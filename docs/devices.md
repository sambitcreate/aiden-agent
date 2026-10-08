# Simulator devices

Aiden can show an iOS Simulator in the Environment panel's **Simulator** tab. There you can tap, type and turn the device yourself. You can also let chats drive it with the `device_*` agent tools while you watch. The design is adapted from T3 Code (MIT, commit `1c127066`); see `THIRD_PARTY_NOTICES.md`.

The feature is on by default on macOS and needs Xcode installed. It is never available on other platforms. To turn it off, launch Aiden with `AIDEN_EXPERIMENTAL_DEVICES=0` (any value other than `1` or `true` disables it).

## Using it

1. Open a chat, then the Environment panel, and choose **+ → More tools… → Device**.
2. Choose **Set up simulator streaming**. Aiden asks before downloading anything (see [Network and privacy](#network-and-privacy)).
3. Pick a simulator and choose **Open** (or **Boot & open**). The live screen appears. Click to tap, drag to swipe, and type while the screen has focus.
4. The rail on the side has Home, Lock, Rotate, appearance, text size, **Screenshot to chat**, **3D view**, **Flat view**, **Restore 3D view** (while 3D is showing), the device tools drawer, **Shut down** and **Close**.

### 3D view

**3D view** shows the live screen inside a device body; **Flat view** shows the plain screen. Your choice is remembered on this Mac.

- **Hardware models.** The iPhone 18 Pro, iPhone 18 Pro Max, 13-inch iPad Pro (M5) and iPhone Duo use the device models T3 Code ships, converted from Apple's AR product files (see `THIRD_PARTY_NOTICES.md`). Each loads the first time that device is shown in 3D. Until then, and if it cannot load, Aiden's own procedural body is shown: built to published dimensions for iPhone 17 Pro / 18 Pro, 17 Pro Max / 18 Pro Max and the 13-inch iPad Pro (M4 and M5), and a generic phone or tablet body for other iPhones, iPads and Android devices. The iPad Pro (M5) adds **Attach Magic Keyboard** to the rail while 3D is showing; attaching it turns the iPad to landscape.
- **Turning and zooming.** Drag around the device, or swipe with two fingers on a trackpad, to turn it. A flick coasts and settles on the nearest useful view. Pinch, or Control-scroll, zooms. Option-drag turns the device even over the screen. **Restore 3D view** straightens the device, resets zoom, and turns the simulator back to portrait.
- **Touch.** Drag the screen to touch it, exactly as in the flat view, in any orientation.
- **iPhone Duo.** The Duo opens and closes in 3D. Pinch over the device to fold the hinge: the model follows your fingers at once and the simulator follows. The **Fold shape** buttons (Closed, Book or Laptop, Open) animate the hinge and re-centre the device on it. The half-fold button reads **Book** when the phone is held upright and **Laptop** when it is held sideways, and the glyphs turn with the phone. **Device stance** sets the native Laptop and Tent stands; a fold button pressed on a stand first turns the phone back to how it was held. Turning the Duo over to the other display asks the simulator to switch displays; if it does not confirm within five seconds, the view turns back. Both displays stay live. The Duo controls also work in the flat view.

The flat view is used whenever the stream falls back to MJPEG, WebGL is unavailable or lost, an iPhone Duo display feed cannot be decoded, or the first frame has not arrived yet. An iPhone Duo also needs a Device Hub that reports its hinge (0.11.0 or newer); otherwise the **3D view** button explains why it is off. All motion respects Reduce Motion.

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

The paired Mac's simulators then appear under their own heading in your tab. Aiden checks paired Macs only when you open the tab or choose refresh. It never polls in the background. Agent tools never use a paired Mac's simulators.

### Simulators on SSH hosts

Any Mac you can already reach with `ssh` can lend its simulators. It needs Xcode, Node.js 22 or newer, and npm on the PATH of a non-interactive SSH shell (Aiden adds `~/.local/bin`, `/opt/homebrew/bin` and `/usr/local/bin`).

1. In Settings → **Simulator** → **SSH hosts**, choose **Add SSH host**. Enter a name, an SSH target (`user@host` or an alias from `~/.ssh/config`), and optionally an identity file and port.
2. Choose **Test connection**. Aiden checks Node, npm, Xcode, and the helper versions on the host. It installs and starts nothing. A target that resolves to this Mac is reported as such and skipped.
3. Save the host, then choose **Install…** on its row. After you confirm, Aiden runs `npm` on the host to install the pinned `expo-device-hub` (and `agent-device` when agent access is on) into `~/.aiden/devices` there.
4. In the Simulator tab the host appears after This Mac and any paired Macs. Choose **Connect**, then open a simulator as usual.

Aiden runs the system `/usr/bin/ssh` with `BatchMode=yes`. It never asks for or stores passwords or keys, so the key must be loaded in `ssh-agent` or named in your SSH config or the identity-file field. SSH hosts are contacted only when you choose **Connect**, **Retry**, **Refresh**, **Open**, **Test connection**, **Install**, **Update**, or **Check versions**. Startup and background refreshes never contact them. Turning simulator streaming off, removing a host, or quitting Aiden closes the tunnels and stops the helpers Aiden started on the host. Helpers installed on a host stay there.

While a host is connected, its device hub is forwarded to a port on this Mac's loopback that has no password of its own, the same as the local hub. Other apps and other user accounts on this Mac can reach that port, and through it run commands on the SSH host as your SSH user. Connect SSH hosts only on a Mac you trust, and disconnect them when you are done. See Internals → "SSH hosts".

When agent access is on, `device_list` and `device_open` also cover SSH hosts that you have connected. The agent never connects a host or installs anything on it. If agent tools are missing on a host, the agent asks you to install them in Settings.

### Helper versions and updates

Each host shows its helpers' installed, running, and pinned versions: in Settings → Simulator, on each SSH host row, and under **Host diagnostics** in the Device tools drawer and the Simulator tab before the hub is ready.

When a new Aiden release pins a newer helper, the update runs only as part of an explicit action, and only for a helper you already approved. Approval means simulator streaming for this Mac's hub, agent access for its `agent-device`, and **Install** for an SSH host. The explicit actions are **Start**, **Retry**, or **Update** on this Mac, and **Connect**, **Refresh**, or **Retry** on an SSH host. Progress such as "Updating the device hub from 0.11.0 to 0.12.0…" shows wherever the host is listed, and a failure offers **Retry** for that host. Nothing updates at startup or in the background. Turning streaming or agent access off cancels any update still waiting its turn or still connecting: each install checks the approval again right before it runs, so only an install that already started can finish.

**Check versions** only reads: the disk on this Mac, and one SSH call per SSH host. It never queries the npm registry.

After a successful update, Aiden reclaims old versions. It keeps the newest previous version as a fallback. **Prune old versions** removes every unpinned version. Both run under a maintenance lock and never delete a version that a running helper was started from.

### Device power features

These work on this Mac's simulators. A paired Mac's simulator gets only the screenshot options, the overlay, and the event log. For Android emulators, see [Device power features on Android](#device-power-features-on-android).

- **Screenshots.** The rail's screenshot control has two halves. The camera sends a screenshot to the chat, as before. The menu beside it offers **Screenshot to chat** and **Save screenshot…**, and, while the 3D view shows, **Save framed screenshot…**, which saves the device as drawn in 3D. Saving opens the system save dialog in Downloads with a name like `iPhone-17-Pro-2026-10-08-142530.png` (`…-framed-…` for the framed image), and the confirmation toast has **Reveal in Finder**.
- **Screen recording.** **Record screen** in the rail starts `simctl io recordVideo` (H.264). While it runs, the button turns into a red indicator with the elapsed time. Selecting it stops the recording with SIGINT so the file is finalized. Recordings stop by themselves after 10 minutes. On stop, the save dialog opens in Downloads (`<device>-<time>.mp4`). Cancelling the dialog deletes the recording. Deleting the chat, quitting Aiden, or shutting the simulator down stops a recording and deletes it. Aiden's composer has no video attachments, so recordings are not attached to the chat.
- **Accessibility overlay.** Turn on **Overlay element frames** in the device tools drawer to outline every accessibility element on the flat screen. Hover an element to see its label and role. The frames follow rotation. While they show, the flat screen is used instead of the 3D frame. On this Mac the tree is re-read every two seconds. On a paired Mac it is read once, and a refresh button reads it again.
- **Event log.** Expand **Event log** in the drawer for serve-sim's live record of touches, keys, buttons, and launches. You can filter, pause (new events keep buffering), clear, and copy it. It keeps the newest 500 entries and is connected only while the section is expanded.
- **Clipboard.** **Paste to device** in the drawer puts the Mac clipboard's text on the simulator's pasteboard (`simctl pbcopy`, text on stdin) and then presses Cmd+V on the device so the focused field receives it. Cmd+V on the focused screen does the same. The keys go 40 ms apart so iOS registers Cmd before V. **Copy from device** (`simctl pbpaste`) copies the simulator's text to the Mac. Only text up to 64 KB is accepted, and images and files are refused.
- **Multi-touch.** On the flat screen, Option-drag places two touches mirrored around the screen centre. Moving toward or away from the centre pinches, and moving around it rotates. Option+Shift-drag moves both touches together for a two-finger pan. Touch dots show both fingers while Option is held. A trackpad pinch over the flat screen pinches the device. The 3D frame keeps its own gestures.
- **Erase.** **Erase all content and settings…** in the drawer first shows a destructive confirmation that names the simulator. It then shuts the simulator down if it is running, runs `simctl erase`, and offers **Boot** to start it again, or **Close simulator**. Agents have no erase tool, and the always-on guidance still forbids erasing a watched simulator unless the user asks.

The agent's `device_screenshot` takes an optional `saveTo` that also writes the PNG to a path. The path must be inside the chat's workspace (a relative path is relative to the workspace) or the Downloads folder. A folder path gets a dated file name. Paths are checked as written and again after resolving symlinks, and no folder below the workspace or Downloads may be a link. The file is written through folders held open from that root, so a folder replaced by a link while saving cannot send the file elsewhere. A final symlink is never followed, an existing file is replaced rather than overwritten in place, and the path is checked before the screenshot is taken. Under ask permission, a screenshot with `saveTo` asks first.

## Android Emulators

The Simulator tab also shows Android Emulators, under the same feature flag and the same streaming consent. Nothing extra is installed: the pinned expo-device-hub already bundles serve-emu. The port follows T3 Code at commit `a6ec88f7`.

- **Requirements.** The Android SDK with Platform-Tools, the Emulator, and Command-line Tools (latest), and at least one AVD from Android Studio's Device Manager. Aiden finds the SDK from `ANDROID_HOME` or `ANDROID_SDK_ROOT`, then `~/Library/Android/sdk`, then the SDK that owns an `adb` on your PATH. It puts `platform-tools` and `emulator` first on PATH for the hub and for every host command. The hub lists AVDs with `avdmanager`, which needs Java; when `JAVA_HOME` is unset, Aiden uses the Java runtime bundled with Android Studio. A Mac without Xcode can still run emulators: the hub starts when either platform can run.
- **Listing.** Each host lists its devices in an **iOS Simulators** and an **Android Emulators** section. A platform that cannot run says why, for example "Android SDK not found." Running emulators come from the hub's `/api/devices`. AVDs the hub leaves out because they never booted come from `emulator -list-avds`. Physical Android phones are not listed. A stopped emulator's id is its AVD name; once it boots, its id becomes the adb serial (`emulator-5554`), and the session follows the serial.
- **Booting and shutting down.** Both go through the hub (`/api/devices/boot` and `/api/devices/shutdown`). Boot failures are classified as in T3: not enough disk space, a timeout, or a launch failure.
- **Stream.** One WebSocket, `/vendor/serve-emu/ws?device=<serial>&frame-meta=1`, carries H.264 Annex-B access units behind a 16-byte `SEMU` header (magic, version, key flag, pts) and takes JSON gestures upstream. The decoder configures from the keyframe's SPS and asks for keyframes with `reset-video`. When a fold or rotation changes the screen size, serve-emu restarts its encoder (`video-session`). The viewer keeps the last frame and input stays connected. After 2 seconds the viewer shows "Waiting for device video…". There is no MJPEG fallback on Android.
- **Input.** Printable characters are sent as text. Arrows, Enter, Backspace, Tab, Delete, Home/End, and Page Up/Down are sent as Android keycodes, and Escape is Back. The rail has Back, Home, Recents, Power, and a Portrait/Landscape menu that tilts the emulator's accelerometer.
- **Device tools.** Appearance, text size, Reduce Motion (the animation scales), the network switch (`svc wifi` and `svc data`), orientation, location, eight permission groups, open URL, launch, quit, and the focused app. Each one is a typed `adb -s <serial>` argv in `main/services/devices/android-device-actions.ts`. Arguments after `adb shell` are quoted for the device's shell, which parses them again. iOS-only controls such as Liquid Glass, color filters, and push notifications are hidden.
- **Foldables.** When the emulator reports a hinge sensor, the viewer shows **Fold device** and **Unfold device**, and the 3D view folds a book-style body to match. The state is read from `/vendor/serve-emu/api/fold` and read again whenever the screen size changes. A failed read is retried every 3 seconds, and a command that does not finish in 12 seconds fails with "Fold command timed out." `useAndroidFold` (`renderer/lib/device-fold.ts`) exposes the posture and hinge angle, from 0 (closed) to 180 (open), for the 3D frame.
- **Proxy.** The allowlist adds T3's serve-emu routes: `api/devices`, `screenshot`, `stream-mode`, `stream-settings`, `accessibility`, `fold`, `health`, and the `ws` socket, plus the read-only `logcat` stream for the event log. Device-scoped serve-emu routes need exactly one valid `?device=`. Each mutating route accepts only its own method: POST for screenshot and fold, PUT for stream-mode, and PATCH for stream-settings. `decideDeviceHubRoute` reports a scope. Reading fold state is `read`; folding, stream tuning, and input sockets are `operate`.
- **Paired Macs.** The `/simulators` listing carries `platform`. The relay forwards the serve-emu stream, screenshots, and fold. It rebuilds the fold body from `posture` alone and never relays stream tuning.
- **Power features.** See [Device power features on Android](#device-power-features-on-android).
- **Agents.** `device_list` reports each device's platform and which platforms this Mac can run. `device_open` takes `platform`, which it needs when both platforms have devices and no `deviceId` is given. It pins agent-device with `--platform android --serial <serial>`. The Android quick start allows `adb -s` for builds, logs, and `adb reverse`, and forbids shutting down or wiping the watched emulator and stopping serve-emu.

### Device power features on Android

Each control appears only where it works. `deviceFeatureCapabilities(platform, { local })` in `renderer/shared/device-features.ts` decides, and the viewer, the rail, and the drawer read it instead of checking the platform. Clipboard, erase, and recording run commands on this Mac, so a paired Mac's or SSH host's emulator shows only the screenshot options, the overlay, the event log, and multi-touch.

- **Screenshots.** **Save screenshot…** and `device_screenshot` with `saveTo` work as on iOS. The capture is serve-emu's `/api/screenshot`, and the default name is the AVD's.
- **Accessibility overlay.** It reads serve-emu's `/api/accessibility?device=<serial>`, which is a flattened `uiautomator dump` in pixels for the dump's rotation. `flattenAndroidAxSnapshot` (`renderer/lib/device-ax.ts`) normalizes it to the same element frames as iOS. It skips the full-screen root and takes the label from the text, then the content description, then the resource id's name. The role is the class name's last part. A dump takes two to three seconds, so this Mac's emulator is read again 3 seconds after each read finishes. A failed dump (an animation, a secure window) shows serve-emu's error.
- **Event log (logcat).** **Event log** shows the emulator's logcat from serve-emu's `/api/logcat?device=<serial>` SSE stream. serve-emu runs one `adb logcat -T 1 -v threadtime` child per emulator while anyone reads, and keeps bounded queues for each reader. It stops the child (SIGTERM, then SIGKILL after a second) when the last request goes away. That happens when the section collapses, the viewer closes, the chat is deleted, or Aiden quits (the hub stops). Lines show as `L Tag: message` in the same 500-entry buffer, with filter, pause, clear, and copy. Their kind is the level (`error`, `warning`, and so on), so filtering for "error" works. When the frontmost app is known, **Only <package>** narrows the log to that app's processes through serve-emu's `package` filter, which re-reads `pidof` every 5 s. Lines serve-emu skipped for a slow reader show as one note.
- **Clipboard.** **Paste to device** types the Mac clipboard's text into the focused field through serve-emu's `text` gesture (`POST /vendor/serve-emu/api/text`, sent by main straight to the hub). The text is split into 300-byte pieces, serve-emu's cap for one gesture, never inside a character. The 64 KB limit still applies, and no Cmd+V follows. Cmd+V on the focused screen does the same. serve-emu's gRPC screenshot mode types ASCII only. **Copy from device** stays visible but disabled, with the reason. adb has no way to read an emulator's clipboard: `cmd clipboard` answers "No shell command implementation." on API 36, and serve-emu has no clipboard route.
- **Screen recording.** **Record screen** runs `adb -s <serial> shell screenrecord --time-limit 180 /sdcard/aiden-rec-<id>.mp4` as a supervised child, with the SDK on its PATH. Stopping runs `pkill -INT -f <that file>` on the emulator, so only this recorder finalizes, and the local `adb shell` exits once the MP4 is written. Then `adb pull` copies it to the private temp file, `rm -f` deletes the device's copy, and E's save dialog opens. The device copy is deleted on every exit path, including a failed pull, a recorder that ignored the stop and was killed, a deleted chat, the emulator shutting down, and app quit. Android recordings stop at **3 minutes**. `screenrecord` caps one segment at 180 s on images before Android 14, and Aiden has no muxer to join MP4 segments, so it does not chain them.
- **Multi-touch.** Option-drag, Option+Shift-drag, and trackpad pinch send two serve-emu `touch` gestures per step, with `pointerId` 0 and 1. The second finger lands after the first and lifts before it. Both serve-emu input paths (scrcpy's inject-touch and the emulator's gRPC `sendTouch`) carry the pointer id as a separate pointer. Coordinates are clamped to 0..1, because serve-emu refuses anything outside.
- **Erase.** The confirmation is the same as on iOS. The hub then shuts a running emulator down (`/api/devices/shutdown`, which waits until adb loses it). The AVD then cold-boots once, headless, on a free console port: `emulator -avd <name> -wipe-data -no-snapshot-load -no-window -no-audio -no-boot-anim -port <n>`. Once `sys.boot_completed` is 1, `adb emu kill` asks it to exit, so the Quick Boot snapshot it saves is the fresh state. A failed shutdown never wipes. While the old emulator still holds the AVD ("Running multiple emulators with the same AVD…"), the wipe boot is retried every 2 s. The whole erase gives up after 6 minutes. An emulator's id goes back to its AVD name when it shuts down, which ends its session, so the progress and the **Boot** offer are a toast rather than the iOS dialog. The hub has no wipe option (its boot takes only `{ platform, id, name }`), and deleting `userdata-qemu.img*` by hand would also have to cover `encryptionkey.img*`, `cache.img*`, and the snapshots. So Aiden lets the emulator wipe itself. On this Mac, a marker file survived a Quick Boot. After the wipe boot and an ordinary Quick Boot, `/data/local/tmp` was empty, and the wipe boot took 26 s.

## Settings → Simulator

Settings → **Simulator** appears in the settings list and command palette only when the feature flag is on. It contains:

- **Simulator streaming**, **Agent access** and **Share with paired Macs** switches. Turning on either of the first two asks before anything is downloaded from npm. Turning streaming off also turns the other two off.
- **Helper tools**: the pinned version of each helper, whether it is installed or running, and any older versions still on disk. Reading this touches only the disk. An outdated helper shows **Update** when its permission is on.
- **Check device tool versions**: re-reads the versions on this Mac and on each SSH host. It installs and changes nothing.
- **Prune old versions**: deletes every helper version except the pinned ones and any version a running helper uses. It runs under the maintenance lock, and an install in progress is left alone.
- **SSH hosts**: add, edit, test, connect, install on, and remove SSH device hosts (see [Simulators on SSH hosts](#simulators-on-ssh-hosts)).
- **Remove installed tools**: asks first, then turns every permission off, stops both helpers, and deletes them together with saved screenshots and agent state. Your simulators and their apps are not touched.

## Network and privacy

- The only new outbound traffic is `npm install <tool>@<exact version>` against your configured npm registry. It runs only after you confirm simulator setup or agent access. The install also lets `node-datachannel` download its prebuilt native binary. Aiden sends nothing about your chats.
- Startup, background refreshes, onboarding and the agent tools never install anything. If the helpers are missing, they say so.
- SSH hosts are contacted over your own `ssh` only from the actions listed in [Simulators on SSH hosts](#simulators-on-ssh-hosts). Their installs run `npm` on that host against its configured registry, and only after you confirm **Install**. Streams from a host travel through the SSH tunnel to this Mac's token proxy. The renderer never connects to the host directly.
- Screenshots you send to a chat go to that chat's selected model, like any image attachment.

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| "Xcode was not found." | Install Xcode from the App Store and open it once so it can finish setting up, then choose refresh. |
| "Android SDK not found." | Install Android Studio and its SDK Platform-Tools, Emulator, and Command-line Tools (latest), or set `ANDROID_HOME`, then choose refresh. |
| An Android emulator shows "Waiting for device video…" | The emulator is restarting its encoder after a fold or rotation. If it does not recover, close the device and open it again. |
| Setup fails with an npm error | Make sure `npm` is on your PATH and can reach your registry, then turn streaming on again. |
| The screen stays black | Close the device and open it again. If the stream can't renew its grant three times in a minute, **Reconnect** appears. |
| The 3D view never shows | The stream is using MJPEG, WebGL is unavailable, or an iPhone Duo's hub predates hinge reporting. Hover **3D view** for the reason. After a failure, close and reopen the simulator to try 3D again. |
| A paired Mac shows no simulators | On that Mac, check **Share with paired Macs** and the simulator-control grant for this Mac. |
| An SSH host says SSH was refused | Load the key with `ssh-add`, or set the host's identity file. Aiden runs ssh in batch mode and never prompts for passwords. |
| An SSH host stops at host key verification | Run `ssh <target>` once in Terminal to accept the host key, then choose **Retry**. |
| "Node.js was not found" or "npm was not found" on an SSH host | Install Node.js 22 or newer with npm on the host. Make sure a non-interactive shell can find it, for example in `/opt/homebrew/bin`, `/usr/local/bin` or `~/.local/bin`. |
| An SSH host is listed as this Mac | The target resolves to this Mac, whose simulators already appear under This Mac. |

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
- Android's variants are argv builders in `android-device-feature-actions.ts`: `androidScreenrecordCommand`, `androidStopScreenrecordCommand`, `androidPullCommand`, `androidRemoveRemoteFileCommand`, `androidWipeBootCommand`, `freeEmulatorPort`, `chunkDeviceText`, and the `eraseAndroidEmulator` state machine. `device-features.ts` dispatches on the platform the device listing reports. A target whose `platform` disagrees with the listing is refused before anything runs, and no recording is touched. The recorder takes per-start `env`, `maxDurationMs`, and `remote` hooks (stop, collect, cleanup) for recorders that write on the device. `DeviceHostReady.env` gives a long-running child the same SDK PATH as `run`. `DeviceService.shutdownLocal` is the hub shutdown that erase uses.
- serve-sim's input socket takes two contacts as message `0x05` (`{ type, x1, y1, x2, y2 }`, normalized like `0x03`). The stream client's `sendMultiTouch` applies the same rotation remap as single touches. The gesture geometry is in `renderer/lib/device-multitouch.ts`, so the 3D view can reuse it.
- `device_screenshot` `saveTo` is written by `writeDeviceSaveFile` (`device-save-path.ts`). Its walk (non-recursive `mkdir`, then `lstat` and `realpath` per folder) only produces clear errors. The write goes through the packaged `aiden-worktree-file-io` helper's `save` operation: it reopens the root by the device and inode captured before the walk, opens each folder beneath the previous descriptor with `O_NOFOLLOW`, writes an `O_EXCL` temporary in the held parent, and `renameat`s it over the leaf through that descriptor. A folder swapped for a link after the walk makes the helper refuse. The one remaining race is a folder moved, not replaced, after the helper opened it: the file still lands in that same folder wherever it now is. Moving it out of the root needs write access to the destination, which a process could use directly, and no file that was already outside the root is created, truncated, or replaced. The leaf is replaced as a directory entry, so a hard link to an outside file keeps that file's contents. **Save screenshot…** writes to the path the user picked in the save dialog and does not use this writer.
- The accessibility overlay reads `GET /vendor/serve-sim/helper/<udid>/ax`, and the event log reads `GET /vendor/serve-sim/api/event-log/events`. Both are already on the proxy's read-only allowlist. They draw short-lived grants from `renderer/lib/device-grant.ts`, because they can outlive the stream's one-minute grant.

### Paired Macs

A paired desktop serves `/simulators*` through the Aiden Remote router (`aiden-remote-simulators.ts`). This needs both the desktop-only `simulators:control` capability and the owner's `peerSharing` consent. Phones use their own grant and consent; see "Aiden On The Go viewer" below. The client side (`peer-devices.ts`) relays streams over the pinned-TLS peer connection. The proxy resolves `?host=` to that relay, so the renderer's contract is the same for every host.

### SSH hosts

`ssh-device-host.ts` implements `DeviceHost` over the system ssh, adapted from T3's `SshDeviceHost`:

- It pipes `ssh-device-script.ts` to `node` on the host. The script has modes `probe`, `start`, `agent-start`, `stop-agent`, and `stop`. State lives in `~/.aiden/devices/hosts/<owner>` and tools in `~/.aiden/devices/tools/<name>@<version>`. The owner is a hash of this Aiden's data directory and the host id, so two Aiden installs never stop each other's hub.
- A start installs only when the service passes `allowInstall`, which happens only for an approved host. Otherwise a missing tool exits with code 3 and the service asks for Install.
- The hub, and the agent-device daemon after agent access, are forwarded to this Mac's loopback with `ssh -N -L` (`ExitOnForwardFailure`, `ServerAliveInterval=10`). The proxy treats the forwarded origin like the local hub, so the renderer contract is unchanged.
- **Known risk: the forwarded hub is open to every local process.** The forward listens on `127.0.0.1:<port>` with no authentication of its own, exactly like the local hub (see "The hub is never exposed"). Any process on this Mac, including one running as another macOS user, can therefore reach the remote host's hub through it, including serve-sim's shell-exec route (its token is readable from the unauthenticated `/api`). That means it can run commands on the SSH host as the SSH user while the tunnel is up, without holding the SSH key. The agent-device daemon forward is less exposed because the daemon checks its own token. The tunnel lives only while the host is connected; disconnecting, removing the host, turning streaming off, or quitting closes it. A forward to a UNIX socket in a `0700` folder (`ssh -L /path/hub.sock:127.0.0.1:<hub>`) would limit it to this user. That was not done because every hub consumer (the token proxy's HTTP and WebSocket paths, the device service's hub calls, and the `/readyz` check) dials a TCP origin today, and the external `agent-device` CLI can only reach its daemon over TCP. It is listed as a follow-up in `docs/plans/simulator-devices-t3-parity-plan.md`.
- There is no health polling. When the tunnel exits, the host reconnects up to five times with a 1 s doubling backoff and never installs while reconnecting. Before a user action reuses a forward, the host checks `/readyz` through it.

`local-ssh-target.ts` parses `ssh -G` (and does a name lookup only for a non-IP hostname) to skip targets that are this Mac. Hosts and their per-host install approval are stored in `userData/devices/ssh-hosts.json`. Revoking streaming clears that approval.

Agent access to an SSH host uses the local `agent-device` CLI through the PATH shim, with a per-host `--config` in `userData/devices/hosts/<hash>.json` that points at the forwarded daemon.

### Tool maintenance

`device-tool-maintenance.ts` holds one JavaScript program, shared with the SSH script. It takes a directory lock (rename of a populated directory, with stale-owner recovery). It never removes the pinned install or any version that appears in `ps` output as a running helper's path. The `reclaim` policy runs after an update and keeps the newest previous version. The `prune` policy backs **Prune old versions**.

### The viewer

`renderer/lib/device-stream.ts` decodes the iOS AVCC stream with WebCodecs. Simulators encode H.264 High 5.1, which some decoders reject, so the viewer probes `isConfigSupported` and falls back to MJPEG. Input goes over the hub's binary input WebSocket (`/vendor/serve-sim/helper/ws?device=<udid>`).

serve-sim keeps one stream helper per simulator and reuses it, even after its simulator was shut down, erased or restarted; such a helper streams one stale frame and then nothing. Before Aiden boots an iOS simulator it reads `/vendor/serve-sim/readyz`, which makes serve-sim close the helpers of simulators that are no longer booted.

### 3D viewer

`renderer/lib/device-3d/` ports T3's viewer code (motion, snapping, framing, interaction, trackpad, model loading, Duo scene and viewer, Android fold scene). Like T3, Aiden bundles T3's Apple-derived GLB bodies in `renderer/assets/devices/models/` (owner decision, 2026-10-08; no redistribution licence is established, and `sources.json` records their provenance). `model-source.ts` matches exact simulator names to them and keeps an abortable, replaceable model slot; `device-model-assets.ts` imports them with `?url`, so they are separate files fetched only when a matching device is shown in 3D; `model-scene.ts` parses them with three's `GLTFLoader`. The main window CSP allows `connect-src blob:` because the loader reads embedded textures through blob URLs. Before a GLB loads, and if it fails to load or validate, `hardware-models.ts` and `duo-model.ts` provide original procedural models in millimetres from public spec-sheet dimensions, then scale them to T3's normalized contract (front +Z, one `device-screen` 2.2 units tall; for the Duo, `left-half`/`right-half` hinge groups and `cover-display`, `inner-display-left`, `inner-display-right`). `model-registry.ts` maps exact simulator names to models and has no `three` import. Everything renders the decoded canvas the flat view already holds, in one lazily loaded chunk with three.js, a PMREM-filtered `RoomEnvironment` for PBR reflections, and the models.

- Motion (`device-motion.ts`) is a quaternion spring with flick coast; release snaps to the nearest rest view with a yaw allowance (`view-snap.ts`). Framing (`framing.ts`) refits the camera with a critically damped spring so turning and folding never clip the device.
- A trackpad orbit ends on Electron's native `gestureScrollEnd`, forwarded by main on `devices:trackpad-scroll-end` (`main/services/devices/trackpad-scroll-end.ts`), with a 1.2 s fallback elsewhere.
- The iPhone Duo view (`duo-viewer.ts`) needs both displays, so `device-duo-stream.ts` replaces the stream's video with per-display feeds that share its grant and input socket: one elected feed when the hub supports physical orientation, otherwise the fixed `/helper/<udid>/panel/1|3/stream.avcc` feeds (already on the proxy allowlist). An inactive display's shutdown blank never overwrites its last image. Duo touches go through `sendRawTouch` in raw framebuffer space.
- Each viewer exposes `capture()`, which renders and encodes a PNG of the framed device in one task. The viewports pass it through `onCaptureReady`; **Save framed screenshot…** sends the bytes to main on `devices:framed-screenshot-save`, which accepts only a PNG of at most 32 MB for a valid device and writes it where the user's save dialog says.
- Android foldables: `android-fold-scene.ts` is selected when an Android profile has a fold angle. The viewer feeds `useAndroidFold`'s angle into `DevicePhoneViewport`'s `foldAngle`, so Fold and Unfold animate the 3D body; the fold controls show in both views. Android emulators use the `android-phone` and `android-tablet` family bodies, chosen by screen aspect.
- The floating player streams the flat screen only. While a device floats, its tab is a placeholder, so no 3D view or Duo display feed runs for it; a hidden or inactive tab unmounts the 3D view, which detaches the Duo feeds before the stream stops.

### Tests

- `npm run test:devices`: unit and SSR suites.
- `tests/e2e/environment-devices-*.spec.ts`: Electron E2E against `tests/e2e/device-hub-fake.mjs` and `agent-device-fake.mjs`. The Android spec also fakes the SDK's `adb` and `emulator`; the iOS specs pin `ANDROID_HOME` to an empty folder.
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
  - serve-sim streams the raw portrait framebuffer. When the screen config is portrait-sized but reports landscape or upside down, both apps draw the frame turned to that orientation (a quarter turn clockwise for `landscape_left`, counterclockwise for `landscape_right`, a half turn upside down) and aspect-fit the turned size. Touches are normalised to the frame as shown, and the encoder's inverse remap returns them to the raw framebuffer, so a tap lands where it appears (`AidenSimulatorDisplayRotation` on both platforms).
- **Input.** Both apps send the same packets as the Simulator tab: `0x03` touch normalised to the frame, `0x04` buttons and `0x07` orientation. The relay enforces that list for phones (plus `0x0D`, the hardware-keyboard toggle sent on open): any other tag, a text frame, or an unmasked frame closes the phone's socket with `1008` before the helper sees it. Paired Macs keep the full input socket. The shared fixture's `mobileSimulators` vectors drive the iOS and Android tests, and `renderer/lib/device-stream-mobile-fixture.test.ts` checks the same vectors against the desktop encoder, so the three clients cannot drift apart.
