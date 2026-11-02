import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { AuthContext, ImageApi, ImageModel } from "@earendil-works/pi-ai";
import { explainAspectRatioRejection, ImageGenerationError, ImageGenerationRuntime } from "./runtime.js";
import {
  createImageGenerationSettingsStore,
  IMAGE_GENERATION_SETTINGS_FILE,
  type ImageGenerationSettingsStore,
} from "./settings-store.js";
import { bytes, fakeFetch, imageModel, json, MemoryCredentialStore, png } from "./test-support.js";

const CHAT_KEY = "sk-or-chat-only-key";

function bundledOpenRouter(): ImageModel<ImageApi>[] {
  return [
    imageModel("openrouter", "google/gemini-3.1-flash-image", "openrouter-images", ["text", "image"]),
    imageModel("openrouter", "black-forest-labs/flux.2-pro", "openrouter-images"),
    imageModel("openrouter", "openrouter/auto", "openrouter-images"),
  ];
}

interface Setup {
  env?: Record<string, string>;
  fetch?: typeof fetch;
  onWarning?: (message: string) => void;
  openRouterModels?: () => ImageModel<ImageApi>[];
  wrapSettings?: (store: ImageGenerationSettingsStore) => ImageGenerationSettingsStore;
  catalogFetchTimeoutMs?: number;
  catalogFetchCooldownMs?: number;
}

async function setup(t: test.TestContext, options: Setup = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-image-runtime-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const credentials = new MemoryCredentialStore({ openrouter: { type: "api_key", key: CHAT_KEY } });
  const env = options.env ?? {};
  const authContext: AuthContext = { env: async (name) => env[name], fileExists: async () => false };
  const runtime = new ImageGenerationRuntime({
    credentials,
    settings: (options.wrapSettings ?? ((store) => store))(createImageGenerationSettingsStore(() => root)),
    openRouterModels: options.openRouterModels ?? bundledOpenRouter,
    authContext,
    pollIntervalMs: 1,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.onWarning ? { onWarning: options.onWarning } : {}),
    ...(options.catalogFetchTimeoutMs ? { catalogFetchTimeoutMs: options.catalogFetchTimeoutMs } : {}),
    ...(options.catalogFetchCooldownMs !== undefined ? { catalogFetchCooldownMs: options.catalogFetchCooldownMs } : {}),
  });
  return { runtime, credentials, root };
}

async function availableIds(runtime: ImageGenerationRuntime, provider?: string) {
  return (await runtime.models.getAvailableOfType("image", provider)).map((model) => `${model.provider}:${model.id}`);
}

test("a chat OpenRouter key never makes image generation available", async (t) => {
  const { runtime } = await setup(t, { env: { OPENROUTER_API_KEY: "sk-or-env-chat" } });
  assert.deepEqual(await availableIds(runtime), []);
  const state = await runtime.getState();
  assert.deepEqual(state.providers.find((provider) => provider.id === "openrouter")?.key, {
    connected: false,
    source: null,
  });
  // The whole catalog is still listed for Settings.
  assert.ok(state.models.some((model) => model.provider === "openrouter" && model.id === "black-forest-labs/flux.2-pro"));
  assert.equal(state.models.some((model) => model.id === "openrouter/auto"), false);
});

test("only the dedicated AIDEN_IMAGE_* env var authorizes an image provider", async (t) => {
  const { runtime } = await setup(t, { env: { AIDEN_IMAGE_OPENROUTER_API_KEY: "sk-or-image-env" } });
  assert.deepEqual(await availableIds(runtime), [
    "openrouter:google/gemini-3.1-flash-image",
    "openrouter:black-forest-labs/flux.2-pro",
  ]);
  const state = await runtime.getState();
  assert.deepEqual(state.providers.find((provider) => provider.id === "openrouter")?.key, {
    connected: true,
    source: "env",
  });
});

test("a stored image key lives in its namespace and is never returned in state", async (t) => {
  const { runtime, credentials } = await setup(t);
  const state = await runtime.setKey("replicate", "  r8_stored_image_key  ");
  assert.deepEqual(credentials.entries.get("aiden-internal:image-gen:replicate"), {
    type: "api_key",
    key: "r8_stored_image_key",
  });
  assert.deepEqual(credentials.entries.get("openrouter"), { type: "api_key", key: CHAT_KEY });
  assert.equal(JSON.stringify(state).includes("r8_stored_image_key"), false);
  assert.deepEqual(state.providers.find((provider) => provider.id === "replicate")?.key, {
    connected: true,
    source: "stored",
  });
  assert.ok((await availableIds(runtime, "replicate")).includes("replicate:google/nano-banana-2.1"));

  await runtime.removeKey("replicate");
  assert.deepEqual(await availableIds(runtime, "replicate"), []);
});

test("keys are trimmed and bounded without any network call", async (t) => {
  const { fetch, requests } = fakeFetch(() => json({}));
  const { runtime, credentials } = await setup(t, { fetch });
  for (const bad of ["short", "has a space inside", "x".repeat(600), 42]) {
    await assert.rejects(runtime.setKey("fal", bad), (error: unknown) =>
      error instanceof ImageGenerationError && error.code === "invalid_key",
    );
  }
  assert.equal(credentials.entries.has("aiden-internal:image-gen:fal"), false);
  assert.equal(requests.length, 0);
});

test("a disabled model is hidden from every consumer lookup and cannot generate", async (t) => {
  const { fetch, requests } = fakeFetch(() => json({}, 500));
  const { runtime } = await setup(t, { env: { AIDEN_IMAGE_FAL_KEY: "fal-env-key-123" }, fetch });
  await runtime.ready();
  assert.ok(runtime.models.getModelOfType("image", "fal", "fal-ai/flux/schnell"));

  const state = await runtime.setModelEnabled("fal", "fal-ai/flux/schnell", false);
  assert.equal(state.models.find((model) => model.id === "fal-ai/flux/schnell")?.enabled, false);
  assert.equal(runtime.models.getModelOfType("image", "fal", "fal-ai/flux/schnell"), undefined);
  assert.equal((await availableIds(runtime, "fal")).includes("fal:fal-ai/flux/schnell"), false);

  const result = await runtime.models.generateImages(
    imageModel("fal", "fal-ai/flux/schnell", "fal-images"),
    { input: [{ type: "text", text: "x" }] },
  );
  assert.equal(result.stopReason, "error");
  assert.match(result.errorMessage ?? "", /turned off/u);
  assert.equal(requests.length, 0);

  await runtime.setModelEnabled("fal", "fal-ai/flux/schnell", true);
  assert.ok((await availableIds(runtime, "fal")).includes("fal:fal-ai/flux/schnell"));
  await assert.rejects(runtime.setModelEnabled("fal", "unknown/model", true), (error: unknown) =>
    error instanceof ImageGenerationError && error.code === "unknown_model",
  );
});

test("generation goes through Pi auth with the stored image key only", async (t) => {
  const delivery = "https://replicate.delivery/out.png";
  const { fetch, requests } = fakeFetch((request) =>
    request.url === delivery ? bytes(png(2)) : json({ id: "p1", status: "succeeded", output: delivery }),
  );
  const { runtime } = await setup(t, { fetch });
  await runtime.setKey("replicate", "r8_stored_image_key");
  const model = runtime.models.getModelOfType("image", "replicate", "black-forest-labs/flux-schnell");
  assert.ok(model);

  const result = await runtime.models.generateImages(model, { input: [{ type: "text", text: "a fox" }] });

  assert.equal(result.stopReason, "stop", result.errorMessage);
  assert.equal(result.output.length, 1);
  assert.equal(requests[0]!.headers.authorization, "Bearer r8_stored_image_key");
});

test("fetched models start disabled, custom models start enabled, and curated ones win", async (t) => {
  const { fetch } = fakeFetch((request) => {
    const category = new URL(request.url).searchParams.get("category");
    return json(
      category === "text-to-image"
        ? {
            models: [
              { endpoint_id: "fal-ai/flux/schnell", metadata: { display_name: "Renamed upstream" } },
              { endpoint_id: "acme/new-model", metadata: { display_name: "New Model" } },
            ],
          }
        : { models: [] },
    );
  });
  const { runtime } = await setup(t, { env: { AIDEN_IMAGE_FAL_KEY: "fal-env-key-123" }, fetch });

  const fetched = await runtime.fetchModels("fal");
  const fal = fetched.providers.find((provider) => provider.id === "fal");
  assert.equal(fal?.fetchedCount, 2);
  assert.ok((fal?.fetchedAt ?? 0) > 0);
  const schnell = fetched.models.find((model) => model.id === "fal-ai/flux/schnell");
  assert.deepEqual([schnell?.origin, schnell?.name, schnell?.enabled], ["curated", "FLUX Schnell", true]);
  const added = fetched.models.find((model) => model.id === "acme/new-model");
  assert.deepEqual([added?.origin, added?.enabled], ["fetched", false]);
  assert.equal((await availableIds(runtime, "fal")).includes("fal:acme/new-model"), false);

  const custom = await runtime.addCustomModel({
    provider: "replicate",
    id: "acme/painter",
    name: "Painter",
    referenceField: "image_input",
  });
  const painter = custom.models.find((model) => model.id === "acme/painter");
  assert.deepEqual([painter?.origin, painter?.enabled, painter?.acceptsReferenceImages], ["custom", true, true]);
  await assert.rejects(runtime.addCustomModel({ provider: "replicate", id: "acme/painter" }), ImageGenerationError);
  await assert.rejects(
    runtime.addCustomModel({ provider: "replicate", id: "google/nano-banana-2.1" }),
    /already in the list/u,
  );

  await runtime.setDefaultModel({ provider: "replicate", id: "acme/painter" });
  const removed = await runtime.removeCustomModel({ provider: "replicate", id: "acme/painter" });
  assert.equal(removed.models.some((model) => model.id === "acme/painter"), false);
  assert.equal(removed.defaultModel, null);
  await assert.rejects(runtime.removeCustomModel({ provider: "fal", id: "fal-ai/flux/schnell" }), /Only models you added/u);
});

test("the default model is the stored choice when usable, otherwise the first available", async (t) => {
  const { runtime } = await setup(t, {
    env: { AIDEN_IMAGE_OPENROUTER_API_KEY: "sk-or-image-env", AIDEN_IMAGE_FAL_KEY: "fal-env-key-123" },
  });
  assert.equal((await runtime.defaultModel())?.id, "google/gemini-3.1-flash-image");

  await runtime.setModelEnabled("fal", "fal-ai/flux/schnell", false);
  const state = await runtime.setDefaultModel({ provider: "fal", id: "fal-ai/flux/schnell" });
  // Choosing a default turns it on.
  assert.equal(state.models.find((model) => model.id === "fal-ai/flux/schnell")?.enabled, true);
  assert.deepEqual(state.defaultModel, { provider: "fal", id: "fal-ai/flux/schnell" });
  assert.equal((await runtime.defaultModel())?.id, "fal-ai/flux/schnell");
});

test("with no stored default, Nano Banana 2 is preferred over earlier-listed models, then the first available", async (t) => {
  // Pi's bundled list puts FLUX before Nano Banana 2, as here.
  const { runtime } = await setup(t, {
    env: { AIDEN_IMAGE_OPENROUTER_API_KEY: "sk-or-image-env" },
    openRouterModels: () => [
      imageModel("openrouter", "black-forest-labs/flux-3-image", "openrouter-images"),
      imageModel("openrouter", "google/gemini-3.1-flash-image", "openrouter-images", ["text", "image"]),
    ],
  });
  assert.equal((await runtime.snapshot()).defaultModel?.id, "google/gemini-3.1-flash-image");

  await runtime.setModelEnabled("openrouter", "google/gemini-3.1-flash-image", false);
  assert.equal((await runtime.snapshot()).defaultModel?.id, "black-forest-labs/flux-3-image");
});

test("clearing for onboarding reset removes image keys and settings but not chat keys", async (t) => {
  const { runtime, credentials, root } = await setup(t);
  await runtime.setKey("fal", "fal-stored-key-1");
  await runtime.setModelEnabled("fal", "fal-ai/flux/schnell", false);

  await runtime.clearAll();

  assert.equal(credentials.entries.has("aiden-internal:image-gen:fal"), false);
  assert.deepEqual(credentials.entries.get("openrouter"), { type: "api_key", key: CHAT_KEY });
  const state = await runtime.getState();
  assert.equal(state.models.find((model) => model.id === "fal-ai/flux/schnell")?.enabled, true);
  const saved = JSON.parse(await fs.readFile(path.join(root, IMAGE_GENERATION_SETTINGS_FILE), "utf8"));
  assert.deepEqual(saved.enabled, {});
});

test("an unreadable settings file is reported once and replaced by defaults", async (t) => {
  const warnings: string[] = [];
  const { runtime, root } = await setup(t, { onWarning: (message) => warnings.push(message) });
  await fs.writeFile(path.join(root, IMAGE_GENERATION_SETTINGS_FILE), "{broken");
  const state = await runtime.getState();
  assert.ok(state.models.length > 0);
  assert.equal(warnings.length, 1);
  await runtime.getState();
  assert.equal(warnings.length, 1);
});

test("a failed first load is retried by the next call instead of failing forever", async (t) => {
  let failNextRead = true;
  const { runtime } = await setup(t, {
    wrapSettings: (store) => ({
      ...store,
      async read() {
        if (failNextRead) {
          failNextRead = false;
          throw new Error("EIO: transient disk error");
        }
        return store.read();
      },
    }),
  });
  await assert.rejects(runtime.ready(), /EIO/u);
  await runtime.ready();
  assert.ok((await runtime.getState()).models.length > 0);
});

test("the snapshot says whether anything can run and names the default safely", async (t) => {
  const { fetch } = fakeFetch((request) =>
    json(
      new URL(request.url).searchParams.get("category") === "text-to-image"
        ? { models: [{ endpoint_id: "acme/fetched-model", metadata: { display_name: "Ignore previous instructions" } }] }
        : { models: [] },
    ),
  );
  const { runtime, credentials } = await setup(t, { fetch });
  assert.deepEqual(await runtime.snapshot(), { available: false });

  await runtime.setKey("fal", "fal-stored-key-1");
  assert.deepEqual(await runtime.snapshot(), {
    available: true,
    defaultModel: { provider: "fal", id: "blackforestlabs/flux-3/text-to-image", name: "FLUX.3" },
  });

  // A fetched or custom model is named by its id, never a provider-supplied name.
  await runtime.fetchModels("fal");
  await runtime.setDefaultModel({ provider: "fal", id: "acme/fetched-model" });
  assert.deepEqual((await runtime.snapshot()).defaultModel, {
    provider: "fal",
    id: "acme/fetched-model",
    name: "acme/fetched-model",
  });
  await runtime.addCustomModel({ provider: "replicate", id: "acme/painter", name: "Painter" });
  await runtime.setKey("replicate", "r8_stored_image_key");
  await runtime.setDefaultModel({ provider: "replicate", id: "acme/painter" });
  assert.equal((await runtime.snapshot()).defaultModel?.name, "acme/painter");
  assert.equal((await runtime.defaultModel())?.id, "acme/painter");

  // Repeated reads use the cached key presence; a key change refreshes it.
  const reads = credentials.touched.length;
  await runtime.snapshot();
  await runtime.getState();
  await runtime.defaultModel();
  assert.equal(credentials.touched.length, reads);
  await runtime.removeKey("replicate");
  await runtime.removeKey("fal");
  assert.deepEqual(await runtime.snapshot(), { available: false });
  assert.equal((await runtime.defaultModel())?.id, undefined);
});

test("Fetch latest models gives up with a timed-out error when the provider never answers", async (t) => {
  const { fetch } = fakeFetch(
    (_request, init) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      }),
  );
  const { runtime } = await setup(t, { fetch, catalogFetchTimeoutMs: 20 });
  await runtime.ready();
  const keepAlive = setTimeout(() => undefined, 5_000);
  try {
    await assert.rejects(runtime.fetchModels("openrouter"), (error: unknown) =>
      error instanceof ImageGenerationError && error.code === "network_error" && /took too long/u.test(error.message),
    );
  } finally {
    clearTimeout(keepAlive);
  }
  assert.equal((await runtime.getState()).providers.find((provider) => provider.id === "openrouter")?.fetchedAt, null);
});

const OPENROUTER_CATALOG = {
  data: [{ id: "acme/painter-2", name: "Acme: Painter 2", architecture: { input_modalities: ["text"], output_modalities: ["image"] } }],
};

test("Fetch latest models is single-flight per provider: concurrent presses make one request", async (t) => {
  let answer: (() => void) | undefined;
  const { fetch, requests } = fakeFetch(
    () => new Promise<Response>((resolve) => (answer = () => resolve(json(OPENROUTER_CATALOG)))),
  );
  const { runtime } = await setup(t, { fetch, catalogFetchCooldownMs: 0 });
  const presses = [runtime.fetchModels("openrouter"), runtime.fetchModels("openrouter"), runtime.fetchModels("openrouter")];
  for (let turn = 0; turn < 100 && !answer; turn += 1) await new Promise((resolve) => setImmediate(resolve));
  answer!();
  const states = await Promise.all(presses);
  assert.equal(requests.length, 1);
  for (const state of states) assert.ok(state.models.some((model) => model.id === "acme/painter-2"));
  // Once it has settled, a new press (cooldown off) goes to the network again.
  const again = runtime.fetchModels("openrouter");
  for (let turn = 0; turn < 100 && requests.length < 2; turn += 1) await new Promise((resolve) => setImmediate(resolve));
  answer!();
  await again;
  assert.equal(requests.length, 2);
});

test("a repeat Fetch latest models right after a success is answered without the network", async (t) => {
  const { fetch, requests } = fakeFetch(() => json(OPENROUTER_CATALOG));
  const { runtime } = await setup(t, { fetch, catalogFetchCooldownMs: 60_000 });
  await runtime.fetchModels("openrouter");
  const repeat = await runtime.fetchModels("openrouter");
  assert.equal(requests.length, 1);
  assert.ok(repeat.models.some((model) => model.id === "acme/painter-2"));
  // The cooldown is per provider and only follows a success.
  const failing = fakeFetch(() => json({ error: "nope" }, 500));
  const other = await setup(t, { fetch: failing.fetch, catalogFetchCooldownMs: 60_000 });
  await assert.rejects(other.runtime.fetchModels("openrouter"));
  await assert.rejects(other.runtime.fetchModels("openrouter"));
  assert.equal(failing.requests.length, 2);
});

test("changing one provider's models leaves the other providers' registrations untouched", async (t) => {
  const { runtime } = await setup(t, { env: { AIDEN_IMAGE_FAL_KEY: "fal-env-key-123" } });
  await runtime.ready();
  const fal = runtime.models.getModelOfType("image", "fal", "fal-ai/flux/schnell");

  await runtime.setModelEnabled("replicate", "google/imagen-4-fast", false);
  const replicate = runtime.models.getModelOfType("image", "replicate", "black-forest-labs/flux-schnell");
  await runtime.setDefaultModel({ provider: "replicate", id: "black-forest-labs/flux-schnell" });
  assert.equal(runtime.models.getModelOfType("image", "fal", "fal-ai/flux/schnell"), fal);
  assert.equal(runtime.models.getModelOfType("image", "replicate", "google/imagen-4-fast"), undefined);
  // Choosing an already-enabled default changes no registration.
  assert.equal(runtime.models.getModelOfType("image", "replicate", "black-forest-labs/flux-schnell"), replicate);
});

test("stale enable choices are pruned so the choice limit can't block saves", async (t) => {
  const { runtime, root } = await setup(t);
  const stale = Object.fromEntries(Array.from({ length: 2000 }, (_, index) => [`gone/model-${index}`, false]));
  await fs.writeFile(
    path.join(root, IMAGE_GENERATION_SETTINGS_FILE),
    JSON.stringify({ version: 1, enabled: { fal: stale } }),
  );

  const state = await runtime.setModelEnabled("fal", "fal-ai/flux/schnell", false);

  assert.equal(state.models.find((model) => model.id === "fal-ai/flux/schnell")?.enabled, false);
  const saved = JSON.parse(await fs.readFile(path.join(root, IMAGE_GENERATION_SETTINGS_FILE), "utf8"));
  assert.deepEqual(saved.enabled.fal, { "fal-ai/flux/schnell": false });
});

test("OpenRouter's auto router can't be added as a custom model", async (t) => {
  const { runtime } = await setup(t);
  for (const id of ["openrouter/auto", "openrouter/auto-image"]) {
    await assert.rejects(runtime.addCustomModel({ provider: "openrouter", id }), (error: unknown) =>
      error instanceof ImageGenerationError && error.code === "invalid_request",
    );
  }
  assert.equal((await runtime.getState()).models.some((model) => model.id.startsWith("openrouter/auto")), false);
});

test("registered OpenRouter models carry the same name Settings shows, and makers resolve", async (t) => {
  const { runtime } = await setup(t, {
    env: { AIDEN_IMAGE_OPENROUTER_API_KEY: "sk-or-image-env" },
    openRouterModels: () => [
      { ...imageModel("openrouter", "google/gemini-3.1-flash-image", "openrouter-images"), name: "Google: Nano Banana 2" },
    ],
  });
  const state = await runtime.getState();
  const view = state.models.find((model) => model.id === "google/gemini-3.1-flash-image");
  const registered = runtime.models.getModelOfType("image", "openrouter", "google/gemini-3.1-flash-image");
  assert.equal(view?.name, "Nano Banana 2");
  assert.equal(registered?.name, "Nano Banana 2");
  assert.equal((await runtime.snapshot()).defaultModel?.name, "Nano Banana 2");

  assert.equal(runtime.imageModelMaker("openrouter", "google/gemini-3.1-flash-image"), "google");
  assert.equal(runtime.imageModelMaker("replicate", "black-forest-labs/flux-schnell"), "black-forest-labs");
  assert.equal(runtime.imageModelMaker("fal", "unknown-vendor/thing"), undefined);
});

test("bulk enable choices land in one write and leave untouched providers' registrations alone", async (t) => {
  let writes = 0;
  const { runtime } = await setup(t, {
    env: { AIDEN_IMAGE_FAL_KEY: "fal-env-key-123", AIDEN_IMAGE_OPENROUTER_API_KEY: "sk-or-image-env" },
    wrapSettings: (store) => ({
      ...store,
      update: (mutate) => {
        writes += 1;
        return store.update(mutate);
      },
    }),
  });
  await runtime.ready();
  const openRouter = runtime.models.getModelOfType("image", "openrouter", "google/gemini-3.1-flash-image");
  assert.ok(openRouter);
  await runtime.setDefaultModel({ provider: "fal", id: "fal-ai/flux/schnell" });
  writes = 0;

  const state = await runtime.setModelsEnabled([
    { provider: "fal", id: "fal-ai/flux/schnell", enabled: false },
    { provider: "replicate", id: "google/imagen-4-fast", enabled: false },
    { provider: "fal", id: "fal-ai/flux-2-pro", enabled: false },
  ]);

  assert.equal(writes, 1);
  const enabled = (id: string) => state.models.find((model) => model.id === id)?.enabled;
  assert.deepEqual(
    [enabled("fal-ai/flux/schnell"), enabled("google/imagen-4-fast"), enabled("fal-ai/flux-2-pro")],
    [false, false, false],
  );
  assert.equal(runtime.models.getModelOfType("image", "fal", "fal-ai/flux/schnell"), undefined);
  assert.equal(runtime.models.getModelOfType("image", "replicate", "google/imagen-4-fast"), undefined);
  // OpenRouter was not in the request, so its registration is the same object.
  assert.equal(runtime.models.getModelOfType("image", "openrouter", "google/gemini-3.1-flash-image"), openRouter);
  // Turning off the default keeps it stored, as a single toggle does.
  assert.deepEqual(state.defaultModel, { provider: "fal", id: "fal-ai/flux/schnell" });

  const back = await runtime.setModelsEnabled([{ provider: "fal", id: "fal-ai/flux/schnell", enabled: true }]);
  assert.equal(back.models.find((model) => model.id === "fal-ai/flux/schnell")?.enabled, true);
  assert.ok(runtime.models.getModelOfType("image", "fal", "fal-ai/flux/schnell"));
});

test("a default chosen while the same model is being toggled off ends with every view agreeing", async (t) => {
  const id = "fal-ai/flux/schnell";
  type Race = (runtime: ImageGenerationRuntime) => Promise<unknown>[];
  const toggleOff: Race = (runtime) => [runtime.setModelEnabled("fal", id, false)];
  const bulkOff: Race = (runtime) => [runtime.setModelsEnabled([{ provider: "fal", id, enabled: false }])];
  const chooseDefault: Race = (runtime) => [runtime.setDefaultModel({ provider: "fal", id })];
  const races: [string, Race][] = [
    ["toggle, then default", (runtime) => [...toggleOff(runtime), ...chooseDefault(runtime)]],
    ["default, then toggle", (runtime) => [...chooseDefault(runtime), ...toggleOff(runtime)]],
    ["bulk, then default", (runtime) => [...bulkOff(runtime), ...chooseDefault(runtime)]],
    ["default, then bulk", (runtime) => [...chooseDefault(runtime), ...bulkOff(runtime)]],
  ];
  for (const [label, race] of races) {
    const { runtime, root } = await setup(t, { env: { AIDEN_IMAGE_FAL_KEY: "fal-env-key-123" } });
    await runtime.ready();
    await Promise.all(race(runtime));

    const saved = JSON.parse(await fs.readFile(path.join(root, IMAGE_GENERATION_SETTINGS_FILE), "utf8"));
    const stored = saved.enabled.fal[id] as boolean;
    const state = await runtime.getState();
    const listed = state.models.find((model) => model.provider === "fal" && model.id === id)?.enabled;
    const registered = runtime.models.getModelOfType("image", "fal", id) !== undefined;
    const snapshotDefault = (await runtime.snapshot()).defaultModel;
    assert.deepEqual(saved.defaultModel, { provider: "fal", id }, label);
    assert.equal(listed, stored, label);
    assert.equal(registered, stored, label);
    assert.equal(snapshotDefault?.provider === "fal" && snapshotDefault.id === id, stored, label);
  }
});

test("a bulk request naming an unlisted model is rejected without writing any choice", async (t) => {
  const { runtime, root } = await setup(t);
  const before = await runtime.getState();
  await assert.rejects(
    runtime.setModelsEnabled([
      { provider: "fal", id: "fal-ai/flux/schnell", enabled: false },
      { provider: "fal", id: "acme/not-listed", enabled: true },
    ]),
    (error: unknown) => error instanceof ImageGenerationError && error.code === "invalid_request",
  );
  assert.deepEqual(await runtime.getState(), before);
  await assert.rejects(fs.readFile(path.join(root, IMAGE_GENERATION_SETTINGS_FILE), "utf8"), { code: "ENOENT" });
});

test("a requested aspect ratio reaches each provider only in a field that model understands", async (t) => {
  const delivery = "https://replicate.delivery/out.png";
  const falQueue = "https://queue.fal.run/fal-ai/requests/r1";
  const pngUri = `data:image/png;base64,${Buffer.from(png(3)).toString("base64")}`;
  const { fetch, requests } = fakeFetch((request) => {
    if (request.url === delivery) return bytes(png(2));
    if (request.url.startsWith("https://api.replicate.com/")) return json({ id: "p1", status: "succeeded", output: delivery });
    if (request.url === `${falQueue}/status`) return json({ status: "COMPLETED" });
    if (request.url === falQueue) return json({ images: [{ url: pngUri }] });
    if (request.url.startsWith("https://queue.fal.run/"))
      return json({ request_id: "r1", status_url: `${falQueue}/status`, response_url: falQueue, cancel_url: `${falQueue}/cancel` });
    return json({
      id: "gen-1",
      object: "chat.completion",
      created: 1,
      model: "x",
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "", images: [{ type: "image_url", image_url: { url: pngUri } }] } }],
    });
  });
  const { runtime } = await setup(t, {
    env: {
      AIDEN_IMAGE_REPLICATE_API_TOKEN: "r8_env_image_key",
      AIDEN_IMAGE_FAL_KEY: "fal-env-key-123",
      AIDEN_IMAGE_OPENROUTER_API_KEY: "sk-or-image-key",
    },
    fetch,
  });
  await runtime.ready();
  const generate = async (provider: string, id: string, aspectRatio?: string) => {
    const model = runtime.models.getModelOfType("image", provider, id);
    assert.ok(model, `${provider}/${id} is registered`);
    const before = requests.length;
    const result = await runtime.models.generateImages(
      model,
      { input: [{ type: "text", text: "a fox" }] },
      { fetch, ...(aspectRatio ? { metadata: { aspectRatio } } : {}) },
    );
    assert.equal(result.stopReason, "stop", result.errorMessage);
    const submit = requests.slice(before).find((request) => request.method === "POST")!;
    return submit.body as Record<string, unknown> & { input?: Record<string, unknown> };
  };

  // Replicate: `aspect_ratio` input, only for a ratio the model accepts.
  assert.equal((await generate("replicate", "black-forest-labs/flux-schnell", "16:9")).input?.aspect_ratio, "16:9");
  assert.equal((await generate("replicate", "google/imagen-4-fast", "3:2")).input?.aspect_ratio, undefined);
  assert.equal((await generate("replicate", "qwen/qwen-image-2-pro", "16:9")).input?.aspect_ratio, undefined);
  // fal: `aspect_ratio` for models that take it, the `image_size` preset otherwise.
  const banana = await generate("fal", "fal-ai/nano-banana-pro", "9:16");
  assert.deepEqual([banana.aspect_ratio, banana.image_size], ["9:16", undefined]);
  const schnell = await generate("fal", "fal-ai/flux/schnell", "16:9");
  assert.deepEqual([schnell.aspect_ratio, schnell.image_size], [undefined, "landscape_16_9"]);
  // 3:2 and 2:3 have no preset: FLUX takes a custom size, others keep their default.
  const custom = await generate("fal", "fal-ai/flux/schnell", "3:2");
  assert.deepEqual([custom.aspect_ratio, custom.image_size], [undefined, { width: 1536, height: 1024 }]);
  const portrait = await generate("fal", "fal-ai/flux-2-pro", "2:3");
  assert.deepEqual(portrait.image_size, { width: 1024, height: 1536 });
  const noPreset = await generate("fal", "bytedance/seedream/v5/flash/text-to-image", "3:2");
  assert.deepEqual([noPreset.aspect_ratio, noPreset.image_size], [undefined, undefined]);
  // OpenRouter: `image_config.aspect_ratio` in the chat-completions body.
  const routed = await generate("openrouter", "google/gemini-3.1-flash-image", "4:3");
  assert.deepEqual(routed.image_config, { aspect_ratio: "4:3" });
  assert.equal((await generate("openrouter", "google/gemini-3.1-flash-image")).image_config, undefined);
  // Anything other than a known ratio is never forwarded.
  assert.equal((await generate("replicate", "black-forest-labs/flux-schnell", "21:9")).input?.aspect_ratio, undefined);
});

test("a fetched Replicate model keeps the ratios its schema lists and sends them after a reload", async (t) => {
  const delivery = "https://replicate.delivery/out.png";
  const schema = {
    components: {
      schemas: {
        Input: { properties: { prompt: { type: "string" }, aspect_ratio: { allOf: [{ $ref: "#/components/schemas/aspect_ratio" }] } } },
        aspect_ratio: { type: "string", enum: ["1:1", "16:9", "21:9"] },
      },
    },
  };
  const { fetch, requests } = fakeFetch((request) => {
    if (request.url.includes("/collections/"))
      return json({ models: [{ owner: "acme", name: "painter", latest_version: { id: "a".repeat(64), openapi_schema: schema } }] });
    if (request.url === delivery) return bytes(png(2));
    return json({ id: "p1", status: "succeeded", output: delivery });
  });
  const first = await setup(t, { env: { AIDEN_IMAGE_REPLICATE_API_TOKEN: "r8_env_image_key" }, fetch });
  await first.runtime.fetchModels("replicate");
  await first.runtime.setModelEnabled("replicate", "acme/painter", true);

  // A fresh runtime over the same settings file reads the stored adapter back.
  const runtime = new ImageGenerationRuntime({
    credentials: first.credentials,
    settings: createImageGenerationSettingsStore(() => first.root),
    openRouterModels: bundledOpenRouter,
    authContext: { env: async (name) => (name === "AIDEN_IMAGE_REPLICATE_API_TOKEN" ? "r8_env_image_key" : undefined), fileExists: async () => false },
    pollIntervalMs: 1,
    fetch,
  });
  await runtime.ready();
  const model = runtime.models.getModelOfType("image", "replicate", "acme/painter");
  assert.ok(model);
  const send = async (aspectRatio: string) => {
    const before = requests.length;
    const result = await runtime.models.generateImages(model, { input: [{ type: "text", text: "a fox" }] }, { metadata: { aspectRatio } });
    assert.equal(result.stopReason, "stop", result.errorMessage);
    return (requests.slice(before).find((request) => request.method === "POST")!.body as { input: Record<string, unknown> }).input;
  };
  assert.equal((await send("16:9")).aspect_ratio, "16:9");
  assert.equal((await send("4:3")).aspect_ratio, undefined, "a ratio missing from the schema enum is omitted");
});

test("a Replicate reference field's cardinality comes from the model, curated or fetched", async (t) => {
  const delivery = "https://replicate.delivery/out.png";
  const schema = {
    components: {
      schemas: {
        Input: { properties: { prompt: { type: "string" }, image: { type: "array", items: { type: "string" }, maxItems: 3 } } },
      },
    },
  };
  const { fetch, requests } = fakeFetch((request) => {
    if (request.url.includes("/collections/"))
      return json({ models: [{ owner: "acme", name: "editor", latest_version: { id: "b".repeat(64), openapi_schema: schema } }] });
    if (request.url === delivery) return bytes(png(2));
    return json({ id: "p1", status: "succeeded", output: delivery });
  });
  const env = { AIDEN_IMAGE_REPLICATE_API_TOKEN: "r8_env_image_key" };
  const first = await setup(t, { env, fetch });
  await first.runtime.fetchModels("replicate");
  await first.runtime.setModelEnabled("replicate", "acme/editor", true);

  // A fresh runtime over the same settings file reads the stored adapter back.
  const runtime = new ImageGenerationRuntime({
    credentials: first.credentials,
    settings: createImageGenerationSettingsStore(() => first.root),
    openRouterModels: bundledOpenRouter,
    authContext: { env: async (name) => env[name as keyof typeof env], fileExists: async () => false },
    pollIntervalMs: 1,
    fetch,
  });
  await runtime.ready();
  const reference = { type: "image" as const, mimeType: "image/png", data: Buffer.from(png(5)).toString("base64") };
  const send = async (id: string) => {
    const model = runtime.models.getModelOfType("image", "replicate", id);
    assert.ok(model, id);
    const before = requests.length;
    const result = await runtime.models.generateImages(model, { input: [{ type: "text", text: "edit" }, reference] });
    assert.equal(result.stopReason, "stop", result.errorMessage);
    return { model, input: (requests.slice(before).find((request) => request.method === "POST")!.body as { input: Record<string, unknown> }).input };
  };
  const uri = `data:image/png;base64,${reference.data}`;

  const qwen = await send("qwen/qwen-image-edit-2511");
  assert.deepEqual(qwen.input.image, [uri], "the curated Qwen edit model takes an array");
  assert.ok((qwen.model.inputLimits?.images?.maxPerRequest ?? 0) > 1);

  const fetched = await send("acme/editor");
  assert.deepEqual(fetched.input.image, [uri], "a fetched array schema survives a settings reload");
  assert.equal(fetched.model.inputLimits?.images?.maxPerRequest, 3);

  const kontext = await send("black-forest-labs/flux-kontext-max");
  assert.equal(kontext.input.input_image, uri, "a single-image model still gets one string");
  assert.equal(kontext.model.inputLimits?.images?.maxPerRequest, 1);
});

test("an OpenRouter rejection of the requested aspect ratio reads as a clear error", () => {
  const failed = (errorMessage: string) => ({
    api: "openrouter-images",
    provider: "openrouter",
    model: "some/model",
    output: [],
    stopReason: "error" as const,
    errorMessage,
    timestamp: 1,
  }) as unknown as Parameters<typeof explainAspectRatioRejection>[2];
  const withRatio = { metadata: { aspectRatio: "16:9" } } as Parameters<typeof explainAspectRatioRejection>[1];
  const raw = '400 {"error":{"message":"Invalid image_config.aspect_ratio for this model"}}';
  assert.match(
    explainAspectRatioRejection("openrouter", withRatio, failed(raw)).errorMessage ?? "",
    /doesn't accept the 16:9 aspect ratio\. Try again without an aspect ratio/u,
  );
  // Other errors, other providers and ratio-less requests pass through unchanged.
  assert.equal(explainAspectRatioRejection("openrouter", withRatio, failed("401 bad key")).errorMessage, "401 bad key");
  assert.equal(explainAspectRatioRejection("fal", withRatio, failed(raw)).errorMessage, raw);
  assert.equal(explainAspectRatioRejection("openrouter", undefined, failed(raw)).errorMessage, raw);
});
