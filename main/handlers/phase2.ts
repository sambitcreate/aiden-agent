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
import { skillRegistry } from "../services/skill-registry-main.js";
import { transcribe } from "../services/transcription.js";
import { geminiLiveTranscription } from "../services/gemini-live-transcription.js";
import { asString } from "./voice-codec.js";
import { parseSkill, parseMcpServer } from "./phase2-parse.js";
import { rendererDocumentOwner } from "../services/renderer-document-owner.js";
import type { RendererDocumentOwner } from "../services/renderer-document-owner.js";
import { mutatePortableConfigAndSync } from "../services/portable-credential-snapshot.js";
import { withMcpConfigurationPublication } from "../services/mcp-config-lease.js";
import { webSearchCredentials } from "../services/web-search-credentials.js";
import {
  DEFAULT_WEB_SEARCH_FALLBACK_ON,
  WEB_SEARCH_PROVIDER_REGISTRY,
  getWebSearchProviderDefinition,
  isWebSearchProviderId,
  normalizeWebSearchSettings,
  projectWebSearchProviderRegistry,
  webSearchRouteReadiness,
  type WebSearchProviderStatus,
  type WebSearchProviderId,
  type WebSearchRendererSnapshot,
  type WebSearchRouteReadiness,
  type WebSearchSettingsV2,
} from "../services/web-search-provider-registry-core.js";

interface ActiveVoiceTranscription {
  controller: AbortController;
  removeOwnerInvalidation: () => void;
}

const activeVoiceTranscriptions = new Map<string, ActiveVoiceTranscription>();

function webSearchMutationOwner(event: Electron.IpcMainInvokeEvent): RendererDocumentOwner {
  return rendererDocumentOwner(
    event,
    () => new Error("Web Search changes must come from the active application document."),
  );
}

function webSearchSettingsSnapshot(
  settings: WebSearchSettingsV2,
  statuses: Partial<Record<WebSearchProviderId, WebSearchProviderStatus>>,
): WebSearchRendererSnapshot {
  const selection = structuredClone(settings.selection);
  const route =
    selection.mode === "fixed"
      ? [
          {
            providerId: selection.providerId,
            credentialMode: selection.credentialMode ?? "anonymous",
          },
        ]
      : structuredClone(selection.route);
  return {
    settings: structuredClone(settings),
    // This helper receives only categorical statuses. The registry projection
    // removes fixed origins and all credential details.
    providers: projectWebSearchProviderRegistry(statuses),
    selection,
    route,
    routeReadiness: webSearchRouteReadiness(
      settings,
      Object.fromEntries(
        Object.entries(statuses).map(([providerId, status]) => [
          providerId,
          status?.configurationStatus === "configured"
            ? { hasCredential: true }
            : { hasCredential: false },
        ]),
      ) as Partial<Record<WebSearchProviderId, { hasCredential: boolean }>>,
    ) as WebSearchRouteReadiness[],
  };
}

function supportsApiKeyCredential(
  definition: ReturnType<typeof getWebSearchProviderDefinition>,
): boolean {
  return (
    definition?.credentialKind === "optional-api-key" ||
    definition?.credentialKind === "api-key" ||
    definition?.credentialKind === "endpoint-and-api-key" ||
    definition?.credentialKind === "api-key-and-zone"
  );
}

async function readWebSearchSnapshot(): Promise<WebSearchRendererSnapshot> {
  const settings = await configStore.getWebSearchSettings();
  const statuses: Partial<Record<WebSearchProviderId, WebSearchProviderStatus>> = {};
  await Promise.all(
    WEB_SEARCH_PROVIDER_REGISTRY.map(async (definition) => {
      const config = settings.providerConfig[definition.id];
      if (supportsApiKeyCredential(definition)) {
        let hasCredential = false;
        try {
          hasCredential = await webSearchCredentials.has(
            webSearchCredentials.reference(definition.id, config),
          );
        } catch {
          hasCredential = false;
        }
        statuses[definition.id] = {
          configurationStatus:
            hasCredential || definition.credentialKind === "optional-api-key"
              ? hasCredential
                ? "configured"
                : "not-required"
              : "needs-setup",
          ready:
            definition.releaseState === "shipped" &&
            (hasCredential || definition.credentialKind === "optional-api-key"),
        };
        return;
      }
      if (definition.credentialKind === "endpoint") {
        const configured = typeof config?.endpoint === "string";
        statuses[definition.id] = {
          configurationStatus: configured ? "configured" : "needs-setup",
          ready: definition.releaseState === "shipped" && configured,
        };
        return;
      }
      if (definition.credentialKind === "none") {
        statuses[definition.id] = {
          configurationStatus: "not-required",
          ready: definition.releaseState === "shipped",
        };
        return;
      }
      // Existing-provider-auth and future auth combinations stay explicit
      // until their provider-specific binding is implemented.
      statuses[definition.id] = {
        configurationStatus: "needs-setup",
        ready: false,
      };
    }),
  );
  return webSearchSettingsSnapshot(settings, statuses);
}

async function updateWebSearchSnapshot(
  event: Electron.IpcMainInvokeEvent,
  mutation: (current: WebSearchSettingsV2) => WebSearchSettingsV2,
): Promise<WebSearchRendererSnapshot> {
  const owner = webSearchMutationOwner(event);
  await configStore.updateWebSearchSettings(mutation, () => !owner.isDestroyed());
  if (owner.isDestroyed()) throw new Error("The renderer document is no longer active.");
  return readWebSearchSnapshot();
}

function voiceOperationKey(owner: RendererDocumentOwner, value: unknown): string {
  const operationId = asString(value, "operationId");
  if (operationId.length > 128 || !/^[A-Za-z0-9._:-]+$/u.test(operationId)) {
    throw new Error("Invalid voice transcription operation.");
  }
  return `${owner.id}:${owner.documentId}:${operationId}`;
}

// Re-exported so the IPC contract surface stays queryable from one module.
export { asString, parseSkill, parseMcpServer };

export function registerPhase2Handlers(): void {
  // ── Skills ───────────────────────────────────────────────────────────
  ipcMain.handle("skills:list", async () => configStore.listSkills());
  ipcMain.handle("skills:save", async (_event, skill: unknown) => {
    try {
      return await mutatePortableConfigAndSync(() => configStore.saveSkill(parseSkill(skill)));
    } finally {
      skillRegistry.invalidate();
    }
  });
  ipcMain.handle("skills:remove", async (_event, id: unknown) => {
    try {
      await mutatePortableConfigAndSync(() => configStore.removeSkill(asString(id, "id")));
    } finally {
      skillRegistry.invalidate();
    }
  });
  ipcMain.handle("skills:catalog", async (_event, workspaceId: unknown) =>
    skillRegistry.catalog(asString(workspaceId, "workspaceId")),
  );
  // Compatibility alias with the safe workspace-id contract. Renderer paths
  // are never accepted as discovery authority.
  ipcMain.handle("skills:discovered", async (_event, workspaceId: unknown) =>
    skillRegistry.catalog(asString(workspaceId, "workspaceId")),
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

  // ── Web Search settings and credentials ─────────────────────────────
  ipcMain.handle("webSearch:get", async (event) => {
    const owner = webSearchMutationOwner(event);
    if (owner.isDestroyed()) throw new Error("The renderer document is no longer active.");
    return readWebSearchSnapshot();
  });
  ipcMain.handle("webSearch:setEnabled", async (event, enabled: unknown) => {
    if (typeof enabled !== "boolean") throw new Error("Web Search enabled must be a boolean.");
    return updateWebSearchSnapshot(event, (current) =>
      normalizeWebSearchSettings({ ...current, enabled }),
    );
  });
  ipcMain.handle("webSearch:setSelection", async (event, selection: unknown) => {
    return updateWebSearchSnapshot(event, (current) =>
      normalizeWebSearchSettings({ ...current, selection }),
    );
  });
  ipcMain.handle("webSearch:setAutomaticRoute", async (event, route: unknown) => {
    return updateWebSearchSnapshot(event, (current) => {
      const fallbackOn =
        current.selection.mode === "automatic"
          ? current.selection.fallbackOn
          : [...DEFAULT_WEB_SEARCH_FALLBACK_ON];
      return normalizeWebSearchSettings({
        ...current,
        selection: { mode: "automatic", route, fallbackOn },
      });
    });
  });
  ipcMain.handle(
    "webSearch:setProviderConfig",
    async (event, providerId: unknown, providerConfig: unknown) => {
      if (!isWebSearchProviderId(providerId)) {
        throw new Error("Unknown Web Search provider.");
      }
      return updateWebSearchSnapshot(event, (current) => {
        const nextProviderConfig: Record<string, unknown> = { ...current.providerConfig };
        if (providerConfig === null) delete nextProviderConfig[providerId];
        else nextProviderConfig[providerId] = providerConfig;
        return normalizeWebSearchSettings({ ...current, providerConfig: nextProviderConfig });
      });
    },
  );
  ipcMain.handle("webSearch:setCredential", async (event, providerId: unknown, key: unknown) => {
    const owner = webSearchMutationOwner(event);
    if (!isWebSearchProviderId(providerId)) throw new Error("Unknown Web Search provider.");
    const settings = await configStore.getWebSearchSettings();
    const reference = webSearchCredentials.reference(
      providerId,
      settings.providerConfig[providerId],
    );
    await webSearchCredentials.set(reference, key, () => !owner.isDestroyed());
    if (owner.isDestroyed()) throw new Error("The renderer document is no longer active.");
    return readWebSearchSnapshot();
  });
  ipcMain.handle("webSearch:removeCredential", async (event, providerId: unknown) => {
    const owner = webSearchMutationOwner(event);
    if (!isWebSearchProviderId(providerId)) throw new Error("Unknown Web Search provider.");
    const settings = await configStore.getWebSearchSettings();
    const reference = webSearchCredentials.reference(
      providerId,
      settings.providerConfig[providerId],
    );
    await webSearchCredentials.remove(reference, () => !owner.isDestroyed());
    if (owner.isDestroyed()) throw new Error("The renderer document is no longer active.");
    return readWebSearchSnapshot();
  });

  // Legacy Exa aliases remain for one rollback window. They use the same
  // fenced v2 credential path and never expose the plaintext key.
  ipcMain.handle("exa:get", async (event) => {
    const owner = webSearchMutationOwner(event);
    if (owner.isDestroyed()) throw new Error("The renderer document is no longer active.");
    const settings = await configStore.getWebSearchSettings();
    const reference = webSearchCredentials.reference("exa", settings.providerConfig.exa);
    return { enabled: settings.enabled, hasKey: await webSearchCredentials.has(reference) };
  });
  ipcMain.handle("exa:setKey", async (event, key: unknown) => {
    const owner = webSearchMutationOwner(event);
    const settings = await configStore.getWebSearchSettings();
    const reference = webSearchCredentials.reference("exa", settings.providerConfig.exa);
    const value = typeof key === "string" ? key.trim() : "";
    if (value) await webSearchCredentials.set(reference, value, () => !owner.isDestroyed());
    else {
      await webSearchCredentials.remove(reference, () => !owner.isDestroyed());
      await configStore.updateWebSearchSettings(
        (current) => ({ ...current, enabled: false }),
        () => !owner.isDestroyed(),
      );
    }
    if (owner.isDestroyed()) throw new Error("The renderer document is no longer active.");
    return { hasKey: await webSearchCredentials.has(reference) };
  });
  ipcMain.handle("exa:setEnabled", async (event, enabled: unknown) => {
    if (typeof enabled !== "boolean") throw new Error("Web Search enabled must be a boolean.");
    await updateWebSearchSnapshot(event, (current) => ({ ...current, enabled }));
    return configStore.getSettings();
  });

  // ── Voice transcription ──────────────────────────────────────────────
  ipcMain.handle(
    "voice:transcribe",
    async (
      event,
      audioBase64: unknown,
      mimeType: unknown,
      model: unknown,
      operationId: unknown,
    ) => {
      const owner = rendererDocumentOwner(
        event,
        () => new Error("Voice transcription must come from the active application document."),
      );
      const key = voiceOperationKey(owner, operationId);
      activeVoiceTranscriptions.get(key)?.controller.abort();
      const controller = new AbortController();
      const removeOwnerInvalidation = owner.onInvalidated(() => controller.abort());
      activeVoiceTranscriptions.set(key, { controller, removeOwnerInvalidation });
      try {
        return await transcribe({
          audioBase64: asString(audioBase64, "audioBase64"),
          mimeType: typeof mimeType === "string" ? mimeType : "audio/webm",
          model: typeof model === "string" ? model : undefined,
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]),
        });
      } finally {
        removeOwnerInvalidation();
        if (activeVoiceTranscriptions.get(key)?.controller === controller) {
          activeVoiceTranscriptions.delete(key);
        }
      }
    },
  );
  ipcMain.handle("voice:transcribeCancel", (event, operationId: unknown) => {
    const owner = rendererDocumentOwner(
      event,
      () => new Error("Voice transcription must come from the active application document."),
    );
    activeVoiceTranscriptions.get(voiceOperationKey(owner, operationId))?.controller.abort();
  });
  ipcMain.handle("voice:streamStart", async (event) => {
    const owner = rendererDocumentOwner(
      event,
      () => new Error("Voice streaming must come from the active application document."),
    );
    return geminiLiveTranscription.start(owner);
  });
  ipcMain.handle("voice:streamPush", (event, sessionId: unknown, pcmBase64: unknown) => {
    const owner = rendererDocumentOwner(
      event,
      () => new Error("Voice streaming must come from the active application document."),
    );
    geminiLiveTranscription.push(owner, asString(sessionId, "sessionId"), pcmBase64);
  });
  ipcMain.handle("voice:streamFinish", async (event, sessionId: unknown) => {
    const owner = rendererDocumentOwner(
      event,
      () => new Error("Voice streaming must come from the active application document."),
    );
    return geminiLiveTranscription.finish(owner, asString(sessionId, "sessionId"));
  });
  ipcMain.handle("voice:streamCancel", (event, sessionId: unknown) => {
    const owner = rendererDocumentOwner(
      event,
      () => new Error("Voice streaming must come from the active application document."),
    );
    geminiLiveTranscription.cancel(owner, asString(sessionId, "sessionId"));
  });
}
