# Aiden On The Go

Aiden On The Go is the native SwiftUI companion for Aiden Agent on macOS and Linux. The paired desktop owns execution, persistence, providers, workspaces, and permissions; iPhone and iPad provide an authenticated remote control surface over a local network or Tailscale.

If the selected computer is unavailable, choose **Switch connection** in the recovery panel to select another paired computer or pair another Aiden Agent. This remains available when a secure-identity failure prevents retrying.

Public new-chat links wait through connection readiness, then require confirmation of their installation and workspace and never start dictation. iOS App Intents use a one-shot foreground action inside the app process, so the intentional voice shortcut remains available. Existing-chat widget and notification links only navigate. Unsent composer drafts and unresolved-send records remain protected device-only storage and are excluded from backups, including stores from older versions during app startup without opening a chat; backup restore does not migrate them.

On a host that negotiates Remote revision 54's `bot:messaging`, the Bots list offers **Bots can message each other**. Advanced → **Other Bots** controls whether each Bot receives and sends messages. Turning messaging off globally disables both per-Bot switches with **Turned off for all Bots**. Older hosts show no messaging controls. Saves apply optimistically and reconcile against the desktop after a lost response; failures restore authoritative values and show an error.

Bot messages use the existing labelled transcript rows, including a saved answer returned while the sender was paused. A `message` notification opens the Bot's chat without starting or resuming a turn, and displays only the host's bounded, redacted preview.

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

Hosts that announce Remote revision 55's `bot:access-requests` are asked for that capability in a separate foreground connection negotiation. Bot chats then show bounded access cards with only the host's offered **Not now**, **Always for this folder**, and **Allow once** actions. Whole-Mac cards offer no persistent grant. Retrying the same choice after an uncertain response keeps its idempotency key and body. Choosing a different answer sends that choice with a different key. An expired card stays dismissed; other failures restore it unless a newer feed update has replaced it. Access-needed issue cards offer **Not now** to dismiss them and may offer **Allow this folder** for a persistable folder. A successful answer with `savedForFuture: true` shows "Folder approval recorded." This acknowledges the exact committed approval operation, even when replayed after the folder was removed. It does not confirm current saved access, restore the old card, or grant access to an ended task. Older hosts keep their existing behavior.

Hosts that offer Remote revision 56's `bot:plans` are asked for it in a separate capability call. Bot chats show the host's plan with its reason, ordered steps and coverage. **Approve plan**, **Not now**, **Show details**, and an active plan's **Stop plan** use the same wording as desktop. Active checklists show step states, remaining minutes and usage counts; ended plans show compact progress. Long reviews scroll with decisions kept outside the review area. Visible pending plans hold Send while the draft stays editable. File coverage names the enforced location, read/change mode and any plan-only lifetime. Show details retains the exact location. If the location cannot fit safely, the phone omits that pending card and keeps the waiting signal; review and approve on the host desktop. Send remains available in that fallback, and a delayed phone approval is refused before granting access. Active plans retain Stop with a safe folder summary. A receipt acknowledges the answer; the host's session or event stream changes or clears the card. A `409 plan_expired` clears only the matching unchanged card. Unknown-outcome retries reuse the same plan-and-decision key and body; another decision gets its own key and body. Late answers cannot replace a newer card. Older hosts show no plan card or controls.

For focused plan regression tests from the repository root, use an explicitly selected simulator and a new result path for each run:

```sh
DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer xcodebuild test \
  -project ios/AidenOnTheGo.xcodeproj -scheme AidenOnTheGo \
  -destination 'platform=iOS Simulator,id=2FBB28DB-0E20-495C-B964-5A678C417E89' \
  -derivedDataPath /tmp/aiden-bot-messaging-ios-derived \
  -resultBundlePath "/tmp/aiden-bot-plan-$(date +%s).xcresult" \
  -disableAutomaticPackageResolution -onlyUsePackageVersionsFromResolvedFile \
  -collect-test-diagnostics never \
  -only-testing:AidenOnTheGoTests/AidenBotPlanTests \
  CODE_SIGNING_ALLOWED=NO
```

Use an installed Xcode and simulator destination appropriate to your machine. Simulator XCTest with signing disabled verifies compilation and behavior, not physical-device, Keychain, entitlement, or release acceptance.
