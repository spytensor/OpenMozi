import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUpDown,
  Download,
  Eye,
  Folder,
  FolderOpen,
  FolderUp,
  Loader2,
  MessageSquarePlus,
  Paperclip,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import type { ChangeEvent, DragEvent, ReactNode } from "react";
import WorkspacePage from "@/components/layout/WorkspacePage";
import { TypeIcon } from "@/components/chat/artifact-type-icons";
import { buildFileArtifact, fileDownloadUrl } from "@/lib/file-artifact";
import { runtimeBrowsableProjectRoots, runtimeRootLabel } from "@/lib/runtime-display";
import { useApi } from "@/hooks/useApi";
import { useLocale } from "@/i18n";
import type { Artifact } from "@/types";
import type { RuntimeWorkspaceRoot } from "@/types/runtime";

interface FsEntry {
  name: string;
  displayName?: string;
  path: string;
  isDir: boolean;
  size?: number;
  created?: number;
  mtime: number;
  mime?: string;
  artifactKind?: "deck" | "document" | "sheet" | "image" | "archive" | "code" | "other" | null;
}

interface FsListResponse {
  dir: string;
  root: string;
  entries: FsEntry[];
}

type FilesSortMode = "name" | "size" | "newest";

export function isLocalFilesOrigin(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1";
}

export interface FilesStartChatPayload {
  folderPath: string;
  label: string;
  attachPath?: string;
  attachFilename?: string;
}

export type FilesStartChatOptions = FilesStartChatPayload;
export interface FilesAttachToChatOptions {
  path: string;
  filename: string;
}

interface FilesViewProps {
  onOpenArtifact?: (artifact: Artifact) => void;
  onStartChat?: (payload: FilesStartChatOptions) => void;
  onAttachToChat?: (payload: FilesAttachToChatOptions) => void;
  onOpenSession?: (sessionId: string) => void;
  /** Runtime workspace roots — the SAME projects the composer and sidebar use. */
  roots?: RuntimeWorkspaceRoot[];
}

interface FileSource {
  sessionId: string;
  sessionTitle: string;
  timestamp: number;
}

type Dialog =
  | { kind: "add" }
  | { kind: "rename"; entry: FsEntry }
  | { kind: "delete"; entries: FsEntry[] }
  | { kind: "move"; entries: FsEntry[] };

function formatSize(bytes?: number): string {
  if (bytes === undefined) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatTime(ms: number): string {
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return "";
  }
}

function entryLabel(entry: FsEntry): string {
  return entry.displayName || entry.name;
}

function parentDir(path: string): string {
  return path.replace(/[\\/][^\\/]+[\\/]?$/, "");
}

function pathLeaf(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function relativeDisplayPath(path: string, root: string | null, dir: string | null): string {
  const base = [root, dir].find((candidate) => candidate && (path === candidate || path.startsWith(`${candidate}/`) || path.startsWith(`${candidate}\\`)));
  return base ? path.slice(base.length).replace(/^[\\/]/, "") || pathLeaf(path) : pathLeaf(path);
}

/** A human name for a workspace dir — the workspace root shows as its label,
 *  not the raw user-id folder. */
function friendlyDirName(path: string, root: string, rootLabel: string): string {
  return path === root ? rootLabel : pathLeaf(path);
}

export default function FilesView({
  onOpenArtifact,
  onStartChat,
  onAttachToChat,
  onOpenSession,
  roots = [],
}: FilesViewProps) {
  const { get, post, del } = useApi();
  const { t, locale } = useLocale();
  const [root, setRoot] = useState<string | null>(null);
  const [dir, setDir] = useState<string | null>(null);
  const [entries, setEntries] = useState<FsEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [search, setSearch] = useState("");
  const [sortMode, setSortMode] = useState<FilesSortMode>("newest");
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [locationVisible, setLocationVisible] = useState(false);
  const [previewedFile, setPreviewedFile] = useState<FsEntry | null>(null);
  const [fileSource, setFileSource] = useState<FileSource | null>(null);
  const [workingFilesExpanded, setWorkingFilesExpanded] = useState(false);
  const localOrigin = typeof window !== "undefined" && isLocalFilesOrigin(window.location.hostname);
  const revealLabel = typeof navigator !== "undefined" && /Mac/i.test(navigator.userAgent)
    ? t("files.revealFinder")
    : t("files.showInFolder");

  /** The per-user workspace root captured from the first listing. */
  const workspaceRootRef = useRef<string | null>(null);

  const load = useCallback(async (targetDir?: string) => {
    setLoading(true);
    setError(null);
    const q = targetDir ? `?dir=${encodeURIComponent(targetDir)}` : "";
    const { data, error: err } = await get<FsListResponse>(`/api/fs/list${q}`);
    setLoading(false);
    if (err || !data) {
      // A failed switch must not leave the previous root's files on screen —
      // clear so the error banner isn't contradicted by stale entries.
      setEntries([]);
      setSelected(new Set());
      setPreviewedFile(null);
      setError(err || t("files.error.load"));
      return;
    }
    setEntries(data.entries ?? []);
    setSelected(new Set());
    setPreviewedFile(null);
    setDir(data.dir);
    setRoot((prev) => prev ?? data.root);
    workspaceRootRef.current ??= data.root;
  }, [get, t]);

  useEffect(() => { void load(); }, [load]);

  const projectRoots = useMemo(() => runtimeBrowsableProjectRoots(roots), [roots]);
  const switchRoot = useCallback((path: string | null) => {
    setSearch("");
    setRoot(path ?? workspaceRootRef.current);
    void load(path ?? workspaceRootRef.current ?? undefined);
  }, [load]);

  useEffect(() => {
    if (!previewedFile) { setFileSource(null); return; }
    let cancelled = false;
    void get<{ source: FileSource | null }>(`/api/fs/source?path=${encodeURIComponent(previewedFile.path)}`).then(({ data }) => {
      if (!cancelled) setFileSource(data?.source ?? null);
    });
    return () => { cancelled = true; };
  }, [get, previewedFile]);

  const atRoot = useMemo(() => !root || !dir || dir === root, [root, dir]);
  const totalSize = useMemo(
    () => entries.reduce((sum, entry) => sum + (entry.isDir ? 0 : entry.size ?? 0), 0),
    [entries],
  );

  const visibleEntries = useMemo(() => {
    const query = search.trim().toLowerCase();
    const filtered = query
      ? entries.filter((entry) => entryLabel(entry).toLowerCase().includes(query))
      : entries;
    const compare = (a: FsEntry, b: FsEntry) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      if (sortMode === "name") return entryLabel(a).localeCompare(entryLabel(b));
      if (sortMode === "size") return (b.size ?? 0) - (a.size ?? 0);
      return b.mtime - a.mtime;
    };
    return [...filtered].sort(compare);
  }, [entries, search, sortMode]);

  const groupedEntries = useMemo(() => {
    const isWorking = (entry: FsEntry) => {
      const name = entryLabel(entry).toLowerCase();
      return !entry.isDir && (/^pasted-\d+\./.test(name) || /^probe-/.test(name) || entry.artifactKind === "code");
    };
    return {
      folders: visibleEntries.filter((entry) => entry.isDir),
      deliverables: visibleEntries.filter((entry) => !entry.isDir && !isWorking(entry)),
      working: visibleEntries.filter(isWorking),
    };
  }, [visibleEntries]);

  const selectedEntries = useMemo(
    () => entries.filter((entry) => selected.has(entry.path)),
    [entries, selected],
  );
  const allVisibleSelected = visibleEntries.length > 0 && visibleEntries.every((entry) => selected.has(entry.path));
  const soleSelectedFolder = selectedEntries.length === 1 && selectedEntries[0].isDir ? selectedEntries[0] : null;

  const goUp = () => {
    if (!dir || atRoot) return;
    const parent = parentDir(dir) || root || dir;
    void load(parent);
  };

  const openEntry = (entry: FsEntry) => {
    if (entry.isDir) {
      void load(entry.path);
      return;
    }
    setPreviewedFile(entry);
    onOpenArtifact?.(buildFileArtifact({
      path: entry.path,
      filename: entryLabel(entry),
      mime: entry.mime,
      size: entry.size,
      timestamp: entry.mtime,
    }));
  };

  const revealEntry = async (entry: FsEntry) => {
    const { error: err } = await post("/api/fs/reveal", { path: entry.path });
    if (err) setError(err);
  };

  const doRename = async (entry: FsEntry, nextName: string) => {
    const trimmed = nextName.trim();
    if (!trimmed || trimmed === entry.name) return;
    const { error: err } = await post("/api/fs/rename", { path: entry.path, newName: trimmed });
    setDialog(null);
    if (err) { setError(err); return; }
    void load(dir ?? undefined);
  };

  // Reusable primitives shared by the Add card. Return a result instead of
  // toasting so the card can sequence mkdir → upload.
  const createFolderAt = async (targetDir: string, name: string): Promise<{ path?: string; error?: string }> => {
    const { data, error: err } = await post<{ success: boolean; path?: string }>("/api/fs/mkdir", { dir: targetDir, name: name.trim() });
    if (err) return { error: err };
    return { path: data?.path };
  };

  const uploadFilesTo = async (targetDir: string, files: File[]): Promise<{ error?: string }> => {
    if (files.length === 0) return {};
    const form = new FormData();
    form.append("dir", targetDir);
    for (const file of files) form.append("files", file, file.name);
    try {
      const response = await fetch(`/upload?dir=${encodeURIComponent(targetDir)}`, {
        method: "POST",
        credentials: "include",
        body: form,
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        return { error: typeof data.error === "string" ? data.error : `Upload failed (${response.status})` };
      }
      return {};
    } catch (err) {
      return { error: err instanceof Error ? err.message : t("files.error.upload") };
    }
  };

  const doDelete = async (targets: FsEntry[]) => {
    setDialog(null);
    const failures: string[] = [];
    for (const entry of targets) {
      const { error: err } = await del(`/api/fs/file?path=${encodeURIComponent(entry.path)}`);
      if (err) failures.push(`${entryLabel(entry)}: ${err}`);
    }
    if (failures.length > 0) setError(failures.join("\n"));
    void load(dir ?? undefined);
  };

  const doMove = async (targets: FsEntry[], destDir: string) => {
    setDialog(null);
    const { data, error: err } = await post<{ success: boolean; errors?: Array<{ path: string; error: string }> }>("/api/fs/move", {
      paths: targets.map((entry) => entry.path),
      destDir,
    });
    if (err) { setError(err); return; }
    if (data?.errors?.length) setError(t("files.movePartial", { count: data.errors.length }));
    void load(dir ?? undefined);
  };

  const uploadFiles = async (files: File[]) => {
    if (!dir || files.length === 0) return;
    setUploading(true);
    setError(null);
    const { error: err } = await uploadFilesTo(dir, files);
    setUploading(false);
    if (err) { setError(err); return; }
    void load(dir);
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragActive(false);
    void uploadFiles(Array.from(event.dataTransfer.files ?? []));
  };

  const toggleEntry = (path: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const toggleAllVisible = () => {
    setSelected((current) => {
      const next = new Set(current);
      if (allVisibleSelected) {
        for (const entry of visibleEntries) next.delete(entry.path);
      } else {
        for (const entry of visibleEntries) next.add(entry.path);
      }
      return next;
    });
  };

  const startChatForEntry = (entry: FsEntry) => {
    const label = entryLabel(entry);
    if (entry.isDir) {
      onStartChat?.({ folderPath: entry.path, label });
      return;
    }
    const folderPath = parentDir(entry.path);
    onStartChat?.({
      folderPath,
      label: pathLeaf(folderPath) || label,
      attachPath: entry.path,
      attachFilename: label,
    });
  };

  const renderEntry = (entry: FsEntry) => (
    <div
      key={entry.path}
      className="group grid grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-3 border-b border-ink/[0.045] px-3 py-2.5 last:border-b-0 hover:bg-ink/[0.02]"
    >
      <input
        type="checkbox"
        checked={selected.has(entry.path)}
        onChange={() => toggleEntry(entry.path)}
        aria-label={t("files.selectItem", { name: entryLabel(entry) })}
      />
      <button type="button" onClick={() => openEntry(entry)} className="flex min-w-0 items-center gap-3 text-left">
        {entry.isDir
          ? <span className="flex h-8 w-8 shrink-0 items-center justify-center"><Folder className="h-6 w-6 text-accent/70" /></span>
          : <TypeIcon type={entryLabel(entry).split(".").pop() || "file"} size={32} />}
        <span className="min-w-0">
          <span className="block truncate text-[13px] font-medium text-ink/80">{entryLabel(entry)}</span>
          <span className="block truncate text-[10.5px] text-ink/34">
            {entry.isDir ? t("files.folder") : `${formatSize(entry.size)} · ${formatTime(entry.mtime)}`}
          </span>
        </span>
      </button>
      <div className="flex shrink-0 items-center gap-1 opacity-100 md:opacity-0 md:transition-opacity md:group-hover:opacity-100 md:focus-within:opacity-100">
        <IconAction title={entry.isDir ? t("files.openFolder") : t("files.open")} onClick={() => openEntry(entry)}>
          {entry.isDir ? <FolderOpen className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
        </IconAction>
        {!entry.isDir && <a href={fileDownloadUrl(entry.path)} download title={t("files.download")} className="inline-flex h-8 w-8 items-center justify-center rounded-md text-ink/45 transition-colors hover:bg-ink/[0.06] hover:text-ink/70"><Download className="h-3.5 w-3.5" /></a>}
        {localOrigin && <IconAction title={revealLabel} onClick={() => void revealEntry(entry)}><FolderOpen className="h-3.5 w-3.5" /></IconAction>}
        <IconAction title={entry.isDir ? t("files.startChatHere") : t("files.startChat")} onClick={() => startChatForEntry(entry)}><MessageSquarePlus className="h-3.5 w-3.5" /></IconAction>
        {!entry.isDir && <IconAction title={t("files.attachToChat")} onClick={() => onAttachToChat?.({ path: entry.path, filename: entryLabel(entry) })}><Paperclip className="h-3.5 w-3.5" /></IconAction>}
        <IconAction title={t("files.rename")} onClick={() => setDialog({ kind: "rename", entry })}><Pencil className="h-3.5 w-3.5" /></IconAction>
        <IconAction title={t("files.delete")} danger onClick={() => setDialog({ kind: "delete", entries: [entry] })}><Trash2 className="h-3.5 w-3.5" /></IconAction>
      </div>
    </div>
  );

  return (
    <WorkspacePage testId="files-view" contentClassName="max-w-[1180px]">
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-[22px] font-semibold tracking-normal text-ink/85">{t("files.title")}</h1>
            <p className="mt-1 max-w-[720px] text-[12.5px] leading-5 text-ink/40">{t("files.description")}</p>
            <p className="mt-2 text-[11.5px] text-ink/36">
              {t("files.summary", { count: entries.length, size: formatSize(totalSize) || "0 B" })}
              <span aria-hidden="true"> · </span>
              <button
                type="button"
                onClick={() => setLocationVisible((visible) => !visible)}
                className="text-ink/36 underline-offset-2 transition-colors hover:text-ink/60 hover:underline"
              >
                {locationVisible ? t("files.hideLocation") : t("files.showLocation")}
              </button>
            </p>
            {locationVisible && (
              <p className="mt-1 max-w-[720px] truncate font-mono text-[11px] text-ink/40" title={dir ?? ""}>{dir ?? ""}</p>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void load(dir ?? undefined)}
              className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border px-3 text-[12.5px] font-medium transition-colors hover:bg-ink/[0.04]"
              style={{ borderColor: "var(--border-medium)", color: "var(--text-secondary)" }}
            >
              <RefreshCw className="h-3.5 w-3.5" />
              {t("files.refresh")}
            </button>
            <button
              type="button"
              onClick={() => setDialog({ kind: "add" })}
              disabled={!dir}
              className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-3 text-[12.5px] font-medium transition-colors disabled:opacity-50"
              style={{ background: "var(--accent)", color: "var(--accent-fg)" }}
            >
              {uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
              {t("files.add")}
            </button>
          </div>
        </div>

        {projectRoots.length > 0 && (
          <div data-testid="files-root-switcher" className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={() => switchRoot(null)}
              aria-pressed={!root || root === workspaceRootRef.current}
              className={`inline-flex h-7 items-center rounded-full border px-3 text-[12px] transition-colors ${!root || root === workspaceRootRef.current ? "border-accent/40 bg-accent/10 text-ink/85" : "border-ink/[0.08] text-ink/50 hover:text-ink/75"}`}
            >
              {t("root.workspace")}
            </button>
            {projectRoots.map((projectRoot) => (
              <button
                key={projectRoot.path}
                type="button"
                onClick={() => switchRoot(projectRoot.path)}
                aria-pressed={root === projectRoot.path}
                className={`inline-flex h-7 max-w-[220px] items-center rounded-full border px-3 text-[12px] transition-colors ${root === projectRoot.path ? "border-accent/40 bg-accent/10 text-ink/85" : "border-ink/[0.08] text-ink/50 hover:text-ink/75"}`}
              >
                <span className="truncate">{runtimeRootLabel(projectRoot, locale)}</span>
              </button>
            ))}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2 text-[12px] text-ink/45">
          {!atRoot && (
            <button
              type="button"
              onClick={goUp}
              className="inline-flex h-8 items-center gap-1 rounded-md px-2 transition-colors hover:bg-ink/[0.05]"
              style={{ color: "var(--text-secondary)" }}
            >
              <FolderUp className="h-3.5 w-3.5" />
              {t("files.up")}
            </button>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2">
          <label
            className="flex h-8 min-w-[220px] flex-1 items-center gap-2 rounded-md border px-2.5"
            style={{ borderColor: "var(--border-medium)", background: "var(--surface-input)" }}
          >
            <Search className="h-3.5 w-3.5" style={{ color: "var(--text-muted)" }} />
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t("files.search")}
              className="min-w-0 flex-1 bg-transparent text-[12.5px] outline-none placeholder:text-ink/30"
              style={{ color: "var(--text-primary)" }}
            />
            {search && (
              <button type="button" onClick={() => setSearch("")} title={t("files.clearSearch")}>
                <X className="h-3.5 w-3.5" style={{ color: "var(--text-muted)" }} />
              </button>
            )}
          </label>
          <label
            className="flex h-8 items-center gap-2 rounded-md border px-2.5"
            style={{ borderColor: "var(--border-medium)", color: "var(--text-secondary)" }}
          >
            <ArrowUpDown className="h-3.5 w-3.5" />
            <select
              value={sortMode}
              onChange={(event) => setSortMode(event.target.value as FilesSortMode)}
              className="bg-transparent text-[12.5px] outline-none"
              style={{ color: "var(--text-secondary)" }}
            >
              <option value="name">{t("files.sort.name")}</option>
              <option value="size">{t("files.sort.size")}</option>
              <option value="newest">{t("files.sort.newest")}</option>
            </select>
          </label>
        </div>

        {selectedEntries.length > 0 && (
          <div
            className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-[12.5px]"
            style={{ borderColor: "var(--border-medium)", background: "var(--surface-elevated)", color: "var(--text-secondary)" }}
          >
            <span>{t("files.selected", { count: selectedEntries.length })}</span>
            <div className="flex items-center gap-2">
              {soleSelectedFolder && (
                <button
                  type="button"
                  onClick={() => onStartChat?.({ folderPath: soleSelectedFolder.path, label: entryLabel(soleSelectedFolder) })}
                  className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 font-medium"
                  style={{ background: "var(--accent)", color: "var(--accent-fg)" }}
                >
                  <MessageSquarePlus className="h-3.5 w-3.5" />
                  {t("files.startSession")}
                </button>
              )}
              <button type="button" onClick={() => setDialog({ kind: "move", entries: selectedEntries })} className="rounded-md px-2 py-1 hover:bg-ink/[0.05]">
                {t("files.move")}
              </button>
              <button type="button" onClick={() => setDialog({ kind: "delete", entries: selectedEntries })} className="rounded-md px-2 py-1 hover:bg-danger/10" style={{ color: "var(--danger)" }}>
                {t("files.deleteSelected")}
              </button>
            </div>
          </div>
        )}

        {error && <div className="whitespace-pre-wrap rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-[12px] text-warning">{error}</div>}

        {previewedFile && (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border px-3 py-2 text-[11.5px] text-ink/45" style={{ borderColor: "var(--border-subtle)", background: "var(--surface-elevated)" }}>
            <span>{formatSize(previewedFile.size)}</span><span aria-hidden="true">·</span>
            <span>{t("files.created", { date: formatTime(previewedFile.created ?? previewedFile.mtime) })}</span><span aria-hidden="true">·</span>
            <span className="max-w-[420px] truncate">{relativeDisplayPath(previewedFile.path, root, dir)}</span>
            {fileSource && <><span aria-hidden="true">·</span><button type="button" className="text-accent hover:underline" onClick={() => onOpenSession?.(fileSource.sessionId)}>{t("files.fromChat", { title: fileSource.sessionTitle })}</button></>}
            {localOrigin && <><span aria-hidden="true">·</span><button type="button" className="text-accent hover:underline" onClick={() => void revealEntry(previewedFile)}>{revealLabel}</button></>}
          </div>
        )}

        <div
          className={`overflow-hidden rounded-lg border ${dragActive ? "border-dashed" : ""}`}
          style={{ borderColor: dragActive ? "var(--accent)" : "rgb(var(--ink-rgb) / 0.07)", background: dragActive ? "var(--surface-hover)" : undefined }}
          onDragOver={(event) => {
            event.preventDefault();
            setDragActive(true);
          }}
          onDragLeave={() => setDragActive(false)}
          onDrop={handleDrop}
        >
          {loading ? (
            <div className="flex items-center justify-center gap-2 px-4 py-10 text-[12.5px] text-ink/40">
              <Loader2 className="h-4 w-4 animate-spin" /> {t("common.loading")}
            </div>
          ) : visibleEntries.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-4 py-14 text-center text-[12.5px] text-ink/35">
              <Upload className="h-5 w-5 text-ink/25" />
              <span>{search ? t("files.noMatches") : t("files.dropHint")}</span>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-3 border-b border-ink/[0.045] px-3 py-2 text-[11px] text-ink/34">
                <input type="checkbox" checked={allVisibleSelected} onChange={toggleAllVisible} aria-label={t("files.selectAll")} />
                <span>{t("files.name")}</span>
                <span>{t("files.actions")}</span>
              </div>
              {search.trim() ? visibleEntries.map(renderEntry) : <>
                {groupedEntries.folders.map(renderEntry)}
                {groupedEntries.deliverables.map(renderEntry)}
                {groupedEntries.working.length > 0 && <>
                  <button type="button" className="flex w-full items-center justify-between border-b border-ink/[0.045] px-3 py-2 text-left text-[12px] font-medium text-ink/55 hover:bg-ink/[0.02]" onClick={() => setWorkingFilesExpanded((value) => !value)} aria-expanded={workingFilesExpanded}>
                    <span>{t("files.workingFiles")}</span><span>{groupedEntries.working.length}</span>
                  </button>
                  {workingFilesExpanded && groupedEntries.working.map(renderEntry)}
                </>}
              </>}
            </>
          )}
        </div>
      </div>

      {dialog?.kind === "add" && dir && (
        <AddContentDialog
          currentDir={dir}
          root={root ?? dir}
          onCancel={() => setDialog(null)}
          createFolderAt={createFolderAt}
          uploadFilesTo={uploadFilesTo}
          onDone={(destDir) => { setDialog(null); void load(destDir); }}
        />
      )}
      {dialog?.kind === "rename" && (
        <TextPromptDialog
          title={t("files.rename")}
          label={t("files.newName")}
          initialValue={entryLabel(dialog.entry)}
          confirmText={t("files.save")}
          onCancel={() => setDialog(null)}
          onConfirm={(value) => void doRename(dialog.entry, value)}
        />
      )}
      {dialog?.kind === "delete" && (
        <ConfirmDialog
          title={t("files.delete")}
          message={
            dialog.entries.length === 1
              ? t("files.confirmDelete", { name: entryLabel(dialog.entries[0]) })
              : t("files.confirmDeleteSelected", { count: dialog.entries.length })
          }
          confirmText={t("files.delete")}
          danger
          onCancel={() => setDialog(null)}
          onConfirm={() => void doDelete(dialog.entries)}
        />
      )}
      {dialog?.kind === "move" && root && (
        <MoveDialog
          entries={dialog.entries}
          root={root}
          startDir={dir ?? root}
          onCancel={() => setDialog(null)}
          onConfirm={(destDir) => void doMove(dialog.entries, destDir)}
        />
      )}
    </WorkspacePage>
  );
}

function IconAction({
  title,
  children,
  danger = false,
  onClick,
}: {
  title: string;
  children: ReactNode;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`inline-flex h-8 w-8 items-center justify-center rounded-md text-ink/45 transition-colors ${
        danger ? "hover:bg-danger/10 hover:text-danger" : "hover:bg-ink/[0.06] hover:text-ink/70"
      }`}
    >
      {children}
    </button>
  );
}

function ModalShell({ title, children, onClose, width = "440px" }: { title: string; children: ReactNode; onClose: () => void; width?: string }) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(id);
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div
      className={`fixed inset-0 z-50 flex items-center justify-center px-4 py-6 transition-opacity duration-150 ease-out ${shown ? "opacity-100" : "opacity-0"}`}
      style={{ background: "rgb(0 0 0 / 0.40)" }}
      onClick={onClose}
    >
      <div
        className={`w-full overflow-hidden rounded-xl border shadow-2xl transition-all duration-150 ease-out ${shown ? "translate-y-0 opacity-100" : "translate-y-1 opacity-0"}`}
        style={{ maxWidth: width, borderColor: "var(--border-medium)", background: "var(--surface)" }}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b px-4 py-3" style={{ borderColor: "var(--border-subtle)" }}>
          <h2 className="text-[14px] font-semibold text-ink/85">{title}</h2>
          <button type="button" onClick={onClose} className="text-ink/40 transition-colors hover:text-ink/70">
            <X className="h-4 w-4" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function DialogFooter({ children }: { children: ReactNode }) {
  return <div className="flex justify-end gap-2 border-t px-4 py-3" style={{ borderColor: "var(--border-subtle)" }}>{children}</div>;
}

function TextPromptDialog({
  title,
  label,
  initialValue = "",
  confirmText,
  onCancel,
  onConfirm,
}: {
  title: string;
  label: string;
  initialValue?: string;
  confirmText: string;
  onCancel: () => void;
  onConfirm: (value: string) => void;
}) {
  const { t } = useLocale();
  const [value, setValue] = useState(initialValue);
  const submit = () => { if (value.trim()) onConfirm(value.trim()); };
  return (
    <ModalShell title={title} onClose={onCancel}>
      <div className="px-4 py-4">
        <label className="mb-1.5 block text-[11px] text-ink/45">{label}</label>
        <input
          autoFocus
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter") submit(); }}
          className="h-9 w-full rounded-md border px-2.5 text-[13px] outline-none"
          style={{ background: "var(--surface-input)", borderColor: "var(--border-subtle)", color: "var(--text-primary)" }}
        />
      </div>
      <DialogFooter>
        <button type="button" onClick={onCancel} className="h-8 rounded-md px-3 text-[12.5px] text-ink/55 transition-colors hover:bg-ink/[0.05]">
          {t("files.cancel")}
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={!value.trim()}
          className="h-8 rounded-md px-3 text-[12.5px] font-medium transition-colors disabled:opacity-50"
          style={{ background: "var(--accent)", color: "var(--accent-fg)" }}
        >
          {confirmText}
        </button>
      </DialogFooter>
    </ModalShell>
  );
}

function ConfirmDialog({
  title,
  message,
  confirmText,
  danger = false,
  onCancel,
  onConfirm,
}: {
  title: string;
  message: string;
  confirmText: string;
  danger?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useLocale();
  return (
    <ModalShell title={title} onClose={onCancel}>
      <div className="px-4 py-4 text-[13px] leading-6 text-ink/70">{message}</div>
      <DialogFooter>
        <button type="button" onClick={onCancel} className="h-8 rounded-md px-3 text-[12.5px] text-ink/55 transition-colors hover:bg-ink/[0.05]">
          {t("files.cancel")}
        </button>
        <button
          type="button"
          onClick={onConfirm}
          className="h-8 rounded-md px-3 text-[12.5px] font-medium text-white transition-colors"
          style={{ background: danger ? "var(--danger)" : "var(--accent)" }}
        >
          {confirmText}
        </button>
      </DialogFooter>
    </ModalShell>
  );
}

interface MoveFolder {
  name: string;
  displayName?: string;
  path: string;
  isDir: boolean;
}

function MoveDialog({
  entries,
  root,
  startDir,
  onCancel,
  onConfirm,
}: {
  entries: FsEntry[];
  root: string;
  startDir: string;
  onCancel: () => void;
  onConfirm: (destDir: string) => void;
}) {
  const { get } = useApi();
  const { t } = useLocale();
  const [browseDir, setBrowseDir] = useState(startDir);
  const [folders, setFolders] = useState<MoveFolder[]>([]);
  const [loading, setLoading] = useState(true);
  const movingPaths = useMemo(() => new Set(entries.map((entry) => entry.path)), [entries]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void get<FsListResponse>(`/api/fs/list?dir=${encodeURIComponent(browseDir)}`).then(({ data }) => {
      if (cancelled) return;
      setFolders((data?.entries ?? []).filter((entry) => entry.isDir));
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [browseDir, get]);

  const atRoot = browseDir === root;
  const label = (entry: MoveFolder) => entry.displayName || entry.name;

  return (
    <ModalShell title={t("files.moveTitle", { count: entries.length })} onClose={onCancel}>
      <div className="px-4 py-3">
        <div className="mb-2 flex items-center gap-2 text-[11.5px] text-ink/45">
          <button
            type="button"
            disabled={atRoot}
            onClick={() => setBrowseDir(browseDir.replace(/[\\/][^\\/]+[\\/]?$/, "") || root)}
            className="inline-flex h-7 items-center gap-1 rounded-md px-2 transition-colors hover:bg-ink/[0.05] disabled:opacity-40"
            style={{ color: "var(--text-secondary)" }}
          >
            <FolderUp className="h-3.5 w-3.5" />
            {t("files.up")}
          </button>
          <span className="min-w-0 flex-1 truncate font-mono text-[11px]" title={browseDir}>{browseDir}</span>
        </div>
        <div className="max-h-[260px] overflow-y-auto rounded-md border" style={{ borderColor: "var(--border-subtle)" }}>
          {loading ? (
            <div className="flex items-center justify-center gap-2 px-3 py-8 text-[12px] text-ink/40">
              <Loader2 className="h-4 w-4 animate-spin" /> {t("common.loading")}
            </div>
          ) : folders.length === 0 ? (
            <div className="px-3 py-8 text-center text-[12px] text-ink/35">{t("files.moveNoSubfolders")}</div>
          ) : (
            folders.map((folder) => (
              <button
                key={folder.path}
                type="button"
                disabled={movingPaths.has(folder.path)}
                onClick={() => setBrowseDir(folder.path)}
                className="flex w-full items-center gap-2.5 border-b px-3 py-2 text-left text-[12.5px] transition-colors last:border-b-0 hover:bg-ink/[0.04] disabled:opacity-40"
                style={{ borderColor: "rgb(var(--ink-rgb) / 0.05)", color: "var(--text-secondary)" }}
              >
                <Folder className="h-4 w-4 shrink-0 text-accent/70" />
                <span className="min-w-0 flex-1 truncate">{label(folder)}</span>
                <FolderOpen className="h-3.5 w-3.5 shrink-0 text-ink/30" />
              </button>
            ))
          )}
        </div>
      </div>
      <DialogFooter>
        <button type="button" onClick={onCancel} className="h-8 rounded-md px-3 text-[12.5px] text-ink/55 transition-colors hover:bg-ink/[0.05]">
          {t("files.cancel")}
        </button>
        <button
          type="button"
          onClick={() => onConfirm(browseDir)}
          className="inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-[12.5px] font-medium transition-colors"
          style={{ background: "var(--accent)", color: "var(--accent-fg)" }}
        >
          <FolderOpen className="h-3.5 w-3.5" />
          {t("files.moveHere")}
        </button>
      </DialogFooter>
    </ModalShell>
  );
}

/**
 * The "Add" card — the one place to bring content into the workspace: drag or
 * pick files, then choose to drop them into an existing folder or a new one.
 * Built to grow (URL / connector imports can slot in as more source tabs).
 */
function AddContentDialog({
  currentDir,
  root,
  onCancel,
  createFolderAt,
  uploadFilesTo,
  onDone,
}: {
  currentDir: string;
  root: string;
  onCancel: () => void;
  createFolderAt: (dir: string, name: string) => Promise<{ path?: string; error?: string }>;
  uploadFilesTo: (dir: string, files: File[]) => Promise<{ error?: string }>;
  onDone: (destDir: string) => void;
}) {
  const { get } = useApi();
  const { t } = useLocale();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const [mode, setMode] = useState<"existing" | "new">("existing");
  const [browseDir, setBrowseDir] = useState(currentDir);
  const [folders, setFolders] = useState<MoveFolder[]>([]);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (mode !== "existing") return;
    let cancelled = false;
    void get<FsListResponse>(`/api/fs/list?dir=${encodeURIComponent(browseDir)}`).then(({ data }) => {
      if (!cancelled) setFolders((data?.entries ?? []).filter((entry) => entry.isDir));
    });
    return () => { cancelled = true; };
  }, [browseDir, get, mode]);

  const addFiles = (incoming: File[]) => {
    if (incoming.length === 0) return;
    setFiles((current) => {
      const seen = new Set(current.map((f) => `${f.name}:${f.size}`));
      return [...current, ...incoming.filter((f) => !seen.has(`${f.name}:${f.size}`))];
    });
  };

  const canConfirm = !busy && (mode === "new" ? newName.trim().length > 0 : files.length > 0);
  const atRoot = browseDir === root;

  const confirm = async () => {
    setBusy(true);
    setError(null);
    let destDir = mode === "existing" ? browseDir : currentDir;
    if (mode === "new") {
      const created = await createFolderAt(currentDir, newName.trim());
      if (created.error || !created.path) { setBusy(false); setError(created.error ?? t("files.error.load")); return; }
      destDir = created.path;
    }
    if (files.length > 0) {
      const up = await uploadFilesTo(destDir, files);
      if (up.error) { setBusy(false); setError(up.error); return; }
    }
    setBusy(false);
    onDone(destDir);
  };

  return (
    <ModalShell title={t("files.add")} onClose={onCancel}>
      <div className="max-h-[70vh] overflow-y-auto px-4 py-4">
        {/* Drop zone / file picker */}
        <div
          role="button"
          tabIndex={0}
          onClick={() => fileInputRef.current?.click()}
          onDragOver={(event) => { event.preventDefault(); setDragActive(true); }}
          onDragLeave={() => setDragActive(false)}
          onDrop={(event) => { event.preventDefault(); setDragActive(false); addFiles(Array.from(event.dataTransfer.files ?? [])); }}
          className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border border-dashed px-4 py-8 text-center transition-colors"
          style={{ borderColor: dragActive ? "var(--accent)" : "rgb(var(--ink-rgb) / 0.16)", background: dragActive ? "var(--surface-hover)" : "var(--surface-input)" }}
        >
          <Upload className="h-6 w-6 text-ink/35" />
          <span className="text-[12.5px] text-ink/55">{t("files.addDropHint")}</span>
          <span className="text-[11px] text-ink/34">{t("files.addBrowseHint")}</span>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(event: ChangeEvent<HTMLInputElement>) => { addFiles(Array.from(event.target.files ?? [])); event.target.value = ""; }}
          />
        </div>

        {files.length > 0 && (
          <div className="mt-3 space-y-1">
            {files.map((file) => (
              <div key={`${file.name}:${file.size}`} className="flex items-center gap-2 rounded-md px-2 py-1.5" style={{ background: "var(--surface-hover)" }}>
                <TypeIcon type={file.name.split(".").pop() || "file"} size={22} />
                <span className="min-w-0 flex-1 truncate text-[12px] text-ink/70">{file.name}</span>
                <span className="shrink-0 text-[10.5px] text-ink/34">{formatSize(file.size)}</span>
                <button type="button" onClick={() => setFiles((c) => c.filter((f) => f !== file))} className="text-ink/40 hover:text-ink/70">
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Destination */}
        <div className="mt-4">
          <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-ink/40">{t("files.destination")}</div>
          <div className="mb-2 inline-flex rounded-md border p-0.5" style={{ borderColor: "var(--border-subtle)" }}>
            {(["existing", "new"] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className="rounded px-3 py-1 text-[12px] font-medium transition-colors"
                style={mode === m ? { background: "var(--accent)", color: "var(--accent-fg)" } : { color: "var(--text-secondary)" }}
              >
                {m === "existing" ? t("files.destExisting") : t("files.destNew")}
              </button>
            ))}
          </div>

          {mode === "existing" ? (
            <div>
              <div className="mb-1.5 flex items-center gap-2 text-[11.5px] text-ink/45">
                <button
                  type="button"
                  disabled={atRoot}
                  onClick={() => setBrowseDir(browseDir.replace(/[\\/][^\\/]+[\\/]?$/, "") || root)}
                  className="inline-flex h-7 items-center gap-1 rounded-md px-2 transition-colors hover:bg-ink/[0.05] disabled:opacity-40"
                  style={{ color: "var(--text-secondary)" }}
                >
                  <FolderUp className="h-3.5 w-3.5" />
                  {t("files.up")}
                </button>
                <span className="min-w-0 flex-1 truncate font-mono text-[11px]" title={browseDir}>{browseDir}</span>
              </div>
              <div className="max-h-[160px] overflow-y-auto rounded-md border" style={{ borderColor: "var(--border-subtle)" }}>
                {folders.length === 0 ? (
                  <div className="px-3 py-6 text-center text-[12px] text-ink/35">{t("files.moveNoSubfolders")}</div>
                ) : (
                  folders.map((folder) => (
                    <button
                      key={folder.path}
                      type="button"
                      onClick={() => setBrowseDir(folder.path)}
                      className="flex w-full items-center gap-2.5 border-b px-3 py-2 text-left text-[12.5px] transition-colors last:border-b-0 hover:bg-ink/[0.04]"
                      style={{ borderColor: "rgb(var(--ink-rgb) / 0.05)", color: "var(--text-secondary)" }}
                    >
                      <Folder className="h-4 w-4 shrink-0 text-accent/70" />
                      <span className="min-w-0 flex-1 truncate">{folder.displayName || folder.name}</span>
                      <FolderOpen className="h-3.5 w-3.5 shrink-0 text-ink/30" />
                    </button>
                  ))
                )}
              </div>
              <p className="mt-1.5 text-[11px] text-ink/34">{t("files.addUploadTarget", { dir: friendlyDirName(browseDir, root, t("files.workspaceRoot")) })}</p>
            </div>
          ) : (
            <div>
              <label className="mb-1.5 block text-[11px] text-ink/45">{t("files.folderName")}</label>
              <input
                autoFocus
                value={newName}
                onChange={(event) => setNewName(event.target.value)}
                className="h-9 w-full rounded-md border px-2.5 text-[13px] outline-none"
                style={{ background: "var(--surface-input)", borderColor: "var(--border-subtle)", color: "var(--text-primary)" }}
              />
              <p className="mt-1.5 text-[11px] text-ink/34">{t("files.addNewTarget", { dir: friendlyDirName(currentDir, root, t("files.workspaceRoot")) })}</p>
            </div>
          )}
        </div>

        {error && <div className="mt-3 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-[12px] text-warning">{error}</div>}
      </div>
      <DialogFooter>
        <button type="button" onClick={onCancel} className="h-8 rounded-md px-3 text-[12.5px] text-ink/55 transition-colors hover:bg-ink/[0.05]">
          {t("files.cancel")}
        </button>
        <button
          type="button"
          onClick={() => void confirm()}
          disabled={!canConfirm}
          className="inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-[12.5px] font-medium transition-colors disabled:opacity-50"
          style={{ background: "var(--accent)", color: "var(--accent-fg)" }}
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
          {mode === "new" && files.length === 0 ? t("files.create") : t("files.add")}
        </button>
      </DialogFooter>
    </ModalShell>
  );
}
