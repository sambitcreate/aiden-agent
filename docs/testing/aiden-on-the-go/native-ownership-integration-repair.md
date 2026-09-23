# Native ownership integration repair — 2026-09-23

Base: preserved integration merge `49445999`, branch `feature/native-ownership-integration`.

The prior executed iOS chat run reported ten failed test cases. The repair addresses four independent causes: workspace metadata/detail ordering, draft I/O unnecessarily retaining Send admission, optimistic Stop state, and stale approval restoration after a canceled response. It adds seven regression tests alongside the existing failures. Independent source review caught and corrected stale-list resurrection and unnecessary approval refresh on healthy running streams.

## Verification

- Generic iOS `build-for-testing`, Xcode 26.6, signing disabled: passes (app and XCTest compile).
- iPhone 17 simulator, iOS 26.4.1, Xcode 26.6: full XCTest bundle passes, 453 passed / 6 opt-in physical-device tests skipped / 0 failures (459 total). All 160 AidenChatTests pass. Result bundle: `/tmp/aiden-242-full-repair.xcresult`.
- iOS release policy suite: passes.
- Android chat tests: 40 pass after correcting invalid fixture JSON.
- Full Android JVM suite: 193 passed, zero failures/errors/skips; lint and instrumentation compilation pass.
- Integrated managed-worktree lifecycle tests: 29 passed after building the required native helpers.
- Independent iOS source/test review: no remaining actionable findings after final re-review.

## Simulator execution and remaining acceptance

The owner explicitly authorized simulators and requested the policy update in this PR. `ios/AGENTS.md` now allows simulator development/regression verification and distinguishes it from hardware-dependent physical acceptance.

The first simulator run resolved all ten originally failing cases, but exposed four assertions in the existing pending-era metadata test: the detail overlay could admit a recreated chat using a list token invalidated during deletion cleanup. The overlay now enforces the same per-chat deletion floor as incoming rows. Independent re-review found no additional actionable issue, and the full simulator bundle then passed.

The six skips require opt-in physical-device configuration: Image Playground unavailability, paired streaming, workspace CRUD, server restart, pinned URLSession, and signed Keychain isolation. No physical-device or release acceptance is claimed; no merge/release performed.

Local logs: `/tmp/aiden-242-full-repair.log`, `/tmp/aiden-217-repair-build-final.log`, `/tmp/aiden-217-repair-policy.log`, `/tmp/aiden-217-repair-android-final.log`, `/tmp/aiden-217-repair-worktree-final.log`.
