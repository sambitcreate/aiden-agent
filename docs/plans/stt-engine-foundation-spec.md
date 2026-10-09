# On-device speech engine foundation (STT sub-project 1)

Status: Spec — approved in design review on 2026-10-09; awaiting written-spec review before the implementation plan.
Branch: `feature/speech-to-text-update-203d37`.
Reference: Handy (`cjpais/handy`, MIT) at `f6b3f82` (2026-10-08), local checkout `/Users/sambitbiswas/projects/opp/handy`. Handy is Rust/Tauri, so Aiden ports behavior and algorithms as original TypeScript. No Handy source is copied.

## Program context

The owner chose four bundles on 2026-10-09. Each gets its own spec, plan and PR, in this order:

| # | Sub-project | Scope |
|---|---|---|
| **1** | **Engine foundation (this spec)** | Engine module layout; sherpa-onnx 1.13.8; curated six-model offline catalog with pinned SHA-256 and resumable downloads; language and translate; Silero VAD trimming and segmentation; worker hardening; local-first provider resolution; Telegram local routing |
| 2 | Live & accuracy | Streaming models (Nemotron 3.5 Streaming, Parakeet Unified) with a live preview in the pill and composer; Silero-driven silence auto-stop; dictionary biasing (Whisper prompt, sherpa hotwords, OpenAI `prompt`) plus fuzzy custom-word correction |
| 3 | Dictation UX | History with saved audio and retry; rule-based filler cleanup; paste hardening; mic picker; Esc cancel; mute-while-recording; dedicated LLM cleanup model and prompt |
| 4 | Consistency & onboarding | Remote dictionary and warm-up; CLI `/voice` and `/dictate` defaults; onboarding voice step |

A separate throwaway spike measures transcribe.cpp with Metal against sherpa-onnx on CPU. If the numbers justify it, transcribe.cpp can later slot in behind the engine boundary defined here. Nothing in this spec depends on the spike.

**Standing rules:**
- **UI stays Aiden.** Port Handy's behavior, never its visuals.
- **Pre-1.0.** Replace old shapes instead of migrating them.
- **Downloads are user-initiated only.**

## Goals

1. Run six offline model families through one engine boundary on sherpa-onnx-node, pinned exactly to 1.13.8.
2. Make every model download verifiable, resumable and size-bounded, with sources and hashes pinned in source.
3. Let users choose the spoken language (or Auto) and, where the model supports it, translate to English.
4. Stop sending silence to recognizers. Split long audio so window-limited models (Whisper, Moonshine, SenseVoice) work on recordings of any length.
5. Make the worker survive crashes and hangs and recover predictably. Show a "Loading model…" state when loading is slow.
6. Resolve the voice provider local-first when the user hasn't chosen one. Never open the microphone when nothing can transcribe.
7. Fix Telegram voice notes ignoring on-device.

## Non-goals (for this sub-project)

- Streaming recognition and live preview (sub-project 2).
- Silero-based silence auto-stop in the pill (sub-project 2). The RMS detector in `renderer/lib/dictation-vad.ts` stays for now.
- Recognizer biasing from the dictionary (sub-project 2).
- History, paste, mic picker and cleanup changes (sub-project 3).
- Onboarding and CLI `/voice` defaults (sub-project 4).
- GPU acceleration: CoreML or Metal (pending the spike).
- Thread-count tuning. `numThreads` stays 2 until the spike measures 2 against 4.
- Models outside the six below.
- Cloud translation.

## Current state (baseline `3af86181`)

- **Engine:** `main/services/parakeet-engine.ts` builds only a NeMo-transducer `OfflineRecognizer`, CPU, 2 threads. It caches recognizers by model id with no cap.
- **Worker:**
  - `main/services/parakeet.ts` forks `build/main/parakeet-worker.js` as an Electron utility process.
  - Protocol v1 is in `parakeet-protocol.ts`; PCM travels as base64, either float32 from the renderer or PCM16 from Remote and CLI.
  - A FIFO lane (`parakeet-transcription-lane.ts`) serializes work.
  - A lease-based idle unloader (`parakeet-idle-unload.ts`) kills the process.
  - A fixed 120 s request timeout lives in `parakeet-process-core.ts`.
- **Catalog and downloads:** `main/services/local-models-core.ts`.
  - Two Parakeet int8 models, both labelled "620 MB"; the real archives are 487 MB and 482 MB.
  - No hash verification, and an 800 MB global cap.
  - `/usr/bin/tar -xjf` into a staging dir, then rename.
  - Storage at `<userData>/parakeet-models/<id>`.
- **Provider:** every call site uses `voiceProvider ?? "openai"`:
  - `main/services/transcription.ts:197`
  - `renderer/pill/pill-app.tsx:215,232,277`
  - `renderer/components/composer.tsx:643`
  - `renderer/components/settings/voice-settings.tsx:42`
- **Telegram:** `telegram-service.ts:500` wires `transcribeAudio: transcribe`. `transcribe()` routes everything except `gemini` to OpenAI, so on-device users get OpenAI or an error.
- **Remote:** `aiden-remote-speech-core.ts` projects `LocalModel[]` to iOS (`AidenRemoteClient.swift:29`, Codable) and Android (`AidenSpeech.kt`, lenient `Json { ignoreUnknownKeys = true }`). Additive fields are safe on both.

## Design

### 1. Module layout

Rename the Parakeet-specific modules to engine-neutral names. There is no compatibility shim; importers update in the same change.

| From | To |
|---|---|
| `parakeet.ts` | `local-speech.ts` (parent: lifecycle, lane, leases, supervisor wiring) |
| `parakeet-engine.ts` | `local-speech-engine.ts` (Electron-free sherpa adapter; runs in the worker, the CLI worker thread, and the in-process fallback) |
| `parakeet-worker.ts` | `local-speech-worker.ts` (build entry `build/main/local-speech-worker.js`; update `scripts/build-electron.mjs` and `scripts/verify-macos-package.mjs`) |
| `parakeet-protocol.ts` | `local-speech-protocol.ts` (v2) |
| `parakeet-process-core.ts` | `local-speech-process-core.ts` |
| `parakeet-transcription-lane.ts` | `local-speech-lane.ts` |
| `parakeet-idle-unload.ts` | `local-speech-idle-unload.ts` |
| `local-models-core.ts` | split into `local-speech-catalog.ts` (pure data plus selectors) and `local-speech-downloads.ts` (downloader) |
| `local-models.ts` | `local-speech-models.ts` (Electron wiring, IPC progress) |

New pure modules:
- `local-speech-language.ts` (language resolver)
- `local-speech-vad.ts` (segmentation planning)
- `renderer/shared/voice-provider.ts` (provider resolver; shared by main, renderer and CLI)

Matching test files are renamed with their modules.

IPC channel names stay stable (`localVoice:*`, `localModels:*`, `voice:transcribeLocal*`). The `utilityProcess` `serviceName` stays "Aiden Voice Transcription".

### 2. Catalog

`local-speech-catalog.ts` exports a frozen `SPEECH_MODELS` array. Each entry is a `SpeechModelSpec`:

```ts
type SpeechModelFamily = "nemo-transducer" | "nemo-canary" | "whisper" | "sense-voice" | "moonshine-v2";

interface SpeechModelSpec {
  id: string;                        // stable, /^[a-z0-9-]{1,64}$/
  name: string;
  description: string;               // one plain sentence
  family: SpeechModelFamily;
  archive: { url: string; bytes: number; sha256: string };
  /** Role → path inside the extracted directory. Every role must exist for `installed`. */
  files: Record<string, string>;
  /** ISO 639-1/3 base codes the model can transcribe. */
  languages: readonly string[];
  capabilities: {
    autoDetect: boolean;             // model can pick the language itself
    languageHint: boolean;           // model accepts an explicit source language
    translateToEnglish: boolean;
    /** Longest single decode window; longer speech is VAD-segmented. */
    maxWindowSeconds: number | null;
  };
  /** 0..1, from Handy's catalog.json at f6b3f82 (score / 100). Relative, display-only. */
  accuracy: number;
  speed: number;
  recommended: boolean;              // exactly one entry
  license: { name: string; url: string; attribution?: string };
}
```

**The six entries.** All archives come from `https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/`. Sizes and digests were read from the GitHub release asset API on 2026-10-09.

| id | Archive | Bytes | sha256 | Family | Files kept | Languages | Auto | Hint | Translate | Window | Acc / Speed | License |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `parakeet-v3` ★ | `sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2` | 487170055 | `5793d0fd397c5778d2cf2126994d58e9d56b1be7c04d13c7a15bb1b4eafb16bf` | nemo-transducer | `encoder.int8.onnx`, `decoder.int8.onnx`, `joiner.int8.onnx`, `tokens.txt` | 25 European (bg hr cs da nl en et fi fr de el hu it lv lt mt pl pt ro ru sk sl es sv uk) | ✓ | – | – | null | 0.88 / 0.79 | CC-BY-4.0 (NVIDIA) |
| `parakeet-v2` | `sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8.tar.bz2` | 482468385 | `157c157bc51155e03e37d2466522a3a737dd9c72bb25f36eb18912964161e1ad` | nemo-transducer | same four | en | – | – | – | null | 0.89 / 0.85 | CC-BY-4.0 (NVIDIA) |
| `canary-180m-flash` | `sherpa-onnx-nemo-canary-180m-flash-en-es-de-fr-int8.tar.bz2` | 153692328 | `7a38ed8b13f014ad632b09ff8d22e0c6f1359dd046af9235d281dfae841b9ab9` | nemo-canary | `encoder.int8.onnx`, `decoder.int8.onnx`, `tokens.txt` | en de es fr | – | ✓ | ✓ (de/es/fr → en) | null | 0.88 / 0.98 | CC-BY-4.0 (NVIDIA) |
| `whisper-turbo` | `sherpa-onnx-whisper-turbo.tar.bz2` | 563790207 | **computed once at implementation** (GitHub publishes no digest for this asset) | whisper | `turbo-encoder.int8.onnx`, `turbo-decoder.int8.onnx`, `turbo-tokens.txt` | 99 (Whisper set) | ✓ | ✓ | – (turbo was trained without translation) | 30 | 0.88 / 0.35 | MIT (OpenAI) |
| `sense-voice` | `sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2` | 163002883 | `7d1efa2138a65b0b488df37f8b89e3d91a60676e416f515b952358d83dfd347e` | sense-voice | `model.int8.onnx`, `tokens.txt` | zh yue en ja ko | ✓ | ✓ | – | 30 | 0.81 / 0.98 | FunASR Model License 1.1 (attribution: "SenseVoice Small, Alibaba FunAudioLLM") |
| `moonshine-base-en` | `sherpa-onnx-moonshine-base-en-quantized-2026-02-27.tar.bz2` | 111266225 | `43232c1d13013d37317163baec3135bd771a186a4356f28c889bab453bb0e891` | moonshine-v2 | `encoder_model.ort`, `decoder_model_merged.ort`, `tokens.txt` | en | – | – | – | 30 | 0.80 / 0.99 | MIT (Moonshine English models) |

Catalog notes:
- **SenseVoice:** the 2024-07-17 build is the original FunAudioLLM SenseVoiceSmall. The 2025-09-09 int8 export is a Cantonese fine-tune (ASLP-lab WSYue) and is not used.
- **Moonshine v2:** its config uses `moonshine: { encoder, mergedDecoder }`. The native addon in 1.13.x has supported `mergedDecoder` since before 1.13.4, even though `types.js` still documents only the v1 fields.
- **Whisper turbo:** the implementer downloads the archive once, records its sha256 in the catalog, and notes the date in the plan. Every other digest above is final.
- **Size labels:** `sizeLabel` is derived from `archive.bytes` (decimal MB, rounded), never hand-written.
- **Bundled VAD:** the Silero model is shipped inside the app, not downloaded.
  - File: `silero_vad.onnx`, 643854 bytes, sha256 `9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6`, from the same release tag. MIT license.
  - It is committed to `resources/speech/silero_vad.onnx`, listed in electron-builder `extraResources`, copied into the CLI bundle, and its hash is asserted by a test.

### 3. Downloads (`local-speech-downloads.ts`)

The downloader is a port of Handy's hardened `managers/model/download.rs` behavior into Node `fetch` streams.

- **Partial file.** Bytes go to `<root>/.partial/<id>.tar.bz2.part`. On start, an existing partial file of size *n* (0 < *n* < `bytes`) resumes with `Range: bytes=n-`.
- **Resume responses.**

  | Response | Action |
  |---|---|
  | 206 | `Content-Range` must start at exactly *n*, or the partial is discarded and the download restarts. |
  | 200 to a Range request | Truncate and restart from 0. |
  | 416 | Accepted only when the partial size equals `bytes` and its hash matches. Otherwise discard and restart. |
- **Size bound.** The stream is cut at the first byte past `archive.bytes`, which fails the download. The final size must equal `bytes`. This replaces the global 800 MB cap.
- **Timeouts.** Connect 15 s. A stall (no bytes for 60 s) aborts with a retryable error. There are no automatic retries; the user presses Download again and it resumes.
- **Hashing.**
  - A streaming SHA-256 runs as bytes arrive.
  - On resume, the existing partial is hashed first by reading it from disk, because Node `Hash` state can't be persisted.
  - Verification runs before extraction. On a mismatch the partial is deleted and the user sees "The download was corrupted. Try again."
- **Extraction.**
  - Extract into `<root>/<id>.extracting/`.
  - Strip the top directory, then delete everything that isn't in `files`, so test WAVs and unused precisions don't stay on disk.
  - Check that every role in `files` exists, then atomically rename to `<root>/<id>/`.
- **Cleanup.** Stale `.part` files and `.extracting/` dirs for unknown ids, or with no active download, are removed when the catalog is listed.
- **Progress** keeps the existing `localModels:progress` shape: 0–90 % download, 90 % verify, 90–100 % extract. A new `phase: "verify"` value is added to `LocalModelDownloadState` (an additive Remote field).
- **Cancel** aborts the stream and keeps the partial for resume. Delete removes both the partial and the model.

### 4. Storage

- **Desktop** root is `<userData>/voice-models/`, mode 0700. **CLI** root is `<agentDir>/voice-models`.
- **Old folders are not migrated** (pre-1.0 rule).
  - At startup, if `<userData>/parakeet-models/` exists, it is removed in the background.
  - Any `localVoiceModel` value that doesn't name an installed catalog model is treated as unset (§9).
  - The one-time re-download yields a hash-verified copy. The CLI does the same for `<agentDir>/parakeet-models`.

### 5. Engine adapter (`local-speech-engine.ts`)

- **One model slot.** The engine holds at most one loaded `OfflineRecognizer`. Loading a different model releases the current one first. This matches Handy's single-worker rule and bounds memory: Whisper turbo plus Parakeet together would exceed 1.5 GB.
- **Family config builders.** A pure `buildRecognizerConfig(spec, dir, request)` returns the sherpa config. Shared fields are `featConfig { sampleRate: 16000, featureDim: 80 }`, `numThreads: 2` and `provider: "cpu"`.

  | Family | Model config |
  |---|---|
  | nemo-transducer | `transducer { encoder, decoder, joiner }`, `modelType: "nemo_transducer"` |
  | nemo-canary | `canary { encoder, decoder, srcLang, tgtLang, usePnc: 1 }` |
  | whisper | `whisper { encoder, decoder, language, task: "transcribe" }` (sherpa's default `tailPaddings`) |
  | sense-voice | `senseVoice { model, language, useInverseTextNormalization: 1 }` |
  | moonshine-v2 | `moonshine { encoder, mergedDecoder }` |

  Every family also sets `tokens`.
- **Per-request language and task.**
  - Whisper's language is applied per stream via `OfflineStream.setOption("language", code)`.
  - Canary's `srcLang`/`tgtLang` and SenseVoice's `language` are applied with `OfflineRecognizer.setConfig(...)` only when they differ from the last request. Both are exposed by the 1.13.8 node API.
  - If either call throws on a given family, the recognizer is rebuilt for that request. A unit test with a fake sherpa module covers this fallback.
- **Result.**
  - `getResult(stream)` returns sherpa's JSON.
  - The adapter returns `{ text, language: string | null, decodeMs }`.
  - `language` is the detected code when sherpa reports one (Whisper `lang`, SenseVoice `lang` tags normalized to base codes), otherwise `null`.
  - Text is trimmed. Segment texts are joined with a single space, except that CJK-to-CJK boundaries are joined with no space.

### 6. VAD trimming and segmentation (`local-speech-vad.ts`)

This runs inside the worker before decode, using sherpa's `Vad` with the bundled Silero model.

**Configuration.** Values are taken from Handy's `SmoothedVad` and adapted to sherpa's API.

| Setting | Value | Note |
|---|---|---|
| `threshold` | 0.3 | |
| `minSilenceDuration` | 0.45 s | Handy's offline hangover |
| `minSpeechDuration` | 0.06 s | Handy's onset |
| `windowSize` | 512 | |
| `maxSpeechDuration` | 28 s | |

**Planning.** A pure `planSegments(regions, totalSamples, maxWindowSeconds)` takes the VAD speech regions and returns the sample ranges to decode:
- add 450 ms pre-roll and 450 ms post-roll, clamped to the clip;
- merge regions whose padded ranges overlap or are less than 300 ms apart;
- for windowed families, greedily pack merged regions into windows of at most `maxWindowSeconds - 2` (28 s), splitting only at region boundaries. A single region longer than 28 s is split at the 28 s limit, which sherpa already enforces through `maxSpeechDuration`;
- for unwindowed families (Parakeet, Canary), return one range from the first region's padded start to the last region's padded end, so silence is trimmed but the context is whole.

**Edge cases.**
- No speech regions: return `{ text: "", language: null }` without decoding. This is the guard against Whisper hallucinating on silence.
- Clips shorter than 1 s are zero-padded to 1.25 s before VAD and decode, as Handy does.
- VAD failure (model missing or a throw) fails open: decode the whole clip as one range (windowed families still get fixed 28 s chunks) and log a warning.

**Setting.** `voiceTrimSilence` (default `true`). When it's off, decode the whole clip, using fixed 28 s chunks for windowed families.

### 7. Worker protocol v2 and supervision

**Messages** (`local-speech-protocol.ts`, `version: 2`):
- Parent to worker:
  - `status`
  - `load { modelId, modelDirectory, spec }` (replaces `warm`)
  - `transcribe { modelId, modelDirectory, spec, pcm: Int16Array, sampleRate: 16000, language: string | null, task: "transcribe" | "translate", trimSilence: boolean }`
  - `release`
- Worker to parent: `result { …, text?, language?, decodeMs?, loadMs? }` and `failure { message, code?: "model-missing" | "engine-unavailable" | "decode-failed" }`.
- `pcm` is sent as a typed array through Electron's structured clone, not base64.

**PCM through the pipeline.**
- The renderer produces PCM16 once, in `renderer/lib/voice-recorder-core.ts` (float32 → clamped Int16), and sends it over `voice:transcribeLocal` as an `ArrayBuffer`.
- Remote and CLI already have PCM16; they decode base64 once in main.
- Compared with today's float32 base64 per hop, this is about 2.7× less data.
- *Implementation check:* confirm Electron 43 `UtilityProcess.postMessage` and `ipcRenderer.invoke` both structured-clone typed arrays. If either doesn't, fall back to base64 PCM16 on that hop only, which still halves today's payload.

**Validation.** Parsers in `local-speech-protocol.ts` validate:
- `pcm` length ≤ 16000 × 60 × 30 samples (30 minutes);
- `language` matches `/^[a-z]{2,3}$/` or is null;
- `spec.id` equals `modelId`.

**Supervision** (`local-speech-process-core.ts`), ported from Handy's `engine_supervisor`:

- **Deadlines scale with audio.** Load: 180 s. Transcribe: `max(120 s, 20 × audioSeconds)`. Status: 30 s. This replaces the fixed 120 s.
- **Crash or hang.**
  - The parent kills the worker and logs the last 64 stderr lines. The worker is forked with `stdio: "pipe"`; stderr is buffered in a ring of 64 lines and stdout is drained.
  - A batch `transcribe` is retried **once** in a fresh worker.
  - It is never retried after a user cancel, or after a second failure. A hang during a retry is reported as `decode-failed`.
- **Cancel stays kill-and-respawn-on-next-use,** as today. Queued requests are dropped by a lane epoch bump.
- **The renderer budget** (`renderer/lib/dictation-operation-gate.ts`, local 125 s) and the coordinator watchdog (135 s) become `max(current, 20 × audioSeconds + 15 s)`. Long local recordings can no longer time out on the renderer side before the worker's own deadline.

### 8. Language resolution (`local-speech-language.ts`)

**New settings** (§13):
- `voiceLanguage`: `"auto"` or a base code, default `"auto"`.
- `voiceTranslateToEnglish`: default `false`.

**`effectiveLanguage(spec, intent)`** is a pure function that resolves at the point of use and is never written back:
1. If `intent` is `"auto"`: return `null` (let the model detect) when `spec.capabilities.autoDetect`; otherwise `"en"` if supported, otherwise `spec.languages[0]`.
2. If `intent` is in `spec.languages`, return it.
3. Otherwise apply the aliases `nb→no`, `fil→tl`, `iw→he`, `in→id`, `zh-*→zh`, `yue-*→yue`, then retry step 2.
4. Otherwise fall back as in step 1. The UI shows "This model doesn't support <language>; using <fallback>."

**Per-family behavior:**
- **nemo-transducer:** the hint is ignored, because Parakeet takes no language prompt. Parakeet v2 is English-only.
- **Canary:** `srcLang` is the resolved code. When translating, `tgtLang = "en"`; otherwise `tgtLang = srcLang`.
- **Whisper and SenseVoice:** the resolved code, or `""` for auto.

**`effectiveTask(spec, settings, sourceLanguage)`:** returns `"translate"` only when `voiceTranslateToEnglish && spec.capabilities.translateToEnglish && sourceLanguage !== "en"`. A null source counts as not English only for models that can detect the language.

### 9. Provider resolution (`renderer/shared/voice-provider.ts`)

```ts
type VoiceProviderResolution =
  | { kind: "ready"; provider: "local"; modelId: string }
  | { kind: "ready"; provider: "openai" | "gemini" }
  | { kind: "needs-setup"; reason: "no-local-model" | "no-provider" | "local-engine-unavailable" };

function resolveVoiceProvider(input: {
  explicit: VoiceProvider | undefined;     // settings.voiceProvider
  localModelId: string | undefined;        // settings.localVoiceModel
  installedLocalModels: readonly string[]; // catalog order
  engineReady: boolean;
  hasOpenAIKey: boolean;
  hasGeminiVoice: boolean;                 // Gemini key with voice scope
}): VoiceProviderResolution;
```

**Rules.**
- **An explicit choice always wins.**
  - `local` with no installed model resolves to `needs-setup/no-local-model`; with the engine down, to `local-engine-unavailable`.
  - An explicit cloud provider resolves to `ready`, even without a key, so the existing key errors still surface.
- **With no explicit choice:**
  - If a local model is installed and the engine is ready, use local.
  - Otherwise use `openai` if it has a key, then `gemini` if it has voice scope.
  - Otherwise return `needs-setup/no-provider`.
- **The local model** is `localVoiceModel` if it is installed. Otherwise it is the first installed model in catalog order, which puts the recommended model first.

**Call sites.**
- All six `voiceProvider ?? "openai"` sites use the resolver, as do Telegram (§11) and Remote.
- Renderer callers get the resolution from a new `voice:resolveProvider` IPC. Main gathers the key presence and installed models; no secrets cross to the renderer.
- Settings → Voice shows the effective provider when none is explicit: "Automatic — using On-device (Parakeet v3)".
- The model manager's "auto-activate on first download" (`model-manager-view.tsx:163-175`) is removed, because the resolver makes it redundant. Downloading no longer silently rewrites `voiceProvider`.

### 10. Cloud language hints

- **OpenAI** (`transcription.ts`): add the multipart field `language=<code>` when `voiceLanguage` isn't `"auto"`.
- **Gemini Live** (`gemini-live-transcription.ts:93-101`): `inputAudioTranscription.languageCodes = [code]` when not auto.
- **Gemini batch:** pass the language only if the Interactions `transcription_config` accepts a language field, which is verified against the API docs during implementation. Otherwise it gets no hint, the same as today.
- **Translate** is never sent to cloud providers. The toggle only shows for local models that can translate (§14).

### 11. Telegram on-device routing

- `transcribe()` in `main/services/transcription.ts` uses the resolver. When it resolves to local:
  1. Telegram's OGG/Opus bytes are decoded to 16 kHz mono PCM16. `ogg-opus-decoder` (MIT, WASM) runs inside the speech worker, decoding at 48 kHz, downmixing, and resampling to 16 kHz with sherpa's `LinearResampler` (`resampler.js`).
  2. The PCM16 then goes through the normal lane.
- **Packaging size.** The decoder adds about 10 MB unpacked. During implementation, measure the packaged delta and record it in `.memory/packaging-size.md`. If it is over 5 MB, use `opus-decoder` with `codec-parser` directly, both from the same author and both MIT.
- **MIME types:** the local path accepts only `audio/ogg` and `audio/opus`, which is what Telegram voice notes use. Any other audio type (for example an `audio/mpeg` music file) skips transcription on local and gets the notice "This audio format needs a cloud voice provider." Cloud resolution handles every type as today.
- **Usage** is recorded with `providerId: "local-voice"`, as in the IPC path.

### 12. Model state, loading UI and the no-model guard

- **State broadcast.** The parent broadcasts `localVoice:state` with `{ modelId, state: "loading" | "ready" | "failed" | "unloaded", error? }` to the composer windows and the pill.
  - `loading` is emitted when a `load` or a load-triggering `transcribe` starts.
  - Only `ready` or `failed` end a loading state in the UI. An `unloaded` from idle unload that races a load is ignored, following Handy 417dc6a.
- **Slow-load notice.** When the user stops recording and the result is waiting on a load still in progress, the pill and composer show "Loading model…" only after 2 s (`SLOW_MODEL_LOAD_MS = 2000`). Warm loads never flash it. Once shown, it stays for that operation.
- **No-model guard.** The resolver runs on the dictation shortcut press (`dictation-coordinator.ts` `press`) and on the composer mic press, *before* the mic is opened.
  - `needs-setup` doesn't open the mic.
  - The pill shows an error with a Settings action: "Download a voice model in Settings → Voice" or "Set up a voice provider in Settings → Voice".
  - The composer shows the same copy in its existing voice error surface.
  - Warm-up (`load`) still fires on press when the resolution is local.

### 13. Settings

**New keys** in `main/services/types.ts` `AppSettings`:
- `voiceLanguage?: string` — `"auto"` or a base code; invalid values are dropped.
- `voiceTranslateToEnglish?: boolean`
- `voiceTrimSilence?: boolean` — default `true` when unset.

**Validation** goes in `parseDictationPreferencePatch`'s sibling, a new `parseVoicePreferencePatch` in `renderer/shared/voice-preferences.ts`. It is used by `settings:set` (`main/handlers/providers.ts`) and by `portable-config-core.ts`. `runtimeSettingsFrom` drops invalid shapes.

**Removed:** nothing besides the auto-activate behavior in §9. `localVoiceModel` keeps its meaning.

### 14. UI (Aiden visual language)

All changes extend existing components in `renderer/components/settings/`. They follow `docs/settings-design-system.md`: shared page headings, grouped cards, inset separators and trailing controls. They use semantic tokens from `renderer/styles.css` and `renderer/shared/appearance.ts`. Before building, review `docs/chatgpt-desktop-ui-inspiration.md` and `docs/chatgpt-ui-element-specimen.html` per AGENTS.md. Nothing is copied from Handy's UI.

- **Model manager** (`model-manager-view.tsx`):
  - Each row keeps its existing accuracy and speed meters and the Recommended badge.
  - New on each row:
    - a language summary ("25 languages", "English", "Chinese, Cantonese, English, Japanese, Korean");
    - capability labels (Auto-detect, Translate);
    - the derived size;
    - a licence line with attribution in secondary text.
  - Download progress gains "Verifying…" between download and extract.
  - Errors use the soft semantic status fill, with no colored borders.
- **Voice settings** (`voice-settings.tsx` / `local-voice-settings.tsx`):
  - **Language:** a select with Auto plus each language the active provider supports. On-device shows the active model's set; cloud shows a curated common list. Its trailing caption shows the fallback notice from §8 when it applies.
  - **Translate to English:** a switch, shown only when the active local model can translate.
  - **Trim silence:** a switch, default on, under On-Device Engine.
  - **Provider:** the select gains an "Automatic" choice, which is the unset state, with the resolved provider as its caption.
- **Pill and composer:** add "Loading model…" and the needs-setup error to the existing state copy and styling. No new geometry.
- **Accessibility:** new controls keep `focus-visible` rings. Selects and switches reuse shared primitives.

### 15. Remote, native clients and CLI

- **Remote `GET /speech`** lists six models. Existing fields keep their meaning; `sizeLabel` now carries the real size. The additive fields are:
  - `languages`
  - `capabilities`
  - `license`
  - the download `phase: "verify"`

  The contract revision isn't bumped because no client needs the new fields. Check against main at merge time per AGENTS.md: if another PR has claimed a revision for a speech change, coordinate.
- **Remote transcription** uses the resolved local model, `voiceLanguage`, task and trim. Its 60 s cap is unchanged.
- **Native checks:**
  - iOS `AidenWorkspaceShellView.swift` and Android `AidenVoiceSettingsScreen.kt` render a six-row model list correctly, with long names and the new size labels.
  - A "verify" phase doesn't break progress display. Both clients treat `phase` as a display string; confirm it.
  - Run `ios/AidenOnTheGoTests/AidenRemoteClientTests.swift` and `android/.../AidenRemoteClientTest.kt`. Add a decode test with the additive fields to each.
- **CLI:**
  - `packages/cli` picks up the renamed modules through `aidenRelativeTsRewritePlugin`.
  - `aiden speech status|download|select|delete|transcribe` lists and uses all six models.
  - `sherpa-onnx-node` becomes an exact `1.13.8` pin in `packages/cli/package.json`, matching the desktop.
  - The CLI bundles `silero_vad.onnx`.
  - `/voice` and `/dictate` defaults are out of scope (sub-project 4).

### 16. Network and privacy posture

- **Model archives** are fetched only after an explicit user action: Settings Download, the Remote download route, or `aiden speech download`.
- **Nothing hits the network for speech models** at startup, on listing, in onboarding navigation, or from background work. Catalog data, including hashes, lives in source.
- **Silero VAD** is bundled, so it never touches the network.
- **No audio or transcript** leaves the device on the local path.
- **Telegram local decoding** happens in-process.

## Testing

All tests are behavioral. They are registered in `test:voice`, and a new file added outside it is registered in the matching lane script. Test files are renamed with their modules (§1).

| Area | Test | Oracle |
|---|---|---|
| Catalog | `local-speech-catalog.test.ts` | Every entry's `files` roles map to real config fields in `buildRecognizerConfig` output; exactly one `recommended`; ids are unique and valid; every sha256 is 64 lowercase hex characters; `sizeLabel` derives from bytes. These are independent invariants, not a list reflected through itself. |
| Config builders | `local-speech-engine.test.ts` with a fake sherpa module | Canary translate sets `tgtLang: "en"`; Whisper auto passes `""` and sets the stream option; a `setConfig` throw triggers a rebuild; the single slot releases the previous recognizer; CJK segment joining. |
| Downloader | `local-speech-downloads.test.ts` against a local `node:http` fixture | Resume with 206 at the right offset; 206 at a wrong offset restarts; 200 to Range restarts; 416 with a complete, valid partial succeeds; hash mismatch deletes the partial and errors; an oversize stream is cut; a stall times out using an injected clock; cancel keeps the partial; extraction prunes non-required files; leftovers are cleaned. Uses small synthetic tar.bz2 archives built in the test. |
| Language | `local-speech-language.test.ts` | Resolution table across all six specs × {auto, en, de, yue, nb, unsupported}; `effectiveTask` matrix. |
| VAD planning | `local-speech-vad.test.ts` | `planSegments` on synthetic region lists: padding, merging, 28 s packing, oversize split, empty result, unwindowed single range. |
| VAD integration | Same file, real sherpa `Vad` on generated PCM (sine bursts plus silence) | Detects bursts within ±60 ms; all-silence returns no regions. Runs where `sherpa-onnx-node` loads; otherwise skips with a reason. |
| Protocol | `local-speech-protocol.test.ts` | v2 round trip with an `Int16Array`; rejects oversize PCM, bad language codes and a mismatched spec id. |
| Supervision | `local-speech-process-core.test.ts` with a fake child | Crash → one retry → success; second crash → `decode-failed`; hang beyond the scaled deadline → kill and retry; cancel → no retry; stderr tail captured. |
| Provider resolver | `renderer/shared/voice-provider.test.ts` | Full decision table from §9. |
| Telegram | Extend `aiden-remote-speech.test.ts` or a new `transcription-routing.test.ts` | Local resolution routes OGG/Opus through decode and the lane (fake decoder and lane); cloud resolution is unchanged. |
| Settings | Extend `dictation-preferences.test.ts` or add `voice-preferences.test.ts` | Patch parsing and invalid-shape dropping for the three new keys. |
| UI | Testing Library on `model-manager-view` and `voice-settings` | Rows render language, capability and licence text; the Translate switch appears only for Canary; Automatic shows the resolved caption; "Verifying…" appears in the verify phase. No className assertions. |
| Pill | Extend pill tests | "Loading model…" appears only after 2 s on a fake clock; needs-setup never calls `getUserMedia`. |
| Bundle | `scripts/verify-macos-package.test.mjs`, CLI `tests/bundle.test.mjs` | Worker entry renamed; `silero_vad.onnx` present with the pinned hash. |
| Native | iOS and Android Remote client tests | Decode `/speech` with the additive fields. |
| Smoke (opt-in) | `AIDEN_STT_SMOKE=1 npm run test:stt-smoke` (not in CI) | Downloads the six real archives on explicit opt-in, verifies hashes, and transcribes a `say`-generated WAV with each model, asserting key words. Used once before merge and recorded in the PR. |

**Suites before PR:**
- `npm run test:voice`
- `npm run test:aiden-remote-speech`
- the serial lane for the renamed files
- `npm run type-check`
- scoped ESLint
- the Vite build
- the CLI build, typecheck and tests
- the iOS and Android Remote client tests

## Acceptance (definition of done)

1. All six models download with hash verification, resume after a forced interruption, and transcribe a test phrase on this Mac. Recorded via the smoke run.
2. Whisper turbo transcribes a 90 s recording without truncation, through VAD segmentation.
3. A 10 s recording that is all silence returns an empty transcript for every model, with no hallucinated text.
4. Language set to German with Canary transcribes German; Translate on gives English.
5. Killing the worker mid-decode recovers through one retry, and the transcript arrives.
6. On a fresh profile with no keys and no models, the dictation shortcut shows the needs-setup pill and the mic indicator never lights.
7. A Telegram voice note with only Parakeet installed is transcribed on-device, and the usage record says local.
8. iOS and Android list six models from the Mac and can select and download one.
9. The `parakeet-models/` folder is gone after the first launch, and the new root holds verified models.

## Risks and verification items

- **Structured clone of typed arrays** over `utilityProcess` and `ipcRenderer.invoke` in Electron 43. There is a fallback in §7.
- **Gemini batch language field** existence (§10). The fallback is no hint.
- **Moonshine v2 `.ort` files** need ONNX Runtime ORT-format support in sherpa's bundled runtime. If loading fails on 1.13.8, drop Moonshine from the catalog for this sub-project and record why. The other five don't depend on it.
- **`ogg-opus-decoder` size** (§11) has a defined fallback.
- **Memory:** Whisper turbo int8 is expected to peak around 1–1.5 GB RSS in the worker. The single-slot rule and idle unload bound it. Record the measured peak in the PR.
- **Handy scores** were measured on transcribe.cpp. They are relative display hints only.

## Licensing and attribution

- Model licences are shown in the model manager and kept in the catalog: CC-BY-4.0 (NVIDIA Parakeet and Canary), MIT (Whisper, Moonshine English), and the FunASR Model License 1.1 for SenseVoice, which requires attribution and keeping the model name.
- Silero VAD is MIT.
- Handy-derived behavior is recorded in `.memory/` with the Handy commit `f6b3f82` and the file paths studied:
  - `managers/model/download.rs`
  - `engine_supervisor/supervisor.rs`
  - `audio_toolkit/audio/vad.rs`
  - `managers/model.rs` (`effective_language`)
  - `src/overlay/RecordingOverlay.tsx`
