# Design mode v2 — Phase 3a: live app frames — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Revision 2 (2026-11-24).** This revision applies both plan reviews (A: anti-goals only; B: spec, feasibility and tests) as decided in the review-decisions note. Every finding is mapped to its task and step in "Applied review decisions" at the end. Code claims were rechecked against 2c's head `117e52170` and Electron 43.8.4's `node_modules/electron/electron.d.ts`.

**Goal:** A route of the workspace's running web app shows on the canvas as a live, interactive frame, and nothing that frame does can reach the internet, leave its frame, open a dialog or a window, download a file, take keyboard focus from Aiden, or get a device permission.
- A new frame kind, `app`, names an app root and a route. The canvas draws it as an `<iframe>` of the app's **own loopback origin** (served or attached, from 2b and 2c), at a real viewport size, scaled to its box. It counts toward the six-live limit. With no server running it shows its last snapshot under an overlay that follows the app's phase: **Start app** (or **Connect**), "Waiting for you to allow…", "Starting…", or the crash sentence with **Retry**.
- **Admission is main's decision.** A main-window frame becomes an app frame only when the renderer placed it as an `app` node, main recorded its name token and the origin it expects, it is a direct child of the main frame, and its first navigation goes to exactly that origin. Every other frame (generative UI, v1 file frames, anything else) keeps v1's guard and pin, and a loopback target stays refused for it, flag on or off (S69).
- **Every request** from an app frame, from any frame nested inside it, from a frameless request an app origin started, and from an app export window goes through one **default-session request dispatcher**. Only `http:`/`ws:` to `localhost`, `127.0.0.1` and `[::1]` (minus Aiden's own ports), `data:` and `blob:` pass. Everything else is cancelled and counted. Transports that skip `webRequest` are narrowed where Electron allows: app responses carry a loopback-only `connect-src` and `X-DNS-Prefetch-Control: off`, and reporting headers are stripped. WebTransport can't be seen or switched off in Electron 43.8.4, so it is a documented gap next to TURN over TCP and server-side requests (S71).
- **No modals, popups, downloads or top navigation.** The iframe's sandbox is `allow-scripts allow-same-origin allow-forms` (S10). A navigation guard pins app frames to loopback; a link out shows "Open in browser", which opens the URL in Aiden's browser panel. A subframe redirect never reaches `shell.openExternal` (S1).
- **No focus theft.** An app iframe is `inert` until the person enters it, so a page script can't pull focus out of Aiden's composer (S75).
- **Permissions are denied** for app frames by one default-session permission dispatcher, which Gemini Live now registers through (S9).
- Main **injects a v2 bridge** into each app frame. Everything the bridge says is untrusted data (S11). In 3a the canvas uses it for the route, errors, Vite HMR (S12), Esc and the Dark switch; React source mapping is checked against React 19 (§11 item 5).
- A frame that had requests cancelled shows **"N blocked"** in its title, with a popover listing the hosts (§6.3.5).
- Aiden can place app frames with a minimal `canvas_place_frame {kind: "app"}` (S6). Download renders app frames as PNG or PDF in a hidden window **on the default session**, under the same dispatchers, with downloads, printing, popups and dialogs blocked (S13, S73).
- Session-cookie logins work in packaged (`file://`) builds through a `Set-Cookie` rewrite, or are documented as a known limit (S4).

Everything above is behind `AIDEN_EXPERIMENTAL_DESIGN_LIVE` (default off). With the flag off, nothing changes (D1).

**Architecture:**
- **Shared contract (`renderer/shared`).**
  - `design-canvas/schema.ts` gains the `app` kind and its fields.
  - `design-canvas/app-frame.ts` (new, pure) holds route and app-root validation, the frame box and its rounding, the iframe name format, the sandbox token list and the `allow` list.
  - `design-canvas/app-bridge-messages.ts` (new) parses every bridge message defensively.
  - `design-canvas/app-frame-events.ts` (new) holds the main → renderer event shapes (blocked, refused navigation, suppressed dialog) and the `designCanvas:appFrameMount` reply.
- **Session plumbing (`main/services`).**
  - `default-session-web-request.ts` (new) is the only owner of `session.defaultSession.webRequest.onBeforeRequest` and `onHeadersReceived`. Subscribers compose; a second claim throws; with no subscriber the Electron listener is removed (§11 item 4).
  - `default-session-permissions.ts` (new) is the only owner of the default session's permission check, permission request, display-media and device permission handlers, and of its `will-download`, `select-hid-device`, `select-serial-port` and `select-usb-device` events. It has deny layers, event subscribers and one owner slot, which Gemini Live's existing guard fills (S9).
  - `loopback-ports.ts` (new): the live set of Aiden's own loopback ports (S72).
- **App frames (`main/services/design-canvas/app-frames/`, new folder).**
  - `app-network-policy.ts` (pure): the request verdict table, the loopback test, the `Set-Cookie` rewrite, the response-header rules and the cancel cache.
  - `app-frame-registry.ts`: placement records, admission, and the set of main-window frames that are app frames, by Chromium's `frameTreeNodeId`. It never forgets a live frame (S70). It maps each to its canvas frame id for events, and counts blocked hosts.
  - `app-frame-guard.ts` (pure): navigation and redirect decisions for every main-window subframe, including the flag-off loopback refusal.
  - `app-network-main.ts`: the design subscribers on both dispatchers, installed from `main/index.ts` right after the claims, before any window exists, only when `designLiveEnabled()`.
  - `app-bridge-source.ts`: the v2 bridge script. It shares the v1 core with `bridge-source.ts`, extracted into `bridge-core-source.ts`.
  - `app-bridge-main.ts`: injection into app frames with a per-document nonce.
  - `app-export.ts`: the hidden default-session export window for app frames.
  - `app-sw-origins.ts`: the device-local list of app origins whose service workers are cleared (S76).
- **Main window.**
  - `main/windows/main-window-navigation.ts` (new) takes `setWindowOpenHandler`, `will-navigate`, `will-redirect` and `will-frame-navigate` out of `main/index.ts` (`:1953-1975`) unchanged for the flag-off path, so they can be tested by register and invoke. It adds the S1 subframe redirect rule, admission and the app guard when the flag is on, and the loopback refusal for every non-app subframe in both flag states. It runs for every main window Aiden creates, including one recreated after close.
  - `main/windows/main-window-console.ts` (new) takes the `console-message` listener out of `main/index.ts` (`:1945-1951`). Gemini Live's `[aiden-live]` markers are accepted from the main frame only; with the flag on it also counts sandboxed-dialog notices from app-context frames (D10).
- **Renderer.** `renderer/design/nodes/app-node.tsx` draws the frame. It asks main for admission through `designCanvas:appFrameMount`, which returns the origin to frame. It listens for `designCanvas:appFrame` events and draws the blocked label and popover, the Open in browser toast, the phase overlays and the Dark switch.
- **CSP.** `main-window.html`'s `frame-src` gains `http://localhost:* http://127.0.0.1:* http://[::1]:*` (S52). This is static, so the frame guard refuses those frames for everything but an admitted app frame (D11).

**Tech Stack:** TypeScript (ESM), Electron 43.8.4 main, React renderer, happy-dom for the bridge, `tsx --test` for unit and integration tests, and Playwright for one new E2E spec in the Cua Space.

**Spec:** `docs/superpowers/specs/2026-11-23-design-mode-live-app-design.md`:
- §3 anti-goals 1 and 5; §4; §5.1;
- §6.3.1–§6.3.5 and §6.3.10; §6.10; §6.11; §7 (main services, bridge, E2E);
- §8 row 3a and the pre-build checks after it: §11 items 4, 5 and 7;
- §12 S1, S3, S4, S5, S6, S9, S10, S11, S12, S13 and S15, plus 2b's S29 (served origins), 2c's S49 (attached origins, the lost holder), S52 (`[::1]` in `frame-src`) and S53 (the browser panel is never restricted).

**Stacking.** 3a's branch is `t3/design-mode-v2-p3a`, cut from `t3/design-mode-v2-p2c` (PR #919, on 2b #916, DM #915, 2a #911, 1b #908 and 1a #894) at `798fb4093` or later. Line numbers below were rechecked at `117e52170`. Task 0 checks that 2c's head has:
- `DesignAppServers.forgetWorkspace`, `appForOrigin`, `isAppOrigin` and `onOriginsChanged` (`app-server-main.ts:535`, `:553`, `:578`, `:585`), including attached entries and the lost-holder rule (2c As built #29);
- `serve()` and `serveAttached()` registering `127.0.0.1`, any held `[::1]` and the `localhost` alias (`:1409`, `:1417`);
- `useDesignAppsSnapshot(chatId, enabled)` (`renderer/design/design-app-chip.tsx:89`);
- the browser feed `designAppServers.onStatus → browserService.setDesignServers` (`design-canvas/main.ts:341`);
- `DesignAppPhase` (`renderer/shared/design-app.ts:38`) and the `designApp:retry` channel.

If 2c changes after `117e52170`, re-read its "As built" and "Code-review fixes" notes and update the "What exists today" table and D21 before starting.

3a's spec amendments are **S57–S77**.

**Security review (§11 item 7).** One of 3a's two plan and code reviewers is briefed **only on §3's anti-goals** and this plan's network and guard tables (D3, D3b, D9). The other reviews everything.

## Scope

In scope:
- the `app` frame kind (§6.3.1) and its renderer node (§6.3.2), with the six-live limit, snapshots, phase overlays, enter and leave;
- the iframe sandbox without `allow-modals` (S10), a Permissions Policy `allow` list that grants nothing, `inert` while not entered (S75), and the CSP's `frame-src` (S52);
- admission of app frames by placement record (S69), and the loopback refusal for every other main-window subframe in both flag states;
- a minimal `canvas_place_frame {kind: "app"}` (S6), plus app frames in `canvas_read`, and clear refusals from the tools that can't handle them yet;
- bridge injection and the v2 bridge (§6.3.3): the v1 pick core under the `aiden-app:` prefix, `route`, `error`, `hmr` (Vite only, S12), `source`, `escape` and `set-scheme`. All of it is untrusted (S11);
- the default-session request dispatcher and the design subscriber (§6.3.4, S3, S15), and the transports outside it (S71). The test is the D3 and D3b tables;
- Aiden's own loopback ports, complete, with a drift guard (S72);
- subframe redirects (S1);
- the default-session permission dispatcher, shared with Gemini Live (S9), with the session's download and device-chooser events;
- `Set-Cookie` handling for `file://` builds (S4), stripping frame-blocking and reporting headers from app responses (D7);
- the navigation guard, Open in browser, and the blocked notice (§6.3.5);
- export on the default session (S13, S73);
- clearing app service workers (S76);
- the fixture app `tests/fixtures/design-live-app/` and the live-frame E2E (§7), with observer oracles;
- the React 19 source-mapping check (§11 item 5) and the Electron probes (Task 2);
- docs (including PRODUCT.md and `docs/design-mode.md`), spec amendments S57–S77, `.memory/design-mode.md` and this plan's as-built notes.

Out of scope:
- **3b:** route discovery, `.aiden/canvas.json` `routes` and `params`, Add ▸ Page from app, route-aware placement, the rest of the tool changes (`canvas_update_frame` for routes and viewports, `canvas_duplicate`), the skill and prompt rewrite, and `design_app_frame_added` (§8 row 3b).
- **3c:** edge-drag reflow, breakpoint ticks, the device menu, Add view at width and the ⌘D variant. `variantOf` is parsed in 3a and nothing writes it.
- **4:** Inspect (X) with `inspect-at`, measure with `measure-at`, element chips, change toasts and changed-frame dots, error frames with Fix with Aiden, the non-Vite HMR signal, `design_inspect`, and **comments anchored to elements and text editing (`edit-*`) on app frames** (S68). 3a's bridge carries the v1 pick core so 4 only wires the UI; in 3a the Comment tool places a frame-level pin on an app frame.
- **7:** onboarding and the README line. Live apps stay flagged.
- **Analytics.** No 3a event (D19). `design_app_frame_added` is 3b's.
- **Remote, iOS, Android and the CLI.** Design mode is desktop-only. Nothing 3a changes reaches the Remote projection, and the CLI doesn't bundle `design-canvas/`.
- **Windows.** Live apps are `unavailable` there (2c), so no app frame can have an origin; the dispatchers have no design subscriber.
- **WebRTC TURN over TCP and the dev server's own server-side requests.** These are outside `webRequest` (S5) and stay documented gaps. Whatever Task 2's probes show for preconnect and DNS joins them in S71.

**Feature flag.** While `designLiveEnabled()` is false:
- the design subscribers are never added to either dispatcher, so the default session has **no** `webRequest` listener, no `will-download` listener, and the permission handlers are exactly what Gemini Live sets today (null when Live is unbound);
- `main-window-navigation.ts` runs today's handlers byte-for-byte, plus one refusal: a main-window subframe navigating to a loopback `http:` origin other than the renderer's own is refused, as is any subframe navigation reported with `frame: null` to a loopback `http:`, `https:` or unknown-scheme target. That is what today's CSP does (D11);
- no bridge is injected, no `designCanvas:appFrame` event is sent, and `designCanvas:appFrameMount` answers `{error: "live-off"}`;
- `canvas_place_frame`'s `kind` enum and description are today's; `canvas_read` reports any `app` frame as `kind: "app"` with its route but nothing places one;
- an `app` frame already in a document (from a run with the flag on) draws as a static card, "Live apps are off", with its last snapshot and no iframe;
- export refuses an `app` frame with `{error: "live-off"}`, shown as "Live apps are off.";
- at startup, service workers of origins on the S76 list are still cleared, and the list emptied, so nothing an app registered keeps running.

These are unflagged and inert while the flag is off:
- the two dispatcher modules and the Gemini Live owner slot (Live behaves as today; Task 4 proves it with Live's own tests unedited);
- `loopback-ports.ts` (it only records);
- the schema's `app` kind (parsing it changes nothing for documents without one);
- the CSP's `frame-src` additions (the guard refuses those frames);
- `main-window-navigation.ts` and `main-window-console.ts` (moves, with the flag-off path tested against today's behaviour; the only console change is that Live markers must come from the main frame, which is the only frame that sends them).

## What exists today (checked against 2c's head `117e52170`)

| Item | Today | 3a action |
|---|---|---|
| Main window navigation (`main/index.ts:1953-1975`) | `setWindowOpenHandler` opens every URL externally and denies; `will-navigate` prevents and opens externally; **`will-redirect` prevents and opens externally for every frame, subframes included** (`:1963`); `will-frame-navigate` runs `createDesignFrameNavigationGuard` | Moved into `main-window-navigation.ts`. Flag off: same, plus the loopback-subframe refusal and the `frame: null` refusal (D11). Flag on: `will-redirect` acts only on the main frame; subframe redirects go to the app guard (S1, D9) |
| Main window lifetime (`main/index.ts:1895-1899`, `:2066`, `:2330`) | `mainWindow = null` on `closed`; `app.on("activate")` → `showMainWindow()` → `createMainWindow()` makes a new window | Navigation, console, registry binding and injection run for **every** created window; main looks the window up through a getter, never a captured reference (D6) |
| Startup switches (`main/index.ts:254`, `:264`) | `enable-features=GlobalShortcutsPortal` (Linux), `blink-settings=dnsPrefetchingEnabled=false` (all) Unchanged. No WebTransport switch is added: the Task 2 probe showed none of them stops it (S71). DNS prefetching is already off app-wide |
| WebRTC (`main/index.ts:1686`) | `disable_non_proxied_udp` on the main window | Unchanged; TURN over TCP stays a documented gap (S5) |
| `console-message` (`main/index.ts:1945-1951`) | Forwards fixed `[aiden-live]` markers from **any** frame (200 per window) | Moved to `main-window-console.ts`; markers accepted only when `details.frame` is the main frame. Flag on: an app frame's sandboxed-dialog notice is counted (D10). Nothing is forwarded |
| `createDesignFrameNavigationGuard` (`frame-navigation.ts:44-64`) | Pins `aiden-design:` frames to their host; any other subframe may go anywhere; `if (isMainFrame \|\| !frame) return true` (`:52`) | Kept as is for `aiden-design:` targets. `app-frame-guard.ts` runs the v1 pin **first**, then admission, the app rule, and the loopback and `frame: null` refusals (D9) |
| CSP (`main-window.html:8`) | `frame-src 'self' aiden-genui: aiden-design:` | Adds `http://localhost:* http://127.0.0.1:* http://[::1]:*` (S52, D11). Task 2 checks Chromium keeps the `[::1]` source (S74) |
| Production CSP (`scripts/renderer-csp.ts:4`, `scripts/verify-renderer-csp.mjs:9`) | Strips localhost from `script-src` and `style-src`; the release check rejects localhost there | `frame-src` keeps its loopback sources in production. The release check gains a `frame-src` rule (D11) |
| Default-session `webRequest` | No listener anywhere (§11 item 4). Partition listeners: browser panel and Bots (`browser/service.ts:736-762`), design offline (`offline-session.ts:53`) | `default-session-web-request.ts` owns it (D6) |
| Default-session `will-download` | **None.** Only the browser partition (`browser/service.ts:793`) and the offline partition (`offline-session.ts:63`) cancel downloads | `default-session-permissions.ts` owns it; the design subscriber cancels export-window and app-context downloads (D8, D18) |
| `OnBeforeRequestListenerDetails` (`electron.d.ts:22942`) | Has `frame?: WebFrameMain \| null`, **`initiatorOrigin?: string`** (`:22955`), `webContentsId?`, `resourceType` (no WebTransport value, `:22963`) | S3 said there is no initiator; 43.8.4 has one. D4 uses it (S57) |
| `WebContentsWillFrameNavigateEventParams` (`electron.d.ts:24605-24631`) | `url`, `isMainFrame`, `frame: WebFrameMain \| null` (null after the frame navigated or was destroyed), **`initiator?: WebFrameMain \| null`** | Admission requires the initiator to be the main window's main frame; Task 2 records what Electron reports for an `src`-set navigation (D2) |
| `WebFrameMain` (`electron.d.ts:19138-19260`) | `frameTreeNodeId`, `parent`, `name`, `origin`, `detached` (`:19246`), `frames` (`:19251`), `framesInSubtree` (`:19257`), `isDestroyed()` (`:19191`), `executeJavaScript(code, userGesture?)` (`:19187`) | Liveness comes from `mainFrame.framesInSubtree` (S70); injection passes `userGesture: false` |
| `PermissionRequest` (`electron.d.ts:10865`), `PermissionCheckHandlerHandlerDetails` (`:23349`) | Only `isMainFrame` and `requestingUrl` (plus `securityOrigin`, `embeddingOrigin` on checks). **No frame**. Check and request permission names (`:13473`, `:13482`) list no background-sync, periodic-sync or background-fetch name | The deny rule works from the requesting URL, `isMainFrame` and the web contents (D8, S60) |
| Gemini Live permissions (`gemini-live/display-media-contract.ts:112-215`, wired in `gemini-live/service-main.ts:142-156`) | `installGeminiLiveDisplayMediaGuards(session.defaultSession, …)` sets all three handlers while a Live document is bound and sets them to `null` on dispose. It keys a `WeakMap` by the session object (`:139`, `:163-166`). `DisplayMediaGuardSession` isn't exported (`:112`). `service-main.ts` reinstalls on every binding change | `service-main.ts` passes the permission dispatcher's owner slot, which is the **same object** for every call with the same name. `DisplayMediaGuardSession` gains `export`; the guard's code and tests are otherwise unchanged (D8) |
| `display-capture-acceptance.ts:149-263` | An isolated acceptance launch mode that sets default-session handlers directly | Unchanged: that mode never starts design mode or the dispatchers (Task 0 checks `bootstrap.ts:51` routes it before `main/index.ts`). On the `default-session-owner` allowlist (Task 4) |
| v1 bridge (`bridge-source.ts:42`, `DESIGN_BRIDGE_SOURCE`) | Served inside `aiden-design:` HTML; `aiden-design:` prefix; hover, pick, locate, highlight, anchors, tweaks, text edit | Its pick core moves into `bridge-core-source.ts`, shared with the v2 bridge. `bridge-source.test.ts` passes unedited (D12) |
| `parseDesignBridgeMessage` (`renderer/shared/design-canvas/bridge-messages.ts`) | Bounded, defensive parse of `aiden-design:` messages | Unchanged. The v2 parser is separate (`app-bridge-messages.ts`) and accepts only `aiden-app:` |
| Renderer `message` listeners (`design/nodes/file-node.tsx:111-114`, `design/design-comments.tsx:180-185`, `components/html-artifact-frame.tsx:215-218`, `visual-viewer/main.tsx`) | Each checks `event.source` against its own frame. **`design-comments.tsx:182-183` accepts any `iframe[data-frame-id]` in the canvas** and writes anchors from it | App iframes never carry `data-frame-id` (they use `data-app-frame-id`), and `design-comments.tsx` also checks the frame's kind is `file` (D16). Task 11 tests both |
| Frame kinds (`schema.ts:19`, `FRAME_KINDS` `:268`, `parseFrame` `:520`) | Ten kinds, no `app` | `app` added with its fields (D15) |
| `isDesignPrintable` (`schema.ts:126`) | Gates `dark` (`:580`), `printMode`/`paper` (`:604`), export formats (`frame-export.ts:25`), the side panel's print controls, the comment `look` and `canvas_update_frame`'s `dark`/`paper`/`printMode` | **Unchanged**: false for `app`. `designExportFormats` gains an `app` case, `["png", "pdf"]` (D15) |
| `designMinSize` (`schema.ts:146`), clamp at `:781` | One minimum per kind | `designMinSize("app")` is 10 (200 × 0.05), so the generic clamp never moves a recomputed app box (D15) |
| Node types (`renderer/design/nodes/registry.ts`) | One per kind | `app: AppNode` |
| Live set (`renderer/design/live-set-core.ts:16`, `canBeLive`) | `file` and `artifact` | Adds `app` |
| File frame sandbox (`file-node.tsx:33`) | `allow-scripts` | Unchanged; app frames use their own token list (D16) |
| Present and full window (`design-present.tsx:14-27`) | Canvas keys (Esc, arrows) drive present; `single` is Open full window | App frames show live but `inert` while presenting; `single` isn't offered for app frames (D16) |
| Comment geometry (`comment-geometry.ts:31`, `design-comments.tsx:298`) | Element anchors on `file` frames only | An app frame takes a frame-level pin with no element (D16) |
| `canvas_place_frame` (`canvas-tools.ts:1109`, `PLACED_KINDS` `:114`) | Eight kinds; one description | Flag on only: `app` joins the kinds with `appRoot` and `route` (D17) |
| `llm-client.ts:3003`, `:3046`, `:3078` | `designLive` computed once; canvas tools get no app deps | Canvas tools get `designLive` and an `apps` reader over `designAppServers` (D17) |
| 2b/2c origins (`app-server-main.ts:553`, `:578`, `:585`) | `appForOrigin` matches exact held addresses (not while a holder is lost); `isAppOrigin` is sticky per session until `forgetWorkspace` (`:535`); `onOriginsChanged` fires on every change | Read by the registry, the policy, the guard and injection. No change to 2b/2c types (D21) |
| `DesignAppStatus.origin` (`renderer/shared/design-app.ts:83`) and `DesignAppPhase` (`:38`) | `"http://127.0.0.1:5173"` or `"http://[::1]:5173"` while running; phases `stopped \| consent \| installing \| starting \| running \| crashed` | Main resolves the origin at mount time and returns it; the overlay follows the phase (D16) |
| Framework detection (`app-server-core.ts:104`, `:126-146`) | Reads `dependencies` and `devDependencies`; Vite matches the `vite` package | The fixture declares `devDependencies` (Task 1) |
| Export (`main/handlers/design-canvas.ts:619-685`, `designCanvas:export`; `DesignCanvasExportResult` `:150-154`; `frame-render.ts:54-90`) | Asks for the Save destination (`saveFile`, `:663`) before rendering; errors are codes (`unavailable`, `missing`, `failed`); the hidden window is on the offline partition, and `frame-render.ts:79-83` resets zoom per commit because Chromium keeps zoom per host | App frames: check the app is running **before** the Save dialog; new codes `app-not-running` and `live-off`; a separate path in `app-export.ts` on the default session at zoom 1 with 2× through device emulation (D18) |
| `designCanvas:source` (`main/handlers/design-canvas.ts:694`) | Code tab for page and artifact frames | Refuses app frames with `{error: "unavailable"}` and the Code tab is hidden for them (D18) |
| Offline session (`offline-session.ts:44-63`) | Its own `webRequest`, permission handlers, download cancel and proxy | Unchanged. It is the pattern the export window follows, minus the proxy (S13) |
| Browser panel (`browser/service.ts`) | Its own partition; 2c lists design apps first | Never sees the design subscriber, so opening an app URL there works (S53). The E2E checks it with the flag on |
| `designLiveEnabled` (`studio/feature-flags.ts:37`), renderer capability `designLive` (`:55`) | 2b's flag | Gates every 3a path |
| Aiden's own loopback listeners (`.listen(` in `main/`) | `aiden-remote-service.ts:341`, `aiden-mcp-server.ts:98`, `mcp-oauth-loopback.ts:180`, `acp/mcp-bridge.ts:99`, `bot-computers/viewer-hub.ts:680`, `browser/files.ts:862`, `devices/local-device-host.ts:844`, `devices/device-hub-proxy.ts:571`; spawned: the device hub (`local-device-host.ts:428-431`, `--port <n> --host 127.0.0.1`) and the agent daemon's `httpPort`, new or reused (`:492-522`); electron-updater 6.8.9's Squirrel.Mac proxy (`MacUpdater.js:209`); the renderer dev server and the debugging ports | All registered with `aidenLoopbackPorts`, with a drift guard in `check:aiden-rules` (D5, S72) |
| `electron.autoUpdater.getFeedURL()` (`electron.d.ts:2121`), `app-updater.ts:323` | `MacUpdater` sets the native feed URL to its proxy (`http://127.0.0.1:<port>`) before it emits `update-downloaded`, which `app-updater.ts` already listens to | The proxy's port is read from `getFeedURL()` on `update-downloaded` (D5) |
| E2E launch environment (`tests/e2e/design-app-status.spec.ts:173`) | Specs pass `appEnvironment: { AIDEN_EXPERIMENTAL_DESIGN_LIVE: "1", … }` | The v1 specs gain a flag-on run through the same helper (Task 14) |

## Decisions

**D1. What 3a changes, and what the flag protects.**
- With the flag on, 3a adds the `app` kind, its node, admission, the bridge, the two dispatcher subscribers, the guard and app export.
- With the flag off, the observable behaviour is today's. The only code that runs is:
  - the dispatcher modules with no design subscriber, which for `webRequest` and `will-download` means no Electron listener at all;
  - the Gemini Live owner slot, which passes Live's handlers through untouched;
  - the moved navigation and console handlers, with today's behaviour;
  - the guard's loopback and `frame: null` refusals, which stand in for the CSP sources that are now static;
  - the S76 startup clear of app service workers (only origins an earlier flag-on run recorded).
- Every 2b and 2c rule stays: consent, presence, the 60 s stop, attaching, `appForOrigin` and `isAppOrigin`. 3a reads those; it never widens them.

**D2. What an app frame is (S69, S70).**
- **Placement record.** Before it sets an app iframe's `src`, the renderer calls `designCanvas:appFrameMount(chatId, frameId, mountToken)`. Main checks the flag, that the chat is attended and in design mode, reads the frame from the store (it must be `kind: "app"`), resolves the app root's running status by the chat's `workspaceId` and the frame's `appRoot` (never by `appRoot` alone), and records `{name: appFrameName(frameId, mountToken), expectedOrigin, frameId, mountToken, expiresAt: now + 30 s}`. At most 12 records wait at once (two per live frame); the oldest waiting record is dropped first, which only means that frame mounts again. The reply is `{origin}` or `{error: "live-off" | "app-not-running" | "too-many-frames" | "unavailable"}`. The renderer frames exactly the returned origin plus the route; it never builds an origin.
- **Admission.** On the main window's `will-frame-navigate`, a frame becomes an app frame only when **all** of these hold:
  - the flag is on and the registry is installed for this window;
  - `frame` is not `null`, `isMainFrame` is false, and `frame.parent` is the main window's main frame (a direct child);
  - `frame.name` equals a waiting record's name, and the record hasn't expired. The record is consumed by the first navigation that names it, whatever the outcome;
  - the target URL's origin is exactly the record's `expectedOrigin`;
  - the frame has never committed a document: its current URL is empty or `about:blank`, and it is not in the v1 guard's `designFrames`;
  - `initiator` is the main window's main frame. Task 2 records what Electron 43 reports for a navigation started by setting an `<iframe>`'s `src`. If it is `null` there, the rule accepts `null` as well, but never any other frame, and As built records it;
  - the registry has room after pruning (below).

  The name is a necessary token, never a sufficient one: a page can't learn the random `mountToken`, and the record is one-use. Every other main-window frame (a generative-UI frame, a v1 file frame, an unknown frame) keeps the v1 guard and pin, and a loopback target stays refused for it, flag on or off (D9, D11).
- **The set never forgets a live frame (S70).** `app-frame-registry.ts` keeps a set of Chromium `frameTreeNodeId`s. A `frameTreeNodeId` lasts as long as its `<iframe>` element, across navigations and process swaps, and Chromium never reuses one. Membership is sticky for the element's life: a frame that later navigates to another loopback origin, or a page that rewrites its own `window.name`, is still filtered. There is **no** reset on any navigation, same-document, in-page or of the main document. The set has a cap of 512. When an admission finds it full, main prunes only ids whose frame is no longer in `mainWindow.webContents.mainFrame.framesInSubtree`. If it is still full, admission is refused and the mount reply was already `too-many-frames` or the frame shows the snapshot with a "Too many live frames" label; nothing is ever evicted.
- **App context.** A request or navigation is in app context when any of these holds:
  - its frame, or any ancestor up `frame.parent`, is in the set. That covers nested iframes, `srcdoc`, `data:` and `blob:` frames;
  - its frame belongs to the main window, isn't the main frame, and its committed `frame.origin` is loopback `http:` other than the renderer's own (a backstop: such a frame can't exist without admission, so finding one fails closed);
  - its frame belongs to the main window, isn't the main frame, and its `parent` chain doesn't reach the main frame (fenced-frame or inner-tree roots);
  - reading its `url`, `origin` or `parent` throws (destroyed) and its web contents is the main window.
- **Per window.** The registry is bound to the current main window through a getter (`() => mainWindow?.webContents ?? null`). A window recreated after close (`main/index.ts:1899`, `:2330`) gets the same navigation and console wiring, and its frames register against it.
- **Mapping to the canvas.** The name `aiden-app:<frameId>:<mountToken>` maps the frame to `{frameId, mountToken}` for events. Events for a frame in app context only through the backstop are dropped.
- **Export windows** register their `webContentsId` with the registry for their lifetime. Everything in them is app context (D18).

**D3. The network policy (§6.3.4, S1, S3, S15).** `appRequestVerdict(request, context) → "allow" | "cancel" | "untouched"` is pure. `context` supplies `appContext(frame)`, `isAppOrigin(origin)`, `isExportContents(id)`, `rendererOrigin`, `ownPorts` and `frameless` (the D4 allowlist).
- **Loopback** means a URL whose WHATWG-parsed `protocol` is `http:` or `ws:` and whose `hostname` is exactly `localhost`, `127.0.0.1` or `[::1]`, on a port not in `ownPorts`. URL parsing normalizes first, so `http://2130706433:5173` is `127.0.0.1` (allowed) and `http://[0:0:0:0:0:0:0:1]` is `[::1]` (allowed). `localhost.`, `*.localhost`, `0.0.0.0`, `127.0.0.2` and `[::ffff:7f00:1]` are not loopback here. The renderer's own origin (`file://`, or the dev origin `http://127.0.0.1:4143` from `AIDEN_RENDERER_URL`, `run-development-runtime.mjs:29`) is never an app target: its port is in `ownPorts`.
- **Allowed in app context:** loopback, `data:`, `about:blank`/`about:srcdoc`, and `blob:` whose inner origin is loopback.
- **Everything else in app context is cancelled**: `https:` (loopback included), `wss:`, any other host, `file:`, `aiden-design:` (S15), `aiden-genui:`, `aiden-asset:`, `aiden-attachment:`, `chrome-extension:`, `devtools:` and any unknown scheme. A cancel is reported to the registry with the URL's host (for `http(s)`/`ws(s)`) or its scheme, never the path or query.
- **A request that throws** while the policy runs is cancelled when its frame, initiator or web contents could be app context, and logged once per minute.
- **Main-window main-frame requests are never touched**, and nor are requests from any frame that isn't app context. Redirect hops reach `onBeforeRequest` again with the new URL, so a loopback → external redirect of a `fetch` is cancelled at the second hop.
- **Cancel cache (main-thread load).** A buggy app that retries a cancelled host in a tight loop sends thousands of synchronous calls into main. The policy keeps a 1 s cache of **cancel** verdicts only, keyed by `{frameTreeNodeId, scheme, host, port}` (or `{webContentsId, …}` for export windows). A cache hit cancels without re-walking the frame tree and only bumps the host's counter. Caching only cancels keeps it fail-closed whatever changes in the meantime. Task 5 has a load test: 10 000 cancels from one frame take under 250 ms of policy time on the host, and the dispatcher still answers an unrelated request in under 5 ms during the burst.

The test is this table, run through `appRequestVerdict` with fabricated `details` (Task 5) and, for the starred rows, end to end in the E2E (Task 14), where a `*` means an **observer listener must see zero bytes, connections or hits** (D3b). `app` means the frame or an ancestor is in the registry set; `5173` is the app's port; `4143` is the renderer dev port.

| # | Context | Request | Verdict |
|---|---|---|---|
| A1 | app frame | `http://127.0.0.1:5173/src/main.tsx` | allowed |
| A2 | app frame | `http://localhost:5173/` | allowed |
| A3 | app frame | `http://[::1]:5173/` | allowed |
| A4 | app frame | `ws://127.0.0.1:5173/` (Vite HMR) | allowed |
| A5 | app frame | `ws://localhost:24678/` (legacy HMR port) | allowed |
| A6 | app frame | `data:image/png;base64,iVBO…` | allowed |
| A7 | app frame | `blob:http://127.0.0.1:5173/0b6c…` | allowed |
| A8 | app frame | `http://127.0.0.1:4321/api` (another loopback server, not Aiden's) | allowed |
| A9 | app frame | `http://2130706433:5173/` (normalizes to 127.0.0.1) | allowed |
| A10 | app frame | `about:srcdoc` | allowed |
| A11 | app frame | `https://example.com/` | cancelled* |
| A12 | app frame | `http://192.168.1.10/` | cancelled* |
| A13 | app frame | `http://localhost.evil.com:5173/` | cancelled |
| A14 | app frame | `http://localhost.:5173/` | cancelled |
| A15 | app frame | `http://app.localhost:5173/` | cancelled |
| A16 | app frame | `http://0.0.0.0:5173/` | cancelled |
| A17 | app frame | `http://127.0.0.2:5173/` | cancelled* |
| A18 | app frame | `http://[::ffff:127.0.0.1]:5173/` | cancelled |
| A19 | app frame | `https://127.0.0.1:5173/` | cancelled* |
| A20 | app frame | `wss://localhost:5173/` | cancelled |
| A21 | app frame | `ws://example.com/` | cancelled* |
| A22 | app frame | `aiden-design://grant/design/a.html` | cancelled |
| A23 | app frame | `aiden-genui://preview/x` | cancelled |
| A24 | app frame | `aiden-asset://…`, `aiden-attachment://…` | cancelled |
| A25 | app frame | `file:///etc/hosts` | cancelled |
| A26 | app frame | `blob:https://example.com/0b6c…` | cancelled |
| A27 | app frame | `http://127.0.0.1:9222/json` (debugging port floor) | cancelled |
| A28 | app frame | `http://127.0.0.1:4143/` (renderer dev server) | cancelled |
| A29 | app frame | `http://127.0.0.1:<Remote server port>/` (D5) | cancelled |
| A30 | app frame | `chrome-extension://abc/x.js` | cancelled |
| A31 | app frame | `http://127.0.0.1:<local-device-host port>/` | cancelled |
| A32 | app frame | `http://127.0.0.1:<device daemon httpPort>/health` | cancelled |
| A33 | app frame | `ws://[::1]:<any own port>/` | cancelled |
| A34 | app frame | `http://127.0.0.1:<actual --remote-debugging-port>/json` | cancelled |
| A35 | app frame | `<img src="aiden-attachment://…">`, `<script src="aiden-design://…">`, `<link href="aiden-asset://…">` | cancelled; the scheme handler's hit counter stays 0* |
| A36 | app frame | `<a ping="https://127.0.0.1:P/p" href="/x">` click | ping cancelled* |
| A37 | app frame | `new EventSource("https://example.com/")` | cancelled* |
| A38 | app frame | CSS `@import`, `@font-face src`, `background-image` to `https://example.com` | cancelled* |
| A39 | app frame | `<link rel=prefetch>` / `modulepreload` / speculation-rules prefetch to `https://127.0.0.1:P` | cancelled* |
| A40 | app frame | `<link rel=preconnect href="https://127.0.0.1:P">` | observer sees no TCP connect* (or the S71 gap, per Task 2) |
| A41 | app frame | `fetch("/r")` → 307 → `http://127.0.0.1:<own port>/` | cancelled at hop 2 (the E2E checks the recorder's `cancel` line for that port) |
| A42 | app frame | `fetch("/r")` → 302 → `http://localhost.evil.test/` | cancelled at hop 2 |
| A43 | dedicated, shared and `blob:` worker of an app frame | `fetch("https://example.com/")` | cancelled* |
| A44 | app frame | `navigator.sendBeacon("https://example.com/")` while alive | cancelled* |
| A45 | main-window non-main frame whose `parent` chain doesn't reach the main frame | `https://example.com/` | cancelled |
| A46 | app frame, its own navigation request | `http://127.0.0.1:5173/pricing` (allowed) and, in the unit table, `https://example.com/` | the E2E recorder shows `frame` = the child's `frameTreeNodeId` and `resourceType: "subFrame"`; the unit row cancels |
| A47 | main-window non-main frame not in the set whose `origin` is `http://127.0.0.1:4321` (backstop) | `https://example.com/` | cancelled |
| R1 | app frame, `fetch` | `/go-out` on 5173 → 302 → `https://example.com` (second hop) | cancelled* |
| R2 | app frame, navigation | `/go-out` → 302 → `https://example.com` | cancelled (and the guard refuses, D9)* |
| R3 | app frame, navigation | `/go-login` → 302 → `/login` on 5173 | allowed |
| R4 | nested iframe inside an app frame | `https://www.youtube.com/embed/x` | cancelled* |
| R5 | app frame that navigated to `http://127.0.0.1:4321/` (still sticky) | `https://example.com/` | cancelled |
| R6 | registry at its cap, with one long-lived live app frame | external fetch from that frame | still cancelled (S70) |
| R7 | main window closed and recreated | an app frame's external fetch and microphone request | cancelled and denied (D2, D6) |
| N1 | frame `null`, `initiatorOrigin` an app origin (service-worker fetch) | `https://example.com/` | cancelled* |
| N2 | frame `null`, app initiator (`navigator.sendBeacon` on `pagehide`) | `https://example.com/b` | cancelled* |
| N3 | frame `null`, app initiator (keepalive `fetch` after the iframe was removed) | `https://example.com/k` | cancelled* |
| N4 | frame `null`, app initiator, WebSocket | `wss://example.com/` | cancelled |
| N5 | frame `null`, app initiator, service-worker script update | `http://127.0.0.1:5173/sw.js` | allowed |
| N6 | frame `null`, initiator `"null"` (opaque) | `https://example.com/` | cancelled |
| N7 | frame `null`, initiator another loopback origin (`http://127.0.0.1:9999`) | `https://example.com/` | cancelled |
| N8 | frame `null`, no initiator, not on the frameless allowlist | `https://example.com/` | cancelled, and logged (D4) |
| N9 | frame `null`, no initiator, on the audited frameless allowlist (D4) | that URL | untouched |
| N10 | frame `null`, initiator the renderer's own origin (`file://` as Task 5's audit records it, or `http://127.0.0.1:4143` in dev) | `https://api.example.com/` | untouched |
| N11 | frame `null`, the renderer's own initiator or none | `aiden-design://…`, `data:…`, `blob:…` (not network) | untouched |
| N12 | frame `null`, an app, other loopback or opaque initiator (an app's worker or service worker) | `aiden-design://…`, `aiden-attachment://…`, `file:///etc/hosts`, `blob:https://example.com/…` | cancelled; `data:` and loopback `blob:` allowed (review fix, 2026-11-27) |
| E1 | app export window, main frame | `http://127.0.0.1:5173/pricing` | allowed |
| E2 | app export window | `https://fonts.googleapis.com/css2?family=Inter` | cancelled |
| M1 | main window, main frame | `https://api.openai.com/v1/…` | untouched |
| M2 | main window, main frame | `http://127.0.0.1:5173/` | untouched |
| M3 | main window, `aiden-design:` file frame (not app context) | anything | untouched |
| M4 | quick chat or pill window, main frame | anything | untouched |
| M5 | browser panel or Bot partition | anything | never seen (other session) |
| M6 | flag off | anything | no listener installed |

**D3b. Rows checked outside the verdict function.** Each verdict is written by hand. A `*` row has an observer oracle in the E2E.

| # | Context | Action | Expected | Where |
|---|---|---|---|---|
| W1 | app frame | `new WebTransport("https://127.0.0.1:P/")` with a UDP observer on P | documented gap (S71): Electron 43.8.4 can't see or stop it | Task 2 probe; not asserted in Task 14 |
| W2 | app service worker | the same | documented gap (S71) | Task 2 probe; not asserted in Task 14 |
| H1 | app response | `Reporting-Endpoints: e="https://127.0.0.1:P/r"`, `Report-To`, `NEL`, plus a CSP with `report-to e` | headers stripped; observer 0 bytes* | Task 5 unit, Task 14 |
| H2 | app frame | `history.go(-1)` after a sibling app frame navigated | the sibling's URL unchanged (or, per Task 2, the documented limit) | Task 2 probe, Task 14 |
| S1 | an app origin's service worker, after the flag is turned off and Aiden restarted | any | registration cleared | Task 7 unit, Task 14 |
| P1 | entered app frame | `video.requestPictureInPicture()` | rejected; no window | Task 11 token set, Task 14 |
| P2 | app frame | `element.requestFullscreen()`, `navigator.clipboard.readText()`, `navigator.mediaDevices.getDisplayMedia()` | rejected | Task 14 |
| K1 | app frame, not entered | `setInterval(() => input.focus(), 50)` while the test types in the composer | the composer gets every character | Task 2 probe, Task 14 |
| D1 | app frame | `location = "mailto:x"`, `"vscode://x"`, `"slack://x"` | refused; the `openExternal` permission denied; no `shell.openExternal` | Task 6, Task 14 |
| D2 | app frame | `<a download href="/f.zip">` click | no download, no dialog | Task 14 |
| E3 | app export window | `location = "/f.zip"` (attachment), `<a download>` | no download, no Save dialog | Task 13 unit, Task 14 |
| E4 | app export window | `window.print()` | no print dialog | Task 14 |
| E5 | app export window | `sendBeacon("https://…")`; `new WebTransport(…)` | the beacon cancelled*; WebTransport a documented gap (S71), not asserted | Task 14 |
| E6 | app export window | `getUserMedia`, `Notification.requestPermission()` | denied | Task 7 unit, Task 14 |

**D4. Frameless requests (S3, S57).** Electron 43.8.4 reports `initiatorOrigin`, "kept from the original request across redirects; absent for requests the browser started itself". So:
- **App initiator.** A `frame: null` request whose `initiatorOrigin` is an app origin, or any loopback `http:` origin other than the renderer's own, or `"null"` (opaque), is app context and gets D3's rule (N1–N7). This covers service-worker fetches, `pagehide` beacons, keepalive fetches after the iframe is removed and WebSockets. Opaque `aiden-genui:` frames' keepalive requests to the network are therefore cancelled with the flag on; that is an accepted change.
- **No initiator.** A `frame: null` request with no `initiatorOrigin` and a network scheme (`http`, `https`, `ws`, `wss`) to a non-loopback host is cancelled (N8), **unless** it matches an entry on the audited frameless allowlist (N9). The list **starts empty** and gains only what Task 5's audit observes in the Space, each entry a fixed URL prefix with a test row and a comment naming its owner. Each frameless cancel is logged to diagnostics as `design-live frameless-cancel` with the host only, at most once per host per minute, so a missed entry shows up in the field rather than as a silent break.
- **Renderer traffic.** A `frame: null` request whose initiator is the renderer's own origin is Aiden's own (N10), as are non-network schemes from it or with no initiator (N11). An app initiator decides first, for every scheme (N12). Task 5's audit records the exact `initiatorOrigin` the packaged `file://` renderer's frameless requests carry. **If it is `"null"`**, N6 would cancel Aiden's own traffic: stop, and amend D4 and S57 before Task 5 Step 2 (the flag-on chat-send smoke run in Task 14 is the end-to-end check).
- Electron's `net` module isn't used by Aiden's main process (no `net.request` or `net.fetch` call), and `electron-updater` uses its own partition; the audit confirms both.

**D5. Aiden's own loopback ports (S59, S72).** App frames are loopback-only, but Aiden itself listens on loopback. `ownPorts` is a live set, and its loopback requests from app context are cancelled (A27–A29, A31–A34):
- **Debugging ports, read from the real switches**: `app.commandLine.getSwitchValue("remote-debugging-port")` and the port of `inspector.url()` (`node:inspector`), read when the design subscriber installs. 9222 and 9229 stay as a floor.
- **The renderer dev server's port**, from `AIDEN_RENDERER_URL`, when set.
- **Every port an Aiden service listens on**, registered through `aidenLoopbackPorts.add(port)` after a successful `listen` and `.delete(port)` on close: `aiden-remote-service.ts:341`, `aiden-mcp-server.ts:98`, `mcp-oauth-loopback.ts:180`, `acp/mcp-bridge.ts:99`, `bot-computers/viewer-hub.ts:680`, `browser/files.ts:862`, `devices/local-device-host.ts:844` and `devices/device-hub-proxy.ts:571`. Services that bind beyond loopback still register.
- **Ports of daemons Aiden spawns or reuses**: the device hub's reserved `--port` (`local-device-host.ts:426-431`), registered before spawn and deleted when the hub stops, and the agent daemon's `httpPort` (`:492-522`), registered when read from `daemon.json` (new or reused) and deleted when the daemon is found unhealthy or stopped.
- **electron-updater's Squirrel.Mac proxy** (6.8.9, `MacUpdater.js:209`, `listen(0, "127.0.0.1")`). Its server is a private field, but it sets the native updater's feed URL to `http://127.0.0.1:<port>` before it emits `update-downloaded`. `app-updater.ts`'s existing `update-downloaded` handler (`:323`) reads `electron.autoUpdater.getFeedURL()` and registers that port when it is loopback, and deletes it when the updater is disposed. The proxy also requires a random 64-byte Basic credential, so the window before registration exposes nothing usable; docs say so.
- **Not registered, with a reason on the allowlist:** test-only listeners (`peer-pairing-test-host.ts`, `openrouter-recording-test-support.ts`, `mcp-oauth-test-server.ts`, `bot-computers/rfb-fake-server.ts`, `*/fixtures/*.mjs`), `gemini-live/display-capture-acceptance.ts:75` (its own launch mode, no design mode), `design-canvas/app-server/app-ports.ts:32` (2b's free-port probe, which closes at once), and `devices/ssh-device-script.ts:104` (a script string that runs on the remote device).
- **A separately run `aiden serve`** (packages/cli) on the same machine is another program; its endpoints need pairing credentials. Docs list it under "Loopback is broad" (Risk 4).
- **Drift guard.** `check:aiden-rules` gains `loopback-listen-registered`: every `.listen(` call in `main/**/*.ts` (tests and fixtures excluded) must sit in a module that also calls `aidenLoopbackPorts.add`, or appear on `scripts/aiden-rules-allowlist.json` with a reason. It is AST-based, like the existing rules (`check-aiden-rules.mjs:16`, `:361`).
- **Not adopted:** a per-port owner-pid backstop (2c's `follow-through/listening-ports.ts`). `onBeforeRequest` is synchronous and the pid lookup is asynchronous, so it could only cancel a port's first request blindly; the registered set plus the drift guard is the rule.

A design app is never on one of these ports: 2b picks free ports and 2c excludes 9222, 9229 and the renderer's port from Connect.

**D6. The default-session `webRequest` dispatcher (§11 item 4).** `main/services/default-session-web-request.ts`:
- `claimDefaultSessionWebRequest(webRequest)` returns the dispatcher. A second claim for the same `webRequest` object throws "The default session's webRequest is already owned by default-session-web-request.ts." The dispatcher is exported as `defaultSessionWebRequest`.
- **Install order.** `main/index.ts` claims both dispatchers inside `app.whenReady()`, then **synchronously** installs the design subscribers, the deny layer and the download subscriber (`installAppNetwork`, Task 7), all **before** the first `createMainWindow` (`:2497`). A canvas restored with an app frame on screen can therefore never set an iframe `src` before the filter exists. If the flag is on and the registry isn't installed for a window, the guard refuses every loopback subframe in it (fail closed).
- `onBeforeRequest(name, handler)` and `onHeadersReceived(name, handler)` add a named subscriber and return its removal. A duplicate name throws. Handlers are synchronous and return `"cancel" | undefined` (before request) or `{ responseHeaders } | undefined` (headers).
- **Composition.** Before-request subscribers run in registration order; the first `"cancel"` wins. Headers subscribers run in order, each seeing the previous one's headers. A subscriber that throws counts as `"cancel"` for before-request, and as "no change" for headers. Either way it is logged once per minute with its name.
- **Listener lifetime.** The Electron listener is set when the first subscriber of that event is added, and cleared (`webRequest.onBeforeRequest(null)`) when the last is removed. So with no subscriber the session has no listener, and the flag-off path is exactly today's.
- **Filter.** No URL filter: the policy decides. That keeps one listener per event, as Electron requires.
- **The offline and browser partitions** keep their own listeners. The dispatcher refuses to claim any session but the default one.
- **Test-only recorder (M7).** When `AIDEN_E2E_DESIGN_LIVE_RECORD` names a file and `app.isPackaged` is false, the design subscriber appends `{resourceType, frameTreeNodeId, initiatorOrigin, verdict}` (no URL path or query) for app-context requests to it. Packaged builds never read the variable.

**D7. Response headers (S4, S71).** The design headers subscriber acts only on responses in app context:
- **For every app-context response** (any loopback origin, any resource type):
  - `Report-To`, `NEL` and `Reporting-Endpoints` are removed, so the Reporting API's uploader (`net/reporting`, outside URLLoader) has no endpoint;
  - for `mainFrame`, `subFrame` and worker-script responses, a **second** `Content-Security-Policy` header is added: `connect-src 'self' http://localhost:* http://127.0.0.1:* ws://localhost:* ws://127.0.0.1:* data: blob:`. A second policy only narrows, so the app's own CSP still applies. It names no `[::1]` source, because Chromium rejects them as invalid (probe 6); `'self'` covers an `[::1]` export window's own origin (S74);
  - `X-DNS-Prefetch-Control: off` is set.
- **Only for responses from an app origin** (`isAppOrigin`):
  - **Cookies.** Each `Set-Cookie` value gets its `SameSite` attribute replaced by `SameSite=None`, and `Secure` added if absent (`appSetCookie(value)`, pure). Chromium treats `127.0.0.1`, `[::1]` and `localhost` as potentially trustworthy, so a `Secure` cookie is accepted and sent on plain `http:` there. A packaged build loads the renderer from `file://`, which makes the frame cross-site, so without this rewrite a default `SameSite=Lax` session cookie is refused. Task 14's E2E runs against the `file://` renderer and proves sign-in. **If that fails**, the rewrite is removed and the limit documented (S4's fallback). A proxy is not added in 3a. A sign-in that sets its cookie from another loopback API port (A8) isn't rewritten; docs say so;
  - **Frame-blocking headers.** `X-Frame-Options`, and the `frame-ancestors` directive of every `Content-Security-Policy`, are removed, so an app that sets them for production still frames on the canvas. Other directives are kept. A non-app frame's `X-Frame-Options` is kept (Q2).
- **For an export window's main-frame response**: `Content-Security-Policy: sandbox allow-scripts allow-same-origin allow-forms` is added, which sandboxes the top-level document: no downloads, modals, printing or popups (D18).
- Nothing else is changed. A response header that fails to parse is left as it is.

**D8. The permission dispatcher (S9, S60).** `main/services/default-session-permissions.ts` owns `setPermissionCheckHandler`, `setPermissionRequestHandler`, `setDisplayMediaRequestHandler` (with its options) and `setDevicePermissionHandler` on the default session, plus the session's `will-download`, `select-hid-device`, `select-serial-port` and `select-usb-device` events. A second claim throws, as in D6.
- **Owner slot.** `ownerSlot(name)` returns an object with the setters Gemini Live's `DisplayMediaGuardSession` needs, and returns **the same object** on every call with the same name, because Live's guard keys a `WeakMap` by it and `service-main.ts` reinstalls on every binding change. The slot forwards `setDisplayMediaRequestHandler`'s options. `service-main.ts` passes `defaultSessionPermissions.ownerSlot("gemini-live")` where it passed `session.defaultSession`. Setting `null` empties the slot. At most one owner name; a second name throws. `display-media-contract.ts` gains one word: `export interface DisplayMediaGuardSession`.
- **Deny layers.** `addDenyLayer(name, layer)` adds `{ denyCheck, denyRequest, denyDisplay, denyDevice }` predicates. Any layer saying deny wins, before the owner.
- **Event subscribers.** `onWillDownload(name, handler)` and `onSelectDevice(name, handler)` add named subscribers; the Electron listener exists only while one does. A `will-download` handler returning `"cancel"` calls `event.preventDefault()` and `item.cancel()`. A chooser handler returning `"cancel"` calls `preventDefault()` and the callback with `""`.
- **Installing handlers.** For each handler:
  - no layer and no owner: the Electron handler is `null`, so Electron's defaults apply as today;
  - only an owner: the owner's handler is installed as is (display media with its own options), so Live behaves exactly as today;
  - a deny layer: a composed handler runs the layers, then the owner, then Electron's documented default for that handler. Task 4 records each default from the Electron 43 docs in the code and a test: checks and requests grant; display media without a handler rejects, so the composed one answers `{}`; the device handler without one denies, so the composed one answers `false`.
- **Runtime guard (non-packaged builds).** After the claims, when `app.isPackaged` is false, the dispatchers replace the default session's setters (`webRequest.onBeforeRequest`, `onHeadersReceived`, the four permission setters) with stubs that throw "Use default-session-web-request.ts / default-session-permissions.ts", keeping the originals for themselves. That catches what the AST rule can't (a dynamically reached session). The acceptance launch never claims, so it is untouched.
- **The design layer** denies:
  - every check and request from an app export window's web contents;
  - every check and request whose `isMainFrame` is false, whose web contents is the main window, and whose `requestingUrl` isn't on Aiden's own list (the renderer's own origin, which in `npm run dev` is the dev origin `http://127.0.0.1:4143`; `aiden-design:` and `aiden-genui:` and blobs of them). Electron gives no frame here, so this is the fail-closed form of "a frame under an app origin". Only admitted app frames and what they nest can be such frames;
  - any check or request whose requesting origin `isAppOrigin()`, from any web contents;
  - a check with no web contents (service workers) whose `securityOrigin` or requesting origin is an app origin or another loopback origin other than the renderer's own;
  - display media whose `securityOrigin` is an app or other loopback origin, whose `request.frame` is in app context (it or an ancestor on an app or other loopback origin, which covers export windows, or under an admitted frame in the main window), or that has no frame and doesn't come from Aiden's own documents. Other default-session windows (Quick Chat, the pill, bot bubbles) are judged by their own frames, not as the main window's;
  - device permission whose `origin` is an app origin or another loopback origin other than the renderer's own.

  Electron 43's permission names list no background-sync, periodic-sync or background-fetch entry (`electron.d.ts:13473`, `:13482`). The layer denies every check and request from app context, including `unknown`; Task 2's probe records whether Chromium consults the handler when the fixture's service worker registers a sync. Either way S76's clear is the guarantee.
- **Downloads.** The design download subscriber cancels any download whose `webContents` is an export window, whose `frame` is in app context, or, when the frame is gone, whose `item.getInitiatorOrigin()` is an app or other loopback origin. Sandboxed app iframes without `allow-downloads` can't start one anyway (D2 row in D3b).
- **Device choosers.** With the flag on, the main window handles `select-bluetooth-device` with `preventDefault()` and `callback("")`, because Electron otherwise picks the first device. The export window handles `select-bluetooth-device` the same way. The session's `select-hid-device`, `select-serial-port` and `select-usb-device` go through `onSelectDevice`. HID and USB are `(event, details, callback)`: the design subscriber cancels when `details.frame` is in app context or null. Serial is `(event, portList, webContents, callback)` with no frame: it cancels in the main window and in export windows. Aiden uses none of them.
- **macOS system picker.** On macOS, `getDisplayMedia` uses the system picker and never reaches the display handler (`display-media-contract.ts:50`), so the iframe's `allow` (`display-capture 'none'`) is the guard there. Task 11 asserts it in the token set and Task 14 probes `getDisplayMedia` in the Linux Space.
- **Gemini Live.** `display-media-contract.ts`'s tests don't change. A new test binds Live and checks an app frame's microphone request is denied while Live's own document is still granted, and the same unbound.

**D9. Navigation and redirects (§6.3.4, S1, S58, S69).** `app-frame-guard.ts` decides; `main-window-navigation.ts` applies.
- **`will-frame-navigate`**, for a non-main frame, in this order (both flag states unless marked):
  1. **`frame === null`**: refused when the target is loopback `http:`, `https:` or an unknown scheme. Other targets (`aiden-design:`, `aiden-genui:`, `about:`, `data:`, `blob:`) keep v1's existing `frame: null` handling unchanged.
  2. **The v1 pin**: a frame in v1's `designFrames`, or one currently on an `aiden-design:` host, is decided by the v1 guard, as today. A pinned frame can't leave its host for an app origin.
  3. **Admission** (flag on): D2's conditions. Pass → the frame joins the set and the navigation is allowed.
  4. **An app-context frame** (flag on) may go to a loopback `http:` URL (not `ownPorts`), `about:blank`, `about:srcdoc`, `data:` or `blob:` (loopback). Anything else is refused. When the refused frame is the app frame itself and the target is `http(s):`, main sends a `navigation-refused` event with the URL (D16). For nested frames it is counted as blocked.
  5. **Any other target that is loopback `http:`** other than the renderer's own origin: refused. With the flag on, an `https:` target from a non-app-context direct child is decided by step 6 as today.
  6. **Otherwise** the v1 design guard decides, as today.
- **Before install** (flag on, the registry isn't bound for this window): every loopback subframe navigation is refused.
- **`will-redirect`** (S1). Main frame: today's behaviour (`preventDefault` and open externally). A subframe, with the flag on:
  - `frame === null`: prevented, not opened;
  - in app context, loopback → loopback is allowed (R3);
  - in app context, anything else is prevented and counted as blocked (R2), and when the frame is the app frame itself and the target is `http(s):`, main sends `navigation-refused` with the redirect target, so the Open in browser toast appears. It is never opened externally;
  - not in app context: prevented, not opened (an `aiden-design:` or `aiden-genui:` frame never redirects over HTTP, so this changes nothing in practice).

  With the flag off, the handler is today's, unchanged.
- **Open in browser.** The frame's toast says "<host> is outside the app" with **Open in browser**, which calls the existing browser-panel open with the URL. The browser panel uses its own partition and navigation rules, and never consults `isAppOrigin`, so app URLs and external URLs both open there (S53).
- **External schemes.** `mailto:`, `vscode:`, `slack:` and other non-web targets from app context are refused by step 4; the design layer also denies the `openExternal` permission (D8), and no 3a path calls `shell.openExternal` for a subframe (D3b D1).
- **`setWindowOpenHandler`** stays as is. The sandbox has no `allow-popups`, so an app frame's `window.open` and `target=_blank` links never reach it (E2E row).
- **`will-navigate`** (main frame) stays as is. The sandbox has no `allow-top-navigation`.

The guard is tested as this table (Task 6), each verdict written by hand:

| # | Frame | Flag | Event and target | Verdict |
|---|---|---|---|---|
| G1 | app frame | on | `will-redirect` `/go-login` → `/login` on 5173 | allowed |
| G2 | app frame | on | `will-redirect` `/go-out` → `https://example.com` | prevented, counted, `navigation-refused` sent, no `openExternal` |
| G3 | main frame | on, off | `will-redirect` anywhere | today's: prevented and opened externally |
| G4 | app frame | on | `https://example.com` | refused, `navigation-refused` |
| G5 | app frame | on | `http://127.0.0.1:4321/` | allowed, still in the set |
| G6 | nested frame in an app frame | on | `https://www.youtube.com/embed/x` | refused, counted |
| G7 | fresh direct child, matching record, target = expected origin, initiator = main frame | on | `http://127.0.0.1:5173/pricing` | admitted |
| G8 | fresh direct child, matching record | on | another loopback origin than the record's | refused; record consumed |
| G9 | `aiden-genui:` frame | on, off | self-navigates to `http://127.0.0.1:8080/` | refused |
| G10 | v1 file frame on an `aiden-design:` host | on, off | an app origin | refused (pin first) |
| G11 | fresh unnamed direct child, no record | on, off | `http://127.0.0.1:2375/` | refused |
| G12 | subframe, `frame === null` | off | loopback `http:` | refused |
| G13 | subframe, `frame === null` | on | `https://example.com` | refused |
| G14 | unknown non-main frame (no record, not design, not genui) | on, off | `http://localhost:5173/` | refused |
| G15 | fresh direct child, matching record, initiator another frame | on | the expected origin | refused |
| G16 | fresh direct child, record older than 30 s | on | the expected origin | refused |
| G17 | fresh direct child, matching record, set full of live frames | on | the expected origin | refused (S70) |
| G18 | app frame | on | `http://127.0.0.1:<own port>/` | refused |
| G19 | nested frame in an app frame | on | `about:srcdoc`, `data:…`, loopback `blob:` | allowed |
| G20 | subframe, `frame === null` | on | `will-redirect` to loopback or external | prevented, not opened |
| G21 | direct child | off | the renderer's own dev origin | allowed (today's CSP `'self'`) |
| G22 | any subframe, registry not bound for this window | on | loopback | refused |
| G23 | app frame | on | `mailto:x`, `vscode://x`, `slack://x` | refused |
| G24 | v1 file frame | on, off | another `aiden-design:` host | refused (v1, unchanged) |

**D10. Dialogs (S10, S61).** The iframe has no `allow-modals`, so `alert`, `confirm`, `prompt`, `print` and `beforeunload` prompts are ignored by Chromium. Chromium logs "Ignored call to 'alert()'. The document is sandboxed…" on the frame. With the flag on, `main-window-console.ts` counts those messages from app-context frames (`details.frame`) and sends a `dialog-suppressed` event `{frameId, kind}` (one per kind per 5 s per frame). The frame's popover lists "Dialogs are turned off on the canvas" with the kinds. **The count is page-forgeable** (a page can `console.error` the same text); it is display-only, bounded, and drives no decision. It isn't the bridge's job (S61): a dialog in a boot script runs before injection. The same module keeps Gemini Live's `[aiden-live]` forwarder, now accepting markers only when `details.frame` is the window's main frame, so a subframe can't forge Live diagnostics or use up the 200-event budget.

**D11. CSP and the loopback refusal (S52, S67, S69).**
- `main-window.html`'s `frame-src` becomes `'self' aiden-genui: aiden-design: http://localhost:* http://127.0.0.1:* http://[::1]:*`. A meta CSP can't be widened at runtime, so this is static.
- In **both** flag states, `main-window-navigation.ts` refuses a main-window subframe navigating to a loopback `http:` origin other than the renderer's own unless it is an admitted app frame (flag on only), and refuses a `frame: null` subframe navigation to a loopback `http:`, `https:` or unknown-scheme target (D9 steps 1 and 5). That is what the old `frame-src` refused, for every frame that existed before 3a, so nothing a page could do before can be done now, flag off or on.
- **Build check.** `verify-renderer-csp.mjs` gains `assertFrameSrc`: for `main-window.html`, `frame-src` is exactly that list; other pages keep whatever they have, but none may contain `http:`, `https:`, `*` or a non-loopback host. `renderer-csp.test.ts` gains the matching build and rejection cases.

**D12. The v2 bridge (§6.3.3, S11).**
- **Source.** `bridge-core-source.ts` exports the v1 pick core as a string template with `PREFIX` and `host` slots: element description, hover outline, `pick-at`, `locate`, `highlight` and anchors. `bridge-source.ts` builds v1 from it, and `bridge-source.test.ts` passes unedited. `app-bridge-source.ts` builds v2 with the `aiden-app:` prefix and adds:
  - `route`: patches `history.pushState` and `replaceState` and listens to `popstate`, then posts `{path}` (pathname plus search, at most 2 048 characters) after each change and once at start;
  - `error`: `window.onerror`, `unhandledrejection`, the Vite overlay (`vite-error-overlay`, through a `MutationObserver` on `document.documentElement`), the Next.js dialog (`nextjs-portal`) and failed module loads (`error` events on `script[type=module]`). Each posts `{kind, message, at?}`, with the message at most 500 characters and `at` the first stack frame as `{path, line}` when its URL is the frame's own origin;
  - `hmr` (D13);
  - `source-at {requestId, x, y}`, answered by `source {requestId, component?, owners[], path?, line?}` (D14);
  - `escape`: posted when the page sees an unmodified `Escape` `keydown` (capture phase). It is untrusted and harmless: the canvas only leaves the entered frame;
  - `set-scheme {dark}`: sets `color-scheme`, `data-theme="dark"` and `class="dark"` on `<html>`, and removes exactly what it added when turned off.

  It drops v1's tweaks and text-edit parts: tweaks are for `file` frames only (S13). Text editing (`edit-*`), `inspect-at` and `measure-at` are Phase 4, which re-adds them to the v2 bridge (S68).
- **Invocation.** Main runs `void (${APP_BRIDGE_SOURCE})(${JSON.stringify(nonce)}, (url) => import(url))` through `webFrameMain.executeJavaScript(code, false)`. `userGesture` is explicitly `false`, so injection never grants the page user activation (Picture-in-Picture, clipboard, fullscreen). The expression evaluates to `undefined`, and main never awaits a value the page could influence (no thenable from the page is adopted). The importer is a closure argument, so the page can't intercept it, and tests pass a fake.
- **Once-guard (S11).** The bridge reads `window.__aidenAppBridge`. If it equals this injection's nonce, it returns; otherwise it installs and sets it. Main keeps one nonce per frame document (a new one on each committed navigation of that frame, `did-frame-navigate`), so the two injection points (`dom-ready` and `did-frame-finish-load`) install once per document. A page that pre-sets the property can't guess the nonce, and a page that reads it afterwards can only stop a second install that wasn't going to happen.
- **Transport.** `host.postMessage({type: "aiden-app:" + type, …}, "*")`, as v1 (the renderer is `file://`, so no target origin can be named). It answers only messages whose `event.source` is `window.parent`.
- **Untrusted output (S11).** The bridge runs in the page's main world, where the page can replace any global first. So:
  - `parseAppBridgeMessage` (renderer) accepts only known types, checks every field's type, and bounds strings (path 2 048, message 500, component 120, at most 8 owners) and numbers. Unknown or oversized messages are dropped;
  - the canvas checks `event.source === iframe.contentWindow` for the frame's current iframe, as v1 does, and accepts at most 60 bridge messages per second per frame; the rest are dropped;
  - a `path` from `error.at` or `source` is accepted only when it is a relative POSIX path with no `..`, no leading `/@fs/`, `/@id/` or `/node_modules/`, no query or fragment, at most 512 characters, under the app root. The renderer checks the shape; any main-side use (Phase 4's `design_inspect`) also resolves it with `realpath` inside the app root;
  - no bridge text reaches the model in 3a. Phase 4 sends it fenced as data (`fenceAsData`), labelled page-reported;
  - nothing security-related trusts the bridge: blocked counts and refused navigations come from main (S61), dialog counts come from main's reading of console text (display-only, D10), and the network and permission rules don't read the page at all.
- **Injection** (`app-bridge-main.ts`), flag on only: on the main window's `frame-created` (then that frame's `dom-ready`) and `did-frame-finish-load` (`webFrameMain.fromId`), for a frame that **is itself** in the registry set (not a nested one) and whose current origin `isAppOrigin()`. A failed `executeJavaScript` (the frame navigated away) is ignored. Injection never runs in export windows except the small scheme script (D18).

**D13. HMR in 3a (S12, S63).** The bridge finds the page's own `script[type=module][src$="/@vite/client"]`, resolves its `src` against the document URL, and imports it through the importer **only when the resolved URL's origin is the frame's own origin**, so Vite's `base` is respected and a page can't point the importer at another origin. It calls `createHotContext("/@aiden/bridge")` and posts `hmr {}` on `vite:afterUpdate`. With no such script it does nothing. In 3a the canvas uses `hmr` only to bump the frame's snapshot generation, throttled (D16). The "watcher saw a save, then the DOM settled" signal for Next.js, webpack and the rest, and the change toasts, are Phase 4.

**D14. React source mapping (§11 item 5).** Task 2 runs the check before the bridge is built. The walk:
- finds the element's `__reactFiber$…` key, then the nearest function or class component above it (`type.displayName || type.name`) and up to 8 owners through `_debugOwner`;
- with React ≤ 18, reads `_debugSource {fileName, lineNumber}`;
- with React 19, reads the fiber's `_debugStack` (an `Error`), takes the first frame after React's own (`jsxDEV`, `react-jsx-dev-runtime`, `react-dom`), fetches that module URL (same origin, allowed), decodes its inline source map (a small base64-VLQ decoder in the bridge), and maps the frame's line and column to the original `sources[0]` and line;
- falls back to a `data-aiden-src` stamp on the element or an ancestor.

The path is the module URL's path relative to the frame's origin (`/src/Pricing.tsx` → `src/Pricing.tsx`), which Vite serves relative to the app root.
- **If Task 2's check passes** (the fixture's `<h1>` maps to `src/Pricing.tsx` and its JSX line), `source` carries `path` and `line`.
- **If it fails**, the source-map decoder is dropped: `source` carries the component and owners only, Aiden searches for the name in Phase 4, the E2E asserts the name, and S64 records it. The Inspect UI is the same either way.

**D15. The `app` kind (§6.3.1, S62).**
```
{ kind: "app", appRoot: ".", route: "/pricing", viewport: {width: 1280, height: 800},
  scale: 0.5, colorScheme?: "light" | "dark", label?: string, variantOf?: frameId }
```
- `appRoot`: `"."`, or a relative POSIX path accepted by `isDesignRelativePath` with no `.` segment.
- `route`: starts with one `/`, isn't `//…`, has no `\`, no control or hidden characters (`consentDisplayText`'s set), at most 2 048 characters, and `new URL(route, "http://x.invalid").origin === "http://x.invalid"`. The fragment is dropped.
- `viewport`: integers from 200 to 4 000 each. `scale`: 0.05 to 2, **rounded to 4 decimals** when parsed.
- **Box.** `w = Math.round(viewport.width × scale)` and `h = Math.round(viewport.height × scale) + DESIGN_FRAME_HEADER_PX`. §6.3.1 says `viewport × scale`; the title row, as on every page frame, is the exception (S62). The parser recomputes `w` and `h` from these, so they can't disagree, and parse → serialize → parse is a fixed point (two chats watching the canvas never ping-pong writes). `designMinSize("app")` is 10 (200 × 0.05), so the generic clamp never moves a recomputed box. In 3a a corner resize **keeps the aspect ratio** and changes `scale` (`scale = round4(w / viewport.width)`); edge-drag reflow is 3c's.
- `label` (at most 60 characters) and `variantOf` (a frame id) are parsed and kept; 3c writes them.
- `designWidth`, `tweaks`, `tweakVersions`, `printMode`, `paper` and `dark` don't apply. **`isDesignPrintable("app")` stays false**, so the existing gates drop `dark`, `printMode` and `paper` and `canvas_update_frame` refuses them. `designExportFormats` gains an `app` case: `["png", "pdf"]`, never `"source"`. `canDesignGuide("app")` is true (layout guides over the viewport).
- The parser keeps app frames whatever the flag, so a document written with the flag on survives a run with it off (D1). The URL is never stored: it's the server's origin plus `route`, decided by main at mount time.

**D16. The renderer's app node (§6.3.2).** `app-node.tsx`:
- **Iframe.** `sandbox="allow-scripts allow-same-origin allow-forms"`, `referrerPolicy="no-referrer"`, `name` from D2, `title` the frame's title, `data-app-frame-id` (never `data-frame-id`, so v1's comment listener never matches it). `allow` sets `'none'` for camera, microphone, geolocation, display-capture, clipboard-read, clipboard-write, payment, usb, serial, hid, bluetooth, midi, publickey-credentials-get, publickey-credentials-create, screen-wake-lock, xr-spatial-tracking, picture-in-picture, fullscreen, window-management, local-fonts, idle-detection, storage-access, web-share, otp-credentials, identity-credentials-get, direct-sockets and autoplay (defence in depth beside D8). It is laid out at `viewport` size and scaled with `transform: scale(scale)`, as file frames are. `colorScheme` follows the Dark switch.
- **Inert until entered (S75).** The iframe carries `inert` whenever the frame isn't entered, so nothing inside it, OOPIF included, can take focus from the composer. Enter removes `inert`; leaving sets it again.
- **Mounting.** Before it renders the iframe, the node calls `designCanvas:appFrameMount(chatId, frame.id, mountToken)` with a fresh random `mountToken` and frames `reply.origin + frame.route`. A change of origin in the snapshot (a restart on another port) remounts with a new token and a new iframe (`key` = origin + token). Errors map to the states below.
- **States**, from the app root's entry in `useDesignAppsSnapshot(chatId, designLive)` and the mount reply, each over the last snapshot (or the skeleton), dimmed, using 2c's chip labels and the shared squircle `Button` with its focus ring:

  | State | Overlay | Button |
  |---|---|---|
  | `stopped` | the chip's label | **Start app** (`designApp:start`), or **Connect** for a url root |
  | `stopped` with a problem (`exposed`, `no-access`, toolchain) | the fixed problem sentence | none |
  | `consent` | "Waiting for you to allow the app to run" | none |
  | `installing`, `starting` | "Starting…" (no spinner, as 2c's chip) | none |
  | `crashed` | the chip's fixed crash sentence | **Retry** (`designApp:retry`) |
  | `running`, before the iframe's `load` and the bridge's `ready` | none; the snapshot stays under the iframe | none |
  | `running`, attached holder lost | the chip's attached-lost sentence | **Connect** |
  | mount `too-many-frames` | "Too many live frames" label | none |
  | flag off | static card "Live apps are off" | none |
  | no app root of that name | static card "This app isn't in this workspace" | none |
- **Live set.** `canBeLive` includes `app`; the six-live cap and the 25% zoom rule apply.
- **Enter and leave.** As file frames: double-click or ↩ enters. Leaving: a click on the canvas outside the frame, or the bridge's `escape` message, or Esc when focus is back in the canvas (`canvas-keymap-core.ts:67`). Pointer, wheel and keys go to the frame only while entered.
- **Present and full window.** While presenting (`design-present.tsx`), app frames are live but stay `inert` unless entered, so Esc and the arrows keep driving the presentation. `single` (Open full window) isn't offered for app frames.
- **Comment tool.** C + click on an app frame places a frame-level pin with no element anchor (no `pick-at`). `design-comments.tsx` also checks the frame's kind is `file` before treating a message as a page report.
- **Title row.** Title; then the in-app path when it differs from `frame.route` (from `route`, shown escaped, at most 60 characters, truncating with an ellipsis); then `1280 × 800`; then the Error and blocked labels.
- **Blocked label (§6.3.5).** "N blocked" in a quiet tertiary label, as a `Button variant="bar" size="small"` that opens a `Popover` from `ui.tsx`: up to 20 hosts (escaped through `consentDisplayText`, each at most 253 characters, "and N more" after), suppressed dialog kinds (D10), and the fixed sentence "Design mode only lets apps reach localhost for now." Counts come only from main's `designCanvas:appFrame` events for this frame's current `mountToken`; a new mount starts at 0.
- **Error label.** The latest `error` message sets a quiet "Error" label, a `Button variant="bar" size="small"` that opens the same kind of `Popover` with the escaped message, so it reaches the keyboard and screen readers. Error frames and Fix with Aiden are Phase 4.
- **Open in browser** (D9): `navigation-refused` is coalesced per frame to at most one toast per second, latest URL wins: "<host> is outside the app", with the action.
- **Snapshots.** `useFrameSnapshot(frame.id, generation)`, where `generation` goes up on each `hmr`, each full load and each origin change; captures are throttled to at most one per 2 s per frame.
- **Frame actions.** Dark switch (sets `colorScheme`, posts `set-scheme`), Download (PNG and PDF, D18), Hide, Lock and Remove. No tweaks, no Open full window, no text edit, no Code tab.
- **Resize** keeps the aspect ratio and writes `scale` (D15).
- **UI rules.** Semantic tokens only, no decorative borders or outlines, status in soft fills and labels, visible `focus-visible` rings on the overlay buttons and the labels, Reduce Motion through the motion tokens, no brain icons.

**D17. `canvas_place_frame {kind: "app"}` (S6).** With `designLive` only:
- `PLACED_KINDS` gains `"app"`, and the description gains one sentence: "kind app shows a route of the workspace's running web app live (appRoot, route; viewport width and height, default 1280 × 800, at scale 0.5); design_app starts the app." With the flag off, the enum and the description are byte-for-byte today's, so the prompt cache and replays are unchanged.
- Parameters: `appRoot` (optional when the workspace has one app), `route` (default `/`), `width` and `height` (200–4 000), `scale` (0.05–2). D15's validators run; an invalid route is a tool error naming the rule.
- **The root** must be one of the snapshot's apps, candidates, chosen roots or url roots, read through a new `apps` dep (`{ roots(workspaceId): string[] }` over `designAppServers.snapshot`). The server doesn't have to be running.
- **Dedupe.** Same `appRoot` and `route` on the target page reuses that frame (`placed: "reused"`) unless `duplicate: true`, as for `file`.
- **`canvas_read`** lists app frames as `{kind: "app", appRoot, route, viewport, scale, live: <running>}`.
- **Refusals in 3a.** `canvas_inspect`: "canvas_inspect can't open live app frames yet." `canvas_duplicate` with variants, and `canvas_update_frame`'s `designWidth`, `tweaks`, `dark`, `paper` and `printMode` on an app frame: a tool error naming the frame kind (the existing `isDesignPrintable` gates give the last three). Moving, resizing (changes `scale`, aspect kept), retitling, grouping, hiding, locking, removing and `colorScheme` through `canvas_update_frame` work, through the generic paths.
- No new tool, and `design_app` is unchanged.

**D18. Export on the default session (S13, S73).** Download on an app frame, PNG at 2× or PDF, through the existing `designCanvas:export` handler (`main/handlers/design-canvas.ts:619`), which already takes only `(chatId, frameId, format, theme)`:
- **Order.** For an app frame the handler checks, **before** the Save dialog: the flag (`{error: "live-off"}`); `format` is `png` or `pdf` (`designExportFormats`); the app root's status resolved by the chat's `workspaceId` and the frame's `appRoot` is `running` (`{error: "app-not-running"}`). Only then does it ask for the destination. `DesignCanvasExportResult` gains `"app-not-running" | "live-off"`, and the renderer's toast copy maps them to "Start the app to download this frame." and "Live apps are off."
- **Main resolves the address.** Main builds `origin + route` from `designAppServers`. The renderer never supplies a URL.
- **`designCanvas:source`** answers `{error: "unavailable"}` for an app frame, and the node never shows the Code tab.
- **The window.** `app-export.ts` opens a hidden window like `frame-render.ts`'s (sandboxed, no preload, `disableDialogs`, `setWindowOpenHandler` deny, `disable_non_proxied_udp`), but on the **default session**, so cookies and storage match the canvas. Its `webContentsId` is registered as an export window with the registry for its life, so D3 (E1–E2), D7 (the CSP `sandbox` header), D8 (permissions, downloads) apply to everything in it. `will-navigate` is prevented; `will-redirect` allows a main-frame loopback → app-origin hop only; `will-frame-navigate` refuses every subframe, so frames inside the app draw empty (S65). The CSP sandbox blocks downloads, modals, printing and popups for the top-level document; the download subscriber cancels anything that still starts (E3, E4).
- **Zoom.** The default session keeps zoom per host, and in `npm run dev` the app's host `127.0.0.1` is also the main window's. So the export window always renders at zoom 1 (set on each commit, as `frame-render.ts:79-83` does) and gets 2× through `webContents.enableDeviceEmulation({deviceScaleFactor: 2, …})` (`electron.d.ts:18165`). Task 2 checks that `capturePage` returns 2× pixels under that emulation; if it doesn't, the fallback is `capturePage` at 1× and S73 records PNG at 1×. It shares `frame-render.ts`'s `zoomGate` either way.
- **Settle.** `did-finish-load`, then the bridge's scheme script when `colorScheme` is dark, then 500 ms with no request started (counted by the dispatcher for that web contents), capped at 15 s for a cold compile. Then `capturePage` or `printToPDF` as today, with the viewport as the design width.
- The window is destroyed on every path, and unregistered.

**D19. Analytics.** None. §8 row 3b lists `design_app_frame_added`, and §6.10's "an event lands with its feature" is met when Add ▸ Page from app arrives in 3b. In 3a only Aiden places app frames. A test proves no `report` call happens on placement, render or block.

**D20. Network posture.** 3a adds no outbound access of its own. Its only network effect is to *cancel* requests. It contacts no dev server from main (the export window is a renderer page under the dispatchers), makes no models.dev, catalog or registry call, and nothing runs at startup or in onboarding while the flag is off apart from S76's local storage clear. The `--host-resolver-rules` mapping and the recorder (D6) exist only in the E2E. `npm run check:aiden-rules`' `network-allowlist` stays clean.

**D21. Contract widenings and what guards the old behaviour.**

| Contract | Widening | Guard (existing tests that must pass unedited, plus new ones) |
|---|---|---|
| `DesignFrameKind`, `parseFrame` | `app` kind and fields | `schema.test.ts` existing cases unedited; new app cases and the fixed-point test |
| `isDesignPrintable` | **None**: false for `app` | Existing cases unedited |
| `designExportFormats` | `app` → `["png", "pdf"]` | `frame-export` cases unedited; a new app case |
| `canDesignGuide`, `designMinSize` | Include `app` | Existing cases unedited |
| `selectLiveFrames` | `app` frames are candidates | `live-set-core.test.ts` unedited; a new case with app frames |
| `designNodeTypes` | `app: AppNode` | Type check |
| `canvas_place_frame` | `app` kind with `designLive` only | `canvas-tools.test.ts` unedited; a new test that the flag-off tool definition equals today's |
| `canvas_read`, `canvas_inspect`, `canvas_update_frame`, `canvas_duplicate` | App frames listed or refused | Existing cases unedited |
| `DesignCanvasToolDeps` | Optional `designLive`, `apps` | Existing fakes still type-check |
| `DESIGN_BRIDGE_SOURCE` | Built from the shared core | `bridge-source.test.ts` unedited |
| Main window navigation | Moved; S1, admission and the guard with the flag on; the loopback and `frame: null` refusals in both states | New register-and-invoke tests of today's behaviour (written first, against the moved code) |
| Main window `console-message` | Moved; Live markers from the main frame only; dialog counter with the flag on | New register-and-invoke tests; Live's `[aiden-live]` markers still forwarded |
| Gemini Live permissions | Through the owner slot; `DisplayMediaGuardSession` exported | `display-media-contract.test.ts` and `gemini-live/service.test.ts` unedited |
| `main-window.html` CSP | `frame-src` loopback sources | `renderer-csp.test.ts` existing cases unedited; new `frame-src` cases |
| `designCanvas:export` (`DesignCanvasExportResult`) | App frames on the default session; codes `app-not-running`, `live-off` | `design-canvas.test.ts` existing export cases unedited; new register-and-invoke app cases |
| `designCanvas:source` | Refuses app frames | Existing cases unedited |
| `designCanvas:appFrameMount` | New invoke channel | Register-and-invoke tests; the IPC channel inventory test |
| 2b/2c `DesignAppServers` | None; read only | `app-server-main.test.ts` unedited |
| IPC | One notification, `designCanvas:appFrame` | The IPC channel inventory test (send site and allowlist) |
| `check:aiden-rules` | Rules `default-session-owner` and `loopback-listen-registered` | `check-aiden-rules.test.mjs` existing cases unedited; new cases |
| Listening services | Register their ports | Each service's suite unedited |

## Interfaces

`renderer/shared/design-canvas/app-frame.ts` (pure):

```ts
export const APP_FRAME_SANDBOX = "allow-scripts allow-same-origin allow-forms";
export const APP_FRAME_ALLOW: string; // every listed feature 'none' (D16)
export const APP_FRAME_LIMITS: { routeChars: 2048; minViewport: 200; maxViewport: 4000; minScale: 0.05; maxScale: 2; labelChars: 60 };
export function isAppRoute(value: unknown): value is string;
export function isAppRoot(value: unknown): value is string;
export function roundAppScale(scale: number): number; // 4 decimals
export function appFrameBox(viewport: { width: number; height: number }, scale: number): { w: number; h: number };
export function appFrameName(frameId: string, mountToken: string): string;
export function parseAppFrameName(name: string): { frameId: string; mountToken: string } | null;
/** The same-origin path a bridge reported, or null (D12). */
export function appSourcePath(origin: string, url: string): string | null;
```

`renderer/shared/design-canvas/app-frame-events.ts`:

```ts
export const DESIGN_APP_FRAME_CHANNEL = "designCanvas:appFrame";
export const DESIGN_APP_FRAME_MOUNT_CHANNEL = "designCanvas:appFrameMount";
export type DesignAppFrameEvent =
  | { kind: "blocked"; frameId: string; mountToken: string; count: number; hosts: string[] }
  | { kind: "navigation-refused"; frameId: string; mountToken: string; url: string }
  | { kind: "dialog-suppressed"; frameId: string; mountToken: string; dialog: "alert" | "confirm" | "prompt" | "print" | "beforeunload" };
export type DesignAppFrameMountResult =
  | { origin: string }
  | { error: "live-off" | "app-not-running" | "too-many-frames" | "unavailable" };
export function parseDesignAppFrameEvent(value: unknown): DesignAppFrameEvent | null;
```

`renderer/shared/design-canvas/app-bridge-messages.ts`:

```ts
export type AppBridgeMessage =
  | { type: "ready" }
  | { type: "route"; path: string }
  | { type: "error"; kind: "error" | "rejection" | "overlay" | "module"; message: string; at?: { path: string; line: number } }
  | { type: "hmr" }
  | { type: "escape" }
  | { type: "source"; requestId: string; component?: string; owners: string[]; path?: string; line?: number }
  | { type: "picked" | "anchors" /* v1 core shapes, reused */; /* … */ };
export function parseAppBridgeMessage(data: unknown, origin: string): AppBridgeMessage | null;
export function postToAppPage(target: Window | null | undefined, message: { type: "set-scheme"; dark: boolean } | { type: "source-at"; requestId: string; x: number; y: number } /* + v1 core requests */): void;
```

`main/services/default-session-web-request.ts`:

```ts
export type BeforeRequestHandler = (details: Electron.OnBeforeRequestListenerDetails) => "cancel" | undefined;
export type HeadersHandler = (details: Electron.OnHeadersReceivedListenerDetails, headers: Record<string, string[]>) => Record<string, string[]> | undefined;
export interface DefaultSessionWebRequest {
  onBeforeRequest(name: string, handler: BeforeRequestHandler): () => void;
  onHeadersReceived(name: string, handler: HeadersHandler): () => void;
}
export function claimDefaultSessionWebRequest(
  webRequest: Pick<Electron.WebRequest, "onBeforeRequest" | "onHeadersReceived">,
  options?: { log?: (event: string, fields: Record<string, unknown>) => void; guardSetters?: boolean },
): DefaultSessionWebRequest;
```

`main/services/default-session-permissions.ts`:

```ts
export interface PermissionDenyLayer {
  denyCheck?(webContents: Electron.WebContents | null, permission: string, origin: string, details: Electron.PermissionCheckHandlerHandlerDetails): boolean;
  denyRequest?(webContents: Electron.WebContents, permission: string, details: Electron.PermissionRequest): boolean;
  denyDisplay?(request: Electron.DisplayMediaRequestHandlerHandlerRequest): boolean;
  denyDevice?(details: Electron.DevicePermissionHandlerHandlerDetails): boolean;
}
export type WillDownloadHandler = (item: Electron.DownloadItem, webContents: Electron.WebContents, frame: Electron.WebFrameMain | null) => "cancel" | undefined;
export type SelectDeviceHandler = (kind: "hid" | "serial" | "usb", details: { frame: Electron.WebFrameMain | null }) => "cancel" | undefined;
export interface DefaultSessionPermissions {
  /** Gemini Live's DisplayMediaGuardSession; the same object for the same name. */
  ownerSlot(name: string): DisplayMediaGuardSession;
  addDenyLayer(name: string, layer: PermissionDenyLayer): () => void;
  onWillDownload(name: string, handler: WillDownloadHandler): () => void;
  onSelectDevice(name: string, handler: SelectDeviceHandler): () => void;
}
export function claimDefaultSessionPermissions(target: PermissionTarget, options?: { guardSetters?: boolean }): DefaultSessionPermissions;
```

`main/services/design-canvas/app-frames/app-network-policy.ts` (pure):

```ts
export type AppFrameRef = {
  frameTreeNodeId: number;
  parent: AppFrameRef | null;
  url: string;
  origin: string;
  isMainFrame: boolean; // the main window's main frame
}; // every field read safely; a throwing read is surfaced as `unreadable: true`
export type AppRequest = {
  url: string;
  frame: AppFrameRef | null;
  initiatorOrigin?: string;
  webContentsId?: number;
  inMainWindow: boolean;
};
export type AppPolicyContext = {
  appContext(frame: AppFrameRef | null, inMainWindow: boolean): "registered" | "backstop" | null;
  isAppOrigin(origin: string): boolean;
  isExportContents(webContentsId: number): boolean;
  rendererOrigin: string; // "file://" (as audited) or the dev origin
  ownPorts: ReadonlySet<number>;
  frameless: readonly string[]; // audited URL prefixes (D4), empty at start
};
export function appRequestVerdict(request: AppRequest, context: AppPolicyContext): "allow" | "cancel" | "untouched";
export function isAppLoopback(url: string, ownPorts: ReadonlySet<number>): boolean;
export function appSetCookie(value: string): string;
export function appResponseHeaders(headers: Record<string, string[]>, kind: { appOrigin: boolean; resourceType: string; exportMainFrame: boolean }): Record<string, string[]>;
export class AppCancelCache { /* 1 s cancel-only cache keyed by {frame or contents, scheme, host, port} */ }
```

`main/services/design-canvas/app-frames/app-frame-registry.ts`:

```ts
export class AppFrameRegistry {
  constructor(options: { mainContents(): Electron.WebContents | null; liveIds(): ReadonlySet<number> | null; cap?: number; now?: () => number });
  expectPlacement(record: { frameId: string; mountToken: string; expectedOrigin: string }): "ok" | "too-many-frames";
  admit(navigation: {
    frame: AppFrameRef & { name: string };
    targetUrl: string;
    isDirectChild: boolean;
    initiator: "main-frame" | "none" | "other";
    designFrame: boolean;
  }): "app" | "refused" | "not-candidate";
  isAppFrame(frameTreeNodeId: number): boolean;
  appContext(frame: AppFrameRef | null, inMainWindow: boolean): "registered" | "backstop" | null;
  addExportContents(webContentsId: number): () => void;
  isExportContents(webContentsId: number): boolean;
  reportBlocked(frame: AppFrameRef, hostOrScheme: string): void; // coalesced, then emitted
  onEvent(listener: (event: DesignAppFrameEvent) => void): () => void;
}
```

`main/services/loopback-ports.ts` (D5): `export const aidenLoopbackPorts: { add(port: number): void; delete(port: number): void; has(port: number): boolean; snapshot(): ReadonlySet<number> }`.

`main/services/design-canvas/app-frames/app-sw-origins.ts` (S76): `export function createAppServiceWorkerOrigins(options: { file: string; session: Pick<Electron.Session, "clearStorageData"> }): { remember(origin: string): Promise<void>; clear(): Promise<void> }` (origins only; one leaves only once cleared; past a soft bound of 64 the oldest unowned are evicted through `clear`).

## Global Constraints

- **Fail closed.** Every unknown in the request path cancels: a throwing subscriber, an unparsable URL in app context, a frame whose `url`, `origin` or `parent` throws on read, a frame whose chain doesn't reach the main frame, an initiator-less frameless network request off the allowlist. Every unknown in the navigation path refuses: `frame === null` toward loopback, `https:` or an unknown scheme, a registry that isn't installed, a full registry. Every unknown in the permission path denies.
- **One owner per session event.** Only `default-session-web-request.ts` and `default-session-permissions.ts` call the default session's `webRequest.*`, its permission setters, and its `will-download` and `select-*-device` events. A second claim throws (tested); non-packaged builds also replace the setters with throwing stubs after the claim (D8). `check:aiden-rules` gains `default-session-owner` (Task 4).
- **Install before any window.** The claims and the design subscribers install inside `app.whenReady()` before the first `createMainWindow` (D6).
- **The page is untrusted.** No security decision reads a bridge message, page-set globals, or console text. A frame's `name` is used only as a one-use admission token next to main's own placement record, never as a sufficient condition (D2). Bridge output is bounded and shown escaped; none reaches the model in 3a.
- **Main decides URLs.** The iframe's origin comes from main's mount reply; export URLs come from main's store and `designAppServers`; the renderer never supplies an origin to main.
- **Flag off is today.** Tests in Tasks 4, 6, 7, 10, 12 and 13 each include a flag-off case proving no listener, handler, injection or event appears, and that the tool definition is unchanged.
- **No new network** (D20).
- **UI rules** (AGENTS.md, `GUI.md`, `docs/design-guide.md`; read both ChatGPT references before styling): shared squircle `Button`s, Radix overlays from `ui.tsx`, semantic tokens only, no decorative borders or outlines, status in soft fills and labels, visible `focus-visible` rings on every non-text control, Reduce Motion through the motion tokens, focus return through `returnFocus`, no brain icons.
- **AGENTS.md test rules.**
  - Behavioural tests only: no source greps, no tautologies (no looping D3's rows through a guard built from the same rows: each row's verdict is written by hand), no exact `className` strings, no markup snapshots. The sandbox and `allow` attributes are asserted as token sets, because they are the security contract.
  - Each new test file is registered **in the task that adds it**: appended to `test:design-mode` in `package.json` (union, keeping every entry) and added to its lane in `scripts/ci-test-registry.json` (main and shared in `core-git`; renderer and happy-dom suites in `renderer-other`, as v1's `bridge-source.test.ts` is). The dispatcher, permission and console tests guard Gemini Live too, so they are also appended to `test:gemini-live`. That task runs `npm run test:ci-policy`.
  - The E2E spec goes in `scripts/ci-e2e-spec-map.json` in Task 14.
- **Window-opening runs happen in the Cua Space** (`npm run test:e2e:space`), including Task 2's probes and Task 5's audit. Scratch scripts live untracked inside the worktree so the Space sync carries them; nothing from them is committed.
- **Docs** change in this PR (Task 15).

## Tasks

### Task 0: Baseline

- [x] Branch `t3/design-mode-v2-p3a` from `t3/design-mode-v2-p2c` at `798fb4093` or later. Build the native helpers a fresh worktree needs (`npm run build:native:c`, `npm run build:vcc`) and run `npm ci` in `packages/cli` (2c As built #22).
- [x] Confirm each "Stacking" item (`rg -n "forgetWorkspace|appForOrigin|isAppOrigin|onOriginsChanged" main/services/design-canvas/app-server/app-server-main.ts`, `rg -n "useDesignAppsSnapshot" renderer/design`, `rg -n "designApp:retry" renderer main`), and that `node_modules/electron/package.json` is 43.8.4 or later with `initiatorOrigin`, `framesInSubtree` and the `will-frame-navigate` `initiator` in `electron.d.ts`. These are baseline checks, not tests. If anything differs, update "What exists today" and D21 first.
- [x] Confirm the acceptance launch: `main/bootstrap.ts:51` loads `display-capture-acceptance.js` instead of `main/index.ts`, so it never meets the dispatchers.
- [x] Run `npm run test:design-mode`, `npm run test:gemini-live`, `npx tsx --test scripts/renderer-csp.test.ts`, `node --test scripts/check-aiden-rules.test.mjs` and `npx tsc --noEmit -p .`. Expected: PASS. Record failures as pre-existing.

### Task 1: The fixture app

**Files:**
- Create: `tests/fixtures/design-live-app/` with `package.json`, `index.html`, `vite.config.ts`, `src/main.tsx`, `src/App.tsx`, `src/Home.tsx`, `src/Pricing.tsx`, `src/Probe.tsx`, `src/Login.tsx`, `src/worker.ts`, `public/sw.js`, `README.md`
- Modify: `.gitignore` if needed for the fixture's `node_modules` link and `.vite-cache/`

- [x] **Step 1: Write the fixture.**
  - **`package.json`:** `"scripts": {"dev": "vite"}` and `devDependencies` for `vite`, `@vitejs/plugin-react`, `react` and `react-dom` at the repo root's ranges, so 2b's detection (`app-server-core.ts:104`, `:126-146`) finds Vite. **No lockfile**: the symlinked `node_modules` counts as the person's install, and no install runs.
  - **`vite.config.ts`:** `cacheDir: ".vite-cache"` inside the fixture copy, so the dep optimizer never writes into the repo root's `node_modules` through the link; `@vitejs/plugin-react`; and one middleware plugin: `GET /go-out` → `302 https://example.com/`; `GET /go-login` → `302 /login`; `GET /r-own?port=N` → `307 http://127.0.0.1:N/`; `GET /r-evil` → `302 http://localhost.evil.test/`; `POST /api/login` sets `Set-Cookie: sid=fixture; HttpOnly; Path=/` (no `SameSite`, so Chromium's default `Lax` applies) and redirects to `/login?ok=1`; `GET /api/me` answers the cookie's value or 401; `GET /framed` answers with `X-Frame-Options: DENY` and `Content-Security-Policy: frame-ancestors 'none'; script-src 'self'`; `GET /reporting?to=URL` answers with `Reporting-Endpoints: e="URL"`, `Report-To`, `NEL` and `Content-Security-Policy: script-src 'none'; report-to e`; `GET /f.zip` answers `Content-Disposition: attachment`.
  - No router: `App.tsx` switches on `location.pathname` and listens to `popstate`. Vite's SPA fallback serves `index.html` for every route.
  - `/`: "Fixture home", a counter, and a link to `/pricing`;
  - `/pricing`: `<h1>Pricing</h1>` on a known line of `Pricing.tsx`, and a component `PriceCard` used twice;
  - `/probe?target=<host:port>&own=<port>&udp=<port>`: on a button press (so the E2E controls timing), tries each way out against the given observer targets and writes each outcome to `#result` as JSON: `fetch`, `<img>`, `new WebSocket("wss://…")`, `new EventSource`, CSS `@import`/`@font-face`/`background-image`, `<link rel=prefetch|modulepreload|preconnect|dns-prefetch>`, a speculation-rules prefetch, `<a ping>`, `navigator.sendBeacon` while alive, `new WebTransport` from the page, a dedicated worker, a shared worker and a `blob:` worker each running `fetch`, `<img src="aiden-attachment://…">`/`<script src="aiden-design://…">`/`<link href="aiden-asset://…">`, `fetch("/r-own?port=<own>")`, `fetch("/r-evil")`, `fetch("/go-out")`, `window.open`, `alert("x")`, `confirm("x")`, `print()`, `navigator.mediaDevices.getUserMedia({audio: true})`, `getDisplayMedia()`, `Notification.requestPermission()`, `navigator.geolocation.getCurrentPosition`, `video.requestPictureInPicture()`, `document.documentElement.requestFullscreen()`, `navigator.clipboard.readText()`, an `<iframe src="https://www.youtube.com/embed/x">`, a `top.location` assignment, `location = "mailto:x"`, an `<a download href="/f.zip">` click, `history.go(-1)`, a `pagehide` beacon, a "focus thief" toggle (`setInterval(() => input.focus(), 50)`), and registering `/sw.js`, whose `fetch` handler calls the target, opens a `WebTransport`, and registers a background `sync`;
  - `/login`: a form that posts to `/api/login`; `/api/me` returns the signed-in name.
- [x] **Step 2: Check it runs** headlessly on the host (no window): link `node_modules` to the repo root's (as 2b's Vite test does), start `npx vite --host 127.0.0.1 --port 0 --strictPort` against a temp copy from a scratch script, `curl` `/`, `/go-out` and `/api/me`, and stop it. Expected: 200, 302, 401, and no `.vite/` written under the repo root's `node_modules`. Also run `detectFramework` on the fixture's `package.json` from a one-off `tsx -e`. Expected: `vite`. Nothing is committed from the script.
- [x] **Step 3:** Commit `test(design): a Vite + React 19 fixture app for live frames`.

### Task 2: Pre-build checks in the Space — React 19 source mapping and the Electron probes

**Files:**
- Create: `main/services/design-canvas/app-frames/react-source-walk.ts` (the walk and the VLQ decoder as a source string plus a pure `decodeSourceMapLine` export), `react-source-walk.test.ts`
- Modify: `package.json` (`test:design-mode`), `scripts/ci-test-registry.json` (`renderer-other`: it is a happy-dom suite)
- Scratch (untracked, inside the worktree so the Space sync carries it; never committed): `.p3a-probe/react-source-check.mjs`, `.p3a-probe/electron-probes.mjs`, `.p3a-probe/observer.mjs`

- [x] **Step 1: Write failing tests** (happy-dom plus pure):
  - `decodeSourceMapLine` maps a generated line and column to the original source and line, for a real inline map produced by Vite's own `transformWithOxc`/plugin-react output of a three-line JSX module (built in the test, no network);
  - the walk on a fake React 18 fiber (`_debugSource {fileName, lineNumber}`) gives the component, owners and `path:line`;
  - on a fake React 19 fiber with `_debugStack` whose first app frame is `http://127.0.0.1:5173/src/Pricing.tsx?t=1:14:7`, with a stubbed `fetch` returning a module carrying an inline map, gives `src/Pricing.tsx` and the original line;
  - a frame under `/@fs/`, `/node_modules/` or another origin gives no path;
  - no fiber gives the `data-aiden-src` stamp, else nothing.
- [x] **Step 2:** Run. Expected: FAIL.
- [x] **Step 3: Implement** the walk and decoder.
- [x] **Step 4: The React check.** Run `npm run test:e2e:space -- --run node_modules/.bin/electron .p3a-probe/react-source-check.mjs`: it starts Vite on a temp copy of the fixture, opens a hidden `BrowserWindow` at `/pricing`, runs the walk on the `<h1>` through `executeJavaScript`, and prints the result. Expected: `src/Pricing.tsx` and the `<h1>`'s line. **Record the outcome** in this plan's As built. If it fails, apply D14's fallback now (drop the decoder; the walk returns the component and owners), and change Task 14's assertion to the component name.
- [x] **Step 5: The Electron probes.** Run `npm run test:e2e:space -- --run node_modules/.bin/electron .p3a-probe/electron-probes.mjs`. The script starts `observer.mjs` (a TCP listener, a TLS-less HTTP listener, a UDP listener on 127.0.0.1 and on the Space's non-loopback interface, a DNS stub, and an `aiden-attachment:`-style test scheme handler with a hit counter), launches a main window that frames the fixture through a parent page with the 3a sandbox, installs a recording `webRequest` subscriber on the default session, and runs each probe twice where a switch matters (switch off, then on). It prints a JSON report. **Record every result** in As built:
  1. **WebTransport** from the frame, a dedicated worker and the service worker against the UDP observer: does `onBeforeRequest` see it; do datagrams arrive; does `disable-blink-features=WebTransport` make `WebTransport` undefined in all three (W1, W2)?
  2. **Preconnect and DNS prefetch**: does `<link rel=preconnect>` to an observer host open a TCP connection; does `dns-prefetch` reach the DNS stub, with `blink-settings=dnsPrefetchingEnabled=false` (already set, `main/index.ts:264`) and with `X-DNS-Prefetch-Control: off` on the response (A40)?
  3. **Custom schemes**: does `onBeforeRequest` fire for `<img>`, `<script>` and `<link>` loads of a `standard`/`secure`, `supportFetchAPI: false` scheme, and does a cancel there keep the handler's counter at 0 (A35)?
  4. **Attribution**: for an app frame's own navigation, is `details.frame` the child (its `frameTreeNodeId`) with `resourceType: "subFrame"`; for a nested iframe's navigation, the new child or its parent (A46, Risk 2)?
  5. **Initiator**: what `will-frame-navigate`'s `initiator` is for a navigation started by setting an `<iframe>`'s `src` from the parent (D2's admission rule)?
  6. **`[::1]` in `frame-src`**: with `frame-src … http://[::1]:*`, does a `[::1]` server frame, or does Chromium drop the source with a console warning (S74)?
  7. **Joint session history**: after a sibling app frame navigates, does `history.go(-1)` in another app frame move the sibling (H2)?
  8. **Inert**: with `inert` on the iframe, does the page's focus loop still take focus from a parent `<textarea>` the script types into (K1)?
  9. **Export scale**: does `capturePage` under `enableDeviceEmulation({deviceScaleFactor: 2})` at zoom 1 return 2× pixels (D18)?
  10. **Background sync**: when the service worker registers `sync` and `periodicSync`, does the permission check handler see a call, and with what name (D8)?
  11. **Reporting**: with the reporting headers stripped by a headers subscriber, does the observer see any report upload (H1)?
- [x] **Step 6: Apply the outcomes.** Defaults stand whatever the probes show (D7, S71). Then:
  - ~~if any WebTransport datagram arrives with the switch on, stop and escalate~~ Resolved 2026-11-24: datagrams arrived in every mode, and the main session made WebTransport a documented gap (S71), with no switch;
  - if preconnect or DNS still reaches the observer, write the gap into S71 (next to S5) and into Task 15's docs, and mark A40 as "documented gap" in Task 14 instead of asserting zero;
  - if custom-scheme loads aren't seen by `webRequest`, stop and escalate, as for WebTransport: A22–A24 and A35 can't hold, and a check in the `aiden-*` protocol handlers has to be designed and reviewed before Task 7;
  - if the initiator is `null` for `src`-set navigations, record it; D2 accepts `null` but never another frame;
  - if `[::1]` is dropped, S74 records it and app frames refuse `[::1]` origins with the sentence "This app runs on IPv6 localhost, which the canvas can't show yet. Restart it on 127.0.0.1." (Task 11);
  - if siblings move on `history.go`, record H2 as a documented limit in Task 15's docs;
  - if `inert` doesn't stop the focus loop, stop and escalate: S75 needs another mechanism before Task 11;
  - if `capturePage` stays 1×, S73 records PNG at 1×.
- [x] **Step 7: Register** `react-source-walk.test.ts` (`renderer-other`). Run `npm run test:ci-policy`.
- [x] **Step 8:** Commit `feat(design): React source walk for live frames, checked against React 19` (the probe outcomes go into As built in Task 15's commit).

### Task 3: The `app` frame kind

**Files:**
- Create: `renderer/shared/design-canvas/app-frame.ts`, `app-frame.test.ts`
- Modify: `renderer/shared/design-canvas/schema.ts`, `schema.test.ts`, `renderer/shared/design-canvas/frame-export.ts` (and its test), `renderer/design/live-set-core.ts`, `live-set-core.test.ts`, `renderer/design/nodes/registry.ts`, `renderer/design/nodes/app-node.tsx` (new: the static card only), `package.json`, `scripts/ci-test-registry.json`

- [x] **Step 1: Write failing tests.**
  - **`isAppRoute`, as a table.** Accepted: `/`, `/pricing`, `/blog/hello-world?x=1`. Refused: `""`, `pricing`, `//evil.com`, `/\evil`, `http://x/`, `/a\nb`, a bidi override, 2 049 characters, a number.
  - **`isAppRoot`:** `.`, `web`, `apps/site` accepted; `..`, `./web`, `/abs`, `web/../x`, `a\b` refused.
  - **`appFrameBox`:** `1280 × 800` at 0.5 gives `w 640`, `h 400 + header`; `1333 × 777` at `0.3333` gives integer `w` and `h` (444 and 259 + header).
  - **`roundAppScale`:** `0.333333` → `0.3333`.
  - **`parseAppFrameName`:** round-trips `appFrameName`; refuses other prefixes, extra parts, over-long ids.
  - **`appSourcePath`:** same origin `/src/A.tsx?t=1` → `src/A.tsx`; `/@fs/…`, `/node_modules/…`, `/@id/…`, another origin, `..` → `null`.
  - **Schema:** an app frame parses with every field and `w`/`h` recomputed from viewport and scale (a stored `w` of 9 999 is replaced); a bad route, root, viewport (199, 4 001, 1.5) or scale drops the frame; `label` is cut at 60; `variantOf` keeps a valid id; `designWidth`, `tweaks`, `dark`, `printMode` and `paper` on an app frame are dropped; **parse → serialize → parse is a fixed point** for an app frame at scale `0.3333` and at `0.05` with viewport 200 (the generic clamp doesn't move it); existing kinds' cases unedited.
  - **Export formats:** `designExportFormats({kind: "app"})` is `["png", "pdf"]`; `isDesignPrintable("app")` is false.
  - **Live set:** app frames compete with file frames for the six; an entered app frame is always live.
- [x] **Step 2:** Run. Expected: FAIL.
- [x] **Step 3: Implement** D15. `AppNode` is the static card (title, "Live apps are off", the snapshot or skeleton). It gets its live body in Task 11.
- [x] **Step 4: Register** `app-frame.test.ts` (`core-git`). Run `npm run test:ci-policy`.
- [x] **Step 5:** Rerun, plus `npm run test:design-mode` and `npx tsc --noEmit -p .`. Expected: PASS.
- [x] **Step 6:** Commit `feat(design): the app frame kind`.

### Task 4: The two default-session dispatchers and the one-owner rule

**Files:**
- Create: `main/services/default-session-web-request.ts`, `default-session-web-request.test.ts`, `main/services/default-session-permissions.ts`, `default-session-permissions.test.ts`
- Modify: `main/index.ts` (claim both inside `app.whenReady()` before the first `createMainWindow`), `main/services/gemini-live/service-main.ts` (pass the owner slot), `main/services/gemini-live/display-media-contract.ts` (`export` on `DisplayMediaGuardSession`, nothing else), `scripts/check-aiden-rules.mjs`, `scripts/check-aiden-rules.test.mjs`, `scripts/aiden-rules-allowlist.json`, `package.json`, `scripts/ci-test-registry.json`

- [x] **Step 1: Write failing tests** against a fake `webRequest` and a fake permission target that record every setter call and listener:
  - **webRequest:**
    - `a second claim of the same webRequest throws` (§11 item 4);
    - `with no subscriber no Electron listener is set`; adding one sets it; removing the last sets `null`;
    - `subscribers run in order and the first cancel wins`; a later subscriber doesn't run after a cancel;
    - `a throwing before-request subscriber cancels and logs`; a throwing headers subscriber leaves the headers;
    - `headers subscribers chain`;
    - `a duplicate subscriber name throws`;
    - `with guardSetters, a direct call to the target's onBeforeRequest throws` while the dispatcher still installs its own listener.
  - **Permissions:**
    - `a second claim throws`;
    - `no layer and no owner leaves every handler null`;
    - `an owner alone is installed as given`: the exact functions and display options Live passes reach the target, and `null` from the owner clears them;
    - `ownerSlot returns the same object for the same name`;
    - `a deny layer wins over the owner`, and with no owner the composed handlers answer Electron's defaults (D8): check and request grant, display `{}`, device `false`;
    - `removing the last layer restores the owner's handlers, or null`;
    - `a second owner name throws`;
    - **events:** with no subscriber there is no `will-download` or `select-*-device` listener; a `will-download` subscriber returning `"cancel"` calls `preventDefault` and `item.cancel()`; a `select-hid-device` subscriber returning `"cancel"` calls the callback with `""`; removing the last subscriber removes the listener;
    - `with guardSetters, a direct setPermissionRequestHandler call throws`.
  - **Gemini Live through the slot:** `installGeminiLiveDisplayMediaGuards(slot, …)` with a bound fake document grants its microphone request and denies another document's; calling it twice with `ownerSlot("gemini-live")` returns the same dispose (the `WeakMap` sees one object); dispose leaves the slot empty and the target handlers `null` (no layer).
  - **`default-session-owner` rule** (`check-aiden-rules.test.mjs`): flags `webRequest.on*`, `setPermissionCheckHandler`, `setPermissionRequestHandler`, `setDisplayMediaRequestHandler`, `setDevicePermissionHandler` and `on("will-download" | "select-hid-device" | "select-serial-port" | "select-usb-device")` reached through `session.defaultSession`, `session.fromPartition("")`, `<expr>.webContents.session` and `mainWindow.webContents.session` in any file but `default-session-*.ts`; passes partition sessions (`fromPartition("persist:x")`); an allowlisted file passes.
- [x] **Step 2:** Run. Expected: FAIL.
- [x] **Step 3: Implement** D6 and D8's dispatcher (no design layer yet), and the `default-session-owner` AST rule. Allowlist `main/services/gemini-live/display-capture-acceptance.ts` (its own launch mode, `:149-263`) with that reason. The rule's limit (a session reached dynamically escapes it) is why the runtime setter guard exists; say so in the rule's comment. Wire the claims in `main/index.ts` inside `app.whenReady()` before the first `createMainWindow` (`:2497`), with `guardSetters: !app.isPackaged`, and change `service-main.ts:145` to `defaultSessionPermissions.ownerSlot("gemini-live")`.
- [x] **Step 4: Register** both test files (`core-git`), and append them to `test:gemini-live` as well as `test:design-mode`. Run `npm run test:ci-policy`.
- [x] **Step 5:** Rerun, plus `npm run test:gemini-live` with Live's existing tests **unedited**, `node --test scripts/check-aiden-rules.test.mjs`, `npm run check:aiden-rules` and `npx tsc --noEmit -p main/tsconfig.json`. Expected: PASS.
- [x] **Step 6:** Commit `feat(main): one owner each for the default session's webRequest, permissions and session events`.

### Task 5: The network policy, the registry and Aiden's own ports

**Files:**
- Create: `main/services/design-canvas/app-frames/app-network-policy.ts`, `app-network-policy.test.ts`, `app-frame-registry.ts`, `app-frame-registry.test.ts`, `main/services/loopback-ports.ts`, `loopback-ports.test.ts`, `renderer/shared/design-canvas/app-frame-events.ts`
- Modify: `main/services/aiden-remote-service.ts`, `aiden-mcp-server.ts`, `mcp-oauth-loopback.ts`, `acp/mcp-bridge.ts`, `bot-computers/viewer-hub.ts`, `browser/files.ts`, `devices/local-device-host.ts`, `devices/device-hub-proxy.ts`, `app-updater.ts` (register loopback ports), `scripts/check-aiden-rules.mjs`, `scripts/check-aiden-rules.test.mjs`, `scripts/aiden-rules-allowlist.json`, `package.json`, `scripts/ci-test-registry.json`

- [x] **Step 1: The frameless audit (D4), in the Space.** With the flag on and a logging-only subscriber behind a scratch env var (untracked `.p3a-probe/audit.mjs`, a Playwright script run with `npm run test:e2e:space -- --run node .p3a-probe/audit.mjs`), launch the built app (`file://` renderer) and: send a chat, open a link preview, use spellcheck, open Settings → About (update check), start and stop Gemini Live if a key is present, start an MCP OAuth sign-in against the test OAuth server, load an image attachment. Log every `frame: null` request with its `initiatorOrigin` (or its absence), scheme and host. Record in As built: the exact `initiatorOrigin` the renderer's own frameless requests carry (`"file://"` or `"null"`, m16), every initiator-less network request, and what couldn't be exercised (no Gemini key, no OAuth provider). Add to `APP_FRAMELESS_ALLOWLIST` only what was observed, with a comment naming each owner; it starts empty. If the renderer's initiator is `"null"`, stop and amend D4 first.
- [x] **Step 2: Write failing tests.**
  - **`appRequestVerdict`: D3's table, every row**, each with its verdict written by hand in the test (no derivation from the policy's own sets). Fabricated frames are plain objects `{frameTreeNodeId, parent, url, origin, isMainFrame}`; a getter that throws stands in for a destroyed frame and must give `cancel` in the main window; A45's frame has a `parent` chain ending at `null` without reaching the main frame; A47's frame isn't registered but has a loopback `origin`. The renderer origin is tested both as `file://` and as the dev origin `http://127.0.0.1:4143` (A28, N10).
  - **Cancel cache:** a second identical cancel within 1 s doesn't call `appContext` again; an allow is never cached; after 1 s the walk runs again. **Load:** 10 000 cancels from one fabricated frame complete in under 250 ms of policy time, and an interleaved main-frame request is decided in under 5 ms.
  - **`isAppLoopback`:** normalization rows (A9, `[0:0:0:0:0:0:0:1]`, `LOCALHOST`), and `ownPorts` rows.
  - **`appSetCookie`, as a table:** no `SameSite` → `SameSite=None; Secure`; `SameSite=Lax`/`Strict` (any case) → `None`; `Secure` kept once; `Max-Age`, `Path`, `HttpOnly` and `Domain` kept; a cookie with `Partitioned` kept.
  - **`appResponseHeaders`:** for an app origin: `X-Frame-Options` (any case) removed; `frame-ancestors` removed from each CSP value and the rest kept (`script-src 'self'` stays); an empty CSP after removal drops that value; for any app-context response: `Report-To`, `NEL` and `Reporting-Endpoints` (any case) removed (H1); for `mainFrame`, `subFrame` and worker scripts, one added `connect-src` CSP value with exactly D7's sources and `X-DNS-Prefetch-Control: off`; for an image response, no CSP added; for a non-app-origin loopback response, `X-Frame-Options` kept; for an export main frame, the `sandbox` CSP added; other headers untouched.
  - **Registry:**
    - `expectPlacement` then `admit` with a matching name, the expected origin, a direct child, `initiator: "main-frame"`, an `about:blank` frame → `app`; the record is consumed (a second admit with the same name is `refused`);
    - each failing condition alone gives `refused`: another origin, a nested frame, `initiator: "other"`, a frame whose URL is an `aiden-design:` page, `designFrame: true`, an expired record (31 s on the fake clock), no record;
    - `initiator: "none"` is accepted or refused per Task 2's recorded outcome (the test asserts the recorded one);
    - membership is sticky across a later navigation to another loopback origin; there is no `reset()`;
    - **a live frame is never evicted:** 600 admissions of frames that each disappear from `liveIds()` right after, plus one long-lived frame admitted first that stays in `liveIds()`: the long-lived frame is `isAppFrame` throughout and `appContext` finds it at the end (R6);
    - at the cap with every id live, a new admission is `refused` and `expectPlacement` answers `too-many-frames`; after one id leaves `liveIds()`, the next admission succeeds;
    - `appContext` finds a registered ancestor three levels up; gives `backstop` for an unregistered loopback-origin main-window subframe, for a chain that doesn't reach the main frame, and for a frame whose `parent` read throws; gives `null` for an `aiden-design:` frame and for the main frame;
    - blocked reports coalesce into one `blocked` event per frame per 250 ms with a running count and at most 20 distinct hosts;
    - a `backstop` frame and a frame with no parsable name emit nothing.
  - **Loopback ports:** add, has, delete, snapshot.
  - **Each listening service:** after its `listen`, `aidenLoopbackPorts.has(port)`; after close, not. For `local-device-host.ts`: the hub's reserved port is registered before spawn and removed when the hub stops; a reused agent daemon's `httpPort` from `daemon.json` is registered, and removed when it is found unhealthy. For `app-updater.ts`: a fake `autoUpdater` whose `getFeedURL()` returns `http://127.0.0.1:61234` at `update-downloaded` registers 61234; a non-loopback feed URL registers nothing. These extend each service's existing suite with new cases; existing cases stay unedited.
  - **`loopback-listen-registered` rule** (`check-aiden-rules.test.mjs`): a module with `server.listen(0, "127.0.0.1")` and no `aidenLoopbackPorts.add` is flagged; with the call, it passes; an allowlisted file passes; `*.test.ts` and `fixtures/` are skipped.
- [x] **Step 3:** Run. Expected: FAIL.
- [x] **Step 4: Implement** D3–D5, D7's pure header rules, the registry, the cancel cache, and the event parser in `app-frame-events.ts` (with its own cases in `app-frame.test.ts`). Add the port registrations to the services listed in D5, and the drift rule with D5's allowlist entries and reasons. `npm run check:aiden-rules` must report nothing new.
- [x] **Step 5: Register** the three new test files (`core-git`). Run `npm run test:ci-policy`.
- [x] **Step 6:** Rerun, plus the touched services' suites, `node --test scripts/check-aiden-rules.test.mjs` and `npm run check:aiden-rules`. Expected: PASS.
- [x] **Step 7:** Commit `feat(design): the live-frame network policy, frame registry and Aiden's own ports`.

### Task 6: Main window navigation, S1, admission and the guard

**Files:**
- Create: `main/windows/main-window-navigation.ts`, `main-window-navigation.test.ts`, `main/services/design-canvas/app-frames/app-frame-guard.ts`, `app-frame-guard.test.ts`
- Modify: `main/index.ts` (call `installMainWindowNavigation(createdWindow, deps)` instead of the inline handlers at `:1953-1975`, for every created window), `package.json`, `scripts/ci-test-registry.json`

- [x] **Step 1: Write the flag-off tests first, against today's code moved verbatim** into `installMainWindowNavigation`, with a fake `webContents` (an `EventEmitter` with `getURL`, `mainFrame` and `setWindowOpenHandler`) and a recording `openExternal`:
  - `window.open opens externally and is denied`;
  - `a main-frame navigation to another URL is prevented and opened externally`; the same URL is allowed;
  - `a redirect is prevented and opened externally` (today's behaviour for every frame, kept with the flag off);
  - `the v1 design guard keeps a design frame on its host` (G24);
  - **the new flag-off rows:** G9, G10, G11, G12, G14 (flag off) and G21: a direct subframe to `http://127.0.0.1:5173` is refused; a genui frame and a file frame self-navigating to loopback are refused; a `frame: null` loopback target is refused; to the renderer's own dev origin it is allowed.

  Move the code, run them. Expected: PASS except the new rows, which FAIL until Step 4.
- [x] **Step 2: Write failing flag-on tests.**
  - **`app-frame-guard` as a table (pure):** every flag-on row of D9's guard table, G1–G24, each verdict written by hand, with fabricated frames, records and initiators.
  - **Register and invoke, flag on**, with a real registry:
    - `a subframe redirect never calls openExternal`: loopback → external is prevented, reported blocked, and sends one `navigation-refused` with the redirect target; loopback → loopback proceeds (S1's two rows, G1, G2);
    - `a main-frame redirect still opens externally` (G3);
    - `an app frame's link out is prevented and sends one navigation-refused event` (G4);
    - `mailto:, vscode: and slack: from an app frame are refused and openExternal is never called` (G23, D3b D1);
    - `a placed frame is admitted only on its expected origin` (G7, G8, G15, G16), and `a full registry refuses` (G17);
    - `before install, a loopback subframe is refused` (G22);
    - `a second window gets the same handlers`: install for window A, close it, install for window B; an app frame in B is admitted and a genui frame in B is refused;
    - `with the flag on, select-bluetooth-device is answered with an empty choice`.
- [x] **Step 3:** Run. Expected: FAIL.
- [x] **Step 4: Implement** D9, D11's refusals, admission through the registry, and the Bluetooth handler.
- [x] **Step 5: Register** both test files (`core-git`). Run `npm run test:ci-policy`.
- [x] **Step 6:** Rerun, plus `npx tsx --test main/services/design-canvas/frame-navigation.test.ts` unedited. Expected: PASS.
- [x] **Step 7:** Commit `fix(main): subframe redirects never open the browser; admit and guard live app frames`.

### Task 7: Wiring the design subscribers, admission IPC, console and service workers

**Files:**
- Create: `main/services/design-canvas/app-frames/app-network-main.ts`, `app-network-main.test.ts`, `main/windows/main-window-console.ts`, `main-window-console.test.ts`, `main/services/design-canvas/app-frames/app-sw-origins.ts`, `app-sw-origins.test.ts`
- Modify: `main/index.ts` (install `installAppNetwork` right after the claims, before the first window; replace the inline `console-message` listener at `:1945-1951` with `installMainWindowConsole` for every created window), `main/handlers/design-canvas.ts` and `design-canvas.test.ts` (`designCanvas:appFrameMount`), `renderer/preload-channels.ts`, `package.json`, `scripts/ci-test-registry.json`

- [x] **Step 1: Write failing tests** with the real dispatchers over fake targets, a real registry and a fake `DesignAppServers` (`isAppOrigin`, `appForOrigin`, `onOriginsChanged`, `forgetWorkspace`, `snapshot`):
  - **flag off:** `installAppNetwork({enabled: false})` adds no subscriber, no deny layer, no download or chooser subscriber and no console counter; the fake targets record no setter call;
  - **flag on, requests:** a request from a registered app frame to `https://example.com/` is cancelled and its host reaches a `blocked` event for that frame's `{frameId, mountToken}`; a main-frame request is untouched (M1); a `frame: null` request with no initiator to a non-allowlisted host is cancelled and logs one `design-live frameless-cancel` with the host only, and a second within a minute logs nothing;
  - **flag on, headers:** an app-frame response from an app origin with `Set-Cookie: sid=1` comes back `SameSite=None; Secure`; the same response for a non-app frame is untouched; `X-Frame-Options` goes only for the app frame; `Report-To` goes for any app-context response; the `connect-src` CSP is added to an app-context document response;
  - **debugging ports:** with a fake command line whose `remote-debugging-port` is 9333 and a fake `inspector.url()` on 9339, both are in `ownPorts` after install;
  - **permissions (S9), with Live bound and unbound:**
    - an app frame's `media` request (`isMainFrame: false`, `requestingUrl` `http://127.0.0.1:5173/`) is denied;
    - a check with `requestingUrl` `http://127.0.0.1:5173/` is denied, and one from the renderer's own origin isn't, with the renderer origin as `file://` and as the dev origin;
    - a service-worker check (no web contents, `securityOrigin` an app origin) is denied;
    - an export window's `notifications` and `media` requests are denied (E6);
    - an app frame's `openExternal` request is denied;
    - Live's own document's microphone request is still granted while bound; unbound, the renderer main frame's check gets Electron's default;
    - a display request whose `frame` is in app context gets `{}`;
    - a device permission for an app origin is `false`;
    - `select-hid-device`, `select-serial-port` and `select-usb-device` from an app-context frame are cancelled; from the main frame they pass through (no handler);
  - **downloads:** a `will-download` from an export window's web contents is cancelled (E3); one whose `frame` is in app context is cancelled; one from the main window's main frame is left alone;
  - **events** go to the current main window's `webContents.send(DESIGN_APP_FRAME_CHANNEL, …)` only, looked up through the getter;
  - **window recreated (R7):** install, bind window A, close A (the getter returns `null`), create B and bind it; an app frame admitted in B gets its external fetch cancelled and its `media` request denied;
  - **`designCanvas:appFrameMount` (register and invoke):** flag off → `{error: "live-off"}`; a frame that isn't `kind: "app"` → `unavailable`; an app root not running in the chat's workspace → `app-not-running`; the same `appRoot` running in **another** workspace → `app-not-running` (resolved by `workspaceId`); running → `{origin}` and a waiting record the registry admits; a full registry → `too-many-frames`; a `url` or `origin` field in the payload is ignored;
  - **console (`main-window-console.test.ts`):** a `[aiden-live] microphone-ready` from the main frame is forwarded; the same text from a subframe isn't and doesn't use the budget; with the flag on, "Ignored call to 'alert()'. The document is sandboxed…" from an app-context frame sends one `dialog-suppressed`, a second within 5 s doesn't, and the same text from a non-app frame sends nothing;
  - **service workers (`app-sw-origins.test.ts`, temp dir and fake session):** `remember` keeps at most 64 origins and only origins; `clear` calls `clearStorageData({origin, storages: ["serviceworkers"]})` for each and empties the file; a corrupt file clears nothing and is reset; the design wiring calls `remember` on admission, `clear` for that workspace's origins on `forgetWorkspace`, and `clear` once at startup with the flag on **and** off (S1).
- [x] **Step 2:** Run. Expected: FAIL.
- [x] **Step 3: Implement.** `designAppServers.onOriginsChanged` needs no action: the policy reads `isAppOrigin` on each request. The startup clear runs after ready and never blocks window creation. Add `"designCanvas:appFrame"` (send) and `"designCanvas:appFrameMount"` (invoke) to `renderer/preload-channels.ts` with their sites, so the IPC inventory test passes. When `AIDEN_E2E_DESIGN_LIVE_RECORD` is set and `app.isPackaged` is false, attach D6's recorder.
- [x] **Step 4: Register** the three new test files (`core-git`); append `main-window-console.test.ts` and `app-network-main.test.ts` to `test:gemini-live` too. Run `npm run test:ci-policy`.
- [x] **Step 5:** Rerun, plus the IPC contract test, `npm run test:gemini-live`, `npx tsx --test main/handlers/design-canvas.test.ts` and `npx tsc --noEmit -p .`. Expected: PASS.
- [x] **Step 6:** Commit `feat(design): live app frames reach only loopback and get no permissions`.

### Task 8: The CSP

**Files:**
- Modify: `main-window.html`, `scripts/verify-renderer-csp.mjs`, `scripts/renderer-csp.test.ts`

- [x] **Step 1: Write failing tests** in `renderer-csp.test.ts`:
  - the production build of a page with the new `frame-src` keeps its three loopback sources (they are not stripped like `script-src`'s);
  - `assertProductionRendererCsp` rejects a `main-window.html` whose `frame-src` adds `https:`, `http:`, `*` or `http://example.com`, and one missing `aiden-design:`;
  - another page with `frame-src https:` is rejected.
- [x] **Step 2:** Run. Expected: FAIL.
- [x] **Step 3: Implement** D11: the `frame-src` change and `assertFrameSrc`. Task 6's refusals are already in place, so the wider `frame-src` never admits a frame the guard doesn't.
- [x] **Step 4:** Rerun, plus `npm run build` (which runs `verify-renderer-csp.mjs` on the real build). Expected: PASS.
- [x] **Step 5:** Commit `feat(design): the main window may frame admitted loopback apps`.

### Task 9: The v2 bridge source and its messages

**Files:**
- Create: `main/services/design-canvas/bridge-core-source.ts`, `main/services/design-canvas/app-frames/app-bridge-source.ts`, `app-bridge-source.test.ts`, `renderer/shared/design-canvas/app-bridge-messages.ts`, `app-bridge-messages.test.ts`
- Modify: `main/services/design-canvas/bridge-source.ts` (built from the core), `package.json`, `scripts/ci-test-registry.json`

- [x] **Step 1: Move v1's core** into `bridge-core-source.ts` and rebuild `DESIGN_BRIDGE_SOURCE` from it. Run `npx tsx --test main/services/design-canvas/bridge-source.test.ts` **unedited**. Expected: PASS.
- [x] **Step 2: Write failing tests**, running the real v2 script in happy-dom with a stand-in parent (as v1's test does) and a fake importer:
  - **once-guard (S11):** a second run with the same nonce installs nothing (one `ready`); a page that pre-set `window.__aidenAppBridge = "guess"` still gets the bridge; a new nonce installs again (a new document);
  - **the expression's value:** evaluating the injected expression gives `undefined`, even when the page replaced `Promise.prototype.then` first;
  - **answers only its parent:** a `pick-at` from another source gets no reply;
  - **prefix:** every message starts `aiden-app:`; an `aiden-design:` request gets no reply;
  - **route:** `pushState`, `replaceState` and `popstate` each post the new path; a 3 000-character path is cut;
  - **errors:** a thrown error, an unhandled rejection, a `vite-error-overlay` element added later and a `nextjs-portal` each post `error` with its kind; a 2 000-character message is cut to 500; a stack frame on another origin gives no `at`;
  - **hmr:** with `<script type="module" src="/base/@vite/client">`, the importer is called with `http://127.0.0.1:5173/base/@vite/client`; its fake `createHotContext().on("vite:afterUpdate")` callback posts `hmr`; with no such script, or with `src="https://evil.example/@vite/client"` or `src="//evil.example/@vite/client"`, the importer is never called;
  - **escape:** an unmodified `Escape` keydown posts `escape`; `Shift+Escape` doesn't;
  - **set-scheme:** `dark: true` sets `color-scheme`, `data-theme="dark"` and `class="dark"`; `false` removes exactly those, keeping a `class="dark"` the page had itself and a `data-theme` it set;
  - **source-at:** answers through Task 2's walk;
  - **v1 core:** `pick-at` and `locate` answer as v1's (one case each, to prove the shared core is wired).
  - **`parseAppBridgeMessage`, as a table:** each type's valid shape, `escape` included; a wrong prefix, unknown type, non-string fields, an oversized path or message, 9 owners, a negative or fractional line, `at.path` of `/@fs/x` or `../x`, and a `source` with `path` but no `line` are dropped or trimmed as D12 says.
- [x] **Step 3:** Run. Expected: FAIL.
- [x] **Step 4: Implement** D12 and D13.
- [x] **Step 5: Register** `app-bridge-source.test.ts` (happy-dom, `renderer-other`, as v1's `bridge-source.test.ts`) and `app-bridge-messages.test.ts` (`core-git`). Run `npm run test:ci-policy`.
- [x] **Step 6:** Rerun, plus `npm run test:design-mode`. Expected: PASS.
- [x] **Step 7:** Commit `feat(design): the live app bridge, its once-guard and its message parser`.

### Task 10: Injection

**Files:**
- Create: `main/services/design-canvas/app-frames/app-bridge-main.ts`, `app-bridge-main.test.ts`
- Modify: `main/index.ts` (install with every created main window, flag on only), `package.json`, `scripts/ci-test-registry.json`

- [x] **Step 1: Write failing tests** with a fake `webContents` emitter and fake `WebFrameMain`s that record `executeJavaScript(code, userGesture)` calls:
  - `a registered app frame gets the bridge on dom-ready, with a nonce, and userGesture false`;
  - `did-frame-finish-load in the same document reuses the nonce`, so the script runs with the same value (the once-guard does the rest);
  - `after did-frame-navigate the nonce is new`;
  - `a nested frame inside an app frame gets nothing`;
  - `a frame whose origin isn't an app origin gets nothing`, even if registered (it navigated to another loopback origin);
  - `a file frame, a genui frame, a backstop frame or the main frame gets nothing`;
  - `an executeJavaScript that rejects is swallowed`, and one that resolves to a thenable isn't awaited further;
  - `a recreated window gets injection too`;
  - `flag off installs no listener`.
- [x] **Step 2:** Run. Expected: FAIL.
- [x] **Step 3: Implement.**
- [x] **Step 4: Register** (`core-git`). Run `npm run test:ci-policy`.
- [x] **Step 5:** Rerun. Expected: PASS.
- [x] **Step 6:** Commit `feat(design): inject the bridge into live app frames`.

### Task 11: The live app node

**Files:**
- Modify: `renderer/design/nodes/app-node.tsx`, `renderer/design/nodes/frame-actions.tsx`, `renderer/design/frame-snapshots.ts` (generation and capture throttle for app frames), `renderer/lib/ipc.ts` (`onDesignAppFrame`, `designAppFrameMount`), `renderer/design/design-comments.tsx` (kind check; frame-level pin on app frames), `renderer/design/design-present.tsx` (no `single` for app frames; inert while presenting), the canvas resizer (aspect lock for app frames), the export toast copy (`app-not-running`, `live-off`)
- Create: `renderer/design/nodes/app-node.test.tsx`, `renderer/design/app-frame-messages.test.tsx` (the listener checks)
- Modify: `package.json`, `scripts/ci-test-registry.json`

Before styling, read `docs/chatgpt-desktop-ui-inspiration.md` and `docs/chatgpt-ui-element-specimen.html`, `GUI.md` and `docs/design-guide.md`.

- [x] **Step 1: Write failing tests** (Testing Library on happy-dom, with a fake snapshot hook, a fake mount IPC and a fake event source):
  - **iframe contract:** with a running app and a mount reply `{origin: "http://127.0.0.1:5173"}`, the iframe's `sandbox` token set is exactly `allow-scripts`, `allow-same-origin`, `allow-forms` (no `allow-modals`, `allow-popups`, `allow-top-navigation`, `allow-downloads`); the `allow` token set denies every D16 feature, `picture-in-picture`, `fullscreen` and `display-capture` included; `referrerpolicy` is `no-referrer`; `src` is `http://127.0.0.1:5173/pricing`; `name` parses back to the frame id and the token passed to the mount call; there is `data-app-frame-id` and **no** `data-frame-id`;
  - **mount order:** no iframe exists until the mount call resolves; the mount call carries `chatId`, the frame id and a fresh token, and no URL; a mount reply with `[::1]` gives `http://[::1]:5173/pricing` (or, after Task 2's `[::1]` fallback, the IPv6 sentence and no iframe);
  - a new origin in the snapshot gives a new mount call, a new token and a new iframe element;
  - **inert:** not entered → the iframe has `inert`; after double-click it doesn't; after a canvas click or an `escape` message from this iframe's window it has `inert` again; an `escape` from another window changes nothing;
  - **states**, one case per row of D16's table: the overlay text, and the button (Start app → `designApp.start(chatId, appRoot)`; Connect for a url root; Retry → `designApp.retry(chatId, appRoot)`; none for consent, starting, problems, too-many-frames); running before `load` keeps the snapshot visible;
  - **flag off:** "Live apps are off", no iframe, no mount call;
  - **not live** (outside the six): the snapshot, no iframe, no mount call;
  - **blocked label:** two `blocked` events for this mount show "3 blocked"; the popover lists the hosts escaped (a bidi override shows as `\u{202E}`), at most 20 plus "and N more", and the fixed sentence; an event for another `mountToken` changes nothing;
  - **dialogs:** a `dialog-suppressed` event adds "Dialogs are turned off on the canvas" with the kind;
  - **navigation-refused:** five events within one second give one toast with the latest URL; Open in browser calls the browser panel's open with that URL;
  - **route and error:** a `route` message from this iframe's window shows the path; from another window, nothing; an `error` message shows the Error label, a button whose popover holds the escaped text and which is reachable by Tab;
  - **rate limits:** 200 `route` messages in one tick change the shown path at most 60 times; 10 `hmr` messages within 2 s cause one snapshot capture;
  - **Dark switch:** toggling posts `set-scheme` to this iframe only and saves `colorScheme`;
  - **frame actions:** Download offers PNG and PDF only; there is no Code tab, no Open full window and no tweaks;
  - **resize:** a corner drag from 640 × 400 to 800 × 450 writes `scale 0.625` and a box of 800 × 500 + header (aspect kept);
  - **present:** while presenting, app frames are rendered with `inert` and the presentation's arrow keys still advance; the frame menu doesn't offer full window;
  - **comments:** C + click on an app frame creates a comment with that `frameId` and no `anchor`.
  - **`app-frame-messages.test.tsx`:** a message with an `aiden-design:` prefix posted from an app iframe's window changes nothing in `design-comments.tsx`'s and `file-node.tsx`'s state (no anchors written), and `design-comments.tsx` ignores a page report from a frame whose kind isn't `file`.
- [x] **Step 2:** Run. Expected: FAIL.
- [x] **Step 3: Implement** D16, the export toast copy for the new codes, and the IPC wrappers.
- [x] **Step 4: Register** both test files (`renderer-other`). Run `npm run test:ci-policy`.
- [x] **Step 5:** Rerun, plus `npm run test:design-mode`. Expected: PASS.
- [x] **Step 6:** Commit `feat(design): live app frames on the canvas`.

### Task 12: `canvas_place_frame {kind: "app"}`

**Files:**
- Modify: `main/services/design-canvas/canvas-tools.ts`, `canvas-tools.test.ts`, `main/services/llm-client.ts` (pass `designLive` and `apps`)

- [x] **Step 1: Write failing tests:**
  - **flag off:** the `canvas_place_frame` definition (name, description, parameters) is deep-equal to the one built with the deps today's tests use, and `kind: "app"` is refused with the existing kind error;
  - **flag on:** placing `{kind: "app", route: "/pricing"}` in a one-app workspace makes an app frame with `appRoot "."`, viewport 1280 × 800, scale 0.5 and the D15 box, on the turn's page; a second call reuses it; `duplicate: true` adds one;
  - an unknown `appRoot`, a bad route and a `width` of 100 are tool errors naming the rule;
  - several apps and no `appRoot`: an error listing the roots;
  - `canvas_read` lists the app frame with its route and `live`;
  - `canvas_inspect` and `canvas_duplicate` on it give their D17 errors; `canvas_update_frame {dark: true}`, `{paper: "a4"}` and `{printMode: …}` on it error and `{colorScheme: "dark"}` works; a resize changes `scale`, keeps the viewport and keeps the aspect ratio;
  - no `report` call (D19).
- [x] **Step 2:** Run. Expected: FAIL.
- [x] **Step 3: Implement** D17.
- [x] **Step 4:** Rerun, plus `npm run test:design-mode` and `npx tsc --noEmit -p .`. Expected: PASS.
- [x] **Step 5:** Commit `feat(design): Aiden places live app frames`.

### Task 13: Export on the default session

**Files:**
- Create: `main/services/design-canvas/app-frames/app-export.ts`
- Modify: `main/handlers/design-canvas.ts` (route app frames in `designCanvas:export`; refuse them in `designCanvas:source`; widen `DesignCanvasExportResult`), `main/handlers/design-canvas.test.ts`

- [x] **Step 1: Write failing tests** in `design-canvas.test.ts`'s register-and-invoke suite, with a fake app renderer and a recording `saveFile`:
  - an app frame with a running app asks the app renderer for `http://127.0.0.1:5173/pricing` at its viewport width and `colorScheme`, and writes its bytes;
  - the app root is resolved by the chat's `workspaceId` and `appRoot`: the same root running in another workspace gives `{error: "app-not-running"}`;
  - no running app: `{error: "app-not-running"}`, and **`saveFile` was never called**;
  - flag off: `{error: "live-off"}`, and `saveFile` was never called;
  - format `source` on an app frame: `{error: "unavailable"}`;
  - `designCanvas:source` on an app frame: `{error: "unavailable"}`;
  - file and artifact frames still go to `renderDesignFrame` (existing cases unedited).
  - **`app-export.ts` decisions** (pure helpers, tested in the same file): the export window's options carry the default session, `sandbox: true`, `disableDialogs`, no preload; its zoom is 1 on each commit; the capture request asks for `deviceScaleFactor: 2` for PNG (or 1, per Task 2's recorded outcome); its web contents is registered as an export window for the render's life and unregistered on success, failure and timeout; the download subscriber cancels a download from it (E3).
- [x] **Step 2:** Run. Expected: FAIL.
- [x] **Step 3: Implement** D18. The window itself is production-only, as `frame-render.ts` is; its decisions are in the helpers above, the registry, the policy (the `sandbox` CSP), the guard and the dispatchers, already tested, plus Task 14's E2E.
- [x] **Step 4:** Rerun. Expected: PASS.
- [x] **Step 5:** Commit `feat(design): download live app frames, drawn on the default session`.

### Task 14: E2E, observer oracles and screenshots

**Files:**
- Create: `tests/e2e/design-live-frames.spec.ts`, `tests/e2e/design-live-observer.ts` (the observer listeners and the Space's non-loopback address)
- Modify: `tests/e2e/design-mode-helpers.ts` (an `AIDEN_E2E_DESIGN_LIVE_ALL=1` switch that adds `AIDEN_EXPERIMENTAL_DESIGN_LIVE=1` to every launch, for the flag-on v1 runs), `scripts/ci-e2e-spec-map.json`: map the spec to `renderer/design/nodes/app-node`, `renderer/shared/design-canvas/app-*`, `main/services/design-canvas/app-frames/`, `main/services/default-session-*`, `main/windows/main-window-navigation`, `main/windows/main-window-console`, `main/services/loopback-ports.ts`, `main-window.html` and `tests/fixtures/design-live-app/`

- [x] **Step 1: Write the spec** (as built: deviation 17). Launch with `AIDEN_EXPERIMENTAL_DESIGN_LIVE=1`, `AIDEN_E2E_DESIGN_LIVE_RECORD=<test output>/record.jsonl`, a temp copy of `tests/fixtures/design-live-app/` with `node_modules` linked to the repo root's, and the fake model scripted to call `design_app start` and then `canvas_place_frame` for `/` and `/pricing`. The E2E renderer loads from `build/renderer` (`file://`), as packaged builds do.
  - **Observers (the oracle for every `*` row).** `design-live-observer.ts` starts, per test: a raw TCP listener on `127.0.0.1:P` (for `https://127.0.0.1:P`, which policy cancels), a TCP listener on `127.0.0.2:P2` (A17; routable on Linux loopback), a UDP listener on `127.0.0.1:U` (QUIC/WebTransport), and an HTTP listener on the Space's non-loopback interface address `I:Q`. Aiden's own ports can't host an observer (Aiden is listening there), so own-port rows (A29, A41) assert on the recorder instead: the spec reads one registered own port from the recorder's install line and checks a `cancel` entry for a request to it. Electron launches with the **test-only** switch `--host-resolver-rules="MAP example.com I:Q, MAP www.youtube.com I:Q, MAP localhost.evil.test I:Q, MAP fonts.googleapis.com I:Q"` passed by Playwright's launch args, never by product code. Each observer counts connections, bytes and datagrams; every `*` row asserts **zero** at its observer as well as the page-side failure. A positive control at the start proves the mapping works: an unfiltered request from Playwright's own Node side reaches `I:Q`.
  - **Attribution (A46).** After `/pricing` loads, `record.jsonl` holds a `subFrame` entry whose `frameTreeNodeId` is the app iframe's own (read through the recorder's `frame-created` line), proving the dispatcher sees the frame's own navigation as the child.
  - **Two routes live:** after Allow on the consent card, both frames show "Fixture home" and "Pricing" inside their iframes (Playwright frame locators).
  - **Probe** (D3's starred rows and D3b): place `/probe?target=…&own=…&udp=U`, enter it, press its button, read `#result`, then check every observer:
    - A11, A12, A17, A19, A21, A36–A39, A43, A44, R1, R4: failed in the page, and zero bytes at the observers;
    - A41: failed in the page, and the recorder holds a `cancel` for the own port;
    - A35: the custom-scheme loads failed and Aiden's scheme handlers logged no hit for them (the recorder's `untouched`/`cancel` lines and the handler's test counter);
    - A40: no TCP connect at the observer (or, if Task 2 recorded the gap, the test asserts the documented S71 behaviour instead);
    - W1, W2 are a documented gap (S71): the spec asserts nothing about WebTransport, neither that it is stopped nor that it leaks;
    - the frame's title shows a blocked count ≥ 5, and its popover lists `example.com`, `192.168.1.10` and `www.youtube.com` with the localhost sentence;
    - `window.open` returned `null` and the external-open recorder saw nothing;
    - `alert`, `confirm` and `print` returned at once; the popover lists "Dialogs are turned off on the canvas";
    - `getUserMedia` rejected with `NotAllowedError`, `getDisplayMedia` rejected, `Notification.requestPermission()` gave `denied`, geolocation failed (P2);
    - `requestPictureInPicture` rejected and no new window appeared (P1); `requestFullscreen` and `clipboard.readText` rejected (P2);
    - `top.location` didn't change the window's URL;
    - `location = "mailto:x"` left the frame where it was and the external-open recorder saw nothing (D1);
    - the `<a download>` click started no download and showed no dialog (D2);
    - after the service worker is active, its fetch failed and the observer saw zero bytes (N1);
    - **frameless beacons (N2, N3):** remove the frame (Hide), which fires its `pagehide` beacon and keepalive fetch; the observer at `I:Q` saw zero bytes. No blocked-count assertion is made for frameless requests.
  - **Focus (K1):** with `/probe`'s focus thief running and the frame not entered, the test types "hello composer" into the chat composer; the composer holds exactly that text.
  - **Esc and leave:** enter `/pricing`, press Esc inside it: the frame leaves (the bridge's `escape`), `inert` is back, and the next key goes to the canvas. Enter again and click the canvas: the frame leaves.
  - **Joint history (H2):** navigate the `/` frame to `/pricing` through its link, then run `history.go(-1)` in the `/probe` frame; the `/` frame's URL is unchanged (or the documented limit per Task 2).
  - **Reporting (H1):** load `/reporting?to=https://127.0.0.1:P/r` in a frame; the TCP observer saw zero bytes after 5 s.
  - **Redirects (S1):** a link to `/go-login` lands on `/login` inside the frame; a link to `/go-out` leaves the frame where it was, counts one blocked, opens nothing externally, and shows the Open in browser toast; Open in browser opens the browser panel with `https://example.com/` in its address bar (S53).
  - **Frame-blocking headers:** `/framed` shows its content.
  - **Cookies (S4):** on `/login`, submit the form; `/api/me` shows "fixture" after a reload of the frame. If this fails, apply D7's fallback (remove the rewrite, document the limit) and assert the documented message instead.
  - **React 19 source (§11 item 5):** post `aiden-app:source-at` for the `<h1>` from the renderer to the `/pricing` iframe and read the reply: `src/Pricing.tsx` and its line (or, after Task 2's fallback, the component `Pricing`).
  - **HMR:** edit `src/Home.tsx`'s text in the temp copy; the `/` frame shows the new text without a reload (its `route` state and the counter survive).
  - **States (B-M9):** Stop from the chip; both frames show their snapshot under "Start app"; pressing it shows "Starting…" and then the frames live again. Kill the dev server process: the frames show the crash sentence and Retry; Retry brings them back.
  - **`[::1]` (S74):** the spec first checks the Space can bind `::1` and fails with a clear message if it can't (no silent skip). Then it starts a second copy of the fixture on `[::1]`, attaches it through Connect, places a frame, and asserts it renders (or, after Task 2's fallback, shows the IPv6 sentence).
  - **Export (E1–E6):** PNG from the `/pricing` frame's menu saves a non-empty PNG of 2 × viewport width (or 1×, per Task 2); PDF saves a PDF. Export `/probe` with a query that makes it, on load, start an attachment download, call `print()`, open a `WebTransport`, `sendBeacon` to `example.com` and request the microphone: the export completes, no Save dialog other than Aiden's own appeared, nothing downloaded, the observers saw zero bytes (E5), and the permission requests were denied (E6). With the app stopped, Download shows "Start the app to download this frame." and no Save dialog.
  - **Service workers (S1):** after the probe's service worker is active, quit, relaunch with the flag **off**, then relaunch with it on and open `/probe`'s origin in a frame: `navigator.serviceWorker.getRegistrations()` is empty.
  - **Browser panel (S53):** opening the design app from Local servers loads it in the panel with the flag on.
  - **Screenshots** in the test's output folder, light and dark at 1440: `design-live-frames`, `design-live-blocked-popover`, `design-live-error-label`, `design-live-start-overlay`, `design-live-starting`, `design-live-crashed`, `design-live-consent`, `design-live-too-many`, `design-live-off`, `design-live-not-in-workspace`, `design-live-open-in-browser`, and the title row truncating at scale 0.1.
- [x] **Step 2: Run in the Space** (results in Build status). `npm run test:e2e:space -- tests/e2e/design-live-frames.spec.ts`. Then the v1 and Live suites **twice**, unchanged: with the flag off (`npm run test:e2e:space -- tests/e2e/design-canvas.spec.ts tests/e2e/design-containment.spec.ts tests/e2e/design-mode.spec.ts tests/e2e/live-app-control.spec.ts tests/e2e/design-app-status.spec.ts tests/e2e/design-app-server.spec.ts`), and with the flag on (`npm run test:e2e:space -- --run env AIDEN_E2E_DESIGN_LIVE_ALL=1 npx playwright test tests/e2e/design-canvas.spec.ts tests/e2e/design-containment.spec.ts tests/e2e/design-mode.spec.ts tests/e2e/live-app-control.spec.ts`). Add the flag-on chat-send smoke run: `npm run test:e2e:space -- --run env AIDEN_E2E_DESIGN_LIVE_ALL=1 npx playwright test tests/e2e/chat-message-queue.spec.ts`. Expected: PASS for all.
- [x] **Step 3: Host (macOS), headless only.** (2026-11-27: `test:gemini-live` passed on the host.) Window-opening tests run only in the Space. Darwin-only behaviour here is the macOS system picker in Gemini Live's display path; Task 4's and Task 7's tests cover the slot headlessly. The window-recreation path (R7) is covered by Task 6's and Task 7's register-and-invoke tests, because closing the last window ends the app on Linux. Run `npm run test:gemini-live` on the host.
- [x] **Step 4:** Commit `test(design): live app frames E2E with observer oracles`.

### Task 15: Docs, memory and spec amendments

**Files:**
- `README.md` (checked only), `PRODUCT.md`, `docs/design-mode.md`, `docs/plans/README.md`, `docs/superpowers/specs/2026-11-23-design-mode-live-app-design.md`, `.memory/design-mode.md`, this plan

- [x] **Step 1: Check registration.** Every new test file was registered in its task (Tasks 2, 3, 4, 5, 6, 7, 9, 10 and 11). Run `npm run test:ci-policy`. Expected: PASS.
- [x] **Step 2: `docs/design-mode.md`.** Rewrite line 31 ("showing the app on the canvas comes with the next phases") to say live frames show the app on the canvas and link the new section. Add a "Live frames" section:
  - placing a route (Aiden places them in 3a; Add ▸ Page from app comes later), entering (double-click or ↩) and leaving (Esc or a click on the canvas), and the overlays for each phase;
  - **localhost only:** what passes (the app's own server and other loopback servers, not Aiden's own ports), what is blocked, the "N blocked" label and its popover, Open in browser;
  - no dialogs, popups, downloads or top navigation; device and other permissions are denied; frames can't take keyboard focus until entered;
  - redirects inside the app work; redirects out are blocked;
  - session cookies in packaged builds (or the known limit, per Task 14), and that a cookie set by another loopback port isn't rewritten;
  - `X-Frame-Options` and `frame-ancestors` are ignored for the app's own pages on the canvas;
  - `[::1]` servers (per Task 2);
  - Download of an app frame as PNG or PDF (frames inside the app draw empty; the app must be running);
  - the app's service workers are cleared when design mode ends for the workspace and at the next start;
  - what isn't covered: WebTransport (HTTP/3 over QUIC, from pages, workers and service workers), WebRTC TURN over TCP, the dev server's own server-side requests (S5), and whatever Task 2 recorded for preconnect and DNS (S71) and joint history (H2);
  - **loopback is broad:** other local services, including a separately run `aiden serve`, are reachable as they would be from the person's browser;
  - **dev only:** in `npm run dev` the renderer (`http://127.0.0.1:4143`) and an app on `127.0.0.1` are the same site, so they may share a renderer process, and a runaway app can freeze Aiden's window. Packaged builds load the renderer from `file://`.
- [x] **Step 3: PRODUCT.md.** Line 69 describes the flagged 2b behaviour and says workspace pages are "served only to the canvas in a sandbox with no network". Add a clause after the flagged dev-server sentence: with the same flag, the canvas shows the running app live in frames that reach only localhost (not Aiden's own ports), with no dialogs, popups, downloads or device permissions, a blocked label listing refused hosts, and PNG or PDF download. Keep the sandbox sentence true for workspace pages.
- [x] **Step 4: Spec.** Add "### Phase 3a amendments (2026-11-24)" with S57–S77 (below), and update the status line at the top to name this plan.
- [x] **Step 5: Plan index.** Extend the design mode v2 row in `docs/plans/README.md` with "Phase 3a (live app frames) planned 2026-11-24, stacked on 2c, plan [p3a](../superpowers/plans/2026-11-24-design-mode-v2-p3a-live-frames.md)". When the PR opens, change it to "Phase 3a (live app frames) built, in review as #NNN".
- [x] **Step 6: Memory.** Add a "v2 Phase 3a: live frames" section to `.memory/design-mode.md`: the files; the two dispatchers and their one-owner rule (AST rule plus runtime setter guard); admission by placement record; the frame registry and the never-evict rule; D3's rules, the cancel cache and the frameless allowlist (and the renderer initiator Task 5 recorded); Aiden's own ports and the drift rule; the permission layer, session events and Live's owner slot; S1; WebTransport and the response headers; the bridge nonce, importer and `escape`; inert; the React 19 outcome; the cookie outcome; Task 2's probe outcomes; the test files and lanes. Update the v2 summary line.
- [x] **Step 7: Stale claims.** Run `rg -n "frame-src|allow-modals|webRequest|will-redirect|will-download|localhost only|blocked|live frame|next phases" README.md PRODUCT.md docs .memory packages/cli/README.md` and fix what 3a made wrong. Expected: README unchanged (flagged, Phase 7 adds the line); `docs/keyboard.md` unchanged (no new shortcut; Esc and ↩ already documented for frames, checked); onboarding unchanged (Phase 7); `host-platform-capabilities.ts` unchanged.
- [x] **Step 8:** Tick this plan's boxes, add "As built" notes (Task 2's probe report, Task 5's audit, the cookie and React outcomes), and commit `docs(design): Phase 3a docs, spec amendments and memory`.

## Spec amendments S57–S77 (Task 15 writes these)

- **S57. Frameless requests use the initiator (3a; amends S3).** Electron 43.8.4's `webRequest` details carry `initiatorOrigin`. A `frame: null` request whose initiator is an app origin, another loopback origin or opaque gets the app rule. One with no initiator and a network scheme to a non-loopback host is cancelled unless it is on the audited frameless allowlist, which starts empty; each such cancel is logged (host only, rate-limited). The renderer's own initiator (as Task 5 recorded it) is untouched, and so are non-network schemes from it or with no initiator. An app, other loopback or opaque initiator gets the app rule for every scheme, so an app's worker can't reach Aiden's own schemes, files or another site's blobs (review fix, 2026-11-27).
- **S58. App frames are tracked by frame tree node (3a; amends §6.3.4).** An admitted main-window subframe stays an app frame for its element's life, even after it navigates to another loopback origin. Its descendants are app context too, as is any main-window subframe on a non-renderer loopback origin and any whose chain doesn't reach the main frame.
- **S59. Aiden's own loopback ports (3a).** App frames can't reach the debugging ports, the renderer dev server or any port an Aiden service or Aiden-spawned daemon listens on (S72 lists them).
- **S60. Permissions are decided by requesting URL (3a; amends S9).** Electron gives permission handlers no frame. The design layer denies every non-main-frame request in the main window that isn't from Aiden's own origin or schemes, every request from an app origin, every request in an app export window, and display and device requests from app context. Gemini Live registers through the dispatcher's owner slot; its handlers are unchanged. The main window answers `select-bluetooth-device` with no device, and the session's HID, serial and USB choosers cancel for app context.
- **S61. Blocked counts and dialogs come from main (3a; amends §6.3.3's `blocked`).** Main counts cancelled requests, blocked redirects and refused navigations per app frame and sends them to the canvas. Sandboxed-dialog counts are read by main from Chromium's console notice; the page can print the same text, so they are display-only. The bridge has no `blocked` message.
- **S62. The app frame box (3a; amends §6.3.1).** `w = round(viewport.width × scale)`; `h = round(viewport.height × scale)` plus the title row; `scale` has 4 decimals. In 3a a corner resize keeps the aspect ratio and changes `scale`.
- **S63. HMR in 3a is Vite's only (3a; S12).** The Vite client is imported only from the frame's own origin. Other frameworks' "save, then the DOM settled" signal lands in Phase 4 with the toasts.
- **S64. React source mapping outcome (3a; §11 item 5).** Task 2's result: `file:line` through `_debugStack` and Vite's inline source maps, or component and owners only.
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
- **S73. App export hardening (3a; extends S13 and S65).** App frames export as PNG or PDF only. The app must be running before the Save dialog opens; the handler answers `app-not-running` or `live-off`. The export window's document is CSP-sandboxed (no downloads, modals, printing or popups), downloads from it are cancelled, and it renders at zoom 1 with 2× through device emulation (or 1×, per Task 2).
- **S74. `[::1]` framing outcome (3a; S52).** Task 2's result: Chromium rejects `http://[::1]:*` as an invalid `frame-src` source and ignores it, so `frame-src` lists only `http://localhost:*` and `http://127.0.0.1:*`, and app frames refuse `[::1]` origins with "This app runs on IPv6 localhost, which the canvas can't show yet. Restart it on 127.0.0.1."
- **S75. Focus and keys (3a; amends §6.3.2).** App iframes are `inert` until entered, so a page can't take focus from Aiden. Esc inside an entered frame reaches the canvas through the bridge's `escape` message; a click on the canvas also leaves. While presenting, app frames stay inert unless entered, and Open full window isn't offered for them. **Decided (2026-11-27):** Task 2's probe 8 showed `inert` alone doesn't hold: a page's repeated `focus()` still pulled focus out of the composer into an `inert` iframe (1 of 20 typed characters landed). So `inert` stays on every app iframe that isn't entered, and while any app frame is mounted one document-level guard listens in capture phase for `focusout` and the window's `blur`. When focus moves into an app iframe that isn't entered, it goes back to the element that lost it, if that element is still connected and focusable; when nothing of Aiden's had focus (the body), the iframe is blurred. The check runs synchronously and once more in a microtask, with no polling and no timers. Entering a frame exempts that iframe until it is left; presenting keeps the guard. The guard is removed with the last app frame and on dispose (`renderer/design/app-frame-focus-guard.ts`).
- **S76. App service workers don't outlive design mode (3a).** Main keeps a device-local list of origins only: every loopback origin (other than the renderer's own) that an app frame loaded a page from, including the other local servers an admitted frame or its subframes navigate to (G5). Their service workers are cleared when design mode ends for the workspace and at every start, flag on or off. An origin that frames of several workspaces reached is cleared only when the last of them ends (or at the next start): a worker is per origin, so an earlier clear would pull it from under a page that is still live. Ownership is asked inside the serialized clear, as each origin's turn comes and again once its clear is done, so a workspace that reaches the origin while an earlier workspace's end is still clearing keeps it too. No page is let onto an origin mid-clear: `designCanvas:appFrameMount` answers only once no clear of the app's origin is queued or running. A page that reaches an origin while its clear runs anyway (a G5 navigation is decided at once, or an admission after the mount answered) may lose the worker to it, so its app frame is reloaded once that clear is done and the page registers the worker again. **Bounded limitation:** from the moment such a clear takes a worker until that reload, the page runs without it, and a reload also follows when the page arrived just after its own clear finished but before the rest of that clear's origins did. Default-port pages are listed as `http://localhost` (no `:80`). An origin leaves the list only once its clear succeeded, and one whose clear failed stays for the next try. 64 is a soft bound: past it, the oldest origins no live workspace owns are evicted, through the same serialized clear as every other (so the ownership check, the mount wait and the reload apply). An owned origin is never evicted, so with every listed origin owned the list grows past 64 until a workspace ends.
- **S77. App frame states follow the app's phase (3a; amends §6.3.2).** Stopped, waiting for consent, installing or starting, crashed (with Retry), running before load (the snapshot stays), attached-lost, too many live frames, live apps off and not in this workspace each have a fixed overlay using 2c's chip labels.

## Verification

Run, in order, each expected to pass:
1. `npx tsx --test renderer/shared/design-canvas/app-frame.test.ts renderer/shared/design-canvas/app-bridge-messages.test.ts renderer/shared/design-canvas/schema.test.ts renderer/design/live-set-core.test.ts`
2. `npx tsx --test main/services/default-session-web-request.test.ts main/services/default-session-permissions.test.ts main/services/loopback-ports.test.ts main/services/design-canvas/app-frames/*.test.ts main/windows/main-window-navigation.test.ts main/windows/main-window-console.test.ts`
3. `npx tsx --test main/services/design-canvas/bridge-source.test.ts main/services/design-canvas/frame-navigation.test.ts main/services/design-canvas/canvas-tools.test.ts main/handlers/design-canvas.test.ts` (existing, unedited except D21's new cases)
4. `npm run test:gemini-live` (Live's existing tests unedited)
5. `npx tsx --test renderer/design/nodes/app-node.test.tsx renderer/design/app-frame-messages.test.tsx scripts/renderer-csp.test.ts`
6. The touched listening services' suites (Task 5), including `app-updater` and `devices`
7. `npm run test:design-mode`
8. `npx tsc --noEmit -p .` and `npx tsc --noEmit -p main/tsconfig.json`
9. `npm run lint`, `node --test scripts/check-aiden-rules.test.mjs` and `npm run check:aiden-rules`
10. `npm run test:ci-policy`
11. `npm run build` (runs the CSP release check on the real renderer build)
12. `npm run cli:build`. A guard: the CLI doesn't bundle `design-canvas/`, but `loopback-ports.ts` is imported by services it may bundle (`aiden-mcp-server.ts`).
13. Cua Space: `npm run test:e2e:space -- tests/e2e/design-live-frames.spec.ts`, then the flag-off and flag-on v1 runs and the flag-on chat-send smoke run from Task 14 Step 2
14. Host, headless: `npm run test:gemini-live`
15. iOS and Android: nothing to run. Check with `rg -n "appFrame|app-frame|kind: \"app\"" ios android` that no client reads canvas documents (design mode is out of the Remote projection).

Then run `npm run test` once before the PR. CI must be green on the exact head. The PR body carries Task 14's screenshots, light and dark, and Task 2's, Task 5's and Task 14's recorded outcomes.

## Risks and edge cases

For reviewers to attack (the anti-goals reviewer takes items 1–9):
1. **A request the dispatcher can't attribute.** Frameless requests with no initiator are cancelled unless allowlisted (D4), and logged. Attack: an Aiden-owned frameless request missed by the audit breaks with the flag on. It's caught by the flag-on E2E runs, the audit and the field log; the fix is an allowlist row, never loosening the rule.
2. **A subframe navigation's `details.frame`.** For a nested iframe's navigation, Electron may give the new child frame or its parent. Both walk up to the registered app frame, so either is covered; Task 2 records which, and A46 proves the app frame's own navigation is attributed to the child.
3. **Sticky membership.** A frame that navigates from an app origin to `http://127.0.0.1:4321` stays filtered (R5). Chromium never reuses `frameTreeNodeId`s, so there is no reset, and live frames are never evicted (S70, R6).
4. **Loopback is broad.** App frames can reach any loopback service except Aiden's own ports, as the app could in the person's browser. Attack: a local service without auth (a database UI, the Docker TCP API on 2375, a separately run `aiden serve`). That is the person's machine and the person's app; §2 decision 3 accepts it, and docs say so. Aiden's own listeners are excluded and guarded against drift (D5). Non-app frames can't reach loopback at all (S67, S69).
5. **Permissions without a frame.** The rule denies every non-Aiden subframe of the main window. Attack: a future feature that frames a third-party page in the main window and needs a permission. It would need its own deny-layer exception and a test; the CSP and the guard already block such frames.
6. **The bridge in the main world.** The page can pre-empt or spoof everything the bridge says. Nothing security-related reads it (S61), outputs are bounded, rate-limited and escaped, injection grants no user activation, and no bridge text reaches the model in 3a.
7. **Redirect handling.** `will-redirect` and `onBeforeRequest` both see redirects. A navigation redirect out is prevented by the guard and cancelled by the filter; a `fetch` redirect out is cancelled at its second hop (R1–R2). `openExternal` is no longer reachable from a subframe redirect (S1).
8. **Gaps by design (S5, S71).** WebTransport, WebRTC TURN over TCP, the dev server's own server-side requests (SSR fetches, proxies), and whatever Task 2 showed for preconnect and DNS aren't covered by `webRequest`. Documented.
9. **Cookies.** The rewrite makes app cookies `SameSite=None; Secure` on loopback in the shared default-session jar. Attack: another localhost page the renderer loads reads them. Only the person's own apps' loopback origins get the rewrite, and §9 already accepts the shared jar.
10. **Shared cookie jar with export.** Export on the default session sees the canvas's cookies, which is S13's intent; zoom is reset per commit so the shared host's zoom doesn't leak (D18).
11. **Electron defaults when composing permissions.** If Electron 43's default for a handler isn't what D8 records, a composed handler could change Aiden's own behaviour with the flag on. Task 4 cites the docs and tests the composed defaults; the flag-on `live-app-control.spec.ts` run exercises dictation and Live.
12. **Vite HMR WebSocket.** Vite 8 serves HMR on the app's own port (A4), and older configs use 24678 (A5). Both are loopback and allowed; 24678 isn't Aiden's.
13. **Next.js on `[::1]` or `0.0.0.0`.** 2b binds `127.0.0.1`; attached `[::1]` servers frame through S52's source or are refused per S74. Wildcard servers can't be attached (2c).
14. **Performance.** One synchronous policy call per default-session request with the flag on. The policy is a few URL parses and set lookups; the frame walk is at most the frame depth; repeated cancels hit the 1 s cache (D3).
15. **Flag off.** Attack whether any path installs a listener, handler or switch with the flag off: Tasks 4, 6, 7, 10 and 13 each have a flag-off test whose fakes record every setter.
16. **Same-site dev renderer.** In `npm run dev` an app on `127.0.0.1` shares a site with the renderer and may share its process. Dev only; documented.

## Open questions

Each has the answer this plan uses (both reviews agreed with these).
1. **Comments and text editing on app frames in 3a?** *No, Phase 4* (S68, which also covers `inspect-at`, `measure-at` and `edit-*`). 3a ships the bridge's pick core so 4 only wires the UI. In 3a, C + click places a frame-level pin. The flag-on v1 runs in Task 14 prove `file` frames' comments and text editing are unchanged.
2. **Strip `X-Frame-Options` and `frame-ancestors`?** *Yes, for the app's own responses in app frames only* (D7, S66). A non-app frame's `X-Frame-Options` is kept (Task 5 row).
3. **If the cookie rewrite fails in `file://` builds?** *Document the known limit* and don't add a proxy in 3a (S4's fallback). Keep the E2E's assertion switch.
4. **Allow every loopback port, or only the app's own origins, for subresources?** *Every loopback port except Aiden's own* (§6.3.4, D5), with the own-ports set complete and guarded against drift (S72).
5. **What goes on the frameless allowlist?** *It starts empty and gains only what Task 5's Space audit observes*, each with an owner and a test, plus field diagnostics for every frameless cancel. N8 stays fail-closed.
6. **Read-only workspaces?** *Frames show their snapshot with the `no-access` sentence and no Start button*, as 2c refuses starts there.
7. **An `aiden-rules` check for the one-owner rule?** *Yes*: `default-session-owner` in Task 4, covering `session.defaultSession`, `fromPartition("")` and `webContents.session`, with the acceptance launch allowlisted, plus the runtime setter guard for what an AST can't see.
8. **Deny permissions to every non-Aiden subframe, or only app origins?** *Every non-Aiden subframe of the main window* (D8). Electron gives no frame, so matching by origin alone would miss a nested `about:srcdoc` or a frame that navigated to another loopback origin. The flag-on E2E runs catch any Aiden-owned `about:blank` helper frame this would break.

## Applied review decisions

Review A is the anti-goals-only review, review B the full review. "Same as" marks an overlap where the decisions note chose one fix.

| Finding | Decision | Task and step |
|---|---|---|
| A-B1 WebTransport skips `webRequest` | Loopback-only `connect-src` and `X-DNS-Prefetch-Control: off` on app responses; probe in the Space; record leaks in S71 (D7, S71). **Amended after the probe:** no switch stops WebTransport, so it is a documented gap (main session's decision, 2026-11-24) | Task 2 Step 5 (probe 1, 2) and Step 6; Task 5 Step 2 (`appResponseHeaders`); Task 14 Step 1 (E5's beacon) |
| A-B2 Registry eviction and reset drop a live frame | Never evict a live id; prune by `framesInSubtree`; refuse when full; no reset (D2, S70) | Task 5 Step 2 (600-remount test, cap test); Task 6 Step 2 (G17); Task 11 Step 1 (too-many-frames state) |
| A-M1 Any direct child can navigate to loopback | Admission by placement record, expected origin, fresh direct child, main-frame initiator; v1 pin first; loopback refused for every other frame in both flag states (D2, D9, D11, S67, S69) | Task 5 Step 2 (admission); Task 6 Steps 1–2 (G7–G16, G24); Task 7 Step 1 (`designCanvas:appFrameMount`) |
| A-M2 Install order and window recreation | Claims and subscribers installed in `whenReady` before the first window; window getter; per-window wiring; fail closed before install (D6) | Task 4 Step 3; Task 6 Step 2 (second window, G22); Task 7 Step 1 (R7); Task 10 Step 1 (recreated window) |
| A-M3 Export window can download and print | CSP `sandbox` on the export main frame; default-session `will-download` cancel; dialogs and popups blocked (D7, D8, D18, S73) | Task 4 Steps 1, 3 (download slot); Task 5 Step 2 (sandbox header); Task 7 Step 1 (download cancel); Task 13 Step 1; Task 14 Step 1 (E3–E6) |
| A-M4 Focus theft from the composer | `inert` until entered; present keeps it (D16, S75) | Task 2 Step 5 (probe 8); Task 11 Step 1 (inert, present); Task 14 Step 1 (K1) |
| A-M5 `frame === null` fails open | Refuse loopback, `https:` and unknown-scheme targets with `frame: null`, both flag states; refuse in `will-redirect` too (D9) | Task 6 Steps 1–2 (G12, G13, G20) |
| A-M6 Own-ports list incomplete | Device hub proxy, local device host, spawned and reused daemons, updater proxy via `getFeedURL()`, debugging ports from the switches; drift rule (D5, S72) | Task 5 Steps 2, 4 (service cases, `loopback-listen-registered`); Task 7 Step 1 (debugging ports) |
| A-M7 E2E can't show nothing left | Observer listeners with zero-byte assertions; test-only `--host-resolver-rules` to a non-loopback observer; recorder hook for attribution; custom-scheme hit counter (D6, Task 14) | Task 2 Step 5 (probes 3, 4); Task 7 Step 3 (recorder); Task 14 Step 1 |
| A-m1 `allow` list misses non-`'self'` features | Add picture-in-picture, fullscreen, window-management, local-fonts, idle-detection, storage-access, web-share, otp-credentials, identity-credentials-get, publickey-credentials-create, direct-sockets, autoplay (D16) | Task 11 Step 1 (token set); Task 14 Step 1 (P1, P2) |
| A-m2 Reporting and NEL uploads | Strip `Report-To`, `NEL`, `Reporting-Endpoints` from app-context responses (D7) | Task 2 Step 5 (probe 11); Task 5 Step 2; Task 14 Step 1 (H1) |
| A-m3 Page-driven floods | `navigation-refused` coalesced 1/s per frame, latest wins; captures 1 per 2 s; bridge messages 60/s per frame (D12, D16) | Task 11 Step 1 (rate-limit and toast cases) |
| A-m4 `[aiden-live]` forwarder accepts any frame | Main-frame only, moved into `main-window-console.ts`; dialog counts called forgeable (D10, S61) | Task 7 Step 1 (console cases) |
| A-m5 Bridge hardening | Vite client only from the frame's own origin; `executeJavaScript(code, false)`; expression returns `undefined`, no page thenable awaited (D12, D13) | Task 9 Step 2 (value, hmr cases); Task 10 Step 1 (`userGesture false`, thenable) |
| A-m6 Owner slot identity and rule aliases | `ownerSlot` returns the same object per name; the AST rule covers `webContents.session` aliases; runtime setter guard in non-packaged builds (D8) | Task 4 Steps 1, 3 |
| A-m7 D2 and D9 contradicted each other | One admission rule (D2) used by the guard (D9) | Task 5 Step 2; Task 6 Step 2 |
| A-m8 Service workers outlive design mode | Cleared on `forgetWorkspace` and at every start via a device-local origin list; background-sync permissions denied with every other app-context permission (Electron names none) (D8, S76) | Task 2 Step 5 (probe 10); Task 7 Step 1 (`app-sw-origins`); Task 14 Step 1 (S1) |
| A-m9 Present and full window unspecified | Inert while presenting unless entered; no `single` for app frames (D16, S75) | Task 11 Step 1 (present case) |
| A-m10 Dev renderer same-site as apps | Documented, dev only (Risk 16) | Task 15 Step 2 |
| A-m11 Export details | Refuse `source` and the Code tab; check running before the Save dialog; resolve by `workspaceId` and `appRoot` (D18) | Task 13 Step 1 |
| A-m12 Joint session history | Probe; assert or document (D3b H2) | Task 2 Step 5 (probe 7), Step 6; Task 14 Step 1 (H2); Task 15 Step 2 |
| A-m13 Idempotent box recompute | Integer `w`/`h`, `scale` to 4 decimals, `designMinSize("app") = 10`, fixed-point test (D15, S62) | Task 3 Step 1 |
| A-m14 Main-thread amplification | 1 s cancel-only cache; load test (D3) | Task 5 Step 2 |
| A-m15 `parent === null` roots | Fail closed: a main-window non-main frame whose chain doesn't reach the main frame is app context (D2, A45) | Task 5 Step 2 |
| A-m16 Renderer initiator serialization | Audit records it; stop and amend D4 if `"null"`; genui keepalive cancels accepted (D4) | Task 5 Step 1 |
| A-m17 App iframes carry `data-frame-id` | `data-app-frame-id` only; comments check the kind; C + click is a frame-level pin (D16) | Task 11 Step 1 |
| A rows W1, W2 | D3b | Task 2 Step 5; Task 14 Step 1 |
| A rows A31–A34 | D3 | Task 5 Step 2; Task 14 Step 1 (A32) |
| A rows A35–A44 | D3 | Task 5 Step 2; Task 14 Step 1 |
| A row A45 | D3 | Task 5 Step 2 |
| A row A46 | D3; the recorder proves the child attribution on an allowed navigation, and the unit row cancels the external one (see note 3 below) | Task 7 Step 3; Task 14 Step 1 |
| A rows H1, H2, S1, P1, P2, K1, D1, D2, E3–E6 | D3b | As listed in D3b's "Where" column |
| A rows G9–G13 | D9 guard table (G9–G13, with G11 per the admission decision, see note 2) | Task 6 Steps 1–2 |
| A rows R6, R7 | D3 | Task 5 Step 2 (R6); Task 7 Step 1 (R7) |
| B-B1 Registry evicts a live frame | Same as A-B2, plus the loopback-origin backstop (A47) | Task 5 Step 2 |
| B-B2 Existing frames reach loopback with the flag on | Same as A-M1; guard rows for genui, file and unknown frames in both flag states | Task 6 Steps 1–2 (G9, G10, G11, G14) |
| B-M1 `isDesignPrintable("app")` contradicts D15/D17 | Leave it unchanged; `designExportFormats(app) = ["png", "pdf"]` (D15, D21) | Task 3 Step 1 |
| B-M2 One-owner rule has no task | `default-session-owner` in `check:aiden-rules` with the acceptance allowlist and alias coverage (Q7) | Task 4 Steps 1, 3, 5 |
| B-M3 Own-ports list, drift guard | Same as A-M6 | Task 5 Steps 2, 4 |
| B-M4 "It failed" isn't evidence | Same as A-M7; frameless rows assert on the observer, no blocked count | Task 14 Step 1 |
| B-M5 Transports beyond HTTP and WebSocket | Same as A-B1; EventSource and preconnect rows (A37, A40) | Task 2 Step 5; Task 14 Step 1 |
| B-M6 Export window Save dialog | Same as A-M3 | Task 4; Task 7; Task 13; Task 14 |
| B-M7 Fixture not detected as Vite | `devDependencies`, no lockfile, `cacheDir` inside the copy | Task 1 Steps 1–2 |
| B-M8 v1 regressions not run with the flag on | v1 and Live specs run flag off and flag on; flag-on chat-send smoke | Task 14 Step 2 |
| B-M9 No state for consent, installing, starting, crashed, loading | Phase table with 2c's chip and Retry; screenshots light and dark (D16, S77) | Task 11 Step 1; Task 14 Step 1 (states, screenshots) |
| B-M10 `[::1]` framing unchecked | Probe plus an E2E case; amendment S74 and a refusal sentence if dropped | Task 2 Step 5 (probe 6), Step 6; Task 14 Step 1 |
| B-M11 PRODUCT.md and design-mode.md stale | Update both | Task 15 Steps 2–3 |
| B-M12 Export path misnamed, codes missing | Retarget to `designCanvas:export`; `app-not-running`, `live-off`; register-and-invoke tests (D18, D21) | Task 11 Step 3 (toast copy); Task 13 Step 1 |
| B-m1 Export zoom leaks host-wide | Zoom 1 per commit, 2× via device emulation (D18) | Task 2 Step 5 (probe 9); Task 13 Step 1 |
| B-m2 Refused redirect sends no event | `will-redirect` sends `navigation-refused` for the app frame (D9, G2) | Task 6 Step 2 |
| B-m3 Gemini Live slot details | Export the type; idempotent slot; options forwarded; macOS picker note; `getDisplayMedia` probe (D8) | Task 4 Steps 1, 3; Task 14 Step 1 (P2) |
| B-m4 Device choosers untested | Routed through `onSelectDevice`; tests (D8) | Task 4 Step 1; Task 7 Step 1 |
| B-m5 Test lanes | Dispatcher, permission and console tests also in `test:gemini-live`; happy-dom suites in `renderer-other` | Task 2 Step 7; Task 4 Step 4; Task 7 Step 4; Task 9 Step 5 |
| B-m6 Scratch script location, audit on host | Scratch scripts untracked in the worktree; audit scripted in the Space; record what couldn't be exercised | Task 2 Steps 4–5; Task 5 Step 1 |
| B-m7 Renderer dev origin | Excluded explicitly; tests with the dev origin (D3, D8) | Task 5 Step 2 (A28, N10); Task 6 Step 1 (G21); Task 7 Step 1 |
| B-m8 Dialog counts forgeable | Said so in D10 and S61 | Task 15 Step 4 (S61) |
| B-m9 Bridge scope wording | S68 covers `inspect-at`, `measure-at`, `edit-*`; Phase 4 re-adds them | Task 15 Step 4 (S68) |
| B-m10 Esc to leave | `escape` bridge message; canvas click leaves (D12, D16, S75) | Task 9 Step 2; Task 11 Step 1; Task 14 Step 1 |
| B-m11 C + click on an app frame | Frame-level pin, no element (D16) | Task 11 Step 1 |
| B-m12 Error label not accessible | Button + Popover (D16) | Task 11 Step 1 |
| B-m13 Resize keeps aspect ratio | Aspect lock writes `scale`; truncation screenshot (D15, D16) | Task 3 Step 1; Task 11 Step 1; Task 12 Step 1; Task 14 Step 1 |
| B-m14 Cookie rewrite scope | Documented (D7) | Task 15 Step 2 |
| B-m15 Log frameless cancels | Diagnostics, host only, rate-limited (D4) | Task 7 Step 1 |
| B-m16 D19 citation | §8 row 3b cited (D19) | — (plan text) |
| B-m17 Plans README wording | "built, in review as #NNN" when the PR opens | Task 15 Step 5 |
| B-m18 Screenshots incomplete | Error label, starting, crashed, consent, too many, live off, not in workspace, light and dark | Task 14 Step 1 |
| Open questions 1–8 | B's answers, A agreeing | "Open questions" above |

**Notes where the applied fix differs from a review's literal suggestion.**
1. **A-m8, background-sync permissions.** Electron 43's permission typings have no background-sync, periodic-sync or background-fetch name, so there is nothing to deny by name. The design layer already denies every check and request from app context (`unknown` included); Task 2's probe 10 records whether Chromium asks at all. The decided fix (clear service workers when design mode ends) is applied, and a device-local origin list extends it to every start, so row S1 (flag turned off, then restart) holds.
2. **A-G11.** Review A expected a renderer-created child heading for a non-app loopback origin to be "registered as app context". The admission decision supersedes that: without a placement record for that exact origin, it is refused (G8, G11).
3. **A-A46.** Review A proposed a debug hook that disables the guard so the frame's own external navigation reaches the filter. The plan adds no guard-disabling switch, even test-only. The recorder proves the frame's own navigation is attributed to the child (on an allowed navigation), and the unit table proves that attribution gives `cancel` for an external target.
4. **A-M6, owner-pid backstop.** Review A suggested it as an optional extra. It isn't adopted: `onBeforeRequest` is synchronous and the pid lookup asynchronous (D5). The updater proxy's port is learned from `autoUpdater.getFeedURL()`, so nothing needs documenting as unlearnable; the short window before `update-downloaded` exposes only a Basic-auth-protected endpoint.
5. **A-M1, initiator check.** Kept as an extra admission condition beside the decided placement record (stricter fix). Task 2's probe 5 records what Electron reports for an `src`-set navigation; if it is `null`, admission accepts `null` but never another frame.
6. **A-B1/B-M5, DNS prefetch.** `main/index.ts:264` already sets `blink-settings=dnsPrefetchingEnabled=false` app-wide; the plan keeps it and adds `X-DNS-Prefetch-Control: off` as decided.

## As built

Recorded as the build goes. Task 15 adds Task 5's audit, the cookie outcome and the final notes.

### Deviations

1. **`fitAppScale`.** `renderer/shared/design-canvas/app-frame.ts` lowers an app frame's `scale` (rounded down to 4 decimals) so its box stays within the canvas's 8000 maximum frame size, after D15's box rule. Without it the generic size clamp would move a recomputed box and break the parse fixed point (Task 3).
2. **`DESIGN_FRAME_HEADER_PX` moved** into `renderer/shared/design-canvas/app-frame.ts`, so the shared box rule can use it; `renderer/design/nodes/design-node-context.ts` re-exports it (Task 3).
3. **Side panel naming.** The side panel calls the `app` kind "App page", with the `AppWindow` icon (Task 3).
4. **aiden-rules allowlist.** `scripts/aiden-rules-allowlist.json` has a `default-session-owner` entry for `main/services/gemini-live/display-capture-acceptance.ts` (its own launch mode), as Task 4 planned (Task 4).
5. **WebTransport is a documented gap, with no switch** (main session's decision, 2026-11-24, after probe 1). S71 is rewritten with the probe table; `designLiveSwitches` and its test are dropped from Task 7; W1, W2 and E5's WebTransport part are "documented gap (S71)" and Task 14 asserts nothing about them; the docs name WebTransport next to TURN over TCP and server-side requests.
6. **Port registration helpers.** Services register through `registerListeningPort(server)` (reads the bound port after `listen`, returns an idempotent removal) and the updater through `registerLoopbackUrlPort(() => autoUpdater.getFeedURL())`, both in `loopback-ports.ts`, rather than calling `aidenLoopbackPorts.add` directly. The `loopback-listen-registered` rule accepts any of the three. The updater reads `autoUpdater` through `main/platform.ts` (newly exported there) so its simulated-service tests keep mocking Electron, and only on `darwin` (Task 5).
7. **Hub port lifetime.** The device hub's reserved port is held from just before spawn until that child exits or is killed (a supervised restart releases the old port and holds the new one); the agent daemon's port is held from the moment its `daemon.json` is read (new or reused and healthy) until `stopAgent`. An unhealthy leftover is never registered (Task 5).
8. **Allowlisted listeners.** `loopback-listen-registered` allowlists `rfb-fake-server.ts`, `mcp-oauth-test-server.ts`, `openrouter-recording-test-support.ts` and `peer-pairing-test-host.ts` (test-only), `app-server/app-ports.ts` (2b's free-port probe) and `gemini-live/display-capture-acceptance.ts` (its own launch mode). `devices/ssh-device-script.ts`' `listen` is inside a script string, so the AST rule never sees it and it needs no entry; `local-device-host.ts`' `reservePort` probe passes because the module registers the hub port (Task 5).
9. **`frame-src` without `[::1]`.** Probe 6 showed Chromium rejects `http://[::1]:*` as an invalid `frame-src` source and ignores it, so Task 8 adds only `http://localhost:*` and `http://127.0.0.1:*`, and the release check accepts exactly those two. `[::1]` app origins get the S74 refusal sentence instead (Task 8, Task 11).
10. **`assertFrameSrc`, fail-closed.** The release check reads a page's effective frame sources (`frame-src`, else `child-src`, else `default-src`), and every page may list only `'self'`, `'none'`, `aiden-*:` schemes and `http://localhost` or `http://127.0.0.1` sources. This is stricter than D11's "no `http:`, `https:`, `*` or non-loopback host": `data:`, `blob:` and `https://*.example.com` are rejected too. `main-window.html`'s `frame-src`, when declared, must be exactly the five sources in any order. A main window with no `frame-src` is accepted, because `default-src` then decides and it is narrower; that also keeps the existing `renderer-csp.test.ts` cases unedited (Task 8).
11. **Bridge messages, fail-closed (Task 9).**
   - `postToAppPage(target, origin, command)` takes the frame's app origin and posts to it rather than to `"*"`. If the iframe has navigated to another origin, nothing is delivered. It refuses an origin that isn't a loopback `http:` app origin.
   - `parseAppBridgeMessage(data, origin)` takes the message event's origin and drops anything that isn't a loopback `http:` origin with a port.
   - A `source` line without a path is dropped, and a bad path drops both. A path without a line is kept, because the walk legitimately gives one when the source map can't be read.
   - A bad `error.at` is dropped, and the error itself is kept.
   - `route` paths must start with `/`.
   - The shared core is a script fragment: the embedding bridge declares `host`, `doc`, `PREFIX` and `send`, then calls `handleCore(type, data)`.
12. **`canvas_place_frame {kind: "app"}` details (Task 12).**
    - The `apps` dep is `{ snapshot(workspaceId) }`, an async read of `designAppServers.snapshot`. The roots come from its apps, candidates and chosen roots, and `canvas_read` reads `live` from the same snapshot (phase `running`).
    - A reused frame takes the new title. It changes only the viewport sides and scale that are given (not null); the rest stay the frame's own, and the scale is refit and the box recomputed from the merged values (review fix M6).
    - App placement runs the shared look fields: `guide` applies, and `dark`, `tweaks`, `paper` and `printMode` give the existing kind errors.
    - `nextTo`, `groupId`, `page`, `x` and `y` work as for other kinds.
    - `colorScheme` exists on `canvas_update_frame` only with live apps on; on a frame of another kind it gives "Only a live app frame has a colorScheme."
    - Two behaviours apply in both flag states, since neither touches a tool definition: the aspect-locked resize (width decides the scale, else height) and the `canvas_inspect` refusal for app frames. With the flag off, a stored app frame still resizes correctly and isn't inspected.
    - The D19 "no `report` call" test is left out. The canvas tools take no analytics dependency, so the test would assert something the code can't do (a tautology the test rules forbid).

13. **Export of live app frames (Task 13).**
    - The plan's single `app-export.ts` is split. `app-export-core.ts` holds the decisions: the window options, the 1× pixel size, the navigation guard, the export-window registration with its timeout, the quiet-network wait and the dark script. They are tested without Electron in `app-export-core.test.ts`, not in `design-canvas.test.ts`, because they are a service's decisions, not the handler's. `app-export.ts` is the production-only window, like `frame-render.ts`.
    - PNGs are 1× (`APP_EXPORT_DEVICE_SCALE = 1`, per probe 9), not `deviceScaleFactor: 2`.
    - "Settled" means no request started for 500 ms, capped at 15 s, with the whole render limited to 30 s. To measure it, the registry keeps a last-request stamp per export window, which `onBeforeRequest` sets and removal clears. This is the only new registry state.
    - The export window allows one main-frame load, on the app's own origin. Redirects may stay on that origin only. The page can't navigate or open windows, and frames inside the app draw empty (S65). `markLoaded` closes the window to any further load.
    - The order of checks is: flag off → `live-off`; no renderer, a bad format or no viewport → `unavailable`; app not running in the chat's workspace → `app-not-running`. All three come before the Save dialog. `saveFile` is called only after they pass, and the file is written only after the render succeeds.
    - The renderer toast text for the two new errors is added now ("Start the app to download this frame." and "Live apps are off."), not in Task 11, so the widened result type never reaches an unmapped error.
    - The default session keeps zoom per host. In development the app's host (`localhost`) can also be the main window's, so zoom 1 is set on every commit and the render is held inside `designFrameZoomGate` (the same gate `frame-render.ts` uses).
    - The E3 download cancel for export windows was already covered by `app-network-main.test.ts` and is unchanged.

14. **Task 14 and 15 as far as Task 11 allows (2026-11-27).**
    - The `AIDEN_E2E_DESIGN_LIVE_ALL=1` switch lives in `tests/e2e/fixtures.ts`, where the launch environment is built, not in `design-mode-helpers.ts`. A test's own environment is spread after it, so a test can still set the flag itself.
    - `AppNode`'s static card now says "Not live on the canvas yet" with the flag on and "Live apps are off" only with it off. Task 12 lets Aiden place app frames with the flag on, so the old sentence would have been false. `AppFrameBody` is split out, and `app-node.test.tsx` starts with those two cases; Task 11 extends it.
    - `tests/e2e/design-live-frames.spec.ts`, its observers and the screenshots waited for Task 11, because without the live node there is no app iframe to drive. They landed after it (deviation 17). The flag-off and flag-on v1 runs and the flag-on chat-send smoke run ran (see Build status).
    - The docs describe what is built: app frames that Aiden places, the static card, and Download. The "Live frames" docs section from Task 15 Step 2 (entering, overlays, blocked label, cookies, the dev-only process note) lands with Task 11.
    - `docs/pi-gui-artifacts.md` gave the main window's `frame-src` from before design mode; it was corrected.

15. **The live app node (Task 11, 2026-11-27).**
    - **S75's guard.** `renderer/design/app-frame-focus-guard.ts`: each mounted `AppFrame` holds the document's guard (`holdAppFrameFocusGuard`). The first holder installs a capture `focusout` listener on the document and a capture `blur` listener on the window, and the last one removes them. When the active element becomes an app iframe without `data-app-frame-entered`, focus goes back to the element that lost it, if it is connected, not inert, not disabled and not the body; otherwise the iframe is blurred. The check runs at once (Chromium's order, probe 8) and again in a microtask (engines, including happy-dom, that move focus after `focusout`).
    - Its tests are in `app-node.test.tsx`: "a page that pulls focus into a not-entered app frame gives it straight back to the composer", "with nothing of Aiden's focused, a page that takes focus is blurred back to the body", "an entered app frame keeps the focus the person gave it" and "the focus guard goes away with the last app frame". The first, second and fourth failed with the guard switched off.
    - The iframe carries `data-app-frame-id` (never `data-frame-id`, so v1's page listeners skip it) and `data-app-frame-entered` while entered. `design-comments.tsx` also ignores messages from frames whose kind isn't `file`; `app-frame-messages.test.tsx` checks that an app page's `aiden-design:ready` gets no `locate`.
    - Resizing an app frame goes through `appResizeScale` (moved with `APP_DEFAULT_VIEWPORT` to `renderer/shared/design-canvas/app-frame.ts`) in `canvas-adapter-core.ts`, so the width decides the scale unless only the height moved.
    - The context gains `leave(id)` (clears `entered` and focuses `.studio-canvas`) and `openInBrowser(url)` (the browser panel's `open_link`). Enter on a selected app frame enters it. Presenting fits app frames with the header offset, and the presenting CSS hides their header.
    - The leave-by-pane-click case is tested in Task 14 only: React Flow reads pane clicks through its pointer path, which happy-dom doesn't synthesize, so the unit test covers the bridge's `escape` and the canvas's Esc instead.
16. **Review fixes (review-p3a-1, 2026-11-27).** Every finding was real, and each fix started from a failing test.
    - B1: frameless requests from an app, other loopback or opaque initiator get the app rule for every scheme (new D3 row N12; S57 amended).
    - B2: `select-serial-port` is `(event, portList, webContents, callback)` in Electron 43 (`electron.d.ts:12729`). The dispatcher wires it that way and gives subscribers `{frame: null, webContents}`.
    - M1: display media and HID/USB choosers fail closed without a frame. Frames are judged by their own ancestors, so Quick Chat, the pill and bot bubbles aren't treated as the main window.
    - M2: `designCanvas:appFrameMount` needs design mode on (`canFrame`) before and after it awaits the app's origin.
    - M3: export checks the running app's origin again after the Save dialog.
    - M4: the export window cancels `select-bluetooth-device`.
    - M5: the cancel cache doesn't cache `blob:` or `about:`.
    - M6: see deviation 12.
    - m1: an error's `at` skips dependency and other-origin stack frames.
    - m2: the bridge injects at every `dom-ready` of a frame, not only the first.
    - m3: a download whose frame is gone is judged by `item.getInitiatorOrigin()`.
    - m4: `APP_CONNECT_SRC` names no `[::1]` source.

17. **Task 14's live-frames spec (2026-11-27), and two escalations.**
    - **What it covers.**
      - Two routes and `/framed` render live and inert.
      - Enter, press, Esc and leave work, with the canvas getting focus back.
      - A redirect inside the app goes to `/login`, and Esc still leaves from the new page.
      - Download offers PNG and PDF but not the original file, and the PNG is 1280 px wide.
      - Present shows one frame a slide, and the frame stays inert.
      - Stopping the app shows Start app; Start brings the frames back.
      - With the flag off after a relaunch, the frames say "Live apps are off" and nothing is framed.
      - The probe:
        - A control fetch reaches the mapped observer.
        - In the page, these fail: fetch to external, LAN, 127.0.0.2 and https loopback; `img`; ws, wss and EventSource; the custom schemes; redirects to an own port, evil and out; `getUserMedia` (`NotAllowedError`); `getDisplayMedia`; geolocation; PiP; fullscreen; clipboard.
        - `window.open` gives null, `confirm` returns at once, Notification is `denied`, and the beacon is queued.
        - The main window keeps its `file:` URL, and `shell.openExternal` is never called (it's recorded).
        - The TCP observers on 127.0.0.1 and 127.0.0.2 and the external observer see zero.
        - The blocked label counts at least 5, and its popover shows the hosts, the localhost sentence and the dialogs line.
        - Pressing `mailto:` opens nothing.
    - **Changes from Step 1.**
      - Frames are placed at `scale: 0.25` so a fitted canvas stays at or above the live zoom floor.
      - `mailto:` has its own probe button, because a refused one leaves the frame on a blocked page.
      - The UDP observer is a target only: WebTransport leaks (S71), so nothing is asserted about it.
      - Rows not automated yet: attribution (A46), joint history (H2), reporting (H1), cookies (S4), React source, HMR, crash and Retry, `[::1]`, PDF and probe export (E1–E6), service-worker relaunch, the browser panel (S53), frameless beacons, and the consent, starting, crashed, too-many, not-in-workspace and truncation screenshots.
    - **K1 escalated.** Space probes (Electron 43.8.4) showed the S75 guard can't keep the keys.
      - A cross-process app frame takes focus in two steps: the composer's `focusout` fires with the body active, then the window's `blur` with the iframe active. The guard now answers the second step (it remembers what lost focus for 250 ms) and puts `document.activeElement` back on the composer.
      - Chromium still keeps the app frame focused, so keys routed the way a keyboard's are (CDP `Input.dispatchKeyEvent`, the same as Playwright's keys) go to the page.
      - Every same-task variant lost 20 of 20 keys: `focus`, blur then focus, `window.focus`, blurring the iframe, hiding it.
      - A `setTimeout(0)` or rAF restore lost 1 to 4 of 20.
      - `--enable-blink-features=BlockingFocusWithoutUserActivation` with `allow="focus-without-user-activation 'none'"` on the iframe lost 0 of 20. Without the switch, the `allow` token does nothing.
      - Probe 8 and the first K1 run used Electron's `sendInputEvent`. It delivers only to the main frame's widget, for keys and for mouse (a click on an app frame never reaches its page), so it couldn't show this.
      - The K1 test was `live.fixme` with the real routing. Choosing between the Blink switch (app-wide), a timer guard that still leaks, or a documented limit was a decision for the owner, made in deviation 18.
    - **S1/D1 escalated.** The main window's CSP `frame-src` refuses a navigation or redirect out of an app frame before `will-frame-navigate` or `will-redirect` runs.
      - The dev log shows `ERR_BLOCKED_BY_CSP` with `isMainFrame: false` for `/go-out` → `https://example.com/` and for `mailto:`.
      - The frame lands on Chromium's blocked page. There's no "*host* is outside the app" toast, no Open in browser and no blocked count, but nothing leaves Aiden.
      - The S1 test was `live.fixme`. A fix (for example, answering `did-fail-provisional-load` for app frames with the refusal and reloading the last in-app URL) needed a decision, made in deviation 18.
    - The `design-live-open-in-browser` screenshot waited for S1.

18. **The K1 and S1 decisions, and review-p3a-2 (2026-11-27).**
    - **K1: the Blink switch, with the guard kept.**
      - `main/index.ts` appends `BlockingFocusWithoutUserActivation` to `--enable-blink-features` at startup, before ready, only while `AIDEN_EXPERIMENTAL_DESIGN_LIVE` is on (`app-frame-switches.ts`). It keeps any features already named.
      - App iframes deny `focus-without-user-activation` in their `allow` list, so a page's own `focus()` does nothing until the person activates the frame. The switch is process-wide, but it only affects frames whose policy denies the feature, and Aiden's own windows don't.
      - Probe numbers: same-task restores lost 20 of 20 keys, a timer restore 1 to 4 of 20, and the switch with the `allow` token 0 of 20. Probe 8 had used `sendInputEvent`, which reaches only the main frame, so it couldn't see the leak.
      - The S75 guard stays as defence in depth.
      - The K1 E2E runs again (no `fixme`) and is the canary for a Chromium upgrade that drops the feature. It waits 5.5 s after its last check inside the frame before typing. Playwright runs frame checks as a user gesture (`callFunctionOn` with `userGesture`), and Chromium's transient activation lasts 5 s: an in-frame diagnostic showed `navigator.userActivation.isActive` true right after one.
      - Aiden's own focus calls (composer autofocus, focus after IPC-driven opens) are in its own frames, which the policy doesn't touch. The flag-on v1 and chat-send suites cover them.
    - **S1/D1: recover from the CSP block.**
      - When an admitted app frame's load fails with `ERR_BLOCKED_BY_CSP` (`did-fail-provisional-load`, found with `webFrameMain.fromId`), main refuses it like a redirect: the blocked count goes up and the host is listed. An http or https target (`validatedURL`) gets the "*host* is outside the app" toast with Open in browser; `mailto:` and other schemes get no toast (D1). Main then sends `navigation-restore` to that mount.
      - The renderer puts the iframe back on the last in-app path its page reported, or the frame's route.
      - Open in browser still opens only on the person's press, in the browser panel. The probe's "`shell.openExternal` is never called" assertion holds.
      - Other load failures, other frames and the flag off are left alone.
      - The S1 E2E runs again and takes the `design-live-open-in-browser` screenshots.
    - **review-p3a-2.** Gemini's second review (`3e1311fc6..b1f9592de`) confirmed 11 of the first review's fixes and found M1–M4 and m1–m6. All ten were verified, and each was fixed test-first:
      - M1: `frameIsApp` fails closed when the ancestor walk ends before a root (more than 64 frames), as the registry's walk does.
      - M2: a frame whose app stopped while it was live forgets the iframe it showed, so leaving the live set can't remount it with a used token.
      - M3: entering holds only for the page on screen when the person entered. If that page goes (the app stopped, restarted or moved), or the frame was entered with no page, the frame is left, and the next page mounts inert. Double-click enters only a live, framed page. In Present, stepping and a click on the canvas leave an entered frame; Open full window's single frame stays entered.
      - M4: a picture that falls due after the page has gone is dropped.
      - m1: a new mount's blocked label doesn't carry the last mount's dialogs.
      - m2: the header's status row gives way before the actions, so a quarter-scale frame keeps Dark and Download in reach (checked in the S1 E2E).
      - m3: the focus guard is held only while a frame shows a page, and a released guard ignores a second look it had queued.
      - m4: a Dark press before the page has loaded reaches it at load.
      - m5: app frames draw their layout guide.
      - m6: double-clicking the blocked or error label doesn't enter the frame.

19. **review-p3a-3 (2026-11-27).** Gemini's third review (`b1f9592de..e95acb97a`) found K1 clean and all ten review-p3a-2 fixes holding. It found three more, all verified and fixed test-first:
    - M1: putting a frame back is bounded. A restore that leads straight out again, with no `ready` or route from the page in between, drops the last path and falls back to the frame's route. A third way out within 3 s stops the reloads. The frame then shows "This page leads outside the app." with **Reload**, which goes to the route. Each blocked load is still counted once, and the toast keeps its one id. Ways out spaced further apart are each put back.
    - m1: leaving a frame moves focus to the canvas only when focus was in that frame (its iframe or the body). A frame that leaves by itself, because its app stopped or restarted, doesn't take focus from the composer or a panel.
    - m2: an app frame's own `data:` or `blob:` page, which the window's `frame-src` refuses, is counted with no toast and put back. Only what `frame-src` allows (`about:blank`, `about:srcdoc`, loopback `http:` outside Aiden's ports, where a block means the page's own `frame-ancestors`) is left alone.

20. **review-p3a-4 (2026-11-27).** Gemini's fourth review, which included a full-phase security skim, found no blockers. It found three more, all verified and fixed test-first:
    - **M1: the restore bound can't be gamed by timing or page messages.** Deviation 19's 3-in-3 s window let a loop slower than 1.5 s run forever, and a page could post `route` or `ready` to skip the path fallback. The new bound is per mount, on an injectable monotonic clock (`performance.now()`), and never reads bridge messages.
      - A frame nobody has entered is put back once. It can't be clicked, so its next way out is the page's own, and it stops however long after.
      - An entered frame is put back up to 3 times. It gets them back after the person stays in it 10 s with no way out, when they enter it afresh, or when they press Reload.
      - The restore after one to a path other than the route always goes to the route.
    - **m1: stuck frames and the Reload button.**
      - A stuck frame is left: it goes inert behind its card and can't be entered.
      - Enter or Space on a focused button (Reload, a frame's actions, any `button`, link or pressable role) is the button's. `StudioCanvas` no longer takes it as the canvas's Enter, which kept the button from being pressed. Nodes are `role="group"`, so selecting a frame and pressing Return still enters it.
      - `reload()` clears the stuck flag synchronously.
    - **m2: the frame guard frames only the `frame-src` hosts.** `[::1]` is counted and put back, with no toast, as a loopback page isn't outside the app. The list now lives in `renderer/shared/design-canvas/main-window-frame-src.json`. The guard derives its hosts from it, and `verify-renderer-csp.mjs` (which holds `main-window.html` to it exactly) and `renderer-csp.test.ts` read it.

21. **PR #965 Pullfrog review (2026-11-27).** One P1 and three P2s, all verified and fixed test-first:
    - **P1: every page an app frame reaches is remembered, not only the admitted origin.** G5 lets an admitted frame or its subframes load pages from other loopback servers, and any of them can register a service worker. `app-network-main.ts` now remembers the origin of every `mainFrame` or `subFrame` load in registered or backstop context that isn't the renderer's own. It files it under the workspace of the frame's admitted app (`AppFrameRegistry.admittedOrigin`), so `forgetWorkspace` clears it with the rest. XHR and other subresources aren't remembered, since a worker needs a document.
    - **P2 (twice): the list forgets an origin only once its clear succeeded.** `remember` past 64 origins clears the evicted ones first and keeps any whose clear failed. `clear` keeps the failed ones for the next start or workspace end, so nothing is forgotten with its worker still registered.
    - **P2: an app frame is written only where its root was checked.** `placeAppFrame` checks the root against the chat's workspace before awaiting the apps snapshot. `edit()` then looked the workspace up again, so a chat moved in between had the frame written into the other workspace's canvas. `edit()` now takes the workspace the change was checked in and refuses with "This chat moved to another workspace while the frame was being placed. Place it again." when the chat's workspace is no longer that one.

22. **PR #965 Pullfrog re-review (2026-11-27).** Two more S76 gaps, both verified and fixed test-first:
    - **An origin two workspaces share.** Each workspace's set named the same persisted record, so ending the first cleared the shared server's worker under the second's live page and removed its record. `forgetWorkspace` now clears only origins no other live workspace still owns. A shared origin keeps its worker and its record until its last owner ends, or the next start.
    - **Default-port pages.** `new URL(...).origin` drops `:80`, and the list's pattern required a port, so a port-80 page's worker was never recorded. The pattern now takes the port as optional.

23. **PR #965 Pullfrog re-review 2 (2026-11-27).** A teardown race, verified and fixed test-first. Deviation 22's ownership check ran before the queued clear. If a second workspace reached the same origin while that clear waited on file or session I/O, its worker was still removed. `AppServiceWorkerOrigins.clear` now takes a `keep` check, which `forgetWorkspace` passes as live ownership. It is asked inside the queue, right before each origin's `clearStorageData`, and again after it. An origin kept by either check is left uncleared, or kept listed, for its new owner's end.

24. **PR #965 Pullfrog re-review 3 (2026-11-27).** Deviation 23's second `keep` check ran only after `clearStorageData` returned. It could keep the record, but not the worker of a page that claimed the origin while that clear was running. A clear already under way can't be undone, so this is closed by construction, test-first:
    - **No page goes live mid-clear.** `AppServiceWorkerOrigins.whenCleared(origin)` reports the clears of an origin that are queued or running, and whether one cleared it. `designCanvas:appFrameMount` waits on it through `appFrames.clearSettled`, before recording the placement or answering the origin, so the iframe loads only after the clear.
    - **Pages that reached the origin mid-clear are reloaded.** A G5 navigation, or an admission after the mount answered, can still land during a clear. `rememberPage` takes the registered frame it came from, and admissions now pass their `frameTreeNodeId`. When a clear covering that origin was pending and actually cleared it, main reloads that frame once (`WebFrameMain.reload()`) after the clear, so the page registers the worker again. The queued `remember` lists the origin again, now under its new owner. A frame whose claim came before the origin's turn isn't cleared, so it isn't reloaded.
    - **The remaining window** is bounded and documented in S76: between that clear and the reload, the page runs without its worker.

25. **PR #965 Pullfrog re-review 4 (2026-11-27).** Cap eviction in `remember()` called `clearEach` directly. It skipped the clear queue, `whenCleared`, `keep` and the reload, so past 64 origins a live page's worker could be evicted. Verified and fixed test-first:
    - `remember(origin, keep)` writes the new origin and picks the evicted origins: the oldest that `keep` doesn't claim, never the one just added. It hands them to `clear(evicted, keep)`, so an eviction is a clear like any other.
    - `app-network-main.ts` passes live workspace ownership as `keep`.
    - The 64 bound is now soft. With every origin owned, the list grows, and it shrinks again as workspaces end.

26. **Focus-guard flake (#966 CI run 46054292686, 2026-11-27).** `app-node.test.tsx`'s Chromium-order test failed once in CI, on attempt 1. Root cause: `AppFrame` held the S75 focus guard in a passive `useEffect`, which runs a task after the commit that puts the iframe in the DOM. Testing Library's `waitFor` resolves from its mutation observer at that commit, so under load the composer's `focusout` could fire before the guard existed and go unremembered. The window blur then blurred the iframe to the body. A page could hit the same gap in the app: focus taken in the task between the commit and the effect would go unanswered. The guard is now held in a `useLayoutEffect`, so it is up in the same commit. A new test catches the iframe at insertion with a mutation observer. It failed every run before the fix and passes after. Under full CPU load, the original test failed 4 of 40 runs before the fix and 0 of 80 after.

### Build status (2026-11-27)

Built: Tasks 0–15. Task 11 was unblocked by the S75 decision (deviation 15), and Task 14's live-frames spec runs (deviation 17). K1 and S1/D1 were decided and built, and review-p3a-2's findings are fixed (deviation 18). **Open:** Task 5's frameless audit. The allowlist is empty, and it is checked against real traffic once live frames can load.

E2E in the Cua Space after the K1 and S1 decisions and review-p3a-2 (2026-11-27, Space `aiden-p3a-3`, built first):
- `design-live-frames.spec.ts`: 4 passed, K1 and S1 included, twice (once in the combined run, once alone for the screenshots).
- **Flag off**, the six suites: 30 passed.
- **Flag on** (`AIDEN_E2E_DESIGN_LIVE_ALL=1`), the four v1 and Live suites with the `chat-message-queue` chat-send smoke run: 37 passed.
- No flakes, no retries.

E2E in the Cua Space after Task 11 and the review fixes (2026-11-27, head `cd19cc0fc`):
- `design-live-frames.spec.ts`: 2 passed, 2 skipped (K1, S1), with no retries needed on the final run.
- **Flag off**, the six suites: 30 passed.
- **Flag on** (`AIDEN_E2E_DESIGN_LIVE_ALL=1`, built first), the four v1 and Live suites: 17 passed.
- The flag-on `chat-message-queue` chat-send smoke run: 20 passed.
- No flakes.

Earlier, before Task 11 (Linux Space, 2026-11-27, host load averages 250–600):
- **Flag off**, all six suites the plan names: 27 passed, 1 flaky and 2 failed. The two failures were `design-containment.spec.ts`'s observers. Its `onBeforeRequest` hit the unpackaged setter stub (D6). The spec now subscribes through the dispatcher, which E2E launches expose with `AIDEN_E2E_WEB_REQUEST_OBSERVER=1` in unpackaged builds only. Its assertions are unchanged, and the rerun passed 2 of 2. The flaky test was `design-canvas.spec.ts:242`: it timed out at `framePositions` after a reload, then passed on retry.
- **Flag on** (`AIDEN_E2E_DESIGN_LIVE_ALL=1`): the v1 suites, Live, and the `chat-message-queue` chat-send smoke run. 34 passed and 3 failed: `chat-message-queue.spec.ts:447`, where a request was missing after 10 s; `chat-message-queue.spec.ts:636`, where onboarding timed out; and `design-canvas.spec.ts:1617`, which timed out on the rename poll. Retries are off in `--run` mode. Rerun with `--repeat-each=2`, flag off and flag on, all three passed 6 of 6 both ways. These were load flakes, not caused by the flag.
- The plan's flag-on commands don't build: `--run` skips the guest's build step. The runs used `--run bash -c "npm run build && AIDEN_E2E_DESIGN_LIVE_ALL=1 npx playwright test …"`.

### Task 2 probe outcomes (Linux Space, Electron 43.8.4)

| Probe | Outcome | Effect |
|---|---|---|
| 1. WebTransport | Leaks in every mode tried (no switch, `--disable-blink-features=WebTransport`, `--disable-features=WebTransport`, `--disable-quic`, CSP `connect-src`, CSP + `--disable-quic`), from the page, a dedicated worker and a service worker; `webRequest` never sees it and CSP raises no violation | Documented gap (S71), deviation 5 |
| 2a. Preconnect | `<link rel=preconnect href="https://127.0.0.1:P">` from an app frame opened **no** TCP connection at the observer | A40 asserted as zero in Task 14 |
| 5. Initiator | `will-frame-navigate`'s `initiator` for an `src`-set navigation is the **main frame** | D2 holds as written; admission never needs to accept `null` |
| 4. Attribution | An app frame's own navigation reaches `onBeforeRequest` with `details.frame` = the frame's own `frameTreeNodeId` and `resourceType: "subFrame"` | A46 holds |
| 10. Background sync | The permission **check** handler is consulted with `background-sync` when the service worker registers a sync | The design layer denies it (it denies every app-context check); S76 stays the guarantee |
| 6. `[::1]` in `frame-src` | **Corrected 2026-11-27.** Chromium rejects the source: "The source list for the Content Security Policy directive 'frame-src' contains an invalid source: 'http://[::1]:*'. It will be ignored." The `[::1]` frame fails with `ERR_BLOCKED_BY_CSP` (its `load` event fires on the error page, which is what the earlier row misread as framing; its document has no content) | S74 fallback: app frames refuse `[::1]` origins with "This app runs on IPv6 localhost, which the canvas can't show yet. Restart it on 127.0.0.1." (Task 11), and Task 8 leaves `http://[::1]:*` out of `frame-src` (deviation 9) |
| 2b. DNS prefetch | Neither `<link rel=dns-prefetch>` host (with or without `X-DNS-Prefetch-Control: off`) appears anywhere in the net log, under the app-wide `blink-settings=dnsPrefetchingEnabled=false` | No DNS gap to document; the header stays as defence in depth |
| 3. Custom schemes | `onBeforeRequest` sees `<img>`, `<script>` and `<link rel=stylesheet>` loads of a `standard`/`secure`, `supportFetchAPI: false` scheme from the app frame (`details.frame` = the frame, resource types `image`, `script`, `stylesheet`); cancelling them leaves the handler's hit counter at 0 (the control load from the main frame hit it once) | A22–A24 and A35 hold; no escalation |
| 7. Joint session history | After sibling A navigated, `history.go(-1)` in sibling B left A where it was (and B and the parent too) | H2 holds and is asserted in Task 14 |
| 8. Inert | **Fails.** With `inert` on the iframe, the page's `setInterval(() => input.focus(), 50)` still pulls focus out of the parent's textarea: of 20 typed characters 1 reached the textarea, and the iframe was `document.activeElement` after every one (the child's input got none). Guards on the iframe's `focus` event or a capturing `focusin` never fire. A parent-side guard on the composer's `blur` that refocuses it when `document.activeElement` is the (not entered) iframe kept all 20 characters in the textarea (about 42 guard runs) | **Escalated** (Step 6): S75 needs another mechanism before Task 11. Task 11 is not started |
| 9. Export scale | `capturePage` under `enableDeviceEmulation({deviceScaleFactor: 2})` at zoom 1 returns the same 1× pixels as without it (400 × 273 both), though the page's `devicePixelRatio` reads 2 | S73 records PNG at 1×; Task 13 asks for `deviceScaleFactor: 1` |
| 11. Reporting | No report upload reached either observer in 60 s, with the reporting headers stripped **or** unstripped (the control) | Inconclusive: the probe can't show the strip matters. The strip stays as defence in depth, and Task 14's H1 zero-bytes assertion stands |
| React 19 (Step 4) | On the fixture's `/pricing` under Vite 8.3.5 and React 19, the walk on the `<h1>` gives component `Pricing`, owners `["App"]`, `src/Pricing.tsx` and line 13 (the `<h1>`'s real line) through `_debugStack` and Vite's inline source map; the fiber has no `_debugSource` | S64: `file:line` mapping holds; no D14 fallback |

Environment note: in the Cua Space (gVisor), Chromium's seccomp-sandboxed renderer crashes (`exitCode 11`, "seccomp-bpf failure in syscall nr=0x7b", `sched_getaffinity`) as soon as a Vite + React page runs. The React check ran with `--disable-seccomp-filter-sandbox` on the probe's own Electron command line. Task 14's Space runs that render the fixture will need the same test-only switch; product code never sets it.
