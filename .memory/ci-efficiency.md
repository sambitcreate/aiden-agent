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

## Electron deadline correction (2026-11-04)

Published head `c74e51618`, CI run 41789418295/job 126440392131, collected 118/80/96 cases across the three Electron jobs. GitHub's check annotation explicitly says the first job exceeded its 20-minute maximum; it was cancelled at the last `usage-data.spec.ts` case without printing an individual spec failure. Other shards passed (test steps 881/684s). Read-only logs and the deadline annotation from prior run 41784199399 confirmed a different shard 3 hitting the same limit, while its first two passed; the workflow/sharder were identical. Complete file windows varied substantially across runners. No runtime regression or `usage-data` defect was established.

Four single-worker shards now preserve the 20-minute job budget, retries and fail-on-flaky policy. Weights are the maximum of prior estimates and complete file windows from 628/c74; partial cancelled terminal windows never count as complete. The 67-file fixture retains job IDs/counts and partial evidence separately. The independent all-green ffc run 41778188548 supplies holdout timings. Tests combine recent worst complete windows with a 120-second setup/cleanup reserve and require 180 seconds of remaining headroom, and compare the holdout allocation without changing its timings. A real Playwright collection check guards every deterministic case exactly once; new specs still get a default weight. The current 295 deterministic cases divide 75/72/78/70. This trades one extra runner's setup cost for measured headroom. Local CI policy 75/75, final focused policy/collection 23/23, lint and diff checks passed; independent review and exact-head hosted CI remain pending. No unchanged hosted job was rerun and no main run was cancelled. Activation candidate work remains isolated and unrelated.

### First four-shard hosted result (2026-11-04)

After independent Sol high review cleared the measured allocation, published head `b278f4e4b` run 41801806234 completed all four Electron jobs successfully in 13m25s, 12m28s, 13m16s and 13m03s respectively. The 20-minute budget and flake policy were unchanged. These are whole-job elapsed times, including runner setup and cleanup. Other required surfaces also passed; a separately observed Linux x64 job was still running when recorded. This establishes the first hosted four-shard result, not the final PR head.

## macOS demand (2026-11-05, perf/ci-macos-demand)

GitHub caps macOS at 5 concurrent jobs on Free, Pro and Team, whatever the repo's visibility. In the week of Oct 29 to Nov 5 macOS sat at exactly 5 for about 52% of the time and at least one job was waiting 63% of the time. Ubuntu queue p90 was 0.2 min. A Support request to raise the limit went in on 2026-11-05.

- PRs run `core-git`, `runtime-subagents` and `renderer-other` on Ubuntu. The `macos` lane stays on macOS and main runs all four there.
- A Linux probe's failure list is not enough to pick that lane: 16 tests skip off macOS and about 40 more `return` early, which reads as a pass. Check for both when moving tests.
- Worktree test failures on Linux (`managed-worktree-lifecycle`, `workspace-worktree-application-service`) were never root-caused; those files stay on macOS.
- iOS routing: `renderer/shared/` and `scripts/ci-test-registry.json` no longer select iOS, and a scripts-only `package.json` change does not either. A real week had 58 of 116 iOS selections with no iOS, protocol or Remote server change.
- Replay of that week with a 6-minute `macos` lane: PR wait p50 106 to about 50 min, p90 294 to about 169; main p50 115 to about 74. Moving main's lanes too would give about 43/152 for PRs, but main would never run those tests on macOS. The replay is a model: check real timings after a week.
- Before push the split passed in Ubuntu 24.04 arm64 (14,034 tests, none failed or skipped) and the `macos` lane passed on a Mac. The first hosted x64 run then failed one `core-git` test: the image catalog single-flight test counted event-loop turns while the runtime read settings from disk, and it now waits for the request itself. Later hosted runs passed all four lanes.
- Not done: trimming PR macOS E2E, which should wait for a week of real runs.

## Linux E2E shards (2026-11-05, perf/ci-linux-e2e-shards)

Linux x64 ran packaging then a 22-minute serial E2E step, about 36 minutes plus Fedora, which set the floor on a PR once macOS stopped queueing. `linux-e2e` now runs the shards from `scripts/ci-e2e-shards.mjs` beside packaging, using macOS-derived weights. `diagnostics-production.spec.ts` is left out of shards, and it only skipped on Linux before. The `linux-required` gate reads both jobs, so the ruleset's contexts did not change.

## PR726 integration after macOS-demand PR775 — 2026-11-05

Preserved the historical four Mac E2E shards and three Linux shards, all 1,313 branch tests and all 1,269 incoming tests (44 branch additions retained). PR headless lanes move to Ubuntu while main keeps Mac coverage. Independent review found a native-routing gap: comment-derived mirrors missed public Remote parsers, DTOs and limits, including continuity watches, Open work, routine models, peers, resume, and existing Bot, subagent and background-job contracts. Added explicit public paths and behavioral classifier cases; generic host helpers retain the lighter route. Shared public contract edits alone now select both native clients. No production, wire or native implementation changes.

CI policy tests passed 79/79, image-generation runtime tests passed 27/27, and root ES2020 types and final scoped lint passed. Initial lint caught two imports made unused when the comment-grep test was replaced with behavioral cases; removed them and verified lint again. GPT-6.1 Sol high independent review is CLEAR (`/tmp/aiden-pr726-main775-ci-review.md`). The privacy fix in 6d02ff1a0 and native fixtures are unchanged by this main merge. Hosted CI on the new exact head remains required before merging PR726.


## PR726 native routing follow-up — 2026-11-05

External review5793938192/inline4487570455 identified two additional omissions in the explicit inventory: bot-routine-model-directory.ts and bot-presets.ts. Both are public Remote payloads with independent Swift/Kotlin models. Their single-file changes now select both mobile suites, covered by behavioral classifier calls with no accompanying server-file change. The bounded Remote/native audit additionally verified and restored assistant.ts approval controls/limits, bot-connections.ts connection-card/preset chips, chat-triage.ts public patch/result, custom-model-options.ts native provider-create inputs, and provider-failure.ts forwarded outcome categories/attempts/retry exhaustion. Each has literal behavioral classifier coverage, separate from the production inventory. Host-only authorization/normalization helpers, paired-desktop-only contracts and projected-out visual internals were inspected without adding unsupported mobile mirrors. Existing generic host-helper exclusions, lane/test unions, budgets, retries, strict flaky gates and main concurrency are retained. The complete CI policy suite passed80/80 with zero skips/failures; scoped ESLint and diff checks passed. GPT-6.1 Sol high independent review/fix audit and final source/tests/docs review are CLEAR (`/tmp/aiden-pr726-native-routing-followup-independent-review.md`); the root independently reviewed the five audit-authored additions and their real Remote/native consumers. The inventory counts above refer to registered test files. No runtime, DTO, native fixture or Remote59 changes. Fresh exact-head hosted CI remains required.
