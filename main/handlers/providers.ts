// Provider configuration + API key IPC handlers. Thin — logic lives in services.

import { ipcMain, logger } from "../platform.js";
import { configStore } from "../services/config-store.js";
import {
  canUseStoredProviderKey,
  sameProviderConnection,
} from "../services/provider-key-policy.js";
import { secrets } from "../services/secrets.js";
import { listModels, normalizeProviderBaseUrl, testConnection } from "../services/models.js";
import {
  parseProviderAuthProviderId,
  parseProviderAuthResponseRequest,
  parseProviderAuthStartRequest,
} from "../services/provider-auth-flow-core.js";
import { providerAuthFlow } from "../services/provider-auth-flow.js";
import { providerAuthOwner } from "../services/provider-auth-owner.js";
import { providerRegistry } from "../services/provider-registry.js";
import {
  assertMutableProviderId,
  forwardCodexProviderStatusChanges,
  mergeCodexProvider,
} from "../services/provider-list-core.js";
import type { ProviderKind, StoredProvider } from "../services/types.js";

function asString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Expected non-empty string for "${name}".`);
  }
  return value;
}

function parseProvider(value: unknown): StoredProvider {
  if (typeof value !== "object" || value === null) {
    throw new Error("Invalid provider payload.");
  }
  const p = value as Record<string, unknown>;
  const kind = p.kind === "anthropic" ? "anthropic" : ("openai" as ProviderKind);
  return {
    id: asString(p.id, "id"),
    kind,
    label: asString(p.label, "label"),
    baseUrl: normalizeProviderBaseUrl(asString(p.baseUrl, "baseUrl")),
    models: Array.isArray(p.models)
      ? p.models.filter((m): m is string => typeof m === "string")
      : [],
    defaultModel: typeof p.defaultModel === "string" ? p.defaultModel : undefined,
    needsKey: typeof p.needsKey === "boolean" ? p.needsKey : true,
    isPreset: typeof p.isPreset === "boolean" ? p.isPreset : false,
  };
}

async function connectionKey(
  provider: StoredProvider,
  keyOverride: unknown,
): Promise<string | null> {
  // Keyless providers must never pull a stale stored secret into a connection
  // test merely because the provider ids happen to match. Discovery talks to
  // the HTTP endpoint directly, so it must send no compatibility token either.
  if (!provider.needsKey) return null;
  if (typeof keyOverride === "string" && keyOverride.trim()) return keyOverride.trim();

  const saved = await configStore.getProvider(provider.id);
  // A saved key is valid only for the saved endpoint/protocol. A draft with a
  // different endpoint must receive a newly typed key before it can be tested.
  if (!canUseStoredProviderKey(saved, provider)) return null;
  return secrets.getKey(provider.id);
}

function replacementKey(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Save a provider and rotate its secret as one main-process operation. An
 * existing key is removed before a changed endpoint becomes usable, so a
 * renderer payload cannot redirect it to another host.
 */
async function saveProvider(provider: StoredProvider, keyOverride: unknown) {
  assertMutableProviderId(provider.id);
  const previous = await configStore.getProvider(provider.id);
  const connectionChanged = Boolean(previous && !sameProviderConnection(previous, provider));
  const replacement = provider.needsKey ? replacementKey(keyOverride) : null;

  if (connectionChanged || !provider.needsKey) await secrets.deleteKey(provider.id);
  // Never restore a key after an endpoint/protocol change. A configuration
  // write can fail after the in-memory store has advanced, and restoring the
  // old credential would then expose it to the newly supplied endpoint.
  const saved = await configStore.saveProvider(provider);
  if (replacement) await secrets.setKey(provider.id, replacement);
  return saved;
}

async function listProviders() {
  const providers = await configStore.listProviders();
  try {
    return mergeCodexProvider(providers, await providerRegistry.codex.snapshot());
  } catch {
    logger.warn("providers", "ChatGPT / Codex status was unavailable while listing providers.");
    return mergeCodexProvider(providers, null);
  }
}

export function registerProviderHandlers(): void {
  forwardCodexProviderStatusChanges(providerRegistry.codex, (channel, event) =>
    ipcMain.broadcast(channel, event),
  );

  ipcMain.handle("providers:list", listProviders);

  ipcMain.handle("providers:auth:status", async (_event, providerId: unknown) =>
    providerAuthFlow.status(parseProviderAuthProviderId(providerId)),
  );

  ipcMain.handle("providers:auth:start", (event, request: unknown) =>
    providerAuthFlow.start(providerAuthOwner(event), parseProviderAuthStartRequest(request)),
  );

  ipcMain.handle("providers:auth:respond", (event, request: unknown) =>
    providerAuthFlow.respond(providerAuthOwner(event), parseProviderAuthResponseRequest(request)),
  );

  ipcMain.handle("providers:auth:cancel", (event, request: unknown) =>
    providerAuthFlow.cancel(providerAuthOwner(event), parseProviderAuthStartRequest(request)),
  );

  ipcMain.handle("providers:logout", async (event, providerId: unknown) => {
    // Logout is a credential mutation, so reject requests queued by a document
    // that navigation or renderer replacement has already made stale.
    providerAuthOwner(event);
    return providerAuthFlow.logout(parseProviderAuthProviderId(providerId));
  });

  ipcMain.handle(
    "providers:save",
    async (_event, providerValue: unknown, keyOverride?: unknown) => {
      return saveProvider(parseProvider(providerValue), keyOverride);
    },
  );

  ipcMain.handle("providers:remove", async (_event, id: unknown) => {
    const providerId = asString(id, "id");
    assertMutableProviderId(providerId);
    await configStore.removeProvider(providerId);
  });

  ipcMain.handle("providers:setKey", async (_event, id: unknown, key: unknown) => {
    const providerId = asString(id, "id");
    assertMutableProviderId(providerId);
    const provider = await configStore.getProvider(providerId);
    if (provider && !provider.needsKey) {
      await secrets.deleteKey(providerId);
      return { hasKey: false, provider };
    }
    const value = typeof key === "string" ? key.trim() : "";
    if (value) {
      await secrets.setKey(providerId, value);
    } else {
      await secrets.deleteKey(providerId);
    }
    return { hasKey: Boolean(value), provider: provider ?? null };
  });

  // Optional keyOverride lets the user test a freshly typed key before saving it.
  ipcMain.handle(
    "providers:test",
    async (_event, providerValue: unknown, keyOverride?: unknown) => {
      const provider = parseProvider(providerValue);
      assertMutableProviderId(provider.id);
      const key = await connectionKey(provider, keyOverride);
      return testConnection(provider, key);
    },
  );

  ipcMain.handle(
    "providers:listModels",
    async (_event, providerValue: unknown, keyOverride?: unknown) => {
      const provider = parseProvider(providerValue);
      assertMutableProviderId(provider.id);
      const key = await connectionKey(provider, keyOverride);
      return listModels(provider, key);
    },
  );

  ipcMain.handle("settings:get", async () => configStore.getSettings());
  ipcMain.handle("settings:set", async (_event, patch: unknown) => {
    if (typeof patch !== "object" || patch === null) throw new Error("Invalid settings patch.");
    const p = patch as Record<string, unknown>;
    const next: Partial<import("../services/types.js").AppSettings> = {};
    if (typeof p.lastProviderId === "string") next.lastProviderId = p.lastProviderId;
    if (typeof p.lastModel === "string") next.lastModel = p.lastModel;
    if (typeof p.exaEnabled === "boolean") next.exaEnabled = p.exaEnabled;
    if (p.voiceProvider === "openai" || p.voiceProvider === "gemini" || p.voiceProvider === "local")
      next.voiceProvider = p.voiceProvider;
    if (typeof p.voiceModel === "string") next.voiceModel = p.voiceModel;
    if (typeof p.localVoiceModel === "string") next.localVoiceModel = p.localVoiceModel;
    if (typeof p.shortcutEnabled === "boolean") next.shortcutEnabled = p.shortcutEnabled;
    if (typeof p.shortcutAccelerator === "string") next.shortcutAccelerator = p.shortcutAccelerator;
    if (typeof p.dictationEnabled === "boolean") next.dictationEnabled = p.dictationEnabled;
    if (typeof p.dictationAccelerator === "string")
      next.dictationAccelerator = p.dictationAccelerator;
    if (
      p.chatTitleProviderId === "automatic" ||
      p.chatTitleProviderId === "apple-foundation-models" ||
      p.chatTitleProviderId === "chat-model"
    ) {
      next.chatTitleProviderId = p.chatTitleProviderId;
    }
    return configStore.setSettings(next);
  });
}
