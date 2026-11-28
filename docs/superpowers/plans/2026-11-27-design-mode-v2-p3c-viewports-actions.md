# Design mode v2 — Phase 3c: viewports and actions — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Revision 3 (2026-11-27).** This revision applies review-p3c-plan-2 (2 blockers, 3 majors, 3 minors; 14 of round 1's 18 confirmed resolved). All 8 were checked against the code and accepted:
> - S101 now matches the `createFileRoute(` call site and replaces that one string token by its offsets. A probe of the 77 route examples shipped in `@tanstack/router-core` 1.170.18 shows the rule accepts every single-file example. The old identifier count would have refused 51 of them.
> - S89's cleanup follows what d3-drag 3.0.0 really listens for, and has a generation guard.
> - S96 reads and gates inside the lock, S95 checks the canvas before writing, paths are split into app-relative and workspace-relative, both store classes take the new options, and the Undo toast and narrow-header checks are fixed.

> **Revision 2 (2026-11-27).** This revision applies review-p3c-plan (Gemini 4 Neon high: 6 blockers, 7 majors, 5 minors). All 18 findings were checked against the code after merging 3b at `c354b32ba`, and every one held. Two are fixed by a different mechanism from the one the reviewer suggested, for the reasons given in "Applied review decisions" at the end. The TanStack copy is no longer a known gap: S101 rewrites its route literal or refuses.

> **Revision 1 (2026-11-27).** First draft, written against 3b's head `0a37450dd`.

**Goal:** The person can resize a live app frame's viewport and watch the page reflow, pick a device size, add a second view of the same page at another width, duplicate a page as a variant with ⌘D, and move a page's file to the system Trash with Undo. All of this is behind `AIDEN_EXPERIMENTAL_DESIGN_LIVE`.

- **Edge-drag reflow (§6.3.8).**
  - Dragging a frame's edge changes its `viewport` and keeps its scale, so the page reflows.
  - A readout shows the size live (`1180 × 800`). While a width edge is dragged, ticks mark the page's CSS breakpoints, which the bridge reads from same-origin `@media` rules.
  - Corner drags keep 3a's behaviour: the aspect stays and the scale changes (D15, S62).
- **Device menu (§6.3.8).** iPhone, iPad, Laptop and Desktop from 3b's `APP_DEVICES` (S85), plus Custom… for a typed width and height. It's also the keyboard path for resizing.
- **Add view at width (§6.3.8).** Places another frame of the same route at a device or custom width, beside the original, in its variant set.
- **Duplicate page as variant, ⌘D (§6.3.9).** Copies the route's file to `<name>-v2` (then `-v3`, and so on) as a main-side file operation with undo, for file routers: Next (app and pages), TanStack, Astro and React Router or Remix flat routes. TanStack's `createFileRoute` path is rewritten to the copy's own (S101). Anything it can't copy safely is refused, with **Ask Aiden** offered instead.
- **Move page file to Trash (§6.3.9).** Moves a route's single owning file to the OS Trash with `shell.trashItem`. Undo puts the file back. Routes not owned by a single page file are refused.
- **Remove from canvas** (v1's "Hide from canvas") takes the frame off the canvas only, as today.

With the flag off, the resizer, the header, the menus, ⌘D, the shortcut sheet and every IPC answer are byte-for-byte today's.

**Architecture:**
- **Pure rules (`renderer/shared/design-canvas/`).**
  - `app-frame.ts` gains `appEdgeResize` (an edge drag: new viewport and box, scale kept) and `withAppViewport` (S85's keep-scale viewport change, moved out of `canvas-tools.ts`).
  - `app-variants.ts` (new) holds `variantRootOf` and `placeAppVariant`, moved out of `canvas_place_frame`'s variant branch.
  - `app-bridge-messages.ts` gains the `breakpoints` message.
- **Bridge (`main/services/design-canvas/app-frames/app-bridge-source.ts`).** Reads breakpoints from same-origin style rules, within caps, at `ready`, on `load` and after each Vite update.
- **Route-file rules (`main/services/design-canvas/app-server/`).**
  - `app-page-files-core.ts` (new, pure): the route a frame names, which file owns it, the variant name, the candidate paths, the relative-import check, and the TanStack literal rewrite.
  - `app-page-files.ts` (new, disk): the bounded, no-follow owner walk (S78's rules), `readRegularFileBytes`, and `confinedTarget`, which checks or creates a target folder without following links.
- **Main file operations.**
  - `main/handlers/design-canvas.ts` gets three IPCs: `designCanvas:addAppView`, `designCanvas:appPageVariant` and `designCanvas:appPageTrash`.
  - `main/services/design-canvas/app-page-ledger.ts` (new) is a per-workspace, in-memory ledger. It reconciles the canvas undo and redo of both file operations after each save, and broadcasts what it did on `designCanvas:pageFile`.
  - `store.ts`: `update` gains `byPerson`, and `save` gains an internal `onCommitted`.
- **Renderer (`renderer/design/`).**
  - `AppNode` draws per-control resizers when the flag is on.
  - `canvas-adapter-core.ts`'s `applyNodeChanges` learns which control is dragged.
  - New `app-viewport-ruler.tsx` and `app-frame-menus.tsx` hold the readout and ticks, and the device and More menus.
  - ⌘D routes to the variant action for one selected app frame.
  - `StudioCanvas` ignores canvas keys while a menu, popover or dialog is open.

**Tech Stack:** Electron 43.8.4, React 19, `@xyflow/react` 12.11.6 (`NodeResizeControl`, `NodeToolbar`, `useViewport`), TypeScript, `tsx --test`, happy-dom, Playwright Electron in a Cua Space.

**Spec:** [`docs/superpowers/specs/2026-11-23-design-mode-live-app-design.md`](../specs/2026-11-23-design-mode-live-app-design.md): §6.3.8, §6.3.9, §8's 3c row, §6.10 and §11 (S1–S88).

**Stacking:** 3c stacks on 3b ([PR #966](https://github.com/sambitcreate/aiden-agent/pull/966)), which stacks on 3a ([PR #965](https://github.com/sambitcreate/aiden-agent/pull/965)) and the earlier phases. It depends on 3a (frames, aspect lock, menus) and 3b (`device`, `variantOf`, `label`, `removedAppRoutes`, route rules). This branch merged `origin/t3/design-mode-v2-p3b` at `c354b32ba`. Merge again when 3b moves. Never rebase.

## Scope

**In:**
- Edge drags that reflow, the live readout, breakpoint ticks and a polite announcement of the final size.
- The device menu with Custom….
- Add view at width.
- ⌘D and the More menu's **Duplicate page as variant** for file routers, with undo and redo.
- The More menu's **Move page file to Trash** for single-file pages, with Undo.
- The More menu's **Remove from canvas**.
- Canvas keys ignored while an overlay is open (S94), which also fixes ⌫ behind today's Download menu.
- One more `design_app_frame_added` call site for each new placement (S100).
- Docs, the shortcut sheet and `docs/keyboard.md`.

**Not in:**
- **⌥-drag clipping.** Changing the box without the viewport is deferred (S90).
- **Snapping to breakpoints** (open question 2).
- **Copying for config routers.** React Router's literal `app/routes.ts` and any non-file router get **Ask Aiden** instead (spec §6.3.9: "Aiden does it").
- **A new Aiden tool.** `canvas_read` and `canvas_place_frame` are unchanged in behaviour (S99).
- **Adopt** (Phase 5).
- **Native clients.** Phones don't draw app frames. Task 11 checks nothing shared changed.
- **Onboarding.** Nothing until Phase 7, because the flag stays experimental.

## Feature flag

Everything sits behind `designLiveEnabled()` (`main/services/studio/feature-flags.ts:37`) and, in the renderer, `useAppCapabilities().designLive` (used in `renderer/design/nodes/app-node.tsx`'s `AppFrame`).

With the flag off:
- `AppNode` renders today's single `DesignNodeResizer … keepAspectRatio`, with no device or More button, and the status row still shows the size;
- `applyNodeChanges` called without its new third argument behaves as today;
- ⌘D duplicates the selection (`canvas-keymap-core.ts:60`, `design-canvas.tsx`'s `case "duplicate"`);
- the shortcut sheet has no new row;
- the three new IPCs answer `{error: "unavailable"}`;
- the bridge sends no `breakpoints` message;
- no event is sent;
- `store.update` without `byPerson`, and `store.save` without `onCommitted`, behave as today.

The overlay guard in `StudioCanvas` (S94) applies with the flag off too, because it fixes an existing bug (⌫ pressed in the Download menu reaches the canvas). Its test runs flag-off.

## What exists today (checked against 3b's head `c354b32ba`)

Line numbers drift as 3a and 3b take review fixes. Task 0 rechecks them with `rg -n`, and named symbols win over numbers.

| Area | Fact | Evidence |
|---|---|---|
| Viewport limits | `APP_FRAME_LIMITS` minViewport 200, maxViewport 4000, minScale 0.05, maxScale 2 | `renderer/shared/design-canvas/app-frame.ts:50-58` |
| Box rule | `appFrameBox`: `w = round(width × scale)`, `h = round(height × scale) + 36` (S62) | `app-frame.ts:109-114` |
| Corner resize | `appResizeScale` keeps the aspect and fits with `fitAppScale` | `app-frame.ts:117-148` |
| Devices | `APP_DEVICES`: iPhone 390×844, iPad 768×1024, Laptop 1280×800, Desktop 1440×900; `deviceBucket` | `renderer/shared/design-canvas/app-devices.ts:7-26` |
| Resizer | `DesignNodeResizer` wraps `NodeResizer` with `design-resize-handle` and `design-resize-line`. The controls are pointer-only `<div>`s (no `tabIndex`), styled in `design-canvas.css:3-15` | `renderer/design/nodes/frame-parts.tsx:14-37`, `renderer/design/design-canvas.css` |
| d3-drag | `XYResizer` uses d3-drag 3.0.0, which listens for `mousedown.drag` on the control, then adds `mousemove.drag` and `mouseup.drag` **capture** listeners on `window` per gesture (`mouseupped` calls `noevent`, which stops immediate propagation), plus `touchstart`/`touchmove`/`touchend`/`touchcancel` on the control. It never listens for pointer events | `node_modules/d3-drag/src/drag.js:39-79`, `node_modules/@xyflow/system/dist/esm/index.mjs:1` |
| xyflow resize events | `XYResizer` calls `onResizeStart` on drag start. On end it returns early unless a resize happened (`resizeDetected`), and otherwise calls `onResizeEnd` **before** `onEnd`, which emits the final `{type: "dimensions", resizing: false}` change. `ResizeParams` is `{x, y, width, height}`, with no control name | `node_modules/@xyflow/system/dist/esm/index.mjs:3445-3605` |
| Adapter | `applyNodeChanges`: dimension changes with `resizing` set are applied, and the app branch sets the scale from `appResizeScale` and the box from `appFrameBox`. A frame is re-emitted only when its box differs | `renderer/design/canvas-adapter-core.ts:127-186` |
| App node | `<DesignNodeResizer selected minSize={designMinSize("app")} keepAspectRatio />`; the status row prints `${viewport.width} × ${viewport.height}`; the iframe is drawn at viewport width with `transform: scale(scale)`; its key `${origin}\|${token}` excludes the viewport, so a width change reflows in place; page state resets when `routeShown !== route`; `shownKey` names the mounted page | `renderer/design/nodes/app-node.tsx` (`AppNode`, `statusRow`, `routeShown`, `shownKey`) |
| One undo step per gesture | `onNodesChange` batches a drag or resize as one step and applies each change live | `renderer/design/design-canvas.tsx` (`onNodesChange`) |
| Flush first | Main-side frame actions call `await flush()` and refuse with a toast when it returns false | `design-canvas.tsx` (`download`, `readSource`, `makeTweaksDefault`, the Add ▸ Page from app placer) |
| Undo steps from main | A `designCanvas:updated` broadcast without `step` or `aidenTurn` is carried into every history entry, so it can't be undone | `renderer/design/use-design-canvas.ts` (announcement handling), `renderer/design/canvas-history-core.ts:56-72` |
| ⌘D | `{type: "duplicate"}` for ⌘D without ⇧ or repeat; `resolveKey` runs `duplicateFrames` on the selection | `renderer/design/canvas-keymap-core.ts:60`, `canvas-adapter-core.ts:207` |
| Keys on controls | `StudioCanvas.onKeyDown` lets Enter and Space on a pressable target through and skips editable targets. It never checks `hasOpenLayer()`, and React key events from portalled menus bubble to it | `renderer/canvas/studio-canvas.tsx:51-66`, `:110-136`; `renderer/lib/layer-stack.ts:90-95`; `docs/design-guide.md` ("To ask whether a dialog, menu or popover is open, use `hasOpenLayer`") |
| Menu focus | `DropdownMenuContent`'s `onCloseAutoFocus` keeps focus only when it is already inside `[role="dialog"], [role="alertdialog"]` | `renderer/components/ui.tsx:2005-2016` |
| Focus return | `returnFocus(candidates, options)` | `renderer/lib/focus-return.ts:41` |
| Frame actions | App frames have Dark (`aria-pressed`) and a Download `DropdownMenu` (PNG, PDF) | `renderer/design/nodes/frame-actions.tsx` |
| Node context | `enter`, `leave`, `update(id, patch, {record})`, `remove`, `download`, `comment`; `DesignFramePatch` has no `viewport` or `scale` | `renderer/design/nodes/design-node-context.ts` |
| Screen-space toolbars | `NodeToolbar` draws in screen pixels, outside the zoom transform | `renderer/design/nodes/format-bar.tsx:140-146` |
| Built-in keys | `canvas-duplicate`: ⌘D and Backspace, `requiresCapability: "designMode"`; the sheet filters on `capabilities[key.requiresCapability]` | `renderer/shared/built-in-keys.ts` (`canvas-duplicate`), `renderer/lib/shortcut-sheet.ts:130` |
| Capabilities | `CommandCapability = StudioFeature \| "designMode"`; `AppCapabilities.designLive` exists | `renderer/shared/keybindings.ts:8`, `renderer/lib/app-capabilities.tsx:37` |
| Keyboard doc | "`⌘D` duplicates the selection" | `docs/keyboard.md:102-103` |
| Trash | The only use is `trash: (folderPath) => shell.trashItem(folderPath)`, injected | `main/services/workspace-application-service-main.ts:54` |
| Notification channels | `INVOKE_PREFIXES` allows `designCanvas:` by prefix, but notifications need an exact entry in `NOTIFICATION_CHANNEL_VALUES`, checked by `ipc-contract.test.ts` against exported channel constants (as `DESIGN_FILES_CHANGED_CHANNEL`) | `renderer/preload-channels.ts:7-19`, `:137-155`; `main/handlers/ipc-contract.test.ts`; `main/services/design-canvas/watch.ts:51` |
| Person placement | `placeAppRoute`: `pickerChat` (which needs `live.apps.routes`), `stillFraming`, `store.update` with `beforeWrite`, a broadcast `step`, `sendFocus` with `own: true`, then `onAppFrameAdded(viewport.width)` | `main/handlers/design-canvas.ts` (`pickerChat`, `stillFraming`, `designCanvas:placeAppRoute`) |
| Workspace | Handlers get only `workspaceRoot(chat)`; nothing passes the workspace permission | `main/handlers/design-canvas.ts:330-331`, `design-canvas-main.ts` |
| Permission | `runnable()` refuses `none` and `read-only` | `main/services/design-canvas/app-server/app-server-main.ts` (`runnable`) |
| Framework | `DesignAppsSnapshot.candidates[]` and `.apps[]` carry `framework?: FrameworkId` | `renderer/shared/design-app.ts:6-18`, `:91`, `:115`, `:121` |
| Save, update and removed routes | `save(workspaceId, doc, baseRevision, {undone, undoneRoutes, beforeWrite, chatsLive})` checks the revision (`conflict` otherwise) and notes removals `byPerson`; the reply has no `doc`. `update(workspaceId, mutate, {beforeWrite})` has no revision check and notes no removal. The handlers use the `DesignChatCanvases` wrapper, whose own `save` and `update` forward options | `main/services/design-canvas/store.ts:144-229`, `:471-556` |
| Route keys | `appRouteKey = "<root>\u0000<route>"`; a route is noted removed only when no frame in the **workspace** doc shows it (`shownAppRoutes`); capped at 200 | `renderer/shared/design-canvas/schema.ts` (`removedAppRoutes`, `shownAppRoutes`, `withRemovedAppRoutes`) |
| Variant placement | `canvas_place_frame`'s variant branch | `main/services/design-canvas/canvas-tools.ts:1236-1345` |
| Viewport updates in the tool | The reuse branch merges the viewport with an explicit `p.scale` when given; the update rule keeps the scale; both refit groups | `canvas-tools.ts:1258-1272`, `:1857-1863` |
| Group refit | `refitGroups(doc, ids)` | `renderer/shared/design-canvas/placement.ts:135` |
| Bounded read | `readBounded(path, cap)` opens `O_NOFOLLOW \| O_NONBLOCK` but returns a UTF-8 string, and `null` for missing, irregular **and** over-cap files | `main/services/design-canvas/app-server/app-detect.ts:53-75` |
| File lock and digest | `withFileLock(file, task)`; `digest(text)` (SHA-256 of a string) | `main/handlers/design-canvas.ts:203`, `:399` |
| File watcher | `DesignFileWatcher` and `ownWrite` cover v1 `file`/`image` frames only, not app route files | `main/services/design-canvas/watch.ts`, `design-canvas.tsx` (watched paths) |
| Route walker | `CONVENTION_FOLDERS`, `confinedRoot`, `walk` (POSIX paths relative to the **app root**, `app-routes.ts:124`), `walkConvention`; `discoverRoutes` reads React Router's `app/routes.ts` and walks flat files only for `{flat: true}` | `main/services/design-canvas/app-server/app-routes.ts` (`discoverRoutes`) |
| Route rules | `routeFromFile` (one file, no siblings), `routesFromFiles` (drops a flat file with child routes as a layout), `scanTsTokens` (tokens carry no offsets; `null` past 50 000 tokens or when unterminated), `parseReactRouterConfig` (`{routes}` for a literal config, `{flat: true}` for `flatRoutes()`, `null` otherwise) | `main/services/design-canvas/app-server/app-routes-core.ts` |
| Route patterns | `isConcreteRoute` allows a query and a trailing `/` | `renderer/shared/design-canvas/app-routes.ts` (`isConcreteRoute`) |
| Toasts | Sonner's `action` is `{label, onClick}`, with no `disabled`; a toast is replaced by calling `toast(…, {id})` again | `node_modules/sonner/dist/index.d.ts:43-47`, `design-canvas.tsx` (the page delete's Undo toast) |
| TanStack examples | `@tanstack/react-router` 1.170.18 and `@tanstack/router-core` are installed; `router-core/skills/**/SKILL.md` hold 77 route-file code blocks | `node_modules/@tanstack/` |
| Ask Aiden handoff | `queueOnFrame(frameId, note)` | `renderer/design/design-comments.tsx` |
| Analytics | `design_app_frame_added {source, device_bucket}`, four call sites (S88) | `main/services/analytics/analytics-events.ts`, `docs/analytics.md`, `main/handlers/design-canvas-main.ts` (`onAppFrameAdded`) |
| Fixture | `tests/fixtures/design-live-routes/`: TanStack detected without the router plugin installed; `App.tsx` maps the path through `import.meta.glob("./routes/*.tsx")`, so `pricing-v2.tsx` is served at `/pricing-v2`; route files are plain default exports | `tests/fixtures/design-live-routes/src/App.tsx`, `src/routes/pricing.tsx` |
| CI Linux E2E | The `linux-e2e` apt line lists no glib package explicitly | `.github/workflows/ci.yml:966` |

## Decisions

All are **proposed**. They become spec amendments S89–S101 in Task 12. Each follows the spec unless it says otherwise.

### S89 — Edges reflow, corners scale (proposed)

- **Flag on.** `AppNode` renders eight `NodeResizeControl`s instead of one `NodeResizer`:
  - four corner **handles** with `keepAspectRatio`, which keep 3a's rule (the scale changes, the viewport stays);
  - four edge **lines** without it, which change the viewport and keep the scale.

  Each control has its own `side` closure, because `ResizeParams` names no control. Each uses the shared `design-resize-handle` and `design-resize-line` classes, so the hit areas look like today's.
- **Bounds the resizer knows.** Edge controls get `minWidth = max(minSize, round(200 × scale))`, `maxWidth = min(maxSize, round(4000 × scale))`, and the same for height plus the 36 px title row. So xyflow's own values never pass the clamp, and the left and top edges don't drift.
- **Telling the adapter.**
  - `onResizeStart` calls `context.resizeStart(id, side)`. That sets `resizeModes` (a ref map read synchronously by `onNodesChange`) and the React state `activeResize: {frameId, side} | null` (read by the ruler and live region).
  - It also bumps a monotonic `resizeGeneration` ref.
  - **A real drag** is cleared synchronously in `onNodesChange`, right after `applyNodeChanges` has handled that frame's `{type: "dimensions", resizing: false}` change. That change is the last thing xyflow sends (`onEnd` runs after `onResizeEnd`). `onResizeEnd` clears nothing.
  - **A press without a drag** gets no end from xyflow, because it returns early when `!resizeDetected`. `DesignCanvas` adds capture listeners on `window` **once, at mount**: `mouseup`, `touchend`, `touchcancel`, `pointerup`, `pointercancel` and `blur`. Registered before any gesture, they run ahead of d3-drag's per-gesture `mouseup.drag` capture listener, whose `noevent` stops later listeners on the same target. When `resizeModes` isn't empty, a listener records the current generation and schedules a `setTimeout(0)`. The timeout clears the modes and `activeResize` only if the generation is unchanged, and the timer is cancelled on unmount. After a real drag, the synchronous clear has already run, so the timeout finds nothing to do.
- **The edge rule** (`appEdgeResize`):
  - `left`/`right`: `viewport.width = clamp(round(w / scale))`.
  - `top`/`bottom`: `viewport.height = clamp(round((h − 36) / scale))`.
  - The clamp is 200–4000 and `maxSize`. The box is then recomputed with `appFrameBox` (S62's fixed point).
  - `left`/`top` keep the opposite edge fixed: `x = x₀ + w₀ − w`.
- **Batches.** xyflow sends a left or top drag as `[position, dimensions]` in one batch. The adapter applies `appEdgeResize` once per frame per batch, from the frame as it was before the batch, and its `x`/`y` overwrite any position change in that batch. The final `resizing: false` change goes through the same rule, which is idempotent for clamped values. A frame is re-emitted when its box **or** its viewport changed, because at small scales a one-pixel viewport change can round to the same box.
- **Live.** Each move applies through `onNodesChange`, so the iframe gets the new width and reflows without a remount.
- **One undo step** per drag, with the existing `gesture` batching.
- **Entered frames.** Starting a resize on an entered frame leaves it first (3a's `leave`).
- **Keyboard.** The resize controls stay pointer-only, as today. The keyboard path is the device menu and Custom… (S92), and every button, menu item and popover control there has a visible `focus-visible` ring.

### S90 — ⌥-drag clipping is deferred (proposed)

§6.3.8 asks for ⌥-drag to change the box only, clipping without reflow. That conflicts with S62: the parser recomputes the box from the viewport and the scale, so a clipped box can't be stored. §8's 3c row doesn't list it. A later phase can add a stored clip box if wanted (open question 1). ⌥ during a resize behaves as without it.

### S91 — Breakpoint ticks and the readout (proposed)

- **The bridge message.** `{type: "breakpoints", widths: number[]}`, where `[]` clears the ticks.
- **The walk.**
  - The bridge walks `document.styleSheets`, skipping any sheet whose `cssRules` throws (cross-origin).
  - It recurses into `CSSMediaRule`, `CSSSupportsRule`, `CSSLayerBlockRule`, `CSSScopeRule` and `CSSImportRule` (the imported sheet, plus the import's own media list). A `WeakSet` of visited sheets prevents cycles.
  - It skips `CSSContainerRule`, because container queries aren't the viewport.
  - **Caps:** 64 sheets, 4 000 rules visited, depth 8, and `mediaText` up to 1 024 characters (longer is skipped).
  - It sends at `ready`, on `load` and after each `vite:afterUpdate`, only when the list changed.
- **Which conditions count.** Only `width`, `min-width` and `max-width` in `px`, `em` or `rem`. `em` and `rem` are × 16, the initial font size that media queries use, not the root element's. `breakpointsOf(mediaText)` is a small tokenizer over the bounded text, with no regex over page text. Each comparison with `width` gives a tick where the layout changes:

  | Condition | Tick |
  |---|---|
  | `min-width: N`, `width >= N`, `N <= width` | `ceil(N)` |
  | `max-width: N`, `width <= N`, `N >= width` | `floor(N) + 1` |
  | `width > N`, `N < width` | `floor(N) + 1` |
  | `width < N`, `N > width` | `ceil(N)` |

  A chained range, `A op width op B` (for example `(640px <= width < 1024px)`), gives one tick for each side. Other features (`orientation`, `height`) are ignored, and each width part of an `and`/`or` list still counts. So `768px` and `767.98px` both tick at 768.
- **Before posting,** the bridge keeps ticks in 200–4000, dedupes, sorts and keeps the first 24.
- **Validation** (`parseAppBridgeMessage`): an array of 0–24 integers in 1–8000, strictly ascending, or the message is dropped. Display-only (S11): a tick never changes a stored value.
- **State.** `AppNode` keeps `{key: shownKey, widths}` in React state. It's reset when the route changes or the iframe remounts, as page state is today, and ignored when its key isn't the current `shownKey`.
- **Drawing.** While a width edge is dragged, a `NodeToolbar` (screen space) shows:
  - the readout `1180 × 800` in tabular numerals;
  - one tick per breakpoint at `breakpoint × scale × zoom` screen px from the fixed edge (from the left for a `right` drag, from the right for a `left` drag), with `zoom` from `useViewport()`.

  A tick label is hidden when it's closer than 40 screen px to the previous one. The track may extend past the box, and ticks there stay visible. A height or corner drag shows the readout only. Styles live in `renderer/design/design-canvas.css` with existing tokens, and there are no new tokens.
- **Announcement.** A polite live region, mounted in `AppNode` outside the ruler, says "Viewport 1180 by 800" when `activeResize` clears. Nothing is announced during the drag.
- **No snapping** (open question 2).

### S92 — The device menu (proposed)

- **The control.** With the flag on, a header button **replaces** the status row's static size text. It shows the matching device label, or `1180 × 800`. Its `aria-label` is always "Viewport, 1180 by 800" (or the device). It opens a `DropdownMenu` with a `DropdownMenuRadioGroup` of the four presets, plus **Custom…**.
  - A preset is checked when the viewport equals it exactly.
- **Narrow frames.** On a frame under 240 screen px wide, the button shows an icon only. The action buttons are `shrink-0`, and the title and label truncate, so every button stays reachable at iPhone width and scale 0.25.
- **Custom….**
  - Choosing it sets an `opening` ref, so the menu's `onCloseAutoFocus` calls `preventDefault()`.
  - A `Popover` anchored to the button then opens with `role="dialog"` and focus in Width.
  - It has two number fields, Width and Height (whole numbers, 200–4000), filled with the current viewport, and Apply and Cancel. A field out of range shows `200–4000` as help text and disables Apply.
  - On close, focus goes back with `returnFocus([trigger])`.
- **The change.** `context.setViewport(id, viewport)` applies `withAppViewport` (S85's keep-scale rule: `fitAppScale`, then `appFrameBox`), then `refitGroups` for the frame's group, through the canvas's local `change()`, as one undo step.
- **Shared rule.** `canvas-tools.ts` calls `withAppViewport` too:
  - In the reuse branch, the caller passes `{...adopted, scale: given(p.scale) ? appScale(p.scale) : adopted.scale}`, so an explicit scale still wins.
  - In the update rule, it passes the frame as is.
  - Their outputs must not change, as the existing canvas-tools tests show.
- **No analytics.**

### S93 — Add view at width (proposed)

- **Where.** A **More** (`…`) button in the app frame's header opens:
  - **Add view at width** ▸ iPhone, iPad, Laptop, Desktop, Custom…;
  - **Duplicate page as variant** (`⌘D`);
  - **Move page file to Trash…**;
  - **Remove from canvas** (`⌫`).
- **The renderer** calls `await flush()` first and refuses with today's unsaved-changes toast when that fails.
- **The IPC.** `designCanvas:addAppView(chatId, {frameId, device?, width?, height?})`.
  - Its gate is `liveChat` (the flag, `requireChat`, `canFrame`), a new helper that `pickerChat` is rebuilt on. It doesn't need `live.apps.routes`.
  - Then `stillFraming` in `beforeWrite`, `store.update`, a broadcast step `add-app-view:<revision>`, `sendFocus` with `own: true`, and then `onAppFrameAdded(viewport.width)`.
- **Placement.** `placeAppVariant` places:
  - the same app root and route;
  - the device's viewport (or the typed size) at the original's scale, fitted to `maxSize`;
  - the label `iPhone`, `iPad`, `Laptop`, `Desktop` or `<width> px`;
  - `createdBy: "person"`;
  - `variantOf` set to `variantRootOf(original)`'s id, beside the set's right edge, in its group, or in a new group made around both.
- **Refusals.** `not-found`, `locked`, `full` and `bad-size`. Each shows a toast, and the menu closes.
- **Duplicates allowed.** The same width twice gives two frames.

### S94 — ⌘D, and no canvas keys behind an overlay (proposed)

- **Flag on, with exactly one app frame selected:** ⌘D runs **Duplicate page as variant**. Otherwise it runs today's `duplicateFrames`. This is a renderer-only branch in `resolveKey`'s `duplicate` case.
- **Overlays.** `StudioCanvas.onKeyDown` returns without resolving any canvas key while `hasOpenLayer(isOverlayLayer)` is true, as `docs/design-guide.md` prescribes. So ⌘D, ⌫ and the rest do nothing while a frame menu, a popover, the Trash confirmation or a dialog is open. Editable targets and entered frames are skipped as today.
- **The shortcut sheet** gains `canvas-duplicate-page`: "Duplicate a live page as a variant", ⌘D, "With one live app frame selected, copies its page file as name-v2.", `requiresCapability: "designLive"`. `CommandCapability` gains `"designLive"`. `docs/keyboard.md` gets the same line.

### S95 — Which pages can be copied, and the copy's name (proposed)

- **The route a frame names.** `pagePath(route)` drops the query and a trailing `/` (except for `/`), and ownership and naming use that path. A query is carried over to the variant frame's route (`/pricing?plan=pro` → `/pricing-v2?plan=pro`).
- **Framework.** It comes from the app's entry in `live.apps.snapshot(workspaceId)` (`candidates[]` or `apps[]`, `framework?: FrameworkId`). With no framework, the answer is `config-router`.
- **The owner walk.** `routeFiles(workspaceRoot, appRoot, framework)` reuses 3b's confined, no-follow walker and caps (S78). It never runs code. It returns `{files: Map<pattern, OwnerFile[]>, layouts: Set<pattern>, truncated, configRouter}`, where `OwnerFile = {appRelPath, convention}`.
  - **Two kinds of path.** `appRelPath` is relative to the app root, as 3b's walker gives it. It's what `routeFromFile`, `variantPathCandidates` and `tanstackRouteId` take. `workspaceRelPath(appRoot, appRelPath)` gives `appRelPath` for `.`, else `${appRoot}/${appRelPath}`. That's what `confinedTarget`, ledger records and every file name shown to the person use. In a monorepo with `appRoot: "apps/web"`, a copy of `src/routes/pricing.tsx` goes to `apps/web/src/routes/pricing-v2.tsx`.
  - **React Router**, mirroring `discoverRoutes`: when `app/routes.ts` exists, flat routes are walked only if it reads as `{flat: true}`. A literal `{routes}` config, `null` or a refused read gives `configRouter: true`.
  - **Layouts.** A flat file that `routesFromFiles` would drop as a layout (it has child routes) is listed under `layouts`, never as an owner.
- **Matching.** Equality with a static pattern first. When only a dynamic pattern matches, the answer is `dynamic`. When the matching file is a layout, the answer is `layout`.
- **Refusals.** Each maps to a toast with **Ask Aiden**. The last two columns say whether it applies to ⌘D and to Trash:

  | Kind | When | ⌘D | Trash |
  |---|---|---|---|
  | `config-router` | React Router with a literal or unreadable `app/routes.ts`, or a framework with no file convention | ✓ | ✓ |
  | `dynamic` | the route comes from a dynamic segment (`[slug]`, `$slug`), so the file serves more than this page | ✓ | ✓ |
  | `layout` | the file is also its children's layout (TanStack `blog.tsx` beside `blog.$slug.tsx`) | ✓ | ✓ |
  | `no-file` | no file owns the route | ✓ | ✓ |
  | `several-files` | more than one file owns it | ✓ | ✓ |
  | `special-files` | the copy goes to a **sibling** Next `app/` folder (candidate 3), and the source folder holds `layout`, `template`, `loading`, `error` or `not-found`, which the copy would lose | ✓ | — |
  | `relative-imports` | a relative import would resolve to a different file from the copy's folder | ✓ | — |
  | `route-literal` | a TanStack file whose `createFileRoute`/`createLazyFileRoute` path can't be rewritten exactly (S101) | ✓ | — |
  | `too-many` | `-v2` to `-v9` are all taken | ✓ | — |
  | `too-large` | the file is over 512 KiB (`DESIGN_SOURCE_MAX_BYTES`) | ✓ | ✓ |
  | `not-regular` | the owner is a link, a FIFO or not a file | ✓ | ✓ |
  | `truncated` | the walk hit a cap, so ownership can't be proven | ✓ | ✓ |
  | `read-only` | the workspace permission is `none` or `read-only` | ✓ | ✓ |

  A child-folder copy (candidate 4, `app/page.tsx` → `app/index-v2/page.tsx`) inherits `app/layout.tsx`, so it isn't refused for special files.
- **The name.**
  - The base drops a trailing `-v[2-9]` from the last segment of the path, so a copy of `/pricing-v2` is `/pricing-v3`.
  - `/` becomes `/index-vN`.
  - For each N from 2 to 9, skip it if another file's pattern already is the route. Otherwise try the confined `wx` write (below), and treat `EEXIST` as taken and move to N+1. This covers a case-insensitive APFS clash (`Pricing-v2.tsx`) and a concurrent ⌘D without a separate existence check. All taken gives `too-many`.
- **Candidate paths.** These are tried in order, and the first whose `routeFromFile` equals the wanted path wins:
  1. **The stem with the suffix:** `pricing.tsx` → `pricing-v2.tsx`, and `index.astro` → `index-v2.astro`.
  2. **The token before a trailing `index` or `route`:** TanStack `blog.index.tsx` → `blog-v2.index.tsx`.
  3. **The folder renamed:** `app/pricing/page.tsx` → `app/pricing-v2/page.tsx`, and `src/routes/pricing/route.tsx` → `src/routes/pricing-v2/route.tsx`.
  4. **A child `index-vN` folder:** Next `app/page.tsx` → `app/index-v2/page.tsx`.

  Only the owning file is copied.
- **The relative-import check** (`relativeImportsMoved`).
  - It returns `false` at once when the folder doesn't change.
  - Otherwise it fails closed (`true`) when `scanTsTokens` returns `null`.
  - It resolves every relative specifier in `import "…"` (side effect), `import … from "…"`, `export … from "…"`, `import("…")` and `require("…")` against both folders. For `.astro`, only the `---` frontmatter is read.
  - If any resolves differently, the copy refuses with `relative-imports`.
- **The bytes.**
  - `readRegularFileBytes(path, cap)` opens `O_RDONLY | O_NOFOLLOW | O_NONBLOCK` and stats the open handle (`isFile()`, `mode & 0o777`). It returns `{bytes: Buffer, mode}`, or `too-large`, `not-regular`, `missing` or `io`.
  - The copy is the same bytes, except for S101's TanStack literal.
- **The write** (`confinedTarget(workspaceReal, workspaceRelPath, {create})`):
  - It `lstat`s every segment from the workspace realpath, refusing a link or a non-folder, and checks `isPathInside(workspaceReal, realpath(parent))`.
  - For a new folder (candidates 3 and 4), it creates only that one child with a non-recursive `mkdir`, after the parent passed.
  - Then it writes `writeFile(target, bytes, {flag: "wx", mode})` under `withFileLock(target)`. If the write fails, a folder it just created is removed when empty.
- **Check the canvas before touching disk.** Before any file is written, main runs `placeAppVariant` as a dry run on `store.get`'s document, with a placeholder route. `locked`, `locked-group`, `page-full` and `canvas-full` refuse there (as `locked` or `full`), and nothing is written.
- **Placement.** The variant route, beside the variant set with `placeAppVariant`, labelled `vN`, with `createdBy: "person"`.
  - `store.update` re-runs `placeAppVariant` on the latest document and `stillFraming` in `beforeWrite`.
  - A broadcast step `app-page-variant:<revision>`, `sendFocus` with `own: true`, then `onAppFrameAdded`.
- **Rollback.** If the update refuses or fails after the file was written (a lock or a full page that appeared meanwhile, design mode turned off, or a write error):
  - under `withFileLock`, main re-reads the copy;
  - only if its digest still equals the written bytes is it moved to the Trash, and a folder `confinedTarget` created is then removed if empty;
  - a copy changed in the meantime is kept, and the reply says so;
  - the reply is the real reason (`locked`, `full`, `unavailable` or `io`), not always `io`.
- **No file watcher.** `watcher.ownWrite` is for v1 file frames. App route files update through the dev server's HMR, so nothing is announced to the watcher.

### S96 — Move page file to Trash (proposed)

- **The menu item** reads **Move page file to Trash…**.
  - Choosing it sets the `opening` ref (as S92 does) and opens a popover with `role="alertdialog"`, with focus on **Cancel**.
  - The popover names the file (`src/routes/pricing.tsx`) and says "You can undo this.", with **Move to Trash** and **Cancel**.
  - Cancel or Escape returns focus to the More button with `returnFocus`.
  - This follows the design guide's destructive-but-restorable rule: no modal dialog.
- **Allowed** only when S95's walk gives one page file, using the Trash column of S95's table.
- **The renderer** calls `await flush()` first, then dims every frame of that route at once (optimistic, through a `trashing` set in the node context).
- **Main:**
  1. Run the gates (S99).
  2. Resolve the owner with the walk, to fail fast on S95's refusals. Nothing is read or kept yet.
  3. Call `store.update(workspaceId, mutate, {byPerson: true, beforeWrite})` (the `DesignChatCanvases` wrapper's, which forwards `byPerson`). It has no revision check, so it can't hit a save conflict. `byPerson` is a new option: `withRemovedAppRoutes(…, byPerson)`, which defaults to `false`, so existing callers are unchanged.
     - `mutate` removes every app frame of that root and route in the **whole workspace document**, because `shownAppRoutes` is workspace-wide. It throws `locked` when any of them is locked.
     - `beforeWrite` takes `withFileLock(workspaceRelPath)` and, inside it:
       - re-runs `stillFraming`;
       - re-reads `workspaceAccess` (still writable, and the same workspace realpath);
       - re-runs `confinedTarget`;
       - reads the bytes with `readRegularFileBytes`, so the bytes kept for undo are the ones trashed. `too-large`, `not-regular` or `io` throws, and nothing is written.
       - Then it calls `trash(absolute)`. If `trash` throws, nothing is written and the reply is `io`.
     - If the canvas write throws after a successful trash, the kept bytes are written back with `wx` and the reply is `io`. If that also fails, the reply is `io` with `restore: "failed"`, and the toast says the file is in the Trash.
  4. Broadcast step `app-page-trash:<revision>`, record the ledger entry, and reply `{trashed, route, removed, revision}`.
- **The renderer** puts the frames back on failure, with a toast naming the reason. On success it moves focus to the canvas region with `returnFocus`, so ⌘Z works at once. The success toast, with its **Undo** action, is shown only once the canvas has applied `revision`. Sonner's action has no `disabled` state, so the toast is deferred rather than disabled, and its Undo always undoes the Trash step, never the step before it. The deferral is usually a few milliseconds. If the revision isn't applied within 5 s, a toast without Undo says ⌘Z undoes it.
- **Undo** brings the frames back, and the ledger (S97) restores the file with `wx`. If something exists at the path, nothing is overwritten and a toast says so.
- **Redo** removes the frames again but **doesn't** trash the file again. A save can't tell a redo from the person removing a frame, and the ledger never deletes on a signal it can't read (open question 4).
- **The Trash keeps its copy** after Undo, because Electron has no restore-from-Trash API. That's documented.

### S97 — The page-file ledger (proposed)

`app-page-ledger.ts` keeps, per workspace and in memory, at most 16 records, newest kept (the `TWEAK_UNDO_LIMIT` precedent). Each record holds `chatId`, `workspaceId`, `workspaceRoot` (the realpath when recorded), `appRoot`, `route`, `file` (workspace-relative, `workspaceRelPath`), `bytes: Buffer`, `mode` and `digest` (SHA-256 of the bytes):
- a **copy record** adds `frameId` and `state: "present" | "trashed"`;
- a **trash record** adds `frameIds` and `state: "trashed" | "restored"`.

**One record per file.** Recording a file drops any older record of that workspace for the same `file`. So E2E case E's copy and a later Trash of the same page never both act.

**Reconciling.**
- `designCanvas:save` passes `onCommitted(doc)` to the `DesignChatCanvases` wrapper's `save`, which forwards it to `DesignCanvasStore.save`. This is a new, internal option. It's called synchronously on the workspace chain with the exact document written, and only after the write. It's wrapped in `try/catch`, so a throw can't fail or delay the save. The IPC reply is unchanged.
- The handler then queues `ledger.reconcile(workspaceId, chatId, committedDoc, undoneRoutes)` on a per-workspace queue. It's never awaited by the reply, and it pairs that save's `undoneRoutes` with that save's document.

| Record | Signal in the committed doc | Action | Then |
|---|---|---|---|
| copy, present | frame gone **and** its route key in this save's `undoneRoutes` (an undo of the placement) | trash the copy if its digest is unchanged | `trashed`; a changed digest drops the record, keeps the file and shows a `changed` toast |
| copy, present | frame gone without that key (the person removed it) | none | drop the record, keep the file |
| copy, trashed | frame back (a redo) | write the bytes with `wx` | `present`; `exists` drops the record and shows a toast |
| trash, trashed | any of `frameIds` back (an undo) | write the bytes with `wx` | `restored`; `exists` drops the record and shows a toast |
| trash, restored | frames gone again | none | drop the record (S96's redo rule) |

An `io` failure drops the record and shows its toast, so a retry never acts on a file the ledger has lost track of.

- **Gates inside the lock.** Each action runs under `withFileLock` for the file. Right before `trash` or the write, it calls the injected `canAct(chatId, workspaceId, workspaceRoot)`. That checks `canFrame`, that the chat's workspace folder still has that realpath, and the permission (S99). It also re-runs `confinedTarget`. `designCanvas:save` doesn't require design mode, so this is what stops a save after leaving design mode from touching files. A refused gate drops the record and does nothing.
- **Outcomes.** `DESIGN_PAGE_FILE_CHANNEL = "designCanvas:pageFile"` is exported from `main/handlers/design-canvas.ts` and added to `NOTIFICATION_CHANNEL_VALUES`. Outcomes are broadcast (like `designCanvas:updated`) as `{chatId, done | failed, reason?, file}`, and each window shows only its own chat's.
- **Never deletes on an ambiguous signal.** A missing record, a different workspace, a refused gate, or a quit (the records and the canvas undo history are both memory-only) means nothing happens.

### S98 — "Hide from canvas" is Remove from canvas (proposed)

§6.3.9's "Hide from canvas" is v1's canvas-only removal. 3c offers it in the More menu as **Remove from canvas**, the existing `remove` (⌫).

### S99 — Gates (proposed)

- **Every 3c IPC needs** the flag and an attended chat in design mode (`liveChat`, then `stillFraming` in `beforeWrite`).
- **The two file operations and the ledger** also need:
  - a workspace folder;
  - a workspace permission other than `none` or `read-only`, from a new dependency, `workspaceAccess(chat): Promise<{root: string; permission: WorkspacePermission | "read-only"} | null>`, wired in `design-canvas-main.ts` from `configStore.getWorkspace(...)`.
- **Otherwise** the IPC answers `unavailable`, or `read-only` for the permission.
- **Scope.** 3c is desktop-only. No new Aiden tool is added.

### S100 — Analytics (proposed)

No new event, so the registry is unchanged. `design_app_frame_added {source: "person", device_bucket}` gains call sites 5 (Add view at width) and 6 (Duplicate page as variant), each sent after the store commit. Device changes, edge drags and Trash send nothing. The `docs/analytics.md` row lists the new sources.

### S101 — TanStack copies rewrite their route literal, or refuse (proposed)

A TanStack route file names its own path in `createFileRoute("/pricing")` (or `createLazyFileRoute`). An unchanged copy would claim `/pricing` without the router plugin. With the plugin, the plugin would rewrite the copy as soon as it lands, which would change its digest and turn ⌘D → ⌘Z into a `changed` refusal. So for `tanstack-router` and `tanstack-start` copies:
- **The expected literal.** `tanstackRouteId(appRelPath)` gives the path the generator writes for the source file:
  - the path under `src/routes/` without its extension;
  - `.` and `/` split into tokens, with a trailing `route` or `lazy` token dropped;
  - a trailing `index` gives the parent path plus `/` (`/` at the root), and anything else gives `/` plus the tokens joined with `/`.

  The same function on the copy's path gives the new literal (`/pricing` → `/pricing-v2`, `/blog/` → `/blog-v2/`, `/` → `/index-v2`).
- **The edit targets the call site.** `scanTsTokens(text, maxTokens, {offsets: true})` gives each string token its `start` and `end` in the text. This is a new option, and the default output is unchanged.
  - The bytes must decode as UTF-8 and re-encode to the same bytes, and the scan must succeed.
  - A **call site** is an `id` token `createFileRoute` or `createLazyFileRoute` followed by `(`. Imports (`import { createFileRoute } from …`), types and other mentions aren't call sites, and neither are strings elsewhere (`<Link to="/pricing">`, `href`).
  - An aliased import (`createFileRoute as …` or `createLazyFileRoute as …`) refuses, because its calls can't be seen by name.
  - There must be at most one call site. Its tokens must be `(`, one `str` equal to the expected literal, then `)` (usually followed by the options call's `(`). The raw text from `start` to `end` must be the value in `'` or `"` quotes, with no backslash, so the decoded value is the raw text.
  - Exactly that token span is replaced with the new literal in the same quotes. Every other byte stays.
- **No call** (a plain default export, as in the fixture) means a byte-identical copy.
- **Anything else** (a second call site, an aliased import, a template literal or any non-string argument, a different path, or invalid UTF-8) refuses with `route-literal` and **Ask Aiden**, and nothing is written.
- **The ledger's bytes and digest** are the rewritten bytes, so the plugin finds nothing to change and ⌘Z trashes the copy cleanly.
- **Checked against real examples.** Scanning the 77 route-file code blocks in `node_modules/@tanstack/router-core/skills/**/SKILL.md` (1.170.18) with the real `scanTsTokens`:
  - 51 blocks have more than one `createFileRoute` identifier, usually the import, so the round-1 identifier rule would have refused them;
  - 70 have exactly one call site with one string literal;
  - the 7 with two call sites are WRONG/CORRECT comparison snippets, not files;
  - 2 repeat the route literal elsewhere in the text, which the round-1 text-uniqueness rule would have refused.

  Task 7's rows include a full file with its import, a `<Link to>` to its own path, and one of these doc examples, copied as a fixture.

Next, Astro and React Router or Remix flat routes carry no path literal, so their copies are byte-identical.

## Interfaces

```ts
// renderer/shared/design-canvas/app-frame.ts
export type AppResizeSide = "left" | "right" | "top" | "bottom";
export type AppResizeMode = "corner" | AppResizeSide;
export function appEdgeResize(
  frame: { x: number; y: number; w: number; h: number; viewport?: { width: number; height: number }; scale?: number },
  side: AppResizeSide,
  drag: { x?: number; y?: number; w?: number; h?: number },
  maxSize: number,
): { x: number; y: number; w: number; h: number; viewport: { width: number; height: number } };
export function appEdgeBounds(scale: number, minSize: number, maxSize: number):
  { minWidth: number; maxWidth: number; minHeight: number; maxHeight: number };
export function withAppViewport(
  frame: { viewport?: { width: number; height: number }; scale?: number },
  viewport: { width: number; height: number },
  maxSize: number,
): { viewport: { width: number; height: number }; scale: number; w: number; h: number };

// renderer/shared/design-canvas/app-variants.ts
export type AppVariantInput = {
  id: string; groupId: string; title: string; route: string;
  viewport: { width: number; height: number }; scale: number;
  label?: string; createdBy: "aiden" | "person"; style?: Partial<DesignFrame>;
};
export function variantRootOf(doc: DesignCanvas, frame: DesignFrame): DesignFrame; // its variantOf's frame when present, else itself
export function placeAppVariant(doc: DesignCanvas, original: DesignFrame, input: AppVariantInput):
  | { doc: DesignCanvas; frameId: string }
  | { error: "locked" | "locked-group" | "page-full" | "canvas-full" };

// renderer/shared/design-canvas/app-bridge-messages.ts
//   AppBridgeMessage gains | { type: "breakpoints"; widths: number[] }   // 0–24 strictly ascending integers in 1–8000
export const APP_BREAKPOINT_LIMITS: { min: 1; max: 8000; count: 24 };

// renderer/design/canvas-adapter-core.ts
export function applyNodeChanges(doc: DesignCanvas, changes: NodeChange[], resizeModes?: ReadonlyMap<string, AppResizeMode>): /* as today */;

// renderer/design/nodes/design-node-context.ts — DesignNodeContextValue gains
resizeStart(id: string, mode: AppResizeMode): void;
activeResize: { frameId: string; side: AppResizeMode } | null;
setViewport(id: string, viewport: { width: number; height: number }): void;
addAppView(id: string, size: { device: AppDevice } | { width: number; height: number }): void;
duplicateAppPage(id: string): void;
trashAppPage(id: string): void;
trashing: ReadonlySet<string>;

// main/services/design-canvas/app-server/app-page-files-core.ts
export type AppPageRefusal =
  | "config-router" | "dynamic" | "layout" | "no-file" | "several-files" | "special-files"
  | "relative-imports" | "route-literal" | "too-many" | "too-large" | "not-regular" | "truncated" | "read-only";
export type OwnerFile = { appRelPath: string; convention: RouteConvention };            // relative to the app root
export function workspaceRelPath(appRoot: string, appRelPath: string): string;           // "." → appRelPath, else `${appRoot}/${appRelPath}`
export function pagePath(route: string): { path: string; query: string };
export function ownerOf(path: string, walk: { files: ReadonlyMap<string, OwnerFile[]>; layouts: ReadonlySet<string> }):
  { owner: OwnerFile } | { refused: "dynamic" | "layout" | "no-file" | "several-files" };
export function variantBase(path: string): string;                       // "/pricing-v2" → "/pricing", "/" → "/index"
export function variantPathCandidates(owner: OwnerFile, n: number): { appRelPath: string; newFolder?: string }[];
export function specialFilesLost(owner: OwnerFile, candidate: { newFolder?: string }, siblings: readonly string[]): boolean;
export function relativeImportsMoved(source: string, fromDir: string, toDir: string, kind: "ts" | "astro"): boolean;
export function tanstackRouteId(appRelPath: string): string;
export function rewriteTanstackLiteral(bytes: Buffer, from: string, to: string): { bytes: Buffer } | { refused: "route-literal" };

// main/services/design-canvas/app-server/app-page-files.ts
export function routeFiles(fs: RouteFs, workspaceRoot: string, appRoot: string, framework: FrameworkId | undefined):
  Promise<{ files: Map<string, OwnerFile[]>; layouts: Set<string>; siblings: (appRelPath: string) => Promise<string[]>; truncated: boolean; configRouter: boolean } | null>;
export function readRegularFileBytes(path: string, cap: number):
  Promise<{ ok: true; bytes: Buffer; mode: number } | { ok: false; reason: "too-large" | "not-regular" | "missing" | "io" }>;
export function confinedTarget(workspaceReal: string, workspaceRelPath: string, options: { create: boolean }):
  Promise<{ ok: true; absolute: string; createdFolder?: string } | { ok: false; reason: "outside" | "link" | "io" }>;

// main/services/design-canvas/app-page-ledger.ts
export type PageFileOutcome =
  | { chatId: string; done: "restored" | "copy-trashed" | "copy-rewritten"; file: string }
  | { chatId: string; failed: "restore" | "trash" | "write"; reason: "exists" | "changed" | "io"; file: string };
export function createAppPageLedger(deps: {
  writeBytes(absolute: string, bytes: Buffer, mode: number): Promise<"ok" | "exists" | "io">; // wx, via confinedTarget
  readBytes(absolute: string): Promise<Buffer | null>;                                        // readRegularFileBytes
  trash(absolute: string): Promise<void>;
  resolve(record: LedgerRecord): Promise<string | null>;  // confinedTarget against record.workspaceRoot
  canAct(chatId: string, workspaceId: string, workspaceRoot: string): Promise<boolean>;
  withFileLock<T>(file: string, task: () => Promise<T>): Promise<T>;
  notify(outcome: PageFileOutcome): void;                 // broadcast on DESIGN_PAGE_FILE_CHANNEL
  limit?: number;                                          // 16
}): {
  recordCopy(record: Omit<CopyRecord, "kind" | "state">): void;
  recordTrash(record: Omit<TrashRecord, "kind" | "state">): void;
  reconcile(workspaceId: string, chatId: string, committed: DesignCanvas, undoneRoutes: readonly string[]): Promise<void>;
};

// main/services/design-canvas/app-server/app-routes-core.ts
export function scanTsTokens(text: string, maxTokens?: number, options?: { offsets?: boolean }): TsToken[] | null;
//   with offsets, str tokens also carry { start: number; end: number } (the quotes included); default output unchanged

// main/services/design-canvas/store.ts — both DesignCanvasStore and the DesignChatCanvases wrapper
update(workspaceId, mutate, options?: { beforeWrite?; byPerson?: boolean }): Promise<DesignCanvas>;
save(workspaceId, doc, baseRevision, options?: { …today's; onCommitted?(doc: DesignCanvas): void }): Promise<DesignCanvasSaveResult>;
//   onCommitted is synchronous, runs after the write, and a throw inside it is caught

// main/handlers/design-canvas.ts
export const DESIGN_PAGE_FILE_CHANNEL = "designCanvas:pageFile";
export type DesignCanvasAddAppViewResult =
  | { placed: string; pageId: string }
  | { error: "unavailable" | "not-found" | "locked" | "full" | "bad-size" };
export type DesignCanvasAppPageVariantResult =
  | { placed: string; pageId: string; route: string; file: string }
  | { error: "unavailable" | "not-found" | "locked" | "full" | "io" | AppPageRefusal };
export type DesignCanvasAppPageTrashResult =
  | { trashed: string; route: string; removed: string[]; revision: number }
  | { error: "unavailable" | "not-found" | "locked" | "io" | AppPageRefusal; restore?: "failed" };
// deps gain: workspaceAccess(chat): Promise<{ root: string; permission: WorkspacePermission | "read-only" } | null>
// deps.appFrames gains: trash?(absolute: string): Promise<void>; broadcastPageFile?(outcome: PageFileOutcome): void

// renderer/preload-channels.ts — NOTIFICATION_CHANNEL_VALUES gains "designCanvas:pageFile"

// renderer/lib/ipc.ts
addDesignAppView(chatId, request: { frameId: string; device?: AppDevice; width?: number; height?: number }): Promise<DesignCanvasAddAppViewResult>;
duplicateDesignAppPage(chatId, request: { frameId: string }): Promise<DesignCanvasAppPageVariantResult>;
trashDesignAppPage(chatId, request: { frameId: string }): Promise<DesignCanvasAppPageTrashResult>;
onDesignPageFile(handler: (outcome: PageFileOutcome) => void): () => void;

// renderer/shared/keybindings.ts
export type CommandCapability = StudioFeature | "designMode" | "designLive";
```

## Global Constraints

- **Flag off is today.** Tasks 2, 5, 6, 8 and 9 each include a flag-off case:
  - `AppNode` renders one resizer and today's header;
  - `applyNodeChanges` without `resizeModes` deep-equals today's output;
  - ⌘D duplicates;
  - the sheet has no new row;
  - the IPCs answer `unavailable`;
  - the bridge sends no `breakpoints`;
  - `store.update` and `store.save` without the new options behave as today.
- **Deletion is reversible and never guesses.**
  - Files go to the OS Trash only, through the injected `shell.trashItem`, never `unlink` or `rm`.
  - Writes use `wx` and never overwrite.
  - The ledger acts only on S97's signals, inside the file lock and after `canAct`.
- **No link is followed.** Every read is `O_NOFOLLOW` on an `lstat`-checked path. Every write or trash first passes `confinedTarget`, and a new folder is created one level at a time.
- **Main decides paths.** The renderer sends a frame id and, for views, a device or two integers.
- **Never run the person's code** to find a route's file.
- **Stylesheet data is untrusted.** Breakpoints are capped, validated numbers, shown only as ticks, never stored.
- **Analytics.** Only S100's two call sites, from main.
- **IPC contract.** The new notification channel is exported and listed in `renderer/preload-channels.ts`, and `main/handlers/ipc-contract.test.ts` must pass.
- **UI rules** (AGENTS.md, `GUI.md`, `docs/design-guide.md`). Read `docs/chatgpt-desktop-ui-inspiration.md` and `docs/chatgpt-ui-element-specimen.html` before Tasks 4, 5 and 9. Then:
  - shared squircle `Button iconOnly size="small" variant="transparent"`, `DropdownMenu*` and `Popover` from `renderer/components/ui`;
  - existing semantic tokens only, with ruler CSS in `renderer/design/design-canvas.css`;
  - number fields with no focus accent, border or ring;
  - visible `focus-visible` on every button, menu item and popover control (the resize controls stay pointer-only, S89);
  - no decorative borders;
  - Reduce Motion through the motion tokens;
  - focus returned with `returnFocus`;
  - no brain icons.
- **AGENTS.md test rules.**
  - Behavioural tests only, with no source greps and no `className` or markup snapshots.
  - S91's and S95's rows are written by hand from the frameworks' documented examples.
  - Each new test file is registered in the task that adds it, appended to `test:design-mode` in `package.json` (a union) and added to its lane in `scripts/ci-test-registry.json` (`core-git` for main and shared suites, `renderer-other` for renderer and happy-dom suites). That task runs `npm run test:ci-policy`.
- **Window-opening runs happen in the Cua Space** (`npm run test:e2e:space`). 3a's and 3b's E2E notes hold:
  - frames are placed at `scale: 0.25`, then fitted;
  - controls are pressed with focus and Enter;
  - Linux needs `--disable-seccomp-filter-sandbox` through `appArgs`;
  - `--run` takes `bash -c "npm run build && …"`.
- **Docs change in this PR** (Task 12).

## Review Focus

1. **Dragging past a limit, and letting go.** An edge dragged below 200 or past the box limit, then released, must keep the opposite edge still and the scale unchanged. A press on a handle without a drag must leave no resize mode behind. *Pinned by* Task 2's clamp-and-release and click-without-drag cases.
2. **⌘D on a page that isn't safely copyable.** A `[slug]` route, a TanStack layout, a Next sibling folder with `layout.tsx`, `import "./x.css"`, an odd `createFileRoute`, or a React Router literal config must refuse with Ask Aiden and write nothing. *Pinned by* Task 7's refusal rows and Task 8's "nothing written" spy.
3. **Undo after the copy changed.** ⌘D, an edit to `pricing-v2.tsx`, then ⌘Z: the edited file must not go to the Trash. *Pinned by* Task 8's digest case. The TanStack literal is rewritten before the digest, so the plugin causes no false `changed` (Task 7's S101 rows).
4. **Trash, then something takes the path.** Trash `pricing.tsx`, a new `pricing.tsx` is written, then Undo: nothing is overwritten, and a toast says the file exists. *Pinned by* Task 8's `exists` case.
5. **A save after leaving design mode, or from another chat.** No file is touched unless `canAct` passes for that record's chat and workspace root. *Pinned by* Task 8's gate and two-chat cases.

---

## Tasks

### Task 0: Baseline and probes

- [ ] Confirm the branch is `t3/design-mode-v2-p3c` with `origin/t3/design-mode-v2-p3b` (`c354b32ba` or later) merged in. Merge any newer 3b commits (no rebase), and grep for conflict markers.
- [ ] Run `npm ci`, `npm run build:native:c`, `npm run build:vcc`, and `npm ci` in `packages/cli`.
- [ ] Recheck each "What exists today" row with `rg -n`, and update the table if anything moved.
- [ ] **Probe 1 (xyflow).** In a scratch happy-dom test:
  - check that `NodeResizeControl` takes `keepAspectRatio`, `minWidth`, `maxWidth`, `minHeight` and `maxHeight` per control;
  - check that a drag's final change is `{type: "dimensions", resizing: false}` after `onResizeEnd`;
  - check that a press with no move calls `onResizeStart` but not `onResizeEnd`.

  Record what you find in As built. If per-control `keepAspectRatio` is missing, corners use `shouldResize` with `appResizeScale`, and S89 records that.
- [ ] **Probe 2 (Linux Trash).**
  - Run `npm run test:e2e:space -- --run bash -c "command -v gio && gio trash --help"` in the Space.
  - Read `.github/workflows/ci.yml:966` (the `linux-e2e` apt line). If `gio` comes only from the runner image, note that.
  - If the Space lacks `gio`, Task 10's Trash checks skip on Linux with that reason and run on the macOS host. `docs/linux.md` gets one line: Move page file to Trash needs `gio` (`libglib2.0-bin`).
- [ ] Run `npm run test:design-mode` and `npx tsc --noEmit -p .`. Expected: PASS. Record any failures as pre-existing.

### Task 1: Shared pure rules

**Files:**
- Modify: `renderer/shared/design-canvas/app-frame.ts` (`appEdgeResize`, `appEdgeBounds`, `withAppViewport`, the resize types)
- Create: `renderer/shared/design-canvas/app-variants.ts` (`variantRootOf`, `placeAppVariant`)
- Modify: `main/services/design-canvas/canvas-tools.ts`:
  - the variant branch calls `placeAppVariant`, mapping `locked` → `LOCKED_MESSAGE`, `locked-group` → `groupOf`'s message, and the two full errors → today's messages;
  - the reuse branch and the update rule call `withAppViewport`, with an explicit `p.scale` passed in as the frame's scale.
- Test: `renderer/shared/design-canvas/app-frame.test.ts`, `renderer/shared/design-canvas/app-variants.test.ts` (new, `core-git`), `main/services/design-canvas/canvas-tools.test.ts` (unchanged, must pass)

- [ ] **Step 1: Write the failing tests** in `app-frame.test.ts`:
  - `"a right-edge drag changes the viewport width and keeps the scale"`: `{x:0,y:0,viewport:{1280,800},scale:0.5}` (box `640×436`) dragged to `w: 590` gives viewport `{1180, 800}`, box `{590, 436}` and `x: 0`.
  - `"a left-edge drag keeps the right edge fixed"`: at `x: 100`, `drag {x: 150, w: 590}` gives `x + w === 740`.
  - `"a bottom-edge drag changes the height less the title row"`: `h: 336` gives height `600`.
  - `"an edge drag stops at 200 and at the box limit"`: `w: 10` at scale 0.5 gives width 200 and box `w` 100, with the right edge fixed on a left drag. At scale 2 with maxSize 8000, `w: 9000` gives width 4000 and box `w` ≤ 8000.
  - `"edge bounds match the viewport limits"`: `appEdgeBounds(0.5, 10, 8000)` gives `minWidth 100`, `maxWidth 2000`, `minHeight 136` and `maxHeight 2036`.
  - `"withAppViewport keeps the scale when the box fits and shrinks it when not"`.
- [ ] **Step 2: Write the failing tests** in `app-variants.test.ts`:
  - `"a variant goes right of its set, in a new group titled with the route"`.
  - `"a second variant goes right of the first"`.
  - `"a variant of a variant joins the root's set"`.
  - `"a variant whose original is gone is its own root"`.
  - `"a locked original, a locked group and a full page are refused"`, with the doc unchanged.
- [ ] **Step 3: Run** `npx tsx --test renderer/shared/design-canvas/app-frame.test.ts renderer/shared/design-canvas/app-variants.test.ts`. Expected: FAIL.
- [ ] **Step 4: Implement** the five functions, moving the tool's logic as is.
- [ ] **Step 5: Run** both suites and `npx tsx --test main/services/design-canvas/canvas-tools.test.ts`. Expected: PASS. The canvas-tools suite includes its reuse case with an explicit scale.
- [ ] **Step 6:** Register `app-variants.test.ts` (`test:design-mode`, `core-git`). Run `npm run test:ci-policy`. Commit `feat(design): shared edge-resize, viewport and variant rules (3c)`.

### Task 2: Edges reflow, corners scale

**Files:**
- Modify: `renderer/design/canvas-adapter-core.ts` (the third argument; one `appEdgeResize` per frame per batch, overriding position changes; re-emit on a viewport change)
- Modify: `renderer/design/nodes/frame-parts.tsx` (`AppFrameResizers({selected, minSize, scale, onStart})`: eight `NodeResizeControl`s with per-side closures and `appEdgeBounds`)
- Modify: `renderer/design/nodes/app-node.tsx` (flag on: `AppFrameResizers`; flag off: today's resizer)
- Modify: `renderer/design/nodes/design-node-context.ts` (`resizeStart`, `activeResize`)
- Modify: `renderer/design/design-canvas.tsx` (the `resizeModes` ref, `activeResize` state and `resizeGeneration` ref; the synchronous clear after the final change; the mount-time capture listeners with the generation-guarded `setTimeout(0)`; `resizeStart` leaves an entered frame)
- Test: `renderer/design/canvas-adapter-core.test.ts`, `renderer/design/nodes/app-node.test.tsx`, `renderer/design/design-canvas.test.tsx`

- [ ] **Step 1: Write the failing tests** in `canvas-adapter-core.test.ts`:
  - `"an app frame's edge resize changes its viewport and keeps its scale"`.
  - `"an app frame's corner resize still scales"`: the `"corner"` mode, and no map, both deep-equal today's call.
  - `"a left-edge batch of position and dimensions keeps the right edge, even past the clamp"`: `[{position x: 600}, {dimensions w: 40, resizing: true}]` at scale 0.5 gives width 200, box `w` 100, and `x = x₀ + w₀ − 100`.
  - `"the final resizing:false change in edge mode keeps the scale"`: after a clamped drag, the end change leaves the scale equal to the start.
  - `"a viewport change that rounds to the same box is still saved"`: at scale 0.25, `w` from 320 to 320.4 changes nothing, and a change that moves the viewport by 1 is emitted.
- [ ] **Step 2: Write the failing tests:**
  - `app-node.test.tsx`: `"flag on: an app frame has edge and corner resize controls"` (eight controls, four lines), and `"flag off: one aspect-locked resizer, as today"`.
  - `design-canvas.test.tsx`:
    - `"a press on a resize control without a drag leaves no resize mode"`. Dispatch `mousedown` on a line (what d3-drag listens for), then `mouseup` on `window`, and run timers. `activeResize` is `null`, and a following side-panel resize scales as today.
    - `"a real drag clears its mode on the final change, not on a timer"`. After `mousedown`, `mousemove` and `mouseup`, `activeResize` is `null` before timers run.
    - `"a new resize started before the timer fires keeps its mode"`. Press without a drag, start a second resize, then run timers: the second mode stays.
- [ ] **Step 3: Run** the three suites. Expected: FAIL.
- [ ] **Step 4: Implement** per S89.
- [ ] **Step 5: Run** the three suites. Expected: PASS.
- [ ] **Step 6:** Commit `feat(design): app frame edges change the viewport (3c)`.

### Task 3: Breakpoints from the bridge

**Files:**
- Modify: `main/services/design-canvas/app-frames/app-bridge-source.ts` (`breakpointsOf(mediaText)` and the capped walk; filter, dedupe, sort and cap before posting; send on `ready`, `load` and `vite:afterUpdate` when changed)
- Modify: `renderer/shared/design-canvas/app-bridge-messages.ts` (`breakpoints`, `APP_BREAKPOINT_LIMITS`)
- Modify: `renderer/design/nodes/app-node.tsx` (`{key, widths}` state keyed by `shownKey`)
- Test: `main/services/design-canvas/app-frames/app-bridge-source.test.ts`, `renderer/shared/design-canvas/app-bridge-messages.test.ts`, `renderer/design/nodes/app-node.test.tsx`

- [ ] **Step 1: Write the failing tests** in `app-bridge-source.test.ts` (the bridge in happy-dom with `<style>` elements):
  - `"breakpoints come from min-width, max-width and range queries"`: `(min-width: 768px)`, `(max-width: 767.98px)`, `(width >= 64rem)` and `screen and (min-width: 40em) and (orientation: landscape)` give `[640, 768, 1024]`.
  - `"a chained range gives both ends"`: `(640px <= width < 1024px)` gives `[640, 1024]`.
  - `"nested media inside @supports, @layer and @scope count; container queries don't"`.
  - `"an @import's media and its sheet count, without looping"`: a stub import cycle.
  - `"a cross-origin sheet is skipped without throwing"`.
  - `"the walk stops at its caps"`: 5 000 rules give a result, and rules past 4 000 aren't read.
  - `"out-of-range ticks are dropped and the list is capped at 24 before posting"`: 30 rules and a `120px` give 24 ticks, all in 200–4000.
  - `"removing every media rule sends an empty list once"`.
- [ ] **Step 2: Write the failing tests:**
  - `app-bridge-messages.test.ts`: `"a breakpoints message keeps 0–24 strictly ascending integers in range"`, with `[]` accepted. `"unsorted, duplicate, fractional, 0, 9000, string or 25-entry lists are dropped"` gives `null` for each.
  - `app-node.test.tsx`: `"breakpoints from an earlier route are forgotten"`. After the route changes, the old list isn't shown.
- [ ] **Step 3: Run** the three suites. Expected: FAIL.
- [ ] **Step 4: Implement** per S91.
- [ ] **Step 5: Run** the three suites. Expected: PASS.
- [ ] **Step 6:** Commit `feat(design): the bridge reports the page's breakpoints (3c)`.

### Task 4: The readout, ticks and announcement

Read `docs/chatgpt-desktop-ui-inspiration.md` and `docs/chatgpt-ui-element-specimen.html` first.

**Files:**
- Create: `renderer/design/app-viewport-ruler.tsx` (`AppViewportRuler({side, viewport, scale, zoom, breakpoints})`, in a `NodeToolbar` while `activeResize` names the frame)
- Modify: `renderer/design/nodes/app-node.tsx` (the ruler, plus the polite live region mounted outside it)
- Modify: `renderer/design/design-canvas.css` (ruler classes with existing tokens)
- Test: `renderer/design/app-viewport-ruler.test.tsx` (new, `renderer-other`), `renderer/design/nodes/app-node.test.tsx`

- [ ] **Step 1: Write the failing tests:**
  - `"the readout shows width × height"`.
  - `"ticks sit at breakpoint × scale × zoom from the fixed edge"`: `[640, 768, 1024]` at scale 0.5 and zoom 1 gives `320, 384, 512` from the left for a `right` drag. Zoom 0.5 gives `160, 192, 256`. A `left` drag measures from the right.
  - `"a label too close to the previous one is hidden"`.
  - `"a height drag shows the readout and no ticks"`.
  - In `app-node.test.tsx`: `"the end of a resize announces the final size once"`. The live region says `Viewport 1180 by 800` after `activeResize` clears, and is empty during the drag.
- [ ] **Step 2: Run** the two suites. Expected: FAIL.
- [ ] **Step 3: Implement** per S91's drawing rules.
- [ ] **Step 4: Run** both suites. Expected: PASS.
- [ ] **Step 5:** Register the ruler test (`test:design-mode`, `renderer-other`). Run `npm run test:ci-policy`. Commit `feat(design): live viewport readout and breakpoint ticks (3c)`.

### Task 5: The device menu and Custom…

**Files:**
- Create: `renderer/design/app-frame-menus.tsx` (`AppDeviceMenu({frame, onViewport})` and the Custom popover; Task 9 adds `AppMoreMenu` here)
- Modify: `renderer/design/nodes/app-node.tsx` (flag on: the device button replaces the status row's size text; header priorities, with buttons `shrink-0` and title and label truncating)
- Modify: `renderer/design/nodes/frame-actions.tsx` (flag on: the device button before Dark)
- Modify: `renderer/design/nodes/design-node-context.ts` and `renderer/design/design-canvas.tsx` (`setViewport`: `withAppViewport`, then `refitGroups`, as one step)
- Test: `renderer/design/app-frame-menus.test.tsx` (new, `renderer-other`), `renderer/design/nodes/app-node.test.tsx`, `renderer/design/design-canvas.test.tsx`

- [ ] **Step 1: Write the failing tests:**
  - `"the button names the matching device, or the size, and the size text isn't shown twice"`.
  - `"choosing iPad sets 768 × 1024 and keeps the scale"`.
  - `"a grouped frame changed to Desktop still fits its group"` (`design-canvas.test.tsx`): the group's box contains the frame's new box.
  - `"Custom… opens with focus in Width, applies whole numbers in range and refuses others"`: `150` disables Apply and shows `200–4000`.
  - `"closing Custom returns focus to the device button"`.
  - `"on a narrow frame every header button stays reachable"`: at a 98 px box (happy-dom, where layout boxes are zero), the device button renders icon-only with its `aria-label`, and every header button is in the DOM and in tab order. Non-zero rects are checked in Task 10's E2E, which has real layout.
  - `"flag off: no device button, and the size text stays"`.
- [ ] **Step 2: Run** the suites. Expected: FAIL.
- [ ] **Step 3: Implement** with `DropdownMenu`, `DropdownMenuRadioGroup`, `DropdownMenuRadioItem` and `Popover` from `renderer/components/ui`. Use the `opening` ref with `onCloseAutoFocus` `preventDefault()`, and `returnFocus` on close.
- [ ] **Step 4: Run** the suites. Expected: PASS.
- [ ] **Step 5:** Register the menus test (`test:design-mode`, `renderer-other`). Run `npm run test:ci-policy`. Commit `feat(design): device menu for app frames (3c)`.

### Task 6: Add view at width (IPC)

**Files:**
- Modify: `main/handlers/design-canvas.ts` (`liveChat`; `pickerChat` rebuilt on it; `designCanvas:addAppView`; `DesignCanvasAddAppViewResult`)
- Modify: `main/handlers/design-canvas-main.ts` (call site 5's comment)
- Modify: `renderer/lib/ipc.ts` (`addDesignAppView`)
- Test: `main/handlers/design-canvas.test.ts`

- [ ] **Step 1: Write the failing tests:**
  - `"addAppView places the same route at the device width beside its set"`: the new frame has viewport `{390, 844}`, the original's scale, `label: "iPhone"`, `variantOf` the root and `createdBy: "person"`. A broadcast `step` `add-app-view:<rev>` and a focus with `own: true` follow.
  - `"addAppView works without route discovery"`: deps with no `apps.routes` still place the view.
  - `"a custom view takes two whole numbers and refuses others"`.
  - `"a view of a variant joins the root's set"`.
  - `"a locked original answers locked; a gone frame answers not-found"`.
  - `"addAppView reports design_app_frame_added once, after the commit"`.
  - `"flag off, unattended or not in design mode: unavailable"`.
- [ ] **Step 2: Run** `npx tsx --test main/handlers/design-canvas.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** per S93.
- [ ] **Step 4: Run** the suite. Expected: PASS, including 3b's `placeAppRoute` and `appRoutes` cases on the rebuilt `pickerChat`.
- [ ] **Step 5:** Commit `feat(design): add a view of a page at another width (3c)`.

### Task 7: Which file owns a page, the copy's name, and safe file access

**Files:**
- Create: `main/services/design-canvas/app-server/app-page-files-core.ts` (`workspaceRelPath`, `pagePath`, `ownerOf`, `variantBase`, `variantPathCandidates`, `specialFilesLost`, `relativeImportsMoved`, `tanstackRouteId`, `rewriteTanstackLiteral`)
- Modify: `main/services/design-canvas/app-server/app-routes-core.ts` (`scanTsTokens`'s `offsets` option)
- Create: `main/services/design-canvas/app-server/fixtures/tanstack-route.tsx` (a TanStack doc example, with its source in a comment)
- Create: `main/services/design-canvas/app-server/app-page-files.ts` (`routeFiles`, `readRegularFileBytes`, `confinedTarget`, reusing `confinedRoot`, `walkConvention`, `readParsedFile` and the caps from `app-routes.ts`, exported from there without behaviour change)
- Test: `main/services/design-canvas/app-server/app-page-files-core.test.ts`, `app-page-files.test.ts` (new, `core-git`)

- [ ] **Step 1: Write the failing tests** in `app-page-files-core.test.ts`, with rows written by hand:
  - `"workspace paths"`: `workspaceRelPath(".", "src/routes/a.tsx")` gives `src/routes/a.tsx`, and `workspaceRelPath("apps/web", "src/routes/a.tsx")` gives `apps/web/src/routes/a.tsx`.
  - `"page paths"`: `/pricing/` → `/pricing`, `/pricing?tab=a` → path `/pricing` and query `?tab=a`, and `/` → `/`.
  - `"variant bases"`: `/pricing-v2` → `/pricing`, `/` → `/index`, and `/pricing-v10` stays `/pricing-v10`.
  - `"candidate paths per framework"`:
    - Next app `app/pricing/page.tsx` → `app/pricing-v2/page.tsx` (new folder);
    - Next app `app/page.tsx` → `app/index-v2/page.tsx`;
    - Next pages `pages/pricing.tsx`;
    - TanStack `src/routes/blog.index.tsx` → `src/routes/blog-v2.index.tsx`;
    - TanStack `src/routes/pricing/route.tsx`;
    - flat `app/routes/pricing.tsx`;
    - Astro `src/pages/index.astro`.

    For each, `routeFromFile` of the accepted candidate equals the wanted path.
  - `"owners"`: one file. A dynamic-only match gives `dynamic`. A layout gives `layout`. Two files give `several-files`. None gives `no-file`.
  - `"special files are lost only by a sibling folder copy"`: `app/pricing/` with `layout.tsx` → `true` for candidate 3. `app/page.tsx` with `app/layout.tsx` → `false` for candidate 4.
  - `"relative imports"`:
    - the same folder gives `false` without scanning;
    - a sibling-folder copy keeps `"../lib/x"` but moves `"./Hero"` and `import "./pricing.css"`;
    - a deeper copy moves `"../x"`;
    - `require("./x")`, `import()` and `export … from` count;
    - `"@/x"` and `"react"` never move;
    - a specifier in a comment doesn't count;
    - an unterminated template with a folder change gives `true`.
  - `"TanStack route ids"`: `pricing.tsx` → `/pricing`, `blog.index.tsx` → `/blog/`, `index.tsx` → `/`, `pricing/route.tsx` → `/pricing`.
  - `"the TanStack literal is rewritten at its call site, or refused"`:
    - a full file, `import { createFileRoute, Link } from "@tanstack/react-router"` plus `export const Route = createFileRoute('/pricing')({ component: Pricing })` plus `<Link to="/pricing">`, gives `'/pricing-v2'` in the call only: the import and the `Link` string are untouched, and every other byte is equal;
    - a `createLazyFileRoute("/about")` file with its import is rewritten the same way;
    - one of `@tanstack/router-core`'s SKILL.md route examples, copied into `main/services/design-canvas/app-server/fixtures/tanstack-route.tsx` with its source noted, is rewritten;
    - no call site (a plain default export, or an import only) gives the same bytes;
    - two call sites, an aliased import, a template literal, a non-string argument, a different path, or invalid UTF-8 gives `route-literal`.
  - `"scanTsTokens offsets don't change the default output"`: without the option, the tokens deep-equal today's for the same text, and with it each `str` token's `text.slice(start, end)` is its quoted source.
- [ ] **Step 2: Write the failing tests** in `app-page-files.test.ts`, on a temp workspace:
  - `"routeFiles maps patterns to files without following links"`: a symlinked file and folder are absent, and every path the spy recorded is under the app root.
  - `"React Router: flatRoutes() walks files; a literal routes.ts is a config router"`.
  - `"a TanStack layout file is listed as a layout"`.
  - `"a capped walk is truncated"`.
  - `"readRegularFileBytes returns raw bytes and mode, and tells too-large from not-regular"`: a non-UTF-8 file round-trips byte for byte, 600 KiB gives `too-large`, and a symlink or FIFO gives `not-regular`.
  - `"confinedTarget refuses a link anywhere on the path and creates one folder at most"`: with a symlink at `app/pricing-v2`, nothing is written outside, and the result is `link`. A new `app/pricing-v2/` is created when absent, and a missing grandparent refuses.
- [ ] **Step 3: Run** both. Expected: FAIL.
- [ ] **Step 4: Implement** per S95 and S101.
- [ ] **Step 5: Run** both, plus `app-routes-core.test.ts`, `app-routes.test.ts` and `app-detect.test.ts` (unchanged). Expected: PASS.
- [ ] **Step 6:** Register both (`test:design-mode`, `core-git`). Run `npm run test:ci-policy`. Commit `feat(design): find the file that owns a page and name its variant (3c)`.

### Task 8: Main file operations and the ledger

**Files:**
- Create: `main/services/design-canvas/app-page-ledger.ts` (S97)
- Modify: `main/services/design-canvas/store.ts` (`byPerson` on `DesignCanvasStore.update` and `DesignChatCanvases.update`; `onCommitted` on both `save`s)
- Modify: `main/handlers/design-canvas.ts`:
  - `DESIGN_PAGE_FILE_CHANNEL`;
  - `designCanvas:appPageVariant` and `designCanvas:appPageTrash`;
  - the `workspaceAccess` dependency;
  - `onCommitted` plus the queued `reconcile` in `designCanvas:save`.
- Modify: `main/handlers/design-canvas-main.ts` (`workspaceAccess` from `configStore.getWorkspace`, `trash: (path) => shell.trashItem(path)`, `broadcastPageFile` through `ipcMain.broadcast(DESIGN_PAGE_FILE_CHANNEL, …)`, call site 6's comment)
- Modify: `renderer/preload-channels.ts` (`"designCanvas:pageFile"` in `NOTIFICATION_CHANNEL_VALUES`)
- Modify: `renderer/lib/ipc.ts` (`duplicateDesignAppPage`, `trashDesignAppPage`, `onDesignPageFile`)
- Test: `main/services/design-canvas/app-page-ledger.test.ts` (new, `core-git`), `main/services/design-canvas/store.test.ts`, `main/handlers/design-canvas.test.ts`, `main/handlers/ipc-contract.test.ts` (unchanged, must pass)

- [ ] **Step 1: Write the failing tests** in `app-page-ledger.test.ts`, with fakes for every dependency:
  - `"undo of a copy moves the unchanged copy to the Trash"`.
  - `"undo of a changed copy keeps the file and forgets the record"`: there is no trash call, `failed: "trash", reason: "changed"`, and a later save with the frame back writes nothing.
  - `"removing a copy's frame without undo keeps the file and forgets the record"`.
  - `"redo of a copy writes it again, never over a file"`: `exists` drops the record.
  - `"undo of a trash restores the bytes with wx; an existing file refuses and drops the record"`.
  - `"redo of a trash removes nothing"`.
  - `"a newer record for the same file replaces the older"`: copy, then trash of the same file, then undo of the trash restores the trash record's bytes, and the copy record never acts.
  - `"a refused gate does nothing and drops the record"`: `canAct` false means no trash or write.
  - `"records are per workspace and chat, at most 16"`.
  - `"each action runs inside the file lock"`: the order the fake lock records.
- [ ] **Step 2: Write the failing tests** in `store.test.ts`:
  - `"update with byPerson notes a removed app route"`, and without it notes nothing (today).
  - `"save's onCommitted gets the written document"`: it equals the next `get`, through both `DesignCanvasStore` and `DesignChatCanvases`.
  - `"a throwing onCommitted doesn't fail the save"`.
  - `"DesignChatCanvases.update forwards byPerson"`.
- [ ] **Step 3: Write the failing tests** in `design-canvas.test.ts`:
  - `"appPageVariant copies the route file and places it as a variant, as an undoable step"`:
    - on a TanStack temp app, `/pricing` gives `src/routes/pricing-v2.tsx` with equal bytes and mode;
    - the frame has `route: "/pricing-v2"`, `label: "v2"` and `variantOf` the root;
    - a broadcast step `app-page-variant:<rev>`, a focus with `own: true`, and one `onAppFrameAdded`.
  - `"appPageVariant rewrites a TanStack createFileRoute literal"`, on a realistic file with its `import { createFileRoute }` line and a `<Link to>` to itself.
  - `"a monorepo app copies, trashes and restores under its app root"`: with `appRoot: "apps/web"`, ⌘D writes `apps/web/src/routes/pricing-v2.tsx`; Trash moves `apps/web/src/routes/about.tsx`; undo restores it there. Nothing appears under the workspace's own `src/`.
  - `"a locked or full canvas refuses before any file is written"`: the fs spy records no write and no `mkdir`.
  - `"a lock that appears after the write rolls the copy back and answers locked"`: `beforeWrite` sees the new lock, and the unchanged copy is trashed. The created folder is removed when empty, and the reply is `locked`.
  - `"a copy edited before rollback is kept"`.
  - `"appPageVariant on /pricing?plan=pro places /pricing-v2?plan=pro"`.
  - `"appPageVariant skips a taken slot on EEXIST"`: a pre-made `Pricing-v2.tsx` on a case-insensitive fake fs gives `-v3`.
  - `"appPageVariant refuses and writes nothing"`: one case each for `dynamic`, `layout`, `relative-imports`, `route-literal`, `too-large`, `read-only` (`workspaceAccess` permission `none`), `config-router` and `locked`. The fs spy records no write and no `mkdir`.
  - `"appPageTrash moves the single owning file to the Trash and removes its frames across the workspace"`:
    - trash is called with the real path;
    - frames of that route on two pages are gone;
    - the route key is in `removedAppRoutes`;
    - a broadcast step `app-page-trash:<rev>`;
    - the reply carries `revision`.
  - `"appPageTrash refuses a locked frame on any page before trashing"`.
  - `"a failed canvas write after trash writes the file back"`: `beforeWrite` succeeds and the write throws, so the bytes are restored with `wx` and the reply is `io`.
  - `"Trash keeps the bytes it trashed"`: the file is changed after the owner walk and before `beforeWrite`, and undo restores the changed bytes.
  - `"Trash re-checks the permission inside the lock"`: `workspaceAccess` turns `none` while the update waits, so nothing is trashed and the reply is `read-only`.
  - `"a save after undo restores the trashed file, after the reply"`: end to end through the handler.
  - `"a save after leaving design mode touches no file"`.
  - `"flag off: both answer unavailable"`.
- [ ] **Step 4: Run** the suites. Expected: FAIL.
- [ ] **Step 5: Implement** per S95, S96, S97 and S99.
- [ ] **Step 6: Run** the four suites. Expected: PASS.
- [ ] **Step 7:** Register the ledger test (`test:design-mode`, `core-git`). Run `npm run test:ci-policy`. Commit `feat(design): duplicate and trash page files with undo (3c)`.

### Task 9: ⌘D, the More menu, the overlay guard, toasts and Ask Aiden

**Files:**
- Modify: `renderer/design/app-frame-menus.tsx` (`AppMoreMenu` and the Trash `alertdialog` popover)
- Modify: `renderer/design/nodes/frame-actions.tsx` (flag on: More last)
- Modify: `renderer/canvas/studio-canvas.tsx` (return early while `hasOpenLayer(isOverlayLayer)`)
- Modify: `renderer/design/design-canvas.tsx`:
  - `duplicate` with the flag and one app frame calls the variant action;
  - `addAppView`, `duplicateAppPage` and `trashAppPage` in the node context, each after `await flush()`;
  - the `trashing` set;
  - the toasts, Ask Aiden and `onDesignPageFile` filtered by chat;
  - the Trash toast's Undo, deferred until the canvas reaches `revision` (the toast waits, with a 5 s fallback toast that has no Undo);
  - focus returned to the canvas region after Trash.
- Modify: `renderer/shared/built-in-keys.ts` (`canvas-duplicate-page`), `renderer/shared/keybindings.ts:8` (`"designLive"`)
- Test: `renderer/design/app-frame-menus.test.tsx`, `renderer/design/design-canvas.test.tsx`, `renderer/lib/shortcut-sheet.test.ts`

- [ ] **Step 1: Write the failing tests:**
  - `app-frame-menus.test.tsx`:
    - `"More lists the four actions"`.
    - `"Move page file to Trash asks first, with focus on Cancel"`: it's an `alertdialog`. Cancel calls nothing and returns focus to More. Move to Trash calls `trashAppPage` once.
  - `design-canvas.test.tsx`:
    - `"⌘D with one app frame selected duplicates its page, after flushing"`.
    - `"⌘D with two frames, a non-app frame, or the flag off duplicates as today"`.
    - `"⌘D and ⌫ do nothing while a frame menu or the Trash confirmation is open"` (flag on), and `"⌫ does nothing while the Download menu is open"` (flag off).
    - `"a refusal shows its reason and Ask Aiden queues a note on the frame"`.
    - `"trash dims the frame at once and puts it back on failure"`.
    - `"the Trash toast's Undo undoes the Trash step, not the one before"`: the reply's `revision` arrives before the canvas sync, and no Undo toast is shown yet. After the sync, the toast appears, and its Undo brings the frames back.
    - `"a Trash whose revision never arrives shows a toast without Undo"` (fake timers, 5 s).
    - `"after Trash, focus is on the canvas and ⌘Z undoes it"`.
    - `"a page-file outcome shows a toast in its own chat only"`.
  - `shortcut-sheet.test.ts`: `"the live-page duplicate row shows only with designLive"`.
- [ ] **Step 2: Run** the suites. Expected: FAIL.
- [ ] **Step 3: Implement.** Toast copy is short and plain, one line per refusal kind:
  - `dynamic`: "This page comes from a dynamic route, so copying its file would copy every page it serves."
  - `relative-imports`: "This page imports files beside it, so a copy in another folder would break."
  - `route-literal`: "This page's route path couldn't be updated safely in a copy."
  - Write the rest in the same style.

  The Ask Aiden note is "Duplicate this page as a variant named <route>-v2." or "Move this page's file to the Trash.". It's queued on the frame and never sent by itself.
- [ ] **Step 4: Run** the suites. Expected: PASS.
- [ ] **Step 5:** Commit `feat(design): ⌘D, the app frame's More menu and the overlay key guard (3c)`.

### Task 10: E2E, lanes and screenshots

**Files:**
- Modify: `tests/fixtures/design-live-routes/`: add `src/styles.css` with `@media (min-width: 640px)`, `(min-width: 768px)` and `(width >= 64rem)` rules for `#layout`, imported from `src/main.tsx`. Pricing renders `<div id="layout" data-cols>`, with `data-cols` set from `matchMedia`. Add `src/routes/about.tsx`, a plain page used only by case F.
- Create: `tests/e2e/design-live-viewports.spec.ts`
- Modify: `scripts/ci-e2e-spec-map.json`. Add `"design-live-viewports.spec.ts"` with these prefixes:
  - `renderer/shared/design-canvas/app-`, `renderer/shared/built-in-keys`, `renderer/shared/keybindings`, `renderer/lib/shortcut-sheet`, `renderer/preload-channels`;
  - `renderer/canvas/studio-canvas`, `renderer/design/app-viewport-ruler`, `renderer/design/app-frame-menus`, `renderer/design/nodes/app-node`, `renderer/design/nodes/frame-actions`, `renderer/design/nodes/frame-parts`, `renderer/design/canvas-adapter-core`, `renderer/design/design-canvas`, `renderer/design/use-design-canvas`;
  - `main/services/design-canvas/app-frames/app-bridge-source`, `main/services/design-canvas/app-server/app-page-files`, `main/services/design-canvas/app-page-ledger`, `main/services/design-canvas/store`, `main/handlers/design-canvas`;
  - `tests/fixtures/design-live-routes/`, `tests/e2e/design-live-helpers.ts`.

  `design-live-routes.spec.ts` already covers `tests/fixtures/design-live-routes/` by prefix, so its entry needs no change.

- [ ] **Step 1: Write the spec** with the 3b helpers. Each test seeds its own workspace copy. Cases:
  - **A. Edge drag reflows.** At 1280, dragging the right edge to 1180 × scale gives `innerWidth` 1180 and changes `data-cols` at 1024. The readout showed `1180 × 800`, and the ticks for 640, 768 and 1024 were drawn. The scale is unchanged. ⌘Z restores 1280 in one step.
  - **B. A corner drag keeps the viewport.**
  - **C. Device menu and Custom, by keyboard.** Focus the device button and press Enter, choose iPad, and `innerWidth` is 768. Custom 500 × 900 gives 500. Focus returns to the button.
  - **D. Add view at width.** iPhone gives a second frame, at 390, in the group.
  - **E. ⌘D, undo and redo.** With `/pricing` selected, ⌘D creates `src/routes/pricing-v2.tsx`, and its frame shows the Pricing heading after HMR. ⌘Z removes the frame, and the file is gone from disk. ⇧⌘Z brings back both.
  - **F. Trash and Undo** (its own workspace, on `/about`). Confirm the popover. The file is gone and the frame removed. The toast's Undo brings back the frame, then the file.
  - **G. Refusal.** ⌘D on `/blog/hello-world` shows the dynamic toast. Ask Aiden puts the note on the frame, and no file is written.
  - **H. Flag off.** ⌘D on a page frame duplicates the frame, and there's no More or device button.
  - **I. Shortcut sheet.** ⌘/ lists the new row with the flag on only.
  - **J. A narrow header.** An iPhone frame at scale 0.25: every header button has a non-zero bounding box inside the frame, and each is reachable by Tab.
- [ ] **Step 2: Run** in the Space: `npm run test:e2e:space -- tests/e2e/design-live-viewports.spec.ts`. If Probe 2 found no `gio`, E and F's Trash checks skip on Linux with that reason, and then run on the macOS host with `npx playwright test tests/e2e/design-live-viewports.spec.ts -g "Trash|⌘D"`. That host run is allowed only for this macOS-only behaviour (AGENTS.md).
- [ ] **Step 3: Screenshots** in light and dark (`shoot`):
  - an edge drag with the readout and ticks;
  - the device menu;
  - the More menu;
  - the Trash confirmation;
  - the refusal toast;
  - a narrow iPhone frame's header.

  These go in the PR body.
- [ ] **Step 4: Run** `npm run test:ci-policy`. Commit `test(design): live viewports and page actions E2E (3c)`.

### Task 11: The CLI and native-clients guard

- [ ] Run `npm run cli:build` and `cd packages/cli && npm test`. The CLI bundles `renderer/shared`, so the new shared files must build there. Expected: PASS.
- [ ] Check that no Aiden Remote contract changed: `git diff origin/t3/design-mode-v2-p3b -- main/services/remote* ios android` is empty. The canvas JSON shape gains no stored field. Record this in As built.

### Task 12: Docs, memory and spec amendments

**Files:**
- Modify: `docs/design-mode.md`:
  - the `#app-frames` paragraph: edges change the viewport and corners scale, and the device button replaces the size text;
  - the `#live-frames` bullets: the readout and ticks, the device menu, Add view at width, ⌘D (frameworks, refusals, the TanStack path rewrite, Ask Aiden), and Move page file to Trash (Undo, redo not trashing again, the Trash keeping its copy, undo history and the file ledger both cleared on quit);
  - "Removed routes stay removed": Trash notes the route too;
  - "Privacy": stylesheet breakpoints and the bytes kept for undo stay on the device, in memory.
- Modify: `PRODUCT.md:71` (the live-frames sentence: viewport resizing, device sizes, views, ⌘D variants and page Trash). This is unconditional.
- Modify: `docs/keyboard.md:102-103` (⌘D with one live app frame; canvas keys are ignored while a menu or popover is open).
- Modify: `docs/analytics.md` (the `design_app_frame_added` row: call sites 5 and 6).
- Modify: `docs/linux.md`, only if Probe 2 found `gio` needed.
- Modify: `docs/plans/README.md` (3c built, with the PR link once opened).
- Modify: the spec:
  - the status line;
  - §6.3.8 (S89–S93);
  - §6.3.9 (S94–S99, S101);
  - §6.10 (S100);
  - append S89–S101 as amendments.
- Modify: `.memory/design-mode.md` (a "v2 Phase 3c" section: xyflow's and d3-drag's resize event order, the synchronous clear and the mount-time capture cleanup, the ledger and its signals, the naming and TanStack rules, and E2E gotchas).
- Modify: this plan's As built.

- [ ] Search for stale claims: `rg -n "corner keeps|keeps its shape|⌘D|Hide from canvas|Duplicate page|browser size" docs README.md PRODUCT.md`. Fix any that 3c makes stale.
- [ ] Commit `docs(design): viewports, ⌘D and page Trash (3c)`.

## Spec amendments S89–S101 (Task 12 writes these)

| # | Amendment | Section |
|---|---|---|
| S89 | Edges change the viewport and keep the scale, and corners keep D15; per-side controls with viewport-derived bounds; modes cleared synchronously after xyflow's final change, and for a press without a drag by mount-time window capture listeners (ahead of d3-drag's) with a generation-guarded timer; one undo step | §6.3.8 |
| S90 | ⌥-drag clipping deferred: it conflicts with S62's recomputed box | §6.3.8 |
| S91 | Breakpoints from same-origin width conditions (chained ranges, px/em/rem × 16), a capped walk with imports and scopes, filtered and capped before posting, validated and display-only; zoom-aware ticks on width drags; a polite end announcement; no snapping | §6.3.8 |
| S92 | The device menu replaces the size text; presets plus Custom… by the shared keep-scale rule with a group refit; the keyboard path for resizing | §6.3.8 |
| S93 | Add view at width in a More menu, after a flush, gated without route discovery, joined to the variant set's root | §6.3.8 |
| S94 | ⌘D on exactly one app frame duplicates the page; canvas keys are ignored while an overlay is open; a `designLive` shortcut row | §6.3.9 |
| S95 | The owner walk (React Router flat only, layouts excluded), the refusal table, page paths without query or trailing slash, `-vN` naming through `wx` and `EEXIST`, candidate paths, the fail-closed relative-import check, raw bytes and confined writes | §6.3.9 |
| S96 | Move page file to Trash with an `alertdialog` confirmation; one store update that trashes in `beforeWrite` and writes the file back if the canvas write fails; workspace-wide frame removal; Undo restores with `wx`; redo doesn't trash again | §6.3.9 |
| S97 | The in-memory per-workspace ledger: one record per file, the committed document paired with its `undoneRoutes`, actions inside the file lock after `canAct`, explicit failure transitions, broadcast outcomes | §6.3.9 |
| S98 | "Hide from canvas" is Remove from canvas | §6.3.9 |
| S99 | The gates, with the workspace permission from a new `workspaceAccess` dependency; desktop only; no new tool | §6.3.9 |
| S100 | `design_app_frame_added` call sites 5 and 6; nothing else sends | §6.10 |
| S101 | TanStack copies rewrite the one string argument of their single `createFileRoute(`/`createLazyFileRoute(` call site by its offsets (imports and other strings don't count), or refuse with `route-literal` | §6.3.9 |

## Verification

Run, in order, each expected to pass:
1. `npx tsx --test renderer/shared/design-canvas/app-frame.test.ts renderer/shared/design-canvas/app-variants.test.ts renderer/shared/design-canvas/app-bridge-messages.test.ts renderer/shared/design-canvas/app-devices.test.ts`
2. `npx tsx --test main/services/design-canvas/app-server/app-page-files-core.test.ts main/services/design-canvas/app-server/app-page-files.test.ts main/services/design-canvas/app-server/app-routes.test.ts main/services/design-canvas/app-server/app-detect.test.ts main/services/design-canvas/app-frames/app-bridge-source.test.ts`
3. `npx tsx --test main/services/design-canvas/app-page-ledger.test.ts main/services/design-canvas/canvas-tools.test.ts main/services/design-canvas/store.test.ts main/handlers/design-canvas.test.ts main/handlers/ipc-contract.test.ts`
4. `npx tsx --test renderer/design/canvas-adapter-core.test.ts renderer/design/nodes/app-node.test.tsx renderer/design/app-viewport-ruler.test.tsx renderer/design/app-frame-menus.test.tsx renderer/design/design-canvas.test.tsx renderer/lib/shortcut-sheet.test.ts`
5. `npm run test:design-mode`
6. `npx tsc --noEmit -p .` and `npx tsc --noEmit -p main/tsconfig.json`
7. `npm run lint` and `npm run check:aiden-rules`
8. `npm run test:ci-policy`
9. `npm run build` and `npm run cli:build`
10. In the Cua Space: Task 10's spec, `design-live-frames.spec.ts`, `design-live-routes.spec.ts`, and the flag-on and flag-off v1 design suites.

Then run `npm run test` once before the PR. CI must be green on the exact head. The PR body carries Task 10's screenshots in light and dark.

## Risks and edge cases

| # | Risk | Mitigation |
|---|---|---|
| 1 | **TanStack's route literal.** | S101 rewrites the one exact literal or refuses, so a copy never claims the original's path, and the plugin finds nothing to change. The fixture has no literal, so the rewrite is pinned by Task 7's rows and Task 8's handler case, not E2E. |
| 2 | **A new route shows Not found** until the dev server notices the file. | The frame is live, so HMR shows it. E2E case E waits for the heading. No retry loop. |
| 3 | **xyflow changes its event order** in a minor upgrade. | Probe 1 records the order, and Task 2's tests reproduce it with real `NodeResizeControl`s in happy-dom, so a change fails a test. |
| 4 | **Linux Trash needs `gio`.** | Probe 2. `shell.trashItem` rejects without it, so the reply is `io`, the frames are put back, and nothing is deleted. |
| 5 | **A `variantOf` that points at a removed frame.** | `variantRootOf` falls back to the frame itself (Task 1). |
| 6 | **The Trash keeps a copy after Undo.** | Electron can't restore from the Trash. Documented (S96). |
| 7 | **Quit or reload clears undo.** | The canvas undo history and the ledger are both memory-only (`store.ts` notes main and the renderer restart together), so after a restart there's no undo step for either the frame or the file, and they can't disagree. Persisting file bytes in userData would keep page source beyond the workspace. |
| 8 | **A resize storm.** | It's the same path as today's resize, and the iframe width updates without a remount. |
| 9 | **CSS-in-JS breakpoints** inserted after `load` are missed until the next Vite update. | Accepted. The ticks are a hint. |
| 10 | **⌘D muscle memory.** | Only with the flag, and only for exactly one live app frame. The toast names the new file, and ⌘Z removes it. |
| 11 | **A trash that succeeds and a canvas write that then fails.** | The kept bytes are written back with `wx`. If that also fails, the toast says the file is in the Trash (S96). |

## Open questions

Each has the answer this plan uses. The owner may override.
1. **⌥-drag clipping?** *Deferred* (S90).
2. **Snap edge drags to breakpoints?** *No.* Ticks only.
3. **Linux Trash in CI?** *Probe first* (Task 0, Probe 2).
4. **Should redo of a Trash move the file again?** *No* (S96).
5. **Analytics for Add view and ⌘D?** *Yes, as call sites 5 and 6* (S100).
6. **"Hide from canvas"?** *It's Remove from canvas* (S98).
7. **A size cap for kept copies?** *512 KiB*, with larger files refused.
8. **TanStack copies?** *Rewrite the one exact literal, or refuse* (S101). Refusing every TanStack copy was the alternative, but TanStack's generated files always carry the literal, so that would refuse every real TanStack page.

## Applied review decisions (review-p3c-plan, 2026-11-27)

All 18 findings were checked after merging 3b at `c354b32ba`. Each held. Two are fixed by a different mechanism from the reviewer's:

| # | Finding | Where fixed |
|---|---|---|
| 1 | xyflow end order, a press without a drag, ref vs state, no control name, batches, viewport-only change | S89; Task 2 (clamp-and-release, no-drag, batch and rounding cases); Probe 1 |
| 2 | `designCanvas:pageFile` not allowlisted; how outcomes reach the window | S97 (exported constant, preload entry, broadcast filtered by chat); Task 8 |
| 3 | No undo steps for ⌘D and Trash; a save conflict after trashing; no flush; the toast Undo race | S95/S96 (steps, flush, `revision`-gated Undo). **Different mechanism:** trash runs inside `store.update`'s `beforeWrite`, with `byPerson`, rather than trash-then-update, so a failed trash writes nothing and a failed write puts the file back |
| 4 | Lossy `readBounded`, `mkdir` through links, ledger gates and locks | `readRegularFileBytes`, `confinedTarget`, `canAct` and `withFileLock` in the ledger (S95, S97); Task 7 and Task 8 cases |
| 5 | TanStack literal | S101 (rewrite the exact single literal or refuse); Task 7 rows; Task 8 handler case |
| 6 | Same-file records, `store.get` pairing, failure transitions | S97. **Different mechanism:** `save` gains an internal `onCommitted(doc)` callback instead of returning the doc, so the IPC reply type is unchanged |
| 7 | React Router rule backwards, layout files, Next root inheritance, query and trailing slash | S95 (`configRouter` mirroring `discoverRoutes`, `layout` refusal, `special-files` only for sibling folders, `pagePath`); Task 7 |
| 8 | Side-effect imports, `require`, `scanTsTokens` null, Trash refusals | S95's check and refusal table; Task 7 |
| 9 | No permission dependency, `AppFramework` type, `pickerChat` coupling, explicit `p.scale`, context members, group refit, `ownWrite` | S99 (`workspaceAccess`); `FrameworkId`; `liveChat`; S92 (scale and refit); Interfaces; `ownWrite` removed (S95) |
| 10 | Canvas keys behind open menus | S94's `hasOpenLayer` guard; Task 9 cases, one flag-off |
| 11 | Focus hand-off into and out of popovers, and after Trash | S92/S96 (`opening` ref, `role`, `returnFocus`, canvas focus); Tasks 5 and 9 |
| 12 | Ticks ignore zoom | S91 (`× zoom`, `useViewport`); Task 4's zoom 0.5 case |
| 13 | Chained ranges, imports, caps, the 24-limit drop, empty lists, state lifecycle | S91; Task 3 |
| 14 | `ci.yml` line, case F's coupling, spec-map entries, `gio` in CI | Probe 2 cites `:966`; case F owns its workspace and `/about`; the spec map is fixed |
| 15 | Size text shown twice; a crowded narrow header | S92; Task 5 cases; a narrow-header screenshot |
| 16 | Resize controls aren't focusable; CSS location; the live region's mount | S89's keyboard note; ruler CSS in `design-canvas.css`; the live region outside the ruler (S91) |
| 17 | Case-insensitive clashes and the check-then-write gap | S95 (`wx` per slot, `EEXIST` moves on); Task 8 case |
| 18 | `PRODUCT.md`, the doc targets, Risk 7's wording | Task 12; Risk 7 |

## Applied review decisions, round 2 (review-p3c-plan-2, 2026-11-27)

| # | Finding | Where fixed |
|---|---|---|
| 1 | S101 counted identifiers, so every real file's import refused | S101 matches call sites only and refuses aliased imports; probe against 77 TanStack examples; Task 7 and Task 8 cases on full files |
| 2 | S89's cleanup used pointer events d3-drag doesn't use, and had no generation guard | S89: a synchronous clear after the final change; mount-time capture listeners for mouse, touch, pointer and `blur`; the `resizeGeneration` guard; Task 2's `mousedown`/`mouseup` cases |
| 3 | Trash read its bytes before the lock, and `beforeWrite` didn't re-check the permission | S96: read, gates and trash all inside `beforeWrite`'s file lock; Task 8 cases |
| 4 | App-relative and workspace-relative paths were mixed | `appRelPath` and `workspaceRelPath` (S95, S97, Interfaces); Task 7 rows; Task 8's monorepo case |
| 5 | ⌘D could write a file and then refuse | S95's dry run before the write, and a digest-checked rollback that returns the real reason; Task 8 cases |
| 6 | The wrapper store must forward the new options | Interfaces, S96, S97 and Task 8 name both classes; `onCommitted` is synchronous and caught |
| 7 | Sonner has no disabled action; happy-dom has no layout | S96 defers the Undo toast; Task 5 asserts DOM and tab order; Task 10 case J checks real rects |
| 8 | Text uniqueness refused pages that link to themselves | S101 replaces the call's token span by offsets (`scanTsTokens`'s new `offsets` option) |

## As built

Built 2026-11-27 on `t3/design-mode-v2-p3c`, merged up from `origin/t3/design-mode-v2-p3b`. Commits: Task 1 `c51955f63`, Task 2 `8c182b2af`, Task 3 `3f4232ccf`, Task 4 `786142b97`, Task 5 `73f496113`, Task 7 `54fe8d232`, Task 6 `8b7b8d04b` (built after Task 7, whose helpers it shares), Task 8 `0c36e53de`, Task 9 `516d98886`, then Task 10's E2E and Task 12's docs. Review round 3's notes are applied: `withFileLock` is keyed on `path.resolve(workspaceReal, workspaceRelPath)`, `resizeModes` is snapshotted before `change(...)`, the variant error reply has an optional `kept`, S101's scan skips a `createFileRoute(` preceded by `.`, and Task 9's Undo wording above says deferred.

**Probes.**
- Probe 1 (xyflow 12.11.6) was settled from xyflow's source: `NodeResizeControl` takes a per-control `keepAspectRatio` and bounds, a press with no drag calls no `onResizeEnd`, and the final change is `{type: "dimensions", resizing: false}`. Corners use `keepAspectRatio`, not `shouldResize`.
- Probe 2 (`gio` in the Space): present, `/usr/bin/gio` from `libglib2.0-bin`, so E and F's Trash checks run in the Space and no host run was needed. `docs/linux.md` lists `gio` as an optional requirement for these two actions.

**Deviations.**
- Task 2: the rounding example was wrong (at scale 0.25, `w` 320 → 320.4 moves the viewport by 2, not 0); the test uses 320.1 and 320.2. The cleanup tests read the readout, not the side panel. The compact header threshold is measured in canvas px (`APP_COMPACT_HEADER_PX = 240`).
- Task 1: `placeAppVariant` takes the variant set's root from its caller (`variantRootOf`), so the handler and Aiden's tool share one rule.
- Task 3: nested `CSSStyleRule`s (CSS nesting) are walked; the bridge's `ready` and `load` are one send; rule kinds are detected by constructor name, since a cross-realm `instanceof` fails; happy-dom needs `CSSMediaRule` and `CSSContainerRule` stubs in the tests.
- Task 4: the ruler is a slot in `AppFrame`, drawn through a `NodeToolbar`.
- Task 5: the device button lives in `FrameActions`, and the device menu is off for a locked frame.
- Task 7: the TanStack router-core in the repo is 1.171.15. The S101 fixture is `posts.tsx` with `@ts-nocheck`. Reads go through `confinedRead`. A namespace import refuses (`relative-imports`). `_index` and `lazy` are flat markers. `pagePath` also cuts at `#`. Reads are stricter (regular files only, capped). `relativeImportsMoved` fails closed on anything it can't parse, and `rewriteTanstackLiteral` falls back to a substring match of the exact literal. Known residuals: an apostrophe in JSX text can make the import scan fail (which refuses, so it's safe), and Astro `<script>` imports aren't checked.
- Task 6: `liveChat` refuses a Bot chat by throwing, which is `requireChat`'s behaviour, rather than answering `unavailable`.
- Task 8: the ledger acts only on records of the chat whose save it reads. The Trash removes every app frame of the same app root and page path, ignoring the query, so `/pricing?plan=pro` frames go too. A rollback with no candidate path left answers `no-file`.
- Task 9: the Trash confirmation names the route ("The file that serves /pricing…"), not the file: no IPC resolves the file before main acts. The success toast names the real file. On a compact frame, Dark and Download fold into More. Focus moves to the canvas when the Trash starts, not only on success, and a confirmed Trash skips `returnFocus`. The page actions live in their own hook module, `renderer/design/app-page-actions.ts`. The 5 s fallback toast is tested at the hook level with mock timers.
- Task 10: the fixture gets no `src/routes/about.tsx`; case F writes it into its own workspace copy before the app starts, so 3b's picker still lists exactly four routes. Case J uses the iPhone view case D adds (390 wide at scale 0.5, 195 canvas px, under the 240 px compact threshold) instead of a separate 0.25 frame. Case A drags to about 1000 so `data-cols` drops below the 1024 breakpoint, and allows a few px either way for mouse rounding. Case H duplicates a note, since a flag-off canvas shows no app frames.
- Found by Task 10's E2E, fixed in `6171617ee` and the save-before-mount commit after it:
  - A popover opened from a menu item (the device menu's Custom…, More's Custom… and Move page file to Trash…) showed nothing in the app: opened beside the modal menu, the menu's focus trap took focus back and the popover dismissed itself. happy-dom didn't reproduce it. The popover now opens from the menu's `onCloseAutoFocus`, once the menu has closed.
  - An app frame an undo or redo brought back (the Trash's Undo, ⇧⌘Z of a copy) said "This frame can't show the app.": main finds the frame on the saved canvas, and the node asked before the debounced save. The node now awaits the canvas's flush (`flushCanvas` in the node context, `beforeMount` on `AppFrame`) before `designCanvas:appFrameMount`. This was latent since 3a for ⌫ then ⌘Z of any app frame.
  - The handler tests renamed a few locals and parameters, and four reads of fixture page files carry an inline `check-aiden-rules: allow`, because `no-source-grep-test` follows names file-wide and the fixtures' `.tsx` paths looked like production source.
- Task 11: `git diff origin/t3/design-mode-v2-p3b -- 'main/services/remote*' ios android` is empty; no Aiden Remote contract changed, and the canvas JSON gains no stored field.

**Results** (2026-11-27, local and in the Cua Space `aiden-p3c-1`):
- `npm run test:design-mode`: 1,948 passed, 1 skipped, 1 failed: `lint-client.test.ts` "a pathological file comes back timed-out within the deadline" took 3.7 s with the host's load average near 650. 3c doesn't touch `design-md/`, and the file passes alone (11/11, twice). The earlier run was 1,945 passed, 0 failed. The four real-process failures in the pre-build baseline (`app-attach-process`, `app-server-process`) didn't recur.
- `npx tsc --noEmit -p .`, `npm run type-check:e2e`, `npm run lint`, `npm run check:aiden-rules` and `npm run test:ci-policy` (132/132) pass. `npx tsc --noEmit -p main/tsconfig.json` reports only errors in files 3c doesn't touch (`rootDir`, `--jsx` and `.ts` import settings), as on 3b.
- `npm run cli:build` builds `dist/app`; `packages/cli` `npm test`: 376 passed, 0 failed.
- E2E in the Space: `design-live-viewports.spec.ts` 4/4, with no retries on the final run; `design-live-frames.spec.ts` and `design-live-routes.spec.ts` pass with it (12 passed, and the viewports C case flaked once on a key pressed before the menu held focus, fixed in the spec); `design-canvas.spec.ts`, `design-mode.spec.ts` and `design-containment.spec.ts` 16/16.
- Open: an app frame's last picture can show a menu or popover that covered it when the picture was taken (seen dimmed under "This frame can't show the app." before the save-before-mount fix). The picture is a capture of the main window, from 3a.

**Code review round 1** (2026-11-27, two reviewers on `9e1bd10ed`; `origin/t3/design-mode-v2-p3b` at `7b9ffe0a1` merged first). All 13 findings were real and fixed, each with a test that failed before its fix:
- The ledger's records carry the canvas revision of the save that set their state (the action's commit, then each undo or redo followed). Only a newer save acts on a record. `apply` re-reads the list after every action, and `locked` drops a record replaced while it waited, so a reconcile queued from before an action can't put a trashed file back or drop or trash a new copy.
- The page copy re-checks `stillFraming` and `writableWorkspace` (same real path) inside the file's lock, as the Trash does.
- Add view at width on a page copy shows the copy's own route and scale, in the root's set.
- In create mode, `confinedTarget` answers `exists` for a new page's folder taken by a file or, on a case-insensitive volume, by a folder in another case (native `realpath` names it `Pricing-v2`), so the copy moves on to the next number.
- `parseReactRouterConfig` marks `flatRoutes()` beside or inside other calls `mixed`, which `routeFiles` treats as a config router. Discovery still walks the flat files for display.
- A TanStack copy whose rewrite passes `DESIGN_SOURCE_MAX_BYTES` is refused as `too-large`.
- The Trash refits its frames' groups.
- `gestureEdit` (in `canvas-adapter-core.ts`) starts a drag's undo step on its first change that alters the canvas, so an edge drag whose first move rounds to the same viewport is still one step. It is tested through the real reducer, since happy-dom can't lay out xyflow's resizer.
- `--shadow-popover` and `--shadow-control` are `@theme inline` names that Tailwind never emits as variables, so the readout and the resize handles (the latter already on main) now use `--elevation-popover` and `--elevation-control`.
- The Trash toast offers Undo only at exactly the Trash's revision, and the Undo undoes only while the canvas is still the one it was shown with; otherwise it says to press ⌘Z.
- Duplicate's `aria-keyshortcuts` comes from `ariaKeyShortcut("Command+D")`.
- After the Trash's reply, focus moves to the canvas only if it was lost or is still in the canvas. It stays a plain `focus()`, not `returnFocus`: the closing modal confirmation can still leave the canvas `aria-hidden` that frame, and `returnFocus` then refuses it.
- Results after the fixes: `test:design-mode` 1,961 passed, 1 skipped, and 1 failed. The failure was a handler test that read the ledger's outcome a moment before its notify; it now waits for it, and the touched files pass 175/175. tsc, the e2e typecheck, lint, `check:aiden-rules` and ci-policy (132/132) pass. `design-live-viewports.spec.ts` passes 4/4 with no retries in the Cua Space `aiden-p3c-2`. An earlier run needed one retry each, both from host load: A's Electron teardown timed out after its assertions passed, and E's refusal toast expired during its screenshots.

**PR #968 round 2** (2026-11-28: CI and Pullfrog):
- Desktop tests (core-git, Linux) failed on the case-clash test, which assumed a case-insensitive volume: on Linux the injected `realpath` hit ENOENT. Production was right on both: a case-sensitive volume has no clash. The test now probes the volume (`caseInsensitive`) and checks each kind's real behaviour.
- Pullfrog r4724521914: writes are bound to handles. `createPageFile` opens the folder no-follow and checks it is the inode at its own real path. It creates the file empty (`O_EXCL | O_NOFOLLOW`), and before writing a byte through the new file's handle it checks that the file is in that folder and the folder is still at its path. On Linux the create and the one folder `confinedTarget` may make go through `/proc/self/fd/N/name`, so they land in the verified inode, and a file that ends up in a folder moved away is unlinked through the same handle. macOS residual: Node has no handle-relative create (`/dev/fd` can't be looked up through), so a swap of a folder above, exactly across the create and put back before the check, can leave one empty file, or the copy's one empty folder, where the link pointed. It is refused (`link`), and no byte is written there. Two race tests cover a swap around the whole create and one between the folder's check and the create.
- Pullfrog r4724521921: both page actions re-check, inside the serialized update, that the frame still shows the captured app root and page path (`showsSamePage`), and answer `not-found` otherwise. The copy already written is taken back.
- Pullfrog r4724521924: Trash replies waiting for their revision are kept per revision, so a second Trash never drops the first one's toast.
- Desktop tests (renderer-other): the component sink gains a "Popover at an anchor" case for `PopoverAnchor`.

**PR #968 round 3** (2026-11-28: Pullfrog on `55748a308`):
- r4724600691: on macOS, round 2's identity check ran by path after the create, so a racer could point the path outside for the create and the check and put it back before the folder check. Path-based sandwich checks don't close this either: each call resolves the path again, so a racer flipping the link between calls passes them all. The macOS create is now one `open` with `O_NOFOLLOW_ANY`, which refuses a link in any part of the path, so the file is made only at the literal confined path under real folders. Linux keeps the `/proc/self/fd` create. What remains on macOS: the one new folder is made by path, so a swap can leave an empty folder outside (never a file or a byte), and a write that fails after the create leaves the empty file in the workspace. The race tests now require that nothing at all appears outside, put back right after the create or at the end.
- r4724600701: the variant writes its copy in the canvas update's `beforeWrite`, after the mutator has checked the frame's page and the placement, so a frame retargeted or locked by another save gets nothing written. A rollback now follows only a canvas write that fails after the copy. On Linux it removes Aiden's own file through its folder's handle, by identity and bytes (`removeCreatedFile`), so no Trash (`gio`) is needed. On macOS it uses the Trash after the digest check. A changed copy is kept and reported.
- CI flake (run 46087050991, `design-live-viewports.spec.ts` C): the device menu chose iPhone instead of iPad. Radix's roving focus moves an arrow key's focus in a `setTimeout`, and Chromium runs queued input before timers, so an Enter sent right behind ArrowDown could land on iPhone. Sending both keys in one task reproduces it every time. The product doesn't drop a key: only automation presses within one timer tick. The spec now waits for each key's focus before the next key. It also waits for the More menu to focus itself before focusing its submenu row, and for a highlighted route before the picker's Enter, which does nothing until the routes have loaded. The spec passes 20/20 with `--repeat-each=5 --retries=0` in the Cua Space at a host load average of about 560.

**PR #968 round 4** (2026-11-28: Pullfrog on `fb99f7fd6`, and CI):
- r4724860830: the Linux rollback checked the inode and then unlinked the name, so a file that took the name in between would have been deleted. `takeBackFrom` now renames the name, through the folder's handle, to a random `.aiden-rollback-…` name in the same folder. The rename is atomic, so whatever held the name is now at a name no other process uses. It is unlinked only when proved to be Aiden's own file (one link and the same inode, plus the copied bytes for a rollback). Anything else goes back with `link` then `unlink`, which never replaces a file that took the name again; if it can't, it stays aside and the reply names it as kept. When the rename fails, the file is emptied through a handle proved to be that inode instead. `createPageFile`'s own Linux cleanup, when a folder moved or a write failed, uses the same take-back. A process that can write the folder could list it and find the random name, but it could already delete anything in that folder, so this adds nothing to what it can do. macOS keeps the Trash (by path, after the digest check; recoverable).
- CI "Desktop tests (renderer-other)": the 3b test "a route change drops the old route's path…" missed `/pricing?tab=2`. The frame's `message` listener was a passive effect. 3c's save-before-mount adds a promise hop before the mount request, so the commit that shows the iframe happens outside `act`, and the listener effect waits on React's scheduler. The test's first route message could arrive in that gap and be dropped. The listener is now a layout effect: the frame listens from the commit that shows its page, and an old route's listener never outlives the commit that replaced it. A test posts a route at the moment of insertion (`iframeAsInserted`), before any passive effect; it failed before the fix. `app-node.test.tsx` passes 20 runs out of 20.

