import { customModelThinkingLevels } from "../../renderer/shared/custom-model-options.js";
import { isCompactionEngine, parseCompactionModelOverrides } from "../../renderer/shared/compaction.js";
import { parseModelPadPreferencesPatch } from "../../renderer/shared/model-pad-preferences.js";
// Provider configuration + API key IPC handlers. Thin — logic lives in services.

import { ipcMain } from "../platform.js";
import { activeLinuxDictationHoldShortcut, bindLinuxDictationHoldShortcut, disableLinuxDictationHoldShortcut } from "../services/shortcut.js";
import { DictationHoldSettingsTransaction } from "../services/dictation-hold-settings.js";
import { configStore } from "../services/config-store.js";
import { canUseStoredProviderKey } from "../services/provider-key-policy.js";
import { secrets } from "../services/secrets.js";
import { listModels, testConnection } from "../services/models.js";
import {
  parseProviderAuthProviderId,
  parseProviderAuthResponseRequest,
  parseProviderAuthStartRequest,
} from "../services/provider-auth-flow-core.js";
import { providerAuthFlow } from "../services/provider-auth-flow.js";
import { providerAuthOwner } from "../services/provider-auth-owner.js";
import { providerRegistry } from "../services/provider-registry.js";
import { projectPiCatalogRefreshErrors } from "../services/pi-catalog-refresh.js";
import { isCustomProviderId } from "../services/custom-provider-id.js";
import { GOOGLE_PROVIDER_ID, parseGoogleThinkingSelection } from "../services/google-provider.js";
import { parseAnthropicThinkingSelection } from "../services/anthropic-provider.js";
import {
  assertMutableProviderId,
  forwardCodexProviderStatusChanges,
} from "../services/provider-list-core.js";
import { appearancePreview, applySettingsEffects } from "../services/settings-application-effects.js";
import {
  removeProviderWithCredentialCleanup,
  saveProviderWithCredentialRotation,
  setProviderKeyWithCredentialRotation,
} from "../services/provider-credential-rotation.js";
import {
  normalizeProviderCredentialInput,
  providerConnectionSnapshot,
} from "../services/provider-credential-rotation-core.js";
import { listConfiguredProviders } from "../services/provider-list-main.js";
import { mcpProviderKeySharingIds, setMcpProviderKeySharing } from "../services/mcp-provider-auth.js";
import { registerProviderKeySharingHandler } from "./mcp-provider-auth.js";
import { invalidateBotRuntimeInventoryAuthority } from "../services/bot-runtime-inventory-lease.js";
import { modelsDevCacheRuntime, modelsDevCacheStatus } from "../services/models-dev-cache.js";
import { providerModelInfo } from "../services/provider-model-info.js";
import { listProvidersWithLegacyPiCredentialMigration } from "../services/legacy-pi-credential-migration.js";
import { registerProviderCatalogHandlers } from "./provider-catalog-handlers.js";
import { asProviderId, asString, createProviderPayloadParser } from "./provider-payload.js";
import type { StoredProvider } from "../services/types.js";
import { MAX_CONFIG_ID_LENGTH } from "../services/types.js";
import {
  normalizeAppearanceConfig,
  parseAppearanceConfig,
} from "../../renderer/shared/appearance.js";
import {
  normalizeProviderArtworkInput,
  persistableProviderArtwork,
} from "../services/provider-artwork.js";
import { isGenerationThinkingLevel } from "../../renderer/shared/generation-thinking.js";
import { isGeminiUsageScope } from "../../renderer/shared/gemini-usage-scope.js";
import { isGeminiTranscriptionModel } from "../../renderer/shared/voice-models.js";
import { parseDictationDictionary } from "../../renderer/shared/dictation-dictionary.js";
import { parseDictationPreferencePatch } from "../../renderer/shared/dictation-preferences.js";
import { parseVoicePreferencePatch, parseVoiceProviderPatch } from "../../renderer/shared/voice-preferences.js";
import { isUsageLimitWaitHours } from "../../renderer/shared/usage-limits.js";


const parseProvider = createProviderPayloadParser({ persistableArtwork: persistableProviderArtwork });

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
  return secrets.getProviderKey(provider.id, JSON.stringify(providerConnectionSnapshot(provider)));
}

function replacementKey(value: unknown): string | null {
  return normalizeProviderCredentialInput(value);
}

/**
 * Save a provider and rotate its secret as one main-process operation. An
 * existing key is removed before a changed endpoint becomes usable, so a
 * renderer payload cannot redirect it to another host.
 */
async function saveProvider(
  provider: StoredProvider,
  keyOverride: unknown,
  isCurrent: () => boolean,
) {
  if (providerRegistry.isBuiltinProvider(provider.id)) {
    throw new Error(
      `${provider.label} is built into Aiden and has no editable endpoint configuration.`,
    );
  }
  if (!isCustomProviderId(provider.id)) {
    throw new Error(
      "Custom provider IDs are reserved by Aiden. Create a new custom connection instead.",
    );
  }
  assertMutableProviderId(provider.id);
  const replacement = provider.needsKey ? replacementKey(keyOverride) : null;
  return saveProviderWithCredentialRotation(provider, replacement, isCurrent);
}

async function listProviders() {
  const [providers, sharing] = await Promise.all([
    listConfiguredProviders(),
    mcpProviderKeySharingIds().catch(() => new Set<string>()),
  ]);
  return providers.map((provider) =>
    provider.isBuiltin && provider.credentialType === "api_key" && sharing.has(provider.id)
      ? { ...provider, connectorKeySharing: true }
      : provider,
  );
}

async function refreshProviderCatalogs(providerIds?: readonly string[], force = true) {
  const errors = await providerRegistry.refreshBuiltinCatalogs(providerIds, force);
  return {
    providers: await listProviders(),
    errors: projectPiCatalogRefreshErrors(errors),
  };
}

const linuxHoldSettings = new DictationHoldSettingsTransaction({
  active: activeLinuxDictationHoldShortcut,
  bind: bindLinuxDictationHoldShortcut,
  disable: disableLinuxDictationHoldShortcut,
});

export function registerProviderHandlers(): void {
  forwardCodexProviderStatusChanges(
    providerRegistry.codex,
    (channel, event) => ipcMain.broadcast(channel, event),
    () => invalidateBotRuntimeInventoryAuthority("provider_credential"),
  );

  ipcMain.handle("providers:list", listProviders);

  ipcMain.handle("providers:normalizeArtwork", (_event, input: unknown) =>
    normalizeProviderArtworkInput(input),
  );

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
    const owner = providerAuthOwner(event);
    const id = parseProviderAuthProviderId(providerId);
    const result = await providerAuthFlow.logout(id);
    // The opt-in belongs to the removed key; a later key must be opted in again.
    await setMcpProviderKeySharing(id, false, () => !owner.isDestroyed()).catch(() => undefined);
    return result;
  });

  ipcMain.handle(
    "providers:validateOnboardingApiKey",
    async (event, providerIdValue: unknown, keyValue: unknown) => {
      const owner = providerAuthOwner(event);
      if (providerIdValue !== "openai" && providerIdValue !== "anthropic") {
        throw new Error("This provider does not support onboarding API-key validation.");
      }
      const key = normalizeProviderCredentialInput(keyValue);
      if (!key) throw new Error("Enter an API key before validating the connection.");
      return providerRegistry.validateAndStoreOnboardingApiKey(
        providerIdValue,
        key,
        () => !owner.isDestroyed(),
      );
    },
  );

  ipcMain.handle("providers:save", async (event, providerValue: unknown, keyOverride?: unknown) => {
    const owner = providerAuthOwner(event);
    return saveProvider(parseProvider(providerValue), keyOverride, () => !owner.isDestroyed());
  });

  ipcMain.handle("providers:remove", async (event, id: unknown) => {
    const owner = providerAuthOwner(event);
    const providerId = asProviderId(id);
    if (providerRegistry.isBuiltinProvider(providerId)) {
      throw new Error("Providers built into Aiden cannot be removed.");
    }
    if (!isCustomProviderId(providerId)) {
      throw new Error("Only Aiden custom connections can be removed.");
    }
    assertMutableProviderId(providerId);
    await removeProviderWithCredentialCleanup(providerId, () => !owner.isDestroyed());
  });

  ipcMain.handle("providers:setKey", async (event, id: unknown, key: unknown) => {
    const providerId = asProviderId(id);
    if (providerRegistry.isBuiltinProvider(providerId)) {
      // Retired UI clients must use the Pi-owned auth flow. Also bind this
      // rejected state-changing request to a live document for parity with
      // logout/auth, rather than accepting queued stale renderer work.
      providerAuthOwner(event);
      throw new Error("Providers built into Aiden must use their managed sign-in flow.");
    }
    if (!isCustomProviderId(providerId)) {
      throw new Error("Only Aiden custom connections can store an endpoint key.");
    }
    assertMutableProviderId(providerId);
    const owner = providerAuthOwner(event);
    const value = normalizeProviderCredentialInput(key);
    return setProviderKeyWithCredentialRotation(providerId, value, () => !owner.isDestroyed());
  });

  // Optional keyOverride lets the user test a freshly typed key before saving it.
  ipcMain.handle(
    "providers:test",
    async (_event, providerValue: unknown, keyOverride?: unknown) => {
      const provider = parseProvider(providerValue);
      if (providerRegistry.isBuiltinProvider(provider.id)) {
        throw new Error("Providers built into Aiden use managed connection handling.");
      }
      if (!isCustomProviderId(provider.id)) {
        throw new Error("Only Aiden custom connections support endpoint tests.");
      }
      assertMutableProviderId(provider.id);
      const key = await connectionKey(provider, keyOverride);
      return testConnection(provider, key);
    },
  );

  ipcMain.handle(
    "providers:listModels",
    async (_event, providerValue: unknown, keyOverride?: unknown) => {
      const provider = parseProvider(providerValue);
      if (providerRegistry.isBuiltinProvider(provider.id)) {
        throw new Error("Providers built into Aiden use managed model discovery.");
      }
      if (!isCustomProviderId(provider.id)) {
        throw new Error("Only Aiden custom connections support endpoint model discovery.");
      }
      assertMutableProviderId(provider.id);
      const key = await connectionKey(provider, keyOverride);
      return listModels(provider, key);
    },
  );

  registerProviderKeySharingHandler<Electron.IpcMainInvokeEvent>({
    handle: (channel, handler) => ipcMain.handle(channel, handler),
    owner: providerAuthOwner,
    set: setMcpProviderKeySharing,
  });

  registerProviderCatalogHandlers(ipcMain, {
    providerAuthOwner,
    isBuiltinProvider: (providerId) => providerRegistry.isBuiltinProvider(providerId),
    refreshProviderCatalogs,
    modelsDev: modelsDevCacheRuntime,
    modelsDevStatus: modelsDevCacheStatus,
    modelInfo: providerModelInfo,
  });

  ipcMain.handle("settings:get", async () => configStore.getSettings());
  ipcMain.handle("settings:getAppearance", async () => {
    const settings = await configStore.getSettings();
    return appearancePreview.effective(normalizeAppearanceConfig(settings.appearance));
  });
  ipcMain.handle("settings:getAppearanceState", async () => {
    const settings = await configStore.getSettings();
    return appearancePreview.snapshot(normalizeAppearanceConfig(settings.appearance));
  });
  ipcMain.handle("settings:previewAppearance", async (_event, value: unknown) => {
    const appearance = appearancePreview.preview(parseAppearanceConfig(value));
    ipcMain.broadcast("settings:appearance-changed", appearance);
    return appearance;
  });
  ipcMain.handle(
    "settings:setGoogleThinking",
    async (_event, modelIdValue: unknown, levelValue: unknown) => {
      const selection = parseGoogleThinkingSelection(modelIdValue, levelValue);
      return configStore.setGoogleThinkingLevel(selection.modelId, selection.level);
    },
  );
  ipcMain.handle(
    "settings:setCodexThinking",
    async (_event, modelIdValue: unknown, levelValue: unknown) => {
      const selection = providerRegistry.codex.parseThinkingSelection(modelIdValue, levelValue);
      return configStore.setCodexThinkingLevel(selection.modelId, selection.level);
    },
  );
  ipcMain.handle(
    "settings:setCompactionModelBudget",
    async (_event, modelKeyValue: unknown, budgetValue: unknown) => {
      if (typeof modelKeyValue !== "string") throw new Error("Choose an exact provider/model for the compaction budget.");
      if (budgetValue === null || budgetValue === undefined) return configStore.setCompactionModelBudget(modelKeyValue, undefined);
      const parsed = parseCompactionModelOverrides({ [modelKeyValue]: budgetValue });
      return configStore.setCompactionModelBudget(modelKeyValue, parsed[modelKeyValue]);
    },
  );
  ipcMain.handle(
    "settings:setAnthropicThinking",
    async (_event, modelIdValue: unknown, levelValue: unknown) => {
      const selection = parseAnthropicThinkingSelection(modelIdValue, levelValue);
      return configStore.setAnthropicThinkingLevel(selection.modelId, selection.level);
    },
  );
  ipcMain.handle(
    "settings:setProviderThinking",
    async (_event, providerIdValue: unknown, modelIdValue: unknown, levelValue: unknown) => {
      const providerId = asProviderId(providerIdValue);
      const modelId = asString(modelIdValue, "modelId");
      if (modelId.length > MAX_CONFIG_ID_LENGTH || !isGenerationThinkingLevel(levelValue)) {
        throw new Error("Invalid provider thinking selection.");
      }
      const builtin = providerRegistry.builtinProvider(providerId);
      const custom = builtin ? undefined : await configStore.getProvider(providerId);
      const levels = builtin?.modelMetadata?.[modelId]?.thinkingLevels ??
        (custom?.kind === "openai" && custom.models.includes(modelId)
          ? customModelThinkingLevels(custom.modelMetadata?.[modelId]?.overrides)
          : undefined);
      if (!levels?.includes(levelValue)) {
        throw new Error("This thinking level is not supported by the selected model.");
      }
      return configStore.setProviderThinkingLevel(providerId, modelId, levelValue);
    },
  );
  ipcMain.handle(
    "settings:setModelVisibility",
    async (_event, providerIdValue: unknown, modelIdValue: unknown, hiddenValue: unknown) => {
      const providerId = asProviderId(providerIdValue);
      const modelId = asString(modelIdValue, "modelId");
      if (modelId.length > MAX_CONFIG_ID_LENGTH || typeof hiddenValue !== "boolean") {
        throw new Error("Invalid model visibility request.");
      }
      return configStore.setModelVisibility(providerId, modelId, hiddenValue);
    },
  );
  ipcMain.handle("settings:showAllProviderModels", async (_event, providerIdValue: unknown) => {
    return configStore.showAllProviderModels(asProviderId(providerIdValue));
  });
  ipcMain.handle("settings:hideAllProviderModels", async (_event, providerIdValue: unknown) => {
    return configStore.hideAllProviderModels(asProviderId(providerIdValue));
  });
  ipcMain.handle(
    "settings:setGeminiVoiceSetup",
    async (_event, scopeValue: unknown, modelValue: unknown) => {
      if (!isGeminiUsageScope(scopeValue) || typeof modelValue !== "string") {
        throw new Error("Invalid Gemini voice setup.");
      }
      if (!isGeminiTranscriptionModel(modelValue)) {
        throw new Error("Choose a supported Gemini transcription model.");
      }
      await listProvidersWithLegacyPiCredentialMigration();
      if (!(await providerRegistry.getBuiltinRequestAuth(GOOGLE_PROVIDER_ID))) {
        throw new Error("Add a Google API key in Providers before enabling Gemini voice.");
      }
      return configStore.setGeminiVoiceSetup(scopeValue, modelValue);
    },
  );
  ipcMain.handle("settings:setGeminiUsageScope", async (_event, scopeValue: unknown) => {
    if (!isGeminiUsageScope(scopeValue)) {
      throw new Error("Invalid Gemini usage scope.");
    }
    await listProvidersWithLegacyPiCredentialMigration();
    if (!(await providerRegistry.getBuiltinRequestAuth(GOOGLE_PROVIDER_ID))) {
      throw new Error("Add a Google API key in Providers before updating Gemini access.");
    }
    return configStore.setGeminiUsageScope(scopeValue);
  });
  ipcMain.handle("settings:set", async (_event, patch: unknown) => {
    if (typeof patch !== "object" || patch === null) throw new Error("Invalid settings patch.");
    const p = patch as Record<string, unknown>;
    const next: Partial<import("../services/types.js").AppSettings> = {};
    if (p.remoteAppControlsEnabled !== undefined) {
      if (typeof p.remoteAppControlsEnabled !== "boolean") throw new Error("Invalid paired controls setting.");
      next.remoteAppControlsEnabled = p.remoteAppControlsEnabled;
    }
    if (p.appControlPolicy !== undefined) {
      if (!["disabled", "ask", "safe"].includes(p.appControlPolicy as string)) throw new Error("Invalid app controls policy.");
      next.appControlPolicy = p.appControlPolicy as import("../../renderer/shared/app-controls.js").AppControlPolicy;
    }
    if (typeof p.lastProviderId === "string") next.lastProviderId = p.lastProviderId;
    if (typeof p.lastModel === "string") next.lastModel = p.lastModel;
    if (typeof p.exaEnabled === "boolean") next.exaEnabled = p.exaEnabled;
    Object.assign(next, parseVoiceProviderPatch(p));
    if (typeof p.voiceModel === "string") next.voiceModel = p.voiceModel;
    if (typeof p.localVoiceModel === "string") next.localVoiceModel = p.localVoiceModel;
    if (typeof p.shortcutEnabled === "boolean") next.shortcutEnabled = p.shortcutEnabled;
    if (typeof p.shortcutAccelerator === "string") next.shortcutAccelerator = p.shortcutAccelerator;
    if (typeof p.dictationEnabled === "boolean") next.dictationEnabled = p.dictationEnabled;
    Object.assign(next, parseDictationPreferencePatch(p));
    Object.assign(next, parseVoicePreferencePatch(p));
    if (p.dictationDictionary !== undefined)
      next.dictationDictionary = parseDictationDictionary(p.dictationDictionary);
    if (typeof p.dictationSilenceStop === "boolean")
      next.dictationSilenceStop = p.dictationSilenceStop;
    if (typeof p.dictationCleanup === "boolean") next.dictationCleanup = p.dictationCleanup;
    if (typeof p.dictationSounds === "boolean") next.dictationSounds = p.dictationSounds;
    if (typeof p.showLocalModelReasoning === "boolean")
      next.showLocalModelReasoning = p.showLocalModelReasoning;
    if (p.compactionEngine !== undefined) {
      if (!isCompactionEngine(p.compactionEngine)) throw new Error("Invalid compaction engine.");
      next.compactionEngine = p.compactionEngine;
    }
    if (p.compactionModelOverrides !== undefined) next.compactionModelOverrides = parseCompactionModelOverrides(p.compactionModelOverrides);
    if (p.cacheWarmingEnabled !== undefined) {
      if (typeof p.cacheWarmingEnabled !== "boolean") throw new Error("Invalid cache warming setting.");
      next.cacheWarmingEnabled = p.cacheWarmingEnabled;
    }
    if (p.usageLimitWaitHours !== undefined) {
      if (!isUsageLimitWaitHours(p.usageLimitWaitHours)) throw new Error("Invalid usage limit wait setting.");
      next.usageLimitWaitHours = p.usageLimitWaitHours;
    }
    if (typeof p.memoryEnabled === "boolean") next.memoryEnabled = p.memoryEnabled;
    if (p.computerUseAlwaysAllow !== undefined) {
      if (typeof p.computerUseAlwaysAllow !== "boolean") throw new Error("Invalid Computer Use setting.");
      next.computerUseAlwaysAllow = p.computerUseAlwaysAllow;
    }
    for (const key of ["aidenLiveEnabled", "aidenLiveButtonVisible"] as const) {
      if (p[key] === undefined) continue;
      if (typeof p[key] !== "boolean") throw new Error("Invalid Aiden Live setting.");
      next[key] = p[key];
    }
    if (p.skillsEnabled !== undefined) {
      if (typeof p.skillsEnabled !== "boolean") throw new Error("Invalid skills enabled setting.");
      next.skillsEnabled = p.skillsEnabled;
    }
    if (typeof p.dictationAccelerator === "string")
      next.dictationAccelerator = p.dictationAccelerator;
    if (
      p.chatTitleProviderId === "automatic" ||
      (p.chatTitleProviderId === "apple-foundation-models" && process.platform === "darwin") ||
      p.chatTitleProviderId === "chat-model"
    ) {
      next.chatTitleProviderId = p.chatTitleProviderId;
    }
    if (p.appearance !== undefined) next.appearance = parseAppearanceConfig(p.appearance);
    Object.assign(next, parseModelPadPreferencesPatch(p));
    const saved = process.platform === "linux" && next.dictationHoldToTalk !== undefined
      ? await linuxHoldSettings.apply(next.dictationHoldToTalk, (isCurrent) => configStore.setSettings(next, isCurrent))
      : await configStore.setSettings(next);
    await applySettingsEffects(saved, next);
    return saved;
  });
}
