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

The paired Mac's simulators then appear under their own heading in your tab. Aiden checks paired Macs only when you open the tab or choose refresh. It never polls in the background. Agent tools never use a paired Mac's simulators.

### Simulators on SSH hosts

Any Mac you can already reach with `ssh` can lend its simulators. It needs Xcode, Node.js 22 or newer, and npm on the PATH of a non-interactive SSH shell (Aiden adds `~/.local/bin`, `/opt/homebrew/bin` and `/usr/local/bin`).

1. In Settings → **Simulator** → **SSH hosts**, choose **Add SSH host**. Enter a name, an SSH target (`user@host` or an alias from `~/.ssh/config`), and optionally an identity file and port.
2. Choose **Test connection**. Aiden checks Node, npm, Xcode, and the helper versions on the host. It installs and starts nothing. A target that resolves to this Mac is reported as such and skipped.
3. Save the host, then choose **Install…** on its row. After you confirm, Aiden runs `npm` on the host to install the pinned `expo-device-hub` (and `agent-device` when agent access is on) into `~/.aiden/devices` there.
4. In the Simulator tab the host appears after This Mac and any paired Macs. Choose **Connect**, then open a simulator as usual.

Aiden runs the system `/usr/bin/ssh` with `BatchMode=yes`. It never asks for or stores passwords or keys, so the key must be loaded in `ssh-agent` or named in your SSH config or the identity-file field. SSH hosts are contacted only when you choose **Connect**, **Retry**, **Refresh**, **Open**, **Test connection**, **Install**, **Update**, or **Check versions**. Startup and background refreshes never contact them. Turning simulator streaming off, removing a host, or quitting Aiden closes the tunnels and stops the helpers Aiden started on the host. Helpers installed on a host stay there.

When agent access is on, `device_list` and `device_open` also cover SSH hosts that you have connected. The agent never connects a host or installs anything on it. If agent tools are missing on a host, the agent asks you to install them in Settings.

### Helper versions and updates

Each host shows its helpers' installed, running, and pinned versions: in Settings → Simulator, on each SSH host row, and under **Host diagnostics** in the Device tools drawer and the Simulator tab before the hub is ready.

When a new Aiden release pins a newer helper, the update runs only as part of an explicit action, and only for a helper you already approved. Approval means simulator streaming for this Mac's hub, agent access for its `agent-device`, and **Install** for an SSH host. The explicit actions are **Start**, **Retry**, or **Update** on this Mac, and **Connect**, **Refresh**, or **Retry** on an SSH host. Progress such as "Updating the device hub from 0.11.0 to 0.12.0…" shows wherever the host is listed, and a failure offers **Retry** for that host. Nothing updates at startup or in the background.

**Check versions** only reads: the disk on this Mac, and one SSH call per SSH host. It never queries the npm registry.

After a successful update, Aiden reclaims old versions. It keeps the newest previous version as a fallback. **Prune old versions** removes every unpinned version. Both run under a maintenance lock and never delete a version that a running helper was started from.

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
| Setup fails with an npm error | Make sure `npm` is on your PATH and can reach your registry, then turn streaming on again. |
| The screen stays black | Close the device and open it again. If the stream can't renew its grant three times in a minute, **Reconnect** appears. |
| The 3D frame never shows | The stream is using MJPEG, the device has a hinge, or WebGL is unavailable. The flat view is intended in these cases. |
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

### Paired Macs

A paired desktop serves `/simulators*` through the Aiden Remote router (`aiden-remote-simulators.ts`). This needs both the desktop-only `simulators:control` capability and the owner's `peerSharing` consent. The client side (`peer-devices.ts`) relays streams over the pinned-TLS peer connection. The proxy resolves `?host=` to that relay, so the renderer's contract is the same for every host.

### SSH hosts

`ssh-device-host.ts` implements `DeviceHost` over the system ssh, adapted from T3's `SshDeviceHost`:

- It pipes `ssh-device-script.ts` to `node` on the host. The script has modes `probe`, `start`, `agent-start`, `stop-agent`, and `stop`. State lives in `~/.aiden/devices/hosts/<owner>` and tools in `~/.aiden/devices/tools/<name>@<version>`. The owner is a hash of this Aiden's data directory and the host id, so two Aiden installs never stop each other's hub.
- A start installs only when the service passes `allowInstall`, which happens only for an approved host. Otherwise a missing tool exits with code 3 and the service asks for Install.
- The hub, and the agent-device daemon after agent access, are forwarded to this Mac's loopback with `ssh -N -L` (`ExitOnForwardFailure`, `ServerAliveInterval=10`). The proxy treats the forwarded origin like the local hub, so the renderer contract is unchanged.
- There is no health polling. When the tunnel exits, the host reconnects up to five times with a 1 s doubling backoff and never installs while reconnecting. Before a user action reuses a forward, the host checks `/readyz` through it.

`local-ssh-target.ts` parses `ssh -G` (and does a name lookup only for a non-IP hostname) to skip targets that are this Mac. Hosts and their per-host install approval are stored in `userData/devices/ssh-hosts.json`. Revoking streaming clears that approval.

Agent access to an SSH host uses the local `agent-device` CLI through the PATH shim, with a per-host `--config` in `userData/devices/hosts/<hash>.json` that points at the forwarded daemon.

### Tool maintenance

`device-tool-maintenance.ts` holds one JavaScript program, shared with the SSH script. It takes a directory lock (rename of a populated directory, with stale-owner recovery). It never removes the pinned install or any version that appears in `ps` output as a running helper's path. The `reclaim` policy runs after an update and keeps the newest previous version. The `prune` policy backs **Prune old versions**.

### The viewer

`renderer/lib/device-stream.ts` decodes the iOS AVCC stream with WebCodecs. Simulators encode H.264 High 5.1, which some decoders reject, so the viewer probes `isConfigSupported` and falls back to MJPEG. Input goes over the hub's binary input WebSocket (`/vendor/serve-sim/helper/ws?device=<udid>`).

The 3D frame (`renderer/lib/device-3d/`) is procedural. T3's Apple GLB models have no redistribution license and are never bundled. It renders the same decoded canvas as the flat view, in a lazily loaded `three` chunk.

### Tests

- `npm run test:devices`: unit and SSR suites.
- `tests/e2e/environment-devices-*.spec.ts`: Electron E2E against `tests/e2e/device-hub-fake.mjs` and `agent-device-fake.mjs`.
- `scripts/devices-acceptance.mjs --allow-npm-install`: real-Mac acceptance.
