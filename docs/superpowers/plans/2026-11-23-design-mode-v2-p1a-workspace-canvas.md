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
- File: `userData/design-canvases/<workspaceId>.json`. The workspace id must pass `isWorkspaceArtifactWorkspaceId` (`renderer/shared/workspace-artifacts.ts:265`). Chats without a folder resolve through `persistedChatWorkspaceId` to `"default"` and share that canvas.
- `version: 3`. `activePageId` and `pages[].viewport` are removed. `chatPages: Record<chatId, pageId>` is added: parsed and kept valid, but written by nothing until 1b.
- Optional `chatId` on artifact frames and on comments, stamped when they are created.
- Limits:
  - `pages` 200;
  - `frames` 4000, `framesPerPage` 400 (unchanged);
  - `comments` 2000;
  - 16 MiB document cap unchanged.
- Panning, zooming and switching pages never call `change()`, never save and are never undo steps.
- `localStorage` key: `aiden.design.view.<workspaceId>.<chatId>`. Every read and write goes in try/catch, and the canvas renders correctly without storage.
- `designCanvas:updated` payload: `{workspaceId, revision, aidenTurn?, step?}`. `designCanvas:focus` payload: `{chatId, pageId?, frameIds}`.
- Handlers keep `chatId` as their argument and authority check: an attended chat, with the design-mode rule each handler has today.
- Design mode stays desktop-only and out of the Remote projection.
- AGENTS.md:
  - no source-grep tests;
  - new test files are registered in `scripts/ci-test-registry.json` and a `package.json` test script, then `npm run test:ci-policy` is run;
  - docs change in this PR;
  - window-opening E2E runs through `npm run test:e2e:space`.

## Review Focus

1. **Two windows, one workspace.** A save from window A must reach window B on the same workspace through `{workspaceId}`, and B must refetch. Neither window may jump to the other's page. Test: Task 3 (handler broadcast) and Task 7 (sync filters on `workspaceId`).
2. **The view names a deleted page** (another chat deleted it). The canvas shows the first page and does not crash. Tools default to the first page. Test: Task 1 (`viewPageId`) and Task 7 (the canvas shows the first page).
3. **`localStorage` throws or holds junk** (private mode, a hand-edited value). The canvas opens on the first page at the default viewport. Test: Task 6.
4. **A stale v2 file at a workspace path** (a downgrade and re-upgrade, or a hand copy). Parse refuses it, and the store sets it aside as corrupt instead of crashing. Test: Task 2.
5. **Chat deleted while another chat on the workspace has the canvas open.** The shared file survives, and the deleted chat's artifact frames show their missing state rather than an error. Test: Task 8.

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

- [ ] **Step 1: Write failing tests**
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
- [ ] **Step 2:** Run `npx tsx --test renderer/shared/design-canvas/schema.test.ts renderer/shared/design-canvas/view.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
  - Safe chat id: reuse the regex from `store.ts` (`/^[A-Za-z0-9._:-]{1,160}$/u`), exported from `schema.ts` as `isDesignChatId`, so the store and the schema share it.
  - `parseViewport` moves to `view.ts`.
- [ ] **Step 4:** Rerun. Expected: PASS. `npx tsc -p renderer --noEmit` now lists every caller to fix in Tasks 2–8. Don't fix them here.
- [ ] **Step 5:** Commit `feat(design): canvas document v3 with chat pages and no view state`.

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

- [ ] **Step 1: Write failing tests**
  - `pages.test.ts`:
    - `addPage inserts after the given page and leaves chatPages alone`;
    - `deletePage drops chatPages entries for the deleted page`.
  - `canvas-summary.test.ts`:
    - `canvasView uses the chat view's viewport only for the view's own page`;
    - `canvasPromptLine marks the chat's view page as on screen`.
  - `canvas-history-core.test.ts`: `undo after another chat switched pages does not change any page` (a doc with two pages: undoing a frame move must leave `pages` deep-equal).
  - `placement.test.ts` / `comments.test.ts`: `placeFrame puts the frame on the given page`; `addComment stamps chatId`.
- [ ] **Step 2:** Run each test file. Expected: FAIL.
- [ ] **Step 3:** Implement. Delete the tests that only covered `showPage` or active-page tracking, and replace them with the cases above.
- [ ] **Step 4:** Run `npx tsx --test renderer/shared/design-canvas/*.test.ts renderer/design/canvas-*-core.test.ts`. Expected: PASS.
- [ ] **Step 5:** Commit `refactor(design): canvas helpers take the page explicitly`.

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
  - `DesignCanvasUpdated = { workspaceId: string; revision: number; aidenTurn?: string; step?: string }`.
  - Callers keep calling `broadcast({chatId, revision, aidenTurn?, step?})`. A new `broadcastDesignCanvasUpdate(update)` in `main.ts` resolves the workspace through `designCanvasStore.workspaceIdOf` and sends the workspace payload. Its failures are logged and never thrown.

- [ ] **Step 1: Write failing tests**
  - `store.test.ts`:
    - `two chats of one workspace read and write the same document`, through `DesignChatCanvases` with a fake `workspaceIdOf`;
    - `chats of different workspaces get different documents`;
    - `first access removes v2 per-chat files and writes the layout marker, once`: seed `chat-1.json` with a v2 doc and `chat-1.json.corrupt-1`, call `get`, assert both are gone and `.layout-v3` exists; seed another file afterwards, call again, and assert it survives;
    - `a v2 document at a workspace path is set aside as corrupt`;
    - `refuses workspace ids that fail isWorkspaceArtifactWorkspaceId`.
  - `design-canvas.test.ts` (handler): `a save broadcasts the chat's workspace id`. With a registered fake whose broadcast records payloads, saving through chat A yields `{workspaceId: "ws-1", revision: 1}`.
- [ ] **Step 2:** Run `npx tsx --test main/services/design-canvas/store.test.ts main/handlers/design-canvas.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement. Rename the store's internal `chatId` parameters to `workspaceId`. Update the file header comment.
- [ ] **Step 4:** Rerun. Expected: PASS.
- [ ] **Step 5:** Commit `feat(design): one canvas file per workspace`.

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

- [ ] **Step 1: Write failing tests**
  - `views.test.ts`: `mounted counts only chats with a view on that workspace`; `set null clears the view but forget drops the chat`.
  - Handler: `designCanvas:view stores a parsed view and refuses a malformed one`; `designCanvas:view refuses a Bot chat`.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement. Clear the chat's view when the window that reported it is destroyed: register `sender.once("destroyed")` the first time each sender reports.
- [ ] **Step 4:** Rerun. Expected: PASS. Register `views.test.ts` in `scripts/ci-test-registry.json` and the `package.json` script that holds the other `design-canvas/*.test.ts` files, then run `npm run test:ci-policy`.
- [ ] **Step 5:** Commit `feat(design): main keeps each chat's canvas view`.

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
