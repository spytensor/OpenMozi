import { spawn, type ChildProcess } from 'node:child_process';
import { basename, delimiter, isAbsolute, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import pino from 'pino';
import { SECRET_PATTERNS } from '../security/secrets.js';
import { getSkillNodeModulesDir, getSkillPythonDir } from '../paths.js';
import {
  expandHome,
  getFsPolicy,
  getWorkspaceAllowedRoots,
  getWorkspaceDir,
  isPathInsideRoot,
} from '../tools/workspace-policy.js';

const logger = pino({ name: 'mozi:capability:shell' });

// ---------------------------------------------------------------------------
// Environment sanitization — strip secret env vars from child processes
// ---------------------------------------------------------------------------

/** Cache sanitized env so we only compute it once per process. */
let _sanitizedEnv: Record<string, string> | null = null;

/** Env vars that prevent external AI CLIs from running inside MOZI subprocesses. */
const NESTED_CLI_VARS = new Set([
  'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT',
  'CODEX_CLI_SESSION', 'CODEX_SANDBOX_ACTIVE',
  'GEMINI_CLI_SESSION',
]);

function getSanitizedEnv(): Record<string, string> {
  if (_sanitizedEnv) return _sanitizedEnv;
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (SECRET_PATTERNS.some(p => p.test(key))) continue;
    if (NESTED_CLI_VARS.has(key)) continue;
    clean[key] = value;
  }
  // Put the shared skill-runtime dependency roots on the module resolution
  // paths so scripts the Brain writes can import packages provisioned from a
  // skill's install: manifest (see skills/provision-deps.ts) without a local
  // install in the working dir.
  clean.NODE_PATH = [getSkillNodeModulesDir(), clean.NODE_PATH].filter(Boolean).join(delimiter);
  clean.PYTHONPATH = [getSkillPythonDir(), clean.PYTHONPATH].filter(Boolean).join(delimiter);
  _sanitizedEnv = clean;
  return clean;
}

/** Invalidate cached sanitized env (e.g. after config reload). */
export function resetSanitizedEnvCache(): void {
  _sanitizedEnv = null;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ShellResult {
  stdout: string;
  stderr: string;
  exit_code: number;
  timed_out: boolean;
  blocked: boolean;
  elapsed_ms: number;
  executor: 'native' | 'docker';
  sandboxed: boolean;
  /** Present only when background=true */
  process_id?: string;
  /** OS PID, present only when background=true */
  pid?: number;
}

export interface ShellOptions {
  timeout?: number;       // Hard timeout in ms (default 60000)
  cwd?: string;           // Working directory
  restricted?: boolean;   // Enable blocked commands check
  networkIsolation?: boolean; // Block network-capable commands in restricted mode
  isolationMode?: 'docker' | 'native';
  dockerImage?: string;
  env?: Record<string, string>; // Additional env vars
  /** Spawn detached and return immediately with process_id */
  background?: boolean;
  /** Per-process ring buffer limit in bytes (default 10MB) */
  maxOutputBuffer?: number;
  /** Chat/session ID for lifecycle cleanup */
  chatId?: string;
  /** Tenant ID for lifecycle cleanup */
  tenantId?: string;
  /** Permission level from TEL/session context. L3 may bypass workspace path guards. */
  permissionLevel?: string;
  /**
   * Enforce tools.fs.workspace_only for registered shell tools. Direct internal
   * callers can opt in, but keep their historical explicit-cwd behavior by default.
   */
  enforceWorkspaceBoundary?: boolean;
  /** Effective filesystem roots supplied by TEL for this user/session. */
  allowedWorkspaceRoots?: string[];
}

export interface ShellExecFileOptions {
  timeout?: number;
  cwd?: string;
  env?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Background process registry
// ---------------------------------------------------------------------------

export type BgProcessStatus = 'running' | 'completed' | 'failed' | 'killed';

export interface ManagedBgProcess {
  id: string;
  process: ChildProcess;
  command: string;
  chatId: string;
  tenantId: string;
  startedAt: number;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  status: BgProcessStatus;
  maxOutputBuffer: number;
}

const bgProcesses = new Map<string, ManagedBgProcess>();

const DEFAULT_MAX_OUTPUT_BUFFER = 10 * 1024 * 1024; // 10MB

// ---------------------------------------------------------------------------
// Blocked commands (restricted mode)
// ---------------------------------------------------------------------------

const BLOCKED_PATTERNS: RegExp[] = [
  /\brm\s+(-\w*r\w*f|--recursive.*--force|-\w*f\w*r)\b/,
  /\brm\s+-rf\b/,
  /\bmkfs\b/,
  /\bdd\s+.*of=\/dev\//,
  /\b:(){ :\|:& };:/,              // Fork bomb
  /\bchmod\s+(-R\s+)?777\s+\//,
  /\bchown\s+.*\s+\/(?!tmp)/,
  /\b>\s*\/dev\/sd/,
  /\bshutdown\b/,
  /\breboot\b/,
  /\bhalt\b/,
  /\binit\s+0\b/,
  /\biptables\s+-F\b/,
];

const NETWORK_BLOCKED_PATTERNS: RegExp[] = [
  /\bcurl\b/,
  /\bwget\b/,
  /\bhttpie\b/,
  /\b(?:nc|ncat|netcat)\b/,
  /\btelnet\b/,
  /\b(?:ssh|scp|sftp)\b/,
  /\bping\b/,
  /\b(?:dig|nslookup|nmap)\b/,
  /\bftp\b/,
  /\bgit\s+(clone|fetch|pull|push)\b.*(?:https?:\/\/|git@|ssh:\/\/)/,
  /\b(?:npm|pnpm)\s+(?:install|i|ci|update|add|dlx)\b/,
  /\byarn\s+(?:add|install|up)\b/,
  /\b(?:pip|pip3)\s+install\b/,
  /\buv\s+pip\s+install\b/,
  /\bpoetry\s+add\b/,
  /\bcargo\s+add\b/,
  /\bgo\s+get\b/,
  /\bdocker\s+pull\b/,
  /\bbase64\s+(?:-d|--decode)\b.*\|\s*(?:sh|bash|zsh)\b/,
];

// High-risk = truly destructive. Normal dev ops (git, npm, curl) are NOT high-risk.
const HIGH_RISK_PATTERNS: RegExp[] = [
  /\brm\s+-rf\s+\//,            // rm -rf with absolute root path
  /\bmkfs\b/,
  /\bdd\s+.*of=\/dev\//,
  /\bshutdown\b/,
  /\breboot\b/,
  /\bchmod\s+(-R\s+)?777\s+\//,  // chmod 777 on root paths
];

const ALLOWED_COMMANDS = new Set([
  'awk',
  'bash',
  'cat',
  'chmod',
  'cp',
  'cut',
  'echo',
  'env',
  'find',
  'git',
  'grep',
  'head',
  'ls',
  'make',
  'mkdir',
  'mv',
  'node',
  'npm',
  'pnpm',
  'printf',
  'pwd',
  'rg',
  'sed',
  'sh',
  'sleep',
  'sort',
  'tail',
  'tee',
  'touch',
  'tr',
  'tsup',
  'uniq',
  'uv',
  'vitest',
  'wc',
  'xargs',
  'zsh',
  'python',
  'python3',
]);

const DEFAULT_DOCKER_IMAGE = 'alpine:3.20';
const SHELL_WORKSPACE_DENIAL = 'Shell is restricted to the workspace';

let dockerAvailability: 'unknown' | 'yes' | 'no' = 'unknown';
const dockerImageAvailability = new Map<string, boolean>();

function formatWorkspaceRestriction(roots: string[]): string {
  return `${SHELL_WORKSPACE_DENIAL}: ${roots.join(', ')}. Ask the user to widen access.`;
}

function resolveShellCwd(cwd?: string): string {
  const workspaceDir = getWorkspaceDir();
  if (!cwd || cwd.trim().length === 0) {
    return workspaceDir;
  }
  const expanded = expandHome(cwd);
  return resolve(isAbsolute(expanded) ? expanded : resolve(workspaceDir, expanded));
}

function shouldEnforceWorkspaceBoundary(options: ShellOptions): boolean {
  if (!options.enforceWorkspaceBoundary) return false;
  if (!getFsPolicy().workspaceOnly) return false;
  return (options.permissionLevel ?? 'L0_READ_ONLY') !== 'L3_FULL_ACCESS';
}

function extractCdTargets(command: string): string[] {
  const targets: string[] = [];
  const cdPattern = /(?:^|[;&|]\s*)cd\s+(?:--\s+)?(?:"([^"]*)"|'([^']*)'|([^\s;&|]+))/gi;
  let match: RegExpExecArray | null;
  while ((match = cdPattern.exec(command)) !== null) {
    const target = (match[1] ?? match[2] ?? match[3] ?? '').trim();
    if (target.length > 0) targets.push(target);
  }
  return targets;
}

function extractPathTokens(command: string): string[] {
  const tokens = new Set<string>();
  // Avoid treating URL paths (https://host/path) as local absolute paths.
  const withoutUrls = command.replace(/[a-z][a-z0-9+.-]*:\/\/[^\s"'`<>]+/gi, ' ');
  const pathPattern = /(?:^|[\s=:"'([{,;|&<>])((?:~|\/|\.\.?\/)[^\s"'`|;&)<>]*)/g;
  let match: RegExpExecArray | null;
  while ((match = pathPattern.exec(withoutUrls)) !== null) {
    const raw = (match[1] ?? '').trim();
    if (!raw || raw === '/' || raw === '~') {
      tokens.add(raw);
      continue;
    }
    tokens.add(raw.replace(/[,.]+$/g, ''));
  }
  return Array.from(tokens).filter(Boolean);
}

function resolveCommandPathToken(token: string, cwd: string): string | null {
  const expanded = expandHome(token);
  if (isAbsolute(expanded)) return resolve(expanded);
  if (expanded.startsWith('../') || expanded.startsWith('./') || expanded.includes('/../')) {
    return resolve(cwd, expanded);
  }
  return null;
}

function validateShellWorkspaceBoundary(command: string, cwd: string, options: ShellOptions): string | null {
  if (!shouldEnforceWorkspaceBoundary(options)) return null;
  const roots = options.allowedWorkspaceRoots && options.allowedWorkspaceRoots.length > 0
    ? options.allowedWorkspaceRoots
    : getWorkspaceAllowedRoots();
  const denial = formatWorkspaceRestriction(roots);
  const isAllowed = (path: string) => roots.some(root => isPathInsideRoot(path, root));

  if (!isAllowed(cwd)) {
    logger.warn({
      command: command.slice(0, 200),
      cwd,
      allowed_roots: roots,
      permission_level: options.permissionLevel ?? 'L0_READ_ONLY',
      reason: 'cwd_outside_workspace',
    }, 'Blocked shell command outside workspace boundary');
    return denial;
  }

  // Best-effort string guard only. This is not a sandbox and cannot stop a
  // deliberately adversarial shell payload; it blocks accidental absolute-path
  // and path-traversal escapes until a real process sandbox is available.
  for (const target of extractCdTargets(command)) {
    const resolvedTarget = resolveCommandPathToken(target, cwd) ?? resolve(cwd, target);
    if (!isAllowed(resolvedTarget)) {
      logger.warn({
        command: command.slice(0, 200),
        cwd,
        cd_target: target,
        resolved_target: resolvedTarget,
        allowed_roots: roots,
        permission_level: options.permissionLevel ?? 'L0_READ_ONLY',
        reason: 'cd_target_outside_workspace',
      }, 'Blocked shell cd outside workspace boundary');
      return denial;
    }
  }

  for (const token of extractPathTokens(command)) {
    const resolvedPath = resolveCommandPathToken(token, cwd);
    if (resolvedPath && !isAllowed(resolvedPath)) {
      logger.warn({
        command: command.slice(0, 200),
        cwd,
        path_token: token,
        resolved_path: resolvedPath,
        allowed_roots: roots,
        permission_level: options.permissionLevel ?? 'L0_READ_ONLY',
        reason: 'path_token_outside_workspace',
      }, 'Blocked shell command path outside workspace boundary');
      return denial;
    }
  }

  return null;
}

function blockedShellResult(message: string, executor: 'native' | 'docker' = 'native'): ShellResult {
  return {
    stdout: '',
    stderr: message,
    exit_code: -1,
    timed_out: false,
    blocked: true,
    elapsed_ms: 0,
    executor,
    sandboxed: false,
  };
}

/** Check if a command matches any blocked pattern */
function isBlocked(command: string): boolean {
  return BLOCKED_PATTERNS.some((pattern) => pattern.test(command));
}

/** Check if a command appears to perform network access. */
function isNetworkCommand(command: string): boolean {
  return NETWORK_BLOCKED_PATTERNS.some((pattern) => pattern.test(command));
}

export function isHighRiskCommand(command: string): boolean {
  return HIGH_RISK_PATTERNS.some((pattern) => pattern.test(command));
}

function extractPrimaryCommand(command: string): string | null {
  const trimmed = command.trim();
  if (!trimmed) return null;

  const assignmentRegex = /^[A-Za-z_][A-Za-z0-9_]*=.*/;
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  let index = 0;
  while (index < tokens.length && assignmentRegex.test(tokens[index])) {
    index += 1;
  }

  let candidate = tokens[index] ?? '';
  if (!candidate) return null;
  if (candidate === 'sudo') {
    candidate = tokens[index + 1] ?? '';
  }
  if (!candidate) return null;
  return basename(candidate);
}

function isAllowedCommand(command: string): boolean {
  const primary = extractPrimaryCommand(command);
  if (!primary) return false;
  return ALLOWED_COMMANDS.has(primary);
}

function runCommand(
  executable: string,
  args: string[],
  options: {
    timeout: number;
    cwd?: string;
    env?: Record<string, string>;
    executor: 'native' | 'docker';
    sandboxed: boolean;
  },
): Promise<ShellResult> {
  const startTime = Date.now();
  return new Promise<ShellResult>((resolvePromise) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: { ...getSanitizedEnv(), ...options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let resolved = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, options.timeout);

    child.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
    child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });

    const finish = (exitCode: number | null) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      resolvePromise({
        stdout,
        stderr,
        exit_code: exitCode ?? -1,
        timed_out: timedOut,
        blocked: false,
        elapsed_ms: Date.now() - startTime,
        executor: options.executor,
        sandboxed: options.sandboxed,
      });
    };

    child.on('close', (code) => finish(code));
    child.on('error', (err) => {
      stderr += err.message;
      finish(-1);
    });
  });
}

function checkDockerAvailability(): Promise<boolean> {
  if (dockerAvailability === 'yes') return Promise.resolve(true);
  if (dockerAvailability === 'no') return Promise.resolve(false);

  return new Promise<boolean>((resolvePromise) => {
    const probe = spawn('docker', ['version', '--format', '{{.Server.Version}}'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let finished = false;
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      dockerAvailability = 'no';
      try { probe.kill('SIGKILL'); } catch { /* noop */ }
      resolvePromise(false);
    }, 1500);

    probe.on('close', (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      const available = code === 0;
      dockerAvailability = available ? 'yes' : 'no';
      resolvePromise(available);
    });

    probe.on('error', () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      dockerAvailability = 'no';
      resolvePromise(false);
    });
  });
}

function checkDockerImageAvailability(image: string): Promise<boolean> {
  if (dockerImageAvailability.has(image)) {
    return Promise.resolve(Boolean(dockerImageAvailability.get(image)));
  }

  return new Promise<boolean>((resolvePromise) => {
    const probe = spawn('docker', ['image', 'inspect', image], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });

    let finished = false;
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      dockerImageAvailability.set(image, false);
      try { probe.kill('SIGKILL'); } catch { /* noop */ }
      resolvePromise(false);
    }, 1500);

    probe.on('close', (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      const available = code === 0;
      dockerImageAvailability.set(image, available);
      resolvePromise(available);
    });

    probe.on('error', () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      dockerImageAvailability.set(image, false);
      resolvePromise(false);
    });
  });
}

async function runInDockerSandbox(command: string, options: ShellOptions & { timeout: number }): Promise<ShellResult> {
  const hostCwd = resolveShellCwd(options.cwd);
  const dockerImage = options.dockerImage ?? process.env.MOZI_SHELL_DOCKER_IMAGE ?? DEFAULT_DOCKER_IMAGE;
  const args = [
    'run',
    '--rm',
    '--pull', 'never',
    '--network', 'none',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--read-only',
    '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=64m',
    '--tmpfs', '/var/tmp:rw,noexec,nosuid,nodev,size=64m',
    '--pids-limit', '128',
    '--memory', '512m',
    '--cpus', '1',
    '--user', '65534:65534',
    '-v', `${hostCwd}:${hostCwd}`,
    '-w', hostCwd,
    dockerImage,
    'sh',
    '-lc',
    command,
  ];
  return runCommand('docker', args, {
    timeout: options.timeout,
    cwd: hostCwd,
    env: options.env,
    executor: 'docker',
    sandboxed: true,
  });
}

// ---------------------------------------------------------------------------
// Background process API
// ---------------------------------------------------------------------------

/** Append to a ring buffer, capping at maxLen bytes. */
function ringAppend(current: string, chunk: string, maxLen: number): string {
  const combined = current + chunk;
  if (combined.length <= maxLen) return combined;
  return combined.slice(combined.length - maxLen);
}

/** Spawn a detached background process and register it. */
export function execBackground(
  command: string,
  options: { cwd?: string; env?: Record<string, string>; maxOutputBuffer?: number; chatId?: string; tenantId?: string } = {},
): { process_id: string; pid: number | undefined } {
  const id = randomUUID();
  const maxBuf = options.maxOutputBuffer ?? DEFAULT_MAX_OUTPUT_BUFFER;
  const cwd = resolveShellCwd(options.cwd);

  const child = spawn('sh', ['-c', command], {
    cwd,
    env: { ...getSanitizedEnv(), ...options.env },
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: false, // keep in same process group for cleanup
  });

  const managed: ManagedBgProcess = {
    id,
    process: child,
    command,
    chatId: options.chatId ?? '',
    tenantId: options.tenantId ?? 'default',
    startedAt: Date.now(),
    stdout: '',
    stderr: '',
    exitCode: null,
    status: 'running',
    maxOutputBuffer: maxBuf,
  };

  child.stdout?.on('data', (data: Buffer) => {
    managed.stdout = ringAppend(managed.stdout, data.toString(), maxBuf);
  });

  child.stderr?.on('data', (data: Buffer) => {
    managed.stderr = ringAppend(managed.stderr, data.toString(), maxBuf);
  });

  child.on('close', (code) => {
    managed.exitCode = code;
    managed.status = (code === 0) ? 'completed' : 'failed';
    logger.info({ process_id: id, command: command.slice(0, 80), exit_code: code }, 'Background process exited');
  });

  child.on('error', (err) => {
    managed.stderr = ringAppend(managed.stderr, err.message, maxBuf);
    managed.exitCode = -1;
    managed.status = 'failed';
    logger.warn({ process_id: id, err: err.message }, 'Background process error');
  });

  bgProcesses.set(id, managed);
  logger.info({ process_id: id, pid: child.pid, command: command.slice(0, 80) }, 'Background process started');

  return { process_id: id, pid: child.pid };
}

/** Get the status of a background process. */
export function getProcessStatus(processId: string): {
  status: BgProcessStatus;
  exit_code: number | null;
  elapsed_ms: number;
  pid: number | undefined;
  command: string;
} | null {
  const proc = bgProcesses.get(processId);
  if (!proc) return null;
  return {
    status: proc.status,
    exit_code: proc.exitCode,
    elapsed_ms: Date.now() - proc.startedAt,
    pid: proc.process.pid,
    command: proc.command,
  };
}

/** Get stdout/stderr output of a background process. */
export function getProcessOutput(processId: string, tailLines?: number): {
  stdout: string;
  stderr: string;
} | null {
  const proc = bgProcesses.get(processId);
  if (!proc) return null;

  let stdout = proc.stdout;
  let stderr = proc.stderr;

  if (tailLines && tailLines > 0) {
    stdout = stdout.split('\n').slice(-tailLines).join('\n');
    stderr = stderr.split('\n').slice(-tailLines).join('\n');
  }

  return { stdout, stderr };
}

/** Send input to a background process's stdin. */
export function sendProcessInput(processId: string, input: string): { ok: boolean; error?: string } {
  const proc = bgProcesses.get(processId);
  if (!proc) return { ok: false, error: `Process ${processId} not found` };
  if (proc.status !== 'running') return { ok: false, error: `Process ${processId} is ${proc.status}` };
  if (!proc.process.stdin?.writable) return { ok: false, error: 'stdin is not writable' };

  try {
    proc.process.stdin.write(input);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Kill a background process. */
export function killProcess(processId: string, signal: NodeJS.Signals = 'SIGTERM'): { killed: boolean; error?: string } {
  const proc = bgProcesses.get(processId);
  if (!proc) return { killed: false, error: `Process ${processId} not found` };
  if (proc.status !== 'running') return { killed: false, error: `Process ${processId} is already ${proc.status}` };

  try {
    proc.process.kill(signal);
    proc.status = 'killed';
    proc.exitCode = -1;
    return { killed: true };
  } catch (err) {
    return { killed: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Kill all background processes, optionally filtered by chatId and/or tenantId. */
export function killAllProcesses(chatId?: string, tenantId?: string): number {
  let killed = 0;
  for (const [id, proc] of bgProcesses) {
    if (chatId && proc.chatId !== chatId) continue;
    if (tenantId && proc.tenantId !== tenantId) continue;
    if (proc.status === 'running') {
      try {
        proc.process.kill('SIGKILL');
        proc.status = 'killed';
        proc.exitCode = -1;
        killed++;
      } catch {
        // process may have already exited
      }
    }
    // Clean up completed/failed/killed entries
    bgProcesses.delete(id);
  }
  if (killed > 0) {
    logger.info({ killed, chatId, tenantId }, 'Killed background processes');
  }
  return killed;
}

/** Get count of currently running background processes. */
export function getRunningProcessCount(): number {
  let count = 0;
  for (const proc of bgProcesses.values()) {
    if (proc.status === 'running') count++;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Execute a shell command with timeout and restriction support */
export async function exec(command: string, options: ShellOptions = {}): Promise<ShellResult> {
  const timeout = options.timeout ?? 60_000;
  const cwd = resolveShellCwd(options.cwd);
  const workspaceBoundaryError = validateShellWorkspaceBoundary(command, cwd, options);
  if (workspaceBoundaryError) {
    return blockedShellResult(workspaceBoundaryError);
  }

  // Background mode: run restricted/blocked checks, then spawn detached
  if (options.background) {
    // Apply the same security checks as synchronous mode
    if (options.restricted && isBlocked(command)) {
      return {
        stdout: '', stderr: `Command blocked by restricted mode: ${command}`,
        exit_code: -1, timed_out: false, blocked: true, elapsed_ms: 0,
        executor: 'native', sandboxed: false,
      };
    }
    if (options.restricted && options.networkIsolation && isNetworkCommand(command)) {
      return {
        stdout: '', stderr: `Command blocked by network isolation policy: ${command}`,
        exit_code: -1, timed_out: false, blocked: true, elapsed_ms: 0,
        executor: 'native', sandboxed: false,
      };
    }
    if (options.restricted && !isAllowedCommand(command)) {
      const primary = extractPrimaryCommand(command) ?? 'unknown';
      return {
        stdout: '', stderr: `Command blocked by restricted allowlist policy: ${primary}`,
        exit_code: -1, timed_out: false, blocked: true, elapsed_ms: 0,
        executor: 'native', sandboxed: false,
      };
    }

    const result = execBackground(command, {
      cwd,
      env: options.env,
      maxOutputBuffer: options.maxOutputBuffer,
      chatId: options.chatId,
      tenantId: options.tenantId,
    });

    return {
      stdout: `Background process started.\nprocess_id: ${result.process_id}\nStatus: running\n\nUse process_status with this process_id to check completion, then process_output to read results.`,
      stderr: '',
      exit_code: 0,
      timed_out: false,
      blocked: false,
      elapsed_ms: 0,
      executor: 'native',
      sandboxed: false,
      process_id: result.process_id,
      pid: result.pid,
    };
  }

  // Restricted mode check
  if (options.restricted && isBlocked(command)) {
    logger.warn({ command }, 'Blocked command in restricted mode');
    return {
      stdout: '',
      stderr: `Command blocked by restricted mode: ${command}`,
      exit_code: -1,
      timed_out: false,
      blocked: true,
      elapsed_ms: 0,
      executor: 'native',
      sandboxed: false,
    };
  }

  if (options.restricted && options.networkIsolation && isNetworkCommand(command)) {
    logger.warn({ command }, 'Blocked network command in restricted mode');
    return {
      stdout: '',
      stderr: `Command blocked by network isolation policy: ${command}`,
      exit_code: -1,
      timed_out: false,
      blocked: true,
      elapsed_ms: 0,
      executor: 'native',
      sandboxed: false,
    };
  }

  if (options.restricted && !isAllowedCommand(command)) {
    const primary = extractPrimaryCommand(command) ?? 'unknown';
    logger.warn({ command, primary }, 'Blocked command not in allowlist');
    return {
      stdout: '',
      stderr: `Command blocked by restricted allowlist policy: ${primary}`,
      exit_code: -1,
      timed_out: false,
      blocked: true,
      elapsed_ms: 0,
      executor: 'native',
      sandboxed: false,
    };
  }

  const isolationMode = options.isolationMode ?? (options.restricted ? 'docker' : 'native');
  if (isolationMode === 'docker') {
    const dockerImage = options.dockerImage ?? process.env.MOZI_SHELL_DOCKER_IMAGE ?? DEFAULT_DOCKER_IMAGE;
    const dockerReady = await checkDockerAvailability();
    if (dockerReady && await checkDockerImageAvailability(dockerImage)) {
      const result = await runInDockerSandbox(command, { ...options, timeout });
      logger.debug({ command, exit_code: result.exit_code, timed_out: result.timed_out, elapsed_ms: result.elapsed_ms }, 'Shell command completed in docker sandbox');
      return result;
    }
    if (options.restricted) {
      // restricted mode already applied blocked pattern checks above — safe to use native
      logger.warn({ command, docker_image: dockerImage }, 'Docker sandbox unavailable; falling back to restricted native executor');
    } else {
      // Docker explicitly requested but unavailable — block execution
      logger.error({ command, docker_image: dockerImage }, 'Docker sandbox unavailable and no restricted fallback; blocking execution');
      return {
        stdout: '',
        stderr: 'Docker sandbox is unavailable. Cannot execute without sandboxing.',
        exit_code: 1,
        timed_out: false,
        blocked: true,
        elapsed_ms: 0,
        executor: 'docker' as const,
        sandboxed: false,
      };
    }
  }

  const result = await runCommand('sh', ['-c', command], {
    timeout,
    cwd,
    env: options.env,
    executor: 'native',
    sandboxed: false,
  });
  logger.debug({ command, exit_code: result.exit_code, timed_out: result.timed_out, elapsed_ms: result.elapsed_ms }, 'Shell command completed in native executor');
  return result;
}

/** Execute a native binary with argv semantics while reusing shell timeout/env handling. */
export function execFile(executable: string, args: string[], options: ShellExecFileOptions = {}): Promise<ShellResult> {
  return runCommand(executable, args, {
    timeout: options.timeout ?? 60_000,
    cwd: resolveShellCwd(options.cwd),
    env: options.env,
    executor: 'native',
    sandboxed: false,
  });
}
