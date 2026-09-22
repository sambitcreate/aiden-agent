# Hermes Bot run-control upgrade — September 22, 2026

Baseline c8c09e0d2; branch feature/hermes-bot-run-controls. Read all seven Hermes
hub children, verified upstream gateway/run.py. No upstream code copied. PR #205
managed-home remount files excluded. Plan: docs/plans/hermes-bot-run-control-plan.md.

Telegram patch bounds queue and albums, preserves edit ordering, adds explicit
queue/interrupt commands, cancels pre-dispatch/pre-generation work and preserves
canonical Bot identity through /new compaction. Offset persistence gates dispatch;
queue remains memory-only (restart does not preserve pending drafts). Already
committed user input remains history when Stop prevents generation.

Shared foreground admission is implemented on feature/bot-run-input-admission,
stacked on Telegram PR #216 (89c49d9d). Contract commit 4e5c42fb defines
chat-run-input-v1 and POST /streams/{streamId}/inputs. Host admission reserves Pi
capacity, persists user history, and journals visible user markers atomically to
avoid later transcript replay. Agent-end drains pending reservations; cancellation
may prevent consumption of already committed history. Desktop Steer is distinct
from Interrupt; Telegram /steer uses the same host path. Remote ledger results
retain chatId privately for current authorization on retries after stream eviction
or restart. Unknown desktop results retain request identity and never auto-resend.
Native consumer coordination is with task
01a0c7aa-c3ec-7530-8ecc-96f7788c17f1. Later profile/peer/rooms assessment is in plan.

Two Sol medium reviews identified interrupt ack/priority ordering, stale compaction
confirmation, unbound cross-topic controls, polling retry loss, and crash replay
windows. All findings were fixed with targeted regressions. Telegram 227/227, onboarding
55/55, type-check, scoped lint and diff check pass. PR #216 is published; hosted verify/E2E and Pullfrog are queued. Greptile is blocked by its external 50-credit trial limit. Live Telegram acceptance remains pending. Upstream source pinned to
836b5f8253d27fee79b4f833bc43624f06a890b3 (gateway/run.py SHA256
acb8e4ed5b675ce49c12ebd1014aa034f746068a4fde23275c29e6e77b29e69c).


Slice 2 focused tests: initial host/Pi/compaction/queue/IPC 148 passed, Telegram
228 passed, Remote suites 459 passed and 1 skipped; review-fix router/streams 86
passed. Electron tests verify true steering after route detach, single journal
projection, draft retention, and oversized text eligibility. Compaction suite 334/334, onboarding 55/55, type-check, build and scoped lint pass. Lost-accepted-receipt then not-active E2E passes and confirms no duplicate send. Native consumer suites remain in progress. Independent Sol medium review found
and fixed detach rejection, oversized draft uncertainty, stream-eviction replay,
and uncertain old-receipt duplicate risk. Plan remains active until native work
and hosted review/check gates complete; no merge, deploy, or release performed.


Shared admission published in PR #220 (stacked on #216). Full desktop queue E2E
12/12 pass; existing Android Remote/progress focused suite passes; iOS generic
build-for-testing passes (compilation, not device execution). Telegram final
barrier captures the target and admits only after offset durability. A crash/stop
in that memory-only pending window may discard an unacknowledged command; accepted
history remains persisted. This matches the slice's non-durable Telegram ingress
scope and is covered by a stop-before-admission regression. PR #216 hosted verify
is green; Electron and Pullfrog remain pending. PR #220 hosted checks in progress.

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

PR #220 Pullfrog follow-up: pre-admission authorization now wraps the live
idempotency action, so policy denial cannot poison a fresh request UUID. Evicted
stream receipts use read-only replayExisting: no reservation, pruning, or clock
advance; stored chat access is rechecked before returning the receipt. Unknown
host outcomes remain non-repeatable. OpenAPI now declares nonblank text and the
required x-aiden-max-utf8-bytes extension, with whitespace and Unicode boundary
contract tests. Focused ledger/stream/protocol suite93 passed. Native owner was
asked to confirm the same byte/nonblank checks; public DTO shape is unchanged.
Ambiguous exceptions after entering the host callback become indefinite in-flight
ledger entries, not expiring internal-error rejections. A short-TTL restart test
proves no second host call after expiry. Final focused93 +router42 tests pass;
type-check and scoped lint pass, both Sol medium re-reviews clear.
