# Continuous integration

The `CI` workflow exposes one aggregate result, **CI required**. The gate fails
when detection, policy checks, or a selected job fails, is cancelled, is missing,
or unexpectedly skips. Branch protection can require this check; the workflow
itself does not change repository protection settings.

## Selecting work

PRs compare the merge base and PR head using complete, NUL-delimited Git output.
Rename detection is disabled so both the removed and added paths select work.
`scripts/ci-changes.mjs` maps each path to seven areas: `desktop`, `apple`, `ios`,
`android`, `cli`, `linux` and `catalog`. Only explicit prose documentation paths
select nothing; contributor-instruction files such as `AGENTS.md` and the design
guide are not treated as prose. Android-only and iOS-only PRs select their own
platform checks, renderer-only PRs select desktop checks, and CLI-only PRs select
the CLI jobs plus static checks. Desktop changes always imply `catalog`. Shared
contracts, main-process/native code, infrastructure, unknown paths, empty diffs
and detection failures select every area. Policy checks always run.

Every main push runs full validation except a push that changes only the
generated model catalog (`resources/model-capabilities.json`, reason
`catalog-only`). Those commits run detection, policy and the
`catalog` job; the other jobs skip. Real code changes on main are never routed
this way. Linux packaging jobs run only when the `linux` area is selected, which
includes every full main run.

`scripts/ci-required.mjs` lists, per job, either `always` or the areas that select
it. A job may skip only when every one of its areas is false; any other skip,
failure, cancellation or missing result fails **CI required**. Branch protection
should require only that check.

PR pushes cancel superseded PR CI. Each main run of `CI` and `Release consumer contract`
has its own concurrency group, so neither running nor pending main validation is
superseded. Runner capacity can still cause queueing.

## Execution and coverage

- TypeScript (including the e2e project) and lint run on Ubuntu. One macOS
  `build` job runs `npm run build` and uploads `build/` as a tarred, one-day
  artifact; the Electron shards and `verify` download it instead of rebuilding.
  Diagnostics and branding remain in `verify`; the model-catalog suite runs in
  its own Ubuntu `catalog` job.
- Apple Foundation Models tests run in their own job. The `ios` job resolves
  Swift packages into a cached directory keyed on `Package.resolved`, builds for
  testing once for the generic device and once for the simulator, then runs
  `test-without-building` against the shared DerivedData. iOS-only changes also
  run shipping and TestFlight policies in that job; full desktop runs execute
  them through the preserved regression lane.
- Three desktop lanes use `scripts/ci-test-registry.json`. Every ordinary file in
  the `pretest:serial`/`test:serial` graph belongs to exactly one lane. New files
  require explicit assignment; unknown shell commands, environment changes, test
  flags and root `pretest`/`posttest` hooks fail the inventory check rather than
  silently dropping or duplicating coverage. Validation also discovers every
  `*.test.*` file under `main/`, `renderer/` and `scripts/` on disk: each must be
  reachable from the serial graph, from a registry `workflowScripts` entry (npm
  scripts a workflow runs directly, such as `test:diagnostics` or
  `test:linux-native`, which must still appear as `npm run <script>` in a
  workflow), or from the `manual` allowlist (perf, smoke and Linux D-Bus
  integration files, each with a reason). Prerequisite and preserved ids must be
  unique, so the runner schedules each build once.
- `npm test` runs `scripts/run-ci-tests.mjs --parallel`: prerequisites first, the
  three lanes concurrently with prefixed output (sharing one machine-sized pool
  of Node test workers), then the preserved commands.
  Each registered file runs once. `npm run test:serial` keeps the original chain,
  which runs some files more than once, for comparison.
- When a lane fails, the runner lists its failed tests again after all of its
  output, each with its file, line and error, and adds the list to the job
  summary. A lane's TAP output runs to tens of thousands of lines, so the end of
  the log is where a failure stays findable.
- Browser containment, terminal coverage thresholds, Ruby policy, Rust
  formatting/tests/clippy and native helper production/test builds retain their
  execution modes. Registry validation checks both files and these prerequisites.
- Electron files run across four isolated macOS runners with one worker each and
  `--fail-on-flaky-tests`, retaining the 20-minute job limit. File-duration weights
  preserve larger historical estimates and complete windows from hosted runs
  41784199399 and 41789418295. Cancelled terminal windows are lower bounds, never
  treated as completed timings. The completed run 41778188548 independently checks
  the allocation. A measured budget check reserves two minutes for setup/cleanup
  and at least three minutes of headroom; real runner variation can still differ.
  Newly discovered specs get a default weight and always run. A real Playwright
  collection check verifies that every deterministic case belongs to exactly one
  shard. Live-provider specs remain opt-in; production diagnostics run separately
  with the production profile.
- Linux runs the same Electron shards on three Ubuntu runners in `linux-e2e`,
  beside the packaging job rather than after it. The required `Linux x64` and
  `Linux arm64` checks fail if a selected shard does not pass. Each shard builds
  the app itself, because waiting for the macOS `build` artifact would tie Linux
  to the macOS queue.
- Android retains unit tests, lint, test compilation and emulator coverage, with
  Gradle's build cache enabled and APK publication only on main. Hosted iOS
  compilation is not physical-device XCTest acceptance.

Use `node scripts/run-ci-tests.mjs --list` or `--dry-run` to inspect assignments.
Use `--lane core-git`, `--lane runtime-subagents`, or `--lane renderer-other` to
reproduce a lane, and `--summary` to report timings. Existing focused npm commands
remain available. Browser-dependent lanes explicitly install Chromium; a warm
local browser cache is not proof that hosted prerequisites are present.

## Measurement and rollout

An advisory report fetches every job page for the current workflow attempt and
summarizes execution, start offsets, per-platform runner-minutes and slow steps.
Start offsets include both dependency waits and runner queueing. API/reporting
failure cannot fail `CI required`. Test lanes also write elapsed summaries.

The September 21 sample of ten successful PR runs had a 25m43s median completion,
25m24s median Electron job and 14m09s median verify job. The older draft ran in
9m16s on a smaller suite; that is not a prediction for today's tests. Compare
multiple comparable full and selected-lane runs, including queue delays, failures,
reruns and total runner usage. Parallelism may trade more runner-minutes for less
waiting. Browser caches, install retries and further Linux migration are follow-up
experiments only if measured overhead or failures justify them.

On 2026-11-04, run [41789418295](https://github.com/sambitcreate/aiden-agent/actions/runs/41789418295)
hit the 20-minute job limit on Electron shard 1 after starting its final case;
GitHub's annotation explicitly identified the job deadline, with no individual
spec failure printed. Its three shards collected 118/80/96 cases. Shards 2 and 3
completed their test steps in 881/684 seconds; shard 1 was cancelled after 1,126
seconds of testing plus setup. The earlier run 41784199399 instead timed out on
shard 3, so refreshing weights from one fast runner alone would conceal the
variance. Four shards using the conservative complete-file measurements project
under 15 minutes each before the setup reserve, while the independent completed
run projects roughly 10–11 minutes. This adds one runner's setup cost in exchange
for headroom. It changes neither test timeouts nor retries; exact-head hosted CI
must still pass.

The Linux x64 job in run [41801806234](https://github.com/sambitcreate/aiden-agent/actions/runs/41801806234/job/126479810811)
failed the flaky-test gate on 2026-11-04: the Usage data persistence check read a
fresh profile's `settings.json` before it existed, then passed on its existing
retry. The switch updates optimistically, so its unchecked state does not prove
that the first settings write has finished. That test now treats only `ENOENT`
as a pending poll result and still requires persisted `analytics.enabled: false`
before relaunching and checking the switch again. A filesystem regression also
requires malformed JSON and other read errors to fail. This changes no product
behavior, test timeout, retry policy or flaky-test gate.

The local proactive suite also exposed a fake-clock ordering failure in the
held-event gap test on 2026-11-04. A fixed 20 ms pause could expire before a
timer's store read finished; the next clock advance then missed a retry timer
registered afterward. The test now gates that read deliberately and waits for
the dispatcher's drain before advancing again. It checks the full five-minute
boundary, exact run order and settled durable receipts without a timing guess.
The production event dispatcher and its limits are unchanged.

Electron shard 2 in run [41813917090](https://github.com/sambitcreate/aiden-agent/actions/runs/41813917090/job/126521250640)
failed the flaky-test gate on the Bot-browser held-tab reveal case: its first
attempt failed the gray-pixel assertion and its existing retry passed. The
fixture showed a new password field after two seconds without establishing that
the periodic held-tab scanner had observed it first. A controlled slow scan
reproduced the unmasked field and text leak under that unsupported premise.
The fixture now waits for the real scanner to finish observing the new password
before the person presses Show, then retains every pixel, no-secret and typing
refusal assertion. Its standalone Electron uses sRGB so exact red controls do
not depend on a host display profile, and pixel snapshots follow two animation
frames after the person's page action rather than assuming load/click means
paint has finished. Production masking, its documented
first-observation limitation, timeouts, retries and the flaky-test gate remain
unchanged.

Release workflows, signing/notarization, publication and repository protection
settings remain unchanged. The previous draft's release-admission rewrite has
been removed to keep release hardening separate from this CI rollout.
