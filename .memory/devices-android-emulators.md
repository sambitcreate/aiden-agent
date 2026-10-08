# Android emulators and foldable controls: 2026-10-08

Branch `feature/devices-android-emulator`, implementer (A) of the six-way T3 device-parity split. It ports T3 Code's Android path at commit `a6ec88f7` (MIT). See `docs/devices.md`, section "Android Emulators", and `THIRD_PARTY_NOTICES.md`.

## Decisions

- `DevicePlatform = "ios" | "android"`. Android devices use `kind: "other"`, and the platform tells them apart. Physical Android phones are filtered out of the listing (deferred).
- The shared `DEVICE_ID_PATTERN` is `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`, so AVD names fit. The leading alphanumeric character means no id can be read as an adb or simctl flag. It is used by IPC, actions, the proxy, the relay, peer parsing, and the agent tool schema.
- iOS listing stays on `xcrun simctl`. Android uses the hub's `/api/devices` plus `emulator -list-avds`, as in T3. A failed Android listing marks Android unavailable with a reason and never fails iOS.
- The local host finds the SDK (`findAndroidSdk`, `androidUnavailableReason`) and puts `platform-tools` and `emulator` on PATH for the hub and `run`. The hub starts when either platform can run. A successful Xcode check is cached for the run.
- `DeviceHostInfo.platforms?` carries per-platform availability. It is optional so peers and older fixtures still parse.
- Android actions live in `android-device-actions.ts`, kept apart from `device-actions.ts` to limit conflicts with sibling E. Every argument after `adb shell` is quoted with `deviceShellQuote`, because adb joins the words for the device's `sh`. The test proves this by re-parsing the words with `/bin/sh`.
- `DeviceSettings.foregroundApp` (Android only) comes from `dumpsys window`, because serve-emu has no appstate SSE feed.
- Proxy: `DEVICE_HUB_MUTABLE_ROUTES` lists one allowed method per route. Device-scoped serve-emu routes need exactly one `?device=`, otherwise serve-emu would pick an unlisted device. `DeviceHubRoute.scope` is `read` or `operate`, so fold GET is read and fold POST is operate. Aiden has only one remote capability (`simulators:control`), so scope is informational for now.
- The relay rebuilds bodies itself: the iOS screenshot `{udid}`, the fold `{posture}`, and the serve-emu screenshot with no body. PUT and PATCH (stream tuning) are never relayed. OpenAPI `SimulatorDevice` now requires `platform`. The protocol revision was not bumped, because this route is desktop to desktop only. An older peer client that receives Android devices rejects the whole listing.
- Fold: `createAndroidFoldController` is framework-free and tested with a fake clock: retry after 3 s, timeout after 12 s, and a stale read dropped on a screen change. `useAndroidFold` mints a fresh grant for each request, because grants expire after 60 s. The viewer owns the hook, and `fold.angle` and `fold.fold.posture` are available there for the 3D frame (sibling B).
- The composer's type-to-focus redirect was taking keys from the focused device screen; this was a latent iOS bug too. Device surfaces now carry `data-typing-surface="device"`, which `isReservedTypingSurface` honours.

## Tests

- New: `main/services/devices/android-device-actions.test.ts` and `renderer/lib/device-fold.test.ts`, both registered in `test:devices`. Extended: service, host, proxy, relay, peer, IPC, tools, shared, stream (SEMU and keys), panel, and drawer suites.
- E2E: `tests/e2e/environment-devices-android.spec.ts`. The fake hub sends a real 128x256 baseline H.264 keyframe (no SEI) behind SEMU headers. The iOS specs pin `ANDROID_HOME` to an empty folder, so a developer's real SDK (this Mac has one) cannot add devices and break `device_open`'s platform choice.
