# Design mode v2 — Phase 3b: routes and skill — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Revision 3 (2026-11-27).** This revision applies review-p3b-plan-2, which confirmed revision 2's 14 fixes and raised 2 Majors and 4 Minors. All six were verified and accepted:
> - the analytics task now sits right after Task 4, as Task 5, with old Tasks 5–8 renumbered 6–9;
> - `entry.fallbackRoute`, the `DesignChatView` placement view and the `:561` guard are added;
> - the skills type is fixed, and `withDesignModeSection` takes `designMdOn || liveAppsOn`;
> - the analytics test is split into two cases;
> - the convention-folder rules are made consistent, with `ENOENT` skipped.

> **Revision 2 (2026-11-27).** This revision applies review-p3b-plan, which found 2 Blockers, 9 Majors and 3 Minors. All 14 were checked against `20e263fe1` and accepted. Each is mapped to its decision, task and test in "Applied review decisions" at the end.

**Goal:** Aiden and the person can put any page of the workspace's real web app on the canvas by route, and Aiden designs in the app itself: a route file it writes lands on the chat's page as a live app frame, and the prompt and the `aiden-design` skill teach the live-app workflow. All of this is behind `AIDEN_EXPERIMENTAL_DESIGN_LIVE`.

- **Route discovery.** `discoverRoutes` reads the routes of Next.js, TanStack, React Router v7 and Remix, and Astro apps from their files, without running TypeScript. `.aiden/canvas.json` can list `routes` and give values to dynamic segments (`params`) (§6.3.6).
- **Add ▸ Page from app…** A dialog lists the app's routes with a filter. A dynamic route takes a value, and a route can also be typed. The page is placed as the person's own undo step.
- **Route-aware placement (§6.3.7).** A route file Aiden writes or edits lands once per route on the turn's page, and is focused. Writing a component places nothing. Entering design mode on an empty chat page places the routes the chat wrote, up to 12, or else the app's `/`.
- **The rest of §6.5's tool changes.**
  - `canvas_place_frame {kind: "app"}` gains `device`, `variantOf` and `label`.
  - `canvas_update_frame` gains `route`, the viewport (`width`, `height`, `device`) on top of 3a's `colorScheme`.
  - `canvas_read` reports each app frame's blocked count.
  - `design_app` gains a read-only `routes` action.
- **The live-app prompt and skill (§6.5).** These are written for live apps. The v1 `design/*.html` mockup path stays as the fallback for workspaces with no web app until 3d (S6).
- **The event `design_app_frame_added {source, device_bucket}`** (§6.10).

With the flag off, every prompt, skill, tool definition, menu and placement is byte-for-byte today's (D1).

**Architecture:**
- **Route rules (`main/services/design-canvas/app-server/`).**
  - `app-routes-core.ts` (new, pure) maps a framework's route file to a route pattern in one canonical syntax. It parses the two generated or config files the spec names, `routeTree.gen.ts` and `app/routes.ts`, with an O(n) tokenizer and a depth-capped reader (never by running them), merges canvas.json's lists, and fills dynamic segments.
  - `app-routes.ts` (new) is the bounded, no-follow disk walker that feeds it, following S23's split between pure rules and disk reads.
  - `canvas-config.ts` parses `routes` and `params`.
  - `DesignAppServers.routes()` joins discovery and the config for one app root, with a short per-workspace cache.
- **Canvas tools (`main/services/design-canvas/canvas-tools.ts`).** The new parameters, the device presets from a shared module, the `onAppFrameAdded` dependency, and a `blockedFor` getter backed by 3a's `AppFrameRegistry`.
- **Placement (`main/services/design-canvas/written-pages.ts`, `entry.ts`).** Route files join the written-pages pipeline through a second path classifier. The canvas document gains `removedAppRoutes`, which works like `removedPagePaths`, so a route the person took off the canvas isn't put back.
- **IPC (`main/handlers/design-canvas.ts`).** Two channels, `designCanvas:appRoutes` and `designCanvas:placeAppRoute`. They follow `designCanvas:placeArtifact`'s person-placement pattern: main decides the box, the page and the dedupe, and broadcasts its own undo step.
- **Renderer (`renderer/design/`).** The Add menu's **Page from app…** item and its `AppRoutePicker` dialog.
- **Prompt and skill.**
  - `designModePromptSection(true)` and the new `aidenDesignSkill(live)` give the live text; flag off returns today's objects.
  - `skill-registry-main.ts` picks the skill with `designLiveEnabled()`.

**Tech Stack:** Electron 43.8.4, React 19, TypeScript, TypeBox tool schemas over pi-agent-core's `AgentTool`, `tsx --test`, happy-dom with Testing Library, and Playwright Electron E2E in a Cua Space.

**Spec:** [`docs/superpowers/specs/2026-11-23-design-mode-live-app-design.md`](../specs/2026-11-23-design-mode-live-app-design.md). The relevant parts:
- §6.3.6 (routes and canvas.json), §6.3.7 (route-aware placement) and §6.5 (Aiden's tools, where work lands, and the prompt and skill);
- §6.10, which defines the event;
- §8's 3b row;
- the S-decisions S1–S77, of which S6, S18, S33–S44 (S38 above all), S68 and S75 bear on this phase.

**Stacking:** 3b stacks on `t3/design-mode-v2-p3a` (PR #965), which stacks on 2c, 2b, DM, 2a, 1b and 1a. Its new decisions start at **S78**, because the spec's last is S77.

## Scope

**In 3b:**
1. `discoverRoutes(workspaceRoot, appRoot, framework)` for the spec's five conventions (S80), with bounded reads (S78) and one pattern syntax (S79).
2. `.aiden/canvas.json` `apps[].routes` and `apps[].params` (S81), and `design_app {action: "routes"}` (S82).
3. Add ▸ **Page from app…** with an app picker, a filter, values for dynamic routes and a typed route (S87).
4. Route-aware placement of written and edited route files, and entry placement of the chat's route files or `/` (S83).
5. "Where Aiden's work lands": S18's order for every placement, and §6.5's text rewritten to match (S84).
6. The remaining §6.5 tool changes (S85).
7. The live-app prompt and skill (S86).
8. `design_app_frame_added` (S88).
9. E2E with a route fixture, screenshots, and docs.

**Not in 3b:**
- The device menu, ⌘D, the device-frame chrome and Fit-to-device. These are 3c's (§6.3.8). 3b only adds the shared preset table and the `device` parameter the tools accept.
- Mock apps (`mock: true`), the React mock-app scaffolding and the v1 mockup removal. These are 3d's (S6). The v1 `design/*.html` text stays in the live prompt as the fallback.
- `design_inspect`, element comments, Inspect, text edits and `data-aiden-comment` source mapping on app frames. These are Phase 4's (S68). The skill's JSX `data-aiden-comment` bullet waits for Phase 4 (S86).
- Error frames, and bridge-reported errors in `canvas_read`. These are Phase 4's (S85).
- Adopt and live directions. These are Phase 5's, so the skill says "ask which to keep" (S86).
- Onboarding. Everything stays behind the flag until Phase 7.
- Running TypeScript, a bundler or the framework's CLI to learn routes (S78).

## Feature flag

Everything sits behind `designLiveEnabled()` (`main/services/studio/feature-flags.ts:37`) and, in the renderer, `useAppCapabilities().designLive` (used at `renderer/design/nodes/app-node.tsx:395`).

With the flag off:
- the system prompt is `DESIGN_MODE_PROMPT_SECTION` unchanged;
- the skill is today's `AIDEN_DESIGN_SKILL` object;
- every tool definition deep-equals today's;
- the Add menu has Group, File… and Image…;
- the two IPC channels answer `{error: "unavailable"}`;
- no route file places anything;
- no event is sent.

## What exists today (checked against 3a's head `03e03fe73`)

| Area | Fact | Evidence |
|---|---|---|
| Flag | `designLiveEnabled()` | `main/services/studio/feature-flags.ts:37` |
| Prompt | `DESIGN_MODE_PROMPT_SECTION` is v1 HTML text: "Screens and pages you design are workspace HTML files under design/…" and "Work on the page the person is looking at, which starts as this chat's own page…" | `main/services/design-canvas/canvas-tools.ts:233-251` |
| Prompt | `designModePromptSection(designLive)` returns today's section, plus `DESIGN_MD_PROMPT_BULLET` when the flag is on; it is static per flag (S34) | `canvas-tools.ts:254-260` |
| Prompt | llm-client builds the system prompt with `designModePromptSection(designMdOn)` | `main/services/llm-client.ts:3212` |
| Skill | `AIDEN_DESIGN_SKILL` is a frozen v1 object: design/tokens.css, tweaks and `data-aiden-src`; `AIDEN_DESIGN_SKILL_ID = "builtin:aiden-design"` | `main/services/design-canvas/skill.ts` (57 lines) |
| Skill | It is registered by `designModeEnabled()` only, with no live flag | `main/services/skill-registry-main.ts:21-23` |
| Skill tests | These check that the tools the skill and prompt name are offered, that `designModePromptSection(false) === DESIGN_MODE_PROMPT_SECTION`, that the libraries are served, and that on-demand tools come with load_tools | `main/services/design-canvas/skill.test.ts` |
| Tool | `kind: "app"` is placed only when `appsOn = deps.designLive === true && deps.apps !== undefined` | `canvas-tools.ts:134-138`, `:929` |
| Tool | `DesignCanvasToolDeps.apps` is `{snapshot(workspaceId) → {apps, candidates, chosen}}` | `canvas-tools.ts:320-335` |
| Tool | `placeAppFrame`: the root comes from the snapshot, and the error lists the roots; the page is `pageOf(doc, p.page, view.pageId)`; dedupe is on the same appRoot and route on the page; a reused frame merges only the sides given; it returns `{status:"placed", placed:"new"\|"copy"\|"reused", frame}` | `canvas-tools.ts:1115-1218` |
| Tool | `appViewportSide`, `appScale` and `appRoute` | `canvas-tools.ts:904-927` |
| Tool | `withAppLiveness` adds `live` to `canvas_read`'s app frames | `canvas-tools.ts:1222-1229` |
| Tool | `canvas_update_frame` takes `colorScheme` only with `appsOn`, and refuses it on non-app frames; an app resize keeps the aspect ratio and changes `scale`. There is no `route` or viewport | `canvas-tools.ts:1527`, `:1596`, `:1661` |
| Tool | `canvas_inspect` refuses app frames | `canvas-tools.ts:2150` |
| Summary | `summarizeFrame` gives app frames `appRoot`, `route`, `viewport`, `scale` and `colorScheme` | `renderer/shared/design-canvas/canvas-summary.ts:369-377` |
| Schema | `label` and `variantOf` on frames are parsed and kept, but nothing writes them | `renderer/shared/design-canvas/schema.ts:136-139`, `:663-665` |
| Schema | `removedPagePaths` (limit 200) is maintained by `withRemovedPagePaths(before, after, byPerson, undone)`: `save` notes the person's removals, and `update` only forgets | `schema.ts:247`, `:270`, `:472`, `:503-515`; `main/services/design-canvas/store.ts:180`, `:214` |
| App frame | `isAppRoute` (`/`-rooted; no `//`, `\`, `#` or hidden characters; ≤ 2 048 characters), `appRouteFrom`, `isAppRoot`, `fitAppScale`, `appResizeScale`, `APP_DEFAULT_VIEWPORT` 1280 × 800, `DESIGN_FRAME_HEADER_PX = 36` | `renderer/shared/design-canvas/app-frame.ts:67`, `:79`, `:87`, `:131` |
| Placement | `isAutoPlacedPagePath` covers `design/*.html` only; `writtenPagePath(toolName, details)` uses `parseProducedFile` | `main/services/design-canvas/written-pages.ts` (~:152) |
| Placement | `placeWrittenPagesOnCanvas({chatId, workspaceRoot, paths, store, pages, broadcast, newId, entry?, limit?, …})` returns `{frameIds, pageId?, focusId?}`; `EARLIER_PAGES_LIMIT = 12`; `RecentWrittenPages` and `pagesWrittenInChat(messages)` | `written-pages.ts` |
| Placement | After a completed `write_file`/`edit_file`, llm-client calls `writtenPagePath`; `placeWrittenPage` notes it in `recentWrittenPages`, places it and focuses it; `createDesignPageScanner` scans commands' output for design/ only | `llm-client.ts:3226-3312`, `:6346-6348`, `:6828-6830` |
| Produced files | `parseProducedFile` accepts write_file ("written") and edit_file ("edited") for any safe relative path | `renderer/shared/produced-file.ts` |
| Entry | `createDesignEntry` places `recent.merged(chat.id, pagesWrittenInChat(chat.messages))` with `limit: EARLIER_PAGES_LIMIT`; `setDesignMode` calls it | `main/services/design-canvas/entry.ts`; `main/services/chat-application-service.ts:423`; wiring at `chat-application-service-main.ts:61` |
| Config | `CanvasConfigApp = {root; script?; designMd?; url?; urlRefused?}` (no `routes`, `params` or `mock`); `parseApps` handles at most 32 apps; reads are no-follow and capped at 64 KiB; `saveCanvasConfigApp` merges `script` and keeps unknown fields | `main/services/design-canvas/canvas-config.ts` (239 lines) |
| Config | `.aiden/canvas.json` isn't a protected path (only `.aiden/hooks.json` and `hooks/` are), so `write_file` can write it | `main/services/protected-agent-config-paths.ts:25` |
| Consent | The attach record is `{origin, configUrl, workspaceReal}` and the launch fingerprint leaves canvas.json out, so editing `routes` or `params` asks for nothing again | `main/services/design-canvas/app-server/app-records.ts:188`, `app-server-main.ts:1043` |
| Detection | `FRAMEWORKS` lists next, react-router (`@react-router/dev`), remix (`@remix-run/dev`), remix-3, tanstack-start, nuxt, angular, astro, gatsby, create-react-app, tanstack-router (`@tanstack/router-plugin`, labelled Vite) and vite | `main/services/design-canvas/app-server/app-server-core.ts:83-103` |
| Detection | `readBounded(filePath, cap, {head?})` | `app-detect.ts:53` |
| Servers | `snapshot(workspaceId)` runs `detectFor` (detection plus a config read) on every call | `app-server-main.ts:362-369`, `:1504-1509` |
| Servers | `DesignAppsSnapshot {target, apps, candidates (appRoot, framework, frameworkLabel, script, name), chosen}`; `DesignAppStatus.framework?` | `renderer/shared/design-app.ts:83-131` |
| `design_app` | `ACTIONS = ["status","start","stop","restart","logs","choose"]`; starts per turn are capped at 4; errors come back as `{status:"error", message}` | `main/services/design-canvas/app-server/app-tool.ts:31-45`, `:207-330` |
| Registry | `AppFrameRegistry` keeps blocked totals per `frameTreeNodeId`; `frameInfo(id) → {frameId, mountToken}`; main reaches it as `installedAppNetwork()?.registry` | `main/services/design-canvas/app-frames/app-frame-registry.ts:243`; `main/handlers/design-canvas-main.ts:72` |
| Person placement | `designCanvas:placeArtifact`: `designTurnPages` picks the page; `createdBy: "person"`; dedupe answers `already`; it broadcasts with `step: "send-to-canvas:<revision>"` | `main/handlers/design-canvas.ts:461-532`, `:546` (`canFrame`) |
| Handler deps | `appFrames.apps` is `{snapshot, appForOrigin}`, already wired from `designAppServers` | `main/handlers/design-canvas.ts:344-354`; `design-canvas-main.ts:69-75` |
| Renderer IPC | `designCanvas:placeArtifact` is invoked through `renderer/lib/ipc.ts:2872`; the preload passes it through generically | `renderer/lib/ipc.ts:2872` |
| Add menu | `DesignAddKind = "note"\|"group"\|"file"\|"image"`; the DropdownMenu has Group, File… and Image… | `renderer/design/design-toolbar.tsx:45`, `:172-185` |
| Canvas | `add(frame)` places through `change()`; `pick` uses `pickDesignFile`; `onAdd`; `canAddFiles={grant !== null}` | `renderer/design/design-canvas.tsx:579`, `:668`, `:758`, `:1393` |
| Apps hook | `useDesignAppsSnapshot(chatId, enabled)` | `renderer/design/design-app-chip.tsx:89` |
| Analytics | Design events live at `analytics-events.ts:87-99`, with `design_app_started` reported from `main/services/design-canvas/main.ts:337`; tests at `analytics-feature-reports.test.ts:252-300`; docs rows at `docs/analytics.md:50-56` | as listed |
| E2E | `tests/e2e/design-live-frames.spec.ts`: `seedFixture` copies `tests/fixtures/design-live-app` and links `node_modules`; `openLiveChat` presses Allow on the Run card; `placeFrames` uses `aiden.lmStudio.enqueueToolScenario`; `AIDEN_E2E_DESIGN_LIVE_ALL=1` is in `tests/e2e/fixtures.ts` (3a deviation 14) | as listed |
| Root deps | `node_modules` has `@tanstack/react-router` and `router-core`, but not `@tanstack/router-plugin`, next, astro or `@react-router/*`. `typescript` is a dev dependency only | `package.json` |

## Decisions

All are **proposed**. They become spec amendments S78–S88 in Task 15. Each follows the spec unless it says otherwise.

### S78 — Route discovery reads files and never runs code (proposed)

`discoverRoutes` lives in two files, following S23's split:
- **`app-routes-core.ts` (pure).** Holds the conventions, the file-to-pattern rules, two text parsers, the merge with canvas.json, and `fillRoute`.
- **`app-routes.ts` (disk).** A walker that follows **no** links, matching `app-detect.ts`, `canvas-config.ts` and `app-fingerprint.ts` (review B2):
  - **The root is confined before any read.**
    - `realWorkspace = realpath(workspaceRoot)`.
    - Every segment of `appRoot` (its parents included) is `lstat`ed. A symlink or a non-directory there ends discovery with `null`, and so does an app root whose realpath is outside the workspace.
    - Each fixed convention folder on the way down (`src`, `app`, `pages`, `routes`) is `lstat`ed too, and is handled on its own (m2-4):
      - a missing one (`ENOENT`) is skipped, because a Next app may have `app/` and no `pages/`;
      - a symlink or a non-directory is also **skipped**, so that convention gives no routes, and the others are still read.
      - Only the app root's own path gives `null`.
    - `realpath(<workspace>/<appRoot>)` must be inside `realWorkspace` (`isPathInside`).
  - **Inside the walk.** Every `Dirent` that `isSymbolicLink()` is skipped, whether a file or a folder. Nothing is read through a link, even one that points back inside the root.
  - **The two parsed files** (`src/routeTree.gen.ts`, `app/routes.ts`) are read with `readBounded` at their real path. Its `O_NOFOLLOW | O_NONBLOCK` turns a symlinked file into `null`, which means fallback.
  - It skips `node_modules` and every hidden folder (`.next`, `.git`, `.output`).
  - It stops at depth 10, 2 000 directory entries in total, or 500 routes, and reads at most 256 KiB of a parsed file.
- A hit cap returns what it has with `truncated: true`.
- **Rationale.**
  - The spec's list is file conventions plus "simple literal configs only".
  - Loading `routes.ts` or `routeTree.gen.ts` would execute the person's code in main, and `typescript` isn't a runtime dependency.
  - The two generated or literal shapes are read by a small single-pass tokenizer and a recursive-descent reader (M8.4).
    - The tokenizer is O(n). It skips comments and string and template literals properly, and yields identifiers, strings and punctuation.
    - The reader descends at most 16 levels of `prefix`/`layout` nesting.
    - Any unexpected token returns `null`, which means fallback (S80).
    - There are no regular expressions over the file text, so there is no backtracking risk.

### S79 — One pattern syntax: Next's brackets (proposed)

Every discovered pattern is written with `[name]` for one segment, `[...name]` for a catch-all and `[[...name]]` for an optional catch-all.
- TanStack `$id` becomes `[id]`.
- Remix and React Router `$slug` become `[slug]`, and a bare `$` becomes `[...splat]`.
- Astro's `[slug]` and `[...slug]` are already in this form.
- Optional segments (Remix `(lang)`, Next `[[...x]]`) are listed once, as the pattern.

**Rationale.** The spec's canvas.json example keys `params` by `"/blog/[slug]"`, so one syntax across frameworks lets a `params` key match whatever discovery found. The UI and the tool show the same string.

A pattern is a **route** only once every bracket is filled. `isAppRoute` rejects nothing in a pattern, so the place paths check "no `[` left" themselves (`isConcreteRoute`).

### S80 — Which conventions are read (proposed)

| Framework ids (2a) | Convention | Notes |
|---|---|---|
| `next` | `app/**/page.{tsx,jsx,ts,js,mdx}` and `pages/**/*.{tsx,jsx,ts,js,mdx}`, each also under `src/` | Route groups `(x)` are dropped. `@slot` parallel routes, `_private` folders and `(.)` intercepting routes are skipped. `pages/_app`, `_document`, `_error`, `404`, `500` and `pages/api/**` are skipped. `index` becomes the folder. |
| `tanstack-start`, `tanstack-router` | `src/routeTree.gen.ts` when present: the keys of `interface FileRoutesByFullPath { … }`. Otherwise `src/routes/**`, using flat dots, `index`, `$param`, `_pathless` and `(group)` | `__root.tsx` and `-ignored` files are never pages. A layout (a file with child routes, or a folder's `route.tsx` with children) is dropped only by the whole-tree `routesFromFiles`. |
| `react-router` | `app/routes.ts` when it is a literal array of `index()`, `route()`, `layout()` and `prefix()` calls with string literals. Otherwise the flat `app/routes/**` convention | One spread (`...flatRoutes()`) means flat routes. Any other code means unsupported, and the list is then `/` only, with `fallback: "config"`. |
| `remix` | Flat `app/routes/**`: dots become `/`, `_index` is the index, `$` becomes a param, `_` prefixes are pathless, trailing `_` is dropped, `[.]` is an escaped dot, and `route.tsx` folders count | as React Router's flat routes. |
| `astro` | `src/pages/**/*.{astro,md,mdx,html}` | `.ts` and `.js` endpoints and `_`-prefixed files are skipped. |
| every other id, and none | none | The list is `/` plus canvas.json's. |

**Single-file and whole-tree rules (M8.3).**
- `routeFromFile(convention, relPath)` answers for one path without seeing its siblings. It is used for written files (S83), and it maps a layout file to its own route, so editing `posts.tsx` may place `/posts`. That is harmless, because `/posts` is a real route that renders the layout.
- `routesFromFiles(convention, relPaths)` sees the whole tree. It drops layouts that have child or index routes, and keeps a leaf folder's `route.tsx`. Discovery uses it.

Remix 3 (`remix-3`) has no file convention yet, so it gets the fallback. The table cites the frameworks' public conventions. Task 1's fixtures are copied from each framework's documented examples, so the rules are checked against a source independent of the code.

### S81 — canvas.json `routes` and `params` (proposed; revised for M8, m1)

- **`routes`.**
  - An array of at most 200 strings, each passing `isAppRoute` or `isRoutePattern`.
  - A bad entry is dropped **silently**, as `parseApps` drops bad fields today (`canvas-config.ts:71-87` has no issues list).
- **`params`.**
  - An object of at most 50 keys. Each key is a pattern with **exactly one** parameter.
  - Each key maps to at most 20 values:
    - a `[name]` value is one segment;
    - a catch-all value is segments joined by `/`;
    - every segment is non-empty, not `.` or `..`, at most 200 characters, and free of hidden or control characters (`consentDisplayText(v) === v`).
  - Bad keys and values are dropped silently.
- **A pattern with two or more parameters** (`/[org]/projects/[id]`) can't be filled from `params`. It is listed as a pattern, and it is filled by:
  - concrete entries in `routes`;
  - the picker's per-parameter fields (S87);
  - the tool's concrete `route`.
- **`fillRoute`** applies the same segment rules, percent-encodes each segment, and returns `null` unless the result passes `isConcreteRoute`. So `{slug: ".."}`, `{rest: "a//b"}` and `{rest: "a/../b"}` give `null`.
- **The merge (`mergeRouteList`).**
  - The list starts with `/`.
  - When `routes` is present, it is `routes` in its own order. Otherwise it is the discovered patterns, sorted with static routes first, then by depth, then alphabetically.
  - Each single-parameter pattern with `params` values is followed by its filled routes.
  - The result is deduplicated. Each entry is `{route, pattern?, source: "config"|"discovered"}`.
- **`routes` replaces discovery, and doesn't add to it.** This is how the spec's example reads, and it gives a monorepo or an unsupported router (S80's fallback) a complete list the person controls.
- **Writing.** Aiden writes the file with `write_file` or `edit_file`, as the skill says (S86). Neither `saveCanvasConfigApp` nor the attach consent changes. Unknown fields such as `mock` (3d) are already kept.
- **Freshness.**
  - `DesignAppServers.routes()` caches **only the disk walk** (`discoverRoutes`) for 5 s per `(workspaceId, appRoot)`.
  - It reads canvas.json fresh on every call before `mergeRouteList`, so an edit followed by `design_app routes` is seen at once.
  - The walk cache is cleared on a detection change and in `forgetWorkspace` (`app-server-main.ts:537`).
  - With no detection cached yet, `routes()` runs `detectFor` first.

### S82 — `design_app {action: "routes", root?}` (proposed; revised for m1)

This is a seventh, read-only action. The spec says Aiden "prefers `.aiden/canvas.json`" but names no tool that lists routes, and Aiden needs the list to place frames and to write the file.
- **Reply.** `{status: "routes", root, framework?, source: "discovered"|"config"|"fallback", truncated, routes: [{route, pattern?}]}`, capped at 200 entries.
  - `framework` is left out when it is unknown.
  - `AppRouteList` carries `framework?` for this.
- **`root`.** `routes` joins `status` and `start` in the actions that don't need `root` (`app-tool.ts:224`). With one app, it defaults to that app; with several and no `root`, it is an error listing the roots.
- It works while the app is stopped, isn't counted as a start, and never shows a card.
- Route strings come from the person's files, so the reply carries them as JSON values only and never as prose. Each is checked by `isAppRoute` or by the pattern shape.

### S83 — Route-aware placement (proposed; revised for B1, M3, M4, m2)

- **Which files.**
  - A route file is one that a `write_file` or `edit_file` completes in a design-mode turn, with the flag on, which lies under the deepest app root containing it, and which `routeFromFile` (single-file, S80) maps to a pattern for that root's framework.
  - A command's output isn't scanned outside `design/`. That is today's `createDesignPageScanner` limit, a deliberate cost bound, and commands rarely create route files.
- **The turn's data, with no disk walk.**
  - The first route candidate of a turn starts **one in-flight promise** of `{snapshot, config}`: `designAppServers.snapshot(workspaceId)` plus `readCanvasConfig(workspaceRoot)` for `params`.
  - Every later write in the turn awaits the same promise, so concurrent writes never detect twice.
  - Placement never calls `routes()`, so it never walks the tree.
  - A root added by the same turn's `write_file package.json` is seen only in the next turn. That is accepted, because the tool can still place it.
- **Root resolution (`routeOwner`).** The deepest root among the snapshot's candidates, its apps and canvas.json's described roots that contains the path. A path under no root, or in a root whose framework has no convention, places nothing.
- **Where it lands.**
  - A concrete pattern places an `app` frame for `{appRoot, route}` on the turn's page (S84) at the default 1280 × 800 and scale 0.5, and focuses it.
  - It places nothing if that page already has a frame for the same appRoot and route. Frames elsewhere don't count, which matches 3a's dedupe.
  - A single-parameter pattern is placed only when canvas.json gives it a value, and then with the first one. Otherwise it places nothing.
  - An edit of a file that maps to no route (a component, a style, a layout) places nothing. HMR updates the open frames.
- **At most 12 per turn.**
  - llm-client keeps `appFramesPlacedThisTurn`, raised by each placement's `added.length`.
  - Once it reaches `EARLIER_PAGES_LIMIT` (12), later route files place nothing, and the tool can still place them.
  - A per-call `limit` wouldn't do this, because each write calls `placeWrittenPagesOnCanvas` once (`llm-client.ts:3268-3298`).
- **Not inspected.** Route paths bypass `writtenPageInspector`'s `written` and `removed` (`llm-client.ts:3293-3294`). Those inspect only v1 `design/*.html` pages.
- **Remembered writes, one timeline.**
  - Route files are noted in the **same** `recentWrittenPages` instance as design/ pages, and only with the flag on.
  - Its existing `forget(chatId)` calls in `releaseChatContext` and `invalidateChatWorkspaceContext` (`chat-application-service-main.ts:80`, `:87`) therefore cover them, with no second store to wire.
  - `pagesWrittenInChat(messages, {isRouteFile?})` gains an optional classifier. Left out, which is the flag-off case, it returns exactly today's list.
- **Removed routes.**
  - The canvas document gains `removedAppRoutes: string[]`. Its keys are `appRouteKey(appRoot, route)` = `"<appRoot>\u0000<route>"`, at most 200, newest kept.
  - It is maintained exactly like `removedPagePaths`: `withRemovedAppRoutes(before, after, byPerson, undoneRoutes)` runs next to `withRemovedPagePaths` in `store.save` and `store.update`.
  - When the person removes the last frame of a route, the route is noted. Any frame showing it again, whoever adds it, forgets it.
  - Automatic placement skips a noted route. The tool and the person's Add don't.
- **The person's undo (B1).**
  - `designCanvas:save` options gain a separate **`undoneRoutes?: string[]`**, at most `DESIGN_CANVAS_LIMITS.frames`.
    - Each entry passes `isAppRouteKey`: two halves, `isAppRoot` and `isAppRoute`, with a total of at most 2 300 characters.
    - `saveOptions` (`main/handlers/design-canvas.ts:248-265`) keeps `undone`'s `isDesignRelativePath` check unchanged and validates `undoneRoutes` on its own.
  - In the renderer, `use-design-canvas.ts` keeps `undoneRoutes` beside `undonePages`. `pruneShownUndonePages` (`:365`), `updateUndonePagesForEdit` (`:384`) and `startSaveTransition` (`:450`) read `shownAppRoutes(doc)` (new, in `schema.ts`) next to `shownPagePaths(doc)`.
  - ⌘Z of a turn's frames goes through 1b's `aidenTurn` and this `undoneRoutes`, so undoing an Aiden placement never notes a removal.
- **Retraction (m2).**
  - `retractPlacedFrames` covers a different case from undo: design mode turning off, or the chat leaving, while a write was in flight (`!(await shouldSave())`, `written-pages.ts:625-630`).
  - App frames take part because they are just frame ids in `placedIds`.
- **Reporting (M3).**
  - `placeWrittenPagesOnCanvas` returns `added: number[]`, the viewport widths of the app frames it actually kept.
  - The list is filled only after `store.update` commits and the post-write `shouldSave()` passes. It is empty when the placement is refused, unchanged or retracted.
  - Callers report S88 from it.
- **Entry (M4.5).**
  - The chat's remembered writes form one timeline, `recent.merged(chatId, pagesWrittenInChat(messages, {isRouteFile}))`, oldest first.
  - Entry takes the **newest 12 across both kinds**, keeping their order, then splits them: design/ pages go through today's `entryPlacement`, and route files are placed as app frames on the page it chose.
  - Route frames don't change that page choice, which stays 1b's rule.
  - App routes are deduplicated against **the target page only**, plus `removedAppRoutes`, never other pages or other chats' pages.
  - With no writes of either kind, `entry.ts` can't know which page `entryPlacement` will pick, or whether that page is empty. It passes `entry.fallbackRoute: {appRoot, route: "/"}` (only for a `single` target), and `placeWrittenPagesOnCanvas` decides inside its `store.update` (M2-2). It places that app's `/` only when:
    - the target page is empty after v1 placement;
    - the snapshot's target is `single`;
    - `/` isn't in `removedAppRoutes`.
  - Several roots and no writes place nothing. The status chip's Choose apps is the person's way in.
- **Flag off.** No route classifier runs, no route file is noted, and nothing changes.

### S84 — Where Aiden's work lands (proposed; S18 revisited)

S18's order stands for **every** placement 3b adds: the tool, written routes, entry and the person's Add. The order is shown this turn → the message's page → the kept view → the claim → the first page.
- The tool and the written-route path take the page `designTurnPages` already gives the turn.
- The person's Add takes the page on screen, sent with the call and checked by main (S87).
- §6.5's "where Aiden's work lands" is rewritten to say exactly this.
  - The spec's draft text ("the chat's own page unless the person is looking at another") is the same rule seen from the person's side.
  - Nothing new is built for it. Task 15 updates the spec text and the prompt line, and Task 8's tests pin the order for route placements.
- **Rationale.** 3a and 1b already put every frame on the page the turn's view names. A second rule for app frames would put two frames from one turn on two pages.

### S85 — The remaining tool changes (proposed; revised for M1, M2, M7, m3)

- **`canvas_place_frame {kind: "app"}`** keeps `title` required (`canvas-tools.ts:1310`) and also takes:
  - **`device`:** one of `phone`, `tablet`, `laptop` or `desktop`, mapping to §6.3.8's iPhone 390 × 844, iPad 768 × 1024, Laptop 1280 × 800 and Desktop 1440 × 900.
    - Explicit `width` or `height` win over it, side by side.
    - The table lives in the new `renderer/shared/design-canvas/app-devices.ts`, which 3c's menu also uses.
  - **`variantOf`:** the **id** of an app frame on the same page with the same app root. App frames have no `path`, so `designFrameByIdOrPath`'s path form never matches.
    - The new frame goes right of the rightmost frame in the variant set (the original plus every frame whose `variantOf` is the original), `DESIGN_FRAME_GAP` (64) apart, top-aligned.
    - If the original has a `groupId` (a group or an artboard), the new frame joins that container and the container is refitted with `refitGroups`.
    - Otherwise a new group titled after the original's route is made around both with `fitGroupToMembers`, as `canvas_build`'s group does (`canvas-tools.ts:2664-2677`).
    - It is refused, with the existing locked wording, when the original or its container is locked.
    - It is refused with the existing "That page is full" error when the frame, plus a new group if one is needed, would pass `framesPerPage`.
    - It is recorded in the new frame's `variantOf`.
  - **`label`:** at most `APP_FRAME_LIMITS.labelChars` (60). It is stored in `frame.label`, **separate from the title**.
  - **On reuse.** `device` merges like `width`/`height` do today (`canvas-tools.ts:1160-1172`), with explicit sides overriding. `label` replaces the old one when given. `variantOf` is ignored on reuse, because the frame already exists.
- **Shown.**
  - `summarizeFrame` (`canvas-summary.ts:369-377`) adds `label` and `variantOf` to app frame summaries.
  - `AppNode`'s header shows `label` after the title, in the muted text token, through `FrameTitle`'s existing slot or a sibling span.
- **`canvas_update_frame`** on app frames also takes:
  - **`route`**, checked by `isAppRoute` and the concrete-route check. It changes the route, changes the title only if the title equalled the old route, and keeps the frame.
    - `AppNode` then resets its `pageState`, `loadedKey` and `stuckKey`, and its restore counters, for the new route (`app-node.tsx:475-525`, `:669-755`), so the old route's path, error and stuck state don't carry over.
  - **`width`/`height`** (the viewport, each `isAppViewportSide`, 200–4 000, `APP_FRAME_LIMITS`) and **`device`**.
    - The frame **keeps its current scale**, refitted by `fitAppScale` to `maxSize`, and its box becomes `appFrameBox(viewport, scale)`.
    - It is the same rule as `canvas_place_frame`, and the scale stays within `[minScale, maxScale]` because it only ever shrinks from an in-range value.
    - A 1440 × 900 frame at scale 1 switched to `phone` becomes 390 × 844 at scale 1.
  - **`label`.**
  - Passing the box (`w`/`h`) together with the viewport (`width`/`height`/`device`) in one call is an error: "Change the frame's size or its viewport, not both in one call."
  - Each of these refuses a non-app frame with the existing kind error.
- **`canvas_read`** lists each app frame with `blocked: <count>` when the count isn't zero.
  - It is read through a new dependency, `blockedFor(frameId) → number`, backed by `AppFrameRegistry.blockedForFrame(frameId)`.
  - That sums the totals of **live** members only, those in `options.liveIds()`, whose `frameId` matches. A null `liveIds()` (no window) gives 0. So the totals of a dead earlier mount, which stay in `members` until `prune` runs at 512, are never counted (M7).
  - It gives **a count only**: the hosts are page-chosen text (S11).
- **Errors in `canvas_read` wait for Phase 4.** §6.5 lists "errors", but the only source is the bridge, whose text is untrusted (S11), and error frames are Phase 4's. 3b sends no bridge text to the model.
- **`design_inspect`** is Phase 4 (§8). **`canvas_inspect`** still refuses app frames.
- **The analytics dependency.**
  - `DesignCanvasToolDeps` gains `onAppFrameAdded?(viewportWidth: number)`.
  - It is called after the tool's `store.update` resolves, once per **new or copied** app frame, never for a reused one.
  - This revises 3a's D19 for this one event.

### S86 — The live prompt and skill (proposed; revised for M5)

- **The prompt is static per turn's tools (S34).**
  - The signature is `designModePromptSection(designMd: boolean, liveApps = false)`. `liveApps` is true only when this turn offers `design_app`, which is llm-client's existing condition at `:3154`: `designLive && followThroughAvailable && workspace && !excludeToolNames.has("design_app")`.
  - The outputs:
    - `(false, false)` is today's `DESIGN_MODE_PROMPT_SECTION`, strictly equal.
    - `(true, false)` is today's flag-on string (section + `DESIGN_MD_PROMPT_BULLET`), strictly equal. This covers Windows, an excluded `design_app`, and `turn-wiring.test.ts`.
    - `(designMd, true)` is `LIVE_DESIGN_MODE_PROMPT_SECTION`, plus `DESIGN_MD_PROMPT_BULLET` **verbatim** when `designMd` is true.
  - llm-client's two call sites (`:3212`, `:3377`) pass both values.
  - `:3377` also passes `withDesignModeSection(…, {live: designMdOn || liveAppsOn})`. Today that is `{live: designMdOn}`, which would keep a stored v1 section on a turn with `design_app` but no `design_system` (m2-2).
- **Replacing a stored live prompt.**
  - `withDesignModeSection` (`design-md/turn.ts:184`) today replaces a stored copy only if it contains `DESIGN_MD_PROMPT_BULLET`.
  - It also replaces one that contains the exported `LIVE_APP_PROMPT_MARKER` (the live section's first bullet). A chat that flips to a turn without `design_app` therefore drops the live text.
  - It gets a mid-chat flip test in `design-md/turn.test.ts`.
- **The prompt's live bullets** (exact copy, Task 10):
  - Design in the real app. When the workspace has a web app, screens are its routes and components, not design/ HTML. Start it with `design_app start`, and list its pages with `design_app routes`.
  - A route file you write or edit lands on this chat's page by itself, once, and updates live as you save. Component and style edits update every open frame. Use `canvas_place_frame` with kind app to show another route or a device size.
  - For a variant of a page, write a route copy such as `/pricing-v2` next to the original and place it with `variantOf`. Keep at most three directions, then ask which to keep.
  - With no web app, use the design/ HTML pages as before. This bullet goes in 3d (S6).
  - Keep today's canvas, page, focus, comments and coordinates bullets. The `canvas_inspect` bullet says it draws design/ pages and not app frames.
- **The skill.**
  - `aidenDesignSkill(live: boolean)` returns today's frozen object when `live` is false, and `AIDEN_DESIGN_SKILL_LIVE` when it is true. Both have the same `name` and id.
  - A pure `designCanvasSkills({designMode, designLive})` in `skill.ts` returns the list `skill-registry-main.ts:21-23` spreads, and the registry passes `designModeEnabled()` and `designLiveEnabled()`.
  - It is tested in `skill.test.ts`. The reviewer suggested `skill-registry-main.ts`, but that module builds the singleton registry at import, so the pure helper sits with the skill instead.
- **The skill is global, but tools are per turn.** The registry can't see a turn's tools, so the live skill's live sections open with "When design_app is among your tools". Its "No web app" section, the v1 HTML method unchanged, is what a turn without `design_app` follows.
- **What the live skill teaches:**
  - how to start the app and list its routes;
  - preferring `.aiden/canvas.json` routes and params, and writing them when discovery says `fallback` or a dynamic route needs a value;
  - new screens as new route files in the app's own convention;
  - working on the chat's page;
  - variants as `<route>-v2` copies placed with `variantOf`;
  - at most three directions, then asking which to keep;
  - `canvas_read snapshot: true` to check;
  - DESIGN.md as the source of truth, within S38's limits: tokens and prose only, no `motion` group, the Motion and Voice & Content sections unchecked by the linter, and `@file#fragment` references unresolved.
- **Not in the live skill:** the JSX `data-aiden-comment` bullet. In 3b, app frames take only frame-level comments (S68), and the bullet returns with Phase 4's source mapping.
- **Rationale.** One skill name keeps the registry, the load_tools hints and the "tools it names are offered" test. Functions, rather than mutable objects, keep flag-off strictly equal.

### S87 — Add ▸ Page from app… (proposed; revised for M6)

- **The menu.**
  - `DesignAddKind` gains `"app-route"`.
  - The item reads **Page from app…** and is shown only with `designLive`.
  - It is **enabled** when `snapshot.target !== "unavailable"` and `snapshot.apps.length > 0 || snapshot.candidates.length > 0`. An attached server or an `apps[].url` app (target `"none"`, `app-server-main.ts:1574`) counts.
  - Otherwise it is disabled, with the hint "No web app in this workspace".
- **The dialog (`AppRoutePicker`).** A Radix `Dialog` from `ui.tsx`, titled "Add a page from your app". It has:
  - an app `Select`, shown only with two or more roots;
  - a filled filter `Input` with no focus accent, labelled "Filter routes";
  - a `listbox` of route rows, where arrow keys move, Enter places, and the active row uses the hover fill;
  - one inline value field per parameter on each dynamic row (`[slug]` labelled "slug", and two fields for `/[org]/projects/[id]`), prefilled from single-parameter `params`;
  - a final "Go to <typed>" row when the filter text is a concrete route not in the list;
  - a source line: "From your app's files", "From .aiden/canvas.json", or, for the fallback, "Only / found: list routes in .aiden/canvas.json";
  - Cancel and **Add**, both shared squircle buttons;
  - at most 200 rows, then "N more: refine the filter".
- **The order of a placement (M6.3).** Before calling `placeAppRoute`, `design-canvas.tsx` awaits `flush()` (`:171`), so a pending local save can't CAS-conflict with main's write and clear the undo history. It then sends the page on screen as `pageId` with `viewSize`.
- **IPC.**
  - `designCanvas:appRoutes(chatId, {appRoot?})` returns `{apps: [{appRoot, label}], appRoot, list: AppRouteList}`, or `{error: "unavailable"|"no-app"}`.
  - `designCanvas:placeAppRoute(chatId, {appRoot, route, pageId?, viewSize?})` returns:
    - `{placed: frameId, pageId}`;
    - `{already: frameId, pageId}`;
    - `{error: "unavailable"|"bad-route"|"unknown-root"|"full"}`.
  - **What main checks:**
    - `canFrame(chat)` and the flag;
    - the root against the snapshot;
    - the route with `isAppRoute` and the concrete-route check;
    - `pageId` against `doc.pages`, falling back to `views.get(chatId)`, as S84 says.
  - **Placing.** Main places with `createdBy: "person"`, centred in the person's viewport (`placeArtifact`'s box rule), at the default viewport and scale.
  - A frame for that appRoot and route already on the page answers `already`.
  - `placeFrame`'s frame limit answers `full`.
  - **Focus.** Both `placed` and `already` call `deps.sendFocus` with the frame. `placeArtifact` focuses only a frame on another page (`design-canvas.ts:523-529`), and that isn't enough here.
  - **Undo.** It broadcasts `step: "add-app-route:<revision>"`, so the placement is the person's own undo step.
  - **Analytics.** It reports S88 with `source: "person"` only for `placed`.
- **Picker copy.**
  - `bad-route`: "That address isn't a page of this app."
  - `full`: "This page is full. Remove a frame or use another page."
  - `unknown-root`: "That app isn't in this workspace any more."
- **Rationale.** The person never types an origin: main resolves the app and the box. `placeArtifact` is the tested precedent for a person's placement made in main.
- **The size** is the default 1280 × 800 at 0.5. 3c's device menu adds a device choice.

### S88 — `design_app_frame_added` (proposed; revised for M3)

- **Registry entry:** `design_app_frame_added: { source: enumProp("person", "aiden"), device_bucket: enumProp("phone", "tablet", "laptop", "desktop") }`.
- **`device_bucket`** comes from the viewport width (`deviceBucket(width)` in `app-devices.ts`): `phone` up to 480, `tablet` 481–1023, `laptop` 1024–1439, `desktop` 1440 and over.
- **It is reported from exactly four call sites,** each after its write committed, and never for a reused, refused or retracted frame:
  1. `createDesignCanvasTools`' `onAppFrameAdded` in llm-client, with `source: "aiden"`;
  2. llm-client's `placeWrittenPage`, from the result's `added`, with `source: "aiden"`;
  3. `createDesignEntry`, wired in `chat-application-service-main.ts:61`, from the result's `added`, with `source: "aiden"`;
  4. `designCanvas:placeAppRoute`'s `placed`, with `source: "person"`.
- **What it never carries:** the route, the app root, the framework or a count of routes.
- It needs its docs row in `docs/analytics.md`'s design section, and its test in `analytics-feature-reports.test.ts`.

## Interfaces

```ts
// renderer/shared/design-canvas/app-devices.ts (new, shared with 3c)
export type AppDevice = "phone" | "tablet" | "laptop" | "desktop";
export const APP_DEVICES: Readonly<Record<AppDevice, { label: string; width: number; height: number }>>;
// phone "iPhone" 390×844, tablet "iPad" 768×1024, laptop "Laptop" 1280×800, desktop "Desktop" 1440×900
export function isAppDevice(value: unknown): value is AppDevice;
export function deviceBucket(viewportWidth: number): AppDevice;

// renderer/shared/design-canvas/app-routes.ts (new, shared: main and renderer read the same shapes)
export type AppRouteEntry = { route: string; pattern?: string; source: "config" | "discovered" };
export type AppRouteList = {
  appRoot: string;
  framework?: FrameworkId;
  source: "discovered" | "config" | "fallback";
  truncated: boolean;
  routes: AppRouteEntry[];
};
export function isRoutePattern(value: string): boolean;      // "/blog/[slug]", "/docs/[...rest]"
export function isConcreteRoute(value: string): boolean;     // isAppRoute and no "[" "]"
export function patternParams(pattern: string): { name: string; catchAll: boolean; optional: boolean }[];
/** Each segment non-empty, not "." or "..", ≤ 200 chars, no hidden or control characters; the result must pass isConcreteRoute. */
export function fillRoute(pattern: string, values: Record<string, string>): string | null;
export function isParamValue(value: string, catchAll: boolean): boolean;

// main/services/design-canvas/app-server/app-routes-core.ts (new, pure)
export type RouteConvention = "next-app" | "next-pages" | "tanstack" | "react-router-flat" | "astro";
export function conventionsFor(framework: FrameworkId | undefined): readonly RouteConvention[];
/** relPath is POSIX and relative to the app root, e.g. "src/app/(shop)/pricing/page.tsx". */
export function routeFromFile(convention: RouteConvention, relPath: string): string | null;
/** Whole-tree: drops layouts with child or index routes, keeps a leaf folder's route.tsx. */
export function routesFromFiles(convention: RouteConvention, relPaths: readonly string[]): string[];
/** O(n) tokens of TS/JS text: identifiers, strings (escapes decoded), punctuation; comments and template literals skipped. */
export function scanTsTokens(text: string, maxTokens?: number): Array<{ kind: "id" | "str" | "punct"; value: string }> | null;
export function parseTanStackRouteTree(text: string): string[] | null;
export function parseReactRouterConfig(text: string): { routes: string[] } | { flat: true } | null;
export function mergeRouteList(input: {
  appRoot: string;
  discovered: { patterns: string[]; truncated: boolean } | null; // null: no convention
  config?: { routes?: string[]; params?: Record<string, string[]> };
}): AppRouteList;
export const ROUTE_LIMITS: { depth: 10; entries: 2000; routes: 500; fileBytes: 262_144; listed: 200 };

// main/services/design-canvas/app-server/app-routes.ts (new, disk; strict no-follow, B2)
/** null: the app root or one of its parent segments is a link or not a folder, or its realpath is outside the workspace.
 *  A convention folder (src, app, pages, routes) that is missing (ENOENT), a link or not a folder is skipped, giving no routes from that convention. */
export function discoverRoutes(workspaceRoot: string, appRoot: string, framework: FrameworkId | undefined,
  options?: { signal?: AbortSignal }): Promise<{ patterns: string[]; truncated: boolean } | null>;
/** For placement: the pattern a written file maps to, or null. Pure over the path (routeFromFile); no disk read. */
export function routeForWrittenFile(appRoot: string, framework: FrameworkId | undefined, workspaceRelPath: string): string | null;

// canvas-config.ts (modified)
export type CanvasConfigApp = { root: string; script?: string; designMd?: string; url?: string; urlRefused?: boolean;
  routes?: string[]; params?: Record<string, string[]> };

// app-server-main.ts (modified)
class DesignAppServers { routes(workspaceId: string, appRoot?: string): Promise<AppRouteList | { error: "unknown-root" | "choose-root" | "unavailable"; roots?: string[] }>; }
// Only discoverRoutes is cached, per (workspaceId, appRoot) for 5 s; canvas.json is read fresh every call (m1).
// Cleared on a detection change and in forgetWorkspace. Runs detectFor first when nothing is cached.

// canvas-tools.ts (modified)
type DesignCanvasToolDeps = { /* …3a's… */ blockedFor?(frameId: string): number; onAppFrameAdded?(viewportWidth: number): void; };

// app-frame-registry.ts (modified)
/** Sums totals of members in options.liveIds() whose frameId matches; null liveIds gives 0 (M7). */
blockedForFrame(frameId: string): number;

// schema.ts / store.ts (modified)
removedAppRoutes?: string[];                 // DESIGN_CANVAS_LIMITS.removedAppRoutes = 200
export function appRouteKey(appRoot: string, route: string): string;
export function isAppRouteKey(value: unknown): value is string;   // isAppRoot + "\u0000" + isAppRoute, ≤ 2 300 chars
export function shownAppRoutes(doc: DesignCanvas): ReadonlySet<string>;   // keys of the doc's app frames
export function withRemovedAppRoutes<T extends DesignCanvas>(before: DesignCanvas, after: T, byPerson: boolean, undoneRoutes?: ReadonlySet<string>): T;

// main/handlers/design-canvas.ts (modified, B1): designCanvas:save options
type SaveOptions = { undone?: string[] /* isDesignRelativePath, as today */; undoneRoutes?: string[] /* isAppRouteKey, ≤ frames */; workspaceId: string };
// store.save options gain undoneRoutes, passed to withRemovedAppRoutes

// written-pages.ts (modified)
export type WrittenAppRoute = { appRoot: string; route: string };
export function placeWrittenAppRoutes(doc: DesignCanvas, routes: readonly WrittenAppRoute[], newId: () => string,
  view: DesignChatView /* as placeWrittenPageFrames takes it (written-pages.ts:274), so frames land beside what is in view */,
  options: { skipRemoved: boolean; room: number /* left of the turn's 12 */ }): { doc: DesignCanvas; frameIds: string[]; widths: number[] };
// placeWrittenPagesOnCanvas: input gains
//   routes?: WrittenAppRoute[]
//   entry.fallbackRoute?: WrittenAppRoute   // entry's "/" (M2-2): placed inside store.update, after entryPlacement and
//                                           // placeWrittenPageFrames, only if framesOnPage(doc, view.pageId) is empty and
//                                           // the key isn't in removedAppRoutes
// its early return (written-pages.ts:561, `showable.length === 0 && !rules`) also requires (input.routes?.length ?? 0) === 0
// its result gains
//   added: number[]   // viewport widths of app frames kept after commit and the post-write shouldSave (M3)
// pagesWrittenInChat(messages, options?: { isRouteFile?(path: string): boolean }) — left out: today's list exactly

// skill.ts (modified)
export function aidenDesignSkill(live: boolean): typeof AIDEN_DESIGN_SKILL;
export function designCanvasSkills(flags: { designMode: boolean; designLive: boolean }): readonly SkillRegistryCandidate[];   // skill-registry-core.ts:11, what listBuiltin takes

// canvas-tools.ts (modified, M5)
export const LIVE_DESIGN_MODE_PROMPT_SECTION: string;
export const LIVE_APP_PROMPT_MARKER: string;           // the live section's first bullet, for withDesignModeSection
export function designModePromptSection(designMd: boolean, liveApps?: boolean): string;

// main/handlers/design-canvas.ts (new channels)
export type DesignCanvasAppRoutesResult =
  | { apps: { appRoot: string; label: string }[]; appRoot: string; list: AppRouteList }
  | { error: "unavailable" | "no-app" };
// placeAppRoute(chatId, { appRoot: string; route: string; pageId?: string; viewSize?: { w: number; h: number } })
export type DesignCanvasPlaceAppRouteResult =
  | { placed: string; pageId: string } | { already: string; pageId: string }
  | { error: "unavailable" | "bad-route" | "unknown-root" | "full" };
```

## Global Constraints

- **Flag off is today.** Tasks 4, 6, 7, 8, 9, 10 and 12 each include a flag-off case: the tool definitions and `design_app`'s action list deep-equal the ones built with today's dependencies; the prompt and skill strictly equal today's; no route classifier runs; the IPC answers `unavailable`; the menu has no new item; and no event is sent.
- **Never run the person's code to learn routes** (S78). No `import()`, no `require`, no `typescript`, no child process. Reads are bounded, no-follow, and confined to the app root.
- **Route strings are untrusted.** They come from file names and the person's config. They are validated by `isAppRoute`/`isRoutePattern`, shown as text nodes only, and given to the model as JSON values only. No security decision reads a route: the origin still comes from main's server record (3a D2).
- **Main decides URLs and boxes** for the person's Add (S87). The renderer sends an app root and a route string, and main checks both.
- **No new network.** Discovery reads disk. Nothing contacts a framework registry or the dev server for routes.
- **Analytics** (AGENTS.md Product analytics): only S88's two properties, through `main/services/analytics/`. The registry entry, the docs row and a test land in Task 5. No renderer-side analytics.
- **UI rules** (AGENTS.md, `GUI.md`, `docs/design-guide.md`). Read `docs/chatgpt-desktop-ui-inspiration.md` and `docs/chatgpt-ui-element-specimen.html` before Task 12. Then:
  - shared squircle `Button`s and Radix overlays from `ui.tsx`;
  - semantic tokens only;
  - text inputs with no focus accent, border or ring;
  - visible `focus-visible` on the list rows and buttons;
  - no decorative borders;
  - Reduce Motion through the motion tokens;
  - focus returning to the Add button on close;
  - no brain icons.
- **AGENTS.md test rules.**
  - Behavioural tests only. There are no source greps and no `className` or markup snapshots.
  - S80's rows are written by hand from the frameworks' documented examples. They never come from looping the convention table through itself.
  - The prompt and skill tests assert behaviour: the tools named are offered, flag off equals today, and the live text names no tool the turn lacks. They don't pin copy.
  - Each new test file is registered **in the task that adds it**, appended to `test:design-mode` in `package.json` (a union keeping every entry) and added to its lane in `scripts/ci-test-registry.json`: main and shared suites in `core-git`, renderer and happy-dom suites in `renderer-other`. That task runs `npm run test:ci-policy`.
  - The E2E spec goes in `scripts/ci-e2e-spec-map.json` in Task 13.
- **Window-opening runs happen in the Cua Space** (`npm run test:e2e:space`). 3a's E2E notes hold (3a As built #17):
  - frames are placed at `scale: 0.25`, then fitted to screen;
  - controls are pressed with focus and Enter;
  - on Linux, `--disable-seccomp-filter-sandbox` goes through `appArgs`;
  - `--run` takes `bash -c "npm run build && …"`.
- **Docs change in this PR** (Task 15). The memory gets a 3b section when it is built.

## Review Focus

1. **A route folder full of non-pages.** Next `app/` holds `layout.tsx`, `loading.tsx`, `error.tsx`, `route.ts` handlers, `_components/` and `@modal/`; TanStack holds `__root.tsx` and `-utils.ts`. A person expects only real pages listed, and editing `layout.tsx` to place nothing. *Pinned by* Task 1's non-page rows and Task 8's "edit layout places nothing".
2. **A huge or hostile tree.** A monorepo app root with 50 000 files must answer quickly and partly (`truncated`). A symlinked app root, parent or convention folder, a symlink loop, or a symlinked `routes.ts` must never be followed, and nothing outside the root may be read. *Pinned by* Task 2's caps and its spy-recorded confinement cases (B2).
3. **The same route twice.** Aiden edits `pricing/page.tsx` ten times in a turn, or the person already placed `/pricing`. One frame, focused, never a second. *Pinned by* Task 8's dedupe cases and Task 11's `already`.
4. **A route the person removed.** They delete the `/pricing` frame, and Aiden edits `pricing/page.tsx` again. It must not come back by itself, but Aiden's explicit `canvas_place_frame` may. *Pinned by* Task 7's store cases and Task 8's skip case.
5. **Two chats, one workspace.** Chat A's route writes land on A's page, never on B's, even when B's canvas is on screen. *Pinned by* Task 8's two-chat case and Task 13's E2E.

---

## Tasks

### Task 0: Baseline

- [ ] Confirm the branch is `t3/design-mode-v2-p3b`, on `origin/t3/design-mode-v2-p3a` at `03e03fe73` or later. If 3a gained commits, merge them in (no rebase).
- [ ] `npm ci`, `npm run build:native:c`, `npm run build:vcc`, and `npm ci` in `packages/cli`.
- [ ] Recheck each "What exists today" row's line numbers with `rg -n`. If anything moved, update the table first. These are baseline checks, not tests.
- [ ] Run `npm run test:design-mode` and `npx tsc --noEmit -p .`. Expected: PASS. Record failures as pre-existing.

### Task 1: Route rules (pure)

**Files:**
- Create: `renderer/shared/design-canvas/app-routes.ts`, `renderer/shared/design-canvas/app-routes.test.ts`
- Create: `main/services/design-canvas/app-server/app-routes-core.ts`, `app-routes-core.test.ts`

**Interfaces:**
- Consumes: `isAppRoute` (`app-frame.ts:67`), `consentDisplayText`, and `FrameworkId` (`renderer/shared/design-app.ts`).
- Produces, exactly as in Interfaces: `AppRouteEntry`, `AppRouteList`, `isRoutePattern`, `isConcreteRoute`, `patternParams`, `isParamValue`, `fillRoute`, `conventionsFor`, `routeFromFile`, `routesFromFiles`, `scanTsTokens`, `parseTanStackRouteTree`, `parseReactRouterConfig`, `mergeRouteList` and `ROUTE_LIMITS`.

- [ ] **Step 1: Write the failing tests.** Each row's expected value is written by hand from the framework's own documented examples.
  - **`routeFromFile("next-app", …)`** (single file):
    - `app/page.tsx` → `/`
    - `app/pricing/page.tsx` → `/pricing`
    - `src/app/(shop)/cart/page.tsx` → `/cart`
    - `app/blog/[slug]/page.mdx` → `/blog/[slug]`
    - `app/docs/[...rest]/page.tsx` → `/docs/[...rest]`
    - `app/shop/[[...all]]/page.js` → `/shop/[[...all]]`
    - `app/layout.tsx`, `app/loading.tsx`, `app/api/x/route.ts`, `app/_components/Card.tsx`, `app/@modal/page.tsx` and `app/(.)photo/page.tsx` → `null`
  - **`next-pages`:**
    - `pages/index.tsx` → `/`
    - `pages/about.tsx` → `/about`
    - `pages/blog/[id].tsx` → `/blog/[id]`
    - `pages/blog/index.tsx` → `/blog`
    - `pages/_app.tsx`, `pages/_document.tsx`, `pages/404.tsx` and `pages/api/hello.ts` → `null`
  - **`tanstack`** (single file):
    - `src/routes/index.tsx` → `/`
    - `src/routes/about.tsx` → `/about`
    - `src/routes/posts.$postId.tsx` → `/posts/[postId]`
    - `src/routes/posts/$postId/edit.tsx` → `/posts/[postId]/edit`
    - `src/routes/_auth/settings.tsx` → `/settings`
    - `src/routes/(marketing)/pricing.tsx` → `/pricing`
    - `src/routes/files/$.tsx` → `/files/[...splat]`
    - `src/routes/posts.index.tsx` → `/posts`
    - `src/routes/posts.tsx` → `/posts` (it can't see siblings, S80)
    - `src/routes/__root.tsx` and `src/routes/-components/x.tsx` → `null`
  - **`routesFromFiles("tanstack", […])`** (whole tree):
    - `["src/routes/posts.tsx", "src/routes/posts.index.tsx", "src/routes/posts.$postId.tsx"]` → `["/posts", "/posts/[postId]"]`, with the layout counted once, as the index;
    - `["src/routes/dashboard/route.tsx"]` (a leaf) → `["/dashboard"]`;
    - `["src/routes/dashboard/route.tsx", "src/routes/dashboard/stats.tsx"]` → `["/dashboard/stats"]`.
  - **`react-router-flat`** (Remix's documented examples):
    - `app/routes/_index.tsx` → `/`
    - `app/routes/about.tsx` → `/about`
    - `app/routes/concerts.$city.tsx` → `/concerts/[city]`
    - `app/routes/concerts._index.tsx` → `/concerts`
    - `app/routes/_auth.login.tsx` → `/login`
    - `app/routes/concerts_.mine.tsx` → `/concerts/mine`
    - `app/routes/sitemap[.]xml.tsx` → `/sitemap.xml`
    - `app/routes/files.$.tsx` → `/files/[...splat]`
    - `app/routes/dashboard/route.tsx` → `/dashboard`
    - `app/routes/_auth.tsx` → `null`
  - **`astro`:**
    - `src/pages/index.astro` → `/`
    - `src/pages/blog/[slug].astro` → `/blog/[slug]`
    - `src/pages/[...path].astro` → `/[...path]`
    - `src/pages/about.md` → `/about`
    - `src/pages/api/x.ts` and `src/pages/_draft.astro` → `null`
  - **`scanTsTokens`:**
    - `route("a//b", "x.tsx") // route("evil", "y")` gives the tokens of the first call only.
    - `/* route("c", "z") */` gives nothing.
    - A string holding `"*/"` is one string token.
    - A template literal with `${…}` is skipped as one unit.
    - An unterminated string or comment gives `null`.
    - 256 KiB of `((((((…` returns in under 100 ms, with `null` from the reader's depth cap. This is the linear-time oracle.
  - **`parseTanStackRouteTree`:**
    - A trimmed real `routeTree.gen.ts`, with `export interface FileRoutesByFullPath { '/': typeof IndexRoute; '/about': …; '/posts/$postId': … }`, gives `["/", "/about", "/posts/[postId]"]`.
    - The same keys inside a comment are ignored.
    - Text without the interface gives `null`.
  - **`parseReactRouterConfig`:**
    - `export default [index("routes/home.tsx"), route("about", "routes/about.tsx"), ...prefix("blog", [route(":slug", "routes/post.tsx")])] satisfies RouteConfig;` gives `{routes: ["/", "/about", "/blog/[slug]"]}`.
    - Nesting of `layout("l.tsx", [prefix("a", [route(":id", "r.tsx")])])` gives `/a/[id]`, and 17 levels give `null`.
    - `export default flatRoutes() satisfies RouteConfig;` gives `{flat: true}`.
    - A config that maps over an array gives `null`.
  - **`mergeRouteList`:**
    - With no config, `/` comes first, then static before dynamic: discovered `["/blog/[slug]", "/about", "/"]` gives `/`, `/about`, `/blog/[slug]`.
    - With `params {"/blog/[slug]": ["hello-world"]}`, `/blog/hello-world` (source `config`, pattern `/blog/[slug]`) follows the pattern.
    - `params {"/[org]/p/[id]": ["x"]}` (two parameters) adds nothing.
    - With `routes: ["/", "/pricing"]`, discovery is ignored and the source is `config`.
    - `discovered: null` and no config gives `{source: "fallback", routes: [{route: "/"}]}`.
    - 300 discovered patterns give 200 entries and `truncated: true`.
  - **`fillRoute` and `isParamValue`:**
    - `("/blog/[slug]", {slug: "a b"})` gives `/blog/a%20b`.
    - `{slug: "a/b"}`, `{slug: "."}`, `{slug: ".."}`, `{slug: ""}` and `{slug: "a​b"}` each give `null`.
    - The catch-all `("/docs/[...rest]", {rest: "a/b"})` gives `/docs/a/b`; `{rest: "a//b"}` and `{rest: "a/../b"}` give `null`.
    - An empty optional catch-all gives `/shop`.
    - `("/[org]/p/[id]", {org: "o", id: "1"})` gives `/o/p/1`.
  - **The pattern checks:**
    - `isConcreteRoute("/blog/[slug]")` is false, and `isConcreteRoute("/blog/x")` is true.
    - `isRoutePattern("/a/[b")` and `isRoutePattern("//x")` are false.
  - **`conventionsFor`:** `next` gives `["next-app", "next-pages"]`, `remix` gives `["react-router-flat"]`, and `vite` and `undefined` give `[]`.
- [ ] **Step 2:** Run `npx tsx --test renderer/shared/design-canvas/app-routes.test.ts main/services/design-canvas/app-server/app-routes-core.test.ts`. Expected: FAIL, because the modules aren't found.
- [ ] **Step 3: Implement.**
  - The converters are per-segment rules over `relPath.split("/")`.
  - `routesFromFiles` groups paths by parent route before dropping layouts.
  - `scanTsTokens` is one forward pass with an index and no regular expressions, stopping after `maxTokens` (default 50 000). The two readers walk its tokens recursively, to a depth of 16.
  - Values are percent-encoded per segment with `encodeURIComponent` after `isParamValue`.
- [ ] **Step 4:** Rerun the tests. Expected: PASS.
- [ ] **Step 5:** Register both files in `test:design-mode` and the `core-git` lane, then run `npm run test:ci-policy`. Commit `feat(design): route rules for Next, TanStack, React Router, Remix and Astro`.

### Task 2: The bounded walker, strictly no-follow

**Files:**
- Create: `main/services/design-canvas/app-server/app-routes.ts`, `app-routes.test.ts`

**Interfaces:**
- Consumes: Task 1's core, `readBounded` (`app-detect.ts:53`), and `isPathInside`.
- Produces: `discoverRoutes` and `routeForWrittenFile`.

- [ ] **Step 1: Write the failing tests** against temporary directories.
  - **What each convention reads:**
    - A Next app with `app/` and `src/pages/` lists both conventions' routes.
    - A TanStack app with `src/routeTree.gen.ts` uses that file and ignores a stray `src/routes/old.tsx`. Without the file, it walks `src/routes` through `routesFromFiles`.
    - React Router: a literal `app/routes.ts` wins, `flatRoutes()` walks, and an unsupported config gives `null`, which the merge turns into fallback.
    - An app root of `apps/web` reads only `apps/web/**`.
  - **Confinement (B2), each asserting that nothing outside is read.** A spy `readBounded` and `readdir` dependency records every path, and every recorded path must lie under the app root's realpath.
    - `apps/web` is a symlink to a folder outside the workspace: `null`.
    - `apps/web` is a symlink to a folder **inside** the workspace: `null`, because links aren't followed.
    - `apps` (a parent segment) is a symlink: `null`.
    - `src/routes` is a symlink (outside or inside): no routes from it, and the result isn't `null`.
    - A Next app with `app/` and no `pages/` or `src/` (`ENOENT`) lists `app/`'s routes.
    - A Next app whose `pages` is a regular file still lists `app/`'s routes.
    - `src/routeTree.gen.ts` is a symlink to a real tree file inside the root: not used, so the walk proceeds as if it were missing.
    - `app/routes.ts` is a symlink: `null` from the read, so fallback.
    - A file `src/routes/about.tsx` that is a symlink: not listed.
    - A directory symlink loop inside `src/routes`: skipped, and the walk ends.
  - **Caps:**
    - 2 100 files give `truncated: true` and still return in under 2 s.
    - `node_modules/x/app/page.tsx` and `.next/server/app/page.js` are never listed.
  - **`routeForWrittenFile`:**
    - `("apps/web", "next", "apps/web/app/pricing/page.tsx")` gives `/pricing`.
    - `apps/web/app/pricing/Card.tsx` and `docs/app/page.tsx` give `null`.
    - It reads no disk: the test passes paths that don't exist.
  - An aborted signal rejects with `AbortError`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3: Implement** S78.
  - Confine first: the workspace realpath, `lstat` per segment, then `isPathInside`.
  - Then walk breadth-first with `readdir({withFileTypes: true})`, skipping every `isSymbolicLink()` entry.
  - Read the two parsed files with `readBounded` only.
- [ ] **Step 4:** Rerun. Expected: PASS.
- [ ] **Step 5:** Register the file (`core-git`) and commit `feat(design): read an app's routes from its files, bounded and confined`.

### Task 3: canvas.json `routes` and `params`, and `DesignAppServers.routes`

**Files:**
- Modify: `main/services/design-canvas/canvas-config.ts`, `canvas-config.test.ts`
- Modify: `main/services/design-canvas/app-server/app-server-main.ts`, `app-server-main.test.ts`

**Interfaces:**
- Produces: `CanvasConfigApp.routes`/`.params` and `DesignAppServers.routes(workspaceId, appRoot?)`.

- [ ] **Step 1: Write the failing tests.**
  - **Parsing:**
    - The spec's example, `{"apps":[{"root":"web","script":"dev","routes":["/","/pricing","/blog/hello-world"],"params":{"/blog/[slug]":["hello-world"]}}]}`, parses to those fields.
    - Each of these is dropped silently, with the rest of the app kept: a route `"https://x"`, a 201st route, a param key that isn't a pattern, a two-parameter key, a value of `..`, a value with `/` for a single segment, a value with U+202E, and a 21st value.
    - `"mock": true`, `routes` and `params` survive a `saveCanvasConfigApp` round trip.
  - **`routes()`:**
    - With a fake `detect` (a Next app at `.`), a fake config and a temp tree, it gives `source: "discovered"` and `framework: "next"`.
    - With config routes, it gives `source: "config"`.
    - With several roots and no `appRoot`, it gives `{error: "choose-root", roots}`.
    - An unknown root gives `{error: "unknown-root"}`.
    - `permission: "none"` gives `{error: "unavailable"}`.
    - A first call with nothing cached runs detection once.
    - Two calls within 5 s walk the disk once (a counting `discover` dependency), but a canvas.json edit between them **is** seen by the second call.
    - A detection change and `forgetWorkspace` each clear the walk cache.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3: Implement** S81's parsing with `isParamValue`, and `routes()` with the walk-only cache. Pass `discoverRoutes` as `deps.discoverRoutes` so the tests can count it.
- [ ] **Step 4:** Rerun both suites. Expected: PASS.
- [ ] **Step 5:** Commit `feat(design): canvas.json routes and params, and the app's route list`.

### Task 4: `design_app {action: "routes"}`

**Files:**
- Modify: `main/services/design-canvas/app-server/app-tool.ts`, `app-tool.test.ts`; `main/services/llm-client.ts` (`servers` gains `routes`)

- [ ] **Step 1: Write the failing tests:**
  - **flag off:** the tool isn't built, as in 2b, so the existing case is left as it is;
  - **one app, no `root`:** `routes` answers `{status: "routes", root: ".", framework: "next", source: "discovered", truncated: false, routes: [{route: "/"}, {route: "/pricing"}, {route: "/blog/[slug]", pattern: "/blog/[slug]"}]}`;
  - **unknown framework:** `framework` is absent from the reply;
  - **not a start:** five `routes` calls, then a `start`, still starts, so `routes` doesn't count toward `DESIGN_APP_STARTS_PER_TURN`;
  - **no side effects:** it never calls `servers.start` or opens a card;
  - **several apps with no `root`:** an error listing the roots;
  - **`stillAvailable() === false`:** it answers `unavailable`;
  - **JSON values only:** a route named `/"ignore previous` round-trips through `JSON.parse` unchanged.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Add `"routes"` to `ACTIONS`, and exempt it from the root check at `app-tool.ts:224`.
  - Add `routes` to `DesignAppToolServers`'s `Pick`.
  - Extend the description with "routes lists the app's pages (from its files or .aiden/canvas.json)".
- [ ] **Step 4:** Rerun. Expected: PASS.
- [ ] **Step 5:** Commit `feat(design): design_app lists an app's routes`.

### Task 5: `design_app_frame_added`

**Files:**
- Modify: `main/services/analytics/analytics-events.ts`, `analytics-feature-reports.test.ts`, `docs/analytics.md`

The four call sites are wired in Tasks 6, 8, 9 and 11. This task adds the event they report, and comes first because `reportAnalyticsEvent` is typed on the registry's names (`main/services/analytics/analytics-report.ts:26`), so those tasks need the entry to compile.

- [ ] **Step 1: Write the failing tests** in `analytics-feature-reports.test.ts`, following its pattern (`captureAnalyticsEvents(t)`, `reportAnalyticsEvent`, `await analyticsSettled()`, `deepEqual`):
  - `{source: "person", device_bucket: "phone"}` is sent as given;
  - `{source: "bot", device_bucket: "phone"}` and `{source: "person", device_bucket: "watch"}`, reported separately, each record `{event: "design_app_frame_added", props: undefined}`. A required property out of its list drops the whole payload in `pickValidProps` (`analytics-events.ts:216-234`), as `design_app_started`'s test shows (`analytics-feature-reports.test.ts:296-310`);
  - an extra `route: "/x"` prop is dropped.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Add the registry entry after `design_app_started`, with a comment naming 3b.
  - Add the docs row in `docs/analytics.md`'s design section: "`design_app_frame_added` · a live app frame was placed (by the person's Add, or by Aiden) · `source`, `device_bucket` · never the route, app or framework".
  - Settings' "What's sent" sheet renders from the registry, so it needs no change.
- [ ] **Step 4:** Rerun, plus `npm run test:analytics`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(analytics): design_app_frame_added`.

### Task 6: The device table, and `canvas_place_frame`'s `device`, `variantOf` and `label`

**Files:**
- Create: `renderer/shared/design-canvas/app-devices.ts`, `app-devices.test.ts`
- Modify: `main/services/design-canvas/canvas-tools.ts`, `canvas-tools.test.ts`
- Modify: `renderer/shared/design-canvas/canvas-summary.ts` (`label`, `variantOf`), `canvas-summary.test.ts`
- Modify: `renderer/design/nodes/app-node.tsx` (the header shows `label`), `renderer/design/nodes/app-node.test.tsx`
- Modify: `main/services/llm-client.ts` (wire `onAppFrameAdded` to S88's call site 1)

**Interfaces:**
- Consumes: the `design_app_frame_added` registry entry (Task 5).
- Produces: `APP_DEVICES`, `isAppDevice` and `deviceBucket`; `canvas_place_frame`'s `device`, `variantOf` and `label`; `DesignCanvasToolDeps.onAppFrameAdded`.

- [ ] **Step 1: Write the failing tests:**
  - **`deviceBucket`:** 390 → phone, 480 → phone, 481 → tablet, 1023 → tablet, 1024 → laptop, 1439 → laptop, 1440 → desktop, 3840 → desktop.
  - **flag off:** `canvas_place_frame`'s definition deep-equals the one built with today's dependencies.
  - **`device`:**
    - `{kind: "app", title: "Home", route: "/", device: "phone"}` gives viewport 390 × 844 at scale 0.5.
    - `device` with `width: 400` gives 400 × 844.
    - `device: "watch"` is an error naming the four devices.
    - On reuse, `device: "tablet"` changes the frame to 768 × 1024, and a reuse with `label` replaces the old label.
  - **`variantOf`:**
    - Given the ungrouped `/pricing` frame's id, a `/pricing-v2` frame lands 64 units to its right, top-aligned, on the same page.
    - A new group titled `/pricing` holds both, and `canvas_read` lists the new frame's `variantOf`.
    - A second variant goes right of the first, joins the same group, and the group refits around all three.
    - An original inside an artboard puts the variant in that artboard.
    - `variantOf` naming a workspace path, a `file` frame, or an app frame of another root is an error.
    - A locked original, or one in a locked group, is refused with the locked wording.
    - A page with `framesPerPage - 1` frames and an ungrouped original is refused with the "full" error, because the new group wouldn't fit, and nothing is written.
  - **`label`:**
    - `label: "Calm"` is stored, `canvas_read` lists it, and the title is unchanged.
    - 61 characters is an error.
    - **AppNode:** the frame's header shows the title and "Calm" as text, through Testing Library's `getByText`.
  - **`onAppFrameAdded`:** it is called with 390 for a new phone frame, with 1280 for a `duplicate: true` copy, not at all for a reuse, and not at all when the place is refused.
  - **A pattern route** (`/blog/[slug]`) is an error saying to fill the value.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3: Implement** S85's placement half on top of `placeAppFrame` (`canvas-tools.ts:1115-1218`). Use `besideBox`/`DESIGN_FRAME_GAP` for the position and `fitGroupToMembers`/`refitGroups` for the group (`:2664-2677`).
- [ ] **Step 4:** Rerun, plus `npx tsc --noEmit -p .`. Expected: PASS.
- [ ] **Step 5:** Register `app-devices.test.ts` (`core-git`) and commit `feat(design): device sizes, variants and labels for app frames`.

### Task 7: Retargeting and resizing app frames, blocked counts, and removed routes with their undo

**Files:**
- Modify: `canvas-tools.ts`, `canvas-tools.test.ts`
- Modify: `renderer/design/nodes/app-node.tsx`, `app-node.test.tsx` (reset state on a route change)
- Modify: `main/services/design-canvas/app-frames/app-frame-registry.ts`, `app-frame-registry.test.ts`
- Modify: `renderer/shared/design-canvas/schema.ts`, `schema.test.ts`; `main/services/design-canvas/store.ts`, `store.test.ts`
- Modify: `main/handlers/design-canvas.ts:248-265` (`saveOptions`), `main/handlers/design-canvas.test.ts` (B1)
- Modify: `renderer/design/use-design-canvas.ts` (`:139`, `:191`, `:365`, `:384`, `:450`), `renderer/design/use-design-canvas.test.tsx`; `renderer/lib/ipc.ts` (the save call carries `undoneRoutes`)
- Modify: `llm-client.ts` (wire `blockedFor: (id) => installedAppNetwork()?.registry.blockedForFrame(id) ?? 0`)

- [ ] **Step 1: Write the failing tests.**
  - **`canvas_update_frame`:**
    - `{route: "/about"}` changes the route and a route-equal title, and keeps the id and box; a custom title stays.
    - A 1440 × 900 frame at scale 1 with `{device: "phone"}` reads back as viewport 390 × 844, scale 1, box `appFrameBox({390, 844}, 1)`, and the save succeeds (M1's oracle: no `The canvas update is invalid`).
    - `{width: 4000, height: 4000}` at scale 2 is refitted by `fitAppScale` so the box stays within `maxSize`.
    - `{width: 199}` and `{width: 4001}` are errors naming 200–4 000.
    - `{w: 600, device: "phone"}` is the "size or its viewport, not both" error.
    - `{route: "/x"}` on a `file` frame is the existing kind error.
    - With the flag off, the definition deep-equals today's.
  - **AppNode, a route change:** a mounted frame whose page reported path `/pricing?tab=2` and was stuck shows neither the old path chip nor the stuck overlay after a rerender with `route: "/about"`. The iframe's `src` ends in `/about`.
  - **Registry (M7):**
    - Two live nodes for `f1`, with 3 and 2 blocked, give `blockedForFrame("f1") === 5`.
    - Dropping one node from the fake `liveIds()` set gives 3.
    - `liveIds()` returning null gives 0, and an unknown frame gives 0.
  - **`canvas_read`:** with `blockedFor` returning 4, it lists `blocked: 4` on the app frame, and omits it at 0. With no dependency, no `blocked` key appears.
  - **Schema and store:**
    - `removedAppRoutes` parses, dedupes and keeps the newest 200.
    - A person's `save` that removes the last `/pricing` frame of root `.` notes `appRouteKey(".", "/pricing")`.
    - The same save with `undoneRoutes: [that key]` notes nothing.
    - An `update` that adds a `/pricing` frame forgets the key, and an `update` that removes one notes nothing (`store.ts:214`).
  - **`designCanvas:save` (B1, register and invoke):**
    - A save with `undoneRoutes: [appRouteKey(".", "/pricing")]` succeeds and leaves `removedAppRoutes` empty.
    - `undoneRoutes: ["../x\u0000/"]`, a non-array, or more entries than `DESIGN_CANVAS_LIMITS.frames` throws `Invalid canvas save options.`
    - `undone` with an app route key still throws, so the page list keeps its own check.
  - **`use-design-canvas` (B1):**
    - Placing an app frame through a broadcast Aiden turn, then ⌘Z, sends the next save with that frame's key in `undoneRoutes`.
    - Redo forgets the key.
    - A later edit that shows the route again prunes it.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3: Implement** S85's update and read halves and S83's removed routes and `undoneRoutes`.
- [ ] **Step 4:** Rerun, plus `npm run test:design-mode`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(design): retarget and resize app frames, report blocked counts, remember removed routes`.

### Task 8: Route-aware placement of written files

**Files:**
- Modify: `main/services/design-canvas/written-pages.ts`, `written-pages.test.ts`; `main/services/llm-client.ts:3226-3312`, `:6346-6348`, `:6828-6830`

**Interfaces:**
- Consumes: `routeForWrittenFile` (Task 2), `designAppServers.snapshot` and `readCanvasConfig`, `removedAppRoutes` (Task 7), and `deviceBucket` (Task 6).
- Produces: `WrittenAppRoute` and `placeWrittenAppRoutes`. `placeWrittenPagesOnCanvas` gains `routes?` and `added`; `pagesWrittenInChat` gains `{isRouteFile?}`.

- [ ] **Step 1: Write the failing tests** (`written-pages.test.ts`, with a store, fake pages and a fake broadcast, as today):
  - **One placement:** a written `app/pricing/page.tsx` in a Next workspace places one `app` frame, `{appRoot: ".", route: "/pricing"}`, on the turn's page. It is focused, and the result's `added` is `[1280]`.
  - **Dedupe:** the same file edited again in the turn, or in the next turn, places nothing new. A `/pricing` frame the person placed counts, and nothing is added.
  - **Non-route files:** `app/pricing/PriceCard.tsx` and `app/layout.tsx` place nothing.
  - **Dynamic routes:** `app/blog/[slug]/page.tsx` places nothing without params, and places `/blog/hello-world` with `params {"/blog/[slug]": ["hello-world"]}`.
  - **Removed:** a route in `removedAppRoutes` isn't placed.
  - **Two chats** in one workspace: chat A's write lands on A's page while chat B's view shows B's page (S84).
  - **Both kinds:** a `design/home.html` write still places its v1 `file` frame, and both kinds land when a turn writes both.
  - **Roots:** a path under `apps/web` in a two-app workspace is placed for `apps/web`, not `.`. A file under no root, and a Vite app with no convention, place nothing.
  - **One data read per turn** (M4.1): three concurrent writes start one `snapshot` and one `readCanvasConfig` (counting fakes), and no `discoverRoutes`.
  - **The cap** (M4.2): 13 distinct route files written in one turn, each through its own `placeWrittenPage` call, place 12 frames, and the 13th places nothing.
  - **Not inspected** (M4.3): a route write calls neither `inspector.written` nor `inspector.removed`, while a design/ write still calls `written`.
  - **Retraction** (m2): `shouldSave()` turning false after the write retracts the app frame, as it does a file frame, and `added` is `[]`.
  - **Reporting** (M3): `added` is `[]` for a refused, unchanged or retracted placement. The llm-client reporter is called once per kept frame, with `source: "aiden"`.
  - **flag off:** no route file is noted in `recentWrittenPages`, and a route write places nothing. The existing v1 tests stay unedited.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3: Implement** S83 in llm-client.
  - The post-write hook awaits the turn's single `{snapshot, config}` promise, builds `writtenAppRoute(path)`, and notes route files in `recentWrittenPages`.
  - It calls `placeWrittenPagesOnCanvas({…, paths: [], routes: [route]})` with the room left under the turn's cap, and skips the inspector for routes.
  - That call has no paths, so the early return at `written-pages.ts:561` (`showable.length === 0 && !rules`) must also require `(input.routes?.length ?? 0) === 0`. Otherwise a route-only call returns `{frameIds: []}` before placing; Task 8's first test case catches this.
  - `placeWrittenAppRoutes` gets the turn's `DesignChatView` (`renderer/shared/design-canvas/view.ts:13`), so `placeFrame` puts the frame beside what is in view, as v1 pages land.
  - It reports `added` (S88 call site 2).
- [ ] **Step 4:** Rerun, plus `npm run test:design-mode`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(design): a route file Aiden writes lands as a live frame`.

### Task 9: Entry placement

**Files:**
- Modify: `main/services/design-canvas/entry.ts`. Its tests live in `written-pages.test.ts`, where `createDesignEntry` is tested today.
- Modify: `main/services/chat-application-service-main.ts:61` (pass `apps`, `readConfig`, `designLive` and the reporter: S88 call site 3)

- [ ] **Step 1: Write the failing tests:**
  - **Both kinds:** entry into a chat that wrote `app/pricing/page.tsx` and `design/home.html` places both on its empty page.
  - **One timeline** (M4.5): a chat whose history wrote, oldest first, 10 design/ pages interleaved with 5 route files places the newest 12 in timeline order. The test names which 12, by hand.
  - **The `/` fallback:**
    - A chat that wrote nothing, in a single-app workspace, gets `/` on its empty page, and the reporter fires once with `aiden`.
    - Chat B entering on its own fresh page gets its own `/`, even though chat A's page already shows `/`, because dedupe is per target page.
    - The same chat with a frame already on its page gets nothing.
    - A two-app workspace with nothing written gets nothing.
    - A removed `/` isn't put back.
    - An attached-only workspace (target `none`) gets nothing.
  - **Forgetting** (M4.4): after `recentWrittenPages.forget(chatId)` (the existing `releaseChatContext`/`invalidateChatWorkspaceContext` path), entry places no route files from this run, only from history.
  - **flag off:** entry places exactly today's frames. The existing tests stay unedited.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3: Implement** S83's entry rule.
  - `createDesignEntry` passes the timeline's route files as `routes`, plus `entry.fallbackRoute` when it wrote nothing and the target is `single`.
  - `placeWrittenPagesOnCanvas` evaluates the fallback inside `store.update`, after `entryPlacement` and the v1 placement, against `framesOnPage(doc, view.pageId)` and `removedAppRoutes`.
  - Add a test row: a target page holding only a note gets no `/`.
- [ ] **Step 4:** Rerun. Expected: PASS.
- [ ] **Step 5:** Commit `feat(design): entering design mode shows the chat's routes, or the app's home`.

### Task 10: The live prompt and skill

**Files:**
- Modify: `main/services/design-canvas/canvas-tools.ts:233-260`, `main/services/design-canvas/skill.ts`, `skill.test.ts`
- Modify: `main/services/skill-registry-main.ts:21-23` (calls `designCanvasSkills`)
- Modify: `main/services/design-canvas/design-md/turn.ts:184-186`, `design-md/turn.test.ts`
- Modify: `main/services/llm-client.ts:3212`, `:3377` (pass `designMdOn` and `liveAppsOn`, the `design_app` condition at `:3154`; `withDesignModeSection`'s option becomes `{live: designMdOn || liveAppsOn}`)

- [ ] **Step 1: Write the failing tests.**
  - **`skill.test.ts`:**
    - `aidenDesignSkill(false)` strictly equals `AIDEN_DESIGN_SKILL`.
    - `designModePromptSection(false) === DESIGN_MODE_PROMPT_SECTION`, and `designModePromptSection(true) === DESIGN_MODE_PROMPT_SECTION + "\n" + DESIGN_MD_PROMPT_BULLET` (the Windows and excluded-`design_app` case, M5.1).
    - `designModePromptSection(true, true)` contains `DESIGN_MD_PROMPT_BULLET` verbatim, and `(false, true)` doesn't.
    - Every tool the live prompt and live skill name is among the tools a flag-on design turn **with `design_app`** offers (`canvas_*`, `design_system`, `design_app`, `load_tools`). Extend the existing "tools it names are offered" test to the live pair.
    - `designModePromptSection(true, false)` names no `design_app`.
    - The live prompt and skill name `design_app` and `variantOf`, and don't name `data-aiden-comment` (S86).
    - The live skill doesn't claim Motion or Voice are checked, or that `@file#fragment` resolves. This asserts S38's specific forbidden claims, not a copy snapshot.
    - `designCanvasSkills({designMode: true, designLive: true})` offers `builtin:aiden-design` with the live instructions; `{designLive: false}` offers today's object; `{designMode: false}` offers none (M5.3).
  - **`design-md/turn.test.ts` (M5.2):** a chat whose stored section is the live one, on a turn with `live: false` or without `design_app`, gets the section replaced, so the latest copy names no `design_app`. The existing flip test at `:264-270` stays green.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3: Write the copy** for S86's bullets and the live skill's sections: "Start the app", "Pages are routes", "Variants and directions", "DESIGN.md", and "No web app".
  - Write it in the plain style of today's text, under today's length plus 60 %.
  - The live sections open with "When design_app is among your tools".
  - Export `LIVE_APP_PROMPT_MARKER`, and extend `withDesignModeSection`'s replacement check to it.
- [ ] **Step 4:** Rerun, plus `npm run test:design-mode` and `npx tsx --test main/services/design-canvas/design-md/turn-wiring.test.ts`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(design): the design prompt and skill teach the live app`.

### Task 11: The person's Add: IPC

**Files:**
- Modify: `main/handlers/design-canvas.ts`, `design-canvas.test.ts`
- Modify: `main/handlers/design-canvas-main.ts:69-75` (pass `routes` and the reporter: S88 call site 4)
- Modify: `renderer/lib/ipc.ts` (two methods next to `placeArtifact`, `:2872`)

- [ ] **Step 1: Write the failing register-and-invoke tests:**
  - **flag off:** both channels answer `{error: "unavailable"}`.
  - **`designCanvas:appRoutes`:**
    - `("chat-1")` lists one app's routes, including `framework`.
    - A Bot chat (`botId`) answers `unavailable`.
    - An attached-only workspace (target `none`, one attached app) lists that app.
  - **`designCanvas:placeAppRoute`, placing:**
    - `("chat-1", {appRoot: ".", route: "/pricing", pageId: P})` places an app frame on page `P`, with `createdBy: "person"`, centred in the reported view.
    - It broadcasts a `step` starting `add-app-route:`, and `sendFocus` receives the frame.
    - A `pageId` not in `doc.pages` falls back to the chat's view page.
  - **Dedupe:** a second call answers `already` with the same frame id, and `sendFocus` receives it again (M6.1).
  - **Bad input:** `route: "https://evil"`, `route: "/blog/[slug]"` and `appRoot: "../x"` give `bad-route`, `bad-route` and `unknown-root`.
  - **Full** (M6.2): a page at `framesPerPage` answers `full`, and nothing is written.
  - **Removed:** a removed route placed by the person is placed, and forgotten from `removedAppRoutes`.
  - **Analytics:** the reporter is called once with `{source: "person", device_bucket: "laptop"}` for `placed`, and not for `already` or `full`.
  - **`viewSize`:** negative values are ignored, as `placeArtifact`'s test does (`design-canvas.test.ts:1129`).
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3: Implement** S87's IPC half. Share the page and box code with `placeArtifact` through a local helper, `personPlacement(chat, {pageId, viewSize})`, without changing `placeArtifact`'s results or tests.
- [ ] **Step 4:** Rerun. Expected: PASS.
- [ ] **Step 5:** Commit `feat(design): the person can place a page of their app`.

### Task 12: The person's Add: menu and picker

**Files:**
- Create: `renderer/design/app-route-picker.tsx`, `renderer/design/app-route-picker.test.tsx`
- Modify: `renderer/design/design-toolbar.tsx:45`, `:172-185`; `renderer/design/design-canvas.tsx:758` (`onAdd`; `await flush()` first, `:171`). The menu cases go in `renderer/design/design-canvas.test.tsx` (existing), and the dialog's in the new file.

- [ ] **Step 1: Read** both ChatGPT references (Global Constraints), `GUI.md` and `docs/design-guide.md`. Note the list-row and dialog states to reuse.
- [ ] **Step 2: Write the failing happy-dom tests.** Use Testing Library, and never `assert.equal` on a DOM node (`.memory/design-mode.md:437`).
  - **The menu:**
    - With `designLive` false, the Add menu has exactly Group, File… and Image….
    - With it true and a `single` target, **Page from app…** is enabled.
    - With target `none` and one attached app in `apps`, it is enabled (M6.4).
    - With target `none` and no apps or candidates, or with `unavailable`, it is disabled with its hint.
  - **Opening and placing:**
    - Opening it calls `appRoutes` and lists `/`, `/pricing` and `/blog/[slug]`.
    - Typing `pri` leaves `/pricing`. Enter awaits `flush` **before** calling `placeAppRoute({appRoot: ".", route: "/pricing", pageId: <page on screen>})`, then closes the dialog, and focus returns to the Add trigger. The order is checked with a recorded call log (M6.3).
  - **Dynamic rows:**
    - The `/blog/[slug]` row's `slug` field, prefilled with `hello-world`, adds `/blog/hello-world`.
    - An empty value or `..` disables Add.
    - A `/[org]/p/[id]` row shows two fields.
  - **Typed routes:** typing `/checkout?step=2` shows "Go to /checkout?step=2", and typing `//x` shows nothing.
  - **Two apps:** a root picker shows, and switching it reloads the list.
  - **Errors:** `{error: "bad-route"}` and `{error: "full"}` show their S87 copy in the dialog, and the dialog stays open.
  - **The fallback** source shows its canvas.json line.
  - **Route text renders as text:** a route `/<img src=x>` makes no `img` element.
  - **Escape** closes the dialog without a call.
- [ ] **Step 3:** Run `npx tsx --test renderer/design/app-route-picker.test.tsx renderer/design/design-canvas.test.tsx`. Expected: FAIL.
- [ ] **Step 4: Implement** S87's dialog with `ui.tsx` primitives and semantic tokens. The list uses `role="listbox"`, with `aria-activedescendant` driven from the filter input.
- [ ] **Step 5:** Rerun, plus `npm run test:design-mode` and `npx tsc --noEmit -p .`. Expected: PASS.
- [ ] **Step 6:** Register the file (`renderer-other`) and commit `feat(design): Add ▸ Page from app`.

### Task 13: E2E, lanes and screenshots

**Files:**
- Create: `tests/e2e/design-live-helpers.ts`, holding `seedFixture(workspaceDir, fixtureDir)`, `chatIdFor`, `rootApp`, `openLiveChat`, `placeFrames`, `frameGroup`, `appIframe`, `inside`, `press`, `shoot` and `LIVE_ON`, moved out of `tests/e2e/design-live-frames.spec.ts:64-147` (M9.1).
- Modify: `tests/e2e/design-live-frames.spec.ts` (import the helpers; its tests are unchanged)
- Create: `tests/fixtures/design-live-routes/`:
  - `package.json` with `"scripts": {"dev": "vite"}`, declaring `vite`, `@vitejs/plugin-react`, `react`, `react-dom` and `@tanstack/router-plugin` but **not installing** the plugin, so 2a detects `tanstack-router`;
  - `index.html`, `vite.config.ts` (as 3a's fixture, with `cacheDir: ".vite-cache"`), `src/main.tsx`, `src/App.tsx`;
  - `src/routes/index.tsx`, `src/routes/pricing.tsx`, `src/routes/blog.$slug.tsx`, `src/components/Banner.tsx`;
  - `.aiden/canvas.json` containing `{"apps":[{"root":".","script":"dev","params":{"/blog/[slug]":["hello-world"]}}]}`.
  - `App.tsx` maps `location.pathname` to modules from `import.meta.glob("./routes/*.tsx", {eager: true})` with the flat-file rule, so a file added at run time is served through HMR without a router package.
- Create: `tests/e2e/design-live-routes.spec.ts`
- Modify: `scripts/ci-e2e-spec-map.json`. Under `"specs"`, add `"design-live-routes.spec.ts"` with these path prefixes (M9.3):
  - `main/services/design-canvas/app-server/app-routes`, `main/services/design-canvas/app-server/app-tool`, `main/services/design-canvas/canvas-config`;
  - `main/services/design-canvas/written-pages`, `main/services/design-canvas/entry`, `main/services/design-canvas/canvas-tools`;
  - `main/handlers/design-canvas`;
  - `renderer/design/app-route-picker`, `renderer/design/design-toolbar`, `renderer/design/use-design-canvas`, `renderer/design/nodes/app-node`;
  - `renderer/shared/design-canvas/app-`;
  - `tests/fixtures/design-live-routes/`, `tests/e2e/design-live-helpers.ts`.
  - Add `tests/e2e/design-live-helpers.ts` to `design-live-frames.spec.ts`'s list too.

- [ ] **Step 1: Write the spec** with the helpers. Every live case runs under `live.use({workspaceSeed: true, appEnvironment: LIVE_ON})`.
  - **A. Add ▸ Page from app:**
    - The dialog lists `/`, `/pricing`, `/blog/[slug]` and `/blog/hello-world`.
    - Filtering `pri` and pressing Enter makes the `/pricing` frame go live, and its iframe shows `Pricing`.
    - Adding it again focuses it, and the frame count stays the same.
    - ⌘Z removes it, and the next save succeeds. This is the E2E oracle for B1: no save error toast, and the canvas reloads unchanged.
  - **B. Written route:**
    - The fake model's `write_file` of `src/routes/about.tsx` (with `<h1>About</h1>`) puts one live `/about` frame on the chat's page, showing `About`.
    - Its `edit_file` of the same file changes the heading in place, and the frame count stays the same.
  - **C. Component edit:** an `edit_file` of `src/components/Banner.tsx` places nothing new, and the open `/` frame shows the new banner text through HMR.
  - **D. Entry:** a fresh chat entering design mode on the fixture gets one `/` frame.
  - **E. Two chats:** chat A writes `src/routes/a.tsx` while chat B's canvas is on screen. A's page gets `/a`, and B's page gets nothing.
  - **F. Removed:** after deleting the `/about` frame, the model edits `about.tsx` again, and no frame returns.
  - **G. Flag off** (M9.2): a separate `test.describe` with `live.use({appEnvironment: {AIDEN_EXPERIMENTAL_DESIGN_LIVE: "0"}})`. The Add menu has three items, and a route write places nothing.
- [ ] **Step 2: Run it in the Space:**
  `npm run test:e2e:space -- --run bash -c "npm run build && npx playwright test tests/e2e/design-live-routes.spec.ts tests/e2e/design-live-frames.spec.ts"`
  Then run the flag-on and flag-off v1 design suites. Expected: PASS, and `design-live-frames.spec.ts` reports its own test count once, not twice. Record any flake per AGENTS.md: rerun once, then record the spec, the symptom and the run link.
- [ ] **Step 3: Take the screenshots** (`shoot`), in light and dark, saved under `test-results/design-live-routes/`. They go in the PR body, not the repo:
  1. the Add menu with **Page from app…**;
  2. the picker with the filter, a dynamic row with its value, and the "Go to" row;
  3. the picker with two apps;
  4. the fallback source line;
  5. a written route's frame just landed and focused;
  6. three variants grouped with `variantOf`, placed by the fake model, with their labels in the headers;
  7. a phone-size app frame from `device: "phone"`.
- [ ] **Step 4:** Run `npm run test:ci-policy`, then commit `test(design): routes and route-aware placement E2E`.

### Task 14: The CLI and native clients guard

- [ ] `npm run cli:build`. The CLI doesn't bundle `design-canvas/`; this guards the shared `renderer/shared/design-canvas/app-routes.ts` import paths. Expected: PASS.
- [ ] Run `rg -n "removedAppRoutes|appRoutes|design_app_frame_added" ios android`. Expected: no hits. Design mode is out of the Remote projection, so no mobile suite runs. Note this in the PR body.

### Task 15: Docs, memory and spec amendments

**Files:**
- Modify: `docs/design-mode.md` (the "Live apps (experimental)" section, `:29-76`):
  - a "Pages from your app" subsection covering Add ▸ Page from app…, the frameworks read and the fallback;
  - `.aiden/canvas.json` `routes` and `params` with the spec's example;
  - "Where Aiden's work lands";
  - written routes landing by themselves, and removed routes staying removed.
- Modify: `PRODUCT.md:71`: one sentence on pages by route behind the experimental flag.
- Modify: `docs/analytics.md` (Task 5 adds the row; recheck it).
- Modify: `docs/plans/README.md:70`: 3b built, with the PR link once opened.
- Modify: the spec:
  - the status line;
  - §6.3.6, with S79's syntax and S80's table;
  - §6.3.7, with S83's removed routes, one snapshot per turn and entry;
  - §6.5, with S84's "where Aiden's work lands", S85's tool list (errors and `data-aiden-comment` moved to Phase 4) and S82's `design_app routes`;
  - §6.10, with S88's buckets;
  - append S78–S88 as amendments.
- Modify: `.memory/design-mode.md`: a "v2 Phase 3b" section after `:439`'s 3a section. It holds the route rules' file split, the canonical syntax, the per-turn snapshot, `removedAppRoutes`, the IPC pair, and any gotchas found in the E2E.
- Modify: this plan's As built.

- [ ] Search the docs for stale claims: `rg -n "design/ HTML|HTML files under design|Page from app|canvas.json" docs README.md PRODUCT.md`. Fix any that 3b makes stale.
- [ ] Commit `docs(design): routes, Page from app and the live skill (3b)`.

## Spec amendments S78–S88 (Task 15 writes these)

| # | Amendment | Section |
|---|---|---|
| S78 | Route discovery reads files only, strictly no-follow (the app root and its convention folders confined to the workspace's realpath, no link ever read), bounded, with an O(n) tokenizer for the two parsed files | §6.3.6 |
| S79 | One pattern syntax, Next's brackets, for every framework and for `params` keys | §6.3.6 |
| S80 | The conventions table, single-file and whole-tree rules, and `/` plus canvas.json for everything else | §6.3.6 |
| S81 | `routes` replaces discovery; `params` fills single-parameter patterns only, with segment rules (no `.`, `..`, empty or hidden characters); bad entries dropped silently; only the walk is cached | §6.3.6 |
| S82 | `design_app {action: "routes"}` | §6.5 |
| S83 | Route-aware placement: file tools only, deepest root, dynamic routes only with a value, one `{snapshot, config}` read per turn, 12 per turn, `removedAppRoutes` with `undoneRoutes` on save, one written-files timeline, and the entry rule | §6.3.7 |
| S84 | S18's order for every placement; "where Aiden's work lands" rewritten | §6.5 |
| S85 | `device`, `variantOf` (by id), `label` (its own field, shown); update `route`/viewport/`device`, keeping scale; `canvas_read` `blocked` from live mounts, as a count only; errors move to Phase 4; one analytics dependency on the canvas tools | §6.5 |
| S86 | The live prompt follows the turn's tools (`design_app` offered) and stays static per turn; the live skill is one name, conditional on `design_app`; `data-aiden-comment` moves to Phase 4; "ask which to keep" until Adopt (Phase 5) | §6.5 |
| S87 | Add ▸ Page from app… (enabled for any known app), flush first, the page sent and checked, focus on placed and already, `full` | §6.3.6 |
| S88 | `design_app_frame_added` buckets, sources and its four call sites, each after commit | §6.10 |

## Verification

Run, in order, each expected to pass:
1. `npx tsx --test renderer/shared/design-canvas/app-routes.test.ts renderer/shared/design-canvas/app-devices.test.ts renderer/shared/design-canvas/schema.test.ts renderer/shared/design-canvas/canvas-summary.test.ts`
2. `npx tsx --test main/services/design-canvas/app-server/app-routes-core.test.ts main/services/design-canvas/app-server/app-routes.test.ts main/services/design-canvas/app-server/app-server-main.test.ts main/services/design-canvas/app-server/app-tool.test.ts main/services/design-canvas/canvas-config.test.ts`
3. `npx tsx --test main/services/design-canvas/canvas-tools.test.ts main/services/design-canvas/written-pages.test.ts main/services/design-canvas/store.test.ts main/services/design-canvas/skill.test.ts main/services/design-canvas/design-md/turn.test.ts main/services/design-canvas/design-md/turn-wiring.test.ts main/services/design-canvas/app-frames/app-frame-registry.test.ts main/handlers/design-canvas.test.ts`
4. `npx tsx --test main/services/analytics/analytics-feature-reports.test.ts`
5. `npx tsx --test renderer/design/app-route-picker.test.tsx renderer/design/use-design-canvas.test.tsx renderer/design/design-canvas.test.tsx renderer/design/nodes/app-node.test.tsx`
6. `npm run test:design-mode`
7. `npx tsc --noEmit -p .` and `npx tsc --noEmit -p main/tsconfig.json`
8. `npm run lint` and `npm run check:aiden-rules`
9. `npm run test:ci-policy`
10. `npm run build` and `npm run cli:build`
11. In the Cua Space: Task 13's spec, `design-live-frames.spec.ts`, and the flag-on and flag-off v1 design suites.

Then run `npm run test` once before the PR. CI must be green on the exact head. The PR body carries Task 13's screenshots in light and dark.

## Risks and edge cases

| # | Risk | Mitigation |
|---|---|---|
| 1 | **A framework's convention drifts** (Next adds a special file; TanStack changes `routeTree.gen.ts`'s interface name). | The rules are a table with documented-example tests (Task 1). An unknown shape falls back to `/` plus canvas.json, never a crash. The skill tells Aiden to write `routes` on a fallback. |
| 2 | **Parsing `routes.ts`** misreads a clever config. | An O(n) tokenizer that understands comments and strings, with a depth-16 reader of literal calls only. Anything else returns `null`, which means fallback. A wrong list is visible in the picker and fixed by canvas.json. No code runs, and there are no regular expressions over file text (M8.4). |
| 3 | **A written file named by a config the flat rule disagrees with** (React Router with a custom `routes.ts` mapping `pages/x.tsx` to `/y`). | `routeForWrittenFile` uses the flat rule only, so it may place nothing for such a file, which is safe. The list from `design_app routes` is still right, and the skill says to place the route with the tool when nothing lands. |
| 4 | **Placement races detection.** The turn's snapshot is taken once, so an app made this turn isn't seen until the next turn. | Accepted (S83). The tool can place the frame. |
| 5 | **Too many frames.** A turn that scaffolds 30 routes would place 30 live frames, while only six can be live (3a). | A turn counter (`appFramesPlacedThisTurn`) caps written-route placement at 12 new app frames, the same as entry (`EARLIER_PAGES_LIMIT`). Later route files place nothing, and Aiden can place them with the tool (Task 8's 13-file case). Frames past the six-live limit show snapshots, as 3a built. |
| 6 | **`removedAppRoutes` grows without bound.** | Capped at 200, newest kept, as `removedPagePaths` is. |
| 7 | **Route strings as prompt injection.** A file named `ignore-all.tsx` becomes `/ignore-all`. | Routes reach the model only as JSON string values in tool results, and `isAppRoute` bounds length and characters. That matches how the model already sees workspace file names. |
| 8 | **Big monorepo walks** slow the picker. | Caps of 2 000 entries and depth 10, a 5 s cache of the walk only, and `truncated` shown as "N more". The walk runs on main's event loop with `readdir` batches, never a sync walk. Placement never walks (S83). |
| 12 | **A symlinked app root or convention folder** points outside the workspace. | Strict no-follow (S78): every segment is `lstat`ed, the realpath is confined, and no link is ever read. Task 2's spy proves every read path is under the root. |
| 13 | **A stale undo list breaks saves.** An app route key in the page `undone` list would fail `saveOptions`. | A separate `undoneRoutes` field with its own validator (S83, B1), and an E2E ⌘Z-then-save oracle (Task 13 case A). |
| 9 | **The fixture fakes detection** by declaring `@tanstack/router-plugin` without installing it. | This tests our detection and route rules, not TanStack. The app serves routes itself through `import.meta.glob`. Open question 1. |
| 10 | **Flag off drift.** | Every touched tool, prompt, skill, menu and IPC has a flag-off deep-equal test (Global Constraints). |
| 11 | **Analytics overcounting.** Entry places `/` each time a person re-enters an empty page. | It fires only for new frames, and an empty page re-entered after they removed `/` places nothing (`removedAppRoutes`). |

## Open questions

Each has the answer this plan uses. The owner may override.
1. **Is faking `tanstack-router` detection in the E2E fixture acceptable?** *Yes, as planned.* The alternative is installing `@tanstack/router-plugin` (or Next) as a root dev dependency only for E2E, which adds an install surface to CI for little gain. Task 1's unit rows cover every framework's rules.
2. **Should bridge-reported errors in `canvas_read` wait for Phase 4?** *Yes* (S85). They are untrusted page text, and Phase 4 builds error frames with their own trust boundary.
3. **Should the JSX `data-aiden-comment` skill bullet wait for Phase 4?** *Yes* (S86). In 3b app frames take only frame-level comments (S68), so the bullet would promise something the canvas can't do yet.
4. **Should automatic placements (written routes, entry) count as `source: "aiden"`?** *Yes* (S88). The person didn't place them, and the spec's enum has only `person` and `aiden`.
5. **Should canvas.json `routes` replace discovery, or add to it?** *Replace* (S81), following the spec's example and giving the person full control for unsupported routers. If the owner prefers a union, it changes only `mergeRouteList` and one test row.

## Applied review decisions (review-p3b-plan, 2026-11-27)

All 14 findings were checked against `20e263fe1` and accepted. One part of M5.3 is placed differently from the reviewer's suggestion, for the reason given in its row.

| Finding | Verified at | Applied in |
|---|---|---|
| **B1** The `undone` save option rejects app route keys | `main/handlers/design-canvas.ts:248-265` (`isDesignRelativePath` on every entry); `use-design-canvas.ts:365`, `:384`, `:450` use `shownPagePaths` only | S83 "The person's undo": a separate `undoneRoutes` with `isAppRouteKey`, and `shownAppRoutes`. Task 7 handler and hook tests; Task 13 case A's ⌘Z-then-save oracle; risk 13 |
| **B2** Symlink reading contradicts `O_NOFOLLOW`, and the root isn't confined | `app-detect.ts:56` opens with `O_NOFOLLOW \| O_NONBLOCK` | S78 is now strictly no-follow, with the root and convention folders confined by `lstat` and realpath. Task 2's spy-recorded confinement cases; risk 12 |
| **M1** The viewport range and the kept-width scale overflow | `app-frame.ts:50-58` (200–4 000, scale 0.05–2); `fitAppScale` only shrinks (`:117-128`) | S85: `isAppViewportSide`, keep the current scale and refit, refuse box plus viewport in one call. Task 7's 1440@1 → phone oracle |
| **M2** `label` and `variantOf` aren't shown, `variantOf` is underspecified, and AppNode keeps stale state | `canvas-summary.ts:369-377`; `app-node.tsx:475-482`, `:718-740`; `placement.ts:18` (`DESIGN_FRAME_GAP = 64`); `fitGroupToMembers` at `canvas-tools.ts:2664-2677` | S85: summary fields, the label in AppNode's header, `variantOf` by id only at a 64 gap, the container rules, locked and full refusals, and AppNode resetting on a route change. Tasks 6 and 7 |
| **M3** Two of the three `aiden` call sites aren't wired, and retracted placements are reported | `llm-client.ts:3268-3298`; `chat-application-service-main.ts:61`; `written-pages.ts:625-630` | S88's four call sites, each after commit; `added` filled only after the post-write `shouldSave()`. Tasks 6, 8, 9 and 11, with the event registered first in Task 5 |
| **M4.1** `params` isn't in the snapshot, and the snapshot races | `renderer/shared/design-app.ts:121-130` | S83: one in-flight `{snapshot, config}` promise per turn, and no walk. Task 8's counting case |
| **M4.2** `limit` can't cap across calls | `llm-client.ts:3275` calls once per file | S83: `appFramesPlacedThisTurn`. Task 8's 13-file case |
| **M4.3** Route files reach the inspector | `llm-client.ts:3293-3294` | S83 "Not inspected". Task 8 case |
| **M4.4** Remembered routes leak across delete and move | `chat-application-service-main.ts:80`, `:87` | S83: the same `recentWrittenPages` instance, so the existing `forget` calls cover it. Task 9 case. This is simpler than the reviewer's second store and has the same effect |
| **M4.5** The entry order is ambiguous, and `/` is deduped across the canvas | `written-pages.ts:425-470` (`entryPlacement` looks for file frames canvas-wide) | S83 "Entry": one timeline, the newest 12 across both kinds, routes deduped on the target page only. Task 9's hand-named 12 and its two-chat `/` case |
| **M5.1** The live prompt names `design_app` on turns without it | `llm-client.ts:3154` vs `:3212`, `:3377` | S86: `designModePromptSection(designMd, liveApps)`. Task 10 cases |
| **M5.2** `withDesignModeSection` misses the live text | `design-md/turn.ts:184` | S86: `LIVE_APP_PROMPT_MARKER`, with the DM bullet kept verbatim. Task 10's `turn.test.ts` case |
| **M5.3** The registry test doesn't reach `skill-registry-main.ts` | `skill-registry.test.ts:68-80` builds its own registry | S86: a pure `designCanvasSkills` **in `skill.ts`**, not `skill-registry-main.ts`, because that module builds the singleton registry when imported. Tested in `skill.test.ts` |
| **M6.1** `already` isn't focused | `design-canvas.ts:523-529` focuses only `elsewhere` | S87: `sendFocus` on placed and already. Task 11 |
| **M6.2** There is no `full` error | `design-canvas.ts:479`, `:510` (`placeArtifact` has one) | S87, and Tasks 11 and 12 |
| **M6.3** The view and save debounces race | `use-design-view.ts` (250 ms), `use-design-canvas.ts:50` (800 ms) | S87: `await flush()` first, and `pageId` sent and checked. Task 12's call-order case; Task 11's fallback case |
| **M6.4** The item is disabled for attached apps | `app-server-main.ts:1574` (target `none` without detection) | S87's enable rule. Task 12 case |
| **M7** `blockedForFrame` counts dead mounts | `app-frame-registry.ts:84-95` (prune only at the cap) | S85: live members only. Task 7's `liveIds` cases |
| **M8.1** `fillRoute` lets `.` and `..` through | `encodeURIComponent("..") === ".."` | S81's segment rules and `isParamValue`. Task 1 and Task 3 rows |
| **M8.2** Multi-parameter patterns can't be filled | — | S81: `params` fills single-parameter patterns only; the picker has per-parameter fields. Task 1, 3 and 12 rows |
| **M8.3** A single file can't see its siblings | — | S80: `routeFromFile` versus `routesFromFiles`. Task 1 rows |
| **M8.4** Regular-expression parsing risks backtracking | — | S78: the O(n) `scanTsTokens` and a depth-16 reader. Task 1's timing oracle |
| **M9.1** Re-exporting from a spec runs its tests twice | `design-live-frames.spec.ts:64-147` (unexported) | Task 13: `design-live-helpers.ts`, and a single-count check |
| **M9.2** The flag-off case sits under `LIVE_ON` | `design-live-frames.spec.ts:62` (`live.use`) | Task 13 case G in its own `describe` |
| **M9.3** The spec map has no lanes | `scripts/ci-e2e-spec-map.json` `"specs"` maps names to prefixes | Task 13's exact prefixes |
| **m1** Cache staleness, the issues claim, `framework` and the `root` check | `canvas-config.ts:71-87` (silent); `app-tool.ts:224` | S81 "Freshness", silent drops, `AppRouteList.framework?`, `routes` exempt from the root check. Tasks 3 and 4 |
| **m2** `retractPlacedFrames` isn't undo | `written-pages.ts:625-630` | S83 "Retraction" separated from "The person's undo". Task 8's retraction case |
| **M2-1** (review 2) The analytics task came after the tasks that report it | `analytics-report.ts:26`: `reportAnalyticsEvent` is typed on registry names | It is moved to Task 5, right after Task 4, with old Tasks 5–8 renumbered 6–9 and every cross-reference updated |
| **M2-2** (review 2) Missing `fallbackRoute`, viewport and early-return details | `written-pages.ts:274` (takes `DesignChatView`), `:561` (early return); `entry.ts:39-55` runs before `store.update` | Interfaces: `entry.fallbackRoute`, `view: DesignChatView`, and the guard condition. S83 "Entry", plus Task 8 Step 3 and Task 9 Step 3 with its note-only-page case |
| **m2-1** (review 2) The skills return type | `skill-registry-core.ts:11` `SkillRegistryCandidate` | Interfaces |
| **m2-2** (review 2) The `withDesignModeSection` live flag | `llm-client.ts:3377` passes `{live: designMdOn}` | S86, Task 10 |
| **m2-3** (review 2) The analytics test's wording | `pickValidProps` returns `undefined` for the whole payload (`analytics-events.ts:216-234`) | Task 5: two separate cases, each asserting `props: undefined` |
| **m2-4** (review 2) Convention-folder consistency | — | S78, Interfaces and Task 2 now agree: the root path gives `null`; a convention folder that is missing, a link or not a folder is skipped. Task 2 adds the `ENOENT` and file-as-folder cases |
| **m3** Reuse behaviour and the required `title` | `canvas-tools.ts:1160-1172`, `:1310` | S85: `title` stays required; `device` and `label` merge on reuse. Task 6 cases |

## As built

Built 2026-11-27 on `t3/design-mode-v2-p3b`, stacked on 3a (merged from `origin/t3/design-mode-v2-p3a` three times, never rebased), Tasks 0–15. No PR yet. The decisions S78–S88 stand as written, apart from the deviations below.

**Deviations, by task.**

- **Task 1 (route rules).**
  - Remix `($lang)` optional segments map to `[[...lang]]`, the one optional form S79 allows.
  - `prefix()` in a literal `app/routes.ts` is read without a spread as well as with one.
- **Task 3 (canvas.json).**
  - A `routes` entry is kept when it passes `isConcreteRoute` or `isRoutePattern`, so a pattern listed by the person stays in the list.
  - An empty `routes` array falls back to discovery: it can't mean "no pages", because `/` is always listed.
- **Task 4.** `routes()` for a workspace with no app root answers `unknown-root`.
- **Task 6.**
  - `variantOf` refuses `nextTo`, `x`, `y` and `groupId`, because a variant's place is decided by its set.
  - A variant joining an artboard refits it with `refitGroups`.
- **Task 7.**
  - `canvas_update_frame` `label: ""` clears the label.
  - The renderer keeps page paths and route keys in one undone set (a route key holds a NUL no page path can) and splits them into `undone` and `undoneRoutes` only at `saveDesignCanvas`. The behaviour is the plan's, with one set instead of two.
  - `AppNode` resets on a route change by adjusting state during render (`routeShown`) and resets its restore counters in a layout effect. It also resets `loadedKey`, so the old route's load doesn't count.
- **Task 8.**
  - The per-turn logic lives in `createWrittenRouteTurn` (`written-pages.ts`): one shared load, and the 12 cap (`room` and `placed`). llm-client only wires it.
  - `writtenFilePath` (new) gives any produced file. A route is classified only when the file isn't a `design/` page.
  - Root owners are the snapshot's candidates and apps plus canvas.json's roots. A root listed only in canvas.json has no framework, so it places nothing, and, being deeper, it shadows a shallower root, as the "deepest root" rule reads.
  - A failed snapshot or config read degrades to no placement and never throws into the turn.
  - Three pieces of llm-client wiring have no unit harness: the inspector skip, S88's call site 2 and "flag off notes nothing". The helper tests and Task 13's E2E cover them.
- **Task 9.**
  - `createDesignEntry` takes one optional `live: {snapshot, readConfig, onAppFrameAdded}`, present only with the flag on, instead of separate dependencies.
  - The newest-12 window walks the timeline newest first. A `design/` page counts only while it exists (`isShowablePage`, as today) and a route file only once it maps to a route. On the canvas, pages are placed before routes.
  - The snapshot doesn't name the single app, so the `/` fallback uses the lone web candidate, else the lone app, and otherwise places nothing. "Wrote nothing" means the chat's timeline is empty.
- **Task 10.**
  - `liveAppsOn` is "the filtered canvas tool list contains `design_app`", the plan's condition read from its result, so `excludeToolNames` is covered.
  - The live prompt is built from today's lines: the `design/` bullet becomes the three live bullets plus a "no web app" bullet, the width bullet says "for a design/ page", and the `canvas_inspect` bullet says it draws `design/` pages, not app frames. The prompt is 1.15× today's length, the live skill 1.34×.
  - The live skill's "No web app" section is today's HTML method verbatim, so it keeps `data-aiden-comment` for HTML pages. The test checks that the live sections (before "No web app") don't name it.
  - "Remove the other directions' files" is left out: the skill only says to ask which to keep, so no deletion is implied.
- **Task 11.**
  - The picker's app list is the snapshot's candidates, then its started or attached apps, then canvas.json's chosen roots. The label is the package name, else the framework label for `.`, else the root path.
  - There is no shared `personPlacement` helper. `placeAppRoute` resolves its page with `designTurnPages({message: {pageId, viewSize}})` and places with `placeFrame` plus `canvasView`, the same rule as `placeArtifact`, which is untouched.
  - Errors: a root not in the picker's list answers `unknown-root`, and so does an invalid `appRoot` string; an invalid route answers `bad-route`. `appRoutes` maps the server's `unknown-root` and `choose-root` to `no-app`.
- **Task 12.**
  - The toolbar owns the picker, its open state and the Add trigger's ref, so focus returns to Add. `DesignAddKind` doesn't gain `"app-route"`. `appRoutePlacer` builds `place`: it flushes, then places with the page on screen and its view size.
  - The menu and dialog cases are in `app-route-picker.test.tsx`, with the toolbar rendered on its own. The flush-before-place order is checked on `appRoutePlacer` with a call log.
  - The disabled item carries its hint as a second line. The filter is a `combobox` that controls the listbox through `aria-activedescendant`. A dynamic row's fields sit in its row: focusing one makes the row active, Enter in one adds that row, and a double-click adds a row.
  - A dynamic row's prefill is decoded from the first route the list filled from the same pattern, because the list carries filled routes, not raw `params`.
  - The load errors read "No web app in this workspace" and "Pages from your app can't be added right now." The latter is also the place `unavailable` copy, which S87 didn't name.
- **Task 13 (found by the E2E).**
  - The canvas dropped the person's own Add focus. A focus request is held back for 3 s after the person's last move on the canvas (`FOCUS_QUIET_MS`) so that Aiden can't take the view, and clicking Add and typing in the picker counted as moves. The frame landed out of view and never went live.
  - The fix: `placeAppRoute` sends its focus with `own: true`, `canvasFocusFrom` keeps it, and `focusYieldsToPerson` (pure, tested) never holds back the person's own request. The handler test checks the flag, and case A is the end-to-end check.
  - The helper module is `design-live-helpers.ts`, as planned. `openLiveChat` gained a title and `startDesignChat` for a second chat, `seedFixture` gained an `into` folder for the two-app workspace, and `savedCanvas` and `appRoutesOn` read the saved document.
  - The fixture's `App.tsx` uses the flat-file rule over `import.meta.glob("./routes/*.tsx")`. Route modules export a default component, because `@tanstack/react-router` isn't installed.
  - Case E holds the fake model's completions (`holdCompletions`) while chat B's canvas is brought back on screen, then releases them.
  - Screenshots 3 and 4 (two apps and the fallback line) come from one workspace with `workspaces: ["apps/*"]`: `apps/shop` holds the routes fixture and `apps/site` holds 3a's router-less app.
  - Screenshots 6 and 7 share one shot, `design-live-variants-phone`: the home with two `variantOf` frames, labelled Current, Calm and Bold, and a `device: "phone"` pricing frame.
  - A second frame of a route already on the page needs `duplicate: true` to become a variant. Without it, `canvas_place_frame` reuses the existing frame and ignores `variantOf` (S85's reuse rule). The case passes `duplicate: true`, and the skill's route copies (`/pricing-v2`) never hit this rule.

- **Code review 1 (review-p3b-1, 2026-11-27).** All 6 Majors and 4 Minors were verified and fixed test-first:
  - `appRoutes` and `placeAppRoute` re-check the chat (still framing, same workspace) after each await and inside `beforeWrite`, and `placeAppRoute` answers `unavailable` for an unavailable workspace.
  - A variant that needs a new group is refused when the whole canvas has no room for both frames.
  - `parseReactRouterConfig` falls back when code follows the default export (only a `satisfies`/`as` type, `;`, the end or the next statement may follow), reads `await flatRoutes()`, and still treats `flatRoutes({…})` with options as unreadable.
  - The picker says when main cut the list short, drops a load that a newer one or a close superseded, keeps double-clicks inside a value field, prefills a mid-pattern catch-all with its own segments only, scrolls on arrow keys, keeps the typed-into row active under a passing pointer, and uses the motion token's default duration.
  - `isConcreteRoute` refuses `.`, `..` and empty path segments, which also covers canvas.json's `routes` and every placement.

- **Pullfrog round 1 (PR #966, 2026-11-27).** All 6 findings were verified and fixed test-first:
  - The picker places nothing unless the canvas's pending save resolves `true`. It answers its own `unsaved`: "The canvas couldn't be saved, so the page wasn't added. Try again in a moment."
  - Entry's route list carries the workspace id it was read from (`placeWrittenPagesOnCanvas`'s new `workspaceId`). A chat that moved meanwhile places nothing. A turn's written routes pass their workspace the same way.
  - `isConcreteRoute` and patterns refuse percent-encoded dot segments (`%2e`, `.%2E` and so on), because the URL parser resolves them like `.` and `..`. Raw non-ASCII routes stay allowed, so it doesn't compare against the parser's re-encoded pathname.
  - The walk reads each folder only while it is still a real folder at its own real path. An `lstat` runs before the read, and after it a second `lstat` with the same dev/ino and a `realpath` check (`inRealDir`). The two parsed files are fenced by their folder the same way. Node has no no-follow directory read. The residual case is a folder renamed away and back inside one read, which keeps its inode.
  - A spread `flatRoutes(…)` with options is unreadable too, so only option-free `flatRoutes()` walks `app/routes/`.
  - `placeAppRoute` passes `stillFraming` into `pages.show()`. `DesignCanvasViews.showPage` takes an optional `stillOwned`, asked after its load and right before its synchronous change. Focus is checked again after the show.

- **Pullfrog round 2 (PR #966, 2026-11-27).**
  - Restore-after-read race. The walk now reads through `confinedRead`: an `lstat` before; an `lstat` after with the same dev/ino, which must also be the handle's own; and `realpath` must equal the path. The two parsed files are read through one `O_NOFOLLOW` handle (`readRouteFile`), so a folder renamed aside, linked out and put back around the read is caught on every platform. Folders are listed through a handle on Linux (`listOpenedDir`: `open(O_DIRECTORY|O_NOFOLLOW)`, then `readdir("/proc/self/fd/N")`).
  - **Documented residual, macOS folder listings.** Node has no `fdopendir`, `openat` or `fchdir`, and `/dev/fd/N` answers `ENOTDIR` for a folder. So macOS lists by path, with identity taken from the `lstat` before. A process that renames a folder aside, links it out and renames it back within one `readdir` gets the outside folder's names listed. That is names only: they become route strings shown as text. No outside file is read, nothing is written or run, and the frame still loads the dev server's own URL. Closing it would need a native helper.
  - Post-save fences. After `placeWrittenPagesOnCanvas` saves, `claimWithRoom` takes `stillOwned` (checked in `beforeWrite`), `show()` passes `shouldSave` to `pages.show`, and ownership is checked again after each await before any page or focus data is returned. A chat that left gets no claim, no view and no focus there; the frames already saved stay.

**Verification.** Recorded in Task 13's Space runs below and in the FINISH line of the build's status log.

