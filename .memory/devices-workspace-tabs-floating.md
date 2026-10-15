# Devices workspace UX: per-device tabs, floating player, docked Quick View — 2026-10-08

Sibling D of the T3 devices-parity push (base `4cb409d5`). Ported from T3 Code `ThreadPreviewMiniPlayer`/`previewMiniPlayerLayout` (8bbe2bf660), right-panel device surfaces (`rightPanelStore` `openDevice`/`renameDevice`/`dismissedDeviceSurfaceIds`), and 429c625a85 (workspace card beside chat). Attribution in THIRD_PARTY_NOTICES.md (T3 simulator devices section).

## Shape
- **Tabs are derived, not stored**: one strip entry per live `DeviceSession` of the active chat. `renderer/lib/device-tabs.ts` holds pure per-chat state `{order, titles, dismissed, active, picker}`; `visibleDeviceTabs(tabs, sessions, name)` hides dismissed keys. Key = `encodeURIComponent(hostId):encodeURIComponent(deviceId)`.
- `renderer/lib/device-workspace-store.ts`: window store (`useSyncExternalStore`). Tabs persist in localStorage `aiden-agent.devices.tabs-v1` (50 chats LRU); floating device per chat is memory-only; player geometry `aiden-agent.devices.mini-player-v1`; auto-float `aiden-agent.devices.auto-float` (default on, "0" = off). Storage errors are swallowed.
- The old single "Simulator" tab shape is gone (pre-1.0, no migration). Environment kind stays `"devices"`; its strip entries expand like browser pages (`device:<key>` ids, picker id `devices`). Launcher/picker label is now **Device**.
- Closing a tab (strip ×/Delete/context menu) = `closeDeviceTab` (dismiss) + `devicesApi.close({shutdown:false})`. Rail Close/Shut down only dismiss (DevicesPanel already closes). Dismissals are pruned once the session is gone; `openDeviceTab` (user open via picker → `onOpened`, or agent reveal) un-dismisses. Closing the last tab closes the kind; rail close leaves the picker.
- Only the selected tab mounts `DeviceViewer` (others unmounted → stream dropped). A floating device's tab renders `DeviceFloatingPlaceholder` instead, so one stream per device.
- `devices:reveal` payload is now `{chatId, hostId?, deviceId?}` (main `DeviceService.reveal(chatId, target?)`, device_open passes the session). Renderer `deviceRevealAction` → `float` (auto-float on + target), `tab` (showTools devices), or `ignore` (other chat).

## Floating player
- `renderer/components/device-mini-player.tsx` (lazy, portal to body, `fixed z-[48]` like the floating browser). Uses `use-device-stream.ts` (a flat-stream copy of DeviceViewer's grant/client/input logic — DeviceViewer was not refactored to avoid conflicts with sibling E; consider having DeviceViewer adopt the hook later) and `use-floating-container-bounds.ts` (extracted from BrowserFloatingFrame, which now uses it).
- Layout `renderer/lib/device-mini-player-layout.ts` reuses `browserFloatingFrame`/`resizeBrowserFloatingFrame` with a 36px header; snap is per-axis within 48px of an edge (corner when near two). Live drag frame is local state; geometry is committed (rounded) on release/keyboard. Header: Home, Rotate, Dock, Close; arrows/Shift move, +/− resize, Escape docks (the screen keeps Escape for the device).
- Host ends floating when the session disappears.

## Narrow windows
- `resolveChatCardInset` (environment-panel-layout.ts): Quick View docks beside the chat by setting `data-chat-card-inset`, `--chat-card-inset-end` and `--chat-card-max-width` (px; Full width → 100000px) on `[data-browser-floating-container]`; CSS shifts `.chat-content-column` (original rule untouched, composer.test greps it). Returns 0 (card floats over chat) below a 560px column. Metrics read from `--chat-content-max-width`/`--aiden-dock-gutter`, re-read on root style/data-chat-width changes.

## Timeline
- `safeToolDescriptor` labels: List/Open/Screenshot/Close (or Shut down) simulator — never the UDIDs. Renderer VERBS plus iOS `AidenChat.swift` and Android `AidenChat.kt` verb maps got the same four entries (native tests extended; not run locally, see final report).

## Tests
- `npm run test:devices` adds `device-tabs.test.ts`, `device-mini-player-layout.test.ts`, `device-mini-player.test.tsx`; `environment-panel-layout.test.ts` (test:serial) covers docking with a CSS-semantics oracle. The old source-grep reveal test in devices-panel.test.tsx was replaced by behavioral tests.
- e2e: `environment-devices-stream.spec.ts` (tab → rename → float/touch/snap/Escape → context-menu float → dock → close stays closed → reopen restores name), `-agent.spec.ts` (device_open floats, Dock to tab), `-tab.spec.ts` (Device label), `workspace-panel.spec.ts` (Quick View docking at 1400/1000).

## Left as-is
- Agent prompt/approval copy in `device-tools.ts`/`device-service.ts` still says "Simulator tab" (sibling A edits those files).
