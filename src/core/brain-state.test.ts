import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestDb, teardownTestDb } from '../test-helpers.js';

// ---- Mocks (must be declared before dynamic imports) ----

const mockGetConfig = vi.fn();
const mockGetClientForTask = vi.fn();

vi.mock('../config/index.js', () => ({
  getConfig: () => mockGetConfig(),
}));

vi.mock('./model-router.js', () => ({
  getClientForTask: (...args: unknown[]) => mockGetClientForTask(...args),
}));

// ---- Dynamic import after mocks ----
const {
  extractBrainState,
  injectBrainState,
  removeBrainStateMessages,
  isBrainStateMessage,
  formatSnapshot,
  BRAIN_STATE_MARKER,
} = await import('./brain-state.js');

import { getDb } from '../store/db.js';
import type { ChatMessage, LLMClient, ChatResponse, StreamChunk } from './llm.js';
import type { BrainStateSnapshot } from './brain-state.js';

// ---- Test helpers ----

let tmpDir: string;

function defaultBrainStateConfig(overrides: Record<string, unknown> = {}) {
  return {
    brain_state: {
      enabled: true,
      extraction_model: 'auto',
      max_snapshot_tokens: 500,
      persist_to_db: true,
      extract_on: ['soft', 'hard', 'rotate'],
      ...overrides,
    },
  };
}

function makeMockLLMClient(response: string = '{}'): LLMClient {
  return {
    provider: 'mock',
    chat: vi.fn().mockResolvedValue({
      content: response,
      usage: { input_tokens: 10, output_tokens: 20 },
      model: 'mock-model',
      stop_reason: 'end',
    } satisfies ChatResponse),
    async *chatStream(): AsyncGenerator<StreamChunk> {
      yield {
        type: 'done',
        response: {
          content: response,
          usage: { input_tokens: 10, output_tokens: 20 },
          model: 'mock-model',
          stop_reason: 'end',
        },
      };
    },
  };
}

const defaultCtx = { chatId: 'test-chat', tenantId: 'default', userOriginalRequest: 'Help me build a thing' };
const sampleDialogue: ChatMessage[] = [
  { role: 'system', content: 'You are a helpful assistant.' },
  { role: 'user', content: 'Help me build a thing.' },
  { role: 'assistant', content: 'Sure, I will start building.' },
];

beforeAll(() => {
  const result = setupTestDb();
  tmpDir = result.tmpDir;
});

afterAll(() => {
  teardownTestDb(tmpDir);
});

beforeEach(() => {
  vi.clearAllMocks();
});

// ============================================================================
// extractBrainState
// ============================================================================

describe('extractBrainState', () => {
  it('extracts active tasks from DB', async () => {
    mockGetConfig.mockReturnValue(defaultBrainStateConfig());
    const client = makeMockLLMClient('{}');
    mockGetClientForTask.mockReturnValue({ client, selection: {} });

    // Insert task rows
    const db = getDb();
    db.prepare(`INSERT INTO tasks (id, tenant_id, title, status, assigned_agent) VALUES (?, ?, ?, ?, ?)`)
      .run('task-bs-1', 'default', 'Build API', 'running', 'agent-1');
    db.prepare(`INSERT INTO tasks (id, tenant_id, title, status, assigned_agent) VALUES (?, ?, ?, ?, ?)`)
      .run('task-bs-2', 'default', 'Write docs', 'pending', null);

    const snapshot = await extractBrainState(sampleDialogue, defaultCtx, 'soft', client);
    expect(snapshot.hard_state.active_tasks.length).toBeGreaterThanOrEqual(2);
    expect(snapshot.hard_state.active_tasks.some(t => t.id === 'task-bs-1' && t.status === 'running')).toBe(true);
    expect(snapshot.hard_state.active_tasks.some(t => t.id === 'task-bs-2' && t.status === 'pending')).toBe(true);
  });

  it('extracts recent tool outcomes from DB', async () => {
    mockGetConfig.mockReturnValue(defaultBrainStateConfig());
    const client = makeMockLLMClient('{}');
    mockGetClientForTask.mockReturnValue({ client, selection: {} });

    const db = getDb();
    db.prepare(`INSERT INTO tool_outcomes (tenant_id, chat_id, turn_id, iteration, tool_name, tool_call_id, outcome, error_summary, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`)
      .run('default', 'test-chat', 'turn-1', 1, 'shell_exec', 'call-1', 'success', null);
    db.prepare(`INSERT INTO tool_outcomes (tenant_id, chat_id, turn_id, iteration, tool_name, tool_call_id, outcome, error_summary, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`)
      .run('default', 'test-chat', 'turn-1', 2, 'file_read', 'call-2', 'error', 'File not found');

    const snapshot = await extractBrainState(sampleDialogue, defaultCtx, 'soft', client);
    expect(snapshot.hard_state.recent_tool_outcomes.length).toBeGreaterThanOrEqual(2);
    expect(snapshot.hard_state.recent_tool_outcomes.some(o => o.tool === 'shell_exec' && o.status === 'success')).toBe(true);
    expect(snapshot.hard_state.recent_tool_outcomes.some(o => o.tool === 'file_read' && o.status === 'error' && o.summary === 'File not found')).toBe(true);
  });

  it('handles empty DB gracefully', async () => {
    mockGetConfig.mockReturnValue(defaultBrainStateConfig());
    const client = makeMockLLMClient('{}');
    mockGetClientForTask.mockReturnValue({ client, selection: {} });

    // Use a unique tenant so we get no rows
    const ctx = { chatId: 'empty-chat-999', tenantId: 'empty-tenant-999' };
    const snapshot = await extractBrainState(sampleDialogue, ctx, 'soft', client);
    expect(snapshot.hard_state.active_tasks).toEqual([]);
    expect(snapshot.hard_state.recent_tool_outcomes).toEqual([]);
  });

  it('parses valid JSON from LLM extraction', async () => {
    mockGetConfig.mockReturnValue(defaultBrainStateConfig());
    const llmJson = JSON.stringify({
      execution_plan: 'Build an API service',
      current_step: 'Setting up routes',
      completed_steps: ['Project init'],
      key_decisions: ['Use Express'],
      pending_actions: ['Write handlers'],
    });
    const client = makeMockLLMClient(llmJson);

    const snapshot = await extractBrainState(sampleDialogue, defaultCtx, 'soft', client);
    expect(snapshot.soft_state.reasoning.execution_plan).toBe('Build an API service');
    expect(snapshot.soft_state.reasoning.current_step).toBe('Setting up routes');
    expect(snapshot.soft_state.reasoning.completed_steps).toEqual(['Project init']);
    expect(snapshot.soft_state.reasoning.key_decisions).toEqual(['Use Express']);
    expect(snapshot.soft_state.reasoning.pending_actions).toEqual(['Write handlers']);
  });

  it('handles malformed LLM response gracefully', async () => {
    mockGetConfig.mockReturnValue(defaultBrainStateConfig());
    const client = makeMockLLMClient('this is not json at all!!!');

    const snapshot = await extractBrainState(sampleDialogue, defaultCtx, 'soft', client);
    // Should not crash, reasoning fields should be empty defaults
    expect(snapshot.soft_state.reasoning.execution_plan).toBe('');
    expect(snapshot.soft_state.reasoning.current_step).toBe('');
    expect(snapshot.soft_state.reasoning.completed_steps).toEqual([]);
    expect(snapshot.soft_state.reasoning.key_decisions).toEqual([]);
    expect(snapshot.soft_state.reasoning.pending_actions).toEqual([]);
  });

  it('returns empty snapshot when disabled', async () => {
    mockGetConfig.mockReturnValue(defaultBrainStateConfig({ enabled: false }));
    const client = makeMockLLMClient('{}');

    const snapshot = await extractBrainState(sampleDialogue, defaultCtx, 'soft', client);
    expect(snapshot.hard_state.active_tasks).toEqual([]);
    expect(snapshot.hard_state.recent_tool_outcomes).toEqual([]);
    // LLM client should NOT have been called
    expect(client.chat).not.toHaveBeenCalled();
  });

  it('persists snapshot to event_log when persist_to_db=true', async () => {
    mockGetConfig.mockReturnValue(defaultBrainStateConfig({ persist_to_db: true }));
    const client = makeMockLLMClient('{}');

    const ctx = { chatId: 'persist-chat', tenantId: 'persist-tenant' };
    await extractBrainState(sampleDialogue, ctx, 'hard', client);

    const db = getDb();
    const row = db.prepare(`SELECT * FROM event_log WHERE tenant_id = ? AND event_type = 'brain_state_snapshot' AND entity_id = ?`)
      .get('persist-tenant', 'persist-chat') as Record<string, unknown> | undefined;
    expect(row).toBeDefined();

    const runtimeRow = db.prepare(`
      SELECT payload
      FROM runtime_state
      WHERE tenant_id = ? AND state_kind = 'brain_state_snapshot' AND scope_type = 'chat' AND scope_id = ?
    `).get('persist-tenant', 'persist-chat') as { payload: string } | undefined;
    expect(runtimeRow).toBeDefined();
  });

  it('does NOT persist when persist_to_db=false', async () => {
    mockGetConfig.mockReturnValue(defaultBrainStateConfig({ persist_to_db: false }));
    const client = makeMockLLMClient('{}');

    const ctx = { chatId: 'no-persist-chat', tenantId: 'no-persist-tenant' };
    await extractBrainState(sampleDialogue, ctx, 'soft', client);

    const db = getDb();
    const row = db.prepare(`SELECT * FROM event_log WHERE tenant_id = ? AND event_type = 'brain_state_snapshot' AND entity_id = ?`)
      .get('no-persist-tenant', 'no-persist-chat') as Record<string, unknown> | undefined;
    expect(row).toBeUndefined();

    const runtimeRow = db.prepare(`
      SELECT payload
      FROM runtime_state
      WHERE tenant_id = ? AND state_kind = 'brain_state_snapshot' AND scope_type = 'chat' AND scope_id = ?
    `).get('no-persist-tenant', 'no-persist-chat') as { payload: string } | undefined;
    expect(runtimeRow).toBeUndefined();
  });
});

// ============================================================================
// injectBrainState
// ============================================================================

describe('injectBrainState', () => {
  const makeSnapshot = (): BrainStateSnapshot => ({
    hard_state: {
      active_tasks: [],
      recent_tool_outcomes: [],
      user_original_request: 'Build something',
    },
    soft_state: {
      reasoning: {
        execution_plan: 'Step-by-step plan',
        current_step: 'Step 1',
        completed_steps: [],
        key_decisions: [],
        pending_actions: [],
      },
    },
    snapshot_at: new Date().toISOString(),
    trigger: 'soft',
  });

  it('places snapshot after first system message', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello!' },
    ];
    const result = injectBrainState(makeSnapshot(), messages);
    // Position 0 = system, position 1 = brain state, position 2 = user...
    expect(result[0].content).toBe('You are helpful.');
    expect(result[1].content).toContain(BRAIN_STATE_MARKER);
    expect(result[2].content).toBe('Hi');
    expect(result.length).toBe(4);
  });

  it('replaces existing brain state message (no duplicates)', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Hi' },
    ];
    const snap = makeSnapshot();
    const first = injectBrainState(snap, messages);
    expect(first.filter(m => m.content?.includes(BRAIN_STATE_MARKER)).length).toBe(1);

    const second = injectBrainState(snap, first);
    expect(second.filter(m => m.content?.includes(BRAIN_STATE_MARKER)).length).toBe(1);
    // Total messages: system + brain state + user = 3
    expect(second.length).toBe(3);
  });

  it('handles messages with no system message', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi!' },
    ];
    const result = injectBrainState(makeSnapshot(), messages);
    // Should insert at position 0 since no system message found
    expect(result[0].content).toContain(BRAIN_STATE_MARKER);
    expect(result.length).toBe(3);
  });
});

// ============================================================================
// removeBrainStateMessages
// ============================================================================

describe('removeBrainStateMessages', () => {
  it('strips brain state markers correctly', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'System prompt' },
      { role: 'system', content: `${BRAIN_STATE_MARKER}\nSnapshot data here` },
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there!' },
    ];
    const result = removeBrainStateMessages(messages);
    expect(result.length).toBe(3);
    expect(result.every(m => !m.content?.includes(BRAIN_STATE_MARKER))).toBe(true);
  });
});

// ============================================================================
// isBrainStateMessage
// ============================================================================

describe('isBrainStateMessage', () => {
  it('identifies brain state messages', () => {
    expect(isBrainStateMessage({ role: 'system', content: `${BRAIN_STATE_MARKER}\nData` })).toBe(true);
    expect(isBrainStateMessage({ role: 'system', content: 'Regular system prompt' })).toBe(false);
    expect(isBrainStateMessage({ role: 'user', content: BRAIN_STATE_MARKER })).toBe(false);
    expect(isBrainStateMessage({ role: 'assistant', content: 'Hello' })).toBe(false);
  });
});

// ============================================================================
// formatSnapshot
// ============================================================================

describe('formatSnapshot', () => {
  it('formats complete snapshot as readable text', () => {
    const snapshot: BrainStateSnapshot = {
      hard_state: {
        active_tasks: [{ id: 'task-1', title: 'Build API', status: 'running', assigned_agent: 'agent-1' }],
        recent_tool_outcomes: [{ tool: 'shell_exec', status: 'success', summary: 'ran npm build' }],
        user_original_request: 'Build me an API',
      },
      soft_state: {
        reasoning: {
          execution_plan: 'Build REST API',
          current_step: 'Setting up routes',
          completed_steps: ['Init project'],
          key_decisions: ['Use Express'],
          pending_actions: ['Write tests'],
        },
      },
      snapshot_at: '2026-01-01T00:00:00.000Z',
      trigger: 'soft',
    };

    const text = formatSnapshot(snapshot);
    expect(text).toContain(BRAIN_STATE_MARKER);
    expect(text).toContain('Build me an API');
    expect(text).toContain('Build REST API');
    expect(text).toContain('Setting up routes');
    expect(text).toContain('Init project');
    expect(text).toContain('Use Express');
    expect(text).toContain('Write tests');
    expect(text).toContain('task-1');
    expect(text).toContain('shell_exec');
    expect(text).toContain('ran npm build');
  });
});
