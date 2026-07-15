import { fireEvent, screen, waitFor, renderWithLocale } from "@/test/render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ScheduledView from "./ScheduledView";

function jsonResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: () => Promise.resolve(body),
  } as Response;
}

describe("ScheduledView", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(jsonResponse({
      tasks: [
        {
          id: "task-ok",
          name: "Morning review",
          next_run_at: "2026-07-04T06:30:00.000Z",
          last_status: "ok",
        },
        {
          id: "task-failed",
          name: "Sync digest",
          next_run_at: "2026-07-05T09:00:00.000Z",
          last_status: "failed",
          last_error: "Token expired",
        },
      ],
    }))));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("lists scheduled tasks from the scheduler endpoint", async () => {
    renderWithLocale(<ScheduledView />);

    expect(await screen.findByText("Morning review")).toBeInTheDocument();
    expect(screen.getByText("Sync digest")).toBeInTheDocument();
    expect(screen.getByText("OK")).toBeInTheDocument();
    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(screen.getByText("Token expired")).toBeInTheDocument();
    expect(screen.getAllByText("Next run").length).toBeGreaterThan(0);
    expect(fetch).toHaveBeenCalledWith(
      "/api/scheduler/tasks",
      expect.objectContaining({ method: "GET", credentials: "include" }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  });

  it("shows a quiet empty state when no tasks are scheduled", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ tasks: [] }));

    renderWithLocale(<ScheduledView />);

    expect(await screen.findByText("No scheduled tasks yet. Try asking MOZI to prepare a morning briefing every day.")).toBeInTheDocument();
  });

  it.each([
    { locale: "en" as const, label: "Reminded" },
    { locale: "zh-CN" as const, label: "已提醒" },
  ])("hides reminder identifiers and humanizes fired status in $locale", async ({ locale, label }) => {
    const reminderUuid = "8fd7424a-b24f-4cc6-85ea-5c45d6a6dc2d";
    vi.mocked(fetch).mockImplementation((input) => {
      const url = String(input);
      if (url.includes("/api/scheduler/reminders")) {
        return Promise.resolve(jsonResponse({
          reminders: [{ id: 1, chat_id: reminderUuid, message: "Stand up", fire_at: "2026-07-04T06:30:00.000Z", fired: 1 }],
        }));
      }
      return Promise.resolve(jsonResponse({ tasks: [] }));
    });

    renderWithLocale(<ScheduledView />, { locale });

    expect(await screen.findByText(label, {}, { timeout: 1500 })).toBeInTheDocument();
    expect(screen.queryByText(reminderUuid)).not.toBeInTheDocument();
  });
});
