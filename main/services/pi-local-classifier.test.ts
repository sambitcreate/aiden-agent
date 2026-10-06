import assert from "node:assert/strict";
import test from "node:test";
import { createModels, createProvider, type ImageModel, type ClassifierContext } from "@earendil-works/pi-ai";
import { classify } from "@earendil-works/pi-ai/api/llama-cpp-classify";
import { createLocalClassifierModels, localClassifierBaseUrl } from "./pi-local-classifier.js";
import { buildModel, type ResolvedModelRuntime } from "./model-runtime-core.js";
import type { StoredProvider } from "./types.js";

const provider: StoredProvider = {
  id: "custom:llama", kind: "openai", label: "Local llama", baseUrl: "http://localhost:8080/proxy/v1/chat/completions",
  deployment: "local", needsKey: true, models: ["qwen", "embedding"],
  modelMetadata: { embedding: { source: "provider", type: "embedding" } }, llamaCppClassifierEnabled: true,
};
const context: ClassifierContext = { state: { text: "a bug report" }, questions: {
  category: { type: "choice", instructions: "Classify the topic", criteria: { code: "Software", other: "Other" } },
} };
function fixture(initial = provider) {
  const base = createModels();
  let saved = structuredClone(initial), key = "first-key", resolutions = 0;
  let afterResolve = () => {};
  const requests: Array<{ path: string; headers: Headers; body: Record<string, unknown> }> = [];
  let status = 200;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    const body = JSON.parse(String(init?.body));
    requests.push({ path, headers: new Headers(init?.headers), body });
    if (status !== 200) return new Response("Native llama-server endpoint unavailable", { status });
    const payload = path.endsWith("/tokenize") ? { tokens: [...body.content].map((c: string) => c.charCodeAt(0)) }
      : path.endsWith("/apply-template") ? { prompt: "Render the supplied classification question" }
      : { completion_probabilities: [{ top_logprobs: [{ id: 65, logprob: -0.1 }, { id: 66, logprob: -2.5 }] }] };
    return Response.json(payload);
  };
  const facade = createLocalClassifierModels({ models: base, providers: [saved], getProvider: async () => saved,
    resolveRuntime: async () => {
      resolutions++;
      const resolved: ResolvedModelRuntime = { provider: structuredClone(saved), model: buildModel(saved, "qwen", { contextWindow: 8192, maxTokens: 2048, input: ["text"], reasoning: false }),
        models: base, apiKey: key, headers: saved.needsKey ? { "x-fresh-auth": key } : { authorization: "chat-placeholder" },
        streams: { streamSimple: () => { throw new Error("Chat streaming must not be used"); } } };
      afterResolve(); return resolved;
    }, classify: (model, input, options) => classify(model, input, { ...options, fetch }),
  });
  const model = () => facade.models.getModelOfType("classifier", provider.id, "qwen")!;
  return { ...facade, base, requests, model, setSaved: (p: StoredProvider) => { saved = p; },
    rotate: (value: string) => { key = value; }, resolutions: () => resolutions,
    afterResolve: (fn: () => void) => { afterResolve = fn; }, status: (value: number) => { status = value; } };
}

test("only saved opt-in adds classifier inventory without chat pollution or startup requests", async () => {
  for (const p of [{ ...provider, llamaCppClassifierEnabled: false }, { ...provider, llamaCppClassifierEnabled: undefined }, { ...provider, deployment: "hosted" as const }]) {
    const f = fixture(p);
    assert.deepEqual(await f.models.getAvailableOfType("classifier"), []);
    assert.equal(f.resolutions(), 0); assert.equal(f.requests.length, 0);
  }
  const f = fixture();
  assert.deepEqual((await f.models.getAvailableOfType("classifier")).map((m) => m.id), ["qwen"]);
  assert.deepEqual(await f.models.getAvailableOfType("chat"), []);
  assert.deepEqual(await f.models.getAvailableOfType("image"), []);
  assert.deepEqual(await f.base.getAvailableOfType("classifier"), []);
  assert.equal(f.models.getModelOfType("chat", provider.id, "qwen"), undefined);
  assert.equal(f.resolutions(), 0); assert.equal(f.requests.length, 0);
});

test("classifier inventory reads each opted-in provider once per listing and still honors revocation", async () => {
  const second: StoredProvider = { ...provider, id: "custom:other", baseUrl: "http://localhost:9090/v1", models: ["mini"], modelMetadata: undefined };
  const saved = new Map([provider, second].map((p) => [p.id, { ...structuredClone(p), models: p.id === provider.id ? ["qwen", "phi", "embedding"] : p.models }]));
  const reads: string[] = [];
  const facade = createLocalClassifierModels({
    models: createModels(), providers: [...saved.values()],
    getProvider: async (id) => { reads.push(id); return saved.get(id); },
    resolveRuntime: async () => { throw new Error("Listing must not resolve credentials"); },
  });
  assert.deepEqual((await facade.models.getAvailableOfType("classifier")).map((m) => `${m.provider}/${m.id}`),
    ["custom:llama/qwen", "custom:llama/phi", "custom:other/mini"]);
  assert.deepEqual(reads.sort(), ["custom:llama", "custom:other"]);

  reads.length = 0;
  assert.deepEqual((await facade.models.getAvailableOfType("classifier", second.id)).map((m) => m.id), ["mini"]);
  assert.deepEqual(reads, ["custom:other"], "a provider-scoped listing reads only that provider");

  saved.set(provider.id, { ...saved.get(provider.id)!, models: ["qwen"] });
  saved.set(second.id, { ...saved.get(second.id)!, llamaCppClassifierEnabled: false });
  assert.deepEqual((await facade.models.getAvailableOfType("classifier")).map((m) => m.id), ["qwen"]);
});

test("real Pi classifier preserves proxy paths, reads current credentials and produces normalized answers", async () => {
  const f = fixture(); const model = f.model(); f.rotate("rotated-key");
  // A fabricated caller endpoint/header is never authority.
  const result = await f.models.classify({ ...model, baseUrl: "https://evil.invalid", headers: { authorization: "stale" } }, context);
  assert.equal(result.stopReason, "stop", result.errorMessage);
  const answer = result.answers.category;
  assert.equal(answer.type, "choice");
  if (answer.type === "choice") { assert.equal(answer.choice, "code"); assert.ok(answer.probabilities.code > 0.9); }
  assert.equal(f.resolutions(), 1);
  assert.deepEqual([...new Set(f.requests.map((r) => r.path))].sort(), ["/proxy/apply-template", "/proxy/completion", "/proxy/tokenize"]);
  for (const r of f.requests) { assert.equal(r.headers.get("authorization"), "Bearer rotated-key"); assert.equal(r.headers.get("x-fresh-auth"), "rotated-key"); }
  assert.equal(f.requests.find((r) => r.path.endsWith("/completion"))?.body.n_predict, 1);
});

test("keyless classification never sends the chat auth placeholder", async () => {
  const f = fixture({ ...provider, needsKey: false });
  assert.equal((await f.models.classify(f.model(), context)).stopReason, "stop");
  assert.ok(f.requests.length > 0);
  for (const r of f.requests) assert.equal(r.headers.has("authorization"), false);
});

test("capability revocation, endpoint changes and model removal fence dispatch even during credential resolution", async () => {
  for (const change of [{ ...provider, llamaCppClassifierEnabled: false }, { ...provider, baseUrl: "http://other.local/v1" }, { ...provider, models: [] }, { ...provider, needsKey: false }]) {
    for (const during of [false, true]) {
      const f = fixture(); const model = f.model();
      if (during) f.afterResolve(() => f.setSaved(change)); else f.setSaved(change);
      const result = await f.models.classify(model, context);
      assert.equal(result.stopReason, "error"); assert.match(result.errorMessage!, /configuration changed/);
      assert.equal(f.requests.length, 0);
    }
  }
});

test("malformed endpoints, unsupported native APIs and cancellation fail without chat fallback", async () => {
  assert.equal(localClassifierBaseUrl("http://localhost:8080/prefix/v1/chat/completions/"), "http://localhost:8080/prefix/v1");
  for (const baseUrl of ["file:///tmp/foo", "http://key:secret@localhost/v1", "http://localhost/v1?secret=yes"]) {
    const f = fixture({ ...provider, baseUrl });
    assert.equal((await f.models.classify(f.model(), context)).stopReason, "error");
    assert.equal(f.resolutions(), 0); assert.equal(f.requests.length, 0);
  }
  const f = fixture(); f.status(404);
  const result = await f.models.classify(f.model(), context);
  assert.equal(result.stopReason, "error"); assert.match(result.errorMessage!, /llama|404/i);
  const cancelled = fixture(); const abort = new AbortController();
  cancelled.afterResolve(() => abort.abort());
  assert.equal((await cancelled.models.classify(cancelled.model(), context, { signal: abort.signal })).stopReason, "aborted");
  assert.equal(cancelled.requests.length, 0);
});

test("global image providers keep their own endpoint and auth while the local facet is enabled", async () => {
  const f = fixture();
  const image: ImageModel<"openai-images"> = { type: "image", api: "openai-images", provider: "remote-image", id: "image",
    name: "Image", baseUrl: "https://image.example/v1", input: ["text"], output: ["image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  let usedKey: string | undefined, usedUrl: string | undefined;
  f.base.setProvider(createProvider({ id: "remote-image", models: [image],
    auth: { apiKey: { name: "Image key", resolve: async () => ({ auth: { apiKey: "remote-key" }, source: "fixture" }) } },
    images: { "openai-images": { generateImages: async (model, _context, options) => {
      usedKey = options?.apiKey; usedUrl = model.baseUrl;
      return { api: model.api, provider: model.provider, model: model.id, output: [], stopReason: "stop", timestamp: 1 };
    } } },
  }));
  const available = await f.models.getAvailableOfType("image");
  assert.equal(available.length, 1);
  const result = await f.models.generateImages(available[0], { input: [{ type: "text", text: "A flower" }] });
  assert.equal(result.stopReason, "stop", result.errorMessage);
  assert.equal(usedKey, "remote-key"); assert.equal(usedUrl, "https://image.example/v1");
  assert.equal(f.resolutions(), 0); assert.equal(f.requests.length, 0);
});
