// Provider configuration + API key IPC handlers. Thin — logic lives in services.

import { ipcMain } from "../platform.js";
import { configStore } from "../services/config-store.js";
import { NO_AUTH_API_KEY } from "../services/generation-runtime.js";
import {
  canUseStoredProviderKey,
  sameProviderConnection,
} from "../services/provider-key-policy.js";
import { secrets } from "../services/secrets.js";
import { listModels, testConnection } from "../services/models.js";
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
    baseUrl: asString(p.baseUrl, "baseUrl").replace(/\/$/, ""),
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
  // Keyless providers must never pull a stale stored secret into a local/LAN
  // connection test merely because the provider ids happen to match. Pi sends
  // this non-secret compatibility value during generation, so test and model
  // discovery must send the same request shape.
  if (!provider.needsKey) return NO_AUTH_API_KEY;
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

export function registerProviderHandlers(): void {
  ipcMain.handle("providers:list", async () => configStore.listProviders());

  ipcMain.handle(
    "providers:save",
    async (_event, providerValue: unknown, keyOverride?: unknown) => {
      return saveProvider(parseProvider(providerValue), keyOverride);
    },
  );

  ipcMain.handle("providers:remove", async (_event, id: unknown) => {
    await configStore.removeProvider(asString(id, "id"));
  });

  ipcMain.handle("providers:setKey", async (_event, id: unknown, key: unknown) => {
    const providerId = asString(id, "id");
    const value = typeof key === "string" ? key.trim() : "";
    if (value) {
      await secrets.setKey(providerId, value);
    } else {
      await secrets.deleteKey(providerId);
    }
    const provider = await configStore.getProvider(providerId);
    return { hasKey: Boolean(value), provider: provider ?? null };
  });

  // Optional keyOverride lets the user test a freshly typed key before saving it.
  ipcMain.handle(
    "providers:test",
    async (_event, providerValue: unknown, keyOverride?: unknown) => {
      const provider = parseProvider(providerValue);
      const key = await connectionKey(provider, keyOverride);
      return testConnection(provider, key);
    },
  );

  ipcMain.handle(
    "providers:listModels",
    async (_event, providerValue: unknown, keyOverride?: unknown) => {
      const provider = parseProvider(providerValue);
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
    return configStore.setSettings(next);
  });
}
