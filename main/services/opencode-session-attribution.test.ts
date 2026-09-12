import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type Server } from "node:http";
import type { Api, Model } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import { resolveModelRuntimeWith, withPinnedBotProviderAuth } from "./model-runtime-core.js";
import {
  OPENCODE_SESSION_HEADER,
  openCodeSessionHeaders,
  withOpenCodeSessionAttribution,
} from "./opencode-session-attribution.js";

function model(
  overrides: Partial<Model<Api>> = {},
): Model<Api> {
  return {
    id: "glm-5.3-flash",
    name: "GLM-5.3-Flash",
    api: "openai-completions",
    provider: "opencode-go",
    baseUrl: "https://opencode.ai/zen/go/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000_000,
    maxTokens: 131_072,
    ...overrides,
  };
}

test("withOpenCodeSessionAttribution adds the session header for opencode-go", () => {
  const attributed = withOpenCodeSessionAttribution(model(), "chat-123");
  assert.equal(attributed.headers?.[OPENCODE_SESSION_HEADER], "chat-123");
});

test("withOpenCodeSessionAttribution never mutates the catalog model", () => {
  const catalog = model();
  withOpenCodeSessionAttribution(catalog, "chat-123");
  assert.equal(catalog.headers, undefined);
});

test("withOpenCodeSessionAttribution preserves existing model headers", () => {
  const attributed = withOpenCodeSessionAttribution(
    model({ provider: "opencode-go", headers: { "X-Custom": "keep" } }),
    "chat-123",
  );
  assert.equal(attributed.headers?.[OPENCODE_SESSION_HEADER], "chat-123");
  assert.equal(attributed.headers?.["X-Custom"], "keep");
});

test("withOpenCodeSessionAttribution replaces a case-variant of the header", () => {
  const attributed = withOpenCodeSessionAttribution(
    model({ headers: { "X-OPENCODE-SESSION": "caller" } }),
    "chat-123",
  );
  assert.equal(attributed.headers?.["X-OPENCODE-SESSION"], undefined);
  assert.equal(attributed.headers?.[OPENCODE_SESSION_HEADER], "chat-123");
});

test("withOpenCodeSessionAttribution covers opencode, opencode-zen, and host matches", () => {
  assert.equal(
    withOpenCodeSessionAttribution(model({ provider: "opencode" }), "chat-1").headers?.[
      OPENCODE_SESSION_HEADER
    ],
    "chat-1",
  );
  assert.equal(
    withOpenCodeSessionAttribution(model({ provider: "opencode-zen" }), "chat-1").headers?.[
      OPENCODE_SESSION_HEADER
    ],
    "chat-1",
  );
  assert.equal(
    withOpenCodeSessionAttribution(
      model({ provider: "custom:connection", baseUrl: "https://opencode.ai/zen/go/v1" }),
      "chat-1",
    ).headers?.[OPENCODE_SESSION_HEADER],
    "chat-1",
  );
});

test("withOpenCodeSessionAttribution leaves unrelated providers untouched", () => {
  const concentrate = model({
    provider: "concentrate",
    baseUrl: "https://api.concentrate.ai/v1",
  });
  assert.equal(withOpenCodeSessionAttribution(concentrate, "chat-1"), concentrate);
  assert.equal(withOpenCodeSessionAttribution(concentrate, "chat-1").headers, undefined);
});

test("withOpenCodeSessionAttribution requires a non-empty conversation id", () => {
  const catalog = model();
  assert.equal(withOpenCodeSessionAttribution(catalog, undefined), catalog);
  assert.equal(withOpenCodeSessionAttribution(catalog, ""), catalog);
  assert.equal(withOpenCodeSessionAttribution(catalog, "   "), catalog);
});

test("withOpenCodeSessionAttribution ignores malformed or foreign base urls", () => {
  assert.equal(
    withOpenCodeSessionAttribution(model({ provider: "custom", baseUrl: "" }), "chat-1").headers,
    undefined,
  );
  assert.equal(
    withOpenCodeSessionAttribution(
      model({ provider: "custom", baseUrl: "https://evil-opencode.ai.example.com/v1" }),
      "chat-1",
    ).headers,
    undefined,
  );
  assert.equal(
    withOpenCodeSessionAttribution(
      model({ provider: "custom", baseUrl: "not a url" }),
      "chat-1",
    ).headers,
    undefined,
  );
});

test("openCodeSessionHeaders is undefined for non-targets and blank ids", () => {
  assert.deepEqual(openCodeSessionHeaders({ provider: "opencode-go" }, "chat-1"), {
    [OPENCODE_SESSION_HEADER]: "chat-1",
  });
  assert.equal(openCodeSessionHeaders({ provider: "opencode-go" }, " "), undefined);
  assert.equal(openCodeSessionHeaders({ provider: "concentrate" }, "chat-1"), undefined);
  assert.equal(openCodeSessionHeaders({}, "chat-1"), undefined);
});

test("openCodeSessionHeaders rejects ids that are not bounded tokens", () => {
  // Header-injection safety: ids flow from renderer-adjacent inputs.
  assert.equal(openCodeSessionHeaders({ provider: "opencode-go" }, "a\rb"), undefined);
  assert.equal(openCodeSessionHeaders({ provider: "opencode-go" }, "a\nb"), undefined);
  assert.equal(openCodeSessionHeaders({ provider: "opencode-go" }, "chat bad"), undefined);
  assert.equal(
    openCodeSessionHeaders({ provider: "opencode-go" }, "x".repeat(129)),
    undefined,
  );
  // UUIDs, chat ids, and request ids stay valid.
  assert.ok(openCodeSessionHeaders({ provider: "opencode-go" }, "12375712-3dab-45dc-a97a-02b6bb36ac48"));
  assert.ok(openCodeSessionHeaders({ provider: "opencode-go" }, "req-1.a_b:c"));
});

test("withPinnedBotProviderAuth preserves the session header on the dispatched model", async () => {
  const attributed = withOpenCodeSessionAttribution(model(), "chat-bot");
  const captured: Array<Model<Api>> = [];
  const pinned = withPinnedBotProviderAuth(
    {
      provider: { id: "opencode-go", kind: "openai", label: "OpenCode Zen", baseUrl: "https://opencode.ai/zen/go/v1", models: [], needsKey: true, isPreset: true },
      model: attributed,
      models: {} as never,
      apiKey: undefined,
      headers: undefined,
      streams: {} as never,
    },
    {
      status: 200,
      auth: { apiKey: "key", baseUrl: undefined, headers: undefined },
      source: "test",
    } as never,
    (requestModel) => {
      captured.push(requestModel);
      return { stream: async () => { throw new Error("unused"); }, result: async () => ({}) as never } as never;
    },
  );
  try {
    await pinned.streams.streamSimple(attributed, { systemPrompt: "", messages: [] }, {}).result();
  } catch {
    // The stub provider stream intentionally throws; only the model matters.
  }
  assert.equal(captured[0]?.headers?.[OPENCODE_SESSION_HEADER], "chat-bot");
});

test("the attributed model's header reaches the outgoing HTTP request", async () => {
  const received: Array<Record<string, string | undefined>> = [];
  const server: Server = createServer((request, response) => {
    received.push(Object.fromEntries(
      Object.entries(request.headers).map(([name, value]) => [name, Array.isArray(value) ? value.join(",") : value]),
    ));
    response.statusCode = 500;
    response.end('{"error":{"message":"unused"}}');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  const streams = openAICompletionsApi();
  const context = {
    systemPrompt: "",
    messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "hi" }], timestamp: Date.now() }],
  };
  const attributed = withOpenCodeSessionAttribution(
    model({ provider: "opencode-go", baseUrl }),
    "chat-wire",
  );
  const control = model({ provider: "concentrate", baseUrl, headers: undefined });
  for (const candidate of [attributed, control]) {
    try {
      await streams
        .streamSimple(candidate, context, { apiKey: "test-key" })
        .result();
    } catch {
      // The stub server rejects every request; only the headers matter.
    }
  }
  server.close();
  assert.equal(received[0]?.[OPENCODE_SESSION_HEADER], "chat-wire");
  assert.equal(received[1]?.[OPENCODE_SESSION_HEADER], undefined);
});

const NATIVE_MODEL: Model<Api> = model();

function nativeDependencies() {
  return {
    getProvider: async () => undefined,
    getApiKey: async () => null,
    resolveRuntimeLimits: async () => ({
      reasoning: false,
      input: ["text"] as Array<"text" | "image">,
      contextWindow: 1_000_000,
      maxTokens: 131_072,
      thinkingLevelMap: undefined,
    }),
    codex: {
      models: {} as never,
      prepareRuntimeModel: async () => NATIVE_MODEL,
      streamSimple: (() => undefined) as never,
    },
    native: {
      models: {} as never,
      getProvider: () => ({
        id: "opencode-go",
        kind: "openai" as const,
        label: "OpenCode Zen",
        baseUrl: "https://opencode.ai/zen/go/v1",
        models: [NATIVE_MODEL.id],
        needsKey: true,
        isPreset: true,
      }),
      getModel: (_providerId: string, modelId: string) =>
        modelId === NATIVE_MODEL.id ? NATIVE_MODEL : undefined,
      streamSimple: (() => undefined) as never,
    },
  };
}

test("resolveModelRuntimeWith attaches attribution on the native path", async () => {
  const runtime = await resolveModelRuntimeWith(
    nativeDependencies(),
    "opencode-go",
    NATIVE_MODEL.id,
    undefined,
    "chat-abc",
  );
  assert.equal(runtime.model.headers?.[OPENCODE_SESSION_HEADER], "chat-abc");
  // The stored catalog model itself must stay pristine.
  assert.equal(NATIVE_MODEL.headers, undefined);
});

test("resolveModelRuntimeWith skips attribution without a conversation id", async () => {
  const runtime = await resolveModelRuntimeWith(
    nativeDependencies(),
    "opencode-go",
    NATIVE_MODEL.id,
  );
  assert.equal(runtime.model.headers, undefined);
});

test("resolveModelRuntimeWith attaches attribution for custom OpenCode endpoints", async () => {
  const customModel = model({
    provider: "custom:connection",
    baseUrl: "https://opencode.ai/zen/go/v1",
  });
  const dependencies = {
    ...nativeDependencies(),
    native: {
      ...nativeDependencies().native,
      getProvider: () => undefined,
    },
    getProvider: async () => ({
      id: "custom:connection",
      kind: "openai" as const,
      label: "Custom",
      baseUrl: "https://opencode.ai/zen/go/v1",
      models: [customModel.id],
      needsKey: false,
      isPreset: false,
    }),
  };
  const runtime = await resolveModelRuntimeWith(
    dependencies,
    "custom:connection",
    customModel.id,
    undefined,
    "chat-custom",
  );
  assert.equal(runtime.model.headers?.[OPENCODE_SESSION_HEADER], "chat-custom");
});
