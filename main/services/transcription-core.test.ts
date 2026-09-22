import assert from "node:assert/strict";
import test from "node:test";
import { GEMINI_TRANSCRIPTION_MODEL } from "../../renderer/shared/voice-models.js";
import {
  buildGeminiTranscriptionRequest,
  GEMINI_INTERACTIONS_ENDPOINT,
  parseGeminiTranscriptionResponse,
} from "./transcription-core.js";

test("Gemini 3.5 transcription uses a non-stored verbatim Interactions request", () => {
  assert.equal(
    GEMINI_INTERACTIONS_ENDPOINT,
    "https://generativelanguage.googleapis.com/v1beta/interactions",
  );
  assert.deepEqual(
    buildGeminiTranscriptionRequest({
      audioBase64: "UklGRg==",
      mimeType: "audio/wav",
    }),
    {
      model: GEMINI_TRANSCRIPTION_MODEL,
      input: [
        {
          type: "audio",
          data: "UklGRg==",
          mime_type: "audio/wav",
        },
      ],
      generation_config: {
        transcription_config: {
          mode: { type: "verbatim" },
        },
      },
      store: false,
    },
  );
});

test("Gemini Interactions responses return only model transcript text and usage", () => {
  const usage = {
    total_input_tokens: 12,
    total_output_tokens: 4,
    total_tokens: 16,
  };
  assert.deepEqual(
    parseGeminiTranscriptionResponse({
      steps: [
        { type: "user_input", content: [{ type: "text", text: "private input" }] },
        {
          type: "model_output",
          content: [
            { type: "text", text: "Hello from" },
            { type: "audio", data: "ignored" },
            { type: "text", text: "Gemini." },
          ],
        },
      ],
      usage,
    }),
    { text: "Hello from Gemini.", usage },
  );
  assert.deepEqual(parseGeminiTranscriptionResponse(null), {
    text: "",
    usage: undefined,
  });
});
