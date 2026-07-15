import { fireEvent, screen, renderWithLocale } from "@/test/render";
import { describe, expect, it, vi } from "vitest";
import type { Artifact } from "@/types";
import ArtifactCard from "./ArtifactCard";

function artifact(overrides: Partial<Artifact> = {}): Artifact {
  return {
    id: "artifact-1",
    plugin_id: "sandpack_v1",
    title: "A-share report",
    status: "completed",
    data: {
      content_type: "html",
      code: "<!DOCTYPE html><html><head><style>body{}</style></head><body><h1>Investment report</h1><p>Ready to review.</p></body></html>",
    },
    timestamp: 1,
    ...overrides,
  };
}

describe("ArtifactCard", () => {
  it("shows title, quiet type metadata, and the open affordance", () => {
    renderWithLocale(<ArtifactCard artifact={artifact()} onOpen={vi.fn()} />);

    expect(screen.getByText("A-share report")).toBeInTheDocument();
    expect(screen.getByText("HTML")).toBeInTheDocument();
    expect(screen.getByText("Open")).toBeInTheDocument();
    expect(screen.queryByText("1 lines")).not.toBeInTheDocument();
    expect(screen.queryByText(/Investment report Ready to review/)).not.toBeInTheDocument();
    expect(screen.queryByText(/<!DOCTYPE html>/i)).not.toBeInTheDocument();
  });

  it("uses a document type and extension subtitle for document artifacts", () => {
    renderWithLocale(
      <ArtifactCard
        artifact={artifact({
          plugin_id: "document_v1",
          data: { content_type: "markdown", ext: "docx", markdown: "# Title\n\nFirst prose line of the report." },
        })}
        onOpen={vi.fn()}
      />,
    );

    expect(screen.getByText("Document · DOCX")).toBeInTheDocument();
    expect(screen.queryByText("Title")).not.toBeInTheDocument();
  });

  it("marks failed artifacts as interrupted", () => {
    renderWithLocale(<ArtifactCard artifact={artifact({ status: "failed" })} onOpen={vi.fn()} />);

    expect(screen.getByText("HTML · Interrupted")).toBeInTheDocument();
  });

  it("opens the artifact when the card is clicked", () => {
    const onOpen = vi.fn();
    const art = artifact();
    renderWithLocale(<ArtifactCard artifact={art} onOpen={onOpen} />);

    fireEvent.click(screen.getByRole("button", { name: /A-share report/i }));

    expect(onOpen).toHaveBeenCalledWith(art);
  });

  it("uses the constrained quiet surface and a small neutral icon slot", () => {
    renderWithLocale(<ArtifactCard artifact={artifact()} onOpen={vi.fn()} />);

    const card = screen.getByTestId("artifact-card");
    const iconSlot = screen.getByTestId("artifact-card-icon-slot");
    const icon = screen.getByTestId("artifact-type-icon");

    expect(card).toHaveClass("max-w-[460px]");
    expect(card).toHaveClass("rounded-lg");
    expect(card).toHaveClass("border-ink/[0.06]");
    expect(card).toHaveClass("bg-ink/[0.02]");
    expect(card).not.toHaveClass("rounded-xl");
    expect(card.className).not.toContain("hover:border-accent/30");
    expect(card.className).not.toContain("hover:bg-accent/10");
    expect(iconSlot).toHaveClass("h-7");
    expect(iconSlot).toHaveClass("w-7");
    expect(iconSlot).not.toHaveClass("h-9");
    expect(iconSlot).not.toHaveClass("w-9");
    expect(icon).toHaveStyle({ width: "22px", height: "22px" });
  });

  it("shows file_v1 filename, type, size, and a real Download action while opening the panel on card click", () => {
    const onOpen = vi.fn();
    const art = artifact({
      plugin_id: "file_v1",
      title: "Generated file",
      data: {
        path: "/tmp/report.xlsx",
        filename: "report.xlsx",
        ext: "xlsx",
        size: 1536,
        mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        kind: "sheet",
        previewable: false,
        downloadUrl: "/api/fs/file?path=server-authenticated",
      },
    });

    renderWithLocale(<ArtifactCard artifact={art} onOpen={onOpen} />);

    expect(screen.getByText("report.xlsx")).toBeInTheDocument();
    expect(screen.getByText("Sheet · XLSX · 1.5 KB")).toBeInTheDocument();
    const download = screen.getByRole("link", { name: /Download/i });
    expect(download).toHaveAttribute("href", "/api/fs/file?path=server-authenticated");

    download.addEventListener("click", (event) => event.preventDefault(), { once: true });
    fireEvent.click(download);
    expect(onOpen).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /report\.xlsx/i }));

    expect(onOpen).toHaveBeenCalledWith(art);
  });
});
