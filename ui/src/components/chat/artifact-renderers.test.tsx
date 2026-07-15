import { fireEvent, screen, renderWithLocale } from "@/test/render";
import { describe, expect, it } from "vitest";
import type { Artifact } from "@/types";
import { artifactSnippet, artifactTypeLabel, CodeRenderer, DocumentRenderer, getArtifactDownload, renderArtifactPrintHtml } from "./artifact-renderers";

function artifact(overrides: Partial<Artifact>): Artifact {
  return {
    id: "artifact-1",
    plugin_id: "sandpack_v1",
    title: "Preview",
    status: "completed",
    data: {},
    timestamp: 1,
    ...overrides,
  };
}

describe("artifact renderers", () => {
  it("uses the pdfjs LEGACY build in both realms (modern build garbles fonts on Electron)", async () => {
    // Electron's Chromium lacks Math.sumPrecise / Map.prototype.getOrInsertComputed,
    // which the modern pdfjs build calls during embedded-font translation; pdfjs
    // swallows the per-font TypeError and paints raw subset charcodes (garbled
    // CJK/Latin). The legacy build ships its own shims. Guard both import sites.
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    // vitest cwd is the ui/ package root; import.meta.url is http-scheme in jsdom.
    const renderer = await readFile(join(process.cwd(), "src/components/chat/artifact-renderers.tsx"), "utf8");
    const worker = await readFile(join(process.cwd(), "src/lib/pdf-worker.ts"), "utf8");

    expect(renderer).toContain('from "pdfjs-dist/legacy/build/pdf.mjs"');
    expect(renderer).not.toMatch(/from "pdfjs-dist";/);
    expect(worker).toContain('import "pdfjs-dist/legacy/build/pdf.worker.mjs"');
  });

  it("renders static HTML directly in an iframe instead of a Sandpack runtime", () => {
    const { container } = renderWithLocale(
      <CodeRenderer
        artifact={artifact({
          data: {
            content_type: "html",
            code: "<!DOCTYPE html><html><body><h1>Report</h1></body></html>",
          },
        })}
        showCode={false}
      />,
    );

    const iframe = container.querySelector("iframe");
    expect(iframe).toBeInTheDocument();
    expect(iframe?.getAttribute("srcdoc")).toContain("<h1>Report</h1>");
    expect(screen.queryByText(/Couldn't connect to server/i)).not.toBeInTheDocument();
  });

  it("recovers historical HTML that was stored as a markdown document", () => {
    const html = '<!DOCTYPE html><html><body><h1>Recovered dashboard</h1></body></html>';
    const historical = artifact({
      plugin_id: "document_v1",
      data: { content_type: "markdown", markdown: html },
    });
    const { container } = renderWithLocale(<CodeRenderer artifact={historical} showCode={false} />);

    expect(container.querySelector("iframe")?.getAttribute("srcdoc")).toContain("Recovered dashboard");
    expect(artifactTypeLabel(historical)).toBe("HTML");
    expect(getArtifactDownload(historical)).toMatchObject({
      filename: "Preview.html",
      mime: "text/html",
      text: html,
    });
  });

  it("shows a live generation state for running artifacts without code yet", () => {
    renderWithLocale(
      <CodeRenderer
        artifact={artifact({
          status: "running",
          fallback_text: "Generating preview...",
          data: { content_type: "html", code: "" },
        })}
        showCode={false}
      />,
    );

    expect(screen.getByText("Generating preview...")).toBeInTheDocument();
  });

  it("shows a live writing state for running document artifacts before markdown arrives", () => {
    renderWithLocale(
      <DocumentRenderer
        artifact={artifact({
          plugin_id: "live_work_v1",
          status: "running",
          fallback_text: "Writing document...",
          data: { content_type: "markdown", phase: "writing", live_preview: true },
        })}
      />,
    );

    expect(screen.getByText("Writing document...")).toBeInTheDocument();
    expect(screen.getByText("Content will appear here as soon as the model emits renderable output.")).toBeInTheDocument();
  });

  it("renders document markdown links with the shared link rules", () => {
    const doc = artifact({
      plugin_id: "document_v1",
      data: {
        content_type: "markdown",
        markdown: [
          "[HTTP](https://example.com/report)",
          "[CodeBuddy](codebuddy.cn/work)",
          "[Local deck](/Users/x/a.pptx)",
        ].join("\n\n"),
      },
    });

    renderWithLocale(<DocumentRenderer artifact={doc} />);

    const http = screen.getByRole("link", { name: "HTTP" });
    expect(http).toHaveAttribute("href", "https://example.com/report");
    expect(http).toHaveAttribute("target", "_blank");
    expect(http).toHaveAttribute("rel", "noopener noreferrer nofollow");

    const bareDomain = screen.getByRole("link", { name: "CodeBuddy" });
    expect(bareDomain).toHaveAttribute("href", "https://codebuddy.cn/work");
    expect(bareDomain).toHaveAttribute("target", "_blank");

    expect(screen.queryByRole("link", { name: "Local deck" })).not.toBeInTheDocument();
    expect(screen.getByText("Local deck")).toBeInTheDocument();

    const printHtml = renderArtifactPrintHtml(doc) ?? "";
    expect(printHtml).toContain('href="https://example.com/report"');
    expect(printHtml).toContain('href="https://codebuddy.cn/work"');
    expect(printHtml).toContain('target="_blank"');
    expect(printHtml).toContain('rel="noopener noreferrer nofollow"');
    expect(printHtml).not.toContain('href="/Users/x/a.pptx"');
  });

  it("shows a calm generating state (not raw code) while writing by default", () => {
    const { container } = renderWithLocale(
      <CodeRenderer
        artifact={artifact({
          plugin_id: "live_work_v1",
          status: "running",
          data: {
            content_type: "html",
            live_preview: true,
            phase: "rendering",
            code: "<!DOCTYPE html><html><body><h1>Half-writ",
          },
        })}
        showCode={false}
      />,
    );

    // A user asking for a deck must NOT be shown raw streaming source by
    // default — a calm generating state, no code, no broken iframe.
    expect(container.querySelector("iframe")).not.toBeInTheDocument();
    expect(container.querySelector('[data-testid="artifact-live-code"]')).not.toBeInTheDocument();
    expect(screen.queryByText(/Half-writ/)).not.toBeInTheDocument();
  });

  it("keeps the opt-in live code view compact by rendering only a capped tail", () => {
    const code = [
      "BEGIN-ONLY",
      ...Array.from({ length: 70 }, (_, index) => `chunk-${index + 1}`),
      "TAIL-ONLY",
    ].join("\n");

    renderWithLocale(
      <CodeRenderer
        artifact={artifact({
          plugin_id: "live_work_v1",
          status: "running",
          data: {
            content_type: "html",
            live_preview: true,
            phase: "rendering",
            code,
          },
        })}
        showCode={true}
      />,
    );

    expect(screen.getByTestId("artifact-live-code-window")).not.toHaveClass("max-h-[180px]");
    expect(screen.getByTestId("artifact-live-code-counts")).toHaveTextContent("72 lines");
    expect(screen.getByText(/BEGIN-ONLY/)).toBeInTheDocument();
    expect(screen.getByText(/TAIL-ONLY/)).toBeInTheDocument();
  });

  it("lets the user collapse the default-expanded live code view to the source tail", () => {
    const code = [
      "BEGIN-ONLY",
      ...Array.from({ length: 70 }, (_, index) => `chunk-${index + 1}`),
      "TAIL-ONLY",
    ].join("\n");

    renderWithLocale(
      <CodeRenderer
        artifact={artifact({
          plugin_id: "live_work_v1",
          status: "running",
          data: {
            content_type: "html",
            live_preview: true,
            phase: "rendering",
            code,
          },
        })}
        showCode={true}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Collapse" }));

    expect(screen.getByTestId("artifact-live-code-window")).toHaveClass("max-h-[180px]");
    expect(screen.getByRole("button", { name: "Expand" })).toBeInTheDocument();
    expect(screen.queryByText(/BEGIN-ONLY/)).not.toBeInTheDocument();
    expect(screen.getByText(/TAIL-ONLY/)).toBeInTheDocument();
  });

  it("flips from the live stream to the rendered preview once the artifact completes", () => {
    const { container } = renderWithLocale(
      <CodeRenderer
        artifact={artifact({
          plugin_id: "live_work_v1",
          status: "completed",
          data: {
            content_type: "html",
            live_preview: true,
            code: "<!DOCTYPE html><html><body><h1>Done</h1></body></html>",
          },
        })}
        showCode={false}
      />,
    );

    expect(container.querySelector('[data-testid="artifact-live-code"]')).not.toBeInTheDocument();
    expect(container.querySelector("iframe")?.getAttribute("srcdoc")).toContain("<h1>Done</h1>");
  });

  it("uses visible HTML text for artifact card snippets instead of leaking doctype/source boilerplate", () => {
    expect(
      artifactSnippet(artifact({
        data: {
          content_type: "html",
          code: "<!DOCTYPE html><html><head><style>body{}</style></head><body><h1>Investment report</h1><p>Ready to review.</p></body></html>",
        },
      })),
    ).toBe("Investment report Ready to review.");
  });
});
