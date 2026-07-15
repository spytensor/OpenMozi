/**
 * Brain Engine — Core execution engine using pi-agent runtime.
 *
 * Replaces the hand-written while loop in handler.ts with pi-agent's
 * agentLoop, while preserving all Mozi-specific logic:
 * - Legacy XML tool call parsing (MiniMax)
 * - Output sanitization (think blocks, protocol leaks)
 * - Token budget tracking
 * - Streaming progress callbacks
 * - Recovery phases (self-heal, hard recovery, brain intervention)
 *
 * The handler.ts becomes a thin orchestrator that:
 * 1. Builds context
 * 2. Selects model
 * 3. Calls brainExecute()
 * 4. Handles post-execution (memory, title, session state)
 */

import pino from 'pino';
import { Agent } from '@mariozechner/pi-agent-core';
import type {
  AgentEvent,
  AgentMessage,
  BeforeToolCallContext,
  BeforeToolCallResult,
  AfterToolCallContext,
  AfterToolCallResult,
} from '@mariozechner/pi-agent-core';
import { streamSimple } from '@mariozechner/pi-ai';
import { IncompleteStreamError, type LLMClient, type ChatMessage, type ChatOptions, type ChatResponse, type ToolDefinition, type ModelThinkSetting } from './llm.js';
import type { ToolContext } from '../tools/types.js';
import { executeToolCalls, extractToolIntent, extractToolSkillName } from '../tools/executor.js';
import { getAllRegisteredTools } from '../tools/dynamic-registry.js';
import { emit as emitProgress } from '../progress/event-bus.js';
import type { ProgressCallback } from './brain-progress.js';
import type { ArtifactEvent } from '../artifacts/types.js';
import { ArtifactCoordinator } from '../artifacts/coordinator.js';
import { createTurnFileArtifactTracker, type TurnFileArtifactTracker } from '../artifacts/file-artifacts.js';
import { shouldSuggestDecomposition } from './complexity-hint.js';
import { buildActivePlanContext } from './plan-grounding.js';
import { hasDsmlToolCallMarkup, stripDsmlToolCallMarkup, extractLegacyToolCallsFromText } from './legacy-tool-parsing.js';
import { activeSkillScope, getActiveSkills } from '../skills/active-skills.js';
import { formatActiveSkillSection } from '../memory/context-slots.js';
import {
  buildCompletionGateBlockedResponse,
  buildCompletionGateFeedback,
  createCompletionGateState,
  evaluateCompletionGate,
  failForMissingDeliverables,
  recordCompletionGateBatch,
  type CompletionGateDecision,
  type CompletionGateState,
} from './completion-gates.js';
import { findMissingClaimedDeliverables } from './deliverable-verification.js';
import {
  shapePromptMessagesForExecution,
  shapeToolsForExecution,
  type ModelExecutionProfile,
  type TaskToolProfile,
} from '../tools/tool-shaping.js';
import { explicitlyRequestedArtifactContentType } from '../artifacts/content-contract.js';
import { artifactEventContentType } from './brain-artifacts.js';

const logger = pino({ name: 'mozi:brain-engine' });

// ---------------------------------------------------------------------------
// Output sanitization (moved from handler.ts)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Brain execution result
// ---------------------------------------------------------------------------

export interface BrainExecutionResult {
  responseText: string;
  model?: string;
  totalTokens?: number;
  toolIterations: number;
  recovered: boolean;
  recoveryMode?: 'self_heal' | 'hard_recovery' | 'brain_intervention' | 'fallback';
  completionGateDecision: CompletionGateDecision;
  completionGateBlocked?: boolean;
  modelExecutionProfile: ModelExecutionProfile;
  taskToolProfile: TaskToolProfile;
  exposedToolCount: number;
  toolSchemaTokensEstimate: number;
}

/**
 * Wrap an LLMClient so every chat/chatStream call inside the loop reports its
 * usage to the collector — including self-heal and hard-recovery calls —
 * without threading counters through each iteration helper.
 */
function withTurnChatOptions(
  client: LLMClient,
  collector: ChatOptions['usageCollector'],
  promptCacheKey: string | undefined,
): LLMClient {
  return {
    ...client,
    chat: (messages, options) => client.chat(messages, {
      ...options,
      ...(collector ? { usageCollector: collector } : {}),
      ...(promptCacheKey ? { promptCacheKey } : {}),
    }),
    chatStream: (messages, options) => client.chatStream(messages, {
      ...options,
      ...(collector ? { usageCollector: collector } : {}),
      ...(promptCacheKey ? { promptCacheKey } : {}),
    }),
  };
}

import {
  buildPreopenRenderableArtifact,
  createLiveArtifactInputTracker,
  emitTurnExecutionDetail,
  isRenderableArtifactEvent,
  parseToolArguments,
  resolveArtifactContract,
  userExplicitlyRequestsArtifact,
} from './brain-artifacts.js';
export { isRenderableArtifactEvent, resolveArtifactContract } from './brain-artifacts.js';
import { errorMessageForTerminalPatch, sanitizeVisibleOutput, throwIfAborted } from './brain-loop-policy.js';
import { executeNonStreamingTurn, executeRecovery, executeStreamingTurn, type TurnParams, type TurnResult } from './brain-turn-handlers.js';
export { sanitizeVisibleOutput } from './brain-loop-policy.js';

export interface BrainExecutionOptions {
  /** Mozi LLM client (Vercel AI SDK) */
  client: LLMClient;
  /** Prepared context messages (system + history + user) */
  contextMessages: ChatMessage[];
  /** Max output tokens for LLM call */
  maxTokens: number;
  /** Temperature for LLM call */
  temperature: number;
  /** Provider-specific reasoning mode/budget hint. */
  think?: ModelThinkSetting;
  /** Tool context for execution */
  toolContext: ToolContext;
  /** Authoritative tenant for discovery, execution, and turn telemetry. */
  tenantId: string;
  /** Progress callback for streaming/tool events */
  progress: ProgressCallback;
  /** Chat ID for logging */
  chatId: string;
  /** Turn ID for event correlation */
  turnId: string;
  /** Task ID for progress events */
  taskId: string;
  /** Channel type for format decisions */
  channelType?: string;
  /** Caller-provided cancellation signal for the active user turn. */
  abortSignal?: AbortSignal;
  /** Turn-scoped usage sink applied to every LLM call in the loop (observability). */
  usageCollector?: ChatOptions['usageCollector'];
  /** Selected model identity for capability-aware prompt and tool shaping. */
  modelProvider?: string;
  modelId?: string;
  /** Stable OpenAI prompt-cache routing key for this turn's immutable prefix. */
  promptCacheKey?: string;

  // Loop configuration
  maxIterations: number;
  llmCallTimeoutMs: number;
  maxLoopElapsedMs: number;
  repeatedBatchThreshold: number;
  maxFailedToolBatches: number;
  selfHealRetries: number;
  selfHealBackoffMs: number;
}

/**
 * Execute brain turn using Mozi's existing LLM client.
 *
 * This function replaces the while loop in handler.ts but keeps using
 * Mozi's LLMClient.chat/chatStream APIs for now. The pi-agent agentLoop
 * integration will be layered on top once the adapter is battle-tested.
 *
 * Key improvement over the old while loop:
 * - Extracted as a pure function (no handler state dependency)
 * - Testable in isolation
 * - Clear input/output contract
 * - Recovery logic is self-contained
 */
export async function brainExecute(opts: BrainExecutionOptions): Promise<BrainExecutionResult> {
  const {
    contextMessages, maxTokens, temperature,
    progress, chatId, turnId, taskId,
    abortSignal,
    maxIterations, llmCallTimeoutMs, maxLoopElapsedMs,
    repeatedBatchThreshold, maxFailedToolBatches,
    selfHealRetries, selfHealBackoffMs,
  } = opts;
  const client = opts.usageCollector || opts.promptCacheKey
    ? withTurnChatOptions(opts.client, opts.usageCollector, opts.promptCacheKey)
    : opts.client;

  if (!opts.tenantId.trim()) {
    throw new Error('Brain execution requires a tenantId');
  }
  if (opts.toolContext.tenantId && opts.toolContext.tenantId !== opts.tenantId) {
    throw new Error(`Brain tenant mismatch: turn=${opts.tenantId} toolContext=${opts.toolContext.tenantId}`);
  }

  const unlimitedIterations = maxIterations === 0;
  const loopStartAt = Date.now();
  const loopMessages: ChatMessage[] = [...contextMessages];
  const appendTurnSystemContext = (content: string): void => {
    let lastUserIndex = -1;
    for (let index = loopMessages.length - 1; index >= 0; index--) {
      if (loopMessages[index]?.role === 'user') {
        lastUserIndex = index;
        break;
      }
    }
    loopMessages.splice(lastUserIndex >= 0 ? lastUserIndex : loopMessages.length, 0, {
      role: 'system',
      content,
    });
  };
  throwIfAborted(abortSignal, 'Request cancelled');

  const userMsg = contextMessages[contextMessages.length - 1]?.content?.toString() ?? '';
  const artifactCapable = typeof opts.toolContext.onArtifact === 'function';
  const requiredArtifactContentType = explicitlyRequestedArtifactContentType(userMsg);

  // Plan grounding: re-read persisted plan state from the DB every turn so the
  // Brain never depends on conversation memory for plan progress. Injected
  // before the complexity hint — an already-running plan suppresses the
  // "consider decomposing" nudge (re-decomposing a live plan is the failure
  // mode we're guarding against).
  let hasActivePlanContext = false;
  if (chatId) {
    try {
      const planContext = buildActivePlanContext(chatId, opts.tenantId);
      if (planContext) {
        hasActivePlanContext = true;
        appendTurnSystemContext(planContext);
      }
    } catch {
      // Grounding is best-effort; a broken block must never break the turn.
    }
  }

  // Complexity policy: multi-phase requests must go through the durable plan
  // path. Inline execution of such tasks inside an interactive turn is exactly
  // the failure mode that loses all progress on turn limits/refresh/restart —
  // a real production incident shipped this way. The Brain still owns the
  // final call (prompt text is policy, not execution), but the policy is
  // stated firmly instead of as a take-it-or-leave-it hint.
  if (!hasActivePlanContext && shouldSuggestDecomposition(userMsg)) {
    appendTurnSystemContext('[Runtime policy] This request is a multi-phase task. Call decompose_task FIRST — before any other tool call or inline work — so the runtime executes it as a durable background plan with visible progress. Inline execution of multi-phase work is killed by turn limits and loses all progress. Only skip decompose_task if the task is genuinely trivial (one or two quick steps).');
  }
  if (artifactCapable && userExplicitlyRequestsArtifact(userMsg)) {
    const typeDirective = requiredArtifactContentType ? ` The required content_type is exactly "${requiredArtifactContentType}".` : '';
    appendTurnSystemContext(`[Artifact Contract] The user explicitly requested a renderable artifact such as SVG/HTML/chart. This channel supports artifacts. You must either call create_artifact with the full renderable content or explain briefly why you cannot produce it.${typeDirective} Never reply with only a promise that you will create it.`);
  }

  const repeatedToolBatches = new Map<string, number>();
  let loopStopReason: string | null = null;
  let consecutiveFailedToolBatches = 0;
  let recentToolFailureDetails: string[] = [];
  let truncationContinuations = 0;
  const maxTruncationContinuations = 3;
  const maxArtifactRepairAttempts = 1;
  let artifactRepairAttempts = 0;
  let responseText = '';
  let totalTokens = 0;
  const completionGateState = createCompletionGateState();
  let completionGateRejections = 0;
  const maxCompletionGateRejections = 2;
  const availableTools = getAllRegisteredTools(opts.tenantId);
  const toolShaping = shapeToolsForExecution({
    tools: availableTools,
    userText: userMsg,
    provider: opts.modelProvider,
    model: opts.modelId,
  });
  loopMessages.splice(0, loopMessages.length, ...shapePromptMessagesForExecution(loopMessages, toolShaping));
  const toolsDef = toolShaping.tools.length > 0 ? toolShaping.tools : undefined;
  const executionMetadata = {
    modelExecutionProfile: toolShaping.modelProfile,
    taskToolProfile: toolShaping.taskProfile,
    exposedToolCount: toolShaping.shapedCount,
    toolSchemaTokensEstimate: toolShaping.schemaTokensEstimate,
  };
  const resolveCompletionCandidate = (candidate: TurnResult, iterationIndex: number): BrainExecutionResult | null => {
    // Runtime fact check: if the final text claims deliverable files that do not
    // exist on disk, the gate FAILS regardless of what the model narrated — the
    // substrate, not the Brain, decides whether a deliverable was produced.
    const missingDeliverables = findMissingClaimedDeliverables(candidate.responseText, opts.toolContext.userId);
    const decision = failForMissingDeliverables(evaluateCompletionGate(completionGateState), missingDeliverables);
    if (decision.status === 'pending' || decision.status === 'failed') {
      if (completionGateRejections < maxCompletionGateRejections) {
        completionGateRejections += 1;
        loopMessages.push({ role: 'assistant', content: candidate.responseText });
        loopMessages.push({ role: 'user', content: buildCompletionGateFeedback(decision) });
        progress.onStreamEnd?.('');
        return null;
      }
      return {
        // Deliver what the model actually produced plus an honest caveat —
        // never swallow the deliverable or surface internal verifier actions.
        responseText: buildCompletionGateBlockedResponse(
          decision,
          userMsg,
          candidate.responseText,
          artifactCoordinator?.completedDeliverableTitles() ?? [],
        ),
        model: candidate.model,
        totalTokens,
        toolIterations: iterationIndex,
        recovered: true,
        recoveryMode: 'fallback',
        completionGateDecision: decision,
        completionGateBlocked: true,
        ...executionMetadata,
      };
    }
    return {
      responseText: candidate.responseText,
      model: candidate.model,
      totalTokens,
      toolIterations: iterationIndex,
      recovered: false,
      completionGateDecision: decision,
      ...executionMetadata,
    };
  };

  let renderableArtifactEmitted = false;
  const emittedArtifactContentTypes = new Set<string>();
  const baseToolContext: ToolContext = { ...opts.toolContext, tenantId: opts.tenantId, abortSignal };
  const turnRichArtifactPaths = baseToolContext.turnRichArtifactPaths ?? new Set<string>();
  const artifactCoordinator = baseToolContext.artifactCoordinator ?? (artifactCapable
    ? new ArtifactCoordinator(turnId, (event) => {
        if (isRenderableArtifactEvent(event)) {
          renderableArtifactEmitted = true;
          const contentType = artifactEventContentType(event);
          if (contentType) emittedArtifactContentTypes.add(contentType);
        }
        baseToolContext.onArtifact?.(event);
      })
    : undefined);
  const trackedToolContext: ToolContext = artifactCapable
    ? {
      ...baseToolContext,
      turnRichArtifactPaths,
      artifactCoordinator,
    }
    : baseToolContext;

  const fileArtifactTracker = artifactCapable
      ? createTurnFileArtifactTracker({
          activeRootPath: opts.toolContext.workspaceRootPath,
          userId: opts.toolContext.userId,
          richArtifactPaths: turnRichArtifactPaths,
          artifactCoordinator,
        })
    : undefined;
  await fileArtifactTracker?.captureBaseline();

  logger.debug({ chatId, userText: contextMessages[contextMessages.length - 1]?.content?.toString().slice(0, 80) }, 'Brain execution starting');

  let iteration = 0;
  try {
  while (unlimitedIterations || iteration < maxIterations) {
    throwIfAborted(abortSignal, 'Request cancelled');

    // Check loop timeout
    if (maxLoopElapsedMs > 0 && Date.now() - loopStartAt >= maxLoopElapsedMs) {
      loopStopReason = 'loop_timeout';
      logger.warn({ chatId, elapsedMs: Date.now() - loopStartAt, maxLoopElapsedMs }, 'Tool loop timed out');
      break;
    }

    const i = iteration;
    iteration += 1;

    // Calculate effective timeout
    const elapsedMs = Date.now() - loopStartAt;
    const remainingLoopMs = maxLoopElapsedMs > 0 ? Math.max(0, maxLoopElapsedMs - elapsedMs) : 0;
    const effectiveCallTimeoutMs = (() => {
      if (llmCallTimeoutMs <= 0 && maxLoopElapsedMs <= 0) return undefined;
      if (llmCallTimeoutMs > 0 && maxLoopElapsedMs > 0) return Math.max(500, Math.min(llmCallTimeoutMs, remainingLoopMs));
      if (llmCallTimeoutMs > 0) return llmCallTimeoutMs;
      return Math.max(500, remainingLoopMs);
    })();

    // --- LLM call (streaming or non-streaming) ---
    const isStreaming = !!progress.onStreamChunk;

    if (isStreaming) {
      const result = await executeStreamingTurn({
        client, loopMessages, maxTokens, temperature, think: opts.think, toolsDef,
        effectiveCallTimeoutMs, progress, chatId, turnId, taskId, i, loopStartAt,
        repeatedToolBatches, repeatedBatchThreshold, maxFailedToolBatches,
        consecutiveFailedToolBatches, recentToolFailureDetails,
        truncationContinuations, maxTruncationContinuations,
        toolContext: trackedToolContext, tenantId: opts.tenantId,
        userText: userMsg,
        artifactCapable,
        didEmitRenderableArtifact: () => renderableArtifactEmitted && (
          !requiredArtifactContentType || emittedArtifactContentTypes.has(requiredArtifactContentType)
        ),
        artifactRepairAttempts,
        maxArtifactRepairAttempts,
        abortSignal,
        fileArtifactTracker,
        completionGateState,
      });

      consecutiveFailedToolBatches = result.consecutiveFailedToolBatches;
      recentToolFailureDetails = result.recentToolFailureDetails;
      truncationContinuations = result.truncationContinuations;
      if (result.artifactRepairApplied) {
        artifactRepairAttempts += 1;
      }
      totalTokens += result.totalTokens ?? 0;

      if (result.action === 'final') {
        responseText = result.responseText;
        const resolved = resolveCompletionCandidate(result, i);
        if (resolved) return resolved;
        continue;
      }
      if (result.action === 'stop') {
        loopStopReason = result.stopReason ?? 'max_iterations';
        break;
      }
      // action === 'continue' — loop continues
    } else {
      const result = await executeNonStreamingTurn({
        client, loopMessages, maxTokens, temperature, think: opts.think, toolsDef,
        effectiveCallTimeoutMs, progress, chatId, turnId, taskId, i, loopStartAt,
        repeatedToolBatches, repeatedBatchThreshold, maxFailedToolBatches,
        consecutiveFailedToolBatches, recentToolFailureDetails,
        truncationContinuations, maxTruncationContinuations,
        toolContext: trackedToolContext, tenantId: opts.tenantId,
        userText: userMsg,
        artifactCapable,
        didEmitRenderableArtifact: () => renderableArtifactEmitted && (
          !requiredArtifactContentType || emittedArtifactContentTypes.has(requiredArtifactContentType)
        ),
        artifactRepairAttempts,
        maxArtifactRepairAttempts,
        abortSignal,
        fileArtifactTracker,
        completionGateState,
      });

      consecutiveFailedToolBatches = result.consecutiveFailedToolBatches;
      recentToolFailureDetails = result.recentToolFailureDetails;
      truncationContinuations = result.truncationContinuations;
      if (result.artifactRepairApplied) {
        artifactRepairAttempts += 1;
      }
      totalTokens += result.totalTokens ?? 0;

      if (result.action === 'final') {
        responseText = result.responseText;
        const resolved = resolveCompletionCandidate(result, i);
        if (resolved) return resolved;
        continue;
      }
      if (result.action === 'stop') {
        loopStopReason = result.stopReason ?? 'max_iterations';
        break;
      }
    }
  }

  // --- Recovery if no response ---
  if (!responseText) {
    throwIfAborted(abortSignal, 'Request cancelled');
    const gateDecision = evaluateCompletionGate(completionGateState);
    if (gateDecision.status === 'pending' || gateDecision.status === 'failed') {
      return {
        responseText: buildCompletionGateBlockedResponse(
          gateDecision,
          userMsg,
          undefined,
          artifactCoordinator?.completedDeliverableTitles() ?? [],
        ),
        totalTokens,
        toolIterations: iteration,
        recovered: true,
        recoveryMode: 'fallback',
        completionGateDecision: gateDecision,
        completionGateBlocked: true,
        ...executionMetadata,
      };
    }
    const recoveryResult = await executeRecovery({
      client, contextMessages, loopMessages, chatId, turnId,
      loopStopReason: loopStopReason ?? 'max_iterations',
      recentToolFailureDetails, selfHealRetries, selfHealBackoffMs,
      llmCallTimeoutMs, iteration, maxIterations, unlimitedIterations,
      repeatedBatchThreshold, maxFailedToolBatches,
    });
    return {
      responseText: recoveryResult.responseText,
      model: recoveryResult.model,
      totalTokens: totalTokens + (recoveryResult.totalTokens ?? 0),
      toolIterations: iteration,
      recovered: true,
      recoveryMode: recoveryResult.mode,
      completionGateDecision: gateDecision,
      ...executionMetadata,
    };
  }

  return {
    responseText,
    totalTokens,
    toolIterations: iteration,
    recovered: false,
    completionGateDecision: evaluateCompletionGate(completionGateState),
    ...executionMetadata,
  };
  } catch (err) {
    artifactCoordinator?.terminateAll('failed', errorMessageForTerminalPatch(err, 'Artifact generation interrupted'));
    throw err;
  } finally {
    artifactCoordinator?.terminateAll('closed');
  }
}
