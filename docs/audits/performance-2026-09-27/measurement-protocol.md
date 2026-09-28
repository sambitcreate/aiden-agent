# Reproducible before/after measurement protocol

Status: proposed protocol, not executed performance results. Baseline is the commit in [the audit ledger](README.md). Use synthetic data and isolated application state. No live model request is necessary for stream replay.

## Keep comparisons valid

Record commit and dirty-state hash, app/Electron/native build versions, release/debug mode, hardware, OS, display refresh rate, window size, power source, low-power mode, thermal state, fixture seed and tool configuration. Compare the same hardware and build mode; run AC and battery separately. Close unrelated heavy workloads and let the device cool. Warm caches explicitly for warm runs; reset only the disposable fixture for cold runs.

For latency, warm up twice, collect at least 20 samples per scenario, and report median/p95 plus all observations. Use at least five 60-second settled-idle samples per state after a 30-second settling period. For energy, use longer fixed-duration runs on physical devices and repeat at least three times; record the run duration. These sample sizes are initial lab protocol choices, not claims of statistical significance. Investigate variance before calling small changes wins. Never compare an instrumented debug baseline to an uninstrumented release after-run.

Record feedback latency separately from server acknowledgement and authoritative completion. Optimistic rendering should improve feedback without changing the meaning of saved, approved, executed, or delivered.

## Scenario matrix

| Scenario | Fixtures / state transitions | Capture |
| --- | --- | --- |
| Desktop startup | Cold/warm; cached providers; slow/failing provider metadata; no connected services | First shell paint, composer usable, provider-ready, main event-loop delay, initial JS bytes |
| Desktop idle | Empty chat, completed long chat, Settings, Review closed/open; visible, blurred, minimized, closed-to-tray | Per-process CPU/GPU time, wakeups, compositor frames, app-owned RAF/timers, child launches, RSS |
| Embedded browser | 0/1/5 tabs; static page vs synthetic animation; switch/hide panel | Per-tab renderer/GPU work and continued page functionality |
| Streaming | 100/500 settled turns; deterministic 2k/10k/100k character streams with prose/code/math/tool deltas | Frame p50/p95/p99, long tasks, React commits, parser calls, scroll writes, IPC events/bytes, disk writes/bytes |
| Artifacts and media | 0/1/10 offscreen HTML artifacts; bounded image gallery; scroll/open/expand/collapse | Active frame count, decode/raster time, GPU memory, accessibility/focus preservation |
| Workspaces and processes | Small repo/large synthetic repo; Review idle/churn; 0/4 terminals; healthy/hung MCP | Git/helper counts, watcher wakeups, terminal throughput, cancellation-to-quiescence, cleanup after quit |
| Voice and schedules | Cold/warm local transcription; timeout/cancel; 20 missed schedules | Main responsiveness, worker lifetime/RSS, queue concurrency, shutdown deadline |
| Mobile navigation | Cache miss/hit; 50/250/1,000/2,000 chat summaries; switch Bot/chat/workspace/host | Tap-to-feedback, tap-to-usable-content, requests/bytes, cache hit rate, allocations, scroll jank |
| Mobile mutations | Send, rename, favorite, create, move, delete; success, definite failure, timeout after commit | Immediate pending UI, stable identity, rollback correctness, draft preservation, duplicate effects |
| Mobile stream/lifecycle | Burst stream; disconnect/reconnect; foreground/background/foreground; host switch | Queue depth, projection count, frame jank, reconnect rate, active jobs/sockets, memory plateau |

## Tools and acceptance

Desktop: use a production-equivalent isolated build with Chromium Performance/React profiling for attribution, macOS Instruments for process/energy observations, and explicit counters for app-owned work. Keep separate uninstrumented runs for outcome numbers. Do not infer GPU utilization from CPU percentages. Use privileges only if already available; lack of a privileged energy tool is a measurement limitation, not zero consumption.

iOS: physical-device Instruments Time Profiler, animation/hitch and allocation traces plus XCTest clock/memory measurements. Android: release/profileable build, Perfetto/system trace, frame timing and allocation measurements; validate optimism with deterministic coroutine/network tests. Emulator/simulator timings can help development but cannot close battery acceptance.

Existing diagnostics already provide bounded event/error journals: `main/services/diagnostics-contract.ts:5`, `main/services/process-diagnostics.ts:48`, and `renderer/lib/dev-log.ts:59`. They do not by themselves constitute a GPU/frame-time/energy benchmark. Extend the existing privacy-safe mechanism with bounded counters where necessary; do not log every token, prompt, title, path, payload or credential. The packaged diagnostics script verifies journal operation, not a performance budget.

Use the historical [chat-summary benchmark](../../testing/aiden-on-the-go/chat-summary-performance.md) as fixture design and prior evidence only. Its September 1 numbers are not the baseline for this checkout.

Initial proposed invariants: no app-owned continuous render loop after a static surface settles; no duplicate mutation on unknown outcome; no stale host response overwriting the current host; one scroll write per frame at most; bounded stream buffers/cache memory; no background UI polling without an active consumer. Necessary heartbeats and user-owned background tasks need explicit budgets, not a blanket stop policy. Relative CPU/GPU/energy targets should be set after the baseline, rather than inventing a promised percentage reduction.

## Per-change evidence template

```markdown
### <audit finding ID>: <change>
- Status: proposed / instrumented / implemented / verified / reverted
- Before SHA and after SHA:
- Hardware, OS, build, power, thermal state:
- Scenario, seed, sample count, commands/tools:
- Before: raw artifact, median/p95 or counter totals
- After: raw artifact, median/p95 or counter totals
- Difference and variance:
- Behavioral tests and failure/race scenarios:
- Mobile/server compatibility evidence where applicable:
- Risk, tradeoff and rollback:
```

After each implementation, update both this audit's ledger and the relevant specialist item. Preserve failed experiments and their explanation. A functional test pass does not fill a missing energy measurement.


## Reproduce the Remote append counter fixture

Use the repository's lockfile-installed `tsx` runner; plain `node` cannot execute all TypeScript constructs in the imported service on the supported Node line. Set `fixture` to this audit checkout's helper, `target` to the checkout being measured, and `output` to a new writable JSON path. Install the target checkout's pinned dependencies with `npm ci` if absent. The helper itself performs no network or persistence work.

```sh
fixture="/absolute/path/to/audit-checkout/docs/audits/performance-2026-09-27/evidence/stream-baseline.mts"
target="/absolute/path/to/checkout-being-measured"
output="/tmp/aiden-stream-reproduction.json"
"$target/node_modules/.bin/tsx" "$fixture" "$target" "$output"
```

Measure baseline `a9baa4aa3027893e5455043083465c34b4c8b4ac` and accounting implementation `c4f195f4a5fd98dfd0a54b141e2a503e3c6b4797` in separate checkouts, using the same fixture and different output paths. Expected mechanism evidence is 64 versus 0 full snapshot calls for each 64-append scenario; the final serialized sizes must agree. Do not overwrite the original evidence files with reproduction timings.

The command was re-executed during review using the browser worktree (its stream service is unchanged from baseline) and the accounting worktree, each with its own installed `tsx`: both scenarios reproduced 64→0 calls and identical final sizes (11,561 and 4,211,361 bytes). Node 26.10.0, Darwin 27 arm64; exploratory timings remain separate from physical-device performance acceptance. Local reproduction artifacts: `/tmp/aiden-performance-batch-1/cycle-1/benchmark-{before,after}-repro.json`.
