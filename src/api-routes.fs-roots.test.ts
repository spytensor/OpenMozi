import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { registerApiRoutes } from './api-routes.js';
import { getConfigPath } from './paths.js';
import { loadConfig } from './config/index.js';
import { setupTestDb, teardownTestDb } from './test-helpers.js';
import { resolveWritePath } from './tools/tool-utils.js';
import { exec } from './capabilities/shell.js';

describe('api fs roots', () => {
  const savedMoziHome = process.env.MOZI_HOME;
  const savedOfficeEnv = {
    browser: process.env.OFFICE_DOCUMENT_SERVER_URL,
    internal: process.env.OFFICE_DOCUMENT_SERVER_INTERNAL_URL,
    storage: process.env.OFFICE_STORAGE_BASE_URL,
    secret: process.env.ONLYOFFICE_JWT_SECRET,
  };
  let moziHome: string;
  let projectDir: string;
  let outsideDir: string;
  let dbTmpDir: string;

  beforeEach(() => {
    moziHome = mkdtempSync(join(tmpdir(), 'mozi-fs-roots-home-'));
    projectDir = mkdtempSync(join(tmpdir(), 'mozi-fs-project-'));
    outsideDir = mkdtempSync(join(tmpdir(), 'mozi-fs-outside-'));
    process.env.MOZI_HOME = moziHome;
    loadConfig(getConfigPath());
    dbTmpDir = setupTestDb().tmpDir;
  });

  afterEach(() => {
    teardownTestDb(dbTmpDir);
    rmSync(moziHome, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
    if (savedMoziHome === undefined) {
      delete process.env.MOZI_HOME;
    } else {
      process.env.MOZI_HOME = savedMoziHome;
    }
    loadConfig('/nonexistent/mozi.json');
    for (const [key, value] of Object.entries({
      OFFICE_DOCUMENT_SERVER_URL: savedOfficeEnv.browser,
      OFFICE_DOCUMENT_SERVER_INTERNAL_URL: savedOfficeEnv.internal,
      OFFICE_STORAGE_BASE_URL: savedOfficeEnv.storage,
      ONLYOFFICE_JWT_SECRET: savedOfficeEnv.secret,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('requires authentication when auth mode is token', async () => {
    const app = Fastify();
    try {
      await registerApiRoutes(app, {
        jwtSecret: 'test-secret',
        config: {
          server: { auth_mode: 'token', host: '127.0.0.1' },
          security: { enterprise: {} },
          http_rate_limit: { global_rpm: 100, auth_rpm: 10, pair_rpm: 5 },
        },
      });

      const response = await app.inject({ method: 'GET', url: '/api/fs/roots' });
      expect(response.statusCode).toBe(401);

      const fileResponse = await app.inject({ method: 'GET', url: '/api/fs/file?path=/tmp/nope.txt' });
      expect(fileResponse.statusCode).toBe(401);

      const previewResponse = await app.inject({ method: 'GET', url: '/api/fs/preview?path=/tmp/nope.pdf&w=512' });
      expect(previewResponse.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('streams allowed files with UTF-8 attachment disposition and 404s outside roots', async () => {
    const app = Fastify();
    const outputDir = join(moziHome, 'output');
    const filename = '报告.pdf';
    const filePath = join(outputDir, filename);
    const outsidePath = join(outsideDir, 'outside.pdf');
    try {
      await registerApiRoutes(app, {
        jwtSecret: 'test-secret',
        config: {
          server: { auth_mode: 'none', host: '127.0.0.1' },
          security: { enterprise: {} },
          http_rate_limit: { global_rpm: 100, auth_rpm: 10, pair_rpm: 5 },
        },
      });

      mkdirSync(outputDir, { recursive: true });
      writeFileSync(filePath, '%PDF-1.4\nallowed');
      writeFileSync(outsidePath, '%PDF-1.4\noutside');

      const served = await app.inject({
        method: 'GET',
        url: `/api/fs/file?path=${encodeURIComponent(filePath)}`,
      });
      expect(served.statusCode).toBe(200);
      const contentType = String(served.headers['content-type'] ?? '');
      const contentDisposition = String(served.headers['content-disposition'] ?? '');
      expect(contentType).toContain('application/pdf');
      expect(contentDisposition).toContain('attachment');
      expect(contentDisposition).toContain(`filename*=UTF-8''${encodeURIComponent(filename)}`);
      expect(served.body).toBe('%PDF-1.4\nallowed');

      const outside = await app.inject({
        method: 'GET',
        url: `/api/fs/file?path=${encodeURIComponent(outsidePath)}`,
      });
      expect(outside.statusCode).toBe(404);

      const outsidePreview = await app.inject({
        method: 'GET',
        url: `/api/fs/preview?path=${encodeURIComponent(outsidePath)}&w=512`,
      });
      expect(outsidePreview.statusCode).toBe(404);
      expect(outsidePreview.json()).toMatchObject({ success: false, code: 'file_not_found' });

      const missing = await app.inject({
        method: 'GET',
        url: `/api/fs/file?path=${encodeURIComponent(join(outputDir, 'missing.pdf'))}`,
      });
      expect(missing.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('serves Docker-era artifact paths only through their current allowed App roots', async () => {
    const app = Fastify();
    const outputDir = join(moziHome, 'output');
    const userId = 'local-user';
    const userWorkspace = join(moziHome, 'workspace');
    const outputFile = join(outputDir, 'archive', 'report.pdf');
    const workspaceFile = join(userWorkspace, 'sheet.xlsx');
    try {
      await registerApiRoutes(app, {
        jwtSecret: 'test-secret',
        config: {
          server: { auth_mode: 'none', host: '127.0.0.1' },
          security: { enterprise: {} },
          http_rate_limit: { global_rpm: 100, auth_rpm: 10, pair_rpm: 5 },
        },
      });

      mkdirSync(dirname(outputFile), { recursive: true });
      mkdirSync(userWorkspace, { recursive: true });
      writeFileSync(outputFile, '%PDF-1.4\nlegacy output');
      writeFileSync(workspaceFile, 'legacy workspace');

      const outputResponse = await app.inject({
        method: 'GET',
        url: `/api/fs/file?path=${encodeURIComponent('/data/output/archive/report.pdf')}`,
      });
      expect(outputResponse.statusCode).toBe(200);
      expect(outputResponse.body).toBe('%PDF-1.4\nlegacy output');

      const workspaceResponse = await app.inject({
        method: 'GET',
        url: `/api/fs/file?path=${encodeURIComponent(`/data/workspace/users/${userId}/sheet.xlsx`)}`,
      });
      expect(workspaceResponse.statusCode).toBe(200);
      expect(workspaceResponse.body).toBe('legacy workspace');

      const traversal = await app.inject({
        method: 'GET',
        url: `/api/fs/file?path=${encodeURIComponent('/data/output/../../outside.pdf')}`,
      });
      expect(traversal.statusCode).toBe(404);

      const otherUser = await app.inject({
        method: 'GET',
        url: `/api/fs/file?path=${encodeURIComponent('/data/workspace/users/user-b/sheet.xlsx')}`,
      });
      expect(otherUser.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('creates a signed native Office session and serves its file token without a browser cookie', async () => {
    process.env.OFFICE_DOCUMENT_SERVER_URL = 'http://localhost:8082';
    process.env.OFFICE_DOCUMENT_SERVER_INTERNAL_URL = 'http://onlyoffice';
    process.env.OFFICE_STORAGE_BASE_URL = 'http://mozi:9210';
    process.env.ONLYOFFICE_JWT_SECRET = 'test-onlyoffice-secret';
    const app = Fastify();
    const outputDir = join(moziHome, 'output');
    const filePath = join(outputDir, 'budget.xlsx');
    const outsidePath = join(outsideDir, 'outside.xlsx');
    try {
      await registerApiRoutes(app, {
        jwtSecret: 'test-secret',
        config: {
          server: { auth_mode: 'none', host: '127.0.0.1' },
          security: { enterprise: {} },
          http_rate_limit: { global_rpm: 100, auth_rpm: 10, pair_rpm: 5 },
        },
      });
      mkdirSync(outputDir, { recursive: true });
      writeFileSync(filePath, 'xlsx bytes');
      writeFileSync(outsidePath, 'outside bytes');

      const session = await app.inject({
        method: 'GET',
        url: `/api/office/session?path=${encodeURIComponent(filePath)}&locale=zh-CN`,
      });
      expect(session.statusCode).toBe(200);
      expect(session.json()).toMatchObject({
        available: true,
        engine: 'onlyoffice',
        editable: false,
        config: { documentType: 'cell', editorConfig: { mode: 'view', lang: 'zh-CN' } },
      });
      const documentUrl = new URL(session.json().config.document.url);
      const served = await app.inject({ method: 'GET', url: `${documentUrl.pathname}${documentUrl.search}` });
      expect(served.statusCode).toBe(200);
      expect(served.body).toBe('xlsx bytes');

      const outside = await app.inject({
        method: 'GET',
        url: `/api/office/session?path=${encodeURIComponent(outsidePath)}`,
      });
      expect(outside.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('grants, persists, live-allows, and revokes project roots for fs and shell policy', async () => {
    const app = Fastify();
    const outputDir = join(moziHome, 'output');
    const workspaceDir = join(moziHome, 'workspace');
    try {
      await registerApiRoutes(app, {
        jwtSecret: 'test-secret',
        config: {
          server: { auth_mode: 'none', host: '127.0.0.1' },
          security: { enterprise: {} },
          http_rate_limit: { global_rpm: 100, auth_rpm: 10, pair_rpm: 5 },
        },
      });

      const initial = await app.inject({ method: 'GET', url: '/api/fs/roots' });
      expect(initial.statusCode).toBe(200);
      expect(initial.json()).toMatchObject({
        success: true,
        roots: expect.arrayContaining([
          expect.objectContaining({ tier: 'output', path: outputDir }),
          expect.objectContaining({ tier: 'workspace', path: workspaceDir }),
        ]),
      });
      expect(existsSync(outputDir)).toBe(true);
      expect(existsSync(workspaceDir)).toBe(true);

      const granted = await app.inject({
        method: 'POST',
        url: '/api/fs/roots',
        payload: { path: projectDir },
      });
      expect(granted.statusCode).toBe(200);
      expect(granted.json()).toMatchObject({
        success: true,
        root: expect.objectContaining({
          tier: 'project',
          path: projectDir,
          label: expect.any(String),
          bookmark: null,
        }),
      });

      const rawConfig = JSON.parse(readFileSync(getConfigPath(), 'utf-8')) as {
        tools?: { fs?: { additional_allowed_roots?: string[]; granted_project_roots?: Array<{ path: string; bookmark: string | null }> } };
      };
      expect(rawConfig.tools?.fs?.additional_allowed_roots).toContain(projectDir);
      expect(rawConfig.tools?.fs?.granted_project_roots?.[0]).toMatchObject({
        path: projectDir,
        bookmark: null,
      });

      loadConfig(getConfigPath());
      const projectFile = join(projectDir, 'accepted.txt');
      expect(resolveWritePath(projectFile)).toBe(projectFile);

      const shellAllowed = await exec('pwd', {
        cwd: projectDir,
        enforceWorkspaceBoundary: true,
        permissionLevel: 'L2_SHELL_EXEC',
      });
      expect(shellAllowed.blocked).toBe(false);
      expect(realpathSync(shellAllowed.stdout.trim())).toBe(realpathSync(projectDir));

      const outsideFile = join(outsideDir, 'blocked.txt');
      let refusal = '';
      try {
        resolveWritePath(outsideFile);
      } catch (err) {
        refusal = err instanceof Error ? err.message : String(err);
      }
      expect(refusal).toContain('workspace_only policy');
      expect(refusal).toContain(outputDir);
      expect(refusal).toContain(workspaceDir);
      expect(refusal).toContain(projectDir);

      const revoked = await app.inject({
        method: 'DELETE',
        url: '/api/fs/roots',
        payload: { path: projectDir },
      });
      expect(revoked.statusCode).toBe(200);
      expect(revoked.json()).toMatchObject({ success: true, revoked: true });
      expect(revoked.json().roots).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ path: projectDir })]),
      );

      expect(() => resolveWritePath(join(projectDir, 'after-revoke.txt'))).toThrow('workspace_only policy');
      const shellRevoked = await exec('pwd', {
        cwd: projectDir,
        enforceWorkspaceBoundary: true,
        permissionLevel: 'L2_SHELL_EXEC',
      });
      expect(shellRevoked.blocked).toBe(true);
      expect(shellRevoked.stderr).toContain(outputDir);
      expect(shellRevoked.stderr).toContain(workspaceDir);
    } finally {
      await app.close();
    }
  });

  it('lists display names and creates and moves entries inside allowed roots', async () => {
    const app = Fastify();
    const workspaceDir = join(moziHome, 'workspace');
    try {
      await registerApiRoutes(app, {
        jwtSecret: 'test-secret',
        config: {
          server: { auth_mode: 'none', host: '127.0.0.1' },
          security: { enterprise: {} },
          http_rate_limit: { global_rpm: 100, auth_rpm: 10, pair_rpm: 5 },
        },
      });

      mkdirSync(workspaceDir, { recursive: true });
      const storedName = '1712345678901-abcdef-report.pdf';
      const sourcePath = join(workspaceDir, storedName);
      writeFileSync(sourcePath, '%PDF-1.4\nreport');
      const realSourcePath = realpathSync(sourcePath);

      const listed = await app.inject({
        method: 'GET',
        url: `/api/fs/list?dir=${encodeURIComponent(workspaceDir)}`,
      });
      expect(listed.statusCode).toBe(200);
      expect(listed.json().entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: storedName,
            displayName: 'report.pdf',
            path: realSourcePath,
          }),
        ]),
      );

      const created = await app.inject({
        method: 'POST',
        url: '/api/fs/mkdir',
        payload: { dir: workspaceDir, name: 'Project Alpha' },
      });
      expect(created.statusCode).toBe(200);
      const projectPath = realpathSync(join(workspaceDir, 'Project Alpha'));
      expect(created.json()).toMatchObject({ success: true, path: projectPath });
      expect(existsSync(projectPath)).toBe(true);

      const badName = await app.inject({
        method: 'POST',
        url: '/api/fs/mkdir',
        payload: { dir: workspaceDir, name: '../escape' },
      });
      expect(badName.statusCode).toBe(400);

      const conflict = await app.inject({
        method: 'POST',
        url: '/api/fs/mkdir',
        payload: { dir: workspaceDir, name: 'Project Alpha' },
      });
      expect(conflict.statusCode).toBe(409);

      const moved = await app.inject({
        method: 'POST',
        url: '/api/fs/move',
        payload: { paths: [sourcePath], destDir: projectPath },
      });
      expect(moved.statusCode).toBe(200);
      expect(moved.json()).toMatchObject({
        success: true,
        moved: [{ from: realSourcePath, to: join(projectPath, storedName) }],
        errors: [],
      });
      expect(existsSync(sourcePath)).toBe(false);
      expect(readFileSync(join(projectPath, storedName), 'utf8')).toContain('report');

      const outsideSource = join(outsideDir, 'outside.txt');
      writeFileSync(outsideSource, 'outside');
      const rejected = await app.inject({
        method: 'POST',
        url: '/api/fs/move',
        payload: { paths: [outsideSource], destDir: projectPath },
      });
      expect(rejected.statusCode).toBe(200);
      expect(rejected.json()).toMatchObject({
        success: false,
        moved: [],
        errors: [expect.objectContaining({ path: outsideSource, status: 404 })],
      });
    } finally {
      await app.close();
    }
  });
});
