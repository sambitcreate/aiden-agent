import type {
  BotAccessUpdate,
  BotCapabilityCatalog,
  BotModelOption,
  BotProviderOption,
} from "../../shared/bot-capabilities";
import { firstAvailableModel, firstAvailableVisionModel } from "./bot-access-draft";

/**
 * A Bot's model and, when that model reads text only, the model its photos and
 * screenshots go to. Ids are the catalog's opaque ids.
 */
export interface BotModelChoice {
  providerId?: string;
  modelId?: string;
  visionProviderId?: string;
  visionModelId?: string;
}

export function findBotModel(
  catalog: BotCapabilityCatalog,
  providerId: string | undefined,
  modelId: string | undefined,
): { provider: BotProviderOption; model: BotModelOption } | undefined {
  if (!providerId || !modelId) return undefined;
  const provider = catalog.providers.find(({ id }) => id === providerId);
  const model = provider?.models.find(({ id }) => id === modelId);
  return provider && model ? { provider, model } : undefined;
}

export function botModelUsable(found: ReturnType<typeof findBotModel>): boolean {
  return Boolean(found?.provider.available && found.model.available);
}

/** Today's default for a new Bot: the first model, plus a photo model when it reads text only. */
export function recommendedBotModelChoice(catalog: BotCapabilityCatalog): BotModelChoice {
  const model = firstAvailableModel(catalog);
  if (!model) return {};
  const readsImages = findBotModel(catalog, model.providerId, model.modelId)?.model.supportsImages === true;
  const vision = readsImages ? undefined : firstAvailableVisionModel(catalog, model.providerId);
  return {
    providerId: model.providerId,
    modelId: model.modelId,
    visionProviderId: vision?.providerId,
    visionModelId: vision?.modelId,
  };
}

/**
 * Picks the primary model. A model that reads images needs no photo model; a
 * text-only one keeps a still-usable photo model, else gets the first available.
 * An unusable choice returns `current` unchanged.
 */
export function chooseBotModel(
  catalog: BotCapabilityCatalog,
  current: BotModelChoice,
  providerId: string,
  modelId: string,
): BotModelChoice {
  const found = findBotModel(catalog, providerId, modelId);
  if (!found || !botModelUsable(found)) return current;
  if (found.model.supportsImages) {
    return { providerId, modelId, visionProviderId: undefined, visionModelId: undefined };
  }
  const kept = findBotModel(catalog, current.visionProviderId, current.visionModelId);
  const vision = kept && botModelUsable(kept) && kept.model.supportsImages
    ? { providerId: kept.provider.id, modelId: kept.model.id }
    : firstAvailableVisionModel(catalog, providerId);
  return { providerId, modelId, visionProviderId: vision?.providerId, visionModelId: vision?.modelId };
}

/** Picks the photo model; only a usable model that reads images is accepted. */
export function chooseBotVisionModel(
  catalog: BotCapabilityCatalog,
  current: BotModelChoice,
  providerId: string,
  modelId: string,
): BotModelChoice {
  const found = findBotModel(catalog, providerId, modelId);
  if (!found || !botModelUsable(found) || !found.model.supportsImages) return current;
  return { ...current, visionProviderId: providerId, visionModelId: modelId };
}

export function sameBotModelChoice(a: BotModelChoice, b: BotModelChoice): boolean {
  return a.providerId === b.providerId
    && a.modelId === b.modelId
    && a.visionProviderId === b.visionProviderId
    && a.visionModelId === b.visionModelId;
}

/** The Full-access update a new Bot is created with. No model means no model keys. */
export function botFullAccess(
  catalog: BotCapabilityCatalog,
  choice: BotModelChoice,
): { access: BotAccessUpdate; hasModel: boolean } {
  const hasModel = Boolean(choice.providerId && choice.modelId);
  const hasVision = hasModel && Boolean(choice.visionProviderId && choice.visionModelId);
  return {
    hasModel,
    access: {
      accessMode: "full",
      catalogRevision: catalog.revision,
      confirmedForeground: true,
      ...(hasModel ? { providerId: choice.providerId!, modelId: choice.modelId! } : {}),
      // The create dialog names Web Search; creating the Bot grants it.
      webSearchEnabled: true,
      ...(hasVision ? { visionModel: { providerId: choice.visionProviderId!, modelId: choice.visionModelId! } } : {}),
    },
  };
}
