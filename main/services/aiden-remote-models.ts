import { AidenRemoteServiceError } from "./aiden-remote-errors.js";
import type { AppSettings, Provider } from "./types.js";
import { isModelHidden } from "../../renderer/shared/model-visibility.js";
import { normalizeProviderArtwork } from "../../renderer/shared/provider-artwork.js";

const MAX_REMOTE_MODEL_ID_LENGTH = 256;
const MAX_REMOTE_MODEL_CATALOG_BYTES = 900 * 1024;
const REMOTE_MODEL_CATALOG_RESERVE_BYTES = 4 * 1024;

export interface AidenRemoteModelProjection {
  id: string;
  label: string;
  thinkingLevels?: string[];
  hidden?: boolean;
}

export interface AidenRemoteProviderProjection {
  id: string;
  label: string;
  artwork?: { mimeType: "image/png"; dataBase64: string };
  models: AidenRemoteModelProjection[];
}

export interface AidenRemoteModelsProjection {
  providers: AidenRemoteProviderProjection[];
  defaults: Record<string, string>;
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
    let serializedBytes = Buffer.byteLength('{"providers":[],"defaults":{}}', "utf8") +
      REMOTE_MODEL_CATALOG_RESERVE_BYTES;
    const providers: AidenRemoteProviderProjection[] = [];
    for (const provider of configured) {
      if (
        (!provider.hasKey && provider.needsKey) ||
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
        const thinkingLevels = metadata?.thinkingLevels
          ?.slice(0, 8)
          .map((level) => bounded(level, 32));
        const model: AidenRemoteModelProjection = {
          id,
          label: bounded(metadata?.name ?? id, 256),
          ...(isModelHidden(settings.hiddenModelsByProvider, provider.id, id)
            ? { hidden: true }
            : {}),
          ...(thinkingLevels?.length ? { thinkingLevels } : {}),
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
    const projection = {
      providers,
      defaults: {
        ...(selectedProvider ? { providerId: selectedProvider.id } : {}),
        ...(selectedModel ? { modelId: selectedModel.id } : {}),
      },
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
  ): Promise<{ providerId: string; modelId: string; thinkingLevels: readonly string[] }> {
    const projection = await this.list();
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
    return {
      providerId: provider.id,
      modelId: model.id,
      thinkingLevels: model.thinkingLevels ?? [],
    };
  }
}
