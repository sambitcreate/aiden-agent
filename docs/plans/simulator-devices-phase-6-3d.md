# Simulator Devices Phase 6: 3D Device Frames

Status: done (2026-09-25); T3 parity update 2026-10-08. Parent plan: [simulator-devices-plan.md](simulator-devices-plan.md).

## Goal

Show the live simulator screen inside a turnable 3D device in the Simulator tab, with the feel of T3 Code's device workspace, including the iPhone Duo and Android foldables, bundling T3's device models where they match and original procedural bodies elsewhere.

## Asset decision (2026-10-08)

The owner reversed the earlier ban: Aiden bundles T3's device GLBs, the same files T3 ships ("if t3 uses no license thing we should use the same"). They are Apple-derived AR assets (iPhone 18 Pro, iPhone 18 Pro Max, iPad Pro 13-inch M5, its Magic Keyboard, and the iPhone Duo with its centimetre hinge rig). **No redistribution licence is established for them**; the owner accepted that. Provenance, source URLs and SHA-256 hashes stay in `renderer/assets/devices/models/sources.json`, and `THIRD_PARTY_NOTICES.md` names them.

T3's GLB path is ported 1:1: exact device-name matching, an abortable, replaceable model slot, `GLTFLoader.parseAsync`, `?url` imports so the files stay out of the JavaScript and load only on demand, and the Magic Keyboard accessory. Aiden's **original procedural models** (built in three.js from public spec-sheet dimensions) remain: they show at once, cover devices without a GLB, and stay in place if a GLB fails to load or validate. T3's viewer code is ported (MIT, authorized) and runs against both through the same normalized contract.

## Scope

- **Full 3D feel**, ported from T3: a quaternion spring with flick coast and decay, release snapping to the nearest rest view with a yaw allowance, a critically damped camera refit, logarithmic pinch zoom, trackpad orbit that ends on Electron's native `gestureScrollEnd`, and a render-on-demand scheduler.
- **Hardware models**, matched by exact simulator name: 6.3-inch iPhone Pro (iPhone 17 Pro, 18 Pro), 6.9-inch iPhone Pro Max (17/18 Pro Max), 13-inch iPad Pro (M4 and M5 share a chassis), and the iPhone Duo. Everything else, including Android, uses family profiles (`ios-phone`, `ios-tablet`, `android-phone`, `android-tablet`). Exact T3 names (iPhone 18 Pro, iPhone 18 Pro Max, iPad Pro 13-inch (M5), iPhone Duo) then swap in the bundled GLB; the iPad's **Attach Magic Keyboard** rail button adds T3's keyboard accessory.
- **iPhone Duo in 3D**: an articulated body, pinch to fold with a hinge preview, animated folds that re-centre on the hinge, flip to the other display with a 5 s rollback, Duo snap views, per-display stream feeds, and orientation-following fold controls (Book ↔ Laptop label, rotating glyphs, stands send the hold orientation before the angle).
- **Android fold body**: T3's procedural book-style fold scene, selected when an Android profile has a fold angle.
- The flat screen stays the source of truth. Frames decode into the flat canvas; the 3D view samples it as a `CanvasTexture` (the Duo also draws its per-display feeds into two surface canvases).
- A per-viewer preference (`localStorage`, key `aiden.devices.framePreference`) picks 3D or flat, defaulting to 3D.
- The flat screen is used whenever 3D cannot work: the MJPEG compatibility stream, missing or lost WebGL, an undecodable Duo display feed, or a Duo hub without hinge readback ("iPhone Duo 3D requires Device Hub 0.11.0 or newer").

## Design

| File | Role |
| --- | --- |
| `renderer/lib/device-3d/model-registry.ts` | Exact simulator name → model id; `isDuoDevice`. No `three` import. |
| `renderer/lib/device-3d/model-kit.ts` | Continuous-corner outlines, slabs, lathe-turned lenses, PBR material kit, per-material merging. |
| `renderer/lib/device-3d/hardware-models.ts` | Original iPhone Pro, Pro Max and iPad Pro 13 models from spec dimensions. |
| `renderer/lib/device-3d/duo-model.ts` | Original iPhone Duo: two thin leaves, hinge barrel, three displays on T3's rig contract. |
| `renderer/lib/device-3d/model-scene.ts` | T3's normalized-model contract and validation; model disposal. |
| `renderer/lib/device-3d/shape-profile.ts`, `phone-scene.ts` | Family bodies, raw-framebuffer UVs and touch projection. |
| `renderer/lib/device-3d/android-fold-scene.ts` | T3's procedural Android fold body. |
| `renderer/lib/device-3d/device-motion.ts`, `view-snap.ts`, `framing.ts` | T3's spring, snapping and framing. |
| `renderer/lib/device-3d/interaction.ts`, `trackpad.ts` | Scheduler, pointer ownership, wheel navigation and log zoom, trackpad and Safari gestures. |
| `renderer/lib/device-3d/phone-viewer.ts`, `duo-viewer.ts` | The two viewers, with an injectable `viewer-runtime.ts` (renderer, PMREM `RoomEnvironment`, clock, frames, timers). |
| `renderer/lib/device-3d/duo-scene.ts`, `duo-snap.ts` | T3's Duo articulation, UVs, touch mapping and rest views. |
| `renderer/lib/device-duo-control.ts` | T3's Duo control queue, fold state, hold orientation and pinch accumulator. |
| `renderer/lib/device-duo-stream.ts` | Per-display Duo feeds, hooked into `device-stream.ts`. |
| `renderer/components/device-phone-viewport.tsx`, `device-duo-viewport.tsx` | React shells: lazy load, resize, pointer, trackpad and blur. |
| `renderer/components/device-duo-controls.tsx` | Fold and stance buttons with Aiden's own glyphs. |
| `main/services/devices/trackpad-scroll-end.ts` | Forwards `gestureScrollEnd` on `devices:trackpad-scroll-end`. |

Accessibility: the 3D wrapper is a focusable `role="application"` region that forwards keys like the flat screen. **3D view** and **Flat view** use `aria-pressed`; when 3D is blocked its button stays focusable with `aria-disabled` and the reason as its description. All animation respects `prefers-reduced-motion`, and the final pose always stays visible.

## As built

- `three@0.186.1` (MIT). The viewers, three.js, `RoomEnvironment` and the models build into one lazy chunk (about 151 kB gzip); the main window's initial JS is unchanged.
- Models are authored in millimetres and scaled so the display is 2.2 units tall. Static parts merge per material: a handset is at most a dozen draw calls and under 25k vertices.
- A WebGL failure (creation, render, context loss) or an undecodable Duo display feed switches to the flat screen with one toast and disables **3D view** until that simulator's viewer is reopened.
- `capture()` on each viewer returns a PNG of the framed device; the screenshot menu offers it as **Save framed screenshot…** while the 3D view shows, saved through the same dialog as other screenshots.
- Android foldables feed `useAndroidFold`'s hinge angle into the 3D fold body. The floating player stays flat, and a floating device's tab is a placeholder, so nothing streams twice.
- Tests (all in `test:devices`): `device-3d.test.ts`, `device-motion.test.ts`, `hardware-models.test.ts`, `duo.test.ts`, `phone-viewer.test.ts`, `duo-viewer.test.ts`, `android-fold-scene.test.ts`, `device-duo-control.test.ts`, `device-duo-stream.test.ts`, `trackpad-scroll-end.test.ts`, and the Duo control rendering in `device-tools-panel.test.tsx`.

## Exit

Open an iPhone 17 Pro, an iPad Pro 13-inch and an iPhone Duo. Turn each with a drag and a trackpad swipe, flick one and watch it settle, pinch to zoom, tap through the 3D display, rotate to landscape, and toggle Flat view. On the Duo, pinch the hinge, press Closed, Book and Open, try the Laptop and Tent stands, turn the device over to the cover, and confirm the controls still work in Flat view. With Reduce Motion on, everything snaps instead of springing.
