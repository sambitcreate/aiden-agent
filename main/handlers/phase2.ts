// Phase-2 IPC handlers: Skills, MCP servers, Exa web search, and voice transcription.

import { ipcMain } from "../platform.js";
import { configStore } from "../services/config-store.js";
import { secrets } from "../services/secrets.js";
import { mcpManager } from "../services/mcp.js";
import { authorizeMcpServer, clearOAuth, hasOAuthTokens } from "../services/mcp-oauth.js";
import {
  assertMcpPresetServer,
  getMcpPresetForServerId,
  MCP_PRESETS,
  presetSecretId,
  presetServerId,
} from "../services/mcp-presets.js";
import { discoverSkills } from "../services/skills-discovery.js";
import { transcribe } from "../services/transcription.js";
import { asString } from "./voice-codec.js";
import { parseSkill, parseMcpServer } from "./phase2-parse.js";

// Re-exported so the IPC contract surface stays queryable from one module.
export { asString, parseSkill, parseMcpServer };

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
  // Built-in provider catalog with per-preset connection state. Preset API keys
  // live in the encrypted secrets store ("mcp:<serverId>"), never in config.json.
  ipcMain.handle("mcp:presets", async () => {
    const servers = await configStore.listMcpServers();
    return Promise.all(
      MCP_PRESETS.map(async (preset) => {
        const serverId = presetServerId(preset.id);
        const existing = servers.find(
          (s) => s.id === serverId && s.presetId === preset.id,
        );
        const ready =
          preset.auth.kind === "apiKey"
            ? await secrets.hasKey(presetSecretId(serverId))
            : await hasOAuthTokens(serverId, existing?.url ?? preset.url);
        return { preset, serverId, configured: Boolean(existing), enabled: existing?.enabled ?? true, ready };
      }),
    );
  });
  // Save or clear a preset's API key. Empty key clears; the key is never returned.
  ipcMain.handle("mcp:setPresetKey", async (_event, serverId: unknown, key: unknown) => {
    const id = asString(serverId, "serverId");
    const preset = getMcpPresetForServerId(id);
    if (!preset || preset.auth.kind !== "apiKey") {
      throw new Error("This MCP preset does not accept an API key.");
    }
    const value = typeof key === "string" ? key.trim() : "";
    if (value) await secrets.setKey(presetSecretId(id), value);
    else await secrets.deleteKey(presetSecretId(id));
    await mcpManager.disconnect(id); // reconnect with the new key on next use
    return { hasKey: Boolean(value) };
  });
  ipcMain.handle("mcp:save", async (_event, server: unknown) => {
    const parsed = parseMcpServer(server);
    assertMcpPresetServer(parsed);
    const existing = (await configStore.listMcpServers()).find((item) => item.id === parsed.id);
    await mcpManager.disconnect(parsed.id); // force reconnect with new config next use
    if (existing?.oauth && !parsed.oauth) await clearOAuth(parsed.id);
    return configStore.saveMcpServer(parsed);
  });
  ipcMain.handle("mcp:remove", async (_event, id: unknown) => {
    const serverId = asString(id, "id");
    await mcpManager.disconnect(serverId);
    await clearOAuth(serverId);
    await secrets.deleteKey(presetSecretId(serverId));
    await configStore.removeMcpServer(serverId);
  });
  ipcMain.handle("mcp:status", async (_event, server: unknown) => {
    const parsed = parseMcpServer(server);
    const status = await mcpManager.status(parsed);
    return {
      ...status,
      authorized: parsed.oauth ? await hasOAuthTokens(parsed.id, parsed.url) : undefined,
    };
  });
  // Browser OAuth sign-in for a remote MCP server. Stores tokens on success.
  ipcMain.handle("mcp:authorize", async (_event, server: unknown) => {
    const parsed = parseMcpServer(server);
    const preset = assertMcpPresetServer(parsed);
    if (preset && preset.auth.kind !== "oauth") {
      throw new Error("This MCP preset uses an API key instead of OAuth.");
    }
    await mcpManager.disconnect(parsed.id);
    await authorizeMcpServer(parsed);
    return { authorized: true };
  });
  ipcMain.handle("mcp:oauthStatus", async (_event, id: unknown) => {
    const serverId = asString(id, "id");
    const server = (await configStore.listMcpServers()).find((item) => item.id === serverId);
    return { authorized: await hasOAuthTokens(serverId, server?.url) };
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
    else {
      await secrets.deleteKey("exa");
      await configStore.setSettings({ exaEnabled: false });
    }
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
      signal: AbortSignal.timeout(120_000),
    });
  });

}
