# Audit "Do now" cleanup

Status: Active (2026-11-18)

## Background

On 2026-11-18, Gemini ran a dead-code, cleanup and performance audit of `main` at `f2fd27640`. Each finding was then checked against the code, and a second reviewer re-checked the disputed rows. Of the 117 findings:

- 66 were confirmed, 31 partly right and 14 wrong.
- 5 are held because related work is in flight, and 1 was already fixed.

This plan covers only the 35 findings marked **Do now**. Those are confirmed, low risk, and need no product decision.

Out of scope, each needing its own decision or plan:

- Rows marked Needs decision, Do later or Skip.
- The pinned-pi dependency dedupes, which need a replay evaluation.
- Android `security-crypto`.
- Durable jobs.
- Wiring `AidenBotFormSkeleton`.
- Caps on plan receipts and approval tallies.

The item IDs below match the verification table (B = packaging, CLI and CI; M = IPC and main process; R = Bots and renderer; P = phones).

## Ground rules

- **Behavior:** no change, except the performance fixes, which keep the same output and only do less work.
- **Deletions:** remove the code together with the tests, stubs, preload entries, query keys and docs that exist only for it. If a test covers live behavior through a deleted helper, rewrite the test against the live path rather than dropping coverage.
- **Tests:** follow AGENTS.md → Tests. Add no source-grep tests. When a test is added, register it in both `package.json` and `scripts/ci-test-registry.json`, and run `npm run test:ci-policy`.
- **Unverifiable items:** if a finding turns out wrong once the change is attempted, leave the code as it is and record why under "Outcome" below.
- **Docs:** update any doc or `.memory/` note a change makes stale.

## Phases

The work runs in two lanes so the phone work can proceed alongside the desktop work. Each phase is implemented, then reviewed by an independent reviewer, and every finding is fixed and re-reviewed until the review comes back clean. One PR carries every phase.

### Lane A: desktop, CLI and CI

**Phase 1: packaging, dependencies, build config**

- B1: leave node-pty's Windows prebuilds, Windows-only dependencies and C++ sources out of the packaged app (`build.files` and `asarUnpack`). Keep the macOS and Linux prebuilds and `lib/`.
- B5: remove the unused devDependencies `@rolldown/plugin-babel`, `babel-plugin-react-compiler`, `eslint-plugin-import`, `@radix-ui/colors` and `class-variance-authority`, after confirming each has no implicit loader.
- B6: drop the duplicate `yaml` devDependency and keep the runtime entry.
- B23: delete the unused `main/tsconfig.json`.
- B25: stop the Linux jobs re-running type-check and lint, but only if the static job is guaranteed to run for every path that triggers them. If it isn't, leave the Linux jobs as they are.
- Check: `npm run type-check`, `npm run lint`, `npm run build`, `npm run test:ci-policy`. Then make an unpacked package (`electron-builder --dir`) and check that node-pty loads from it.

**Phase 2: CLI package**

- B7: move every package that esbuild inlines from `packages/cli` `dependencies` to `devDependencies`. Keep the externals that load at run time (`allowedExternalPackages` in `scripts/build.mjs`, including photon, quickjs-wasi, sherpa-onnx, jiti and ws) in `dependencies`.
- B8: fix the Dockerfile comment that lists chord as a runtime external.
- B10: remove the never-set `appliedMarker` option from `scripts/patch-branding.mjs`.
- Check: `npm run cli:build` and the CLI test suites, including `tests/bundle.test.mjs`. Run `npm pack --dry-run` to confirm the runtime dependency list.

**Phase 3: dead IPC and main-process code**

- M1: remove the legacy `exa:get` and `exa:set` channels, `exaApi` and `useExaConfig`. The rollback window has passed.
- M4: remove the `assistant` get-config channel, `assistantApi`, `useAssistantConfig` and its query key and stale invalidation.
- M5: remove the unused Telegram connect and disconnect channels.
- M11: remove the dead renderer helpers `pickFolder`, `chatsApi.createAssistant`, `useScheduledRuns`, `useWebSearchSettings` and the unused provider mutation hooks, with their orphaned query keys and invalidations.
- M13: remove the 12 exported main-service functions that have no callers.
- M14: remove the dead constants, including the unused `FORM_FILL_MAX_OPTIONS` copy in `planner-core.ts`.
- M17: merge the duplicate import of the generative-ui extension in `llm-client.ts`.
- R18: remove the dead Bot value exports, or un-export them where they are used locally.
- R19: remove the unused eager `botProviderCredentialSignature` singleton.
- Check: `npm run type-check`, `npm run lint`, the IPC contract and registration suites, and the suites for each touched service.

**Phase 4: Bot performance**

- R1: skip live re-projection when the transcript watch hands back the same entries.
- R2: cache each Bot's plans and issues in the remote Bot session publisher, and invalidate the cache from those stores' own change signals. Published output must not change.
- R7: classify a Bot action once instead of once per rule in `bot-tool-assembly.ts`.
- Check: `npm run test:aiden-remote` and the Bot runtime suites. In a fresh worktree, run `npm run build:native:c` and `npm run build:vcc` first.

**Phase 5: renderer**

- R26: lazy-load the remote chat route views the way the other routes already are.
- R28: pass `forkDisabledReason` to settled message rows through a context, as `VisualFollowUpBusyContext` already does, so a turn starting or ending doesn't re-render every row. Do the same in `remote-chat-view.tsx`.
- R32: remove the dead renderer exports and the test-only `connection-chips.tsx`. Keep `durable-jobs.ts`.
- R33: remove the dead CSS rules and the `aiden-agent-event-out` keyframes.
- Check: `npm run type-check`, `npm run lint`, `npm run build`, the renderer suites, and the Playwright specs for chat and remote chat, run in a Cua Space.

### Lane B: phones

**Phase 6: iOS**

- P3: build the Bot session expiry timestamp directly rather than round-tripping it through JSON.
- P4: cache the markdown tail and single-block parse results, and replace the full-text lowercase with a cheaper check.
- P5: move the `revealedPartial` read into a child view so each streamed token redraws only the streaming row.
- P9: cancel the tasks `AidenChatViewModel.deinit` misses. `uploadRevocation` stays running on purpose.
- P11: remove the unreferenced Swift symbols.
- Check: build the app, widget and tests, run the iOS unit tests, and run `scripts/check-ios-shipping-target.test.mjs`.

**Phase 7: Android**

- P16: `remember` the formatted message in `RichFormattedMessage`.
- P17: run the Bot avatar decode and normalize off the main thread.
- P23: remove the unused `ui-tooling-preview` dependency.
- P24: turn on the Gradle build cache and parallel builds. The configuration cache stays off until CI proves its plugins support it.
- P26: remove `SDK_INT >= O` checks, which minSdk 26 makes redundant.
- P28: remove the unused `aiden_sidebar_logo.png` and the two unused strings.
- Check: `./gradlew :app:assembleDebug :app:testDebugUnitTest :app:lintDebug`.

## Outcome

To be filled in as phases land.

- P3: done. A Bot plan's `expiry` validates `expiresAt` through `AidenRemoteTimestamp(rawValue:)`, the same strict RFC 3339 parser the decoder uses, with no JSON round trip.
- P4: done. A finished reply caches its tail and single-block parse; a streaming tail is still parsed fresh and never enters the cache. The full-text `lowercased()` in `allowsSplitting` is a byte scan for the same HTML openers.
- P5: done. `revealedPartial` is read only by two small child views (the partial bubble and the scroll-follow observer), so a revealed token no longer re-evaluates the whole Bot session body.
- P9: done. `AidenChatViewModel.deinit` also cancels the foreign-run probe, rate-limit retry, worktree setup, skill catalog and mention tasks. These are defensive cancels for consistency: each task already holds `self` until it finishes or exits on a nil weak `self`, so none could outlive the view model. `uploadRevocationTask` is left running on purpose, with a comment.
- P11: done, changed scope. A fresh scan found 28 dead app symbols plus 2 that became dead with them (`offersBotIssues`, `ChatMoveRequest`); all were deleted, and the one script pin (`chatLoadErrorMessage` in `check-ios-shipping-target.test.mjs`) was dropped. Kept: Codable wire fields and enum cases (they must still decode), delegate and `AppShortcutsProvider`/`@main` members the frameworks call, and two `AidenDiagnosticEvent` cases that belong to the shared diagnostics vocabulary.
- P16: done. `RichFormattedMessage` remembers its formatted output keyed on the text and palette (the formatter's only inputs; link and copy handlers are read at click time and the body style is applied separately). Prose and fenced code are split once into remembered segments, with the same trimming, 8 dp gaps and modifier placement as before.
- P17: done. `AidenBotGeneratedAvatarModel.setCandidate` is now `suspend` and runs the decode, crop and PNG re-encode on `Dispatchers.Default`. The phases (NORMALIZING, then READY or FAILED) and error messages are unchanged, and cancellation is rethrown instead of being reported as a failed image.
- P23: done. No `@Preview` or `ui.tooling.preview` import exists in any source set, so the `ui-tooling-preview` implementation dependency and its version-catalog entry are gone. The debug-only `ui-tooling` stays.
- P24: done. `gradle.properties` turns on `org.gradle.parallel` and `org.gradle.caching`; the configuration cache stays off. CI's Android job already passes `--build-cache` and caches Gradle through `setup-java`, so nothing conflicts.
- P26: done. minSdk is 26, so the two `SDK_INT >= O` guards (notification channel creation in `AidenOnTheGoApp` and the channel-importance check in `AidenScheduledRunNotifier`) are gone; neither had an `else` branch. Checks for later API levels (P, Q, R, S, Tiramisu) stay.
- P28: done. `drawable/aiden_sidebar_logo.png` (one density only) and the strings `bot_issue_stale` and `bot_issue_not_sent` had no references in code, XML, `R.` refs or `getIdentifier` lookups. The app has no locale-qualified `values-*` string folders, so no other locale needed changes.
