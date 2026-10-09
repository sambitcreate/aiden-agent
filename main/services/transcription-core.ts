import { GEMINI_TRANSCRIPTION_MODEL } from "../../renderer/shared/voice-models.js";
import {
  voiceSetupMessage,
  type VoiceProviderResolution,
} from "../../renderer/shared/voice-provider.js";

export const GEMINI_INTERACTIONS_ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta/interactions";

export interface GeminiTranscriptionRequest {
  model: string;
  input: Array<{
    type: "audio";
    data: string;
    mime_type: string;
  }>;
  generation_config: {
    transcription_config: {
      mode: { type: "verbatim" };
      /** BCP-47 hints; omitted for automatic detection. */
      language_codes?: string[];
    };
  };
  store: false;
}

export function buildGeminiTranscriptionRequest(input: {
  audioBase64: string;
  mimeType: string;
  model?: string;
  language?: string;
}): GeminiTranscriptionRequest {
  return {
    model: input.model ?? GEMINI_TRANSCRIPTION_MODEL,
    input: [
      {
        type: "audio",
        data: input.audioBase64,
        mime_type: input.mimeType || "audio/wav",
      },
    ],
    generation_config: {
      transcription_config: {
        mode: { type: "verbatim" },
        ...(input.language ? { language_codes: [input.language] } : {}),
      },
    },
    // Match the old one-shot request's privacy boundary: Aiden does not need
    // server-side interaction history for a single dictation recording.
    store: false,
  };
}

/** Multipart body for OpenAI `/audio/transcriptions`. */
export function buildOpenAITranscriptionForm(input: {
  bytes: Uint8Array;
  mimeType: string;
  model: string;
  language?: string;
}): FormData {
  const form = new FormData();
  form.append(
    "file",
    new Blob([new Uint8Array(input.bytes)], { type: input.mimeType || "audio/webm" }),
    "audio.webm",
  );
  form.append("model", input.model);
  if (input.language) form.append("language", input.language);
  return form;
}

export interface TranscribeInput {
  audioBase64: string;
  mimeType: string;
  model?: string;
  signal?: AbortSignal;
}

export interface TranscribeRouterDeps {
  resolve(): Promise<VoiceProviderResolution>;
  local: { oggOpus(bytes: Uint8Array, modelId: string, signal?: AbortSignal): Promise<string> };
  openai(input: TranscribeInput): Promise<string>;
  gemini(input: TranscribeInput): Promise<string>;
}

/** Ogg/Opus is the only container the on-device path decodes (Telegram voice notes). */
const LOCAL_AUDIO_MIME = /^audio\/(ogg|opus)\b/i;

/**
 * Routes encoded audio (Telegram voice notes) through the resolved provider.
 * The renderer's recorded-audio path never comes here: it sends PCM to the
 * on-device lane or calls the cloud provider directly.
 */
export function createTranscribeRouter(deps: TranscribeRouterDeps): (input: TranscribeInput) => Promise<string> {
  return async (input) => {
    const resolution = await deps.resolve();
    if (resolution.kind === "needs-setup") throw new Error(voiceSetupMessage(resolution.reason));
    if (resolution.provider === "local") {
      if (!LOCAL_AUDIO_MIME.test(input.mimeType)) throw new Error("This audio format needs a cloud voice provider.");
      return deps.local.oggOpus(Buffer.from(input.audioBase64, "base64"), resolution.modelId, input.signal);
    }
    return resolution.provider === "gemini" ? deps.gemini(input) : deps.openai(input);
  };
}

export function parseGeminiTranscriptionResponse(value: unknown): {
  text: string;
  usage: unknown;
} {
  if (!value || typeof value !== "object") return { text: "", usage: undefined };
  const response = value as {
    steps?: unknown;
    usage?: unknown;
  };
  const steps = Array.isArray(response.steps) ? response.steps : [];
  const text = steps
    .flatMap((step) => {
      if (!step || typeof step !== "object") return [];
      const record = step as { type?: unknown; content?: unknown };
      if (record.type !== "model_output" || !Array.isArray(record.content)) return [];
      return record.content;
    })
    .map((content) => {
      if (!content || typeof content !== "object") return "";
      const record = content as { type?: unknown; text?: unknown };
      return record.type === "text" && typeof record.text === "string" ? record.text : "";
    })
    .filter(Boolean)
    .join(" ")
    .trim();
  return { text, usage: response.usage };
}

const TRANSCRIPTION_BASE_TIMEOUT_MS = 120_000;
const TRANSCRIPTION_MAX_TIMEOUT_MS = 5 * 60_000;
/** Extra allowance per 128 KiB of audio for long voice notes on slow uplinks. */
const TRANSCRIPTION_BYTES_PER_SECOND = 128 * 1024;

/** Deadline for one cloud transcription request, scaled by the audio size. */
export function transcriptionTimeoutMs(audioBytes: number): number {
  const bytes = Number.isFinite(audioBytes) && audioBytes > 0 ? audioBytes : 0;
  return Math.min(
    TRANSCRIPTION_MAX_TIMEOUT_MS,
    TRANSCRIPTION_BASE_TIMEOUT_MS + Math.ceil((bytes / TRANSCRIPTION_BYTES_PER_SECOND) * 1000),
  );
}

export interface TranscriptionDeadline {
  /** Aborts when the caller cancels or the deadline passes. */
  readonly signal: AbortSignal;
  /** Present a deadline abort as a timeout; pass other failures through. */
  failure(error: unknown): unknown;
  dispose(): void;
}

/**
 * Bound a cloud transcription request (upload, response and body read) even
 * when the caller supplies no signal, such as Telegram voice notes.
 */
export function startTranscriptionDeadline(
  audioBytes: number,
  callerSignal?: AbortSignal,
): TranscriptionDeadline {
  const timeoutMs = transcriptionTimeoutMs(audioBytes);
  const controller = new AbortController();
  let timedOut = false;
  const onCallerAbort = () => controller.abort(callerSignal?.reason);
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException("Voice transcription timed out.", "TimeoutError"));
  }, timeoutMs);
  if (callerSignal?.aborted) onCallerAbort();
  else callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
  return {
    signal: controller.signal,
    failure(error) {
      if (!timedOut) return error;
      return Object.assign(
        new Error(`Voice transcription timed out after ${Math.round(timeoutMs / 1000)} s.`),
        { name: "TimeoutError", cause: error },
      );
    },
    dispose() {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    },
  };
}
