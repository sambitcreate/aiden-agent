# Simulator Devices Phase 6: 3D Device Frames

Status: done (2026-09-25). Parent plan: [simulator-devices-plan.md](simulator-devices-plan.md).

## Goal

Show the live simulator screen inside a turnable, procedural iPhone or iPad body in the Simulator tab, the way T3 Code's nightly does, without bundling any vendor device model or art.

## Scope

- iOS only. Two original procedural bodies, phone and tablet, built from three.js primitives. No GLB models, no Duo or fold scenes, no Android shells.
- The flat screen stays the source of truth. Frames always decode into the existing flat canvas; the 3D frame samples it as a `CanvasTexture`. The stream client, input socket and screenshot path are unchanged.
- A per-viewer preference (`localStorage`, key `aiden.devices.framePreference`) picks 3D or flat. It defaults to 3D.
- The flat screen is used whenever the 3D frame cannot work: the MJPEG compatibility stream, hinged (iPhone Duo) simulators, and missing or lost WebGL.

## Design

| File | Role |
| --- | --- |
| `renderer/lib/device-3d/shape-profile.ts` | Phone and tablet silhouettes; `resolveDeviceShape(kind, portraitAspect)`. |
| `renderer/lib/device-3d/phone-scene.ts` | Procedural body, display mesh, raw-framebuffer UVs, and touch projection (`createDisplayProjection`). |
| `renderer/lib/device-3d/motion.ts` | Aiden's own critically damped yaw/pitch spring. Release settles facing the viewer within ±60°; reduced motion jumps. |
| `renderer/lib/device-3d/interaction.ts` | Render scheduler (no frames while idle), wheel orbit, and one-pointer touch-or-orbit ownership. |
| `renderer/lib/device-3d/phone-viewer.ts` | `WebGLRenderer`, lights, camera fit, context loss. The only module that imports the renderer; loaded with `import()`. |
| `renderer/lib/device-3d/frame-mode.ts` | Preference storage and the flat-screen blockers with their labels. |
| `renderer/components/device-phone-viewport.tsx` | React shell: lazy load, resize, pointer and wheel input, blur ends a drag. |
| `renderer/components/device-viewer.tsx` | Mounts the 3D frame over the hidden flat screen, and adds the **3D frame** and **Reset 3D view** rail buttons. |

Input: a drag that starts on the display is a simulator touch; a drag elsewhere, or with Option held, turns the device. Two-finger trackpad swipes also turn it. Pinch is left alone. Touches land in the displayed frame in every orientation.

Accessibility: the 3D wrapper is a focusable `role="application"` region that forwards keys like the flat screen. The rail toggle uses `aria-pressed`; when blocked it is disabled and its title names the reason. All animation respects `prefers-reduced-motion`, and the final pose always stays visible.

## As built

- `three@0.186.1` (MIT) is a runtime dependency; `@types/three` is a dev dependency. Vite emits it in the lazy `phone-viewer` chunk (about 145 kB gzip), so the Simulator tab costs nothing until a 3D frame is shown.
- Framing is refitted every render from the posed body's bounds instead of T3's separate framing spring; motion is a new spring rather than T3's recovered one.
- A WebGL failure (creation, render, or context loss) switches to the flat screen with a toast and disables the toggle for the session.
- Tests: `renderer/lib/device-3d/device-3d.test.ts` (in `test:devices`) covers layout, UVs, touch projection per orientation, camera fit, motion, the scheduler, wheel orbit, interaction ownership, preference storage, blockers, and shape choice.

## Exit

Open an iPhone and an iPad simulator, turn each with a drag and a trackpad swipe, tap through the 3D display, rotate the simulator to landscape, and toggle back to flat. With Reduce Motion on, the device snaps instead of springing.
