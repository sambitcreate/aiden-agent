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
  - A retry is a `pendingRoutineFires` entry with `retry: {failedRunId, attempt}`. The request id is `<failedRunId>:retry-N`; the trigger is `{kind: "retry", requestId, failedRunId, attempt}`.
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
