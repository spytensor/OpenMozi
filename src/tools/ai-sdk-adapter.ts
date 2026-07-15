/**
 * AI SDK Tool Adapter — bridges MOZI tool definitions + executor to Vercel AI SDK's tool format.
 *
 * The AI SDK's `generateText({maxSteps, tools})` requires each tool to have an `execute` function.
 * This adapter wraps MOZI's existing `executeTool()` into that format, preserving:
 * - Prompt injection detection
 * - Parallel/sequential execution (file-mutating tools serialize)
 * - Progress event emission
 * - Abort signal support
 */

import { tool as aiTool, jsonSchema } from 'ai';
import type { ToolDefinition, ToolCall } from '../core/llm.js';
import { executeTool, extractToolIntent, extractToolSkillName, detectPromptInjection } from './executor.js';
import type { ToolContext, ToolResult } from './types.js';
import { emit } from '../progress/event-bus.js';
import pino from 'pino';

const logger = pino({ name: 'mozi:tools:ai-sdk-adapter' });

type ExecutableAITool = ReturnType<typeof aiTool<Record<string, unknown>, string>>;

export interface ToolAdapterOptions {
  context?: ToolContext;
  chatId?: string;
  /** Called before each tool execution */
  onToolStart?: (toolName: string, args: Record<string, unknown>) => void;
  /** Called after each tool execution */
  onToolEnd?: (toolName: string, result: ToolResult) => void;
}

/**
 * Convert MOZI ToolDefinition[] into AI SDK executable tools.
 *
 * Each tool gets an `execute` function that calls MOZI's existing executor,
 * preserving all security checks, logging, and progress tracking.
 */
export function toExecutableAITools(
  tools: ToolDefinition[],
  options: ToolAdapterOptions = {},
): Record<string, ExecutableAITool> {
  const result: Record<string, ExecutableAITool> = {};

  for (const t of tools) {
    const toolName = t.function.name;

    try {
      result[toolName] = aiTool({
        description: t.function.description,
        inputSchema: jsonSchema(t.function.parameters as Parameters<typeof jsonSchema>[0]),
        execute: async (args: Record<string, unknown>) => {
          // Build a ToolCall in MOZI format
          const callId = `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
          const argsJson = JSON.stringify(args);
          const moziToolCall: ToolCall = {
            id: callId,
            type: 'function',
            function: { name: toolName, arguments: argsJson },
          };

          // Emit progress event
          const intent = extractToolIntent(toolName, argsJson);
          const skillName = extractToolSkillName(toolName, argsJson);
          if (options.chatId) {
            emit({ type: 'tool_call', toolName, intent, skillName, chatId: options.chatId });
          }
          options.onToolStart?.(toolName, args);

          // Execute through existing MOZI executor (preserves all security)
          const moziResult = await executeTool(moziToolCall, options.context);

          // Emit completion event
          if (options.chatId) {
            emit({
              type: 'tool_result',
              toolName,
              toolCallId: moziResult.tool_call_id,
              elapsed_ms: moziResult.duration_ms,
              error: moziResult.is_error ? moziResult.content : undefined,
              skillName: moziResult.skillName,
              skillDescription: moziResult.skillDescription,
              skillLoadOutcome: moziResult.skillLoadOutcome,
              skillMissingBins: moziResult.skillMissingBins,
              skillMissingEnv: moziResult.skillMissingEnv,
              skillLoadError: moziResult.skillLoadError,
              chatId: options.chatId,
            });
          }
          options.onToolEnd?.(toolName, moziResult);

          // AI SDK expects the return value as the tool result
          // Return as string so it's injected into the conversation
          return moziResult.content;
        },
      });
    } catch (err) {
      // Invalid JSON Schema — skip tool instead of crashing the entire chat
      logger.warn({ tool: toolName, err: err instanceof Error ? err.message : String(err) }, 'Skipping tool with invalid schema');
    }
  }

  return result;
}

/**
 * Get just the count of successfully adapted tools (for logging).
 */
export function countAdaptedTools(tools: Record<string, unknown>): number {
  return Object.keys(tools).length;
}
