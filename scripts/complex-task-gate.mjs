#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, accessSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join, isAbsolute } from 'node:path';

function fail(message) {
  console.error(`[complex-task-gate] ${message}`);
  process.exit(1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf-8',
    stdio: options.capture ? 'pipe' : 'inherit',
    env: options.env ?? process.env,
  });
  if (result.status !== 0) {
    fail(`Command failed: ${[command, ...args].join(' ')}`);
  }
  return result.stdout ?? '';
}

function findCommandOnPath(command) {
  if (isAbsolute(command)) {
    try {
      accessSync(command, constants.X_OK);
      return command;
    } catch {
      return null;
    }
  }

  for (const entry of (process.env.PATH ?? '').split(delimiter)) {
    if (!entry) continue;
    const candidate = join(entry, command);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue searching PATH.
    }
  }

  return null;
}

function runProbe(command, args) {
  const result = spawnSync(command, args, {
    encoding: 'utf-8',
    stdio: 'pipe',
    env: process.env,
    timeout: 15000,
  });

  return {
    ok: result.status === 0,
    stdout: (result.stdout ?? '').trim(),
    stderr: (result.stderr ?? '').trim(),
    error: result.error?.message ?? '',
  };
}

function inspectWorkers(noLiveProbe) {
  const workers = [
    {
      adapter_id: 'claude_code',
      command: 'claude',
      auth_path: join(homedir(), '.claude', '.credentials.json'),
      lanes: ['review', 'code'],
      probe_args: ['-p', '--output-format', 'json', 'Reply exactly OK'],
    },
    {
      adapter_id: 'codex_cli',
      command: 'codex',
      auth_path: join(homedir(), '.codex', 'auth.json'),
      lanes: ['review', 'code'],
      probe_args_by_lane: {
        review: ['exec', '--json', '--color', 'never', '--sandbox', 'read-only', 'Reply exactly OK'],
        code: ['exec', '--json', '--color', 'never', '--sandbox', 'workspace-write', 'Reply exactly OK'],
      },
    },
  ];

  const reports = [];
  for (const worker of workers) {
    const commandPath = findCommandOnPath(worker.command);
    const hasAuth = existsSync(worker.auth_path);

    for (const lane of worker.lanes) {
      const base = {
        adapter_id: worker.adapter_id,
        lane,
        command_path: commandPath,
        auth_path: worker.auth_path,
        status: 'ready',
        summary: 'Managed worker ready',
        live_probe: { enabled: !noLiveProbe, ok: true, summary: 'Live probe disabled' },
      };

      if (!commandPath) {
        reports.push({
          ...base,
          status: 'blocked',
          summary: `Command ${worker.command} not found`,
          live_probe: { enabled: !noLiveProbe, ok: false, summary: 'Command missing' },
        });
        continue;
      }

      if (!hasAuth) {
        reports.push({
          ...base,
          status: 'blocked',
          summary: `Auth not found at ${worker.auth_path}`,
          live_probe: { enabled: !noLiveProbe, ok: false, summary: 'Auth missing' },
        });
        continue;
      }

      if (!noLiveProbe) {
        const args = worker.probe_args ?? worker.probe_args_by_lane?.[lane];
        const probe = runProbe(commandPath, args);
        if (!probe.ok || !probe.stdout.includes('OK')) {
          reports.push({
            ...base,
            status: 'blocked',
            summary: probe.stderr || probe.error || probe.stdout || 'Live probe failed',
            live_probe: {
              enabled: true,
              ok: false,
              summary: probe.stderr || probe.error || probe.stdout || 'Live probe failed',
            },
          });
          continue;
        }
        reports.push({
          ...base,
          live_probe: {
            enabled: true,
            ok: true,
            summary: 'Live probe succeeded',
          },
        });
        continue;
      }

      reports.push(base);
    }
  }

  return reports;
}

function parseArgs(argv) {
  return {
    skipBuild: argv.includes('--skip-build'),
    skipPromptContract: argv.includes('--skip-prompt-contract'),
    noLiveProbe: argv.includes('--no-live-probe'),
  };
}

function summarizeLaneReports(reports, lane, requireLiveProbe) {
  const laneReports = reports.filter((report) => report.lane === lane);
  if (laneReports.length === 0) {
    return {
      ok: false,
      summary: `No worker readiness reports produced for lane ${lane}`,
    };
  }

  const viable = laneReports.filter((report) => report.status !== 'blocked');
  if (viable.length === 0) {
    return {
      ok: false,
      summary: `${lane} lane is blocked: ${laneReports.map((report) => `${report.adapter_id}: ${report.summary}`).join(' | ')}`,
    };
  }

  if (requireLiveProbe) {
    const liveHealthy = viable.find((report) => report.live_probe?.enabled && report.live_probe.ok);
    if (!liveHealthy) {
      return {
        ok: false,
        summary: `${lane} lane has no passing live probe`,
      };
    }
    return {
      ok: true,
      summary: `${lane} lane ready via ${liveHealthy.adapter_id}`,
    };
  }

  const ready = viable.find((report) => report.status === 'ready') ?? viable[0];
  return {
    ok: true,
    summary: `${lane} lane ready via ${ready.adapter_id}`,
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));

  if (!options.skipBuild) {
    run('pnpm', ['build']);
  }
  if (!options.skipPromptContract) {
    run('pnpm', ['verify:prompt-contract']);
  }

  const reports = inspectWorkers(options.noLiveProbe);
  if (reports.length === 0) {
    fail('No worker readiness reports were produced');
  }

  const requiredLanes = ['review', 'code'];
  const laneResults = requiredLanes.map((lane) => summarizeLaneReports(reports, lane, !options.noLiveProbe));
  const failed = laneResults.filter((result) => !result.ok);
  if (failed.length > 0) {
    fail(failed.map((result) => result.summary).join('; '));
  }

  for (const result of laneResults) {
    console.log(`[complex-task-gate] ${result.summary}`);
  }
  console.log('[complex-task-gate] Managed-worker readiness gate passed');
}

main();
