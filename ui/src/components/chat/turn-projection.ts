import type { ChatMessage, TimelineItem, TurnEnvelope, TurnStatus } from "@/types";
import { LOCALES, type Locale } from "@/i18n/messages";
import {
  buildChatRenderItems,
  buildExecutionBlockModel,
  inferMessageLocale,
  isExecutionTimelineItem,
  type ChatRenderItem,
  type ExecutionBlockModel,
  type ExecutionState,
} from "./execution";

/**
 * How a durable Turn Envelope status re-colors an execution block that is still
 * shaped "running" on restore (Issue #626). Only terminal statuses appear here;
 * `active`/`awaiting_approval` are still-open and intentionally absent, so a block
 * for such a turn keeps its live "running" shape.
 */
const OPEN_BLOCK_TERMINAL_STATUS: Partial<Record<TurnStatus, ExecutionState>> = {
  completed: "success",
  failed: "error",
  cancelled: "cancelled",
  interrupted: "interrupted",
};

function applyTerminalStatus(block: ExecutionBlockModel, terminal?: TurnStatus): ExecutionBlockModel {
  const terminalState = OPEN_BLOCK_TERMINAL_STATUS[terminal ?? "active"];
  const overridden = terminalState === "cancelled" || terminalState === "interrupted"
    ? terminalState
    : block.status === "running" ? terminalState : undefined;
  return overridden ? { ...block, status: overridden } : block;
}

/**
 * A successful `dag_created` row is only the foreground-to-background handoff.
 * Once its foreground turn is terminal, the durable plan panel owns progress;
 * retaining this block creates a second, stale "processing" surface.
 */
function isQuietCompletedPlanHandoff(block: ExecutionBlockModel, terminal?: TurnStatus): boolean {
  return terminal === "completed"
    && block.status === "success"
    && block.issueCount === 0
    && block.tasks.length > 0
    && block.tasks.every((task) => task.rawStatus === "dag_created");
}

/**
 * Compatibility projection for partially identified historical sessions.
 * Unscoped artifacts still force the frozen grouper, but Turn Envelopes remain
 * authoritative for terminal lifecycle state so a stale pending row cannot
 * keep a completed turn spinning forever.
 */
export function projectLegacyTimeline(
  timeline: TimelineItem[],
  turns: TurnEnvelope[] = [],
): ChatRenderItem[] {
  const turnStatus = new Map(turns.map((turn) => [turn.turnId, turn.status]));
  return buildChatRenderItems(timeline).flatMap((item) => {
    if (item.kind !== "execution" || !item.block.turnId) return [item];
    const terminal = turnStatus.get(item.block.turnId);
    const block = applyTerminalStatus(item.block, terminal);
    return isQuietCompletedPlanHandoff(block, terminal) ? [] : [{ ...item, block }];
  });
}

/**
 * Deterministic Turn Timeline projection (Issue #625).
 * -----------------------------------------------------
 * A pure reducer that renders a session's timeline from the server-authoritative
 * turn identity (`turnId`) and per-turn sequence (`seq`, Issue #627) instead of
 * the frozen heuristic grouper (`buildChatRenderItems`), which keyed off arrival
 * order and client wall-clock timestamps.
 *
 * The contract this module upholds:
 *  - Ordering derives ONLY from `(turnId, seq)`, never from array position or the
 *    client's `Date.now()` timestamps. The same fixed log therefore projects to a
 *    byte-equivalent render tree whether it arrived by live append, full reload,
 *    backward pagination, or reconnect.
 *  - All events of one turn stay contiguous, so ChatView renders one MOZI avatar
 *    per turn.
 *  - True chronology is preserved: a failure that happened before the answer
 *    renders before the answer. Nothing is reordered for cosmetics (the frozen
 *    renderer's `normalizeTurnDisplayOrder` moved artifacts/failures after the
 *    answer — this reducer does not).
 *  - Server terminal state is consumed: an orphaned "running" block belonging to a
 *    turn the server marked terminal is shown per the envelope, not recomputed.
 *
 * Presentation helpers (`buildExecutionBlockModel`, tool/skill summaries, i18n
 * labels) are reused verbatim from `execution.ts`; this module only decides
 * grouping and order.
 */

/** Coerce a server-carried locale string to a known UI `Locale`, or undefined. */
function asLocale(value: unknown): Locale | undefined {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value)
    ? (value as Locale)
    : undefined;
}

function itemTurnId(item: TimelineItem): string | undefined {
  const value = item.turnId ?? (item.data as { turnId?: unknown } | undefined)?.turnId;
  return typeof value === "string" && value.trim() ? value : undefined;
}

function itemSeq(item: TimelineItem): number | undefined {
  const value = item.seq ?? (item.data as { seq?: unknown } | undefined)?.seq;
  return typeof value === "number" ? value : undefined;
}

/**
 * Whether the deterministic projection may render this timeline.
 *
 * Two gates, matching Issue #625's "capability-gate the new path, retain the
 * frozen fallback for legacy sessions":
 *  1. The server advertised `timeline_v1` in its `welcome` frame (the client is
 *     talking to a runtime that assigns turn identity + sequence).
 *  2. The session is fully turn-identified: every content item carries a
 *     `turnId`. System notices (client-local, never persisted) are exempt.
 *     A single unidentified content item means a legacy or partially-migrated
 *     session, which must keep the frozen renderer.
 *
 * A brand-new turn's optimistic user message has a `turnId` backfilled by
 * `useChat` before this runs, so live turns still qualify.
 */
export function canProjectDeterministically(
  timeline: TimelineItem[],
  capabilities?: string[] | null,
): boolean {
  if (!capabilities?.includes("timeline_v1")) return false;
  const content = timeline.filter((item) => item.type !== "message" || (item.data as ChatMessage).role !== "system");
  return !!content.length && content.every(itemTurnId);
}

interface OrderedItem {
  item: TimelineItem;
  index: number;
  turnKey: string;
  sortSeq: number;
}

/**
 * Assign every item a deterministic `(turnKey, sortSeq)`:
 *  - turn-scoped items use their own `turnId` and `seq` (missing `seq`, e.g. a
 *    live user message awaiting its server sequence, sorts first via -Infinity —
 *    the user prompt is always the first row of its turn);
 *  - unscoped items (system notices) inherit the nearest preceding turn and trail
 *    its real work, keeping them near their context without depending on the
 *    client clock.
 */
function turnOrderValue(turnId: string, startedAtByTurn: Map<string, number>): number {
  // Live turns are projected before a restore has supplied their envelopes.
  // Current server turn ids embed the server creation epoch; keep this as a
  // compatibility fallback, never the primary restored-session order.
  return startedAtByTurn.get(turnId) ?? (Number(turnId.split("_")[1]) || Number.MAX_SAFE_INTEGER);
}

function orderItems(timeline: TimelineItem[], turns: TurnEnvelope[]): OrderedItem[] {
  const startedAtByTurn = new Map(turns.map((turn) => [turn.turnId, turn.startedAt]));
  let lastTurnKey = "";
  let unscopedCounter = 0;
  const ordered = timeline.map((item, index) => {
    const turnId = itemTurnId(item);
    if (turnId) {
      lastTurnKey = turnId;
      const seq = itemSeq(item);
      return {
        item,
        index,
        turnKey: turnId,
        sortSeq: typeof seq === "number" ? seq : Number.NEGATIVE_INFINITY,
      };
    }
    return {
      item,
      index,
      turnKey: lastTurnKey,
      sortSeq: Number.MAX_SAFE_INTEGER - 1_000_000 + unscopedCounter++,
    };
  });

  return ordered.sort((a, b) => {
    if (a.turnKey !== b.turnKey) {
      const order = turnOrderValue(a.turnKey, startedAtByTurn) - turnOrderValue(b.turnKey, startedAtByTurn);
      if (order !== 0) return order;
      return a.turnKey < b.turnKey ? -1 : 1;
    }
    if (a.sortSeq !== b.sortSeq) return a.sortSeq - b.sortSeq;
    // Fully-tied keys only occur among live-only unscoped notices; original order
    // is a stable, path-local tiebreak (never present in a persisted fixed log).
    return a.index - b.index;
  });
}

/**
 * Project a timeline into render items grouped and ordered by turn identity.
 * Assumes `canProjectDeterministically` already returned true for this timeline.
 */
export function projectTimelineByTurn(
  timeline: TimelineItem[],
  turns: TurnEnvelope[] = [],
): ChatRenderItem[] {
  const ordered = orderItems(timeline, turns);
  const turnStatus = new Map<string, TurnStatus>();
  for (const turn of turns) turnStatus.set(turn.turnId, turn.status);

  // Locale per turn. On the authoritative path (Issue #628) the server carries
  // the turn's presentation locale on its envelope, so consume that directly and
  // do NOT re-scan message characters. The per-message character scan survives
  // ONLY as a legacy fallback for turns whose envelope predates the carried
  // field (or had no reliable signal), so historical sessions still localize.
  const turnUserLocales = new Map<string, Locale | undefined>();
  for (const turn of turns) {
    const carried = asLocale(turn.locale);
    if (carried) turnUserLocales.set(turn.turnId, carried);
  }
  for (const { item, turnKey } of ordered) {
    if (turnUserLocales.has(turnKey)) continue;
    if (item.type !== "message") continue;
    const message = item.data as ChatMessage;
    if (message.role !== "user") continue;
    turnUserLocales.set(turnKey, inferMessageLocale(message.content) ?? undefined);
  }

  const renderItems: ChatRenderItem[] = [];
  let executionRun: OrderedItem[] = [];
  let executionTurn: string | null = null;
  let blockCounter = 0;

  const flushExecutionRun = () => {
    if (executionRun.length === 0 || executionTurn === null) {
      executionRun = [];
      executionTurn = null;
      return;
    }
    const items = executionRun.map((entry) => entry.item);
    const model = buildExecutionBlockModel(
      items,
      `turn-exec-${executionTurn}-${blockCounter++}`,
      turnUserLocales.get(executionTurn),
    );
    // Consume the server-authoritative terminal status (Issue #626). An execution
    // block still shaped "running" (its last tool/task never got an end event)
    // belongs to a turn the envelope may have already terminalized: completed,
    // failed, user-cancelled, or crash-interrupted. Project that truth instead of
    // spinning forever. `active`/`awaiting_approval` are genuinely still open and
    // left as-is (the approval card is the explicit waiting surface).
    const terminal = turnStatus.get(executionTurn);
    // Cancellation/interruption are authoritative even when an aborted tool
    // emitted an error-shaped end frame first. Otherwise restore would relabel a
    // user stop as a failure. Completed/failed only resolve orphaned live blocks.
    const block = applyTerminalStatus(model, terminal);
    if (isQuietCompletedPlanHandoff(block, terminal)) {
      executionRun = [];
      executionTurn = null;
      return;
    }
    renderItems.push({ kind: "execution", block });
    executionRun = [];
    executionTurn = null;
  };

  for (const entry of ordered) {
    const { item, index, turnKey } = entry;

    if (isExecutionTimelineItem(item)) {
      // Coalesce only items that are consecutive AND in the same turn. A turn
      // boundary or an interleaved message/artifact flushes the run, so true
      // chronology within the turn is preserved (no cross-boundary merging).
      if (executionTurn !== null && executionTurn !== turnKey) {
        flushExecutionRun();
      }
      executionTurn = turnKey;
      executionRun.push(entry);
      continue;
    }

    flushExecutionRun();
    renderItems.push({ kind: "single", item, index });
  }

  flushExecutionRun();
  return renderItems;
}
