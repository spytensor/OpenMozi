import { fireEvent, screen, renderWithLocale, within } from "@/test/render";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Artifact, ChatMessage, SessionState, TimelineItem, ToolEvent } from "@/types";
import ChatView from "./ChatView";

function message(
  role: ChatMessage["role"],
  content: string,
  timestamp: number,
  overrides: Partial<ChatMessage> = {},
): TimelineItem {
  return {
    type: "message",
    timestamp,
    data: {
      id: `${role}-${timestamp}`,
      role,
      content,
      timestamp,
      ...overrides,
    } satisfies ChatMessage,
  };
}

function toolEvent(
  callId: string,
  timestamp: number,
  turnId?: string,
  overrides: Partial<ToolEvent> = {},
): TimelineItem {
  return {
    type: "tool_event",
    timestamp,
    data: {
      id: `tool-${callId}`,
      callId,
      turnId,
      tool: "web_search",
      phase: "end",
      status: "success",
      intent: "Search the project",
      result: "Done",
      elapsed_ms: 9_000,
      timestamp,
      ...overrides,
    } satisfies ToolEvent,
  };
}

function artifactItem(timestamp: number, overrides: Partial<Artifact> = {}): TimelineItem {
  const artifact: Artifact = {
    id: overrides.id ?? `artifact-${timestamp}`,
    plugin_id: overrides.plugin_id,
    title: overrides.title ?? "Live deck",
    status: overrides.status ?? "completed",
    fallback_text: overrides.fallback_text,
    data: overrides.data ?? { content_type: "html" },
    timestamp: overrides.timestamp ?? timestamp,
  };
  return { type: "artifact", timestamp, data: artifact };
}

function hasExactClass(element: HTMLElement, className: string) {
  return element.className.split(/\s+/).includes(className);
}

function activityIndicatorCount() {
  return [
    ...screen.queryAllByTestId("chat-responding-status-line"),
    ...screen.queryAllByTestId("chat-active-tool-line"),
    ...screen.queryAllByTestId("chat-thinking-indicator"),
    ...screen.queryAllByTestId("execution-live-line"),
  ].length;
}

function renderChat(
  timeline: TimelineItem[],
  options: {
    sessionId?: string;
    sessionState?: SessionState;
    activeTool?: string | null;
    activeToolSkillName?: string | null;
    activeTurnId?: string | null;
    timelineCapabilities?: string[];
    turns?: import("@/types").TurnEnvelope[];
    onSend?: (content: string) => void;
    onRegenerate?: (content: string) => void;
    onOpenMemory?: () => void;
  } = {},
) {
  const onSend = options.onSend ?? vi.fn();
  const onRegenerate = options.onRegenerate ?? vi.fn();
  return renderWithLocale(
    <ChatView
      sessionId={options.sessionId}
      timeline={timeline}
      sessionState={options.sessionState ?? "IDLE"}
      activeTool={options.activeTool ?? null}
      activeToolSkillName={options.activeToolSkillName}
      activeTurnId={options.activeTurnId}
      timelineCapabilities={options.timelineCapabilities}
      turns={options.turns}
      onApprove={vi.fn()}
      onReject={vi.fn()}
      onSend={onSend}
      onRegenerate={onRegenerate}
      onOpenMemory={options.onOpenMemory}
    />,
  );
}

describe("ChatView", () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: vi.fn(),
    });
  });

  it("renders a restored memory update as a quiet action that opens Memory", () => {
    const onOpenMemory = vi.fn();
    renderChat([
      message("user", "Remember that I prefer concise replies", 1, { turnId: "turn-memory" }),
      {
        type: "memory_update",
        timestamp: 2,
        turnId: "turn-memory",
        seq: 2,
        data: {
          count: 1, added: 1, reinforced: 0, updated: 0,
          factIds: [41], timestamp: 2, turnId: "turn-memory", seq: 2,
        },
      },
    ], { onOpenMemory });

    fireEvent.click(screen.getByRole("button", { name: "Saved to memory. Open memory" }));
    expect(onOpenMemory).toHaveBeenCalledOnce();
  });

  it("places active conversation content inside the centered workspace reading rail", () => {
    renderChat([
      message("user", "Research OpenClaw", 1),
      message("assistant", "Here is the report.", 2),
    ]);

    const scrollRegion = screen.getByTestId("chat-scroll-region");
    const rail = screen.getByTestId("chat-timeline-rail");

    expect(scrollRegion).toContainElement(rail);
    expect(scrollRegion.className).toContain("overflow-y-auto");
    expect(rail.className).toContain("mx-auto");
    expect(rail.className).toContain("max-w-[1240px]");
    expect(rail.className).toContain("px-6");
    expect(screen.getByTestId("message-user")).toBeInTheDocument();
    expect(screen.getByTestId("message-assistant")).toBeInTheDocument();
  });

  it("pauses auto-follow when the user scrolls up and resumes from the latest button", () => {
    renderChat(
      [message("user", "Write a long answer", 1), message("assistant", "Streaming answer", 2, { streaming: true })],
      { sessionState: "RESPONDING" },
    );
    const region = screen.getByTestId("chat-scroll-region");
    Object.defineProperties(region, {
      scrollHeight: { configurable: true, value: 1200 },
      clientHeight: { configurable: true, value: 500 },
      scrollTop: { configurable: true, writable: true, value: 200 },
    });

    fireEvent.scroll(region);

    const jumpButton = screen.getByTestId("chat-jump-to-latest");
    expect(jumpButton).toHaveTextContent("MOZI is responding · Jump to latest");

    fireEvent.click(jumpButton);

    expect(region.scrollTo).toHaveBeenCalledWith({ top: 1200, behavior: "auto" });
    expect(screen.queryByTestId("chat-jump-to-latest")).not.toBeInTheDocument();
  });

  it("resumes auto-follow when the user manually returns near the bottom", () => {
    renderChat([message("user", "Review this", 1), message("assistant", "Answer", 2)]);
    const region = screen.getByTestId("chat-scroll-region");
    Object.defineProperties(region, {
      scrollHeight: { configurable: true, value: 1200 },
      clientHeight: { configurable: true, value: 500 },
      scrollTop: { configurable: true, writable: true, value: 100 },
    });
    fireEvent.scroll(region);
    expect(screen.getByTestId("chat-jump-to-latest")).toHaveTextContent("Jump to latest");

    region.scrollTop = 665;
    fireEvent.scroll(region);

    expect(screen.queryByTestId("chat-jump-to-latest")).not.toBeInTheDocument();
  });

  it("shows the quiet empty state suggestions and sends their prompts", () => {
    const onSend = vi.fn();
    const onRegenerate = vi.fn();
    renderWithLocale(
      <ChatView
        timeline={[]}
        sessionState="IDLE"
        activeTool={null}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onSend={onSend}
        onRegenerate={onRegenerate}
      />,
      { locale: "en" },
    );

    expect(screen.getByText("What are we doing today?")).toBeInTheDocument();
    expect(screen.getByText("Start with a task, a question, or something to build.")).toBeInTheDocument();
    expect(screen.getAllByText("↗")).toHaveLength(3);

    fireEvent.click(screen.getByRole("button", { name: "Research a topic for me" }));

    expect(onSend).toHaveBeenCalledWith("Research a topic for me");
    expect(onRegenerate).not.toHaveBeenCalled();
  });

  it("folds interim assistant text into one quiet disclosure and keeps a single avatar", () => {
    renderChat([
      message("user", "Research OpenClaw", 1),
      message("assistant", "I will check.", 2),
      message("assistant", "Here is the report.", 3),
    ]);

    // Only the final answer stays full-size; the interim narration lives in the fold.
    expect(screen.getAllByTestId("message-assistant")).toHaveLength(1);
    expect(screen.getByText("Here is the report.")).toBeInTheDocument();
    expect(screen.queryByText("I will check.")).not.toBeInTheDocument();
    expect(screen.getAllByTestId("mozi-avatar")).toHaveLength(1);
    expect(screen.getByTestId("mozi-avatar").querySelector("img")).toHaveAttribute("src", "/mozi-mark.png");

    fireEvent.click(screen.getByTestId("turn-fold-summary"));
    expect(screen.getByText("I will check.")).toBeInTheDocument();
  });

  it("shows an approximate minutes-only duration on the fold for long multi-phase work", () => {
    const t0 = 1_700_000_000_000;
    renderChat([
      { ...message("user", "梳理一下这个项目", 1), timestamp: t0 },
      { ...message("assistant", "先让我全面了解项目结构。", 2), timestamp: t0 + 1_000 },
      toolEvent("phase-1", t0 + 2_000, "turn-1", { timestamp: t0 + 2_000 }),
      { ...message("assistant", "继续查看架构文档。", 3), timestamp: t0 + 3_000 },
      toolEvent("phase-2", t0 + 435_000, "turn-1", { timestamp: t0 + 435_000 }),
      { ...message("assistant", "文档已经生成完毕。", 4), timestamp: t0 + 436_000 },
    ]);

    const summary = screen.getByTestId("turn-fold-summary");
    expect(summary.textContent).toContain("查看处理过程");
    expect(summary.textContent).toContain("约 7 分钟");
    expect(summary.textContent).not.toMatch(/毫秒|ms|秒/);
  });

  it("leaves no successful execution residue beside a simple final answer", () => {
    renderChat([
      message("user", "Research the models", 1),
      toolEvent("search-1", 2, "turn-1"),
      message("assistant", "Here is the final comparison.", 3),
    ]);

    expect(screen.queryByTestId("execution-summary")).not.toBeInTheDocument();
    expect(screen.getAllByTestId("mozi-avatar")).toHaveLength(1);
    expect(screen.getByTestId("mozi-avatar").querySelector(".animate-pulse")).toBeNull();
  });

  it("renders interim assistant turn fragments without actions and keeps the final answer actionable", () => {
    const onSend = vi.fn();
    const onRegenerate = vi.fn();
    renderChat(
      [
        message("user", "Make the app.", 1),
        message("assistant", "信息够了，我先检查环境。", 2),
        toolEvent("search-1", 3, "turn-1"),
        message("assistant", "好的，环境就绪。现在开始制作。", 4),
        toolEvent("build-1", 5, "turn-1"),
        message("assistant", "完成了，可以在本地查看。", 6),
      ],
      { onSend, onRegenerate },
    );

    // Interim fragments and their successful work fold; the answer stands alone.
    const assistantMessages = screen.getAllByTestId("message-assistant");
    expect(assistantMessages).toHaveLength(1);
    expect(screen.getAllByTestId("mozi-avatar")).toHaveLength(1);
    expect(screen.queryByText("信息够了，我先检查环境。")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("turn-fold-summary"));
    const foldContent = screen.getByTestId("turn-fold-content");
    expect(within(foldContent).getAllByTestId("turn-fold-narration")).toHaveLength(2);
    for (const interim of within(foldContent).getAllByTestId("turn-fold-narration")) {
      expect(within(interim).queryByRole("button", { name: "Copy" })).not.toBeInTheDocument();
      expect(within(interim).queryByRole("button", { name: "Regenerate" })).not.toBeInTheDocument();
    }

    const finalMessage = assistantMessages[0];
    const finalContent = within(finalMessage).getByTestId("message-assistant-content");
    expect(hasExactClass(finalContent, "text-ink/70")).toBe(false);
    expect(within(finalMessage).getByRole("button", { name: "Copy" })).toBeInTheDocument();
    fireEvent.click(within(finalMessage).getByRole("button", { name: "Regenerate" }));
    expect(onRegenerate).toHaveBeenCalledWith("Make the app.");
    expect(onSend).not.toHaveBeenCalled();
  });

  it("keeps one MOZI avatar across progress text, tools, artifacts, and the final answer", () => {
    renderChat([
      message("user", "Create a Word report.", 1),
      message("assistant", "I will inspect the project first.", 2),
      toolEvent("inspect-1", 3, "turn-1"),
      artifactItem(4, { title: "report.docx", plugin_id: "file_v1" }),
      message("assistant", "The report is ready.", 5),
    ]);

    // Narration and successful work fold; the deliverable artifact and the
    // final answer remain visible with one shared avatar.
    expect(screen.getAllByTestId("message-assistant")).toHaveLength(1);
    expect(screen.getByText("The report is ready.")).toBeInTheDocument();
    expect(screen.getByText("report.docx")).toBeInTheDocument();
    expect(screen.getByTestId("turn-fold-summary")).toBeInTheDocument();
    expect(screen.getAllByTestId("mozi-avatar")).toHaveLength(1);
  });

  it("hides persisted build metadata artifacts while keeping the user deliverable", () => {
    renderChat([
      message("user", "Create a Word report.", 1),
      artifactItem(2, {
        id: "build-metadata",
        title: "build_script_build-deadbeef.d",
        plugin_id: "file_v1",
        data: { filename: "build_script_build-deadbeef.d", path: "/project/target/debug/build_script_build-deadbeef.d" },
      }),
      artifactItem(3, {
        id: "generator",
        title: "generate_report.js",
        plugin_id: "file_v1",
        data: { filename: "generate_report.js", path: "/project/generate_report.js" },
      }),
      artifactItem(4, {
        id: "deliverable",
        title: "report.docx",
        plugin_id: "file_v1",
        data: { filename: "report.docx", path: "/project/report.docx" },
      }),
    ]);

    expect(screen.queryByText("build_script_build-deadbeef.d")).not.toBeInTheDocument();
    expect(screen.queryByText("generate_report.js")).not.toBeInTheDocument();
    expect(screen.getByText("report.docx")).toBeInTheDocument();
  });

  it("routes message regenerate actions through onRegenerate, not onSend", () => {
    const onSend = vi.fn();
    const onRegenerate = vi.fn();
    renderChat(
      [
        message("user", "Draft the plan.", 1),
        message("assistant", "Here is the plan.", 2),
      ],
      { onSend, onRegenerate },
    );

    fireEvent.click(within(screen.getByTestId("message-user")).getByRole("button", { name: "Regenerate" }));
    expect(onRegenerate).toHaveBeenCalledWith("Draft the plan.");
    expect(onSend).not.toHaveBeenCalled();

    fireEvent.click(within(screen.getByTestId("message-assistant")).getByRole("button", { name: "Regenerate" }));
    expect(onRegenerate).toHaveBeenCalledTimes(2);
    expect(onRegenerate).toHaveBeenLastCalledWith("Draft the plan.");
    expect(onSend).not.toHaveBeenCalled();
  });

  it("keeps actions on a single assistant answer turn", () => {
    renderChat([
      message("user", "Research OpenClaw", 1),
      message("assistant", "Here is the report.", 2),
    ]);

    const assistant = screen.getByTestId("message-assistant");

    expect(within(assistant).getByRole("button", { name: "Copy" })).toBeInTheDocument();
    expect(within(assistant).getByRole("button", { name: "Regenerate" })).toBeInTheDocument();
  });

  it("does not let an empty assistant message consume the turn avatar", () => {
    renderChat([
      message("user", "Research OpenClaw", 1),
      message("assistant", " \n\n ", 2),
      message("assistant", "Here is the report.", 3),
    ]);

    expect(screen.getAllByTestId("message-assistant")).toHaveLength(1);
    expect(screen.getAllByTestId("mozi-avatar")).toHaveLength(1);
  });

  it("shows thinking while a turn is running before answer text exists", () => {
    renderChat([message("user", "Research OpenClaw", 1)], { sessionState: "WORKING" });

    expect(screen.getByText("Thinking...")).toBeInTheDocument();
    expect(screen.queryByText("Responding...")).not.toBeInTheDocument();
  });

  it("keeps a single working indicator as the sole status owner until the current turn terminalizes", () => {
    renderChat([
      message("user", "Inspect this project", 1),
      message("assistant", "I will inspect the project first.", 2),
      toolEvent("inspect-1", 3, "turn-1"),
    ], { sessionState: "WORKING", activeTurnId: "turn-1" });

    const indicator = screen.getByTestId("chat-thinking-indicator");
    expect(indicator).toBeInTheDocument();
    // Mid-turn the honest label is continued work, not a fresh "Thinking...".
    expect(screen.getByText("Working...")).toBeInTheDocument();
    expect(screen.queryByText("Thinking...")).not.toBeInTheDocument();
    expect(screen.queryByTestId("execution-summary")).not.toBeInTheDocument();
    expect(document.querySelectorAll(".animate-spin")).toHaveLength(1);
    expect(screen.getByTestId("mozi-avatar").querySelector(".animate-pulse")).toBeNull();
  });

  it("renders the live indicator as the last feed row in a multi-phase turn", () => {
    renderChat([
      message("user", "Organize this project", 1),
      message("assistant", "Let me inspect the structure first.", 2),
      toolEvent("phase-1", 3, "turn-1"),
      message("assistant", "It is a Rust project. Reading core files.", 4),
      toolEvent("phase-2", 5, "turn-1"),
      message("assistant", "Now generating the document.", 6),
    ], { sessionState: "WORKING", activeTurnId: "turn-1" });

    const rowNodes = [...document.querySelectorAll("[data-chat-row]")];
    expect(rowNodes.length).toBeGreaterThan(1);
    const lastRow = rowNodes[rowNodes.length - 1] as HTMLElement;
    expect(lastRow.querySelector('[data-testid="chat-thinking-indicator"]')).not.toBeNull();
    // No suppressed same-turn block resurfaces above it, and only one spinner exists.
    expect(screen.queryByTestId("execution-summary")).not.toBeInTheDocument();
    expect(document.querySelectorAll(".animate-spin")).toHaveLength(1);
  });

  it("does not show fallback thinking while a current-turn artifact is running", () => {
    renderChat(
      [
        message("user", "Create a deck", 1),
        artifactItem(2, {
          plugin_id: "live_work_v1",
          status: "running",
          data: { content_type: "html", live_preview: true, phase: "writing" },
        }),
      ],
      { sessionState: "WORKING" },
    );

    expect(screen.getByText("Generating")).toBeInTheDocument();
    expect(screen.queryByText("Thinking...")).not.toBeInTheDocument();
    expect(screen.queryByText("Responding...")).not.toBeInTheDocument();
  });

  it("shows fallback thinking after a current-turn artifact completes while the turn is still working", () => {
    renderChat(
      [
        message("user", "Create a deck", 1),
        artifactItem(2, {
          plugin_id: "live_work_v1",
          status: "completed",
          data: { content_type: "html", live_preview: true, phase: "writing" },
        }),
      ],
      { sessionState: "WORKING" },
    );

    expect(screen.getByText("Working...")).toBeInTheDocument();
    expect(screen.queryByText("Thinking...")).not.toBeInTheDocument();
  });

  it("does not show an extra indicator when the last item is visible streaming assistant text", () => {
    renderChat(
      [
        message("user", "Research OpenClaw", 1),
        message("assistant", "Partial answer", 2, { streaming: true, requestId: "req-1" }),
      ],
      { sessionState: "RESPONDING" },
    );

    expect(screen.queryByTestId("chat-responding-status-line")).not.toBeInTheDocument();
    expect(screen.queryByTestId("chat-thinking-indicator")).not.toBeInTheDocument();
    expect(screen.queryByTestId("chat-active-tool-line")).not.toBeInTheDocument();
  });

  it("shows responding while a streaming assistant message has no visible content yet", () => {
    renderChat(
      [
        message("user", "Research OpenClaw", 1),
        message("assistant", "", 2, { streaming: true, requestId: "req-1" }),
      ],
      { sessionState: "RESPONDING" },
    );

    expect(screen.getByTestId("chat-responding-status-line")).toHaveTextContent("Responding...");
    expect(screen.queryByTestId("chat-thinking-indicator")).not.toBeInTheDocument();
    expect(screen.queryByTestId("chat-active-tool-line")).not.toBeInTheDocument();
  });

  it("renders at most one extra activity indicator across representative states", () => {
    const cases: Array<{
      name: string;
      timeline: TimelineItem[];
      sessionState: SessionState;
      activeTool?: string | null;
    }> = [
      {
        name: "idle",
        timeline: [message("user", "Research OpenClaw", 1)],
        sessionState: "IDLE",
      },
      {
        name: "thinking",
        timeline: [message("user", "Research OpenClaw", 1)],
        sessionState: "WORKING",
      },
      {
        name: "tool active",
        timeline: [message("user", "Search the web", 1)],
        sessionState: "WORKING",
        activeTool: "web_search",
      },
      {
        name: "streaming with content",
        timeline: [
          message("user", "Research OpenClaw", 1),
          message("assistant", "Partial answer", 2, { streaming: true, requestId: "req-1" }),
        ],
        sessionState: "RESPONDING",
      },
      {
        name: "streaming empty",
        timeline: [
          message("user", "Research OpenClaw", 1),
          message("assistant", "", 2, { streaming: true, requestId: "req-1" }),
        ],
        sessionState: "RESPONDING",
      },
      {
        name: "running artifact",
        timeline: [
          message("user", "Create a deck", 1),
          artifactItem(2, {
            plugin_id: "live_work_v1",
            status: "running",
            data: { content_type: "html", live_preview: true, phase: "writing" },
          }),
        ],
        sessionState: "WORKING",
      },
    ];

    for (const activityCase of cases) {
      const { unmount } = renderChat(activityCase.timeline, {
        sessionState: activityCase.sessionState,
        activeTool: activityCase.activeTool,
      });

      expect(activityIndicatorCount(), activityCase.name).toBeLessThanOrEqual(1);
      unmount();
    }
  });

  it("shows the active tool label instead of thinking or responding", () => {
    renderChat([message("user", "Search the web", 1)], {
      sessionState: "WORKING",
      activeTool: "web_search",
    });

    expect(screen.getByText("Searching public information")).toBeInTheDocument();
    expect(screen.queryByText("Thinking...")).not.toBeInTheDocument();
    expect(screen.queryByText("Responding...")).not.toBeInTheDocument();
  });

  it("keeps the live running tool event visible near the bottom without adding a duplicate indicator", () => {
    renderChat(
      [
        message("user", "Search the web", 1),
        toolEvent("search-1", 2, "turn-1", { phase: "start", status: undefined }),
      ],
      { sessionState: "WORKING", activeTurnId: "turn-1" },
    );

    expect(screen.getByTestId("execution-live-line")).toHaveTextContent("Search the project");
    expect(screen.queryByTestId("chat-active-tool-line")).not.toBeInTheDocument();
    expect(screen.queryByText("Thinking...")).not.toBeInTheDocument();
    expect(activityIndicatorCount()).toBe(1);
  });

  it("keeps a background running tool live when the foreground session is idle", () => {
    const timeline = [
      message("user", "Search the web", 1),
      toolEvent("search-1", 2, "turn-1", { phase: "start", status: undefined }),
    ];
    const { rerender } = renderWithLocale(
      <ChatView
        timeline={timeline}
        sessionState="WORKING"
        activeTool={null}
        activeTurnId="turn-1"
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onSend={vi.fn()}
        onRegenerate={vi.fn()}
      />,
      { locale: "en" },
    );

    expect(screen.getByTestId("execution-live-line")).toHaveTextContent("Search the project");

    rerender(
      <ChatView
        timeline={timeline}
        sessionState="IDLE"
        activeTool={null}
        activeTurnId={null}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onSend={vi.fn()}
        onRegenerate={vi.fn()}
      />,
    );

    expect(screen.getByTestId("execution-live-line")).toHaveTextContent("Search the project");
    expect(screen.queryByTestId("chat-active-tool-line")).not.toBeInTheDocument();
    expect(screen.queryByText("Thinking...")).not.toBeInTheDocument();
    expect(screen.queryByText(/runtime restarted/i)).not.toBeInTheDocument();
  });

  it("keeps raw skill identifiers out of the normal live line", () => {
    renderWithLocale(
      <ChatView
        timeline={[message("user", "Use imagegen", 1)]}
        sessionState="WORKING"
        activeTool="use_skill"
        activeToolSkillName="imagegen"
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onSend={vi.fn()}
        onRegenerate={vi.fn()}
      />,
      { locale: "en" },
    );

    expect(screen.getByTestId("chat-active-tool-line")).toHaveTextContent("Loading skill");
    expect(screen.getByTestId("chat-active-tool-line")).not.toHaveTextContent("imagegen");
  });
});

describe("ChatView deterministic turn projection (Issue #625)", () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
    Element.prototype.scrollTo = vi.fn();
  });

  const CAPS = ["timeline_v1"];

  function idMessage(role: ChatMessage["role"], content: string, turnId: string, seq: number): TimelineItem {
    return {
      type: "message",
      timestamp: 1000 + seq,
      turnId,
      seq,
      data: { id: `${role}-${turnId}-${seq}`, role, content, timestamp: 1000 + seq, turnId, seq },
    };
  }

  function idTool(turnId: string, callId: string, seq: number, overrides: Partial<ToolEvent> = {}): TimelineItem {
    return {
      type: "tool_event",
      timestamp: 1000 + seq,
      turnId,
      seq,
      data: {
        id: `tool-${callId}`,
        callId,
        turnId,
        seq,
        tool: "web_search",
        phase: "end",
        status: "success",
        intent: "Search the project",
        result: "Done",
        elapsed_ms: 9_000,
        timestamp: 1000 + seq,
        ...overrides,
      } satisfies ToolEvent,
    };
  }

  it("renders exactly one MOZI avatar per turn", () => {
    renderChat(
      [
        idMessage("user", "first question", "turn_1000", 1),
        idTool("turn_1000", "c1", 2, { status: "error", error: "boom", elapsed_ms: 9_000 }),
        idMessage("assistant", "first answer", "turn_1000", 3),
        idMessage("user", "second question", "turn_2000", 1),
        idTool("turn_2000", "c2", 2, { status: "error", error: "bang", elapsed_ms: 9_000 }),
        idMessage("assistant", "second answer", "turn_2000", 3),
      ],
      { timelineCapabilities: CAPS },
    );

    // One avatar per turn — not one per assistant row.
    expect(screen.getAllByTestId("mozi-avatar")).toHaveLength(2);
    expect(screen.getByText("first answer")).toBeInTheDocument();
    expect(screen.getByText("second answer")).toBeInTheDocument();
  });

  it("renders a pre-answer failure before the answer (true chronology)", () => {
    renderChat(
      [
        idMessage("user", "do it", "turn_1", 1),
        idTool("turn_1", "c1", 2, { status: "error", error: "denied", elapsed_ms: 9_000 }),
        idMessage("assistant", "here is the result", "turn_1", 3),
      ],
      { timelineCapabilities: CAPS },
    );

    const rail = screen.getByTestId("chat-timeline-rail");
    // The survived failure folds into the turn fold, which precedes the answer.
    // A mid-turn error the turn moved past is normal process, so the completed
    // turn still reads as done (green), not as a failure.
    const foldSummary = within(rail).getByTestId("turn-fold-summary");
    expect(within(rail).getByTestId("turn-fold-done-dot")).toBeInTheDocument();
    expect(within(rail).queryByTestId("turn-fold-issue-dot")).not.toBeInTheDocument();
    const answer = within(rail).getByText("here is the result");
    expect(foldSummary.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.click(foldSummary);
    expect(within(screen.getByTestId("turn-fold-content")).getByTestId("execution-block-embedded")).toBeInTheDocument();
  });

  it("keeps legacy (uncapable) sessions on the frozen renderer", () => {
    // No capability advertised → frozen path; still renders the conversation.
    renderChat(
      [
        message("user", "legacy question", 1),
        message("assistant", "legacy answer", 2),
      ],
      {},
    );
    expect(screen.getByText("legacy question")).toBeInTheDocument();
    expect(screen.getByText("legacy answer")).toBeInTheDocument();
  });

  // ── Issue #628: accessibility, keyboard navigation, windowing, EN/ZH parity ──

  describe("accessible live status (Issue #628)", () => {
    it("exposes a single polite live region", () => {
      renderChat([message("user", "hi", 1), message("assistant", "hello", 2)]);
      const live = screen.getByTestId("chat-live-status");
      expect(live).toHaveAttribute("role", "status");
      expect(live).toHaveAttribute("aria-live", "polite");
      // Idle session announces nothing (no chatter for a settled conversation).
      expect(live).toHaveTextContent("");
    });

    it("announces one coarse activity phase — Responding — in the turn's language", () => {
      // A streaming assistant message with no renderable content yet → the
      // "responding" phase (before any answer text appears).
      const en = renderChat(
        [message("user", "hi", 1), message("assistant", "", 2, { streaming: true, requestId: "r1", turnId: "turn_1" })],
        { sessionState: "RESPONDING", timelineCapabilities: ["timeline_v1"], turns: [{ turnId: "turn_1", sessionId: "s", chatId: "c", origin: "user", status: "active", seqHighWater: 2, startedAt: 1, locale: "en" }] },
      );
      expect(screen.getByTestId("chat-live-status")).toHaveTextContent("MOZI is responding");
      en.unmount();

      // Same runtime state, Chinese turn locale carried on the envelope → the
      // screen-reader announcement is Chinese. This is the authoritative-path
      // parity: presentation language follows the carried locale, not the UI.
      renderChat(
        [message("user", "你好", 1), message("assistant", "", 2, { streaming: true, requestId: "r1", turnId: "turn_1" })],
        { sessionState: "RESPONDING", timelineCapabilities: ["timeline_v1"], turns: [{ turnId: "turn_1", sessionId: "s", chatId: "c", origin: "user", status: "active", seqHighWater: 2, startedAt: 1, locale: "zh-CN" }] },
      );
      expect(screen.getByTestId("chat-live-status")).toHaveTextContent("MOZI 正在回复");
    });

    function approvalRequest(status: "pending" | "approved" | "rejected"): TimelineItem {
      return {
        type: "approval_request",
        timestamp: 2,
        data: { id: "ap1", description: "Delete files?", status, timestamp: 2 } as never,
      };
    }

    it("announces a pending approval as the meaningful activity", () => {
      renderChat([message("user", "delete it", 1), approvalRequest("pending")], { sessionState: "WORKING" });
      expect(screen.getByTestId("chat-live-status")).toHaveTextContent("MOZI is waiting for your approval");
    });

    it("stops announcing waiting once the approval card is approved", () => {
      // After resolution the card is still the last render item, but the live
      // region must fall back to the session's real activity — not linger on
      // "waiting for your approval" (Issue #628).
      renderChat([message("user", "delete it", 1), approvalRequest("approved")], { sessionState: "IDLE" });
      const live = screen.getByTestId("chat-live-status");
      expect(live).not.toHaveTextContent("waiting for your approval");
      expect(live).toHaveTextContent("");
    });

    it("stops announcing waiting once the approval card is rejected", () => {
      renderChat([message("user", "delete it", 1), approvalRequest("rejected")], { sessionState: "IDLE" });
      const live = screen.getByTestId("chat-live-status");
      expect(live).not.toHaveTextContent("waiting for your approval");
      expect(live).toHaveTextContent("");
    });
  });

  describe("keyboard navigation (Issue #628)", () => {
    it("moves focus between timeline rows with Arrow keys and Home/End", () => {
      renderChat([
        message("user", "one", 1),
        message("assistant", "first answer", 2),
        message("user", "two", 3),
        message("assistant", "second answer", 4),
      ]);
      const rail = screen.getByTestId("chat-timeline-rail");
      expect(rail).toHaveAttribute("role", "feed");
      const rows = Array.from(document.querySelectorAll<HTMLElement>("[data-chat-row]"));
      expect(rows.length).toBeGreaterThanOrEqual(4);

      fireEvent.keyDown(rail, { key: "ArrowDown" });
      expect(document.activeElement).toBe(rows[0]);
      fireEvent.keyDown(rail, { key: "ArrowDown" });
      expect(document.activeElement).toBe(rows[1]);
      fireEvent.keyDown(rail, { key: "ArrowUp" });
      expect(document.activeElement).toBe(rows[0]);
      fireEvent.keyDown(rail, { key: "End" });
      expect(document.activeElement).toBe(rows[rows.length - 1]);
      fireEvent.keyDown(rail, { key: "Home" });
      expect(document.activeElement).toBe(rows[0]);
    });

    it("does not hijack navigation keys from controls inside a timeline row", () => {
      renderChat([message("user", "one", 1), message("assistant", "answer", 2)]);
      const copy = screen.getAllByRole("button", { name: "Copy" })[0];
      copy.focus();
      fireEvent.keyDown(copy, { key: "Home" });
      expect(document.activeElement).toBe(copy);
    });
  });

  describe("long-session windowing (Issue #628)", () => {
    function longTimeline(turnCount: number): TimelineItem[] {
      const items: TimelineItem[] = [];
      let ts = 0;
      for (let i = 0; i < turnCount; i++) {
        items.push(message("user", `question ${i}`, ++ts));
        items.push(message("assistant", `answer ${i}`, ++ts));
      }
      return items;
    }

    it("windows out the earlier prefix past the cap and reveals it on demand", () => {
      // 120 turns → 240 render rows, well past the 160-row cap.
      renderChat(longTimeline(120));
      // Earliest turn is hidden; a boundary-aligned prefix is collapsed.
      expect(screen.queryByText("question 0")).not.toBeInTheDocument();
      const showEarlier = screen.getByTestId("chat-show-earlier");
      expect(showEarlier).toHaveTextContent(/Show \d+ earlier messages/);
      // The most recent turn is always mounted (chronology preserved at the tail).
      expect(screen.getByText("answer 119")).toBeInTheDocument();

      fireEvent.click(showEarlier);
      expect(screen.getByText("question 0")).toBeInTheDocument();
      expect(screen.queryByTestId("chat-show-earlier")).not.toBeInTheDocument();
    });

    it("does not window a normal-length session", () => {
      renderChat(longTimeline(10));
      expect(screen.queryByTestId("chat-show-earlier")).not.toBeInTheDocument();
      expect(screen.getByText("question 0")).toBeInTheDocument();
    });

    it("resets an expanded history window when switching between two long sessions", () => {
      const first = longTimeline(120);
      const second = longTimeline(121).map((item) => item.type === "message"
        ? { ...item, data: { ...(item.data as ChatMessage), content: `B ${(item.data as ChatMessage).content}` } }
        : item);
      const { rerender } = renderChat(first, { sessionId: "session-a" });
      fireEvent.click(screen.getByTestId("chat-show-earlier"));
      expect(screen.getByText("question 0")).toBeInTheDocument();

      rerender(
        <ChatView
          sessionId="session-b"
          timeline={second}
          sessionState="IDLE"
          activeTool={null}
          onApprove={vi.fn()}
          onReject={vi.fn()}
          onSend={vi.fn()}
          onRegenerate={vi.fn()}
        />,
      );
      expect(screen.queryByText("B question 0")).not.toBeInTheDocument();
      expect(screen.getByTestId("chat-show-earlier")).toBeInTheDocument();
    });

    it("keeps the mounted DOM bounded for 500 authoritative turns, including background turns", () => {
      const timeline: TimelineItem[] = [];
      const turns: import("@/types").TurnEnvelope[] = [];
      for (let i = 0; i < 500; i++) {
        const turnId = `turn_bg_${i}`;
        timeline.push(message("assistant", `background result ${i}`, i + 1, { turnId, seq: 1 }));
        turns.push({
          turnId, sessionId: "long-session", chatId: "c", origin: "background",
          status: "completed", seqHighWater: 1, startedAt: i + 1, locale: i % 2 ? "en" : "zh-CN",
        });
      }
      const started = performance.now();
      renderChat(timeline, {
        sessionId: "long-session", timelineCapabilities: ["timeline_v1"], turns,
      });
      const elapsed = performance.now() - started;
      expect(document.querySelectorAll("[data-chat-row]").length).toBeLessThanOrEqual(161);
      expect(screen.getByText("background result 499")).toBeInTheDocument();
      // Generous jsdom budget: catches accidental all-500 DOM mounting while
      // remaining stable on slower CI machines. Pure projection has its tighter
      // 120 ms median budget in turn-projection.perf.test.ts.
      expect(elapsed).toBeLessThan(1_500);
    });

    it("transitions from the empty welcome state to a conversation without a hook-count error", () => {
      // Guards the rules-of-hooks ordering: the memoization/windowing hooks must
      // run before the empty-state early return, or this transition would throw
      // "rendered more hooks than during the previous render".
      const { rerender } = renderChat([], { sessionState: "IDLE" });
      // Welcome (empty) state took the early return — no timeline rail yet.
      expect(screen.queryByTestId("chat-timeline-rail")).not.toBeInTheDocument();
      expect(() =>
        rerender(
          <ChatView
            timeline={[message("user", "first question", 1), message("assistant", "first answer", 2)]}
            sessionState="IDLE"
            activeTool={null}
            onApprove={vi.fn()}
            onReject={vi.fn()}
            onSend={vi.fn()}
            onRegenerate={vi.fn()}
          />,
        ),
      ).not.toThrow();
      expect(screen.getByText("first answer")).toBeInTheDocument();
    });
  });
});
