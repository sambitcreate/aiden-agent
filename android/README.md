# Aiden On The Go for Android

The native Compose client connects to Aiden Agent over the Remote API. The host owns execution, persistence, permissions and model configuration.

Opening a chat already running on another device restores available reply text, reasoning and tool activity from a revision 58 host. The phone resumes live updates from the same point. Earlier hosts use their retained run events.

On hosts that negotiate `bot:messaging` in Remote contract revision 54, the Bots list offers **Bots can message each other**. Advanced → **Other Bots** has receive and send switches for each Bot. When global messaging is off, both switches are disabled with **Turned off for all Bots**. Older hosts show no messaging controls. Each change sends only its changed field; Bot identity patches carry the latest Bot revision. Optimistic saves reconcile lost responses by reading the host and roll back with an error when unsaved.

Bot messages use existing labelled transcript rows, including bounded saved answers while paused. A `message` notification opens that Bot's chat, preserves the host's redacted preview and never starts or resumes a turn.

See the [Remote API guide](../docs/aiden-remote-api-v1.md) and [shared contract fixtures](../protocol/aiden-remote/v1/fixtures/contract.json).

Run focused JVM tests from this directory with `./gradlew :app:testDebugUnitTest`. Simulator and JVM checks do not constitute physical-device or release acceptance.

Hosts that announce Remote revision 55's `bot:access-requests` are asked for that capability in a separate foreground connection negotiation. Bot chats then show bounded access cards with only the host's offered **Not now**, **Always for this folder**, and **Allow once** actions. Whole-Mac cards offer no persistent grant. Retrying the same choice after an uncertain response keeps its idempotency key and body. Choosing a different answer sends that choice with a different key. An expired card stays dismissed; other failures restore it unless a newer feed update has replaced it. Access-needed issue cards offer **Not now** to dismiss them and may offer **Allow this folder** for a persistable folder. A successful answer with `savedForFuture: true` shows "Folder approval recorded." This acknowledges the exact committed approval operation, even when replayed after the folder was removed. It does not confirm current saved access, restore the old card, or grant access to an ended task. Older hosts keep their existing behavior.

Hosts that offer Remote revision 56's `bot:plans` are asked for it in a separate capability call. Bot chats show the host's plan with its reason, ordered steps and coverage. **Approve plan**, **Not now**, **Show details**, and an active plan's **Stop plan** use the same wording as desktop. Active checklists show step states, remaining minutes and usage counts; ended plans show compact progress. Long reviews scroll with decisions kept outside the review area. Visible pending plans hold Send while the draft stays editable. File coverage names the enforced location, read/change mode and any plan-only lifetime. Show details retains the exact location. If the location cannot fit safely, the phone omits that pending card and keeps the waiting signal; review and approve on the host desktop. Send remains available in that fallback, and a delayed phone approval is refused before granting access. Active plans retain Stop with a safe folder summary. A receipt acknowledges the answer; the host's session or event stream changes or clears the card. A `409 plan_expired` clears only the matching unchanged card. Receiving an identical pending-plan snapshot during the answer keeps that refusal applicable; a changed plan or explicit response generation still fences the old response. Unknown-outcome retries reuse the same plan-and-decision key and body; another decision gets its own key and body. Late answers cannot replace a newer card. Older hosts show no plan card or controls.

Hosts offering Remote revision 57’s `bot:allowed` are asked for that capability alone. When it is held, Bot profiles show **Allowed without asking**, with a count from the complete paginated rule-and-folder list. Remove keeps the row disabled until the host returns a fresh list; failures retain the row and show an error. Stale or foreign cursors restart from the first page. Rule rows show usage; folder rows show only their added date. Host-offered approval counts enable **Always allow for <Bot>**. B folder counts require both `bot:access-requests` and `bot:allowed`. Unknown outcomes retain the exact wait, decision and scope key/body; another scope or decision uses another key. **Always allow requested.** acknowledges the choice, while the host confirms saved access. Earlier hosts retain their existing UI.

For focused allowed-list and existing Bot regressions, use the installed JDK/SDK and offline Gradle from `android/`:

```sh
JAVA_HOME='/Applications/Android Studio.app/Contents/jbr/Contents/Home' \
ANDROID_HOME=/Users/sambitbiswas/Library/Android/sdk \
./gradlew --offline :app:testDebugUnitTest \
  --tests '*AidenBotAllowedTest' --tests '*AidenRemoteClientTest' \
  --tests '*AidenRemoteCoordinatorClientTest' --tests '*AidenRemotePhase0Test' \
  --tests '*AidenBotPlan*' --tests '*AidenBotSessionControllerTest' \
  --tests '*AidenBotAccessRequestsContractTest'
```

`./gradlew --offline :app:lintDebug :app:compileDebugAndroidTestKotlin` checks lint and instrumented-test compilation without claiming an emulator UI run.

Bot notification polls retain the fetch's original negotiated visibility through system permission and notification posting. Losing Bot/chat read, messaging, issue, access-request or peer visibility keeps the cursor and delivered IDs unchanged until a fresh authorized poll; issue rows do not expose their private subtype. Host support alone never grants visibility. Older hosts without a separate support inventory retain the existing Bot/chat read baseline for routine notifications only. A system banner already accepted before access changed cannot be withdrawn by this notifier.

Git review uses the host’s commit capability. Commit stays disabled when the host refuses the review, and the phone shows the host’s reason, including when a changed file could not be shown. A missing capability also keeps Commit disabled. A permitted review still needs visible changes and a snapshot; Android also waits for a fresh review before enabling Commit.
