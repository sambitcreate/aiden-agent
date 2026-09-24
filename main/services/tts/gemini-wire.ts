// Google Gemini TTS wire helpers: request bodies, strict response parsing,
// audio validation, and provider error classification.
//
// Everything here is pure and testable. The provider adapter supplies the SDK
// client; this module decides what a valid request and response look like.
// Raw provider strings never escape classification.

import type { TtsErrorCode, TtsModelId } from "../../../renderer/shared/tts.js";
import { TTS_LIMITS } from "../../../renderer/shared/tts.js";

export const TTS_AUDIO_SAMPLE_RATE = 24_000;
export const TTS_AUDIO_CHANNELS = 1;

export type TtsWireAudioMime = "audio/wav" | "audio/l16";

export interface TtsSynthesisWireRequest {
  model: TtsModelId;
  /** Exactly one prepared segment; the transcript is the literal speech text. */
  transcript: string;
  /** Resolved provider voice id, validated in main. */
  voice: string;
  /** Structured delivery style; empty string means no annotation. */
  style: string;
}

/** JSON-able interaction body for the Interactions API (unary WAV slice). */
export interface TtsInteractionBody {
  model: TtsModelId;
  store: false;
  stream: false;
  input: ReadonlyArray<{
    type: "user_input";
    content: ReadonlyArray<{
      type: "text";
      text: string;
      annotations?: ReadonlyArray<{ type: "speech_metadata"; style: string }>;
    }>;
  }>;
  response_format: {
    type: "audio";
    mime_type: "audio/wav";
    sample_rate: number;
  };
  generation_config: {
    speech_config: { speakers: ReadonlyArray<{ voice: string }> };
  };
}

/**
 * Build the synthesis request body. The transcript is never prefixed with
 * delivery instructions: it is the exact text to speak (plan §3.1).
 */
export function buildTtsInteractionBody(
  request: TtsSynthesisWireRequest,
): TtsInteractionBody {
  if (!request.transcript.trim()) {
    throw new TtsWireError("invalid_response", "Nothing to synthesize.");
  }
  if (Buffer.byteLength(request.transcript, "utf8") > TTS_LIMITS.segmentMaxBytes) {
    throw new TtsWireError("response_too_large", "Segment exceeds the size limit.");
  }
  if (!request.voice) {
    throw new TtsWireError("voice_unavailable", "No voice selected.");
  }
  return {
    model: request.model,
    store: false,
    stream: false,
    input: [
      {
        type: "user_input",
        content: [
          {
            type: "text",
            text: request.transcript,
            ...(request.style
              ? {
                  annotations: [
                    { type: "speech_metadata" as const, style: request.style },
                  ],
                }
              : {}),
          },
        ],
      },
    ],
    response_format: {
      type: "audio",
      mime_type: "audio/wav",
      sample_rate: TTS_AUDIO_SAMPLE_RATE,
    },
    generation_config: {
      speech_config: { speakers: [{ voice: request.voice }] },
    },
  };
}

export class TtsWireError extends Error {
  constructor(
    readonly code: TtsErrorCode,
    message: string,
    readonly retryable: boolean = false,
    readonly generationMayHaveBeenBilled: boolean = false,
  ) {
    super(message);
    this.name = "TtsWireError";
  }
}

export interface TtsSynthesizedAudio {
  bytes: Uint8Array;
  mimeType: TtsWireAudioMime;
  sampleRate: number;
  channels: number;
}

export interface TtsSynthesisUsage {
  /** Null when the provider did not report usage: never shown as zero cost. */
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface TtsUnarySynthesisResult {
  audio: TtsSynthesizedAudio;
  usage: TtsSynthesisUsage;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeBase64Strict(data: string): Uint8Array {
  if (typeof data !== "string" || data.length === 0) {
    throw new TtsWireError("invalid_response", "Audio payload is empty.");
  }
  const buffer = Buffer.from(data, "base64");
  if (buffer.byteLength === 0) {
    throw new TtsWireError("invalid_response", "Audio payload could not be decoded.");
  }
  return new Uint8Array(buffer);
}

interface WavInfo {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  dataBytes: number;
}

/**
 * Validate a RIFF/WAVE container. Chunks are parsed, not assumed: optional
 * chunks (LIST, fact) may precede fmt/data in any order.
 */
export function validateWavContainer(bytes: Uint8Array): WavInfo {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 12) {
    throw new TtsWireError("invalid_response", "Audio container is truncated.");
  }
  if (
    String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!) !== "RIFF" ||
    String.fromCharCode(bytes[8]!, bytes[9]!, bytes[10]!, bytes[11]!) !== "WAVE"
  ) {
    throw new TtsWireError("invalid_response", "Audio container is not WAV.");
  }
  let offset = 12;
  let fmt: WavInfo | null = null;
  let dataBytes = 0;
  while (offset + 8 <= bytes.byteLength) {
    const chunkId = String.fromCharCode(
      bytes[offset]!,
      bytes[offset + 1]!,
      bytes[offset + 2]!,
      bytes[offset + 3]!,
    );
    const chunkSize = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (body + chunkSize > bytes.byteLength) {
      throw new TtsWireError("invalid_response", "Audio chunk exceeds container.");
    }
    if (chunkId === "fmt " && chunkSize >= 16) {
      const audioFormat = view.getUint16(body, true);
      const channels = view.getUint16(body + 2, true);
      const sampleRate = view.getUint32(body + 4, true);
      const bitsPerSample = view.getUint16(body + 14, true);
      if (audioFormat !== 1 || bitsPerSample !== 16) {
        throw new TtsWireError(
          "invalid_response",
          "Audio format is not 16-bit PCM.",
        );
      }
      fmt = { sampleRate, channels, bitsPerSample, dataBytes: 0 };
    } else if (chunkId === "data") {
      dataBytes = chunkSize;
    }
    offset = body + chunkSize + (chunkSize % 2);
  }
  if (!fmt || dataBytes === 0) {
    throw new TtsWireError("invalid_response", "Audio container is missing PCM data.");
  }
  return { ...fmt, dataBytes };
}

function parseAudioContent(content: unknown): TtsSynthesizedAudio {
  if (!isRecord(content)) {
    throw new TtsWireError("invalid_response", "Audio content is malformed.");
  }
  const mimeType = content.mime_type;
  if (mimeType !== "audio/wav" && mimeType !== "audio/l16") {
    throw new TtsWireError("invalid_response", "Unexpected audio format.");
  }
  const bytes = decodeBase64Strict(content.data as string);
  if (bytes.byteLength > TTS_LIMITS.segmentAudioMaxBytes) {
    throw new TtsWireError("response_too_large", "Audio segment exceeds the size limit.");
  }
  if (mimeType === "audio/wav") {
    const info = validateWavContainer(bytes);
    return {
      bytes,
      mimeType,
      sampleRate: info.sampleRate,
      channels: info.channels,
    };
  }
  const sampleRate =
    typeof content.sample_rate === "number" ? content.sample_rate : TTS_AUDIO_SAMPLE_RATE;
  const channels =
    typeof content.channels === "number" ? content.channels : TTS_AUDIO_CHANNELS;
  if (sampleRate !== TTS_AUDIO_SAMPLE_RATE || channels !== TTS_AUDIO_CHANNELS) {
    throw new TtsWireError("invalid_response", "Unexpected PCM layout.");
  }
  return { bytes, mimeType, sampleRate, channels };
}

function parseUsage(usage: unknown): TtsSynthesisUsage {
  if (!isRecord(usage)) return { inputTokens: null, outputTokens: null };
  return {
    inputTokens:
      typeof usage.total_input_tokens === "number" ? usage.total_input_tokens : null,
    outputTokens:
      typeof usage.total_output_tokens === "number" ? usage.total_output_tokens : null,
  };
}

/**
 * Strictly parse a unary Interactions create response. Prefers the structured
 * steps; falls back to the convenience output_audio only when steps carry no
 * audio. Never merges both sources.
 */
export function parseUnarySynthesisResponse(
  response: unknown,
): TtsUnarySynthesisResult {
  if (!isRecord(response)) {
    throw new TtsWireError("invalid_response", "Provider response is malformed.");
  }
  const status = response.status;
  if (status !== "completed") {
    if (status === "failed" || isRecord(response.errors) || Array.isArray(response.errors)) {
      throw new TtsWireError("provider_unavailable", "The model could not generate speech.");
    }
    throw new TtsWireError(
      "response_incomplete",
      "Speech generation did not complete.",
      true,
      true,
    );
  }
  const steps = Array.isArray(response.steps) ? response.steps : [];
  for (const step of steps) {
    if (!isRecord(step) || step.type !== "model_output") continue;
    const contents = Array.isArray(step.content) ? step.content : [];
    for (const content of contents) {
      if (!isRecord(content) || content.type !== "audio") continue;
      return {
        audio: parseAudioContent(content),
        usage: parseUsage(response.usage),
      };
    }
  }
  if (isRecord(response.output_audio)) {
    return {
      audio: parseAudioContent(response.output_audio),
      usage: parseUsage(response.usage),
    };
  }
  throw new TtsWireError("invalid_response", "No audio in the provider response.");
}

/**
 * Classify a raw provider/transport error onto the closed error union.
 * Never leaks raw diagnostics into the returned message.
 */
export function classifyTtsProviderError(error: unknown): TtsWireError {
  if (error instanceof TtsWireError) return error;
  const raw = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  const statusMatch = /(?:\b|^)([45]\d\d)(?:\b|$)/u.exec(raw);
  const status = statusMatch ? Number(statusMatch[1]) : undefined;
  if (raw.includes("API key") || raw.includes("api key") || status === 401) {
    return new TtsWireError("invalid_credential", "The Google API key was rejected.");
  }
  if (status === 403 || raw.includes("PERMISSION_DENIED")) {
    return new TtsWireError("permission_denied", "Google denied access to this operation.");
  }
  if (status === 404 || raw.includes("NOT_FOUND")) {
    return new TtsWireError("not_found", "The requested model or voice is unavailable.");
  }
  if (status === 429 || raw.includes("RESOURCE_EXHAUSTED") || raw.includes("quota")) {
    return new TtsWireError(
      "quota",
      "Google usage limits were reached.",
      true,
      false,
    );
  }
  if (status !== undefined && status >= 500) {
    return new TtsWireError(
      "provider_unavailable",
      "Google is temporarily unavailable.",
      true,
      true,
    );
  }
  if (
    raw.includes("ENOTFOUND") ||
    raw.includes("ETIMEDOUT") ||
    raw.includes("ECONNRESET") ||
    raw.includes("fetch failed") ||
    raw.includes("AbortError") ||
    raw.includes("timed out")
  ) {
    return new TtsWireError(
      "network",
      "The network request to Google did not complete.",
      true,
      true,
    );
  }
  return new TtsWireError(
    "provider_unavailable",
    "Speech generation failed.",
    false,
    true,
  );
}

// --- Voices API helpers -----------------------------------------------------

export interface TtsVoiceSummary {
  /** Opaque provider resource id, e.g. "voices/..." or a prebuilt name. */
  providerVoiceId: string;
  name: string;
  kind: "prebuilt" | "prompted" | "replicated";
}

export interface TtsVoicesPage {
  voices: readonly TtsVoiceSummary[];
  nextPageToken: string | null;
}

export function parseVoicesListResponse(response: unknown): TtsVoicesPage {
  if (!isRecord(response)) {
    throw new TtsWireError("invalid_response", "Voice list response is malformed.");
  }
  const items = Array.isArray(response.voices) ? response.voices : [];
  const voices: TtsVoiceSummary[] = [];
  for (const item of items) {
    if (!isRecord(item)) continue;
    const id = item.id ?? item.name;
    const displayName = item.display_name ?? item.displayName;
    if (typeof id !== "string" || id.length === 0 || id.length > 512) continue;
    const kind =
      item.type === "prompted" || item.type === "replicated" || item.type === "prebuilt"
        ? (item.type as TtsVoiceSummary["kind"])
        : "prebuilt";
    voices.push({
      providerVoiceId: id,
      name: typeof displayName === "string" ? displayName : id,
      kind,
    });
  }
  const nextPageToken =
    typeof response.next_page_token === "string" && response.next_page_token.length > 0
      ? response.next_page_token
      : null;
  return { voices, nextPageToken };
}

/** Sentinel prebuilt starter voices curated for the first-run picker. */
export const TTS_STARTER_PREBUILT_VOICES: readonly TtsVoiceSummary[] = [
  { providerVoiceId: "Kore", name: "Kore", kind: "prebuilt" },
  { providerVoiceId: "Puck", name: "Puck", kind: "prebuilt" },
  { providerVoiceId: "Charon", name: "Charon", kind: "prebuilt" },
  { providerVoiceId: "Aoede", name: "Aoede", kind: "prebuilt" },
];
