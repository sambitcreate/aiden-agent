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
`catalog-only`). Those catalog bot commits run detection, policy and the
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
  silently dropping or duplicating coverage.
- `npm test` runs `scripts/run-ci-tests.mjs --parallel`: prerequisites first, the
  three lanes concurrently with prefixed output (sharing one machine-sized pool
  of Node test workers), then the preserved commands.
  Each registered file runs once. `npm run test:serial` keeps the original chain,
  which runs some files more than once, for comparison.
- Browser containment, terminal coverage thresholds, Ruby policy, Rust
  formatting/tests/clippy and native helper production/test builds retain their
  execution modes. Registry validation checks both files and these prerequisites.
- Electron files run across three isolated macOS runners with one worker each and
  `--fail-on-flaky-tests`. File-duration weights come from hosted run 35667578649;
  newly discovered specs get a default weight and always run. Live-provider specs
  remain opt-in; production diagnostics run separately with the production profile.
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

Release workflows, signing/notarization, publication and repository protection
settings remain unchanged. The previous draft's release-admission rewrite has
been removed to keep release hardening separate from this CI rollout.
