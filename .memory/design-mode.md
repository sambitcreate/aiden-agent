# Design mode

Status: active. P0 (retire Studio), P1 (layout shell) and P2 (canvas and frames, Tasks 1–7) are done. The Mac Studio work was pushed as `claude/design-mode-deep-dive` on 2026-11-05, then merged with `origin/main` on `claude/project-thread-29fzrr` (the PR branch). P3 (Aiden on the canvas) is done (2026-11-05, P3a–P3d, on the PR #778 branch), plan `docs/superpowers/plans/2026-11-05-design-mode-p3-aiden-on-canvas.md`. P3a (canvas tools) is done: `main/services/design-canvas/canvas-tools.ts` (four tools, 20 calls per turn, `designCanvasToolsAllowed` gate, `DESIGN_MODE_PROMPT_SECTION`), wired in `llm-client.ts` as the `aiden.design-canvas` runtime extension (static prompt section + volatile `canvasPromptLine` so the prompt cache holds). P3b (artifact frames) is done: `artifact-frames.ts` places committed `render_artifact` visuals after `generativeUiArtifactStore.commit` (never on a failed turn), same-title Aiden frames swap `mediaId` and keep their box; `ArtifactNode` keys its loaded src by mediaId. P3c (skill) is done: `design-canvas/skill.ts` (`aiden-design`, `DESIGN_CANVAS_SKILLS`), registered in `skill-registry-main.ts` only when the flag is on, dropped by `withoutSkills` unless `designCanvasOffered` in llm-client, and from Remote and Telegram catalogs. P3d is done: `design-mode-tool.ts` (`DesignModeConsent`, `design_mode`, on-demand), `canvas-snapshots.ts`, card `renderer/design/design-mode-consent.tsx`, focus store `renderer/design/canvas-focus-requests.ts`; canvas tools held back and added by `withEnteredCanvasTools` after Enter; new tests must also go in `scripts/ci-test-registry.json` or `npm test` fails its registry check. P4 plan (owner chose everything in their reference screenshots): `docs/superpowers/plans/2026-11-05-design-mode-p4-full-canvas.md`; P4a built 2026-11-05, P4e, P4b, P4c, P4d, P4f, P4g and P4h built 2026-11-06, P5 (launch) built 2026-11-06. Placement moved to `renderer/shared/design-canvas/placement.ts`; summaries in `canvas-summary.ts`. P4–P5 plans are written before each phase.

- Spec: `docs/superpowers/specs/2026-10-31-design-mode-design.md`. Plans: `docs/superpowers/plans/2026-10-31-design-mode-p0-retire-studio.md`, `docs/superpowers/plans/2026-10-31-design-mode-p1-layout.md`.
- It replaces Design Studio (DS-1a, #385). P0 deletes the Studio code. It keeps the canvas, studio assets, the `finishTurn` harness, `generation-stream` and the `ChatOwnerV1` parser, and leaves data on disk.

## Owner decisions (2026-10-31)

- Attached to a workspace or an Aiden private folder (#667 removed no-workspace chats).
- Ships to people: default-on since P5 (2026-11-06); `AIDEN_DESIGN_MODE=0` (or false/off/no) is the kill switch. The old `AIDEN_EXPERIMENTAL_DESIGN_MODE` does nothing now.
- Desktop only now, Remote-ready later. The Remote projection must not expose `designMode` yet.
- The right side is an infinite canvas "like Create Images / Figma / open-design / Paper" where the agent creates things and the person points and annotates (owner, 2026-10-31). This superseded v1's browser-tabs canvas.

## Design choices

- Designs are workspace files (`design/<slug>.html`); the canvas document (`userData/design-canvases/<chatId>.json`, revision CAS) only records frames and comments.
- Canvas reuses `StudioCanvas` (xyflow). Frames: file, artifact, image, note, group. At most 6 live iframes; the rest show `capturePage` snapshots.
- Files are served by a new `aiden-design:` scheme: per-chat grant token, realpath containment, no network CSP, vendored libs under `__aiden/lib/`, injected bridge script. Iframes are `sandbox="allow-scripts"` only.
- Comments copy open-design: `data-aiden-comment` IDs written into the source, fuzzy re-anchoring (anchored, stale, lost), an `<attached-design-comments>` scoped block. Draw marks are normalised 0..1.
- Agent tools: `canvas_read` (tldraw-style context), `canvas_place_frame`, `canvas_update_frame`, `canvas_remove_frame`, `canvas_focus`, `canvas_arrange`, `canvas_page`, plus `design_mode` (consent card, `aiden_open` pattern, offered only when Inline visuals is `automatic`).
- Widths: chat 420 (360–560); canvas at least 320. Split at a content container of 680 px or more, stacked (Chat | Canvas segmented control) below. Only a person's entry in this window resizes: collapse the sidebar if that makes room, else widen to 1280. The banner shows only while stacked and widening can work. Escape never leaves design mode. (Revised in the P1 review, 2026-11-01; the first cut used 480 / 1100 / 840 on the window width.)
- open-design (nexu-io) has no infinite canvas; its value is picking, comment anchoring and agent context. Avoid its CDN React/Babel, `allow-same-origin` and foreignObject screenshots.
- Owner (2026-10-31): ship design mode only. Create Images is being reworked in another thread, so keep edits to `renderer/canvas/*` and `studio/feature-flags.ts` additive and check for its open PRs before touching them.

## P0 notes (2026-10-31)

- Stale `/design` and `/design/$projectId` links use `beforeLoad: redirectRetiredRoute` (in `renderer/main/studio-capability-route.tsx`) and land on `/`. P1 replaces these routes.
- `llm-client` refuses a chat with any `owner` ("belongs to a feature that is no longer available"), keeping the old `resolveGenerationProfile` refusal for hidden `design-project` chats. The rule is `chatRunRefusal(chat)` in `renderer/shared/chat-visibility.ts` (keyed on surface "feature"), tested in `chat-visibility.test.ts`.
- `generation-harness.ts` (`createGenerationHarness`) is gone; `llm-client` builds `new PiAgentRuntimeHarness(...)` directly. The dead `inputClosed` admission flag was removed too. Extensions compose inline as base, then advisor, then codemode.
- Shortcut decided (2026-10-31): `design.toggle` = ⌘⇧L (`Command+Shift+L`), listed in `INTRODUCED_DEFAULT_COMMANDS`. ⌘⇧D stays with `dictation.toggle` (off by default, global; a local default on it would block enabling dictation). ⌘⇧G is find-previous (built-in-keys), ⌘⌥D is the macOS Dock toggle.
- Under Node, TanStack router-core always runs in server mode, so a `beforeLoad` redirect sets `router.state.redirect` without following it; tests follow it with `router.navigate`.
- Open PR #682 (chat images as files) edits main-window.html CSP and custom-schemes-core(.test).ts; P2 Task 3 touches the same lines — merge origin/main and recheck after it lands.

## P1 layout shell (2026-10-31, in review)

Module map:

- Flag (now a kill switch, `AIDEN_DESIGN_MODE=0`): in `main/services/studio/feature-flags.ts`, surfaced as `AppCapabilities.designMode` (`renderer/lib/app-capabilities.tsx`). Off means no UI, no shortcut, no `/design`, and `chats:setDesignMode` refuses.
- Storage: `Chat.designMode?: boolean` (omitted means off) in `chat-store-core.ts`; written through `chat-application-service.ts` and the `chats:setDesignMode` handler (`main/handlers/chats.ts`, params in `chat-renderer-mutations.ts`), broadcast on `chats:design-mode-changed`. Bot and `owner` chats are never eligible. Not in the Remote projection.
- Window: `app:widenForDesign` (`main/handlers/design-window.ts`, pure `widenedBounds` in `main/windows/design-window-core.ts`) widens to 1280 only when `canWidenForDesign` allows it (not fullscreen or maximized, work area at least 1280), otherwise `{widened:false}`; `app:designWindowCanWiden` asks the same question without resizing.
- Renderer state: `renderer/lib/design-mode.ts` has `designModeAvailable`, the optimistic `useSetDesignMode` hook (module-level in-flight map, settles on the latest), `DesignModeControlsContext` / `useDesignModeControls(chatId)`.
- Layout: `renderer/design/design-layout.tsx` (`DesignLayout`, `useDesignChatState`, `useDesignWindowPolicy`, the localStorage snapshot of panel and sidebar state taken on entry), `design-chat-divider.tsx` (separator "Resize chat", 360–560), `design-canvas-region.tsx` (split or stacked), `design-canvas.tsx` + `design-canvas-empty.tsx` (placeholder until P2), `renderer/components/design-mode-banner.tsx` (rendered by `DesignModeBannerSlot` in the chat's ScrollArea toolbar). Wired in `renderer/main/chat-layout.tsx` / `chat-pane.tsx`; the Environment panel is closed and forced to overlay, not unmounted (`environment-panel-layout.ts`).
- Sidebar: `chat-sidebar.tsx` scope list (‹ All workspaces row above the workspace heading) from `sidebar-workspace-groups.ts`.
- Entry points: `DesignModeToggle` in `chat-top-bar.tsx`; `design.toggle` (⌘⇧L, `INTRODUCED_DEFAULT_COMMANDS`, capability `designMode`) in `keybindings.ts`; `/design` and `/design off` in `slash-commands.ts`.
- Tests: `npm run test:design-mode` (design-mode, design-window-core, design-layout, chat-sidebar-scope, chat-top-bar-design) plus additions to the keybindings, command-system-core, shortcut-sheet, slash and store suites; E2E `tests/e2e/design-mode.spec.ts`. Screenshots are taken by that spec when `AIDEN_DESIGN_SCREENSHOTS=<dir>` is set.

Deviations from the P1 plan:

- Tasks 1–5: a dedicated `chats:design-mode-changed` channel instead of reusing chat updates; the store owns the shape checks and the service owns eligibility; the flag is enforced at the IPC handler as well as in the UI; param tests live in `chat-renderer-mutations.test.ts`; the hook test is `.tsx`; `designModeAvailable` takes an optional workspace and excludes `owner` chats; the channel is `app:widenForDesign`; `useSplitViewSidebar` carries the sidebar collapse; `test:design-mode` was created in Task 4 and lists the files that exist (the plan named files that were never created); the workbench is closed and forced to overlay rather than unmounted; the empty-state title is "Nothing on the canvas yet"; the banner shows again whenever the window drops below 840.
- Task 6: the scope test is a new behavioral file (`chat-sidebar-scope.test.tsx`) because `chat-sidebar.test.tsx` is a source-grep contract; a scoped sidebar forces the projects view and hides remote rows; the back row sits above the heading; choosing All projects holds per chat for the window session and resets when design mode turns off.
- Task 7: the shortcut handler lives in `DesignWorkbench` through `DesignModeControlsContext`, not in `root-view`; `CommandCapability` gates `design.toggle` (`paletteWhenAvailable`) in the palette, shortcut sheet and shortcut settings; new slash kinds `optional-off` argument, `design-mode` action, `design-chat` availability; `slashCommandWaitsForArgument` lets `/design` run on Enter with no argument; the composer offers `/design` only when the controls belong to its chat. Chats in a `noWorkspace` workspace are eligible; Assistant, Bot and `owner` chats are not.
- Task 8: the plan's "canvas at least 980 px at 1440" is impossible with the sidebar open (1440 − ~260 sidebar − 420 chat); the E2E asserts the canvas runs from the divider to the window edge and is at least 480. The widen and banner cases stub `screen.getDisplayMatching` in the main process, because xvfb's screen is 640×480. The canvas width follows the Environment panel spacer's 300 ms close transition, so the E2E polls until the canvas reaches the window edge. The fake model titles every chat with its reply, so the E2E renames each chat after its first message. Screenshots switch light/dark with `settings:previewAppearance` (not saved); setting `nativeTheme.themeSource` is ignored because the renderer keeps its own mode. The E2E passed (2/2) in a Linux Cua Space, so darwin-only paths were not exercised. P1 review rerun (2026-11-01): the rewritten E2E covers split at 1440 and 1000, stacked at 640 (Chat | Canvas), the banner (dismiss and Widen), the 800 collapse and 640 widen entries, a 360 px header non-overlap check and the scope clear; it passed 2/2 in the Space. In the compact overlay (under 700 px) picking a chat leaves the sidebar open and the content inert, so the spec presses Escape; the scoped sidebar hides other workspaces' chats, so it steps out via All workspaces first.
- Seen in the P1 screenshots, for P2: the global Live pill sits over the canvas zoom controls at the bottom right; at 800 px the overlay canvas covers the whole chat. (Both fixed in the P1 review fixes below.)
- Pre-existing, not ours: `renderer/main/chat-transition.test.tsx` hangs after all 35 tests pass, also at the base commit.

## P1 review fixes (2026-11-01)

- Layout is decided from the content container: `resolveDesignCanvasLayout` returns `{mode: "split" | "stacked", chatWidth, canvasWidth}` (`DESIGN_SPLIT_MIN_WIDTH` 680, `DESIGN_CANVAS_MIN_WIDTH` 320, `DESIGN_WIDEN_TARGET` 1280). `data-design-layout` on the layout root is `split`, `stacked` or `off`.
- Stacked: `DesignPaneContext` / `useDesignPane()` hold the shown pane per chat (module-level map, window session). `DesignPaneSwitch` (Segmented "Design mode view") sits after the toggle in the top bar. The hidden chat body goes through `ScrollArea bodyHidden` and `DesignChatBody` (terminal drawer), which stay mounted but `inert`, `aria-hidden` and invisible.
- Window policy (`useDesignWindowPolicy`): only `consumePendingDesignEntry` (set by the toggle, ⇧⌘L and `/design` in this window) may collapse or widen, via `resolveDesignEntryAction`. `app:designWindowCanWiden` feeds the banner; `widenWindowForDesign` returns `{widened:false}` when fullscreen, maximized or the work area is under 1280, and skips animation under macOS Reduce Motion. After a widen a 150 ms debounced resize reopens the sidebar if the split fits. The collapse marker `aiden-agent.design.sidebar-collapsed-by-design` stores the sidebar width. On entry the room is measured as `window.innerWidth` minus `useSplitViewSidebar().reservedWidth` (0 while collapsed or overlaid), not the content container: the Environment panel is still closing then, and measuring the container collapsed the sidebar at 1440.
- Live pill: `EnvironmentPanelContext.reportDesignDockInset` moves the dock's right inset to the canvas width (split) or `containerWidth - 128` (stacked canvas), so it stays off the canvas controls. Best effort in stacked mode.
- Top bar: `useToolbarDensity` returns `regular | compact | tight` (tight below 480 px of content); tight folds `foldable` actions (Quick View, Terminal) into the ••• menu only while design mode is on (a narrow window outside design mode keeps them, per `chat-top-bar.spec.ts`) as `data-folded-toolbar-action` rows. The title `h1` gets `min-width: 0` in design mode and header actions are `shrink-0`. Missing padding in `getComputedStyle` counts as 0 (happy-dom returns "").
- Workbench snapshot: entry always closes the panel and Quick View; it rewrites the snapshot when none is saved or the panel or Quick View is open, so a stale one from another window is replaced.
- Sidebar: "‹ All workspaces" row, a workspace-row-style heading, "Show only <workspace>" after clearing, and a render-time fallback to the full list when the scope is empty (the scope is never cleared automatically).
- Copy: "Designs will appear here."; "Design mode isn't available in this chat."
- Testing gotcha: never `assert.equal(element, null)` in happy-dom tests; a failing assert tries to inspect the element and the run hangs. Compare `=== null` instead.

## P1 review round 2 (2026-11-01)

- Composer footer (all composers, not only design mode): `.composer-action-row` is `flex-1`, so its zero basis never wrapped and the actions overflowed leftward over "+" in a narrow composer (a 390 px window did it outside design mode too). The `@container composer (max-width: 420px)` tier now hides the model and Reasoning labels (`composer-model-label`, only when a provider icon is shown; `composer-reasoning-label`), squares the model trigger (`composer-model-trigger`), tightens the action gap, and wraps the footer and the action row on their natural width. At the default 420 px chat column the footer is one row; at 360 the actions move to a second line.
- Banner: `DesignModeBannerSlot` (from `design-layout.tsx`, via `DesignBannerContext`) renders in `ScrollArea`'s new `toolbarAccessory` slot, so the measured toolbar height pushes messages down and it never covers the Chat | Canvas control. The slot reports its height; the stacked canvas region takes `stackedTopInset` and starts below it. The old absolute `top-14 z-40` overlay is gone.
- "Canvas chrome missing at 1000 px with the sidebar open" was a screenshot taken while the lazy `DesignCanvas` chunk loaded: the Suspense fallback shows the same "Designs will appear here." without the tool rail or zoom controls. No canvas change; the E2E now waits for the "Canvas tools" and "Zoom" toolbars and checks they sit inside the canvas region apart from each other (320 px canvas included).
- Chat title: the truncating title spans carry `title` with the full text (the button's accessible name already was the full title).
- E2E helpers in `tests/e2e/design-mode.spec.ts`: `expectComposerFooterClear` (visible footer buttons stay inside the composer, no pairwise overlap, "+" and send present; the context meter only outside design mode), `expectCanvasChrome`, and banner-below-header / first-message-below-banner checks. Test 2 also checks the footer at a 420 px window with design mode off. Passed 2/2 in the Cua Space.
- Formatting gotcha: `npx oxfmt` on `styles.css` or `model-picker.tsx` reformats the whole file (HEAD is not oxfmt-clean there); keep diffs to your own lines.

## P2 Tasks 1–3 (2026-11-01)

- Task 1, `renderer/shared/design-canvas/schema.ts`: `DesignCanvasV1`, `parseDesignCanvasV1` (drops and counts bad frames, clamps sizes, coordinates and zoom, bounds comments, refuses a non-integer revision), `emptyDesignCanvas`, `isDesignRelativePath`.
- Task 2:
  - `DesignCanvasStore` (`main/services/design-canvas/store.ts`): one atomic `<userData>/design-canvases/<chatId>.json` per chat, a promise chain per chat, and a CAS `save(chatId, doc, baseRevision)`. The singleton lives in `design-canvas/main.ts`, not `main/index.ts`.
  - IPC: `designCanvas:get`/`save` (broadcast `designCanvas:updated`) in `main/handlers/design-canvas.ts`. Each handler refuses with the flag off and refuses unknown chats.
  - Renderer client: `designCanvasApi` at the end of `renderer/lib/ipc.ts`.
  - Deleting a chat (and startup pending-deletion reconcile) deletes its canvas.
- Task 3, `aiden-design://<grant>/<workspace-relative path>`:
  - Grants: `DesignGrantRegistry` (`grants.ts`) keeps them in memory only. A grant is lowercase base32 of 32 random bytes, 52 chars. That deviates from the plan's base64url, because Chromium lowercases standard-scheme hosts. `revokeRoot` was added for workspace removal. The singleton is `designGrants` in `design-canvas/main.ts`.
  - Grant IPC: `designCanvas:grant` → `{grant}` or `{error:"unavailable"}`. It needs design mode on, no `botId`, no `owner` and a workspace `folderPath`. It re-reads the chat after issuing and revokes if the chat changed.
  - Revocation: grants end on design mode off, a move to another workspace, chat delete and workspace remove.
  - `resolveDesignFile` (`resolve-core.ts`) parses the raw path, because WHATWG parsing would collapse `%2e%2e`. Then it realpaths and checks `isPathInside`.
    - 404: traversal and encoded `..`, empty or `.` segments, separators or NUL, symlink escape, missing files, directories, extensionless names.
    - 403: dot segments and disallowed extensions.
    - 413: files over 8 MiB.
  - `designResponse` (`protocol.ts`): every response carries `DESIGN_CONTENT_SECURITY_POLICY`, `no-store` and `nosniff`. Failure bodies are plain, with no paths. Methods other than GET or HEAD get 405.
  - Bridge: HTML gets `<script src=".../__aiden/bridge.js">` injected after `<head>` (else after `<html>` or the doctype), byte-level through latin1. `__aiden/lib/<name>` serves the generative-UI host libraries.
  - Wiring: `startDesignProtocol()` (`protocol-main.ts`) is called from `main/index.ts` only when the flag is on. `registerCustomSchemes({studioAssets, designMode})` registers the scheme with `LOCAL_CONTENT_PRIVILEGES`.
  - Main window CSP: adds `aiden-design:` to `frame-src` and `img-src` only. Framed content must stay sandboxed without `allow-same-origin` (Task 6).
  - `DESIGN_SCHEME` and `designUrl` live in `renderer/shared/design-canvas/url.ts` so the renderer can import them.
  - Navigation guards needed no change, because `externalUrl` already refuses `aiden-design:`.
- Open for review:
  - Workspace permission "none" does not block framing.
  - There is a residual parent-directory TOCTOU between realpath and the `O_NOFOLLOW` open.
  - The bridge has no nonce yet (spec P4).
  - The `main-window.html` CSP line will conflict with PR #682 (`aiden-attachment:` in `img-src`).
- Final review fixes (P2 Tasks 1–3):
  - `remove()` revokes grants and deletes the canvas a second time after `chatStore.remove`, so a save or grant that raced the delete is not left behind.
  - Managed worktree deletion, and the worktree-create rollback, call `designGrants.revokeRoot(folderPath)` through `WorkspaceWorktreeApplicationService` deps.
  - `designCanvas:grant` re-resolves the workspace root after issuing and revokes if it changed or disappeared.
  - `DesignCanvasStore` refuses a save, or throws on an `update`, when the compact JSON is larger than `maxDocumentBytes` (default 16 MiB, the read cap), so an oversized canvas never reads back as empty.
  - Deferred for Task 4: `getChat` parses the full transcript on every canvas IPC call; a metadata-only read belongs in `chat-store-core`.

## P2 Tasks 4–7 (2026-11-01)

- Task 4, sync and editing (`renderer/design/`):
  - `useDesignCanvas` (`use-design-canvas.ts`) is a custom sync engine, not TanStack Query: local edits save after 800 ms (flushed on unmount and through `registerLifecycleFlush` on quit); a CAS conflict refetches and replays the pending mutations once; a remote `designCanvas:updated` refetch clears undo.
  - `canvas-adapter-core.ts` maps frames to React Flow nodes and does placement and duplicate; `canvas-history-core.ts` keeps undo steps (applied as frame diffs, see review fixes); `canvas-keymap-core.ts` handles ⌘Z, ⇧⌘Z, ⌘D, Delete or Backspace, Escape, ↩ and ⇧2 (fit selection); duplicate and delete ignore key repeats.
  - Main: canvas get/save need an attended chat (no `botId`, no `owner`) but not design mode, so the unmount flush survives `/design off`. Reads use `chatStore.getMeta` (metadata only). A corrupt or oversized canvas file is quarantined, and deleting the chat removes the quarantined copies.
- Task 5, live set and snapshots: `live-set-core.ts` keeps at most 6 live iframes, only at zoom ≥ 0.25, with a 1.5× hysteresis bonus for frames still at least half on screen. `frame-snapshots.ts` stores per-frame snapshots keyed by file version; `designCanvas:capture` captures only the asking window's own page.
- Task 6, frames (`renderer/design/nodes/`): note, group, file, image and artifact nodes share `DesignNodeContext` (grant, versions, live set, remove). `FileFrame` loads `designUrl(grant, path)` in `sandbox="allow-scripts"` and shows "File not found" when no bridge `ready` arrives within 2 s. Double-click or ↩ enters a frame (tabindex 0); Escape with the canvas focused, or a pane click, leaves. The Add menu (Note, Group, File…, Image…) is an xyflow Panel; File…/Image… use `designCanvas:pickFile` (Open dialog, realpath inside the workspace). `main/services/design-canvas/watch.ts` watches framed folders while the grant lives and bumps a per-path `?v=n`. React Flow runs with `deleteKeyCode={null}`, `zoomOnDoubleClick={false}`, `elevateNodesOnSelect={false}`. Additive `renderer/canvas` changes: `CanvasNodeChrome` `flush`, `StudioCanvas` `resolveKey` and children.
- Task 7, E2E (window-opening, run only in the Linux Cua Space):
  - `tests/e2e/design-mode-helpers.ts` holds the helpers the design specs share (window and display width, appearance preview, `capture`, workspace chat setup, locators).
  - `tests/e2e/design-canvas.spec.ts`: note, group, two pages and an image through a stubbed Open dialog; positions and note text survive a reload; a disk edit reaches the live page within 2 s; enter and leave a frame; a deleted page shows "File not found"; ≤ 20 % zoom leaves no iframe. The test PNG is encoded in Node. Pages are brought live with Fit selection (click, ⇧2), because a fitted row of 1280 px pages sits below 25 % zoom and shows snapshots.
  - `tests/e2e/design-containment.spec.ts`: a probe page tries fetch, an image, a form post, `window.open`, `top.location` and a nested iframe; `webRequest.onBeforeRequest` records (and cancels) requests, and the test asserts nothing went to example.com or left `aiden-design:`, the window URL and window count are unchanged, and the page saw CSP violations.
  - Fixes the E2E found: `startDesignProtocol()` now runs before `createMainWindow` (a scheme handled only after the window loaded gave `ERR_UNKNOWN_URL_SCHEME` to the canvas's `<img>` frames); `placeFrame` puts an unpositioned frame 64 px right of the last ungrouped frame in view and steps past any overlap (spec line 255; before, every frame was centred and they stacked); the canvas wrapper is `data-typing-surface="canvas"`, which `isReservedTypingSurface` honours, so ⇧2 and H/V no longer type into the chat composer.
  - The P1 spec waits for the canvas region to stop moving before checking the toolbars (the sidebar transition made it flaky).
  - Screenshots: set `AIDEN_DESIGN_SCREENSHOTS` and run the specs with the runner's `--run` mode (normal mode does not pass env vars through), then copy the folder out of the Space.
- Review fixes (2026-11-01):
  - Undo and redo are rebasable frame diffs (`changesBetween` in `canvas-history-core.ts`), not whole-doc snapshots, so an undo never takes back frames another window added; a conflict merge clears history.
  - A save failure stops the save loop (the next edit retries) and shows a toast; a `designCanvas:updated` that lands while a save is pending or in flight is remembered and refetched once the save settles.
  - `↩` (or NumpadEnter) on a single selected page or artifact enters it, matching double-click.
  - The watcher reports only the changed page when the event names a watched page; an asset or an unnamed event still reports every page in that folder.
  - `designCanvas:capture` scales the page's CSS-pixel rect by `webContents.getZoomFactor()` before clamping to the content size (window points).
  - `docs/keyboard.md` now says `Esc` leaves only with the canvas focused; keys inside an entered page stay with the page (the bridge does not forward Esc).
- Deferred minors: store clamping can leave the saved doc differing from local until reload; a page framed at the workspace root does not see changes in subfolders; Escape inside a focused page does nothing until the person clicks the canvas. Watcher gaps: a framed folder that does not exist yet is never watched, recursive watching of a large folder is costly, and a slow `set` racing a `clear` relies on generations only. Up to 7 iframes can exist for about 1 s while one retires. A page whose CSP blocks the bridge, or a file over 8 MiB, shows a false "File not found".

## P4a toolbar, pages, rename (2026-11-05)

- Schema version 2 (`renderer/shared/design-canvas/schema.ts`): `DesignCanvasV1`/`parseDesignCanvasV1` renamed to `DesignCanvas`/`parseDesignCanvas`; `pages[]` (id, name, viewport), `activePageId`, `pageId` on frames and comments, `DESIGN_FIRST_PAGE_ID = "page-1"`, helpers `activeDesignPage`, `framesOnPage`, `withActiveViewport`. v1 reads as one "Page 1" with the old viewport. Test fixtures must carry `pageId`; the renderer trusts `designCanvas:get`, so a v1 fixture there crashes the canvas.
- Page edits in `renderer/shared/design-canvas/pages.ts` (pure, shared by the picker and Aiden's tools). `changesBetween` takes page names/order and the page on screen from an undo step but keeps each page's current viewport.
- UI: `design-toolbar.tsx` replaces `design-add-menu.tsx` (deleted); StudioCanvas `toolbar` prop (additive). Zoom stays bottom right: top right is under the Linux window controls (fixed, z-80, 52 px tall), which ate the clicks in E2E. `FrameTitle` (`nodes/frame-title.tsx`) via `CanvasNodeChrome titleSlot`; context `renaming`/`rename`. `FileFrame` takes `titleSlot` so its unit test needs no context. Keys: `N` note, `F2` rename. Built-in keys can carry `requiresCapability` (Design canvas section in ⌘/ and Settings).
- Tools: `pageOf` matches a page id or name (case-insensitive) and errors with the page list; groups must be on the same page; `canvas_focus` refuses frames on two pages and switches the page first.

## P4e comments and Send to Aiden (2026-11-05/06)

- Pure core `renderer/shared/design-canvas/comments.ts` (add/edit/delete, tray = `queued`, `markCommentsSent`, resolve/reopen, `anchorScore`/`locateAnchor`, `applyAnchorReport`, labels, `designCommentsBlock`/`describeComment`). Comment ids double as the `data-aiden-comment` value. Schema adds optional `queued`, `sentAt`, `resolvedAt` and anchor `rect`/`point` (page px); `sourcePath` is now a `file:line` stamp (`isSourceStamp`).
- Bridge v2: the canvas keeps the pointer and asks the page about points (`hover-at`, `pick-at`, `locate`, `highlight`); the page reports `picked`, `anchors` (byId or candidates the canvas scores), `scroll`. The fuzzy score runs in the renderer, not in the page. Parser: `renderer/shared/design-canvas/bridge-messages.ts`. Bridge tests run the real script in happy-dom with a stand-in parent (`new Function("window", source)`).
- UI: `renderer/design/design-comments.tsx` (hook + pins in a `ViewportPortal`, counter-scaled; box flips near edges), `comment-geometry.ts`, `design-comments-panel.tsx` (All comments), `design-comment-tray.tsx` + `comment-tray-store.ts` (module store the canvas publishes and the composer reads; crops in memory). Comment mode CSS sets `pointer-events: none` on node children so frames take the click whole.
- Composer: queued comments ride on any non-Steer send (empty text sends "Please make the change(s) in my design comment(s)."); `markSent` only after `sendComposerPayload` returns true. The mounted composer test stubs the tray store via globalThis but uses the real `designCommentAttachments`.
- Auto-resolve: the canvas records each comment's file version at send; a later `ready` with a newer version that still finds the element resolves it. Versions reset per app run, so after a restart sent comments resolve only by hand.
- Removing a frame removes its comments (`applyNodeChanges`); `changesBetween` diffs comments like frames.
- Marks come from a pen in the comment box (no separate D tool).

## P4b drawing tools (2026-11-06)

- New kinds `text`, `shape` (`rect`/`oval`, label in `text`), `connector` (`ends`, `arrow`), `stroke` (points as 0..1 fractions of its box, pen `handles`, `closed`) and `frame` (artboard). `group` and `frame` are containers (`isDesignContainer`); they don't nest. Caps: 1 000 frames, 400 per page, 2 000 stroke points.
- `renderer/shared/design-canvas/connectors.ts`: an end on a frame sits at the facing side's midpoint (or a named side) and keeps its last x/y, so it becomes a free end when the frame goes. `syncConnectors` runs in the parser, adapter, placement, pages edits and canvas tools; call it after any edit that moves frames.
- `drawing.ts`: drag boxes, 45° snap, RDP simplification, stroke box/path maths, `containerAt`/`regroupFrames` (drawn or dropped items join the artboard or group under their centre).
- Input: `renderer/design/design-drawing.tsx` listens in the capture phase on the canvas wrapper and stops the event so React Flow doesn't pan or select; drafts render in a `ViewportPortal`. Line kinds get `style.pointerEvents: "none"` (node `style` beats xyflow's wrapper) and an SVG hit band with `pointer-events: stroke`.
- Text is plain for now (`nodes/canvas-text.tsx`); P4c adds formatting. Colours: `DesignColor` palette, blue..pink map to `--chart-1..7`, fills via `color-mix`.
- After Delete, focus goes back to `.studio-canvas` (else ⌘Z lands on the body). Known: the ResizeObserver loop warning on node drag/resize is reported as an uncaught error (predates P4b).

## P4c rich notes (2026-11-06)

- Notes and text store a Markdown subset (`renderer/shared/design-canvas/rich-text.ts`): `**b**`, `*i*`, `<u>u</u>`, `[t](url)` (http/https/mailto only), `- ` / `1. ` lists, one paragraph per line. The serializer nests bold > italic > underline; the parser's star-run rules match it (randomized round-trip test guards this).
- Editor: `nodes/rich-text-editor.tsx` (contenteditable + execCommand; paste/drop plain text; re-seeds innerHTML only when the stored value differs from what it last emitted). `rich-text-dom.ts` reads the DOM back. View mode: `rich-text-view.tsx` (React elements, links open on ⌘/Ctrl-click).
- Format bar `nodes/format-bar.tsx` in an xyflow `NodeToolbar`; its menus/popover carry `data-design-format-bar` so the editor's blur into them keeps editing, and `onCloseAutoFocus` restores the editor selection.
- Gotchas: the app's command system listens on document capture, so ⌘K (palette) and ⌘B (sidebar) win even in editable fields. The editor takes ⌘B/I/U in a window capture listener and preventDefaults (the command system skips defaultPrevented). No ⌘K for links.
- Notes gained size (default small), color, fill (note colour via `designFillVar`); `CanvasNodeChrome` got a `tint` prop. Shape labels stay plain.

## PR #778 review fixes (2026-11-06)

- Pullfrog review on 022686e5e. Frame navigation: the window CSP already refuses https in frames (a self-navigation lands on ERR_BLOCKED_BY_CSP), but other aiden-design hosts, aiden-genui: and 'self' were open. `frame-navigation.ts` guards `will-frame-navigate` on the main window: a design frame stays on its own host. `will-frame-navigate` does not fire for about:blank (a dead end with no script, so harmless). E2E: design-containment "cannot navigate its own frame away".
- Saves: a second conflict in a row now keeps the edits on the newest canvas (status error, retried by the next edit). A closed canvas keeps trying unsaved edits at 2/5/15/30 s and stays registered with the lifecycle flush until saved or given up.
- Second round: canvas sessions report unsaved edits to the renderer close guard as a `design` source (dirty while unsent, saving while in flight). A closed session that stops retrying keeps its edits and its lifecycle flush until a flush saves them or the person discards at the quit/close/reload prompt. Main's prompt wording moved to `main/services/close-guard-prompt.ts` and names "the design canvas".
- The watcher's debounce test runs on a fake watch with mocked timers (the real-file version split one burst on a loaded CI runner).
- Agent `canvas_remove_frame` drops the frame's comments, through the shared `commentsWithoutFrames` (also used by the canvas adapter).

## P4d download, full window, Present (2026-11-06)

- `renderer/shared/design-canvas/frame-export.ts` (formats, file names, export width, PDF layout) and `presentation.ts` (row order). Frames carry `paper` / `printMode` (file and artifact only, `isDesignPrintable`).
- Export: `designCanvas:export` reads the frame from the store, so the renderer calls `useDesignCanvas().flush()` first (saves are debounced 800 ms). `frame-render.ts` draws in a hidden sandboxed window; PNG = window `zoomFactor: 2` + `capturePage(rect, {stayHidden: true})`. CDP `Page.captureScreenshot` hangs in a hidden window on Linux/xvfb; don't go back to it.
- Present / Open full window share `DesignPresentation` state; the wrapper becomes `fixed inset-0 z-[70]`, and `onMoveEnd` doesn't save while presenting. Fit each frame with `getViewportForBounds` + `setViewport`, not `fitView`: xyflow queues fitView until the next node update, so it could land after Exit and undo the restore.
- `StudioCanvas` top row uses `useTrailingWindowControlsClearance` (Linux Aiden-drawn window buttons, z-80, cover the canvas's top right otherwise).
- Open full window is a single-frame present view, not the browser panel (keeps the `aiden-design:` sandbox). Artboards don't export yet.

## P4f side panel (2026-11-06)

- `renderer/design/design-side-panel.tsx` (Properties / Layers / Code), toggled by `I` (keymap `{type:"panel"}`; ⌥⌘I is the menu's DevTools) or the PanelRight button; open state in localStorage `aiden.design.sidePanel`. Hidden while presenting.
- `layers-core.ts`: `designLayers`, `reorderLayer`, `stepLayer`. The canvas draws containers first, then the rest, each in document order, so reordering only swaps siblings (same parent, same container-ness).
- Frame fields `radius`, `guide` (`columns-4/8/12`, `grid-8`; `canDesignGuide`), `hidden`, `locked` (`true` only). Hidden: not drawn (members of a hidden container too), not presented, not live. Locked: `draggable/deletable: false`, `applyNodeChanges` skips it, duplicates drop it.
- `designCanvas:source(chatId, frameId)` returns a page file or artifact HTML, cut at 512 KiB (`DESIGN_SOURCE_MAX_BYTES`).
- `update(id, patch: DesignFramePatch, {record})` in the node context; the toolbar wraps (`flex-wrap`) instead of scrolling.

## P4g tweaks (2026-11-06)

- `renderer/shared/design-canvas/tweaks.ts`: controls from `<script type="application/aiden-tweaks">` (switch/choice/number/color, target `var` or `attr`), stored as `frame.tweaks` keyed by target name (only non-default values), `designTweakState` → `{dark, vars, attrs}`, `withDesignTweakQuery` adds `aiden-dark` / `aiden-tweaks` to the address.
- Bridge `set-tweaks` applies on `<html>` and restores originals for anything dropped; it also reads the query at script start (head), so first loads, reloads and exports never flash untweaked. `FileFrame` keeps the boot query fixed per address (derived state) and posts later changes, so a tweak never reloads the iframe.
- Artifacts: `readDesignArtifactTheme(dark)` builds the dark theme from the appearance config's dark variant; `HtmlArtifactIframe` got a `readTheme` prop. Export passes the theme (main uses it only when `frame.dark`).
- The panel reads source through `readSource` = `flush()` + `designCanvas:source`: main reads the stored canvas, and a just-added frame isn't saved for 800 ms.

## P4h page text editing (2026-11-06)

- Bridge: `edit-enable {on}` (posted while the frame is entered), `edit-command`, `edit-finish`; it sends `edit-start` / `edit-end {plain, changes, beforeHtml, afterHtml, element}`. Plain = same element, style, inline shape and text-run count. Chromium leaves `style=""` after select-all + typing, so an empty style counts as none.
- `renderer/shared/design-canvas/text-edit.ts` plans the file write (exactly once, whole text run, stamp narrows to 30 lines); `designCanvas:editText` writes it. `renderer/design/page-text-edits.ts` flushes first (main reads the stored canvas), keeps its own undo stack, and hands non-plain or unplaced edits to Aiden as a queued comment.
- The canvas `change` wrapper forgets the text undo stack only when a recorded change really alters the doc, on its first run (saves replay mutations). Otherwise xyflow's measurement changes wiped it.
- E2E: Playwright's `dblclick` misses inside the CSS-scaled iframe; use `dblclickInPage`. `getByText` resolves to an inner `<b>` after Bold, so locate by tag.

## P5 launch (2026-11-06)

- Kill switch: `designModeEnabled` = not `AIDEN_DESIGN_MODE` in 0/false/off/no. Studio-foundation's "flags off" E2E sets `AIDEN_DESIGN_MODE: "0"`; design specs no longer set any env.
- Analytics: `design_mode_entered {source}` and `design_mode_exited` from `chats:setDesignMode` (renderer passes the source as a 3rd arg; previous state read through the service's `assertCurrent`, so a no-op counts nothing), `design_mode_entered {source: "aiden"}` and `design_mode_declined` from `DesignModeConsent.answer`, `design_comments_sent {count_bucket}` from desktop `chat:start` via `reportDesignCommentsSent` (counts the block's JSON list with `attachedDesignCommentCount`).
- Onboarding: `designMode` tile in "Build in your workspace" (mint tint, `DesignModeArt` in create-art), hidden by `visibleOnboardingFeatures` when `designMode === false`.

## Watcher and picture follow-up (2026-11-12)

- `besidePage` returns null (nothing beside the page counts as unchanged) for a link whose target is a folder, so an unnamed event near a linked asset folder always reloads the page.
- `OwnWrite.fileClockOffset` (from the page's mtime/ctime right after the canvas writes it, 0 or less) shifts the neighbour time fence onto the files' clock; `wallNow` is injectable for tests.
- Each settled write schedules a timer that runs `forgetStaleNotes` at its window's end; `heldNotes(chatId)` reports how many notes are still held.
- `FrameSnapshotCache.stamp` hands out a global sequence; `set` keeps a picture only when its stamp is newer than the frame's last kept or forgotten one, so the latest-started capture wins.
- In RTL `waitFor` checks, never strict-assert a DOM element against null: the failure diff of a happy-dom element is slow enough to starve `waitFor`'s timers. Compare `=== null` to a boolean.


## Live pages while Aiden works (2026-11-12)

- Owner reported the canvas staying empty while Aiden edited `design/*.html` (the model never called `canvas_place_frame`, and the canvas tools only exist when the turn starts in design mode). Fix: `main/services/design-canvas/written-pages.ts`. llm-client's `tool_execution_end` passes each completed `write_file`/`edit_file` `producedFile` to `placeWrittenPage` (set when `designCanvasToolsAllowed({...designTurn, designMode: true})`), which re-reads `designMode` at each write, places a file frame once per path (any page) and sends `designCanvas:focus`. Codemode's nested calls emit their own events, so they count. `run_command` writes do not.
- `chatApplicationService.setDesignMode` calls `designPagesOnEntry` (wired in `chat-application-service-main.ts`) only on an off→on change with a workspace folder; it places `pagesWrittenInChat(chat.messages)` (saved timeline `producedFile`s, newest 12) on an empty canvas only, then broadcasts `designCanvas:focus` (the focus store keeps it until the canvas mounts). Never awaited by the switch.
- `canvas_place_frame` kind file adopts an existing Aiden, ungrouped frame of the same path, page and width (keeps its id, lock, tweaks) instead of adding a copy; the prompt section and `aiden-design` skill say pages land by themselves.
- Watcher: `set()` used to drop events queued under the old set (close cleared the debounce). A page landing while Aiden edits another page lost that edit (seen once in E2E). Now pending events for pages still watched carry over, and an async flush reports to the replacing watch for pages it still watches (`ChatWatch.paths`).
- Canvas focus waited the full 3 s because `getNodes()` on the controlled flow never carries `measured`; it now checks `getInternalNode(id).measured`.
- E2E: `tests/e2e/design-canvas.spec.ts` "pages Aiden writes land on the canvas by themselves…" (shots `1440-canvas-earlier-page`, `1440-canvas-live-pages`).
- Pullfrog round 1 on #820: a queued placement no longer drops on Stop (checks design mode and the workspace folder instead); `recentWrittenPages` (`design-canvas/main.ts`, memory only, 50 per chat, forgotten with the chat; entry places up to the 12 newest existing pages) lets mid-reply entry find pages the running reply wrote before its timeline is saved; adoption resize calls `syncConnectors` (the store's parser already synced it on save).
- Review follow-up on #820: ACP harness turns (Google Antigravity) now pass confined `onFileWrite` writes to `placeWrittenPage` and attach host-confirmed `producedFile` on completed `write_file`/`edit_file` timeline steps (with FIFO per-path queuing, symlinked root canonicalization, and diff-less creation promotion) so live placement and `pagesWrittenInChat` work on Antigravity too; `tool_execution_end` runs `placeWrittenPage` whenever `!denied && !event.isError` so a page committed right as Stop is clicked is still placed and noted; `placeWrittenPagesOnCanvas` re-checks `shouldSave` after file reads settle so deleting a chat or leaving design mode mid-flight never recreates the canvas; `useDesignCanvas` refetches if `designCanvas:updated` arrived while the initial `getDesignCanvas` (or an earlier refetch) was in flight; `DesignCanvas` waits for `.every(...)` visible targeted frame to be measured (ignoring hidden frames) before `fitView`; `canvas_place_frame` adoption preserves an adopted frame's resized `w`/`h` when grouping or moving without explicit dimensions; and `DesignFileWatcher.flush` re-checks `allowed` after its async own-write reads settle.

## Full agent control (2026-11-12, on the #820 branch)

- Page sizes: `defaultFileBox(designWidth)` in `schema.ts` (390 → 390×844, 768 → 576×768, 1280 → 640×436, 1440 → 720×486). `written-pages.ts` reads the first 16 KiB of each page (`readDesignWidthHint`: `O_NOFOLLOW` open + regular-file `fstat` on the resolved real path) and `inferDesignWidth` picks a width from `<meta name="aiden-design-width">`, a numeric viewport width, or agreeing `body`/`html`/`.phone`/`.device`/`.mobile`/`.screen` shell widths; otherwise 1280.
- `canvas_place_frame` kind file adopts an ungrouped, unlocked Aiden frame of the same path on the page whatever its width (same width preferred); a new width without w/h gets that width's default box (`boxForWidth`: default box → new default, custom → width scaled like the side panel's Width menu). `duplicate: true` always adds a frame (light/dark, phone/desktop variants). `canvas_update_frame` with `designWidth` resizes the same way.
- Any unlocked frame (person's too) can be moved, restyled, grouped, reordered, hidden, locked or moved to a page. `locked` refuses update (except `locked: false`), remove and arrange. Removing a person's frame needs `force: true` (`confirm` still accepted). `canvas_page` delete of a page with person or locked frames also needs `force`.
- Look fields on place/update (`stylePatch`): `dark`, `tweaks` (validated with `isDesignTweakTarget`/`isDesignTweakValue`, merged, `null` deletes), `fill` on artboards too (`"none"` clears on update), `radius`, `guide` (`"none"` clears), `paper`, `printMode`; update also `hidden`, `locked`, `page` (`moveFramesToPage`), `layer` front/back/forward/backward or `aboveFrameId`/`belowFrameId` (siblings only).
- Layer helpers moved to `renderer/shared/design-canvas/layers.ts` (re-exported by `renderer/design/layers-core.ts`), plus `bringLayerToFront`/`sendLayerToBack`; reordering now works on the frame's own page, not only the page on screen.
- `placeFrame` grows a `group` (not an artboard) right/down to hold a placed member with 32 px to spare (`growGroupToHold`); `fitGroupToMembers` fits a container around its members with `GROUP_PADDING` {32, 48, 32, 32}.
- `canvas_arrange`: row/column/grid (`layoutBoxes`, gap 64, rowGap 80, align, columns default √n, grid when > 4 frames), into a group (`groupId`) or out (`null`), arranges a group's members or every top-level frame when `frameIds` is left out (skipping locked ones), refits affected groups and `fitGroupIds`, switches page and focuses unless `focus: false`.
- `canvas_read` adds `outsideFrames` (every frame outside the view, within the shared `CANVAS_READ_FRAME_LIMIT` = 200, text cut to 120 chars) and `outsideOmitted`; summaries carry `locked`, `guide`, `radius`, `paper`, `printMode`.
- `canvas_focus` takes `page` (shows an empty page with `status: "shown"`).
- llm-client: held canvas tools exist whenever the turn could use the canvas, not only when `design_mode` is offered; `enteredCanvasTools.prepare` latches once design mode is on (card or the person's own switch mid-reply), adds the tools and a `design-mode` system section once, and codemode's `lateDeferredTools` gets them too. `createGenerativeUiExtensionRuntime({ designCanvas })` stops steering UI mockups/screens to `render_artifact` while canvas tools are offered.
