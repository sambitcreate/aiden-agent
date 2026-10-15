# Devices: post-merge review fixes (2026-10-08)

Fixes on top of the six-way devices parity merge (`611d3edc`). Each is its own commit with a behavioral test.

## Contracts and invariants
- **Device ids**: phones and the fixture parser use the desktop's `DEVICE_ID_PATTERN` (`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`; a stopped AVD is `Pixel_9_API_35`). Both phone decoders *skip* a device they cannot use (bad id, missing field, repeat) instead of failing the listing; chat ids not listed are dropped. The `mobileSimulators` fixture lists a stopped AVD. `MOBILE_HUB_HTTP_PATH` in `aiden-remote-simulators.ts` still only admits `[A-Za-z0-9-]` (fine: phones stream iOS only).
- **Grants** (`device-stream.ts`): `DeviceStreamTarget.grants` (the viewer passes its `createDeviceGrantSource`) supplies fresh grants to iPhone Duo display feeds and to the resumed primary video after Duo 3D closes. A refused feed renews itself once; a second refusal calls `onDuoUnavailable`, never the parent's `onUnauthorized`.
- **Close 1006** renews the grant only within `DEVICE_STREAM_GRANT_EXPIRY_MARGIN_MS` (5 s) of `expiresAt`; otherwise normal retry. 1008/4401 always renew. `DeviceStreamRuntime.now` is injectable.
- **Floating player** passes `device.platform` and the key detail; Android header shows Back/Home/Recents (no Rotate).
- **Event log** SSE is gated on the viewer's `active` (passed through `DeviceFeatureSections`).
- **Fold**: the 12 s timeout races the whole write (grant mint included); `dispose()` aborts an in-flight write.
- **Mobile retry budgets** refill after 5 s of a healthy connection (iOS `AidenSimulatorRetryBudget`, Android `firstFrameAt` + `STABLE_SOCKET_MILLIS`); a connection that drops straight away still gives up after one retry.
- **iOS**: touches go through `AidenSimulatorTouchTracker` on the model (one end per begin; `@GestureState` reset, `.inactive` scene and `deactivate()` lift a held finger). Decoded frames reach the main thread through `AidenLatestFrameSlot` (one hop outstanding).
- **Android**: `StreamLifecycle` pauses streaming on dispose (the view model is activity-scoped). Frames decode via `AidenSimulatorFrameDecoder` (bounds first, power-of-two `inSampleSize` never below the aspect-fit draw size, `inBitmap` pool). `AidenFrameReusePolicy` reuses a bitmap only after the UI reports (`frameShown`) a frame two newer.

## Not changed
- Inactive Duo panel feeds and the 15 s read timeout: serve-sim's native capture logs "60Hz IOSurface poll + 5fps idle floor", so panel feeds keep producing frames; no change made.
