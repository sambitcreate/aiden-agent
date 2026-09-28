# Whole-app performance audit and optimization ledger

Date: 2026-09-27 (America/New_York)
Baseline commit: `a9baa4aa3027893e5455043083465c34b4c8b4ac`
Branch: `feature/performance-audit`
Status: source audit complete — 40 ranked findings. [Batch 1 implementation and PR orchestration](batch-1.md) is in progress; hardware GPU/battery baselines remain pending.

## Scope and evidence rules

Five GPT Astra medium specialists cover desktop GPU/rendering, desktop processes/battery, iOS responsiveness, Android responsiveness, and shared storage/transport/runtime. Reports use the same checkout. The five specialists ran in two waves because the session supports three concurrent subagents.

The user's observation of high GPU use is the motivating symptom, not a quantified baseline. Source-confirmed work establishes a mechanism, not its share of measured GPU time or battery drain. Runtime profiling must establish that attribution. Historical measurements are explicitly dated and are not new measurements. Unmeasured values stay **not measured**, and after values stay **pending** until the corresponding implementation is tested.

## Specialist reports

| Area | Report | Status |
| --- | --- | --- |
| Desktop GPU, rendering, motion, perceived speed | [Desktop GPU](desktop-gpu.md) | Complete |
| Main process, helpers, wakeups, battery | [Desktop processes](desktop-processes.md) | Complete |
| iOS loading, mutations, rendering, lifecycle | [iOS](ios.md) | Complete |
| Android loading, mutations, rendering, lifecycle | [Android](android.md) | Complete |
| Shared storage, transport, streaming, agent runtime | [Shared data/runtime](shared-data-runtime.md) | Complete |

## Recommended starting sequence

Priority ranks proposed work; it is not measured energy attribution. Effort is a rough engineering estimate excluding physical-device acceptance: S = one focused change, M = several connected changes, L = architecture/protocol work.

| Order | Opportunity | Evidence IDs | Effort | First proof required |
| --- | --- | --- | --- | --- |
| 0 | Capture isolated baseline and deterministic counters | [Measurement protocol](measurement-protocol.md) | M | Reproducible idle/stream/navigation runs with process-separated GPU/CPU and actual device energy |
| 1 | Throttle ordinary hidden embedded browser tabs; retain explicit active-capture exceptions | DP-01 | M | Hidden local animation fixture quiets without breaking automation/capture |
| 2a | Eliminate full Remote-journal serialization from per-event budget accounting | SDR-1 | M | Exact byte-bound equivalence; ordered healthy-subscriber delivery under pressure |
| 2b | Make reconciled chat metadata a fast path instead of scanning all transcripts per update | SDR-2 | L | Constant unrelated-transcript reads without ghost rows, stale ownership or crash-recovery regressions |
| 2c | Isolate historical transcript rows, bound code highlighting, coalesce scroll work | DG-01/03/04 | M | Fewer historical row commits and scroll writes; exact final text and stable reader position |
| 3a | Remove Android draft/transcript disk work and selected-image processing from Main | AND-01/02/03 | M–L | Responsive typing/receipts/image selection with durable ordered writes and cancellation preserved |
| 3b | Publish iOS fresh chat independently of catalog; deduplicate progress bootstrap | IOS-03 | S–M | Held/failed catalog does not block chat display or weaken model authority |
| 4 | Bound helper work after timeout and await MCP teardown | DP-02/04 | M | Timed-out worker exits; hung clients cannot leak or hang quit |
| 5 | Bound stream queues, inactive view owners and transcript-cache retention | IOS-01/02 / AND-06 | L | Slow-consumer and disk-failure races retain exact order and admitted winners |
| 5b | Gate hidden Android tab work and flatten expanded workspace rows | AND-04/05 | M | Visible-content latency improves; composed rows scale with viewport |
| 5c | Reconcile ambiguous mobile operations before expanding optimism | AND-08 / iOS action matrix | L | Lost-receipt/restart fixtures never duplicate logical operations or discard newer drafts |
| 6 | Give offscreen HTML artifacts explicit lifecycle ownership | DG-02 | L | Reduced active previews with preserved interactive state on resume |
| 7 | Limit automatic schedule concurrency and helper residency | DP-03/05/06 | M–L | No active work eviction; bounded catch-up; warm-start cost measured |
| 8 | Render the shell sooner and split secondary routes | DG-10 / DP-07 | M–L | Earlier first paint with recovery/authority gates still intact |

Shared persistence batching (SDR-3/4), inline attachment migration (SDR-5), and cold Pi synchronization/session retention (SDR-6/7) follow measured accounting/index fixes; these need explicit durability and ownership contracts. Blur, shimmer and 3D quality are profiling experiments, not the first changes to make without attribution.

## Mobile optimism policy

“Immediate feedback everywhere” should mean cached/pending presentation everywhere it is safe, not declaring every remote action successful. Both clients already have optimistic send and Favorites paths. Preserve those and audit remaining actions individually.

- Navigation: display the correct instance-scoped cached content immediately, then revalidate; separate optional catalogs from transcript delivery.
- Reversible metadata: show an attempt-owned pending overlay, keep canonical revisions unchanged, and reconcile a definite rejection without replacing newer user intent.
- Send/create: show a local pending item with stable identity, preserve the latest draft on rejection, and reconcile an unknown server outcome before any retry. A new idempotency key can create a duplicate.
- Delete: hide/pending presentation may be immediate, but preserve rollback and authoritative cache-removal ordering.
- Stop, approvals, permissions, schedules, Git/file writes: acknowledge the tap immediately; label completion only after authoritative evidence. Never infer authority from a cache.
- Every path must cover success, definite rejection, timeout after commit, stale response, rapid repeated input, navigation/host switch, backgrounding, and process death where a durable attempt contract exists.

The [iOS action matrix](ios.md#optimistic-action-matrix) and [Android action matrix](android.md#optimistic-action-matrix) contain implementation-specific evidence.

## Before/after ledger

Append evidence as each optimization is implemented. Record exact before/after commits, hardware, OS, build configuration, fixture, measurement command, repeat count, and raw artifact location. Do not replace a baseline with a later run or report a proposed target as an achieved result.

| Item | Before | After | Status |
| --- | --- | --- | --- |
| DG-01/03/04: transcript/highlight/scroll | Full historical row traversal; unbounded block highlighting; immediate + scheduled follow. Runtime not measured | Pending | Proposed |
| DG-02 / DP-01: offscreen frames/browser | Mounted artifact frames; browser guests set `backgroundThrottling: false`. GPU/energy not measured | DP-01: native fixture policies false→true for 3 hidden guests; active capture/automation/recording pass. DG-02 pending; GPU/energy unmeasured | Browser [PR #282](https://github.com/sambitcreate/aiden-agent/pull/282), reviewed; artifacts proposed |
| DP-02/04: worker timeout / MCP quit | Timeout rejects request without killing worker; MCP close excluded from awaited quit group. Exit latency not measured | Pending | Proposed |
| DP-03/05/06: residency / discovery / schedules | No measured residency budget; serial tool discovery; no distinct-task concurrency cap in scheduler | Pending | Proposed |
| DG-10 / DP-07: first usable shell | App-info/provider reads and main recovery precede shell/window readiness. Latency not measured | Pending | Proposed |
| IOS-01/02: stream/cache bounds | Unbounded default AsyncThrowingStream queue; admitted chat map lacks aggregate eviction. Peak memory not measured | Pending | Proposed |
| IOS-03/06/07: loading / retries / cache | Chat/catalog tuple gates fresh publication; fixed 1 s progress retry; summaries encoded twice | IOS-03: fresh visible+durable chat before held catalog release, including 503; 212 XCTests pass. IOS-06/07 pending; no device timing | Loading [PR #283](https://github.com/sambitcreate/aiden-agent/pull/283), reviewed; other items proposed |
| AND-01/02/03: UI-thread work | Draft writes, detail cache persistence and selected-image conversion run on Main paths | AND-03: serial worker preparation; three emulator codec tests pass; 6400×4000 conversion samples to 6.4M decoded pixels versus 25.6M. AND-01/02 pending; RSS/energy unmeasured | Images [PR #284](https://github.com/sambitcreate/aiden-agent/pull/284), reviewed; local suite startup timeout still under investigation |
| AND-04/05/06/07: navigation / lists / live rendering | Both product surfaces composed; expanded workspace rows nested in one lazy item; activity-owned detail models; growing live-string work. Runtime not measured | Pending | Proposed |
| AND-08: optimistic unknown outcomes | Pending send key retained in memory; generic errors revert optimistic row; create calls default to fresh keys. Duplicate outcome not reproduced | Pending | Design and fault-reproduction prerequisite |
| SDR-1/2: stream accounting / metadata | SDR-1: 64 appends → 64 full snapshots; all payloads read on ordinary index update | SDR-1: 64 appends → 0 full snapshots, identical final byte sizes; 62 stream tests + 7,452 independent byte comparisons pass. SDR-2 pending | Accounting [PR #285](https://github.com/sambitcreate/aiden-agent/pull/285), reviewed; index proposed |
| SDR-3/4/5: persistence / CLI / attachments | Whole retained snapshots and chats rewritten; CLI replacement performs two atomic writes/four explicit fsync calls. Runtime not measured | Pending | Proposed |
| SDR-6/7: Pi history / residency | Context rebuilt for each missing message; session map has no idle capacity policy. Runtime not measured | Pending | Proposed |

## Activity log

- Created isolated worktree and audit branch from baseline above; original checkout was clean.
- Read project memory and existing performance/long-thread plans. Historical July findings require source revalidation; do not carry them forward as current defects automatically.
- Started first three specialists. No product source changes, dependency installation, catalog refresh, provider traffic, or private chat inspection.
- Completed desktop GPU/process and iOS reports; started Android and shared runtime specialists. Added [measurement protocol](measurement-protocol.md) and [source/environment inventory](baseline-inventory.json).

- Shared data/runtime report completed: seven findings, including independently spot-checked all-transcript index reads. Preserved transcript-free summary endpoint and existing stream backpressure as explicit non-findings.
- Android report completed: eight findings and an action-level optimism matrix. Spot-checked draft and image preparation call paths. All five specialist reports now complete (10 desktop GPU + 8 desktop process + 7 iOS + 8 Android + 7 shared runtime findings).
- Updated the existing master plan, plan index and project memory; retained historical audit evidence and added current corrections.

## Coverage and validation limits

This is a risk-focused deep source audit across five domains, not an assertion that every line of the repository or third-party runtime was inspected. The [inventory](baseline-inventory.json) records checkout identity and source counts. No product behavior, UI, API, dependency or configuration changed; new runtime tests are therefore not warranted for this documentation pass. Root dependencies are absent in this new worktree. Application, Electron, iOS and Android test/build suites were not executed, and existing test references in specialist reports are proposed validation, not new passes.

No production profile, microphone, connected account, live provider call or model-catalog fetch was used. Runtime GPU attribution, packaged startup/frame-time measurements, physical-device energy, and manual visual/accessibility acceptance remain open. Optional features such as voice, browser capture, terminal, device streaming and scheduled tasks require their own active/idle fixtures; their presence alone does not prove idle drain.

Documentation validation passed: `git diff --check`; 13 relative Markdown file links resolve; 104 fully qualified or Android-aliased source anchors reference existing files and valid line numbers; baseline inventory parses as JSON. This anchor check verifies locations, not the correctness of every claim. Root independently spot-checked the browser throttle, worker timeout, transcript scroll/reveal, iOS catalog coupling, Android draft/image Main paths, and shared index scan.
