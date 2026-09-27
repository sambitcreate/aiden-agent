# Dictation Parakeet lifecycle, modes, and dictionary — 2026-09-27

- Branch `feature/dictation-parakeet-modes`. Plan: `docs/plans/dictation-parakeet-modes-plan.md`.
- **Shared, pure modules:**
  - `renderer/shared/dictation-preferences.ts` holds the mode resolution, idle-minute validation, and `parseDictationPreferencePatch`, which `settings:set` uses.
  - `renderer/shared/dictation-dictionary.ts` holds parse, apply, and add-entry.
- **Settings keys:**
  - `dictationActivationMode` (`toggle|hold|hybrid`);
  - `dictationDictionary` (`{from,to}[]`);
  - `localVoiceIdleUnloadMinutes` (integer 0–1440, 0 = never; default 10).
  - `dictationHoldToTalk` stays the release-capable flag. The Linux `linuxHoldSettings.apply` path is keyed on it, so choosing a mode also sets it.
  - `runtimeSettingsFrom` drops invalid shapes of all three keys.
- **Coordinator:**
  - Hybrid starts the key watch at press. `pressedAt` and `releasedAt` are stamped at call time.
  - A release shorter than `HYBRID_TAP_THRESHOLD_MS` (300) latches toggle.
  - If the watch fails, the recording latches toggle with a hint.
  - `warmUp` runs once per idle press. `applyDictionary` runs after cleanup.
- **Parakeet:**
  - Leases wrap status, transcribe, and warm.
  - Idle unload kills the worker process, since that is the only reliable way to free native memory.
  - The exit listener calls `forget()`.
  - The `warm` protocol message was added without a version bump, because the parent and worker ship together.
- **Composer:** the mic calls `localVoiceApi.warm` at start. The composer applies the dictionary in its transcript callback.
- **Not done:**
  - Remote (mobile) transcription through Mac Parakeet does not apply the dictionary.
  - VAD, history, and mute are deferred.
  - Physical-hardware acceptance is pending.

## Review fixes
- Unmappable hybrid shortcuts latch toggle and announce the fallback at recorder readiness.
- Dictionary deduplication uses locale-independent lowercase; matching preserves original Unicode spelling and uses regex capture groups to select replacements. Dotted Turkish I, long s, and Greek sigma regressions cover regex case-fold equivalence.
- Recognizer release runs in the transcription lane under an idle lease, so idle disposal cannot reject model deletion.
- CLI speech worker handles the shared warm request explicitly.
- Added shortcut/dictionary regressions; 44 focused tests, CI policy suite, desktop typecheck, and CLI build/typecheck pass. New suites are assigned to CI lanes.
