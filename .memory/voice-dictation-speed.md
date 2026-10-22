# Voice dictation speed (STT sub-project 2) — 2026-10-22

Plan: `docs/plans/voice-dictation-speed-plan.md`. Deep dive (Claude Doc): https://claude.ai/artifact/JZWtaaWud4cks6WtdjdQBY.

## Phase 1 (speed fixes on sherpa-onnx), PR #579, merged 2026-10-22 as 3fe63836 (unreleased)

- **Preload:** `main/services/local-voice-preload.ts` (`createLocalVoicePreloader`, coalescing; `localVoicePreloadRelevant`).
  Runs 3 s after launch (main/index.ts, next to shortcut init), from settings effects when `localVoiceModel`,
  `voiceProvider` or `localVoicePreload: true` change, and after `localModels:download`. Setting `localVoicePreload`
  (default on, `localVoicePreloadEnabled`), Settings → Voice "Load in advance". Idle unload default 10 → 30 min.
  Cost: a Parakeet worker is about 2 GB RSS, so a launch holds it for 30 min even without dictation.
- **Pill:** `preparePill()` in `main/windows/pill-window.ts`; `DictationCoordinator.prepare()` queues it so a new
  renderer's `ready` always lands after `pillReady = false`. Only when `isDictationShortcutActive()`.
- **Paste:** `createSecureInputPrefetch` (dictation-paste.ts) via coordinator `prepareDelivery` at stop and again at
  result before cleanup; a probe is reused if it started ≤ 1.5 s earlier, each probe answers one delivery.
- **Capture:** `renderer/lib/pcm-recorder.ts` (`PcmRecorder`, MediaRecorder-shaped: state/start/stop/onstop,
  `takePcm`, `dispose`) reuses `gemini-live-pcm` worklet at 16 kHz; `transcribePcm16` in voice-recorder-core shares
  the deadline/cancel path with `transcribeBlob`. Local only; cloud keeps MediaRecorder. Tail 80 ms
  (`recorderStopTailMs`). Empty capture now reports "" (No speech detected) instead of waiting for the watchdog.
- **Startup:** `DictationStatePayload.voice` (ReadyVoiceProvider) on every "recording" broadcast; pill falls back to
  `voice:resolveProvider` only without it. Pill reads settings in parallel with getUserMedia.
- **Composer:** `renderer/lib/dictation-insertion.ts` + `insertDictation` in composer.tsx: caret insertion via
  `execCommand("insertText")` (undoable), `setText` fallback when another field has focus or execCommand fails (jsdom).
- **Timing:** coordinator `onTiming` → `logger.info("dictation", "Dictation timing", {startMs, speechMs,
  transcribeMs, deliverMs, outcome})`.
- `voice:transcribeLocal` no longer awaits `usageStore.record`.
- No Remote/iOS/Android/CLI change. Tests: local-voice-preload, settings-application-effects-core, pcm-recorder,
  dictation-insertion, use-voice-recorder (new), plus coordinator/paste/pill/core extensions.

## Phase 2 (benchmark PR #580 merged 2026-10-22 as dca19fba; engine and live text in PR #581)

Owner chose 1a (spike transcribe.cpp Metal vs sherpa CPU 2/4 threads vs sherpa streaming on the Mac via Remote
Control, then live mode on the winner) and 2a (live words in the pill, one paste at the end in other apps).

- Benchmark: `scripts/voice-engine-spike/` (own package.json, not a workspace, not linted as app code beyond
  eslint's js rules; Node globals are imported from `node:*` like the other scripts). One child process per config.
  Configs: sherpa v3 cpu2/cpu4/coreml, tcpp v3 metal/cpu4 (offline + `redecode`), tcpp parakeet-unified-en and
  nemotron-3.5 (Metal stream), sherpa nemotron en / 3.5 160 ms (OnlineRecognizer stream). Pins come from Handy's
  catalog.json (GGUF) and csukuangfj2 HF repos at fixed revisions (sherpa Nemotron); tokens.txt hashes were computed
  here because HF lists no LFS hash for them.
- transcribe.cpp 0.4.0: Parakeet TDT v3 has `supportsStreaming: false` and rejects `parakeet_buffered`; live text on
  v3 means re-decoding the recording so far. `Stream.text` gives `{committed, tentative}`; koffi FFI, Node >= 22.
- sherpa-onnx-node 1.13.8 already supports multilingual streaming Nemotron (`stream.setOption("language", ...)`;
  unset means auto). Its optional platform packages use `^1.13.8`, so the spike pins them with `overrides`.
- Linux container smoke run (4 vCPU, not representative): sherpa v3 int8 decoded "brothels" as "brothers" where the
  tcpp Q8_0 GGUF was right; sherpa v3 redecode fell behind on 17 s; sherpa Nemotron streaming kept up (~80% busy).
- Mac run 2026-10-22 (Mac Studio M1 Max, 64 GB, macOS 27.0, via Remote Control; ~/aiden-voice-spike, cache
  ~/.cache/aiden-voice-spike ~3.5 GB on a disk that was 98% full): see
  scripts/voice-engine-spike/reference-results/2026-10-22-mac-studio-m1-max.md. Warm decode 3.5/8.8/26.9 s:
  sherpa cpu2 162/378/1220 ms, cpu4 119/263/810, tcpp Metal 64/115/388, tcpp cpu4 178/420/1393. WER 0.036 vs 0.022.
  tcpp v3 Metal redecode every 500 ms <= 37% busy at 27 s, final 64-340 ms. Nemotron 3.5 Metal stream 0.2 ms/chunk,
  first word 1.1 s, finalize 24-64 ms, more errors. Unified English first word 2.1 s. sherpa Nemotron drops first
  word of TTS phrases. sherpa Core ML slower than CPU, 4.7 GB.
- Decision: transcribe.cpp 0.4.0 Metal + Parakeet v3 Q8_0 GGUF on Apple Silicon; live text by re-decoding v3; Linux
  and Intel keep sherpa. First Metal init per machine 4.9 s (then ~55 ms) and first decode after load slow, so the
  preload must do a warm-up decode. Existing users need the 705 MB GGUF; keep sherpa until it's downloaded.

## Phase 2 build (PR #581, branch claude/project-thread-6azxgh, 2026-10-22)

- Engine: `transcribe-cpp` 0.4.0 exact pin (ESM, koffi 3.3.3 FFI) in `main/services/local-speech-transcribe-cpp.ts`
  (`createTranscribeCppEngine`, `EngineUnavailableError`, `unpackedTranscribeLibrary`). No static import of
  `transcribe-cpp`: the desktop worker (`local-speech-worker.ts`) dynamic-imports it and routes by family with
  `createRoutedSpeechEngine` (worker-core), so the CLI bundle never pulls it. Load decodes 1 s of silence (Metal
  shader warm-up). Packaged: `TRANSCRIBE_LIBRARY` = app.asar.unpacked libtranscribe.dylib (setting it skips the
  binding's contract check). asarUnpack: @transcribe-cpp/darwin-arm64-metal and @koromix/koffi-darwin-arm64.
  Root `build.files` excludes `@transcribe-cpp/linux-*` (a 64 MB Vulkan build) and `@koromix/koffi-linux-*`; the small
  JS packages still ship on Linux, unused. Never add `build.linux.files`: electron-builder then drops the root list and
  packs the whole repo (CI caught it: .d.mts, docs, .memory in app.asar). Verifiers: verify-macos-package `verifyPackagedMetalSpeechEngine`, verify-linux-package
  `assertNoMetalSpeechEngine` (native prebuilds only).
- Catalog: `parakeet-v3-metal` (family `parakeet-gguf`, host darwin/arm64, `livePreview`, quant Q8_0, archive format
  "file", 739,508,576 bytes, HF revision 85ac09ea). Listed first and recommended only via `speechModelsForHost`;
  `PORTABLE_SPEECH_MODELS` (default for `createSpeechModelManager`, so the CLI) excludes it. Automatic picks it once
  installed because installed ids follow catalog order. No LocalModel field or Remote revision change.
- Live preview: `main/services/local-speech-live-core.ts` (`LivePreviewSession`, `LivePreviewManager`), wired in
  `local-speech-live.ts`; IPC `voice:localLiveStart/Push/Stop` (pill preload allowlist too), answers on
  `voice:stream-text`. Re-decodes the current phrase (600 ms quiet after >= 200 ms speech ends it; 20 s forced split
  at the quietest frame of the last 1.5 s), noise floor = 10th percentile frame RMS over 5 s, speech = RMS >
  max(300, 3x floor). One decode in flight, interval max(400 ms, 1.5x last), >= 300 ms new audio. Committed = stable
  prefix of two decodes. Caps 600 s total, 10 s per push. `voice:transcribeLocal` stops the owner's preview first.
- Renderer: `renderer/lib/local-live-preview.ts` (2-chunk batches, gives up after 100 unsent), `PcmRecorder.onchunk`,
  `pcm16FromChunks`; started by `use-voice-recorder.ts` and `pill-app.tsx` for local + PcmRecorder. Pill line
  `renderer/pill/live-transcript-tail.tsx`. Composer shows live words in the draft at the caret (read-only,
  `dictationInsertion`), final insert after `flushSync` clears the preview; applies to Gemini live too. Trade-off:
  programmatic value clears earlier undo history; the dictation insert stays undoable.
- Settings: `FasterModelOffer` ("Faster on this Mac", Download and Use) in local-voice-settings.tsx via
  `FASTER_MODEL` {parakeet-v3 -> parakeet-v3-metal}; a chosen model follows, Automatic stays Automatic.
- Tests: local-speech-transcribe-cpp, local-speech-live-core, composer-dictation (new, registered in test:voice and
  scripts/ci-test-registry.json), plus catalog/downloads/protocol/worker-core/remote-speech/hook/pill/settings.
- Pending: packaged-app check on the Mac (dylib + koffi from asar.unpacked), timing and live words by hand; then
  delete ~/.cache/aiden-voice-spike (3.5 GB) on the Mac.
