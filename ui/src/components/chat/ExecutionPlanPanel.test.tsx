import { act, screen, waitFor, fireEvent, renderWithLocale } from "@/test/render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExecutionPlanPanel, type SessionPlan } from "./ExecutionPlanPanel";
import type { TimelineItem } from "@/types";

function plansResponse(plans: SessionPlan[]) {
  return Promise.resolve({
    ok: true,
    json: () => Promise.resolve({ sessionId: "sess-1", plans }),
  });
}

function userMessage(id: string, timestamp: number): TimelineItem {
  return {
    type: "message",
    timestamp,
    data: { id, role: "user", content: "next question", timestamp },
  };
}

const RUNNING_PLAN: SessionPlan = {
  id: "root-1",
  goal: "Quarterly tax report",
  status: "running",
  created_at: "2026-01-01 00:00:00",
  updated_at: "2026-01-01 00:00:00",
  steps: [
    { id: "s1", title: "Collect sources", status: "completed" },
    { id: "s2", title: "Draft analysis", status: "running" },
    { id: "s3", title: "Final review", status: "pending" },
  ],
};

// Completed at 2026-01-01 00:00:00 UTC (SQLite datetime('now') format).
const COMPLETED_PLAN: SessionPlan = {
  ...RUNNING_PLAN,
  status: "completed",
  updated_at: "2026-01-01 00:00:00",
  steps: RUNNING_PLAN.steps.map((step) => ({ ...step, status: "completed" })),
};

const MIXED_STATUS_PLAN: SessionPlan = {
  ...RUNNING_PLAN,
  steps: [
    { id: "s1", title: "Collect sources", status: "completed" },
    { id: "s2", title: "Draft analysis", status: "failed" },
    { id: "s3", title: "Final review", status: "cancelled" },
    { id: "s4", title: "Publish", status: "running" },
    { id: "s5", title: "Archive", status: "pending" },
  ],
};

const BLOCKED_PLAN: SessionPlan = {
  ...RUNNING_PLAN,
  status: "failed",
  steps: [
    { id: "s1", title: "Research Africa", status: "failed" },
    { id: "s2", title: "Write Excel", status: "blocked", blocked_reason: "Dependency failed: Research Africa" },
  ],
};

describe("ExecutionPlanPanel", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(() => plansResponse([RUNNING_PLAN])));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("renders nothing without a session", () => {
    renderWithLocale(<ExecutionPlanPanel sessionId={null} timeline={[]} />);
    expect(screen.queryByTestId("execution-plan-panel")).toBeNull();
  });

  it("rehydrates the plan from the API and auto-expands a running plan", async () => {
    renderWithLocale(<ExecutionPlanPanel sessionId="sess-1" timeline={[]} />);

    await waitFor(() => {
      expect(screen.getByTestId("execution-plan-panel")).toBeTruthy();
    });
    expect(screen.getByText("Quarterly tax report")).toBeTruthy();
    expect(screen.getByText("1/3")).toBeTruthy();
    // Auto-expanded: steps are visible.
    expect(screen.getByText("1. Collect sources")).toBeTruthy();
    expect(screen.getByText("2. Draft analysis")).toBeTruthy();
  });

  it("collapses and expands on click", async () => {
    renderWithLocale(<ExecutionPlanPanel sessionId="sess-1" timeline={[]} />);
    await waitFor(() => expect(screen.getByTestId("execution-plan-panel")).toBeTruthy());

    const toggle = screen.getByRole("button", { expanded: true });
    fireEvent.click(toggle);
    expect(screen.queryByText("1. Collect sources")).toBeNull();
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    expect(screen.getByText("1. Collect sources")).toBeTruthy();
  });

  it("refetches (debounced) when task_update items change", async () => {
    const fetchMock = vi.fn(() => plansResponse([RUNNING_PLAN]));
    vi.stubGlobal("fetch", fetchMock);

    const { rerender } = renderWithLocale(<ExecutionPlanPanel sessionId="sess-1" timeline={[]} />);
    await waitFor(() => expect(screen.getByTestId("execution-plan-panel")).toBeTruthy());
    const callsAfterMount = fetchMock.mock.calls.length;

    const updatedTimeline: TimelineItem[] = [{
      type: "task_update",
      timestamp: Date.now(),
      data: {
        id: "t1", task_id: "s2", title: "Draft analysis", status: "completed", timestamp: Date.now(),
      },
    }];
    rerender(<ExecutionPlanPanel sessionId="sess-1" timeline={updatedTimeline} />);

    await waitFor(() => {
      expect(fetchMock.mock.calls.length).toBeGreaterThan(callsAfterMount);
    }, { timeout: 2000 });
  });

  it("shows terminal state without auto-expanding", async () => {
    vi.stubGlobal("fetch", vi.fn(() => plansResponse([{
      ...RUNNING_PLAN,
      status: "completed",
      steps: RUNNING_PLAN.steps.map((step) => ({ ...step, status: "completed" })),
    }])));

    renderWithLocale(<ExecutionPlanPanel sessionId="sess-1" timeline={[]} />);
    await waitFor(() => expect(screen.getByTestId("execution-plan-panel")).toBeTruthy());
    expect(screen.getByText("3/3")).toBeTruthy();
    // Not auto-expanded for a finished plan.
    expect(screen.queryByText("1. Collect sources")).toBeNull();
  });

  it("does not label a successfully completed retry as stopped", async () => {
    vi.stubGlobal("fetch", vi.fn(() => plansResponse([{
      ...RUNNING_PLAN,
      steps: [
        { id: "s1", title: "Research countries", status: "completed", guard_reason: "loop_timeout" },
        { id: "s2", title: "Write workbook", status: "running" },
      ],
    }])));

    renderWithLocale(<ExecutionPlanPanel sessionId="sess-1" timeline={[]} />);
    await waitFor(() => expect(screen.getByText("1. Research countries")).toBeTruthy());
    expect(screen.queryByText(/Stopped: loop_timeout/)).toBeNull();
  });

  it("renders a terminal guard as a human explanation instead of an internal code", async () => {
    vi.stubGlobal("fetch", vi.fn(() => plansResponse([{
      ...RUNNING_PLAN,
      status: "failed",
      steps: [{ id: "s1", title: "Research countries", status: "failed", guard_reason: "loop_timeout" }],
    }])));

    renderWithLocale(<ExecutionPlanPanel sessionId="sess-1" timeline={[]} />);
    await waitFor(() => expect(screen.getByTestId("execution-plan-panel")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    expect(screen.getByText(/Stopped: no progress timeout/)).toBeTruthy();
    expect(screen.queryByText(/loop_timeout/)).toBeNull();
  });

  it("keeps a terminal plan visible while no newer user message exists", async () => {
    vi.stubGlobal("fetch", vi.fn(() => plansResponse([COMPLETED_PLAN])));
    // Last user message predates plan completion (the message that started it).
    const timeline: TimelineItem[] = [
      userMessage("m1", Date.parse("2025-12-31T10:00:00Z")),
    ];

    renderWithLocale(<ExecutionPlanPanel sessionId="sess-1" timeline={timeline} />);
    await waitFor(() => expect(screen.getByTestId("execution-plan-panel")).toBeTruthy());
    expect(screen.getByText("3/3")).toBeTruthy();
  });

  it("retires a terminal plan once the user sends a newer message", async () => {
    const fetchMock = vi.fn(() => plansResponse([COMPLETED_PLAN]));
    vi.stubGlobal("fetch", fetchMock);
    // Plan finished 2026-01-01 00:00:00 UTC; user moved on the next day.
    const timeline: TimelineItem[] = [
      userMessage("m1", Date.parse("2025-12-31T10:00:00Z")),
      userMessage("m2", Date.parse("2026-01-02T00:00:00Z")),
    ];

    renderWithLocale(<ExecutionPlanPanel sessionId="sess-1" timeline={timeline} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await act(() => Promise.resolve());
    expect(screen.queryByTestId("execution-plan-panel")).toBeNull();
  });

  it("renders every active plan as its own cancellable row", async () => {
    const secondPlan: SessionPlan = {
      ...RUNNING_PLAN,
      id: "root-2",
      goal: "Phone market research",
      updated_at: "2026-01-01 01:00:00",
      steps: [{ id: "s2-1", title: "Survey brands", status: "running" }],
    };
    vi.stubGlobal("fetch", vi.fn(() => plansResponse([secondPlan, RUNNING_PLAN])));

    renderWithLocale(<ExecutionPlanPanel sessionId="sess-1" timeline={[]} />);
    await waitFor(() => expect(screen.getByTestId("execution-plan-panel")).toBeTruthy());
    expect(screen.getByText("Quarterly tax report")).toBeTruthy();
    expect(screen.getByText("Phone market research")).toBeTruthy();
    // Each active plan carries its own cancel button and auto-expands.
    expect(screen.getAllByTestId("plan-cancel-button")).toHaveLength(2);
    expect(screen.getByText("1. Survey brands")).toBeTruthy();
    expect(screen.getByText("1. Collect sources")).toBeTruthy();
  });

  it("shows retry buttons only for failed and cancelled step rows", async () => {
    vi.stubGlobal("fetch", vi.fn(() => plansResponse([MIXED_STATUS_PLAN])));

    renderWithLocale(<ExecutionPlanPanel sessionId="sess-1" timeline={[]} />);
    await waitFor(() => expect(screen.getByTestId("execution-plan-panel")).toBeTruthy());

    expect(screen.getAllByTestId("plan-step-retry-button")).toHaveLength(2);
    expect(screen.getByText("2. Draft analysis")).toBeTruthy();
    expect(screen.getByText("3. Final review")).toBeTruthy();
    expect(screen.getByText("4. Publish")).toBeTruthy();
    expect(screen.getByText("5. Archive")).toBeTruthy();
  });

  it("labels an unexecuted dependent as waiting on upstream without offering a fake retry", async () => {
    vi.stubGlobal("fetch", vi.fn(() => plansResponse([BLOCKED_PLAN])));

    renderWithLocale(<ExecutionPlanPanel sessionId="sess-1" timeline={[]} />);
    await waitFor(() => expect(screen.getByTestId("execution-plan-panel")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { expanded: false }));

    expect(screen.getByText("waiting on upstream")).toHaveAttribute(
      "title",
      "Dependency failed: Research Africa",
    );
    expect(screen.getAllByTestId("plan-step-retry-button")).toHaveLength(1);
  });

  it("posts to the retry endpoint when clicking a step retry button", async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ ok: true }),
        });
      }
      return plansResponse([MIXED_STATUS_PLAN]);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderWithLocale(<ExecutionPlanPanel sessionId="sess-1" timeline={[]} />);
    await waitFor(() => expect(screen.getByTestId("execution-plan-panel")).toBeTruthy());

    fireEvent.click(screen.getAllByTestId("plan-step-retry-button")[0]);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/sessions/sess-1/plans/root-1/steps/s2/retry",
        expect.objectContaining({ method: "POST" }),
      );
    });
  });
});
