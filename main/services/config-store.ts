// Provider configuration + lightweight app settings persistence.
// Seeds a set of preset providers on first run so users can just drop in a key.

import { DataStore } from "./data-store.js";
import { secrets } from "./secrets.js";
import type { AppSettings, McpServer, Provider, Skill, StoredProvider, Workspace } from "./types.js";

interface ConfigShape {
  providers: StoredProvider[];
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

/** Built-in presets. Hosted providers need a key; local backends do not. */
const PRESETS: StoredProvider[] = [
  {
    id: "openai",
    kind: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    models: ["gpt-4o", "gpt-4o-mini", "gpt-4.1", "o3-mini"],
    defaultModel: "gpt-4o",
    needsKey: true,
    isPreset: true,
  },
  {
    id: "anthropic",
    kind: "anthropic",
    label: "Anthropic (Claude)",
    baseUrl: "https://api.anthropic.com/v1",
    models: ["claude-sonnet-4-20250514", "claude-3-7-sonnet-latest", "claude-3-5-haiku-latest"],
    defaultModel: "claude-sonnet-4-20250514",
    needsKey: true,
    isPreset: true,
  },
  {
    id: "gemini",
    kind: "openai",
    label: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    models: ["gemini-2.0-flash", "gemini-1.5-pro", "gemini-1.5-flash"],
    defaultModel: "gemini-2.0-flash",
    needsKey: true,
    isPreset: true,
  },
  {
    id: "deepseek",
    kind: "openai",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    models: ["deepseek-chat", "deepseek-reasoner"],
    defaultModel: "deepseek-chat",
    needsKey: true,
    isPreset: true,
  },
  {
    id: "moonshot",
    kind: "openai",
    label: "Moonshot (Kimi)",
    baseUrl: "https://api.moonshot.ai/v1",
    models: ["kimi-k2-0711-preview", "moonshot-v1-128k", "moonshot-v1-32k"],
    defaultModel: "kimi-k2-0711-preview",
    needsKey: true,
    isPreset: true,
  },
  {
    id: "lmstudio",
    kind: "openai",
    label: "LM Studio (local)",
    baseUrl: "http://localhost:1234/v1",
    models: [],
    needsKey: false,
    isPreset: true,
  },
  {
    id: "ollama",
    kind: "openai",
    label: "Ollama (local)",
    baseUrl: "http://localhost:11434/v1",
    models: [],
    needsKey: false,
    isPreset: true,
  },
];

const store = new DataStore<ConfigShape>("config.json", {
  providers: [],
  settings: {},
  seeded: false,
  mcpServers: [],
  skills: [],
  workspaces: [],
});

async function ensureSeeded(): Promise<ConfigShape> {
  const config = await store.load();
  let dirty = false;
  if (!config.seeded) {
    config.providers = structuredClone(PRESETS);
    config.seeded = true;
    dirty = true;
  }
  // Backfill arrays added after the initial release.
  if (!Array.isArray(config.mcpServers)) {
    config.mcpServers = [];
    dirty = true;
  }
  if (!Array.isArray(config.skills)) {
    config.skills = [];
    dirty = true;
  }
  if (!Array.isArray(config.workspaces) || config.workspaces.length === 0) {
    config.workspaces = [defaultWorkspace()];
    dirty = true;
  }
  if (dirty) await store.save(config);
  return config;
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

async function toProvider(p: StoredProvider): Promise<Provider> {
  return { ...p, hasKey: await secrets.hasKey(p.id) };
}

export const configStore = {
  async listProviders(): Promise<Provider[]> {
    const config = await ensureSeeded();
    return Promise.all(config.providers.map(toProvider));
  },

  async getProvider(id: string): Promise<StoredProvider | undefined> {
    const config = await ensureSeeded();
    return config.providers.find((p) => p.id === id);
  },

  /** Insert or update a provider record (upsert by id). */
  async saveProvider(provider: StoredProvider): Promise<Provider> {
    const config = await ensureSeeded();
    const idx = config.providers.findIndex((p) => p.id === provider.id);
    if (idx >= 0) {
      config.providers[idx] = { ...config.providers[idx], ...provider };
    } else {
      config.providers.push(provider);
    }
    await store.save(config);
    return toProvider(config.providers.find((p) => p.id === provider.id)!);
  },

  async removeProvider(id: string): Promise<void> {
    const config = await ensureSeeded();
    config.providers = config.providers.filter((p) => p.id !== id);
    await store.save(config);
    await secrets.deleteKey(id);
  },

  async getSettings(): Promise<AppSettings> {
    const config = await ensureSeeded();
    return config.settings;
  },

  async setSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
    const config = await ensureSeeded();
    config.settings = { ...config.settings, ...patch };
    await store.save(config);
    return config.settings;
  },

  // ── MCP servers ──────────────────────────────────────────────────────
  async listMcpServers(): Promise<McpServer[]> {
    const config = await ensureSeeded();
    return config.mcpServers;
  },

  async saveMcpServer(server: McpServer): Promise<McpServer> {
    const config = await ensureSeeded();
    const idx = config.mcpServers.findIndex((s) => s.id === server.id);
    if (idx >= 0) config.mcpServers[idx] = server;
    else config.mcpServers.push(server);
    await store.save(config);
    return server;
  },

  async removeMcpServer(id: string): Promise<void> {
    const config = await ensureSeeded();
    config.mcpServers = config.mcpServers.filter((s) => s.id !== id);
    await store.save(config);
  },

  // ── Skills ───────────────────────────────────────────────────────────
  async listSkills(): Promise<Skill[]> {
    const config = await ensureSeeded();
    return config.skills;
  },

  async saveSkill(skill: Skill): Promise<Skill> {
    const config = await ensureSeeded();
    const idx = config.skills.findIndex((s) => s.id === skill.id);
    if (idx >= 0) config.skills[idx] = skill;
    else config.skills.push(skill);
    await store.save(config);
    return skill;
  },

  async removeSkill(id: string): Promise<void> {
    const config = await ensureSeeded();
    config.skills = config.skills.filter((s) => s.id !== id);
    await store.save(config);
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
    const config = await ensureSeeded();
    const next = normalizeWorkspace({ ...workspace, updatedAt: Date.now() });
    const idx = config.workspaces.findIndex((w) => w.id === next.id);
    if (idx >= 0) config.workspaces[idx] = { ...config.workspaces[idx], ...next };
    else config.workspaces.push(next);
    await store.save(config);
    return config.workspaces.find((w) => w.id === next.id)!;
  },

  async removeWorkspace(id: string): Promise<void> {
    const config = await ensureSeeded();
    config.workspaces = config.workspaces.filter((w) => w.id !== id);
    // Never leave the app without a workspace.
    if (config.workspaces.length === 0) config.workspaces = [defaultWorkspace()];
    await store.save(config);
  },
};
