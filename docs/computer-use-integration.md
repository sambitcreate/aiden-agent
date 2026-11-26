# Computer Use integration

## Decision

Aiden uses Cua's external Rust `cua-driver` process through its native MCP
stdio transport. Aiden does not reimplement capture, accessibility, pointer,
keyboard, or window automation in Swift. The Electron main process is the
model adapter. A small authenticated Rust broker/bridge is only the macOS
permission, transport, and lifecycle boundary; it implements no capture or
input behavior.

Hermes established the useful model-facing shape: one `computer_use` function,
capture modes `som`, `vision`, and `ax`, element-first actions, background input
by default, explicit approval for mutation, and Pi/provider-aware image results.
Aiden preserves that contract while changing the process and release policy to
fit a signed desktop product.

## Driver release policy

Aiden pins both the macOS universal `cua-driver` 0.38.0 artifact (for Computer
Use on macOS) and the Linux arm64 `cua-driver` 0.38.0 artifact (for Linux Bot
computers in Lume) from tag `cua-driver-rs-v0.38.0` (published 2026-10-21) and
source commit `85e2b1318bd77ccf3cfa88ccdf875a4bb7eaed19` (upgraded from 0.36.0
on 2026-11-24; 0.38.0 is the newest release with at least 7 quiet days before
the next upstream tag — 16.3 days until 0.39.0 on 2026-11-06 — avoiding the
multi-release-per-day 0.39–0.61 burst; 0.36.0 replaced 0.34.1 on 2026-10-19,
see [the 0.36 upgrade plan](plans/cua-driver-0-36-upgrade-plan.md); 0.34.1
replaced 0.8.3 on 2026-10-09, see [the 0.34 plan](plans/cua-driver-0-34-upgrade-plan.md)).
The exact URL, archive byte size, archive SHA-256, extracted binary byte size,
and binary SHA-256 are recorded in `resources/computer-use/cua-driver-artifact.json`
(macOS universal) and `resources/computer-use/cua-driver-linux-arm64-artifact.json`
(Linux arm64). The macOS release archive holds five signed files (CLI, cursor
theme, SDK dylib, Node runtime, C header), and the Linux arm64 release archive
holds the five Linux counterparts plus `wayland-helper/`; Aiden vendors only
the top-level `cua-driver` executable and rejects any other staged entry. The
security-critical binary hashes, sizes, Cua signing identifier, and Cua Team ID
are also compiled into Aiden (`scripts/computer-use-signing-pins.mjs`,
`main/services/computer-use/binary.ts`) and the Rust broker rather than trusted
from those mutable JSON files. Driver updates happen only in reviewed Aiden
releases.

The runtime never executes Cua's moving installer, never resolves a production
driver from `PATH`, never follows an executable path returned by the driver's
manifest, and never invokes its self-updater. Upstream telemetry and update
checks are disabled in every child process, including upstream's
`DO_NOT_TRACK=1` opt-out, which takes precedence over persisted driver
configuration. The broker also starts the driver with
`CUA_DRIVER_DISABLE_RUN_SCRIPT=1`, so 0.35+'s on-by-default `run_script`
(sandboxed JavaScript that drives the driver's own tools) is not offered; it,
the `run_steps` batch tool (with its `run_actions` alias), 0.37's `get_guide`
skill-pack reader, and 0.37's `browser_select` are also denied by the broker
and filtered from the catalog the model sees. The broker's environment allowlist
never forwards `CUA_DRIVER_ALLOW_BRIEF_FOREGROUND` (0.37's daemon-level
brief-foreground drag auto-escalation, off by default), preserving Aiden's
explicit foreground approval. 0.37's `PreventUserIdleDisplaySleep` guard
(`CUA_DRIVER_KEEP_DISPLAY_AWAKE`, default 600 s idle window after tool calls)
stays at its upstream default: it only defers idle display sleep while an agent
is actively working and never wakes a sleeping display or bypasses a lock.
No CLI flags used by Aiden (`mcp --embedded --direct --host-bundle-id`,
`mcp --embedded --socket`, `serve --socket --pid-file --no-overlay
--no-permissions-gate`) were removed between 0.36.0 and 0.38.0. The MIT notice
ships beside the helper.

Since 0.36 the driver caps screenshots at 1366 px on the long edge by default
(0.34 used 1568); Aiden passes `max_image_dimension` only when the model asks
for a different cap. Since 0.37 macOS window screenshots also exclude the
user's pointer (#5480), and Electron background drags deliver through the main
process (#5351). Captures request `tree_format: "elements"` for `som` and
`ax` (0.35+ returns a lean markdown tree otherwise) and `"markdown"` for
`vision`; items of a closed menu are not in a capture, so the model opens menu
items with the `menu` action and a path. `type` refuses text that contains a
line break or tab, because 0.35+ sends those as Return and Tab; the model sends
Return or Tab with the `key` action as its own step. Capture by app sends
`list_windows({app})`, which the driver filters by app-name substring or exact
bundle identifier. An optional `changes_only` capture (not with `vision`) sends
`since` with the window's previous snapshot and returns the driver's diff rows
or `no_change` without element numbers. Either way the previous numbers are
cleared and the model takes a full capture before acting by number, because
upstream prunes unrendered echo text rows while keeping their indices and its
`no_change` ignores reindexing, so indices can shift under `no_change`. On
`no_change` the driver's `focused_element` row is passed through. On macOS
0.38.0, refusal codes actively emitted by the driver include:
`write_not_applied` (the control read back unchanged, so choose another route),
`window_not_key` (focus or document menu context not confirmed, including
0.37's sibling-window `invoke_menu` guard #5520), `target_focus_unconfirmed`
(0.37's `press_key` target-focus check #5372, mapped alongside `window_not_key`
to `focus_unconfirmed`), `screen_locked` (0.37's locked-screen / screen-saver
refusal #5483, which invalidates the capture and asks the user to unlock
without offering a foreground retry, since foreground input would reach the
lock screen), `select_menu_would_raise_window` (0.37's background web
`<select>` click refusal #5353, which keeps the capture and steers the model to
`set_value`), `desktop_coordinate_scope_required` and
`element_bounds_unavailable` (window target refusals), and
`background_unavailable`. Aiden reads `background_unavailable` by its
`reason` and `effect`: reason `windowserver_connection_invalid` (a daemon with
no valid WindowServer connection; nothing was sent) is reported as
`permission_required` with the setup text, not a foreground retry; reason
`drag_and_drop_session` with effect `no_drop` (the drag's press and moves were
posted and released at once) and any other effect besides `refused` invalidate
the capture and ask the model to capture and check before any foreground retry
(`drag_released`, or `execution_unknown` for a non-drag action); anything else
offers the approved foreground retry. On refused `ActionResult` payloads Aiden
also reads 0.37's top-level recovery `hint` (#5493) when `error.hint` is
omitted, while omitting raw driver `next_call` tool names from the consolidated
`computer_use` surface. The remaining mappings stay forward-compatible:
`windowserver_connection_invalid`, `permission_required` and
`direct_capture_consent_required` as codes (reported as
`permission_required`), `electron_main_process_unavailable` (foreground
retry), and `foreground_partial_unknown` (Linux/Hyprland only; an unknown
execution outcome).

Upstream publishes a cosign (Sigstore) bundle beside each release asset. The
pinned archive SHA-256 stays the authority; `npm run computer-use:vendor --
--verify-sigstore` additionally verifies the bundle against the exact
`cd-rust-cua-driver.yml` release-workflow identity when `cosign` is installed.

The kernel launch requirement embedded in `darwin_security.m` is generated from
the reviewed pins by `node scripts/generate-cua-launch-requirement.mjs`
(`--check` verifies the checked-in bytes, `--write` rewrites them; update the
length and SHA-256 pinned in `driver.rs` afterwards). The generator uses Apple's
LightweightCodeRequirements encoder and reproduces the former 0.8.3 bytes
exactly.

Every upstream `cua-driver-rs` release, including the pinned 0.38.0, is marked pre-release. Aiden treats
Computer Use as a gated beta until the real-driver smoke matrix and release
signing checks in Phase 4 pass. The bare universal asset carries Cua's valid
Developer ID signature (`YCK386LBJ7`) but Gatekeeper does not accept it as an
independently notarized executable. Packaging must preserve that upstream
signature and exact hash while signing the containing helper and complete outer
app with Aiden's identity, then notarize the complete release.

## Process boundary

The packaged helper is `Contents/Helpers/CuaDriver.app`. Its display name is
**Aiden Computer Use**, but its `CFBundleExecutable` is Aiden's small Rust broker,
not `cua-driver`. The untouched pinned driver remains a second executable inside
the bundle. No Swift code is used.

A direct CuaDriver.app wrapper is insufficient: any same-user process could
relaunch the already-granted app and drive its stdio or socket. The broker
therefore accepts no driver arguments or public privileged mode. Aiden directly
spawns the same signed Rust executable in unprivileged bridge mode with a
dedicated Node IPC socket on fd 3. The bridge authenticates the live Aiden main
process from that socket's full kernel audit token, verifies the exact enclosing
signed Aiden build through Security.framework's audit-token guest lookup, and
requires Aiden to remain its direct parent. Aiden separately validates the exact
child PID it spawned. The bridge and LaunchServices broker then mutually
authenticate their connected live processes, including the broker's exact
current-build code identity, before privileged transport begins. The bridge—not
Aiden—connects to and holds a separate broker-owned, one-shot launch lease; the
broker authenticates that lease's full audit-token identity before publishing
its control socket, and the bridge verifies that the lease and control sockets
belong to the same broker process incarnation. Lease EOF revokes the entire
broker group. Aiden never connects to or accepts a pathname authentication
socket, so its authenticated endpoint cannot be transferred to impersonate it.
Static pathname checks and reusable numeric PIDs are not treated as live-process
authentication.

After authentication, the broker:

1. starts the pinned driver as
   `cua-driver mcp --embedded --direct --host-bundle-id com.sambitcreate.aiden-agent.cua-driver`
   with anonymous stdin/stdout pipes, so the driver's permission report names
   the separately granted signed broker that owns TCC responsibility. Since
   0.34, embedded `mcp` requires either a private `--socket` service or
   `--direct`; Aiden uses `--direct` so the MCP child owns its runtime and no
   pathname socket exists. Direct mode disables the driver's on-screen agent
   cursor overlay, which Aiden does not use;
2. establishes occupied broker and driver-supervision groups before any
   privileged child exists, then uses macOS's kernel-enforced launch requirement
   to admit only the reviewed Cua signing identity, Team ID,
   cross-architecture CDHashes, platform, and hardened code flags before the
   driver can execute its first user-space instruction; an independent watchdog
   stops the exact child by audit token, dynamically revalidates that process
   incarnation and path, occupies its private group, and resumes it only after
   the launcher has joined the same group;
3. parses the relayed MCP JSON-RPC and allows only initialization, tool catalog,
   health/permission/capture/enumeration, session lifecycle, and the explicit
   Hermes action-tool allowlist;
4. keeps every privileged pipe endpoint inside the authenticated chain and
   terminates/reaps the complete containment group when either peer closes.

The embedded driver intentionally ignores `check_permissions.prompt`. When the
user explicitly chooses **Request access** in Aiden, the authenticated broker
recognizes only the exact internal `check_permissions { prompt: true }` shape,
requests Accessibility and Screen Recording from its own LaunchServices-owned
host identity with Apple's public APIs, rewrites the driver call to a status-only
recheck, and grants no prompt authority to expanded or malformed calls. Aiden
then tears down that driver and checks readiness with a fresh helper so a stale
per-process TCC cache cannot report the pre-prompt state.

Since 0.34 the driver runs its live ScreenCaptureKit probe only on a prompting
call. Because the broker rewrites Aiden's prompting call to a status-only
recheck, the driver never receives one, so in embedded mode
`screen_recording_capturable` is always `null`
(`direct_capture_status: "not_checked"`). Since 0.36 upstream's prompting
`check_permissions` call also takes one tiny ScreenCaptureKit frame so the
direct-capture consent appears during the explicit grant rather than over the
user's window (#5352), and a bundle-identifier approval counts as that consent
(#5402). Whether the consent now appears during **Request access** in Aiden,
given the status-only rewrite, is unverified until packaged acceptance; if it
appears over the first capture instead, Aiden's fallback is unverified: the
macOS 0.38.0 driver does not send a `direct_capture_consent_required` code, so
the mapping that reports it as `permission_required` with the setup text is
forward-compatible only (Aiden does not yet reopen the readiness checklist
mid-chat). Readiness therefore rests on the
Accessibility and Screen Recording TCC preflight booleans; an explicit `false`
from a probe that did run still vetoes. This is weaker than the 0.8.3 live
probe: a stale preflight can report ready, after which the first screenshot
capture fails and the controller refuses pixel actions. Packaged acceptance
must confirm the report still carries `embedded: true` and
`attribution: "host"` under `--direct`.

An internal anonymous-pipe guard occupies the broker group and receives no
public arguments. Before calling Foundation or Security, the dormant launcher
forks a fallback sentinel and independent watchdog. The watchdog captures the
launcher's audit token and continuously inspects only its direct children while
`launchAndReturnError` is unresolved. Once the constrained child appears, the
watchdog stops that exact PID-version, validates it, and joins its private
process group. After Foundation returns the same PID, the launcher joins too.
Both then remain kernel occupants even if Foundation auto-reaps the driver. If
Aiden exits, the broker crashes, either peer disconnects, or either supervisor
dies, an occupant signals its current group with bounded TERM-to-KILL cleanup.
No delayed cleanup targets a cached numeric PID or PGID.

Public macOS APIs do not combine `NSTask.launchRequirementData` with an atomic
start-suspended/process-group attribute. During authority revocation the
watchdog therefore never kills a launcher whose launch call is still unresolved:
that could allow a child to commit just after the check. It keeps scanning and
contains any late child instead. If the OS call permanently wedges before
creating a child, an inert janitor may remain until that call resolves; it has no
MCP input or driver authority. This deliberate fail-closed tradeoff preserves
the kernel first-instruction requirement without private spawn SPI.

The broker never unlinks a caller-named path; Aiden removes only its own confined
temporary directory after the complete child boundary has exited.

There is no filesystem bearer, public daemon socket, or model-visible driver
credential. Mode 0700/0600 paths would not isolate a secret from another process
running as the same user, so Aiden deliberately uses no such secret-transfer
scheme. Each generation gets its own broker, bridge, embedded MCP child, random
driver session ID, serialized MCP call queue, selected window, and element-token
snapshot. Normal teardown makes a bounded best-effort `end_session` call. Abort,
timeout, or transport loss invalidates the generation and kills its whole driver
process group so an in-flight native action cannot finish later in a detached
daemon.

Provider credentials, OAuth tokens, Node/Electron injection variables, proxy
credentials, and dynamic-loader variables never cross either child boundary.
Cua recording/replay is not exposed because it persists complete tool arguments
and creates a broader filesystem/output surface than this integration needs.

Ad-hoc hot-reload builds cannot satisfy the packaged signing/team check and must
not claim the isolated TCC boundary. Unit/integration tests use a faithful fake
bridge; real permission acceptance is performed only with a team-signed
packaged app. Release packaging disables RunAsNode, Node environment options,
and CLI inspection, enables embedded ASAR integrity and ASAR-only loading, and
gives the Rust helper no Electron JIT or library-validation exceptions.

Computer Use requires macOS 14.4 or newer because that is the first supported
deployment target for the launch-requirement API used by this fail-closed helper.
The rest of Aiden may continue to run on its broader macOS range with Computer
Use unavailable.

## Guest lane in Bot computers

Bot computers (`docs/bot-computers.md`, "Guest driver lane") run the same
pinned `cua-driver` 0.38.0 inside a Bot's own virtual machine, for element
reads and element clicks there (the macOS universal binary for macOS guests,
and the pinned Linux arm64 binary in
`resources/computer-use/cua-driver-linux-arm64-artifact.json` for upcoming
Linux guests):

- Set up and Update base copy only the upstream-signed `cua-driver`
  executable from the vendored helper into the base over Aiden's SSH, with the
  helper's `LICENSE.cua-driver.md` beside it. The
  guest checks its SHA-256 against the compiled pin and its signature against
  the pinned Cua identifier and Team ID before it is put in place. The guest
  never downloads a driver, never resolves one from `PATH`, and never runs the
  installer or the self-updater.
- Aiden's broker stays on the Mac and is not copied: inside the guest the
  virtual machine is the boundary. A LaunchAgent in the guest's logged-in
  session runs `cua-driver serve --socket <guest socket> --no-overlay
  --no-permissions-gate` with the Mac driver's fixed environment (telemetry
  and update checks off, `DO_NOT_TRACK=1`, `CUA_DRIVER_DISABLE_RUN_SCRIPT=1`)
  but without the broker's host bundle identifier, since the guest driver
  holds its own grants. The grants of Accessibility and Screen
  Recording are made by the person in the base's live view and copied into
  every Bot computer made from it.
- Each session is one SSH child running `cua-driver mcp --embedded --socket
  <guest socket>`. `CuaDriverSession` checks the exact 0.38.0 catalog,
  Aiden's allowlist and every required tool before any call, and
  `ComputerUseController` keeps the same denied tools, safety refusals and
  element-token binding as on the Mac. Its per-action access cards don't
  apply: the Bot's rules classify each call first, and the controller then
  authorizes it for that one call.
- A driver error or Take over ends that controller's generation; the next
  call starts a fresh session.
- A computer uses the guest lane only when the base's probe (a list of apps
  and a screenshot) passed for this exact pin. A new pin arrives only with an
  Aiden release; until the base is set up again with it (Update base or Set up
  element control) and a Bot's computer is Reset, that computer stays on the
  screen lane.

## Phased delivery and review gates

1. **Foundation:** compiled artifact pins and vendor verification; absolute
   binary resolution; mutually authenticated Rust broker/bridge and process-group
   supervision; anonymous embedded MCP transport; strict MCP method/tool
   allowlist; filtered tool catalog and initialize/tools/start/end lifecycle;
   strict child environment; abort, timeout, disconnect, process-tree, fuse,
   signing, and serialized-call tests.
2. **Agent adapter:** the consolidated Hermes-compatible schema; capture and
   all action mappings; image/structured result normalization; capability and
   stale-element-token handling; action-aware approvals; model capability
   gating; cancellation and exact-target `capture_after`. Coordinate fields use
   homogeneous numeric arrays bounded to exactly two items so OpenAI-compatible
   providers receive object-valued JSON Schema `items`; runtime validation still
   independently requires two finite nonnegative values.
3. **Product surface:** persisted global enablement, a per-chat access card
   ("Use your Mac with Computer Use?": Deny / Allow in this chat, with Always
   allow in its menu) raised by the first call, and
   Always allow / Reset chat permissions in Settings;
   readiness/doctor/permission IPC; lifecycle cleanup.
4. **Release and acceptance:** isolated development output plus transactional
   distribution staging; mandatory Developer ID and notarization preflight;
   nested signature, staple, Gatekeeper, entitlement, fuse, and
   packaged-resource validation; privacy documentation; the full test suite;
   and an opt-in operator-driven real-driver smoke against an isolated profile
   and uniquely titled disposable TextEdit window. The smoke seeds both gates
   off, then uses the normal Settings, macOS TCC, per-chat access card, Stop, and
   quit paths with a capability-authenticated, loopback-only scripted
   vision/tool model—never a privileged test backdoor. It validates and owns the
   exact system TextEdit executable, correlates every result to its tool-call ID
   and exact PID/window, rejects failed or denied actions, and verifies the saved
   marker and post-action capture. Only the visible Stop control emits the
   content-free explicit user-Stop event; unmount/navigation cleanup cannot
   satisfy this evidence. The harness proves Stop reaped the helper while Aiden
   remained alive and only then accepts a normal app quit. Failure cleanup
   actively TERM-to-KILLs only exact package-owned broker/driver and disposable
   TextEdit processes with PID-reuse checks.

The reproducible commands are:

```bash
npm run package
npm run package:verify
AIDEN_COMPUTER_USE_ACCEPTANCE=1 npm run test:computer-use:packaged
```

The acceptance command intentionally stops for visible macOS TCC decisions and
one Computer Use access card (choose **Allow in this chat**); the type,
save-key and stale-click actions then run without further cards. On success it writes
an evidence-only receipt to `build/computer-use-acceptance-receipt.json`, bound
to the tested app's signed CDHash, app-ASAR hash, bundle ID, and versions. A new
package or acceptance run invalidates the old receipt. TCC grants are persistent
macOS state and must be revoked manually in System Settings if no longer wanted.
Distribution uses `npm run dist`; it removes the old canonical output, builds in
staging, and promotes only verified current DMG/ZIP output. Its after-sign and
pre-promotion verifiers require Aiden's Developer ID Application identity, a
stapled ticket, and a successful Gatekeeper assessment. Pre-promotion also
validates and mounts the DMG read-only, extracts the ZIP privately, runs the full
package/notarization verifier on both embedded apps, and binds their bundle
versions, signed CDHash, and app-ASAR hash to the verified staging app. A receipt
for the development package is not evidence of a notarized distribution.

Freeze a phase only after its automated gates and independent reviews pass.
Operational evidence remains artifact-specific: no release is accepted until
`release:verify` passes that exact canonical distribution, and no packaged
Computer Use smoke is accepted until its identity-bound receipt exists.

## Non-negotiable safety rules

- Capture-derived AX/OCR text is untrusted application content, never system
  instructions.
- Capture, wait, and enumeration are read-only. Input actions require Computer
  Use access for the chat (a one-time access card or Always allow), independent
  of workspace permission; each action's grant is still bound to the exact
  target and consumed once.
- Foreground delivery is a distinct visible-risk approval and is unavailable
  unless the driver advertises the capability. Menu actions and modified clicks
  are always foreground. Drag (including a modified drag) defaults to the
  background since 0.36; Aiden offers a foreground retry, with its own
  approval, when the driver refuses with `background_unavailable` before any
  input (for example an Electron window). When a background drag starts a
  native drag-and-drop session the driver has already posted the press and
  moves and releases at once (`reason: "drag_and_drop_session"`, effect
  `no_drop`); Aiden then invalidates the capture and tells the model to capture
  and check before any foreground retry. Aiden never re-sends the drag itself. Drag still has no element endpoints: a named
  element becomes its center point.
- Turns nobody started from a window (unattended follow-ups, a paired
  device's turns, turns Aiden owes a chat) refuse `computer_use`. A
  [keep-going goal](keep-going-goals.md) round may use it only when it starts
  in a focused window that shows the chat on an unlocked screen; the round is
  then that window's own run, with the same access card, approval mode and
  lock-screen refusal as the person's message. Focus is checked only before the
  round starts, since Computer Use brings other apps forward; the window
  closing, reloading or showing another chat stops the round. A round without
  a window is refused the tool and the goal bar offers **Continue here**.
- Dangerous system shortcuts and destructive shell-like text are rejected
  before the approval prompt.
- Screenshots and base64 image payloads remain transient in the Pi tool loop;
  Aiden does not write them to its chat history or application logs. The
  selected model provider handles received content under its own data policy.
- Production does not accept an arbitrary driver path. Development cannot bypass
  the pinned hash and signing checks.
- The granted helper never accepts model-selected driver arguments, a public
  daemon mode, or a caller-selected cleanup PID/path. Unexpected transport loss
  invalidates and terminates the complete generation.

## Sources audited

- Hermes: `tools/computer_use/schema.py`, `tool.py`, `cua_backend.py`,
  `permissions.py`, and multimodal routing in `run_agent.py`.
- Cua: the 0.8.3, 0.34.1, 0.36.0 and 0.38.0 release checksums, `Skills/cua-driver/EMBEDDING.md`,
  `WORKFLOW.md` and `MACOS.md` (0.34.1), the action-result contract, telemetry
  documentation, platform support, installer scripts, and release workflow.
  Re-audited for 0.38.0 (tag `cua-driver-rs-v0.38.0`, commit
  `85e2b1318bd77ccf3cfa88ccdf875a4bb7eaed19`): macOS universal and Linux arm64
  release tarballs, `SHA256SUMS`, `release-manifest.json`, Sigstore bundles,
  Mach-O CodeDirectory CDHashes, `scripts/docs-generators/cli-specs/cua-driver-mcp-{macos,linux}.json`,
  `libs/cua-driver/contract/manifest.json`, `libs/cua-driver/rust/CHANGELOG.md`,
  `cua-driver-core/src/{background_input,delivery,recovery_hint,tool}.rs`,
  `platform-macos/src/{display_awake,tools/{click,drag,get_window_state,hotkey,invoke_menu,press_key,type_text}}.rs`,
  `platform-linux/src/tools/impl_.rs`, and `crates/cua-driver/src/{cli,main,serve}.rs`.
- Aiden: Pi agent/tool types, `llm-client.ts`, generic MCP manager, approval UI,
  config/chat persistence, Electron lifecycle, preload allowlists, and packaging.

## Linux managed payload preparation

Linux Computer Use remains disabled while its authenticated launch boundary is
implemented. `scripts/linux-payload-inventory.mjs` provides a reusable inventory
check for a finalized, trusted, quiescent payload tree. It records every regular
file and directory, including file hashes and modes, and rejects links and
special files. The expected inventory is external to the payload: nothing in the
payload is excluded from comparison.

```sh
node scripts/linux-payload-inventory.mjs compute /absolute/staged/payload /absolute/trusted/inventory.json
node scripts/linux-payload-inventory.mjs verify /absolute/staged/payload /absolute/trusted/inventory.json
```

Compute an expected inventory only after authenticating the release and completing
trusted extraction into isolated staging. A future privileged installer must protect
both the staged tree and expected inventory from hostile writers. Do not regenerate
an expected inventory from an installation whose integrity is in doubt: that would
accept its modified files. A matching attacker-supplied inventory proves nothing
about release identity. See [Linux package provenance](releasing.md#linux-package-provenance).

The inventory utility itself is not a privileged installer, immutable storage
mechanism, atomic filesystem security boundary, or live-process authenticator.
It does not inventory host libraries outside the supplied tree or constrain JIT.
Electron Builder adds files after afterPack, and package installation can alter
sandbox permissions, so the final intended generation must be inventoried rather
than assuming an earlier packaging-hook snapshot is complete.

`native/linux-managed-payload` supplies the next local-only preparation step. A
trusted operator can stage an already approved inventory into a private
root-managed store on an SELinux-enforcing host:

```sh
sudo aiden-managed-payload stage \
  --store /var/lib/aiden-managed-payload/store \
  --source /absolute/trusted/extracted-payload \
  --inventory /absolute/protected/inventory.json \
  --approval /absolute/protected/local-staging-approval.json
```

The approval must use schema version 1 and kind `local-staging-only`, and bind
the exact inventory-file SHA-256. The stager validates protected ancestry and
metadata, copies into fresh root-owned inodes through descriptor-relative paths,
sets the store's exact SELinux creation context, verifies every copied entry,
restores the process creation context, and publishes the inventory-digest-named
generation without replacement. Its receipt deliberately records
`releaseAuthenticated`, `runtimeAdmission`, and `kernelImmutable` as false.

This command neither authenticates release attestations nor activates, launches,
or confines the generation. Do not treat a locally staged generation as
production Computer Use admission. Production still needs authenticated release
acceptance, root-managed active-generation selection, exact-generation launch,
complete process and loader confinement, live process-incarnation supervision,
and an accepted GNOME capture/input driver.
