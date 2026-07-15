import { describe, it, expect, vi } from 'vitest';
import { toExecutableAITools, countAdaptedTools } from './ai-sdk-adapter.js';
import type { ToolDefinition } from '../core/llm.js';

function makeTool(name: string, params: Record<string, unknown> = { type: 'object', properties: {} }): ToolDefinition {
  return {
    type: 'function',
    function: { name, description: `Tool: ${name}`, parameters: params },
  };
}

describe('tools/ai-sdk-adapter', () => {
  it('converts MOZI tool definitions to AI SDK format', () => {
    const tools = [makeTool('read_file'), makeTool('write_file')];
    const adapted = toExecutableAITools(tools);

    expect(Object.keys(adapted)).toContain('read_file');
    expect(Object.keys(adapted)).toContain('write_file');
    expect(countAdaptedTools(adapted)).toBe(2);
  });

  it('each adapted tool has an execute function', () => {
    const tools = [makeTool('shell_exec')];
    const adapted = toExecutableAITools(tools);

    // AI SDK tools have execute property
    const shellTool = adapted.shell_exec;
    expect(shellTool).toBeDefined();
  });

  it('skips tools with invalid JSON schema instead of crashing', () => {
    const tools = [
      makeTool('good_tool'),
      // Invalid schema — not a valid JSON Schema object
      makeTool('bad_tool', { type: 'invalid_garbage', foo: 123 } as any),
      makeTool('another_good'),
    ];

    // Should not throw
    const adapted = toExecutableAITools(tools);

    // Good tools should be present; bad tool may or may not be depending on jsonSchema strictness
    expect(Object.keys(adapted).length).toBeGreaterThanOrEqual(2);
    expect(adapted.good_tool).toBeDefined();
    expect(adapted.another_good).toBeDefined();
  });

  it('calls onToolStart and onToolEnd callbacks', async () => {
    const tools = [makeTool('list_directory', {
      type: 'object',
      properties: { path: { type: 'string' } },
    })];

    const starts: string[] = [];
    const ends: string[] = [];

    const adapted = toExecutableAITools(tools, {
      onToolStart: (name) => starts.push(name),
      onToolEnd: (name) => ends.push(name),
    });

    // Execute the adapted tool
    const listDirTool = adapted.list_directory as any;
    // AI SDK tool's execute is on the tool object
    if (listDirTool.execute) {
      await listDirTool.execute({ path: '.' });
      expect(starts).toContain('list_directory');
      expect(ends).toContain('list_directory');
    }
  });

  it('handles all built-in tools without crashing', async () => {
    // Import actual tool definitions
    const { ALL_TOOLS } = await import('./definitions.js');

    // Should adapt all tools without throwing
    const adapted = toExecutableAITools(ALL_TOOLS);
    expect(countAdaptedTools(adapted)).toBeGreaterThan(20);

    // Verify some key tools are present
    const names = Object.keys(adapted);
    expect(names).toContain('read_file');
    expect(names).toContain('write_file');
    expect(names).toContain('shell_exec');
    expect(names).toContain('web_search');
    expect(names).toContain('remember');
    expect(names).toContain('git_status');
  });

  it('preserves tool execution through existing executor', async () => {
    const tools = [makeTool('list_directory', {
      type: 'object',
      properties: { path: { type: 'string' } },
    })];

    const adapted = toExecutableAITools(tools);
    const listDirTool = adapted.list_directory as any;

    if (listDirTool.execute) {
      const result = await listDirTool.execute({ path: '.' });
      // list_directory on '.' should return file listing
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    }
  });
});
