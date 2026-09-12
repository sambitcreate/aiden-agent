# Linux Desktop Support

Status: Complete — implementation, native acceptance, and hosted x64/arm64/Fedora acceptance complete 2026-08-30

## Goal

Ship Aiden Agent as a first-class Linux desktop application that installs and
runs on the common Debian/Ubuntu, Fedora/RHEL, and openSUSE families, with a
portable AppImage option. Preserve the existing macOS experience while making
platform-specific behavior explicit, secure, tested, and maintainable.

## Supported baseline

- Architectures: x86_64 and arm64.
- Packages: AppImage, `.deb`, and `.rpm`.
- Runtime baseline: glibc 2.34 or newer; package verification rejects native
  executables or modules that raise that floor.
- Display servers: X11 and Wayland. Window placement that Wayland deliberately
  forbids is treated as a capability limitation rather than emulated.
- Desktop integration: native Linux window frame/menu, desktop notifications,
  default file manager, common installed editors, and Secret Service/KWallet
  credential encryption.
- Computer Use, Apple Foundation Models, and Bots remain macOS-only. Linux omits
  their helpers, settings/navigation actions, onboarding promises, and runtime
  tool exposure while retaining the shared implementations for capable hosts.

## Research-backed tradeoffs

1. Electron supports Linux x64 and arm64, while electron-builder directly
   supports AppImage, Debian, and RPM targets. Native dependencies and Aiden's
   own helper executables must be built and verified on the target OS rather
   than copied from macOS.
2. Linux `safeStorage` can fall back to Electron's `basic_text` backend. Aiden
   will fail closed for provider and OAuth secrets when no desktop keyring is
   available, with an actionable error, instead of silently storing secrets
   with the hard-coded fallback key.
3. Wayland does not allow applications to position or programmatically focus
   windows in all compositors. Global dictation therefore guarantees capture
   and clipboard delivery on Linux, while exact floating-pill placement and
   automatic paste remain macOS conveniences.
4. Linux uses a conventional native frame. macOS keeps hidden-inset traffic
   lights, vibrancy, and the Dock-icon preference; Linux does not expose those
   controls.
5. Native profile sharing becomes a Save dialog on Linux. Opening a workspace
   uses the system file manager, and supported editors are discovered from
   executable paths/Flatpak installations rather than macOS bundles/Spotlight.
6. Linux packages initially use explicit download/install updates. The current
   signed macOS updater stays unchanged; silently treating `.deb`/`.rpm`
   replacement as equivalent would bypass distribution ownership and package
   manager expectations.

Primary references:

- [Electron supported platforms](https://www.electronjs.org/docs/latest/tutorial/installation)
- [Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage)
- [Electron Linux notifications](https://www.electronjs.org/docs/latest/tutorial/notifications)
- [Electron custom title bars](https://www.electronjs.org/docs/latest/tutorial/custom-title-bar)
- [electron-builder Linux targets](https://www.electron.build/docs/linux/)
- [electron-builder cross-platform builds](https://www.electron.build/docs/features/multi-platform-build/)

## Delivery phases

### Phase 1 — audit, research, and support contract

- Inventory macOS assumptions in startup, windows, menus, permissions,
  packaging, helper binaries, onboarding, settings, and release automation.
- Establish the supported distro/package matrix and deliberate limitations.
- Add this plan to the canonical plan inventory.

Review gate: confirm that every default-on service either has a Linux path or
is explicitly capability-gated before implementation begins.

### Phase 2 — Linux build, package, and runtime foundation

- Make development startup platform-neutral.
- Add Linux AppImage, Debian, and RPM packaging with x64/arm64 metadata,
  Linux runtime dependencies, icons, native helpers, unpacked native modules,
  and fuse/package verification.
- Port the worktree remover, subagent run store, file mutator, and shell runner
  to Linux without weakening their path, identity, or atomicity contracts.
- Add platform-safe window construction, menu construction, terminal shell
  selection, and secure-storage selection.

Review gate: build and test all Linux native helpers, create an unpacked Linux
package, inspect its resources/fuses/permissions, and run focused runtime tests.

### Phase 3 — platform capabilities and service adaptations

- Advertise typed host capabilities to the renderer.
- Omit Computer Use and Apple Foundation Models on Linux.
- Adapt microphone permission, dictation delivery, profile sharing, external
  editors/file manager, Tailscale discovery, and LAN service publication.
- Remove or replace macOS-only controls and promises in Settings/onboarding
  while retaining clear explanations for deliberate Linux limitations.

Review gate: exercise every changed IPC boundary and verify that unsupported
features cannot be enabled or invoked through stale renderer state.

### Phase 4 — CI, distribution, documentation, and acceptance

- Add Linux unit/integration, native-helper, package-contract, and Electron E2E
  coverage under Xvfb.
- Add x64 and arm64 Linux artifact workflows.
- Document install, keyring, Wayland, package ownership, and update behavior.
- Run type-check, lint, focused suites, full tests, Linux package verification,
  and smoke launch acceptance.

Review gate: freeze the diff, perform a final platform/security regression
review, and archive this plan only when the complete acceptance matrix passes.

## Implementation and review record

- Phase 1 complete: audited startup, windows, menus, permissions, helpers,
  packaging, onboarding, settings, Remote Access, companion copy, and release
  automation. Every default-on service now has a Linux implementation or an
  explicit main-owned capability gate.
- Phase 2 complete: Linux development startup, x64/arm64 AppImage/DEB/RPM
  configuration, package/fuse verification, native C helper portability,
  Linux PTY layouts, conventional window/menu behavior, and fail-closed
  keyring selection are implemented. Clean target-architecture builds produced
  and verified all three package formats and every native helper/module.
- Phase 3 complete: Computer Use and Apple Foundation Models are inaccessible
  on Linux; Settings, onboarding, profile export, dictation, shortcuts,
  editors/file manager, Tailscale, nearby mobile discovery, and Aiden On The
  Go copy follow the advertised platform capabilities. Review additionally
  fixed Linux safe-save recovery ownership and Remote Access publisher races.
- Latest-main parity reconciliation retains Web Search, diagnostics, Gemini
  voice transcription, Model Pad, companion projections, raster and sandboxed
  generative UI artifacts, and response/accessibility improvements on Linux.
  Chat-native Scheduled Tasks, including revision-bound remote runs and shared
  desktop/mobile presentation, are also platform-neutral on Linux.
  The attended-chat Ask User Question composer and the native todo, BTW, and
  Advisor Pi extensions are also platform-neutral and covered by both Ubuntu
  and Fedora Linux CI gates.
  The shared capability projection now also hides Bots and all Bot entry points
  until Linux receives equivalent native security bindings. Settings and
  Command-K share the same availability filter, dictation never invokes macOS
  Accessibility on Linux, and model metadata remains a release-bundled offline
  snapshot with no live models.dev UI action.
- Phase 4 implementation complete: CI builds x64 and arm64 artifacts, installs
  and verifies DEB on Ubuntu 24.04 and RPM on Fedora 44, and runs Electron E2E
  under Xvfb. Release publication requires both Linux architectures alongside
  the verified macOS artifacts. Linux installation and limitation guidance is
  documented in `docs/linux.md`.
- Native acceptance passes on both x64 and arm64 Ubuntu 24.04: package
  verification, DEB installation, RPM metadata, AppImage execution, native
  linkage, desktop association, and fresh empty-XDG X11 startup. Debian 12
  additionally proves the glibc 2.36/legacy-ALSA path; Fedora 44 and openSUSE
  Tumbleweed prove RPM dependency resolution; headless Weston proves Wayland
  startup. The complete deterministic Electron E2E suite also runs under Xvfb.
- The final adversarial pass fixed several defects that metadata-only checks
  missed: Linux's seven-field native generation token, a glibc 2.38 symbol
  leak, Debian's false ALSA virtual provider, architecture-specific release
  filenames, a dynamically linked arm64 AppImage launcher, non-ELF `.node`
  verifier inputs, AppleDouble test sidecars, stripped X11/Wayland launch
  variables, keyless onboarding incorrectly requiring a desktop keyring, and
  RPM integrity checks rejecting electron-builder's exact sandbox-mode fallback.
  It also corrected Linux last-window shutdown so enabled Remote Access retains
  background ownership without changing the ordinary last-window quit policy.
- Local regression acceptance passes `type-check`, E2E type-check, lint, Linux
  contracts, helper/parser adversarial suites, package/publisher tests, and the
  production TypeScript-to-native run-store boundary.
- Live OrbStack acceptance now also exercises the installed Linux
  `/usr/bin/tailscale` client from the real Aiden controller. A separate
  tailnet peer reached the exact HTTPS `/api/aiden/v1/health` contract, and
  teardown removed only Aiden's scoped Serve route. This pass added strict
  `Running`/online status checks and actionable detection of Linux's required
  one-time Tailscale operator grant.

Hosted run `33338723528` completed the release-infrastructure gate: Linux x64,
Linux arm64, the Fedora RPM artifact consumer, deterministic Electron E2E,
Android, and the full verification job all passed. The final CI hardening uses
SIGKILL for bounded Electron smoke teardown and hands Fedora a checksum-verified
RPM built against the Ubuntu baseline, preserving the strict glibc 2.34 floor.
Together with the native acceptance matrix above, this completes the plan's
original delivery scope.

## Acceptance criteria

- A fresh supported Linux desktop can install an appropriate Aiden package and
  complete onboarding without encountering a macOS-only control or helper.
- Chat, providers, local runtimes, MCP, terminal, workspaces/worktrees,
  subagents, schedules, notifications, local voice, Telegram, and Aiden Remote
  retain their existing contracts on Linux or disclose a documented platform
  limitation before the user acts.
- Secret material is never written through Electron's Linux `basic_text`
  backend.
- AppImage, Debian, and RPM contents include the correct-architecture native
  modules/helpers and exclude Computer Use and Apple-only helper artifacts.
- macOS packaging, signing, notarization, UI, and feature availability remain
  regression-tested and unchanged except for shared platform abstractions.
