# Voice dictation: speed and live text (STT sub-project 2)

Status: Active (2026-10-22). Phase 1 merged in [PR #579](https://github.com/sambitcreate/aiden-agent/pull/579) on 2026-10-22 and is not released yet. The phase 2 benchmark ([PR #580](https://github.com/sambitcreate/aiden-agent/pull/580)) ran on the owner's Mac on 2026-10-22 and picked transcribe.cpp on Metal with Parakeet TDT v3. The Metal engine and live words are built in [PR #581](https://github.com/sambitcreate/aiden-agent/pull/581) (see [Phase 2 build](#phase-2-build)); a packaged-app check and timing on the owner's Mac remain.

Deep dive: [Local voice dictation: speed and live text](https://claude.ai/artifact/JZWtaaWud4cks6WtdjdQBY) (2026-10-21). It compares Aiden's on-device dictation with Handy (`cjpais/handy`, MIT) as of v0.9.x.

## Problem

On a warm model, a 3 s phrase took about 965 ms from release to pasted text, while the recognizer itself decodes it in 111–191 ms. The rest was waiting:

- two `osascript` launches in front of every paste (the Secure Input probe, then the paste transaction);
- a fixed 180 ms MediaRecorder tail, then a WebM/Opus decode and a 16 kHz resample after stop;
- serial startup work per press: a provider lookup in the pill, the microphone, then a settings read;
- cold paths: the pill window loaded on the first press, the speech worker forked on the first press, a 10 minute idle unload and no preload, so the first dictation after a while paid about 1 s of model load.

The composer also appended the transcript at the end of the draft with no undo.

Handy does not type live into other apps. It shows live words in its overlay and pastes once at the end, and it has run transcribe.cpp (ggml, Metal) instead of ONNX since v0.9.0.

## Owner decisions (2026-10-21)

1. **1a:** spike transcribe.cpp (Metal) against sherpa-onnx on the owner's Mac first, then build live mode on the winner.
2. **2a:** in other apps, live words appear in the pill and the transcript is pasted once at the end.
3. Keeping the model warm is a user option. The default idle unload is 30 minutes, and the model loads in advance.
4. **4a:** ship every phase 1 fix in one PR, watch CI and merge.

## Phase 1: speed fixes on the current engine

Desktop only (macOS and Linux). There is no Remote protocol, iOS, Android or CLI change: the pill state is desktop IPC, and phones transcribe through `transcribePcm16Base64`, which is unchanged.

- **Model kept warm.** Settings → Voice → On-Device Engine gains **Load in advance** (`localVoicePreload`, default on). The model loads a few seconds after launch, when a model or provider is chosen, and after a model download (`main/services/local-voice-preload.ts`). **Free memory when idle** now defaults to 30 minutes instead of 10. Turning Load in advance off restores load-on-first-dictation.
- **Pill loaded hidden.** When the dictation shortcut is registered, the pill window loads hidden after launch (`preparePill`). It goes through the coordinator queue, so the new renderer's ready signal can never be lost to a racing press.
- **Paste checks overlap transcription.** The Secure Input probe starts when capture stops (`createSecureInputPrefetch`) and is reused by the paste if it started at most 1.5 s earlier. Delivery refreshes it in parallel with cleanup when transcription ran long.
- **Raw audio for on-device voice.** The pill and the composer record on-device audio as 16 kHz mono PCM through the existing PCM worklet (`renderer/lib/pcm-recorder.ts`), with an 80 ms stop tail instead of 180 ms. Nothing is decoded or resampled after stop. Cloud providers still record with MediaRecorder.
- **Less serial startup.** The coordinator passes the provider it resolved for the press in the `recording` broadcast, so the pill does not ask main again. The pill reads settings while the microphone opens.
- **Usage write off the critical path.** `voice:transcribeLocal` returns the transcript before the usage record is written.
- **Empty recordings end at once.** A recording that captured nothing reports an empty result ("No speech detected.") instead of waiting out the coordinator's watchdog.
- **Composer.** The transcript goes in at the caret (replacing a selection), with spacing only where it touches a word. It is inserted natively, so ⌘Z removes it.
- **Timing log.** Each delivered dictation logs one `Dictation timing` line: press to recording, speech, stop to transcript, and transcript to paste.

Left unchanged on purpose: the 80 ms focus re-check delay inside the paste transaction, `numThreads` (2; measured in the spike), and a native paste helper (needs a signed helper; revisit after the timing log shows what remains).

Acceptance on the owner's Mac: release-to-text on a warm model under about 400 ms for a 3 s phrase, read from the timing log; first dictation after launch with no "Loading model…"; ⌘Z in the composer removes a dictation.

## Phase 2: engine spike, then live text

- Spike on the owner's Mac (Remote Control) with [`scripts/voice-engine-spike/`](../../scripts/voice-engine-spike/README.md). It is a standalone benchmark with its own `package.json` (sherpa-onnx-node 1.13.8, transcribe-cpp 0.4.0), not part of the app. Every model it downloads is pinned by size and SHA-256. It compares:
  - sherpa-onnx Parakeet TDT v3 int8 on 2 threads (today), 4 threads and Core ML;
  - transcribe.cpp Parakeet TDT v3 Q8_0 on Metal and on CPU, the same GGUF Handy ships;
  - the streaming models Parakeet Unified English and Nemotron 3.5 (multilingual) on transcribe.cpp Metal;
  - Nemotron streaming (English, multilingual) on sherpa-onnx `OnlineRecognizer`.

  For each it reports load time, memory (RSS, and the macOS physical footprint that counts Metal buffers), and decode time for clips of about 3, 10 and 30 s, plus two LibriSpeech clips. For live text it reports update cost, busy share, first word, finalize time and word error rate.
- transcribe.cpp 0.4.0 does not stream Parakeet TDT v3: the model reports no streaming support and rejects the `parakeet_buffered` extension. Live words on v3, Aiden's multilingual default, would mean re-decoding the recording so far. The benchmark measures this as `redecode`, re-decoding every 500 ms.
- A smoke run on the 4-vCPU Linux cloud container (not representative) showed sherpa v3 re-decoding falling behind on a 17 s clip. Sherpa Nemotron streaming kept up there at about 75 to 85% busy, with 0 to 4% WER on LibriSpeech. Mac numbers decide.
- **Mac results (2026-10-22).** The benchmark ran on a Mac Studio (M1 Max, 64 GB, macOS 27.0); full tables are in [`reference-results/2026-10-22-mac-studio-m1-max.md`](../../scripts/voice-engine-spike/reference-results/2026-10-22-mac-studio-m1-max.md).

  | Warm decode, release to text | 3.5 s | 8.8 s | 26.9 s | mean WER |
  |---|---|---|---|---|
  | sherpa v3 int8, 2 threads (today) | 162 ms | 378 ms | 1220 ms | 0.036 |
  | sherpa v3 int8, 4 threads | 119 ms | 263 ms | 810 ms | 0.036 |
  | transcribe.cpp v3 Q8_0, Metal | 64 ms | 115 ms | 388 ms | 0.022 |
  | transcribe.cpp v3 Q8_0, 4 CPU threads | 178 ms | 420 ms | 1393 ms | 0.022 |

  - Re-decoding v3 on Metal every 500 ms stayed at or under 37% busy up to 27 s of audio. It showed the first words after 0.5 s of audio, and the final decode took 64 to 340 ms.
  - The Nemotron 3.5 stream on Metal cost about 0.2 ms per 100 ms chunk and finalized in 24 to 64 ms. Its first word came only after 1.1 s, and it made more mistakes.
  - Parakeet Unified English showed its first word only after 2.1 s.
  - Both sherpa Nemotron streams dropped the first word of every spoken phrase.
  - sherpa's Core ML provider decoded slower than its CPU path and used a 4.7 GB footprint.
  - Physical footprint after load: 897 MB for transcribe.cpp v3 on Metal, against 1136 MB for sherpa v3.
- **Engine decision.** On Apple Silicon Macs, use transcribe.cpp 0.4.0 on Metal with Parakeet TDT v3 Q8_0. Live text re-decodes v3, because the same model then writes both the live words and the final text, and the words barely change at release. This is 2.5 to 3 times faster than today and more accurate.
  - Linux and Intel Macs keep sherpa-onnx. transcribe.cpp on CPU is slower than sherpa on 4 threads and fell behind re-decoding a 27 s clip (136% busy).
  - Nemotron 3.5 streaming stays a later option for long dictations or slower Macs.
- **Carry into the build:**
  - The first Metal init on a machine took 4.9 s, and the first decode after it was slow (460 ms for 3.5 s of audio). Both came from compiling shaders into a cold Metal cache.
    - A re-run took 65 ms to init, and its first decode took 87 ms.
    - Session setup took 0 ms.
    - A fresh install or update can pay the cold cost once, so preloading should finish with a short warm-up decode.
  - Re-decode cost grows with the recording. Skip a tick while a decode is still running, and on long recordings re-decode only the words not yet settled.
  - Existing Mac users have the sherpa ONNX model. Metal needs the 705 MB GGUF, so keep sherpa working until that model is downloaded.
- Build live mode on the winner: committed and tentative words in the pill (the Gemini Live path already streams `{committed, tentative}`) and in the composer, with one paste at the end for other apps.
- Packaging, notarization and the CLI bundle must carry the chosen engine; Remote transcription for phones keeps working.

## Phase 2 build

Desktop only. There is no Remote protocol revision or `LocalModel` field change: phones see one more catalog entry from an Apple silicon Mac, and `transcribePcm16Base64` routes it to the same engine. The CLI keeps the portable sherpa-onnx catalog.

- **Engine.** `transcribe-cpp` 0.4.0 (pinned exactly) runs behind the engine boundary for the new `parakeet-gguf` family (`main/services/local-speech-transcribe-cpp.ts`). The speech worker routes each request by model family, so sherpa-onnx models are unchanged. Loading decodes one second of silence, which pays the cold Metal shader compile before the first dictation. A library that fails to load reports the engine as unavailable with the reason.
- **Catalog.** `parakeet-v3-metal` is the Parakeet TDT v3 Q8_0 GGUF (739,508,576 bytes) from a fixed Hugging Face revision, pinned by size and SHA-256 and downloaded as a single file. It is listed and recommended only on `darwin`/`arm64` (`speechModelsForHost`); every other host, and the CLI, sees the portable catalog.
- **Existing users.** Their sherpa Parakeet v3 keeps working. Settings → Voice offers **Faster on this Mac** with **Download and Use** while the Metal build is not downloaded. A chosen model follows the upgrade; Automatic picks the Metal build up on its own because it lists first.
- **Live preview.** Models marked `livePreview` (only the Metal build) get a preview session in main (`main/services/local-speech-live-core.ts`). The renderer streams 16 kHz PCM in 200 ms batches over `voice:localLiveStart`, `voice:localLivePush` and `voice:localLiveStop`, and main answers with `voice:stream-text` `{sessionId, committed, tentative}`.
  - It re-decodes the current phrase, never the whole recording. A phrase ends after 600 ms of quiet against an adaptive noise floor, and a phrase with no pause is split at its quietest point after 20 s.
  - At most one decode runs at a time, spaced by 1.5 times the last decode (at least 400 ms). Words two decodes agree on are committed; the rest are tentative.
  - Sessions are bound to the document that started them, end on reload, a new start or the final transcription, and are capped at 10 minutes of audio and 10 s per push.
  - The preview is best effort. When it cannot start or keep up it stops, and the final decode of the whole recording is unchanged.
- **Pill.** The live words show in the pill as a single right-aligned line that fades at its leading edge. Other apps still get one paste at the end (decision 2a).
- **Composer.** The live words show in the draft at the caret (Gemini live transcription, which already streamed words, now shows them there too), read-only while they may change, and the final text replaces them in one native insert, so ⌘Z still removes the dictation. Setting the preview value clears Chromium's earlier undo history for that field; edits made before the dictation cannot be undone past it.
- **Packaging.** The Metal library and koffi's native module are unpacked from the asar on Apple silicon, and the worker points `TRANSCRIBE_LIBRARY` at the unpacked `libtranscribe.dylib`. `scripts/verify-macos-package.mjs` checks the unpacked files; Linux packages exclude transcribe.cpp and koffi, and `scripts/verify-linux-package.mjs` fails if they appear.

Acceptance on the owner's Mac: a packaged build loads the Metal engine from `app.asar.unpacked`; words appear in the pill and the composer within about half a second of speech; release-to-text on a warm model stays near the benchmark's 64 ms decode for a 3.5 s phrase, read from the timing log.

## Later

- Silero-based silence auto-stop in the pill and recognizer biasing from the dictionary (from the STT foundation spec's sub-project 2 list).
- Onboarding voice step (sub-project 4).
