import { GEMINI_TRANSCRIPTION_MODEL } from "../../renderer/shared/voice-models.js";

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
    };
  };
  store: false;
}

export function buildGeminiTranscriptionRequest(input: {
  audioBase64: string;
  mimeType: string;
  model?: string;
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
      },
    },
    // Match the old one-shot request's privacy boundary: Aiden does not need
    // server-side interaction history for a single dictation recording.
    store: false,
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
