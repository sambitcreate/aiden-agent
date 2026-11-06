# Usage-limit waits and spending limits (2026-10-26)

Guide: `docs/usage-limits-and-spending.md`. Plan and the owner's 14 decisions: `docs/plans/usage-limits-and-spending-plan.md`.

## Shape

- **Waits** live below Pi's retry loop: `withUsageLimitWait` / `streamSimpleWaitingOutUsageLimits` (`main/services/usage-limit-stream.ts`) wrap the stream function in `llm-client.ts`, `bot-runtime/bot-models.ts` (Bot `modelsFor`; `backgroundModelsFor` never waits), the subagent worker and `child-agent-runtime.ts`. The wrapper holds back `start` until content arrives, so a pre-content rejection is never shown. The gate (`usage-limit-core.ts`) is keyed per provider+model or per provider (account scope) and lets one test request through, then releases the rest oldest first.
- Headers are read through a custom `fetch` only for the APIs in `FETCH_OBSERVABLE_APIS`; Google adapters refuse one, so Gemini relies on error text.
- After a give-up the gate refuses that limit for 5 minutes (`USAGE_LIMIT_REFUSE_MS`), which also bounds Pi 1.4's own retries of the give-up error.
- `acquire` takes the request's `maxWaitMs`: a held limit clearing past `since + maxWaitMs` ends the wait with a `too-long` ticket (covers saved holds and holds another chat made). `UsageLimitService.waitSettingChanged()` (called from the settings handler) pushes a new longest wait into every running wait via `gate.setMaxWait`.
- Bot spend: `afterResponse` awaits `record`, so the next `beforeRequest` sees it. Routine run balances are saved in `spending.json` (`runs`, last 500) so a resumed run keeps its spend.
- **Spending** is a meter around the same stream functions (`createSpendingMeter`, `spending-service.ts`) that reads `usage.cost.total` from `stream.result()`. `spendCounts` is false for OAuth sign-ins and local runtimes. Refusals throw before the request: chats via `llm-client`, Bots via `BotSessionError("spending_limit")` (mapped to `409 operation_stale` for phones and to a Telegram line), routine runs via the run id on the owner.
- Both stores are device-local DataStores (`usage-limits.json`, `spending.json`) and are deliberately not in portable config's file set; the two settings (`usageLimitWaitHours`, `spendingLimits`) are.

## Remote

Revision 47 `spending-limits-v1` is PROVISIONAL (first written as 40; moved to 43 on 2026-10-28 when main held 42, then to 44 after #631 took 43, then to 45 after #639 took 44, all on 2026-10-28; then to 46 after #626 took 45 and to 47 after #629 took 46, both on 2026-10-29): re-claim at merge in `AIDEN_REMOTE_SPENDING_LIMITS_CONTRACT_REVISION`, the fixture's two `contractRevision` fields, iOS `AidenRemotePhase0Tests` and Android fixture tests. Phones only (feature token count was at 30 of the 32 cap; now 31). Allow more is compare-and-set on a status revision (`sp_` + hash of period, start, limit and extra cents) through `SpendingService.allowMoreIf`.

## Gaps

Not counted: Bot compaction summaries, the Bot memory review, chat titles. CLI has neither feature. No subscription usage meter (only source is Claude's unofficial `/api/oauth/usage`); owner chose to leave it out on 2026-10-28.

Retries (#595, merged first): a give-up, a too-long hold and a refusal carry `markUsageLimitFailure` (`aidenUsageLimitFailure: true` on the AssistantMessage, kept by pi-agent-core's `Object.assign`), and `PiCompactionCoordinator.check` skips provider retries for it. Bots use Pi Durable's own retry, which the marker does not reach; the 5-minute refusal keeps those quick.

## November 2, 2026

The managed Pi recovery loop honors the foreground spending stop after the response and tool results are durable, before automatic compaction, retry, or cut-off continuation. For reduced history, the spending stop allows a required pi-vcc checkpoint to finish locally. With the LLM engine, or if the local checkpoint cannot be saved, the run reports a compaction failure. Otherwise a priced length stop keeps its visible text. A paid failed response still reports the provider failure. Foreground chats check the ledger again at provider dispatch, including after a rate-limit wait. If the limit changed during the wait, the chat shows the spending refusal and its existing allowance control.

### Helper dispatch after provider waits (2026-11-02, PR #697 follow-up)

Helpers now recheck the shared chat ledger and latest cap inside `withUsageLimitWait` before every provider dispatch, after settling their meter. The outer meter still records completed request usage. A behavioral registry test reproduces both spending by other chat work and a lowered cap during a real 429 wait (each sent a second request before the fix); both now stop before provider I/O, while Allow more still resumes the request. No Remote protocol, client DTO, or UI contract changed.

Durable ledger saves came from the dispatch ledger on main (`publish`), which replaced this PR's own save queue when #703 merged main; a failed save rejects and the meter refuses the next dispatch. The desktop Allow more handler compares the displayed owner, period, limit and extra allowance against the current ledger in the same mutation used by Remote. A helper’s split-history summaries use the child meter and settle before the following summary or model reply. Usage still receives each delivered summary separately.
