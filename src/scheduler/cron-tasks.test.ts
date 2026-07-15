import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb } from '../store/db.js';
import { setupTestDb, teardownTestDb } from '../test-helpers.js';
import { BackgroundJobRunner } from '../background-executor/runner.js';
import { clearHandlers, registerHandler } from '../background-executor/registry.js';
import {
  getPendingTasks,
  getTask,
  resetBackgroundTaskTableFlag,
} from '../core/background-tasks.js';
import {
  addCronTask,
  checkAndFireCronTasks,
  resetCronTaskTableFlag,
} from './cron-tasks.js';

vi.mock('../channels/proactive-notifier.js', () => ({
  notify: vi.fn().mockResolvedValue(undefined),
}));

let tmpDir: string;
let runner: BackgroundJobRunner;

describe('scheduler/cron-tasks background execution', () => {
  beforeEach(() => {
    const result = setupTestDb();
    tmpDir = result.tmpDir;
    resetBackgroundTaskTableFlag();
    resetCronTaskTableFlag();
    clearHandlers();
    runner = new BackgroundJobRunner({ pollIntervalMs: 50, tenantId: 'default' });
  });

  afterEach(async () => {
    runner.stop();
    await runner.waitForIdle();
    clearHandlers();
    teardownTestDb(tmpDir);
  });

  it('fires a due cron task, enqueues it, and the background runner executes it', async () => {
    registerHandler('cron_test', async (task) => {
      const params = task.handler_params ? JSON.parse(task.handler_params) as { message?: string } : {};
      return `cron:${params.message ?? 'missing'}`;
    });

    const cron = addCronTask({
      chatId: 'chat-cron',
      scheduleKind: 'at',
      scheduleValue: new Date(Date.now() + 60_000).toISOString(),
      handlerType: 'cron_test',
      handlerParams: { message: 'ok' },
      description: 'Cron execution test',
    });

    getDb().prepare(`
      UPDATE cron_tasks
      SET next_run_at = datetime('now', '-1 second')
      WHERE id = ?
    `).run(cron.id);

    const fired = checkAndFireCronTasks('default');
    expect(fired).toBe(1);

    const pending = getPendingTasks('default');
    expect(pending).toHaveLength(1);
    expect(pending[0].handler_type).toBe('cron_test');

    await runner.tick();
    await runner.waitForIdle();

    const executed = getTask(pending[0].id);
    expect(executed?.status).toBe('completed');
    expect(executed?.result).toBe('cron:ok');
  });
});
