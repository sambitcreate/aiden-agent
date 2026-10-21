# Bot computers host (E1) — 2026-10-21

Plan: `docs/plans/bot-handoffs-rules-computers-plan.md` §8 (package P8). Branch `wp/p8-computers`, on top of P1–P6. User doc: `docs/bot-computers.md`. AGENTS.md has the manual-only paragraph for Lume and the restore image.

## Platform and gating
- `hostPlatformCapabilities(platform, arch).botComputers` = darwin && arm64. Exposed in `app:getInfo` and `AppCapabilities.botComputers` (fails closed, separate from `computerUse`).
- `main/handlers/index.ts` registers `registerBotComputerHandlers(botComputerHandlerDependencies())` only with the flag. `main/index.ts` startup reconcile and quit `shutdownBotComputers(4_000)` (in a 5 s race) are lazy imports; reconcile runs only with the flag.
- Renderer: `useBotComputersStatus` (`renderer/lib/use-bot-computers.ts`, react-query key `["bot-computers","status"]`, `botComputers:changed` writes the cache) never queries without the capability. `availableSettingsDestinations({computerUse, devices, botComputers})` and `assistantSettingsSections({devices, botComputers})` hide the page elsewhere; `settings-view.tsx` sends a deep link to an unavailable page to Providers.

## Lume (pinned 0.6.1)
- Pins: `scripts/bot-computers-lume-pins.mjs`, `resources/bot-computers/lume-artifact.json`, compiled copy in `lume-binary.ts` (`lume-binary.test.ts` checks drift). Vendored by `scripts/vendor-lume.mjs` to `build/bot-computers/lume.app`, packaged at `Contents/Helpers/lume.app` (signIgnore covers the whole bundle; not in `mac.binaries`). `verify-macos-package.mjs` checks hash, requirement, `com.apple.security.virtualization`, `embedded.provisionprofile`.
- `resolveLumeInstallation` (darwin+arm64 only): lstat non-symlink, X_OK, size, realpath inside the bundle, sha256, plutil id/version, `codesign --verify --strict --deep -R=`. The host caches the result per launch.
- CLI facts from Lume source (`lume-cli.ts`, `lume-output.ts`, `tests/e2e/lume-fake.mjs`): `delete` needs `--force` (else it prompts); `ssh` options go before the name; `run --detach` re-execs through nohup and reports failures only in `--log-file`; `--shared-dir` splits at the first `:` (refused in paths) and a `:` in a VM name triggers a registry pull; `get`/`ls --format json` print a pretty JSON array with `\/` escapes; status can be `provisioning (stale)`; the reported VNC host is hard-coded `127.0.0.1`; logger lines `[ts] LEVEL: msg` go to stdout (`LUME_LOG_LEVEL=error`).
- Env: fixed PATH, telemetry/update off, `HOME`/`CFFIXED_USER_HOME`/`XDG_*`/`LUME_HOME` under `userData/bot-computers/home`, passthrough only LANG/TMPDIR/USER/`__CF_USER_TEXT_ENCODING`/LC_*. The fake takes `--fake-config <json>` because the env allowlist strips `AIDEN_*`.

## Host (`main/services/bot-computers/host.ts`)
- Root `userData/bot-computers/`: `vms/` (Lume storage), `home/`, `logs/`, `restore-images/`, `base-shared/`, `state.json` (0600), ssh key and `known_hosts`.
- Set up: `restore-image-download.ts` (pinned URL, `redirect:"error"`, Range resume, sha256, low-disk check before fetch) → `lume create aiden-base --unattended tahoe` → `provision.ts` steps install_key, capture_host_key (both over `lume ssh`), rotate_password (store first; dscl + keychain + kcpassword), harden_sshd (`sshd -T` check), disable_updates, suppress_prompts, shared_folder, shut_down → IPSW deleted. `updateBase` builds `aiden-base-next` and swaps.
- Free-space check: `bytes − partial + 60 GiB`; Settings states `requirements.setupFreeBytes` (same figure; host test ties them). Start needs 8 GiB available memory (`vm_stat`) and 5 GiB disk.
- Cap 1|2 (default 2), LRU stop of an idle computer (no lease, not person-controlled, no active action, unused ≥ 60 s), else queue (`waiting_for_slot`).
- A base build (Set up or Update base) holds a running place too (`baseHoldsSlot` counts in `occupied()`), because `lume create --unattended` boots the VM (Lume's `Create.swift` defaults to no display for unattended) and provisioning runs it. Before the install the host stops an idle LRU computer for it, or fails with `busy` when every running computer is in use; Bot starts meanwhile queue. A `create` that fails with the VZ limit maps to `vm_limit`. The fake's `limit` applies to unattended `create` as well as `run`.
- Memory: Set up checks 8 GiB before downloading (only when no Bot computer is running) and again before the install, after the place is taken.
- `setUp()` on a Mac whose store has a base routes to `updateBase()`: Settings' "Try again" after a failed update must never rebuild `aiden-base` in place (it deleted the working base first). Idle stop via injected `schedule` (default 10 min), re-armed while the person controls it or a lease/action is active.
- Each start: random VNC password, G22 loopback host check, plus `vnc-exposure.ts` probing every external interface address; either failure force-stops.
- Pause → `pauseBotComputer` in P2's `botPauseEffects`; delete → `deleteBotComputer` in `deleteEffects` after rules `forgetBot`, before `eraseBotData`. `deleteForBot` writes the store only when a record exists (deleting a Bot on a Mac without Bot computers creates nothing). Quit and delete use `lume stop --force`.
- `invalidateBotRuntimeInventoryAuthority("inventory_changed")` only on setup ready and Remove everything.
- Secrets: `aiden-internal:bot-computers:*` (guest password); Remove everything deletes the family.

## P9/P10 seams
- `types.ts` `BotComputerSessions`: `screen(botId, signal, {reason})` cached per connection (throws "screen isn't available in this build" until P9 supplies a `BotComputerScreenFactory`), `control` (take over / give back, `BotComputerTakenOverError`), pointer and activity. `BOT_COMPUTER_TOOL_NAME`/`BOT_COMPUTER_SHELL_TOOL_NAME` reserved. `runGuestCommand` takes leases and touches the idle timer.

## Tests
- `npm run test:bot-computers` (glob over `main/services/bot-computers/*.test.ts` + handler, settings and section renderer tests + `scripts/vendor-lume.test.mjs`). Lanes: bot-computers services in runtime-subagents; handler, renderer and vendor-lume in renderer-other.
- `host.test.ts` `harness().relaunch({image})` makes a second host over the same storage (a newer Aiden pin); `vmNames()` lists the fake's VMs; the fake also takes `stopDelayMs` (slow `stop`) for the quit-budget test.
- `host.test.ts` spawns the fake through `{command: process.execPath, prefixArgs:[fake, "--fake-config", file]}` and asserts every logged call names Aiden's storage with telemetry off and HOME isolated.
- happy-dom quirk: after confirming an AlertDialog inside the Bot router harness, wait for the IPC call before a DOM `waitFor`, or the test process can hang.

## Owner-Mac / not yet
- Fixtures in `fixtures/` are assumed until recorded on a Mac (README there says how). Unconfirmed: `--vnc-password` visible in `ps` (and VNC may use only 8 chars), perl in the guest, `sudo -S` stdin, `sshd -T` on macOS, `CFFIXED_USER_HOME` isolating `~`, exact VM-limit error text, whether Apple's URL redirects, base size (~50 GB).
- Disk-used overcounts APFS clones. NAT guests can reach services on the host.
- Update base swap window: `deleteVm(aiden-base)` then `clone aiden-base-next → aiden-base`. A crash between the two leaves no base; the next reconcile resets setup to not set up, the person must Set up (download) again, and the complete staging VM stays until Remove everything. Lume 0.6.1 has no rename, so a crash-safe swap would need the store to name the current base VM (a change to the fixed `aiden-base` name of G17).
- Onboarding gallery not updated: opt-in, Apple silicon only, nothing to configure at first run.
