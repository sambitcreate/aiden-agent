# Aiden On The Go

Aiden On The Go is the native SwiftUI companion for Aiden Agent on macOS. The Mac owns execution, persistence, providers, workspaces, and permissions; iPhone and iPad provide an authenticated remote control surface over a local network or Tailscale.

iPhone and iPad stay **Internal TestFlight-only**. App Store GA is not part of the October 2026 macOS 1.0 and Android public window.

The product and protocol sources of truth are:

- [`PROJECT_SPEC.md`](PROJECT_SPEC.md)
- [`../docs/plans/aiden-on-the-go-plan.md`](../docs/plans/aiden-on-the-go-plan.md)
- [`../docs/aiden-remote-api-v1.md`](../docs/aiden-remote-api-v1.md)
- [`../protocol/aiden-remote/v1/openapi.json`](../protocol/aiden-remote/v1/openapi.json)

Open `AidenOnTheGo.xcodeproj` and use the `AidenOnTheGo` scheme. Hardware verification is performed with terminal-based `xcodebuild` and `xcrun` commands against an explicitly selected physical device.

To verify ActivityKit persistence and authenticated reconciliation across two real app-host processes without reinstalling the app between phases, run:

```sh
npm run ios:activitykit-process-proof -- \
  --xcode-device-id <physical-xcode-udid> \
  --core-device-id <physical-coredevice-uuid>
```

The command rejects simulated or mismatched destinations, builds once, starts a uniquely identified Live Activity, confirms the first test host has exited, relaunches the installed destination artifacts, reconciles through `AidenRemoteClient`, ends the activity, and moves its temporary result bundles to Trash. Its cleanup phase is best-effort even when a proof phase fails.

Aiden On The Go is MIT-licensed under [`LICENSE`](LICENSE). The original Hermex MIT notice is retained under `AidenOnTheGo/Resources/ThirdPartyNotices/` for adapted implementation pieces; no Hermes WebUI compatibility layer or product identity is shipped.
