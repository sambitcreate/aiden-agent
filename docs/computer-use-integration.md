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

Aiden pins the macOS universal `cua-driver` 0.8.3 artifact from tag
`cua-driver-rs-v0.8.3` and source commit
`0612c26b2c7b8556f6de7f6b4f3927ecac914e4f`. Both the archive and extracted
binary SHA-256 values are recorded in
`resources/computer-use/cua-driver-artifact.json`. The security-critical binary
hash, Cua signing identifier, and Cua Team ID are also compiled into Aiden and
the broker rather than trusted from that mutable metadata. Driver updates
happen only in reviewed Aiden releases.

The runtime never executes Cua's moving installer, never resolves a production
driver from `PATH`, never follows an executable path returned by the driver's
manifest, and never invokes its self-updater. Upstream telemetry and update
checks are disabled in every child process. The MIT notice ships beside the
helper.

The pinned 0.8.3 release is currently marked pre-release upstream. Aiden treats
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
   `cua-driver mcp --embedded --host-bundle-id com.sambitcreate.aiden-agent.cua-driver`
   with anonymous stdin/stdout pipes, so the driver's permission report names
   the separately granted signed broker that owns TCC responsibility;
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

Ad-hoc development builds cannot satisfy the production signing/team check and
must not claim the isolated TCC boundary. Unit/integration tests use a faithful
fake bridge; real permission acceptance is performed only with a team-signed
packaged app. Release packaging disables RunAsNode, Node environment options,
and CLI inspection, enables embedded ASAR integrity and ASAR-only loading, and
gives the Rust helper no Electron JIT or library-validation exceptions.

Computer Use requires macOS 14.4 or newer because that is the first supported
deployment target for the launch-requirement API used by this fail-closed helper.
The rest of Aiden may continue to run on its broader macOS range with Computer
Use unavailable.

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
   gating; cancellation and exact-target `capture_after`.
3. **Product surface:** persisted global enablement and per-chat activation;
   readiness/doctor/permission IPC; Settings and composer controls; accessible
   allow-once approval details; lifecycle cleanup.
4. **Release and acceptance:** vendored binary, nested signature/notarization
   validation, packaged-resource inspection, privacy documentation, full test
   suite, and an opt-in real-driver smoke against a disposable app window.

Every phase is frozen and independently reviewed before the next phase begins.

## Non-negotiable safety rules

- Capture-derived AX/OCR text is untrusted application content, never system
  instructions.
- Capture, wait, and enumeration are read-only. Every user-visible input action
  requires a fresh Allow once decision, independent of workspace permission.
- Foreground delivery is a distinct visible-risk approval and is unavailable
  unless the driver advertises the capability.
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
- Cua: the 0.8.3 release/checksums, `Skills/cua-driver/EMBEDDING.md`, telemetry
  documentation, platform support, installer scripts, and release workflow.
- Aiden: Pi agent/tool types, `llm-client.ts`, generic MCP manager, approval UI,
  config/chat persistence, Electron lifecycle, preload allowlists, and packaging.
