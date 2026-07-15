import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { generate, restore, validate, persist, getLatest, getLatestForSession, type SessionState, type SessionHandoff } from './session-handoff.js';
import { setupTestDb, teardownTestDb } from '../test-helpers.js';
import { getDb } from '../store/db.js';

let tmpDir: string;

beforeAll(() => {
  const result = setupTestDb();
  tmpDir = result.tmpDir;
});

afterAll(() => {
  teardownTestDb(tmpDir);
});

describe('core/session-handoff', () => {
  const mockSessionState: SessionState = {
    session_id: 'session-001',
    tasks: [
      { id: 'task-1', status: 'completed', title: 'Setup project', key_output: 'Project initialized' },
      { id: 'task-2', status: 'running', title: 'Write API', progress: 'step 2/5', assigned_agent: 'agent-1' },
      { id: 'task-3', status: 'blocked', title: 'Write tests', assigned_agent: 'agent-2' },
    ],
    agents: [
      { id: 'agent-1', role: 'coder', status: 'running', task_id: 'task-2' },
      { id: 'agent-2', role: 'tester', status: 'blocked', task_id: 'task-3' },
    ],
    checkpoints: [
      {
        checkpoint_id: 'cp-1',
        task_id: 'task-2',
        step_index: 2,
        files: [{ path: 'src/api.ts', hash_before: 'a', hash_after: 'b' }],
        db_mutations: null,
        rollback_commands: ['git checkout -- src/api.ts'],
        created_at: '2026-01-01T00:00:00.000Z',
      },
    ],
    key_decisions: ['Use TypeScript', 'REST API over GraphQL'],
    unresolved_questions: ['Database selection pending'],
    file_changes: ['src/api.ts: +120 lines', 'package.json: updated'],
    conversation_summary: 'User asked to build an API service. Project initialized, API implementation in progress.',
    session_context: 'User prefers TypeScript with strict mode',
  };

  it('generate creates a valid handoff document', () => {
    const doc = generate(mockSessionState);

    expect(doc.session_id).toBe('session-001');
    expect(doc.trigger).toBe('watermark_95');
    expect(doc.created_at).toBeTruthy();
    expect(Object.keys(doc.task_snapshot)).toHaveLength(3);
    expect(doc.key_decisions).toHaveLength(2);
    expect(doc.unresolved_questions).toHaveLength(1);
    expect(Object.keys(doc.active_agents)).toHaveLength(2);
    expect(doc.file_changes).toHaveLength(2);
    expect(doc.conversation_summary).toBeTruthy();
    expect(doc.session_context).toBe('User prefers TypeScript with strict mode');
    expect(doc.hard_state).toBeDefined();
    expect(doc.hard_state!.tasks).toHaveLength(3);
    expect(doc.hard_state!.workers).toHaveLength(2);
  });

  it('generate maps task statuses correctly', () => {
    const doc = generate(mockSessionState);
    expect(doc.task_snapshot['task-1'].status).toBe('completed');
    expect(doc.task_snapshot['task-2'].status).toBe('in_progress');
    expect(doc.task_snapshot['task-3'].status).toBe('blocked');
  });

  it('generate with different triggers', () => {
    const doc = generate(mockSessionState, 'user_command');
    expect(doc.trigger).toBe('user_command');

    const doc2 = generate(mockSessionState, 'crash_recovery');
    expect(doc2.trigger).toBe('crash_recovery');
  });

  it('restore creates a new session from handoff', () => {
    const doc = generate(mockSessionState);
    const restored = restore(doc);

    expect(restored.session_id).toBeTruthy();
    expect(restored.session_id).not.toBe('session-001'); // New session
    expect(restored.state).toBe('IDLE');
    expect(restored.context).toContain('SESSION HANDOFF');
    expect(restored.context).toContain('session-001');
    expect(restored.context).toContain('Use TypeScript');
    expect(restored.context).toContain('Database selection pending');
    expect(restored.handoff).toEqual(doc);
    expect(restored.hard_state.tasks).toHaveLength(3);
  });

  it('restore includes task and agent info in context', () => {
    const doc = generate(mockSessionState);
    const restored = restore(doc);

    expect(restored.context).toContain('Hard State');
    expect(restored.context).toContain('Key Decisions');
    expect(restored.context).toContain('Workers');
    expect(restored.context).toContain('Checkpoints');
    expect(restored.context).toContain('File Changes');
    expect(restored.context).toContain('Soft Summary');
  });

  it('validate accepts valid handoff document', () => {
    const doc = generate(mockSessionState);
    expect(validate(doc)).toBe(true);
  });

  it('validate rejects invalid document', () => {
    expect(() => validate({ invalid: 'data' })).toThrow();
  });

  it('generate handles empty session state', () => {
    const empty: SessionState = {
      session_id: 'empty-session',
      tasks: [],
      agents: [],
      key_decisions: [],
      unresolved_questions: [],
      file_changes: [],
      conversation_summary: '',
      session_context: '',
    };

    const doc = generate(empty);
    expect(doc.session_id).toBe('empty-session');
    expect(Object.keys(doc.task_snapshot)).toHaveLength(0);
    expect(doc.key_decisions).toHaveLength(0);
  });

  it('persist stores handoff to event_log', () => {
    const doc = generate(mockSessionState);
    persist(doc);
    const latest = getLatest();
    expect(latest).not.toBeNull();
    expect(latest!.session_id).toBe('session-001');
    expect(latest!.trigger).toBe('watermark_95');
  });

  it('getLatest returns null when no handoff exists', () => {
    const result = getLatest('nonexistent-tenant');
    expect(result).toBeNull();
  });

  it('getLatest returns most recent handoff', () => {
    const doc1 = generate(mockSessionState, 'user_command');
    persist(doc1, 'multi-test');

    const state2 = { ...mockSessionState, session_id: 'session-002' };
    const doc2 = generate(state2, 'timeout');
    persist(doc2, 'multi-test');

    const latest = getLatest('multi-test');
    expect(latest).not.toBeNull();
    expect(latest!.session_id).toBe('session-002');
    expect(latest!.trigger).toBe('timeout');
  });

  it('getLatestForSession returns handoff only for requested session id', () => {
    const doc1 = generate(mockSessionState, 'user_command');
    persist(doc1, 'session-scope-test');

    const doc2 = generate({ ...mockSessionState, session_id: 'session-xyz' }, 'timeout');
    persist(doc2, 'session-scope-test');

    const latestFor001 = getLatestForSession('session-001', 'session-scope-test');
    expect(latestFor001).not.toBeNull();
    expect(latestFor001!.session_id).toBe('session-001');

    const latestForUnknown = getLatestForSession('missing-session', 'session-scope-test');
    expect(latestForUnknown).toBeNull();
  });

  it('restore from empty handoff produces minimal context', () => {
    const empty: SessionState = {
      session_id: 'empty-session',
      tasks: [],
      agents: [],
      key_decisions: [],
      unresolved_questions: [],
      file_changes: [],
      conversation_summary: '',
      session_context: '',
    };

    const doc = generate(empty);
    const restored = restore(doc);
    expect(restored.state).toBe('IDLE');
    expect(restored.context).toContain('SESSION HANDOFF');
  });

  // =========================================================================
  // Brain state integration tests
  // =========================================================================

  it('SessionHandoff with brain_state_snapshot serializes/deserializes correctly', () => {
    const brainSnapshot = {
      hard_state: {
        active_tasks: [{ id: 'task-1', title: 'Build API', status: 'running', assigned_agent: 'agent-1' }],
        recent_tool_outcomes: [{ tool: 'shell_exec', status: 'success' as const, summary: 'OK' }],
        user_original_request: 'Build an API',
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
      trigger: 'soft' as const,
    };

    const stateWithBrainState: SessionState = {
      ...mockSessionState,
      session_id: 'session-bs-1',
      brain_state_snapshot: brainSnapshot,
    };

    const doc = generate(stateWithBrainState);
    expect(doc.brain_state_snapshot).toBeDefined();
    expect(doc.brain_state_snapshot!.soft_state.reasoning.execution_plan).toBe('Build REST API');
    expect(doc.brain_state_snapshot!.hard_state.active_tasks).toHaveLength(1);

    // Persist and retrieve
    persist(doc, 'bs-tenant');
    const latest = getLatest('bs-tenant');
    expect(latest).not.toBeNull();
    expect(latest!.brain_state_snapshot).toBeDefined();
    expect(latest!.brain_state_snapshot!.soft_state.reasoning.current_step).toBe('Setting up routes');

    const db = getDb();
    const runtimeState = db.prepare(`
      SELECT payload
      FROM runtime_state
      WHERE tenant_id = 'bs-tenant' AND state_kind = 'session_hard_state' AND scope_type = 'session' AND scope_id = 'session-bs-1'
    `).get() as { payload: string } | undefined;
    expect(runtimeState).toBeDefined();
  });

  it('backward compat: old handoff without brain_state_snapshot still parses', () => {
    // Simulate a handoff doc from before brain_state_snapshot was added
    const legacyDoc = {
      session_id: 'legacy-session',
      created_at: new Date().toISOString(),
      trigger: 'watermark_95',
      task_snapshot: {},
      key_decisions: ['Used old format'],
      unresolved_questions: [],
      active_agents: {},
      file_changes: [],
      conversation_summary: 'Old session summary',
      session_context: '',
      // no brain_state_snapshot field
    };

    // validate should not throw
    expect(validate(legacyDoc)).toBe(true);

    // restore should work and not include brain state section in context
    const restored = restore(legacyDoc as SessionHandoff);
    expect(restored.context).toContain('SESSION HANDOFF');
    expect(restored.context).not.toContain('Brain State');
  });

  it('restore() includes brain state in context when present', () => {
    const brainSnapshot = {
      hard_state: {
        active_tasks: [],
        recent_tool_outcomes: [],
        user_original_request: 'Deploy the app',
      },
      soft_state: {
        reasoning: {
          execution_plan: 'Build and deploy',
          current_step: 'Running tests',
          completed_steps: ['Wrote code'],
          key_decisions: ['Use Docker'],
          pending_actions: ['Push to registry'],
        },
      },
      snapshot_at: '2026-01-01T00:00:00.000Z',
      trigger: 'hard' as const,
    };

    const stateWithBrainState: SessionState = {
      ...mockSessionState,
      session_id: 'session-bs-restore',
      brain_state_snapshot: brainSnapshot,
    };

    const doc = generate(stateWithBrainState);
    const restored = restore(doc);

    // Context should contain brain state information
    expect(restored.context).toContain('Brain State');
    expect(restored.context).toContain('Deploy the app');
    expect(restored.context).toContain('Build and deploy');
    expect(restored.context).toContain('Running tests');
  });
});
