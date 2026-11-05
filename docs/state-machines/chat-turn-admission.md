# ChatTurnAdmission transition worksheet

Inventory: `backend:M006`. Owner: `main/services/chat-turn-admission.ts`. Behavioral oracle: `main/services/chat-turn-admission.test.ts` and `main/services/chat-turn-admission-lifecycle.test.ts`.

One lease covers the critical section between a user message being appended and a generation being registered. It can span awaits, then hands off synchronously.

## Axes

These are independent. Do not fold them into one enum.

| Axis | Values | Meaning |
|---|---|---|
| Authority | `active`, `revoked` | May this turn still start work? Expiry, owner invalidation, chat deletion and `releaseAll` all revoke through the same event. |
| Preparation | `pending`, `settled` | Has admitted async work finished? Revoked work that has not settled still holds the chat and its bytes. |
| Registration | `none`, `registering` | Is `handoff` inside its synchronous callback? |
| Append slot, skill slot | `none`, `lease(bytes)` | Which bytes this lease holds against the process-wide pools. |
| Skill custody (per handoff) | `lease`, `lease_release_requested`, `generation`, `returned`, `released` | Who owes the refund for a skill reservation once handoff starts. |
| Reconciliation fence (per owner) | unset, set | Storage could not say whether an append landed. Separate from every lease. |

## Transitions

Guard failures reject the event and change nothing.

| Event | Source | Guard | Next | Effects |
|---|---|---|---|---|
| Begin | `tryBegin` | Generation idle, no record for the chat, owner not fenced | `active`, `pending`, slots empty | Starts the expiry timer |
| Reserve append | `reserveAppendPayload` | `active`, no append slot, not registering, safe non-negative bytes, pool has room | Append slot `lease(bytes)` | Charges the append pool |
| Reserve skill | `reserveSkillPreparation` | `active`, no skill slot, not registering, pool has room | Skill slot `lease(max)` | Charges the skill pool |
| Prepare skill | `prepareSkillInvocation` | `active`, skill slot held, nothing prepared, not registering, bytes fit | Skill slot shrinks to actual bytes | Refunds the difference |
| Settle | `settleAsyncWork` | Not already settled | `settled` | Refunds the append slot unless retained. Finalizes if revoked. |
| Revoke | `release`, expiry, `releaseMatching`, `releaseChat`, `releaseAll` | `active` | `revoked` | Stops the timer, runs release callbacks. Finalizes if settled and not registering. |
| Begin registration | `handoff` | `active`, `settled`, identity matches, not registering | `registering` | Runs the registration callback |
| Registration succeeded | `handoff` | `registering` | Skill slot moves to the generation, authority `revoked` | Revokes if still active, then finalizes |
| Registration failed | `handoff` | `registering` | `none`; the lease keeps its slots | Finalizes only if revoked meanwhile. Rethrows to the caller. |
| Skill release requested | Generation cleanup | Custody `lease` or `generation` | `lease_release_requested` or `released` | Refunds the skill pool once, only from `generation` |

Finalize removes the record, stops the timer and refunds whatever the lease still holds. It runs exactly when authority is `revoked`, preparation is `settled` and registration is `none`.

## Commit points

- **Reservation:** a successful reserve is the linearization point for a pool charge.
- **Generation ownership:** registration succeeding inside `handoff`. The lease is gone by the time `handoff` returns, with no await between.
- **Physical release:** bytes are refunded when the holder is done: settle for ordinary appends, release for a cached first-send receipt, generation cleanup for a handed-off skill.

Expiry is evidence that authority ended. It is never evidence that the IO finished, so it refunds nothing while preparation is pending. Once preparation has settled, expiry is the real end of the lease and refunds what the lease still holds, such as a cached first-send receipt.

## Stale and rejected events

- Events from a lease whose record is no longer current in the chat's slot are ignored. The turn or owner identity is checked by `owns`, `handoff` and `releaseMatching`.
- `handoff` re-entered while registering returns `false`, so one lease cannot register two generations.
- `release` during registration revokes at once, but finalization waits for the outcome. On success the skill charge moves to the generation, so the refund happens once.
- A registration callback that failed keeps its release function, which is then inert. The lease still owns the charge.

## Persistence and projections

Nothing here is persisted. A restart empties the leases and the fence. `isAdmitted` means a record exists (the chat is occupied); `owns` means `active` and `settled`. `isActive` is `active` only.

## Behavior kept as it was

- A live lease that has settled may reserve again. Those bytes are refunded at finalize.
- The reconciliation fence blocks new leases for an owner. It does not revoke that owner's existing leases on other chats, and it does not block their handoff. Their appends still check it through `assertCurrent`.
- The expiry timer calls the same revoke as `release`. A throwing release callback therefore still surfaces as an uncaught error there.
