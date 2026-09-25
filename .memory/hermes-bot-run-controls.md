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

Command-edit follow-up: classify the duplicate success acknowledgment and
post-dequeue command re-admission as actionable. Explicit edited-message gates
for /queue, /continue and /interrupt now produce unchanged/not-sent receipts,
never a new admission or interrupt. Five regressions cover pending/dequeued
sources. Telegram238 passed, both Sol medium re-reviews clear; plan documents
exact text and unchanged ordinary-prompt edit behavior.

Slice 2 follow-through (2026-09-24, branch feature/on-the-go-midflight-ops):
shared foreground admission is now implemented and advertised as
`chat-run-input-v1` (contract revision 12). `llmClient.admitChatRunInput` is the
single main-owned boundary: Pi queue preflight probe → durable user-message
append (appendChatMessageWithReconciliation; unknown outcomes escalate to
AidenOperationUnknownOutcomeError) → queueSteer/queueFollowUp. Committed-but-
rejected results keep the persisted message and report `committed: true`.
Remote `POST /streams/{streamId}/inputs` is idempotent per request UUID via the
stream service ledger, binds stream→chat→turn→ownerDocumentId, revalidates
bot chat access through runChatMutation, and returns 404 when unwired.
Desktop `chat:admitRunInput` IPC shares the same boundary and owner check.
iOS/Android gained additive DTOs, `supportsChatRunInput`, and client methods;
native Steer/Queue composer UX remains the On The Go slice C work.

Slice 2 review follow-ups: `POST /streams/{id}/cancel` and
`/approvals/{id}/respond` still run stream/approval chat-access checks before
their idempotency actions, so a replayed request after record eviction returns
not_found instead of the recorded outcome. The inputs route solved this by
executing `runAccess` inside the ledger action; apply the same pattern to the
sibling routes in a follow-up. Also fixed in that pass: a prepare-persist
failure previously poisoned the key with a sticky internal_error even though
the action provably never ran — the ledger now discards the unexecuted entry
(`discardUnexecuted`), and the durable gate has a rejection sink for replay
paths that never invoke the wrapper.
