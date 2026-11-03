# Android draft recomposition

The Android chat keeps its collected draft read inside the composer's Scaffold content. Voice input reads `viewModel.draft.value` when recording actually starts, including when microphone permission returns. The voice controller still snapshots that text as its session's base draft and rejects callbacks from retired sessions.

Keeping a separate `rememberUpdatedState(draft)` at screen scope made each edit recompose the whole chat screen, even though voice input only needed the text on an explicit action. Removing that redundant read leaves typing in the composer.

## Measurement, 2026-10-21

A debug build on the isolated `medium_phone` ARM64 emulator, Android 16/API 36, mounted the production `AidenChatDetailScreen` with temporary stores and no paired server. A temporary `SideEffect` counter at the screen's entry measured ten separate `performTextInput("word ")` actions, with `waitForIdle()` between actions. The counter was reset after initial composition.

| Measurement | Before | After |
| --- | ---: | ---: |
| Root screen compositions during ten edits | 10 | 0 |
| Final editor text | Ten copies of `word ` | Ten copies of `word ` |

The diagnostic assertion requiring zero root compositions failed before the change and passed afterward. The counter and diagnostic test were removed after the measurement. A permanent tooling observer could not identify named scopes because this build omits scope source metadata; no production test hook or empty counter test was retained.

This measures recomposition ownership in an emulator. It does not establish physical-device input latency, frame rate, CPU use, or battery savings. The fixture had no provider traffic or active stream.

## Verification

- Focused Android JVM suites cover chat state and draft behavior, voice modes, voice base-draft composition, and retired voice-session callbacks.
- Existing `AidenComposerUiTest` exercises editor controls and submission behavior in the emulator.
- `lintDebug` and `compileDebugAndroidTestKotlin` check the production and instrumentation code.

The existing Gradle discovery and CI emulator command cover these suites. No server, Remote protocol, iOS, composer layout, permissions, or persisted-draft format changes are involved.
