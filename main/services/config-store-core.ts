// Custom-provider configuration + lightweight app settings persistence.
// Pi built-ins are derived from its runtime registry, not seeded into this file.
//
// This is the read/write API the rest of the app calls. Behind it the data is
// split four ways (see portable-config-core.ts): provider intent, aliases, MCP
// servers, and skills are portable and live in ~/.aiden/config.json; workspaces
// and seeding markers are machine-local; so are UI settings and the model
// discovery cache. Callers see none of that.
//
// Platform-independent: the stores and the keychain are injected, so the routing
// and the seeding order are exercisable without Electron. config-store.ts binds
// the real ones.

import * as path from "node:path";
import {
  composeStoredProvider,
  emptyPortableConfig,
  splitStoredProvider,
  isPortableProviderList,
  isProviderAliasMap,
  isMcpServerList,
  isSkillList,
  mergeProviderModelCacheEntries,
  providerAliasSourcesAreInactive,
  resolveProviderAlias,
  resolvedProviderAliasRoutes,
  runtimeSettingsFrom,
  type PortableConfigShape,
  type PortableConfigStores,
  type ProviderModelCacheEntry,
  type ProviderModelCacheShape,
  type SettingsShape,
} from "./portable-config-core.js";
import { GOOGLE_PROVIDER_ID } from "./google-provider.js";
import { migratePiProviderConfig } from "./provider-config-migration-core.js";
import { providerConnectionSnapshot } from "./provider-credential-rotation-core.js";
import {
  mergeGoogleThinkingPreference,
  type GoogleThinkingLevel,
} from "../../renderer/shared/google-thinking.js";
import {
  mergeCodexThinkingPreference,
  type CodexThinkingLevel,
} from "../../renderer/shared/codex-thinking.js";
import {
  mergeAnthropicThinkingPreference,
  type AnthropicThinkingLevel,
} from "../../renderer/shared/anthropic-thinking.js";
import { mergeProviderThinkingPreference } from "../../renderer/shared/provider-thinking.js";
import type { GenerationThinkingLevel } from "../../renderer/shared/generation-thinking.js";
import { migrateLegacyPiProviderId } from "../../renderer/shared/google-provider.js";
import {
  remapHiddenModelProvider,
  withModelVisibility,
  withoutProviderVisibility,
} from "../../renderer/shared/model-visibility.js";
import { hiddenModelsForGeminiScope } from "../../renderer/shared/gemini-usage-scope.js";
import { ASSISTANT_WORKSPACE_ID } from "../../renderer/shared/assistant.js";
import {
  freshWebSearchSettings,
  migrateWebSearchSettingsWithReport,
  parseWebSearchSettings,
  normalizeWebSearchSettings,
  type WebSearchSettingsV2,
} from "./web-search-provider-registry-core.js";
import type {
  AppSettings,
  McpServer,
  Provider,
  Skill,
  StoredProvider,
  Workspace,
} from "./types.js";

/** The slice of the keychain store this module needs. See secrets.ts. */
export interface SecretsPort {
  hasKey(providerId: string): Promise<boolean>;
  getProviderKey?(providerId: string, binding: string): Promise<string | null>;
  deleteKey(providerId: string, isCurrent?: () => boolean): Promise<void>;
  migrateKeys(migrate: (keys: Record<string, unknown>) => boolean): Promise<void>;
  migrateProviderKeysWithBindings(
    migrations: ReadonlyArray<{
      legacyProviderId: string;
      providerId: string;
      binding: string;
    }>,
  ): Promise<boolean>;
}

/** Every install starts with one folderless workspace so chats have a home. */
const DEFAULT_WORKSPACE_ID = "default";
function defaultWorkspace(): Workspace {
  const now = Date.now();
  return {
    id: DEFAULT_WORKSPACE_ID,
    name: "Workspace",
    permission: "ask",
    createdAt: now,
    updatedAt: now,
  };
}

const PERMISSIONS = new Set(["full", "ask", "none"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function ownRecordEntry<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

function setRecordEntry<T>(record: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(record, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function providerAliasRoutes(
  aliases: Readonly<Record<string, string>>,
): Array<readonly [source: string, target: string]> {
  return resolvedProviderAliasRoutes(aliases)
    .sort((left, right) => left[2] - right[2])
    .map(([source, target]) => [source, target] as const);
}

function normalizePortableConfig(value: unknown): {
  config: PortableConfigShape;
  unsafe: boolean;
} {
  if (!isRecord(value)) return { config: emptyPortableConfig(), unsafe: true };

  let unsafe = false;
  const has = (key: string) => Object.prototype.hasOwnProperty.call(value, key);
  const providers = value.providers;
  let safeProviders: PortableConfigShape["providers"] = [];
  if (!has("providers")) {
    safeProviders = [];
  } else if (isPortableProviderList(providers)) {
    safeProviders = providers;
  } else {
    unsafe = true;
  }

  const aliases = value.providerIdAliases;
  let safeAliases = !has("providerIdAliases")
    ? {}
    : isProviderAliasMap(aliases)
      ? aliases
      : ((unsafe = true), {});
  if (!providerAliasSourcesAreInactive(safeAliases, safeProviders)) {
    unsafe = true;
    safeAliases = {};
  }

  const mcpServers = value.mcpServers;
  const safeMcpServers = !has("mcpServers")
    ? []
    : isMcpServerList(mcpServers)
      ? mcpServers
      : ((unsafe = true), []);
  const skills = value.skills;
  const safeSkills = !has("skills") ? [] : isSkillList(skills) ? skills : ((unsafe = true), []);

  return {
    config: {
      ...structuredClone(value),
      providers: safeProviders,
      providerIdAliases: safeAliases,
      mcpServers: safeMcpServers,
      skills: safeSkills,
    } as PortableConfigShape,
    unsafe,
  };
}

function normalizeWorkspace(w: Workspace): Workspace {
  return {
    ...w,
    name: w.name.trim() || "Workspace",
    permission: PERMISSIONS.has(w.permission) ? w.permission : "ask",
    managedWorktree:
      w.managedWorktree &&
      typeof w.managedWorktree.repositoryPath === "string" &&
      path.isAbsolute(w.managedWorktree.repositoryPath) &&
      typeof w.managedWorktree.worktreePath === "string" &&
      path.isAbsolute(w.managedWorktree.worktreePath) &&
      typeof w.managedWorktree.branch === "string" &&
      typeof w.managedWorktree.createdFromHead === "string" &&
      (w.managedWorktree.worktreeGitDir === undefined ||
        (typeof w.managedWorktree.worktreeGitDir === "string" &&
          path.isAbsolute(w.managedWorktree.worktreeGitDir)))
        ? {
            repositoryPath: w.managedWorktree.repositoryPath,
            worktreePath: w.managedWorktree.worktreePath,
            branch: w.managedWorktree.branch,
            ...(typeof w.managedWorktree.worktreeGitDir === "string"
              ? { worktreeGitDir: w.managedWorktree.worktreeGitDir }
              : {}),
            ...(typeof w.managedWorktree.ownershipToken === "string"
              ? { ownershipToken: w.managedWorktree.ownershipToken }
              : {}),
            ...(typeof w.managedWorktree.worktreeDevice === "number" &&
            Number.isSafeInteger(w.managedWorktree.worktreeDevice) &&
            w.managedWorktree.worktreeDevice >= 0
              ? { worktreeDevice: w.managedWorktree.worktreeDevice }
              : {}),
            ...(typeof w.managedWorktree.worktreeInode === "number" &&
            Number.isSafeInteger(w.managedWorktree.worktreeInode) &&
            w.managedWorktree.worktreeInode >= 0
              ? { worktreeInode: w.managedWorktree.worktreeInode }
              : {}),
            createdFromHead: w.managedWorktree.createdFromHead,
          }
        : undefined,
    folderPath:
      typeof w.folderPath === "string" && path.isAbsolute(w.folderPath) ? w.folderPath : undefined,
  };
}

function hasProviderCache(
  entry: ProviderModelCacheEntry | undefined,
): entry is ProviderModelCacheEntry {
  return entry?.models !== undefined || entry?.modelMetadata !== undefined;
}

export type ConfigStore = ReturnType<typeof createConfigStore>;

export function createConfigStore(
  configStores: PortableConfigStores,
  secrets: SecretsPort,
  reportDeferredError: (area: string, error: unknown) => void = () => undefined,
) {
  const { portable, settings: settingsStore, local: localStore, modelCache } = configStores;
  let seedPromise: Promise<boolean> | null = null;
  let secretMigrationAliases: Array<readonly [source: string, target: string]> = [];
  let secretMigrationTargets: Array<Readonly<{ id: string; binding: string }>> = [];
  let secretMigrationComplete = false;
  let secretMigrationPromise: Promise<void> | null = null;

  async function portableConfigSafeForCredentialReconciliation(
    reloadFromDisk: boolean,
  ): Promise<boolean> {
    if (!(await ensureSeeded())) return false;
    if (reloadFromDisk) {
      // A prior config mutation may have failed after publication. Restart
      // journals must decide from authoritative disk bytes, never cache.
      await portable.reload();
    }
    if (await portable.loadedFromCorruptFile()) return false;
    return !normalizePortableConfig(await portable.load()).unsafe;
  }

  async function attemptSecretMigration(): Promise<void> {
    if (secretMigrationComplete) return;
    if (!secretMigrationPromise) {
      secretMigrationPromise = (async () => {
        let unresolved = false;
        const customAliasSources = new Set(secretMigrationAliases.map(([legacyId]) => legacyId));
        const bindingByTarget = new Map(
          secretMigrationTargets.map((target) => [target.id, target.binding]),
        );
        const migrations = secretMigrationAliases.flatMap(([legacyProviderId, providerId]) => {
          const binding = bindingByTarget.get(providerId);
          return binding === undefined ? [] : [{ legacyProviderId, providerId, binding }];
        });
        if (
          migrations.length !== secretMigrationAliases.length ||
          !(await secrets.migrateProviderKeysWithBindings(migrations))
        ) {
          unresolved = true;
        }
        await secrets.migrateKeys((keys) => {
          let changed = false;
          const legacyGoogleKey = ownRecordEntry(keys, "gemini");
          if (legacyGoogleKey !== undefined && !customAliasSources.has("gemini")) {
            if (typeof legacyGoogleKey !== "string") {
              unresolved = true;
              return false;
            }
            const currentGoogleKey = ownRecordEntry(keys, GOOGLE_PROVIDER_ID);
            if (currentGoogleKey === undefined) {
              setRecordEntry(keys, GOOGLE_PROVIDER_ID, legacyGoogleKey);
            } else {
              unresolved = true;
              return changed;
            }
            delete keys.gemini;
            changed = true;
          }
          return changed;
        });
        if (unresolved) {
          reportDeferredError(
            "provider-secret-migration",
            new Error("Legacy provider credentials contain unresolved future-version records."),
          );
        } else {
          secretMigrationComplete = true;
        }
      })()
        .catch((error: unknown) => {
          reportDeferredError("provider-secret-migration", error);
        })
        .finally(() => {
          secretMigrationPromise = null;
        });
    }
    await secretMigrationPromise;
  }

  /**
   * Materialize the v2 Web Search preference exactly once during config
   * seeding. This is deliberately a local JSON/keychain operation: no
   * provider adapter or network path is reachable from startup migration.
   */
  async function ensureWebSearchSettings(): Promise<void> {
    const document = await settingsStore.load();
    // A malformed settings file is user-owned. Existing config-store behavior
    // is to expose safe defaults while refusing every write until the file is
    // repaired; Web Search migration must preserve that invariant.
    if (await settingsStore.loadedFromCorruptFile()) return;
    const hasWebSearch = Object.prototype.hasOwnProperty.call(document.settings, "webSearch");
    if (hasWebSearch) {
      // The settings normalizer canonicalizes supported v2 documents and keeps
      // unsupported/future values verbatim. Do not reinterpret a present value
      // as legacy absence: an older build must never overwrite preferences it
      // cannot understand during startup.
      return;
    }

    const local = await localStore.load();
    const profileKind =
      local.webSearchProfileKind ??
      (typeof local.aidenDirMigratedAt === "number"
        ? "upgrade"
        : local.seeded === false
          ? "fresh"
          : "upgrade");
    const migration = migrateWebSearchSettingsWithReport({
      exaEnabled: document.settings.exaEnabled,
      hasExaKey: await secrets.hasKey("exa"),
      evidence: {
        profileKind,
        seeded: local.seeded,
        hasPersistedProfile: profileKind === "upgrade",
        settingsFileExists: (await settingsStore.loadedDiskContents()) !== null,
        onboarding: document.settings.onboarding,
      },
    });
    await settingsStore.update((next) => {
      next.settings.webSearch = migration.settings;
    });
  }

  /**
   * Migrate onto the split layout, then backfill anything a newer release added.
   *
   * `migratePiProviderConfig` straddles the split: it rewrites providers and
   * aliases (portable) while also remapping `settings.lastProviderId` (local). It
   * runs over a composite draft and the halves are written separately, which is
   * safe here because seeding happens once before any handler can race it.
   *
   * The composite must carry the real `models` and `modelMetadata`, because
   * `isUntouchedPiPreset` compares both to decide whether a legacy preset was
   * ever edited. Composing from an empty cache would make every untouched preset
   * look customised and retain providers this migration exists to retire.
   */
  async function ensureSeeded(): Promise<boolean> {
    if (!seedPromise) {
      seedPromise = (async () => {
        if (!(await configStores.ensureMigrated())) return false;
        if (await localStore.loadedFromUnsafeFile()) return false;
        if (await portable.loadedFromCorruptFile()) return false;

        const seeded = (await localStore.load()).seeded;
        const cacheBefore = (await modelCache.load()).byProvider;
        const currentSettings = runtimeSettingsFrom((await settingsStore.load()).settings);
        let lastProviderId = currentSettings.lastProviderId;
        let hiddenModelsByProvider = currentSettings.hiddenModelsByProvider;
        let migrated: StoredProvider[] = [];
        let providersChanged = false;
        let aliasRoutesForMigration: Record<string, string> = {};

        // Read-modify-*maybe*-write. Seeding is the single gate every other
        // caller awaits, so nothing can interleave between this load and the
        // save. Writing only on a real change matters because the target is a
        // file the user edits by hand: an unconditional rewrite on every launch
        // would reorder their keys, drop anything Aiden does not recognise, and
        // — before the corrupt-file guard below — silently replace a file with a
        // JSON typo with an empty default.
        const before = await portable.load();
        const normalized = normalizePortableConfig(before);
        const config = normalized.config;
        if (normalized.unsafe) return false;
        const aliasesBeforeMigration = Object.fromEntries(Object.entries(config.providerIdAliases));

        // A fresh install already starts with no providers. Never use this
        // machine's local seed marker to clear portable provider intent: a
        // valid ~/.aiden/config.json may have been copied here from another
        // machine before this local root exists.
        const draft = {
          providers: config.providers.map((intent) =>
            composeStoredProvider(intent, cacheBefore[intent.id]),
          ),
          providerIdAliases: config.providerIdAliases,
          settings: { lastProviderId: currentSettings.lastProviderId },
        };
        providersChanged = migratePiProviderConfig(draft);
        config.providers = draft.providers.map((provider) => splitStoredProvider(provider).intent);
        config.providerIdAliases = draft.providerIdAliases ?? {};
        aliasRoutesForMigration = aliasesBeforeMigration;
        for (const [source, target] of Object.entries(config.providerIdAliases)) {
          if (!Object.prototype.hasOwnProperty.call(aliasRoutesForMigration, source)) {
            setRecordEntry(aliasRoutesForMigration, source, target);
          }
        }
        lastProviderId = draft.settings.lastProviderId;
        migrated = draft.providers;
        if (normalizePortableConfig(config).unsafe) {
          // Migration may add an alias to an otherwise maximum-capacity graph.
          // Never publish a document this same build would reject on restart.
          return false;
        }

        if (JSON.stringify(config) !== JSON.stringify(before)) {
          await portable.save(config);
        }

        if (!seeded) {
          await localStore.update((config) => void (config.seeded = true));
        }
        const activeProviderIds = new Set(config.providers.map((provider) => provider.id));
        const cacheAliasEntries = providerAliasRoutes(aliasRoutesForMigration).filter(
          ([legacyId, targetId]) =>
            legacyId !== targetId &&
            !activeProviderIds.has(legacyId) &&
            activeProviderIds.has(targetId),
        );
        secretMigrationAliases = cacheAliasEntries;
        for (const [legacyId, targetId] of cacheAliasEntries) {
          hiddenModelsByProvider = remapHiddenModelProvider(
            hiddenModelsByProvider,
            legacyId,
            targetId,
          );
        }
        if (
          lastProviderId !== currentSettings.lastProviderId ||
          JSON.stringify(hiddenModelsByProvider) !==
            JSON.stringify(currentSettings.hiddenModelsByProvider)
        ) {
          await settingsStore.update((config) => {
            config.settings.lastProviderId = lastProviderId;
            config.settings.hiddenModelsByProvider = hiddenModelsByProvider;
          });
        }
        secretMigrationTargets = [
          ...new Map(
            cacheAliasEntries.flatMap(([, targetId]) => {
              const intent = config.providers.find((provider) => provider.id === targetId);
              if (!intent) return [];
              const stored = composeStoredProvider(intent, ownRecordEntry(cacheBefore, targetId));
              return [
                [
                  targetId,
                  {
                    id: targetId,
                    binding: JSON.stringify(providerConnectionSnapshot(stored)),
                  },
                ] as const,
              ];
            }),
          ).values(),
        ];
        const cacheAliasRepairNeeded = cacheAliasEntries.some(([legacyId]) =>
          hasProviderCache(ownRecordEntry(cacheBefore, legacyId)),
        );
        if (providersChanged || cacheAliasRepairNeeded) {
          // Re-home the discovery cache onto the IDs that survived, the same way
          // secrets.migrateKeys re-homes API keys. Entries for retired presets
          // are dropped rather than orphaned under an ID nothing references.
          // Alias repair also runs independently on later launches so a crash
          // after the portable write cannot permanently strand cache data.
          await modelCache.update((draft) => {
            if (providersChanged) {
              const next: Record<string, ProviderModelCacheEntry> = {};
              for (const provider of migrated) {
                const embedded = splitStoredProvider(provider).cache;
                const existing = ownRecordEntry(cacheBefore, provider.id);
                const legacy = cacheAliasEntries
                  .filter(([, targetId]) => targetId === provider.id)
                  .map(([legacyId]) => ownRecordEntry(cacheBefore, legacyId))
                  .reduce<ProviderModelCacheEntry>(
                    (combined, entry) => mergeProviderModelCacheEntries(entry, combined),
                    {},
                  );
                const cache = mergeProviderModelCacheEntries(
                  mergeProviderModelCacheEntries(embedded, legacy),
                  existing,
                );
                if (hasProviderCache(cache)) setRecordEntry(next, provider.id, cache);
              }
              draft.byProvider = next;
              return;
            }
            for (const [legacyId, targetId] of cacheAliasEntries) {
              const legacy = ownRecordEntry(draft.byProvider, legacyId);
              if (!hasProviderCache(legacy)) continue;
              setRecordEntry(
                draft.byProvider,
                targetId,
                mergeProviderModelCacheEntries(legacy, ownRecordEntry(draft.byProvider, targetId)),
              );
              delete draft.byProvider[legacyId];
            }
          });
        }
        await localStore.update((config) => {
          if (!Array.isArray(config.workspaces) || config.workspaces.length === 0) {
            config.workspaces = [defaultWorkspace()];
          }
        });
        await ensureWebSearchSettings();
        return true;
      })().catch((error: unknown) => {
        seedPromise = null;
        throw error;
      });
    }
    const completed = await seedPromise;
    if (!completed) {
      seedPromise = null;
    } else {
      // Provider credentials are independently encrypted, so malformed or
      // temporarily unavailable secret storage must defer only key migration,
      // never the window/updater startup path or ordinary config reads.
      await attemptSecretMigration();
    }
    return completed;
  }

  async function requireSeededForWrite(): Promise<void> {
    if (!(await ensureSeeded())) {
      throw new Error(
        "Config migration is deferred; fix ~/.aiden/config.json and restart before changing settings.",
      );
    }
  }

  async function readPortable(): Promise<PortableConfigShape> {
    await ensureSeeded();
    return normalizePortableConfig(await portable.load()).config;
  }

  async function mutatePortable<R>(
    mutation: (draft: PortableConfigShape) => R | Promise<R>,
    isCurrent: () => boolean = () => true,
  ): Promise<R> {
    await requireSeededForWrite();
    if (await portable.loadedFromCorruptFile()) {
      throw new Error("Portable config contains invalid JSON; fix ~/.aiden/config.json first.");
    }
    return portable.update(async (draft) => {
      const normalized = normalizePortableConfig(draft);
      if (normalized.unsafe) {
        throw new Error(
          "Portable config is malformed; edit ~/.aiden/config.json before changing it.",
        );
      }
      Object.assign(draft, normalized.config);
      const result = await mutation(draft);
      const mutated = normalizePortableConfig(draft);
      if (mutated.unsafe) {
        throw new Error("The requested change would create an invalid portable config.");
      }
      Object.assign(draft, mutated.config);
      return result;
    }, isCurrent);
  }

  async function mutateSettings<R>(
    mutation: (draft: SettingsShape) => R | Promise<R>,
    isCurrent: () => boolean = () => true,
  ): Promise<R> {
    await requireSeededForWrite();
    return settingsStore.update(mutation, isCurrent);
  }

  async function readModelCache(): Promise<ProviderModelCacheShape> {
    await ensureSeeded();
    return modelCache.load();
  }

  async function toProvider(
    p: StoredProvider,
    providerIdAliases: Readonly<Record<string, string>>,
  ): Promise<Provider> {
    return {
      ...p,
      hasKey: secrets.getProviderKey
        ? Boolean(await secrets.getProviderKey(p.id, JSON.stringify(providerConnectionSnapshot(p))))
        : await secrets.hasKey(p.id),
      legacyIds: Object.keys(providerIdAliases).filter(
        (legacyId) => resolveProviderAlias(providerIdAliases, legacyId) === p.id,
      ),
    };
  }

  return {
    /**
     * Reset setup-owned configuration without deleting user-created work.
     * Skills and workspaces remain; providers, MCP connections, preferences,
     * and regenerable provider discovery data return to first-launch defaults.
     */
    async resetUserSetup(): Promise<void> {
      await mutatePortable((config) => {
        config.providers = [];
        config.providerIdAliases = {};
        config.mcpServers = [];
      });
      await mutateSettings((config) => {
        config.settings = {};
      });
      await modelCache.update((config) => {
        config.byProvider = {};
      });
    },

    async portableConfigSafeForCredentialReconciliation(): Promise<boolean> {
      return portableConfigSafeForCredentialReconciliation(true);
    },

    async cachedPortableConfigSafeForCredentialReconciliation(): Promise<boolean> {
      return portableConfigSafeForCredentialReconciliation(false);
    },

    /**
     * Legacy Pi keys may be copied only after provider aliases were read from a
     * safe portable document and their encrypted keys finished migrating. If
     * either half is deferred, an old built-in-looking ID could still belong to
     * a custom endpoint and must remain untouched.
     */
    async providerLegacyCredentialMigrationReady(): Promise<boolean> {
      if (!(await ensureSeeded()) || !secretMigrationComplete) return false;
      if (await portable.loadedFromCorruptFile()) return false;
      return !normalizePortableConfig(await portable.load()).unsafe;
    },

    async listProviders(): Promise<Provider[]> {
      const config = await readPortable();
      const cache = await readModelCache();
      return Promise.all(
        config.providers.map((intent) =>
          toProvider(
            composeStoredProvider(intent, ownRecordEntry(cache.byProvider, intent.id)),
            config.providerIdAliases,
          ),
        ),
      );
    },

    async getProvider(id: string): Promise<StoredProvider | undefined> {
      const config = await readPortable();
      const intent = config.providers.find((p) => p.id === id);
      if (!intent) return undefined;
      return composeStoredProvider(intent, ownRecordEntry((await readModelCache()).byProvider, id));
    },

    /** Insert or update a provider record (upsert by id). */
    async saveProvider(
      provider: StoredProvider,
      isCurrent: () => boolean = () => true,
    ): Promise<Provider> {
      const { intent, cache } = splitStoredProvider(provider);
      const stored = await mutatePortable((config) => {
        const idx = config.providers.findIndex((p) => p.id === intent.id);
        if (idx >= 0) config.providers[idx] = { ...config.providers[idx], ...intent };
        else config.providers.push(intent);
        return structuredClone(config.providers.find((p) => p.id === intent.id)!);
      }, isCurrent);
      const entry = await modelCache.update((draft) => {
        const next = { ...ownRecordEntry(draft.byProvider, intent.id), ...cache };
        setRecordEntry(draft.byProvider, intent.id, next);
        return structuredClone(next);
      }, isCurrent);
      const config = await readPortable();
      return toProvider(composeStoredProvider(stored, entry), config.providerIdAliases);
    },

    async removeProvider(id: string, isCurrent: () => boolean = () => true): Promise<void> {
      await mutatePortable((config) => {
        config.providers = config.providers.filter((p) => p.id !== id);
      }, isCurrent);
      // Once portable deletion commits, finish every dependent cleanup even if
      // the requesting renderer navigates away. Otherwise recreating this ID
      // can revive stale cache or visibility state.
      await modelCache.update((draft) => void delete draft.byProvider[id]);
      await mutateSettings((config) => {
        config.settings.hiddenModelsByProvider = withoutProviderVisibility(
          config.settings.hiddenModelsByProvider,
          id,
        );
      });
      await secrets.deleteKey(id);
    },

    /** Resolve a historical provider identity without ever falling through to a new Pi provider. */
    async resolveProviderId(id: string | undefined): Promise<string | undefined> {
      if (!id) return id;
      const config = await readPortable();
      return resolveProviderAlias(config.providerIdAliases, id) ?? migrateLegacyPiProviderId(id);
    },

    async getSettings(): Promise<AppSettings> {
      await ensureSeeded();
      return runtimeSettingsFrom((await settingsStore.load()).settings);
    },

    /** Read the normalized Web Search document after startup migration. */
    async getWebSearchSettings(): Promise<WebSearchSettingsV2> {
      await ensureSeeded();
      const settings = runtimeSettingsFrom((await settingsStore.load()).settings);
      // A present but unsupported/future document is projected closed. The
      // raw value remains durable for a newer build, while runtime callers get
      // a supported shape that cannot authorize a request.
      return settings.webSearch ?? { ...freshWebSearchSettings(), enabled: false };
    },

    /** Atomically update only Web Search settings; credentials stay elsewhere. */
    async updateWebSearchSettings(
      mutation: (current: WebSearchSettingsV2) => WebSearchSettingsV2,
      isCurrent: () => boolean = () => true,
    ): Promise<AppSettings> {
      const saved = await mutateSettings((config) => {
        const hasWebSearch = Object.prototype.hasOwnProperty.call(config.settings, "webSearch");
        const current = parseWebSearchSettings(config.settings.webSearch);
        if (!current && hasWebSearch) {
          throw new Error(
            "Web Search settings are invalid or from a newer version; repair settings.json before changing them.",
          );
        }
        const next = normalizeWebSearchSettings(
          mutation(structuredClone(current ?? freshWebSearchSettings())),
        );
        config.settings.webSearch = next;
        return structuredClone(config.settings);
      }, isCurrent);
      return runtimeSettingsFrom(saved);
    },

    async setSettings(
      patch: Partial<AppSettings>,
      isCurrent: () => boolean = () => true,
    ): Promise<AppSettings> {
      // Aliases live in the portable store, so the alias lookup and the settings
      // write are no longer one transaction. Safe: providerIdAliases is an
      // append-only migration record that a settings change never rewrites. Do
      // not "fix" this by folding settings back into the portable file.
      const providerIdAliases = (await readPortable()).providerIdAliases;
      const saved = await mutateSettings((config) => {
        // Web Search has its own versioned mutation seam. A generic settings
        // write may preserve an unsupported raw document, but it must not use
        // this broad patch API to replace that document (or introduce a new
        // unvalidated one) while an older build cannot interpret it.
        if (Object.prototype.hasOwnProperty.call(patch, "webSearch")) {
          const currentHasWebSearch = Object.prototype.hasOwnProperty.call(
            config.settings,
            "webSearch",
          );
          if (currentHasWebSearch && !parseWebSearchSettings(config.settings.webSearch)) {
            throw new Error(
              "Web Search settings are invalid or from a newer version; repair settings.json before changing them.",
            );
          }
          if (!parseWebSearchSettings(patch.webSearch)) {
            throw new Error("Web Search settings must be a supported version 2 document.");
          }
        }
        const lastProviderId =
          typeof patch.lastProviderId === "string"
            ? (resolveProviderAlias(providerIdAliases, patch.lastProviderId) ??
              migrateLegacyPiProviderId(patch.lastProviderId))
            : patch.lastProviderId;
        config.settings = {
          ...config.settings,
          ...patch,
          ...(patch.assistant
            ? { assistant: { ...config.settings.assistant, ...patch.assistant } }
            : {}),
          ...(lastProviderId !== undefined ? { lastProviderId } : {}),
        };
        return structuredClone(config.settings);
      }, isCurrent);
      return runtimeSettingsFrom(saved);
    },

    /**
     * Commit Gemini's purpose and Voice selection together. The visibility
     * sentinel hides future Google chat models too, without making a model
     * pinned by an existing chat unexecutable.
     */
    async setGeminiVoiceSetup(
      scope: import("./types.js").GeminiUsageScope,
      voiceModel: string,
    ): Promise<AppSettings> {
      const saved = await mutateSettings((config) => {
        config.settings.geminiUsageScope = scope;
        config.settings.voiceProvider = "gemini";
        config.settings.voiceModel = voiceModel;
        config.settings.hiddenModelsByProvider = hiddenModelsForGeminiScope(
          config.settings.hiddenModelsByProvider,
          GOOGLE_PROVIDER_ID,
          scope,
        );
        return structuredClone(config.settings);
      });
      return runtimeSettingsFrom(saved);
    },

    /**
     * Update Gemini's allowed purpose without changing the active Voice
     * provider. Provider credential management uses this path so rotating a
     * Google key cannot silently move transcription away from local or OpenAI.
     */
    async setGeminiUsageScope(scope: import("./types.js").GeminiUsageScope): Promise<AppSettings> {
      const saved = await mutateSettings((config) => {
        config.settings.geminiUsageScope = scope;
        config.settings.hiddenModelsByProvider = hiddenModelsForGeminiScope(
          config.settings.hiddenModelsByProvider,
          GOOGLE_PROVIDER_ID,
          scope,
        );
        return structuredClone(config.settings);
      });
      return runtimeSettingsFrom(saved);
    },

    /** Atomically update one presentation-only model visibility preference. */
    async setModelVisibility(
      providerId: string,
      modelId: string,
      hidden: boolean,
    ): Promise<AppSettings> {
      const saved = await mutateSettings((config) => {
        if (
          providerId === GOOGLE_PROVIDER_ID &&
          config.settings.geminiUsageScope === "transcription_only" &&
          !hidden
        ) {
          return structuredClone(config.settings);
        }
        config.settings.hiddenModelsByProvider = withModelVisibility(
          config.settings.hiddenModelsByProvider,
          providerId,
          modelId,
          hidden,
        );
        return structuredClone(config.settings);
      });
      return runtimeSettingsFrom(saved);
    },

    /** Atomically restore every model for one provider to picker visibility. */
    async showAllProviderModels(providerId: string): Promise<AppSettings> {
      const saved = await mutateSettings((config) => {
        if (
          providerId === GOOGLE_PROVIDER_ID &&
          config.settings.geminiUsageScope === "transcription_only"
        ) {
          return structuredClone(config.settings);
        }
        config.settings.hiddenModelsByProvider = withoutProviderVisibility(
          config.settings.hiddenModelsByProvider,
          providerId,
        );
        return structuredClone(config.settings);
      });
      return runtimeSettingsFrom(saved);
    },

    /** Atomically merge one validated native-Google preference into current settings. */
    async setGoogleThinkingLevel(
      modelId: string,
      level: GoogleThinkingLevel,
    ): Promise<AppSettings> {
      const saved = await mutateSettings((config) => {
        config.settings.googleThinkingByModel = mergeGoogleThinkingPreference(
          config.settings.googleThinkingByModel,
          modelId,
          level,
        );
        return structuredClone(config.settings);
      });
      return runtimeSettingsFrom(saved);
    },

    /** Atomically merge one validated ChatGPT/Codex preference into current settings. */
    async setCodexThinkingLevel(modelId: string, level: CodexThinkingLevel): Promise<AppSettings> {
      const saved = await mutateSettings((config) => {
        config.settings.codexThinkingByModel = mergeCodexThinkingPreference(
          config.settings.codexThinkingByModel,
          modelId,
          level,
        );
        return structuredClone(config.settings);
      });
      return runtimeSettingsFrom(saved);
    },

    /** Atomically merge one validated Anthropic preference into current settings. */
    async setAnthropicThinkingLevel(
      modelId: string,
      level: AnthropicThinkingLevel,
    ): Promise<AppSettings> {
      const saved = await mutateSettings((config) => {
        config.settings.anthropicThinkingByModel = mergeAnthropicThinkingPreference(
          config.settings.anthropicThinkingByModel,
          modelId,
          level,
        );
        return structuredClone(config.settings);
      });
      return runtimeSettingsFrom(saved);
    },

    /** Atomically persist a Pi-native thinking preference for any other provider. */
    async setProviderThinkingLevel(
      providerId: string,
      modelId: string,
      level: GenerationThinkingLevel,
    ): Promise<AppSettings> {
      const saved = await mutateSettings((config) => {
        config.settings.providerThinkingByModel = mergeProviderThinkingPreference(
          config.settings.providerThinkingByModel,
          providerId,
          modelId,
          level,
        );
        return structuredClone(config.settings);
      });
      return runtimeSettingsFrom(saved);
    },

    // ── MCP servers ──────────────────────────────────────────────────────
    async listMcpServers(): Promise<McpServer[]> {
      return (await readPortable()).mcpServers;
    },

    async saveMcpServer(
      server: McpServer,
      isCurrent: () => boolean = () => true,
    ): Promise<McpServer> {
      return mutatePortable((config) => {
        const idx = config.mcpServers.findIndex((s) => s.id === server.id);
        if (idx >= 0) config.mcpServers[idx] = { ...config.mcpServers[idx], ...server };
        else config.mcpServers.push(server);
        return structuredClone(server);
      }, isCurrent);
    },

    async removeMcpServer(id: string, isCurrent: () => boolean = () => true): Promise<void> {
      await mutatePortable((config) => {
        config.mcpServers = config.mcpServers.filter((s) => s.id !== id);
      }, isCurrent);
    },

    // ── Skills ───────────────────────────────────────────────────────────
    async listSkills(): Promise<Skill[]> {
      return (await readPortable()).skills;
    },

    async saveSkill(skill: Skill): Promise<Skill> {
      return mutatePortable((config) => {
        const idx = config.skills.findIndex((s) => s.id === skill.id);
        if (idx >= 0) config.skills[idx] = { ...config.skills[idx], ...skill };
        else config.skills.push(skill);
        return structuredClone(skill);
      });
    },

    async removeSkill(id: string): Promise<void> {
      await mutatePortable((config) => {
        config.skills = config.skills.filter((s) => s.id !== id);
      });
    },

    // ── Workspaces ───────────────────────────────────────────────────────
    // Machine-local: folderPath and managedWorktree name absolute paths and git
    // identities that only resolve on this machine, so they are not portable.
    async listWorkspaces(): Promise<Workspace[]> {
      await ensureSeeded();
      return (await localStore.load()).workspaces;
    },

    async getWorkspace(id: string): Promise<Workspace | undefined> {
      await ensureSeeded();
      return (await localStore.load()).workspaces.find((w) => w.id === id);
    },

    /** Insert or update a workspace (upsert by id). */
    async saveWorkspace(workspace: Workspace): Promise<Workspace> {
      // The Aiden assistant's threads live under this reserved id and it must
      // never resolve to a real folder: a workspace claiming it would hand the
      // assistant that folder's path and permission, and would cross-link its
      // threads into the main sidebar.
      if (workspace.id === ASSISTANT_WORKSPACE_ID) {
        throw new Error(`"${ASSISTANT_WORKSPACE_ID}" is reserved and cannot be a workspace id.`);
      }
      const next = normalizeWorkspace({ ...workspace, updatedAt: Date.now() });
      await requireSeededForWrite();
      return localStore.update((config) => {
        const idx = config.workspaces.findIndex((w) => w.id === next.id);
        if (idx >= 0) config.workspaces[idx] = { ...config.workspaces[idx], ...next };
        else config.workspaces.push(next);
        return structuredClone(config.workspaces.find((w) => w.id === next.id)!);
      });
    },

    async removeWorkspace(id: string): Promise<void> {
      await requireSeededForWrite();
      await localStore.update((config) => {
        config.workspaces = config.workspaces.filter((w) => w.id !== id);
        // Never leave the app without a workspace.
        if (config.workspaces.length === 0) config.workspaces = [defaultWorkspace()];
      });
    },
  };
}
