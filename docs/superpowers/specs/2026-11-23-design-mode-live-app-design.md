# Design mode v2: the live app canvas

Status: approved by the owner, 2026-11-23. No code yet. Builds on [Design mode v1](2026-10-31-design-mode-design.md) (P0–P5 shipped, on by default). Project memory: `.memory/design-mode.md`.

## 1. Intent

The owner wants design mode to put a project's **real, running web app** on an infinite canvas. Every route becomes a live, interactive frame. The person can inspect any element's real values, measure, spot values that break the design system, compare live directions side by side and see component variants. All of it updates within a second of a file save.

Tools of this kind usually have no agent of their own: the person copies an element reference and pastes it into a separate coding agent. Aiden's edge is that the agent sits in the same window. Pointing goes straight into the composer, errors get a **Fix with Aiden** button, and Aiden itself starts the app, writes routes and arranges the board.

Why now: v1 draws HTML mockups under `design/`. People building real React apps can't use them for their actual product, and the mockups have to be translated into code afterwards. v2 makes the canvas the app.

## 2. Owner decisions (2026-11-23)

1. Frames show the **live interactive app**: dev-server routes, not HTML mockups.
2. **One canvas per workspace.** Each design chat gets its own page on it, and Aiden can change which page a chat uses.
3. App-frame network is **localhost only** for now.
4. **Aiden can start and control everything** in design mode (dev server start, stop, restart, install and config) without per-call approval.
5. A workspace with no web app: Aiden **asks before scaffolding** a small React app into the repo (§6.8).
8. **Monorepos:** Aiden asks which apps to start and work in (§6.2.1).
9. **Live frames are for web apps only.** For a React project that isn't a web app (Electron, for example), Aiden makes React mocks in a mock app to iterate on (§6.8).
10. **Design mode uses the [DESIGN.md](https://github.com/google-labs-code/design.md) standard** for the app's design system (§6.9).
6. **Comment stays on C, exactly as today.** Inspect is a separate tool with its own key, X (§6.4.1).
7. The dev server **starts by itself when the person turns design mode on** (toggle, ⇧⌘L, `/design`, or Enter on Aiden's card). It never starts just because Aiden relaunched (§6.2.3).

Standing preferences that apply: pre-1.0 means no migrations (delete old shapes), autonomous phase-by-phase execution, and Opus implementers with reviews in the main session.

## 3. Goals, non-goals, anti-goals

**Goals**
- G1. Run or attach to the workspace's dev server from design mode. Aiden and the person can both start, stop, restart and read logs.
- G2. Show any route of the app as a live, interactive frame at a real viewport that reflows on resize.
- G3. Point, comment, inspect, measure and edit text inside live app frames, with React component and `file:line` source mapping.
- G4. One shared canvas per workspace. A chat's page is its working area, and every chat can see the whole board.
- G5. Feedback loops: a "saved · N frames updated" toast, changed-frame dots, and error frames with Fix with Aiden.
- G6. Explore live directions (route variants) and **Adopt** one. Run a drift check against the app's own tokens, and show a Styles frame.
- G7. Component cards from `*.canvas.tsx` files (Phase 6, its own spec before build).
- G8. A workspace with no web app can still design: Aiden scaffolds a small React app (see §6.8).

**Non-goals (v2)**
- Remote, iOS and Android, and Telegram: design mode stays desktop-only and out of the Remote projection.
- Internet access for app frames (decision 3). Apps that fetch remote APIs, fonts or images show those requests failing. This is a known limit, surfaced in the frame (§6.3.5).
- A native GPU canvas, a plugin runtime, or project tabs.
- Non-React frameworks beyond showing their pages. Vue, Svelte and Astro routes can render as frames, but source mapping and component cards are React-only.
- Collaboration beyond what a shared workspace canvas gives (no multi-user presence).

**Anti-goals** (a failure even if it technically works)
- An app frame that reaches the internet, navigates the canvas away, or touches Aiden's own renderer.
- A dev server that keeps running after the person has left design mode everywhere in that workspace, or after quit.
- Two chats or windows fighting over the shared canvas: page jumps, lost edits or save-conflict storms.
- Aiden running arbitrary shell commands without approval under the "design mode" banner. Only the fixed dev-server actions skip approval (§6.2.4).
- Losing anything v1 does well: comments, drawing and flows, notes, present and export, tweaks and text edit all keep working on the new canvas.

## 4. Constraints

- Electron 43, default session, main window `sandbox: true`, `contextIsolation`, no `webviewTag`. The main-window CSP `frame-src` today is `'self' aiden-genui: aiden-design:` (`main-window.html:8`).
- No `defaultSession.webRequest` handlers exist yet. Electron allows one listener per event per session, so the new filter must own each event through one dispatcher.
- Aiden does not bundle Node. Agent commands use the user's PATH with no login-shell lookup today. `devices/device-toolchain.ts` already resolves `npm`/`node` through `$SHELL -ilc` and rejects the Electron binary.
- `backgroundJobs` (`main/services/follow-through/background-jobs.ts`) already supervises long-running processes: process groups, logs, port polling via lsof or `/proc`, crash reaping, and teardown on quit, chat delete and workspace removal. `hostPlatformCapabilities().backgroundJobs` is true on darwin and linux.
- AGENTS.md:
  - New analytics events go in the registry, with a docs row and a test.
  - The onboarding gallery tile and art must be updated for a materially changed core capability.
  - Docs change in the same PR.
  - No source-grep tests.
  - New test files are registered in `scripts/ci-test-registry.json` and the `package.json` scripts.
  - Window-opening E2E runs in a Cua Space, and darwin-specific paths on the host.

## 5. Approaches considered

### 5.1 Hosting a live app frame

| | A. iframe on the canvas, injected from main (**chosen**) | B. Loopback reverse proxy in main | C. `WebContentsView` per frame on its own partition |
|---|---|---|---|
| How | `<iframe src="http://localhost:PORT/route">`. Main injects the bridge with `webFrameMain.executeJavaScript` and filters the network with one default-session `webRequest` dispatcher | A main-owned `127.0.0.1:0` server proxies HTTP and WS, rewrites HTML to add the bridge, and sets a strict CSP | Native views over the canvas, like the browser panel. CDP injection and a partition `webRequest` |
| Canvas fit | Keeps xyflow transforms, DOM overlays (pins, popovers), `event.source` checks, snapshots and the live set | Same as A | Native views sit above the DOM, can't follow zoom transforms and cover pins and toolbars |
| Risks | Shares the default session's cookie jar, though storage is per origin. The bridge runs in the page's main world. Injection lands after first paint | Changes the app's origin and port: absolute `localhost:3000` calls go cross-origin, and HMR client ports need rewriting. Streaming and compression edge cases | Bounds syncing, heavy at 6 frames, and a rewrite of the bridge transport |

A wins because everything v1 built (pins, popovers, comment geometry, the live set, snapshots) assumes DOM iframes. B remains the fallback for export if per-frame filtering proves leaky. C is rejected.

### 5.2 Running the dev server

Reuse `backgroundJobs` (**chosen**), not a new process supervisor: it brings group kill, reaping and teardown, plus the person's Stop chip, for free. A thin `DesignAppServers` layer adds workspace ownership, script detection, the Node toolchain and URL discovery.

### 5.3 Workspace canvas: where a chat's page lives

- **On the canvas document as `chatPages: {chatId: pageId}` (chosen).** It is atomic with page edits, needs no change to the `Chat` shape, and stays out of the Remote projection.
- A field on `Chat` is rejected: it can go stale when a page is deleted, and it touches chat-store and Remote code for nothing.

### 5.4 What happens to HTML mockup pages

**Chosen:** keep `file` frames as a supported kind (static HTML and images still frame fine through `aiden-design:`), but Aiden stops writing `design/*.html` mockups. Its default is the real app, or the scaffolded app of §6.8. The auto-placement of written pages (`written-pages.ts`) switches from HTML files to routes (§6.3.7).

The v1 mockup path is removed. That covers the skill and prompt text, the automatic placement of HTML pages, and the offer to write `design/tokens.css` and `specimen.html`, which the app's `DESIGN.md` (§6.9) and the Styles frame (§6.6) replace.

Without Node, design mode still opens. Notes, shapes, flows, images and existing `file` frames work, and Aiden explains how to install Node (§6.8).

- *Delete file frames:* rejected, because static HTML and images remain useful on a board and cost nothing to keep.
- *Keep mockups as the default:* rejected by decision 1.

## 6. Design

### 6.1 Workspace canvas (foundation)

**Document v3** (`renderer/shared/design-canvas/schema.ts`)
- File: `userData/design-canvases/<workspaceId>.json`. The workspace id is validated like `isWorkspaceArtifactWorkspaceId`.
- Old per-chat files (`<chatId>.json`) are deleted on first start, with no migration.
- Worktrees and no-workspace chats are their own workspace records, so each gets its own canvas. That is correct, because frame paths are relative to the checkout.
- `version: 3`. Removed: `activePageId` and `pages[].viewport`.
- Added: `chatPages: Record<chatId, pageId>`.
- Optional `chatId` (the chat that created it) on:
  - artifact frames, needed to load media from the right chat;
  - comments, to filter the tray to the chat that queued them.
- Optional `app` fields on frames (§6.3.1).
- Limits:
  - `pages`: 50 → 200.
  - Frames: 1 000 → 4 000, per page 400 unchanged.
  - Comments: 500 → 2 000.
  - The 16 MiB file cap stays.

**View state leaves the document**
- **Renderer:** each chat's current page and per-page viewport live in a per-chat view store (`localStorage` key `aiden.design.view.<workspaceId>.<chatId>`). Panning, zooming and switching pages never call `change()`, so they never save or cause conflicts. Undo stops tracking the active page.
- **Main:** keeps an in-memory `DesignCanvasViews` map from chatId to `{pageId, viewport, size}`. The renderer feeds it through a debounced `designCanvas:view` IPC.
- Tools read the view from that map:
  - `pageOf` defaults to the chat's view page, then `chatPages[chatId]`, then the first page.
  - `canvasView`, `canvasPromptLine` and the `onScreen` check use the map.
  - Placement uses the chat's page and view.
- `canvas_focus`, `canvas_arrange` and `canvas_page show` send `designCanvas:focus {chatId, pageId, frameIds}` to that chat's window. They no longer write view state into the document.

**Identity and IPC**
- Handlers keep `chatId` as the argument. It is the authority check: an attended chat with design mode on. Main resolves `workspaceId` through `persistedChatWorkspaceId` and keys the store with it.
- `designCanvas:updated` becomes `{workspaceId, revision}`, and every mounted canvas on that workspace refetches. `designCanvas:focus` stays per chat.

**A chat's page**
- On design-mode entry (`designPagesOnEntry`), Aiden claims a page for the chat when it has none in `chatPages`: a new page named after the chat title (renamed with the chat until someone renames the page by hand).
- Aiden can change it with a new `canvas_page {action: "use", page}`, which sets `chatPages[chatId]` and shows the page.
- Several chats may share a page.
- Deleting a page reassigns its chats to the first page. `canvas_page delete` refuses a page that other chats use unless `force: true`.
- Chat delete removes its `chatPages` entry, its queued comments and its artifact frames, but keeps the page and every other frame. Moving a chat (only empty chats can move) just drops its entry.
- Workspace remove and managed-worktree delete or rollback delete the canvas file.

**Sharing in practice.** Every chat sees every page. The page picker marks which chats use each page. Written pages and app frames are placed on the acting chat's page. Dedupe of existing frames checks only the target page.

**Comments tray.** `queuedComments` and `markCommentsSent` filter by `comment.chatId === chatId`. Auto-resolve stays per window, as today.

### 6.2 App server

**6.2.1 Detection** (`main/services/design-canvas/app-server/app-server-core.ts`, pure)
- `detectWebApp(root)` reads `package.json`:
  - **Framework**, from dependencies: `next`, `vite`, `@remix-run/dev`, `react-router` v7 framework mode, `@tanstack/react-start` or `@tanstack/router-plugin`, `astro`, `react-scripts`, `gatsby`.
  - **Dev script**: `dev`, then `start`, then `serve`.
  - **Package manager**, from the lockfile: pnpm, yarn, bun or npm.
  - **Whether `node_modules` exists.**
- It looks one level down for monorepos (`apps/*`, `packages/*`, `web/`, `frontend/`, `site/`) and returns every candidate.
- **Monorepos (owner, 2026-11-23):** when there is more than one candidate and `.aiden/canvas.json` doesn't already name the apps, **Aiden asks the person** through the question card which apps to start and work in. Several can be picked. The answer is saved in `.aiden/canvas.json` as `apps: [{root, script}]`, so the question comes up once.
  - Until it is answered, the person's design-mode toggle starts nothing, and the status chip shows **Choose apps…**.
  - When a copy or variant is ambiguous (for example "make a pricing page" in a repo with `web/` and `docs/`), Aiden also asks which app it belongs in.
- Each candidate is classified as one of:
  - **`web`**: a runnable web app. A framework from the list above with a dev script, and no `electron` dependency.
  - **`react-nonweb`**: uses React but can't run as a web page by itself. Electron apps (`electron` in dependencies) and anything that names itself that way in `.aiden/canvas.json` fall here.
  - **`none`**.
- Design mode runs **only `web` apps** live. A `react-nonweb` project is designed through React mocks (§6.8).

**6.2.2 Node toolchain.** Lift `resolveExecutable` and the npm resolution out of `devices/device-toolchain.ts` into a shared `main/services/node-toolchain.ts`: PATH, then `$SHELL -ilc "command -v …"` (with a cache), then Homebrew, rejecting the Electron binary and `ELECTRON_RUN_AS_NODE`. The device toolchain is re-pointed at it. Commands run in `agentShellCommandEnvironment()` with the resolved bin directory prepended, plus `BROWSER=none`, `FORCE_COLOR=0` and `PORT=<free port>` when the framework reads `PORT`.

**6.2.3 `DesignAppServers`** (`app-server-main.ts`, one per process)
- Keyed by **workspaceId + appRoot** (the app root is relative to the workspace, `.` for the root). A monorepo may run several roots at once, and every `app` frame names its `appRoot` (§6.3.1).
- **Starts** only on:
  - the person turning design mode on in a chat of this workspace (toggle, ⇧⌘L, `/design`, or Enter on the `design_mode` card). This starts the single detected `web` app, or the apps saved in `.aiden/canvas.json`. When the choice is still open, nothing starts and Aiden asks (§6.2.1);
  - `design_app start`;
  - the Start chip or a frame's "Start app" overlay.

  Restoring design-mode chats at launch never starts a process.
- **Attaching a server Aiden didn't start**:
  - an app entry's `url` in `.aiden/canvas.json` is used as is, after a loopback check;
  - otherwise the status chip's **Connect running server…** lists listening loopback ports whose process working directory is inside the app root (`lsof -a -d cwd`, or `/proc/<pid>/cwd` on Linux);
  - the framework's default port is offered only as a suggestion, never registered without that cwd match.

  Attached servers are never stopped by Aiden.
- `start(chatId, workspaceId, {root?, script?})` starts through `backgroundJobs.start` with the description "Run the app for design mode".
  - The job is owned by the starting chat. If that chat is deleted, the job stops, and the status shows Stopped with Start.
  - Design-mode servers don't count toward the per-chat 10-job limit. They reserve their own slot.
- **URL discovery** combines:
  - the dev server's printed URL, from `browserLocalServers()` on the job's output tail (fast);
  - `job.ports` from lsof polling (confirmation).

  When both are available they must agree on the port. The origin is canonicalised to `http://localhost:<port>`.
- **States:** `stopped | installing | starting | running {origin} | crashed {exitCode, tail}`. Changes broadcast as `designApp:status {workspaceId, …}`.
- **Install:** `start` runs the lockfile's install command first (`npm ci` only if a `package-lock.json` exists, otherwise `npm install`; `pnpm install --frozen-lockfile`; and so on) when `node_modules` is missing. This also runs as a background job, so its logs show and it can be stopped.
- **Stops when:**
  - no window has shown this workspace's canvas for 60 s. Presence comes from mounted canvases reporting through `designCanvas:view` (mount, unmount and window close). Switching to another workspace, or leaving design mode, unmounts the canvas. The grace period means a quick switch back doesn't restart it;
  - the workspace is removed or loses folder access;
  - quit;
  - the owning chat is deleted (via `backgroundJobs`).
- The server URL is also passed to `browserService` so the browser panel lists it.

**6.2.4 Tool `design_app`.** Offered with the canvas tools under the same gates (`designCanvasToolsAllowed`, `followThroughAvailable`, plus the `stillAvailable` re-check of design mode and folder access).
- Actions: `status | start | stop | restart | logs {lines} | choose {root, script}`.
- It takes a **script name from package.json and an app root inside the workspace**, never a free-form command.
- **No approval card**, per decision 4. This is recorded explicitly in `workspace-tool-approval.ts` as a reviewed exception ("design-mode dev-server control"), not by omission.
- Installing a *new* dependency or running other commands still goes through `run_command` and its normal approvals.

**6.2.5 UI.** An **app status chip** in the canvas top bar:
- Running: "Vite · :5173".
- Other states: Starting…, Installing…, Crashed, Start.
- Its menu has Start/Stop/Restart, Show logs (the terminal drawer streams the job log read-only) and Choose app… (when several roots exist).

### 6.3 Live app frames

**6.3.1 Frame kind `app`** (schema):
```
{ kind: "app", appRoot: ".", route: "/pricing", viewport: {width: 1280, height: 800},
  scale: 0.5, colorScheme?: "light"|"dark", label?: string, variantOf?: frameId }
```
- `w`/`h` on the canvas are always `viewport × scale`. The URL is computed at render time as the server origin plus the route; the document never stores ports.
- With no server running, the frame shows its last snapshot with a "Start app" overlay.

**6.3.2 Rendering** (`renderer/design/nodes/app-node.tsx`)
- `<iframe sandbox="allow-scripts allow-same-origin allow-forms allow-modals" referrerPolicy="no-referrer">`, laid out at viewport size and CSS-scaled.
- `allow-same-origin` is needed for localStorage, cookies and HMR. The localhost origin is cross-origin to Aiden's `file:` renderer in packaged builds. In `npm run dev` the renderer is on `localhost:<vite>`, which is same-site, so the bridge never trusts site and only uses `postMessage` with `event.source` checks.
- `allow-popups` and `allow-top-navigation` are left out on purpose.
- The main-window CSP adds `http://localhost:* http://127.0.0.1:*` to `frame-src` only.
- App frames count toward the 6-live limit. Others show snapshots (`capturePage`, keyed by route plus file-change generation).
- Interaction follows v1: Move (V) drags frames. Double-click or ↩ enters a frame, and it then takes all pointer, wheel and keyboard input. Esc or a pane click leaves.

**6.3.3 Bridge injection** (`main/services/design-canvas/app-bridge-main.ts`)
- On the main window's `did-frame-finish-load` and `frame-created` → `dom-ready`, for each subframe whose origin is a **registered app origin** (a running `DesignAppServers` origin), it calls `webFrameMain.executeJavaScript(APP_BRIDGE_SOURCE)`. This runs again after every full reload.
- The bridge gets an `__aidenBridge` once-guard and the `aiden-app:` message prefix. It reuses the v1 core (hover-at, pick-at, locate, highlight, anchors, edit-*) and adds:
  - **`inspect-at`**: computed style for the inspector (§6.4.1).
  - **`measure-at`**: box distances to the nearest siblings and parent.
  - **`source`**: React fiber walk giving component name, owner chain and `file:line`. It uses `_debugSource` (React ≤18) or a parse of the `_debugStack` frame (React 19). When neither is available it falls back to `data-aiden-src` stamps.
  - **`route`**: history `pushState`/`popstate` patch and `location` reports, so a frame knows when it navigated inside the app.
  - **`error`**:
    - `window.onerror` and `unhandledrejection`;
    - the Vite error overlay (`vite-error-overlay` element);
    - the Next.js error dialog (`nextjs-portal`);
    - failed module loads.

    Each report carries the message, the first stack frame mapped to a source file, and the kind.
  - **`hmr`**: Vite `vite:afterUpdate` and Next `__NEXT_HMR_CB` / webpack `module.hot` status → "updated".
  - **`blocked`**: counts requests the network filter cancelled (main tells the bridge, which can't see them).
- The tweak query parameters are **not** used for app frames, because they would break routing.
- **Tweaks are for `file` frames only.**
- App frames get a Dark switch: `colorScheme` makes the bridge set `color-scheme`, `data-theme="dark"` and `class="dark"` on `<html>`, which covers Tailwind's class mode and shadcn-style themes. The switch is removed again when it is turned off.

**6.3.4 Network filter** (`main/services/design-canvas/app-network-main.ts`)
- One default-session `webRequest.onBeforeRequest` dispatcher, the only owner of that event, with room for future subscribers.
- For a request whose `details.frame` is a subframe of the main window inside an app frame (the frame or an ancestor has a registered app origin):
  - allow `http:`/`ws:` to `localhost`, `127.0.0.1` and `[::1]`, plus `data:`, `blob:` and the `aiden-design:` bridge;
  - cancel everything else and report it to that frame's status.
- A null `details.frame` (service workers, preconnect) from an app origin is cancelled unless it is loopback.
- Main-frame requests are never touched.
- The navigation guard (`frame-navigation.ts`) pins app frames to loopback origins. External links inside the app are refused, and a frame-level toast offers "Open in browser", which goes to the Aiden browser panel.

**6.3.5 Localhost-only notice.** When a frame has had requests blocked, its title shows a quiet "N blocked" label. Its popover lists the hosts and says: "Design mode only lets apps reach localhost for now."

**6.3.6 Routes**
- `discoverRoutes(root, framework)`, pure, in `app-server-core.ts`, reads:
  - Next.js `app/**/page.*` (route groups dropped) and `pages/**`;
  - TanStack `src/routes/**`, using the `routeTree.gen.ts` path list when present;
  - React Router v7 `app/routes.ts` (simple literal configs only), otherwise Remix `app/routes/**`;
  - Astro `src/pages/**`.
- Dynamic segments are listed with their parameter names.
- **`.aiden/canvas.json`** (in the repo; Aiden can write it) overrides discovery:
  ```
  { "apps": [ { "root": "web", "script": "dev",
                "routes": ["/", "/pricing", "/blog/hello-world"],
                "params": { "/blog/[slug]": ["hello-world"] } },
              { "root": "design-app", "script": "dev", "mock": true },
              { "root": "docs", "url": "http://localhost:4321" } ] }
  ```
- Canvas UI: **Add ▸ Page from app…** lists the routes with a filter, and dynamic routes take a value.

**6.3.7 Placement while Aiden works**
- `written-pages.ts` becomes route-aware. When Aiden writes or edits a file that maps to a route (a route file under the discovered conventions), that route lands on the chat's page as an `app` frame once per route and is focused.
- Edits to non-route files (components, CSS) place nothing; HMR updates the frames already on the canvas.
- On entry to an empty chat page, the routes the chat wrote are placed, up to 12. If there are none and the chat page is empty, the app's `/` is placed.

**6.3.8 Responsive viewports**
- Dragging a frame edge changes `viewport` and the page reflows. A live readout shows `1180 × 800`, with ticks at the breakpoints found in the app's CSS (the bridge reads `@media (min-width…)` rules from same-origin stylesheets).
- ⌥-drag changes the frame box only, which clips without reflowing.
- Device menu: iPhone 390×844, iPad 768×1024, Laptop 1280×800, Desktop 1440×900, plus Custom.
- **Add view at width** duplicates the frame with `variantOf`.

**6.3.9 Page actions** (app frames)
- **Duplicate page as variant (⌘D)**: for file-based routers (Next, TanStack, Astro, Remix flat routes) it copies the route file to `<name>-v2` deterministically, as a main-side file op with undo, and places the new route beside the original with `variantOf`. For config routers, Aiden does it.
- **Delete page**: moves the route file to the system Trash, with undo restoring it. It is refused for routes not owned by a single file.
- **Hide from canvas**: canvas-only, as in v1.

**6.3.10 Export and snapshots**
- Snapshots: unchanged `capturePage` of the main window.
- Export (`frame-render.ts`): app frames render in the hidden window on a dedicated `aiden-design-live` partition, whose own `webRequest` applies the same loopback filter. The bridge is injected for tweaks and dark mode. Settle waits for `load` plus 500 ms idle, with a 15 s cap for cold compiles.

### 6.4 See and point

**6.4.1 Inspector (Inspect tool, X)**
- A new tool in the toolbar, separate from Comment. **Comment stays on C, unchanged.**
- It reuses the Comment tool's pick machinery (hover outline, `pick-at`), but its result is a popover anchored to the element.
- It shows:
  - a selector breadcrumb, the React component name and `file:line`;
  - size;
  - font family, size, weight, line height and tracking;
  - padding, display, gap and align;
  - radius;
  - colour and background in hex.
- A value matching a token (§6.6.2) shows the token name.
- Works on `app` and `file` frames.
- Actions:
  - **Ask Aiden**: adds an element chip to the composer (§6.4.3).
  - **Comment**: opens the Comment tool's box on the same element.
  - **Copy reference**.
- ⇧-click with Inspect adds a chip directly.

**6.4.2 Measure.** With Inspect active, hold ⌥ to show distances from the selected element to the hovered one, or to the parent edges. ⌥S keeps a measurement as a canvas mark that `canvas_read` lists.

**6.4.3 Element chips**
- An Inspect click with ⇧ (or Ask Aiden) adds a chip above the composer: component name, route, viewport, selector, `file:line` and a crop picture.
- On send they become an `<attached-design-elements>` block, modelled on `<attached-design-comments>` with the same data-not-instructions guard.
- Chips clear after send. Unlike comments they are not stored on the canvas.

**6.4.4 Change feedback**
- After a save that reaches app frames (HMR "updated" from their bridges, or a reload), a toast reads "`Header.tsx` saved · 3 frames updated". The file name comes from the watcher's own-write record when Aiden wrote it, otherwise "Updated 3 frames".
- Updated frames get a dot on their title until they are next in view and focused. Clicking the toast fits them.

**6.4.5 Error frames**
- A bridge `error`, a crashed server or a failed load turns the frame into an error state: the message, the mapped `file:line`, and **Fix with Aiden** (queues the error with its stack as an element chip with text "Fix this error") plus Copy.
- A crashed server shows the last 20 log lines in the chip menu, with the same button.

**6.4.6 Navigation**
- ⌘F: find a frame by title or route.
- A minimap toggle (xyflow `MiniMap`, off by default).
- **Tidy up** (⌃⌥T): the person's version of `canvas_arrange` on the selection, or on the page.
- **Copy as image** (⇧⌘C): the selection or view to the clipboard.

### 6.5 Agent surface

- New tool: `design_app` (§6.2.4).
- New tool: `design_system` (§6.9).
- Changed tools:
  - `canvas_place_frame kind app {route, viewport|device, scale?, page?, duplicate?, variantOf?}`;
  - `canvas_update_frame` takes `route`, `viewport` and `colorScheme`;
  - `canvas_page use`;
  - `canvas_read` lists app frames with route, viewport, live state, errors and blocked count.
  - `canvas_read {snapshot: true}` is unchanged.
- New tool: `design_inspect {frameId, selector | point}`, which returns the inspector values and source, so Aiden can check its own work. It replaces v1's page-inspect paths for app frames; `file` frames keep the v1 behaviour.
- **Where Aiden's work lands:**
  - Placements and written routes go on the chat's claimed page (`chatPages[chatId]`), even when the person is browsing another page. `canvas_focus` then moves that chat's view to the claimed page.
  - A tool call that names a page uses that page.
  - A canvas opened with no saved view shows the chat's claimed page.
- Rewritten **prompt section and `aiden-design` skill**:
  - Design in the real app: routes and components, using the app's styling system.
  - Start the app with `design_app` when it isn't running.
  - Prefer `.aiden/canvas.json` for route lists and dynamic params.
  - Use the chat's own page.
  - Variants as route copies grouped together.
  - Show at most 3 directions, then Adopt.
  - Keep `data-aiden-comment` handling for comments: in JSX, add `data-aiden-comment` props.
  - Follow the app's `DESIGN.md` as the source of truth, and keep it and the code in step (§6.9).
- Text editing inside a page (P4h) works on app frames only through Aiden, because the source is JSX. "Plain" edits become a queued element chip with the before and after text, and Aiden makes the edit.

### 6.6 Explore and consistency

**6.6.1 Directions and Adopt**
- **Explore 3 directions** on an app frame (a frame menu item, or Aiden on request): a group with the original and up to 3 variant routes (`/pricing-v1`…), all live.
- **Adopt v2** on a variant:
  - deterministic for file routers: replace the original route file's contents with the variant's;
  - delete the variant files (to the Trash);
  - collapse the group to the original frame.

  It is one undoable step. For config routers, Aiden adopts.

**6.6.2 Tokens and drift**
- The token set comes from, in order:
  1. the app's **`DESIGN.md`** tokens (§6.9), which are normative;
  2. otherwise every `--*` custom property the bridge finds on `:root`/`html` (this covers Tailwind v4 `@theme` and shadcn-style variables);
  3. otherwise a scale derived from frequency: the most-used font sizes, radii, spacing and colours across the frame.
- With a `DESIGN.md`, the check also reports **code drift**: a DESIGN.md token whose matching CSS variable in the running app has a different value (for example `colors.primary` `#1A1C1E` against `--color-primary: #1B1C1E`). Each drift offers **Update code** or **Update DESIGN.md**, and either one goes to Aiden.
- The inspector flags off-scale values: radius, gap, padding, font size and line height not in the token set, and colours with ΔE above 2 from every token colour.
- **Consistency check** (frame or page menu) scans visible elements in the live frames and lists drifts grouped by property and value, with element chips. **Fix all with Aiden** sends them as one block.

**6.6.3 Styles frame.** A new native frame kind `styles {appRoot}`, drawn by Aiden's renderer. It is a live view of the app's `DESIGN.md`:
- **Tokens:** colours (with `light`/`dark` groups side by side), typography levels set in their own fonts, rounded, spacing and motion. Motion shows as small previews that respect Reduce Motion.
- **Component tokens.**
- **The Overview and Do's and Don'ts prose.**
- **Lint findings** from §6.9, such as "button-primary contrast 3.9:1".

It updates when the file changes. Without a `DESIGN.md` it shows the app's CSS-variable snapshot with a **Draft DESIGN.md** button. Clicking a swatch or a type level adds a chip ("Change `colors.primary`").

### 6.7 Component cards (Phase 6; own spec first)

- A canvas-file convention under `.aiden/`:
  - `*.canvas.tsx` beside components, where each named no-argument export is one card;
  - `.aiden/canvas/setup.tsx` wraps every card with CSS, fonts, providers and mocks.
- Rendering needs an Aiden-owned board route. The likely shape is a second Vite dev server started with a config that extends the app's own and adds an Aiden plugin serving `/__aiden/board?files=…`, sliced into frames.
- Next-only apps need shims for `next/*` modules so their components render under Vite.
- This is the largest unknown, so it gets its own spike and spec before any build. Phase 6 is not blocked by, and does not block, Phases 1–5.

### 6.8 Workspaces without a runnable web app

Design mode runs only `web` apps live. Everything else is designed through **React mocks**: Aiden builds mock screens in a small Vite + React app (the *mock app*) and iterates on them on the canvas like any live app. When there is no `web` app and the person asks Aiden to design something, **Aiden asks first** through the question card. There are two cases.

**React projects that aren't web apps** (`react-nonweb`, for example an Electron app like Aiden itself). The question: "This is an Electron app, so it can't run on the canvas. Make React mocks of its screens in design-app/ to iterate on?"
- The mock app reuses the project's own UI where it can:
  - a Vite alias to the project's React source (for example `@app` → `../src/renderer`);
  - the project's global CSS and design variables;
  - its fonts.
- Desktop-only APIs are stubbed in `design-app/src/stubs/`. That covers the preload bridge (for example `window.electron` / `window.api`) and node or electron imports, which are aliased to stub modules, with mock data, so real components render in a browser.
- Each design iteration is a route in the mock app (`/settings`, `/settings-v2`, …). It's either composed from the project's real components or hand-built in React when a component can't render outside the app.
- Aiden says which parts are real components and which are mocked.
- Moving a chosen direction back into the real app is an ordinary coding task. Aiden ports the change into the project's source, outside the canvas.

**No React or web app at all.** The question: "This folder has no web app. Add a small React app in design-app/ to design in?" On yes, the mock app is a plain starter with no aliases or stubs.

In both cases, on yes, Aiden:
- scaffolds the mock app at `design-app/`, its own package with a `package.json`, from the template bundled in `resources/design-app-template/`. It never uses `design/`, which may hold v1 files. If `design-app/` exists and isn't a mock app, it uses `design-app-2/`;
- includes a starter `DESIGN.md` and its generated `theme.css` (§6.9);
- writes `.aiden/canvas.json` with `apps: [{root: "design-app", script: "dev", mock: true}]`;
- starts it. The install runs the person's package manager against the npm registry; that is the tooling's network, not an app frame's;
- places `/`.

On no, Aiden works with notes, shapes and flows only.

If Node can't be resolved, or the install fails, the status chip shows the reason. Aiden says how to fix it (install Node from nodejs.org or Homebrew, or check the network for the install) and offers Retry.

The old `design/*.html` mockup flow is retired from the skill. Existing HTML files still frame as `file` frames.

### 6.9 DESIGN.md: the design system source

Design mode adopts Google Labs' open [DESIGN.md format](https://github.com/google-labs-code/design.md/blob/main/docs/spec.md) (Apache-2.0; spec version `alpha`; CLI and library `@google/design.md` 0.4.0) as the one place an app's design system lives. It is a Markdown file with YAML design tokens:
- **Token groups:** `colors`, `typography`, `rounded`, `spacing`, `motion` and `components`. Groups such as `light`/`dark` and `sm`–`xl` are allowed.
- **References:** `{path}` references between tokens, and `@file#fragment` references to other files.
- **Prose sections, in a fixed order:** Overview, Colors, Typography, Layout, Elevation & Depth, Shapes, Motion, Voice & Content Strategy, Components, Do's and Don'ts.

Aiden follows the tokens as normative values and the prose as guidance.

**Where it lives**
- `DESIGN.md` in the app root, or in the nearest folder above it up to the workspace root.
- A monorepo may have one per app, or one shared at the workspace root.
- `.aiden/canvas.json` can point an app at a specific file (`apps[].designMd`).
- References inside it resolve from its own folder, as the spec requires.

**Reading and checking** (`main/services/design-canvas/design-md/`)
- Bundle `@google/design.md` **pinned exactly** (an alpha format, so it is upgraded only deliberately). Use its programmatic `lint()` in main: no `npx` and no network.
- The parsed design system and the findings are cached per file version and re-linted when the watcher sees the file change.
- Findings go to the Styles frame, `canvas_read` (a one-line summary) and the `design_system` tool.

**Agent surface**
- New tool `design_system {action: "read" | "lint" | "export", appRoot?, format?}`:
  - `read` returns the parsed tokens, the section list and any omitted sections;
  - `lint` returns the findings;
  - `export` returns the library's `css-tailwind`, `json-tailwind` or `dtcg` output for Aiden to apply to the app's styling.
- The design-mode prompt's volatile line names the active `DESIGN.md` and its lint counts.
- The `aiden-design` skill:
  - treats DESIGN.md as the source of truth;
  - uses its tokens (never one-off values) when writing UI;
  - uses its Voice & Content Strategy for copy;
  - when a design change adds or alters a token, updates `DESIGN.md` in the same turn, keeping section order and YAML validity, and runs `lint`;
  - keeps the app's CSS variables in step with it, using `export` as the starting point.

**When there isn't one.** When Aiden starts designing in an app without a `DESIGN.md`, it asks once through the question card: "No DESIGN.md yet. Draft one from the app's current styles?"
- On yes, Aiden drafts it from the bridge's token collection (§6.6.2), the app's Tailwind theme or CSS, and its fonts. It fills only the sections it has evidence for, lists the rest under `omitted`, lints it, and puts a Styles frame on the chat's page.
- The person can also choose **Draft DESIGN.md** on the Styles frame.

**Mock apps (§6.8).**
- The scaffold ships a starter `DESIGN.md` and a `theme.css` generated from it (`css-tailwind` export), so mocks follow the system from the first screen.
- For a `react-nonweb` project, Aiden drafts the mock app's `DESIGN.md` from the project's own CSS variables and fonts. The mock's styling stays faithful to the real app, and the same file can later be adopted at the project root.

**Component cards (Phase 6).** The DESIGN.md Components section can point at canvas files with external references (`@src/components/Button.canvas.tsx`). The Styles frame links each referenced component to its cards.

### 6.10 Analytics

Registry additions, each with a docs row and a test. No paths, routes, URLs or names.
- `design_app_started {framework, manager, outcome: running|crashed|failed}`
- `design_app_frame_added {source: person|aiden, device_bucket}`
- `design_point_used {action: inspect|ask|comment}`
- `design_drift_checked {count_bucket}`
- `design_direction_adopted {}`
- `design_md_drafted {source: app|mock}` and `design_md_linted {errors_bucket, warnings_bucket}`

### 6.11 Docs and onboarding

- Update the README feature line, `PRODUCT.md`, `docs/keyboard.md` (X Inspect, ⌥ and ⌥S measure, ⌘F, ⌃⌥T, ⇧⌘C and ⌘D on app frames) and `docs/plans/README.md`.
- Add a new `docs/design-mode.md` user guide covering `.aiden/canvas.json` and the localhost-only rule.
- The onboarding Design Mode tile and `DesignModeArt` are redrawn to show live route frames with an inspector popover.

## 7. Testing

- DESIGN.md: draft generation from token snapshots, lint wiring over fixture files (valid, broken ref, low contrast, duplicate section), lookup from app root to workspace root, `canvas.json` override, and code-drift matching of DESIGN.md tokens to CSS variables.
- Pure cores, with fixtures:
  - `detectWebApp`, `discoverRoutes` (Next, TanStack, Remix, React Router, Astro fixtures), lockfile detection;
  - URL-from-output parsing, state transitions;
  - v3 schema parse with `chatPages` invariants;
  - the view store, page reassignment, the token and drift scoring, Adopt file plans.
- Main services:
  - `DesignAppServers` against a fake `backgroundJobs`;
  - the network dispatcher with fabricated request details (allow and cancel table);
  - the navigation guard;
  - injection, with a fake `webFrameMain`;
  - `design_app` tool behaviour and gates;
  - canvas-tools per-chat page semantics, including two chats on one canvas.
- Bridge: run the real script in happy-dom (as v1 does) for inspect, measure, the source walk on a fake fiber, error capture and the once-guard.
- E2E (Cua Space, plus the host for darwin paths):
  - A fixture Vite + React app in `tests/fixtures/design-live-app/` (dependencies vendored or installed in CI with an offline cache) is started by `design_app` through the fake model.
  - Two routes appear live. An edit to a component updates both frames and shows the toast.
  - The Point inspector shows the right values.
  - A frame fetching `https://example.com` gets cancelled and shows "1 blocked".
  - A thrown error shows Fix with Aiden.
  - Two chats on one workspace keep separate pages, with no page jumps.
- Existing design specs move to the v3 file key.

## 8. Phases

Each phase is one PR, or a short stack, that leaves main shippable. Plans are written before each phase.

| # | Phase | Contents | Size |
|---|---|---|---|
| 1 | Workspace canvas | §6.1: v3 schema, workspace store, view state out of the document, chat pages, `canvas_page use`, comment and artifact chat ownership, lifecycle, tests and E2E moved | L |
| 2 | App server | §6.2: node-toolchain lift, detection, `DesignAppServers` on `backgroundJobs`, `design_app` tool, status chip and logs, stop rules | L |
| 3 | Live app frames | §6.3: `app` kind, iframe and CSP, bridge injection and v2 bridge, network dispatcher and navigation guard, routes and `.aiden/canvas.json`, route-aware placement, viewports and devices, page actions, export partition, skill and prompt rewrite, the §6.8 scaffold and mock apps, DESIGN.md read/lint/`design_system` tool and drafting (§6.9) | XL (split 3a frames and filter, 3b routes and placement and skill, 3c viewports and actions and export) |
| 4 | See and point | §6.4: inspector, measure, element chips, change toasts, error frames, find, minimap, tidy, copy image, `design_inspect` | L |
| 5 | Explore and consistency | §6.6: directions and Adopt, DESIGN.md-based drift and code-drift check, Styles frame as the live DESIGN.md view | L |
| 6 | Component cards | §6.7: spike, spec, build | XL |
| 7 | Launch | Analytics, docs guide, onboarding tile and art, keyboard docs | M |

Phase 1 is the foundation and lands first. Phases 2 and 3 are sequential. Phase 4 can start in parallel with 3b, because the inspector also works on `file` frames.

## 9. Risks and open questions

- **React 19 source mapping:** `_debugSource` is gone. Parsing `_debugStack` works in dev builds but is version-sensitive. The fallback is component name only, with Aiden grepping for it.
- **Injection timing:** the bridge arrives after first paint, so errors thrown during boot are read from the framework overlays rather than `onerror`.
- **Dev-mode same-site:** in `npm run dev`, `localhost:<app>` and the renderer's `localhost:<vite>` are same-site, which can put them in one process. The bridge stays postMessage-only, and the filter never touches the main frame.
- **Shared cookie jar:** apps share the default session's cookies by origin with any localhost page the renderer loads. This is acceptable for loopback dev servers and documented.
- **Ports in use:** a dev server already running outside Aiden is attached when its port answers on the detected origin. Aiden doesn't own it and never stops it.
- **Many live frames:** there is no change to the 6-live cap in v2. Scale work (offscreen pool) is deferred to Phase 6.

## 10. Builder's choices

These are left to the builder:
- exact file layout inside `design-canvas/app-server/`;
- debounce timings;
- the popover layout within the design guide;
- device preset list details;
- toast copy beyond the strings given;
- whether the monorepo search goes deeper than one level.
