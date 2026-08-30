// Routing tests for the split config store: every configStore method must land
// in the right file, and seeding must run the two migrations in the right order.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { createConfigStore, type SecretsPort } from "./config-store-core.js";
import {
  LEGACY_CONFIG_ARCHIVE_SUFFIX,
  LOCAL_CONFIG_FILENAME,
  PORTABLE_CONFIG_FILENAME,
  PROVIDER_MODEL_CACHE_FILENAME,
  SETTINGS_FILENAME,
  createPortableConfigStores,
  isProviderAliasMap,
  splitStoredProvider,
} from "./portable-config-core.js";
import type { AssistantConfig, StoredProvider, Workspace } from "./types.js";

function fakeSecrets(initial: Record<string, unknown> = {}) {
  const keys = { ...initial };
  let migrateCalls = 0;
  const bindingId = (id: string) => `__test_binding__:${id}`;
  const port: SecretsPort = {
    async hasKey(id) {
      return Boolean(keys[id]);
    },
    async getProviderKey(id, binding) {
      return keys[bindingId(id)] === binding && typeof keys[id] === "string"
        ? (keys[id] as string)
        : null;
    },
    async deleteKey(id) {
      delete keys[id];
      delete keys[bindingId(id)];
    },
    async migrateKeys(migrate) {
      migrateCalls += 1;
      migrate(keys);
    },
    async migrateProviderKeysWithBindings(migrations) {
      const byTarget = new Map<string, { binding: string; sources: string[] }>();
      for (const migration of migrations) {
        const target = byTarget.get(migration.providerId);
        if (target && target.binding !== migration.binding) return false;
        if (target) target.sources.push(migration.legacyProviderId);
        else {
          byTarget.set(migration.providerId, {
            binding: migration.binding,
            sources: [migration.legacyProviderId],
          });
        }
      }
      const pending: Array<{ source: string; id: string; binding: string }> = [];
      for (const [id, target] of byTarget) {
        const present = target.sources.filter((source) =>
          Object.prototype.hasOwnProperty.call(keys, source),
        );
        if (present.length > 1) return false;
        if (present.length === 1) {
          if (
            typeof keys[present[0]] !== "string" ||
            Object.prototype.hasOwnProperty.call(keys, id) ||
            Object.prototype.hasOwnProperty.call(keys, bindingId(id))
          ) {
            return false;
          }
          pending.push({ source: present[0], id, binding: target.binding });
          continue;
        }
        const hasKey = Object.prototype.hasOwnProperty.call(keys, id);
        const hasBinding = Object.prototype.hasOwnProperty.call(keys, bindingId(id));
        if (!hasKey && !hasBinding) continue;
        if (typeof keys[id] !== "string" || keys[bindingId(id)] !== target.binding) return false;
      }
      for (const migration of pending) {
        keys[migration.id] = keys[migration.source];
        keys[bindingId(migration.id)] = migration.binding;
        delete keys[migration.source];
      }
      return true;
    },
  };
  return {
    port,
    keys,
    get migrateCalls() {
      return migrateCalls;
    },
  };
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

const assistantConfig: AssistantConfig = {
  enabled: false,
  hotkeyEnabled: true,
  hotkeyAccelerator: "Command+Shift+J",
  watchUncommitted: true,
  watchUntouchedProjects: true,
  watchConfigChanges: true,
  pollIntervalMinutes: 30,
  untouchedThresholdDays: 14,
  quietHoursEnabled: false,
  quietHoursStart: "22:00",
  quietHoursEnd: "08:00",
  maxNudgesPerDay: 5,
  urgencyThreshold: 7,
  settingsPermission: "ask",
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
  assert.equal(await h.store.providerLegacyCredentialMigrationReady(), true);
  assert.equal(h.secrets.migrateCalls, 1);
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

test("model visibility updates are atomic and provider-scoped", async (t) => {
  const h = await harness(t);
  await Promise.all([
    h.store.setModelVisibility("google", "gemini-pro", true),
    h.store.setModelVisibility("anthropic", "claude-sonnet", true),
    h.store.setModelVisibility("google", "gemini-flash", true),
  ]);

  assert.deepEqual((await h.store.getSettings()).hiddenModelsByProvider, {
    anthropic: { defaultVisibility: "shown", exceptions: ["claude-sonnet"] },
    google: { defaultVisibility: "shown", exceptions: ["gemini-flash", "gemini-pro"] },
  });

  await h.store.setModelVisibility("google", "gemini-pro", false);
  assert.deepEqual((await h.store.getSettings()).hiddenModelsByProvider, {
    anthropic: { defaultVisibility: "shown", exceptions: ["claude-sonnet"] },
    google: { defaultVisibility: "shown", exceptions: ["gemini-flash"] },
  });
  await h.store.showAllProviderModels("google");
  assert.deepEqual((await h.store.getSettings()).hiddenModelsByProvider, {
    anthropic: { defaultVisibility: "shown", exceptions: ["claude-sonnet"] },
  });

  await h.store.hideAllProviderModels("google");
  assert.deepEqual((await h.store.getSettings()).hiddenModelsByProvider?.google, {
    defaultVisibility: "hidden",
    exceptions: [],
  });
  await h.store.setModelVisibility("google", "gemini-pro", false);
  assert.deepEqual((await h.store.getSettings()).hiddenModelsByProvider?.google, {
    defaultVisibility: "hidden",
    exceptions: ["gemini-pro"],
  });
});

test("Gemini voice setup atomically selects voice and gates every Google chat model", async (t) => {
  const h = await harness(t);
  await h.store.setModelVisibility("google", "gemini-private", true);
  await h.store.setModelVisibility("anthropic", "claude-private", true);

  const voiceOnly = await h.store.setGeminiVoiceSetup(
    "transcription_only",
    "gemini-3.5-transcribe-live",
  );
  assert.equal(voiceOnly.voiceProvider, "gemini");
  assert.equal(voiceOnly.voiceModel, "gemini-3.5-transcribe-live");
  assert.equal(voiceOnly.geminiUsageScope, "transcription_only");
  assert.deepEqual(voiceOnly.hiddenModelsByProvider, {
    anthropic: { defaultVisibility: "shown", exceptions: ["claude-private"] },
    google: {
      defaultVisibility: "shown",
      exceptions: ["gemini-private"],
      policyHidden: true,
    },
  });

  await h.store.setModelVisibility("google", "future-gemini", false);
  await h.store.showAllProviderModels("google");
  assert.deepEqual((await h.store.getSettings()).hiddenModelsByProvider?.google, {
    defaultVisibility: "shown",
    exceptions: ["gemini-private"],
    policyHidden: true,
  });

  const full = await h.store.setGeminiVoiceSetup(
    "models_and_transcription",
    "gemini-3.5-transcribe",
  );
  assert.equal(full.geminiUsageScope, "models_and_transcription");
  assert.deepEqual(full.hiddenModelsByProvider, {
    anthropic: { defaultVisibility: "shown", exceptions: ["claude-private"] },
    google: { defaultVisibility: "shown", exceptions: ["gemini-private"] },
  });
});

test("Gemini usage scope gates Google models without changing local or OpenAI voice", async (t) => {
  const h = await harness(t);

  await h.store.setSettings({
    voiceProvider: "local",
    voiceModel: "local-voice-selection",
  });
  const local = await h.store.setGeminiUsageScope("transcription_only");
  assert.equal(local.voiceProvider, "local");
  assert.equal(local.voiceModel, "local-voice-selection");
  assert.equal(local.geminiUsageScope, "transcription_only");
  assert.deepEqual(local.hiddenModelsByProvider?.google, {
    defaultVisibility: "shown",
    exceptions: [],
    policyHidden: true,
  });

  await h.store.setSettings({
    voiceProvider: "openai",
    voiceModel: "gpt-4o-mini-transcribe",
  });
  const openai = await h.store.setGeminiUsageScope("models_and_transcription");
  assert.equal(openai.voiceProvider, "openai");
  assert.equal(openai.voiceModel, "gpt-4o-mini-transcribe");
  assert.equal(openai.geminiUsageScope, "models_and_transcription");
  assert.equal(openai.hiddenModelsByProvider?.google, undefined);
});

test("removing a provider clears its model visibility preferences", async (t) => {
  const h = await harness(t);
  await h.store.saveProvider(provider);
  await h.store.setModelVisibility(provider.id, provider.models[0], true);
  await h.store.setModelVisibility("other", "other-model", true);

  await h.store.removeProvider(provider.id);

  assert.deepEqual((await h.store.getSettings()).hiddenModelsByProvider, {
    other: { defaultVisibility: "shown", exceptions: ["other-model"] },
  });
});

test("admitted provider removal finishes cache and visibility cleanup after renderer navigation", async (t) => {
  const h = await harness(t);
  await h.store.saveProvider(provider);
  await h.store.setModelVisibility(provider.id, provider.models[0], true);
  h.secrets.keys[provider.id] = "ciphertext";
  let validityChecks = 0;

  await h.store.removeProvider(provider.id, () => {
    validityChecks += 1;
    return validityChecks <= 5;
  });

  assert.equal(validityChecks, 5);
  assert.deepEqual(await h.store.listProviders(), []);
  assert.equal((await h.store.getSettings()).hiddenModelsByProvider?.[provider.id], undefined);
  assert.equal(h.secrets.keys[provider.id], undefined);
  const cache = await readJson<{ byProvider: Record<string, unknown> }>(h.cacheFile);
  assert.equal(cache.byProvider[provider.id], undefined);
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
  await h.store.setSettings({ exaEnabled: true, showLocalModelReasoning: false });

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
    showLocalModelReasoning: false,
  });
});

test("resetUserSetup clears setup and preferences while preserving skills and workspaces", async (t) => {
  const h = await harness(t);
  await h.store.saveProvider(provider);
  await h.stores.portable.update((config) => {
    config.providerIdAliases = { "legacy-lmstudio": provider.id };
  });
  await h.store.saveMcpServer({
    id: "filesystem",
    name: "Filesystem",
    transport: "stdio",
    command: "mcp-fs",
    enabled: true,
  });
  await h.store.saveSkill({
    id: "summarize",
    name: "Summarize",
    description: "Summarize a document",
    instructions: "Keep it concise.",
    enabled: true,
  });
  await h.store.saveWorkspace({
    id: "project",
    name: "Project",
    permission: "ask",
    folderPath: "/Users/example/project",
    createdAt: 1,
    updatedAt: 1,
  });
  await h.store.setSettings({
    profileName: "Sambit",
    lastProviderId: provider.id,
    lastModel: "qwen3-8b",
    exaEnabled: true,
  });

  await h.store.resetUserSetup();

  assert.deepEqual(await h.store.listProviders(), []);
  assert.deepEqual(await h.store.listMcpServers(), []);
  assert.deepEqual(await h.store.getSettings(), {});
  assert.deepEqual(await h.store.listSkills(), [
    {
      id: "summarize",
      name: "Summarize",
      description: "Summarize a document",
      instructions: "Keep it concise.",
      enabled: true,
    },
  ]);
  assert.ok((await h.store.listWorkspaces()).some((workspace) => workspace.id === "project"));

  const portable = await readJson<{
    providerIdAliases: Record<string, string>;
    skills: Array<{ id: string }>;
  }>(h.portableFile);
  assert.deepEqual(portable.providerIdAliases, {});
  assert.deepEqual(
    portable.skills.map(({ id }) => id),
    ["summarize"],
  );
  assert.deepEqual(
    (await readJson<{ byProvider: Record<string, unknown> }>(h.cacheFile)).byProvider,
    {},
  );
});

test("reads and writes survive a restart of the whole store", async (t) => {
  const h = await harness(t);
  await h.store.saveProvider(provider);
  await h.store.setSettings({ exaEnabled: true, assistant: assistantConfig });

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
  assert.deepEqual(await next.getSettings(), {
    exaEnabled: true,
    assistant: assistantConfig,
  });
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

test("released onboarding local identity migration re-homes cache and remembered provider", async (t) => {
  const releasedId = "custom:onboarding-lmstudio";
  const h = await harness(t, {
    providers: [
      {
        ...provider,
        id: releasedId,
        defaultModel: "qwen3-8b",
      },
    ],
    settings: {
      lastProviderId: releasedId,
      hiddenModelsByProvider: { [releasedId]: ["qwen3-8b"] },
    },
    seeded: true,
  });

  const [listed] = await h.store.listProviders();

  assert.equal(listed.id, "custom:lmstudio");
  assert.deepEqual(listed.legacyIds, [releasedId]);
  assert.deepEqual(listed.models, provider.models);
  assert.deepEqual(listed.modelMetadata, provider.modelMetadata);
  assert.equal((await h.store.getSettings()).lastProviderId, "custom:lmstudio");
  assert.deepEqual((await h.store.getSettings()).hiddenModelsByProvider, {
    "custom:lmstudio": { defaultVisibility: "shown", exceptions: ["qwen3-8b"] },
  });
  const cache = await readJson<{ byProvider: Record<string, unknown> }>(h.cacheFile);
  assert.equal(cache.byProvider[releasedId], undefined);
  assert.deepEqual(cache.byProvider["custom:lmstudio"], {
    models: provider.models,
    modelMetadata: provider.modelMetadata,
  });
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

test("an interrupted provider-ID migration re-homes legacy cache on the next launch", async (t) => {
  const h = await harness(t, {
    workspaces: [],
    seeded: true,
    aidenDirMigratedAt: Date.now(),
  });
  const targetId = "custom:openai-legacy";
  await fs.mkdir(path.dirname(h.portableFile), { recursive: true });
  await fs.writeFile(
    h.portableFile,
    JSON.stringify(
      {
        providers: [
          splitStoredProvider({
            ...untouchedPreset,
            id: targetId,
            isPreset: false,
            isBuiltin: false,
          }).intent,
        ],
        providerIdAliases: { openai: targetId },
        mcpServers: [],
        skills: [],
      },
      null,
      2,
    ),
    "utf-8",
  );
  await fs.writeFile(
    h.settingsFile,
    JSON.stringify({ settings: { lastProviderId: "openai" } }),
    "utf-8",
  );
  await fs.writeFile(
    h.cacheFile,
    JSON.stringify({ byProvider: { openai: { models: untouchedPreset.models } } }),
    "utf-8",
  );

  const [listed] = await h.store.listProviders();

  assert.equal(listed.id, targetId);
  assert.deepEqual(listed.models, untouchedPreset.models);
  assert.equal((await h.store.getSettings()).lastProviderId, targetId);
  const cache = await readJson<{
    byProvider: Record<string, { models?: string[] }>;
  }>(h.cacheFile);
  assert.deepEqual(cache.byProvider[targetId]?.models, untouchedPreset.models);
  assert.equal(cache.byProvider.openai, undefined);
});

test("retry-safe cache repair never overwrites a newer destination cache", async (t) => {
  const h = await harness(t, {
    workspaces: [],
    seeded: true,
    aidenDirMigratedAt: Date.now(),
  });
  const targetId = "custom:openai-legacy";
  const freshModels = ["fresh-model"];
  await fs.mkdir(path.dirname(h.portableFile), { recursive: true });
  await fs.writeFile(
    h.portableFile,
    JSON.stringify({
      providers: [
        splitStoredProvider({
          ...untouchedPreset,
          id: targetId,
          isPreset: false,
          isBuiltin: false,
        }).intent,
      ],
      providerIdAliases: { openai: targetId },
      mcpServers: [],
      skills: [],
    }),
    "utf-8",
  );
  await fs.writeFile(
    h.cacheFile,
    JSON.stringify({
      byProvider: {
        openai: {
          models: untouchedPreset.models,
          modelMetadata: {
            "legacy-metadata": { source: "provider", reasoning: true },
          },
        },
        [targetId]: { models: freshModels },
      },
    }),
    "utf-8",
  );

  const [listed] = await h.store.listProviders();

  assert.deepEqual(listed.models, freshModels);
  const cache = await readJson<{
    byProvider: Record<string, { models?: string[] }>;
  }>(h.cacheFile);
  assert.deepEqual(cache.byProvider[targetId]?.models, freshModels);
  assert.deepEqual((cache.byProvider[targetId] as { modelMetadata?: unknown })?.modelMetadata, {
    "legacy-metadata": { source: "provider", reasoning: true },
  });
  assert.equal(cache.byProvider.openai, undefined);
});

test("retry-safe cache repair keeps destination metadata while restoring legacy models", async (t) => {
  const h = await harness(t, {
    workspaces: [],
    seeded: true,
    aidenDirMigratedAt: Date.now(),
  });
  const targetId = "custom:openai-legacy";
  const freshMetadata = {
    "fresh-model": { source: "provider" as const, vision: true },
  };
  await fs.mkdir(path.dirname(h.portableFile), { recursive: true });
  await fs.writeFile(
    h.portableFile,
    JSON.stringify({
      providers: [
        splitStoredProvider({
          ...untouchedPreset,
          id: targetId,
          isPreset: false,
          isBuiltin: false,
        }).intent,
      ],
      providerIdAliases: { openai: targetId },
      mcpServers: [],
      skills: [],
    }),
    "utf-8",
  );
  await fs.writeFile(
    h.cacheFile,
    JSON.stringify({
      byProvider: {
        openai: { models: untouchedPreset.models },
        [targetId]: { modelMetadata: freshMetadata },
      },
    }),
    "utf-8",
  );

  const [listed] = await h.store.listProviders();

  assert.deepEqual(listed.models, untouchedPreset.models);
  assert.deepEqual(listed.modelMetadata, freshMetadata);
  const cache = await readJson<{
    byProvider: Record<string, { models?: string[]; modelMetadata?: unknown }>;
  }>(h.cacheFile);
  assert.deepEqual(cache.byProvider[targetId]?.models, untouchedPreset.models);
  assert.deepEqual(cache.byProvider[targetId]?.modelMetadata, freshMetadata);
  assert.equal(cache.byProvider.openai, undefined);
});

test("provider migration folds complementary caches from every historical alias", async (t) => {
  const h = await harness(t, {
    workspaces: [],
    seeded: true,
    aidenDirMigratedAt: Date.now(),
  });
  const targetId = "custom:openai-legacy";
  await fs.mkdir(path.dirname(h.portableFile), { recursive: true });
  await fs.writeFile(
    h.portableFile,
    JSON.stringify({
      providers: [
        splitStoredProvider({
          ...untouchedPreset,
          id: targetId,
          isPreset: false,
          isBuiltin: false,
        }).intent,
      ],
      providerIdAliases: {
        "old-models": targetId,
        "old-metadata": targetId,
      },
      mcpServers: [],
      skills: [],
    }),
    "utf-8",
  );
  await fs.writeFile(
    h.settingsFile,
    JSON.stringify({ settings: { lastProviderId: "old-models" } }),
    "utf-8",
  );
  await fs.writeFile(
    h.cacheFile,
    JSON.stringify({
      byProvider: {
        "old-models": { models: untouchedPreset.models },
        "old-metadata": {
          modelMetadata: {
            "gpt-4o": { source: "provider", reasoning: true },
          },
        },
      },
    }),
    "utf-8",
  );

  const [listed] = await h.store.listProviders();

  assert.deepEqual(listed.models, untouchedPreset.models);
  assert.deepEqual(listed.modelMetadata, {
    "gpt-4o": { source: "provider", reasoning: true },
  });
  const cache = await readJson<{
    byProvider: Record<string, { models?: string[]; modelMetadata?: unknown }>;
  }>(h.cacheFile);
  assert.deepEqual(cache.byProvider[targetId], {
    models: untouchedPreset.models,
    modelMetadata: {
      "gpt-4o": { source: "provider", reasoning: true },
    },
  });
  assert.equal(cache.byProvider["old-models"], undefined);
  assert.equal(cache.byProvider["old-metadata"], undefined);
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
  const futureSecret = { version: 2, ciphertext: "future" };
  const secrets = fakeSecrets({ openai: "ciphertext", "future-provider": futureSecret });
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
  assert.deepEqual(secrets.keys["future-provider"], futureSecret);
  assert.equal(listed.hasKey, true);
});

test("secret migration preserves unknown future-shaped source and destination records", async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-config-future-keys-"));
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
  const futureSource = { version: 2, ciphertext: "future-source" };
  const futureTarget = { version: 2, ciphertext: "future-target" };
  const secrets = fakeSecrets({
    openai: futureSource,
    "custom:openai": futureTarget,
    gemini: "legacy-google-ciphertext",
    google: futureTarget,
  });
  const store = createConfigStore(
    createPortableConfigStores(
      () => path.join(base, "dot-aiden"),
      () => localRoot,
    ),
    secrets.port,
  );

  await store.listProviders();
  assert.deepEqual(secrets.keys.openai, futureSource);
  assert.deepEqual(secrets.keys["custom:openai"], futureTarget);
  assert.equal(secrets.keys.gemini, "legacy-google-ciphertext");
  assert.deepEqual(secrets.keys.google, futureTarget);
  assert.equal(
    await store.providerLegacyCredentialMigrationReady(),
    false,
    "future destinations keep Pi import deferred",
  );
});

test("a string legacy key cannot bypass a future-shaped custom destination", async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-config-future-target-"));
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
  const futureTarget = { version: 2, ciphertext: "future-target" };
  const secrets = fakeSecrets({
    openai: "legacy-ciphertext",
    "custom:openai-legacy": futureTarget,
  });
  const store = createConfigStore(
    createPortableConfigStores(
      () => path.join(base, "dot-aiden"),
      () => localRoot,
    ),
    secrets.port,
  );

  await store.listProviders();
  assert.equal(secrets.keys.openai, "legacy-ciphertext");
  assert.deepEqual(secrets.keys["custom:openai-legacy"], futureTarget);
  assert.equal(await store.providerLegacyCredentialMigrationReady(), false);
});

test("a future-shaped custom alias source stays unresolved when its destination is absent", async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-config-future-source-"));
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
  const futureSource = { version: 2, ciphertext: "future-source" };
  const secrets = fakeSecrets({ openai: futureSource });
  const store = createConfigStore(
    createPortableConfigStores(
      () => path.join(base, "dot-aiden"),
      () => localRoot,
    ),
    secrets.port,
  );

  const [listed] = await store.listProviders();
  assert.deepEqual(secrets.keys.openai, futureSource);
  assert.equal(secrets.keys[listed.id], undefined);
  assert.equal(listed.hasKey, false);
  assert.equal(await store.providerLegacyCredentialMigrationReady(), false);
});

test("conflicting custom alias ciphertexts stay preserved and unbound", async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-config-conflicting-keys-"));
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
  const targetId = "custom:openai-legacy";
  const secrets = fakeSecrets({
    openai: "source-ciphertext",
    [targetId]: "destination-ciphertext",
  });
  const store = createConfigStore(
    createPortableConfigStores(
      () => path.join(base, "dot-aiden"),
      () => localRoot,
    ),
    secrets.port,
  );

  const [listed] = await store.listProviders();
  assert.equal(listed.id, targetId);
  assert.equal(secrets.keys.openai, "source-ciphertext");
  assert.equal(secrets.keys[targetId], "destination-ciphertext");
  assert.equal(secrets.keys[`__test_binding__:${targetId}`], undefined);
  assert.equal(listed.hasKey, false, "an unproven destination cannot reach the custom endpoint");
  assert.equal(await store.providerLegacyCredentialMigrationReady(), false);
});

test("converging custom alias sources migrate all-or-none", async (t) => {
  for (const [name, sourceKeys] of [
    ["two-string-sources", { ancient: "ancient-ciphertext", legacy: "legacy-ciphertext" }],
    [
      "future-and-string-sources",
      {
        ancient: { version: 2, ciphertext: "future-ciphertext" },
        legacy: "legacy-ciphertext",
      },
    ],
  ] as const) {
    await t.test(name, async (t) => {
      const h = await harness(t, {
        workspaces: [],
        seeded: true,
        aidenDirMigratedAt: Date.now(),
      });
      const targetId = "custom:converged";
      await fs.mkdir(path.dirname(h.portableFile), { recursive: true });
      await fs.writeFile(
        h.portableFile,
        JSON.stringify({
          providers: [
            {
              ...splitStoredProvider(provider).intent,
              id: targetId,
              label: "Converged proxy",
              baseUrl: "https://proxy.internal/v1",
            },
          ],
          providerIdAliases: {
            ancient: "legacy",
            legacy: targetId,
          },
          mcpServers: [],
          skills: [],
        }),
        "utf-8",
      );
      const secrets = fakeSecrets(sourceKeys);
      const store = createConfigStore(h.stores, secrets.port);

      const [listed] = await store.listProviders();
      assert.deepEqual(secrets.keys.ancient, sourceKeys.ancient);
      assert.equal(secrets.keys.legacy, sourceKeys.legacy);
      assert.equal(secrets.keys[targetId], undefined);
      assert.equal(secrets.keys[`__test_binding__:${targetId}`], undefined);
      assert.equal(listed.hasKey, false);
      assert.equal(await store.providerLegacyCredentialMigrationReady(), false);
    });
  }
});

test("a custom Gemini alias cannot fall through to built-in Google key migration", async (t) => {
  const h = await harness(t, {
    workspaces: [],
    seeded: true,
    aidenDirMigratedAt: Date.now(),
  });
  const targetId = "custom:gemini-legacy";
  await fs.mkdir(path.dirname(h.portableFile), { recursive: true });
  await fs.writeFile(
    h.portableFile,
    JSON.stringify({
      providers: [
        {
          ...splitStoredProvider(provider).intent,
          id: targetId,
          label: "Gemini proxy",
          baseUrl: "https://proxy.internal/v1",
        },
      ],
      providerIdAliases: { gemini: targetId },
      mcpServers: [],
      skills: [],
    }),
    "utf-8",
  );
  const futureTarget = { version: 2, ciphertext: "future-target" };
  const secrets = fakeSecrets({
    gemini: "legacy-gemini-ciphertext",
    [targetId]: futureTarget,
  });
  const store = createConfigStore(h.stores, secrets.port);

  await store.listProviders();
  assert.equal(secrets.keys.gemini, "legacy-gemini-ciphertext");
  assert.equal(secrets.keys.google, undefined);
  assert.deepEqual(secrets.keys[targetId], futureTarget);
  assert.equal(await store.providerLegacyCredentialMigrationReady(), false);
});

test("conflicting custom Gemini ciphertexts stay unbound and never reach Google", async (t) => {
  const h = await harness(t, {
    workspaces: [],
    seeded: true,
    aidenDirMigratedAt: Date.now(),
  });
  const targetId = "custom:gemini-legacy";
  await fs.mkdir(path.dirname(h.portableFile), { recursive: true });
  await fs.writeFile(
    h.portableFile,
    JSON.stringify({
      providers: [
        {
          ...splitStoredProvider(provider).intent,
          id: targetId,
          label: "Gemini proxy",
          baseUrl: "https://proxy.internal/v1",
        },
      ],
      providerIdAliases: { gemini: targetId },
      mcpServers: [],
      skills: [],
    }),
    "utf-8",
  );
  const secrets = fakeSecrets({
    gemini: "source-ciphertext",
    [targetId]: "destination-ciphertext",
  });
  const store = createConfigStore(h.stores, secrets.port);

  const [listed] = await store.listProviders();
  assert.equal(secrets.keys.gemini, "source-ciphertext");
  assert.equal(secrets.keys[targetId], "destination-ciphertext");
  assert.equal(secrets.keys[`__test_binding__:${targetId}`], undefined);
  assert.equal(secrets.keys.google, undefined);
  assert.equal(listed.hasKey, false);
  assert.equal(await store.providerLegacyCredentialMigrationReady(), false);
});

test("corrupt portable roots cannot move or bind legacy provider secrets", async (t) => {
  for (const kind of ["invalid-json", "invalid-utf8", "fifo", "directory"] as const) {
    await t.test(kind, async (t) => {
      const h = await harness(t, {
        workspaces: [],
        seeded: true,
        aidenDirMigratedAt: Date.now(),
      });
      await fs.mkdir(path.dirname(h.portableFile), { recursive: true });
      if (kind === "invalid-json") {
        await fs.writeFile(h.portableFile, "{", "utf-8");
      } else if (kind === "invalid-utf8") {
        await fs.writeFile(h.portableFile, Buffer.from([0xc3, 0x28]));
      } else if (kind === "fifo") {
        execFileSync("/usr/bin/mkfifo", [h.portableFile]);
      } else {
        await fs.mkdir(h.portableFile);
      }
      const secrets = fakeSecrets({ gemini: "custom-gemini-ciphertext" });
      const store = createConfigStore(h.stores, secrets.port);

      assert.deepEqual(await store.listProviders(), []);
      assert.equal(secrets.keys.gemini, "custom-gemini-ciphertext");
      assert.equal(secrets.keys.google, undefined);
      assert.equal(secrets.migrateCalls, 0);
      assert.equal(await store.providerLegacyCredentialMigrationReady(), false);
    });
  }
});

test("unsafe or active-source aliases never move or delete provider keys", async (t) => {
  const secondProvider = {
    ...provider,
    id: "custom:other",
    label: "Other",
    baseUrl: "http://localhost:2345/v1",
  };
  for (const aliases of [
    { [provider.id]: secondProvider.id },
    { [provider.id]: secondProvider.id, [secondProvider.id]: provider.id },
    { [provider.id]: "" },
  ]) {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-config-alias-safety-"));
    t.after(() => fs.rm(base, { recursive: true, force: true }));
    const localRoot = path.join(base, "userData");
    const portableRoot = path.join(base, "dot-aiden");
    await fs.mkdir(localRoot, { recursive: true });
    await fs.mkdir(portableRoot, { recursive: true });
    await fs.writeFile(
      path.join(localRoot, LOCAL_CONFIG_FILENAME),
      JSON.stringify({
        workspaces: [],
        seeded: true,
        aidenDirMigratedAt: Date.now(),
      }),
      "utf-8",
    );
    await fs.writeFile(
      path.join(portableRoot, PORTABLE_CONFIG_FILENAME),
      JSON.stringify({
        providers: [
          splitStoredProvider(provider).intent,
          splitStoredProvider(secondProvider).intent,
        ],
        providerIdAliases: aliases,
        mcpServers: [],
        skills: [],
      }),
      "utf-8",
    );
    const secrets = fakeSecrets({
      [provider.id]: "first-key",
      [secondProvider.id]: "second-key",
    });
    const store = createConfigStore(
      createPortableConfigStores(
        () => portableRoot,
        () => localRoot,
      ),
      secrets.port,
    );

    await store.listProviders();

    assert.equal(secrets.keys[provider.id], "first-key");
    assert.equal(secrets.keys[secondProvider.id], "second-key");
    assert.equal(secrets.keys[""], undefined);
  }
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

test("a first-ever launch has no providers and records that it seeded", async (t) => {
  const h = await harness(t);
  assert.deepEqual(await h.store.listProviders(), []);

  const local = await readJson<{ seeded: boolean }>(h.localFile);
  assert.equal(local.seeded, true);
});

test("a copied portable provider survives first launch on a fresh local root", async (t) => {
  const h = await harness(t);
  const copiedProvider = splitStoredProvider(provider).intent;
  await fs.mkdir(path.dirname(h.portableFile), { recursive: true });
  await fs.writeFile(
    h.portableFile,
    JSON.stringify(
      {
        providers: [copiedProvider],
        providerIdAliases: {},
        mcpServers: [],
        skills: [],
      },
      null,
      2,
    ),
    "utf-8",
  );

  const [listed] = await h.store.listProviders();
  assert.equal(listed.id, provider.id);
  assert.deepEqual(listed.models, [], "the copied intent has no local model cache yet");
  assert.equal(listed.hasKey, false, "the copied intent has no local secret yet");

  const portable = await readJson<{ providers: Array<{ id: string }> }>(h.portableFile);
  assert.deepEqual(
    portable.providers.map((copied) => copied.id),
    [provider.id],
  );
  assert.equal((await readJson<{ seeded: boolean }>(h.localFile)).seeded, true);
});

test("a previously split config without providers is repaired before startup migration", async (t) => {
  const h = await harness(t, {
    workspaces: [],
    seeded: true,
    aidenDirMigratedAt: Date.now(),
  });
  await fs.mkdir(path.dirname(h.portableFile), { recursive: true });
  await fs.writeFile(
    h.portableFile,
    JSON.stringify({ providerIdAliases: {}, mcpServers: [], skills: [] }, null, 2),
    "utf-8",
  );

  assert.deepEqual(await h.store.listProviders(), []);
  assert.deepEqual((await readJson<{ providers: unknown[] }>(h.portableFile)).providers, []);
});

test("a post-startup edit missing providers is normalized inside the next write", async (t) => {
  const h = await harness(t, {
    workspaces: [],
    seeded: true,
    aidenDirMigratedAt: Date.now(),
  });
  await h.store.listProviders();
  const missingProviders = JSON.stringify(
    { providerIdAliases: {}, mcpServers: [], skills: [] },
    null,
    2,
  );
  await fs.writeFile(h.portableFile, missingProviders, "utf-8");
  await h.stores.portable.reload();

  const saved = await h.store.saveProvider(provider);

  assert.equal(saved.id, provider.id);
  assert.deepEqual(
    (await readJson<{ providers: Array<{ id: string }> }>(h.portableFile)).providers.map(
      ({ id }) => id,
    ),
    [provider.id],
  );
});

test("a first upgrade with an existing portable file repairs its missing providers field", async (t) => {
  const h = await harness(t, { workspaces: [], seeded: true });
  await fs.mkdir(path.dirname(h.portableFile), { recursive: true });
  await fs.writeFile(
    h.portableFile,
    JSON.stringify({ providerIdAliases: {}, mcpServers: [], skills: [] }, null, 2),
    "utf-8",
  );

  assert.deepEqual(await h.store.listProviders(), []);
  assert.equal(
    typeof (await readJson<{ aidenDirMigratedAt: number }>(h.localFile)).aidenDirMigratedAt,
    "number",
  );
  assert.deepEqual((await readJson<{ providers: unknown[] }>(h.portableFile)).providers, []);
});

test("malformed provider data does not crash startup or overwrite the portable file", async (t) => {
  const h = await harness(t);
  await fs.mkdir(path.dirname(h.portableFile), { recursive: true });
  const malformed = JSON.stringify(
    { providers: [null], providerIdAliases: {}, mcpServers: [], skills: [] },
    null,
    2,
  );
  await fs.writeFile(h.portableFile, malformed, "utf-8");

  assert.deepEqual(await h.store.listProviders(), []);
  assert.equal(await h.store.portableConfigSafeForCredentialReconciliation(), false);
  assert.equal(await h.store.providerLegacyCredentialMigrationReady(), false);
  assert.equal(h.secrets.migrateCalls, 0, "unsafe aliases cannot authorize legacy key migration");
  assert.equal(await fs.readFile(h.portableFile, "utf-8"), malformed);
  await h.stores.portable.reload();
  assert.deepEqual(await h.store.listProviders(), []);
  await assert.rejects(
    h.store.saveSkill({
      id: "s1",
      name: "S",
      description: "d",
      instructions: "i",
      enabled: true,
    }),
    /Config migration is deferred/u,
  );
  assert.equal(await fs.readFile(h.portableFile, "utf-8"), malformed);
});

test("already-migrated malformed portable state blocks every config write", async (t) => {
  const local = {
    workspaces: [],
    seeded: true,
    aidenDirMigratedAt: Date.now(),
  };
  const h = await harness(t, local);
  await fs.mkdir(path.dirname(h.portableFile), { recursive: true });
  const malformed = JSON.stringify(
    { providers: [null], providerIdAliases: {}, mcpServers: [], skills: [] },
    null,
    2,
  );
  await fs.writeFile(h.portableFile, malformed, "utf-8");

  assert.deepEqual(await h.store.listProviders(), []);
  await assert.rejects(h.store.setSettings({ exaEnabled: true }), /migration is deferred/iu);
  await assert.rejects(
    h.store.saveWorkspace({
      id: "blocked",
      name: "Blocked",
      permission: "ask",
      folderPath: "/blocked",
      createdAt: 1,
      updatedAt: 1,
    }),
    /migration is deferred/iu,
  );
  await assert.rejects(
    h.store.saveSkill({
      id: "blocked",
      name: "Blocked",
      description: "",
      instructions: "",
      enabled: true,
    }),
    /migration is deferred/iu,
  );

  assert.equal(await fs.readFile(h.portableFile, "utf-8"), malformed);
  assert.deepEqual(await readJson(h.localFile), local);
  await assert.rejects(fs.stat(h.settingsFile), { code: "ENOENT" });
});

test("an active provider ID is never redirected through an alias", async (t) => {
  const h = await harness(t, {
    workspaces: [],
    seeded: true,
    aidenDirMigratedAt: Date.now(),
  });
  await fs.mkdir(path.dirname(h.portableFile), { recursive: true });
  const intent = splitStoredProvider(provider).intent;
  const raw = JSON.stringify({
    providers: [intent],
    providerIdAliases: { [intent.id]: "custom:replacement" },
    mcpServers: [],
    skills: [],
  });
  await fs.writeFile(h.portableFile, raw, "utf-8");

  const [listed] = await h.store.listProviders();
  assert.equal(listed.id, intent.id);
  assert.equal(await h.store.resolveProviderId(intent.id), intent.id);
  await assert.rejects(h.store.setSettings({ exaEnabled: true }), /migration is deferred/iu);
  assert.equal(await fs.readFile(h.portableFile, "utf-8"), raw);
});

test("malformed portable MCP and skill entries stay byte-identical and read as empty", async (t) => {
  for (const field of ["mcpServers", "skills"] as const) {
    const h = await harness(t, {
      workspaces: [],
      seeded: true,
      aidenDirMigratedAt: Date.now(),
    });
    await fs.mkdir(path.dirname(h.portableFile), { recursive: true });
    const raw = JSON.stringify({
      providers: [],
      providerIdAliases: {},
      mcpServers: field === "mcpServers" ? [null] : [],
      skills: field === "skills" ? [null] : [],
    });
    await fs.writeFile(h.portableFile, raw, "utf-8");

    assert.deepEqual(
      field === "mcpServers" ? await h.store.listMcpServers() : await h.store.listSkills(),
      [],
    );
    assert.equal(await fs.readFile(h.portableFile, "utf-8"), raw);
    await assert.rejects(
      h.store.saveSkill({
        id: "safe",
        name: "Safe",
        description: "",
        instructions: "",
        enabled: true,
      }),
      /(?:Portable config is malformed|Config migration is deferred|schema is not safe)/u,
    );
    assert.equal(await fs.readFile(h.portableFile, "utf-8"), raw);
  }
});

test("credential reconciliation reloads authoritative portable config from disk", async (t) => {
  const h = await harness(t);
  assert.deepEqual(await h.store.listMcpServers(), []);
  const server = {
    id: "authoritative-server",
    name: "Authoritative",
    transport: "stdio" as const,
    command: "mcp-authoritative",
    enabled: true,
  };
  await fs.writeFile(
    h.portableFile,
    JSON.stringify(
      {
        providers: [],
        providerIdAliases: {},
        mcpServers: [server],
        skills: [],
      },
      null,
      2,
    ),
    "utf-8",
  );

  assert.equal(await h.store.portableConfigSafeForCredentialReconciliation(), true);
  assert.deepEqual(await h.store.listMcpServers(), [server]);
});

test("duplicate portable MCP and skill IDs are rejected as ambiguous identities", async (t) => {
  const validMcp = {
    id: "duplicate",
    name: "One",
    transport: "stdio" as const,
    command: "one",
    enabled: true,
  };
  const validSkill = {
    id: "duplicate",
    name: "One",
    description: "",
    instructions: "",
    enabled: true,
  };
  for (const field of ["mcpServers", "skills"] as const) {
    const h = await harness(t, {
      workspaces: [],
      seeded: true,
      aidenDirMigratedAt: Date.now(),
    });
    await fs.mkdir(path.dirname(h.portableFile), { recursive: true });
    const raw = JSON.stringify({
      providers: [],
      providerIdAliases: {},
      mcpServers:
        field === "mcpServers" ? [validMcp, { ...validMcp, name: "Two", command: "two" }] : [],
      skills:
        field === "skills" ? [validSkill, { ...validSkill, name: "Two", instructions: "two" }] : [],
    });
    await fs.writeFile(h.portableFile, raw, "utf-8");

    assert.deepEqual(
      field === "mcpServers" ? await h.store.listMcpServers() : await h.store.listSkills(),
      [],
    );
    assert.equal(await fs.readFile(h.portableFile, "utf-8"), raw);
  }
});

test("duplicate provider IDs are rejected before one endpoint can borrow another cache", async (t) => {
  const h = await harness(t, {
    workspaces: [],
    seeded: true,
    aidenDirMigratedAt: Date.now(),
  });
  const intent = splitStoredProvider(provider).intent;
  await fs.mkdir(path.dirname(h.portableFile), { recursive: true });
  const raw = JSON.stringify({
    providers: [intent, { ...intent, baseUrl: "http://different-host:1234/v1" }],
    providerIdAliases: {},
    mcpServers: [],
    skills: [],
  });
  await fs.writeFile(h.portableFile, raw, "utf-8");
  await fs.writeFile(
    h.cacheFile,
    JSON.stringify({ byProvider: { [provider.id]: { models: provider.models } } }),
    "utf-8",
  );

  assert.deepEqual(await h.store.listProviders(), []);
  assert.equal(await fs.readFile(h.portableFile, "utf-8"), raw);
});

test("valid-JSON malformed local roots are normalized before startup reads", async (t) => {
  for (const malformed of [null, []] as const) {
    const h = await harness(t, malformed);

    assert.deepEqual(await h.store.listProviders(), []);
    assert.equal((await h.store.listWorkspaces()).length, 1);
    assert.deepEqual(await h.store.getSettings(), {});
  }
});

test("unsafe workspace records are hidden without rewriting the local source", async (t) => {
  for (const workspaces of [
    [{}],
    [
      {
        id: "duplicate",
        name: "One",
        folderPath: "/first",
        permission: "full",
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: "duplicate",
        name: "Two",
        folderPath: "/second",
        permission: "none",
        createdAt: 2,
        updatedAt: 2,
      },
    ],
  ] as const) {
    const raw = JSON.stringify({
      workspaces,
      seeded: true,
      aidenDirMigratedAt: Date.now(),
    });
    const h = await harness(t);
    await fs.writeFile(h.localFile, raw, "utf-8");

    assert.deepEqual(await h.store.listWorkspaces(), []);
    assert.equal(await h.store.getWorkspace("duplicate"), undefined);
    assert.equal(await fs.readFile(h.localFile, "utf-8"), raw);
    await assert.rejects(
      h.store.saveWorkspace({
        id: "blocked",
        name: "Blocked",
        permission: "ask",
        createdAt: 1,
        updatedAt: 1,
      }),
      /Config migration is deferred/u,
    );
    assert.equal(await fs.readFile(h.localFile, "utf-8"), raw);
  }
});

test("duplicate workspace IDs never route one record's path through another", async (t) => {
  const legacy = {
    workspaces: [
      {
        id: "duplicate",
        name: "One",
        folderPath: "/first",
        permission: "full",
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: "duplicate",
        name: "Two",
        folderPath: "/second",
        permission: "none",
        createdAt: 2,
        updatedAt: 2,
      },
    ],
    seeded: true,
    aidenDirMigratedAt: Date.now(),
  };
  const h = await harness(t, legacy);

  const workspaces = await h.store.listWorkspaces();

  assert.deepEqual(workspaces, []);
  assert.equal(await h.store.getWorkspace("duplicate"), undefined);
  assert.deepEqual(await readJson(h.localFile), legacy);
});

test("deferred migration leaves an unarchived corrupt legacy source read-only", async (t) => {
  const h = await harness(t);
  const brokenLegacy = '{ "providers": [broken legacy] }';
  await fs.writeFile(h.localFile, brokenLegacy, "utf-8");
  await fs.mkdir(path.dirname(h.portableFile), { recursive: true });
  await fs.writeFile(h.portableFile, "null", "utf-8");

  assert.deepEqual(await h.store.listProviders(), []);
  assert.deepEqual(await h.store.listWorkspaces(), []);
  assert.equal(await fs.readFile(h.localFile, "utf-8"), brokenLegacy);
  await assert.rejects(
    h.store.saveWorkspace({
      id: "blocked",
      name: "Blocked",
      permission: "ask",
      createdAt: 1,
      updatedAt: 1,
    }),
    /Config migration is deferred/u,
  );
  assert.equal(await fs.readFile(h.localFile, "utf-8"), brokenLegacy);
  await assert.rejects(
    fs.stat(`${h.localFile}${LEGACY_CONFIG_ARCHIVE_SUFFIX}`),
    (error: NodeJS.ErrnoException) => error.code === "ENOENT",
  );
});

test("valid-JSON malformed settings roots are normalized before reads and writes", async (t) => {
  for (const malformed of [null, [], { settings: null }] as const) {
    const h = await harness(t, {
      workspaces: [],
      seeded: true,
      aidenDirMigratedAt: Date.now(),
    });
    await fs.writeFile(h.settingsFile, JSON.stringify(malformed), "utf-8");

    assert.deepEqual(await h.store.getSettings(), {});
    assert.equal(
      (await h.store.setSettings({ lastProviderId: "custom:test" })).lastProviderId,
      "custom:test",
    );
  }
});

test("invalid settings JSON boots with defaults but remains read-only", async (t) => {
  const h = await harness(t, {
    workspaces: [],
    seeded: true,
    aidenDirMigratedAt: Date.now(),
  });
  const broken = '{ "settings": { "keybindings": [broken] } }';
  await fs.writeFile(h.settingsFile, broken, "utf-8");

  assert.deepEqual(await h.store.getSettings(), {});
  await assert.rejects(h.store.setSettings({ exaEnabled: true }), /does not parse/u);
  assert.equal(await fs.readFile(h.settingsFile, "utf-8"), broken);
});

test("malformed legacy settings are normalized before same-process consumers run", async (t) => {
  const h = await harness(t, {
    providers: [],
    settings: "bad",
    workspaces: [],
    seeded: true,
  });

  assert.deepEqual(await h.store.getSettings(), {});
  assert.deepEqual(await h.store.setGoogleThinkingLevel("gemini-test", "high"), {
    googleThinkingByModel: { "gemini-test": "high" },
  });
});

test("valid-JSON malformed model-cache roots cannot block migrated startup", async (t) => {
  for (const malformed of [null, { byProvider: null }] as const) {
    const h = await harness(t, {
      workspaces: [],
      seeded: true,
      aidenDirMigratedAt: Date.now(),
    });
    await fs.mkdir(path.dirname(h.portableFile), { recursive: true });
    await fs.writeFile(
      h.portableFile,
      JSON.stringify(
        {
          providers: [splitStoredProvider(provider).intent],
          providerIdAliases: {},
          mcpServers: [],
          skills: [],
        },
        null,
        2,
      ),
      "utf-8",
    );
    await fs.writeFile(h.cacheFile, JSON.stringify(malformed), "utf-8");

    const [listed] = await h.store.listProviders();
    assert.equal(listed.id, provider.id);
    assert.deepEqual(listed.models, []);
  }
});

test("malformed nested model metadata is dropped before renderer consumers see it", async (t) => {
  const h = await harness(t, {
    workspaces: [],
    seeded: true,
    aidenDirMigratedAt: Date.now(),
  });
  await fs.mkdir(path.dirname(h.portableFile), { recursive: true });
  await fs.writeFile(
    h.portableFile,
    JSON.stringify({
      providers: [splitStoredProvider(provider).intent],
      providerIdAliases: {},
      mcpServers: [],
      skills: [],
    }),
    "utf-8",
  );
  await fs.writeFile(
    h.cacheFile,
    JSON.stringify({
      byProvider: {
        [provider.id]: {
          models: provider.models,
          modelMetadata: {
            [provider.models[0]]: {
              source: "provider",
              thinkingLevels: { length: 1 },
            },
          },
        },
      },
    }),
    "utf-8",
  );

  const [listed] = await h.store.listProviders();

  assert.deepEqual(listed.models, provider.models);
  assert.equal(listed.modelMetadata, undefined);
});

test("malformed metadata embedded directly in portable intent cannot reach consumers", async (t) => {
  const h = await harness(t, {
    workspaces: [],
    seeded: true,
    aidenDirMigratedAt: Date.now(),
  });
  await fs.mkdir(path.dirname(h.portableFile), { recursive: true });
  await fs.writeFile(
    h.portableFile,
    JSON.stringify({
      providers: [
        {
          ...splitStoredProvider(provider).intent,
          modelMetadata: {
            bad: { source: "provider", thinkingLevels: { length: 1 } },
          },
        },
      ],
      providerIdAliases: {},
      mcpServers: [],
      skills: [],
    }),
    "utf-8",
  );

  const [listed] = await h.store.listProviders();

  assert.deepEqual(listed.models, []);
  assert.equal(listed.modelMetadata, undefined);
});

test("blank and duplicate cached model IDs are removed before renderer consumers see them", async (t) => {
  const h = await harness(t, {
    workspaces: [],
    seeded: true,
    aidenDirMigratedAt: Date.now(),
  });
  await fs.mkdir(path.dirname(h.portableFile), { recursive: true });
  await fs.writeFile(
    h.portableFile,
    JSON.stringify({
      providers: [splitStoredProvider(provider).intent],
      providerIdAliases: {},
      mcpServers: [],
      skills: [],
    }),
    "utf-8",
  );
  await fs.writeFile(
    h.cacheFile,
    JSON.stringify({
      byProvider: {
        [provider.id]: {
          models: ["", "qwen3-8b", "qwen3-8b", 7],
        },
      },
    }),
    "utf-8",
  );

  const [listed] = await h.store.listProviders();

  assert.deepEqual(listed.models, ["qwen3-8b"]);
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

test("provider migration compresses a maximum-depth alias graph before publication", async (t) => {
  const h = await harness(t, {
    workspaces: [],
    seeded: true,
    aidenDirMigratedAt: Date.now(),
  });
  const sourceId = "legacy-provider";
  const aliases = Object.fromEntries(
    Array.from({ length: 256 }, (_, index) => [
      `old-${index}`,
      index === 255 ? sourceId : `old-${index + 1}`,
    ]),
  );
  await fs.mkdir(path.dirname(h.portableFile), { recursive: true });
  await fs.writeFile(
    h.portableFile,
    JSON.stringify({
      providers: [splitStoredProvider({ ...provider, id: sourceId }).intent],
      providerIdAliases: aliases,
      mcpServers: [],
      skills: [],
    }),
    "utf-8",
  );

  const [listed] = await h.store.listProviders();
  const saved = await readJson<{
    providerIdAliases: Record<string, string>;
  }>(h.portableFile);
  assert.equal(listed.id, `custom:${sourceId}`);
  assert.equal(isProviderAliasMap(saved.providerIdAliases), true);
  assert.equal(saved.providerIdAliases["old-0"], listed.id);
  assert.equal(saved.providerIdAliases[sourceId], listed.id);
});

test("provider migration never publishes beyond the maximum alias count", async (t) => {
  const h = await harness(t, {
    workspaces: [],
    seeded: true,
    aidenDirMigratedAt: Date.now(),
  });
  const sourceId = "legacy-at-capacity";
  const aliases = Object.fromEntries(
    Array.from({ length: 4_096 }, (_, index) => [`old-${index}`, `custom:historical-${index}`]),
  );
  await fs.mkdir(path.dirname(h.portableFile), { recursive: true });
  const raw = JSON.stringify({
    providers: [splitStoredProvider({ ...provider, id: sourceId }).intent],
    providerIdAliases: aliases,
    mcpServers: [],
    skills: [],
  });
  await fs.writeFile(h.portableFile, raw, "utf-8");

  const [listed] = await h.store.listProviders();
  assert.equal(listed.id, sourceId);
  assert.equal(await fs.readFile(h.portableFile, "utf-8"), raw);
});

test("alias chains resolve fully and re-home oldest cache and secret data", async (t) => {
  const h = await harness(t, {
    workspaces: [],
    seeded: true,
    aidenDirMigratedAt: Date.now(),
  });
  const target = { ...provider, id: "custom:target" };
  await fs.mkdir(path.dirname(h.portableFile), { recursive: true });
  await fs.writeFile(
    h.portableFile,
    JSON.stringify({
      providers: [splitStoredProvider(target).intent],
      providerIdAliases: {
        ancient: "legacy",
        legacy: target.id,
      },
      mcpServers: [],
      skills: [],
    }),
    "utf-8",
  );
  await fs.writeFile(
    h.cacheFile,
    JSON.stringify({
      byProvider: {
        ancient: {
          models: ["oldest-model"],
          modelMetadata: { "oldest-model": { source: "provider" } },
        },
      },
    }),
    "utf-8",
  );
  const secrets = fakeSecrets({ ancient: "oldest-key" });
  const store = createConfigStore(h.stores, secrets.port);

  const [listed] = await store.listProviders();

  assert.equal(await store.resolveProviderId("ancient"), target.id);
  assert.deepEqual(listed.legacyIds, ["ancient", "legacy"]);
  assert.deepEqual(listed.models, ["oldest-model"]);
  assert.equal(listed.hasKey, true);
  assert.equal(secrets.keys.ancient, undefined);
  assert.equal(secrets.keys[target.id], "oldest-key");
  const cache = await readJson<{ byProvider: Record<string, unknown> }>(h.cacheFile);
  assert.equal(cache.byProvider.ancient, undefined);
  assert.deepEqual(cache.byProvider[target.id], {
    models: ["oldest-model"],
    modelMetadata: { "oldest-model": { source: "provider" } },
  });
});

test("provider normalization keeps the nearest alias cache and resolves remembered chains", async (t) => {
  const nearProvider = {
    ...provider,
    id: "near",
    models: ["embedded"],
  };
  const h = await harness(t, {
    providers: [nearProvider],
    providerIdAliases: { ancient: "near" },
    settings: { lastProviderId: "ancient" },
    workspaces: [],
    seeded: true,
  });
  await fs.writeFile(
    h.cacheFile,
    JSON.stringify({
      byProvider: {
        near: { models: ["fresh-near"] },
        ancient: { models: ["stale-ancestor"] },
      },
    }),
    "utf-8",
  );

  const [listed] = await h.store.listProviders();

  assert.equal(listed.id, "custom:near");
  assert.deepEqual(listed.models, ["fresh-near"]);
  assert.equal((await h.store.getSettings()).lastProviderId, listed.id);
  const cache = await readJson<{ byProvider: Record<string, unknown> }>(h.cacheFile);
  assert.deepEqual(cache.byProvider[listed.id], {
    models: ["fresh-near"],
    modelMetadata: provider.modelMetadata,
  });
  assert.equal(cache.byProvider.near, undefined);
  assert.equal(cache.byProvider.ancient, undefined);
});

test("alias lookup never reads inherited object properties", async (t) => {
  const h = await harness(t, {
    providers: [],
    providerIdAliases: {},
    settings: {},
    workspaces: [],
    seeded: true,
  });

  assert.equal(await h.store.resolveProviderId("toString"), "toString");
  assert.equal(
    (await h.store.setSettings({ lastProviderId: "toString" })).lastProviderId,
    "toString",
  );
});

test("prototype-sensitive provider IDs retain their local model cache", async (t) => {
  const h = await harness(t, {
    workspaces: [],
    seeded: true,
    aidenDirMigratedAt: Date.now(),
  });
  const prototypeProvider = { ...provider, id: "__proto__" };
  await fs.mkdir(path.dirname(h.portableFile), { recursive: true });
  await fs.writeFile(
    h.portableFile,
    JSON.stringify({
      providers: [splitStoredProvider(prototypeProvider).intent],
      providerIdAliases: {},
      mcpServers: [],
      skills: [],
    }),
    "utf-8",
  );
  await fs.writeFile(
    h.cacheFile,
    JSON.stringify({
      byProvider: {
        ["__proto__"]: { models: ["prototype-model"] },
      },
    }),
    "utf-8",
  );

  const [listed] = await h.store.listProviders();

  assert.equal(listed.id, "custom:__proto__");
  assert.deepEqual(listed.legacyIds, ["__proto__"]);
  assert.deepEqual(listed.models, ["prototype-model"]);
  assert.equal(listed.hasKey, false);
  assert.equal(h.secrets.keys[listed.id], undefined);
  assert.deepEqual(
    (await readJson<{ byProvider: Record<string, unknown> }>(h.cacheFile)).byProvider[listed.id],
    { models: ["prototype-model"] },
  );
});

test("relative workspace paths stay hidden and block local writes", async (t) => {
  const unsafe = {
    workspaces: [
      {
        id: "relative",
        name: "Relative",
        permission: "full",
        folderPath: ".",
        managedWorktree: {
          repositoryPath: ".",
          worktreePath: ".",
          branch: "main",
          createdFromHead: "abc",
        },
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    seeded: true,
    aidenDirMigratedAt: Date.now(),
  };
  const h = await harness(t, unsafe);

  assert.deepEqual(await h.store.listWorkspaces(), []);
  await assert.rejects(
    h.store.saveWorkspace({
      id: "safe",
      name: "Safe",
      permission: "ask",
      folderPath: "/safe",
      createdAt: 1,
      updatedAt: 1,
    }),
    /Config migration is deferred/u,
  );
  assert.deepEqual(await readJson(h.localFile), unsafe);
});

test("malformed known settings fields are dropped before type-assuming consumers", async (t) => {
  const h = await harness(t, {
    workspaces: [],
    seeded: true,
    aidenDirMigratedAt: Date.now(),
  });
  await fs.writeFile(
    h.settingsFile,
    JSON.stringify({
      settings: {
        profileName: { bad: true },
        exaEnabled: "yes",
        showLocalModelReasoning: "yes",
        lastProviderId: 7,
        futureSetting: { retained: true },
      },
    }),
    "utf-8",
  );

  assert.deepEqual(await h.store.getSettings(), {
    futureSetting: { retained: true },
  });
});

test("local reasoning visibility is a durable boolean presentation preference", async (t) => {
  const h = await harness(t);

  assert.equal((await h.store.getSettings()).showLocalModelReasoning, undefined);
  assert.equal(
    (await h.store.setSettings({ showLocalModelReasoning: false })).showLocalModelReasoning,
    false,
  );

  const next = createConfigStore(
    createPortableConfigStores(
      () => path.dirname(h.portableFile),
      () => path.dirname(h.localFile),
    ),
    fakeSecrets().port,
  );
  assert.equal((await next.getSettings()).showLocalModelReasoning, false);
});

test("future nested settings versions survive unrelated writes", async (t) => {
  const h = await harness(t, {
    workspaces: [],
    seeded: true,
    aidenDirMigratedAt: Date.now(),
  });
  const appearance = { version: 2, mode: "future", futurePalette: { accent: "#abcdef" } };
  const keybindings = {
    version: 2,
    commands: { "future.command": { binding: "Command+Shift+Y" } },
  };
  const assistant = { enabled: true, futureMode: "ambient" };
  const googleThinkingByModel = { "future-google": "ultra" };
  const codexThinkingByModel = { "future-codex": "ultra" };
  const anthropicThinkingByModel = { "future-anthropic": "ultra" };
  const providerThinkingByModel = { "future-provider": { "future-model": "ultra" } };
  await fs.writeFile(
    h.settingsFile,
    JSON.stringify({
      settings: {
        appearance,
        keybindings,
        assistant,
        voiceProvider: "future-voice",
        chatTitleProviderId: "future-title-policy",
        scheduledDefaultMode: "future-mode",
        scheduledDefaultPermission: "future-permission",
        googleThinkingByModel,
        codexThinkingByModel,
        anthropicThinkingByModel,
        providerThinkingByModel,
      },
    }),
    "utf-8",
  );

  await h.store.setSettings({ exaEnabled: true });

  const saved = (await readJson<{ settings: Record<string, unknown> }>(h.settingsFile)).settings;
  assert.deepEqual(saved.appearance, appearance);
  assert.deepEqual(saved.keybindings, keybindings);
  assert.equal((saved.assistant as Record<string, unknown>).futureMode, "ambient");
  assert.deepEqual(saved.googleThinkingByModel, googleThinkingByModel);
  assert.deepEqual(saved.codexThinkingByModel, codexThinkingByModel);
  assert.deepEqual(saved.anthropicThinkingByModel, anthropicThinkingByModel);
  assert.deepEqual(saved.providerThinkingByModel, providerThinkingByModel);
  assert.equal(saved.voiceProvider, "future-voice");
  assert.equal(saved.chatTitleProviderId, "future-title-policy");
  assert.equal(saved.scheduledDefaultMode, "future-mode");
  assert.equal(saved.scheduledDefaultPermission, "future-permission");
  assert.equal(saved.exaEnabled, true);

  const runtime = await h.store.getSettings();
  assert.equal((runtime.assistant as unknown as Record<string, unknown>).futureMode, undefined);
  assert.equal(runtime.googleThinkingByModel, undefined);
  assert.equal(runtime.codexThinkingByModel, undefined);
  assert.equal(runtime.anthropicThinkingByModel, undefined);
  assert.equal(runtime.providerThinkingByModel, undefined);
  assert.equal(runtime.voiceProvider, undefined);
  assert.equal(runtime.chatTitleProviderId, undefined);
  assert.equal(runtime.scheduledDefaultMode, undefined);
  assert.equal(runtime.scheduledDefaultPermission, undefined);

  await h.store.setSettings({ assistant: assistantConfig });
  await h.store.setGoogleThinkingLevel("known-google", "high");
  await h.store.setCodexThinkingLevel("known-codex", "xhigh");
  await h.store.setAnthropicThinkingLevel("known-anthropic", "max");
  await h.store.setProviderThinkingLevel("opencode-go", "ox-alpha-free", "high");

  const edited = (await readJson<{ settings: Record<string, unknown> }>(h.settingsFile)).settings;
  assert.equal((edited.assistant as Record<string, unknown>).futureMode, "ambient");
  assert.equal((edited.googleThinkingByModel as Record<string, unknown>)["future-google"], "ultra");
  assert.equal((edited.codexThinkingByModel as Record<string, unknown>)["future-codex"], "ultra");
  assert.equal(
    (edited.anthropicThinkingByModel as Record<string, unknown>)["future-anthropic"],
    "ultra",
  );
  assert.deepEqual((edited.providerThinkingByModel as Record<string, unknown>)["future-provider"], {
    "future-model": "ultra",
  });
  const editedRuntime = await h.store.getSettings();
  assert.equal(editedRuntime.googleThinkingByModel?.["known-google"], "high");
  assert.equal(editedRuntime.codexThinkingByModel?.["known-codex"], "xhigh");
  assert.equal(editedRuntime.anthropicThinkingByModel?.["known-anthropic"], "max");
  assert.equal(editedRuntime.providerThinkingByModel?.["opencode-go"]?.["ox-alpha-free"], "high");
});

test("editing MCP servers and skills preserves unknown future fields", async (t) => {
  const h = await harness(t, {
    workspaces: [],
    seeded: true,
    aidenDirMigratedAt: Date.now(),
  });
  await fs.mkdir(path.dirname(h.portableFile), { recursive: true });
  await fs.writeFile(
    h.portableFile,
    JSON.stringify({
      providers: [],
      providerIdAliases: {},
      mcpServers: [
        {
          id: "future-server",
          name: "Old",
          transport: "stdio",
          command: "old",
          enabled: true,
          futurePolicy: { mode: "strict" },
        },
      ],
      skills: [
        {
          id: "future-skill",
          name: "Old",
          description: "",
          instructions: "",
          enabled: true,
          futureMetadata: { owner: "newer-aiden" },
        },
      ],
    }),
    "utf-8",
  );

  await h.store.saveMcpServer({
    id: "future-server",
    name: "New",
    transport: "stdio",
    command: "new",
    enabled: true,
  });
  await h.store.saveSkill({
    id: "future-skill",
    name: "New",
    description: "",
    instructions: "updated",
    enabled: true,
  });

  const portable = await readJson<{
    mcpServers: Array<Record<string, unknown>>;
    skills: Array<Record<string, unknown>>;
  }>(h.portableFile);
  assert.deepEqual(portable.mcpServers[0].futurePolicy, { mode: "strict" });
  assert.deepEqual(portable.skills[0].futureMetadata, { owner: "newer-aiden" });
});

test("prototype-sensitive model IDs survive all thinking-preference reads and writes", async (t) => {
  const h = await harness(t, {
    workspaces: [],
    seeded: true,
    aidenDirMigratedAt: Date.now(),
  });
  await fs.writeFile(
    h.settingsFile,
    JSON.stringify({
      settings: {
        googleThinkingByModel: { ["__proto__"]: "high" },
        codexThinkingByModel: { ["__proto__"]: "xhigh" },
        anthropicThinkingByModel: { ["__proto__"]: "max" },
      },
    }),
    "utf-8",
  );

  const loaded = await h.store.getSettings();
  assert.equal(loaded.googleThinkingByModel?.["__proto__"], "high");
  assert.equal(loaded.codexThinkingByModel?.["__proto__"], "xhigh");
  assert.equal(loaded.anthropicThinkingByModel?.["__proto__"], "max");

  await h.store.setGoogleThinkingLevel("__proto__", "low");
  await h.store.setCodexThinkingLevel("__proto__", "medium");
  await h.store.setAnthropicThinkingLevel("__proto__", "off");

  const saved = await h.store.getSettings();
  assert.equal(saved.googleThinkingByModel?.["__proto__"], "low");
  assert.equal(saved.codexThinkingByModel?.["__proto__"], "medium");
  assert.equal(saved.anthropicThinkingByModel?.["__proto__"], "off");
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
  assert.equal(await h.store.portableConfigSafeForCredentialReconciliation(), false);
});

test("an already-migrated corrupt portable file cannot be overwritten by a UI write", async (t) => {
  const h = await harness(t, {
    workspaces: [],
    seeded: true,
    aidenDirMigratedAt: Date.now(),
  });
  await fs.mkdir(path.dirname(h.portableFile), { recursive: true });
  const broken = '{ "providers": [broken] }';
  await fs.writeFile(h.portableFile, broken, "utf-8");

  assert.deepEqual(await h.store.listSkills(), []);
  await assert.rejects(
    h.store.saveSkill({
      id: "blocked",
      name: "Blocked",
      description: "",
      instructions: "",
      enabled: true,
    }),
    /Config migration is deferred/u,
  );
  assert.equal(await fs.readFile(h.portableFile, "utf-8"), broken);
});

test("a JSON typo introduced after startup stays write-protected after reload", async (t) => {
  const h = await harness(t);
  await h.store.listSkills();
  const broken = '{ "providers": [broken after startup] }';
  await fs.writeFile(h.portableFile, broken, "utf-8");
  await h.stores.portable.reload();

  assert.deepEqual(await h.store.listSkills(), []);
  await assert.rejects(
    h.store.saveSkill({
      id: "blocked",
      name: "Blocked",
      description: "",
      instructions: "",
      enabled: true,
    }),
    /Portable config contains invalid JSON/u,
  );
  assert.equal(await fs.readFile(h.portableFile, "utf-8"), broken);
});

test("a JSON typo introduced after startup is blocked without an explicit reload", async (t) => {
  const h = await harness(t);
  await h.store.listSkills();
  const broken = '{ "providers": [broken while focused] }';
  await fs.writeFile(h.portableFile, broken, "utf-8");

  await assert.rejects(
    h.store.saveSkill({
      id: "blocked",
      name: "Blocked",
      description: "",
      instructions: "",
      enabled: true,
    }),
    /does not parse/u,
  );
  assert.equal(await fs.readFile(h.portableFile, "utf-8"), broken);
});

test("a write after a JSON typo is blocked without touching the source", async (t) => {
  const h = await harness(t);
  await fs.mkdir(path.dirname(h.portableFile), { recursive: true });
  const handWritten = '{ "providers": [broken] }';
  await fs.writeFile(h.portableFile, handWritten, "utf-8");

  await assert.rejects(
    h.store.saveSkill({
      id: "s1",
      name: "S",
      description: "d",
      instructions: "i",
      enabled: true,
    }),
    /Config migration is deferred/u,
  );

  const dir = path.dirname(h.portableFile);
  const preserved = (await fs.readdir(dir)).filter((n) => n.includes(".invalid-"));
  assert.equal(preserved.length, 0, "no replacement means no rescue copy is needed");
  assert.equal(await fs.readFile(h.portableFile, "utf-8"), handWritten);
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

test("cached credential safety checks do not consume an external reload signal", async (t) => {
  const h = await harness(t);
  await h.store.saveSkill({
    id: "first",
    name: "First",
    description: "",
    instructions: "",
    enabled: true,
  });
  const external = await readJson<Record<string, unknown>>(h.portableFile);
  await fs.writeFile(
    h.portableFile,
    JSON.stringify({
      ...external,
      skills: [
        ...((external.skills as unknown[]) ?? []),
        {
          id: "external",
          name: "External",
          description: "",
          instructions: "",
          enabled: true,
        },
      ],
    }),
    "utf-8",
  );

  assert.equal(await h.store.cachedPortableConfigSafeForCredentialReconciliation(), true);
  assert.equal(await h.stores.portable.reload(), true);
  assert.equal(await h.store.cachedPortableConfigSafeForCredentialReconciliation(), true);
});

test("portable mutations validate the resulting document before publication", async (t) => {
  const h = await harness(t);
  await h.store.listSkills();
  const before = await fs.readFile(h.portableFile, "utf-8");

  await assert.rejects(
    h.store.saveSkill({
      id: "   ",
      name: "Invalid",
      description: "",
      instructions: "",
      enabled: true,
    }),
    /invalid portable config/u,
  );
  await assert.rejects(
    h.store.saveMcpServer({
      id: "\t",
      name: "Invalid",
      transport: "stdio",
      enabled: true,
    }),
    /invalid portable config/u,
  );
  assert.equal(await fs.readFile(h.portableFile, "utf-8"), before);
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

test("a failed secret migration never blocks startup reads and retries later", async (t) => {
  const h = await harness(t);
  let calls = 0;
  const reports: Array<{ area: string; error: unknown }> = [];
  const flaky: SecretsPort = {
    async hasKey() {
      return false;
    },
    async deleteKey() {},
    async migrateKeys() {
      calls += 1;
      if (calls === 1) throw new Error("keychain locked");
    },
    async migrateProviderKeysWithBindings() {
      return true;
    },
  };
  const store = createConfigStore(h.stores, flaky, (area, error) => {
    reports.push({ area, error });
  });

  assert.deepEqual(await store.listSkills(), [], "malformed secrets cannot abort config startup");
  assert.equal(calls, 1);
  assert.equal(reports[0]?.area, "provider-secret-migration");
  assert.match(String(reports[0]?.error), /keychain locked/u);
  assert.deepEqual(await store.listSkills(), [], "a retry gets through");
  assert.equal(calls, 2);
});
