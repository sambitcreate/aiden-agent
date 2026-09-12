# Linux macOS parity reconciliation

Status: Active — phases 1–2 complete; phase 3 in progress, 2026-09-12.

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
| Updates | Package replacement / release link | Respect DEB/RPM ownership; define supported AppImage/update delivery |
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
