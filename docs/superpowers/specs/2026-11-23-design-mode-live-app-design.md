# Design mode v2: the live app canvas

Status: approved by the owner, 2026-11-23. Pre-build checks recorded in §11, and the PR split revised in §8. Phase 1a is in progress; its plan is [`2026-11-23-design-mode-v2-p1a-workspace-canvas.md`](../plans/2026-11-23-design-mode-v2-p1a-workspace-canvas.md). Phase 2a (app detection) is built from [`2026-11-24-design-mode-v2-p2a-app-detection.md`](../plans/2026-11-24-design-mode-v2-p2a-app-detection.md); its decisions are S19–S24. Phase DM (DESIGN.md) is built from [`2026-11-24-design-mode-v2-dm-design-md.md`](../plans/2026-11-24-design-mode-v2-dm-design-md.md) behind `AIDEN_EXPERIMENTAL_DESIGN_LIVE`; its decisions are S33–S44. Phase 2b (the dev server process) is built from [`2026-11-24-design-mode-v2-p2b-dev-server.md`](../plans/2026-11-24-design-mode-v2-p2b-dev-server.md) behind the same flag; its decisions are S25–S32. Phase 2c (app status, logs and attaching) is built from [`2026-11-24-design-mode-v2-p2c-app-status.md`](../plans/2026-11-24-design-mode-v2-p2c-app-status.md) behind the same flag; its decisions are S45–S56. Phase 3a (live app frames) is built from [`2026-11-24-design-mode-v2-p3a-live-frames.md`](../plans/2026-11-24-design-mode-v2-p3a-live-frames.md) behind the same flag; its decisions are S57–S77, with S75's focus guard decided on 2026-11-27. The two gaps found in its E2E were decided the same day: Blink's `BlockingFocusWithoutUserActivation` stops a page's `focus()` loop (S75), and a redirect out is refused with a toast and the frame put back (S1). Phase 3b (routes and skill) is built from [`2026-11-27-design-mode-v2-p3b-routes-skill.md`](../plans/2026-11-27-design-mode-v2-p3b-routes-skill.md) behind the same flag; its decisions are S78–S88. Phase 3c (viewports and actions) is planned in [`2026-11-27-design-mode-v2-p3c-viewports-actions.md`](../plans/2026-11-27-design-mode-v2-p3c-viewports-actions.md) behind the same flag; its proposed decisions are S89–S101 (revised after review-p3c-plan). Builds on [Design mode v1](2026-10-31-design-mode-design.md) (P0–P5 shipped, on by default). Project memory: `.memory/design-mode.md`.

## 1. Intent

The owner wants design mode to put a project's **real, running web app** on an infinite canvas. Every route becomes a live, interactive frame. The person can inspect any element's real values, measure, spot values that break the design system, compare live directions side by side and see component variants. All of it updates within a second of a file save.

Tools of this kind usually have no agent of their own: the person copies an element reference and pastes it into a separate coding agent. Aiden's edge is that the agent sits in the same window. Pointing goes straight into the composer, errors get a **Fix with Aiden** button, and Aiden itself starts the app, writes routes and arranges the board.

Why now: v1 draws HTML mockups under `design/`. People building real React apps can't use them for their actual product, and the mockups have to be translated into code afterwards. v2 makes the canvas the app.

## 2. Owner decisions (2026-11-23)

1. Frames show the **live interactive app**: dev-server routes, not HTML mockups.
2. **One canvas per workspace.** Each design chat gets its own page on it, and Aiden can change which page a chat uses.
3. App-frame network is **localhost only** for now.
4. **Aiden can start and control everything** in design mode (dev server start, stop, restart, install and config) without per-call approval. (Refined in §12 S2: one consent per workspace and app root before the first start, renewed when the script text changes; never per call.)
5. A workspace with no web app: Aiden **asks before scaffolding** a small React app into the repo (§6.8).
6. **Comment stays on C, exactly as today.** Inspect is a separate tool with its own key, X (§6.4.1).
7. The dev server **starts by itself when the person turns design mode on** (toggle, ⇧⌘L, `/design`, or Enter on Aiden's card). It never starts just because Aiden relaunched (§6.2.3).
8. **Monorepos:** Aiden asks which apps to start and work in (§6.2.1).
9. **Live frames are for web apps only.** For a React project that isn't a web app (Electron, for example), Aiden makes React mocks in a mock app to iterate on (§6.8).
10. **Design mode uses the [DESIGN.md](https://github.com/google-labs-code/design.md) standard** for the app's design system (§6.9).

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
- An app frame whose renderer-side HTTP or WebSocket requests reach the internet, or that navigates the canvas away, touches Aiden's own renderer, or gets device permissions. Transports outside `webRequest` (WebRTC TURN over TCP) and the dev server's own server-side network are outside this guarantee; see §12 S5.
- A dev server that keeps running after the person has left design mode everywhere in that workspace, or after quit.
- Two chats or windows fighting over the shared canvas: page jumps, lost edits or save-conflict storms.
- Aiden running arbitrary shell commands without approval under the "design mode" banner. Only the fixed dev-server actions skip approval (§6.2.4).
- Losing anything v1 does well: comments, drawing and flows, notes, present and export, tweaks and text edit all keep working on the new canvas.

## 4. Constraints

- Electron 43, default session, main window `sandbox: true`, `contextIsolation`, no `webviewTag`. The main-window CSP `frame-src` today is `'self' aiden-genui: aiden-design:` (`main-window.html:8`).
- No `defaultSession.webRequest` handlers exist yet. Electron allows one listener per event per session, so the new filter must own each event through one dispatcher.
- Aiden does not bundle Node. Agent commands use the user's PATH with no login-shell lookup today. `main/services/node-toolchain.ts` (lifted out of `devices/device-toolchain.ts` in 2a, S24) resolves `node` and the package managers through `$SHELL -ilc` and rejects the Electron binary.
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
- **Owner:** main owns each chat's current page and per-page viewports, and persists them per workspace in `userData/design-canvas-views/<workspaceId>.json`, separate from the canvas document. *(Revised 2026-11-23 after review: an earlier draft kept them in renderer `localStorage` as well, and the two copies raced on mount, chat switch, restart and attach.)* Panning, zooming and switching pages never call `change()`, so they never save or cause conflicts. Undo stops tracking the active page.
- **Main:** `DesignCanvasViews` holds, per chat, `{pageId, viewports, focusId, mounted, size}`. The renderer reads it on mount (`designCanvas:view:get`) and feeds it through a debounced `designCanvas:view` IPC.
- Tools read the view from that map:
  - `pageOf` defaults to the chat's view page, then `chatPages[chatId]`, then the first page.
  - `canvasView`, `canvasPromptLine` and the `onScreen` check use the map.
  - Placement uses the chat's page and view.
- `canvas_focus`, `canvas_arrange` and `canvas_page show` send `designCanvas:focus {chatId, pageId, frameIds}` to that chat's window. They no longer write view state into the document.

**Identity and IPC**
- Handlers keep `chatId` as the argument. It is the authority check: an attended chat with design mode on. Main resolves `workspaceId` through `persistedChatWorkspaceId` and keys the store with it.
- `designCanvas:updated` becomes `{workspaceId, chatId, revision, aidenTurn?, step?}`, with `chatId` naming the chat whose action caused the change, and every mounted canvas on that workspace refetches. Only the origin chat records it as its own undo step. `designCanvas:focus` stays per chat.

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
- Its menu has Start/Stop/Restart, Show logs (the terminal drawer streams the job log read-only) and Choose app… (when several roots exist). *(Amended by S45 and S46: the menu also has Retry, Disconnect, Connect and Connect running server…, and Show logs opens a read-only logs drawer in the canvas, never the terminal drawer.)*

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
- Dynamic segments are listed with their parameter names, in one syntax for every framework (S79): `[name]`, `[...name]` and `[[...name]]`. A pattern is a route only once every bracket is filled. Discovery reads files only, never runs code and follows no links (S78); S80 has the conventions table and the `/`-plus-canvas.json fallback for every other framework.
- **`.aiden/canvas.json`** (in the repo; Aiden can write it) overrides discovery:
  ```
  { "apps": [ { "root": "web", "script": "dev",
                "routes": ["/", "/pricing", "/blog/hello-world"],
                "params": { "/blog/[slug]": ["hello-world"] } },
              { "root": "design-app", "script": "dev", "mock": true },
              { "root": "docs", "url": "http://localhost:4321" } ] }
  ```
- `routes` replaces discovery; `params` fills single-parameter patterns only; bad entries are dropped silently (S81).
- Canvas UI: **Add ▸ Page from app…** lists the routes with a filter, and dynamic routes take a value (S87).

**6.3.7 Placement while Aiden works**
- `written-pages.ts` becomes route-aware. When Aiden writes or edits a file that maps to a route (a route file under the discovered conventions), that route lands on the chat's page as an `app` frame once per route and is focused.
- Edits to non-route files (components, CSS) place nothing; HMR updates the frames already on the canvas.
- On entry to an empty chat page, the routes the chat wrote are placed, up to 12. If there are none and the chat page is empty, the app's `/` is placed.
- As built (S83): only `write_file` and `edit_file` count; the deepest app root owns a path; a dynamic route lands only with a canvas.json value; one `{snapshot, config}` read per turn and at most 12 per turn; entry takes the newest 12 across written routes and `design/` pages, and the `/` fallback needs a `single` target. A route the person took off is kept in `removedAppRoutes` and never placed automatically again; the person's undo goes in `undoneRoutes` and isn't a removal.

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
  - `canvas_read` lists app frames with route, viewport, live state, errors and blocked count. As built (S85): `device`, `variantOf` (by id) and `label` on place; `route`, the viewport, `device` and `label` on update, keeping scale; `blocked` is a count only, and errors move to Phase 4.
  - `design_app {action: "routes", root?}` lists an app's routes (S82).
  - `canvas_read {snapshot: true}` is unchanged.
- New tool: `design_inspect {frameId, selector | point}`, which returns the inspector values and source, so Aiden can check its own work. It replaces v1's page-inspect paths for app frames; `file` frames keep the v1 behaviour.
- **Where Aiden's work lands (S84, rewritten in 3b):**
  - Every placement (the tool, written routes and entry) goes on the page the turn resolves, in S18's order: the page shown this turn, then the message's page, then the chat's kept view, then its claimed page (`chatPages[chatId]`), then the first page.
  - A tool call that names a page uses that page.
  - The person's Add ▸ Page from app… uses the page on screen, sent with the call and checked by main.
  - A canvas opened with no saved view shows the chat's claimed page.
- Rewritten **prompt section and `aiden-design` skill**:
  - Design in the real app: routes and components, using the app's styling system.
  - Start the app with `design_app` when it isn't running.
  - Prefer `.aiden/canvas.json` for route lists and dynamic params.
  - Use the chat's own page.
  - Variants as route copies grouped together.
  - Show at most 3 directions, then Adopt.
  - Keep `data-aiden-comment` handling for comments: in JSX, add `data-aiden-comment` props. (Moved to Phase 4 with source mapping, S86; the live skill's No web app section keeps the v1 HTML method.)
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
- Bundle `@google/design.md` **pinned exactly** at `0.4.0` (an alpha format, so it is upgraded only deliberately). Import only the `@google/design.md/linter` entry point and call its `lint(content)` in main: never the CLI, no `npx` and no network. The library reads its own bundled `spec-config.yaml` beside its code at load time, so the packaged-build smoke check runs `lint()` once from inside the asar (§11).
- The parsed design system and the findings are cached per file version and re-linted when the watcher sees the file change.
- Findings go to the Styles frame, `canvas_read` (a one-line summary) and the `design_system` tool.
- Phase DM changes how this works: see S34–S38 and S44 in §12.

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

Registry additions, each with a docs row and a test. No paths, routes, URLs or names. Each event lands in the PR of the phase that introduces its feature, not in Phase 7.
- `design_app_started {framework, manager, outcome: running|crashed|failed}`
- `design_app_frame_added {source: person|aiden, device_bucket}` (3b, S88: `phone` ≤ 480, `tablet` 481–1023, `laptop` 1024–1439, `desktop` ≥ 1440, from four call sites, each after commit)
- `design_point_used {action: inspect|ask|comment}`
- `design_drift_checked {count_bucket}`
- `design_direction_adopted {}`
- `design_md_drafted {source: app|mock}` and `design_md_linted {errors_bucket, warnings_bucket}`

### 6.11 Docs and onboarding

Each phase's PR updates the docs its own change makes stale (AGENTS.md). Phase 7 is left with the onboarding art and the final pass over the user guide.

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
  - A fixture Vite + React app in `tests/fixtures/design-live-app/` is started by `design_app` through the fake model. It has no dependencies of its own: the E2E setup symlinks its `node_modules` to the repo root's, which already carries `vite`, `@vitejs/plugin-react` and React 19. Detection then sees `node_modules` and skips the install, so E2E never touches the network. The install path is covered by unit tests against a fake `backgroundJobs`.
  - Two routes appear live (3a). An edit to a component updates both frames and shows the toast (4).
  - The Inspect popover shows the right values.
  - A frame fetching `https://example.com` gets cancelled and shows "1 blocked".
  - A thrown error shows Fix with Aiden (4).
  - Two chats on one workspace keep separate pages, with no page jumps.
- Existing design specs move to the v3 file key.

## 8. Phases

Each row is one PR that leaves main shippable. A plan is written before each PR's build, and each PR runs the review loop: two Opus reviewers, a fix pass, then CI watched to green on the exact head. Analytics events and doc updates ship with the PR whose feature they describe (§6.10, §6.11).

| PR | Phase | Contents | Depends on | Size |
|---|---|---|---|---|
| 1a | Workspace canvas: document | §6.1: v3 schema (with `chatPages` parsed and the optional `chatId` on artifact frames and comments), workspace-keyed store, old per-chat files deleted, view state out of the document (renderer view store, main `DesignCanvasViews`, `designCanvas:view`), every `activePageId` reader moved to the chat's view, focus by IPC with a `pageId` instead of document writes, `designCanvas:updated {workspaceId, chatId, revision}`, artifact frames loaded through their owning chat, comments tray and Aiden's comment tools filtered by chat, workspace remove deletes the canvas file, chat delete drops the chat's comments, another chat's changes never this chat's undo steps, attaching a No workspace chat merges its canvas, chat delete no longer deletes the shared file, design E2E moved to the v3 file key | — | L |
| 1b | Workspace canvas: chat pages | §6.1: `chatPages` written (page claim on entry, renamed with the chat), `canvas_page use`, delete reassignment and `force`, lifecycle (chat delete prunes its `chatPages` entry and artifact frames; managed-worktree delete or rollback deletes the file), the two-chats E2E | 1a | M |
| 2a | App server: detection | §6.2.1–6.2.2: `node-toolchain.ts` lifted out of `device-toolchain.ts`, `detectWebApp` and lockfile detection (pure) | 1b | M |
| 2b | App server: process | §6.2.3–6.2.4: `DesignAppServers` on `backgroundJobs` with a design job owner (S7), install with a completion stamp (S8), loopback binding (S14), URL discovery, start consent and permission gate (S2), `design_app` tool and its reviewed approval exception, presence and the 60 s stop rule (moved from 2c, S6), `design_app_started` event | 2a | L |
| 2c | App server: UI | §6.2.3, §6.2.5: status chip and menu, read-only logs drawer, Connect running server (with S15's consent for repo-supplied URLs), the browser-panel listing | 2b | M |
| 3a | Live frames | §6.3.1–6.3.5, §6.3.10: `app` kind, iframe (no `allow-modals`, S10) and CSP, a minimal `canvas_place_frame kind app` (S6), bridge injection and v2 bridge with untrusted-output handling (S11) and Vite-client HMR (S12), default-session request dispatcher with the fail-closed null-frame rule (S3), subframe redirect handling (S1), permission dispatcher shared with Gemini Live (S9), cookie handling for `file://` builds (S4), navigation guard, blocked notice, export on the default session (S13), the fixture app and live-frame E2E, the React 19 source-mapping check (§11) | 2c | XL |
| 3b | Routes and skill | §6.3.6–6.3.7, §6.5: `discoverRoutes`, `.aiden/canvas.json`, Add ▸ Page from app, route-aware placement, the rest of the tool changes, skill and prompt rewrite for live apps (the v1 mockup path stays until 3d), `design_app_frame_added` event | 3a, DM | L |
| 3c | Viewports and actions | §6.3.8–6.3.9: edge-drag reflow and breakpoint ticks, device menu, Add view at width, ⌘D variant, delete page to Trash | 3a | M |
| 3d | Mock apps | §6.8: `resources/design-app-template/` with its starter `DESIGN.md` and `theme.css` (moved from DM, S6), the two ask-first flows, stubs and aliases for `react-nonweb`, Node-missing and install-failed states, and the v1 mockup path removed (`design-system.ts`, `design-system-offers.ts`, the skill text; moved from 3b, S6) | 3b, DM | L |
| DM | DESIGN.md | §6.9: pinned `@google/design.md/linter`, lookup and `apps[].designMd`, cached lint, `design_system` tool (outputs fenced as data, S11), prompt line, Draft DESIGN.md flow, `design_md_*` events | 2a (lands before 3b) | L |
| 4 | See and point | §6.4: Inspect (X), measure, element chips, change toasts, error frames with Fix with Aiden, ⌘F, minimap, Tidy up, Copy as image, `design_inspect`, `design_point_used` event | 3a (can run beside 3b) | L |
| 5 | Explore and consistency | §6.6: directions and Adopt, token sources and drift, code drift against DESIGN.md, consistency check, Styles frame, `design_drift_checked` and `design_direction_adopted` events | 3b, DM, 4 | L |
| 7 | Launch | §6.11: turn the live-app flag on by default (S6), onboarding tile and `DesignModeArt` redraw, final pass over `docs/design-mode.md` and `docs/keyboard.md` | 5 | M |
| 6 | Component cards | §6.7: spike, own spec, build | independent, last | XL |

1a and 1b are the foundation and land first, unflagged. Everything from 2b to 5 ships behind `AIDEN_EXPERIMENTAL_DESIGN_LIVE` (default off) until Phase 7 turns it on, so main never shows a half-built live canvas and onboarding changes once, with the launch (S6). The 2 PRs and 3a are sequential. DM can run beside 2b–3a and must land before 3b. After 3a, 3b, 3c and 4 can run in parallel, as long as no more than three or four agents are working at once.

## 9. Risks and open questions

- **React 19 source mapping:** `_debugSource` is gone. Parsing `_debugStack` works in dev builds but is version-sensitive. The fallback is component name only, with Aiden grepping for it.
- **Injection timing:** the bridge arrives after first paint, so errors thrown during boot are read from the framework overlays rather than `onerror`.
- **Dev-mode same-site:** in `npm run dev`, `localhost:<app>` and the renderer's `localhost:<vite>` are same-site, which can put them in one process. The bridge stays postMessage-only, and the filter never touches the main frame.
- **Shared cookie jar:** apps share the default session's cookies by origin with any localhost page the renderer loads. This is acceptable for loopback dev servers and documented.
- **Ports in use:** a dev server already running outside Aiden is never attached by itself. The person connects it from Connect running server…, or approves an `apps[].url` entry. Aiden reads ownership from the process and socket tables, never by contacting the port, and never stops it. *(Amended by S48.)*
- **Many live frames:** there is no change to the 6-live cap in v2. Scale work (offscreen pool) is deferred to Phase 6.

## 10. Builder's choices

These are left to the builder:
- exact file layout inside `design-canvas/app-server/`;
- debounce timings;
- the popover layout within the design guide;
- device preset list details;
- toast copy beyond the strings given;
- whether the monorepo search goes deeper than one level.

## 11. Resolved before build (2026-11-23)

These were checked against the code and the registry before Phase 1 started.

1. **`@google/design.md` is usable.** Version 0.4.0 is the latest release (0.1.0–0.4.0, last published 2026-07-27), Apache-2.0, ESM like Aiden. The `/linter` entry point exports `lint(content: string)`, which returns findings, the resolved tokens, the section list and a Tailwind config. It also exports the DTCG, CSS-variable and Tailwind v4 emitters and `fixSectionOrder`. The linter has no `fetch`, HTTP or `child_process`. Its one file read is its own bundled `spec-config.yaml`. The linter bundle is about 680 KB. Its dependencies mostly overlap Aiden's (`unified` 11, `remark-parse` 11, `yaml`, `zod`); the new ones are `remark-mdx`, `remark-frontmatter` and `citty`. Decision: exact pin, `/linter` only, plus a packaged-build `lint()` check (DM PR).
2. **No conflict with v1's design-system module.** `main/services/design-canvas/design-system.ts` and `design-system-offers.ts` (the `tokens.css` and `specimen.html` offers) are used only by `design-canvas/main.ts` and their own tests. Decision: delete both, their tests and their registry entries in 3b. New code lives under `design-canvas/design-md/`. Changed by S6 (removal moves to 3d) and S37 (the scanner stays, in `design-md/style-scan.ts`).
3. **E2E fixture without network.** Decision: the fixture app symlinks its `node_modules` to the repo root's (§7).
4. **Default-session `webRequest`.** Nothing registers on the default session today. The existing listeners are on named partitions: the browser panel and Bot sessions (`browser/service.ts`) and the design offline partition (`offline-session.ts`). Decision: 3a adds a single `default-session-web-request.ts` dispatcher that owns `onBeforeRequest` on the default session, with a test that a second registration throws. The `aiden-design-live` export partition follows the `offline-session.ts` pattern.
5. **React 19 source mapping** is checked first in 3a, against the fixture app: does the `_debugStack` walk plus Vite's source maps give `file:line`? If not, ship component name plus owner chain and have Aiden search for it. `data-aiden-src` stamps come only from a Vite plugin in mock apps. The Inspect UI is the same either way.
6. **v1 canvases are cleared.** Covered by the no-migrations rule. 1a's PR adds a release-notes line and updates `PRODUCT.md`: canvases are now shared per workspace, and boards from earlier versions are cleared. Files under `design/` are untouched and can be placed again as `file` frames.
7. **3a security review.** One of 3a's two reviewers is briefed only on the §3 anti-goals. The network filter test is a table of requests, each marked allowed or cancelled:
   - allowed: `localhost`, `127.0.0.1`, `[::1]`, `data:`, `blob:`, `aiden-design:`;
   - cancelled: `https://example.com`, `http://192.168.1.10`, `http://localhost.evil.com`, a request with no frame from an app origin;
   - never touched: any main-window request.

   The E2E checks the "1 blocked" label.

## 12. Spec review amendments (2026-11-23)

An adversarial review checked this spec against the code and Electron 43's typings. Each finding below was verified. Where an amendment and an earlier section disagree, the amendment wins. Each names the PR that owns it; §8's table already reflects them.

- **S1. Subframe redirects (3a; blocker).** The main window's `will-redirect` handler (`main/index.ts` ~1945) calls `preventDefault()` and `openExternalUrl` for every redirect, subframes included. A live app's ordinary `/` → `/login` redirect would break the frame and open a browser tab. A `302` to an external URL would put page data on the internet through `shell.openExternal`. 3a limits that handler to `isMainFrame`. Subframe redirects go to the frame guard: loopback → loopback is allowed, anything else is cancelled and counted as blocked. Test rows: loopback → external redirect on a navigation and on a `fetch`. **As built (2026-11-27):** the main window's CSP `frame-src` refuses a redirect (or `mailto:`) out of an app frame before `will-redirect` or `will-frame-navigate` runs, so the load fails with `ERR_BLOCKED_BY_CSP`. Main answers that failure (`did-fail-provisional-load`) for an admitted app frame as it answers a refused redirect: the blocked count goes up, an http or https target gets the "*host* is outside the app" toast with Open in browser (opened only when the person presses it), `mailto:` and other schemes get no toast (D1), and the frame goes back to the last in-app path its page reported. The frame's own `data:` or `blob:` page is refused the same way, with no toast. Putting a frame back is bounded per mount, by a monotonic clock and never by the page's messages. A frame nobody has entered is put back once. An entered frame is put back up to three times, and gets them back after 10 s in it with no way out, a fresh enter, or Reload. The restore after one to a path always goes to the route. Past the bound, the frame is left and shows "This page leads outside the app." with Reload. `[::1]` is refused like `data:` and `blob:`, since `frame-src` names only `localhost` and `127.0.0.1`. Nothing leaves Aiden.
- **S2. Dev-server start consent (2b; blocker).** The script name is fixed, but its text is not: Aiden (or a prompt injection) can edit `"dev"` or the Vite config, then restart. Install runs dependency lifecycle scripts. So:
  - **Consent:** before the first start for each workspace + app root, the person sees one consent card naming the resolved command and the script's text. Aiden stores a hash of the text and asks again whenever it changes. After that, starts, stops and restarts need no per-call approval (decision 4).
  - **Script:** `design_app` may only use the script the person confirmed. `choose` changes it only through the same card.
  - **Permission:** every start, the person's toggle included, is refused when the workspace permission is `none` (workspace permissions are `full | ask | none`, `main/services/types.ts`). *(Round 2.)*
  - **Round 3:** the fingerprint also covers the `pre<script>` and `post<script>` text and the app root's `.npmrc`, `.yarnrc.yml` and `bunfig.toml`. The consent card says plainly that it approves the launch command and that the dev server then runs the app's own code: the consent does not cover what that code does.
  - **What the consent covers** *(round 2)*: the fingerprint is a hash of the script text plus the app root's framework config files (`vite.config.*`, `next.config.*`, `astro.config.*`, `react-router.config.*`, `remix.config.*`) and its lockfile, in the style of the MCP stdio launch fingerprints (`mcp-stdio-approvals.ts`). Any change asks again.
  - **Recorded exception:** `workspace-tool-approval.ts` records it as "per-call approval skipped after workspace consent".
- **S3. Null-frame requests fail closed (3a; blocker).** Electron's `OnBeforeRequestListenerDetails` has no initiator, and `frame` is null after a frame navigates or is destroyed (keepalive fetch from a removed iframe, beacon on pagehide, service-worker fetch). On the default session, every non-loopback request with a null `frame` is cancelled. The only exceptions are on an audited allowlist of Aiden's own frameless traffic, with tests. Test rows: service-worker fetch, pagehide beacon, keepalive fetch after removing the iframe, WebSocket.
- **S4. Cookies in packaged builds (3a).** Packaged builds load the renderer from `file://` (`window-paths.ts`), so a localhost iframe is cross-site, and `SameSite=Lax/Strict` cookies (the default) are rejected. Session-login apps can't sign in, but only in packaged builds: `npm run dev` hides it. 3a adds a cookie-login fixture tested in a `file://` build, and tries rewriting a registered app origin's `Set-Cookie` to `SameSite=None; Secure` in `onHeadersReceived`, which the dispatcher then also owns. If that fails, it's documented as a known limit in `docs/design-mode.md`.
- **S5. What the network guarantee covers.** The filter covers renderer-side HTTP and WebSocket requests from app frames. It does not cover WebRTC TURN over TCP (no `webRequest` event; see `main/index.ts` ~1664) or the dev server's own server-side requests (SSR, proxies, rewrites). Both are known gaps; the §5.1 B proxy is the route to a full guarantee. §3's anti-goal is reworded to match.
- **S6. Sequencing (all).** Changes to the PR order:
  - presence and the 60 s stop move into 2b, so a tool-started server is never left running unseen;
  - 3a gets a minimal `canvas_place_frame kind app`, so its E2E can place frames;
  - the mock template's starter `DESIGN.md` moves to 3d, after DM;
  - the v1 mockup path is removed in 3d, not 3b, so non-web workspaces can always design;
  - DM lands before 3b, whose skill text uses `design_system`;
  - the toast and Fix with Aiden E2E steps belong to 4;
  - 2b–5 ship behind `AIDEN_EXPERIMENTAL_DESIGN_LIVE` until Phase 7 turns it on and updates onboarding.
- **S7. A design job owner (2b).** *(Round 2: this replaces §5.2's "Stop chip for free" and §6.2.3's "owned by the starting chat; stops with it". `BackgroundJobs`' `list`, `get`, `read`, `stop` and `settle` methods and its per-chat limit are keyed by `chatId` today, so the `design` owner needs a non-chat key (the workspace id and app root). Design jobs are excluded from Remote's `chat:jobs`, `background_job`, the goal check `jobsRunning` and settle.)* `backgroundJobs` posts a job-ended notice that wakes the owning chat (`follow-through-main.ts` ~161–186), lists the job in that chat's `background_job` tool, and stops the job when the chat is deleted. For the dev server, that would start unasked turns, let the agent stop it behind `DesignAppServers`' back, and kill it for every chat when one chat is deleted. Jobs therefore get an owner kind `design`: no `onEnded` wake (`DesignAppServers` shows the end in its status), hidden from `background_job`, and a lifetime tied to workspace presence and quit, not to a chat.
- **S8. Install completion stamp (2b).** "Does `node_modules` exist?" can't tell a stopped or killed install from a finished one. After an install exits 0, `DesignAppServers` records a stamp (app root + lockfile hash) under userData. A missing or stale stamp means reinstall. The status chip offers Retry after a failed install.
- **S9. Permission dispatcher (3a).** The default session has no permission handler, so Electron grants by default. Gemini Live sets and then clears (`null`) its own handlers (`display-media-contract.ts`). 3a adds one default-session permission dispatcher that Gemini Live registers through. It denies every request and check from a frame under a registered app origin. Tested with Live bound and unbound.
- **S10. No `allow-modals` (3a).** App frames use `sandbox="allow-scripts allow-same-origin allow-forms"`. Without this, `alert`/`confirm`/`prompt` loops could lock the Aiden window. The bridge reports suppressed dialogs in the frame status.
- **S11. Bridge output is untrusted (3a, 4, DM).** The bridge runs in the page's main world, which can pre-empt or spoof it. Every bridge message is validated for shape and length. A `file:line` is accepted only if it resolves inside the app root. Error, source and inspect text reaches Aiden fenced as data (as `fenceAsData` does), and `design_inspect` results are labelled page-reported. The once-guard must not trust a page-set `__aidenBridge`: it checks a per-injection nonce.
- **S12. HMR signal (3a, 4).** `vite:afterUpdate` reaches only module code, webpack's `module.hot` is per module, and Next 16 defaults to Turbopack. The bridge gets a Vite hot context by importing `/@vite/client` (respecting `base`) and calling `createHotContext`. Other frameworks count "the watcher saw a save, then the frame's DOM changed and settled" as updated.
- **S13. Export (3a).** Export renders app frames in a hidden window on the default session, under the same dispatchers, so cookies and storage match the canvas. (The offline proxy pattern would block loopback.) Remove "for tweaks" from §6.3.10: tweaks are for `file` frames only (§6.3.3), so anti-goal 5's "tweaks keep working" applies to `file` frames.
- **S14. Bind to loopback (2b).** Next.js and create-react-app bind `0.0.0.0` by default. When Aiden starts a server, it passes the framework's host flag or env (`--hostname 127.0.0.1`, `HOST=127.0.0.1`, Vite `--host 127.0.0.1`), so design mode never exposes the app to the local network.
- **S15. Two allowlist openings closed (2c, 3a).** `aiden-design:` is removed from app frames' allowlist and added to the cancelled test rows; the bridge arrives through `executeJavaScript`, not that scheme. A repo-supplied `apps[].url` in `.aiden/canvas.json` needs the S2 consent before it is registered as an app origin.

### Phase 1b amendments (2026-11-24)

Phase 1b (chat pages, plan `docs/superpowers/plans/2026-11-23-design-mode-v2-p1b-chat-pages.md`) built §6.1 "A chat's page" with three changes. They win over §6.1 and §6.5 where those disagree.

- **S16. Entry takes the free page on screen (1b).** Entry doesn't always add a page named after the chat. It keeps a live claim; else it takes the page holding most of the chat's earlier pages; else it takes the page on screen as it is (no rename, no `namedFor`) when no other live chat claims it, it isn't another live chat's named page, and it is empty or no other chat's kept view is on it. Only otherwise does it add a page named after the chat. So the first chat on a fresh canvas keeps Page 1.
- **S17. A moved chat's empty named page goes (1b).** Moving an empty chat drops its claim, its `namedFor` marks and its artifact frames, and deletes the page made for it when that page holds no frames or comments, no other chat uses it, and it isn't the only page. §6.1's "just drops its entry" is replaced. The same applies when a chat attaches from a shared legacy No workspace canvas that stays behind.
- **S18. The view comes before the claim when placing (1b).** A placement with no page lands on the page Aiden showed this turn, then the message's page, then the chat's kept view page, then its claim, then the first page; the renderer shows the view page, then the claim. So Aiden works on the page the person is looking at, not always on the claimed page as §6.5 "Where Aiden's work lands" says. §6.5 is to be revisited in 3b, when app frames and the rewritten prompt land.

### Phase 2a amendments (2026-11-24)

Phase 2a (app detection, plan `docs/superpowers/plans/2026-11-24-design-mode-v2-p2a-app-detection.md`) built §6.2.1's detection and §6.2.2's toolchain lookup. These win over §6.2 and §6.8 where they disagree. Nothing calls the new modules until 2b.

- **S19. Launch environment in 2b.** The dev-server command environment (`agentShellCommandEnvironment()`, `BROWSER`, `FORCE_COLOR`, `PORT`, S14's host flags) lands in 2b with the process, through `nodeCommandEnvironment(env, binDirs)` and `runScriptCommand(info, script, extraArgs)`. 2b always sets `COREPACK_ENABLE_DOWNLOAD_PROMPT=0`. There's no corepack fallback for a missing manager. Only npm gets `--` before extra arguments: pnpm 12 and Yarn 4 pass a bare `--` through to the script (checked 2026-11-24).
- **S20. Package manager rules.**
  - The `packageManager` field decides only with no lockfile or its own; otherwise it's a conflict.
  - A conflict is settled only by a single manager's install marker in `node_modules`; otherwise 2b refuses with a message saying how to fix it. A gitignored leftover lockfile is a conflict too; that's accepted, since the message names the file to delete.
  - `pnpm-workspace.yaml` means pnpm.
  - Deno is unsupported.
  - An enclosing repo's signal counts when the workspace has none of its own and no `.git`, and only when that repo's `workspaces` or `pnpm-workspace.yaml` lists the workspace; otherwise it's npm with a plain install. The walk stops at `.git`, home, a caller's `stopAt` and five levels.
- **S21. Kinds and scripts.**
  - Desktop shells (Electron, Tauri) are never `web`.
  - The dev script prefers the framework's dev command and skips builds, production runs, Storybook and workspace runners, including root scripts that hand off to one member (`-w`, `--workspace`, `--prefix`, `--dir` with a package manager; `yarn workspace`, `pnpm -C`, `concurrently`, `npm-run-all`, `run-p`). A root that declares workspaces is `web` only when its script runs the framework's own dev command.
  - New reasons: `workspace-runner` and `unknown-framework`. 3d never scaffolds for either.
  - `no-dev-script` is only for a framework app with no Storybook and either no dev/start/serve script or only production runs (`start: "next start"`).
  - React Native or Expo is `react-nonweb`.
  - "React Router v7 framework mode" means `@react-router/dev`.
- **S22. Frameworks.** The allowlist gains Angular, Nuxt, `@tanstack/start` and Remix 3 (`remix` at major 3 or later; dev command `node --watch`, default port 44100, from the `remix@3.3.0` starter). They run as live frames; source mapping and component cards stay React-only.
- **S23. `detectWebApp` lives in `app-detect.ts`.** §6.2.1 put it in `app-server-core.ts`. It reads the disk with bounded, no-follow reads; `app-server-core.ts` stays pure.
- **S24. Device PATH fix.** The device helpers (`deviceNodeEnvironment`, `androidSdkEnv`, `createNpmRunner`, the generated agent-device launcher, and host commands run before Node is resolved) no longer put an empty entry on PATH. Node and package-manager lookup moved to `main/services/node-toolchain.ts`, shared by devices and design mode; the device exports are unchanged.

### Phase 2b amendments (2026-11-24)

Phase 2b (the dev server process, plan `docs/superpowers/plans/2026-11-24-design-mode-v2-p2b-dev-server.md`) built §6.2's server half behind `AIDEN_EXPERIMENTAL_DESIGN_LIVE`. These win over §6.2, §11 and S1–S24 where they disagree.

- **S25. Design jobs (2b).** Background jobs gain a design owner with its own cap of 8 running jobs and its own read, stop and socket methods. A design job's log rotates at 25 MB and keeps 50 MB; reads take byte offsets. `scanPorts` and finished-job eviction never notify a chat. The shared job types and Remote are unchanged. Stopping a design job also signals descendants that left its process group (`setsid`), found by parent pid before any signal.
- **S26. Consent detail (2b).** The fingerprint covers:
  - both roots' install lifecycle scripts;
  - the raw `packageManager` and `devEngines` values;
  - rc and workspace files from the app root to the lockfile folder, and the `yarnPath` target;
  - the lockfile and framework configs (the spec's five, plus Nuxt, Angular and Gatsby).

  The other rules:
  - unreadable or linked files, and scripts over 4 000 characters, refuse;
  - the record keeps `installShown`;
  - detection, toolchain and fingerprint run again before every spawn, and the command is rebuilt from that result;
  - display escapes cover control, format, line and paragraph separators, Hangul fillers and variation selectors;
  - `start`, `restart` and `choose` need a live desktop window owner; a Remote or windowless owner gets `desktop-only` or `consent-unavailable`.
- **S27. Install rule (2b; narrows S8).** An install runs for a missing `node_modules`, an unfinished or stale Aiden install, or on request. It doesn't run over an install the person made, and never when the lockfile is outside the workspace (`install-outside-workspace`).
- **S28. Launch environment (2b; extends S19 and S22).**
  - Flags are added only when the script runs the framework CLI, never as a second host or port flag; Vite-based CLIs get `--strictPort`, and classic `remix dev` gets env only.
  - The scrub removes `NODE_ENV`, `ELECTRON_*`, `AIDEN_*`, `npm_*`, `npm_config_*`, `INIT_CWD` and the provider keys pi-ai knows (`findEnvKeys` over `getProviders()`).
  - Framework telemetry is off unless the person set it.
  - Remix 3's default starter ignores `HOST` and `PORT` and is refused as `exposed` (S22 note).
- **S29. Origin and exposure (2b; amends §6.2.3 line 186).**
  - The origin is `http://127.0.0.1:<port>`.
  - Readiness needs an IPv4 loopback port the job's process tree holds; output resets the quiet timer at the next poll, with a 10-minute cap.
  - Every socket of the tree must be loopback, checked by one shared poller (one `ps` and one `lsof` per tick for all jobs) every 500 ms while starting and every 2 s while running, with a reader that fails closed and a 4 096-fd cap per process; three failed reads stop the server.
  - `appForOrigin` matches held addresses only, and `isAppOrigin` keeps every served origin restricted for the session.
- **S30. Presence and workspace changes (2b; refines S6).**
  - Presence is a visible canvas (pane shown and document visible); 60 s after none is visible, the server stops.
  - Each attempt holds a workspace admission. A folder-path change or `none` stops a running server.
  - `no-access` only when access is really gone, otherwise `interrupted`.
  - The existing gate covers workspace changes, so there's no separate pause.
- **S31. Tool and choice (2b).**
  - No automatic restart.
  - At most 4 starts, restarts or chooses per turn; the tool waits for the card, then up to 90 s for the attempt, and an aborted turn stops the wait, not the server.
  - `design_app` skips the per-call approval card (`REVIEWED_CARDLESS_TOOLS`); hooks and Settings → Approvals rules still block or ask, and it is never judged.
  - `choose` accepts only `web` candidates, and saves `script` into `.aiden/canvas.json` through the confined writer, which refuses any link on the path and an unknown `version`, and writes new files with `version: 1`.
  - Configured roots come from DM's `configuredRoots`.
  - A moved chat starts nothing.
- **S32. Phase split (2b, 2c).** 2b owns the `design_app` tool, the `designApp:*` IPC (all through `rendererDocumentOwner`), the `designApp:status` broadcast, the `launch | attach` consent union and the attach problems. 2c adds only UI and attaching.

### Phase DM amendments (2026-11-24)

Phase DM (DESIGN.md, plan `docs/superpowers/plans/2026-11-24-design-mode-v2-dm-design-md.md`) built §6.9's reading, checking, agent surface and draft offer, behind the live flag. These win over §6.9 and §11 where they disagree. 2b's S25–S32 sit between the Phase 2a block and this one.

- **S33. Flag.** DM ships behind `AIDEN_EXPERIMENTAL_DESIGN_LIVE` with 2b–5 (S6), and creates `designLiveEnabled` with 2b's definition. With the flag on, the DESIGN.md offer replaces v1's tokens offer; with it off, nothing changes and no lint worker starts.
- **S34. No volatile prompt line.** §6.9's "volatile line" became the `design-canvas-status` note on 2026-11-18. The DESIGN.md path and counts are one sentence of that note, so a turn with the same counts adds nothing. The prompt section gains one static bullet when the flag is on; flipping the flag changes it once per chat.
- **S35. No watcher in DM.** Reads are on demand (turn start, tool calls, the IPC) and cached by content hash, so an edit is seen on the next read. Phase 5 adds a watcher for the live Styles frame.
- **S36. `design_system` actions.** `read | lint | export | draft`. `lint` takes optional `content` to check a draft before it's written. `draft` returns text and never writes. The tool never writes files.
- **S37. Draft sources and the scanner.** In DM a draft comes from the app's own style files, through v1's scanner, which DM moves into `design-md/style-scan.ts`. 3d deletes only the tokens offer and its skill text, not the scanner (this replaces §11 item 2's "delete both" and S6's scanner part). Phase 5 adds the bridge's token collection as a second source. Placing a Styles frame after a draft moves to Phase 5.
- **S38. What 0.4.0 checks.** No `motion` group; Motion and Voice & Content Strategy aren't known sections; `@file#fragment` isn't resolved; duplicate sections and unresolved token-group references aren't reported. DM adds `aiden/duplicate-section` and `aiden/unresolved-ref` warnings. 3b's skill text and Phase 5's Styles frame must not promise more than this.
- **S39. `.aiden/canvas.json` in DM.** DM owns `canvas-config.ts`.
  - **Version.** A file with no `version`, or `version: 1`, is understood. Any other `version` is `unsupported-version`: DM reads nothing from it, and a writer must refuse to change it. New files are written with `version: 1` (2b's writer does the writing).
  - **Paths** are workspace-relative; a root of exactly `.` is allowed and any other `.` segment is refused. `apps[].designMd` must end in `.md`.
  - **Described roots** come from one shared helper, `describedRoots(config, detected)`, used by DM's R2 and 2b's D4: the entries with a `script` whose `root` is also a `web` candidate in detection, in file order; if there are none, detection decides.
  - `designMd` applies to any entry whose `root` matches. Unknown fields stay in the file for 2b's writer.
- **S40. "Asks once"** means once per workspace and app root, logged only when the turn that carried the offer ended normally, as v1's tokens offer does. The log is an HMAC of the folder path and app root with the per-install key; the mechanics move to `offer-log.ts`. The offer is made only when `ask_user_question` is offered in that turn and the chat can write.
- **S41. The IPC.** A read-only `designCanvas:designSystem` lands in DM. `scripts/design-md-packaged-acceptance.mjs` calls it in the release workflow, and Phase 5 reads it. It sends no analytics.
- **S42. Packaging.** The package's CLI (`dist/index.js`), its top-level `dist/spec.md` and `dist/spec-config.yaml`, `dist/linter/spec.md`, its nested `node_modules/` and the hoisted packages only it reaches (its CLI and MDX/frontmatter parsers; the linter is one bundled file) are left out of the asar. The lint worker is a separate built file, and both package checks look for it.
- **S43. Events.** `design_md_linted` fires once per new content of a file per run, never for a `content` lint or an IPC read. `design_md_drafted {source: "app"}` fires when a turn ran `draft` and the target file exists at the turn's normal end where it didn't when the draft ran.
- **S44. The linter runs in a worker.** The worker posts `ready` once the linter is imported; loading has a 10 s limit (then `linter-unavailable`), and the lint itself a 2 s deadline from `ready` (then `timed-out`, cached by content hash). A 64 KiB file cap. The worker's environment drops `DEBUG`, `LOG_STREAM` and `LOG_TOKENS`.

### Phase 2c amendments (2026-11-24)

Phase 2c (app status, logs and attaching, plan `docs/superpowers/plans/2026-11-24-design-mode-v2-p2c-app-status.md`) builds §6.2.5's chip and lets design mode connect to a dev server the person already runs, behind `AIDEN_EXPERIMENTAL_DESIGN_LIVE`.

- **S45. Status chip (2c; details §6.2.5).** One chip per workspace in the canvas's top-right `actions` slot, before the Canvas view tools. It is hidden without the flag or when live apps are `unavailable`; with no web app it is a Connect chip offering only Connect running server…. It summarises several apps as "<N> apps", has no spinner or pulse, and announces only a crash and a disconnect that carries a problem (the person's own Disconnect isn't announced). A status read that races a broadcast keeps each app's higher revision. Its menu has Start, Stop, Restart, Retry, Show logs, Disconnect, Connect, Connect again, Choose apps… and Connect running server…. The actions are optimistic: the invoke's own result settles them, a refusal rolls back with the problem shown inline, and only a newer revision for that app replaces them.
- **S46. Logs drawer (2c; replaces §6.2.5's terminal drawer).** Logs open in a read-only drawer inside the canvas, never the PTY terminal:
  - the text is plain, with escape sequences removed (also across reads), lines capped at 4 KiB, and hidden characters shown as escapes;
  - CAN and SUB cancel an OSC or DCS; a line break ends one unfinished, and a sequence still unfinished after 4 KiB shows as escaped text, so none hides later output;
  - it starts at the last 256 KiB of the run, polls by run and byte cursor while the canvas is shown, and keeps 256 KiB; a read that finds it more than 256 KiB behind (after a pause, or a long new run) drops what it shows, says output was skipped, and jumps to the last 256 KiB;
  - main ends each read on a UTF-8 character boundary while the job runs;
  - attached servers have no logs.
- **S47. Retry (2c; S8).** `designApp:retry` clears the toolchain cache, and main decides what runs: a failed choice is replayed as that choice; an install failure or a missing-module crash reinstalls; anything else restarts. Not offered for `exposed` or attached apps.
- **S48. Connect lists from the process table (2c; amends §6.2.3 and §9).**
  - §9's "Ports in use" sentence ("a dev server already running outside Aiden is attached when its port answers on the detected origin") is replaced by: "A dev server already running outside Aiden is never attached by itself. The person connects it from Connect running server…, or approves an `apps[].url` entry. Aiden reads ownership from the process and socket tables, never by contacting the port, and never stops it." (A-m5)
  - The scan runs only on the person's action.
  - It lists listening sockets of the person's own processes (by uid, read first) whose canonical folder is inside the workspace's `realpath`, each under the deepest app root holding it, or under its own folder when no root holds it.
  - It excludes every Aiden job tree, every Aiden descendant outside a terminal-drawer shell, ports below 1024, 9222, 9229, 24678 and Aiden's renderer port.
  - A partial read lists what was read and says some servers may be missing; every pick is re-checked fail-closed.
  - It makes no HTTP probe and offers no default-port suggestion.
- **S49. Attached servers (2c; amends S29's "one `lsof` per tick").**
  - **The check** finds the port's holder first, then its folder, inside `realpath(appRoot)` inside `realpath(workspace)`.
  - **The origin** comes from sockets: exactly `127.0.0.1` (or `::ffff:127.0.0.1`), else `::1`; never `localhost` and never another loopback address. Aiden serves exactly the origins the subtree holds.
  - **Ownership and loopback.** Every process in the holder's subtree must be the person's, and every socket loopback. The shared poller re-checks every 2 s, in the same `ps` as jobs but with its own socket read, so one side's failed look never fails the other.
  - **Re-binding.** A holder that exits may be replaced within 6 s by a same-uid process under the same parent holding the same address and port, whose folder (read strictly) is inside the app root and whose subtree carries no background job's marker; a new holder that fails either detaches at once, and anything else detaches after 6 s. While the holder is gone, its origin maps to no app.
  - **Detaching.** An attachment detaches when the holder is gone or stops holding the port (`attach-unreachable`), after three failed looks of its own (`attach-unreachable`), when it binds beyond loopback or another user's process joins (`attach-not-loopback`), on workspace changes, and 60 s after no canvas is visible. Stop means disconnect. Aiden never signals an attached process.
  - **No launch.** While attached, start and retry answer the attachment, and restart and choose refuse with `already-running`.
  - **Access.** Read-only and `none` workspaces can't attach.
- **S50. Attach consent (2c; S15).**
  - A Connect pick is itself the consent; main re-checks that the picked pid still holds the port.
  - An `apps[].url` needs the attach card, under its own key. Allow registers only if the re-check finds the same pid, process name and folder the card showed. The record is keyed by the canonical origin, the config text and the workspace's real folder, and the card asks again when any changes.
  - `design_app` can attach only url roots and has no connect action.
- **S51. `apps[].url` (2c; §6.3.6's example).**
  - Accepted: `http:`, a host of `localhost`, `127.0.0.1` or `[::1]`, an explicit port from 1024 to 65535, no credentials, query or fragment, and a path that is empty or `/`.
  - Anything else is `urlRefused` and shown as `attach-url-invalid`.
  - A url or refused-url root never launches, even with a `script`, and choose on it is refused with `not-web` before any card.
- **S52. IPv6 loopback apps (2c → 3a; amends §6.3.2).** An attached app may have the origin `http://[::1]:<port>`, since Vite on macOS often binds `localhost` to `::1` only. 3a adds `http://[::1]:*` to the main window's `frame-src` and treats `[::1]` like `127.0.0.1` in its filter. §6.3.4 already allows it.
- **S53. Browser listing (2c; §6.2.3).** A main-side feed from `onStatus` into `BrowserService`: running design apps, started and attached, are listed first in Local servers with a "design mode" label. There's no new IPC and no `BrowserServer` type change. 3a's `isAppOrigin` restriction applies to canvas frames only and must not block opening that URL in the browser panel.
- **S54. 2b contract widenings (2c).** D13's table:
  - the attach card fields and the two new problems;
  - `DesignAppConsent.request` for attach;
  - three channels and the handler `Pick`;
  - stop on attached, and start, restart, choose and retry on a live attachment;
  - logs while attached;
  - attached origins;
  - `designSockets` roots and their separate socket read;
  - `ProcessRow.uid` and the partial discovery option;
  - `readDesignLog`'s UTF-8 boundary;
  - `CanvasConfigApp.url`;
  - the records' `attaches`;
  - the new `attach-not-loopback` and `attach-unreachable` text.

  No 2b field is renamed or retyped.
- **S55. Aiden's own processes (2c).** Connect never lists, and an attach or re-bind never accepts, a process in any background job's tree, a holder whose subtree has a process carrying a background job's marker (`AIDEN_BACKGROUND_JOB=`, so a job's `setsid` escapee too), a descendant of Aiden outside a terminal-drawer shell, or a port Aiden uses for debugging. An environment that can't be read fails closed; on macOS that includes Apple's platform binaries, whose environment `ps -E` doesn't print. Servers the person runs in Aiden's terminal drawer are theirs and are listed.
- **S56. An attached root never launches (2c).** While a root is attached, nothing spawns for it: the toggle starts nothing, start and retry answer the attachment, and restart and choose refuse with `already-running`. The person disconnects first.

### Phase 3a amendments (2026-11-24)

Phase 3a (live app frames) is built from [`2026-11-24-design-mode-v2-p3a-live-frames.md`](../plans/2026-11-24-design-mode-v2-p3a-live-frames.md) behind `AIDEN_EXPERIMENTAL_DESIGN_LIVE`. Its pre-build probe outcomes are in that plan's As built section.

- **S57. Frameless requests use the initiator (3a; amends S3).** Electron 43.8.4's `webRequest` details carry `initiatorOrigin`. A `frame: null` request whose initiator is an app origin, another loopback origin or opaque gets the app rule. One with no initiator and a network scheme to a non-loopback host is cancelled unless it is on the audited frameless allowlist, which starts empty; each such cancel is logged (host only, rate-limited). The renderer's own initiator (as Task 5 recorded it) is untouched, and so are non-network schemes from it or with no initiator. An app, other loopback or opaque initiator gets the app rule for every scheme, so an app's worker can't reach Aiden's own schemes, files or another site's blobs (review fix, 2026-11-27).
- **S58. App frames are tracked by frame tree node (3a; amends §6.3.4).** An admitted main-window subframe stays an app frame for its element's life, even after it navigates to another loopback origin. Its descendants are app context too, as is any main-window subframe on a non-renderer loopback origin and any whose chain doesn't reach the main frame.
- **S59. Aiden's own loopback ports (3a).** App frames can't reach the debugging ports, the renderer dev server or any port an Aiden service or Aiden-spawned daemon listens on (S72 lists them).
- **S60. Permissions are decided by requesting URL (3a; amends S9).** Electron gives permission handlers no frame. The design layer denies every non-main-frame request in the main window that isn't from Aiden's own origin or schemes, every request from an app origin, every request in an app export window, and display and device requests from app context. Gemini Live registers through the dispatcher's owner slot; its handlers are unchanged. The main window answers `select-bluetooth-device` with no device, and the session's HID, serial and USB choosers cancel for app context.
- **S61. Blocked counts and dialogs come from main (3a; amends §6.3.3's `blocked`).** Main counts cancelled requests, blocked redirects and refused navigations per app frame and sends them to the canvas. Sandboxed-dialog counts are read by main from Chromium's console notice; the page can print the same text, so they are display-only. The bridge has no `blocked` message.
- **S62. The app frame box (3a; amends §6.3.1).** `w = round(viewport.width × scale)`; `h = round(viewport.height × scale)` plus the title row; `scale` has 4 decimals. In 3a a corner resize keeps the aspect ratio and changes `scale`.
- **S63. HMR in 3a is Vite's only (3a; S12).** The Vite client is imported only from the frame's own origin. Other frameworks' "save, then the DOM settled" signal lands in Phase 4 with the toasts.
- **S64. React source mapping outcome (3a; §11 item 5).** Task 2's result, on Vite 8.3.5 and React 19: `file:line` holds, through `_debugStack` and Vite's inline source maps (the fiber has no `_debugSource`). No component-only fallback is needed.
- **S65. Export draws app frames alone (3a; S13).** The hidden window is on the default session under both dispatchers; frames inside the app draw empty; the address comes from main.
- **S66. Frame-blocking headers (3a).** For an app origin's responses inside app frames, `X-Frame-Options` and CSP `frame-ancestors` are removed; nothing else of the app's own headers is weakened.
- **S67. Loopback refusal for every non-app frame, in both flag states (3a).** `frame-src` lists the loopback sources statically, so the frame guard refuses a main-window subframe to a loopback origin that isn't the renderer's unless it is an admitted app frame (flag on), and refuses a `frame: null` navigation toward loopback, `https:` or an unknown scheme. Nothing a page could do before 3a can be done now, flag off or on.
- **S68. Element comments, text editing, Inspect and measure on app frames move to Phase 4 (3a; amends §6.3.3).** 3a's bridge carries the v1 pick core; `inspect-at`, `measure-at` and `edit-*` are re-added to the v2 bridge in Phase 4, which wires the Comment tool's element anchors, Inspect and text editing to it. In 3a, C + click on an app frame places a frame-level pin.
- **S69. Admission of app frames (3a; amends §6.3.2 and §6.3.4).** A main-window frame becomes an app frame only when the renderer placed it as an `app` node and main recorded its name token and expected origin, it is a fresh direct child of the main frame, its first navigation goes to exactly that origin, the initiator is the main frame, and the flag is on. Generative-UI frames, v1 file frames and unknown frames keep v1's guard and pin and are refused loopback targets.
- **S70. The registry never forgets a live frame (3a).** Membership lasts for the element's life with no reset. At the cap, only frames gone from the main window's frame tree are pruned; if it is still full, the new frame isn't admitted and shows its snapshot with "Too many live frames".
- **S71. Transports outside `webRequest` (3a; next to S5).** WebTransport (HTTP/3 over QUIC, from pages, dedicated workers and service workers) isn't seen by `webRequest`, and Electron 43.8.4 can't turn it off: neither `--disable-blink-features=WebTransport`, `--disable-features=WebTransport`, `--disable-quic` nor a CSP `connect-src` stops it. It joins TURN over TCP and the dev server's server-side requests as a documented gap; the guarantee is what §3 states, requests that go through `webRequest`, and the full route is §5.1 B's proxy in a later phase. App-context documents and workers still get an added loopback-only `connect-src` and `X-DNS-Prefetch-Control: off` as defence in depth, and reporting headers are stripped. DNS prefetching is already off app-wide. Task 2's probe (Linux Space, Electron 43.8.4, a UDP observer per source):

  | Mode | Page | Dedicated worker | Service worker | `webRequest` saw it | CSP violation |
  |---|---|---|---|---|---|
  | no switch | datagrams | datagrams | datagrams | no | — |
  | `--disable-blink-features=WebTransport` | datagrams | datagrams | datagrams | no | — |
  | `--disable-features=WebTransport` | datagrams | datagrams | datagrams | no | — |
  | `--disable-quic` (+ the Blink switch) | datagrams | datagrams | datagrams | no | — |
  | CSP `connect-src` (confirmed active: `fetch` to example.com blocked) | datagrams | datagrams | datagrams | no | none raised |
  | CSP + `--disable-quic` | datagrams | datagrams | datagrams | no | none raised |

  Preconnect and DNS prefetch outcomes are recorded in As built.
- **S72. Aiden's own ports, complete (3a; extends S59).** The set covers every Aiden loopback listener in `main/` (including the device hub proxy and local device host), the device hub and agent daemons Aiden spawns or reuses, electron-updater's Squirrel.Mac proxy (from the native feed URL), the renderer dev server, and the debugging ports read from the real switches. `check:aiden-rules` fails when a new loopback `listen` isn't registered or allowlisted with a reason.
- **S73. App export hardening (3a; extends S13 and S65).** App frames export as PNG or PDF only. The app must be running before the Save dialog opens; the handler answers `app-not-running` or `live-off`. The export window's document is CSP-sandboxed (no downloads, modals, printing or popups), downloads from it are cancelled, and it renders at zoom 1. PNGs are 1×: Task 2 showed `capturePage` gives the same pixels under device emulation. The export waits for 500 ms with no new request, at most 15 s, and gives up after 30 s.
- **S74. `[::1]` framing outcome (3a; S52).** Task 2's result: Chromium rejects `http://[::1]:*` as an invalid `frame-src` source and ignores it, so `frame-src` lists only `http://localhost:*` and `http://127.0.0.1:*`, and app frames refuse `[::1]` origins with "This app runs on IPv6 localhost, which the canvas can't show yet. Restart it on 127.0.0.1."
- **S75. Focus and keys (3a; amends §6.3.2).** App iframes are `inert` until entered, so a page can't take focus from Aiden. Esc inside an entered frame reaches the canvas through the bridge's `escape` message; a click on the canvas also leaves. While presenting, app frames stay inert unless entered, and Open full window isn't offered for them. **Decided (2026-11-27):** Task 2's probe 8 showed `inert` alone doesn't hold: a page's repeated `focus()` still pulled focus out of the composer into an `inert` iframe (1 of 20 typed characters landed). So `inert` stays on every app iframe that isn't entered, and while any app frame is mounted one document-level guard listens in capture phase for `focusout` and the window's `blur`. When focus moves into an app iframe that isn't entered, it goes back to the element that lost it, if that element is still connected and focusable; when nothing of Aiden's had focus (the body), the iframe is blurred. The check runs synchronously and once more in a microtask, with no polling and no timers. Entering a frame exempts that iframe until it is left; presenting keeps the guard. The guard is held while any app frame shows a page and is removed with the last one and on dispose (`renderer/design/app-frame-focus-guard.ts`). The guard restores Aiden's DOM focus, but with the page in another process Chromium keeps the app frame focused, and keys routed as a keyboard's are go to the page. In the Space every same-task variant lost all 20 keys, and a `setTimeout(0)` restore still lost 1 to 4 of 20. Probe 8 had used `sendInputEvent`, which reaches only the main frame's widget, so it couldn't see this. **Decided (2026-11-27, K1):** while `AIDEN_EXPERIMENTAL_DESIGN_LIVE` is on, main turns on Blink's `BlockingFocusWithoutUserActivation` at startup (added to `--enable-blink-features`), and every app iframe's `allow` list sets `focus-without-user-activation 'none'`, so a page's own `focus()` does nothing until the person activates the frame. With both, 0 of 20 keys leaked; the `allow` token alone does nothing. The guard stays as defence in depth. Entering holds only for the page on screen when the person entered: when it goes (the app stops, restarts or moves), the frame is left and the next page mounts inert. Stepping a presentation or clicking off the slide leaves an entered frame. K1's E2E is the canary for a Chromium that drops the feature.
- **S76. App service workers don't outlive design mode (3a).** Main keeps a device-local list of origins only: every loopback origin (other than the renderer's own) that an app frame loaded a page from, including the other local servers an admitted frame or its subframes navigate to (G5). Their service workers are cleared when design mode ends for the workspace and at every start, flag on or off. An origin that frames of several workspaces reached is cleared only when the last of them ends (or at the next start): a worker is per origin, so an earlier clear would pull it from under a page that is still live. Ownership is asked inside the serialized clear, as each origin's turn comes and again once its clear is done, so a workspace that reaches the origin while an earlier workspace's end is still clearing keeps it too. No page is let onto an origin mid-clear: `designCanvas:appFrameMount` answers only once no clear of the app's origin is queued or running. A page that reaches an origin while its clear runs anyway (a G5 navigation is decided at once, or an admission after the mount answered) may lose the worker to it, so its app frame is reloaded once that clear is done and the page registers the worker again. **Bounded limitation:** from the moment such a clear takes a worker until that reload, the page runs without it, and a reload also follows when the page arrived just after its own clear finished but before the rest of that clear's origins did. Default-port pages are listed as `http://localhost` (no `:80`). An origin leaves the list only once its clear succeeded, and one whose clear failed stays for the next try. 64 is a soft bound: past it, the oldest origins no live workspace owns are evicted, through the same serialized clear as every other (so the ownership check, the mount wait and the reload apply). An owned origin is never evicted, so with every listed origin owned the list grows past 64 until a workspace ends.
- **S77. App frame states follow the app's phase (3a; amends §6.3.2).** Stopped, waiting for consent, installing or starting, crashed (with Retry), running before load (the snapshot stays), attached-lost, too many live frames, live apps off and not in this workspace each have a fixed overlay using 2c's chip labels.

### Phase 3b amendments (2026-11-27)

Phase 3b (routes and skill) is built from [`2026-11-27-design-mode-v2-p3b-routes-skill.md`](../plans/2026-11-27-design-mode-v2-p3b-routes-skill.md) behind `AIDEN_EXPERIMENTAL_DESIGN_LIVE`. Its deviations are in that plan's As built section.

- **S78. Route discovery reads files only (3b; §6.3.6).** A pure core (`app-routes-core.ts`) and a disk walker (`app-routes.ts`) that follows no links: the app root and its convention folders are `lstat`ed and confined to the workspace's realpath, linked entries are skipped, the two parsed files (`src/routeTree.gen.ts`, `app/routes.ts`) are read with `O_NOFOLLOW` and parsed by an O(n) tokenizer and a recursive-descent reader (16 levels). It skips `node_modules` and hidden folders and stops at depth 10, 2 000 entries, 500 routes and 256 KiB per parsed file, returning `truncated: true`.
- **S79. One pattern syntax (3b; §6.3.6).** Next's brackets for every framework and for `params` keys: `[name]`, `[...name]`, `[[...name]]`. TanStack and Remix `$x` become `[x]`, a bare `$` becomes `[...splat]`, optional segments are listed once as the pattern. `isConcreteRoute` (no bracket left) gates every placement.
- **S80. The conventions (3b; §6.3.6).** Next `app/**/page.*` and `pages/**` (also under `src/`); TanStack `routeTree.gen.ts`, else `src/routes/**`; React Router a literal `app/routes.ts`, else flat `app/routes/**` (other code gives `/` only); Remix flat `app/routes/**`; Astro `src/pages/**`; every other framework `/` plus canvas.json. `routeFromFile` answers one path (written files); `routesFromFiles` sees the tree and drops layouts (discovery).
- **S81. canvas.json `routes` and `params` (3b; §6.3.6).** `routes` (≤ 200) replaces discovery in its own order; `params` (≤ 50 keys, ≤ 20 values) fills single-parameter patterns only, with segment rules (no empty, `.`, `..`, hidden or control characters, ≤ 200 characters); bad entries are dropped silently. Only the disk walk is cached (5 s per root); canvas.json is read fresh on every call.
- **S82. `design_app {action: "routes", root?}` (3b; §6.5).** A read-only seventh action that works while the app is stopped and shows no card. It answers `{status: "routes", root, framework?, source, truncated, routes}`, up to 200 entries, as JSON values only.
- **S83. Route-aware placement (3b; §6.3.7).** File tools only; the deepest root owns a path; a dynamic route only with a canvas.json value; one `{snapshot, config}` read per turn; at most 12 per turn; `removedAppRoutes` (keys `"<appRoot>\u0000<route>"`, newest 200) with `undoneRoutes` on save; one written-files timeline shared with `design/` pages; entry takes the newest 12 of both kinds and places the single app's `/` only on an empty page.
- **S84. Where Aiden's work lands (3b; §6.5).** S18's order for every placement 3b adds; the person's Add uses the page on screen, checked by main.
- **S85. The remaining tool changes (3b; §6.5).** `device` (phone 390 × 844, tablet 768 × 1024, laptop 1280 × 800, desktop 1440 × 900), `variantOf` by id (beside the variant set, in the original's group or a new one) and `label` (its own field, shown in the header); `canvas_update_frame` takes `route`, the viewport, `device` and `label` and keeps scale; `canvas_read` reports `blocked` from live mounts as a count only. Errors in `canvas_read` move to Phase 4. One analytics dependency, `onAppFrameAdded`, on the canvas tools.
- **S86. The live prompt and skill (3b; §6.5).** The live prompt section follows the turn's tools (`design_app` offered) and is static per turn; `LIVE_APP_PROMPT_MARKER` lets a stored live section be replaced. The skill keeps one name: `aidenDesignSkill(live)` returns the live text only with the flag on, and its live sections open with "When design_app is among your tools". `data-aiden-comment` in JSX moves to Phase 4. "Ask which to keep" stands in for Adopt until Phase 5.
- **S87. Add ▸ Page from app… (3b; §6.3.6).** Enabled for any known app (candidate, started or connected); the canvas flushes its pending save first, sends the page on screen and its view size, and main checks both. `placed` and `already` both focus the frame; `full` answers a full page. The placement is the person's own undo step.
- **S88. `design_app_frame_added` (3b; §6.10).** `{source: person|aiden, device_bucket}` with S85's buckets, reported from four call sites (the canvas tools, a written route, entry, and the person's Add), each after its write committed, never for a reused, refused or retracted frame. It carries no route, root, framework or count.
