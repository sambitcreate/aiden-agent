import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  CURATED_FAL_IMAGE_MODELS,
  CURATED_REPLICATE_IMAGE_MODELS,
} from "../../../renderer/shared/image-generation/catalog.js";
import {
  createImageGenerationSettingsStore,
  defaultImageGenerationSettings,
  IMAGE_GENERATION_SETTINGS_FILE,
  normalizeImageGenerationSettings,
  parseImageCatalogEntry,
} from "./settings-store.js";

async function tempRoot(t: test.TestContext): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-image-settings-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

const fetchedEntry = {
  provider: "fal",
  id: "fal-ai/flux/schnell",
  name: "FLUX Schnell",
  maker: "black-forest-labs",
  acceptsReferenceImages: false,
  adapter: { kind: "fal", textEndpoint: "fal-ai/flux/schnell" },
};

test("a missing file reads as defaults and a saved document round-trips with mode 0600", async (t) => {
  const root = await tempRoot(t);
  const store = createImageGenerationSettingsStore(() => root);
  assert.deepEqual(await store.read(), defaultImageGenerationSettings());

  await store.update((draft) => {
    draft.defaultModel = { provider: "fal", id: "fal-ai/flux/schnell" };
    draft.enabled.fal = { "fal-ai/flux/schnell": false };
    draft.fetched.fal = { fetchedAt: 1_760_000_000_000, models: [structuredClone(fetchedEntry)] as never };
  });

  const reopened = createImageGenerationSettingsStore(() => root);
  const settings = await reopened.read();
  assert.deepEqual(settings.defaultModel, { provider: "fal", id: "fal-ai/flux/schnell" });
  assert.equal(settings.enabled.fal?.["fal-ai/flux/schnell"], false);
  assert.equal(settings.fetched.fal?.models[0]?.id, "fal-ai/flux/schnell");
  const stat = await fs.stat(path.join(root, IMAGE_GENERATION_SETTINGS_FILE));
  assert.equal(stat.mode & 0o777, 0o600);
});

test("a mutation that would write an invalid document is refused and nothing changes", async (t) => {
  const root = await tempRoot(t);
  const store = createImageGenerationSettingsStore(() => root);
  await assert.rejects(
    store.update((draft) => {
      draft.defaultModel = { provider: "replicate", id: "not a model id" };
    }),
    /invalid/u,
  );
  assert.equal((await store.read()).defaultModel, null);
});

test("a corrupt or tampered file resets to defaults and is reported", async (t) => {
  for (const contents of [
    "{not json",
    JSON.stringify({ version: 2 }),
    JSON.stringify({ version: 1, custom: { anthropic: [] } }),
    JSON.stringify({ version: 1, fetched: { fal: { fetchedAt: 1, models: [{ ...fetchedEntry, adapter: { kind: "replicate" } }] } } }),
  ]) {
    const root = await tempRoot(t);
    await fs.writeFile(path.join(root, IMAGE_GENERATION_SETTINGS_FILE), contents);
    const store = createImageGenerationSettingsStore(() => root);
    assert.deepEqual(await store.read(), defaultImageGenerationSettings(), contents);
    assert.equal(await store.loadedFromCorruptFile(), true, contents);
  }
});

test("validation enforces per-provider id shapes, adapter fields and size bounds", () => {
  const valid = (document: unknown) => normalizeImageGenerationSettings(document);
  assert.throws(() => valid({ version: 1, enabled: { replicate: { "owner/name/extra": true } } }));
  assert.throws(() => valid({ version: 1, enabled: { openrouter: { "vendor/model": "yes" } } }));
  assert.throws(() =>
    valid({
      version: 1,
      custom: {
        replicate: [
          { provider: "replicate", id: "a/b", name: "A", acceptsReferenceImages: true, adapter: { kind: "replicate", referenceField: "mask" } },
        ],
      },
    }),
  );
  assert.throws(() =>
    valid({ version: 1, custom: { fal: Array.from({ length: 51 }, (_, index) => ({ ...fetchedEntry, id: `a/m${index}`, adapter: { kind: "fal", textEndpoint: `a/m${index}` } })) } }),
  );
  // A reference mode is only "array" or "single", and only alongside a reference field.
  const replicateEntry = (adapter: Record<string, unknown>) => ({
    version: 1,
    custom: { replicate: [{ provider: "replicate", id: "a/b", name: "A", acceptsReferenceImages: true, adapter }] },
  });
  assert.throws(() => valid(replicateEntry({ kind: "replicate", referenceField: "image", referenceMode: "many" })));
  assert.throws(() => valid(replicateEntry({ kind: "replicate", referenceMode: "array" })));
  const arrayMode = valid(replicateEntry({ kind: "replicate", referenceField: "image", referenceMode: "array" }));
  assert.deepEqual(arrayMode.custom.replicate?.[0]?.adapter, {
    kind: "replicate",
    referenceField: "image",
    referenceMode: "array",
  });
  // Reference support is derived from the adapter, never trusted from the file.
  const derived = valid({
    version: 1,
    custom: {
      replicate: [
        { provider: "replicate", id: "a/b", name: "A", acceptsReferenceImages: true, adapter: { kind: "replicate" } },
      ],
    },
  });
  assert.equal(derived.custom.replicate?.[0]?.acceptsReferenceImages, false);
});

test("every bundled curated entry passes the stored-entry validator unchanged", () => {
  for (const entry of [...CURATED_REPLICATE_IMAGE_MODELS, ...CURATED_FAL_IMAGE_MODELS]) {
    assert.deepEqual(parseImageCatalogEntry(entry.provider, structuredClone(entry)), entry, entry.id);
  }
});
