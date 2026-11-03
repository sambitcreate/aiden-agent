# Audit 08 fixes: Bots, routines, health — 2026-10-29

Branch `claude/audit-fix-bots-telegram`. Fixed every finding except F6 (deleting
`durable-jobs/**`), which stays per `code-health-helpers.md` and
`docs/plans/durable-jobs-leases-plan.md`.

Telegram findings were dropped on 2026-10-31: the owner plans to remove
Telegram entirely, so PR #659 ships only the Bot, routine and health fixes.

Runtime/routines/health:
- `BotRunWatchdog.resume()` restarts every running bot's stall window; the
  `powerMonitor` resume listener is subscribed in `initializeBotSessionRuntime`
  (not at module load: under tsx `electron` is a path string) and removed at
  shutdown. `check()` also calls `resume()` when more than 2 intervals passed
  since the last check (sleep without a resume event).
- Event runs go through `bot-routine-events/runner.ts`. It owns the
  AbortControllers; `stopBotEventRoutines()` (async) aborts them and awaits the
  dispatcher's and folder watch's `idle()`. The executor records a cancelled
  run as uncertain under a fresh id, so the receipt stays and it replays.
- Bug found on main: schedule-store-core `recordRun` saves the run, then
  `updateRuntime` throws "Scheduled task not found" for event routines (not
  schedule tasks), so every live event run threw before delivery and settled
  only by replay. `eventRoutineRunStore` returns the saved run in that case.
- Folder watch: the file tool router's `onWrite` records routine-turn writes in
  `own-writes.ts` (`botOwnWrites`). While a routine's runs are active (refcount
  per routine) changes are held; on the last end plus 5 s settle, paths the
  routine wrote are dropped only while the file still matches the mtime/size
  the journal captured at the Bot's write (`record` stats it; the router awaits
  `onWrite` so this lands before the call returns), and that fingerprint
  swallows late fs.watch echoes for 60 s. A Bot-written file the person edits
  or deletes before release fires (Pullfrog PR #659 finding). Same-size edits
  within the filesystem's mtime resolution can't be told apart. The rest fire. Shell writes are not
  journaled. Each `watch` is wrapped in try/catch (one bad folder refuses only
  that routine), and a generation counter captured synchronously in `rearm()`
  stops a rearm that finishes after dispose.
- Preflight `rearm` loads routines first, then cancels and arms synchronously,
  so overlapping rearms (interval + wake) can't orphan timers; a sequence
  number drops an older rearm whose read finished last.
- `stopBotHealth` is async and awaits the delivery flush (`stopBotDeliveryFlush`)
  and event-routine stops, bounded at 3 s (then it logs and returns).

Tests: bot-run-watchdog wake test, events.test folder
cases (own writes vs a dropped file, overlapping runs, stop → uncertain →
replay, delivered run settles), preflight live-timer cases, watchdog gap test.
