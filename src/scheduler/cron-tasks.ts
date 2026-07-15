/**
 * Cron Tasks — Persistent recurring/one-shot scheduled tasks.
 *
 * Design inspired by OpenClaw's cron service, adapted for Mozi:
 * - Three schedule modes: 'at' (one-shot), 'every' (interval), 'cron' (expression)
 * - Uses 'croner' for reliable next-run computation (timezone-aware, no hand-rolled matching)
 * - Run logging for observability
 * - deleteAfterRun for one-shot tasks
 * - Fires by computing nextRunAt and comparing against current time
 */

import pino from 'pino';
import { Cron } from 'croner';
import { getDb } from '../store/db.js';
import { addBackgroundTask } from '../core/background-tasks.js';

const logger = pino({ name: 'mozi:cron-tasks' });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CronScheduleKind = 'at' | 'every' | 'cron';

export interface CronTask {
  id: string;
  tenant_id: string;
  chat_id: string;
  schedule_kind: CronScheduleKind;
  schedule_value: string;        // ISO date for 'at', ms for 'every', cron expr for 'cron'
  timezone: string | null;
  handler_type: string;
  handler_params: string | null;
  description: string;
  enabled: number;
  delete_after_run: number;
  last_run_at: string | null;
  next_run_at: string | null;
  run_count: number;
  last_status: string | null;    // 'ok' | 'error' | null
  last_error: string | null;
  created_at: string;
}

let tableEnsured = false;

function ensureCronTasksTable(): void {
  if (tableEnsured) return;
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS cron_tasks (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      chat_id TEXT NOT NULL,
      schedule_kind TEXT NOT NULL DEFAULT 'cron',
      schedule_value TEXT NOT NULL,
      timezone TEXT,
      handler_type TEXT NOT NULL,
      handler_params TEXT,
      description TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1,
      delete_after_run INTEGER NOT NULL DEFAULT 0,
      last_run_at DATETIME,
      next_run_at DATETIME,
      run_count INTEGER NOT NULL DEFAULT 0,
      last_status TEXT,
      last_error TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_cron_tasks_tenant
      ON cron_tasks(tenant_id, enabled);
  `);
  // Migration for older tables
  try { db.exec(`ALTER TABLE cron_tasks ADD COLUMN schedule_kind TEXT NOT NULL DEFAULT 'cron'`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE cron_tasks ADD COLUMN schedule_value TEXT NOT NULL DEFAULT ''`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE cron_tasks ADD COLUMN timezone TEXT`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE cron_tasks ADD COLUMN delete_after_run INTEGER NOT NULL DEFAULT 0`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE cron_tasks ADD COLUMN run_count INTEGER NOT NULL DEFAULT 0`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE cron_tasks ADD COLUMN last_status TEXT`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE cron_tasks ADD COLUMN last_error TEXT`); } catch { /* exists */ }
  // Migrate old cron_expression column → schedule_value
  try {
    db.exec(`UPDATE cron_tasks SET schedule_value = cron_expression, schedule_kind = 'cron' WHERE schedule_value = '' AND cron_expression IS NOT NULL`);
  } catch { /* old column may not exist */ }
  tableEnsured = true;
}

// ---------------------------------------------------------------------------
// Schedule computation (inspired by OpenClaw's schedule.ts)
// ---------------------------------------------------------------------------

/**
 * Compute the next run time in epoch ms for a schedule.
 */
export function computeNextRunAtMs(
  kind: CronScheduleKind,
  value: string,
  nowMs: number,
  timezone?: string | null,
): number | undefined {
  if (kind === 'at') {
    const atMs = new Date(value).getTime();
    if (!Number.isFinite(atMs)) return undefined;
    return atMs > nowMs ? atMs : undefined;
  }

  if (kind === 'every') {
    const everyMs = parseInt(value, 10);
    if (!Number.isFinite(everyMs) || everyMs < 1000) return undefined;
    // Next interval from now
    return nowMs + everyMs;
  }

  // kind === 'cron'
  try {
    const tz = timezone?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone;
    const job = new Cron(value, { timezone: tz });
    const next = job.nextRun(new Date(nowMs));
    if (!next) return undefined;
    const nextMs = next.getTime();
    if (!Number.isFinite(nextMs) || nextMs <= nowMs) {
      // Retry from next second (croner timezone edge case workaround)
      const retry = job.nextRun(new Date(Math.floor(nowMs / 1000) * 1000 + 1000));
      if (retry) {
        const retryMs = retry.getTime();
        if (Number.isFinite(retryMs) && retryMs > nowMs) return retryMs;
      }
      return undefined;
    }
    return nextMs;
  } catch (err) {
    logger.warn({ kind, value, err: err instanceof Error ? err.message : String(err) }, 'Invalid cron expression');
    return undefined;
  }
}

/**
 * Validate a schedule.
 */
export function isValidSchedule(kind: CronScheduleKind, value: string): boolean {
  if (kind === 'at') {
    return Number.isFinite(new Date(value).getTime());
  }
  if (kind === 'every') {
    const ms = parseInt(value, 10);
    return Number.isFinite(ms) && ms >= 1000;
  }
  try {
    new Cron(value);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export interface AddCronTaskOptions {
  chatId: string;
  scheduleKind: CronScheduleKind;
  scheduleValue: string;
  timezone?: string;
  handlerType: string;
  handlerParams?: Record<string, unknown>;
  description: string;
  deleteAfterRun?: boolean;
  tenantId?: string;
}

export function addCronTask(opts: AddCronTaskOptions): CronTask {
  if (!isValidSchedule(opts.scheduleKind, opts.scheduleValue)) {
    throw new Error(`Invalid schedule: ${opts.scheduleKind} "${opts.scheduleValue}"`);
  }

  ensureCronTasksTable();
  const db = getDb();
  const id = `cron_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const nowMs = Date.now();
  const nextRunAtMs = computeNextRunAtMs(opts.scheduleKind, opts.scheduleValue, nowMs, opts.timezone);
  const nextRunAt = nextRunAtMs ? new Date(nextRunAtMs).toISOString() : null;

  db.prepare(`
    INSERT INTO cron_tasks (id, tenant_id, chat_id, schedule_kind, schedule_value, timezone,
      handler_type, handler_params, description, delete_after_run, next_run_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    opts.tenantId ?? 'default',
    opts.chatId,
    opts.scheduleKind,
    opts.scheduleValue,
    opts.timezone ?? null,
    opts.handlerType,
    opts.handlerParams ? JSON.stringify(opts.handlerParams) : null,
    opts.description,
    opts.deleteAfterRun ? 1 : 0,
    nextRunAt,
  );

  logger.info({ cronId: id, kind: opts.scheduleKind, value: opts.scheduleValue, nextRunAt }, 'Cron task created');
  return db.prepare(`SELECT * FROM cron_tasks WHERE id = ?`).get(id) as CronTask;
}

export function listCronTasks(tenantId = 'default'): CronTask[] {
  ensureCronTasksTable();
  return getDb().prepare(`SELECT * FROM cron_tasks WHERE tenant_id = ? ORDER BY created_at DESC`).all(tenantId) as CronTask[];
}

export function cancelCronTask(id: string, tenantId = 'default'): boolean {
  ensureCronTasksTable();
  const result = getDb().prepare(`DELETE FROM cron_tasks WHERE id = ? AND tenant_id = ?`).run(id, tenantId);
  return result.changes > 0;
}

// ---------------------------------------------------------------------------
// Tick — check and fire due tasks
// ---------------------------------------------------------------------------

/**
 * Check all enabled cron tasks and fire those that are due.
 * Called every minute by the scheduler.
 */
export function checkAndFireCronTasks(tenantId = 'default'): number {
  ensureCronTasksTable();
  const db = getDb();
  const tasks = db.prepare(`
    SELECT * FROM cron_tasks WHERE tenant_id = ? AND enabled = 1
  `).all(tenantId) as CronTask[];

  let fired = 0;
  const nowMs = Date.now();

  for (const task of tasks) {
    try {
      // Check if task is due based on next_run_at
      if (task.next_run_at) {
        const nextMs = new Date(task.next_run_at).getTime();
        if (!Number.isFinite(nextMs) || nextMs > nowMs) continue;
      } else {
        // No next_run_at computed — compute now
        const nextMs = computeNextRunAtMs(task.schedule_kind as CronScheduleKind, task.schedule_value, nowMs, task.timezone);
        if (!nextMs || nextMs > nowMs) {
          // Update next_run_at for future checks
          if (nextMs) {
            db.prepare(`UPDATE cron_tasks SET next_run_at = ? WHERE id = ?`).run(new Date(nextMs).toISOString(), task.id);
          }
          continue;
        }
      }

      // Dedup: skip if last_run_at is within 30 seconds (prevent double-fire)
      if (task.last_run_at) {
        const lastMs = new Date(task.last_run_at + (task.last_run_at.endsWith('Z') ? '' : 'Z')).getTime();
        if (nowMs - lastMs < 30_000) continue;
      }

      // Fire: create background task
      const params = task.handler_params ? JSON.parse(task.handler_params) : {};
      addBackgroundTask({
        chatId: task.chat_id,
        objective: task.description || `Scheduled: ${task.schedule_kind} ${task.schedule_value}`,
        tenantId: task.tenant_id,
        handlerType: task.handler_type,
        handlerParams: params,
      });

      // Compute next run
      const nextRunAtMs = computeNextRunAtMs(task.schedule_kind as CronScheduleKind, task.schedule_value, nowMs, task.timezone);
      const nextRunAt = nextRunAtMs ? new Date(nextRunAtMs).toISOString() : null;

      // Update state
      db.prepare(`
        UPDATE cron_tasks SET last_run_at = datetime('now'), next_run_at = ?, run_count = run_count + 1, last_status = 'ok'
        WHERE id = ?
      `).run(nextRunAt, task.id);

      fired++;
      logger.info({ cronId: task.id, description: task.description, nextRunAt }, 'Cron task fired');

      // Delete one-shot tasks
      if (task.delete_after_run) {
        db.prepare(`DELETE FROM cron_tasks WHERE id = ?`).run(task.id);
        logger.info({ cronId: task.id }, 'One-shot cron task deleted after run');
      }

    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      db.prepare(`UPDATE cron_tasks SET last_status = 'error', last_error = ? WHERE id = ?`).run(errMsg, task.id);
      logger.warn({ cronId: task.id, err: errMsg }, 'Cron task check failed');
    }
  }

  return fired;
}

// Backward compat aliases
export function isValidCronExpression(expr: string): boolean {
  return isValidSchedule('cron', expr);
}

export function resetCronTaskTableFlag(): void {
  tableEnsured = false;
}
