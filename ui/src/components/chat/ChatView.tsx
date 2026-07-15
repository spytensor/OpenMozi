import { useRef, useEffect, useMemo, useState, type KeyboardEvent, type ReactNode, type UIEvent } from "react";
import { ArrowDown, ChevronDown, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { TimelineItem, ChatMessage, ApprovalRequest, Artifact, MemoryUpdate, SessionState, TurnEnvelope } from "@/types";
import MessageBubble, { AssistantNarration, hasRenderableAssistantContent, stripInjectedContext } from "./MessageBubble";
import MoziAvatar from "@/components/MoziAvatar";
import ExecutionBlock from "./ExecutionBlock";
import ApprovalCard from "./ApprovalCard";
import ArtifactCard from "./ArtifactCard";
import { inferMessageLocale, toolRunningActionLabel, type ChatRenderItem } from "./execution";
import { canProjectDeterministically, projectLegacyTimeline, projectTimelineByTurn } from "./turn-projection";
import { MemoryUpdateNotice } from "./MemoryUpdateNotice";
import { translateMessage, useLocale, type Locale, type MessageKey } from "@/i18n";

const WELCOME_SUGGESTIONS: MessageKey[] = [
  "chat.card.research.prompt",
  "chat.card.code.prompt",
  "chat.card.writing.prompt",
];

const AUTO_FOLLOW_THRESHOLD_PX = 48;

function AssistantColumnRow({ children, showAvatar = false }: { children: ReactNode; showAvatar?: boolean }) {
  return (
    <div data-testid="chat-assistant-column-row" className="flex w-full max-w-[980px] items-start gap-3">
      {showAvatar ? (
        <MoziAvatar className="mt-0.5" />
      ) : (
        <div data-testid="chat-assistant-column-spacer" aria-hidden="true" className="mt-0.5 h-[26px] w-[26px] shrink-0" />
      )}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

/**
 * The live "MOZI is doing X" line shown while a tool runs but no live execution
 * block sits at the timeline bottom. It stays a compact one-liner by default,
 * but — when the active turn has already completed steps that are otherwise held
 * back during the turn — it becomes clickable to reveal those step details, so
 * a user who wants to see what's happening can, without cluttering the default.
 */
function LiveToolLine({
  label,
  detailBlocks,
}: {
  label: string;
  detailBlocks: Array<Extract<ChatRenderItem, { kind: "execution" }>["block"]>;
}) {
  const [open, setOpen] = useState(false);
  const canExpand = detailBlocks.length > 0;
  return (
    <div data-testid="chat-active-tool-line" className="w-full max-w-[640px]">
      <button
        type="button"
        onClick={() => canExpand && setOpen((value) => !value)}
        aria-expanded={canExpand ? open : undefined}
        className={cn(
          "flex w-full items-center gap-2 py-1.5 text-[12px] leading-none text-ink/42 transition-colors",
          canExpand ? "cursor-pointer hover:text-ink/60" : "cursor-default",
        )}
      >
        <Loader2 aria-hidden="true" className="h-3.5 w-3.5 shrink-0 animate-spin text-accent" strokeWidth={2} />
        <span className="live-verb-shimmer min-w-0 truncate">{label}</span>
        {canExpand && (
          <ChevronDown
            size={12}
            className={cn("shrink-0 text-ink/25 transition-transform duration-180ms", open && "rotate-180")}
          />
        )}
      </button>
      {open && canExpand && (
        <div className="mt-2 space-y-3 border-l border-ink/[0.07] pl-3 duration-180ms motion-safe:animate-in motion-safe:fade-in-0">
          {detailBlocks.map((block) => (
            <ExecutionBlock key={block.key} block={block} embedded />
          ))}
        </div>
      )}
    </div>
  );
}

/** The clean text of the nearest user message before `index`, or undefined. */
function precedingUserPrompt(timeline: TimelineItem[], index: number): string | undefined {
  for (let i = index - 1; i >= 0; i--) {
    const item = timeline[i];
    if (item.type !== "message") continue;
    const m = item.data as ChatMessage;
    if (m.role !== "user") continue;
    const text = stripInjectedContext(m.content);
    return text.trim() ? text : undefined;
  }
  return undefined;
}

function precedingProjectedUserPrompt(renderItems: ChatRenderItem[], index: number): string | undefined {
  for (let i = index - 1; i >= 0; i--) {
    const item = renderItems[i];
    if (item.kind !== "single" || item.item.type !== "message") continue;
    const message = item.item.data as ChatMessage;
    if (message.role === "user") return stripInjectedContext(message.content);
  }
  return undefined;
}

function isUiLocale(value: unknown): value is Locale {
  return value === "en" || value === "zh-CN";
}

/**
 * The presentation locale for the current/active turn's live status labels.
 * On the authoritative path (Issue #628) this is the locale the server carried
 * on the turn's envelope — no character scan. The per-message scan survives only
 * as a legacy fallback for turns whose envelope predates the carried field.
 */
function latestTurnLocale(
  timeline: TimelineItem[],
  turns: TurnEnvelope[] | undefined,
  activeTurnId: string | null,
  fallback: Locale,
): Locale {
  const carried = (turnId: string | null | undefined) => {
    if (!turnId) return undefined;
    const env = turns?.find((t) => t.turnId === turnId);
    return isUiLocale(env?.locale) ? env.locale : undefined;
  };
  // Prefer the active turn's carried locale, else the latest recorded turn's.
  const activeCarried = carried(activeTurnId) ?? (turns?.length ? carried(turns[turns.length - 1]!.turnId) : undefined);
  if (activeCarried) return activeCarried;

  for (let i = timeline.length - 1; i >= 0; i--) {
    const item = timeline[i];
    if (item.type !== "message") continue;
    const message = item.data as ChatMessage;
    if (message.role !== "user") continue;
    return inferMessageLocale(message.content) ?? fallback;
  }
  return fallback;
}

function isStreamingAssistantAnswer(item?: TimelineItem): boolean {
  if (item?.type !== "message") return false;
  const message = item.data as ChatMessage;
  return message.role === "assistant" && message.streaming === true && hasRenderableAssistantContent(message);
}

function isStreamingAssistantMessage(item?: TimelineItem): boolean {
  if (item?.type !== "message") return false;
  const message = item.data as ChatMessage;
  return message.role === "assistant" && message.streaming === true;
}

function normalizedArtifactState(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function isArtifactTerminalStatus(status: string): boolean {
  return status === "completed" || status === "failed" || status === "closed" || status === "cancelled" || status === "canceled";
}

function isRunningArtifact(artifact: Artifact): boolean {
  const status = normalizedArtifactState(artifact.status);
  if (status === "running" || status === "generating") return true;
  if (isArtifactTerminalStatus(status)) return false;

  const dataStatus = normalizedArtifactState(artifact.data.status);
  if (dataStatus === "running" || dataStatus === "generating") return true;

  const phase = normalizedArtifactState(artifact.data.phase);
  return artifact.plugin_id === "live_work_v1" && (phase === "generating" || phase === "writing");
}

const GENERATED_ARTIFACT_DIRECTORIES = new Set([
  "target",
  "build",
  "dist",
  "out",
  "coverage",
  "cache",
  "tmp",
  "temp",
  "node_modules",
]);

function isIntermediateFileArtifact(artifact: Artifact): boolean {
  if (artifact.plugin_id !== "file_v1") return false;
  const filename = String(artifact.data.filename ?? artifact.title ?? "").toLowerCase();
  const path = String(artifact.data.path ?? "");
  const segments = path.split(/[\\/]+/).map((segment) => segment.toLowerCase());
  return segments.some((segment) => GENERATED_ARTIFACT_DIRECTORIES.has(segment))
    || filename === "invoked.timestamp"
    || filename === "cachedir.tag"
    || filename.endsWith(".d")
    || /^build_script_build-[a-f0-9]+\./.test(filename)
    || /^generate[_-].*\.(?:js|mjs|cjs|ts|py|sh)$/.test(filename);
}

function latestUserMessageIndex(timeline: TimelineItem[]): number {
  for (let i = timeline.length - 1; i >= 0; i--) {
    const item = timeline[i];
    if (item.type !== "message") continue;
    const message = item.data as ChatMessage;
    if (message.role === "user") return i;
  }
  return 0;
}

function hasRunningArtifactInCurrentTurn(timeline: TimelineItem[]): boolean {
  const start = latestUserMessageIndex(timeline);
  for (let i = start; i < timeline.length; i++) {
    const item = timeline[i];
    if (item.type === "artifact" && isRunningArtifact(item.data as Artifact)) return true;
  }
  return false;
}

function messageTurnId(message: ChatMessage): string | undefined {
  return message.turnId?.trim() || undefined;
}

function sameTurnBeforeNextUser(currentTurnId: string | undefined, laterTurnId: string | undefined): boolean {
  if (currentTurnId && laterTurnId) return currentTurnId === laterTurnId;
  // Current runtime data does not reliably attach turnId to assistant text, so
  // missing IDs fall back to the user-message boundary.
  return true;
}

function isRenderableAssistantText(item: TimelineItem): boolean {
  if (item.type !== "message") return false;
  const message = item.data as ChatMessage;
  return message.role === "assistant" && hasRenderableAssistantContent(message);
}

function hasLaterTurnWork(renderItems: ChatRenderItem[], renderIndex: number, message: ChatMessage): boolean {
  const currentTurnId = messageTurnId(message);

  for (let i = renderIndex + 1; i < renderItems.length; i++) {
    const next = renderItems[i];

    if (next.kind === "execution") {
      if (next.block.status === "running" && sameTurnBeforeNextUser(currentTurnId, next.block.turnId)) return true;
      continue;
    }

    const item = next.item;
    if (item.type !== "message") continue;
    const nextMessage = item.data as ChatMessage;
    if (nextMessage.role === "user") break;
    if (isRenderableAssistantText(item) && sameTurnBeforeNextUser(currentTurnId, messageTurnId(nextMessage))) {
      return true;
    }
  }

  return false;
}

function isLastAssistantTextInTurn(renderItems: ChatRenderItem[], renderIndex: number, message: ChatMessage): boolean {
  if (message.role !== "assistant" || !hasRenderableAssistantContent(message)) return true;
  return !hasLaterTurnWork(renderItems, renderIndex, message);
}

type ActivityIndicatorKind = "none" | "tool" | "responding" | "thinking" | "working";

function hasLiveExecutionAtTimelineBottom(renderItems: ChatRenderItem[]): boolean {
  const lastRenderItem = renderItems[renderItems.length - 1];
  return lastRenderItem?.kind === "execution" && lastRenderItem.block.status === "running";
}

/**
 * Derives the single extra activity indicator for the chat rail.
 * Invariant: at most ONE indicator renders at any time. Any visible activity
 * already at the bottom of the timeline - growing streaming answer text, a
 * running execution block, a running artifact card - IS the activity signal, so the extra
 * indicator must be "none" in those states.
 */
function deriveActivityIndicator(
  timeline: TimelineItem[],
  renderItems: ChatRenderItem[],
  sessionState: SessionState,
  activeTool: string | null,
): ActivityIndicatorKind {
  if (sessionState === "IDLE") return "none";

  const lastItem = timeline[timeline.length - 1];
  if (hasLiveExecutionAtTimelineBottom(renderItems)) return "none";
  if (activeTool) return "tool";
  if (isStreamingAssistantAnswer(lastItem)) return "none";
  if (isStreamingAssistantMessage(lastItem)) return "responding";
  if (hasRunningArtifactInCurrentTurn(timeline)) return "none";
  // "Thinking" is honest only before the turn has produced anything. Once the
  // turn has narrated or run tools, the between-steps gap (often a long one
  // while the model composes its next tool call) reads as continued work.
  return hasTurnOutputSinceLastUserMessage(timeline) ? "working" : "thinking";
}

/** True once the active turn has any visible narration or concrete work behind it. */
function hasTurnOutputSinceLastUserMessage(timeline: TimelineItem[]): boolean {
  for (let i = timeline.length - 1; i >= 0; i--) {
    const item = timeline[i];
    if (item.type === "message") {
      const msg = item.data as ChatMessage;
      if (msg.role === "user") return false;
      if (msg.role === "assistant" && (msg.content ?? "").trim()) return true;
      continue;
    }
    if (item.type === "tool_event" || item.type === "task_update" || item.type === "artifact") return true;
  }
  return false;
}

/**
 * Max render rows mounted at once before the earlier prefix is windowed out
 * (Issue #628). Chosen well above a typical session so ordinary chats render
 * unchanged; only very long sessions pay the DOM cost of a hidden prefix.
 */
const WINDOW_MAX_ROWS = 160;

function isUserRenderRow(item: ChatRenderItem): boolean {
  return item.kind === "single" && item.item.type === "message" && (item.item.data as ChatMessage).role === "user";
}

function renderTurnId(item: ChatRenderItem): string | undefined {
  if (item.kind === "execution") return item.block.turnId;
  const value = item.item.turnId ?? (item.item.data as { turnId?: unknown } | undefined)?.turnId;
  return typeof value === "string" && value ? value : undefined;
}

/**
 * First render-row index to mount, keeping the last `cap` rows but backing up to
 * the nearest user-message boundary so a turn is never split (preserving the
 * per-turn avatar/ordering invariants). Returns 0 when nothing is windowed.
 */
function windowStartIndex(renderItems: ChatRenderItem[], cap: number): number {
  if (renderItems.length <= cap) return 0;
  let start = renderItems.length - cap;
  const turnId = renderTurnId(renderItems[start]);
  if (turnId) {
    while (start > 0 && renderTurnId(renderItems[start - 1]) === turnId) start -= 1;
    return start;
  }
  while (start > 0 && !isUserRenderRow(renderItems[start])) start -= 1;
  return start;
}

type LiveActivity = "idle" | "working" | "thinking" | "responding" | "approval";

// Dedicated screen-reader phrasing, distinct from the visible `chat.status.*`
// indicators so assistive tech announces a clear full phrase and the two never
// double-read the same text.
const LIVE_ACTIVITY_KEY: Record<Exclude<LiveActivity, "idle">, MessageKey> = {
  working: "chat.activity.working",
  thinking: "chat.activity.thinking",
  responding: "chat.activity.responding",
  approval: "chat.activity.approval",
};

/**
 * Collapse the fine-grained render state into ONE coarse live-activity phase for
 * screen readers (Issue #628). Announcing this (and only this) means assistive
 * tech hears "Working" / "Responding" / "Waiting for your approval" once per
 * transition — never one announcement per low-level tool event.
 */
function deriveLiveActivity(
  activityIndicator: ActivityIndicatorKind,
  renderItems: ChatRenderItem[],
  sessionState: SessionState,
  turns?: TurnEnvelope[],
): LiveActivity {
  if (turns?.some((turn) => turn.status === "awaiting_approval")) return "approval";
  const last = renderItems[renderItems.length - 1];
  // Only a still-pending approval card is a meaningful "waiting" activity. Once
  // the operator approves or rejects, the card stays the last render item but
  // must no longer make the live region announce "waiting for your approval"
  // (Issue #628).
  if (
    last?.kind === "single" &&
    last.item.type === "approval_request" &&
    (last.item.data as ApprovalRequest).status === "pending"
  ) {
    return "approval";
  }
  if (sessionState === "IDLE") return "idle";
  if (activityIndicator === "responding") return "responding";
  if (activityIndicator === "thinking") return "thinking";
  return "working";
}

interface TurnFoldGroup {
  key: string;
  items: ChatRenderItem[];
}

function isUserMessageRow(ri: ChatRenderItem): boolean {
  return ri.kind === "single" && ri.item.type === "message" && (ri.item.data as ChatMessage).role === "user";
}

function isAssistantTextRow(ri: ChatRenderItem): boolean {
  return (
    ri.kind === "single" &&
    ri.item.type === "message" &&
    (ri.item.data as ChatMessage).role === "assistant" &&
    hasRenderableAssistantContent(ri.item.data as ChatMessage)
  );
}

function isFoldableRow(ri: ChatRenderItem): boolean {
  // Everything the turn worked THROUGH before its latest answer is process,
  // including phases with survived errors (the turn moved past them) — they
  // fold, and the fold header carries a warning marker. Only true outcomes
  // stay out: running work, cancellations/interruptions (no later answer
  // supersedes them), approvals, and deliverable artifacts.
  if (ri.kind === "execution") {
    return ri.block.status === "success" || ri.block.status === "error" || ri.block.status === "mixed";
  }
  return isAssistantTextRow(ri);
}

/**
 * Collapse a turn's intermediate process — interim narration and completed
 * work phases BEFORE its latest answer — into one quiet disclosure, so the
 * final answer is the only full-size content a finished turn leaves behind.
 * Grouping is per user-message segment; the newest assistant message (the
 * answer, or the narration currently being worked under) never folds.
 */
function buildTurnFolds(renderItems: ChatRenderItem[]): { groups: Map<number, TurnFoldGroup>; folded: Set<number> } {
  const groups = new Map<number, TurnFoldGroup>();
  const folded = new Set<number>();

  const flushSegment = (start: number, end: number) => {
    let lastAssistant = -1;
    for (let i = end - 1; i >= start; i--) {
      if (isAssistantTextRow(renderItems[i])) {
        lastAssistant = i;
        break;
      }
    }
    if (lastAssistant < 0) return;
    const collected: number[] = [];
    for (let i = start; i < lastAssistant; i++) {
      if (isFoldableRow(renderItems[i])) collected.push(i);
    }
    if (collected.length === 0) return;
    groups.set(collected[0], {
      key: `turn-fold-${collected[0]}`,
      items: collected.map((i) => renderItems[i]),
    });
    collected.forEach((i) => folded.add(i));
  };

  let segStart = 0;
  for (let i = 0; i <= renderItems.length; i++) {
    if (i === renderItems.length || isUserMessageRow(renderItems[i])) {
      flushSegment(segStart, i);
      segStart = i + 1;
    }
  }

  return { groups, folded };
}

function foldItemTimestamps(ri: ChatRenderItem): number[] {
  if (ri.kind === "execution") {
    return [...ri.block.tools, ...ri.block.tasks].map((entry) => entry.timestamp).filter((ts) => ts > 1_000_000_000_000);
  }
  return ri.item.timestamp > 1_000_000_000_000 ? [ri.item.timestamp] : [];
}

function TurnFold({ group }: { group: TurnFoldGroup }) {
  const { locale: uiLocale } = useLocale();
  const [expanded, setExpanded] = useState(false);
  const firstBlock = group.items.find((ri): ri is ChatRenderItem & { kind: "execution" } => ri.kind === "execution");
  const locale = firstBlock?.block.locale ?? uiLocale;

  const stamps = group.items.flatMap(foldItemTimestamps);
  const spanMs = stamps.length >= 2 ? Math.max(...stamps) - Math.min(...stamps) : 0;
  const minutes = spanMs >= 60_000 ? Math.max(1, Math.floor(spanMs / 60_000)) : 0;
  const label = minutes > 0
    ? `${translateMessage(locale, "execution.summary.viewWork")} · ${translateMessage(locale, "execution.duration.minutes", { count: String(minutes) })}`
    : translateMessage(locale, "execution.summary.viewWork");
  return (
    <div data-testid="turn-fold" className="w-full max-w-[640px] py-1">
      <button
        type="button"
        data-testid="turn-fold-summary"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        className="inline-flex max-w-full items-center gap-2 px-1 py-1 text-[12px] leading-none text-ink/35 transition-colors duration-180ms hover:text-ink/55"
      >
        {/* By construction the fold only exists once the turn produced its final
            answer (buildTurnFolds requires a lastAssistant), so it always
            represents a completed turn. Survived mid-turn errors are normal
            process, not a failure — the dot is green ("done"), never amber. */}
        <span
          data-testid="turn-fold-done-dot"
          className="h-1.5 w-1.5 shrink-0 rounded-full bg-success/80"
        />
        <span className="truncate">{label}</span>
        <ChevronDown size={12} className={cn("shrink-0 text-ink/25 transition-transform duration-180ms", expanded && "rotate-180")} />
      </button>
      {expanded && (
        <div
          data-testid="turn-fold-content"
          className="mt-2.5 space-y-3 border-l border-ink/[0.07] pl-3 duration-180ms motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-top-1"
        >
          {group.items.map((ri, idx) =>
            ri.kind === "execution" ? (
              <ExecutionBlock key={ri.block.key} block={ri.block} embedded />
            ) : (
              <AssistantNarration key={(ri.item.data as ChatMessage).id ?? `narration-${idx}`} message={ri.item.data as ChatMessage} />
            ),
          )}
        </div>
      )}
    </div>
  );
}

function renderRowKey(ri: ChatRenderItem, index: number): string {
  if (ri.kind === "execution") return `exec-${ri.block.key}`;
  const item = ri.item;
  if (item.type === "message") return `msg-${(item.data as ChatMessage).id ?? index}`;
  if (item.type === "approval_request") return `apr-${(item.data as ApprovalRequest).id ?? index}`;
  if (item.type === "artifact") return `art-${(item.data as Artifact).id ?? index}`;
  if (item.type === "memory_update") return `memory-${item.turnId ?? index}`;
  return `row-${index}`;
}

interface ChatViewProps {
  sessionId?: string | null;
  timeline: TimelineItem[];
  sessionState: SessionState;
  activeTool: string | null;
  activeToolSkillName?: string | null;
  /** Turn currently running per the runtime (null = nothing is running). */
  activeTurnId?: string | null;
  /** Timeline capabilities advertised by the server; gates deterministic projection. */
  timelineCapabilities?: string[];
  /** Server-authoritative turn envelopes for terminal-state consumption. */
  turns?: TurnEnvelope[];
  onApprove: (id: string, scope?: "once" | "session") => void;
  onReject: (id: string) => void;
  onSend: (content: string) => void;
  onRegenerate: (content: string) => void;
  onDeleteMessage?: (message: ChatMessage) => void;
  onOpenArtifact?: (artifact: Artifact) => void;
  onOpenModelSettings?: () => void;
  onOpenMemory?: () => void;
}

export default function ChatView({ sessionId = null, timeline, sessionState, activeTool, activeToolSkillName = null, activeTurnId = null, timelineCapabilities, turns, onApprove, onReject, onSend, onRegenerate, onDeleteMessage, onOpenArtifact, onOpenModelSettings, onOpenMemory }: ChatViewProps) {
  const { locale, t } = useLocale();
  const scrollRegionRef = useRef<HTMLDivElement>(null);
  const autoFollowRef = useRef(true);
  const [autoFollow, setAutoFollow] = useState(true);

  const updateAutoFollow = (next: boolean) => {
    autoFollowRef.current = next;
    setAutoFollow(next);
  };

  const scrollToLatest = () => {
    const region = scrollRegionRef.current;
    if (!region) return;
    updateAutoFollow(true);
    region.scrollTo({ top: region.scrollHeight, behavior: "auto" });
  };

  const handleScroll = (event: UIEvent<HTMLDivElement>) => {
    const region = event.currentTarget;
    const distanceFromBottom = region.scrollHeight - region.scrollTop - region.clientHeight;
    const next = distanceFromBottom <= AUTO_FOLLOW_THRESHOLD_PX;
    if (next !== autoFollowRef.current) updateAutoFollow(next);
  };

  // Keyboard navigation across the timeline feed (Issue #628): the ARIA `feed`
  // pattern moves focus between article rows with Up/Down and Home/End. Auto-
  // follow is suspended while the user is navigating with the keyboard so the
  // view does not yank focus away from the row they landed on.
  const handleFeedKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const region = scrollRegionRef.current;
    if (!region) return;
    const rows = Array.from(region.querySelectorAll<HTMLElement>("[data-chat-row]"));
    if (rows.length === 0) return;
    const focused = document.activeElement as HTMLElement;
    const current = rows.indexOf(focused);
    // Do not hijack arrow/Home/End behavior from buttons, links, or controls
    // nested inside an article. Feed navigation applies when focus is on the
    // rail itself or directly on one of its article rows.
    if (event.target !== event.currentTarget && current < 0) return;
    let next = current;
    if (event.key === "ArrowDown") next = current < 0 ? 0 : Math.min(rows.length - 1, current + 1);
    else if (event.key === "ArrowUp") next = current < 0 ? rows.length - 1 : Math.max(0, current - 1);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = rows.length - 1;
    const target = rows[next];
    if (!target || next === current) return;
    event.preventDefault();
    if (next < rows.length - 1) updateAutoFollow(false);
    target.focus();
    target.scrollIntoView({ block: "nearest" });
  };

  useEffect(() => {
    const region = scrollRegionRef.current;
    if (!region) return;
    if (autoFollowRef.current) {
      region.scrollTo({ top: region.scrollHeight, behavior: "auto" });
    }
    // Re-evaluate "at bottom" on every content change, not only on scroll events.
    // Content can grow or shrink without any scroll (e.g. a short, unscrollable
    // view), which left a stale autoFollow=false pinning the "jump to latest"
    // pill on screen even while the view was already at the bottom — it then
    // only cleared on click. If we are actually at the bottom now, resume follow.
    const distanceFromBottom = region.scrollHeight - region.scrollTop - region.clientHeight;
    if (distanceFromBottom <= AUTO_FOLLOW_THRESHOLD_PX && !autoFollowRef.current) {
      updateAutoFollow(true);
    }
  }, [timeline.length, timeline[timeline.length - 1], sessionState]);

  // Hooks must run unconditionally, before the empty-state early return below —
  // React counts hook calls per render (rules of hooks). The projection is
  // memoized here (Issue #628) so it does NOT re-run on unrelated renders — most
  // importantly on every scroll frame (`handleScroll` calls setState). Without
  // this a 500-turn session reprojected + rebuilt every row on each scroll tick.
  const deterministicProjection = canProjectDeterministically(timeline, timelineCapabilities);
  const renderItems = useMemo(
    () => (deterministicProjection ? projectTimelineByTurn(timeline, turns ?? []) : projectLegacyTimeline(timeline, turns ?? [])),
    [deterministicProjection, timeline, turns],
  );
  // Windowing state (Issue #628); re-hidden whenever a session shrinks below the
  // cap (session switch / clear) so a new session never inherits an expanded view.
  const [showEarlier, setShowEarlier] = useState(false);
  useEffect(() => {
    if (renderItems.length <= WINDOW_MAX_ROWS) setShowEarlier(false);
  }, [renderItems.length]);
  useEffect(() => {
    setShowEarlier(false);
  }, [sessionId]);

  if (timeline.length === 0 && sessionState === "IDLE") {
    return (
      <div className="flex-1 flex items-center justify-center px-4">
        <div className="w-full max-w-[520px]">
          <div className="mb-7 text-center">
            <div className="mb-3 flex justify-center">
              <MoziAvatar size={48} />
            </div>
            <h1
              className="mb-2 text-[28px] font-semibold leading-tight text-ink/88"
              style={{ fontFamily: '"Kaiti SC","STKaiti",serif, sans-serif' }}
            >
              {t("chat.welcomeHeadline")}
            </h1>
            <p className="text-sm text-ink/36">{t("chat.welcomeSubtitle")}</p>
          </div>
          <div className="divide-y divide-ink/[0.06] border-y border-ink/[0.06]">
            {WELCOME_SUGGESTIONS.map((promptKey) => (
              <button
                key={promptKey}
                onClick={() => onSend(t(promptKey))}
                className="group flex w-full cursor-pointer items-center gap-3 px-1 py-3 text-left text-[13px] text-ink/48 transition-colors duration-150 hover:text-ink/72"
              >
                <span aria-hidden="true" className="text-ink/26 transition-colors group-hover:text-accent/70">↗</span>
                <span className="min-w-0 truncate">{t(promptKey)}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  // Non-hook derivations (safe after the early return). The deterministic Turn
  // projection (Issue #625) is memoized above.
  const activityIndicator = deriveActivityIndicator(timeline, renderItems, sessionState, activeTool);
  const turnLocale = latestTurnLocale(timeline, turns, activeTurnId, locale);

  // Windowing (Issue #628): cap mounted DOM rows for very long sessions. The cut
  // is aligned to a user-message boundary so a turn is never split and the
  // per-turn avatar/ordering logic stays correct; chronology is preserved
  // (only a contiguous prefix is hidden, nothing is reordered). Normal-length
  // sessions (<= WINDOW_MAX_ROWS) render byte-for-byte as before.
  const windowStart = showEarlier ? 0 : windowStartIndex(renderItems, WINDOW_MAX_ROWS);
  const hiddenEarlierCount = windowStart;

  // One coarse, deduplicated live-activity phase for screen readers (Issue
  // #628). The DOM text changes only on a phase transition, so an assistive
  // technology announces one meaningful change — never every low-level tool event.
  const liveActivity = deriveLiveActivity(activityIndicator, renderItems, sessionState, turns);
  const liveAnnouncement =
    liveActivity === "idle" ? "" : translateMessage(turnLocale, LIVE_ACTIVITY_KEY[liveActivity]);

  let assistantAvatarShownInTurn = false;

  const claimTurnAvatar = () => {
    const showAvatar = !assistantAvatarShownInTurn;
    assistantAvatarShownInTurn = true;
    return showAvatar;
  };

  const renderActivityIndicator = () => {
    switch (activityIndicator) {
      case "tool": {
        if (!activeTool) return null;
        // The active turn's completed steps are held back from the timeline
        // during the turn (they collapse into the fold once it ends). Offer them
        // as click-to-expand detail behind the live line.
        const detailBlocks = renderItems
          .filter(
            (ri): ri is Extract<ChatRenderItem, { kind: "execution" }> =>
              ri.kind === "execution" && ri.block.turnId === activeTurnId && ri.block.status !== "running",
          )
          .map((ri) => ri.block);
        return (
          <AssistantColumnRow showAvatar={claimTurnAvatar()}>
            <LiveToolLine
              label={toolRunningActionLabel(activeTool, turnLocale, activeToolSkillName)}
              detailBlocks={detailBlocks}
            />
          </AssistantColumnRow>
        );
      }
      case "responding":
        return (
          <AssistantColumnRow showAvatar={claimTurnAvatar()}>
            <div data-testid="chat-responding-status-line" className="flex items-center gap-2 py-1 text-xs text-ink/40">
              <Loader2 aria-hidden="true" className="h-3.5 w-3.5 shrink-0 animate-spin text-accent" strokeWidth={2} />
              <span>{translateMessage(turnLocale, "chat.status.responding")}</span>
            </div>
          </AssistantColumnRow>
        );
      case "thinking":
      case "working":
        return (
          <AssistantColumnRow showAvatar={claimTurnAvatar()}>
            <div data-testid="chat-thinking-indicator" className="flex items-center gap-2 py-1.5">
              <div className="flex items-center gap-2 py-1">
                <Loader2 aria-hidden="true" className="h-3.5 w-3.5 shrink-0 animate-spin text-accent" strokeWidth={2} />
                <span className="text-xs text-ink/40">
                  {translateMessage(turnLocale, activityIndicator === "working" ? "chat.status.working" : "chat.status.thinking")}
                </span>
              </div>
            </div>
          </AssistantColumnRow>
        );
      case "none":
        return null;
    }
  };

  const renderTimelineItem = (ri: ChatRenderItem, renderIndex: number) => {
    if (ri.kind === "execution") {
      // Interruption is server-authoritative. Foreground IDLE is expected after
      // a detached DAG handoff and must never be used to guess that a live
      // background turn died. Startup recovery terminalizes real orphans in
      // the turn envelope; turn projection carries that status into the block.
      // During an active turn the live line is the sole status owner. A terminal
      // disclosure from that same turn is held back until the turn itself is terminal.
      if (sessionState !== "IDLE" && ri.block.status !== "running" && ri.block.turnId === activeTurnId) return null;
      const showAvatar = claimTurnAvatar();
      return (
        <AssistantColumnRow key={ri.block.key} showAvatar={showAvatar}>
          <ExecutionBlock block={ri.block} />
        </AssistantColumnRow>
      );
    }
    const { item, index } = ri;
    switch (item.type) {
      case "message": {
        const msg = item.data as ChatMessage;
        if (msg.role === "user") {
          assistantAvatarShownInTurn = false;
        }
        // An assistant answer regenerates by re-running the user prompt that
        // produced it — the nearest visible user message before it.
        const regenerateText =
          msg.role === "assistant"
            ? deterministicProjection
              ? precedingProjectedUserPrompt(renderItems, renderIndex)
              : precedingUserPrompt(timeline, index)
            : undefined;
        const assistantMessageRenders =
          msg.role === "assistant" &&
          (hasRenderableAssistantContent(msg) || Boolean(msg.streaming && msg.requestId));
        const showAvatar = msg.role === "assistant" ? !assistantAvatarShownInTurn : true;
        if (assistantMessageRenders) {
          assistantAvatarShownInTurn = true;
        }
        // Stable identity: the timeline is mutated in place (stream upserts,
        // artifact patches, dropped empty messages) — index keys would let
        // React reuse the wrong component instance across those edits.
        return (
          <MessageBubble
            key={msg.id ?? index}
            message={msg}
            onRegenerate={onRegenerate}
            regenerateText={regenerateText}
            showAvatar={showAvatar}
            showAssistantActions={isLastAssistantTextInTurn(renderItems, renderIndex, msg)}
            onDelete={sessionState === "IDLE" && /^conversation:\d+$/.test(msg.id) ? onDeleteMessage : undefined}
            onOpenArtifact={onOpenArtifact}
            onOpenModelSettings={onOpenModelSettings}
          />
        );
      }
      case "approval_request":
        // An approval belongs INSIDE the assistant's turn — align it into
        // the content column (indented past the avatar), not at the avatar's
        // own left edge as a top-level peer.
        return (
          <AssistantColumnRow key={(item.data as ApprovalRequest).id ?? index}>
            <ApprovalCard
              request={item.data as ApprovalRequest}
              onApprove={onApprove}
              onReject={onReject}
            />
          </AssistantColumnRow>
        );
      case "artifact":
        if (isIntermediateFileArtifact(item.data as Artifact)) return null;
        return (
          <AssistantColumnRow key={(item.data as Artifact).id ?? index}>
            <ArtifactCard artifact={item.data as Artifact} onOpen={onOpenArtifact} />
          </AssistantColumnRow>
        );
      case "memory_update":
        return (
          <AssistantColumnRow key={`memory-${item.turnId ?? index}`}>
            <MemoryUpdateNotice update={item.data as MemoryUpdate} onOpen={onOpenMemory} />
          </AssistantColumnRow>
        );
      default:
        return null;
    }
  };

  // Build the ordered row list once. The live activity indicator always renders
  // at the very bottom of the timeline: with the active turn's terminal blocks
  // held back, the newest narration is the bottom row and the single indicator
  // reads as "what MOZI is doing right now". (The old mid-timeline anchor placed
  // it at the turn's FIRST execution item, which floated a spinner between
  // paragraphs in multi-phase turns.) Windowing drops only a leading prefix;
  // every mounted row is wrapped for keyboard/screen-reader navigation.
  const { groups: turnFoldGroups, folded: foldedRowIndices } = buildTurnFolds(renderItems);
  const rows: Array<{ key: string; node: ReactNode }> = [];
  const pushRow = (ri: ChatRenderItem, index: number) => {
    const node = renderTimelineItem(ri, index);
    if (node) rows.push({ key: renderRowKey(ri, index), node });
  };
  for (let i = windowStart; i < renderItems.length; i++) {
    const foldGroup = turnFoldGroups.get(i);
    if (foldGroup) {
      rows.push({
        key: foldGroup.key,
        node: (
          <AssistantColumnRow showAvatar={claimTurnAvatar()}>
            <TurnFold group={foldGroup} />
          </AssistantColumnRow>
        ),
      });
      continue;
    }
    if (foldedRowIndices.has(i)) continue;
    pushRow(renderItems[i], i);
  }
  {
    const indicator = renderActivityIndicator();
    if (indicator) rows.push({ key: "activity-indicator", node: indicator });
  }

  return (
    <div className="relative min-h-0 flex-1">
      {/* One deduplicated, coarse live-activity announcement for assistive tech. */}
      <div data-testid="chat-live-status" role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {liveAnnouncement}
      </div>
      <div
        ref={scrollRegionRef}
        data-testid="chat-scroll-region"
        className="h-full overflow-y-auto"
        onScroll={handleScroll}
      >
        <div
          data-testid="chat-timeline-rail"
          role="feed"
          tabIndex={0}
          aria-busy={sessionState !== "IDLE"}
          aria-label={t("chat.timeline.ariaLabel")}
          onKeyDown={handleFeedKeyDown}
          className="mx-auto flex w-full max-w-[1240px] flex-col gap-3 px-6 py-6 sm:px-8 lg:px-16 lg:py-8"
        >
          {hiddenEarlierCount > 0 && (
            <button
              type="button"
              data-testid="chat-show-earlier"
              onClick={() => setShowEarlier(true)}
              className="mx-auto mb-1 inline-flex h-8 items-center rounded-full border border-ink/[0.12] px-3 text-[12px] text-ink/55 transition-colors hover:border-ink/[0.2] hover:text-ink/85"
            >
              {translateMessage(turnLocale, "chat.timeline.showEarlier", { count: String(hiddenEarlierCount) })}
            </button>
          )}
          {rows.map(({ key, node }, mountedIndex) => (
            <div
              key={key}
              data-chat-row
              role="article"
              aria-posinset={hiddenEarlierCount + mountedIndex + 1}
              aria-setsize={renderItems.length + (activityIndicator !== "none" ? 1 : 0)}
              tabIndex={0}
              className="rounded-md outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              {node}
            </div>
          ))}
        </div>
      </div>
      {!autoFollow && (
        <div className="pointer-events-none absolute inset-x-0 bottom-4 z-20 flex justify-center px-4">
          <button
            type="button"
            data-testid="chat-jump-to-latest"
            onClick={() => scrollToLatest()}
            className="pointer-events-auto inline-flex h-8 items-center gap-2 rounded-full border border-ink/[0.12] bg-base/95 px-3 text-[12px] text-ink/65 shadow-lg backdrop-blur transition-colors hover:border-ink/[0.2] hover:text-ink/90"
          >
            {sessionState !== "IDLE" && <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin text-accent" />}
            <span>{sessionState !== "IDLE" ? t("chat.follow.responding") : t("chat.follow.latest")}</span>
            <ArrowDown aria-hidden="true" className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}
