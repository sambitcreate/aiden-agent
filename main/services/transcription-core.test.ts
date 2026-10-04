import assert from "node:assert/strict";
import test from "node:test";
import { GEMINI_TRANSCRIPTION_MODEL } from "../../renderer/shared/voice-models.js";
import {
  buildGeminiTranscriptionRequest,
  GEMINI_INTERACTIONS_ENDPOINT,
  parseGeminiTranscriptionResponse,
  startTranscriptionDeadline,
  transcriptionTimeoutMs,
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

test("a transcription without a caller signal is still aborted at its deadline and reported as a timeout", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const deadline = startTranscriptionDeadline(64 * 1024);
  t.mock.timers.tick(transcriptionTimeoutMs(64 * 1024) - 1);
  assert.equal(deadline.signal.aborted, false);
  t.mock.timers.tick(1);
  assert.equal(deadline.signal.aborted, true);
  const failure = deadline.failure(deadline.signal.reason) as Error;
  assert.equal(failure.name, "TimeoutError");
  assert.match(failure.message, /timed out after \d+ s/u);
  deadline.dispose();
});

test("caller cancellation passes through unchanged and a disposed deadline never fires", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const caller = new AbortController();
  const cancelled = startTranscriptionDeadline(0, caller.signal);
  const reason = new Error("user stopped dictation");
  caller.abort(reason);
  assert.equal(cancelled.signal.reason, reason);
  assert.equal(cancelled.failure(reason), reason, "a user cancel is not a timeout");
  cancelled.dispose();

  const finished = startTranscriptionDeadline(0);
  finished.dispose();
  t.mock.timers.tick(10 * 60_000);
  assert.equal(finished.signal.aborted, false);
});

test("transcription deadlines grow with audio size up to a cap", () => {
  const short = transcriptionTimeoutMs(100 * 1024);
  const long = transcriptionTimeoutMs(10 * 1024 * 1024);
  assert.ok(short >= 120_000 && short < long);
  assert.equal(transcriptionTimeoutMs(1024 * 1024 * 1024), 5 * 60_000);
  assert.equal(transcriptionTimeoutMs(Number.NaN), transcriptionTimeoutMs(0));
});
