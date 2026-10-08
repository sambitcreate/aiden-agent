# Simulator devices

Aiden can show an iOS Simulator in the Environment panel's **Simulator** tab. There you can tap, type and turn the device yourself. You can also let chats drive it with the `device_*` agent tools while you watch. The design is adapted from T3 Code (MIT, commit `1c127066`); see `THIRD_PARTY_NOTICES.md`.

The feature is on by default on macOS and needs Xcode installed. It is never available on other platforms. To turn it off, launch Aiden with `AIDEN_EXPERIMENTAL_DEVICES=0` (any value other than `1` or `true` disables it).

## Using it

1. Open a chat, then the Environment panel, and select **Simulator**.
2. Choose **Set up simulator streaming**. Aiden asks before downloading anything (see [Network and privacy](#network-and-privacy)).
3. Pick a simulator and choose **Open** (or **Boot & open**). The live screen appears. Click to tap, drag to swipe, and type while the screen has focus.
4. The rail on the side has Home, Lock, Rotate, appearance, text size, **Screenshot to chat**, the device tools drawer, **3D frame**, **Shut down** and **Close**.

### 3D frame

iPhone and iPad simulators can be shown inside a procedural 3D body. Drag the frame's edge to turn it, and choose **Reset 3D view** to straighten it. The flat view is used whenever the stream falls back to MJPEG, the simulator has a hinge, WebGL is unavailable, or the first frame has not arrived yet. The 3D view respects Reduce Motion.

### Letting chats use simulators

Turn on **Let Aiden use simulators** in the tab, or **Agent access** in Settings → Simulator. Aiden downloads the pinned `agent-device` helper. After that, chats in workspaces with full or ask permission can call `device_list`, `device_open`, `device_screenshot` and `device_close`. Opening and closing a device ask first under ask permission. Aiden drives the device with the `agent-device` CLI that `device_open` describes. Subagents, bots and assistant mode never get these tools.

### Simulators on paired Macs

A Mac you paired as an Aiden desktop can share its simulators. On the Mac that has the simulators:

- turn on **Share with paired Macs**, and
- grant the other Mac simulator control in **Aiden On The Go**.

The paired Mac's simulators then appear under their own heading in your tab. Aiden checks paired Macs only when you open the tab or choose refresh. It never polls in the background. Agent tools use this Mac's simulators only.

## Android Emulators

The Simulator tab also shows Android Emulators, under the same feature flag and the same streaming consent. Nothing extra is installed: the pinned expo-device-hub already bundles serve-emu. The port follows T3 Code at commit `a6ec88f7`.

- **Requirements.** The Android SDK with Platform-Tools, the Emulator, and Command-line Tools (latest), and at least one AVD from Android Studio's Device Manager. Aiden finds the SDK from `ANDROID_HOME` or `ANDROID_SDK_ROOT`, then `~/Library/Android/sdk`, then the SDK that owns an `adb` on your PATH. It puts `platform-tools` and `emulator` first on PATH for the hub and for every host command. A Mac without Xcode can still run emulators: the hub starts when either platform can run.
- **Listing.** Each host lists its devices in an **iOS Simulators** and an **Android Emulators** section. A platform that cannot run says why, for example "Android SDK not found." Running emulators come from the hub's `/api/devices`. AVDs the hub leaves out because they never booted come from `emulator -list-avds`. Physical Android phones are not listed. A stopped emulator's id is its AVD name; once it boots, its id becomes the adb serial (`emulator-5554`), and the session follows the serial.
- **Booting and shutting down.** Both go through the hub (`/api/devices/boot` and `/api/devices/shutdown`). Boot failures are classified as in T3: not enough disk space, a timeout, or a launch failure.
- **Stream.** One WebSocket, `/vendor/serve-emu/ws?device=<serial>&frame-meta=1`, carries H.264 Annex-B access units behind a 16-byte `SEMU` header (magic, version, key flag, pts) and takes JSON gestures upstream. The decoder configures from the keyframe's SPS and asks for keyframes with `reset-video`. When a fold or rotation changes the screen size, serve-emu restarts its encoder (`video-session`). The viewer keeps the last frame and input stays connected. After 2 seconds the viewer shows "Waiting for device video…". There is no MJPEG fallback on Android.
- **Input.** Printable characters are sent as text. Arrows, Enter, Backspace, Tab, Delete, Home/End, and Page Up/Down are sent as Android keycodes, and Escape is Back. The rail has Back, Home, Recents, Power, and a Portrait/Landscape menu that tilts the emulator's accelerometer.
- **Device tools.** Appearance, text size, Reduce Motion (the animation scales), the network switch (`svc wifi` and `svc data`), orientation, location, eight permission groups, open URL, launch, quit, and the focused app. Each one is a typed `adb -s <serial>` argv in `main/services/devices/android-device-actions.ts`. Arguments after `adb shell` are quoted for the device's shell, which parses them again. iOS-only controls such as Liquid Glass, color filters, and push notifications are hidden.
- **Foldables.** When the emulator reports a hinge sensor, the flat view shows **Fold device** and **Unfold device**. The state is read from `/vendor/serve-emu/api/fold` and read again whenever the screen size changes. A failed read is retried every 3 seconds, and a command that does not finish in 12 seconds fails with "Fold command timed out." `useAndroidFold` (`renderer/lib/device-fold.ts`) exposes the posture and hinge angle, from 0 (closed) to 180 (open), for the 3D frame.
- **Proxy.** The allowlist adds T3's serve-emu routes: `api/devices`, `screenshot`, `stream-mode`, `stream-settings`, `accessibility`, `fold`, `health`, and the `ws` socket. Device-scoped serve-emu routes need exactly one valid `?device=`. Each mutating route accepts only its own method: POST for screenshot and fold, PUT for stream-mode, and PATCH for stream-settings. `decideDeviceHubRoute` reports a scope. Reading fold state is `read`; folding, stream tuning, and input sockets are `operate`.
- **Paired Macs.** The `/simulators` listing carries `platform`. The relay forwards the serve-emu stream, screenshots, and fold. It rebuilds the fold body from `posture` alone and never relays stream tuning.
- **Agents.** `device_list` reports each device's platform and which platforms this Mac can run. `device_open` takes `platform`, which it needs when both platforms have devices and no `deviceId` is given. It pins agent-device with `--platform android --serial <serial>`. The Android quick start allows `adb -s` for builds, logs, and `adb reverse`, and forbids shutting down or wiping the watched emulator and stopping serve-emu.

## Settings → Simulator

Settings → **Simulator** appears in the settings list and command palette only when the feature flag is on. It contains:

- **Simulator streaming**, **Agent access** and **Share with paired Macs** switches. Turning on either of the first two asks before anything is downloaded from npm. Turning streaming off also turns the other two off.
- **Helper tools**: the pinned version of each helper, whether it is installed, and any older versions still on disk. Reading this touches only the disk.
- **Prune old versions**: deletes every helper version except the pinned ones. An install in progress is left alone.
- **Remove installed tools**: asks first, then turns every permission off, stops both helpers, and deletes them together with saved screenshots and agent state. Your simulators and their apps are not touched.

## Network and privacy

- The only new outbound traffic is `npm install <tool>@<exact version>` against your configured npm registry. It runs only after you confirm simulator setup or agent access. The install also lets `node-datachannel` download its prebuilt native binary. Aiden sends nothing about your chats.
- Startup, background refreshes, onboarding and the agent tools never install anything. If the helpers are missing, they say so.
- Screenshots you send to a chat go to that chat's selected model, like any image attachment.

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| "Xcode was not found." | Install Xcode from the App Store and open it once so it can finish setting up, then choose refresh. |
| "Android SDK not found." | Install Android Studio and its SDK Platform-Tools, Emulator, and Command-line Tools (latest), or set `ANDROID_HOME`, then choose refresh. |
| An Android emulator shows "Waiting for device video…" | The emulator is restarting its encoder after a fold or rotation. If it does not recover, close the device and open it again. |
| Setup fails with an npm error | Make sure `npm` is on your PATH and can reach your registry, then turn streaming on again. |
| The screen stays black | Close the device and open it again. If the stream can't renew its grant three times in a minute, **Reconnect** appears. |
| The 3D frame never shows | The stream is using MJPEG, the device has a hinge, or WebGL is unavailable. The flat view is intended in these cases. |
| A paired Mac shows no simulators | On that Mac, check **Share with paired Macs** and the simulator-control grant for this Mac. |

## Internals

This section is adapted from T3 Code's `docs/internals/devices.md`.

### Two external tools, one seam

`expo-device-hub` streams the simulator and `agent-device` drives it. Each one is npm-installed at a pinned version into `userData/devices/tools/<name>/<version>/` after its own consent step. Installs are staged and marked complete with an `.install-complete` sentinel (`main/services/devices/device-toolchain.ts`). Setup installs and starts only the hub. `agent-device` stays absent until agent access is granted.

Both helpers run under Electron's Node (`ELECTRON_RUN_AS_NODE`) rather than `npx`, so opening a device never depends on the registry. The hub is a supervised child process rather than imported middleware, because serve-sim loads private CoreSimulator frameworks through a native addon, and a crash there must not take Aiden down.

Everything host-specific sits behind `DeviceHost` (`device-host.ts`, `local-device-host.ts`). `device-service.ts` holds the device state:

- consent, stored in `userData/devices/consent.json`
- the listing across this Mac and paired Macs
- per-chat sessions
- the toolchain actions: read, prune and remove.

Consent revokes win races. Every revoke bumps a consent epoch. A grant, start or agent tool call checks that epoch:

- before it contacts npm, so it never contacts npm after a revoke, and
- again when it finishes. If the epoch changed, it stops the hub or agent-device it started and fails.

Removing the tools runs a streaming revoke first. It then waits for any in-flight grant, hub start or agent tool call before it deletes files, and new agent tool calls are refused while it runs. A new grant waits for the removal to finish.

### The hub is never exposed

serve-sim has a shell-exec route whose token can be read from its own unauthenticated `/api`. The hub therefore binds only to `127.0.0.1`. The renderer reaches it only through main's loopback proxy (`device-hub-proxy.ts`), which:

- requires a short-lived grant from a per-launch 256-bit token
- allowlists T3's iOS stream, config and screenshot routes
- refuses non-GET requests except screenshot capture.

The renderer never sees the hub origin. Stream responses carry `Cache-Control: no-transform`.

### Device settings never go through the hub

serve-sim's own Tools panel sends shell commands over that exec channel. Aiden never proxies it. Each control in the device tools drawer is instead a typed action in `device-actions.ts` that runs `simctl` in main against booted devices only.

### Agents drive through the CLI

There are deliberately only four `device_*` tools (`device-tools.ts`). Driving happens through the `agent-device` CLI. `run_command` gets a pinned shim directory on its PATH, read fresh for every command, so a revoke mid-generation drops it. How to drive a device comes back in the `device_open` result instead of an always-loaded prompt. The always-on prompt block is four lines that point at the tools and ask the agent to prefer them (and `agent-device`) for anything on the device the user is watching. Shell tools such as `xcrun simctl`, `xcodebuild` and `adb` stay allowed for builds, installs, logs, port forwarding and diagnostics the device tools do not cover, but the block also forbids shutting down or erasing a watched simulator or stopping `serve-sim` unless the user asks, since the prompt is loaded before any `device_open`. The `device_open` quick start repeats that preference, allows `xcrun simctl` for gaps on the same UDID, and repeats the no-teardown guardrail.

### Paired Macs

A paired desktop serves `/simulators*` through the Aiden Remote router (`aiden-remote-simulators.ts`). This needs both the desktop-only `simulators:control` capability and the owner's `peerSharing` consent. The client side (`peer-devices.ts`) relays streams over the pinned-TLS peer connection. The proxy resolves `?host=` to that relay, so the renderer's contract is the same for every host.

### The viewer

`renderer/lib/device-stream.ts` decodes the iOS AVCC stream with WebCodecs. Simulators encode H.264 High 5.1, which some decoders reject, so the viewer probes `isConfigSupported` and falls back to MJPEG. Input goes over the hub's binary input WebSocket (`/vendor/serve-sim/helper/ws?device=<udid>`).

The 3D frame (`renderer/lib/device-3d/`) is procedural. T3's Apple GLB models have no redistribution license and are never bundled. It renders the same decoded canvas as the flat view, in a lazily loaded `three` chunk.

### Tests

- `npm run test:devices`: unit and SSR suites.
- `tests/e2e/environment-devices-*.spec.ts`: Electron E2E against `tests/e2e/device-hub-fake.mjs` and `agent-device-fake.mjs`. The Android spec also fakes the SDK's `adb` and `emulator`; the iOS specs pin `ANDROID_HOME` to an empty folder.
- `scripts/devices-acceptance.mjs --allow-npm-install`: real-Mac acceptance.
