# AGENTS.md — Repository Instructions for Coding Agents

This file applies to Codex, Claude Code, Gemini CLI, and any other coding agent working in this repository.

The repo-level source of truth is [docs/CONSTITUTION.md](docs/CONSTITUTION.md). Follow it for all architecture, delegation, and release decisions.

## Non-Negotiable Rules

1. Prompt text is not the execution engine. Runtime owns worker launch, sandboxing, health, state, fallback, and verification.
2. Never invent worker progress, fake `queued`/`completed` states, or hide a deterministic runtime failure behind vague generic apologies.
3. Only claim capabilities that are actually registered and currently ready in this runtime.
4. Treat user-defined workspace skills and workspace agents as first-class extensions; they must follow the same managed-worker contract as built-in flows.
5. Do not ship delegation changes unless the complex-task release gate still passes.
6. Do not use generic shell execution as the transport for Claude Code, Codex, Gemini, or other external AI CLIs; those belong to managed-worker skills/adapters.
7. Do not treat a feature change as complete until relevant local tests have been run and passed; if new behavior lacks coverage, add or update tests in the same change.
8. Treat every bug report or feedback item as investigation-only until the user reviews the evidence and explicitly approves an implementation option. Follow the decision gate in `docs/CONSTITUTION.md` §6.

## Mandatory Bug And Feedback Workflow

Before changing product code for any bug, complaint, anomaly, or improvement request:

1. Inspect the real code and live call path; verify that the reported behavior and proposed diagnosis are true.
2. Identify the immediate cause and assess architectural causes, especially ownership, identity, lifecycle, state, persistence, contracts, and duplicated implementations.
3. Check existing MOZI abstractions first, then relevant mature open-source solutions, standards, and industry patterns. Compare fit, maintenance, license, security, and integration cost.
4. Give the user a decision brief: evidence, root cause, architectural assessment, existing solutions, options and tradeoffs, recommendation, scope, and verification plan.
5. Wait for explicit user approval of an option. Do not edit product code, dependencies, schemas, migrations, runtime configuration, or release artifacts before approval.
6. Implement only the approved option. Return for a new decision if material facts or scope change.

The original request to “fix” something does not itself satisfy step 5; approval must follow the investigation. Read-only inspection, reproduction, and research are allowed before approval.

## Practical Implications

- For delegation work, check the real adapter path, preflight, lane, sandbox, and result contract.
- For prompt work, keep prompts thin and grounded in runtime truth.
- For upgrade questions, prefer the startup contract: migrations, bootstrap sync, and workspace reload happen on restart.

## Product Surfaces And Parity

MOZI is one product with two first-class delivery surfaces:

- **Web:** the Docker-deployed MOZI runtime and Web UI.
- **App:** the installed macOS app, which supervises the packaged MOZI runtime
  and presents the same Web UI as a desktop product.

Shared product behavior must stay synchronized. A user-facing change is assumed
to affect both surfaces unless its Issue and implementation explicitly identify
it as Web-only or App-only.

1. Keep shared UI, API contracts, persistence behavior, model/provider behavior,
   prompts, permissions, artifacts, files, memory, and error states in common
   code. Do not create separate Web and App implementations without a concrete
   platform requirement.
2. Define both surfaces in the Issue and PR acceptance criteria. For a shared
   change, record Web/Docker evidence and installed-App evidence separately;
   passing one surface never proves the other.
3. Build both surfaces from the same commit. Rebuild/restart Docker for Web
   verification and rebuild/reinstall `/Applications/MOZI.app` for App
   verification so stale artifacts cannot masquerade as current behavior.
4. Verify the surfaces sequentially when they share port 9210. Stop one cleanly,
   verify that its listener and owned processes are gone, then start the other.
   Use isolated test data and state which runtime, data home, and artifact are
   being tested.
5. Exercise the same core workflow on both surfaces for shared changes. Add
   platform-specific checks where the environments differ: container mounts,
   auth, reverse proxy, and service health for Web; Finder launch, packaged
   resources, macOS permissions, quit/relaunch, and sidecar ownership for App.
6. If one surface cannot be verified, report that surface as unverified and do
   not call the complete product change done. Track an explicit blocker or
   follow-up Issue rather than silently narrowing the claim.

## Owner Mac Runtime Baseline

The installed macOS app is the owner's normal MOZI entry point. Unless a task
explicitly requires source-mode development, treat `/Applications/MOZI.app` as
the live product runtime and `~/Library/Application Support/MOZI` as its real
data home.

1. Before runtime work, inspect `http://127.0.0.1:9210/api/health` and verify
   that the listener belongs to the installed app. Do not infer runtime identity
   from the port alone.
2. Do not start `pnpm start`, `pnpm start:all`, `pnpm desktop:dev`, or a Docker
   MOZI service alongside the installed app. They compete for port 9210 and can
   produce false test results. The ONLYOFFICE Docker service may remain running.
3. Use source mode only when the change genuinely needs it. Quit the installed
   app gracefully first, isolate development data from the real App Support
   home, and state which runtime is under test.
4. A source build or passing source test does not update the installed app.
   After a change intended for the owner, rebuild the arm64 package, replace
   `/Applications/MOZI.app`, launch that installed copy, and verify the real
   user path before claiming completion.
5. Launch the product with `open -a /Applications/MOZI.app`. Quit it through the
   normal app lifecycle; use forced process termination only after graceful quit
   has demonstrably failed.
6. Never reset, delete, overwrite, or remigrate the real App Support data as a
   test shortcut. Preserve sessions, memory, secrets, files, workspaces, skills,
   agents, model configuration, and artifacts; create and record a rollback
   backup before any required migration.
7. For user-facing bugs, App evidence must come from the installed app,
   including health, the affected UI/API path, clean quit/relaunch, orphan
   process checks, and SQLite integrity when persistence is involved. Complete
   the separate Web/Docker evidence required above before claiming shared
   product completion.

For Claude-specific conventions and deeper repo guidance, also see [CLAUDE.md](CLAUDE.md).
