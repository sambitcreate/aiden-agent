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
