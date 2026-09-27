# Queue messages while compaction runs — 2026-09-27

Branch: `feature/queue-while-compacting`. Plan: `docs/plans/queue-while-compacting-plan.md`.

Manual compaction keeps the composer editable and holds queued messages until compaction succeeds. `ChatMessageQueue.holdReason` is the durable per-chat state; the composer must derive its active compaction affordance, status text and Cancel action from the queue snapshot as well as its local start state, because the chat-keyed composer remounts when navigating away and back.

The `/compact` slash token is consumed immediately after the asynchronous command starts. Its completion only reports errors/unavailable actions, allowing the now-clear composer to accept messages into the held queue during compaction. Claim compaction synchronously through a ref and reject starts while the queue-owned hold is active; render state alone cannot fence same-tick calls, and a remounted composer has no local busy state.

Relevant validation: `npm run test:slash-commands`; `npm run type-check:e2e`; focused `chat-message-queue.spec.ts` compaction scenario.

Follow-up review: attachment and skill removal now use `composerInputLocked`, preserving draft editing while manual compaction holds queued sends. The compaction E2E removes a pasted image before navigation while the original command is still pending.
