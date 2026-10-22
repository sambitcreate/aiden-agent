// Shared request handler for the on-device speech worker. The Electron
// utility process and the CLI worker thread both route protocol frames here.

import { effectiveTask } from "../../renderer/shared/voice-language.js";
import { speechEngine, type EngineTranscribeRequest, type EngineTranscribeResult } from "./local-speech-engine.js";
import type { SpeechModelSpec } from "./local-speech-catalog.js";
import { decodeOggOpusToPcm16k, OggOpusTooLongError } from "./local-speech-opus.js";
import { EngineUnavailableError } from "./local-speech-transcribe-cpp.js";
import {
  isLocalSpeechParentMessage,
  LOCAL_SPEECH_PROTOCOL_VERSION,
  MAX_PCM_SAMPLES,
  type LocalSpeechAudio,
  type LocalSpeechFailureCode,
  type LocalSpeechParentMessage,
  type LocalSpeechWorkerMessage,
} from "./local-speech-protocol.js";

type MaybePromise<T> = T | Promise<T>;

export interface LocalSpeechWorkerEngine {
  status(): MaybePromise<{ ready: boolean; error: string | null }>;
  load(spec: SpeechModelSpec, dir: string, language?: string | null): MaybePromise<{ loadMs: number }>;
  transcribe(request: EngineTranscribeRequest): MaybePromise<EngineTranscribeResult>;
  release(): void;
}

/**
 * Routes each model to the engine that runs it: GGUF models to transcribe.cpp
 * (when this worker has it), everything else to sherpa-onnx. Loading a model
 * on one engine releases the other, so one model is held at a time.
 */
export function createRoutedSpeechEngine(
  sherpa: LocalSpeechWorkerEngine,
  gguf: LocalSpeechWorkerEngine | null,
): LocalSpeechWorkerEngine {
  const pick = (spec: SpeechModelSpec): LocalSpeechWorkerEngine => {
    if (spec.family !== "parakeet-gguf") {
      gguf?.release();
      return sherpa;
    }
    if (!gguf) throw new EngineUnavailableError(`${spec.name} needs the Metal voice engine, which this build doesn't include.`);
    sherpa.release();
    return gguf;
  };
  return {
    status: () => sherpa.status(),
    load: (spec, dir, language) => pick(spec).load(spec, dir, language),
    transcribe: (request) => pick(request.spec).transcribe(request),
    release: () => {
      sherpa.release();
      gguf?.release();
    },
  };
}

export interface LocalSpeechWorkerOptions {
  /** Ogg/Opus → 16 kHz mono float samples. Without one, Ogg/Opus is unsupported audio. */
  decodeOggOpus?: (bytes: Uint8Array, options: { maxSamples: number }) => Promise<Float32Array>;
}

class UnsupportedAudioError extends Error {
  override name = "UnsupportedAudioError";
}

function pcm16ToFloat32(pcm: Int16Array): Float32Array {
  const samples = new Float32Array(pcm.length);
  for (let index = 0; index < pcm.length; index += 1) samples[index] = pcm[index]! / 32_768;
  return samples;
}

async function decodeAudio(audio: LocalSpeechAudio, options: LocalSpeechWorkerOptions): Promise<Float32Array> {
  if (audio.kind === "pcm16") return pcm16ToFloat32(audio.pcm);
  if (!options.decodeOggOpus) throw new UnsupportedAudioError("On-device voice can't decode Ogg/Opus audio yet.");
  let samples: Float32Array;
  try {
    // The decoder stops at the cap while decoding, so an over-long note never
    // holds its full PCM. The check below still guards any injected decoder.
    samples = await options.decodeOggOpus(audio.bytes, { maxSamples: MAX_PCM_SAMPLES });
  } catch (error) {
    if (error instanceof OggOpusTooLongError) throw new UnsupportedAudioError(error.message);
    throw error;
  }
  // PCM frames are bounded by the protocol guard; compressed notes are bounded
  // by the decoder, and the trimmed length is checked here as well.
  if (samples.length > MAX_PCM_SAMPLES) {
    throw new UnsupportedAudioError("This voice note is too long for on-device transcription.");
  }
  return samples;
}

async function failureCode(
  error: unknown,
  engine: LocalSpeechWorkerEngine,
  kind: LocalSpeechParentMessage["kind"],
): Promise<LocalSpeechFailureCode | undefined> {
  if (error instanceof Error && error.name === "ModelMissingError") return "model-missing";
  if (error instanceof UnsupportedAudioError) return "unsupported-audio";
  if (error instanceof Error && error.name === "EngineUnavailableError") return "engine-unavailable";
  if (!(await engine.status()).ready) return "engine-unavailable";
  return kind === "transcribe" ? "decode-failed" : undefined;
}

export function createLocalSpeechMessageHandler(
  engine: LocalSpeechWorkerEngine,
  options: LocalSpeechWorkerOptions = {},
): (message: LocalSpeechParentMessage) => Promise<LocalSpeechWorkerMessage> {
  return async (message) => {
    const base = { version: LOCAL_SPEECH_PROTOCOL_VERSION, requestId: message.requestId } as const;
    try {
      switch (message.kind) {
        case "status":
          return { ...base, kind: "result", ...(await engine.status()) };
        case "load":
          return {
            ...base,
            kind: "result",
            loadMs: (await engine.load(message.spec, message.modelDirectory, message.language ?? null)).loadMs,
          };
        case "release":
          engine.release();
          return { ...base, kind: "result" };
        case "transcribe": {
          const samples = await decodeAudio(message.audio, options);
          const result = await engine.transcribe({
            spec: message.spec,
            modelDirectory: message.modelDirectory,
            samples,
            language: message.language,
            task: effectiveTask(message.spec, message.translate, message.language),
            trimSilence: message.trimSilence,
            vadModelPath: message.vadModelPath,
          });
          return { ...base, kind: "result", text: result.text, language: result.language, decodeMs: result.decodeMs };
        }
      }
    } catch (error) {
      const code = await failureCode(error, engine, message.kind);
      return {
        ...base,
        kind: "failure",
        message: error instanceof Error ? error.message : String(error),
        ...(code ? { code } : {}),
      };
    }
  };
}

export const handleLocalSpeechMessage = createLocalSpeechMessageHandler(speechEngine, {
  decodeOggOpus: decodeOggOpusToPcm16k,
});

const INVALID_REQUEST_MESSAGE = "Invalid on-device transcription request.";

/**
 * Entry-point adapter for raw frames from the parent. Valid frames go to the
 * handler. An invalid frame that still names a request gets an immediate
 * failure so the parent does not wait out its hang deadlines; anything else
 * yields null and is dropped.
 */
export async function replyToWorkerFrame(
  frame: unknown,
  handle: (message: LocalSpeechParentMessage) => Promise<LocalSpeechWorkerMessage> = handleLocalSpeechMessage,
): Promise<LocalSpeechWorkerMessage | null> {
  if (isLocalSpeechParentMessage(frame)) return handle(frame);
  const requestId =
    typeof frame === "object" && frame !== null ? (frame as { requestId?: unknown }).requestId : undefined;
  if (typeof requestId !== "string" || requestId.length === 0) return null;
  return {
    version: LOCAL_SPEECH_PROTOCOL_VERSION,
    kind: "failure",
    requestId,
    message: INVALID_REQUEST_MESSAGE,
    code: "invalid-request",
  };
}
