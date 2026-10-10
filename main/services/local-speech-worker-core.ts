// Shared request handler for the on-device speech worker. The Electron
// utility process and the CLI worker thread both route protocol frames here.

import { effectiveTask } from "../../renderer/shared/voice-language.js";
import { speechEngine, type EngineTranscribeRequest, type EngineTranscribeResult } from "./local-speech-engine.js";
import type { SpeechModelSpec } from "./local-speech-catalog.js";
import { decodeOggOpusToPcm16k } from "./local-speech-opus.js";
import {
  isLocalSpeechParentMessage,
  LOCAL_SPEECH_PROTOCOL_VERSION,
  MAX_PCM_SAMPLES,
  type LocalSpeechAudio,
  type LocalSpeechFailureCode,
  type LocalSpeechParentMessage,
  type LocalSpeechWorkerMessage,
} from "./local-speech-protocol.js";

export interface LocalSpeechWorkerEngine {
  status(): { ready: boolean; error: string | null };
  load(spec: SpeechModelSpec, dir: string): { loadMs: number };
  transcribe(request: EngineTranscribeRequest): EngineTranscribeResult;
  release(): void;
}

export interface LocalSpeechWorkerOptions {
  /** Ogg/Opus → 16 kHz mono float samples. Without one, Ogg/Opus is unsupported audio. */
  decodeOggOpus?: (bytes: Uint8Array) => Promise<Float32Array>;
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
  const samples = await options.decodeOggOpus(audio.bytes);
  // PCM frames are bounded by the protocol guard; compressed notes are only
  // bounded once decoded, so enforce the same 30-minute limit here.
  if (samples.length > MAX_PCM_SAMPLES) {
    throw new UnsupportedAudioError("This voice note is too long for on-device transcription.");
  }
  return samples;
}

function failureCode(
  error: unknown,
  engine: LocalSpeechWorkerEngine,
  kind: LocalSpeechParentMessage["kind"],
): LocalSpeechFailureCode | undefined {
  if (error instanceof Error && error.name === "ModelMissingError") return "model-missing";
  if (error instanceof UnsupportedAudioError) return "unsupported-audio";
  if (!engine.status().ready) return "engine-unavailable";
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
          return { ...base, kind: "result", ...engine.status() };
        case "load":
          return { ...base, kind: "result", loadMs: engine.load(message.spec, message.modelDirectory).loadMs };
        case "release":
          engine.release();
          return { ...base, kind: "result" };
        case "transcribe": {
          const samples = await decodeAudio(message.audio, options);
          const result = engine.transcribe({
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
      const code = failureCode(error, engine, message.kind);
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
