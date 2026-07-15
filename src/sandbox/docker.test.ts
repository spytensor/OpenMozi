/**
 * Unit tests for Docker sandboxing (#241)
 * Uses mocked Docker CLI — no real containers.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Mock execFile so we never touch a real Docker daemon
vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));
vi.mock('node:util', () => ({
  promisify: (fn: unknown) => fn,
}));

import { execFile } from 'node:child_process';
import {
  isDockerAvailable,
  resetDockerAvailabilityCache,
  createSessionContainer,
  execInContainer,
  destroyContainer,
} from './docker.js';

let tmpBase: string;
const mockExecFile = execFile as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  tmpBase = mkdtempSync(join(tmpdir(), 'mozi-docker-'));
  process.env.MOZI_WORKSPACES = tmpBase;
  resetDockerAvailabilityCache();
  mockExecFile.mockReset();
});

afterEach(() => {
  delete process.env.MOZI_WORKSPACES;
  rmSync(tmpBase, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// isDockerAvailable
// ---------------------------------------------------------------------------

describe('isDockerAvailable()', () => {
  it('returns true when docker info succeeds', async () => {
    mockExecFile.mockResolvedValueOnce({ stdout: '24.0.0', stderr: '' });
    expect(await isDockerAvailable()).toBe(true);
  });

  it('returns false when docker info fails', async () => {
    mockExecFile.mockRejectedValueOnce(new Error('not found'));
    expect(await isDockerAvailable()).toBe(false);
  });

  it('caches the result', async () => {
    mockExecFile.mockResolvedValueOnce({ stdout: '24.0.0', stderr: '' });
    await isDockerAvailable();
    await isDockerAvailable();
    expect(mockExecFile).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// createSessionContainer
// ---------------------------------------------------------------------------

describe('createSessionContainer()', () => {
  it('returns null when Docker unavailable', async () => {
    mockExecFile.mockRejectedValueOnce(new Error('not found'));
    const id = await createSessionContainer('user-1', 'sess-1');
    expect(id).toBeNull();
  });

  it('calls docker create + start and returns container id', async () => {
    mockExecFile
      .mockResolvedValueOnce({ stdout: '24.0.0', stderr: '' })     // docker info
      .mockResolvedValueOnce({ stdout: 'abc123\n', stderr: '' })   // docker create
      .mockResolvedValueOnce({ stdout: 'abc123\n', stderr: '' });  // docker start

    const id = await createSessionContainer('user-1', 'sess-1');
    expect(id).toBe('abc123');
    // Verify docker create was called with --memory, --read-only, etc.
    const createCall = mockExecFile.mock.calls[1];
    const createArgs: string[] = createCall[1];
    expect(createArgs).toContain('create');
    expect(createArgs).toContain('--read-only');
    expect(createArgs).toContain('--network');
    expect(createArgs).toContain('none');
  });

  it('includes network flag when networkEnabled=true', async () => {
    mockExecFile
      .mockResolvedValueOnce({ stdout: '24.0.0', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'net-cont\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' });

    await createSessionContainer('user-1', 'sess-net', { networkEnabled: true });
    const createArgs: string[] = mockExecFile.mock.calls[1][1];
    expect(createArgs).not.toContain('none');
  });
});

// ---------------------------------------------------------------------------
// execInContainer
// ---------------------------------------------------------------------------

describe('execInContainer()', () => {
  it('returns stdout, stderr, exitCode 0 on success', async () => {
    mockExecFile.mockResolvedValueOnce({ stdout: 'hello\n', stderr: '' });
    const result = await execInContainer('abc123', 'echo hello');
    expect(result).toEqual({ stdout: 'hello\n', stderr: '', exitCode: 0 });
  });

  it('returns exitCode 1 on failure', async () => {
    mockExecFile.mockRejectedValueOnce(
      Object.assign(new Error('exit 1'), { stdout: '', stderr: 'error msg', code: 1 }),
    );
    const result = await execInContainer('abc123', 'false');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('error msg');
  });
});

// ---------------------------------------------------------------------------
// destroyContainer
// ---------------------------------------------------------------------------

describe('destroyContainer()', () => {
  it('calls docker rm -f', async () => {
    mockExecFile.mockResolvedValueOnce({ stdout: '', stderr: '' });
    await destroyContainer('abc123');
    expect(mockExecFile).toHaveBeenCalledWith('docker', ['rm', '-f', 'abc123']);
  });

  it('does not throw if container is already gone', async () => {
    mockExecFile.mockRejectedValueOnce(new Error('No such container'));
    await expect(destroyContainer('ghost')).resolves.toBeUndefined();
  });
});
