import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  SandpackProvider,
  SandpackPreview,
  SandpackCodeEditor,
  SandpackLayout,
} from "@codesandbox/sandpack-react";
import type { SandpackPredefinedTemplate, SandpackFiles, SandpackTheme } from "@codesandbox/sandpack-react";
import { renderAsync } from "docx-preview";
// pdfjs LEGACY build: the modern build assumes bleeding-edge JS APIs
// (Math.sumPrecise, Map.prototype.getOrInsertComputed, …) that Electron's
// Chromium lacks — every embedded font then fails to translate and pdfjs
// silently paints raw subset charcodes (garbled CJK/Latin). The legacy build
// ships its own shims, so no hand-rolled polyfills to forget next upgrade.
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import pdfWorkerUrl from "@/lib/pdf-worker?worker&url";
import * as XLSX from "xlsx";
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight, Download, Loader2 } from "lucide-react";
import type { Artifact } from "@/types";
import { useLocale } from "@/i18n";
import { cn } from "@/lib/utils";
import { TypeIcon, resolveArtifactType } from "./artifact-type-icons";
import { MARKDOWN_COMPONENTS } from "./markdown-link";
import { normalizeMarkdownTables } from "./markdown-normalize";
import {
  fileDownloadUrl,
  buildFileArtifact,
  formatFileSize,
  getFileArtifactInfo,
  isFileArtifact,
  resolveArtifactKind,
  artifactContentLooksLikeStandaloneHtml,
  type ArtifactKind,
  type FileArtifactInfo,
} from "@/lib/file-artifact";
import { highlightCode, shikiLangForExt } from "@/lib/shiki-highlight";
import { useTheme } from "@/theme/ThemeProvider";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

/**
 * Artifact canvas renderers.
 *
 * The canvas is a registry: an artifact's `plugin_id` / `content_type` maps to a
 * renderer. Adding a new content kind (pdf, sheet, slides, …) means adding a
 * renderer here and a case in {@link resolveArtifactKind} — the panel shell does
 * not change. Keep binary formats (Office/PDF/image-by-bytes) behind a backend
 * that exposes a fetchable URL on `artifact.data`.
 */
type ContentType = "html" | "react" | "svg" | "vanilla-js";

const LIVE_CODE_TAIL_LINES = 48;
const LIVE_CODE_TAIL_CHARS = 6000;

// ---------------------------------------------------------------------------
// Kind resolution
// ---------------------------------------------------------------------------

export function artifactTypeLabel(artifact: Artifact): string {
  switch (resolveArtifactKind(artifact)) {
    case "file":
      return "File";
    case "document":
      return "Doc";
    case "image":
      return "Image";
    case "code": {
      if (artifactContentLooksLikeStandaloneHtml(artifact)) return "HTML";
      const ct = String(artifact.data.content_type ?? "").toLowerCase();
      if (ct === "react") return "React";
      if (ct === "svg") return "SVG";
      if (ct === "html") return "HTML";
      if (ct === "javascript" || ct === "vanilla-js") return "JS";
      return "Code";
    }
    default:
      return "File";
  }
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function stringMatrixValue(value: unknown): string[][] | null {
  if (!Array.isArray(value)) return null;
  const rows = value
    .filter((row): row is unknown[] => Array.isArray(row))
    .map((row) => row.map((cell) => String(cell ?? "")));
  return rows.length > 0 ? rows : null;
}

function basename(path: string): string | null {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? null;
}

function inferExtension(filename: string): string {
  const last = filename.split(".").pop();
  return last && last !== filename ? last.replace(/^\./, "").toLowerCase() : "";
}

// Re-exported from the lightweight module so existing importers keep working
// without pulling heavy renderer deps into their bundle.
export { fileDownloadUrl, buildFileArtifact, formatFileSize, getFileArtifactInfo, resolveArtifactKind };
export type { ArtifactKind, FileArtifactInfo };

export function officePdfUrl(path: string): string {
  return `/api/fs/office-pdf?path=${encodeURIComponent(path)}`;
}

/** One-line content preview for the inline card (Manus-style thumbnail text). */
export function artifactSnippet(artifact: Artifact): string {
  const kind = resolveArtifactKind(artifact);
  if (kind === "document") {
    const md = extractDocument(artifact);
    const firstProse = md
      .split("\n")
      .map((line) => line.replace(/^#{1,6}\s*/, "").replace(/^\s*[-*|]\s*/, "").trim())
      .find((line) => line.length > 0);
    return firstProse ? firstProse.slice(0, 120) : "";
  }
  if (kind === "code") {
    const code = extractCode(artifact) ?? "";
    const explicit = String(artifact.data.content_type ?? "").toLowerCase();
    const contentType = explicit === "javascript" ? "vanilla-js" : explicit || detectContentType(code);
    if (contentType === "html" || contentType === "svg") {
      const visibleText = extractVisibleMarkupText(code);
      if (visibleText) return visibleText.slice(0, 120);
    }
    return code
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => !/^<!doctype\b/i.test(line) && !/^<\/?(html|head|body)\b/i.test(line))
      .find((line) => line.length > 0)
      ?.slice(0, 120) ?? "";
  }
  return "";
}

function decodeCommonEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'");
}

function extractVisibleMarkupText(markup: string): string {
  return decodeCommonEntities(markup)
    .replace(/<!doctype[^>]*>/gi, " ")
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<head\b[\s\S]*?<\/head>/gi, " ")
    .replace(/<svg\b[^>]*>/gi, " ")
    .replace(/<\/svg>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// Document renderer (markdown / report)
// ---------------------------------------------------------------------------

/** Prose + table styling shared with chat messages so documents read consistently. */
const PROSE_CLASS =
  "text-sm leading-relaxed prose prose-invert prose-sm max-w-none [&_pre]:bg-[var(--code-bg)] [&_pre]:border [&_pre]:border-ink/[0.06] [&_pre]:rounded-lg [&_pre]:p-3.5 [&_pre]:overflow-x-auto [&_pre]:text-xs [&_pre]:font-mono [&_code]:text-accent-light [&_code]:text-xs [&_code]:font-mono [&_a]:text-accent [&_a]:underline [&_a]:underline-offset-2 [&_table]:my-3 [&_table]:block [&_table]:w-fit [&_table]:max-w-full [&_table]:overflow-x-auto [&_table]:border-separate [&_table]:border-spacing-0 [&_table]:rounded-lg [&_table]:border [&_table]:border-ink/10 [&_table]:text-xs [&_thead]:bg-ink/[0.04] [&_th]:whitespace-nowrap [&_th]:border-b [&_th]:border-ink/10 [&_th]:px-3 [&_th]:py-1.5 [&_th]:text-left [&_th]:font-medium [&_th]:text-ink/60 [&_td]:border-b [&_td]:border-ink/[0.05] [&_td]:px-3 [&_td]:py-1.5 [&_td]:text-ink/70 [&_tr:last-child_td]:border-b-0";

function extractDocument(artifact: Artifact): string {
  const d = artifact.data;
  for (const key of ["markdown", "content", "text", "code"]) {
    if (typeof d[key] === "string" && (d[key] as string).trim()) return d[key] as string;
  }
  return "";
}

export function DocumentRenderer({ artifact }: { artifact: Artifact }) {
  const markdown = useMemo(() => extractDocument(artifact), [artifact.data]);
  if (!markdown) {
    return artifact.status === "running"
      ? <LiveWorkingState artifact={artifact} />
      : <EmptyState label="No document content" />;
  }
  return (
    <div className="h-full overflow-y-auto px-6 py-5">
      <div className={`${PROSE_CLASS} mx-auto max-w-[760px]`}>
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>
          {normalizeMarkdownTables(markdown)}
        </ReactMarkdown>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Image renderer
// ---------------------------------------------------------------------------

function extractImageSrc(artifact: Artifact): string | null {
  const d = artifact.data;
  for (const key of ["image_url", "url", "src", "image"]) {
    if (typeof d[key] === "string" && (d[key] as string).trim()) return d[key] as string;
  }
  return null;
}

export function ImageRenderer({ artifact }: { artifact: Artifact }) {
  const src = useMemo(() => extractImageSrc(artifact), [artifact.data]);
  if (!src) return <EmptyState label="No image to display" />;
  return (
    <div className="flex h-full items-center justify-center overflow-auto bg-black/20 p-6">
      <img src={src} alt={artifact.title} className="max-h-full max-w-full rounded-lg object-contain" />
    </div>
  );
}

type PdfDocumentProxy = import("pdfjs-dist/legacy/build/pdf.mjs").PDFDocumentProxy;
type SortDirection = "asc" | "desc";

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const SHEET_EXTENSIONS = new Set(["xlsx", "xls", "ods", "csv", "tsv"]);
// Formats supported by the local ONLYOFFICE session contract. The simplified
// PDF, HTML, and sheet renderers remain explicit fallbacks only.
const NATIVE_OFFICE_EXTENSIONS = new Set(["doc", "docx", "odt", "rtf", "xls", "xlsx", "ods", "csv", "ppt", "pptx", "odp"]);
const MAX_RENDERED_SHEET_ROWS = 500;

function isPdfInfo(info: FileArtifactInfo): boolean {
  return info.ext === "pdf" || info.mime.toLowerCase().includes("application/pdf");
}

function isDocxInfo(info: FileArtifactInfo): boolean {
  return info.ext === "docx" || info.mime.toLowerCase().includes(DOCX_MIME);
}

function isSheetInfo(info: FileArtifactInfo): boolean {
  const mime = info.mime.toLowerCase();
  return SHEET_EXTENSIONS.has(info.ext)
    || mime.includes(XLSX_MIME)
    || mime.includes("text/csv")
    || mime.includes("text/tab-separated-values");
}

function isOfficeConvertInfo(info: FileArtifactInfo): boolean {
  return NATIVE_OFFICE_EXTENSIONS.has(info.ext);
}

function safeErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function useFileArrayBuffer(url: string | null) {
  const [buffer, setBuffer] = useState<ArrayBuffer | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "loaded" | "failed">("idle");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!url) {
      setBuffer(null);
      setStatus("idle");
      setError(null);
      return;
    }

    const controller = new AbortController();
    setBuffer(null);
    setStatus("loading");
    setError(null);

    fetch(url, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.arrayBuffer();
      })
      .then((nextBuffer) => {
        setBuffer(nextBuffer);
        setStatus("loaded");
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setBuffer(null);
        setStatus("failed");
        setError(safeErrorMessage(err));
      });

    return () => controller.abort();
  }, [url]);

  return { buffer, status, error };
}

function FileArtifactFooter({
  info,
  type,
  sizeLabel,
  downloadLabel,
}: {
  info: FileArtifactInfo;
  type: string;
  sizeLabel: string;
  downloadLabel: string;
}) {
  return (
    <div className="shrink-0 border-t border-ink/[0.06] bg-surface/95 px-5 py-3">
      <div className="flex min-w-0 items-center gap-3">
        <TypeIcon type={type} size={28} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-medium text-ink/82">{info.filename}</p>
          {sizeLabel && <p className="mt-px text-[11px] text-ink/38">{sizeLabel}</p>}
        </div>
        {info.downloadUrl && (
          <a
            data-testid="file-artifact-download"
            href={info.downloadUrl}
            download={info.filename}
            className="inline-flex shrink-0 items-center gap-2 rounded-lg bg-accent px-3 py-2 text-xs font-medium text-white shadow-sm transition-colors hover:bg-accent/90"
          >
            <Download size={14} />
            <span>{downloadLabel}</span>
          </a>
        )}
      </div>
    </div>
  );
}

function BinaryPreviewFrame({
  children,
  info,
  type,
  sizeLabel,
  downloadLabel,
}: {
  children: React.ReactNode;
  info: FileArtifactInfo;
  type: string;
  sizeLabel: string;
  downloadLabel: string;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-black/10">
      <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
      <FileArtifactFooter info={info} type={type} sizeLabel={sizeLabel} downloadLabel={downloadLabel} />
    </div>
  );
}

const MAX_TEXT_PREVIEW_CHARS = 500_000;

function useFileText(url: string | null) {
  const [text, setText] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "loaded" | "failed">("idle");

  useEffect(() => {
    if (!url) { setText(null); setStatus("idle"); return; }
    const controller = new AbortController();
    setText(null);
    setStatus("loading");
    fetch(url, { signal: controller.signal })
      .then((response) => { if (!response.ok) throw new Error(`HTTP ${response.status}`); return response.text(); })
      .then((body) => {
        setText(body.length > MAX_TEXT_PREVIEW_CHARS ? body.slice(0, MAX_TEXT_PREVIEW_CHARS) : body);
        setStatus("loaded");
      })
      .catch((err: unknown) => { if (controller.signal.aborted) return; setText(null); setStatus("failed"); });
    return () => controller.abort();
  }, [url]);

  return { text, status };
}

/** Image files: render the bytes directly — no server-side preview needed. */
function ImageFileRenderer({
  info, type, sizeLabel, downloadLabel,
}: { info: FileArtifactInfo; type: string; sizeLabel: string; downloadLabel: string }) {
  return (
    <BinaryPreviewFrame info={info} type={type} sizeLabel={sizeLabel} downloadLabel={downloadLabel}>
      <div className="flex h-full min-h-[260px] items-center justify-center overflow-auto p-6">
        <img
          data-testid="file-artifact-image"
          src={info.downloadUrl ?? undefined}
          alt={info.filename}
          className="max-h-full max-w-full rounded-lg border border-ink/[0.08] bg-white object-contain shadow-xl"
        />
      </div>
    </BinaryPreviewFrame>
  );
}

const MARKDOWN_PREVIEW_EXTENSIONS = new Set(["md", "markdown", "mdx"]);

/** Text/code/markdown/json/html source: fetch and render client-side. */
function TextFileRenderer({
  info, type, sizeLabel, downloadLabel,
}: { info: FileArtifactInfo; type: string; sizeLabel: string; downloadLabel: string }) {
  const { t } = useLocale();
  const { resolvedTheme } = useTheme();
  const { text, status } = useFileText(info.downloadUrl);
  const asMarkdown = MARKDOWN_PREVIEW_EXTENSIONS.has(info.ext);
  const shikiLang = useMemo(() => shikiLangForExt(info.ext), [info.ext]);
  const [highlightedHtml, setHighlightedHtml] = useState<string | null>(null);

  useEffect(() => {
    if (asMarkdown || status !== "loaded" || text === null) {
      setHighlightedHtml(null);
      return;
    }

    let cancelled = false;
    setHighlightedHtml(null);
    highlightCode(text, shikiLang, resolvedTheme === "dark")
      .then((html) => {
        if (cancelled) return;
        setHighlightedHtml(html);
      });

    return () => {
      cancelled = true;
    };
  }, [asMarkdown, resolvedTheme, shikiLang, status, text]);

  return (
    <BinaryPreviewFrame info={info} type={type} sizeLabel={sizeLabel} downloadLabel={downloadLabel}>
      <div className="h-full min-h-0 overflow-auto bg-surface px-6 py-5" data-testid="file-artifact-text">
        {status === "loading" && (
          <div className="flex items-center gap-2 text-xs text-ink/45"><Loader2 size={14} className="animate-spin text-accent" />{t("artifact.preview.loading")}</div>
        )}
        {status === "failed" && <div className="text-xs text-warning">{t("artifact.unsupportedType")}</div>}
        {status === "loaded" && text !== null && (
          asMarkdown ? (
            <div className="prose prose-invert prose-sm max-w-none text-sm leading-relaxed">
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>{normalizeMarkdownTables(text)}</ReactMarkdown>
            </div>
          ) : highlightedHtml ? (
            <div
              className="overflow-x-auto font-mono text-[12.5px]"
              dangerouslySetInnerHTML={{ __html: highlightedHtml }}
            />
          ) : (
            <pre className="whitespace-pre-wrap break-words font-mono text-[12.5px] leading-5 text-ink/80">{text}</pre>
          )
        )}
      </div>
    </BinaryPreviewFrame>
  );
}

/** Types that render as fetched text (source view). */
const TEXT_PREVIEW_TYPES = new Set(["code", "document", "html", "js", "react", "svg"]);

/** LibreOffice/PDF or format-specific preview used when ONLYOFFICE is unavailable. */
function OfficeFallbackRenderer({
  info,
  type,
  sizeLabel,
  downloadLabel,
}: {
  info: FileArtifactInfo;
  type: string;
  sizeLabel: string;
  downloadLabel: string;
}) {
  const { t } = useLocale();
  const [pdfFailed, setPdfFailed] = useState(false);
  const handleLoadFailed = useCallback(() => setPdfFailed(true), []);

  // Spreadsheets → interactive SheetJS grid (all worksheets).
  if (isSheetInfo(info)) {
    return <SheetFileRenderer info={info} type={type} sizeLabel={sizeLabel} downloadLabel={downloadLabel} />;
  }

  // Word → high-fidelity, scrollable, selectable client-side docx-preview. No
  // LibreOffice conversion, no ONLYOFFICE service — this is the primary Word
  // viewer now, not a last-resort fallback.
  if (isDocxInfo(info)) {
    return <DocxFileRenderer info={info} type={type} sizeLabel={sizeLabel} downloadLabel={downloadLabel} />;
  }

  // Slides / other office types → LibreOffice-converted PDF preview (the only
  // decent embedded option for pptx); binary card if even that is unavailable.
  if (pdfFailed) {
    return <BinaryPreviewFrame info={info} type={type} sizeLabel={sizeLabel} downloadLabel={downloadLabel} />;
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="office-fallback-preview">
      <div className="min-h-0 flex-1">
        <PdfFileRenderer
          info={info}
          type={type}
          sizeLabel={sizeLabel}
          downloadLabel={downloadLabel}
          pdfUrl={info.path ? officePdfUrl(info.path) : undefined}
          onLoadFailed={handleLoadFailed}
        />
      </div>
    </div>
  );
}

interface OnlyOfficeSessionResponse {
  success: boolean;
  available: boolean;
  mode: "native";
  engine: "onlyoffice";
  editable: boolean;
  scriptUrl: string;
  config: Record<string, unknown>;
}

interface OnlyOfficeEditorHandle { destroyEditor?: () => void }

declare global {
  interface Window {
    DocsAPI?: { DocEditor: new (elementId: string, config: Record<string, unknown>) => OnlyOfficeEditorHandle };
  }
}

const onlyOfficeScriptLoads = new Map<string, Promise<void>>();

function loadOnlyOfficeScript(url: string): Promise<void> {
  if (window.DocsAPI?.DocEditor) return Promise.resolve();
  const existing = onlyOfficeScriptLoads.get(url);
  if (existing) return existing;
  const promise = new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = url;
    script.async = true;
    script.dataset.onlyoffice = "true";
    script.onload = () => window.DocsAPI?.DocEditor ? resolve() : reject(new Error("ONLYOFFICE API did not initialize"));
    script.onerror = () => reject(new Error("ONLYOFFICE document service is unavailable"));
    document.head.appendChild(script);
  }).catch((error) => {
    onlyOfficeScriptLoads.delete(url);
    throw error;
  });
  onlyOfficeScriptLoads.set(url, promise);
  return promise;
}

function NativeOfficeRenderer({
  info,
  type,
  sizeLabel,
  downloadLabel,
}: {
  info: FileArtifactInfo;
  type: string;
  sizeLabel: string;
  downloadLabel: string;
}) {
  const { locale, t } = useLocale();
  const [fallback, setFallback] = useState(false);
  const [loading, setLoading] = useState(true);
  const editorId = useRef(`onlyoffice-${Math.random().toString(36).slice(2)}`);

  useEffect(() => {
    if (!info.path) {
      setFallback(true);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    let editor: OnlyOfficeEditorHandle | null = null;
    setFallback(false);
    setLoading(true);
    fetch(`/api/office/session?path=${encodeURIComponent(info.path)}&locale=${encodeURIComponent(locale)}`, {
      credentials: "same-origin",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Native Office unavailable (${response.status})`);
        return response.json() as Promise<OnlyOfficeSessionResponse>;
      })
      .then(async (session) => {
        if (!session.available || !session.scriptUrl) throw new Error("Native Office unavailable");
        await loadOnlyOfficeScript(session.scriptUrl);
        if (controller.signal.aborted || !window.DocsAPI?.DocEditor) return;
        editor = new window.DocsAPI.DocEditor(editorId.current, {
          ...session.config,
          width: "100%",
          height: "100%",
        });
        setLoading(false);
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setFallback(true);
        setLoading(false);
      });
    return () => {
      controller.abort();
      editor?.destroyEditor?.();
    };
  }, [info.path, locale]);

  if (fallback) {
    return <OfficeFallbackRenderer info={info} type={type} sizeLabel={sizeLabel} downloadLabel={downloadLabel} />;
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface" data-testid="native-office-editor">
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-ink/[0.06] px-3 text-[11px] text-ink/45">
        <span className="font-medium text-success">{t("artifact.office.native")}</span>
        <span>{t("artifact.office.readOnly")}</span>
      </div>
      <div className="relative min-h-0 flex-1">
        {loading && <div className="absolute inset-0 z-10 flex items-center justify-center"><LoadingState label={t("artifact.office.opening")} /></div>}
        <div id={editorId.current} className="h-full min-h-[420px] w-full" />
      </div>
    </div>
  );
}

function PdfFileRenderer({
  info,
  type,
  sizeLabel,
  downloadLabel,
  pdfUrl,
  onLoadFailed,
}: {
  info: FileArtifactInfo;
  type: string;
  sizeLabel: string;
  downloadLabel: string;
  pdfUrl?: string;
  /** Notified when the PDF source can't be fetched (e.g. office conversion
   *  failed server-side) so callers can fall back to a legacy renderer. */
  onLoadFailed?: () => void;
}) {
  const { buffer, status, error } = useFileArrayBuffer(pdfUrl ?? info.downloadUrl);
  useEffect(() => {
    if (status === "failed") onLoadFailed?.();
  }, [status, onLoadFailed]);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const [pdfDoc, setPdfDoc] = useState<PdfDocumentProxy | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [pageCount, setPageCount] = useState(0);
  const [renderStatus, setRenderStatus] = useState<"idle" | "loading" | "failed">("idle");
  const [renderError, setRenderError] = useState<string | null>(null);

  useEffect(() => {
    if (!buffer) {
      setPdfDoc(null);
      setPageCount(0);
      setPageNumber(1);
      return;
    }

    let cancelled = false;
    const task = pdfjsLib.getDocument({
      data: new Uint8Array(buffer.slice(0)),
      // CJK CMaps + standard fonts (copied into dist by the pdfjsFontAssets Vite
      // plugin) so Chinese and other CID-font text renders instead of blanks.
      cMapUrl: `${import.meta.env.BASE_URL}cmaps/`,
      cMapPacked: true,
      standardFontDataUrl: `${import.meta.env.BASE_URL}standard_fonts/`,
    });
    task.promise
      .then((doc) => {
        if (cancelled) {
          void doc.destroy();
          return;
        }
        setPdfDoc(doc);
        setPageCount(doc.numPages);
        setPageNumber(1);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setPdfDoc(null);
        setPageCount(0);
        setRenderStatus("failed");
        setRenderError(safeErrorMessage(err));
      });

    return () => {
      cancelled = true;
      void task.destroy();
    };
  }, [buffer]);

  useEffect(() => {
    if (!pdfDoc || !canvasRef.current) return;

    let cancelled = false;
    let renderTask: pdfjsLib.RenderTask | null = null;
    setRenderStatus("loading");
    setRenderError(null);

    pdfDoc.getPage(pageNumber)
      .then((page) => {
        if (cancelled || !canvasRef.current) return null;
        const rawViewport = page.getViewport({ scale: 1 });
        const containerWidth = viewportRef.current?.clientWidth ?? 900;
        const targetWidth = Math.max(320, Math.min(containerWidth - 48, 1120));
        const scale = Math.max(0.5, Math.min(2.5, targetWidth / rawViewport.width));
        const viewport = page.getViewport({ scale });
        const canvas = canvasRef.current;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("Canvas context unavailable");
        const deviceScale = Math.min(window.devicePixelRatio || 1, 2);
        canvas.width = Math.floor(viewport.width * deviceScale);
        canvas.height = Math.floor(viewport.height * deviceScale);
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;
        context.setTransform(deviceScale, 0, 0, deviceScale, 0, 0);
        context.clearRect(0, 0, viewport.width, viewport.height);
        renderTask = page.render({ canvasContext: context, canvas, viewport });
        return renderTask.promise;
      })
      .then(() => {
        if (cancelled) return;
        setRenderStatus("idle");
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setRenderStatus("failed");
        setRenderError(safeErrorMessage(err));
      });

    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [pdfDoc, pageNumber]);

  const displayError = error ?? renderError;
  return (
    <BinaryPreviewFrame info={info} type={type} sizeLabel={sizeLabel} downloadLabel={downloadLabel}>
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex h-12 shrink-0 items-center justify-center gap-3 border-b border-ink/[0.06] bg-surface/90 px-4">
          <button
            type="button"
            title="Previous page"
            disabled={pageNumber <= 1 || !pageCount}
            onClick={() => setPageNumber((value) => Math.max(1, value - 1))}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-ink/[0.08] text-ink/64 transition-colors hover:bg-ink/[0.05] disabled:cursor-not-allowed disabled:opacity-35"
          >
            <ChevronLeft size={16} />
          </button>
          <span className="min-w-[96px] text-center text-xs font-medium text-ink/62">
            {pageCount ? `Page ${pageNumber} of ${pageCount}` : "Page"}
          </span>
          <button
            type="button"
            title="Next page"
            disabled={pageNumber >= pageCount || !pageCount}
            onClick={() => setPageNumber((value) => Math.min(pageCount, value + 1))}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-ink/[0.08] text-ink/64 transition-colors hover:bg-ink/[0.05] disabled:cursor-not-allowed disabled:opacity-35"
          >
            <ChevronRight size={16} />
          </button>
        </div>
        <div ref={viewportRef} className="relative min-h-0 flex-1 overflow-auto p-6">
          {(status === "loading" || renderStatus === "loading") && (
            <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/5">
              <LoadingState label="Loading preview" />
            </div>
          )}
          {(status === "failed" || renderStatus === "failed") && (
            <div className="flex h-full items-center justify-center px-6 text-center">
              <p className="max-w-[420px] text-sm text-ink/42">{displayError || "PDF preview failed"}</p>
            </div>
          )}
          {status !== "failed" && renderStatus !== "failed" && (
            <div className="flex min-h-full items-start justify-center">
              <canvas ref={canvasRef} className="rounded-md bg-white shadow-xl ring-1 ring-ink/[0.08]" />
            </div>
          )}
        </div>
      </div>
    </BinaryPreviewFrame>
  );
}

const DOCX_ALLOWED_TAGS = new Set([
  "a",
  "b",
  "blockquote",
  "br",
  "code",
  "div",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "i",
  "img",
  "li",
  "ol",
  "p",
  "pre",
  "s",
  "span",
  "strong",
  "sub",
  "sup",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "u",
  "ul",
]);

const DOCX_ALLOWED_ATTRS = new Set(["alt", "colspan", "href", "rowspan", "src", "title"]);

function unwrapElement(element: Element): void {
  const parent = element.parentNode;
  if (!parent) return;
  while (element.firstChild) parent.insertBefore(element.firstChild, element);
  parent.removeChild(element);
}

function isSafeDocxUrl(value: string, allowImageData: boolean): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (allowImageData && /^data:image\//i.test(trimmed)) return true;
  if (trimmed.startsWith("#") || trimmed.startsWith("/") || trimmed.startsWith("./") || trimmed.startsWith("../")) return true;
  return /^(https?:|mailto:|tel:)/i.test(trimmed);
}


function DocxFileRenderer({
  info,
  type,
  sizeLabel,
  downloadLabel,
}: {
  info: FileArtifactInfo;
  type: string;
  sizeLabel: string;
  downloadLabel: string;
}) {
  const { buffer, status, error } = useFileArrayBuffer(info.downloadUrl);
  const containerRef = useRef<HTMLDivElement>(null);
  const [renderStatus, setRenderStatus] = useState<"idle" | "loading" | "failed">("idle");
  const [renderError, setRenderError] = useState<string | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!buffer || !container) {
      setRenderStatus("idle");
      setRenderError(null);
      return;
    }

    let cancelled = false;
    container.replaceChildren();
    setRenderStatus("loading");
    setRenderError(null);

    // docx-preview renders the real Word layout (styles, tables, images,
    // headers/footers, page breaks) into the DOM — far higher fidelity than the
    // old mammoth HTML, fully client-side, no ONLYOFFICE service.
    renderAsync(buffer, container, undefined, {
      className: "docx",
      inWrapper: true,
      breakPages: true,
      ignoreLastRenderedPageBreak: true,
      experimental: true,
      useBase64URL: true,
    })
      .then(() => { if (!cancelled) setRenderStatus("idle"); })
      .catch((err: unknown) => {
        if (cancelled) return;
        container.replaceChildren();
        setRenderStatus("failed");
        setRenderError(safeErrorMessage(err));
      });

    return () => { cancelled = true; };
  }, [buffer]);

  const failed = status === "failed" || renderStatus === "failed";
  const loading = status === "loading" || renderStatus === "loading";
  const displayError = error ?? renderError;

  return (
    <BinaryPreviewFrame info={info} type={type} sizeLabel={sizeLabel} downloadLabel={downloadLabel}>
      <div className="h-full overflow-y-auto bg-neutral-200/60 px-4 py-5">
        {loading && <LoadingState label="Loading preview" />}
        {failed && (
          <div className="flex h-full items-center justify-center px-6 text-center">
            <p className="max-w-[420px] text-sm text-ink/42">{displayError || "DOCX preview failed"}</p>
          </div>
        )}
        <div
          ref={containerRef}
          data-testid="docx-preview-host"
          className="docx-preview-host mx-auto text-neutral-900"
          style={failed ? { display: "none" } : undefined}
        />
      </div>
    </BinaryPreviewFrame>
  );
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toLocaleString();
  return String(value);
}

function normalizeSheetRows(rows: unknown[][]): string[][] {
  return rows
    .map((row) => row.map(cellText))
    .filter((row) => row.some((cell) => cell.trim().length > 0));
}

interface ParsedWorkbookSheet {
  name: string;
  rows: string[][];
}

function parseWorkbookSheets(buffer: ArrayBuffer, info: FileArtifactInfo): ParsedWorkbookSheet[] {
  const extension = info.ext.toLowerCase();
  // Honesty gate: a real .xlsx is a ZIP container (PK\x03\x04). SheetJS is
  // lenient and will "render" arbitrary text named .xlsx as a phantom
  // spreadsheet (seen live: a model wrote a 48-byte placeholder note with an
  // .xlsx name and the viewer showed a fake 0-row grid). Refuse loudly instead.
  if (extension === "xlsx") {
    const magic = new Uint8Array(buffer.slice(0, 4));
    const isZip = magic[0] === 0x50 && magic[1] === 0x4b && (magic[2] === 0x03 || magic[2] === 0x05 || magic[2] === 0x07);
    if (!isZip) {
      const textPeek = new TextDecoder("utf-8", { fatal: false }).decode(buffer.slice(0, 160)).trim();
      throw new Error(
        `Not a valid Excel file — the content is ${textPeek ? `plain text: "${textPeek}"` : "not an xlsx container"}. The file was likely written as a placeholder instead of a real workbook.`,
      );
    }
  }
  const workbook = extension === "csv" || extension === "tsv"
    ? XLSX.read(new TextDecoder().decode(buffer), {
      type: "string",
      raw: false,
      FS: extension === "tsv" ? "\t" : ",",
    })
    : XLSX.read(buffer, { type: "array", raw: false, cellDates: true });
  // Every sheet, not just the first — the old renderer silently dropped all
  // other worksheets, which is how a 5-sheet workbook read as a flat table.
  return workbook.SheetNames.map((name) => ({
    name,
    rows: normalizeSheetRows(
      XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1, defval: "", raw: false }) as unknown[][],
    ),
  }));
}

function compareSheetCells(a: string, b: string): number {
  const aNumber = Number(a.replace(/,/g, ""));
  const bNumber = Number(b.replace(/,/g, ""));
  if (a.trim() && b.trim() && Number.isFinite(aNumber) && Number.isFinite(bNumber)) return aNumber - bNumber;
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

function SheetFileRenderer({
  info,
  type,
  sizeLabel,
  downloadLabel,
}: {
  info: FileArtifactInfo;
  type: string;
  sizeLabel: string;
  downloadLabel: string;
}) {
  const { buffer, status, error } = useFileArrayBuffer(info.downloadUrl);
  const fallbackSheets: ParsedWorkbookSheet[] = info.previewRows?.length
    ? [{ name: "Sheet1", rows: info.previewRows }]
    : [];
  const [sheets, setSheets] = useState<ParsedWorkbookSheet[]>(fallbackSheets);
  const [activeSheet, setActiveSheet] = useState(0);
  const [viewMode, setViewMode] = useState<"grid" | "print">("grid");
  const [parseStatus, setParseStatus] = useState<"idle" | "loading" | "failed">("idle");
  const [parseError, setParseError] = useState<string | null>(null);
  const [sort, setSort] = useState<{ column: number; direction: SortDirection } | null>(null);

  useEffect(() => {
    if (!buffer) {
      setSheets(info.previewRows?.length ? [{ name: "Sheet1", rows: info.previewRows }] : []);
      setParseStatus("idle");
      setParseError(null);
      return;
    }

    try {
      setParseStatus("loading");
      setParseError(null);
      setSheets(parseWorkbookSheets(buffer, info));
      setActiveSheet(0);
      setParseStatus("idle");
    } catch (err: unknown) {
      setSheets(info.previewRows?.length ? [{ name: "Sheet1", rows: info.previewRows }] : []);
      setParseStatus("failed");
      setParseError(safeErrorMessage(err));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buffer, info]);

  const rows = sheets[Math.min(activeSheet, Math.max(0, sheets.length - 1))]?.rows ?? [];
  // Styled print view (LibreOffice -> PDF) is offered for real workbooks only.
  const printViewAvailable = !!info.path && (info.ext === "xlsx" || info.ext === "xls");

  const columnCount = Math.max(1, ...rows.map((row) => row.length));
  const headers = rows[0] ?? [];
  const bodyRows = rows.slice(1);
  const sortedRows = useMemo(() => {
    if (!sort) return bodyRows;
    return [...bodyRows].sort((a, b) => {
      const result = compareSheetCells(a[sort.column] ?? "", b[sort.column] ?? "");
      return sort.direction === "asc" ? result : -result;
    });
  }, [bodyRows, sort]);
  const visibleRows = sortedRows.slice(0, MAX_RENDERED_SHEET_ROWS);
  const rowCountLabel = `${bodyRows.length.toLocaleString()} rows`;
  const failed = status === "failed" || parseStatus === "failed";
  const loading = status === "loading" || parseStatus === "loading";

  return (
    <BinaryPreviewFrame info={info} type={type} sizeLabel={sizeLabel} downloadLabel={downloadLabel}>
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-ink/[0.06] bg-surface/90 px-4">
          <div className="flex min-w-0 items-center gap-2">
            <p className="shrink-0 truncate text-xs font-medium text-ink/62">{info.filename}</p>
            {sheets.length > 1 && viewMode === "grid" && (
              <div className="flex min-w-0 items-center gap-1 overflow-x-auto">
                {sheets.map((sheet, index) => (
                  <button
                    key={`${sheet.name}:${index}`}
                    type="button"
                    onClick={() => { setActiveSheet(index); setSort(null); }}
                    className={`shrink-0 rounded-md px-2 py-1 text-[11px] font-medium transition-colors ${
                      index === activeSheet
                        ? "bg-accent/15 text-accent"
                        : "text-ink/45 hover:bg-ink/[0.05] hover:text-ink/70"
                    }`}
                  >
                    {sheet.name}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {printViewAvailable && (
              <button
                type="button"
                onClick={() => setViewMode((mode) => (mode === "grid" ? "print" : "grid"))}
                className="rounded-md border border-ink/[0.08] px-2 py-1 text-[11px] font-medium text-ink/50 transition-colors hover:bg-ink/[0.05] hover:text-ink/75"
              >
                {viewMode === "grid" ? "Print view" : "Data view"}
              </button>
            )}
            {viewMode === "grid" && (
              <span className="rounded-md border border-ink/[0.08] bg-ink/[0.04] px-2 py-1 text-[11px] font-medium text-ink/50">
                {rowCountLabel}
              </span>
            )}
          </div>
        </div>
        {viewMode === "print" && info.path ? (
          <div className="min-h-0 flex-1 overflow-hidden">
            <PdfFileRenderer
              info={info}
              type={type}
              sizeLabel={sizeLabel}
              downloadLabel={downloadLabel}
              pdfUrl={officePdfUrl(info.path)}
              onLoadFailed={() => setViewMode("grid")}
            />
          </div>
        ) : (
        <div className="min-h-0 flex-1 overflow-auto p-4">
          {loading && <LoadingState label="Loading preview" />}
          {failed && rows.length === 0 && (
            <div className="flex h-full items-center justify-center px-6 text-center">
              <p className="max-w-[420px] text-sm text-ink/42">{error ?? parseError ?? "Sheet preview failed"}</p>
            </div>
          )}
          {!loading && rows.length === 0 && !failed && <EmptyState label="No sheet data" />}
          {rows.length > 0 && (
            <table className="min-w-full border-separate border-spacing-0 rounded-md border border-ink/[0.08] bg-surface text-left text-xs shadow-sm">
              <thead className="sticky top-0 z-10 bg-surface">
                <tr>
                  {Array.from({ length: columnCount }).map((_, index) => {
                    const active = sort?.column === index;
                    const Icon = active ? (sort.direction === "asc" ? ArrowUp : ArrowDown) : ArrowUpDown;
                    return (
                      <th key={index} className="border-b border-r border-ink/[0.08] px-0 py-0 last:border-r-0">
                        <button
                          type="button"
                          onClick={() => {
                            setSort((current) => current?.column === index
                              ? { column: index, direction: current.direction === "asc" ? "desc" : "asc" }
                              : { column: index, direction: "asc" });
                          }}
                          className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left font-medium text-ink/62 transition-colors hover:bg-ink/[0.04]"
                        >
                          <span className="max-w-[220px] truncate">{headers[index]?.trim() || `Column ${index + 1}`}</span>
                          <Icon size={13} className={active ? "text-accent" : "text-ink/30"} />
                        </button>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((row, rowIndex) => (
                  <tr key={rowIndex} className="odd:bg-ink/[0.018]">
                    {Array.from({ length: columnCount }).map((_, cellIndex) => (
                      <td key={cellIndex} className="max-w-[280px] border-b border-r border-ink/[0.06] px-3 py-2 text-ink/68 last:border-r-0">
                        <span className="block truncate">{row[cellIndex] ?? ""}</span>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        )}
      </div>
    </BinaryPreviewFrame>
  );
}

// ---------------------------------------------------------------------------
// File renderer (backend file_v1: binary previews, images, or download cards)
// ---------------------------------------------------------------------------

export function FileArtifactRenderer({ artifact }: { artifact: Artifact }) {
  const { locale, t } = useLocale();
  const info = useMemo(() => getFileArtifactInfo(artifact), [artifact]);
  const canPreview = Boolean(info?.previewable && info.previewUrl);
  const [previewState, setPreviewState] = useState<"loading" | "loaded" | "failed">(
    canPreview ? "loading" : "failed",
  );

  useEffect(() => {
    setPreviewState(canPreview ? "loading" : "failed");
  }, [canPreview, info?.previewUrl]);

  if (!info) return <EmptyState label={t("artifact.unsupportedType")} />;

  const type = resolveArtifactType(artifact);
  const sizeLabel = formatFileSize(info.size, locale);
  const downloadLabel = t("artifact.download");
  const previewUrl = info.previewUrl;

  if (info.downloadUrl && isPdfInfo(info)) {
    return <PdfFileRenderer info={info} type={type} sizeLabel={sizeLabel} downloadLabel={downloadLabel} />;
  }

  // Office documents use the local editor-grade viewer first, including
  // spreadsheets. Fallbacks remain format-specific and are labeled honestly.
  // Order matters: this must win over the docx/sheet branches.
  if (info.downloadUrl && info.path && isOfficeConvertInfo(info)) {
    return (
      <NativeOfficeRenderer info={info} type={type} sizeLabel={sizeLabel} downloadLabel={downloadLabel} />
    );
  }

  if (info.downloadUrl && isDocxInfo(info)) {
    return <DocxFileRenderer info={info} type={type} sizeLabel={sizeLabel} downloadLabel={downloadLabel} />;
  }

  if (info.downloadUrl && isSheetInfo(info)) {
    return <SheetFileRenderer info={info} type={type} sizeLabel={sizeLabel} downloadLabel={downloadLabel} />;
  }

  // Images render their own bytes directly (no macOS QuickLook previewUrl needed).
  if (info.downloadUrl && type === "image") {
    return <ImageFileRenderer info={info} type={type} sizeLabel={sizeLabel} downloadLabel={downloadLabel} />;
  }

  // Text/code/json/markdown/html: fetch and render the source client-side.
  if (info.downloadUrl && TEXT_PREVIEW_TYPES.has(type)) {
    return <TextFileRenderer info={info} type={type} sizeLabel={sizeLabel} downloadLabel={downloadLabel} />;
  }

  if (canPreview && previewUrl && previewState !== "failed") {
    return (
      <div className="flex h-full min-h-0 flex-col bg-black/10">
        <div className="min-h-0 flex-1 overflow-auto p-6">
          <div className="relative flex h-full min-h-[260px] items-center justify-center">
            {previewState === "loading" && (
              <div
                data-testid="file-artifact-preview-loading"
                className="absolute inset-0 z-10 flex items-center justify-center"
              >
                <div className="flex items-center gap-2 rounded-lg border border-ink/[0.06] bg-surface/90 px-3 py-2 text-xs text-ink/45 shadow-sm backdrop-blur">
                  <Loader2 size={14} className="animate-spin text-accent" />
                  <span>{t("artifact.preview.loading")}</span>
                </div>
              </div>
            )}
            <img
              data-testid="file-artifact-preview-image"
              src={previewUrl}
              alt={info.filename}
              onLoad={() => setPreviewState("loaded")}
              onError={() => setPreviewState("failed")}
              className={cn(
                "max-h-full max-w-full rounded-lg border border-ink/[0.08] bg-white object-contain shadow-xl transition-opacity duration-150",
                previewState === "loading" ? "opacity-0" : "opacity-100",
              )}
            />
          </div>
        </div>
        <FileArtifactFooter info={info} type={type} sizeLabel={sizeLabel} downloadLabel={downloadLabel} />
      </div>
    );
  }

  return (
    <FileArtifactFallbackCard
      info={info}
      type={type}
      sizeLabel={sizeLabel}
      downloadLabel={downloadLabel}
    />
  );
}

function FileArtifactFallbackCard({
  info,
  type,
  sizeLabel,
  downloadLabel,
}: {
  info: FileArtifactInfo;
  type: string;
  sizeLabel: string;
  downloadLabel: string;
}) {
  return (
    <div className="flex h-full items-center justify-center overflow-auto p-6">
      <div
        data-testid="file-artifact-card"
        className="flex w-full max-w-[360px] flex-col items-center rounded-lg border border-ink/[0.08] bg-ink/[0.03] px-6 py-7 text-center shadow-sm"
      >
        <TypeIcon type={type} size={64} />
        <p className="mt-4 w-full truncate text-[15px] font-medium text-ink/86">{info.filename}</p>
        <div className="mt-2 flex max-w-full flex-wrap items-center justify-center gap-2 text-[11px] text-ink/40">
          {sizeLabel && <span>{sizeLabel}</span>}
          {info.ext && (
            <span className="rounded-md border border-ink/[0.08] bg-ink/[0.04] px-1.5 py-0.5 font-medium uppercase tracking-wide text-ink/46">
              {info.ext}
            </span>
          )}
        </div>
        {info.previewMessage && (
          <p className="mt-3 text-xs leading-5 text-ink/45">{info.previewMessage}</p>
        )}
        {info.downloadUrl && (
          <a
            data-testid="file-artifact-download"
            href={info.downloadUrl}
            download={info.filename}
            className="mt-5 inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-accent/90"
          >
            <Download size={15} />
            <span>{downloadLabel}</span>
          </a>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Code renderer (Sandpack: html / svg / react / vanilla-js)
// ---------------------------------------------------------------------------

const moziDarkTheme: SandpackTheme = {
  colors: {
    surface1: "#0a0a0f",
    surface2: "#13131d",
    surface3: "#1a1a25",
    clickable: "#e4e4e7",
    base: "#e4e4e7",
    disabled: "#52525b",
    hover: "#f4f4f5",
    accent: "#6366f1",
    error: "#ef4444",
    errorSurface: "#1c1917",
  },
  syntax: {
    plain: "#e4e4e7",
    comment: { color: "#52525b", fontStyle: "italic" },
    keyword: "#c084fc",
    tag: "#60a5fa",
    punctuation: "#a1a1aa",
    definition: "#67e8f9",
    property: "#fbbf24",
    static: "#fb923c",
    string: "#4ade80",
  },
  font: {
    body: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    mono: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
    size: "13px",
    lineHeight: "20px",
  },
};

function detectContentType(code: string): ContentType {
  const t = code.trim();
  if (/^(<\?xml[^>]*\?>\s*)?<svg[\s>]/i.test(t)) return "svg";
  if (/\bimport\s+.*from\s+['"]react['"]/i.test(t) || /\buseState\b|\buseEffect\b/.test(t) || /\bexport\s+default\s+function\b/.test(t)) return "react";
  if (/^<!doctype\s+html/i.test(t) || /<html[\s>]/i.test(t) || /<body[\s>]/i.test(t)) return "html";
  if (/<[a-z][\s\S]*>/i.test(t) && !t.includes("import ")) return "html";
  return "vanilla-js";
}

function buildConfig(code: string, ct: ContentType): { template: SandpackPredefinedTemplate; files: SandpackFiles } {
  switch (ct) {
    case "svg": {
      const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{margin:0;display:flex;justify-content:center;align-items:center;min-height:100vh;background:#0a0a0f}svg{max-width:100%;height:auto}</style></head><body>${code}</body></html>`;
      return { template: "static", files: { "/index.html": { code: html, active: true } } };
    }
    case "html": {
      let html = code;
      if (!/<html[\s>]/i.test(code)) html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>${code}</body></html>`;
      return { template: "static", files: { "/index.html": { code: html, active: true } } };
    }
    case "react":
      return { template: "react-ts", files: { "/App.tsx": { code, active: true } } };
    default: {
      const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><div id="app"></div><script src="./index.js"></script></body></html>`;
      return { template: "vanilla", files: { "/index.html": { code: html }, "/index.js": { code, active: true } } };
    }
  }
}

function normalizeStaticHtml(code: string, ct: ContentType): string {
  if (ct === "svg") {
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>html,body{margin:0;min-height:100%;background:#0a0a0f}body{display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box}svg{max-width:100%;height:auto}</style></head><body>${code}</body></html>`;
  }
  if (/<html[\s>]/i.test(code)) return code;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>${code}</body></html>`;
}

export function extractCode(artifact: Artifact): string | null {
  const d = artifact.data;
  for (const key of ["code", "content", "html", "svg", "source"]) {
    if (typeof d[key] === "string" && (d[key] as string).trim()) return d[key] as string;
  }
  if (artifactContentLooksLikeStandaloneHtml(artifact) && typeof d.markdown === "string") return d.markdown;
  return null;
}

export interface ArtifactDownload {
  filename: string;
  /** For text artifacts: raw text + mime. For images: a URL/data-URI to fetch. */
  text?: string;
  mime?: string;
  url?: string;
  direct?: boolean;
}

function slugifyTitle(title: string): string {
  const base = (title || "artifact").trim().replace(/[\s/\\:*?"<>|]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return base || "artifact";
}

export function isDocumentArtifact(artifact: Artifact): boolean {
  return resolveArtifactKind(artifact) === "document" && !!extractDocument(artifact);
}

/**
 * Render a document artifact's markdown to a standalone, print-ready HTML string
 * (reuses the same remark-gfm pipeline as the on-screen renderer, wrapped in
 * clean print typography). Used to export a real PDF via the browser's native
 * print-to-PDF — vector text, no extra dependency. Returns null if not a document.
 */
export function renderArtifactPrintHtml(artifact: Artifact): string | null {
  const md = extractDocument(artifact);
  if (!md) return null;
  const body = renderToStaticMarkup(
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>
      {normalizeMarkdownTables(md)}
    </ReactMarkdown>,
  );
  const title = (artifact.title || "Document").replace(/[<>&]/g, "");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>
    @page { margin: 20mm; }
    * { box-sizing: border-box; }
    body { font-family: -apple-system, "Segoe UI", "PingFang SC", "Noto Sans CJK SC", sans-serif; color: #1a1a1a; line-height: 1.65; max-width: 780px; margin: 0 auto; padding: 24px; }
    h1 { font-size: 1.7rem; margin: 1.4em 0 .5em; } h2 { font-size: 1.35rem; margin: 1.3em 0 .5em; } h3 { font-size: 1.12rem; margin: 1.2em 0 .4em; }
    p, li { font-size: .98rem; } ul, ol { padding-left: 1.4em; }
    a { color: #1a56db; text-decoration: underline; }
    pre { background: #f5f5f7; border: 1px solid #e3e3e6; border-radius: 8px; padding: 14px; overflow: auto; font-size: .85rem; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .88em; }
    :not(pre) > code { background: #f0f0f2; padding: 1px 5px; border-radius: 4px; }
    blockquote { border-left: 3px solid #cbd5e1; padding-left: 14px; color: #475569; margin-left: 0; }
    table { border-collapse: collapse; width: 100%; margin: 1em 0; font-size: .9rem; }
    th, td { border: 1px solid #d5d5da; padding: 7px 11px; text-align: left; }
    th { background: #f5f5f7; font-weight: 600; }
    img { max-width: 100%; } hr { border: none; border-top: 1px solid #e3e3e6; }
  </style></head><body>${body}</body></html>`;
}

/**
 * Describe how to save an artifact to disk in its native format:
 * markdown → .md, html → .html, svg → .svg, react → .tsx, js → .js, image → its
 * source URL. Returns null when there is nothing downloadable yet.
 */
export function getArtifactDownload(artifact: Artifact): ArtifactDownload | null {
  const kind = resolveArtifactKind(artifact);
  const slug = slugifyTitle(artifact.title);

  if (kind === "file") {
    const info = getFileArtifactInfo(artifact);
    return info?.downloadUrl ? { filename: info.filename, url: info.downloadUrl, direct: true } : null;
  }

  if (kind === "image") {
    const src = extractImageSrc(artifact);
    return src ? { filename: slug, url: src } : null;
  }

  if (kind === "document") {
    const md = extractDocument(artifact);
    return md ? { filename: `${slug}.md`, text: md, mime: "text/markdown" } : null;
  }

  const code = extractCode(artifact);
  if (!code) return null;
  const ct = String(artifact.data.content_type ?? "").toLowerCase() || detectContentType(code);
  const ext = ct === "svg" ? "svg" : ct === "react" ? "tsx" : ct === "javascript" || ct === "vanilla-js" ? "js" : "html";
  const mime = ext === "svg" ? "image/svg+xml" : ext === "html" ? "text/html" : "text/plain";
  return { filename: `${slug}.${ext}`, text: code, mime };
}

export function CodeRenderer({ artifact, showCode }: { artifact: Artifact; showCode: boolean }) {
  const code = useMemo(() => extractCode(artifact), [artifact.data]);
  const isLiveWriting = artifact.status === "running" && artifact.data.live_preview === true;
  const contentType = useMemo(() => {
    const explicit = artifact.data.content_type as string | undefined;
    if (explicit === "html" || explicit === "svg" || explicit === "react") return explicit as ContentType;
    if (explicit === "javascript") return "vanilla-js" as ContentType;
    return code ? detectContentType(code) : ("html" as ContentType);
  }, [code, artifact.data.content_type]);
  const staticHtml = useMemo(
    () => (code && (contentType === "html" || contentType === "svg") ? normalizeStaticHtml(code, contentType) : null),
    [code, contentType],
  );
  const config = useMemo(() => (code ? buildConfig(code, contentType) : null), [code, contentType]);

  if (!code) {
    return artifact.status === "running"
      ? <LiveWorkingState artifact={artifact} />
      : <EmptyState label="No content to preview" />;
  }

  // While the model is still writing, default to a calm "generating" state —
  // a user who asked for a deck should NOT be shown raw CSS/HTML streaming.
  // Raw code is opt-in via the </> toggle (showCode); the rendered preview
  // takes over on completion. (Half-written markup can't be safely iframed.)
  if (isLiveWriting) {
    return showCode ? <LiveCodeStream code={code} /> : <LiveWorkingState artifact={artifact} />;
  }

  if (staticHtml) {
    return (
      <div className="flex h-full min-h-0 bg-black">
        {showCode && (
          <div className="h-full w-[42%] min-w-[320px] overflow-auto border-r border-sheet/[0.06] bg-[#0a0a0f]">
            <pre className="m-0 whitespace-pre-wrap break-words p-4 font-mono text-[12px] leading-5 text-sheet/70">{code}</pre>
          </div>
        )}
        <iframe
          title={artifact.title}
          srcDoc={staticHtml}
          sandbox="allow-scripts allow-forms allow-modals allow-popups allow-pointer-lock allow-downloads"
          className="h-full min-w-0 flex-1 border-0 bg-white"
        />
      </div>
    );
  }

  if (!config) return <EmptyState label="No content to preview" />;

  return (
    <SandpackProvider
      template={config.template}
      files={config.files}
      theme={moziDarkTheme}
      options={{ initMode: "immediate" }}
      style={{ height: "100%" }}
    >
      <SandpackLayout style={{ border: "none", borderRadius: 0, height: "100%", minHeight: 0 }}>
        {showCode && <SandpackCodeEditor showLineNumbers showTabs={false} style={{ height: "100%" }} />}
        <SandpackPreview showNavigator={false} showOpenInCodeSandbox={false} showRefreshButton style={{ height: "100%" }} />
      </SandpackLayout>
    </SandpackProvider>
  );
}

// ---------------------------------------------------------------------------

export function EmptyState({ label }: { label: string }) {
  return (
    <div className="flex h-full items-center justify-center">
      <p className="text-sm text-ink/30">{label}</p>
    </div>
  );
}

export function LoadingState({ label }: { label: string }) {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="flex items-center gap-2 text-sm text-ink/40">
        <Loader2 size={15} className="animate-spin text-accent" />
        <span>{label}</span>
      </div>
    </div>
  );
}

/**
 * Streaming code view for an artifact that is still being written. Follows the
 * tail (auto-scroll) unless the user scrolls up to inspect earlier output.
 */
export function LiveCodeStream({ code }: { code: string }) {
  const { locale, t } = useLocale();
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedToBottom = useRef(true);
  const [expanded, setExpanded] = useState(true);
  const lineCount = useMemo(() => code ? code.split(/\r\n|\r|\n/).length : 0, [code]);
  const tailCode = useMemo(() => {
    const lines = code.split(/\r\n|\r|\n/);
    const lineTail = lines.length > LIVE_CODE_TAIL_LINES
      ? lines.slice(-LIVE_CODE_TAIL_LINES).join("\n")
      : code;
    return lineTail.length > LIVE_CODE_TAIL_CHARS ? lineTail.slice(-LIVE_CODE_TAIL_CHARS) : lineTail;
  }, [code]);
  const displayCode = expanded ? code : tailCode;
  const formattedChars = code.length.toLocaleString(locale);
  const formattedLines = lineCount.toLocaleString(locale);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && pinnedToBottom.current) el.scrollTop = el.scrollHeight;
  }, [displayCode]);

  useEffect(() => {
    pinnedToBottom.current = true;
  }, [expanded]);

  return (
    <div data-testid="artifact-live-code" className="flex h-full min-h-0 flex-col bg-base p-3">
      <div
        data-testid="artifact-live-code-window"
        className={cn(
          "flex min-h-0 flex-col overflow-hidden rounded-lg border border-ink/[0.06] bg-[#0a0a0f]",
          expanded ? "h-full" : "max-h-[180px]",
        )}
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-sheet/[0.05] px-3 py-2 text-[11.5px] text-sheet/45">
          <Loader2 size={12} className="animate-spin text-accent" />
          <span>{t("artifact.live.writing")}</span>
          <span data-testid="artifact-live-code-counts" className="min-w-0 truncate font-mono text-[10px] text-sheet/30">
            {t("artifact.live.progress", { chars: formattedChars, lines: formattedLines })}
          </span>
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
            className="ml-auto shrink-0 rounded px-1.5 py-0.5 text-[10.5px] text-accent/70 transition-colors hover:bg-accent/10 hover:text-accent"
          >
            {expanded ? t("artifact.live.collapse") : t("artifact.live.expand")}
          </button>
        </div>
        <div className="h-px shrink-0 overflow-hidden bg-sheet/[0.04]">
          <div className="live-progress-indicator h-full w-1/3 bg-accent/70" />
        </div>
        <div
          ref={scrollRef}
          onScroll={(event) => {
            const el = event.currentTarget;
            pinnedToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          }}
          className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden"
        >
          <pre className="m-0 whitespace-pre-wrap break-words p-3 font-mono text-[12px] leading-5 text-sheet/60">
            {displayCode}
            <span className="ml-0.5 inline-block h-3.5 w-1.5 translate-y-0.5 animate-pulse rounded-[1px] bg-accent/80" />
          </pre>
        </div>
      </div>
    </div>
  );
}

export function LiveWorkingState({ artifact }: { artifact: Artifact }) {
  const { t } = useLocale();
  const phase = typeof artifact.data.phase === "string" ? artifact.data.phase : "preparing";
  const label = artifact.fallback_text || (phase === "writing" ? t("artifact.live.writing") : t("artifact.live.preparing"));
  return (
    <div className="flex h-full items-center justify-center px-8">
      <div className="w-full max-w-[520px]">
        <div className="mb-4 flex items-center gap-2 text-sm text-ink/54">
          <Loader2 size={15} className="animate-spin text-accent" />
          <span>{label}</span>
        </div>
        <div className="h-1 overflow-hidden rounded-full bg-ink/[0.07]">
          <div className="live-progress-indicator h-full w-1/3 rounded-full bg-accent/75" />
        </div>
        <p className="mt-3 text-xs text-ink/28">
          {t("artifact.live.waitingForOutput")}
        </p>
      </div>
    </div>
  );
}
