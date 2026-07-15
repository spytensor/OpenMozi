#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

export const PROMPT_FILES = [
  'src/templates/SOUL.md',
  'src/templates/AGENTS.md',
];

const CHANGELOG_FILE = 'CHANGELOG.md';
const RUNTIME_ROOTS = [
  'src/core/',
  'src/gateway/',
  'src/tools/',
  'src/tel/',
  'src/memory/',
  'src/observer/',
  'src/tenants/',
  'src/capabilities/',
  'src/agents/',
  'src/onboarding/',
  'src/mcp/',
  'src/scheduler/',
  'src/watchdog/',
  'src/security/',
  'src/channels/',
  'src/runtime/',
  'src/progress/',
];

export function isRuntimeFeatureFile(file) {
  if (!file || typeof file !== 'string') return false;
  if (!file.startsWith('src/')) return false;
  if (file.startsWith('src/templates/')) return false;
  if (file.endsWith('.test.ts')) return false;
  return RUNTIME_ROOTS.some(prefix => file.startsWith(prefix));
}

export function evaluatePromptContract(changedFiles) {
  const files = Array.isArray(changedFiles) ? changedFiles : [];
  const runtimeFeatureFiles = files.filter(isRuntimeFeatureFile);
  const promptTouched = files.some(file => PROMPT_FILES.includes(file));
  const changelogTouched = files.includes(CHANGELOG_FILE);

  const errors = [];
  if (runtimeFeatureFiles.length > 0 && !promptTouched) {
    errors.push(
      'Runtime feature files changed, but prompt templates were not updated (src/templates/SOUL.md or src/templates/AGENTS.md).',
    );
  }
  if (runtimeFeatureFiles.length > 0 && !changelogTouched) {
    errors.push('Runtime feature files changed, but CHANGELOG.md was not updated.');
  }

  return {
    ok: errors.length === 0,
    files,
    runtimeFeatureFiles,
    promptTouched,
    changelogTouched,
    errors,
  };
}

function parseArg(name) {
  const prefix = `--${name}=`;
  const arg = process.argv.find(item => item.startsWith(prefix));
  if (!arg) return undefined;
  return arg.slice(prefix.length);
}

function getChangedFiles(baseRef, headRef) {
  const range = baseRef ? `${baseRef}...${headRef}` : headRef;
  const result = spawnSync('git', ['diff', '--name-only', range], {
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    const message = result.stderr?.trim() || result.error?.message || 'git diff failed';
    throw new Error(message);
  }
  const stdout = result.stdout ?? '';
  return stdout
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
}

function main() {
  if (process.env.MOZI_PROMPT_CONTRACT_BYPASS === '1') {
    console.warn('[prompt-contract] bypassed via MOZI_PROMPT_CONTRACT_BYPASS=1');
    return;
  }

  const base = parseArg('base');
  const head = parseArg('head') || 'HEAD';
  const changedFiles = getChangedFiles(base, head);
  const result = evaluatePromptContract(changedFiles);

  if (!result.ok) {
    console.error('[prompt-contract] check failed');
    console.error(`- changed files: ${result.files.length}`);
    console.error(`- runtime feature files: ${result.runtimeFeatureFiles.length}`);
    for (const err of result.errors) {
      console.error(`- ${err}`);
    }
    process.exit(1);
  }

  console.log('[prompt-contract] check passed');
  console.log(`- changed files: ${result.files.length}`);
  console.log(`- runtime feature files: ${result.runtimeFeatureFiles.length}`);
  console.log(`- prompt touched: ${result.promptTouched}`);
  console.log(`- changelog touched: ${result.changelogTouched}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
