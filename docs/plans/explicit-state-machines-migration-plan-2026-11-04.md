# Explicit state-machine migration: risk ranking and phased plan

Status: **Proposed; no implementation started.** Prepared 2026-11-04 against `581aee4f8282444e13e3db1a2d7fefceaae65de9`. This is a planning follow-up to the [372-family inventory](../audits/implicit-state-machines-2026-11-04.md). No runtime suite was executed for this planning change.

**Prioritize authority/revocation, irreversible transactions, ambiguous remote outcomes, generation ownership, and native teardown. Start with a small admission extraction to establish the technique, then migrate one authority or effect boundary per PR.** Do not replace every UI boolean or introduce one application-wide machine.

## Ranking method and complete disposition

[Complete ranked inventory: all 372 entries](../audits/implicit-state-machine-risk-ranking-2026-11-04.tsv). Each original ID appears exactly once, retains its state/invariant description and source locations, and receives a primary risk group and phase disposition. IDs must be qualified: `clients:C15` and `cli-native:C15` are different entries.

Ranking is **architectural consequence and migration priority, not a list of confirmed vulnerabilities or measured failure probabilities**. Entries within a group are tied. Group scores are conservative upper bounds for the composed boundary, not independent estimates of every supporting view's risk. A projection in an authority group does not itself acquire authority. Implementation scoping must split mixed families before editing them.

C/A/T/R are ordinal 1–4 ratings:

- **Consequence:** 1 local cosmetic failure; 2 recoverable workflow interruption; 3 user work/privacy/spend affected; 4 irreversible loss, unauthorized effects, or duplicate external execution.
- **Authority:** 1 display only; 2 ordinary user mutation; 3 crosses execution/device/run ownership; 4 grants/revokes access or handles credentials.
- **Temporal complexity:** 1 local synchronous transition; 2 one asynchronous owner; 3 competing callbacks/timers; 4 cancellation, replacement, concurrent owners or restart interact.
- **Recovery:** 1 trivial reset; 2 reconstructible; 3 partial effects/retained resources; 4 durable ambiguity, crash recovery or irreversible commit.

Ordering considers consequence first, then authority, recovery, cross-platform reach and dependency centrality. There is no summed score or assumed frequency. T1 is maximum-consequence authority/data boundaries; T2 is high; T3 is moderate; T4 is lower. Existing explicit reducers and strong guards reduce the amount to rewrite, but do not make the surrounding effects low-consequence. Static inspection depth remains the depth recorded in the original reports; owner-scan-only entries need direct transition review in P0 before implementation. The backend, clients and CLI/native reports remain the evidence source.

| Rank | Risk tier | Machine family group | Entries | C/A/T/R | Work |
|---:|---|---|---:|---|---|
| 1 | T1 | Authorization, consent, revocation and capability ownership | 55 | 4/4/4/3 | P2 |
| 2 | T1 | Irreversible file, worktree and deletion transactions | 17 | 4/3/4/4 | P4 |
| 3 | T2 | Unknown remote outcomes, idempotency and durable outboxes | 17 | 4/3/4/4 | P3 |
| 4 | T2 | Generation admission, ownership, handoff and cancellation | 22 | 4/3/4/3 | P1 |
| 5 | T2 | Child process, VM and native supervision lifetimes | 26 | 4/3/4/4 | P5 |
| 6 | T2 | Authentication, credential commit and identity migration | 13 | 4/4/4/3 | P2 |
| 7 | T2 | Unattended Bot execution, pause, routine claims and recovery | 25 | 4/3/4/4 | P6 |
| 8 | T2 | Transcript, run journal and terminal persistence reconciliation | 10 | 4/2/4/4 | P1/P4 |
| 9 | T2 | External generation, publication and spend accounting | 12 | 3/3/4/3 | P6 |
| 10 | T2 | Client send queues, mutation intents, replay and settlement | 17 | 3/2/4/3 | P3 |
| 11 | T2 | Connection incarnation, streams and transport replacement | 25 | 3/3/4/3 | P6 |
| 12 | T2 | Durable local state, migrations, edits and autosave | 13 | 3/2/3/4 | P4 targeted; remainder deferred |
| 13 | T2 | Audio, video, input, recording and device sessions | 36 | 3/3/4/2 | P5 targeted; remainder deferred |
| 14 | T2 | Startup, shutdown, update and installation coordination | 14 | 3/2/4/3 | P5 targeted; remainder deferred |
| 15 | T3 | Budgets, bounded queues, backoff and single-flight work | 11 | 2/2/3/2 | Deferred after P6 |
| 16 | T3 | Run projections, attention, notices and monotonic views | 25 | 2/1/3/2 | P3/P6 boundary tests; extraction deferred |
| 17 | T3 | User-driven editors, setup and optimistic workflow UI | 11 | 2/2/3/2 | Deferred after P6 |
| 18 | T3 | Protocol framing, decoding and local parser states | 4 | 2/2/3/2 | Deferred; validate at owner phase |
| 19 | T3 | Catalogs, caches, discovery and background observation | 12 | 2/1/3/2 | Deferred after P6 |
| 20 | T4 | Ephemeral presentation, gestures and selection | 7 | 1/1/2/1 | Defer unless defect or coupling emerges |

The ranking refines the audit's initial priority shortlist; it does not change its historical findings. The highest-ranked groups are tightly coupled: a child workspace write spans authority (1), transaction (2), admission (4) and teardown (5). Its primary inventory placement is not permission to skip the other gates.

## What to make explicit

Use the repository's existing pattern: a typed state model, centralized transition/guard logic, and effects owned by the existing service. TypeScript discriminated unions and small pure transition functions are sufficient; Swift enums and Kotlin sealed states should model native owners where needed. Existing examples include `pi-runtime-events.ts`, `subagents/background-lifecycle-v2.ts`, `rpiv-todo/reducer.ts`, and the guarded `pi-runtime-effect-store.ts`. Preserve those explicit cores; formalize their surrounding orchestration only where required.

Each converted owner must document:

1. States, incoming events, rejected/stale events and guards, including identity/epoch checks.
2. Commands emitted by a transition, who executes them, and how completion/failure returns as an event.
3. The exact linearization point: reservation, authority revocation, dispatch, durable write, publication, terminal receipt or physical exit.
4. Which resources remain held after cancellation and what evidence permits release.
5. Persisted representation, supported restart inputs, recovery states and externally visible projections.

Keep independent axes independent. “Cancelled” cannot simultaneously mean authority revoked, pending I/O settled, child dead, receipt persisted and buffers released. Model these as a small product of typed states with explicit invariants, rather than a giant enumerated cross-product. Promise handles, file descriptors and abort controllers stay in an owner-managed resource registry keyed by the machine's identity; they are not serialized into reducers.

Maintain one authoritative writer per lifecycle. Effect results carry the owning run/document/device/config generation and operation ID; stale results cannot update a replacement owner. Recheck authority immediately before an irreversible dispatch, with an atomic ownership/claim boundary where required. An asynchronous guard check alone does not close a check-to-use race.

## Phases and PR boundaries

The phase order is a dependency order, not a claim that rank 4 is more dangerous than ranks 1–3. Every phase starts by reconciling its source with current main and the active plan index. Scope is an owner plus its adapters, never an entire large service rewrite. A defect discovered during extraction gets a separately explained behavior fix and test; do not silently encode it as intended behavior.

| Phase | Deliverable | Dependencies | Completion evidence |
|---|---|---|---|
| P0 | Baselines and transition contracts for selected owners | None | Behavioral baseline, explicit invariants, existing/new test map and real commit boundaries reviewed |
| P1 | Admission, generation ownership and terminal settlement | P0 | No overlapping owner or early budget release; existing public behavior preserved |
| P2 | Authority/consent and auth commit boundaries | P1 ownership vocabulary | Revocation prevents new effects; stale approvals/credentials cannot revive authority |
| P3 | Host ambiguous outcomes plus desktop/native delivery | P1; P2 ownership guards | Stable operation identity, no blind resend, same restart/replay behavior on all supported clients |
| P4 | Native/file/worktree transactions and durable reconciliation | P2; P3 outcome vocabulary | Crash matrix proves pre/post-publication recovery and preserves uncertain outcomes |
| P5 | Process/VM teardown, capture ownership and shutdown | P1/P2; P4 recovery retention | Real exit/resource evidence gates release; shutdown composes with in-flight transactions |
| P6 | Bot scheduling/recovery and remaining high-risk orchestration | P1–P5 applicable boundaries | No duplicate unattended fire or resurrection; cross-platform regression and acceptance gates complete |

P4 and P5 can proceed on separate owners after their listed prerequisites; do not modify the same native transaction/cleanup owner concurrently. Each phase may require several PRs. No time estimate is defensible until P0 establishes each owner's extraction size.

### P0 — Establish independent behavioral oracles

Start with the named owners below, not a generic state-machine framework. Capture a transition worksheet for each: event, prior state, guard, next state, effect, commit point, persistence and visible result. Trace all callers and terminal paths. Mark an existing enum/reducer as **retain** when it already centralizes transitions; migrate its adapter rather than reimplementing it.

Use deterministic clocks, controlled promises, fake transports, temporary real stores and explicit failure injection. Baselines observe accepted/rejected operations, persisted bytes/receipts, externally issued commands, visible messages and held resources. Snapshotting private flags or the new state object is not an independent oracle. A test-only old/new trace comparison may help locate drift but must also satisfy independently written invariants; never run old and new effect executors together against live resources.

**PR 0:** add only missing fixture/control seams and behavioral cases to existing suites. Establish a local passing baseline before moving logic. Record pre-existing failures without weakening checks. No new telemetry, network calls or runtime flags. Register any genuinely new suite in the appropriate root/CLI/mobile test target.

### P1 — Admission and generation settlement

Primary scope: rank 4 plus rank 8's generation terminal boundary. Begin with [ChatTurnAdmission](../../main/services/chat-turn-admission.ts#L35) (`backend:M006`), then first-send registration (`M007`), generation ownership (`M005/M012/M015/M178`), document/input ownership (`M008/M009`) and CLI admission (`cli-native:C09/C10`). Migrate the remaining rank-4 owners through the same contract, retaining existing subagent lifecycle reducers.

Proposed admission axes: authority `active | revoked`; preparation `pending | settled`; reservation ownership `lease | generation | released`; optional reconciliation fence. Events: reserve, preparation settled, lease expired, owner invalidated, registration succeeded/failed, release requested, generation reclaimed. Handoff remains synchronous with generation registration. Do not permit handoff while preparation is pending or forget retained bytes when authority is revoked.

Proposed generation axes: admission/initialization/execution/settlement, independent stop request and terminal persistence outcome. A terminal callback is not proof of durable save or physical resource release. Keep Pi journal faults, cutoff continuation and visible-versus-durable reconciliation as explicit substates/child owners, rather than silently mapping all errors to “done.”

**Slices:** P1a pure admission transitions behind unchanged lease API; P1b generation owner/settlement with unchanged IPC; P1c CLI and renderer adapters plus remaining host/harness ownership. Do not flatten the full `llm-client` into one enum.

Existing behavioral anchors: `main/services/chat-turn-admission.test.ts`, `chat-generation-owner.test.ts`, `chat-generation-start.test.ts`, `chat-run-input-admission.test.ts`, `generation-initialization-terminal.test.ts`, `generation-emergency-outcome.test.ts`, `renderer/lib/chat-message-queue.test.ts`, and CLI `tests/parity.test.mjs`. Admission already tests pending-versus-settled handoff, cached receipt budgets, expiry without early byte release, and indeterminate append fencing. CLI parity already covers a draining daemon refusing a new turn.

**Required coverage (reuse/extend, not duplicate):**

- Expiry/owner destruction before, during and after append completion; retained capacity remains charged until its actual holder releases it.
- Registration throws, requests reservation release synchronously, or completes just as cancellation arrives; no double release, negative counters or overlap.
- Two renderers, scheduler and remote request compete for one chat; at most one owner wins and the losing intent retains its documented behavior.
- Stop during initialization, after first delta and during terminal save; visible terminal message and durable transcript agree according to current recovery policy.
- Late events from the old run/document cannot terminate or unlock the replacement run. Queue order and edited draft content survive detached settlement.
- CLI shutdown with reserved but not yet executing work waits for the correct reservation/settlement boundary.

**Gate:** existing API behavior passes unchanged; generated event sequences maintain ownership/resource invariants; one queue/lifecycle Electron scenario passes. No persistence or wire-format changes.

### P2 — Authority, approvals and credential commits

Cover all rank-1 owner boundaries and rank 6, starting with Bot capability leases, approvals/questions, subagent write/shell authority, Remote pairing and CLI schedule consent. Then carry the same identity rules through single-use file/CUA grants, handoff/takeover, analytics consent and client approval projections; those projections remain read-only views of host authority.

Evidence: [Bot leases](../../main/services/bot-capability-lease.ts#L62), [provider auth](../../main/services/provider-auth-flow-core.ts#L476), [MCP OAuth token/session ownership](../../main/services/mcp-oauth-provider-core.ts#L172), and [CLI schedule publication approval](../../packages/cli/src/schedule-tool-approval.ts#L27).

Proposed authorization lifecycle: `pending → granted → consumed`, with `denied | expired | revoked` terminals where applicable; immutable scope/subject/generation on the grant. Dispatch admission and already-dispatched work are separate: revocation blocks new effects and requests cancellation, but must not pretend an existing external effect was undone. Preserve current once-only versus reusable grant semantics per owner.

Proposed auth lifecycle: `authenticating → committing → committed`, with cancellation/failure before commit and cleanup settlement tracked separately. Logout is its own delete/settle transaction. A credential committed successfully can yield a catalog warning, never a false “cancelled” result.

**Slices:** P2a Bot/subagent and scheduled-task authority; P2b Remote pairing/single-use capabilities; P2c provider/MCP auth; P2d remaining consent adapters. Do not widen any policy, add background auth/catalog access, or change protocol revision solely for this extraction.

Existing anchors: `bot-capability-lease.test.ts`, `bot-capability-state-checkpoint.test.ts`, `subagents/authority-v2.test.ts`, `subagents/subagent-workspace-write.test.ts`, `aiden-remote-pairing-requests.test.ts`, `provider-auth-flow-core.test.ts`, `mcp-oauth-operation.test.ts`, `mcp-oauth-session.test.ts`, and CLI parity/runtime suites. Provider tests already cover late credentials, owner destruction, timeout cleanup, commit point-of-no-return and shutdown waiting. Pairing already tests cancellation during Allow and revocation of uncollected grants. Workspace-write tests already exercise live revision revalidation after approval.

**Required coverage:** approve/revoke/expire in both orders around every awaited dependency; concurrent approval answers; wrong document/run/device/generation; stale cached approval after config change; cancellation before and after dispatch; single-use replay; failed authority persistence; schedule snapshot changes between preview and first write; write failure after consumption; late OAuth tokens after sign-out/replacement; commit succeeds but refresh fails; shutdown during commit. Assert externally observable effect counts and persisted authority, not internal setter order. Native clients must preserve host-controlled approval expiry and rejection behavior.

**Gate:** no new effect can cross a revoked/mismatched boundary; already-committed effects retain truthful outcomes. Focused host/CLI/mobile suites pass, including platform credential-anchor tests where changed.

### P3 — Unknown outcomes and durable delivery

Scope: ranks 3 and 10, plus stream/terminal projection adapters needed for them. Start with [Remote operation ledger](../../main/services/aiden-remote-operation-contract.ts#L455) (`backend:M058/M059`), Bot/Telegram dedupe and outboxes, desktop send intent/queue fences, and iOS/Android `clients:N22/N23`. Preserve explicit guarded store transitions already present.

Host model: stable operation identity with `in_flight | fulfilled | rejected`, and explicit uncertainty/reconciliation metadata. Client model: queued/frozen request, sending, outcome unknown, confirmed result, rejected or reconciliation required. These are **proposed internal names**, not new wire statuses. One request body, target identity and idempotency key remain bound together across ambiguous retry. Expiry of a local request/key does not prove non-execution.

**Slices:** P3a host ledger/owner adapter; P3b desktop and Telegram; P3c iOS outbox; P3d Android outbox. Compare the same event fixture across clients but preserve their shipped feature differences: iOS Bot attachment delivery must remain covered; do not introduce Android attachment sending as a side effect of this plan.

Existing anchors: `aiden-remote-operation-contract.test.ts`, `bot-runtime/bot-session-service.test.ts`, `telegram/bot-reply-outbox.test.ts`, `renderer/lib/hosts/remote-queue-fence.test.ts`, `ios/AidenOnTheGoTests/AidenBotSessionTests.swift`, and `android/app/src/test/java/sbtbiswas/AidenOnTheGo/features/bots/AidenBotSessionControllerTest.kt`. Host tests already cover indefinitely unknown outcomes, non-durable replay results, capacity overflow, clock rollback and malformed restored entries. Android tests already exercise durable outbox restore, key retention, retained unsettled sends and ownership replacement.

**Required coverage:** host accepts then response is lost; receipt precedes live echo and the reverse; duplicate echo; navigation/kill/relaunch while sending; re-pair to another host during pending send; expired key with unknown outcome; changed payload with same key; malformed or oversized durable ledger; persistence failure before dispatch and after effect; stop/retry races; terminal SSE followed by delayed durable history. Assert one execution/one displayed turn where promised, unchanged bubble identity, original key/body ownership and preserved unknown state. Do not claim global exactly-once effects when a provider cannot prove them.

**Gate:** host + desktop + CLI + iOS + Android fixture scenarios agree on IDs, sequence, terminal and unknown semantics. Existing API fixture remains unchanged unless a separately approved contract change is necessary. A real restart integration test supplements in-memory reducers.

### P4 — File transactions, deletion and durable recovery

Scope: every rank-2 boundary, targeted rank-12 durable stores/migrations, and rank-8 journaling/reconciliation. Start with [native file mutation](../../native/subagent-file-mutator/main.c#L44), [subagent workspace writes](../../main/services/subagents/subagent-workspace-write.ts#L457), [worktree deletion](../../main/services/git.ts#L5028), then Bot/chat deletion and image/artifact publication. Shell dispatch is modeled as an irreversible effect transaction even though it has no file-rename commit point.

Use each implementation's real commit protocol. For file writes, separate `prepared`, namespace publication, durability confirmation, recovery preservation and final cleanup. A failure after publication may be `unknown`/`recovery_required`, not a pre-commit failure. Worktree removal retains its existing quarantine and manifest phases, resume digest barrier and `needs_review` state; do not collapse it into the write transaction's model. Deletion fencing must compose with live run/approval owners.

**Slices:** P4a native mutator + TypeScript bridge; P4b worktree delete/restore; P4c Bot/chat delete and durable receipts; P4d journal/config migration adapters. Preserve serialized formats first. Any actual schema change is a separate compatibility migration with old-reader/downgrade rules.

Existing anchors: `subagents/subagent-workspace-write.test.ts`, `subagent-file-mutation-core.test.ts`, `subagent-file-mutator-io.test.ts`, `subagent-shell.test.ts`, `managed-worktree-remover.test.ts`, `managed-worktree-removal-core.test.ts`, `data-store.resilience.test.ts`, `pi-runtime-effect-store.test.ts`, and native bridge scripts `scripts/subagent-file-mutator.test.mjs` / `scripts/worktree-remover.test.mjs`. Shell tests already require cleanup-unconfirmed to remain durable unknown without retry. Native helpers need their registered native suites, not only mocked TypeScript tests.

**Required coverage:** failure/kill at every durable edge (before prepare, after prepare, after namespace publication, before/after directory sync, before/after journal/receipt publication, during cleanup); restart from each residue; symlink/parent replacement and file identity mismatch; malformed manifest/digest; concurrent deletion and send/write; cancellation on either side of commit; cleanup failure preserves recovery evidence; repeated recovery is idempotent. Use real temporary files and helper processes. Assert file contents, directory entries, persisted receipts and recovery artifacts, not private flags. A new reducer's crash matrix must retain existing path/ownership security tests.

**Gate:** pre-commit failure leaves the old object intact; post-commit/unknown outcomes are never misreported as clean rollback; restart either safely completes, preserves evidence or requires review. macOS and Linux native evidence is required for changed cross-platform helpers.

### P5 — Physical teardown and application lifecycle

Scope: rank 5 and the relevant rank-13 capture/input owners and rank-14 shutdown/install coordinators. Start with subagent process/shell ownership, CUA host/broker/supervisor, Bot VM lifecycle and slots, then MCP/ACP/process workers, terminal and media ownership. Installation/update state remains a separate transaction coupled to shutdown, not a reason to bypass it.

Proposed resource lifecycle: `acquiring → running → stop_requested → draining → exit_confirmed → reclaimed`, with `cleanup_unconfirmed`/recovery ownership where proof is unavailable. Track authorization independently. For CUA, preserve lease authentication, matching control audit identity, supervision arming, child launch and readiness acknowledgement order. VM stop, guest tool exit and slot release are distinct events. A timeout is evidence of a timeout, never proof of exit.

**Slices:** P5a shared process settlement + subagents; P5b CUA/native supervision; P5c VM/MCP/ACP; P5d capture and quit/update composition. Keep native protocol framing and process-group identity checks intact.

Existing anchors: `subagents/subagent-shell.test.ts`, `subagent-shell-runner-io.test.ts`, `background-lifecycle-v2.test.ts`, `computer-use/generation-gate.test.ts`, `dictation-cleanup-core.test.ts`, Bot computer suites, `main/application-lifecycle-core.test.ts`, and CLI `tests/runtime.test.mjs` / `serve-startup.test.mjs`. Run the registered native CUA suite and native helper tests; mocks alone cannot establish descendant death.

**Required coverage:** stop during launch/handshake; EOF before/after supervision armed; parent exits leaving a descendant; TERM ignored then bounded escalation; stale process identity; cancellation concurrently with natural exit; child exits before readiness; cleanup throws; VM start versus stop/takeover; host shutdown while auth/write settlement is pending; cancelled quit reopens only the admission it owns. Real process tests verify descendants, sockets, locks and resource slots, with cleanup in the test itself. Hardware-dependent VM/capture/permission cases need explicit native acceptance evidence.

**Gate:** no new execution after revocation, no resource reuse before confirmed reclamation, no “all stopped” result while cleanup is unconfirmed. Include a shutdown/restart integration trace spanning P1–P4.

### P6 — Bot schedules, recovery and remaining high-risk composition

Scope: rank 7, remaining rank-9 external job/accounting owners, rank-11 connection incarnations, and high-risk residuals from ranks 8/12/13/14 after P0 splits mixed families. Cover paused durable sessions, routine fire claims, catch-up, watchdogs/breakers, event wakes, deliveries and subagent background follow-through. The durable-jobs foundation is inventoried but not permission to activate its currently unwired execution adapter.

Proposed independent axes: Bot policy `active | paused | deleting/deleted`; run/claim lifecycle; scheduler due/claimed/fired/settled; recovery eligibility and budgets. A projected “idle” session does not grant permission to run. External paid job lifecycle must retain submission ambiguity and cancellation settlement. Connection owners carry a peer/config incarnation; replay and projection stay subordinate to execution authority.

**Slices:** P6a Bot pause/claim/recovery; P6b scheduler/catch-up/wakes; P6c external job/accounting and connection incarnation; P6d remaining high-risk owners selected from the matrix. Lower-ranked projection, cache and visual machines remain deferred unless this work exposes a concrete coupling or defect.

Existing anchors: `bot-runtime/bot-session-service.test.ts`, `bot-runtime/bot-pause.test.ts`, `bot-pause-store.test.ts`, `scheduled-bot-routines.test.ts`, `bot-routine-recovery.test.ts`, `bot-routine-events/events.test.ts`, `bot-routine-events/watch.test.ts`, `subagents/background-lifecycle-v2.test.ts`, `aiden-remote-streams.test.ts`, and CLI parity tests. Session tests already cover restart dedupe, explicit Dismiss without a provider request, and an answer committed before a subsequent storage error.

**Required coverage:** two ticks claim one occurrence; clock rollback/forward and timezone/DST boundaries preserve existing scheduling semantics; sleep/restart catch-up; pause/delete during claim or launch; stale lease completion after replacement; repeated wake and delivery retry; watchdog versus natural completion; recovery breaker/budget exhaustion; external job accepted before response loss; no background/manual-only catalog or runtime download caused by startup/reconnect. Assert persisted fire identity, actual provider/tool invocations, pause state and visible result.

**Gate:** repeatable restart/clock tests plus cross-client pause/recovery projection; existing explicit transitions retained. Final inventory disposition marks each targeted owner converted, already explicit, or deliberately deferred with rationale—never “done” merely because an enum was added.

## Test layers and commands for implementation

These are future execution gates, not results from this planning task. Existing test files listed above were located and selected cases inspected; that does not establish a green baseline at this head. A required scenario may already exist—extend it only when an independent behavior gap remains.

| Layer | Required evidence |
|---|---|
| Pure transition tests | Legal/illegal events, terminal monotonicity, stale identity rejection; bounded event-sequence generation with reproducible seeds and independently stated ownership/resource invariants |
| Owner/effect adapter tests | Controlled promise order, reentrancy, duplicate completion, abort and failure; real public methods plus effect/store outputs |
| Restart and persistence | Real temporary stores/helper processes, kill/failure at each actual durability edge, old-format fixtures, clock control |
| Cross-platform contracts | Shared semantic traces for Remote identities, replay, approvals, unknown outcomes and terminal projection; TS/CLI/Swift/Kotlin implementations tested through their public behavior |
| UI integration | Existing queue/outbox/approval flows including navigation, refresh, detached completion and retry; no class-name/source-text assertions |
| Native acceptance | Actual child/descendant exit, platform credential anchors, native helpers; physical devices for hardware-specific behavior and recorded VM/permission evidence |

Run the smallest existing suite while editing, then the relevant registered suite and type/lint checks for each PR. Before integration/merge, run the required broader root/CLI/mobile suites and exact-head CI; don't use CI as the first failure detector. Examples, selected by touched owner:

```sh
# Narrow TS example; native-dependent suites additionally need their existing build hooks.
npx tsx --test main/services/chat-turn-admission.test.ts main/services/chat-generation-owner.test.ts
npm run test:aiden-remote
npm run test:remote-chat
npm run test:bot-runtime
npm run test:bot-pause
npm run test:subagents
npm run test:mcp
npm run test:subagent-file-mutator:native
npm run test:worktree-remover:native
npm run test:computer-use:native
npm run test:bot-computers
npm run type-check
npm --prefix packages/cli run build
npm --prefix packages/cli test
npm --prefix packages/cli run type-check
# On a Mac, window-opening tests use Cua Space; changed darwin-only behavior also needs host evidence.
npm run test:e2e:space -- tests/e2e/chat-message-queue.spec.ts
# From android/, with the configured JDK and SDK:
./gradlew :app:testDebugUnitTest :app:lintDebug :app:assembleDebug :app:compileDebugAndroidTestKotlin
# Select an available simulator explicitly; replace the placeholder before running.
xcodebuild test -project ios/AidenOnTheGo.xcodeproj -scheme AidenOnTheGo \
  -destination 'platform=iOS Simulator,id=<selected-simulator-UDID>' \
  -only-testing:AidenOnTheGoTests
```

Android instrumentation tests require an explicitly selected emulator/device when changed; compilation is not execution. iOS simulator evidence is not physical-device acceptance or Keychain/entitlement acceptance. Apply `ios/AGENTS.md`'s independent review/evidence gates when advancing applicable Bot mobile phases. No live-provider or hardware acceptance is implied by fake-provider unit tests.

## Compatibility, rollout and rollback

- Preserve public service/IPC signatures, wire shapes, errors, persistence schemas, timers, queue order, retention budgets and manual-only network behavior in the first extraction of each owner. “Equivalent” includes failures, cancellation and restart, not only the happy path.
- Keep existing reducers and guarded stores as authoritative cores. Do not add a second competing state writer, duplicate production effects, or a generic workflow engine. State transitions alone do not supply durable exactly-once execution.
- Roll out one owner through its existing API. Prefer a normal code release over a runtime switch that can replace an active owner. If a temporary implementation switch is necessary, choose it only before owner creation and never change it mid-flight; remove it after validation.
- Rollback is a code revert only while persisted/wire compatibility remains intact, with active owners drained or process restarted under existing recovery rules. After a separately approved schema migration, use its explicit compatibility/forward-repair plan; do not downgrade a reader that cannot understand stored state. Never delete recovery evidence to make rollback look clean.
- For every PR, record touched inventory IDs, retained explicit cores, behavior intentionally unchanged, baseline tests, new gap coverage, failure/kill points exercised and remaining native/device evidence. No blanket “all state machines fixed.”
- Update affected runtime/API/platform docs when a behavior or contract actually changes, including native clients and CLI. This plan alone changes none of those product claims. Keep this plan and `docs/plans/README.md` status accurate, and archive only after all accepted scope and evidence gates are complete.

## Proposed first three PRs

1. **P0/P1a: explicit ChatTurnAdmission lifecycle.** Preserve the lease API and reservation accounting; add only missing cancellation/reentrancy cases, then extract transitions.
2. **P1b/P1c: generation owner settlement across host, renderer and CLI.** Establish a shared ownership/terminal contract before touching remote retry or durable commits.
3. **P2a: Bot/subagent/schedule authority transitions.** Bind every approval/dispatch to its current owner and preserve revocation and commit boundaries, using the existing guards as behavioral baselines.

Subsequent PRs follow the phase dependencies above. This is an implementation proposal, not authorization to change shipped semantics or a claim that the required validation has passed.

## Planning validation

Validated that the risk matrix contains exactly 372 unique original inventory IDs across 20 groups, with original invariant descriptions and source references preserved. Checked the plan/audit document links, source line bounds, 47 referenced suite names, listed root npm scripts and document whitespace; `git diff --check` passed. These are documentation/inventory checks only. No production code changed and no runtime test suite was run.
