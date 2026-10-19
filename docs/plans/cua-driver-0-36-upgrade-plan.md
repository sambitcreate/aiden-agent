# Cua driver 0.36 upgrade and upstream delta plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Status: implemented on this branch, 2026-10-19 (Tasks 1–6, 8 and 9). Task 7 (optional hover) was skipped. Routing `permission_required` refusals back to the readiness checklist mid-chat is deferred: Aiden returns the setup text instead. The catalog fixture was hand-updated from the 0.36.0 sources (manifest and tool schemas) rather than captured from a live `tools/list`. Phase 4 owner-only packaged acceptance is pending. Proposed 2026-10-19.

**Goal:** Move Aiden's macOS Computer Use pin from `cua-driver-rs-v0.34.1` to `cua-driver-rs-v0.36.0`, adopt the upstream behavior changes that fit Aiden's approval model, and record which newer upstream capabilities are deferred or declined.

**Architecture:** Unchanged from [`docs/computer-use-integration.md`](../computer-use-integration.md): one Hermes-shaped `computer_use` tool, the authenticated Rust broker/bridge, the embedded `mcp --embedded --direct` stdio driver, reviewed exact pins. Aiden is pre-1.0, so the adapter moves to the 0.36 contract outright with no 0.34 compatibility path, as the [0.34.1 upgrade](cua-driver-0-34-upgrade-plan.md) did for 0.8.3.

**Tech Stack:** TypeScript adapter (`main/services/computer-use/`), Rust broker (`native/computer-use-broker/`), Node vendor/pin scripts (`scripts/`), `tsx --test` and `cargo test`.

**Spec:** this document. The upstream evidence is the local checkout at `/Users/sambitbiswas/projects/opp/cua` (HEAD `5cbe31c71`, 2026-10-19) read as `cua-driver-rs-v0.34.1..HEAD`, plus the GitHub release `cua-driver-rs-v0.36.0`.

## Global constraints

- Pin the released tag `cua-driver-rs-v0.36.0` (published 2026-10-16, pre-release, commit `6d6c734c127025fb39ad5d585a10382808b39dc1`), never an unreleased `main` build. Post-0.36 items go to a later pin.
- Asset: `cua-driver-rs-0.36.0-darwin-universal-binary.tar.gz` (52,085,348 bytes; 0.34.1 was 47,101,654). Its member list is unchanged: `cua-driver`, `cua-cursor-theme`, `libcua_driver_sdk.dylib`, `cua_driver_node_runtime.node`, `cua_driver_abi.h`. Aiden still vendors only `cua-driver` and still verifies the cosign bundle when `--verify-sigstore` is passed.
- Archive and binary SHA-256, both CDHashes, the regenerated launch-requirement DER and the broker's DER length/hash pins are read from the downloaded release at implementation time, never copied from this document.
- Every non-negotiable safety rule in the integration doc still holds: no model-selected driver arguments, no public daemon, per-action approval bound to the exact target, foreground delivery as a distinct approval, capture-derived text is untrusted.
- Docs change in the same PR: integration doc, this plan's index row, the form-fill plan's status line, the Linux audit addendum, and the `.memory/` form-fill note.

## Upstream delta since the 0.34.1 pin

171 driver commits across releases 0.35.0 (2026-10-12), 0.35.1 through 0.35.4, and 0.36.0 (2026-10-16), plus 24 unreleased commits on `main` after the 0.36.0 tag. Sources: `libs/cua-driver/rust/CHANGELOG.md`, `libs/cua-driver/contract/manifest.json`, `docs/content/docs/cua-driver/guides/operate.mdx` ("Before updating to 0.35"), the macOS tool sources, and the release workflow.

### A. Breaking changes that stop the 0.34.1 adapter on 0.36.0

| Upstream change | Aiden impact | Fix |
| --- | --- | --- |
| `get_window_state` is lean by default: no `elements` array, no `_note`/`background_input`, 250-node cap, closed menus collapsed to menu-bar titles (#4743, #4892, 0.35.0) | `normalizeElements` reads `structured.elements` and gets nothing; every `som`/`ax` capture reports zero elements | Send `tree_format: "elements"` on every non-vision capture, keep `max_elements`; tell the model menu items are no longer in captures and `menu` takes a path |
| macOS `type_text` sends `\n`/`\r` as Return and `\t` as Tab on key-typed routes (#4821, 0.35.0) | Text with a line break now submits a form or address bar | Refuse `\n`, `\r`, `\t` in `type` text in `safety.ts` with a hint to use `press_key` Return/Tab, so submission stays an explicit, separately approved action |
| Vertex-compatible schemas (#4888, 0.35.0): `target` is a plain object, `scope` is an enum, nullable defaults dropped; `run_steps` (hidden alias `run_actions`) and `run_script` join `tools/list` | The checked-in catalog fixture and the fake driver carry 0.34.1 shapes; the broker's forbidden-tool test does not name the new tools | Regenerate `fixtures/cua-driver-catalog.mjs` from the real 0.36.0 `tools/list`; update the fake driver; add `run_steps`, `run_actions`, `run_script` to the broker's forbidden-tool test |
| `list_apps` omits `bundle_id`, `launch_path`, `kind`, `last_used` when unknown and drops `windows: []` (#4916) | `publicApp` normalization may assume present-but-null fields | Treat those fields as optional |
| Pixel `double_click` routes through `click`, needs a same-session screenshot, result reads "Posted double-click to pid …" (#4976) | Already capture-first; result text differs | Update fake driver and any result-text assertion |
| `click` refuses an unknown AX action name; accepts `show_alternate_ui`/`show_default_ui` (#5005) | Aiden sends no `action` field | None; pin by test that Aiden never forwards an `action` field |
| New refusal codes: `write_not_applied` (set_value read-back shows no change, was "Sent (unverified)"), `window_not_key`, `windowserver_connection_invalid`, `target_focus_unconfirmed`, `direct_capture_consent_required`, `desktop_coordinate_scope_required`, `foreground_partial_unknown`, `electron_main_process_unavailable`, `element_bounds_unavailable`, `permission_required` | Fall through to the generic refusal message | Map each to an Aiden error with a one-line recovery instruction (see Task 4). The macOS 0.36.0 driver actually sends `write_not_applied`, `window_not_key`, `desktop_coordinate_scope_required` and `element_bounds_unavailable` as codes; `windowserver_connection_invalid` arrives only as a `reason` under `background_unavailable` (`tools/mod.rs`), `permission_required` only as an escalation reason, and `direct_capture_consent_required`, `electron_main_process_unavailable`, `target_focus_unconfirmed` (post-0.36) and `foreground_partial_unknown` (Linux/Hyprland only) not at all on macOS. Those are kept as forward-compatible mappings. |
| `verify_state.include_screenshot` is `boolean`, not `["boolean","null"]` | None (Aiden sends `true` or omits) | Covered by the regenerated catalog |

### B. Improvements that arrive with the re-pin

- **Background drag on macOS** (#5309, 0.36.0). 0.34 refused every window-scoped drag in the background, so Aiden forced `delivery_mode:"foreground"` plus a foreground approval. 0.36 drags in the background by default and refuses with `background_unavailable` only when macOS starts a native drag-and-drop session. Still no element endpoints.
- **Background hover** through `move_cursor` with a window target (#5005): reveals hover-only controls through `AXShowAlternateUI` or Electron `sendInputEvent`; never moves the user's pointer. Optional new `hover` action.
- **Other-Space windows**: `get_window_state` screenshots (#4996) and `set_window_frame` (#4636) now work on windows on another Space.
- **Screenshot cap 1366 px by default** (#4917) instead of 1568, with per-call override unchanged. Aiden passes `max_image_dimension` only when the model asks.
- **Quiet actions return after 300 ms** instead of the full 1 s window watch (#4915).
- **`get_window_state since: <snapshot_id>`** returns only added, changed and removed rows or `no change` (#4743); `query` searches the whole window (#4855).
- **`list_windows({app})`** filters host-side (#4916) and lists window rows in text content (#5211).
- **Background delivery fixes** on macOS: user's key window kept (#4943, #4955), user keystrokes not dropped (#5091), popups and context menus stay open (#5129), Electron background scroll through AX (#4861, #5079), right click posted once (#4690), middle-click routing (#5137), explicit modifier flags (#5051), pixel `type_text`/`press_key`/`scroll` refocus their target (#5062), TextEdit and Finder silent failures fixed (#5057), keyboard into editor surfaces and multi-window apps (#5306), menu/format controls on another Space (#5307), Chrome no longer raised by background actions (#5334).
- **`set_value`** selects AppKit and Chromium pop-up options (#4740) and marks a document edited after an AX text write so it saves (#4989, one extra undo step).
- **Honest refusals**: hover, LibreOffice value writes, drag (#4977); `invoke_menu` lists the items when a path segment is missing (#4857); key-name spellings accepted (#4858); `element_token` no longer needs `pid` (#4739, #5047).
- **Embedded host**: `CUA_DRIVER_RS_UPDATE_CHECK` is now honored on the embedded SDK path (#4985); Aiden already sets it. The prompting `check_permissions` call takes one tiny ScreenCaptureKit frame so the direct-capture consent appears during the explicit grant rather than over the user's window (#5352); a bundle-identifier approval counts as consent (#5402).
- **Resources**: SCK capture workers drain autoreleased objects (#5170); bundle plists are read in process (#5369).

### C. New upstream capabilities, with a decision each

| Capability | Decision | Reason |
| --- | --- | --- |
| `run_steps` batch tool (find, wait, check, act in one call; #4737, #4820, #4935) | Defer | One call would carry several mutations, which breaks Aiden's exact-target, one-use grants. Revisit as the executor for an already-approved form-fill batch plan, where the whole plan is approved as one unit. |
| `run_script` sandboxed JavaScript, on by default (#4822, #4936) | Decline permanently | Arbitrary loops and branches inside one call defeat per-action approval. Broker allowlist already blocks it; also set `CUA_DRIVER_DISABLE_RUN_SCRIPT=1` in the driver environment. |
| `get_guide` on-demand skill sections (#5491, unreleased) | Defer to the next pin | Aiden ships its own guidance in `tool.ts`; use the compiled sections as the source when refreshing it. |
| Recovery hints `hint` + `next_call` on every refusal (#5493, unreleased) | Adopt at the next pin | Aiden already reads `error.hint`; `next_call` is a safe read the model can be offered verbatim. |
| `screen_locked` refusal and display keep-awake assertion (#5483, unreleased) | Adopt at the next pin | Surface a "screen is locked" state instead of a foreground suggestion; decide the `CUA_DRIVER_KEEP_DISPLAY_AWAKE` default then. |
| Pointer excluded from window screenshots (#5480, unreleased) | Adopt at the next pin | Fixes a ~37 px pixel-target miss when the user's pointer sits outside the captured window. Strong reason to re-pin promptly after 0.37 ships. |
| `press_key` refuses when target focus cannot be confirmed (#5372, #5402, unreleased) | Adopt at the next pin | New `target_focus_unconfirmed` code (already mapped forward-compatibly in Task 4). |
| `CUA_DRIVER_ALLOW_BRIEF_FOREGROUND=1` auto-escalates a refused drag to a brief foreground drag (#5481, unreleased) | Decline | Daemon-level escalation bypasses Aiden's explicit foreground approval. Keep the explicit `delivery_mode:"foreground"` retry. |
| Agents approving Cua Driver's own macOS TCC prompts (#5467) | Not applicable | Aiden's broker owns the prompts and the user clicks them. |
| Browser tools (`browser_prepare`, `browser_select`, background Chrome attach on another Space, CDP trusted pointer staying in the background) | Out of scope | Browsers belong to the Web Access rehaul; Aiden keeps CDP tools off the allowlist. |
| Cursor motion crate, timing presets, PiP preview, cursor themes | Not applicable | `--direct` mode has no overlay. |
| Spaces / relay targets, cua-bench, lume, Fleet (removed upstream) | Out of scope | Aiden drives the local Mac only. |

### D. Form Fill Specialist: still blocked

0.35 adds `write_not_applied` read-back failure, `since` snapshot diffs and the net-zero key edit that marks a document edited. None supplies a document-lifetime identity or a conditional, atomic write, which [the form-fill plan](form-fill-specialist-plan.md#required-upstream-contract-before-enablement) requires. The plan stays blocked; its status line gains a 0.36 sentence.

### E. Linux audit addendum items

No change to the blocker (Aiden's trust boundary, not GNOME compatibility). Source-only notes for the [Linux audit](linux-cua-driver-gap-audit.md): WinRects v10 captures GNOME windows from their own actor (#4882); embedded and worker processes no longer launch Orca (#5179); AT-SPI bus deadlocks fixed (#4903); Linux reports permission status instead of "not granted" (1ff756b); `CUA_DRIVER_RS_ENABLE_WAYLAND` passes through to embedded hosts (#4877); untitled X11 windows listed (#5341); long text typed in spare-keycode batches (#5168).

## Review focus

Inputs the spec implies but no existing test exercises, each pinned to a task below:

1. A `type` text whose only newline is trailing (a model "pressing Enter" by habit) must be refused, not silently submitted. Task 3.
2. A drag that macOS turns into a native drag-and-drop session returns `background_unavailable`; Aiden must offer the foreground retry with its own approval and never re-send the drag. Task 5.
3. A `som` capture of a window whose menu bar is open must still mint tokens for the visible menu items, while a closed menu yields only titles. Task 2.
4. A `set_value` that the driver reports as `write_not_applied` must invalidate the capture and tell the model to observe, not retry. Task 4.
5. `tools/list` from the real 0.36.0 driver contains `run_steps`, `run_actions` and `run_script`; the broker must deny all three and the catalog filter must drop them without failing the required-tools check. Task 1.

---

## Phase 1: re-pin to 0.36.0

### Task 1: vendor, pins, launch requirement, fixtures

**Files:**
- Modify: `resources/computer-use/cua-driver-artifact.json`
- Modify: `scripts/computer-use-signing-pins.mjs` (`CUA_DRIVER_CDHASHES`, provenance)
- Modify: `native/computer-use-broker/src/darwin_security.m` (regenerated DER), `native/computer-use-broker/src/driver.rs` (DER length/hash pins, `CUA_DRIVER_DISABLE_RUN_SCRIPT=1`)
- Modify: `main/services/computer-use/contract.ts` (`CUA_DRIVER_VERSION = "0.36.0"`, comments)
- Modify: `main/services/computer-use/fixtures/cua-driver-catalog.mjs`, `fixtures/fake-cua-driver.mjs`
- Test: `scripts/vendor-cua-driver.test.mjs`, `native/computer-use-broker/src/jsonrpc.rs` tests, `native/computer-use-broker/src/driver.rs` tests, `main/services/computer-use/computer-use-foundation.test.ts`

**Interfaces:**
- Produces: `CUA_DRIVER_VERSION === "0.36.0"`; a catalog fixture whose `tools` array is the exact 0.36.0 `tools/list` result.

- [x] **Step 1: Write the failing broker test**: extend `allowlist_is_exact_and_has_no_cursor_or_persistence_surface` in `jsonrpc.rs` so the forbidden list includes `"run_steps"`, `"run_actions"`, `"run_script"`, `"get_guide"`, `"move_cursor"`, `"launch_app"`, `"kill_app"`; extend `driver_environment_is_an_explicit_secret_free_allowlist` to require `CUA_DRIVER_DISABLE_RUN_SCRIPT=1`.
- [x] **Step 2: Run** `npm run test:computer-use:native`. Expected: the environment test fails on the missing variable.
- [x] **Step 3: Add** `"CUA_DRIVER_DISABLE_RUN_SCRIPT=1"` to the driver environment in `driver.rs` beside `CUA_DRIVER_RS_UPDATE_CHECK=false`.
- [x] **Step 4: Update the artifact JSON**: `tag`, `sourceCommit` (`6d6c734c127025fb39ad5d585a10382808b39dc1`), `version`, `asset`, `url`, then run `npm run computer-use:vendor -- --verify-sigstore` once with the old hashes to obtain the real archive and binary SHA-256 from its mismatch report, write them, and rerun until it passes. Record both CDHashes with `codesign -dvvv --arch arm64|x86_64` into `computer-use-signing-pins.mjs`.
- [x] **Step 5: Regenerate the launch requirement**: `node scripts/generate-cua-launch-requirement.mjs --write`, then update the DER length and SHA-256 pinned in `driver.rs`; `--check` must pass.
- [x] **Step 6: Regenerate the catalog fixture** by running the vendored driver's `tools/list` through the existing bridge in a dev build (the fake-bridge harness in `host.testing.ts` documents the call) and writing the result to `fixtures/cua-driver-catalog.mjs`; bump the fake driver's `serverInfo.version` to `0.36.0` and its tool shapes to the 0.36 schemas (lean `get_window_state`, `target` object, `run_steps`/`run_script` present).
- [x] **Step 7: Run** `npm run test:computer-use` and `npm run typecheck`. Expected: foundation tests pass with the new catalog; the required-tools check still finds all 20 allowlisted tools; `run_*` are filtered out.
- [x] **Step 8: Commit** `chore(computer-use): pin cua-driver 0.36.0`.

### Task 2: lean `get_window_state`

**Files:**
- Modify: `main/services/computer-use/controller.ts:1110-1190` (capture call), `fixtures/fake-cua-driver.mjs`
- Test: `main/services/computer-use/computer-use-tool.test.ts`

**Interfaces:**
- Produces: `som`/`ax` captures send `{ tree_format: "elements", max_elements, include_screenshot, ... }`; `vision` captures send `{ tree_format: "markdown", include_accessibility_tree: false, ... }` (`tree_format` enum in the 0.36 manifest: `markdown` default, `elements`, `both`).

- [x] **Step 1: Write the failing test** `som capture requests the elements tree_format and still mints tokens` asserting the driver received `tree_format: "elements"` and the result lists `elements.length > 0` from the fake driver's lean default (the fake returns no `elements` unless asked).
- [x] **Step 2: Write the failing test** `capture with an open menu lists its items; a closed menu lists only titles` using two fake-driver fixtures.
- [x] **Step 3: Run** `npx tsx --test main/services/computer-use/computer-use-tool.test.ts`. Expected: FAIL, zero elements.
- [x] **Step 4: Implement** the `tree_format` argument in the capture branch of `controller.ts`; leave `vision` lean.
- [x] **Step 5: Run the tests**; expected PASS. Commit `fix(computer-use): request the elements tree from cua-driver 0.36`.

### Task 3: newline-safe `type`

**Files:**
- Modify: `main/services/computer-use/safety.ts:360-410`
- Test: `main/services/computer-use/safety.test.ts`

**Interfaces:**
- Produces: `evaluateTypeText(text)` (existing entry point in `safety.ts`) fails with code `"blocked_text"` and message `Line breaks and tabs are not typed through Computer Use because cua-driver sends them as Return and Tab. Type the text without them, then press_key Return or Tab as its own action.` when `text` contains `\n`, `\r` or `\t`.

- [x] **Step 1: Write failing tests**: `rejects trailing newline`, `rejects embedded tab`, `accepts text with no control characters`.
- [x] **Step 2: Run** them; expected FAIL (currently accepted).
- [x] **Step 3: Implement** the check before the shell-token scan.
- [x] **Step 4: Run** `npm run test:computer-use`; expected PASS. Commit `fix(computer-use): refuse line breaks in typed text`.

### Task 4: new refusal codes

**Files:**
- Modify: `main/services/computer-use/controller.ts:200-215` (`WINDOW_TARGET_REFUSALS`), `controller.ts:900-960` (refusal mapping)
- Test: `main/services/computer-use/computer-use-tool.test.ts`

**Interfaces:**
- Produces: one `CuaDriverError` message per code (only `write_not_applied`, `window_not_key`, `desktop_coordinate_scope_required` and `element_bounds_unavailable` are sent as codes by the macOS 0.36.0 driver; the rest are forward-compatible mappings, see §A):
  - `write_not_applied`: invalidates the capture; "cua-driver read the control back and the value did not change. Capture the window again and choose another route (an element click or the key action) instead of repeating set_value."
  - `window_not_key`, `target_focus_unconfirmed`: "The target did not have keyboard focus, so nothing was sent. Click the element first or capture again."
  - `windowserver_connection_invalid`, `permission_required`, `direct_capture_consent_required`: reported as `permission_required` with the setup text. Reopening the readiness checklist mid-chat is deferred (see the status line). Final review: `windowserver_connection_invalid` arrives on macOS 0.36.0 as `reason` under `background_unavailable`, so the controller maps that reason to the same readiness message instead of a foreground retry.
  - `desktop_coordinate_scope_required`, `element_bounds_unavailable`: joins `WINDOW_TARGET_REFUSALS`.
  - `foreground_partial_unknown`: treated as `execution_unknown`.
  - `electron_main_process_unavailable`: joins the `background_unavailable` branch (foreground retry offered).

- [x] **Step 1: Write one failing test per code** asserting the message and whether the capture was invalidated.
- [x] **Step 2: Run**; expected FAIL with the generic refusal text.
- [x] **Step 3: Implement** the mapping. **Step 4: Run** `npm run test:computer-use`; PASS. Commit `feat(computer-use): map cua-driver 0.36 refusal codes`.

## Phase 2: behavior adoption

### Task 5: drag defaults to background

**Files:**
- Modify: `main/services/computer-use/controller.ts:1410-1430` (drag branch), `controller.ts:1491` (foreground gating), `main/services/computer-use/schema.ts` (drag description), `main/services/computer-use/tool.ts` (description and guidance no longer list drag as always foreground)
- Test: `main/services/computer-use/computer-use-tool.test.ts`, `main/services/tool-approval.test.ts` if drag approval text is asserted there

- [x] **Step 1: Write failing tests**: `drag sends delivery_mode background by default and needs only the chat grant`; `drag refused with background_unavailable offers a foreground retry and does not resend`.
- [x] **Step 2: Run**; expected FAIL (drag forces foreground).
- [x] **Step 3: Implement**: remove the forced `delivery_mode:"foreground"`; the generic `background_unavailable` branch already produces the `foreground_required` message.
- [x] **Step 4: Run** `npm run test:computer-use`; PASS. Commit `feat(computer-use): background drag with cua-driver 0.36`.
- [x] **Final-review fix**: upstream `drag.rs` returns its drag-and-drop refusal after the press and moves were posted (`code: "background_unavailable"`, `effect: "no_drop"`, `reason: "drag_and_drop_session"`). Aiden now invalidates the capture and answers `drag_released`, asking the model to capture and check before any foreground retry; a `background_unavailable` refused before any input (`effect: "refused"`) keeps the capture and offers the foreground retry.

### Task 6: cheaper captures

**Files:**
- Modify: `main/services/computer-use/controller.ts` (capture by app, `since`), `schema.ts` (new optional capture field), `fixtures/fake-cua-driver.mjs`
- Test: `main/services/computer-use/computer-use-tool.test.ts`

**Interfaces:**
- Produces: capture by `app` calls `list_windows({ app })` instead of the host-wide list; a new optional capture field `changes_only: boolean` sends `since: <previous snapshot_id of the same window>` and returns the driver's diff rows plus `no_change: true` when the driver reports no change. Tokens are still minted only from a full capture, so `changes_only` results never carry element numbers; the result says so.

- [x] **Step 1: Write failing tests**: `capture by app filters list_windows host-side`; `changes_only capture sends since and reports no_change`.
- [x] **Step 2: Run**; FAIL. **Step 3: Implement.** **Step 4: Run**; PASS. Commit `feat(computer-use): app-filtered discovery and snapshot diffs`.

### Task 7 (optional): `hover` action

**Files:**
- Modify: `main/services/computer-use/contract.ts` (add `move_cursor` to both allowlists), `native/computer-use-broker/src/jsonrpc.rs` (`ALLOWED_TOOLS`, test count 21), `schema.ts`, `controller.ts`, `safety.ts`
- Test: broker tests, `computer-use-tool.test.ts`, `access-gate.test.ts`

**Interfaces:**
- Produces: action `hover` with `element_index` or `x`/`y`, always a window target (`target.kind === "window"`), `delivery_mode` fixed to `"background"`; a desktop target or `foreground` is refused by Aiden before the driver (`move_cursor` on the desktop warps the user's pointer). Approval: the chat's Computer Use grant, like `click`.

- [ ] **Step 1: Write failing tests**: `hover forwards move_cursor with a window target`; `hover on a desktop target is refused before the driver`; broker test for the new allowlist length.
- [ ] **Step 2: Run**; FAIL. **Step 3: Implement.** **Step 4: Run** `npm run test:computer-use` (TS and native); PASS. Commit `feat(computer-use): background hover`.

Skip this task if the owner prefers not to widen the broker allowlist in this release; nothing later depends on it.

## Phase 3: guidance and docs

### Task 8: model guidance refresh

**Files:**
- Modify: `main/services/computer-use/tool.ts` (`COMPUTER_USE_TOOL_DESCRIPTION`, `COMPUTER_USE_AGENT_GUIDANCE`), `schema.ts` descriptions
- Test: `main/services/assistant/system-prompt.test.ts` if it asserts guidance fragments

- [x] **Step 1:** Rewrite from upstream's 0.36.0 `libs/cua/skills/cua-driver/{WORKFLOW,MACOS}.md` and the trimmed tool descriptions (#4742): closed menus are not in captures, use `menu` with a path; typed text never contains line breaks, submit with `press_key`; drag is background first; `changes_only` for verification loops; hover reveals hover-only controls; `write_not_applied` means choose another route.
- [x] **Step 2:** Run `npm run test:computer-use` and the system-prompt suite; PASS. Commit `docs(computer-use): refresh model guidance for cua-driver 0.36`.

### Task 9: documentation

**Files:**
- Modify: `docs/computer-use-integration.md` (pin paragraph: 0.36.0, tag, commit, upgrade date; "Process boundary" item 1 mention of the consent probe on the prompting call; drag sentence in the safety rules; screenshot default 1366 px), `docs/plans/README.md` (this plan's row: Proposed → Implemented), `docs/plans/form-fill-specialist-plan.md` (status line), `docs/plans/linux-cua-driver-gap-audit.md` (0.36 addendum from section E), `.memory/upgrade-form-fill-specialist.md`, `docs/plans/cua-driver-0-34-upgrade-plan.md` (one line: superseded by this plan)

- [x] **Step 1:** `grep -rn "0\.34\.1" README.md PRODUCT.md docs .memory` and fix every claim that describes the current pin (history entries stay).
- [x] **Step 2:** Commit `docs: cua-driver 0.36 pin`.

## Phase 4: acceptance (owner-only)

- [ ] `npm run test:computer-use` (TS and native), `npm run typecheck`, `npm run test:ci-policy`.
- [ ] `npm run package`, `npm run package:verify`, then `AIDEN_COMPUTER_USE_ACCEPTANCE=1 npm run test:computer-use:packaged` with real TCC prompts. Confirm the report still carries `embedded: true` and `attribution: "host"` under `--direct`, record where the Screen Recording consent appears (during **Request access**, as #5352 intends, or over the first capture), and that a background drag of a TextEdit selection delivers without fronting the window.
- [ ] Background drag of a Finder list row with the user's pointer parked over another app: record where the drag-and-drop session ends and whether anything dropped. If the drop can land outside the target window, make drag foreground-approved again for apps whose rows start drag-and-drop sessions.
- [ ] Record the receipt in this plan's status line and move the README row to Implemented.

## Phase 5: next pin (0.37, when released)

Not part of this PR. When upstream tags the release that contains #5480, #5483, #5493, #5491 and #5372: re-pin, surface `next_call` to the model, add `screen_locked` to the readiness UI, and decide `CUA_DRIVER_KEEP_DISPLAY_AWAKE`. The 24 unreleased commits also include faster batched steps (#5487), Electron background drags through the main process (#5351), `browser_select` (#5232), and the desktop point ratio derived from the display mode (#5340).

## Gates

- `npm run test:computer-use` (includes `test:computer-use:native`) and `npm run typecheck` green before review.
- Owner-only packaged acceptance per Phase 4; no receipt, no release claim.
- `scripts/ci-test-registry.json` updated for any new test file (`npm run test:ci-policy`).
