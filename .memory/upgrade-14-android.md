# Android API response cancellation — upgrade lane 14

Baseline: `5cc831a17aa8971fb5b89c7dd9278a6ec4022beb` (origin/main, 2026-09-19).

Finding: `AidenRemoteClient.executeRequest` awaited response headers and then performed blocking body reads after the cancellable continuation had completed. Cancelling during a slow body could wait for the read timeout; declared oversized bounded responses could throw before closing the body.

Decision: keep the OkHttp call under cancellable ownership until response bytes have been read, and close the response inside the callback before returning plain status/body data. Keep decoding and diagnostics on the caller side, preserving existing cancellation/error classification. Scope is the shared REST executor; SSE already cancels its call in `awaitClose`. Pairing and dedicated image download paths are not changed.

Reference lessons (original Kotlin implementation; no source copied):
- OpenCode `packages/app/src/context/global-sdk.tsx` at `7a6ce05d0939826aa6c8e1c481489a713b2d633f`: explicitly abort the active transport attempt when its owner stops (MIT).
- Waku `src/opencode_session.rs` at `6d433e875d57091906ec0770d8bb9ffc9aa29b83`: terminate the underlying resource to unblock retained readers (GPL-3.0; conceptual study only).

No shared server contract, visual layout, setup, feature-tour, or plan status changes. Validation: the two lifecycle regressions fail on unchanged baseline (1000 ms cancellation timeout; body-close assertion) and pass with the fix. All 165 Android unit tests, Android lint, and instrumentation-test Kotlin compilation pass via `:app:testDebugUnitTest :app:lintDebug :app:compileDebugAndroidTestKotlin --max-workers=2`. The third added regression preserves network error classification on body disconnect. Existing test class remains discovered by the Gradle CI suite; no new test script required. No TypeScript changes, so npm type-check/lint were not run. Physical-device network transitions and emulator execution remain untested locally.
