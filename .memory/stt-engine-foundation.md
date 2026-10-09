# On-device speech engine foundation (STT sub-project 1) — 2026-10-09

- Branch `feature/speech-to-text-update-203d37`. Spec: `docs/plans/stt-engine-foundation-spec.md`.
  Plan (with a dated `## Progress` log of every verification): `docs/superpowers/plans/2026-10-09-stt-engine-foundation.md`.
- First of four speech-to-text sub-projects (1 engine foundation, 2 live and accuracy, 3 dictation UX,
  4 consistency and onboarding). Stays on `sherpa-onnx-node` pinned **exactly 1.13.8** (root and
  `packages/cli`), `numThreads: 2`, `provider: "cpu"` for every recognizer.

## What shipped

- A frozen six-model offline catalog with pinned byte sizes and SHA-256: Parakeet TDT 0.6B v3
  (recommended) and v2, Canary 180M Flash, Whisper Large v3 Turbo, SenseVoice Small, Moonshine Base EN.
  Archives come only from `k2-fsa/sherpa-onnx` `asr-models` release assets, downloaded only on an
  explicit user action (Settings Download, Remote download route, `aiden speech download`).
- Verified, resumable downloads (`Range` + `.partial/<id>.tar.bz2.part`, SHA-256 before extract,
  prune to `spec.files`, atomic rename) under `<userData>/voice-models/<id>/` (CLI: `<agentDir>/voice-models`).
  Progress phases `download` (0–90) → `verify` (90) → `extract` (90–100).
- Language (`voiceLanguage`), Translate to English (`voiceTranslateToEnglish`, Canary only) and
  Trim silence (`voiceTrimSilence`, default on). Unsupported languages fall back with a caption.
- Bundled Silero VAD (`resources/speech/silero_vad.onnx`, packaged at `Resources/speech/`, CLI at
  `dist/app/speech/`) for trimming and segmentation; silence returns `""` without decoding.
- Speech worker protocol v2 (binary PCM16, `translate: boolean`, worker derives the task), crash
  supervision with one retry, invalid frames fail fast, model-state events ("Loading model…" latch).
- Local-first provider resolution ("Automatic") for desktop dictation, pill, composer, Telegram and Remote.
- Telegram Ogg/Opus voice notes decode on-device (`opus-decoder@0.7.12` + `codec-parser@2.5.0`, ≈0.41 MB packaged).
- Settings → Voice: model capabilities, licences, language, translate and trim controls.

## Module map

- `main/services/local-speech-catalog.ts` — `SPEECH_MODELS`, `SILERO_VAD`, size/language labels.
- `local-speech-downloads.ts` (Electron-free `createSpeechModelManager`), `local-speech-models.ts` (Electron wiring,
  legacy `parakeet-models/` removal).
- `local-speech-engine.ts` — sherpa adapter, single model slot, per-family config, VAD segmentation.
- `local-speech-vad.ts` — pure `planSegments` / `fixedChunks`.
- `local-speech-protocol.ts`, `local-speech-worker.ts` (build entry `build/main/local-speech-worker.js`),
  `local-speech-worker-core.ts`, `local-speech-process-core.ts` (supervision), `local-speech-lane.ts`,
  `local-speech-idle-unload.ts`, `local-speech-model-state.ts`, `local-speech-opus.ts`, and the parent `local-speech.ts`.
- `renderer/shared/voice-language.ts` (`effectiveLanguage`, `effectiveTask`), `voice-preferences.ts`,
  `voice-provider.ts` (`resolveVoiceProvider`, setup messages, Automatic caption), `local-speech-state.ts`.
- `main/services/voice-provider-resolution.ts` (gathers inputs in main), `dictation-voice-check.ts`.
- CLI: `packages/cli/src/speech.ts` reuses the same core through `aidenRelativeTsRewritePlugin`.

## Decisions

- **Single slot:** one recognizer loaded at a time, keyed by model id and directory; idle unload kills the worker.
- **Language updates:** sherpa 1.13.8 implements `SetConfig` only for Canary and Whisper; SenseVoice is rebuilt;
  Parakeet/Moonshine ignore language. Whisper's language switch via `setConfig` is verified natively (smoke run).
- **VAD values** (from Handy's SmoothedVad): threshold 0.3, minSilence 0.45 s, minSpeech 0.06 s, window 512,
  maxSpeech 28 s; 450 ms pre/post roll, merge gaps < 300 ms, 28 s windows for windowed families, one
  trimmed range for Parakeet/Canary. Clips < 1 s are padded to 1.25 s. VAD failure fails open.
- **Delete, not migrate** (pre-1.0): `parakeet-models/` is deleted at startup; renamed modules have no stubs.
- **Automatic provider:** explicit `voiceProvider` wins; unset prefers an installed on-device model when the engine
  is ready, then OpenAI (key), then Gemini only with a Google key **and** a chosen `geminiUsageScope`
  (never sends audio to a chat-only key); main re-checks the provider for cloud transcription.
- Language resolver lives in `renderer/shared/` (Settings needs it). Gemini batch sends `language_codes`.
- **Remote:** `/speech` passes the additive `languages`, `capabilities`, `license` and `verify` phase through;
  OpenAPI `SpeechStatus` and the shared fixture were updated (optional fields, no revision bump), and
  `aiden-remote-speech.test.ts` validates the real projection against the schema. iOS and Android decode
  them tolerantly and show "Downloading… 90%" during verify (acceptable; no native change).

## Verification (2026-10-09)

- `npm run test:stt-smoke` (opt-in, never in CI; downloads ≈1.96 GB into a temp root and deletes it): all six
  models transcribe "The quick brown fox jumps over the lazy dog" recognizably (the test checks for "quick" and "fox"; every model returned the full sentence, with casing that varies by model) and return `""` for 10 s of silence.
  The test needs the macOS voices "Samantha" (required; the test skips without it) and "Anna" (German; its checks are skipped
  without it); add them in System Settings → Accessibility → Spoken Content → System Voice → Manage Voices.
  Moonshine `.ort` loads on 1.13.8, so it stays. Whisper: de → auto works on the same engine; German speech
  auto/en/auto gives German/English/German; a 112 s clip keeps both ends. Canary: `de` gives German, translate gives English.
- Isolated RSS after load / peak (fresh process, short clips): parakeet-v3 1962/2000 MB, parakeet-v2 1940/1980,
  canary 753/849, whisper-turbo 2536/2814, sense-voice 949/966, moonshine 542/569. Whisper is far above the
  spec's 1–1.5 GB estimate — revisit (smaller Whisper or memory limits) in sub-project 2.
- Decode of a ≈3 s phrase: parakeet ≈110–190 ms, canary ≈130–180, whisper ≈1.2–1.5 s, sense-voice ≈55–80,
  moonshine ≈35–55; 10 s silence ≈20–35 ms (VAD only). Full table in the plan's Progress.
- Packaged arm64 `--dir` build: `npm run package:verify` passes; worker entry and `Resources/speech/silero_vad.onnx` present.
- iOS `AidenRemoteClientTests` + `AidenRemotePhase0Tests` on the iPhone 17 simulator and Android
  `AidenRemoteClientTest` + full `testDebugUnitTest` pass with a six-model `/speech` decode test.
  Android needs `JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"` and
  `ANDROID_HOME=~/Library/Android/sdk` in this worktree (no `local.properties`).

## Deferred

- **Onboarding:** AGENTS.md asks onboarding to introduce setup-critical features. This sub-project intentionally
  defers the onboarding voice step (and CLI `/voice` and `/dictate` defaults, Remote dictionary and warm-up) to sub-project 4.
- Live acceptance still owed on real hardware: crash-mid-decode retry in the app, needs-setup pill on a fresh profile,
  Telegram voice note → local usage record, iOS/Android select+download against a live Mac, Translate caption screenshot.
- Review minors deferred across tasks (see the SDD ledger `.superpowers/sdd/2026-10-09-stt-engine-foundation/progress.md`):
  disk error copy says "Free up space" for EACCES; no stall guard on the final flush; `settings:set` silently drops an
  invalid `voiceLanguage`; parent supervision has no end-to-end integration test; opening Settings → Voice may fork the
  worker for `engineStatus`; explicit cloud + stale `localVoiceModel` shows "(automatic)"; on-device with no model shows
  the cloud language list; worker deadline not clamped to the 32-bit timer range (> 12 days of audio only).

## Licensing and attribution

- Model licences live in the catalog and the model manager: CC-BY-4.0 (NVIDIA Parakeet, Canary), MIT (Whisper,
  Moonshine EN), FunASR Model License 1.1 (SenseVoice; attribution and model name kept). Silero VAD is MIT.
- Behavior was ported, not copied, from Handy (`cjpais/handy`, MIT) at commit **`f6b3f82`**. Files studied:
  `managers/model/download.rs`, `engine_supervisor/supervisor.rs`, `audio_toolkit/audio/vad.rs`,
  `managers/model.rs` (`effective_language`), `src/overlay/RecordingOverlay.tsx`. Catalog scores are Handy's
  `catalog.json` values / 100 (relative display hints measured on transcribe.cpp).
