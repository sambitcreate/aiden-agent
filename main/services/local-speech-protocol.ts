// Versioned message protocol between the parent process and the isolated
// on-device speech worker (Electron utility process or CLI worker thread).
// Audio crosses as binary PCM16 (or Ogg/Opus bytes) via structured clone.

import type { SpeechModelFamily, SpeechModelSpec } from "./local-speech-catalog.js";

export const LOCAL_SPEECH_PROTOCOL_VERSION = 2 as const;
/** 30 minutes of 16 kHz mono audio. */
export const MAX_PCM_SAMPLES = 16_000 * 60 * 30;
/** Generous bound for 30 minutes of Opus even at high bitrates. */
export const MAX_OGG_OPUS_BYTES = 64 * 1024 * 1024;

export type LocalSpeechAudio = { kind: "pcm16"; pcm: Int16Array } | { kind: "ogg-opus"; bytes: Uint8Array };

type V = typeof LOCAL_SPEECH_PROTOCOL_VERSION;

export type LocalSpeechParentMessage =
  | { version: V; kind: "status"; requestId: string }
  | { version: V; kind: "load"; requestId: string; modelId: string; modelDirectory: string; spec: SpeechModelSpec }
  | {
      version: V;
      kind: "transcribe";
      requestId: string;
      modelId: string;
      modelDirectory: string;
      spec: SpeechModelSpec;
      audio: LocalSpeechAudio;
      language: string | null;
      translate: boolean;
      trimSilence: boolean;
      vadModelPath: string;
    }
  | { version: V; kind: "release"; requestId: string };

export type LocalSpeechFailureCode = "model-missing" | "engine-unavailable" | "decode-failed" | "unsupported-audio";

export type LocalSpeechWorkerMessage =
  | {
      version: V;
      kind: "result";
      requestId: string;
      ready?: boolean;
      error?: string | null;
      text?: string;
      language?: string | null;
      decodeMs?: number;
      loadMs?: number;
    }
  | { version: V; kind: "failure"; requestId: string; message: string; code?: LocalSpeechFailureCode };

const FAMILIES: readonly SpeechModelFamily[] = ["nemo-transducer", "nemo-canary", "whisper", "sense-voice", "moonshine-v2"];
const FAILURE_CODES: readonly LocalSpeechFailureCode[] = ["model-missing", "engine-unavailable", "decode-failed", "unsupported-audio"];
const LANGUAGE = /^[a-z]{2,3}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isSpecFor(value: unknown, modelId: unknown): boolean {
  if (!isRecord(value) || value.id !== modelId || !isNonEmptyString(modelId)) return false;
  if (!FAMILIES.includes(value.family as SpeechModelFamily)) return false;
  if (!isRecord(value.files)) return false;
  return Object.values(value.files).every((file) => typeof file === "string");
}

/**
 * Structured clone across Electron hops can deliver PCM as a different
 * ArrayBuffer view (for example a Node Buffer). Rebuild any even-length view
 * as an Int16Array over the same bytes; returns null for anything else.
 */
export function normalizePcm16(value: unknown): Int16Array | null {
  if (value instanceof Int16Array) return value;
  if (value instanceof ArrayBuffer) {
    return value.byteLength % 2 === 0 ? new Int16Array(value) : null;
  }
  if (!ArrayBuffer.isView(value) || value.byteLength % 2 !== 0) return null;
  if (value.byteOffset % 2 === 0) return new Int16Array(value.buffer, value.byteOffset, value.byteLength / 2);
  // Unaligned views (possible for pooled Buffers) need a copy.
  const copy = new Uint8Array(value.byteLength);
  copy.set(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  return new Int16Array(copy.buffer);
}

function normalizeBytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return null;
}

/** Validates the audio payload, normalizing its typed array in place. */
function isAudio(value: unknown): value is LocalSpeechAudio {
  if (!isRecord(value)) return false;
  if (value.kind === "pcm16") {
    const pcm = normalizePcm16(value.pcm);
    if (!pcm || pcm.length > MAX_PCM_SAMPLES) return false;
    value.pcm = pcm;
    return true;
  }
  if (value.kind === "ogg-opus") {
    const bytes = normalizeBytes(value.bytes);
    if (!bytes || bytes.length === 0 || bytes.length > MAX_OGG_OPUS_BYTES) return false;
    value.bytes = bytes;
    return true;
  }
  return false;
}

/**
 * Validates a parent → worker frame. PCM delivered as a non-Int16Array view
 * is rewritten to an Int16Array on the message object so receivers can rely
 * on the declared type.
 */
export function isLocalSpeechParentMessage(value: unknown): value is LocalSpeechParentMessage {
  if (!isRecord(value) || value.version !== LOCAL_SPEECH_PROTOCOL_VERSION) return false;
  if (!isNonEmptyString(value.requestId)) return false;
  switch (value.kind) {
    case "status":
    case "release":
      return true;
    case "load":
      return isNonEmptyString(value.modelDirectory) && isSpecFor(value.spec, value.modelId);
    case "transcribe":
      return (
        isNonEmptyString(value.modelDirectory) &&
        isSpecFor(value.spec, value.modelId) &&
        (value.language === null || (typeof value.language === "string" && LANGUAGE.test(value.language))) &&
        typeof value.translate === "boolean" &&
        typeof value.trimSilence === "boolean" &&
        typeof value.vadModelPath === "string" &&
        isAudio(value.audio)
      );
    default:
      return false;
  }
}

export function isLocalSpeechWorkerMessage(value: unknown): value is LocalSpeechWorkerMessage {
  if (!isRecord(value) || value.version !== LOCAL_SPEECH_PROTOCOL_VERSION) return false;
  if (!isNonEmptyString(value.requestId)) return false;
  if (value.kind === "failure") {
    return (
      typeof value.message === "string" &&
      (value.code === undefined || FAILURE_CODES.includes(value.code as LocalSpeechFailureCode))
    );
  }
  if (value.kind !== "result") return false;
  if (value.ready !== undefined && typeof value.ready !== "boolean") return false;
  if (value.error !== undefined && value.error !== null && typeof value.error !== "string") return false;
  if (value.text !== undefined && typeof value.text !== "string") return false;
  if (value.language !== undefined && value.language !== null && typeof value.language !== "string") return false;
  if (value.decodeMs !== undefined && typeof value.decodeMs !== "number") return false;
  if (value.loadMs !== undefined && typeof value.loadMs !== "number") return false;
  return true;
}
