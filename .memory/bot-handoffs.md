# Bot hand-offs (desktop core) — 2026-10-20

Plan: `docs/plans/bot-handoffs-rules-computers-plan.md` §4.1 (package P1: the hand-off core and the desktop). Branch `wp/p1-handoffs`. Rules (P3), Remote and phones (P4), and sign-in and the Bot browser or computer (P5–P9) build on this.

## Shape
- Shared contract: `renderer/shared/bot-handoffs.ts`.
  - Tool names: `hand_off` (this package) and `sign_in` (a later package).
  - Limits: action 160, why 400, note 4,000, URL 2,048.
  - `BotPendingHandoff` already carries `kind: "sign_in"`, `origin`, `target`, `source: "rule"` and `rule`, so later packages add no shape changes.
  - `normalizeBotHandoffAction` collapses whitespace and drops a trailing full stop, so result texts never read "code..". Rules must pass their action through it and keep it within 160 characters, because `botHandoffResultOf` is strict.
  - `isBotHandoffOpenUrl` allows https only, with a host, no user name or password, no surrounding whitespace.
  - `withoutBotHandoffControls` (used by `normalizeBotHandoffAction` and every surface's `why`) drops C0/C1 controls but whitespace, bidi embeds/overrides/isolates and marks, and characters that draw nothing (soft hyphen, zero-width space, word joiner, invisible operators, BOM, U+180E, deprecated format characters, interlinear annotation marks), and turns U+2028/U+2029 into `\n`. ZWJ and ZWNJ stay (emoji, Persian). 2026-10-21, H1.
  - `botHandoffTakesNote(handoff)`: false only for a card the `locked.credentials` rule opened. The bridge answers such a note `invalid` (IPC throws "That answer doesn’t match the card.", Remote `400 invalid_request`), and the desktop composer is off while it waits (`handoffNoNoteComposerText`). A sign-in keeps its Skip note (the Remote API documents it). Other action cards say "<Bot> reads any note you send. Enter passwords, codes and card numbers on the page, never in the chat." (a money rule's card takes a note, such as a payment reference, so it names card numbers too)
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
  - Some providers reuse a tool-call id in every turn. Live projection keys a call by `<n>:<toolCallId>` (`callKey`, `n` = how many assistant messages issued that id so far), so each turn's answer is its own row: the first keeps `handoff:<toolCallId>`, a repeat is `handoff:<toolCallId>:<entry id>`. `recordRuleHandoffEntry` likewise only counts rows after the latest assistant message that issued the call, so a second turn's rule answer is written. 2026-10-21, H1.
  - Rows show "You did this: …", "You skipped this: …" or "You signed in to <host>", with the note below, on the person's side.
  - A `handoff_result` starts a turn; the Activity log titles that turn "Hand-off".
  - The `hand_off` step's phase is "waiting", so it is never a recap step. Its label is "Handed you a step", via `botToolStepLabel`.
- IPC (`main/handlers/bot-handoffs.ts`, strict parsers in `bot-params.ts`):
  - `bots:answerHandoff({botId, waitId, outcome, note?})` returns `{answered}` and throws "That answer doesn’t match the card." on an invalid answer.
  - `use-bot-handoff-actions.ts` counts answers and Opens in flight, and `busy` holds while any is; a single boolean let a finished Open re-enable Done while a note's answer was still on its way, which then read "already answered". 2026-10-21, H1. The count is module state keyed by Bot and card (`waitId`, the hook's second argument), so the chat's card and the floating panel's copy (`bot-panel-handoff.tsx`) share it: a note sent from the composer keeps the panel's Done waiting too, and a call that never ends can't hold the next card's buttons (H1 review).
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
- A locked rule's card never quotes typed text: `lockedRuleSummary` in `bot-tool-assembly.ts` turns `computer_use` `type`/`set_value` and `computer` `type`/`key` summaries into "type into the “<label>” field" (or "the focused field"), and a `computer_use` key into "press keys". The card's `why` and the Done the Bot reads use it. Approvals are never locked-class (a locked rule always hands off), the Bot browser's approval already hides typed text, and MCP summaries are the tool name only.

## Not yet
- Paired desktops and phones don't receive `rule` on the wire (revision 37), so they can't tell a password-or-code card; a note they send with its answer is `400 invalid_request` and the card keeps waiting. Showing it needs a wire field in a later revision.
- Remote and phones: P4 (host side, `.memory/remote-rev37-bot-handoffs.md`) maps `handoff_result` to the person's message for every device and adds the revision-36 answer and open-on-Mac routes; the phone and paired-desktop UI is P5 (`.memory/bot-handoffs-clients.md`).
- CLI: hand-offs are desktop-only. The CLI bundles `renderer/shared/bot-activity.ts`, which is why it names the `hand_off` literal instead of importing the constant.
- Tests: `npm run test:bot-handoffs` (8 files), plus extensions in `live-projection` (including catch-up on subscribe with no refresh wired, and the list preview), `bot-attention`, `bot-chat-pane` (including a pasted photo refused while a card waits), `bot-transcript-rows`, `bot-activity-log`, `bot-params`, `bot-activity(-detail)` and `tests/e2e/bots-starter.spec.ts`.
- Bot chat tests can paste an image by setting `window.aidenAPI.attachments.readClipboardImages` after `mountChat` (the Bot test IPC fake has no attachments bridge) and firing `paste` with `clipboardData.items`.
- Sign-in (P7): the `sign_in` tool, its desktop card and the Bot-browser holds are in `.memory/bot-browser.md` ("Sign-in"). Rule hand-offs of Bot browser calls now carry `open` (the page the Bot was on). Card text is stripped of control and bidi marks (`withoutBotHandoffControls`).
