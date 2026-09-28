# Desktop processes, startup, idle work, and helper ownership

Audit date: 2026-09-27. Source baseline: `a9baa4aa3027893e5455043083465c34b4c8b4ac`. Audit only; no product changes or real-user runtime actions.

## Scope and evidence limits

Reviewed Electron main startup/shutdown, browser guests, voice utility process, MCP ownership, schedules, terminal traffic, filesystem watchers, and recurring maintenance. Read repository `AGENTS.md`, the main checkout's `.memory/PROJECT-CONTEXT.md` (the isolated worktree has no copy), and `docs/plans/performance-stability-efficiency-plan.md`. That July plan is historical: several of its findings have already been mitigated and must not be copied as current defects.

All findings below are **source-confirmed mechanisms**, with runtime severity still to be measured. No packaged app, microphone, authenticated MCP connection, model download/catalog refresh, actual schedule, or user browser was run. No CPU, RSS, energy, launch-time, or wakeup measurements were collected. Timer periods and operation counts are static baselines, not observed OS wakeups. An `unref()` timer still executes while Electron remains alive; conversely a configured timer does not prove measurable battery drain. Tests were not run: this audit changes documentation only, and the isolated checkout has no installed `node_modules/.bin/tsx`.

## Prioritized findings

### DP-01 — P1: inactive browser guests explicitly retain unthrottled execution

**Evidence:** `main/services/browser/service.ts:804–813` creates every embedded tab with `backgroundThrottling: false`. `:891–912` hides/detaches a guest without changing that policy or closing its webContents; `:920–922` hides other tabs when presenting one. `:938–958` shows actual closure is a separate lifecycle. The tab count has an explicit bound at `:800–801`.

**Mechanism / baseline:** each live inactive tab can retain its page's timers/animations and related work instead of receiving the normal background-throttling policy. This applies to ordinary tabs, not only an active recording/capture operation. The resulting CPU and memory depend on loaded pages; a blank page is not evidence of expensive idle work. The source proves the policy, not a particular watts or wakeups figure.

**Existing mitigation:** sandboxing, per-workspace tab cap, explicit guest close, timer cleanup, and document ownership. Hiding tabs prevents input/visual presentation. None of these restores background throttling.

**Proposed optimization:** default ordinary guests to normal throttling; acquire a temporary unthrottled lease only for active capture/recording/automation that demonstrably needs it. Release the lease on success, cancellation, crash, and tab close. Consider idle guest discard separately after measuring reload cost.

**Risk:** throttling can slow automation waiting on page timers and break capture on some Linux hosts. Preserve the documented Linux hidden capture host at `:899–911`; test automation/capture explicitly rather than globally freezing every hidden guest.

**Before/after measurement and tests:** use isolated local fixture pages (idle, 60 Hz animation, timer-heavy) with 1 and several tabs, active/background/hidden/minimized states, and no external network. Record process-tree CPU, timer/RAF counts, guest RSS and frame production for five-minute windows on AC and battery. Extend browser behavioral tests with lease restoration and close/cancel cases; packaged Electron test should observe hidden fixture callback frequency and prove active recording stays correct. Acceptance: ordinary hidden guest activity falls materially, temporary leases return to zero, and capture/navigation output remains correct.

### DP-02 — P1: a local transcription timeout does not stop its native work

**Evidence:** `main/services/parakeet-process-core.ts:9` sets the request deadline to 120,000 ms. Its timeout callback at `:68–71` only deletes the pending entry and rejects; `dispose()` at `:120–126` is where the port is actually killed. `main/services/parakeet-worker.ts:47–53` calls synchronous transcription; `main/services/parakeet-engine.ts:84–88` performs native `decode`. `main/services/parakeet.ts:75–84` reuses an existing client; its normal transcription error path does not invalidate the client. Explicit active cancellation does invalidate/kill it through `disposeClientIfCurrent`.

**Mechanism / baseline:** a 120-second timeout bounds the caller's wait, not the utility process's CPU or lifetime. A stuck decode can continue after the UI receives failure. A subsequent request can target that same busy worker. This is conditional on a slow/hung worker, not a claim that ordinary transcription runs for 120 seconds.

**Existing mitigation:** isolated utility process, single-flight launch, serialized transcription lane, explicit active-cancel process disposal, generation fencing, and request correlation. The old plan's claim that native transcription normally blocks Electron main is no longer correct.

**Proposed optimization:** make timeout invalidate and terminate the exact process generation, reject all its outstanding requests, and require a new client for subsequent work. Record categorical timeout/termination outcome. Use a bounded exit acknowledgement before admitting the replacement if needed to prevent transient overlapping native decoders.

**Risk:** status/release requests share the worker; blindly killing on every queued status timeout could interrupt legitimate active decode. Model deadline ownership at the transcription lane/process level and distinguish queue wait from execution time.

**Before/after measurement and tests:** fake a worker that never responds, using a short injected deadline. Assert timeout causes exactly one process invalidation/kill, all requests settle, late messages cannot resolve new requests, and a subsequent transcription starts a new generation. Then packaged synthetic worker test measures timeout-to-process-exit and main event-loop delay. Target: no timed-out process remains executing after the documented kill grace.

### DP-03 — P2: voice workers and native model objects have no idle residency budget

**Evidence:** `main/services/parakeet-engine.ts:25` retains a recognizer map, `:48–50` returns cached entries, `:70` inserts each model, and `:74–75` deletes only an explicitly released model. `main/services/parakeet.ts:75–84` reuses the launched child; `engineStatus()` at `:96–102` can launch it before transcription; disposal is tied to cancellation/application cleanup. `main/handlers/local-voice.ts:49` invokes release for model deletion.

**Mechanism / baseline:** successful use of different model IDs can retain each recognizer for the lifetime of the utility process. A status-only probe can leave a utility process resident. The engine config uses two CPU threads (`parakeet-engine.ts:65`), but cached recognizers do not necessarily keep those threads busy. Neither model-file size nor the old audit's approximately 1.2 GB estimate is a measured RSS baseline here.

**Existing mitigation:** one shared process, serialized decode, explicit release and shutdown. Isolation improves responsiveness but does not itself reduce retained native memory.

**Proposed optimization:** one-recognizer cache or small byte-budgeted LRU, with idle process eviction after a measured reuse window; cancel the eviction timer during pending work. Process exit is the reliable reclaim boundary if the native binding lacks deterministic disposal. Avoid launching a worker merely to release an unloaded model.

**Risk:** model reconstruction increases first-transcription latency and energy; aggressive eviction can be worse for frequent dictation. Choose a measured idle threshold, and protect queued work.

**Before/after measurement and tests:** status-only, model A, model B, five minutes idle, then A again. Capture per-process footprint, total system memory pressure, decode latency and process count at each boundary. Assert one eviction timer, no eviction during queued/active decode, and a fresh process after expiry. Report warm-latency tradeoff alongside reclaimed memory.

### DP-04 — P1: MCP client teardown is outside the awaited application quit barrier

**Evidence:** `main/index.ts:298–316` invokes `void mcpManager.closeAll()` during cleanup. The subsequent awaited shutdown group at `:413–425` does not include that promise. `main/services/mcp.ts:311–317` closes server IDs serially; each ID closes cached/status clients. `main/services/generation-bound-connection-cache.ts:110–116` awaits client closure but provides no close deadline itself.

**Mechanism / baseline:** Electron can reach `app.quit()` (`main/index.ts:445`) before MCP closure settles. A slow first close delays starting subsequent closes because the loop is serial. This is an ownership/settlement gap; whether actual stdio descendants survive depends on transport and OS behavior and has not been reproduced here. SDK-internal timeouts must not be misrepresented as absent; the missing element is an app-owned aggregate quit contract.

**Existing mitigation:** cleanup is idempotent, clients are removed/fenced during disconnect, parent generations and subagents are awaited earlier, and other services have explicit settlement. MCP connection single-flight is already implemented at `generation-bound-connection-cache.ts:41–45`; the old duplicate-connect finding is superseded.

**Proposed optimization:** include bounded MCP closure in the quit barrier, close independent IDs with bounded concurrency, wait for owned stdio process exit where available, and log bounded categorical stragglers. A timeout must trigger resource cleanup rather than merely abandoning the promise.

**Risk:** waiting without an aggregate deadline would turn quick quit into a hang. Closing clients before running tool cancellation settles can race active mutations; preserve the existing parent/subagent shutdown ordering.

**Before/after measurement and tests:** fake slow/rejecting/hung client closures across several IDs, assert all are asked to close and quit stays within the aggregate budget. Packaged isolated stdio fixture should include a child and a stubborn descendant; record process exit after quit and repeated open/close cycles. Never terminate unrelated real MCP services as an audit test.

### DP-05 — P2: each generation rediscovers MCP tools serially; idle clients remain cached

**Evidence:** `main/services/mcp.ts:357–366` calls `listTools()` in `agentContextFor` even with a cached connection. `:412–424` awaits enabled servers one by one. `generation-bound-connection-cache.ts:23–25,41–45,99,110–116` holds clients until explicit disconnect/transport closure; no idle expiry or reference-counted release exists in this cache.

**Mechanism / baseline:** for N enabled servers advertising tools, a collection invokes up to N tool-list RPCs in series; schema acquisition latency can accumulate across servers and repeated generations. Successfully opened stdio helpers/connections can stay resident when no conversation needs them. CPU while resident depends on server implementation and must be measured.

**Existing mitigation:** reuse avoids repeat launch cost; generation/configuration leases fence stale connections; status-test connections are separately owned and closed. The short-lived bounded discovery path elsewhere in this file must not be confused with this regular generation path.

**Proposed optimization:** cache schemas per connection/configuration generation, invalidated on supported tool-list change notifications or an explicit bounded freshness policy. Connect/discover independent servers with small bounded concurrency. Add idle expiry only with active-use leases so tool execution cannot lose a connection mid-call.

**Risk:** stale schemas can expose removed tools or omit new ones; leases must preserve credential rotation and strict approval semantics. Idle timeout can force expensive or interactive reconnects; measure before selecting defaults.

**Before/after measurement and tests:** mock 1/4/10 servers with deterministic discovery latency, repeated generations, tool-list changes, credential rotation, and one offline server. Measure tool-ready latency, RPC count, active process count and idle footprint. Behavioral acceptance: cached unchanged generation avoids repeat listing, invalidation refreshes exactly once, no active call is closed, strict callers still fail closed.

### DP-06 — P1: distinct scheduled tasks can all catch up together, without a power policy

**Evidence:** `main/services/schedule-service-core.ts:135–139` only suppresses an already-running task with the same ID. `:183–198` dispatches execution and tracks each task. Startup catch-up `:345–355` launches missed tasks without awaiting completion before continuing the loop. Dependencies at `:34–40` expose no power/lock state. The inspected main-process `powerMonitor` use is config reload on resume (`main/index.ts:2010`), not schedule power management.

**Mechanism / baseline:** N overdue distinct tasks can overlap in execution after their serialized scheduling preparation; there is no global execution cap here. Expensive scripts/LLM/local-model tasks can contend with the freshly opened UI. This does not prove an N-task CPU burst on every launch; tasks must be enabled and overdue, and downstream providers may limit execution.

**Existing mitigation:** same-task overlap protection, revision fencing, globally-enabled setting, workspace blocking, cancellation, durable next-run advancement, and a five-second stop-settlement deadline (`:377–392`). Cron timers avoid a short-period app polling loop.

**Proposed optimization:** bounded global admission for automatic runs with fairness across workspaces; coalesce catch-up according to existing one-run semantics. Introduce explicit user-understandable policy for battery/lock/thermal states while keeping manual Run Now responsive. Do not silently disable intentionally unattended automations or Remote access merely because the desktop window is hidden.

**Risk:** changing dispatch time affects schedule expectations, ordering, cancellation and stale revisions. Revalidate authority at actual admission, preserve cancellation while queued, and distinguish queued from running status.

**Before/after measurement and tests:** 20 overdue tasks with controllable blocking executions; assert peak concurrency at the configured bound, every eligible task eventually runs once, paused/deleted work never starts, manual/automatic fairness, and stop settles queued work. Packaged run measures startup interactivity and peak CPU/RSS with fake local executors. Battery policy tests use injected power state, not the auditor's real system settings.

### DP-07 — P2: first-window creation sits behind a long storage/recovery chain

**Evidence:** `main/index.ts:1712–1736` awaits terminal history, Live restoration and several artifact stores. `:1761–1771` awaits subagent store initialization, expired tool-output pruning and pending deletions. `:1867–1881` awaits legacy migration, lists chats, reconciles runtime/compaction records and then managed-worktree recovery. Remote service initialization is awaited at `:2013`, before `createMainWindow()` at `:2022`.

**Mechanism / baseline:** time in this awaited chain contributes directly to first-window delay; larger histories, recovery work, slow disks and optional Remote initialization can increase it. Counts and milliseconds are unmeasured. Some ordering intentionally prevents writes before durable recovery; moving everything after render would violate correctness.

**Existing mitigation:** optional-service error handling, durable recovery before writers, scheduled tasks/Telegram/updater start after window creation. No claim is made that these services download model catalogs during startup.

**Proposed optimization:** instrument each stage first. Create a lightweight read-only/loading shell earlier while keeping mutations and Remote endpoints gated on authoritative recovery. Defer opportunistic retention scans where safe, and parallelize only genuinely independent store initialization. Preserve fail-closed migration/artifact recovery gates.

**Risk:** early UI or IPC admission can race recovery and corrupt state. Any optimization must preserve the existing barriers for writes and provider/credential authority; a visible shell is not permission to make the composer operational early.

**Before/after measurement and tests:** isolated profiles with empty, 1,000-chat, artifact-heavy and interrupted-migration fixtures; cold/warm launch over repeated trials. Measure process-start → window-created → first-paint → authoritative-ready → composer-ready separately. Tests must prove attempted writes remain rejected until recovery completes and that failed recovery remains explicit, even if the shell is already visible.

### DP-08 — P2: terminal output pays full-buffer concatenation and IPC cost per PTY chunk

**Evidence:** `main/services/terminal.ts:349–358` appends/slices the retained string, increments sequence, appends history, invokes its observer and sends renderer IPC for every incoming chunk. `main/services/terminal-history.ts:20–21` separately bounds persisted history to 5,000 lines/200,000 characters. Terminal disposal signals the process group and PTY (`terminal.ts:454–466`) and document invalidation terminates ownership (`:335–345`).

**Mechanism / baseline:** at C PTY callbacks per second, main sends C data events per active terminal and repeatedly concatenates the retained buffer. Hidden panel presentation does not change this callback. This is an active high-output workload issue, not a periodic idle-polling finding. String-engine allocation details and IPC bytes require measurement.

**Existing mitigation:** bounded buffer/history, debounced persisted history, sequence IDs, document ownership, process-group cleanup. Ordinary terminal descendants already receive SIGHUP; detached processes deliberately retain Unix semantics, so they are not automatically an app leak.

**Proposed optimization:** bounded chunk ring for retained output plus byte/time-threshold IPC batching, flushing immediately on exit and explicit reads. Keep sequences and snapshot handoff consistent. Coalesce resize only if traces show redundant resize traffic.

**Risk:** batching can reorder output relative to exit/snapshot or drop trailing bytes; increasing batch delay hurts interactive shells. Preserve small input-to-output latency and exact replay.

**Before/after measurement and tests:** one/four fixture PTYs producing many small chunks at a fixed total byte rate, visible/hidden panels. Compare IPC messages/bytes, event-loop p95/p99, total CPU and allocation rate. Assert byte-exact ordered output, final flush before exit and no stale document delivery, using existing terminal/history suites.

## Additional bounded work and measurement candidates

- **Browser picture-in-picture:** `main/services/browser/service.ts:1470–1487` performs a capture and base64 image assignment every 250 ms (up to 240 capture attempts/minute per PiP when callbacks can keep up). A pending flag prevents overlapping capture; closing/disabling cleans up the interval (`:1427–1458`). It lacks a visible/minimized check in the frame callback. Measure static-page capture CPU/bytes before replacing with changed-frame or adaptive cadence. This is an explicitly active feature, not baseline idle work; preserve expected live preview quality.
- **Dictation pill:** lazy-created on first `showPill()` (`main/windows/pill-window.ts:88–101`), hidden rather than destroyed at `:104–105`, and configured with background throttling disabled at `:54` because it records while unfocused. Treat its post-recording footprint as a measurement question; do not label it an always-created startup renderer or assert idle CPU without a trace. Separate active recording from hidden-idle state if measurements justify toggling throttling or eviction.
- **Skill watchers:** `main/services/bot-skill-content-watcher.ts:28–63` watches only discovered instruction directories, deduplicates directories, filters unrelated filenames and uses `persistent: false`. Good narrow event-based design. Its map grows until whole-service disposal (`:66–69`), with no reconciliation for no-longer-used directories. Under churn across many workspaces, measure retained watcher count and assess reference-counted reconciliation. Avoid broad recursive home watches and preserve immediate authority invalidation on content change.
- **Updater:** `main/services/app-updater.ts:24–25,173–188` starts a 15-second initial check and six-hour interval only on supported update builds; both timers are unrefed. This is not a rapid idle polling problem. Battery-aware download policy is a possible later optimization, not a measured regression.
- **Maintenance:** hourly tool-output pruning (`main/index.ts:1765–1770`) and diagnostic retention timers are low-frequency work. Record scan size/duration before adding complexity. Avoid launching duplicate overlapping retention scans if future measurements reveal scans exceeding their interval.
- **Remote read-aloud:** `main/services/aiden-remote-tts.ts:68–71` installs a 30-second idle-reclaim timer for each constructed host (two callbacks/minute). An empty-session-aware one-shot timer is possible, but lower priority than native decode/browser work. Do not infer this host exists when Remote is disabled without checking construction.
- **Durable jobs:** `main/services/durable-jobs/worker.ts:20–23` has a one-second claim loop, but the reviewed source search found no production construction of `DurableJobWorker`; references are its own implementation and tests. **Do not count this as 60 live desktop polls/minute.** Reassess when runtime wiring lands.
- **Crash recovery is already bounded:** `main/services/renderer-crash-recovery.ts` tracks recent crashes and returns retry/backoff decisions, consumed by `main/index.ts`. The historical unconditional hot-reload-loop claim must not be repeated as current behavior.

## Shared verification protocol

Use a production-equivalent build without invoking the release model-refresh path. Record commit, dirty-state hash, Electron/app versions, build flags, hardware, macOS/Linux version, power source, profile fixture, and enabled optional features. Run each scenario independently before combining them; use identical fixture data and startup cache conditions for before/after comparison. Collect process-tree CPU time and memory, main event-loop delay/utilization, child launches/exits, open resource counts, IPC events/bytes, and filesystem operation/byte counts. Instruments energy/system traces are lab evidence, not CI substitutes. Do not treat a single Activity Monitor snapshot as a battery baseline.

Recommended deterministic follow-up suites: Parakeet protocol/process/lane tests; generation-bound MCP cache/status tests; schedule-service-core tests; terminal/history tests; `npm run test:browser`; renderer recovery/quit-barrier tests; bot-skill-content-watcher tests. Add behavioral counters and injected clocks/process fixtures rather than source-string tests. No protocol or mobile contract changes are proposed here; any implementation changing shared Remote behavior must also inspect and run relevant iOS/Android suites.

Suggested order: fix timeout resource ownership and MCP shutdown first; measure/adjust browser guest throttling; bound schedule catch-up; establish helper residency budgets; then optimize startup barriers, schema discovery and terminal batching against measured baselines. Keep network catalog actions explicitly manual/release-only throughout.
