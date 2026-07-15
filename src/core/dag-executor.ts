import pino from 'pino';
import type { LLMClient } from './llm.js';
import type { TaskRecord } from '../store/task-dag.js';
import { getById, getDependencies, updateStatus, updateTask } from '../store/task-dag.js';
import { loadTaskResult } from '../tasks/workspace.js';
import { getConfig } from '../config/index.js';
import {
  startTracking,
  reportTaskStarted,
  reportTaskCompleted,
  reportTaskFailed,
  reportTaskCancelled,
  stopTracking,
} from '../progress/progress-reporter.js';
import { log as logEvent } from '../store/events.js';
import { dispatchToSubAgent, isSubAgentAvailable } from './subagent-dispatch.js';
import { write as writeBlackboard } from '../capabilities/blackboard.js';
import { searchLessons, incrementApplied } from '../memory/lessons.js';
import {
  TaskCancelledError,
  registerRunningTask,
  finishRunningTask,
  clearCancellationRequest,
  isTaskCancellationRequested,
  throwIfTaskCancelled,
} from './task-cancellation.js';
import { reportTimeoutAndMaybeTune } from './autonomous-timeout.js';
import { buildDependencyMap, buildDependentsMap, topologicalOrder } from './dag-graph.js';
import { executeSingleTask, isTimeoutFallbackResult, isInterruptedFallbackResult } from './dag-task-loop.js';
import type { ToolContext } from '../tools/types.js';
import { buildExecutionToolContext } from '../tools/execution-context.js';

const logger = pino({ name: 'mozi:dag-executor' });

// ---------------------------------------------------------------------------
// Concurrency Semaphore — limits parallel SubAgent spawns
// ---------------------------------------------------------------------------

class ConcurrencySemaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly maxConcurrent: number) {}

  async acquire(): Promise<void> {
    if (this.active < this.maxConcurrent) {
      this.active++;
      return;
    }
    return new Promise<void>((resolve) => {
      this.waiting.push(() => {
        this.active++;
        resolve();
      });
    });
  }

  release(): void {
    this.active--;
    const next = this.waiting.shift();
    if (next) next();
  }
}

type SubagentFallbackReason = 'subagent_dispatch_failed' | 'subagent_dispatch_exception' | 'no_subagent_available';

interface SubagentFallbackMetadata {
  runtimeSource?: string;
  runtimeSessionKey?: string;
  sessionId?: string;
  turnId?: string;
  toolContext?: ToolContext;
  detail?: string;
}

function recordSubagentFallbackForTask(
  task: TaskRecord,
  chatId: string,
  reason: SubagentFallbackReason,
  metadata?: SubagentFallbackMetadata,
): void {
  try {
    logEvent(
      'dag_subagent_fallback',
      'task',
      task.id,
      {
        chat_id: chatId,
        reason,
        fallback: 'in_process',
        runtime_source: metadata?.runtimeSource ?? 'unknown',
        runtime_session_key: metadata?.runtimeSessionKey ?? null,
        session_id: metadata?.sessionId ?? null,
        turn_id: metadata?.turnId,
        detail: metadata?.detail,
      },
      task.tenant_id,
    );
  } catch (err) {
    logger.warn({
      taskId: task.id,
      chatId,
      reason,
      err: err instanceof Error ? err.message : String(err),
    }, 'Failed to persist SubAgent fallback event');
  }
}

function recordSubagentUnavailableForDag(
  tenantId: string,
  chatId: string,
  taskCount: number,
  metadata?: SubagentFallbackMetadata,
): void {
  try {
    logEvent(
      'dag_subagent_fallback',
      'dag',
      chatId,
      {
        chat_id: chatId,
        reason: 'no_subagent_available',
        fallback: 'in_process',
        task_count: taskCount,
        runtime_source: metadata?.runtimeSource ?? 'unknown',
        runtime_session_key: metadata?.runtimeSessionKey ?? null,
        turn_id: metadata?.turnId,
      },
      tenantId,
    );
  } catch (err) {
    logger.warn({
      chatId,
      reason: 'no_subagent_available',
      err: err instanceof Error ? err.message : String(err),
    }, 'Failed to persist DAG SubAgent unavailable event');
  }
}

type ExecutionStatus = 'pending' | 'running' | 'completed' | 'blocked' | 'failed' | 'cancelled';

interface ExecutionState {
  status: ExecutionStatus;
  result?: string;
  error?: string;
  attempts: number;
}

interface TaskExecutionOutcome {
  taskId: string;
  success: boolean;
  cancelled?: boolean;
  result?: string;
  error?: string;
  elapsedMs: number;
  timedOut?: boolean;
  retryable?: boolean;
  retryAfterMs?: number;
}

function clearTaskGuardReason(taskId: string, tenantId: string): void {
  const persisted = getById(taskId, tenantId);
  if (!persisted || typeof persisted.constraints?.guard_reason !== 'string') return;
  const constraints = { ...persisted.constraints };
  delete constraints.guard_reason;
  updateTask(taskId, { constraints }, tenantId);
  logEvent('task_guard_cleared', 'task', taskId, { reason: 'execution_recovered' }, tenantId);
}

export interface DagTaskProgressEvent {
  type: 'task_started' | 'task_completed' | 'task_failed' | 'task_cancelled';
  taskId: string;
  taskTitle: string;
  elapsed_ms?: number;
  error?: string;
}

export type DagProgressCallback = (event: DagTaskProgressEvent) => void | Promise<void>;

/**
 * Execute a task DAG by dependency waves.
 * Tasks with all deps completed run in parallel; dependents of failures are
 * persisted as blocked without execution.
 */
export interface DagExecutionOptions {
  /** When true, dispatch tasks to SubAgent child processes instead of in-process LLM loops. */
  useSubAgents?: boolean;
  /** Observability tag describing who enabled SubAgent runtime (global/tenant/session/capability). */
  subagentRuntimeSource?: string;
  /** Session key used by rollout controls (tenant:session/chat). */
  subagentSessionKey?: string;
  /** DB session ID used by the Web UI timeline. */
  sessionId?: string;
  /** Permission/session context inherited from the originating turn. */
  toolContext?: ToolContext;
}

export async function executeDag(
  tasks: TaskRecord[],
  systemPrompt: string,
  chatId: string,
  progress?: DagProgressCallback,
  fallbackClient?: LLMClient,
  turnId?: string,
  options?: DagExecutionOptions,
): Promise<string> {
  if (tasks.length === 0) {
    return '(No tasks to execute)';
  }

  const dagId = chatId;
  const tenantId = tasks[0].tenant_id;
  const requestedSubAgents = options?.useSubAgents === true;
  const subagentAvailable = requestedSubAgents ? isSubAgentAvailable(tenantId) : false;
  const useSubAgents = requestedSubAgents && subagentAvailable;
  const semaphore = useSubAgents
    ? new ConcurrencySemaphore(getConfig().system.max_parallel_agents)
    : null;

  if (requestedSubAgents && !subagentAvailable) {
    logger.info({
      tenantId,
      chatId,
      source: options?.subagentRuntimeSource ?? 'unknown',
    }, 'SubAgent runtime requested but unavailable, using in-process fallback');
    recordSubagentUnavailableForDag(
      tenantId,
      chatId,
      tasks.length,
      {
        runtimeSource: options?.subagentRuntimeSource,
        runtimeSessionKey: options?.subagentSessionKey,
        sessionId: options?.sessionId,
        turnId,
      },
    );
  }

  if (useSubAgents) {
    logger.info({
      maxParallel: getConfig().system.max_parallel_agents,
      source: options?.subagentRuntimeSource ?? 'unknown',
      sessionKey: options?.subagentSessionKey ?? `${tenantId}:${chatId}`,
    }, 'DAG using SubAgent dispatch');
  }

  const taskById = new Map(tasks.map(task => [task.id, task]));
  const dependencies = buildDependencyMap(tasks, taskById);
  const dependents = buildDependentsMap(tasks, dependencies);
  const topoOrder = topologicalOrder(tasks, dependencies, dependents);

  startTracking(dagId, tasks.length, chatId, turnId, options?.sessionId, tenantId);

  const state = new Map<string, ExecutionState>();
  for (const task of tasks) {
    state.set(task.id, { status: 'pending', attempts: 0 });
  }

  const emitTaskEvent = async (event: DagTaskProgressEvent): Promise<void> => {
    const task = taskById.get(event.taskId);
    if (task) {
      const nextStatus = event.type === 'task_started'
        ? 'running'
        : event.type === 'task_completed'
        ? 'completed'
        : event.type === 'task_cancelled'
        ? 'cancelled'
        : 'failed';
      updateStatus(task.id, nextStatus, task.tenant_id);
      logEvent(event.type, 'task', task.id, {
        title: task.title,
        elapsed_ms: event.elapsed_ms,
        error: event.error,
      }, task.tenant_id);
    }

    // Parent linkage (Issue #624): surface the subtask's owning plan-root/parent
    // so the timeline nests it under the correct group. undefined for a top-level
    // task (e.g. the plan root itself).
    const parentTaskId = task?.parent_task_id ?? undefined;
    if (event.type === 'task_started') {
      reportTaskStarted(dagId, event.taskId, event.taskTitle, parentTaskId);
    } else if (event.type === 'task_completed') {
      reportTaskCompleted(dagId, event.taskId, event.taskTitle, event.elapsed_ms ?? 0, parentTaskId);
    } else if (event.type === 'task_cancelled') {
      reportTaskCancelled(dagId, event.taskId, event.taskTitle, event.error ?? 'Task cancelled', parentTaskId);
    } else {
      reportTaskFailed(dagId, event.taskId, event.taskTitle, event.error ?? 'Unknown error', parentTaskId);
    }

    if (progress) {
      await progress(event);
    }
  };

  const failDependents = async (failedTaskId: string, reason: string): Promise<void> => {
    const queue = [...(dependents.get(failedTaskId) ?? [])];

    while (queue.length > 0) {
      const dependentId = queue.shift()!;
      const snapshot = state.get(dependentId);
      if (!snapshot || snapshot.status !== 'pending') {
        continue;
      }

      const dependentTask = taskById.get(dependentId);
      if (!dependentTask) {
        continue;
      }

      // Check on_dep_failure policy
      if (dependentTask.on_dep_failure === 'continue') {
        // Task opts to continue despite upstream failure — don't cascade
        logger.info({
          taskId: dependentTask.id,
          failedDep: failedTaskId,
          policy: 'continue',
        }, 'Upstream failed but dependent continues per on_dep_failure policy');
        continue;
      }

      // fail_fast (default): the dependent did not execute. Persist it as
      // blocked rather than lying that its own work failed.
      const error = `Dependency failed: ${reason}`;
      state.set(dependentId, { status: 'blocked', error, attempts: snapshot.attempts });
      updateTask(dependentTask.id, {
        constraints: {
          ...dependentTask.constraints,
          blocked_by_task_id: failedTaskId,
          blocked_reason: error,
        },
      }, dependentTask.tenant_id);
      updateStatus(dependentTask.id, 'blocked', dependentTask.tenant_id, {
        reason: error,
        blocked_by_task_id: failedTaskId,
      });
      logEvent('task_blocked', 'task', dependentTask.id, {
        title: dependentTask.title,
        error,
        blocked_by_task_id: failedTaskId,
      }, dependentTask.tenant_id);

      queue.push(...(dependents.get(dependentId) ?? []));
    }
  };

  const cancelDependents = async (cancelledTaskId: string, reason: string): Promise<void> => {
    const queue = [...(dependents.get(cancelledTaskId) ?? [])];
    while (queue.length > 0) {
      const dependentId = queue.shift()!;
      const snapshot = state.get(dependentId);
      if (!snapshot || snapshot.status !== 'pending') {
        continue;
      }

      const dependentTask = taskById.get(dependentId);
      if (!dependentTask) continue;

      const error = `Dependency cancelled: ${reason}`;
      state.set(dependentId, { status: 'cancelled', error, attempts: snapshot.attempts });
      await emitTaskEvent({
        type: 'task_cancelled',
        taskId: dependentTask.id,
        taskTitle: dependentTask.title,
        error,
      });
      clearCancellationRequest(dependentTask.id, dependentTask.tenant_id);
      queue.push(...(dependents.get(dependentId) ?? []));
    }
  };

  while (true) {
    const readyTaskIds = topoOrder.filter((taskId) => {
      const snapshot = state.get(taskId);
      if (!snapshot || snapshot.status !== 'pending') {
        return false;
      }

      const task = taskById.get(taskId);
      const deps = dependencies.get(taskId) ?? [];
      return deps.every(depId => {
        const depStatus = state.get(depId)?.status;
        if (depStatus === 'completed') return true;
        // If this task uses 'continue' policy, treat failed deps as resolved
        if (depStatus === 'failed' && task?.on_dep_failure === 'continue') return true;
        return false;
      });
    });

    if (readyTaskIds.length === 0) {
      break;
    }

    const settled = await Promise.allSettled(
      readyTaskIds.map(async (taskId): Promise<TaskExecutionOutcome> => {
        const task = taskById.get(taskId)!;
        const prevState = state.get(taskId)!;
        const startedAt = Date.now();
        const taskAbortSignal = registerRunningTask({
          taskId: task.id,
          tenantId: task.tenant_id,
          chatId,
          turnId,
          taskTitle: task.title,
        });

        try {
          throwIfTaskCancelled(taskAbortSignal, task.id);
          state.set(taskId, { status: 'running', attempts: prevState.attempts });
          await emitTaskEvent({
            type: 'task_started',
            taskId: task.id,
            taskTitle: task.title,
          });

          let depContext = buildDependencyContext(task, dependencies, state, taskById);

          // On retry attempts, inject relevant lessons from past failures
          if (prevState.attempts > 0) {
            depContext = appendLessonsContext(depContext, task);
          }

          if (semaphore) {
            await semaphore.acquire();
            try {
              return await executeViaSubAgentOrFallback(
                task, systemPrompt, chatId, depContext, fallbackClient, turnId, startedAt, taskAbortSignal,
                {
                  runtimeSource: options?.subagentRuntimeSource,
                  runtimeSessionKey: options?.subagentSessionKey,
                  sessionId: options?.sessionId,
                  turnId,
                  toolContext: options?.toolContext,
                },
              );
            } finally {
              semaphore.release();
            }
          }

          const result = await executeSingleTask(
            task,
            systemPrompt,
            chatId,
            fallbackClient,
            depContext,
            turnId,
            taskAbortSignal,
            options?.toolContext,
          );
          // A generic-interruption fallback string is NOT a completed step. It
          // means the loop stopped on a guard (or a user cancel that unwound by
          // returning instead of throwing). Treat it as cancelled — no retry, no
          // whitewash into "completed".
          if (isInterruptedFallbackResult(result)) {
            return {
              taskId,
              success: false,
              cancelled: true,
              error: result,
              elapsedMs: Date.now() - startedAt,
            };
          }
          const timedOut = isTimeoutFallbackResult(result);
          return {
            taskId,
            success: !timedOut,
            result: timedOut ? undefined : result,
            error: timedOut ? 'Task timed out' : undefined,
            elapsedMs: Date.now() - startedAt,
            timedOut,
          };
        } catch (err) {
          if (err instanceof TaskCancelledError || taskAbortSignal.aborted) {
            return {
              taskId,
              success: false,
              cancelled: true,
              error: err instanceof Error ? err.message : 'Task cancelled',
              elapsedMs: Date.now() - startedAt,
            };
          }
          return {
            taskId,
            success: false,
            error: err instanceof Error ? err.message : String(err),
            elapsedMs: Date.now() - startedAt,
            retryable: isRetryableTaskError(err),
            retryAfterMs: retryAfterMs(err),
          };
        } finally {
          finishRunningTask(task.id, task.tenant_id);
        }
      }),
    );

    for (let i = 0; i < settled.length; i++) {
      const taskId = readyTaskIds[i];
      const task = taskById.get(taskId)!;
      const outcome = settled[i];
      const prevAttempts = state.get(taskId)?.attempts ?? 0;
      const maxRetries = task.constraints.max_retries ?? 2;

      if (outcome.status === 'rejected') {
        const error = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
        state.set(taskId, { status: 'failed', error, attempts: prevAttempts + 1 });

        await emitTaskEvent({
          type: 'task_failed',
          taskId: task.id,
          taskTitle: task.title,
          error,
        });
        await failDependents(taskId, `${task.title}: ${error}`);
        clearCancellationRequest(task.id, task.tenant_id);
        continue;
      }

      if (outcome.value.cancelled) {
        const error = outcome.value.error || 'Task cancelled';
        state.set(taskId, { status: 'cancelled', error, attempts: prevAttempts + 1 });
        await emitTaskEvent({
          type: 'task_cancelled',
          taskId: task.id,
          taskTitle: task.title,
          elapsed_ms: outcome.value.elapsedMs,
          error,
        });
        await cancelDependents(taskId, `${task.title}: ${error}`);
      } else if (outcome.value.success) {
        clearTaskGuardReason(task.id, task.tenant_id);
        state.set(taskId, {
          status: 'completed',
          result: outcome.value.result,
          attempts: prevAttempts + 1,
        });

        await emitTaskEvent({
          type: 'task_completed',
          taskId: task.id,
          taskTitle: task.title,
          elapsed_ms: outcome.value.elapsedMs,
        });
        clearCancellationRequest(task.id, task.tenant_id);
      } else if ((outcome.value.timedOut || outcome.value.retryable) && prevAttempts < maxRetries) {
        // Recoverable provider/runtime failure with retries remaining — start a
        // fresh task loop. This also gives failover a clean provider-native
        // transcript instead of switching providers mid-loop.
        logger.info({
          taskId: task.id,
          attempt: prevAttempts + 1,
          maxRetries,
          retryAfterMs: outcome.value.retryAfterMs ?? 0,
        }, 'Recoverable task failure, re-queuing for retry');
        clearTaskGuardReason(task.id, task.tenant_id);
        state.set(taskId, { status: 'pending', attempts: prevAttempts + 1 });
        updateStatus(task.id, 'ready', task.tenant_id);
        logEvent('task_retry_scheduled', 'task', task.id, {
          title: task.title,
          attempt: prevAttempts + 1,
          max_retries: maxRetries,
          reason: outcome.value.error,
        }, task.tenant_id);
        if ((outcome.value.retryAfterMs ?? 0) > 0) {
          await new Promise(resolve => setTimeout(resolve, Math.min(outcome.value.retryAfterMs!, 30_000)));
        }
      } else {
        const error = outcome.value.error || 'Unknown task error';
        state.set(taskId, { status: 'failed', error, attempts: prevAttempts + 1 });

        await emitTaskEvent({
          type: 'task_failed',
          taskId: task.id,
          taskTitle: task.title,
          elapsed_ms: outcome.value.elapsedMs,
          error,
        });
        await failDependents(taskId, `${task.title}: ${error}`);
        clearCancellationRequest(task.id, task.tenant_id);
      }

      if (outcome.value.cancelled) {
        clearCancellationRequest(task.id, task.tenant_id);
      }
    }
  }

  for (const taskId of topoOrder) {
    const snapshot = state.get(taskId);
    if (snapshot?.status === 'pending' || snapshot?.status === 'running') {
      const task = taskById.get(taskId)!;
      if (isTaskCancellationRequested(task.id, task.tenant_id)) {
        const error = 'Task cancelled';
        state.set(taskId, { status: 'cancelled', error, attempts: snapshot.attempts });
        await emitTaskEvent({
          type: 'task_cancelled',
          taskId: task.id,
          taskTitle: task.title,
          error,
        });
      } else {
        const error = 'Task was not executed due to unresolved dependencies';
        state.set(taskId, { status: 'blocked', error, attempts: snapshot.attempts });
        updateTask(task.id, {
          constraints: { ...task.constraints, blocked_reason: error },
        }, task.tenant_id);
        updateStatus(task.id, 'blocked', task.tenant_id, { reason: error });
        logEvent('task_blocked', 'task', task.id, {
          title: task.title,
          error,
          reason: 'unresolved_dependencies',
        }, task.tenant_id);
      }
      clearCancellationRequest(task.id, task.tenant_id);
    }
  }

  const aggregatedOutput = topoOrder.map((taskId, index) => {
    const task = taskById.get(taskId)!;
    const snapshot = state.get(taskId)!;

    const title = `Task ${index + 1}: ${task.title}`;
    if (snapshot.status === 'completed') {
      return `${title}\n${snapshot.result?.trim() || '(no output)'}`;
    }

    if (snapshot.status === 'cancelled') {
      return `${title}\nCancelled: ${snapshot.error || 'Task cancelled'}`;
    }

    if (snapshot.status === 'blocked') {
      return `${title}\nBlocked (not executed): ${snapshot.error || 'Waiting for dependencies'}`;
    }

    return `${title}\nError: ${snapshot.error || 'Unknown error'}`;
  }).join('\n\n---\n\n');

  stopTracking(dagId);
  logger.info({ totalTasks: tasks.length }, 'DAG execution completed');
  return aggregatedOutput;
}

function isRetryableTaskError(err: unknown): boolean {
  if (err && typeof err === 'object' && 'retryable' in err && (err as { retryable?: unknown }).retryable === true) {
    return true;
  }
  const message = err instanceof Error ? err.message : String(err);
  return /rate[_ -]?limit|tokens per min|\b429\b|temporar(?:y|ily) unavailable|\b502\b|\b503\b|connection reset/i.test(message);
}

function retryAfterMs(err: unknown): number | undefined {
  const message = err instanceof Error ? err.message : String(err);
  const match = message.match(/try again in\s+([0-9.]+)\s*(ms|s)/i);
  if (!match) return undefined;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value < 0) return undefined;
  return match[2].toLowerCase() === 's' ? Math.ceil(value * 1000) : Math.ceil(value);
}

/**
 * Search for relevant lessons and append them to the dependency context.
 * Called on retry attempts so the LLM can learn from past failures.
 */
function appendLessonsContext(depContext: string, task: TaskRecord): string {
  try {
    // Search by task title keywords
    const keywords = task.title.split(/\s+/).filter(w => w.length > 2).slice(0, 3);
    const matched = new Map<number, string>();

    for (const kw of keywords) {
      for (const lesson of searchLessons(kw, task.tenant_id)) {
        matched.set(lesson.id, lesson.lesson);
      }
    }

    if (matched.size === 0) return depContext;

    // Mark lessons as applied
    for (const id of matched.keys()) {
      incrementApplied(id);
    }

    const lessonsBlock = [...matched.values()].slice(0, 5).map(l => `- ${l}`).join('\n');
    return `${depContext}\n\nLessons from past attempts:\n${lessonsBlock}`;
  } catch {
    return depContext;
  }
}

/**
 * Build context string from completed dependency task results.
 * This allows downstream tasks to see what upstream tasks discovered.
 *
 * Resume support: dependencies completed in a PREVIOUS run are excluded from
 * the current execution scope (buildDependencyMap filters to in-scope tasks),
 * so their results are loaded from the persisted task workspace instead of
 * in-memory state. This is what lets a resumed DAG continue with full context.
 */
function buildDependencyContext(
  task: TaskRecord,
  dependencies: Map<string, string[]>,
  state: Map<string, ExecutionState>,
  taskById: Map<string, TaskRecord>,
): string {
  const parts: string[] = [];

  for (const depId of dependencies.get(task.id) || []) {
    const depState = state.get(depId);
    const depTask = taskById.get(depId);
    if (depState?.status === 'completed' && depState.result && depTask) {
      parts.push(`--- Result from "${depTask.title}" ---\n${depState.result}`);
    } else if (depState?.status === 'failed' && depTask) {
      parts.push(`--- "${depTask.title}" FAILED ---\n${depState.error || 'Unknown error'}`);
    }
  }

  // Out-of-scope deps (completed before this run) — recover persisted results.
  try {
    const inScope = new Set(dependencies.get(task.id) || []);
    const allDepIds = getDependencies(task.id, task.tenant_id);
    for (const depId of allDepIds) {
      if (inScope.has(depId)) continue;
      const persisted = loadTaskResult(depId);
      if (persisted?.output) {
        const depTitle = getById(depId, task.tenant_id)?.title ?? depId;
        parts.push(`--- Result from "${depTitle}" (previous run) ---\n${persisted.output}`);
      }
    }
  } catch {
    // Persisted-result recovery is best-effort; execution proceeds without it.
  }

  return parts.length > 0
    ? `\n\nContext from previous tasks:\n${parts.join('\n\n')}`
    : '';
}

/**
 * Attempt SubAgent dispatch; fall back to in-process execution on failure.
 */
async function executeViaSubAgentOrFallback(
  task: TaskRecord,
  systemPrompt: string,
  chatId: string,
  depContext: string,
  fallbackClient?: LLMClient,
  turnId?: string,
  startedAt?: number,
  taskAbortSignal?: AbortSignal,
  fallbackMetadata?: SubagentFallbackMetadata,
): Promise<TaskExecutionOutcome> {
  const t0 = startedAt ?? Date.now();

  try {
    throwIfTaskCancelled(taskAbortSignal, task.id);
    const subResult = await dispatchToSubAgent(
      task,
      systemPrompt,
      depContext || undefined,
      {
        abortSignal: taskAbortSignal,
        chatId,
        sessionId: fallbackMetadata?.sessionId,
        permissionLevel: fallbackMetadata?.toolContext?.permissionLevel,
        turnId,
        runtimeSource: fallbackMetadata?.runtimeSource,
        runtimeSessionKey: fallbackMetadata?.runtimeSessionKey,
      },
    );

    if (subResult.cancelled) {
      return {
        taskId: task.id,
        success: false,
        cancelled: true,
        error: subResult.output || 'Task cancelled',
        elapsedMs: Date.now() - t0,
      };
    }

    if (subResult.success) {
      // Write result to Blackboard for inter-task context sharing
      try {
        writeBlackboard(`task:${task.id}:result`, subResult.output, {
          scope: `dag:${chatId}`,
          written_by: `subagent:${task.id}`,
          ttl_seconds: 3600,
          tenant_id: task.tenant_id,
        });
      } catch (bbErr) {
        logger.warn({ taskId: task.id, err: bbErr instanceof Error ? bbErr.message : String(bbErr) },
          'Failed to write SubAgent result to Blackboard');
      }

      return {
        taskId: task.id,
        success: true,
        result: subResult.output,
        elapsedMs: Date.now() - t0,
      };
    }

    // SubAgent returned failure — fall back to in-process
    throwIfTaskCancelled(taskAbortSignal, task.id);
    const lowerOutput = subResult.output.toLowerCase();
    if (lowerOutput.includes('timeout') || lowerOutput.includes('timed out') || lowerOutput.includes('aborted')) {
      reportTimeoutAndMaybeTune({
        scope: 'subagent',
        tenantId: task.tenant_id,
        chatId,
        taskId: task.id,
        detail: subResult.output,
      });
    }
    recordSubagentFallbackForTask(task, chatId, 'subagent_dispatch_failed', {
      ...fallbackMetadata,
      detail: subResult.output.slice(0, 400),
    });
    logger.warn({ taskId: task.id, output: subResult.output }, 'SubAgent dispatch failed, falling back to in-process');
  } catch (err) {
    if (err instanceof TaskCancelledError || taskAbortSignal?.aborted) {
      return {
        taskId: task.id,
        success: false,
        cancelled: true,
        error: err instanceof Error ? err.message : 'Task cancelled',
        elapsedMs: Date.now() - t0,
      };
    }
    const detail = err instanceof Error ? err.message : String(err);
    const lowerDetail = detail.toLowerCase();
    if (lowerDetail.includes('timeout') || lowerDetail.includes('timed out') || lowerDetail.includes('aborted')) {
      reportTimeoutAndMaybeTune({
        scope: 'subagent',
        tenantId: task.tenant_id,
        chatId,
        taskId: task.id,
        detail,
      });
    }
    recordSubagentFallbackForTask(task, chatId, 'subagent_dispatch_exception', {
      ...fallbackMetadata,
      detail: detail.slice(0, 400),
    });
    logger.warn({
      taskId: task.id,
      err: detail,
    }, 'SubAgent dispatch threw, falling back to in-process');
  }

  // Fallback: in-process execution
  try {
    const fallbackToolContext = buildExecutionToolContext('subagent_fallback', {
      ...fallbackMetadata?.toolContext,
      chatId: task.id,
      taskId: task.id,
      tenantId: task.tenant_id,
      agentId: task.assigned_agent || task.id,
      permissionLevel: fallbackMetadata?.toolContext?.permissionLevel,
    });
    const result = await executeSingleTask(
      task,
      systemPrompt,
      chatId,
      fallbackClient,
      depContext,
      turnId,
      taskAbortSignal,
      fallbackToolContext,
    );
    if (isInterruptedFallbackResult(result)) {
      return {
        taskId: task.id,
        success: false,
        cancelled: true,
        error: result,
        elapsedMs: Date.now() - t0,
      };
    }
    const timedOut = isTimeoutFallbackResult(result);
    return {
      taskId: task.id,
      success: !timedOut,
      result: timedOut ? undefined : result,
      error: timedOut ? 'Task timed out' : undefined,
      elapsedMs: Date.now() - t0,
      timedOut,
    };
  } catch (err) {
    if (err instanceof TaskCancelledError || taskAbortSignal?.aborted) {
      return {
        taskId: task.id,
        success: false,
        cancelled: true,
        error: err instanceof Error ? err.message : 'Task cancelled',
        elapsedMs: Date.now() - t0,
      };
    }
    return {
      taskId: task.id,
      success: false,
      error: err instanceof Error ? err.message : String(err),
      elapsedMs: Date.now() - t0,
      retryable: isRetryableTaskError(err),
      retryAfterMs: retryAfterMs(err),
    };
  }
}
