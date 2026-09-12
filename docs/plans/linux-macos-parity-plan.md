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

## Phase 4: Hosted acceptance repair (implementation complete; CI pending)

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
