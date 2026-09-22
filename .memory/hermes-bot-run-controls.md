# Hermes Bot run-control upgrade — September 22, 2026

Baseline c8c09e0d2; branch feature/hermes-bot-run-controls. Read all seven Hermes
hub children, verified upstream gateway/run.py. No upstream code copied. PR #205
managed-home remount files excluded. Plan: docs/plans/hermes-bot-run-control-plan.md.

Telegram patch bounds queue and albums, preserves edit ordering, adds explicit
queue/interrupt commands, cancels pre-dispatch/pre-generation work and preserves
canonical Bot identity through /new compaction. Offset persistence gates dispatch;
queue remains memory-only (restart does not preserve pending drafts). Already
committed user input remains history when Stop prevents generation.

Shared foreground Steer is NOT implemented or advertised: Pi's internal queue
needs main-owned user transcript persistence/projection, exact run/request identity,
revocation, capacity and idempotency before public IPC/Remote admission. Owner is
this runtime task; mobile consumer coordination is with task
01a0c7aa-c3ec-7530-8ecc-96f7788c17f1. Later profile/peer/rooms assessment is in plan.

Two Sol medium reviews identified interrupt ack/priority ordering, stale compaction
confirmation, unbound cross-topic controls, polling retry loss, and crash replay
windows. All findings were fixed with targeted regressions. Telegram 227/227, onboarding
55/55, type-check, scoped lint and diff check pass. Hosted CI, PR publication
and live Telegram acceptance remain pending. Upstream source pinned to
836b5f8253d27fee79b4f833bc43624f06a890b3 (gateway/run.py SHA256
acb8e4ed5b675ce49c12ebd1014aa034f746068a4fde23275c29e6e77b29e69c).

PR #216 Pullfrog follow-up: `/continue` carries its Telegram source message ID
and treats post-admission acknowledgment failure as handled. Explicit `/queue`
and `/continue` suppress the generic busy notice so each command produces one
confirmation. Six regressions cover preparing/running and unknown acknowledgment
outcomes with redelivery. Telegram suite: 233 passed; scoped lint passes. This
fix is carried into stacked PR #220 without changing the native input contract.
