# Simulator device power features (devices parity, sibling E): 2026-10-08

This is the iOS work for T3-parity device features in the Simulator tab. Every contract carries a `platform` discriminator, so Android (sibling A) can add adb variants.

## What shipped
- **Erase.** `eraseDevice` in `main/services/devices/device-actions.ts` shuts down a booted simulator, then runs `simctl erase`. A failed shutdown never erases. A shutdown that lost the race ("current state: Shutdown") still erases. In the UI, the drawer's Device section shows a destructive AlertDialog that names the device, then a Dialog offering **Boot** (`devices:open` plus a stream reconnect) or **Close simulator**. There is no agent erase tool, and the guidance text is unchanged.
- **Clipboard.**
  - Paste: `simctl pbcopy` with the text on stdin, then the renderer sends MetaLeft+KeyV through HID (`renderer/lib/device-clipboard.ts`). Cmd+V on the focused screen is caught by a native keydown listener in `device-multitouch-layer.tsx`.
  - Copy: `simctl pbpaste` to the Electron clipboard.
  - Text only, capped at 64 KB of UTF-8 (`checkDeviceClipboardText`).
  - Main reads the host clipboard, so the renderer needs no clipboard-read permission.
- **Recording.** `device-recording.ts` supervises `simctl io <udid> recordVideo --codec=h264 --force <tmp>`.
  - Stop: SIGINT, then SIGKILL after 15 s, which marks the recording failed.
  - Cap: 10 min.
  - Cleanup: on chat delete (`closeDeviceSessionsForChat`), app quit (`shutdownDevices`), and when the simulator is no longer booted or listed. `device-features.ts` watches `service.onState` for the last case.
  - Saving: a save dialog in Downloads. Cancelling deletes the file. The toast offers Reveal in Finder, which works only for paths saved this launch.
  - Recordings are not attached to chat, because the composer has no video attachment support.
- **Screenshots.** The rail has a joined split control: `.squircle-control.squircle-action-group` with a Radix menu. "Save screenshot…" uses `devices:screenshot-save` and the save dialog.
  - The agent's `device_screenshot` takes an optional `saveTo`, validated by `device-save-path.ts`:
    - It must be inside the workspace or Downloads.
    - It is checked lexically and again through realpath of the deepest existing ancestor before any mkdir.
    - The file is opened with `O_NOFOLLOW`.
    - The path is checked before the capture.
  - `deviceToolRequiresApproval` makes `saveTo` ask under "ask" permission. `llm-client.ts` now calls this function instead of using `DEVICE_APPROVAL_TOOL_NAMES`.
- **Accessibility overlay** (ported from T3 `deviceHubApi.ts`).
  - `renderer/lib/device-ax.ts` flattens the tree and maps frames into the displayed stream. It applies the UI→raw rotation only when the stream is portrait-shaped while the device is rotated. A portrait tree for a landscape device is mapped the other way.
  - Hover hit-testing picks the smallest element.
  - The tree is polled every 2 s for this Mac only. A paired Mac gets one read per refresh.
  - The overlay forces the flat view (`frame3d && !axOverlay`).
- **Event log.** `renderer/lib/device-event-log.ts` reads SSE through fetch. The buffer is bounded at 500 entries and de-duplicated by id, and a clear stays sticky. The panel subscribes only while the section is expanded, and supports filter, pause (keeps buffering), clear, and copy.
- **Multi-touch.** serve-sim's helper message **0x05** `{type,x1,y1,x2,y2}` exists. The evidence is in `vendor/serve-sim/dist/middleware.js` `handleHidMessage` `case 5` → `hid.multiTouch`. The stream client has `sendMultiTouch`.
  - `renderer/lib/device-multitouch.ts`: Option = mirrored pinch/rotate, Option+Shift = pan, ctrl+wheel = trackpad pinch (ends after 150 ms idle).
  - The flat-view layer uses native listeners plus `stopPropagation` so React's single-touch handlers do not fire.

## Grants
Proxy grants last 60 s. The overlay and the event log use `createDeviceGrantSource` (`renderer/lib/device-grant.ts`) to mint fresh grants over IPC. The existing foreground feed still reuses the stream's grant, which may be stale if the drawer opens more than a minute after the stream starts. That is a pre-existing issue and was not changed.

## Files
- Main: `device-actions.ts` (appended section), `device-recording.ts`, `device-features.ts`, `device-feature-ipc.ts`, `device-save-path.ts`, `DeviceService.localTarget`, and wiring in `main/handlers/devices.ts`.
- Renderer: `renderer/shared/device-features.ts`, the libs listed above, and these components: `device-ax-overlay`, `device-event-log-panel`, `device-erase-control`, `device-clipboard-controls`, `device-record-control`, `device-screenshot-control`, `device-multitouch-layer`, `device-feature-sections`.
- The viewer and drawer were changed only by small mounts. `DeviceToolsPanel` now accepts `children`, and `ToolsSection` and `Row` are exported.
- Tests: the unit suites are registered in `test:devices`. The e2e spec is `tests/e2e/environment-devices-features.spec.ts`; the fake hub now serves `/ax` and the event-log SSE.

## Open questions
- Whether a HID Cmd+V pastes on iOS while the hardware keyboard is reported disconnected has not been verified on a real simulator. If it does not, the simctl pasteboard is still set, and long-press → Paste works.
- Trackpad rotation is not exposed by Chromium. Only pinch is passed through.
