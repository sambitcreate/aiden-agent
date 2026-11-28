# Bot execution and Bot peers

Phase contracts for `main/services/bot-runtime/bot-execution.ts` (390 lines) and `main/services/bot-peers/service.ts` (332 lines).

## Bot execution (`main/services/bot-runtime/bot-execution.ts`)

Owner: `main/services/bot-runtime/bot-execution.ts` (`createBotExecutionRegistry`, `withBotExecutionAdmission`, `createBotBackgroundExecutionModels`, `reconcileBotExecutionResponses`). Behavioral oracle: `main/services/bot-runtime/bot-execution.test.ts`.

### Durable documents

- `BotExecutionDoc` (`aiden.execution-binding`, task-scoped): binds `claimId`, `requestId`, `sourceInputs`, `dispatchGeneration`, `dispatchIds` (max 256), `operations` (`{ key, requestFingerprint }`, max 256), `costConsent`, `costDecision`, and `blocked` (`spending_unknown` | `unavailable`).
- `BotCostReceiptScopeDoc` (conversation-scoped): holds a UUIDv4 `nonce` (`responseScopeId`) initialized before any provider receipt reconciliation or publication.

### Wrapped task phases (`GenerationTask`, `ToolTask`, `CompactionTask`)

Every phase handler (and `abort`) runs inside `invoke`:

| Step                                  | Guard / invariant                                                                                                                                                                                                                                                                                                                             | Failure behavior                                                                                                                                               |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Bind & verify sources              | Reads `BotExecutionDoc` (or `LiveDoc.run.inputs` for `GenerationTask`). `resolveSources` loads 1–64 placed submissions, verifies all share one `claimId`, checks exact `peerOrigin` provenance when `selected.peer` is set (and rejects ambient peer metadata otherwise), and idempotently records `submissionId`. Commits `BotExecutionDoc`. | Throws immediately (no model resolution or dispatch).                                                                                                          |
| 2. Offline response reconciliation    | Initializes/validates `BotCostReceiptScopeDoc.nonce` (`responseScopeId`). Calls `reconcileBotExecutionResponses`: reconciles response costs, then verifies each `aiden.execution.response.<sha256>` memo (`version: 2`) via `port.verifyResponse(facts)` before calling `port.recordKnownResponse`. Does not require live credentials.        | Calls `block(error)`.                                                                                                                                          |
| 3. Resolve runtime & typed fallback   | Runs `port.resolve(botId, claim, runtime.signal)` inside `claimScope`. Fallback (`selectFallback`) is permitted **only** on `BotRoutineModelUnavailableError` when `phase` is `"prepare"` or `"select"`, `claim.fallback` exists, `!claim.startedAt`, and `claim.actual === "primary"`.                                                       | On `abort`, rethrows so the outer `abort` handler settles locally with `getModel: () => undefined` and calls `port.dismissed`. Otherwise calls `block(error)`. |
| 4. Checkpoint & model lock            | If `checkpoint.model` is present, its `provider`, `modelId`, and `thinkingLevel` must match the resolved claim. `executionModels` enforces `exact(model)` on every call so prepared work cannot retarget.                                                                                                                                     | Releases runtime and throws.                                                                                                                                   |
| 5. Execute inside `BotExecutionScope` | Revalidates runtime, prepares optional `registrySnapshot` (skipped on `abort`), checks image-input capability during `GenerationTask:prepare` (blocks with `BotExecutionImageError` unless `inspect_image` companion is offered), runs original handler, and calls `port.dismissed` on `abort` or `settledTerminal`.                          | Releases helper runtimes and main runtime in `finally`.                                                                                                        |

`block(error)` commits `BotExecutionDoc.blocked` (`spending_unknown` when `error instanceof SpendingDispatchError && error.code === "uncertain"`, else `unavailable`), notifies `options.onBlocked`, and waits for `runtime.signal` to abort before throwing.

### Provider receipt verification and deferred terminal guard (`#L129-260`)

- **Request identity & replay (`saved`):** Records `{ key: operationKey, requestFingerprint }` in `BotExecutionDoc.operations` (refusing mismatched request bodies or >256 rows). Checks `runtime.memo(memoKey)`; if present, both `matching(receipt)` and `port.verifyResponse(facts)` must succeed (SQLite memos are untrusted hints). For fresh (non-`previousDispatch`) calls with no exact memo, scans prior generations' verified accountable memos (excluding `deferred`/`pending`) in descending `generation` order and replays the first verified accountable response without re-dispatching.
- **Seal before memo (`remember`):** On a fresh observation (`observed = true`), computes `responseFacts` and calls `execution.sealResponse(facts, amount)` (omitting `amount` for `pending`/`deferred` or unverified cost) before `runtime.memo(memoKey, envelope)` and re-verifying `matching(saved) && verified(memoKey, saved)`.
- **No synthetic zero charge on unverified deferred error/abort (`#L181-191`):** When `previousDispatch` is set (`fetchDeferred`), `stored.stopReason` is `"error"` or `"aborted"`, and `!botExecutionAccountableResponse(stored)`, `remember` checks whether `BotExecutionDoc.costDecision` holds a verified person cost approval (`decision.dispatchId === dispatchId`, matching `BotCostReceiptScopeDoc.nonce`, `toGeneration === fromGeneration + 1`, `dispatchGeneration >= fromGeneration`, and `verifyCostApproval(...)`) or `execution.isDispatchSettled(dispatchId)` is true. If so, it triggers `settledDeferredTerminal()` (which disables retry and compaction on `scoped.settings` and calls `port.dismissed` after the phase ends) and returns `stored` **without calling `execution.afterDispatch`**: the outcome stays an error/abort, no synthetic zero charge is written, and the deferred job is not polled again.
- **Deferred polling (`fetchDeferred` / `cancelDeferred`):** Authenticates the originating `dispatchId` via the in-memory `deferred` map or a verified persisted memo (`originatingDispatch`), calls `reserve()` (protected response slot without opening a second `beforeDispatch` budget reservation), and seals/verifies the poll result.
- **Child task provenance (`scoped.commit`):** Automatically stamps `BotExecutionDoc.sourceInputs` onto newly created `GenerationTask` children from `LiveDoc.run.inputs`, and propagates `claimId`, `requestId`, and `sourceInputs` onto `ToolTask` and `CompactionTask` children.
- **Background execution (`createBotBackgroundExecutionModels`):** Separate model proxy for detached reviews; fixes the admitted model, runs `revalidate → beforeDispatch → revalidate → started → afterDispatch` per sequential `dispatchId`, and rejects `fetchDeferred`/`cancelDeferred`.

## Bot peers (`main/services/bot-peers/service.ts`)

Owner: `main/services/bot-peers/service.ts` (`createBotPeerService`) and `renderer/shared/bot-peers.ts` (wire types and parsers). Behavioral oracle: `main/services/bot-peers/service.test.ts`.

### Serialization and state persistence

All state writes run through one keyed serial queue (`serial = createKeyedSerial()`, key `"state"`). Each mutation loads JSON (`<= 2 MiB`), validates every invariant (`validateState`), checks prospective serialized capacity (`publicationBytes`) before reserving external link slots, and writes via `options.persistence.write(previousBytes, nextBytes, assertCurrent, isCurrent)` with a fresh `state.revision`.

### Exchange, delivery, and stop states

- **Exchange states (`BotPeerExchangeState`):** `waiting`, `queued`, `running`, `interrupted`, `stopping`, `completed`, `failed`, `cancelled`, `expired`, `uncertain`.
- **Delivery / return states (`Delivery.state`):** `reserved → waiting → queued → delivered` (projected as `not_applicable` for `status`/`fyi` returns).
- **Stop receipt states (`BotPeerStopState`, `renderer/shared/bot-peers.ts#L60`):** five states — `requested`, `uncertain`, `stopped`, `not_running`, `blocked` — with optional `reason` (`mixed_inputs`, `host_unavailable`, `stale_source`). `pendingStop(exchange)` is true while `lastStop.state` is `requested` or `uncertain`.

| Stop path                                               | Prior condition                              | `lastStop.state`                 | Exchange transition                                                                                         |
| ------------------------------------------------------- | -------------------------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `stop()` on terminal, `fyi`, or `status`                | Valid revision and new `mutationId`          | `not_running`                    | Unchanged; receipt stored for idempotent replay.                                                            |
| `stop()` on active `request`/`question`                 | Valid revision, no pending stop              | `requested`                      | Cascades `state = "stopping"` across up to 3 hops of unresulted descendants, then invokes `stopProgress()`. |
| `stopProgress()` sees `mixed_inputs`                    | Target shares a live run with other inputs   | `blocked` (`mixed_inputs`)       | `state = "uncertain"`, `blockedReason` set.                                                                 |
| `stopProgress()` sees `uncertain` or active descendants | Stop unconfirmed or child return undelivered | `uncertain` (`host_unavailable`) | `state = "uncertain"`, `blockedReason` set.                                                                 |
| `stopProgress()` sees retired recipient                 | `!recipientPublication`                      | `not_running`                    | `markResult(..., { outcome: "failed" })`.                                                                   |
| `stopProgress()` confirms stop or unadmitted delivery   | `stopped \|\| !row.delivery.submissionId`    | `stopped`                        | `markResult` with `expired` (if past `expiresAt`) or `cancelled`.                                           |
| `stopProgress()` sees nothing running                   | Not stopped, delivery existed                | `not_running`                    | Runs `completeBranch()`; if still unresulted, marks `failed`.                                               |

`stopProgress()` returns early without mutating while `deliveryInFlight.has(id)` so an in-flight admission settles first.

### Passive publication fence (`BotPeerPublication.assertCurrent`)

`publication(expected, valid)` builds a host-only `BotPeerPublication` (`{ botId, incarnation, assertCurrent }`) used by `rowPublication`, `rootPublication`, and `finalPublication`. `assertCurrent()`:

1. Reloads state and verifies `valid(state)` (record exists, not retired, incarnation matches),
2. Checks live `owner(botId).incarnation === frozen.incarnation`,
3. Reloads state a second time and re-verifies `valid(state)` to close any retirement race during the owner check.

Every runtime row, receipt read, link activation, evidence read, and final publication rechecks `assertCurrent()`. `PublicationProof` records (`state.publications`, max 512) preserve passive final-delivery authority across `prune()` until `settleFinalPublication` records `settledAt` (re-openable via `retainFinalPublication`).

### Execution leases (`AbortController`)

`executionLease(binding)` verifies `bindingCurrent(binding)` and creates an `AbortController` indexed in `leases` (`${pairId}:${exchangeId}`) with WeakMaps recording every ancestor `pairId`, `pairGeneration`, `botId`, `rootId`, and `branchId` (up to 4 hops).

- `revalidate()` checks `controller.signal.throwIfAborted()` both before and after `bindingCurrent(binding)`.
- Leases abort synchronously on pair revocation (`revokeLeases`, and `abortStaleLeases` on failed revoke or reconcile), Bot pause/removal (`abortBotLeases`, `forgetBot`), and initiating task/branch stop (`stopSource`).

### Single-flight reconciliation (`reconcile`)

`reconcile()` deduplicates concurrent callers via a shared `pumping` promise and loops up to 4 rounds until `state.revision` stops changing: aborts stale leases, cleans up links, publishes sender/recipient rows, closes stale unresulted exchanges (`closeStale`), advances `stopProgress` or `deliver` + `completeBranch`, delivers terminal returns (`deliver(..., true)`), and runs `finalize(rootId)` once every activating exchange in a root has a terminal result, delivered return, and no pending stop.
