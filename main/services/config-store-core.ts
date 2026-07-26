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

import {
  composeStoredProvider,
  splitStoredProvider,
  type PortableConfigShape,
  type PortableConfigStores,
  type ProviderModelCacheEntry,
  type ProviderModelCacheShape,
  type SettingsShape,
} from "./portable-config-core.js";
import { migrateGoogleProviderKeyMap } from "./google-provider.js";
import { migratePiProviderConfig } from "./provider-config-migration-core.js";
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
import { migrateLegacyPiProviderId } from "../../renderer/shared/google-provider.js";
import { ASSISTANT_WORKSPACE_ID } from "../../renderer/shared/assistant.js";
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
  deleteKey(providerId: string): Promise<void>;
  migrateKeys(migrate: (keys: Record<string, string>) => boolean): Promise<void>;
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
function normalizeWorkspace(w: Workspace): Workspace {
  return {
    ...w,
    name: w.name.trim() || "Workspace",
    permission: PERMISSIONS.has(w.permission) ? w.permission : "ask",
    managedWorktree:
      w.managedWorktree &&
      typeof w.managedWorktree.repositoryPath === "string" &&
      typeof w.managedWorktree.worktreePath === "string" &&
      typeof w.managedWorktree.branch === "string" &&
      typeof w.managedWorktree.createdFromHead === "string"
        ? { ...w.managedWorktree }
        : undefined,
  };
}

export type ConfigStore = ReturnType<typeof createConfigStore>;

export function createConfigStore(configStores: PortableConfigStores, secrets: SecretsPort) {
  const { portable, settings: settingsStore, local: localStore, modelCache } = configStores;
  let seedPromise: Promise<void> | null = null;

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
  async function ensureSeeded(): Promise<void> {
    if (!seedPromise) {
      seedPromise = (async () => {
        await configStores.ensureMigrated();

        const seeded = (await localStore.load()).seeded;
        const cacheBefore = (await modelCache.load()).byProvider;
        const currentSettings = (await settingsStore.load()).settings;
        let lastProviderId = currentSettings.lastProviderId;
        let migrated: StoredProvider[] = [];
        let providersChanged = false;

        // Read-modify-*maybe*-write. Seeding is the single gate every other
        // caller awaits, so nothing can interleave between this load and the
        // save. Writing only on a real change matters because the target is a
        // file the user edits by hand: an unconditional rewrite on every launch
        // would reorder their keys, drop anything Aiden does not recognise, and
        // — before the corrupt-file guard below — silently replace a file with a
        // JSON typo with an empty default.
        const before = await portable.load();
        const config = structuredClone(before);

        // A first-ever launch clears the provider list. Only ever true when the
        // list is already empty, so the ~/.aiden migration cannot lose anything
        // by having run before this.
        if (!seeded) config.providers = [];
        if (!Array.isArray(config.mcpServers)) config.mcpServers = [];
        if (!Array.isArray(config.skills)) config.skills = [];
        if (!config.providerIdAliases || typeof config.providerIdAliases !== "object") {
          config.providerIdAliases = {};
        }

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
        lastProviderId = draft.settings.lastProviderId;
        migrated = draft.providers;

        if (JSON.stringify(config) !== JSON.stringify(before)) {
          await portable.save(config);
        }

        if (!seeded) {
          await localStore.update((config) => void (config.seeded = true));
        }
        if (lastProviderId !== currentSettings.lastProviderId) {
          await settingsStore.update(
            (config) => void (config.settings.lastProviderId = lastProviderId),
          );
        }
        if (providersChanged) {
          // Re-home the discovery cache onto the IDs that survived, the same way
          // secrets.migrateKeys re-homes API keys. Entries for retired presets
          // are dropped rather than orphaned under an ID nothing references.
          await modelCache.update((draft) => {
            const next: Record<string, ProviderModelCacheEntry> = {};
            for (const provider of migrated) {
              const { cache } = splitStoredProvider(provider);
              if (cache.models?.length || cache.modelMetadata) next[provider.id] = cache;
            }
            draft.byProvider = next;
          });
        }
        await localStore.update((config) => {
          if (!Array.isArray(config.workspaces) || config.workspaces.length === 0) {
            config.workspaces = [defaultWorkspace()];
          }
        });

        const aliases = (await portable.load()).providerIdAliases;
        await secrets.migrateKeys((keys) => {
          let changed = false;
          for (const [legacyId, customId] of Object.entries(aliases)) {
            if (!keys[legacyId] || legacyId === customId) continue;
            if (!keys[customId]) keys[customId] = keys[legacyId];
            delete keys[legacyId];
            changed = true;
          }
          return migrateGoogleProviderKeyMap(keys) || changed;
        });
      })().catch((error: unknown) => {
        seedPromise = null;
        throw error;
      });
    }
    await seedPromise;
  }

  async function readPortable(): Promise<PortableConfigShape> {
    await ensureSeeded();
    return portable.load();
  }

  async function mutatePortable<R>(
    mutation: (draft: PortableConfigShape) => R | Promise<R>,
    isCurrent: () => boolean = () => true,
  ): Promise<R> {
    await ensureSeeded();
    return portable.update(mutation, isCurrent);
  }

  async function mutateSettings<R>(
    mutation: (draft: SettingsShape) => R | Promise<R>,
    isCurrent: () => boolean = () => true,
  ): Promise<R> {
    await ensureSeeded();
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
      hasKey: await secrets.hasKey(p.id),
      legacyIds: Object.entries(providerIdAliases)
        .filter(([, targetId]) => targetId === p.id)
        .map(([legacyId]) => legacyId),
    };
  }

  return {
    async listProviders(): Promise<Provider[]> {
      const config = await readPortable();
      const cache = await readModelCache();
      return Promise.all(
        config.providers.map((intent) =>
          toProvider(
            composeStoredProvider(intent, cache.byProvider[intent.id]),
            config.providerIdAliases,
          ),
        ),
      );
    },

    async getProvider(id: string): Promise<StoredProvider | undefined> {
      const config = await readPortable();
      const intent = config.providers.find((p) => p.id === id);
      if (!intent) return undefined;
      return composeStoredProvider(intent, (await readModelCache()).byProvider[id]);
    },

    /** Insert or update a provider record (upsert by id). */
    async saveProvider(provider: StoredProvider): Promise<Provider> {
      const { intent, cache } = splitStoredProvider(provider);
      const stored = await mutatePortable((config) => {
        const idx = config.providers.findIndex((p) => p.id === intent.id);
        if (idx >= 0) config.providers[idx] = { ...config.providers[idx], ...intent };
        else config.providers.push(intent);
        return structuredClone(config.providers.find((p) => p.id === intent.id)!);
      });
      const entry = await modelCache.update((draft) => {
        draft.byProvider[intent.id] = { ...draft.byProvider[intent.id], ...cache };
        return structuredClone(draft.byProvider[intent.id]);
      });
      const config = await readPortable();
      return toProvider(composeStoredProvider(stored, entry), config.providerIdAliases);
    },

    async removeProvider(id: string): Promise<void> {
      await mutatePortable((config) => {
        config.providers = config.providers.filter((p) => p.id !== id);
      });
      await modelCache.update((draft) => void delete draft.byProvider[id]);
      await secrets.deleteKey(id);
    },

    /** Resolve a historical provider identity without ever falling through to a new Pi provider. */
    async resolveProviderId(id: string | undefined): Promise<string | undefined> {
      if (!id) return id;
      const config = await readPortable();
      return config.providerIdAliases[id] ?? migrateLegacyPiProviderId(id);
    },

    async getSettings(): Promise<AppSettings> {
      await ensureSeeded();
      return (await settingsStore.load()).settings;
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
      return mutateSettings((config) => {
        const lastProviderId =
          typeof patch.lastProviderId === "string"
            ? (providerIdAliases[patch.lastProviderId] ??
              migrateLegacyPiProviderId(patch.lastProviderId))
            : patch.lastProviderId;
        config.settings = {
          ...config.settings,
          ...patch,
          ...(lastProviderId !== undefined ? { lastProviderId } : {}),
        };
        return structuredClone(config.settings);
      }, isCurrent);
    },

    /** Atomically merge one validated native-Google preference into current settings. */
    async setGoogleThinkingLevel(
      modelId: string,
      level: GoogleThinkingLevel,
    ): Promise<AppSettings> {
      return mutateSettings((config) => {
        config.settings.googleThinkingByModel = mergeGoogleThinkingPreference(
          config.settings.googleThinkingByModel,
          modelId,
          level,
        );
        return structuredClone(config.settings);
      });
    },

    /** Atomically merge one validated ChatGPT/Codex preference into current settings. */
    async setCodexThinkingLevel(modelId: string, level: CodexThinkingLevel): Promise<AppSettings> {
      return mutateSettings((config) => {
        config.settings.codexThinkingByModel = mergeCodexThinkingPreference(
          config.settings.codexThinkingByModel,
          modelId,
          level,
        );
        return structuredClone(config.settings);
      });
    },

    /** Atomically merge one validated Anthropic preference into current settings. */
    async setAnthropicThinkingLevel(
      modelId: string,
      level: AnthropicThinkingLevel,
    ): Promise<AppSettings> {
      return mutateSettings((config) => {
        config.settings.anthropicThinkingByModel = mergeAnthropicThinkingPreference(
          config.settings.anthropicThinkingByModel,
          modelId,
          level,
        );
        return structuredClone(config.settings);
      });
    },

    // ── MCP servers ──────────────────────────────────────────────────────
    async listMcpServers(): Promise<McpServer[]> {
      return (await readPortable()).mcpServers;
    },

    async saveMcpServer(server: McpServer): Promise<McpServer> {
      return mutatePortable((config) => {
        const idx = config.mcpServers.findIndex((s) => s.id === server.id);
        if (idx >= 0) config.mcpServers[idx] = server;
        else config.mcpServers.push(server);
        return structuredClone(server);
      });
    },

    async removeMcpServer(id: string): Promise<void> {
      await mutatePortable((config) => {
        config.mcpServers = config.mcpServers.filter((s) => s.id !== id);
      });
    },

    // ── Skills ───────────────────────────────────────────────────────────
    async listSkills(): Promise<Skill[]> {
      return (await readPortable()).skills;
    },

    async saveSkill(skill: Skill): Promise<Skill> {
      return mutatePortable((config) => {
        const idx = config.skills.findIndex((s) => s.id === skill.id);
        if (idx >= 0) config.skills[idx] = skill;
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
      await ensureSeeded();
      return localStore.update((config) => {
        const idx = config.workspaces.findIndex((w) => w.id === next.id);
        if (idx >= 0) config.workspaces[idx] = { ...config.workspaces[idx], ...next };
        else config.workspaces.push(next);
        return structuredClone(config.workspaces.find((w) => w.id === next.id)!);
      });
    },

    async removeWorkspace(id: string): Promise<void> {
      await ensureSeeded();
      await localStore.update((config) => {
        config.workspaces = config.workspaces.filter((w) => w.id !== id);
        // Never leave the app without a workspace.
        if (config.workspaces.length === 0) config.workspaces = [defaultWorkspace()];
      });
    },
  };
}
