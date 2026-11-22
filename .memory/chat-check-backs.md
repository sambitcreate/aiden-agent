# Chats that check back (Proactive Aiden C2) — 2026-11-22

Plan: `docs/plans/proactive-aiden-plan.md` Phase 1, C2. Guide: `docs/coding-follow-through.md#checking-back-later`.

## Layout
- `main/services/wake-up-time.ts`: shared time rules (`resolveWakeUpTime`, `localClockParts`, `WAKE_UP_TIME_LIMITS`, `WAKE_UP_INVALID_TIME_MESSAGE`). Bot `wake_up` (`bot-wake-ups/wake-ups.ts` `resolveBotWakeUpTime`) layers its once-cron DST check on top; check-backs use it directly (own timer, no cron).
- `renderer/shared/check-backs.ts`: tool name `check_back`, limits (1–1440 min, 3 per chat, 20 total, note ≤ 500, 2 h late window), `CheckBackView`, `checkBackWhen`/`checkBackClock`.
- `main/services/follow-through/check-backs.ts`: `CheckBacks` (pure, fake-timer testable). Records `{id, chatId, fireAt, note, setAt, setByTurnId, state: pending|claimed|fired|cancelled, endedAt}` in follow-through `state.json` under `checkBacks` (absent in older files). One timer for the soonest; `rearm()` on startup (`restore`), `resume`, `unlock-screen` (`main/index.ts`). Fire: save `claimed`, await `flush`, re-read `enabled()` (off → `cancelAll`), post via `noticeDelivery` (`source: "check_back"`, `wake: true`), then settle on the `AgentNoticeOutcome`: queued/woke/recorded → `fired`; `dropped` + `gone` → `cancelled`; other drops → back to `pending` with `attempts` + `retryAt` (now + 60 s; `dueAt = max(fireAt, retryAt)`), and the 3rd drop logs and leaves a record-only "Check-back not delivered (due …)" card (`fired`). `cancelAll` also cancels `claimed` records not yet handed to `post` (`posting` set). Late ≤ 2 h → late text; older or a `claimed` record at launch → record-only "Missed check-back (due …)" card (`wake: false`). Finished records pruned after a day. Sets serialised per chat; caps checked with no await between check and push.
- `check-back-tool.ts`: `set | list | cancel`; codes `invalid_time`, `invalid_note`, `too_many_pending`, `not_found`, `off`. Result `details.checkBack.fireAt` feeds the activity row ("Will check back at 3:10 PM" via `ACTION_VERBS` in `renderer/lib/agent-steps.ts`). The tool re-checks the turn refusal itself (defence in depth).
- Offered (`llm-client.ts`): not Bot/Assistant, has chatId and a workspace folder, `usageSource === "chat"`, not Telegram, `hostPlatformCapabilities().chatCheckBacks` (macOS, Linux). Declared every turn for cache stability, read-only workspaces included.

## Args-aware refusal (reused by later units)
- `chat-turn-tool-policy.ts`: `ChatTurnAudience.goalRound?`, `TURN_ARGS_REFUSAL_RULES` rows `{tool, turns, args, reason}`, `argIs(key, ...values)`, `aidenStartedTurn(turn)` (unattended || windowless || goalRound), `chatTurnArgsToolRefusal(turn, rules?)`. llm-client pushes it into `turnToolRefusals` (run through `firstTurnToolRefusal`). Add a rule by adding a row (A5: `subagent` write roles/background in goal rounds; B3: `subagent` background launches; D3: `child_chats start` in woken turns).
- Phone-sent turns are person turns (`remoteAudience`, not windowless) and may set one.

## Settings
- `chatCheckBacks` in `ScheduledTaskSettings` / `AppSettings` (omitted = on), row "Let chats check back later" in the "While you're away" group after "Background execution" (C1 adds Keep awake to the same group). Off → `chatCheckBacksChanged` dep of the scheduled-task application service → `checkBacks.cancelAll()`. Remote settings strip it (`remoteScheduledSettings`; OpenAPI has `additionalProperties: false`).

## UI
- Composer chip `CheckBackChip` in `follow-through-chips.tsx` (AlarmClock, "Checking back at 3:10 PM +N", popover with notes and optimistic Cancel → `chats:followThroughCancelCheckBack`). Notice card icon AlarmClock, label "Check-back".

## Not done here
- C3 (done): `dueSoonKeepAwakeInput` in `keep-awake/keep-awake-inputs.ts` holds for check-backs (`checkBacks.pendingAll()`) and Bot wake-ups (enabled `wakeUp` tasks with `nextRunAt`, cached in `keep-awake-main.ts` and refreshed on `bots:changed` / `schedule:updated` / resume) due within 60 min, only when `!powerMonitor.isOnBatteryPower()`. Reason kinds `check-back` / `wake-up`; >1 h overdue stops holding; while anything is due it rechecks every 5 min (Linux has no on-ac/on-battery events). Goal-round turns (A3) must set `goalRound` in the audience options. Phones list/cancel later (C7).
