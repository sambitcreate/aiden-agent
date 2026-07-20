import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { lookupCatalogModelInfo, parseModelCatalog } from "./models-catalog-core.js";
import { normalizeProviderBaseUrl, testConnection } from "./models.js";

const provider = {
  id: "lmstudio",
  kind: "openai" as const,
  label: "LM Studio (local)",
  baseUrl: "http://127.0.0.1:1234/v1",
  models: [],
  needsKey: false,
  isPreset: true,
};

test("connection testing returns normalized models so Settings can save the discovered draft", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = (async (input, init) => {
    assert.equal(String(input), "http://127.0.0.1:1234/v1/models");
    assert.deepEqual(init?.headers, {});
    return new Response(
      JSON.stringify({ data: [{ id: "z-model" }, { id: "a-model" }, { id: "a-model" }] }),
      { status: 200 },
    );
  }) as typeof fetch;

  assert.deepEqual(await testConnection(provider, null), {
    ok: true,
    modelCount: 2,
    models: ["a-model", "z-model"],
  });
});

test("keyless Anthropic discovery omits x-api-key while retaining its protocol version", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = (async (_input, init) => {
    assert.deepEqual(init?.headers, { "anthropic-version": "2023-06-01" });
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  }) as typeof fetch;

  assert.deepEqual(
    await testConnection(
      {
        ...provider,
        id: "anthropic-local",
        kind: "anthropic",
        label: "Anthropic-compatible local server",
      },
      null,
    ),
    { ok: true, modelCount: 0, models: [] },
  );
});

test("normalizes safe provider URLs and rejects credentials or request decorations", () => {
  assert.equal(
    normalizeProviderBaseUrl(" https://tailnet.example.ts.net/v1/// "),
    "https://tailnet.example.ts.net/v1",
  );
  assert.throws(
    () => normalizeProviderBaseUrl("https://key:secret@example.test/v1"),
    /API key field/u,
  );
  assert.throws(
    () => normalizeProviderBaseUrl("https://example.test/v1?key=secret"),
    /query string/u,
  );
  assert.throws(() => normalizeProviderBaseUrl("ftp://example.test/v1"), /HTTP or HTTPS/u);
});

test("release catalog parsing rejects invalid payloads and lookups stay conservative", () => {
  assert.throws(() => parseModelCatalog(null), /must be an object/u);
  assert.throws(() => parseModelCatalog([]), /must be an object/u);

  const catalog = parseModelCatalog({
    local: {
      models: {
        "vision-model": {
          name: "Vision Model",
          attachment: true,
          tool_call: true,
          reasoning: true,
          open_weights: true,
          modalities: { input: ["text", "image"] },
          limit: { context: 32_000, output: 4_096 },
        },
      },
    },
  });
  assert.deepEqual(lookupCatalogModelInfo(catalog, "lmstudio", "vision-model"), {
    id: "vision-model",
    name: "Vision Model",
    vision: true,
    toolCall: true,
    reasoning: true,
    openWeights: true,
    contextLength: 32_000,
    outputLimit: 4_096,
    inputModalities: ["text", "image"],
    knowledge: undefined,
    releaseDate: undefined,
    matched: true,
  });
  assert.deepEqual(lookupCatalogModelInfo({}, "ollama", "qwen-local"), {
    id: "qwen-local",
    vision: false,
    toolCall: false,
    reasoning: false,
    openWeights: false,
    matched: false,
  });
});

test("runtime metadata stays local and the bundled snapshot is packaged", async () => {
  const runtimeSource = await readFile(new URL("./models-catalog.ts", import.meta.url), "utf8");
  assert.doesNotMatch(runtimeSource, /\bfetch\s*\(/u);
  assert.doesNotMatch(runtimeSource, /models\.dev/u);

  const snapshot = JSON.parse(
    await readFile(new URL("../../resources/model-capabilities.json", import.meta.url), "utf8"),
  ) as unknown;
  assert.doesNotThrow(() => parseModelCatalog(snapshot));

  const packageJson = JSON.parse(
    await readFile(new URL("../../package.json", import.meta.url), "utf8"),
  ) as { build?: { files?: string[] } };
  assert.ok(packageJson.build?.files?.includes("resources/model-capabilities.json"));
});
