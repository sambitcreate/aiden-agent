# Simulator devices

Aiden can show an iOS Simulator in the Environment panel's **Simulator** tab. There you can tap, type and turn the device yourself. You can also let chats drive it with the `device_*` agent tools while you watch. The design is adapted from T3 Code (MIT, commit `1c127066`); see `THIRD_PARTY_NOTICES.md`.

The feature is on by default on macOS and needs Xcode installed. It is never available on other platforms. To turn it off, launch Aiden with `AIDEN_EXPERIMENTAL_DEVICES=0` (any value other than `1` or `true` disables it).

## Using it

1. Open a chat, then the Environment panel, and choose **+ → More tools… → Device**.
2. Choose **Set up simulator streaming**. Aiden asks before downloading anything (see [Network and privacy](#network-and-privacy)).
3. Pick a simulator and choose **Open** (or **Boot & open**). The live screen appears. Click to tap, drag to swipe, and type while the screen has focus.
4. The rail on the side has Home, Lock, Rotate, appearance, text size, **Screenshot to chat**, the device tools drawer, **3D frame**, **Shut down** and **Close**.

### 3D frame

iPhone and iPad simulators can be shown inside a procedural 3D body. Drag the frame's edge to turn it, and choose **Reset 3D view** to straighten it. The flat view is used whenever the stream falls back to MJPEG, the simulator has a hinge, WebGL is unavailable, or the first frame has not arrived yet. The 3D view respects Reduce Motion.

### Device tabs and the floating player

Each device you open in a chat gets its own Environment tab, named after the device. **+ → More tools… → Device** opens the device picker; choosing a device there adds its tab. The picker also shows whenever the chat has no device open.

- **Rename** a tab by double-clicking it, pressing F2 while it is focused, or choosing **Rename** from its context menu. Enter saves, Escape cancels, and an empty name goes back to the device's name. Names are kept per chat, so opening the same device again in that chat brings its name back.
- **Close** a tab with its ×, Delete, or the context menu. That ends this chat's viewer session; the simulator keeps running (use **Shut down** in the rail to power it off). A closed tab stays closed: refreshing or relaunching never brings it back. Opening the device again from the picker, or an agent's `device_open`, does.
- Only the tab you are looking at streams. Switching tabs, hiding the panel, or hiding the window stops decoding and closes the stream; both devices keep running.

**Float over chat** (in the rail, or a tab's context menu) moves the device into a small player over the transcript while the panel shows something else:

- Drag its header to move it. Released near an edge it slides flush to that edge, and near a corner it lands in the corner. Drag any edge or corner to resize it; the screen keeps its shape.
- With the header focused, the arrow keys move it (Shift for bigger steps), + and − resize it, and Escape docks it back into its tab. The screen takes clicks, drags and typing like the full viewer, and the header has Home and Rotate.
- Its size and position are kept for the window, and it always stays inside the chat area when the window or panels change size.
- **Dock in tab** returns it to its tab; **Close floating device** just hides the player. The tab shows a placeholder while the device floats, so the device is never streamed twice.

When a chat's agent opens a device, it floats over that chat. Turn off **Auto-show floating device** in **Settings → Simulator → Workspace** to open its tab instead. Device activity also shows in the chat's activity rows: *Opened simulator*, *Took simulator screenshot*, *Closed simulator*, and so on, on desktop and in Aiden On The Go.

On narrower windows Quick View docks beside the chat: the conversation moves left only as far as the card needs and narrows only once it reaches the left edge. When even that would leave the chat too narrow, the card floats over it as before.

### Letting chats use simulators

Turn on **Let Aiden use simulators** in the tab, or **Agent access** in Settings → Simulator. Aiden downloads the pinned `agent-device` helper. After that, chats in workspaces with full or ask permission can call `device_list`, `device_open`, `device_screenshot` and `device_close`. Opening and closing a device ask first under ask permission. Aiden drives the device with the `agent-device` CLI that `device_open` describes. Subagents, bots and assistant mode never get these tools.

### Simulators on paired Macs

A Mac you paired as an Aiden desktop can share its simulators. On the Mac that has the simulators:

- turn on **Share with paired Macs**, and
- grant the other Mac simulator control in **Aiden On The Go**.

The paired Mac's simulators then appear under their own heading in your tab. Aiden checks paired Macs only when you open the tab or choose refresh. It never polls in the background. Agent tools use this Mac's simulators only.

### Device power features

These work on this Mac's simulators. A paired Mac's simulator gets only the screenshot options, the overlay, and the event log.

- **Screenshots.** The rail's screenshot control has two halves. The camera sends a screenshot to the chat, as before. The menu beside it offers **Screenshot to chat** and **Save screenshot…**. Saving opens the system save dialog in Downloads with a name like `iPhone-17-Pro-2026-10-08-142530.png`, and the confirmation toast has **Reveal in Finder**.
- **Screen recording.** **Record screen** in the rail starts `simctl io recordVideo` (H.264). While it runs, the button turns into a red indicator with the elapsed time. Selecting it stops the recording with SIGINT so the file is finalized. Recordings stop by themselves after 10 minutes. On stop, the save dialog opens in Downloads (`<device>-<time>.mp4`). Cancelling the dialog deletes the recording. Deleting the chat, quitting Aiden, or shutting the simulator down stops a recording and deletes it. Aiden's composer has no video attachments, so recordings are not attached to the chat.
- **Accessibility overlay.** Turn on **Overlay element frames** in the device tools drawer to outline every accessibility element on the flat screen. Hover an element to see its label and role. The frames follow rotation. While they show, the flat screen is used instead of the 3D frame. On this Mac the tree is re-read every two seconds. On a paired Mac it is read once, and a refresh button reads it again.
- **Event log.** Expand **Event log** in the drawer for serve-sim's live record of touches, keys, buttons, and launches. You can filter, pause (new events keep buffering), clear, and copy it. It keeps the newest 500 entries and is connected only while the section is expanded.
- **Clipboard.** **Paste to device** in the drawer puts the Mac clipboard's text on the simulator's pasteboard (`simctl pbcopy`, text on stdin) and then presses Cmd+V on the device so the focused field receives it. Cmd+V on the focused screen does the same. **Copy from device** (`simctl pbpaste`) copies the simulator's text to the Mac. Only text up to 64 KB is accepted, and images and files are refused.
- **Multi-touch.** On the flat screen, Option-drag places two touches mirrored around the screen centre. Moving toward or away from the centre pinches, and moving around it rotates. Option+Shift-drag moves both touches together for a two-finger pan. Touch dots show both fingers while Option is held. A trackpad pinch over the flat screen pinches the device. The 3D frame keeps its own gestures.
- **Erase.** **Erase all content and settings…** in the drawer first shows a destructive confirmation that names the simulator. It then shuts the simulator down if it is running, runs `simctl erase`, and offers **Boot** to start it again, or **Close simulator**. Agents have no erase tool, and the always-on guidance still forbids erasing a watched simulator unless the user asks.

The agent's `device_screenshot` takes an optional `saveTo` that also writes the PNG to a path. The path must be inside the chat's workspace (a relative path is relative to the workspace) or the Downloads folder. A folder path gets a dated file name. Paths are checked as written and again after resolving symlinks. A final symlink is never followed, and the path is checked before the screenshot is taken. Under ask permission, a screenshot with `saveTo` asks first.

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

### Device power features

- Erase, clipboard, and recording are argv builders in `device-actions.ts` (`deviceEraseCommands`, `deviceClipboardWriteCommand`, `deviceClipboardReadCommand`, `deviceRecordVideoCommand`, `eraseDevice`). Each one takes the target's `platform`, and a platform without a variant is refused before anything runs, so adb variants can be added beside iOS. They reach a simulator only through `DeviceService.localTarget`, which accepts only this Mac's simulators that the last listing reported. Clipboard and recording also require the simulator to be booted.
- `device-recording.ts` supervises `simctl io recordVideo` children. It runs one recorder per simulator. Stop sends SIGINT, then SIGKILL after 15 s, which fails the recording. The cap is 10 minutes. Temp files go in `userData/devices/recordings/`.
- `device-features.ts` composes the features, discards recordings when their simulator stops being booted or listed, and remembers the files it saved so that only those can be revealed.
- The IPC is `device-feature-ipc.ts`. Channels: `devices:erase`, `devices:clipboard-paste`, `devices:clipboard-copy`, `devices:recordings-list`, `devices:recording-start`, `devices:recording-stop`, `devices:recording-save`, `devices:recording-discard`, `devices:screenshot-save`, `devices:reveal-saved`, plus the `devices:recordings` notification. Inputs are parsed by `renderer/shared/device-features.ts`.
- serve-sim's input socket takes two contacts as message `0x05` (`{ type, x1, y1, x2, y2 }`, normalized like `0x03`). The stream client's `sendMultiTouch` applies the same rotation remap as single touches. The gesture geometry is in `renderer/lib/device-multitouch.ts`, so the 3D view can reuse it.
- The accessibility overlay reads `GET /vendor/serve-sim/helper/<udid>/ax`, and the event log reads `GET /vendor/serve-sim/api/event-log/events`. Both are already on the proxy's read-only allowlist. They draw short-lived grants from `renderer/lib/device-grant.ts`, because they can outlive the stream's one-minute grant.

### Paired Macs

A paired desktop serves `/simulators*` through the Aiden Remote router (`aiden-remote-simulators.ts`). This needs both the desktop-only `simulators:control` capability and the owner's `peerSharing` consent. The client side (`peer-devices.ts`) relays streams over the pinned-TLS peer connection. The proxy resolves `?host=` to that relay, so the renderer's contract is the same for every host.

### The viewer

`renderer/lib/device-stream.ts` decodes the iOS AVCC stream with WebCodecs. Simulators encode H.264 High 5.1, which some decoders reject, so the viewer probes `isConfigSupported` and falls back to MJPEG. Input goes over the hub's binary input WebSocket (`/vendor/serve-sim/helper/ws?device=<udid>`).

The 3D frame (`renderer/lib/device-3d/`) is procedural. T3's Apple GLB models have no redistribution license and are never bundled. It renders the same decoded canvas as the flat view, in a lazily loaded `three` chunk.

### Tests

- `npm run test:devices`: unit and SSR suites.
- `tests/e2e/environment-devices-*.spec.ts`: Electron E2E against `tests/e2e/device-hub-fake.mjs` and `agent-device-fake.mjs`.
- `scripts/devices-acceptance.mjs --allow-npm-install`: real-Mac acceptance.
