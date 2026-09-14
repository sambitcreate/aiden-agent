# Aiden CLI — desktop feature parity checklist

Companion to [aiden-cli-plan.md](aiden-cli-plan.md). Compiled 2026-09-04 from three parallel
inventories of the desktop app (chat/session, providers/settings, automation/remote). For each
item: what it does, where it lives, whether the core is portable (no `electron` / `platform.js`
imports), and the CLI delivery vehicle.

Initial Phase 0–1 ports: ask-user-question, advisor, btw, todo (+widget), memory,
web-search, display-image, /usage, /voice + /dictate (basic), skills injection, themes, wordmark +
one-loop randomized startup animation.

## What pi already gives the CLI natively (no port needed)

Session resume/fork/tree/clone, `/export` HTML+JSONL, AGENTS.md context loading, project trust
(`/trust`, `defaultProjectTrust`), `/compact`, `/copy`, `/model`, `/session`, image paste/drag,
autocomplete, themes, hidden `/debug`.

## CLI-now — pure cores ready to port

| Feature | Desktop cores (portable) | CLI vehicle |
| --- | --- | --- |
| Auto session titles | `chat-title-policy.ts`, `chat-title-routing.ts` (pure); `chat-store-core.ts:1139` | extension: first user message → background title via model-runtime adapter → pi session name |
| Cross-session title/preview search | `chat-store-core.ts:723` (`listSummaryMetadata`), `sidebar-workspace-groups.ts` (pure) | `/search <query>` extension command |
| Portable `.aiden-chat.json` export | `chat-export.ts` (pure, schema v1, atomic) | `/export --aiden` writing to cwd (Phase 3 interop format) |
| Workspace registry + scratch workspaces | `workspace-application-service.ts` (pure DI), `scratch-workspace.ts` (pure) | `aiden workspace` / `/scratch` commands |
| Per-workspace access tiers (full/ask/none) | enforced in `llm-client.ts:572-908` (portable logic) | extension mapping persisted tier → tool approval |
| Managed git worktrees | `git.ts` (pure), `managed-worktree-*-core.ts`, worktree-remover C helper | `/git` + `/worktree` commands |
| Attachments batch caps | `attachments.ts` + `attachment-contract.ts` (pure) | optional `/attach <paths…>` honoring contract caps |
| Pi remote catalog overlay (hardened) | `pi-remote-catalog.ts`, `pi-models-store.ts` (pure; 4h freshness, ETag, stale pass) | startup revalidation + `/catalog refresh` — stronger than stock pi refresh |
| models.dev snapshot + model info | `models-catalog-core.ts`, `models-dev-cache-core.ts`, `provider-model-info-core.ts` (pure) | `/model info <id>` |
| AA + OpenRouter benchmark insights | `artificial-analysis-*-core.ts`, `openrouter-benchmark-catalog-core.ts`, `model-insights-action-core.ts` (pure) | `/insights` (manual fetch; benchmark-only key per network rules) |
| Provider auth flow coordinator | `provider-auth-flow-core.ts` (pure; only injects `shell.openExternal`) | `aiden auth login <provider>` — URL-print or device-code TUI |
| Codex subscription provider | `codex-provider.ts`, `codex-auth-failure.ts` (pure) | `registerProvider` Phase 2 |
| Concentrate + custom providers (LM Studio/Ollama/compat) | `concentrate-provider.ts`, `provider-config-migration-core.ts`, `provider-key-policy.ts` (pure) | `registerProvider` custom branch (the CLI's model-runtime bridge covers only the built-in branch today) |
| Onboarding key validation + state machine | `onboarding-provider-validation.ts`, `onboarding-state-core.ts`, `onboarding-reset-core.ts` (pure) | first-run extension + `aiden reset` |
| Credential store core (cipher injected) | `pi-credential-store-core.ts` (pure; desktop injects safeStorage) | backs `aiden auth` with a file cipher |
| Web-search provider zoo + routing | `web-search-provider-registry-core.ts` (pure; 20+ providers) | extend `/voice`-style settings command + env keys |
| Custom theme variants | `appearance.ts` (`parseThemeVariantJson`, safety checks — pure) | `aiden theme import/export` through the generate-themes pipeline |
| Thinking-level metadata (Google/Anthropic) | `google-thinking.ts`, `anthropic-thinking.ts` (pure) | `/models` metadata |
| Subagent delegation tool | `subagents/subagent-tool.ts`, `capability-profile.ts`, `subagent-supervisor.ts`, `forked-context.ts` (pure cores) | `subagent` tool (advisor-port pattern); `child_process` replaces UtilityProcess |
| Subagent approvals (one-shot digests) | `approval-v2.ts`, `outbound-approval-v2.ts`, `subagent-shell.ts` gates (pure) | RPC extension-UI prompts (ask-user-question pattern) |
| Subagent run store + history | `subagent-run-store*.ts` (pure + portable C helper) | roster widget or `/subagents` |
| Generative UI export | `generative-ui-html.ts`, `generative-ui-artifact-store.ts` (pure), vendored Chart.js/Plotly/KaTeX | export standalone HTML + open (plan Phase 4) |
| Schedule CRUD + preview (authoring) | `schedule-tool.ts`, `schedule-guard.ts`, `schedule-store.ts` (pure croner) | extension tools + `aiden schedule` |
| Usage ledger (source-attributed) | `usage-store-core.ts` (pure DataStore) | merge desktop store format into `/usage` |

## Needs glue (Electron touch is small)

| Feature | Glue needed | Files |
| --- | --- | --- |
| MCP preset catalog + OAuth | printed-URL OAuth + file credential store replace keychain/session glue | `mcp-presets.ts`, `plugin-catalog.ts` (pure), `mcp-oauth-store-core.ts` |
| Provider auth browser handoff | `shell.openExternal` injected (pure coordinator) | `provider-auth-flow.ts` |
| Catalog refresh on credential commit | drop bot-inventory hooks | `provider-registry.ts::refreshBuiltinCatalogs` |
| Telegram control | token source swap (env/auth.json vs safeStorage) | `telegram/*` (pure pipeline), Phase 4 serve |
| Scheduled task firing | platform notification seam swap | `schedule-execution.ts` |
| Bots runtime | file-based capability-key fallback for Keychain anchor | `bot-*` (mostly pure) |
| Remote speech | Parakeet engine host → worker_threads/child | `aiden-remote-speech*.ts`, `parakeet-process-core.ts` (transport-agnostic protocol) |

## Serve-phase (`aiden serve`)

Scheduled-task scheduler loop, bots runtime, Telegram long-poll, Aiden Remote REST+SSE (86
operations, OpenAPI at `protocol/aiden-remote/v1/openapi.json`), pairing/revocation/TLS identity
(+ `openssl` on PATH), Tailscale Serve route (planner is pure; needs `tailscale` on host), remote
workspaces/files/git/schedules/bots/speech endpoints, compaction-as-checkpoint daemon policy,
cross-chat activity coordination (`chat-activity-core.ts`, `chat-deletion-gate.ts`).

## Desktop-only (do not port)

Apple Foundation Models provider; on-device Parakeet dictation UX (global hotkey, pill, paste);
Gemini Live voice mode; computer-use (TCC + Rust broker + GUI session); Bot Face Studio
(nativeImage raster); Model Pad canvas (benchmark key already ports via `/insights`); command
palette, sidebar browser, workspace picker popover, environment/review panels, terminal drawer;
assistant dock; usage heatmap/share-card visuals; legacy keychain migration; provider artwork;
update-install flow. (Terminal/serve equivalents noted in the plan where they exist.)

## Cross-cutting

- Portability is verified from the bundled output graph. Selected speech, schedule, vision,
  subagent supervisor, and MCP mutation factories require explicit dependency injection;
  a `*-core.ts` filename alone does not establish that a module is Electron-free.
- `aiden.json` intentionally mirrors desktop `AppSettings` subsets — extend the same shapes.
- safeStorage-bound credentials stay desktop-only; CLI uses environment credentials or
  encrypted `auth.json` with an owner-private wrapping key. It does not share desktop keychain data.
- UtilitiesProcess hosts (subagent inference, Parakeet) become `child_process`/`worker_threads`.
- Native C helpers (worktree-remover, run-store, shell-runner, file-mutator) are POSIX-portable;
  need Linux build targets when they enter the CLI.


## Implementation and acceptance — 2026-09-05

The tables above preserve the original inventory. The implementation is in `packages/cli`;
this plan remains active until the final acceptance checks below are complete.

| Area | Implemented delivery |
| --- | --- |
| Sessions | Automatic/manual titles, active-branch search/export, bounded attachment batches, portable/desktop journal snapshot import into independent journals |
| Workspace authority | Registry, scratch directories, full/ask/none gates, daemon-routed mutations and cancellation, shared Git/files/worktree services and native removal |
| Providers and setup | Native Pi provider APIs including Codex OAuth, Concentrate/custom providers, auth coordinator and key validation, encrypted credential migration, shared onboarding state, thinking metadata |
| Catalogs | Hardened inference catalog overlay; fixed-endpoint manual models.dev and separate AA/OpenRouter benchmark credentials; display-only offline reads |
| MCP | Explicit SDK adapter (not provided by Pi), stdio/HTTP/SSE, presets/OAuth, pagination and response/schema budgets, exact schema/configuration checks before effects |
| Subagents | Shared supervisor, fresh/fork projection, parent-owned tool execution, native private history, one-shot write/shell/outbound/mutation gates and nested capability ceilings |
| Automation | Shared schedule CRUD, previews, durable runs, selected MCP/web inference and script execution; explicit-owner Telegram polling; settled shutdown |
| Bots | Shared notice/catalog/access/incarnation/rollback anchors, managed homes, scoped file/shell/MCP/skill/web tools, companion image analysis, worker-normalized photos, scoped read-only child investigations |
| Remote | Shared TLS/pairing/device revocation, REST/SSE service adapters, workspaces/files/Git/worktrees/schedules/Bots/models/chats/speech, idempotent turns and replay |
| Speech | Portable local-model manager and worker-hosted Parakeet protocol; explicit model downloads; status and setup remain offline |
| Presentation | Generated theme variants, terminal feature tour, offline generative HTML libraries, source-attributed usage ledger |
| Distribution | Four native helpers build on macOS/Linux; Docker image runs without Electron; Linux container CI job |

Final automated validation:

- macOS CLI: **57/57 passed**; CLI and root TypeScript, root ESLint, and `git diff --check` passed.
- Linux Node 22 container: **57/57 CLI tests passed**, **23/23 portable file-mutator tests passed** (two macOS-only metadata cases skipped), and **8/8 shell-runner tests passed**. All four helpers compile. The runtime image starts its scheduler with networking disabled and shuts down cleanly.
- The complete `npm run test:subagents` chain passed, including its 720-test main suite, shared phase suites, shell transport, and 25 macOS native file-mutator cases. The identifier regression is covered by the 107-test Phase 6B suite.
- Focused shared schedule/application, speech, vision, and credential suites: **54/54 passed**.
- Android `AidenRemoteClientTest`: Gradle focused unit-test task passed.
- **Pending physical acceptance:** iOS `AidenRemoteClientTests` and `AidenRemotePhase0Tests` compile, but Xcode cannot launch them until Sambit's iPhone is unlocked. The earlier three stale test expectations were corrected. No simulator substitutes for this check.

The code implementation is complete for the delivery vehicles in this checklist. Keep the
plan active until the physical iPhone rerun completes; do not report that acceptance as passed.

## Documented limitations and Phase 6 follow-ups — 2026-09-14

Deliberate scope boundaries, verified against `packages/cli/src`:

- **Memory is shared** via `~/.aiden/memory` with `ws-<folder-hash>` workspace scopes.
  Bot scopes remain per-surface (bot ids differ across installs); facts scoped to a
  deleted desktop workspace keep their legacy UUID scope until re-registered.
- **Daemon chats run a bounded toolset.** Remote/Telegram/Bot sessions get memory, todo,
  MCP, web search, advisor, and artifact export — no image display or
  ask-user-question (`daemon-chats.ts`). Interactive-only tools stay out of
  unattended surfaces.
- **Scheduled notifications are pull-based.** Mobile clients poll
  `GET /scheduled-tasks/notifications` on refresh (no cloud push); the desktop uses its
  existing Electron notification path.
- **`bots`/`remote` commands need `aiden serve` running.** They route over the daemon
  socket with no fallback (unlike `schedule`/`workspace`, which take a one-shot lease).
  `aiden serve --daemon` now provides the background lifecycle.
- **Credentials are file-encrypted, not keychain-protected.** AES-256-GCM under an
  owner-private wrapping key in the agent directory; documented in `packages/cli/README.md`.
- **Pairing renders a terminal QR** for the existing mobile payload; the pairing window
  still lives in the daemon and expires after ~5 minutes.
- **Advisor usage ledger writes are no-ops** (`advisor.ts`); session-journal usage still
  records. `src/probe-imp.ts` is dead dev cruft; `child-runner.ts` is test-only.

Terminal equivalents intentionally differ from desktop presentation: exported artifacts
replace canvas panels; Bot photos use a bounded worker instead of nativeImage; CLI authority
anchors are private files instead of keychain anchors. Bot child investigations are read-only
within admitted file scopes. Advanced attended child effects are exposed by the TUI, where
one-shot approval can be completed. Desktop-only items above remain excluded.
