# GPUI UI Fidelity

Status: active | Started: 2026-08-10 | Branch: `gpui-rust`

## Goal

Bring the completed Rust/GPUI port to user-facing parity with the Electron/React application. Preserve the native Rust architecture while matching the Electron shell geometry, semantic appearance tokens, interaction states, focus behavior, and responsive contracts.

Pixel comparison uses isolated development profiles. Automated capture is currently blocked until the Codex host receives macOS Screen Recording permission, so each phase also carries source-contract, focused-test, strict-Clippy, and isolated-runtime gates.

## Phases

| Phase | Status | Scope |
| --- | --- | --- |
| 0. Current-state and runtime audit | Complete | Re-audit current Rust against current Electron; establish disposable launch/capture protocol; identify the persistent shell as the highest-impact mismatch. |
| 1. Canonical shell and chat sidebar | Complete | Full-height split shell; 272px default / 236–340px persisted sidebar; exact 700px compact overlay; canonical navigation and time buckets; neutral selection tokens; pointer occlusion; focus cycle/restoration; pointer and keyboard resizing; model picker moved to composer. |
| 2. Chat measure and composer control plane | Complete | Shared centered 52rem transcript/approval/composer measure; attached workspace/Git/model context; composer geometry, elevation, auto-grow, focus, and generation-safe controls. |
| 3. Chat toolbar and workspace hierarchy | Complete | Single 52px per-chat toolbar; preferred-editor split control; real workspace-gated terminal; exact traffic-light/inset and compact-width behavior. |
| 4. Environment workbench | Complete | Detached summary; responsive inline/overlay shell; hardened workspace-files backend; retained Files editor; live Review/Compare, virtualized diffs, Overview integration, and Files handoff. |
| 5. Settings shell parity | Complete | Canonical split shell, Back/search/grouping, Skills destination, selection/focus behavior, responsive settings navigation, managed/discovered Skills UI, and end-to-end Skills invocation. |
| 6. Secondary surfaces and visual regression | In progress | Runtime-truthful Assistant/shortcuts/About, then Model Pad, Appearance, Providers, MCP, Scheduled, Computer Use, Voice, Usage/Subagents/terminal polish, motion/reduced-motion, light/dark capture matrix, and remaining accessibility work. |

## Phase 1 verification

- `cargo test -p aiden-ui --locked` — 279 passed.
- `cargo clippy -p aiden-ui --all-targets --all-features --locked -- -D warnings` — passed.
- `cargo fmt --all -- --check` and `git diff --check` — passed.
- Disposable returning-user main-window smoke — booted without panic.
- Two independent code reviews plus a final correction review — no remaining accepted findings in the Phase 1 scope.

## Phases 2–3 verification

- Shared transcript/composer geometry and toolbar behavior are covered by focused layout, action, focus, generation-gating, preferred-editor, terminal, and compact-width tests.
- `cargo test -p aiden-ui --locked` — 300 passed at the Phase 3 acceptance point.
- Strict all-target/all-feature Clippy, rustfmt, and diff validation — passed.
- Disposable returning-user smoke — booted without panic and measured the requested 1000×700 outer/content bounds on macOS.

## Phase 4 verification

- Environment shell: exact 480/560/720px sizing contract, 1040px inline threshold, full-column inline compression, modal overlay occlusion/focus, detached summary, persistence, pointer/keyboard resizing, and toolbar/palette wiring are implemented.
- Files backend: bounded hierarchy/read/write APIs, optimistic versions, cancellation, recovery discovery, and macOS descriptor-relative atomic replacement are accepted after independent containment, exchange, and rollback-race review (25 focused tests).
- Files UI: retained tree/editor state, scoped Cmd-S, versioned save/conflict recovery, root-level discard arbitration, recovery warnings, compact navigation, and roving file-tree focus are complete (339-test acceptance point).
- Review/Compare: stale-safe keyed resources, honest loading/error/empty states, local/remote target selection, virtualized roving file and diff lists, metadata-safe diff parsing, live Overview polling, and repeated Files handoff are complete.
- `cargo test -p aiden-data --locked` — 167 passed; `cargo test -p aiden-ui --locked` — 360 passed.
- Strict all-target/all-feature Clippy, rustfmt, and diff validation — passed.
- Independent correctness review accepted the final Environment tranche. Pixel regression remains queued until Screen Recording permission is available.

## Phase 5 verification

- Settings reuses the canonical app split shell: one persisted 272px rail, exact Back/search/Agent/App catalog, compact occlusion and focus cycling, and a centered 672px content measure. The same 12-destination catalog drives navigation, search, deep links, and the command palette.
- Skills discovery covers global and workspace roots with descriptor-relative no-follow traversal, bounded reads, cancellation, deterministic precedence, and stale-result fencing. Configured Skills have typed per-entry validation and an overflow-safe 8 MiB aggregate instruction cap.
- Main-chat turns build one immutable, cancellable Skills registry per turn. Tool identities are deterministic and collision-checked before provider I/O; names/descriptions are disclosed as untrusted tool metadata, while detailed instructions/supporting files load only on invocation. Assistant, automation, and subagent runtimes do not receive ambient Skills.
- The Skills settings surface implements managed create/edit/enable/delete flows, read-only discovered rows, workspace capability fencing, virtualized stable-ID lists, and app-root focus-trapped modals. Onboarding precisely discloses pre-invocation metadata versus invoked content.
- Acceptance points: 185 `aiden-data` tests and 397 `aiden-ui` tests after the final Skills lifecycle corrections, strict all-target/all-feature Clippy, rustfmt, diff validation, and independent runtime/UI reviews with no residual findings.

## Phase 6 order

1. Runtime truth: transactional shortcut runtime and truthful Assistant/About surfaces. **Complete.**
2. Model Pad, full composer picker, and Appearance/native integration. **Complete.**
3. Provider authentication/templates and native provider-specific setup. **Codex OAuth, Apple title routing, and release-pinned dynamic Pi API-key setup are complete.**
4. MCP, Scheduled, Computer Use, and Voice parity. **MCP authority/OAuth/HTTP/SSE/Settings, real Scheduled execution/UI, attended Computer Use, and local plus credential-bound OpenAI/Gemini Voice transcription are complete.**
5. Secondary panels, motion/reduced motion, accessibility, and the visual capture matrix.

## Phase 6A verification

- One app-lifetime shortcut runtime now owns the effective catalog, GPUI bindings,
  macOS claims, recorder suspension, status reporting, and serialized persistence.
  Reset All is one rollback-safe document transaction; malformed, future, or
  unreadable settings fail closed without claiming managed local or global
  shortcuts.
- Main-window routing distinguishes onboarding, a ready main window, and a
  windowless process. Dock/global reopen reuses one Stores owner and dispatches
  only after the main Root is ready. Recorder leases suspend all global claims
  and are authoritatively released on every section/view/window exit path.
- Assistant and About now describe only implemented runtime behavior and use
  the real build profile, package version, application icon, and repository
  action.
- Acceptance points: 117 `aiden-core` tests, 76 `aiden-mac` tests, and 437
  `aiden-ui` tests; strict workspace Clippy, rustfmt for the tranche, and diff
  validation passed. Independent review findings were corrected and re-gated.

## Phase 6C provider-security foundation

- Provider credentials are usable only with an exact connection snapshot.
  A path-shared authority serializes fixed-account Keychain staging and bound
  reads; a durable pending marker is published before either Keychain account
  changes and is removed only after provider/config selection commit.
- Custom-provider edits, discovered-model updates, and removal share one
  mutation authority. Builtin, preset, Codex-reserved, and non-`custom:` ids
  cannot enter generic mutation paths. Removal revokes first and never restores
  an orphaned credential after config deletion commits.
- Chat, title generation, and Assistant validate the exact provider/model pair
  and resolve only an active bound credential before request work. Onboarding
  writes bound credentials, and provider readiness no longer falls back to raw
  secret-slot presence.
- Authenticated model discovery uses the exact draft connection and never
  surfaces arbitrary HTTP bodies, preventing reflected Authorization values in
  Settings errors.
- Acceptance points: 195 `aiden-data`, 256 `aiden-providers`, and 449
  `aiden-ui` tests; strict workspace Clippy, rustfmt, diff validation, and a
  final independent security re-review passed. Native Pi setup and remaining
  provider visual parity remain open.

## Phase 6D native Codex and Apple title verification

- ChatGPT/Codex sign-in is an explicit user action in Settings and onboarding;
  boot performs no provider network request. Encrypted Pi credentials publish a
  durable pending denial before fixed Keychain mutation, activate only after
  document commit, and serialize reads, refresh CAS, sign-out, and health state
  across store instances.
- Definitive refresh rejection records a credential-generation-fenced
  `needs_attention` state and immediately refreshes the live provider inventory.
  Stale refreshes cannot mark a newer sign-in unhealthy, and rejected accounts
  no longer advertise usable models.
- OAuth attempts use bounded, cancellable requests and an exact owned dialog
  lease. Leaving Settings, quitting, replacing the dialog, or receiving a late
  completion cannot pop another modal or focus a hidden Settings control.
- Apple Foundation Models title routing uses the normalized native platform,
  is selectable and status-visible in Settings, and is independent of chat
  provider validity. Apple and chat-model titles share the canonical 15-second
  owner deadline, classify every timeout as cancelled, and persist real
  terminal usage when available.
- Foundation helper requests use exclusive temp directories and owned child
  handles. Shutdown writes the exact cancellation marker; the synchronous
  registry never signals raw PIDs, avoiding post-`waitpid` PID-reuse races.
- Acceptance points: 11 Pi credential tests, 29 Codex tests, the complete
  Foundation suite and focused reap/drain regression, and 493 `aiden-ui` tests
  at independent re-review. Strict workspace Clippy had no scoped findings;
  rustfmt and diff validation passed. Dynamic Pi setup remains an explicit
  follow-up rather than falling through the generic builtin editor.

## Phase 6B foundation verification

- Model Pad layouts persist in the device-local store under store-issued,
  process-monotonic save intents. Conditional publication returns an explicit
  `Published`/`Stale` outcome; stale work cannot mark the editor clean or
  update the runtime picker. Layout edits are authoritatively locked while a
  save is active.
- Settings retains unavailable placements, refreshes its inventory from the
  latest usable non-embedding provider models, searches visible provider/model
  labels, and projects Artificial Analysis suggestions only from the validated
  device-local cache after an explicit user action. Offline status reads are
  task-cancelled and generation-fenced.
- The responsive settings pad now has centered coordinates, keyboard and drag
  manipulation, visible filtering/empty states, provider metadata, and honest
  save/error status. Appearance mutations share one revision-fenced
  coordinator across Settings, palette, sidebar, and ChatService; GPUI follows
  system appearance changes and does not fabricate native Dock success.
- Acceptance points: 197 `aiden-data` tests and 469 `aiden-ui` tests at the
  correction handoff; focused Model Pad store 5/5, Settings Model Pad 15/15,
  and Model Data 6/6; formatting/diff validation and an independent correction
  re-review passed.
- The composer now owns a retained controlled Model Picker rather than a generic
  Select. It provides a searchable/pinned list and exact captured 2-D Pad
  interaction, staged Escape/focus restoration, generation-safe single commit,
  device-local ordered pins, live inventory repair, provider assets/metadata,
  and the canonical 316px picker + 8px gap + 224px detail rail. The dynamic
  lattice, separate 6px points/24px puck, narrow attribution, and compact
  behavior passed final independent review after 519 UI tests.
- Appearance now uses a process-lifetime publication authority, synchronous
  close/quit flushes, pre-window native theme/Dock restore, retained macOS
  accessibility observation, atomic rollback/retry, and fail-closed recovery.
  Settings renders simultaneous Light/Dark editors, miniature/system previews,
  themed code comparison, real controls, Dock assets, import/copy feedback,
  unsafe multi-field drafts, responsive layout, and roving focus. Pointer and
  motion preferences reach live runtime consumers. Final independent review
  accepted the surface after 532 UI tests and 31 focused Appearance tests.

## Phase 6E MCP authority verification

- Settings, chat, and Assistant now share the exact app-owned MCP manager and
  mutation authority. Save/remove/toggle/reset/external reconciliation fence
  in-flight calls before and after publication; slow handshakes cannot reinsert
  removed connections.
- Preset credentials are bound to the canonical connection snapshot and are
  resolved centrally for status and runtime work. Credential revision is part
  of the non-secret connection identity, so unkeyed/keyed and rotated-key
  transitions rebuild the cached client without exposing secret bytes.
- Credential cleanup uses a bounded, crash-safe device-local journal with real
  key removal and boot replay. Malformed portable input stays unsafe and cannot
  masquerade as removal; cleanup failure retains the previous watcher baseline
  and automatically retries the unchanged transition.
- Production OAuth now persists encrypted sessions under exact connection and
  renderer ownership, uses durable rollback/revocation cleanup, and holds one
  operation lease from discovery through runtime admission. Bounded PRM,
  authorization-server/OIDC discovery, DCR, PKCE, refresh, and public-address
  checks fail closed; Ready is published only after an ephemeral real MCP
  handshake succeeds.
- Settings now supports preset, custom HTTP, and local stdio configuration with
  explicit OAuth actions, revision-fenced async completion, retained modal
  focus/cancel ownership, and honest inline errors. Legacy SSE records remain
  editable/removable but testing and runtime connection are explicitly
  unsupported rather than simulated.
- Acceptance points: 204 `aiden-data`, 108 `aiden-mcp`, and 552 `aiden-ui`
  tests after the OAuth/Settings tranche. Independent authority review also
  accepted real ConfigStore/watcher compositions and a real GPUI
  failed-save/retry path.

## Phase 6F Scheduled execution verification

- Stores owns one production executor and one `Arc<ScheduleStore>` / `SchedulerCore`
  shared by boot, Settings, the panel, and Assistant tools. The persisted global
  gate defaults off, each task must be explicitly enabled, and boot dispatches
  only when the user previously enabled the global gate and exact executor
  dependencies remain ready.
- LLM tasks pin an available provider, model, credential binding, workspace
  permission, and optional exact MCP bindings. Native runs are bounded plain
  provider turns with no filesystem or shell tools; unsupported full project
  automation fails closed instead of implying Electron coding-tool parity.
- Script tasks use mandatory full permission with process-group cancellation,
  a 60-second timeout, and a 1 MiB combined-output cap. Disable, edit, remove,
  global stop, workspace revocation, and quit settle or fence stale work before
  a result can be recorded.
- Settings implements retained create/edit/delete/enable controls with exact
  revisions and honest async errors. The Scheduled panel projects live global,
  readiness, running, next-run, last-result, and persisted run-history state;
  Run Now routes through the same core. Assistant proposals remain attended and
  bind provider/MCP state before revision-checked publication.
- Acceptance points: 204 data, 117 core, 58 scheduler, and 566 UI tests. Strict
  all-target/all-feature workspace Clippy, rustfmt, and diff validation passed.

## Phase 6G Computer Use verification

- Stores owns one injectable Computer Use authority and production controller
  factory. Settings, chat, provider dispatch, approval decisions, context
  cancellation, and quit share that exact instance; construction and ordinary
  status reads never prompt for permissions.
- Global and chat-local gates default off. The provider receives the exact
  14-action tool only with an opted-in chat, an active non-None workspace,
  explicit model tool-call capability, exact persisted provider/workspace
  identity, pinned-helper readiness, and a current authority generation.
- Mutating actions pause on an app-root, occluding Allow once/Deny modal bound
  to the exact generation, tool call, PID, window, target revision, and private
  grant ledger. Stop, disable, chat/workspace/provider change, close, and quit
  cancel stale work; screenshots and accessibility payloads are never logged
  or persisted by the UI.
- Acceptance points: 118 Computer Use unit tests, 4 broker integration tests,
  558 UI tests, strict all-target/all-feature workspace Clippy, rustfmt, and
  diff validation.

## Phase 6H Usage, Profile, and Terminal verification

- Usage now matches the Electron five-range, default-one-year, session-local
  selection contract with complete aggregate metrics and a privacy-narrow PNG
  share projection. Profile edits use the accepted ConfigStore authority and
  retain exact save/focus fencing.
- Terminal sessions are created only on explicit first open and are owned by
  the active workspace and window. The drawer supports eight tabs, four equal
  horizontal/vertical split panes, coherent select/close/exit fallback,
  viewport-only clear, and exact focus restoration when Terminal owned focus.
- Only the global drawer height persists. Pointer and keyboard resizing use the
  Electron pixel bounds and newest-intent publication; tabs and split layout
  remain ephemeral. Workspace/permission changes, window close, and quit drop
  every retained PTY through owned child handles and bounded foreground
  teardown, with no cached raw-PID signaling after child exit.
- Terminal acceptance points: 17 focused backend/layout/GPUI tests, UI test
  compilation, and strict all-target/all-feature UI Clippy. Full visual capture
  remains part of the known Screen Recording constraint below.

## Phase 6I Subagents foreground foundation verification

- Stores owns one app-lifetime Subagents authority backed by the production V2
  run store. The main provider loop advertises the bounded Subagents tool only
  when the exact workspace, model, provider credential, cancellation, and V2
  persistence bindings are available; the canonical exact-`0` rollback remains
  fail closed.
- Foreground children support fresh context and an immutable, sanitized fork of
  the exact persisted parent chat revision. Children inherit or narrow the root
  capability grant, use bounded concurrency and output, and revalidate provider,
  credential, workspace, and generation identity around every child step.
- Read-only workspace tools are available without ambient Skills, Computer Use,
  network, or MCP authority. Workspace write/edit is advertised only with
  matching workspace permission and a live app-owned approval channel; each
  proposed mutation pauses on a focus-trapped Allow once/Deny modal bound to
  exact owner, revision, arguments, and effect digests. The descriptor-relative
  recovery stage is created only after authorization and immediately before an
  atomic commit.
- The production Subagents panel reads chat-scoped V2 snapshots and durable
  workspace-write and shell effect state. A foreground shell command is exposed
  only through an exact per-command Allow once/Deny approval, runs with a
  scrubbed environment plus bounded output/time/process-group cleanup, and is
  durably projected as prepared/authorized/dispatched/terminal or unknown.
  Stop, generation/chat/workspace/provider change,
  modal loss, window close, and quit cancel parked or active children and fence
  stale completions. Assistant messages retain the exact generation reference;
  user messages do not.
- Post-create recovery stages remain owned by an identity-pinned guard through
  descriptor and provenance verification. Failures remove only the exact owned
  name; hostile replacement or hard-link mutation is preserved as evidence.
  First-run onboarding now presents the six shipped capabilities through a
  data-driven responsive gallery with bounded 1024-pixel RGBA assets, visible
  hover/focus states, and keyboard-contained informational tiles.
- Verification points: the full 644-test UI suite, the 157-test Subagents
  suite, and all-target workspace
  tests, exact all-feature/all-target strict workspace Clippy, rustfmt, and diff
  validation pass. Independent acceptance found no remaining P0/P1/P2. This is the
  foreground fresh/fork read/write/shell foundation only: MCP, depth-2
  delegation, and background execution remain unavailable and are not
  advertised.

## Phase 6J transactional chat and persistent Assistant dock verification

- Every composer entry point now uses one persistence-first transaction.
  Attachment-only turns are supported, known non-vision selections reject
  images before admission, and edit/rebranch replaces the durable tail in one
  idempotent operation. Stable message/chat ids reconcile post-publication
  ambiguity without duplicate sends; unknown outcomes remain locked until an
  explicit verified reopen resolves them.
- Streaming follows the transcript only while the user is at the bottom. A
  real GPUI prepaint/wheel/jump harness verifies that reading history is not
  pulled down by later deltas and that Jump returns to the new maximum offset.
- Assistant is one lazy app-root dock entity rather than a route replacement.
  It preserves the underlying chat, transcript, approvals, and focus across
  route changes; minimized replies use a bounded sanitized preview and unread
  badge. Root modals and Environment occlude it, compact geometry is bounded,
  and the complete inert chrome has a 120 ms exit with a reduced-motion fast
  path.
- The retained dock follows ChatService's live in-memory provider/model
  selection before settings persistence. Request-time local preflight binds
  portable, Codex, Pi-native, and explicitly discovered loopback selections to
  the exact current connection and credential; stale rejection rolls back the
  optimistic turn, preserves newer drafts, and remains retryable when the live
  snapshot itself is still valid.
- Verification points: 208 data tests, 675 UI tests, focused Assistant and real
  GPUI lifecycle/state tests, exact all-feature/all-target strict workspace
  Clippy, rustfmt, and diff validation. Independent review found no remaining
  P0/P1/P2.

## Phase 6K Subagent remote read-only MCP verification

- Foreground depth-1 fresh/fork children discover only enabled remote HTTP or
  legacy SSE MCP servers at generation admission. Stdio never enters the child
  inventory. The canonical default-on exact-`0` global, V2, and child-MCP
  rollback gates all fail closed; an empty, unavailable, stale, or mutating
  inventory exposes no MCP capability.
- Only structurally valid tools with an explicit non-conflicting
  `readOnlyHint: true` and supported execution metadata are enumerated. The
  parent schema names the exact server and tool, and each call pauses on the
  same app-root FIFO as Computer Use, workspace writes, and shell. The modal
  shows bounded canonical arguments and offers only Deny or a 60-second Allow
  once grant; configured-server effects and external data disclosure are
  explicit.
- Discovery and each approved call use isolated remote clients. Exact config,
  process-keyed credential revision, connection fingerprint, input schema, and
  read classification are rechecked before and after the single raw call.
  Credentials remain host-owned, raw and encoded credential forms are redacted,
  results are bounded and marked as untrusted evidence, and cancellation or
  any stale binding closes the session without downgrading to an unapproved
  call.
- One shared MCP/web operation budget applies to the foreground run. First-run
  onboarding discloses generation-start discovery, per-call approval, data sent
  to the configured server, host-held credentials, and the configured server's
  control over actual effects.
- Verification passed 122 MCP tests, 160 Subagents tests, 680 UI tests, the
  composed config-to-child-to-mounted-approval-to-real-remote-call regression,
  strict all-feature/all-target workspace Clippy, rustfmt, and diff validation.
  The separate MCP mutation lane is now available only under its subordinate
  exact-`0` rollout. Mutating tools require a distinct effect-profile approval,
  durable Prepared→Authorized→DispatchStarted publication, a final fence, and
  no automatic retry after an Unknown outcome. Depth-2 delegation and background
  execution remain absent from both schema and executor. Phase 6 remains active
  for those lanes and final visual QA.

## Phase 6L Voice Settings parity verification

- Voice Settings retains GPUI provider and cloud-model Select entities, exposes
  only locally hydrated configured cloud options, and routes setup through the
  existing provider authority. The local panel shows bundled-engine
  readiness/error, selected model and explicit model-management action,
  microphone status, dictation hotkey status/retry/manage action, and
  Accessibility trust with explicit Grant/Refresh actions.
- Local runtime probes are provider-gated and network-free; no model download,
  microphone probe, Accessibility prompt, or cloud request occurs on boot or
  while a cloud provider is selected. Unsupported native bridges remain honest
  and fail closed.
- Verification passed the focused Voice Settings tests, the full affected UI
  suite, strict all-feature/all-target workspace Clippy, rustfmt, and diff
  validation. Remaining Phase 6 work is depth-2/background Subagents and final
  visual capture/accessibility review.

## Phase 6M Scheduled Settings defaults parity verification

- Scheduled Settings now projects the Electron defaults contract alongside the
  live scheduler gate and task list: default mode, permission, MCP access,
  notifications, timezone, and the workspace/global script-folder disclosure.
  New-task drafts consume the same defaults while retaining explicit per-task
  overrides.
- Defaults load fail closed with an authoritative loading/error/retry state.
  Every save is a sparse ConfigStore update fenced by a monotonic settings
  revision; stale completions cannot overwrite a newer edit, and invalid enum,
  boolean, or timezone values never become editable runtime state.
- Verification passed the scheduled defaults round-trip and malformed-value
  tests, the full workspace all-target suite, strict all-feature/all-target
  Clippy, rustfmt, and diff validation. Scheduler execution remains behind its
  existing default-off global and per-task gates.

## Phase 6N Command Palette input and focus parity verification

- The palette query is now a native GPUI `InputState`/`Input` with selection,
  IME, clipboard, placeholder, and Enter semantics. Submodes have an explicit
  keyboard-accessible Back button; Escape/Backspace/Left restore the root mode
  and clear the scoped query.
- Result rows are focusable and keyboard activatable with Enter/Space, expose
  disabled/busy semantics, and retain the existing bounded command catalog,
  dialog occlusion, and focus restoration behavior.
- Verification passed 13 focused palette tests, the full workspace all-target
  suite (690 UI tests), strict all-feature/all-target Clippy, rustfmt, and diff
  validation. Phase 6 remains active for the remaining visual/accessibility
  capture and unavailable depth-2/background Subagent lanes.

## Phase 6O Assistant Settings truthfulness verification

- Assistant Settings now reports the retained dock's live composer selection
  and readiness instead of claiming that the model is frozen at first open.
  The history fact is explicitly local to the current Assistant session, and
  semantic status badges distinguish positive, neutral, caution, and unavailable
  runtime facts.
- Access copy names the currently shipped attended project/schedule/MCP
  surfaces, per-call remote approval, and the explicit absence of app-settings,
  file, shell, background, and delegated capabilities. The global shortcut row
  retains live Active/Unavailable/Off status with Retry and Manage actions.
- Verification passed five focused Assistant Settings contract tests plus the
  full workspace test, strict Clippy, rustfmt, and diff gates. Runtime behavior
  remains owned by the retained Assistant authority and is not duplicated in
  Settings.

## Phase 6P Providers Settings visual parity verification

- Providers Settings now has an accessible Add-provider menu with local LM
  Studio/Ollama templates and private/custom endpoint templates, a loading-
  aware Pi provider refresh action, curated featured-provider disclosure, and
  provider logo assets with safe local/hosted fallbacks.
- Built-in rows retain the Pi authority's exact setup method/revision and show
  truthful Ready/Set up/Unavailable states; custom editor persistence and the
  existing focus-trapped Pi setup modal remain unchanged. Provider templates
  only seed local draft fields and never write credentials or contact a server.
- Verification passed twelve focused Providers tests, the full workspace UI
  suite (695 tests), strict all-feature/all-target Clippy, rustfmt, and diff
  validation. Phase 6 remains active for final visual/accessibility capture and
  unavailable depth-2/background Subagent lanes.

## Phase 6Q Shortcuts Settings accessibility parity verification

- Shortcuts Settings now separates the canonical command catalog into Global
  and In-app groups, keeps search as a native accessible GPUI input, and shows
  explicit recording/loading guidance with a status icon. Escape and Tab cancel
  recording with propagation stopped, so navigation never becomes a binding.
  Search matches the Electron catalog's category, keyword, pretty accelerator,
  and ARIA accelerator metadata in addition to the visible command text.
- Verification passed the ten focused shortcut tests and a clean UI check;
  the existing transactional registration, persistence, and recorder ownership
  semantics remain unchanged.

## Phase 6R Computer Use Settings presentation parity verification

- Computer Use Settings now has a truthful Beta/readiness callout with helper
  status tone, driver version, recoverable refresh/error state, permission
  labels, and privacy badges for per-chat opt-in, attended actions, and the
  no-capture-persistence boundary.
- The durable privacy notice can be restored through a revision-fenced,
  off-thread ConfigStore removal; stale completions are ignored and the
  app-root reducer reopens the next chat notice only after the durable event.
- Verification passed four focused Computer Use Settings tests, strict UI
  Clippy, rustfmt, and diff validation. Phase 6 remains active for final visual
  capture, remaining small settings refinements, and unavailable depth-2/
  background Subagent lanes.

## Phase 6S MCP editor multiline parity verification

- Manual MCP stdio environment values and remote HTTP/SSE headers now use
  bounded auto-growing GPUI textareas (3–8 rows) rather than one-line fields.
  The disclosure copy retains the portable-plaintext boundary, while OAuth and
  preset credentials remain on their encrypted authority paths.
- Embedded equals signs, multiline values, transport switching, parser
  round-trips, and modal busy/focus fences remain covered by the MCP Settings
  tests. No runtime transport or authority behavior changed.

## Phase 6T Custom Provider editor modal parity verification

- The custom-provider editor is now an app-root occluding modal with bounded
  scroll geometry, owned first/last focus handles, Tab wrapping, Escape and
  backdrop close, explicit return-focus, and close/save busy locking.
- Draft errors and asynchronous save completions are tied to the editor's
  provider/revision identity, so stale completions cannot mutate a replacement
  draft. Verification passed fifteen focused Providers tests plus check,
  Clippy, rustfmt, and diff validation.

## Phase 6U Credential-removal lifecycle fencing

- Custom Provider key removal now runs through the same serialized mutation
  authority as save/replace. The editor disables key editing, save, discovery,
  and close while removal is pending, and a provider/editor revision fence
  ignores late completions after navigation or replacement.
- MCP preset-key removal has the same busy/revision lifecycle, with a shared
  preset-key mutation coordinator preventing a stale clear from deleting a
  replacement key. Connection-reset completions are also fenced to the latest
  reset revision.
- Verification passed thirteen MCP Settings tests, fifteen Providers Settings
  tests, the full workspace suite (707 tests), strict all-feature/all-target
  Clippy, rustfmt, and diff validation. Phase 6 remains active for final visual
  capture and unavailable depth-2/background Subagent lanes.

## Phase 6V Web Search Settings lifecycle fencing

- Web Search enablement now uses an explicit busy/revision fence. A failed
  ConfigStore write restores the prior toggle instead of leaving an optimistic,
  non-durable value visible; stale toggle, keychain probe, and test completions
  are ignored after a newer operation or settings hydration.
- Exa key saves/removals retain the exact editor identity and section lifecycle.
  Leaving Web Search invalidates in-flight work and closes the draft, while a
  successful removal reports separately when the durable disable write could not
  be committed.
- Verification passed six focused Web Search tests, strict UI Clippy, rustfmt,
  and diff validation. Phase 6 remains active for final visual capture and
  unavailable depth-2/background Subagent lanes.

## Phase 6W Dictation pill focus parity

- Re-showing a retained GPUI dictation pill now uses a no-op liveness probe
  instead of activating the overlay window. This preserves the focused target
  application for the dictated paste and matches Electron's `focusable: false`
  plus `showInactive()` contract.
- The bridge contract has a focused regression, and the pill state/coordinator
  suite remains green. Phase 6 remains active for final visual capture and
  unavailable depth-2/background Subagent lanes.

## Phase 6X Voice Settings lifecycle fencing

- Voice Settings now binds runtime probes, provider/model selection, local
  model management, accessibility checks, and section exit to monotonic
  operation and lifecycle revisions. A late local probe cannot repopulate
  stale readiness after a provider switch or settings hydration.
- Leaving Voice cancels an active model download and invalidates its progress
  and terminal callbacks; stale provider/model/error completions remain inert.
- Verification passed five focused Voice Settings tests, the full UI suite
  (716 tests), strict all-feature/all-target workspace Clippy, rustfmt, and
  diff validation. Phase 6 remains active for final visual capture and
  unavailable depth-2/background Subagent lanes.

## Phase 6Y Dictation pill display/work-area parity

- The macOS pill bridge now queries AppKit's cursor display and visible frame
  on every new show, converts the Dock/menu-bar-safe work area into GPUI's
  top-left coordinate space, and passes the matching GPUI display id to the
  non-activating window. A nearest-frame fallback handles display-transition
  gaps; non-macOS and unsupported native probes fall back to the primary GPUI
  frame without claiming Dock-aware placement.
- Pure geometry coverage exercises negative-origin displays, menu-bar/Dock
  insets, and undersized work-area clamping. Native bridge tests verify the
  AppKit coordinate conversion and finite-area validation.
- Phase 6 remains active for final visual capture and unavailable
  depth-2/background Subagent lanes.

## Phase 6Z Windowless global Dictation focus parity

- The process-wide DictationToggle shortcut now bypasses main-window
  preparation and app activation, then toggles the app-lifetime pill
  coordinator directly. Dictation therefore remains usable with the main
  window closed and preserves the external application's focus for the final
  paste; an active chat generation remains a handled no-op rather than a
  fall-through window-activating action.
- ComposerFocus and AssistantOpen retain their existing main-window
  preparation and activation behavior. A focused policy regression covers the
  command split, and the full UI/workspace test suites, strict workspace
  Clippy, rustfmt, and diff validation are green.
- Phase 6 remains active for final visual capture and unavailable
  depth-2/background Subagent lanes.

## Phase 6AA Onboarding keyboard and retained-window lifecycle parity

- Provider, model, and appearance choice cards are native focusable GPUI
  controls with tab stops, visible focus styling, and Enter/Space activation
  fences. Keyboard selection therefore cannot accidentally advance the whole
  onboarding flow, while the existing selected borders/checkmarks remain the
  source of truth.
- The first-run onboarding window vetoes native close while it is retained,
  including the short completion-marker/deferred-handoff interval. A
  process-lifetime window handle lets Dock/global reopen reactivate the exact
  onboarding entity and preserve its step, draft, and focus; completion alone
  removes it programmatically before opening the main window.
- Verification passed the focused onboarding/lifecycle suites, the full UI
  suite (725 tests), full workspace all-target tests, strict all-feature/
  all-target Clippy, rustfmt, and diff validation. Phase 6 remains active for
  final visual capture and unavailable depth-2/background Subagent lanes.

## Phase 6AB Production update-feed discovery and ready banner

- The macOS bridge now resolves only the bounded `provider: generic` HTTPS
  feed from a packaged `app-update.yml`; unpackaged and development binaries
  remain inert and never contact the update service.
- The app owns one update authority and watch-fenced snapshot. Packaged feed
  checks parse the actual Electron Builder `latest-mac.yml` YAML contract,
  resolve its relative artifact URL, and verify the declared base64 SHA-512
  digest (while retaining bounded JSON/SHA-256 compatibility for injected
  providers). The sidebar exposes a small Update ready card with Later/Open
  installer actions. The native action opens only a verified `.dmg`, `.pkg`, or
  `.zip`; staged downloads preserve that allowlisted suffix and reject
  unsupported artifacts before download. It does not claim automatic
  in-place replacement.
- Verification passed the macOS updater suite, the app-update authority
  tests, UI check, strict UI Clippy, rustfmt, and diff validation. Automatic
  quit-and-restart installation remains a native distribution follow-up.

## Phase 6AC Provider stream retry parity

- Anthropic generation streams now disable `reqwest-eventsource`'s unbounded
  transport reconnect policy. A lost network settles the user-owned turn with
  the existing actionable error surface and explicit Retry action instead of
  leaving an indefinite streaming cursor or replaying a partially delivered
  request.
- Verification passed the full `aiden-providers` suite, full workspace tests,
  strict all-feature/all-target Clippy, rustfmt, and diff validation. Phase 6
  remains active for final visual capture and intentionally unavailable
  depth-2/background Subagent lanes.

## Phase 6AD Computer Use quit durability

- Application quit now has a single-flight guard and waits for the authority's
  durable global Computer Use disable plus coordinator/controller teardown
  before crossing the irreversible `cx.quit()` boundary. A failed persistence
  or shutdown task leaves the app open, resumes the live settings coordinator,
  and shows fixed retry guidance instead of silently losing the disable.
- Verification passed the focused quit and Computer Use shutdown tests, the
  full workspace all-target suite (750 tests in the UI binary), strict
  all-feature/all-target Clippy, rustfmt, and diff validation. Phase 6 remains
  active for final visual capture and intentionally unavailable
  depth-2/background Subagent lanes.

## Phase 6AE Native update install-on-quit boundary audit

- Re-audited Electron's production contract (`autoInstallOnAppQuit` plus
  `autoUpdater.quitAndInstall(false, true)`) against the standalone GPUI
  runtime. Electron delegates replacement/relaunch to its native Squirrel.Mac
  updater; the Rust binary has no equivalent signed external helper, native
  updater handoff, or packaged GPUI `.app` replacement contract.
- The Rust updater seam is therefore explicitly named and documented as an
  **open verified installer** action. It has no automatic quit/restart method,
  and the GPUI quit barrier never invokes it. Verified private `.dmg`, `.pkg`,
  and `.zip` artifacts remain available only after an explicit user action.
- Focused `aiden-mac` (107 tests) and `aiden-ui` (751 tests) suites pass; the
  updater crate's strict Clippy check, rustfmt, and diff checks are green.
  Automatic signed replacement remains blocked on a future signed external
  updater/package contract rather than being simulated by shelling out to an
  installer from the live process.

## Phase 6AF Dictation pill elapsed-timer parity

- The live pill meter task now emits bounded monotonic `Tick` events while a
  recording is listening, so the visible `m:ss` clock advances independently
  of audio-level availability and catches up safely after a delayed frame.
  Recording-start identity fencing prevents a stale task from advancing a
  newer recording, and cancellation/stopping/error transitions clear the
  clock source. Reduced motion freezes only the animated level bars; it does
  not freeze elapsed time.
- Focused pill coverage verifies monotonic/bounded catch-up, stale-recording
  fencing, reduced-motion timer independence, and the existing cursor-display
  placement contract. Full workspace verification remains the release gate;
  Phase 6 stays active for final visual capture and intentionally unavailable
  depth-2/background Subagent lanes.

## Phase 6AG Terminal claim-check warning parity

- Terminal provider timelines now pass through the existing core
  `attach_claim_check` detector before the final snapshot reaches the
  foreground. Completed, failed, and cancelled settlements retain their
  correct terminal status and expose the structured `UnverifiedSuccess` step
  ids when the prose claims a consequential action that the evidence did not
  verify.
- The activity feed renders a warning card (`Success not verified`) for that
  structured state, including persisted timelines after reload. Focused
  provider/activity tests cover a failed write claim and cancelled-step
  status; full workspace verification remains the release gate.

## Phase 6AH Windowless dictation close lifecycle fence

- Native red-close disposes the visible AppState before another GPUI render can
  refresh process-wide generation state. The close transaction now clears the
  windowless dictation gate immediately after disposal, so a subsequent
  global dictation toggle still reaches the non-activating pill coordinator
  instead of becoming a permanent no-op.
- A source-contract regression covers the close/dispose ordering and atomic
  reset. Phase 6 remains active for final visual capture and intentionally
  unavailable depth-2/background Subagent lanes.

## Phase 6AI Activity Feed disclosure and live ticker parity

- Activity timelines now use generation-keyed disclosure state. Settled turns
  render a compact summary first; the summary is a real keyboard-activatable
  button that expands the full trail. Failed/blocked/cancelled steps and
  unverified-success claim checks auto-open once for the affected generation,
  while an explicit user close remains authoritative for subsequent updates.
- Live turns keep a bounded three-row ticker with subdued older rows and a
  reduced-motion-safe active-row treatment. Focused pure and GPUI entity tests
  cover row bounds, attention auto-open, explicit close, and generation reset.

## Phase 6AJ Attachment format and text-context parity

- The GPUI picker now follows Electron's bounded attachment contract: text
  files are UTF-8 inlined with a 100,000-character cap and truncation marker,
  NUL-containing files fail closed, and BMP/HEIC/HEIF images retain their
  exact MIME/data payload even when the native thumbnail renderer falls back
  to a file chip.
- Provider history reconstructs text attachments as labeled fenced text before
  the user's message and preserves image blocks. Focused tests cover extension
  mapping, bounded text/malformed-byte behavior, and exact provider block shape.
  Phase 6 remains active for final visual capture and intentionally unavailable
  depth-2/background Subagent lanes.

## Phase 6AK Windowless pill appearance retention

- The dictation pill now receives an app-lifetime appearance snapshot that is
  updated from the authoritative ChatService. When the main window is closed,
  a later global DictationToggle therefore retains the user's selected palette
  and effective reduced-motion policy instead of falling back to the default
  appearance. A live main-window snapshot still wins whenever it is available.
- Focused coverage verifies the live-over-cached selection and cached
  windowless fallback; the UI check and formatting/diff gates remain green.
  Phase 6 remains active for final visual capture and intentionally unavailable
  depth-2/background Subagent lanes.

## Phase 6AL Markdown math source-preserving fallback

- Assistant markdown now recognizes bounded inline/display math spans outside
  fenced or inline code and routes them through a source-preserving GPUI
  fallback. Inline formulas become copyable code spans and display formulas
  become labeled `math` fences, retaining the original delimiters instead of
  silently dropping or misclassifying the expression.
- The fallback is deliberately not advertised as KaTeX: the pinned
  `gpui-component` markdown renderer has no native KaTeX/MathJax element, so
  true typeset parity remains a future renderer/dependency lane. Focused tests
  cover delimiters, escaping, code exclusion, bounds, and fence sizing.
  Phase 6 remains active for final visual capture and intentionally unavailable
  depth-2/background Subagent lanes.

## Phase 6AM Persisted foreground-Subagent chips

- Assistant transcript messages now project bounded persisted Subagent
  references into status-labeled, keyboard-activatable chips. Legacy references
  retain their exact run ids with safe fallback labels, while enriched
  references expose their bounded item labels and terminal state.
- Chip activation routes through the existing AppState navigation/file-mutation
  gate, opens the Subagents roster, and selects the exact persisted run without
  performing synchronous dispatcher or disk work during render. Live foreground
  snapshots now publish from the authority projector into a bounded, memory-only
  cache keyed by exact generation/chat identity; the chat snapshot reads that
  cache and a short revision poll refreshes the stream without disk I/O. Cancel
  and finish tombstones reject late callbacks before they can repopulate chips.
  Focused chip/cache/lifecycle tests, the full 781-test UI suite, full workspace
  tests, strict workspace Clippy, rustfmt, and diff checks pass. Phase 6 remains
  active for final visual capture and intentionally unavailable depth-2/background
  Subagent lanes.

## Phase 6AN VoiceOver lifecycle announcements

- The macOS boundary now posts bounded, control-normalized announcements to
  VoiceOver through AppKit's application accessibility notification. Unsupported
  hosts and off-main-thread calls fail closed, while provider-controlled text is
  capped before it reaches the native bridge.
- AppState observes only coarse generation and foreground-approval transitions,
  deduplicated by generation/approval identity; streamed token and thinking
  deltas never announce. Focused sanitizer and lifecycle tests pass in both
  `aiden-mac` and `aiden-ui`, with strict Clippy, rustfmt, and diff checks green.
  Phase 6 remains active for final visual capture and intentionally unavailable
  depth-2/background Subagent lanes.

## Phase 6AO Live foreground-Subagent snapshot cache

- The live chip path is now production-reachable without synchronous storage
  reads: the V2 projector publishes bounded snapshots through a weak authority
  callback, ChatService exposes only the exact active generation's memory cache,
  and MessageList renders status chips with the existing Subagents navigation
  gate. A 120 ms revision poll is fenced to the chat/counter and exits when the
  generation settles; cancellation/finish clear the cache and reject stale
  callbacks. Focused cache, stale-lifecycle, and message-list tests pass, along
  with the full workspace suite and strict Clippy/fmt/diff gates. This lane does
  not claim per-token activity updates or depth-2/background execution.

## Known visual-QA constraint

The app windows can be launched with disposable `HOME`, `AIDEN_CONFIG_DIR`, and user-data roots. Quartz confirms actual window bounds, but `screencapture -l` is denied until Screen Recording permission is granted to the terminal/Codex host. Once enabled, capture Electron and GPUI at the same 1000×700 outer bounds, display scale, fixture data, and light/dark system appearance; compare absolute error and a 50% overlay.
