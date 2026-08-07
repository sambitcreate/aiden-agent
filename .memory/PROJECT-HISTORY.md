### 2026-08-07 — MCP client + subagent runtime deep audit (crash/hang/security fixes)

- **`aiden-mcp::client`**: `McpClientManager` no longer holds the global map
  lock across awaits — clients are `Arc`-shared and cloned out under the lock, so
  a 60s tool call (or a slow stdio connect) can no longer serialize every other
  server or stall a second chat generation. `ensure_connected` connects outside
  the lock (double-checked insert) and now reconnects when the server record's
  canonical fingerprint (`spec_fingerprint`, transport + credential snapshot)
  changes — a reconfigured command/URL/env/header/preset key no longer leaves a
  stale process (and stale credentials) serving forever. Tool results are capped
  at `MAX_MCP_TOOL_RESULT_CHARS` (200k) so a verbose server cannot blow up the
  transcript. Tests: cross-server non-blocking probe, connect-during-call probe,
  reconnect-on-spec-change, concurrent-connect, fingerprint determinism (no
  secret leakage), truncation.
- **`aiden-subagents::shell_runner`**: the timed-out path never killed the
  command — the deadline arm broke the loop but the cleanup only killed on
  overflow/cancel, so `child.wait()` blocked for the command's full remaining
  lifetime (e.g. `sleep 5` with a 100ms timeout stalled 5s; the pre-existing
  `timeout_produces_timed_out_outcome` test was silently slow/flaky). Cleanup now
  kills the whole process group (`process_group(0)` + `killpg`, fallback
  `child.kill()`) for timeout/overflow/cancel, and the post-exit pipe drain is
  bounded by a 1s grace period so an orphaned grandchild holding the pipes cannot
  stall the caller indefinitely. `uuid_like()` now mixes a process-wide atomic
  counter into the time seed — two concurrent shell runs (or parallel tests) in
  the same clock tick collided on the private temp dir ("private tree failed").
- **`aiden-ui::approvals::approval_bridge`**: `decide` on a dead entry (runner
  cancelled after `resolve` took the receiver) now removes the leaked pending
  card; a stale never-resolvable approval no longer lingers in the queue.
- **`aiden-ui::panels::subagents_panel`**: refreshes are coalesced through a
  `RefreshGate` (the 2s tick can fire during a slow up-to-8 MiB `runs.json`
  read), and a refresh that outlives a chat switch no longer applies stale
  results for the previous scope.
- **Verified-by-test (no change needed)**: authority digest stability across
  restarts even with reordered persisted JSON keys; nested self-spawn + depth
  caps; empty/null-byte shell command rejection; run-store V2 corrupted file
  fails closed preserving evidence (no crash); workspace path sandboxing rejects
  `../../etc/passwd` escapes on both executors (new traversal test battery).

### 2026-08-07 — GPUI port: remaining services (provider auth flow, updater provider, MCP credential cleanup, connection caches, Gemini context cache, appearance preview, model pad, document owner)

- **App updater** (`rust/aiden-mac`): `updater_feed.rs` — the pure electron-updater
  generic-feed core (strict JSON feed parse, artifact selection, sha-256 download
  verification, feed/artifact size caps; always compiled + tested, no network);
  `feed_update_provider.rs` behind the new `update-feed` cargo feature — a real
  `FeedUpdateProvider` implementing the existing `UpdateProvider` seam (fetch →
  channel policy via `should_offer_update` → download → verify → stage), with the
  quit-and-install step defined as an `UpdateInstaller` trait the GPUI binary wires
  later (TS `autoUpdater.quitAndInstall`). FeedClient is injectable; tests never
  touch the network. Default builds stay feed-free.
- **provider-auth-flow-core** → `rust/aiden-providers/src/auth_flow.rs` (~1.2k LOC +
  ~1.5k test): the full interactive auth coordinator — single global flow slot
  owned by (owner id, document id), prompt/event DTO contract, select-option
  mapping, https-only external URLs, sanitized error classification + diagnostics,
  per-prompt abort, bounded flow timeout + auth-cleanup window, credential-commit
  point of no return, logout/shutdown waits. 27 tests mirror the TS suite
  (ownership fencing, token redaction, timeout/cleanup races, late-credential
  suppression, commit/finishing, shutdown waits).
- **provider-auth-owner** → `rust/aiden-agent/src/document_owner.rs`: the
  renderer-document-owner engine behind provider-auth-owner.ts — epoch-based
  document capture, navigation/process-loss/destroyed invalidation (once), send
  fencing, one-throwing-listener isolation. 7 tests against an Electron-free
  `RendererWebContents` trait.
- **mcp-credential-cleanup-core** → `rust/aiden-mcp/src/credential_cleanup.rs`:
  secret-map sha-256 hashing, credential/runtime connection snapshots, strict
  journal parsing, cleanup-after-config resolution (7 tests).
- **generation-bound-connection-cache** → `rust/aiden-mcp/src/connection_cache.rs`:
  `GenerationBoundConnectionCache` + `GenerationBoundConnectionAttempts` with
  supersede-close-after-ready semantics (7 tests; fixes a parking_lot re-entrant
  deadlock and the TS-fire-and-forget async semantics via spawn).
- **gemini-context-cache** → `rust/aiden-providers/src/gemini_cache.rs` (~0.9k LOC):
  deterministic bounded workspace snapshot (metadata only, never contents),
  fingerprint-keyed cache with 1h TTL / backoff / expiry-margin, injectable
  `GeminiFetch`, bounded deadlines, per-workspace 8-cache eviction, invalidation +
  shutdown remote deletes (10 tests; credentials header-only, never in URLs).
- **provider-list-core** → `rust/aiden-providers/src/list.rs`: Codex virtual
  provider merge, reserved-id collision filtering, status-channel forwarding (4
  tests). **appearance-preview-core** → `aiden-core/appearance_preview.rs` (2
  tests); **model-pad-layout** → `aiden-core/model_pad.rs` (4 tests).
- Scan of `main/services/*.ts` confirmed already-ported: provider-config-migration
  (`aiden-data::portable_config::migrate_pi_provider_config`), mcp-presets
  (`aiden-mcp::config`), profile-share-core (`aiden-data::profile` PNG validation),
  secret-map, appearance preview snapshot type. No standalone telemetry/portability
  service exists (usage accounting covers privacy-safe analytics).
- Workspace: added `aiden-mac` to `[workspace.dependencies]` (aiden-ui references
  it via `aiden-mac.workspace = true`; without the entry the workspace manifest
  would not load). New deps: aiden-providers gains `aiden-git` + `uuid`;
  aiden-mac gains `sha2` + `tempfile`; aiden-mcp gains `parking_lot`.
- Verified: `cargo test --workspace --no-fail-fast` (1225 passed), `cargo clippy
  --workspace --all-targets -- -D warnings` (clean), `cargo fmt --all -- --check`
  (clean), plus `cargo test/clippy -p aiden-mac --features update-feed` (84 passed,
  clean) and `cargo check --workspace --all-features`.

### 2026-08-07 — GPUI port: workspace context bar (workspace picker, git chips/dialogs, open-in-editor)

- New `rust/aiden-ui/src/workspace/` module: the chat-pane header bar renders
  three chips — workspace (name/path → `WorkspacePicker` overlay with the
  recent-workspaces list from the portable-config `workspaces` section +
  "Choose folder…" via `gpui::PathPromptOptions`/`prompt_for_paths`, the
  native macOS open panel), git (branch name, dirty dot, ahead/behind via
  `aiden_git::status::info`, refreshed on chat-view focus + 15 s poll while
  visible, → `BranchPicker` with switch/create branches through
  `aiden_git::branch::{checkout,create_branch}` and Commit/Push entries), and
  open-in-editor (editors detected on the background through
  `aiden_data::external_editors::EditorCache`, argv-only `open -b` launch).
  `CommitDialog` uses the `aiden_git::diff::review` snapshot + numstat summary
  (`commit_selection_description`), commits via `aiden_git::commit::commit`
  and toasts the subject/branch; `PushDialog` uses `push_capability`
  (upstream detection + ahead count), pushes via `aiden_git::push::push`, and
  hides force-with-lease behind a confirm (type the destination branch name;
  the lease pin resolves from `refs/remotes/<remote>/<dest>`). All git and
  editor detection runs on the tokio bridge (`gpui_tokio_bridge::Tokio` — the
  task is created before the `cx.spawn` continuation because continuation
  `cx` is an `AsyncApp`), never the foreground. Git errors render inline with
  `GitErrorCode` taxonomy hints (`git_error_hint`).
- `rust/aiden-ui/src/services/chat_service.rs` (additive): `workspace` /
  `workspaces` fields, boot loads the list and activates the most-recently
  updated one, `select_workspace` / `add_workspace_from_folder`
  (canonicalize + basename name + `ask` permission, uuid-like id) /
  `workspace_folder`; new chats carry the workspace id.
- Shell wiring (app.rs / chat/chat_pane.rs): the bar renders above the
  transcript; `AppState` mirrors service workspace state into
  `WorkspaceState::set_mirror` (poll restarts only on folder change),
  routes `WorkspaceEvent::{SelectWorkspace, AdoptFolder, Notify}`, starts
  the terminal drawer in the workspace folder and re-homes an existing one
  via a new additive `TerminalDrawer::set_cwd`; chat-view focus refreshes
  the git chip.
- Native dialog approach: **gpui built-in `prompt_for_paths`** (present in
  gpui 0.2.2 `App`) — no `rfd` dependency added.
- Tests: 8 new unit tests in `workspace/state.rs` (git-chip formatting
  incl. detached/unborn/pluralization, branch ordering with current pinning,
  commit selection descriptions, editor ranking passthrough + Finder last,
  case-insensitive workspace/branch filters, `GitErrorCode` hints,
  `truncate_path_middle` port). Live (not stubbed) git/editor paths behind
  the `WorkspaceState` methods.
- Verified: `cargo test -p aiden-ui` (136 passed), `cargo clippy -p aiden-ui
  --all-targets -- -D warnings` (clean), `cargo fmt -p aiden-ui`, `cargo
  check --workspace` (passes), 10 s smoke run of `target/debug/aiden` with
  no stderr/panics. Known limit: an already-open terminal keeps its original
  cwd until the workspace changes (the PTY is not migrated on first open).

### 2026-08-07 — GPUI port: aiden-computer-use crate (Computer Use + Apple Foundation Models)

- Added `rust/aiden-computer-use` to the workspace: the broker client, the
  cua-driver MCP session protocol, and the Apple Foundation Models helper
  client (ports of `main/services/computer-use/*` and
  `main/services/foundation-models-connection*.ts`; the Swift helper and the
  native Rust broker are untouched).
- **Broker/bridge client** (`contract.rs`, `jsonrpc.rs`, `lines.rs`,
  `socket.rs`, `process.rs`, `session.rs`, `host.rs`, `binary.rs`): exact
  replication of the native broker wire protocol — the pinned 20-tool
  allow-list (`start_session … set_value`), line-delimited JSON-RPC 2.0 with
  the broker guard's message classification (`process_client_message` /
  `process_driver_message`, including the `check_permissions{prompt:true}` →
  recheck rewrite and local `-32601` denials), 1 MiB client / 64 MiB server
  frame bounds, the `{"type":"ready","protocolVersion":2}` readiness frame,
  socket confinement to `/tmp/acu-*` with `control.sock`/`lease.sock` fixed
  names, and the 25 ms retry/backoff connect loop. `CuaDriverSession` is the
  MCP client over the bridge's stdio (initialize → tools/list → start_session
  → tool calls) with per-call timeouts, serialized queue, session-id
  injection, and the broken/closed lifecycle. `host.rs` (macOS) spawns the
  broker via `open` and the bridge with Node-compatible fd 3 (IPC socketpair)
  / fd 4 (readiness pipe); `binary.rs` pins the driver sha-256 + signing
  requirements.
- **Pure policy logic**: `safety.rs` (action normalization, blocked key/text
  payloads, approval summaries, per-generation one-use `ComputerUseGrantLedger`
  with sorted-key canonical JSON fingerprints), `generation_gate.rs`,
  `settings_core.rs` (durable disable-as-kill-switch coordinator, with a real
  `aiden_data::ConfigStore` wiring for `computerUseEnabled`), `status_core.rs`
  (revision-gated cached readiness service with fixed error-status mapping).
- **Foundation Models client** (`foundation_models.rs`): the file-exchange
  protocol (request.json ≤20 KB / response.json ≤64 KB / process-id / cancelled
  under a `aiden-foundation-models-*` 0700 tempdir, `open -W -n` spawner,
  helper pid SIGTERM termination, bounded stdout/stderr) plus the connection
  state machine (platform gate at macOS 26 + arm64, single-flight cached
  status, title generation with model_unavailable/assets_unavailable cache
  downgrade).
- Tests: 87 lib tests (safety/gates/settings/status/FM ported from the TS
  suites, JSON-RPC framing roundtrips, protocol message shapes, FM fixture
  transcripts, reconnect/backoff) + 4 integration tests against an in-process
  mock broker on a tempdir Unix socket speaking the guarded wire protocol. No
  real broker/driver/helper launches in tests.
- Verification: `cargo test -p aiden-computer-use` (91), `cargo clippy -p
  aiden-computer-use --all-targets -- -D warnings`, `cargo fmt -p
  aiden-computer-use -- --check`, and `cargo check --workspace` all pass.

### 2026-08-07 — GPUI port: shell integration wiring (Phase 6 wiring)

- Wired the previously standalone `rust/aiden-ui` surfaces into the app shell:
  an `AppView` router (`Chat | Scheduled | Usage | Subagents | Settings`) with
  a sidebar nav section + settings gear, the ⌘K command palette (snapshot
  `PaletteDataSource` over the chat service/provider catalog, settings-backed
  recency, palette commands routed onto shell services), the ⌘J terminal
  drawer (real PTY, created once and hidden/shown), the ⌘⇧D dictation pill
  (cached `WindowHandle` so re-invoking focuses instead of stacking), and
  first-run onboarding (completion callback closes the onboarding window and
  opens the main window).
- `Stores` gained shared `schedules` + `usage` Arcs; `SettingsServices::from_stores`
  now returns `Self` and reuses the shared schedule store; `StoreUsageSource`
  maps `aiden_data::usage_store` summaries onto the usage panel types;
  `StoreScheduledSource` feeds the scheduled panel from the real store.
- Found and fixed a real boot bug: the onboarding window's root view was
  `OnboardingView` without a gpui-component `Root` wrapper, and gpui-component
  `Input` elements call `Root::read` while painting — first-run boots panicked.
  The onboarding window now wraps the view in `Root` (completion is delivered
  via the `on_complete` callback since the root handle no longer targets the
  view). Onboarding panels/settings/pill `#[allow(dead_code)]` module flags in
  `main.rs` were removed; remaining demo-scaffolding items keep targeted allows.
- Verification: `cargo build -p aiden-ui`, `cargo test -p aiden-ui` (104 tests),
  `cargo clippy -p aiden-ui --all-targets -- -D warnings`, `cargo fmt -p
  aiden-ui -- --check`, and `cargo check --workspace` all pass; both onboarding
  (fresh config) and main-window (marker present) smoke boots are clean.

### 2026-08-06 — GPUI port: aiden-core domain expansion (Phase 4)

- Expanded `rust/aiden-core` with the dependency-free renderer/shared + chat
  policy contracts: `appearance.rs` (4 theme presets x light/dark with exact
  RGBA hex values, token resolution, strict parse/normalize), `keybindings.rs`
  (25-command catalog, accelerator normalization, V1 override document
  mutation/repair/migration that preserves unknown future fields byte-for-byte),
  `chat_title.rs` (title policy + routing), `chat_store_core.rs` (id/meta
  validation, staging filename contracts), `chat_workspace.rs`, `app_update.rs`,
  `dictation.rs`, `claim_check.rs` (hand-rolled matcher for the TS regex
  grammar since `regex` is outside the crate's allowed deps),
  `generation_thinking.rs`/`anthropic_thinking.rs`/`google_thinking.rs`/
  `codex_thinking.rs`, `provider_deployment.rs`, `subagent_runs.rs` +
  `subagent_management_v2.rs` (V1/V2 run snapshot state machines, strict
  exact-key parsers), `subagent_safe_text.rs` (bounded fail-closed port of the
  credential/path/env sanitizer — no `entities`/`remark` deps, so HTML entity
  decoding and the markdown AST check are conservatively approximated), and
  `assistant.rs` (fail-closed approval validators + canonical escaped JSON).
- TS tests ported as Rust `#[test]`s with identical expectations (appearance,
  keybindings, claim-check, title policy/routing, thinking levels, subagent
  runs/management, app-update, provider-deployment, assistant).
- `cargo test -p aiden-core` (111 tests), `cargo clippy -p aiden-core
  --all-targets -- -D warnings`, and `cargo fmt -p aiden-core -- --check` all
  pass. aiden-core stays pure: serde/serde_json/schemars/thiserror/chrono only.

### 2026-08-06 — GPUI port: aiden-data persistence layer (Phase 4)

- Ported the Electron main-process persistence layer into `rust/aiden-data`
  (synchronous; callers use background executors), keeping on-disk JSON
  byte-compatible with existing `~/.aiden` and `~/Library/Application
  Support/aiden-agent` installs: `data-store.ts`, `aiden-config-dir.ts`,
  `portable-config-core.ts`, `config-store-core.ts`, `chat-store-core.ts`,
  `schedule-store.ts`, `secret-map-core.ts`, `pi-credential-store-core.ts`,
  `mcp-oauth-store-core.ts`, `portable-config-watch-core.ts`.
- Chat history keeps the exact layout: `chats/index.json` + per-chat
  `<id>.json`, `.chat-transaction.<id>.pending` markers, crash-staging sweeps,
  corrupt-index quarantine + rebuild-from-payloads, and serialized RMW.
- Scheduled tasks keep `schedules.json` / `schedule-runs.json` with stored-task
  quarantine; croner's "5-or-6-parts" is replaced by a hand-rolled evaluator
  (the `cron` crate's numeric day-of-week ranges don't match croner's
  `0/7 = Sunday` convention).
- safeStorage incompatibility is documented and handled: Electron ciphertext
  cannot be decrypted outside Electron, so new secrets go into the macOS
  Keychain (`keyring` crate) under TS key names with a base64 marker
  (`base64("aiden-k1:")`) in the JSON slots; legacy safeStorage blobs are
  read-but-flagged `needs-rotation`.
- `cargo test -p aiden-data` (105 tests), `cargo clippy -p aiden-data
  --all-targets -- -D warnings`, and `cargo fmt --check` all pass.

# Project History

Major milestones only. Day-to-day changelog noise lives in git.

### 2026-08-06 — Subagent deadline reliability and proxy timeout audit

- Fixed a foreground-launch failure where the supervisor derived a fractional
  millisecond remainder from `performance.now()` and passed it to the strict V2
  authority parser, which correctly requires safe-integer budget values. The
  host now floors that derived deadline before authority minting, so valid
  no-capability scout batches launch without model-supplied resource fields.
- Clarified the model-facing subagent tool contract: run identifiers, timing,
  and resource budgets are host-owned and must never be supplied by the model.
- Kept the sole settlement timers for MCP inventory/read/mutation and web
  requests referenced until completion. A remote operation that ignores
  cancellation therefore yields the intended bounded result instead of leaving
  an awaiting caller unresolved as Node's event loop drains.
- Updated the direct MCP SDK to 1.30.0 with compatible transitive security
  fixes. `npm audit --omit=dev` is clean. The full subagent gate (including
  native helper suites), type-check, and lint passed.

### 2026-07-30 — Aiden Assistant Markdown and confirmed automations

- Removed the decorative brain glyph from provider reasoning disclosures while retaining
  the Thinking status, shimmer, disclosure semantics, and streamed reasoning content.
- Routed Assistant replies through the main chat's safe Markdown, code, math, copy, and
  streaming handoff path, including per-message raw-text fallback.
- Added attended-only project, MCP, and schedule identity tools plus approval-gated
  `schedule_task` creation for global, project, and exact MCP-scoped LLM automations.
  Read-only and Full access are explicit in the confirmation; scripts, run-now, pause,
  resume, removal, ambient dock tools, and recursive self-scheduling remain blocked.
  A main-owned execution profile bounds later runs and suppresses notifications for
  exact `[SILENT]` results.
- Added `edit_automation` for sparse, revision-checked changes to one exact Aiden-created
  task. The merged final task is confirmed through the same check/cross card and saved
  in place, while stale revisions fail closed instead of overwriting or creating a
  duplicate.
- Automation proposals are normalized before the owner-bound approval pause. The dock
  shows a human-readable schedule, exact prompt, fixed scope, and scheduler state with
  accessible cross/check decisions; Allow or Deny resumes the same agent run. Scheduled
  Tasks also exposes Create with Aiden/Create manually and exact MCP selection.
- Replaced the dock's fixed one-row input with the shared compact chat textarea and
  button primitives. Multiline drafts content-size, preserve line breaks, wrap long
  tokens, and become internally scrollable at a bounded height.
- Added focused policy, prompt, IPC, Markdown, lifecycle, accessibility, and icon
  regressions and registered the new UI suite in ordinary and coverage test commands.

### 2026-07-29 — README and roadmap reconciled with PR 4

- Rebuilt the public feature inventory from the current PR diff, including the
  Assistant dock, unified commands, native Subagents inspector, managed
  worktrees, dev/prod isolation, appearance hardening, and the in-app update
  prompt.
- Added an Upcoming section sourced from the active plan index and linked each
  direction to its canonical plan without presenting planned work as shipped.
- Re-audited every Upcoming claim against the branch. The public roadmap now
  distinguishes shipped skill discovery, Pi registry/auth/catalog refresh,
  deterministic compaction, and atomic chat storage from the narrower
  slash-selection, remote-overlay, provenance, checkpoint, run-control, and
  whole-app performance work that remains.
- Corrected the Dynamic Model Catalog and Pi Provider Integration plan status
  prose after source verification showed their device-local store, built-in
  registry, generic authentication, native routing, manual refresh, and voice
  credential slices were already implemented.
- Corrected the release status now that signed GitHub release assets and
  updater metadata are published.
- Archived the completed development/production coexistence plan and updated
  the plan index so finished work is not advertised as upcoming.

### 2026-07-29 — In-app update-ready banner

- Signed production builds now publish downloaded-update state into the main
  renderer, and the chat sidebar shows a compact semantic-token banner
  immediately above Profile and Settings.
- The banner names the downloaded Aiden Agent version and offers session-local
  Later plus Restart now actions. Malformed renderer payloads fail closed and
  development builds continue to avoid the production update feed.
- The visible update surface uses Aiden's app mark and the shared compact
  motion recipe: a 150ms bottom-anchored pop/fade in, a presence-preserving
  120ms fade out, and an immediate final state when Reduce Motion is enabled.
- Restart now uses Aiden's existing protected renderer unload, Computer Use
  durability, parent/child generation drain, and service shutdown before
  handing off to `electron-updater`; unsaved edits retain the normal keep or
  discard decision, while active saves and Git mutations block restart.
- Added shared-state parsing, IPC inventory, placement, action, lifecycle-order,
  branding, preflight, type, lint, and production-build verification.

### 2026-07-29 — Slash commands and active skill invocation planned

- Audited Pi's 22 core slash commands, its built-in Llama extension, and
  dynamic skill-command behavior against Aiden's actual command, composer,
  chat-turn, and skill-discovery architecture.
- Added the canonical phased plan for a composer-anchored Commands and Skills
  palette, including main-authoritative skill resolution, turn-scoped
  invocation, safe provenance, accessibility, and release gates.
- Implementation has not started; this milestone changes planning and project
  status only.

### 2026-07-29 — Portable provider migration preservation and stable CI gates

- First launch on a machine with a new local root now preserves valid provider
  intent already present in a copied `~/.aiden/config.json`; only local model
  discovery and secrets remain absent until that machine re-establishes them.
- Added a fresh-machine regression that verifies the copied provider remains
  listed and that the local seed marker is still recorded.
- CI now recognizes either valid grep traversal bound, and the Node-wrapped Git
  branch-race fixture uses an explicit test-only read budget rather than the
  production default that was too short under GitHub Actions load.

### 2026-07-28 — Native Subagents Phase 5 complete

- Phase 5 added strict packaged-artifact verification before every lifecycle
  launch, aggregate-only health evidence, fixed Send/Stop/Settings/quit smoke
  actions, and a default 100-cycle packaged soak.
- A quit receipt now stages before a revocable no-replace commit; a raced,
  timed-out, or failed finalization cannot become accepted clean evidence, and
  a true packaged-soak failure exits nonzero before later cleanup can mask it.
- Focused contracts, the aggregate Subagents suite, type-check, lint, strict
  package verification, a 3-cycle smoke, and the full 100-cycle soak passed.
  Two fresh final adversarial reviews were clean for lifecycle/receipt and
  per-cycle package-integrity behavior.
- The feature remains behind `AIDEN_SUBAGENTS_ENABLED=1` for the internal
  rollout decision. The explicitly deferred local-at-rest hardening remains
  out of scope for this single-user build.

### 2026-07-28 — Subagents inspector complete; verification begins

- Phase 4 delivered the accessible inline child chips and responsive Subagents
  destination in Environment, including the existing Aiden orb state treatment.
- The user explicitly chose to move this single-user build to Phase 5 rather
  than continue the local-at-rest redaction hardening review loop. The
  non-privacy native cleanup FIFO availability fix remains in scope and covered.
- Phase 5 now owns package verification, a packaged lifecycle soak, and
  privacy-safe aggregate health metrics before the internal opt-in expands.
- The soak foundation now has a strict packaged-only control/receipt contract,
  a local capability-authenticated provider fixture, and an explicit
  100-cycle outer controller; main-process driving and final metric wiring
  remain a separate integration step.
- The Phase 5 integration now drives only fixed Send, Stop, and Settings
  navigation actions through the normal renderer lifecycle, waits for Pi's
  real provider-response boundary before acting, and records a quit receipt
  only after parent generations and the child registry settle and aggregate
  health metrics flush. Parent shutdown is deliberately longer than a child
  cancellation drain so pre-registration tool construction can record a
  cleanup miss before a quit receipt is evaluated. A dropped aggregate write
  remains non-blocking for the live app, but permanently makes a packaged-soak
  snapshot fail closed rather than emitting stale clean evidence. At that
  checkpoint, package execution and the final fresh review gate remained pending.

### 2026-07-28 — Crash-resumable managed worktree cleanup

- Managed worktree deletion now binds the native helper's durable full-tree manifest digest into the v3 deletion journal before unlinking begins.
- Restart recovery resumes only missing entries from that exact authorized manifest; fresh/unbound manifests are discarded and rescanned, while added, modified, replaced, ignored, or ambiguous entries remain fail-closed for review.
- Nested in-progress removals use deterministic isolation aliases derived from the authorized manifest, recursive path binding, and entry identity, so a crash after a directory rename resumes only the exact captured tree.
- Manifest cleanup uses the native helper's identity- and digest-verified `.finalizing` and `.deleting` captures; TypeScript recovery delegates bound finalization to that same no-clobber protocol while keeping unbound inspection read-only.
- Missing cleanup roots now advance only after the exact sidecar path is durably absent. Bound manifest mutations transition atomically to review, bound I/O failures remain retryable, and unbound sidecar objects are preserved without being opened or removed.
- Root-absent bound-sidecar recovery delegates to the packaged native finalizer so every original, `.finalizing`, and `.deleting` transition uses no-replace renames rather than JavaScript's replace-on-collision rename semantics.
- Every remaining pathname unlink now atomically captures the just-validated manifest, isolated worktree entry, root directory, displaced run store, or cleanup entry under a fresh high-entropy name and revalidates the captured inode; replacements at the source boundary are preserved and reported as mutation instead of being removed.
- Private subagent-history deletion now treats a rejected write acknowledgement as indeterminate: a fresh durable read must prove the intent absent before the in-memory tombstone can reopen writes, while installed intents reject queued and restarted upserts until cross-store reconciliation completes.
- Native run-store acknowledgement now binds its post-rename descriptor to the exact requested bytes with an identity-bracketed read, then retains that ctime-aware baseline so same-inode, same-size, restored-mtime replacements fail closed.
- Private-history tombstones now revoke queued and in-flight reads as well as writes; durable absence verification releases settled memory-only tombstones so a proven pre-install failure cannot permanently deny a surviving chat.
- Pending chat-deletion recovery markers normalize valid identifiers and duplicates before their hard cap, preserve valid markers across malformed run data, and fail closed rather than dropping over-cap or structurally malformed recovery state.
- Every schema-valid chat index entry is now rebound to an exact same-ID payload and payload-derived metadata; missing, mismatched, and stale ghosts are repaired while operational payload I/O leaves the valid index intact for retry.
- Renderer-visible subagent snapshots now redact lower- and mixed-case POSIX shell assignments through projection, strict parsing, persistence, and replay while retaining source-code, math/label, HTML/URL, and complete Base64 controls.
- Lower- and mixed-case shell assignments no longer inherit HTML treatment from an arbitrary unmatched angle bracket; only completed, unquoted tag attributes and real HTTP queries remain controls, while bounded arrow/callback/destructured default parameters remain readable source code.
- Native run-store destination reads now use nonblocking opens before descriptor validation, so a hostile writerless FIFO at `runs.json` fails closed as `destination_changed` rather than stalling reads or expected-generation writes.
- Native cleanup now opens owned-looking stale `.tmp` and `.cleanup` candidates nonblocking before validation, so a hostile FIFO is skipped promptly without weakening regular-file capture or replacement-race checks.

### 2026-07-26 — Aiden settings and canonical command system

- Added a truthful Aiden Settings section for the shipped dock: global-shortcut status, composer-model behavior, local history, current access boundaries, and explicit proactivity status.
- Replaced fragmented keyboard listeners and hotkey persistence with one typed command catalog, one renderer dispatcher, transactional global registration, versioned legacy migration, and a searchable canonical Keyboard Shortcuts editor.
- Added the Command-K palette for commands, chats, models, providers, Settings destinations, and immediate appearance changes. Native menus, visible hints, ARIA metadata, and custom chat-jump modifiers derive from the same bindings.
- Model selection now synchronizes across the composer, Aiden, and the palette; window-ready handshakes protect cold-start global and native-menu commands.
- Adversarial hardening added document-owned recorder suspension, reload-safe readiness generations, native-menu-aware conflict validation, scoped command availability, and partial-response preservation on Assistant errors.
- Further adversarial loops serialized all Appearance writers under revision ownership, made delayed native-theme events environment-only, gated startup shortcut state, hardened IME and assistive-technology behavior, and verified V1 shortcut repair through randomized convergence tests.

### 2026-07-26 — Provider identity across model surfaces

- Added compact, theme-safe provider marks to Pi/custom provider Settings, the ChatGPT/Codex and Apple Foundation Models cards, the composer model trigger/list/details, Model Pad settings, and the private usage scoreboard.
- Model surfaces use Claude and Grok product marks only for their exact first-party provider IDs; aggregator, unknown, Radius, custom, and future providers retain their own mark or a neutral initial fallback. Local/hosted deployment text remains visible after replacing the generic CPU/cloud glyphs.
- SVGs are bundled through explicit Vite URLs, with multicolor/opaque marks isolated as images and monochrome marks as semantic-color masks. Wide official wordmarks were cropped to compact logomarks, and an incorrectly collected OpenAI-as-Cerebras asset was replaced.

### 2026-07-27 — Whole-app performance and stability audit

- Audited Electron main/native lifecycles, renderer rendering/streaming, storage, IPC, networking, background services, and packaging with three independent lanes plus a cross-cutting baseline.
- Confirmed release-priority risks in non-atomic chat persistence, unbounded attachment/history/voice payloads, synchronous local transcription, perpetual streaming RAF work, aggressive Git polling, incomplete MCP/tool cancellation, and crash/schedule lifecycle ownership.
- Added the versioned performance, stability, battery, and efficiency master plan. No runtime fixes were made in the audit pass.

### 2026-07-29 — Development and production app coexistence implemented locally

- Added a pre-main runtime-profile bootstrap so the development app identifies
  itself as `Aiden Agent Dev` before the single-instance lock, while production
  keeps the existing `Aiden Agent` identity and data locations.
- Development now uses independent Application Support, portable config,
  session, log, and crash roots; an explicit absolute `--user-data-dir` remains
  authoritative, while empty or relative overrides fail closed.
- Development global shortcuts default off unless explicitly opted in, updater
  eligibility is production-only, and the Dock, menu, About panel, page title,
  executable, helper apps, and bundle identifiers carry visible development
  branding.
- The cached macOS development wrapper now binds every executable Electron code
  artifact and helper architecture into its identity, validates all branded
  plist fields and architectures, and requires a strict deep-valid signature.
- Controlled development launches confirmed the isolated paths and left the
  installed production app untouched. Focused runtime/branding and soak
  contracts, type-check, lint, build, wrapper generation, and the full test
  suite passed.
- Two adversarial review rounds found and drove fixes for explicit user-data
  preservation, cache/layout binding, helper branding, empty override handling,
  complete Electron code identity, and helper architecture validation. A wholly
  fresh final runtime reviewer and packaging reviewer both returned clean.
- The implementation and active coexistence plan remain intentionally
  uncommitted at the user's request.

### 2026-07-29 — Shared modal motion and elevation corrected

- Every application modal now preserves the visible workspace without a dim or
  blurred curtain, while the overlay continues to own pointer modality.
- Shared dialogs, alerts, and Command-K fade and scale from 90% to 100% over
  10ms without animating position; closing uses the inverse fade/scale and
  Reduce Motion continues to suppress both transitions.
- Modal-only elevation is slightly stronger in light and dark themes so
  floating dialogs remain visually distinct without altering the Environment
  summary or side panel's original shared elevation.

### 2026-07-29 — Native Subagents rollout enabled

- Native Subagents now default on after the completed Phase 5 packaged soak,
  so the tool and the Environment capability are available in ordinary
  development and production launches without a hidden opt-in.
- The Environment summary's existing live orb/count opens the Subagents
  destination, where the active/done roster and latest sanitized activity are
  visible for the current chat.
- `AIDEN_SUBAGENTS_ENABLED=0` remains an emergency rollback switch that
  disables both the model-facing tool and renderer entry together.
- A registered source-contract regression covers the shared motion, transparent
  overlays, theme shadows, and reduced-motion gates. Focused motion, preflight,
  Command-K, type-check, lint, build, and diff validation passed.

### 2026-07-29 — Whole-app theme integrity hardened

- Audited the main renderer, settings, provider surfaces, persistent dictation
  pill, semantic CSS tokens, and custom-theme runtime with independent token,
  component, and propagation reviewers.
- Resolved primary, secondary, tertiary, status, syntax, terminal, focus, and
  filled control colors against canvas, sidebar, and raised surfaces for every
  built-in light/dark pair and safe custom themes. Named light accents were
  minimally corrected where their sidebar contrast missed 4.5:1, checked
  switches use the derived on-accent color, and the shared focus ring overrides
  local outline resets. Toolbar icons now use a resolver-owned 3:1 semantic
  token. New installs use explicit diff symbols, while existing saved
  preferences remain unchanged.
- The reused dictation pill now reconciles validated persisted appearance and
  responds live to storage, system scheme, high-contrast, reduced-motion, and
  visibility changes without exposing theme mutation through its restricted
  preload. Main owns the latest safe debounced preview until its matching save
  lands, broadcasts that effective appearance to hidden auxiliary windows, and
  serves it to late-created windows. Full Appearance Settings and Command-K
  claim that same preview ownership before saving, so a newer direct commit
  cannot be masked by an older debounce. Main-window startup and Appearance
  Settings reopening also hydrate from that effective owner, including after a
  failed save, so the app and pill cannot diverge. Pending metadata remains
  explicit: reopening Appearance reclaims and retries an unsaved preview rather
  than silently marking process-memory state durable. The pill gates its first
  dictation content frame on authoritative hydration and never repaints from a
  stale origin-local cache on reuse.
- Ant Ling now follows semantic icon color in dark mode, and provider icon wells
  use the declared `well` surface instead of an undefined utility.
- Added regression matrices and pill/provider contracts. Focused tests,
  preflight, Command-K, type-check, lint, production build, detector, and live
  light/dark/focus checks passed. The work remains uncommitted.
- Focused controls intentionally suppress CSS outlines app-wide. Existing
  caret, fill, border, selection, and state changes remain, but no button,
  field, disclosure, or other interactive element receives an outer outline.

### 2026-07-29 — Native Subagent identifier allocation hardened

- A production subagent call could fail before launching with
  `Invalid renderer-safe subagent snapshot.` when the privacy scanner
  interpreted a random UUID substring as reversibly encoded private text.
- The supervisor now rejection-samples its internally generated run/child UUID
  until both identifiers pass the unchanged renderer-safe parser. This keeps
  strict validation for renderer-, workspace-, and persistence-derived
  identifiers without making random child startup probabilistic.
- A deterministic regression covers the captured false-positive UUID. The full
  Subagents gate, native run-store suite, type-check, scoped lint, and diff
  validation pass.

### 2026-07-29 — GLM subagent invocation and stream limits repaired

- A live GLM 4.7 response made four pre-launch attempts that failed role
  validation before any run existed. The provider-facing role schema used
  TypeBox's `anyOf` plus `const` representation; it now publishes one flat
  string `enum`, while the independent exact runtime parser remains unchanged.
- The first launched scout later failed after 512 events even though it was
  within the turn, tool-call, output, and deadline limits. Text-delta chunking
  no longer counts toward the lifecycle-event guard because output characters
  already have their own strict cap; lifecycle/control events remain bounded.
- The live development main process predated the safe-UUID fix, so a terminal
  projection failure could reject its parent group while a sibling remained
  active. Restarting onto the current build loads safe identifier allocation,
  and startup reconciliation converts the crash-left active record to
  interrupted before the renderer opens.

### 2026-07-29 — Portable provider-config startup hotfix prepared

- Diagnosed the installed app's launch failure as a split-config migration
  assuming `providers` was always an array. Missing or malformed portable fields
  could throw before the main window and updater started.
- Portable config reads normalize missing fields, writes normalize inside their
  serialized transaction, and malformed valid-JSON data remains untouched while
  the app boots with safe in-memory defaults. Local settings and regenerable
  cache stores also normalize valid JSON with invalid root shapes.
- First-upgrade migration repairs missing portable fields individually, restores
  matching model cache without overwriting newer cache, and defers archiving the
  legacy source when the portable root or a present field is unsafe.
- Provider-ID cache re-homing is retry-safe across an interrupted portable
  write, preserves a newer destination cache, and rejects duplicate portable
  provider IDs before two endpoints can share one cache identity. Malformed
  legacy settings normalize before same-process settings consumers run.
- Unsafe portable data now makes migration explicitly deferred and all config
  writes remain blocked until a later successful migration, preserving the
  unarchived legacy source. Legacy archives publish atomically, malformed nested
  caches recover from legacy data, and workspace/MCP/skill entries are validated
  before reaching consumers.
- Archives left incomplete by older builds are never trusted or overwritten; a
  byte-identical archive is accepted, otherwise the complete current source is
  atomically preserved under a second recovery name. Routed provider, MCP,
  skill, and workspace identities must be unique, model metadata is validated
  through nested fields, and aliased caches merge models and metadata separately.
- Symlink archives are treated as unusable and receive a durable recovery copy.
  Corrupt portable files remain write-protected after migration and reload;
  unsafe workspace records remain read-only on disk. Alias maps are nonempty and
  acyclic, secret migration uses only inactive-source to active-target routes,
  every historical cache alias is folded, valid legacy siblings are salvaged,
  and model IDs are normalized to unique nonempty values.
- Regression coverage includes missing providers at startup and after reload,
  partial migration, interrupted cache migration, malformed roots and provider
  entries, byte-preserving failure behavior, and same-ID endpoint mismatches.
- The affected older build still exits before its delayed updater check, so
  users already in the broken state must install the hotfix build manually.
- Final adversarial review caught and closed eight additional boundaries:
  writes now re-read the portable file inside the mutation queue; unsafe
  pre-marker workspaces defer migration; alias chains resolve to their terminal
  provider; portable cache fields cannot bypass local cache validation; workspace
  paths must be absolute; malformed known settings fields are dropped; and
  prototype-sensitive provider IDs and inherited alias properties are handled
  with explicit own-property semantics.
- A later fresh review tightened those boundaries further: portable writes now
  compare exact loaded bytes immediately before rename and reject both first-save
  and mid-mutation external changes; provider-ID generation reserves alias graph
  nodes; remembered providers resolve through terminal aliases; nearer alias
  caches win over older ancestors; secret and thinking-preference dictionaries
  use own-property-safe storage; and future nested settings versions survive
  unrelated writes.
- The final pre-release review replaced the remaining check-then-rename window
  with no-overwrite publication, made initial loads and reloads race-safe, fsynced
  archive data and directory entries, reused complete recovery archives, and
  blocked every settings/workspace/portable write when an already-migrated
  portable document is unsafe. Legacy providers now survive missing or malformed
  model arrays, provider URLs reject credentials/query/fragment state, active
  provider IDs cannot also be alias sources, production secret maps preserve
  prototype-sensitive IDs, and startup never downgrades a future keybindings
  document.
- A subsequent fresh pair blocked release again on held-inode edits, local
  migration source races, corrupt settings normalization, crash durability, and
  nested forward data. Protected publication now rechecks the displaced inode;
  local migration retries after exact-source conflicts and preserves a complete
  recovery archive; invalid settings boot through a safe runtime projection but
  remain read-only; persistence retains unknown assistant/thinking members; and
  config plus provider-key writes fsync staged data and parent directories before
  acknowledging success.
- The last frozen-target review added interruption recovery and object-local
  forward compatibility. Startup now restores crash-orphaned held files before
  defaults can load, retains the displaced inode under a durable previous name
  so late descriptor writes remain recoverable, and creates README files
  exclusively. Assistant, thinking, MCP, skill, keybinding, and structured
  secret records preserve opaque future members during current-version edits.
  Provider credentials use endpoint-aware rollback when a config save fails,
  while MCP credentials are cleared only after the fallible config mutation has
  committed.
- A release-blocking pair then found that ordinary protected writes retained
  every predecessor, credential mutations still had process-exit gaps, dangling
  symlinks looked absent, malformed encrypted stores were writable, late legacy
  additions stayed archive-only, and full preference maps dropped one sibling.
  Held filenames now carry their expected hash so unchanged predecessors are
  removed while changed ones become explicit conflicts. Provider save/removal
  uses an encrypted restart journal; MCP removal/OAuth disable uses a durable
  non-secret cleanup intent; both reconcile only against authoritative config.
  Secret and OAuth stores reject malformed roots on mutation, migration replays
  non-conflicting late additions, dangling config symlinks defer safely, and
  full-capacity thinking updates preserve every unrelated model.
- MCP OAuth mutations now fsync both staged ciphertext and the containing
  directory before cleanup intent is cleared, so a power loss cannot acknowledge
  credential deletion while leaving the old encrypted session recoverable.
- Two independent release reviews found six further blockers. Provider-secret
  migration now fails soft and retries without blocking startup; credential
  journals remain pending across ambiguous config errors and reconcile only
  after an authoritative reload; direct provider and MCP preset key writes share
  their transaction queues and reject absent config records; MCP cleanup aborts
  the active OAuth generation and stale writes are guarded inside the encrypted
  store queue; decrypted OAuth sessions are structurally validated; and unknown
  future top-level enum strings remain persisted while runtime consumers see
  only current values. Preset setup now saves config before its encrypted key.
- Follow-up call-path review extended OAuth epochs to background refresh
  providers, routed every MCP save through the cleanup queue, and made internal
  provider-journal reads strict. Cleanup can now supersede all stale token
  writers, stale config saves cannot race removal, and unreadable encrypted
  journal state is never treated as absence.
- The final hotfix hardening pass binds provider keys to encrypted endpoint
  snapshots, quarantines credentials after safe external provider/MCP edits,
  suspends and re-invalidates OAuth generations around cleanup, and carries
  renderer-document ownership through provider/MCP queues and secret writes.
  MCP cleanup journals now record exact previous and target connections, and
  OAuth setup persists its connection before opening a browser.
- Unusable portable roots now defer into read-only defaults instead of aborting
  startup. Valid-but-unsafe local workspace files reject later writes, future
  assistant/keybinding/scheduler values survive unrelated edits, and scheduler
  IPC writes only fields explicitly supplied by the caller. The full test suite,
  type-check, lint, and production build pass on the final candidate.
- The final blocker-fix round stopped implicitly binding legacy unbound
  credentials to whatever endpoint currently shares an ID. Provider and MCP
  API-key credentials now require an encrypted connection binding and fail
  closed when that binding is missing; affected users may need to enter those
  keys once after installing the hotfix. MCP authorization reserves its OAuth
  generation during serialized admission, releases the global queue before the
  browser flow, and aborts immediately when its renderer owner is replaced.
- Protected config publication now rechecks renderer ownership at every commit
  boundary and retains the displaced inode as a bounded `.previous` candidate
  for the process lifetime. A later startup removes unchanged predecessors and
  preserves late descriptor edits as explicit conflicts without resurrecting
  intentionally deleted config. Recovery ignores symlinks and special files.
  Migration retry also merges late legacy settings, and credential cleanup
  journals retain only hashes of MCP environment and header maps.
- The final adversarial re-review moved canonical config and credential reads
  onto no-follow, nonblocking, descriptor-verified regular-file reads so FIFOs
  cannot hang startup and symlinks cannot be replaced accidentally. Archive
  mismatch is migration evidence only when the archive is a complete usable
  snapshot, preventing a truncated canonical archive from resurrecting data via
  an older recovery copy.
- MCP cleanup intent is now derived from the exact config observed inside its
  serialized admission. OAuth reauthorization stages replacement tokens in
  memory and commits them only after verification, preserving the prior durable
  session when authorization is cancelled or fails. Provider and MCP identifier
  bounds now match their cleanup-journal schema, and known keybinding entries
  retain future nested fields through edit, reset, and repair.
- A further two-reviewer gate found and closed six release blockers. Provider
  rotation now reads only keys bound to the authoritative current endpoint and
  quarantines mismatches. In-flight MCP connections are generation-bound so a
  save or removal can never let an older connection repopulate the cache.
  Portable mutations validate their final shape before publication, and held
  special files are restored with their original topology after path swaps.
- Split migration archives the exact bytes originally loaded rather than a
  later live pathname, so edits between split publication and archive creation
  remain detectable and recoverable. Generated provider IDs, provider URLs and
  keys, and provider-alias count/depth now share explicit schema bounds; alias
  validation and route construction use memoized linear resolution.
- The last blocker round made generation-bound MCP cancellation close a pending
  client again after `connect()` settles, because an early close can be a no-op
  until the transport is ready. OAuth resource bindings retain query identity
  while discarding fragments, preventing tenant-bearing endpoints from sharing
  sessions. Direct provider-key writes now use the same key bound as the
  rotation journal.
- Provider alias migration flattens historical routes to the new terminal while
  retaining pre-flatten routes for nearest-cache precedence, and its complete
  output is revalidated before publication so maximum-count input cannot gain
  one unsafe alias. Protected directory swaps use no-overwrite recursive
  restoration; hard links are reserved for file-like objects.
- The next independent release gate rejected lossy UTF-8 decoding, unbounded
  predecessor retention, incomplete special-object crash recovery, stale MCP
  admission, late OAuth/status connections, a preset-key bound bypass, an
  undersized provider-rotation journal, and local future-field loss. Regular
  reads now decode UTF-8 fatally while DataStore retains exact source buffers;
  an initial 32-predecessor cap was later removed after proving it created a
  deterministic write outage; and startup restores crash-held symlinks, FIFOs,
  and directories without following or overwriting.
- MCP agent and status connections reserve generations while their exact config
  snapshot is admitted, recheck during auth resolution, and close again after a
  cancelled connect settles. OAuth session reads serialize behind mutations and
  prove their lease before and after decryption. Provider-key length validation
  is central, while the independently validated rotation journal has a larger
  whole-record bound. Split migration preserves unknown local top-level fields.

### 2026-07-29 — Portable-config startup hotfix final reconciliation hardening

- Unsafe portable reloads no longer replace the last successfully reconciled
  provider/MCP snapshot. A later valid repair reconciles from that last-known
  safe state even when its normalized content equals the fail-soft defaults,
  and failed side effects remain pending for retry. Cached safety checks are
  deliberately non-reloading so they cannot consume the one disk-change signal
  before the composed watcher captures and reconciles it.
- MCP credential identity remains narrowly scoped to secret cleanup, while a
  separate complete runtime identity includes name and enabled state for
  admission and invalidation. External disables and renames now cancel pending
  connections and OAuth work without deleting unchanged credentials.
- External provider edits move exact endpoint-bound credentials into one
  encrypted quarantine slot instead of deleting from stale snapshots. Returning
  endpoints swap their matching key back into the active slot on reload or
  restart, while every read remains bound to the exact provider connection.
- Pre-binding custom-provider keys are preserved in encrypted quarantine rather
  than deleted. Legacy API-key MCP presets adopt their old ciphertext only after
  the configured preset identity and catalog-owned HTTPS origin are validated.
- Protected config publication retains every displaced inode for the process
  lifetime without a write-count ceiling. On the next launch, unchanged
  predecessors are removed and edits made through any older descriptor are
  preserved as conflicts.
- MCP cleanup journals resolve conservatively when an external file skips past
  their target: any authoritative identity other than the prior connection
  clears stale credentials and allows later edits to proceed.
- Fully reconciled app-authored provider/MCP mutations advance the watcher's
  last-safe credential snapshot. A later external removal or retarget in the
  same process therefore invalidates connections added through Settings.
- Pre-binding custom-provider keys use a recovery slot separate from rotating
  endpoint-bound keys. If that legacy slot is already occupied, provider
  mutation fails closed before either ciphertext can be deleted.
- Provider alias secret migration moves only recognized string ciphertext and
  preserves unknown future-shaped source or destination records.
- Legacy Pi credential import now waits for safe portable aliases and completed
  encrypted alias reconciliation, so an old built-in-looking key can never be
  rebound from an unresolved custom endpoint. Provider rotation journals also
  converge across A to B to C edits by clearing an ambiguous staged credential.
- Every provider-list consumer now enters legacy Pi credential migration through
  one readiness-gated wrapper. Migration-proven custom-provider keys receive an
  exact encrypted endpoint binding in the same durable publication that moves
  the key; conflicting or future-shaped source/destination records remain
  untouched, unbound, and keep migration deferred, including custom aliases
  that reuse the `gemini` ID.
- MCP preset key replacement now disconnects the admitted runtime connection
  inside the same serialized credential mutation. Durable OAuth replacement
  rechecks generation ownership after publication and restores the exact prior
  token map if ownership changed or publication failed.
- A retained OAuth transport lease remains current after its pending connection
  is promoted into the cache, with the exact connected record owning that lease
  until disconnect, replacement, or generation invalidation.
- App-authored portable snapshot sync reconciles from the prior last-safe
  baseline before advancing it. An unrelated external endpoint edit absorbed by
  the mutation's own disk reload therefore still invalidates stale runtime
  connections.
- Provider, MCP, and Skill portable writes now share one outer mutation/snapshot
  transaction. Inner credential queues release before snapshot reconciliation
  can re-enter them, preventing self-deadlock while ensuring every portable
  writer reconciles unrelated external edits before returning.
- The outer transaction seeds or reconciles the cached snapshot before its
  first portable mutation, so that mutation cannot absorb an external endpoint
  edit before any last-safe baseline exists.
- Watcher-triggered pending-journal recovery uses the already-selected cached
  portable projection instead of consuming a newer disk edit behind the
  transition being committed. Any follow-up cached projection is reconciled
  before the last-safe baseline advances.
- Converging alias credentials are preflighted as a group and moved plus bound
  all-or-none in one encrypted-store publication. Corrupt JSON, invalid UTF-8,
  FIFOs, and directory-backed portable roots stop seeding before any secret
  migration can run.
- Legacy archive validation now decodes UTF-8 fatally, and current-version
  keybinding normalization, mutation, reset, and repair preserve unknown root
  fields as well as unknown command fields.
- Final local verification passed 216 portable/config regressions and 52
  credential-recovery regressions, TypeScript, lint, `git diff --check`, the
  complete `npm test` matrix, 32 native remover tests, 41 Rust broker tests with
  fmt/clippy, the production build, development package, hardened package
  verifier, and renderer-ready packaged boot smokes for missing, FIFO,
  directory, and invalid-UTF-8 portable config paths. The final smoke evidence
  is `/var/folders/g1/zzchcsk55fvfjq8bpg8w3qj00000gn/T/aiden-hotfix-smoke-LL2bFE`.

### 2026-07-30 — Homebrew install documented without docs-only releases

- The README now puts the public Homebrew cask command directly below the
  product description.
- Pushes to `main` that contain only Markdown, `docs/` content, or release
  workflow changes no longer run the DMG release pipeline. Manual release
  dispatch remains available, and any source-bearing push still releases.
- Published GitHub Releases now retain the Aiden beta introduction and append
  GitHub-generated notes for changes since the previous release. Release tags
  are explicitly bound to the workflow commit that produced the verified
  artifacts.
### 2026-07-25 — Portable `~/.aiden` config

- Config split into a portable half and a machine-local half. `~/.aiden/config.json` (override `AIDEN_CONFIG_DIR`) is the hand-editable source of truth for provider intent, aliases, MCP servers, and skills, seeded with a README and re-read on window focus / power resume; a real change broadcasts `app:config-externally-changed` so the renderer refetches. UI settings moved to `userData/settings.json`, model discovery caches to `userData/provider-model-cache.json`; workspaces and `seeded` stay in `userData/config.json`. Secrets never move.
- One-time migration consumes the pre-split `userData/config.json` (renamed `.pre-aiden-dir`) and records `aidenDirMigratedAt`, so deleting the portable file yields defaults instead of resurrecting the pre-migration provider, MCP, and skill lists.
- `DataStore` gained atomic staged-temp + rename writes and an explicit serialized `reload()`; `load()` still never re-reads. `config-store` and the split moved behind injectable cores so both are tested without Electron.

### 2026-07-25 — Pi-native provider selection

- The provider Settings view now keeps the core Pi providers plus OpenCode Zen/Go, Z.AI Coding CN, and Kimi for Coding in a deliberate front group. The remaining current and future Pi providers are hidden behind an accessible **Show more providers** disclosure, without changing their Pi-native setup or transport.

### 2026-07-24 — Environment inline/overlay fit; Gemini native; Activity trails

- Local LLM cold starts show **Model loading…** (Ollama `/api/ps`, LM Studio loaded state) instead of Thinking until weights are in memory; parallel JIT + poll; `chat:status` phases. Providers gain optional `deployment: local | hosted` (editor control; Tailscale/custom default local).
- Environment Review/Files now stay inline whenever a min-width panel still leaves the 560px conversation floor, shrinking a wider saved width first; overlay is fit-based (not SplitView's 700px sidebar chrome).
- Gemini Phases 0/1/3 landed: catalog-driven runtime limits, Pi native `google` transport with legacy `gemini` migration, per-model Thinking control, and bounded workspace context caching.
- Reused the Thinking control for exact Anthropic and ChatGPT/Codex models from Pi metadata (hidden `minimal` alias; defaults High / Medium).
- Per-response Activity trails from the renderer-safe generation timeline, with append-only `unverified_success` when success prose conflicts with a failed action.
- Activity trails became a borderless **live ticker** (Cursor-style): three rows, newest rising in from blur while older lines drift up under a fade mask, collapsing at settlement to one deterministic summary ("Explored 8 files, 4 searches, ran 1 command") that expands to the flat trail. Timeline v2 adds reasoning steps timed host-side from pi's `thinking_start`/`thinking_end` and a per-tool `detail` line; `run_command` now takes a model-authored `description` so the feed can name intent while the command itself still never reaches the timeline.
- Same-repository GitHub beta release path replaced the separate public-binary-repo design; publication still gated on credentials and `RELEASES_ENABLED`.
- Chat switching is state-driven, not mount-driven: dropped the route-level `key={chatId}` that remounted `ChatPane` (its own `chatId` layout effects already reset stream/timeline/approvals), keyed only `Composer` for drafts, settled `ScrollArea` scroll before paint, and prefetched transcripts on sidebar hover/focus.

### 2026-07-23 — Scheduled Tasks Phase 4; dictation; MCP presets; context compaction

- Scheduled Tasks shipped through Phase 4: main-process cron, script/LLM modes, `/scheduled`, approval-gated `schedule_task`, notifications, quarantine for invalid tasks.
- Global dictation pill pastes into the focused app (Accessibility + AppleScript); MCP preset catalog (Composio, Notion, Linear) with encrypted keys / OAuth.
- Model-aware Pi `transformContext` compaction for tool-heavy generations; local-model reasoning surface for LM Studio/Ollama; streaming reveal hardened for fast local replies.
- Established `0.27.x` beta line and branded DMG installer layout.

### 2026-07-22 — Computer Use Phases 1–4; Appearance; publishing; public readiness

- Pivoted Computer Use to exact-pinned external `cua-driver` + Rust broker (archived prior Pi/Swift prototype). Foundation, Hermes-style adapter, fail-closed global/chat gates, and packaged acceptance completed.
- Appearance workbench: paired light/dark presets, semantic tokens, Dock icons, Reduce Motion.
- Branded publishing, packaged-only `electron-updater`, gated release workflow; README/public-readiness pass. Designer Mode blocked on Phase 0 preview/identity proofs (no runtime yet).

### 2026-07-21 — Codex Pi-native auth; usage profile; Apple titles

- ChatGPT/Codex sign-in via exact-pinned Pi `openai-codex` with encrypted OAuth in main only.
- Private device-local usage ledger and Profile share card (aggregate-only).
- Apple Foundation Models on-device chat titles + Rename with Apple.

### 2026-07-20 — Model metadata offline; Environment; Model Pad; Git worktrees

- Offline model metadata: local discovery → Artificial Analysis user cache → bundled models.dev; no runtime public catalog.
- Environment summary card + Review/Files workbench; spatial Personal Model Pad; managed Git worktrees and hardened Git IPC.

### 2026-07-19 — UI trust polish; workspace plate; Pi provider plan

- ChatGPT/Codex-inspired UI/trust polish; new-chat workspace plate and `~/aiden` scratch folders.
- Wrote `docs/plans/pi-provider-integration-plan.md` (broader registry migration; not fully implemented).

### 2026-07-18 — Electron independence

- Replaced hosted runtime with repository-owned Electron; rebuilt macOS UI primitives; preferred-editor control; chat titles; workspace terminal drawer.
- Renamed and republished as Aiden Agent on `https://github.com/sambitcreate/aiden-agent`.

### 2026-07-17 — Agent foundation

- Workspace coding agent (permissions, tools, Pi loop), MCP/Skills/Exa/attachments, on-device Parakeet voice, chat/settings foundation.

### 2026-07-30 — Canonical GitHub main and local worktree cleanup

- PR 6 merged the public Homebrew install command, documentation-only release
  suppression, and GitHub-generated release notes into the official repository.
- `/Users/sambitbiswas/projects/aiden-macos` is the sole registered worktree,
  its only local branch is `main`, and that branch is synchronized exactly with
  GitHub `origin/main`.
- The fuller Assistant-worktree history and the canonical checkout's older
  milestones were merged into this ignored local history file before cleanup.
  Unmerged legacy refs plus the dirty provider worktree were preserved in the
  verified sibling recovery archive before their worktrees and local branches
  were removed.

### 2026-08-07 — GPUI port: aiden-agent crate (assistant + coding tools + agent loop)

- Ported `main/services/assistant/` + `coding-tools.ts` into
  `rust/aiden-agent` (8 modules, ~5.9k LOC, 51 tests): system prompt builder
  (byte-preserved persona + `[SILENT]` contract), attended tool-error guard,
  workspace-confined coding tools with real `tokio::fs` execution and JSON
  Schema params, `list_mcp_servers`/`list_projects` identity tools, the
  automation runtime contract (coding-tools-only project automations, renderer
  cannot request internal modes), and an `AgentRunner` that drives
  `aiden_providers::Provider` streams over a `tokio::sync::mpsc` channel of
  unified `AgentEvent`s. Streams never throw — every provider failure is a
  terminal `Error` event. Shell tool runs `tokio::process` behind an
  `ApprovalPolicy` trait whose crate default denies everything mutating (UI
  wires approval later). Verified: `cargo test -p aiden-agent` (51 passed),
  `cargo clippy -p aiden-agent --all-targets -- -D warnings` (clean),
  `cargo fmt --check` (clean). Notable deviations documented in
  `.papercuts/troubleshooting.md`: parent grep uses RE2 semantics (no JS
  lookbehind), Node-style `path_relative` needed on macOS `/var`→`/private/var`
  skew, and `.await` on mpsc sends is easy to drop silently.

### 2026-08-07 — GPUI port: aiden-git crate + aiden-data usage/profile/external-editors

- New crate `rust/aiden-git` (9 modules, ~7.0k LOC, 32 tests): port of
  `main/services/git.ts`'s core surface. `GitService::run` mirrors the TS
  runner (argv-only, env scrub of `GIT_DIR`/`GIT_CONFIG_*`, isolated process
  group, 1 MiB output cap, 4s/20s/120s read/mutation/push timeouts with
  SIGTERM→SIGKILL grace), `GitRepo::resolve` asserts the repo root before any
  command, and mutations serialize per common-dir. Modules: `status`
  (porcelain v2 parse + granular staged/unstaged/untracked/conflicted counts),
  `branch` (list/checkout/create), `diff` (review snapshot fencing, per-file
  diff, numstat, comparison), `commit` (isolated-index commit with
  `.git/index.lock`, hooks, CAS `update-ref`), `push`/`pull` (reviewed push
  capability + endpoint-frozen push, optional `--force-with-lease`,
  `--ff-only` pull), `worktree` (list/add/remove with `aiden-owner` marker +
  dev/ino pinning), `error` (typed `GitError` + stderr→auth/conflict/dirty
  classification).
- `rust/aiden-data` additions (3 modules, ~2.6k LOC, 20 tests):
  `usage_store.rs` (usage-store-core.ts: tolerant `usage.json` normalization,
  per-day×source×provider×model buckets, calendar streaks, 7d/30d/90d/1y/all
  summaries for the heatmap/scoreboard views), `profile.rs` (profile.ts +
  profile-core.ts + profile-share-core.ts + profile-share-files.ts: name
  normalization/validation, `/usr/bin/id -F` display name, PNG share-image
  decode/validate with CRC chunk walk, private temp share files + stale
  cleanup), `external_editors.rs` (external-editors.ts: 31 editor definitions,
  resolution/ranking, spotlight query, argv-only `open -b` launch).
- Workspace: added `aiden-git` to members + `workspace.dependencies`, and
  added the previously-missing `aiden-mcp` workspace dependency (pre-existing
  uncommitted `aiden-ui` work referenced it, breaking `cargo check --workspace`).
- Verified: `cargo test -p aiden-git -p aiden-data` (157 passed),
  `cargo clippy -p aiden-git -p aiden-data --all-targets -- -D warnings` (clean),
  `cargo fmt --check` (clean), `cargo check --workspace` (passes).

### 2026-08-07 — GPUI port: main-process services (web-search, artificial-analysis, approvals, quit/readiness, dev-log, llm-client orchestration)

- `rust/aiden-providers` (2 modules, ~1.9k LOC + ~1.1k test, 174 crate tests): `web_search.rs` (Exa `POST /search` client — byte-faithful wire body verified against a recorded fixture, result normalization capped at 1200 chars, injectable transport so tests never hit the network, key via the existing `ApiKeyResolver` pattern under the `exa` credential id; default 20s timeout / zero retries, matching the TS) and `artificial_analysis.rs` (all four `artificial-analysis-*.ts` cores: catalog types + `parseArtificialAnalysisUserCache` validation, percentiles with average-rank ties, paginated Free-endpoint fetch with page/byte/model caps, `ArtificialAnalysisRuntime` with the TS action/state mutex split, `FileArtificialAnalysisCacheStore` atomic 0600 writes, IPC-safe action wrapper; the explicit-user-action contract is encoded in the type system via a `UserInitiated` token constructible only through `UserInitiated::explicit()`, and the user's key is never bundled — it resolves through the resolver under the `artificial-analysis` credential id). Added `async-trait`, `chrono` deps + `tempfile` dev-dep.
- `rust/aiden-agent` (3 modules, ~1.5k LOC + ~1.3k test, 91 crate tests): `tool_approval.rs` (ToolApprovalCoordinator with synchronous publish + one-shot `PendingApprovalRequest::wait`, owner-document fencing, abort-signal expiry), `superseding_task.rs` (generation gate — waiters follow replacements, stale failures never displace the current generation, generic `E: Clone` error), `llm_client.rs` (essential llm-client.ts orchestration: `toPiMessages` message assembly, the `generation-runtime.ts` pure contract — thinking resolution/image gating/terminal fallbacks/bounded cleanup —, `TimelineProjector` against `aiden-core::GenerationTimeline`, `ChatTurnAdmission`, `startGenerationAndMaybeTitle`, and a `GenerationManager` with stream/chat admission, cancel/shutdown drains, and a usage-capture hook). `llm-client.ts` was confirmed to be **Pi agent-loop glue**, not a client.
- `rust/aiden-data` (1 module, ~0.4k LOC, 7 tests): `dev_log.rs` (dev-log.ts: serialized append, 2 MB rotation to `.prev.log`, 4096-char line cap, byte-faithful secret redaction).
- `rust/aiden-mac` (2 modules, ~0.6k LOC, 12 tests): `quit_barrier.rs` (renderer-close barrier over a `RendererQuitWindow` trait with a first-wins outcome slot, plus the pure quit decision — in-flight generations block unless forced) and `readiness.rs` (renderer-readiness-core.ts adapted to service-warmup gates: generation-following waiters, disposal releases).
- Workspace: reverted the uncommitted `aiden-subagents` workspace-member addition (its manifest references a non-existent workspace dep and blocks every cargo command); noted for the subagents phase.
- Verified: `cargo test -p aiden-providers -p aiden-agent -p aiden-data -p aiden-mac` (430 passed), `cargo clippy` on all four with `-D warnings` (clean), `cargo fmt --check` (clean), `cargo check --workspace` (passes).

### 2026-08-07 — GPUI port: live wiring for the chat (usage recording, generation timelines, MCP tools, subagent live source)

- `rust/aiden-ui/src/services/stream.rs`: `StreamReducer` now captures the terminal `Done` message's `aiden_core::Usage` and `ToolCall`s; new `chat_usage_record` maps a core `Usage` into the privacy-safe `UsageRequestRecord` shape (`source: chat`, token breakdown, cost status) — unit-tested (reported/unmetered/local/failed cases). Added `zero_usage_message` for synthesized turns.
- `rust/aiden-ui/src/services/mcp_tools.rs` (new): bounded chat MCP tool collection (`collect_chat_mcp_tools`, per-server/total caps, failing servers skipped, preset API-key injection via an injected keychain resolver) plus the namespaced dispatch map (`McpToolTarget` server/tool pair). Unit-tested for namespaced round-trip, disabled/unreachable servers, and preset-key injection.
- `rust/aiden-ui/src/services/provider_kit.rs`: `TurnSnapshot` gains `mcp: Option<McpStreamContext>`; `build_stream_request_with_tools` (additive) puts the tool defs on the wire; `drive_stream` now (a) projects stream events onto an `aiden-agent` `TimelineProjector` (thinking/tool steps published live as `StreamMsg::Timeline`), (b) dispatches model tool calls through `McpClientManager::call_tool` with the namespaced name mapping and appends normalized `ToolResultMessage`s for one follow-up pass (single tool round; multi-round agent loop is a follow-up), and (c) threads the terminal `Usage` through `StreamMsg::Done`. Unit-tested event→timeline projection and tool-dispatch fail-closed.
- `rust/aiden-ui/src/services/stores.rs`: `Stores` gains a shared `Arc<McpClientManager>`.
- `rust/aiden-ui/src/services/chat_service.rs`: `GenerationState` gains a live `timeline`; `StreamMsg::Timeline` mirrors it; terminal `Done`/`Error` persist the timeline on the assistant message (`ChatMessageInput.timeline`) and record usage (`source: chat`) into `UsageStore` on the background executor; `send_message` wires `mcp_context()` (enabled servers from the portable config + preset-key resolver).
- `rust/aiden-ui/src/chat/activity_feed.rs` (new) + `message_list.rs`: port of `activity-feed.tsx`/`agent-steps.ts` — persisted assistant messages render their timeline (thinking/tool trail) above the bubble, and the live stream bubble renders `generation.timeline` (spinner on active steps). Pure step-line/summary logic unit-tested against the renderer contract.
- `rust/aiden-ui/src/panels/subagents_panel.rs`: `SubagentRunSource` gains `snapshots_for_chat` (default = all); new `LiveRunSource` reads `userData/subagent-runs-v2/runs.json` via the aiden-subagents V2 parser (tolerant fallback to per-snapshot parse; missing/corrupt file → empty state, never demo data); panel tracks `active_chat` (`set_active_chat`) and refreshes snapshots on a 2s cadence while mounted. Parsing/filtering unit-tested.
- Cargo: `aiden-ui` gains `aiden-agent`, `aiden-subagents`, `aiden-git` workspace deps (+ `tempfile` dev-dep); `aiden-subagents` added to `workspace.dependencies`.
- Verified: `cargo test -p aiden-ui` (136 passed, incl. ~18 new), `cargo clippy -p aiden-ui --all-targets -- -D warnings` (clean), `cargo fmt -p aiden-ui --check` (clean), `cargo check --workspace` (passes). Remaining degraded behaviors: single-pass MCP tool loop (a second model tool-use round settles with the recorded timeline), usage is only recorded on terminal Done/Error (not user stops), and preset API-key MCP servers need the keychain resolver wired (keyless presets are skipped).
- `rust/aiden-mac` dictation port (2026-08-07): new `audio` (AVAudioEngine input-tap capture via `objc2-avf-audio` → downmix + linear resample to mono 16 kHz Float32, `AudioCapture` trait + pure resampler unit tests), `dictation_coordinator` (exact port of `dictation-coordinator.ts` — serialized tokio-mutex queue, idle/starting/recording/transcribing/delivering, hide timers, 100k transcript cap; all four TS tests mirrored + 11 more), `sherpa` + `local_models` (Parakeet catalog, GitHub-release tar.bz2 download w/ progress 0–90/90–100 %, `/usr/bin/tar --strip-components=1` extraction, cancel-by-id registry, env-overridable models root) + `local_runtime_status` (Ollama/LM Studio load-state parsers) — all behind a new `dictation` cargo feature (default ON; `--no-default-features` builds clean). `aiden-ui` pill wiring: `pill/live_audio.rs` (`LiveAudioSource` — background-thread capture feeding a shared `CaptureBuffer` for the meter bars + transcription drain), `pill/coordinator.rs` (`PillCoordinator` — broadcast watcher drives capture → sherpa transcribe → paste via `paste.rs`; missing model → exact "Download it in Settings → Voice" error; fake-capture/fake-transcribe tests), and the app shell (`app.rs` `wire_pill_coordinator` — foreground window-command bridge over `PILL_WINDOW`, `PillCommand` channel, live appearance read at open, cancel button → coordinator). sherpa-onnx 1.13.4 verified: crates.io static feature downloads a prebuilt macOS lib at build time and the FFI links/runs. Verified: `cargo test -p aiden-mac` (72), `cargo test -p aiden-ui` (191), `cargo clippy -p aiden-mac --all-targets -- -D warnings` (clean), `cargo check --workspace` (passes). Live dictation is wired in-app (⌘⇧D → record → transcribe → paste); model download UI in Settings → Voice remains a later-phase surface.
