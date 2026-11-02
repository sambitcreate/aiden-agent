# Studio Foundation (Track F)

Status: merged in PR A (#375) and PR B (#376) on 2026-10-07; shipped in 0.55.0. Binding spec: `docs/plans/studio-foundation-adr.md`. Umbrella: `docs/plans/design-studio-create-images-rebuild-plan.md`. Next: DS-1 (Design Studio) and CI-1 (Create Images) fill the placeholder routes.

## Flags
- `AIDEN_EXPERIMENTAL_DESIGN_STUDIO` and `AIDEN_EXPERIMENTAL_CREATE_IMAGES` (values `1` or `true`, default off). Read in `main/services/studio/feature-flags.ts`, exposed to the renderer as the `designStudio` / `createImages` app capabilities.
- Run with a flag: `AIDEN_EXPERIMENTAL_DESIGN_STUDIO=1 npm run dev` (add the second variable for Create Images).
- Flags off: no sidebar rows, palette commands, routes, studio chunks, asset store or `aiden-asset:` scheme. The e2e flags-off spec and the sidebar and palette render tests pin this.

## Route contract
- Replace `renderer/design/design-route.tsx` (`DesignRoute({ projectId? })`) and `renderer/images/images-route.tsx` (`ImagesRoute({ workflowId? })`). Keep the export names and props.
- Never edit `renderer/main/router.tsx`; the lazy `/design`, `/design/$projectId`, `/images`, `/images/$workflowId` routes already wrap these in `StudioCapabilityRoute`, which redirects to `/` when the flag is off.
- Studio paths stay under the chat layout so the sidebar remains; `isStudioPath` in `ChatLayout` suppresses the Environment workbench and terminal there.

## Studio asset store and protocol
- `main/services/studio-assets/`: content-addressed store (put, dedupe, read, thumbnails 256/512, GC), PNG/JPEG/WebP only, magic-byte and pixel validation.
- Holder keys are `design:<id>`, `images-workflow:<id>`, `images-run:<id>`. `retain`, `release`, `releaseAllForHolder`, `replaceHolder` manage them. Unheld assets survive a 1 h GC grace (`gcGraceMs`) after their last put or release.
- Delivery uses document-bound grant URLs `aiden-asset://grant/<token>`. Feature handlers authorize the asset before `StudioAssetGrants.issue`. Grants are revoked when the renderer document navigates, reloads, crashes or closes (no TTL).
- Availability: `StudioAssetStore.status()` is `"closed" | "open" | "failed"`. When a studio flag is on, `installStudioAssetProtocol` installs the `aiden-asset:` handler right before `createMainWindow` in `main/index.ts`, ahead of the reconcile chain where `startStudioAssets` opens the store; if the store fails to open, requests get 503. The handler must exist before the main window loads: Chromium binds a document's custom-scheme subresource loaders when it commits, so a late `protocol.handle` makes every `aiden-asset:` image fail with `net::ERR_UNKNOWN_URL_SCHEME` (no handler call, no log) until reload. This bug shipped from 2026-10-07 to 2026-10-31; the Create Images E2E now asserts `naturalWidth > 0`.
- Store opening: a DB open failure for I/O or permission reasons rejects `initialize()` (status `"failed"`, retryable by calling it again). A corrupt DB or one with an invalid `user_version` is quarantined (0600) as `assets-v1.sqlite.corrupt-<timestamp>` and rebuilt, including once when the startup sweep/GC first hits a damaged page; a newer build's DB (`user_version` > 1) is left untouched and `initialize()` fails as unavailable from the content-addressed blobs; only while that rebuild is pending (a `recovery_pending` row written with the fresh schema and cleared atomically with the re-index insert, so an interrupted rebuild resumes on the next open), unindexed blobs that pass hash and validation are re-indexed instead of deleted and marked in the `recovered` table, which GC never collects (a re-hold by one owner doesn't prove the others came back), so recovered images are kept rather than risked; a `quota` refusal names their count and size. On an ordinary open an unindexed blob is a crashed put or a half-finished GC and is removed. GC also runs every 20 minutes and before a `quota` refusal. DB files are 0600. The orphan sweep and GC passes are non-fatal and go to the store's `onError`; quarantine and re-index notices go to `onWarning`. DS/CI surfaces should report a storage error when `status() !== "open"` (call `initialize()` to retry first).
- Limits live in `STUDIO_ASSET_LIMITS` (32 MiB per asset, 10 GiB total, 100k assets).

## Schemes and CSP
- `registerCustomSchemes` (`main/services/custom-schemes.ts`, called once from `main/index.ts`) is the only scheme registration; it registers `aiden-genui` always and `aiden-asset` only when a studio flag is on. Do not add another `registerSchemesAsPrivileged` call.
- CSP token `aiden-asset:` was added to `img-src` only in `main-window.html`. Not in `frame-src`, `connect-src` or `script-src`.

## Canvas kit (`renderer/canvas/`)
- Exports from `index.ts`: `StudioCanvas`, `StudioSurface`, `CanvasToolRail`, `CanvasZoomControls`, `CanvasNodeChrome`, `resolveCanvasKey`, `CanvasCommand`, `CanvasTool`, `CANVAS_MIN_ZOOM`, `CANVAS_MAX_ZOOM`, `formatZoomPercent`. Built on pinned `@xyflow/react`.
- Only route modules import `renderer/canvas/styles` (React Flow base CSS plus `studio-canvas.css`), so the CSS and library stay out of the entry chunk. Keys (V, H, M, =, -, Shift+0) act on the focused canvas only.
- React Flow and its bundled runtime deps (`@xyflow/system`, d3-*, zustand, classcat) are credited in `THIRD_PARTY_NOTICES.md`.

## Tests and CI
- Suites: `test:studio-foundation` (this track), `test:design-studio`, `test:create-images` (later tracks), filed into the existing CI lanes via `scripts/ci-test-registry.json`. No new CI lanes.
- Playwright: `tests/e2e/studio-foundation.spec.ts`.
- Pre-existing failure on `main`: `main/services/native-menu-command-contract.test.ts` ("every window creation path waits for settled startup shortcut state") in `test:command-system`.

## Bundle budget (`npm run check:bundle-budget`, main window initial JS)
- Main / pre-canvas baseline (F-2.2): 21526 B raw, 8249 B gzip.
- Branch (PR B head): 21594 B raw, 8284 B gzip (+68 B raw, +35 B gzip; sidebar rows and route stubs only).
