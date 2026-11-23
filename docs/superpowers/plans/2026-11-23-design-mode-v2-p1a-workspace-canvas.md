# Design mode v2 — Phase 1a: workspace canvas document — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the design canvas one document per workspace, with each chat's current page and viewport living outside that document. Leave design mode working exactly as today for one chat.

**Architecture:** The store keeps one file per workspace id. A thin adapter resolves a chat to its workspace, so most callers keep passing a chat id. The view (page, viewport, canvas size) moves out of the document:
- the renderer keeps it per chat in `localStorage`;
- the renderer reports it to main over `designCanvas:view`;
- main holds it in memory in `DesignCanvasViews`, and tools read it from there.

Every `doc.activePageId` reader becomes an explicit `pageId` taken from the chat's view. Page changes Aiden asks for become `designCanvas:focus {chatId, pageId, frameIds}` IPC instead of document writes.

**Tech Stack:** TypeScript (ESM), Electron 43 main, React 19 renderer with xyflow, `tsx --test` for unit tests, Playwright E2E through `npm run test:e2e:space`.

**Spec:** `docs/superpowers/specs/2026-11-23-design-mode-live-app-design.md` §6.1, §8 (row 1a), §11.6.

## Global Constraints

- Pre-1.0: no migration. Old per-chat canvas files are deleted on first start (§6.1, §11.6).
- File: `userData/design-canvases/<workspaceId>.json`. The workspace id must pass `isWorkspaceArtifactWorkspaceId` (`renderer/shared/workspace-artifacts.ts:265`). Each No workspace chat has its own hidden workspace record (`noWorkspace: true`), so it gets its own canvas. Only legacy chats with no `workspaceId` resolve through `persistedChatWorkspaceId` to `"default"` and share that canvas. The renderer normalizes with `persistedChatWorkspaceId` too (amendment A11).
- `version: 3`. `activePageId` and `pages[].viewport` are removed. `chatPages: Record<chatId, pageId>` is added: parsed and kept valid, but written by nothing until 1b.
- Optional `chatId` on artifact frames and on comments, stamped when they are created.
- Limits:
  - `pages` 200;
  - `frames` 4000, `framesPerPage` 400 (unchanged);
  - `comments` 2000;
  - 16 MiB document cap unchanged.
- Panning, zooming and switching pages never call `change()`, never save and are never undo steps.
- `localStorage` key: `aiden.design.view.<workspaceId>.<chatId>`. Every read and write goes in try/catch, and the canvas renders correctly without storage.
- `designCanvas:updated` payload: `{workspaceId, chatId, revision, aidenTurn?, step?}`, where `chatId` is the chat whose action caused the change (A2). `designCanvas:focus` payload: `{chatId, pageId?, frameIds}`.
- Handlers keep `chatId` as their argument and authority check: an attended chat, with the design-mode rule each handler has today.
- Design mode stays desktop-only and out of the Remote projection.
- AGENTS.md:
  - no source-grep tests;
  - new test files are registered in `scripts/ci-test-registry.json` and a `package.json` test script, then `npm run test:ci-policy` is run;
  - docs change in this PR;
  - window-opening E2E runs through `npm run test:e2e:space`.

## Review Focus

1. **Two chats, one workspace, one window.** A save from chat A's canvas must reach chat B's canvas on the same workspace through `{workspaceId}`, and B must refetch. Switching between them never jumps either chat's page. Test: Task 3 (handler broadcast) and Task 7 (sync filters on `workspaceId`).
2. **The view names a deleted page** (another chat deleted it). The canvas shows the first page and does not crash. Tools default to the first page. Test: Task 1 (`viewPageId`) and Task 7 (the canvas shows the first page).
3. **`localStorage` throws or holds junk** (private mode, a hand-edited value). The canvas opens on the first page at the default viewport. Test: Task 7.
4. **A stale v2 file at a workspace path** (a downgrade and re-upgrade, or a hand copy). Parse refuses it, and the store sets it aside as corrupt instead of crashing. Test: Task 3.
5. **Chat deleted while another chat on the workspace has the canvas open.** The shared file survives, and the deleted chat's artifact frames show their missing state rather than an error. Test: Task 8.

## Review amendments (2026-11-23)

An adversarial review of this plan against the code found the problems below, each verified. They are part of the plan: where an amendment and a task disagree, the amendment wins. Each names the task that owns it and the test that pins it.

- **A1. Aiden's page change counts at once, with or without a window** (Task 5, with a renderer part in Task 7).
  - When a tool shows or focuses a page (`canvas_page show`, `add` with show, `canvas_focus`, `canvas_arrange`), main sets that chat's view page immediately: `DesignCanvasViews.showPage(chatId, pageId)` creates a view if none exists. Later tool calls in the same turn read it.
  - *(Revised in round 2: no `seq`.)* Each Aiden page change gets a per-chat `focusId` (an increasing integer kept by main). Main sends it in `designCanvas:focus {chatId, pageId, frameIds, focusId}`. Every view report echoes the last `focusId` that renderer applied. Main ignores a report whose echoed `focusId` is older than the chat's current one. A report from a fresh mount echoes nothing (`0`) and is likewise ignored while a newer Aiden change is pending.
  - On mount, the canvas asks main for the chat's kept view (`designCanvas:view:get`, answered from `DesignCanvasViews`: page, viewport, `focusId`). It prefers that over `localStorage`, which is only the fallback when main has no view (first launch after a restart).
  - The renderer applies a focus request's `pageId` even when it skips the fit because the person interacted within `FOCUS_QUIET_MS`.
  - Test: `canvas_page add` with show, then `canvas_place_frame` with no page, puts the frame on the new page, both with a `focus` dep and without one.
- **A2. Another chat's change is never this chat's undo step** (Tasks 3 and 7). `designCanvas:updated` carries the origin `chatId`. The renderer records `aidenTurn` and `step` only when `update.chatId === chatId`; otherwise it records `null` (a change carried into every step). Test (`use-design-canvas.test.tsx`): after an update with chat A's `aidenTurn`, undo in chat B leaves A's frames in place and B's redo stack survives.
- **A3. Comment tray filtered by chat in 1a, not 1b** (Tasks 2 and 7).
  - `queuedComments(doc, chatId)` and `markCommentsSent(doc, ids, sentAt, chatId)` consider only comments with `comment.chatId === chatId`. Comments without a `chatId` are none in v3, because the wipe removes v1/v2 documents.
  - The tray, its badge and send all use the filtered list.
  - Test: two chats each queue comments, and each tray and send shows only its own.
- **A4. Main keeps a chat's last page after its canvas unmounts** (Tasks 4 and 5).
  - `set(..., null)` marks the canvas unmounted but keeps the last `pageId` and viewport; `mounted()` counts only mounted canvases.
  - The per-message `DesignViewState` (`canvas-summary.ts:20`) gains an optional `pageId`, and `parseDesignViewState` accepts that key (it refuses unknown keys today).
  - *(Revised in round 2.)* The page tools use, in order: a page Aiden showed earlier in this turn (A1), then the message's `pageId`, then the registry's kept page, then the first page. `canvasPromptLine` uses the same order minus the first step.
  - Test: unmount, then a background placement for that chat lands on its last page.
- **A5. Views keyed by chat, ordered by `focusId`, and cleaned up** (Task 4). *(Revised in round 2: Aiden has a single main window (`main/index.ts` `mainWindow`), and quick chat and the pill never mount design UI, so per-window keying is dropped.)*
  - `DesignCanvasViews` stores one view per `chatId`, with a `mounted` flag and the `focusId` (A1).
  - When the main window is destroyed, every view is marked unmounted; pages are kept.
  - A `null` report skips `requireChat` (it only validates the id), so an unmount after delete still marks the view unmounted.
  - `forget(chatId)` runs on chat delete, beside the other per-chat cleanups in `chat-application-service-main.ts`.
  - Tests: a report echoing an older `focusId` is ignored; switching chats A→B→A in one window restores A's kept page.
- **A6. Artifact swap stays within its chat; the Code tab reads through the owner** (Tasks 6 and 8).
  - `artifact-frames.ts`'s same-title swap only matches frames whose `chatId` equals the acting chat.
  - `designCanvas:source` reads an artifact through `frame.chatId ?? chat.id`, with the same workspace check as preview and export.
  - Tests: chat B's same-title visual places a new frame instead of swapping chat A's; the Code tab of A's artifact opened from B shows its source.
- **A7. Focus without a page finds the frames' page** (Task 7). When a focus request has no `pageId`, the renderer takes it from the first focused frame's `pageId` in the document. Main's own senders (`designPagesOnEntry` in `chat-application-service-main.ts:62`, `placeImages` in `llm-client.ts`) also include `pageId`. Test: focus with frames on another page switches to it and fits them.
- **A8. Attaching a No workspace chat keeps its canvas when its files come along** (Task 8). *(Revised in round 2.)*
  - When: only when `attachToWorkspace` copies the files (`fileAction === "copy"`) and the hidden folder is not a legacy shared scratch (`sharedLegacyScratch` false, `chat-application-service.ts` ~582). Otherwise the hidden canvas is not merged; it is deleted with the hidden workspace (A13), and PRODUCT.md says that attaching without copying files leaves the canvas behind.
  - How: `appendCanvasPages(target, source, { label, pathMap, newId })` in `pages.ts`.
    - Each source page with frames becomes a new target page named `"<chat title> · <page name>"`.
    - Frame and comment ids are kept, and re-id'd only on a collision, with `groupId`, `frameId` and connector links remapped. That keeps the chat's earlier tool calls valid.
    - `file` and `image` frame paths are rewritten through `pathMap`, built from the attach's `copiedPaths`; frames whose file wasn't copied are dropped.
    - `chatPages` is not copied.
  - Within the limits it's all or nothing. Over a limit, nothing is merged.
  - After a merge, main calls `designCanvasViews.showPage(chatId, firstMergedPageId)`.
  - Tests: two pages with a group and a comment merge with links intact and ids kept; a path renamed into `aiden-scratch/` is rewritten; over the limit, the target is unchanged.
- **A9. One workspace id per operation** (Task 3).
  - The handler resolves the workspace once, from the chat it checked: `persistedChatWorkspaceId(chat.workspaceId)`.
  - Store calls take that id. `DesignChatCanvases` methods return `{ doc | result, workspaceId }`, and the broadcast uses the returned id rather than resolving again.
  - `saveDesignCanvas` sends the renderer's expected `workspaceId`. *(Revised in round 2.)* When it differs from the chat's current workspace, main answers `{ok: false, reason: "moved"}`. The renderer treats that as final: it drops the session's unsent edits, clears its guard state (so quit doesn't ask about them) and remounts. The canvas is keyed `${workspaceId}:${chatId}` in `design-canvas-region.tsx`.
  - Test: a save that names W1 for a chat now in W2 returns `moved`, and W2's file is unchanged; the renderer session drops its edits and reports no unsaved work.
- **A10. Entry placement checks the chat's page, not the whole canvas** (Task 6). `written-pages.ts`'s `onlyIfEmpty` tests `framesOnPage(doc, targetPage).length > 0`, where the target page is the chat's page in A4's order. *(Added in round 2.)* When the chat has no view at all and that page has frames, the entry adds a new page named after the chat title, places onto it, and calls `designCanvasViews.showPage` for it. This is a claim without `chatPages`; 1b turns it into a real `chatPages` claim. Test: chat B, with no view, enters a workspace whose first page holds chat A's frames; a new page named after B is created, holds B's written pages, and is B's view page. Reword PRODUCT.md's "landing on an empty canvas" to "landing on the chat's empty page".
- **A11. The renderer normalizes the workspace id** (Task 7). The update filter and the `localStorage` key use `persistedChatWorkspaceId(chat.workspaceId)`, so legacy chats match `"default"`.
- **A12. One shared layout promise; the 1b handoff** (Task 3).
  - `ensureLayout` is a single promise per store instance, so concurrent first calls on different workspace chains run the wipe once.
  - 1b note: `viewPageId` will gain the `chatPages[chatId]` fallback between the view and the first page (§6.1).

Round 2 (a fresh adversarial review of the amended plan and spec) revised A1, A4, A5, A8, A9 and A10 above and added:

- **A13. Lifecycle items moved from 1b into 1a** (Task 8). Without them 1a regresses cleanup.
  - Workspace `remove` (`workspace-application-service.ts` ~177) deletes `<workspaceId>.json` and its corrupt copies. That also covers a No workspace chat's hidden workspace released on delete.
  - Chat delete removes the deleted chat's comments (`comment.chatId === chatId`) from its workspace canvas, through the store's `update`.
  - Tests: removing a workspace deletes its canvas file; deleting chat A drops A's comments and leaves B's.
- **A14. Comments for Aiden are per chat too** (Task 5).
  - `canvas_read` lists only comments whose `chatId` is the acting chat.
  - `canvas_comment` refuses a comment whose `chatId` differs, with `"That comment belongs to another chat."`.
  - Test: chat B's `canvas_read` omits A's sent comment, and B's `canvas_comment` on it is refused.
- **A15. `addComment` requires `chatId`** (Task 2). The input's `chatId` is required, not optional, so `tsc` flags every caller and no queued comment is hidden from every tray.
- **A16. Small fixes.**
  - Task 3's `DesignCanvasUpdated` includes `chatId` (per A2).
  - `broadcastDesignCanvasUpdate` takes the workspace id the store call returned, instead of resolving it again (A9).
  - Task 7's file list includes `renderer/design/design-toolbar.tsx` (it uses `activeDesignPage`).
  - Review Focus 1 reads "one window switching between two chats on one workspace".

---

### Task 1: v3 schema and the view type

**Files:**
- Modify: `renderer/shared/design-canvas/schema.ts`
- Create: `renderer/shared/design-canvas/view.ts`
- Test: `renderer/shared/design-canvas/schema.test.ts`, create `renderer/shared/design-canvas/view.test.ts`

**Interfaces:**
- Produces:
  - `DesignCanvas = { version: 3; revision; pages: DesignPage[]; chatPages: Record<string, string>; frames; comments; removedPagePaths? }`.
  - `DesignPage = { id: string; name: string }`.
  - `DesignArtifactFrame.chatId?: string`, `DesignComment.chatId?: string`.
  - `DESIGN_CANVAS_LIMITS.pages = 200`, `.frames = 4000`, `.comments = 2000`.
  - `framesOnPage(doc, pageId: string)` (the argument is required).
  - `frameShowingDesignPage(doc, path, pageId?: string)` prefers `pageId`'s frame, otherwise the first in document order.
  - Removed: `activeDesignPage`, `withActiveViewport`.
  - `view.ts`:
    - `DesignChatView = { pageId: string; viewport: DesignViewport; size?: { w: number; h: number } }`;
    - `parseDesignChatView(value: unknown): DesignChatView | null`;
    - `viewPageId(doc: Pick<DesignCanvas, "pages">, view?: { pageId?: string } | null): string`, which returns the view's page when it exists, otherwise `doc.pages[0].id`;
    - `DESIGN_FRESH_VIEWPORT = { x: 0, y: 0, zoom: 1 }`.

- [x] **Step 1: Write failing tests**
  - `schema.test.ts`:
    - `parses a v3 document and keeps chatPages entries that name existing pages and safe chat ids`: an entry pointing at a missing page and one with chat id `"../x"` are dropped.
    - `refuses version 1 and 2 documents`: `ok: false`.
    - `drops activePageId and page viewports from input`: the parsed pages have exactly the keys `id` and `name`.
    - `keeps chatId on artifact frames and comments only when it is a safe chat id`.
    - `caps pages at 200, frames at 4000 and comments at 2000`.
    - Update existing cases that build v2 docs to build v3 docs through `emptyDesignCanvas()`.
  - `view.test.ts`:
    - `viewPageId falls back to the first page when the view's page is gone, or there is no view`.
    - `parseDesignChatView clamps zoom to 0.1–4 and refuses a missing pageId or a non-finite viewport`.
- [x] **Step 2:** Run `npx tsx --test renderer/shared/design-canvas/schema.test.ts renderer/shared/design-canvas/view.test.ts`. Expected: FAIL.
- [x] **Step 3:** Implement.
  - Safe chat id: reuse the regex from `store.ts` (`/^[A-Za-z0-9._:-]{1,160}$/u`), exported from `schema.ts` as `isDesignChatId`, so the store and the schema share it.
  - `parseViewport` moves to `view.ts`.
- [x] **Step 4:** Rerun. Expected: PASS. `npx tsc -p renderer --noEmit` now lists every caller to fix in Tasks 2–8. Don't fix them here.
- [x] **Step 5:** Commit `feat(design): canvas document v3 with chat pages and no view state`.

### Task 2: Shared helpers take an explicit page

**Files:**
- Modify:
  - `renderer/shared/design-canvas/pages.ts`
  - `placement.ts`, `comments.ts`, `layers.ts`, `canvas-summary.ts`, `connectors.ts` (if it reads the active page)
  - `renderer/design/canvas-adapter-core.ts`, `renderer/design/canvas-history-core.ts`
- Test: the matching `*.test.ts` beside each file.

**Interfaces:**
- Consumes: Task 1.
- Produces:
  - `addPage(doc, id, name?, after?: string)`: inserts after `after` (default: the end) and does not change any view.
  - `showPage`: deleted. Showing a page is a view change.
  - `duplicatePage(doc, id, pageId, newFrameId)`: unchanged signature, without the view copy.
  - `deletePage(doc, id)`: also drops `chatPages` entries that pointed at it (1b adds reassignment).
  - `placeFrame(doc, frame & { pageId: string }, view, newId)`: `pageId` is required.
  - `addComment(doc, input & { pageId: string; chatId?: string })`: a frame's page still wins over `pageId`.
  - `layerRows(doc, pageId)` (or the existing name, given a `pageId`).
  - `canvasView(doc, view: DesignChatView | undefined, size?)`: the viewport is `view?.viewport ?? DESIGN_FRESH_VIEWPORT`. A view whose `pageId` differs from the page asked about uses the fresh viewport.
  - `describeCanvas(doc, { pageId, view, ... })`: `onScreen` is `page.id === viewPageId(doc, view)`.
  - `canvasPromptLine(doc, view: DesignChatView | undefined, selection?)`.
  - `adaptCanvas(doc, pageId, ...)` in `canvas-adapter-core.ts`.
  - `changesBetween` in `canvas-history-core.ts`: stops tracking `activePageId` and viewports. It still takes page names and order whole when they changed.

- [x] **Step 1: Write failing tests**
  - `pages.test.ts`:
    - `addPage inserts after the given page and leaves chatPages alone`;
    - `deletePage drops chatPages entries for the deleted page`.
  - `canvas-summary.test.ts`:
    - `canvasView uses the chat view's viewport only for the view's own page`;
    - `canvasPromptLine marks the chat's view page as on screen`.
  - `canvas-history-core.test.ts`: `undo after another chat switched pages does not change any page` (a doc with two pages: undoing a frame move must leave `pages` deep-equal).
  - `placement.test.ts` / `comments.test.ts`: `placeFrame puts the frame on the given page`; `addComment stamps chatId`.
- [x] **Step 2:** Run each test file. Expected: FAIL.
- [x] **Step 3:** Implement. Delete the tests that only covered `showPage` or active-page tracking, and replace them with the cases above.
- [x] **Step 4:** Run `npx tsx --test renderer/shared/design-canvas/*.test.ts renderer/design/canvas-*-core.test.ts`. Expected: PASS.
- [x] **Step 5:** Commit `refactor(design): canvas helpers take the page explicitly`.

### Task 3: Workspace-keyed store, chat adapter, workspace broadcast

**Files:**
- Modify:
  - `main/services/design-canvas/store.ts`
  - `main/services/design-canvas/main.ts`
  - `main/handlers/design-canvas.ts`, `main/handlers/design-canvas-main.ts`
- Test: `main/services/design-canvas/store.test.ts`, `main/handlers/design-canvas.test.ts`

**Interfaces:**
- Consumes: Task 1.
- Produces:
  - `DesignCanvasStore`: same methods, keyed by workspace id. `assertDesignCanvasWorkspaceId(id)` replaces `assertDesignCanvasChatId` for the store (`assertDesignCanvasChatId` stays for handlers). It gains a private `ensureLayout()`, run once per instance before the first read or delete:
    - if `<root>/.layout-v3` is missing, remove every entry in `root`;
    - then write `.layout-v3`.
  - `DesignChatCanvases` (new, in `store.ts`):
    - constructed with `new DesignChatCanvases({ store, workspaceIdOf(chatId): Promise<string | null> })`;
    - exposes `get(chatId)`, `save(chatId, doc, base, options)`, `update(chatId, mutate, options)` and `workspaceIdOf(chatId)`;
    - each method throws `"This chat is no longer available."` when `workspaceIdOf` returns null.
  - Production: `designCanvasStore` (exported from `main.ts`) becomes the `DesignChatCanvases` instance, with `workspaceIdOf = async (id) => { const meta = await chatStore.getMeta(id); return meta ? persistedChatWorkspaceId(meta.workspaceId) : null; }`. The raw workspace store is exported as `designWorkspaceCanvasStore`.
  - `DesignCanvasUpdated = { workspaceId: string; chatId: string; revision: number; aidenTurn?: string; step?: string }`.
  - Callers keep calling `broadcast({chatId, revision, aidenTurn?, step?})`. A new `broadcastDesignCanvasUpdate(update)` in `main.ts` resolves the workspace through `designCanvasStore.workspaceIdOf` and sends the workspace payload. Its failures are logged and never thrown.

- [x] **Step 1: Write failing tests**
  - `store.test.ts`:
    - `two chats of one workspace read and write the same document`, through `DesignChatCanvases` with a fake `workspaceIdOf`;
    - `chats of different workspaces get different documents`;
    - `first access removes v2 per-chat files and writes the layout marker, once`: seed `chat-1.json` with a v2 doc and `chat-1.json.corrupt-1`, call `get`, assert both are gone and `.layout-v3` exists; seed another file afterwards, call again, and assert it survives;
    - `a v2 document at a workspace path is set aside as corrupt`;
    - `refuses workspace ids that fail isWorkspaceArtifactWorkspaceId`.
  - `design-canvas.test.ts` (handler): `a save broadcasts the chat's workspace id`. With a registered fake whose broadcast records payloads, saving through chat A yields `{workspaceId: "ws-1", revision: 1}`.
- [x] **Step 2:** Run `npx tsx --test main/services/design-canvas/store.test.ts main/handlers/design-canvas.test.ts`. Expected: FAIL.
- [x] **Step 3:** Implement. Rename the store's internal `chatId` parameters to `workspaceId`. Update the file header comment.
- [x] **Step 4:** Rerun. Expected: PASS.
- [x] **Step 5:** Commit `feat(design): one canvas file per workspace`.

### Task 4: Main view registry and `designCanvas:view`

**Files:**
- Create: `main/services/design-canvas/views.ts`
- Modify: `main/handlers/design-canvas.ts`, `main/services/design-canvas/main.ts`, `renderer/preload-channels.ts`, `renderer/lib/ipc.ts`
- Test: create `main/services/design-canvas/views.test.ts`, extend `main/handlers/design-canvas.test.ts`

**Interfaces:**
- Consumes: Task 1 `DesignChatView`, `parseDesignChatView`. Task 3 `DesignChatCanvases.workspaceIdOf`.
- Produces:
  - `class DesignCanvasViews`:
    - `set(chatId: string, workspaceId: string, view: DesignChatView | null): void` (null means the canvas unmounted);
    - `get(chatId): DesignChatView | undefined`;
    - `mounted(workspaceId): number`, the count of chats with a non-null view, for Phase 2's presence rule;
    - `forget(chatId): void`.
  - Exported singleton `designCanvasViews` from `main.ts`.
  - IPC `designCanvas:view (chatId, view | null)`:
    - `requireChat`;
    - a view that fails `parseDesignChatView` throws `"Invalid canvas view."`;
    - `null` clears it.
  - Renderer `designCanvasApi.reportDesignCanvasView(chatId, view | null): Promise<void>`.

- [x] **Step 1: Write failing tests**
  - `views.test.ts`: `mounted counts only chats with a view on that workspace`; `set null marks the view unmounted but keeps its page; forget drops the chat`.
  - Handler: `designCanvas:view stores a parsed view and refuses a malformed one`; `designCanvas:view refuses a Bot chat`.
- [x] **Step 2:** Run them. Expected: FAIL.
- [x] **Step 3:** Implement. When the main window is destroyed, mark every view unmounted (A5).
- [x] **Step 4:** Rerun. Expected: PASS. Register `views.test.ts` in `scripts/ci-test-registry.json` and the `package.json` script that holds the other `design-canvas/*.test.ts` files, then run `npm run test:ci-policy`.
- [x] **Step 5:** Commit `feat(design): main keeps each chat's canvas view`.

### Task 5: Canvas tools and prompt read the chat's view; focus carries the page

**Files:**
- Modify:
  - `main/services/design-canvas/canvas-tools.ts`
  - `main/services/llm-client.ts` (the canvas wiring near lines 2714, 2972, 3009, 3082, 3114 and 3179)
  - `renderer/design/canvas-focus-requests.ts`
- Test: `main/services/design-canvas/canvas-tools.test.ts`, `renderer/design/canvas-focus-requests` cases in an existing renderer design test, or a new `canvas-focus-requests.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 2 and 4.
- Produces:
  - `DesignCanvasToolDeps.view?(): DesignChatView | undefined`.
  - `DesignCanvasToolDeps.focus?(request: { pageId?: string; frameIds: string[] }): void`.
  - `CanvasFocusRequest = { ids: string[]; pageId?: string; at: number }`. `canvasFocusFrom` keeps `pageId` when it is a string.
- Behaviour:
  - `pageOf(doc, value, view)` defaults to `viewPageId(doc, view)`.
  - `onScreen` compares with the view page.
  - `canvas_page show` (and `add` with `show !== false`) calls `focus({pageId, frameIds: []})` instead of writing the document.
  - `canvas_focus` and `canvas_arrange` include the frames' page.
  - Placement into a page that isn't on screen does not move the person's view unless the tool's `focus` / `show` asks for it, exactly as today.
  - `withEnteredCanvasTools` and the `viewState` selection keep working. `viewState.viewSize` still wins over `view().size` for this turn.
  - Artifact frames placed through tools stamp `chatId: deps.chatId`.

- [ ] **Step 1: Write failing tests.** In `canvas-tools.test.ts`, convert the 22 `activePageId` assertions to the view and focus calls they now make, and add:
  - `canvas_read lists the chat's view page as on screen`;
  - `canvas_page show sends focus with the page and leaves the document unchanged`, asserting that the store's revision did not move;
  - `with no view the tools use the first page`;
  - `two chats with different views read different on-screen pages from one document`.
  - Focus parse: `canvasFocusFrom keeps a string pageId and drops anything else`.
- [ ] **Step 2:** Run `npx tsx --test main/services/design-canvas/canvas-tools.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement. In `llm-client.ts`:
  - pass `view: () => designCanvasViews.get(params.chatId)`;
  - make `focus` send `{chatId, pageId, frameIds}`;
  - call `canvasPromptLine(doc, designCanvasViews.get(chatId), selection)`.
- [ ] **Step 4:** Rerun the tool tests and `npx tsx --test main/services/llm-client*.test.ts` for the touched wiring. Expected: PASS.
- [ ] **Step 5:** Commit `feat(design): canvas tools follow the chat's own view`.

### Task 6: Placement services use the chat's page

**Files:**
- Modify:
  - `main/services/design-canvas/artifact-frames.ts`
  - `main/services/design-canvas/written-pages.ts`
  - `main/handlers/design-canvas.ts` (`designCanvas:placeArtifact`)
  - `main/services/chat-application-service-main.ts:62`
- Test: `artifact-frames.test.ts`, `written-pages.test.ts`, `main/handlers/design-canvas.test.ts`

**Interfaces:**
- Consumes: Tasks 2, 4 and 5.
- Each service gains `view?(): DesignChatView | undefined` (production: `designCanvasViews.get(chatId)`) and places on `viewPageId(doc, view)`.
- Dedupe compares against that page.
- Artifact frames are stamped with `chatId`.
- `placeArtifact`'s "already on another page" no longer calls `showPage`. It returns `{status: "already", frameId, page}`, and the handler sends `designCanvas:focus {chatId, pageId, frameIds: [frameId]}` to the asking window.

- [ ] **Step 1: Write failing tests**
  - `artifact frame lands on the chat's view page and carries chatId`;
  - `written page dedupes only against the chat's view page`;
  - `placeArtifact on another page focuses that page without changing the document`.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Rerun. Expected: PASS.
- [ ] **Step 5:** Commit `feat(design): placements land on the acting chat's page`.

### Task 7: Renderer view store, canvas and sync

**Files:**
- Create: `renderer/design/canvas-view-store.ts`
- Modify:
  - `renderer/design/use-design-canvas.ts`
  - `renderer/design/design-canvas.tsx`
  - `renderer/design/design-comments.tsx`
  - `renderer/design/design-side-panel.tsx`
  - the component that mounts the canvas with `chatId`, which now also passes `workspaceId` (`renderer/design/design-canvas-region.tsx`)
- Test: create `renderer/design/canvas-view-store.test.ts`, extend `renderer/design/use-design-canvas.test.tsx`, `renderer/design/design-canvas.test.tsx`

**Interfaces:**
- Consumes: Tasks 1, 4 and 5.
- Produces:
  - `readDesignView(workspaceId, chatId): { pageId?: string; viewports: Record<string, DesignViewport> }`;
  - `writeDesignView(workspaceId, chatId, value)`.
  - Both are wrapped in try/catch. A non-object or junk value reads as `{viewports: {}}`. Viewports are capped at the 200 page limit, dropping the oldest.
  - `useDesignView({ workspaceId, chatId, doc })` returns `{ pageId: string; viewport: DesignViewport; showPage(id): void; setViewport(v): void; setSize(s): void }`:
    - `pageId` is `viewPageId(doc, stored)`;
    - it reports `{pageId, viewport, size}` through `reportDesignCanvasView` (250 ms debounce) and reports `null` on unmount.
  - `useDesignCanvas(workspaceId, chatId)`:
    - the sync ignores `designCanvas:updated` whose `workspaceId` differs;
    - `viewsMoved`/`withViews` are deleted;
    - panning never reaches `change()`.
- In `design-canvas.tsx`, every `doc.activePageId` and `activeDesignPage(doc).viewport` becomes `view.pageId` / `view.viewport`. The page picker calls `view.showPage`. A focus request with `pageId` calls `view.showPage(pageId)` before fitting.

- [ ] **Step 1: Write failing tests**
  - `canvas-view-store.test.ts`:
    - `round-trips a view per workspace and chat`;
    - `reads junk and a throwing localStorage as an empty view`.
  - `use-design-canvas.test.tsx`:
    - `an update for another workspace is ignored and one for this workspace refetches`;
    - `panning does not save`, asserting no `saveDesignCanvas` call after advancing past `DESIGN_CANVAS_SAVE_DELAY_MS`.
  - `design-canvas.test.tsx`:
    - `shows the first page when the stored page no longer exists`;
    - `switching pages does not create an undo step`.
- [ ] **Step 2:** Run `npx tsx --test renderer/design/canvas-view-store.test.ts renderer/design/use-design-canvas.test.tsx renderer/design/design-canvas.test.tsx`. Expected: FAIL.
- [ ] **Step 3:** Implement. Register the new test file (CI registry and `package.json`).
- [ ] **Step 4:** Rerun, then `npx tsc --noEmit -p renderer` and `-p main`. Expected: PASS, with no type errors left from Task 1.
- [ ] **Step 5:** Commit `feat(design): each chat keeps its own page and view`.

### Task 8: Artifact ownership, chat delete, E2E and docs

**Files:**
- Modify:
  - `renderer/design/nodes/artifact-node.tsx:52`: load with `frame.chatId ?? canvas.chatId`.
  - `main/handlers/design-canvas.ts`: preview and export of an artifact frame use `frame.chatId ?? chat.id`, refused unless that chat exists and shares the asking chat's workspace.
  - `main/services/chat-application-service.ts:795,812` and `main/index.ts:2598`: chat delete no longer deletes a canvas file. 1b adds pruning.
  - `tests/e2e/design-canvas.spec.ts`: seed `design-canvases/<workspaceId>.json` and `.layout-v3`.
  - `tests/e2e/design-mode.spec.ts`: switch to the v3 key wherever it touches files.
  - `PRODUCT.md` design-mode paragraph and `README.md` line 55, if it implies a per-chat canvas.
  - `docs/plans/README.md` row, `.memory/design-mode.md`.
- Test: `main/handlers/design-canvas.test.ts`, `main/services/chat-application-service*.test.ts`

- [ ] **Step 1: Write failing tests**
  - `artifact preview through another chat of the same workspace works, and of another workspace is refused`;
  - `deleting a chat leaves the workspace canvas file in place` (chat application service, with a fake store recording calls: `delete` is never called).
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4: Verify the whole phase**
  - Run `npm run test`. Expected: PASS.
  - Run `npm run test:e2e:space -- tests/e2e/design-canvas.spec.ts tests/e2e/design-mode.spec.ts`. Expected: PASS.
  - Run `npm run lint`, if the repo has it. Expected: clean.
  - Take screenshots of the canvas with two pages, for the PR body.
- [ ] **Step 5: Docs**
  - `PRODUCT.md`: "Design mode keeps one canvas per workspace, shared by its chats; each chat remembers its own page and view. Canvases from earlier versions are cleared on first start; files under `design/` are untouched."
  - The same sentence in the release notes when the version is cut.
  - Commit `feat(design): shared workspace canvas with per-chat artifacts; docs`.
