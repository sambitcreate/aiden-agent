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

## Phase 2 (benchmark ready, not run on a Mac yet)

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
