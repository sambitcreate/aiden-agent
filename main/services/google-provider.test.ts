import { normalizeContext } from "@earendil-works/pi-ai";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { builtinModels, builtinProviders } from "@earendil-works/pi-ai/providers/all";
import {
  adaptGoogleXHighStreamOptions,
  withAidenPiCompatibility,
} from "./pi-provider-compatibility.js";
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
  assert.equal(google?.defaultModel, "gemini-2.5-flash");
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
    provider.modelMetadata?.["gemini-3.1-pro-preview"]?.thinkingLevels,
    ["off", "low", "medium", "high"],
  );
  assert.equal(
    provider.modelMetadata?.["gemini-3.1-pro-preview"]?.thinkingCanDisable,
    false,
  );
  assert.deepEqual(
    provider.modelMetadata?.["gemma-4-26b-a4b-it"]?.thinkingLevels,
    ["off", "high"],
  );
});

test("native thinking mutations reject unsupported or unknown selections", () => {
  assert.deepEqual(
    parseGoogleThinkingSelection("gemini-3.1-pro-preview", "low"),
    {
      modelId: "gemini-3.1-pro-preview",
      level: "low",
    },
  );
  assert.throws(
    () => parseGoogleThinkingSelection("gemini-3.1-pro-preview", "xhigh"),
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
  const remoteModels = new Map([
    [
      "gemini-4-hydrogen",
      {
        reasoning: true,
        thinkingLevelMap: {
          off: null,
          minimal: null,
          low: "low",
          medium: "medium",
          high: "high",
          xhigh: "xhigh",
          max: null,
        },
      },
    ],
    [
      "gemini-4-carbon",
      {
        reasoning: true,
        thinkingLevelMap: {
          off: null,
          minimal: null,
          low: "low",
          medium: "medium",
          high: "high",
          xhigh: null,
          max: null,
        },
      },
    ],
  ]);
  const resolveRemote = (modelId: string) => remoteModels.get(modelId);
  assert.deepEqual(
    parseGoogleThinkingSelection("gemini-4-hydrogen", "high", resolveRemote),
    { modelId: "gemini-4-hydrogen", level: "high" },
  );
  assert.deepEqual(
    parseGoogleThinkingSelection("gemini-4-hydrogen", "xhigh", resolveRemote),
    { modelId: "gemini-4-hydrogen", level: "xhigh" },
  );
  assert.throws(
    () => parseGoogleThinkingSelection("gemini-4-hydrogen", "max", resolveRemote),
    /not supported/u,
  );
  assert.throws(
    () => parseGoogleThinkingSelection("gemini-4-carbon", "xhigh", resolveRemote),
    /not supported/u,
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
            cachedContentTokenCount: 2,
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
      normalizeContext({
        systemPrompt: "Keep the response short.",
        messages: [{ role: "user", content: "Hello", timestamp: 1 }],
      }),
      { apiKey: "native-test-key", maxRetries: 0, reasoning: "high" },
    )
    .result();

  assert.equal(result.api, "google-generative-ai");
  assert.equal(result.provider, GOOGLE_PROVIDER_ID);
  assert.equal(result.stopReason, "stop");
  assert.equal(result.usage.input, 1);
  assert.equal(result.usage.cacheRead, 2);
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

test("Google compatibility wrapper sends XHIGH thinkingLevel for Gemini 4 models on Pi 1.5.2", async (t) => {
  let requestPath = "";
  let requestBody = "";
  let observedPayloadLevel: unknown;
  const server = createServer((request, response) => {
    requestPath = request.url ?? "";
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
                  { text: "Deep reasoning", thought: true },
                  { text: "Done" },
                ],
              },
              finishReason: "STOP",
            },
          ],
        })}\n\n`,
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const baseProvider = builtinProviders().find((entry) => entry.id === GOOGLE_PROVIDER_ID);
  assert.ok(baseProvider);
  const provider = withAidenPiCompatibility(baseProvider);
  const baseModel = baseProvider.getModels()[0];
  assert.ok(baseModel);
  const hydrogenModel = {
    ...baseModel,
    id: "gemini-4-hydrogen",
    name: "Gemini 4 Hydrogen",
    baseUrl: `http://127.0.0.1:${address.port}/v1beta`,
    reasoning: true,
    thinkingLevelMap: {
      off: null,
      minimal: null,
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
      max: null,
    },
  };

  const result = await provider
    .streamSimple(
      hydrogenModel,
      normalizeContext({
        messages: [{ role: "user", content: "Solve", timestamp: 1 }],
      }),
      {
        apiKey: "native-test-key",
        maxRetries: 0,
        reasoning: "xhigh",
        onPayload: (payload) => {
          observedPayloadLevel = (
            payload as { config?: { thinkingConfig?: { thinkingLevel?: unknown } } }
          )?.config?.thinkingConfig?.thinkingLevel;
          return undefined;
        },
      },
    )
    .result();

  assert.equal(result.stopReason, "stop");
  assert.equal(observedPayloadLevel, "XHIGH");
  assert.match(requestPath, /\/v1beta\/models\/gemini-4-hydrogen:streamGenerateContent/u);
  const parsedRequest = JSON.parse(requestBody) as {
    generationConfig?: {
      thinkingConfig?: { includeThoughts?: boolean; thinkingLevel?: string };
    };
  };
  assert.deepEqual(parsedRequest.generationConfig?.thinkingConfig, {
    includeThoughts: true,
    thinkingLevel: "XHIGH",
  });
});

test("Google xhigh compatibility covers google-vertex, opencode, fallback levels, and caller onPayload overrides", async () => {
  const vertexModel = {
    id: "gemini-4-neon",
    name: "Gemini 4 Neon",
    api: "google-vertex" as const,
    provider: "google-vertex",
    baseUrl: "https://example.invalid",
    reasoning: true,
    thinkingLevelMap: {
      off: null,
      minimal: null,
      low: "low",
      medium: "medium",
      high: null,
      xhigh: "xhigh",
      max: null,
    },
    input: ["text"] as ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_048_576,
    maxTokens: 65_536,
  };
  const adapted = adaptGoogleXHighStreamOptions(vertexModel, {
    reasoning: "xhigh",
    onPayload: (payload) => ({
      ...(payload as Record<string, unknown>),
      extraTag: "kept",
    }),
  });
  assert.equal(adapted?.reasoning, "medium");
  const patched = await adapted?.onPayload?.(
    {
      model: "gemini-4-neon",
      config: { thinkingConfig: { includeThoughts: true, thinkingLevel: "MEDIUM" } },
    },
    vertexModel,
  );
  assert.deepEqual(patched, {
    model: "gemini-4-neon",
    config: { thinkingConfig: { includeThoughts: true, thinkingLevel: "XHIGH" } },
    extraTag: "kept",
  });

  // Budget-based payloads are left untouched rather than mixing thinkingBudget and thinkingLevel.
  const budgetPayload = {
    model: "gemini-2.5-pro",
    config: { thinkingConfig: { includeThoughts: true, thinkingBudget: 8192 } },
  };
  const untouched = await adaptGoogleXHighStreamOptions(vertexModel, { reasoning: "xhigh" })?.onPayload?.(
    budgetPayload,
    vertexModel,
  );
  assert.deepEqual(untouched, budgetPayload);

  // opencode and opencode-go also serve google-generative-ai models and receive xhigh compatibility.
  for (const providerId of ["opencode", "opencode-go"] as const) {
    const base = builtinProviders().find((entry) => entry.id === providerId);
    assert.ok(base);
    let capturedReasoning: unknown;
    const wrapped = withAidenPiCompatibility({
      ...base,
      streamSimple: (_model, _context, options) => {
        capturedReasoning = options?.reasoning;
        throw new Error("intercepted");
      },
    });
    const opencodeGoogleModel = {
      ...vertexModel,
      api: "google-generative-ai" as const,
      provider: providerId,
      thinkingLevelMap: { low: "low", medium: "medium", high: "high", xhigh: "xhigh" },
    };
    assert.throws(
      () => wrapped.streamSimple(opencodeGoogleModel, normalizeContext({ messages: [] }), { reasoning: "xhigh" }),
      /intercepted/u,
    );
    assert.equal(capturedReasoning, "high");
  }
});
