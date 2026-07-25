// Routing tests for the split config store: every configStore method must land
// in the right file, and seeding must run the two migrations in the right order.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { createConfigStore, type SecretsPort } from "./config-store-core.js";
import {
  LOCAL_CONFIG_FILENAME,
  PORTABLE_CONFIG_FILENAME,
  PROVIDER_MODEL_CACHE_FILENAME,
  SETTINGS_FILENAME,
  createPortableConfigStores,
} from "./portable-config-core.js";
import type { StoredProvider, Workspace } from "./types.js";

function fakeSecrets(initial: Record<string, string> = {}) {
  const keys = { ...initial };
  const port: SecretsPort = {
    async hasKey(id) {
      return Boolean(keys[id]);
    },
    async deleteKey(id) {
      delete keys[id];
    },
    async migrateKeys(migrate) {
      migrate(keys);
    },
  };
  return { port, keys };
}

async function harness(t: test.TestContext, legacy?: unknown) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-config-store-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const portableRoot = path.join(base, "dot-aiden");
  const localRoot = path.join(base, "userData");
  await fs.mkdir(localRoot, { recursive: true });
  if (legacy !== undefined) {
    await fs.writeFile(
      path.join(localRoot, LOCAL_CONFIG_FILENAME),
      JSON.stringify(legacy, null, 2),
      "utf-8",
    );
  }
  const stores = createPortableConfigStores(
    () => portableRoot,
    () => localRoot,
  );
  const secrets = fakeSecrets();
  return {
    store: createConfigStore(stores, secrets.port),
    stores,
    secrets,
    portableFile: path.join(portableRoot, PORTABLE_CONFIG_FILENAME),
    localFile: path.join(localRoot, LOCAL_CONFIG_FILENAME),
    settingsFile: path.join(localRoot, SETTINGS_FILENAME),
    cacheFile: path.join(localRoot, PROVIDER_MODEL_CACHE_FILENAME),
  };
}

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await fs.readFile(file, "utf-8")) as T;
}

// Already in the Aiden-reserved namespace, so the Pi migration leaves it alone.
const provider: StoredProvider = {
  id: "custom:lmstudio",
  kind: "openai",
  label: "LM Studio",
  baseUrl: "http://localhost:1234/v1",
  models: ["qwen3-8b"],
  modelMetadata: { "qwen3-8b": { source: "lmstudio" } },
  needsKey: false,
  deployment: "local",
};

// ── Provider routing ─────────────────────────────────────────────────────────

test("a saved provider splits across the portable file and the local cache", async (t) => {
  const h = await harness(t);
  const saved = await h.store.saveProvider(provider);

  assert.equal(saved.id, provider.id);
  assert.deepEqual(saved.models, provider.models, "the caller still sees one whole provider");

  const portable = await readJson<{ providers: Record<string, unknown>[] }>(h.portableFile);
  assert.equal("models" in portable.providers[0], false);
  assert.equal("modelMetadata" in portable.providers[0], false);
  assert.equal(portable.providers[0].baseUrl, provider.baseUrl);

  const cache = await readJson<{ byProvider: Record<string, unknown> }>(h.cacheFile);
  assert.deepEqual(cache.byProvider[provider.id], {
    models: provider.models,
    modelMetadata: provider.modelMetadata,
  });
});

test("listProviders recombines intent with this machine's cache", async (t) => {
  const h = await harness(t);
  await h.store.saveProvider(provider);

  const [listed] = await h.store.listProviders();
  assert.deepEqual(listed.models, provider.models);
  assert.deepEqual(listed.modelMetadata, provider.modelMetadata);
  assert.equal(listed.hasKey, false);
});

test("getProvider recombines intent with this machine's cache", async (t) => {
  const h = await harness(t);
  await h.store.saveProvider(provider);

  assert.deepEqual(await h.store.getProvider(provider.id), provider);
  assert.equal(await h.store.getProvider("nope"), undefined);
});

// A provider carried to a new machine has intent but no cache and no key. It must
// still list, with an empty model list, rather than break the picker.
test("a provider with no local cache lists with an empty model list", async (t) => {
  const h = await harness(t);
  await h.store.saveProvider(provider);
  await h.stores.modelCache.save({ byProvider: {} });

  const [listed] = await h.store.listProviders();
  assert.deepEqual(listed.models, []);
  assert.equal(listed.baseUrl, provider.baseUrl);
  assert.equal(listed.hasKey, false);
});

test("an upsert that omits modelMetadata keeps what is already cached", async (t) => {
  const h = await harness(t);
  await h.store.saveProvider(provider);
  const { modelMetadata: _dropped, ...withoutMetadata } = provider;

  const saved = await h.store.saveProvider({ ...withoutMetadata, label: "Renamed" });
  assert.equal(saved.label, "Renamed");
  assert.deepEqual(saved.modelMetadata, provider.modelMetadata, "cache is retained, not blanked");
});

test("removing a provider clears its cache entry and its key", async (t) => {
  const h = await harness(t);
  await h.store.saveProvider(provider);
  h.secrets.keys[provider.id] = "ciphertext";

  await h.store.removeProvider(provider.id);

  assert.deepEqual(await h.store.listProviders(), []);
  const cache = await readJson<{ byProvider: Record<string, unknown> }>(h.cacheFile);
  assert.deepEqual(cache.byProvider, {}, "no orphan cache under an ID nothing references");
  assert.equal(h.secrets.keys[provider.id], undefined);
});

// ── Store placement ──────────────────────────────────────────────────────────

test("MCP servers and skills are portable; workspaces and settings are not", async (t) => {
  const h = await harness(t);
  await h.store.saveMcpServer({
    id: "fs",
    name: "Filesystem",
    transport: "stdio",
    command: "mcp-fs",
    enabled: true,
  });
  await h.store.saveSkill({
    id: "s1",
    name: "Summarize",
    description: "d",
    instructions: "i",
    enabled: true,
  });
  const workspace: Workspace = {
    id: "w1",
    name: "Thing",
    permission: "ask",
    folderPath: "/Users/someone/projects/thing",
    createdAt: 1,
    updatedAt: 1,
  };
  await h.store.saveWorkspace(workspace);
  await h.store.setSettings({ exaEnabled: true });

  const portableRaw = await fs.readFile(h.portableFile, "utf-8");
  assert.match(portableRaw, /mcp-fs/);
  assert.match(portableRaw, /Summarize/);
  assert.equal(portableRaw.includes("/Users/someone/projects/thing"), false);
  assert.equal(portableRaw.includes("exaEnabled"), false);

  const local = await readJson<{ workspaces: Workspace[] }>(h.localFile);
  assert.equal(
    local.workspaces.some((w) => w.id === "w1"),
    true,
  );
  assert.deepEqual((await readJson<{ settings: unknown }>(h.settingsFile)).settings, {
    exaEnabled: true,
  });
});

test("reads and writes survive a restart of the whole store", async (t) => {
  const h = await harness(t);
  await h.store.saveProvider(provider);
  await h.store.setSettings({ exaEnabled: true });

  // A second bundle over the same directories stands in for the next launch.
  const next = createConfigStore(
    createPortableConfigStores(
      () => path.dirname(h.portableFile),
      () => path.dirname(h.localFile),
    ),
    fakeSecrets().port,
  );

  // Seeding stamps isPreset/isBuiltin false on every retained provider, so
  // compare the fields the round trip is actually about.
  assert.deepEqual(await next.getProvider(provider.id), {
    ...provider,
    isPreset: false,
    isBuiltin: false,
  });
  assert.deepEqual(await next.getSettings(), { exaEnabled: true });
});

test("every install ends up with at least one workspace", async (t) => {
  const h = await harness(t);
  const workspaces = await h.store.listWorkspaces();
  assert.equal(workspaces.length, 1);

  await h.store.removeWorkspace(workspaces[0].id);
  assert.equal((await h.store.listWorkspaces()).length, 1, "the app is never workspace-less");
});

// ── Seeding order ────────────────────────────────────────────────────────────

/**
 * A legacy seeded preset, byte-for-byte as the Pi migration expects to find it —
 * the model list and default must match LEGACY_PRESET_MODELS/DEFAULT_MODELS in
 * provider-config-migration-core.ts or it reads as user-edited.
 */
const untouchedPreset: StoredProvider = {
  id: "openai",
  kind: "openai",
  label: "OpenAI",
  baseUrl: "https://api.openai.com/v1",
  models: ["gpt-4o", "gpt-4o-mini", "gpt-4.1", "o3-mini"],
  defaultModel: "gpt-4o",
  needsKey: true,
  deployment: "hosted",
  isPreset: true,
};

// The ordering bug this pins: the ~/.aiden migration strips models into the cache
// before the Pi migration runs, and isUntouchedPiPreset compares models. If the
// composite it sees were built from an empty cache, this preset would look edited
// and survive as a custom connection.
test("an untouched legacy preset is still retired when seeding follows the split", async (t) => {
  const h = await harness(t, {
    providers: [untouchedPreset],
    settings: { lastProviderId: "openai" },
    seeded: true,
  });

  const listed = await h.store.listProviders();
  assert.deepEqual(
    listed.map((p) => p.id),
    [],
    "the preset is Pi-owned now and must not be retained",
  );
});

test("an edited legacy preset is retained under a reserved ID with its cache re-homed", async (t) => {
  const h = await harness(t, {
    providers: [{ ...untouchedPreset, baseUrl: "https://proxy.internal/v1" }],
    settings: { lastProviderId: "openai" },
    seeded: true,
  });

  const [listed] = await h.store.listProviders();
  assert.notEqual(listed.id, "openai", "it gets an Aiden-reserved ID");
  assert.deepEqual(listed.models, untouchedPreset.models, "its cache follows the new ID");
  assert.deepEqual(listed.legacyIds, ["openai"]);
  assert.equal(
    (await h.store.getSettings()).lastProviderId,
    listed.id,
    "the remembered provider is remapped even though settings moved stores",
  );
});

test("provider keys are re-homed onto the reserved ID during seeding", async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-config-keys-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const localRoot = path.join(base, "userData");
  await fs.mkdir(localRoot, { recursive: true });
  await fs.writeFile(
    path.join(localRoot, LOCAL_CONFIG_FILENAME),
    JSON.stringify({
      providers: [{ ...untouchedPreset, baseUrl: "https://proxy.internal/v1" }],
      settings: {},
      seeded: true,
    }),
    "utf-8",
  );
  const secrets = fakeSecrets({ openai: "ciphertext" });
  const store = createConfigStore(
    createPortableConfigStores(
      () => path.join(base, "dot-aiden"),
      () => localRoot,
    ),
    secrets.port,
  );

  const [listed] = await store.listProviders();
  assert.equal(secrets.keys.openai, undefined, "the key does not stay under the retired ID");
  assert.equal(secrets.keys[listed.id], "ciphertext");
  assert.equal(listed.hasKey, true);
});

test("seeding runs once even under concurrent first reads", async (t) => {
  const h = await harness(t, { providers: [], settings: {}, seeded: true });
  const [providers, skills, servers, settings] = await Promise.all([
    h.store.listProviders(),
    h.store.listSkills(),
    h.store.listMcpServers(),
    h.store.getSettings(),
  ]);

  assert.deepEqual(providers, []);
  assert.deepEqual(skills, []);
  assert.deepEqual(servers, []);
  assert.deepEqual(settings, {});
  const local = await readJson<{ aidenDirMigratedAt: number }>(h.localFile);
  assert.equal(typeof local.aidenDirMigratedAt, "number");
});

test("a first-ever launch clears providers and records that it seeded", async (t) => {
  const h = await harness(t);
  assert.deepEqual(await h.store.listProviders(), []);

  const local = await readJson<{ seeded: boolean }>(h.localFile);
  assert.equal(local.seeded, true);
});

test("setSettings remaps a legacy lastProviderId through the portable aliases", async (t) => {
  const h = await harness(t, {
    providers: [{ ...untouchedPreset, baseUrl: "https://proxy.internal/v1" }],
    settings: {},
    seeded: true,
  });
  const [listed] = await h.store.listProviders();

  const settings = await h.store.setSettings({ lastProviderId: "openai" });
  assert.equal(settings.lastProviderId, listed.id);
});

test("resolveProviderId reads the aliases from the portable file", async (t) => {
  const h = await harness(t, {
    providers: [],
    providerIdAliases: { ancient: "custom-ancient" },
    settings: {},
    seeded: true,
  });

  assert.equal(await h.store.resolveProviderId("ancient"), "custom-ancient");
  assert.equal(await h.store.resolveProviderId(undefined), undefined);
});

// ── Hand-edited file safety ──────────────────────────────────────────────────

// The regression: ensureSeeded used to write the portable file unconditionally,
// so a JSON typo was replaced with empty defaults by merely launching the app —
// no user action required. Migration alone was not enough to cover this.
test("launching the app does not destroy a portable file with a JSON typo", async (t) => {
  const h = await harness(t);
  await fs.mkdir(path.dirname(h.portableFile), { recursive: true });
  const handWritten = '{\n  "providers": [{ "id": "custom:mine" }],  <-- typo\n}';
  await fs.writeFile(h.portableFile, handWritten, "utf-8");

  await h.store.listSkills();

  assert.equal(await fs.readFile(h.portableFile, "utf-8"), handWritten);
});

test("a write after a JSON typo preserves the broken file beside itself", async (t) => {
  const h = await harness(t);
  await fs.mkdir(path.dirname(h.portableFile), { recursive: true });
  const handWritten = '{ "providers": [broken] }';
  await fs.writeFile(h.portableFile, handWritten, "utf-8");

  // The user gives up on the typo and adds a skill from the UI instead.
  await h.store.saveSkill({
    id: "s1",
    name: "S",
    description: "d",
    instructions: "i",
    enabled: true,
  });

  const dir = path.dirname(h.portableFile);
  const preserved = (await fs.readdir(dir)).filter((n) => n.includes(".invalid-"));
  assert.equal(preserved.length, 1, "exactly one rescue copy");
  assert.equal(await fs.readFile(path.join(dir, preserved[0]), "utf-8"), handWritten);
  // The live file is now valid and holds the new skill.
  assert.deepEqual(
    (await h.store.listSkills()).map((s) => s.id),
    ["s1"],
  );
});

test("a healthy file is never shadowed by a rescue copy", async (t) => {
  const h = await harness(t);
  await h.store.saveSkill({
    id: "s1",
    name: "S",
    description: "d",
    instructions: "i",
    enabled: true,
  });
  await h.store.saveSkill({
    id: "s2",
    name: "T",
    description: "d",
    instructions: "i",
    enabled: true,
  });

  const entries = await fs.readdir(path.dirname(h.portableFile));
  assert.deepEqual(
    entries.filter((n) => n.includes(".invalid-")),
    [],
  );
});

// An unchanged portable file must not be rewritten on launch: doing so reorders a
// hand-maintained file's keys and drops anything Aiden does not model. The first
// launch after a provider is added does legitimately normalize it (the Pi
// migration stamps isPreset/isBuiltin), so the invariant is that it settles.
test("a launch that changes nothing leaves the portable file byte-identical", async (t) => {
  const h = await harness(t);
  await h.store.saveProvider(provider);

  function relaunch() {
    return createConfigStore(
      createPortableConfigStores(
        () => path.dirname(h.portableFile),
        () => path.dirname(h.localFile),
      ),
      fakeSecrets().port,
    );
  }

  await relaunch().listProviders(); // settles the normalization
  const settled = await fs.readFile(h.portableFile, "utf-8");
  const settledStat = await fs.stat(h.portableFile);

  await relaunch().listProviders();
  assert.equal(await fs.readFile(h.portableFile, "utf-8"), settled);
  assert.equal((await fs.stat(h.portableFile)).mtimeMs, settledStat.mtimeMs, "not even rewritten");

  await relaunch().listProviders();
  assert.equal((await fs.stat(h.portableFile)).mtimeMs, settledStat.mtimeMs, "still stable");
});

test("a failed seed does not latch, so the next call retries", async (t) => {
  const h = await harness(t);
  let calls = 0;
  const flaky: SecretsPort = {
    async hasKey() {
      return false;
    },
    async deleteKey() {},
    async migrateKeys() {
      calls += 1;
      if (calls === 1) throw new Error("keychain locked");
    },
  };
  const store = createConfigStore(h.stores, flaky);

  await assert.rejects(() => store.listSkills(), /keychain locked/);
  assert.deepEqual(await store.listSkills(), [], "a retry gets through");
  assert.equal(calls, 2);
});
