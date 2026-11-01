# Design mode P2: canvas, frames and the `aiden-design:` scheme — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The empty canvas region from P1 becomes a working infinite canvas. People can pan, zoom, select, move, resize, duplicate, delete and undo. They can add notes, groups, workspace images and workspace HTML files as frames. File frames render live and sandboxed from a new `aiden-design:` scheme, reload when the file changes, and fall back to snapshots outside a small live set. The canvas persists per chat in main.

**Architecture:**
- **Document:** a versioned JSON document per chat, owned by a main-process store with compare-and-swap revisions and atomic writes. It mirrors the Create Images `ImageWorkflowStore`.
- **Renderer:** a pure adapter maps the document to xyflow nodes for `StudioCanvas`. A controller hook saves with an 800 ms debounce and the base revision. A pure undo stack records canvas edits.
- **Scheme:** a grant-scoped custom protocol serves workspace files with realpath containment, a no-network CSP, the vendored libraries, and an injected bridge (P2 sends only `ready` and `resize`).
- **Live frames:** a pure live-set selector caps live iframes at 6. Everything else shows a `capturePage` snapshot.

**Tech Stack:** Electron (`protocol.handle`, `webContents.capturePage`, `fs.watch`), React 19, @xyflow/react 12 (`NodeResizer`), TanStack Query, `tsx --test`, Testing Library, Playwright.

**Spec:** [`docs/superpowers/specs/2026-10-31-design-mode-design.md`](../specs/2026-10-31-design-mode-design.md) §5.1–§5.5 and §5.7 (the bridge only as far as `ready` and `resize`), and §7 (Canvas IPC).

## Global Constraints

- P0 and P1 have landed on the branch. Everything here is behind capability `designMode` (`AIDEN_EXPERIMENTAL_DESIGN_MODE`). With the flag off, the scheme is not registered, the IPC handlers are not registered, and no canvas file is written.
- **Document limits:**
  - At most 200 frames and 500 comments.
  - Frame size is clamped to 40–8 000 px; coordinates to ±1 000 000.
  - Zoom is clamped to 0.1–4.
  - A title is at most 120 characters; note text at most 2 000.
- **Design widths:** 390, 768, 1280 (default) and 1440.
- **Live frames:**
  - At most 6 at once.
  - Below 25 % zoom no frame is live.
  - The file watch is debounced by 150 ms.
- **Scheme:**
  - URL form: `aiden-design://<grant>/<relative-path>`. A grant is 32 random bytes, base64url encoded.
  - Files above 8 MiB are refused.
  - Dotfiles and dot-folders are refused.
  - Allowed extensions: `.html .htm .css .js .mjs .json .svg .png .jpg .jpeg .gif .webp .woff .woff2 .txt`.
  - CSP, exactly as in spec §5.4: `default-src 'none'; script-src aiden-design: 'unsafe-inline'; style-src aiden-design: 'unsafe-inline'; img-src aiden-design: data: blob:; font-src aiden-design: data:; media-src aiden-design: blob:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'`.
  - Headers on every response: `cache-control: no-store` and `x-content-type-options: nosniff`.
  - Iframes use `sandbox="allow-scripts"` only.
- **Storage:** `userData/design-canvases/<chatId>.json`, file mode 0600, directory mode 0700, written with `writeJsonAtomic` from `main/services/durable-fs.ts`.
- **No network** anywhere in this phase.
- **UI:** follow `GUI.md`, `docs/design-guide.md`, the squircle button treatment and the semantic tokens. Review `docs/chatgpt-desktop-ui-inspiration.md` and `docs/chatgpt-ui-element-specimen.html` first. Frames have no decorative borders: selection uses the existing canvas selection treatment, and focus-visible rings are kept. Do not use brain icons.
- **Tests:** behavioral only (AGENTS.md "Tests"). New test files go in a `test:design-mode` script (created in P1) and in `scripts/ci-test-registry.json`. Run `npm run test:ci-policy`.
- **Screenshots and E2E:** take screenshots of every new UI, light and dark. Window-opening tests run through `npm run test:e2e:space`.

## Review Focus

1. **A symlink inside the workspace that points outside it** (`design/escape -> /Users/x/.ssh`), or `design/../../etc/hosts` URL-encoded as `%2e%2e`: the scheme answers 404 and never reads the target. Tests are in Task 3.
2. **A frame whose HTML calls `fetch("https://…")`, submits a form, calls `window.open`, sets `top.location` or embeds an iframe:** each is blocked, and the main window does not navigate. A Playwright containment test is in Task 7.
3. **The same chat open in two windows, both moving frames:** the second save gets `conflict`, reloads the document and reapplies its own pending change, so neither window's move is lost. A test is in Task 4.
4. **40 file frames on the canvas while the person pans quickly:** at most 6 iframes exist in the DOM at any moment, and a frame that just left the live set keeps its snapshot instead of flashing a skeleton. Tests are in Task 5.
5. **A file frame's file is deleted or renamed on disk:** the frame shows "File not found" with a **Remove frame** action. It is not blank and does not break the canvas. Tests are in Tasks 3 and 6.

---

### Task 1: Canvas document schema and parser

**Files:**
- Create: `renderer/shared/design-canvas/schema.ts`
- Test: `renderer/shared/design-canvas/schema.test.ts`

**Interfaces:**
- Produces: `DesignCanvasV1`, `DesignFrame`, `DesignComment` (exact shapes from spec §5.7), and:
  ```ts
  export const DESIGN_CANVAS_LIMITS: { frames: 200; comments: 500; minSize: 40; maxSize: 8000; maxCoord: 1_000_000; titleChars: 120; noteChars: 2000; minZoom: 0.1; maxZoom: 4 };
  export const DESIGN_WIDTHS: readonly [390, 768, 1280, 1440];
  export function emptyDesignCanvas(): DesignCanvasV1; // revision 0, viewport {0,0,1}
  export function parseDesignCanvasV1(value: unknown): { ok: true; doc: DesignCanvasV1; dropped: number } | { ok: false; issues: string[] };
  export function isDesignRelativePath(value: unknown): value is string; // lexical check only
  ```

- [ ] **Step 1: Write the failing tests.**
  - `parseDesignCanvasV1(emptyDesignCanvas())` is ok, with `dropped: 0`.
  - A frame with `kind: "page"` is dropped, and `dropped` counts it.
  - `w: 5` becomes 40, `w: 99999` becomes 8000, and `x: 5e9` becomes 1 000 000.
  - A `file` frame with `path` set to `"../a.html"`, `"/abs.html"`, `".git/config"`, `"design/.env"`, `"a\\b.html"` or `"a\u0000.html"` is dropped.
  - A `file` frame with `path` `"design/hero.html"` is kept.
  - 201 frames give 200, keeping the first 200.
  - A frame whose `groupId` names a missing group keeps the frame and removes the `groupId`.
  - Duplicate frame IDs keep the first occurrence.
  - `version: 2` and a non-object both give `ok: false`.
  - `viewport.zoom: 9` becomes 4.
  - A note with 2 500 characters is cut to 2 000.
- [ ] **Step 2: Run the tests and confirm they fail.**
  - Run: `npx tsx --test renderer/shared/design-canvas/schema.test.ts`
  - Expected: FAIL. The module does not exist.
- [ ] **Step 3: Implement the module.** It is pure, with no Node imports, because the renderer and the CLI bundle may import it. `isDesignRelativePath` rejects an empty path, more than 1 024 characters, a NUL, a backslash, a leading `/` or drive letter, any `..` segment, and any segment that starts with `.`.
- [ ] **Step 4: Run the tests again.** Expected: PASS.
- [ ] **Step 5: Commit** with the message `Add design canvas document schema`.

### Task 2: Canvas store and IPC

**Files:**
- Create: `main/services/design-canvas/store.ts`, `main/handlers/design-canvas.ts`
- Modify:
  - `main/handlers/index.ts`, registered only when `designModeEnabled()`.
  - The chat deletion path: next to where generative-ui artifacts are cleared for a deleted chat (grep `deleteChat` in `main/handlers/chats.ts` and `main/services/chat-application-service.ts`).
  - `renderer/preload-channels.ts` and `renderer/lib/ipc.ts`.
- Test: `main/services/design-canvas/store.test.ts`, `main/handlers/design-canvas.test.ts`

**Interfaces:**
- Consumes: the Task 1 parser.
- Produces:
  ```ts
  export type DesignCanvasSaveResult = { ok: true; revision: number } | { ok: false; reason: "conflict"; doc: DesignCanvasV1 } | { ok: false; reason: "invalid"; issues: string[] };
  export class DesignCanvasStore {
    constructor(options: { root: () => string; writeJson?: typeof writeJsonAtomic; now?: () => number });
    get(chatId: string): Promise<DesignCanvasV1>;            // emptyDesignCanvas() when no file
    save(chatId: string, doc: DesignCanvasV1, baseRevision: number): Promise<DesignCanvasSaveResult>;
    update(chatId: string, mutate: (doc: DesignCanvasV1) => DesignCanvasV1): Promise<DesignCanvasV1>; // P3 tools use this
    delete(chatId: string): Promise<void>;
  }
  // IPC
  // "designCanvas:get"  (chatId) => DesignCanvasV1
  // "designCanvas:save" (chatId, doc, baseRevision) => DesignCanvasSaveResult
  // broadcast "designCanvas:updated" { chatId, revision }
  // renderer/lib/ipc.ts: getDesignCanvas, saveDesignCanvas, onDesignCanvasUpdated
  ```

- [ ] **Step 1: Write the failing tests.**
  - **Store:**
    - `get` on an unknown chat gives revision 0.
    - `save(id, doc, 0)` gives `{ok: true, revision: 1}`, and a new store on the same root reads it back.
    - `save(id, doc, 0)` a second time gives `conflict`, carrying the revision 1 document.
    - Two concurrent `save` calls with the same base give exactly one `ok`.
    - `update` gets serialised with `save` on the same chat.
    - `delete` removes the file, and a later `get` gives revision 0.
    - A chat ID that does not match the chat ID pattern throws before touching disk.
    - A corrupt JSON file gives `emptyDesignCanvas()` and leaves the file as it is.
    - A `writeJson` stub that throws leaves the revision unchanged.
  - **Handler** (register and invoke, as in `main/handlers/chat-renderer-mutations.test.ts`):
    - Malformed params are rejected.
    - A successful save broadcasts `designCanvas:updated` with the new revision.
    - Deleting a chat through the chat deletion path removes its canvas file.
    - With the flag off, no `designCanvas:` channel is registered.
- [ ] **Step 2: Run the tests and confirm they fail.**
  - Run: `npx tsx --test main/services/design-canvas/store.test.ts main/handlers/design-canvas.test.ts`
  - Expected: FAIL.
- [ ] **Step 3: Implement the store** with one promise chain per chat, as `ImageWorkflowStore` uses for `chains`. `save` validates through `parseDesignCanvasV1` and stores `revision = base + 1`. The store is created in `main/index.ts` next to the Create Images store, rooted at `path.join(app.getPath("userData"), "design-canvases")`.
- [ ] **Step 4: Run the tests again,** plus `npm run type-check`. Expected: PASS.
- [ ] **Step 5: Commit** with the message `Store design canvases per chat in main`.

### Task 3: The `aiden-design:` scheme

**Files:**
- Create:
  - `main/services/design-canvas/grants.ts`
  - `main/services/design-canvas/resolve-core.ts`
  - `main/services/design-canvas/protocol.ts`
  - `main/services/design-canvas/bridge-source.ts`: the bridge script as a string constant. P4 extends it.
- Modify:
  - `main/services/custom-schemes-core.ts`: add `DESIGN_SCHEME = "aiden-design"` with `LOCAL_CONTENT_PRIVILEGES`, behind `options.designMode`.
  - `main-window.html`: the CSP adds `aiden-design:` to `frame-src` and `img-src`.
  - The navigation guards in `main/index.ts` (grep `will-navigate` and `setWindowOpenHandler`): `aiden-design:` is refused as a top-level or popup destination.
  - `main/handlers/design-canvas.ts`: adds `designCanvas:grant`.
- Test:
  - `main/services/design-canvas/resolve-core.test.ts`
  - `main/services/design-canvas/grants.test.ts`
  - `main/services/design-canvas/protocol.test.ts`
  - `main/services/custom-schemes-core.test.ts`: extend it.

**Interfaces:**
- Produces:
  ```ts
  // grants.ts
  export class DesignGrantRegistry {
    issue(chatId: string, workspaceRoot: string): string;     // same chat+root → same grant while alive
    resolve(grant: string): { chatId: string; workspaceRoot: string } | null;
    revokeChat(chatId: string): void;
    revokeAll(): void;
  }
  // resolve-core.ts
  export type DesignResolveResult = { ok: true; absolute: string; mimeType: string; size: number } | { ok: false; status: 403 | 404 | 413 };
  export async function resolveDesignFile(workspaceRoot: string, urlPath: string): Promise<DesignResolveResult>;
  export function designUrl(grant: string, relativePath: string): string;
  // protocol.ts
  export function designResponse(request: { url: string }, deps: { grants: DesignGrantRegistry; readFile(p: string): Promise<Buffer>; readLibrary(name: string): Promise<{ bytes: Uint8Array; mimeType: string } | null> }): Promise<Response>;
  export function registerDesignProtocol(deps: …): void;
  // IPC "designCanvas:grant" (chatId) => { grant: string } | { error: "unavailable" }
  ```

- [ ] **Step 1: Write the failing tests.** Use real temp directories and real symlinks.
  - **`resolveDesignFile`:**
    - It serves `design/a.html` as `text/html; charset=utf-8`.
    - It decodes `design/my%20page.html`.
    - These give 404: `%2e%2e/secret.txt`; `design/escape.html` when that is a symlink to a file outside the root; `design/inner` when that is a symlinked directory outside the root and the request is `design/inner/x.html`; a missing file; a directory.
    - These give 403: `.git/config`, `design/.env` and `design/a.exe`.
    - A 9 MiB file gives 413.
    - A symlink that stays inside the root is served.
  - **Grants:**
    - `issue` is stable per chat and root.
    - A different root gives a new grant and revokes the old one.
    - `revokeChat` makes `resolve` give null.
    - A guessed grant gives null.
  - **`designResponse`:**
    - An HTML response carries the exact CSP string, `nosniff` and `no-store`.
    - Its body contains one `<script src="aiden-design://<grant>/__aiden/bridge.js">` right after `<head>` (or at the start when there is no `<head>`).
    - `__aiden/bridge.js` is served as `text/javascript`.
    - `__aiden/lib/chart.js` is served through `readLibrary`.
    - `__aiden/lib/unknown.js` gives 404.
    - An unknown grant gives 404.
    - A non-HTML file is served byte for byte, with no injection.
  - **`customSchemePrivileges({studioAssets: false, designMode: true})`** includes `aiden-design` with `bypassCSP: false` and `supportFetchAPI: false`. With `designMode: false` it does not.
- [ ] **Step 2: Run the tests and confirm they fail.**
  - Run: `npx tsx --test main/services/design-canvas/resolve-core.test.ts main/services/design-canvas/grants.test.ts main/services/design-canvas/protocol.test.ts main/services/custom-schemes-core.test.ts`
  - Expected: FAIL.
- [ ] **Step 3: Implement it.**
  - `resolveDesignFile` checks each segment against the Task 1 rules after decoding.
  - It realpaths the root and the target, and checks containment with `isPathInside` (as `main/services/generative-ui-extension.ts` does). It stats the target and requires `isFile()`.
  - The bridge for P2:
    1. It posts `{type: "aiden-design:ready", docHeight}` on load to `parent` with target `"*"` (the parent checks `event.source`).
    2. It posts `aiden-design:resize` from a `ResizeObserver` on `document.documentElement`, throttled to one per animation frame.
  - The library route reuses `readGenerativeUiHostLibrary`.
  - Grants are revoked when design mode turns off for a chat, when a chat's workspace changes and when the chat is deleted. Hook into the `setDesignMode` path from P1 and the chat deletion path from Task 2.
- [ ] **Step 4: Run the tests again,** plus `npm run type-check`. Expected: PASS.
- [ ] **Step 5: Commit** with the message `Serve workspace designs through a sandboxed aiden-design scheme`.

### Task 4: Renderer adapter, controller and undo

**Files:**
- Create:
  - `renderer/design/canvas-adapter-core.ts`: document ↔ xyflow nodes.
  - `renderer/design/canvas-history-core.ts`: undo and redo.
  - `renderer/design/canvas-keymap-core.ts`: design-only keys on top of `resolveCanvasKey`.
  - `renderer/design/use-design-canvas.ts`: query, debounced save, conflict handling and the update subscription.
- Test:
  - `renderer/design/canvas-adapter-core.test.ts`
  - `renderer/design/canvas-history-core.test.ts`
  - `renderer/design/canvas-keymap-core.test.ts`
  - `renderer/design/use-design-canvas.test.tsx`

**Interfaces:**
- Consumes: the Task 1 types and the Task 2 IPC client.
- Produces:
  ```ts
  export type DesignNode = Node<{ frame: DesignFrame }, DesignFrame["kind"]>;
  export function nodesFromCanvas(doc: DesignCanvasV1, selection: ReadonlySet<string>): DesignNode[]; // groups first so children render above
  export function applyNodeChanges(doc: DesignCanvasV1, changes: NodeChange<DesignNode>[]): DesignCanvasV1; // position, dimensions, remove
  export function placeFrame(doc: DesignCanvasV1, frame: Omit<DesignFrame, "id" | "x" | "y"> & Partial<Pick<DesignFrame, "x" | "y">>, view: { x: number; y: number; w: number; h: number }, newId: () => string): { doc: DesignCanvasV1; id: string }; // auto-place: right of the last frame in the group or the view, 64 px gap
  export function duplicateFrames(doc: DesignCanvasV1, ids: string[], newId: () => string): DesignCanvasV1; // +32,+32
  export interface CanvasHistory { past: DesignCanvasV1[]; future: DesignCanvasV1[] }
  export function record(h: CanvasHistory, before: DesignCanvasV1, limit?: number /* 100 */): CanvasHistory;
  export function undo(h: CanvasHistory, current: DesignCanvasV1): { history: CanvasHistory; doc: DesignCanvasV1 } | null;
  export function redo(h: CanvasHistory, current: DesignCanvasV1): { history: CanvasHistory; doc: DesignCanvasV1 } | null;
  export type DesignCanvasCommand = CanvasCommand | { type: "undo" } | { type: "redo" } | { type: "duplicate" } | { type: "delete" } | { type: "fitSelection" } | { type: "escape" };
  export function resolveDesignCanvasKey(event: CanvasKeyEvent, context: { editable: boolean; platform: "darwin" | "other" }): DesignCanvasCommand | null;
  export function useDesignCanvas(chatId: string): { doc: DesignCanvasV1 | undefined; status: "loading" | "ready" | "saving" | "error"; change(mutate: (doc: DesignCanvasV1) => DesignCanvasV1, opts?: { record?: boolean }): void; undo(): void; redo(): void; canUndo: boolean; canRedo: boolean };
  ```

- [ ] **Step 1: Write the failing tests.**
  - **Adapter:**
    - A position change on a framed child inside a group moves only that frame.
    - Moving a group moves its children by the same delta.
    - A dimensions change clamps to 40–8 000.
    - A remove change on a group removes the group and clears its children's `groupId`. The children stay.
    - `placeFrame` with no x or y and an empty canvas centres the frame in the view.
    - With frames in group G, `placeFrame` puts the new frame at the last frame's right edge plus 64, on the same top.
    - `placeFrame` keeps the frame count at most 200, giving `{error: "limit"}` past that. Add that variant to the return type.
  - **History:**
    - Undo after two recorded edits restores the first state, and redo restores the second.
    - A new edit after an undo clears `future`.
    - The limit 100 drops the oldest entry.
  - **Keymap:**
    - ⌘Z gives undo, ⇧⌘Z gives redo, ⌘D gives duplicate, Backspace and Delete give delete, Shift+2 gives fitSelection, and Escape gives escape. On `"other"`, Ctrl replaces ⌘.
    - Every one of them gives null when `editable` is true, so ⌘Z inside a note's textarea undoes text.
    - V, H, =, -, Shift+0, Shift+1 and M still resolve as in `resolveCanvasKey`.
  - **`useDesignCanvas`** (fake timers; IPC mocked at the `renderer/lib/ipc.ts` boundary):
    - Two `change` calls within 800 ms make one save, with the first revision as the base.
    - A `conflict` result replaces the base with the server document and reapplies the pending mutation once, then saves again (Review Focus 3).
    - A `designCanvas:updated` broadcast with a newer revision refetches when there is no pending edit, and is ignored while one is pending until it saves.
    - Unmounting with a pending edit flushes it immediately.
- [ ] **Step 2: Run the tests and confirm they fail.**
  - Run: `npx tsx --test renderer/design/canvas-adapter-core.test.ts renderer/design/canvas-history-core.test.ts renderer/design/canvas-keymap-core.test.ts renderer/design/use-design-canvas.test.tsx`
  - Expected: FAIL.
- [ ] **Step 3: Implement it.**
  - Follow `renderer/images/use-workflow-controller.ts` for the debounce and revision handling.
  - `change` records history only when `record !== false`. Continuous drags record once, on drag stop.
- [ ] **Step 4: Run the tests again.** Expected: PASS.
- [ ] **Step 5: Commit** with the message `Add design canvas controller, adapter and undo`.

### Task 5: Live set and snapshots

**Files:**
- Create: `renderer/design/live-set-core.ts`, `renderer/design/frame-snapshots.ts`
- Modify:
  - `main/handlers/design-canvas.ts`: adds `designCanvas:capture`.
  - `renderer/preload-channels.ts` and `renderer/lib/ipc.ts`.
- Test: `renderer/design/live-set-core.test.ts`, `renderer/design/frame-snapshots.test.ts`, and an extension to `main/handlers/design-canvas.test.ts`.

**Interfaces:**
- Produces:
  ```ts
  export const DESIGN_LIVE_LIMIT = 6;
  export const DESIGN_LIVE_MIN_ZOOM = 0.25;
  export function selectLiveFrames(input: { frames: DesignFrame[]; viewport: { x: number; y: number; zoom: number }; view: { w: number; h: number }; selected: ReadonlySet<string>; entered: string | null; previous: ReadonlySet<string> }): Set<string>;
  // IPC "designCanvas:capture" ({ x, y, width, height }) => { dataUrl: string } | { error: "unavailable" }   // the sender's own window only; clamps to the window bounds
  export function useFrameSnapshot(frameId: string): { snapshot: string | undefined; capture(rect: DOMRect): void };
  ```

- [ ] **Step 1: Write the failing tests.**
  - **`selectLiveFrames`:**
    - Only `file` and `artifact` frames are ever live.
    - Zoom 0.2 gives an empty set, even with a selection.
    - The entered frame is always live, at any zoom of 0.25 or more.
    - Selected frames come next, then the frames in view by the on-screen area they cover.
    - The set never exceeds 6: with 40 frames in view, the result has 6 members.
    - Hysteresis: a frame in `previous` that is still at least 50 % in view keeps its place over a newcomer of equal area, so a small pan does not swap it out (Review Focus 4).
    - Frames fully off-screen are never live unless entered or selected.
  - **Capture handler:**
    - It captures from the sender's `BrowserWindow`.
    - A rect is clamped to the content bounds.
    - A zero-size rect gives `error`.
    - The result is a `data:image/png;base64,` URL downscaled to at most 1 024 px on its longest side.
  - **`frame-snapshots`:** the cache keeps at most 60 snapshots (least recently used), keyed by frame ID plus file version, and a version bump invalidates.
- [ ] **Step 2: Run the tests and confirm they fail.**
  - Run: `npx tsx --test renderer/design/live-set-core.test.ts renderer/design/frame-snapshots.test.ts main/handlers/design-canvas.test.ts`
  - Expected: FAIL.
- [ ] **Step 3: Implement it.** Capture uses `webContents.capturePage(rect)`, then `image.resize` when it is larger than 1 024.
- [ ] **Step 4: Run the tests again.** Expected: PASS.
- [ ] **Step 5: Commit** with the message `Cap live design frames and snapshot the rest`.

### Task 6: Frame nodes, file watch and the canvas UI

**Files:**
- Create:
  - `renderer/design/design-canvas.tsx`: replaces the P1 empty `StudioCanvas` inside `DesignCanvasRegion`.
  - `renderer/design/nodes/registry.ts`, `note-node.tsx`, `group-node.tsx`, `image-node.tsx`, `file-node.tsx`, `artifact-node.tsx`.
  - `renderer/design/design-add-menu.tsx`.
  - `main/services/design-canvas/watch.ts`.
- Modify:
  - `renderer/design/design-canvas-region.tsx`.
  - `renderer/canvas/studio-canvas.tsx`: only to accept an optional `onKeyDownCapture`-style `resolveKey` override, so the design keymap can extend the default one. Create Images' behaviour must not change.
  - `main/handlers/design-canvas.ts`: adds `designCanvas:watch` and `designCanvas:pickFile`.
  - `renderer/preload-channels.ts` and `renderer/lib/ipc.ts`.
- Test:
  - `renderer/design/design-canvas.test.tsx`
  - `renderer/design/nodes/file-node.test.tsx`
  - `main/services/design-canvas/watch.test.ts`
  - The existing `renderer/canvas/canvas-controls.test.tsx` and `renderer/images/images-components.test.tsx` must still pass unchanged.

**Interfaces:**
- Consumes: Tasks 2–5.
- Produces:
  ```ts
  // IPC "designCanvas:watch" (chatId, relativePaths: string[]) => void   // replaces the watched set; at most 50 paths
  // broadcast "designCanvas:filesChanged" { chatId, paths: string[] }     // debounced 150 ms
  // IPC "designCanvas:pickFile" (chatId, kind: "file" | "image") => { path: string } | { cancelled: true } | { error: "outside-workspace" | "unsupported" }
  export const designNodeTypes: NodeTypes;
  export function FileFrame(props: { frame: DesignFrame; grant: string; live: boolean; entered: boolean; version: number; onEnter(): void; onMissing(): void }): JSX.Element;
  ```

- [ ] **Step 1: Write the failing tests.**
  - **`watch.ts`** (real temp directory):
    - Writing a watched file emits one `filesChanged` within 150–400 ms, even after 5 rapid writes.
    - A change to `design/hero.css`, beside a watched `design/hero.html`, also reports `design/hero.html`, because assets in the same folder count.
    - Replacing the watched set closes the old watchers.
    - More than 50 paths are cut to 50.
  - **`file-node.test.tsx`:**
    - Not live: it renders the snapshot `<img>` when one is cached, otherwise a skeleton with the title. Either way there is no `<iframe>`.
    - Live: it renders one `<iframe sandbox="allow-scripts">` whose `src` is the `aiden-design` URL, with `width` set to the design width and a `transform: scale(boxWidth / designWidth)`.
    - Not entered: the iframe wrapper has `pointer-events: none`. A double-click calls `onEnter`.
    - Entered: the wrapper has the `nodrag nowheel` classes.
    - An `aiden-design:ready` message from another window's `source` is ignored. One from the iframe's own `contentWindow` updates the document height.
    - A load that answers 404 shows "File not found" and a **Remove frame** button (Review Focus 5).
    - A version bump changes the iframe `src` cache-buster (`?v=<n>`), so the frame reloads in place.
  - **`design-canvas.test.tsx`** (xyflow stubbed as in `renderer/canvas/canvas-controls.test.tsx`):
    - Add menu → Note places a note at the view centre and focuses its textarea.
    - Add menu → Group adds a group titled "Group".
    - Add menu → File… calls `pickFile` and places a `file` frame with the returned path.
    - Pressing Delete with a frame selected removes it, and ⌘Z brings it back.
    - Escape with an entered frame leaves the frame and does not leave design mode, so the `useDesignMode` set function is not called.
    - The empty state shows "Ask Aiden to design something, or add a note." when there are no frames.
- [ ] **Step 2: Run the tests and confirm they fail.**
  - Run: `npx tsx --test main/services/design-canvas/watch.test.ts renderer/design/nodes/file-node.test.tsx renderer/design/design-canvas.test.tsx`
  - Expected: FAIL.
- [ ] **Step 3: Implement it.**
  - **Nodes:**
    - Every node uses `CanvasNodeChrome` and `NodeResizer`.
    - The group node renders as a soft filled region with its title, with no border.
    - The image node shows `<img src="aiden-design://…">`.
    - The artifact node reuses the existing preview through `renderer/components/html-artifact-frame.tsx`. Accept its `previewCache` as is; P3 fills `mediaId`.
  - **`pickFile`** opens `dialog.showOpenDialog` with `defaultPath` set to the workspace root and validates the result through `resolveDesignFile`.
  - **The live set** is recomputed on viewport change, throttled to one per animation frame. When a frame leaves the live set, `capture` runs first and the iframe is removed once the snapshot arrives, so the frame never flashes.
- [ ] **Step 4: Run the tests again,** plus `npm run test:create-images` and `npm run test:studio-foundation`. Expected: PASS.
- [ ] **Step 5: Commit** with the message `Render design frames on the canvas`.

### Task 7: E2E, containment, registration, docs and screenshots

**Files:**
- Create: `tests/e2e/design-canvas.spec.ts`, `tests/generative-ui/design-containment.spec.ts`, or extend `tests/generative-ui/containment.spec.ts` if its harness fits.
- Modify: `package.json` (`test:design-mode` and the e2e list), `scripts/ci-test-registry.json`, `docs/plans/README.md`, `.memory/design-mode.md`.

- [ ] **Step 1: Write the E2E specs.**
  - **`design-canvas.spec.ts`:** launch with `AIDEN_EXPERIMENTAL_DESIGN_MODE=1` and a temp workspace that contains `design/hero.html`.
    1. Enter design mode.
    2. Add a note, type text, and add `design/hero.html` through a stubbed `pickFile`.
    3. Reload the window. Both frames return at the same positions.
    4. Edit `hero.html` on disk. The frame's text changes within 2 s without a reload of the app.
    5. Zoom to 20 %. No iframe is present.
  - **`design-containment.spec.ts`:** a frame file that tries `fetch("https://example.com")`, `new Image().src = "https://example.com/x.png"`, a form POST, `window.open`, `top.location = "https://example.com"`, and an `<iframe src="https://example.com">`.
    - Assert that no request leaves the app (Playwright request interception on the Electron session).
    - Assert that the main window URL is unchanged.
    - Assert that the frame reports CSP violations (Review Focus 2).
- [ ] **Step 2: Run them.**
  - Run: `npm run test:e2e:space -- tests/e2e/design-canvas.spec.ts tests/generative-ui/design-containment.spec.ts`
  - Expected: PASS.
- [ ] **Step 3: Register every new test file,** then run `npm run test:ci-policy` and `npm run test:design-mode`. Expected: PASS.
- [ ] **Step 4: Take the screenshots.**
  - Light and dark, at 1440 and 1000 px.
  - States: the empty canvas; the canvas with a note, a group and two file frames; an entered frame; a frame showing "File not found".
  - Save them under `/tmp/design-mode-screens/p2/`.
- [ ] **Step 5: Update the docs.** Update the `docs/plans/README.md` Design mode row and `.memory/design-mode.md` to say P2 is done.
- [ ] **Step 6: Commit** with the message `Cover the design canvas end to end`.
