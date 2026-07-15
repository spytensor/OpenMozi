/**
 * Scheduled Tasks — periodic background job registrations.
 *
 * Extracted from index.ts. Registers all `scheduleTask` entries
 * that run on fixed intervals (reminders, learner, memory maintenance, etc.).
 */

import pino from 'pino';
import { schedule as scheduleTask } from './scheduler/index.js';
import { checkAndFireReminders } from './scheduler/reminders.js';
import { notify } from './channels/proactive-notifier.js';
import { extractLessons } from './core/event-learner.js';
import { consolidateEpisodes, decayUnusedFacts, pruneLowSalienceFacts } from './memory/long-term.js';
import { cleanExpiredRetries } from './security/approval-retry.js';
import { cleanupStaleWorkspaces } from './tasks/workspace.js';
import { checkAndFireCronTasks } from './scheduler/cron-tasks.js';

const logger = pino({ name: 'mozi:scheduled-tasks' });

/**
 * Register all periodic background tasks with the scheduler.
 */
export function registerScheduledTasks(): void {
  scheduleTask({
    id: 'reminder_dispatch',
    name: 'Reminder Dispatch',
    interval_minutes: 1,
    run: async () => {
      await checkAndFireReminders(async (chatId, message, reminder) => {
        await notify(chatId, `Reminder: ${message}`, {
          channelKey: reminder.channel_type ?? undefined,
          requireDelivery: true,
        });
      });
    },
  });

  scheduleTask({
    id: 'cron_dispatch',
    name: 'Cron Task Dispatch',
    interval_minutes: 1,
    run: () => {
      try {
        const fired = checkAndFireCronTasks('default');
        if (fired > 0) {
          logger.info({ fired }, 'Cron tasks dispatched');
        }
      } catch (err) {
        logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Cron dispatch failed');
      }
    },
  });

  scheduleTask({
    id: 'event_learner',
    name: 'Event Log Learner',
    interval_minutes: 5,
    run: () => {
      try {
        const lessons = extractLessons('default', 24);
        if (lessons.length > 0) {
          logger.info({ count: lessons.length }, 'Event learner extracted lessons');
        }
      } catch (err) {
        logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Event learner cycle failed');
      }
    },
  });

  scheduleTask({
    id: 'memory_salience_maintenance',
    name: 'Memory Salience Maintenance',
    interval_minutes: 15,
    run: () => {
      try {
        const decayed = decayUnusedFacts('default', 30);
        const consolidated = consolidateEpisodes('default', 3);
        const pruned = pruneLowSalienceFacts('default', 0.1, 30);
        if (decayed + consolidated + pruned > 0) {
          logger.info({ decayed, consolidated, pruned }, 'Memory salience maintenance completed');
        }
      } catch (err) {
        logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Memory salience maintenance failed');
      }
    },
  });

  scheduleTask({
    id: 'data_retention',
    name: 'Daily Data Retention Cleanup',
    interval_minutes: 24 * 60,
    run: async () => {
      try {
        const { pruneStaleData } = await import('./store/retention.js');
        const result = pruneStaleData();
        logger.info({ result }, 'Daily data retention completed');
      } catch (err) {
        logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Data retention failed');
      }
    },
  });

  scheduleTask({
    id: 'approval_retry_cleanup',
    name: 'Approval Retry Cleanup',
    interval_minutes: 5,
    run: () => {
      try {
        cleanExpiredRetries(30);
      } catch (err) {
        logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Approval retry cleanup failed');
      }
    },
  });

  scheduleTask({
    id: 'task_workspace_cleanup',
    name: 'Task Workspace Cleanup',
    interval_minutes: 60,
    run: () => {
      try {
        const removed = cleanupStaleWorkspaces(72); // 72 hours retention
        if (removed > 0) {
          logger.info({ removed }, 'Stale task workspaces cleaned');
        }
      } catch (err) {
        logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Task workspace cleanup failed');
      }
    },
  });
}
