import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { registerApiRoutes } from './api-routes.js';
import { setupTestDb, teardownTestDb } from './test-helpers.js';
import { createSession } from './memory/sessions.js';
import { createPlanTasks, isPlanRunActive, type PlanRunContext } from './core/plan-runner.js';
import {
  getById,
  resetColumnsEnsured,
  updateStatus,
  updateTask,
  type TaskRecord,
} from './store/task-dag.js';
import type { DecomposeTaskInput } from './core/dag-bridge.js';

const hoisted = vi.hoisted(() => ({
  executeDagMock: vi.fn(),
  deliverAssistantMessageMock: vi.fn().mockReturnValue({ delivered: 1 }),
}));

vi.mock('./core/dag-executor.js', () => ({
  executeDag: hoisted.executeDagMock,
}));

vi.mock('./channels/websocket.js', () => ({
  deliverAssistantMessage: hoisted.deliverAssistantMessageMock,
}));

const PLAN: DecomposeTaskInput = {
  goal: 'Retry failed step plan',
  subtasks: [
    { title: 'Collect inputs', objective: 'Collect inputs', done_criteria: 'inputs collected', depends_on: [], agent_type_hint: 'any', constraints: {} },
    { title: 'Write report', objective: 'Write report', done_criteria: 'report written', depends_on: [0], agent_type_hint: 'any', constraints: {} },
  ],
};

function makeCtx(sessionId: string): PlanRunContext {
  return {
    tenantId: 'default',
    chatId: 'chat-plan-retry-test',
    sessionId,
    userId: 'local-user',
    systemPrompt: 'You are a test brain.',
  };
}

async function waitForRunToFinish(rootTaskId: string, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (isPlanRunActive(rootTaskId)) {
    if (Date.now() - start > timeoutMs) throw new Error('plan run did not finish in time');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('plan step retry route', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = setupTestDb().tmpDir;
    resetColumnsEnsured();
    hoisted.executeDagMock.mockReset();
    hoisted.deliverAssistantMessageMock.mockClear();
  });

  afterEach(() => {
    teardownTestDb(tmpDir);
  });

  async function registerApp() {
    const app = Fastify();
    await registerApiRoutes(app, {
      jwtSecret: 'test-secret',
      config: {
        server: { auth_mode: 'none', host: '127.0.0.1' },
        security: { enterprise: {} },
        http_rate_limit: { global_rpm: 100, auth_rpm: 10, pair_rpm: 5 },
      },
    });
    return app;
  }

  it('rejects a step that is not in a terminal-failed state with 409', async () => {
    const app = await registerApp();
    try {
      const session = createSession('local-user', 'Retry route', 'default');
      const created = createPlanTasks(PLAN, makeCtx(session.id));
      const completedStep = getById(created.steps[0].taskId, 'default')!;
      updateStatus(completedStep.id, 'completed', 'default');
      updateStatus(created.rootTaskId, 'failed', 'default');

      const response = await app.inject({
        method: 'POST',
        url: `/api/sessions/${session.id}/plans/${created.rootTaskId}/steps/${completedStep.id}/retry`,
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({
        error: 'Plan step can only be retried when status is failed or cancelled',
      });
      expect(hoisted.executeDagMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('resets a terminal step to ready and triggers a plan run', async () => {
    const app = await registerApp();
    try {
      const session = createSession('local-user', 'Retry route', 'default');
      const created = createPlanTasks(PLAN, makeCtx(session.id));
      const steps = created.steps.map((step) => getById(step.taskId, 'default')!);
      updateStatus(steps[0].id, 'completed', 'default');
      updateStatus(steps[1].id, 'failed', 'default');
      updateTask(steps[1].id, { constraints: { ...steps[1].constraints, guard_reason: 'tool denied' } }, 'default');
      updateStatus(created.rootTaskId, 'failed', 'default');

      hoisted.executeDagMock.mockImplementation(async (tasks: TaskRecord[]) => {
        for (const task of tasks) updateStatus(task.id, 'completed', task.tenant_id);
        return 'retried output';
      });

      const response = await app.inject({
        method: 'POST',
        url: `/api/sessions/${session.id}/plans/${created.rootTaskId}/steps/${steps[1].id}/retry`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true, restoredDescendantIds: [] });
      await waitForRunToFinish(created.rootTaskId);

      expect(hoisted.executeDagMock).toHaveBeenCalledTimes(1);
      const retriedScope = hoisted.executeDagMock.mock.calls[0][0] as TaskRecord[];
      expect(retriedScope.map((task) => task.id)).toEqual([steps[1].id]);
      expect(getById(steps[1].id, 'default')!.status).toBe('completed');
      expect(getById(steps[1].id, 'default')!.constraints.guard_reason).toBeUndefined();
      expect(getById(created.rootTaskId, 'default')!.status).toBe('completed');
    } finally {
      await app.close();
    }
  });

  it('restores the causally blocked descendant chain when retrying its failed upstream', async () => {
    const app = await registerApp();
    try {
      const session = createSession('local-user', 'Retry blocked chain', 'default');
      const chainPlan: DecomposeTaskInput = {
        goal: 'Recover downstream delivery',
        subtasks: [
          { title: 'Research', objective: 'Research', done_criteria: 'done', depends_on: [], agent_type_hint: 'any', constraints: {} },
          { title: 'Validate', objective: 'Validate', done_criteria: 'done', depends_on: [0], agent_type_hint: 'any', constraints: {} },
          { title: 'Write Excel', objective: 'Write Excel', done_criteria: 'done', depends_on: [1], agent_type_hint: 'any', constraints: {} },
        ],
      };
      const created = createPlanTasks(chainPlan, makeCtx(session.id));
      const steps = created.steps.map(({ taskId }) => getById(taskId, 'default')!);
      updateStatus(steps[0].id, 'failed', 'default');
      for (const blocked of steps.slice(1)) {
        updateTask(blocked.id, {
          constraints: {
            ...blocked.constraints,
            blocked_by_task_id: steps[0].id,
            blocked_reason: `Dependency failed: ${steps[0].title}`,
          },
        }, 'default');
        updateStatus(blocked.id, 'blocked', 'default');
      }
      updateStatus(created.rootTaskId, 'failed', 'default');

      hoisted.executeDagMock.mockImplementation(async (tasks: TaskRecord[]) => {
        for (const task of tasks) updateStatus(task.id, 'completed', task.tenant_id);
        return 'recovered output';
      });

      const response = await app.inject({
        method: 'POST',
        url: `/api/sessions/${session.id}/plans/${created.rootTaskId}/steps/${steps[0].id}/retry`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().restoredDescendantIds).toEqual([steps[1].id, steps[2].id]);
      await waitForRunToFinish(created.rootTaskId);
      const retryScope = hoisted.executeDagMock.mock.calls[0][0] as TaskRecord[];
      expect(retryScope.map((task) => task.id)).toEqual(steps.map((step) => step.id));
      expect(getById(created.rootTaskId, 'default')!.status).toBe('completed');
    } finally {
      await app.close();
    }
  });
});
