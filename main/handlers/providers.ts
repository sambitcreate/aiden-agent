// Provider configuration + API key IPC handlers. Thin — logic lives in services.

import { ipcMain } from "../platform.js";
import { configStore } from "../services/config-store.js";
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
    models: Array.isArray(p.models) ? p.models.filter((m): m is string => typeof m === "string") : [],
    defaultModel: typeof p.defaultModel === "string" ? p.defaultModel : undefined,
    needsKey: typeof p.needsKey === "boolean" ? p.needsKey : true,
    isPreset: typeof p.isPreset === "boolean" ? p.isPreset : false,
  };
}

export function registerProviderHandlers(): void {
  ipcMain.handle("providers:list", async () => configStore.listProviders());

  ipcMain.handle("providers:save", async (_event, provider: unknown) => {
    return configStore.saveProvider(parseProvider(provider));
  });

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
  ipcMain.handle("providers:test", async (_event, providerValue: unknown, keyOverride?: unknown) => {
    const provider = parseProvider(providerValue);
    const key =
      typeof keyOverride === "string" && keyOverride.trim()
        ? keyOverride.trim()
        : await secrets.getKey(provider.id);
    return testConnection(provider, key);
  });

  ipcMain.handle("providers:listModels", async (_event, providerValue: unknown, keyOverride?: unknown) => {
    const provider = parseProvider(providerValue);
    const key =
      typeof keyOverride === "string" && keyOverride.trim()
        ? keyOverride.trim()
        : await secrets.getKey(provider.id);
    return listModels(provider, key);
  });

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
    if (typeof p.dictationAccelerator === "string") next.dictationAccelerator = p.dictationAccelerator;
    return configStore.setSettings(next);
  });
}
