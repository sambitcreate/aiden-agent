# Usage-limit waits and spending limits (2026-10-26)

Guide: `docs/usage-limits-and-spending.md`. Plan and the owner's 14 decisions: `docs/plans/usage-limits-and-spending-plan.md`.

## Shape

- **Waits** live below Pi's retry loop: `withUsageLimitWait` / `streamSimpleWaitingOutUsageLimits` (`main/services/usage-limit-stream.ts`) wrap the stream function in `llm-client.ts`, `bot-runtime/bot-models.ts` (Bot `modelsFor`; `backgroundModelsFor` never waits), the subagent worker and `child-agent-runtime.ts`. The wrapper holds back `start` until content arrives, so a pre-content rejection is never shown. The gate (`usage-limit-core.ts`) is keyed per provider+model or per provider (account scope) and lets one test request through, then releases the rest oldest first.
- Headers are read through a custom `fetch` only for the APIs in `FETCH_OBSERVABLE_APIS`; Google adapters refuse one, so Gemini relies on error text.
- After a give-up the gate refuses that limit for 5 minutes (`USAGE_LIMIT_REFUSE_MS`), which also bounds Pi 1.4's own retries of the give-up error.
- **Spending** is a meter around the same stream functions (`createSpendingMeter`, `spending-service.ts`) that reads `usage.cost.total` from `stream.result()`. `spendCounts` is false for OAuth sign-ins and local runtimes. Refusals throw before the request: chats via `llm-client`, Bots via `BotSessionError("spending_limit")` (mapped to `409 operation_stale` for phones and to a Telegram line), routine runs via the run id on the owner.
- Both stores are device-local DataStores (`usage-limits.json`, `spending.json`) and are deliberately not in portable config's file set; the two settings (`usageLimitWaitHours`, `spendingLimits`) are.

## Remote

Revision 40 `spending-limits-v1` is PROVISIONAL (main held 37, others claimed 38/39): re-claim at merge in `AIDEN_REMOTE_SPENDING_LIMITS_CONTRACT_REVISION`, the fixture's two `contractRevision` fields, iOS `AidenRemotePhase0Tests` and Android fixture tests. Phones only (feature token count was at 30 of the 32 cap; now 31). Allow more is compare-and-set on a status revision (`sp_` + hash of period, start, limit and extra cents) through `SpendingService.allowMoreIf`.

## Gaps

Not counted: Bot compaction summaries, the Bot memory review, chat titles. CLI has neither feature. No subscription usage meter (only source is Claude's unofficial `/api/oauth/usage`).
