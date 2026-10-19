# Aiden harness quality and reliability upgrade

Status: Active (2026-10-19). Implementation authorized, with fresh-context GPT-6.1 Sol/medium review after each phase. PR and exact-head CI required; do not merge. Live evaluation and release acceptance remain separate gates.

## Objective and Pi decision

Improve Aiden's ability to complete work, recover from failures, show what was verified, and evaluate workflow changes using execution evidence.

Keep the active Pi packages pinned at **1.3.0** during the initial work. Preserve the frozen `@aiden/pi-legacy-harness` alias at **0.87.1**. The changes belong primarily to Aiden's runtime integration, tools, memory, clients, and evaluation infrastructure. Use existing Pi hooks and Aiden's immutable runtime contribution snapshots. Do not fork Pi, patch installed dependencies, replace the runtime with Harness², or combine a provider upgrade with a harness experiment.

If an upstream defect or missing public API prevents a slice, reproduce it independently and use the separate Pi upgrade gate below. The current dependency record is [Pi 1.3.0 project memory](../../.memory/pi-1.3.0-upgrade.md).

## Evidence and baseline

The sitrep used three GPT-6.1 Sol subagents at high reasoning, followed by independent source inspection and focused parent-agent probes.

| Reference | Audited snapshot and limits |
| --- | --- |
| Aiden checkout | `a74edb0f6b1f165196cc98969d73482c857f945a`, version 0.57.0; clean at audit start |
| Remote main comparison | `13aa5763a32fb46619b61355166825b456905b1c`; 109 commits ahead, 155 changed files. Core finding files were unchanged; relevant harness, Remote, and chat-pane patches were inspected. This was a focused comparison, not a full audit of every new commit. |
| Harness² | Google Research commit [`1cfe254e8d25b15f37048c3730134686abe60335`](https://github.com/google-research/harness2/tree/1cfe254e8d25b15f37048c3730134686abe60335); source inspected, no downloaded code executed |
| Executed checks | Real temporary SQLite memory-capacity probe; real Assistant error-state function probe; six task-oracle fixtures with 7 valid controls accepted and 22 invalid controls rejected; 23 CI-policy/registration tests passed |
| Not established | Live-model task success or billed-cost improvement, full current-main test acceptance, packaged performance, visual quality, or physical-device acceptance. The audit checkout had no installed dependencies. |

Before implementation, refresh this baseline against the then-current main. Preserve the recently merged audit fixes instead of treating old plans as current defect inventories.

### Verified findings

| Finding | Evidence | Qualification |
| --- | --- | --- |
| Newer chats lose cross-chat recall when metadata capacity fills | [`memory-store.ts`](../../main/services/memory-store.ts), `replaceChatMetadata`; [`llm-client.ts`](../../main/services/llm-client.ts), indexing call. Six chats inserted `[1000,1000,1000,1000,1000,0]`; newest unique term had no recall match. | Applies when workspace memory is enabled. Existing chats can refresh; deleting source chats frees space. Approved facts and Bot memory are separate. |
| Assistant recovery treats independent errors as a repeated loop | [`tool-loop-guard.ts`](../../main/services/assistant/tool-loop-guard.ts), `advanceAttendedToolErrorState`; [`pi-turn-context.ts`](../../main/services/pi-turn-context.ts). Two batches, each with an error and a success, trigger tool removal. | Attended Assistant mode only, not all coding-workspace turns. The escape hatch is intentional and must remain effective. |
| Later services disappear from large discovery inventories | [`pi-tool-discovery.ts`](../../main/services/pi-tool-discovery.ts), `inventory` slices 512 before ranking and namespace filtering. | Explicit bounded policy; preserve byte, authority, and upstream inventory limits. |
| Lifecycle completion does not establish task correctness | [`pi-agent-runtime-harness.ts`](../../main/services/pi-agent-runtime-harness.ts), managed outcome; [`subagent-child-runner.ts`](../../main/services/subagents/subagent-child-runner.ts), terminal prose. | Existing [`claim-check.ts`](../../renderer/shared/claim-check.ts) flags narrow false-success cases; preserve and extend it. |
| Independent task evaluation remains unfinished | [Six-task pilot](../research/experiments/task-quality-fixtures/pilot-manifest.json) and [research conclusions](../research/2609.20804-pi-harness-deep-dive.md). | Existing replay tests establish lifecycle invariants. Oracle-control passes are not model task-success measurements. |
| CLI does not wire the durable Bot-session service | [`remote-bots.ts`](../../packages/cli/src/remote-bots.ts), [`remote.ts`](../../packages/cli/src/remote.ts), and [`aiden-remote-router.ts`](../../main/services/aiden-remote-router.ts). | Negotiation correctly withholds unavailable session/routine/preset/memory/proactivity features. This is a parity gap. |
| Desktop renders every loaded transcript message | [`message-list.tsx`](../../renderer/components/message-list.tsx) and [`chat-pane.tsx`](../../renderer/main/chat-pane.tsx). | Structural observation; measure packaged latency and memory before claiming a regression or selecting a rendering strategy. |

## Scope and existing work

Reuse the existing effect journal, unknown-effect states, approved workspace boundaries, scoped output handles, compaction coordinator, durable Bot sessions, subagent budgets, and test-registration machinery. Keep catalog and provider network behavior within the manual-only rules in `AGENTS.md`.

Coordinate with these existing plans rather than replacing them:

- [Task-quality research](../research/2609.20804-pi-harness-deep-dive.md): complete the protected adapter and measured pilot; retain historical results and frozen controls.
- [Compaction and memory upgrade](pi-compaction-memory-upgrade-plan.md): retain checkpoint/publication/recovery invariants; no default threshold change in this plan.
- [Aiden CLI](aiden-cli-plan.md) and [parity checklist](aiden-cli-parity-checklist.md): add the durable Bot-session delta without reopening completed original delivery work.
- [Performance program](performance-stability-efficiency-plan.md), [long-thread payloads](long-thread-payload-upgrade-plan.md), and [cache-first loading](cache-first-loading-states-plan.md): reconcile implementations before assigning overlapping transcript work.
- [Peer/mobile reliability](peer-mobile-reliability-plan.md) and [subagent expansion](subagent-orchestration-expansion-plan.md): these retain ownership of background result delivery and wake authority. This plan does not enable background launches.
- [Diagnostics program](logging-and-diagnostics-upgrade-plan.md): retain privacy boundaries while improving safe failure evidence.

Out of initial scope: automatic self-modification, replaying live external writes, unrestricted executor permissions, mandatory multi-run processing for every chat, automatic changes to global skills, broad tool-concurrency changes, and a Pi version upgrade.

## Delivery sequence

Each row is a reviewable slice, not one large PR. H0 precedes implementation. Independent H1 fixes can land before evaluation. H3/H4 can proceed after H0 without delaying the first fixes. H5 requires the evidence and evaluation foundations.

| Slice | Deliverable | Depends on | Status |
| --- | --- | --- | --- |
| H0 | Current-main baseline, ownership, and acceptance inventory | None | Complete; fresh review passed |
| H1a | Bounded workspace metadata retention and indexing status | H0 | Planned |
| H1b | Progress-aware attended Assistant recovery | H0 | Planned |
| H1c | Discovery across admitted namespaces with bounded output | H0 | Planned |
| H1d | Failed CLI advisor accounting and useful CI receipts | H0 | Planned; separate commits |
| H2a | Versioned, host-owned verification/evidence receipts | H0 | Planned |
| H2b | Protected six-task evaluation adapter and offline falsification | H2a | Planned |
| H2c | One bounded baseline/candidate live pilot | H2b and resolved pilot budget/configuration | Planned; no trial started |
| H3 | Portable durable Bot-session parity for CLI/native consumers | H0; portability decision below | Planned |
| H4a | Packaged long-chat and idle performance baselines | H0 | Planned |
| H4b | Measured transcript rendering improvement | H4a | Planned |
| H5a | Versioned workflow evidence and lesson candidates | H2a, H2b | Planned |
| H5b | Explicit workflow experiment and adoption UI | H5a, completed H2c with usable measurement pipeline | Planned; off by default |

### H0 — Freeze the baseline and reconcile ownership

1. Start implementation from current main; recheck each finding and relevant tests. Record commit, lockfile hashes, active/legacy Pi versions, platform, build mode, and feature flags.
2. Resolve overlapping plan owners. Record shipped, implemented-but-unaccepted, inactive, and proposed states separately. Correct stale version claims without converting pending physical acceptance into a pass.
3. Preserve the six frozen cases. Create a new versioned experiment manifest when an adapter or trial is ready; do not silently rewrite the old manifest's authorization or historical results.
4. Separate correctness, deterministic lifecycle/efficiency, and real-model task quality. Never infer the third from the first two.

Exit: exact baseline and slice ownership recorded; each finding reconfirmed, narrowed, or removed with evidence. No new feature or provider request is needed.

### H1a — Prevent metadata starvation

Implement retention inside the existing SQLite transaction. Retain the current 5,000-document scope and 1,000-document chat bounds initially. Admit current-chat documents by evicting oldest eligible metadata from other chats when necessary, with deterministic tie-breaking. Specify whether age means last indexing or source-message time before coding; avoid letting a passive refresh make all old material artificially new. Approved facts are never eviction candidates, and Bot memory files are unchanged.

Return a structured indexing result (accepted, dropped/rejected, evicted, capacity status) and handle it at callers. Expose bounded diagnostic status without copying conversation content. If user-facing status is needed, use existing Memory/settings surfaces.

Acceptance: a newly active chat remains recallable at capacity; limits hold; refreshing old chats, source deletion, concurrent writers, rejected input, and rollback preserve isolation and deterministic retention. Fact expiry/provenance remain unchanged. Extend the real-store suite, including the original sixth-chat failure. Do not merely raise the cap.

### H1b — Detect actual repeated failure

Replace the any-error counter with bounded host-owned failure classification. Use tool identity, a digest of validated arguments, and a safe error category to recognize repetition; never persist raw arguments or provider error text. Unrelated successful work must not erase evidence of an unchanged failing call. Changing arguments must not permit unlimited retries: retain a total failure/turn ceiling and existing cancellation/deadline limits.

Treat permission denial and revoked authority as terminal for that action. Retry transient/correctable errors only under existing authority. Preserve text-only recovery for repeated malformed calls from providers that ignore tool errors. Keep the policy scoped to attended Assistant mode.

Acceptance: identical malformed calls still stop; independent errors with useful progress do not stop prematurely; varied arguments cannot bypass the total ceiling; denial/cancellation never causes another effect. Extend existing guard and real-harness integration tests.

### H1c — Scale discovery without expanding authority

Search compact metadata across the already-admitted inventory before returning bounded schemas. Provide deterministic namespace paging and direct namespace lookup so admission order cannot hide an entire service. Validate duplicate identities and namespace collisions across the admitted set. Preserve per-server listTools bounds, result/schema byte limits, cancellation, configuration revisions, and dispatch-time permission checks.

Measure an explicit metadata-index memory/CPU budget. If an aggregate limit is reached, report unavailable scope honestly and provide bounded namespace navigation; do not imply an exhaustive search. Never fetch catalogs or connect new services merely to satisfy discovery.

Acceptance: exact search and namespace lookup find a service after position 512 in a multi-server fixture; paging is deterministic; hidden/revoked tools remain absent; malicious schemas stay bounded. Measure at 64, 512, and 1,536 admitted tools. Extend `pi-tool-discovery.test.ts` and affected MCP authority tests.

### H1d — Preserve accounting and diagnostic evidence

For CLI advisor calls ending before a response, implement `recordUnreportedUsage` as a failed/cancelled attempt with unavailable token/cost values. Unavailable is distinct from zero. Mark accounting recorded only after persistence succeeds; persistence retries must not double count an attempt.

Separately, extend sanitized CI receipts with repository-owned test IDs, failure category, lifecycle phase, retry count, duration, and commit/run identity. Populate from an allowlisted reporter, not raw stdout or assertion text. Keep credentials, user content, screenshots, traces, and arbitrary local paths out of automatic uploads.

Acceptance: throws/cancellation create one unknown-usage attempt; successful accounting stays intact. CI fixtures produce useful safe records for test/setup/timeout failures and reject unsafe fields. Preserve the one-rerun limit and fail-on-flaky policy.

### H2a — Make verification evidence durable and scoped

Introduce a versioned host-owned receipt alongside lifecycle/timeline state. Proposed fields: run/turn identity, check kind, artifact/snapshot identity, check result (`passed`, `failed`, `not_run`, `inconclusive`), evidence reference, observed time, and limitations. Bound fields and counts. Model prose may propose a check but cannot manufacture a passed host receipt.

Keep three meanings distinct: the response ended, a particular check passed, and explicit task acceptance predicates passed. Exit code zero is evidence about that command, not proof of every user requirement. Retain the existing claim checker as a complementary signal.

Bind checks to the artifact version examined; further edits make receipts stale. Reconcile external effects through permitted read-only receipts or observed state. Never repeat a write to manufacture confirmation or convert an unknown effect into success.

Reuse runtime/effect journals and scoped output storage. Keep large evidence behind authorized references with retention/deletion rules. Missing or expired evidence stays explicit. Define additive persistence and older-reader behavior before adding wire fields.

Acceptance: successful/failed/not-run checks, stale artifacts, restart, duplicate delivery, redaction, cancellation, and missing evidence are distinguishable. A successful tool call cannot forge task completion. Exposed evidence has consistent meaning on desktop, CLI, iOS, and Android. Any transcript/Remote change includes both native implementations, fixtures, and focused suites; claim the next Remote revision at merge.

Subagent follow-up: measure whether tool-heavy children hit their cap without a useful report. If reproduced, reserve a bounded final reporting allowance within the existing total budget. Include partial checks/blockers without extending mutation authority or labeling interrupted work verified.

### H2b — Complete protected task evaluation

Use the existing six cases: `old_only_constraints`, `superseded_instructions`, `buried_failed_tests`, `output_recovery`, `resumed_plans`, and `comfortable_window_control`.

The host adapter constructs legal transcript pairs, real scoped output handles, and real durable plan state. Oracles, controls, manifests, and receipts remain outside agent-readable/writable paths. Run verification after the task in an actual OS/container isolation boundary; Python `-I` is not that boundary. Restrict evaluation network access so grading material is unavailable.

Use fresh identical workspaces and isolated state per arm. Record immutable source/fixture hashes, harness commit, locks, model/provider/effort/options, prompt/skill/tool hashes, policy revisions, and cache preparation. Reject incompatible resume. For resumed plans, verify the complete host-observed mutation history; matching final state cannot prove that prohibited intermediate edits never happened.

Acceptance: existing 7 positive and 22 negative controls reach expected verdicts; attempts to read/change grading state are denied; corrupt receipts fail closed; output recovery proves an authorized actual read; no-op and deliberately harmful policy controls do not appear as improvements. Register executable suites in package/CI inventories. Keep the seven lifecycle replays as a separate gate.

### H2c — Run one measured pilot

Resolve one runtime model/provider/effort, one policy change, permitted endpoints, request/output limits, wall-time limits, and a cumulative spend ceiling in a new manifest before inference. The GPT-6.1 Sol choice for research subagents does not choose a deployed Aiden model or authorize benchmark spend.

Start with the existing six-task, two-replicate-per-arm design (24 task runs). This is a feasibility pilot, not a powered superiority claim. Predeclare acceptance criteria: no authority violations, no new failed task predicates, and the minimum practical quality/cost/latency improvement sought. Count all attempts and infrastructure failures, including foreground, summaries, warming, retries, advisors, children, selection, and reflection. Reserve conservative maximum request cost before dispatch and stop admission at the cumulative cap; routes without a usable price bound are ineligible for money-capped trials. Unknown billed usage remains unknown, and request/token limits remain independently enforced.

Report per-task outcomes and variation, with the baseline always eligible. Keep defaults if inconclusive. A useful pilot permits a larger held-out evaluation; it does not justify broad rollout. Freeze the next experiment before inspecting held-out results.

### H3 — Bring durable Bot sessions to the CLI deliberately

First document the portable-service boundary and profile ownership model. Target reuse of the desktop durable Bot-session core through CLI process, credential, and notification adapters. Audit the bundled dependency graph for Electron imports. If portability requires adding a Pi package, pin it to the audited 1.3.0 line and evaluate the addition separately; do not silently upgrade existing packages.

Preserve Bot homes, grants, schedules, and chats. Define explicit migration with backup/recovery before changing legacy Bot chat handling; never launch unattended work during migration. Negotiate session/routine/preset/memory/proactivity features only when their endpoints are wired and accepted.

Acceptance: desktop-host and CLI-host matrices agree for supported features; unavailable features remain honest. Test native capability fallback, durable send/resume/dismiss, routines, memory edits, restart, revocation, and duplicate requests. Run macOS/Linux CLI bundle/runtime tests and focused iOS/Android suites. Record physical pairing/background acceptance separately. If portability is blocked, publish the boundary and keep the slice open.

### H4 — Measure then bound transcript work

H4a records packaged 50-, 500-, and 2,000-message scenarios with representative tool activity/artifacts. Measure cold/warm chat open, streaming responsiveness, mounted rows, memory, event-loop delay, idle wakeups, and relevant read/write/transfer bytes. Stamp results with commit, dirty state, build, OS/hardware, power conditions, and scenario. Retain the initial-JavaScript budget.

H4b selects windowing or another bounded rendering technique from those measurements. Specify numeric budgets from the baseline before implementation, including a short-chat regression limit. Preserve scroll position, live-to-saved handoff, keyboard focus, find/copy, artifacts, selection, and accessibility. Coordinate loading with long-thread/cache-first plans rather than conflating rendering and transport limits.

Acceptance: repeatable packaged measurements meet declared budgets; long-chat interactions and reduced-motion/focus checks pass. Inspect both native consumers if shared transcript/transport changes. Do not infer latency or battery improvement from bundle size alone.

### H5 — Add explicit workflow improvement

H5a creates an evidence bundle and proposed lesson record. Keep workflow knowledge distinct from personal facts and Bot persona. A lesson candidate contains an applicability cue, precise operation, component/version, supporting run/check references, confidence, limitations, expiry/review state, and rollback lineage. Support no lesson, conflicting evidence, and withdrawal. Selection alone never proves causation.

H5b adds an explicitly invoked “Improve this workflow” action behind a default-off capability. Show task scope, editable skill/workflow surfaces, permitted tools, maximum runs/time/spend, and the resulting diff. Probe isolated fixtures or disposable workspaces; exclude real external mutations. A shared budget includes every child, retry, judge, and reflection. Cancellation revokes pending work.

Validate skill frontmatter, supported hooks, referenced helpers, capability declarations, and prompt size against Aiden's actual loader. A valid script is not automatically trusted. Host credential access, approvals, protected paths, network policy, and replay rules stay immutable.

Adoption is an explicit user action on a versioned, reviewable change after evidence exists. Include the unchanged baseline, allow rejection, and provide rollback. Do not silently insert all lessons into always-on context or promote them into executable/global skills. Record applicability and retrieval costs.

Acceptance: useful candidates can be adopted/rolled back; harmful/inconclusive candidates leave baseline active; cancellation/budget exhaustion stop the experiment; forged/expired evidence cannot authorize adoption; tool output cannot expand authority. Update concise onboarding and the feature-tour gallery only when the capability ships, including its own code-drawn illustration and art tests.

## Harness² ideas adopted and adapted

- Use [Propose–Probe–Compose](https://github.com/google-research/harness2/blob/1cfe254e8d25b15f37048c3730134686abe60335/harness2/core/recursion.py) as a bounded method. Its `4k` executions and `3k` improvement stages are not an ordinary-chat default or monetary cap.
- Use [evidence trees](https://github.com/google-research/harness2/blob/1cfe254e8d25b15f37048c3730134686abe60335/harness2/core/context.py) and [completion receipts](https://github.com/google-research/harness2/blob/1cfe254e8d25b15f37048c3730134686abe60335/harness2/core/runmark.py), adapted to Aiden's scoped storage, privacy, and retention.
- Use [evidence-supported reflection](https://github.com/google-research/harness2/blob/1cfe254e8d25b15f37048c3730134686abe60335/harness2/core/prompts.py#L1105-L1147), including confounded/no-effect/no-lesson outcomes.
- Change its [finals-only selection policy](https://github.com/google-research/harness2/blob/1cfe254e8d25b15f37048c3730134686abe60335/harness2/core/selection.py#L93-L112): retain baseline and permit abstention. Harness² adopts its sole final at `k=1` without a selector; that is not an improvement guarantee.
- Preserve Aiden authority. Harness²'s [Codex launcher](https://github.com/google-research/harness2/blob/1cfe254e8d25b15f37048c3730134686abe60335/harness2/substrate/codex.py) bypasses sandbox/approval boundaries, and its [experiment guide](https://github.com/google-research/harness2/blob/1cfe254e8d25b15f37048c3730134686abe60335/docs/EXPERIMENTS.md#L92-L110) documents rubric exposure. Do not copy that execution posture or assume benchmark gains transfer to Aiden.

## Validation and rollout

Run narrow suites before hosted CI. Confirm current script membership/native prerequisites at implementation time rather than copying old counts. Starting points:

| Surface | Behavioral validation |
| --- | --- |
| Memory, recovery, discovery, runtime receipts | Focused `memory-store`, `memory-context`, `assistant/tool-loop-guard`, `pi-tool-discovery`, `claim-check`, harness/effect tests; relevant `test:compaction`, `test:assistant-automations`, `test:mcp`, `test:compaction:evaluate` scripts |
| Evaluation | Frozen controls plus registered host-adapter, protected-verifier, isolation, accounting, and baseline/candidate tests |
| Advisor and CI receipts | Advisor/usage tests, CLI bundle/parity tests, diagnostic policy and `test:ci-policy` |
| CLI Bots/shared contracts | Bot-session/router tests, `test:aiden-remote`, CLI build/test/type-check, relevant iOS/Android suites and protocol fixtures |
| Transcript/verification UI | Mounted renderer/Playwright behavior, relevant native suites, packaged measurements, accessibility/reduced motion |
| Cross-cutting | Root/CLI types and scoped lint; broader integration/build checks where dependencies/contracts justify them; exact-head hosted CI |

Extend existing behavioral suites where possible. Register new files in package test scripts and the CI registry. Do not grow source-grep contracts or tests that mirror implementation. A passed retry remains a flake: rerun at most once and record spec, symptom, and run link without weakening gates.

Before UI work, read `GUI.md`, `docs/design-guide.md`, `docs/chatgpt-desktop-ui-inspiration.md`, and `docs/chatgpt-ui-element-specimen.html`, then use the appropriate Graphical skill. Settings follow `docs/settings-design-system.md`. Preserve semantic tokens, squircle actions, text-input focus rules, non-text keyboard focus, and the Memory SD-card icon. Update onboarding when setup, permissions, privacy, or core capabilities change.

Ship confirmed fixes independently after their gates pass. Add schemas compatibly; old readers degrade to unknown/not available. Keep experiments default off and reversible. Retention affects rebuildable metadata only, never source conversations or approved facts. Define migration backup/read compatibility before CLI durable Bot migration.

Update shared PR branches by merging main, preserve the union of test scripts, re-claim Remote revisions at merge, and wait for CI on the resulting exact head. Preserve uncommitted/unpushed work. Record physical/packaged acceptance separately from CI. Update this plan/index with each slice; archive only when required acceptance is complete.

## Separate Pi upgrade gate

Open only for a verified upstream requirement. Record the minimal reproduction, affected public API, pinned upstream change, compatibility risks, and why an Aiden integration fix is insufficient. Choose an exact candidate; update desktop/CLI compatible pins and lockfiles together. Preserve the frozen legacy adapter unless its migration is separately accepted.

Evaluate baseline/candidate with lifecycle/compaction replay, provider serialization, migration/reopen/rollback, cancellation/effect ownership, Bot sessions, CLI bundle layout/startup, and applicable task-quality trials. Do not mix the version change with a harness policy change. Keep the previous pin if inconclusive. No upstream publication or package upgrade is performed by creating this plan.

## Completion record

- [x] Source audit, independent verification, and chat sitrep completed.
- [x] Scope clarified: Aiden harness first; active Pi version fixed initially.
- [x] Plan, index entry, and project-memory note prepared.
- [x] H0 baseline/ownership refreshed for implementation.
- [ ] H1 corrective slices implemented and accepted.
- [ ] H2 evidence/evaluation pipeline implemented; separately scoped live pilot recorded.
- [ ] H3 CLI durable Bot parity implemented and accepted.
- [ ] H4 packaged baseline and justified rendering changes accepted.
- [ ] H5 explicit workflow experiments implemented and accepted.
- [ ] Applicable native, packaged, physical, and exact-head CI gates recorded; plan archived.

## Implementation baseline — H0 (2026-10-19)

Merged `origin/main` at `99df8a92a53a3bdd016a52f425729ab9eabc26a6`; integration commit `a9bb1876cd0c77aad166b1e252164585c760938d`. Platform: macOS arm64, Node v22.22.3. No packaged build or runtime feature configuration has been exercised yet. Active Pi pins remain 1.3.0 and the legacy alias remains 0.87.1.

Lock SHA-256: root `fbe057e0e1313cb721a6b4827488a0de6108537b5c4638f77de745cb26d8aa5b`; standalone CLI `dec2029c818166ca04ecbbc4cc71cc4b76467ea8a36f5e70784eb85da08e5495`.

Source recheck retains H1a (remaining-capacity admission), H1b (any-error counter), H1c (512 prefix), H1d (CLI unknown-usage no-op and minimal CI receipt), H2 (lifecycle completion is not acceptance), H3 (only bots/botFiles wired), and H4 (all loaded settled rows mounted). These are source findings; new packaged/live measurements are not claimed.

Ownership: H1 owns focused corrections; the existing compaction plan retains its implemented checkpoint/recovery behavior and pending signed/operator acceptance. The CLI plan's original delivery remains historical; H3 owns only durable-session parity. H4 owns measured rendering, coordinating with the long-thread plan's rendering proposal; payload compression and journal coalescing already merged are preserved. The broader performance plan remains unaccepted. Cache-first loading retains ownership of transport/loading state. Diagnostics owns privacy policy, H1d only safe receipt detail. Peer/mobile reliability owns background wake authority, which remains unchanged. H2 extends the frozen six-task research without rewriting its manifest.

Acceptance ledger: deterministic local checks, lifecycle replay, protected task quality, live pilot, packaged performance, native/physical acceptance, and exact-head CI are tracked separately. Live pilot provider/model and cumulative spend are awaiting user configuration; independent implementation proceeds.

H0 focused validation on the merged checkout: Assistant guard, discovery and advisor runtime suites: 36 pass; CI registry and required checks: 23 pass. Memory is being changed in H1a and its post-change acceptance is recorded separately. CLI capability/bundle and packaged/native baselines remain pending their slices; no current acceptance is inferred from historical counts. H0 review identified stale overlapping claims; dated reconciliation notes now exist in CLI and long-thread plans.
