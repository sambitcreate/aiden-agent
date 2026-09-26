// Loopback-only provider contract: verifies the real @google/genai SDK
// serialization for read aloud against a local HTTP server. No credential, no
// Google origin. Mirrors the gemini-live sdk-contract pattern.

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import test from "node:test";
import { buildTtsInteractionBody } from "./gemini-wire.js";
import { createGeminiTtsProvider } from "./gemini-provider.js";

interface CapturedRequest {
  method: string;
  path: string;
  authHeader: string | undefined;
  body: Record<string, unknown>;
}

function wavBase64(): string {
  const samples = new Uint8Array(32);
  const bytes = new Uint8Array(44 + samples.byteLength);
  const view = new DataView(bytes.buffer);
  const write = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) bytes[offset + i] = text.charCodeAt(i);
  };
  write(0, "RIFF");
  view.setUint32(4, 36 + samples.byteLength, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 24000, true);
  view.setUint32(28, 48000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, samples.byteLength, true);
  bytes.set(samples, 44);
  return Buffer.from(bytes).toString("base64");
}

function interactionJson(): Record<string, unknown> {
  return {
    id: "interaction-test-1",
    status: "completed",
    steps: [
      {
        type: "model_output",
        content: [
          {
            type: "audio",
            mime_type: "audio/wav",
            data: wavBase64(),
            sample_rate: 24000,
            channels: 1,
          },
        ],
      },
    ],
    usage: { total_input_tokens: 7, total_output_tokens: 640 },
  };
}

async function withLoopbackServer(
  handle: (respond: (json: unknown, status?: number) => void, captured: CapturedRequest) => void,
  run: (baseUrl: string) => Promise<void>,
): Promise<CapturedRequest[]> {
  const captured: CapturedRequest[] = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      const entry: CapturedRequest = {
        method: request.method ?? "",
        path: request.url ?? "",
        authHeader: request.headers["x-goog-api-key"] as string | undefined,
        body,
      };
      captured.push(entry);
      handle(
        (json, status = 200) => {
          response.statusCode = status;
          response.setHeader("content-type", "application/json");
          response.end(JSON.stringify(json));
        },
        entry,
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", resolve);
    server.once("error", reject);
  });
  const address = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  return captured;
}

test("provider synthesis serializes the exact reviewed body through the real SDK", async () => {
  const requests = await withLoopbackServer(
    (respond) => respond(interactionJson()),
    async (baseUrl) => {
      const provider = createGeminiTtsProvider({
        httpOptions: { baseUrl },
      });
      const result = await provider.synthesize({
        apiKey: "loopback-only-key",
        body: buildTtsInteractionBody({
          model: "gemini-3.8-flash-tts",
          transcript: "Read this segment exactly.",
          voice: "Kore",
          style: "calm delivery",
        }),
      });
      assert.equal(result.audio.mimeType, "audio/wav");
      assert.equal(result.audio.sampleRate, 24000);
      assert.equal(result.audio.channels, 1);
      assert.deepEqual(result.usage, { inputTokens: 7, outputTokens: 640 });
    },
  );
  const request = requests[requests.length - 1]!;
  assert.equal(request.method, "POST");
  assert.match(request.path, /\/v1beta\/interactions/u);
  assert.equal(request.authHeader, "loopback-only-key");
  assert.equal(request.body.store, false);
  assert.equal(request.body.stream, false);
  assert.equal(request.body.model, "gemini-3.8-flash-tts");
  const json = JSON.stringify(request.body);
  assert.equal(json.split("Read this segment exactly.").length - 1, 1);
  assert.doesNotMatch(json, /previous_interaction_id|system_instruction|"tools"/u);
});

test("provider maps provider rejections onto the closed error union", async () => {
  await withLoopbackServer(
    (respond) =>
      respond(
        { error: { code: 429, message: "Resource exhausted", status: "RESOURCE_EXHAUSTED" } },
        429,
      ),
    async (baseUrl) => {
      const provider = createGeminiTtsProvider({
        httpOptions: { baseUrl },
      });
      await assert.rejects(
        provider.synthesize({
          apiKey: "loopback-only-key",
          body: buildTtsInteractionBody({
            model: "gemini-3.8-flash-tts",
            transcript: "Any text.",
            voice: "Kore",
            style: "",
          }),
        }),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.equal((error as { code?: string }).code, "quota");
          return true;
        },
      );
    },
  );
});
