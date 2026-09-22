# Native response/list ownership follow-up

Owner: this recovery task, explicitly retained by program coordinator on 2026-09-22. Separate patch after PR217; do not call full recovery complete while these findings remain open. Separate worktree /Users/sambitbiswas/.codex/worktrees/mobile-response-ownership/aiden-agent, branch feature/mobile-response-ownership, based on published PR217 head0cba92f10675eead1b11d1a056aa7365487373f8. Original-main source baseline: c8c09e0d2. Coordinator explicitly authorized parallel follow-up while217CI runs on2026-09-22 16:53 UTC. Published217 worktree remains unchanged.

## Evidence status

Both independent Sol medium reviewers inspected original-main and current source. The schedules below are source-confirmed counterexamples and deterministic test specifications, NOT executed XCTest reproductions. Physical XCTest remains blocked by the locked shared iPhone; no simulator allowed. Obtain an executed Android baseline where applicable, and compile iOS regressions while retaining explicit device acceptance limits.

## Workspace rename response versus terminal settlement

Affected iOS: AidenWorkspaceChatsModel.rename/persist in Features/Remote/AidenChatFeature.swift; detail AidenChatViewModel.reconcileChat/acceptRemoteChat. Routes: PATCH /chats/{id} with If-Match, then GET /chats/{id} for reconciliation. Both exist in original-main.

Schedule: hold a successful PATCH response containing new title + pre-terminal messages. Let detail stream finish and authoritative GET save final messages. Release PATCH. Workspace model upserts/persists its older full transcript and publishes onChatUpdated. isMutating fences only one workspace model; transcriptGeneration fences only one detail model; isCurrent validates installation, not response order. PR217 tokens order already-accepted writes, so a newly accepted delayed HTTP response receives a newer token.

Regression: real production workspace/detail models and held URLProtocol PATCH; terminal GET settles first; release PATCH. Require final message and successful new title in model/list/cache/reopened disk. Negative tests: post-PATCH refresh offline/failure must not undo successful title or publish stale messages; ordinary disk failure must not remove newly created chat from the in-memory list; repeated refresh supersession must not trigger duplicate mutations. Never replay PATCH/POST to recover a read.

## Workspace list/cache versus mutation or installation purge

Affected iOS: workspace load GET /chats?workspaceId=..., remove, and persist saveChats/reconcileChatSummary; Persistence/AidenChatCache.swift list/summary writes; AidenRemoteCoordinator.purgeInstallationDataUnlocked. Original-main already has these methods.

Schedule A: list GET starts before create/rename/delete or detail settlement; response is delayed until after accepted newer model/cache update, then overwrites full-chat list with older records.
Schedule B: load passes isCurrent and queues saveChats; purge runs first; delayed list write runs after purge and recreates metadata. persist can likewise yield after detailed save then write list/summary after purge. Envelope instance IDs isolate namespaces but do not prevent post-purge writes. Existing coordinator installationDataGate protects withRetainedInstallationData operations, not workspace list/persist writes.

Regression: deterministic admitted list/summary writes delivered after actual purge; reopened disk must contain neither artifact, another instance must be unaffected, a legitimate re-pair/new session must work. Hold list GET through valid create/rename/remove and verify both UI and offline results. Inspect every list/summary writer before choosing cache tokens or retained-data gate; avoid a partial fence that leaves companion artifacts writable.

## Bot navigation and Android parity

Inspect all cached-nil BotShell GET writers and Android workspace/Bots/detail producers. A stale response rejected by shared ordering must use a currently admitted chat or retry an authoritative GET so valid navigation completes. Do not simply return and strand a loading destination. Preserve successful create and model/navigation scope identity guards. Complete reachability review before asserting this is reproduced.

## Coordination and next gate

Notified browser owner 01a0c7aa-c3e8-7003-8374-03d44f1812dd and mobile Bots/Queue-Steer owner 01a0c7aa-c3ec-7530-8ecc-96f7788c17f1 about list/rename/BotShell scope; awaiting overlap constraints. Deliverable owner knows cache token API. Keep PR217 code unchanged while exact-head CI completes. Implement follow-up separately after its scoped gate, obtain both independent Sol medium reviews and applicable Android/iOS checks, then send exact commit and regression evidence to integration coordinator.

## Executed Android cache-boundary baseline (2026-09-22)

Ran two temporary deterministic JUnit regressions using production AidenChatCache and real temporary disk. The queued closure matches WorkspaceHome.accept's deferred save; one test executes it after a newer accepted chat write, the other after purge. Both FAIL as expected: newer title is replaced; purged chat is recreated. `git diff c8c09e0d2 HEAD -- android/.../persistence/AidenChatCache.kt` is empty, so the exercised cache source is identical to original main. These are cache-boundary reproductions, not full navigation/ViewModel integration tests.

Command: `./gradlew :app:testDebugUnitTest --tests '*AidenChatTest.queuedHomeWrite*' --max-workers=2 --console=plain` with the established Android Java/SDK environment. Evidence: `/tmp/aiden-response-ownership-baseline.log`; exact temporary tests: `/tmp/aiden-response-ownership-baseline.patch`. Test file restored after capturing evidence; PR217 worktree remains clean. Follow-up must retain these negatives, add owner-level queued-dispatcher/held-HTTP tests, and prove they pass with the safe fix.

Android source review also confirms Home summary-page generation is local to home loads and cannot see detail settlement. iOS BotShell duplicate GET is reachable when openConversation sets path, triggering restorationID/.task while the first cache-miss GET is pending; both openConversation and hydrateRestoredPath can publish for the same path. Hold GET A, return final from B, then release A. Assert final presentation, mutation access, retained navigation path and reopened cache. No claim of executed iOS reproduction yet.

2026-09-22 integration audit adjustment: PR217 now also fences iOS workspace/home metadata and attachment writes across deletion/purge, with required reservations and per-file metadata ordering preserving valid re-admission. This absorbs the iOS delayed cache-write/purge portion of the follow-up. Cross-owner HTTP response vs terminal settlement/presentation, rename field preservation, Bot duplicate GETs and Android delayed home writes remain open. Exact revised PR head is recorded in the task's next publication/update.

15:39 UTC heartbeat: exact f959469702 hosted verify failed in unchanged scripts/bot-inbox-writer.test.mjs wrong-inode case with uncaught stdin EPIPE. TS/lint/policy/model checks passed; native iOS compile step skipped after test failure. Android hosted green; Electron E2E still running. Job106812682773/run35747292113 logs /tmp/aiden-pr217-verify-failure.log. Built native helper locally; all3 harness tests pass (/tmp/aiden-pr217-inbox-recheck.log). Rerun request rejected while run still in progress; retry failed job/run after completion. Coordinator notified for possible existing owner EPIPE fix. No tested code changed; broader followup remains after PR217 gate.

16:20 heartbeat: c22 verify failed capacity test's equality between two live statfs readings. Adopted isolated sourcepeer4c00c968 as683f92dea7020789aed8d303e58c687b635eca99 (same fix already green in218/combined), no production/mobile changes. Focused capacity test passed, both independent Sol medium reviews clear. Restored locked dependencies via npm ci --ignore-scripts; ESLint now passes for capacity test and earlier inbox harness. Logs /tmp/aiden-pr217-c22-verify.log, /tmp/aiden-pr217-capacity-fixed.log, /tmp/aiden-pr217-test-fixes-lint.log. Published, coordinator/integration informed; latest hosted CI still required.

16:34 portability follow-up: published0cba92f10675eead1b11d1a056aa7365487373f8 fixes4074005701 test-only. Baseline217 statfs Number conversion need not be safeinteger; finite/nonnegative plus typederror/reserve/estimate/sameobservation shortfall retained. Actual-error fixture aboveMAXSAFE accepted; NaN/infinities/negative/non-shortfall/untyped rejected. Focused2tests andeslint pass (/tmp/aiden-pr217-capacity-large.log), bothSolmediumreviews clear. PR221 has different hardened safeinteger contract; coordinated without changing221. All12threads resolved; latestCIpending. Nativecodeunchangedc22.

## First bounded implementation and remaining ownership plan

Repeated the two Android cache-boundary negatives on the isolated follow-up base; both fail (/tmp/aiden-response-followup-baseline.log). A git diff confirms Android cache source on original-main c8c09e0d2 equals the exercised published217 base. The original patch remains /tmp/aiden-response-ownership-baseline.patch.

Implemented only queued accepted Home writes so far: cache-wide AtomicLong reservation before Home.accept launches IO, per-installation/chat high-water and purge floors checked inside synchronized saveChat, removal/purge invalidation, normal fresh writes still admitted. Added injectable Home cache dispatcher and an actual Home ViewModel controlled-dispatcher test, plus adapted the two cache negatives. All3focused tests pass, then all180Android JVM tests pass with lint/instrumentation compilation (/tmp/aiden-response-followup-fixed.log, /tmp/aiden-response-followup-android.log). This is not yet a full response-ownership fix and is not published.

Next concrete slices:
1. Android shared response admission: reserve at request dispatch for initial/terminal/title GET and accepted POST; return current admitted winner on supersession, preserve stream receipt and navigation, never replay a mutation. Cover two detail ViewModels with one held initial GET through the other's terminal settlement.
2. Android home pages: carry request tokens through summary acceptance; row/metadata ownership must see detail settlement and purge; reject stale pages without advancing cursor/boundary, preserve currently admitted rows and unrelated installation. Test held initial/pagination GET through settlement/purge and disk reopen.
3. iOS duplicate Bot GET and detail reads: reserve before HTTP, pass authority through shared presentation helper, use current admitted winner on rejection with path/device/scope guards. Test both duplicated GET completion orders and navigation availability.
4. iOS rename/list response ownership: PATCH receipt owns title fields, not a whole stale transcript. Preserve the successful title when refresh fails, preserve settled messages and avoid treating opaque revisions as numerically ordered. Final representation/revision choice must follow server contract and direct review; do not overwrite a current transcript with an old response or silently discard successful rename. Held PATCH/list vs terminal GET tests and legitimate new-create/rename/navigation controls are required.

Native integration owner and browser owner were notified of branch/worktree boundaries. Both Sol reviewers assigned read-only ownership review; published217 stays on its tested head. Physical XCTest remains unexecuted; no device slot requested while locked.

Independent Sol medium reviews: Android queued-home slice clear in both source/test reviews. iOS design review recommends separate title overlay ownership: reserve request-origin tickets before GET/PATCH; retain winning full snapshot/revision on delayed successful rename, persist successful title overlay separately, and perform a read-only refresh to obtain a coherent snapshot. If refresh fails, preserve the overlay but require refresh before another revisioned mutation rather than invent an opaque revision order. Bot mutation-availability publication also needs path+scope+attempt ownership after its awaits. This is a concrete design proposal awaiting implementation/regression evidence, not shipped behavior.
