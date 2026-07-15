import { describe, expect, it } from 'vitest';
import { ALL_TOOLS } from './definitions.js';
import {
  detectTaskToolProfile,
  resolveModelExecutionProfile,
  shapePromptMessagesForExecution,
  shapeToolsForExecution,
} from './tool-shaping.js';

function names(result: ReturnType<typeof shapeToolsForExecution>): string[] {
  return result.tools.map(tool => tool.function.name);
}

describe('model-aware tool shaping', () => {
  it('detects Chinese and English task profiles', () => {
    expect(detectTaskToolProfile('帮我修复 TypeScript bug 并运行测试')).toBe('coding');
    expect(detectTaskToolProfile('Create an Excel spreadsheet and save it')).toBe('office');
    expect(detectTaskToolProfile('研究并对比最新的三个产品')).toBe('research');
    expect(detectTaskToolProfile('打开桌面应用并点击登录按钮')).toBe('desktop');
    expect(detectTaskToolProfile('Why is the sky blue?')).toBe('simple');
  });

  it('uses weak-tool profiles for DeepSeek and MiniMax', () => {
    expect(resolveModelExecutionProfile('deepseek', 'deepseek-v4-pro')).toBe('weak_tool_use');
    expect(resolveModelExecutionProfile('minimax', 'MiniMax-M3')).toBe('weak_tool_use');
  });

  it('keeps coding tools and removes browser/desktop tools for coding', () => {
    const shaped = shapeToolsForExecution({
      tools: ALL_TOOLS,
      userText: 'Fix this repository bug and run tests',
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
    });
    expect(names(shaped)).toEqual(expect.arrayContaining(['read_file', 'edit_file', 'git_diff', 'run_tests', 'shell_exec']));
    expect(names(shaped)).not.toEqual(expect.arrayContaining(['browser_open', 'desktop_click']));
    expect(shaped.shapedCount).toBeLessThan(shaped.originalCount);
    expect(shaped.schemaTokensEstimate).toBeLessThan(Math.ceil(JSON.stringify(ALL_TOOLS).length / 4) * 0.75);
  });

  it('keeps the shell path required by Office skills while removing git and browser', () => {
    const shaped = shapeToolsForExecution({
      tools: ALL_TOOLS,
      userText: '做一个 Excel 表格并保存到本地',
      provider: 'minimax',
      model: 'MiniMax-M3',
    });
    expect(names(shaped)).toEqual(expect.arrayContaining(['use_skill', 'shell_exec', 'write_file', 'create_artifact']));
    expect(names(shaped)).not.toEqual(expect.arrayContaining(['git_commit', 'browser_open']));
  });

  it('never removes tenant dynamic tools', () => {
    const dynamic = { type: 'function' as const, function: { name: 'tenant_custom', description: 'custom', parameters: { type: 'object' } } };
    const shaped = shapeToolsForExecution({
      tools: [...ALL_TOOLS, dynamic],
      userText: 'What is this?',
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
    });
    expect(names(shaped)).toContain('tenant_custom');
  });

  it('never removes artifact tools when a simple-looking request explicitly asks for HTML', () => {
    const shaped = shapeToolsForExecution({
      tools: ALL_TOOLS,
      userText: '给我一个 HTML，做一个？',
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
    });
    expect(shaped.taskProfile).toBe('simple');
    expect(names(shaped)).toEqual(expect.arrayContaining(['create_artifact', 'update_artifact']));
  });

  it('keeps computer-use tools for desktop tasks and control-plane tools for general tasks', () => {
    const desktop = shapeToolsForExecution({
      tools: ALL_TOOLS,
      userText: 'Open the desktop app and click the login button',
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
    });
    expect(names(desktop)).toEqual(expect.arrayContaining(['desktop_launch_app', 'desktop_click', 'desktop_screenshot']));

    const general = shapeToolsForExecution({
      tools: ALL_TOOLS,
      userText: 'Schedule this workflow for tomorrow',
      provider: 'minimax',
      model: 'MiniMax-M3',
    });
    expect(names(general)).toEqual(expect.arrayContaining(['set_cron_task', 'connector_execute', 'install_skill']));
  });

  it('keeps prompt tool names aligned and removes redundant weak-model tutorials', () => {
    const shapedTools = shapeToolsForExecution({
      tools: ALL_TOOLS,
      userText: 'Research the latest release',
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
    });
    const [system, policy] = shapePromptMessagesForExecution([{
      role: 'system',
      content: [
        'Core safety.',
        '## Visual Output & Aesthetics\nvisual tutorial',
        '## Task Decomposition\ndecomposition tutorial',
        '## Persistent Tasks\ntask tutorial',
        '## Available Tools\n\nread_file, shell_exec, desktop_click\n\nUse these tools when the user asks.',
      ].join('\n'),
    }], shapedTools);
    expect(String(system.content)).not.toContain('desktop_click');
    expect(String(system.content)).not.toContain('Task Decomposition');
    expect(String(system.content)).not.toContain('Persistent Tasks');
    expect(String(system.content)).not.toContain('Visual Output & Aesthetics');
    expect(String(policy.content)).toContain('weak_tool_use');
  });
});
