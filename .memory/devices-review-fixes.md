# Devices: review fixes on the parity branch (2026-10-08)

Follow-up fixes to review findings on `feature/ios-simulator-upgrades-compare-42da8d`, after the A–F merge. Each fix has its own commit and a behavioral test.

## Fixes

1. **SSH stop is sticky** (`ssh-device-host.ts`).
   - A `generation` counter replaces the `stopped` flag. Every connect (`ensureReady`, `ensureAgentReady`, and the reconnect loop) captures it when it is called. `stop()` bumps it.
   - A stale connect refuses before reaching the host, or closes the tunnel it opened.
   - `stop()` cannot be permanent, because `disconnectSsh` keeps the entries and reuses the host objects. Only remove and edit create new objects.
   - Test: three queued connects plus a stop leave no live tunnel, and a later Connect works.
2. **Phones cannot shut down Android emulators** (`device-service.ts`, `createShare`).
   - Mobile `open` and `shutdown` refuse non-iOS devices with `capability_denied` (403).
   - Mobile `action` is refused in the share host too. The relay already refused it, so this is defense in depth.
3. **Phone input socket allowlist** (`aiden-remote-simulators.ts`).
   - `MobileSimulatorInputFilter` is a streaming RFC 6455 client-frame parser, inserted through the new `pipeUpgrade({ inbound })` hook in `device-hub-proxy.ts`.
   - Passes: masked binary messages whose first byte is in `MOBILE_SIMULATOR_INPUT_TAGS` (now exported from `aiden-remote-protocol.ts`), their continuations, and ping, pong, and close frames.
   - Closes with 1008 on anything else: another tag, text, an empty or unmasked frame, RSV bits, or a reserved opcode. The offending frame never reaches the hub.
   - The relay strips `Sec-WebSocket-Extensions` for phones, so no permessage-deflate is negotiated.
   - Desktop relays stay an opaque pipe.
   - Native iOS and Android encoders emit only 0x03, 0x04, 0x07, and 0x0D. They are pinned to the fixture, whose parser refuses other tags. No native change was needed.
4. **Peer AVD id rewrite**.
   - `peer-devices.ts` accepts a changed id only when it matches `isEmulatorSerial`.
   - `device-service.ts` also requires that the requested device was a stopped Android AVD and that no other listed device has that serial. Otherwise the open is refused ("answered with a different device").
5. **Save-path mkdir race** (`device-save-path.ts`).
   - The walk starts from `realpath(root)` and does a non-recursive `mkdir` per component, then checks each one with `lstat` (links refused) and `realpath` (it must stay inside the root).
   - Behavior change: a folder link below the root is now refused even when it points inside the root.
   - The test patches `fs/promises.mkdir` with `syncBuiltinESMExports()` to plant a link mid-walk.
6. **SSH forward exposure** (documented, not fixed).
   - The loopback forward exposes the remote hub, including serve-sim exec, to every local process.
   - A UNIX-socket forward would need every hub consumer (proxy, service hub calls, `/readyz`) to dial a socket path. The external agent-device CLI is TCP-only.
   - Documented in `docs/devices.md` (user SSH section and Internals → SSH hosts), with a follow-up in `docs/plans/simulator-devices-t3-parity-plan.md`.
