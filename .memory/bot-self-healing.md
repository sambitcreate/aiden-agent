# Bot self-healing (Bot autonomy Plan A, 2026-10-27)

Spec: `docs/superpowers/specs/2026-10-27-bot-autonomy-design.md` §4–§5. Plan: `docs/superpowers/plans/2026-10-27-bot-autonomy-a-healing.md`. Branch `feature/bot-autonomy`.

## Layout
- **Failure kinds:** `renderer/shared/bot-routine-failure.ts` (`classifyBotRoutineFailure`, kinds temporary | sign_in | access_changed | model_setup | tool_error | stalled | other). `ScheduledRun.failure`, `ScheduledRun.claimCheck`. The executor redacts every error text through `message()`. `settledOutcome` passes Pi's `detail`.
- **Delivery funnel:** `main/services/bot-delivery/{log,funnel,funnel-main}.ts`.
  - Per-Bot `deliveries.json`, with per-channel `macSentAt` and `telegramSentAt`, and `suppressed` rows that are never served to phones.
  - The gate is asked only when a row is new. `ALWAYS_NOW_GATE` is in place until Plan B.
  - The phone feed (`bot-routine-notifications.ts`) reads due rows.
- **Bot issues:** `renderer/shared/bot-issues.ts`, `main/services/bot-issues/{store,service,service-main}.ts`.
  - Per-Bot `issues.json`, chat entries `aiden.bot-issue` and `aiden.bot-issue-status`, at most 8 open.
  - Raises are coalesced in flight. A failed append or delivery is repaired by the next raise. `act` claims the issue by id.
  - Open issues count toward `needsYou`. Remote `bot:issues` (revision 42) is in `aiden-remote-bot-issues.ts`.
- **Recovery:** `main/services/bot-routine-recovery.ts` (+ `-main.ts`), called from the executor's `afterRun` dependency (desktop only; the CLI does not wire it).
  - A retry is a `pendingRoutineFires` entry keyed by `<failedRunId>:retry-N`. New entries carry `verifiedToolFree: true` after the durable session confirms the failed attempt requested no tools. The check uses the first generation created with the input and its owned tool tasks, so a later chat's tools cannot disqualify the routine. Before a fresh submission, older entries check previous attempts. A previously admitted retry is observed by its existing submission ID.
  - Auto-pause runs inside the active fire. It disables the routine and clears queued retries in one store update, preserving the active receipt until delivery settles, then disarms its cron job. The person-facing pause path waits for the active fire and must stay outside that callback.
  - The pending scan waits for the first future retry instead of backing off.
  - Issue keys are `routine_failed:<taskId>` and `routine_paused:<taskId>`. Three same-kind failed fires pause the routine. Claim-flagged success runs count as failed fires.
- **Health:** `renderer/shared/bot-health.ts`, `main/services/bot-health/{checks,preflight,health-main}.ts`.
  - The model and sign-in checks use `probeBotAdmission` in bot-session-main (real admission, which repairs stale model bindings), then `preflightBotModelAuth`.
  - Connections are checked for Custom grants only, through `botCapabilityCatalog.reconcile`. The computer check is a store read only.
  - Pre-fire timers rearm every 5 minutes from `schedules.json` and on power resume. Issue keys are `preflight:<checkId>`.
  - IPC `bots:health:report` / `bots:health:check`. The desktop section is `renderer/main/bots/bot-health-section.tsx`.
- **Watchdog:** `main/services/bot-runtime/bot-run-watchdog.ts`, wired in bot-session-main (`watchRun` subscribes to the live projection; any event counts as progress).
  - Routine runs: stopped, and recorded `stalled` through the `botRunStalls` mark and `consumeStall`.
  - Attended runs: a `run_stalled` issue with Stop and Keep waiting (`snoozeBotRunWatchdog`).
- **Claim check:** `main/services/bot-runtime/bot-claim-check.ts`, which reuses the chat detector over the newest turn's projected tool results. `botTurnClaims(botId)` uses the Bot's MCP tool names (`toolSources.mcpToolNames`).

## Known limits
- No claim chip on attended desktop Bot replies yet (routine results only).
- A computer give-back is not "waiting on the person" for the watchdog.
- Full-access connections are not checked before a fire.
- The CLI has failure kinds only.
- The detector matches general success claims ("Done", "task completed") for connector tools, not "I sent the email".

Superseded retries become observation-only. Recovery checks the saved run and Pi admission before it discards a stale receipt, including after an uncertain attempt advanced lastRunAt. A person pausing or editing a routine retires its queued retry instructions.
