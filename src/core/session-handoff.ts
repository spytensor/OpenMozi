/**
 * Session Handoff — generates and restores handoff documents for session rotation.
 *
 * When the token budget reaches 95% watermark, Brain generates a handoff
 * document capturing the current state. A new session loads this document
 * to continue where the old session left off.
 */

import { getDb } from '../store/db.js';
import { log as logEvent } from '../store/events.js';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import pino from 'pino';
import { BrainStateSnapshotSchema, type BrainStateSnapshot, formatSnapshotForHandoff } from './brain-state.js';
import {
  HardStateBundleSchema,
  buildHardStateBundle,
  formatHardStateBundleForPrompt,
  getRuntimeState,
  persistHardStateBundle,
  type CheckpointHardState,
  type HardStateBundle,
} from './hard-state-plane.js';

const logger = pino({ name: 'mozi:session-handoff' });

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const HandoffTrigger = z.enum(['watermark_95', 'user_command', 'timeout', 'crash_recovery']);
export type HandoffTriggerType = z.infer<typeof HandoffTrigger>;

export const TaskSnapshotEntry = z.object({
  status: z.enum(['completed', 'in_progress', 'blocked', 'failed']),
  progress: z.string().default(''),
  assigned_agent: z.string().nullable().default(null),
  key_output: z.string().default(''),
});

export const ActiveAgentEntry = z.object({
  role: z.string(),
  status: z.enum(['running', 'blocked']),
  task_id: z.string(),
});

export const SessionHandoffSchema = z.object({
  session_id: z.string(),
  created_at: z.string(),
  trigger: HandoffTrigger,
  task_snapshot: z.record(z.string(), TaskSnapshotEntry),
  key_decisions: z.array(z.string()),
  unresolved_questions: z.array(z.string()),
  active_agents: z.record(z.string(), ActiveAgentEntry),
  file_changes: z.array(z.string()),
  conversation_summary: z.string(),
  session_context: z.string().default(''),
  brain_state_snapshot: BrainStateSnapshotSchema.optional(),
  hard_state: HardStateBundleSchema.optional(),
});

export type SessionHandoff = z.infer<typeof SessionHandoffSchema>;

// ---------------------------------------------------------------------------
// Types for generate()
// ---------------------------------------------------------------------------

export interface SessionState {
  session_id: string;
  state?: 'IDLE' | 'WORKING' | 'RESPONDING';
  tasks: Array<{
    id: string;
    status: string;
    title: string;
    progress?: string;
    assigned_agent?: string | null;
    key_output?: string;
  }>;
  agents: Array<{
    id: string;
    role: string;
    status: string;
    task_id: string;
  }>;
  checkpoints?: CheckpointHardState[];
  key_decisions: string[];
  unresolved_questions: string[];
  file_changes: string[];
  conversation_summary: string;
  session_context: string;
  brain_state_snapshot?: BrainStateSnapshot;
  hard_state?: HardStateBundle;
}

export interface RestoredSession {
  session_id: string;
  state: 'IDLE';
  context: string;
  handoff: SessionHandoff;
  hard_state: HardStateBundle;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate a handoff document from the current session state.
 */
export function generate(
  sessionState: SessionState,
  trigger: HandoffTriggerType = 'watermark_95',
): SessionHandoff {
  const hardState = sessionState.hard_state ?? buildHardStateBundle({
    session_id: sessionState.session_id,
    session_state: sessionState.state ?? 'IDLE',
    file_changes: sessionState.file_changes,
    tasks: sessionState.tasks.map(task => ({
      id: task.id,
      title: task.title,
      status: task.status,
      assigned_agent: task.assigned_agent ?? null,
      progress: task.progress ?? '',
      key_output: task.key_output ?? '',
      checkpoints: (sessionState.checkpoints ?? [])
        .filter(checkpoint => checkpoint.task_id === task.id)
        .map(checkpoint => ({
          checkpoint_id: checkpoint.checkpoint_id,
          step_index: checkpoint.step_index,
          created_at: checkpoint.created_at,
        })),
    })),
    workers: sessionState.agents.map(agent => ({
      id: agent.id,
      role: agent.role,
      status: agent.status,
      task_id: agent.task_id,
    })),
    checkpoints: sessionState.checkpoints ?? [],
  });

  const taskSnapshot: Record<string, z.infer<typeof TaskSnapshotEntry>> = {};

  for (const task of sessionState.tasks) {
    const mappedStatus = mapTaskStatus(task.status);
    taskSnapshot[task.id] = {
      status: mappedStatus,
      progress: task.progress ?? '',
      assigned_agent: task.assigned_agent ?? null,
      key_output: task.key_output ?? '',
    };
  }

  const activeAgents: Record<string, z.infer<typeof ActiveAgentEntry>> = {};
  for (const agent of sessionState.agents) {
    activeAgents[agent.id] = {
      role: agent.role,
      status: agent.status as 'running' | 'blocked',
      task_id: agent.task_id,
    };
  }

  const handoff: SessionHandoff = {
    session_id: sessionState.session_id,
    created_at: new Date().toISOString(),
    trigger,
    task_snapshot: taskSnapshot,
    key_decisions: sessionState.key_decisions,
    unresolved_questions: sessionState.unresolved_questions,
    active_agents: activeAgents,
    file_changes: sessionState.file_changes,
    conversation_summary: sessionState.conversation_summary,
    session_context: sessionState.session_context,
    brain_state_snapshot: sessionState.brain_state_snapshot,
    hard_state: hardState,
  };

  // Validate through schema
  const validated = SessionHandoffSchema.parse(handoff);

  logger.info({
    session_id: validated.session_id,
    trigger,
    tasks: Object.keys(validated.task_snapshot).length,
    agents: Object.keys(validated.active_agents).length,
    decisions: validated.key_decisions.length,
  }, 'Handoff document generated');

  return validated;
}

/**
 * Restore a session from a handoff document.
 * Creates a new session with the handoff context loaded.
 */
export function restore(handoff: SessionHandoff, tenantId = 'default'): RestoredSession {
  // Validate handoff document
  const validated = SessionHandoffSchema.parse(handoff);
  const hardState = validated.hard_state
    ?? getRuntimeState(
      'session_hard_state',
      'session',
      validated.session_id,
      HardStateBundleSchema,
      tenantId,
    )
    ?? buildHardStateBundle({
      session_id: validated.session_id,
      session_state: 'IDLE',
      file_changes: validated.file_changes,
      tasks: Object.entries(validated.task_snapshot).map(([taskId, task]) => ({
        id: taskId,
        title: taskId,
        status: task.status,
        assigned_agent: task.assigned_agent,
        progress: task.progress,
        key_output: task.key_output,
        checkpoints: [],
      })),
      workers: Object.entries(validated.active_agents).map(([agentId, agent]) => ({
        id: agentId,
        role: agent.role,
        status: agent.status,
        task_id: agent.task_id,
      })),
      checkpoints: [],
    });

  const newSessionId = randomUUID();

  // Build context string from handoff
  const contextParts: string[] = [
    '=== SESSION HANDOFF ===',
    `Previous session: ${validated.session_id}`,
    `Trigger: ${validated.trigger}`,
    `Created: ${validated.created_at}`,
    '',
  ];

  contextParts.push(formatHardStateBundleForPrompt(hardState));
  contextParts.push('');

  // Task status summary
  if (validated.key_decisions.length > 0) {
    contextParts.push('--- Key Decisions ---');
    for (const d of validated.key_decisions) {
      contextParts.push(`  - ${d}`);
    }
    contextParts.push('');
  }

  // Unresolved questions
  if (validated.unresolved_questions.length > 0) {
    contextParts.push('--- Unresolved ---');
    for (const q of validated.unresolved_questions) {
      contextParts.push(`  ? ${q}`);
    }
    contextParts.push('');
  }

  // Brain state from previous session
  if (validated.brain_state_snapshot) {
    contextParts.push('--- Brain State ---');
    contextParts.push(formatSnapshotForHandoff(validated.brain_state_snapshot));
    contextParts.push('');
  }

  // Preserve legacy soft summary/context, but keep it secondary to hard state.
  if (Object.keys(validated.task_snapshot).length > 0 && !validated.hard_state) {
    contextParts.push('--- Tasks ---');
    for (const [taskId, snap] of Object.entries(validated.task_snapshot)) {
      contextParts.push(`  ${taskId}: ${snap.status}${snap.progress ? ` (${snap.progress})` : ''}`);
      if (snap.key_output) contextParts.push(`    Output: ${snap.key_output}`);
    }
    contextParts.push('');
  }

  if (Object.keys(validated.active_agents).length > 0 && !validated.hard_state) {
    contextParts.push('--- Active Agents ---');
    for (const [agentId, agent] of Object.entries(validated.active_agents)) {
      contextParts.push(`  ${agentId}: ${agent.role} (${agent.status}) → task ${agent.task_id}`);
    }
    contextParts.push('');
  }

  if (validated.file_changes.length > 0 && !validated.hard_state) {
    contextParts.push('--- File Changes ---');
    for (const f of validated.file_changes) {
      contextParts.push(`  ${f}`);
    }
    contextParts.push('');
  }

  // Conversation summary
  if (validated.conversation_summary) {
    contextParts.push('--- Soft Summary ---');
    contextParts.push(validated.conversation_summary);
    contextParts.push('');
  }

  // Session context
  if (validated.session_context) {
    contextParts.push('--- Soft Context ---');
    contextParts.push(validated.session_context);
  }

  const context = contextParts.join('\n');

  logger.info({
    old_session: validated.session_id,
    new_session: newSessionId,
    context_length: context.length,
  }, 'Session restored from handoff');

  try {
    logEvent(
      'session_handoff_restore',
      'session',
      newSessionId,
      { from_session_id: validated.session_id, trigger: validated.trigger },
      tenantId,
    );
  } catch (err) {
    logger.warn({
      old_session: validated.session_id,
      new_session: newSessionId,
      err: err instanceof Error ? err.message : String(err),
    }, 'Failed to persist handoff restore event');
  }

  return {
    session_id: newSessionId,
    state: 'IDLE',
    context,
    handoff: validated,
    hard_state: hardState,
  };
}

/**
 * Persist a handoff document to the event log.
 */
export function persist(doc: SessionHandoff, tenantId = 'default'): void {
  logEvent('session_handoff', 'session', doc.session_id, doc, tenantId);
  if (doc.hard_state) {
    persistHardStateBundle(doc.hard_state, tenantId);
  }
  logger.info({ session_id: doc.session_id, tenant_id: tenantId }, 'Handoff document persisted');
}

/**
 * Get the most recent handoff document from the event log.
 */
export function getLatest(tenantId = 'default'): SessionHandoff | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT payload FROM event_log
    WHERE tenant_id = ? AND event_type = 'session_handoff'
    ORDER BY id DESC
    LIMIT 1
  `).get(tenantId) as { payload: string } | undefined;

  if (!row) return null;

  const parsed = JSON.parse(row.payload);
  return SessionHandoffSchema.parse(parsed);
}

/**
 * Get the most recent handoff document for a specific previous session.
 */
export function getLatestForSession(sessionId: string, tenantId = 'default'): SessionHandoff | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT payload FROM event_log
    WHERE tenant_id = ? AND event_type = 'session_handoff' AND entity_id = ?
    ORDER BY id DESC
    LIMIT 1
  `).get(tenantId, sessionId) as { payload: string } | undefined;

  if (!row) return null;

  const parsed = JSON.parse(row.payload);
  return SessionHandoffSchema.parse(parsed);
}

/**
 * Validate a handoff document against the schema.
 * Returns true if valid, throws if invalid.
 */
export function validate(doc: unknown): doc is SessionHandoff {
  SessionHandoffSchema.parse(doc);
  return true;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function mapTaskStatus(status: string): 'completed' | 'in_progress' | 'blocked' | 'failed' {
  switch (status) {
    case 'completed': return 'completed';
    case 'failed': return 'failed';
    case 'blocked': return 'blocked';
    case 'running':
    case 'assigned':
    case 'ready':
    case 'pending':
    default:
      return 'in_progress';
  }
}
