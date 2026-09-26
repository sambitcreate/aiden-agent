# Simulator Devices Phase 3: Live Stream and User Controls

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the Simulator tab's setup shell into a working viewer. It walks the user through consent and install, lists iOS simulators, and streams one into the Environment panel with touch, keyboard, hardware buttons, rotation, appearance, and screenshot-to-chat.

**Architecture:** The renderer gets a framework-free stream client (`renderer/lib/device-stream.ts`, ported from T3 `packages/client-runtime/src/device/stream.ts`, iOS only). It talks to main's token proxy with a short-lived grant: `grant.origin` plus `?t=<token>&host=<hostId>`. Video comes from the AVCC body through WebCodecs onto a canvas, with MJPEG `<img>` as the fallback. Input goes over the per-device binary WebSocket. Device settings never go through the hub. Main runs typed `simctl` actions (`device-actions.ts`, ported from T3 `apps/server/src/device/DeviceActions.ts`, iOS subset) behind new `devices:*` IPC channels.

**Parent plan:** [simulator-devices-plan.md](simulator-devices-plan.md), Phase 3. Its Global Constraints apply to every task here.

## Global Constraints

- Network: the tab contacts nothing until the user presses **Set up simulator streaming**. The consent copy names both npm and `node-datachannel`'s prebuilt-binary download.
- The renderer reaches the hub only through main's proxy and a grant. Grants are minted only while the tab is `active`. A 401/403 response, or a WebSocket close of 1008 or 4401, mints a fresh grant once and reconnects.
- A hidden or inactive tab stops the client. That stops the decoder, the sockets, and the MJPEG `<img>`.
- Leaving a chat keeps its session. Removing a chat (`chats:remove`) closes that chat's sessions. Simulators keep running unless the user asks for **Shut down**.
- UI: use the shared `Button` and `Text`, semantic tokens only, no decorative colored borders, and keep `focus-visible` rings. Every icon-only control has an `aria-label`. Respect Reduce Motion.
- Ported files carry `Adapted from t3code <path> @ 1c127066 (MIT)`.

## Scope decisions

- **Trackpad deferred to Phase 6.** T3 `phoneTrackpad.ts` only maps wheel and pinch gestures to *orbit/zoom of the 3D model* (`phoneWheelNavigation`). A flat stream has nothing to orbit, so the port lands with the 3D frames in Phase 6. The flat viewer uses pointer events for touch.
- **Actions subset (iOS):** `setAppearance`, `setTextSize`, `setIncreaseContrast`, `openUrl`, `setPermission` (the `simctl privacy` TCC services only; notifications need serve-sim's CLI, which is Phase 4+), `setLocation`, and `clearLocation`. Each action is one `xcrun simctl` exec with an argv array and no shell. Accessibility toggles through `serve-sim-ax-settings` are deferred.
- **Screenshot to chat** uses main's existing `service.screenshot()`, which posts directly to the hub. The PNG reaches the renderer over IPC, and the composer ingests it through its existing clipboard-image path (`attachments.readClipboardImages`), so attachment limits and model support checks still apply.

## File map

| Path | Responsibility |
| --- | --- |
| `renderer/lib/device-stream.ts` | AVCC demuxer, WebCodecs decoder, MJPEG fallback, input socket, HID map |
| `renderer/lib/device-stream.test.ts` | Ported `stream.test.ts` and `streamFrames.test.ts` iOS cases (injected fake clock, fetch, and sockets) |
| `main/services/devices/device-actions.ts` | Typed `simctl` actions and a settings read |
| `main/services/devices/device-actions.test.ts` | argv per action, the unsupported inputs, parsing the settings read |
| `renderer/shared/devices.ts` | `DeviceActionInput`, `DeviceSettings`, `parseDeviceActionInput`, `parseDeviceSettings` |
| `main/services/devices/device-service.ts` | `action()`, `settings()`, `closeChat()` |
| `main/services/devices/device-ipc.ts` | `devices:action`, `devices:settings`, `devices:screenshot` |
| `main/handlers/chats.ts` | `chats:remove` closes that chat's device sessions |
| `renderer/lib/composer-attach.ts` | Per-chat registry that hands image files to the one composer that can accept them |
| `renderer/lib/composer-attach.test.ts` | Delivery needs exactly one available receiver |
| `renderer/components/devices-panel.tsx` | Setup → device list → viewer state machine |
| `renderer/components/device-viewer.tsx` | Canvas/img viewer, pointer and keyboard input, controls rail |
| `renderer/components/devices-panel.test.tsx` | A render test per `DeviceHostStatus`, the list, and the viewer shell |
| `tests/e2e/environment-devices-stream.spec.ts` | Real proxy and viewer against a fake hub: frame paint, input message, reconnect, screenshot to chat, and `Origin` |
| `tests/e2e/device-hub-fake.mjs` | Fake `expo-device-hub` the spec seeds as the installed entry |

## Task 1: Stream client (`renderer/lib/device-stream.ts`)

**Produces:**

```ts
export type DeviceStreamStatus = "connecting" | "streaming" | "error";
export type DeviceOrientation = "portrait" | "portrait_upside_down" | "landscape_left" | "landscape_right";
export interface DeviceScreenSize { width: number; height: number; orientation: DeviceOrientation }
export interface DeviceStreamEvents {
  onStatus(status: DeviceStreamStatus, detail?: string): void;
  onScreen(screen: DeviceScreenSize): void;
  onUnauthorized(): void;
  onMjpegFallback(url: string): void;
  onInputConnected(connected: boolean, detail?: string): void;
}
export interface DeviceStreamTarget { hostId: string; deviceId: string; grant: DeviceStreamGrant; preferMjpeg?: boolean }
export interface DeviceStreamRuntime { fetch; WebSocket; VideoDecoder?; EncodedVideoChunk?; createImageBitmap?; setTimeout; clearTimeout }
export class AvccDemuxer { push(bytes: Uint8Array): AvccChunk[]; reset(): void }
export function avcCodecString(bytes: Uint8Array): string;
export function hidUsageForCode(code: string): number | null;
export function deviceHubUrl(target, path: string, protocol: "http" | "ws"): string;
export function createDeviceStreamClient(target, output: HTMLCanvasElement | DeviceFrameSink, events, runtime?): DeviceStreamClient;
```

- [x] Port the iOS path of `stream.ts`. Drop the Duo, panel, and Android code. URLs are `deviceHubUrl(target, "/vendor/serve-sim/helper/<udid>/stream.avcc", "http")` and `…/helper/<udid>/ws` over `ws`.
- [x] Inject `DeviceStreamRuntime` (defaulting to the globals) so the tests control time without `vi.useFakeTimers`.
- [x] Tests: AVCC reassembly across reads; codec strings; the MJPEG URL carrying `t` and `host`; the input message tags for orientation, button, and touch; late closes from discarded sockets; stopped clients not reconnecting; the prime timeout; raw-point remapping; waiting for MJPEG dimensions; an image error; the first-frame timeout; the unsupported-profile fallback; a stale 401; a delayed JPEG seed; a stalled AVCC body; borrowed decoded frames.

## Task 2: Device actions (main)

- [x] `renderer/shared/devices.ts` gains the fail-closed parsers for `DeviceActionInput` (a discriminated union on `type`, a UDID-shaped `deviceId`, `http(s)` or custom-scheme URLs only, and a reverse-DNS `appId`) and for `DeviceSettings`.
- [x] `device-actions.ts`: `iosActionArgv(input): string[]`, `runDeviceAction(ready, input)`, and `readDeviceSettings(ready, udid)` (`ui appearance`, `ui content_size`, and `ui increase_contrast` in parallel; failures degrade to unknown).
- [x] The service adds `action(input)` (which runs the action and then returns fresh settings), `settings({hostId, deviceId})`, and `closeChat(chatId)`.
- [x] The IPC adds `devices:action`, `devices:settings`, and `devices:screenshot`, each returning PNG bytes as a `Uint8Array`. Register them in `devicesApi`, and add them to the contract test.
- [x] `chats:remove` calls `closeDeviceSessionsForChat(chatId)` when the flag is on.

## Task 3: Simulator tab UI

- [x] `DevicesPanel` gains a `chatId` and becomes a state machine: `disabled` / `needs-consent` → a consent card; `installing` / `starting` → progress with the detail text; `unavailable` / `error` → the reason plus **Try again**; `stopped` → **Start**; `ready` → the device list, or the viewer when this chat has an open session.
- [x] The device list shows booted devices first, with an iPhone or iPad glyph, the name and version, and an **Open** button (labelled **Boot & open** when the device is shut down). It needs an active chat.
- [x] `DeviceViewer`: the canvas, or an `<img>` after an MJPEG fallback, at the device aspect ratio. Pointer down/move/up become normalized touches. Key events go to the device while the viewer is focused. A controls rail offers Home, Lock, Rotate, Appearance (light/dark), Screenshot to chat, and Close. The status line reads Connecting, Streaming, or Reconnect.
- [x] Composer: registers with `composerImageAttach` (a per-chat registry, not a window event) and feeds files through `readClipboardImages`.

## Task 4: E2E and registration

- [x] E2E with a fake device hub. Set `AIDEN_EXPERIMENTAL_DEVICES=1`. As built, no `AIDEN_E2E_DEVICE_FAKE` switch is needed: the spec seeds consent and an "installed" hub entry that runs `tests/e2e/device-hub-fake.mjs`, and puts a fake `xcrun` on PATH. Assert the MJPEG frame paints (`naturalWidth > 0`), that a click sends a `0x03` touch packet, and that dropping the socket reconnects. Record the `Origin` header the renderer sends.
- [x] Register the new tests in `test:devices` and the CI registry, then run type-check, lint, `test:ci-policy`, and `type-check:e2e`.
- [x] Update the parent plan's status, `.memory/simulator-devices.md`, and the papercuts.
