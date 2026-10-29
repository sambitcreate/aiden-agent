# Bot self wake-ups (wake sources plan, step 2) — 2026-10-28

Plan: `docs/plans/bot-wake-sources-plan.md` step 2, branch `feature/bot-self-wake` (stacked on `feature/bot-wake-sources`). Owner approved on 2026-10-28 that a Bot may set bounded wake-ups **without an approval card**. User docs: `docs/bot-routines.md` "Wake-ups a Bot sets for itself".

## Layout
- `renderer/shared/bot-wake-ups.ts`: tool name `wake_up`, entry kind `aiden.wake-up`, routine name `Wake-up`, limits (1–1440 min, 3 pending, note ≤ 500), `botWakeUpWhen(fireAt, now, zone?)` ("at 3:10 PM" / "tomorrow at 9:00 AM" / "on Oct 31 at 9:00 AM").
- `main/services/bot-wake-ups/wake-ups.ts`: `createBotWakeUps({store, routines, timezone, enabled})` → `set` / `pending` / `cancel` / `cancelAll`, and `resolveBotWakeUpTime({inMinutes}|{at:"HH:MM"}, now, zone)`. `in_minutes` rounds down to a whole minute at least 30 s away; a fire time whose once-schedule cron would name a different instant (the second pass through a repeated DST hour) is refused as `invalid_time`, and a `create` that throws (minute passed while saving) also maps to `invalid_time`; `at` means its next occurrence within 24 h in the host zone. The cap check and the create run in one serialized section per Bot, so concurrent sets cannot pass 3. Error codes: `invalid_time`, `invalid_note`, `too_many_pending` (with the pending list, soonest first), `not_found`, `off`.
- `wake-up-tool.ts`: the Pi tool (`set` with `in_minutes` XOR `at`, `list`, `cancel {id}`); a successful set appends the `aiden.wake-up` entry `{wakeUpId, fireAt}` through the call's own `appendEntry` (never through the session service: the deadlock rule in `bot-pause.md`). No model parameter.
- `wake-up-candidate.ts` + `wake-ups-main.ts` (desktop singletons, `botSelfWakeUpsEnabled(botId)`); wired in `bot-runtime/bot-tool-sources-main.ts` after the hand-off candidate, only when the turn is not a routine run and the switch is on.
- Storage: a one-time Bot routine (`schedule {kind:"once"}`) named `Wake-up` with `ScheduledTask.wakeUp = {setAt}` (`types.ts` `BotWakeUpMarker`, kept by `schedule-store-core.ts`). `scheduled-bot-routines.ts` fires it with `botWakeUpPrompt` ("You set this wake-up at 3:10 PM: <note>" + the `[SILENT]` line), and `isSpentBotWakeUp` hides a fired one from `list`. A spent one is kept for the 7-day catch-up window and pruned by the next `set`. The routines IPC parser refuses a `wakeUp` field, so only the tool makes one.

- Tool-originated deletes (`cancel`, `set`'s prune) call `botRoutineService.delete(input, { cleanup: "background" })`: the `routineDeleted` fan-out settles Bot issues through the session service's append, which would wait behind a Pause close that itself waits for the tool (deadlock). `cancelAll` (IPC) still awaits cleanup.

## Gating (loop prevention)
- `bot-tool-policy.ts`: ingress allows `wake_up` only when every request id is neither `routine:` nor intro, and the verdict denies routine turns. Routine, event, catch-up and wake-up runs all use `routine:` request ids, so none can set another wake-up. Desktop, phone and Telegram turns can.
- Per-Bot switch `BotDefinition.selfWakeUps` (only `false` is stored; an absent key on update keeps the stored value). `bots:update` with `selfWakeUps:false` calls `botWakeUps.cancelAll` → **every wake-up task of the Bot is deleted**, including spent/skipped ones still owed a catch-up and claimed ones in recovery (PR #636 review) (decision: nothing the Bot set fires after the person says no; turning it back on restores nothing). The person's own routines stay. The Remote `updateBot` does not pass the key.

## UI
- Chat: `live-projection.ts` maps the entry to `{type:"wake_up", wakeUpId, fireAt}` (outlives a `[SILENT]` turn). `renderer/components/bots/wake-up-chip.tsx` shows "Wake-up at 3:10 PM · Cancel". Cancel appears only while the routine is still pending (from the `botRoutinesKey` query, loaded only when the transcript has a chip) and the minute has not arrived. Clicking it removes the routine optimistically, then `bots:routines:delete`; on failure it restores and toasts.
- Profile routines list (`bot-routines.tsx`): a wake-up row is not a button (no editor), with an AlarmClock icon, "Wake-up at …", the note, and a small Cancel (shown while enabled, or disabled with no fire pending, e.g. paused by the routines tool).
- Advanced → Chat (`bot-advanced.tsx` `SelfWakeUpsField`): "Let <Bot> set its own wake-ups" switch, saves on its own.

## Remote / native clients
- No wire change and no revision: the unknown `wake_up` transcript entry is dropped by the projection's default branch. Phones see the wake-up as an ordinary one-time routine named Wake-up (and can delete it), and its fire arrives like any routine message.

## Open
- The CLI's durable Bot tool sources do not offer `wake_up` yet.
