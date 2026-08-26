# Packaged performance baseline runbook

This runbook is the Phase 0 laboratory protocol for the Performance, Stability,
Battery, and Efficiency plan. Results are production-equivalent evidence only
when they come from a signed unpacked or installed build with DevTools closed.

## Reference environment

- Reference Mac: Apple Silicon, at least 16 GB RAM, macOS version recorded in
  every receipt.
- Run each scenario once on AC and once on battery after a five-minute settling
  period. Disable unrelated foreground applications and leave normal macOS
  security services enabled.
- Record the commit, dirty-state hash, Aiden/Electron versions, build mode,
  hardware, macOS version, power source, and scenario. The fixture script stamps
  these fields without recording the repository path or environment values.
- `powermetrics` is optional and must be run only when the operator explicitly
  grants the required privilege. Its absence does not invalidate Instruments
  Energy Log evidence.

## Prepare

1. Create the scenario receipt immediately before the build so its commit and
   content-derived dirty-state hash describe the packaged source. Then run
   `npm run package:performance` and `npm run package:verify`. The performance
   package uses React's profiling renderer; a normal production bundle cannot
   emit React commit measurements.
2. List the exact scenario identifiers with `npm run perf:fixture -- --list`.
3. For each scenario, create a fresh fixture and receipt. Example:

   ```sh
   AIDEN_BENCHMARK_POWER_SOURCE=ac npm run perf:fixture -- \
     --scenario visible-idle \
     --build-mode packaged \
     --output build/performance-results/visible-idle-ac.json
   ```

4. After signing and verification, bind each receipt to that exact package.
   Binding reads the immutable build marker from `app.asar`, executes the
   package's fixed runtime-version probe, and records SHA-256 hashes for
   `app.asar` and the executable plus the macOS code-directory hash:

   ```sh
   npm run perf:bind-package -- \
     --receipt build/performance-results/visible-idle-ac.json \
     --app "release/development/mac-arm64/Aiden Agent.app"
   ```

5. Before the cold boundary, create the runtime seed and a reusable launch
   ticket. This is the only step that hashes the full fixture/package, runs
   `codesign`, or executes the packaged runtime probe:

   ```sh
   npm run perf:launch -- \
     --prepare-ticket \
     --ticket build/performance-results/visible-idle-ac.launch-ticket.json \
     --receipt build/performance-results/visible-idle-ac.json \
     --app "release/development/mac-arm64/Aiden Agent.app"
   ```

   For `cold-launch`, perform this preflight before reboot. After login, allow
   the Mac to settle for five minutes and do not rerun package verification.
   The measured launcher performs only constant-size inode/stat checks before
   spawn; it does not invoke `pmset`, `codesign`, hashing, or the packaged
   runtime probe in the cold boundary. Aiden records the initial expected power
   source and every AC/battery transition, and strict verification rejects a
   run with any transition. The launcher repeats the full fixture/package
   verification after Aiden exits.
   For `warm-launch`, reuse the same ticket and mutable runtime after one clean
   quit. Launch with:

   ```sh
   npm run perf:launch -- \
     --ticket build/performance-results/visible-idle-ac.launch-ticket.json \
     --receipt build/performance-results/visible-idle-ac.json \
     --app "release/development/mac-arm64/Aiden Agent.app"
   ```

   Launch tickets are device-private control files: they contain absolute app
   and fixture paths, must remain under `build/performance-results`, and must not
   be attached to a PR or shared with the path-free receipt evidence.

   Set the mutable runtime root once per receipt before any launch or artifact
   copy command:

   ```sh
   export FIXTURE_ROOT="$(pwd)/build/performance-runs/<run-id>/performance-fixture"
   export RUNTIME_ROOT="$(dirname "$FIXTURE_ROOT")/runtime"
   ```

   Confirm both values against that receipt's `scenario-inputs.json`; never
   reuse them across run IDs.

   Never point a benchmark at production user data.

   The launcher always uses the marker-bound disposable runtime profile,
   configuration, and workspace; never point it at production user data.

6. In Settings → About, choose **Export diagnostics…** at the end of the measured
   interval and save beside the receipt. Inspect the JSON before sharing it.
   Keep Instruments recording while you invoke a clean Quit so shutdown CPU,
   energy, PTY, helper, and MCP cleanup remain in the measured trace. Let the
   target process exit, then stop/save Instruments. After `perf:launch` returns,
   copy the finalized summary for that exact measured session from the private
   runtime:

   ```sh
   cp "$RUNTIME_ROOT/profile/performance-diagnostics-last-session.json" \
     build/performance-results/visible-idle-ac-shutdown.json
   ```

   The diagnostics export and shutdown summary are separate required artifacts.
   Strict verification requires their `sessionStartedAt`, run ID, and scenario to
   match, and requires a clean shutdown with zero timeout/failure/process-gone
   counters. Do not substitute a diagnostics export from the following relaunch.

7. Enter the measured Instruments values into the receipt. Every artifact entry
   is an exact `{ "path", "sha256", "bytes" }` record relative to the receipt;
   absolute paths and unhashed/missing traces are rejected. Then verify both
   artifacts. `--require-complete` rejects every unmeasured field; omit it only
   while preparing a run:

   ```sh
   npm run perf:verify-receipt -- \
     --receipt build/performance-results/visible-idle-ac.json \
     --diagnostics build/performance-results/visible-idle-ac-diagnostics.json \
     --require-complete
   ```

8. A separate relaunch/export may be retained as ancillary recovery evidence.
   Its bounded `previousSession` must match the finalized shutdown summary, but
   it does not replace the measured-session diagnostics artifact.

## Instruments templates and measured intervals

- Time Profiler: main-thread stacks, process CPU time, helper process lifetime,
  and startup signposts. Use 60 seconds after the scenario reaches steady state.
- Energy Log: wakeups, CPU, GPU, and energy impact. Use five minutes for idle and
  60 seconds for active scenarios.
- Core Animation: frame rate, frame time, and compositor work during streaming,
  scrolling, transparency, and panel motion.
- Chrome Performance and React Profiler are optional attribution artifacts.
  Capture them in a separate, explicitly non-production-equivalent pass because
  DevTools changes the workload. They may stay `null` in a complete Instruments
  receipt; never attach a second pass to the production run as if it were the
  same measured interval.

## Scenario matrix

| Group               | Required scenarios and procedure                                                                                                                                                                    |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Launch              | Cold launch after reboot/login and warm launch after one clean quit. Measure main ready, window creation, navigation, shell paint, provider ready, and composer ready.                              |
| Idle                | Visible focused, visible blurred, minimized, and window-closed/background. Run five minutes; count app-owned RAF/timers, Git/helper launches, IPC, wakeups, CPU, and energy.                        |
| Transcript          | Load the 100- and 500-turn fixtures. Scroll end-to-end, search/copy representative content, and record long tasks and settled heap.                                                                 |
| Streaming           | Stream the 2k and 10k Markdown fixtures with code, math, reasoning, and tool phases. Record React commits, parser/highlighter work, scroll writes, frame time, IPC bytes, and first-token overhead. |
| Repository          | Clean and dirty fixture workspace with Review closed/open, then generate external file churn. Record Git commands, child count, filesystem bytes, freshness, and event-loop delay.                  |
| Attachments         | One file, 20 near-limit files, a sparse 10 GB text file, deleted source, and repeated add/remove/chat-switch cycles. Record peak and settled heap plus IPC/disk bytes.                              |
| Voice               | Cold and warm on-device dictation plus the maximum supported recording. Stop mid-run. Record recognizer load/decode, main event-loop p99, RSS, and quiescence.                                      |
| Terminal            | Four idle PTYs, then four bounded high-output workloads. Record output IPC rate, renderer commits, buffer memory, resize calls, and shutdown.                                                       |
| MCP                 | Offline, hung, and 100 concurrent duplicate-connect attempts. Record client/helper count, deadlines, result bytes, and shutdown cleanup.                                                            |
| Scheduler/lifecycle | Twenty missed schedules, suspend/resume, lock/unlock, and timezone/DST change. Record concurrency, catch-up count, wakeups, duplicate runs, and durable state.                                      |

The fixture root includes a clean initialized 4,000-file Git repository,
bounded dirty/reset/churn drivers, twenty 512 KiB attachment files, a sparse
10 GiB rejection input, deterministic 60-second PCM audio, a local OpenAI-style
SSE stream server, offline/hung MCP definitions, terminal output driver, and a
separate disposable profile containing exactly twenty missed schedules.
`scenario-inputs.json` contains the fixed command/selector contract. The
launcher selects the schedule profile only for `schedules-20-missed`, so those
tasks cannot contaminate unrelated runs.

## Exact scenario drivers

For every receipt, read `runId` from the receipt and set `FIXTURE_ROOT` to
`build/performance-runs/<runId>/performance-fixture`. Do not reuse a fixture or
run a driver before ticket preparation: preflight verifies the complete fixture
digest, measured launch checks the captured root identity, and postflight hashes
the full immutable fixture again. `scenario-inputs.json` is the machine-readable
copy of these fixed inputs and the sibling mutable runtime paths.

- Launch: reboot/login before `cold-launch`; for `warm-launch`, quit cleanly and
  relaunch the same bound receipt once. Start Instruments before launch.
- Idle: make the Aiden window focused, blurred, minimized, or closed while the
  app remains running, then leave it untouched for five minutes.
- Transcript: open “Performance 100 turns” or “Performance 500 turns” from the
  generated profile, scroll from first to last message and back once, then let
  heap settle for 60 seconds.
- Streaming: run `node "$FIXTURE_ROOT/stream-server.mjs"`, select the local
  “Performance stream fixture” model, and send exactly `stream 2000` or
  `stream 10000`. Approve the fixed `read_file` request once. The server emits
  an explicit reasoning delta, a tool-call phase, and bounded Markdown content.
  Stop the server with Control-C after the generation settles.
- Repository: set `RUNTIME_ROOT` to the sibling `runtime` directory named in
  `scenario-inputs.json`. Run `"$RUNTIME_ROOT/repo-reset.sh"` for clean, or
  `"$RUNTIME_ROOT/repo-dirty.sh"` for dirty, from any working directory before
  opening Review. For churn, run `"$RUNTIME_ROOT/repo-churn.sh"` only during
  the 120-second measured interval and wait for it to exit.
- Attachments: choose `attachments/text-00.txt`, record and clear it; choose all
  twenty `text-*.txt` files, record and clear them; then choose
  `attachments/sparse-10gb.txt` and record the authoritative add-time rejection
  with no chip created. For deletion, create the machine-declared mutable copy:

  ```sh
  cp "$FIXTURE_ROOT/attachments/text-00.txt" \
    "$RUNTIME_ROOT/workspace/deleted-attachment.txt"
  ```

  Select `$RUNTIME_ROOT/workspace/deleted-attachment.txt`, then delete that copy
  before Send. The selected
  attachment is already a bounded in-memory DTO, so Send must use the retained
  bytes successfully; record the retained heap/IPC behavior rather than claiming
  a send-time source-file rejection. Repeat add/remove/chat-switch ten times.

- Voice bootstrap: first create the package-bound `voice-long` receipt with
  `voiceModelIdentity: null`, then prepare and launch an unbound bootstrap ticket:

  ```sh
  npm run perf:launch -- \
    --prepare-ticket \
    --ticket build/performance-results/voice-long-ac.bootstrap.launch-ticket.json \
    --receipt build/performance-results/voice-long-ac.json \
    --app "release/development/mac-arm64/Aiden Agent.app"
  npm run perf:launch -- \
    --ticket build/performance-results/voice-long-ac.bootstrap.launch-ticket.json \
    --receipt build/performance-results/voice-long-ac.json \
    --app "release/development/mac-arm64/Aiden Agent.app"
  ```

  The unbound diagnostics driver reports `model_required` without quitting the
  app. In that disposable profile, explicitly install and select the local voice
  model, then quit. Bind its exact catalog/model ID and complete file hash:

  ```sh
  npm run perf:bind-voice-model -- \
    --receipt build/performance-results/voice-long-ac.json \
    --fixture-root "$FIXTURE_ROOT" \
    --model-id parakeet-v3
  ```

  The binding changes the receipt, so prepare a fresh bound ticket. Arm and
  start Instruments before invoking the measured launcher; both fixed decodes
  run automatically during app startup:

  ```sh
  npm run perf:launch -- \
    --prepare-ticket \
    --ticket build/performance-results/voice-long-ac.launch-ticket.json \
    --receipt build/performance-results/voice-long-ac.json \
    --app "release/development/mac-arm64/Aiden Agent.app"
  # Start the Instruments recording now.
  npm run perf:launch -- \
    --ticket build/performance-results/voice-long-ac.launch-ticket.json \
    --receipt build/performance-results/voice-long-ac.json \
    --app "release/development/mac-arm64/Aiden Agent.app"
  ```

  The diagnostics-gated `voice-long` driver reads the receipt-bound
  `voice-60s.wav` through a bounded no-follow descriptor and performs one cold
  and one warm production `transcribePcm` decode. Verify
  `benchmark:voice-fixed-decode` count 2. Separately record live dictation for
  60 seconds and a stop-mid-recording case to cover MediaRecorder controls; the
  fixed driver does not add a renderer-callable file-to-microphone surface.

Native Instruments `.trace` recordings are package directories. Archive each
one to a regular ZIP before entering it in the receipt, for example
`ditto -c -k --sequesterRsrc --keepParent Time\ Profiler.trace timeProfiler.zip`.
The verifier requires ZIP artifacts for Time Profiler, Energy Log, and Core
Animation; JSON for diagnostics/optional DevTools exports; distinct paths; and
exact hashes/byte counts. It validates archive integrity and distinct
trace-package contents, but
does not infer the Instruments template from private trace metadata. Before
archiving, the lab operator must confirm the open recording's template matches
its receipt key; that template check is part of the manual laboratory review.
Optional Chrome Performance and React Profiler files are ancillary attribution
evidence: the verifier binds their extension, size, and digest and checks a
JSON-like prefix, but does not attest complete JSON syntax or the DevTools
export type. Open/import each optional file successfully during the same manual
laboratory review before recording it.

- Terminal: open four terminals and leave them idle for 60 seconds. For output,
  run `"$FIXTURE_ROOT/terminal-output.sh"` in each and wait for all four bounded
  commands to exit.
- MCP offline/hung: the launcher selects a config containing only the named
  fault server. In Settings → MCP, press Test once and wait through the bounded
  failure/deadline. Other scenarios use an MCP-empty config. For
  `mcp-duplicate-connect`, startup automatically issues exactly 100 concurrent
  calls through `McpManager.status`; verify the fixed
  `benchmark:mcp-duplicate-connect` counter equals 100 in the export.
- Schedules: before the measured launch, run
  `node "$FIXTURE_ROOT/stream-server.mjs"`. The launcher selects the isolated
  profile containing exactly twenty missed schedules, each bound to the local
  `performance-stream` provider/model, only for `schedules-20-missed`; wait
  until the queue settles, then stop the server. For suspend/resume and
  lock/unlock, begin the trace, perform one
  macOS lifecycle transition, wait 60 seconds, then return. For timezone change,
  first set the lab Mac to the exact source `UTC`; start the trace, change once
  to the exact target `America/New_York`, wait 60 seconds for Aiden to reconcile,
  then restore the operator's original timezone after the trace. Confirm the
  displayed system timezone after each transition. These exact IANA IDs and the
  settle interval are also in `scenario-inputs.json`; keep the operator's
  original timezone only in the private lab log, never the shareable export.

Each driver has one start and one settle boundary. If a driver, approval, model
install, or lifecycle transition does not complete exactly as described, mark
the receipt invalid and generate a fresh run rather than editing its provenance.
The strict verifier machine-checks the shared runtime envelope and the three
fully automatic drivers (`voice-long`, `mcp-duplicate-connect`, and
`schedules-20-missed`). The remaining interactive scenario execution is a
laboratory attestation: an operator must inspect the named Instruments recording
against these steps. Artifact/schema verification alone does not certify that a
manual scroll, approval, attachment selection, or lifecycle action occurred.

## Required output and budgets

Each receipt gets measured values for startup milestones, main event-loop p99,
renderer long-task p95, React commits, RAF/timer/scroll counts, child/helper
launches, IPC and filesystem bytes, Git/MCP/PTY/recognizer counts, heap/RSS peak
and settled values, shutdown duration, wakeups/CPU/energy, and package sizes.

Phase 0 CI budgets are intentionally regression guards around the audited
baseline: renderer JavaScript and a single renderer chunk must each stay below
3 MiB, while all build source maps stay below the measured 14 MiB legacy
ceiling. Phase 4 removes packaged maps and tightens JavaScript to the plan's
1.5 MiB / 500 KiB targets after code splitting.

Hardware energy values are lab gates. CI enforces only deterministic fixture,
counter, privacy, schema, receipt/export pairing, bundle, and package
invariants. A desktop Mac can produce the AC half of the matrix only; battery
evidence must come from a portable reference Mac and must never be inferred or
copied from AC measurements.
