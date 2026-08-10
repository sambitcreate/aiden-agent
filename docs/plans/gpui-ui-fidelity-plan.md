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
2. Model Pad foundation and truthful Appearance coordination. **Full composer 2-D picker accepted; complete Appearance surface remains in correction.**
3. Provider authentication/templates and native provider-specific setup. **Codex OAuth and Apple title routing complete; dynamic Pi setup remains open.**
4. MCP, Scheduled, Computer Use, and Voice parity.
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
- The complete Appearance controls and native transaction integration remain
  active Phase 6 work; the isolated `aiden-mac` bridge itself is accepted.

## Known visual-QA constraint

The app windows can be launched with disposable `HOME`, `AIDEN_CONFIG_DIR`, and user-data roots. Quartz confirms actual window bounds, but `screencapture -l` is denied until Screen Recording permission is granted to the terminal/Codex host. Once enabled, capture Electron and GPUI at the same 1000×700 outer bounds, display scale, fixture data, and light/dark system appearance; compare absolute error and a 50% overlay.
