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

- `npm run test:scheduled`: 116 passed.
- `npm run test:assistant-automations`: 151 passed.
- `npm run type-check`: passed.
- `npm run lint`: passed.
- `git diff --check`: passed.

No shared server/transcript/native contracts or UI changed. This fixes lifecycle
behavior of an existing capability and needs no onboarding or plan-status change.
No Electron build, rendered UI, or mobile suites run for this pure service change.
Hosted CI and central Luna/Pullfrog review remain outstanding before campaign signoff.
