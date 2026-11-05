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

**`consume` is the linearization point for child writes and shell.** The brokers read `currentAuthority` before awaited workspace checks, and that read goes stale during the await. It stays safe because each production revocation pairs `revokeAuthority` with `approvals.cancelRun` synchronously, so `consume` fails right before the effect. Expiry is covered by the same `consume`, since the approval deadline never exceeds the authority deadline. Any new revocation path must keep that pairing.

Shell has one more await after `consume`: journaling dispatch-started. Expiry aborts nothing, so `execute` rechecks authority and the deadline after that await. The new tests in `subagent-workspace-write.test.ts` and `subagent-shell.test.ts` hold revocation inside those awaits.

Consuming an approval frees the `(run, toolCallId)` slot, so a repeat call can prepare again. That needs a new approval, so it does not extend authority. Current behavior, kept.

### Subagent write and shell authority guards — retained

`subagent-workspace-write.ts` and `subagent-shell.ts` compose the ledger, run grant, workspace revision, root pin and operation registry. The sequence is: admit, prepare, ask, re-read authority and workspace, authorize, then at execute re-read, consume and dispatch.

- Stop aborts the run signal before revoking approvals (`subagent-control-v2.ts`).
- A consumed approval is gone even when the effect fails, so a failed write cannot be retried under it.
- `shutdown` revokes the run grant first, so a late answer cannot authorize anything.

The file transaction in this owner belongs to P4a (Lane C). PR #687 adds a protected-path check in the same function, away from these guards.

Fixed defect, found in review and reproduced by test: an approval or authority that expired while dispatch was being journaled still spawned the command. The store cannot cancel a shell effect after dispatch-started, so this refusal is journaled as `unknown`, which is never retried. The record overstates the risk of a command that did not run, but it can't be mistaken for a clean cancellation.

### `backend:M036` Bot capability and inventory leases — retained

`BotCapabilityLeaseRegistry` and `BotRuntimeInventoryLeaseRegistry` already centralize every transition in one small class each. A lease is `active`, then `invalidated` (aborted, by epoch, generation, audience or inventory change) or `released`.

| Event | Guard | Effect |
|---|---|---|
| `acquire` | epoch not older than published; a newer epoch publishes first | New active lease |
| `invalidateBot`, `invalidateChat`, `invalidateAudience` | | Aborts matching leases. Bot and chat invalidation also move the generation first. A matching lease taken in an abort listener is closed too, because the abort loop walks the live `Set` |
| `publishBotEpoch`, `publishChatEpoch` | rollback throws; same epoch is a no-op | Aborts matching leases |
| `release` | idempotent | Removed. `assertCurrent` fails from then on; the signal does not abort |
| `assertCurrent` | synchronous | The fence immediately before an effect |

The inventory registry differs: it snapshots and clears its set before aborting, so a lease taken in an abort listener survives under the new generation. That lease is current, and no production listener re-acquires synchronously.

`BotRuntimeAuthorityResolver.revalidateBeforeEffect` ends with a synchronous recheck of both leases after its awaited reads. That recheck is the linearization point.

### `backend:M037` capability checkpoint — retained

`bot-capability-state-checkpoint.ts` already models pending and committed heads with fail-closed poisoning. No change.

### `backend:M019` tool approval coordinator — converted

Per-prompt lifetime is `admitted → publishing → published → settled`. Per-stream admission is `open`, `cancelled` or `detached`, with `stopped` for the whole coordinator.

| Event | Prior | Guard | Next | Effect |
|---|---|---|---|---|
| `request` | none | not stopped, signal live, stream open | `admitted` | Any older prompt with the same id settles `cancelled` |
| publish starts | `admitted` | rechecked after the listener is attached | `publishing` | Prompt reaches the surface |
| publish returns | `publishing` | | `published` | none |
| publish throws, unsettled | `publishing` | | `settled` (`unavailable`) | No withdrawal |
| settle during publish | `publishing` | | `settled` | Withdrawn once the callback ends, even if it then throws, unless a same-id replacement owns the id |
| `decide`, `decideAsHost` | `published` | owner document matches, or host authority | `settled` | Scope kept only if it was offered |
| abort, `cancelStream`, `detachStream`, `shutdown` | any live phase | | `settled` | Withdrawn if shown |

The first settlement is the linearization point, so the first answer across the desktop, phones and controllers wins. A detached stream cannot override a cancelled one.

Fixed defect, reproduced by test: a prompt settled from inside its own publish callback was shown but never withdrawn, which left its attention row and run projection open.

### `backend:M020` question coordinator — converted

Same prompt phases as the approval coordinator, plus the deadline timer. `respondWithOutcome` treats a passed deadline as a timeout even if the timer has not fired.

Fixed defects, reproduced by test:

- The same publish re-entry as `M019`.
- `shutdown` did not close admission. A question asked afterwards with a live signal was published and never settled, so its turn waited out the shutdown grace period.

`llm-client` does not call `cancelStream` on this coordinator. Stop reaches questions through each request's abort signal, so stream cancellation does not need to close admission here.

### `backend:M190` remembered approval scope — retained

`ToolApprovalRuleBook` keys rules by tool, pattern and workspace. Chat rules are in memory and `always` rules are persisted. The coordinator stores a scope only if it was offered and the answer was allow. No change.

### `backend:M029` Bot question wait registry — retained

`bot-questions.ts` keeps one wait per `waitId`, and its `settle` is gated on prompt identity, so a stale abort cannot end the replacement wait. Baselines are in `bot-questions.test.ts`.

### `backend:M028` Bot approval wait registry — deferred

PR #730 rewrites `bot-approvals.ts`, and #727 also edits it. Reconcile after those land.
