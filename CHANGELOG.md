# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Changed

- GitHub Releases are now produced by a fail-closed local macOS workflow: the release helper builds both DMG and ZIP artifacts, runs the packaged smoke matrix, records Developer ID and notarization truth, generates SHA-256 and manifest evidence, and uploads real assets through `gh`. Unsigned builds require explicit opt-in and are forced to prerelease status; empty Release pages are rejected.
- Public OpenMozi exports now fail closed on tracked runtime data, owner paths, private project names, and private-repository links; README screenshots are reproducible isolated Dark-mode EN/ZH demos, package metadata consistently declares MIT, and the macOS bundle carries the MIT license plus explicit CodeSandbox Nodebox Sustainable Use License notices.
- Explicit HTML, SVG, React, and JavaScript requests now retain `create_artifact` even when a turn is classified as simple, require the exact requested content type through the Brain repair contract, and normalize unambiguous standalone HTML/SVG signatures before persistence. Web/App rendering also recognizes historical HTML that was incorrectly stored as a Markdown document, restoring an HTML preview, icon, label, and `.html` download without rewriting user data.
- Memory recall now treats SQLite facts as the source of truth and uses deterministic local full-text search for small collections; real provider embeddings activate only after the configured size threshold, carry provider/model/dimension index fingerprints, and rebuild safely when the embedding space changes. The Settings picker exposes only verified embedding families, while OpenAI turns keep stable core memory ahead of append-only history, move volatile recall behind it, and attach a stable prompt-cache key with cache-read/write telemetry and pricing.
- Web/App session history now derives running and approval-needed indicators from durable user and background Turn Envelopes, broadcasts those states across the owner's sessions, and clears them only on a persisted terminal transition. Detached plan artifacts keep their background turn identity instead of inheriting an unrelated foreground turn.
- Admin usage accounting now attributes new DAG-step and plan-summary calls to their real user, conservatively repairs historical task-owned rows through persisted task ancestry, includes available legacy provider Cache telemetry, and counts real failed attempts even without Token usage. The product presents one local estimated-spend total from observed Token categories and immutable LiteLLM/built-in price snapshots, with cache-aware and historical non-cached upper-bound components kept in calculation details; the unused OpenAI organization billing connection and Admin Key surface were removed.
- Memory writes now use one user-scoped add/reinforce/update contract across the explicit `remember` tool, manual API, and background extraction. Same-turn duplicates collapse to one evidence record, later paraphrases reinforce the existing fact, corrections keep a stable fact identity, and the chat timeline shows a durable localized memory-update notice that opens the Memory workspace.
- MOZI builds now embed one canonical product identity (version, source commit, build time, release channel, and runtime surface), expose it through health/version APIs, carry it into Desktop and Docker packaging, and require the release helper to update root, Web UI, and Desktop package versions atomically without regressions.
- Brain execution now separates artifact lifecycle, pure loop policies, progress contracts, and streaming/non-streaming/tool/recovery handlers from the orchestration entrypoint, with import-boundary coverage preventing core-to-gateway/store coupling.
- LLM public contracts and provider dispatch are now separated from the AI SDK request/streaming adapter, with import-boundary coverage preventing provider code from coupling to gateway or storage modules.
- API registration now exposes a small stable entrypoint, delegates Office, memory, and scheduler endpoints to typed domain modules, and keeps the remaining compatibility implementation internal; inventory and boundary tests prevent missing, duplicate, or root-level route registrations.
- The Web UI now lazy-loads the artifact/Office renderer and non-chat workspaces (Admin, Settings, Files, Skills, Scheduler), removing PDF, Mammoth, SheetJS, and Sandpack from the initial entry chunk. `build:all` enforces a 750 kB raw entry budget from the Vite manifest.
- Messaging channels now publish an authoritative operation contract covering directionality, media, proactive delivery, editing, and deletion. Google Chat and Teams are labeled outgoing-only, LINE explicitly tells users unsupported media was not processed, and WeChat proactive delivery remains a structured non-delivery instead of a no-op success. The dead `memory_summaries` store and API were removed in favor of the live, user-scoped session digest path.
- Office artifacts now prefer an optional local ONLYOFFICE Docs service for editor-grade DOCX, XLSX, and PPTX viewing. Sessions and source-file requests are JWT-signed, storage paths are rechecked against the authenticated user's workspace, the original binary remains downloadable, and editing stays disabled until callback persistence and artifact versioning exist. Unavailable services are labeled as fallback previews instead of native rendering.
- Provider model selection now prefers server-side live discovery for configured OpenAI-compatible, Anthropic-compatible, Gemini, and Ollama providers. Results carry live/cache/catalog/manual provenance, survive transient failures through a persisted last-known list, and allow explicitly registered unknown model IDs with conservative capabilities instead of requiring a MOZI catalog release.
- Added model-aware prompt and tool shaping: DeepSeek and MiniMax receive smaller task-specific tool schemas and compact execution guidance, while prompt snapshots record model/task profiles and prompt/schema token estimates. DeepSeek reasoning-capable models now keep thinking enabled across tool-call continuations unless explicitly disabled.
- Replaced the bundled skill catalog with Anthropic's official skills: all 17 skills from [anthropics/skills](https://github.com/anthropics/skills) (docx, pdf, pptx, xlsx, canvas-design, algorithmic-art, theme-factory, brand-guidelines, slack-gif-creator, claude-api, mcp-builder, frontend-design, web-artifacts-builder, webapp-testing, doc-coauthoring, internal-comms, skill-creator) with upstream bodies verbatim and frontmatter extended to MOZI's SKILL-SPEC (Apache 2.0 license notices preserved). The 22 homemade default skills were removed; `coding-agent` is kept as the managed-worker delegation skill required by the complex-task execution contract.
- Skills page redesign: cards are grouped into category sections with per-skill lucide icon tiles on muted category tints; the four repeated capability chips were removed from cards (that detail lives in the detail drawer) and badges appear only for genuine anomalies — "Needs setup" now strictly means missing binaries/env.

### Added

- Added structured Bug, Feature, and Documentation Issue forms, a private security-report route, PR template, contribution guide, support policy, and Contributor Covenant for the public OpenMozi community.
- Added Settings → About MOZI for the shared Web/App UI, including runtime and Desktop shell versions, source commit, release channel, product surface, surface-specific update guidance, and an explicit shell/runtime mismatch warning.
- Added a production macOS icon derived from the existing web `墨` mark, including a reproducible 1024px master-to-iconset/ICNS generator and Electron Builder wiring for app, Finder, Dock, ZIP, and DMG packaging.
- Added the runtime-enforced verifier-first completion gate: the Brain now tracks file, git, test, and artifact evidence by tool batch, withholds unverified streaming claims, injects structured repair feedback, and records real verifier status in turn traces and prompt snapshots.
- Skill detail and editing: `GET /api/skills/:id` returns parsed frontmatter, raw `SKILL.md`, and a file listing; `PUT /api/skills/:id` edits workspace skills (bundled skills are read-only and return 403); a state endpoint toggles workspace skills. Skill cards open a detail drawer with rendered SKILL.md, requirements, sandbox profile, and files; workspace skills are editable in place.
- Chat renders skill activation as a distinct `Skill(name)` line with a load-outcome sub-line ("Successfully loaded skill · description" or the structured failure reason). `use_skill` results and tool events carry structured metadata (`skillName`, `skillDescription`, `skillLoadOutcome`, missing bins/env) instead of the UI regex-parsing display text.
- Active Skills lifecycle: `use_skill` now returns a short ack while the full skill body is injected through a session-scoped "Active Skills" context slot — exactly once regardless of reloads — and retires deterministically after the loading turn plus one follow-up user turn (`ACTIVE_SKILL_TTL_TURNS`). A new `unload_skill` tool lets the Brain retire a skill explicitly. Skill bodies no longer accumulate in conversation history (claude-api alone is ~18K tokens).
- Enterprise Docker image preinstalls `python3`, `git`, `poppler-utils`, and the pip packages declared by the document/media skills (python-docx, openpyxl, python-pptx, pdfplumber, reportlab, Pillow, numpy, pandas, imageio, markitdown), so document skills are Ready offline instead of surfacing "Needs setup" in the container.

- Release queue reset after v1.10.6; new entries land here.
- Web search key (SEARCH1API_KEY) can now be set from Settings › Providers & Keys — previously it could only be configured via CLI onboarding, so `web_search` / `web_fetch` and the `web-research` skill stayed disabled with no UI to fix it. `GET /api/search-key` reports whether it is configured and `POST /api/search-key` stores it in the encrypted secret store and applies it to the live process so search works without a restart.
- Web UI Settings can now pick the brain provider + model, reusing the native provider registry: `GET /api/providers` returns the provider/model catalog with key-presence and the current selection, and `POST /api/brain` writes `brain.model` + `model_router.brain_provider` to the config exactly like the CLI wizard's `runBrainUpdate` (applies on restart). The Providers & Keys settings panel shows a provider/model selector alongside the editable API keys.
- Settings Providers now shows the active model prominently (a banner with the running provider/model and a connected indicator from runtime health) and marks the active provider, so it is obvious which model MOZI is currently using. Provider key status is env-aware (`GET /api/providers` `hasKey` uses `resolveApiKey`, which checks environment variables, not just config), and a per-provider connection test (`POST /api/providers/:id/check`, reusing the native `checkProviderHealth`) verifies a key actually works rather than merely being present. On a backend that predates these endpoints, unverifiable providers are shown neutrally instead of a misleading "No key".
- The Settings model picker is now a rich browser showing every provider and model with tier, context window, tool/vision/reasoning support, and per-1M pricing, with the current model marked. It stays populated even against a backend that predates `GET /api/providers` by seeding from a UI-bundled catalog generated from the single source of truth (`scripts/gen-ui-model-catalog.mjs` → `ui/src/data/model-catalog.generated.json`), refined by `/api/config` for the current selection and key presence.
- Web UI canvas + execution UX overhaul: `create_artifact` now accepts `content_type: 'markdown'` and emits a `document_v1` artifact rendered as a full report in the canvas; the artifact panel became a renderer registry (code/document/image) resolved by `plugin_id`/`content_type`, opening only when the user clicks an inline card. The chat execution block collapses to a quiet one-line summary by default, markdown tables render with borders, the auto-opening telemetry side panel was removed (chat is full-width), the project-context banner was slimmed to a one-line strip, and project-scoped chats now nest under their project in the sidebar.
- Web UI live work surface: document/code artifacts can now open in a deterministic running state while `create_artifact` or renderable `write_file` input streams arrive, then patch into their final completed state without invented progress percentages. The input send button also reflects active work and can stop a running turn through the runtime cancellation path.

### Fixed

- Long-running DAG steps now treat `timeout_seconds` as a renewable inactivity lease instead of a hard wall-clock lifetime. Model and tool progress renew the lease, successful timeout tuning continues with the expanded budget, and repeated failure/loop guards still stop active but unproductive work.
- Recovered plan steps clear stale loop-guard state before retry/completion, the plan UI no longer labels completed work as stopped or exposes raw guard codes, and detached background execution is no longer misclassified as restart-interrupted merely because the foreground chat is idle.
- macOS desktop navigation now requires the exact runtime origin, blocks untrusted main-frame replacement, allows only HTTP/HTTPS/mailto external links, denies renderer permission requests by default, and cancels non-runtime downloads. Startup failures redact credential-like values and expose in-app Retry, Restart runtime, and Open log actions without enabling a preload bridge; expected status-page navigation cancellations no longer dump data URLs into logs.
- Finder-launched MOZI.app runtimes now receive a deterministic PATH containing existing Homebrew, `/usr/local`, Conda, and user-tool directories without adding the working directory. A viewer-readable desktop capability endpoint reports resolved binaries, executable health probes, document Python modules, managed-worker CLI plus credential readiness, Docker daemon availability, and ONLYOFFICE enhanced/fallback truth.
- macOS desktop migration now supports an explicit Docker-backed source through `MOZI_DESKTOP_LEGACY_HOME`, checkpoints and verifies SQLite before copying, creates a complete external backup, validates a staging copy, records hashes/counts/rollback steps, and atomically installs it at `~/Library/Application Support/MOZI`. Unknown target contents block migration instead of being overwritten, and packaged startup errors are surfaced instead of disappearing into an unhandled promise.
- macOS app shutdown now waits for its owned runtime to finish the existing graceful drain and SQLite close path, escalates from `SIGTERM` to `SIGKILL` only after a bounded timeout, and reaps app-owned children after startup failure. External runtimes remain attached but are never terminated.
- macOS desktop packaging now follows the current runtime resource layout: bundled skills are staged from `skills/`, while `bootstrap/` is required only for built-in agent definitions. Local packaging and CI no longer fail on the removed legacy `bootstrap/skills` directory.
- Memory load failures now render as an exclusive retryable error state instead of simultaneously claiming that no memories exist.
- Chat retry now atomically replaces the previous turn in live and persisted timelines, compacts duplicate retry rows left by older builds, clears stale activity indicators, and renders provider authentication/quota failures as structured retry states without exposing raw provider JSON.

- Unit tests no longer load host `.env` credentials or accidentally collect the standalone scripted release gate. Provider-role tests load their own temporary config, and memory-browser assertions now verify user-scoped browsing rather than an unsupported per-chat list filter.
- The optional ONLYOFFICE Compose service now pins its published `linux/amd64` platform so Docker Desktop can run it predictably on Apple Silicon hosts instead of stalling or failing architecture resolution.
- Restored a green TypeScript check by normalizing numeric background-task IDs at the LLM billing boundary. Added a fail-fast `verify:pre-merge` command matching the layered local checks; CI already requires typecheck before unit, integration, and E2E jobs.
- Brain turns now require an authoritative tenant identity and use it consistently for dynamic tool discovery, schema shaping, execution, and telemetry. A mismatched tool context fails before model execution instead of leaking or silently falling back to the default tenant.
- Generated files now converge on a persisted `file_v1` conversation card across filesystem, shell, skill, managed-worker, task, connector, and test execution boundaries. File envelopes include an authenticated download URL, preserve cards after refresh, accept previously unknown deliverable extensions, and validate explicit worker paths against canonical user-scoped workspace roots.
- Closed redirect and browser subrequest SSRF bypasses: outbound fetches now validate every redirect hop, strip credentials on cross-origin redirects, and cap redirect depth; Playwright sessions also block unsafe navigation, iframe, asset, and WebSocket requests and clean up failed sessions.
- Made the Brain tool permission gate fail closed: every built-in tool now requires an explicit permission declaration, startup rejects incomplete coverage, and unknown or dynamically registered tools require `L2_SHELL_EXEC` instead of bypassing preflight.
- Web UI: the Web-UI-selected workspace scope no longer leaks into the user's chat bubble or the auto-title. It is injected into the system prompt for the turn instead of prepended to the persisted user message; the frontend also strips the legacy block from already-persisted turns.
- Web UI agent progress now avoids duplicate lifecycle/progress cards when a live artifact already covers the turn, localizes per-turn progress labels from the user's message language, and keeps the left workspace sidebar scoped down by hiding the unfinished Skills section.
- Added App Support storage migration safeguards for issue #288: the packaged macOS App now checks legacy `~/.mozi` data before supervisor startup, copies config/secrets/SQLite/logs/workspace/skills/agents/memory/task state into the App Support home without deleting the source, rewrites only default legacy workspace and allowed-root paths, writes a migration manifest, blocks deterministic conflicts, and exposes active `mozi_home` / `config_path` plus migration status in runtime diagnostics.
- Added explicit runtime service controls for issue #288: Web UI System diagnostics can query and toggle the user service through `/api/runtime/service`, with launchd/systemd status surfaced as runtime state instead of implied background behavior.
- Added a real browser Web UI smoke gate for issue #275: `pnpm test:e2e:web` builds/serves the actual MOZI runtime UI with an isolated `MOZI_HOME`, drives Chromium through first-run onboarding and the System view, verifies live `/api/runtime/*` data, and writes `reports/web-ui-smoke.json` plus `output/playwright/web-ui-smoke.png`; the E2E CI job now builds the UI, installs Chromium, and uploads those artifacts.
- Added macOS desktop packaging CI for issue #287: pull requests that touch the desktop/runtime/UI packaging path now build the MOZI runtime, build the Web UI, stage a verified runner-architecture Node runtime, prepare a production-only desktop runtime resource directory with bootstrap skills/agents, package an unsigned `MOZI.app`, keep the Electron shell `app.asar` separate from MOZI runtime dependencies, verify required app resources and native imports, and upload a short-lived unsigned artifact for review.
- Added the first macOS desktop app shell package (`desktop/`) for issue #286: an Electron main process supervises the real MOZI daemon, health-checks `/api/health`, loads the existing Web UI when ready, and reports deterministic startup failures with the actual runtime/log paths instead of presenting demo state.
- **Multi-platform channel layer.** Introduced a `ChannelPlugin` registry (`src/channels/registry.ts`) and drove the onboarding wizard, capability manifest, and proactive-notification router from it. Shipped 10 new channels alongside the existing Telegram / WeChat / Web UI: **Discord, Slack (Socket Mode), LINE, Feishu / Lark (WSClient), Matrix (unencrypted rooms), IRC (TLS + SASL), Mattermost, Twitch Chat**, plus outgoing-notification channels for **Google Chat** and **Microsoft Teams**. Each channel has a dedicated tutorial under `docs/channels/<id>.md` covering credential acquisition, env vars, troubleshooting, and privacy. Deferred channels (WhatsApp, Signal, iMessage, BlueBubbles, Zalo OA, Tlon, interactive modes of Google Chat / MS Teams) are documented in `docs/channels/UNSUPPORTED.md` with concrete blockers.
- Added persistent task-management control-plane tools (`create_task`, `list_tasks`, `get_task`, `update_task`) so the runtime can track, inspect, and advance durable work items outside ad-hoc narration.
- Added `run_task`, which executes a persistent task through the existing DAG/subagent runtime instead of forcing the agent to rebuild execution state from scratch each turn.
- Added `repair_task` plus task-repair diagnostics/reset logic so failed persistent tasks can be classified, reset, and rerun through the same runtime path.
- Added `Skill Runtime v1`: bundled/workspace skill listing, local/bundled/git skill install into workspace, workspace skill enable/disable, and explicit skill validation.
- Added `Computer Use v1`: desktop screenshot, window listing/focus, app launch, keyboard input, hotkeys, and coordinate clicks through dedicated runtime tools.
- Added vision-guided desktop targeting tools (`desktop_click_hint`, `desktop_type_hint`) so MOZI can act on visible desktop targets without requiring manual coordinates.
- Added an English Phase 1 E2E acceptance protocol plus a concrete run report artifact for terminal-first validation.
- Added DeepSeek V4 Flash/Pro provider catalog support, including DeepSeek thinking-mode request mapping and reasoning-content preservation for tool-call continuation turns.
- Closed the permission-gate gap on the Brain tool-call hot path. Previously only `fs_*` / `shell_*` tools flowed through `runTel()` and therefore through `checkPermission`; `web_*`, `browser_*`, `desktop_*`, `git_*`, and memory tools bypassed the permission check on the direct `executeTool` path. Introduced `src/tools/tool-permission-map.ts` and an executor preflight that enforces `filesystem.read|write`, `shell.execute`, and `network.request` requirements uniformly before any tool body runs, so a `L1_READ_WRITE` agent can no longer call `git_push` / `web_fetch` / `browser_*` without approval.
- Added `/steer <text>` — mid-turn agent nudge. Users can now redirect a running agent without interrupting the current turn or breaking Anthropic prompt cache (TTL 5 min). Drained at each tool-call boundary in `executeAiSdkBrainLoop` and injected as a `user_steer` runtime message with a source-bound `[USER STEER chat:<id> — untrusted]` prefix and `role: system`, so the brain cannot mistake it for SOUL policy nor can a user forge the prefix. Steers survive behavioral-retry resets via a sticky `carriedSteerMessages` queue so a narration-without-execution retry does not silently drop queued user intent. Rate-limited to 3 queued entries × 500 chars per entry per chat; opportunistic garbage collection drops chatIds whose entries and last-brain-activity are both > 1h stale so the in-memory map cannot grow unbounded. Every steer runs through `detectPromptInjection` plus a short-input supplementary regex set (covers `< 20 char` payloads that skip the generic detector's length floor); blocked attempts are logged under `security.steer_rejected` and surfaced to the brain as a `runtime_meta` rejection instead of the original payload. When the brain has been idle past the 5-min prompt-cache TTL, the enqueue ack explicitly tells the user "this steer will start a fresh turn" (§10 Fallback Discipline — no silent downgrade). Ships the first concrete use of the Runtime Message IR contract from `docs/RUNTIME-PROMPT-ARCHITECTURE.md` §2 (`src/gateway/runtime-message-ir.ts`). Available via the standard slash-command parser on Telegram, WebSocket, Discord, Slack, Feishu, Twitch, Matrix, and Mattermost.
- Added `propose_skill` — a Brain-driven skill auto-extraction tool. The Brain now decides when a completed task represents a genuinely reusable workflow and persists it as a `SKILL.md` under the workspace autogen namespace (`~/.mozi/workspace/skills/autogen-<slug>/SKILL.md`). Proposals go through a strict Zod schema validation (every user-visible string capped at 2000 chars to prevent DoS writes), path-safe `autogen-<slug>` allowlist slugification (no `../` escapes), symlink-target refusal (`lstatSync` + `O_EXCL` write flag to close the TOCTOU window and defend against symlink-planting attacks), and write produces legal SKILL-SPEC frontmatter with `origin: "autogen"`, `user-invocable: false`, `metadata.sandbox_profile: "read-only"`. Autogen skills are **hidden from `/skills` and `/api/skills` by default** — they become visible only when `listRuntimeSkills` is called with `{ includeAutogen: true }` (operator-level diagnostics), so a newly written autogen skill never auto-exposes as a user-invocable command. SKILL-SPEC.md registers the new extension fields (`origin`, `source_task_id`, `metadata.sandbox_profile`). Auto-trigger heuristics (when the Brain *should* call `propose_skill`) remain intentionally absent; Phase 1 only lays the persistence substrate. Audited via `skill.autogen_created` in `event_log`.
- Added tool plugin hook system (`src/tools/plugin.ts` + `src/tools/plugin-registry.ts`). Plugins can register `pre_tool_call` (veto or rewrite args) and `transform_tool_result` (rewrite content) hooks; registry mirrors the channel plugin pattern. Hooks run **after** the permission gate so they cannot be used to escalate privilege at the tool-name level, and `transform_tool_result` rewrites cannot toggle `is_error` (rejected and audited as `security.hook_violation` to prevent masking completion-gate failures). Fail-closed on throw / 5s timeout → synthesized veto; the timer handle is cleared on fast-path completion so sustained tool-call rates do not leak pending timers. `plugin.ts` documents the trust boundary: hooks rewriting `args.url` / `args.command` for tools that do not re-validate inputs (`web_*`, `browser_*`, `desktop_*`) CAN direct a permitted call at a new destination — hooks must therefore be authored or vetted by the operator. First bundled reference hook `builtin.redact-secrets` strips common credential patterns (`*_API_KEY=`, `*_TOKEN=`, `Authorization: Bearer`, `AKIA…`, PEM private key blocks) from tool output at priority 10 — with placeholder protection that refuses to redact values shorter than 16 chars or matching common placeholder markers (`your-key-here`, `<your-token>`, `xxx`, `***`, `placeholder`, `changeme`, `todo`, …) so users can still grep their own config examples. Installed at startup via `installBuiltinToolHooks()` alongside `installBuiltinChannelPlugins()`.
- Capability manifest (`src/core/capability-manifest.ts`) now self-describes the four Phase 11 additions so `pnpm mozi status` and the runtime prompt's capability section report them honestly: `mid_turn_steering` (/steer), `brain_proposed_skills` (`propose_skill` autogen), `tool_plugin_hooks` (veto/transform/redact-secrets), plus a tightened `tool_calling` summary calling out the hot-path L0–L3 permission gate. README.md + README.zh-CN.md gain a user-facing "Steer mid-turn / Evolve its own skills / Extend via plugin hooks" block so external readers see the capability, not just internal commits.
- Added the first Lovable-style Web UI runtime workspace integration: read-only `/api/runtime/workspace` and `/api/runtime/logs` endpoints expose real MOZI storage/config roots, SQLite counts, runtime statuses, skills, and log tail data; the sidebar/composer/System view now bind Projects, Local Folders, Skills, storage health, and Inspect data from runtime state instead of frontend placeholders, and selected Web UI roots flow into the standard WebSocket `IncomingMessage` context.
- Added persisted Web UI session timeline restore for issue #310: runtime-visible user messages, assistant stream output, task progress, tool status, approvals, and artifacts are now stored as ordered session timeline events and exposed through `/api/sessions/:id/timeline`, so refresh/relogin can restore the working sequence instead of only replaying final chat messages.
- Added the Web UI runtime UX hardening pass for issues #317-#321: sessions now persist selected project/workspace context, restored chats rehydrate that context, Settings/System/Skills use real runtime data without demo profile/status placeholders, built-in skill/root labels use the UI locale layer, and the sidebar/composer keep the Lovable-style layout while hiding raw runtime identifiers from primary user surfaces.

### Changed

- Web UI MVP is now explicitly chat-first: project navigation, composer project scope, the project context banner, and unfinished attachment/mention controls are hidden behind UI feature flags. The dormant project selector path now has a future-safe default strategy that picks the runtime source/root project by default while preserving an explicit "general/no project" choice separately.
- Default runtime prompt assembly and primary Web UI labels now avoid MOZI-specific self-disclosure in ordinary user-facing interactions, while still allowing diagnostics/source details when the user explicitly asks for runtime internals.

- Task metadata can now be patched after creation, task cancellation/status events carry richer reason context, persistent task execution reuses child-task/dependency structure, and task recovery now distinguishes timeouts, dependency failures, blocked state, and managed-worker verifier/runtime failures.
- `/tasks` no longer returns a placeholder; it now renders real persistent task state with active defaults plus status/query filtering.
- `/skills` now renders real runtime skill state, including source, enabled/disabled status, and missing requirements, instead of only a capability summary.
- Runtime capability manifest now reports desktop/computer-control availability when `desktop_*` tools are registered.
- The constitution now explicitly requires passing relevant local tests for any feature change, and requires new behavior to add or update local test coverage in the same change.
- The acceptance plan has been replaced with an English Phase 1 terminal-first E2E protocol covering 12 concrete end-to-end scenarios.

### Fixed

- Provider connectivity and runtime LLM calls now resolve API keys saved through the Web UI tenant key store, so saving a provider key in Settings can be tested immediately and used without duplicating the key in static config. Search1API key saving now creates the local secret master key when needed and reports storage failures explicitly instead of surfacing a generic 500.
- Fixed Web UI chat session identity for issue #302: new chats now use runtime-owned UUID session ids, empty draft chats are reused instead of polluting history, sidebar timestamps normalize SQLite UTC values instead of drifting by local timezone, and the Chats/Projects sections expose stable session ids without raw internal task labels.
- Fixed Web UI restore ordering for issue #310 by keeping in-place task/tool/artifact updates anchored to their original timeline position while merging later status details, preventing refreshed conversations from jumping progress rows to the end of the transcript.
- Fixed `server.auth_mode=none` for local-first desktop/web use: protected API routes now receive a real `local-user` tenant context, the local user is provisioned in SQLite, and first-run Web UI onboarding can complete without token/OAuth pairing.
- Fixed the task-control gap where MOZI had low-level DAG/task storage primitives but no agent-facing runtime surface for durable task tracking and updates.
- Fixed the recovery gap where persistent tasks could fail terminally without a runtime-native diagnosis/reset path.
- Fixed provider/runtime error surfacing so wrapped quota/balance failures no longer collapse into the generic "temporary backend error" message when a deterministic root cause is available.
- Fixed DeepSeek V4 tool-loop stability by defaulting DeepSeek tool calls to non-thinking mode unless reasoning is explicitly configured, preserving streamed reasoning deltas for explicit thinking turns, and resolving auto context budgets from the selected model window.
- Fixed Telegram photo handling so generated workspace temp filenames are not persisted into chat context, and already-persisted stale attachment paths are sanitized before reaching the Brain.
- Fixed Telegram photo context boundaries so prior-turn photo analyses are marked as historical context and cannot be mistaken for images attached to the current message.
- Web UI approval deadlock: structured WS approve/reject messages now take a direct control-plane path (RBAC-checked, then `approveRequest`/`rejectRequest`) instead of queueing behind the very turn that is blocked waiting for the decision — previously an elevation approval was only applied after the ~300s tool wait timed out, so the approved action (e.g. `web_search`) never ran. Approval resolution broadcasts `approval_resolved` and persists the timeline row at resolve time to all of the user's connections, double-approve returns an idempotent terminal ack, and timeline reads reconcile approval items against the authoritative `approval_requests` table so a refresh can never resurrect an actionable pending card.

## [v2.0.0] - 2026-07-04

### Added

- Added local email/password authentication for enterprise deployments, including register/login flows and invite-based registration.
- Added enforced model entitlements with tenant ceilings, user grants, and truthful denials for disallowed model requests.
- Added LLM usage collection and tenant token quota enforcement for enterprise cost and usage controls.
- Added the admin console surface for users, audit history, usage, quotas, model grants, and audit CSV export.
- Added the enterprise Docker profile with local auth, read-only rootfs hardening, tmpfs scratch mounts, resource limits, healthcheck, and localhost-only default binding.

## [v1.10.6] - 2026-03-07

### Added

- Release queue reset after v1.10.5; new entries land here.

### Changed

- Managed-worker coding skill execution now resolves an explicit working directory instead of relying on adapter defaults to infer the repo root.

### Fixed

- Fixed the managed-worker coding skill contract so `completed_pending_verify` is no longer treated as a final success result.
- Fixed the managed-worker dispatch path to produce a synchronous verifier terminal state (`passed` or `failed`) instead of leaving jobs stuck at `completed_pending_verify`.
- Fixed the gateway/verifier closure so managed-worker skill results can now complete a turn when verification passes, while still blocking true pending verification.

## [v1.10.5] - 2026-03-06

### Added

- Release queue reset after v1.10.4; new entries land here.

### Changed

- Repo self-inspection now auto-promotes repo-grounding mid-turn for repo-like read/list requests, and can normalize redundant repo prefixes before filesystem execution.
- DAG/subagent default task timeouts now derive from the loop budget instead of the unrelated background-process timeout settings.

### Fixed

- Fixed repo/path confusion where MOZI could fall back to `~/.mozi/workspace/...` for repo-relative inspection paths such as `workspace/repos/Mozi/src`.
- Fixed near-miss repo file lookups so inspection mode can recover pragmatic guesses like `src/tools-shaping.ts` to the real module path.
- Fixed DAG execution observability by syncing task start/completion/failure/cancel states back into persistent task records and event logs.
- Fixed long-running DAG coding turns that could sit behind hour-scale subagent defaults until the outer interactive turn was cancelled.

## [v1.10.4] - 2026-03-06

### Added

- Runtime model capability snapshot and capability-manifest output now include routing explainability, usable model inventory, and sample routing decisions for operator inspection.
- Per-user routing preferences can now be stored in long-term memory and merged onto tenant-level routing defaults when the runtime has a concrete user identity.

### Changed

- Onboarding now generates and displays a recommended multi-model stack, persists routing preferences, and limits recommendations to models that actually passed onboarding benchmarks.
- Routing selection and vision/background summary helpers now accept user-aware routing context so real chat turns can honor merged user and tenant routing preferences.

### Fixed

- Fixed CLI-backed providers being dropped from capability snapshots and policy routing when other healthy API-key providers were present.
- Fixed routing cost-sensitivity and vision preference wiring so the policy engine affects the real runtime paths instead of only config parsing and isolated tests.
- Fixed onboarding review output so it shows both the recommended stack and the actual routing assignments that will be saved.

## [v1.10.3] - 2026-03-06

### Added

- Release queue reset after v1.10.2; new entries land here.

### Changed

- Prompt guidance now treats `skill_invoke` failures as real delegation/runtime failures instead of something to narrate around, and explicitly reminds the brain to read back changed non-code files before claiming completion.
- Managed-worker `skill_invoke` results now flow into the same gateway completion model as local verification, so delegated verifier state is tracked as runtime hard state instead of prompt-only JSON.
- Telegram/runtime progress now treats turn phase, current action, and managed-worker state as channel-visible runtime signals instead of leaving delegated work silent until the final answer.
- General-task tool shaping now defaults to a conservative surface instead of exposing the full raw builtin set, which makes weak/default models less likely to wander into low-level process and mutation paths.

### Fixed

- `skill_invoke` now surfaces structured skill business failures as actual tool errors, so failed managed-worker delegation no longer looks like a successful tool call.
- `read_file` now reports its resolved file path, and completion-gate readback verification keys off the resolved path instead of raw user text, preventing false `verification_pending` loops after grounded reads.
- `ai-coding-assistant` now requires `task` in its advertised skill schema and aligns success detection with managed-worker result enums (`completed` / `succeeded`).
- Gateway turns now stop immediately when a delegated managed worker finishes with verifier status still pending, instead of burning extra LLM iterations on a blocker the current turn cannot resolve.
- Managed-worker dispatch now emits real queue/launch/run/verify state plus heartbeats onto the progress bus, and Telegram can render those updates as a live progress message for long-running delegated work.
- `run_tests` no longer relies on brittle `stdout.indexOf('{\"')` parsing; it now prefers dedicated JSON output and a deterministic balanced-JSON extractor as fallback.
- Proactive/reminder delivery now distinguishes “sender exists but did not actually deliver” from true success, so invalid channel targets can no longer be silently counted as delivered.
- Skill matching now hardens explicit delegation, code review, and code-fix intents across English and Chinese phrasing instead of relying only on naive keyword extraction.

## [v1.10.2] - 2026-03-06

### Added

- Native Telegram draft streaming via `sendMessageDraft` (Bot API 9.5+). New `draft` stream mode sends ephemeral draft updates at 300ms intervals for smooth real-time output in DMs. Automatically falls back to `edit` mode in groups or when the API is unavailable.
- `sendMessageDraft()` raw API wrapper in `src/channels/telegram.ts` (telegraf 4.16.3 doesn't support it natively yet).
- `markDraftStreamUsed()` on `TelegramOutputChannel` to ensure final message is sent as a new message after draft streaming.

### Changed

- Default `telegram.stream_mode` changed from `append` to `draft`. Existing explicit config values (`append`, `edit`, `off`) are preserved.
- Draft mode skips repeated typing indicators since the draft itself acts as the "bot is typing" signal.

## [v1.10.1] - 2026-03-06

### Added

- Release v1.10.1.
- Added a repo-level constitution document plus root coding-agent instructions so Claude Code, Codex, and future tooling follow the same managed-worker execution rules.

### Changed

- Documented the existing-install upgrade path: after updating code/package, restart is normally sufficient because startup reruns migrations, bootstrap sync, and workspace skill/agent loading.
- Explicit external-worker delegation requests now activate a managed-worker-only runtime policy: the turn prompt steers delegation through registered skills/agents and tool shaping strips background-process polling from that lane.
- Available skill context now exposes exact `skill_id` values and invocation guidance so the brain can call registered skills without guessing IDs.

### Fixed

- Fixed runtime project-root resolution so daemon restarts no longer climb to the parent repository and fail opening the wrong `package.json`.
- Startup now loads workspace agent manifests in addition to workspace skills, so restart is enough for existing installs to pick up user-defined agents.
- Generic shell tools no longer encourage or allow Claude Code, Codex, Gemini, or similar external AI CLIs to be launched via ad-hoc `shell_exec` / `shell_exec_bg` orchestration.

## [v1.10.0] - 2026-03-06

### Added

- Added managed-worker preflight and health inspection with explicit lane/sandbox readiness reporting.
- Added `mozi status --workers [--live-probe]` so Claude/Codex readiness is inspectable without digging through logs.
- Added `pnpm verify:complex-task-gate` as an automated release gate for delegated worker readiness.

### Changed

- Project-root resolution for repo-aware tools, bootstrap skill loading, and daemon entrypoint lookup no longer depends on the shell `cwd`; runtime assets now resolve from the installed MOZI root.
- SubAgent DAG dispatch now honors preset `external_worker` definitions, so managed worker agents can execute through Claude Code or Codex instead of silently falling back to placeholder wiring.
- Release automation now materializes formatted release notes from `CHANGELOG.md`'s `Unreleased` block and runs the complex-task gate before tagging/publishing.
- Codex worker sandbox selection is now lane-aware (`review` -> `read-only`, `code` -> `workspace-write`) and worker job metadata records lane/sandbox/preflight context.

### Fixed

- Added a real `ai-coding-assistant` bootstrap skill that submits managed worker jobs and returns the actual result summary.
- Added Codex CLI managed-worker support, sanitized nested CLI session env vars, and synchronized bootstrap agent presets on startup so existing installs pick up delegation fixes.
- Managed worker dispatch now fails closed when preflight blocks a worker instead of pretending delegation is available.
- Prompt-contract git diff inspection no longer depends on spawning `/bin/sh`, which makes the check work in tighter sandboxed environments.

## [v1.9.29] - 2026-03-06

### Added

- Release v1.9.29.
- Published formatted release notes for the Telegram streaming and model-budget hardening release train.

### Changed

- Synchronized prompt templates with append-only Telegram streaming, rich-artifact-only auto-send, and model-aware token budgeting so runtime behavior and prompt guidance stay aligned.

### Fixed

- Fixed the `Tests (Layered)` CI failure by updating prompt templates required by the prompt contract.
- Filled the release queue section with non-empty formatted changelog placeholders instead of empty `None.` blocks.

## [v1.9.28] - 2026-03-06

### Added

- Release v1.9.28.
- Added a dedicated Telegram progress pipeline so channel streaming semantics are isolated from the main runtime loop and testable.

### Changed

- Telegram streaming now defaults to append-only follow-up messages; legacy `partial` configs are upgraded to the safer append mode, while mutable single-message streaming remains available as explicit `edit` mode.
- Subagent startup token budgets now derive from the selected model context window when `context.max_tokens` is left in auto mode.

### Fixed

- Telegram no longer auto-pushes intermediate markdown/code artifacts such as issue draft `.md` files by default; auto-send is now limited to user-facing rich artifacts like images, PDFs, and media.
- AI SDK adapters now clamp requested output tokens to the selected provider/model metadata instead of blindly forwarding oversized `max_tokens` values.
- Prompt templates are now synchronized with the new Telegram channel semantics and model-aware token budgeting contract.

## [v1.9.27] - 2026-03-06

### Added

- Release v1.9.27.
- Added canonical CLI onboarding command `mozi onboard`; `mozi init` remains as a legacy alias.

### Changed

- Onboarding wizard now asks the user to explicitly choose the brain model instead of implicitly taking the first detected provider/model.
- Secondary-role routing benchmarks now evaluate all remaining candidate models, including non-brain models from the chosen provider.
- Onboarding workspace flows now explain the layered prompt model (`SOUL.local.md`, `AGENTS.local.md`, `USER.md`) so system prompt updates and user overrides stay clearly separated.
- Onboarding secret persistence now prefers encrypted storage whenever a MOZI master key exists, and contract validation accepts both `.env` and encrypted secret storage.
- Wizard-entered provider API keys now follow the same secret-storage path as Search and Telegram credentials.

### Fixed

- Fixed command/docs drift where `/config` existed in docs and helper code but was not dispatched by the main runtime command router.
- Fixed Telegram onboarding so pasted provider keys are persisted through shared onboarding secret storage instead of living only in process memory.

## [v1.9.26] - 2026-03-06

### Added

- Release v1.9.26.
- Prompt snapshot capture and persistence for observability (`observer/prompt-snapshot`).
- Regression harness: export failure fixtures by `trace_id` and generate CI test skeletons (`observer/regression-harness`).
- `pruneOldSnapshots()` for automatic snapshot retention management.
- Task-aware tool shaping: tools are filtered per task type to reduce prompt noise (`tools/tool-shaping`).

### Changed

- `buildIntelligentContext` renamed to `compileIntelligentContext`, now returns detected `taskType` alongside messages.
- Tool resolution hoisted above the execution loop (tools are fixed per turn).

### Fixed

- None.

## [v1.9.13] - 2026-03-03

### Added

- Added proactive-engine regression coverage to ensure interval ticks do not start overlapping wake cycles while a prior wake is still running.

### Changed

- Error self-recovery behavior is now deterministic English by default (no extra LLM call/token usage).
- LLM-based self-recovery is now explicit opt-in via `MOZI_LLM_SELF_RECOVERY=1`.

### Fixed

- Fixed proactive-engine overlap noise by skipping interval wake ticks when an existing wake is in flight, reducing repeated `operation was aborted` judge errors.
- Fixed inconsistent self-recovery language during provider failures by using deterministic English fallback messaging (issue `#133`).

## [v1.9.12] - 2026-03-03

### Added

- Added Telegram live partial-stream mode (`telegram.stream_mode = "partial"`) using OpenClaw-style message flow:
  send one message on first visible chunk, then progressively edit it.
- Added configurable Telegram stream edit debounce (`telegram.stream_edit_interval_ms`, default `900` ms).
- Added OpenClaw-style config alias support in loader for:
  - `telegram.streamMode` -> `telegram.stream_mode`
  - `telegram.streamEditIntervalMs` -> `telegram.stream_edit_interval_ms`
- Added regression tests for Telegram output-channel message adoption/edit behavior, including pending-message adoption race handling.

### Changed

- Telegram output channel now supports adopted message IDs so final handler output can reuse and edit an existing streamed message instead of sending a duplicate.

### Fixed

- Fixed duplicate final Telegram reply bubbles when partial stream output is enabled by reusing the streamed message for final response delivery (issue `#132`).

## [v1.9.11] - 2026-03-03

### Added

- Added `llm-cli` regression coverage for:
  - ignoring stale cached session IDs when backend `sessionMode` is `none`
  - one-shot recovery retry when a session-enabled CLI backend returns a session-conflict error.

### Changed

- Refactored CLI adapter chat execution into per-attempt execution path with explicit session-mode gating and retry handling.

### Fixed

- Fixed stale in-memory session reuse for backends that explicitly disable sessions (`sessionMode: 'none'`).
- Fixed recoverable CLI session-collision failures by clearing cached session IDs and retrying once fresh (issue `#131`).

## [v1.9.10] - 2026-03-03

### Added

- Added a runtime capability self-report template to the system capability contract so model identity/DAG status answers use a consistent three-state format.
- Added regression assertions in `src/core/capability-manifest.test.ts` for:
  - explicit active DAG tool-path value (`decompose_task -> dag-bridge -> executeDag`)
  - anti-misdiagnosis guidance in the generated capability prompt.

### Changed

- Updated stale “DAG dormant” wording in:
  - `docs/ARCHITECTURE-GAPS.md`
  - `src/core/task-dispatcher.ts`
  - capability summaries in `src/core/capability-manifest.ts`.
- Updated `src/templates/SOUL.md` self-diagnosis guidance so runtime responses distinguish:
  `direct_brain_execution` (default), `task_decomposition` (on-demand DAG), and `subagent_execution` (rollout-gated worker path).

### Fixed

- Fixed docs/runtime prompt parity for DAG status reporting so MOZI no longer describes DAG as “fully dormant” when `task_decomposition` is enabled (issue `#129`).

## [v1.9.9] - 2026-03-03

### Added

- Added turn-level atomic checkpoint manager (`begin/commit/rollback`) in `core/turn-atomic-rollback`.
- Added strategy support for `git` (repo-aware reconciliation) and `tel` (checkpoint-only fallback).
- Added tests for:
  - non-git TEL rollback path
  - git rollback reconciliation path
  - git commit path
  - gateway turn-level rollback on failed tool loop
  - gateway turn-level commit on successful tool flow

### Changed

- Gateway handler now starts a turn-scoped checkpoint session for executable turns and finalizes it automatically:
  commit on success, rollback on failed/cancelled outcomes.

### Fixed

- Fixed partial side effects across multi-step turns by restoring pre-turn workspace state when the turn does not complete successfully (issue `#128`).

## [v1.9.8] - 2026-03-03

### Added

- Added score-driven lifecycle evaluator for agents with deterministic actions:
  `promote_proposed`, `promoted`, `demoted`, `blacklisted`, `archived`.
- Added `refreshScoreAndMaybeEvolve(...)` API to run scoring and lifecycle policy in one step.
- Added lifecycle boundary tests for promotion (gated + auto), demotion, and blacklist transitions.

### Changed

- SubAgent dispatch now refreshes score and runs lifecycle evaluation after each execution outcome.
- Agent registry updates now support changing agent `type` (needed for promote/demote transitions).

### Fixed

- Implemented adaptive evolution workflow promised by architecture/issue `#127`:
  score updates can now trigger auditable policy actions instead of passive metrics only.

## [v1.9.7] - 2026-03-03

### Added

- Added gateway integration tests covering session-handoff creation (rotate watermark) and restore-on-stale-session flow.
- Added `getLatestForSession(sessionId, tenantId)` in `core/session-handoff` for precise handoff retrieval by prior session id.

### Changed

- Gateway now restores prior-session handoff context into live system prompt when a stale session rolls over.
- Gateway now passes a concrete `SessionState` snapshot + `tenantId` into `budgetCheckAndAct(...)` so rotate-watermark handoff generation runs in production flow.

### Fixed

- Fixed missing end-to-end session-handoff wiring in live gateway path (`running-summary` and `session-handoff` now both participate in runtime flow).
- Fixed missing restore telemetry by persisting `session_handoff_restore` events during handoff restore.

## [v1.9.6] - 2026-03-03

### Added

- Added policy issue `#130` to track and enforce English-by-default response behavior.

### Changed

- Updated core/system prompt policies to default to English unless the user explicitly requests another language.
- Updated proactive engine language fallback from `zh` to `en`.
- Updated profile extraction guidance to only set `language_preference` when explicitly requested by the user.

### Fixed

- Fixed inconsistent language defaults that caused implicit same-language/Chinese responses without explicit user preference.

## [v1.9.5] - 2026-03-03

### Added

- Added regression coverage for empty sanitized LLM output in `src/gateway/handler.test.ts`.
- Added fallback message tests for the new `empty_response` stop reason in `src/gateway/tool-loop-guards.test.ts`.

### Changed

- Gateway tool-loop classification now marks empty sanitized model output as `empty_response` instead of defaulting to `max_iterations`.
- Guard fallback messaging now includes explicit user guidance for `empty_response`.

### Fixed

- Fixed false `reason=max_iterations` failures when the model returned content that became empty after output sanitization.

## [v1.9.4] - 2026-03-03

### Added

- Added regression test coverage for Codex CLI system-prompt argument encoding in `src/core/llm-cli.test.ts`.

### Changed

- Updated Codex CLI system-prompt encoding to use `developer_instructions=...` for `codex exec -c`.

### Fixed

- Fixed `codex-cli` provider path where runtime system instructions could be ignored due to incorrect config key (`instructions=...`).

## [v1.9.3] - 2026-03-02

### Added

- Default filesystem allowlist now includes `~/.mozi`, so self-upgrade and config operations can run without manual root additions.

### Changed

- `mozi init` provider detection now includes installed CLI providers (`claude-cli`, `codex-cli`, `gemini-cli`) even when no API key is present.
- Gateway brain prompts now include authoritative runtime model/provider facts so model-identity answers reflect actual configured/runtime routing.

### Fixed

- Reduced incorrect “no permission / only one model visible” responses by injecting concrete runtime provider-model inventory into the system context.

## [v1.8.38] - 2026-03-01

### Added

- Release v1.8.38.

### Changed

- None.

### Fixed

- None.

## [v1.8.37] - 2026-03-01

### Added

- Release v1.8.37.

### Changed

- None.

### Fixed

- None.

## [v1.8.36] - 2026-03-01

### Added

- Release v1.8.36.

### Changed

- None.

### Fixed

- None.

## [v1.8.35] - 2026-03-01

### Added

- Release v1.8.35.

### Changed

- None.

### Fixed

- None.

## [v1.8.34] - 2026-03-01

### Added

- Release v1.8.34.

### Changed

- None.

### Fixed

- None.

## [v1.8.33] - 2026-03-01

### Added

- Release v1.8.33.

### Changed

- None.

### Fixed

- None.

## [v1.8.32] - 2026-03-01

### Added

- Release v1.8.32.

### Changed

- None.

### Fixed

- None.

## [Historical Notes]

### Added

- Added autonomous memory salience + forgetting controls: fact-level `salience_score`, salience-aware ranking/recall, low-salience pruning with semantic consolidation, and correction-priority memory extraction.
- Added self-correction and capability adaptation upgrades: user-correction lesson capture, post-tool verification directives, unknown-tool capability-gap guidance, and dynamic tool lifecycle states (`draft`/`active`/`deprecated`) with usage/failure telemetry.
- Added event-driven proactive execution and voice channel foundations: proactive `act` handler with safety gate + audit events, webhook/file-change event triggers, and `/ws/voice` STT/TTS adapter wiring with channel config.

- Added dynamic tool result truncation (`truncateToolResult`) with CJK-aware head/tail split and per-tool token budgeting based on remaining context window budget.
- Added legacy tool call parser extension (`src/core/llm-legacy-toolcall-fallback.ts`) supporting XML, Markdown code-fence, and plain-JSON formats for non-standard LLM providers.
- Added declarative agent manifest support (`agent.toml`/`agent.yaml`) with Zod-validated schema for model preferences, tool whitelists, resource limits, and guardrails. Workspace agents auto-loaded at bootstrap via `loadWorkspaceAgents()`.
- Added SSRF protection (`src/security/ssrf-guard.ts`) blocking private IPs (RFC 1918, loopback, link-local, CGNAT), cloud metadata endpoints, non-HTTP protocols, and DNS rebinding. Integrated into `web_fetch` and `browser_open` tools with configurable `tools.network` settings.
- Added hash-based tool call loop detection (`LoopDetector` in `src/gateway/tool-loop-guards.ts`) using SHA256 signatures to detect consecutive repeats (A,A,A) and periodic cycles (A,B,A,B). Two-phase response: hint injection first, force-stop if LLM persists.
- SOUL.md capability alignment: Added Proactive Awareness section (engine behavior, proactive_control tool, limitations), Memory System section (8 subsystems: auto-extract, lessons, semantic search, consolidation, context builder, running summary, project context, sessions), User Understanding section (profile auto-extraction, first-contact guide), Learning from Experience section (event learner, tool outcome tracking, effectiveness scoring), Dynamic Tool Creation (runtime bash/python tool registration), Scheduler & Reminders (background tasks, fire-once reminders), Agent Scoring (descriptive metrics, explicitly no self-adaptation).

### Added (prior)

- Added turn-level failure replay harness (`src/observer/failure-replay.ts`) that exports trace fixtures (`trace_id` -> fixture), supports provider/tool mock replay, and validates expected failure paths.
- Added one-command regression skeleton generation (`pnpm replay:generate --trace <trace_id>`) via `scripts/failure-replay-generate.mjs`.
- Added replay harness test coverage: unit (`src/observer/failure-replay.test.ts`) and integration (`tests/integration/failure-replay-harness.integration.test.ts`).
- Added deterministic agent-loop signal snapshots and structured decision logs (`agent_loop_decision`) with replay helpers for auditability.
- Added agent-loop replay integration coverage (`tests/integration/agent-loop-replay.integration.test.ts`) to validate deterministic action reconstruction from logged decisions.
- Added enterprise authentication configuration under `security.enterprise` with multi-tenant OIDC issuer bindings and SAML IdP bindings.
- Added progressive SubAgent runtime rollout controls under `tools.subagents` (`enabled`, `enabled_tenants`, `enabled_sessions`, `session_capability`) with gateway session-resolution logic.
- Added dedicated runtime decision module (`src/gateway/subagent-runtime.ts`) and tests for global/tenant/session/capability activation paths.
- Added SubAgent runtime e2e coverage (`tests/e2e/subagent-runtime.e2e.test.ts`) for parallel execution, cancellation, timeout-retry behavior, and fallback observability.
- Added provider tool-calling compatibility matrix integration tests with smoke/full modes, covering non-stream, stream, parallel multi-tool-call, and failover recovery scenarios across OpenAI/Anthropic/OpenAI-compatible classes.
- Added provider compatibility CI workflow (`.github/workflows/provider-compat.yml`) with nightly full runs, smoke runs on push/PR, workflow-dispatch mode selection, and report artifact uploads.
- `mozi init` now supports auto-starting MOZI in the background after setup, with CLI flags `--auto-start` and `--no-auto-start`.
- Added runtime PID-file lifecycle management to prevent accidental multi-instance startup collisions.
- Added process lifecycle CLI commands:
  - `mozi start --daemon`
  - `mozi stop [--force]`
  - `mozi restart [--daemon]`
- Added a standard "Upgrade & Restart a Running Instance" section to `README.md`.
- Added onboarding write-contract documentation: `docs/ONBOARDING-CONFIG-CONTRACT.md`.
- Added bootstrap skill `onboarding-config-contract` to enforce onboarding/config change checklist.
- Added centralized recovery policy engine (`src/core/recovery-policy.ts`) to classify loop-stop causes and drive staged recovery decisions (`self_heal`, `hard_recovery`, `brain_intervention`, `fallback`).
- Added turn-level control state machine (`src/core/turn-control.ts`) with lifecycle states (`QUEUED`, `PLANNING`, `EXECUTING`, `RECOVERING`, `WAITING_INPUT`, `RESPONDING`, `DONE`, `FAILED`) and emitted `turn_state` progress events.
- Added observability trace persistence: per-turn `turn_traces` + per-tool `tool_spans`, with `trace_id` lifecycle recording from gateway execution.
- Added SLO dashboard APIs:
  - `GET /api/dashboard/slo` (success rate, latency, failure category, cost, recent trace/span view)
  - `GET /api/dashboard/models` (model dimension options)
  - `GET /api/dashboard/costs` now supports `model` filter
- Added Web UI SLO panel and model-dimension filtering across Cost/SLO tabs.
- Added prompt-contract automation:
  - `scripts/prompt-contract.mjs` for changed-file policy checks
  - `pnpm verify:prompt-contract`
  - CI workflow gate requiring prompt/changelog sync when runtime features change

### Fixed

- Hardened migration compatibility for legacy databases: startup no longer fails when older `memory_facts` tables are missing `salience_score`; salience index creation is deferred until additive column migration runs.
- Reduced failure-regression validation overhead by enabling direct trace-based replay artifact generation from persisted telemetry/event data.
- Replaced random autonomous loop behavior with deterministic rule evaluation, eliminating non-repeatable proactive triggers.
- Linked agent-loop decisions to live task backlog state, turn failure categories, and daily token quota pressure for closed-loop operational control.
- Replaced enterprise auth stubs with production OIDC discovery/JWKS token validation and minimal SAML assertion signature validation, including tenant-context claim/attribute mapping.
- Upgraded API pre-handler auth flow to await enterprise OIDC/SAML verification while preserving local JWT/API-key fallback compatibility.
- Wired SubAgent feature flags into the production `decompose_task` path (`gateway -> tools executor -> dag bridge -> dag executor`) so tenant/session rollout now affects real task execution.
- Added reliable in-process fallback observability for SubAgent runtime failures/unavailability via `event_log` (`dag_subagent_fallback` events on both DAG and task scope).
- Updated runtime capability manifest `subagent_execution` status/value (`mode=global|targeted|disabled`) to reflect real rollout configuration.
- Hardened `shell_exec` restricted execution with default Docker sandbox isolation (no network, dropped capabilities, non-root user, read-only rootfs), explicit command allowlisting, and high-risk command hard-gate approvals requiring `approval_request_id` retries.
- Hardened tool-call protocol repair before LLM calls: `sanitizeToolPairs` now enforces assistant(tool_calls) -> adjacent tool(result) integrity (not just ID existence), preventing provider-side `Tool results are missing for tool calls` failures after context mutations.
- Enforced tenant quota guards in the live gateway path: daily/monthly token hard limits now short-circuit turns, soft limits trigger degraded output budgets, model allowlists (`allowed_models`) are enforced before execution, and per-task token caps now terminate oversized turns with explicit user guidance.
- `mozi init` update flow no longer hard-exits when all detected providers fail health checks; users can now retry, reconfigure keys, or continue update without provider re-verification.
- Provider health check now treats a successful API roundtrip as healthy even when a model returns empty final text (e.g. reasoning-first responses).
- Provider detection now respects per-provider base URL overrides (e.g. `MINIMAX_BASE_URL`) during onboarding/init verification.
- Complex decomposition with a single task now stays on the DAG path (instead of being downgraded to simple mode), so artifact-based UI rendering can still activate.
- Simple-classified research requests (medium/high complexity + tool-calling) are now promoted to executable DAG tasks, improving artifact activation and research flow consistency.
- Refreshing the UI no longer replays duplicate complex-turn content as both plain assistant text and artifact card; history restore now deduplicates against nearby workspace artifacts.
- Tool execution event bubbles are now rendered as compact inline chips instead of long full-width bars, improving chat readability.
- Workspace artifact mission/title generation no longer reuses raw user prompt text, avoiding prompt echo in artifact headers and mission panels.
- Workspace artifacts now persist full markdown report payload (`report_markdown`) and render it in-card, restoring Task section readability after refresh.
- Mission/task panel spacing and alignment in artifact cards was refined for consistent visual hierarchy.
- Chat auto-scroll now respects manual user scroll position; while browsing history, incoming updates no longer force-jump to latest.
- Added in-session message queueing: when MOZI is still processing, newly sent messages are queued and dispatched FIFO once the current turn finishes.
- Input bar now displays explicit busy/queued status to make turn scheduling visible.
- Legacy tool-call protocol leaks are now stripped even when streams terminate mid-block (unclosed `[TOOL_CALL]` / `<tool_call>`), preventing raw protocol text from reaching users.
- Artifact marker parsing now tolerates leading whitespace on both server and UI restore paths, improving refresh-time artifact recovery.
- History dedupe now compares assistant plain-text against both workspace artifact summary and full `report_markdown`, removing more duplicate Task dump echoes after refresh.
- Workspace artifact cards now hide token-percentage labels and always use `Execution Workspace` as card title to avoid prompt echo and reduce cognitive noise.
- Telegram streaming output now uses a synchronized send/edit state machine (no `-1` sentinel race), preventing sudden content replacement/flicker and duplicate fallback replies when first send is still in-flight.
- Telegram reply delivery now runs in stable non-streaming mode (typing + final send only), eliminating mid-reply content edits/replacements/deletions that degraded UX.
- Unified onboarding persistence between `mozi init` wizard and Telegram onboarding through `src/onboarding/persistence.ts` to prevent drift and missed writes.
- Standardized onboarding secrets persistence: Telegram/Search keys are now written via shared `.env` upsert helpers instead of split write paths.
- Added onboarding write-contract validation in the wizard before marking setup complete.
- Loop-guard handling now routes through policy-selected recovery phases instead of hardcoded branch logic in `gateway/handler`, enabling deterministic intervention behavior.
- Config storage now uses `~/.mozi/mozi.json` as canonical file, with automatic fallback/migration from legacy `~/.mozi/config.yaml`.
- Wizard/CLI/config migration paths are aligned to the same canonical config format, preventing init/deploy drift where only `config.yaml` appeared.
- Cost dashboard totals now come from real `billing_records` (LLM call spend) instead of agent average-token approximation, improving operational accuracy.

## [v1.1.13] - 2026-02-23

### Fixed

- Added Telegram-specific system prompt constraints so model output avoids markdown-only styling in Telegram channel responses.
- Added Telegram output normalization (`normalizeTelegramText`) to strip raw markdown wrappers (`**`, `` ` ``, headings, fenced blocks) before send/edit, preventing ugly literal formatting in chat bubbles.
- Applied the normalization path consistently to direct replies, streamed message sends, and streamed edits.
- Added regression tests for Telegram markdown normalization and send-path behavior.

## [v1.1.12] - 2026-02-23

### Fixed

- Simple-turn loop guard fallbacks no longer expose internal runtime text (e.g. `Reached maximum ...` / `internal runtime guard`) to end users.
- DAG task loop guard fallbacks now use user-safe continuation text instead of technical guardrail strings.
- Added internal event-log persistence for guard-stop outcomes (`tool_loop_guard`, `dag_tool_loop_guard`) so diagnostics remain available to Brain/ops while chat output stays clean.
- Guard fallback messaging now auto-detects missing env prerequisites (e.g. `SEARCH1API_KEY`) and returns actionable next-step guidance without leaking protocol internals.

## [v1.1.11] - 2026-02-23

### Added

- Added `tools.loops.llm_call_timeout_ms` (default `45000`) to bound a single provider call (`chat`/`chatStream`) and prevent indefinite `WORKING` hangs when upstream streaming stalls.

### Fixed

- Strengthened state progression robustness by enforcing per-call timeouts in both simple-turn and DAG tool loops, so stuck provider calls now fail fast and allow session state to converge back to `RESPONDING -> IDLE`.

## [v1.1.10] - 2026-02-23

### Added

- Added `tools.loops.max_elapsed_ms` (default `120000`) to cap per-turn tool-loop runtime without forcing a hard iteration cap.

### Fixed

- Prevented “UI looks stuck forever” scenarios where `max_iterations=0` (unlimited) plus ever-changing tool calls could keep running indefinitely.
- Added tool-loop timeout guards for both simple chat path and DAG task execution path, with safe terminal messages and self-heal fallback.

## [v1.1.9] - 2026-02-23

### Fixed

- Resolved a hot-update config type bug where loop limits could become string values (e.g. `"0"`), causing false guardrail termination messages such as `Reached maximum of 0 tool call iterations`.
- `updateConfig` now applies scalar coercion (`"0"` -> `0`, `"true"` -> `true`) and validates the full config schema before committing runtime changes.
- Added runtime numeric normalization for tool-loop limits in gateway/brain/DAG executors so stale malformed in-memory values no longer break loop control.
- Replaced confusing `maximum of 0` fallback text with explicit internal-guard wording.

## [v1.1.8] - 2026-02-23

### Added

- Added configurable simple-turn self-heal controls under `tools.loops`:
  - `self_heal_retries`
  - `self_heal_backoff_ms`

### Changed

- When a simple-turn tool loop is stopped by guardrails (max iterations / repeated loop / repeated failures), MOZI now runs bounded internal recovery attempts before returning a terminal stop message.

### Fixed

- Simple-turn guardrail stops no longer hard-terminate the conversation by default; recovery now synthesizes a continuation response and keeps the dialogue flow alive.
- Streaming channels now receive a proper `stream_end` for guarded-stop fallback text, preventing dangling “working” placeholders.

## [v1.1.7] - 2026-02-23

### Fixed

- Added fallback parsing for legacy text-based tool-call protocol (`[TOOL_CALL] ... [/TOOL_CALL]`) in both non-stream and stream model responses, so tool execution no longer degrades into raw chat text.
- Prevented legacy tool-call protocol text from leaking into user-visible streamed chat output by sanitizing gateway/UI render paths.
- Added regression tests for legacy tool-call fallback parsing to avoid future protocol-compatibility regressions.

## [v1.1.6] - 2026-02-23

### Changed

- Workspace artifact card was redesigned to match the Agent Workflow style language (Mission/Task Flow/Execution Trace/Observer) with cleaner hierarchy and status coloring.
- Execution trace is now grouped by task blocks and rendered inside a collapsible panel, reducing noisy full-card text dumps.

### Fixed

- Resolved AI SDK `ModelMessage[]` schema failures by hardening tool-message conversion and auto-recovering malformed historical `tool` entries.
- Ensured every tool result path includes `tool_name`, including parallel tool execution rejection fallbacks.
- Rich websocket clients with `artifact_v1` no longer receive duplicate plain-text DAG output after artifact updates.
- UI now suppresses late artifact-echo assistant messages when they duplicate recent workspace artifact summary/report content.

## [v1.1.0] - 2026-02-23

### Added

- Configurable tool-loop guardrails (`tools.loops.*`) and repeated-tool-failure circuit breaker for gateway/DAG/subagent flows.
- Configurable filesystem policy (`tools.fs.workspace_only`, `allow_project_root_read`, `additional_allowed_roots`) for MVP flexibility with optional hardening.

### Changed

- Unified onboarding flows to include `SEARCH1API_KEY` setup in chat onboarding, with `.env` persistence and clearer web-tool enablement prompts.

### Fixed

- Avoided simple-turn tool loops on decomposition parse fallback by defaulting to non-tool simple classification.

## [v1.0.0] - 2026-02-22

### Added

- Initial stable release.
