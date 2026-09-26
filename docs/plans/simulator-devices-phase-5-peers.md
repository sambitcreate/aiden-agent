# Simulator devices — Phase 5: simulators on paired Macs

Status: Implemented on `worktree-main-20260925` (2026-09-25).
Parent plan: [simulator-devices-plan.md](simulator-devices-plan.md).

## Decision

The parent plan scoped Phase 5 as SSH device hosts, ported from T3. Aiden already pairs desktops with pinned HTTPS, revocable per-device credentials, and LAN or Tailscale reachability (Aiden Remote and `peer-host-registry.ts`). On 2026-09-25 the user chose **"Peers now, SSH later"**:

- Phase 5 reuses those pairings, so a Mac can watch and control the simulators of another Mac it has paired with.
- SSH hosts (T3's `SshDeviceHost`) stay a later follow-up. The T3 sources were reviewed and are summarized at the end of this plan.

## Goal

When Mac B has shared its simulators, Mac A's Simulator tab lists them under B's name. Mac A can open, stream, tap, rotate, change settings, screenshot, and shut them down, just like local simulators. Chats, consent, and tool installs stay authoritative on the Mac that owns the simulators.

## Authority model

Two independent gates must both hold, following the multi-host plan: *"neither client type nor an old broad chat grant silently implies new authority."*

1. **Owner consent on the serving Mac.** A new device-local consent, `peerSharing` ("Share with paired Macs"), sits in B's Simulator tab. It requires `streaming` and is cleared whenever streaming is revoked. When it is off, every simulator route answers `{sharing: false}` or refuses, and the relay closes.
2. **Negotiated capability on the client device.** This is a new capability, `simulators:control`, in its own negotiable vocabulary.
   - A client adds it through the existing post-pairing `POST /device/capabilities` upgrade.
   - Only `mac` and `linux` device records may hold it. The state registry strips it from phone and tablet records when loading them, as defense in depth.
   - Native iOS and Android clients never request it. Their capability types are open raw values, so the additive vocabulary does not affect them. No shared fixture changes.

Pairing direction stays explicit: A controlling B's simulators does not let B reach A's.

## Wire contract (Aiden Remote v1, additive)

Every route below requires a bearer credential, `Aiden-Protocol-Version: 1`, and `simulators:control`. When the serving app has no simulator service (flag off or not macOS), each route answers `404 not_found`.

| Route | Body | Response |
| --- | --- | --- |
| `GET /simulators` | — | `{sharing, status, detail?, devices[]}`. Lists the devices, starting an already-installed hub but never installing. |
| `POST /simulators/open` | `{deviceId}` | `{device}`. Boots the simulator if needed and attaches the stream helper. The client allows 200 s for this. |
| `POST /simulators/shutdown` | `{deviceId}` | `{ok: true}` |
| `POST /simulators/settings` | `{deviceId}` | `DeviceSettings` |
| `POST /simulators/action` | `DeviceActionInput` without `hostId` | `DeviceSettings` |
| `GET, HEAD, POST /simulators/hub/<hub path>` and WebSocket upgrade | — | The hub response, streamed without buffering |

- The relay applies **the same allowlist** as the local proxy, `DEVICE_HUB_HTTP_PATHS`, `DEVICE_HUB_WS_PATHS`, and the mutable screenshot route, through one exported function, `decideDeviceHubRoute`. serve-sim's exec route can never be reached.
- The relay strips `Authorization`, cookies, and the protocol header before forwarding, and it forwards only to the serving Mac's own loopback hub.
- A device ID must belong to a simulator listed by the serving Mac's latest `simctl` listing.
- Upgrades are served by the same LAN HTTPS and Tailscale loopback listeners, with the same connection-mode gating.

## Client side

- `PeerDevices` (`main/services/devices/peer-devices.ts`) adapts `PeerHostRegistry`:
  - it lists enabled paired hosts;
  - it negotiates `simulators:control` once per host;
  - it makes the typed JSON calls through `registry.request`, with a longer `timeoutMs` for boot;
  - it takes binary screenshots over pinned TLS through the relay;
  - it returns a relay upstream for the proxy: the endpoint origin, the base path, the bearer header, and the pinned TLS options.
- `device-service.ts` becomes multi-host.
  - The local host is unchanged.
  - Each peer keeps its name, status, and devices.
  - `refresh()` also refreshes peers.
  - A new `refreshPeers()` refreshes only peers. The tab calls it when the local host is not ready, so opening the tab never starts local helpers.
  - Peers are contacted only from those two user-driven refreshes. There is no background polling.
- `device-hub-proxy.ts` resolves `?host=` to either a loopback hub or a peer relay upstream.
  - For a peer upstream it uses HTTPS or TLS with the pinned SPKI and adds the bearer header.
  - It drops `Origin`, which Aiden Remote refuses, and the renderer never sees the credential.
- The UI groups simulators by host: "This Mac" and then each paired Mac. Each group shows its own status, for example "Simulator sharing is off on Studio." The ready state gains a "Share with paired Macs" switch.
- Agent device tools stay **local-only** in this phase. B's owner shared simulators with paired *people's Macs*, not with A's agent. `device_list` shows only local simulators, and `device_open` refuses peer hosts. Agent control of peer simulators is a follow-up and needs its own consent.

## Tests

- Protocol and state:
  - the simulator vocabulary parses;
  - phone records drop `simulators:control`;
  - the upgrade is refused for phones and when the service is absent.
- Router:
  - each route requires the capability;
  - `sharing: false` short-circuits;
  - unknown devices are refused;
  - the relay allowlist refuses the exec route, and relay requests carry no Authorization header;
  - the WebSocket relay pipes both directions.
- Device service: peer listing and grouping, dispatch by `hostId`, the not-supported case (404) hidden, peer errors isolated to that host, and `peerSharing` consent coupling.
- Proxy: a peer upstream receives the bearer header and TLS options and no `Origin`.
- Panel: grouped rendering, the share switch, and peer status copy.

## As built (2026-09-25)

- The tab's mount and **Start** refresh only this Mac (`devices:refresh` with scope `"local"`). Paired Macs are contacted only from **Refresh paired Macs** / **Try again**, a full refresh, or an open on that host.
- Peers need simulator streaming consent on the calling Mac too. Revoking streaming forgets peers and their sessions, and the proxy stops resolving them.
- Agent tools call `refreshLocal()` and filter state to the local host, so they never contact or list paired Macs.
- `serverCapabilities` includes `simulators:control` only for `mac`/`linux` devices on a Mac with the simulator feature. This keeps a desktop's grants a subset of the advertised inventory, and phones never see the vocabulary. The shared mobile fixture is unchanged; the desktop protocol test compares it with the vocabulary minus simulator capabilities.
- `PeerHostRegistry.request` treats an answered 4xx (`request_failed`) as reachable and keeps the host `connected`. 401/403 arrive as `authentication_required` and still mark it unavailable.
- Revocation closes relay streams twice: before and after the revocation fence, so a stream admitted in between cannot survive.
- Downgrade: an older Aiden cannot load a device record holding `simulators:control`. Downgrading the serving Mac after a desktop negotiated it means re-pairing that desktop. This is documented in `docs/aiden-remote-api-v1.md` and the OpenAPI description.

## SSH follow-up notes (T3, reviewed)

Port these when SSH is scheduled:

- `SshDeviceHost.ts` bootstraps with `ssh … sh -s` and sends the script on stdin. It forwards the hub and the agent-device daemon with `-L`, and runs a health loop with reconnect backoff.
- `sshDeviceScript.ts` has probe, start, agent-start, stop-agent, and stop modes, uses a symlink lock, and installs to `~/.t3/device/tools/name@version`.
- `localSshDeviceHost.ts` parses `ssh -G` to detect a host that is actually this Mac.
- Required constraints: use the system `ssh` with `BatchMode=yes` and store no keys or passwords.
