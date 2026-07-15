import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { setupTestDb, teardownTestDb } from '../test-helpers.js';
import { loadConfig } from '../config/index.js';
import {
  DecomposeTaskInputSchema,
  criticReviewPlan,
  executeDecomposeTask,
  verifyDagOutput,
  replanFromVerifierFailure,
} from './dag-bridge.js';
import type { LLMClient } from './llm.js';

let tmpDir: string;

beforeAll(() => {
  const result = setupTestDb();
  tmpDir = result.tmpDir;
});

afterAll(() => {
  teardownTestDb(tmpDir);
});

afterEach(() => {
  delete process.env.MOZI_TEST_INLINE_DAG;
  delete process.env.MOZI_E2E_LLM;
  delete process.env.MOZI_BRAIN_MAX_PLAN_STEPS;
  loadConfig('/nonexistent/dag-bridge-test-default.json');
});

function makePlan(stepCount: number) {
  return {
    goal: `Run ${stepCount} step plan`,
    subtasks: Array.from({ length: stepCount }, (_, i) => ({
      title: `Step ${i + 1}`,
      objective: `Complete step ${i + 1}`,
      done_criteria: 'done',
    })),
  };
}

function makeFallbackClient(): LLMClient {
  return {
    provider: 'test',
    async chat() {
      return {
        content: 'done',
        usage: { input_tokens: 1, output_tokens: 1 },
        model: 'test-model',
        stop_reason: 'end_turn',
      };
    },
    async *chatStream() {
      yield {
        type: 'done',
        response: {
          content: 'done',
          usage: { input_tokens: 1, output_tokens: 1 },
          model: 'test-model',
          stop_reason: 'end_turn',
        },
      };
    },
  };
}

describe('core/dag-bridge', () => {
  describe('DecomposeTaskInputSchema', () => {
    it('parses valid input with dependencies', () => {
      const input = {
        goal: 'Build a REST API',
        subtasks: [
          { title: 'Design schema', objective: 'Create database schema for the API' },
          { title: 'Implement endpoints', objective: 'Build CRUD endpoints', depends_on: [0] },
          { title: 'Write tests', objective: 'Unit tests for all endpoints', depends_on: [1] },
        ],
      };

      const result = DecomposeTaskInputSchema.parse(input);
      expect(result.goal).toBe('Build a REST API');
      expect(result.subtasks).toHaveLength(3);
      expect(result.subtasks[1].depends_on).toEqual([0]);
      expect(result.subtasks[2].depends_on).toEqual([1]);
    });

    it('rejects fewer than 2 subtasks', () => {
      const input = {
        goal: 'Simple task',
        subtasks: [{ title: 'Only one', objective: 'Not enough' }],
      };

      expect(() => DecomposeTaskInputSchema.parse(input)).toThrow();
    });

    it('rejects more than 20 subtasks', () => {
      const subtasks = Array.from({ length: 21 }, (_, i) => ({
        title: `Task ${i}`,
        objective: `Do thing ${i}`,
      }));

      expect(() => DecomposeTaskInputSchema.parse({ goal: 'Too many', subtasks })).toThrow();
    });

    it('applies default values for optional fields', () => {
      const input = {
        goal: 'Test defaults',
        subtasks: [
          { title: 'A', objective: 'Do A' },
          { title: 'B', objective: 'Do B' },
        ],
      };

      const result = DecomposeTaskInputSchema.parse(input);
      expect(result.subtasks[0].depends_on).toEqual([]);
      expect(result.subtasks[0].done_criteria).toBe('');
      expect(result.subtasks[0].agent_type_hint).toBe('any');
      expect(result.subtasks[0].constraints).toEqual({});
    });

    it('parses constraints when provided', () => {
      const input = {
        goal: 'With constraints',
        subtasks: [
          { title: 'A', objective: 'Do A', constraints: { timeout_seconds: 60, max_retries: 3, max_tokens: 4000 } },
          { title: 'B', objective: 'Do B' },
        ],
      };

      const result = DecomposeTaskInputSchema.parse(input);
      expect(result.subtasks[0].constraints.timeout_seconds).toBe(60);
      expect(result.subtasks[0].constraints.max_retries).toBe(3);
      expect(result.subtasks[0].constraints.max_tokens).toBe(4000);
    });
  });

  describe('executeDecomposeTask plan step limit', () => {
    it('allows a 6-step plan with default max_plan_steps', async () => {
      loadConfig('/nonexistent/dag-bridge-defaults.json');
      process.env.MOZI_TEST_INLINE_DAG = '1';
      process.env.MOZI_E2E_LLM = 'scripted';

      const result = await executeDecomposeTask(makePlan(6), {
        chatId: 'chat-six-step-default',
        tenantId: 'default',
        systemPrompt: 'You are a test brain.',
        fallbackClient: makeFallbackClient(),
      });

      expect(result).toContain('Planner-Critic-Verifier Results');
      expect(result).toContain('Verifier passed: yes');
    });

    it('rejects plans exceeding max_plan_steps with the new message', async () => {
      process.env.MOZI_BRAIN_MAX_PLAN_STEPS = '5';
      loadConfig('/nonexistent/dag-bridge-max-plan-steps.json');
      process.env.MOZI_TEST_INLINE_DAG = '1';
      process.env.MOZI_E2E_LLM = 'scripted';

      await expect(executeDecomposeTask(makePlan(6), {
        chatId: 'chat-max-plan-steps',
        tenantId: 'default',
        systemPrompt: 'You are a test brain.',
        fallbackClient: makeFallbackClient(),
      })).rejects.toThrow(
        'Too many subtasks: 6 exceeds max_plan_steps=5. Reduce the number of subtasks or increase brain.max_plan_steps in config.',
      );
    });
  });

  describe('planner-critic-verifier helpers', () => {
    it('criticReviewPlan reports missing done_criteria and risk hints', () => {
      const plan = DecomposeTaskInputSchema.parse({
        goal: 'Ship production change',
        subtasks: [
          { title: 'Deploy to production', objective: 'Deploy safely' },
          { title: 'Validate', objective: 'Check health' },
        ],
      });
      const review = criticReviewPlan(plan);
      expect(review.warnings.join('\n')).toContain('missing done_criteria');
      expect(review.risks.join('\n')).toContain('high-risk');
    });

    it('verifyDagOutput detects failed subtasks from DAG output text', () => {
      const plan = DecomposeTaskInputSchema.parse({
        goal: 'Test verifier',
        subtasks: [
          { title: 'A', objective: 'Do A', done_criteria: 'A done' },
          { title: 'B', objective: 'Do B', done_criteria: 'B done' },
        ],
      });
      const output = [
        'Task 1: A',
        'All good. A done successfully.',
        '',
        '---',
        '',
        'Task 2: B',
        'Error (task skipped): boom',
      ].join('\n');

      const report = verifyDagOutput(plan, output);
      expect(report.passed).toBe(false);
      expect(report.failedSubtaskIndexes).toContain(1);
      expect(report.findings.join('\n')).toContain('failed execution');
    });

    it('replanFromVerifierFailure rebuilds failed subtasks for next planner iteration', () => {
      const plan = DecomposeTaskInputSchema.parse({
        goal: 'Retry plan',
        subtasks: [
          { title: 'A', objective: 'Do A', done_criteria: 'A done' },
          { title: 'B', objective: 'Do B', done_criteria: 'B done', depends_on: [0] },
        ],
      });
      const replanned = replanFromVerifierFailure(plan, {
        passed: false,
        failedSubtaskIndexes: [1],
        findings: ['Subtask 1 failed'],
      }, 1);

      expect(replanned).not.toBeNull();
      expect(replanned!.subtasks[0].title).toContain('Iteration 2');
      expect(replanned!.subtasks.length).toBeGreaterThanOrEqual(2);
    });
  });
});
