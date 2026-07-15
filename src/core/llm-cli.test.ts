import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { CliBackendConfig } from './providers.js';

const hoisted = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  calls: [] as Array<{ command: string; args: string[] }>,
  responses: [] as Array<{ stdout: string; stderr: string; exitCode: number }>,
}));

vi.mock('node:child_process', () => ({
  spawn: hoisted.spawnMock,
}));

import { createCliAdapter } from './llm-cli.js';

function makeProc(command: string, args: string[]): EventEmitter & {
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: PassThrough;
} {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    stdin: PassThrough;
  };
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.stdin = new PassThrough();

  hoisted.calls.push({ command, args: [...args] });
  const response = hoisted.responses.shift() ?? {
    stdout: '{"type":"item.completed","item":{"type":"agent_message","text":"OK"}}\n',
    stderr: '',
    exitCode: 0,
  };

  queueMicrotask(() => {
    if (response.stdout) proc.stdout.write(response.stdout);
    proc.stdout.end();
    if (response.stderr) proc.stderr.write(response.stderr);
    proc.stderr.end();
    proc.emit('close', response.exitCode);
  });

  return proc;
}

describe('core/llm-cli', () => {
  beforeEach(() => {
    hoisted.calls.length = 0;
    hoisted.responses.length = 0;
    hoisted.spawnMock.mockReset();
    hoisted.spawnMock.mockImplementation((command: string, args: string[]) => makeProc(command, args));
  });

  it('encodes codex system prompt using developer_instructions config key', async () => {
    const backend: CliBackendConfig = {
      command: 'codex',
      args: ['exec', '--json', '--color', 'never'],
      input: 'arg',
      output: 'jsonl',
      modelArg: '--model',
      fixedModel: 'gpt-5.3-codex',
      systemPromptArg: '-c',
      systemPromptFormat: 'codex-config-instructions',
      systemPromptWhen: 'always',
      sessionMode: 'none',
    };

    const client = createCliAdapter('codex-cli', 'gpt-5.3-codex', backend);
    const response = await client.chat([
      { role: 'system', content: 'You are a strict runtime policy.' },
      { role: 'user', content: 'Reply with OK.' },
    ], { model: 'gpt-5.3-codex' });

    expect(response.content).toBe('OK');
    expect(hoisted.calls.length).toBe(1);
    const call = hoisted.calls[0];
    const cfgIdx = call.args.indexOf('-c');
    expect(cfgIdx).toBeGreaterThanOrEqual(0);
    const cfg = call.args[cfgIdx + 1];
    expect(cfg).toBe('developer_instructions="You are a strict runtime policy."');
    expect(cfg.startsWith('instructions=')).toBe(false);
  });

  it('ignores stale cached session IDs when backend sessionMode is none', async () => {
    const sessionBackend: CliBackendConfig = {
      command: 'claude',
      args: ['-p', '--output-format', 'json'],
      resumeArgs: ['-p', '--output-format', 'json', '--resume'],
      input: 'arg',
      output: 'json',
      modelArg: '--model',
      sessionArg: '--session-id',
      sessionMode: 'existing',
      sessionIdFields: ['conversation_id'],
    };

    hoisted.responses.push(
      { stdout: '{"result":"seeded","conversation_id":"sess-123"}\n', stderr: '', exitCode: 0 },
      { stdout: '{"result":"fresh"}\n', stderr: '', exitCode: 0 },
    );

    const seededClient = createCliAdapter('claude-cli', 'claude-sonnet-4-6', sessionBackend);
    await seededClient.chat(
      [{ role: 'user', content: 'seed session' }],
      { model: 'claude-sonnet-4-6', cliSessionKey: 'chat-1' } as any,
    );

    const noSessionBackend: CliBackendConfig = {
      ...sessionBackend,
      sessionMode: 'none',
    };
    const noSessionClient = createCliAdapter('claude-cli', 'claude-sonnet-4-6', noSessionBackend);
    await noSessionClient.chat(
      [{ role: 'user', content: 'no session mode' }],
      { model: 'claude-sonnet-4-6', cliSessionKey: 'chat-1' } as any,
    );

    expect(hoisted.calls.length).toBe(2);
    const secondCall = hoisted.calls[1];
    expect(secondCall.args).not.toContain('--resume');
    expect(secondCall.args).not.toContain('--session-id');
  });

  it('clears cached session and retries once on session-conflict failures', async () => {
    const backend: CliBackendConfig = {
      command: 'claude',
      args: ['-p', '--output-format', 'json'],
      resumeArgs: ['-p', '--output-format', 'json', '--resume'],
      input: 'arg',
      output: 'json',
      modelArg: '--model',
      sessionArg: '--session-id',
      sessionMode: 'existing',
      sessionIdFields: ['conversation_id'],
    };

    hoisted.responses.push(
      { stdout: '{"result":"seeded","conversation_id":"sess-abc"}\n', stderr: '', exitCode: 0 },
      { stdout: '', stderr: 'Error: Session ID sess-abc is already in use.', exitCode: 1 },
      { stdout: '{"result":"recovered"}\n', stderr: '', exitCode: 0 },
    );

    const client = createCliAdapter('claude-cli', 'claude-sonnet-4-6', backend);

    await client.chat(
      [{ role: 'user', content: 'seed session' }],
      { model: 'claude-sonnet-4-6', cliSessionKey: 'chat-2' } as any,
    );

    const recovered = await client.chat(
      [{ role: 'user', content: 'run with stale session' }],
      { model: 'claude-sonnet-4-6', cliSessionKey: 'chat-2' } as any,
    );

    expect(recovered.content).toBe('recovered');
    expect(hoisted.calls.length).toBe(3);
    expect(hoisted.calls[1].args).toContain('--resume');
    expect(hoisted.calls[2].args).not.toContain('--resume');
    expect(hoisted.calls[2].args).not.toContain('--session-id');
  });

  it('honors caller timeout_ms override for CLI calls', async () => {
    vi.useFakeTimers();
    try {
      hoisted.spawnMock.mockImplementation((_command: string, _args: string[], options?: { signal?: AbortSignal }) => {
        const proc = new EventEmitter() as EventEmitter & {
          stdout: PassThrough;
          stderr: PassThrough;
          stdin: PassThrough;
        };
        proc.stdout = new PassThrough();
        proc.stderr = new PassThrough();
        proc.stdin = new PassThrough();

        const signal = options?.signal;
        signal?.addEventListener('abort', () => {
          proc.emit('error', new Error('The operation was aborted'));
        }, { once: true });

        return proc;
      });

      const backend: CliBackendConfig = {
        command: 'claude',
        args: ['-p', '--output-format', 'json'],
        input: 'arg',
        output: 'json',
        modelArg: '--model',
        timeoutMs: 180_000,
        sessionMode: 'none',
      };

      const client = createCliAdapter('claude-cli', 'claude-sonnet-4-6', backend);
      const promise = client.chat([{ role: 'user', content: 'hello' }], {
        model: 'claude-sonnet-4-6',
        timeout_ms: 5,
      });
      const assertion = expect(promise).rejects.toThrow('timed out after 5ms');

      await vi.advanceTimersByTimeAsync(10);
      await vi.advanceTimersByTimeAsync(2_250);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('kills the CLI child on caller abort and escalates if it does not exit', async () => {
    vi.useFakeTimers();
    try {
      const killMock = vi.fn((_signal?: NodeJS.Signals) => true);
      hoisted.spawnMock.mockImplementation((_command: string, _args: string[], options?: { signal?: AbortSignal }) => {
        const proc = new EventEmitter() as EventEmitter & {
          stdout: PassThrough;
          stderr: PassThrough;
          stdin: PassThrough;
          kill: ReturnType<typeof vi.fn>;
        };
        proc.stdout = new PassThrough();
        proc.stderr = new PassThrough();
        proc.stdin = new PassThrough();
        proc.kill = killMock;

        options?.signal?.addEventListener('abort', () => {
          proc.emit('error', new Error('The operation was aborted'));
        }, { once: true });

        return proc;
      });

      const backend: CliBackendConfig = {
        command: 'claude',
        args: ['-p', '--output-format', 'json'],
        input: 'arg',
        output: 'json',
        modelArg: '--model',
        timeoutMs: 180_000,
        sessionMode: 'none',
      };

      const controller = new AbortController();
      const client = createCliAdapter('claude-cli', 'claude-sonnet-4-6', backend);
      const promise = client.chat([{ role: 'user', content: 'hello' }], {
        model: 'claude-sonnet-4-6',
        abort_signal: controller.signal,
      });

      controller.abort(new Error('Stop now'));
      await vi.advanceTimersByTimeAsync(0);
      expect(killMock).toHaveBeenCalledWith('SIGTERM');

      await vi.advanceTimersByTimeAsync(2_000);
      expect(killMock).toHaveBeenCalledWith('SIGKILL');

      const assertion = expect(promise).rejects.toThrow('Stop now');
      await vi.advanceTimersByTimeAsync(250);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('caps interactive CLI timeout and returns a clear timeout error', async () => {
    vi.useFakeTimers();
    try {
      const killMock = vi.fn((_signal?: NodeJS.Signals) => true);
      hoisted.spawnMock.mockImplementation((_command: string, _args: string[], options?: { signal?: AbortSignal }) => {
        const proc = new EventEmitter() as EventEmitter & {
          stdout: PassThrough;
          stderr: PassThrough;
          stdin: PassThrough;
          kill: ReturnType<typeof vi.fn>;
        };
        proc.stdout = new PassThrough();
        proc.stderr = new PassThrough();
        proc.stdin = new PassThrough();
        proc.kill = killMock;

        options?.signal?.addEventListener('abort', () => {
          proc.emit('error', new Error('The operation was aborted'));
        }, { once: true });

        return proc;
      });

      const backend: CliBackendConfig = {
        command: 'claude',
        args: ['-p', '--output-format', 'json'],
        input: 'arg',
        output: 'json',
        modelArg: '--model',
        timeoutMs: 180_000,
        sessionMode: 'none',
      };

      const client = createCliAdapter('claude-cli', 'claude-sonnet-4-6', backend);
      const promise = client.chat([{ role: 'user', content: 'hello' }], {
        model: 'claude-sonnet-4-6',
        timeout_ms: 300_000,
        execution_scope: 'interactive',
      });
      const assertion = expect(promise).rejects.toThrow('The CLI model did not respond in time (45000ms).');

      await vi.advanceTimersByTimeAsync(45_000);
      expect(killMock).toHaveBeenCalledWith('SIGTERM');
      await vi.advanceTimersByTimeAsync(2_000);
      expect(killMock).toHaveBeenCalledWith('SIGKILL');
      await vi.advanceTimersByTimeAsync(250);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('treats timeout_ms=0 as disabled for this call', async () => {
    vi.useFakeTimers();
    try {
      hoisted.spawnMock.mockImplementation((_command: string, _args: string[], _options?: { signal?: AbortSignal }) => {
        const proc = new EventEmitter() as EventEmitter & {
          stdout: PassThrough;
          stderr: PassThrough;
          stdin: PassThrough;
        };
        proc.stdout = new PassThrough();
        proc.stderr = new PassThrough();
        proc.stdin = new PassThrough();

        setTimeout(() => {
          proc.stdout.write('{"result":"late ok"}\n');
          proc.stdout.end();
          proc.stderr.end();
          proc.emit('close', 0);
        }, 20);

        return proc;
      });

      const backend: CliBackendConfig = {
        command: 'claude',
        args: ['-p', '--output-format', 'json'],
        input: 'arg',
        output: 'json',
        modelArg: '--model',
        timeoutMs: 5,
        sessionMode: 'none',
      };

      const client = createCliAdapter('claude-cli', 'claude-sonnet-4-6', backend);
      const promise = client.chat([{ role: 'user', content: 'hello' }], {
        model: 'claude-sonnet-4-6',
        timeout_ms: 0,
      });

      await vi.advanceTimersByTimeAsync(25);
      await expect(promise).resolves.toMatchObject({ content: 'late ok' });
    } finally {
      vi.useRealTimers();
    }
  });
});
