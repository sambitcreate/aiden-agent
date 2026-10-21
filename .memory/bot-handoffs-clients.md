# Remote revision 37 (`bot:handoffs`) on the clients: desktop peers, iOS, Android (P5), 2026-10-21

Plan: `docs/plans/bot-handoffs-rules-computers-plan.md`, package P5. Branch `wp/p5-clients`. Host side: P4 (`.memory/remote-rev37-bot-handoffs.md`). Core: P1 (`.memory/bot-handoffs.md`) and P2 (`.memory/bot-pause.md`). The clients mirror P4's wire shapes exactly; the shared fixture section is `botHandoffs` in `protocol/aiden-remote/v1/fixtures/contract.json`.

## The same rules on every client
- **Negotiation.** Ask for `bot:handoffs` only when the host lists it in `serverCapabilities`, and only in a `POST /device/capabilities {accepts: ["bot:handoffs"]}` call of its own, after the other grants. A 400 or 404 means only that the host can't grant it: keep the pairing as it was, with no error. A 401 or `credential_revoked` still ends the pairing. Store the grant only once the refreshed `/server` lists it.
- **Decoding (holders).**
  - The session `handoff` is `{waitId ^[A-Za-z0-9-]{1,64}$, kind action|sign_in, action ≤160 non-blank, why? ≤400, open?: {url}}` or null.
  - `open.url` must be https, have a host, carry no user name, have no surrounding whitespace, and be at most 2,048 characters.
  - There is a `handoff` frame `{handoff}`, a `paused` state, and `bot_paused` and `handoff_expired` codes.
  - Summary `paused` arrives only as true; detail `paused` is a Boolean. A flag that disagrees with a `paused` sessionState is refused.
  - Every client decodes a missing flag as false and never writes false back, so a legacy Bot round-trips unchanged. (On Android this is `@EncodeDefault(NEVER)`; without it `AidenBotRevision25ContractTest`'s round trips fail.)
- **Legacy devices** see `unavailable` instead of paused and a `handoff-notice:<waitId>` assistant message without createdAt. A write to a paused Bot gets `operation_stale`. `handoff_result` reaches every device as a user message.
- **Card** ("Your turn: <action>"), next to the question and approval cards:
  - **Action:** Open (only for a URL the rule accepts), Skip and Done.
  - **Sign-in:** Finish on your Mac (`open-on-mac`, then "Finish signing in on your Mac." or "Open Aiden on your Mac to finish signing in.") and Skip. It never sends Done (that is a 400).
  - The composer becomes the note field: Send = Done with the note. A note is trimmed, non-blank and at most 4,000 characters; a longer one is refused locally and never sent.
  - The card is claimed optimistically. `handoff_expired` keeps it gone ("That card was already answered or closed."). Any other failure restores it, unless the feed changed the hand-off meanwhile, and shows "That answer wasn't sent. Please try again."
  - Idempotency key per `answerHandoff:<waitId>`, kept across a lost answer.
- **Pause.**
  - `POST /bots/{id}/pause {}` and a body-less `DELETE /bots/{id}/pause` both return `{state, interrupted}`. Each needs an Idempotency-Key, kept while the outcome is unknown.
  - Offered only when the host holds-and-lists `bot:handoffs`, the device may write Bots, and the Bot has a durable session.
  - A paused chat shows "<Name> is paused." with Resume and holds the composer ("<Name> is paused"). There is no optimistic state: the Mac's answer, or the feed, settles it.
- **Copy (G2).** Interrupted row: "Interrupted — tap to resume". Person-paused row: "Paused".

## Desktop (paired-Mac peer client), commit 674c4aa3
- `main/services/peer-host-registry.ts`:
  - `NEGOTIATED_GRANTS` has the row `["bot:handoffs", durable-session feature, "own_call"]`.
  - `own_call` grants go in a separate `requestGrants` call after the batch, and their 400/404 is swallowed.
  - `hostServesBotHandoffs(view)` is in `renderer/lib/hosts/remote-bot-session.ts`.
- `main/services/peer-operation.ts` and `renderer/shared/peer-operation.ts` add the peer operations `botAnswerHandoff`, `botHandoffOpenOnMac`, `botPause` and `botUnpause` (DELETE, no body), validated with the P4 receipt parsers.
- `renderer/lib/hosts/remote-bot-session.ts` keeps `handoff` and `paused` in the session view (`remoteBotSessionPaused`) and applies `handoff` frames.
- UI:
  - `remote-bot-chat-view.tsx` shows the shared hand-off card (`handoff-card.tsx`, new `finishOn` prop, "Finish on <Mac>") and `BotPausedNotice` (`renderer/main/bots/bot-paused-card.tsx`).
  - The chat's ••• menu has Pause Bot / Resume Bot.
  - A settled card is hidden by the identity of the host's handoff object, not its wait id. Resume asks again under the same wait id, and the frame or snapshot carrying it is a new object, so the card shows again (adversarial review fix).
- The host feed sends paired desktops the revision-35 rows, so the desktop sidebar never shows a paired Bot as Paused or Interrupted (its rows show only "Working…" or the Bot's purpose). Only the open chat knows. Whether holders should get per-audience feed rows is an open owner question (hardening H2).
- Merge watch with #565:
  - `peer-bot-session-compat.ts` `SESSION_KEYS` must gain `handoff`.
  - The registry's catch must merge into `requestGrants`.

## iOS, commit 51822967
- Contract: `AidenRemoteContract.swift` (capability `botHandoffs`, also in the phone progress set, as the blueprint says; error codes).
- Client: `AidenRemoteClient.swift` adds `answerBotHandoff`, `openBotHandoffOnMac`, `pauseBot` and `unpauseBot`. A malformed waitId is refused (`invalidResponse`) before anything is sent.
- Coordinator: `negotiateBotHandoffsIfNeeded` runs after the progress batch.
- Models: `AidenBotSession.swift` (`AidenRemoteBotHandoff`, `AidenBotHandoffWire.isOpenURL`) and `AidenBot.swift` (`AidenBotWire.pausedFlag`).
- UI:
  - `AidenBotSessionModel.swift` holds `answerHandoff`, `finishHandoffOnMac`, `unpause`, and the `AidenBotSessionCopy` strings, including `interruptedSubtitle` and `pausedSubtitle`.
  - `Features/Bots/AidenBotHandoffCard.swift` holds the card and `AidenBotPausedCard`; it is in the pbxproj.
  - `AidenBotSessionChatView.swift` shows the card and the paused state.
  - The profile's More menu has Pause Bot / Resume Bot.
- Notifications (G24): `AidenScheduledRunNotifier.notifyBotHandoff` posts one alert per waitId when the app isn't active.
- `scripts/check-ios-shipping-target.test.mjs` allowlists the new Swift file.
- Tests: `AidenBotContractTests`, `AidenBotSessionTests`, `AidenRemoteClientTests`, `AidenChatTests` and `AidenBotHomeProfileTests` (fixture `botHandoffs` via `AidenRemoteContractFixture.swift`). They can only run on macOS CI or the owner's Mac.
- Completeness check (same day):
  - `AidenBotHandoffWire.isOpenURL` and the card's Open parse with `encodingInvalidCharacters: true` (iOS 17+). The Mac stores a page as its WHATWG `href`, which keeps `[`, `]`, `|` and `^` unescaped; plain `URLComponents(string:)` refuses those, and the phone would refuse the whole session.
  - The outbox's pre-send check uses `canSend`, so a paused Bot takes nothing (as on Android) and a cut-off request keeps its key.
  - Profile `setPaused` and `deleteBot` each carry one `@MainActor`.
  - The cache round trip of a paused summary encodes dates as ISO 8601, as `AidenBotCache` does.
  - `AidenBotSessionModel.pause()` (optimistic) had tests but no production caller: Pause is offered on the profile only, as on Android. The desktop chat's ••• menu also has it. Hardening H2 removed it.

## Android
- Protocol: `protocol/AidenRemoteProtocol.kt` has `BOT_HANDOFFS` (negotiable and phone-known; `PHONE_BOT_HANDOFFS`) and the `BOT_PAUSED` and `HANDOFF_EXPIRED` codes. `botHandoffs` is a fixture Bot root whose `pausedDetail.instructions` is allowed.
- Models:
  - `AidenBotSession.kt`: `AidenBotHandoffWire` (manual `isOpenUrl`, deliberately strict: no `@` in the authority, no control characters), `AidenBotHandoff` (exact-keys `parse` / `toJson`), the answer request and receipts, `AidenBotSession.handoff` (written only when non-null), and the `Handoff` event payload.
  - `AidenBot.kt`: the `PAUSED` state, `paused` flags and `aidenValidateBotPaused`.
- Client: `AidenRemoteClient.kt` adds `answerBotHandoff`, `openBotHandoffOnMac`, `pauseBot` and `unpauseBot` (DELETE). Each receipt's waitId must match.
- Coordinator: `features/remote/AidenRemoteCoordinator.kt` has the top-level `aidenShouldRequestBotHandoffs` / `aidenRequestBotHandoffs` (JVM-testable against MockWebServer) and the private `negotiateBotHandoffs`, which runs after `negotiateProgressCapabilities`.
- Controller: `features/bots/AidenBotSessionController.kt`.
  - `AidenBotComposerMode` is MESSAGE, HANDOFF_NOTE, HELD_FOR_SIGN_IN or PAUSED.
  - It provides `answerHandoff`, `finishHandoffOnMac`, `unpause` and `onHandoffArrived`, which fires once per new waitId.
  - Its copy (`INTERRUPTED_ROW`, `PAUSED_ROW`, and the hand-off errors) stays as English constants for the JVM tests. The Compose strings are in `strings.xml`.
- UI:
  - `AidenBotHandoffCard.kt` holds the card and `AidenBotPausedCard`.
  - `AidenBotSessionScreen.kt` shows the card, the paused card and the composer modes. Its G24 notification posts only while the lifecycle is below STARTED, through `AidenScheduledRunNotifier.postBotHandoff` (tag `aiden.bot-handoff.<instance>.<bot>.<waitId>`).
  - `AidenBotPause.kt` holds `aidenBotOffersPause`, `AidenBotPauseControl` and `withSessionState`.
  - In the profile ••• menu, Pause Bot / Resume Bot comes before Delete.
- Tests:
  - New: `AidenBotHandoffsContractTest`.
  - Extended: `AidenBotSessionControllerTest`, `AidenBotProfileBehaviorTest` and `AidenBotHomeBehaviorTest`.

## Hardening H2 (branch `wp/h2-remote-clients`)
- Desktop `remote-bot-chat-view.tsx`: `useBusyOperations()` counts busy work per operation, so one finishing (Pause) never clears another's (the card's answer). `answeringHandoff` (a ref of the wait id in flight) stops the composer sending a second answer. Questions and approvals are hidden by the identity of the settled object (as the hand-off card), so Resume asking the same wait id shows them again; a failed approval answer brings its card back.
- Desktop `peer-host-registry.ts` `requestGrants`: a `401` from `POST /device/capabilities` clears the host's verification and rethrows, so the offer counts as unanswered and the next connect asks again.
- iOS:
  - `aidenBotSessionFeedGrants(installation)` + `AidenBotSessionModel.reopenFeed()` (the chat view's `onChange` of the held grants): the feed is wrapped in a reopenable `AsyncThrowingStream`, and a reopen skips the backoff (mirrors Android's 25ec0fc8).
  - `answerHandoffFromComposer(_:connected:)`: Send-as-Done needs the connection (as the card's Done and Skip), and staged photos or files keep the draft with "Send photos/files after you answer the card." (the desktop's copy).
  - Hand-off alert: `aidenBotSessionDeepLinkPath(botID:hostFeatures:)` sends `.botChat` on a durable-session Mac to the Bots area with the durable chat pushed (`setCompactBotPath`). Android already routed it.
- Android: `aidenBotPausedChatOffersResume(canWriteBots, ui)` gates the paused card's Resume on `canWriteBots` and a connection. iOS's paused card already used `canAct: canWrite`. The desktop's `BotPausedNotice` is disabled only while its own pause or unpause is on its way: it stays enabled while the stream reconnects, because the call is a plain request (`docs/aiden-remote-api-v1.md` says so).
- The host normalises `open.url` (see `.memory/remote-rev37-bot-handoffs.md`), so Android's strict `isOpenUrl` and iOS's check accept every page the host sends; neither client changed for it.

## Validating Android without the SDK (container recipe)
- `dl.google.com` is blocked, so there is no Android SDK and no AGP. Maven Central (`repo.maven.apache.org`) returns 429 to Gradle. The Google mirror `https://maven-central.storage-download.googleapis.com/maven2/` works.
- Build a standalone Kotlin JVM Gradle project outside the repo (e.g. `/tmp/p5-clients/kcheck`) with Kotlin 2.3.20 and the serialization plugin, `kotlinx-serialization-json` 1.7.3, coroutines 1.10.2, okhttp and mockwebserver 4.12.0, and JUnit 4.
  - Source dirs: the app's `src/main/java` (`protocol/**`, `models/**`, `diagnostics/**`, `networking/**` without `AidenNetworkAvailability.kt`, and the pure `features/bots` files), plus stubs.
  - Stubs:
    - `Immutable`, `Color`, `StringRes`, `android.util.Log`, `androidx.core.util.AtomicFile`;
    - a Java `R.java` generated from `strings.xml` (a Kotlin `object R` breaks the reflection-based copy test);
    - `AidenThemePresetID`, `AidenActivityMarkKind`, the activity-presentation helpers and the coordinator's top-level helpers, sed-extracted verbatim from the real files.
  - Point the test resources at the fixtures, set `workingDir` to `android/app`, and set `jdk.net.hosts.file` to `src/test/jvm-hosts`.
- Result on 2026-10-21: 123 JVM tests ran. Only `anOutboxFileThatCantBeReadIsSetAsideAndTheChatSaysSo` failed, because the container runs as root and `setReadable(false)` has no effect. Compose screens, the notifier and lint still need CI.
