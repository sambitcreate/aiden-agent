# CI efficiency workstream (perf/ci-efficiency, 2026-10-03)

## What changed
- `scripts/ci-changes.mjs` routes by seven areas: desktop, apple, ios, android,
  cli, linux, catalog. Desktop implies catalog. A diff touching only
  `resources/model-capabilities.json` is `catalog-only`, including on main
  (catalog bot commits); every other main push is full.
- `scripts/ci-required.mjs` rules are `{always}` or `{areas: [...]}`; a job may
  skip only when all of its areas are false. Branch protection should require
  only **CI required** (the separate `ios-simulator` job was merged into `ios`).
- One macOS `build` job tars `build/` into `desktop-build-<run>-<attempt>`;
  e2e shards and `verify` download it. Only that job runs `npm run build`.
- `catalog` job (Ubuntu) runs `test:model-catalog`. Linux packaging runs only
  for the `linux` area (always on full main runs) and is not in `required`.
- iOS: SPM checkout cached by `Package.resolved`, build-for-testing (device,
  then simulator) and `test-without-building`. DerivedData caching deferred.
- Android gradlew calls pass `--build-cache`.
- `release-consumers.yml` concurrency never cancels main runs.
- `npm test` = `node scripts/run-ci-tests.mjs --parallel` (prereqs, four lanes
  concurrently, preserved commands). The old chain is `pretest:serial` /
  `test:serial`; registry `sourceScripts` point at those. Root
  `pretest`/`posttest` hooks are rejected by `validateRegistry`.
- Duplicate proof: before 718 file runs (613 unique, 75 duplicated), after 613.
- 2026-10-15 test-execution audit: ~40 files (test:preflight, command-system,
  scheduled, google-provider, config-recovery, concentrate,
  codex-auth-view-state) were unreachable from the serial graph and never ran.
  They are now in `test:serial` and lanes (source 975 -> 1015 files).
  `validateRegistry` now discovers test files on disk and requires each to be
  in the serial graph, a `workflowScripts` entry, or the `manual` allowlist.
  Duplicate prerequisite/preserved ids are rejected (the JSON had every
  prerequisite twice, so the planner ran 26 builds instead of 13), and
  `test:serial` no longer repeats its big tsx segment.

## Flakes (EXT-43)
- Fixed: Tailscale controller tests used the production route lock on UDP
  49191 (OS ephemeral range); now a private port. Product lock port in the
  ephemeral range is an open owner decision.
- Open: one-off Electron e2e flakes (chat-message-queue steer, environment
  devices agent, browser-lifecycle navigation timeout, browser-throttling) and
  an AidenChatTests removal/upload race cluster on iOS.

## Needs live validation
Artifact tar round trip, iOS test-without-building and SPM cache, Gradle
cache, routing outputs on real PR/main/catalog-bot events.

## Electron shard weights (2026-11-02)

Refreshed file windows from run 41534097337 (attempt 2's third shard, and its retained successful first/second jobs). The third shard timed out after starting 117 tests; its final workspace-panel file receives an allowance beyond the observed truncated window. A separate completed run 41391629898 supplies independent fixture windows: on its 60 observed files the old allocation projects 506/524/830 seconds and the refreshed allocation 597/626/637 seconds. Two later files have no independent timing and are excluded equally from that comparison. Three single-worker shards, selection, exclusions, timeout and flake policy are unchanged.

## macOS demand (2026-11-05, perf/ci-macos-demand)

GitHub caps macOS at 5 concurrent jobs on Free, Pro and Team, whatever the repo's visibility. In the week of Oct 29 to Nov 5 macOS sat at exactly 5 for about 52% of the time and at least one job was waiting 63% of the time. Ubuntu queue p90 was 0.2 min. A Support request to raise the limit went in on 2026-11-05.

- PRs run `core-git`, `runtime-subagents` and `renderer-other` on Ubuntu. The `macos` lane stays on macOS and main runs all four there.
- A Linux probe's failure list is not enough to pick that lane: 16 tests skip off macOS and about 40 more `return` early, which reads as a pass. Check for both when moving tests.
- Worktree test failures on Linux (`managed-worktree-lifecycle`, `workspace-worktree-application-service`) were never root-caused; those files stay on macOS.
- iOS routing: `renderer/shared/` and `scripts/ci-test-registry.json` no longer select iOS, and a scripts-only `package.json` change does not either. A real week had 58 of 116 iOS selections with no iOS, protocol or Remote server change.
- Replay of that week with a 6-minute `macos` lane: PR wait p50 106 to about 50 min, p90 294 to about 169; main p50 115 to about 74. Moving main's lanes too would give about 43/152 for PRs, but main would never run those tests on macOS. The replay is a model: check real timings after a week.
- Before merge the split passed in Ubuntu 24.04 arm64 (14,034 tests, none failed or skipped) and the `macos` lane passed on a Mac. Neither was a hosted runner.
- Not done: Linux E2E sharding, `bot-browser` and `workspace-settings` flake fixes, and trimming PR macOS E2E, which should wait for a week of real runs.
