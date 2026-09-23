# Chat composer busy controls audit

Reference: [Hermex Bot Mode contract](https://github.com/uzairansaruzi/hermex/blob/master/docs/agents/bots.md), reviewed on September 23, 2026. Aiden remains on its own Mac execution runtime and Remote API v1.

| Hermex rule or mode | Aiden desktop after this change | Aiden On The Go |
| --- | --- | --- |
| Idle Send, with a busy race that cannot silently interrupt | Ordinary Send uses Aiden's append and turn admission gate. A raced busy append is rejected; the draft is restored for a deliberate choice. | Atomic turn start; a busy admission fails. |
| Steer adds guidance without interrupting | Exact-stream, text-only IPC checks the renderer document owner and uses Pi's steer queue. When Pi emits the queued user input, the Mac saves it to the visible chat before the next model step. The receipt says guidance was queued, not read. | Unavailable; Remote API v1 has no steer command. |
| Queue runs after the current response | Explicit Queue mode uses the existing Mac window's bounded, editable follow-up queue. Selecting the mode does not submit. Its receipt says only that a follow-up was queued. | Unavailable; no client-only queue is synthesized. |
| Redirect interrupts and changes direction | Explicit Redirect mode requires a consequence confirmation, replaces the local pending queue with the new text-only direction, and requests Stop. The replacement runs through the normal append gate after the current response settles. | Unavailable; the phone can cancel, then deliberately start a new turn. |
| Separate Stop clears work and queued prompts, retaining unrelated composer text | Stop cancels the exact current stream and clears local queued follow-ups. The independent composer draft remains. Pending tool approvals are cancelled by the Mac's existing stream cancellation path. | Stream cancel only. |
| Drafts and unknown acknowledgments never auto-retry | Desktop text drafts are device-local across navigation and relaunch. A submission stores an unresolved marker before dispatch; a rejected or uncertain result restores the text. The queue's uncertain append path removes its claimed item and pauses, so it cannot replay automatically. Attachment bytes remain in the live picker and do not survive relaunch. | iOS has a device-local draft store; Android keeps the draft in its view model. Both reconcile turn state rather than resending after connection loss. |
| Receipts describe admission, not model consumption | Queue and Redirect show admission/request copy. The queue editor remains a Mac-local draft manager; it does not claim to edit the Pi runtime's queue. | No busy admission receipts. |

## Remote follow-up

Desktop Steer is currently document-owned and admitted to Pi's in-memory queue. A Mac restart after an accepted receipt but before Pi emits the queued input can drop that guidance. The next slice must add a durable, idempotent Mac-owned admission ledger with exact request IDs, accepted/rejected/unknown recovery, cancellation disposition, and a transcript projection that survives restart. Only then add negotiated Remote commands and SSE receipts; keep iOS and Android as Remote API v1 clients. This work is tracked by [Hermes-inspired Bot run control](plans/hermes-bot-run-control-plan.md).
