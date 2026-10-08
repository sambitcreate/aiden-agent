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

A paired desktop serves `/simulators*` through the Aiden Remote router (`aiden-remote-simulators.ts`). This needs both the desktop-only `simulators:control` capability and the owner's `peerSharing` consent. Phones use their own grant and consent; see "Aiden On The Go viewer" below. The client side (`peer-devices.ts`) relays streams over the pinned-TLS peer connection. The proxy resolves `?host=` to that relay, so the renderer's contract is the same for every host.

### The viewer

`renderer/lib/device-stream.ts` decodes the iOS AVCC stream with WebCodecs. Simulators encode H.264 High 5.1, which some decoders reject, so the viewer probes `isConfigSupported` and falls back to MJPEG. Input goes over the hub's binary input WebSocket (`/vendor/serve-sim/helper/ws?device=<udid>`).

The 3D frame (`renderer/lib/device-3d/`) is procedural. T3's Apple GLB models have no redistribution license and are never bundled. It renders the same decoded canvas as the flat view, in a lazily loaded `three` chunk.

### Tests

- `npm run test:devices`: unit and SSR suites.
- `tests/e2e/environment-devices-*.spec.ts`: Electron E2E against `tests/e2e/device-hub-fake.mjs` and `agent-device-fake.mjs`.
- `scripts/devices-acceptance.mjs --allow-npm-install`: real-Mac acceptance.

## Aiden On The Go viewer

Aiden On The Go on iPhone and Android can watch and control a simulator that runs on the paired Mac. It is useful when an agent opened a device in a chat and you are away from the desk.

### Turning it on

Settings → Simulator → **Share with Aiden On The Go**. It is off by default, needs simulator streaming, and is separate from **Share with paired Macs**. Turning it off disconnects phones at once; paired Macs stay connected.

### What a phone can do

- See a device button above the composer when the chat has simulators. With several, the viewer has a picker.
- Watch the simulator full screen, with the status bar hidden. Controls appear on demand: shake the phone (with a haptic) or tap the handle at the top. On Android, Back shows the controls first and leaves on the second press.
- Tap and drag on the screen, press Home, open the app switcher, rotate, reload the stream, and shut the simulator down after a confirmation.
- Read the hub and agent-device versions, and retry when the Mac's hub has stopped.

A phone cannot change simulator settings, run device actions, take screenshots, read the accessibility tree or event log, or do anything the agent tools do. Those stay on the Mac.

Android emulators are listed with "Open on your Mac to view". They stream H.264 only, and the phones have no native H.264 path yet.

### How it works

- **Contract.** Aiden Remote revision 25 adds the phone-only `simulators:mobile` grant behind the `mobile-simulators-v1` feature. Phones negotiate it after pairing. `aiden-remote-simulators.ts` serves phones as a separate audience with a narrower route set: list, open (iOS only), shut down, the MJPEG stream, the screen config and health reads, and the input socket. Details are in `docs/aiden-remote-api-v1.md` under "Phone simulator viewer".
- **Consent per audience.** `device-service.ts` builds one share host per audience, each with its own consent and listeners. The relay closes only the affected audience's streams when consent changes. The 8-stream cap per paired device still applies.
- **Chat devices.** `GET /simulators?chatId=` returns `chatDeviceIds` from the desktop's per-chat sessions after checking that the phone can read the chat. It never starts the hub. Phones call it when a chat opens, when the app returns to the foreground, and when the viewer closes. Nothing polls.
- **Native viewers, no WebView.** WKWebView cannot easily honour Aiden's pinned self-signed TLS, so both apps stream natively:
  - iOS (`ios/AidenOnTheGo/Networking/AidenSimulatorStream.swift`, `AidenMJPEGMultipartParser.swift`, `AidenSimulatorContract.swift`, `Features/Simulators/`). MJPEG arrives over a URLSession data task that uses the pinned-trust delegate. Input goes over a `URLSessionWebSocketTask` on the same pinned session.
  - Android (`networking/AidenSimulatorStream.kt`, `models/AidenSimulators.kt`, `features/simulators/`). MJPEG is read with the pinned OkHttp client and input goes over an OkHttp WebSocket.
  - On both, frames decode off the main thread and only the newest frame is kept.
- **Input.** Both apps send the same packets as the Simulator tab: `0x03` touch normalised to the frame, `0x04` buttons and `0x07` orientation. The shared fixture's `mobileSimulators` vectors drive the iOS and Android tests, and `renderer/lib/device-stream-mobile-fixture.test.ts` checks the same vectors against the desktop encoder, so the three clients cannot drift apart.
