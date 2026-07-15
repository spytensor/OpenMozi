import pino from 'pino';
import { IncompleteStreamError, type LLMClient, type ChatMessage, type ChatResponse, type ToolDefinition, type ModelThinkSetting } from './llm.js';
import type { ToolContext } from '../tools/types.js';
import { executeToolCalls, extractToolIntent, extractToolSkillName } from '../tools/executor.js';
import { emit as emitProgress } from '../progress/event-bus.js';
import type { ProgressCallback } from './brain-progress.js';
import { createTurnFileArtifactTracker, type TurnFileArtifactTracker } from '../artifacts/file-artifacts.js';
import { activeSkillScope, getActiveSkills } from '../skills/active-skills.js';
import { formatActiveSkillSection } from '../memory/context-slots.js';
import { evaluateCompletionGate, recordCompletionGateBatch, type CompletionGateState } from './completion-gates.js';
import { extractLegacyToolCallsFromText, hasDsmlToolCallMarkup, stripDsmlToolCallMarkup } from './legacy-tool-parsing.js';
import {
  buildPreopenRenderableArtifact,
  createLiveArtifactInputTracker,
  emitTurnExecutionDetail,
  parseToolArguments,
  resolveArtifactContract,
} from './brain-artifacts.js';
import { buildAbortError, errorMessageForTerminalPatch, hasLegacyToolCallProtocol, sanitizeVisibleOutput, throwIfAborted } from './brain-loop-policy.js';

const logger = pino({ name: 'mozi:brain-engine' });

// ---------------------------------------------------------------------------
// Internal: streaming turn execution
// ---------------------------------------------------------------------------

export interface TurnParams {
  client: LLMClient;
  loopMessages: ChatMessage[];
  maxTokens: number;
  temperature: number;
  think?: ModelThinkSetting;
  toolsDef: ToolDefinition[] | undefined;
  effectiveCallTimeoutMs: number | undefined;
  progress: ProgressCallback;
  chatId: string;
  turnId: string;
  taskId: string;
  i: number;
  loopStartAt: number;
  repeatedToolBatches: Map<string, number>;
  repeatedBatchThreshold: number;
  maxFailedToolBatches: number;
  consecutiveFailedToolBatches: number;
  recentToolFailureDetails: string[];
  truncationContinuations: number;
  maxTruncationContinuations: number;
  toolContext: ToolContext;
  tenantId: string;
  userText: string;
  artifactCapable: boolean;
  didEmitRenderableArtifact: () => boolean;
  artifactRepairAttempts: number;
  maxArtifactRepairAttempts: number;
  abortSignal?: AbortSignal;
  fileArtifactTracker?: TurnFileArtifactTracker;
  completionGateState: CompletionGateState;
}

export interface TurnResult {
  action: 'continue' | 'final' | 'stop';
  responseText: string;
  model?: string;
  totalTokens?: number;
  stopReason?: string;
  artifactRepairApplied?: boolean;
  consecutiveFailedToolBatches: number;
  recentToolFailureDetails: string[];
  truncationContinuations: number;
}

function buildToolBatchSignature(toolCalls: Array<{ function: { name: string; arguments: string } }>): string {
  return toolCalls
    .map(tc => `${tc.function.name}:${tc.function.arguments}`)
    .sort((a, b) => a.localeCompare(b))
    .join('|');
}

const REPEATED_TOOL_LOOP_READ_ONLY_TOOLS = new Set([
  'process_status',
  'process_output',
  'read_file',
  'list_directory',
  'web_search',
  'web_fetch',
  'browser_extract',
  'browser_assert',
  'list_tasks',
  'get_task',
  'list_runtime_skills',
  'list_cron_tasks',
]);

function buildRepeatableToolBatchSignature(toolCalls: Array<{ function: { name: string; arguments: string } }>): string | null {
  const sideEffectingCalls = toolCalls.filter(call => !REPEATED_TOOL_LOOP_READ_ONLY_TOOLS.has(call.function.name));
  if (sideEffectingCalls.length === 0) return null;
  return buildToolBatchSignature(sideEffectingCalls);
}

function usageTotal(response: ChatResponse): number {
  return response.usage.input_tokens + response.usage.output_tokens;
}

function asString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  return String(value);
}

function renderActiveSkillsSystemSection(skills: Array<{ name: string; description: string; instructions: string }>): string {
  return `## Active Skills\n\n${skills.map(formatActiveSkillSection).join('\n\n')}`;
}

function replaceActiveSkillsSystemSection(content: string, nextSection: string): string {
  const header = '## Active Skills';
  const headerMatch = /^## Active Skills$/m.exec(content);
  if (!headerMatch || headerMatch.index === undefined) {
    return `${content.trimEnd()}\n\n${nextSection}`.trim();
  }
  const start = headerMatch.index;
  const restStart = start + header.length;
  const rest = content.slice(restStart);
  const nextHeaderRelative = rest.search(/\n## /);
  const end = nextHeaderRelative === -1 ? content.length : restStart + nextHeaderRelative;
  return `${content.slice(0, start).trimEnd()}\n\n${nextSection}\n\n${content.slice(end).trimStart()}`.trim();
}

function injectLoadedActiveSkill(loopMessages: ChatMessage[], toolContext: ToolContext, result: { tool_name?: string; is_error?: boolean; skillName?: string }): void {
  if (result.is_error || result.tool_name !== 'use_skill' || !result.skillName) return;
  const scope = activeSkillScope({
    tenantId: toolContext.tenantId,
    sessionId: toolContext.sessionId,
    chatId: toolContext.chatId,
  });
  if (!scope) return;
  const activeSkills = getActiveSkills(scope);
  if (activeSkills.length === 0) return;
  const nextSection = renderActiveSkillsSystemSection(activeSkills);
  const systemMessage = loopMessages.find(message => message.role === 'system');
  if (systemMessage) {
    const currentContent = typeof systemMessage.content === 'string' ? systemMessage.content : '';
    systemMessage.content = replaceActiveSkillsSystemSection(currentContent, nextSection);
    return;
  }
  loopMessages.unshift({
    role: 'system',
    content: nextSection,
  });
}

function toolTerminalErrorMessage(abortSignal: AbortSignal | undefined, err: unknown): string {
  if (abortSignal?.aborted) {
    return errorMessageForTerminalPatch(buildAbortError(abortSignal, 'Request cancelled'), 'Tool execution cancelled');
  }
  return `Tool execution interrupted: ${errorMessageForTerminalPatch(err, 'no result returned')}`;
}

const FILE_ARTIFACT_SCAN_BOUNDARY_TOOLS = new Set([
  'shell_exec',
  'shell_exec_bg',
  'process_status',
  'process_output',
  'write_file',
  'edit_file',
  'append_file',
  'delegate_coding_task',
  'run_task',
  'repair_task',
  'read_task_result',
  'run_tests',
  'improve_code',
  'connector_execute',
  'create_background_task',
]);

function shouldScanFileArtifactsAfterBatch(toolCalls: Array<{ function: { name: string } }>): boolean {
  return toolCalls.some(call => FILE_ARTIFACT_SCAN_BOUNDARY_TOOLS.has(call.function.name));
}

async function handleToolCalls(
  params: TurnParams,
  toolCalls: Array<{ id: string; type: string; function: { name: string; arguments: string } }>,
  rawContent: string,
  reasoningContent?: string,
): Promise<TurnResult> {
  const { loopMessages, progress, chatId, turnId, taskId, i, repeatedToolBatches, repeatedBatchThreshold, maxFailedToolBatches, tenantId } = params;
  let { consecutiveFailedToolBatches, recentToolFailureDetails } = params;
  throwIfAborted(params.abortSignal, 'Request cancelled');

  const batchSignature = buildRepeatableToolBatchSignature(toolCalls);
  if (batchSignature) {
    const seen = (repeatedToolBatches.get(batchSignature) ?? 0) + 1;
    repeatedToolBatches.set(batchSignature, seen);
    if (seen >= repeatedBatchThreshold) {
      return { action: 'stop', responseText: '', stopReason: 'repeated_tool_loop', consecutiveFailedToolBatches, recentToolFailureDetails, truncationContinuations: params.truncationContinuations };
    }
  }

  const pendingToolResults = new Map<string, { id: string; function: { name: string } }>();
  const toolCallById = new Map(toolCalls.map(call => [call.id, call]));
  let interruptedBy: unknown;
  const emitMissingToolResults = (): void => {
    if (pendingToolResults.size === 0) return;
    const error = toolTerminalErrorMessage(params.abortSignal, interruptedBy);
    for (const tc of pendingToolResults.values()) {
      pendingToolResults.delete(tc.id);
      progress.onToolEnd(tc.function.name);
      emitProgress({
        type: 'tool_result',
        taskId,
        toolName: tc.function.name,
        toolCallId: tc.id,
        elapsed_ms: 0,
        error,
        chatId,
        tenantId,
        sessionId: params.toolContext.sessionId,
        turnId,
      });
    }
  };

  try {
  loopMessages.push({
    role: 'assistant',
    content: rawContent || '',
    reasoning_content: reasoningContent,
    tool_calls: toolCalls as any,
  });

  for (const tc of toolCalls) {
    progress.onToolStart(tc.function.name);
    emitProgress({
      type: 'tool_call',
      taskId,
      toolName: tc.function.name,
      toolCallId: tc.id,
      intent: extractToolIntent(tc.function.name, tc.function.arguments),
      skillName: extractToolSkillName(tc.function.name, tc.function.arguments),
      chatId,
      tenantId,
      sessionId: params.toolContext.sessionId,
      turnId,
    });
    pendingToolResults.set(tc.id, tc);

    // Pre-open renderable artifact cards as soon as tool-call arguments are
    // available. For write_file/create_artifact, the HTML/SVG/code is already
    // in the arguments before the filesystem/runtime tool finishes, so the UI
    // can render immediately and later receive a completion patch.
    if (params.toolContext.artifactCoordinator) {
      const fnArgs = parseToolArguments(tc.function.arguments);
      const preopen = buildPreopenRenderableArtifact(tc.function.name, fnArgs);
      if (preopen) {
        const title = preopen.title || 'Generating artifact';
        const artifactData = preopen.contentType === 'markdown' || preopen.contentType === 'document'
          ? { markdown: preopen.code, content_type: 'markdown', live_preview: true, meta: { turn_id: params.turnId } }
          : { code: preopen.code, content_type: preopen.contentType, live_preview: true, meta: { turn_id: params.turnId } };
        params.toolContext.artifactCoordinator.openOrGet(tc.id, {
          plugin_id: preopen.contentType === 'markdown' || preopen.contentType === 'document' ? 'document_v1' : 'sandpack_v1',
          title,
          content_type: preopen.contentType === 'document' ? 'markdown' : preopen.contentType,
          status: 'running',
          collapsed_by_default: false,
          fallback_text: preopen.fallbackText,
          data: artifactData,
        });
      }
    }
  }

  const toolStart = Date.now();
  throwIfAborted(params.abortSignal, 'Request cancelled');
  // Pass the SHARED turn context (no spread): approval side-effects written by
  // the executor — elevated permissionLevel, the elevation dedup cache,
  // writeConfirmedByElevation, scope grants — must survive into later tool
  // batches of the same turn. A per-batch copy caused one elevation prompt per
  // batch even after the user approved (8 prompts in one production turn).
  params.toolContext.loopIteration = params.i;
  const results = await executeToolCalls(toolCalls as any, params.toolContext);
  throwIfAborted(params.abortSignal, 'Request cancelled');
  const toolElapsed = Date.now() - toolStart;
  recordCompletionGateBatch(
    params.completionGateState,
    toolCalls,
    results,
    params.toolContext.turnRichArtifactPaths,
  );

  for (const result of results) {
    loopMessages.push({
      role: 'tool',
      content: result.content,
      tool_call_id: result.tool_call_id,
      tool_name: result.tool_name,
    });
  }
  for (const result of results) {
    injectLoadedActiveSkill(loopMessages, params.toolContext, result);
  }

  const allFailed = results.length > 0 && results.every(r => r.is_error);
  if (allFailed) {
    consecutiveFailedToolBatches += 1;
    recentToolFailureDetails = results
      .map(r => asString(r.content).trim())
      .filter(c => c.length > 0)
      .slice(0, 2);
  } else {
    consecutiveFailedToolBatches = 0;
    recentToolFailureDetails = [];
  }

  for (const result of results) {
    pendingToolResults.delete(result.tool_call_id);
    const originalToolCall = toolCallById.get(result.tool_call_id);
    const resultToolName = result.tool_name ?? originalToolCall?.function.name ?? 'tool';
    progress.onToolEnd(resultToolName);
    emitProgress({
      type: 'tool_result',
      taskId,
      toolName: resultToolName,
      toolCallId: result.tool_call_id,
      result: result.is_error ? undefined : asString(result.content).slice(0, 200),
      elapsed_ms: toolElapsed,
      error: result.is_error ? asString(result.content).slice(0, 280) : undefined,
      skillName: result.skillName,
      skillDescription: result.skillDescription,
      skillLoadOutcome: result.skillLoadOutcome,
      skillMissingBins: result.skillMissingBins,
      skillMissingEnv: result.skillMissingEnv,
      skillLoadError: result.skillLoadError,
      chatId,
      tenantId,
      sessionId: params.toolContext.sessionId,
      turnId,
    });
    if (!result.is_error && originalToolCall) {
      const skillName = extractToolSkillName(originalToolCall.function.name, originalToolCall.function.arguments);
      if (skillName) {
        params.fileArtifactTracker?.noteSkillUse(skillName);
      }
    }
  }

  if (params.fileArtifactTracker) {
    const producedFiles = results.flatMap(result => result.is_error ? [] : [
      ...(result.produced_files ?? []),
    ]);
    await params.fileArtifactTracker.emitPaths(producedFiles);
    if (shouldScanFileArtifactsAfterBatch(toolCalls)) {
      await params.fileArtifactTracker.scanAndEmit();
    }
  }

  logger.info({ chatId, iteration: i + 1, toolCalls: toolCalls.map(tc => tc.function.name) }, 'Tool calls executed');

  // Runtime-enforced turn handoff (constitution: prompt text is policy, not
  // execution). A successful ends_turn result — decompose_task started a
  // detached background plan — finalizes the turn NOW. Relying on the ack
  // text alone let a weak model re-execute the entire plan in the foreground,
  // doubling cost and racing the background delivery.
  const endsTurn = results.find(r => r.ends_turn && !r.is_error);
  if (endsTurn) {
    const handoff = endsTurn.ends_turn_message?.trim() || asString(endsTurn.content);
    logger.info({ chatId, iteration: i + 1, tool: endsTurn.tool_name }, 'Tool result ended the turn (detached handoff)');
    return {
      action: 'final',
      responseText: handoff,
      consecutiveFailedToolBatches,
      recentToolFailureDetails,
      truncationContinuations: params.truncationContinuations,
    };
  }

  if (consecutiveFailedToolBatches >= maxFailedToolBatches) {
    return { action: 'stop', responseText: '', stopReason: 'repeated_tool_failures', consecutiveFailedToolBatches, recentToolFailureDetails, truncationContinuations: params.truncationContinuations };
  }

  return { action: 'continue', responseText: '', consecutiveFailedToolBatches, recentToolFailureDetails, truncationContinuations: params.truncationContinuations };
  } catch (err) {
    interruptedBy = err;
    throw err;
  } finally {
    emitMissingToolResults();
  }
}

export async function executeStreamingTurn(params: TurnParams): Promise<TurnResult> {
  const { client, loopMessages, maxTokens, temperature, think, toolsDef, effectiveCallTimeoutMs, progress, chatId, i, loopStartAt } = params;
  let { truncationContinuations } = params;
  throwIfAborted(params.abortSignal, 'Request cancelled');
  emitTurnExecutionDetail(params, i === 0 ? 'Thinking through the request' : 'Organizing tool results');

  let accumulated = '';
  const gateAtCallStart = evaluateCompletionGate(params.completionGateState);
  const holdVisibleOutput = gateAtCallStart.status === 'pending' || gateAtCallStart.status === 'failed';
  let finalResponse: ChatResponse | null = null;
  const liveArtifactInputs = createLiveArtifactInputTracker(params);
  let abortTerminalEmitted = false;
  const failArtifactsForAbort = (): void => {
    if (abortTerminalEmitted) return;
    abortTerminalEmitted = true;
    const err = params.abortSignal?.aborted
      ? buildAbortError(params.abortSignal, 'Request cancelled')
      : new Error('Request cancelled');
    const reason = errorMessageForTerminalPatch(err, 'Artifact generation interrupted');
    liveArtifactInputs.failAll(reason);
  };
  let removeAbortListener: (() => void) | undefined;
  if (params.abortSignal) {
    if (params.abortSignal.aborted) {
      failArtifactsForAbort();
    } else {
      params.abortSignal.addEventListener('abort', failArtifactsForAbort, { once: true });
      removeAbortListener = () => params.abortSignal?.removeEventListener('abort', failArtifactsForAbort);
    }
  }

  let stream;
  try {
    try {
      stream = client.chatStream(
        loopMessages,
        {
          max_tokens: maxTokens,
          temperature,
          think,
          tools: toolsDef,
          timeout_ms: effectiveCallTimeoutMs,
          execution_scope: 'interactive',
          abort_signal: params.abortSignal,
          billing: {
            tenantId: params.tenantId,
            userId: params.toolContext.userId,
            taskId: params.taskId,
            agentId: params.toolContext.agentId,
          },
        },
      );
    } catch (err) {
      if (params.abortSignal?.aborted) throw buildAbortError(params.abortSignal, 'Request cancelled');
      const errMsg = err instanceof Error ? err.message : String(err);
      const isTimeout = errMsg.includes('abort') || errMsg.includes('timeout') || (err instanceof Error && err.name === 'AbortError');
      if (isTimeout) {
        logger.warn({ chatId, iteration: i, elapsed_ms: Date.now() - loopStartAt }, 'LLM stream timed out');
        return {
          action: (params.consecutiveFailedToolBatches + 1 >= params.maxFailedToolBatches) ? 'stop' : 'continue',
          responseText: '',
          stopReason: 'loop_timeout',
          consecutiveFailedToolBatches: params.consecutiveFailedToolBatches + 1,
          recentToolFailureDetails: params.recentToolFailureDetails,
          truncationContinuations,
        };
      }
      throw err;
    }

    try {
      for await (const chunk of stream) {
        throwIfAborted(params.abortSignal, 'Request cancelled');
        if (chunk.type === 'text' && chunk.text) {
          accumulated += chunk.text;
          const visible = sanitizeVisibleOutput(accumulated);
          if (!holdVisibleOutput && visible.length > 0 && !hasLegacyToolCallProtocol(accumulated)) {
            progress.onStreamChunk!(visible);
          }
        }
        if (chunk.type === 'tool_input_start') {
          liveArtifactInputs.start(chunk.toolCallId, chunk.toolName);
          // Real presence signal while the model composes a (possibly very
          // large) tool call — e.g. writing a whole document into file_write
          // arguments. Without it the UI has nothing but a generic fallback
          // for the entire composition window.
          emitProgress({
            type: 'tool_composing',
            composingPhase: 'start',
            toolName: chunk.toolName,
            toolCallId: chunk.toolCallId,
            chatId,
            tenantId: params.tenantId,
            sessionId: params.toolContext.sessionId,
            turnId: params.turnId,
          });
        }
        if (chunk.type === 'tool_input_delta') {
          liveArtifactInputs.append(chunk.toolCallId, chunk.delta);
        }
        if (chunk.type === 'tool_input_end') {
          liveArtifactInputs.end(chunk.toolCallId);
          emitProgress({
            type: 'tool_composing',
            composingPhase: 'end',
            toolCallId: chunk.toolCallId,
            chatId,
            tenantId: params.tenantId,
            sessionId: params.toolContext.sessionId,
            turnId: params.turnId,
          });
        }
        if (chunk.type === 'done' && chunk.response) {
          finalResponse = chunk.response;
        }
      }
      throwIfAborted(params.abortSignal, 'Request cancelled');
      liveArtifactInputs.flushAll();
    } catch (err) {
      liveArtifactInputs.failAll(errorMessageForTerminalPatch(err, 'Artifact generation interrupted'));
      throw err;
    }
  } finally {
    removeAbortListener?.();
  }

  if (!finalResponse) {
    throw new IncompleteStreamError('LLM stream ended without done chunk', {
      content: accumulated,
      usage: { input_tokens: 0, output_tokens: 0 },
      model: client.provider,
      stop_reason: null,
      incomplete: true,
      truncated: true,
      incomplete_reason: 'stream ended without done chunk',
      usage_status: 'unavailable',
    });
  }

  const responseTokens = usageTotal(finalResponse);

  // Tool calls from stream
  if (finalResponse.tool_calls && finalResponse.tool_calls.length > 0) {
    progress.onStreamEnd?.('');
    const result = await handleToolCalls(params, finalResponse.tool_calls, finalResponse.content || '', finalResponse.reasoning_content);
    return { ...result, totalTokens: responseTokens };
  }

  // Truncation detection
  if ((finalResponse.stop_reason === 'max_tokens' || finalResponse.stop_reason === 'length')
    && truncationContinuations < params.maxTruncationContinuations) {
    truncationContinuations += 1;
    loopMessages.push({ role: 'assistant', content: accumulated || finalResponse.content || '' });
    loopMessages.push({
      role: 'user',
      content: '[INTERNAL DIRECTIVE — This is an internal directive, not a user message.] Your previous response was truncated due to output length limits. Continue exactly where you left off. Do not repeat what you already said.',
    });
    return { action: 'continue', responseText: '', totalTokens: responseTokens, consecutiveFailedToolBatches: params.consecutiveFailedToolBatches, recentToolFailureDetails: params.recentToolFailureDetails, truncationContinuations };
  }

  // Legacy XML tool call rescue
  const rawContent = accumulated || finalResponse.content || '';
  if (hasLegacyToolCallProtocol(rawContent)) {
    const legacyCalls = parseLegacyToolCalls(rawContent);
    if (legacyCalls && legacyCalls.length > 0) {
      logger.warn({ chatId, tools: legacyCalls.map(c => c.name), iteration: i }, 'Rescued legacy XML tool calls');
      progress.onStreamEnd?.('');
      const syntheticToolCalls = legacyCalls.map((lc, idx) => ({
        id: `legacy_${Date.now()}_${idx}`,
        type: 'function' as const,
        function: { name: lc.name, arguments: JSON.stringify(lc.arguments) },
      }));
      const result = await handleToolCalls(params, syntheticToolCalls, rawContent);
      return { ...result, totalTokens: responseTokens };
    }
  }

  // Final response
  let responseText = sanitizeVisibleOutput(rawContent);
  const artifactResolution = resolveArtifactContract({
    userText: params.userText,
    responseText,
    artifactCapable: params.artifactCapable,
    artifactEmitted: params.didEmitRenderableArtifact(),
    artifactRepairAttempts: params.artifactRepairAttempts,
    maxArtifactRepairAttempts: params.maxArtifactRepairAttempts,
  });
  if (artifactResolution?.directive) {
    progress.onStreamEnd?.('');
    loopMessages.push({ role: 'assistant', content: responseText });
    loopMessages.push({ role: 'user', content: artifactResolution.directive });
    return {
      action: 'continue',
      responseText: '',
      totalTokens: responseTokens,
      artifactRepairApplied: true,
      consecutiveFailedToolBatches: params.consecutiveFailedToolBatches,
      recentToolFailureDetails: params.recentToolFailureDetails,
      truncationContinuations,
    };
  }
  progress.onStreamEnd?.(holdVisibleOutput ? '' : responseText);

  logger.info({ chatId, model: finalResponse.model, tokens: finalResponse.usage, streamed: true, toolIterations: i }, 'LLM response (streamed)');

  return {
    action: 'final',
    responseText,
    model: finalResponse.model,
    totalTokens: responseTokens,
    consecutiveFailedToolBatches: params.consecutiveFailedToolBatches,
    recentToolFailureDetails: params.recentToolFailureDetails,
    truncationContinuations,
  };
}

export async function executeNonStreamingTurn(params: TurnParams): Promise<TurnResult> {
  const { client, loopMessages, maxTokens, temperature, think, toolsDef, effectiveCallTimeoutMs, chatId, i, loopStartAt, progress } = params;
  let { truncationContinuations } = params;
  throwIfAborted(params.abortSignal, 'Request cancelled');
  emitTurnExecutionDetail(params, i === 0 ? 'Thinking through the request' : 'Organizing tool results');

  let response: ChatResponse;
  try {
    response = await client.chat(
      loopMessages,
      {
        max_tokens: maxTokens,
        temperature,
        think,
        tools: toolsDef,
        timeout_ms: effectiveCallTimeoutMs,
        execution_scope: 'interactive',
        abort_signal: params.abortSignal,
        billing: {
          tenantId: params.tenantId,
          userId: params.toolContext.userId,
          taskId: params.taskId,
          agentId: params.toolContext.agentId,
        },
      },
    );
  } catch (err) {
    if (params.abortSignal?.aborted) throw buildAbortError(params.abortSignal, 'Request cancelled');
    const errMsg = err instanceof Error ? err.message : String(err);
    const isTimeout = errMsg.includes('abort') || errMsg.includes('timeout') || (err instanceof Error && err.name === 'AbortError');
    if (isTimeout) {
      logger.warn({ chatId, iteration: i, elapsed_ms: Date.now() - loopStartAt }, 'LLM call timed out');
      return {
        action: (params.consecutiveFailedToolBatches + 1 >= params.maxFailedToolBatches) ? 'stop' : 'continue',
        responseText: '',
        stopReason: 'loop_timeout',
        consecutiveFailedToolBatches: params.consecutiveFailedToolBatches + 1,
        recentToolFailureDetails: params.recentToolFailureDetails,
        truncationContinuations,
      };
    }
    throw err;
  }

  const responseTokens = usageTotal(response);

  // Tool calls
  if (response.tool_calls && response.tool_calls.length > 0) {
    const result = await handleToolCalls(params, response.tool_calls, response.content || '', response.reasoning_content);
    return { ...result, totalTokens: responseTokens };
  }

  // Truncation detection
  if ((response.stop_reason === 'max_tokens' || response.stop_reason === 'length')
    && truncationContinuations < params.maxTruncationContinuations) {
    truncationContinuations += 1;
    loopMessages.push({ role: 'assistant', content: response.content || '' });
    loopMessages.push({
      role: 'user',
      content: '[INTERNAL DIRECTIVE — This is an internal directive, not a user message.] Your previous response was truncated due to output length limits. Continue exactly where you left off. Do not repeat what you already said.',
    });
    return { action: 'continue', responseText: '', totalTokens: responseTokens, consecutiveFailedToolBatches: params.consecutiveFailedToolBatches, recentToolFailureDetails: params.recentToolFailureDetails, truncationContinuations };
  }

  // Legacy XML tool call rescue
  const rawContent = response.content || '';
  if (hasLegacyToolCallProtocol(rawContent)) {
    const legacyCalls = parseLegacyToolCalls(rawContent);
    if (legacyCalls && legacyCalls.length > 0) {
      logger.warn({ chatId, tools: legacyCalls.map(c => c.name), iteration: i }, 'Rescued legacy XML tool calls (non-streaming)');
      const syntheticToolCalls = legacyCalls.map((lc, idx) => ({
        id: `legacy_${Date.now()}_${idx}`,
        type: 'function' as const,
        function: { name: lc.name, arguments: JSON.stringify(lc.arguments) },
      }));
      const result = await handleToolCalls(params, syntheticToolCalls, rawContent);
      return { ...result, totalTokens: responseTokens };
    }
  }

  // Final response
  let responseText = sanitizeVisibleOutput(rawContent);
  const artifactResolution = resolveArtifactContract({
    userText: params.userText,
    responseText,
    artifactCapable: params.artifactCapable,
    artifactEmitted: params.didEmitRenderableArtifact(),
    artifactRepairAttempts: params.artifactRepairAttempts,
    maxArtifactRepairAttempts: params.maxArtifactRepairAttempts,
  });
  if (artifactResolution?.directive) {
    loopMessages.push({ role: 'assistant', content: responseText });
    loopMessages.push({ role: 'user', content: artifactResolution.directive });
    return {
      action: 'continue',
      responseText: '',
      totalTokens: responseTokens,
      artifactRepairApplied: true,
      consecutiveFailedToolBatches: params.consecutiveFailedToolBatches,
      recentToolFailureDetails: params.recentToolFailureDetails,
      truncationContinuations,
    };
  }
  logger.info({ chatId, model: response.model, tokens: response.usage, toolIterations: i }, 'LLM response');

  return {
    action: 'final',
    responseText,
    model: response.model,
    totalTokens: responseTokens,
    consecutiveFailedToolBatches: params.consecutiveFailedToolBatches,
    recentToolFailureDetails: params.recentToolFailureDetails,
    truncationContinuations,
  };
}

// ---------------------------------------------------------------------------
// Legacy XML tool call parsing (moved from handler.ts)
// ---------------------------------------------------------------------------

function parseLegacyToolCalls(text: string): Array<{ name: string; arguments: Record<string, string> }> | null {
  // DSML / prefixed-XML markup goes through the shared parser (handles the
  // <|DSML|invoke>…<|DSML|parameter> grammar and value coercion).
  if (hasDsmlToolCallMarkup(text)) {
    const extracted = extractLegacyToolCallsFromText(text);
    if (extracted && extracted.toolCalls.length > 0) {
      return extracted.toolCalls.map((tc) => {
        let parsed: Record<string, unknown> = {};
        try { parsed = JSON.parse(tc.function.arguments) as Record<string, unknown>; } catch { /* keep empty */ }
        const args: Record<string, string> = {};
        for (const [k, v] of Object.entries(parsed)) args[k] = typeof v === 'string' ? v : String(v);
        return { name: tc.function.name, arguments: args };
      });
    }
  }

  const minimaxPattern = /<minimax:tool_call>\s*<invoke\s+name="([^"]+)">([\s\S]*?)<\/invoke>\s*<\/minimax:tool_call>/gi;
  const paramPattern = /<parameter\s+name="([^"]+)">([\s\S]*?)<\/parameter>/gi;
  const calls: Array<{ name: string; arguments: Record<string, string> }> = [];

  let match: RegExpExecArray | null;
  while ((match = minimaxPattern.exec(text)) !== null) {
    const toolName = match[1];
    const body = match[2];
    const args: Record<string, string> = {};
    let paramMatch: RegExpExecArray | null;
    paramPattern.lastIndex = 0;
    while ((paramMatch = paramPattern.exec(body)) !== null) {
      args[paramMatch[1]] = paramMatch[2];
    }
    calls.push({ name: toolName, arguments: args });
  }

  return calls.length > 0 ? calls : null;
}

// ---------------------------------------------------------------------------
// Recovery execution
// ---------------------------------------------------------------------------

interface RecoveryParams {
  client: LLMClient;
  contextMessages: ChatMessage[];
  loopMessages: ChatMessage[];
  chatId: string;
  turnId: string;
  loopStopReason: string;
  recentToolFailureDetails: string[];
  selfHealRetries: number;
  selfHealBackoffMs: number;
  llmCallTimeoutMs: number;
  iteration: number;
  maxIterations: number;
  unlimitedIterations: boolean;
  repeatedBatchThreshold: number;
  maxFailedToolBatches: number;
}

interface RecoveryResult {
  responseText: string;
  model?: string;
  totalTokens?: number;
  mode: 'self_heal' | 'hard_recovery' | 'brain_intervention' | 'fallback';
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise(resolve => setTimeout(resolve, ms));
}

function hasCjkText(text: string): boolean {
  return /[\u3400-\u9fff]/.test(text);
}

export async function executeRecovery(params: RecoveryParams): Promise<RecoveryResult> {
  const { client, contextMessages, loopMessages, chatId, loopStopReason, recentToolFailureDetails, selfHealRetries, selfHealBackoffMs, llmCallTimeoutMs } = params;

  // Self-heal: retry with directive
  if (selfHealRetries > 0) {
    for (let attempt = 1; attempt <= selfHealRetries; attempt++) {
      if (selfHealBackoffMs > 0) await sleep(selfHealBackoffMs * attempt);

      loopMessages.push({
        role: 'user',
        content: `[SYSTEM RECOVERY MODE] Previous execution stopped because ${loopStopReason}. ${recentToolFailureDetails.join(' | ').slice(0, 320)}. Continue the same user task. Return a direct user-facing answer now.`,
      });

      try {
        const recovery = await client.chat(loopMessages, {
          max_tokens: 1200,
          temperature: 0.2,
          timeout_ms: llmCallTimeoutMs > 0 ? llmCallTimeoutMs : undefined,
          execution_scope: 'interactive',
        });
        const recovered = sanitizeVisibleOutput(recovery.content);
        if (recovered.trim().length > 0) {
          logger.info({ chatId, attempt, model: recovery.model }, 'Self-heal recovery succeeded');
          return {
            responseText: recovered,
            model: recovery.model,
            totalTokens: recovery.usage.input_tokens + recovery.usage.output_tokens,
            mode: 'self_heal',
          };
        }
      } catch (err) {
        logger.warn({ chatId, attempt, err: err instanceof Error ? err.message : String(err) }, 'Self-heal recovery failed');
      }
    }
  }

  // Hard recovery: fresh context, no tools
  try {
    const hardMessages: ChatMessage[] = [
      ...contextMessages,
      {
        role: 'user',
        content: `[HARD RECOVERY MODE] Previous execution stopped: ${loopStopReason}. Tools are disabled. Provide the best direct response now.`,
      },
    ];
    const hardRecovery = await client.chat(hardMessages, {
      max_tokens: 1200,
      temperature: 0.2,
      timeout_ms: llmCallTimeoutMs > 0 ? llmCallTimeoutMs : undefined,
      execution_scope: 'interactive',
    });
    const recovered = sanitizeVisibleOutput(hardRecovery.content);
    if (recovered.trim().length > 0) {
      logger.info({ chatId, model: hardRecovery.model }, 'Hard recovery succeeded');
      return {
        responseText: recovered,
        model: hardRecovery.model,
        totalTokens: hardRecovery.usage.input_tokens + hardRecovery.usage.output_tokens,
        mode: 'hard_recovery',
      };
    }
  } catch (err) {
    logger.warn({ chatId, err: err instanceof Error ? err.message : String(err) }, 'Hard recovery failed');
  }

  // Fallback: static user-facing message
  const userText = contextMessages[contextMessages.length - 1]?.content?.toString() ?? '';
  const isZh = hasCjkText(userText);
  const fallback = isZh
    ? '当前请求执行中断，我已自动重置执行器并保留上下文。请直接重发原请求。'
    : 'This request was interrupted during execution. I reset the executor and preserved context; resend the same request.';

  logger.warn({ chatId, reason: loopStopReason }, 'All recovery phases exhausted, using fallback');
  return { responseText: fallback, mode: 'fallback' };
}
