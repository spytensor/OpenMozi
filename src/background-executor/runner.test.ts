import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { BackgroundJobRunner } from './runner.js';
import { registerHandler, clearHandlers } from './registry.js';
import { shellBackgroundHandler } from './handlers/shell-background.js';
import {
  addBackgroundTask,
  BACKGROUND_TASK_RETRY_BASE_MS,
  BACKGROUND_TASK_RETRY_MAX_MS,
  calculateRetryDelayMs,
  getTask,
  resetBackgroundTaskTableFlag,
} from '../core/background-tasks.js';
import { setupTestDb, teardownTestDb } from '../test-helpers.js';

// Mock proactive-notifier to avoid real Telegram calls
vi.mock('../channels/proactive-notifier.js', () => ({
  notify: vi.fn().mockResolvedValue(undefined),
}));

describe('BackgroundJobRunner', () => {
  let runner: BackgroundJobRunner;

  beforeEach(() => {
    setupTestDb();
    resetBackgroundTaskTableFlag();
    clearHandlers();
    runner = new BackgroundJobRunner({ pollIntervalMs: 50, tenantId: 'default' });
  });

  afterEach(async () => {
    runner.stop();
    await runner.waitForIdle();
    teardownTestDb();
  });

  it('picks up pending task and executes handler', async () => {
    registerHandler('test_handler', async (_task, _signal) => {
      return 'done!';
    });

    addBackgroundTask({
      chatId: 'chat1',
      objective: 'Test task',
      handlerType: 'test_handler',
    });

    await runner.tick();
    await runner.waitForIdle();

    const task = getTask(1);
    expect(task).toBeDefined();
    expect(task!.status).toBe('completed');
    expect(task!.result).toBe('done!');
  });

  it('executes an enqueued task through the shell handler registry path', async () => {
    registerHandler('shell_background', shellBackgroundHandler);

    const created = addBackgroundTask({
      chatId: 'chat1',
      objective: 'Echo from shell',
      handlerType: 'shell_background',
      handlerParams: { command: 'printf shell-ok' },
      timeoutMs: 5_000,
    });

    await runner.tick();
    await runner.waitForIdle();

    const task = getTask(created.id);
    expect(task!.status).toBe('completed');
    expect(task!.result).toBe('shell-ok');
    expect(task!.last_error).toBeNull();
    expect(task!.running_since).toBeNull();
  });

  it('marks task as failed when handler throws', async () => {
    registerHandler('fail_handler', async () => {
      throw new Error('Something broke');
    });

    const created = addBackgroundTask({
      chatId: 'chat1',
      objective: 'Failing task',
      handlerType: 'fail_handler',
      maxRetries: 0, // No retries
    });

    await runner.tick();
    await runner.waitForIdle();

    const task = getTask(created.id);
    expect(task!.status).toBe('failed');
    expect(task!.result).toContain('Something broke');
  });

  it('retries task on failure only after exponential backoff delay', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    try {
      let attempts = 0;
      registerHandler('retry_handler', async () => {
        attempts++;
        if (attempts < 2) throw new Error('Temporary failure');
        return 'succeeded on retry';
      });

      addBackgroundTask({
        chatId: 'chat1',
        objective: 'Retry task',
        handlerType: 'retry_handler',
        maxRetries: 3,
      });

      await runner.tick();
      await runner.waitForIdle();

      let task = getTask(1);
      expect(task!.status).toBe('retrying');
      expect(task!.retry_count).toBe(1);
      expect(task!.retry_after).toBe(Date.now() + BACKGROUND_TASK_RETRY_BASE_MS);

      await runner.tick();
      await runner.waitForIdle();
      expect(attempts).toBe(1);
      expect(getTask(1)!.status).toBe('retrying');

      await vi.advanceTimersByTimeAsync(BACKGROUND_TASK_RETRY_BASE_MS);
      await runner.tick();
      await runner.waitForIdle();

      task = getTask(1);
      expect(task!.status).toBe('completed');
      expect(task!.result).toBe('succeeded on retry');
      expect(task!.retry_after).toBeNull();
      expect(attempts).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('calculates capped exponential retry delays', () => {
    expect(calculateRetryDelayMs(1)).toBe(BACKGROUND_TASK_RETRY_BASE_MS);
    expect(calculateRetryDelayMs(2)).toBe(BACKGROUND_TASK_RETRY_BASE_MS * 2);
    expect(calculateRetryDelayMs(3)).toBe(BACKGROUND_TASK_RETRY_BASE_MS * 4);
    expect(calculateRetryDelayMs(10)).toBe(BACKGROUND_TASK_RETRY_MAX_MS);
  });

  it('fails task when no handler is registered', async () => {
    addBackgroundTask({
      chatId: 'chat1',
      objective: 'Unknown type task',
      handlerType: 'nonexistent_handler',
    });

    await runner.tick();
    await runner.waitForIdle();

    const task = getTask(1);
    expect(task!.status).toBe('failed');
    expect(task!.result).toContain('No handler registered');
  });

  it('respects max concurrent task limit', async () => {
    let running = 0;
    let maxConcurrent = 0;

    registerHandler('slow_handler', async (_task, signal) => {
      running++;
      maxConcurrent = Math.max(maxConcurrent, running);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { running--; resolve(); }, 200);
        signal.addEventListener('abort', () => { clearTimeout(timer); running--; reject(new Error('abort')); }, { once: true });
      });
      return 'done';
    });

    // Create 5 tasks
    for (let i = 0; i < 5; i++) {
      addBackgroundTask({
        chatId: 'chat1',
        objective: `Task ${i}`,
        handlerType: 'slow_handler',
      });
    }

    await runner.tick();
    await new Promise(r => setTimeout(r, 50));

    // Should have at most 3 running (MAX_CONCURRENT_TASKS)
    expect(maxConcurrent).toBeLessThanOrEqual(3);
  });

  it('aborts task on timeout', async () => {
    registerHandler('timeout_handler', async (_task, signal) => {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 10000); // Would take 10s
        signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('Aborted')); }, { once: true });
      });
      return 'should not reach';
    });

    addBackgroundTask({
      chatId: 'chat1',
      objective: 'Timeout task',
      handlerType: 'timeout_handler',
      timeoutMs: 100, // 100ms timeout
      maxRetries: 0,
    });

    await runner.tick();
    await runner.waitForIdle();

    const task = getTask(1);
    expect(task!.status).toBe('failed');
    expect(task!.result).toContain('Timeout');
  });

  it('does not pick up already running tasks', async () => {
    let callCount = 0;
    registerHandler('count_handler', async () => {
      callCount++;
      await new Promise(r => setTimeout(r, 200));
      return 'done';
    });

    addBackgroundTask({
      chatId: 'chat1',
      objective: 'Single exec task',
      handlerType: 'count_handler',
    });

    // Tick twice quickly
    await runner.tick();
    await runner.tick();
    await runner.waitForIdle();

    expect(callCount).toBe(1); // Only executed once
  });

  it('tracks active count correctly', async () => {
    registerHandler('active_handler', async (_task, signal) => {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 200);
        signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('abort')); }, { once: true });
      });
      return 'done';
    });

    addBackgroundTask({
      chatId: 'chat1',
      objective: 'Active task',
      handlerType: 'active_handler',
    });

    expect(runner.activeCount).toBe(0);
    await runner.tick();
    await new Promise(r => setTimeout(r, 20));
    expect(runner.activeCount).toBe(1);
    await runner.waitForIdle();
    expect(runner.activeCount).toBe(0);
  });

  it('handles empty pending queue gracefully', async () => {
    await runner.tick(); // No tasks — should not throw
    expect(runner.activeCount).toBe(0);
  });

  it('stop aborts running tasks', async () => {
    let aborted = false;
    registerHandler('long_handler', async (_task, signal) => {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 10000);
        signal.addEventListener('abort', () => { clearTimeout(timer); aborted = true; reject(new Error('abort')); }, { once: true });
      });
      return 'done';
    });

    addBackgroundTask({
      chatId: 'chat1',
      objective: 'Long task',
      handlerType: 'long_handler',
    });

    await runner.tick();
    await new Promise(r => setTimeout(r, 50));
    expect(runner.activeCount).toBe(1);

    runner.stop();
    await runner.waitForIdle();
    expect(aborted).toBe(true);
    expect(runner.activeCount).toBe(0);
  });
});
