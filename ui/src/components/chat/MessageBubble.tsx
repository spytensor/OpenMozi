import { memo, useState } from "react";
import { AlertCircle, Check, Copy, RefreshCw, Settings2, Trash2 } from "lucide-react";
import { TypeIcon } from "./artifact-type-icons";
import { buildFileArtifact } from "@/lib/file-artifact";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Artifact, ChatMessage } from "@/types";
import MoziAvatar from "@/components/MoziAvatar";
import { useLocale } from "@/i18n";
import { MARKDOWN_COMPONENTS } from "./markdown-link";
import { normalizeMarkdownTables } from "./markdown-normalize";

interface MessageBubbleProps {
  message: ChatMessage;
  /** Re-run an existing prompt as a fresh turn without creating a new user bubble. */
  onRegenerate?: (content: string) => void;
  /**
   * The prompt to re-run when regenerating an assistant answer — the user
   * message that produced it. Ignored for user messages (they regenerate
   * themselves). Absent when there is no preceding prompt to re-run.
   */
  regenerateText?: string;
  showAvatar?: boolean;
  showAssistantActions?: boolean;
  onDelete?: (message: ChatMessage) => void;
  /** Open an attachment in the shared artifact panel (same renderers as agent artifacts). */
  onOpenArtifact?: (artifact: Artifact) => void;
  /** Open the model settings recovery path for deterministic provider failures. */
  onOpenModelSettings?: () => void;
}

const CHAT_PROSE_CLASS =
  "text-sm leading-relaxed prose prose-invert prose-sm max-w-none " +
  "[&_pre]:bg-[var(--code-bg)] [&_pre]:border [&_pre]:border-ink/[0.06] [&_pre]:rounded-lg [&_pre]:p-3.5 [&_pre]:overflow-x-auto [&_pre]:text-xs [&_pre]:font-mono " +
  "[&_code]:text-accent-light [&_code]:text-xs [&_code]:font-mono " +
  "[&_p]:my-[0.6em] [&_p:first-child]:mt-0 [&_p:last-child]:mb-0 [&_ul]:my-[0.6em] [&_ol]:my-[0.6em] [&_ul]:pl-[1.35em] [&_ol]:pl-[1.35em] [&_li]:my-[0.25em] [&_li>p]:my-[0.3em] [&_li>ul]:my-[0.35em] [&_li>ol]:my-[0.35em] " +
  "[&_a]:text-accent [&_a]:underline [&_a]:underline-offset-2 " +
  "[&_h1]:text-[17px] [&_h1]:font-semibold [&_h1]:leading-[1.35] [&_h1]:mt-[1.5em] [&_h1]:mb-[0.5em] [&_h1:first-child]:mt-0 " +
  "[&_h2]:text-[15.5px] [&_h2]:font-semibold [&_h2]:leading-[1.38] [&_h2]:mt-[1.5em] [&_h2]:mb-[0.5em] [&_h2:first-child]:mt-0 " +
  "[&_h3]:text-[14px] [&_h3]:font-semibold [&_h3]:leading-[1.45] [&_h3]:mt-[1.5em] [&_h3]:mb-[0.5em] [&_h3:first-child]:mt-0 " +
  "[&_h4]:text-[13.5px] [&_h4]:font-medium [&_h4]:leading-[1.45] [&_h4]:mt-[1.5em] [&_h4]:mb-[0.5em] [&_h4:first-child]:mt-0 " +
  "[&_blockquote]:border-l-2 [&_blockquote]:border-accent/30 [&_blockquote]:pl-3 [&_blockquote]:text-ink/50 " +
  "[&_hr]:my-5 [&_hr]:border-0 [&_hr]:border-t [&_hr]:border-ink/10 " +
  "[&_table]:my-3 [&_table]:block [&_table]:w-fit [&_table]:max-w-full [&_table]:overflow-x-auto [&_table]:border-separate [&_table]:border-spacing-0 [&_table]:rounded-lg [&_table]:border [&_table]:border-ink/10 [&_table]:text-xs " +
  "[&_thead]:bg-ink/[0.04] [&_th]:whitespace-nowrap [&_th]:border-b [&_th]:border-ink/10 [&_th]:px-3 [&_th]:py-1.5 [&_th]:text-left [&_th]:font-medium [&_th]:text-ink/60 " +
  "[&_td]:border-b [&_td]:border-ink/[0.05] [&_td]:px-3 [&_td]:py-1.5 [&_td]:text-ink/70 [&_tr:last-child_td]:border-b-0";

export type ChatErrorKind = "authentication" | "quota" | "request";

export function normalizeChatError(content: string): { kind: ChatErrorKind; detail: string } | null {
  const text = content.trim();
  const lower = text.toLowerCase();
  if (!lower.startsWith("request failed") && !lower.startsWith("error:")) return null;
  if (lower.includes("invalid api key") || lower.includes("authentication_error") || lower.includes("provider api key is invalid")) {
    return { kind: "authentication", detail: "" };
  }
  if (lower.includes("quota") || lower.includes("rate_limit_error") || lower.includes("token plan") || lower.includes("用量上限") || lower.includes("2056")) {
    return { kind: "quota", detail: "" };
  }
  const detail = text
    .replace(/^request failed:\s*/i, "")
    .replace(/\s*\{\s*"type"[\s\S]*$/i, "")
    .trim();
  return { kind: "request", detail };
}

function MessageAction({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="flex h-6 w-6 items-center justify-center rounded-md text-ink/35 transition-colors hover:bg-ink/[0.06] hover:text-ink/70"
    >
      {children}
    </button>
  );
}

/**
 * Render markdown to a standalone HTML string for the clipboard's text/html
 * flavor. react-dom/server is imported dynamically so it stays out of the entry
 * chunk (it only loads when someone actually copies a rich message).
 */
async function markdownToHtml(text: string): Promise<string> {
  try {
    const { renderToStaticMarkup } = await import("react-dom/server");
    return renderToStaticMarkup(<ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>);
  } catch {
    return "";
  }
}

/**
 * Copy `text` to the clipboard, resilient across contexts (the previous
 * `navigator.clipboard?.writeText` silently no-op'd whenever the async Clipboard
 * API was unavailable — the button looked dead). When `html` is provided it is
 * written as the text/html flavor alongside the plain text, so a rich paste
 * target (docs, email) renders the formatting while a plain target still gets
 * the raw markdown. Returns whether the copy succeeded.
 */
async function copyToClipboard(text: string, html: string): Promise<boolean> {
  try {
    if (html && navigator.clipboard && typeof ClipboardItem !== "undefined") {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/plain": new Blob([text], { type: "text/plain" }),
          "text/html": new Blob([html], { type: "text/html" }),
        }),
      ]);
      return true;
    }
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the legacy execCommand path below.
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none;";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/** Copy button with a transient checkmark so the click has visible feedback. */
function CopyAction({ text, rich = false }: { text: string; rich?: boolean }) {
  const { t } = useLocale();
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void (async () => {
      const html = rich ? await markdownToHtml(text) : "";
      if (!(await copyToClipboard(text, html))) return;
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    })();
  };
  return (
    <MessageAction label={copied ? t("chat.copied") : t("chat.copy")} onClick={copy}>
      {copied ? <Check size={13} className="text-success/80" /> : <Copy size={13} />}
    </MessageAction>
  );
}

/**
 * Legacy turns baked the Web-UI workspace scope into the persisted user message.
 * It is turn context, not user content — strip it so it never shows in the bubble.
 * (New turns inject it into the system prompt instead.)
 */
export function stripInjectedContext(text: string): string {
  return text
    .replace(/(^|\n)Workspace Context \(selected in Web UI\):(?:\n-[^\n]*)*\n?/g, "$1")
    .replace(/^\n+/, "")
    .trim();
}

type MarkdownSegment = {
  text: string;
  fenced: boolean;
};

function getFenceMarker(line: string): string | null {
  return line.match(/^ {0,3}(`{3,}|~{3,})/)?.[1] ?? null;
}

/**
 * DeepSeek can emit prose with long blank-line runs. Collapse those for markdown
 * rendering without touching fenced code, where blank lines are meaningful.
 */
export function normalizeAssistantMarkdown(text: string): string {
  const source = text.replace(/\r\n?/g, "\n").trim();
  if (!source) return "";

  const segments: MarkdownSegment[] = [];
  let buffer = "";
  let inFence = false;
  let fenceChar = "";
  let fenceLength = 0;

  for (const match of source.matchAll(/[^\n]*(?:\n|$)/g)) {
    const lineWithBreak = match[0];
    if (!lineWithBreak) continue;
    const hasBreak = lineWithBreak.endsWith("\n");
    const line = hasBreak ? lineWithBreak.slice(0, -1) : lineWithBreak;
    const marker = getFenceMarker(line);

    if (!inFence && marker) {
      if (buffer) segments.push({ text: buffer, fenced: false });
      buffer = lineWithBreak;
      inFence = true;
      fenceChar = marker[0];
      fenceLength = marker.length;
      continue;
    }

    if (inFence) {
      const closesFence = Boolean(marker && marker[0] === fenceChar && marker.length >= fenceLength);
      if (closesFence && hasBreak) {
        buffer += line;
        segments.push({ text: buffer, fenced: true });
        buffer = "\n";
        inFence = false;
        fenceChar = "";
        fenceLength = 0;
        continue;
      }

      buffer += lineWithBreak;
      if (closesFence) {
        segments.push({ text: buffer, fenced: true });
        buffer = "";
        inFence = false;
        fenceChar = "";
        fenceLength = 0;
      }
      continue;
    }

    buffer += lineWithBreak;
  }

  if (buffer) segments.push({ text: buffer, fenced: inFence });

  return segments
    .map((segment) => (segment.fenced ? segment.text : segment.text.replace(/\n{3,}/g, "\n\n")))
    .join("")
    .trim();
}

export function hasRenderableAssistantContent(message: ChatMessage): boolean {
  return normalizeAssistantMarkdown(message.content).length > 0;
}

/**
 * Memoized so a streaming turn only re-parses the markdown of the bubble whose
 * content actually changed. useChat rebuilds the timeline array on every chunk but
 * keeps unchanged items by reference, so shallow prop compare skips their re-render.
 */
/** Muted markdown prose for interim narration rendered inside a collapsed turn fold. */
export function AssistantNarration({ message }: { message: ChatMessage }) {
  const content = normalizeAssistantMarkdown(message.content);
  if (!content.trim()) return null;
  return (
    <div data-testid="turn-fold-narration" className={`${CHAT_PROSE_CLASS} text-ink/60`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>
        {normalizeMarkdownTables(content)}
      </ReactMarkdown>
    </div>
  );
}

export default memo(function MessageBubble({
  message,
  onRegenerate,
  regenerateText,
  showAvatar = true,
  showAssistantActions = true,
  onDelete,
  onOpenArtifact,
  onOpenModelSettings,
}: MessageBubbleProps) {
  const { t } = useLocale();
  const { role, streaming } = message;
  const content = role === "user" ? stripInjectedContext(message.content) : normalizeAssistantMarkdown(message.content);
  const chatError = role === "assistant" ? normalizeChatError(content) : null;
  const showStreamingPlaceholder = role === "assistant" && Boolean(streaming && message.requestId);
  const assistantContentClass = showAssistantActions ? CHAT_PROSE_CLASS : `${CHAT_PROSE_CLASS} text-ink/70`;

  if (role === "system") {
    if (!content) return null;
    return (
      <div data-testid="message-system" className="text-center py-2">
        <div className="inline-block bg-ink/[0.03] border border-ink/[0.05] rounded-full px-4 py-1">
          <span className="text-xs text-ink/35">{content}</span>
        </div>
      </div>
    );
  }

  if (role === "user") {
    const attachments = message.attachments ?? [];
    return (
      <div data-testid="message-user" className="group flex flex-col items-end min-w-0">
        {content && (
        <div data-testid="message-user-bubble" className="bg-accent/15 border border-accent/15 rounded-2xl rounded-br-md px-4 py-2.5 max-w-[75%] shadow-sm overflow-hidden">
          <p className="text-sm whitespace-pre-wrap break-words leading-relaxed overflow-wrap-anywhere">{content}</p>
        </div>
        )}
        {attachments.length > 0 && (
          // Attachment chips sit BELOW the user's text (docs/DESIGN.md). Same chip
          // recipe as the composer pending chip: token neutral surface, 1px
          // hairline, 6px radius, format-specific icon — identical before/after send.
          <div data-testid="message-user-attachments" className={`flex flex-col items-end gap-1 ${content ? "mt-1.5" : ""}`}>
            {attachments.map((att) => {
              const canOpen = Boolean(att.path && onOpenArtifact);
              return (
                <button
                  type="button"
                  key={att.path || att.filename}
                  disabled={!canOpen}
                  onClick={canOpen
                    ? () => onOpenArtifact!(buildFileArtifact({ path: att.path, filename: att.filename, mime: att.mimeType, size: att.size }))
                    : undefined}
                  title={canOpen ? t("chat.attachment.open", { name: att.filename }) : att.filename}
                  className={`flex max-w-[75%] items-center gap-2 rounded-lg border px-2 py-1.5 text-left transition-colors ${canOpen ? "cursor-pointer hover:border-accent/40 hover:bg-elevated/70" : ""}`}
                  style={{
                    borderColor: "var(--border-medium)",
                    background: "var(--surface-input)",
                    color: "var(--text-secondary)",
                  }}
                >
                  <TypeIcon type={(att.filename || "").split(".").pop() || "file"} size={28} />
                  <span className="truncate text-[12px]">{att.filename}</span>
                </button>
              );
            })}
          </div>
        )}
        <div className="mt-1 flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          <CopyAction text={content} />
          {onRegenerate && (
            <MessageAction label={t("chat.regenerate")} onClick={() => onRegenerate(content)}>
              <RefreshCw size={13} />
            </MessageAction>
          )}
          {onDelete && (
            <MessageAction label={t("chat.delete")} onClick={() => onDelete(message)}>
              <Trash2 size={13} />
            </MessageAction>
          )}
        </div>
      </div>
    );
  }

  if (!content && !showStreamingPlaceholder) return null;

  // Assistant — MOZI avatar beside the content, aligned to the first text line
  return (
    <div data-testid="message-assistant" className="group flex w-full max-w-[980px] items-start gap-3 py-1.5">
      {showAvatar ? (
        <MoziAvatar className="mt-0.5" />
      ) : (
        <div aria-hidden="true" className="mt-0.5 h-[26px] w-[26px] shrink-0" />
      )}
      <div className="min-w-0 flex-1">
      {chatError ? (
        <div data-testid="message-error" className="max-w-[760px] rounded-md border border-danger/25 bg-danger/[0.06] px-3 py-2.5 text-sm text-ink/75">
          <div className="flex items-start gap-2">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
            <div className="min-w-0 flex-1">
              <p className="font-medium text-ink/85">{t(`chat.error.${chatError.kind}.title`)}</p>
              <p className="mt-0.5 leading-relaxed text-ink/58">
                {chatError.detail || t(`chat.error.${chatError.kind}.description`)}
              </p>
              {chatError.kind === "request" && onRegenerate && regenerateText && (
                <button
                  type="button"
                  onClick={() => onRegenerate(regenerateText)}
                  className="mt-2 inline-flex items-center gap-1.5 text-xs font-medium text-accent hover:text-accent-light"
                >
                  <RefreshCw size={12} />
                  {t("common.retry")}
                </button>
              )}
              {chatError.kind !== "request" && onOpenModelSettings && (
                <button
                  type="button"
                  onClick={onOpenModelSettings}
                  className="mt-2 inline-flex items-center gap-1.5 text-xs font-medium text-accent hover:text-accent-light"
                >
                  <Settings2 size={12} />
                  {t("chat.error.openModelSettings")}
                </button>
              )}
              {onDelete && (
                <button
                  type="button"
                  onClick={() => onDelete(message)}
                  className="mt-2 block text-xs font-medium text-ink/50 hover:text-danger"
                >
                  {t("chat.delete")}
                </button>
              )}
            </div>
          </div>
        </div>
      ) : content ? (
        <div data-testid="message-assistant-content" className={assistantContentClass}>
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>
            {normalizeMarkdownTables(content)}
          </ReactMarkdown>
        </div>
      ) : streaming ? (
        <div className="flex items-center gap-1 py-1">
          <span className="w-1.5 h-1.5 rounded-full bg-accent typing-dot" />
          <span className="w-1.5 h-1.5 rounded-full bg-accent typing-dot" />
          <span className="w-1.5 h-1.5 rounded-full bg-accent typing-dot" />
        </div>
      ) : null}
      {content && !chatError && !streaming && showAssistantActions && (
        <div className="mt-1 flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          <CopyAction text={content} rich />
          {onRegenerate && regenerateText && (
            <MessageAction label={t("chat.regenerate")} onClick={() => onRegenerate(regenerateText)}>
              <RefreshCw size={13} />
            </MessageAction>
          )}
          {onDelete && (
            <MessageAction label={t("chat.delete")} onClick={() => onDelete(message)}>
              <Trash2 size={13} />
            </MessageAction>
          )}
        </div>
      )}
      </div>
    </div>
  );
});
