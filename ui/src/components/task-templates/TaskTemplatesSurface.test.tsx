import { fireEvent, renderWithLocale, screen, waitFor } from "@/test/render";
import { afterEach, describe, expect, it, vi } from "vitest";
import TaskTemplatesSurface from "./TaskTemplatesSurface";

const templates = Array.from({ length: 5 }, (_, index) => ({
  id: `00000000-0000-4000-8000-00000000000${index}`,
  title: `Task ${index + 1}`,
  instructions: `Instructions ${index + 1}`,
  output_format: index === 0 ? "Bulleted summary" : "",
  pinned: true,
  sort_order: index,
}));

afterEach(() => vi.unstubAllGlobals());

describe("TaskTemplatesSurface", () => {
  it("keeps the home surface to one link and moves every task into the library", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(response({ templates }))));
    renderWithLocale(<TaskTemplatesSurface />, { locale: "en" });

    const libraryLink = await screen.findByRole("button", { name: "My tasks (5)" });
    expect(screen.queryByRole("button", { name: "Edit task: Task 1" })).not.toBeInTheDocument();
    fireEvent.click(libraryLink);

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "My tasks" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit task: Task 1" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit task: Task 5" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New task" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete task: Task 1" })).toHaveClass("opacity-0", "group-hover:opacity-100");
  });

  it("opens an existing task for editing when its title is clicked", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(response({ templates }))));
    renderWithLocale(<TaskTemplatesSurface />, { locale: "en" });

    fireEvent.click(await screen.findByRole("button", { name: "My tasks (5)" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit task: Task 1" }));

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Edit task" })).toBeInTheDocument();
    expect(screen.getByLabelText("Task name")).toHaveValue("Task 1");
    expect(screen.getByLabelText("How should MOZI handle it?")).toHaveValue("Instructions 1");
  });

  it("keeps new task creation directly available and saves the draft", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/task-templates" && init?.method === "POST") {
        return Promise.resolve(response({ template: templates[0] }, 201));
      }
      return Promise.resolve(response({ templates: [] }));
    });
    vi.stubGlobal("fetch", fetchMock);
    renderWithLocale(<TaskTemplatesSurface />, { locale: "en" });

    fireEvent.click(await screen.findByRole("button", { name: "My tasks (0)" }));
    fireEvent.click(screen.getByRole("button", { name: "New task" }));
    fireEvent.change(screen.getByLabelText("Task name"), { target: { value: "Daily brief" } });
    fireEvent.change(screen.getByLabelText("How should MOZI handle it?"), { target: { value: "Summarize my work" } });
    fireEvent.click(screen.getByRole("button", { name: "Save task" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/task-templates",
      expect.objectContaining({ method: "POST", body: expect.stringContaining("Daily brief") }),
    ));
  });

  it("requires confirmation before deleting an existing task", async () => {
    const remaining = templates.slice(1);
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith(templates[0]!.id) && init?.method === "DELETE") {
        return Promise.resolve(response({ ok: true }));
      }
      const deleted = fetchMock.mock.calls.some(([, requestInit]) => requestInit?.method === "DELETE");
      return Promise.resolve(response({ templates: deleted ? remaining : templates }));
    });
    vi.stubGlobal("fetch", fetchMock);
    renderWithLocale(<TaskTemplatesSurface />, { locale: "en" });

    fireEvent.click(await screen.findByRole("button", { name: "My tasks (5)" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete task: Task 1" }));
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining(templates[0]!.id),
      expect.objectContaining({ method: "DELETE" }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Delete?: Task 1" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      `/api/task-templates/${templates[0]!.id}`,
      expect.objectContaining({ method: "DELETE" }),
    ));
  });

  it("opens an example as an editable draft and persists only after save", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/task-templates" && init?.method === "POST") {
        return Promise.resolve(response({ template: templates[0] }, 201));
      }
      return Promise.resolve(response({ templates: [] }));
    });
    vi.stubGlobal("fetch", fetchMock);
    renderWithLocale(<TaskTemplatesSurface />, { locale: "en" });

    fireEvent.click(await screen.findByRole("button", { name: "My tasks (0)" }));
    fireEvent.click(screen.getByRole("button", { name: "Organize today's email" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByLabelText("Task name")).toHaveValue("Organize today's email");
    expect(fetchMock).not.toHaveBeenCalledWith("/api/task-templates", expect.objectContaining({ method: "POST" }));

    fireEvent.click(screen.getByRole("button", { name: "Save task" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/task-templates", expect.objectContaining({ method: "POST" })));
  });
});

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response;
}
