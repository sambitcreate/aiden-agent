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

- Android variants of the workstream E features: erase (wipe-data), clipboard, and recording.
- Agent control of simulators on paired Macs.
- Real-Mac and physical-device acceptance for every workstream.
- Onboarding feature-tour tile for devices.

## Live acceptance 2026-10-08

The built app ran against the real `expo-device-hub@0.12.0` on this Mac (iOS 27.0/27.1 runtimes, an isolated user-data folder, consent given through the UI). Erase ran only on throwaway simulators made with `simctl create`.

Passed on real devices:

- **iPhone Duo 3D.** The procedural Duo body with live cover and inner displays. Closed, Book, Open, Laptop stand and Tent stand each moved the simulator's hinge (screen config: angle 0/90/180, pose `laptop`/`tent`, screen 1 or 3) and the model animated to match. Ctrl-wheel pinch folded the hinge (0° to 144°) with the model following. Flipping at Book switched the simulator to the cover (screen 1, `facedown`) and back. Rotate turned the Duo and its glyphs. Tapping Settings on the inner display opened Settings.
- **iPhone 3D.** iPhone 17 Pro and 17 Pro Max hardware bodies with a live screen. Option-drag orbit, snap back, Ctrl-wheel zoom, Restore 3D view, touch (Settings opened), Flat view, and Save framed screenshot (transparent PNG).
- **Power features.** Accessibility frames line up with the icons. The event log streams touches, keys and buttons. Paste to device and Cmd+V both paste into a focused field (8 of 8 after the fix below), and Copy from device works. A recording saved a playable H.264 file. Option-drag pinch zoomed Maps. Erase, then Boot, brought the simulator back live.
- **Tabs and the floating player.** Two devices made two tabs. Rename, float from the context menu, Dock in tab, and close (the simulator kept running) all worked, and only the visible device had an open stream.
- **Android.** `Pixel_10` (not foldable; no foldable AVD exists on this Mac) listed, booted, streamed in 3D and flat, took taps and typing, and handled Back and Home. Appearance changed `cmd uimode night`, and the drawer showed the foreground app.

Fixed during the run:

- Reopening an iOS simulator after Shut down, Erase, or an outside restart reused serve-sim's stale stream helper and failed with "stopped receiving video". Aiden now reads serve-sim's `readyz` before booting, which recycles the helper.
- Every Android boot failed with "Failed to allocate an emulator port" when Java was not on PATH, because the hub runs `avdmanager`. The hub now gets Android Studio's bundled Java when `JAVA_HOME` is unset.
- About half the pastes typed "v" or nothing, because iOS saw V before Cmd. The keys are now 40 ms apart.
- The hovered accessibility label was cut off at the screen's right edge.
- Event log times showed UTC instead of local time.
- The Duo cover showed two front cameras. The model's cutout now sits on the simulator's own camera hole, and the cover's hinge-side corners are square, as in the simulator's mask.

Not covered: a foldable Android AVD (Fold/Unfold and the Android 3D fold body), trackpad rotation (Chromium does not expose it), and native trackpad gestures (the pinch was synthesized with Ctrl-wheel events).

## Status

- 2026-10-08: Plan written. Workstreams A–F are in progress on `feature/ios-simulator-upgrades-compare-42da8d`.
- 2026-10-08: Live acceptance on real simulators and an emulator; six fixes landed (see above).
