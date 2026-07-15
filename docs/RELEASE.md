# Release Process

MOZI uses a single release script to keep version updates consistent across the repo.

## Commands

```bash
# Update versioned files only (no git actions)
pnpm version:bump -- --version 1.0.1

# Compute next version from current package.json
pnpm version:bump -- --bump patch
pnpm version:bump -- --bump minor
pnpm version:bump -- --bump major

# One-click release (version update + commit + tag + push + GitHub Release)
pnpm release:cut -- --version 2.0.1
```

## What the Script Updates

- `package.json` version
- `ui/package.json` version
- `desktop/package.json` version
- `README.md` top version badge
- `CHANGELOG.md` (creates or prepends current release entry)

## Required Release Gates

Before cutting a release, the branch must pass:

- `pnpm build`
- `pnpm verify:prompt-contract`
- `pnpm verify:complex-task-gate`
- the real complex-task release gate documented in [COMPLEX-TASK-RELEASE-GATE.md](COMPLEX-TASK-RELEASE-GATE.md)

Do not ship a release if MOZI cannot complete at least one real complex task end-to-end on the current build.

For Phase 1 terminal-first acceptance, also review and execute the scenarios in [acceptance-test-plan.md](acceptance-test-plan.md).

Useful diagnostics:

- `pnpm mozi status --workers`
- `pnpm mozi status --workers --live-probe`

## Existing Install Upgrade Path

For an existing install on the same machine, the normal upgrade path is:

1. update the code/package to the new version
2. rebuild if needed
3. restart MOZI

Routine runtime upgrades should not require re-running onboarding. On startup, MOZI reruns DB migrations, synchronizes bootstrap skills/agents, and reloads workspace skills/agents. Re-run onboarding only when changing credentials, providers, or preferences.

## Flags

- `--version <semver>`: explicit target version
- `--bump patch|minor|major`: derive next version from current
- `--commit`: create `chore(release): vX.Y.Z` commit
- `--tag`: create annotated git tag `vX.Y.Z`
- `--push`: push commit and tag to `origin`
- `--release`: create GitHub release via `gh`
- `--all`: equivalent to `--commit --tag --push --release`

## Example Stable Release

```bash
pnpm release:cut -- --version 2.0.1
```
