import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupTestDb, teardownTestDb } from '../test-helpers.js';

const hoisted = vi.hoisted(() => ({
  executeDagMock: vi.fn(),
  deliverAssistantMessageMock: vi.fn().mockReturnValue({ delivered: 1 }),
}));

vi.mock('./dag-executor.js', () => ({
  executeDag: hoisted.executeDagMock,
}));

vi.mock('../channels/websocket.js', () => ({
  deliverAssistantMessage: hoisted.deliverAssistantMessageMock,
}));

import {
  createPlanTasks,
  getPlanSteps,
  startDetachedPlanRun,
  resumeIncompletePlans,
  isPlanRunActive,
  type PlanRunContext,
} from './plan-runner.js';
import { getById, listPlanRootTasks, resetColumnsEnsured, updateStatus, type TaskRecord } from '../store/task-dag.js';
import { getTurnEnvelope } from '../memory/turn-envelopes.js';
import { loadTaskMetadata, loadTaskResult, persistTaskMetadata } from '../tasks/workspace.js';
import type { DecomposeTaskInput } from './dag-bridge.js';
import { addSessionScopeGrant, createSession, updateSessionPermissionLevel } from '../memory/sessions.js';

const PLAN: DecomposeTaskInput = {
  goal: 'Quarterly tax update report',
  subtasks: [
    { title: 'Collect policy sources', objective: 'Gather Q2 policy texts', done_criteria: 'sources listed', depends_on: [], agent_type_hint: 'any', constraints: {} },
    { title: 'Draft analysis', objective: 'Draft the analysis section', done_criteria: 'draft exists', depends_on: [0], agent_type_hint: 'any', constraints: {} },
  ],
};

function makeCtx(overrides: Partial<PlanRunContext> = {}): PlanRunContext {
  return {
    tenantId: 'default',
    chatId: 'chat-plan-test',
    sessionId: 'sess-plan-test',
    systemPrompt: 'You are a test brain.',
    ...overrides,
  };
}

async function waitForRunToFinish(rootTaskId: string, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (isPlanRunActive(rootTaskId)) {
    if (Date.now() - start > timeoutMs) throw new Error('plan run did not finish in time');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Simulate the real executor contract: mark scope tasks terminal in the DB. */
function executeDagMarks(status: 'completed' | 'failed', output = 'dag output') {
  hoisted.executeDagMock.mockImplementation(async (tasks: TaskRecord[]) => {
    for (const task of tasks) {
      updateStatus(task.id, status, task.tenant_id);
    }
    return output;
  });
}

describe('core/plan-runner', () => {
  let tmpDir: string;

  beforeEach(() => {
    const result = setupTestDb();
    tmpDir = result.tmpDir;
    resetColumnsEnsured();
    hoisted.executeDagMock.mockReset();
    hoisted.deliverAssistantMessageMock.mockClear();
  });

  afterEach(() => {
    teardownTestDb(tmpDir);
  });

  it('createPlanTasks persists root + children with dependencies and delivery metadata', () => {
    const executionModel = { provider: 'openai', model: 'gpt-5.6-luna' };
    const created = createPlanTasks(PLAN, makeCtx({ executionModel }));

    const root = getById(created.rootTaskId, 'default');
    expect(root).not.toBeNull();
    expect(root!.parent_task_id).toBeNull();
    expect(root!.tags).toContain('plan:root');
    expect(listPlanRootTasks('default').map((t) => t.id)).toContain(created.rootTaskId);

    const steps = getPlanSteps(created.rootTaskId, 'default');
    expect(steps).toHaveLength(2);
    expect(steps[0].title).toBe('Collect policy sources');
    expect(steps[0].status).toBe('ready');
    expect(steps[1].status).toBe('pending'); // has a dependency

    const meta = loadTaskMetadata(created.rootTaskId);
    expect(meta?.chat_id).toBe('chat-plan-test');
    expect(meta?.session_id).toBe('sess-plan-test');
    expect(meta?.system_prompt).toBe('You are a test brain.');
    expect(meta?.execution_model).toEqual(executionModel);
  });

  it('detached run passes live session permission context into DAG execution', async () => {
    const session = createSession('user-plan-test', 'Plan context', 'default');
    updateSessionPermissionLevel(session.id, 'L0_READ_ONLY', 'default');
    addSessionScopeGrant(session.id, '/tmp/granted-plan', 'default');
    executeDagMarks('completed');
    const ctx = makeCtx({
      sessionId: session.id,
      userId: 'user-plan-test',
      permissionLevel: 'L3_FULL_ACCESS',
    });
    const created = createPlanTasks(PLAN, ctx);

    startDetachedPlanRun(created.rootTaskId, ctx);
    await waitForRunToFinish(created.rootTaskId);

    const options = hoisted.executeDagMock.mock.calls[0][6];
    expect(options.toolContext).toMatchObject({
      chatId: 'chat-plan-test',
      tenantId: 'default',
      sessionId: session.id,
      userId: 'user-plan-test',
      agentId: created.rootTaskId,
      permissionLevel: 'L0_READ_ONLY',
      scopeGrants: ['/tmp/granted-plan'],
    });
    expect(loadTaskMetadata(created.rootTaskId)).toMatchObject({
      user_id: 'user-plan-test',
      permission_level: 'L0_READ_ONLY',
    });
    // Regression: plan steps create real deliverables — without onArtifact the
    // artifact never reaches the session timeline and the user only sees a
    // container file path in the completion text.
    expect(typeof options.toolContext.onArtifact).toBe('function');
  });

  it('detached run completes the plan, persists the result, and delivers a completion message', async () => {
    executeDagMarks('completed', 'All steps done.');
    const created = createPlanTasks(PLAN, makeCtx());

    expect(startDetachedPlanRun(created.rootTaskId, makeCtx())).toBe(true);
    await waitForRunToFinish(created.rootTaskId);

    expect(getById(created.rootTaskId, 'default')!.status).toBe('completed');
    expect(loadTaskResult(created.rootTaskId)?.success).toBe(true);

    expect(hoisted.deliverAssistantMessageMock).toHaveBeenCalledTimes(1);
    const delivered = hoisted.deliverAssistantMessageMock.mock.calls[0][0];
    expect(delivered.chatId).toBe('chat-plan-test');
    expect(delivered.sessionId).toBe('sess-plan-test');
    expect(delivered.content).toContain('Plan completed');
    expect(delivered.content).toContain('2/2 completed');

    // Issue #626: the detached plan is its OWN background turn, delivered under a
    // distinct id with origin=background — never the foreground turn.
    const bgTurnId = `turn_bg_${created.rootTaskId}`;
    expect(delivered.turnId).toBe(bgTurnId);
    expect(delivered.origin).toBe('background');
    // The DAG ran under that background turn id (6th positional arg), so all step
    // events group with the completion, not with any foreground turn.
    expect(hoisted.executeDagMock.mock.calls[0][5]).toBe(bgTurnId);
    // A durable, terminalized background envelope exists for restore.
    const envelope = getTurnEnvelope('sess-plan-test', bgTurnId, 'default');
    expect(envelope?.origin).toBe('background');
    expect(envelope?.status).toBe('completed');
  });

  it('isolates a detached plan from the foreground turn that spawned it (Issue #626)', async () => {
    executeDagMarks('completed');
    const created = createPlanTasks(PLAN, makeCtx());
    // The spawning foreground turn id must NOT leak into the plan's execution.
    startDetachedPlanRun(created.rootTaskId, makeCtx({ turnId: 'turn_foreground' }));
    await waitForRunToFinish(created.rootTaskId);

    const bgTurnId = `turn_bg_${created.rootTaskId}`;
    expect(hoisted.executeDagMock.mock.calls[0][5]).toBe(bgTurnId);
    expect(hoisted.executeDagMock.mock.calls[0][5]).not.toBe('turn_foreground');
    expect(hoisted.deliverAssistantMessageMock.mock.calls[0][0].turnId).toBe(bgTurnId);
  });

  it('failed steps mark the plan failed and the delivery says so honestly', async () => {
    executeDagMarks('failed', 'step blew up');
    const created = createPlanTasks(PLAN, makeCtx());

    startDetachedPlanRun(created.rootTaskId, makeCtx());
    await waitForRunToFinish(created.rootTaskId);

    expect(getById(created.rootTaskId, 'default')!.status).toBe('failed');
    const delivered = hoisted.deliverAssistantMessageMock.mock.calls[0][0];
    expect(delivered.content).toContain('Plan finished with problems');
  });

  it('cancelled steps mark the plan failed and the delivery reports cancellation honestly (no whitewash)', async () => {
    // Regression for the 2026-07-08 live cancel-whitewash incident: an
    // interrupted step must NOT be delivered as "Plan completed". Simulate the
    // executor marking the scope cancelled (what the fixed dag-executor does
    // when executeSingleTask returns an interruption-fallback string).
    hoisted.executeDagMock.mockImplementation(async (tasks: TaskRecord[]) => {
      for (const task of tasks) updateStatus(task.id, 'cancelled', task.tenant_id);
      return 'Task 1: Collect policy sources\nCancelled: 任务执行中断。';
    });
    const created = createPlanTasks(PLAN, makeCtx());

    startDetachedPlanRun(created.rootTaskId, makeCtx());
    await waitForRunToFinish(created.rootTaskId);

    expect(getById(created.rootTaskId, 'default')!.status).toBe('failed');
    const delivered = hoisted.deliverAssistantMessageMock.mock.calls[0][0];
    expect(delivered.content).toContain('Plan finished with problems');
    expect(delivered.content).not.toContain('Plan completed');
    // Cancellations are named distinctly from generic failures.
    expect(delivered.content).toContain('cancelled');
    expect(delivered.content).toContain('0/2 completed');

    const result = loadTaskResult(created.rootTaskId);
    expect(result?.success).toBe(false);
    expect(result?.metadata).toMatchObject({ cancelled: 2, failed: 0 });
  });

  it('mixed completed + cancelled reports partial honest stats', async () => {
    hoisted.executeDagMock.mockImplementation(async (tasks: TaskRecord[]) => {
      // First step completes, second is cancelled.
      updateStatus(tasks[0].id, 'completed', tasks[0].tenant_id);
      if (tasks[1]) updateStatus(tasks[1].id, 'cancelled', tasks[1].tenant_id);
      return 'partial output';
    });
    const created = createPlanTasks(PLAN, makeCtx());

    startDetachedPlanRun(created.rootTaskId, makeCtx());
    await waitForRunToFinish(created.rootTaskId);

    expect(getById(created.rootTaskId, 'default')!.status).toBe('failed');
    const delivered = hoisted.deliverAssistantMessageMock.mock.calls[0][0];
    expect(delivered.content).toContain('1/2 completed');
    expect(delivered.content).toContain('1 cancelled');
    expect(delivered.content).not.toContain('Plan completed:');
  });

  it('reports blocked downstream work honestly and never reuses a successful step excerpt as completion', async () => {
    hoisted.executeDagMock.mockImplementation(async (tasks: TaskRecord[]) => {
      updateStatus(tasks[0].id, 'failed', tasks[0].tenant_id);
      if (tasks[1]) updateStatus(tasks[1].id, 'blocked', tasks[1].tenant_id);
      return '已完成: 研究报告已经交付';
    });
    const created = createPlanTasks(PLAN, makeCtx());

    startDetachedPlanRun(created.rootTaskId, makeCtx());
    await waitForRunToFinish(created.rootTaskId);

    const delivered = hoisted.deliverAssistantMessageMock.mock.calls[0][0];
    expect(delivered.content).toContain('Plan finished with problems');
    expect(delivered.content).toContain('1 failed');
    expect(delivered.content).toContain('1 blocked');
    expect(delivered.content).not.toContain('已完成: 研究报告已经交付');
    expect(loadTaskResult(created.rootTaskId)?.metadata).toMatchObject({ blocked: 1, failed: 1 });
  });

  it('refuses a second concurrent run of the same plan', async () => {
    let release: () => void = () => {};
    hoisted.executeDagMock.mockImplementation(async (tasks: TaskRecord[]) => {
      await new Promise<void>((resolve) => { release = resolve; });
      for (const task of tasks) updateStatus(task.id, 'completed', task.tenant_id);
      return 'ok';
    });
    const created = createPlanTasks(PLAN, makeCtx());

    expect(startDetachedPlanRun(created.rootTaskId, makeCtx())).toBe(true);
    expect(startDetachedPlanRun(created.rootTaskId, makeCtx())).toBe(false);

    release();
    await waitForRunToFinish(created.rootTaskId);
  });

  it('resumeIncompletePlans normalizes stranded steps and re-runs only incomplete ones', async () => {
    const created = createPlanTasks(PLAN, makeCtx());
    // Simulate a crash mid-run: root running, step0 completed, step1 stranded running.
    updateStatus(created.rootTaskId, 'running', 'default');
    const steps = getPlanSteps(created.rootTaskId, 'default');
    updateStatus(steps[0].id, 'completed', 'default');
    updateStatus(steps[1].id, 'running', 'default');

    executeDagMarks('completed', 'resumed output');
    const report = resumeIncompletePlans({ systemPrompt: 'fallback prompt' });
    expect(report.resumed).toContain(created.rootTaskId);
    await waitForRunToFinish(created.rootTaskId);

    // Only the incomplete step went to the executor.
    const scope = hoisted.executeDagMock.mock.calls[0][0] as TaskRecord[];
    expect(scope.map((t) => t.id)).toEqual([steps[1].id]);
    // Resume used the system prompt captured at creation, not the fallback.
    expect(hoisted.executeDagMock.mock.calls[0][1]).toBe('You are a test brain.');

    expect(getById(created.rootTaskId, 'default')!.status).toBe('completed');
    expect(hoisted.deliverAssistantMessageMock).toHaveBeenCalledTimes(1);
  });

  it('resume reconstructs permission context from metadata when the session row is unavailable', async () => {
    const created = createPlanTasks(PLAN, makeCtx({
      sessionId: 'missing-session-plan',
      userId: 'user-resume-plan',
      permissionLevel: 'L1_READ_WRITE',
    }));
    updateStatus(created.rootTaskId, 'running', 'default');

    executeDagMarks('completed', 'resumed output');
    const report = resumeIncompletePlans({ systemPrompt: 'fallback prompt' });
    expect(report.resumed).toContain(created.rootTaskId);
    await waitForRunToFinish(created.rootTaskId);

    const options = hoisted.executeDagMock.mock.calls[0][6];
    expect(options.toolContext).toMatchObject({
      chatId: 'chat-plan-test',
      tenantId: 'default',
      sessionId: 'missing-session-plan',
      userId: 'user-resume-plan',
      agentId: created.rootTaskId,
      permissionLevel: 'L1_READ_WRITE',
      scopeGrants: [],
    });
  });

  it('resume skips plans without delivery metadata and marks them failed', () => {
    const created = createPlanTasks(PLAN, makeCtx());
    updateStatus(created.rootTaskId, 'running', 'default');
    // Wipe the metadata chat target.
    persistTaskMetadata(created.rootTaskId, {
      task_id: created.rootTaskId,
      title: 'x',
      objective: 'x',
      status: 'running',
      created_at: new Date().toISOString(),
      workspace_path: '',
    });

    const report = resumeIncompletePlans({ systemPrompt: 'fallback' });
    expect(report.resumed).not.toContain(created.rootTaskId);
    expect(getById(created.rootTaskId, 'default')!.status).toBe('failed');
  });

  it('executeDecomposeTask (background mode) creates the plan, starts a detached run, and returns a turn-ending handoff', async () => {
    const { loadConfig } = await import('../config/index.js');
    loadConfig('/nonexistent/mozi-plan-runner-test.json'); // defaults: dag_execution_mode=background
    executeDagMarks('completed', 'background dag output');

    const { executeDecomposeTask } = await import('./dag-bridge.js');
    const outcome = await executeDecomposeTask(PLAN, {
      chatId: 'chat-plan-test',
      tenantId: 'default',
      systemPrompt: 'You are a test brain.',
      sessionId: 'sess-plan-test',
    });

    // Background mode returns a structured DetachedPlanStarted outcome — the
    // runtime (not prompt text) ends the foreground turn on it.
    expect(typeof outcome).not.toBe('string');
    const detached = outcome as Exclude<typeof outcome, string>;
    expect(detached.detached).toBe(true);
    expect(detached.content).toContain('RUNNING IN BACKGROUND');
    expect(detached.content).toContain('1. Collect policy sources');
    expect(detached.userMessage).toContain('1. Collect policy sources');
    expect(detached.rootTaskId).toMatch(/[0-9a-f-]+/);

    await waitForRunToFinish(detached.rootTaskId);
    expect(getById(detached.rootTaskId, 'default')!.status).toBe('completed');
    expect(hoisted.deliverAssistantMessageMock).toHaveBeenCalledTimes(1);
  });

  it('delivers a Brain-written completion summary grounded in step results', async () => {
    executeDagMarks('completed', 'raw dag output');
    const chatMock = vi.fn().mockResolvedValue({
      content: '模板与初版内容已完成,交付文件:/data/output/report.xlsx。',
      usage: { input_tokens: 100, output_tokens: 50 },
      model: 'test-model',
      stop_reason: 'end_turn',
    });
    const fakeClient = { chat: chatMock } as unknown as NonNullable<PlanRunContext['fallbackClient']>;

    const created = createPlanTasks(PLAN, makeCtx({ fallbackClient: fakeClient }));
    expect(startDetachedPlanRun(created.rootTaskId, makeCtx({ fallbackClient: fakeClient }))).toBe(true);
    await waitForRunToFinish(created.rootTaskId);

    expect(chatMock).toHaveBeenCalledTimes(1);
    // Summarization input is grounded: goal + per-step status block.
    const [messages] = chatMock.mock.calls[0] as [Array<{ role: string; content: string }>];
    const userMsg = messages.find((m) => m.role === 'user')!;
    expect(userMsg.content).toContain('Quarterly tax update report');
    expect(userMsg.content).toContain('Collect policy sources');

    expect(hoisted.deliverAssistantMessageMock).toHaveBeenCalledTimes(1);
    const delivered = hoisted.deliverAssistantMessageMock.mock.calls[0][0] as { content: string };
    expect(delivered.content).toContain('Plan completed');
    expect(delivered.content).toContain('/data/output/report.xlsx');
    // The old behavior dumped raw step outputs; the Brain summary replaces it.
    expect(delivered.content).not.toContain('raw dag output');
  });

  it('falls back to the compact template when the Brain summary call fails', async () => {
    executeDagMarks('completed', 'raw dag output');
    const failingClient = {
      chat: vi.fn().mockRejectedValue(new Error('provider down')),
    } as unknown as NonNullable<PlanRunContext['fallbackClient']>;

    const created = createPlanTasks(PLAN, makeCtx({ fallbackClient: failingClient }));
    expect(startDetachedPlanRun(created.rootTaskId, makeCtx({ fallbackClient: failingClient }))).toBe(true);
    await waitForRunToFinish(created.rootTaskId);

    expect(hoisted.deliverAssistantMessageMock).toHaveBeenCalledTimes(1);
    const delivered = hoisted.deliverAssistantMessageMock.mock.calls[0][0] as { content: string };
    expect(delivered.content).toContain('Plan completed');
    expect(delivered.content).toContain('Steps: 2/2 completed');
    // Compact template lists step statuses, not full raw outputs.
    expect(delivered.content).toContain('[completed] Collect policy sources');
    expect(delivered.content).toContain('execution panel');
  });

  it('enforces the run attempt cap', async () => {
    executeDagMarks('completed');
    const created = createPlanTasks(PLAN, makeCtx());
    const { incrementAttempts } = await import('../store/task-dag.js');
    incrementAttempts(created.rootTaskId, 'default');
    incrementAttempts(created.rootTaskId, 'default');
    incrementAttempts(created.rootTaskId, 'default');

    expect(startDetachedPlanRun(created.rootTaskId, makeCtx())).toBe(false);
    expect(getById(created.rootTaskId, 'default')!.status).toBe('failed');
  });
});
