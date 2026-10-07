# ADR-F: Studio Foundation

Status: Proposed (Phase 0 deliverable; needs owner approval)
Date: 2026-10-07
Baseline: `main` @ `bd232b85` (line numbers below are from this commit)
Parent plan: [Design Studio + Create Images rebuild](design-studio-create-images-rebuild-plan.md) §6 ADR-F and §7 Track F
Consumers: [ADR-DS](design-studio-adr.md), [ADR-CI](create-images-adr.md)
Task plan: [studio-foundation-tasks.md](studio-foundation-tasks.md)

Track F owns every shared hotspot once, so the two feature tracks touch only their own files afterwards. This ADR records each decision against the code that exists today. Where it departs from the umbrella plan, the departure is marked **(deviation)** and justified.

## F-D1 Capabilities and flags

**Today.** `appHandlers.getInfo()` (`main/handlers/app.ts:31-54`) returns a `capabilities` object that the renderer parses fail-closed in `parseAppCapabilities` (`renderer/lib/app-capabilities.tsx:38-60`). Experimental features read an env flag through a pure, injectable function: `devicesEnabled(environment, platform)` reads `AIDEN_EXPERIMENTAL_DEVICES` (`main/services/devices/feature-flag.ts:1-14`), and `geminiLiveEnabled(environment)` reads `AIDEN_EXPERIMENTAL_GEMINI_LIVE` (`main/services/gemini-live/feature-flag.ts:10-17`).

**Decision.**
- New module `main/services/studio/feature-flags.ts`, which is Electron-free:
  - `DESIGN_STUDIO_FEATURE_FLAG = "AIDEN_EXPERIMENTAL_DESIGN_STUDIO"`
  - `CREATE_IMAGES_FEATURE_FLAG = "AIDEN_EXPERIMENTAL_CREATE_IMAGES"`
  - `designStudioEnabled(env)`, `createImagesEnabled(env)`, `studioAssetsEnabled(env)` (true when either is on), and `studioCapabilities(env): { designStudio; createImages }`
- Each flag is on only for `"1"` or `"true"`, trimmed and case-insensitive. This matches the devices parser. The flags are not platform-gated, because neither feature needs macOS-only APIs.
- `getInfo()` spreads `...studioCapabilities()`. `AppCapabilities` gains `designStudio` and `createImages`, both `false` in `DISABLED_APP_CAPABILITIES` and `=== true` in the parser.
- **No Settings toggle in Track F.** A Settings switch would itself be a visible trace when the flags are off (umbrella §3.3). It would also need a persisted `AppSettings` field, portable-config handling and a `settings-design-system.md` section. The owner tests with `AIDEN_EXPERIMENTAL_DESIGN_STUDIO=1 npm run dev`. A "Labs" opt-in switch can come with each track's release-readiness phase (CI-4, DS default-on), and the env var stays as the kill switch. *(Open question Q1.)*

## F-D2 Routes: under `chatLayoutRoute`, not root **(deviation)**

**Today.** `/settings` is a root route (`renderer/main/router.tsx:174-183`) and has no sidebar. The sidebar is rendered only by `ChatLayout`'s `SplitView` (`renderer/main/chat-layout.tsx:93-118`). `/scheduled`, `/profile` and `/bots` are children of `chatLayoutRoute`. `ChatLayout` hides `TerminalDrawer` with a pathname check (`chat-layout.tsx:109-114`) and passes `suppressed` to `EnvironmentWorkbench` only for remote hosts (`:104`).

**Decision.** Register four lazy routes under `chatLayoutRoute`: `/design`, `/design/$projectId`, `/images` and `/images/$workflowId`.
- The routes render `lazyRouteComponent(() => import("../design/design-route"), "DesignRoute")` and `lazyRouteComponent(() => import("../images/images-route"), "ImagesRoute")`. These are wrapped by `preloadsWith` and a new `StudioCapabilityRoute` (`renderer/main/studio-capability-route.tsx`), which renders `<Navigate to="/" replace />` when its capability is off. This copies `BotsCapabilityRoute` (`router.tsx:45-48`).
- Track F registers the param routes too, so the feature tracks only replace `renderer/design/design-route.tsx` and `renderer/images/images-route.tsx` and never edit `router.tsx` again.
- `chat-layout.tsx` gets one predicate, `isStudioPath(pathname)` from the new `renderer/shared/studio-routes.ts`. It is added to the `suppressed` expression and to the `TerminalDrawer` exclusion. That is two expressions, and the workbench's open/closed state is preserved, exactly as for remote hosts.
- `workspaceCommandVisibility` (`renderer/lib/command-system-core.ts:41-52`) also returns `environment: false` on studio paths, so Cmd+Shift+E cannot toggle a hidden panel.

**Why not root routes** (the umbrella's wording): a root route loses the sidebar, as Settings does. Keeping the sidebar would need a second `SplitView` + `ChatSidebar` (2,131 lines) under a sibling layout. That remounts the sidebar on every Chat↔Studio switch, losing scroll state and causing a visible flash, and it duplicates `ChatLayout`'s `chats:metadata-updated` and `chats:fork-summary-changed` listeners. The nested route costs two expressions in `chat-layout.tsx` that Track F owns. The feature tracks still never edit it.

## F-D3 Sidebar rows

**Today.** The top nav is an inline block at `renderer/components/chat-sidebar.tsx:1662-1684` (New Agent, Scheduled, Bots behind `capabilities.bots`). The only tests for it are the source-grep tests in `chat-sidebar.test.tsx:17-39`.

**Decision.**
- Extract the block into `renderer/components/sidebar-primary-nav.tsx`, a `<nav aria-label="Primary">` with props `{ pathname, capabilities, newAgentDisabled, onNewAgent, onNavigate }`. Add **Design** (lucide `PenTool`) and **Images** (lucide `Images`) after Bots, each rendered only when its capability is on.
- A row is selected when `studioFeatureForPath(pathname)` matches its feature.
- There is no "Create" heading. For two rows a heading adds visual weight without helping; it can be added if a third studio surface appears. *(Small deviation from umbrella §6.)*
- The rows reuse `SidebarListItem`, its fill focus state and `aria-current="page"`. No brain icons.
- The two source-grep tests are **replaced** by a `renderToStaticMarkup` + `@xmldom/xmldom` render test, following the pattern in `sidebar-organize-menu.test.tsx`. This follows the AGENTS.md rule to replace grep coverage when changing a surface.

## F-D4 Commands

**Today.** `COMMAND_IDS` and `COMMANDS` live in `renderer/shared/keybindings.ts:5-306`. The palette lists `COMMANDS.filter((d) => d.showInPalette)` (`command-palette.tsx:164`) and disables a command when it has no handler (`:214`). That would leave a disabled studio row visible with the flags off.

**Decision.**
- Add `"design.open"` ("Open Design Studio") and `"images.open"` ("Open Create Images"). Both have category `Navigate`, `defaultBinding: null`, `showInPalette: true`, `showInSettings: false`, no `nativeMenu` and no global binding.
- `CommandDefinition` gains an optional `requiresCapability?: StudioFeature`.
- The new pure function `paletteCommands(capabilities)` in `command-system-core.ts` replaces the inline filter, so with a flag off the command is absent rather than disabled.
- Handlers are registered in `RootContent` (`renderer/main/root-view.tsx`, next to `settings.open` at `:159`) and guarded by the capability and the existing `navigationBlockedReason`.
- Shortcut customization waits for default-on, when `showInSettings` flips.

## F-D5 Hidden feature chats: one central classifier

**Model.** DS adds `chat.owner = { kind: "design-project", projectId }` (ADR-DS §1). F-3 adds the field, its parser, and one classifier in `renderer/shared/chat-visibility.ts`. That folder is Electron-free and bundled by the CLI.

```ts
export type ChatOwnerV1 = { kind: "design-project"; projectId: string };
export type ChatSurface = "regular" | "assistant" | "bot" | "feature";
export function chatSurface(chat: { workspaceId?: string; botId?: string; owner?: ChatOwnerV1 }): ChatSurface;
export function isUserVisibleChat(chat): boolean; // chatSurface(chat) === "regular"
```

- **Precedence:** `owner` → `feature`, then `botId` → `bot`, then the persisted Assistant workspace → `assistant`, else `regular`.
- **Sites admit surfaces by allow-list,** so any future owner kind is hidden everywhere by default.
- **The store refuses bad combinations.** `chatStore.create` refuses `owner` together with `botId`. `isValidMeta` (`chat-store-core.ts:355`) accepts only `owner === undefined` or a valid `ChatOwnerV1`. A damaged owner makes the whole record invalid, which fails closed (hidden) rather than leaking it into the sidebar.
- **Only main-internal callers can set `owner`.** `metaOf` (`:924`) propagates it, `copyVisibleHistory` never copies it and refuses an owned source, and public parsers (`parseChatCreate`, Remote create) cannot produce it.

**Constraint (from the DS ADR).** `chatStore.list()` and `listSummaryMetadata()` stay **unfiltered**. Startup reconciliation derives the live chat-ID set from `chatStore.list()` (`main/index.ts:1899-1905`) and then garbage-collects `piRuntimeEffectStore` and `piCompactionSessionStore` state for missing IDs. F-3 moves those lines into `reconcileChatScopedStores(chatStore, stores)` (`main/services/startup-chat-reconciliation.ts`) and pins with a test that a hidden chat's ID still reaches every store. `fork-summary-service-main.ts:48`, `empty-chat-migration-main.ts:73`, `bot-capability-services-main.ts:107` and `bot-inbox-projection` (`listChatMetadata: () => chatStore.list()`) also keep the full list.

**Every current site** (grep of `ASSISTANT_WORKSPACE_ID`, `botId === undefined`, `listRegular`, `listSummaryMetadata` and `chatStore.list(` across `main/` and `renderer/`):

| # | Site | Today | F-3 change | Projections covered |
|---|---|---|---|---|
| 1 | `chat-store-core.ts:1076` `listRegular` | `botId === undefined` | surface ∈ {regular, assistant} (Assistant inclusion unchanged) | `chats:list` IPC → sidebar, sidebar search, palette chat search, `ChatIndex`; Remote `list()` (`aiden-remote-chats.ts:1302`) |
| 2 | `aiden-remote-chats.ts:460-466` `safeSummaryMetadata` | bot or Assistant → null | surface === regular | `/chat-summaries` pages and cursors (`:1332`, `:1354`); host-feed summaries (`:1417`); host-feed runs, which `aiden-remote-host-feed.ts:272-277` drops when they have no summary; peer desktops and native clients, which consume these projections |
| 3 | `aiden-remote-chats.ts:1431` `classify` | Bot classification only | surface === feature → `not_found` | Every per-chat Remote route through `requireChatAccess` / `runChatMutation` (`aiden-remote-router.ts:844-878`, 32 call sites): get, messages window, turns, attachments, rename, move, fork, remove |
| 4 | `aiden-remote-chat-progress-authorize.ts:76-85` | Assistant → 404 | surface ∉ {regular, bot} → 404 | Remote task/agent progress |
| 5 | `chat-fork-service.ts:130-135` | Assistant → `ineligible` | Assistant or feature → `ineligible`; also guarded in `copyVisibleHistory` | Desktop and Remote fork/copy |
| 6 | `rpiv-btw/service-core.ts:108` | bot or Assistant → refuse | surface !== regular → refuse | Side questions |
| 7 | `empty-chat-migration.ts:43-46` | not bot, not Assistant | surface === regular | Startup empty-chat sweep (it must never delete a freshly created, empty project chat) |
| 8 | `aiden-remote-chats.ts:1418-1422` `botChatIds` | `botId !== undefined` | unchanged (the store rejects owner + bot) | Host-feed Bot runs |
| 9 | `aiden-remote-chats.ts:1856` skill catalog | Assistant → empty | unchanged (`classify` refuses feature chats first) | – |
| 10 | `main/handlers/chats.ts:160` `chats:todoSnapshot` | Assistant → null | unchanged; a design chat has no todo tool, so this is not a projection | – |
| 11 | `chat-workspace-authority.ts:40-45` | Assistant mode authority | **DS-1a**, per ADR-DS §1 (design runs only) | – |
| 12 | `chat-application-service.ts:158`, `chat-first-message-params.ts:38`, `chats.ts:262`, `config-store-core.ts:1208` | Reserve the Assistant workspace ID on creation | unchanged: creation guards, not visibility | – |
| 13 | `renderer/main/chat-pane.tsx:239`, `assistant/use-assistant-chat.ts:326,673` | Assistant UI | unchanged | – |
| 14 | `main/index.ts:1899-1905`, `fork-summary-service-main.ts:48`, `empty-chat-migration-main.ts:73`, `bot-capability-services-main.ts:107`, `aiden-remote-service-main.ts:734` | Full `list()` | **must stay unfiltered**; the first is extracted and tested | Startup and background reconcilers |

**Wire shape.** There is no change. `owner` is never projected: `projectAidenRemoteChat` and `safeSummaryMetadata` build explicit field lists. Owned chats are simply absent or `404`. `AIDEN_REMOTE_CONTRACT_REVISION` stays `24` (`aiden-remote-protocol.ts:34`), `protocol/aiden-remote/v1/fixtures/contract.json` is unchanged, and iOS and Android need no code changes. Their suites still run as regression evidence.

**Finding (not changed here).** Remote `list()` without a `workspaceId`, and `classify()` / `get()` by ID, do not exclude **Assistant** chats today. Only summaries and progress do. F-3 keeps Assistant behavior unchanged, as umbrella §7 requires. *(Open question Q2.)*

**Separate PR.** F-3 ships as its own PR (`feature/studio-chat-visibility`), in parallel with the rest of Track F. It touches only Remote/core files plus `main/index.ts:1899-1905`, needs the Remote and native suites, and does not depend on the flags. DS-1a depends on both PRs.

## F-D6 Studio asset store, `aiden-asset:` protocol and grants

**Ported vs dropped.**

| Reference module | Fate |
|---|---|
| `asset-image-validation-core.ts` (343 lines, PNG/JPEG only) | **Dropped.** Main already has the stricter shared validator that Pi image outputs go through: `displayImageDimensions` + `validateDisplayImageDimensions` (`main/services/display-image-extension.ts:326,364`), with structure checks, no APNG, a 16,384 px edge and 20 MP. CI-1 stores Pi outputs, which may be WebP; the old validator would reject them. The new `image-validation-core.ts` (~70 lines) sniffs PNG/JPEG/WebP magic bytes, rejects a declared-MIME mismatch, enforces limits (`too_large`) and then delegates the structure check (`invalid_image`). |
| `asset-delivery-core.ts` (224) | **Ported and simplified** as `delivery-core.ts` `StudioAssetGrants`. Dropped: leases, TTL renewal, per-request "protocol tickets", frame authorization. |
| `asset-protocol.ts` (151) | **Rewritten** as a pure `request-handler.ts` plus a 15-line `protocol.ts`. Dropped: the global `webRequest.onBeforeRequest`, the egress guard, the favicon exception, request observers and the second `registerSchemesAsPrivileged`. |
| `asset-store-core.ts` (2,032) | **Rewritten** at ~300 lines. Dropped: quarantine directory, workspace mirror / Finder sync, repair reports, GC plan/apply two-phase, reference epochs, thumbnail LRU accounting, preview leases. |

**Layout** (created only when `studioAssetsEnabled()`):

```
<userData>/studio-assets/assets-v1.sqlite      node:sqlite, WAL, synchronous=FULL, user_version=1
<userData>/studio-assets/blobs/<id[0..2]>/<id>  immutable bytes; id = sha256 hex; writeFileAtomic({ exclusive: true, mode: 0o600 })
<userData>/studio-assets/thumbs/<id>-<edge>.png regenerable cache; writeFileAtomic({ fsync: false })
```

```sql
CREATE TABLE assets (id TEXT PRIMARY KEY, media_type TEXT NOT NULL, bytes INTEGER NOT NULL,
  width INTEGER NOT NULL, height INTEGER NOT NULL, created_at INTEGER NOT NULL, touched_at INTEGER NOT NULL);
CREATE TABLE holds (holder TEXT NOT NULL, asset_id TEXT NOT NULL REFERENCES assets(id),
  PRIMARY KEY (holder, asset_id));
CREATE INDEX holds_by_asset ON holds(asset_id);
```

**API** (`main/services/studio-assets/store.ts`, class `StudioAssetStore`). The names match ADR-CI §2.3 and ADR-DS §2.
- `initialize()`
- `put({ bytes, declaredMimeType? }) → StudioAssetRecord`: deduplicates by sha256 and refreshes `touched_at` on a hit.
- `get(assetId)`, `read(assetId) → { record, bytes }`
- `thumbnail(assetId, 256 | 512) → { bytes, mediaType }`
- `retain(holder, assetIds)`, `release(holder, assetIds)`, `releaseAllForHolder(holder) → number`, `replaceHolder(holder, assetIds)`
- `holders(assetId)`, `usage()`, `collectGarbage()`, `close()`

A holder is `{ kind: "design" | "images-workflow" | "images-run"; id }`. Its key is `` `${kind}:${id}` ``, which gives exactly the strings the other ADRs use: `design:<projectId>`, `images-workflow:<id>` and `images-run:<runId>`. `retain` fails with `not_found` for an unknown asset, inside one transaction.

**Limits** (`contract.ts`):

| Limit | Value |
|---|---|
| Asset size | 32 MiB |
| Store total | 10 GiB (owns the old `CREATE_IMAGES_MAX_TOTAL_ASSET_BYTES`) |
| Asset count | 100,000 |
| Image size | 16,384 px edge, 20 MP |

Over-limit puts fail with `quota` or `too_large`.

**GC model: holders, not counters.** `collectGarbage()` deletes rows with no holds whose `touched_at` is older than a **1 h grace**, inside one synchronous transaction, then unlinks the blob and thumbnails. `touched_at` is refreshed by `put` (dedup hit) and by any release, so an asset that was just imported, just released or is still on screen survives. GC runs from `initialize()` (startup) and whenever a feature calls it, for example after pruning runs. Crash windows:
- **Blob written, row not inserted:** the orphan blob is swept by `initialize()`, together with `.*.tmp` staging files.
- **Row deleted, files remain:** swept the same way.

Because `node:sqlite` is synchronous, a GC transaction can never interleave with a `retain`.

**Thumbnails.** These go through the `StudioAssetThumbnailer` port. Production uses `nativeImage` (`studio-assets/thumbnailer-main.ts`, following `bot-avatar-image-main.ts:24-53`): decode, `isEmpty()` check, resize the longest edge, `toPNG()`. When the source's longest edge is ≤ the requested edge, or decoding fails, the original is served. `nativeImage` only promises PNG/JPEG, so WebP falls back to the original. Successful thumbnails are cached.

**Grants** (`StudioAssetGrants`).
- `issue(owner: RendererDocumentOwner, assetId, rendition: "original" | "thumb-256" | "thumb-512") → "aiden-asset://grant/<43-char base64url token>"`.
- Tokens are bound to the issuing document and dedupe per (document, asset, rendition).
- They are revoked by `owner.onInvalidated` (navigation, reload, crash, destroy; see `renderer-document-owner.ts:41-55`). They have **no TTL**, so a long-open canvas never needs to renew.
- Capacity is 8,192 grants with oldest-first eviction.
- The feature handler is responsible for authorization: it issues a grant only for assets held by a project or workflow the user has open.
- Without a global `webRequest` listener, the protocol cannot see the requesting frame. A token is therefore an unguessable 256-bit capability given only to the main-window document, and guest `aiden-genui:` frames cannot load it because of their CSP.

**Protocol.** `createStudioAssetRequestHandler({ store, grants })` is pure and testable with WHATWG `Request` / `Response`:
- `GET` / `HEAD` only (otherwise 405).
- The URL must be exactly `aiden-asset://grant/<token>` with no query or fragment (otherwise 404).
- An unknown or revoked token returns 404; store failure returns 503.
- Responses carry `content-type`, `cache-control: no-store`, `x-content-type-options: nosniff` and `content-disposition: inline`.

`protocol.ts` calls `protocol.handle("aiden-asset", handler)` once.

**One privileged-scheme call.** `registerGenerativeUiScheme()` (`generative-ui-protocol.ts:31-46`, called at `main/index.ts:162`) is replaced by `registerCustomSchemes({ studioAssets: studioAssetsEnabled() })` from `main/services/custom-schemes.ts`. A pure `custom-schemes-core.ts` builds the list and enforces a single call.
- `aiden-genui` keeps its exact privileges: standard, secure, stream, no fetch, no CORS.
- `aiden-asset` gets the same privileges with `bypassCSP: false` and `allowServiceWorkers: false`.
- With both flags off, only `aiden-genui` is registered, as today.

**CSP: one explicit token.** `main-window.html:8` `img-src 'self' data: blob: file: https: http:` gains `aiden-asset:`. Nothing else changes: not `connect-src`, `media-src` or `frame-src`, and `file:` stays.
- This is the only CSP edit, and the umbrella requires an ADR line for it.
- It is static and therefore present with the flags off. It is inert there: no handler is registered and no grant can exist, so every `aiden-asset:` load fails.
- *Rejected alternative:* `blob:` URLs built from IPC byte transfers. That needs no CSP edit, but it duplicates image bytes into the renderer and leaves a manual revoke lifecycle on every canvas node. *(Open question Q3.)*

## F-D7 Canvas kit (`renderer/canvas/`)

**Dependency.** `@xyflow/react` **`12.11.6`**, exact, in `devDependencies` (renderer-only, like `@tanstack/react-router`).
- It is the version `ref-design-studio`'s lockfile resolved for `^12.11.5`, with `@xyflow/system 0.0.82`. That is newer than `ref-create-images`' `12.9.3` / `0.0.73`, and both are MIT.
- It adds `zustand@4`, `classcat`, `d3-zoom`, `d3-drag`, `d3-selection` and `d3-interpolate` to the lockfile.
- No registry lookup is needed. `THIRD_PARTY_NOTICES.md` gains a hand-written "React Flow (@xyflow/react)" MIT entry, as `three.js` has.
- Attribution is hidden (`proOptions.hideAttribution`), which the MIT license permits, and credit goes in the notices.

**CSS.** `renderer/canvas/styles.ts` imports `@xyflow/react/dist/base.css` and `./studio-canvas.css` (tokens only: `--color-background`, `--color-separator`, `--color-list-selection`, `--focus-ring`). Only the two lazy route modules import it, so Vite emits it with the lazy chunk. Node tests never import `styles.ts`.

**Surface.**

| Export | Purpose |
|---|---|
| `<StudioSurface title actions>` | Route chrome: drag-region header plus a full-height body. It uses a new `useSplitViewCollapsed()` exported from `ui.tsx` for the collapsed-sidebar inset, matching `ScrollArea` (`ui.tsx:1016-1024`). |
| `<StudioCanvas>` | Generic over xyflow `Node` / `Edge`. Wraps `ReactFlowProvider` + `ReactFlow` with dot `Background`, an optional `MiniMap`, the tool rail and the zoom controls. Select tool: marquee select, middle/right-drag pan. Hand tool: drag pans, selection off. Space-to-pan is xyflow's default `panActivationKeyCode`. Zoom 0.1–4. The wrapper is a focusable `role="region"` with the neutral focus ring. Shows `emptyState` with zero nodes. |
| `<CanvasToolRail tool onToolChange>` | A `role="toolbar"` of `Button` toggles (`aria-pressed`, `aria-keyshortcuts` V/H). No borders; selection uses the `muted` fill. |
| `<CanvasZoomControls zoom …>` | Zoom out / percent readout / zoom in / fit / minimap toggle. Presentational. |
| `<CanvasNodeChrome title selected status?>` | Shared node frame for DS Screen nodes and CI nodes. |
| `canvas-keymap-core.ts` `resolveCanvasKey(event, { editable })` | Unmodified keys only, handled on the canvas region and never window-global, so no globally reserved shortcuts: V, H, `=`/`+`, `-`, Shift+1 fit, Shift+0 100 %, M minimap. Returns null in editable targets, with any modifier, during IME composition, or for repeated tool keys. |

## F-D8 Startup

Inside the reconcile chain, after `registerGenerativeUiProtocol()` (`main/index.ts:1760`) and before `openProcessStartupIpcAdmission()` (`:2050`):

```ts
if (studioAssetsEnabled()) {
  try {
    await studioAssetStore.initialize();
    registerStudioAssetProtocol(createStudioAssetRequestHandler({ store: studioAssetStore, grants: studioAssetGrants }));
  } catch (error) {
    logger.warn("studio", "Studio assets are unavailable; Design and Images will report a storage error.", error);
  }
}
```

The singletons live in `studio-assets/main.ts`, where the root is `app.getPath("userData")/studio-assets` and is resolved lazily. With the flags off, no directory or database is created. Protocol requests are not IPC, so startup admission (`startup-ipc-admission.ts:22-46`) does not hold them. They cannot arrive early anyway, because grants are only issued by feature IPC, and that IPC is admitted after this point. DS and CI stores initialize next to this block.

## F-D9 Test lanes **(deviation)**

**Today.** `scripts/ci-test-registry.json` has exactly three unit lanes (`core-git`, `runtime-subagents`, `renderer-other`). They are hard-coded in the `.github/workflows/ci.yml:227` matrix and asserted in `scripts/ci-test-registry.test.mjs:20-24`. Every file reachable from `pretest:serial`/`test:serial` must belong to exactly one lane (`validateRegistry`, `ci-test-registry.mjs:403-421`).

**Decision.**
- **No new registry lanes.** Each new lane would add a macOS-26 hosted runner per PR, plus matrix and policy-test edits.
- Instead, each feature gets an **npm suite script** appended to `test:serial`: `test:chat-visibility` (F-3), `test:studio-foundation`, and later `test:design-studio` and `test:create-images`. Their files are assigned to the existing lanes: `main/**` → `core-git`, `renderer/**` → `renderer-other`. Remote-adjacent edits stay in their current `runtime-subagents` files.
- Perf tests (`test:create-images:perf`, `test:design-studio:perf`) are standalone scripts **not** reachable from the serial graph, like `test:compaction:evaluate`.
- New Playwright specs are discovered automatically by `scripts/ci-e2e-shards.mjs` (`discoverSpecs`).

*(Open question Q4.)*

## F-D10 Bundle budget

`scripts/check-renderer-bundle-budget.mjs` caps entry + modulepreloads at 3,520,000 B raw / 1,075,000 B gzip.
- The entry chunk gains only the routes, the sidebar rows, the command rows, `chat-visibility.ts` and `studio-routes.ts`. That is expected to be under 4 KB raw.
- React Flow, `base.css` and the kit load only with `/design` or `/images`.
- The F PR records the before/after `check:bundle-budget` output.

## Open questions for the owner

| # | Question | Recommendation |
|---|---|---|
| Q1 | Should there be a Settings "Labs" toggle now? | No. Env flags only until each track's default-on phase. |
| Q2 | Should Remote also 404 **Assistant** chats by direct ID and drop them from workspace-less `list()`? | Yes, but as a separate small PR with native checks, not inside F-3. |
| Q3 | Is the one-token `img-src aiden-asset:` CSP edit, present while the flags are off, acceptable? | Yes. It is inert without a handler, and the alternative (blob URLs) costs memory and lifecycle code on every node. |
| Q4 | Is it acceptable to use per-feature npm suites in the existing CI lanes instead of three new registry lanes? | Yes. It avoids extra hosted runners; the narrow `npm run test:<feature>` command gives the same local loop. |

## Risks

| Risk | Mitigation |
|---|---|
| F-3 regresses Assistant or Remote listing | Assistant semantics are preserved site by site (table rows 1, 4, 5). Existing Assistant assertions stay green (`aiden-remote-chat-summaries.test.ts:150-178`, progress `:106-114`). Run `npm run test:aiden-remote` and the iOS/Android suites. |
| A future reconciler filters hidden chats and deletes their state | `reconcileChatScopedStores` is the single place, with a test. ADR-DS adds a compaction-session restart test. |
| `nativeImage` cannot decode WebP | Fall back to the original bytes (≤ 20 MP); covered by a fake-thumbnailer failure test. |
| A stale grant shows a deleted asset | Grants carry no lease, but GC keeps a 1 h grace after the last release. After that, a stale grant returns 404 and the feature shows a missing-image state. |
| xyflow behavior differs under Linux xvfb | The kit e2e uses keyboard and button paths for tools and zoom, plus one hand-tool drag. No trackpad gestures. |


## Orchestrator decisions on open questions (2026-10-07)

1. No Settings "Labs" toggle; env flags until each feature defaults on.
2. Remote's direct-ID/no-workspace access to Assistant chats is fixed in a separate small PR, not in Track F.
3. `img-src aiden-asset:` is accepted with both flags off (no handler registered → loads fail closed).
4. npm suites inside the existing CI lanes instead of new lanes.
