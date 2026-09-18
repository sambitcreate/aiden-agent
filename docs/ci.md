# Continuous integration

The `CI` workflow exposes one aggregate result, **CI required**. Its gate fails if
change detection, policy validation, or any selected job fails, is cancelled, or
unexpectedly skips. Repository branch protection should require this check. Adding
the workflow does not itself change repository protection settings.

## Selecting work

Pull requests compare the merge base with the PR head. Explicit documentation-only
changes run policy validation. Android-only and iOS-only changes select their own
platform checks; desktop renderer changes select desktop checks. Main-process code,
shared renderer contracts, native code, resources, package manifests, scripts,
workflows, unknown paths, and failed change detection select the full suite.

Every push to `main` runs the full suite, including native clients. This provides the
complete exact-commit result used by release admission. Models.dev catalog refresh
remains a separate approved post-merge workflow.

## Desktop checks

- Static verification runs TypeScript, lint, diagnostics, branding/release policy,
  model-catalog contracts, one production build, and production-profile diagnostics.
- Unit tests use `scripts/ci-test-registry.json` to assign each ordinary regression
  test once. The registry is checked against the existing `pretest`/`test` package
  script graph on every run. Newly registered tests must receive a lane assignment;
  unsupported shell syntax, environment changes, and runner flags require an audit.
- Special execution modes remain explicit: terminal coverage thresholds, Chromium
  containment, Ruby release policy, native C helper builds/tests, and Rust
  formatting/tests/clippy. They cannot be replaced by a list of JavaScript files.
- Electron E2E uses three isolated macOS runners, one worker per runner, with
  duration-weighted file assignment. New deterministic specs are automatically
  included. The opt-in live-provider test remains outside CI.
- Apple Foundation Models tests and generic-device iOS test compilation run in
  independent jobs. Hosted iOS compilation does not prove physical-device XCTest
  acceptance. Android keeps unit, lint, compilation, and emulator coverage, with APK
  publication only on main pushes.

Use `node scripts/run-ci-tests.mjs --list` to inspect the registered work and
`--dry-run` to inspect commands. Existing focused npm scripts remain available.
See [Electron E2E](../tests/e2e/README.md) for shard reproduction and local artifacts.
Hosted failure uploads retain only sanitized receipts for seven days.

## Releases and measurement

Release admission verifies the latest successful main CI attempt and its
`CI required` result for the exact source SHA before allocating a macOS release
runner. Existing version tags stop at the Ubuntu preflight. Fresh signing,
notarization, package validation, and signed-app acceptance remain mandatory;
see [releasing](releasing.md).

The September 4–18 audit measured a 14m15s median successful CI run and a 16m41s
90th percentile. The sampled main Electron job took 13m15s, including about 12m24s
of test execution. These are baseline observations, not guarantees for the new
layout. Compare hosted wall time, queue time, summed runner time, failures, and
reruns after rollout. More parallel jobs may shorten feedback while increasing
runner time; runner availability can limit the improvement. Shard summaries report
file counts and elapsed time without including private test data.
