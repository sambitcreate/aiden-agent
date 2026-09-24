import assert from "node:assert/strict";
import test from "node:test";
import {
  buildTtsInteractionBody,
  classifyTtsProviderError,
  parseUnarySynthesisResponse,
  parseVoicesListResponse,
  validateWavContainer,
  TtsWireError,
  TTS_STARTER_PREBUILT_VOICES,
} from "./gemini-wire.js";
import { TTS_LIMITS } from "../../../renderer/shared/tts.js";

const BODY = {
  model: "gemini-3.8-flash-tts" as const,
  transcript: "Hello there.",
  voice: "Kore",
  style: "calm delivery",
};

test("the interaction body carries the exact transcript, no history, tools, or system text", () => {
  const body = buildTtsInteractionBody(BODY);
  assert.equal(body.model, "gemini-3.8-flash-tts");
  assert.equal(body.store, false);
  assert.equal(body.stream, false);
  assert.equal(body.input.length, 1);
  const [step] = body.input;
  assert.equal(step!.type, "user_input");
  const [content] = step!.content;
  assert.equal(content!.type, "text");
  assert.equal(content!.text, "Hello there.");
  assert.deepEqual(content!.annotations, [
    { type: "speech_metadata", style: "calm delivery" },
  ]);
  // No conversation history, no previous interaction, no tools, no prompts.
  const json = JSON.stringify(body);
  assert.doesNotMatch(json, /previous_interaction|tools|system_instruction/u);
  assert.equal(body.generation_config.speech_config.speakers[0]!.voice, "Kore");
});

test("the transcript appears exactly once and is never prefixed with instructions", () => {
  const body = buildTtsInteractionBody({ ...BODY, style: "say it calmly" });
  const json = JSON.stringify(body);
  const occurrences = json.split("Hello there.").length - 1;
  assert.equal(occurrences, 1);
  assert.doesNotMatch(json, /say it calmly: Hello there/u);
});

test("empty style omits the annotation entirely", () => {
  const body = buildTtsInteractionBody({ ...BODY, style: "" });
  assert.equal(body.input[0]!.content[0]!.annotations, undefined);
});

test("body builder rejects empty transcripts, oversized segments, and missing voices", () => {
  assert.throws(
    () => buildTtsInteractionBody({ ...BODY, transcript: "  " }),
    (error: unknown) => error instanceof TtsWireError && error.code === "invalid_response",
  );
  assert.throws(
    () =>
      buildTtsInteractionBody({
        ...BODY,
        transcript: "x".repeat(TTS_LIMITS.segmentMaxBytes + 1),
      }),
    (error: unknown) => error instanceof TtsWireError && error.code === "response_too_large",
  );
  assert.throws(
    () => buildTtsInteractionBody({ ...BODY, voice: "" }),
    (error: unknown) => error instanceof TtsWireError && error.code === "voice_unavailable",
  );
});

function wavBytes(options?: { sampleRate?: number; channels?: number; extraChunk?: boolean }): Uint8Array {
  const sampleRate = options?.sampleRate ?? 24000;
  const channels = options?.channels ?? 1;
  const samples = new Uint8Array(32);
  const chunks: Uint8Array[] = [];
  const fmt = new Uint8Array(16);
  const fmtView = new DataView(fmt.buffer);
  fmtView.setUint16(0, 1, true);
  fmtView.setUint16(2, channels, true);
  fmtView.setUint32(4, sampleRate, true);
  fmtView.setUint16(14, 16, true);
  chunks.push(ascii("fmt "), u32(fmt.byteLength), fmt);
  if (options?.extraChunk) {
    const list = ascii("INFO");
    chunks.push(ascii("LIST"), u32(list.byteLength + (list.byteLength % 2)), list);
  }
  chunks.push(ascii("data"), u32(samples.byteLength), samples);
  const body = concat(chunks);
  return concat([ascii("RIFF"), u32(4 + body.byteLength), ascii("WAVE"), body]);
}

function ascii(value: string): Uint8Array {
  const out = new Uint8Array(value.length);
  for (let i = 0; i < value.length; i += 1) out[i] = value.charCodeAt(i);
  return out;
}

function u32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, true);
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

test("WAV validation parses chunks, not a fixed 44-byte header", () => {
  const withList = validateWavContainer(wavBytes({ extraChunk: true }));
  assert.equal(withList.sampleRate, 24000);
  assert.equal(withList.channels, 1);
  assert.equal(withList.bitsPerSample, 16);
  assert.equal(withList.dataBytes, 32);

  const stereo = validateWavContainer(wavBytes({ channels: 2, sampleRate: 48000 }));
  assert.equal(stereo.channels, 2);
  assert.equal(stereo.sampleRate, 48000);
});

test("WAV validation rejects truncated, non-RIFF, and non-PCM containers", () => {
  assert.throws(() => validateWavContainer(new Uint8Array(8)), TtsWireError);
  assert.throws(
    () => validateWavContainer(ascii("JUNKJUNKJUNKJUNKJUNKJUNK")),
    /not WAV/u,
  );
  const badFormat = wavBytes();
  // Overwrite the audio format to something unsupported (IEEE float = 3).
  new DataView(badFormat.buffer).setUint16(20, 3, true);
  assert.throws(() => validateWavContainer(badFormat), /16-bit PCM/u);
  const truncated = wavBytes().slice(0, 30);
  assert.throws(() => validateWavContainer(truncated), TtsWireError);
});

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function synthResponse(wav: Uint8Array, status = "completed") {
  return {
    status,
    steps: [
      {
        type: "model_output",
        content: [
          { type: "audio", mime_type: "audio/wav", data: base64(wav), sample_rate: 24000, channels: 1 },
        ],
      },
    ],
    usage: { total_input_tokens: 5, total_output_tokens: 600 },
  };
}

test("unary parsing returns validated WAV audio and reported usage", () => {
  const wav = wavBytes();
  const result = parseUnarySynthesisResponse(synthResponse(wav));
  assert.equal(result.audio.mimeType, "audio/wav");
  assert.equal(result.audio.sampleRate, 24000);
  assert.equal(result.audio.channels, 1);
  assert.deepEqual(result.usage, { inputTokens: 5, outputTokens: 600 });
  // Bytes are preserved losslessly.
  assert.deepEqual(Buffer.from(result.audio.bytes), Buffer.from(wav));
});

test("unary parsing falls back to output_audio without duplication", () => {
  const wav = wavBytes();
  const response = {
    status: "completed",
    output_audio: { type: "audio", mime_type: "audio/wav", data: base64(wav) },
    usage: {},
  };
  const result = parseUnarySynthesisResponse(response);
  assert.equal(result.audio.mimeType, "audio/wav");
  assert.deepEqual(result.usage, { inputTokens: null, outputTokens: null });
});

test("unary parsing rejects failures, incompletes, non-audio, and bad payloads", () => {
  assert.throws(
    () => parseUnarySynthesisResponse({ status: "failed", errors: [{ code: 500 }] }),
    (error: unknown) =>
      error instanceof TtsWireError && error.code === "provider_unavailable",
  );
  assert.throws(
    () => parseUnarySynthesisResponse({ status: "in_progress" }),
    (error: unknown) =>
      error instanceof TtsWireError &&
      error.code === "response_incomplete" &&
      error.generationMayHaveBeenBilled === true,
  );
  assert.throws(
    () => parseUnarySynthesisResponse({ status: "completed", steps: [] }),
    (error: unknown) =>
      error instanceof TtsWireError && error.code === "invalid_response",
  );
  assert.throws(
    () =>
      parseUnarySynthesisResponse({
        status: "completed",
        steps: [{ type: "model_output", content: [{ type: "audio", mime_type: "audio/wav", data: "!!!" }] }],
      }),
    TtsWireError,
  );
  assert.throws(
    () =>
      parseUnarySynthesisResponse({
        status: "completed",
        steps: [
          {
            type: "model_output",
            content: [
              { type: "audio", mime_type: "audio/mp3", data: base64(wavBytes()) },
            ],
          },
        ],
      }),
    /Unexpected audio format/u,
  );
});

test("provider errors collapse onto the closed union without leaking details", () => {
  const cases: Array<[unknown, string, boolean]> = [
    [new Error("API key not valid. Please pass a valid API key."), "invalid_credential", false],
    [new Error("Request failed with status 403"), "permission_denied", false],
    [new Error("Request failed with status 404"), "not_found", false],
    [new Error("RESOURCE_EXHAUSTED for project 123"), "quota", true],
    [new Error("Request failed with status 503"), "provider_unavailable", true],
    [new Error("fetch failed: ETIMEDOUT"), "network", true],
  ];
  for (const [error, code, retryable] of cases) {
    const classified = classifyTtsProviderError(error);
    assert.equal(classified.code, code);
    assert.equal(classified.retryable, retryable);
    assert.ok(
      !classified.message.includes("123") && !classified.message.includes("SECRET"),
    );
  }
});

test("voice list parsing normalizes page tokens and kinds", () => {
  const page = parseVoicesListResponse({
    voices: [
      { id: "voices/abc123", display_name: "My voice", type: "prompted" },
      { id: "voices/rep-1", display_name: "Cloned", type: "replicated" },
      { name: "Kore", type: "prebuilt" },
      { id: "" },
      "not-a-voice",
    ],
    next_page_token: "tok-2",
  });
  assert.equal(page.voices.length, 3);
  assert.deepEqual(page.voices[0], {
    providerVoiceId: "voices/abc123",
    name: "My voice",
    kind: "prompted",
  });
  assert.equal(page.nextPageToken, "tok-2");

  const last = parseVoicesListResponse({ voices: [], next_page_token: "" });
  assert.equal(last.nextPageToken, null);
});

test("starter prebuilt voices are unique and valid", () => {
  const ids = TTS_STARTER_PREBUILT_VOICES.map((voice) => voice.providerVoiceId);
  assert.equal(new Set(ids).size, ids.length);
  for (const voice of TTS_STARTER_PREBUILT_VOICES) {
    assert.equal(voice.kind, "prebuilt");
  }
});
