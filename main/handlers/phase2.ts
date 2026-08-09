// Phase-2 IPC handlers: Skills, MCP servers, Exa web search, and voice transcription.

import { ipcMain } from "../platform.js";
import { configStore } from "../services/config-store.js";
import { secrets } from "../services/secrets.js";
import { mcpManager } from "../services/mcp.js";
import {
  authorizeMcpServer,
  endReservedMcpAuthorization,
  hasOAuthTokens,
  reserveMcpAuthorization,
} from "../services/mcp-oauth.js";
import type { McpOAuthOperation } from "../services/mcp-oauth-operation.js";
import {
  mutateCredentialForConfiguredMcp,
  mutateMcpWithCredentialCleanup,
  withConfiguredMcp,
} from "../services/mcp-credential-cleanup.js";
import {
  mcpCredentialConnectionSnapshot,
  mcpRuntimeConnectionSnapshot,
  pendingMcpCredentialCleanupForRemove,
  pendingMcpCredentialCleanupForSave,
  replaceMcpCredentialAfterDisconnect,
} from "../services/mcp-credential-cleanup-core.js";
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
import { rendererDocumentOwner } from "../services/renderer-document-owner.js";
import { mutatePortableConfigAndSync } from "../services/portable-credential-snapshot.js";
import { withMcpConfigurationPublication } from "../services/mcp-config-lease.js";

// Re-exported so the IPC contract surface stays queryable from one module.
export { asString, parseSkill, parseMcpServer };

export function registerPhase2Handlers(): void {
  // ── Skills ───────────────────────────────────────────────────────────
  ipcMain.handle("skills:list", async () => configStore.listSkills());
  ipcMain.handle("skills:save", async (_event, skill: unknown) =>
    mutatePortableConfigAndSync(() => configStore.saveSkill(parseSkill(skill))),
  );
  ipcMain.handle("skills:remove", async (_event, id: unknown) =>
    mutatePortableConfigAndSync(() => configStore.removeSkill(asString(id, "id"))),
  );
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
        const existing = servers.find((s) => s.id === serverId && s.presetId === preset.id);
        if (existing) assertMcpPresetServer(existing);
        const ready =
          preset.auth.kind === "apiKey"
            ? Boolean(
                existing &&
                (await secrets.getOrBindLegacyProviderKey(
                  presetSecretId(serverId),
                  JSON.stringify(mcpCredentialConnectionSnapshot(existing)),
                )),
              )
            : await hasOAuthTokens(serverId, existing?.url ?? preset.url);
        return {
          preset,
          serverId,
          configured: Boolean(existing),
          enabled: existing?.enabled ?? true,
          ready,
        };
      }),
    );
  });
  // Save or clear a preset's API key. Empty key clears; the key is never returned.
  ipcMain.handle("mcp:setPresetKey", async (event, serverId: unknown, key: unknown) => {
    const owner = rendererDocumentOwner(
      event,
      () => new Error("MCP changes must come from the active application document."),
    );
    const isCurrent = () => !owner.isDestroyed();
    const id = asString(serverId, "serverId");
    const preset = getMcpPresetForServerId(id);
    if (!preset || preset.auth.kind !== "apiKey") {
      throw new Error("This MCP preset does not accept an API key.");
    }
    const value = typeof key === "string" ? key.trim() : "";
    await mutateCredentialForConfiguredMcp(
      id,
      (configured) =>
        replaceMcpCredentialAfterDisconnect(
          () => mcpManager.disconnect(id),
          async () => {
            await withMcpConfigurationPublication(id, async () => {
              if (value)
                await secrets.setProviderKey(
                  presetSecretId(id),
                  value,
                  JSON.stringify(mcpCredentialConnectionSnapshot(configured)),
                  isCurrent,
                );
              else await secrets.deleteKey(presetSecretId(id), isCurrent);
            });
          },
        ),
      isCurrent,
    );
    return { hasKey: Boolean(value) };
  });
  ipcMain.handle("mcp:save", async (event, server: unknown) => {
    const owner = rendererDocumentOwner(
      event,
      () => new Error("MCP changes must come from the active application document."),
    );
    const isCurrent = () => !owner.isDestroyed();
    const parsed = parseMcpServer(server);
    assertMcpPresetServer(parsed);
    return mutateMcpWithCredentialCleanup(
      parsed.id,
      (current) => pendingMcpCredentialCleanupForSave(current, parsed),
      async () => {
        await mcpManager.disconnect(parsed.id);
        return withMcpConfigurationPublication(parsed.id, () =>
          configStore.saveMcpServer(parsed, isCurrent),
        );
      },
      isCurrent,
    );
  });
  ipcMain.handle("mcp:remove", async (event, id: unknown) => {
    const owner = rendererDocumentOwner(
      event,
      () => new Error("MCP changes must come from the active application document."),
    );
    const isCurrent = () => !owner.isDestroyed();
    const serverId = asString(id, "id");
    await mutateMcpWithCredentialCleanup(
      serverId,
      (current) => pendingMcpCredentialCleanupForRemove(current, serverId),
      async () => {
        await mcpManager.disconnect(serverId);
        await withMcpConfigurationPublication(serverId, () =>
          configStore.removeMcpServer(serverId, isCurrent),
        );
      },
      isCurrent,
    );
  });
  ipcMain.handle("mcp:status", async (event, server: unknown) => {
    const owner = rendererDocumentOwner(
      event,
      () => new Error("MCP status must come from the active application document."),
    );
    const parsed = parseMcpServer(server);
    let statusGeneration = 0;
    return withConfiguredMcp(
      parsed.id,
      mcpRuntimeConnectionSnapshot(parsed),
      async () => {
        const status = await mcpManager.status(
          parsed,
          () => !owner.isDestroyed(),
          statusGeneration,
        );
        return {
          ...status,
          authorized: parsed.oauth ? await hasOAuthTokens(parsed.id, parsed.url) : undefined,
        };
      },
      () => !owner.isDestroyed(),
      () => {
        statusGeneration = mcpManager.statusGeneration(parsed.id);
      },
    );
  });
  // Browser OAuth sign-in for a remote MCP server. Stores tokens on success.
  ipcMain.handle("mcp:authorize", async (event, server: unknown) => {
    const owner = rendererDocumentOwner(
      event,
      () => new Error("MCP authorization must come from the active application document."),
    );
    const parsed = parseMcpServer(server);
    const preset = assertMcpPresetServer(parsed);
    if (preset && preset.auth.kind !== "oauth") {
      throw new Error("This MCP preset uses an API key instead of OAuth.");
    }
    const ownerAbort = new AbortController();
    let reserved: McpOAuthOperation | undefined;
    const stopWatching = owner.onInvalidated(() =>
      ownerAbort.abort(new Error("The renderer document is no longer active.")),
    );
    try {
      return await withConfiguredMcp(
        parsed.id,
        mcpRuntimeConnectionSnapshot(parsed),
        async () => {
          await mcpManager.disconnect(parsed.id);
          await authorizeMcpServer(parsed, () => !owner.isDestroyed(), ownerAbort.signal, reserved);
          reserved = undefined;
          return { authorized: true };
        },
        () => !owner.isDestroyed(),
        () => {
          reserved = reserveMcpAuthorization(parsed.id);
        },
      );
    } finally {
      if (reserved) endReservedMcpAuthorization(reserved);
      stopWatching();
    }
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
