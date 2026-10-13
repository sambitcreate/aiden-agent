import assert from "node:assert/strict";
import test from "node:test";
import {
  CatalogFetchError,
  fetchFalImageModels,
  fetchOpenRouterImageModels,
  fetchReplicateImageModels,
  pairFalModels,
  parseOpenRouterImageModels,
  parseReplicateCollection,
  replicateAspectRatios,
  replicateReferenceField,
} from "./catalog-fetch.js";
import { normalizeImageGenerationSettings } from "./settings-store.js";
import { fakeFetch, json } from "./test-support.js";

const openRouterFixture = {
  data: [
    {
      id: "google/gemini-nano-banana-2.1",
      name: "Google: Nano Banana 2.1",
      architecture: { input_modalities: ["image", "text"], output_modalities: ["image", "text"] },
    },
    {
      id: "black-forest-labs/flux.2-pro",
      name: "Black Forest Labs: FLUX.2 Pro",
      architecture: { input_modalities: ["text"], output_modalities: ["image"] },
    },
    { id: "openrouter/auto", name: "Auto", architecture: { input_modalities: ["text"], output_modalities: ["image"] } },
    { id: "openai/gpt-6", name: "GPT-6", architecture: { input_modalities: ["text"], output_modalities: ["text"] } },
    { id: "no slash", name: "Bad", architecture: { output_modalities: ["image"] } },
    { id: "black-forest-labs/flux.2-pro", name: "Duplicate", architecture: { output_modalities: ["image"] } },
  ],
};

test("OpenRouter's list keeps image-output models with their reference support", () => {
  const models = parseOpenRouterImageModels(openRouterFixture);
  assert.deepEqual(
    models.map((model) => [model.id, model.name, model.acceptsReferenceImages, model.maker, model.adapter]),
    [
      ["google/gemini-nano-banana-2.1", "Nano Banana 2.1", true, "google", { kind: "openrouter", textOutput: true }],
      [
        "black-forest-labs/flux.2-pro",
        "FLUX.2 Pro",
        false,
        "black-forest-labs",
        { kind: "openrouter", textOutput: false },
      ],
    ],
  );
  assert.throws(() => parseOpenRouterImageModels({ models: [] }), CatalogFetchError);
});

test("the OpenRouter fetch uses the fixed URL, no credentials and no redirects", async () => {
  const inits: RequestInit[] = [];
  const { fetch, requests } = fakeFetch((_request, init) => {
    inits.push(init);
    return json(openRouterFixture);
  });
  const models = await fetchOpenRouterImageModels(fetch);
  assert.equal(models.length, 2);
  assert.equal(requests[0]!.url, "https://openrouter.ai/api/v1/models?output_modalities=image");
  assert.equal(requests[0]!.headers.authorization, undefined);
  assert.equal(inits[0]!.redirect, "error");
});

test("oversized, malformed and redirected catalogs fail with typed errors", async () => {
  const oversized = fakeFetch(
    () => new Response("{}", { status: 200, headers: { "content-length": String(5 * 1024 * 1024) } }),
  );
  await assert.rejects(fetchOpenRouterImageModels(oversized.fetch), (error: unknown) => {
    assert.ok(error instanceof CatalogFetchError);
    assert.equal(error.code, "invalid_catalog");
    assert.match(error.message, /oversized/u);
    return true;
  });

  const streamedTooLarge = fakeFetch(() => new Response(`{"data":[${'"x",'.repeat(1_200_000)}"x"]}`));
  await assert.rejects(fetchOpenRouterImageModels(streamedTooLarge.fetch), /oversized/u);

  const malformed = fakeFetch(() => new Response("<html>nope</html>"));
  await assert.rejects(fetchOpenRouterImageModels(malformed.fetch), (error: unknown) =>
    error instanceof CatalogFetchError && error.code === "invalid_catalog",
  );

  const redirected = fakeFetch(() => {
    throw new TypeError("fetch failed: unexpected redirect");
  });
  await assert.rejects(fetchOpenRouterImageModels(redirected.fetch), (error: unknown) =>
    error instanceof CatalogFetchError && error.code === "network_error",
  );
});

test("fal pages are followed by cursor and capped, and edit siblings are paired", async () => {
  const pages: Record<string, unknown> = {
    "text-to-image|": {
      models: [
        { endpoint_id: "google/nano-banana-2.1", metadata: { display_name: "Nano Banana 2.1", status: "active", group: { key: "nb21", label: "Text to Image" } } },
        { endpoint_id: "fal-ai/flux/schnell", metadata: { display_name: "FLUX.1 [schnell]", status: "active" } },
      ],
      has_more: true,
      next_cursor: "Mg",
    },
    "text-to-image|Mg": {
      models: [
        { endpoint_id: "bytedance/seedream/v5/pro/text-to-image", metadata: { display_name: "Seedream 5 Pro", status: "active" } },
        { endpoint_id: "retired/model", metadata: { display_name: "Old", status: "deprecated" } },
        { endpoint_id: "../escape", metadata: { display_name: "Bad" } },
      ],
      has_more: false,
      next_cursor: null,
    },
    "image-to-image|": {
      models: [
        { endpoint_id: "google/nano-banana-2.1/edit", metadata: { display_name: "Edit", status: "active", group: { key: "nb21", label: "Edit" } } },
        { endpoint_id: "bytedance/seedream/v5/pro/edit", metadata: { display_name: "Edit", status: "active" } },
      ],
      has_more: false,
    },
  };
  const { fetch, requests } = fakeFetch((request) => {
    const url = new URL(request.url);
    return json(pages[`${url.searchParams.get("category")}|${url.searchParams.get("cursor") ?? ""}`] ?? { models: [] });
  });

  const models = await fetchFalImageModels(fetch, "fal-key-12345");

  assert.deepEqual(
    models.map((model) => [model.id, model.adapter.kind === "fal" ? model.adapter.editEndpoint : null]),
    [
      ["google/nano-banana-2.1", "google/nano-banana-2.1/edit"],
      ["fal-ai/flux/schnell", undefined],
      ["bytedance/seedream/v5/pro/text-to-image", "bytedance/seedream/v5/pro/edit"],
    ],
  );
  assert.ok(requests.every((request) => request.url.startsWith("https://api.fal.ai/v1/models?")));
  assert.ok(requests.every((request) => request.headers.authorization === "Key fal-key-12345"));

  let page = 0;
  const endless = fakeFetch(() => json({ models: [], has_more: true, next_cursor: `c${(page += 1)}` }));
  await fetchFalImageModels(endless.fetch, undefined);
  assert.equal(endless.requests.length, 10, "five pages per category");
  assert.ok(endless.requests.every((request) => request.headers.authorization === undefined));
});

test("fal group pairing stays inside one namespace", () => {
  const paired = pairFalModels(
    [{ endpoint: "acme/painter", name: "Painter", group: "shared", groupLabel: "Text to Image" }],
    [{ endpoint: "other/painter-edit", name: "Edit", group: "shared", groupLabel: "Edit" }],
  );
  assert.equal(paired[0]!.acceptsReferenceImages, false);
});

test("Replicate's reference field comes from the OpenAPI input schema", () => {
  const schema = (properties: Record<string, unknown>) => ({ components: { schemas: { Input: { properties } } } });
  assert.deepEqual(replicateReferenceField(schema({ prompt: {}, image_input: { type: "array", maxItems: 14 } })), {
    field: "image_input",
    mode: "array",
    max: 14,
  });
  assert.deepEqual(replicateReferenceField(schema({ prompt: {}, input_image: { type: "string" } })), {
    field: "input_image",
    mode: "single",
    max: 1,
  });
  // The property's type decides the shape, not the field's name.
  assert.deepEqual(replicateReferenceField(schema({ prompt: {}, image: { type: "array" } })), {
    field: "image",
    mode: "array",
    max: 4,
  });
  assert.deepEqual(
    replicateReferenceField({
      components: {
        schemas: {
          Input: { properties: { image: { allOf: [{ $ref: "#/components/schemas/images" }] } } },
          images: { type: "array", maxItems: 3 },
        },
      },
    }),
    { field: "image", mode: "array", max: 3 },
  );
  assert.equal(replicateReferenceField(schema({ prompt: {}, mask: { type: "string" } })), undefined);
  assert.equal(replicateReferenceField(undefined), undefined);
});

test("Replicate's aspect ratios are the schema enum's values Aiden can request", () => {
  const schema = (aspect: unknown, extra: Record<string, unknown> = {}) => ({
    components: { schemas: { Input: { properties: { prompt: {}, aspect_ratio: aspect } }, ...extra } },
  });
  assert.deepEqual(replicateAspectRatios(schema({ type: "string", enum: ["21:9", "16:9", "1:1", "custom"] })), ["1:1", "16:9"]);
  assert.deepEqual(
    replicateAspectRatios(
      schema({ allOf: [{ $ref: "#/components/schemas/aspect_ratio" }] }, { aspect_ratio: { enum: ["9:16", "match_input_image"] } }),
    ),
    ["9:16"],
  );
  assert.equal(replicateAspectRatios(schema({ type: "string" })), undefined, "free text is not a known set");
  assert.equal(replicateAspectRatios(schema({ enum: ["21:9", "custom"] })), undefined);
  assert.equal(replicateAspectRatios(schema({ $ref: "#/components/schemas/missing" })), undefined);
  assert.equal(replicateAspectRatios(undefined), undefined);
});

test("the Replicate collection needs a key and parses owner/name models", async () => {
  const unauthenticated = fakeFetch(() => json({}));
  await assert.rejects(fetchReplicateImageModels(unauthenticated.fetch, undefined), (error: unknown) =>
    error instanceof CatalogFetchError && error.code === "key_required",
  );
  assert.equal(unauthenticated.requests.length, 0);

  const { fetch, requests } = fakeFetch(() =>
    json({
      models: [
        {
          owner: "black-forest-labs",
          name: "flux-2-pro",
          latest_version: {
            openapi_schema: {
              components: { schemas: { Input: { properties: { input_images: { type: "array", maxItems: 8 } } } } },
            },
          },
        },
        { owner: "ideogram-ai", name: "ideogram-v4-turbo", latest_version: null },
        { owner: "bad owner", name: "x" },
      ],
    }),
  );
  const models = await fetchReplicateImageModels(fetch, "r8_key_value");
  assert.equal(requests[0]!.url, "https://api.replicate.com/v1/collections/text-to-image");
  assert.equal(requests[0]!.headers.authorization, "Bearer r8_key_value");
  assert.deepEqual(
    models.map((model) => [model.id, model.name, model.maker, model.acceptsReferenceImages]),
    [
      ["black-forest-labs/flux-2-pro", "Flux 2 Pro", "black-forest-labs", true],
      ["ideogram-ai/ideogram-v4-turbo", "Ideogram V4 Turbo", "ideogram", false],
    ],
  );

  const rejected = fakeFetch(() => json({ detail: "Unauthenticated" }, 401));
  await assert.rejects(fetchReplicateImageModels(rejected.fetch, "r8_key_value"), (error: unknown) =>
    error instanceof CatalogFetchError && error.code === "rejected_key",
  );
});

test("Replicate collection entries keep the latest version and skip ids over the stored limit", () => {
  const version = "a".repeat(64);
  const models = parseReplicateCollection({
    models: [
      { owner: "someone", name: "community-art", latest_version: { id: version } },
      { owner: "o".repeat(100), name: "n".repeat(100), latest_version: { id: version } },
      { owner: "someone", name: "odd-version", latest_version: { id: "not a version!" } },
    ],
  });
  assert.deepEqual(
    models.map((model) => [model.id, model.adapter]),
    [
      ["someone/community-art", { kind: "replicate", version }],
      ["someone/odd-version", { kind: "replicate" }],
    ],
  );
  // Every parsed entry is storable as a fetched list.
  assert.doesNotThrow(() =>
    normalizeImageGenerationSettings({ version: 1, fetched: { replicate: { fetchedAt: 1, models } } }),
  );
});

test("a catalog fetch that runs past its deadline fails with a timed-out message", async () => {
  const { fetch } = fakeFetch(
    (_request, init) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      }),
  );
  // AbortSignal.timeout does not hold the event loop open by itself.
  const keepAlive = setTimeout(() => undefined, 5_000);
  try {
    await assert.rejects(fetchOpenRouterImageModels(fetch, AbortSignal.timeout(20)), (error: unknown) =>
      error instanceof CatalogFetchError &&
      error.code === "network_error" &&
      /took too long/u.test(error.message),
    );
    const controller = new AbortController();
    const cancelled = fetchOpenRouterImageModels(fetch, controller.signal);
    controller.abort();
    await assert.rejects(cancelled, /cancelled/u);
  } finally {
    clearTimeout(keepAlive);
  }
});
