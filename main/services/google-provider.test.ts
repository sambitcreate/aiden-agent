import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import {
  canonicalGoogleProvider,
  GOOGLE_BASE_URL,
  GOOGLE_PROVIDER_ID,
  GoogleProviderService,
  migrateGoogleProviderConfig,
  migrateGoogleProviderKeyMap,
  parseGoogleThinkingSelection,
} from "./google-provider.js";

test("configuration migration replaces the legacy preset and preserves selection", () => {
  const config = {
    providers: [
      {
        id: "openai",
        kind: "openai" as const,
        label: "OpenAI",
        baseUrl: "https://api.openai.com/v1",
        models: ["gpt"],
        needsKey: true,
      },
      {
        id: "gemini",
        kind: "openai" as const,
        label: "Old Gemini",
        baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
        models: ["gemini-2.0-flash", "gemini-1.5-pro"],
        defaultModel: "gemini-2.0-flash",
        needsKey: true,
        isPreset: true,
      },
    ],
    settings: { lastProviderId: "gemini", lastModel: "gemini-2.0-flash" },
  };

  assert.equal(migrateGoogleProviderConfig(config), true);
  assert.deepEqual(
    config.providers.map((provider) => provider.id),
    ["openai", GOOGLE_PROVIDER_ID],
  );
  const google = config.providers[1];
  assert.equal(google?.baseUrl, GOOGLE_BASE_URL);
  assert.equal(google?.defaultModel, "gemini-2.0-flash");
  assert.ok(google?.models.includes("gemini-2.5-pro"));
  assert.ok(!google?.models.includes("gemini-1.5-pro"));
  assert.equal(config.settings.lastProviderId, GOOGLE_PROVIDER_ID);
  assert.equal(config.settings.lastModel, "gemini-2.0-flash");
  assert.equal(migrateGoogleProviderConfig(config), false);
});

test("canonicalization preserves a discovered native subset", () => {
  const provider = canonicalGoogleProvider({
    id: GOOGLE_PROVIDER_ID,
    kind: "openai",
    label: "Edited",
    baseUrl: "https://example.invalid",
    models: ["gemini-2.5-pro", "unsupported"],
    defaultModel: "gemini-2.5-pro",
    needsKey: false,
  });
  assert.deepEqual(provider.models, ["gemini-2.5-pro"]);
  assert.equal(provider.defaultModel, "gemini-2.5-pro");
  assert.equal(provider.baseUrl, GOOGLE_BASE_URL);
  assert.equal(provider.needsKey, true);
  assert.equal(provider.isPreset, true);
  assert.deepEqual(provider.modelMetadata?.["gemini-2.5-pro"]?.thinkingLevels, [
    "off",
    "low",
    "medium",
    "high",
  ]);
  assert.equal(
    provider.modelMetadata?.["gemini-2.5-pro"]?.thinkingCanDisable,
    true,
  );
});

test("native thinking metadata preserves only distinct choices", () => {
  const provider = canonicalGoogleProvider();
  assert.deepEqual(
    provider.modelMetadata?.["gemini-3-pro-preview"]?.thinkingLevels,
    ["off", "low", "high"],
  );
  assert.equal(
    provider.modelMetadata?.["gemini-3-pro-preview"]?.thinkingCanDisable,
    false,
  );
  assert.deepEqual(
    provider.modelMetadata?.["gemma-4-26b-a4b-it"]?.thinkingLevels,
    ["off", "high"],
  );
});

test("native thinking mutations reject unsupported or unknown selections", () => {
  assert.deepEqual(
    parseGoogleThinkingSelection("gemini-3-pro-preview", "low"),
    {
      modelId: "gemini-3-pro-preview",
      level: "low",
    },
  );
  assert.throws(
    () => parseGoogleThinkingSelection("gemini-3-pro-preview", "medium"),
    /not supported/u,
  );
  assert.throws(
    () => parseGoogleThinkingSelection("gemini-2.0-flash", "high"),
    /does not support/u,
  );
  assert.throws(
    () => parseGoogleThinkingSelection("unknown", "high"),
    /does not support/u,
  );
});

test("canonicalization preserves an explicit empty native discovery result", () => {
  const provider = canonicalGoogleProvider({
    id: GOOGLE_PROVIDER_ID,
    kind: "openai",
    label: "Google Gemini",
    baseUrl: GOOGLE_BASE_URL,
    models: [],
    needsKey: true,
    isPreset: true,
  });
  assert.deepEqual(provider.models, []);
  assert.equal(provider.defaultModel, undefined);
});

test("credential migration moves ciphertext without overwriting a native key", () => {
  const legacyOnly = { gemini: "legacy-ciphertext" };
  assert.equal(migrateGoogleProviderKeyMap(legacyOnly), true);
  assert.deepEqual(legacyOnly, { google: "legacy-ciphertext" });

  const both = { gemini: "legacy-ciphertext", google: "native-ciphertext" };
  assert.equal(migrateGoogleProviderKeyMap(both), true);
  assert.deepEqual(both, { google: "native-ciphertext" });
  assert.equal(migrateGoogleProviderKeyMap(both), false);
});

test("native Google streaming sends Gemini thinking through the google-generative-ai protocol", async (t) => {
  let requestPath = "";
  let requestBody = "";
  let apiKeyHeader = "";
  const server = createServer((request, response) => {
    requestPath = request.url ?? "";
    apiKeyHeader = String(request.headers["x-goog-api-key"] ?? "");
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
              content: {
                role: "model",
                parts: [
                  { text: "Native Google thought", thought: true },
                  { text: "Native Google response" },
                ],
              },
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

  const service = new GoogleProviderService(builtinModels());
  const baseModel = service.getModel("gemini-2.5-flash");
  assert.ok(baseModel);
  const model = {
    ...baseModel,
    baseUrl: `http://127.0.0.1:${address.port}/v1beta`,
  };
  const result = await service
    .streamSimple(
      model,
      {
        systemPrompt: "Keep the response short.",
        messages: [{ role: "user", content: "Hello", timestamp: 1 }],
      },
      { apiKey: "native-test-key", maxRetries: 0, reasoning: "high" },
    )
    .result();

  assert.equal(result.api, "google-generative-ai");
  assert.equal(result.provider, GOOGLE_PROVIDER_ID);
  assert.equal(result.stopReason, "stop");
  assert.equal(result.content[0]?.type, "thinking");
  assert.equal(
    result.content[0]?.type === "thinking" ? result.content[0].thinking : "",
    "Native Google thought",
  );
  assert.equal(result.content[1]?.type, "text");
  assert.equal(
    result.content[1]?.type === "text" ? result.content[1].text : "",
    "Native Google response",
  );
  assert.match(
    requestPath,
    /\/v1beta\/models\/gemini-2\.5-flash:streamGenerateContent/u,
  );
  assert.equal(apiKeyHeader, "native-test-key");
  const parsedRequest = JSON.parse(requestBody) as {
    systemInstruction?: unknown;
    generationConfig?: {
      thinkingConfig?: { includeThoughts?: boolean; thinkingBudget?: number };
    };
  };
  assert.ok(parsedRequest.systemInstruction);
  assert.deepEqual(parsedRequest.generationConfig?.thinkingConfig, {
    includeThoughts: true,
    thinkingBudget: 24_576,
  });
  assert.doesNotMatch(requestPath, /\/openai/u);
});
