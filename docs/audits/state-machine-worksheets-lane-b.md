# State-machine transition worksheets: Lane B (authority, then Bot schedules)

Working record for the explicit state-machine migration. It holds the P0 transition worksheets for the owners Lane B converts, and each owner's disposition. Rankings in the migration plan are architectural, so nothing here is a defect unless it says it was reproduced.

Dispositions:

- **Converted:** transitions moved into a typed function or phase, behavior preserved.
- **Retained:** already centralized. Adapter or baseline work only.
- **Deferred:** left alone, with the reason.

## P2a: Bot and subagent authority

### `backend:M107` subagent run grant (`SubagentRunGrantV2`) — converted

One decision per child run and privileged lane, in memory only, never persisted.

| Event | Prior phase | Guard | Next phase | Effect |
|---|---|---|---|---|
| construct, Full | none | effective permission is Full | `granted` | none |
| construct, otherwise | none | | `unrequested` | none |
| `ensure` first call | `unrequested` | Ask, signal live, permission and authority digest match, unexpired | `requesting` | One approval card |
| `ensure` while asking | `requesting` | same | `requesting` | Joins the same answer |
| answer allow | `requesting` | run signal not aborted | `granted` | none |
| answer deny, throw, or allow after abort | `requesting` | | `denied` | none |
| `revoke` | any live phase | | `revoked` | Late answer is ignored |
| any event | `denied`, `revoked` | | unchanged | Terminal |

Commit point: the phase changes when the answer returns, but no effect is authorized by the grant alone. Every effect still needs an exact ledger approval. `valid()` also rechecks signal, expiry, permission and digest on each use, so drift closes the grant without changing its phase.

### `backend:M107` subagent approval ledger (`SubagentApprovalLedgerV2`) — retained

`prepare → authorized → consumed`, with `deny`, `cancelRun` and expiry removing the entry. Removal is the terminal state: the ledger keeps no tombstones and stays bounded at 128 entries. The `authorized` flag, the identity binding and the one-entry-per-`(run, toolCallId)` set already live in one class.

**`consume` is the linearization point for child writes and shell.** The brokers read `currentAuthority` before awaited workspace checks, and that read goes stale during the await. It stays safe because each production revocation pairs `revokeAuthority` with `approvals.cancelRun` synchronously, so `consume` fails right before the effect. Expiry is covered by the same `consume`, since the approval deadline never exceeds the authority deadline. Any new revocation path must keep that pairing. The new tests in `subagent-workspace-write.test.ts` and `subagent-shell.test.ts` hold revocation inside those awaits.

Consuming an approval frees the `(run, toolCallId)` slot, so a repeat call can prepare again. That needs a new approval, so it does not extend authority. Current behavior, kept.

### Subagent write and shell authority guards — retained

`subagent-workspace-write.ts` and `subagent-shell.ts` compose the ledger, run grant, workspace revision, root pin and operation registry. The sequence is: admit, prepare, ask, re-read authority and workspace, authorize, then at execute re-read, consume and dispatch.

- Stop aborts the run signal before revoking approvals (`subagent-control-v2.ts`). A stop that lands while dispatch is being journaled reaches the shell helper as an aborted signal, and the helper refuses to spawn on one.
- A consumed approval is gone even when the effect fails, so a failed write cannot be retried under it.
- `shutdown` revokes the run grant first, so a late answer cannot authorize anything.

The file transaction in this owner belongs to P4a (Lane C). PR #687 adds a protected-path check in the same function, away from these guards.

### `backend:M036` Bot capability and inventory leases — retained

`BotCapabilityLeaseRegistry` and `BotRuntimeInventoryLeaseRegistry` already centralize every transition in one small class each. A lease is `active`, then `invalidated` (aborted, by epoch, generation, audience or inventory change) or `released`.

| Event | Guard | Effect |
|---|---|---|
| `acquire` | epoch not older than published; a newer epoch publishes first | New active lease |
| `invalidateBot`, `invalidateChat`, `invalidateAudience` | | Generation moves before abort, so a lease taken in an abort listener is closed too |
| `publishBotEpoch`, `publishChatEpoch` | rollback throws; same epoch is a no-op | Aborts matching leases |
| `release` | idempotent | Removed. `assertCurrent` fails from then on; the signal does not abort |
| `assertCurrent` | synchronous | The fence immediately before an effect |

`BotRuntimeAuthorityResolver.revalidateBeforeEffect` ends with a synchronous recheck of both leases after its awaited reads. That recheck is the linearization point.

### `backend:M037` capability checkpoint — retained

`bot-capability-state-checkpoint.ts` already models pending and committed heads with fail-closed poisoning. No change.

### `backend:M028` Bot approval wait registry — deferred

PR #730 rewrites `bot-approvals.ts`, and #727 also edits it. Reconcile after those land.
