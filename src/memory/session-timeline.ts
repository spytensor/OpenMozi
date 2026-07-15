import { getDb } from '../store/db.js';
import { getRequest } from '../security/gates.js';
import { recordTurnSeqHighWater } from './turn-envelopes.js';

export type SessionTimelineItemType =
  | 'message'
  | 'tool_event'
  | 'task_update'
  | 'approval_request'
  | 'artifact'
  | 'memory_update';

export interface SessionTimelineItem {
  type: SessionTimelineItemType;
  timestamp: number;
  data: unknown;
}

export interface SessionTimelinePageItem extends SessionTimelineItem {
  eventId: number;
  /** Owning turn id (Issue #627); undefined for legacy / turn-less rows. */
  turnId?: string;
  /** Durable per-turn monotonic sequence; undefined for legacy / turn-less rows. */
  seq?: number;
}

/** Result of a timeline write: the authoritative turn identity + sequence assigned. */
export interface SaveTimelineResult {
  turnId?: string;
  seq: number | null;
}

export interface SessionTimelinePage {
  timeline: SessionTimelinePageItem[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface SaveTimelineItemInput {
  tenantId?: string;
  sessionId: string;
  chatId: string;
  turnId?: string;
  type: SessionTimelineItemType;
  eventKey: string;
  timestamp: number;
  data: unknown;
  conversationId?: number;
  preserveTimestampOnUpdate?: boolean;
  mergeDataOnUpdate?: boolean;
}

interface TimelineRow {
  id: number;
  conversation_id: number | null;
  item_type: SessionTimelineItemType;
  timestamp_ms: number;
  payload: string;
  turn_id: string | null;
  turn_seq: number | null;
}

interface ConversationMessageRow {
  id: number;
  role: string;
  content: string;
}

function isRuntimeDiagnosticMessage(data: unknown): boolean {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  const message = data as Record<string, unknown>;
  return message.role === 'assistant' && typeof message.content === 'string' &&
    /^(Runtime Status|Agent Runtime — Commands)(?:\n|$)/.test(message.content.trim());
}

function messageKey(role: unknown, content: unknown): string | null {
  return typeof role === 'string' && typeof content === 'string' ? `${role}\u0000${content}` : null;
}

function parsePayload(payload: string): unknown {
  try {
    return JSON.parse(payload);
  } catch {
    return {};
  }
}

function normalizeTimestamp(timestamp: number | undefined): number {
  return Number.isFinite(timestamp) && timestamp && timestamp > 0 ? Math.floor(timestamp) : Date.now();
}

function compactUndefined(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(compactUndefined);
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .map(([key, entry]) => [key, compactUndefined(entry)]),
  );
}

function dataString(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function requestContextString(context: Record<string, unknown> | null, key: string): string | undefined {
  const value = context?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function reconcileApprovalPayload(data: unknown, tenantId: string): unknown {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
  const payload = data as Record<string, unknown>;
  const requestId = dataString(payload, 'id');
  if (!requestId) return data;

  const request = (() => {
    try {
      return getRequest(requestId, tenantId);
    } catch {
      return null;
    }
  })();
  if (!request) return data;

  const requiredLevel = requestContextString(request.context, 'required_level');
  return compactUndefined({
    ...payload,
    id: request.id,
    description: request.description,
    action: request.action,
    status: request.status,
    required_level: requiredLevel,
    current_level: requestContextString(request.context, 'current_level'),
    denied_action: requestContextString(request.context, 'denied_action'),
    tool: requestContextString(request.context, 'tool'),
    tool_intent: requestContextString(request.context, 'tool_intent'),
    originating_prompt: requestContextString(request.context, 'originating_prompt'),
    permission_level: request.status === 'approved' ? requiredLevel : undefined,
  });
}

function buildPayload(input: SaveTimelineItemInput, tenantId: string): unknown {
  const next = compactUndefined(input.data ?? {});
  if (!input.mergeDataOnUpdate) return next;

  const db = getDb();
  const existing = db.prepare(`
    SELECT payload
    FROM session_timeline_events
    WHERE tenant_id = ? AND session_id = ? AND event_key = ?
  `).get(tenantId, input.sessionId, input.eventKey) as { payload: string } | undefined;
  if (!existing) return next;

  const previous = parsePayload(existing.payload);
  if (
    previous &&
    typeof previous === 'object' &&
    !Array.isArray(previous) &&
    next &&
    typeof next === 'object' &&
    !Array.isArray(next)
  ) {
    return { ...(previous as Record<string, unknown>), ...(next as Record<string, unknown>) };
  }
  return next;
}

/**
 * Compute the next per-turn monotonic sequence for a fresh row. Returns null
 * when the write has no turn identity (legacy / turn-less path). This is the
 * server-owned choke point: every persisted timeline row that belongs to a turn
 * receives a durable, gap-tolerant, monotonically increasing sequence here and
 * nowhere else.
 */
function nextTurnSeq(
  db: ReturnType<typeof getDb>,
  tenantId: string,
  sessionId: string,
  turnId: string,
): number {
  const row = db.prepare(`
    SELECT COALESCE(MAX(turn_seq), 0) AS maxSeq
    FROM session_timeline_events
    WHERE tenant_id = ? AND session_id = ? AND turn_id = ?
  `).get(tenantId, sessionId, turnId) as { maxSeq: number };
  return row.maxSeq + 1;
}

/**
 * Persist (or update) a rendered timeline row and return the authoritative turn
 * identity + per-turn sequence assigned to it. On update the original sequence
 * is preserved so an event keeps its first-assigned position; only the payload
 * and mutable envelope fields change. Historical rows are never rewritten.
 */
export function saveTimelineItem(input: SaveTimelineItemInput): SaveTimelineResult {
  const db = getDb();
  const tenantId = input.tenantId ?? 'default';
  const timestamp = normalizeTimestamp(input.timestamp);
  const payload = buildPayload(input, tenantId);
  const turnId = input.turnId ?? null;
  // Assign a sequence only for turn-scoped rows. On conflict the column is left
  // out of the UPDATE clause below, so an existing row keeps its first sequence.
  const assignedSeq = turnId ? nextTurnSeq(db, tenantId, input.sessionId, turnId) : null;
  db.prepare(`
    INSERT INTO session_timeline_events (
      tenant_id, session_id, chat_id, turn_id, turn_seq, conversation_id, item_type, event_key, timestamp_ms, payload
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(tenant_id, session_id, event_key) DO UPDATE SET
      chat_id = excluded.chat_id,
      -- Preserve turn identity on merge-updates that omit it (e.g. artifact
      -- patches), so a row never loses its owning turn after first assignment.
      turn_id = COALESCE(excluded.turn_id, session_timeline_events.turn_id),
      conversation_id = COALESCE(excluded.conversation_id, session_timeline_events.conversation_id),
      item_type = excluded.item_type,
      timestamp_ms = CASE WHEN ? THEN session_timeline_events.timestamp_ms ELSE excluded.timestamp_ms END,
      payload = excluded.payload,
      updated_at = datetime('now')
  `).run(
    tenantId,
    input.sessionId,
    input.chatId,
    turnId,
    assignedSeq,
    input.conversationId ?? null,
    input.type,
    input.eventKey,
    timestamp,
    JSON.stringify(payload),
    input.preserveTimestampOnUpdate ? 1 : 0,
  );
  // Read back the stored values: an update preserved a prior sequence, so the
  // authoritative seq is whatever the row now holds, not the freshly computed one.
  const stored = db.prepare(`
    SELECT turn_id, turn_seq
    FROM session_timeline_events
    WHERE tenant_id = ? AND session_id = ? AND event_key = ?
  `).get(tenantId, input.sessionId, input.eventKey) as { turn_id: string | null; turn_seq: number | null } | undefined;
  const seq = stored?.turn_seq ?? null;
  const effectiveTurnId = stored?.turn_id ?? undefined;
  if (effectiveTurnId && seq != null) {
    recordTurnSeqHighWater({ tenantId, sessionId: input.sessionId, turnId: effectiveTurnId, seq });
  }
  return { turnId: effectiveTurnId, seq };
}

export function deleteTimelineItem(
  sessionId: string,
  eventKey: string,
  tenantId = 'default',
): void {
  const db = getDb();
  db.prepare(`
    DELETE FROM session_timeline_events
    WHERE tenant_id = ? AND session_id = ? AND event_key = ?
  `).run(tenantId, sessionId, eventKey);
}

/**
 * Clone the latest user prompt row into a new turn identity (Issue #626).
 *
 * A Web UI regenerate re-runs the same prompt as a fresh turn: the gateway mints a
 * new `turnId` for the retry. The prior turn remains immutable and visible;
 * the cloned prompt becomes seq 1 of the new turn so its answer is coherent and
 * never reuses the prior turn's sequence.
 *
 * @returns true when a user row was cloned.
 */
export function cloneLatestUserMessageToTurn(input: {
  tenantId?: string;
  sessionId: string;
  turnId: string;
  content: string;
}): boolean {
  const db = getDb();
  const tenantId = input.tenantId ?? 'default';
  const row = db.prepare(`
    SELECT chat_id, conversation_id, payload FROM session_timeline_events
    WHERE tenant_id = ? AND session_id = ? AND item_type = 'message'
      AND json_extract(payload, '$.role') = 'user'
      AND json_extract(payload, '$.content') = ?
    ORDER BY timestamp_ms DESC, id DESC
    LIMIT 1
  `).get(tenantId, input.sessionId, input.content) as { chat_id: string; conversation_id: number | null; payload: string } | undefined;
  if (!row) return false;
  const timestamp = Date.now();
  const prior = JSON.parse(row.payload) as Record<string, unknown>;
  const { turnId: _oldTurnId, seq: _oldSeq, ...data } = prior;
  saveTimelineItem({
    tenantId,
    sessionId: input.sessionId,
    chatId: row.chat_id,
    turnId: input.turnId,
    ...(row.conversation_id ? { conversationId: row.conversation_id } : {}),
    type: 'message',
    eventKey: `turn:${input.turnId}:message:user`,
    timestamp,
    data: { ...data, id: `msg_${input.turnId}_user`, timestamp },
  });
  return true;
}

/**
 * Remove the previous answer/work for the latest user prompt before a Web UI
 * regenerate. The user row itself remains the stable turn boundary.
 */
export function deleteTimelineAfterLatestUserMessage(
  sessionId: string,
  tenantId = 'default',
): number {
  const db = getDb();
  const boundary = db.prepare(`
    SELECT id, timestamp_ms
    FROM session_timeline_events
    WHERE tenant_id = ? AND session_id = ? AND item_type = 'message'
      AND json_extract(payload, '$.role') = 'user'
    ORDER BY timestamp_ms DESC, id DESC
    LIMIT 1
  `).get(tenantId, sessionId) as { id: number; timestamp_ms: number } | undefined;
  if (!boundary) return 0;

  const result = db.prepare(`
    DELETE FROM session_timeline_events
    WHERE tenant_id = ? AND session_id = ?
      AND (timestamp_ms > ? OR (timestamp_ms = ? AND id > ?))
  `).run(tenantId, sessionId, boundary.timestamp_ms, boundary.timestamp_ms, boundary.id);
  return result.changes;
}

export function getSessionTimeline(
  sessionId: string,
  limit = 500,
  tenantId = 'default',
): SessionTimelineItem[] {
  // Legacy "items only" shape: strip the page-only fields (eventId, and the
  // #627 turnId/seq) so existing internal callers see the stable {type,
  // timestamp, data} contract. Turn identity + sequence are exposed on the
  // paginated restore path (getSessionTimelinePage), which the REST/UI uses.
  return getSessionTimelinePage(sessionId, { limit, tenantId })
    .timeline.map(({ eventId: _eventId, turnId: _turnId, seq: _seq, ...item }) => item);
}

function encodeCursor(timestamp: number, id: number): string {
  return Buffer.from(JSON.stringify({ t: timestamp, id }), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | undefined): { timestamp: number; id: number } | null {
  if (!cursor) return null;
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { t?: unknown; id?: unknown };
    return Number.isSafeInteger(value.t) && Number.isSafeInteger(value.id) && Number(value.t) >= 0 && Number(value.id) > 0
      ? { timestamp: Number(value.t), id: Number(value.id) }
      : null;
  } catch {
    return null;
  }
}

function backfillConversationIds(sessionId: string, tenantId: string): void {
  const db = getDb();
  const rows = db.prepare(`
    SELECT id, conversation_id, payload
    FROM session_timeline_events
    WHERE tenant_id = ? AND session_id = ? AND item_type = 'message'
    ORDER BY timestamp_ms ASC, id ASC
  `).all(tenantId, sessionId) as Array<{ id: number; conversation_id: number | null; payload: string }>;
  if (!rows.some((row) => row.conversation_id === null)) return;
  const conversations = db.prepare(`
    SELECT id, role, content FROM conversations
    WHERE tenant_id = ? AND session_id = ? ORDER BY id ASC
  `).all(tenantId, sessionId) as ConversationMessageRow[];
  const queues = new Map<string, number[]>();
  for (const message of conversations) {
    const key = messageKey(message.role, message.content);
    if (key) queues.set(key, [...(queues.get(key) ?? []), message.id]);
  }
  const update = db.prepare('UPDATE session_timeline_events SET conversation_id = ? WHERE id = ? AND conversation_id IS NULL');
  getDb().transaction(() => {
    for (const row of rows) {
      const payload = parsePayload(row.payload) as Record<string, unknown>;
      const key = messageKey(payload?.role, payload?.content);
      const queue = key ? queues.get(key) : undefined;
      if (!queue?.length) continue;
      if (row.conversation_id !== null) {
        const linkedIndex = queue.indexOf(row.conversation_id);
        if (linkedIndex >= 0) queue.splice(linkedIndex, 1);
        continue;
      }
      const conversationId = queue.shift() as number;
      update.run(conversationId, row.id);
    }
  })();
}

export function getSessionTimelinePage(
  sessionId: string,
  options: { limit?: number; tenantId?: string; before?: string } = {},
): SessionTimelinePage {
  const db = getDb();
  const tenantId = options.tenantId ?? 'default';
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
  const before = decodeCursor(options.before);
  if (options.before && !before) throw new Error('Invalid timeline cursor');
  backfillConversationIds(sessionId, tenantId);
  const rows = db.prepare(`
    SELECT id, conversation_id, item_type, timestamp_ms, payload, turn_id, turn_seq
    FROM session_timeline_events
    WHERE tenant_id = ? AND session_id = ?
      AND (? IS NULL OR timestamp_ms < ? OR (timestamp_ms = ? AND id < ?))
    ORDER BY timestamp_ms DESC, id DESC
    LIMIT ?
  `).all(tenantId, sessionId, before?.timestamp ?? null, before?.timestamp ?? null, before?.timestamp ?? null, before?.id ?? null, limit + 1) as TimelineRow[];
  const hasMore = rows.length > limit;
  const selected = rows.slice(0, limit);
  const oldest = selected.at(-1);
  const timeline = [...selected].reverse().flatMap((row) => {
    const parsed = parsePayload(row.payload);
    if (row.item_type === 'message' && isRuntimeDiagnosticMessage(parsed)) return [];
    const data = row.item_type === 'approval_request'
      ? reconcileApprovalPayload(parsed, tenantId)
      : parsed;
    if (row.item_type === 'message' && data && typeof data === 'object' && !Array.isArray(data)) {
      const message = data as Record<string, unknown>;
      if (row.conversation_id !== null) message.id = `conversation:${row.conversation_id}`;
    }
    return [{
      eventId: row.id,
      type: row.item_type,
      timestamp: row.timestamp_ms,
      ...(row.turn_id ? { turnId: row.turn_id } : {}),
      ...(row.turn_seq != null ? { seq: row.turn_seq } : {}),
      data,
    }];
  });
  return {
    timeline,
    hasMore,
    nextCursor: hasMore && oldest ? encodeCursor(oldest.timestamp_ms, oldest.id) : null,
  };
}

export function linkLatestTimelineMessage(input: {
  tenantId?: string; sessionId: string; role: string; content?: string; conversationId: number;
}): boolean {
  const db = getDb();
  const row = db.prepare(`
    SELECT id FROM session_timeline_events
    WHERE tenant_id = ? AND session_id = ? AND item_type = 'message'
      AND conversation_id IS NULL AND json_extract(payload, '$.role') = ?
      AND (? IS NULL OR json_extract(payload, '$.content') = ?)
    ORDER BY timestamp_ms DESC, id DESC LIMIT 1
  `).get(input.tenantId ?? 'default', input.sessionId, input.role, input.content ?? null, input.content ?? null) as { id: number } | undefined;
  if (!row) return false;
  return db.prepare('UPDATE session_timeline_events SET conversation_id = ? WHERE id = ? AND conversation_id IS NULL')
    .run(input.conversationId, row.id).changes > 0;
}

/** Remove legacy status/help rows that were accidentally persisted as chat output. */
export function removeRuntimeDiagnosticTimelineItems(): number {
  const db = getDb();
  const result = db.prepare(`
    DELETE FROM session_timeline_events
    WHERE item_type = 'message'
      AND json_extract(payload, '$.role') = 'assistant'
      AND (
        json_extract(payload, '$.content') LIKE 'Runtime Status%'
        OR json_extract(payload, '$.content') LIKE 'Agent Runtime — Commands%'
      )
  `).run();
  return result.changes;
}

/**
 * Mirror conversation deletion in the rendered timeline. User turns include
 * all following execution output until the next prompt; assistant deletion is
 * intentionally scoped to that one answer.
 */
export function deleteTimelineForSessionMessage(input: {
  tenantId?: string;
  sessionId: string;
  role: string;
  content: string;
  messageOccurrence: number;
  conversationId?: number;
}): number {
  const db = getDb();
  const tenantId = input.tenantId ?? 'default';
  const directlyLinked = input.conversationId ? db.prepare(`
    SELECT id, timestamp_ms FROM session_timeline_events
    WHERE tenant_id = ? AND session_id = ? AND conversation_id = ?
    LIMIT 1
  `).get(tenantId, input.sessionId, input.conversationId) as { id: number; timestamp_ms: number } | undefined : undefined;
  const candidates = directlyLinked ? [] : db.prepare(`
    SELECT id, timestamp_ms
    FROM session_timeline_events
    WHERE tenant_id = ? AND session_id = ? AND item_type = 'message'
      AND json_extract(payload, '$.role') = ?
      AND json_extract(payload, '$.content') = ?
    ORDER BY timestamp_ms ASC, id ASC
  `).all(tenantId, input.sessionId, input.role, input.content) as Array<{ id: number; timestamp_ms: number }>;
  const target = directlyLinked ?? candidates[Math.max(0, input.messageOccurrence - 1)];
  if (!target) return 0;

  if (input.role !== 'user') {
    return db.prepare('DELETE FROM session_timeline_events WHERE id = ?').run(target.id).changes;
  }

  const nextUser = db.prepare(`
    SELECT id, timestamp_ms
    FROM session_timeline_events
    WHERE tenant_id = ? AND session_id = ? AND item_type = 'message'
      AND json_extract(payload, '$.role') = 'user'
      AND (timestamp_ms > ? OR (timestamp_ms = ? AND id > ?))
    ORDER BY timestamp_ms ASC, id ASC
    LIMIT 1
  `).get(tenantId, input.sessionId, target.timestamp_ms, target.timestamp_ms, target.id) as { id: number; timestamp_ms: number } | undefined;
  const result = nextUser
    ? db.prepare(`
        DELETE FROM session_timeline_events
        WHERE tenant_id = ? AND session_id = ?
          AND (timestamp_ms > ? OR (timestamp_ms = ? AND id >= ?))
          AND (timestamp_ms < ? OR (timestamp_ms = ? AND id < ?))
      `).run(tenantId, input.sessionId, target.timestamp_ms, target.timestamp_ms, target.id, nextUser.timestamp_ms, nextUser.timestamp_ms, nextUser.id)
    : db.prepare(`
        DELETE FROM session_timeline_events
        WHERE tenant_id = ? AND session_id = ?
          AND (timestamp_ms > ? OR (timestamp_ms = ? AND id >= ?))
      `).run(tenantId, input.sessionId, target.timestamp_ms, target.timestamp_ms, target.id);
  return result.changes;
}

export function patchTimelineArtifactData(input: {
  tenantId?: string;
  sessionId: string;
  chatId: string;
  artifactId: string;
  patch: Record<string, unknown>;
  timestamp?: number;
}): void {
  const tenantId = input.tenantId ?? 'default';
  const eventKey = `artifact:${input.artifactId}`;
  const db = getDb();
  const row = db.prepare(`
    SELECT payload, timestamp_ms
    FROM session_timeline_events
    WHERE tenant_id = ? AND session_id = ? AND event_key = ?
  `).get(tenantId, input.sessionId, eventKey) as { payload: string; timestamp_ms: number } | undefined;

  if (!row) return;

  const existing = parsePayload(row.payload);
  const artifact = existing && typeof existing === 'object'
    ? existing as { data?: Record<string, unknown> }
    : {};
  const patch = input.patch;
  // Envelope-level fields live at the top of the artifact row, not inside `data`.
  // `plugin_id` is included so a completion patch that reclassifies a live
  // placeholder (e.g. `live_work_v1`) to the real renderer converges on disk.
  const envelopeKeys = ['plugin_id', 'title', 'status', 'fallback_text', 'updated_at'];
  const dataPatch = {
    ...(patch.data && typeof patch.data === 'object' && !Array.isArray(patch.data) ? patch.data : {}),
    ...Object.fromEntries(
      Object.entries(patch).filter(([key]) => !envelopeKeys.includes(key) && key !== 'data'),
    ),
  };
  const next = {
    ...artifact,
    ...Object.fromEntries(
      Object.entries(patch).filter(([key]) => envelopeKeys.includes(key)),
    ),
    data: {
      ...(artifact.data ?? {}),
      ...dataPatch,
    },
  };

  saveTimelineItem({
    tenantId,
    sessionId: input.sessionId,
    chatId: input.chatId,
    type: 'artifact',
    eventKey,
    timestamp: input.timestamp ?? row.timestamp_ms,
    preserveTimestampOnUpdate: true,
    data: next,
  });
}

/**
 * Terminalize artifact rows left in the `running` state by a previous process.
 *
 * "Opened implies eventually terminal": a crash or restart between an
 * artifact_open and its terminal patch leaves a row spinning forever on reload.
 * At startup we flip any lingering `running` artifact to `failed` and record
 * `failure_reason: 'interrupted'` in its data so the UI renders it as stopped.
 *
 * @param tenantId - Restrict the sweep to one tenant; omit to sweep all.
 * @returns Number of rows terminalized.
 */
export function terminalizeStaleRunningArtifacts(tenantId?: string): number {
  const db = getDb();
  const rows = (tenantId
    ? db.prepare(
        `SELECT id, payload FROM session_timeline_events WHERE item_type = 'artifact' AND tenant_id = ?`,
      ).all(tenantId)
    : db.prepare(
        `SELECT id, payload FROM session_timeline_events WHERE item_type = 'artifact'`,
      ).all()) as Array<{ id: number; payload: string }>;

  const update = db.prepare(
    `UPDATE session_timeline_events SET payload = ?, updated_at = datetime('now') WHERE id = ?`,
  );

  let count = 0;
  const sweep = db.transaction((items: Array<{ id: number; payload: string }>) => {
    for (const row of items) {
      const parsed = parsePayload(row.payload);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      const artifact = parsed as Record<string, unknown>;
      if (artifact.status !== 'running') continue;
      artifact.status = 'failed';
      const data = artifact.data && typeof artifact.data === 'object' && !Array.isArray(artifact.data)
        ? artifact.data as Record<string, unknown>
        : {};
      data.failure_reason = 'interrupted';
      artifact.data = data;
      update.run(JSON.stringify(artifact), row.id);
      count++;
    }
  });
  sweep(rows);
  return count;
}

export interface FileArtifactSourceCandidate {
  sessionId: string;
  timestamp: number;
  path: string;
}

/** Read-only, bounded lookup over the live file_v1 artifact store. */
export function findFileArtifactSourceCandidates(
  tenantId: string,
  basenameFallback: string,
  limit = 20,
): FileArtifactSourceCandidate[] {
  const rows = getDb().prepare(`
    SELECT session_id, timestamp_ms, payload
    FROM session_timeline_events
    WHERE tenant_id = ?
      AND item_type = 'artifact'
      AND json_extract(payload, '$.plugin_id') = 'file_v1'
      AND (
        json_extract(payload, '$.data.path') LIKE ? ESCAPE '\\'
        OR json_extract(payload, '$.data.filename') = ?
      )
    ORDER BY timestamp_ms DESC
    LIMIT ?
  `).all(tenantId, `%${escapeSqlLike(basenameFallback)}`, basenameFallback, limit) as Array<{
    session_id: string;
    timestamp_ms: number;
    payload: string;
  }>;

  return rows.flatMap((row) => {
    const payload = parsePayload(row.payload);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
    const data = (payload as Record<string, unknown>).data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) return [];
    const path = (data as Record<string, unknown>).path;
    return typeof path === 'string'
      ? [{ sessionId: row.session_id, timestamp: row.timestamp_ms, path }]
      : [];
  });
}

function escapeSqlLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}
