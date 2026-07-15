import type { ChatMessage, ToolDefinition } from '../core/llm.js';
import { resolveRuntimeModel } from '../core/providers.js';
import { ALL_TOOLS } from './definitions.js';
import { explicitlyRequestsRenderableArtifact } from '../artifacts/content-contract.js';

export type TaskToolProfile = 'simple' | 'coding' | 'research' | 'office' | 'data' | 'creative' | 'finance' | 'desktop' | 'general';
export type ModelExecutionProfile = 'strong_reasoning' | 'weak_tool_use' | 'non_reasoning';

export interface ToolShapingResult {
  tools: ToolDefinition[];
  taskProfile: TaskToolProfile;
  modelProfile: ModelExecutionProfile;
  originalCount: number;
  shapedCount: number;
  schemaTokensEstimate: number;
}

const BUILTIN_NAMES = new Set(ALL_TOOLS.map(tool => tool.function.name));
const CORE = new Set([
  'get_capabilities', 'list_directory', 'read_context', 'read_file', 'recall', 'recall_episodes',
  'remember', 'use_skill', 'unload_skill', 'list_runtime_skills',
]);
const FILE_WRITE = ['append_file', 'edit_file', 'write_file'];
const SHELL = ['shell_exec', 'shell_exec_bg', 'process_input', 'process_kill', 'process_output', 'process_status'];
const GIT = ['git_add', 'git_commit', 'git_diff', 'git_log', 'git_push', 'git_revert', 'git_status'];
const TASKS = ['create_task', 'decompose_task', 'get_task', 'list_tasks', 'read_task_result', 'repair_task', 'run_task', 'update_task'];
const ARTIFACTS = ['create_artifact', 'update_artifact'];
const WEB = ['web_fetch', 'web_search'];
const BROWSER = ['browser_assert', 'browser_click', 'browser_extract', 'browser_open', 'browser_type'];
const DESKTOP = [
  'desktop_screenshot', 'desktop_list_windows', 'desktop_focus_window', 'desktop_launch_app',
  'desktop_click', 'desktop_type', 'desktop_hotkey', 'desktop_click_hint', 'desktop_type_hint',
];
const RUNTIME_CONTROL = [
  'connector_execute', 'create_background_task', 'proactive_control', 'send_progress_report',
  'set_reminder', 'set_cron_task', 'list_cron_tasks', 'cancel_cron_task',
  'install_skill', 'set_skill_state', 'validate_skill', 'reload_skills',
];

function setOf(...groups: Array<string | string[] | Set<string>>): Set<string> {
  const result = new Set<string>();
  for (const group of groups) {
    if (typeof group === 'string') result.add(group);
    else for (const value of group) result.add(value);
  }
  return result;
}

const TASK_TOOLS: Record<TaskToolProfile, Set<string>> = {
  simple: setOf(CORE, WEB, 'analyze_image'),
  coding: setOf(CORE, FILE_WRITE, SHELL, GIT, TASKS, WEB, ARTIFACTS, 'analyze_image', 'delegate_coding_task', 'run_tests'),
  research: setOf(CORE, WEB, BROWSER, ARTIFACTS, TASKS, 'analyze_image', 'write_file', 'set_reminder'),
  office: setOf(CORE, FILE_WRITE, SHELL, ARTIFACTS, WEB, 'analyze_image', 'run_tests'),
  data: setOf(CORE, FILE_WRITE, SHELL, ARTIFACTS, WEB, 'analyze_image', 'run_tests'),
  creative: setOf(CORE, FILE_WRITE, SHELL, ARTIFACTS, WEB, 'analyze_image'),
  finance: setOf(CORE, FILE_WRITE, SHELL, ARTIFACTS, WEB, 'analyze_image'),
  desktop: setOf(CORE, DESKTOP, BROWSER, 'analyze_image'),
  general: setOf(CORE, FILE_WRITE, SHELL, TASKS, ARTIFACTS, WEB, RUNTIME_CONTROL, 'analyze_image', 'run_tests'),
};

export function detectTaskToolProfile(text: string): TaskToolProfile {
  const value = text.toLowerCase();
  if (/\b(docx?|word|xlsx?|excel|pptx?|powerpoint|spreadsheet|slide deck)\b|文档|表格|演示文稿|幻灯片/.test(value)) return 'office';
  if (/\b(code|coding|bug|fix|refactor|repository|repo|typescript|javascript|python|test|pull request|\bpr\b|commit|git|docker|api)\b|代码|修复|仓库|测试|提交/.test(value)) return 'coding';
  if (/\b(research|compare|investigate|latest|sources?|citation|find out|look up|search)\b|研究|对比|调查|最新|搜索|查找/.test(value)) return 'research';
  if (/\b(csv|dataset|data analysis|sql|statistics|chart|plot|pivot)\b|数据分析|统计|图表/.test(value)) return 'data';
  if (/\b(design|illustration|image|svg|poster|creative|story|logo|website)\b|设计|图片|海报|创作|网页/.test(value)) return 'creative';
  if (/\b(finance|stock|market|crypto|portfolio|valuation|investment)\b|股票|市场|加密货币|投资|估值/.test(value)) return 'finance';
  if (/\b(desktop|screen|screenshot|window|launch app|open app|click|type into|hotkey)\b|桌面|屏幕|截图|窗口|打开应用|启动应用|点击|输入到/.test(value)) return 'desktop';
  if (/^(what|why|how|who|when|where|is|are|can|does|explain|define)\b|[?？]$|是什么|为什么|怎么/.test(value.trim())) return 'simple';
  return 'general';
}

export function resolveModelExecutionProfile(provider?: string, model?: string): ModelExecutionProfile {
  const providerId = provider?.toLowerCase() ?? '';
  if (providerId === 'deepseek' || providerId === 'minimax') return 'weak_tool_use';
  if (!providerId || !model || model === 'fallback') return 'strong_reasoning';
  const definition = resolveRuntimeModel(providerId, model, { allowUnknown: true });
  return definition?.reasoning === true ? 'strong_reasoning' : 'non_reasoning';
}

export function shapeToolsForExecution(input: {
  tools: ToolDefinition[];
  userText: string;
  provider?: string;
  model?: string;
}): ToolShapingResult {
  const taskProfile = detectTaskToolProfile(input.userText);
  const modelProfile = resolveModelExecutionProfile(input.provider, input.model);
  const shouldShape = taskProfile !== 'general' || modelProfile !== 'strong_reasoning';
  const allowed = new Set(TASK_TOOLS[taskProfile]);
  if (explicitlyRequestsRenderableArtifact(input.userText)) {
    for (const toolName of ARTIFACTS) allowed.add(toolName);
  }
  const tools = shouldShape
    ? input.tools.filter(tool => !BUILTIN_NAMES.has(tool.function.name) || allowed.has(tool.function.name))
    : input.tools;
  const schemaChars = JSON.stringify(tools).length;
  return {
    tools,
    taskProfile,
    modelProfile,
    originalCount: input.tools.length,
    shapedCount: tools.length,
    schemaTokensEstimate: Math.ceil(schemaChars / 4),
  };
}

export function buildModelExecutionPolicy(result: ToolShapingResult): string | null {
  if (result.modelProfile === 'strong_reasoning' && result.taskProfile === 'general') return null;
  return [
    '[Runtime model policy]',
    `Task profile: ${result.taskProfile}. Model profile: ${result.modelProfile}.`,
    `The runtime exposed ${result.shapedCount} relevant tools (from ${result.originalCount}).`,
    'Use only tools that are visible. Prefer one valid tool call over speculative multi-tool batches; inspect each result before the next dependent call.',
  ].join('\n');
}

function removeMarkdownSection(content: string, heading: string): string {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return content.replace(new RegExp(`\\n## ${escaped}\\n[\\s\\S]*?(?=\\n## |\\n---\\n|$)`, 'g'), '');
}

export function shapePromptMessagesForExecution(
  messages: ChatMessage[],
  result: ToolShapingResult,
): ChatMessage[] {
  const toolNames = result.tools.map(tool => tool.function.name).join(', ');
  const shaped = messages.map(message => ({ ...message }));
  const firstSystem = shaped.find(message => message.role === 'system');
  if (firstSystem && typeof firstSystem.content === 'string') {
    let content = firstSystem.content.replace(
      /## Available Tools\n\n[\s\S]*?\n\nUse these tools when the user asks\./,
      `## Available Tools\n\n${toolNames}\n\nUse only these currently exposed tools.`,
    );
    if (result.modelProfile !== 'strong_reasoning') {
      content = removeMarkdownSection(content, 'Task Decomposition');
      content = removeMarkdownSection(content, 'Persistent Tasks');
      if (result.taskProfile !== 'office' && result.taskProfile !== 'creative') {
        content = removeMarkdownSection(content, 'Visual Output & Aesthetics');
      }
    }
    firstSystem.content = content;
  }
  const policy = buildModelExecutionPolicy(result);
  if (policy) {
    let lastUserIndex = -1;
    for (let index = shaped.length - 1; index >= 0; index--) {
      if (shaped[index]?.role === 'user') {
        lastUserIndex = index;
        break;
      }
    }
    shaped.splice(lastUserIndex >= 0 ? lastUserIndex : shaped.length, 0, { role: 'system', content: policy });
  }
  return shaped;
}
