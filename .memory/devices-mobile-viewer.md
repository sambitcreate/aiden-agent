# Devices: Aiden On The Go simulator viewer (sibling F, 2026-10-08)

Phones (iOS and Android Aiden On The Go) can watch and control a simulator on the paired Mac. Ported from T3 Code `apps/mobile/src/features/devices` (MIT), but native: no WebView, so the pinned TLS applies to every byte.

## Contract (Aiden Remote revision 25)
- Capability `simulators:mobile` (`AIDEN_REMOTE_MOBILE_SIMULATOR_CAPABILITIES`), phone-only (`iphone`/`ipad`), negotiated post-pairing via `POST /device/capabilities` while `/server.features` lists `mobile-simulators-v1`. Never issued by pairing; stripped from persisted desktop records (`mayHoldMobileSimulatorCapabilities`). Desktops are refused it (403); phones are still refused `simulators:control`.
- `/simulators*` authenticates with either grant (`SIMULATOR_ROUTE_CAPABILITIES`, any-of `authenticateCredential`). The audience comes from the device type (`simulatorAudience`). OpenAPI marks those routes with `x-aiden-any-capability`.
- Phone scope (enforced in `aiden-remote-simulators.ts`): list, open (iOS only), shutdown; hub GET `helper/{udid}/stream.mjpeg|config|health`; WS `helper/ws?device=`. Settings, actions, screenshot, AVCC, ax, event log, device list (+ socket) → `403 capability_denied` with `MOBILE_SIMULATOR_REFUSAL`.
- `GET /simulators?chatId=` (only accepted query): router checks `chat:read` + `requireChatAccess`, relay passes `{chatId}` to `host.list`; the listing adds `chatDeviceIds` and never starts the hub. Phones also get `toolVersions`.
- Fixture `mobileSimulators` (listing incl. an `android` device, input vectors, screen-config vectors, MJPEG samples with and without Content-Length, refusal). `renderer/lib/device-stream-mobile-fixture.test.ts` runs every vector through the real desktop encoder, so the fixture cannot drift from the Simulator tab.

## Consent
- New `DeviceConsent.mobileSharing` ("Share with Aiden On The Go", Settings → Simulator, default off, needs streaming). Optional in the type (absent = off) to keep sibling fixtures compiling; the parser always emits a boolean.
- `device-service.ts` builds one share host per audience (`shareHost(audience = "desktop")`); each has its own sharing predicate and listeners. The relay subscribes per audience and `closeAudience` closes only that audience's live relays.

## Android emulators
Listed on phones with "Open on your Mac to view". No native H.264 (VideoToolbox/MediaCodec) path yet; `open` refuses non-iOS for the phone audience.

## Display orientation
`AidenSimulatorDisplayRotation` (iOS contract, Android `AidenSimulatorStream.kt`) is the one predicate for both drawing and the touch remap: rotate only when the screen config is portrait-sized (`width <= height`) and reports landscape/upside down. The viewers draw the raw frame turned (iOS `rotationEffect`, Android `drawBehind` + `rotate`), aspect-fit the turned size, and normalize taps against that rect before `rawPoint`/`mapTouch`. Android also subsamples against the turned size. The desktop Simulator tab (`device-viewer.tsx`) does not turn the canvas yet; T3's `DeviceStreamView.tsx` does.

## Mobile clients
See the iOS and Android sections in `docs/devices.md` ("Aiden On The Go viewer").
