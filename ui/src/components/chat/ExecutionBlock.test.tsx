import { fireEvent, screen, renderWithLocale } from "@/test/render";
import { describe, expect, it } from "vitest";
import { memo } from "react";
import type { ExecutionBlockModel } from "./execution";
import ExecutionBlock, { areExecutionBlockPropsEqual } from "./ExecutionBlock";

function failedSearchBlock(): ExecutionBlockModel {
  const rawError =
    "Error: web search failed — SEARCH1API_KEY environment variable is not set IMPORTANT: Do NOT answer this question from training data.";

  return {
    key: "turn-1",
    turnId: "turn-1",
    headline: "Searching the web",
    status: "error",
    toolCount: 3,
    taskCount: 0,
    issueCount: 3,
    totalElapsedMs: 2404,
    issueSummaries: [
      {
        key: "web-search-key",
        label: "search public information",
        detail: "Missing SEARCH1API_KEY",
        count: 3,
        latestTimestamp: 3,
      },
    ],
    tasks: [],
    tools: [1, 2, 3].map((index) => ({
      id: `tool-search-${index}`,
      callId: `search-${index}`,
      turnId: "turn-1",
      tool: "web_search",
      phase: "end",
      status: "error",
      error: rawError,
      elapsed_ms: index === 1 ? 2400 : 2,
      timestamp: index,
    })),
  };
}

function partialSourceBlock(): ExecutionBlockModel {
  const rawError = "Error: Crawl API error 502: Failed to crawl URL: Crawl service failed with status 500";

  return {
    key: "turn-2",
    turnId: "turn-2",
    headline: "Researching sources",
    status: "mixed",
    toolCount: 2,
    taskCount: 0,
    issueCount: 1,
    totalElapsedMs: 7400,
    issueSummaries: [
      {
        key: "source-unavailable",
        label: "search public information",
        detail: "Source temporarily unavailable",
        count: 1,
        latestTimestamp: 2,
      },
    ],
    tasks: [],
    tools: [
      {
        id: "tool-fetch-ok",
        callId: "fetch-ok",
        turnId: "turn-2",
        tool: "web_fetch",
        phase: "end",
        status: "success",
        intent: "https://example.com/success",
        result: "https://example.com/success",
        elapsed_ms: 2500,
        timestamp: 1,
      },
      {
        id: "tool-fetch-error",
        callId: "fetch-error",
        turnId: "turn-2",
        tool: "web_fetch",
        phase: "end",
        status: "error",
        intent: "https://example.com/unavailable",
        error: rawError,
        elapsed_ms: 4900,
        timestamp: 2,
      },
    ],
  };
}

function searchNoResultsBlock(): ExecutionBlockModel {
  return {
    key: "turn-search-empty",
    turnId: "turn-search-empty",
    headline: "Searching public information",
    status: "mixed",
    toolCount: 2,
    taskCount: 0,
    issueCount: 1,
    totalElapsedMs: 1200,
    issueSummaries: [
      {
        key: "search-empty",
        label: "search public information",
        detail: "Search returned no useful results",
        count: 1,
        latestTimestamp: 2,
      },
    ],
    tasks: [],
    tools: [
      {
        id: "tool-search-ok",
        callId: "search-ok",
        turnId: "turn-search-empty",
        tool: "web_search",
        phase: "end",
        status: "success",
        intent: "A股 基金",
        elapsed_ms: 600,
        timestamp: 1,
      },
      {
        id: "tool-search-empty",
        callId: "search-empty",
        turnId: "turn-search-empty",
        tool: "web_search",
        phase: "end",
        status: "error",
        error: 'Search API error 404: {"ok":false,"message":"No results found"}',
        elapsed_ms: 600,
        timestamp: 2,
      },
    ],
  };
}

function lifecycleTasks() {
  return [
    {
      id: "task-received",
      task_id: "turn-3:received",
      turnId: "turn-3",
      title: "Request received",
      status: "completed" as const,
      userStatus: "received" as const,
      timestamp: 1,
    },
    {
      id: "task-planning",
      task_id: "turn-3:planning",
      turnId: "turn-3",
      title: "Planned approach",
      status: "completed" as const,
      userStatus: "planning" as const,
      timestamp: 2,
    },
    {
      id: "task-responding",
      task_id: "turn-3:responding",
      turnId: "turn-3",
      title: "Response prepared",
      status: "completed" as const,
      userStatus: "responding" as const,
      timestamp: 9,
    },
  ];
}

function simpleLifecycleBlock(): ExecutionBlockModel {
  return {
    key: "turn-3",
    turnId: "turn-3",
    headline: "Check weather",
    status: "success",
    toolCount: 1,
    taskCount: 3,
    issueCount: 0,
    totalElapsedMs: 1200,
    issueSummaries: [],
    tasks: lifecycleTasks(),
    tools: [
      {
        id: "tool-weather",
        callId: "weather",
        turnId: "turn-3",
        tool: "web_fetch",
        phase: "end",
        status: "success",
        intent: "https://example.com/weather",
        result: "https://example.com/weather",
        elapsed_ms: 1200,
        timestamp: 3,
      },
    ],
  };
}

function complexLifecycleBlock(): ExecutionBlockModel {
  return {
    key: "turn-4",
    turnId: "turn-4",
    headline: "Research market news",
    status: "success",
    toolCount: 3,
    taskCount: 3,
    issueCount: 0,
    totalElapsedMs: 9000,
    issueSummaries: [],
    tasks: lifecycleTasks().map((task) => ({ ...task, turnId: "turn-4", task_id: task.task_id.replace("turn-3", "turn-4") })),
    tools: [1, 2, 3].map((index) => ({
      id: `tool-source-${index}`,
      callId: `source-${index}`,
      turnId: "turn-4",
      tool: "web_fetch",
      phase: "end",
      status: "success" as const,
      intent: `https://example.com/source-${index}`,
      result: `https://example.com/source-${index}`,
      elapsed_ms: 3000,
      timestamp: index + 3,
    })),
  };
}

function runningLifecycleBlock(): ExecutionBlockModel {
  return {
    key: "turn-5",
    turnId: "turn-5",
    headline: "Research market news",
    status: "running",
    toolCount: 1,
    taskCount: 2,
    issueCount: 0,
    totalElapsedMs: 0,
    issueSummaries: [],
    tasks: [
      {
        id: "task-received-running",
        task_id: "turn-5:received",
        turnId: "turn-5",
        title: "Request received",
        status: "completed",
        userStatus: "received",
        timestamp: 1,
      },
      {
        id: "task-planning-running",
        task_id: "turn-5:planning",
        turnId: "turn-5",
        title: "Understanding request and planning",
        status: "completed",
        userStatus: "planning",
        timestamp: 2,
      },
      {
        id: "task-responding-running",
        task_id: "turn-5:responding",
        turnId: "turn-5",
        title: "Preparing response",
        status: "running",
        userStatus: "responding",
        timestamp: 5,
      },
    ],
    tools: [
      {
        id: "tool-source-running",
        callId: "source-running",
        turnId: "turn-5",
        tool: "web_fetch",
        phase: "end",
        status: "success",
        intent: "https://example.com/source",
        result: "https://example.com/source",
        elapsed_ms: 2400,
        timestamp: 4,
      },
    ],
  };
}

function activeWorkLifecycleBlock(): ExecutionBlockModel {
  return {
    key: "turn-6",
    turnId: "turn-6",
    headline: "Working on task",
    status: "running",
    toolCount: 0,
    taskCount: 3,
    issueCount: 0,
    totalElapsedMs: 0,
    issueSummaries: [],
    tasks: [
      {
        id: "task-received-active",
        task_id: "turn-6:received",
        turnId: "turn-6",
        title: "Request received",
        status: "completed",
        userStatus: "received",
        timestamp: 1,
      },
      {
        id: "task-planning-active",
        task_id: "turn-6:planning",
        turnId: "turn-6",
        title: "Planned approach",
        status: "completed",
        userStatus: "planning",
        timestamp: 2,
      },
      {
        id: "task-working-active",
        task_id: "turn-6:working",
        turnId: "turn-6",
        title: "Working on task",
        status: "running",
        userStatus: "working",
        timestamp: 3,
      },
    ],
    tools: [],
  };
}

describe("ExecutionBlock", () => {
  it("keeps collapsed success free of step counts and exact durations", () => {
    renderWithLocale(<ExecutionBlock block={complexLifecycleBlock()} />);
    const summary = screen.getByTestId("execution-summary");
    expect(summary).toHaveTextContent("View work");
    expect(summary.textContent).not.toMatch(/\d+\s*(ms|毫秒|秒|s\b)/);
    expect(summary.textContent).not.toMatch(/(步|steps?)/i);
  });

  it("shows a truthful error label without step or duration counts", () => {
    const block = nestedPlanBlock();
    block.issueCount = 0;
    renderWithLocale(<ExecutionBlock block={block} />);
    const summary = screen.getByTestId("execution-summary");
    expect(summary).toHaveTextContent("Needs attention");
    expect(summary.textContent).not.toMatch(/\d+\s*(ms|毫秒|秒|s\b)/);
    expect(summary.textContent).not.toMatch(/(步|steps?)/i);
  });

  it("stays quiet and collapsed by default, surfacing only a compact pill", () => {
    renderWithLocale(<ExecutionBlock block={failedSearchBlock()} />);

    expect(screen.getByTestId("execution-summary")).toHaveTextContent("Needs attention (3)");
    expect(screen.getByTestId("execution-summary").textContent).not.toMatch(/\d+\s*(ms|毫秒|秒|s\b)/);
    expect(screen.getByTestId("execution-summary").textContent).not.toMatch(/(步|steps?)/);
    expect(screen.queryByText("MOZI")).not.toBeInTheDocument();
    expect(screen.queryByText(/Missing SEARCH1API_KEY/)).not.toBeInTheDocument();
    expect(screen.queryByText(/IMPORTANT: Do NOT answer/)).not.toBeInTheDocument();
  });

  it("reveals sanitized timeline rows on the single expansion level", () => {
    renderWithLocale(<ExecutionBlock block={failedSearchBlock()} />);

    fireEvent.click(screen.getByTestId("execution-summary"));

    expect(screen.getAllByText("A step hit an issue: search public information")).toHaveLength(3);
    expect(screen.getAllByText("Missing SEARCH1API_KEY (repeated 3 times)")).toHaveLength(3);
    expect(screen.queryByText(/IMPORTANT: Do NOT answer/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Show timeline/i })).not.toBeInTheDocument();
  });

  it("localizes the compact summary and expanded steps (zh-CN)", () => {
    renderWithLocale(<ExecutionBlock block={failedSearchBlock()} />, { locale: "zh-CN" });

    expect(screen.getByTestId("execution-summary")).toHaveTextContent("需要处理（3）");
    expect(screen.queryByText(/缺少 SEARCH1API_KEY/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("execution-summary"));

    expect(screen.getAllByText("一步遇到问题：搜索公开资料")).toHaveLength(3);
    expect(screen.getAllByText("缺少 SEARCH1API_KEY（重复 3 次）")).toHaveLength(3);
  });

  it("uses the transcript locale over the global UI locale for chat progress", () => {
    renderWithLocale(<ExecutionBlock block={{ ...partialSourceBlock(), locale: "zh-CN" }} />, { locale: "en" });

    expect(screen.getByTestId("execution-summary")).toHaveTextContent("查看处理过程");
    expect(screen.queryByText("View work")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("execution-summary"));

    expect(screen.getAllByTestId("execution-step-label").some((node) => node.textContent?.includes("读取 example.com"))).toBe(true);
    expect(screen.getByText("一个来源无法访问，已换用其他来源")).toBeInTheDocument();
  });

  it("frames partial source failures as skipped sources without leaking crawl internals", () => {
    renderWithLocale(<ExecutionBlock block={partialSourceBlock()} />);

    expect(screen.getByTestId("execution-summary")).toHaveTextContent("View work");
    expect(screen.queryByText(/One source was unreachable/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Crawl API error/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("execution-summary"));

    expect(screen.getByText("One source was unreachable; used another")).toBeInTheDocument();
    expect(screen.queryByText("Some sources were skipped")).not.toBeInTheDocument();
    expect(screen.getAllByTestId("execution-step-label").some((node) => node.textContent?.includes("Read example.com"))).toBe(true);
    expect(screen.queryByText(/Failed to crawl URL/)).not.toBeInTheDocument();
    expect(screen.queryByText(/status 500/)).not.toBeInTheDocument();
  });

  it("localizes partial source failures (zh-CN)", () => {
    renderWithLocale(<ExecutionBlock block={partialSourceBlock()} />, { locale: "zh-CN" });

    expect(screen.getByTestId("execution-summary")).toHaveTextContent("查看处理过程");
    expect(screen.queryByText(/一个来源无法访问/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("execution-summary"));

    expect(screen.getByText("一个来源无法访问，已换用其他来源")).toBeInTheDocument();
    expect(screen.queryByText("部分来源已跳过")).not.toBeInTheDocument();
    expect(screen.getAllByTestId("execution-step-label").some((node) => node.textContent?.includes("读取 example.com"))).toBe(true);
    expect(screen.queryByText(/Crawl API error/)).not.toBeInTheDocument();
  });

  it("presents empty search results without raw provider errors", () => {
    renderWithLocale(<ExecutionBlock block={searchNoResultsBlock()} />, { locale: "zh-CN" });

    fireEvent.click(screen.getByTestId("execution-summary"));

    expect(screen.getByText(/一次搜索没有找到有效结果，已继续/)).toBeInTheDocument();
    expect(screen.queryByText(/Search API error/)).not.toBeInTheDocument();
    expect(screen.queryByText(/\{"ok":false/)).not.toBeInTheDocument();
  });

  it("does not over-expose lifecycle planning for a simple completed task", () => {
    renderWithLocale(<ExecutionBlock block={simpleLifecycleBlock()} />);

    expect(screen.getByTestId("execution-summary")).toHaveTextContent("View work");

    fireEvent.click(screen.getByTestId("execution-summary"));

    expect(screen.queryByText("Request received")).not.toBeInTheDocument();
    expect(screen.queryByText("Understood request and planned")).not.toBeInTheDocument();
    expect(screen.queryByText("Response prepared")).not.toBeInTheDocument();
    expect(screen.getAllByTestId("execution-step-label").some((node) => node.textContent?.includes("Read example.com"))).toBe(true);
  });

  it("renders skill activation rows and skill attribution suffixes from tool events", () => {
    const block: ExecutionBlockModel = {
      key: "turn-skill",
      turnId: "turn-skill",
      headline: "Load skill imagegen",
      status: "success",
      toolCount: 2,
      taskCount: 0,
      issueCount: 0,
      totalElapsedMs: 1800,
      issueSummaries: [],
      tasks: [],
      tools: [
        {
          id: "tool-use-skill",
          callId: "use-skill",
          turnId: "turn-skill",
          tool: "use_skill",
          phase: "end",
          status: "success",
          skillName: "imagegen",
          skillDescription: "Generate images from prompts",
          skillLoadOutcome: "success",
          intent: "Load skill imagegen https://example.com/should-not-chip",
          elapsed_ms: 600,
          timestamp: 1,
        },
        {
          id: "tool-search-skill",
          callId: "search-skill",
          turnId: "turn-skill",
          tool: "web_search",
          phase: "end",
          status: "success",
          skillName: "imagegen",
          intent: "transparent sprite sheet",
          elapsed_ms: 1200,
          timestamp: 2,
        },
      ],
    };

    renderWithLocale(<ExecutionBlock block={block} />);

    expect(screen.getByTestId("execution-summary")).toHaveTextContent("View work");

    fireEvent.click(screen.getByTestId("execution-summary"));

    const labels = screen.getAllByTestId("execution-step-label");
    const activationLabel = labels.find((node) => node.textContent?.includes("Loading skill"));
    expect(activationLabel).toBeTruthy();
    expect(activationLabel).not.toHaveTextContent("imagegen");
    expect(screen.getByTestId("execution-skill-detail")).toHaveTextContent(
      "⌊ Successfully loaded skill",
    );
    expect(screen.queryByText("❖ imagegen")).not.toBeInTheDocument();
    expect(labels.some((node) => node.textContent?.includes("Search transparent sprite sheet"))).toBe(true);
  });

  it("renders skill activation failures as a two-level item with the reason", () => {
    const block: ExecutionBlockModel = {
      key: "turn-skill-failure",
      turnId: "turn-skill-failure",
      headline: "Load skill gated-skill",
      status: "error",
      toolCount: 1,
      taskCount: 0,
      issueCount: 1,
      totalElapsedMs: 150,
      issueSummaries: [
        {
          key: "skill-missing",
          label: "load skill",
          detail: "Missing requirements",
          count: 1,
          latestTimestamp: 1,
        },
      ],
      tasks: [],
      tools: [
        {
          id: "tool-use-skill-failure",
          callId: "use-skill-failure",
          turnId: "turn-skill-failure",
          tool: "use_skill",
          phase: "end",
          status: "error",
          skillName: "gated-skill",
          skillDescription: "Needs local tools",
          skillLoadOutcome: "ineligible",
          skillMissingBins: ["python3"],
          skillMissingEnv: ["ANTHROPIC_API_KEY"],
          error: "Error: Unknown or ineligible skill \"gated-skill\" (missing requirements).",
          elapsed_ms: 150,
          timestamp: 1,
        },
      ],
    };

    renderWithLocale(<ExecutionBlock block={block} />);
    fireEvent.click(screen.getByTestId("execution-summary"));

    expect(screen.getByTestId("execution-step-label")).toHaveTextContent("Loading skill");
    expect(screen.getByTestId("execution-step-label")).not.toHaveTextContent("gated-skill");
    expect(screen.getByTestId("execution-skill-detail")).toHaveTextContent(
      "⌊ Skill is not eligible",
    );
  });

  it("reveals exact durations and raw tool data only after both disclosures", () => {
    const block = nestedPlanBlock();
    renderWithLocale(<ExecutionBlock block={block} />);

    expect(screen.queryByText("shell_exec")).not.toBeInTheDocument();
    expect(screen.queryByText(/npm run build/)).not.toBeInTheDocument();
    expect(screen.queryByText("500ms")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("execution-summary"));
    expect(screen.queryByText("shell_exec")).not.toBeInTheDocument();
    expect(screen.queryByText(/npm run build/)).not.toBeInTheDocument();
    expect(screen.queryByText("500ms")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("execution-technical-summary"));
    expect(screen.getByText("shell_exec")).toBeInTheDocument();
    expect(screen.getByText(/npm run build/)).toBeInTheDocument();
    expect(screen.getByText("500ms")).toBeInTheDocument();
  });

  it("shows lightweight lifecycle stages for a complex completed task", () => {
    renderWithLocale(<ExecutionBlock block={complexLifecycleBlock()} />);

    expect(screen.getByTestId("execution-summary")).toHaveTextContent("View work");
    expect(screen.queryByText("I’ve finished the necessary work; the answer is below.")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("execution-summary"));

    expect(screen.getByText("Request received")).toBeInTheDocument();
    expect(screen.getByText("Understood request and planned")).toBeInTheDocument();
    expect(screen.getByText("Response prepared")).toBeInTheDocument();
    expect(screen.getAllByTestId("execution-step-label").filter((node) => node.textContent?.includes("Read example.com"))).toHaveLength(3);
  });

  it("renders live work as one updating line instead of an expanded block", () => {
    renderWithLocale(<ExecutionBlock block={runningLifecycleBlock()} />);

    expect(screen.getByTestId("execution-live-line")).toHaveTextContent("Preparing response");
    expect(screen.queryByTestId("execution-summary")).not.toBeInTheDocument();
    expect(screen.queryByTestId("execution-lead")).not.toBeInTheDocument();
    expect(screen.getAllByText("Preparing response")).toHaveLength(1);
  });

  it("keeps live URL activity to a verb phrase and domain chip logic out of the live line", () => {
    const block: ExecutionBlockModel = {
      key: "turn-url",
      turnId: "turn-url",
      headline: "x",
      status: "running",
      toolCount: 1,
      taskCount: 0,
      issueCount: 0,
      totalElapsedMs: 0,
      issueSummaries: [],
      tasks: [],
      tools: [
        {
          id: "t-url",
          callId: "c-url",
          turnId: "turn-url",
          tool: "web_fetch",
          phase: "start",
          status: "running",
          intent: "https://github.com/zhadyz/AI_SOC",
          timestamp: 1,
        },
      ],
    };

    renderWithLocale(<ExecutionBlock block={block} />);

    const line = screen.getByTestId("execution-live-line");
    expect(line).toHaveTextContent("Read github.com");
    expect(line).not.toHaveTextContent("https://github.com/zhadyz/AI_SOC");
  });

  it("uses readable search intent in the live line without rendering a second typing indicator", () => {
    const block: ExecutionBlockModel = {
      key: "turn-q",
      turnId: "turn-q",
      headline: "x",
      status: "running",
      toolCount: 1,
      taskCount: 0,
      issueCount: 0,
      totalElapsedMs: 0,
      issueSummaries: [],
      tasks: [],
      tools: [
        {
          id: "t-q",
          callId: "c-q",
          turnId: "turn-q",
          tool: "web_search",
          phase: "start",
          status: "running",
          intent: "global temperature map interactive API free 2025 2026",
          timestamp: 1,
        },
      ],
    };

    renderWithLocale(<ExecutionBlock block={block} />);

    expect(screen.getByTestId("execution-live-line")).toHaveTextContent(
      "Search global temperature map interactive API free 2025 2026",
    );
    expect(screen.queryByTestId("execution-summary")).not.toBeInTheDocument();
  });

  it("uses skill activation grammar in the live line", () => {
    const block: ExecutionBlockModel = {
      key: "turn-skill-live",
      turnId: "turn-skill-live",
      headline: "Load skill",
      status: "running",
      toolCount: 1,
      taskCount: 0,
      issueCount: 0,
      totalElapsedMs: 0,
      issueSummaries: [],
      tasks: [],
      tools: [
        {
          id: "tool-skill-live",
          callId: "skill-live",
          turnId: "turn-skill-live",
          tool: "use_skill",
          phase: "start",
          status: "running",
          skillName: "imagegen",
          intent: "Load skill imagegen",
          timestamp: 1,
        },
      ],
    };

    renderWithLocale(<ExecutionBlock block={block} />);

    expect(screen.getByTestId("execution-live-line")).toHaveTextContent("Loading skill");
    expect(screen.getByTestId("execution-live-line")).not.toHaveTextContent("imagegen");
    expect(screen.queryByTestId("execution-summary")).not.toBeInTheDocument();
  });

  it("shows an active working stage before any tool output exists", () => {
    renderWithLocale(<ExecutionBlock block={activeWorkLifecycleBlock()} />);

    expect(screen.queryByTestId("execution-lead")).not.toBeInTheDocument();
    expect(screen.getByTestId("execution-live-line")).toHaveTextContent("Working on the task");
  });

  it("freezes an orphaned running block into an interrupted state instead of spinning forever", () => {
    const zombie: ExecutionBlockModel = {
      key: "turn-dead",
      turnId: "turn-dead",
      headline: "Web search",
      status: "running",
      toolCount: 1,
      taskCount: 0,
      issueCount: 0,
      totalElapsedMs: 0,
      issueSummaries: [],
      tasks: [],
      tools: [
        {
          id: "tool-orphan",
          callId: "orphan-1",
          turnId: "turn-dead",
          tool: "web_search",
          phase: "start",
          status: "running",
          intent: "阿里巴巴 最新财报",
          timestamp: 1,
        },
      ],
    };

    renderWithLocale(<ExecutionBlock block={zombie} interrupted />);

    expect(screen.getByText("Interrupted — runtime restarted before this finished")).toBeInTheDocument();
    expect(document.querySelector(".animate-spin")).toBeNull();
    expect(screen.queryByTestId("execution-lead")).not.toBeInTheDocument();
    expect(screen.queryByTestId("execution-live-line")).not.toBeInTheDocument();
  });

  it("renders URL domains as quiet chips and keeps raw URLs in technical details", () => {
    renderWithLocale(<ExecutionBlock block={simpleLifecycleBlock()} />);

    fireEvent.click(screen.getByTestId("execution-summary"));

    const label = screen.getByTestId("execution-step-label");
    expect((label.textContent?.match(/example\.com/g) ?? [])).toHaveLength(1);
    expect(label).toHaveTextContent("Read example.com");
    expect(screen.getByText("example.com")).toBeInTheDocument();
    expect(screen.queryByText("https://example.com/weather")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("execution-technical-summary"));
    expect(screen.getByText(/https:\/\/example\.com\/weather/)).toBeInTheDocument();
  });

  it("keeps the domain chip when a source has a page title", () => {
    const block = simpleLifecycleBlock();
    block.tools = [
      {
        ...block.tools[0],
        result: "<html><head><title>Weather report</title></head><body>Forecast</body></html>",
      },
    ];

    renderWithLocale(<ExecutionBlock block={block} />);

    fireEvent.click(screen.getByTestId("execution-summary"));

    const label = screen.getByTestId("execution-step-label");
    expect(label).toHaveTextContent("Read Weather report example.com");
    expect(screen.getByLabelText("example.com")).toBeInTheDocument();
  });

  it("caps long expanded timelines with an internal scroll region", () => {
    const block: ExecutionBlockModel = {
      key: "turn-long",
      turnId: "turn-long",
      headline: "Inspect many sources",
      status: "success",
      toolCount: 12,
      taskCount: 0,
      issueCount: 0,
      totalElapsedMs: 12_000,
      issueSummaries: [],
      tasks: [],
      tools: Array.from({ length: 12 }, (_, index) => ({
        id: `tool-long-${index + 1}`,
        callId: `long-${index + 1}`,
        turnId: "turn-long",
        tool: "web_fetch",
        phase: "end" as const,
        status: "success" as const,
        intent: `https://example.com/source-${index + 1}`,
        result: `https://example.com/source-${index + 1}`,
        elapsed_ms: 1000,
        timestamp: index + 1,
      })),
    };

    renderWithLocale(<ExecutionBlock block={block} />);

    fireEvent.click(screen.getByTestId("execution-summary"));

    expect(screen.getByTestId("execution-timeline")).toHaveClass("max-h-[320px]", "overflow-y-auto");
    expect(screen.getAllByTestId("execution-step-label")).toHaveLength(12);
  });
});

function nestedPlanBlock(): ExecutionBlockModel {
  // A two-task plan: root → { Build (failed), Test (cancelled) }, with one tool
  // owned by the Build subtask. Status is set non-running so the pill expands.
  const tasks: ExecutionBlockModel["tasks"] = [
    { id: "t-root", task_id: "root", title: "Ship the release", status: "running", timestamp: 100 },
    { id: "t-a", task_id: "sub-a", parentTaskId: "root", title: "Build", status: "failed", rawStatus: "task_failed", detail: "compile error", timestamp: 101 },
    { id: "t-b", task_id: "sub-b", parentTaskId: "root", title: "Test", status: "failed", rawStatus: "task_cancelled", timestamp: 102 },
  ];
  const tools: ExecutionBlockModel["tools"] = [
    { id: "tool-a1", callId: "a1", taskId: "sub-a", tool: "shell_exec", phase: "end", status: "success", intent: "npm run build", elapsed_ms: 500, timestamp: 103 },
  ];
  return {
    key: "turn-plan",
    turnId: "turn-plan",
    headline: "Ship the release",
    status: "error",
    toolCount: 1,
    taskCount: 3,
    issueCount: 1,
    totalElapsedMs: 500,
    issueSummaries: [],
    tasks,
    tools,
  };
}

describe("ExecutionBlock — nested task timeline (Issue #624)", () => {
  it("does not label a mixed-success plan as done or leak shell i18n keys", () => {
    const block = nestedPlanBlock();
    block.status = "mixed";
    renderWithLocale(<ExecutionBlock block={block} />);
    expect(screen.getByTestId("execution-summary")).toHaveTextContent("Needs attention");
    fireEvent.click(screen.getByTestId("execution-summary"));
    expect(screen.getByText("Run command")).toBeTruthy();
    expect(screen.queryByText(/npm run build/)).not.toBeInTheDocument();
    expect(screen.queryByText(/execution\.step\.shell/)).not.toBeInTheDocument();
  });
  it("labels an all-cancelled plan truthfully in the collapsed summary", () => {
    const block = nestedPlanBlock();
    block.tasks = [{ id: "cancelled", task_id: "cancelled", title: "Stopped work", status: "failed", rawStatus: "task_cancelled", timestamp: 1 }];
    block.tools = [];
    block.toolCount = 0;
    block.taskCount = 1;
    block.issueCount = 0;
    block.status = "success";
    renderWithLocale(<ExecutionBlock block={block} />);
    expect(screen.getByTestId("execution-summary")).toHaveTextContent("Cancelled");
  });
  it("renders plan → subtasks → tool as nested, depth-tagged groups", () => {
    renderWithLocale(<ExecutionBlock block={nestedPlanBlock()} />);
    fireEvent.click(screen.getByTestId("execution-summary"));

    const groups = screen.getAllByTestId("execution-task-group");
    expect(groups).toHaveLength(3);
    // Root is depth 0, subtasks depth 1.
    const depths = groups.map((g) => g.getAttribute("data-depth"));
    expect(depths).toEqual(["0", "1", "1"]);

    // The Build subtask's tool nests one level deeper than the subtask (depth 2)
    // and is a leaf, not a task group.
    const depth2 = document.querySelectorAll('[data-depth="2"]');
    expect(depth2).toHaveLength(1);
    expect(depth2[0].getAttribute("data-testid")).not.toBe("execution-task-group");
  });

  it("shows a cancelled subtask truthfully and never hides the failure", () => {
    renderWithLocale(<ExecutionBlock block={nestedPlanBlock()} />);
    fireEvent.click(screen.getByTestId("execution-summary"));

    // Cancelled is labelled distinctly from a failure.
    expect(screen.getByText("Cancelled")).toBeTruthy();
    // The raw failure remains reachable only in technical details.
    expect(screen.queryByText("compile error")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("execution-technical-summary"));
    expect(screen.getByText(/compile error/)).toBeTruthy();
  });

  it("localizes the cancelled state (zh-CN)", () => {
    renderWithLocale(<ExecutionBlock block={nestedPlanBlock()} />, { locale: "zh-CN" });
    fireEvent.click(screen.getByTestId("execution-summary"));
    expect(screen.getByText("已取消")).toBeTruthy();
  });

  // Issue #626: a block the deterministic projection re-colored from the durable
  // Turn Envelope. Its tool never got an 'end' frame (status left "running"), but
  // the envelope's terminal status is authoritative.
  function openRunningBlock(status: ExecutionBlockModel["status"]): ExecutionBlockModel {
    return {
      key: "turn-x",
      turnId: "turn-x",
      headline: "Working",
      status,
      toolCount: 1,
      taskCount: 0,
      issueCount: 0,
      totalElapsedMs: 0,
      issueSummaries: [],
      tasks: [],
      tools: [
        { id: "t1", callId: "c1", turnId: "turn-x", tool: "shell", phase: "start", status: "success", timestamp: 1 },
      ],
    };
  }

  it("freezes an envelope-interrupted block instead of spinning (Issue #626)", () => {
    const { container } = renderWithLocale(<ExecutionBlock block={openRunningBlock("interrupted")} />);
    expect(screen.getByTestId("execution-summary")).toHaveTextContent(
      "Interrupted — runtime restarted before this finished",
    );
    // No live spinner: the collapsed summary button is shown, not the live line.
    expect(container.querySelector(".animate-spin")).toBeNull();
  });

  it("renders an envelope-cancelled block as stopped, not failed (Issue #626)", () => {
    const { container } = renderWithLocale(<ExecutionBlock block={openRunningBlock("cancelled")} />);
    expect(screen.getByTestId("execution-summary")).toHaveTextContent("Cancelled");
    expect(container.querySelector(".animate-spin")).toBeNull();
  });

  it("localizes an envelope-cancelled block (zh-CN, Issue #626)", () => {
    renderWithLocale(<ExecutionBlock block={openRunningBlock("cancelled")} />, { locale: "zh-CN" });
    expect(screen.getByTestId("execution-summary")).toHaveTextContent("已取消");
  });
});

describe("ExecutionBlock — memoization (Issue #628)", () => {
  // The turn-timeline projection rebuilds every block's wrapper object and its
  // tasks/tools/issueSummaries arrays on every pass, so a stable historical turn
  // arrives as a fresh, structurally-identical object each render. Without a
  // content-aware comparator React's default shallow prop compare would see the
  // new reference and re-render the whole turn history on every active update.
  // The default export must actually be memoized with our comparator — not the
  // default shallow compare, and not left un-memoized — or the render-count win
  // silently regresses even while the comparator logic stays correct.
  it("wires the exported comparator into the memoized default export", () => {
    expect((ExecutionBlock as unknown as { compare?: unknown }).compare).toBe(areExecutionBlockPropsEqual);
  });

  it("does not re-render a reconstructed but semantically unchanged block, yet re-renders when active content changes", () => {
    // Count renders at the real memo boundary: the exported comparator guarding
    // the exported component. The body runs only when memo decides to re-render,
    // so `renders` is a truthful render count, not a commit-of-parent artifact.
    let renders = 0;
    const Counting = memo(function CountingExecutionBlock({ block }: { block: ExecutionBlockModel }) {
      renders += 1;
      return <ExecutionBlock block={block} />;
    }, areExecutionBlockPropsEqual);

    const { rerender } = renderWithLocale(<Counting block={simpleLifecycleBlock()} />);
    expect(renders).toBe(1); // initial mount

    // Reconstructed: a brand-new wrapper object with brand-new tasks/tools arrays
    // but structurally identical content — exactly what the projection emits for
    // an unchanged historical turn. The comparator must treat it as equal.
    rerender(<Counting block={simpleLifecycleBlock()} />);
    expect(renders).toBe(1); // memo bailed out — no re-render for this update

    // Active content changes: a new tool lands and the tool count ticks up. The
    // comparator must detect this and let the block re-render.
    const changed = simpleLifecycleBlock();
    changed.toolCount = 2;
    changed.tools = [
      ...changed.tools,
      { ...changed.tools[0], id: "tool-weather-2", callId: "weather-2", timestamp: 4 },
    ];
    rerender(<Counting block={changed} />);
    expect(renders).toBe(2); // change detected — re-rendered
  });

  it("comparator treats a reconstructed block as equal but flags changed active content", () => {
    const a = simpleLifecycleBlock();
    // Structurally identical, all-new references.
    expect(areExecutionBlockPropsEqual({ block: a }, { block: simpleLifecycleBlock() })).toBe(true);
    // undefined vs explicit false interrupted is normalized to equal.
    expect(areExecutionBlockPropsEqual({ block: a, interrupted: false }, { block: a })).toBe(true);

    const moreTools = simpleLifecycleBlock();
    moreTools.toolCount = 2;
    expect(areExecutionBlockPropsEqual({ block: a }, { block: moreTools })).toBe(false);

    const changedToolContent = simpleLifecycleBlock();
    changedToolContent.tools = [{ ...changedToolContent.tools[0], elapsed_ms: 9999 }];
    expect(areExecutionBlockPropsEqual({ block: a }, { block: changedToolContent })).toBe(false);

    expect(areExecutionBlockPropsEqual({ block: a, interrupted: true }, { block: a })).toBe(false);
  });
});
