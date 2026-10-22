# Remote contract revision 37: Bot hand-offs and pause on phones (P4) — 2026-10-20

Plan: `docs/plans/bot-handoffs-rules-computers-plan.md`, package P4 (host side). Branch `wp/p4-remote`. Phones (iOS, Android) and the paired-desktop client are P5 (`.memory/bot-handoffs-clients.md`). Builds on P1 (`.memory/bot-handoffs.md`) and P2 (`.memory/bot-pause.md`).

## Revision number
- Provisional. PR #564 also claims 36. The number lives in one place per platform:
  - desktop: `AIDEN_REMOTE_BOT_HANDOFFS_CONTRACT_REVISION` in `main/services/aiden-remote-protocol.ts`, which `AIDEN_REMOTE_CONTRACT_REVISION` aliases;
  - the shared fixture: two `contractRevision` literals in `protocol/aiden-remote/v1/fixtures/contract.json` (top level and `hostHealth`).
- Desktop tests compare against the constant, never a literal, so renumbering is: the constant, the 2 fixture literals, and the "36" in `docs/aiden-remote-api-v1.md` and the OpenAPI descriptions.
  - Review dry run (2026-10-21): with the constant and both fixture literals set to 37, every desktop Remote suite passed (`test:aiden-remote` minus the IPv6-bound service test, plus `test:peer-hosts`). That needed one fix: the protocol test's "require contract revision 37" regex now builds from the constant.
  - PR #564 merged first and took 36 on `main`, so the integrator renumbers this work to 37 when merging `main`.
- iOS `AidenRemotePhase0Tests.swift` asserts the fixture revision literally (37 now); a renumber must change it too.

## Negotiation
- Capability `bot:handoffs` (`AIDEN_REMOTE_BOT_HANDOFF_CAPABILITIES`): an opt-in with no authority. It is last in the opt-in, negotiable and capability lists. Pairing never issues it; any device type may negotiate it.
- No `/server` feature token: shipped clients refuse more than 32, and since main's 004d2f9b a fully wired host already gives phones 30 (desktops 28). The router lists it in `serverCapabilities` (Bot-aware devices only) while `botHandoffsWired`: `supportsHandoffs` plus `answerHandoff`, `openHandoffOnMac`, `pause` and `unpause`.
- `supportsHandoffs` on the session service = `handoffs` bridge and `openHandoffOnMac` both wired. The desktop wires `botHandoffs` and `openBotHandoffById(botId, waitId, "phone")`. The CLI wires neither, so a CLI host never offers it.
- Negotiating it on an unwired host is `404 not_found`.

## Per-device view (`aiden-remote-bot-handoffs.ts`, pure)
- `LEGACY_AUDIENCE = {handoffs: false}`.
- `stateViewForAudience`: `paused` becomes `{unavailable, interrupted: false}` for legacy devices.
- `projectBotSummaryForAudience` / `projectBotDetailForAudience`:
  - holders: a summary keeps `paused` only as `true`; a detail always carries a Boolean;
  - legacy devices: the flag is dropped and `sessionState: paused` becomes `unavailable`.
- `toRemoteBotHandoff`: parse-validated. A link that fails `isBotHandoffOpenUrl` is dropped, and a blank `why` too.
  - `cardPage(url)` (hardening H2): `open.url` goes out as the WHATWG parser prints it (`new URL(url).href`), so Android's strict `isOpenUrl` and iOS's `URLComponents` check, which refuse forms the Mac's parser accepts (`https:host`, an empty `@`, a tab in the host, a backslash, uppercase, `:443`, a Unicode host), never refuse the whole snapshot. A bare origin keeps its form (no trailing `/` added); a printed form that fails the check (too long) drops `open`.
- `legacyHandoffNotice`: an assistant message `handoff-notice:<waitId>`, "<Name> needs you on your Mac: <action>", with no `createdAt`.
- The host stores the holder view everywhere:
  - `AidenRemoteBotService.sessionStates` (service-main) and `projectAidenRemoteBotSummary`, which adds `paused: true`;
  - the projector's `state`;
  - idempotency ledger results.
  It is projected per device at the edge: the router for `/bots`, detail routes and from-preset; the host feed per audience (owner answer 3a, 2026-10-22): the source sends `bots` (legacy) and `handoffBots` (holder), journal entries carry `audience` (`all`/`legacy`/`handoffs`), a change both read alike is one entry, and the router passes `botHandoffs: holdsBotHandoffs(device)` to `open`; and the session service after the ledger returns.

## Session service (`aiden-remote-bot-session.ts`)
- `Audience.handoffs`. The broadcast cache key is `cards:activity:handoffs`.
- The projector reads `handoffOf(botId)`: the first pending card, plus the Bot's name for the notice. A card the wire can't carry stays on the Mac.
- The constructor refreshes projectors on `questions`, `approvals` and `handoffs` `onChange`, and on the new `stateChanges` option (service-main: `onBotSessionStateChange` from `bot-session-main.ts`, imported lazily; `close()` unsubscribes). A pause or unpause on the Mac commits nothing to the conversation, so without it an open phone stream never saw it until its next refresh. Covered by "a pause and unpause made on the Mac reach open phone streams at once…".
- A `handoff` frame (payload `{handoff}`, deliberately wrapped) is published after `approval` when the waitId changes. At that seq:
  - a legacy device gets an `entry` frame carrying the notice when a card opens with none shown before it;
  - once a notice is shown, a card that settles (answer, withdrawal) or gives way to another (`pending(botId)[0]` changes) reaches it as a `snapshot` frame of its own audience at that seq (`publish` passes `"snapshot"` to `frame()` whenever `this.handoff` was non-null). Review fix 2026-10-21: it used to be a no-op `state` frame, and shipped clients (iOS, Android, desktop on main) have no frame that removes an entry, so the stale "needs you on your Mac" line stayed until a refetch. All three already apply a mid-stream `snapshot` as a full replace (the history-rewrite path), so no client change was needed. Covered by "a device without bot:handoffs drops a hand-off's line once it is answered, withdrawn or replaced…", which folds the real legacy frames through the desktop reducer and compares with a fresh read.
- A legacy device's snapshot appends the notice as its newest entry. A holder's snapshot always has the `handoff` key.
- `handoff_result` entries project for every device as a user message. The id is `entry_handoff:<toolCallId>`, or `entry_handoff_<sha256/32>` when the wire grammar refuses the call id. The text is `botHandoffResultLine` plus `\n\n<note>`.
- `mapSessionError(error, audience)`: `paused_by_person` is `bot_paused` 409 for holders and `operation_stale` 409 otherwise. Refusals made from state record nothing in the ledger.
- Routes:
  - `answerHandoff`: ledger route `POST /bots/{id}/handoffs/{waitId}/answer`. A card no longer waiting is `handoff_expired`. `done` on `sign_in` is a 400.
  - `openHandoffOnMac`: returns `{waitId, opened: result !== "none"}`.
  - `pause(…, "phone")` / `unpause`: go through `control()`, with `CONTROL_ROUTES` (unpause = `DELETE /bots/{id}/pause`).
  - All of them 404 when unwired.
  - Refusals replay as refusals (hardening H2): `answerOrRefuseUnchanged` wraps the question, approval and hand-off answers so an `AidenRemoteServiceError` thrown inside the ledger becomes `AidenOperationNotExecutedError` (nothing recorded; the same key is checked again). Before, the ledger recorded it as `internal_error` and a retry got a 500. `openHandoffOnMac`'s expired check does the same.

## Router
- Route labels `botHandoffAnswer`, `botHandoffOpenOnMac` and `botPause`. They use separate single-line matchers, because the matcher-scan test cannot cover alternation.
- Each needs `bot:write` (authenticate), then `requireBotHandoffs`: 404 if unwired, else `bot:read` + `bot:handoffs`.
- Each needs an Idempotency-Key. `DELETE /pause` reads no body.
- session, events, send, resume, dismiss, stop and the question answer pass `handoffs: holdsBotHandoffs(device, deps)`.

## Fixture and OpenAPI
- `contract.json` `botHandoffs`: a holder and a `legacy` view of one hand-off ("Scout", waitId `4f9c2d1e-…`), its answer, open-on-Mac, pause and unpause, the paused session, summary and detail, and the refusals.
- The desktop parser checks the legacy view never carries a revision-37 word. The section is refused below revision 37.
- `pausedDetail.instructions` is allowed by the privacy walk. P5 added `botHandoffs` to the iOS and Android fixture roots with the same exception (`AidenRemoteContract.swift`, `AidenRemoteProtocol.kt` `isAllowedKnownIdentityKey`).
- OpenAPI: 3 paths after the question answer; schemas `BotHandoff`, `BotHandoffAnswerRequest`, `BotHandoffAnswerReceipt` and `BotHandoffOpenOnMacReceipt`. `BotDetail` also gained the `sessionState` it was missing.
- BotSession's `allOf` + closed `BotSessionState` can't be validated by plain Ajv, so the Ajv test checks the hand-off on its own.

## Not done here
- `routines_skipped` is sent to no device.
- A legacy phone keeps the notice line in its local list until its next snapshot.
- Remote has no Bot-routine run route. The generic schedules API already 404s Bot routines.
