# Dictation Parakeet lifecycle, modes, and dictionary — 2026-09-27

> 2026-10-09: the `parakeet*` modules were renamed to engine-neutral `local-speech*` (see `.memory/stt-engine-foundation.md`); the Parakeet names below are historical.

- Branch `feature/dictation-parakeet-modes`. Plan: `docs/plans/completed/dictation-parakeet-modes-plan.md`.
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

Independent review corrected the dictionary settings row keys to use the same locale-independent lowercase identity as parser deduplication; a Turkish-casing regression verifies distinct I/dotless-ı entries keep distinct React keys.

Status (2026-10-01): merged in PR #279 (on main after 0.51.0); plan moved to `docs/plans/completed/`.

## Speech model storage (STT engine foundation, Task 2, 2026-10-09)

- `main/services/local-speech-downloads.ts` (`createSpeechModelManager`) replaced
  `local-models-core.ts`; `local-speech-models.ts` is the Electron wiring. Models
  live under `<userData>/voice-models/<id>/` (CLI: `<agentDir>/voice-models`).
- Downloads resume from `.partial/<id>.tar.bz2.part` with `Range`, verify the
  pinned SHA-256 before extracting into `<id>.extracting/`, prune to `spec.files`,
  then rename. Progress phases: download (0-90) → verify (90) → extract (90-100).
- Startup (`prepareLocalSpeechStorage`) deletes the legacy `parakeet-models/`
  folder and stale staging; catalog-model partials are kept so a relaunch resumes.

## Local-first voice provider resolution (STT engine foundation, Task 7, 2026-10-09)

- `renderer/shared/voice-provider.ts` `resolveVoiceProvider` is the single rule: an explicit
  `voiceProvider` wins; unset ("Automatic") prefers an installed on-device model when the
  engine is ready, then OpenAI (key), then Gemini (Google key + a chosen `geminiUsageScope`),
  else `needs-setup`. `main/services/voice-provider-resolution.ts` gathers inputs in main;
  renderers call `voice:resolveProvider` (allowed in the pill) at mic press.
- Settings → Voice: "Automatic" (Select value `automatic`, since Radix rejects `""`) clears the
  key via `settings:set { voiceProvider: null }` (`parseVoiceProviderPatch`). Model downloads no
  longer auto-activate a model, and the manager's "Use" sets only `localVoiceModel`. With no
  usable choice, "Active model" shows the fallback as "<name> (automatic)".
- `voice-provider-resolution.ts` exports `createVoiceProviderResolver(deps)`; live deps load
  lazily so the module is testable. Known follow-up: Settings' resolution query can fork the
  speech worker through `engineStatus` when a model is installed (review M4, left as is).
- `voice:transcribe` now takes the resolved cloud provider as a 5th arg and calls
  `transcribeCloud` (`createCloudTranscriber`), which re-resolves in main and refuses a
  mismatch with "Voice settings changed. Try again." before any upload; only Telegram goes through `transcribe` (`createTranscribeRouter` in
  `transcription-core.ts`), which routes `audio/ogg|opus` to `transcribeLocalOggOpus` with
  `local-voice` usage and refuses other types on-device.
- Telegram transcription failures become `"<file> was not transcribed: <reason>"` notices.
- Cloud language hints use the base code of `voiceLanguage`: OpenAI `language`, Gemini Live
  `languageCodes`, Gemini batch `transcription_config.language_codes`.
- Worker entries go through `replyToWorkerFrame`: an invalid frame with a requestId gets an
  immediate `invalid-request` failure (its own protocol code, never retried) instead of two
  hang deadlines.
- Opus end trim uses each stream's final granule minus its pre-skip, so chained files decode
  to exact lengths.

## Settings → Voice UI (STT engine foundation, Task 9, 2026-10-09)

- `voice-settings.tsx` exports `VoiceInputSettings` (provider, Language, conditional
  "Translate to English", cloud model rows, plus `LocalVoiceSettings`); `VoiceSettings` wraps it
  with the dictation sections so the input rows can be tested without the router.
- Language options: "Automatic" (value `auto`) then the active on-device model's `languages`, or
  a fixed cloud list of 17 codes; names come from `Intl.DisplayNames(["en"])`. A stored language
  the model can't hear stays selectable and shows "<model> doesn't support <X>. Using <Y>."
  from `effectiveLanguage(...).fallback`. Translate shows when the active model has
  `capabilities.translateToEnglish` (only Canary today).
- Captions under a select sit in a `flex w-full flex-col` wrapper because
  `.settings-field-control` is a flex row.
- Model cards are `role="group"` named by the model; they show `languagesLabel · sizeLabel`,
  neutral `Badge` chips (Auto-detect / Translate), and "License: name — attribution". Progress
  labels: Downloading… N% / Verifying… / Installing….
- On-Device Engine has a "Trim silence" switch (`voiceTrimSilence`, default on).
- Tests: `voice-settings.test.tsx`, `model-manager-view.test.tsx`, and the shared fixture
  `local-models-test-catalog.ts` (real pinned catalog). The old source-grep Gemini deferral test
  moved to a behavioral test in `voice-settings.test.tsx`.
