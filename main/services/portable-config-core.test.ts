import {
  ensurePrivateDirectory,
  ensurePrivateDirectoryAsync,
  hardenPrivateFile,
  hardenPrivateFileAsync,
} from "./private-storage.js";
// Migration tests for the ~/.aiden split.
//
// The load-bearing guarantee here is negative: once an install has migrated,
// deleting the portable config must yield defaults rather than resurrect the
// pre-migration snapshot. See "deleting the portable file after migration" below.

import assert from "node:assert/strict";
import fsSync from "node:fs";
import fsPromises, * as fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { createConfigStore, type SecretsPort } from "./config-store-core.js";
import {
  LEGACY_CONFIG_ARCHIVE_SUFFIX,
  LOCAL_CONFIG_FILENAME,
  PORTABLE_CONFIG_MAX_BYTES,
  PORTABLE_CONFIG_FILENAME,
  PORTABLE_README_FILENAME,
  PROVIDER_MODEL_CACHE_FILENAME,
  SETTINGS_FILENAME,
  composeStoredProvider,
  createPortableConfigStores,
  isProviderAliasMap,
  isMcpServer,
  isSkillList,
  isPortableProvider,
  splitStoredProvider,
  runtimeSettingsFrom,
} from "./portable-config-core.js";
import { CONFIGURED_SKILL_LIMITS } from "./skill-config-limits.js";
import { SLASH_LIMITS } from "../../renderer/shared/slash-commands.js";
import type { PortableConfigShape } from "./portable-config-core.js";
import type { StoredProvider, Workspace } from "./types.js";

interface Roots {
  portableRoot: string;
  localRoot: string;
  portableFile: string;
  localFile: string;
  settingsFile: string;
  cacheFile: string;
  readmeFile: string;
  archiveFile: string;
}

async function roots(t: test.TestContext): Promise<Roots> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-portable-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const portableRoot = path.join(base, "dot-aiden");
  const localRoot = path.join(base, "userData");
  await fs.mkdir(localRoot, { recursive: true });
  return {
    portableRoot,
    localRoot,
    portableFile: path.join(portableRoot, PORTABLE_CONFIG_FILENAME),
    localFile: path.join(localRoot, LOCAL_CONFIG_FILENAME),
    settingsFile: path.join(localRoot, SETTINGS_FILENAME),
    cacheFile: path.join(localRoot, PROVIDER_MODEL_CACHE_FILENAME),
    readmeFile: path.join(portableRoot, PORTABLE_README_FILENAME),
    archiveFile: path.join(localRoot, `${LOCAL_CONFIG_FILENAME}${LEGACY_CONFIG_ARCHIVE_SUFFIX}`),
  };
}

function stores(r: Roots) {
  return createPortableConfigStores(
    () => r.portableRoot,
    () => r.localRoot,
  );
}

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await fs.readFile(file, "utf-8")) as T;
}

async function missing(file: string): Promise<boolean> {
  try {
    await fs.stat(file);
    return false;
  } catch {
    return true;
  }
}

const provider: StoredProvider = {
  id: "custom-lmstudio",
  kind: "openai",
  label: "LM Studio",
  baseUrl: "http://localhost:1234/v1",
  models: ["qwen3-8b", "llama-3.1-8b"],
  modelMetadata: { "qwen3-8b": { source: "lmstudio", contextLength: 32_768 } },
  needsKey: false,
  deployment: "local",
  defaultModel: "qwen3-8b",
};

const workspace: Workspace = {
  id: "default",
  name: "Workspace",
  permission: "ask",
  folderPath: "/Users/someone/projects/thing",
  createdAt: 1,
  updatedAt: 2,
};

/** A pre-split userData/config.json with something in every field. */
function legacyConfig() {
  return {
    providers: [provider],
    providerIdAliases: { "old-id": "custom-lmstudio" },
    settings: { appearance: "dark", lastProviderId: "custom-lmstudio" },
    seeded: true,
    mcpServers: [
      {
        id: "fs",
        name: "Filesystem",
        transport: "stdio",
        command: "mcp-fs",
        enabled: true,
      },
    ],
    skills: [{ id: "s1", name: "Summarize", description: "d", instructions: "i", enabled: true }],
    workspaces: [workspace],
  };
}

test("configured skill lists enforce per-entry, count, and aggregate bounds", () => {
  const skill = (id: string, instructions = "i") => ({
    id,
    name: `Skill ${id}`,
    description: "",
    instructions,
    enabled: true,
  });
  assert.equal(
    isSkillList(
      Array.from({ length: CONFIGURED_SKILL_LIMITS.entries + 1 }, (_, index) =>
        skill(String(index)),
      ),
    ),
    false,
  );
  assert.equal(
    isSkillList([
      skill("oversized", "i".repeat(SLASH_LIMITS.instructionBytes + 1)),
    ]),
    false,
  );
  const aggregateInstruction = "i".repeat(SLASH_LIMITS.instructionBytes);
  const aggregateCount =
    Math.floor(CONFIGURED_SKILL_LIMITS.aggregateBytes / SLASH_LIMITS.instructionBytes) + 1;
  assert.equal(
    isSkillList(
      Array.from({ length: aggregateCount }, (_, index) =>
        skill(`aggregate-${index}`, aggregateInstruction),
      ),
    ),
    false,
  );
});

test("portable config ingestion with unsafe skill bounds publishes no skills", async (t) => {
  const r = await roots(t);
  await fs.mkdir(r.portableRoot, { recursive: true });
  await fs.writeFile(
    r.portableFile,
    JSON.stringify({
      providers: [],
      providerIdAliases: {},
      mcpServers: [],
      skills: [
        {
          id: "oversized",
          name: "Oversized",
          description: "",
          instructions: "i".repeat(SLASH_LIMITS.instructionBytes + 1),
          enabled: true,
        },
      ],
    }),
    "utf8",
  );

  const instance = stores(r);
  assert.deepEqual((await instance.portable.load()).skills, []);
  assert.equal(await instance.portable.loadedFromUnsafeFile(), true);
});

test("legacy migration defers instead of consuming over-bound skill lists", async (t) => {
  const scenarios = [
    {
      name: "count",
      skills: Array.from({ length: CONFIGURED_SKILL_LIMITS.entries + 1 }, (_, index) => ({
        id: `skill-${index}`,
        name: `Skill ${index}`,
        description: "",
        instructions: "i",
        enabled: true,
      })),
    },
    {
      name: "aggregate",
      skills: Array.from(
        {
          length:
            Math.floor(
              CONFIGURED_SKILL_LIMITS.aggregateBytes / SLASH_LIMITS.instructionBytes,
            ) + 1,
        },
        (_, index) => ({
          id: `skill-${index}`,
          name: `Skill ${index}`,
          description: "",
          instructions: "i".repeat(SLASH_LIMITS.instructionBytes),
          enabled: true,
        }),
      ),
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async (t) => {
      const r = await roots(t);
      await fs.writeFile(
        r.localFile,
        JSON.stringify({ ...legacyConfig(), skills: scenario.skills }),
        "utf8",
      );

      assert.equal(await stores(r).ensureMigrated(), false);
      assert.equal(await missing(r.portableFile), true);
      assert.equal(await missing(r.archiveFile), true);
      assert.equal((await readJson<{ skills: unknown[] }>(r.localFile)).skills.length, scenario.skills.length);
    });
  }
});

test("oversized portable and legacy config files fail before JSON ingestion", async (t) => {
  const oversized = JSON.stringify({
    providers: [],
    providerIdAliases: {},
    mcpServers: [],
    skills: [
      {
        id: "oversized",
        name: "Oversized",
        description: "",
        instructions: "i".repeat(PORTABLE_CONFIG_MAX_BYTES),
        enabled: true,
      },
    ],
  });

  await t.test("portable", async (t) => {
    const r = await roots(t);
    await fs.mkdir(r.portableRoot, { recursive: true });
    await fs.writeFile(r.portableFile, oversized, "utf8");
    const instance = stores(r);
    assert.deepEqual(await instance.portable.load(), {
      providers: [],
      providerIdAliases: {},
      mcpServers: [],
      skills: [],
    });
    assert.equal(await instance.portable.loadedFromCorruptFile(), true);
  });

  await t.test("legacy", async (t) => {
    const r = await roots(t);
    await fs.writeFile(r.localFile, oversized, "utf8");
    const instance = stores(r);
    assert.equal(await instance.ensureMigrated(), false);
    assert.equal(await instance.local.loadedFromCorruptFile(), true);
    assert.equal(await missing(r.archiveFile), true);
    assert.equal((await fs.stat(r.localFile)).size > PORTABLE_CONFIG_MAX_BYTES, true);
  });
});

async function writeLegacy(r: Roots): Promise<void> {
  await fs.writeFile(r.localFile, JSON.stringify(legacyConfig(), null, 2), "utf-8");
}

// ── Provider intent / cache split ────────────────────────────────────────────

test("splitStoredProvider separates portable intent from regenerable cache", () => {
  const { intent, cache } = splitStoredProvider(provider);
  assert.equal("models" in intent, false);
  assert.equal("modelMetadata" in intent, false);
  assert.equal(intent.baseUrl, provider.baseUrl);
  assert.deepEqual(cache.models, provider.models);
  assert.deepEqual(cache.modelMetadata, provider.modelMetadata);
});

test("splitStoredProvider carries only the cache keys the caller supplied", () => {
  const { models: _models, modelMetadata: _metadata, ...withoutCaches } = provider;
  const { cache } = splitStoredProvider(withoutCaches as StoredProvider);
  // Absent must stay absent so an upsert retains what is already cached rather
  // than blanking it.
  assert.equal("models" in cache, false);
  assert.equal("modelMetadata" in cache, false);
});

test("composeStoredProvider round-trips a provider through the split", () => {
  const { intent, cache } = splitStoredProvider(provider);
  assert.deepEqual(composeStoredProvider(intent, cache), provider);
});

test("composeStoredProvider yields an empty model list when nothing is cached", () => {
  const { intent } = splitStoredProvider(provider);
  const composed = composeStoredProvider(intent, undefined);
  assert.deepEqual(composed.models, []);
  assert.equal("modelMetadata" in composed, false);
});

test("composeStoredProvider ignores cache fields smuggled into portable intent", () => {
  const malformedIntent = {
    ...splitStoredProvider(provider).intent,
    models: ["portable-model"],
    modelMetadata: {
      "portable-model": { source: "provider", thinkingLevels: { length: 1 } },
    },
  };

  const composed = composeStoredProvider(malformedIntent, undefined);

  assert.deepEqual(composed.models, []);
  assert.equal(composed.modelMetadata, undefined);
});

test("credential-bearing config IDs share the journal length bound", () => {
  assert.equal(isPortableProvider({ ...splitStoredProvider(provider).intent, id: "p".repeat(257) }), false);
  assert.equal(
    isMcpServer({
      id: "m".repeat(257),
      name: "Too long",
      transport: "http",
      url: "https://mcp.example",
      enabled: true,
    }),
    false,
  );
});

// ── Migration ────────────────────────────────────────────────────────────────

test("migration writes the portable fields to the portable root", async (t) => {
  const r = await roots(t);
  await writeLegacy(r);
  await stores(r).ensureMigrated();

  const portable = await readJson<Record<string, unknown>>(r.portableFile);
  assert.deepEqual(portable.providerIdAliases, { "old-id": "custom-lmstudio" });
  assert.equal((portable.mcpServers as unknown[]).length, 1);
  assert.equal((portable.skills as unknown[]).length, 1);
  assert.deepEqual(portable.providers, [splitStoredProvider(provider).intent]);
});

test("partial portable migration imports legacy providers without replacing portable fields", async (t) => {
  const r = await roots(t);
  await fs.mkdir(r.portableRoot, { recursive: true });
  await fs.writeFile(
    r.portableFile,
    JSON.stringify(
      {
        mcpServers: [
          {
            id: "mine",
            name: "Mine",
            transport: "stdio",
            command: "mine",
            enabled: true,
          },
        ],
        skills: [],
      },
      null,
      2,
    ),
    "utf-8",
  );
  await writeLegacy(r);

  await stores(r).ensureMigrated();

  const portable = await readJson<PortableConfigShape>(r.portableFile);
  assert.deepEqual(portable.providers, [splitStoredProvider(provider).intent]);
  assert.deepEqual(portable.mcpServers, [
    {
      id: "mine",
      name: "Mine",
      transport: "stdio",
      command: "mine",
      enabled: true,
    },
  ]);
  assert.deepEqual(
    (await readJson<{ byProvider: Record<string, unknown> }>(r.cacheFile)).byProvider[provider.id],
    splitStoredProvider(provider).cache,
  );
});

test("partial portable migration repairs each missing field and restores matching cache", async (t) => {
  const r = await roots(t);
  await fs.mkdir(r.portableRoot, { recursive: true });
  const existingIntent = splitStoredProvider(provider).intent;
  await fs.writeFile(
    r.portableFile,
    JSON.stringify({ providers: [existingIntent] }, null, 2),
    "utf-8",
  );
  await writeLegacy(r);

  await stores(r).ensureMigrated();

  const portable = await readJson<PortableConfigShape>(r.portableFile);
  assert.deepEqual(portable.providers, [existingIntent]);
  assert.deepEqual(portable.providerIdAliases, { "old-id": "custom-lmstudio" });
  assert.deepEqual(portable.mcpServers, legacyConfig().mcpServers);
  assert.deepEqual(portable.skills, legacyConfig().skills);
  assert.deepEqual(
    (await readJson<{ byProvider: Record<string, unknown> }>(r.cacheFile)).byProvider[provider.id],
    splitStoredProvider(provider).cache,
  );
});

test("complete portable migration restores a missing matching cache before retiring legacy data", async (t) => {
  const r = await roots(t);
  await fs.mkdir(r.portableRoot, { recursive: true });
  await fs.writeFile(
    r.portableFile,
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
  await writeLegacy(r);

  await stores(r).ensureMigrated();

  assert.deepEqual(
    (await readJson<{ byProvider: Record<string, unknown> }>(r.cacheFile)).byProvider[provider.id],
    splitStoredProvider(provider).cache,
  );
  assert.equal(await missing(r.archiveFile), false);
});

test("migration never attaches a legacy cache to a same-id provider at another endpoint", async (t) => {
  const r = await roots(t);
  await fs.mkdir(r.portableRoot, { recursive: true });
  const copiedIntent = {
    ...splitStoredProvider(provider).intent,
    baseUrl: "http://different-host:1234/v1",
  };
  await fs.writeFile(
    r.portableFile,
    JSON.stringify(
      {
        providers: [copiedIntent],
        providerIdAliases: {},
        mcpServers: [],
        skills: [],
      },
      null,
      2,
    ),
    "utf-8",
  );
  await writeLegacy(r);
  const bundle = stores(r);

  await bundle.ensureMigrated();

  assert.deepEqual((await bundle.modelCache.load()).byProvider, {});
});

test("first-upgrade migration regenerates a malformed model-cache root", async (t) => {
  const r = await roots(t);
  await writeLegacy(r);
  await fs.writeFile(r.cacheFile, "null", "utf-8");
  const bundle = stores(r);

  await bundle.ensureMigrated();

  assert.deepEqual(
    (await bundle.modelCache.load()).byProvider[provider.id],
    splitStoredProvider(provider).cache,
  );
});

test("first-upgrade migration replaces an empty normalized cache entry from legacy data", async (t) => {
  const r = await roots(t);
  await writeLegacy(r);
  await fs.writeFile(
    r.cacheFile,
    JSON.stringify({ byProvider: { [provider.id]: { models: "bad" } } }),
    "utf-8",
  );
  const bundle = stores(r);

  await bundle.ensureMigrated();

  assert.deepEqual(
    (await bundle.modelCache.load()).byProvider[provider.id],
    splitStoredProvider(provider).cache,
  );
});

test("malformed portable roots are preserved and defer retiring valid legacy data", async (t) => {
  for (const malformed of [null, []] as const) {
    const r = await roots(t);
    await fs.mkdir(r.portableRoot, { recursive: true });
    const raw = JSON.stringify(malformed, null, 2);
    await fs.writeFile(r.portableFile, raw, "utf-8");
    await writeLegacy(r);

    await stores(r).ensureMigrated();

    assert.equal(await fs.readFile(r.portableFile, "utf-8"), raw);
    assert.equal(await missing(r.archiveFile), true);
    assert.equal(
      "aidenDirMigratedAt" in (await readJson<Record<string, unknown>>(r.localFile)),
      false,
    );
  }
});

test("malformed portable providers defer migration without retiring legacy data", async (t) => {
  const r = await roots(t);
  await fs.mkdir(r.portableRoot, { recursive: true });
  const malformed = JSON.stringify(
    { providers: [null], providerIdAliases: {}, mcpServers: [], skills: [] },
    null,
    2,
  );
  await fs.writeFile(r.portableFile, malformed, "utf-8");
  await writeLegacy(r);

  await stores(r).ensureMigrated();

  assert.equal(await fs.readFile(r.portableFile, "utf-8"), malformed);
  assert.equal(await missing(r.archiveFile), true);
  const local = await readJson<Record<string, unknown>>(r.localFile);
  assert.deepEqual(local.providers, [provider]);
  assert.equal("aidenDirMigratedAt" in local, false);
});

test("active provider IDs cannot also redirect through the alias map", async (t) => {
  const r = await roots(t);
  await fs.mkdir(r.portableRoot, { recursive: true });
  const intent = splitStoredProvider(provider).intent;
  const raw = JSON.stringify(
    {
      providers: [intent],
      providerIdAliases: { [intent.id]: "custom:replacement" },
      mcpServers: [],
      skills: [],
    },
    null,
    2,
  );
  await fs.writeFile(r.portableFile, raw, "utf-8");
  await writeLegacy(r);

  assert.equal(await stores(r).ensureMigrated(), false);
  assert.equal(await fs.readFile(r.portableFile, "utf-8"), raw);
  assert.equal(await missing(r.archiveFile), true);
  assert.equal(
    "aidenDirMigratedAt" in (await readJson<Record<string, unknown>>(r.localFile)),
    false,
  );
});

test("provider alias validation is bounded and resolves accepted chains linearly", () => {
  const accepted = Object.fromEntries(
    Array.from({ length: 256 }, (_, index) => [
      `legacy-${index}`,
      index === 255 ? "custom:terminal" : `legacy-${index + 1}`,
    ]),
  );
  assert.equal(isProviderAliasMap(accepted), true);
  const tooDeep = {
    ...accepted,
    "legacy-255": "legacy-256",
    "legacy-256": "custom:terminal",
  };
  assert.equal(isProviderAliasMap(tooDeep), false);
  const tooMany = Object.fromEntries(
    Array.from({ length: 4_097 }, (_, index) => [
      `old-${index}`,
      `custom:provider-${index}`,
    ]),
  );
  assert.equal(isProviderAliasMap(tooMany), false);
});

test("portable provider URLs reject embedded credentials and URL-only state", async (t) => {
  for (const baseUrl of [
    "https://user:secret@example.com/v1",
    "https://example.com/v1?token=secret",
    "https://example.com/v1#token",
  ]) {
    const r = await roots(t);
    await fs.mkdir(r.portableRoot, { recursive: true });
    const raw = JSON.stringify({
      providers: [{ ...splitStoredProvider(provider).intent, baseUrl }],
      providerIdAliases: {},
      mcpServers: [],
      skills: [],
    });
    await fs.writeFile(r.portableFile, raw, "utf-8");
    await writeLegacy(r);

    assert.equal(await stores(r).ensureMigrated(), false);
    assert.equal(await fs.readFile(r.portableFile, "utf-8"), raw);
    assert.equal(await missing(r.archiveFile), true);
  }
});

test("legacy provider URLs with embedded credentials defer without retiring the source", async (t) => {
  const r = await roots(t);
  const legacy = {
    ...legacyConfig(),
    providers: [{ ...provider, baseUrl: "https://user:secret@example.com/v1" }],
  };
  const raw = JSON.stringify(legacy, null, 2);
  await fs.writeFile(r.localFile, raw, "utf-8");

  assert.equal(await stores(r).ensureMigrated(), false);
  assert.equal(await fs.readFile(r.localFile, "utf-8"), raw);
  assert.equal(await missing(r.archiveFile), true);
  assert.equal(await missing(r.portableFile), true);
});

test("duplicate portable provider IDs defer migration instead of sharing one cache identity", async (t) => {
  const r = await roots(t);
  await fs.mkdir(r.portableRoot, { recursive: true });
  const intent = splitStoredProvider(provider).intent;
  const duplicate = {
    ...intent,
    baseUrl: "http://different-host:1234/v1",
  };
  const raw = JSON.stringify(
    {
      providers: [intent, duplicate],
      providerIdAliases: {},
      mcpServers: [],
      skills: [],
    },
    null,
    2,
  );
  await fs.writeFile(r.portableFile, raw, "utf-8");
  await writeLegacy(r);

  await stores(r).ensureMigrated();

  assert.equal(await fs.readFile(r.portableFile, "utf-8"), raw);
  assert.equal(await missing(r.archiveFile), true);
  assert.equal(
    "aidenDirMigratedAt" in (await readJson<Record<string, unknown>>(r.localFile)),
    false,
  );
});

test("legacy providers salvage valid intent while dropping malformed optional metadata", async (t) => {
  const r = await roots(t);
  const malformedMetadataProvider = {
    ...provider,
    id: "custom-malformed-metadata",
    modelMetadata: {
      broken: { source: "provider", thinkingLevels: { length: 1 } },
    },
  };
  await fs.writeFile(
    r.localFile,
    JSON.stringify(
      { providers: [null, malformedMetadataProvider], seeded: true, workspaces: [] },
      null,
      2,
    ),
    "utf-8",
  );

  await stores(r).ensureMigrated();

  assert.deepEqual((await readJson<PortableConfigShape>(r.portableFile)).providers, [
    splitStoredProvider({
      ...provider,
      id: "custom-malformed-metadata",
      modelMetadata: undefined,
    }).intent,
  ]);
  assert.deepEqual((await readJson<{ providers: unknown[] }>(r.archiveFile)).providers, [
    null,
    malformedMetadataProvider,
  ]);
});

test("legacy migration salvages valid siblings from mixed malformed lists", async (t) => {
  const r = await roots(t);
  const legacy = legacyConfig();
  await fs.writeFile(
    r.localFile,
    JSON.stringify(
      {
        ...legacy,
        providers: [provider, null],
        mcpServers: [...legacy.mcpServers, null],
        skills: [...legacy.skills, null],
      },
      null,
      2,
    ),
    "utf-8",
  );

  await stores(r).ensureMigrated();

  const portable = await readJson<PortableConfigShape>(r.portableFile);
  assert.deepEqual(portable.providers, [splitStoredProvider(provider).intent]);
  assert.deepEqual(portable.mcpServers, legacy.mcpServers);
  assert.deepEqual(portable.skills, legacy.skills);
  const archived = await readJson<{
    providers: unknown[];
    mcpServers: unknown[];
    skills: unknown[];
  }>(r.archiveFile);
  assert.equal(archived.providers[archived.providers.length - 1], null);
  assert.equal(archived.mcpServers[archived.mcpServers.length - 1], null);
  assert.equal(archived.skills[archived.skills.length - 1], null);
});

test("legacy migration removes blank and duplicate model IDs without dropping the provider", async (t) => {
  const r = await roots(t);
  await fs.writeFile(
    r.localFile,
    JSON.stringify({
      ...legacyConfig(),
      providers: [
        {
          ...provider,
          models: ["", "qwen3-8b", "qwen3-8b", 7],
        },
      ],
    }),
    "utf-8",
  );

  const bundle = stores(r);
  await bundle.ensureMigrated();

  assert.deepEqual((await bundle.modelCache.load()).byProvider[provider.id]?.models, ["qwen3-8b"]);
});

test("legacy providers survive absent or malformed model lists", async (t) => {
  for (const variant of ["absent", "malformed"] as const) {
    const r = await roots(t);
    const candidate: Record<string, unknown> = {
      ...provider,
      modelMetadata: undefined,
    };
    if (variant === "absent") delete candidate.models;
    else candidate.models = "not-an-array";
    await fs.writeFile(
      r.localFile,
      JSON.stringify({ ...legacyConfig(), providers: [candidate] }),
      "utf-8",
    );

    const bundle = stores(r);
    assert.equal(await bundle.ensureMigrated(), true);
    assert.deepEqual((await readJson<PortableConfigShape>(r.portableFile)).providers, [
      splitStoredProvider(provider).intent,
    ]);
    assert.deepEqual((await bundle.modelCache.load()).byProvider[provider.id]?.models, []);
  }
});

test("migration keeps model caches out of the hand-editable file", async (t) => {
  const r = await roots(t);
  await writeLegacy(r);
  await stores(r).ensureMigrated();

  const raw = await fs.readFile(r.portableFile, "utf-8");
  assert.equal(raw.includes("modelMetadata"), false);
  assert.equal(raw.includes("qwen3-8b"), true, "defaultModel is intent and stays portable");
  assert.equal(raw.includes("llama-3.1-8b"), false, "discovered models are not intent");

  const cache = await readJson<{ byProvider: Record<string, unknown> }>(r.cacheFile);
  assert.deepEqual(cache.byProvider["custom-lmstudio"], {
    models: provider.models,
    modelMetadata: provider.modelMetadata,
  });
});

test("migration extracts UI settings into settings.json", async (t) => {
  const r = await roots(t);
  await writeLegacy(r);
  await stores(r).ensureMigrated();

  assert.deepEqual(await readJson(r.settingsFile), {
    settings: { appearance: "dark", lastProviderId: "custom-lmstudio" },
  });
});

test("workspaces stay machine-local because their paths only resolve here", async (t) => {
  const r = await roots(t);
  await writeLegacy(r);
  await stores(r).ensureMigrated();

  const local = await readJson<Record<string, unknown>>(r.localFile);
  assert.deepEqual(local.workspaces, [workspace]);
  const portable = await fs.readFile(r.portableFile, "utf-8");
  assert.equal(portable.includes("workspaces"), false);
  assert.equal(portable.includes(workspace.folderPath!), false);
});

test("the migration marker is separate from the pre-existing seeded flag", async (t) => {
  const r = await roots(t);
  await writeLegacy(r);
  await stores(r).ensureMigrated();

  const local = await readJson<{ seeded: boolean; aidenDirMigratedAt: number }>(r.localFile);
  assert.equal(local.seeded, true, "seeded still means what it meant before");
  assert.equal(typeof local.aidenDirMigratedAt, "number");
});

test("migration seeds a README describing the folder", async (t) => {
  const r = await roots(t);
  await writeLegacy(r);
  await stores(r).ensureMigrated();

  const readme = await fs.readFile(r.readmeFile, "utf-8");
  assert.match(readme, /# ~\/\.aiden/);
  assert.match(readme, /API keys and OAuth tokens/, "explains why hasKey is false elsewhere");
  assert.match(readme, /separate from the `skills` array/, "disambiguates the two skill systems");
});

test("migration never overwrites a README the user has edited", async (t) => {
  const r = await roots(t);
  await fs.mkdir(r.portableRoot, { recursive: true });
  await fs.writeFile(r.readmeFile, "mine", "utf-8");
  await writeLegacy(r);
  await stores(r).ensureMigrated();

  assert.equal(await fs.readFile(r.readmeFile, "utf-8"), "mine");
});

test("migration never follows or overwrites an existing README symlink", async (t) => {
  const r = await roots(t);
  await fs.mkdir(r.portableRoot, { recursive: true });
  const target = path.join(r.localRoot, "readme-target.md");
  await fs.writeFile(target, "external", "utf-8");
  await fs.symlink(target, r.readmeFile);
  await writeLegacy(r);

  await stores(r).ensureMigrated();

  assert.equal(await fs.readFile(target, "utf-8"), "external");
  assert.equal((await fs.lstat(r.readmeFile)).isSymbolicLink(), true);
});

test("migration archives the pre-split config instead of leaving it readable", async (t) => {
  const r = await roots(t);
  await writeLegacy(r);
  await stores(r).ensureMigrated();

  const archived = await readJson<Record<string, unknown>>(r.archiveFile);
  assert.equal((archived.providers as unknown[]).length, 1, "the original is kept for safety");
  const local = await readJson<Record<string, unknown>>(r.localFile);
  assert.equal("providers" in local, false, "but config.json no longer holds portable fields");
  assert.equal("settings" in local, false);
  assert.equal("skills" in local, false);
  assert.equal(
    (await fs.readdir(r.localRoot)).some(
      (name) => name.startsWith(`.${path.basename(r.archiveFile)}.`) && name.endsWith(".tmp"),
    ),
    false,
    "atomic archive publication leaves no staging file",
  );
});

test("migration preserves unknown top-level local state in the active local file", async (t) => {
  const r = await roots(t);
  const legacy = {
    ...legacyConfig(),
    futureLocalState: {
      version: 9,
      machineLease: "keep-active",
    },
  };
  await fs.writeFile(r.localFile, JSON.stringify(legacy, null, 2), "utf-8");

  assert.equal(await stores(r).ensureMigrated(), true);

  const local = await readJson<Record<string, unknown>>(r.localFile);
  assert.deepEqual(local.futureLocalState, legacy.futureLocalState);
  assert.equal("providers" in local, false);
  assert.equal("settings" in local, false);
  assert.equal("mcpServers" in local, false);
  assert.equal("skills" in local, false);
  assert.equal(typeof local.aidenDirMigratedAt, "number");
});

test("a fresh install with no legacy file still gets a portable config", async (t) => {
  const r = await roots(t);
  await stores(r).ensureMigrated();

  assert.deepEqual(await readJson(r.portableFile), {
    providers: [],
    providerIdAliases: {},
    mcpServers: [],
    skills: [],
  });
  assert.equal(await missing(r.readmeFile), false);
  assert.equal(await missing(r.archiveFile), true, "nothing to archive");
  const local = await readJson<{ seeded: boolean }>(r.localFile);
  assert.equal(local.seeded, false, "a fresh install has not seeded providers yet");
});

test("migration is idempotent across processes", async (t) => {
  const r = await roots(t);
  await writeLegacy(r);
  await stores(r).ensureMigrated();
  const first = await fs.readFile(r.portableFile, "utf-8");
  const firstLocal = await readJson<{ aidenDirMigratedAt: number }>(r.localFile);

  // A second store bundle stands in for the next app launch.
  await stores(r).ensureMigrated();

  assert.equal(await fs.readFile(r.portableFile, "utf-8"), first);
  assert.equal(
    (await readJson<{ aidenDirMigratedAt: number }>(r.localFile)).aidenDirMigratedAt,
    firstLocal.aidenDirMigratedAt,
    "the marker is not rewritten, so migration truly did not re-run",
  );
});

test("migration leaves a hand-edited portable config alone", async (t) => {
  const r = await roots(t);
  await fs.mkdir(r.portableRoot, { recursive: true });
  const handWritten = {
    providers: [],
    providerIdAliases: {},
    mcpServers: [
      {
        id: "mine",
        name: "Mine",
        transport: "stdio",
        command: "x",
        enabled: true,
      },
    ],
    skills: [],
  };
  await fs.writeFile(r.portableFile, JSON.stringify(handWritten, null, 2), "utf-8");
  await writeLegacy(r);

  await stores(r).ensureMigrated();

  assert.deepEqual(await readJson(r.portableFile), handWritten);
});

// The regression that motivated archiving the legacy file. Without it, absence of
// the portable config re-runs migration against the stale pre-split snapshot and
// resurrects every provider, MCP server, and skill removed since.
test("deleting the portable file after migration yields defaults, not the old snapshot", async (t) => {
  const r = await roots(t);
  await writeLegacy(r);
  const first = stores(r);
  await first.ensureMigrated();

  // The user removes a provider, then later deletes ~/.aiden/config.json to
  // start over.
  await first.portable.update((config) => void (config.providers = []));
  await fs.rm(r.portableFile);

  const next = stores(r);
  await next.ensureMigrated();

  assert.deepEqual(await next.portable.load(), {
    providers: [],
    providerIdAliases: {},
    mcpServers: [],
    skills: [],
  });
});

test("a crash between archiving and slimming still converges on the next launch", async (t) => {
  const r = await roots(t);
  await writeLegacy(r);

  // Simulate the interrupted state: the archive exists, the legacy file has not
  // been slimmed, and no marker was written.
  await fs.copyFile(r.localFile, r.archiveFile);

  await stores(r).ensureMigrated();

  const local = await readJson<Record<string, unknown>>(r.localFile);
  assert.deepEqual(local.workspaces, [workspace], "the user's workspaces are not lost");
  assert.equal(typeof local.aidenDirMigratedAt, "number");
  const archived = await readJson<Record<string, unknown>>(r.archiveFile);
  assert.equal((archived.providers as unknown[]).length, 1, "the archive still holds the original");
});

test("a legacy edit after archive publication stays live and is recovered on retry", async (t) => {
  const r = await roots(t);
  await writeLegacy(r);
  const originalHandle = await fs.open(r.localFile, "r+");
  const editedLegacy = {
    ...legacyConfig(),
    settings: {
      ...legacyConfig().settings,
      profileName: "Late settings edit",
      scheduledTasksEnabled: true,
      assistant: {
        appearance: "dark",
        lateLegacyField: "recover me",
      },
    },
    skills: [
      ...legacyConfig().skills,
      {
        id: "late-edit",
        name: "Late edit",
        description: "",
        instructions: "preserve me",
        enabled: true,
      },
    ],
  };
  const editedBytes = JSON.stringify(editedLegacy, null, 2);
  let hookRuns = 0;
  const interrupted = createPortableConfigStores(
    () => r.portableRoot,
    () => r.localRoot,
    {
      beforeLocalProtectedPublish: async () => {
        hookRuns += 1;
        await originalHandle.truncate(0);
        await originalHandle.writeFile(editedBytes, "utf-8");
        await originalHandle.sync();
      },
    },
  );

  assert.equal(await interrupted.ensureMigrated(), false);
  assert.equal(hookRuns, 1);
  assert.equal(await fs.readFile(r.localFile, "utf-8"), editedBytes);
  await originalHandle.close();

  const splitSettings = await readJson<{
    settings: Record<string, unknown>;
  }>(r.settingsFile);
  splitSettings.settings.profileName = "Newer split edit";
  splitSettings.settings.assistant = {
    appearance: "light",
    futureField: { version: 9 },
  };
  await fs.writeFile(r.settingsFile, JSON.stringify(splitSettings, null, 2), "utf-8");

  assert.equal(await stores(r).ensureMigrated(), true);
  const recoveryNames = (await fs.readdir(r.localRoot)).filter((name) =>
    name.startsWith(`${path.basename(r.archiveFile)}.recovery-`),
  );
  assert.equal(recoveryNames.length, 1);
  assert.equal(await fs.readFile(path.join(r.localRoot, recoveryNames[0]), "utf-8"), editedBytes);
  assert.equal(
    (await readJson<PortableConfigShape>(r.portableFile)).skills.some(
      (skill) => skill.id === "late-edit",
    ),
    true,
    "the retry surfaces a non-conflicting edit made after the first portable publication",
  );
  const recoveredSettings = (
    await readJson<{
      settings: {
        profileName?: string;
        scheduledTasksEnabled?: boolean;
        assistant?: Record<string, unknown>;
      };
    }>(r.settingsFile)
  ).settings;
  assert.equal(
    recoveredSettings.profileName,
    "Newer split edit",
    "a newer split setting wins a conflicting late legacy edit",
  );
  assert.equal(
    recoveredSettings.scheduledTasksEnabled,
    true,
    "a non-conflicting late legacy setting is still recovered",
  );
  assert.deepEqual(recoveredSettings.assistant, {
    appearance: "light",
    futureField: { version: 9 },
    lateLegacyField: "recover me",
  });
});

test("a legacy edit between split publication and archive creation is recovered on retry", async (t) => {
  const r = await roots(t);
  await writeLegacy(r);
  const originalBytes = await fs.readFile(r.localFile, "utf-8");
  const editedLegacy = {
    ...legacyConfig(),
    skills: [
      ...legacyConfig().skills,
      {
        id: "between-split-and-archive",
        name: "Late archive edit",
        description: "",
        instructions: "recover this edit",
        enabled: true,
      },
    ],
  };
  const editedBytes = JSON.stringify(editedLegacy, null, 2);
  let hookRuns = 0;
  const interrupted = createPortableConfigStores(
    () => r.portableRoot,
    () => r.localRoot,
    {
      beforeLegacyArchive: async () => {
        hookRuns += 1;
        await fs.writeFile(r.localFile, editedBytes, "utf-8");
      },
    },
  );

  assert.equal(await interrupted.ensureMigrated(), false);
  assert.equal(hookRuns, 1);
  assert.equal(await fs.readFile(r.archiveFile, "utf-8"), originalBytes);
  assert.equal(await fs.readFile(r.localFile, "utf-8"), editedBytes);

  assert.equal(await stores(r).ensureMigrated(), true);
  assert.equal(
    (await readJson<PortableConfigShape>(r.portableFile)).skills.some(
      (skill) => skill.id === "between-split-and-archive",
    ),
    true,
  );
});

// A retry may find the slimmed file at config.json; copying that over a good
// archive would destroy the only remaining copy of the legacy fields.
test("an existing archive is never overwritten", async (t) => {
  const r = await roots(t);
  await writeLegacy(r);
  await fs.writeFile(r.archiveFile, JSON.stringify({ providers: ["precious"] }), "utf-8");

  await stores(r).ensureMigrated();

  assert.deepEqual(await readJson(r.archiveFile), { providers: ["precious"] });
});

test("an unusable older archive gets a second complete recovery copy before slimming", async (t) => {
  for (const variant of ["truncated", "empty", "directory"] as const) {
    const r = await roots(t);
    await writeLegacy(r);
    const completeLegacy = await fs.readFile(r.localFile);
    if (variant === "directory") {
      await fs.mkdir(r.archiveFile);
    } else {
      await fs.writeFile(r.archiveFile, variant === "truncated" ? "{partial" : "", "utf-8");
    }

    assert.equal(await stores(r).ensureMigrated(), true);

    const recoveryNames = (await fs.readdir(r.localRoot)).filter((name) =>
      name.startsWith(`${path.basename(r.archiveFile)}.recovery-`),
    );
    assert.equal(recoveryNames.length, 1);
    assert.equal(
      (await fs.readFile(path.join(r.localRoot, recoveryNames[0]))).equals(completeLegacy),
      true,
      `${variant} archive still gets a complete recovery copy`,
    );
    const local = await readJson<{ aidenDirMigratedAt: number }>(r.localFile);
    assert.equal(typeof local.aidenDirMigratedAt, "number");
    if (variant === "directory") {
      assert.equal((await fs.stat(r.archiveFile)).isDirectory(), true);
    } else {
      assert.equal(
        await fs.readFile(r.archiveFile, "utf-8"),
        variant === "truncated" ? "{partial" : "",
      );
    }
  }
});

test("a complete recovery archive prevents resurrection through an unusable canonical archive", async (t) => {
  const r = await roots(t);
  await writeLegacy(r);
  await fs.mkdir(r.portableRoot, { recursive: true });
  await fs.writeFile(
    r.portableFile,
    JSON.stringify({
      providers: [],
      providerIdAliases: {},
      mcpServers: [],
      skills: [],
    }),
    "utf-8",
  );
  await fs.writeFile(r.archiveFile, "{truncated", "utf-8");
  await fs.copyFile(r.localFile, `${r.archiveFile}.recovery-complete`);

  assert.equal(await stores(r).ensureMigrated(), true);
  assert.deepEqual(await readJson<PortableConfigShape>(r.portableFile), {
    providers: [],
    providerIdAliases: {},
    mcpServers: [],
    skills: [],
  });
});

test("an invalid UTF-8 archive cannot authorize stale legacy resurrection", async (t) => {
  const r = await roots(t);
  await fs.writeFile(
    r.localFile,
    JSON.stringify({
      ...legacyConfig(),
      skills: [
        {
          id: "stale-skill",
          name: "Stale",
          description: "",
          instructions: "must not return",
          enabled: true,
        },
      ],
    }),
    "utf-8",
  );
  await fs.mkdir(r.portableRoot, { recursive: true });
  await fs.writeFile(
    r.portableFile,
    JSON.stringify({
      providers: [],
      providerIdAliases: {},
      mcpServers: [],
      skills: [],
    }),
    "utf-8",
  );
  await fs.writeFile(
    r.archiveFile,
    Buffer.concat([
      Buffer.from('{"apparentlyUsable":"', "utf-8"),
      Buffer.from([0x80]),
      Buffer.from('"}', "utf-8"),
    ]),
  );

  assert.equal(await stores(r).ensureMigrated(), true);
  assert.deepEqual((await readJson<PortableConfigShape>(r.portableFile)).skills, []);
});

test("retry reuses an existing complete recovery archive", async (t) => {
  const r = await roots(t);
  await writeLegacy(r);
  const completeLegacy = await fs.readFile(r.localFile);
  await fs.writeFile(r.archiveFile, "{partial", "utf-8");
  const recovery = `${r.archiveFile}.recovery-existing`;
  await fs.writeFile(recovery, completeLegacy);

  assert.equal(await stores(r).ensureMigrated(), true);

  const recoveryNames = (await fs.readdir(r.localRoot)).filter((name) =>
    name.startsWith(`${path.basename(r.archiveFile)}.recovery-`),
  );
  assert.deepEqual(recoveryNames, [path.basename(recovery)]);
  assert.equal((await fs.readFile(recovery)).equals(completeLegacy), true);
});

test("an archive symlink blocks migration without changing the linked legacy bytes", async (t) => {
  const r = await roots(t);
  await writeLegacy(r);
  const completeLegacy = await fs.readFile(r.localFile);
  await fs.symlink(r.localFile, r.archiveFile);
  const bundle = stores(r);
  assert.equal(await bundle.ensureMigrated(), false);
  await assert.rejects(bundle.local.load(), /storage must be a private/u);
  assert.equal((await fs.readFile(r.localFile)).equals(completeLegacy), true);
  assert.equal((await fs.lstat(r.archiveFile)).isSymbolicLink(), true);
});

test("a corrupt portable file is treated as present, so migration cannot clobber it", async (t) => {
  const r = await roots(t);
  await fs.mkdir(r.portableRoot, { recursive: true });
  await fs.writeFile(r.portableFile, "{ definitely not json", "utf-8");
  await writeLegacy(r);

  await stores(r).ensureMigrated();

  assert.equal(
    await fs.readFile(r.portableFile, "utf-8"),
    "{ definitely not json",
    "the user gets a chance to fix their typo rather than losing the file",
  );
  assert.equal(await missing(r.archiveFile), true);
  assert.equal(
    "aidenDirMigratedAt" in (await readJson<Record<string, unknown>>(r.localFile)),
    false,
  );
});

test("a dangling portable config symlink defers migration without blocking startup", async (t) => {
  const r = await roots(t);
  await fs.mkdir(r.portableRoot, { recursive: true });
  await fs.symlink(path.join(r.portableRoot, "missing-target.json"), r.portableFile);
  await writeLegacy(r);

  assert.equal(await stores(r).ensureMigrated(), false);
  assert.equal((await fs.lstat(r.portableFile)).isSymbolicLink(), true);
  assert.equal(await missing(r.archiveFile), true);
  assert.equal(
    "aidenDirMigratedAt" in (await readJson<Record<string, unknown>>(r.localFile)),
    false,
  );
});

test("an unusable portable root defers migration while local settings remain readable", async (t) => {
  const r = await roots(t);
  await fs.symlink(path.join(path.dirname(r.portableRoot), "missing-root"), r.portableRoot);
  const bundle = stores(r);

  assert.equal(await bundle.ensureMigrated(), false);
  assert.deepEqual(await bundle.settings.load(), { settings: {} });
  assert.deepEqual(await bundle.local.load(), { workspaces: [], seeded: false });
  assert.equal((await fs.lstat(r.portableRoot)).isSymbolicLink(), true);
});

test("settings persistence preserves future assistant fields and values", async (t) => {
  const r = await roots(t);
  const future = {
    settings: {
      assistant: {
        version: 99,
        model: { providerId: "future-provider", modelId: "future-model" },
        permission: "future-permission",
        futureToggle: "keep-me",
      },
      profileName: "Before",
    },
  };
  await fs.writeFile(r.settingsFile, JSON.stringify(future), "utf-8");
  const bundle = stores(r);
  await bundle.settings.update((document) => {
    document.settings.profileName = "After";
  });

  const saved = await readJson<typeof future>(r.settingsFile);
  assert.deepEqual(saved.settings.assistant, future.settings.assistant);
  assert.equal(saved.settings.profileName, "After");
});

test("pins and recent models survive a settings.json load and reload into a fresh store with invalid entries dropped", async (t) => {
  const r = await roots(t);
  await fs.writeFile(
    r.settingsFile,
    JSON.stringify({
      settings: {
        pinnedModels: ["openai::gpt", "openai::gpt", 42, "bare-model", "google::gemini"],
        recentModels: ["google::gemini", "bare-model", "google::gemini", "p::1", "p::2", "p::3", "p::4"],
      },
    }),
    "utf-8",
  );

  const loaded = await stores(r).settings.load();
  assert.deepEqual(loaded.settings.pinnedModels, ["openai::gpt", "google::gemini"]);
  assert.deepEqual(loaded.settings.recentModels, ["google::gemini", "p::1", "p::2", "p::3", "p::4"]);

  // Write the loaded document into a fresh store's settings.json and read it back.
  const target = await roots(t);
  await fs.writeFile(target.settingsFile, JSON.stringify(loaded), "utf-8");
  const reloaded = runtimeSettingsFrom((await stores(target).settings.load()).settings);
  assert.deepEqual(reloaded.pinnedModels, ["openai::gpt", "google::gemini"]);
  assert.deepEqual(reloaded.recentModels, ["google::gemini", "p::1", "p::2", "p::3", "p::4"]);

  const wrongShapes = runtimeSettingsFrom({
    pinnedModels: { "openai::gpt": true },
    recentModels: "openai::gpt",
  } as never);
  assert.equal(wrongShapes.pinnedModels, undefined);
  assert.equal(wrongShapes.recentModels, undefined);
});

test("leftover Model Pad keys in settings.json load cleanly and are gone after the next save", async (t) => {
  const r = await roots(t);
  await fs.writeFile(
    r.settingsFile,
    JSON.stringify({
      settings: {
        profileName: "Before",
        pinnedModels: ["openai::gpt"],
        modelPadPlacements: {
          "openai::gpt": { x: 0.25, y: 0.75, xSource: "user", ySource: "benchmark", yMetric: "coding" },
          "not-a-model-key": "anything",
        },
        modelPadMetric: "agentic",
      },
    }),
    "utf-8",
  );

  const bundle = stores(r);
  const loaded = (await bundle.settings.load()).settings as Record<string, unknown>;
  assert.equal("modelPadPlacements" in loaded, false);
  assert.equal("modelPadMetric" in loaded, false);
  assert.deepEqual(loaded.pinnedModels, ["openai::gpt"]);
  assert.equal(loaded.profileName, "Before");
  const runtime = runtimeSettingsFrom({ modelPadPlacements: [], modelPadMetric: 7 } as never);
  assert.equal("modelPadPlacements" in runtime, false);
  assert.equal("modelPadMetric" in runtime, false);

  await bundle.settings.update((document) => {
    document.settings.profileName = "After";
  });
  const saved = await readJson<{ settings: Record<string, unknown> }>(r.settingsFile);
  assert.equal("modelPadPlacements" in saved.settings, false);
  assert.equal("modelPadMetric" in saved.settings, false);
  assert.equal(saved.settings.profileName, "After");
  assert.deepEqual(saved.settings.pinnedModels, ["openai::gpt"]);
});

test("settings.json keeps a known new-chat level and drops an unknown one and any stray Agent Slider", async (t) => {
  const r = await roots(t);
  const slider = {
    version: 1,
    stops: [{ id: "a", label: "A" }, { id: "b", label: "B" }, { id: "c", label: "C" }],
    homeStopId: "b",
  };
  await fs.writeFile(
    r.settingsFile,
    JSON.stringify({ settings: { lastModel: "gpt", lastThinkingLevel: "xhigh", agentSlider: slider } }),
    "utf-8",
  );
  const loaded = await stores(r).settings.load();
  assert.equal(loaded.settings.lastThinkingLevel, "xhigh");
  assert.equal("agentSlider" in loaded.settings, false, "the slider's only home is the portable config");
  assert.equal(runtimeSettingsFrom({ ...loaded.settings, agentSlider: slider } as never).agentSlider, undefined);

  const target = await roots(t);
  await fs.writeFile(
    target.settingsFile,
    JSON.stringify({ settings: { lastModel: "gpt", lastThinkingLevel: "turbo" } }),
    "utf-8",
  );
  const unknown = await stores(target).settings.load();
  assert.equal(unknown.settings.lastThinkingLevel, undefined);
  assert.equal(unknown.settings.lastModel, "gpt");
});

test("a post-startup unsafe local edit cannot be erased by a workspace write", async (t) => {
  const r = await roots(t);
  await fs.writeFile(
    r.localFile,
    JSON.stringify({ workspaces: [], seeded: true, aidenDirMigratedAt: Date.now() }),
    "utf-8",
  );
  const bundle = stores(r);
  assert.equal(await bundle.ensureMigrated(), true);
  await bundle.local.load();
  const duplicate = { ...workspace, id: "duplicate" };
  const unsafe = JSON.stringify({
    workspaces: [duplicate, { ...duplicate, folderPath: "/different" }],
    seeded: true,
    aidenDirMigratedAt: Date.now(),
  });
  await fs.writeFile(r.localFile, unsafe, "utf-8");

  await assert.rejects(
    () => bundle.local.update((document) => void (document.seeded = false)),
    /schema is not safe/u,
  );
  assert.equal(await fs.readFile(r.localFile, "utf-8"), unsafe);
});

test("pre-marker unsafe workspaces defer migration without consuming the local source", async (t) => {
  const r = await roots(t);
  const duplicate = { ...workspace, id: "duplicate" };
  const legacy = {
    ...legacyConfig(),
    workspaces: [duplicate, { ...duplicate, folderPath: "/different" }],
  };
  const raw = JSON.stringify(legacy, null, 2);
  await fs.writeFile(r.localFile, raw, "utf-8");

  assert.equal(await stores(r).ensureMigrated(), false);

  assert.equal(await fs.readFile(r.localFile, "utf-8"), raw);
  assert.equal(await missing(r.archiveFile), true);
  assert.equal(await missing(r.portableFile), true);
});


test("invalid stored compaction budgets fall back without rewriting the saved preferences", () => {
  const settings = { compactionModelOverrides: { "provider/model": { reserveTokens: -1 } }, profileName: "Local user" };
  const runtime = runtimeSettingsFrom(settings);
  assert.equal(runtime.compactionModelOverrides, undefined);
  assert.equal(runtime.profileName, "Local user");
  assert.equal(settings.compactionModelOverrides["provider/model"].reserveTokens, -1);
  settings.compactionModelOverrides["provider/model"].reserveTokens = 8_192;
  const valid = runtimeSettingsFrom(settings);
  settings.compactionModelOverrides["provider/model"].reserveTokens = 64_000;
  assert.equal(valid.compactionModelOverrides?.["provider/model"].reserveTokens, 8_192);
});

test("portable MCP OAuth metadata validates authority without requiring new fields on old configs", () => {
  const server = { id: "custom", name: "Custom", transport: "http", enabled: true, oauth: true, url: "https://service.test/mcp" };
  assert.equal(isMcpServer(server), true);
  assert.equal(isMcpServer({ ...server, authServerMetadataUrl: "https://identity.test/metadata" }), true);
  assert.equal(isMcpServer({ ...server, authServerMetadataUrl: "http://identity.test/metadata" }), false);
  assert.equal(isMcpServer({ ...server, oauth: false, authServerMetadataUrl: "https://identity.test/metadata" }), false);
});

test("portable classifier capability accepts explicit local custom intent only", () => {
  const provider = { id: "custom:llama", kind: "openai", label: "llama", baseUrl: "http://localhost:8080/v1", needsKey: false };
  assert.equal(isPortableProvider(provider), true);
  assert.equal(isPortableProvider({ ...provider, llamaCppClassifierEnabled: true }), true);
  assert.equal(isPortableProvider({ ...provider, deployment: "hosted", llamaCppClassifierEnabled: false }), true);
  for (const change of [{ llamaCppClassifierEnabled: "yes" }, { llamaCppClassifierEnabled: true, deployment: "hosted" }, { llamaCppClassifierEnabled: true, kind: "anthropic" }, { llamaCppClassifierEnabled: true, id: "openai" }, { llamaCppClassifierEnabled: true, isBuiltin: true }]) {
    assert.equal(isPortableProvider({ ...provider, ...change }), false);
  }
});

test("portable files and owned recovery archives are private without changing their bytes", { skip: process.platform === "win32" }, async (t) => {
  const r = await roots(t);
  await fs.mkdir(r.portableRoot, { mode: 0o755 });
  const payload = JSON.stringify({ providers: [], mcpServers: [], skills: [] });
  const copies = [r.portableFile,
    path.join(r.portableRoot, ".config.json.12345678-1234-4234-8234-123456789abc.tmp"),
    path.join(r.portableRoot, "config.json.invalid-2026-10-27T01-02-03-000Z-deadbeef"),
    path.join(r.portableRoot, `.config.json.${"a".repeat(64)}.12345678-1234-4234-8234-123456789abc.previous`),
    r.archiveFile, `${r.archiveFile}.recovery-2026-10-27T01-02-03-000Z-12345678-1234-4234-8234-123456789abc`];
  for (const file of copies) { await fs.writeFile(file, payload); await fs.chmod(file, 0o666); }
  const unrelated = path.join(r.portableRoot, "someone-elses-config.json");
  await fs.writeFile(unrelated, "ordinary"); await fs.chmod(unrelated, 0o644);
  const bundle = stores(r);
  await bundle.portable.load(); await bundle.local.load();
  assert.equal((await fs.stat(r.portableRoot)).mode & 0o777, 0o700);
  const recovered = (await fs.readdir(r.portableRoot)).find((name) => name.startsWith("config.json.conflict-"));
  assert.ok(recovered, "changed recovery bytes remain available as a conflict");
  const retainedCopies = copies.map((file) => file.endsWith(".previous") ? path.join(r.portableRoot, recovered) : file);
  for (const file of retainedCopies) {
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    assert.equal(await fs.readFile(file, "utf8"), payload);
  }
  assert.equal((await fs.stat(unrelated)).mode & 0o777, 0o644);
  const oldUmask = process.umask(0);
  try { await bundle.portable.update((draft) => { draft.skills = []; }); }
  finally { process.umask(oldUmask); }
  assert.equal((await fs.stat(r.portableFile)).mode & 0o777, 0o600);
});

test("portable file aliases fail visibly without chmod or replacing their targets", async (t) => {
  for (const variant of ["file-symlink", "file-hardlink"] as const) {
    const r = await roots(t);
    const outside = path.join(r.localRoot, "outside"); await fs.mkdir(outside);
    const victim = path.join(outside, "important.json"); await fs.writeFile(victim, "keep these bytes");
    const before = (await fs.stat(victim)).mode;
    await fs.mkdir(r.portableRoot);
    if (variant === "file-symlink") await fs.symlink(victim, r.portableFile);
    else await fs.link(victim, r.portableFile);
    const bundle = stores(r);
    await assert.rejects(bundle.portable.load(), /storage must be a private/u);
    await assert.rejects(bundle.portable.update(() => {}), /storage must be a private/u);
    assert.equal(await fs.readFile(victim, "utf8"), "keep these bytes");
    assert.equal((await fs.stat(victim)).mode, before);
  }
});


test("a portable root linked to a folder this user owns is protected and used through the link", { skip: process.platform === "win32" }, async (t) => {
  const r = await roots(t);
  const dotfiles = path.join(r.localRoot, "dotfiles", "aiden");
  await fs.mkdir(dotfiles, { recursive: true, mode: 0o755 });
  // Fix every folder's mode so the umask (0002 on many Linux setups) can't make them group-writable.
  for (const folder of [r.localRoot, path.dirname(dotfiles), dotfiles]) await fs.chmod(folder, 0o755);
  await fs.writeFile(path.join(dotfiles, "config.json"), JSON.stringify({ skills: [{ id: "s1", name: "kept", description: "d", instructions: "i", enabled: true }] }));
  await fs.chmod(path.join(dotfiles, "config.json"), 0o644);
  await fs.symlink(dotfiles, r.portableRoot);
  const bundle = stores(r);
  assert.equal((await bundle.portable.load()).skills?.[0]?.name, "kept");
  await bundle.portable.update((draft) => { draft.skills = []; });
  assert.equal((await fs.lstat(r.portableRoot)).isSymbolicLink(), true, "the link stays a link");
  assert.equal((await fs.stat(dotfiles)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(path.join(dotfiles, "config.json"))).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dotfiles, "config.json"), "utf8")).skills, []);
});

test("a portable root link is refused when another user could replace it", { skip: process.platform === "win32" }, async (t) => {
  const r = await roots(t);
  const shared = path.join(r.localRoot, "shared"); await fs.mkdir(shared); await fs.chmod(shared, 0o777);
  const target = path.join(r.localRoot, "target"); await fs.mkdir(target, { mode: 0o755 }); await fs.chmod(target, 0o755);
  const linkInShared = path.join(shared, "aiden");
  await fs.symlink(target, linkInShared);
  assert.throws(() => ensurePrivateDirectory(linkInShared), /storage must be a private/u, "another user could swap the link");
  assert.equal((await fs.stat(target)).mode & 0o777, 0o755);
});

test("a link partway along the path is refused when another user could replace it", { skip: process.platform === "win32" }, async (t) => {
  const r = await roots(t);
  await fs.chmod(r.localRoot, 0o755);
  const shared = path.join(r.localRoot, "shared"); await fs.mkdir(shared); await fs.chmod(shared, 0o777);
  const owned = path.join(r.localRoot, "owned"); await fs.mkdir(owned, { mode: 0o755 }); await fs.chmod(owned, 0o755);
  const state = path.join(owned, "state"); await fs.mkdir(state, { mode: 0o700 });
  await fs.symlink(owned, path.join(shared, "alias"));
  assert.throws(() => ensurePrivateDirectory(path.join(shared, "alias", "state"), "reject"), /storage must be a private/u, "another user could swap the alias");
  // A safe link whose target runs through the replaceable one is refused too.
  await fs.symlink(path.join(shared, "alias", "state"), path.join(r.localRoot, "config-link"));
  assert.throws(() => ensurePrivateDirectory(path.join(r.localRoot, "config-link"), "reject"), /storage must be a private/u, "the hop inside the link's target could be swapped");
  // The same path through a link in a folder only this user can change is fine.
  await fs.symlink(owned, path.join(r.localRoot, "safe-alias"));
  assert.doesNotThrow(() => ensurePrivateDirectory(path.join(r.localRoot, "safe-alias", "state"), "reject"));
});

test("private storage rejects canonical home aliases and replaceable ancestors without changing permissions", { skip: process.platform === "win32" }, async (t) => {
  const r = await roots(t);
  const parentAlias = path.join(r.localRoot, "parent-alias");
  await fs.symlink(path.dirname(os.homedir()), parentAlias);
  const homeAlias = path.join(parentAlias, path.basename(os.homedir()));
  const beforeHome = (await fs.stat(os.homedir())).mode;
  assert.throws(() => ensurePrivateDirectory(homeAlias), /storage must be a private/u);
  assert.equal((await fs.stat(os.homedir())).mode, beforeHome);
  const sharedParent = path.join(r.localRoot, "shared-parent");
  await fs.mkdir(sharedParent); await fs.chmod(sharedParent, 0o777);
  const child = path.join(sharedParent, "private-child"); await fs.mkdir(child, { mode: 0o700 });
  assert.throws(() => ensurePrivateDirectory(child, "reject"), /storage must be a private/u);
  assert.equal((await fs.stat(sharedParent)).mode & 0o777, 0o777);
});

test("private storage rejects ownership mismatches before changing root or config modes", { skip: !process.getuid }, async (t) => {
  const r = await roots(t);
  await fs.mkdir(r.portableRoot); await fs.chmod(r.portableRoot, 0o755);
  await fs.writeFile(r.portableFile, "preserve"); await fs.chmod(r.portableFile, 0o644);
  const uid = process.getuid!();
  const posixProcess = process as NodeJS.Process & { getuid(): number };
  t.mock.method(posixProcess, "getuid", () => uid + 1);
  await assert.rejects(stores(r).portable.load(), /storage must be a private/u);
  assert.equal((await fs.stat(r.portableRoot)).mode & 0o777, 0o755);
  assert.equal((await fs.stat(r.portableFile)).mode & 0o777, 0o644);
  assert.equal(await fs.readFile(r.portableFile, "utf8"), "preserve");
});

test('runtime settings export botMessaging only when off',()=>{
 assert.equal(runtimeSettingsFrom({botMessaging:false} as never).botMessaging,false);
 assert.equal(runtimeSettingsFrom({botMessaging:true} as never).botMessaging,undefined);
 assert.equal(runtimeSettingsFrom({botMessaging:'no'} as never).botMessaging,undefined);
});

test("runtime settings preserve valid Quick Chat preferences and drop invalid values", () => {
  const valid = runtimeSettingsFrom({
    quickChatDefaultPersistence: "lastWorkspace",
    quickChatKeepOpenOnBlur: false,
  } as never);
  assert.equal(valid.quickChatDefaultPersistence, "lastWorkspace");
  assert.equal(valid.quickChatKeepOpenOnBlur, false);

  const invalid = runtimeSettingsFrom({
    quickChatDefaultPersistence: "workspace:/etc/passwd",
    quickChatKeepOpenOnBlur: "yes",
  } as never);
  assert.equal(invalid.quickChatDefaultPersistence, undefined);
  assert.equal(invalid.quickChatKeepOpenOnBlur, undefined);
});

test("runtime settings keep the Bot bubble switches only when they are booleans", () => {
  const off = runtimeSettingsFrom({ botBubblesEnabled: false, botBubblesFloatOverApps: false } as never);
  assert.equal(off.botBubblesEnabled, false);
  assert.equal(off.botBubblesFloatOverApps, false);
  const handEdited = runtimeSettingsFrom({ botBubblesEnabled: "no", botBubblesFloatOverApps: 0 } as never);
  assert.equal(handEdited.botBubblesEnabled, undefined, "a non-boolean reads as unset, which means on");
  assert.equal(handEdited.botBubblesFloatOverApps, undefined);
});

test("private-storage helpers preserve ctimeNs when modes already equal 0o700 and 0o600", { skip: process.platform === "win32" }, async (t) => {
  const r = await roots(t);
  await fs.chmod(r.localRoot, 0o755);
  await fs.mkdir(r.portableRoot, { mode: 0o755 });
  await fs.chmod(r.portableRoot, 0o755);
  await fs.writeFile(r.portableFile, '{"skills":[]}', "utf8");
  await fs.chmod(r.portableFile, 0o644);

  ensurePrivateDirectory(r.portableRoot);
  hardenPrivateFile(r.portableFile);
  assert.equal((await fs.stat(r.portableRoot)).mode & 0o7777, 0o700);
  assert.equal((await fs.stat(r.portableFile)).mode & 0o7777, 0o600);

  const dirBefore = await fs.lstat(r.portableRoot, { bigint: true });
  const fileBefore = await fs.lstat(r.portableFile, { bigint: true });
  await new Promise((resolve) => setTimeout(resolve, 15));

  ensurePrivateDirectory(r.portableRoot);
  hardenPrivateFile(r.portableFile);
  await ensurePrivateDirectoryAsync(r.portableRoot);
  await hardenPrivateFileAsync(r.portableFile);

  const dirAfter = await fs.lstat(r.portableRoot, { bigint: true });
  const fileAfter = await fs.lstat(r.portableFile, { bigint: true });
  assert.equal(dirAfter.ctimeNs, dirBefore.ctimeNs);
  assert.equal(fileAfter.ctimeNs, fileBefore.ctimeNs);

  await fs.chmod(r.portableRoot, 0o755);
  await fs.chmod(r.portableFile, 0o640);
  await ensurePrivateDirectoryAsync(r.portableRoot);
  await hardenPrivateFileAsync(r.portableFile);
  assert.equal((await fs.stat(r.portableRoot)).mode & 0o7777, 0o700);
  assert.equal((await fs.stat(r.portableFile)).mode & 0o7777, 0o600);
});

test("warm configStore workspace and MCP reads run zero sync fs syscalls and zero readdir scans across directories, absent configs, and owned symlinks", { skip: process.platform === "win32" }, async (t) => {
  const emptySecrets: SecretsPort = {
    async hasKey() {
      return false;
    },
    async deleteKey() {},
    async deleteProviderKeyWithQuarantine() {},
    async migrateKeys() {},
    async migrateProviderKeysWithBindings() {
      return true;
    },
  };

  for (const variant of ["absent-portable-config", "owned-symlink"] as const) {
    const r = await roots(t);
    const parentBase = path.dirname(r.portableRoot);
    await fs.chmod(parentBase, 0o755);
    await fs.chmod(r.localRoot, 0o755);

    if (variant === "absent-portable-config") {
      await fs.writeFile(
        r.localFile,
        JSON.stringify({
          workspaces: [workspace],
          seeded: true,
          aidenDirMigratedAt: Date.now(),
          webSearchProfileKind: "fresh",
        }),
        "utf8",
      );
      await fs.writeFile(
        r.settingsFile,
        JSON.stringify({
          settings: {
            approvalModeOrigin: "fresh",
            webSearch: { version: 2, enabled: false, selectedProvider: "duckduckgo", providers: {} },
          },
        }),
        "utf8",
      );
    } else {
      const dotfiles = path.join(parentBase, "dotfiles", "aiden");
      await fs.mkdir(dotfiles, { recursive: true, mode: 0o755 });
      await fs.chmod(path.dirname(dotfiles), 0o755);
      await fs.chmod(dotfiles, 0o755);
      await fs.writeFile(
        path.join(dotfiles, PORTABLE_CONFIG_FILENAME),
        JSON.stringify({
          providers: [],
          providerIdAliases: {},
          mcpServers: [{ id: "srv-1", name: "Server 1", transport: "http", url: "https://mcp.test/sse", enabled: true }],
          skills: [],
        }),
        "utf8",
      );
      await fs.symlink(dotfiles, r.portableRoot);
    }

    const bundle = stores(r);
    const configStore = createConfigStore(bundle, emptySecrets);
    if (variant === "owned-symlink") {
      await configStore.saveWorkspace(workspace);
    }

    // Warm both local and portable caches + signatures.
    assert.equal((await configStore.getWorkspace(workspace.id))?.id, workspace.id);
    assert.equal(
      (await configStore.listMcpServers()).length,
      variant === "owned-symlink" ? 1 : 0,
    );
    if (variant === "absent-portable-config") {
      assert.equal(await missing(r.portableFile), true, "portable config.json stays absent");
    }

    // Also confirm first-run absent local config.json hits its cached signature.
    const freshAbsentRoots = await roots(t);
    await fs.chmod(path.dirname(freshAbsentRoots.portableRoot), 0o755);
    const freshAbsentBundle = stores(freshAbsentRoots);
    await freshAbsentBundle.local.load();
    await freshAbsentBundle.portable.load();

    let syncCalls = 0;
    let readdirCalls = 0;
    let openCalls = 0;

    const syncMethods = [
      "closeSync",
      "fchmodSync",
      "fstatSync",
      "lstatSync",
      "mkdirSync",
      "openSync",
      "readdirSync",
      "readFileSync",
      "readlinkSync",
      "realpathSync",
      "statSync",
    ] as const;
    const activeMocks: Array<{ mock: { restore(): void } }> = [];
    for (const method of syncMethods) {
      const original = fsSync[method] as (...args: unknown[]) => unknown;
      activeMocks.push(
        t.mock.method(fsSync, method, (...args: unknown[]) => {
          syncCalls += 1;
          return Reflect.apply(original, fsSync, args);
        }),
      );
    }
    const originalReaddir = fsPromises.readdir;
    activeMocks.push(
      t.mock.method(fsPromises, "readdir", async (...args: Parameters<typeof originalReaddir>) => {
        readdirCalls += 1;
        return Reflect.apply(originalReaddir, fsPromises, args);
      }),
    );
    const originalOpen = fsPromises.open;
    activeMocks.push(
      t.mock.method(fsPromises, "open", async (...args: Parameters<typeof originalOpen>) => {
        openCalls += 1;
        return Reflect.apply(originalOpen, fsPromises, args);
      }),
    );
    syncBuiltinESMExports();

    try {
      for (let i = 0; i < 300; i += 1) {
        const ws = await configStore.getWorkspace(workspace.id);
        const servers = await configStore.listMcpServers();
        assert.equal(ws?.id, workspace.id);
        assert.equal(servers.length, variant === "owned-symlink" ? 1 : 0);
      }
      await freshAbsentBundle.local.load();
      await freshAbsentBundle.portable.load();

      assert.equal(syncCalls, 0, `${variant}: expected 0 synchronous fs syscalls across 600+ warm reads`);
      assert.equal(readdirCalls, 0, `${variant}: expected 0 fs.readdir scans across 600+ warm reads`);
      assert.equal(openCalls, 0, `${variant}: expected 0 fs.open calls across 600+ warm reads`);
    } finally {
      for (const mocked of activeMocks) mocked.mock.restore();
      syncBuiltinESMExports();
    }
  }
});

test("cached signatures invalidate immediately on permission changes, symlink retargets, config links, or foreign owners", { skip: process.platform === "win32" }, async (t) => {
  const r = await roots(t);
  const base = path.dirname(r.portableRoot);
  const dotfilesA = path.join(base, "dotfiles-a");
  const dotfilesB = path.join(base, "dotfiles-b");
  await fs.mkdir(dotfilesA, { mode: 0o755 });
  await fs.mkdir(dotfilesB, { mode: 0o755 });
  for (const dir of [base, r.localRoot, dotfilesA, dotfilesB]) await fs.chmod(dir, 0o755);

  const fileA = path.join(dotfilesA, PORTABLE_CONFIG_FILENAME);
  await fs.writeFile(
    fileA,
    JSON.stringify({ skills: [{ id: "s1", name: "alpha", description: "d", instructions: "i", enabled: true }] }),
    "utf8",
  );
  await fs.writeFile(
    r.localFile,
    JSON.stringify({ workspaces: [workspace], seeded: true, aidenDirMigratedAt: Date.now() }),
    "utf8",
  );
  await fs.symlink(dotfilesA, r.portableRoot);

  const bundle = stores(r);
  assert.equal((await bundle.portable.load()).skills[0]?.name, "alpha");
  assert.equal((await bundle.local.load()).workspaces[0]?.id, workspace.id);

  let readdirCalls = 0;
  const originalReaddir = fsPromises.readdir;
  const readdirMock = t.mock.method(fsPromises, "readdir", async (...args: Parameters<typeof originalReaddir>) => {
    readdirCalls += 1;
    return Reflect.apply(originalReaddir, fsPromises, args);
  });
  syncBuiltinESMExports();
  t.after(() => {
    readdirMock.mock.restore();
    syncBuiltinESMExports();
  });

  // Warm hit baseline.
  await bundle.portable.load();
  await bundle.local.load();
  assert.equal(readdirCalls, 0);

  // 1. Loosening file or directory permissions invalidates on the very next read and re-hardens.
  await fs.chmod(fileA, 0o644);
  await bundle.portable.load();
  assert.equal(readdirCalls, 1);
  assert.equal((await fs.stat(fileA)).mode & 0o7777, 0o600);
  await bundle.portable.load();
  assert.equal(readdirCalls, 1, "re-cached after re-hardening");

  await fs.chmod(dotfilesA, 0o755);
  await bundle.portable.load();
  assert.equal(readdirCalls, 2);
  assert.equal((await fs.stat(dotfilesA)).mode & 0o7777, 0o700);

  // 2. Loosening a non-sticky ancestor invalidates and fails closed before returning cache.
  await fs.chmod(base, 0o777);
  await assert.rejects(bundle.portable.load(), /storage must be a private/u);
  await fs.chmod(base, 0o755);
  assert.equal((await bundle.portable.load()).skills[0]?.name, "alpha");

  // 3. Retargeting the owned root symlink invalidates on the very next read.
  await fs.unlink(r.portableRoot);
  await fs.symlink(dotfilesB, r.portableRoot);
  const countBeforeRetarget = readdirCalls;
  await bundle.portable.load();
  assert.equal(readdirCalls, countBeforeRetarget + 1, "retargeted symlink missed cached signature");
  assert.equal((await fs.stat(dotfilesB)).mode & 0o7777, 0o700, "new symlink target was hardened");

  const unsafeParent = path.join(base, "world-writable");
  const unsafeTarget = path.join(unsafeParent, "dot-aiden");
  await fs.mkdir(unsafeTarget, { recursive: true, mode: 0o755 });
  await fs.chmod(unsafeParent, 0o777);
  await fs.chmod(unsafeTarget, 0o755);
  await fs.unlink(r.portableRoot);
  await fs.symlink(unsafeTarget, r.portableRoot);
  await assert.rejects(bundle.portable.load(), /storage must be a private/u);

  const victimFile = path.join(base, "not-a-directory.json");
  await fs.writeFile(victimFile, '{"keep":true}', "utf8");
  await fs.chmod(victimFile, 0o644);
  await fs.unlink(r.portableRoot);
  await fs.symlink(victimFile, r.portableRoot);
  await assert.rejects(bundle.portable.load(), { code: "EEXIST" });
  assert.equal((await fs.stat(victimFile)).mode & 0o777, 0o644);

  await fs.unlink(r.portableRoot);
  await fs.symlink(dotfilesA, r.portableRoot);
  assert.equal((await bundle.portable.load()).skills[0]?.name, "alpha");

  // 4. Hard-linking or symlinking config.json invalidates on the very next read.
  const hardLinkAlias = path.join(base, "unapproved-hardlink.json");
  await fs.link(fileA, hardLinkAlias);
  await assert.rejects(bundle.portable.load(), /storage must be a private/u);
  await fs.unlink(hardLinkAlias);
  assert.equal((await bundle.portable.load()).skills[0]?.name, "alpha");

  const localBackup = await fs.readFile(r.localFile);
  await fs.unlink(r.localFile);
  await fs.symlink(victimFile, r.localFile);
  await assert.rejects(bundle.local.load(), /storage must be a private/u);
  await fs.unlink(r.localFile);
  await fs.writeFile(r.localFile, localBackup);
  assert.equal((await bundle.local.load()).workspaces[0]?.id, workspace.id);

  // 5. Foreign owner invalidates warm cached signature immediately.
  if (process.getuid) {
    const currentUid = process.getuid();
    const posixProcess = process as NodeJS.Process & { getuid(): number };
    const uidMock = t.mock.method(posixProcess, "getuid", () => currentUid + 1);
    try {
      await assert.rejects(bundle.portable.load(), /storage must be a private/u);
      await assert.rejects(bundle.local.load(), /storage must be a private/u);
    } finally {
      uidMock.mock.restore();
    }
    assert.equal((await bundle.portable.load()).skills[0]?.name, "alpha");
  }
});

test("signature cache is bypassed whenever ownedPublicationPaths or archivePublicationPaths is non-empty", { skip: process.platform === "win32" }, async (t) => {
  const r = await roots(t);
  const base = path.dirname(r.portableRoot);
  await fs.chmod(base, 0o755);
  await fs.chmod(r.localRoot, 0o755);
  await fs.writeFile(
    r.localFile,
    JSON.stringify({ ...legacyConfig(), workspaces: [workspace] }),
    "utf8",
  );

  let readdirCalls = 0;
  const originalReaddir = fsPromises.readdir;
  const readdirMock = t.mock.method(fsPromises, "readdir", async (...args: Parameters<typeof originalReaddir>) => {
    readdirCalls += 1;
    return Reflect.apply(originalReaddir, fsPromises, args);
  });
  let checkedArchivePublication = false;
  let checkedOwnedPublication = false;
  const originalLink = fsPromises.link;
  const linkMock = t.mock.method(fsPromises, "link", async (...args: Parameters<typeof originalLink>) => {
    if (args[1] === r.archiveFile && !checkedArchivePublication) {
      // Warm signature first if needed, then verify non-empty archivePublicationPaths bypasses cache.
      const before = readdirCalls;
      await bundle.local.load();
      assert.ok(readdirCalls > before, "non-empty archivePublicationPaths bypassed signature cache");
      checkedArchivePublication = true;
    }
    return Reflect.apply(originalLink, fsPromises, args);
  });
  syncBuiltinESMExports();
  t.after(() => {
    readdirMock.mock.restore();
    linkMock.mock.restore();
    syncBuiltinESMExports();
  });

  const bundle = createPortableConfigStores(
    () => r.portableRoot,
    () => r.localRoot,
    {
      beforeLocalProtectedPublish: async () => {
        const before = readdirCalls;
        // During localStore.update, ownedPublicationPaths is non-empty, so load() must bypass signature cache.
        await bundle.local.load();
        assert.ok(readdirCalls > before, "non-empty ownedPublicationPaths bypassed signature cache");
        checkedOwnedPublication = true;
      },
    },
  );
  assert.equal(await bundle.ensureMigrated(), true);
  assert.equal(checkedArchivePublication, true);
  await bundle.local.load();
  const warmBefore = readdirCalls;
  await bundle.local.load();
  assert.equal(readdirCalls, warmBefore, "warm read hit signature before update");

  await bundle.local.update((draft) => {
    draft.workspaces = [{ ...workspace, name: "Updated" }];
  });
  assert.equal(checkedOwnedPublication, true);
});
