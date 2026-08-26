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
