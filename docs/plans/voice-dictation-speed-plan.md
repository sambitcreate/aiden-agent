# Voice dictation: speed and live text (STT sub-project 2)

Status: Active (2026-10-22). Phase 1 is in review in [PR #579](https://github.com/sambitcreate/aiden-agent/pull/579); phase 2 waits on the engine spike on the owner's Mac.

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

- Spike on the owner's Mac (Remote Control): transcribe.cpp with Metal (npm `transcribe-cpp`, MIT, darwin-arm64-metal prebuild) against sherpa-onnx CPU at 2 and 4 threads, and sherpa-onnx streaming (Nemotron/Zipformer `OnlineRecognizer`). Measure load time, decode time for 3 s / 10 s / 30 s clips, RSS and word error rate on a fixed set of recordings.
- Build live mode on the winner: committed and tentative words in the pill (the Gemini Live path already streams `{committed, tentative}`) and in the composer, with one paste at the end for other apps.
- Packaging, notarization and the CLI bundle must carry the chosen engine; Remote transcription for phones keeps working.

## Later

- Silero-based silence auto-stop in the pill and recognizer biasing from the dictionary (from the STT foundation spec's sub-project 2 list).
- Onboarding voice step (sub-project 4).
