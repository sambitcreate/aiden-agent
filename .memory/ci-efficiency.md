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
- `npm test` = `node scripts/run-ci-tests.mjs --parallel` (prereqs, three lanes
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

## Linux E2E shards (2026-11-05, perf/ci-linux-e2e-shards)

Linux x64 ran packaging then a 22-minute serial E2E step, about 36 minutes plus Fedora, which set the floor on a PR once macOS stopped queueing. `linux-e2e` now runs the shards from `scripts/ci-e2e-shards.mjs` beside packaging, using macOS-derived weights. `diagnostics-production.spec.ts` is left out of shards, and it only skipped on Linux before. The `linux-required` gate reads both jobs, so the ruleset's contexts did not change.
