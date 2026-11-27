# Design mode v2 — Phase 3c: viewports and actions — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Revision 1 (2026-11-27).** First draft, written against 3b's head `0a37450dd` on `t3/design-mode-v2-p3c`. Every decision is **proposed**.

**Goal:** The person can resize a live app frame's viewport and watch the page reflow, pick a device size, add a second view of the same page at another width, duplicate a page as a variant with ⌘D, and move a page's file to the system Trash with Undo. All of this is behind `AIDEN_EXPERIMENTAL_DESIGN_LIVE`.

- **Edge-drag reflow (§6.3.8).**
  - Dragging a frame's edge changes its `viewport` and keeps its scale, so the page inside reflows.
  - A readout shows the size live (`1180 × 800`). While a width edge is dragged, ticks mark the page's CSS breakpoints, which the bridge reads from same-origin `@media` rules.
  - Corner drags keep 3a's behaviour: the aspect stays and the scale changes (D15, S62).
- **Device menu (§6.3.8).** iPhone, iPad, Laptop and Desktop from 3b's `APP_DEVICES` (S85), plus Custom… for a typed width and height.
- **Add view at width (§6.3.8).** Places another frame of the same route at a device or custom width, beside the original, as a `variantOf` view in its group.
- **Duplicate page as variant, ⌘D (§6.3.9).** Copies the route's file to `<name>-v2` (then `-v3`, and so on) as a main-side file operation with undo, for file routers: Next (app and pages), TanStack, Astro and React Router or Remix flat routes. It places the copy as a variant. Anything it can't copy safely is refused, with **Ask Aiden** offered instead.
- **Move page file to Trash (§6.3.9).** Moves a route's single owning file to the OS Trash with `shell.trashItem`. Undo puts the file back. Routes not owned by a single file are refused.
- **Remove from canvas** (v1's "Hide from canvas") takes the frame off the canvas only, as today.

With the flag off, the resizer, the header, the menus, ⌘D, the shortcut sheet and every IPC answer are byte-for-byte today's.

**Architecture:**
- **Pure rules (`renderer/shared/design-canvas/`).**
  - `app-frame.ts` gains `appEdgeResize` (an edge drag: new viewport and box, scale kept) and `withAppViewport` (S85's keep-scale viewport change, moved out of `canvas-tools.ts` so the device menu and the tool share it).
  - `app-variants.ts` (new) holds `placeAppVariant`, moved out of `canvas_place_frame`'s variant branch, so the tool, Add view at width and ⌘D place variants the same way.
  - `app-bridge-messages.ts` gains the `breakpoints` message.
- **Bridge (`main/services/design-canvas/app-frames/app-bridge-source.ts`).** Reads breakpoints from same-origin `CSSMediaRule`s at `ready` and after each Vite update.
- **Route-file rules (`main/services/design-canvas/app-server/`).**
  - `app-page-files-core.ts` (new, pure): which file owns a route, the variant name, the candidate paths, and the relative-import check.
  - `app-page-files.ts` (new): the bounded, no-follow owner walk, reusing 3b's walker rules (S78).
- **Main file operations (`main/handlers/design-canvas.ts`, `main/services/design-canvas/app-page-ledger.ts` (new)).**
  - Three IPCs: `designCanvas:addAppView`, `designCanvas:appPageVariant` and `designCanvas:appPageTrash`. They follow 3b's `placeAppRoute` person-placement pattern (`:705-800`).
  - A per-workspace in-memory ledger reconciles the canvas undo and redo of both file operations after each save, and reports what it did on a new `designCanvas:pageFile` notification.
- **Renderer (`renderer/design/`).**
  - `AppNode` draws per-control resizers when the flag is on.
  - `canvas-adapter-core.ts`'s `applyNodeChanges` learns which control is dragged.
  - New `app-viewport-ruler.tsx` and `app-frame-menus.tsx` hold the readout and ticks, and the device and More menus.
  - ⌘D routes to the variant action for one selected app frame.

**Tech Stack:** Electron 43.8.4, React 19, `@xyflow/react` 12.11.6 (`NodeResizeControl`, `NodeToolbar`), TypeScript, `tsx --test`, happy-dom, Playwright Electron in a Cua Space.

**Spec:** [`docs/superpowers/specs/2026-11-23-design-mode-live-app-design.md`](../specs/2026-11-23-design-mode-live-app-design.md): §6.3.8, §6.3.9, §8's 3c row, §6.10 and §11 (S1–S88).

**Stacking:** 3c stacks on 3b ([PR #966](https://github.com/sambitcreate/aiden-agent/pull/966)), which stacks on 3a ([PR #965](https://github.com/sambitcreate/aiden-agent/pull/965)) and the earlier phases. It depends on 3a (frames, aspect lock, menus) and 3b (`device`, `variantOf`, `label`, `removedAppRoutes`, route rules). Merge `origin/t3/design-mode-v2-p3b` into this branch when 3b moves. Never rebase.

## Scope

**In:**
- Edge drags that reflow, the live readout, breakpoint ticks and a polite announcement of the final size.
- The device menu with Custom….
- Add view at width.
- ⌘D and the More menu's **Duplicate page as variant** for file routers, with undo and redo.
- The More menu's **Move page file to Trash** for single-file routes, with Undo.
- The More menu's **Remove from canvas**.
- One more `design_app_frame_added` call site for each new placement (S100).
- Docs, the shortcut sheet and `docs/keyboard.md`.

**Not in:**
- **⌥-drag clipping.** Changing the box without the viewport is deferred (S90).
- **Snapping to breakpoints** (open question 2).
- **Copying for config routers.** React Router's `app/routes.ts` and any non-file router get **Ask Aiden** instead (spec §6.3.9: "Aiden does it").
- **A new Aiden tool.** `canvas_read` and `canvas_place_frame` are unchanged in behaviour (S99).
- **Adopt** (Phase 5).
- **Native clients.** Phones don't draw app frames. Task 11 checks nothing shared changed.
- **Onboarding.** Nothing until Phase 7, because the flag stays experimental.

## Feature flag

Everything sits behind `designLiveEnabled()` (`main/services/studio/feature-flags.ts:37`) and, in the renderer, `useAppCapabilities().designLive` (used at `renderer/design/nodes/app-node.tsx:395`).

With the flag off:
- `AppNode` renders today's single `DesignNodeResizer … keepAspectRatio` (`app-node.tsx:814`), with no device or More button;
- `applyNodeChanges` called without its new third argument behaves as today;
- ⌘D duplicates the selection (`canvas-keymap-core.ts:60`, `design-canvas.tsx:808`);
- the shortcut sheet has no new row;
- the three new IPCs answer `{error: "unavailable"}`;
- the bridge sends no `breakpoints` message;
- no event is sent.

## What exists today (checked against 3b's head `0a37450dd`)

| Area | Fact | Evidence |
|---|---|---|
| Viewport limits | `APP_FRAME_LIMITS` minViewport 200, maxViewport 4000, minScale 0.05, maxScale 2 | `renderer/shared/design-canvas/app-frame.ts:50-58` |
| Box rule | `appFrameBox`: `w = round(width × scale)`, `h = round(height × scale) + 36` (S62) | `app-frame.ts:109-114` |
| Corner resize | `appResizeScale` keeps the aspect, so the width (else the height) decides the scale, fitted with `fitAppScale` | `app-frame.ts:117-148` |
| Devices | `APP_DEVICES`: iPhone 390×844, iPad 768×1024, Laptop 1280×800, Desktop 1440×900; `deviceBucket` | `renderer/shared/design-canvas/app-devices.ts:7-26` |
| Resizer | `DesignNodeResizer({selected, minSize, keepAspectRatio})` wraps `NodeResizer` with the shared handle and line classes | `renderer/design/nodes/frame-parts.tsx:14-37` |
| App node | `<DesignNodeResizer selected minSize={designMinSize("app")} keepAspectRatio />`; the status row shows `${viewport.width} × ${viewport.height}`; the iframe is drawn at viewport width with `transform: scale(scale)` | `renderer/design/nodes/app-node.tsx:814`, `:689`, `:755-758` |
| No remount on viewport | The iframe's key is `${origin}\|${token}`, without the viewport, so a width change reflows the page in place | `app-node.tsx:476` |
| Bridge listener | `parseAppBridgeMessage(event.data, event.origin)` in the node | `app-node.tsx:551` |
| Adapter | `applyNodeChanges(doc, changes)`: the app branch sets the scale from `appResizeScale` and the box from `appFrameBox`; it can't tell which control moved | `renderer/design/canvas-adapter-core.ts` ~`:141-150` |
| One undo step per gesture | `onNodesChange` batches a drag or resize as one step and applies each change live | `renderer/design/design-canvas.tsx:527-563` |
| ⌘D | `{type: "duplicate"}` for ⌘D without ⇧ or repeat; `resolveKey` runs `duplicateFrames` on the selection | `renderer/design/canvas-keymap-core.ts:60`, `design-canvas.tsx:808`, `canvas-adapter-core.ts:207` |
| Keys on controls | `StudioCanvas.onKeyDown` lets Enter and Space on a pressable target through (3a), then calls `resolveKey` | `renderer/canvas/studio-canvas.tsx:110-136` |
| Frame actions | App frames have Dark (`aria-pressed`) and a Download `DropdownMenu` (PNG, PDF), built from `Button iconOnly size="small" variant="transparent"` | `renderer/design/nodes/frame-actions.tsx` |
| Node context | `enter`, `leave`, `update(id, patch, {record})`, `remove`, `download`, `comment`; `DesignFramePatch` has no `viewport` or `scale` | `renderer/design/nodes/design-node-context.ts` |
| Built-in keys | `canvas-duplicate`: ⌘D and Backspace, `requiresCapability: "designMode"`; the sheet filters on `capabilities[key.requiresCapability]` | `renderer/shared/built-in-keys.ts:247-253`, `renderer/lib/shortcut-sheet.ts:130` |
| Capabilities | `CommandCapability = StudioFeature \| "designMode"` (no `designLive`); `AppCapabilities.designLive` exists | `renderer/shared/keybindings.ts:8`, `renderer/lib/app-capabilities.tsx:37` |
| Keyboard doc | "`⌘D` duplicates the selection"; canvas keys are fixed | `docs/keyboard.md:102-103` |
| Trash | The only use is `trash: (folderPath) => shell.trashItem(folderPath)`, injected as a dependency | `main/services/workspace-application-service-main.ts:54`, `workspace-application-service.ts:195` |
| Person placement | `placeAppRoute`: `pickerChat`, `stillFraming`, `store.update` with `beforeWrite`, a broadcast `step`, `sendFocus` with `own: true`, then `onAppFrameAdded(viewport.width)` | `main/handlers/design-canvas.ts:705-800`, `:384`, `:793` |
| Gates | `requireChat` `:405`, `pickerChat` `:673`, `stillFraming` `:682`, `canFrame` `:577` (design mode and attended) | `main/handlers/design-canvas.ts` |
| Undo-with-digest precedent | `bakeTweaks`/`undoBakeTweaks` with an undo id, a digest check and `TWEAK_UNDO_LIMIT = 16` | `main/handlers/design-canvas.ts:398`, `:1119-1173` |
| Own writes | `rewriteFrameFile` with `withFileLock`, `replaceWorkspaceText` and `watcher.ownWrite` | `main/handlers/design-canvas.ts:1036-1088`, `:1075` |
| Size cap | `DESIGN_SOURCE_MAX_BYTES = 512 * 1024` | `main/handlers/design-canvas.ts:198` |
| Save and removed routes | `store.save` applies `withRemovedAppRoutes` with `byPerson = true` and takes `undoneRoutes`; `update` only forgets | `main/services/design-canvas/store.ts:144`, `:209`; `renderer/shared/design-canvas/schema.ts:253`, `:557` |
| Route keys | `appRouteKey = "<root>\u0000<route>"`; `removedAppRoutes` capped at 200 | `renderer/shared/design-canvas/schema.ts:253-277` |
| Variant placement | `canvas_place_frame`'s variant branch: same app root, the original's page, locked and full checks, right of `original` and its variants plus `DESIGN_FRAME_GAP`, a new group titled with the original's route when it has none | `main/services/design-canvas/canvas-tools.ts:1226-1345` |
| Viewport update rule | Keeps the scale through `fitAppScale`, then sets the box from `appFrameBox` | `canvas-tools.ts:1857-1863` (and the reuse branch at `:1262-1270`) |
| Workspace folder | `configStore.getWorkspace(...)?.folderPath` | `main/handlers/design-canvas-main.ts:117` |
| Permission | `runnable()` refuses `none` and `read-only` | `main/services/design-canvas/app-server/app-server-main.ts:326-329` |
| Route walker | `CONVENTION_FOLDERS`, `confinedRoot` (no-follow, `lstat`), `walk`, `walkConvention`; `discoverRoutes` returns patterns only | `main/services/design-canvas/app-server/app-routes.ts:99`, `:203` |
| Route rules | `routeFromFile` `:209`, `routesFromFiles` `:228`, `scanTsTokens` `:340`, `parseReactRouterConfig` `:613` | `main/services/design-canvas/app-server/app-routes-core.ts` |
| Route patterns | `isRoutePattern` `:57`, `isConcreteRoute` `:81`, `fillRoute` `:120` | `renderer/shared/design-canvas/app-routes.ts` |
| Ask Aiden handoff | `queueOnFrame(frameId, note)` queues a note on a frame for the next message | `renderer/design/design-comments.tsx:381` |
| Analytics | `design_app_frame_added {source, device_bucket}`, four call sites (S88); docs row | `main/services/analytics/analytics-events.ts:103`, `docs/analytics.md:57`, `main/handlers/design-canvas-main.ts:82` |
| Fixture | `tests/fixtures/design-live-routes/`: TanStack detected; `src/routes/{index,pricing,blog.$slug}.tsx`; `App.tsx` maps the path through `import.meta.glob("./routes/*.tsx")`, so a file added at run time is served (`pricing-v2.tsx` → `/pricing-v2`) | `tests/fixtures/design-live-routes/src/App.tsx` |

## Decisions

All are **proposed**. They become spec amendments S89–S100 in Task 12. Each follows the spec unless it says otherwise.

### S89 — Edges reflow, corners scale (proposed)

- **Flag on.** `AppNode` renders eight `NodeResizeControl`s instead of one `NodeResizer`:
  - four corner **handles** with `keepAspectRatio`, which keep 3a's rule (the scale changes, the viewport stays);
  - four edge **lines** without it, which change the viewport and keep the scale.
  - Each control uses the shared `design-resize-handle` and `design-resize-line` classes, so the hit areas and focus look like today's.
- **Telling the adapter.** `onResizeStart` sets `{frameId → side}` in a ref owned by `DesignCanvas` and passed to `applyNodeChanges(doc, changes, resizeModes?)`. The side is `"corner"` or one of `left`, `right`, `top`, `bottom`. `onResizeEnd` clears it. With no entry, the app branch behaves as today.
- **The edge rule** (`appEdgeResize`):
  - `left`/`right`: `viewport.width = clamp(round(w / scale))`.
  - `top`/`bottom`: `viewport.height = clamp(round((h − 36) / scale))`.
  - The clamp is 200–4000, and also `floor(maxSize / scale)` (less the title row for height), so the box never exceeds `DESIGN_CANVAS_LIMITS.maxSize`.
  - The box is then recomputed with `appFrameBox` (S62's fixed point).
  - `left`/`top` keep the opposite edge fixed: `x = x₀ + w₀ − w`, and likewise for `y`.
- **Live.** Each move applies through `onNodesChange`, so the iframe gets the new width and reflows. The key excludes the viewport, so there is no remount.
- **One undo step** per drag, using the existing `gesture` batching.
- **Entered frames.** Starting any resize on an entered frame leaves it first (3a's `leave`), as dragging does today.
- **Minimum box.** `minSize` stays `designMinSize("app")`. The edge clamp of 200 × scale can be smaller than that box, and the larger of the two wins.

### S90 — ⌥-drag clipping is deferred (proposed)

§6.3.8 asks for ⌥-drag to change the box only, clipping without reflow. That conflicts with S62: the parser recomputes the box from the viewport and the scale, so a clipped box can't be stored. §8's 3c row doesn't list it. 3c ships edge reflow and corner scaling only. A clipped box would need a new stored field and a parser change, which belongs in a later phase if wanted (open question 1). ⌥ during a resize behaves as without it.

### S91 — Breakpoint ticks and the readout (proposed)

- **The bridge message.** `{type: "breakpoints", widths: number[]}`.
  - The bridge walks `document.styleSheets`, skipping any sheet whose `cssRules` throws (cross-origin).
  - It recurses into `CSSMediaRule`, `CSSSupportsRule` and `CSSLayerBlockRule`. It skips `CSSContainerRule`, because container queries aren't the viewport.
  - It sends at `ready`, after each `vite:afterUpdate`, and once on `load`. It sends nothing when the list is unchanged.
- **Which conditions count.** Only `width` and `min-`/`max-width` features in `px`, `em` or `rem`. `em` and `rem` are × 16, the initial font size that media queries use, not the root element's. The tick is where the layout changes:

  | Condition | Tick |
  |---|---|
  | `min-width: N`, `width >= N`, `N <= width` | `ceil(N)` |
  | `max-width: N`, `width <= N`, `N >= width` | `floor(N) + 1` |
  | `width > N`, `N < width` | `floor(N) + 1` |
  | `width < N`, `N > width` | `ceil(N)` |

  Anything else in the query (`orientation`, `height`, `and`/`or` parts) is ignored, and each width part still counts. So `768px` and `767.98px` both tick at 768.
- **Validation** (`parseAppBridgeMessage`): integers 1–8000, at most 24, sorted and unique, or the message is dropped. Display-only (S11): a tick never changes a stored value.
- **Drawing.** While a **width** edge is dragged, a `NodeToolbar` (screen space, like `format-bar.tsx`) shows:
  - the readout `1180 × 800`, in tabular numerals;
  - one tick per breakpoint inside 200–4000, placed at `breakpoint × scale` from the fixed edge, with the width as its label when there's room.

  A height drag shows the readout only. Corner drags show the readout with the unchanged viewport.
- **Announcement.** On resize end, a polite live region says "Viewport 1180 by 800". Nothing is announced during the drag.
- **No snapping** (open question 2).

### S92 — The device menu (proposed)

- **The control.** A header button shows the current size's device label, or `1180 × 800` for any other size. It opens a `DropdownMenu` with a `DropdownMenuRadioGroup` of the four presets from `APP_DEVICES`, plus **Custom…**.
  - A preset is checked when the viewport equals it exactly.
  - Custom… opens a small popover with two number fields, Width and Height (200–4000, integers), filled with the current viewport, and Apply and Cancel buttons. A field out of range shows its range as help text and disables Apply.
- **The change.** `withAppViewport(frame, viewport, maxSize)` gives `{viewport, scale, w, h}` by S85's keep-scale rule (`fitAppScale`, then `appFrameBox`). The renderer applies it with the canvas's local `change()`, as one undo step. Nothing goes to main beyond the normal save.
- **Shared rule.** `canvas-tools.ts`'s viewport update (`:1857-1863`) and its reuse branch (`:1262-1270`) call `withAppViewport` too, so the rule lives once. Their outputs must not change (existing canvas-tools tests).
- **No analytics.** S88's event is for frames added.

### S93 — Add view at width (proposed)

- **Where.** A **More** (`…`) button in the app frame's header opens a menu with:
  - **Add view at width** ▸ iPhone, iPad, Laptop, Desktop, Custom…;
  - **Duplicate page as variant** (`⌘D`);
  - **Move page file to Trash**;
  - **Remove from canvas** (`⌫`).
- **The IPC.** `designCanvas:addAppView(chatId, {frameId, device?, width?, height?})`. It follows `placeAppRoute`'s pattern: the `pickerChat`/`stillFraming` gates, `store.update` with `beforeWrite`, a broadcast step `add-app-view:<revision>`, `sendFocus` with `own: true`, then `onAppFrameAdded(viewport.width)`.
- **Placement.** `placeAppVariant`, shared with the tool, places:
  - the same app root and route;
  - the device's viewport (or the typed size) at the original's scale, fitted to `maxSize`;
  - the label `iPhone`, `iPad`, `Laptop`, `Desktop` or `<width> px`;
  - `createdBy: "person"`;
  - `variantOf` set to the original's `variantOf` when it has one, else the original's id, so every view and variant of a page joins one set;
  - beside the set's right edge, in its group, or a new group made around both.
- **Refusals.** `not-found` (the frame is gone), `locked`, `full`, `bad-size`. Each shows a toast. The menu closes either way.
- **Duplicates allowed.** The same width twice gives two frames, as `duplicate: true` does for the tool. The person asked for it.

### S94 — ⌘D duplicates a page as a variant (proposed)

- **Flag on, with exactly one app frame selected:** ⌘D runs **Duplicate page as variant**. Otherwise it runs today's `duplicateFrames`, including for several frames that include app frames. This is a renderer-only branch in `resolveKey`'s `duplicate` case. The keymap still answers `{type: "duplicate"}`.
- **In a text field, an entered frame or an open menu**, ⌘D behaves as today. `StudioCanvas`'s target checks already exclude those.
- **The shortcut sheet** gains a built-in row, `canvas-duplicate-page`: "Duplicate a live page as a variant", ⌘D, "With one live app frame selected, copies its page file as name-v2.", `requiresCapability: "designLive"`. `CommandCapability` gains `"designLive"`, so the sheet's filter shows it only with the flag on. `docs/keyboard.md` gets the same line.

### S95 — Which pages can be copied, and the copy's name (proposed)

- **The owner walk.** `routeFiles(workspaceRoot, appRoot, framework)` reuses 3b's confined, no-follow walker and caps (S78) and returns `{pattern → files[]}` through `routeFromFile`. It never runs code.
- **Matching.** A frame's concrete route matches a file pattern by equality first. When only a dynamic pattern matches (`fillRoute` in reverse), the answer is `dynamic`.
- **Refusals.** Each one maps to a toast with **Ask Aiden**:

  | Kind | When |
  |---|---|
  | `config-router` | React Router with a literal `app/routes.ts` (`parseReactRouterConfig` non-null), or a framework with no file convention |
  | `dynamic` | the route comes from a dynamic segment (`[slug]`, `$slug`), so the file serves more than this page |
  | `no-file` | no file owns the route (canvas.json-only, or code-based routes) |
  | `several-files` | more than one file owns it (Next `app/` and `pages/` both, or `index` and a folder `route`) |
  | `special-files` | a Next `app/` route folder that also holds `layout`, `template`, `loading`, `error` or `not-found`, which the copy would lose |
  | `relative-imports` | a relative import would resolve to a different file from the copy's folder (below) |
  | `too-many` | `-v2` to `-v9` are all taken |
  | `too-large` | the file is over 512 KiB (`DESIGN_SOURCE_MAX_BYTES`) |
  | `truncated` | the walk hit a cap, so ownership can't be proven |
  | `read-only` | the workspace permission is `none` or `read-only` |

- **The name.**
  - The base drops a trailing `-v[2-9]` from the last route segment, so a copy of `/pricing-v2` is `/pricing-v3`, not `/pricing-v2-v2`.
  - N is the smallest of 2–9 whose route and file are both free.
  - `/` becomes `/index-vN`.
- **Candidate paths.** These are tried in order, and the first whose `routeFromFile` equals the wanted route wins:
  1. **The stem with the suffix:** `pricing.tsx` → `pricing-v2.tsx`, and `index.astro` at the root → `index-v2.astro`.
  2. **The token before a trailing `index` or `route`:** TanStack `blog.index.tsx` → `blog-v2.index.tsx`.
  3. **The folder renamed:** `app/pricing/page.tsx` → `app/pricing-v2/page.tsx`, and `src/routes/pricing/route.tsx` → `src/routes/pricing-v2/route.tsx`.
  4. **A child `index-vN` folder**, for Next `app/page.tsx` → `app/index-v2/page.tsx`.

  Only the owning file is copied. Folder siblings are not.
- **The relative-import check.** Each relative specifier found with `scanTsTokens` (`from "…"`, `import("…")`, `export … from "…"`), or in Astro frontmatter, is resolved against both the old and the new folder. If any resolves differently, the copy refuses with `relative-imports`. So a sibling copy keeps `../` imports, and a folder move refuses `./`.
- **The copy.** Byte-identical, written with flag `wx` and the original's mode, under `withFileLock`, and announced through `watcher.ownWrite`.
- **Placement.** The new route, beside the variant set by `placeAppVariant`, labelled `vN`, `createdBy: "person"`, then `onAppFrameAdded`.

### S96 — Move page file to Trash (proposed)

- **The menu item** reads **Move page file to Trash**, so it's clear the file goes, not just the frame. A small confirmation popover names the file (`src/routes/pricing.tsx`) and says "You can undo this." with **Move to Trash** and **Cancel**, focus on Cancel. It follows the design guide's destructive-but-restorable rule: no modal dialog.
- **Allowed** only for a route owned by one file (S95's walk). Every refusal kind except `too-many` applies here too, and a file over 512 KiB is refused because undo keeps the bytes in memory.
- **What happens:**
  - The frame dims at once (optimistic). Main reads the bytes, calls the injected `trash(path)` (`shell.trashItem`), then removes every app frame of that root and route from the chat's canvas through `store.save`. So the route is noted in `removedAppRoutes` and Aiden's written-route placement won't put it back (S83).
  - A locked frame of that route refuses with `locked` before anything is trashed.
  - A failure puts the frame back, and the toast names the reason.
- **Undo.** The toast's **Undo** runs the canvas undo, which brings the frames back. The ledger (S97) then restores the file with `wx`. If something now exists at the path, nothing is overwritten and a toast says so.
- **Redo** removes the frames again but **doesn't** trash the file again. A save can't tell a redo from the person removing a frame, and the ledger never deletes on a signal it can't read (open question 4).
- **The Trash keeps its copy** after Undo, because Electron has no restore-from-Trash API. That's documented in `docs/design-mode.md`.

### S97 — The page-file ledger (proposed)

`app-page-ledger.ts` keeps, per workspace and in memory, at most 16 records, newest kept (the `TWEAK_UNDO_LIMIT` precedent):
- a **copy record**: `{kind: "copy", chatId, appRoot, route, file, frameId, bytes, digest, state: "present" | "trashed"}`;
- a **trash record**: `{kind: "trash", chatId, appRoot, route, file, frameIds, bytes, state: "trashed" | "restored"}`.

**Reconciling.** After each successful `designCanvas:save`, the handler queues one pass for that chat's records on a per-workspace queue. It reads the saved document with `store.get` and never delays the save's reply.

| Record | Signal in the saved doc | Action |
|---|---|---|
| copy, present | frame gone **and** its route key in this save's `undoneRoutes` (an undo of the placement) | move the copy to the Trash if its digest is unchanged, then `state: "trashed"`; a changed file is kept, with a toast |
| copy, present | frame gone without that key (the person removed it) | drop the record and keep the file |
| copy, trashed | frame back (a redo) | write the kept bytes with `wx`, then `state: "present"` |
| trash, trashed | any of `frameIds` back (an undo) | write the kept bytes with `wx`, then `state: "restored"` |
| trash, restored | frames gone again | drop the record (S96's redo rule) |

- **Gates.** Every action rechecks `canFrame`, the same workspace folder, and the permission rule (S99).
- **Outcomes** go to that chat's window on `designCanvas:pageFile`, rendered as toasts:
  - success: `restored`, `copy-trashed` or `copy-rewritten`;
  - failure: `{failed, reason: "exists" | "changed" | "io"}`.
- **Never deletes on an ambiguous signal.** A missing record, a different workspace, or a quit (the records are memory only) means nothing happens, and the file stays as it is.

### S98 — "Hide from canvas" is Remove from canvas (proposed)

§6.3.9's "Hide from canvas" is v1's canvas-only removal. 3c offers it in the More menu as **Remove from canvas**, the existing `remove` (⌫). There is no new hidden state.

### S99 — Gates (proposed)

Every 3c IPC needs:
- the flag;
- an attended chat in design mode (`pickerChat`, `stillFraming`);
- for the two file operations, also `canFrame`, a workspace folder, and a permission other than `none` or `read-only` (`runnable()`'s rule).

Otherwise the IPC answers `unavailable`. 3c is desktop-only. No new Aiden tool is added, and `canvas_read` reports the new frames as any app frame.

### S100 — Analytics (proposed)

No new event, so the registry is unchanged. `design_app_frame_added {source: "person", device_bucket}` gains call sites 5 (Add view at width) and 6 (Duplicate page as variant), each sent after the store commit, as S88's are. Device changes, edge drags and Trash send nothing. The `docs/analytics.md:57` row lists the new sources.

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
export function variantRootOf(doc: DesignCanvas, frame: DesignFrame): DesignFrame; // its variantOf's frame, else itself
export function placeAppVariant(doc: DesignCanvas, original: DesignFrame, input: AppVariantInput):
  | { doc: DesignCanvas; frameId: string }
  | { error: "locked" | "locked-group" | "page-full" | "canvas-full" };

// renderer/shared/design-canvas/app-bridge-messages.ts
//   AppBridgeMessage gains | { type: "breakpoints"; widths: number[] }
export const APP_BREAKPOINT_LIMITS: { min: 1; max: 8000; count: 24 };

// renderer/design/canvas-adapter-core.ts
export function applyNodeChanges(doc: DesignCanvas, changes: NodeChange[], resizeModes?: ReadonlyMap<string, AppResizeMode>): /* as today */;

// main/services/design-canvas/app-server/app-page-files-core.ts
export type AppPageRefusal =
  | "config-router" | "dynamic" | "no-file" | "several-files" | "special-files"
  | "relative-imports" | "too-many" | "too-large" | "truncated" | "read-only";
export function ownerOf(route: string, files: ReadonlyMap<string, string[]>): { file: string } | { refused: AppPageRefusal };
export function variantRoute(route: string, taken: (route: string) => boolean): { route: string; n: number } | { refused: "too-many" };
export function variantPathCandidates(framework: AppFramework, file: string, n: number): string[];
export function relativeImportsMoved(source: string, fromDir: string, toDir: string, kind: "ts" | "astro"): boolean;

// main/services/design-canvas/app-server/app-page-files.ts
export function routeFiles(fs: RouteFs, workspaceRoot: string, appRoot: string, framework: AppFramework):
  Promise<{ files: Map<string, string[]>; truncated: boolean; configRouter: boolean } | null>;

// main/services/design-canvas/app-page-ledger.ts
export type PageFileOutcome =
  | { chatId: string; done: "restored" | "copy-trashed" | "copy-rewritten"; file: string }
  | { chatId: string; failed: "restore" | "trash" | "write"; reason: "exists" | "changed" | "io"; file: string };
export function createAppPageLedger(deps: {
  fs: { readFile; writeFile; stat }; trash(path: string): Promise<void>;
  notify(outcome: PageFileOutcome): void; limit?: number;
}): {
  recordCopy(workspace: string, record: Omit<CopyRecord, "kind" | "state">): void;
  recordTrash(workspace: string, record: Omit<TrashRecord, "kind" | "state">): void;
  reconcile(workspace: string, chatId: string, doc: DesignCanvas, undoneRoutes: readonly string[]): Promise<void>;
};

// main/handlers/design-canvas.ts — IPC replies
export type DesignCanvasAddAppViewResult =
  | { placed: string; pageId: string }
  | { error: "unavailable" | "not-found" | "locked" | "full" | "bad-size" };
export type DesignCanvasAppPageVariantResult =
  | { placed: string; pageId: string; route: string; file: string }
  | { error: "unavailable" | "not-found" | "locked" | "full" | AppPageRefusal | "io" };
export type DesignCanvasAppPageTrashResult =
  | { trashed: string; route: string; removed: string[] }
  | { error: "unavailable" | "not-found" | "locked" | AppPageRefusal | "io" };
// deps.appFrames gains: trash?(path: string): Promise<void>
// notification: "designCanvas:pageFile" → PageFileOutcome

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
  - `AppNode` renders one resizer and no new buttons;
  - `applyNodeChanges` without `resizeModes` deep-equals today's output;
  - ⌘D duplicates;
  - the sheet has no new row;
  - the IPCs answer `unavailable`;
  - the bridge sends no `breakpoints`.
- **Deletion is reversible and never guesses.** Files go to the OS Trash only, through the injected `shell.trashItem`, never `unlink` or `rm`. Undo restores with `wx` and never overwrites. The ledger acts only on the signals in S97's table.
- **Main decides paths.** The renderer sends a frame id and, for views, a device or two integers. Main finds the app root, the route, the owning file and the copy's path, and checks each against the workspace realpath (no-follow, S78).
- **Never run the person's code** to find a route's file. Reads are bounded and confined, as in 3b.
- **Stylesheet data is untrusted.** Breakpoints are validated numbers, shown only as ticks, and never stored.
- **Analytics.** Only S100's two call sites, from main. No renderer-side analytics, and no new registry entry.
- **UI rules** (AGENTS.md, `GUI.md`, `docs/design-guide.md`). Read `docs/chatgpt-desktop-ui-inspiration.md` and `docs/chatgpt-ui-element-specimen.html` before Tasks 4, 5 and 9. Then:
  - shared squircle `Button iconOnly size="small" variant="transparent"` and `DropdownMenu*` from `renderer/components/ui`;
  - semantic tokens only, ticks in the muted foreground token;
  - number fields with no focus accent, border or ring;
  - visible `focus-visible` on every button, menu item and resize control;
  - no decorative borders on the readout or ticks;
  - Reduce Motion through the motion tokens (the readout fades only);
  - focus returning to the More button when a menu or popover closes;
  - no brain icons.
- **AGENTS.md test rules.**
  - Behavioural tests only: no source greps, and no `className` or markup snapshots.
  - S91's table and S95's naming rows are written by hand from the frameworks' documented examples.
  - Each new test file is registered in the task that adds it, appended to `test:design-mode` in `package.json` (a union) and added to its lane in `scripts/ci-test-registry.json`: main and shared suites in `core-git`, renderer and happy-dom suites in `renderer-other`. That task runs `npm run test:ci-policy`.
- **Window-opening runs happen in the Cua Space** (`npm run test:e2e:space`). 3a's and 3b's E2E notes hold:
  - frames are placed at `scale: 0.25`, then fitted;
  - controls are pressed with focus and Enter;
  - Linux needs `--disable-seccomp-filter-sandbox` through `appArgs`;
  - `--run` takes `bash -c "npm run build && …"`.
- **Docs change in this PR** (Task 12).

## Review Focus

1. **Dragging past a limit.** An edge dragged to 50 px, or to a width whose box exceeds `maxSize` at a large scale, must stop at 200 or the box limit, keep the opposite edge still, and never jump the scale. *Pinned by* Task 1's clamp rows and Task 2's left-edge case.
2. **⌘D on a page that isn't safely copyable.** A `[slug]` route, a Next folder with `layout.tsx`, a page importing `./Hero`, or a React Router config app must refuse with a clear toast and Ask Aiden, and write nothing. *Pinned by* Task 7's refusal rows and Task 8's "nothing written" spy.
3. **Undo after the person edited the copy.** ⌘D, then Aiden or the person edits `pricing-v2.tsx`, then ⌘Z. The edited file must not go to the Trash. *Pinned by* Task 8's digest case.
4. **Trash, then something takes the path.** Trash `pricing.tsx`, Aiden writes a new `pricing.tsx`, then Undo. Nothing is overwritten, and a toast says the file exists. *Pinned by* Task 8's `exists` case.
5. **Two chats, one workspace.** Undo in chat B never restores chat A's trashed file, and records are keyed by workspace and chat. *Pinned by* Task 8's two-chat case.

---

## Tasks

### Task 0: Baseline and probes

- [ ] Confirm the branch is `t3/design-mode-v2-p3c`, on `origin/t3/design-mode-v2-p3b` at `0a37450dd` or later. Merge any newer 3b commits in (no rebase).
- [ ] Run `npm ci`, `npm run build:native:c`, `npm run build:vcc`, and `npm ci` in `packages/cli`.
- [ ] Recheck each "What exists today" row's line numbers with `rg -n`, and update the table if anything moved.
- [ ] **Probe 1 (xyflow).** In a scratch happy-dom test, check that `NodeResizeControl` in 12.11.6 takes `keepAspectRatio` per control and that `onResizeStart`'s params name the control. If per-control `keepAspectRatio` is missing, corners use `shouldResize` with `appResizeScale` instead, and S89 records that.
- [ ] **Probe 2 (Linux Trash).** Run `npm run test:e2e:space -- --run bash -c "command -v gio && gio trash --help"`. If `gio` is missing, Task 10's Trash cases run on the macOS host instead (`test.skip` on Linux with that reason), and the gap is recorded in As built. The apt list in `ci.yml:322` has no explicit glib.
- [ ] Run `npm run test:design-mode` and `npx tsc --noEmit -p .`. Expected: PASS. Record any failures as pre-existing.

### Task 1: Shared pure rules

**Files:**
- Modify: `renderer/shared/design-canvas/app-frame.ts` (add `appEdgeResize`, `withAppViewport`, `AppResizeSide`, `AppResizeMode`)
- Create: `renderer/shared/design-canvas/app-variants.ts` (`variantRootOf`, `placeAppVariant`)
- Modify: `main/services/design-canvas/canvas-tools.ts:1226-1345` (the variant branch calls `placeAppVariant`, mapping its errors to today's messages) and `:1262-1270`, `:1857-1863` (call `withAppViewport`)
- Test: `renderer/shared/design-canvas/app-frame.test.ts`, `renderer/shared/design-canvas/app-variants.test.ts` (new, `core-git`), `main/services/design-canvas/canvas-tools.test.ts` (unchanged; it must still pass)

**Interfaces:** Produces `appEdgeResize`, `withAppViewport`, `variantRootOf` and `placeAppVariant`, as in Interfaces.

- [ ] **Step 1: Write the failing tests** in `app-frame.test.ts`:
  - `"a right-edge drag changes the viewport width and keeps the scale"`: a frame `{x:0,y:0,viewport:{1280,800},scale:0.5}`, box `640×436`, dragged with `w: 590` gives viewport `{1180, 800}`, scale untouched, box `{w:590, h:436}`, `x: 0`.
  - `"a left-edge drag keeps the right edge fixed"`: the same frame at `x: 100`, `drag {x: 150, w: 590}` gives `x === 150` and `x + w === 740`.
  - `"a bottom-edge drag changes the height less the title row"`: `h: 336` gives viewport height `600`.
  - `"an edge drag stops at 200 and at the box limit"`: `w: 10` at scale 0.5 gives width 200 (box 100). At scale 2 and maxSize 8000, `w: 9000` gives width `4000`, and the box `w` is at most 8000.
  - `"withAppViewport keeps the scale when the box fits and shrinks it when not"`: `{1280,800} @0.5` → `{390,844}` keeps 0.5 with box `{195, 458}`. `{4000,4000} @2` with maxSize 8000 gives a scale ≤ `(8000-36)/4000`, and `appFrameBox` of the result fits.
- [ ] **Step 2: Write the failing tests** in `app-variants.test.ts`:
  - `"a variant goes right of its set, in a new group titled with the route"`: an original with no group, and `placeAppVariant` gives one new group holding both. The new frame's `x` equals `original.x + original.w + DESIGN_FRAME_GAP` and its `y` equals the original's.
  - `"a second variant goes right of the first"`.
  - `"a variant of a variant joins the root's set"`: `variantRootOf` of a frame with `variantOf: A` returns A, and the placement is right of A's whole set.
  - `"a variant whose original is gone is its own root"`: `variantRootOf` of a frame with `variantOf` naming a removed id returns the frame itself.
  - `"a locked original, a locked group and a full page are refused"`: the three error kinds, and the doc is unchanged.
- [ ] **Step 3: Run** `npx tsx --test renderer/shared/design-canvas/app-frame.test.ts renderer/shared/design-canvas/app-variants.test.ts`. Expected: FAIL (not defined).
- [ ] **Step 4: Implement** the four functions. Move the tool's variant logic as is, and the tool maps `locked` → `LOCKED_MESSAGE`, `locked-group` → `groupOf`'s existing message, and `page-full`/`canvas-full` → its two existing messages.
- [ ] **Step 5: Run** both new suites and `npx tsx --test main/services/design-canvas/canvas-tools.test.ts`. Expected: PASS, with canvas-tools unchanged.
- [ ] **Step 6:** Register `app-variants.test.ts` (`test:design-mode`, `core-git`). Run `npm run test:ci-policy`. Commit `feat(design): shared edge-resize, viewport and variant rules (3c)`.

### Task 2: Edges reflow, corners scale

**Files:**
- Modify: `renderer/design/canvas-adapter-core.ts` (`applyNodeChanges`'s third argument; the app branch uses `appEdgeResize` for an edge mode)
- Modify: `renderer/design/nodes/frame-parts.tsx` (add `AppFrameResizers({selected, minSize, onStart, onEnd})`, eight `NodeResizeControl`s with the shared classes)
- Modify: `renderer/design/nodes/app-node.tsx:814` (flag on: `AppFrameResizers`; flag off: today's line)
- Modify: `renderer/design/nodes/design-node-context.ts` (`resizeStart(id, mode)` and `resizeEnd(id)`)
- Modify: `renderer/design/design-canvas.tsx:527-563` (a `resizeModes` ref passed to `applyNodeChanges`; `resizeStart` leaves an entered frame)
- Test: `renderer/design/canvas-adapter-core.test.ts`, `renderer/design/nodes/app-node.test.tsx`

- [ ] **Step 1: Write the failing tests** in `canvas-adapter-core.test.ts`:
  - `"an app frame's edge resize changes its viewport and keeps its scale"`: a dimensions change with `resizeModes` `{id → "right"}` gives the frame viewport width `round(w / scale)` and `scale` equal to before.
  - `"an app frame's corner resize still scales"`: `{id → "corner"}`, and also no map, give the same output as today's call (deep-equal to `applyNodeChanges(doc, changes)`).
  - `"a left edge moves x so the right edge stays"`.
- [ ] **Step 2: Write the failing tests** in `app-node.test.tsx` (happy-dom):
  - `"flag on: an app frame has edge and corner resize controls"`: there are eight resize controls for a selected frame, four of them lines.
  - `"flag off: one aspect-locked resizer, as today"`.
- [ ] **Step 3: Run** the two suites. Expected: FAIL.
- [ ] **Step 4: Implement.** `onResizeStart` calls `context.resizeStart(id, mode)` and `onResizeEnd` calls `context.resizeEnd(id)`. The canvas keeps the map in a ref (no re-render) and passes it through.
- [ ] **Step 5: Run** both suites and `renderer/design/design-canvas.test.tsx`. Expected: PASS.
- [ ] **Step 6:** Commit `feat(design): app frame edges change the viewport (3c)`.

### Task 3: Breakpoints from the bridge

**Files:**
- Modify: `main/services/design-canvas/app-frames/app-bridge-source.ts` (read breakpoints; send at `ready`, on `load`, after `vite:afterUpdate`; only when changed; flag-gated as the bridge is)
- Modify: `renderer/shared/design-canvas/app-bridge-messages.ts` (`breakpoints` type, `APP_BREAKPOINT_LIMITS`, parsing)
- Modify: `renderer/design/nodes/app-node.tsx:551` (keep the last list per frame in a ref, never in the doc)
- Test: `main/services/design-canvas/app-frames/app-bridge-source.test.ts`, `renderer/shared/design-canvas/app-bridge-messages.test.ts`

- [ ] **Step 1: Write the failing tests** in `app-bridge-source.test.ts`, running the bridge in happy-dom with a `<style>`:
  - `"breakpoints come from min-width, max-width and range queries"`: `@media (min-width: 768px)`, `@media (max-width: 767.98px)`, `@media (width >= 64rem)`, `@media screen and (min-width: 40em) and (orientation: landscape)` give `[640, 768, 1024]`.
  - `"nested media inside @supports and @layer counts, container queries don't"`.
  - `"a cross-origin sheet is skipped without throwing"`: a stub sheet whose `cssRules` getter throws.
  - `"an unchanged list isn't sent twice"`.
- [ ] **Step 2: Write the failing tests** in `app-bridge-messages.test.ts`:
  - `"a breakpoints message keeps sorted unique integers in range"`.
  - `"a breakpoints message with a fraction, 0, 9000, a string or 25 entries is dropped"` (`null` for each).
- [ ] **Step 3: Run** both suites. Expected: FAIL.
- [ ] **Step 4: Implement** S91's table in the bridge as one pure function, `breakpointsOf(mediaText)`, inside the bridge source. It uses a small tokenizer over `mediaText` (a few hundred characters), not a regex over page text.
- [ ] **Step 5: Run** both suites. Expected: PASS.
- [ ] **Step 6:** Commit `feat(design): the bridge reports the page's breakpoints (3c)`.

### Task 4: The readout, ticks and announcement

Read `docs/chatgpt-desktop-ui-inspiration.md` and `docs/chatgpt-ui-element-specimen.html` first.

**Files:**
- Create: `renderer/design/app-viewport-ruler.tsx` (`AppViewportRuler({frameId, side, viewport, scale, breakpoints, boxWidth})`, rendered in a `NodeToolbar` while a resize is active)
- Modify: `renderer/design/nodes/app-node.tsx` (show the ruler while `resizeModes` has this frame; the polite live region on end)
- Modify: `renderer/styles.css` (ruler tokens only)
- Test: `renderer/design/app-viewport-ruler.test.tsx` (new, `renderer-other`)

- [ ] **Step 1: Write the failing tests:**
  - `"the readout shows width × height"`: it renders `1180 × 800`.
  - `"a width drag draws a tick per breakpoint inside the range, measured from the fixed edge"`: breakpoints `[640, 768, 1024]`, scale 0.5 and side `right` give ticks at offsets `320, 384, 512` from the left. Side `left` measures from the right.
  - `"a height drag shows the readout and no ticks"`.
  - `"the end of a resize announces the final size once"`: the live region's text is `Viewport 1180 by 800` after end, and empty during the drag.
- [ ] **Step 2: Run** `npx tsx --test renderer/design/app-viewport-ruler.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement.** Tabular numerals and the muted foreground token, with no borders. A tick label is hidden when it's closer than 40 screen px to the previous one.
- [ ] **Step 4: Run** the suite. Expected: PASS.
- [ ] **Step 5:** Register it (`test:design-mode`, `renderer-other`). Run `npm run test:ci-policy`. Commit `feat(design): live viewport readout and breakpoint ticks (3c)`.

### Task 5: The device menu and Custom…

**Files:**
- Create: `renderer/design/app-frame-menus.tsx` (`AppDeviceMenu({frame, onViewport})` and the Custom popover; Task 9 adds `AppMoreMenu` here)
- Modify: `renderer/design/nodes/frame-actions.tsx` (flag on, app frames: the device button before Dark)
- Modify: `renderer/design/nodes/design-node-context.ts` (`setViewport(id, viewport)`, which applies `withAppViewport` through `change()` as one step)
- Test: `renderer/design/app-frame-menus.test.tsx` (new, `renderer-other`)

- [ ] **Step 1: Write the failing tests:**
  - `"the button names the matching device, or the size"`: `{390,844}` shows `iPhone`, and `{1180,800}` shows `1180 × 800`.
  - `"choosing iPad sets 768 × 1024 and keeps the scale"`: `onViewport` gets `{768, 1024}`, and through the context the frame's scale is unchanged and its box is `appFrameBox`'s.
  - `"Custom… applies two whole numbers in range and refuses others"`: `1180`/`800` applies. `150` disables Apply and shows `200–4000`.
  - `"closing the menu returns focus to its button"`.
  - `"flag off: no device button"`.
- [ ] **Step 2: Run** `npx tsx --test renderer/design/app-frame-menus.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement** with `DropdownMenu`, `DropdownMenuRadioGroup` and `DropdownMenuRadioItem` from `renderer/components/ui`, and the popover from the same kit. `stop` handles `onPointerDown` and `onDoubleClick`, as Download does.
- [ ] **Step 4: Run** the suite and `renderer/design/nodes/app-node.test.tsx`. Expected: PASS.
- [ ] **Step 5:** Register it (`test:design-mode`, `renderer-other`). Run `npm run test:ci-policy`. Commit `feat(design): device menu for app frames (3c)`.

### Task 6: Add view at width (IPC)

**Files:**
- Modify: `main/handlers/design-canvas.ts` (`designCanvas:addAppView`, following `placeAppRoute`'s pattern; `DesignCanvasAddAppViewResult`)
- Modify: `main/handlers/design-canvas-main.ts:82` (comment: call site 5; the same `onAppFrameAdded`)
- Modify: `renderer/lib/ipc.ts` (`addDesignAppView`)
- Test: `main/handlers/design-canvas.test.ts`

- [ ] **Step 1: Write the failing tests:**
  - `"addAppView places the same route at the device width beside its set"`: `{frameId, device: "phone"}` gives a new frame with viewport `{390, 844}`, the original's scale, `label: "iPhone"`, `variantOf` the original, `createdBy: "person"`. A broadcast with `step` `add-app-view:<rev>` and a focus with `own: true` follow.
  - `"a custom view takes two whole numbers and refuses others"`: `{width: 1180, height: 800}` is placed with `label: "1180 px"`. `{width: 150}`, `{width: 1.5}` and both a device and a width answer `bad-size`.
  - `"a view of a variant joins the root's set"`.
  - `"a locked original answers locked and changes nothing"`, and `"a gone frame answers not-found"`.
  - `"addAppView reports design_app_frame_added once, as the person, after the commit"`: the dependency is called with `390` once. A refused call doesn't call it.
  - `"flag off, unattended or not in design mode: unavailable"`.
- [ ] **Step 2: Run** `npx tsx --test main/handlers/design-canvas.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** with `placeAppVariant` and `variantRootOf`, and `fitAppScale` against `DESIGN_CANVAS_LIMITS.maxSize`.
- [ ] **Step 4: Run** the suite. Expected: PASS.
- [ ] **Step 5:** Commit `feat(design): add a view of a page at another width (3c)`.

### Task 7: Which file owns a page, and the copy's name

**Files:**
- Create: `main/services/design-canvas/app-server/app-page-files-core.ts` (`ownerOf`, `variantRoute`, `variantPathCandidates`, `relativeImportsMoved`, `AppPageRefusal`)
- Create: `main/services/design-canvas/app-server/app-page-files.ts` (`routeFiles`, reusing `confinedRoot`, `walkConvention` and the caps from `app-routes.ts`, exported from there if needed without behaviour change)
- Test: `main/services/design-canvas/app-server/app-page-files-core.test.ts` and `app-page-files.test.ts` (new, `core-git`)

- [ ] **Step 1: Write the failing tests** in `app-page-files-core.test.ts`, with rows written by hand:
  - `"variant names"`: `/pricing` → `/pricing-v2`. `/pricing-v2` → `/pricing-v3`. `/` → `/index-v2`. With `-v2` taken, → `-v3`. With 2–9 taken, → `too-many`.
  - `"candidate paths per framework"`:
    - Next app `app/pricing/page.tsx` → `app/pricing-v2/page.tsx`;
    - Next app `app/page.tsx` → `app/index-v2/page.tsx`;
    - Next pages `pages/pricing.tsx` → `pages/pricing-v2.tsx`;
    - TanStack `src/routes/blog.index.tsx` → `src/routes/blog-v2.index.tsx`;
    - TanStack `src/routes/pricing/route.tsx` → `src/routes/pricing-v2/route.tsx`;
    - flat `app/routes/pricing.tsx` → `app/routes/pricing-v2.tsx`;
    - Astro `src/pages/index.astro` → `src/pages/index-v2.astro`.

    For each, `routeFromFile` of the first accepted candidate equals the wanted route.
  - `"owners"`: one file is ok. A dynamic-only match gives `dynamic`. Two files give `several-files`. None gives `no-file`.
  - `"relative imports"`: a sibling copy with `import x from "../lib/x"` is not moved, and with `"./Hero"` it is (`app/pricing/` → `app/pricing-v2/`). A deeper copy (`app/page.tsx` → `app/index-v2/page.tsx`) with `"../x"` is moved. `"@/x"` and `"react"` are never moved. An `import()` call and `export … from` count. A specifier inside a comment or a string that isn't an import doesn't.
- [ ] **Step 2: Write the failing tests** in `app-page-files.test.ts`, using a temp workspace:
  - `"routeFiles maps patterns to files without following links"`: a symlinked route file and a symlinked folder are absent, and every read path recorded by the spy is under the app root.
  - `"a React Router app with a literal routes.ts is a config router"`.
  - `"a Next app folder with layout.tsx is special-files"`.
  - `"a capped walk is truncated"`.
- [ ] **Step 3: Run** both. Expected: FAIL.
- [ ] **Step 4: Implement.** The relative-import scan uses `scanTsTokens` (`app-routes-core.ts:340`). For `.astro`, only the `---` frontmatter is scanned.
- [ ] **Step 5: Run** both, and `app-routes.test.ts` (unchanged). Expected: PASS.
- [ ] **Step 6:** Register both (`test:design-mode`, `core-git`). Run `npm run test:ci-policy`. Commit `feat(design): find the file that owns a page and name its variant (3c)`.

### Task 8: Main file operations and the ledger

**Files:**
- Create: `main/services/design-canvas/app-page-ledger.ts` (`createAppPageLedger`, S97)
- Modify: `main/handlers/design-canvas.ts`:
  - `designCanvas:appPageVariant` and `designCanvas:appPageTrash`;
  - after a successful `designCanvas:save` (`:461-482`), queue `ledger.reconcile(workspace, chatId, doc, undoneRoutes)` without awaiting it in the reply;
  - the `designCanvas:pageFile` notification;
  - `deps.appFrames.trash`.
- Modify: `main/handlers/design-canvas-main.ts` (`trash: (path) => shell.trashItem(path)`, and call site 6's comment)
- Modify: `renderer/lib/ipc.ts` (`duplicateDesignAppPage`, `trashDesignAppPage`, `onDesignPageFile`)
- Test: `main/services/design-canvas/app-page-ledger.test.ts` (new, `core-git`), `main/handlers/design-canvas.test.ts`

- [ ] **Step 1: Write the failing tests** in `app-page-ledger.test.ts`, with a fake fs and trash:
  - `"undo of a copy moves the unchanged copy to the Trash"`: the frame is gone and its key is in `undoneRoutes`, so trash is called with the path and `copy-trashed` is notified.
  - `"undo of a copy someone edited keeps the file"`: a changed digest means no trash call, and `failed: "trash", reason: "changed"`.
  - `"removing a copy's frame without undo keeps the file and forgets the record"`: a later save with the frame back writes nothing.
  - `"redo of a copy writes it again, never over a file"`: the frame is back and the path is free, so the bytes are written with `wx`. When the path exists, `failed: "write", reason: "exists"`.
  - `"undo of a trash restores the bytes with wx"`, and `"restoring over an existing file refuses with exists"`.
  - `"redo of a trash removes nothing"`.
  - `"records are per workspace and chat, at most 16"`: chat B's save never acts on chat A's record, and the 17th record drops the oldest.
- [ ] **Step 2: Write the failing tests** in `design-canvas.test.ts`:
  - `"appPageVariant copies the route file byte-for-byte and places it as a variant"`: on a TanStack temp app, `/pricing` → `src/routes/pricing-v2.tsx` with equal bytes and mode, written with `wx`, through `watcher.ownWrite`. The frame has `route: "/pricing-v2"`, `label: "v2"` and `variantOf` the root. `onAppFrameAdded` is called once.
  - `"appPageVariant refuses and writes nothing"`: one case each for `dynamic` (`/blog/hello-world`), `relative-imports`, `too-large` (over 512 KiB), `read-only` (permission `none`) and `locked`. The fs spy records no write.
  - `"appPageTrash moves the single owning file to the Trash and removes its frames"`: trash is called with the real path, every app frame of that root and route is gone, and the route key is in `removedAppRoutes`.
  - `"appPageTrash refuses a locked frame before trashing"`: trash isn't called.
  - `"a save after undo restores the trashed file"`: end to end through the handler. Save the doc with the frames back and `undoneRoutes` containing the key, and the file exists again after the queued pass, while the save's reply came first.
  - `"flag off: both answer unavailable"`.
- [ ] **Step 3: Run** both suites. Expected: FAIL.
- [ ] **Step 4: Implement.**
  - Both operations run under `withFileLock` for the path.
  - Each realpath is checked inside the workspace realpath.
  - The copy's bytes are read with `readBounded` at 512 KiB.
  - The digest is the handler's existing `digest`.
- [ ] **Step 5: Run** both suites and `main/services/design-canvas/store.test.ts`. Expected: PASS.
- [ ] **Step 6:** Register the ledger test (`test:design-mode`, `core-git`). Run `npm run test:ci-policy`. Commit `feat(design): duplicate and trash page files with undo (3c)`.

### Task 9: ⌘D, the More menu, toasts and Ask Aiden

**Files:**
- Modify: `renderer/design/app-frame-menus.tsx` (`AppMoreMenu`: Add view at width ▸, Duplicate page as variant `⌘D`, Move page file to Trash…, Remove from canvas `⌫`; the Trash confirmation popover)
- Modify: `renderer/design/nodes/frame-actions.tsx` (flag on, app frames: the More button last)
- Modify: `renderer/design/design-canvas.tsx:808` (`duplicate` with the flag and one app frame selected calls the variant action; otherwise as today), plus the toasts, **Ask Aiden** and `onDesignPageFile`
- Modify: `renderer/shared/built-in-keys.ts` (the `canvas-duplicate-page` row), `renderer/shared/keybindings.ts:8` (`"designLive"`)
- Test: `renderer/design/app-frame-menus.test.tsx`, `renderer/design/design-canvas.test.tsx`, `renderer/lib/shortcut-sheet.test.ts`

- [ ] **Step 1: Write the failing tests:**
  - `app-frame-menus.test.tsx`:
    - `"More lists the four actions"`.
    - `"Move page file to Trash asks first, with focus on Cancel"`: Cancel calls nothing, and Move to Trash calls `trashDesignAppPage` once.
  - `design-canvas.test.tsx`:
    - `"⌘D with one app frame selected duplicates its page"`: `duplicateDesignAppPage` is called with the frame id, and `duplicateFrames` isn't.
    - `"⌘D with two frames, or a non-app frame, duplicates as today"`.
    - `"⌘D in flag-off duplicates as today"`.
    - `"a refusal shows its reason and Ask Aiden queues a note on the frame"`: `{error: "dynamic"}` shows the dynamic copy, and pressing Ask Aiden calls `queueOnFrame(frameId, …)` once.
    - `"trash dims the frame at once and puts it back on failure"`.
    - `"the trash toast's Undo runs the canvas undo"`.
    - `"a page-file outcome shows a toast in its own chat only"`.
  - `shortcut-sheet.test.ts`: `"the live-page duplicate row shows only with designLive"`.
- [ ] **Step 2: Run** the three suites. Expected: FAIL.
- [ ] **Step 3: Implement.** The toast copy is short and plain, with one line per refusal kind:
  - `dynamic`: "This page comes from a dynamic route, so copying its file would copy every page it serves."
  - `relative-imports`: "This page imports files beside it, so a copy elsewhere would break."
  - Write the rest in the same style.

  The Ask Aiden note is "Duplicate this page as a variant named <route>-v2." or "Move this page's file to the Trash.", queued on the frame and never sent by itself.
- [ ] **Step 4: Run** the three suites. Expected: PASS.
- [ ] **Step 5:** Commit `feat(design): ⌘D and the app frame's More menu (3c)`.

### Task 10: E2E, lanes and screenshots

**Files:**
- Modify: `tests/fixtures/design-live-routes/`: add `src/styles.css` with `@media (min-width: 640px)`, `(min-width: 768px)` and `(width >= 64rem)` rules that change `#layout`'s columns, imported from `src/main.tsx`. Pricing shows `<div id="layout" data-cols>` with `data-cols` set from `matchMedia`, so a test can read the reflow.
- Create: `tests/e2e/design-live-viewports.spec.ts`
- Modify: `scripts/ci-e2e-spec-map.json`. Add `"design-live-viewports.spec.ts"` with these prefixes:
  - `renderer/shared/design-canvas/app-`, `renderer/design/app-viewport-ruler`, `renderer/design/app-frame-menus`, `renderer/design/nodes/app-node`, `renderer/design/nodes/frame-actions`, `renderer/design/canvas-adapter-core`, `renderer/design/design-canvas`;
  - `main/services/design-canvas/app-frames/app-bridge-source`, `main/services/design-canvas/app-server/app-page-files`, `main/services/design-canvas/app-page-ledger`, `main/handlers/design-canvas`;
  - `tests/fixtures/design-live-routes/`, `tests/e2e/design-live-helpers.ts`.

  Add `src/styles.css`'s fixture path to `design-live-routes.spec.ts`'s list too.

- [ ] **Step 1: Write the spec** with `tests/e2e/design-live-helpers.ts` (`openLiveChat`, `placeFrames`, `appIframe`, `press`, `shoot`, `LIVE_ON`). Cases:
  - **A. Edge drag reflows.** Place `/pricing` at 1280 and drag the right edge to a box of 1180 × scale. Inside the iframe, `innerWidth` becomes 1180 and `data-cols` changes at 1024. The readout showed `1180 × 800` during the drag, and the ticks for 640, 768 and 1024 were drawn. The scale is unchanged. ⌘Z restores 1280 in one step.
  - **B. A corner drag keeps the viewport.** `innerWidth` stays 1280 and the box grows.
  - **C. Device menu and Custom.** iPad gives `innerWidth` 768. Custom 500 × 900 gives 500.
  - **D. Add view at width.** Add view ▸ iPhone gives a second frame, at 390, right of the first and in its group.
  - **E. ⌘D.** With `/pricing` selected, ⌘D creates `src/routes/pricing-v2.tsx` on disk, and a frame on `/pricing-v2` shows the Pricing heading after HMR. ⌘Z removes the frame, and the file is in the OS Trash (gone from disk). ⇧⌘Z brings the frame and the file back.
  - **F. Trash and Undo.** Move page file to Trash on `/pricing-v2` (made by E) confirms. The file is gone and the frame is removed. The toast's Undo brings back the frame and then the file.
  - **G. Refusal.** ⌘D on `/blog/hello-world` shows the dynamic toast. Ask Aiden puts the note on the frame, and no file is written.
  - **H. Flag off.** The same fixture without `LIVE_ON`: ⌘D on a page frame duplicates the frame, and there's no More or device button.
  - **I. Shortcut sheet.** ⌘/ lists "Duplicate a live page as a variant" with the flag on only.
- [ ] **Step 2: Run** in the Space: `npm run test:e2e:space -- tests/e2e/design-live-viewports.spec.ts`. If Probe 2 found no `gio`, E and F's Trash checks skip on Linux with that reason, and are then run on the macOS host with `npx playwright test tests/e2e/design-live-viewports.spec.ts -g "Trash|⌘D"` (a host window-opening run allowed only for this macOS-only behaviour, AGENTS.md).
- [ ] **Step 3: Screenshots** in light and dark (`shoot`):
  - an edge drag with the readout and ticks;
  - the device menu open;
  - the More menu open;
  - the Trash confirmation;
  - the refusal toast.

  These go in the PR body.
- [ ] **Step 4: Run** `npm run test:ci-policy`. Commit `test(design): live viewports and page actions E2E (3c)`.

### Task 11: The CLI and native-clients guard

- [ ] Run `npm run cli:build` and `cd packages/cli && npm test`. The CLI bundles `renderer/shared` sources, so `app-frame.ts` and `app-variants.ts` must build there. Expected: PASS.
- [ ] Check that no Aiden Remote contract changed: `git diff origin/t3/design-mode-v2-p3b -- main/services/remote* ios android` is empty. Phones don't draw app frames, and the canvas JSON shape is unchanged (no new stored field), so no mobile suite changes. Record this in As built.

### Task 12: Docs, memory and spec amendments

**Files:**
- Modify: `docs/design-mode.md`:
  - the App frames paragraph (`:64`, "resizing it from a corner keeps its shape"), to say edges change the viewport and corners scale;
  - new text on the readout and ticks, the device menu, Add view at width, ⌘D (which frameworks, the refusals, Ask Aiden), and Move page file to Trash (Undo, redo not trashing again, the Trash keeping its copy, nothing kept after quit);
  - a privacy line saying stylesheet breakpoints stay on the device.
- Modify: `docs/keyboard.md:102-103` (⌘D with one live app frame).
- Modify: `docs/analytics.md:57` (call sites 5 and 6).
- Modify: `PRODUCT.md`, if its design-mode line lists live-frame actions. Search it first.
- Modify: `docs/plans/README.md:70` (3c built, with the PR link once opened).
- Modify: the spec:
  - the status line;
  - §6.3.8 (S89, S90, S91, S92, S93);
  - §6.3.9 (S94–S98);
  - §6.10 (S100);
  - append S89–S100 as amendments.
- Modify: `.memory/design-mode.md` (a "v2 Phase 3c" section after 3b's: the resize modes map, the ledger and its signals, the naming rules, and any E2E gotchas).
- Modify: this plan's As built.

- [ ] Search for stale claims: `rg -n "corner keeps|keeps its shape|⌘D|Hide from canvas|Duplicate page" docs README.md PRODUCT.md`. Fix any that 3c makes stale.
- [ ] Commit `docs(design): viewports, ⌘D and page Trash (3c)`.

## Spec amendments S89–S100 (Task 12 writes these)

| # | Amendment | Section |
|---|---|---|
| S89 | Edges change the viewport and keep the scale, corners keep D15's aspect-locked scaling; one undo step; the adapter learns the control from a start/end map | §6.3.8 |
| S90 | ⌥-drag clipping deferred: it conflicts with S62's recomputed box | §6.3.8 |
| S91 | Breakpoints from same-origin `@media` width conditions (px, em, rem × 16), the tick table, validated and display-only; ticks on width drags; a polite end announcement; no snapping | §6.3.8 |
| S92 | The device menu from `APP_DEVICES` plus Custom…, by the shared keep-scale `withAppViewport` | §6.3.8 |
| S93 | Add view at width in a More menu; main places it with the shared `placeAppVariant`, joined to the variant set's root | §6.3.8 |
| S94 | ⌘D on exactly one app frame duplicates the page; otherwise as today; a `designLive` shortcut row | §6.3.9 |
| S95 | The owner walk, the refusal kinds, `-vN` naming (2–9, base stripped), candidate paths, the relative-import check, a byte-identical `wx` copy | §6.3.9 |
| S96 | Move page file to Trash with a confirmation, `shell.trashItem`, all frames of the route removed, Undo restores with `wx`, redo doesn't trash again | §6.3.9 |
| S97 | The in-memory per-workspace ledger of 16 and its signal table, run after each save, never deleting on an ambiguous signal | §6.3.9 |
| S98 | "Hide from canvas" is Remove from canvas | §6.3.9 |
| S99 | The gates: flag, attended design-mode chat, and for file operations `canFrame` and a writable workspace; desktop only; no new tool | §6.3.9 |
| S100 | `design_app_frame_added` call sites 5 and 6; nothing else sends | §6.10 |

## Verification

Run, in order, each expected to pass:
1. `npx tsx --test renderer/shared/design-canvas/app-frame.test.ts renderer/shared/design-canvas/app-variants.test.ts renderer/shared/design-canvas/app-bridge-messages.test.ts renderer/shared/design-canvas/app-devices.test.ts`
2. `npx tsx --test main/services/design-canvas/app-server/app-page-files-core.test.ts main/services/design-canvas/app-server/app-page-files.test.ts main/services/design-canvas/app-server/app-routes.test.ts main/services/design-canvas/app-frames/app-bridge-source.test.ts`
3. `npx tsx --test main/services/design-canvas/app-page-ledger.test.ts main/services/design-canvas/canvas-tools.test.ts main/services/design-canvas/store.test.ts main/handlers/design-canvas.test.ts`
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
| 1 | **TanStack's `createFileRoute('/pricing')` literal** is copied into `pricing-v2.tsx` unchanged. | TanStack's router plugin rewrites that literal when it regenerates. Without the plugin the copy may 404 or claim `/pricing`. The docs say so, and the copy is placed and visible, so the person or Aiden fixes it in one edit. Next, Astro and flat routes have no path literal. |
| 2 | **A new route shows Not found** until the dev server or router notices the file. | The frame is live, so HMR or the next navigation shows it. E2E case E waits for the heading. No retry loop. |
| 3 | **Relative imports** that resolve differently after a folder copy. | S95's resolve-both check refuses, with Ask Aiden. |
| 4 | **Linux Trash needs `gio`.** | Probe 2. `shell.trashItem` rejects without it, so the IPC answers `io`, the frame is put back, and nothing is deleted. |
| 5 | **A `variantOf` that points at a removed frame.** | Unchanged from 3b: a dangling `variantOf` is display-only, and `variantRootOf` falls back to the frame itself. Task 1 covers this. |
| 6 | **The Trash keeps a copy after Undo.** | Electron can't restore from the Trash. Documented (S96). The restored file comes from the kept bytes. |
| 7 | **Records are lost at quit**, so an undo after a restart restores the frame but not the file. | Documented. The ledger is memory-only by design: persisting file bytes in userData would keep page source beyond the workspace. The frame shows Not found, and Aiden can restore the file from git. |
| 8 | **A resize storm**: each pointer move changes the doc and re-renders. | It's the same path as today's resize. The iframe width updates without a remount, and Task 10 case A checks smoothness by completing within its timeout. |
| 9 | **Breakpoints from CSS-in-JS** inserted after `load` are missed until the next Vite update. | Accepted. The ticks are a hint, and a missed tick hides nothing. |
| 10 | **⌘D muscle memory.** A person used to ⌘D duplicating a frame gets a file copy. | Only with the flag, and only for exactly one live app frame. The toast names the new file, and ⌘Z removes it. The sheet and `docs/keyboard.md` say so. |

## Open questions

Each has the answer this plan uses. The owner may override.
1. **⌥-drag clipping?** *Deferred* (S90). It needs a stored clip box, against S62.
2. **Snap edge drags to breakpoints?** *No.* Ticks only. Snapping fights fine adjustment, and it can be added later with a modifier.
3. **Linux Trash in CI?** *Probe first.* If `gio` is missing in the Space, the Trash checks run on the macOS host (Task 10, Step 2) rather than adding packages to CI.
4. **Should redo of a Trash move the file again?** *No* (S96). A save can't tell a redo from the person removing a frame, and nothing is deleted on a guess.
5. **Analytics for Add view and ⌘D?** *Yes, as call sites 5 and 6* (S100). Both add a frame, which is what the event counts.
6. **"Hide from canvas"?** *It's Remove from canvas* (S98), with no new hidden state.
7. **A size cap for kept copies?** *512 KiB* (`DESIGN_SOURCE_MAX_BYTES`), with larger files refused (S95, S96).

## As built

*(Filled in when 3c is built.)*
