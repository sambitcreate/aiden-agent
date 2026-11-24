# P5/P6 and Tier-A state-machine reconciliation

Source-verified transition tables, invariants, commit points, and dispositions for the open P6 owners and the deferred / dense Tier-A reading queue on `main`. Nothing here is marked a defect unless reproduced by a behavioral test.

Dispositions follow the existing state-machine worksheets:
- **Retain:** transitions and linearization points are already centralized and guarded; keep authoritative code as-is (extending behavioral race/teardown tests where gaps exist).
- **Deferred:** extraction remains deliberately deferred with an explicit architectural precondition and no defect found.
- **Unresolved inventory ID on `main`:** the legacy inventory ID appears in a lane worksheet, but no master inventory table exists on `main` to map that ID to a file path; live authority owners in the same area are audited directly by path instead.

---

## 1. Open P6 owners

### 1.1 `main/services/schedule-service-core.ts` — Retain

Owns cron job registration (`jobs`), active task execution slots (`runningTasks`), per-task mutation serialization (`lifecycleTails`), workspace blocks (`blockedWorkspaces`), staggered catch-up (`createCatchUpQueue`), and periodic pending-routine-fire recovery (`pendingRecoveryQueued`, `pendingRetryAt`).

#### Axes
- **Service lifecycle:** `stopped` (`started = false`) vs `running` (`started = true`, fenced by monotonic `startupRevision` and `globallyEnabled`).
- **Task slot (`runningTasks`):** absent, `preparing` (`executionStarted = false`), `executing` (`executionStarted = true`), with `cancelRequested` flag and `workspaceReady` barrier.
- **Catch-up queue (`createCatchUpQueue`):** bounded concurrency (`2`), staggered starts (`3 s`), lock-screen deferral (`shouldDefer`), fenced by monotonic `generation` on `clear()`.

#### Transitions

| Event | Guard | Next / Effect |
|---|---|---|
| `start()` | `!started` | Sets `started = true`, bumps `startupRevision`, starts pending-retry timer, schedules enabled tasks under `withTaskLifecycle`, queues pending Bot fire recovery before overdue catch-up. On error while current, resets `started = false` and clears jobs/timers. |
| `dispatch(taskId)` | `runningTasks.get(taskId)` absent, or stale pre-execution automatic entry (`!executionStarted && !isCurrent()`) | Inserts `RunningTask`. Re-checks `expectedUpdatedAt`, `blockedWorkspaces`, `started && globallyEnabled`, `task.enabled` (with exact one-off paused catch-up exception), `isCurrent()`, and due `fireTime` (throwing `UnclaimableScheduledFire` if already claimed or future). |
| `advanceBeforeRun` | Automatic non-recovery fire | For Bot routines: `store.claimRoutineFire` (optionally running `claimRoutineExecution` write-ahead before publishing the pending fire). For one-off chat tasks: disables task atomically. Marks `state.executionStarted = true` before `execution.run`. |
| `save` / `remove` / `pause` / `resume` | Serialized by `withTaskLifecycle(taskId)` + optional `expectedUpdatedAt` | Stops cron job and awaits `cancelAndSettle(taskId)` before durable write. On caller `AbortSignal` after commit (`saveWithRollback` / `pauseWithRollback` / `resume`), rolls back durable state and rearms prior schedule. |
| `cancelWorkspace(workspaceId)` | Synchronous add to `blockedWorkspaces` | Stops matching cron jobs, awaits `workspaceReady` on snapshot of `runningTasks`, cancels and settles matching runs. |
| `stop()` / `stopAndSettle()` | Any | Bumps `startupRevision`, sets `started = false`, stops pending-retry timer, clears catch-up queue (`generation += 1`), stops all crons, sets `cancelRequested = true`, calls `execution.cancelAll()`. `stopAndSettle()` races `cancelAndSettle()` against a 5 s shutdown cap and returns with a warning even if `runningTasks` are still live (stop requested, not a strict settlement fence). |

#### Invariants & commit points
- **Claim linearization:** For Bot routines, `store.claimRoutineFire` publishes the pending fire (and optional frozen execution claim) before `executionStarted` flips; a cancelled preparation before that point cannot publish a pending fire.
- **Overlap isolation:** Active runs (`executionStarted = true`) and manual runs are never superseded by automatic triggers; `runEvent` serializes per task by awaiting the active `runningTasks` promise.
- **Oracles:** `main/services/schedule-service-core.test.ts` (`npm run test:scheduled`).

---

### 1.2 `main/services/scheduled-bot-routines.ts` — Retain

Owns `createBotRoutineExecutor` (execution and crash recovery of one Bot routine fire) and strict IPC/CRUD routine management (`parseBotRoutine*`, `projectBotRoutine`).

#### Transitions (one routine fire `run(task, { runId, trigger, signal })`)

| Phase | Guard / Input | Next / Outcome |
|---|---|---|
| Idempotent recovery (`recovering`) | `replayable(trigger)` (`automatic`, `retry`, `event`) and `runId === requestId` | Reads `store.runById(task.id, requestId)`. If a prior durable `ScheduledRun` exists: repairs stale task summary, retries idempotent `deliver`, settles pending fire, and returns `prior` without re-running the Bot. |
| Admission probe | `recovering` with no prior run | Queries `ports.submissionForRequest(task.botId, requestId)`. If `retry` is `observeOnly` with no submission, settles fire and throws `UnclaimableScheduledFire`. If paused/disabled with no submission, records `blocked` without submitting. |
| Execute: claim & state check | Not recovering or no `existingSubmissionId` | Optional write-ahead `ports.claimExecution`; inspects `ports.state(botId)`. `paused` → `skipped(paused_by_person)` (or `RoutineOutcomeUnknown` if an admitted fire exists); `interrupted` without `existingSubmissionId` → `skipped(bot_paused)`; `needs_model` → `RoutineFailure`; `unavailable` → error. |
| Execute: retry safety | `trigger.kind === "retry"` and `!verifiedToolFree` | Verifies every prior attempt via `ports.canRetryRoutineRequest`; fails closed with `retry_effect_unknown` if any prior attempt may have executed tools. |
| Execute: submit & await | `wakeUpAllowed` (for wake-ups) and `!signal.aborted` | Calls `ports.send(..., { requestId, ifNotInterrupted: true })` wrapped in `abortable(..., signal)` (which races cancellation against the promise without aborting an already-started `ports.send()` call). On send failure for `replayable(trigger)`, re-reads `submissionForRequest` — an admitted or unreadable lookup becomes `RoutineOutcomeUnknown` (never a false terminal failure). Awaits `ports.awaitReply`; abort/transport error on `replayable` becomes `RoutineOutcomeUnknown`. |
| Settle & deliver | Outcome resolved or caught | Writes durable `store.recordRun` (with `id: requestId` for durable/catch-up fires, omitting `id` for `duplicate` or `uncertain` so the real fire's ID stays free). Runs advisory `afterRun` (healing/retry/pause) and fire-and-forget `observeRoutineHooks` (`RoutineRun` / `RoutineFailed`). Calls `deliver` unless silent/skipped/retrying; if delivery throws, keeps pending fire receipt so startup retries delivery without re-running. Calls `store.settleRoutineFire` only when `durableFire(trigger) && !outcome.uncertain`. |

#### Invariants & commit points
- **At-most-once submission per fire:** `botRoutineRequestId` is deterministic (`routine:<taskId>:<fireTime>`), reused by catch-ups and crash recovery.
- **Unknown-outcome preservation:** Cancellation or lost reply on a replayable trigger sets `uncertain = true`, records `blocked`, suppresses failure notification/hooks, and leaves `pendingRoutineFires` unsettled for recovery.
- **Oracles:** `main/services/scheduled-bot-routines.test.ts` (`npm run test:scheduled`).

---

### 1.3 `main/services/bot-runtime/bot-session-service.ts` — Retain

Also retained under `backend:M024` in `retained-p1-owners.md`; re-audited here for P6 routine/pause/execution-claim/deletion interactions.

#### Axes
- **Per-Bot serialization:** `serialize = createKeyedQueue()` serializes `send`, `resume`, `dismiss`, `stop`, `stopLinkedWork`, `withdraw`, `compact`, `deleteBot`, `pause`, `unpause`, `submissionForRequest`, `canRetryRoutineRequest`.
- **Durable state (`BotSessionState`):** `unavailable` (profile lock held elsewhere) | `paused` (persisted in `BotPauseStore`, fail-closed on unreadable file) | `running(submissionId)` | `interrupted(submissionId, blocked?)` | `needs_model` | `model_error` | `idle`.
- **Terminal fences:** `deleted` (loaded from durable `bots/pending-deletes.json` at construction before any open) and `shuttingDown` (set synchronously in `shutdown()`, currently checked by `appendEntry` — not by `send()` or `openBot()`, which rely on `BotHarnessHost.shutdown()` rejecting later `host.open()` calls once `shutDown = true`).

#### Transitions

| Command | Guard | Next / Effect |
|---|---|---|
| `initialize()` | `host !== null` | Finishes every Bot in `pending-deletes.json`, sweeps orphan sessions against `knownBotIds()`, reads `interruptedBots()` without starting any scheduler, and publishes their state. |
| `send(botId, input)` | Validates provenance (`routineOrigin`, `peerOrigin`, `botMessage`, no `steer` under `deps.execution`), checks `deleted` (no `shuttingDown` guard; late in-flight sends are fenced only once `host.shutdown()` closes host admission) | Inside `serialize(botId)`: dedupes by `requestId` first (`lookupRequest`); enforces `assertNotPaused`, `peer.assertCurrent()`, `spendingRefusal`, `ifNotInterrupted`, `ifIdle`; claims execution/model (releasing unsubmitted plain claim on refusal); dismisses prior interrupted turn if allowed; writes notices and submits to `pi-durable`. |
| `resume(botId, requestId, options)` | `consumeBotResumeOperation` durable idempotency + `assertNotPaused` | Reconciles `BotExecutionDoc` tasks and unknown-cost approvals (`costConsent` verified via `verifyCostApproval` before `acknowledgeUnknown`), clears `blocked`, calls `harness.resume()`, and publishes state. |
| `dismiss` / `stop` / `withdraw` | Per-Bot queue; `dismiss` checks `assertNotPaused` | `dismiss` dedupes via bounded `answered` map, isolates peer-shared inputs, aborts paused turn, writes `interrupted` notice, calls `onStopped`. `stop` guards `expectedSubmissionId` so a successor turn is spared. `withdraw` aborts only queued (unplaced) submissions. |
| `pause` / `unpause` | `pause` checks `!deleted`; durable write first | `pause` writes `BotPauseStore` before calling `onPaused`, bounds `host.suspend` (tracking timed-out closes in `suspending` + `reopenAfterSuspend`), runs `afterPaused`, and publishes `paused`. `unpause` clears pause under queue, then runs `onUnpaused` outside queue so skipped-routine notices can `appendEntry` without deadlock. |
| `awaitReply(botId, submissionId, signal)` | Never starts a paused scheduler | Checks `inspection.scheduling === "paused"` before `submission.wait`; on wait failure (`replyAfterFailedWait`), `deleted` → `{ kind: "interrupted", settled: true }`, `BotHarnessHostClosedError` (quit) → `{ kind: "interrupted" }`, reopened settled submission → returns committed `settledOutcome`, else `failed`. |
| `appendEntry` | Outside command queue (own SQLite tx) | Re-checks `deleted` and `shuttingDown` both before and after any `effectId` idempotency scan inside `conversation.commit`. |
| `deleteBot(botId)` | `requireHost()` (never deletes while another process holds profile lock) | Adds to `deleted`, persists `pending-deletes.json`, runs `beforeDelete`, `host.destroy(botId)`, sequential idempotent `deleteEffects`, then removes from `pending-deletes.json`. |
| `shutdown()` | Any | Sets `shuttingDown = true`, awaits `host?.shutdown()`. |

- **Oracles:** `main/services/bot-runtime/bot-session-service.test.ts` (`npm run test:bot-runtime`).

---

### 1.4 `main/services/bot-routine-notifications.ts` — Retain

Stateless read-only feed projection (`createBotNotificationFeed`) over `BotDeliveryLog.due(since, now() - 1)`.

- **Cursor invariant:** Upper bound is `now() - 1` so rows committing in the current millisecond are never skipped by the client's next exclusive `since` cursor.
- **Capability & quiet filtering:** Drops `row.quiet === true`, missing Bots (`botName === undefined`), and capability-gated classes (`issue` requires `options.issues`, `access_needed` issues require `options.accessRequests`, `peer_result` requires `options.peers`, `bot_message` requires `options.messaging`). Failed routine rows always substitute `BOT_ROUTINE_FAILED_PREVIEW` rather than leaking raw error text; bodies are redacted through `redactRemoteText`. Caps response at `AIDEN_REMOTE_BOT_ROUTINE_NOTIFICATIONS_MAX` (100) and validates via `parseAidenRemoteBotRoutineNotificationList`.
- **Oracles:** `main/services/bot-routine-notifications.test.ts` (`npm run test:bots`).

---

### 1.5 `main/services/aiden-remote-streams.ts` — Retain

Owns remote chat generation stream journals, SSE replay/backpressure (`openCursorSse`), pending remote approvals and questions, and aggregate persistence budgets.

#### States (`AidenRemoteStreamState`)
- **Live:** `queued`, `running`, `waiting_for_approval`, `reconciling`.
- **Terminal:** `done`, `error`, `cancelled`, `interrupted`.

#### Transitions

| Event | Guard | Next State / Effect |
|---|---|---|
| `create(deviceId, streamId, chatId, turnId)` | Unique `streamId`, `streams.size < 256` (after `prune()`) | Creates `StreamRecord` in `queued`, mints `RemoteChatGenerationOwnerController`, records durable `turnIndex`, appends immediate-persist `status(queued)` event. |
| `append` (content/delta) | `!terminal(stream.state)` | Coalesces undelivered deltas within `persistCoalesceMs` (1 s) while `openDelta` matches; structural/boundary events persist immediately, content deltas coalesce. |
| `projectNotification("chat:approval" \| "chat:question")` | Live stream | Arms expiry timer (5 min for devices, 30 min for chat audience), transitions stream to `waiting_for_approval`, persists immediately. |
| `resolveApproval` / `resolveQuestion` | Entry exists in `approvals` / `questions` | Clears expiry timer, removes entry, invokes host coordinator (`approve` / `respondQuestion`). If live: coordinator rejected → `reconciling`; another pending prompt on same stream → re-emits surviving prompt in `waiting_for_approval`; none left → `running`. |
| Terminal `append` (`done`, `error`, `cancelled`, `interrupted`) | Not already terminal | Invalidates `stream.owner`, clears all pending approval/question timers for `streamId`, notifies subscribers & chat listeners, persists immediately. Subsequent `append` calls are no-ops returning the last event. |
| `enforceAggregateBudget` | Snapshot > 16 MiB | Evicts oldest terminal streams with no replay subscriber; marks terminal streams with active replay subscribers `evictAfterDelivery = true` (evicted only when `onClose(finished = true)` confirms complete terminal flush). |
| `revokeDevice(deviceId)` | Any | Denies/cancels all device approvals and questions, cancels live streams (`source: "server"`), invalidates owners, closes all subscribers, deletes streams, and awaits `settlePersistence()`. |

- **Oracles:** `main/services/aiden-remote-streams.test.ts` (`npm run test:aiden-remote`).

---

## 2. Deferred and dense Tier-A reading queue

### 2.1 `backend:M100` — `main/services/subagents/subagent-supervisor-core.ts` — Deferred (audited, behavioral gaps closed)

- **Why previously deferred (`retained-p1-owners.md`):** Cancellation, cleanup, and budget settlement span top-level `execute()` and nested `executeNestedBatch()` paths.
- **Audit findings:**
  - **Ordering & barrier invariants:** Top-level `execute()` validates abort/guidance/tree-expiry/tree-budget/launch-budget, allocates safe IDs, captures fork context (if `fork`), resolves child models (atomic batch refusal if any model is rejected), runs `prepareRun` via `Promise.allSettled`, checks abort/failure before any projection, projects all tasks and awaits `projector.flush()`, then marks `childrenLaunched = true` and registers `stopLiveForGuidance`.
  - **Pre-projection failure cleanup:** Any throw before projection (or abort during `prepareRun`) runs `abortPreparation(reason)` on every fulfilled `PreparedSubagentRun` and never projects or increments `this.launches` (in V2, `this.launches` updates in `finally` from `ledger.snapshot().launched`).
  - **Post-projection failure & cancellation:** `abortExecution(kind, reason)` records first `cancellationKind`, aborts `executionController`, cancels `treeScheduler`, and arms `settlementTimer` (`cancellationGraceMs`) to resolve `settlementSeal`. Each task races `childOperation` against `settlementSeal`; a sealed child records a cleanup failure (`healthMetrics.cleanupFailed()`). `preparedRun.complete(result)` returns `"stopped"` to fence late settlement from overwriting a canonical stop; `finishRun` dedupes `SubagentStop` hooks (`stoppedRuns`) and non-interrupted terminal health metrics (`terminalHealthRuns`).
  - **Nested path (`executeNestedBatch`):** Revalidates depth-1 delegation authority, checks remaining generation-wide turn/network-operation allowance, reserves descendants synchronously via `lease.runDescendants` behind a `startBarrier`, extends ledger allowance, projects + flushes, then releases `startBarrier`. On flush failure, `rejectStart(reason)` + `input.abortTree(reason)` + `Promise.allSettled([nestedExecution])`, then outer `catch` completes projected runs and aborts unprojected preparations.
  - **Disposition:** Keep **Deferred** for structural extraction (splitting `SubagentSupervisor` into a pure transition reducer requires refactoring both `execute` and `executeNestedBatch` across 1,852 lines with no reproduced ordering bug; P5a process settlement is now landed). Added targeted behavioral tests in `main/services/subagents/subagent-supervisor.test.ts` for abort-during-`prepareRun` cleanup and nested `projector.flush()` failure teardown.

### 2.2 `backend:M163` — `main/services/config-store-core.ts` — Retain

- **Axes:** Split-layout migration gate (`seedPromise`, single-flight), secret migration state (`secretMigrationComplete` / `secretMigrationDeferred` / `secretMigrationPromise`), corrupt/unsafe file guards (`loadedFromCorruptFile`, `loadedFromUnsafeFile`, `normalizePortableConfig`), and session-seeded monotonic TTS settings revision.
- **Transitions & invariants:**
  - `ensureSeeded()` runs `configStores.ensureMigrated()`, refuses to write if local or portable files are corrupt/unsafe, runs `migratePiProviderConfig` over a composite draft (portable intent + cached model metadata), validates the migrated document against `normalizePortableConfig` before publishing, writes `~/.aiden/config.json` only on real diff (preserving hand-edited JSON), remaps provider-keyed local settings (`lastProviderId`, hidden models, Model Pad, thinking, compaction overrides), and captures `secretMigrationAliases`/`secretMigrationTargets`.
  - `attemptSecretMigration()` runs once per process; unresolved future-version records set `secretMigrationDeferred = true` and log once without clobbering; thrown keychain errors clear `secretMigrationPromise` so the next read can retry.
  - `ensureWebSearchSettings()` and `ensureApprovalModeSettings()` are one-shot local JSON backfills that bail out on corrupt files or existing markers without overwriting unsupported future values.
- **Oracles:** `main/services/config-store-core.test.ts`, `main/services/portable-config-core.test.ts`, `npm run test:config-recovery`.

### 2.3 `backend:M166` — Analytics consent (`main/services/analytics/analytics-consent.ts`, `analytics-service.ts`) — Retain

- **Why previously deferred:** Lane B deferred while PRs #732–#734 were modifying analytics. Those changes have landed on `main`.
- **Pure consent rules (`analytics-consent.ts`):** `analyticsSendStatus` requires all four gates: `!envDisablesAnalytics(env)` (`DO_NOT_TRACK` / `AIDEN_ANALYTICS=0`), `state.enabled === true`, `hasKey === true`, and `state.noticeShownAt` set. `disableAnalytics` strips `installId`; `enableAnalytics` never reuses an old `installId` (`ensureInstallId` mints a fresh UUID v4 only when sending activates).
- **Service lifecycle (`analytics-service.ts`):**
  - Consent mutations (`setEnabled`, `markNoticeShown`) and `onboardingFinished` serialize through `consentQueue` (`inOrder`). `changeConsent` synchronously bumps `actionEpoch`, drops `heldUntilStarted`, and increments `pendingConsentChanges` before awaiting storage so concurrent feature events or delayed `actionReporter()` callbacks are dropped immediately.
  - `activate()` fences async `store.update` + `createTransport()` with monotonic `generation`; if `stop()` or `cancelStartup()` bumped `generation` mid-activation, the newly created transport is discarded via `created.discard()`.
  - `turnOff()` captures at most one `analytics_disabled` message via `sendNow`, calls `stop()` synchronously (`revokeQueue()`, clears timer/core/installId, notifies renderer `onSendingChanged(false)`), persists `enabled: false` (restoring via `activateIfAllowed()` if `isCurrent()` lost ownership), deletes any pending crash file, sends `captureOptOut` bounded to `1.5 s`, and always calls `stopping.discard()`.
  - `shutdown(timeoutMs = 1_500)` sets `shutdownRequested = true`, bumps `actionEpoch`, drains `consentQueue` + up to `timeoutMs / 3` of startup, cancels startup, stops the hourly timer, and flushes `transport.shutdown` + `crashSends` within `timeoutMs + 250 ms`.
- **Oracles:** `npm run test:analytics`.

### 2.4 `backend:M026` & `main/services/bot-application-service.ts` — Bot deletion and lifecycle journal — Retain

- **Two-layer crash-safe roll-forward:**
  1. `bot-session-service.ts` (`deleteBot`): verifies profile lock ownership (`requireHost()`), adds `botId` to in-memory `deleted`, durably records `botId` in `bots/pending-deletes.json` before its first destructive step, runs `beforeDelete`, `host.destroy(botId)`, then sequential idempotent `deleteEffects`, and removes `botId` from `pending-deletes.json`. On crash, `initialize()` replays every pending delete before exposing any Bot.
  2. `bot-application-service.ts` (`finishDeleteBot`, backed by `bot-lifecycle-journal-core.ts` `M035`): under `mutationGate.run(botId)`, begins or resumes a `delete_bot` journal entry (`prepared → identity_deleted`). Invalidates Bot authority, deletes photo, approval rules (best-effort), browser profile, managed home, capability authority, all Bot chat rows (via `deleteChatWithEffects`), and finally deletes the Bot record last (`botStore.delete(botId)`) before advancing to `identity_deleted` and completing the journal. Keeping the Bot record last guarantees a crash leaves the Bot visible to startup recovery and rolls forward cleanly.
- **Other `bot-application-service.ts` mutations:** `create_bot`, `create_chat`, `copy_chat`, `delete_chat`, `update_model` all follow strict forward stage tables (`STAGES`) in `bot-lifecycle-journal-core.ts`, retry inventory-lease races up to 3 times (`withFreshInventoryLease`), and poison mutations (`recoveryFailure`) if startup recovery cannot complete an interrupted operation.
- **Oracles:** `main/services/bot-application-service.test.ts`, `main/services/bot-runtime/bot-delete.test.ts`, `main/services/bot-lifecycle-journal-core.test.ts` (`npm run test:bots`, `npm run test:bot-runtime`).

### 2.5 `backend:M158` — Chat store (`main/services/chat-store-core.ts`) — Retain

- **Concurrency & durability model:**
  - Per-chat locks (`withLocks` sorted lexicographically for deadlock-free multi-chat ops) + dedicated `INDEX_LOCK`.
  - Shared vs exclusive maintenance gate (`enterShared` / `runMaintenance`): waits for `activeShared === 0` (`drained()`), retries any `pendingDirectorySync`, sweeps crash-leftover temp files (`removeCrashLeftStages`) on first init, reconciles `.chat-transaction.<id>.pending` records (`reconcileChatTransactions`), and rebuilds/validates the in-memory `index.json` memo. External modifications to `index.json` are detected via stat stamp (`ino:size:mtimeNs:ctimeNs`) and invalidate `memo`.
  - Corrupt chat payloads under `"owner"` / `"exclusive"` policies are quarantined verbatim (`*.corrupt`) rather than silently truncated; `"pure"` reads never write.
- **Oracles:** `main/services/chat-store-core.test.ts`, `main/services/chat-append-commit.test.ts`, `main/services/chat-fork-service.test.ts` (`npm run test:slash-commands`).

### 2.6 `backend:M159` — Pi journal & compaction (`main/services/pi-compaction-core.ts`, `pi-session-port.ts`, `pi-session-migration.ts`) — Retain

- **Journal write contract (`pi-session-port.ts`):** Every structural mutation (`appendCompaction`, `appendBranchSummary`, `appendCustomEntry`, `appendMessage`, `importBranch`, `moveTo`) runs inside a single `session.mutate` transaction reading and updating `branchTip("main")` atomically (no torn tip/entry writes).
- **Compaction transitions (`pi-compaction-core.ts`):** Explicit `PiCompactionEvent` (`start` / `end`) and `PiCompactionCheckResult` failure codes (`context-overflow`, `retry-exhausted`, `compaction-failed`, `host-inference`, `host-policy`, `session-failed`, `unsafe-rollback`). Cached-prefix summaries require exact branch/context/memory hash match (`prefixContinuesContext`), verify no forgotten memory fact was restated (`MemoryFactInSummaryError`), and fall back or abort cleanly on `AbortSignal` (`CompactionAbortedError`).
- **Oracles:** `main/services/pi-compaction-core.test.ts`, `main/services/pi-session-port.test.ts`, `main/services/pi-session-migration.test.ts`, `main/services/pi-journal-fork.test.ts` (`npm run test:compaction`).

### 2.7 `backend:M147` — Image storage (`main/services/display-image-artifact-store.ts`, `chat-image-store.ts`) — Retain

- **`DisplayImageArtifactStore`:** Backed by `DataStore` with strict schema validation (`rejectCorruptWrite`, `rejectUnsafeWrite`), 100-record and byte/pixel caps. `initialize()` quarantines unreadable/unsafe staging files (`*.invalid-*`) and opens a clean store, or sets `unavailableReason` (blocking chat mutations fail-closed). `stage()` is idempotent on identical payload and rejects conflicting ID reuse; `recover()` replays staged display artifacts into interrupted assistant messages on startup.
- **`ChatImageStore` (`chat-image-store.ts`):** Content-addressed `chats/images/<2-hex>/<sha256>` files published via exclusive atomic write + `syncFile` + `syncDirectory` before any chat references the hash. Per-hash `putQueues`, `putsInFlight`, and `removals` prevent `put` and `sweep` from crossing on the same hash; `sweep` enforces a 24 h grace window + `isProtected` check before unlinking unreferenced images.
- **Oracles:** `main/services/display-image-artifact-store.test.ts`, `main/services/chat-image-storage.test.ts` (`npm run test:display-image`, `npm run test:transcript-images`).

### 2.8 `clients:C03` — `renderer/main/chat-pane.tsx` — Deferred

- **Current shape:** 4,961 lines with 132 React hook/state/ref/effect sites (`useState`/`useRef`/`useReducer`/`useEffect`), acting as the renderer adapter over main-owned turn admission (`M006`), generation settlement (`M005`/`M177`), approval/question coordinators (`M019`/`M020`), and queued message delivery (`C02`).
- **Disposition:** Keep **Deferred**. It holds no durable authority of its own (the host decides admission, queues, and terminal settlement). Splitting it safely requires a dedicated React component interaction harness rather than unit-only extraction.

### 2.9 `main/services/git.ts` `VerifiedRepoIdentityProof` & `main/services/git-executable.ts` — Retain

Gates the 0-spawn pure-FS `managedWorktreeUsable` fast path in `GitService`:

| Phase | Guard / Check | Failure Behavior |
|---|---|---|
| Binary resolution (`git-executable.ts`) | Absolute `PATH` entries only (never cwd/relative); on macOS resolves `/usr/bin/git` shim via `xcode-select --print-path` or CLT fallback; memoized per `(binary/directPath, PATH, DEVELOPER_DIR)` for 5 min with per-hit `executablePath` revalidation; failures never cached. | Throws `"Git is not installed or unavailable"` or falls back to fresh resolution on path/symlink change. |
| Proof minting (`pureFsAdmissionProof`) | Rejects if `GIT_EXEC_PATH`, `LD_PRELOAD`, or `DYLD_INSERT_LIBRARIES` is set; requires `freshExecutable === memoizedExecutable`; requires trusted OS-managed install path (`isTrustedDirectGitInstallPath`), native Mach-O/ELF binary (`isNativeExecutableBinary`), Linux root-owned non-writable ancestor chain (`isRootOwnedNonWritableChain`), macOS Apple `com.apple.git` codesign verification, direct `--exec-path` match, and bounded no-follow config reads with zero `[include]` / `[includeIf]` directives. Re-hashes repo/config/exec signatures before and after reads (`beforeSig === afterSig`, `execBefore === execAfter`). | Returns `undefined` → `verifyAdmissionRepository` evicts cached proof and fails closed to Git-backed discovery. |
| Proof reuse (`isVerifiedRepoIdentityCurrent`) | Re-checks dangerous env vars, `systemConfigEnvKey`, exact ordered `allPaths`, `repositorySignature(paths)`, and `executableIdentitySignature`. | Returns `false` → falls back to full `verifyAdmissionRepository` (Git spawn). |

- **Oracles:** `main/services/git-executable.test.ts`, `main/services/git.test.ts` (extended with `VerifiedRepoIdentityProof` behavioral edge cases).

### 2.10 Bot allow-list, access authorization, and approval tallies — Retain

- **`main/services/bot-runtime/bot-allow-list.ts`:** Coordinates `ToolApprovalRuleBook` (`grantBot`/`botGrantOperation`/`botConsentRevision`), `BotApprovalTallies`, and `BotApprovals`. In `settle()`, an `allow_always` decision records its publication context and checks `botGrantOperation` first so replays reconcile history without re-granting; new publications pass `expectedConsentRevision` and `validatePublication` to `grantBot`, check for post-grant revocation (`revoked` vs `published`), complete the tally publication state, and release matching pending approval prompts only while `currentGrant` still holds. `reconcile()` is read-only toward authority (never grants access).
- **`main/services/bot-runtime/bot-access-authorization.ts`:** `createBotAccessAuthorizer` snapshots the prompt, checks durable `folderCommitted` history before live checks (so a retry of a committed `always` returns `{ savedForFuture: true }` without creating a duplicate publication), validates owner signal/deadline/callback, revalidates scoped Custom policy revision via `createBotAccessRevalidator`, checks folder `(root, device, inode, inventoryRevision)`, publishes durable folder grant (`grantFolder`) with `operationId: prompt.waitId`, then revalidates at the exact returned publication revision before granting temporary `BotRunAccess`. If post-publication checks fail on `always`, acknowledges `{ savedForFuture: true }` without issuing temporary run authority.
- **`main/services/bot-runtime/bot-approval-tallies.ts`:** Per-Bot serialized append-only decision receipt ledger (`approval-tallies.json`, `0600`) with fail-closed tamper/corruption detection (`blocked = true` on unreadable file, missing/mutated previously observed receipts, or illegal publication transitions outside `pending → published | revoked`). `writeJsonAtomic` `beforePublish` re-reads disk bytes to block lost updates.
- **Oracles:** `main/services/bot-runtime/bot-allow-list.test.ts`, `bot-approval-tallies.test.ts`, `bot-access-requests.test.ts` (`npm run test:bot-allowed`, `npm run test:bot-access`).

### 2.11 `main/services/aiden-remote-bot-session.ts` — Retain

- **Projector lifecycle (`BotLiveProjector`):** Single serialized lane (`this.serial`) per Bot; mints a fresh `epoch` per conversation attachment so reopened harnesses always reach phones as a new epoch with monotonic `seq`. Bounded pending frame ring (`MAX_PENDING_FRAMES = 256`) and snapshot byte budget (`SNAPSHOT_BUDGET_BYTES`), 60 s idle timer (`armIdle`) when `subscribers.size === 0`, and idempotent `close()` emitting `{ type: "closed" }`, stopping `QueuedInputClassifier`, and awaiting `stopWatch`.
- **Service teardown & revocation (`AidenRemoteBotSessionService`):** Tracks SSE `CursorSseHandle` sets per `deviceId`. `revokeDevice(deviceId)` removes and closes all handles for that device; `close()` unsubscribes from intents, state changes, access requests, and plans, revokes all active devices, and closes every settled projector.
- **Mutation idempotency:** `send`, `resume`, `dismiss`, `stop`, `pause`, `unpause`, and card responses run through `bots.executeIdempotent`, using `AidenOperationReplaySafeRetryError` where the underlying Bot session holds its own durable `requestId` receipt.
- **Oracles:** `main/services/aiden-remote-bot-session.test.ts` (`npm run test:aiden-remote`).

---

## 3. Lane B's 30 unreviewed deferred IDs

`docs/audits/state-machine-worksheets-lane-b.md` (line 228) listed 30 inventory IDs whose transition review was not done in Lane B's pass:
- **Backend (14):** `M009`, `M010`, `M031`, `M033`, `M076`, `M099`, `M109`, `M110`, `M127`, `M164`, `M171`, `M180`, `M189`, `M197`
- **Clients (16):** `C10`, `C35`, `C50`, `C51`, `C52`, `C56`, `C63`, `C64`, `C67`, `C71`, `C74`, `N10`, `N12`, `N24`, `N26`, `N34`

| ID(s) | Disposition | Basis |
|---|---|---|
| `backend:M009` | **Retained** (resolved) | Already audited and retained in `docs/state-machines/retained-p1-owners.md`: `main/services/renderer-document-owner.ts` and `main/services/chat-generation-owner.ts` (one-way invalidation, listeners removed once). |
| `backend:M010` | **Cross-referenced (Retained authority vocabulary)** | Lane B notes `M010` sits beside `M009` on Lane A's ownership vocabulary (workspace/chat mutation gates in `main/services/chat-workspace-authority.ts`, `workspace-mutation-gate.ts`, `chat-deletion-gate.ts`, all covered by `npm run test:subagents`). |
| `backend:M031`, `M033`, `M076`, `M099`, `M109`, `M110`, `M127`, `M164`, `M171`, `M180`, `M189`, `M197` | **Unresolved inventory ID on `main`** | The master inventory table mapping these 12 IDs to file paths does not exist on `main` (it was never merged from the planning branch). Rather than guessing ID bindings, concrete live authority/consent owners on `main` in the Bot, approval, and remote domains (`bot-allow-list.ts`, `bot-access-authorization.ts`, `bot-approval-tallies.ts`, `bot-application-service.ts`, `aiden-remote-bot-session.ts`, `aiden-remote-streams.ts`, `config-store-core.ts`, `analytics-service.ts`) are audited directly by path in §§1–2 above. |
| `clients:C10`, `C35`, `C50`, `C51`, `C52`, `C56`, `C63`, `C64`, `C67`, `C71`, `C74`, `N10`, `N12`, `N24`, `N26`, `N34` | **Unresolved inventory ID on `main`** | Same as above: no master inventory table exists on `main` to resolve these 16 client/native IDs to concrete files. Client/native approval views stay read-only projections of host authority; native iOS/Android state-machine work is tracked directly by file path in the dedicated client branches/docs. |
