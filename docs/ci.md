# Continuous integration

The `CI` workflow exposes one aggregate result, **CI required**. The gate fails
when detection, policy checks, or a selected job fails, is cancelled, is missing,
or unexpectedly skips. Branch protection can require this check; the workflow
itself does not change repository protection settings.

## Selecting work

PRs compare the merge base and PR head using complete, NUL-delimited Git output.
Rename detection is disabled so both the removed and added paths select work.
Only explicit prose documentation paths skip platform jobs. Android-only and
iOS-only PRs select their own platform checks; renderer-only PRs select desktop
checks. Shared contracts, main-process/native code, infrastructure, unknown paths,
empty diffs and detection failures run the full suite. Policy checks always run.

Every main push runs full validation. PR pushes cancel superseded PR CI; each main
run has its own concurrency group so neither running nor pending main validation
is superseded. Runner capacity can still cause queueing.

## Execution and coverage

- TypeScript and lint run on Ubuntu. Build, diagnostics, branding and catalog
  policy remain on macOS. Apple Foundation Models tests and generic-device iOS
  compilation run in independent jobs.
- Three desktop lanes use `scripts/ci-test-registry.json`. Every ordinary file in
  the existing `pretest`/`test` graph belongs to exactly one lane. New files require
  explicit assignment; unknown shell commands, environment changes and test flags
  fail the inventory check rather than silently dropping coverage.
- Browser containment, terminal coverage thresholds, Ruby policy, Rust
  formatting/tests/clippy and native helper production/test builds retain their
  execution modes. Registry validation checks both files and these prerequisites.
- Electron files run across three isolated macOS runners with one worker each and
  `--fail-on-flaky-tests`. File-duration weights come from hosted run 35667578649;
  newly discovered specs get a default weight and always run. Live-provider specs
  remain opt-in; production diagnostics run separately with the production profile.
- Android retains unit tests, lint, test compilation and emulator coverage, with
  APK publication only on main. Hosted iOS compilation is not physical-device
  XCTest acceptance. No client runtime behavior changes in this optimization.

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
