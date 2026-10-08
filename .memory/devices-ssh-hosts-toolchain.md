# Devices: SSH hosts and helper versions (October 2026)

This is sibling C of the devices-parity effort (six parallel implementers). It ports T3 Code's SSH device hosts and tool-version UI at `a6ec88f7` (MIT). User docs are in `docs/devices.md` under "Simulators on SSH hosts", "Helper versions and updates", and Internals → "SSH hosts" and "Tool maintenance".

## Shape
- **Shared contracts**: `renderer/shared/device-ssh-hosts.ts`.
  - `SshDeviceHostConfig` has the id `ssh-[a-z0-9]{6,40}`. A target that starts with `-` is refused, so it can never become an ssh option.
  - `DeviceToolVersions` and `DeviceHostCheck`.
  - Draft validation reports errors per field.
  - `DeviceHostInfo` gains optional `tools` and `toolInspectionError`. `DeviceServiceState` gains optional `sshHosts`. Both are optional so siblings' fixtures keep compiling.
- **Main**:
  - `ssh-device-script.ts`: the remote Node program.
  - `ssh-device-host.ts`: tunnels plus reconnect.
  - `local-ssh-target.ts`: `ssh -G`.
  - `ssh-host-store.ts`: `userData/devices/ssh-hosts.json` holds the hosts and a per-host `toolConsent {hub, agent}`.
  - `device-tool-maintenance.ts`: locked prune and reclaim.
- **Service**: `device-service.ts` has an SSH section with these entry points: `startHost`, `updateTool`, `inspectTools`, `saveSshHost`, `removeSshHost`, `testSshHost`. Host order is local, then peers, then SSH.
  - `requireReady` and `requireKnownDevice` are host-aware, so action, settings, screenshot, and close work on SSH hosts unchanged.
- **IPC**: `devices:start-host`, `devices:update-tool`, `devices:inspect-tools`, `devices:ssh-save`, `devices:ssh-remove`, and `devices:ssh-test`.
- **UI**:
  - `settings/simulator-ssh-hosts.tsx` is the group, editor form, and install and remove dialogs.
  - `device-host-diagnostics.tsx` provides versions, `DeviceHostUpdates` with Retry, and the "Host diagnostics" section. It is mounted with one line in `device-tools-panel.tsx` (the drawer) and in the Simulator tab's installing and error states.

## Decisions
- **No health polling.** T3 polls `/readyz` every 10 s. Aiden relies on ssh `ServerAliveInterval` to end a dead tunnel. Reconnects are bounded to 5 attempts, starting at 1 s and doubling, and never install. A user action re-checks `/readyz` through the forward before reusing it.
- **The agent daemon gets its own tunnel.** Starting agent tools therefore never breaks the viewer's hub stream. T3 rebuilds one tunnel instead.
- **Install consent on SSH hosts is per host.** Pressing Install or Update records it. Connect and Refresh then pass `allowInstall` only for approved hosts, which is the "auto-update" path. A streaming revoke clears all SSH approvals. Editing a host's destination clears that host's approval. Agent calls always use `allowInstall: false`.
- **Local updates.** If an older hub is installed and streaming consent is held, `idleStatus` is `stopped` with "X replaces Y when you choose Start". Only `startHost("local")` passes `allowInstall`. The tab's mount and refresh never do. The panel's Start now calls `devices:start-host` instead of `refresh("local")`.
- **Prune and reclaim.**
  - `pruneOldToolVersions` was deleted.
  - Prune now goes through `runToolMaintenance`, which runs under Electron-as-Node with `ps` to protect in-use versions.
  - After an update, a reclaim keeps the newest previous version.
  - Maintenance runs through the `runMaintenance` dependency, which is injected in tests.
- **Quit and revoke are bounded.** Tunnels close immediately. The remote `stop` gets 5 s (`withinBudget`), because `shutdownDevices()` is not otherwise bounded in `main/index.ts`.
- **Agent tools.** `device_list` and `device_open` include SSH hosts whose status is `ready`. Listing still calls only `refreshLocal()`, and paired Macs stay excluded.
- **Version checks are local only.** Check versions reads the disk, plus one SSH probe per host. No npm registry query was added.

## Tests (all in `test:devices`)
- `ssh-device-script.test.ts` runs the real script under node, with a fake HOME and fake npm and xcrun. It covers probe, missing npm, missing-tool exit 3, an approved start with reclaim, stop, owner isolation, and quoting through `sh -c`.
- `ssh-device-host.test.ts` uses fake tunnels and runSsh. It covers forward argv, backoff, give-up, stop during reconnect, port retry, the agent tunnel, and the dead-forward restart.
- The other suites:
  - `device-tool-maintenance.test.ts`
  - `local-ssh-target.test.ts`
  - `ssh-host-store.test.ts`
  - `device-service-ssh.test.ts`
  - `renderer/shared/device-ssh-hosts.test.ts`
  - `device-host-diagnostics.test.tsx`
  - `settings/simulator-ssh-hosts.test.tsx`
  - the SSH test appended to `device-tools.test.ts`
  - IPC channel validation in `device-ipc.test.ts`

## Not done or follow-ups
- There is no Electron E2E for the SSH flow, because it would need a fake `ssh` binary. Real-host acceptance against a second Mac is still pending.
- Settings has no per-host "Prune" for SSH hosts. The remote side reclaims automatically after a successful start.
- After a version mismatch, the local daemon from an older Aiden is replaced only via `stopAgent` on an agent update. `startAgentDaemon` still reuses any healthy `daemon.json`, which was pre-existing behaviour.
