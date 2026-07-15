/**
 * Skill dependency provisioner.
 *
 * Skills declare runtime dependencies in their `install:` frontmatter (npm / pip
 * packages). Historically that manifest was parsed but never acted on, so any
 * skill needing an external library (pptxgenjs, docx, openpyxl, ...) crashed on
 * first use with "Cannot find module" / "ModuleNotFoundError". This module makes
 * the manifest live: when a skill is activated we install its declared packages
 * into a shared runtime dir (`<moziHome>/skill-runtime`) which is placed on
 * NODE_PATH / PYTHONPATH for every shell command (see capabilities/shell.ts).
 *
 * Design notes:
 * - Idempotent: a marker file records provisioned specs; npm presence is also
 *   re-checked against node_modules so a wiped dir re-installs.
 * - Best-effort: install failures are logged and returned, never thrown — a
 *   provisioning miss must not break `use_skill` itself.
 * - Serialized: concurrent activations share one in-flight install chain to
 *   avoid two npm/pip writers racing on the same prefix.
 */

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import pino from 'pino';
import { getSkillRuntimeDir, getSkillNodeModulesDir, getSkillPythonDir } from '../paths.js';
import type { SkillInstallSpec } from './loader.js';

const logger = pino({ name: 'mozi:skills:provision' });

/** Max wall-clock for a single npm/pip install batch. */
const INSTALL_TIMEOUT_MS = 180_000;

const PYTHON_BIN = process.env.MOZI_PYTHON || process.env.PYTHON || 'python3';

export interface ProvisionResult {
  installed: string[];
  skipped: string[];
  failed: Array<{ package: string; error: string }>;
}

/** In-process record of specs already provisioned this run (fast path). */
const provisionedThisRun = new Set<string>();
/** Serialize install batches so two activations don't race the same prefix. */
let installChain: Promise<unknown> = Promise.resolve();

function markerPath(): string {
  return join(getSkillRuntimeDir(), '.provisioned.json');
}

function readMarker(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(markerPath(), 'utf8')) as Record<string, string>;
  } catch {
    return {};
  }
}

function writeMarker(marker: Record<string, string>): void {
  try {
    writeFileSync(markerPath(), JSON.stringify(marker, null, 2), 'utf8');
  } catch (err) {
    logger.warn({ err: String(err) }, 'failed to persist skill-runtime marker');
  }
}

/** npm package base dir name (strip any version/range: `foo@1.2` -> `foo`, keep scope). */
function npmDirName(pkg: string): string {
  const at = pkg.lastIndexOf('@');
  return at > 0 ? pkg.slice(0, at) : pkg;
}

function ensureRuntimeDir(): void {
  const dir = getSkillRuntimeDir();
  mkdirSync(dir, { recursive: true });
  const pkgJson = join(dir, 'package.json');
  if (!existsSync(pkgJson)) {
    // A private package.json stops npm from walking up to install elsewhere.
    writeFileSync(pkgJson, JSON.stringify({ name: 'mozi-skill-runtime', private: true }, null, 2), 'utf8');
  }
  mkdirSync(getSkillPythonDir(), { recursive: true });
}

function run(cmd: string, args: string[]): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolvePromise) => {
    execFile(cmd, args, { timeout: INSTALL_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        resolvePromise({ ok: false, output: `${stderr || ''}${err.message}`.slice(0, 500) });
      } else {
        resolvePromise({ ok: true, output: (stdout || '').slice(0, 200) });
      }
    });
  });
}

/**
 * Provision the npm/pip dependencies declared by a skill's `install:` manifest.
 * `brew` / `manual` kinds are skipped (cannot be auto-run safely) but surfaced
 * in the result so the caller can tell the Brain what still needs a human.
 */
export async function provisionSkillDependencies(
  specs: SkillInstallSpec[] | undefined,
): Promise<ProvisionResult> {
  const result: ProvisionResult = { installed: [], skipped: [], failed: [] };
  if (!specs || specs.length === 0) return result;

  const npmPkgs: string[] = [];
  const pipPkgs: string[] = [];
  for (const spec of specs) {
    if (!spec.package) continue;
    const key = `${spec.kind}:${spec.package}`;
    if (spec.kind === 'npm') {
      const present = provisionedThisRun.has(key) || existsSync(join(getSkillNodeModulesDir(), npmDirName(spec.package)));
      if (present) { result.skipped.push(spec.package); provisionedThisRun.add(key); }
      else npmPkgs.push(spec.package);
    } else if (spec.kind === 'pip') {
      if (provisionedThisRun.has(key)) result.skipped.push(spec.package);
      else pipPkgs.push(spec.package);
    } else {
      // brew / manual — cannot auto-provision; report as skipped.
      result.skipped.push(spec.package);
    }
  }

  if (npmPkgs.length === 0 && pipPkgs.length === 0) return result;

  // Chain onto any in-flight install so writers to the shared prefix serialize.
  const work = installChain.then(async () => {
    ensureRuntimeDir();
    const marker = readMarker();
    const stamp = new Date().toISOString();

    if (npmPkgs.length > 0) {
      logger.info({ packages: npmPkgs }, 'provisioning skill npm dependencies');
      const { ok, output } = await run('npm', [
        'install', '--prefix', getSkillRuntimeDir(),
        '--no-save', '--no-audit', '--no-fund', '--loglevel=error',
        ...npmPkgs,
      ]);
      for (const pkg of npmPkgs) {
        if (ok) { result.installed.push(pkg); provisionedThisRun.add(`npm:${pkg}`); marker[`npm:${pkg}`] = stamp; }
        else result.failed.push({ package: pkg, error: output });
      }
      if (!ok) logger.warn({ packages: npmPkgs, output }, 'npm provisioning failed');
    }

    if (pipPkgs.length > 0) {
      logger.info({ packages: pipPkgs }, 'provisioning skill pip dependencies');
      const { ok, output } = await run(PYTHON_BIN, [
        '-m', 'pip', 'install', '--target', getSkillPythonDir(),
        '--disable-pip-version-check', '--no-input', '--quiet',
        ...pipPkgs,
      ]);
      for (const pkg of pipPkgs) {
        if (ok) { result.installed.push(pkg); provisionedThisRun.add(`pip:${pkg}`); marker[`pip:${pkg}`] = stamp; }
        else result.failed.push({ package: pkg, error: output });
      }
      if (!ok) logger.warn({ packages: pipPkgs, output }, 'pip provisioning failed');
    }

    writeMarker(marker);
  });

  // Keep the chain alive even if this batch throws, so later calls still run.
  installChain = work.catch(() => undefined);
  await work.catch((err) => {
    logger.warn({ err: String(err) }, 'skill dependency provisioning errored');
  });
  return result;
}
