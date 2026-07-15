import type { ChatMessage, ToolCall } from './llm.js';
import { reportTimeoutAndMaybeTune } from './autonomous-timeout.js';
import {
  LoopDetector,
  buildConstraintRecoveryHintMessage,
  buildFailureHintMessage,
  sanitizeToolPairs,
  type LoopStopReason,
} from '../gateway/tool-loop-guards.js';

export type UnifiedExecutionScope = 'gateway' | 'dag' | 'subagent';
export type UnifiedExecutionStopReason = LoopStopReason | 'repeated_tool_failures' | 'max_iterations' | 'runtime_guard';
export type RepeatedFailureStrategy = 'inject_hint' | 'stop';

export interface UnifiedExecutionToolOutcome {
  toolCallId: string;
  toolName: string;
  status: 'success' | 'error';
  errorSummary?: string;
}

export interface UnifiedExecutionKernelOptions {
  scope: UnifiedExecutionScope;
  tenantId: string;
  chatId: string;
  taskId?: string;
  maxIterations: number;
  llmCallTimeoutMs: number;
  maxLoopElapsedMs: number;
  maxFailedToolBatches: number;
  repeatedFailureStrategy?: RepeatedFailureStrategy;
  resolveLoopTimeoutMs?: (nextLoopTimeoutMs: number) => number;
}

export interface UnifiedExecutionIterationBudget {
  iteration: number;
  elapsedMs: number;
  remainingLoopMs: number;
  effectiveCallTimeoutMs?: number;
}

export interface UnifiedExecutionTimeoutDecision {
  stopReason?: Extract<UnifiedExecutionStopReason, 'loop_timeout'>;
  autotuneDirective?: string;
  recentFailureDetails: string[];
}

export interface UnifiedExecutionToolBatchDecision {
  allFailed: boolean;
  recentFailureDetails: string[];
  toolTruthDirective?: string | null;
  constraintRecoveryHint?: string | null;
  failureHint?: string | null;
  loopHint?: string | null;
  stopReason?: Extract<UnifiedExecutionStopReason, 'loop_detected' | 'repeated_tool_failures'>;
}

export function createKernelSystemMessage(content: string): ChatMessage {
  return { role: 'system', content };
}

export function sanitizeExecutionMessages<T extends ChatMessage>(messages: T[]): T[] {
  return sanitizeToolPairs(messages) as T[];
}

export function buildToolTruthDirective(
  outcomes: UnifiedExecutionToolOutcome[],
): string | null {
  if (!outcomes || outcomes.length === 0) return null;

  const lines = outcomes.map((outcome) => {
    if (outcome.status === 'error') {
      return `- ${outcome.toolName} (${outcome.toolCallId}): error${outcome.errorSummary ? ` — ${outcome.errorSummary}` : ''}`;
    }
    return `- ${outcome.toolName} (${outcome.toolCallId}): success`;
  });

  return `[INTERNAL DIRECTIVE — not a user message] Runtime tool outcomes (ground truth):\n${lines.join('\n')}\nWhen you reference tool results, strictly follow this runtime truth. Do not claim a success was a failure or vice versa.`;
}

function buildTimeoutAutotuneDirective(nextCallTimeoutMs: number, nextLoopTimeoutMs: number): string {
  return [
    '[INTERNAL DIRECTIVE — not a user message]',
    `Runtime timeout budgets were auto-tuned after repeated timeouts. New limits: llm_call_timeout_ms=${nextCallTimeoutMs}, max_elapsed_ms=${nextLoopTimeoutMs}.`,
    'Continue with a more efficient approach and avoid repeating failed attempts.',
  ].join(' ');
}

export class UnifiedExecutionKernel {
  private iteration = 0;
  private readonly loopStartAt = Date.now();
  private lastActivityAt = this.loopStartAt;
  private llmCallTimeoutMs: number;
  private maxLoopElapsedMs: number;
  private consecutiveTimeouts = 0;
  private consecutiveFailedToolBatches = 0;
  private recentFailureDetails: string[] = [];
  private readonly loopDetector = new LoopDetector();
  private readonly repeatedFailureStrategy: RepeatedFailureStrategy;

  constructor(private readonly options: UnifiedExecutionKernelOptions) {
    this.llmCallTimeoutMs = options.llmCallTimeoutMs;
    this.maxLoopElapsedMs = options.maxLoopElapsedMs;
    this.repeatedFailureStrategy = options.repeatedFailureStrategy ?? 'inject_hint';
  }

  canContinue(): boolean {
    return this.options.maxIterations === 0 || this.iteration < this.options.maxIterations;
  }

  beginIteration(): UnifiedExecutionIterationBudget | { stopReason: 'loop_timeout' } {
    const elapsedMs = this.elapsedMs();
    const inactiveMs = this.inactiveMs();
    if (this.maxLoopElapsedMs > 0 && inactiveMs >= this.maxLoopElapsedMs) {
      const tuned = reportTimeoutAndMaybeTune({
        scope: this.options.scope,
        tenantId: this.options.tenantId,
        chatId: this.options.chatId,
        taskId: this.options.taskId,
        iteration: this.iteration + 1,
        observedLoopTimeoutMs: this.maxLoopElapsedMs,
        detail: 'loop_timeout_budget_exhausted',
      });
      this.applyAutotune(tuned.nextCallTimeoutMs, tuned.nextLoopTimeoutMs, tuned.applied);
      return { stopReason: 'loop_timeout' };
    }

    const remainingLoopMs = this.maxLoopElapsedMs > 0 ? Math.max(0, this.maxLoopElapsedMs - inactiveMs) : 0;
    const effectiveCallTimeoutMs = (() => {
      if (this.llmCallTimeoutMs <= 0 && this.maxLoopElapsedMs <= 0) return undefined;
      if (this.llmCallTimeoutMs > 0 && this.maxLoopElapsedMs > 0) {
        return Math.max(500, Math.min(this.llmCallTimeoutMs, remainingLoopMs));
      }
      if (this.llmCallTimeoutMs > 0) return this.llmCallTimeoutMs;
      return Math.max(500, remainingLoopMs);
    })();

    this.iteration += 1;
    return {
      iteration: this.iteration,
      elapsedMs,
      remainingLoopMs,
      effectiveCallTimeoutMs,
    };
  }

  handleLlmTimeoutError(detail: string, observedCallTimeoutMs?: number): UnifiedExecutionTimeoutDecision {
    this.recentFailureDetails = [detail.slice(0, 280)];
    this.consecutiveTimeouts += 1;
    this.consecutiveFailedToolBatches = 0;

    const tuned = reportTimeoutAndMaybeTune({
      scope: this.options.scope,
      tenantId: this.options.tenantId,
      chatId: this.options.chatId,
      taskId: this.options.taskId,
      iteration: this.iteration,
      observedCallTimeoutMs,
      observedLoopTimeoutMs: this.maxLoopElapsedMs,
      detail,
    });
    this.applyAutotune(tuned.nextCallTimeoutMs, tuned.nextLoopTimeoutMs, tuned.applied);
    // A successful tune is the recovery action: give the next call the larger
    // budget instead of increasing the limit and terminating in the same
    // branch. Repeated timeouts with no further room to tune still stop.
    if (tuned.applied) this.consecutiveTimeouts = 0;

    return {
      stopReason: !tuned.applied && this.consecutiveTimeouts >= this.options.maxFailedToolBatches
        ? 'loop_timeout'
        : undefined,
      autotuneDirective: tuned.applied
        ? buildTimeoutAutotuneDirective(tuned.nextCallTimeoutMs, this.maxLoopElapsedMs)
        : undefined,
      recentFailureDetails: [...this.recentFailureDetails],
    };
  }

  recordToolBatch(toolCalls: ToolCall[], outcomes: UnifiedExecutionToolOutcome[], failureDetails: string[] = []): UnifiedExecutionToolBatchDecision {
    // A completed tool batch is observable liveness. Renew the inactivity
    // lease even when the batch failed; repeated-failure and loop guards below
    // independently stop work that is active but unproductive.
    if (outcomes.length > 0) this.recordActivity();
    const allFailed = outcomes.length > 0 && outcomes.every(outcome => outcome.status === 'error');
    const normalizedFailureDetails = failureDetails
      .map(detail => detail.trim())
      .filter(detail => detail.length > 0)
      .slice(0, 2);
    this.consecutiveTimeouts = 0;

    if (allFailed) {
      this.consecutiveFailedToolBatches += 1;
      this.recentFailureDetails = normalizedFailureDetails;
    } else {
      this.consecutiveFailedToolBatches = 0;
      this.recentFailureDetails = [];
    }

    let stopReason: UnifiedExecutionToolBatchDecision['stopReason'];
    let loopHint: string | null = null;
    const loopPattern = this.loopDetector.record(toolCalls);
    if (loopPattern) {
      if (this.loopDetector.hintWasInjected) {
        stopReason = 'loop_detected';
      } else {
        loopHint = this.loopDetector.getHintOnce();
      }
    }

    let failureHint: string | null = null;
    if (allFailed && this.consecutiveFailedToolBatches >= this.options.maxFailedToolBatches) {
      if (this.repeatedFailureStrategy === 'stop') {
        stopReason ??= 'repeated_tool_failures';
      } else {
        failureHint = buildFailureHintMessage(this.consecutiveFailedToolBatches, this.recentFailureDetails);
        this.consecutiveFailedToolBatches = 0;
      }
    }

    return {
      allFailed,
      recentFailureDetails: [...this.recentFailureDetails],
      toolTruthDirective: buildToolTruthDirective(outcomes),
      constraintRecoveryHint: allFailed ? buildConstraintRecoveryHintMessage(this.recentFailureDetails) : null,
      failureHint,
      loopHint,
      stopReason,
    };
  }

  stopReasonAfterLoop(): Extract<UnifiedExecutionStopReason, 'max_iterations' | 'runtime_guard'> {
    return this.options.maxIterations > 0 ? 'max_iterations' : 'runtime_guard';
  }

  elapsedMs(): number {
    return Date.now() - this.loopStartAt;
  }

  /** Renew the execution lease after observable model/tool progress. */
  recordActivity(): void {
    this.lastActivityAt = Date.now();
  }

  inactiveMs(): number {
    return Date.now() - this.lastActivityAt;
  }

  get currentLoopTimeoutMs(): number {
    return this.maxLoopElapsedMs;
  }

  get currentCallTimeoutMs(): number {
    return this.llmCallTimeoutMs;
  }

  get currentIteration(): number {
    return this.iteration;
  }

  getRecentFailureDetails(): string[] {
    return [...this.recentFailureDetails];
  }

  private applyAutotune(nextCallTimeoutMs: number, nextLoopTimeoutMs: number, applied: boolean): void {
    if (!applied) return;
    this.llmCallTimeoutMs = nextCallTimeoutMs;
    this.maxLoopElapsedMs = this.options.resolveLoopTimeoutMs
      ? this.options.resolveLoopTimeoutMs(nextLoopTimeoutMs)
      : nextLoopTimeoutMs;
  }
}
