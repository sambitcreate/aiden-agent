// Migration tests for the ~/.aiden split.
//
// The load-bearing guarantee here is negative: once an install has migrated,
// deleting the portable config must yield defaults rather than resurrect the
// pre-migration snapshot. See "deleting the portable file after migration" below.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  LEGACY_CONFIG_ARCHIVE_SUFFIX,
  LOCAL_CONFIG_FILENAME,
  PORTABLE_CONFIG_FILENAME,
  PORTABLE_README_FILENAME,
  PROVIDER_MODEL_CACHE_FILENAME,
  SETTINGS_FILENAME,
  composeStoredProvider,
  createPortableConfigStores,
  splitStoredProvider,
} from "./portable-config-core.js";
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
    mcpServers: [{ id: "fs", name: "Filesystem", transport: "stdio", command: "mcp-fs" }],
    skills: [{ id: "s1", name: "Summarize", description: "d", instructions: "i", enabled: true }],
    workspaces: [workspace],
  };
}

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
    mcpServers: [{ id: "mine", name: "Mine", transport: "stdio", command: "x" }],
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

// A retry may find the slimmed file at config.json; copying that over a good
// archive would destroy the only remaining copy of the legacy fields.
test("an existing archive is never overwritten", async (t) => {
  const r = await roots(t);
  await writeLegacy(r);
  await fs.writeFile(r.archiveFile, JSON.stringify({ providers: ["precious"] }), "utf-8");

  await stores(r).ensureMigrated();

  assert.deepEqual(await readJson(r.archiveFile), { providers: ["precious"] });
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
});
