# Aiden On The Go

Aiden On The Go is the native SwiftUI companion for Aiden Agent on macOS and Linux. The paired desktop owns execution, persistence, providers, workspaces, and permissions; iPhone and iPad provide an authenticated remote control surface over a local network or Tailscale.

Public new-chat links require confirmation of their installation and workspace and never start dictation. iOS App Intents use a one-shot foreground action inside the app process, so the intentional voice shortcut remains available. Existing-chat widget and notification links only navigate. Unsent composer drafts and unresolved-send records remain protected device-only storage and are excluded from backups, including stores opened from older versions; backup restore does not migrate them.

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
