import { AidenRemoteServiceError } from "./aiden-remote-errors.js";
import type { AppSettings, Provider } from "./types.js";
import { isModelHidden } from "../../renderer/shared/model-visibility.js";
import { normalizeProviderArtwork } from "../../renderer/shared/provider-artwork.js";
import {
  isGoogleThinkingLevel,
  normalizeGoogleThinkingLevel,
} from "../../renderer/shared/google-thinking.js";
import {
  isCodexThinkingLevel,
  normalizeCodexThinkingLevel,
} from "../../renderer/shared/codex-thinking.js";
import {
  isAnthropicThinkingLevel,
  normalizeAnthropicThinkingLevel,
} from "../../renderer/shared/anthropic-thinking.js";
import { normalizeProviderThinkingLevel } from "../../renderer/shared/provider-thinking.js";
import { isGenerationThinkingLevel } from "../../renderer/shared/generation-thinking.js";
import { canUseGeminiChatModel } from "../../renderer/shared/gemini-usage-scope.js";
import { acpHarnessUnavailableReason, isAcpHarnessProvider } from "../../renderer/shared/acp-harness.js";
import { customModelThinkingLevels } from "../../renderer/shared/custom-model-options.js";
import {
  resolveAgentSliderStop,
  type AgentSliderSettings,
  type AgentSliderStopUnavailableReason,
} from "../../renderer/shared/agent-slider.js";
import type { GenerationThinkingLevel } from "../../renderer/shared/generation-thinking.js";

const MAX_REMOTE_MODEL_ID_LENGTH = 256;
const MAX_REMOTE_MODEL_CATALOG_BYTES = 900 * 1024;
const REMOTE_MODEL_CATALOG_RESERVE_BYTES = 4 * 1024;

export interface AidenRemoteModelProjection {
  id: string;
  label: string;
  supportsImages: boolean;
  thinkingLevels?: string[];
  defaultThinkingLevel?: string;
  thinkingCanDisable?: boolean;
  hidden?: boolean;
}

export interface AidenRemoteProviderProjection {
  id: string;
  label: string;
  artwork?: { mimeType: "image/png"; dataBase64: string };
  models: AidenRemoteModelProjection[];
}

/**
 * One Agent Slider stop as a paired device sees it (revision 66). `providerId`
 * and `modelId` come together. `thinkingLevel` is the level a turn on this stop
 * runs with here: the stop's own level fitted to what its model offers, absent
 * when the stop has none or the model has no levels. `availability` is
 * "ready" or the first reason the stop cannot run from a paired device.
 */
export interface AidenRemoteAgentSliderStopProjection {
  id: string;
  label: string;
  providerId?: string;
  modelId?: string;
  thinkingLevel?: GenerationThinkingLevel;
  availability: "ready" | AgentSliderStopUnavailableReason;
}

export interface AidenRemoteAgentSliderProjection {
  /** Left to right. */
  stops: AidenRemoteAgentSliderStopProjection[];
  /** The stop Reset to home returns to. */
  homeStopId: string;
}

export interface AidenRemoteModelsProjection {
  providers: AidenRemoteProviderProjection[];
  defaults: Record<string, string>;
  /** Additive (revision 66): absent when the host has no readable Agent Slider. */
  agentSlider?: AidenRemoteAgentSliderProjection;
}

/** The level `requested` runs with on a model offering `levels`, as the model defaults are fitted. */
function fittedThinkingLevel(
  providerId: string,
  levels: readonly GenerationThinkingLevel[],
  requested: GenerationThinkingLevel | undefined,
): GenerationThinkingLevel | undefined {
  if (levels.length === 0) return undefined;
  if (providerId === "google") return normalizeGoogleThinkingLevel(levels.filter(isGoogleThinkingLevel), requested);
  if (providerId === "openai-codex") return normalizeCodexThinkingLevel(levels.filter(isCodexThinkingLevel), requested);
  if (providerId === "anthropic") return normalizeAnthropicThinkingLevel(levels.filter(isAnthropicThinkingLevel), requested);
  return normalizeProviderThinkingLevel(levels, requested);
}

/**
 * The host's slider for a paired device. A stop is checked like the desktop
 * checks it, and is also "model-missing" when its model is not in the catalog
 * this device was sent (an agent harness, an embedding model, or one past the
 * size budget), because a turn could not name it. Nothing is substituted.
 */
function projectAgentSlider(
  slider: AgentSliderSettings,
  configured: readonly Provider[],
  providers: readonly AidenRemoteProviderProjection[],
  settings: AppSettings,
): AidenRemoteAgentSliderProjection {
  const inventory = {
    providers: configured.filter((provider) => !isAcpHarnessProvider(provider.id)),
    hiddenModelsByProvider: settings.hiddenModelsByProvider,
  };
  return {
    homeStopId: slider.homeStopId,
    stops: slider.stops.map((stop) => {
      const resolution = resolveAgentSliderStop(stop, inventory);
      const projected = stop.providerId && stop.model
        ? providers.find((provider) => provider.id === stop.providerId)?.models.find((model) => model.id === stop.model)
        : undefined;
      const availability = !resolution.ok ? resolution.reason : projected ? "ready" as const : "model-missing" as const;
      const thinkingLevel = projected && stop.thinkingLevel
        ? fittedThinkingLevel(stop.providerId!, (projected.thinkingLevels ?? []).filter(isGenerationThinkingLevel), stop.thinkingLevel)
        : stop.thinkingLevel;
      return {
        id: stop.id,
        label: stop.label,
        ...(stop.providerId && stop.model ? { providerId: stop.providerId, modelId: stop.model } : {}),
        ...(thinkingLevel ? { thinkingLevel } : {}),
        availability,
      };
    }),
  };
}

/** An upper bound on the projected slider's size, so the provider budget leaves room for it. */
function agentSliderBytesBound(slider: AgentSliderSettings | undefined): number {
  if (!slider) return 0;
  const widest = {
    homeStopId: slider.homeStopId,
    stops: slider.stops.map((stop) => ({
      id: stop.id,
      label: stop.label,
      providerId: stop.providerId ?? "",
      modelId: stop.model ?? "",
      thinkingLevel: "medium",
      availability: "provider-missing",
    })),
  };
  return Buffer.byteLength(JSON.stringify(widest), "utf8") + 16;
}

function bounded(value: string, maximum: number): string {
  return Array.from(value).slice(0, maximum).join("");
}

export class AidenRemoteModelService {
  constructor(
    private readonly options: {
      listProviders(): Promise<Provider[]>;
      getSettings(): Promise<AppSettings>;
    },
  ) {}

  async list(): Promise<AidenRemoteModelsProjection> {
    const [configured, settings] = await Promise.all([
      this.options.listProviders(),
      this.options.getSettings(),
    ]);
    const slider = settings.agentSliderUnreadable === true ? undefined : settings.agentSlider;
    let serializedBytes = Buffer.byteLength('{"providers":[],"defaults":{}}', "utf8") +
      REMOTE_MODEL_CATALOG_RESERVE_BYTES +
      agentSliderBytesBound(slider);
    const providers: AidenRemoteProviderProjection[] = [];
    for (const provider of configured) {
      if (
        (!provider.hasKey && provider.needsKey) ||
        // Agent harnesses run only in chats open on the Mac, never from a phone.
        isAcpHarnessProvider(provider.id) ||
        provider.id.length === 0 ||
        provider.id.length > MAX_REMOTE_MODEL_ID_LENGTH
      ) {
        continue;
      }
      const projected: AidenRemoteProviderProjection = {
        id: provider.id,
        label: bounded(provider.label, 256),
        models: [],
      };
      const baseBytes = Buffer.byteLength(JSON.stringify(projected), "utf8") + 1;
      if (serializedBytes + baseBytes > MAX_REMOTE_MODEL_CATALOG_BYTES) break;
      serializedBytes += baseBytes;

        const candidateArtwork = normalizeProviderArtwork(provider.artwork);
      if (candidateArtwork) {
        const artworkBytes = Buffer.byteLength(JSON.stringify(candidateArtwork), "utf8") + 12;
        if (serializedBytes + artworkBytes <= MAX_REMOTE_MODEL_CATALOG_BYTES) {
          projected.artwork = candidateArtwork;
          serializedBytes += artworkBytes;
        }
      }

      for (const id of provider.models) {
        if (
          id.length === 0 ||
          id.length > MAX_REMOTE_MODEL_ID_LENGTH ||
          provider.modelMetadata?.[id]?.type === "embedding"
        ) {
          continue;
        }
        const metadata = provider.modelMetadata?.[id];
        const configuredLevels = provider.kind === "openai" && metadata?.overrides?.effortControl
          ? customModelThinkingLevels(metadata.overrides) ?? []
          : undefined;
        const thinkingLevels = (configuredLevels ?? metadata?.thinkingLevels)
          ?.slice(0, 8)
          .map((level) => bounded(level, 32));
        const safeThinkingLevels = thinkingLevels?.filter(isGenerationThinkingLevel) ?? [];
        const googleThinkingLevels = safeThinkingLevels.filter(isGoogleThinkingLevel);
        const codexThinkingLevels = safeThinkingLevels.filter(isCodexThinkingLevel);
        const anthropicThinkingLevels = safeThinkingLevels.filter(isAnthropicThinkingLevel);
        const savedThinkingLevel = provider.id === "google"
          ? settings.googleThinkingByModel?.[id]
          : provider.id === "openai-codex"
            ? settings.codexThinkingByModel?.[id]
            : provider.id === "anthropic"
              ? settings.anthropicThinkingByModel?.[id]
              : settings.providerThinkingByModel?.[provider.id]?.[id];
        const defaultThinkingLevel = safeThinkingLevels.length === 0
          ? undefined
          : provider.id === "google"
            ? normalizeGoogleThinkingLevel(googleThinkingLevels, savedThinkingLevel)
            : provider.id === "openai-codex"
              ? normalizeCodexThinkingLevel(codexThinkingLevels, savedThinkingLevel)
              : provider.id === "anthropic"
                ? normalizeAnthropicThinkingLevel(anthropicThinkingLevels, savedThinkingLevel)
                : normalizeProviderThinkingLevel(safeThinkingLevels, savedThinkingLevel);
        const model: AidenRemoteModelProjection = {
          id,
          label: bounded(metadata?.name ?? id, 256),
          supportsImages: (metadata?.overrides?.vision ?? metadata?.vision) === true && metadata?.overrides?.maxImages !== 0,
          ...(isModelHidden(settings.hiddenModelsByProvider, provider.id, id)
            ? { hidden: true }
            : {}),
          ...(safeThinkingLevels.length ? {
            thinkingLevels: safeThinkingLevels,
            defaultThinkingLevel,
            thinkingCanDisable: configuredLevels
              ? safeThinkingLevels.includes("off") : metadata?.thinkingCanDisable !== false,
          } : {}),
        };
        const modelBytes = Buffer.byteLength(JSON.stringify(model), "utf8") + 1;
        if (serializedBytes + modelBytes > MAX_REMOTE_MODEL_CATALOG_BYTES) break;
        projected.models.push(model);
        serializedBytes += modelBytes;
      }

      if (projected.models.length > 0) providers.push(projected);
      else serializedBytes -= baseBytes + (projected.artwork
        ? Buffer.byteLength(JSON.stringify(projected.artwork), "utf8") + 12
        : 0);
    }
    const selectedProvider =
      providers.find(
        (provider) =>
          provider.id === settings.lastProviderId && provider.models.some((model) => !model.hidden),
      ) ?? providers.find((provider) => provider.models.some((model) => !model.hidden));
    const selectedModel =
      selectedProvider?.models.find((model) => model.id === settings.lastModel && !model.hidden) ??
      selectedProvider?.models.find((model) => !model.hidden);
    const projection: AidenRemoteModelsProjection = {
      providers,
      defaults: {
        ...(selectedProvider ? { providerId: selectedProvider.id } : {}),
        ...(selectedModel ? { modelId: selectedModel.id } : {}),
      },
      ...(slider ? { agentSlider: projectAgentSlider(slider, configured, providers, settings) } : {}),
    };
    if (Buffer.byteLength(JSON.stringify(projection), "utf8") > MAX_REMOTE_MODEL_CATALOG_BYTES) {
      throw new AidenRemoteServiceError(
        "internal_error",
        "The configured model catalog is too large for a paired device.",
        503,
      );
    }
    return projection;
  }

  async resolve(
    providerId?: string,
    modelId?: string,
    options: { allowExistingPinnedGemini?: boolean } = {},
  ): Promise<{
    providerId: string;
    modelId: string;
    thinkingLevels: readonly string[];
    supportsImages: boolean;
  }> {
    const harnessReason = acpHarnessUnavailableReason(providerId);
    if (harnessReason) throw new AidenRemoteServiceError("invalid_request", harnessReason, 400);
    const [projection, settings] = await Promise.all([this.list(), this.options.getSettings()]);
    const provider = providerId
      ? projection.providers.find((candidate) => candidate.id === providerId)
      : projection.providers.find((candidate) => candidate.id === projection.defaults.providerId);
    const model =
      provider &&
      (modelId
        ? provider.models.find((candidate) => candidate.id === modelId)
        : provider.models.find((candidate) => candidate.id === projection.defaults.modelId));
    if (!provider || !model) {
      throw new AidenRemoteServiceError(
        "invalid_request",
        "Choose a configured Aiden provider and model before starting this turn.",
        400,
      );
    }
    if (!canUseGeminiChatModel(
      settings.geminiUsageScope,
      provider.id,
      options.allowExistingPinnedGemini === true,
    )) {
      throw new AidenRemoteServiceError(
        "invalid_request",
        "Google chat models are off while Gemini is configured for transcription only.",
        400,
      );
    }
    return {
      providerId: provider.id,
      modelId: model.id,
      thinkingLevels: model.thinkingLevels ?? [],
      supportsImages: model.supportsImages,
    };
  }
}
