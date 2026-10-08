# Simulator devices

Aiden can show an iOS Simulator in the Environment panel's **Simulator** tab. There you can tap, type and turn the device yourself. You can also let chats drive it with the `device_*` agent tools while you watch. The design is adapted from T3 Code (MIT, commit `1c127066`); see `THIRD_PARTY_NOTICES.md`.

The feature is on by default on macOS and needs Xcode installed. It is never available on other platforms. To turn it off, launch Aiden with `AIDEN_EXPERIMENTAL_DEVICES=0` (any value other than `1` or `true` disables it).

## Using it

1. Open a chat, then the Environment panel, and select **Simulator**.
2. Choose **Set up simulator streaming**. Aiden asks before downloading anything (see [Network and privacy](#network-and-privacy)).
3. Pick a simulator and choose **Open** (or **Boot & open**). The live screen appears. Click to tap, drag to swipe, and type while the screen has focus.
4. The rail on the side has Home, Lock, Rotate, appearance, text size, **Screenshot to chat**, **3D view**, **Flat view**, **Restore 3D view** (while 3D is showing), the device tools drawer, **Shut down** and **Close**.

### 3D view

**3D view** shows the live screen inside a device body; **Flat view** shows the plain screen. Your choice is remembered on this Mac.

- **Hardware models.** iPhone 17 Pro / 18 Pro, iPhone 17 Pro Max / 18 Pro Max, and the 13-inch iPad Pro (M4 and M5) get a body built to their published dimensions: the titanium frame and rounded rail, the Dynamic Island, Action button and Camera Control, the rear camera plateau, and the iPad's single rear camera. Other iPhones, iPads and Android devices get a generic phone or tablet body. Every body is Aiden's own procedural model; no Apple 3D assets are bundled or downloaded.
- **Turning and zooming.** Drag around the device, or swipe with two fingers on a trackpad, to turn it. A flick coasts and settles on the nearest useful view. Pinch, or Control-scroll, zooms. Option-drag turns the device even over the screen. **Restore 3D view** straightens the device, resets zoom, and turns the simulator back to portrait.
- **Touch.** Drag the screen to touch it, exactly as in the flat view, in any orientation.
- **iPhone Duo.** The Duo opens and closes in 3D. Pinch over the device to fold the hinge: the model follows your fingers at once and the simulator follows. The **Fold shape** buttons (Closed, Book or Laptop, Open) animate the hinge and re-centre the device on it. The half-fold button reads **Book** when the phone is held upright and **Laptop** when it is held sideways, and the glyphs turn with the phone. **Device stance** sets the native Laptop and Tent stands; a fold button pressed on a stand first turns the phone back to how it was held. Turning the Duo over to the other display asks the simulator to switch displays; if it does not confirm within five seconds, the view turns back. Both displays stay live. The Duo controls also work in the flat view.

The flat view is used whenever the stream falls back to MJPEG, WebGL is unavailable or lost, an iPhone Duo display feed cannot be decoded, or the first frame has not arrived yet. An iPhone Duo also needs a Device Hub that reports its hinge (0.11.0 or newer); otherwise the **3D view** button explains why it is off. All motion respects Reduce Motion.

### Letting chats use simulators

Turn on **Let Aiden use simulators** in the tab, or **Agent access** in Settings → Simulator. Aiden downloads the pinned `agent-device` helper. After that, chats in workspaces with full or ask permission can call `device_list`, `device_open`, `device_screenshot` and `device_close`. Opening and closing a device ask first under ask permission. Aiden drives the device with the `agent-device` CLI that `device_open` describes. Subagents, bots and assistant mode never get these tools.

### Simulators on paired Macs

A Mac you paired as an Aiden desktop can share its simulators. On the Mac that has the simulators:

- turn on **Share with paired Macs**, and
- grant the other Mac simulator control in **Aiden On The Go**.

The paired Mac's simulators then appear under their own heading in your tab. Aiden checks paired Macs only when you open the tab or choose refresh. It never polls in the background. Agent tools use this Mac's simulators only.

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
| Setup fails with an npm error | Make sure `npm` is on your PATH and can reach your registry, then turn streaming on again. |
| The screen stays black | Close the device and open it again. If the stream can't renew its grant three times in a minute, **Reconnect** appears. |
| The 3D view never shows | The stream is using MJPEG, WebGL is unavailable, or an iPhone Duo's hub predates hinge reporting. Hover **3D view** for the reason. After a failure, close and reopen the simulator to try 3D again. |
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

### 3D viewer

`renderer/lib/device-3d/` ports T3's viewer code (motion, snapping, framing, interaction, trackpad, Duo scene and viewer, Android fold scene). T3 swaps in Apple GLB bodies, which have no redistribution licence; Aiden never bundles, downloads or derives anything from them. Instead `hardware-models.ts` and `duo-model.ts` build original procedural models in millimetres from public spec-sheet dimensions, then scale them to T3's normalized contract (front +Z, one `device-screen` 2.2 units tall; for the Duo, `left-half`/`right-half` hinge groups and `cover-display`, `inner-display-left`, `inner-display-right`). `model-registry.ts` maps exact simulator names to models and has no `three` import. Everything renders the decoded canvas the flat view already holds, in one lazily loaded chunk with three.js, a PMREM-filtered `RoomEnvironment` for PBR reflections, and the models.

- Motion (`device-motion.ts`) is a quaternion spring with flick coast; release snaps to the nearest rest view with a yaw allowance (`view-snap.ts`). Framing (`framing.ts`) refits the camera with a critically damped spring so turning and folding never clip the device.
- A trackpad orbit ends on Electron's native `gestureScrollEnd`, forwarded by main on `devices:trackpad-scroll-end` (`main/services/devices/trackpad-scroll-end.ts`), with a 1.2 s fallback elsewhere.
- The iPhone Duo view (`duo-viewer.ts`) needs both displays, so `device-duo-stream.ts` replaces the stream's video with per-display feeds that share its grant and input socket: one elected feed when the hub supports physical orientation, otherwise the fixed `/helper/<udid>/panel/1|3/stream.avcc` feeds (already on the proxy allowlist). An inactive display's shutdown blank never overwrites its last image. Duo touches go through `sendRawTouch` in raw framebuffer space.
- Each viewer exposes `capture()`, a PNG of the framed device as drawn. The viewports pass it through `onCaptureReady`; no UI uses it yet.
- Android foldables: `android-fold-scene.ts` is selected when an Android profile has a fold angle. `DevicePhoneViewport` takes `foldAngle`; the Simulator tab passes `null` until Android fold state reaches it.

### Tests

- `npm run test:devices`: unit and SSR suites.
- `tests/e2e/environment-devices-*.spec.ts`: Electron E2E against `tests/e2e/device-hub-fake.mjs` and `agent-device-fake.mjs`.
- `scripts/devices-acceptance.mjs --allow-npm-install`: real-Mac acceptance.
