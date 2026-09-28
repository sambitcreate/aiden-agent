# Shared data, Remote transport, agent runtime, and CLI audit

Baseline: `a9baa4aa3027893e5455043083465c34b4c8b4ac` (2026-09-27). Audit only; no product edits, user-state reads, provider requests, or catalog refreshes. Evidence below is from tracked source. Priorities rank optimization work, not measured incident severity. **Runtime latency, CPU, RSS, battery, disk-write volume, and before/after gains are unmeasured.** Complexity and operation counts are static findings; no dependency installation or tests were run (this isolated checkout has no `node_modules/.bin/tsx`).

Reviewed root instructions, the performance and long-thread plans, and relevant Remote backpressure, journal deletion ordering, provider cancellation, subagent ownership, mobile recovery, durable attachment/tool-output, and Pi pin memories. Historical fixes are treated as context, not current defects. Other audit lanes own renderer/GPU, helper lifecycle, and native-client implementation.

## Ranked findings

| ID | Priority / confidence | Area | Cost mechanism | Effort |
| --- | --- | --- | --- | --- |
| SDR-1 | P1 / high | Remote live streaming | Full aggregate clone/serialization for every event, including before subscriber delivery | Medium |
| SDR-2 | P1 / high | Shared chat store | Ordinary listing and every metadata update sequentially reread all indexed chat bodies behind one queue | High |
| SDR-3 | P1 / high | Remote persistence | Whole retained journal replacement at completed-write cadence | Medium–high |
| SDR-4 | P1 / high | CLI daemon | Remote snapshot save synchronously reads and fsyncs on the event loop; two atomic writes per save | Medium |
| SDR-5 | P2 / high | Long chat storage | Whole pretty-printed chat, including inline attachments, rewritten on terminal mutations | High for attachment migration; low for compact JSON |
| SDR-6 | P2 / high | Pi first synchronization | Context rebuilt for every missing visible message, producing quadratic cold synchronization work | Medium |
| SDR-7 | P2 / medium | Pi long-lived process | Open session objects retained until chat deletion, without an idle capacity policy | Medium–high |

### SDR-1: Aggregate-budget checking itself scales with retained history on every delta

Evidence: `main/services/aiden-remote-streams.ts:597–613` deep-clones every stream's event array in `snapshot()`. Each `append()` calls `enforceAggregateBudget()` at line 868, **before** subscriber flush at line 871. The budget function at lines 894–936 calls `JSON.stringify(this.snapshot())` on every append, then repeats that whole operation after each eviction or individual event removal under pressure. This applies even if no disk persistence callback is supplied. Per-event size is already recorded at lines 858–866, but aggregate checking does not reuse it. The bounds at lines 47–55 are 256 streams, 4,096 events/stream, 8 MiB events/stream, and 16 MiB aggregate compact snapshot.

For retained serialized size S, a small incoming delta adds O(S) synchronous clone/stringify work before delivery. Before retention saturates, N equal-sized events in an otherwise empty journal entail a sum of growing prefixes, O(N²) bytes processed; this is bounded by retention, not an indefinitely growing leak. Under pressure, K individually trimmed events can trigger O(K·S) additional work. Heap churn includes cloned objects and the serialized string, beyond retained journal bytes.

Current mitigations: bounded retention; no-op timeline suppression; subscriber cursor/backpressure logic; terminal-delivery protection. None remove this accounting work.

Recommendation: maintain exact serialized-byte accounting for event arrays, stream envelopes, commas, changing state/timestamps, and turn-index entries; perform expensive full verification at restore/test boundaries. Batch pressure trimming using recorded event byte sizes. Do not approximate away UTF-8/JSON escaping or use the sum of payload bytes alone. Preserve sequence gaps/snapshot recovery, terminal replay protection, and turn-index retention. A ring/deque may additionally avoid `shift()` movement but is secondary to full-snapshot serialization.

Validation: extend `aiden-remote-streams.test.ts` with many small deltas, multiple retained terminal streams, Unicode/escaping, repeated aggregate pressure and blocked terminal subscribers. Independently compare accounting with actual serialized bytes. Baseline/after benchmark: append 1k/4k synthetic deltas with 0/8/15 MiB existing retention; measure time to healthy-subscriber write, event-loop delay, allocated bytes and full-snapshot visits. Target is O(new event bytes + actual removals) per append, not a promised millisecond improvement.

### SDR-2: The shared index still expands into every transcript for ordinary operations

Evidence: `main/services/chat-store-core.ts:351–384` reads the index and sequentially calls `readChat()` for every row before returning metadata. `readChat()` reads and parses the entire file at lines 462–475. `list()` at lines 705–715 invokes this before filtering workspace; `listByBot()` at lines 727–728 also filters afterward. `updateMeta()` at lines 612–617 invokes the same scan after a changed chat is written; `writeChatAndMeta()` at lines 620–628 uses it. All ordinary reads and writes share `operationTail` at lines 112–123, so an unrelated `get()` (lines 731–732) waits behind these scans. The CLI daemon explicitly uses this same store (`packages/cli/src/daemon-chats.ts:33–36`).

Static baseline: one ordinary list/update requires O(total indexed transcript bytes) read/parse work, even for one workspace or a one-line title mutation. The sequential filesystem reads and common queue amplify cross-chat latency. This is stronger than simply saying that pretty JSON is slow.

Current mitigations: durable transaction markers, authoritative payload reconciliation, privacy migration, atomic fsync/rename publication. Crucially, Remote summary pages already have `listSummaryMetadata()` at lines 722–724 and `readSummaryIndex()` at lines 387 onward: **do not claim every Remote summary request reads all transcripts**. Those reads still wait on the shared queue, however.

Recommendation: make an explicitly reconciled metadata index the fast path after startup/recovery, reconcile dirty chat IDs from the transaction journal, and reserve all-transcript repair for actual invalidation. Establish external-file-edit/corruption semantics before caching. A later per-chat queue plus narrow index commit queue can improve independent-chat concurrency, but do not simply remove the current serialization.

Risks: trusting schema-valid stale rows revives ghost chats, wrong workspace ownership, deleted metadata or stale titles. Preserve transaction roll-forward, migration behavior, cancellation fences and publication ordering. Validate deletion racing append/title updates, restart after each publication failure, malformed/mismatched payloads, external edits and failed directory sync. Existing `chat-store-core.test.ts` and Remote summary tests are relevant. Baseline/after: synthetic 10/100/1,000 chats with fixed metadata and increasing transcript sizes; count payload bytes read during list, title change and an unrelated queued get. Expected fast-path change is independent of unrelated transcript size; wall-time gains remain unmeasured.

### SDR-3: Remote snapshot persistence has single-flight coalescing but no time-based batching

Evidence: every append calls `persist()` (`aiden-remote-streams.ts:890`); lines 617–636 immediately snapshot when idle and repeat while dirty after each completed write. `snapshot()` clones all retained streams. Desktop wiring passes this to `streamStore.save()` (`main/services/aiden-remote-service-main.ts:463`). `main/services/data-store.ts:459–504` pretty-serializes the snapshot, writes a temp file, syncs it, renames it and syncs the directory. This is whole-journal replacement, independent of the SDR-1 accounting clone.

Baseline: at most one active persistence loop, but if storage completes between deltas nearly every delta can cause a complete replacement. If deltas arrive faster, writes coalesce only over the in-flight duration. A retained old stream also increases writes for a new stream. This is O(sum of snapshot sizes actually persisted), not necessarily one write per token.

Recommendation: first measure byte/write frequency; consider bounded checkpoints with mandatory durable barriers for control/terminal/shutdown events, or append/checkpoint storage with bounded replay. A debounce without maximum latency may starve persistence during continuous output. Treat accepted idempotency outcomes separately from disposable progress; they must not inherit a relaxed durability window.

Risks: a checkpoint window changes crash-replay guarantees; do not describe it as behavior-neutral. Preserve Last-Event-ID replay, terminal truth, revocation cleanup, `settlePersistence()` error reporting, crash interruption and ownership. Compact wire-budget bytes and pretty disk bytes differ: retain appropriate validation against both physical and logical limits when changing serialization.

Validation: fake-clock continuous streams and forced writer stalls; crash/reopen at every checkpoint boundary; held terminal flush, disk-full and revoked-device cases; existing `aiden-remote-streams.test.ts` and DataStore resilience tests. Baseline/after measure total bytes written, fsync count, retained heap, maximum lost progress prefix under the expressly chosen durability contract. Run both native recovery suites for any observable replay change.

### SDR-4: CLI Remote persistence performs blocking filesystem work despite its async interface

Evidence: CLI Remote wires `remote-streams.json` through `JsonStore` (`packages/cli/src/remote-chats.ts:53–58`). `JsonStore.update()` (`packages/cli/src/state.ts:99–108`) acquires a lease, loads the existing full JSON even for replacement saves, then calls `atomicJson()`. `load()` is `readFileSync`/parse (lines 5–9, 97); `atomicJson()` uses synchronous write, file fsync, rename and directory fsync (lines 13–23). Lease acquisition itself writes `owner.json` through the same atomic function (line 68).

Thus a successfully admitted replacement save executes **two atomic JSON writes and four explicit fsync calls**, plus rereads/parses the previous snapshot, on the daemon's JS thread. `async`/Promise wrapping does not offload these calls. Combined with SDR-3, this can delay unrelated SSE delivery, cancellation, RPC or schedule callbacks on slow/busy storage. This is an operation-count claim, not measured delay. The shared desktop DataStore uses asynchronous filesystem calls, so do not generalize this blocking-I/O claim to desktop.

Recommendation: an async, ordered durable writer for daemon hot stores; skip reading the prior value for true replacement only if its corruption/authority semantics permit; retain cross-process exclusion and owner identity. A worker is another option when JSON encoding itself dominates. Low-frequency CLI setup/config commands need not be optimized first.

Risks: never remove fsync or leases to make a benchmark faster; await durability before acknowledgment and preserve stale-lock recovery. Validate timer responsiveness under injected slow storage, contention between independent processes, write/read-only failures and process death before/after rename. Extend CLI parity/runtime coverage and the shared stream suite. Compare p95 event-loop delay and stream cadence alongside identical crash-survival behavior. Existing CLI tests require the package build/dependencies; not executed here.

### SDR-5: Terminal chat mutations rewrite accumulated inline data

Evidence: `main/services/chat-store-core.ts:558–580` serializes the entire chat with indentation into an atomic staged file and durably publishes it. `readChat()` loads the complete representation. The current attachment contract still validates inline bodies (`main/services/attachment-contract.ts:5–18`); the durable-attachment memory explicitly describes independent inline bytes on copy/fork, not a migrated blob store. `main/services/llm-client.ts:3578–3649` persists assistant output on terminal paths, not each delta.

Baseline: O(chat bytes) per terminal append or metadata-changing chat rewrite; across growing history this sums to growing prefixes. Per-message attachment bounds do not bound accumulated chat size. Serialization allocates a full string while the object is live. Disk durability adds intentional sync latency; SDR-2 adds a separate all-chat scan.

Recommendation: measure compact JSON as a small compatible reduction, then implement durable attachment blobs plus metadata references and lazy IPC fetch under the existing durability plan. Do not truncate Pi protocol data or tool calls; journals and replay need exact authoritative records. Blob publication, chat publication, rollback, copy/fork survival, deletion and garbage collection must be transactional. No migration or SQL replacement is justified solely by this audit.

Validation: synthetic long image/text chats, copy/fork after source deletion, failed blob/chat/index publications, crash/restart and old-format reads. Measure serialized bytes, terminal persistence latency and peak heap independently of SDR-2. Existing atomic chat-store and attachment/copy tests provide invariants, not current performance budgets.

### SDR-6: Cold visible-history synchronization repeatedly rebuilds context

Evidence: `main/services/pi-compaction-session-store.ts:389–430` obtains existing markers once, then for **each missing** visible message calls `session.buildContext()` to inspect only its tail before appending a transaction. `main/services/pi-session-port.ts:135–173` fetches the full branch, scans metadata, locates compaction, then projects the effective context; line 176 onward obtains branch entries. Generation calls the sync for prior visible messages at `main/services/llm-client.ts:2414`.

Baseline: when N visible messages lack markers (newly created/recovered journal), a growing context is rebuilt N times: O(N²) entry visits before the first model response in the uncomplicated no-compaction case. In ordinary already-synchronized continuation, markers skip most work; this is **not** claimed as quadratic on every turn.

Recommendation: build the initial effective tail once and update it as successful transactions append, or expose a tested tail projection API. Preserve custom entry projectors and compaction behavior; do not infer the tail merely from the last raw journal entry. The existing tail equality check prevents duplicated assistant output after a crash between durable Pi commit and visible marker publication, so removing it is unsafe.

Validation: extend Pi compaction/session-port behavior tests with 100/1,000 missing messages, last-assistant-without-marker recovery, custom projected entries, partial transaction failure and rerun idempotency. Count buildContext invocations and entry visits; verify identical effective context and markers. First-response latency and allocations remain unmeasured.

### SDR-7: Pi session retention has no idle eviction policy

Evidence: `PiCompactionSessionStore` owns a strong `sessions` map (`main/services/pi-compaction-session-store.ts:730`), returns cached instances at lines 861–864 and installs opened sessions at line 974. The map removes entries in chat deletion at line 1108; the production singleton is at line 1130. No idle eviction/capacity path appears in this class. This proves retained session-object count grows with distinct opened chats until deletion/restart; it does **not** by itself prove the retained bytes of the underlying Pi implementation.

Current mitigations: reuse avoids journal reopen cost, `opening` single-flights concurrent opens, quarantine deliberately retains uncertain recovery ownership. Recommendation: first heap-profile synthetic sequential opens and post-GC retaining paths. If material, add explicit active leases and bounded idle LRU eviction that reopens durable state. Never evict sessions with active generation, unsettled storage or quarantine recovery, and never use journal deletion as cache eviction. Validate reopen equivalence and branch/transaction authority. Baseline/after targets should be retained idle session count/bytes versus reopen latency; no measured memory-saving claim is made.

## Revalidated non-findings and existing safeguards

- Remote slow-subscriber handling is already fixed: `aiden-remote-streams.ts:1685–1784` uses a retained cursor, stops on refused writes, resumes on drain, and times out stalled clients. Do not re-report the historical unbounded socket queue as current. Aggregate trimming still warrants SDR-1, independently of socket backpressure.
- Ordinary Remote summaries already use a transcript-free projection. Full chat detail still has bounded wire output and attachment metadata projection; wire limits do not mean its underlying disk read is paginated.
- Chat persistence now has file and directory sync plus transaction recovery. The older performance plan's blanket “implementation not started” label cannot be taken to mean durability is absent.
- Chat files are not rewritten per token; Pi journals are append/transaction-oriented. No-op tool timeline updates were already suppressed. Durable tool-output spill storage exists; avoid recommendations premised on raw tool stdout being copied into every timeline event.
- Provider hook cancellation and subagent shutdown ownership fixes are recorded and must remain intact. This audit does not propose faster cancellation by dropping ownership or returning success before verified cleanup.
- No gzip/SSE batching recommendation is ranked without transfer/latency evidence. Compression is secondary to eliminating avoidable local full-history work; changing framing/projection requires iOS and Android parity checks.

## Proposed measurement order and acceptance

1. Instrument synthetic Remote append budget accounting separately from persistence. Establish first healthy subscriber latency, event-loop delay, allocations and bytes serialized at several retained sizes.
2. Instrument chat store payload read counts/bytes and queue wait for list, append, title update and unrelated get. Separate warm filesystem cache from parse/serialization CPU.
3. Run the same stream fixture through desktop asynchronous persistence and CLI synchronous persistence with equivalent durable semantics; report p50/p95/p99 and write/fsync counts, not only average throughput.
4. Measure cold Pi synchronization and idle-session retention after GC. Record history length, compaction state, dependency pin, hardware and filesystem with each result.

Before/after performance baselines must use synthetic isolated directories and identical correctness fixtures. No runtime numbers are supplied in this static report. Any implementation change must retain durability/error acknowledgment, ordering, idempotent admission, stream ownership and native-client recovery contracts. Neither plan status nor source implementation was changed by this audit.
