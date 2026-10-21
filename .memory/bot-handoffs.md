# Bot hand-offs (desktop core) — 2026-10-20

Plan: `docs/plans/bot-handoffs-rules-computers-plan.md` §4.1 (package P1: the hand-off core and the desktop). Branch `wp/p1-handoffs`. Rules (P3), Remote and phones (P4), and sign-in and the Bot browser or computer (P5–P9) build on this.

## Shape
- Shared contract: `renderer/shared/bot-handoffs.ts`.
  - Tool names: `hand_off` (this package) and `sign_in` (a later package).
  - Limits: action 160, why 400, note 4,000, URL 2,048.
  - `BotPendingHandoff` already carries `kind: "sign_in"`, `origin`, `target`, `source: "rule"` and `rule`, so later packages add no shape changes.
  - `normalizeBotHandoffAction` collapses whitespace and drops a trailing full stop, so result texts never read "code..". Rules must pass their action through it and keep it within 160 characters, because `botHandoffResultOf` is strict.
  - `isBotHandoffOpenUrl` allows https only, with a host, no user name or password, no surrounding whitespace.
- Bridge: `main/services/bot-runtime/bot-handoffs.ts`, a copy of `bot-questions.ts` plus `get(botId, waitId)` and `onSettled`. The instance is `botHandoffs` in `bot-handoffs-main.ts`.
  - First valid answer wins.
  - An invalid answer keeps the card open.
  - A request with the same waitId withdraws the stale card.
  - Abort rejects with `signal.reason`.
  - Listener throws are swallowed.
- Tool: `bot-handoff-tool.ts`.
  - Memo `aiden.handoff` gives the durable `waitId`, so a quit or SIGKILL followed by Resume re-asks under the same id.
  - `executionMode: "sequential"` shows one card at a time; also `replay: "safe"` and `interactive`.
  - `execute` re-validates its parameters and returns an error result for a bad link.
  - Result texts live in `bot-handoff-text.ts`; P3 and P7 reuse them.
  - Details are `{kind, outcome, action, note?}`.
- Policy: `hand_off` is in `UNATTENDED_WITHHELD`. It is never offered to `routine:`, `tg:` or `intro:` runs, nor to a run that one of those joined. `botToolVerdict` refuses it with "Hand-offs are off for this Bot.". It needs no approval.

## Desktop
- Live projection:
  - `snapshot.handoff` is optional, so old fixtures still compile.
  - `handoff` events go through the feed queue, and `subscribe` catches up.
  - `refreshHandoff` is wired from `botHandoffs.onChange` in `bot-session-main.ts`.
  - A waiting card makes the phase "waiting" and `summary().needsYou` true.
  - `bot-attention.ts` broadcasts `bots:attention` for "Needs you" in the sidebar.
- Transcript:
  - A successful `hand_off` or `sign_in` result with valid details becomes `handoff_result` (id `handoff:<toolCallId>`). Error results (stopped, refused) stay tool results.
  - Rows show "You did this: …", "You skipped this: …" or "You signed in to <host>", with the note below, on the person's side.
  - A `handoff_result` starts a turn; the Activity log titles that turn "Hand-off".
  - The `hand_off` step's phase is "waiting", so it is never a recap step. Its label is "Handed you a step", via `botToolStepLabel`.
- IPC (`main/handlers/bot-handoffs.ts`, strict parsers in `bot-params.ts`):
  - `bots:answerHandoff({botId, waitId, outcome, note?})` returns `{answered}` and throws "That answer doesn’t match the card." on an invalid answer.
  - `bots:openHandoff({botId, waitId})` returns `{opened}`. It requires `rendererDocumentOwner`, and the handler is generic over the event type.
  - The pure open table is in `bot-handoff-open.ts`:
    - From the Mac: a link opens in the Bot's browser (P6's `botBrowser` opener, only for a Bot with the Browser capability), held for the person until the card settles, else in the system browser.
    - From a phone: the Bot's chat comes forward.
    - A sign-in opens only in the Bot's own browser or computer, never the system browser.
- Chat (`bot-chat-pane.tsx`, `renderer/components/bots/handoff-card.tsx`):
  - The card sits above the composer in the approvals container.
  - Buttons, in order: Open (only with a link, labelled "Open <host>"), Skip, Done. All are disabled while an answer is in flight.
  - While a card waits, the composer's placeholder is "Add a note and send to mark it done". Sending answers Done with the trimmed text as the note.
  - The Composer gets `isGenerating={running && !handoff}`, so it shows a plain Send. In queue mode the shared Composer toasts "Follow-up queued…", which would be wrong here. Stop then sits in a row under the composer, as it does under a question card.
  - A failed or refused note throws, so the Composer keeps the draft and toasts the message once. Attachments are refused with "Send photos after you answer the card." or "Send files after you answer the card.".
- Mac notification (`bot-handoff-notifications.ts`, wired in `bot-session-main.ts`):
  - Posted only when no Aiden window is focused. The title is the Bot's name; the body is "Ada needs you to: …", one line of at most 120 characters.
  - Each waitId is announced at most once; the id is claimed before any await, and the set is capped at 256.
  - `watchBotHandoffs(botHandoffs, notifier)` is the production wiring: on each change it offers that Bot's waiting cards to the notifier. Its test uses the real bridge.
  - A click opens `/bots/<id>/chat` through `requestAppPath`, which restores and focuses the main window.
  - It uses Electron `Notification`, so it also posts on Linux.

## Rule hand-offs (P3)
- Bot rules (`bot-rules.md`) hand a ruled tool call to the person through the same bridge: `ruleHandoffRequest` builds a `kind: "action"`, `source: "rule"` request with the rule, and `beforeTool` blocks the call with `ruleHandoffDoneBlock` or `handoffSkippedText`. The answer is recorded as an `aiden.handoff-result` session entry, which live projection maps to the same `handoff_result` row (`handoff:<toolCallId>`).

## Not yet
- Remote and phones: P4 (host side, `.memory/remote-rev37-bot-handoffs.md`) maps `handoff_result` to the person's message for every device and adds the revision-36 answer and open-on-Mac routes; phone UI is P5.
- CLI: hand-offs are desktop-only. The CLI bundles `renderer/shared/bot-activity.ts`, which is why it names the `hand_off` literal instead of importing the constant.
- Tests: `npm run test:bot-handoffs` (8 files), plus extensions in `live-projection` (including catch-up on subscribe with no refresh wired, and the list preview), `bot-attention`, `bot-chat-pane` (including a pasted photo refused while a card waits), `bot-transcript-rows`, `bot-activity-log`, `bot-params`, `bot-activity(-detail)` and `tests/e2e/bots-starter.spec.ts`.
- Bot chat tests can paste an image by setting `window.aidenAPI.attachments.readClipboardImages` after `mountChat` (the Bot test IPC fake has no attachments bridge) and firing `paste` with `clipboardData.items`.
