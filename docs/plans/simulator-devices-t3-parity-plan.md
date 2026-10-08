# Simulator Devices: T3 Code parity upgrade

Status: Active (2026-10-08). Parent plan: [Simulator Devices](simulator-devices-plan.md).

## Goal

Bring Aiden's Simulator devices feature up to date with T3 Code's Devices panel. The parity point is T3 Code `a6ec88f7a7`, 2026-10-08. The upgrade also adds a few capabilities that neither app had yet. T3 Code is MIT-licensed, and the owner has authorized porting its code 1:1, adapted to Aiden's routes, IPC, types and design system. Attribution lives in `THIRD_PARTY_NOTICES.md`.

## Constraints

- **3D models.** T3's Apple-derived `.glb` device models are never bundled, downloaded or derived from. They carry no redistribution licence (owner decision, 2026-10-08). Hardware frames are original, procedural three.js models. The T3 viewer, motion, snapping and Duo code around them is ported.
- **Network posture.** The existing posture is unchanged. Nothing runs at startup or in the background, and there is no polling. Tool installs and updates happen only through explicit user action plus the existing consent and `allowInstall` gates. Paired Macs and SSH hosts are contacted only on user action.
- **No migrations.** Aiden is pre-1.0, so legacy state shapes are deleted rather than migrated.

## Workstreams

Each workstream is implemented in its own worktree and merged into a single PR.

| Workstream | Scope |
|---|---|
| A. Android emulators | `platform: "android"` across contracts, the serve-emu stream (SEMU-framed H.264 over a WebSocket), Android keys and Back/Recents, adb device actions, the proxy allowlist, agent quick start, paired-Mac relay, and Android foldable Fold/Unfold through serve-emu `/api/fold`. |
| B. 3D | The full T3 3D feel: spring motion with flick inertia, rest-view snapping, auto-framing, log zoom, and trackpad orbit end through `gestureScrollEnd`. Also hardware-accurate procedural models matched by device name. **iPhone Duo 3D** covers a hinged two-leaf body, per-display streams (`panel/1`, `panel/3`), touch mapped per leaf, pinch to fold with a hinge preview, the animated fold with hinge re-centring, orientation-following Book/Laptop controls, flip to switch display, and Duo snap views. Also the Android 3D fold body. |
| C. Hosts and toolchain | SSH device hosts: `ssh -L` hub and agent tunnels, remote bootstrap scripts, local-target skip, per-host agent targets, Settings host editor, and Test connection. Tool-version UI: installed, running and required versions per host, consent-respecting update progress, manual Update and Retry, read-only inspect, safe reclaim, and host diagnostics in the tools drawer. |
| D. Workspace UX | One renameable right-panel tab per device, where only the visible tab streams. A floating device mini-player over chat, auto-shown when the agent opens a device. A narrow-window dock. Device activity rows in the timeline. |
| E. Device features | Accessibility-tree overlay, iOS event log, erase device, clipboard paste and copy, screen recording, multi-touch gestures, and screenshot to chat or saved to a file. Contracts are platform-aware; Android variants follow. |
| F. Mobile viewer | Native iOS and Android full-screen device viewer over Aiden Remote, with on-demand controls (shake to toggle; Android Back reveals them first). Gated by a new owner consent and an Aiden Remote protocol revision. |

## Follow-ups (not in this upgrade)

- Android "Copy from device": API 36 emulator images have no clipboard read path (`cmd clipboard` is unimplemented), so the control is shown disabled with a reason.
- Android screen recording is capped at 3 minutes (one `screenrecord` segment); chaining segments needs an MP4 muxer.
- Native H.264 decoding on phones, so Aiden On The Go can view Android emulators (phones list them as "Open on your Mac to view").
- An e2e hub fake that serves a decodable AVCC stream, so Playwright can drive the 3D and Duo views.
- Agent control of simulators on paired Macs.
- Real-Mac and physical-device acceptance for every workstream.
- Onboarding feature-tour tile for devices.
- SSH hub forward exposure (security). `ssh -L 127.0.0.1:<port>:127.0.0.1:<hub>` exposes the remote hub's unauthenticated routes, including serve-sim's shell-exec route, to every local process and user on this Mac while the tunnel is up. The local hub has the same posture. Mitigation: forward to a UNIX socket in a `0700` folder under userData and teach the hub consumers to dial it. That means the token proxy (`http.request` `socketPath` and `net.connect({ path })` for upgrades), the device service's hub calls (an undici dispatcher with `socketPath`), and the `/readyz` check. Alternatively, put an authenticating loopback shim in front of each forward. The agent-device daemon forward can stay TCP because the daemon checks its own token. Documented in `docs/devices.md` (Internals → SSH hosts).

## Status

- 2026-10-08: Plan written. Workstreams A–F are in progress on `feature/ios-simulator-upgrades-compare-42da8d`.
- 2026-10-08: Workstreams A–F, the Android power-feature variants, and two independent review passes are implemented and merged on the branch. Review fixes cover SSH stop races, phone scope (shutdown, input-tag filter), peer id rewrites, save-folder races, AVD-style ids on phones, Android in the floating player, fresh grants for Duo panel feeds, and mobile lifecycle and retry budgets.
