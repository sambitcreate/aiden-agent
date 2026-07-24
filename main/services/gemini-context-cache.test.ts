import assert from "node:assert/strict";
import test from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  buildGeminiWorkspaceSnapshot,
  GeminiContextCache,
} from "./gemini-context-cache.js";

const model = {
  id: "gemini-2.5-pro",
} as Model<Api>;

function response(
  status: number,
  body: unknown = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function payload() {
  return {
    model: model.id,
    contents: [{ role: "user", parts: [{ text: "Hello" }] }],
    config: {
      systemInstruction: "Be concise.",
      tools: [{ functionDeclarations: [{ name: "read_file" }] }],
    },
  };
}

test("workspace snapshots are deterministic, bounded metadata without file contents", () => {
  const snapshot = buildGeminiWorkspaceSnapshot(
    {
      entries: [
        {
          path: "src/index.ts",
          name: "index.ts",
          parentPath: "src",
          depth: 1,
          kind: "file",
          size: 42,
          modifiedAt: 12.9,
        },
      ],
      truncated: false,
      skippedDirectories: 2,
    },
    {
      isRepo: true,
      branch: "main",
      uncommitted: 1,
      ahead: 0,
      behind: 0,
    },
  );
  assert.match(snapshot, /"path":"src\/index\.ts"/u);
  assert.match(snapshot, /"modifiedAt":12/u);
  assert.match(snapshot, /"branch":"main"/u);
  assert.doesNotMatch(snapshot, /"content":/u);
});

test("creates once, reuses by fingerprint, and strips duplicated cached fields", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const cache = new GeminiContextCache({
    fetch: async (url, init) => {
      requests.push({ url: String(url), init });
      return response(200, {
        name: "cachedContents/cache-1",
        expireTime: "2030-01-01T00:00:00Z",
      });
    },
    now: () => Date.parse("2029-01-01T00:00:00Z"),
  });
  const options = {
    apiKey: "secret",
    modelId: model.id,
    workspaceId: "workspace-1",
    workspaceSnapshot: "stable workspace metadata",
  };
  const first = (await cache.applyToPayload({
    ...options,
    payload: payload(),
  })) as { config: Record<string, unknown> };
  const second = (await cache.applyToPayload({
    ...options,
    payload: payload(),
  })) as { config: Record<string, unknown> };

  assert.equal(requests.length, 1);
  assert.equal(first.config.cachedContent, "cachedContents/cache-1");
  assert.equal(second.config.cachedContent, "cachedContents/cache-1");
  assert.equal(first.config.systemInstruction, undefined);
  assert.equal(first.config.tools, undefined);
  const createBody = JSON.parse(String(requests[0]?.init?.body)) as {
    model: string;
    systemInstruction: { parts: Array<{ text: string }> };
    tools: unknown[];
    ttl: string;
  };
  assert.equal(createBody.model, "models/gemini-2.5-pro");
  assert.match(createBody.systemInstruction.parts[0]?.text ?? "", /Be concise/u);
  assert.match(
    createBody.systemInstruction.parts[0]?.text ?? "",
    /stable workspace metadata/u,
  );
  assert.equal(createBody.tools.length, 1);
  assert.equal(createBody.ttl, "3600s");
  assert.equal(
    (requests[0]?.init?.headers as Record<string, string>)["x-goog-api-key"],
    "secret",
  );
  assert.doesNotMatch(requests[0]?.url ?? "", /secret/u);
});

test("fingerprint changes create a new cache", async () => {
  let creates = 0;
  const cache = new GeminiContextCache({
    fetch: async () => {
      creates += 1;
      return response(200, {
        name: `cachedContents/cache-${creates}`,
        expireTime: "2030-01-01T00:00:00Z",
      });
    },
    now: () => Date.parse("2029-01-01T00:00:00Z"),
  });
  const base = {
    apiKey: "secret",
    modelId: model.id,
    workspaceId: "workspace-1",
    payload: payload(),
  };
  await cache.applyToPayload({
    ...base,
    workspaceSnapshot: "snapshot one",
  });
  await cache.applyToPayload({
    ...base,
    workspaceSnapshot: "snapshot two",
  });
  assert.equal(creates, 2);
});

test("creation failure is fail-open and backs off repeated attempts", async () => {
  let requests = 0;
  const warnings: string[] = [];
  const cache = new GeminiContextCache({
    fetch: async () => {
      requests += 1;
      return response(400);
    },
    onWarning: (message) => warnings.push(message),
  });
  const options = {
    apiKey: "secret",
    modelId: model.id,
    workspaceId: "workspace-1",
    workspaceSnapshot: "stable workspace metadata",
  };
  const first = await cache.applyToPayload({ ...options, payload: payload() });
  const second = await cache.applyToPayload({ ...options, payload: payload() });
  assert.deepEqual(first, payload());
  assert.deepEqual(second, payload());
  assert.equal(requests, 1);
  assert.equal(warnings.length, 1);
});

test("a hung cache request is bounded and remains fail-open", async () => {
  const warnings: string[] = [];
  const cache = new GeminiContextCache({
    fetch: () => new Promise<Response>(() => {}),
    onWarning: (message) => warnings.push(message),
    requestTimeoutMs: 5,
  });
  const original = payload();
  const result = await cache.applyToPayload({
    apiKey: "secret",
    modelId: model.id,
    workspaceId: "workspace-1",
    workspaceSnapshot: "stable workspace metadata",
    payload: original,
  });
  assert.strictEqual(result, original);
  assert.equal(warnings.length, 1);
});

test("one cancelled waiter cannot poison a shared cache for healthy turns", async () => {
  let resolveCreate: ((response: Response) => void) | undefined;
  let requests = 0;
  const cache = new GeminiContextCache({
    fetch: () => {
      requests += 1;
      return new Promise<Response>((resolve) => {
        resolveCreate = resolve;
      });
    },
  });
  const controller = new AbortController();
  const base = {
    apiKey: "secret",
    modelId: model.id,
    workspaceId: "workspace-1",
    workspaceSnapshot: "stable workspace metadata",
  };
  const cancelled = cache.applyToPayload({
    ...base,
    payload: payload(),
    signal: controller.signal,
  });
  const healthy = cache.applyToPayload({
    ...base,
    payload: payload(),
  }) as Promise<{ config: Record<string, unknown> }>;
  await Promise.resolve();
  controller.abort();
  assert.deepEqual(await cancelled, payload());
  assert.ok(resolveCreate);
  resolveCreate?.(
    response(200, {
      name: "cachedContents/shared-cache",
      expireTime: "2030-01-01T00:00:00Z",
    }),
  );

  assert.equal((await healthy).config.cachedContent, "cachedContents/shared-cache");
  assert.equal(requests, 1);
});

test("workspace fingerprint churn evicts old remote caches with a fixed bound", async () => {
  let creates = 0;
  let deletes = 0;
  const cache = new GeminiContextCache({
    fetch: async (_url, init) => {
      if (init?.method === "DELETE") {
        deletes += 1;
        return response(200);
      }
      creates += 1;
      return response(200, {
        name: `cachedContents/cache-${creates}`,
        expireTime: "2030-01-01T00:00:00Z",
      });
    },
    now: () => Date.parse("2029-01-01T00:00:00Z"),
  });
  for (let index = 0; index < 10; index += 1) {
    await cache.applyToPayload({
      apiKey: "secret",
      modelId: model.id,
      workspaceId: "workspace-1",
      workspaceSnapshot: `snapshot ${index}`,
      payload: payload(),
    });
  }
  await Promise.resolve();
  assert.equal(creates, 10);
  assert.equal(deletes, 2);
});

test("in-flight invalidation owns exactly one eventual remote deletion", async () => {
  let resolveCreate: ((response: Response) => void) | undefined;
  let deletes = 0;
  const cache = new GeminiContextCache({
    fetch: async (_url, init) => {
      if (init?.method === "DELETE") {
        deletes += 1;
        return response(200);
      }
      return new Promise<Response>((resolve) => {
        resolveCreate = resolve;
      });
    },
  });
  const applying = cache.applyToPayload({
    apiKey: "secret",
    modelId: model.id,
    workspaceId: "workspace-1",
    workspaceSnapshot: "stable workspace metadata",
    payload: payload(),
  });
  await Promise.resolve();
  const invalidating = cache.invalidateWorkspace("workspace-1");
  assert.ok(resolveCreate);
  resolveCreate?.(
    response(200, {
      name: "cachedContents/in-flight-cache",
      expireTime: "2030-01-01T00:00:00Z",
    }),
  );
  await Promise.all([applying, invalidating]);
  assert.equal(deletes, 1);
});

test("workspace invalidation and shutdown delete remote caches without URL credentials", async () => {
  const requests: Array<{ url: string; method: string; key?: string }> = [];
  let created = 0;
  const cache = new GeminiContextCache({
    fetch: async (url, init) => {
      const headers = init?.headers as Record<string, string>;
      requests.push({
        url: String(url),
        method: init?.method ?? "GET",
        key: headers?.["x-goog-api-key"],
      });
      if (init?.method === "DELETE") return response(200);
      created += 1;
      return response(200, {
        name: `cachedContents/cache-${created}`,
        expireTime: "2030-01-01T00:00:00Z",
      });
    },
    now: () => Date.parse("2029-01-01T00:00:00Z"),
  });
  await cache.applyToPayload({
    apiKey: "secret",
    modelId: model.id,
    workspaceId: "workspace-1",
    workspaceSnapshot: "snapshot one",
    payload: payload(),
  });
  await cache.invalidateWorkspace("workspace-1");
  await cache.applyToPayload({
    apiKey: "secret",
    modelId: model.id,
    workspaceId: "workspace-2",
    workspaceSnapshot: "snapshot two",
    payload: payload(),
  });
  await cache.shutdown();

  const deletes = requests.filter((request) => request.method === "DELETE");
  assert.equal(deletes.length, 2);
  assert.ok(deletes.every((request) => request.key === "secret"));
  assert.ok(deletes.every((request) => !request.url.includes("secret")));
});

test("missing workspace context never contacts Google", async () => {
  let requests = 0;
  const cache = new GeminiContextCache({
    fetch: async () => {
      requests += 1;
      return response(500);
    },
  });
  const original = payload();
  const result = await cache.applyToPayload({
    apiKey: "secret",
    modelId: model.id,
    workspaceId: "",
    workspaceSnapshot: "",
    payload: original,
  });
  assert.strictEqual(result, original);
  assert.equal(requests, 0);
});
