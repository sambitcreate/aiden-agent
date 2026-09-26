# Hermes-inspired Bot run control

Status: Active (Telegram PR #216 under review; shared foreground admission implemented, native consumers in progress)
Owner: Hermes runtime task; native consumers coordinated with the Bot mobile task.

## Evidence and scope

Read all seven children of the September 21 Hermes Notion hub (profiles, gateway,
Bot Mode, peer messaging, rooms, delegation, upgrade map). Verified current
NousResearch/hermes-agent `836b5f8253d27fee79b4f833bc43624f06a890b3`
`gateway/run.py` on September 22: busy-input policy and
hard interruption exist upstream. These are product references, not copied code.
Aiden baseline is origin/main c8c09e0d2, not the coordinator's stale checkout.
PR #205 owns managed-home remount recovery; this plan does not change those files.

## Slice 1: Telegram reliability

- Bound pending work (including debounced albums) to 20 prompts and 32 MiB.
- Preserve FIFO during edits; reject overflow without losing accepted input.
- Acknowledge busy queue admission; Queue text and Interrupt text are explicit.
- Interrupt prioritizes its replacement and cancels before waiting for transport acknowledgment.
- Stop cancels pending dispatch/pre-generation admission and clears only its target.
- Persist the polling offset before allowing queued work to execute; retries do
  not overtake failed updates. This remains an in-memory queue: accepted pending
  work is not crash-durable and is cleared on bridge shutdown/re-pairing.
- `/new` on a bound Bot offers compaction of its canonical chat; never fork,
  delete, or recreate its identity. Bind confirmation to the original Bot route.
- Retain user messages already committed before cancellation as conversation
  history; cancellation prevents subsequent inference rather than erasing input.
- Run Telegram/onboarding/type/lint checks and two independent Sol medium reviews.
  Open focused PR, address hosted reviews and wait for required checks.

## Slice 2: shared foreground admission (implemented; review and native validation in progress)

The main-owned admission boundary now reserves bounded Pi capacity, persists the
user message before injection, and journals the matching visible-message marker
atomically with the Pi message. Agent completion drains outstanding persistence
reservations; Stop may prevent consumption after history has committed. Desktop
Steer and Telegram `/steer` use this path; Interrupt retains stop-and-send behavior.
Remote receipts retain the chat authorization resource through stream eviction and
restart and recheck current Bot access before returning an exact retry. Desktop
unknown outcomes retain their original request identity and cannot auto-resend.
Telegram `/steer` captures its target and waits for a durable polling offset before
admission. Like the pending Telegram queue, this waiting action is memory-only:
a crash or bridge stop between offset persistence and admission can discard an
unacknowledged command. Only the later host receipt produces “Steering accepted”;
accepted user history survives cancellation. No durable Telegram ingress is claimed.
Implementation and acceptance checklist:

1. Negotiate an additive capability (`chat-run-input-v1`, subject to native review).
2. Bind requests to chat, exact stream/run identity, authenticated principal,
   request UUID and immutable payload; modes steer/queue, initially text-only.
3. Revalidate current Bot permissions and ownership; reject stale/terminal/revoked
   runs and capacity exhaustion without consuming the client draft.
4. Reserve bounded capacity and persist the user transcript/projection before an
   accepted receipt. Coordinate terminal/cancel races and ensure accepted work
   cannot disappear between the host store and Pi queue.
5. Same request retry returns the original result; conflicting payload reuse fails.
   Define recovery/expiry and cancellation disposition before exposing the endpoint.
6. Add exact accepted/rejected DTO, Electron IPC and feature-gated
   `POST /streams/{streamId}/inputs` (host derives chat, never client chat authority);
   coordinate iOS/Android consumers and focused tests with the mobile owner.
7. Native/desktop draft retention, Stop behavior and old-server fallback must pass
   along with runtime race/adversarial tests and two independent Sol reviews.

The server advertises `chat-run-input-v1` only when the host admission callback is configured. Native clients must negotiate this feature and retain drafts on rejection or uncertainty. No merge or release is authorized.

## Later dependencies assessed

- Profile isolation: Aiden already owns Bot homes and permission boundaries. An
  optional SOUL file or per-Bot provider inheritance needs a separate policy and
  migration; never copy OAuth/Telegram tokens automatically. Single-writer home
  enforcement must compose with PR #205, not duplicate its remount policy.
- Peer messaging: needs roster-only addressing, stable delivery IDs/receipts,
  permission checks, bounded recursion and explicit queued-versus-delivered status.
- Group rooms: need Mac-owned durable driver leases, per-member sessions, serial
  bounded rounds, stop/hold and user escalation. No phone-owned driver.
- Delegation remains ephemeral child work, separate from durable Bot identities.
- Pending request cards and subagent controls need their own negotiated authority
  contract; this plan does not claim they are delivered by existing read-only DTOs.

## Telegram command edits

Ordinary queued prompt edits retain their existing FIFO update behavior. Editing
an already sent `/queue`, `/continue`, or `/interrupt` command is not a new action:
while its original is pending, reply “This message is already queued; its saved
text is unchanged. Use /queue to manage it.” After dequeue, reply “This command
edit was not sent because the original message is not queued.” Neither path
admits another turn or aborts a running one. Five regressions cover pending edits
and all three commands after dequeue. This closes a misleading success receipt
in the source-deduplication path rather than deferring it as a cosmetic issue.

Remote admission review follow-up: authorization failures before the live host
callback leave no idempotency record; exact retries can succeed after access is
restored. Evicted streams allow only read-only lookup of existing receipts with
current chat authorization. OpenAPI's nonblank pattern and required UTF-8 byte
extension are part of the native client validation contract. Host unknown outcomes
still prevent repeat execution. Regression coverage includes denial/retry,
missing-stream lookup, revoked replay access, clock rollback, and Unicode limits.
