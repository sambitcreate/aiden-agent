# Explicit State Machines: 2026-11-23 Refresh & Audit Remediation Plan

Status: **Active — Phases 0, 1, 2, 3, and 4 (4A–4E) implemented in the 2026-11-24 remediation wave; macOS `xcodebuild` Simulator CI, Android `:app:lintDebug`, and physical-hardware acceptance remain open.**
Baseline: `main` HEAD `b2b5c3517` (`0.69.0` release area; `main/`, `renderer/`, and all `ios/` Swift code are byte-identical to `4dec8df04`, with `4dec8df04..b2b5c3517` touching only 7 release/doc files: `package.json`, `package-lock.json`, `docs/plans/README.md`, `docs/release-notes/v0.69.0.md`, and `ios/{APP_STORE_METADATA,ASC_CLI,TESTFLIGHT}.md`).

> **Governing principle** (carried forward from the November 4 migration plan on `origin/feature/explicit-state-machines-plan` at `82c5b3849`):
> Prioritize authority/revocation, irreversible transactions, ambiguous remote outcomes, generation ownership, and native teardown. Migrate one authority or effect boundary per PR. Keep existing authoritative cores; do **not** introduce a generic state-machine framework, replace harmless UI booleans, or change wire formats/persistence schemas unless an explicit bug fix requires it.

---

## 1. Verified Baseline & Audit Corrections (`b2b5c3517`)

Three independent verification passes against `b2b5c3517` established the exact codebase baseline and corrected several drifts from the initial 2026-11-23 refresh notes:

### 1.1 Snapshot, Size & Prior-Lane Status
- **Codebase footprint (non-test production `.ts`/`.tsx`/`.swift`, excluding `.d.ts`)**:
  - `main/`: **1,583 files / 424,835 lines** (`1,560` excluding 23 test-support/fixture/fake helpers).
  - `renderer/`: **1,045 files / 237,840 lines**.
  - `ios/AidenOnTheGo/` + `ios/AidenLiveActivityWidget/`: **177 `.swift` files / 98,398 lines** (`176` excluding `Demo/AidenPreviewFixtureView.swift`).
  - Combined desktop + iOS production total: **2,805 files / 761,073 lines** (versus 2,654 scan rows in `82c5b3849` on 2026-11-04).
- **Delta `9c85bb79b..4dec8df04`**: **167 commits**; **55 added, 0 deleted, 138 modified** non-test production `.ts`/`.tsx`/`.swift` files across desktop + iOS; **58** of the 707 unique paths in `82c5b3849:docs/audits/implicit-state-machine-inventory-2026-11-04.tsv` changed repo-wide (**56** in `main/` + `renderer/` + `ios/`).
- **Prior November migration lanes already landed on `main`**:
  - **P0/P1 (Lane A)**: PRs `#735, #736, #741–#745, #755` landed; worksheets in `docs/state-machines/{chat-turn-admission,generation-run,retained-p1-owners}.md`.
  - **P2 (Lane B)**: PRs `#737–#740` landed; worksheet in `docs/audits/state-machine-worksheets-lane-b.md`.
  - **P3 (`#746–#750`) & P4 (`#751–#754`) (Lane C)**: all landed on `main`, including `aiden-remote-durable-operation.ts`, Telegram outbox transitions, phone Bot outbox fixture (`protocol/aiden-remote/v1/fixtures/bot-outbox-delivery.json`), native subagent file mutator `enum TransactionPhase`, worktree removal journal, and `ChatDeletionSettlement`. Formally documented in `docs/state-machines/remote-durable-operations.md`.
  - **P5 (Lane A)**: PRs `#756, #757, #766, #767, #769` (plus `#768`) landed; worksheet in `docs/state-machines/physical-teardown.md`.
  - **Lane D (`aiden serve`)**: PRs `#758–#765` landed; worksheet in `docs/state-machines/serve-daemon.md`.
  - **P6 (Lane B)**: P6a (`bot-pause-store`, `bot-pause-steps`, `bot-routine-recovery`) reviewed and retained (`lane-b.md#L232-242`); remaining P6 owners reconciled in Phase 4E (`docs/state-machines/p5-p6-tier-a-reconciliation.md` and `docs/state-machines/serve-daemon.md`).

### 1.2 Verified Corrections Incorporated
1. **`Run input transitions` table location**: Lives in `docs/state-machines/retained-p1-owners.md#L52-65` (not `chat-turn-admission.md`); updated for PR #879's `outsideInput()` (`chat-run-input-admission.ts#L303-305`) and `await generation.leadChatInput()` (`#L306-312`).
2. **Webhook slot-release semantics (`main/services/scheduled-task-link-trigger.ts`)**: Known-token disabled `404` (`#L269`) intentionally keeps its 60/min slot (`#L258`), and `429` (`#L261`) rejects before taking a slot (separate `unknown` bucket at 120/min `#L179, #L248-253`). The status codes that call `refuse(taskId, admission)` to release their 60/min slot are **`400`**, **`401`**, **`413`**, and **`415`**.
3. **iOS & Android failure-ambiguity classifiers — 12 iOS sites across two endpoint contracts + verified live `409 idempotency_in_flight` bug**:
   - Host `aiden-remote-router.ts#L3770` and `aiden-remote-durable-operation.ts#L126` throw `409 idempotency_in_flight` when an outcome is unknown after effect commit. Both iOS (`AidenBotOpenWorkModel`, `AidenBotWatchModel`, `AidenBotRoutineModelsModel`, `aidenBotSessionFailureIsAmbiguous`, `aidenBotEditorCreateFailureIsAmbiguous`, etc.) and Android (`AidenBotOpenWorkController.kt#L174`) previously treated `409` as definite and dropped pending idempotency keys.
   - Meanwhile, endpoints backed by `executeAidenDurableOperation`'s 24h cached-rejection ledger (`AidenNewWorktreeRetry`, `AidenChatForkAttempt`, scheduled tasks, git mutations, coordinator mutations) require a distinct tier (`cachedRejectionLedger`) so structured non-in-flight refusals spend the key rather than replaying a cached rejection, while `CancellationError`/`URLError`/`.invalidResponse`/`409 idempotency_in_flight` retain it.
4. **iOS `storageBlocked` pattern — 6 classes across 5 files (plus 5 parallel Android controllers)**: `AidenBotPeersModel.swift` defines two classes (`AidenBotPeersModel` and `AidenBotPeerExchangeModel`), alongside `AidenBotResumeModel.swift`, `AidenBotWatchModel.swift`, `AidenBotRoutineModelsModel.swift`, and `AidenBotOpenWorkModel.swift`.
5. **Symbol, count & path corrections**:
   - `AidenPendingGitMutation` has **5** cases (`commit`, `checkout`, `createBranch`, `push`, `createWorktree`), not 17.
   - `AidenBotCreateOperations+Machine.swift` is paired-computer (`+Machine`) targeting, not a state machine.
   - Densest desktop owners (`wc -l`): `git.ts` 8,921; `llm-client.ts` 7,499; `aiden-remote-router.ts` 5,659; `chat-pane.tsx` 4,961; `pi-agent-runtime-harness.ts` 3,392; `browser/service.ts` 3,241; `aiden-remote-bot-session.ts` 3,157; `telegram-service-core.ts` 2,629; `bot-application-service.ts` 2,282; `ghostty-terminal/surface.ts` 2,212; `subagent-supervisor-core.ts` 1,852; `config-store-core.ts` 1,506; `schedule-service-core.ts` 1,137; `bot-capability-store.ts` 762.
   - `physical-teardown.md` ranges explicitly name `M003`, `M134–M137`, `M002` (pure core), and `cli-native:N13, O01`.
   - `bot-peers/service.ts` (332 lines) has **5** stop receipt states (`requested | uncertain | stopped | not_running | blocked`, `renderer/shared/bot-peers.ts#L60`); `bot-execution.ts` is 390 lines (`#L181-191` no synthetic zero charge); `VerifiedRepoIdentityProof` is `git.ts#L1026-1036` (`isVerifiedRepoIdentityCurrent` `#L1943`); `AidenChatFeature.swift` split across 12 commits (`6182b2e30..a9185707a`) into `ios/AidenOnTheGo/Features/Chat/*`.
   - Path fixes: `main/services/design-canvas/` (not `main/services/design/`); `main/services/bot-runtime/bot-{allow-list,access-authorization,approval-tallies}.ts`.

---

## 2. Recorded Decisions (D1–D7)

| ID | Decision | Resolution Applied |
|---|---|---|
| **D1** | Phase 0 inventory home | **Option A:** Import `docs/audits/implicit-state-machine-{inventory,risk-ranking}-2026-11-04.tsv` verbatim from `82c5b3849` + create canonical [`docs/state-machines/README.md`](../state-machines/README.md) reconciling all 372 IDs and post-Nov-4 owners + `docs/state-machines/remote-durable-operations.md`. |
| **D2** | Phase 1A subagent progression API | **Option A:** Single `subagentRunStateProgresses(current, next, { allowStopped?: boolean })` (plus `subagentRunSnapshotProgresses`, `sameSubagentRunSnapshotIdentity`, `isSubagentRunStateTerminal`) in `renderer/shared/subagent-runs.ts`, preserving `allowStopped: false` in `subagent-control-v2.ts`. |
| **D3** | Phase 1B failure-ambiguity policy | **Option A:** Two-tier endpoint contract (`beforeEffectRefusal` vs `cachedRejectionLedger`) in `AidenRemoteFailureClassification.{swift,kt}`, backed by shared fixture `protocol/aiden-remote/v1/fixtures/mutation-failure-ambiguity.json` (no Remote protocol revision bump). |
| **D4** | Phase 1C `bot-execution.ts` & `bot-peers/service.ts` | **Option A:** Land transition worksheets (`docs/state-machines/bot-execution-and-peers.md`) first; keep security-critical receipt code untouched unless a test reproduces a defect. |
| **D5** | Phase 2A Android parity scope | **Option B (executed):** Unified classifiers + extracted `AidenDurablePendingMutation` on both iOS and Android alongside fixing two `STORAGE`-masking defects in Android `OpenWork` and `Peers`. |
| **D6** | Phase 4B `AidenChatViewModel` first slice | **Option A (planned):** Start with `AidenForeignRunObserver` (`AidenChatViewModel+ForeignRuns.swift`), then `AidenPendingSendCoordinator`, then `AidenChatMutationSubMachines`. |
| **D7** | Phase 4D/4E backlog depth | **Option A (risk-gated):** Fix `aiden serve stop` MCP survivor gap, execute cross-lane P1–P4 shutdown trace, reconcile P5/P6/Tier-A owners via transition worksheets + targeted race/teardown tests, fixing only reproduced defects. |

---

## 3. Phase Status & Deliverables

| Phase | Scope | Status (2026-11-24) | Primary Artifacts / Verification |
|---|---|---|---|
| **Phase 0** (`0A`, `0B`) | Import Nov-4 TSVs, canonical `docs/state-machines/README.md`, `remote-durable-operations.md`, `retained-p1-owners.md` / `physical-teardown.md` / `lane-b.md` corrections, close `backend:M028` (`bot-approvals.ts` 3 ordering fixes + behavioral tests) | **Implemented** | `docs/state-machines/{README,remote-durable-operations,retained-p1-owners,physical-teardown}.md`, `docs/audits/implicit-state-machine-*-2026-11-04.tsv`, `main/services/bot-runtime/bot-approvals.{ts,test.ts}` |
| **Phase 1** (`1A`, `1B`, `1C`) | Unify 4 subagent progression copies (`renderer/shared/subagent-runs.ts`); two-tier `AidenRemoteFailureClassification` on iOS (12 sites) & Android + `mutation-failure-ambiguity.json` fixture fixing `409 idempotency_in_flight`; `bot-execution-and-peers.md` | **Implemented** (iOS `xcodebuild` simulator check pending macOS host) | `renderer/shared/subagent-runs.ts`, `protocol/aiden-remote/v1/fixtures/mutation-failure-ambiguity.json`, `AidenRemoteFailureClassification.{swift,kt}`, `docs/state-machines/bot-execution-and-peers.md` |
| **Phase 2** (`2A`, `2B`) | Shared `AidenDurablePendingMutation` across 5 iOS Bot files (6 classes) & Android parity + direct unit tests (`AidenDurablePendingMutationTests`, `AidenBotResumeModelTests`, `AidenScheduledTasksModel`, `ComposerVoiceInputController`) | **Implemented** (iOS `xcodebuild` simulator check pending macOS host) | `ios/AidenOnTheGo/Features/Bots/AidenDurablePendingMutation.swift`, `android/.../AidenDurablePendingMutation.kt`, mobile test suites |
| **Phase 3** (`3A`, `3B`) | Proactive Aiden (`proactive-aiden.md`, 2 `goal-loop.ts` race fixes); Phase 3B desktop owners (`new-desktop-owners-2026-11.md`, `use-design-canvas.ts` sync races, `provider.ts` close-during-`enabled()` fixes, `hook-dispatcher.ts` idempotency eviction-identity fix, `aiden-mcp-tools`/`bot-plans`/`bot-messages` teardown tests) | **Implemented** | `docs/state-machines/{proactive-aiden,new-desktop-owners-2026-11}.md`, `main/services/goal/goal-loop.ts`, `main/services/gemini-live/app-control/provider.ts`, `main/services/hooks/hook-dispatcher.ts`, `renderer/design/use-design-canvas.ts` |
| **Phase 4A–4C** (iOS dense owners) | Explicit `AidenHostConnectionLifecycle` (`AidenHostConnection.swift`), incremental `AidenChatViewModel` extractions (`AidenForeignRunObserver`, `AidenPendingSendCoordinator`, `AidenChatMutationSubMachines`), explicit `ComposerVoiceInputReducer` + simulator tests | **Implemented** (macOS `xcodebuild` Simulator CI & physical-device mic acceptance pending) | `ios/AidenOnTheGo/Features/Remote/Hosts/AidenHostConnectionLifecycle.swift`, `ios/AidenOnTheGo/Features/Chat/{AidenForeignRunObserver,AidenPendingSendCoordinator,AidenChatMutationSubMachines,ComposerVoiceInputController}.swift` |
| **Phase 4D–4E** (P5, P6, CLI, Tier-A) | Fix `aiden serve stop` orphaned MCP survivor (`packages/cli/src/serve-lifecycle.ts` `selectDaemonMcpGroups`), review `cli-native:N13, O01, C12, C16, C28, C32` (`serve-daemon.md`), audit P5 unaudited remainder + cross-lane P1–P4 shutdown trace (`physical-teardown.md`), reconcile P6 & Tier-A queue (`p5-p6-tier-a-reconciliation.md`) + targeted teardown tests | **Implemented** (hardware/macOS acceptance separate) | `packages/cli/src/serve-lifecycle.ts`, `packages/cli/tests/serve-lifetime.test.mjs`, `docs/state-machines/{serve-daemon,physical-teardown,p5-p6-tier-a-reconciliation}.md` |

---

## 4. Remaining Open Execution Slices (Phases 4A–4C)

### PR 4A: Explicit `AidenHostConnection` Lifecycle (`ios/AidenOnTheGo/Features/Remote/Hosts/AidenHostConnection.swift`)
- Consolidate the 8 coupled axes (`connectionState`, `generation`, `hostGeneration`, `connectionGeneration`, `isRevoked`, `isPurgePending`, `connectInFlight`, `settledState`) into an explicit pure transition type separating terminal custody (`active` vs `revoked(purgePending: Bool)`) from connection attempt state (`idle` / `connecting` / `connected` / `offline`), keeping all `@Observable` properties derived and `AidenHostRegistry` / `AidenHostConnectScheduler` untouched.
- Check Android's host connection coordinator for revocation-vs-reconnect parity.

### PR 4B (Series of 3 Small PRs): Incremental `AidenChatViewModel` Extraction
- **PR 4B-1:** Extract `AidenForeignRunObserver` from `AidenChatViewModel+ForeignRuns.swift` (`probeForForeignRuns`, `isCurrentForeignRun`, `foreignRunGeneration`).
- **PR 4B-2:** Extract `AidenPendingSendCoordinator` (`pendingSend`, `canRetrySend`, `scheduleRateLimitedSendRetry`) over `AidenChatDraftStore`.
- **PR 4B-3:** Extract `AidenChatMutationSubMachines` (worktree setup cancel-after-finish guard, fork/continue attempts, approval/question snapshot generation fences).

### PR 4C: Explicit `ComposerVoiceInputController` Reducer (`ios/AidenOnTheGo/Features/Chat/ComposerVoiceInputController.swift`)
- Consolidate the 12 `state` write sites and audio/task ownership flags (`activatedAudioSessionForRecording`, `audioTapInstalled`, `macTranscriptionTask`, `nativeFinalizationTask`, `suppressNextRecognitionError`, `sessionFence`) into one explicit transition function over `(State, Backend, ResourceOwnership)` guaranteeing tap/audio-session/task cleanup on every exit to `.idle`.

---

## 5. Verification & Rollback Contract

- **Desktop & CLI:** `npm run type-check`, affected registered test scripts in `package.json`, and `npm --prefix packages/cli run build && npm --prefix packages/cli test` whenever touching shared `main/services/` or `renderer/shared/`.
- **Native prerequisites in fresh checkouts:** `npm run build:worktree-remover && npm run build:worktree-file-io && npm run build:subagent-file-mutator && npm run build:subagent-shell-runner && npm run build:vcc && npm run build:lease-flock`.
- **Mobile & hardware gates:**
  - iOS (macOS host required): `xcodebuild test -project ios/AidenOnTheGo.xcodeproj -scheme AidenOnTheGo -destination 'platform=iOS Simulator,id=<UDID>' -only-testing:AidenOnTheGoTests` (simulator evidence does not replace physical-device microphone/Keychain acceptance).
  - Android: `cd android && ./gradlew :app:testDebugUnitTest :app:lintDebug :app:assembleDebug :app:compileDebugAndroidTestKotlin`.
  - Electron E2E: `npm run test:e2e:space -- <spec>` on macOS or CI's `xvfb-run --auto-servernum` sequence on Linux.
- **Test quality invariant:** Behavioral and transition-matrix tests only; never add `readFileSync`/source-grep tests against production `.ts`/`.tsx`/`.css` files.
- **Compatibility & rollback:** Public IPC/service signatures, wire schemas, on-disk stores, and manual-only network guarantees remain unchanged across all phases so every PR can revert cleanly without stranding durable recovery state.
