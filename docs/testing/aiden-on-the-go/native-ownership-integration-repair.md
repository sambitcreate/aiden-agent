# Native ownership integration repair — 2026-09-23

Base: preserved integration merge `49445999`, branch `feature/native-ownership-integration`.

The prior executed iOS chat run reported ten failed test cases. The repair addresses four independent causes: workspace metadata/detail ordering, draft I/O unnecessarily retaining Send admission, optimistic Stop state, and stale approval restoration after a canceled response. It adds seven regression tests alongside the existing failures. Independent source review caught and corrected stale-list resurrection and unnecessary approval refresh on healthy running streams.

## Verification

- Generic iOS `build-for-testing`, Xcode 26.6, signing disabled: passes (app and XCTest compile).
- iOS release policy suite: passes.
- Android chat tests: 40 pass after correcting invalid fixture JSON.
- Full Android JVM suite: 193 passed, zero failures/errors/skips; lint and instrumentation compilation pass.
- Integrated managed-worktree lifecycle tests: 29 passed after building the required native helpers.
- Independent iOS source/test review: no remaining actionable findings after final re-review.

## Runtime gate

The prior iOS execution was on a simulator. No physical iPhone is currently connected; devices enumerated as offline. `ios/AGENTS.md` explicitly prohibits simulator use, so a simulator exception was requested and remains unanswered. The repaired iOS tests have not been executed in this session. Do not claim 153/153 or physical acceptance from compilation. No merge/release has been performed.

Local logs: `/tmp/aiden-217-repair-build-final.log`, `/tmp/aiden-217-repair-policy.log`, `/tmp/aiden-217-repair-android-final.log`, `/tmp/aiden-217-repair-worktree-final.log`.
