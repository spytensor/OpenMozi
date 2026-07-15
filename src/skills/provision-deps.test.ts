import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { provisionSkillDependencies } from './provision-deps.js';
import { getSkillNodeModulesDir, getSkillRuntimeDir } from '../paths.js';

/**
 * Network-free tests for the skill dependency provisioner. The install paths
 * that actually shell out to npm/pip are proven by the live end-to-end run in
 * the PR description; here we lock the decision logic (skip/idempotency/kinds)
 * that must not regress.
 */
describe('provisionSkillDependencies', () => {
  let prevHome: string | undefined;
  let home: string;

  beforeEach(() => {
    prevHome = process.env.MOZI_HOME;
    home = mkdtempSync(join(tmpdir(), 'mozi-prov-'));
    process.env.MOZI_HOME = home;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.MOZI_HOME;
    else process.env.MOZI_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('returns an empty result for undefined / empty specs', async () => {
    expect(await provisionSkillDependencies(undefined)).toEqual({ installed: [], skipped: [], failed: [] });
    expect(await provisionSkillDependencies([])).toEqual({ installed: [], skipped: [], failed: [] });
  });

  it('skips brew and manual kinds (cannot auto-provision) without touching the network', async () => {
    const res = await provisionSkillDependencies([
      { kind: 'brew', formula: 'libreoffice', package: 'libreoffice' },
      { kind: 'manual', command: 'do a thing', package: 'thing' },
    ]);
    expect(res.installed).toEqual([]);
    expect(res.skipped).toEqual(expect.arrayContaining(['libreoffice', 'thing']));
    expect(res.failed).toEqual([]);
  });

  it('treats an npm package already present in node_modules as skipped (idempotent, no install)', async () => {
    // Pre-create the resolved package dir so the existsSync short-circuit fires.
    mkdirSync(join(getSkillNodeModulesDir(), 'pptxgenjs'), { recursive: true });
    const res = await provisionSkillDependencies([{ kind: 'npm', package: 'pptxgenjs' }]);
    expect(res.skipped).toContain('pptxgenjs');
    expect(res.installed).toEqual([]);
    // No marker write is required for the skip path, but the runtime dir must not be clobbered.
    expect(existsSync(join(getSkillNodeModulesDir(), 'pptxgenjs'))).toBe(true);
  });

  it('scopes the runtime dir under MOZI_HOME', () => {
    expect(getSkillRuntimeDir()).toBe(join(home, 'skill-runtime'));
    expect(getSkillNodeModulesDir()).toBe(join(home, 'skill-runtime', 'node_modules'));
  });
});
