import assert from "node:assert/strict";
import test from "node:test";
import { NO_AUTH_API_KEY } from "./generation-runtime.js";
import { testConnection } from "./models.js";

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
    assert.deepEqual(init?.headers, { Authorization: `Bearer ${NO_AUTH_API_KEY}` });
    return new Response(
      JSON.stringify({ data: [{ id: "z-model" }, { id: "a-model" }, { id: "a-model" }] }),
      { status: 200 },
    );
  }) as typeof fetch;

  assert.deepEqual(await testConnection(provider, NO_AUTH_API_KEY), {
    ok: true,
    modelCount: 2,
    models: ["a-model", "z-model"],
  });
});
