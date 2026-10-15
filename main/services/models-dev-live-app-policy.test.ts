import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { IpcMainInvokeEvent } from "electron";

import { registerProviderCatalogHandlers } from "../handlers/provider-catalog-handlers.js";
import { createModelsCatalogReader } from "./models-catalog-reader.js";
import {
  fetchModelsDevCatalog,
  MODELS_DEV_CACHE_SCHEMA_VERSION,
  ModelsDevCacheRuntime,
  type ModelsDevCacheDocument,
} from "./models-dev-cache-core.js";
import { providerAuthOwner } from "./provider-auth-owner.js";
import { createProviderModelInfo } from "./provider-model-info-core.js";

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

class FakeFrame {
  readonly parent = null;
  readonly detached = false;
  constructor(
    readonly processId: number,
    readonly routingId: number,
    readonly frameToken: string,
  ) {}
  isDestroyed(): boolean {
    return false;
  }
  send(): void {}
}

class FakeWebContents extends EventEmitter {
  constructor(
    readonly id: number,
    public mainFrame: FakeFrame,
  ) {
    super();
  }
  isDestroyed(): boolean {
    return false;
  }
}

function invokeEvent(sender: FakeWebContents, frame: FakeFrame | null): IpcMainInvokeEvent {
  return {
    sender,
    senderFrame: frame,
    processId: frame?.processId ?? -1,
    frameId: frame?.routingId ?? -1,
  } as unknown as IpcMainInvokeEvent;
}

const BUNDLED = {
  openai: { id: "openai", models: { "gpt-x": { id: "gpt-x", name: "GPT X (bundled)", limit: { context: 1_000, output: 100 } } } },
};
const REMOTE = {
  openai: { id: "openai", models: { "gpt-x": { id: "gpt-x", name: "GPT X (models.dev)", limit: { context: 9_000, output: 900 } } } },
};

interface RecordedRequest {
  url: string;
  init: RequestInit | undefined;
}

/**
 * The providers catalog channels wired the way providers.ts wires them, over a
 * real models.dev runtime and model-info reader whose only network seam is a
 * recording fetch.
 */
function fixture(options: { fail?: boolean } = {}) {
  const requests: RecordedRequest[] = [];
  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(input), init });
    if (options.fail) return new Response("unavailable", { status: 503 });
    return new Response(JSON.stringify(REMOTE), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  let stored: ModelsDevCacheDocument = {
    schemaVersion: MODELS_DEV_CACHE_SCHEMA_VERSION,
    appVersion: "",
    fetchedAt: null,
    catalog: null,
  };
  const runtime = new ModelsDevCacheRuntime({
    appVersion: () => "1.0.0",
    store: {
      read: async () => stored,
      write: async (document) => {
        stored = document;
      },
    },
    fetchCatalog: () => fetchModelsDevCatalog(fakeFetch, 1_000),
    now: () => new Date("2026-10-15T12:00:00.000Z"),
  });
  const reader = createModelsCatalogReader({
    loadBundled: async () => structuredClone(BUNDLED),
    displayCache: runtime,
    benchmarks: { catalog: async () => null },
    warn: () => undefined,
  });
  const modelInfo = createProviderModelInfo({
    modelsCatalog: reader,
    legacyProvider: async (id) => ({ id, baseUrl: "https://api.openai.com/v1" }),
    codexModelInfo: () => undefined,
  });

  const inventoryRefreshes: Array<{ providerIds?: readonly string[]; force?: boolean }> = [];
  const handlers = new Map<string, Handler>();
  registerProviderCatalogHandlers(
    { handle: (channel, handler) => void handlers.set(channel, handler) },
    {
      providerAuthOwner,
      isBuiltinProvider: (id) => id === "openai",
      refreshProviderCatalogs: async (providerIds, force) => {
        inventoryRefreshes.push({ providerIds, force });
        return { providers: [{ id: "openai" }], errors: [] };
      },
      modelsDev: runtime,
      modelsDevStatus: () => runtime.status(),
      modelInfo,
    },
  );

  const frame = new FakeFrame(7, 1, "document-1");
  const sender = new FakeWebContents(1, frame);
  const invoke = (channel: string, event: IpcMainInvokeEvent, ...args: unknown[]) => {
    const handler = handlers.get(channel);
    assert.ok(handler, `missing handler ${channel}`);
    return Promise.resolve(handler(event, ...args));
  };
  return {
    requests,
    inventoryRefreshes,
    handlers,
    reader,
    ownerEvent: invokeEvent(sender, frame),
    // A request from a subframe of the active document is not the auth owner.
    nonOwnerEvent: invokeEvent(sender, new FakeFrame(7, 2, "embedded-frame")),
    invoke,
  };
}

test("constructing the runtime and registering provider handlers never contacts models.dev", () => {
  const { requests, handlers } = fixture();
  assert.ok(handlers.has("providers:updateCatalogs"));
  assert.equal(requests.length, 0);
});

test("updateCatalogs makes exactly one anonymous request to the fixed models.dev endpoint", async () => {
  const { requests, invoke, ownerEvent } = fixture();

  const result = (await invoke("providers:updateCatalogs", ownerEvent)) as {
    modelsDev: { ok: boolean; status: unknown };
  };

  assert.deepEqual(result.modelsDev, {
    ok: true,
    status: { source: "device-cache", fetchedAt: "2026-10-15T12:00:00.000Z" },
  });
  assert.equal(requests.length, 1);
  const [{ url, init }] = requests;
  assert.equal(url, "https://models.dev/api.json");
  assert.equal(init?.method, "GET");
  assert.equal(init?.credentials, "omit");
  assert.equal(init?.redirect, "error");
  assert.equal(init?.body, undefined);
  const headers = new Headers(init?.headers);
  assert.deepEqual([...headers.keys()], ["accept"]);
  for (const name of ["authorization", "cookie", "x-api-key", "x-device-id"]) {
    assert.equal(headers.has(name), false, name);
  }
});

test("updateCatalogs from a non-owner document is rejected before any fetch or inventory refresh", async () => {
  const { requests, inventoryRefreshes, invoke, nonOwnerEvent } = fixture();

  await assert.rejects(
    invoke("providers:updateCatalogs", nonOwnerEvent),
    /must start from the active application document/u,
  );
  assert.equal(requests.length, 0);
  assert.deepEqual(inventoryRefreshes, []);
});

test("catalog status, model info and Pi inventory refreshes read offline only", async () => {
  const { requests, inventoryRefreshes, invoke, ownerEvent } = fixture();

  assert.deepEqual(await invoke("providers:catalogStatus", ownerEvent), {
    source: "bundled",
    fetchedAt: null,
  });
  const before = (await invoke("models:info", ownerEvent, "openai", ["gpt-x"])) as Record<
    string,
    { name?: string }
  >;
  assert.equal(before["gpt-x"]?.name, "GPT X (bundled)");
  await invoke("providers:refresh", ownerEvent, "openai");
  await invoke("providers:refreshIfStale", ownerEvent);
  assert.equal(inventoryRefreshes.length, 2);
  assert.equal(requests.length, 0, "ordinary reads and Pi refreshes must not contact models.dev");

  await invoke("providers:updateCatalogs", ownerEvent);
  const after = (await invoke("models:info", ownerEvent, "openai", ["gpt-x"])) as Record<
    string,
    { name?: string }
  >;
  assert.equal(after["gpt-x"]?.name, "GPT X (models.dev)", "display reads use the device cache");
  await invoke("providers:catalogStatus", ownerEvent);
  assert.equal(requests.length, 1, "reads after the update are served from the cache");
});

test("the device-local models.dev cache never changes runtime limits", async () => {
  const { reader, invoke, ownerEvent } = fixture();
  const provider = { id: "openai", kind: "openai" as const, baseUrl: "https://api.openai.com/v1" };
  const bundled = await reader.runtimeLimits(provider, "gpt-x");

  await invoke("providers:updateCatalogs", ownerEvent);

  assert.deepEqual(await reader.runtimeLimits(provider, "gpt-x"), bundled);
  assert.equal(bundled.contextWindow, 1_000);
  assert.equal((await reader.bundledInfo(provider, "gpt-x")).name, "GPT X (bundled)");
});

test("a failed update reports the error and keeps the bundled status without retrying", async () => {
  const { requests, invoke, ownerEvent } = fixture({ fail: true });

  const result = (await invoke("providers:updateCatalogs", ownerEvent)) as {
    modelsDev: { ok: boolean; status: unknown; message?: string };
  };

  assert.equal(result.modelsDev.ok, false);
  assert.deepEqual(result.modelsDev.status, { source: "bundled", fetchedAt: null });
  assert.match(result.modelsDev.message ?? "", /HTTP 503/u);
  assert.equal(requests.length, 1);
});
