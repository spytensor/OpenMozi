/**
 * Shell Background Handler — Execute shell commands in background.
 *
 * handler_params: { command: string, cwd?: string }
 */

import { execFile } from 'node:child_process';
import type { BackgroundTask } from '../../core/background-tasks.js';

export async function shellBackgroundHandler(task: BackgroundTask, signal: AbortSignal): Promise<string> {
  const params = task.handler_params ? JSON.parse(task.handler_params) : {};
  const command = params.command;
  if (!command || typeof command !== 'string') {
    throw new Error('shell_background handler requires "command" parameter');
  }

  return new Promise((resolve, reject) => {
    const proc = execFile('sh', ['-c', command], {
      cwd: params.cwd,
      maxBuffer: 5 * 1024 * 1024, // 5MB
      timeout: task.timeout_ms > 0 ? task.timeout_ms : 300_000,
      signal,
    }, (error, stdout, stderr) => {
      if (error) {
        if (signal.aborted) {
          reject(new Error('Task aborted'));
        } else {
          reject(new Error(`Command failed: ${error.message}\nstderr: ${stderr?.slice(0, 500)}`));
        }
        return;
      }
      const output = (stdout ?? '').trim();
      const errOutput = (stderr ?? '').trim();
      resolve(errOutput ? `${output}\n\n[stderr]: ${errOutput}` : output);
    });

    signal.addEventListener('abort', () => {
      proc.kill('SIGTERM');
    }, { once: true });
  });
}
