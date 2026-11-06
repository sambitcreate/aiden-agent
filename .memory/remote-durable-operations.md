# Remote durable operations and named state machines (2026-11)

Landed through #746 and its stack (#747-#754). No serialized format, existing API fixture or protocol revision changed; `bot-outbox-delivery.json` is a new fixture that records existing behaviour.

## Idempotency ledger
- `aiden-remote-durable-operation.ts` is the only persist adapter. Six services use it: bots, chats, git, schedules, streams, workspaces. Do not add an inline admission/outcome write.
- Two durable edges: admission `in_flight` before the action, outcome after. Phases are `executing`, `unknown` (both serialize as `in_flight`, `expiresAt: null`), `fulfilled`, `rejected`.
- A failed outcome write leaves `unknown`: 409 `idempotency_in_flight` until reconciled, never a re-run, past the TTL too. Joins and replays answer the owner's durable result, not the ledger's in-memory one.
- `AidenOperationNotExecutedError` and `AidenOperationReplaySafeRetryError` both delete the entry and rethrow the cause. The second is for an action with its own receipt (`aiden-remote-bot-session.ts`). If the save after that fails, the caller gets 409 and the disk keeps the admission.
- Peer hosts: a host's `idempotency_in_flight` counts as `outcome_unknown` on the desktop, so a send stays unresolved under its key.

## Other tables
- Telegram outbox rows move only through `advance()` and `BOT_REPLY_ROW_TRANSITIONS`. New direct `row.state =` writes are a bug. `delivering` serializes attempts per request.
- Phone Bot outbox: `aidenBotOutboxFailureStep` on both platforms, checked against `protocol/aiden-remote/v1/fixtures/bot-outbox-delivery.json`.
- Subagent file mutator: `enum TransactionPhase` in `native/subagent-file-mutator/main.c`; `commitSubagentFileMutation` names the outcomes. Publication is the point of no return. Changing `main.c` needs refreshed prebuilts for all three targets.
- Worktree removal journal: `managedWorktreeRemovalPhaseAllowed` refuses anything but one step forward, a same-phase digest write, or `needs_review`. All 19 writers in `git.ts` were traced against it. Nothing leaves `needs_review`.
- Chat deletion: `ChatDeletionSettlement` is `completed`, `rolled_back` or `roll_forward_pending`.

## Deferred
- `backend:M026` Bot deletion, `backend:M158` chat store, `backend:M159` Pi journal, `backend:M147` image storage were not changed.
