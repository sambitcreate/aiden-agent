# Design mode v2 — Phase 3b: routes and skill — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

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
  - `app-routes-core.ts` (new, pure) maps a framework's route file to a route pattern in one canonical syntax. It parses the two generated or config files the spec names, `routeTree.gen.ts` and `app/routes.ts`, as text with bounded regular expressions, merges canvas.json's lists, and fills dynamic segments.
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
- **`app-routes.ts` (disk).** A walker that:
  - starts at `<workspace>/<appRoot>`;
  - follows no links: `lstat`, a directory symlink is skipped, and a file symlink is read only if `realpath` stays inside the app root;
  - skips `node_modules` and every hidden folder (`.next`, `.git`, `.output`);
  - stops at depth 10, 2 000 directory entries in total, or 500 routes;
  - reads at most 256 KiB of a parsed file, with `readBounded`.
- A hit cap returns what it has with `truncated: true`.
- **Rationale.**
  - The spec's list is file conventions plus "simple literal configs only".
  - Loading `routes.ts` or `routeTree.gen.ts` would execute the person's code in main, and `typescript` isn't a runtime dependency.
  - Text parsing of the two generated or literal shapes is enough, and anything else falls back (S80).

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
| `tanstack-start`, `tanstack-router` | `src/routeTree.gen.ts` when present: the keys of `interface FileRoutesByFullPath { … }`. Otherwise `src/routes/**`, using flat dots, `index`, `$param`, `_pathless` and `(group)` | `__root.tsx`, `-ignored` files and `route.tsx` layout files are not pages, except a `route.tsx` in a leaf folder. |
| `react-router` | `app/routes.ts` when it is a literal array of `index()`, `route()`, `layout()` and `prefix()` calls with string literals. Otherwise the flat `app/routes/**` convention | One spread (`...flatRoutes()`) means flat routes. Any other code means unsupported, and the list is then `/` only, with `fallback: "config"`. |
| `remix` | Flat `app/routes/**`: dots become `/`, `_index` is the index, `$` becomes a param, `_` prefixes are pathless, trailing `_` is dropped, `[.]` is an escaped dot, and `route.tsx` folders count | as React Router's flat routes. |
| `astro` | `src/pages/**/*.{astro,md,mdx,html}` | `.ts` and `.js` endpoints and `_`-prefixed files are skipped. |
| every other id, and none | none | The list is `/` plus canvas.json's. |

Remix 3 (`remix-3`) has no file convention yet, so it gets the fallback. The table cites the frameworks' public conventions. Task 1's fixtures are copied from each framework's documented examples, so the rules are checked against a source independent of the code.

### S81 — canvas.json `routes` and `params` (proposed)

- **`routes`** is an array of at most 200 strings. Each is a pattern or a concrete route that passes `isAppRoute`, and a bad entry is dropped with a config issue, as `parseApps` does today. **`params`** is an object of at most 50 keys, each a bracket pattern from `routes` or from discovery, mapped to at most 20 values that are each a single path segment (or several segments for a catch-all), with no `/` at the edges and at most 200 characters.
- **The merge (`mergeRouteList`).**
  - The list starts with `/`.
  - When `routes` is present, it is `routes` in its own order. Otherwise it is the discovered patterns, sorted with static routes first, then by depth, then alphabetically.
  - Each pattern with `params` values is followed by its filled routes.
  - The result is deduplicated. Each entry is `{route, pattern?, source: "config"|"discovered"}`.
- **`routes` replaces discovery, and doesn't add to it.** This is how the spec's example reads, and it gives a monorepo or an unsupported router (S80's fallback) a complete list the person controls.
- **Writing.** Aiden writes the file with `write_file` or `edit_file`, as the skill says (S86). Neither `saveCanvasConfigApp` nor the attach consent changes. Unknown fields such as `mock` (3d) are already kept.

### S82 — `design_app {action: "routes", root?}` (proposed)

This is a seventh, read-only action. The spec says Aiden "prefers `.aiden/canvas.json`" but names no tool that lists routes, and Aiden needs the list to place frames and to write the file.
- **Reply.** `{status: "routes", root, framework, source: "discovered"|"config"|"fallback", truncated, routes: [{route, pattern?}]}`, capped at 200 entries.
- It works while the app is stopped, isn't counted as a start, and never shows a card.
- With several apps and no `root`, it is an error listing the roots, as `start` is.
- Route strings come from the person's files, so the reply carries them as JSON values only and never as prose. Each is checked by `isAppRoute`, or by the pattern shape.

### S83 — Route-aware placement (proposed)

- **Which files.** A `write_file` or `edit_file` that completes in a design-mode turn, with the flag on, is a **route file** when it lies under the deepest described or detected app root (see below) and `routeFromFile` maps it to a pattern for that root's framework, or the path is listed for that root by canvas.json (not in 3b). A command's output isn't scanned outside `design/` (today's `createDesignPageScanner` limit). Commands create route files rarely, and the scanner's limit is a deliberate cost bound.
- **Where it lands.**
  - A concrete pattern places an `app` frame for `{appRoot, route}` on the turn's page (S84) at the default 1280 × 800 and scale 0.5, and focuses it.
  - It places nothing if the page already has a frame for that appRoot and route. A frame elsewhere on the canvas doesn't count, which matches 3a's dedupe.
  - A dynamic pattern is placed only when canvas.json gives it a value, with the first value; otherwise it places nothing.
  - An edit of a file that maps to no route (a component, a style, a layout) places nothing. HMR updates the frames already open.
- **Removed routes.**
  - The canvas document gains `removedAppRoutes: string[]`, with keys `"<appRoot>\u0000<route>"`, at most 200, the newest kept.
  - It is maintained exactly like `removedPagePaths`: `withRemovedAppRoutes(before, after, byPerson, undone)` runs next to it in `store.save` and `store.update`.
  - The person removing the last frame of a route notes it. Any frame showing it again, whoever adds it, forgets it.
  - Automatic placement skips a noted route; the tool and the person's Add don't.
  - **Why the store and not the renderer.** It is the same mechanism and limits v1 uses for pages the person took off, so an undo of the removal behaves the same way.
- **Root resolution (`routeOwner`).** The deepest root among the snapshot's candidates and described roots that contains the path. A path under no root, or in a root whose framework has no convention, places nothing.
- **At most 12 per turn.** A turn places at most 12 new app frames from written routes (`EARLIER_PAGES_LIMIT`); later route files place nothing, and the tool can still place them.
- **One snapshot per turn.** Placement reads the snapshot once per turn, at the first completed file write, and keeps it for that turn, so a turn of 30 edits doesn't run detection 30 times (`snapshot` re-detects every call, `app-server-main.ts:362`). A root added by the same turn's `write_file package.json` is only seen next turn. That is accepted, because the frame can still be placed with the tool.
- **Entry.**
  - On entering design mode, the chat's route files are placed after its design/ pages, newest first, up to the shared limit of 12 (`EARLIER_PAGES_LIMIT`, counted across both).
  - They come from `routeFilesWrittenInChat(messages)`, parsed like `pagesWrittenInChat` and joined with a new `RecentWrittenRoutes`.
  - With none of either, an **empty** chat page and exactly one web app root (a `single` target), it places that app's `/`.
  - Several roots and no written routes place nothing. The status chip's Choose apps is the person's way in.
- **Mirrors.**
  - A placement made by the turn is undone with the turn's frames, as 1b's `retractPlacedFrames` already handles for the paths it places.
  - The app frame is just another frame id in `frameIds`.
- **Flag off.** No route classifier runs and nothing changes.

### S84 — Where Aiden's work lands (proposed; S18 revisited)

S18's order, which is shown this turn → the message's page → the kept view → the claim → the first page, stands for **every** placement 3b adds: the tool, written routes, entry and the person's Add.
- The tool and the written-route path take the page `designTurnPages` already gives the turn. The person's Add takes the page on screen, from `views.get(chatId)`, as `placeArtifact` does.
- §6.5's "where Aiden's work lands" is rewritten to say exactly this.
  - The spec's draft text ("the chat's own page unless the person is looking at another") is the same rule seen from the person's side.
  - Nothing new is built for it. Task 15 updates the spec text and the prompt line, and Task 7's tests pin the order for route placements.
- **Rationale.** 3a and 1b already put every frame on the page the turn's view names. A second rule for app frames would put two frames from one turn on two pages.

### S85 — The remaining tool changes (proposed)

- **`canvas_place_frame {kind: "app"}`** also takes:
  - `device`: one of `phone`, `tablet`, `laptop`, `desktop`. It maps to §6.3.8's iPhone 390 × 844, iPad 768 × 1024, Laptop 1280 × 800 and Desktop 1440 × 900. `width`/`height` win if given with it. The table lives in the new `renderer/shared/design-canvas/app-devices.ts`, which 3c's menu also uses.
  - `variantOf`: the id or workspace path of an app frame on the same page and app root. The new frame goes to its right, 48 units apart, joins its group (a new group titled after the original's route is made if it has none), and is recorded in `variantOf`.
  - `label`: at most 60 characters, shown in the title.
- **`canvas_update_frame`** on app frames also takes:
  - `route`, checked by `isAppRoute` and the concrete-route check, which changes the frame's route and its title (only if the title was the route) and keeps the frame;
  - `width`/`height` (the viewport, each 240–3 840), which keep the box's width when the aspect changes, refit with `fitAppScale` and keep the frame id;
  - `device`;
  - `label`.
  - Each refuses a non-app frame with the existing kind error.
  - `width` and `height` today mean the box on other frames. On app frames, `w` and `h` stay the box, and the new `width` and `height` are the viewport, matching `canvas_place_frame`'s 3a parameters.
- **`canvas_read`** lists each app frame with `blocked: <count>` when the count isn't zero.
  - It is read through a new dependency `blockedFor(frameId) → number`, backed by a new `AppFrameRegistry.blockedForFrame(frameId)` that sums the totals of the frame tree nodes whose `frameInfo.frameId` matches.
  - It gives **a count only**: the hosts are page-chosen text (S11).
  - The model reads `live` and `blocked` from main's records only.
- **Errors in `canvas_read` wait for Phase 4.** §6.5 lists "errors" in `canvas_read`, but the only error source is the bridge, whose text is untrusted (S11), and error frames with Fix with Aiden are Phase 4's. 3b sends no bridge text to the model.
- **`design_inspect`** is Phase 4 (§8). **`canvas_inspect`** still refuses app frames.
- **The analytics dependency.** `DesignCanvasToolDeps` gains `onAppFrameAdded?(viewportWidth: number)`. It is called once per **new or copied** app frame the tool places (never a reused one) and is wired in llm-client to `reportAnalyticsEvent` (S88). This revises 3a's D19 ("the canvas tools have no analytics dependency") for this one event.

### S86 — The live prompt and skill (proposed)

- **Static per flag (S34).**
  - `designModePromptSection(true)` returns `LIVE_DESIGN_MODE_PROMPT_SECTION`, a sibling constant: today's section with the v1 HTML bullets rewritten, plus the DESIGN.md bullet.
  - `designModePromptSection(false)` stays today's string.
  - No turn-specific line is added. The app's state reaches the model through the canvas status note and `design_app status`.
- **The prompt's live bullets** (exact copy, Task 10):
  - Design in the real app. When the workspace has a web app, screens are its routes and components, not design/ HTML. Start it with `design_app start`, and list its pages with `design_app routes`.
  - A route file you write or edit lands on this chat's page by itself, once, and updates live as you save. Component and style edits update every open frame. Use `canvas_place_frame` with kind app to show another route or a device size.
  - For a variant of a page, write a route copy such as `/pricing-v2` next to the original and place it with `variantOf`. Keep at most three directions, then ask which to keep.
  - With no web app, use the design/ HTML pages as before. (This bullet goes in 3d, S6.)
  - Keep today's canvas, page, focus, comments and coordinates bullets. The `canvas_inspect` bullet says it draws design/ pages and not app frames.
- **The skill.**
  - `aidenDesignSkill(live: boolean)` returns today's frozen object when `live` is false, and `AIDEN_DESIGN_SKILL_LIVE` when it is true. Both have the same `name` and id.
  - `skill-registry-main.ts` passes `designLiveEnabled()`.
  - The live skill's description names the real app first and design/ HTML as the fallback.
- **What the live skill teaches:**
  - how to start the app and list its routes;
  - preferring `.aiden/canvas.json` routes and params, and writing them when discovery says `fallback` or a dynamic route needs a value;
  - new screens as new route files in the app's own convention;
  - working on the chat's page;
  - variants as `<route>-v2` copies grouped with `variantOf`;
  - at most three directions, then asking;
  - `canvas_read snapshot: true` to check;
  - DESIGN.md as the source of truth, limited by S38: tokens and prose only, no `motion` group, the Motion and Voice & Content sections unchecked by the linter, and `@file#fragment` references unresolved;
  - the v1 HTML method, kept unchanged, under "No web app".
- **Not in the live skill:** the JSX `data-aiden-comment` bullet. App frames take only frame-level comments in 3b (S68). It returns with Phase 4's source mapping.
- **Rationale.**
  - One skill name keeps the registry, the load_tools hints and the existing "tools it names are offered" test working.
  - A function, not a mutable object, keeps flag-off byte-identical.

### S87 — Add ▸ Page from app… (proposed)

- **The menu.**
  - `DesignAddKind` gains `"app-route"`.
  - The item reads **Page from app…** and is shown only with `designLive`.
  - It is disabled, with the hint "No web app in this workspace", when the apps snapshot's target is `none`, `react-nonweb` or `unavailable`.
- **The dialog (`AppRoutePicker`).** A Radix `Dialog` from `ui.tsx`, titled "Add a page from your app". It has:
  - an app `Select`, shown only with two or more roots;
  - a filled filter `Input` with no focus accent, labelled "Filter routes";
  - a list of route rows: a `listbox` of options, arrow keys moving, Enter placing, and the active row in the hover fill;
  - a row for each dynamic pattern with an inline value field (`[slug]` labelled "slug"), prefilled from `params`;
  - a final "Go to <typed>" row when the filter text is a concrete `isAppRoute` route not in the list;
  - a source line: "From your app's files", "From .aiden/canvas.json", or, for the fallback, "Only / found: list routes in .aiden/canvas.json";
  - Cancel and **Add** (shared squircle buttons).
  - The list shows at most 200 rows with "N more: refine the filter".
- **IPC.**
  - `designCanvas:appRoutes(chatId, {appRoot?})` returns `{apps: [{appRoot, label}], appRoot, routes, source, truncated}` or `{error: "unavailable"}`.
  - `designCanvas:placeAppRoute(chatId, {appRoot, route, viewSize?})` returns `{placed: frameId, pageId} | {already: frameId, pageId} | {error: "unavailable"|"bad-route"|"unknown-root"}`.
  - Main checks `canFrame(chat)` and the flag, checks the root against the snapshot and the route with `isAppRoute` plus the concrete-route check, and places on the page on screen with `createdBy: "person"`.
  - The box is centred in the person's viewport, following `placeArtifact`'s box rule, at the default viewport and scale.
  - A frame for that appRoot and route already on the page answers `already` and focuses it.
  - It broadcasts `step: "add-app-route:<revision>"`, so the placement is the person's own undo step. It reports S88 with `source: "person"`.
- **Rationale.**
  - The person never types an origin: main resolves the app and the box.
  - `placeArtifact` is the tested precedent for a person's placement made in main, which keeps 1b's per-chat page claim and undo semantics.
- **The size** is the default 1280 × 800 at 0.5. The dialog has no device choice; 3c's device menu adds it.

### S88 — `design_app_frame_added` (proposed)

- **Registry entry:** `design_app_frame_added: { source: enumProp("person", "aiden"), device_bucket: enumProp("phone", "tablet", "laptop", "desktop") }`.
- **`device_bucket`** comes from the viewport width (`deviceBucket(width)` in `app-devices.ts`): `phone` up to 480, `tablet` 481–1023, `laptop` 1024–1439, `desktop` 1440 and over.
- **When it fires.** One event per new or copied app frame, never for a reused one:
  - `source: "aiden"` for the tool, written-route placement and entry placement, because the person didn't place them;
  - `source: "person"` for `designCanvas:placeAppRoute`.
- **What it never carries:** the route, the app root, the framework or a count of routes.
- It needs its docs row in `docs/analytics.md`'s design section and its test in `analytics-feature-reports.test.ts`.

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
  source: "discovered" | "config" | "fallback";
  truncated: boolean;
  routes: AppRouteEntry[];
};
export function isRoutePattern(value: string): boolean;      // "/blog/[slug]", "/docs/[...rest]"
export function isConcreteRoute(value: string): boolean;     // isAppRoute and no "[" "]"
export function patternParams(pattern: string): { name: string; catchAll: boolean; optional: boolean }[];
export function fillRoute(pattern: string, values: Record<string, string>): string | null;

// main/services/design-canvas/app-server/app-routes-core.ts (new, pure)
export type RouteConvention = "next-app" | "next-pages" | "tanstack" | "react-router-flat" | "astro";
export function conventionsFor(framework: FrameworkId | undefined): readonly RouteConvention[];
/** relPath is POSIX and relative to the app root, e.g. "src/app/(shop)/pricing/page.tsx". */
export function routeFromFile(convention: RouteConvention, relPath: string): string | null;
export function parseTanStackRouteTree(text: string): string[] | null;
export function parseReactRouterConfig(text: string): { routes: string[] } | { flat: true } | null;
export function mergeRouteList(input: {
  appRoot: string;
  discovered: { patterns: string[]; truncated: boolean } | null; // null: no convention
  config?: { routes?: string[]; params?: Record<string, string[]> };
}): AppRouteList;
export const ROUTE_LIMITS: { depth: 10; entries: 2000; routes: 500; fileBytes: 262_144; listed: 200 };

// main/services/design-canvas/app-server/app-routes.ts (new, disk)
export function discoverRoutes(workspaceRoot: string, appRoot: string, framework: FrameworkId | undefined,
  options?: { signal?: AbortSignal }): Promise<{ patterns: string[]; truncated: boolean } | null>;
/** For placement: the pattern a written file maps to, or null. No disk read beyond the convention's config file. */
export function routeForWrittenFile(appRoot: string, framework: FrameworkId | undefined, workspaceRelPath: string): string | null;

// canvas-config.ts (modified)
export type CanvasConfigApp = { root: string; script?: string; designMd?: string; url?: string; urlRefused?: boolean;
  routes?: string[]; params?: Record<string, string[]> };

// app-server-main.ts (modified)
class DesignAppServers { routes(workspaceId: string, appRoot?: string): Promise<AppRouteList | { error: "unknown-root" | "choose-root" | "unavailable"; roots?: string[] }>; }
// Cached per (workspaceId, appRoot) for 5 s, and forgotten on the workspace's detection change.

// canvas-tools.ts (modified)
type DesignCanvasToolDeps = { /* …3a's… */ blockedFor?(frameId: string): number; onAppFrameAdded?(viewportWidth: number): void; };

// app-frame-registry.ts (modified)
blockedForFrame(frameId: string): number;

// schema.ts / store.ts (modified)
removedAppRoutes?: string[];                 // DESIGN_CANVAS_LIMITS.removedAppRoutes = 200
export function appRouteKey(appRoot: string, route: string): string;
export function withRemovedAppRoutes<T extends DesignCanvas>(before: DesignCanvas, after: T, byPerson: boolean, undone?: ReadonlySet<string>): T;

// written-pages.ts (modified)
export type WrittenAppRoute = { appRoot: string; route: string };
export function placeWrittenAppRoutes(doc: DesignCanvas, routes: readonly WrittenAppRoute[], newId: () => string,
  view: { pageId: string }, options: { skipRemoved: boolean }): { doc: DesignCanvas; frameIds: string[]; added: number[] /* viewport widths */ };
export function routeFilesWrittenInChat(messages: readonly ChatMessage[]): string[];

// skill.ts (modified)
export function aidenDesignSkill(live: boolean): typeof AIDEN_DESIGN_SKILL;

// canvas-tools.ts (modified)
export const LIVE_DESIGN_MODE_PROMPT_SECTION: string;

// main/handlers/design-canvas.ts (new channels)
export type DesignCanvasAppRoutesResult =
  | { apps: { appRoot: string; label: string }[]; appRoot: string; list: AppRouteList }
  | { error: "unavailable" | "no-app" };
export type DesignCanvasPlaceAppRouteResult =
  | { placed: string; pageId: string } | { already: string; pageId: string }
  | { error: "unavailable" | "bad-route" | "unknown-root" };
```

## Global Constraints

- **Flag off is today.** Tasks 4, 5, 6, 7, 8, 10 and 12 each include a flag-off case: the tool definitions and `design_app`'s action list deep-equal the ones built with today's dependencies; the prompt and skill strictly equal today's; no route classifier runs; the IPC answers `unavailable`; the menu has no new item; and no event is sent.
- **Never run the person's code to learn routes** (S78). No `import()`, no `require`, no `typescript`, no child process. Reads are bounded, no-follow, and confined to the app root.
- **Route strings are untrusted.** They come from file names and the person's config. They are validated by `isAppRoute`/`isRoutePattern`, shown as text nodes only, and given to the model as JSON values only. No security decision reads a route: the origin still comes from main's server record (3a D2).
- **Main decides URLs and boxes** for the person's Add (S87). The renderer sends an app root and a route string, and main checks both.
- **No new network.** Discovery reads disk. Nothing contacts a framework registry or the dev server for routes.
- **Analytics** (AGENTS.md Product analytics): only S88's two properties, through `main/services/analytics/`. The registry entry, the docs row and a test land in Task 9. No renderer-side analytics.
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

1. **A route folder full of non-pages.** Next `app/` holds `layout.tsx`, `loading.tsx`, `error.tsx`, `route.ts` handlers, `_components/` and `@modal/`; TanStack holds `__root.tsx` and `-utils.ts`. A person expects only real pages listed, and editing `layout.tsx` to place nothing. *Pinned by* Task 1's non-page rows and Task 7's "edit layout places nothing".
2. **A huge or hostile tree.** A monorepo app root with 50 000 files, a symlink loop, or a symlink to `/` must answer quickly and partly (`truncated`), and must never read outside the root. *Pinned by* Task 2's caps, the loop and outside-link cases.
3. **The same route twice.** Aiden edits `pricing/page.tsx` ten times in a turn, or the person already placed `/pricing`. One frame, focused, never a second. *Pinned by* Task 7's dedupe cases and Task 11's `already`.
4. **A route the person removed.** They delete the `/pricing` frame, and Aiden edits `pricing/page.tsx` again. It must not come back by itself, but Aiden's explicit `canvas_place_frame` may. *Pinned by* Task 6's store cases and Task 7's skip case.
5. **Two chats, one workspace.** Chat A's route writes land on A's page, never on B's, even when B's canvas is on screen. *Pinned by* Task 7's two-chat case and Task 13's E2E.

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
- Consumes: `isAppRoute` (`app-frame.ts:67`), `FrameworkId` (`renderer/shared/design-app.ts`).
- Produces: `AppRouteEntry`, `AppRouteList`, `isRoutePattern`, `isConcreteRoute`, `patternParams`, `fillRoute`, `conventionsFor`, `routeFromFile`, `parseTanStackRouteTree`, `parseReactRouterConfig`, `mergeRouteList` and `ROUTE_LIMITS`, exactly as in Interfaces.

- [ ] **Step 1: Write the failing tests.** Each row's expected value is written by hand from the framework's own docs examples:
  - **`routeFromFile("next-app", …)`:**
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
  - **`tanstack`:**
    - `src/routes/index.tsx` → `/`
    - `src/routes/about.tsx` → `/about`
    - `src/routes/posts.$postId.tsx` → `/posts/[postId]`
    - `src/routes/posts/$postId/edit.tsx` → `/posts/[postId]/edit`
    - `src/routes/_auth/settings.tsx` → `/settings`
    - `src/routes/(marketing)/pricing.tsx` → `/pricing`
    - `src/routes/files/$.tsx` → `/files/[...splat]`
    - `src/routes/__root.tsx`, `src/routes/-components/x.tsx` and `src/routes/posts.tsx` with a sibling `posts.index.tsx` (a layout) → `null`
    - `src/routes/posts.index.tsx` → `/posts`
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
  - **`parseTanStackRouteTree`:** a trimmed real `routeTree.gen.ts` text, with `export interface FileRoutesByFullPath { '/': typeof IndexRoute; '/about': …; '/posts/$postId': … }`, gives `["/", "/about", "/posts/[postId]"]`. Text without the interface gives `null`.
  - **`parseReactRouterConfig`:**
    - `export default [index("routes/home.tsx"), route("about", "routes/about.tsx"), ...prefix("blog", [route(":slug", "routes/post.tsx")])] satisfies RouteConfig;` gives `{routes: ["/", "/about", "/blog/[slug]"]}`.
    - `export default flatRoutes() satisfies RouteConfig;` gives `{flat: true}`.
    - A config that maps over an array gives `null`.
  - **`mergeRouteList`:**
    - With no config, the list is `/` first and then static before dynamic. Discovered `["/blog/[slug]", "/about", "/"]` gives `/`, `/about`, `/blog/[slug]`.
    - With `params {"/blog/[slug]": ["hello-world"]}`, `/blog/hello-world` (source `config`, pattern `/blog/[slug]`) follows the pattern.
    - With `routes: ["/", "/pricing"]`, discovery is ignored and the source is `config`.
    - `discovered: null` and no config gives `{source: "fallback", routes: [{route: "/"}]}`.
    - 300 discovered patterns give 200 entries and `truncated: true`.
  - **`fillRoute`:**
    - `("/blog/[slug]", {slug: "a b"})` gives `/blog/a%20b`.
    - A value with `/` in a single segment gives `null`.
    - A catch-all `("/docs/[...rest]", {rest: "a/b"})` gives `/docs/a/b`.
    - An empty optional catch-all gives `/shop`.
  - **The pattern checks:**
    - `isConcreteRoute("/blog/[slug]")` is false, and `isConcreteRoute("/blog/x")` is true.
    - `isRoutePattern("/a/[b")` is false.
    - `isRoutePattern("//x")` is false (it reuses `isAppRoute`'s rules).
  - **`conventionsFor`:** `next` gives `["next-app", "next-pages"]`, `remix` gives `["react-router-flat"]`, and `vite` and `undefined` give `[]`.
- [ ] **Step 2:** Run `npx tsx --test renderer/shared/design-canvas/app-routes.test.ts main/services/design-canvas/app-server/app-routes-core.test.ts`. Expected: FAIL, because the modules aren't found.
- [ ] **Step 3: Implement.**
  - Write the converters as per-segment rules over `relPath.split("/")`.
  - The two parsers are bounded regular expressions over at most `ROUTE_LIMITS.fileBytes` of text. Strip comments first. `parseReactRouterConfig` accepts only the call forms with string-literal arguments, and anything else returns `null`.
  - Percent-encode route values with `encodeURIComponent` per segment.
- [ ] **Step 4:** Rerun the tests. Expected: PASS.
- [ ] **Step 5:** Register both files in `test:design-mode` and the `core-git` lane, then run `npm run test:ci-policy`. Commit `feat(design): route rules for Next, TanStack, React Router, Remix and Astro`.

### Task 2: The bounded walker

**Files:**
- Create: `main/services/design-canvas/app-server/app-routes.ts`, `app-routes.test.ts`

**Interfaces:**
- Consumes: Task 1's core and `readBounded` (`app-detect.ts:53`).
- Produces: `discoverRoutes` and `routeForWrittenFile`.

- [ ] **Step 1: Write the failing tests** against temporary directories:
  - A Next app with `app/` and `src/pages/` lists both conventions' routes.
  - A TanStack app with `src/routeTree.gen.ts` uses the file and ignores a stray `src/routes/old.tsx`. Without the file, it walks `src/routes`.
  - React Router: a literal `app/routes.ts` wins, `flatRoutes()` walks, and an unsupported config gives `null`, which the merge turns into fallback.
  - An app root of `apps/web` reads only `apps/web/**`.
  - A directory symlink to `/` and a symlink loop are skipped. A file symlink to `../../secret.tsx` outside the root isn't read.
  - 2 100 files give `truncated: true` and still return in under 2 s.
  - `node_modules/x/app/page.tsx` and `.next/server/app/page.js` are never listed.
  - `routeForWrittenFile("apps/web", "next", "apps/web/app/pricing/page.tsx")` gives `/pricing`. For `apps/web/app/pricing/Card.tsx` it gives `null`, and for `docs/app/page.tsx` it gives `null`.
  - An aborted signal rejects with `AbortError`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3: Implement** with S78's caps:
  - walk breadth-first with `readdir({withFileTypes: true})`;
  - `lstat` every symlink, and confine the realpath with `isPathInside`.
  - `routeForWrittenFile` is pure over the path, except for TanStack and React Router: when a generated or config file exists, it decides from the written file's convention only. A written file is mapped by the flat rules even if the config would name it differently. That is accepted and documented in the risk table.
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
    - A route `"https://x"`, a 201st route, a param key that isn't a pattern, a value with `/` for a single segment, and 21 values are each dropped with an issue, and the rest is kept.
    - `"mock": true` survives a `saveCanvasConfigApp` round trip, as do `routes` and `params`.
  - **`routes`:**
    - With a fake `detect` (Next app at `.`), a fake config and a temp tree, it gives `source: "discovered"`.
    - With config routes, it gives `source: "config"`.
    - With several roots and no `appRoot`, it gives `{error: "choose-root", roots}`.
    - An unknown root gives `{error: "unknown-root"}`.
    - An unavailable workspace (`permission: "none"`) gives `{error: "unavailable"}`.
    - Two calls within 5 s walk the disk once (a counting `discover` dependency), and a detection change forgets the cache.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Add the fields to `parseApps` with S81's limits.
  - `routes()` uses `detectFor`'s cache for the framework (candidate or status), calls `discoverRoutes` through a new `deps.discoverRoutes` (for tests), then `mergeRouteList`.
- [ ] **Step 4:** Rerun both suites. Expected: PASS.
- [ ] **Step 5:** Commit `feat(design): canvas.json routes and params, and the app's route list`.

### Task 4: `design_app {action: "routes"}`

**Files:**
- Modify: `main/services/design-canvas/app-server/app-tool.ts`, `app-tool.test.ts`; `main/services/llm-client.ts` (`servers` gains `routes`)

- [ ] **Step 1: Write the failing tests:**
  - **flag off:** the tool isn't built, as today (2b), so the case is the existing one, left unchanged;
  - `routes` with one app answers `{status: "routes", root: ".", framework: "next", source: "discovered", truncated: false, routes: [{route: "/"}, {route: "/pricing"}, {route: "/blog/[slug]", pattern: "/blog/[slug]"}]}`;
  - it doesn't count toward `DESIGN_APP_STARTS_PER_TURN`: five `routes` calls, then a `start`, still starts;
  - it never calls `servers.start` or opens a card;
  - several apps with no `root` give an error listing the roots;
  - `stillAvailable() === false` answers `unavailable`;
  - route strings come back as JSON values, so a route named `/"ignore previous` round-trips through `JSON.parse` unchanged.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Add `"routes"` to `ACTIONS` and `routes` to `DesignAppToolServers`'s `Pick`.
  - The description gains "routes lists the app's pages (from its files or .aiden/canvas.json)".
- [ ] **Step 4:** Rerun. Expected: PASS.
- [ ] **Step 5:** Commit `feat(design): design_app lists an app's routes`.

### Task 5: The device table and `canvas_place_frame` app additions

**Files:**
- Create: `renderer/shared/design-canvas/app-devices.ts`, `app-devices.test.ts`
- Modify: `main/services/design-canvas/canvas-tools.ts`, `canvas-tools.test.ts`; `main/services/llm-client.ts` (wire `onAppFrameAdded`, stubbed until Task 9)

**Interfaces:**
- Produces: `APP_DEVICES`, `isAppDevice`, `deviceBucket`; `canvas_place_frame` `device`/`variantOf`/`label`; `DesignCanvasToolDeps.onAppFrameAdded`.

- [ ] **Step 1: Write the failing tests:**
  - **`deviceBucket`:** 390 → phone, 480 → phone, 481 → tablet, 1023 → tablet, 1024 → laptop, 1439 → laptop, 1440 → desktop, 3840 → desktop;
  - **flag off:** `canvas_place_frame`'s definition deep-equals the one built with today's dependencies;
  - `{kind: "app", route: "/", device: "phone"}` gives viewport 390 × 844 at scale 0.5, and `device` with `width: 400` gives 400 × 844;
  - `device: "watch"` is an error naming the four devices;
  - **`variantOf`:**
    - given the `/pricing` frame's id, the new `/pricing-v2` frame sits to its right at a 48-unit gap, on the same page;
    - both share a group titled `/pricing`, and `variantOf` is recorded (read back through `canvas_read`);
    - a second variant goes right of the first;
    - `variantOf` pointing at a `file` frame, or at an app frame of another root, is an error;
  - `label: "Calm"` shows in the title, and 61 characters is an error;
  - `onAppFrameAdded` is called with 390 for a new phone frame and with 1280 for a `duplicate: true` copy, and not at all for a reuse;
  - a pattern route (`/blog/[slug]`) is an error saying to fill the value.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3: Implement** S85's place half on top of `placeAppFrame` (`canvas-tools.ts:1115-1218`). Reuse 3a's group helper and `fitAppScale`.
- [ ] **Step 4:** Rerun, plus `npx tsc --noEmit -p .`. Expected: PASS.
- [ ] **Step 5:** Register `app-devices.test.ts` (`core-git`) and commit `feat(design): device sizes, variants and labels for app frames`.

### Task 6: `canvas_update_frame` route and viewport, `canvas_read` blocked, and `removedAppRoutes`

**Files:**
- Modify: `canvas-tools.ts`, `canvas-tools.test.ts`
- Modify: `main/services/design-canvas/app-frames/app-frame-registry.ts`, `app-frame-registry.test.ts`
- Modify: `renderer/shared/design-canvas/schema.ts`, `schema.test.ts`; `main/services/design-canvas/store.ts`, `store.test.ts`
- Modify: `llm-client.ts` (wire `blockedFor: (id) => installedAppNetwork()?.registry.blockedForFrame(id) ?? 0`)

- [ ] **Step 1: Write the failing tests.**
  - **Update:**
    - `{route: "/about"}` on an app frame changes its route and its route title, and keeps its id and box.
    - A custom title stays.
    - `{width: 390, height: 844}` keeps the box width, refits the height and scale, and reads back as viewport 390 × 844.
    - `{device: "desktop"}` reads back as 1440 × 900.
    - `{route: "/x"}` on a `file` frame is the existing kind error.
    - With the flag off, the definition deep-equals today's.
  - **Registry:** two frame tree nodes mapped to frame `f1` with 3 and 2 blocked give `blockedForFrame("f1") === 5`, an unknown frame gives 0, and a forgotten node stops counting.
  - **Read:** with `blockedFor` returning 4, `canvas_read` lists `blocked: 4` on the app frame and omits it at 0. With no dependency, no `blocked` key appears.
  - **The schema and store.**
    - `removedAppRoutes` parses, dedupes and keeps the newest 200.
    - A person's `save` that removes the last `/pricing` frame of root `.` notes `appRouteKey(".", "/pricing")`.
    - An undo of that removal (`undone`) notes nothing.
    - An `update` that adds a `/pricing` frame forgets it.
    - An `update` that removes one notes nothing, as `removedPagePaths` behaves at `store.ts:214`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3: Implement** S85's update and read halves and S83's removed routes.
  - `undone` for app routes reuses the renderer's existing `undone` list.
  - Extend `use-design-canvas.ts`'s `undonePages` computation (`renderer/design/use-design-canvas.ts:139`, `:191`) to add app route keys next to page paths, so one list carries both.
  - The renderer test goes in `renderer/design/use-design-canvas.test.tsx` (existing).
- [ ] **Step 4:** Rerun, plus `npm run test:design-mode`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(design): retarget and resize app frames, report blocked counts, remember removed routes`.

### Task 7: Route-aware placement of written files

**Files:**
- Modify: `main/services/design-canvas/written-pages.ts`, `written-pages.test.ts`; `main/services/llm-client.ts:3226-3312`, `:6346-6348`, `:6828-6830`

**Interfaces:**
- Consumes: `routeForWrittenFile` (Task 2), `DesignAppServers.snapshot` and `routes` (Task 3), `removedAppRoutes` (Task 6), `onAppFrameAdded` (Task 5).
- Produces: `WrittenAppRoute`, `placeWrittenAppRoutes` and `routeFilesWrittenInChat`. `placeWrittenPagesOnCanvas` gains `routes?: WrittenAppRoute[]` and returns app frame ids in `frameIds`.

- [ ] **Step 1: Write the failing tests** (`written-pages.test.ts`, with a store, fake pages and a fake broadcast, as today):
  - a written `app/pricing/page.tsx` in a Next workspace places one `app` frame `{appRoot: ".", route: "/pricing"}` on the turn's page, focused, with `onAppFrameAdded(1280)` called once;
  - the same file edited again in the turn, and in the next turn, places nothing new;
  - a `/pricing` frame the person placed counts, and nothing is added;
  - `app/pricing/PriceCard.tsx` and `app/layout.tsx` place nothing;
  - `app/blog/[slug]/page.tsx` places nothing without params, and `/blog/hello-world` with `params {"/blog/[slug]": ["hello-world"]}`;
  - a route in `removedAppRoutes` isn't placed;
  - two chats in one workspace: chat A's write lands on A's page while chat B's view shows B's page (S84);
  - a `design/home.html` write still places its v1 `file` frame, and both kinds land when a turn writes both;
  - a path under `apps/web` in a two-app workspace is placed for `apps/web`, not `.`;
  - a file under no app root, and a Vite app with no convention, place nothing;
  - the turn's snapshot is read once across three writes (a counting fake);
  - 13 distinct route files written in one turn place 12 frames, and the 13th places nothing (risk 5);
  - **flag off:** `placeWrittenPage` gets no route classifier, and a route write places nothing (the existing v1 tests stay unedited);
  - a turn undone with its placements retracts the app frame as `retractPlacedFrames` does for file frames.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3: Implement** S83.
  - In llm-client, the post-write hook calls a new `writtenAppRoute(path)`, built once per turn with the cached snapshot, when `designLive`.
  - `placeWrittenPage` passes the route to `placeWrittenPagesOnCanvas({…, routes})`. `RecentWrittenRoutes` notes it beside `recentWrittenPages`.
- [ ] **Step 4:** Rerun, plus `npm run test:design-mode`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(design): a route file Aiden writes lands as a live frame`.

### Task 8: Entry placement

**Files:**
- Modify: `main/services/design-canvas/entry.ts`; its tests live in `written-pages.test.ts` (where `createDesignEntry` is tested today); `main/services/chat-application-service-main.ts:61` (pass `apps` and `designLive`)

- [ ] **Step 1: Write the failing tests:**
  - entry into a chat that wrote `app/pricing/page.tsx` and `design/home.html` places both on its empty page;
  - with 10 design/ pages and 5 routes written, it places 12 frames, newest first across both;
  - a chat that wrote nothing, in a single-app workspace, gets `/` on its empty page, and `onAppFrameAdded` fires once;
  - the same chat with a frame already on its page gets nothing;
  - a two-app workspace with nothing written gets nothing;
  - a removed `/` isn't put back;
  - **flag off:** entry places exactly today's frames (the existing tests stay unedited).
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3: Implement** S83's entry rule in `createDesignEntry`.
- [ ] **Step 4:** Rerun. Expected: PASS.
- [ ] **Step 5:** Commit `feat(design): entering design mode shows the chat's routes, or the app's home`.

### Task 9: `design_app_frame_added`

**Files:**
- Modify: `main/services/analytics/analytics-events.ts`, `analytics-feature-reports.test.ts`, `docs/analytics.md`
- Modify: `main/services/llm-client.ts` (`onAppFrameAdded` → `reportAnalyticsEvent("design_app_frame_added", {source: "aiden", device_bucket: deviceBucket(w)})`)

- [ ] **Step 1: Write the failing tests** in `analytics-feature-reports.test.ts`, following its pattern (`captureAnalyticsEvents(t)`, `reportAnalyticsEvent`, `await analyticsSettled()`, `deepEqual`):
  - `{source: "person", device_bucket: "phone"}` is sent as given;
  - `{source: "bot", device_bucket: "watch"}` sends the event with both props `undefined`;
  - an extra `route: "/x"` prop is dropped.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Add the registry entry after `design_app_started` with a comment naming 3b.
  - Add the docs row in `docs/analytics.md`'s design section: "`design_app_frame_added` · a live app frame was placed (by the person's Add, or by Aiden) · `source`, `device_bucket` · never the route, app or framework".
  - Settings' "What's sent" sheet renders from the registry, so it needs no change.
- [ ] **Step 4:** Rerun, plus `npm run test:analytics`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(analytics): design_app_frame_added`.

### Task 10: The live prompt and skill

**Files:**
- Modify: `main/services/design-canvas/canvas-tools.ts:233-260`, `main/services/design-canvas/skill.ts`, `skill.test.ts`, `main/services/skill-registry-main.ts:21-23` (the registry case goes in `main/services/skill-registry.test.ts`)

- [ ] **Step 1: Write the failing tests** (`skill.test.ts`):
  - `aidenDesignSkill(false)` strictly equals `AIDEN_DESIGN_SKILL`, and `designModePromptSection(false) === DESIGN_MODE_PROMPT_SECTION`;
  - every tool name the live prompt and the live skill mention is among the tools a flag-on design turn offers: `canvas_*`, `design_system`, `design_app` and `load_tools`. Extend the existing "tools it names are offered" test to the live pair;
  - the live prompt and skill name `design_app` and `variantOf`, and don't name `data-aiden-comment` (S86, a behavioural claim that the Phase 4 feature isn't promised);
  - the live skill makes no claim the S38 linter can't keep: it doesn't say Motion or Voice is checked, and doesn't say `@file#fragment` is resolved. Phrase this as an assertion on the specific forbidden sentences listed in S38, not as a copy snapshot;
  - the skill registry built with the live flag on offers `builtin:aiden-design` with the live instructions, and with it off offers today's.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3: Write the copy** for S86's bullets and the live skill's sections ("Start the app", "Pages are routes", "Variants and directions", "DESIGN.md", "No web app"), in the plain style of today's text. Keep it under today's length plus 60 %.
- [ ] **Step 4:** Rerun, plus `npm run test:design-mode`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(design): the design prompt and skill teach the live app`.

### Task 11: The person's Add: IPC

**Files:**
- Modify: `main/handlers/design-canvas.ts`, `design-canvas.test.ts`; `main/handlers/design-canvas-main.ts:69-75` (pass `routes` and the reporter); `renderer/lib/ipc.ts` (two methods next to `placeArtifact`, `:2872`)

- [ ] **Step 1: Write the failing register-and-invoke tests:**
  - **flag off:** both channels answer `{error: "unavailable"}`;
  - `designCanvas:appRoutes("chat-1")` lists one app's routes, and a Bot chat (`botId`) answers `unavailable`;
  - `designCanvas:placeAppRoute("chat-1", {appRoot: ".", route: "/pricing"})` places an app frame on the page on screen, with `createdBy: "person"`, centred in the reported view, and broadcasts `step` starting `add-app-route:`;
  - a second call answers `already` with the same frame id;
  - `route: "https://evil"`, `route: "/blog/[slug]"` and `appRoot: "../x"` give `bad-route`, `bad-route` and `unknown-root`;
  - a removed route placed by the person is placed, and forgotten from `removedAppRoutes`;
  - the reporter is called once with `{source: "person", device_bucket: "laptop"}` for a new frame and not for `already`;
  - `viewSize` with negative values is ignored, as `placeArtifact`'s test does (`design-canvas.test.ts:1129`).
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3: Implement** S87's IPC half, sharing the page and box code with `placeArtifact`. Extract it into a local helper, `personPlacement(chat, viewSize)`, without changing `placeArtifact`'s tests.
- [ ] **Step 4:** Rerun. Expected: PASS.
- [ ] **Step 5:** Commit `feat(design): the person can place a page of their app`.

### Task 12: The person's Add: menu and picker

**Files:**
- Create: `renderer/design/app-route-picker.tsx`, `renderer/design/app-route-picker.test.tsx`
- Modify: `renderer/design/design-toolbar.tsx:45`, `:172-185`; `renderer/design/design-canvas.tsx:758` (`onAdd`); the menu cases go in `renderer/design/design-canvas.test.tsx` (existing), the dialog's in the new file

- [ ] **Step 1: Read** both ChatGPT references (Global Constraints), `GUI.md` and `docs/design-guide.md`. Note the list-row and dialog states to reuse.
- [ ] **Step 2: Write the failing happy-dom tests** (Testing Library, never `assert.equal` on a DOM node, per `.memory/design-mode.md:437`):
  - with `designLive` false, the Add menu has exactly Group, File… and Image…;
  - with it true and a `single` target, **Page from app…** is enabled, and with target `none` it is disabled with its hint;
  - opening it calls `appRoutes` and lists `/`, `/pricing` and `/blog/[slug]`;
  - typing `pri` leaves `/pricing`, and Enter calls `placeAppRoute({appRoot: ".", route: "/pricing"})` and closes the dialog;
  - focus returns to the Add trigger;
  - the `/blog/[slug]` row's `slug` field prefilled with `hello-world` adds `/blog/hello-world`, and an empty value disables Add;
  - typing `/checkout?step=2` shows "Go to /checkout?step=2", and typing `//x` shows nothing;
  - with two apps a root picker shows, and switching it reloads the list;
  - `{error: "bad-route"}` shows "That address isn't a page of this app." in the dialog;
  - the fallback source shows its canvas.json line;
  - route text renders as text: a route `/<img src=x>` makes no `img` element;
  - Escape closes the dialog without a call.
- [ ] **Step 3:** Run `npx tsx --test renderer/design/app-route-picker.test.tsx`. Expected: FAIL.
- [ ] **Step 4: Implement** S87's dialog with `ui.tsx` primitives and semantic tokens. The list uses `role="listbox"` with `aria-activedescendant` from the filter input.
- [ ] **Step 5:** Rerun, plus `npm run test:design-mode` and `npx tsc --noEmit -p .`. Expected: PASS.
- [ ] **Step 6:** Register the file (`renderer-other`) and commit `feat(design): Add ▸ Page from app`.

### Task 13: E2E, lanes and screenshots

**Files:**
- Create: `tests/fixtures/design-live-routes/`:
  - `package.json`: `"scripts": {"dev": "vite"}`, with `vite`, `@vitejs/plugin-react`, `react`, `react-dom` and `@tanstack/router-plugin` declared but **not installed**, so 2a detects `tanstack-router`;
  - `index.html`, `vite.config.ts` (as 3a's fixture, `cacheDir: ".vite-cache"`), `src/main.tsx`, `src/App.tsx`;
  - `src/routes/index.tsx`, `src/routes/pricing.tsx`, `src/routes/blog.$slug.tsx`, `src/components/Banner.tsx`;
  - `.aiden/canvas.json` with `{"apps":[{"root":".","script":"dev","params":{"/blog/[slug]":["hello-world"]}}]}`.
  - `App.tsx` maps `location.pathname` to modules from `import.meta.glob("./routes/*.tsx", {eager: true})` using the flat-file rule, so a file added at run time is served by HMR without a router package.
- Create: `tests/e2e/design-live-routes.spec.ts`
- Modify: `scripts/ci-e2e-spec-map.json`

- [ ] **Step 1: Write the spec**, reusing `design-live-frames.spec.ts`'s helpers (`seedFixture`, `openLiveChat`, `placeFrames`, `appIframe`, `press`, `shoot`). Move them into a shared `tests/e2e/design-live-helpers.ts` only if a third spec needs them; otherwise import by re-export.
  - **A. Add ▸ Page from app.**
    - Open the dialog and check it lists `/`, `/pricing`, `/blog/[slug]` and `/blog/hello-world`.
    - Filter `pri`, then Enter. The `/pricing` frame goes live and its iframe shows `Pricing`.
    - Add the same route again. It is focused, and the frame count stays the same.
    - ⌘Z removes it.
  - **B. Written route.**
    - The fake model's `write_file` of `src/routes/about.tsx` (with `<h1>About</h1>`) puts one `/about` frame on the chat's page, live, showing `About`.
    - Its `edit_file` of the same file changes the heading in place, and the frame count stays the same.
  - **C. Component edit.** An `edit_file` of `src/components/Banner.tsx` places nothing new, and the open `/` frame shows the new banner text through HMR.
  - **D. Entry.** A fresh chat entering design mode on the fixture gets one `/` frame.
  - **E. Two chats.** Chat A writes `src/routes/a.tsx` while chat B's canvas is on screen. A's page gets `/a`, and B's page gets nothing.
  - **F. Removed.** Delete the `/about` frame, then the model edits `about.tsx` again. No frame returns.
  - **G. Flag off.** The Add menu has three items, and a route write places nothing. This runs in the existing flag-off v1 project.
- [ ] **Step 2: Run it in the Space:**
  `npm run test:e2e:space -- --run bash -c "npm run build && npx playwright test tests/e2e/design-live-routes.spec.ts"`
  Then run the flag-on and flag-off v1 design suites and `design-live-frames.spec.ts`, which must still pass. Expected: PASS. Record any flake per AGENTS.md: rerun once, then record the spec, the symptom and the run link.
- [ ] **Step 3: Take screenshots** (`shoot`), in light and dark:
  - (1) the Add menu with **Page from app…**;
  - (2) the picker with the filter, a dynamic row with its value, and the "Go to" row;
  - (3) the picker with two apps;
  - (4) the fallback source line;
  - (5) a written route's frame just landed and focused;
  - (6) three variants grouped with `variantOf`, placed by the fake model with labels;
  - (7) a phone-size app frame from `device: "phone"`;
  - (8) `canvas_read`'s blocked count is model-facing only, so no shot.
  - Save them under `test-results/design-live-routes/`. They go in the PR body, not the repo.
- [ ] **Step 4:** Add the spec to `scripts/ci-e2e-spec-map.json` (design lane), run `npm run test:ci-policy`, and commit `test(design): routes and route-aware placement E2E`.

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
- Modify: `docs/analytics.md` (Task 9 adds the row; recheck it).
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
| S78 | Route discovery reads files only, bounded and no-follow, split into pure rules and a disk walker | §6.3.6 |
| S79 | One pattern syntax, Next's brackets, for every framework and for `params` keys | §6.3.6 |
| S80 | The conventions table, and `/` plus canvas.json for everything else | §6.3.6 |
| S81 | `routes` replaces discovery, `params` fills patterns, and the limits | §6.3.6 |
| S82 | `design_app {action: "routes"}` | §6.5 |
| S83 | Route-aware placement: file tools only, deepest root, dynamic routes only with a value, `removedAppRoutes`, one snapshot per turn, and the entry rule | §6.3.7 |
| S84 | S18's order for every placement; "where Aiden's work lands" rewritten | §6.5 |
| S85 | `device`, `variantOf`, `label`; update `route`/viewport/`device`; `canvas_read` `blocked` as a count only; errors move to Phase 4; one analytics dependency on the canvas tools | §6.5 |
| S86 | The live prompt and skill are static per flag, under one skill name; `data-aiden-comment` moves to Phase 4; "ask which to keep" until Adopt (Phase 5) | §6.5 |
| S87 | Add ▸ Page from app… and its IPC, following `placeArtifact` | §6.3.6 |
| S88 | `design_app_frame_added` buckets and sources | §6.10 |

## Verification

Run, in order, each expected to pass:
1. `npx tsx --test renderer/shared/design-canvas/app-routes.test.ts renderer/shared/design-canvas/app-devices.test.ts renderer/shared/design-canvas/schema.test.ts`
2. `npx tsx --test main/services/design-canvas/app-server/app-routes-core.test.ts main/services/design-canvas/app-server/app-routes.test.ts main/services/design-canvas/app-server/app-server-main.test.ts main/services/design-canvas/app-server/app-tool.test.ts main/services/design-canvas/canvas-config.test.ts`
3. `npx tsx --test main/services/design-canvas/canvas-tools.test.ts main/services/design-canvas/written-pages.test.ts main/services/design-canvas/store.test.ts main/services/skill-registry.test.ts main/services/design-canvas/skill.test.ts main/services/design-canvas/app-frames/app-frame-registry.test.ts main/handlers/design-canvas.test.ts`
4. `npx tsx --test main/services/analytics/analytics-feature-reports.test.ts`
5. `npx tsx --test renderer/design/app-route-picker.test.tsx renderer/design/use-design-canvas.test.tsx renderer/design/design-canvas.test.tsx`
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
| 2 | **Regex parsing of `routes.ts`** misreads a clever config. | Only literal calls are accepted; anything else returns `null`, which means fallback. A wrong list is visible in the picker and fixed by canvas.json. No code runs. |
| 3 | **A written file named by a config the flat rule disagrees with** (React Router with a custom `routes.ts` mapping `pages/x.tsx` to `/y`). | `routeForWrittenFile` uses the flat rule only, so it may place nothing for such a file, which is safe. The list from `design_app routes` is still right, and the skill says to place the route with the tool when nothing lands. |
| 4 | **Placement races detection.** The turn's snapshot is taken once, so an app made this turn isn't seen until the next turn. | Accepted (S83). The tool can place the frame. |
| 5 | **Too many frames.** A turn that scaffolds 30 routes would place 30 live frames, while only six can be live (3a). | Written-route placement reuses the written-pages per-turn limit (`limit`), and frames past the six-live limit show snapshots, as 3a built. Written-route placement is capped at 12 new app frames per turn, the same as entry (`EARLIER_PAGES_LIMIT`). Later route files in that turn place nothing, and Aiden can place them with the tool (Task 7's 13-file case). |
| 6 | **`removedAppRoutes` grows without bound.** | Capped at 200, newest kept, as `removedPagePaths` is. |
| 7 | **Route strings as prompt injection.** A file named `ignore-all.tsx` becomes `/ignore-all`. | Routes reach the model only as JSON string values in tool results, and `isAppRoute` bounds length and characters. That matches how the model already sees workspace file names. |
| 8 | **Big monorepo walks** slow the picker. | Caps of 2 000 entries and depth 10, a 5 s cache, and `truncated` shown as "N more". The walk runs on main's event loop with `readdir` batches, never a sync walk. |
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

## As built

(Filled in during the build: deviations, build status and Space outcomes.)
