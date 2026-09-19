# Schedule startup lifecycle ownership — 2026-09-19

Aiden baseline: `5cc831a17aa8971fb5b89c7dd9278a6ec4022beb`.
Branch: `feature/upgrade-10-schedules`.

## Finding and implementation

The startup settings read could overwrite a concurrent explicit global disable,
allowing missed tasks to run. A startup continuation stopped during a task read
could record a false task error; an obsolete task/settings failure after restart
could disable a task or tear down the newer scheduler.

`main/services/schedule-service-core.ts` now captures a startup revision and
revalidates it after asynchronous reads, upon entering a queued task lifecycle,
and before catch-up or failure handling. Stop and explicit global enable/disable
invalidate pending startup. Existing task revisions, permission checks, manual-run
policy, and provider/MCP bindings are unchanged.

## Source learning

Read-only Hermes reference: `/Users/sambitbiswas/projects/opp/hermes-agent`,
commit `69ae247cf3dba34a37ab4af8484b96d3559a4fcf`.
`cron/scheduler.py` (`_submit_with_guard`) and
`tests/cron/test_scheduler_shutdown_guard.py` demonstrate checking lifecycle
validity before background dispatch and distinguishing teardown from ordinary
failure. Reviewed the MIT license. This is original Aiden code, with no source copied.

## Validation and scope

Four deterministic regression tests failed against the original service. They now
pass, alongside two controls proving current failures still disable the affected
task or reject startup and allow retry. Existing core tests are already registered
in both relevant package scripts.

- `npm run test:scheduled`: 130 passed.
- `npm run test:assistant-automations`: 165 passed.
- `npm run type-check`: passed.
- `npm run lint`: passed.
- `git diff --check`: passed.

No shared server/transcript/native contracts or UI changed. This fixes lifecycle
behavior of an existing capability and needs no onboarding or plan-status change.
No Electron build, rendered UI, or mobile suites run for this pure service change.
Hosted CI and central Luna/Pullfrog review remain outstanding before campaign signoff.

## Central review follow-up

The first PR head (`359614bb1d76bd207ffd2de12b57ff4cb5e5ca98`) left a
persistence gap: cancellation after entering failure quarantine but before its
write committed could still disable the task and overwrite newer runtime fields.
Three deferred-commit regressions reproduced this for stop/restart, global disable,
and ordinary startup next-run persistence; all failed on that head.

`updateRuntime` now accepts the existing persistence ownership callback. Startup
passes its revision guard for both job setup and failure quarantine, so DataStore
rechecks it before publication. No rollback can overwrite newer owners. Quarantine
logging follows a successful commit. A real DataStore test also invalidates
ownership after disk staging, verifies unchanged bytes and cache, and checks that
later runtime updates survive. All four added regressions pass with the updated
120 scheduled / 155 automation totals and green type-check, lint, and diff checks.
Central re-review and exact-head hosted CI remain pending.

## Pullfrog Cron callback follow-up

The review also identified a separate obsolete Cron error path. Three regressions
failed at `2909bb9c` when stop/restart happened during task lookup, run-history
publication, or runtime publication. Cron failures now require both startup
ownership and exact current job identity. `recordRun` accepts a guard for both
persistence calls; stale callbacks cannot publish newer runtime changes, broadcast,
or log a false failure. Catch-up failure recording uses the startup guard too.
Already-published run history remains intact; there is no destructive rollback.

Additional controls cover legitimate current errors and callbacks from a job
replaced by pause/resume. Latest totals: 125 scheduled and 160 automation tests;
type-check, lint, and diff checks passed. The resolved Pullfrog finding still needs
a fresh exact-head review; old-head review results are not current signoff.

## Catch-up claim and full startup publication audit

Pullfrog's follow-up at `7dd218f4` reproduced a missed-run loss during automatic
catch-up. The audit also identified an earlier job-setup advance of the same due
time: guarding dispatch alone would still have lost the missed run. Startup now
preserves overdue `nextRunAt` through job setup until the automatic claim commits.
Every automatic dispatch requires an ownership predicate in its TypeScript options;
the claim combines it with cancellation, checks before/after the persistence await,
and passes it into the store publication guard. Cron triggers supply exact job
ownership; startup catch-up supplies job plus startup ownership.

Restart settles a cancelled predecessor before inspecting due state, preventing
runningTasks overlap from turning the retry into a startup failure. Three new
regressions fail on the prior head and pass now: cancelled lookup and claim both
recover on restart, and cancelled claim publication preserves the durable overdue
timestamp exactly. Normal Cron triggers and explicit manual runs while global/task
scheduling are paused have positive behavior controls.

Publication audit:
- Settings/task reads and per-task lifecycle admission revalidate startup ownership.
- Job map publication is synchronous after the check; resume checks exact ownership.
- Future-run setup, overdue claims and failure quarantine use guarded publication.
- Quarantine logs recheck ownership after the write.
- Unexpected-failure history/runtime writes and logs/broadcasts are guarded.
- Once execution is admitted synchronously, its AbortController and durable run
  result own the lifecycle; actual cancellation/history records remain intact.
- Provider-alias migration in store reads remains independent store-owned identity
  normalization, not startup scheduling state.

Validation: 130 scheduled tests and 165 automation tests pass; type-check, lint and
diff checks pass. Final exact-head Pullfrog/CI remain pending. Usage checked before
this work: 41% remaining, above the campaign's 1% stop threshold.
