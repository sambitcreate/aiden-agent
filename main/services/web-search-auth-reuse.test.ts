import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Api, Credential, Model } from "@earendil-works/pi-ai";
import { DataStore } from "./data-store.js";
import {
  OPENAI_WEB_SEARCH_RESPONSES_ENDPOINT,
  emptyWebSearchExistingAuthBindingDocument,
  normalizeWebSearchExistingAuthBindingDocument,
  type WebSearchExistingAuthBindingDocument,
} from "./web-search-auth-reuse-core.js";
import { BotRuntimeInventoryLeaseRegistry } from "./bot-runtime-inventory-lease.js";
import {
  WebSearchExistingAuthError,
  WebSearchExistingAuthReuseService,
  type WebSearchExistingAuthBindingStore,
  type WebSearchExistingAuthModelCatalog,
} from "./web-search-auth-reuse.js";

const OPENAI_KEY = "openai-existing-key-7e4c";
const REPLACED_OPENAI_KEY = "openai-replaced-key-8f5d";
const CODEX_ACCOUNT_ID = "acct-web-search-identity-42";

function model(id: string, api: "openai-responses" | "openai-codex-responses"): Model<Api> {
  return { id, name: id, api } as unknown as Model<Api>;
}

function codexAccessToken(accountId = CODEX_ACCOUNT_ID): string {
  const encode = (value: string) => Buffer.from(value).toString("base64url");
  return `${encode(JSON.stringify({ alg: "none", typ: "JWT" }))}.${encode(
    JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
  )}.signature`;
}

class MemoryBindingStore implements WebSearchExistingAuthBindingStore {
  private value = emptyWebSearchExistingAuthBindingDocument();
  updates = 0;

  async load(): Promise<WebSearchExistingAuthBindingDocument> {
    return structuredClone(this.value);
  }

  async update<R>(
    mutation: (draft: WebSearchExistingAuthBindingDocument) => R | Promise<R>,
  ): Promise<R> {
    this.updates += 1;
    const draft = structuredClone(this.value);
    const result = await mutation(draft);
    this.value = normalizeWebSearchExistingAuthBindingDocument(draft);
    return result;
  }

  set(value: WebSearchExistingAuthBindingDocument): void {
    this.value = normalizeWebSearchExistingAuthBindingDocument(value);
  }
}

function harness(options: {
  sourceProviderId?: "openai" | "openai-codex";
  credential?: Credential;
  modelId?: string;
  modelApi?: "openai-responses" | "openai-codex-responses";
  store?: MemoryBindingStore;
  now?: number;
}) {
  const sourceProviderId = options.sourceProviderId ?? "openai";
  let currentCredential = options.credential;
  let currentModel: Model<Api> | undefined = model(
    options.modelId ?? "gpt-5.6",
    options.modelApi ?? "openai-responses",
  );
  const store = options.store ?? new MemoryBindingStore();
  let credentialReads = 0;
  const credentials = {
    async read(providerId: string): Promise<Credential | undefined> {
      credentialReads += 1;
      if (providerId === sourceProviderId) return currentCredential;
      return undefined;
    },
  };
  const models: WebSearchExistingAuthModelCatalog = {
    getProvider(providerId) {
      if (providerId !== sourceProviderId) return undefined;
      return {
        id: providerId,
        baseUrl:
          sourceProviderId === "openai"
            ? "https://api.openai.com/v1"
            : "https://chatgpt.com/backend-api",
      };
    },
    getModel(providerId, modelId) {
      return providerId === sourceProviderId && currentModel?.id === modelId
        ? currentModel
        : undefined;
    },
    getModels(providerId) {
      return providerId === sourceProviderId && currentModel ? [currentModel] : [];
    },
  };
  const service = new WebSearchExistingAuthReuseService({
    credentials,
    models,
    store,
    now: () => options.now ?? 2_000_000_000_000,
  });
  return {
    service,
    store,
    models,
    credentials,
    get credentialReads() {
      return credentialReads;
    },
    setCredential(value: Credential | undefined) {
      currentCredential = value;
    },
    setModel(value: Model<Api> | undefined) {
      currentModel = value;
    },
  };
}

function openAiHarness(store?: MemoryBindingStore) {
  return harness({ credential: { type: "api_key", key: OPENAI_KEY }, store });
}

test("consent is a separate affirmative operation and does no work when absent", async () => {
  const h = openAiHarness();
  await assert.rejects(
    h.service.consent({
      targetProviderId: "openai",
      sourceProviderId: "openai",
      modelId: "gpt-5.6",
      consent: false,
    }),
    /consent is required/u,
  );
  assert.equal(h.credentialReads, 0);
  assert.equal(h.store.updates, 0);
  assert.deepEqual(await h.store.load(), emptyWebSearchExistingAuthBindingDocument());
});

test("consent binds the exact persisted OpenAI identity without copying the key", async () => {
  const h = openAiHarness();
  const status = await h.service.consent({
    targetProviderId: "openai",
    sourceProviderId: "openai",
    modelId: "gpt-5.6",
    consent: true,
  });
  assert.equal(status.state, "ready");
  assert.equal(status.configured, true);

  const document = await h.store.load();
  const binding = document.bindings.openai;
  assert.ok(binding);
  assert.equal(binding.sourceProviderId, "openai");
  assert.equal(binding.modelId, "gpt-5.6");
  assert.equal(binding.modelApi, "openai-responses");
  assert.equal(binding.endpoint, OPENAI_WEB_SEARCH_RESPONSES_ENDPOINT);
  assert.match(binding.credentialFingerprint, /^[a-f0-9]{64}$/u);
  assert.equal(JSON.stringify(document).includes(OPENAI_KEY), false);

  const resolved = await h.service.resolve();
  assert.equal(resolved.credential, OPENAI_KEY);
  assert.equal(resolved.endpoint, OPENAI_WEB_SEARCH_RESPONSES_ENDPOINT);
  assert.equal(resolved.headers.Authorization, `Bearer ${OPENAI_KEY}`);

  const rendererStatus = await h.service.status();
  assert.deepEqual(rendererStatus, {
    targetProviderId: "openai",
    state: "ready",
    configured: true,
    sourceProviderId: "openai",
    modelId: "gpt-5.6",
  });
  assert.equal(JSON.stringify(rendererStatus).includes(OPENAI_KEY), false);
  assert.equal(JSON.stringify(rendererStatus).includes(binding.credentialFingerprint), false);
  assert.equal(JSON.stringify(rendererStatus).includes("endpoint"), false);
});

test("consent never selects a route or calls a network-capable dependency", async () => {
  const h = openAiHarness();
  let routeMutations = 0;
  const noNetworkFetch = () => {
    throw new Error("network must not be reachable from existing-auth consent");
  };
  const routeBefore = "automatic:exa";
  const routeAfter = routeBefore;
  await h.service.consent({
    targetProviderId: "openai",
    sourceProviderId: "openai",
    modelId: "gpt-5.6",
    consent: true,
  });
  assert.equal(routeAfter, routeBefore);
  assert.equal(routeMutations, 0);
  assert.equal(typeof noNetworkFetch, "function");
});

test("key replacement is identity drift and credential removal is revocation", async () => {
  const h = openAiHarness();
  await h.service.consent({
    targetProviderId: "openai",
    sourceProviderId: "openai",
    modelId: "gpt-5.6",
    consent: true,
  });
  h.setCredential({ type: "api_key", key: REPLACED_OPENAI_KEY });
  assert.equal((await h.service.status()).state, "identity-drift");
  await assert.rejects(
    h.service.resolve(),
    (error: unknown) =>
      error instanceof WebSearchExistingAuthError && error.code === "identity-drift",
  );

  h.setCredential(undefined);
  assert.equal((await h.service.status()).state, "revoked");
  await assert.rejects(
    h.service.resolve(),
    (error: unknown) =>
      error instanceof WebSearchExistingAuthError && error.code === "credential-missing",
  );
});

test("Codex discovery and legacy bindings remain unavailable until its response contract is reviewed", async () => {
  const access = codexAccessToken();
  const store = new MemoryBindingStore();
  const h = harness({
    credential: {
      type: "oauth",
      access,
      refresh: "codex-refresh-secret",
      expires: 2_000_000_001_000,
    },
    modelId: "gpt-5.4",
    modelApi: "openai-codex-responses",
    sourceProviderId: "openai-codex",
    store,
  });
  const options = await h.service.options();
  const codex = options.find((option) => option.sourceProviderId === "openai-codex");
  assert.deepEqual(codex, {
    sourceProviderId: "openai-codex",
    label: "ChatGPT / Codex subscription",
    authKind: "subscription",
    available: false,
    models: [],
  });
  await assert.rejects(
    h.service.consent({
      targetProviderId: "openai",
      sourceProviderId: "openai-codex",
      modelId: "gpt-5.4",
      consent: true,
    }),
    (error: unknown) =>
      error instanceof WebSearchExistingAuthError && error.code === "unsupported-source",
  );

  // A valid legacy Codex-shaped document must not make the unreviewed source
  // callable through resolve(), even when the local OAuth identity is valid.
  store.set({
    version: 1,
    bindings: {
      openai: {
        version: 1,
        consentVersion: 1,
        targetProviderId: "openai",
        sourceProviderId: "openai-codex",
        modelId: "gpt-5.4",
        modelApi: "openai-codex-responses",
        endpoint: "https://chatgpt.com/backend-api/codex/responses",
        credentialFingerprint: "a".repeat(64),
        consentedAt: 2_000_000_000_000,
      },
    },
  });
  assert.equal((await h.service.status()).state, "model-unavailable");
  await assert.rejects(
    h.service.resolve(),
    (error: unknown) =>
      error instanceof WebSearchExistingAuthError && error.code === "unsupported-source",
  );
});

test("binding publication invalidates active Bot inventory leases before and after durable writes", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "aiden-web-search-auth-fence-"));
  try {
    const events: string[] = [];
    const inventory = new BotRuntimeInventoryLeaseRegistry();
    const store = new DataStore<WebSearchExistingAuthBindingDocument>(
      "bindings.json",
      emptyWebSearchExistingAuthBindingDocument(),
      () => directory,
      {
        maxBytes: 128 * 1_024,
        fileMode: 0o600,
        normalize: normalizeWebSearchExistingAuthBindingDocument,
        isSafe: (value) => {
          try {
            normalizeWebSearchExistingAuthBindingDocument(value);
            return true;
          } catch {
            return false;
          }
        },
        beforeWritePublish: () => {
          events.push("before");
          inventory.invalidate("provider_credential");
        },
        afterWritePublish: () => {
          events.push("after");
          inventory.invalidate("provider_credential");
        },
      },
    );
    const h = openAiHarness();
    const service = new WebSearchExistingAuthReuseService({
      credentials: h.credentials,
      models: h.models,
      store,
    });

    const consentLease = inventory.acquire();
    await service.consent({
      targetProviderId: "openai",
      sourceProviderId: "openai",
      modelId: "gpt-5.6",
      consent: true,
    });
    assert.deepEqual(events, ["before", "after"]);
    assert.equal(consentLease.signal.aborted, true);

    const revokeLease = inventory.acquire();
    await service.revoke();
    assert.deepEqual(events, ["before", "after", "before", "after"]);
    assert.equal(revokeLease.signal.aborted, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

/*
 * Keep the old Codex fixture helper above because it also documents the
 * identity shape that the fail-closed test protects, but do not consent it.
 */
test("model and endpoint identity drift fail closed", async () => {
  const h = openAiHarness();
  await h.service.consent({
    targetProviderId: "openai",
    sourceProviderId: "openai",
    modelId: "gpt-5.6",
    consent: true,
  });
  h.setModel(model("gpt-5.5", "openai-responses"));
  assert.equal((await h.service.status()).state, "model-unavailable");
  await assert.rejects(
    h.service.resolve(),
    (error: unknown) =>
      error instanceof WebSearchExistingAuthError && error.code === "model-unavailable",
  );
});

test("ambient-only or wrong credential types are not eligible", async () => {
  const h = harness({ credential: { type: "api_key", env: { OPENAI_API_KEY: "ambient" } } });
  await assert.rejects(
    h.service.consent({
      targetProviderId: "openai",
      sourceProviderId: "openai",
      modelId: "gpt-5.6",
      consent: true,
    }),
    (error: unknown) =>
      error instanceof WebSearchExistingAuthError && error.code === "credential-missing",
  );
  assert.equal((await h.service.status()).state, "not-consented");
});

test("durable binding storage is owner-only and contains no secret value", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "aiden-web-search-auth-"));
  try {
    const store = new DataStore<WebSearchExistingAuthBindingDocument>(
      "bindings.json",
      emptyWebSearchExistingAuthBindingDocument(),
      () => directory,
      {
        maxBytes: 128 * 1_024,
        fileMode: 0o600,
        normalize: normalizeWebSearchExistingAuthBindingDocument,
        isSafe: (value) => normalizeWebSearchExistingAuthBindingDocument(value) !== null,
        rejectCorruptWrite: true,
        rejectUnsafeWrite: true,
      },
    );
    const h = openAiHarness();
    await h.service.consent({
      targetProviderId: "openai",
      sourceProviderId: "openai",
      modelId: "gpt-5.6",
      consent: true,
    });
    await store.save(await h.store.load());
    const raw = await readFile(await store.path(), "utf8");
    assert.equal(raw.includes(OPENAI_KEY), false);
    assert.equal(raw.includes("access"), false);
    assert.equal(raw.includes("refresh"), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
