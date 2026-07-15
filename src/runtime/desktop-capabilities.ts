import { execFile } from 'node:child_process';
import { constants, existsSync, accessSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { resolveNativeOfficeEnvironment } from '../artifacts/office-native.js';

const execFileAsync = promisify(execFile);
const DOCUMENT_MODULES = ['docx', 'openpyxl', 'pptx', 'pdfplumber', 'reportlab', 'PIL', 'numpy', 'pandas'];

export interface DesktopCommandProbe {
  (command: string, args: string[], timeoutMs?: number): Promise<boolean>;
}

export function resolveExecutable(command: string, pathValue = process.env.PATH ?? ''): string | null {
  const candidates = isAbsolute(command)
    ? [command]
    : pathValue.split(delimiter).filter(Boolean).map((entry) => join(entry, command));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue searching PATH.
    }
  }
  return null;
}

async function defaultProbe(command: string, args: string[], timeoutMs = 3_000): Promise<boolean> {
  try {
    await execFileAsync(command, args, { timeout: timeoutMs, maxBuffer: 256 * 1024 });
    return true;
  } catch {
    return false;
  }
}

export async function buildDesktopCapabilitySnapshot(options: {
  env?: NodeJS.ProcessEnv;
  probe?: DesktopCommandProbe;
  fetchImpl?: typeof fetch;
} = {}) {
  const env = options.env ?? process.env;
  const pathValue = env.PATH ?? '';
  const probe = options.probe ?? defaultProbe;
  const fetchImpl = options.fetchImpl ?? fetch;
  const binaries = Object.fromEntries(
    ['git', 'python3', 'soffice', 'pdftoppm', 'pdftotext', 'pdfimages', 'docker', 'codex', 'claude', 'gemini', 'node', 'pnpm']
      .map((name) => [name, resolveExecutable(name, pathValue)]),
  ) as Record<string, string | null>;

  // Avoid launching every cold CLI at once. Python's document stack and
  // LibreOffice both perform substantial first-run loading on Finder launch;
  // probing them concurrently can make healthy tools time out each other.
  const pythonModules = binaries.python3
    ? await probe(binaries.python3, ['-c', `import ${DOCUMENT_MODULES.join(', ')}`], 20_000)
    : false;
  const sofficeUsable = binaries.soffice
    ? await probe(binaries.soffice, ['--headless', '--version'], 5_000)
    : false;
  const [popplerUsable, dockerDaemon, codexUsable, claudeUsable, geminiUsable] = await Promise.all([
    binaries.pdftoppm ? probe(binaries.pdftoppm, ['-v'], 3_000) : false,
    binaries.docker ? probe(binaries.docker, ['version', '--format', '{{.Server.Version}}'], 3_000) : false,
    binaries.codex ? probe(binaries.codex, ['--version'], 3_000) : false,
    binaries.claude ? probe(binaries.claude, ['--version'], 3_000) : false,
    binaries.gemini ? probe(binaries.gemini, ['--version'], 3_000) : false,
  ]);

  const office = resolveNativeOfficeEnvironment(env);
  let officeAvailable = false;
  let officeReason = office ? 'health_unreachable' : 'not_configured';
  if (office) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2_000);
    try {
      const response = await fetchImpl(`${office.internalUrl}/healthcheck`, { signal: controller.signal, redirect: 'error' });
      officeAvailable = response.ok;
      officeReason = response.ok ? 'healthy' : `health_http_${response.status}`;
    } catch (error) {
      officeReason = error instanceof Error && error.name === 'AbortError' ? 'health_timeout' : 'health_unreachable';
    } finally {
      clearTimeout(timeout);
    }
  }

  const workerCredentialPaths = {
    codex: join(homedir(), '.codex', 'auth.json'),
    claude: join(homedir(), '.claude', '.credentials.json'),
    gemini: join(homedir(), '.gemini', 'oauth_creds.json'),
  };

  return {
    generated_at: new Date().toISOString(),
    desktop_mode: env.MOZI_DESKTOP === '1',
    path_entries: pathValue.split(delimiter).filter(Boolean),
    native: {
      binaries,
      binary_checks: { soffice: sofficeUsable, poppler: popplerUsable },
      document_python_modules: pythonModules,
      document_generation: Boolean(binaries.python3 && pythonModules),
      document_preview: sofficeUsable && popplerUsable,
      desktop_control: process.platform === 'darwin',
    },
    managed_workers: {
      codex: { ready: Boolean(codexUsable && existsSync(workerCredentialPaths.codex)), command: binaries.codex, credential_path: workerCredentialPaths.codex },
      claude: { ready: Boolean(claudeUsable && existsSync(workerCredentialPaths.claude)), command: binaries.claude, credential_path: workerCredentialPaths.claude },
      gemini: { ready: Boolean(geminiUsable && existsSync(workerCredentialPaths.gemini)), command: binaries.gemini, credential_path: workerCredentialPaths.gemini },
    },
    enhanced: {
      docker: { available: dockerDaemon, command: binaries.docker, mode: dockerDaemon ? 'enhanced' : 'unavailable' },
      office: {
        configured: Boolean(office),
        available: officeAvailable,
        engine: office ? 'onlyoffice' : null,
        mode: officeAvailable ? 'enhanced' : 'fallback',
        reason: officeReason,
      },
    },
  };
}
