import pino from 'pino';
import { getDb } from '../store/db.js';

const logger = pino({ name: 'mozi:scheduler:reminders-db' });

export interface Reminder {
  id: number;
  tenant_id: string;
  chat_id: string;
  channel_type: string | null;
  message: string;
  fire_at: string;
  fired: number;
}

export type ReminderSendFn = (chatId: string, message: string, reminder: Reminder) => void | Promise<void>;

function ensureRemindersTable(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      chat_id TEXT NOT NULL,
      channel_type TEXT,
      message TEXT NOT NULL,
      fire_at DATETIME NOT NULL,
      fired BOOLEAN NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_reminders_due
      ON reminders(fired, fire_at);
  `);
  try {
    db.exec('ALTER TABLE reminders ADD COLUMN channel_type TEXT');
  } catch {
    // Column already exists — ignore.
  }
}

/**
 * Create a reminder that should fire after delayMinutes.
 */
export function addReminder(
  chatId: string,
  message: string,
  delayMinutes: number,
  tenantId = 'default',
  channelType?: string,
): Reminder {
  if (!chatId || typeof chatId !== 'string') {
    throw new Error('"chatId" is required');
  }
  if (!message || typeof message !== 'string') {
    throw new Error('"message" is required');
  }
  if (typeof delayMinutes !== 'number' || !Number.isFinite(delayMinutes) || delayMinutes < 0) {
    throw new Error('"delayMinutes" must be a non-negative number');
  }

  ensureRemindersTable();
  const db = getDb();
  const insert = db.prepare(`
    INSERT INTO reminders (tenant_id, chat_id, channel_type, message, fire_at, fired)
    VALUES (?, ?, ?, ?, datetime('now', '+' || ? || ' minutes'), 0)
  `);
  const normalizedChannelType = typeof channelType === 'string' && channelType.trim().length > 0
    ? channelType.trim()
    : null;
  const result = insert.run(tenantId, chatId, normalizedChannelType, message, delayMinutes);
  const id = Number(result.lastInsertRowid);

  const row = db.prepare(`
    SELECT id, tenant_id, chat_id, channel_type, message, fire_at, fired
    FROM reminders
    WHERE id = ?
  `).get(id) as Reminder | undefined;

  if (!row) {
    throw new Error('Failed to read inserted reminder');
  }

  return row;
}

/**
 * List all reminders for a tenant, ordered by fire_at descending.
 */
export function listReminders(tenantId = 'default'): Reminder[] {
  ensureRemindersTable();
  return getDb().prepare(`
    SELECT id, tenant_id, chat_id, channel_type, message, fire_at, fired
    FROM reminders
    WHERE tenant_id = ?
    ORDER BY fire_at DESC
  `).all(tenantId) as Reminder[];
}

/**
 * Find all due reminders, send each one, and mark as fired on success.
 */
export async function checkAndFireReminders(sendFn: ReminderSendFn): Promise<number> {
  ensureRemindersTable();
  const db = getDb();
  const due = db.prepare(`
    SELECT id, tenant_id, chat_id, channel_type, message, fire_at, fired
    FROM reminders
    WHERE fired = 0
      AND fire_at <= datetime('now')
    ORDER BY fire_at ASC, id ASC
  `).all() as Reminder[];

  if (due.length === 0) return 0;

  const markFired = db.prepare('UPDATE reminders SET fired = 1 WHERE id = ?');
  let firedCount = 0;

  for (const reminder of due) {
    try {
      await Promise.resolve(sendFn(reminder.chat_id, reminder.message, reminder));
      markFired.run(reminder.id);
      firedCount += 1;
    } catch (err) {
      logger.error(
        {
          reminderId: reminder.id,
          chatId: reminder.chat_id,
          err: err instanceof Error ? err.message : String(err),
        },
        'Failed to send reminder',
      );
    }
  }

  return firedCount;
}
