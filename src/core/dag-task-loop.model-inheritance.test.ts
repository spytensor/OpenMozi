import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LLMClient } from './llm.js';
import type { TaskRecord } from '../store/task-dag.js';

const hoisted = vi.hoisted(() => ({
  config: { model_router: { roles: {} as Record<string, unknown> } },
  getClientForRole: vi.fn(),
}));

vi.mock('../config/index.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../config/index.js')>();
  return { ...original, getConfig: () => hoisted.config };
});

vi.mock('./model-router.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./model-router.js')>();
  return { ...original, getClientForRole: hoisted.getClientForRole };
});

import { resolveClient } from './dag-task-loop.js';

const task = { id: 'task-inherit', tenant_id: 'default' } as TaskRecord;
const inheritedClient = { provider: 'openai', chat: vi.fn(), chatStream: vi.fn() } as unknown as LLMClient;
const overrideClient = { provider: 'deepseek', chat: vi.fn(), chatStream: vi.fn() } as unknown as LLMClient;

describe('DAG step model inheritance', () => {
  beforeEach(() => {
    vi.stubEnv('MOZI_E2E_LLM', '');
    hoisted.config.model_router.roles = {};
    hoisted.getClientForRole.mockReset();
  });

  it('inherits the model selected for the turn when no step override exists', () => {
    const result = resolveClient(task, inheritedClient, { provider: 'openai', model: 'gpt-5.6-luna', think: true });
    expect(result).toEqual({ client: inheritedClient, think: true });
    expect(hoisted.getClientForRole).not.toHaveBeenCalled();
  });

  it('uses an explicitly configured step override', () => {
    hoisted.config.model_router.roles = { step: { provider: 'deepseek', model: 'deepseek-v4-pro' } };
    hoisted.getClientForRole.mockReturnValue({
      client: overrideClient,
      selection: { provider: 'deepseek', model: 'deepseek-v4-pro', role: 'step' },
    });
    expect(resolveClient(task, inheritedClient).client).toBe(overrideClient);
    expect(hoisted.getClientForRole).toHaveBeenCalledWith('step', inheritedClient, { tenantId: 'default' });
  });
});
