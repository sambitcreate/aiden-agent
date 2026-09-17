import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import type { Api, Model, Provider } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import {
  floorGoogleDisabledThinkingLevel,
  googleDisabledThinkingFloor,
  withAidenPiCompatibility,
  withGoogleThinkingFloor,
} from "./pi-provider-compatibility.js";

test("google thinking floor only lifts Flash ids that dropped minimal", () => {
  assert.equal(googleDisabledThinkingFloor("gemini-3.7-flash"), "LOW");
  assert.equal(googleDisabledThinkingFloor("gemini-3.8-flash"), "LOW");
  assert.equal(googleDisabledThinkingFloor("gemini-3.10-flash"), "LOW");
  assert.equal(googleDisabledThinkingFloor("gemini-4-flash"), "LOW");
  assert.equal(googleDisabledThinkingFloor("gemini-flash-latest"), "LOW");
  assert.equal(googleDisabledThinkingFloor("models/gemini-3.8-flash"), "LOW");

  assert.equal(googleDisabledThinkingFloor("gemini-3.6-flash"), undefined);
  assert.equal(googleDisabledThinkingFloor("gemini-3.5-flash"), undefined);
  assert.equal(googleDisabledThinkingFloor("gemini-3-flash-preview"), undefined);
  assert.equal(googleDisabledThinkingFloor("gemini-2.5-flash"), undefined);
  assert.equal(googleDisabledThinkingFloor("gemini-3.1-flash-lite"), undefined);
  assert.equal(googleDisabledThinkingFloor("gemini-3.8-flash-image"), undefined);
  assert.equal(googleDisabledThinkingFloor("gemini-flash-lite-latest"), undefined);
  assert.equal(googleDisabledThinkingFloor("gemini-3.1-pro-preview"), undefined);
});

test("floor repair rewrites only a MINIMAL thinking level", () => {
  const model = { id: "gemini-3.8-flash" };
  const payload = {
    model: "gemini-3.8-flash",
    contents: [],
    config: { thinkingConfig: { thinkingLevel: "MINIMAL" } },
  };
  assert.deepEqual(floorGoogleDisabledThinkingLevel(payload, model), {
    model: "gemini-3.8-flash",
    contents: [],
    config: { thinkingConfig: { thinkingLevel: "LOW" } },
  });
});

test("floor repair leaves supported models and explicit levels untouched", () => {
  const minimal = { config: { thinkingConfig: { thinkingLevel: "MINIMAL" } } };
  assert.equal(
    floorGoogleDisabledThinkingLevel(minimal, { id: "gemini-3.6-flash" }),
    minimal,
  );

  const explicit = { config: { thinkingConfig: { thinkingLevel: "HIGH" } } };
  assert.equal(
    floorGoogleDisabledThinkingLevel(explicit, { id: "gemini-3.8-flash" }),
    explicit,
  );

  const budget = { config: { thinkingConfig: { thinkingBudget: 0 } } };
  assert.equal(
    floorGoogleDisabledThinkingLevel(budget, { id: "gemini-3.8-flash" }),
    budget,
  );

  const bare = { model: "gemini-3.8-flash" };
  assert.equal(
    floorGoogleDisabledThinkingLevel(bare, { id: "gemini-3.8-flash" }),
    bare,
  );
});

test("provider wrapper delegates to a caller-supplied payload hook last", async () => {
  const calls: unknown[] = [];
  const original: Provider = {
    id: "google",
    name: "Google",
    auth: {} as Provider["auth"],
    getModels: () => [],
    stream: (model, _context, options) => {
      void options?.onPayload?.(
        { config: { thinkingConfig: { thinkingLevel: "MINIMAL" } } },
        model,
      );
      return {} as never;
    },
    streamSimple: (model, _context, options) => {
      void Promise.resolve(
        options?.onPayload?.(
          { config: { thinkingConfig: { thinkingLevel: "MINIMAL" } } },
          model,
        ),
      ).then((next) => calls.push(next));
      return {} as never;
    },
  };
  const wrapped = withGoogleThinkingFloor(original);
  wrapped.streamSimple(
    { id: "gemini-3.8-flash" } as Model<Api>,
    { messages: [] },
    {
      onPayload: (payload) => {
        calls.push(payload);
        return { replaced: true };
      },
    },
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls[0], {
    config: { thinkingConfig: { thinkingLevel: "LOW" } },
  });
  assert.deepEqual(calls[1], { replaced: true });
});

test("provider wrapper is scoped to the Google family", () => {
  const other = {
    id: "openai",
    streamSimple: () => ({} as never),
  } as unknown as Provider;
  assert.equal(withGoogleThinkingFloor(other), other);
  assert.equal(withAidenPiCompatibility(other), other);
});

async function captureThinkingConfig(
  t: test.TestContext,
  model: Model<Api>,
): Promise<Record<string, unknown>> {
  let requestBody = "";
  const server = createServer((request, response) => {
    request.setEncoding("utf-8");
    request.on("data", (chunk) => {
      requestBody += String(chunk);
    });
    request.on("end", () => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        `data: ${JSON.stringify({
          candidates: [
            {
              content: { role: "model", parts: [{ text: "ok" }] },
              finishReason: "STOP",
            },
          ],
          usageMetadata: {
            promptTokenCount: 3,
            candidatesTokenCount: 4,
            totalTokenCount: 7,
          },
        })}\n\n`,
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const google = builtinProviders().find((provider) => provider.id === "google");
  assert.ok(google);
  const wrapped = withAidenPiCompatibility(google);
  const requestModel = {
    ...model,
    baseUrl: `http://127.0.0.1:${address.port}/v1beta`,
  };
  const result = await wrapped
    .streamSimple(
      requestModel,
      { messages: [{ role: "user", content: "Hello", timestamp: 1 }] },
      { apiKey: "native-test-key", maxRetries: 0 },
    )
    .result();
  assert.equal(result.stopReason, "stop");
  const parsed = JSON.parse(requestBody) as {
    generationConfig?: { thinkingConfig?: Record<string, unknown> };
    config?: { thinkingConfig?: Record<string, unknown> };
  };
  return parsed.generationConfig?.thinkingConfig ?? parsed.config?.thinkingConfig ?? {};
}

function googleFlashModel(id: string): Model<Api> {
  return {
    id,
    name: id,
    api: "google-generative-ai",
    provider: "google",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    reasoning: true,
    thinkingLevelMap: { off: null },
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_048_576,
    maxTokens: 65_536,
  };
}

test("disabled thinking on gemini-3.8-flash sends LOW instead of MINIMAL", async (t) => {
  const thinkingConfig = await captureThinkingConfig(t, googleFlashModel("gemini-3.8-flash"));
  assert.deepEqual(thinkingConfig, { thinkingLevel: "LOW" });
});

test("disabled thinking on gemini-3.6-flash keeps MINIMAL", async (t) => {
  const thinkingConfig = await captureThinkingConfig(t, googleFlashModel("gemini-3.6-flash"));
  assert.deepEqual(thinkingConfig, { thinkingLevel: "MINIMAL" });
});
