# Devices: 3D workspace, hardware models and iPhone Duo (October 2026)

Sibling B of the six-way T3 devices parity effort (shared context: base `4cb409d5`, T3 at `a6ec88f7`). Plan doc: `docs/plans/simulator-devices-phase-6-3d.md`; user docs: `docs/devices.md` → "3D view" and Internals → "3D viewer".

## Decisions
- **No Apple assets, ever.** T3's `.glb` bodies and Apple USDZ files have no redistribution licence. Only T3's GLB *metadata* was read (node names, hinge rig, display layout, proportions). Bodies are original procedural three.js models built in mm from public spec sheets (`hardware-models.ts`, `duo-model.ts`) and scaled to T3's normalized contract (display 2.2 units tall; Duo `left-half`/`right-half`, `cover-display`, `inner-display-left|right`). T3's Duo glyphs are Simulator-derived, so `device-duo-controls.tsx` draws its own.
- T3's viewer code is ported 1:1 where it applies: `device-motion`, `view-snap`, `framing`, `interaction` (log zoom), `trackpad`, `duo-scene`, `duo-snap`, `duo-viewer`, `android-fold-scene`, `model-scene` (contract + validation). T3's async model slot is gone: models build synchronously, so "config before model" cases collapse.
- Viewers take an injectable `ViewerRuntime` (`viewer-runtime.ts`): renderer, PMREM `RoomEnvironment`, 2D canvases, clock, rAF, timers, reduced motion. That is how the T3 viewer tests run under `node:test` without mocking `three` (`viewer-test-support.ts`).
- Model registry (`model-registry.ts`, no `three` import): exact names only. 17 Pro / 18 Pro → `iphone-pro`; Pro Max likewise; iPad Pro 13-inch M4 and M5 share a chassis → `ipad-pro-13`; `iPhone Duo`. `isDuoDevice` also treats any iOS screen reporting `supportsHingeAngle` as a Duo (renamed simulators).
- Hinged devices are no longer forced flat. Blockers are now `mjpeg`, `failed` (WebGL or undecodable Duo feed; sticky until the viewer reopens, one toast) and `duo-hub` (Duo without hinge fields: "iPhone Duo 3D requires Device Hub 0.11.0 or newer").
- Rail: **3D view** / **Flat view** (both `aria-pressed`) and **Restore 3D view** (resets pose and zoom; non-Duo devices also rotate back to portrait, as in T3). The e2e stream spec now uses these names.
- Duo stream feeds live in `renderer/lib/device-duo-stream.ts` with small hooks in `device-stream.ts` (`panelId`/`videoOnly` target fields, `onDuoUnavailable`, `sendRawTouch`, `setDuoPanels`, `duoPanels.screenChanged` before `events.onScreen`, `duoPanels.stop()` in `stop`). Sibling A also edits `device-stream.ts`; keep these hooks when merging.
- Trackpad orbit end: main forwards `gestureScrollEnd` on notification channel `devices:trackpad-scroll-end` (Aiden's namespace, not T3's `desktop:`), via `forwardTrackpadScrollEnd(createdWindow.webContents)` in `main/index.ts`; renderer subscribes with `devicesApi.onTrackpadScrollEnd`.
- Framed screenshot: `PhoneViewer.capture()` / `DuoViewer.capture()` render and `toBlob` in one task. Exposed via the viewports' `onCaptureReady` prop; deliberately not wired to UI (sibling E owns "Save screenshot…").

## Integration (merged with A, C, D, E, F on 2026-10-08)
- **Android fold:** `device-viewer.tsx` passes `fold.angle` from A's `useAndroidFold` to `DevicePhoneViewport`; the Fold/Unfold controls now show in 3D too. Android has `kind: "other"`, so `resolveDeviceShape` picks android-phone/tablet by platform plus aspect.
- **Framed screenshot:** E's screenshot menu shows **Save framed screenshot…** only while `frame3d` and a capture exist. The renderer sends PNG bytes on `devices:framed-screenshot-save`; main (`device-feature-ipc.ts`) accepts only a PNG ≤ 32 MB plus a valid host/device, and `device-features.ts` `saveFramedScreenshot` writes it via the same save dialog (name `…-framed-…`), remembered for Reveal in Finder.
- **Mini-player (D):** streams flat only via `useDeviceStream`; the floating device's tab is a placeholder, so there is no second stream and no 3D/Duo feed. Inactive or hidden tabs unmount the 3D view, which detaches Duo feeds before the stream stops. `device-stream.ts` refuses Duo panels and raw touches on Android.
- Magic Keyboard accessory: not built (low priority).

## Verification
- `npm run test:devices` (299 tests at time of writing), `npm run type-check`, eslint on touched files, `npm run build` + `npm run check:bundle-budget` (three + models in one ~151 kB gzip lazy chunk; main window initial JS unchanged).
- Visual check: a scratch harness rendered each model through the real viewers in headless Chromium (SwiftShader). Lessons: a back-facing `ShapeGeometry` made with `rotateY(π)` mirrors X and moved Duo back parts onto the wrong leaf; `face(..., back)` now flips winding and normals instead. Wide black bezels need low `specularIntensity`, or the key light paints a white sheen on them.
