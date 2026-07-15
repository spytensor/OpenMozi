/**
 * Brain State Checkpoint — extracts, persists, and injects structured
 * execution state across context compression boundaries.
 *
 * When the token budget watermark triggers compression, this module:
 * 1. Extracts structured state from DB + runtime + dialogue (via LLM)
 * 2. Persists the snapshot to event_log (if configured)
 * 3. Injects the snapshot as a protected system message that survives compression
 *
 * This prevents "断片" — the agent losing track of what it was doing
 * when dialogue history is compressed or rotated.
 */

import { z } from 'zod';
import { getConfig } from '../config/index.js';
import { getClientForTask } from './model-router.js';
import { getDb } from '../store/db.js';
import { log as logEvent } from '../store/events.js';
import type { ChatMessage, LLMClient } from './llm.js';
import { getTextContent } from './llm.js';
import { upsertRuntimeState } from './hard-state-plane.js';
import pino from 'pino';

const logger = pino({ name: 'mozi:brain-state' });

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Marker string embedded in brain state system messages for identification. */
export const BRAIN_STATE_MARKER = '[BRAIN_STATE_CHECKPOINT — DO NOT COMPRESS]';

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/** Task snapshot extracted from DB */
const TaskEntrySchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  assigned_agent: z.string().nullable().default(null),
});

/** Tool outcome extracted from DB */
const ToolOutcomeEntrySchema = z.object({
  tool: z.string(),
  status: z.enum(['success', 'error']),
  summary: z.string().default(''),
});

/** LLM-extracted reasoning state */
const ReasoningStateSchema = z.object({
  execution_plan: z.string().default(''),
  current_step: z.string().default(''),
  completed_steps: z.array(z.string()).default([]),
  key_decisions: z.array(z.string()).default([]),
  pending_actions: z.array(z.string()).default([]),
});
const DEFAULT_REASONING_STATE = {
  execution_plan: '',
  current_step: '',
  completed_steps: [],
  key_decisions: [],
  pending_actions: [],
};

export const BrainStateHardStateSchema = z.object({
  active_tasks: z.array(TaskEntrySchema).default([]),
  recent_tool_outcomes: z.array(ToolOutcomeEntrySchema).default([]),
  user_original_request: z.string().default(''),
});

export type BrainStateHardState = z.infer<typeof BrainStateHardStateSchema>;

export const BrainStateSoftStateSchema = z.object({
  reasoning: ReasoningStateSchema.default(DEFAULT_REASONING_STATE),
});

export type BrainStateSoftState = z.infer<typeof BrainStateSoftStateSchema>;

const LegacyBrainStateSnapshotSchema = z.object({
  active_tasks: z.array(TaskEntrySchema).default([]),
  recent_tool_outcomes: z.array(ToolOutcomeEntrySchema).default([]),
  user_original_request: z.string().default(''),
  reasoning: ReasoningStateSchema.default(DEFAULT_REASONING_STATE),
  snapshot_at: z.string(),
  trigger: z.enum(['soft', 'hard', 'rotate', 'in_loop']),
});

const StructuredBrainStateSnapshotSchema = z.object({
  hard_state: BrainStateHardStateSchema.default({
    active_tasks: [],
    recent_tool_outcomes: [],
    user_original_request: '',
  }),
  soft_state: BrainStateSoftStateSchema.default({ reasoning: DEFAULT_REASONING_STATE }),
  snapshot_at: z.string(),
  trigger: z.enum(['soft', 'hard', 'rotate', 'in_loop']),
});

/** Full brain state snapshot */
export const BrainStateSnapshotSchema = z.union([
  StructuredBrainStateSnapshotSchema,
  LegacyBrainStateSnapshotSchema,
]).transform((value) => {
  if ('hard_state' in value) {
    return {
      hard_state: BrainStateHardStateSchema.parse(value.hard_state),
      soft_state: BrainStateSoftStateSchema.parse(value.soft_state),
      snapshot_at: value.snapshot_at,
      trigger: value.trigger,
    };
  }

  return {
    hard_state: BrainStateHardStateSchema.parse({
      active_tasks: value.active_tasks,
      recent_tool_outcomes: value.recent_tool_outcomes,
      user_original_request: value.user_original_request,
    }),
    soft_state: BrainStateSoftStateSchema.parse({
      reasoning: value.reasoning,
    }),
    snapshot_at: value.snapshot_at,
    trigger: value.trigger,
  };
});

export type BrainStateSnapshot = z.output<typeof BrainStateSnapshotSchema>;
export type SnapshotTrigger = BrainStateSnapshot['trigger'];

// ---------------------------------------------------------------------------
// Runtime context interface
// ---------------------------------------------------------------------------

export interface BrainStateRuntimeContext {
  chatId: string;
  tenantId: string;
  userId?: string;
  userOriginalRequest?: string;
}

// ---------------------------------------------------------------------------
// LLM extraction prompt
// ---------------------------------------------------------------------------

const EXTRACTION_PROMPT = `You are a state extraction engine. Given recent conversation messages, extract the current execution state as JSON.

Output ONLY valid JSON with this exact structure:
{
  "execution_plan": "brief description of the overall plan/approach",
  "current_step": "what is being done right now",
  "completed_steps": ["step 1 done", "step 2 done"],
  "key_decisions": ["decided X because Y"],
  "pending_actions": ["still need to do Z"]
}

Rules:
- Be concise — each field should be 1-2 sentences max
- completed_steps and pending_actions: max 5 items each
- If no clear plan exists, use empty strings/arrays
- Output ONLY the JSON object, no markdown fences, no explanation`;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract a brain state snapshot from DB + runtime + dialogue.
 *
 * @param dialogue     - Current conversation messages
 * @param ctx          - Runtime context (chatId, tenantId, userOriginalRequest)
 * @param trigger      - What watermark level triggered this extraction
 * @param clientOverride - Optional LLM client override (for testing)
 * @returns Structured brain state snapshot
 */
export async function extractBrainState(
  dialogue: ChatMessage[],
  ctx: BrainStateRuntimeContext,
  trigger: SnapshotTrigger,
  clientOverride?: LLMClient,
): Promise<BrainStateSnapshot> {
  const config = getConfig();
  const brainStateConfig = config.brain_state;

  if (!brainStateConfig.enabled) {
    logger.debug('Brain state extraction disabled by config');
    return emptySnapshot(trigger, ctx.userOriginalRequest);
  }

  // 1. Extract structured state from DB
  const activeTasks = queryActiveTasks(ctx.tenantId);
  const recentOutcomes = queryRecentToolOutcomes(ctx.tenantId, ctx.chatId);

  // 2. Extract reasoning state from dialogue via LLM
  const reasoning = await extractReasoningState(
    dialogue,
    brainStateConfig.extraction_model,
    brainStateConfig.max_snapshot_tokens,
    ctx,
    clientOverride,
  );

  const snapshot = BrainStateSnapshotSchema.parse({
    hard_state: {
      active_tasks: activeTasks,
      recent_tool_outcomes: recentOutcomes,
      user_original_request: ctx.userOriginalRequest ?? '',
    },
    soft_state: {
      reasoning,
    },
    snapshot_at: new Date().toISOString(),
    trigger,
  });

  // 3. Persist to event_log if configured
  if (brainStateConfig.persist_to_db) {
    persistSnapshot(snapshot, ctx.tenantId, ctx.chatId);
  }

  logger.info({
    trigger,
    chatId: ctx.chatId,
    activeTasks: activeTasks.length,
    recentOutcomes: recentOutcomes.length,
    hasReasoningState: !!snapshot.soft_state.reasoning.current_step,
  }, 'Brain state snapshot extracted');

  return snapshot;
}

/**
 * Inject a brain state snapshot into messages as a protected system message.
 *
 * - Removes any existing brain state messages (no duplicates)
 * - Inserts after the first system message (high priority position)
 * - Marked with BRAIN_STATE_MARKER so compressors skip it
 *
 * @param snapshot - The brain state snapshot to inject
 * @param messages - Current message array
 * @returns New message array with brain state injected
 */
export function injectBrainState(
  snapshot: BrainStateSnapshot,
  messages: ChatMessage[],
): ChatMessage[] {
  // Remove any existing brain state messages
  const filtered = removeBrainStateMessages(messages);

  // Format snapshot as readable text
  const content = formatSnapshot(snapshot);

  // Find insertion point: after first system message
  const firstSystemIdx = filtered.findIndex(m => m.role === 'system');
  const insertIdx = firstSystemIdx >= 0 ? firstSystemIdx + 1 : 0;

  // Insert as system message
  const result = [...filtered];
  result.splice(insertIdx, 0, {
    role: 'system',
    content,
  });

  return result;
}

/**
 * Remove all brain state marker messages from a message array.
 */
export function removeBrainStateMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter(m => !isBrainStateMessage(m));
}

/**
 * Check if a message is a brain state checkpoint message.
 */
export function isBrainStateMessage(msg: ChatMessage): boolean {
  return msg.role === 'system' && getTextContent(msg).includes(BRAIN_STATE_MARKER);
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * Format a brain state snapshot as a readable system message.
 */
export function formatSnapshot(snapshot: BrainStateSnapshot): string {
  const hardState = snapshot.hard_state;
  const reasoning = snapshot.soft_state.reasoning;
  const parts: string[] = [BRAIN_STATE_MARKER];
  parts.push(`Snapshot: ${snapshot.snapshot_at} | Trigger: ${snapshot.trigger}`);
  parts.push('');

  // User request
  if (hardState.user_original_request) {
    parts.push(`## User Request`);
    parts.push(hardState.user_original_request);
    parts.push('');
  }

  // Execution state
  if (reasoning.execution_plan || reasoning.current_step) {
    parts.push('## Execution State');
    if (reasoning.execution_plan) parts.push(`Plan: ${reasoning.execution_plan}`);
    if (reasoning.current_step) parts.push(`Current step: ${reasoning.current_step}`);
    if (reasoning.completed_steps.length > 0) {
      parts.push('Completed:');
      for (const s of reasoning.completed_steps) parts.push(`  ✓ ${s}`);
    }
    if (reasoning.pending_actions.length > 0) {
      parts.push('Pending:');
      for (const s of reasoning.pending_actions) parts.push(`  → ${s}`);
    }
    parts.push('');
  }

  // Key decisions
  if (reasoning.key_decisions.length > 0) {
    parts.push('## Key Decisions');
    for (const d of reasoning.key_decisions) parts.push(`- ${d}`);
    parts.push('');
  }

  // Active tasks from DB
  if (hardState.active_tasks.length > 0) {
    parts.push('## Active Tasks (from DB)');
    for (const t of hardState.active_tasks) {
      const agent = t.assigned_agent ? ` [${t.assigned_agent}]` : '';
      parts.push(`- ${t.id}: ${t.title} (${t.status})${agent}`);
    }
    parts.push('');
  }

  // Recent tool outcomes
  if (hardState.recent_tool_outcomes.length > 0) {
    parts.push('## Recent Tool Results');
    for (const o of hardState.recent_tool_outcomes) {
      const icon = o.status === 'success' ? '✓' : '✗';
      parts.push(`- ${icon} ${o.tool}${o.summary ? ': ' + o.summary : ''}`);
    }
  }

  return parts.join('\n');
}

/**
 * Format a brain state snapshot for inclusion in session handoff context.
 * (More compact than the full system message format.)
 */
export function formatSnapshotForHandoff(snapshot: BrainStateSnapshot): string {
  const parts: string[] = [];
  const hardState = snapshot.hard_state;
  const reasoning = snapshot.soft_state.reasoning;

  if (hardState.user_original_request) {
    parts.push(`Original request: ${hardState.user_original_request}`);
  }
  if (reasoning.execution_plan) parts.push(`Plan: ${reasoning.execution_plan}`);
  if (reasoning.current_step) parts.push(`At step: ${reasoning.current_step}`);
  if (reasoning.completed_steps.length > 0) {
    parts.push(`Done: ${reasoning.completed_steps.join('; ')}`);
  }
  if (reasoning.pending_actions.length > 0) {
    parts.push(`Pending: ${reasoning.pending_actions.join('; ')}`);
  }
  if (reasoning.key_decisions.length > 0) {
    parts.push(`Decisions: ${reasoning.key_decisions.join('; ')}`);
  }

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// DB queries
// ---------------------------------------------------------------------------

/**
 * Query active tasks from the tasks table.
 */
function queryActiveTasks(tenantId: string): BrainStateHardState['active_tasks'] {
  try {
    const db = getDb();
    const rows = db.prepare(`
      SELECT id, title, status, assigned_agent
      FROM tasks
      WHERE tenant_id = ? AND status IN ('running', 'assigned', 'pending')
      ORDER BY
        CASE status WHEN 'running' THEN 0 WHEN 'assigned' THEN 1 ELSE 2 END,
        updated_at DESC
      LIMIT 10
    `).all(tenantId) as Array<{
      id: string;
      title: string;
      status: string;
      assigned_agent: string | null;
    }>;

    return rows.map(r => ({
      id: r.id,
      title: r.title,
      status: r.status,
      assigned_agent: r.assigned_agent,
    }));
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Failed to query active tasks for brain state');
    return [];
  }
}

/**
 * Query recent tool outcomes from the tool_outcomes table.
 */
function queryRecentToolOutcomes(
  tenantId: string,
  chatId: string,
): BrainStateHardState['recent_tool_outcomes'] {
  try {
    const db = getDb();
    const rows = db.prepare(`
      SELECT tool_name, outcome, error_summary
      FROM tool_outcomes
      WHERE tenant_id = ? AND chat_id = ?
        AND created_at > datetime('now', '-1 hour')
      ORDER BY id DESC
      LIMIT 10
    `).all(tenantId, chatId) as Array<{
      tool_name: string;
      outcome: string;
      error_summary: string | null;
    }>;

    return rows.map(r => ({
      tool: r.tool_name,
      status: r.outcome as 'success' | 'error',
      summary: r.error_summary ?? '',
    }));
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Failed to query tool outcomes for brain state');
    return [];
  }
}

// ---------------------------------------------------------------------------
// LLM reasoning extraction
// ---------------------------------------------------------------------------

/**
 * Extract reasoning state from dialogue using LLM.
 */
async function extractReasoningState(
  dialogue: ChatMessage[],
  extractionModel: string,
  maxTokens: number,
  routingContext: Pick<BrainStateRuntimeContext, 'tenantId' | 'userId'>,
  clientOverride?: LLMClient,
): Promise<z.infer<typeof ReasoningStateSchema>> {
  const empty = ReasoningStateSchema.parse({});

  // Take last N messages for extraction (don't send entire history)
  const recentMessages = dialogue
    .filter(m => m.role !== 'system' || !getTextContent(m).includes(BRAIN_STATE_MARKER))
    .slice(-12);

  if (recentMessages.length === 0) {
    return empty;
  }

  // Build conversation text, truncating long messages
  const conversationText = recentMessages
    .map(m => {
      const content = m.content || '';
      const truncated = content.length > 1500 ? content.slice(0, 1500) + '...' : content;
      return `${m.role}: ${truncated}`;
    })
    .join('\n');

  try {
    // Get LLM client
    let client: LLMClient;
    if (clientOverride) {
      client = clientOverride;
    } else {
      const taskHints = extractionModel === 'auto'
        ? { type: 'summary' as const, complexity: 'low' as const }
        : { type: 'general' as const, complexity: 'low' as const };
      const result = getClientForTask(taskHints, routingContext);
      client = result.client;
    }

    const response = await client.chat([
      { role: 'system', content: EXTRACTION_PROMPT },
      { role: 'user', content: conversationText },
    ], {
      max_tokens: Math.min(maxTokens, 400),
      temperature: 0.1,
    });

    return parseReasoningResponse(response.content);
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'LLM reasoning extraction failed, using empty state',
    );
    return empty;
  }
}

/**
 * Parse LLM response into structured reasoning state.
 * Handles malformed responses gracefully.
 */
function parseReasoningResponse(content: string): z.infer<typeof ReasoningStateSchema> {
  const empty = ReasoningStateSchema.parse({});

  try {
    // Strip markdown fences if present
    let cleaned = content.trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
    }

    const parsed = JSON.parse(cleaned);
    return ReasoningStateSchema.parse(parsed);
  } catch {
    // Try to extract JSON from response if it's wrapped in text
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        return ReasoningStateSchema.parse(parsed);
      } catch {
        // Fall through to empty
      }
    }

    logger.debug('Could not parse LLM reasoning response, using empty state');
    return empty;
  }
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * Persist a brain state snapshot to the event_log table.
 */
function persistSnapshot(snapshot: BrainStateSnapshot, tenantId: string, chatId: string): void {
  try {
    logEvent('brain_state_snapshot', 'chat', chatId, snapshot, tenantId);
    upsertRuntimeState('brain_state_snapshot', 'chat', chatId, snapshot, tenantId);
    logger.debug({ chatId, trigger: snapshot.trigger }, 'Brain state snapshot persisted');
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'Failed to persist brain state snapshot',
    );
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create an empty snapshot (used when extraction is disabled or fails).
 */
function emptySnapshot(trigger: SnapshotTrigger, userRequest?: string): BrainStateSnapshot {
  return BrainStateSnapshotSchema.parse({
    hard_state: {
      user_original_request: userRequest ?? '',
    },
    soft_state: {
      reasoning: {},
    },
    snapshot_at: new Date().toISOString(),
    trigger,
  });
}
