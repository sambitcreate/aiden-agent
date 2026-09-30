# Remote stream budget accounting

SDR-1 implementation against `a9baa4aa3027893e5455043083465c34b4c8b4ac`.

The budget check no longer deep-clones and serializes retained event history on each append. Events are serialized once for their UTF-8 size; a weak cache supplies that same size when trimming. Newly appended payloads are cloned into journal ownership, and restore sizes are measured after legacy normalization. Existing per-stream event totals remain the accounting source.

A shared snapshot envelope serializes only bounded metadata: at most 256 stream records and 1,024 retained turn identities. Empty event-array brackets are already in the envelope; cached event totals and the exact number of array commas complete the compact snapshot size. This deliberately avoids a global increment/decrement ledger spread across deletion, pruning, revocation and deferred-delivery cleanup. State and timestamp updates happen before enforcing the budget, so the check includes their final serialized sizes.

Aggregate pressure keeps the existing oldest-terminal eviction and largest-journal trimming order, deferred terminal delivery protection, replay sequences and snapshot recovery. Each removal rechecks bounded metadata, without revisiting retained payloads. Array shifts and candidate sorting remain; this is not a deque rewrite. Persistence still clones snapshots and runs with the same single-flight coalescing, durability and error behavior. No schema, endpoint, native-client or onboarding change.

## Reproducible measurement

Run `node_modules/.bin/tsx docs/performance/remote-stream-accounting-benchmark.mts "$PWD" /tmp/stream-accounting.json` in either checkout. The same script ran before and after, with no persistence callback or subscribers, one warmup plus five measured trials, and 64 small appends. Runtime: Node v26.10.0, Darwin 27.0.0 arm64. Inputs are synthetic; no application state or provider traffic is used.

| Prior retained chunks | Snapshot bytes before → after appends (identical both revisions) | Full snapshot calls before → after | Median elapsed before → after |
| --- | --- | --- | --- |
| 0 | 368 → 11,561 | 64 → 0 | 2.767 → 0.212 ms |
| 32 × 128 KiB | 4,200,168 → 4,211,361 | 64 → 0 | 93.925 → 0.223 ms |

Before samples (ms): `[2.769, 2.763875, 2.637083, 2.766583, 2.864084]`; retained-history samples `[93.924875, 90.031208, 93.034, 104.148833, 96.301417]`. After samples: `[0.248875, 0.248666, 0.212458, 0.210042, 0.1905]`; retained-history samples `[0.260792, 0.222958, 0.221417, 0.216959, 0.262041]`.

Snapshot-call counts and matching serialized lengths are deterministic evidence. Timing is exploratory: other builds were running on the host, this is a short synchronous fixture, and subscriber latency, allocation/RSS, event-loop delay, energy and GPU usage were not measured. No battery or whole-app speed claim follows. Persistence-related full-history work (SDR-3/4) remains outside this change.

## Validation

The existing registered stream suite gains independent `Buffer.byteLength(JSON.stringify(service.snapshot()), "utf8")` oracles for Unicode/escaping, timestamp widths, state changes, source/snapshot mutation isolation, normalization on restore, expiry, revocation, retained turn identities/index eviction, per-stream count/byte trimming, repeated aggregate pressure, terminal eviction and deferred terminal replay cleanup. Existing delivery, approval/question, cancellation and persistence tests remain in the suite. Under the budget, all 120 Unicode deltas are retained exactly; pressure retains contiguous newest sequences and the terminal event under the existing policy.

Inspected iOS `AidenRemoteContract.swift` / `AidenRemoteClient.swift` and Android `AidenSSEParser.kt` / `AidenRemoteClient.kt`: DTOs, sequence recovery and terminal delivery rules are unchanged. Native builds/tests are not required for this internal accounting change. Focused stream, full Remote tests, TypeScript and scoped ESLint results are recorded in `.memory/perf-stream-accounting.md`.
