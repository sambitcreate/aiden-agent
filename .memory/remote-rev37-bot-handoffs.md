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
- No `/server` feature token, because the 32-token budget is full. The router lists it in `serverCapabilities` (Bot-aware devices only) while `botHandoffsWired`: `supportsHandoffs` plus `answerHandoff`, `openHandoffOnMac`, `pause` and `unpause`.
- `supportsHandoffs` on the session service = `handoffs` bridge and `openHandoffOnMac` both wired. The desktop wires `botHandoffs` and `openBotHandoffById(botId, waitId, "phone")`. The CLI wires neither, so a CLI host never offers it.
- Negotiating it on an unwired host is `404 not_found`.

## Per-device view (`aiden-remote-bot-handoffs.ts`, pure)
- `LEGACY_AUDIENCE = {handoffs: false}`.
- `stateViewForAudience`: `paused` becomes `{unavailable, interrupted: false}` for legacy devices.
- `projectBotSummaryForAudience` / `projectBotDetailForAudience`:
  - holders: a summary keeps `paused` only as `true`; a detail always carries a Boolean;
  - legacy devices: the flag is dropped and `sessionState: paused` becomes `unavailable`.
- `toRemoteBotHandoff`: parse-validated. A link that fails `isBotHandoffOpenUrl` is dropped, and a blank `why` too.
- `legacyHandoffNotice`: an assistant message `handoff-notice:<waitId>`, "<Name> needs you on your Mac: <action>", with no `createdAt`.
- The host stores the holder view everywhere:
  - `AidenRemoteBotService.sessionStates` (service-main) and `projectAidenRemoteBotSummary`, which adds `paused: true`;
  - the projector's `state`;
  - idempotency ledger results.
  It is projected per device at the edge: the router for `/bots`, detail routes and from-preset; the host feed with `LEGACY_AUDIENCE`, so desktops always get revision-35 rows; and the session service after the ledger returns.

## Session service (`aiden-remote-bot-session.ts`)
- `Audience.handoffs`. The broadcast cache key is `cards:activity:handoffs`.
- The projector reads `handoffOf(botId)`: the first pending card, plus the Bot's name for the notice. A card the wire can't carry stays on the Mac.
- The constructor refreshes projectors on `questions`, `approvals` and `handoffs` `onChange`, and on the new `stateChanges` option (service-main: `onBotSessionStateChange` from `bot-session-main.ts`, imported lazily; `close()` unsubscribes). A pause or unpause on the Mac commits nothing to the conversation, so without it an open phone stream never saw it until its next refresh. Covered by "a pause and unpause made on the Mac reach open phone streams at once…".
- A `handoff` frame (payload `{handoff}`, deliberately wrapped) is published after `approval` when the waitId changes. At that seq:
  - a legacy device gets an `entry` frame carrying the notice when the card opens;
  - it gets a no-op `state` frame when the card settles.
- A legacy device's snapshot appends the notice as its newest entry. A holder's snapshot always has the `handoff` key.
- `handoff_result` entries project for every device as a user message. The id is `entry_handoff:<toolCallId>`, or `entry_handoff_<sha256/32>` when the wire grammar refuses the call id. The text is `botHandoffResultLine` plus `\n\n<note>`.
- `mapSessionError(error, audience)`: `paused_by_person` is `bot_paused` 409 for holders and `operation_stale` 409 otherwise. Refusals made from state record nothing in the ledger.
- Routes:
  - `answerHandoff`: ledger route `POST /bots/{id}/handoffs/{waitId}/answer`. A card no longer waiting is `handoff_expired`. `done` on `sign_in` is a 400.
  - `openHandoffOnMac`: returns `{waitId, opened: result !== "none"}`.
  - `pause(…, "phone")` / `unpause`: go through `control()`, with `CONTROL_ROUTES` (unpause = `DELETE /bots/{id}/pause`).
  - All of them 404 when unwired.

## Router
- Route labels `botHandoffAnswer`, `botHandoffOpenOnMac` and `botPause`. They use separate single-line matchers, because the matcher-scan test cannot cover alternation.
- Each needs `bot:write` (authenticate), then `requireBotHandoffs`: 404 if unwired, else `bot:read` + `bot:handoffs`.
- Each needs an Idempotency-Key. `DELETE /pause` reads no body.
- session, events, send, resume, dismiss, stop and the question answer pass `handoffs: holdsBotHandoffs(device, deps)`.

## Fixture and OpenAPI
- `contract.json` `botHandoffs`: a holder and a `legacy` view of one hand-off ("Scout", waitId `4f9c2d1e-…`), its answer, open-on-Mac, pause and unpause, the paused session, summary and detail, and the refusals.
- The desktop parser checks the legacy view never carries a revision-36 word. The section is refused below revision 37.
- `pausedDetail.instructions` is allowed by the privacy walk. P5 added `botHandoffs` to the iOS and Android fixture roots with the same exception (`AidenRemoteContract.swift`, `AidenRemoteProtocol.kt` `isAllowedKnownIdentityKey`).
- OpenAPI: 3 paths after the question answer; schemas `BotHandoff`, `BotHandoffAnswerRequest`, `BotHandoffAnswerReceipt` and `BotHandoffOpenOnMacReceipt`. `BotDetail` also gained the `sessionState` it was missing.
- BotSession's `allOf` + closed `BotSessionState` can't be validated by plain Ajv, so the Ajv test checks the hand-off on its own.

## Not done here
- `routines_skipped` is sent to no device.
- A legacy phone keeps the notice line in its local list until its next snapshot.
- Remote has no Bot-routine run route. The generic schedules API already 404s Bot routines.
