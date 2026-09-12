# Linux macOS parity reconciliation

Status: Active — phases 1–3c implemented and reviewed; phase 4 hosted validation running; Fedora Computer Use prerequisites in progress, 2026-09-12.

Baseline: Linux `6a397578` (0.36.1), macOS main `a4c85c6d` (0.40.0).

## Phases and gates

1. Integrate stacked Linux fixes `e0f48366`, repair the service status contract, and validate remote/Wayland behavior.
2. Reconcile current main shared runtime, persistence, chat, browser, terminal, settings, onboarding and mobile contracts while preserving Linux platform integrations.
3. Audit and implement remaining feasible Linux native parity, including Bots security backend, dictation and Computer Use; retain explicitly platform-specific Apple capabilities and respect compositor/package-manager ownership.
4. Validate macOS regressions and native Linux x64/arm64 packaging, desktop behavior, mobile contracts and final feature matrix.

After every phase, two independent GPT-6 Astra reviewers at medium effort review the implementation. Resolve actionable findings and rerun relevant checks before proceeding. Record evidence and limitations; no claim of full parity before applicable native acceptance passes.

## Evidence

- Linux support branch pulled; stacked fixes fast-forwarded locally.
- Phase 1 fixes a hosted TypeScript failure: service status omitted `permission_denied` although renderer status and runtime handling included it.

- Phase 1: type-check and focused lint passed; initial remote/Wayland suite 113 passed, 1 skipped; post-review regression suite 51 passed, 1 skipped. Two GPT-6 Astra medium reviewers cleared all findings after fixes for Chromium feature preservation and Tailscale error precedence.

## Phase 2 evidence

- Reconciled main 0.40.0 into Linux; 31 merge conflicts resolved by ownership.
- Shared chat drafts/queue/sidebar, durable memory/Pi lifecycle, browser, Ghostty, Settings, onboarding and remote/mobile contracts retained.
- Two GPT-6 Astra medium reviewers cleared runtime/mobile and renderer/build scopes; fixed unsupported Linux hold-to-dictate UI and explicit main-to-renderer capability projection.
- Full desktop command: 5,916 passed, 3 skipped, zero failures. TypeScript including E2E, lint, branding, production build passed.
- macOS targeted Electron: 12 passed (browser, real PTY, chat controls, guided pairing).
- Android: 141 unit tests passed, lint and instrumentation compilation passed. iOS generic hardware app/test compilation passed; physical execution remains unverified.
- Native Linux ARM64 container: type-check, platform contracts, safety helper tests and production build passed.
- Linux ARM64 Electron initially 10 passed / 2 failed: annotation preview and recording startup time out when rendering hidden surfaces. These native runtime gaps remain explicit phase 3 work; shared-source reconciliation does not claim native acceptance.
- Foreground model catalog parity restored according to root user instructions; fixed endpoint/cache privacy suite plus UI/onboarding checks: 24 passed.

## Remaining native parity matrix

| Capability | Current Linux implementation | Next acceptance |
| --- | --- | --- |
| Bots and Bot Telegram routes | Linux Secret Service authority implemented; two source reviews cleared | Native keyring, ARM64 packaging and Linux Settings acceptance passed; hosted multi-distro gates remain |
| Dictation capture/transcription | Available; toggle shortcut and clipboard delivery | Desktop-owned release events and safe paste when available, X11/Wayland acceptance |
| Computer Use | Gated off; broker and process trust require macOS | Linux capture/input/accessibility backend and equivalent lifecycle/security boundary |
| Updates | Eligible mounted AppImages support verified downloads and atomic replacement; DEB/RPM remain package-manager owned | Future published-version download/restart acceptance |
| Apple-only services | Apple Foundation Models and Dock integration unavailable by platform | Preserve local model alternatives and native Linux desktop behavior |

Full parity is not claimed by the shared-feature merge. Native implementation and target desktop acceptance remain required.

- Phase 2 merge gate complete: both required reviewers cleared integration findings. Linux x64 type-check/contracts/native helpers/build passed under local emulation. ARM64 AppImage/DEB/RPM built and hardened package verifier passed; DEB install reported 0.40.0 and survived a bounded Xvfb GUI smoke. Native recording and detached capture remain phase 3 scope.

- Final phase 2 reviews cleared imported on-device title preference correction and Linux hidden-view capture fix. Expanded ARM64 browser annotation/inactive screenshot test passed; original recording test passed on x64. ARM64 Chromium recording crashes remain a phase 3 runtime investigation; failed experiments were reverted.

## Phase 3a: Linux Bots authority

- Added native Secret Service helper and platform authority factories, preserving macOS Keychain namespaces and bootstrap semantics. No plaintext/file authority fallback or interactive keyring prompt.
- Reused existing Bots settings/navigation and onboarding artwork on Linux; startup failures remain isolated from workspace chat.
- Two Astra medium source reviews cleared after repairing test coverage registration. Bots coverage suite passed 445/445 after accounting for Node’s coverage instrumentation in the helper environment fixture; type-check and Linux contracts passed.
- Private GNOME Keyring tests cover four authority namespaces, reads/writes across helper processes and daemon replacement, locked collection failure, session-only storage rejection, real duplicates, and missing default collection. CI runs this isolated Linux acceptance command.
- Native ARM64 AppImage/DEB/RPM built and hardened package verification passed. Linux Settings Electron acceptance passed, including all Settings destinations and Bots navigation; corrected imported Mac-only Voice label. Both Astra medium reviewers cleared the final changes. Phase 3a complete.

### ARM64 recording diagnosis

A minimal visible-canvas Electron reproduction crashes at the ARM SVE instruction `cntd` on this OrbStack host (SME present, SVE absent). This matches upstream libyuv [fab11704](https://chromium.googlesource.com/libyuv/libyuv/+/fab11704cda62ff2d6b5e308b741e759ae816035). Chromium ignores libyuv environment-disable variables. No Aiden recorder change is justified by current evidence; acceptance needs an Electron build containing the upstream fix. This is specific to the tested CPU feature combination, not evidence that all ARM64 recording fails.

## Phase 3b: AppImage update delivery (complete)

- Add runtime eligibility for writable mounted production AppImages, preserving package-manager updates for DEB/RPM and manual replacement for extracted/read-only images.
- Reuse About update controls through a main-provided capability; preserve Darwin behavior and avoid Linux signing claims.
- Generate architecture-specific minimal AppImage feeds from exact release bytes; verify hashes again before publishing any release assets.
- Implement atomic replacement with failure preservation and test disposable files before enabling installation. Both Astra medium reviewers cleared final changes after fixing swallowed installer failures during restart handoff.

- Phase 3b validation: 19 updater tests, 27 release/branding script tests, 30 About/capability tests passed; full lint and TypeScript passed. ARM64 distributions built and verified. A real FUSE-mounted disposable AppImage passed runtime eligibility, atomic replacement, and replacement executable launch/version acceptance. Feed generation/verification passed against real package bytes. Future-version GitHub download and full production restart remain a release acceptance check.

## Phase 3c: Linux hold dictation (complete implementation)

- Explicit Voice Settings choice creates a desktop-owned GlobalShortcuts portal session; no permission prompts on startup. The displayed trigger comes from the compositor. Session loss, binding changes, disabled policy, and recorder suspension restore toggle ownership.
- Native helper fences portal owner/request/session/shortcut signals. Main fences helper generations, early release and recording operations. Persistence commits use the latest Settings revision.
- Both Astra medium reviews cleared after fixes for duplicate toggle registration and stale Settings persistence.
- Nine native private-D-Bus cases, 87 voice tests, onboarding, Linux Settings Electron, TypeScript, full lint, ARM64 package build/verifier passed. Full desktop command passed 5,946 tests, 3 skipped, zero failures.
- Real GNOME/KDE shortcut assignment and physical press/release acceptance remain external to the mock and Xvfb tests. Linux transcript delivery remains clipboard-only.

## Phase 4: Hosted acceptance repair (complete; hosted CI passed)

Hosted CI at cedcc841 passed shared verification, macOS Electron, Android, and Linux ARM64. Linux x64 passed packaging/keyring but failed three Electron cases: legacy empty-chat migration, unsupported Computer Use setup expectation, and Model Pad minimum-height fit with Linux window chrome. Repair and rerun before final acceptance; Fedora RPM job depends on x64 success.

## Computer Use admission work remaining

The pinned upstream Cua 0.8.3 release has Linux x64/arm64 artifacts, but the Aiden broker deliberately requires macOS live code-signing/audit-token authentication. A same-UID socket, PID, executable pathname, hash check, or bearer secret cannot substitute for that existing contract.

A Linux implementation needs a root-managed verified release payload and an enforced execution domain covering Aiden main, broker, and driver. Exact-build identity, constrained loaders/children, protection against process-memory and descriptor access, and admission before driver execution must survive the complete launch chain. A dedicated broker UID by itself is insufficient. Portable AppImage support would also require separate trusted provisioning.

Next implementation target is a distro-specific policy prototype (Fedora/SELinux or Ubuntu/AppArmor), with reviewed negative tests for tampered executable/ASAR/libraries, unauthorized clients, transferred descriptors, reused PIDs, and peer-loss revocation. Graphical acceptance must additionally verify capture, AT-SPI, and permitted foreground/background actions per compositor. The upstream KDE/background-action matrix has gaps; upstream fixture claims are not Aiden acceptance.

Current Linux Computer Use gate stays disabled until this boundary is implemented and validated. Real compositor hold-shortcut acceptance, focused-element-safe dictation paste, and an Electron release carrying libyuv fab11704 also remain before a full parity claim.

- Phase4 fixes: shared subagent generation validation now accepts exactly Linux7-field and macOS9-field identities; migration safety remains unchanged. Linux draft suite5/5 passed. Compact ModelPad layout passes all24native Linux geometry states with160px minimum retained. Guidedsetup now asserts unsupportedComputerUse absence onLinux (3tests passed). Mac focused Electron9/9 passed; lint/typecheck/build and36focused store tests passed. Both Astra medium reviewers cleared final changes.


## Phase 5: Fedora GNOME Computer Use admission prerequisites

The user selected Fedora GNOME with SELinux as the first implementation target.
OrbStack's tested kernel (`7.0.14-orbstack-00380-ga7e0a2dc9535`) reports only
`capability,landlock,yama,bpf` in `/sys/kernel/security/lsm`. Installing Fedora
userspace there cannot validate SELinux enforcement. A separately booted Fedora
GNOME host with enforcing SELinux is required for native acceptance.

Run `npm run computer-use:linux-host-preflight` on the target desktop.
The host preflight command is a read-only prerequisite diagnostic. Even a
successful result does not authenticate a release, prove installed policy, or
enable Computer Use. The existing Linux capability gate remains disabled.

### Required launch-boundary prototype

1. Root-managed provisioning verifies release provenance and the full immutable
   payload: Electron, ASAR, snapshots, native addons, broker, driver and admitted
   libraries. [fs-verity](https://www.kernel.org/doc/html/latest/filesystems/fsverity.html)
   can protect file contents but does not itself enforce executable admission.
2. A native launcher accepts fixed arguments, sanitizes environment and inherited
   descriptors, and enters an exact-release main domain. Distinct broker, driver
   and Electron child domains must prevent renderer/utility/zygote processes
   acquiring main authority. Source-domain/executable-label transitions require
   actual Electron fork/exec validation; an argv role claim is insufficient.
3. Audit the effective policy against hostile unconfined processes. Fedora's
   [targeted policy](https://github.com/fedora-selinux/selinux-policy/blob/rawhide/policy/modules/kernel/domain.te)
   grants broad access from unconfined domains, so an additive module alone does
   not establish isolation. Verify installed toolchain support before relying on
   [CIL deny rules](https://github.com/SELinuxProject/selinux/blob/main/secilc/docs/cil_access_vector_rules.md);
   neverallow is a compile-time assertion, not permission subtraction.
4. Enforce entrypoint and executable mapping restrictions before execution,
   protect runtime code sources and constrain the main process's required JIT.
   Linux lacks Electron's macOS/Windows
   [embedded ASAR integrity implementation](https://www.electronjs.org/docs/latest/tutorial/fuses).
   Authenticating the interpreter alone does not authenticate writable scripts.
5. Bind private channels to live process incarnations and contain all descendants
   through a trusted supervisor. Kernel credentials alone do not prevent endpoint
   delegation: negative tests must cover inherited/transferred descriptors,
   `/proc/PID/fd`, ptrace, `pidfd_getfd`, PID reuse and peer-loss revocation.

Acceptance requires tampered executable/ASAR/snapshot/library/driver rejection,
unauthorized same-UID clients, Electron role confusion, and complete revocation
under failure. Record the exact kernel, loaded policy, toolchain and release.
After these pass, validate GNOME capture, AT-SPI, portal permission and supported
foreground/background actions. These are requirements, not implemented controls
or a claim that Fedora Computer Use currently works.

- Phase 5 prerequisite diagnostic: 29 tests passed; both GPT-6 Astra medium reviewers cleared. Local OrbStack container correctly reports missing SELinux/session prerequisites. This completes the diagnostic subphase only; enforced launch-boundary implementation is still pending.
- Hosted phase 4 run 34675055415: shared verification, macOS Electron and Linux ARM64 passed. Linux x64 now reaches 52 passing tests but Providers overflows by 17px at 390px; empty-chat migration passed on retry. Android emulator package installation failed with a broken pipe. Fedora RPM remains gated on x64.

## Phase 6: Narrow Providers and migration fixture repair

- Reproduced the hosted 17px overflow locally; constrained the existing Providers action group to its available width. The unchanged full Settings destination/width matrix passes on Linux. Resize checks now wait for the renderer to observe native content width.
- Migration E2E no longer writes the index while Electron can rewrite it. All seed mutations run after verified shutdown and before relaunch, with prelaunch index/journal assertions. Production migration is unchanged. Linux draft suite passed 5/5.
- Both GPT-6 Astra medium source reviews cleared. macOS focused regressions passed 8/8; E2E TypeScript and focused lint passed. The next hosted run remains a validation gate.

## Phase 8: Fedora CI prerequisite repair

- Hosted b637bfdc passed shared verification, macOS Electron, Linux x64, Linux ARM64 and Android. Fedora RPM failed before portal execution because dbus-run-session was absent.
- Fedora44 package query identifies dbus-daemon as the provider. Added it to the existing CI prerequisites and extended the CI policy regression. Both Astra medium reviews cleared; six policy tests and the native portal suite on a real Fedora44 container passed.
- Independently booted a new isolated Fedora44 ARM64 UTM VM with kernel 6.19.10-300.fc44.aarch64 and SELinux Enforcing. This removes the OrbStack kernel limitation for future testing; GNOME setup and launch-boundary acceptance are still pending.

## Phase 9: Enforcing Fedora desktop acceptance host

- Provisioned an independently booted Fedora 44 ARM64 VM: kernel 6.19.10-300.fc44.aarch64, SELinux Enforcing, SELinux userspace 3.11, GNOME 50.4 on Wayland, and GNOME portal 50.0. Two independent Astra medium reviewers verified the live host and prerequisite report.
- The VM has 32 GiB sparse storage, key-only SSH bound to host loopback, and no clipboard, directory, or USB sharing. Ordinary outbound NAT remains enabled; this is not isolation from host network services.
- Exact-head CI at f620ef14 (run 34697719544) passed shared verification, macOS Electron, Linux x64, Linux ARM64, Android, and Fedora RPM.

## Phase 10: Native desktop and SELinux prerequisite experiments

- Added fixed desktop application registration before GlobalShortcuts requests. GNOME rejected the previous unregistered connection. Registration is display metadata, never process authentication; older portals may omit the interface, while genuine registration failures remain errors.
- Real GNOME accepted the registered helper, delivered F8 activation and deactivation, and revoked the helper after a settings rebind. Ctrl+D delivered activation but lost deactivation when Control was released first. GNOME Mutter 50.4 looks up the release using the current modifier mask, so the modified binding is missed after modifier release. Hold dictation cannot be declared generally accepted from the F8 result. See [Mutter key processing](https://github.com/GNOME/mutter/blob/50.4/src/core/keybindings.c) and [GNOME portal forwarding](https://github.com/GNOME/xdg-desktop-portal-gnome/blob/50.0/src/globalshortcuts.c).
- Added an explicitly invoked disposable-VM SELinux probe. With the same non-root UID, baseline file/socket access succeeded, target-scoped CIL denies removed effective allows and denied operations, the root-managed fixture service still launched, and removing the overlay restored baseline access. Ptrace/pidfd results require successful baselines and matching AVCs; proc inspection remains separately qualified because stock policy suppresses some audit records.
- The runner bounds unauthorized launch attempts and always attempts every cleanup step. Host-independent regression tests cover verifier rejection and cleanup faults. The sixth real enforcing-VM run passed and removed its fixture service, modules, user and files. This proves synthetic prerequisites only: authenticated releases, Electron role separation, endpoint delegation and complete revocation remain unimplemented. Computer Use remains disabled on Linux.

- Mitigation: GNOME sessions now reject hold setup before portal activation and retain toggle dictation; the gate does not guess from localized descriptions or requested keys. The final helper returned unavailable on the real GNOME host. The native private D-Bus suite passes 13 cases, and Linux contracts pass 151 tests with one platform skip. Both independent Astra medium reviewers cleared the probe and portal changes.

## Phase 11: Descriptor delegation and upstream compatibility

Active: extend the synthetic policy experiment to transferred and inherited file
descriptors, requiring a working baseline, verified receiver domain, exact-run
audit evidence, and effective policy checks. A failed child launch must not be
counted as successful descriptor isolation.

A separate minimal Electron 43.1.1 ARM64 run on the enforcing GNOME Wayland host
successfully launched a sandboxed renderer and Node utility process. Browser,
GPU, renderer, network utility and Node utility metrics all used the same
Electron executable and `unconfined_t` context. The renderer reported seccomp
mode 2 and no-new-privileges. This is an observational prerequisite, not an
identity boundary or a complete process inventory: zygotes are not included in
`app.getAppMetrics()`. A filename or argv role check would not distinguish these
processes. A future source-domain transition experiment must cover both direct
utility execs and zygote descendants before any main-process authority is granted.

The [pinned driver gap audit](linux-cua-driver-gap-audit.md) records the additional GNOME extension compatibility and authority boundary, native Wayland opt-in, and action matrix needed before Linux driver admission.

Phase 11 complete within its prerequisite scope: both descriptor baselines read
the full synthetic token. The enforcing overlay caused SCM_RIGHTS to omit the
file descriptor and denied an inherited file read after fork plus an explicit
outgoing domain change. Exact receiver/private-file AVCs and loaded policy
subtraction are required. The exec path failed before receiver main and is
explicitly not counted. Restoration and cleanup passed on run 11. Both Astra
medium reviewers independently cleared the final source and evidence; 22 focused
probe tests and 156 Linux contract tests passed (one platform skip).

Next: isolate Electron main and child roles in a separate disposable fixture.
This must preserve a working sandboxed renderer and utilities while distinguishing
source-domain transitions, without treating argv, filenames or the stock
sandbox as authenticated process identity. Production Computer Use stays disabled.

## Phase 12: Electron process-role transition experiment

Active, separate disposable fixture. The candidate launches a root-owned copy
from a fixed system unit into a main domain, then transitions its Electron execs
into a child domain. Acceptance must also cover a command launched by main:
Aiden's scheduled scripts use `child_process.spawn` and its Linux terminal uses
node-pty's `forkpty` followed by `execvp`. A policy covering only Electron's own
executable could leave a shell in the main domain.

[SELinux fork/exec semantics](https://github.com/SELinuxProject/selinux-notebook/blob/main/src/computing_security_contexts.md)
state that fork inherits the parent's context; exec transitions are distinct.
Therefore a post-launch domain snapshot cannot prove every child was isolated
from its first instruction. Trusted pre-exec native paths, anonymous channel
ownership, interpreted payloads, loader inputs and JIT need separate review.
The role fixture may retain broad permissions to measure feasibility, but it
must not advertise those permissions as the production security policy.

Hosted CI at phase-11 commit `23917870` passed every lane (run `34699940335`),
including Fedora RPM, both Linux architectures, macOS Electron, shared
verification and Android.

Phase 12 candidate experiment passed on the enforcing host. Main plus ten
observed descendants were collected, including zygotes, renderer, GPU, network,
Node utility and GTK image-loader helpers. Renderer computation, loopback
network, utility computation, shell and command checks passed; renderer seccomp
and NoNewPrivs remained enabled. Both unauthorized entry attempts returned
exactly 126. The main-to-child NNP transition permission is required to avoid
silently retaining main's context.

The main and Node utility actually moved to a GNOME application scope while
other descendants remained in the original system service. The fixture uses
bounded, domain-scoped pidfd cleanup, opening handles before identity reads;
this is experimental cleanup, not production containment. Final cleanup restored
the module inventory and kept SELinux enforcing. Both independent Astra medium
reviews cleared the candidate; 25 focused tests and 181 Linux contract tests
passed, with one platform skip. Final lint-only imports/comments also pass lint
and the focused suite. Immutable payload, pre-exec fork identity, JIT and protected
channel authority remain unproved; Linux Computer Use remains disabled.

## Phase 13: Protected IPC object permissions

Active: preserve a working generic socket roundtrip while rejecting transfer or
use of a separately labeled protected socket. Both descriptors must have the
same trusted creator domain, and receiver `fd/use` must remain allowed, so a
coarse creator-domain denial cannot explain the protected result. Require exact
synthetic token/ACK baselines, a working generic channel under enforcement,
matching protected-socket AVCs, effective policy checks and restoration.

A separate live socketpair/fork observation on the same Fedora host confirmed
that SO_PEERCRED and SO_PEERPIDFD identify the socketpair creator even while its
child holds the other endpoint. The receipt records creator PID 19085 and holder
PID 19113. These APIs must not be interpreted as authenticating the current
holder after inheritance or delegation. Native launch ownership and enforced
endpoint access remain separate requirements; no production broker admission
has been implemented from this observation.

Phase 13 passed its scoped experiment. With creator fd/use still allowed, the
generic socket completed token read and ACK write under the overlay. The
protected endpoint was omitted with MSG_CTRUNC; exact receiver socket-object
AVCs and effective read/write removal are required. Restoration and cleanup
passed. Both Astra medium reviewers independently cleared source and live
receipts. Thirteen focused tests, 194 Linux contract tests (one platform skip),
and scoped lint passed; both new suites are registered in package.json.
Inherited endpoints, pipes, Electron integration and current-holder authentication
remain separate work; no Computer Use admission was enabled.

## Phase 14: Combined Electron roles and protected socket transfer

Active: perform SCM_RIGHTS receipt inside actual Electron main and Node utility
processes through a small N-API v8 fixture addon. One native sender creates all
four pairs. Main must complete generic and protected token/ACK roundtrips; the
utility must complete generic IPC while the protected endpoint is omitted with
an exact enforcing socket-object AVC. Retain the existing sandboxed renderer,
network, shell, command and complete observed-role checks. This combines the
previous socket and role experiments without enabling production Computer Use.

The ARM64 pinned Cua binary separately passed an isolated `--version` startup
check without network or desktop sockets; see the driver gap audit. This is not
a desktop acceptance result.

Production package provenance is a separate missing prerequisite. The repository
is currently public (verified through GitHub), so repository-bound GitHub build
attestations are an available candidate without introducing a new private release
key. Existing Linux release jobs do not yet attest their packages. A future
installer must verify the exact repository, release workflow and approved source
ref, not just a matching digest or arbitrary workflow attestation.

Phase 14 passed with both independent Astra medium reviews clear. All four
actual Electron IPC cells and prior sandboxed renderer/role checks passed in
final Fedora run 4. Cleanup returned zero and restored the module inventory
under enforcing SELinux. The 41 focused tests, 210 Linux contract tests (one
platform skip), scoped lint and diff checks passed. Evidence is retained at
`/tmp/aiden-fedora-parity-vm/phase14-electron-ipc-evidence`. This establishes
selective SCM_RIGHTS receipt in the tested Electron processes; inherited
endpoints, pipes, current-holder authentication, payload/JIT integrity and
production admission remain open. Exact phase-13 head `88592efa` passed every
hosted CI lane in run `34701326411`.

## Phase 15: Linux release package provenance

Active: add repository/workflow-bound build attestations for verified Linux
release packages, with a pinned official action and focused workflow contracts.
Verification guidance must bind the expected source commit and main ref. This
prepares future releases; it neither publishes a release now nor authenticates
an installed process or enables Computer Use.

Phase 15 implementation passed both Astra medium reviews. The Linux job is
main-only, uses a pinned official action, grants only read access plus OIDC and
attestation writes, and attests every staged package/feed class after verification.
Seventy-two branding/release tests, YAML parsing, scoped lint and diff checks
passed. No release was triggered. Hosted signing and positive/negative package
verification remain acceptance gates for a future approved main release.

## Phase 16: Packaged Linux payload inventory

Complete: compute and verify a deterministic external inventory of a finalized,
trusted, quiescent Linux payload tree. Include every file and directory, modes,
sizes and content hashes; reject links and special files. Keep the inventory
strictly outside the tree, with no excluded payload entries. The future managed
installer must derive it from authenticated release bytes and protect its storage.
This standalone component is not an authentication or race-proof installation
boundary, and production Computer Use remains disabled.

The initial afterPack proposal was rejected after inspecting electron-builder:
it adds target-specific files later, while installation may change sandbox mode.
Finalized extracted payloads must be measured instead of hiding those changes
with exclusions.

Phase 16 passed both independent Astra medium reviews, 26 focused tests and
236 Linux contract tests (one platform skip), plus scoped lint. The reusable
module matched all 316 entries (279 files) from an extracted ARM64 RPM on Fedora
and rejected eight changes covering Electron, ASAR, snapshot, library, addon,
mode, extra file and missing file. Restoration matched; SELinux remained enforcing.
The receipt and module digest are retained in
`/tmp/aiden-fedora-parity-vm/phase16-receipt.json`. The package is a local fixture
from an earlier build, not an authenticated release or current app acceptance.

## Phase 17: Native managed-generation staging

Complete within its local-staging scope: copy a supplied finalized payload into
fresh root-managed inodes using fd-relative traversal, validate the copied bytes
against the complete inventory, and publish a new generation atomically without
replacement. No active pointer or execution is part of this phase. Release
authentication remains a separate mandatory prerequisite for future production
admission.

The native Rust stager accepts only a protected `local-staging-only` approval,
requires host root and SELinux enforcing, pins trusted paths with `openat2`, and
rejects links, hardlinks, special files, unsafe ownership or modes, ACLs,
capabilities and unsupported extended attributes. It copies bytes into fresh
root-owned inodes under the store's exact SELinux creation context, rechecks the
complete inventory and metadata, writes an honest receipt, restores the process
creation context, and publishes by no-replace rename plus parent fsync. Failures
remove only the private temporary generation through retained descriptors;
rollback is armed immediately after the initial `mkdirat`.

Both independent Astra medium reviews cleared the final patch after finding and
verifying the initial-directory rollback fix. Seven Rust tests, the release
build, and the ignored root integration passed on Fedora 44 with SELinux
enforcing. The root suite covers mutable-source races, path replacement, device
nodes without payload reads, links, ACLs, capabilities, ownership and mode
violations, overlapping paths, publication collisions, injected failures and
SELinux filename transitions. No temporary staging directory remained. The
stager also reproduced the 316-entry Phase 16 RPM payload in a preserved
generation and an independent inventory verification matched every byte.

This phase does not authenticate a release, select or launch an active
generation, make payload bytes kernel-immutable, constrain JIT or host-library
loading, authenticate live process incarnations, or implement the GNOME capture
and input driver. Its receipt records those limits as false. Production Linux
Computer Use remains disabled.

## Phase 18: Cross-platform installer delivery

Complete after two independent GPT-6 Astra medium reviews: a standalone manual
workflow produces verified Linux x64 and arm64 AppImage, DEB and RPM artifacts
without publishing a release. A POSIX installer selects the exact package for
macOS or Linux, verifies the release checksum, requires GitHub build-provenance
verification before Linux installation, and verifies Apple identity plus
Gatekeeper acceptance before macOS installation. DEB/RPM preserve
package-manager ownership and a user-owned writable AppImage is the portable
fallback.

The installer uses private, exclusive staging on both platforms. macOS app
replacement preserves the prior app until the promoted copy passes signature,
Gatekeeper, bundle, version, signing-team and architecture checks; rollback
state is armed before filesystem moves, and a failed restore retains the
transaction directory for recovery. Focused checksum, provenance, hostile-path,
rollback-failure and signal-interruption regressions pass. The repository's
branding/release and Linux contract suites also pass.

The current public release contains only the arm64 Mac artifacts. Intel macOS
selection must fail until the release pipeline publishes and validates a signed
x64 DMG; it must never substitute the arm64 DMG. The standalone Linux workflow
does not publish releases, and its Actions artifacts are not accepted by the
release installer. Linux Computer Use production admission remains separate.
