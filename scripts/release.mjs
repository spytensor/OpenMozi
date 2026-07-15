#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const SEMVER_REGEX = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

const ROOT = process.cwd();
const ROOT_PACKAGE = resolve(ROOT, 'package.json');
const UI_PACKAGE = resolve(ROOT, 'ui', 'package.json');
const DESKTOP_PACKAGE = resolve(ROOT, 'desktop', 'package.json');
const README = resolve(ROOT, 'README.md');
const CHANGELOG = resolve(ROOT, 'CHANGELOG.md');

function fail(message) {
  console.error(`[release] ${message}`);
  process.exit(1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: options.stdio ?? 'inherit',
    encoding: 'utf-8',
  });
  if (result.status !== 0) {
    const rendered = [command, ...args].join(' ');
    fail(`Command failed: ${rendered}`);
  }
  return result.stdout ?? '';
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

function parseArgs(argv) {
  const options = {
    version: '',
    bump: '',
    commit: false,
    tag: false,
    push: false,
    release: false,
    all: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      continue;
    }
    if (arg === '--version' || arg === '-v') {
      options.version = argv[++i] ?? '';
      continue;
    }
    if (arg.startsWith('--version=')) {
      options.version = arg.slice('--version='.length);
      continue;
    }
    if (arg === '--bump') {
      options.bump = argv[++i] ?? '';
      continue;
    }
    if (arg.startsWith('--bump=')) {
      options.bump = arg.slice('--bump='.length);
      continue;
    }
    if (arg === '--commit') {
      options.commit = true;
      continue;
    }
    if (arg === '--tag') {
      options.tag = true;
      continue;
    }
    if (arg === '--push') {
      options.push = true;
      continue;
    }
    if (arg === '--release') {
      options.release = true;
      continue;
    }
    if (arg === '--all') {
      options.all = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
    fail(`Unknown argument: ${arg}`);
  }

  if (options.all) {
    options.commit = true;
    options.tag = true;
    options.push = true;
    options.release = true;
  }

  return options;
}

function printHelp() {
  console.log([
    'MOZI release helper',
    '',
    'Usage:',
    '  node scripts/release.mjs --version 1.0.1',
    '  node scripts/release.mjs --bump patch',
    '  node scripts/release.mjs --version 1.0.1 --commit --tag',
    '  node scripts/release.mjs --version 1.0.1 --all',
    '',
    'Flags:',
    '  --version <semver>   Explicit target version (e.g. 1.0.0)',
    '  --bump <type>        patch | minor | major (computed from package.json)',
    '  --commit             Create a release commit',
    '  --tag                Create annotated git tag v<version>',
    '  --push               Push commit and tag to origin',
    '  --release            Create GitHub Release via gh CLI',
    '  --all                Equivalent to --commit --tag --push --release',
  ].join('\n'));
}

function bumpVersion(current, bumpType) {
  const match = current.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    fail(`Cannot bump non-standard version: ${current}`);
  }
  let major = Number(match[1]);
  let minor = Number(match[2]);
  let patch = Number(match[3]);

  switch (bumpType) {
    case 'patch':
      patch += 1;
      break;
    case 'minor':
      minor += 1;
      patch = 0;
      break;
    case 'major':
      major += 1;
      minor = 0;
      patch = 0;
      break;
    default:
      fail(`Invalid bump type: ${bumpType} (expected patch|minor|major)`);
  }

  return `${major}.${minor}.${patch}`;
}

function resolveVersion(options) {
  const rootPkg = readJson(ROOT_PACKAGE);
  if (options.version && options.bump) {
    fail('Use either --version or --bump, not both');
  }
  if (options.version) {
    return options.version.trim().replace(/^v/, '');
  }
  if (options.bump) {
    return bumpVersion(rootPkg.version, options.bump);
  }
  fail('Missing target version. Provide --version <semver> or --bump <type>.');
}

function ensureSemver(version) {
  if (!SEMVER_REGEX.test(version)) {
    fail(`Invalid semver version: ${version}`);
  }
}

function compareSemver(left, right) {
  const parse = (value) => {
    const [core, prerelease = ''] = value.split('+')[0].split('-');
    return { core: core.split('.').map(Number), prerelease };
  };
  const a = parse(left);
  const b = parse(right);
  for (let i = 0; i < 3; i++) {
    if (a.core[i] !== b.core[i]) return a.core[i] > b.core[i] ? 1 : -1;
  }
  if (a.prerelease === b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  return a.prerelease.localeCompare(b.prerelease, undefined, { numeric: true });
}

function updateReadmeVersionBadge(version) {
  if (!existsSync(README)) return false;
  const before = readFileSync(README, 'utf-8');
  const after = before
    .replace(/version-v[0-9A-Za-z._-]+-purple\.svg/g, `version-v${version}-purple.svg`)
    .replace(/Version:\s*v[0-9A-Za-z._-]+/g, `Version: v${version}`);
  if (after !== before) {
    writeFileSync(README, after, 'utf-8');
    return true;
  }
  return false;
}

function trimBlankEdges(lines) {
  const copy = [...lines];
  while (copy.length > 0 && copy[0].trim() === '') copy.shift();
  while (copy.length > 0 && copy[copy.length - 1].trim() === '') copy.pop();
  return copy;
}

function findSectionBounds(lines, heading) {
  const start = lines.findIndex((line) => line.startsWith(heading));
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith('## [')) {
      end = i;
      break;
    }
  }
  return { start, end };
}

function buildUnreleasedReset(version) {
  return [
    '## [Unreleased]',
    '',
    '### Added',
    '',
    `- Release queue reset after v${version}; new entries land here.`,
    '',
    '### Changed',
    '',
    '- None yet.',
    '',
    '### Fixed',
    '',
    '- None yet.',
  ];
}

function hasMeaningfulChangelogContent(lines) {
  return lines.some((line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('- ')) return false;
    if (/^- None\.?$/i.test(trimmed)) return false;
    if (/^- None yet\.?$/i.test(trimmed)) return false;
    if (/^- Release queue reset after /i.test(trimmed)) return false;
    return true;
  });
}

function upsertChangelog(version) {
  const date = new Date().toISOString().slice(0, 10);
  const heading = `## [v${version}] - ${date}`;
  if (!existsSync(CHANGELOG)) {
    fail('CHANGELOG.md is missing. Create a formatted Unreleased section before cutting a release.');
  }

  const current = readFileSync(CHANGELOG, 'utf-8');
  if (current.includes(heading)) return false;

  const lines = current.split('\n');
  const unreleased = findSectionBounds(lines, '## [Unreleased]');
  if (!unreleased) {
    fail('CHANGELOG.md must contain an ## [Unreleased] section');
  }

  const unreleasedBody = trimBlankEdges(lines.slice(unreleased.start + 1, unreleased.end));
  if (!hasMeaningfulChangelogContent(unreleasedBody)) {
    fail('CHANGELOG Unreleased section has no meaningful formatted release notes');
  }

  const rebuilt = [
    ...lines.slice(0, unreleased.start),
    ...buildUnreleasedReset(version),
    '',
    heading,
    '',
    ...unreleasedBody,
    '',
    ...trimBlankEdges(lines.slice(unreleased.end)),
  ];

  writeFileSync(CHANGELOG, `${rebuilt.join('\n').replace(/\n+$/, '\n')}`, 'utf-8');
  return true;
}

function extractReleaseNotes(version) {
  if (!existsSync(CHANGELOG)) {
    return `Release v${version}`;
  }
  const heading = `## [v${version}]`;
  const lines = readFileSync(CHANGELOG, 'utf-8').split('\n');
  const start = lines.findIndex((line) => line.startsWith(heading));
  if (start === -1) return `Release v${version}`;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith('## [')) {
      end = i;
      break;
    }
  }
  const notes = lines.slice(start + 1, end).join('\n').trim();
  return notes || `Release v${version}`;
}

function tagExistsLocally(tagName) {
  const result = spawnSync('git', ['rev-parse', '-q', '--verify', `refs/tags/${tagName}`], {
    stdio: 'ignore',
  });
  return result.status === 0;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const version = resolveVersion(options);
  ensureSemver(version);
  const tagName = `v${version}`;

  const changedFiles = [];

  const rootPkg = readJson(ROOT_PACKAGE);
  const versionedPackages = [
    ['package.json', rootPkg],
    ...(existsSync(UI_PACKAGE) ? [['ui/package.json', readJson(UI_PACKAGE)]] : []),
    ...(existsSync(DESKTOP_PACKAGE) ? [['desktop/package.json', readJson(DESKTOP_PACKAGE)]] : []),
  ];
  const currentVersions = new Set(versionedPackages.map(([, pkg]) => pkg.version));
  if (currentVersions.size !== 1) {
    fail(`Versioned packages are out of sync: ${versionedPackages.map(([path, pkg]) => `${path}=${pkg.version}`).join(', ')}`);
  }
  if (compareSemver(version, rootPkg.version) < 0) {
    fail(`Version regression is not allowed: ${rootPkg.version} -> ${version}`);
  }
  if (rootPkg.version !== version) {
    rootPkg.version = version;
    writeJson(ROOT_PACKAGE, rootPkg);
    changedFiles.push('package.json');
  }

  if (existsSync(UI_PACKAGE)) {
    const uiPkg = readJson(UI_PACKAGE);
    if (uiPkg.version !== version) {
      uiPkg.version = version;
      writeJson(UI_PACKAGE, uiPkg);
      changedFiles.push('ui/package.json');
    }
  }

  if (existsSync(DESKTOP_PACKAGE)) {
    const desktopPkg = readJson(DESKTOP_PACKAGE);
    if (desktopPkg.version !== version) {
      desktopPkg.version = version;
      writeJson(DESKTOP_PACKAGE, desktopPkg);
      changedFiles.push('desktop/package.json');
    }
  }

  if (updateReadmeVersionBadge(version)) {
    changedFiles.push('README.md');
  }

  if (upsertChangelog(version)) {
    changedFiles.push('CHANGELOG.md');
  }

  console.log(`[release] target version: ${version}`);
  if (changedFiles.length > 0) {
    console.log(`[release] updated: ${changedFiles.join(', ')}`);
  } else {
    console.log('[release] no file updates required');
  }

  if (!(options.commit || options.tag || options.push || options.release)) {
    console.log('[release] file update complete (no git actions requested)');
    return;
  }

  if (options.tag || options.push || options.release) {
    console.log('[release] running complex-task release gate');
    run('pnpm', ['verify:complex-task-gate']);
  }

  if (changedFiles.length > 0) {
    run('git', ['add', ...changedFiles]);
  }

  if (options.commit) {
    const hasStaged = run('git', ['diff', '--cached', '--name-only'], { stdio: 'pipe' }).trim().length > 0;
    if (hasStaged) {
      run('git', ['commit', '-m', `chore(release): v${version}`, '-m', 'Co-authored-by: Mozi <MoziAI-co@users.noreply.github.com>']);
    } else {
      console.log('[release] skip commit: no staged changes');
    }
  }

  if (options.tag) {
    if (tagExistsLocally(tagName)) {
      fail(`Tag already exists locally: ${tagName}`);
    }
    run('git', ['tag', '-a', tagName, '-m', `Release ${tagName}`]);
  }

  if (options.push) {
    run('git', ['push', 'origin', 'HEAD']);
    if (options.tag) {
      run('git', ['push', 'origin', tagName]);
    }
  }

  if (options.release) {
    const notes = extractReleaseNotes(version);
    run('gh', ['release', 'create', tagName, '--title', tagName, '--notes', notes]);
  }

  console.log(`[release] completed: ${tagName}`);
}

main();
