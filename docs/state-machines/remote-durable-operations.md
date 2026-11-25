# Remote durable operations and named state machines

Formal record of the P3 (`#746`–`#750`) and P4 (`#751`–`#754`) state-machine work landed on `main` (summarized during rollout in `.memory/remote-durable-operations.md`). No serialized snapshot format, existing API fixture, or Aiden Remote protocol revision changed; `protocol/aiden-remote/v1/fixtures/bot-outbox-delivery.json` is a new contract fixture recording existing phone outbox behavior.

## Idempotency ledger (`aiden-remote-durable-operation.ts`)

Owner: `main/services/aiden-remote-durable-operation.ts` (persist adapter), `main/services/aiden-remote-operation-state.ts` (pure phase reducer), and `main/services/aiden-remote-operation-contract.ts` (ledger, error classes, snapshot bounds). Behavioral oracles: `main/services/aiden-remote-durable-operation.test.ts` and `main/services/aiden-remote-operation-contract.test.ts`.

`executeAidenDurableOperation` is the only persist adapter for Remote mutations. Six services use it: `aiden-remote-bots.ts`, `aiden-remote-chats.ts`, `aiden-remote-git.ts`, `aiden-remote-schedules.ts`, `aiden-remote-streams.ts`, and `aiden-remote-workspaces.ts`. Do not add inline admission or outcome writes elsewhere.

### Phases and transitions (`advanceAidenOperation`)

| Phase | Wire state | `expiresAt` | Meaning |
|---|---|---|---|
| `executing` | `in_flight` | `null` | Live owner in this process. |
| `unknown` | `in_flight` | `null` | No live owner; outcome is unconfirmed and never expires into a retry. |
| `fulfilled` | `fulfilled` | timestamp | Terminal success, replayable until expiry. |
| `rejected` | `rejected` | timestamp | Terminal contract rejection, replayable until expiry. |

| Event | Prior phase | Next phase | Notes |
|---|---|---|---|
| `action_fulfilled` | `executing` | `fulfilled` | Unaccepted in other phases (late events are no-ops). |
| `action_rejected` | `executing` | `rejected` | Stores `errorCode`. |
| `outcome_lost` | `executing` | `unknown` | Action threw `AidenOperationUnknownOutcomeError` or result could not fit snapshot bounds. |
| `outcome_unrecorded` | `fulfilled`, `rejected` | `unknown` | Durable outcome write failed; disk still holds `in_flight`. |
| `reconciled_fulfilled` | `unknown` | `fulfilled` | Authoritative reconciliation only. |
| `reconciled_rejected` | `unknown` | `rejected` | Authoritative reconciliation only. |

Because both `executing` and `unknown` serialize as `in_flight` with `expiresAt: null`, a process restart turns any in-flight admission into `unknown` without changing the stored format.

### Two durable edges and commit points

1. **Admission write (`in_flight`) before the action runs:** `settleDurably` persists `ledger.snapshot()` before calling `admit()`. If that write fails, the action never runs, the entry is dropped via `AidenOperationNotExecutedError`, and the caller gets `500 internal_error` (`notPreparedMessage`); the key remains reusable.
2. **Outcome write after the action settles:** `settleDurably` persists `ledger.snapshot()` again. If that write fails, `ownership.unrecorded()` transitions the live entry to `unknown` and throws `409 idempotency_in_flight` (`outcomeUnrecordedMessage`). The key never re-runs—even past the normal TTL—until reconciled.
3. **Single-writer joins and replays:** Only the call with `ownership` persists. Concurrent joins and replays wait on the owner's `unfinishedOperations` promise so they answer with the owner's durable result rather than an unpersisted in-memory result.
4. **Pre-effect and receipt-backed retries:** Both `AidenOperationNotExecutedError` (nothing committed) and `AidenOperationReplaySafeRetryError` (the underlying action keeps its own durable exact receipt, used by `main/services/aiden-remote-bot-session.ts`) delete the ledger entry and rethrow `cause`. If saving that deletion fails, the caller still receives `409 idempotency_in_flight` and disk retains the admission.
5. **Peer hosts:** On the desktop peer client (`main/handlers/peer-host-live.ts`, `renderer/lib/hosts/remote-host-adapter.ts`), a host's `409 idempotency_in_flight` (or lost/ambiguous answer) maps to `outcome_unknown`, keeping the send unresolved under its idempotency key rather than retrying blindly.

## Telegram Bot reply outbox (`BOT_REPLY_ROW_TRANSITIONS`)

Owner: `main/services/telegram/bot-reply-outbox.ts`.

Every outbox row moves exclusively through `advanceBotReplyRow` and the `BOT_REPLY_ROW_TRANSITIONS` table; direct `row.state =` writes outside that helper are a bug. An in-memory `delivering` guard serializes delivery attempts per `requestId`.

States: `awaiting`, `pending`, `sending`, `sent`, `interrupted`, `dismissed`, `failed`.

| Event | Valid prior states | Next state | Meaning |
|---|---|---|---|
| `answered` | `awaiting`, `interrupted` | `pending` | Bot answer saved to the row. |
| `turn_interrupted` | `awaiting`, `interrupted` | `interrupted` | Turn paused/interrupted; Resume may still answer. |
| `turn_dismissed` | `awaiting`, `interrupted` | `dismissed` | Person stopped or dismissed the turn (terminal). |
| `send_started` | `pending` | `sending` | First send attempt started; outcome is unknown until confirmed. |
| `redelivery_started` | `sending` | `sending` | Single duplicate-labelled retry (`(may be a duplicate)`). |
| `send_confirmed` | `sending` | `sent` | Telegram delivery confirmed (terminal). |
| `send_abandoned` | `pending`, `sending` | `failed` | Retries exhausted or target gone (terminal). |

Events that do not match the row's current state return `undefined` and leave the row untouched, preventing a stale lock copy from repeating a finished send.

## Phone Bot outbox failure steps

Shared fixture: `protocol/aiden-remote/v1/fixtures/bot-outbox-delivery.json` (`maxConnectionAttempts: 3`). Implementations: `aidenBotOutboxFailureStep` in `ios/AidenOnTheGo/Features/Bots/AidenBotSessionModel.swift` and `android/app/src/main/java/sbtbiswas/AidenOnTheGo/features/bots/AidenBotSessionController.kt`.

### Failure classification

- **Ambiguous (`ambiguous: true`):** `500 internal_error`, `503 internal_error`, `408 internal_error`, `429 rate_limited`, `409 idempotency_in_flight`.
- **Definite refusal (`ambiguous: false`):** `409 idempotency_conflict`, `409 internal_error` (replayed settled rejection), `400 invalid_request`.

### Next step (`aidenBotOutboxFailureStep`)

| Condition | Step |
|---|---|
| Definite refusal with lost uploads (iOS only) | `refused_attachments_gone` |
| Any other definite refusal (with or without echo) | `refused` |
| Ambiguous, `attempts < 2` | `retry_later` |
| Ambiguous, `attempts >= 2`, untagged echo present (`echoed && !echoNamesSubmission`) | `settled_by_echo` |
| Ambiguous, `attempts >= 2`, no echo or echo belongs to another submission | `out_of_tries` |

## Subagent file mutation transaction (`TransactionPhase`)

Owners: `native/subagent-file-mutator/main.c` (`enum TransactionPhase`) and `main/services/subagents/subagent-file-mutation-transaction.ts` (`commitSubagentFileMutation`). Behavioral oracle: `main/services/subagents/subagent-file-mutation-transaction.test.ts`.

### Native phases (`enum TransactionPhase`)

`PHASE_IDLE` → `PHASE_INSPECTED` → `PHASE_PREPARED` → `PHASE_COMMITTED` (plus `PHASE_IDLE` → `PHASE_PREPARED` without prior inspect, and `PHASE_INSPECTED | PHASE_PREPARED` → `PHASE_IDLE` on cancel or pre-publish refusal).

- **Point of no return:** `PHASE_COMMITTED` begins at namespace publication (the atomic rename), before parent `fsync` or recovery-file cleanup. `recovery_unlinked` and `commit_parent_synced` track durability independently. An indeterminate commit stays `PHASE_COMMITTED` so the recovery file is never treated as disposable.
- Changing `native/subagent-file-mutator/main.c` requires refreshing prebuilt binaries for all three targets.

### TypeScript settlement (`commitSubagentFileMutation`)

| Outcome | Meaning |
|---|---|
| `not_committed` | Commit threw while helper state was neither `committed` nor `indeterminate`; original file intact. |
| `unknown` | Commit threw while helper state was `committed` or `indeterminate`; recovery preserved if possible. |
| `committed` | Published and recovery file unlinked (or no recovery file needed). |
| `recovery_kept` | Published; `finalize` failed, `preserve` succeeded. |
| `cleanup_unknown` | Published; both `finalize` and `preserve` failed. |

## Managed worktree removal journal

Owner: `main/services/managed-worktree-removal-core.ts` (`managedWorktreeRemovalPhaseAllowed`, `removeManagedWorkspace`). Behavioral oracle: `main/services/managed-worktree-removal-core.test.ts`.

Ordered phases:

```text
prepared → quarantined → checkout_cleanup_started → checkout_complete → admin_cleanup_started → filesystem_complete
```

`managedWorktreeRemovalPhaseAllowed(from, to)` permits only:
1. One step forward in `REMOVAL_PHASE_ORDER`,
2. A same-phase write (`from === to`) to record a manifest digest, or
3. A transition to `needs_review` from any phase.

Nothing leaves `needs_review`: once preserved for human inspection, no recovery path may walk it back into deletion. All 19 journal writers in `git.ts` were traced against this rule. `removeManagedWorkspace` invokes `onDestructiveBoundary()` whenever `deleteWorktree()` succeeds or throws without `destructiveMutationAttempted === false`, ensuring callers never restore workspace-scoped background work after Git deregistration or quarantine mutation begins.

## Chat deletion settlement

Owner: `main/services/chat-application-service.ts` (`ChatDeletionSettlement`, `chatDeletionSettlement`).

| Settlement | Condition | Meaning |
|---|---|---|
| `completed` | `admissionReleased && chatRemoved` | Chat removed and no tombstone remains. |
| `rolled_back` | `admissionReleased && !chatRemoved` | Delete rolled back before tombstone commitment; chat stays usable. |
| `roll_forward_pending` | `!admissionReleased` | A durable tombstone may remain (or its status could not be read); fences stay closed for startup roll-forward. |

## Deferred P4 owners

The following owners were not changed in this pass and remain deferred:

| Inventory | Owner | Status |
|---|---|---|
| `backend:M026` | Bot deletion | Deferred; unchanged. |
| `backend:M158` | Chat store | Deferred; unchanged. |
| `backend:M159` | Pi session compaction journal | Deferred; unchanged. |
| `backend:M147` | Image storage | Deferred; unchanged. |
