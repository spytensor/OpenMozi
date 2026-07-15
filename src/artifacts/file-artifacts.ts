import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { readdir, lstat, realpath } from 'node:fs/promises';
import { basename, extname, relative, resolve } from 'node:path';
import pino from 'pino';
import type { ArtifactCoordinator } from './coordinator.js';
import {
  getOutputDir,
  getWorkspaceAllowedRoots,
  isPathInsideRoot,
} from '../tools/workspace-policy.js';
import { buildFileArtifactPreviewFields } from './file-preview.js';

const logger = pino({ name: 'mozi:file-artifacts' });

export type FileArtifactKind =
  | 'deck'
  | 'document'
  | 'sheet'
  | 'image'
  | 'archive'
  | 'code'
  | 'other';

export interface FileArtifactData {
  path: string;
  filename: string;
  ext: string;
  size: number;
  mime: string;
  kind: FileArtifactKind;
  previewable: boolean;
  previewUrl?: string;
  downloadUrl: string;
  skillName?: string;
}

interface CandidateFile {
  data: FileArtifactData;
  mtimeMs: number;
  ctimeMs: number;
}

interface FileFingerprint {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

interface EmittedFile {
  artifactId: string;
  fingerprint: FileFingerprint;
  contentKey: string;
}

interface ContentArtifact {
  artifactId: string;
  candidate: CandidateFile;
}

interface ScanRoot {
  path: string;
  kind: 'output' | 'project';
}

export interface TurnFileArtifactTracker {
  captureBaseline(): Promise<void>;
  noteSkillUse(skillName: string): void;
  scanAndEmit(): Promise<void>;
  emitPaths(paths: readonly string[]): Promise<void>;
}

interface TurnFileArtifactTrackerOptions {
  activeRootPath?: string;
  userId?: string;
  artifactCoordinator?: ArtifactCoordinator;
  richArtifactPaths?: ReadonlySet<string>;
}

export const DECK_EXTENSIONS = new Set(['pptx', 'key']);
export const DOCUMENT_EXTENSIONS = new Set(['docx', 'pdf', 'md', 'txt', 'rtf']);
export const SHEET_EXTENSIONS = new Set(['xlsx', 'csv', 'tsv']);
export const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg']);
export const ARCHIVE_EXTENSIONS = new Set(['zip', 'tar', 'gz', 'tgz']);
export const CODE_EXTENSIONS = new Set([
  'js',
  'mjs',
  'cjs',
  'ts',
  'tsx',
  'jsx',
  'py',
  'json',
  'jsonl',
  'yaml',
  'yml',
  'toml',
  'xml',
  'html',
  'htm',
  'css',
  'scss',
  'sass',
  'less',
  'sh',
  'bash',
  'zsh',
  'sql',
  'go',
  'rs',
  'rb',
  'php',
  'swift',
  'kt',
  'kts',
  'java',
  'c',
  'h',
  'cpp',
  'cc',
  'cxx',
  'hpp',
  'cs',
  'lua',
  'r',
  'scala',
  'dart',
  'vue',
  'svelte',
]);
export const OTHER_DELIVERABLE_EXTENSIONS = new Set(['epub']);

const SKIPPED_DIRECTORY_NAMES = new Set([
  'node_modules',
  'bower_components',
  'jspm_packages',
  '__pycache__',
  'tmp',
  'temp',
  'cache',
  'target',
  'build',
  'dist',
  'out',
  'coverage',
]);

const MIME_BY_EXT: Record<string, string> = {
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  key: 'application/vnd.apple.keynote',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pdf: 'application/pdf',
  md: 'text/markdown; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  rtf: 'application/rtf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv; charset=utf-8',
  tsv: 'text/tab-separated-values; charset=utf-8',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  zip: 'application/zip',
  tar: 'application/x-tar',
  gz: 'application/gzip',
  tgz: 'application/gzip',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  cjs: 'text/javascript; charset=utf-8',
  ts: 'text/typescript; charset=utf-8',
  tsx: 'text/typescript; charset=utf-8',
  jsx: 'text/javascript; charset=utf-8',
  py: 'text/x-python; charset=utf-8',
  json: 'application/json; charset=utf-8',
  jsonl: 'application/x-ndjson; charset=utf-8',
  yaml: 'application/yaml; charset=utf-8',
  yml: 'application/yaml; charset=utf-8',
  toml: 'application/toml; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  scss: 'text/x-scss; charset=utf-8',
  sass: 'text/x-sass; charset=utf-8',
  less: 'text/css; charset=utf-8',
  sh: 'text/x-shellscript; charset=utf-8',
  bash: 'text/x-shellscript; charset=utf-8',
  zsh: 'text/x-shellscript; charset=utf-8',
  sql: 'application/sql; charset=utf-8',
  go: 'text/x-go; charset=utf-8',
  rs: 'text/rust; charset=utf-8',
  rb: 'text/x-ruby; charset=utf-8',
  php: 'application/x-httpd-php; charset=utf-8',
  swift: 'text/x-swift; charset=utf-8',
  kt: 'text/x-kotlin; charset=utf-8',
  kts: 'text/x-kotlin; charset=utf-8',
  java: 'text/x-java-source; charset=utf-8',
  c: 'text/x-c; charset=utf-8',
  h: 'text/x-c; charset=utf-8',
  cpp: 'text/x-c++; charset=utf-8',
  cc: 'text/x-c++; charset=utf-8',
  cxx: 'text/x-c++; charset=utf-8',
  hpp: 'text/x-c++; charset=utf-8',
  cs: 'text/x-csharp; charset=utf-8',
  lua: 'text/x-lua; charset=utf-8',
  r: 'text/x-r; charset=utf-8',
  scala: 'text/x-scala; charset=utf-8',
  dart: 'text/x-dart; charset=utf-8',
  vue: 'text/x-vue; charset=utf-8',
  svelte: 'text/x-svelte; charset=utf-8',
  epub: 'application/epub+zip',
};

function normalizeExt(path: string): string {
  return extname(path).replace(/^\./, '').toLowerCase();
}

export function classifyFileArtifactKind(ext: string): FileArtifactKind | null {
  const normalized = ext.toLowerCase();
  if (DECK_EXTENSIONS.has(normalized)) return 'deck';
  if (DOCUMENT_EXTENSIONS.has(normalized)) return 'document';
  if (SHEET_EXTENSIONS.has(normalized)) return 'sheet';
  if (IMAGE_EXTENSIONS.has(normalized)) return 'image';
  if (ARCHIVE_EXTENSIONS.has(normalized)) return 'archive';
  if (CODE_EXTENSIONS.has(normalized)) return 'code';
  if (OTHER_DELIVERABLE_EXTENSIONS.has(normalized)) return 'other';
  return normalized ? 'other' : null;
}

export function mimeForFileExtension(ext: string): string {
  return MIME_BY_EXT[ext.toLowerCase()] ?? 'application/octet-stream';
}

export function mimeForFilePath(path: string): string {
  return mimeForFileExtension(normalizeExt(path));
}

function fingerprint(candidate: CandidateFile): FileFingerprint {
  return {
    size: candidate.data.size,
    mtimeMs: candidate.mtimeMs,
    ctimeMs: candidate.ctimeMs,
  };
}

async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

function sameFingerprint(a: FileFingerprint | undefined, b: FileFingerprint): boolean {
  if (!a) return false;
  return a.size === b.size
    && a.mtimeMs === b.mtimeMs
    && a.ctimeMs === b.ctimeMs;
}

async function contentKey(candidate: CandidateFile): Promise<string | null> {
  try {
    const hash = createHash('sha256');
    await new Promise<void>((resolveHash, rejectHash) => {
      const stream = createReadStream(candidate.data.path);
      stream.on('data', chunk => hash.update(chunk));
      stream.on('error', rejectHash);
      stream.on('end', resolveHash);
    });
    return `${candidate.data.ext}:${candidate.data.size}:${hash.digest('hex')}`;
  } catch {
    return null;
  }
}

function filenameQuality(filename: string): number {
  const meaningful = filename.match(/[\p{L}\p{N}]/gu)?.length ?? 0;
  const placeholders = filename.match(/_+/g)?.reduce((total, run) => total + run.length, 0) ?? 0;
  return meaningful - placeholders;
}

function preferCandidate(next: CandidateFile, current: CandidateFile): boolean {
  const nextChangedAt = Math.max(next.mtimeMs, next.ctimeMs);
  const currentChangedAt = Math.max(current.mtimeMs, current.ctimeMs);
  if (nextChangedAt !== currentChangedAt) return nextChangedAt > currentChangedAt;
  return filenameQuality(next.data.filename) > filenameQuality(current.data.filename);
}

function shouldSkipPathSegment(segment: string): boolean {
  if (!segment) return true;
  if (segment.startsWith('.')) return true;
  return SKIPPED_DIRECTORY_NAMES.has(segment.toLowerCase());
}

function shouldSkipFileName(filename: string): boolean {
  const lower = filename.toLowerCase();
  return filename.startsWith('.')
    || lower === 'tmp'
    || lower === 'temp'
    || lower.endsWith('.tmp')
    || lower.endsWith('.temp')
    || lower.endsWith('~')
    || lower.startsWith('~$')
    || lower.includes('.tmp.');
}

function isPathUnderRoot(targetPath: string, rootPath: string): boolean {
  return isPathInsideRoot(resolve(targetPath), resolve(rootPath));
}

function dedupeScanRoots(roots: ScanRoot[]): ScanRoot[] {
  const out: ScanRoot[] = [];
  for (const root of roots) {
    const resolved = resolve(root.path);
    if (out.some((existing) => existing.path === resolved)) continue;
    out.push({ ...root, path: resolved });
  }
  return out;
}

function resolveScanRoots(activeRootPath?: string, userId?: string): ScanRoot[] {
  const outputDir = resolve(getOutputDir());
  const roots: ScanRoot[] = [{ path: outputDir, kind: 'output' }];

  if (activeRootPath?.trim()) {
    const expanded = resolve(activeRootPath.trim());
    const allowedRoots = getWorkspaceAllowedRoots(userId);
    if (allowedRoots.some((root) => isPathUnderRoot(expanded, root))) {
      roots.push({ path: expanded, kind: 'project' });
    }
  }

  return dedupeScanRoots(roots);
}

function candidateFromStat(
  root: ScanRoot,
  filePath: string,
  size: number,
  mtimeMs: number,
  ctimeMs: number,
  explicit = false,
): CandidateFile | null {
  const filename = basename(filePath);
  if (shouldSkipFileName(filename)) return null;

  const relativePath = relative(root.path, filePath);
  const segments = relativePath.split(/[\\/]+/).filter(Boolean);
  if (segments.some(shouldSkipPathSegment)) return null;

  const ext = normalizeExt(filePath);
  const kind = classifyFileArtifactKind(ext);
  if (!kind) return null;
  if (!explicit && (kind === 'code' || kind === 'other')) return null;
  if (root.kind === 'output' && ext === 'py') return null;

  const resolvedPath = resolve(filePath);
  return {
    data: {
      path: resolvedPath,
      filename,
      ext,
      size,
      mime: mimeForFileExtension(ext),
      kind,
      downloadUrl: `/api/fs/file?${new URLSearchParams({ path: resolvedPath }).toString()}`,
      ...buildFileArtifactPreviewFields(resolvedPath, ext),
    },
    mtimeMs,
    ctimeMs,
  };
}

async function collectDeliverableFiles(root: ScanRoot): Promise<CandidateFile[]> {
  const candidates: CandidateFile[] = [];

  async function walk(dirPath: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dirPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const entryPath = resolve(dirPath, entry.name);
      const relativePath = relative(root.path, entryPath);
      const segments = relativePath.split(/[\\/]+/).filter(Boolean);
      if (segments.some(shouldSkipPathSegment)) continue;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await walk(entryPath);
        continue;
      }
      if (!entry.isFile()) continue;

      let stats;
      try {
        stats = await lstat(entryPath);
      } catch {
        continue;
      }
      if (!stats.isFile()) continue;

      const candidate = candidateFromStat(root, entryPath, stats.size, stats.mtimeMs, stats.ctimeMs);
      if (candidate) candidates.push(candidate);
    }
  }

  await walk(root.path);
  return candidates;
}

function buildFileArtifactPatch(artifactId: string, data: FileArtifactData): Parameters<ArtifactCoordinator['patchArtifact']>[1] {
  return {
    plugin_id: 'file_v1',
    title: data.filename,
    status: 'completed',
    fallback_text: `File ready: ${data.filename}`,
    data: { ...data },
    updated_at: new Date().toISOString(),
  };
}

/** Sequentially-numbered render frames (slide-01.jpg, page_3.png, frame12.jpg). */
const RENDER_FRAME_RE = /^(?:slide|page|frame|img|image)[-_ ]?\d{1,4}$/i;
/** Kinds that represent a primary produced document the user actually asked for. */
const PRIMARY_DOC_KINDS = new Set(['deck', 'document', 'sheet']);
/** Display priority when a batch mixes deliverable kinds (lower = shown first). */
const DELIVERABLE_KIND_RANK: Record<string, number> = {
  deck: 0, document: 1, sheet: 2, archive: 3, image: 4, code: 5, other: 6,
};

function basenameWithoutExt(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot > 0 ? filename.slice(0, dot) : filename;
}

function isRenderFrameImage(data: FileArtifactData): boolean {
  return data.kind === 'image' && RENDER_FRAME_RE.test(basenameWithoutExt(data.filename));
}

/**
 * Decide which produced files to surface to the user and in what order.
 *
 * A deck/report task drops its final `.pptx`/`.pdf` next to the per-slide render
 * frames it used to build and verify them (slide-01.jpg ... slide-11.jpg). The
 * user wants the deliverable, not the 11 JPEGs — so when a primary document
 * deliverable is present, its sequentially-numbered render frames are dropped.
 * Survivors are ordered by deliverable priority (deck → document → sheet → ...)
 * instead of raw alphabetical path order, so the main file leads.
 */
export function curateDeliverables(candidates: CandidateFile[]): CandidateFile[] {
  const hasPrimaryDoc = candidates.some((c) => PRIMARY_DOC_KINDS.has(c.data.kind));
  const kept = hasPrimaryDoc ? candidates.filter((c) => !isRenderFrameImage(c.data)) : candidates;
  return [...kept].sort((a, b) => {
    const ra = DELIVERABLE_KIND_RANK[a.data.kind] ?? 9;
    const rb = DELIVERABLE_KIND_RANK[b.data.kind] ?? 9;
    return ra !== rb ? ra - rb : a.data.path.localeCompare(b.data.path);
  });
}

export function createTurnFileArtifactTracker(options: TurnFileArtifactTrackerOptions): TurnFileArtifactTracker {
  const roots = resolveScanRoots(options.activeRootPath, options.userId);
  const turnStartedAtMs = Date.now();
  const baseline = new Map<string, FileFingerprint>();
  const emitted = new Map<string, EmittedFile>();
  const emittedByContent = new Map<string, ContentArtifact>();
  let lastSkillName: string | undefined;

  async function collectAll(): Promise<CandidateFile[]> {
    const nestedRoots = roots.filter((root, index) => (
      roots.some((other, otherIndex) => otherIndex !== index && isPathUnderRoot(root.path, other.path))
    ));
    const candidates: CandidateFile[] = [];
    for (const root of roots) {
      if (nestedRoots.includes(root)) continue;
      candidates.push(...await collectDeliverableFiles(root));
    }
    return candidates;
  }

  async function scanAndEmit(): Promise<void> {
    if (!options.artifactCoordinator) return;

    let candidates: CandidateFile[];
    try {
      candidates = await collectAll();
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Failed to scan file artifacts');
      return;
    }

    await emitCandidates(candidates, false);
  }

  async function emitCandidates(candidates: CandidateFile[], explicit: boolean): Promise<void> {
    const coordinator = options.artifactCoordinator;
    if (!coordinator) return;
    for (const candidate of curateDeliverables(candidates)) {
      const key = await canonicalPath(candidate.data.path);
      const nextFingerprint = fingerprint(candidate);
      if (sameFingerprint(baseline.get(key), nextFingerprint)) continue;
      if (options.richArtifactPaths?.has(key)) continue;
      if (!explicit && candidate.mtimeMs < turnStartedAtMs && candidate.ctimeMs < turnStartedAtMs && !emitted.has(key)) continue;
      const canonicalData: FileArtifactData = candidate.data.path === key
        ? candidate.data
        : {
            ...candidate.data,
            path: key,
            downloadUrl: `/api/fs/file?${new URLSearchParams({ path: key }).toString()}`,
            ...buildFileArtifactPreviewFields(key, candidate.data.ext),
          };
      const data: FileArtifactData = lastSkillName
        ? { ...canonicalData, skillName: lastSkillName }
        : canonicalData;

      const previous = emitted.get(key);
      const resolvedArtifactId = coordinator.resolveByPath(key);
      if (resolvedArtifactId) {
        if (previous && sameFingerprint(previous.fingerprint, nextFingerprint)) continue;
        const nextContentKey = await contentKey(candidate);
        const record: EmittedFile = {
          artifactId: resolvedArtifactId,
          fingerprint: nextFingerprint,
          contentKey: nextContentKey ?? `path:${key}`,
        };
        emitted.set(key, record);
        if (nextContentKey && !emittedByContent.has(nextContentKey)) {
          emittedByContent.set(nextContentKey, { artifactId: resolvedArtifactId, candidate });
        }
        coordinator.patchArtifact(resolvedArtifactId, buildFileArtifactPatch(resolvedArtifactId, data));
        continue;
      }

      if (!previous) {
        const nextContentKey = await contentKey(candidate);
        const duplicate = nextContentKey ? emittedByContent.get(nextContentKey) : undefined;
        if (duplicate) {
          coordinator.bindPathToArtifact(duplicate.artifactId, key);
          emitted.set(key, {
            artifactId: duplicate.artifactId,
            fingerprint: nextFingerprint,
            contentKey: nextContentKey!,
          });
          if (preferCandidate(candidate, duplicate.candidate)) {
            duplicate.candidate = candidate;
            coordinator.patchArtifact(
              duplicate.artifactId,
              buildFileArtifactPatch(duplicate.artifactId, data),
            );
          }
          continue;
        }
        const artifactId = coordinator.openFileByPath(key, {
          plugin_id: 'file_v1',
          title: data.filename,
          status: 'completed',
          collapsed_by_default: false,
          fallback_text: `File ready: ${data.filename}`,
          data: { ...data },
        });
        const record: EmittedFile = {
          artifactId,
          fingerprint: nextFingerprint,
          contentKey: nextContentKey ?? `path:${key}`,
        };
        emitted.set(key, record);
        if (nextContentKey) emittedByContent.set(nextContentKey, { artifactId, candidate });
        continue;
      }

      if (sameFingerprint(previous.fingerprint, nextFingerprint)) continue;
      if (emittedByContent.get(previous.contentKey)?.artifactId === previous.artifactId) {
        emittedByContent.delete(previous.contentKey);
      }
      const nextContentKey = await contentKey(candidate);
      previous.fingerprint = nextFingerprint;
      previous.contentKey = nextContentKey ?? `path:${key}`;
      emitted.set(key, previous);
      if (nextContentKey) emittedByContent.set(nextContentKey, { artifactId: previous.artifactId, candidate });
      coordinator.patchArtifact(previous.artifactId, buildFileArtifactPatch(previous.artifactId, data));
    }
  }

  async function emitPaths(paths: readonly string[]): Promise<void> {
    const configuredRoots = dedupeScanRoots([
      ...roots,
      ...getWorkspaceAllowedRoots(options.userId).map(path => ({ path, kind: 'project' as const })),
    ]);
    const allowedRoots = await Promise.all(configuredRoots.map(async root => ({
      ...root,
      path: await canonicalPath(root.path),
    })));
    const candidates: CandidateFile[] = [];
    for (const rawPath of new Set(paths.map(path => path.trim()).filter(Boolean))) {
      const filePath = await canonicalPath(rawPath);
      const root = allowedRoots.find(candidate => isPathUnderRoot(filePath, candidate.path));
      if (!root) continue;
      try {
        const stats = await lstat(filePath);
        if (!stats.isFile()) continue;
        const candidate = candidateFromStat(root, filePath, stats.size, stats.mtimeMs, stats.ctimeMs, true);
        if (candidate) candidates.push(candidate);
      } catch {
        // A worker may report a path that was cleaned up before delivery.
      }
    }
    await emitCandidates(candidates, true);
  }

  return {
    async captureBaseline(): Promise<void> {
      const candidates = await collectAll();
      baseline.clear();
      for (const candidate of candidates) {
        baseline.set(await canonicalPath(candidate.data.path), fingerprint(candidate));
      }
    },

    noteSkillUse(skillName: string): void {
      const trimmed = skillName.trim();
      if (trimmed) lastSkillName = trimmed;
    },

    scanAndEmit,
    emitPaths,
  };
}
