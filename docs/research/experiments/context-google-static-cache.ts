/** Offline actual Google adapter + Aiden static cache boundary, no inference. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createInitialSystemMessage, normalizeContext, Type, type Api, type Model, type TranscriptContext } from "@earendil-works/pi-ai";
import { googleGenerativeAIApi } from "@earendil-works/pi-ai/api/google-generative-ai.lazy";
import { GeminiContextCache } from "../../../main/services/gemini-context-cache.js";
const now = Date.UTC(2026, 9, 11);
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const operations: { method: string; bodyHash?: string; containsConversation: boolean }[] = [];
let creates = 0;
const cache = new GeminiContextCache({ now: () => now, fetch: async (_url, init) => {
  const body = String(init?.body ?? "");
  operations.push({ method: init?.method ?? "GET", bodyHash: body ? hash(JSON.parse(body)) : undefined, containsConversation: body.includes("DYNAMIC_EVIDENCE") || body.includes("QUEUED_INTENT") });
  if (init?.method === "DELETE") return new Response(null, { status: 204 });
  creates += 1;
  return new Response(JSON.stringify({ name: `cachedContents/offline-${creates}`, expireTime: new Date(now + 3_600_000).toISOString(), usageMetadata: { totalTokenCount: 1234 } }), { status: 200 });
} });
const tool = { name: "read_file", description: "Read a file", parameters: Type.Object({ path: Type.String() }) };
const head = createInitialSystemMessage("STATIC_POLICY", [tool]); assert.ok(head);
const base: TranscriptContext["messages"] = [head, { role: "user", content: "DYNAMIC_EVIDENCE".padEnd(8000, "x"), timestamp: 1 }];
const elided: TranscriptContext["messages"] = [head, { role: "user", content: "DYNAMIC_EVIDENCE shortened for cache-key observation", timestamp: 1 }];
// User truncation is deliberately NOT an elision-policy candidate: this fixture
// only varies dynamic contents to test cache key isolation.
const cases: { name: string; messages: TranscriptContext["messages"]; snapshot: string }[] = [
  { name: "original", messages: base, snapshot: "WORKSPACE_A" },
  { name: "dynamicChanged", messages: elided, snapshot: "WORKSPACE_A" },
  { name: "queued", messages: [...elided, { role: "user", content: "QUEUED_INTENT", timestamp: 2 }], snapshot: "WORKSPACE_A" },
  { name: "schemaChanged", messages: [...elided, { role: "system", content: "", toolsAdded: [{ ...tool, name: "inspect_schema" }], timestamp: 3 }], snapshot: "WORKSPACE_A" },
  { name: "policyChanged", messages: [...elided, { role: "system", content: "", sections: { guidance: "TRUSTED_REVISION" }, timestamp: 3 }], snapshot: "WORKSPACE_A" },
  { name: "workspaceChanged", messages: elided, snapshot: "WORKSPACE_B" },
];
const model = { id: "offline-fixture", name: "Offline", api: "google-generative-ai", provider: "offline", input: ["text"], reasoning: false,
  contextWindow: 128_000, maxTokens: 8192, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } as Model<Api>;
const streams = googleGenerativeAIApi();
let inferenceDispatches = 0;
const rows = [];
const previousFetch = globalThis.fetch;
globalThis.fetch = async () => { inferenceDispatches += 1; throw new Error("Unexpected dispatch"); };
for (const fixture of cases) {
  let captured: { config: Record<string, unknown>; contents: unknown } | undefined;
  const result = await streams.streamSimple(model, normalizeContext({ messages: fixture.messages }), {
    apiKey: "offline-noncredential", env: {}, maxRetries: 0,
    onPayload: async (payload) => {
      captured = await cache.applyToPayload({ apiKey: "offline-noncredential", modelId: model.id, payload, workspaceId: "offline-workspace", workspaceSnapshot: fixture.snapshot }) as typeof captured;
      throw new Error("Captured before inference dispatch");
    },
  }).result();
  assert.equal(result.stopReason, "error"); assert.ok(captured, JSON.stringify(result));
  assert.equal(captured.config.systemInstruction, undefined);
  assert.equal(captured.config.tools, undefined);
  assert.ok(JSON.stringify(captured.contents).includes("DYNAMIC_EVIDENCE"));
  rows.push({ variant: fixture.name, cacheReference: captured.config.cachedContent, cumulativeCacheCreates: creates, dynamicContentHash: hash(captured.contents) });
}
assert.deepEqual(rows.map((row) => row.cumulativeCacheCreates), [1, 1, 1, 2, 3, 4]);
assert.equal(rows[0].cacheReference, rows[2].cacheReference);
assert.notEqual(rows[0].dynamicContentHash, rows[1].dynamicContentHash);
globalThis.fetch = previousFetch;
await cache.shutdown();
assert.equal(operations.filter((row) => row.method === "DELETE").length, 4);
assert.equal(operations.some((row) => row.containsConversation), false);
assert.equal(inferenceDispatches, 0);
console.log(JSON.stringify({ sourceSha256: createHash("sha256").update(readFileSync(new URL("../../../main/services/gemini-context-cache.ts", import.meta.url))).digest("hex"), piAiVersion: JSON.parse(readFileSync(new URL("../../../node_modules/@earendil-works/pi-ai/package.json", import.meta.url), "utf8")).version, generatedAt: new Date().toISOString(), evidenceKind: "offline-real-google-adapter-static-cache", node: process.version, rows, operations, inferenceDispatches,
  limitations: ["All cache responses are local fetch fakes; no network, cache hit tokens, storage cost, or inference quality measured.", "Dynamic user variation is solely a cache-key isolation control, never a proposed user-input elision policy.", "Static cache lifecycle operations are distinct from assistant-message usage records; response usageMetadata in this fixture is not consumed by this API."] }, null, 2));
