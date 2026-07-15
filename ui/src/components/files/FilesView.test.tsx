import { fireEvent, renderWithLocale, screen, waitFor } from "@/test/render";
import { beforeEach, describe, expect, it, vi } from "vitest";
import FilesView, { isLocalFilesOrigin } from "./FilesView";

const getMock = vi.fn();
const postMock = vi.fn();

vi.mock("@/hooks/useApi", () => ({
  useApi: () => ({ get: getMock, post: postMock, del: vi.fn() }),
}));

describe("FilesView", () => {
  beforeEach(() => {
    getMock.mockReset();
    postMock.mockReset();
    postMock.mockResolvedValue({ data: { success: true }, error: null });
    getMock.mockResolvedValue({
      data: {
        dir: "/Users/person/Library/Application Support/MOZI/workspaces/3d58f218-0f86-463c-a33f-7cc3a8de8a53",
        root: "/Users/person/Library/Application Support/MOZI/workspaces/3d58f218-0f86-463c-a33f-7cc3a8de8a53",
        entries: [],
      },
      error: null,
    });
  });

  it("switches between the workspace and the same project roots the composer uses", async () => {
    const roots = [
      { kind: "workspace", path: "/workspace", label: "Workspace", exists: true },
      { kind: "project_root", path: "/Users/person/codes/OpenMoziDemo", label: "OpenMoziDemo", exists: true },
    ] as never;
    getMock.mockImplementation((url: string) => {
      if (url.includes(encodeURIComponent("/Users/person/codes/OpenMoziDemo"))) {
        return Promise.resolve({ data: { dir: "/Users/person/codes/OpenMoziDemo", root: "/Users/person/codes/OpenMoziDemo", entries: [
          { name: "Cargo.toml", path: "/Users/person/codes/OpenMoziDemo/Cargo.toml", isDir: false, size: 5, mtime: 1, artifactKind: "other" },
        ] }, error: null });
      }
      return Promise.resolve({ data: { dir: "/workspace", root: "/workspace", entries: [] }, error: null });
    });
    renderWithLocale(<FilesView roots={roots} />);

    const switcher = await screen.findByTestId("files-root-switcher");
    const projectChip = screen.getByRole("button", { name: "OpenMoziDemo" });
    expect(switcher).toContainElement(projectChip);

    fireEvent.click(projectChip);
    expect(await screen.findByText("Cargo.toml")).toBeInTheDocument();
    expect(getMock).toHaveBeenCalledWith(expect.stringContaining(encodeURIComponent("/Users/person/codes/OpenMoziDemo")));

    fireEvent.click(screen.getByRole("button", { name: "Workspace" }));
    await waitFor(() => expect(screen.queryByText("Cargo.toml")).not.toBeInTheDocument());
  });

  it("reveals the absolute workspace location only on request", async () => {
    renderWithLocale(<FilesView />);
    const path = "/Users/person/Library/Application Support/MOZI/workspaces/3d58f218-0f86-463c-a33f-7cc3a8de8a53";

    const reveal = await screen.findByRole("button", { name: "Show location" });
    expect(screen.queryByText(path)).not.toBeInTheDocument();
    fireEvent.click(reveal);
    expect(screen.getByText(path)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Hide location" }));
    expect(screen.queryByText(path)).not.toBeInTheDocument();
  });

  it("groups folders and deliverables before a collapsed working-files group", async () => {
    getMock.mockResolvedValue({ data: { dir: "/workspace", root: "/workspace", entries: [
      { name: "source.ts", path: "/workspace/source.ts", isDir: false, size: 10, mtime: 1, artifactKind: "code" },
      { name: "final.pdf", path: "/workspace/final.pdf", isDir: false, size: 20, mtime: 2, artifactKind: "document" },
      { name: "Reports", path: "/workspace/Reports", isDir: true, mtime: 3 },
    ] }, error: null });
    renderWithLocale(<FilesView />);

    expect(await screen.findByText("Reports")).toBeInTheDocument();
    expect(screen.getByText("final.pdf")).toBeInTheDocument();
    expect(screen.queryByText("source.ts")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Working files/ }));
    expect(screen.getByText("source.ts")).toBeInTheDocument();
  });

  it("keeps search results flat and exposes file details with source-chat navigation", async () => {
    const onOpenSession = vi.fn();
    getMock.mockImplementation((url: string) => url.startsWith("/api/fs/source")
      ? Promise.resolve({ data: { source: { sessionId: "session-1", sessionTitle: "Launch plan", timestamp: 5 } }, error: null })
      : Promise.resolve({ data: { dir: "/workspace", root: "/workspace", entries: [
        { name: "source.ts", path: "/workspace/source.ts", isDir: false, size: 10, created: 1000, mtime: 2000, artifactKind: "code" },
      ] }, error: null }));
    renderWithLocale(<FilesView onOpenSession={onOpenSession} />);

    fireEvent.change(await screen.findByPlaceholderText("Search files"), { target: { value: "source" } });
    fireEvent.click(screen.getByRole("button", { name: /source.ts/ }));
    await waitFor(() => expect(getMock).toHaveBeenCalledWith("/api/fs/source?path=%2Fworkspace%2Fsource.ts"));
    fireEvent.click(await screen.findByRole("button", { name: "From chat: Launch plan" }));
    expect(onOpenSession).toHaveBeenCalledWith("session-1");
    expect(screen.getAllByText("source.ts")).toHaveLength(2);
  });

  it("calls reveal from a local row and identifies remote origins", async () => {
    getMock.mockResolvedValue({ data: { dir: "/workspace", root: "/workspace", entries: [
      { name: "final.pdf", path: "/workspace/final.pdf", isDir: false, size: 20, mtime: 2, artifactKind: "document" },
    ] }, error: null });
    renderWithLocale(<FilesView />);
    const reveal = await screen.findByTitle(/Reveal in Finder|Show in folder/);
    fireEvent.click(reveal);
    expect(postMock).toHaveBeenCalledWith("/api/fs/reveal", { path: "/workspace/final.pdf" });
    expect(isLocalFilesOrigin("files.example.com")).toBe(false);
    expect(isLocalFilesOrigin("127.0.0.1")).toBe(true);
  });
});
