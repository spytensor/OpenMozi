import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolCall } from './llm.js';

const hoisted = vi.hoisted(() => ({
  reportTimeoutAndMaybeTuneMock: vi.fn(() => ({
    applied: false,
    reason: 'not_applied',
    previousCallTimeoutMs: 10_000,
    previousLoopTimeoutMs: 40_000,
    previousInteractiveTurnTimeoutMs: 40_000,
    nextCallTimeoutMs: 10_000,
    nextLoopTimeoutMs: 40_000,
    nextInteractiveTurnTimeoutMs: 40_000,
  })),
}));

vi.mock('./autonomous-timeout.js', () => ({
  reportTimeoutAndMaybeTune: hoisted.reportTimeoutAndMaybeTuneMock,
}));

import {
  UnifiedExecutionKernel,
  sanitizeExecutionMessages,
} from './unified-execution-kernel.js';

function makeToolCall(name: string, args: Record<string, unknown> = {}): ToolCall {
  return {
    id: `${name}_${JSON.stringify(args)}`,
    type: 'function',
    function: {
      name,
      arguments: JSON.stringify(args),
    },
  };
}

describe('core/unified-execution-kernel', () => {
  beforeEach(() => {
    hoisted.reportTimeoutAndMaybeTuneMock.mockReset();
    hoisted.reportTimeoutAndMaybeTuneMock.mockReturnValue({
      applied: false,
      reason: 'not_applied',
      previousCallTimeoutMs: 10_000,
      previousLoopTimeoutMs: 40_000,
      previousInteractiveTurnTimeoutMs: 40_000,
      nextCallTimeoutMs: 10_000,
      nextLoopTimeoutMs: 40_000,
      nextInteractiveTurnTimeoutMs: 40_000,
    });
  });

  it.each(['gateway', 'dag', 'subagent'] as const)('emits shared tool-truth directives in %s mode', (scope) => {
    const kernel = new UnifiedExecutionKernel({
      scope,
      tenantId: 'default',
      chatId: `${scope}-chat`,
      maxIterations: 4,
      llmCallTimeoutMs: 10_000,
      maxLoopElapsedMs: 60_000,
      maxFailedToolBatches: 2,
      repeatedFailureStrategy: 'stop',
    });

    const decision = kernel.recordToolBatch(
      [makeToolCall('read_file', { path: 'src/app.ts' })],
      [{ toolCallId: 'read_file_1', toolName: 'read_file', status: 'success' }],
      [],
    );

    expect(decision.toolTruthDirective).toContain('Runtime tool outcomes');
    expect(decision.toolTruthDirective).toContain('read_file');
    expect(decision.recentFailureDetails).toEqual([]);
  });

  it.each(['gateway', 'dag', 'subagent'] as const)('detects loops consistently in %s mode', (scope) => {
    const kernel = new UnifiedExecutionKernel({
      scope,
      tenantId: 'default',
      chatId: `${scope}-chat`,
      maxIterations: 10,
      llmCallTimeoutMs: 10_000,
      maxLoopElapsedMs: 60_000,
      maxFailedToolBatches: 2,
      repeatedFailureStrategy: 'stop',
    });
    const repeatedCall = [makeToolCall('list_directory', { path: '/repo' })];
    const repeatedOutcome = [{ toolCallId: 'tc-1', toolName: 'list_directory', status: 'success' as const }];

    expect(kernel.recordToolBatch(repeatedCall, repeatedOutcome).loopHint).toBeNull();
    expect(kernel.recordToolBatch(repeatedCall, repeatedOutcome).loopHint).toBeNull();
    expect(kernel.recordToolBatch(repeatedCall, repeatedOutcome).loopHint).toContain('Loop detected');
    expect(kernel.recordToolBatch(repeatedCall, repeatedOutcome).stopReason).toBe('loop_detected');
  });

  it('uses strategy-specific repeated-failure handling', () => {
    const stopKernel = new UnifiedExecutionKernel({
      scope: 'dag',
      tenantId: 'default',
      chatId: 'dag-chat',
      maxIterations: 4,
      llmCallTimeoutMs: 10_000,
      maxLoopElapsedMs: 60_000,
      maxFailedToolBatches: 2,
      repeatedFailureStrategy: 'stop',
    });
    const injectKernel = new UnifiedExecutionKernel({
      scope: 'gateway',
      tenantId: 'default',
      chatId: 'gateway-chat',
      maxIterations: 4,
      llmCallTimeoutMs: 10_000,
      maxLoopElapsedMs: 60_000,
      maxFailedToolBatches: 2,
      repeatedFailureStrategy: 'inject_hint',
    });
    const toolCalls = [makeToolCall('shell_exec', { command: 'pwd' })];
    const outcomes = [{
      toolCallId: 'tc-shell',
      toolName: 'shell_exec',
      status: 'error' as const,
      errorSummary: 'permission denied',
    }];
    const failures = ['permission denied'];

    expect(stopKernel.recordToolBatch(toolCalls, outcomes, failures).stopReason).toBeUndefined();
    expect(stopKernel.recordToolBatch(toolCalls, outcomes, failures).stopReason).toBe('repeated_tool_failures');

    expect(injectKernel.recordToolBatch(toolCalls, outcomes, failures).failureHint).toBeNull();
    expect(injectKernel.recordToolBatch(toolCalls, outcomes, failures).failureHint).toContain('TOOL FAILURE HINT');
  });

  it('continues with the expanded budget when timeout autotuning succeeds', () => {
    hoisted.reportTimeoutAndMaybeTuneMock.mockReturnValue({
      applied: true,
      reason: 'timeout_budget_increased',
      previousCallTimeoutMs: 10_000,
      previousLoopTimeoutMs: 40_000,
      previousInteractiveTurnTimeoutMs: 40_000,
      nextCallTimeoutMs: 15_000,
      nextLoopTimeoutMs: 50_000,
      nextInteractiveTurnTimeoutMs: 50_000,
    });

    const kernel = new UnifiedExecutionKernel({
      scope: 'gateway',
      tenantId: 'default',
      chatId: 'timeout-chat',
      maxIterations: 5,
      llmCallTimeoutMs: 10_000,
      maxLoopElapsedMs: 40_000,
      maxFailedToolBatches: 2,
      repeatedFailureStrategy: 'inject_hint',
      resolveLoopTimeoutMs: nextLoopTimeoutMs => nextLoopTimeoutMs + 500,
    });

    const first = kernel.handleLlmTimeoutError('timeout waiting for model', 10_000);
    const second = kernel.handleLlmTimeoutError('timeout waiting for model', 10_000);

    expect(first.autotuneDirective).toContain('llm_call_timeout_ms=15000');
    expect(first.stopReason).toBeUndefined();
    expect(second.stopReason).toBeUndefined();
    expect(kernel.currentCallTimeoutMs).toBe(15_000);
    expect(kernel.currentLoopTimeoutMs).toBe(50_500);
  });

  it('stops after repeated call timeouts when no larger budget is available', () => {
    const kernel = new UnifiedExecutionKernel({
      scope: 'dag',
      tenantId: 'default',
      chatId: 'timeout-stop-chat',
      maxIterations: 5,
      llmCallTimeoutMs: 10_000,
      maxLoopElapsedMs: 40_000,
      maxFailedToolBatches: 2,
      repeatedFailureStrategy: 'stop',
    });

    expect(kernel.handleLlmTimeoutError('first timeout', 10_000).stopReason).toBeUndefined();
    expect(kernel.handleLlmTimeoutError('second timeout', 10_000).stopReason).toBe('loop_timeout');
  });

  it('treats the loop timeout as a renewable inactivity lease', () => {
    let now = 1_000;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const kernel = new UnifiedExecutionKernel({
      scope: 'dag',
      tenantId: 'default',
      chatId: 'lease-chat',
      maxIterations: 10,
      llmCallTimeoutMs: 500,
      maxLoopElapsedMs: 1_000,
      maxFailedToolBatches: 3,
      repeatedFailureStrategy: 'stop',
    });

    now = 1_900;
    kernel.recordToolBatch(
      [makeToolCall('read_file', { path: 'a' })],
      [{ toolCallId: 'read-1', toolName: 'read_file', status: 'success' }],
    );
    now = 2_500;
    expect(kernel.elapsedMs()).toBe(1_500);
    expect(kernel.beginIteration()).toMatchObject({ iteration: 1, remainingLoopMs: 400 });

    now = 2_901;
    expect(kernel.beginIteration()).toEqual({ stopReason: 'loop_timeout' });
    nowSpy.mockRestore();
  });

  it('sanitizes broken assistant/tool pairs before execution', () => {
    const sanitized = sanitizeExecutionMessages([
      {
        role: 'assistant',
        content: 'calling tool',
        tool_calls: [makeToolCall('read_file', { path: 'missing.ts' })],
      },
      {
        role: 'user',
        content: 'next instruction',
      },
    ]);

    expect(sanitized).toEqual([
      {
        role: 'assistant',
        content: 'calling tool',
      },
      {
        role: 'user',
        content: 'next instruction',
      },
    ]);
  });

  it('preserves message array identity when sanitization makes no changes', () => {
    const messages = [
      { role: 'system' as const, content: 'sys' },
      { role: 'assistant' as const, content: 'plain response' },
    ];

    const sanitized = sanitizeExecutionMessages(messages);

    expect(sanitized).toBe(messages);
  });

  it('does not mix timeout and tool-failure counters', () => {
    const kernel = new UnifiedExecutionKernel({
      scope: 'gateway',
      tenantId: 'default',
      chatId: 'mixed-failure-chat',
      maxIterations: 5,
      llmCallTimeoutMs: 10_000,
      maxLoopElapsedMs: 40_000,
      maxFailedToolBatches: 2,
      repeatedFailureStrategy: 'stop',
    });
    const toolCalls = [makeToolCall('shell_exec', { command: 'pwd' })];
    const outcomes = [{
      toolCallId: 'tc-shell',
      toolName: 'shell_exec',
      status: 'error' as const,
      errorSummary: 'permission denied',
    }];

    const timeoutDecision = kernel.handleLlmTimeoutError('timeout waiting for model', 10_000);
    const firstToolDecision = kernel.recordToolBatch(toolCalls, outcomes, ['permission denied']);
    const secondToolDecision = kernel.recordToolBatch(toolCalls, outcomes, ['permission denied']);

    expect(timeoutDecision.stopReason).toBeUndefined();
    expect(firstToolDecision.stopReason).toBeUndefined();
    expect(secondToolDecision.stopReason).toBe('repeated_tool_failures');
  });
});
