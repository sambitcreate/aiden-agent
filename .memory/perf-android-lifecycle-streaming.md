# Android lifecycle and streaming performance (perf/android-lifecycle-streaming)

Audit findings EXT-17, EXT-22..28 and EXT-34 for `android/`. The Remote protocol contract is unchanged.

## What changed
- **EXT-22/23**: The Remote coordinator and OkHttp client are now app-scoped through an app container, so rotation and activity recreation no longer rebuild them. The navigation back stack can be saved, and back navigation goes through `PredictiveBackHandler` and sub-screen `BackHandler`s.
- **EXT-24**: Added `persistence/AidenDebouncedDraftWriter`, which writes drafts after a 500 ms debounce. A sequence token stops a stale write from overwriting a newer one.
  - `send` reserves the write that clears the draft and runs it on IO before the turn starts.
  - Drafts are flushed on ON_PAUSE, when the screen is disposed, and in `onCleared`.
  - `acceptRemoteChat` is now `suspend`. Its chat save and admit run on IO, then it re-checks the starting flag, the generation and the client.
  - Chat ViewModels take an `ioDispatcher` parameter. Tests must join the VM jobs before `resetMain`; see `AidenModelPreferenceTest`.
- **EXT-25**: Added `features/chat/AidenLiveTranscriptBuffer`, which holds streamed text and reasoning in StringBuilders. It publishes at most once per 33 ms frame and flushes before any non-delta event.
  - The transcript regexes are hoisted into `AidenChatPatterns` and `CODE_BLOCK_REGEX`.
  - Code-block splitting and the chronological projection are now `remember`ed.
- **EXT-26**: Added `notifications/AidenNotificationThrottle` (`throttleLatest`), replacing `debounce(400)`, which never fired while text was streaming continuously.
  - The live notification updates at most every 1 s.
  - Terminal, null and approval states skip the throttle and post at once.
  - The notification builder sets `setOnlyAlertOnce(true)`.
- **EXT-17**: The reconnect backoff in `AidenTerminalReconciliation.retryDelayMilliseconds` now uses equal jitter, so each delay falls in [ceiling/2, ceiling].
- **EXT-34**: Unit tests read `protocol/aiden-remote/v1/fixtures` directly as a test resources directory. The copied `contract.json` and `manual-pairing-vector.json` are deleted.
- **EXT-27**: Release builds use R8 with `isShrinkResources`. `app/proguard-rules.pro` keeps the kotlinx-serialization serializers.
  - `versionCode` is derived from `-PaidenVersionName` as major*1e6 + minor*1e3 + patch. The default "0.1.0" gives 1000.
  - Removed unused navigation3 and play-services-code-scanner dependencies.
- **EXT-28**: Changed 97 `collectAsState()` calls to `collectAsStateWithLifecycle()`. Transcript value models are marked `@Immutable`. `AidenChat` and `AidenLiveTool` stay unmarked because they have `var` fields.

## Measurements
- Unsigned release APK: 38.9 MB before, 24.7 MB with R8 and resource shrinking.
- Streaming text: about n²/2 character copies before, versus one snapshot per frame now. This is an analytic estimate.
- `testDebugUnitTest`: 307 tests pass. `lintDebug` reports 0 errors.

## Open owner decisions
- Smoke-test the minified release on a device; R8 keep rules have not been exercised on hardware.
- Release CI must pass `-PaidenVersionName`; otherwise versionCode stays 1000.
- Activity-scoped chat ViewModels still accumulate. This was true before this branch.
- The initial cache reads stay on Main so the first frame is populated.
- `AidenNavigationHostUiTest` compiles but has not been run on a device.
