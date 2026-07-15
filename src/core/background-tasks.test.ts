import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../store/db.js';
import { setupTestDb, teardownTestDb } from '../test-helpers.js';
import {
  addBackgroundTask,
  claimTaskForRun,
  getTask,
  getPendingTasks,
  getBackgroundTaskStats,
  completeTask,
  failTask,
  resetBackgroundTaskTableFlag,
} from './background-tasks.js';

let tmpDir: string;

describe('core/background-tasks', () => {
  beforeEach(() => {
    const result = setupTestDb();
    tmpDir = result.tmpDir;
    resetBackgroundTaskTableFlag();
  });

  afterEach(() => {
    teardownTestDb(tmpDir);
  });

  it('adds and returns a pending background task', () => {
    const task = addBackgroundTask('chat-1', 'Check nightly deploy logs', 'tenant-a');

    expect(task.id).toBeGreaterThan(0);
    expect(task.tenant_id).toBe('tenant-a');
    expect(task.chat_id).toBe('chat-1');
    expect(task.objective).toBe('Check nightly deploy logs');
    expect(task.status).toBe('pending');
    expect(task.result).toBeNull();
    expect(task.completed_at).toBeNull();
  });

  it('lists only pending tasks for the requested tenant', () => {
    const pendingA = addBackgroundTask('chat-a', 'Resume ETL task', 'tenant-a');
    const toComplete = addBackgroundTask('chat-a', 'Already done', 'tenant-a');
    addBackgroundTask('chat-b', 'Other tenant task', 'tenant-b');

    completeTask(toComplete.id, 'completed');

    const tasks = getPendingTasks('tenant-a');
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe(pendingA.id);
  });

  it('marks task as completed with result and completed_at', () => {
    const task = addBackgroundTask('chat-1', 'Draft release note');

    expect(claimTaskForRun(task.id)).toBe(true);
    completeTask(task.id, 'Release note drafted');

    const row = getDb().prepare(`
      SELECT status, result, running_since, last_error, completed_at
      FROM background_tasks
      WHERE id = ?
    `).get(task.id) as {
      status: string;
      result: string | null;
      running_since: string | null;
      last_error: string | null;
      completed_at: string | null;
    };

    expect(row.status).toBe('completed');
    expect(row.result).toBe('Release note drafted');
    expect(row.running_since).toBeNull();
    expect(row.last_error).toBeNull();
    expect(row.completed_at).toBeTruthy();
  });

  it('marks task as failed with failure reason', () => {
    const task = addBackgroundTask('chat-1', 'Sync customer data');

    expect(claimTaskForRun(task.id)).toBe(true);
    failTask(task.id, 'network timeout');

    const row = getDb().prepare(`
      SELECT status, result, last_error, running_since, completed_at
      FROM background_tasks
      WHERE id = ?
    `).get(task.id) as {
      status: string;
      result: string | null;
      last_error: string | null;
      running_since: string | null;
      completed_at: string | null;
    };

    expect(row.status).toBe('failed');
    expect(row.result).toBe('network timeout');
    expect(row.last_error).toBe('network timeout');
    expect(row.running_since).toBeNull();
    expect(row.completed_at).toBeTruthy();
  });

  it('claims a pending task exactly once', () => {
    const task = addBackgroundTask('chat-1', 'Run once');

    expect(claimTaskForRun(task.id)).toBe(true);
    expect(claimTaskForRun(task.id)).toBe(false);
    expect(getTask(task.id)?.status).toBe('running');
  });

  it('returns tenant-scoped task status counters', () => {
    const t1 = addBackgroundTask('chat-1', 'pending A', 'tenant-a');
    const t2 = addBackgroundTask('chat-1', 'complete A', 'tenant-a');
    const t3 = addBackgroundTask('chat-1', 'failed A', 'tenant-a');
    addBackgroundTask('chat-2', 'pending B', 'tenant-b');

    completeTask(t2.id, 'done');
    failTask(t3.id, 'bad');

    const statsA = getBackgroundTaskStats('tenant-a');
    expect(statsA.pending).toBe(1);
    expect(statsA.completed).toBe(1);
    expect(statsA.failed).toBe(1);

    const statsB = getBackgroundTaskStats('tenant-b');
    expect(statsB.pending).toBe(1);
    expect(statsB.completed).toBe(0);
    expect(statsB.failed).toBe(0);

    expect(t1.id).toBeGreaterThan(0);
  });
});
