/**
 * Docker-based session sandboxing (#241)
 *
 * Creates ephemeral containers per session with:
 *  - user workspace mounted read-write
 *  - memory + CPU limits
 *  - no network by default
 *  - read-only root filesystem
 *
 * Falls back gracefully to native execution when Docker is unavailable.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import pino from 'pino';
import { getUserWorkspacePath } from './workspace.js';
import type { ResourceLimits } from './limits.js';
import { DEFAULT_LIMITS } from './limits.js';

const execFileAsync = promisify(execFile);
const logger = pino({ name: 'mozi:sandbox:docker' });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ContainerOptions {
  /** Resource limits to apply. Defaults to DEFAULT_LIMITS. */
  limits?: Partial<ResourceLimits>;
  /** Container image to use. Defaults to 'alpine:3.19'. */
  image?: string;
  /** Whether to enable network. Overrides limits.network_enabled. */
  networkEnabled?: boolean;
  /** Extra environment variables for the container. */
  env?: Record<string, string>;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

// ---------------------------------------------------------------------------
// Docker availability
// ---------------------------------------------------------------------------

let dockerAvailable: boolean | null = null;

/**
 * Check if Docker CLI is available on this host.
 * Result is cached after first call.
 */
export async function isDockerAvailable(): Promise<boolean> {
  if (dockerAvailable !== null) return dockerAvailable;
  try {
    await execFileAsync('docker', ['info', '--format', '{{.ServerVersion}}']);
    dockerAvailable = true;
  } catch {
    dockerAvailable = false;
    logger.warn('Docker unavailable — container sandboxing disabled, falling back to native');
  }
  return dockerAvailable;
}

/** Reset the cached Docker availability (for tests). */
export function resetDockerAvailabilityCache(): void {
  dockerAvailable = null;
}

// ---------------------------------------------------------------------------
// Container lifecycle
// ---------------------------------------------------------------------------

/**
 * Create a sandboxed container for a user session.
 * Returns the container ID (64-char hex string).
 *
 * Falls back to returning null if Docker is unavailable
 * (caller should use native execution in that case).
 */
export async function createSessionContainer(
  userId: string,
  sessionId: string,
  opts: ContainerOptions = {},
): Promise<string | null> {
  if (!(await isDockerAvailable())) return null;

  const limits: ResourceLimits = { ...DEFAULT_LIMITS, ...opts.limits };
  const image = opts.image ?? 'alpine:3.19';
  const networkEnabled = opts.networkEnabled ?? limits.network_enabled;
  const workspacePath = getUserWorkspacePath(userId);

  const args: string[] = [
    'create',
    '--name', `mozi-${sessionId}`,
    '--rm',                                // auto-remove when stopped
    '--read-only',                         // read-only root FS
    '--security-opt', 'no-new-privileges', // prevent privilege escalation
    '--cap-drop', 'ALL',                   // drop all Linux capabilities
    '--memory', `${limits.memory_mb}m`,
    '--memory-swap', `${limits.memory_mb}m`, // disable swap
    '--cpu-shares', String(limits.cpu_shares),
    '--pids-limit', String(limits.max_processes),
    '--volume', `${workspacePath}:/workspace:rw`,
    '--workdir', '/workspace',
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m',
  ];

  if (!networkEnabled) {
    args.push('--network', 'none');
  }

  // Inject env vars
  for (const [k, v] of Object.entries(opts.env ?? {})) {
    args.push('--env', `${k}=${v}`);
  }

  args.push(image, 'sleep', 'infinity');

  const { stdout } = await execFileAsync('docker', args);
  const containerId = stdout.trim();
  logger.info({ userId, sessionId, containerId, image }, 'container created');

  // Start the container
  await execFileAsync('docker', ['start', containerId]);

  return containerId;
}

/**
 * Execute a shell command inside a running container.
 * Returns stdout, stderr, and exit code.
 */
export async function execInContainer(
  containerId: string,
  command: string,
  timeoutMs = 30_000,
): Promise<ExecResult> {
  try {
    const { stdout, stderr } = await execFileAsync(
      'docker',
      ['exec', containerId, 'sh', '-c', command],
      { timeout: timeoutMs },
    );
    return { stdout, stderr, exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? String(err),
      exitCode: e.code ?? 1,
    };
  }
}

/**
 * Stop and remove a container.
 * Safe to call even if the container has already exited.
 */
export async function destroyContainer(containerId: string): Promise<void> {
  try {
    await execFileAsync('docker', ['rm', '-f', containerId]);
    logger.debug({ containerId }, 'container destroyed');
  } catch (err) {
    // Container may already be gone — log and continue
    logger.debug({ containerId, err }, 'destroyContainer: container not found or already removed');
  }
}
