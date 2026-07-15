/**
 * BackgroundJobRunner — Polls pending tasks and executes handlers.
 *
 * Design decisions:
 * - Single-process execution (no subprocess forking) — simple and reliable
 * - 10-second poll interval — responsive enough for background work
 * - Max 3 concurrent tasks — prevent resource exhaustion
 * - Timeout via AbortController + setTimeout
 * - Retry with exponential backoff
 * - Notify user on completion/failure via proactive-notifier
 */

import pino from 'pino';
import {
  getPendingTasks,
  getRunningTasks,
  claimTaskForRun,
  markRetrying,
  completeTask,
  failTask,
  getTask,
  type BackgroundTask,
} from '../core/background-tasks.js';
import { resolveHandler } from './registry.js';
import { notify } from '../channels/proactive-notifier.js';

const logger = pino({ name: 'mozi:bg-runner' });

const DEFAULT_POLL_INTERVAL_MS = 10_000;
const MAX_CONCURRENT_TASKS = 3;

export class BackgroundJobRunner {
  private interval: ReturnType<typeof setInterval> | null = null;
  private running = new Map<number, { controller: AbortController; timer: ReturnType<typeof setTimeout> }>();
  private executions = new Set<Promise<void>>();
  private pollIntervalMs: number;
  private tenantId: string;
  private stopped = false;
  private ticking = false; // Prevent concurrent tick() execution

  constructor(options?: { pollIntervalMs?: number; tenantId?: string }) {
    this.pollIntervalMs = options?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.tenantId = options?.tenantId ?? 'default';
  }

  /**
   * Start polling for pending tasks.
   */
  start(): void {
    if (this.interval) return;
    this.stopped = false;

    logger.info({ pollIntervalMs: this.pollIntervalMs, tenantId: this.tenantId }, 'BackgroundJobRunner started');

    // Run immediately on start
    void this.tick();

    this.interval = setInterval(() => {
      void this.tick();
    }, this.pollIntervalMs);
    this.interval.unref(); // Don't prevent process exit
  }

  /**
   * Stop polling and abort all running tasks.
   */
  stop(): void {
    this.stopped = true;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }

    // Abort all running tasks
    for (const [taskId, { controller, timer }] of this.running) {
      clearTimeout(timer);
      controller.abort();
      logger.info({ taskId }, 'Running task aborted on shutdown');
    }
    this.running.clear();

    logger.info('BackgroundJobRunner stopped');
  }

  /**
   * Wait for currently executing task promises to settle.
   *
   * stop() stays synchronous for existing callers, while tests and shutdown
   * paths that need a clean teardown can await this to avoid dangling work.
   */
  async waitForIdle(): Promise<void> {
    while (this.executions.size > 0) {
      await Promise.allSettled([...this.executions]);
    }
  }

  /**
   * Number of currently executing tasks.
   */
  get activeCount(): number {
    return this.running.size;
  }

  /**
   * Single poll tick: check pending tasks, check timeouts, execute new tasks.
   */
  async tick(): Promise<void> {
    if (this.stopped) return;
    if (this.ticking) return; // Prevent concurrent tick overlap
    this.ticking = true;

    try {
      // 1. Check running tasks for timeouts
      this.checkTimeouts();

      // 2. Get pending tasks
      const pending = getPendingTasks(this.tenantId);
      if (pending.length === 0) return;

      // 3. Execute up to MAX_CONCURRENT minus currently running
      const slotsAvailable = MAX_CONCURRENT_TASKS - this.running.size;
      if (slotsAvailable <= 0) return;

      const toExecute = pending.slice(0, slotsAvailable);
      for (const task of toExecute) {
        if (this.running.has(task.id)) continue; // Already running
        this.startTask(task);
      }
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : String(err) }, 'Tick error');
    } finally {
      this.ticking = false;
    }
  }

  private startTask(task: BackgroundTask): void {
    const execution = this.executeTask(task).catch((err) => {
      logger.error(
        { taskId: task.id, err: err instanceof Error ? err.message : String(err) },
        'Unhandled background task execution error',
      );
    });
    this.executions.add(execution);
    void execution.finally(() => {
      this.executions.delete(execution);
    });
  }

  /**
   * Execute a single task with timeout and retry.
   */
  private async executeTask(task: BackgroundTask): Promise<void> {
    if (!claimTaskForRun(task.id, task.tenant_id)) {
      logger.debug({ taskId: task.id, tenantId: task.tenant_id }, 'Background task already claimed or terminal');
      return;
    }

    const handler = resolveHandler(task.handler_type);
    if (!handler) {
      // No handler registered — try a generic fallback or fail
      const msg = `No handler registered for type: ${task.handler_type ?? '(none)'}`;
      logger.warn({ taskId: task.id, handlerType: task.handler_type }, msg);
      failTask(task.id, msg);
      void this.notifyUser(task, 'failed', msg);
      return;
    }

    // Setup abort controller with timeout BEFORE markRunning to avoid leaks
    const controller = new AbortController();
    const timeoutMs = task.timeout_ms > 0 ? task.timeout_ms : 300_000;
    const timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);

    logger.info({ taskId: task.id, objective: task.objective.slice(0, 100), handlerType: task.handler_type }, 'Task started');
    this.running.set(task.id, { controller, timer });

    try {
      const result = await handler(task, controller.signal);

      // Clear timeout
      clearTimeout(timer);
      this.running.delete(task.id);

      // Mark completed
      completeTask(task.id, result);
      logger.info({ taskId: task.id, resultLen: result.length }, 'Task completed');
      void this.notifyUser(task, 'completed', result);
    } catch (err) {
      // Clear timeout
      clearTimeout(timer);
      this.running.delete(task.id);

      const errorMsg = err instanceof Error ? err.message : String(err);
      const isAbort = controller.signal.aborted;

      if (isAbort) {
        logger.warn({ taskId: task.id, timeoutMs }, 'Task timed out');
      } else {
        logger.error({ taskId: task.id, err: errorMsg }, 'Task failed');
      }

      // Retry if under limit
      const refreshed = getTask(task.id);
      const retryCount = refreshed?.retry_count ?? task.retry_count;
      const maxRetries = refreshed?.max_retries ?? task.max_retries;

      if (retryCount < maxRetries) {
        const retry = markRetrying(task.id, isAbort ? `Timeout after ${timeoutMs}ms` : errorMsg);
        logger.info({
          taskId: task.id,
          retryCount: retry.retry_count,
          maxRetries,
          delayMs: retry.delay_ms,
          retryAfter: retry.retry_after,
        }, 'Task scheduled for retry');
      } else {
        failTask(task.id, isAbort ? `Timeout after ${timeoutMs}ms (max retries exhausted)` : errorMsg);
        logger.warn({ taskId: task.id, retryCount, maxRetries }, 'Task failed permanently');
        void this.notifyUser(task, 'failed', errorMsg);
      }
    }
  }

  /**
   * Check running tasks for timeout (belt-and-suspenders, main timeout is AbortController).
   */
  private checkTimeouts(): void {
    const runningTasks = getRunningTasks(this.tenantId);
    for (const task of runningTasks) {
      if (!task.running_since) continue;
      const elapsed = Date.now() - new Date(task.running_since + 'Z').getTime();
      const timeoutMs = task.timeout_ms > 0 ? task.timeout_ms : 300_000;

      if (elapsed > timeoutMs * 1.5) {
        // Stale running task — process may have crashed
        const entry = this.running.get(task.id);
        if (entry) {
          clearTimeout(entry.timer);
          entry.controller.abort();
          this.running.delete(task.id);
        }
        failTask(task.id, `Stale task: running for ${Math.round(elapsed / 1000)}s without completing`);
        logger.warn({ taskId: task.id, elapsed }, 'Stale running task force-failed');
      }
    }
  }

  /**
   * Notify user about task completion/failure.
   */
  private async notifyUser(task: BackgroundTask, status: 'completed' | 'failed', detail: string): Promise<void> {
    try {
      const truncated = detail.length > 500 ? detail.slice(0, 497) + '...' : detail;
      const emoji = status === 'completed' ? '✅' : '❌';
      const message = `${emoji} Background task ${status}:\n${task.objective}\n\n${truncated}`;
      await notify(task.chat_id, message);
    } catch (err) {
      logger.warn({ taskId: task.id, err: err instanceof Error ? err.message : String(err) }, 'Failed to notify user');
    }
  }
}
