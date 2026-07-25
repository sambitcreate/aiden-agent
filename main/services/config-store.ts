// Custom-provider configuration + lightweight app settings persistence.
// Pi built-ins are derived from its runtime registry, not seeded into this file.

import { DataStore } from "./data-store.js";
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
import { secrets } from "./secrets.js";
import { migrateLegacyPiProviderId } from "../../renderer/shared/google-provider.js";
import type {
  AppSettings,
  McpServer,
  Provider,
  Skill,
  StoredProvider,
  Workspace,
} from "./types.js";

interface ConfigShape {
  providers: StoredProvider[];
  /** Historic custom ID -> reserved custom ID. Never expose a Pi collision again. */
  providerIdAliases: Record<string, string>;
  settings: AppSettings;
  seeded: boolean;
  mcpServers: McpServer[];
  skills: Skill[];
  workspaces: Workspace[];
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

const store = new DataStore<ConfigShape>("config.json", {
  providers: [],
  providerIdAliases: {},
  settings: {},
  seeded: false,
  mcpServers: [],
  skills: [],
  workspaces: [],
});

let seedPromise: Promise<void> | null = null;

async function ensureSeeded(): Promise<ConfigShape> {
  if (!seedPromise) {
    seedPromise = store
      .update((config) => {
        if (!config.seeded) {
          config.providers = [];
          config.seeded = true;
        }
        // Backfill arrays added after the initial release.
        if (!Array.isArray(config.mcpServers)) config.mcpServers = [];
        if (!Array.isArray(config.skills)) config.skills = [];
        if (!config.providerIdAliases || typeof config.providerIdAliases !== "object") {
          config.providerIdAliases = {};
        }
        if (!Array.isArray(config.workspaces) || config.workspaces.length === 0) {
          config.workspaces = [defaultWorkspace()];
        }
        migratePiProviderConfig(config);
      })
      .then(async () => {
        const config = await store.load();
        await secrets.migrateKeys((keys) => {
          let changed = false;
          for (const [legacyId, customId] of Object.entries(config.providerIdAliases)) {
            if (!keys[legacyId] || legacyId === customId) continue;
            if (!keys[customId]) keys[customId] = keys[legacyId];
            delete keys[legacyId];
            changed = true;
          }
          return migrateGoogleProviderKeyMap(keys) || changed;
        });
      })
      .catch((error: unknown) => {
        seedPromise = null;
        throw error;
      });
  }
  await seedPromise;
  return store.load();
}

async function mutateConfig<R>(
  mutation: (draft: ConfigShape) => R | Promise<R>,
  isCurrent: () => boolean = () => true,
): Promise<R> {
  await ensureSeeded();
  return store.update(mutation, isCurrent);
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

export const configStore = {
  async listProviders(): Promise<Provider[]> {
    const config = await ensureSeeded();
    return Promise.all(
      config.providers.map((provider) => toProvider(provider, config.providerIdAliases)),
    );
  },

  async getProvider(id: string): Promise<StoredProvider | undefined> {
    const config = await ensureSeeded();
    return config.providers.find((p) => p.id === id);
  },

  /** Insert or update a provider record (upsert by id). */
  async saveProvider(provider: StoredProvider): Promise<Provider> {
    const stored = await mutateConfig((config) => {
      const idx = config.providers.findIndex((p) => p.id === provider.id);
      if (idx >= 0) config.providers[idx] = { ...config.providers[idx], ...provider };
      else config.providers.push(provider);
      return structuredClone(config.providers.find((p) => p.id === provider.id)!);
    });
    const config = await ensureSeeded();
    return toProvider(stored, config.providerIdAliases);
  },

  async removeProvider(id: string): Promise<void> {
    await mutateConfig((config) => {
      config.providers = config.providers.filter((p) => p.id !== id);
    });
    await secrets.deleteKey(id);
  },

  /** Resolve a historical provider identity without ever falling through to a new Pi provider. */
  async resolveProviderId(id: string | undefined): Promise<string | undefined> {
    if (!id) return id;
    const config = await ensureSeeded();
    return config.providerIdAliases[id] ?? migrateLegacyPiProviderId(id);
  },

  async getSettings(): Promise<AppSettings> {
    const config = await ensureSeeded();
    return config.settings;
  },

  async setSettings(
    patch: Partial<AppSettings>,
    isCurrent: () => boolean = () => true,
  ): Promise<AppSettings> {
    return mutateConfig((config) => {
      const lastProviderId =
        typeof patch.lastProviderId === "string"
          ? (config.providerIdAliases[patch.lastProviderId] ??
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
  async setGoogleThinkingLevel(modelId: string, level: GoogleThinkingLevel): Promise<AppSettings> {
    return mutateConfig((config) => {
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
    return mutateConfig((config) => {
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
    return mutateConfig((config) => {
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
    const config = await ensureSeeded();
    return config.mcpServers;
  },

  async saveMcpServer(server: McpServer): Promise<McpServer> {
    return mutateConfig((config) => {
      const idx = config.mcpServers.findIndex((s) => s.id === server.id);
      if (idx >= 0) config.mcpServers[idx] = server;
      else config.mcpServers.push(server);
      return structuredClone(server);
    });
  },

  async removeMcpServer(id: string): Promise<void> {
    await mutateConfig((config) => {
      config.mcpServers = config.mcpServers.filter((s) => s.id !== id);
    });
  },

  // ── Skills ───────────────────────────────────────────────────────────
  async listSkills(): Promise<Skill[]> {
    const config = await ensureSeeded();
    return config.skills;
  },

  async saveSkill(skill: Skill): Promise<Skill> {
    return mutateConfig((config) => {
      const idx = config.skills.findIndex((s) => s.id === skill.id);
      if (idx >= 0) config.skills[idx] = skill;
      else config.skills.push(skill);
      return structuredClone(skill);
    });
  },

  async removeSkill(id: string): Promise<void> {
    await mutateConfig((config) => {
      config.skills = config.skills.filter((s) => s.id !== id);
    });
  },

  // ── Workspaces ───────────────────────────────────────────────────────
  async listWorkspaces(): Promise<Workspace[]> {
    const config = await ensureSeeded();
    return config.workspaces;
  },

  async getWorkspace(id: string): Promise<Workspace | undefined> {
    const config = await ensureSeeded();
    return config.workspaces.find((w) => w.id === id);
  },

  /** Insert or update a workspace (upsert by id). */
  async saveWorkspace(workspace: Workspace): Promise<Workspace> {
    const next = normalizeWorkspace({ ...workspace, updatedAt: Date.now() });
    return mutateConfig((config) => {
      const idx = config.workspaces.findIndex((w) => w.id === next.id);
      if (idx >= 0) config.workspaces[idx] = { ...config.workspaces[idx], ...next };
      else config.workspaces.push(next);
      return structuredClone(config.workspaces.find((w) => w.id === next.id)!);
    });
  },

  async removeWorkspace(id: string): Promise<void> {
    await mutateConfig((config) => {
      config.workspaces = config.workspaces.filter((w) => w.id !== id);
      // Never leave the app without a workspace.
      if (config.workspaces.length === 0) config.workspaces = [defaultWorkspace()];
    });
  },
};
