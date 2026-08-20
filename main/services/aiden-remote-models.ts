import { AidenRemoteServiceError } from "./aiden-remote-errors.js";
import type { AppSettings, Provider } from "./types.js";

export interface AidenRemoteModelProjection {
  id: string;
  label: string;
  thinkingLevels?: string[];
}

export interface AidenRemoteProviderProjection {
  id: string;
  label: string;
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
    const providers = configured
      .filter((provider) => provider.hasKey || !provider.needsKey)
      .map((provider) => ({
        id: bounded(provider.id, 256),
        label: bounded(provider.label, 256),
        models: provider.models
          .filter((id) => provider.modelMetadata?.[id]?.type !== "embedding")
          .map((id) => {
            const metadata = provider.modelMetadata?.[id];
            return {
              id: bounded(id, 256),
              label: bounded(metadata?.name ?? id, 256),
              ...(metadata?.thinkingLevels?.length
                ? { thinkingLevels: [...metadata.thinkingLevels] }
                : {}),
            };
          }),
      }))
      .filter((provider) => provider.models.length > 0);
    const selectedProvider = providers.find((provider) => provider.id === settings.lastProviderId)
      ?? providers[0];
    const selectedModel = selectedProvider?.models.find((model) => model.id === settings.lastModel)
      ?? selectedProvider?.models[0];
    return {
      providers,
      defaults: {
        ...(selectedProvider ? { providerId: selectedProvider.id } : {}),
        ...(selectedModel ? { modelId: selectedModel.id } : {}),
      },
    };
  }

  async resolve(
    providerId?: string,
    modelId?: string,
  ): Promise<{ providerId: string; modelId: string; thinkingLevels: readonly string[] }> {
    const projection = await this.list();
    const provider = providerId
      ? projection.providers.find((candidate) => candidate.id === providerId)
      : projection.providers.find((candidate) => candidate.id === projection.defaults.providerId);
    const model = provider && (modelId
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
