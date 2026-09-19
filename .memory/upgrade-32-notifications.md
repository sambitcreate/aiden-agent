# Upgrade lane 32 — Scheduled notification failure isolation

2026-09-19. Baseline 5cc831a17aa8971fb5b89c7dd9278a6ec4022beb.

The schedule execution path records a run before showing its notification. Native support/create/subscription/show exceptions previously escaped that saved-run boundary, skipped `schedule:updated`, and could cause the scheduler to record a false second failure. Notification click callbacks also leaked synchronous throws and rejected navigation promises.

Notification delivery now returns false on synchronous failure, reports delivery/navigation phase through an optional guarded diagnostic callback, and contains asynchronous navigation rejection. Production logs only a fixed phase message, never notification content or raw native error text. Task execution errors, silent runs, opt-out, unsupported platforms and captured chat identities retain their existing semantics. No shared/native contracts, UI, preferences, background network, releases or plan status changed.

Baseline: 13 registered notification tests, 10 failed / 3 passed. Fixed: 13/13 pass including real createScheduleExecution.run (bundled with synthetic platform, script and storage ports), completed-run record/broadcast, controller release, original script errors, silent runs, opt-out and click failures. Physical notification delivery is not tested.

Sources: Hermes cron/scheduler.py (MIT) separates execution and delivery errors; Waku native notification routing (GPL, concepts only, no copied code) preserves identity and tolerates unavailable delivery; Prime Agent notification extension (MIT) shows platform transport seams. Exact repository heads and file SHA-256 values are in the campaign lane JSON. Mutable profile/identity and normal duplicate-delivery hypotheses were not demonstrated and were not changed.

Final local validation: `npm run test:scheduled` 121/121, `npm run type-check`, `npm run lint`, and `git diff --check` passed using an isolated lockfile install. No full npm test while campaign integration is active. Self-review confirmed narrow delivery-only catch scope, no task result mutation, safe diagnostic text, and existing `test:scheduled` registration. Hosted CI/Pullfrog and Luna review remain separate gates.
