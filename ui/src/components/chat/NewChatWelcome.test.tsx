import { fireEvent, renderWithLocale, screen } from "@/test/render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NewChatWelcome } from "./NewChatWelcome";

describe("NewChatWelcome", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ templates: [] }),
    } as Response)));
  });

  afterEach(() => vi.unstubAllGlobals());

  it("renders a fixed Codex-style card grid and fills a selected English prompt", () => {
    const onSelectPrompt = vi.fn();
    renderWithLocale(<NewChatWelcome onSelectPrompt={onSelectPrompt} />, { locale: "en" });

    expect(screen.getByRole("heading")).toHaveTextContent("What would you like MOZI to help with today?");
    expect(screen.getByTestId("new-chat-welcome")).toHaveClass("w-full", "text-center");
    expect(screen.getByTestId("starter-card-grid")).toHaveClass("grid-cols-2", "sm:grid-cols-4");
    for (const card of screen.getAllByTestId("starter-card")) {
      expect(card).toHaveStyle({ background: "transparent" });
      expect(card).not.toHaveStyle({ background: "var(--surface-elevated)" });
    }
    expect(screen.getAllByTestId("mozi-avatar")).toHaveLength(1);
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
    expect(screen.getAllByRole("button")).toHaveLength(4);
    fireEvent.click(screen.getByRole("button", { name: "Analyze this data and highlight useful trends" }));

    expect(onSelectPrompt).toHaveBeenCalledWith("Analyze this data and highlight useful trends");
  });

  it("renders four Chinese starter cards and a lightweight task-library link", async () => {
    renderWithLocale(<NewChatWelcome onSelectPrompt={vi.fn()} />, { locale: "zh-CN" });

    expect(screen.getByRole("heading")).toHaveTextContent("今天想让 MOZI 帮你做什么？");
    expect(screen.getByRole("button", { name: "把我的会议记录整理成决策和下一步行动" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "调研这个主题并总结关键发现" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "总结我添加的这些文档" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "分析这些数据并指出值得关注的趋势" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "我的任务（0）" })).toBeInTheDocument();
  });
});
