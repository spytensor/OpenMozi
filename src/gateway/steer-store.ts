/**
 * Steer store — holds mid-turn user nudges queued via `/steer <text>` (#257).
 *
 * Decoupled from Session FSM on purpose. Session FSM stays at
 * IDLE/WORKING/RESPONDING (no non-transitioning event). Channels enqueue steer
 * text here; the brain tool-call loop drains the queue at each iteration top
 * and injects it as a `user_steer` runtime message (see runtime-message-ir.ts).
 *
 * Rate-limit policy (gateway layer, not channel layer — so every channel
 * inherits the same cap):
 *   - length ≤ 500 chars per entry
 *   - ≤ 3 queued entries per chatId (dropped with reason 'rate_limited')
 *   - empty / non-string → 'empty' / 'not_string'
 *
 * Lifetime management:
 *   - opportunistic GC on each enqueue drops chatIds whose oldest pending
 *     entry is > 1h old AND whose last brain activity is > 1h old — prevents
 *     unbounded map growth if a chat is abandoned before the brain drains it
 *   - `markBrainActivity(chatId)` is called by the brain loop each iteration
 *     to support the §10 "brain idle" user-visible hint on re-enqueue
 *   - `PROMPT_CACHE_TTL_MS` (5 min) is the Anthropic prompt cache TTL; when
 *     the brain has been idle longer, enqueue returns `brainIdle: true` so
 *     the ack message can warn the user (§10 Fallback Discipline: no silent
 *     downgrade).
 */
import pino from 'pino';
import { log as logEvent } from '../store/events.js';

const logger = pino({ name: 'mozi:gateway:steer-store' });

export const STEER_MAX_LENGTH = 500;
export const STEER_MAX_PER_TURN = 3;
export const PROMPT_CACHE_TTL_MS = 5 * 60 * 1000; // Anthropic prompt cache TTL
export const STEER_GC_AGE_MS = 60 * 60 * 1000;    // drop abandoned chatIds after 1h

interface Entry {
  text: string;
  enqueuedAt: number;
}

const pendingByChat = new Map<string, Entry[]>();
const lastBrainAtByChat = new Map<string, number>();

export type EnqueueReason = 'empty' | 'not_string' | 'too_long' | 'rate_limited';

export interface EnqueueResult {
  accepted: boolean;
  reason?: EnqueueReason;
  /** True when brain has been idle longer than the prompt cache TTL (#263 review §10). */
  brainIdle?: boolean;
}

function audit(event: string, chatId: string, tenantId: string, detail: Record<string, unknown>): void {
  try {
    logEvent(event, 'steer', chatId, detail, tenantId);
  } catch (err) {
    logger.warn({ err: (err as Error).message, event, chatId }, 'steer audit log failed');
  }
}

/**
 * Opportunistic garbage collection. Called from enqueue so we pay O(N) only
 * when someone is actively adding steers. A chatId is reclaimed iff both:
 *   - its oldest pending entry (if any) is > STEER_GC_AGE_MS old, AND
 *   - its last-brain-activity timestamp (if any) is > STEER_GC_AGE_MS old.
 * This way a merely-quiet chat that the brain will drain soon is not dropped.
 */
function maybeGcStale(now: number): void {
  for (const [chatId, entries] of pendingByChat) {
    const oldestEntry = entries[0]?.enqueuedAt ?? Infinity;
    const lastBrain = lastBrainAtByChat.get(chatId) ?? -Infinity;
    const entriesStale = oldestEntry < now - STEER_GC_AGE_MS;
    const brainStale = lastBrain < now - STEER_GC_AGE_MS;
    if (entriesStale && brainStale) {
      pendingByChat.delete(chatId);
      lastBrainAtByChat.delete(chatId);
    }
  }
  // Also reclaim orphan lastBrainAt entries with no pending queue.
  for (const [chatId, lastBrain] of lastBrainAtByChat) {
    if (!pendingByChat.has(chatId) && lastBrain < now - STEER_GC_AGE_MS) {
      lastBrainAtByChat.delete(chatId);
    }
  }
}

export function enqueueSteer(
  chatId: string,
  text: unknown,
  tenantId: string = 'default',
): EnqueueResult {
  const now = Date.now();
  maybeGcStale(now);

  if (typeof text !== 'string') {
    audit('security.steer_rejected', chatId, tenantId, { reason: 'not_string' });
    return { accepted: false, reason: 'not_string' };
  }
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    audit('security.steer_rejected', chatId, tenantId, { reason: 'empty' });
    return { accepted: false, reason: 'empty' };
  }
  if (trimmed.length > STEER_MAX_LENGTH) {
    audit('security.steer_rate_limited', chatId, tenantId, { reason: 'too_long', len: trimmed.length });
    return { accepted: false, reason: 'too_long' };
  }
  const queue = pendingByChat.get(chatId) ?? [];
  if (queue.length >= STEER_MAX_PER_TURN) {
    audit('security.steer_rate_limited', chatId, tenantId, { reason: 'count', queued: queue.length });
    return { accepted: false, reason: 'rate_limited' };
  }
  queue.push({ text: trimmed, enqueuedAt: now });
  pendingByChat.set(chatId, queue);

  // §10 — detect brain-idle condition so the caller can surface a visible hint.
  const lastBrain = lastBrainAtByChat.get(chatId);
  const brainIdle = lastBrain === undefined || now - lastBrain > PROMPT_CACHE_TTL_MS;
  return { accepted: true, brainIdle };
}

export function drainSteer(chatId: string): string[] {
  const queue = pendingByChat.get(chatId);
  if (!queue || queue.length === 0) return [];
  pendingByChat.delete(chatId);
  return queue.map(e => e.text);
}

export function peekSteerCount(chatId: string): number {
  return pendingByChat.get(chatId)?.length ?? 0;
}

/** Called by the brain loop every iteration so enqueueSteer can answer §10. */
export function markBrainActivity(chatId: string): void {
  lastBrainAtByChat.set(chatId, Date.now());
}

/** Test helper — clear all pending steer state. */
export function __resetSteerStoreForTests(): void {
  pendingByChat.clear();
  lastBrainAtByChat.clear();
}

/** Test helper — inject synthetic lastBrainAt for TTL testing. */
export function __setLastBrainAtForTests(chatId: string, ts: number): void {
  lastBrainAtByChat.set(chatId, ts);
}

/** Test helper — inject synthetic enqueuedAt by bypassing enqueueSteer API. */
export function __injectPendingEntryForTests(chatId: string, text: string, enqueuedAt: number): void {
  const queue = pendingByChat.get(chatId) ?? [];
  queue.push({ text, enqueuedAt });
  pendingByChat.set(chatId, queue);
}

/** Test helper — observe lastBrainAt map size for leak tests. */
export function __peekMapSizesForTests(): { pending: number; lastBrain: number } {
  return { pending: pendingByChat.size, lastBrain: lastBrainAtByChat.size };
}
