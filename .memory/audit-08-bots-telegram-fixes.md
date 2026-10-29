# Audit 08 fixes: Bots, Telegram bridge, routines, health — 2026-10-29

Branch `claude/audit-fix-bots-telegram`. Fixed every finding except F6 (deleting
`durable-jobs/**`), which stays per `code-health-helpers.md` and
`docs/plans/durable-jobs-leases-plan.md`.

Telegram (`main/services/telegram*`, `packages/cli/src/telegram.ts`):
- Token change to a different bot (id is the part before `:`) resets
  `lastUpdateId` via `adoptBot`; pairing (`allowedUserId`) is kept, but the
  forum-thread map is cleared (`forgetThreadTargets`, no deleteForumTopic) and
  reprovisioned for the new bot.
- Poll errors back off exponentially to 5 min and honor 429 `retry_after`.
  401/404 stop the bridge with `REJECTED_TOKEN_MESSAGE` until a new token;
  409 shows `POLL_CONFLICT_MESSAGE` and keeps retrying.
- `launch` is single-flight with a `lifecycleEpoch`, so a disable during the
  getMe loop can't resurrect polling. A token change stops the service, saves
  the key, then `restart()`s. The poll batch loop breaks once stopped (the
  unconfirmed rest is redelivered from the persisted offset).
- The typing loop takes the stop signal.
- Desktop and CLI share one per-bot lease `bot-<id>` under
  `telegramSharedOwnershipRoot` (`$AIDEN_CONFIG_DIR`, else `~/.aiden` for the
  default agent dir, else the custom agentDir) in `telegram-owners/`. A record
  is stale when its heartbeat is old AND (its pid is dead OR its `bootAt`
  differs from this boot by > 2 min), so a pid reused after a reboot can't hold
  it. No heartbeat-only bound: after sleep that would steal from a live owner.

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
  routine wrote are dropped (and fingerprinted by mtime/size for 60 s to
  swallow late fs.watch echoes) and the rest fire. Shell writes are not
  journaled. Each `watch` is wrapped in try/catch (one bad folder refuses only
  that routine), and a generation counter captured synchronously in `rearm()`
  stops a rearm that finishes after dispose.
- Preflight `rearm` loads routines first, then cancels and arms synchronously,
  so overlapping rearms (interval + wake) can't orphan timers; a sequence
  number drops an older rearm whose read finished last.
- `stopBotHealth` is async and awaits the delivery flush (`stopBotDeliveryFlush`)
  and event-routine stops, bounded at 3 s (then it logs and returns).

Tests: telegram-service-core "Transport resilience", telegram-ownership,
CLI parity offset/lease test, bot-run-watchdog wake test, events.test folder
cases (own writes vs a dropped file, overlapping runs, stop → uncertain →
replay, delivered run settles), preflight live-timer cases, watchdog gap test,
telegram bot-switch thread reset, ownership reboot test.
`bot-reply-outbox.test.ts` waitFor timing flaked once under load ~118; it
passed on every rerun and does not touch these changes.
