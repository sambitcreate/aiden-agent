# Pinned Cua driver: Fedora GNOME gap audit

Status: source audit, 2026-09-12. No Linux Computer Use admission or full-parity acceptance. This audit did not install the extension, exercise desktop driver operations, or change policy. The separately noted isolated ARM64 version check grants no desktop access. Upstream test claims below are not Aiden's Fedora 44 / GNOME 50.4 acceptance results.

## Pin and release artifacts

Aiden currently pins only the macOS universal artifact in `resources/computer-use/cua-driver-artifact.json`: Cua 0.8.3, tag `cua-driver-rs-v0.8.3`, source `0612c26b2c7b8556f6de7f6b4f3927ecac914e4f`. The [release API](https://api.github.com/repos/trycua/cua/releases/tags/cua-driver-rs-v0.8.3) advertises Linux bare-binary archives:

| Asset | Archive SHA-256 reported by GitHub | Size |
| --- | --- | --- |
| `cua-driver-rs-0.8.3-linux-arm64-binary.tar.gz` | `910456505b927966867f668e37195b130364dcc50f566d4301cd9c3760da9cd3` | 10,856,213 bytes |
| `cua-driver-rs-0.8.3-linux-x86_64-binary.tar.gz` | `42bd2cfb2df60b9d635eb52aaf389ff816e6a7ff45c843e815688a8d96feda2f` | 10,828,874 bytes |

Both exact archives were subsequently downloaded through the release, matched the advertised SHA-256 values above, and contained one regular `cua-driver` executable. Static ELF inspection confirmed AArch64 and x86-64 respectively. Extracted executable SHA-256 values:

- ARM64: `6fb1b0b43b5123390f77b61e00e1acab8ec8e32ff3133a8e5463738cd73ccb29`
- x86-64: `4b7f229ea82ed93da7e2414e53224aed4b1a76685503d4558e07007e693747eb`

Static `DT_NEEDED` inspection found X11, Xi, xkbcommon, GCC support and glibc libraries. This is not a complete runtime dependency inventory: dynamically opened libraries, the extension and runtime resources still require inspection. The ARM64 executable subsequently returned `cua-driver 0.8.3` for `--version` in a bounded Bubblewrap invocation with a separate network namespace, no session/display sockets, a clean environment, and telemetry/update flags disabled. This establishes basic startup only; the x86-64 executable has not been run and neither driver has desktop acceptance. The downloads and receipt are under `/tmp/aiden-linux-cua-artifact-audit/`. These hashes record observed upstream bytes; they are not production admission pins or proof of source-to-binary provenance. Linux packaging, immutable payload installation and exact live binary admission remain work. The macOS signing contract does not cover these assets.

## Source-backed capability limits

The pinned [Wayland selection gate](https://github.com/trycua/cua/blob/0612c26b2c7b8556f6de7f6b4f3927ecac914e4f/libs/cua-driver/rust/crates/platform-linux/src/wayland/mod.rs#L62-L101) is off by default. It requires `WAYLAND_DISPLAY` and an explicitly enabled `CUA_DRIVER_RS_ENABLE_WAYLAND` value. Installing an extension alone does not exercise the native Wayland route. A future trusted launcher must set the reviewed constant deliberately while retaining strict environment filtering; ordinary caller environment must not select the authority boundary.

References below use the immutable source commit. The [platform table and background contract](https://github.com/trycua/cua/blob/0612c26b2c7b8556f6de7f6b4f3927ecac914e4f/docs/content/docs/reference/cua-driver/platform-support.mdx#L39-L79) and [validation ledger](https://github.com/trycua/cua/blob/0612c26b2c7b8556f6de7f6b4f3927ecac914e4f/libs/cua-driver/docs/linux-desktop-validation.md#L5-L14) support this matrix:

| Surface | Pinned upstream position | Fedora GNOME acceptance still needed |
| --- | --- | --- |
| Accessibility and semantic background actions | AT-SPI actions and native GTK behavior covered; semantic actions can avoid raising a window. | Real GTK and Electron/Tauri actions, focus and foreground noninterference; unavailable semantics must refuse. GNOME shared-renderer coverage remains open upstream. |
| Geometry, window targeting, foreground input | GNOME route depends on WinRects geometry and verified activation before portal/libei input. | Compatible trusted extension, target/focus checks, grant cancellation and revocation, real input outcomes. |
| Screenshots | Display capture tries Shell helper, native Wayland protocols, then Screenshot portal; window capture crops a display image using known geometry. | Actual GNOME capture route, consent, scale/multiple displays, occlusion and minimized-window results. A display crop does not establish independent capture of an occluded window. |
| Raw background input | Ordinary standard Wayland clients cannot address arbitrary occluded surfaces through active-seat input. Semantic hit-test fallbacks cover some pixel-addressed actions. | Preserve structured refusals; do not silently foreground or inject into the occluding application. |
| Video and broader renderers | GNOME portal video and shared renderer matrix remain open in the ledger. | No accepted recording or complete app/toolkit parity claim. |

The actual [capture dispatcher](https://github.com/trycua/cua/blob/0612c26b2c7b8556f6de7f6b4f3927ecac914e4f/libs/cua-driver/rust/crates/platform-linux/src/wayland/mod.rs#L924-L1001) is more precise than nearby comments: it attempts several routes and crops the composited display for window captures. The existence of a protocol fallback in source does not prove GNOME 50 advertises that protocol or that the release binary succeeds on it.

The arbitrary raw-background limitation is architectural for an ordinary client on stock Wayland, not a claim that a compositor modification could never implement it. Upstream's experimental nested `cua-compositor` supplies a different environment; it does not establish parity on the user's existing GNOME desktop. macOS itself also has structured refusals, so acceptance should compare concrete action cells rather than promise universal macOS behavior.

## WinRects compatibility and additional authority boundary

The [extension metadata](https://github.com/trycua/cua/blob/0612c26b2c7b8556f6de7f6b4f3927ecac914e4f/libs/cua-driver/wayland-helper/winrects@cua/metadata.json#L1) declares Shell versions **45–48**, not 50. This is a declared compatibility gap; no actual GNOME 50 load failure was tested in this audit. Adding a version string or disabling extension validation would not establish behavioral compatibility.

The [helper README, lines 8–39](https://github.com/trycua/cua/blob/0612c26b2c7b8556f6de7f6b4f3927ecac914e4f/libs/cua-driver/wayland-helper/README.md#L8-L39) describes global window geometry, activation, capture, and cursor operations inside GNOME Shell. Capture uses Shell privilege without a portal grant. AX can remain useful without the helper, but authoritative geometry and verified foreground delivery are missing from that route.

The [extension implementation, lines 13–41 and 110–144](https://github.com/trycua/cua/blob/0612c26b2c7b8556f6de7f6b4f3927ecac914e4f/libs/cua-driver/wayland-helper/winrects@cua/extension.js#L13-L144) exports `org.cua.WinRects` on the session bus. Its capture and activation methods contain no caller authentication. Under a permissive session-bus policy, another reachable caller could invoke these methods directly. This is a source-derived exposure, not an exploitation result on the VM, where this audit did not install the extension.

Consequently, admitting only the exact main/broker/driver processes cannot by itself protect the added Shell endpoint. A solution must enforce who may invoke it, protect its installed code and the Shell hosting it from the modeled hostile same-UID process, authenticate the service side, and revoke access with the authorized lifecycle. A caller-supplied app ID, bus name, PID lookup alone, or writable extension copy is not a replacement for the requested live exact-build boundary. The viability and scope of kernel/bus enforcement need a separate proof; this audit does not claim a few JavaScript checks solve it.

## Next implementable scope

1. Finish the isolated mandatory-boundary probes independently of driver behavior. Retain disabled admission until main/child role separation, immutable executable and interpreted payloads, runtime libraries/JIT, descriptor inheritance/transfer, and lifecycle revocation are demonstrated together.
2. Build a reviewed Cua source revision with a GNOME 50-compatible extension in the isolated VM, retaining upstream automation implementation. First test ABI compatibility without treating it as authorization. Design and negatively test the authenticated Shell boundary before granting it access from production Aiden. A changed build requires a new reviewed pin and extracted binary/payload hashes; it is no longer the untouched 0.8.3 artifact.
3. Compare a portal-based upstream route before committing to the extension design. [RemoteDesktop](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.RemoteDesktop.html) supports user-granted input and an EIS descriptor; [ScreenCast](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.ScreenCast.html) supplies selected capture streams via PipeWire. Those capabilities still require protected descriptor ownership and revocation. They do not by themselves provide the pinned driver's exact-target activation/geometry contract or arbitrary raw background delivery. A portal alternative may require upstream changes and narrower capability reporting.
4. Run an app-owned GTK/Electron/Tauri matrix on the actual GNOME session: AX and pixel actions, foreground and background, occlusion, cancellation, revocation, multi-display scaling, target disappearance, and hostile caller negatives. Accept each proven cell and preserve explicit refusal elsewhere.

Aiden's [existing integration decision](../computer-use-integration.md#decision) delegates automation to Cua and keeps its broker limited to authentication, transport, and lifecycle. Compatible upstream changes or a reviewed Cua fork fit that separation more closely than implementing a second capture/input engine inside Aiden. Either alternative needs an explicit reviewed Linux architecture and artifact policy; neither is authorized for release by this audit.

## Related Electron observation

A separate live Fedora probe recorded Electron 43.1.1 browser, GPU, renderer, network utility, and Node utility processes using the same Electron executable and stock `unconfined_t`. The sandboxed renderer reported `Seccomp: 2` and `NoNewPrivs: 1`; the run did not use `--no-sandbox`. Receipt: `/tmp/aiden-fedora-parity-vm/electron-role-results.json`. This is an observational subset, not a full process inventory: `getAppMetrics` did not enumerate a zygote.

A source-domain transition from a constrained launcher into main, followed by a different transition when main executes the same binary, is a candidate for the next isolated experiment. Its correctness depends on actual exec and fork paths, including zygotes and direct utility processes, plus payload integrity and JIT constraints. The observation does not establish role isolation, and command-line role strings must not become the admission credential.

## 2026-10-09 addendum: upstream 0.34.1 delta

Source-only re-read of `cua-driver-rs-v0.8.3..cua-driver-rs-v0.34.1` while the macOS pin moved to 0.34.1 ([upgrade plan](cua-driver-0-34-upgrade-plan.md)). Linux stays disabled; nothing here was installed or exercised on the Fedora VM.

| Audit gap | 0.34.1 status | Evidence |
| --- | --- | --- |
| WinRects declares Shell 45–48 | Declared 45–50 (API 10); contributor-tested on Ubuntu GNOME 50.1 only | trycua/cua#2565; GNOME 50 capture hardening #2226 |
| No caller authentication on `org.cua.WinRects` | Still open and wider: new `CaptureWindow`/`CaptureWindowPreview` capture an occluded window by id, `pid=0` skips the owner check | `winrects@cua/extension.js` (no `get_sender()` check); #4882 |
| Authenticate the service side | Partially closed: the driver resolves the unique bus owner and requires same-UID, root-owned, non-writable `gnome-shell` | `platform-linux/src/wayland/shell_helper.rs` (#2367) |
| Protect installed extension code | Still open: `install.sh` copies into user-writable `~/.local/share/gnome-shell/extensions` | `wayland-helper/install.sh` |
| Wayland gate off by default | Unchanged (`CUA_DRIVER_RS_ENABLE_WAYLAND` opt-in) | `wayland/mod.rs::wayland_enabled` |
| Window capture was a display crop | Closed for helper API ≥ 9 (per-actor capture; refuses locked, greeter, minimized) | #4882 |
| Portal ScreenCast/RemoteDesktop route | Still open; existing portal code hardened (per-portal zbus connection, libei EIS ack) | #2552, #4880 |
| GNOME Electron/Tauri renderer coverage | Still open; `linux-desktop-validation.md` unchanged | `platform-support.mdx` open gaps |
| Linux artifact provenance | Improved: every asset ships a cosign `.sigstore.json` bundle | `cd-rust-cua-driver.yml` |

The blocker is now Aiden's trust boundary rather than GNOME compatibility. Minimal path: re-pin the full `linux-*.tar.gz` package (it bundles the API 10 helper), run upstream's `scripts/ci/linux/run-rust-e2e-desktop.sh gnome` and Aiden's GTK/Electron matrix on the Fedora VM, then either land sender authentication in WinRects plus a root-owned system-wide install (fork or upstream PR) or record an explicit residual-risk decision. KWin and Hyprland helpers added upstream do not apply to the GNOME target. Other ACP hosts now co-install the same `winrects@cua` UUID, so a per-user install would inherit their install and downgrade races.
