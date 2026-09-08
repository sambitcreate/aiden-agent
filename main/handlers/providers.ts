import { isCompactionEngine } from "../../renderer/shared/compaction.js";
// Provider configuration + API key IPC handlers. Thin — logic lives in services.

import { ipcMain } from "../platform.js";
import { configStore } from "../services/config-store.js";
import { skillRegistry } from "../services/skill-registry-main.js";
import { canUseStoredProviderKey } from "../services/provider-key-policy.js";
import { secrets } from "../services/secrets.js";
import {
  assertOnboardingTailnetBaseUrl,
  listModels,
  normalizeProviderBaseUrl,
  testConnection,
} from "../services/models.js";
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
import {
  canonicalGoogleProvider,
  GOOGLE_PROVIDER_ID,
  parseGoogleThinkingSelection,
} from "../services/google-provider.js";
import { parseAnthropicThinkingSelection } from "../services/anthropic-provider.js";
import {
  assertMutableProviderId,
  forwardCodexProviderStatusChanges,
} from "../services/provider-list-core.js";
import { AppearancePreviewState } from "../services/appearance-preview-core.js";
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
import { invalidateBotRuntimeInventoryAuthority } from "../services/bot-runtime-inventory-lease.js";
import { modelsDevCacheRuntime, modelsDevCacheStatus } from "../services/models-dev-cache.js";
import { listProvidersWithLegacyPiCredentialMigration } from "../services/legacy-pi-credential-migration.js";
import type {
  ProviderDeployment,
  ProviderKind,
  ProviderModelMetadata,
  ProviderModelType,
  StoredProvider,
} from "../services/types.js";
import { MAX_CONFIG_ID_LENGTH, MAX_PROVIDER_BASE_URL_LENGTH } from "../services/types.js";
import {
  normalizeAppearanceConfig,
  parseAppearanceConfig,
} from "../../renderer/shared/appearance.js";
import { normalizeProviderArtwork } from "../../renderer/shared/provider-artwork.js";
import { normalizeProviderArtworkInput } from "../services/provider-artwork.js";
import { isGenerationThinkingLevel } from "../../renderer/shared/generation-thinking.js";
import { isGeminiUsageScope } from "../../renderer/shared/gemini-usage-scope.js";
import { isGeminiTranscriptionModel } from "../../renderer/shared/voice-models.js";

const appearancePreview = new AppearancePreviewState();

function asString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Expected non-empty string for "${name}".`);
  }
  return value;
}

function asProviderId(value: unknown): string {
  const id = asString(value, "id");
  if (id.length > MAX_CONFIG_ID_LENGTH) {
    throw new Error(`Expected "id" to be at most ${MAX_CONFIG_ID_LENGTH} characters.`);
  }
  return id;
}

function optionalPositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function optionalModelType(value: unknown): ProviderModelType | undefined {
  return value === "llm" ||
    value === "embedding" ||
    value === "reranker" ||
    value === "image" ||
    value === "audio" ||
    value === "video"
    ? value
    : undefined;
}

function parseModelMetadata(value: unknown): Record<string, ProviderModelMetadata> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries: Array<[string, ProviderModelMetadata]> = [];
  for (const [modelId, raw] of Object.entries(value)) {
    if (!modelId || !raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const metadata = raw as Record<string, unknown>;
    const source =
      metadata.source === "lmstudio" ||
      metadata.source === "ollama" ||
      metadata.source === "provider"
        ? metadata.source
        : "provider";
    entries.push([
      modelId,
      {
        source,
        name: typeof metadata.name === "string" && metadata.name ? metadata.name : undefined,
        type: optionalModelType(metadata.type),
        vision: typeof metadata.vision === "boolean" ? metadata.vision : undefined,
        toolCall: typeof metadata.toolCall === "boolean" ? metadata.toolCall : undefined,
        reasoning: typeof metadata.reasoning === "boolean" ? metadata.reasoning : undefined,
        contextLength: optionalPositiveNumber(metadata.contextLength),
        parameterCount:
          typeof metadata.parameterCount === "string" && metadata.parameterCount
            ? metadata.parameterCount
            : undefined,
        format:
          typeof metadata.format === "string" && metadata.format ? metadata.format : undefined,
      },
    ]);
  }
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function parseProvider(value: unknown): StoredProvider {
  if (typeof value !== "object" || value === null) {
    throw new Error("Invalid provider payload.");
  }
  const p = value as Record<string, unknown>;
  const kind = p.kind === "anthropic" ? "anthropic" : ("openai" as ProviderKind);
  const modelMetadata = parseModelMetadata(p.modelMetadata);
  const models = Array.isArray(p.models)
    ? p.models.filter(
        (model): model is string =>
          typeof model === "string" &&
          (modelMetadata?.[model]?.type === undefined || modelMetadata[model]?.type === "llm"),
      )
    : [];
  const defaultModel =
    typeof p.defaultModel === "string" && models.includes(p.defaultModel)
      ? p.defaultModel
      : undefined;
  const deployment: ProviderDeployment | undefined =
    p.deployment === "local" || p.deployment === "hosted" ? p.deployment : undefined;
  const baseUrl = normalizeProviderBaseUrl(asString(p.baseUrl, "baseUrl"));
  if (baseUrl.length > MAX_PROVIDER_BASE_URL_LENGTH) {
    throw new Error(`Expected "baseUrl" to be at most ${MAX_PROVIDER_BASE_URL_LENGTH} characters.`);
  }
  const provider: StoredProvider = {
    id: asProviderId(p.id),
    kind,
    label: asString(p.label, "label"),
    artwork: normalizeProviderArtwork(p.artwork),
    baseUrl,
    models,
    modelMetadata,
    defaultModel,
    needsKey: typeof p.needsKey === "boolean" ? p.needsKey : true,
    deployment,
    isPreset: typeof p.isPreset === "boolean" ? p.isPreset : false,
    // Built-in status is derived exclusively from Pi's registry, never from
    // a renderer payload that could redirect native credentials.
    isBuiltin: false,
  };
  if (provider.id === "custom:onboarding-tailscale") {
    assertOnboardingTailnetBaseUrl(provider.baseUrl);
  }
  return provider.id === GOOGLE_PROVIDER_ID ? canonicalGoogleProvider(provider) : provider;
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
  return listConfiguredProviders();
}

async function refreshProviderCatalogs(providerIds?: readonly string[], force = true) {
  const errors = await providerRegistry.refreshBuiltinCatalogs(providerIds, force);
  return {
    providers: await listProviders(),
    errors: projectPiCatalogRefreshErrors(errors),
  };
}

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
    providerAuthOwner(event);
    return providerAuthFlow.logout(parseProviderAuthProviderId(providerId));
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

  ipcMain.handle("providers:refresh", async (event, providerValue?: unknown) => {
    // A catalog refresh can renew OAuth credentials inside Pi, so treat it as
    // a credential-affecting operation rather than accepting stale documents.
    providerAuthOwner(event);
    const providerId = providerValue === undefined ? undefined : asProviderId(providerValue);
    if (providerId !== undefined && !providerRegistry.isBuiltinProvider(providerId)) {
      throw new Error("Only provider catalogs built into Aiden can be refreshed.");
    }
    return refreshProviderCatalogs(providerId === undefined ? undefined : [providerId]);
  });

  ipcMain.handle("providers:refreshIfStale", async (event) => {
    providerAuthOwner(event);
    return refreshProviderCatalogs(undefined, false);
  });

  ipcMain.handle("providers:catalogStatus", () => modelsDevCacheStatus());

  ipcMain.handle("providers:updateCatalogs", async (event) => {
    providerAuthOwner(event);
    const inventory = await refreshProviderCatalogs();
    let modelsDev;
    try {
      const refreshed = await modelsDevCacheRuntime.refresh();
      modelsDev = { ok: true as const, status: refreshed.status };
    } catch (error) {
      modelsDev = {
        ok: false as const,
        status: await modelsDevCacheStatus(),
        message:
          error instanceof Error
            ? error.message.slice(0, 240)
            : "The models.dev catalog could not be updated.",
      };
    }
    return {
      providers: inventory.providers,
      inventoryErrors: inventory.errors,
      modelsDev,
    };
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
      const metadata = providerRegistry.builtinProvider(providerId)?.modelMetadata?.[modelId];
      if (!metadata?.thinkingLevels?.includes(levelValue)) {
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
    if (typeof p.dictationHoldToTalk === "boolean")
      next.dictationHoldToTalk = p.dictationHoldToTalk;
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
    if (typeof p.memoryEnabled === "boolean") next.memoryEnabled = p.memoryEnabled;
    if (p.skillsEnabled !== undefined) {
      if (typeof p.skillsEnabled !== "boolean") throw new Error("Invalid skills enabled setting.");
      next.skillsEnabled = p.skillsEnabled;
    }
    if (typeof p.dictationAccelerator === "string")
      next.dictationAccelerator = p.dictationAccelerator;
    if (
      p.chatTitleProviderId === "automatic" ||
      p.chatTitleProviderId === "apple-foundation-models" ||
      p.chatTitleProviderId === "chat-model"
    ) {
      next.chatTitleProviderId = p.chatTitleProviderId;
    }
    if (p.appearance !== undefined) next.appearance = parseAppearanceConfig(p.appearance);
    const saved = await configStore.setSettings(next);
    if (next.skillsEnabled !== undefined) {
      skillRegistry.invalidate();
      invalidateBotRuntimeInventoryAuthority("skill_configuration");
      if (!next.skillsEnabled) {
        const { llmClient } = await import("../services/llm-client.js");
        llmClient.cancelForSkillsDisabled();
        const { contextLifecycleService } =
          await import("../services/context-lifecycle-service-main.js");
        contextLifecycleService.cancelForSkillsDisabled();
      }
      const { telegramService } = await import("../services/telegram/telegram-service.js");
      void telegramService.refreshCommands();
    }
    if (next.appearance) {
      const appearance = appearancePreview.persisted(normalizeAppearanceConfig(saved.appearance));
      ipcMain.broadcast("settings:appearance-changed", appearance);
    }
    return saved;
  });
}
