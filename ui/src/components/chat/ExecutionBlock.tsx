import { memo, useEffect, useMemo, useState } from "react";
import { ChevronDown, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { TaskUpdate, ToolEvent } from "@/types";
import {
  buildToolStepSummary,
  compactIssueDetail,
  isCancelledTask,
  isTurnLifecycleTask,
  sanitizeTaskTitle,
  toolRunningActionLabel,
  toolUserActionLabel,
  type ExecutionBlockModel,
} from "./execution";
import { buildTaskTree, type TaskGroupNode, type TaskNodeState, type TaskTreeNode } from "./task-tree";
import { formatDurationForLocale, translateMessage, useLocale, type Locale } from "@/i18n";
import { formatApproximateDurationForLocale } from "@/i18n/format";

interface ExecutionBlockProps {
  block: ExecutionBlockModel;
  /**
   * The runtime no longer knows this block's turn — it died mid-flight
   * (process restart, killed turn). Running visuals must freeze into an
   * explicit interrupted state instead of spinning forever.
   */
  interrupted?: boolean;
  /**
   * Render inside an already-expanded turn fold: no own "View work" summary
   * button (a disclosure inside a disclosure is redundant) — just the phase
   * timeline plus the Technical details expander.
   */
  embedded?: boolean;
}

const EXECUTION_TIMELINE_SCROLL_THRESHOLD = 8;

type RowState = "done" | "running" | "blocked" | "skipped" | "pending" | "interrupted" | "queued" | "cancelled";

interface TimelineRow {
  key: string;
  label: string;
  detail?: string;
  state: RowState;
  /** Nesting depth for the nested task-timeline (Issue #624); 0 = top level. */
  depth?: number;
  /** True for a task-group header row so it reads as a group, not a leaf step. */
  isGroup?: boolean;
  timestamp: number;
  durationMs?: number;
  url?: string | null;
  hostname?: string | null;
  showHostnameChip?: boolean;
  isSkillActivation?: boolean;
  skillSuffixName?: string | null;
  skillDescription?: string | null;
  skillLoadOutcome?: "success" | "not_found" | "ineligible" | null;
  skillMissingBins?: string[];
  skillMissingEnv?: string[];
  skillLoadError?: string | null;
}

function taskUserStatusLabel(
  status: TaskUpdate["userStatus"] | undefined,
  locale: Locale,
  taskStatus?: TaskUpdate["status"],
): string | null {
  switch (status) {
    case "received":
      return translateMessage(locale, "execution.taskStatus.received");
    case "planning":
      return translateMessage(
        locale,
        taskStatus === "completed" ? "execution.taskStatus.planningDone" : "execution.taskStatus.planning",
      );
    case "responding":
      return translateMessage(
        locale,
        taskStatus === "completed" ? "execution.taskStatus.respondingDone" : "execution.taskStatus.responding",
      );
    case "checking":
      return translateMessage(locale, "execution.taskStatus.checking");
    case "starting":
      return translateMessage(locale, "execution.taskStatus.starting");
    case "working":
      return translateMessage(
        locale,
        taskStatus === "completed" ? "execution.taskStatus.workingDone" : "execution.taskStatus.working",
      );
    case "verifying":
      return translateMessage(locale, "execution.taskStatus.verifying");
    case "done":
      return translateMessage(locale, "execution.taskStatus.done");
    case "blocked":
      return translateMessage(locale, "execution.taskStatus.blocked");
    default:
      return null;
  }
}

function isTurnLifecycleStatus(status: TaskUpdate["userStatus"] | undefined): boolean {
  return status === "received" || status === "planning" || status === "working" || status === "responding";
}

function localizedIssueDetail(detail: string, locale: Locale): string {
  if (detail === "Source temporarily unavailable") {
    return translateMessage(locale, "execution.issue.sourceTemporarilyUnavailable");
  }
  if (detail === "Source could not be read") {
    return translateMessage(locale, "execution.issue.sourceUnreadable");
  }
  if (detail === "Search returned no useful results") {
    return translateMessage(locale, "execution.issue.searchNoResults");
  }
  if (detail === "Search service temporarily unavailable") {
    return translateMessage(locale, "execution.issue.searchUnavailable");
  }
  if (detail === "File not found") {
    return translateMessage(locale, "execution.issue.fileNotFound");
  }
  if (detail === "Command reported errors") {
    return translateMessage(locale, "execution.issue.commandErrors");
  }
  const missingEnv = detail.match(/^Missing\s+([A-Z][A-Z0-9_]+)$/);
  if (locale === "zh-CN" && missingEnv) return `缺少 ${missingEnv[1]}`;
  return detail;
}

function shouldShowLifecycleTasks(block: ExecutionBlockModel): boolean {
  const lifecycleTasks = block.tasks.filter(isTurnLifecycleTask);
  if (lifecycleTasks.length === 0) return false;

  const nonLifecycleTaskCount = block.tasks.length - lifecycleTasks.length;
  if (block.status === "running") return true;
  if (nonLifecycleTaskCount > 0) return true;
  if (block.toolCount >= 3) return true;
  if (block.totalElapsedMs >= 8_000) return true;
  return block.status === "mixed" && block.toolCount > 1;
}

function visibleTasksForBlock(block: ExecutionBlockModel): TaskUpdate[] {
  const includeLifecycle = shouldShowLifecycleTasks(block);
  const tasks = includeLifecycle ? block.tasks : block.tasks.filter((task) => !isTurnLifecycleTask(task));
  if (block.status === "running") return tasks;
  return tasks.filter((task) => !(task.userStatus === "working" && task.status === "completed" && isTurnLifecycleTask(task)));
}

function getDisplayTools(tools: ToolEvent[]): ToolEvent[] {
  const byCallId = new Map<string, ToolEvent>();

  tools.forEach((tool, index) => {
    const key = tool.callId || `${tool.id}-${index}`;
    const existing = byCallId.get(key);
    if (!existing || tool.phase === "end" || tool.timestamp > existing.timestamp) {
      byCallId.set(key, tool);
    }
  });

  return [...byCallId.values()].sort((a, b) => a.timestamp - b.timestamp);
}

function taskState(task: TaskUpdate): RowState {
  if (task.status === "failed") return "blocked";
  if (task.status === "running") return "running";
  if (task.status === "pending") return "pending";
  return "done";
}

function buildTaskRow(task: TaskUpdate, locale: Locale): TimelineRow {
  const title = sanitizeTaskTitle(task.title);
  const statusLabel = taskUserStatusLabel(task.userStatus, locale, task.status);
  const label = isTurnLifecycleTask(task)
    ? statusLabel || title || translateMessage(locale, "execution.taskFallback")
    : title || statusLabel || translateMessage(locale, "execution.taskFallback");
  const detail =
    task.status !== "failed" && !isTurnLifecycleStatus(task.userStatus) && statusLabel && statusLabel !== label
        ? statusLabel
        : undefined;

  return {
    key: `task:${task.id}`,
    label,
    detail,
    state: taskState(task),
    timestamp: task.timestamp,
    durationMs: task.elapsed_ms,
  };
}

function getTaskRows(tasks: TaskUpdate[], locale: Locale): TimelineRow[] {
  return tasks.map((task) => buildTaskRow(task, locale));
}

function getToolState(tool: ToolEvent, block: ExecutionBlockModel): RowState {
  if (tool.phase === "start") return "running";
  if (tool.status !== "error") return "done";
  return block.status === "mixed" ? "skipped" : "blocked";
}

function issueRepeatSuffix(count: number, locale: Locale): string {
  if (count <= 1) return "";
  const phrase = translateMessage(locale, "execution.repeated", { count });
  return locale === "zh-CN" ? `（${phrase}）` : ` (${phrase})`;
}

function skillActivationDetail(row: TimelineRow, locale: Locale): string {
  if (row.state === "running") return translateMessage(locale, "execution.skill.loading");

  if (row.state === "done" && (row.skillLoadOutcome === "success" || !row.skillLoadOutcome)) {
    return translateMessage(locale, "execution.skill.loaded");
  }

  if (row.skillLoadOutcome === "not_found") {
    return translateMessage(locale, "execution.skill.notFound");
  }

  if (row.skillLoadOutcome === "ineligible") {
    return translateMessage(locale, "execution.skill.ineligible");
  }

  return row.detail || row.skillLoadError || translateMessage(locale, "execution.skill.failed");
}

function buildToolRow(tool: ToolEvent, block: ExecutionBlockModel, locale: Locale): TimelineRow {
    const summary = buildToolStepSummary(tool, locale);
    const state = getToolState(tool, block);
    const issue = state === "blocked" || state === "skipped"
      ? block.issueSummaries.find((item) => item.label === toolUserActionLabel(tool.tool)) ?? block.issueSummaries[0]
      : undefined;
    const issueDetail = issue
      ? `${localizedIssueDetail(issue.detail, locale)}${issueRepeatSuffix(issue.count, locale)}`
      : undefined;

    if (summary.isSkillActivation) {
      const compactError = localizedIssueDetail(compactIssueDetail(tool.error || tool.result || ""), locale);
      const fallbackError = compactError || undefined;
      const row: TimelineRow = {
        key: `tool:${tool.id}`,
        label: toolRunningActionLabel(tool.tool, locale),
        detail: state === "blocked" || state === "skipped" ? (issueDetail ?? fallbackError) : undefined,
        state,
        timestamp: tool.timestamp,
        durationMs: tool.elapsed_ms,
        url: null,
        hostname: null,
        showHostnameChip: false,
        isSkillActivation: true,
        skillSuffixName: null,
        skillDescription: summary.skillDescription,
        skillLoadOutcome: summary.skillLoadOutcome,
        skillMissingBins: summary.skillMissingBins,
        skillMissingEnv: summary.skillMissingEnv,
        skillLoadError: summary.skillLoadError ?? fallbackError,
      };
      return {
        ...row,
        detail: skillActivationDetail(row, locale),
      };
    }

    const userFacingLabel = summary.kind === "shell"
      ? translateMessage(locale, "execution.step.runFallback")
      : summary.kind === "write"
        ? translateMessage(locale, "execution.step.writeFallback")
        : summary.kind === "inspect"
          ? translateMessage(locale, "execution.step.inspectFallback")
          : summary.timelineLabel;
    const label = state === "skipped"
      ? issueDetail ?? translateMessage(locale, "execution.tool.skippedSource")
      : state === "blocked"
        ? translateMessage(locale, "execution.tool.blocked", { label: toolUserActionLabel(tool.tool, locale) })
        : userFacingLabel;
    const detail = state === "blocked"
      ? issueDetail ?? localizedIssueDetail(compactIssueDetail(tool.error || tool.result || ""), locale)
      : undefined;

    return {
      key: `tool:${tool.id}`,
      label,
      detail,
      state,
      timestamp: tool.timestamp,
      durationMs: tool.elapsed_ms,
      url: state === "blocked" || summary.isSkillActivation ? null : summary.url,
      hostname: state === "blocked" || summary.isSkillActivation ? null : summary.hostname,
      showHostnameChip: state === "blocked" || summary.isSkillActivation ? false : summary.showHostnameChip,
      isSkillActivation: summary.isSkillActivation,
      skillSuffixName: null,
    };
}

function getToolRows(tools: ToolEvent[], block: ExecutionBlockModel, locale: Locale): TimelineRow[] {
  return getDisplayTools(tools).map((tool) => buildToolRow(tool, block, locale));
}

function applyInterrupted(row: TimelineRow, interrupted: boolean): TimelineRow {
  return interrupted && row.state === "running" ? { ...row, state: "interrupted" } : row;
}

/**
 * Flatten the nested task tree (Issue #624) into depth-tagged rows, preserving
 * chronology within every relationship. A task-group header row is followed by
 * its children (subtasks + tools) indented one level deeper. Concurrent subtasks
 * stay distinct because each keeps its own `task_id` node — they are never merged.
 */
function flattenTaskTree(
  nodes: TaskTreeNode[],
  block: ExecutionBlockModel,
  locale: Locale,
  interrupted: boolean,
  depth: number,
  out: TimelineRow[],
): void {
  for (const node of nodes) {
    if (node.kind === "tool") {
      out.push(applyInterrupted({ ...buildToolRow(node.tool, block, locale), depth }, interrupted));
      continue;
    }
    out.push(buildTaskGroupRow(node, locale, interrupted, depth));
    flattenTaskTree(node.children, block, locale, interrupted, depth + 1, out);
  }
}

function buildTaskGroupRow(node: TaskGroupNode, locale: Locale, interrupted: boolean, depth: number): TimelineRow {
  const base = buildTaskRow(node.task, locale);
  const state = nodeStateToRowState(node.state, interrupted);
  // Surface the truthful lifecycle state as a chip on cancelled/queued nodes,
  // whose glyph alone is easy to miss; running/done/failed read from the glyph.
  const stateChip =
    node.state === "cancelled"
      ? translateMessage(locale, "execution.node.cancelled")
      : node.state === "queued"
        ? translateMessage(locale, "execution.node.queued")
        : null;
  // For a cancelled/queued node prefer a real reason from the task, else the
  // localized chip — never the raw lifecycle string (e.g. "task_cancelled"),
  // which `buildTaskRow` would otherwise surface as the failed-task detail.
  return {
    ...base,
    state,
    depth,
    isGroup: true,
    detail: stateChip ?? base.detail,
  };
}

function getTimelineRows(block: ExecutionBlockModel, locale: Locale, interrupted: boolean): TimelineRow[] {
  const tree = buildTaskTree(visibleTasksForBlock(block), block.tools);
  if (tree.hasHierarchy) {
    const rows: TimelineRow[] = [];
    flattenTaskTree(tree.roots, block, locale, interrupted, 0, rows);
    return rows;
  }
  const taskRows = getTaskRows(visibleTasksForBlock(block), locale);
  const toolRows = getToolRows(block.tools, block, locale);
  return [...taskRows, ...toolRows]
    .map((row) => applyInterrupted(row, interrupted))
    .sort((a, b) => a.timestamp - b.timestamp);
}

function compactSummary(block: ExecutionBlockModel, interrupted: boolean, locale: Locale): string {
  if (interrupted) return translateMessage(locale, "execution.summary.interrupted");
  const concreteTasks = block.tasks.filter((task) => !isTurnLifecycleTask(task));
  const hasFailedTask = concreteTasks.some((task) => task.status === "failed" && !isCancelledTask(task));
  // A turn the envelope marked cancelled reads as cancelled even if its individual
  // tool/task rows never carried a cancel status (the abort landed between steps).
  if (block.status === "cancelled" || (concreteTasks.length > 0 && concreteTasks.every(isCancelledTask) && block.tools.length === 0)) {
    return translateMessage(locale, "execution.summary.cancelledCompact");
  }
  if (block.status === "error" || (block.status === "mixed" && hasFailedTask)) {
    return block.issueCount > 0
      ? translateMessage(locale, "execution.summary.needsAttention", { count: block.issueCount })
      : translateMessage(locale, "execution.summary.needsAttentionCompact");
  }
  return translateMessage(locale, "execution.summary.viewWork");
}

function statusGlyph(state: RowState): string {
  if (state === "done") return "✓";
  if (state === "cancelled") return "⊘";
  if (state === "blocked" || state === "skipped" || state === "interrupted") return "⚠";
  if (state === "running") return "●";
  return "○";
}

function glyphClass(state: RowState): string {
  if (state === "done") return "text-success/80";
  if (state === "blocked" || state === "interrupted") return "text-warning";
  if (state === "skipped" || state === "cancelled") return "text-warning/80";
  if (state === "running") return "text-accent";
  return "text-ink/24";
}

/** Map the truthful task-node state (Issue #624) to a timeline row state. */
function nodeStateToRowState(state: TaskNodeState, interrupted: boolean): RowState {
  if (interrupted && state === "running") return "interrupted";
  switch (state) {
    case "succeeded":
      return "done";
    case "failed":
      return "blocked";
    case "cancelled":
      return "cancelled";
    case "queued":
      return "queued";
    case "running":
    default:
      return "running";
  }
}

function DomainChip({ hostname }: { hostname: string }) {
  return (
    <span
      aria-label={hostname}
      className="inline-flex max-w-full items-center gap-1 rounded-full bg-ink/[0.04] px-1.5 py-0.5 align-middle font-mono text-[11px] leading-none text-ink/34 transition-colors hover:bg-ink/[0.07] hover:text-ink/50"
    >
      <span className="h-1 w-1 shrink-0 rounded-full bg-ink/25" />
      <span className="truncate">{hostname}</span>
    </span>
  );
}

function TimelineRowView({ row }: { row: TimelineRow }) {
  // Indent nested task-timeline rows (Issue #624). Depth 0 keeps the original
  // pl-3; each level adds a fixed step so a subtask/tool reads as owned by its
  // parent group without depending on the client clock or arrival order.
  const depth = row.depth ?? 0;
  return (
    <div
      data-testid={row.isGroup ? "execution-task-group" : undefined}
      data-depth={depth}
      className="flex min-w-0 items-baseline gap-2 pl-3"
      style={depth > 0 ? { paddingLeft: `${0.75 + depth * 1.15}rem` } : undefined}
    >
      <span
        aria-hidden="true"
        className={cn(
          "w-3.5 shrink-0 self-baseline text-center text-[11px] leading-none",
          glyphClass(row.state),
          row.state === "running" && "pulse-dot",
        )}
      >
        {statusGlyph(row.state)}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-2">
          <p
            data-testid="execution-step-label"
            className={cn(
              "min-w-0 flex-1 text-[12.5px] leading-5",
              row.isSkillActivation ? "font-mono font-semibold text-ink/62" : "text-ink/45",
              row.isGroup && !row.isSkillActivation && "font-medium text-ink/60",
            )}
          >
            {row.label}
            {row.skillSuffixName && (
              <span
                data-testid="execution-skill-suffix"
                className="ml-1.5 inline-flex max-w-full items-center rounded-full bg-ink/[0.04] px-1.5 py-0.5 align-middle text-[10.5px] leading-none text-ink/30"
              >
                ❖ {row.skillSuffixName}
              </span>
            )}
            {row.url && row.hostname && row.showHostnameChip && (
              <>
                {" "}
                <span className="ml-1.5">
                  <DomainChip hostname={row.hostname} />
                </span>
              </>
            )}
          </p>
        </div>
        {row.detail && (
          <p
            data-testid={row.isSkillActivation ? "execution-skill-detail" : undefined}
            className={cn(
              "mt-0.5 break-words text-[11.5px] leading-5 text-ink/30",
              row.isSkillActivation && "pl-0 font-normal",
            )}
          >
            {row.isSkillActivation ? `⌊ ${row.detail}` : row.detail}
          </p>
        )}
      </div>
    </div>
  );
}

function TechnicalDetails({ block, locale }: { block: ExecutionBlockModel; locale: Locale }) {
  const [expanded, setExpanded] = useState(false);
  const tools = getDisplayTools(block.tools);
  const taskDetails = block.tasks.filter((task) => task.detail || task.rawStatus);

  if (tools.length === 0 && taskDetails.length === 0) return null;

  return (
    <div className="mt-3 border-t border-ink/[0.06] pt-2">
      <button
        type="button"
        data-testid="execution-technical-summary"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        className="inline-flex items-center gap-1.5 text-[11.5px] text-ink/32 transition-colors hover:text-ink/52"
      >
        <ChevronDown size={12} className={cn("transition-transform duration-180ms", expanded && "rotate-180")} />
        {translateMessage(locale, "execution.details.technical")}
      </button>
      {expanded && (
        <div data-testid="execution-technical-details" className="mt-2 space-y-2 border-l border-ink/[0.07] pl-3 font-mono text-[10.5px] leading-5 text-ink/35">
          {tools.map((tool) => (
            <dl key={`technical:${tool.callId || tool.id}`} className="space-y-0.5 break-words">
              <div><dt className="inline text-ink/24">{translateMessage(locale, "execution.details.toolName")}: </dt><dd className="inline">{tool.tool || "unknown"}</dd></div>
              {tool.intent && <div><dt className="inline text-ink/24">{translateMessage(locale, "execution.details.intent")}: </dt><dd className="inline whitespace-pre-wrap">{tool.intent}</dd></div>}
              {tool.elapsed_ms != null && <div><dt className="inline text-ink/24">{translateMessage(locale, "execution.details.duration")}: </dt><dd className="inline">{formatDurationForLocale(tool.elapsed_ms, locale)}</dd></div>}
              {tool.skillName && <div><dt className="inline text-ink/24">{translateMessage(locale, "execution.details.skillId")}: </dt><dd className="inline">{tool.skillName}</dd></div>}
              {tool.error && <div><dt className="inline text-ink/24">{translateMessage(locale, "execution.details.error")}: </dt><dd className="inline whitespace-pre-wrap">{tool.error}</dd></div>}
              {(tool.skillMissingBins?.length || tool.skillMissingEnv?.length) ? (
                <div><dt className="inline text-ink/24">{translateMessage(locale, "execution.details.missing")}: </dt><dd className="inline">{[...(tool.skillMissingBins ?? []), ...(tool.skillMissingEnv ?? [])].join(", ")}</dd></div>
              ) : null}
            </dl>
          ))}
          {taskDetails.map((task) => (
            <div key={`technical-task:${task.id}`} className="break-words">
              <span className="text-ink/24">{translateMessage(locale, "execution.details.taskDetail")}: </span>
              {task.detail || task.rawStatus}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function startedAtMs(block: ExecutionBlockModel): number | null {
  const stamps = [...block.tasks, ...block.tools]
    .map((item) => item.timestamp)
    .filter((value): value is number => typeof value === "number" && value > 1_000_000_000_000);
  return stamps.length ? Math.min(...stamps) : null;
}

function liveLabel(block: ExecutionBlockModel, locale: Locale): string {
  const runningTool = [...getDisplayTools(block.tools)].reverse().find((tool) => tool.phase === "start");
  if (runningTool) {
    const summary = buildToolStepSummary(runningTool, locale);
    if (summary.isSkillActivation) return toolRunningActionLabel(runningTool.tool, locale, summary.skillName);
    if (summary.kind === "shell") return translateMessage(locale, "execution.step.runFallback");
    if (summary.kind === "write") return translateMessage(locale, "execution.step.writeFallback");
    if (summary.kind === "inspect") return translateMessage(locale, "execution.step.inspectFallback");
    return summary.label;
  }

  const runningTask = [...block.tasks].reverse().find((task) => task.status === "running" || task.status === "pending");
  if (runningTask) {
    const title = sanitizeTaskTitle(runningTask.title);
    const status = taskUserStatusLabel(runningTask.userStatus, locale, runningTask.status);
    if (title && status && title !== status && !isTurnLifecycleTask(runningTask)) {
      return translateMessage(locale, "execution.step.currentTask", { name: title, detail: status });
    }
    return status || title || translateMessage(locale, "execution.summary.runningCompact");
  }

  return block.headline || translateMessage(locale, "execution.summary.runningCompact");
}

function LiveExecutionLine({ block, locale }: { block: ExecutionBlockModel; locale: Locale }) {
  const start = useMemo(() => startedAtMs(block), [block]);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!start) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [start]);

  const elapsedMs = start ? Math.max(0, Math.floor((now - start) / 60_000) * 60_000) : null;
  const approximateDuration = elapsedMs == null ? null : formatApproximateDurationForLocale(elapsedMs, locale);

  return (
    <div data-testid="execution-live-line" className="flex w-full max-w-[640px] items-center gap-2 py-1.5 text-[12px] text-ink/42">
      <Loader2 aria-hidden="true" className="h-3.5 w-3.5 shrink-0 animate-spin text-accent" strokeWidth={2} />
      <span className="live-verb-shimmer min-w-0 truncate">{liveLabel(block, locale)}</span>
      <span className="flex-1" />
      {approximateDuration && (
        <span className="shrink-0 font-mono text-[10.5px] tabular-nums text-ink/22">
          {approximateDuration}
        </span>
      )}
    </div>
  );
}

export function ExecutionBlock({ block, interrupted = false, embedded = false }: ExecutionBlockProps) {
  const { locale: uiLocale } = useLocale();
  const locale = block.locale ?? uiLocale;
  const [expanded, setExpanded] = useState(false);
  // The turn envelope may have terminalized this block as crash-interrupted
  // (Issue #626); treat that exactly like a runtime-lost block so running rows
  // freeze into the explicit interrupted state instead of spinning.
  const frozen = interrupted || block.status === "interrupted";
  const cancelledBlock = block.status === "cancelled";
  const isLive = block.status === "running" && !frozen;
  const rows = useMemo(() => getTimelineRows(block, locale, frozen), [block, locale, frozen]);
  const summary = compactSummary(block, frozen, locale);
  const concreteTasks = block.tasks.filter((task) => !isTurnLifecycleTask(task));
  const allCancelled = concreteTasks.length > 0 && concreteTasks.every(isCancelledTask) && block.tools.length === 0;
  const hasFailedTask = concreteTasks.some((task) => task.status === "failed" && !isCancelledTask(task));
  const showWarningDot = frozen || cancelledBlock || block.status === "error" || hasFailedTask || allCancelled;
  const shouldScrollTimeline = rows.length > EXECUTION_TIMELINE_SCROLL_THRESHOLD;

  if (isLive) {
    return <LiveExecutionLine block={block} locale={locale} />;
  }

  if (embedded) {
    return (
      <div data-testid="execution-block-embedded" className="w-full max-w-[640px]">
        {rows.length > 0 && (
          <div
            data-testid="execution-timeline"
            // Embedded inside the turn fold (already in the page scroll) — never
            // add a nested max-height scroll box, or the user has to scroll a
            // small inner pane separately to see the whole process.
            className="space-y-2.5 py-0.5"
          >
            {rows.map((row) => (
              <TimelineRowView key={row.key} row={row} />
            ))}
          </div>
        )}
        <TechnicalDetails block={block} locale={locale} />
      </div>
    );
  }

  return (
    <div data-testid="execution-block" className="w-full max-w-[640px] py-1">
      <button
        type="button"
        data-testid="execution-summary"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        className={cn(
          "inline-flex max-w-full items-center gap-2 px-1 py-1 text-[12px] leading-none text-ink/35 transition-colors duration-180ms hover:text-ink/55",
          showWarningDot && "rounded-full border border-ink/[0.05] px-2.5",
        )}
      >
        {showWarningDot && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-warning/80" />}
        <span className="truncate">{summary}</span>
        <ChevronDown size={12} className={cn("shrink-0 text-ink/25 transition-transform duration-180ms", expanded && "rotate-180")} />
      </button>

      {expanded && rows.length > 0 && (
        <div className="mt-2.5 duration-180ms motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-top-1">
          <div
            data-testid="execution-timeline"
            className={cn(
              "space-y-2.5 border-l border-ink/[0.07] py-0.5",
              shouldScrollTimeline && "max-h-[320px] overflow-y-auto pr-1",
            )}
          >
            {rows.map((row) => (
              <TimelineRowView key={row.key} row={row} />
            ))}
          </div>
          <TechnicalDetails block={block} locale={locale} />
        </div>
      )}
    </div>
  );
}

/**
 * Structural equality for the JSON-like values that make up an
 * `ExecutionBlockModel` (primitives, arrays, and plain server-carried objects —
 * no functions, class instances, Maps, or Sets). Used only by the memo
 * comparator below.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  const aIsArray = Array.isArray(a);
  if (aIsArray !== Array.isArray(b)) return false;
  if (aIsArray) {
    const aArr = a as unknown[];
    const bArr = b as unknown[];
    if (aArr.length !== bArr.length) return false;
    for (let i = 0; i < aArr.length; i += 1) {
      if (!deepEqual(aArr[i], bArr[i])) return false;
    }
    return true;
  }
  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const aKeys = Object.keys(aObj);
  const bKeys = Object.keys(bObj);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(bObj, key)) return false;
    if (!deepEqual(aObj[key], bObj[key])) return false;
  }
  return true;
}

/**
 * Custom memo comparator (Issue #628).
 *
 * `projectTimelineByTurn` rebuilds every execution block's wrapper object — and
 * its `tasks` / `tools` / `issueSummaries` arrays — on every projection, even
 * for historical turns whose content never changed. React's default shallow
 * prop compare sees a fresh `block` reference for each block and re-renders the
 * ENTIRE turn history on every active-turn update (a new tool event, a ticking
 * elapsed time, an auto-follow scroll toggle). Comparing block content
 * structurally instead keeps unchanged historical blocks parked at their last
 * render while the one active block whose content actually changed still
 * re-renders.
 *
 * Cheap scalar fields are compared first so the common case — the active block,
 * which almost always differs in `status`/`toolCount`/`totalElapsedMs` — rejects
 * without walking the arrays. `interrupted` is normalized to its defaulted value
 * so `undefined` and an explicit `false` are treated as equal.
 */
export function areExecutionBlockPropsEqual(prev: ExecutionBlockProps, next: ExecutionBlockProps): boolean {
  if ((prev.interrupted ?? false) !== (next.interrupted ?? false)) return false;
  const a = prev.block;
  const b = next.block;
  if (a === b) return true;
  return (
    a.key === b.key &&
    a.turnId === b.turnId &&
    a.locale === b.locale &&
    a.headline === b.headline &&
    a.status === b.status &&
    a.toolCount === b.toolCount &&
    a.taskCount === b.taskCount &&
    a.issueCount === b.issueCount &&
    a.totalElapsedMs === b.totalElapsedMs &&
    deepEqual(a.issueSummaries, b.issueSummaries) &&
    deepEqual(a.tasks, b.tasks) &&
    deepEqual(a.tools, b.tools)
  );
}

/**
 * Memoized with a content-aware comparator (Issue #628) because the projection
 * rebuilds block objects on every active update; see
 * `areExecutionBlockPropsEqual`. This lets a stable parent re-render (scroll
 * auto-follow, a sibling turn's live update) skip every historical block's
 * subtree while the active block still tracks its own changes.
 */
export default memo(ExecutionBlock, areExecutionBlockPropsEqual);
