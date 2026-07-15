import { getDb } from '../store/db.js';

export type BackgroundTaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'retrying';

export interface BackgroundTask {
  id: number;
  tenant_id: string;
  chat_id: string;
  objective: string;
  status: BackgroundTaskStatus;
  result: string | null;
  handler_type: string | null;
  handler_params: string | null;
  running_since: string | null;
  last_error: string | null;
  retry_count: number;
  retry_after: number | null;
  max_retries: number;
  timeout_ms: number;
  created_at: string;
  completed_at: string | null;
}

export interface BackgroundTaskStats {
  pending: number;
  failed: number;
  completed: number;
}

let tableEnsured = false;

export const BACKGROUND_TASK_RETRY_BASE_MS = 10_000;
export const BACKGROUND_TASK_RETRY_MAX_MS = 5 * 60_000;

export interface BackgroundRetrySchedule {
  retry_count: number;
  retry_after: number;
  delay_ms: number;
}

export function calculateRetryDelayMs(retryCount: number): number {
  const safeRetryCount = Math.max(1, Math.floor(retryCount));
  return Math.min(
    BACKGROUND_TASK_RETRY_BASE_MS * Math.pow(2, safeRetryCount - 1),
    BACKGROUND_TASK_RETRY_MAX_MS,
  );
}

function ensureBackgroundTasksTable(): void {
  if (tableEnsured) return;
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS background_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      chat_id TEXT NOT NULL,
      objective TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      result TEXT,
      handler_type TEXT,
      handler_params TEXT,
      running_since DATETIME,
      last_error TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,
      retry_after INTEGER,
      max_retries INTEGER NOT NULL DEFAULT 3,
      timeout_ms INTEGER NOT NULL DEFAULT 300000,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME
    );
    CREATE INDEX IF NOT EXISTS idx_background_tasks_tenant_status
      ON background_tasks(tenant_id, status, created_at DESC);
  `);
  // Migrate existing tables missing new columns
  try {
    db.exec(`ALTER TABLE background_tasks ADD COLUMN handler_type TEXT`);
  } catch { /* column already exists */ }
  try {
    db.exec(`ALTER TABLE background_tasks ADD COLUMN handler_params TEXT`);
  } catch { /* column already exists */ }
  try {
    db.exec(`ALTER TABLE background_tasks ADD COLUMN running_since DATETIME`);
  } catch { /* column already exists */ }
  try {
    db.exec(`ALTER TABLE background_tasks ADD COLUMN last_error TEXT`);
  } catch { /* column already exists */ }
  try {
    db.exec(`ALTER TABLE background_tasks ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0`);
  } catch { /* column already exists */ }
  try {
    db.exec(`ALTER TABLE background_tasks ADD COLUMN retry_after INTEGER`);
  } catch { /* column already exists */ }
  try {
    db.exec(`ALTER TABLE background_tasks ADD COLUMN max_retries INTEGER NOT NULL DEFAULT 3`);
  } catch { /* column already exists */ }
  try {
    db.exec(`ALTER TABLE background_tasks ADD COLUMN timeout_ms INTEGER NOT NULL DEFAULT 300000`);
  } catch { /* column already exists */ }
  tableEnsured = true;
}

export interface AddBackgroundTaskOptions {
  chatId: string;
  objective: string;
  tenantId?: string;
  handlerType?: string;
  handlerParams?: Record<string, unknown>;
  maxRetries?: number;
  timeoutMs?: number;
}

const SELECT_COLS = `id, tenant_id, chat_id, objective, status, result, handler_type, handler_params, running_since, last_error, retry_count, retry_after, max_retries, timeout_ms, created_at, completed_at`;

export function addBackgroundTask(
  chatIdOrOpts: string | AddBackgroundTaskOptions,
  objective?: string,
  tenantId = 'default',
): BackgroundTask {
  const opts: AddBackgroundTaskOptions = typeof chatIdOrOpts === 'string'
    ? { chatId: chatIdOrOpts, objective: objective!, tenantId }
    : chatIdOrOpts;

  if (!opts.chatId || typeof opts.chatId !== 'string') {
    throw new Error('"chatId" is required');
  }
  if (!opts.objective || typeof opts.objective !== 'string') {
    throw new Error('"objective" is required');
  }

  ensureBackgroundTasksTable();
  const db = getDb();
  const insert = db.prepare(`
    INSERT INTO background_tasks (tenant_id, chat_id, objective, status, handler_type, handler_params, max_retries, timeout_ms)
    VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)
  `);
  const result = insert.run(
    opts.tenantId ?? 'default',
    opts.chatId,
    opts.objective,
    opts.handlerType ?? null,
    opts.handlerParams ? JSON.stringify(opts.handlerParams) : null,
    opts.maxRetries ?? 3,
    opts.timeoutMs ?? 300000,
  );
  const id = Number(result.lastInsertRowid);

  const row = db.prepare(`SELECT ${SELECT_COLS} FROM background_tasks WHERE id = ?`).get(id) as BackgroundTask | undefined;
  if (!row) throw new Error('Failed to read inserted background task');
  return row;
}

export function getPendingTasks(tenantId = 'default'): BackgroundTask[] {
  ensureBackgroundTasksTable();
  const db = getDb();
  return db.prepare(`
    SELECT ${SELECT_COLS} FROM background_tasks
    WHERE tenant_id = ?
      AND (
        status = 'pending'
        OR (status = 'retrying' AND (retry_after IS NULL OR retry_after <= ?))
      )
    ORDER BY created_at ASC, id ASC
  `).all(tenantId, Date.now()) as BackgroundTask[];
}

export function getRunningTasks(tenantId = 'default'): BackgroundTask[] {
  ensureBackgroundTasksTable();
  const db = getDb();
  return db.prepare(`
    SELECT ${SELECT_COLS} FROM background_tasks
    WHERE tenant_id = ? AND status = 'running'
    ORDER BY running_since ASC
  `).all(tenantId) as BackgroundTask[];
}

export function markRunning(id: number): void {
  ensureBackgroundTasksTable();
  getDb().prepare(`
    UPDATE background_tasks
    SET status = 'running', running_since = datetime('now'), last_error = NULL, retry_after = NULL
    WHERE id = ?
  `).run(id);
}

export function claimTaskForRun(id: number, tenantId = 'default'): boolean {
  ensureBackgroundTasksTable();
  const result = getDb().prepare(`
    UPDATE background_tasks
    SET status = 'running', running_since = datetime('now'), last_error = NULL, retry_after = NULL
    WHERE id = ?
      AND tenant_id = ?
      AND (
        status = 'pending'
        OR (status = 'retrying' AND (retry_after IS NULL OR retry_after <= ?))
      )
  `).run(id, tenantId, Date.now());
  return result.changes === 1;
}

export function markRetrying(id: number, error: string): BackgroundRetrySchedule {
  ensureBackgroundTasksTable();
  const db = getDb();
  const row = db.prepare(`SELECT retry_count FROM background_tasks WHERE id = ?`).get(id) as { retry_count: number } | undefined;
  const retryCount = Number(row?.retry_count ?? 0) + 1;
  const delayMs = calculateRetryDelayMs(retryCount);
  const retryAfter = Date.now() + delayMs;
  db.prepare(`
    UPDATE background_tasks
    SET status = 'retrying',
        last_error = ?,
        retry_count = ?,
        retry_after = ?,
        running_since = NULL
    WHERE id = ?
  `).run(error, retryCount, retryAfter, id);
  return { retry_count: retryCount, retry_after: retryAfter, delay_ms: delayMs };
}

export function getTask(id: number): BackgroundTask | undefined {
  ensureBackgroundTasksTable();
  return getDb().prepare(`SELECT ${SELECT_COLS} FROM background_tasks WHERE id = ?`).get(id) as BackgroundTask | undefined;
}

export function getBackgroundTaskStats(tenantId = 'default'): BackgroundTaskStats {
  ensureBackgroundTasksTable();
  const db = getDb();
  const row = db.prepare(`
    SELECT
      SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed
    FROM background_tasks
    WHERE tenant_id = ?
  `).get(tenantId) as {
    pending: number | null;
    failed: number | null;
    completed: number | null;
  };

  return {
    pending: Number(row?.pending ?? 0),
    failed: Number(row?.failed ?? 0),
    completed: Number(row?.completed ?? 0),
  };
}

export function completeTask(id: number, result: string): void {
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error('"id" must be a positive integer');
  }

  ensureBackgroundTasksTable();
  const db = getDb();
  db.prepare(`
    UPDATE background_tasks
    SET status = 'completed',
        result = ?,
        running_since = NULL,
        last_error = NULL,
        retry_after = NULL,
        completed_at = datetime('now')
    WHERE id = ?
  `).run(result, id);
}

export function failTask(id: number, reason: string): void {
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error('"id" must be a positive integer');
  }
  if (!reason || typeof reason !== 'string') {
    throw new Error('"reason" is required');
  }

  ensureBackgroundTasksTable();
  const db = getDb();
  db.prepare(`
    UPDATE background_tasks
    SET status = 'failed',
        result = ?,
        last_error = ?,
        running_since = NULL,
        retry_after = NULL,
        completed_at = datetime('now')
    WHERE id = ?
  `).run(reason, reason, id);
}

export function resetBackgroundTaskTableFlag(): void {
  tableEnsured = false;
}
