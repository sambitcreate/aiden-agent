// Phase-2 IPC handlers: Skills, MCP servers, Exa web search, voice transcription,
// and the global shortcut. Thin — logic lives in services.

import { ipcMain } from "@glaze/core/backend";
import { configStore } from "../services/config-store.js";
import { secrets } from "../services/secrets.js";
import { mcpManager } from "../services/mcp.js";
import { authorizeMcpServer, clearOAuth, hasOAuthTokens } from "../services/mcp-oauth.js";
import { discoverSkills } from "../services/skills-discovery.js";
import { transcribe } from "../services/transcription.js";
import { applyShortcutFromSettings } from "../services/shortcut.js";
import type { McpServer, McpTransport, Skill } from "../services/types.js";

function asString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`Expected non-empty string for "${name}".`);
  return value;
}

function parseSkill(value: unknown): Skill {
  if (typeof value !== "object" || value === null) throw new Error("Invalid skill payload.");
  const s = value as Record<string, unknown>;
  return {
    id: asString(s.id, "id"),
    name: asString(s.name, "name"),
    description: typeof s.description === "string" ? s.description : "",
    instructions: typeof s.instructions === "string" ? s.instructions : "",
    enabled: typeof s.enabled === "boolean" ? s.enabled : true,
  };
}

function parseStringRecord(value: unknown): Record<string, string> | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

function parseMcpServer(value: unknown): McpServer {
  if (typeof value !== "object" || value === null) throw new Error("Invalid MCP server payload.");
  const s = value as Record<string, unknown>;
  const transport: McpTransport = s.transport === "http" || s.transport === "sse" ? s.transport : "stdio";
  return {
    id: asString(s.id, "id"),
    name: asString(s.name, "name"),
    transport,
    command: typeof s.command === "string" ? s.command : undefined,
    args: Array.isArray(s.args) ? s.args.filter((a): a is string => typeof a === "string") : undefined,
    env: parseStringRecord(s.env),
    url: typeof s.url === "string" ? s.url : undefined,
    headers: parseStringRecord(s.headers),
    oauth: typeof s.oauth === "boolean" ? s.oauth : undefined,
    enabled: typeof s.enabled === "boolean" ? s.enabled : true,
  };
}

export function registerPhase2Handlers(): void {
  // ── Skills ───────────────────────────────────────────────────────────
  ipcMain.handle("skills:list", async () => configStore.listSkills());
  ipcMain.handle("skills:save", async (_event, skill: unknown) => configStore.saveSkill(parseSkill(skill)));
  ipcMain.handle("skills:remove", async (_event, id: unknown) => configStore.removeSkill(asString(id, "id")));
  // Read-only skills discovered on disk from `.agents` folders (workspace + global).
  ipcMain.handle("skills:discovered", async (_event, folderPath: unknown) =>
    discoverSkills(typeof folderPath === "string" && folderPath ? folderPath : undefined),
  );

  // ── MCP servers ──────────────────────────────────────────────────────
  ipcMain.handle("mcp:list", async () => configStore.listMcpServers());
  ipcMain.handle("mcp:save", async (_event, server: unknown) => {
    const parsed = parseMcpServer(server);
    await mcpManager.disconnect(parsed.id); // force reconnect with new config next use
    return configStore.saveMcpServer(parsed);
  });
  ipcMain.handle("mcp:remove", async (_event, id: unknown) => {
    const serverId = asString(id, "id");
    await mcpManager.disconnect(serverId);
    await clearOAuth(serverId);
    await configStore.removeMcpServer(serverId);
  });
  ipcMain.handle("mcp:status", async (_event, server: unknown) => {
    const parsed = parseMcpServer(server);
    await mcpManager.disconnect(parsed.id);
    const status = await mcpManager.status(parsed);
    return { ...status, authorized: parsed.oauth ? await hasOAuthTokens(parsed.id) : undefined };
  });
  // Browser OAuth sign-in for a remote MCP server. Stores tokens on success.
  ipcMain.handle("mcp:authorize", async (_event, server: unknown) => {
    const parsed = parseMcpServer(server);
    await mcpManager.disconnect(parsed.id);
    await authorizeMcpServer(parsed);
    return { authorized: true };
  });
  // Force-drop all cached MCP connections so the next message reconnects fresh.
  ipcMain.handle("mcp:reconnect", async () => {
    await mcpManager.closeAll();
  });

  // ── Exa web search ───────────────────────────────────────────────────
  ipcMain.handle("exa:get", async () => {
    const settings = await configStore.getSettings();
    return { enabled: settings.exaEnabled ?? false, hasKey: await secrets.hasKey("exa") };
  });
  ipcMain.handle("exa:setKey", async (_event, key: unknown) => {
    const value = typeof key === "string" ? key.trim() : "";
    if (value) await secrets.setKey("exa", value);
    else await secrets.deleteKey("exa");
    return { hasKey: Boolean(value) };
  });
  ipcMain.handle("exa:setEnabled", async (_event, enabled: unknown) => {
    return configStore.setSettings({ exaEnabled: enabled === true });
  });

  // ── Voice transcription ──────────────────────────────────────────────
  ipcMain.handle("voice:transcribe", async (_event, audioBase64: unknown, mimeType: unknown) => {
    return transcribe({
      audioBase64: asString(audioBase64, "audioBase64"),
      mimeType: typeof mimeType === "string" ? mimeType : "audio/webm",
    });
  });

  // ── Global shortcut ──────────────────────────────────────────────────
  ipcMain.handle("shortcut:apply", async () => {
    await applyShortcutFromSettings();
  });
}
