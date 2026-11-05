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

Also fixed, reproduced by test: a publish callback that synchronously re-asks its own id let the first prompt's deferred withdrawal remove the replacement, so a Bot approval left `pending` while it could still be answered. The replacement now owns the id and is withdrawn once, on its own settlement. The older prompt gets no separate withdrawal, because surfaces key prompts by id. Question prompts use random ids and cannot hit this.

Recorded, not changed:

- "Publish throws, unsettled" means never shown, and existing tests require that no withdrawal follows. A surface whose publish shows the prompt and then throws in a later step would break that assumption. `bot-approvals.ts` is the one known case: it stores the waiting entry before calling its own publish, so a throw leaves that entry behind. See `backend:M028`. No desktop path that throws after showing a prompt was established.

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

Open item for that reconciliation: #730's publish callback still sets `waiting` and then calls `options.publish`. If that throws, the coordinator settles `unavailable` without withdrawing, so the `waiting` entry stays. Clear it in that path or set it after publish returns.

## P2b: Remote pairing and single-use capabilities

### `backend:M057` nearby pairing requests — retained

`AidenRemotePairingRequestService` already has one `InternalState` union and a synchronous `approving` claim. `delivered` and `withdrawn` stay independent of it. The linearization points are:

- `respond` setting `approving`, which decides who may act.
- `authorizeCommit` inside the device write, which decides whether a device can exist.
- `stillApproving` after the write and again after sealing, which decide whether the envelope is published.

Every path that loses after commit revokes, and a failed revocation stays in `orphanedDeviceIds` for `close()` to retry.

### `backend:M056` pairing window — retained, one fix

`consumed` is set synchronously before any awaited work, so the secret is burned even if persistence fails. `cancelled` and window identity fence the issue.

Fixed defect, reproduced by test: `authorizeCommit` passes inside the state write, so a window closed or replaced during that write reached the post-await check with a committed device. `exchange` refused the client but left the device record active. No credential escaped, but a device nobody could use stayed in the paired list. `exchange` now revokes it. A failed revocation is swallowed: the client still sees `pairing_closed`, and the record is the same unusable one as before this fix.

### `backend:M142` form-fill batch consent — retained, one fix

`FormFillBatchLedger` has an explicit `pending/authorized/consumed/revoked/expired` status. Expiry was enforced at `authorize` and by `statusOf`, but not at `consume`.

Fixed defect, reproduced at the ledger boundary: an authorized plan could be consumed after its deadline. `consume` now records the expiry, and a clock rollback cannot revive the plan. In the running app authorize and execute are close together, so this needs a slow tool dispatch to matter.

### `backend:M182` Computer Use one-shot grant — retained

`ComputerUseGrantLedger.consume` deletes the grant before validating it, so a rejected attempt also burns it. The fingerprint binds generation, target revision and bound target.

### `backend:M066` file and selection handles — retained

`resolve` and `consumeSelection` are synchronous, so nothing can interleave between the check and the removal. A consumed or wrong-kind handle is an unknown handle. `consumeSelection` spends the handle before its callback runs, so a failed callback fails closed. A save rebinds a handle only to the inode that save installed, and discards it otherwise.

### `backend:M065` Remote attachments — retained

`reserve` holds a record for one send, which then spends or restores it. Revocation removes the record from the map, so a later `restore` changes only a detached object and cannot bring it back.

Chat uploads hold a lease across their awaited lookup. The Bot upload and the fork `stage` do not, so a record can land after its device was revoked or its chat deleted. It cannot be spent, because only that device could send it, and it expires with the attachment TTL. This costs temporary capacity, not authority, so no code changed.

### `backend:M191` Git snapshots, `backend:M067` schedule script claims — retained

Reusable until expiry, bounded, and bound to device and workspace. Code read only, no new tests.

## P2c: provider and MCP auth

No code changed in this slice. The owners already separate the proposed phases, and the required races already have tests.

### `backend:M078` provider auth flow — retained

`session.phase` is `authenticating` or `committing`. The synchronous move to `committing` is the linearization point: abort wins before it, commit wins after it, and `abortSession` is a no-op once committing. `cancel` reports `finishing` rather than a false cancellation. Logout is its own transaction with `logoutInProgress` and `logoutCompletion`, and `shutdown` waits for both. `provider-auth-flow-core.test.ts` covers late credentials, owner loss, timeout cleanup, commit and shutdown.

### `backend:M082` MCP OAuth operation gate — retained

Generations are per server, and an interactive operation also holds `interactive` and its signal. `invalidate`, `cancel` and `suspend` all move the generation, so a stale writer fails `canMutate` however it was started. A background snapshot is not current while an interactive sign-in owns the server.

### `backend:M083` MCP OAuth tokens and commit — retained

Sign-in fills a private `McpOAuthSessionTransaction`, and the old session stays durable until the single commit in `authorizeMcpServerWithRuntime`. Every store write passes the operation's currency check. A failed commit restores the previous session only while the operation is still current.

### `backend:M084` OAuth loopback, `backend:M181` callback consumption — retained

The loopback answers once and closes on every terminal path. The callback state is consumed by the authorization flow, and its tests cover rejection without consumption and issuer binding.

### `backend:M085` MCP admission and cleanup — retained

`createMcpAdmissionQueue` and `McpPendingJournalState` already hold the ordering and the `unknown/empty/pending` state in a pure module.

### `backend:M163` configuration and credential migration — deferred

Not reviewed in this pass. It is a persisted migration, so it overlaps P4d.

## P2d: remaining consent adapters

### `backend:M119` Computer Use access gate — retained, one fix

`grantRevision` and `resetsInProgress` fence cached grants across streams.

Fixed defects, reproduced by test:

- `decide` captured the revision before its awaited status and grant reads and compared later state against that captured value, so a revocation during either read went unnoticed. Turning off Always allow, or starting a reset, while a read was in flight let that one call pass on the stale answer. `decide` now starts again when the revision has moved.
- A revocation after an allow, during the grant save or the readiness recheck, also passed. The allow is now bound to the revision current when it arrived and checked again after those awaits, so the call goes back through the grant read and, if needed, a new card.
- An allow answered after a revocation was cached under the old revision, so a `once` grant lapsed on the next call and the card came back within one response. It is now cached under the answer's revision, because that answer is the person's fresh decision.
- An allow answered during a reset could save a grant that the reset had just cleared. It is now refused.

- The continue marker was cleared only when the current call saw an unready Mac. When setup finished between calls, a later call that passed on the saved grant, was denied or was stopped left the marker behind, and the chat kept offering Continue. The gate now tracks whether it set the marker.

`decide` retries at most three times, then refuses with `COMPUTER_USE_ACCESS_CHANGED_REASON`.

A revocation after an Allow can raise a second card for the same call. That is intended: the revocation is newer than the answer, so the call fails closed and asks again.

### `backend:M123` Bot computer takeover — retained

`takeOver` aborts in-flight actions and `run` refuses while the person holds control. Both happen synchronously, so no await separates the check from the action starting.

### `clients:N38` Android new-chat consent — retained

`AidenNewChatLinkConsent` is target-scoped and consumes the approval before suspending. No change.

### Client approval views (`clients:C20`, `clients:N14`, `clients:C33`, `clients:C53`, `clients:N02`) — retained

These stay read-only projections of host authority. Nothing in P2 changed a wire shape, an approval projection or a host expiry, so the mobile suites were not affected and were not run.

### `backend:M166` analytics consent — deferred

PRs #732, #733 and #734 are changing analytics now.

### Not reviewed in this pass — deferred

Transition review was not done for these, and no claim is made about them: `backend:M009`, `M010`, `M031`, `M033`, `M076`, `M099`, `M109`, `M110`, `M127`, `M164`, `M171`, `M180`, `M189`, `M197`, and `clients:C10`, `C35`, `C56`, `C63`, `C64`, `C67`, `C71`, `C74`, `C50`, `C51`, `C52`, `N10`, `N12`, `N24`, `N26`, `N34`.

`backend:M009` and `M010` also sit on Lane A's ownership vocabulary.
