# Pause a Bot (plan §7, package P2) — 2026-10-20

Plan: `docs/plans/bot-handoffs-rules-computers-plan.md` §7. Code names say *pause/unpause*; the button reads **Resume** because `resume` already means "continue an interrupted turn".

## Layout
- `main/services/bot-pause-store.ts`: `<root>/bot-pauses.json` (mode 0600, `{version: 1, bots: {<botId>: {since, by}}}`, strict parse: exact keys, `by` ∈ `mac|phone|cli`, non-negative safe-integer `since`). Desktop root `<userData>/bot-service`, CLI root `<agentDir>/bot-service`. Kept out of `BotDefinition` so pausing never bumps the identity revision. Pausing again keeps the first `since`/`by`. **Fail closed**: an unparseable or newer-shape file is kept byte-for-byte, reads throw `BotPauseStoreCorruptError`, writes are refused; each read re-checks the file, so fixing it takes effect without a restart. `forgetBot` returns quietly on an unreadable file so a delete always finishes.
- `harness-host.ts` `suspend(botId, timeoutMs = 5 s)`: the per-Bot forced close (inside `serialize`), raced against a timer → `closed | timed_out | not_open`. Never sets `deleted`. On timeout the close keeps running and is reported through `onReport`; a reopen waits for it.
- `bot-session-service.ts`:
  - State `{kind: "paused"; since; by; interrupted?: submissionId}` (checked after `deleted`, before the `isOpen` inspect). Error/skip reason `paused_by_person` ("This Bot is paused. Resume it to continue."); `bot_paused` still means *interrupted*.
  - `send` refuses after the dedupe lookup (a redelivered request id still dedupes); `resume`, `dismiss`, `compact` refuse. A corrupt pause file refuses too (fail closed), while `state()` reports and treats it as unpaused for display.
  - `pause(botId, by)` (serialized): write the pause → `onPaused` (memory review cancel) → if the Bot has live work, `suspend` then `inspect` (reopens paused; the turn reads as interrupted) → `afterPaused` → publish. A timed-out suspend publishes `paused` without `interrupted`, then reopens in the background (`suspending` set) and publishes again.
  - `unpause`: clear → publish → `onUnpaused(botId, record)` outside the queue.
  - `appendEntry(botId, kind, data)` = `conversation.commit(tx => tx.appendEntry(...))`: **never resumes the scheduler**. `markSilent` and routine-proposal status writes now use it (a `{type: "write"}` submit resumed a paused/interrupted Bot — latent bug).
  - Notice `routines_skipped {since, routines: [{routineId, name, count}]}` → transcript entry `routines_skipped` (owned by no turn, so `[SILENT]` never hides it).
- `bot-session-main.ts`: `botPauses`, `onPaused: memoryReview.cancel`, `afterPaused` runs `botPauseEffects`, `onUnpaused` restarts memory review and appends the skipped-routines notice when `countSkippedWhilePaused(...) > 0`. `deleteEffects` forgets the pause after `deleteRoutines`.
- IPC `main/handlers/bot-pause.ts`: `bots:pause(botId)` (always `by: "mac"`, refuses a Bot that does not exist) and `bots:unpause(botId)`, both return the state. `bots:routines:runNow {botId, routineId, expectedUpdatedAt?}` in `bot-routines.ts`.
- Routines: a paused Bot's fire is `skipped / paused_by_person`, `surface: false`, never caught up (catch-up trigger treats `paused` like `interrupted`). A run that a pause interrupts mid-turn is recorded as `paused_by_person` too. `countSkippedWhilePaused(store, botId, since)` counts skips with `startedAt >= since`.
- Telegram (`bot-reply-outbox.ts`): a message for a paused Bot gets one fixed line ("{Name} is paused. Resume it in Aiden to continue.") with no outbox row and no typing action; a reply cut short by a pause is delivered after unpause + Resume.
- Remote legacy projection (`aiden-remote-bot-session.ts`): shipped phones decode a closed state enum, so `paused` → `{state: "unavailable", interrupted: false}` everywhere (snapshot keeps its transcript), and send/resume/dismiss → `operation_stale` 409, which the idempotency ledger forgets so the same key runs after unpause. The `routines_skipped` entry is dropped on the wire (default branch). Only rev-36 `bot:handoffs` devices may see `paused`/`bot_paused` (P4).
- Renderer: Bot ••• menu (chat header, sidebar rows, pinned Bot) and Profile ••• menu: Pause Bot / Resume Bot (after Pin). `BotPausedCard` ("Ada is paused." + Resume, neutral tone) beside the interrupted card; composer `ready=false` with "Ada is paused.". Row labels (G2): interrupted = "Interrupted — tap to resume", paused = "Paused". `RoutinesSkippedCard` lists each routine with Run now (settles to "Started"). `useBotLiveSummary(botId)` shares the sidebar's summary cache.
- CLI (`packages/cli/src/bots.ts`, via the running `aiden serve`): `aiden bots pause <id>` → `{botId, paused: true, since}` (writes first, then cancels and waits for the Bot's live chats), `aiden bots unpause <id>` → `{botId, paused: false}`. `preflight` (phone Bot turns) throws `operation_stale` 409 "<Name> is paused."; `daemon-chats.ts` refuses a paused Bot turn (`chat:error`, no provider request). The CLI has no Bot delete path, so it never calls `forgetBot`.

## Verified behaviour
- `harness.close` signals and joins every task without writing; a running turn stays placed and reopens with `scheduling: "paused"`, i.e. interrupted. Questions, approvals and hand-off waits reject on that abort signal (cards withdrawn) and are re-asked under the same `waitId` after Resume.
- `conversation.commit(... appendEntry ...)` does not resume the paused scheduler; `submit` (including `{type: "write"}`), `compact`, `abort` and `waitForIdle` do.

## Seams for later packages
- Hand-offs (P1): withdrawn by the close like other waits; no code needed. Anything that keeps running on its own (P6/P8 Bot computer stop) goes into `botPauseEffects` in `bot-session-main.ts` (runs via `afterPaused`, after the turn is closed; failures are logged, never block the pause).
- Rev-36 Remote pause/unpause routes and the `paused` wire state are P4; iOS `pausedSubtitle` / Android `PAUSED_ROW` copy (G2) is P5.

## Tests
`npm run test:bot-pause` (store, runtime with a real harness + faux model, IPC handler, chat UI). The runtime and handler tests need `build/native/aiden-lease-flock` (runtime-subagents lane). Extended: `harness-host`, `scheduled-bot-routines`, `schedule-store`, Telegram outbox/core, `aiden-remote-bot-session`, sidebar/header/profile, CLI `parity.test.mjs`.

## Known limits
- A manual run-now of a Bot routine while paused (scheduled-tasks page, Remote schedules API) is recorded as a `paused_by_person` skip rather than refused, and then counts in the skipped notice.
- Run now state on the skipped card is per mount; reopening the chat offers Run now again.
