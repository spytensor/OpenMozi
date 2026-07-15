import { resolve } from 'node:path';
import {
  createArtifactId,
  type ArtifactEnvelope,
  type ArtifactEvent,
  type ArtifactPatch,
  type ArtifactStatus,
} from './types.js';

export interface ArtifactSeed {
  plugin_id: string;
  title: string;
  content_type?: string;
  status?: ArtifactStatus;
  collapsed_by_default?: boolean;
  fallback_text?: string;
  data?: Record<string, unknown>;
  persisted_path?: string;
  parent_id?: string;
  version_number?: number;
  change_description?: string;
}

interface ArtifactRecord {
  artifactId: string;
  key: string;
  title: string;
  pluginId: string;
  contentType?: string;
  status: ArtifactStatus;
  fallbackText: string;
  terminal: boolean;
  paths: Set<string>;
  persistedPath?: string;
  parentId?: string;
  versionNumber?: number;
  changeDescription?: string;
}

function normalizePathKey(path: string): string {
  return resolve(path).replace(/\\/g, '/');
}

function isTerminal(status: ArtifactStatus | undefined): boolean {
  return status === 'completed' || status === 'failed' || status === 'closed';
}

function pluginPrefix(pluginId: string): string {
  if (pluginId === 'document_v1') return 'document';
  if (pluginId === 'sandpack_v1') return 'sandpack';
  if (pluginId === 'file_v1') return 'file';
  if (pluginId === 'live_work_v1') return 'live';
  return 'artifact';
}

function dataContentType(data: Record<string, unknown> | undefined): string | undefined {
  return typeof data?.content_type === 'string' ? data.content_type : undefined;
}

function patchFromSeed(record: ArtifactRecord, seed: ArtifactSeed): ArtifactPatch | null {
  const patch: ArtifactPatch = {};
  if (seed.plugin_id && seed.plugin_id !== record.pluginId) {
    patch.plugin_id = seed.plugin_id;
  }
  if (seed.title && seed.title !== record.title) {
    patch.title = seed.title;
  }
  const nextContentType = seed.content_type ?? dataContentType(seed.data);
  if (nextContentType && nextContentType !== record.contentType) {
    patch.data = { ...(seed.data ?? {}), content_type: nextContentType };
  } else if (seed.data !== undefined) {
    patch.data = seed.data;
  }
  if (seed.fallback_text !== undefined && seed.fallback_text !== record.fallbackText) {
    patch.fallback_text = seed.fallback_text;
  }
  if (seed.status !== undefined && seed.status !== record.status) {
    patch.status = seed.status;
  }
  if (seed.persisted_path !== undefined && seed.persisted_path !== record.persistedPath) {
    patch.persisted_path = seed.persisted_path;
  }
  if (seed.parent_id !== undefined && seed.parent_id !== record.parentId) {
    patch.parent_id = seed.parent_id;
  }
  if (seed.version_number !== undefined && seed.version_number !== record.versionNumber) {
    patch.version_number = seed.version_number;
  }
  if (seed.change_description !== undefined && seed.change_description !== record.changeDescription) {
    patch.change_description = seed.change_description;
  }
  if (Object.keys(patch).length === 0) return null;
  patch.updated_at = new Date().toISOString();
  return patch;
}

export class ArtifactCoordinator {
  private readonly recordsByToolCallId = new Map<string, ArtifactRecord>();
  private readonly recordsByArtifactId = new Map<string, ArtifactRecord>();
  private readonly artifactIdByPath = new Map<string, string>();
  private readonly pendingPathsByToolCallId = new Map<string, Set<string>>();

  constructor(
    private readonly turnId: string,
    private readonly emit: (event: ArtifactEvent) => void,
  ) {}

  openOrGet(toolCallId: string, seed: ArtifactSeed): string {
    const existing = this.recordsByToolCallId.get(toolCallId);
    if (existing) {
      this.applySeed(existing, seed);
      return existing.artifactId;
    }

    const status = seed.status ?? 'running';
    const contentType = seed.content_type ?? dataContentType(seed.data);
    const artifactId = createArtifactId(pluginPrefix(seed.plugin_id));
    const record: ArtifactRecord = {
      artifactId,
      key: toolCallId,
      title: seed.title,
      pluginId: seed.plugin_id,
      contentType,
      status,
      fallbackText: seed.fallback_text ?? seed.title,
      terminal: isTerminal(status),
      paths: new Set(),
      persistedPath: seed.persisted_path,
      parentId: seed.parent_id,
      versionNumber: seed.version_number,
      changeDescription: seed.change_description,
    };
    this.recordsByToolCallId.set(toolCallId, record);
    this.recordsByArtifactId.set(artifactId, record);
    const pendingPaths = this.pendingPathsByToolCallId.get(toolCallId);
    if (pendingPaths) {
      for (const path of pendingPaths) {
        record.paths.add(path);
        this.artifactIdByPath.set(path, artifactId);
      }
      this.pendingPathsByToolCallId.delete(toolCallId);
    }

    const data = contentType && !seed.data?.content_type
      ? { ...(seed.data ?? {}), content_type: contentType }
      : (seed.data ?? {});
    const artifact: ArtifactEnvelope = {
      id: artifactId,
      plugin_id: seed.plugin_id,
      title: seed.title,
      status,
      collapsed_by_default: seed.collapsed_by_default ?? false,
      fallback_text: record.fallbackText,
      data,
      updated_at: new Date().toISOString(),
      ...(record.persistedPath ? { persisted_path: record.persistedPath } : {}),
      ...(record.parentId ? { parent_id: record.parentId } : {}),
      ...(record.versionNumber !== undefined ? { version_number: record.versionNumber } : {}),
      ...(record.changeDescription ? { change_description: record.changeDescription } : {}),
    };
    this.emit({ type: 'open', artifact });
    return artifactId;
  }

  has(toolCallId: string): boolean {
    return this.recordsByToolCallId.has(toolCallId);
  }

  patch(toolCallId: string, patch: ArtifactPatch): void {
    const record = this.recordsByToolCallId.get(toolCallId);
    if (!record || record.terminal) return;
    this.emitPatch(record, patch);
  }

  complete(toolCallId: string, finalPatch: ArtifactPatch = {}): void {
    const record = this.recordsByToolCallId.get(toolCallId);
    if (!record || record.terminal) return;
    this.emitPatch(record, { ...finalPatch, status: finalPatch.status ?? 'completed' });
  }

  registerFileWrite(toolCallId: string, absPath: string): void {
    const key = normalizePathKey(absPath);
    const record = this.recordsByToolCallId.get(toolCallId);
    if (record) {
      record.paths.add(key);
      if (record.artifactId) this.artifactIdByPath.set(key, record.artifactId);
      return;
    }
    const pending = this.pendingPathsByToolCallId.get(toolCallId) ?? new Set<string>();
    pending.add(key);
    this.pendingPathsByToolCallId.set(toolCallId, pending);
  }

  resolveByPath(absPath: string): string | null {
    return this.artifactIdByPath.get(normalizePathKey(absPath)) ?? null;
  }

  /** Associate an additional physical path with an existing artifact identity. */
  bindPathToArtifact(artifactId: string, absPath: string): void {
    const record = this.recordsByArtifactId.get(artifactId);
    if (!record) return;
    const key = normalizePathKey(absPath);
    record.paths.add(key);
    this.artifactIdByPath.set(key, artifactId);
  }

  /**
   * Titles of completed, user-facing FILE deliverables emitted this turn
   * (docx/pptx/pdf/xlsx and generated documents), de-duplicated in emit order.
   * Lets the runtime honestly acknowledge what a turn produced when the model
   * ends silently — a turn whose value is its files is NOT an empty turn.
   */
  completedDeliverableTitles(): string[] {
    const titles: string[] = [];
    const seen = new Set<string>();
    for (const record of this.recordsByArtifactId.values()) {
      if (record.status !== 'completed') continue;
      if (record.pluginId !== 'file_v1' && record.pluginId !== 'document_v1') continue;
      const title = record.title?.trim();
      if (!title || seen.has(title)) continue;
      seen.add(title);
      titles.push(title);
    }
    return titles;
  }

  openFileByPath(absPath: string, seed: ArtifactSeed): string {
    const key = normalizePathKey(absPath);
    const existingArtifactId = this.artifactIdByPath.get(key);
    if (existingArtifactId) {
      const existing = this.recordsByArtifactId.get(existingArtifactId);
      if (existing) {
        this.applySeed(existing, seed);
        return existing.artifactId;
      }
    }

    const toolCallId = `file:${key}`;
    const artifactId = this.openOrGet(toolCallId, seed);
    const record = this.recordsByToolCallId.get(toolCallId);
    if (record) {
      record.paths.add(key);
      this.artifactIdByPath.set(key, artifactId);
    }
    return artifactId;
  }

  patchArtifact(artifactId: string, patch: ArtifactPatch): void {
    const record = this.recordsByArtifactId.get(artifactId);
    if (!record) return;
    this.emitPatch(record, patch);
  }

  terminateAll(status: ArtifactStatus = 'closed', fallbackText?: string): void {
    for (const record of this.recordsByArtifactId.values()) {
      if (!record.artifactId || record.terminal) continue;
      this.emitPatch(record, {
        title: record.title || undefined,
        status,
        fallback_text: fallbackText,
        data: {
          content_type: record.contentType,
          live_preview: true,
          phase: status === 'failed' ? 'failed' : 'done',
          meta: { turn_id: this.turnId },
        },
        updated_at: new Date().toISOString(),
      });
    }
  }

  private applySeed(record: ArtifactRecord, seed: ArtifactSeed): void {
    if (record.terminal) return;
    const patch = patchFromSeed(record, seed);
    if (!patch) return;
    this.emitPatch(record, patch);
  }

  private emitPatch(record: ArtifactRecord, patch: ArtifactPatch): void {
    const normalizedPatch = { ...patch };
    if (normalizedPatch.data) {
      const nextContentType = dataContentType(normalizedPatch.data);
      if (nextContentType) record.contentType = nextContentType;
    }
    if (normalizedPatch.plugin_id) record.pluginId = normalizedPatch.plugin_id;
    if (normalizedPatch.title) record.title = normalizedPatch.title;
    if (normalizedPatch.fallback_text) record.fallbackText = normalizedPatch.fallback_text;
    if (normalizedPatch.persisted_path !== undefined) record.persistedPath = normalizedPatch.persisted_path;
    if (normalizedPatch.parent_id !== undefined) record.parentId = normalizedPatch.parent_id;
    if (normalizedPatch.version_number !== undefined) record.versionNumber = normalizedPatch.version_number;
    if (normalizedPatch.change_description !== undefined) record.changeDescription = normalizedPatch.change_description;
    if (normalizedPatch.status) {
      record.status = normalizedPatch.status;
      record.terminal = isTerminal(normalizedPatch.status);
    }
    if (!normalizedPatch.updated_at) normalizedPatch.updated_at = new Date().toISOString();
    this.emit({ type: 'patch', artifactId: record.artifactId, patch: normalizedPatch });
    for (const path of record.paths) {
      this.artifactIdByPath.set(path, record.artifactId);
    }
  }
}

export interface ArtifactCoordinatorContext {
  turnId?: string;
  artifactCoordinator?: ArtifactCoordinator;
  onArtifact?: (event: ArtifactEvent) => void;
}

export function ensureArtifactCoordinator(
  context: ArtifactCoordinatorContext | undefined,
  fallbackTurnId: string,
): ArtifactCoordinator {
  if (context?.artifactCoordinator) return context.artifactCoordinator;
  const coordinator = new ArtifactCoordinator(
    context?.turnId ?? fallbackTurnId,
    context?.onArtifact ?? (() => {}),
  );
  if (context) {
    context.artifactCoordinator = coordinator;
  }
  return coordinator;
}
