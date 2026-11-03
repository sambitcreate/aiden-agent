# Aiden On The Go

Aiden On The Go is the native SwiftUI companion for Aiden Agent on macOS and Linux. The paired desktop owns execution, persistence, providers, workspaces, and permissions; iPhone and iPad provide an authenticated remote control surface over a local network or Tailscale.

If the selected computer is unavailable, choose **Switch connection** in the recovery panel to select another paired computer or pair another Aiden Agent. This remains available when a secure-identity failure prevents retrying.

Public new-chat links wait through connection readiness, then require confirmation of their installation and workspace and never start dictation. iOS App Intents use a one-shot foreground action inside the app process, so the intentional voice shortcut remains available. Existing-chat widget and notification links only navigate. Unsent composer drafts and unresolved-send records remain protected device-only storage and are excluded from backups, including stores from older versions during app startup without opening a chat; backup restore does not migrate them.

On hosts that offer and grant `bot:watches`, open a Bot’s profile → **Watches** to discover sources, create or edit a watch, pause or resume it, test a check, delete it, or explicitly **Run now**. Sources use host-produced provider, account and resource labels; connector bindings and credentials stay on the host. Discovery happens only when you tap **Discover sources** or **Refresh sources**. The host reports unavailable templates and repair guidance; Calendar watches remain unavailable until the host can bind an exact account safely.

Watches execute on the paired host while Aiden is open and the host is awake. A test shows a bounded preview without advancing the watch baseline or running the Bot. Drafts and unresolved requests stay in this phone’s protected, backup-excluded private storage across editor close, disconnect and app restart; removing or replacing the pairing purges them. Stale saves retain the draft and require review of the latest host revision. An unknown write outcome freezes further changes until a host read confirms it or an explicit retry reuses the same request identity. Older hosts and pairings without `bot:watches` keep their existing profile.

In a Bot’s Advanced → Custom access, Composio has one service allow choice. Manage its enabled apps and tools in Composio; the Bot’s Aiden rules and a watch’s selected account still apply. An older partial Composio selection requires explicit review and replacement with the host’s current service choice. Other MCP connections keep their host-projected choices.

On hosts that offer and grant `bot:open-work` alongside Bot and chat read access, Profile → **Open work** manages unfinished responsibilities. Add a title and note, edit an item, record a waiting reason, mark it done, reopen or dismiss it, and use the host’s per-item **Undo last change** within 24 hours. Add records metadata only; it does not start a Bot run or schedule work. The host’s current source and result links open retained transcript text, with truncated excerpts labelled explicitly.

**Stop linked run** and **Stop and dismiss** appear only when the host can safely stop that item’s linked work. Mixed-input runs explain why Stop is unavailable. A requested or uncertain Stop stays unfinished until an acknowledgement arrives; Stop and dismiss waits for that acknowledgement before dismissing. Protected, backup-excluded drafts and exact pending requests survive disconnect and restart and are scoped to the host, paired device and Bot. Lost responses and typed `unavailable` outcomes keep their original UUID and payload, including after a later denied retry. Ordinary expired unknown requests are never issued under a fresh identity; pending Stop checks can keep using their protected original request beyond 24 hours. Pairing removal, revocation or replacement purges local Open work drafts and attempts. Older or ungranted hosts keep their existing profile.

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
