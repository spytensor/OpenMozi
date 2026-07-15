import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../config/index.js';
import { getDb } from '../store/db.js';
import { createTempDir, removeTempDir, setupTestDb, teardownTestDb } from '../test-helpers.js';
import {
  buildArtifactPersistedRelativePath,
  getLatestArtifactVersion,
  getNextArtifactVersionNumber,
  insertArtifactVersion,
  persistArtifactContent,
  persistArtifactContentToPath,
} from './versioning.js';

let tmpDir: string;
let dbTmpDir: string;
let savedMoziHome: string | undefined;
const testUserId = 'user-artifact-versioning';

beforeAll(() => {
  tmpDir = createTempDir();
  savedMoziHome = process.env.MOZI_HOME;
  process.env.MOZI_HOME = join(tmpDir, 'mozi-home');
  process.env.MOZI_WORKSPACES = join(tmpDir, 'user-workspaces');
  loadConfig('/nonexistent/mozi.json');
});

beforeEach(() => {
  const dbSetup = setupTestDb();
  dbTmpDir = dbSetup.tmpDir;
  loadConfig('/nonexistent/mozi.json');
});

afterEach(() => {
  teardownTestDb(dbTmpDir);
});

afterAll(() => {
  delete process.env.MOZI_WORKSPACES;
  if (savedMoziHome === undefined) delete process.env.MOZI_HOME;
  else process.env.MOZI_HOME = savedMoziHome;
  removeTempDir(tmpDir);
  loadConfig('/nonexistent/mozi.json');
});

describe('artifacts/versioning', () => {
  it('keeps unrelated CJK report titles on distinct persisted paths', () => {
    const southAsia = buildArtifactPersistedRelativePath({
      title: '南亚国家税务研究 2026年Q2',
      contentType: 'markdown',
      sessionId: 'same-session',
    });
    const gulf = buildArtifactPersistedRelativePath({
      title: '海湾国家税务研究 2026年Q2',
      contentType: 'markdown',
      sessionId: 'same-session',
    });
    expect(southAsia).not.toBe(gulf);
  });

  it('returns the latest artifact version while preserving queryable history', async () => {
    const artifactId = 'artifact_history_root';
    const v1 = '# History Draft\n\nParagraph one.\n\nParagraph two before edit.';
    const v2 = '# History Draft\n\nParagraph one.\n\nParagraph two after edit.';

    const persistedPath = await persistArtifactContent({
      title: 'History Draft',
      contentType: 'markdown',
      content: v1,
      sessionId: 'session-versioning',
      userId: testUserId,
    });
    expect(persistedPath).toContain(join('user-workspaces', testUserId, 'artifacts', 'session-versioning'));
    expect(persistedPath).toMatch(/history-draft-[a-f0-9]{10}\.md$/);
    expect(readFileSync(persistedPath, 'utf-8')).toBe(v1);

    insertArtifactVersion({
      id: 'artifact_history_v1',
      artifactId,
      versionNumber: 1,
      content: v1,
      persistedPath,
      createdAt: 100,
    });

    expect(getNextArtifactVersionNumber(artifactId)).toBe(2);

    const updatedPath = await persistArtifactContentToPath(persistedPath, v2, testUserId);
    expect(updatedPath).toBe(persistedPath);
    expect(readFileSync(persistedPath, 'utf-8')).toBe(v2);

    insertArtifactVersion({
      id: 'artifact_history_v2',
      artifactId,
      versionNumber: getNextArtifactVersionNumber(artifactId),
      content: v2,
      persistedPath,
      changeDescription: 'Edit paragraph two',
      createdAt: 200,
    });

    const latest = getLatestArtifactVersion(artifactId);
    expect(latest).toMatchObject({
      id: 'artifact_history_v2',
      artifact_id: artifactId,
      version_number: 2,
      content: v2,
      persisted_path: persistedPath,
      change_description: 'Edit paragraph two',
    });

    expect(getLatestArtifactVersion('artifact_history_v1')).toMatchObject({
      id: 'artifact_history_v2',
      artifact_id: artifactId,
      version_number: 2,
      content: v2,
    });

    const rows = getDb().prepare(`
      SELECT id, artifact_id, version_number, content, persisted_path, change_description
      FROM artifact_versions
      WHERE artifact_id = ?
      ORDER BY version_number ASC
    `).all(artifactId) as Array<Record<string, unknown>>;

    expect(rows).toHaveLength(2);
    expect(rows.map(row => row.version_number)).toEqual([1, 2]);
    expect(rows.map(row => row.content)).toEqual([v1, v2]);
    expect(rows[0]).toMatchObject({
      id: 'artifact_history_v1',
      artifact_id: artifactId,
      persisted_path: persistedPath,
      change_description: null,
    });
    expect(rows[1]).toMatchObject({
      id: 'artifact_history_v2',
      artifact_id: artifactId,
      persisted_path: persistedPath,
      change_description: 'Edit paragraph two',
    });
  });
});
