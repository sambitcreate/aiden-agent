# Simulator Devices: Phase 0 Spike Results

Recorded 2026-09-25 on macOS 27.0, Xcode 27.1 (27A9269), Electron 43 (bundled Node v24.18.0), and an iPhone 17 Pro simulator running iOS 27.0. The scratch scripts were not committed. This document is the record of the spike. It feeds [simulator-devices-plan.md](simulator-devices-plan.md).

## Decisions

| Question | Decision |
| --- | --- |
| Runtime for the pinned tools | **Electron-as-Node.** Spawn `process.execPath` with `ELECTRON_RUN_AS_NODE=1`. The user does not need their own Node. |
| Install mechanism | Use **the user's `npm`**. Resolve it from `PATH`, then from `$SHELL -ilc 'command -v npm'`, then from `/opt/homebrew/bin/npm` or `/usr/local/bin/npm`. Run npm with its own directory prepended to `PATH`. If none of these is found, show a "Node.js/npm is required for setup" state. The registry-tarball fallback is deferred. |
| Tool location | `app.getPath("userData")/devices/tools/<name>/<version>`. These installs are machine-local, contain native modules, and are pinned. They are not portable user config, so they do not go under `aidenConfigDir()`. |
| Decoder path | **WebCodecs H.264 (AVCC)** is the primary path. The MJPEG `<img>` is the fallback. |
| agent-device quick-start | `open <bundleId>` must run before `snapshot`. The first `open` also builds the Apple runner. |

## Task 0.1: Node runtime

- **The pinned installs work.**
  - `npm install --prefix <dir> --no-fund --no-audit expo-device-hub@0.12.0` took about 5s and 44 MB.
  - `agent-device@0.21.12` took about 1s and 6 MB.
  - Both used the default npm registry.
- **The hub under Electron-as-Node works.**
  - The native `node-datachannel` loads under Electron 43's ABI, so no rebuild is needed.
  - The hub also runs under system Node 22.22.
  - The CLI:
    ```
    <electron> <install>/node_modules/expo-device-hub/dist/server/cli.mjs \
      --port <p> --host 127.0.0.1 --hide-sidebar --hide-boot-device
    ```
  - The environment is `ELECTRON_RUN_AS_NODE=1 FORCE_COLOR=0 NO_COLOR=1`.
  - It is ready once `GET /readyz` returns `{"status":"ready",…}`. This took less than 2s here.
  - The hub needs an explicit port. Aiden reserves a free loopback port first.
- **Entry points confirmed.**
  - Hub: `dist/server/cli.mjs`.
  - agent-device: `bin/agent-device.mjs`.
- **npm on PATH.**
  - `npm` was found only under nvm (`~/.nvm/versions/node/v22.22.3/bin/npm`).
  - A packaged app launched from Finder does not inherit that `PATH`, so resolving through a login shell is required.
  - npm's shebang is `#!/usr/bin/env node`, so its directory must also be on the child's `PATH`.

## Hub HTTP surface (expo-device-hub 0.12.0)

| Route | Result |
| --- | --- |
| `GET /api/devices` | `{ simulators: [{ id, name, version: "iOS 27.0", platform: "ios", booted, physical, supported, deviceFrame, lastUsedAt }], emulators: [], errors?: [{ message }] }`. iPads report `supported: false`. |
| `POST /api/devices/boot` `{ platform, id, name }` | `{ ok, id?, error? }`. A cold boot can take minutes, so allow 3 minutes. |
| `POST /vendor/serve-sim/grid/api/start` `{ udid }` | `{ ok: true }`. This attaches the stream helper. It is required even for an already-booted device. **Main calls it directly on the hub. It is never proxied.** |
| `GET /vendor/serve-sim/api` | `{ pid, port, device, url, streamUrl: …/helper/<udid>/stream.mjpeg, wsUrl: …/helper/<udid>/ws, basePath }` |
| `POST /vendor/serve-sim/api/screenshot` `{ udid }` | `200 image/png` |
| `GET /vendor/serve-sim/helper/<udid>/{config,health,stream.mjpeg,stream.avcc}` | All work. The MJPEG stream is `multipart/x-mixed-replace` with a `--frame` boundary. |

**Correction (Phase 3 manual test):** serve-sim's config reports a per-device `wsUrl` (`/vendor/serve-sim/helper/<udid>/ws`). That is the standalone serve-sim path. expo-device-hub routes WebSockets by exact path and destroys that upgrade. Under the hub, the input socket is `/vendor/serve-sim/helper/ws?device=<udid>`, as T3 uses. The proxy allows only that path and requires a well-formed `device`.

## Task 0.2: Stream decode

- `VideoDecoder.isConfigSupported` resolves as supported inside an Electron 43 renderer for `avc1.640033`, `avc1.42E01F`, and `avc1.4D401F`.
- The capture helper reports `1206x2622 direct IOSurface, zero-copy, 60Hz poll + 5fps idle floor`.
- Latency and CPU were not measured. Measure them in Phase 3, against the fake-hub E2E and a real device, before choosing the default.
- A `show: false` probe window never finished its check, so run WebCodecs probes in a visible window.

## Task 0.3: agent-device first run

The configuration:

```
AGENT_DEVICE_STATE_DIR=<userData>/devices/agent-state
AGENT_DEVICE_DAEMON_SERVER_MODE=http
AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS=0
AGENT_DEVICE_NO_UPDATE_NOTIFIER=1
```

The results:

- `devices --json` starts the daemon in about 2.9s and writes `<stateDir>/daemon.json` as `{ httpPort, transport, token, pid, version: "0.21.12", … }`.
- `snapshot -i` with no open session fails with `SESSION_NOT_FOUND`.
- `open com.apple.Preferences --platform ios --udid <id> --session s` takes 4s, including "Building Apple runner…" on first use.
- The first `snapshot -i` takes about 2s and later ones about 0s. Then `close` and `daemon stop --state-dir <dir>` work.
- With Xcode already launched once, no license or first-launch prompt blocked the run. A fresh Xcode install still needs `xcodebuild -runFirstLaunch`, so it maps to a setup `reason`.

## Consequences for Phases 2–4

- **Proxy allowlist.** Use T3's iOS set, with the per-device WebSocket route above.
- **Opening a device.** `DeviceService.open` must call the hub boot route and then `grid/api/start`.
- **Agent guidance.** The Phase 4 `device_open` guidance must say "run `agent-device open <bundleId>` first, then `snapshot -i`".
