/**
 * Plan Runner — durable, detached execution of decomposed plan DAGs.
 *
 * The interactive turn is the wrong lifetime for a multi-step plan: turns get
 * cancelled, time out, and die with page refreshes and process restarts. This
 * module runs a plan DAG DETACHED from any turn:
 *
 *   - Plan state lives in the `tasks` table (root plan task + child subtasks).
 *     The DB is the single source of truth — never LLM context memory.
 *   - Execution is fire-and-forget from the caller's perspective; progress
 *     flows through the existing event pipeline (progress-reporter → event bus
 *     → WebSocket → session timeline).
 *   - Completion is delivered by the RUNTIME (persisted assistant message +
 *     broadcast), never invented by the Brain.
 *   - Incomplete plans are resumed at process startup (`resumeIncompletePlans`)
 *     with a per-root attempt cap so a poison plan cannot crash-loop tokens.
 */

import pino from 'pino';
import { getClient, getClientForRole } from './model-router.js';
import { getConfig } from '../config/index.js';
import {
  create,
  getById,
  listTasks,
  listPlanRootTasks,
  updateStatus,
  incrementAttempts,
  PLAN_ROOT_TAG,
  type TaskRecord,
} from '../store/task-dag.js';
import {
  persistTaskMetadata,
  loadTaskMetadata,
  persistTaskResult,
  loadTaskResult,
} from '../tasks/workspace.js';
import { executeDag } from './dag-executor.js';
import { emit } from '../progress/event-bus.js';
import { log as logEvent } from '../store/events.js';
import type { LLMClient } from './llm.js';
import type { DecomposeTaskInput } from './dag-bridge.js';
import { getSessionPermissionLevel, getSessionScopeGrants } from '../memory/sessions.js';
import { startTurnEnvelope, setTurnEnvelopeStatus } from '../memory/turn-envelopes.js';
import { isValidLevel, type PermissionLevel } from '../security/permissions.js';
import type { ToolContext } from '../tools/types.js';
import type { ArtifactEvent } from '../artifacts/types.js';
import { defaultChatOptionsForSurface } from './llm-surface.js';
import type { ExecutionModelSnapshot } from './execution-model.js';
import { isExecutionModelSnapshot } from './execution-model.js';

const logger = pino({ name: 'mozi:plan-runner' });

/** Statuses that mean a task no longer needs execution. */
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

/** Max detached run attempts per plan root (creation run + resumes). */
const MAX_PLAN_RUN_ATTEMPTS = 3;

/** In-memory guard against double-running the same plan in one process. */
const activeRuns = new Map<string, { startedAt: number; chatId: string }>();

function broadcastPlanSessionActivity(ctx: PlanRunContext): void {
  if (!ctx.sessionId) return;
  emit({
    type: 'session_activity_changed',
    tenantId: ctx.tenantId,
    chatId: ctx.chatId,
    sessionId: ctx.sessionId,
  });
}

export interface PlanRunContext {
  tenantId: string;
  chatId: string;
  sessionId?: string;
  userId?: string;
  permissionLevel?: PermissionLevel;
  turnId?: string;
  systemPrompt: string;
  fallbackClient?: LLMClient;
  executionModel?: ExecutionModelSnapshot;
  useSubAgents?: boolean;
  subagentRuntimeSource?: string;
  subagentSessionKey?: string;
}

function resolvePlanPermissionLevel(ctx: PlanRunContext): PermissionLevel | undefined {
  if (ctx.sessionId) {
    const current = getSessionPermissionLevel(ctx.sessionId, ctx.tenantId);
    if (current) return current;
  }
  return ctx.permissionLevel && isValidLevel(ctx.permissionLevel) ? ctx.permissionLevel : undefined;
}

/**
 * Stable, distinct Turn Envelope identity for a detached plan run (Issue #626).
 *
 * A detached plan is its OWN background turn, NOT part of the foreground turn that
 * spawned it. Deriving the id from the root task keeps it stable across a resume
 * and guarantees it never collides with an interactive `turn_*` id — so plan step
 * events and the completion message group under one background MOZI turn instead of
 * corrupting the (usually already-terminal) foreground turn's chronology.
 */
export function planBackgroundTurnId(rootTaskId: string): string {
  return `turn_bg_${rootTaskId}`;
}

function buildPlanToolContext(rootTaskId: string, ctx: PlanRunContext): ToolContext | undefined {
  const permissionLevel = resolvePlanPermissionLevel(ctx);
  if (!permissionLevel) return undefined;
  const { sessionId, userId, tenantId } = ctx;
  return {
    chatId: ctx.chatId,
    taskId: rootTaskId,
    tenantId,
    sessionId,
    userId,
    // All tool/artifact events emitted by this plan carry the background turn id,
    // so the persist path stamps them onto the background turn rather than
    // backfilling whatever foreground turn happens to be active (Issue #626).
    turnId: planBackgroundTurnId(rootTaskId),
    agentId: rootTaskId,
    permissionLevel,
    scopeGrants: sessionId ? getSessionScopeGrants(sessionId, tenantId) : [],
    // Artifacts created by plan steps must reach the session timeline (and any
    // live UI) through the same persist-then-broadcast path interactive turns
    // use — otherwise the deliverable exists only as a disk file the browser
    // cannot open. Dynamic import mirrors deliverPlanCompletion (layering).
    onArtifact: sessionId && userId
      ? (event: ArtifactEvent) => {
          void import('../channels/websocket.js')
            .then(({ broadcastArtifactEvent }) => broadcastArtifactEvent(
              event,
              userId,
              sessionId,
              tenantId,
              planBackgroundTurnId(rootTaskId),
            ))
            .catch((err) => logger.warn(
              { rootTaskId, err: err instanceof Error ? err.message : String(err) },
              'Failed to broadcast plan artifact event',
            ));
        }
      : undefined,
    executionModel: ctx.executionModel,
  };
}

export interface CreatedPlan {
  rootTaskId: string;
  goal: string;
  steps: Array<{ taskId: string; title: string }>;
}

/**
 * Persist a plan as a root task + child subtask rows. Pure creation — does
 * not execute anything. The root row carries PLAN_ROOT_TAG and its workspace
 * metadata records the delivery target (chat/session) and the system prompt
 * for resume.
 */
export function createPlanTasks(plan: DecomposeTaskInput, ctx: PlanRunContext): CreatedPlan {
  const root = create({
    tenant_id: ctx.tenantId,
    title: plan.goal.slice(0, 200),
    objective: plan.goal,
    done_criteria: 'All child subtasks reach a terminal state and results are delivered.',
    tags: [PLAN_ROOT_TAG],
    constraints: {},
  });

  const taskIds: string[] = [];
  const steps: CreatedPlan['steps'] = [];
  for (let i = 0; i < plan.subtasks.length; i++) {
    const sub = plan.subtasks[i];
    const record = create({
      tenant_id: ctx.tenantId,
      parent_task_id: root.id,
      title: sub.title,
      objective: sub.objective,
      done_criteria: sub.done_criteria,
      depends_on: sub.depends_on.map((idx) => taskIds[idx]),
      agent_type_hint: sub.agent_type_hint,
      constraints: {
        timeout_seconds: sub.constraints.timeout_seconds,
        max_retries: sub.constraints.max_retries ?? 2,
        max_tokens: sub.constraints.max_tokens,
      },
      priority: i,
      tags: [],
    });
    taskIds.push(record.id);
    steps.push({ taskId: record.id, title: sub.title });
  }

  persistTaskMetadata(root.id, {
    task_id: root.id,
    title: root.title,
    objective: root.objective,
    status: root.status,
    created_at: root.created_at,
    workspace_path: '',
    chat_id: ctx.chatId,
    session_id: ctx.sessionId,
    user_id: ctx.userId,
    permission_level: resolvePlanPermissionLevel(ctx),
    plan_goal: plan.goal,
    system_prompt: ctx.systemPrompt,
    execution_model: ctx.executionModel,
  });

  logEvent('plan_created', 'task', root.id, {
    goal: plan.goal,
    step_count: steps.length,
    chat_id: ctx.chatId,
    session_id: ctx.sessionId ?? null,
  }, ctx.tenantId);

  return { rootTaskId: root.id, goal: plan.goal, steps };
}

/** Children of a plan root, in priority order. */
export function getPlanSteps(rootTaskId: string, tenantId: string): TaskRecord[] {
  return listTasks({ tenant_id: tenantId, parent_task_id: rootTaskId });
}

export function isPlanRunActive(rootTaskId: string): boolean {
  return activeRuns.has(rootTaskId);
}

interface RestartPlanFromMetadataOptions {
  tenantId?: string;
  systemPrompt: string;
  fallbackClient?: LLMClient;
  normalizeStrandedSteps?: boolean;
}

export function restartPlanFromMetadata(
  rootTaskId: string,
  options: RestartPlanFromMetadataOptions,
): { started: boolean; reason?: string } {
  const tenantId = options.tenantId ?? 'default';
  const root = getById(rootTaskId, tenantId);
  if (!root) return { started: false, reason: 'plan not found' };

  const meta = loadTaskMetadata(rootTaskId);
  if (!meta?.chat_id) {
    updateStatus(rootTaskId, 'failed', tenantId, { reason: 'unresumable: missing plan metadata' });
    return { started: false, reason: 'no delivery metadata' };
  }
  if (root.attempts >= MAX_PLAN_RUN_ATTEMPTS) {
    updateStatus(rootTaskId, 'failed', tenantId, { reason: 'plan run attempt cap reached' });
    return { started: false, reason: 'attempt cap reached' };
  }

  if (options.normalizeStrandedSteps) {
    for (const step of getPlanSteps(rootTaskId, tenantId)) {
      if (step.status === 'running' || step.status === 'assigned') {
        updateStatus(step.id, 'ready', tenantId, { reason: 'normalized at boot resume' });
      }
    }
  }

  const executionModel = isExecutionModelSnapshot(meta.execution_model)
    ? meta.execution_model
    : undefined;
  let fallbackClient = options.fallbackClient;
  if (executionModel) {
    try {
      fallbackClient = getClient({
        ...executionModel,
        role: 'brain',
        tenantId,
        userId: meta.user_id,
      });
    } catch (err) {
      logger.warn({ rootTaskId, executionModel, err: err instanceof Error ? err.message : String(err) }, 'Failed to restore persisted execution model');
    }
  }

  const started = startDetachedPlanRun(rootTaskId, {
    tenantId,
    chatId: meta.chat_id,
    sessionId: meta.session_id,
    userId: meta.user_id,
    permissionLevel: isValidLevel(meta.permission_level ?? '') ? meta.permission_level as PermissionLevel : undefined,
    systemPrompt: meta.system_prompt || options.systemPrompt,
    fallbackClient,
    executionModel,
  });
  return started ? { started } : { started: false, reason: 'start refused' };
}

/**
 * Start (or resume) a detached run of a plan root. Returns immediately.
 * All observable effects flow through the DB and the event bus.
 */
export function startDetachedPlanRun(rootTaskId: string, ctx: PlanRunContext): boolean {
  if (activeRuns.has(rootTaskId)) {
    logger.warn({ rootTaskId }, 'Plan run already active in this process — not starting another');
    return false;
  }
  const root = getById(rootTaskId, ctx.tenantId);
  if (!root) {
    logger.error({ rootTaskId }, 'Plan root not found — cannot start run');
    return false;
  }
  if (root.attempts >= MAX_PLAN_RUN_ATTEMPTS) {
    updateStatus(rootTaskId, 'failed', ctx.tenantId, { reason: 'plan run attempt cap reached' });
    logger.warn({ rootTaskId, attempts: root.attempts }, 'Plan run attempt cap reached — marking failed');
    return false;
  }

  activeRuns.set(rootTaskId, { startedAt: Date.now(), chatId: ctx.chatId });
  incrementAttempts(rootTaskId, ctx.tenantId);
  updateStatus(rootTaskId, 'running', ctx.tenantId);

  void runPlan(rootTaskId, ctx)
    .catch((err) => {
      // runPlan handles its own errors; this catch is the last-resort guard so
      // a detached rejection can never become an unhandled promise crash.
      logger.error({
        rootTaskId,
        err: err instanceof Error ? err.message : String(err),
      }, 'Detached plan run crashed outside runPlan error handling');
      try {
        updateStatus(rootTaskId, 'failed', ctx.tenantId, { reason: 'detached run crashed' });
      } catch { /* DB unavailable — nothing left to do */ }
    })
    .finally(() => {
      activeRuns.delete(rootTaskId);
    });

  return true;
}

async function runPlan(rootTaskId: string, ctx: PlanRunContext): Promise<void> {
  const steps = getPlanSteps(rootTaskId, ctx.tenantId);
  const incomplete = steps.filter((step) => !TERMINAL.has(step.status));
  const startedAt = Date.now();
  const backgroundTurnId = planBackgroundTurnId(rootTaskId);

  logger.info({
    rootTaskId,
    totalSteps: steps.length,
    incompleteSteps: incomplete.length,
    chatId: ctx.chatId,
    sessionId: ctx.sessionId,
  }, 'Detached plan run starting');

  // Record the background Turn Envelope (Issue #626). This is a distinct,
  // origin='background' turn — never the foreground turn that spawned the plan.
  // Idempotent per (session, turnId), so a resume keeps the original started_at.
  if (ctx.sessionId) {
    try {
      startTurnEnvelope({
        tenantId: ctx.tenantId,
        sessionId: ctx.sessionId,
        chatId: ctx.chatId,
        turnId: backgroundTurnId,
        origin: 'background',
        startedAt,
      });
      broadcastPlanSessionActivity(ctx);
    } catch (err) {
      logger.warn({ rootTaskId, err: err instanceof Error ? err.message : String(err) }, 'Failed to start background turn envelope');
    }
  }

  let output = '';
  let failedMessage: string | null = null;

  if (incomplete.length > 0) {
    try {
      output = await executeDag(
        incomplete,
        ctx.systemPrompt,
        ctx.chatId,
        undefined,
        ctx.fallbackClient,
        backgroundTurnId,
        {
          useSubAgents: ctx.useSubAgents === true,
          subagentRuntimeSource: ctx.subagentRuntimeSource,
          subagentSessionKey: ctx.subagentSessionKey,
          sessionId: ctx.sessionId,
          toolContext: buildPlanToolContext(rootTaskId, ctx),
        },
      );
    } catch (err) {
      failedMessage = err instanceof Error ? err.message : String(err);
      logger.error({ rootTaskId, err: failedMessage }, 'Plan DAG execution threw');
    }
  }

  // Re-read child statuses from the DB — the single source of truth.
  const finalSteps = getPlanSteps(rootTaskId, ctx.tenantId);
  const completed = finalSteps.filter((s) => s.status === 'completed').length;
  const cancelled = finalSteps.filter((s) => s.status === 'cancelled').length;
  const failedOnly = finalSteps.filter((s) => s.status === 'failed').length;
  const blocked = finalSteps.filter((s) => s.status === 'blocked').length;
  const failed = failedOnly + cancelled;
  const unfinished = finalSteps.length - completed - failed - blocked;
  const planSucceeded = failedMessage === null && failed === 0 && blocked === 0 && unfinished === 0;

  updateStatus(rootTaskId, planSucceeded ? 'completed' : 'failed', ctx.tenantId, {
    completed_steps: completed,
    failed_steps: failedOnly,
    cancelled_steps: cancelled,
    blocked_steps: blocked,
    unfinished_steps: unfinished,
  });

  try {
    persistTaskResult(rootTaskId, {
      task_id: rootTaskId,
      success: planSucceeded,
      output: output || failedMessage || '(no output)',
      tokens_used: 0,
      elapsed_ms: Date.now() - startedAt,
      completed_at: new Date().toISOString(),
      metadata: { completed, failed: failedOnly, cancelled, blocked, unfinished, total: finalSteps.length },
    });
  } catch (err) {
    logger.warn({
      rootTaskId,
      err: err instanceof Error ? err.message : String(err),
    }, 'Failed to persist plan result');
  }

  emit({
    type: planSucceeded ? 'background_agent_complete' : 'background_agent_failed',
    taskId: rootTaskId,
    taskTitle: getById(rootTaskId, ctx.tenantId)?.title,
    totalTasks: finalSteps.length,
    completedTasks: completed,
    error: failedMessage
      ?? (failed > 0 ? `${failed} step(s) failed` : blocked > 0 ? `${blocked} step(s) blocked` : undefined),
    chatId: ctx.chatId,
    tenantId: ctx.tenantId,
    sessionId: ctx.sessionId,
  });

  // Terminalize the background Turn Envelope (Issue #626) before delivery so a
  // reload sees an honest completed/failed background turn, not a zombie active one.
  if (ctx.sessionId) {
    try {
      setTurnEnvelopeStatus({
        tenantId: ctx.tenantId,
        sessionId: ctx.sessionId,
        turnId: backgroundTurnId,
        status: planSucceeded ? 'completed' : 'failed',
      });
      broadcastPlanSessionActivity(ctx);
    } catch (err) {
      logger.warn({ rootTaskId, err: err instanceof Error ? err.message : String(err) }, 'Failed to terminalize background turn envelope');
    }
  }

  await deliverPlanCompletion(rootTaskId, ctx, {
    planSucceeded,
    completed,
    failed: failedOnly,
    cancelled,
    blocked,
    unfinished,
    total: finalSteps.length,
    output,
    failedMessage,
  });
}

interface PlanCompletionSummary {
  planSucceeded: boolean;
  completed: number;
  failed: number;
  cancelled: number;
  blocked: number;
  unfinished: number;
  total: number;
  output: string;
  failedMessage: string | null;
}

interface StepDetail {
  title: string;
  status: string;
  excerpt: string;
}

const STEP_EXCERPT_CHARS = 2000;
const TOTAL_EXCERPT_CHARS = 9000;

function hasCjk(text: string): boolean {
  return /[㐀-鿿]/.test(text);
}

/** Load per-step persisted results, capped so the summary prompt stays bounded. */
function collectStepDetails(rootTaskId: string, tenantId: string): StepDetail[] {
  let budget = TOTAL_EXCERPT_CHARS;
  return getPlanSteps(rootTaskId, tenantId).map((step) => {
    let excerpt = '';
    try {
      const persisted = loadTaskResult(step.id);
      const out = (persisted?.output ?? '').trim();
      if (out && budget > 0) {
        excerpt = out.slice(0, Math.min(STEP_EXCERPT_CHARS, budget));
        budget -= excerpt.length;
      }
    } catch { /* missing result files are fine — status still reported */ }
    return { title: step.title, status: step.status, excerpt };
  });
}

function statsLineFor(summary: PlanCompletionSummary): string {
  return `Steps: ${summary.completed}/${summary.total} completed`
    + (summary.cancelled > 0 ? `, ${summary.cancelled} cancelled` : '')
    + (summary.failed > 0 ? `, ${summary.failed} failed` : '')
    + (summary.blocked > 0 ? `, ${summary.blocked} blocked` : '')
    + (summary.unfinished > 0 ? `, ${summary.unfinished} unfinished` : '');
}

/**
 * Compact runtime-truth fallback when the Brain summary is unavailable:
 * status header + per-step state + a short tail excerpt, full outputs stay
 * in the execution panel. Replaces the old behavior of dumping every step's
 * raw output into the chat (11KB in one production run).
 */
function buildCompletionFallback(
  goal: string,
  summary: PlanCompletionSummary,
  stepDetails: StepDetail[],
): string {
  const isZh = hasCjk(goal);
  const header = summary.planSucceeded
    ? (isZh ? `计划完成:${goal}` : `Plan completed: ${goal}`)
    : (isZh ? `计划结束(有问题):${goal}` : `Plan finished with problems: ${goal}`);
  const stepLines = stepDetails.map((s, i) => `${i + 1}. [${s.status}] ${s.title}`);
  const lastWithOutput = summary.planSucceeded
    ? [...stepDetails].reverse().find((s) => s.status === 'completed' && s.excerpt)
    : undefined;
  const tail = lastWithOutput
    ? lastWithOutput.excerpt.slice(0, 600)
    : (summary.failedMessage ? `Execution error: ${summary.failedMessage}` : '');
  const panelHint = isZh ? '各步骤完整输出见执行面板。' : 'Full step outputs are available in the execution panel.';
  return [header, statsLineFor(summary), '', ...stepLines, tail ? '' : null, tail || null, '', panelHint]
    .filter((line): line is string => line !== null)
    .join('\n');
}

/**
 * Standard delivery shape (Claude Code / Codex pattern): completion re-invokes
 * the MODEL with the real persisted step results and the model writes the
 * user-facing report. Honesty holds because the inputs are runtime truth —
 * the model does expression, not invention. Falls back to the compact
 * template when no client is available or the call fails/returns empty.
 */
async function summarizePlanCompletionWithBrain(
  rootTaskId: string,
  ctx: PlanRunContext,
  goal: string,
  summary: PlanCompletionSummary,
  stepDetails: StepDetail[],
): Promise<string | null> {
  // Resolve client via the 'plan_summary' role (fallback chain: plan_summary → summary → brain).
  // ctx.fallbackClient is required — when absent the caller opted out of LLM summaries.
  // When present, try the plan_summary role first (may give a stronger/cheaper model);
  // fall back to ctx.fallbackClient if role resolution fails.
  if (!ctx.fallbackClient) return null;
  let summaryClient = ctx.fallbackClient;
  // Only use the plan_summary role when it is explicitly configured in model_router.roles.
  // This avoids silently replacing ctx.fallbackClient with a generic provider client and
  // preserves behavioral compatibility for callers that inject a specific client.
  const routerRoles = getConfig().model_router?.roles as Record<string, unknown> | undefined;
  const hasPlanSummaryRole = !!(routerRoles?.['plan_summary']);
  if (hasPlanSummaryRole) {
    try {
      const { client } = getClientForRole('plan_summary', ctx.fallbackClient);
      summaryClient = client;
    } catch {
      // Role resolution failed; use ctx.fallbackClient as-is
    }
  }
  const stepsBlock = stepDetails
    .map((s, i) => `### Step ${i + 1}: ${s.title}\nStatus: ${s.status}\n${s.excerpt || '(no persisted output)'}`)
    .join('\n\n');
  try {
    const response = await summaryClient.chat([
      {
        role: 'system',
        content: [
          'You are MOZI reporting the completion of a background plan to the user.',
          'Write ONLY the user-facing completion message, in the same language as the goal.',
          'Ground every statement in the step results below — never invent progress, results, or files.',
          'Artifacts created during the plan (reports, documents, pages) are already shown to the user',
          'as openable cards in the conversation — reference them by title only.',
          'NEVER print internal file paths (e.g. /data/... or "Persisted at ...") — the user cannot open',
          'them and they read as broken links. Keep it under 250 words.',
          'If steps failed or were cancelled, state that plainly first. No emoji.',
        ].join(' '),
      },
      {
        role: 'user',
        content: [
          `Goal: ${goal}`,
          `Outcome: ${statsLineFor(summary)}`,
          summary.failedMessage ? `Runner error: ${summary.failedMessage}` : null,
          '',
          'Step results:',
          stepsBlock,
        ].filter((line): line is string => line !== null).join('\n'),
      },
    ], defaultChatOptionsForSurface('plan_summary', {
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      taskId: rootTaskId,
      agentId: rootTaskId,
    }));
    const text = (response.content ?? '').trim();
    return text.length > 0 ? text : null;
  } catch (err) {
    logger.warn({
      rootTaskId: goal.slice(0, 60),
      err: err instanceof Error ? err.message : String(err),
    }, 'Brain plan-completion summary failed; falling back to compact template');
    return null;
  }
}

async function deliverPlanCompletion(
  rootTaskId: string,
  ctx: PlanRunContext,
  summary: PlanCompletionSummary,
): Promise<void> {
  const root = getById(rootTaskId, ctx.tenantId);
  const goal = root?.objective || root?.title || rootTaskId;
  const stepDetails = collectStepDetails(rootTaskId, ctx.tenantId);

  // Runtime-truth delivery: both paths report actual persisted task state.
  // The Brain path only rewords real results; it never narrates progress.
  const brainSummary = await summarizePlanCompletionWithBrain(rootTaskId, ctx, goal, summary, stepDetails);
  const content = brainSummary
    ? [
      summary.planSucceeded ? `Plan completed: ${goal}` : `Plan finished with problems: ${goal}`,
      statsLineFor(summary),
      '',
      brainSummary,
    ].join('\n')
    : buildCompletionFallback(goal, summary, stepDetails);

  try {
    const { deliverAssistantMessage } = await import('../channels/websocket.js');
    const { delivered } = deliverAssistantMessage({
      tenantId: ctx.tenantId,
      chatId: ctx.chatId,
      sessionId: ctx.sessionId,
      content,
      // Deliver under the plan's own background turn (Issue #626) so the completion
      // message can never backfill an unrelated foreground turn active right now.
      turnId: planBackgroundTurnId(rootTaskId),
      origin: 'background',
    });
    logger.info({ rootTaskId, delivered, sessionId: ctx.sessionId }, 'Plan completion delivered');
  } catch (err) {
    logger.error({
      rootTaskId,
      err: err instanceof Error ? err.message : String(err),
    }, 'Failed to deliver plan completion message');
  }
}

/**
 * Resume incomplete plans at process startup.
 *
 * Runs regardless of clean/unclean shutdown: a `docker compose restart` is a
 * clean SIGTERM but still strands a running plan. Crash recovery (index.ts)
 * has already normalized orphaned running/assigned tasks by the time this is
 * called; here we additionally normalize plan children stranded in 'running'
 * (clean-shutdown case) and restart the detached run.
 */
export function resumeIncompletePlans(options: {
  tenantId?: string;
  systemPrompt: string;
  fallbackClient?: LLMClient;
}): { resumed: string[]; skipped: Array<{ rootTaskId: string; reason: string }> } {
  const tenantId = options.tenantId ?? 'default';
  const resumed: string[] = [];
  const skipped: Array<{ rootTaskId: string; reason: string }> = [];

  const roots = listPlanRootTasks(tenantId, { activeOnly: true });
  for (const root of roots) {
    const result = restartPlanFromMetadata(root.id, {
      tenantId,
      systemPrompt: options.systemPrompt,
      fallbackClient: options.fallbackClient,
      normalizeStrandedSteps: true,
    });
    if (result.started) {
      resumed.push(root.id);
      const meta = loadTaskMetadata(root.id);
      logEvent('plan_resumed', 'task', root.id, {
        chat_id: meta?.chat_id,
        session_id: meta?.session_id ?? null,
        attempt: root.attempts + 1,
      }, tenantId);
    } else {
      skipped.push({ rootTaskId: root.id, reason: result.reason ?? 'start refused' });
    }
  }

  if (resumed.length > 0 || skipped.length > 0) {
    logger.info({ resumed, skipped }, 'Boot-time plan resume pass finished');
  }
  return { resumed, skipped };
}
