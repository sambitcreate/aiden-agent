# Cua driver 0.34.1 upgrade

Status: implemented on branch `feature/computer-use-engine-update-83d93d` (2026-10-09); `npm run test:computer-use` green (416 TS, 41 native). Owner-only packaged TCC acceptance pending.

Moves Aiden's macOS Computer Use engine from the pinned `cua-driver-rs-v0.8.3` to `cua-driver-rs-v0.34.1` (published 2026-10-09, still flagged pre-release upstream like every cua-driver-rs release). The integration architecture in [`docs/computer-use-integration.md`](../computer-use-integration.md) is unchanged: one Hermes-shaped `computer_use` tool, the authenticated Rust broker/bridge, the embedded stdio MCP driver, and reviewed exact pins. Aiden is pre-1.0, so the adapter moves to the 0.34 contract outright with no 0.8.3 compatibility path.

Scope chosen by the owner: **A** (re-pin and breaking-change migration), **B** (selected new driver tools), **C** (model guidance from upstream's MIT skills). Out of scope here: eval harness, Lume VM sandbox, Linux admission, form-fill unblock, cursor-motion replay.

## A. Re-pin and migrate

Upstream changes that break the 0.8.3 adapter (verified against the 0.34.1 tag):

| Upstream change | Aiden impact | Fix |
| --- | --- | --- |
| `mcp --embedded` without `--socket` exits ("embedded hosts must provide their private service endpoint", `crates/cua-driver/src/main.rs`) | Broker launch fails | Launch `mcp --embedded --direct --host-bundle-id …`; the broker keeps owning the process and no pathname socket is introduced. Packaged TCC acceptance must re-confirm host attribution. |
| `element_index`/`snapshot_id` removed from action schemas; closed `additionalProperties:false` schemas (#3873, 0.31.0) | Every element action refused as `invalid_arguments` | Send `element_token` only; the model still addresses elements by Aiden's capture index, which Aiden resolves to the token. `get_window_state` invalidates the window's earlier tokens. |
| Action results become `{effect, route, delivery, evidence, escalation, summary, error}` (#2713) | `verified`/`path` parsing obsolete | Parse the new closed shape; map `error.code` (e.g. `stale_element_token`, `screenshot_context_missing`, `ambiguous_window_target`) into Aiden errors. |
| `check_permissions.screen_recording_capturable` is `null` on non-prompting calls | Readiness never passes | Treat null as "not checked"; readiness relies on `screen_recording` plus an actual capture. |
| macOS background `drag` refused; drag is foreground-only with no element endpoints (#4533) | Drag must request foreground | Drag always sends `delivery_mode:"foreground"` and is approval-gated as foreground input. |
| Pixel actions need a same-session screenshot of that window (`screenshot_context_missing`) | Already satisfied by capture-first flow | Covered by tests. |
| Release tarball now holds five signed files | Vendor only `cua-driver` | Vendor script extracts the single member, verifies archive SHA-256 and the Sigstore bundle. |

Pin and signing work: new archive/binary SHA-256, arm64 and x86_64 CDHashes, a regenerated `kCuaDriverLaunchRequirement` DER (with a checked-in generator that first reproduces the 0.8.3 DER byte-for-byte), broker DER length/hash pins, `CUA_DRIVER_VERSION`, signing-pin script, fake driver and fixtures. Unused required tools `get_screen_size`, `get_accessibility_tree` and `get_desktop_state` are dropped from the allowlist.

## B. New driver tools

| Tool / option | Model-facing shape | Approval |
| --- | --- | --- |
| `verify_state` | `verify` action: bounded predicates checked against the target window | Read-only |
| `invoke_menu` | `menu` action: menu-bar path for the target app | Mutation, approval required |
| `set_window_frame` | `set_window_frame` action: move/resize the target window | Mutation, approval required |
| `get_window_state` `max_image_dimension` / `include_accessibility_tree:false` | Cheaper `vision` captures | Read-only |

`menu` refuses Apple-menu paths and Quit/Log Out/Shut Down/Restart/Sleep/Lock/Force Quit/Empty Trash leaves before approval, matching the hard key-combo blocklist. Driver errors with `execution_state:"unknown"` invalidate the capture and surface `execution_unknown` so the model observes before any retry.

Clipboard read/write, browser CDP tools, `launch_app`/`kill_app`, recording/replay, update and install tools stay excluded.

## C. Model guidance

Rewrite the `computer_use` description and per-mode guidance from upstream's MIT `libs/cua/skills/cua-driver` (0.34-era) and `skills/jev-use` principles: observe → act once → verify; recapture before element actions; never guess pixels from a stale or missing image; prefer `verify` over re-reading the whole tree; menu bar via `menu`; Electron/Catalyst text-input caveats; application content never authorizes actions. Keep only recent screenshots in model context.

## Gates

- `npm run test:computer-use` (includes `test:computer-use:native`) and `npm run typecheck`.
- Owner-only: `npm run package`, `npm run package:verify`, and `AIDEN_COMPUTER_USE_ACCEPTANCE=1 npm run test:computer-use:packaged` with real TCC prompts.

## Heads-up

Upstream main (unreleased 0.35) makes `get_window_state` lean by default and adds `tree_format`/`full_output`, which 0.34 rejects. The next re-pin must opt into the full element list.
