# Audit 08 fixes: Bots, Telegram bridge, routines, health — 2026-10-29

Branch `claude/audit-fix-bots-telegram`. Fixed every finding except F6 (deleting
`durable-jobs/**`), which stays per `code-health-helpers.md` and
`docs/plans/durable-jobs-leases-plan.md`.

Telegram (`main/services/telegram*`, `packages/cli/src/telegram.ts`):
- Token change to a different bot (id is the part before `:`) resets
  `lastUpdateId` via `adoptBot`; pairing (`allowedUserId`) is kept.
- Poll errors back off exponentially to 5 min and honor 429 `retry_after`.
  401/404 stop the bridge with `REJECTED_TOKEN_MESSAGE` until a new token;
  409 shows `POLL_CONFLICT_MESSAGE` and keeps retrying.
- `launch` is single-flight with a `lifecycleEpoch`, so a disable during the
  getMe loop can't resurrect polling; `restart()` runs on token change.
- The typing loop takes the stop signal.
- Desktop and CLI share one per-bot lease `bot-<id>` under
  `telegramSharedOwnershipRoot` (`$AIDEN_CONFIG_DIR`, else `~/.aiden` for the
  default agent dir, else the custom agentDir) in `telegram-owners/`.

Runtime/routines/health:
- `BotRunWatchdog.resume()` restarts every running bot's stall window; the
  `powerMonitor` resume listener is subscribed in `initializeBotSessionRuntime`
  (not at module load: under tsx `electron` is a path string) and removed at
  shutdown.
- Event-routine runs keep an AbortController; `stopBotEventRoutines` aborts
  them. The executor records the cancelled run as uncertain, so it replays.
- Folder watch ignores changes while the routine's own run is in flight
  (`ownRun`), wraps each `watch` in try/catch (one bad folder refuses only that
  routine), and a generation counter captured synchronously in `rearm()` stops
  a rearm that finishes after dispose.
- Preflight `rearm` loads routines first, then cancels and arms synchronously,
  so overlapping rearms (interval + wake) can't orphan timers.
- `stopBotHealth` is async and awaits the delivery flush and event-routine stops.

Tests: telegram-service-core "Transport resilience", telegram-ownership,
CLI parity offset/lease test, bot-run-watchdog wake test, events.test folder
cases, preflight live-timer cases. F7/F10 are wiring in files without a
harness (`sources-main.ts`, `health-main.ts`) and have no dedicated test.
`bot-reply-outbox.test.ts` waitFor timing flaked once under load ~118; it
passed on every rerun and does not touch these changes.
