import type { BotAccessState } from "../../lib/ipc";
import type { BotEditorAccessDraft } from "../../shared/bot-editor-save";
import {
  BOT_FILE_SCOPE_SELECTION_GUIDANCE,
  botFileScopeSelectionIsCoherent,
  type BotAccessUpdate,
  type BotCapabilityCatalog,
  type BotCapabilityOption,
} from "../../shared/bot-capabilities";

/** One model selection shared by Full and Custom access, as on iOS. */
export type BotAccessDraft = BotEditorAccessDraft;

export interface BotModelChoice {
  providerId: string;
  modelId: string;
}

export function botFullAccessAccepted(catalog: BotCapabilityCatalog): boolean {
  return catalog.notice.requiresAcknowledgement === false
    && catalog.notice.acceptedDecision === "continue_full";
}

export function firstAvailableModel(catalog: BotCapabilityCatalog) {
  const provider = catalog.providers.find(
    (candidate) => candidate.available && candidate.models.some((model) => model.available),
  );
  const model = provider?.models.find((candidate) => candidate.available);
  return provider && model ? { providerId: provider.id, modelId: model.id } : undefined;
}

export function firstAvailableVisionModel(catalog: BotCapabilityCatalog, preferredProviderId?: string) {
  const providers = [
    ...catalog.providers.filter((provider) => provider.id === preferredProviderId),
    ...catalog.providers.filter((provider) => provider.id !== preferredProviderId),
  ];
  const provider = providers.find(
    (candidate) => candidate.available
      && candidate.models.some((model) => model.available && model.supportsImages),
  );
  const model = provider?.models.find((candidate) => candidate.available && candidate.supportsImages);
  return provider && model ? { providerId: provider.id, modelId: model.id } : undefined;
}

export function accessDraftFromState(
  state: BotAccessState | null | undefined,
  catalog: BotCapabilityCatalog,
): BotAccessDraft {
  const fallback = firstAvailableModel(catalog);
  const selected = state?.modelSelection
    && catalog.providers.some((provider) =>
      provider.id === state.modelSelection!.providerId
      && provider.models.some((model) => model.id === state.modelSelection!.modelId))
      ? state.modelSelection
      : undefined;
  const selectedModel = catalog.providers.find(({ id }) => id === (selected?.providerId ?? fallback?.providerId))
    ?.models.find(({ id }) => id === (selected?.modelId ?? fallback?.modelId));
  const visionFallback = selectedModel?.supportsImages
    ? undefined
    : firstAvailableVisionModel(catalog, selected?.providerId ?? fallback?.providerId);
  const visionSelected = state?.visionModelSelection
    && catalog.providers.some((provider) =>
      provider.id === state.visionModelSelection!.providerId
      && provider.models.some((model) =>
        model.id === state.visionModelSelection!.modelId && model.supportsImages))
      ? state.visionModelSelection
      : visionFallback;
  return {
    usesFullAccess: state ? state.access.accessMode === "full" : false,
    providerId: selected?.providerId ?? fallback?.providerId,
    modelId: selected?.modelId ?? fallback?.modelId,
    visionProviderId: visionSelected?.providerId,
    visionModelId: visionSelected?.modelId,
    fileScopeIds: state?.access.custom ? [...state.access.custom.fileScopeIds] : [],
    shellEnabled: state?.access.custom?.shellEnabled ?? false,
    connectionIds: state?.access.custom ? [...state.access.custom.connectionIds] : [],
    skillIds: state?.access.custom ? [...state.access.custom.skillIds] : [],
    otherCapabilityIds: state?.access.custom ? [...state.access.custom.otherCapabilityIds] : [],
  };
}

export function buildBotAccessUpdate(
  draft: BotAccessDraft,
  catalog: BotCapabilityCatalog,
): BotAccessUpdate {
  const provider = catalog.providers.find((candidate) => candidate.id === draft.providerId);
  const model = provider?.models.find((candidate) => candidate.id === draft.modelId);
  if (!provider?.available || !model?.available) {
    throw new Error("Choose an available provider and model for this bot.");
  }
  const visionProvider = catalog.providers.find(
    (candidate) => candidate.id === draft.visionProviderId,
  );
  const visionModel = visionProvider?.models.find(
    (candidate) => candidate.id === draft.visionModelId,
  );
  if (!model.supportsImages && (
    !visionProvider?.available || !visionModel?.available || !visionModel.supportsImages
  )) {
    throw new Error("Choose an available vision model for photos and screenshots.");
  }
  const visionSelection = model.supportsImages
    ? null
    : { providerId: visionProvider!.id, modelId: visionModel!.id };
  if (draft.usesFullAccess) {
    if (!botFullAccessAccepted(catalog)) {
      throw new Error("Review the Full Access notice before saving.");
    }
    return {
      accessMode: "full",
      catalogRevision: catalog.revision,
      confirmedForeground: true,
      providerId: provider.id,
      modelId: model.id,
      visionModel: visionSelection,
    };
  }
  const assertAvailable = (options: BotCapabilityOption[], selected: string[], label: string) => {
    for (const id of selected) {
      if (!options.some((option) => option.id === id && option.available)) {
        throw new Error(`A selected ${label} is no longer available. Review the access choices.`);
      }
    }
  };
  assertAvailable(catalog.fileScopes, draft.fileScopeIds, "file access");
  assertAvailable(catalog.connections, draft.connectionIds, "connection");
  assertAvailable(
    catalog.skills.map((option) => ({ ...option, available: option.available || catalog.skillsEnabled === false })),
    draft.skillIds,
    "skill",
  );
  assertAvailable(catalog.otherCapabilities, draft.otherCapabilityIds, "capability");
  if (draft.shellEnabled && !catalog.shellAvailable) {
    throw new Error("Run commands is not currently available on this device.");
  }
  if (!botFileScopeSelectionIsCoherent(draft.fileScopeIds, catalog.fileScopes)) {
    throw new Error(BOT_FILE_SCOPE_SELECTION_GUIDANCE);
  }
  return {
    accessMode: "custom",
    catalogRevision: catalog.revision,
    custom: {
      providerId: provider.id,
      modelId: model.id,
      fileScopeIds: [...draft.fileScopeIds],
      shellEnabled: draft.shellEnabled,
      connectionIds: [...draft.connectionIds],
      skillIds: [...draft.skillIds],
      otherCapabilityIds: [...draft.otherCapabilityIds],
    },
    visionModel: visionSelection,
  };
}

function sameIdSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id) => right.includes(id));
}

export function botAccessDiffers(
  update: BotAccessUpdate,
  state: BotAccessState | null | undefined,
): boolean {
  if (!state) return true;
  if (update.accessMode !== state.access.accessMode) return true;
  if (update.accessMode === "full") {
    return state.modelSelection?.providerId !== update.providerId
      || state.modelSelection?.modelId !== update.modelId
      || state.visionModelSelection?.providerId !== update.visionModel?.providerId
      || state.visionModelSelection?.modelId !== update.visionModel?.modelId;
  }
  if (state.access.accessMode === "full") return true;
  const current = state.access.custom;
  const next = update.custom;
  return current.providerId !== next.providerId
    || current.modelId !== next.modelId
    || current.shellEnabled !== next.shellEnabled
    || !sameIdSet(current.fileScopeIds, next.fileScopeIds)
    || !sameIdSet(current.connectionIds, next.connectionIds)
    || !sameIdSet(current.skillIds, next.skillIds)
    || !sameIdSet(current.otherCapabilityIds, next.otherCapabilityIds)
    || state.visionModelSelection?.providerId !== update.visionModel?.providerId
    || state.visionModelSelection?.modelId !== update.visionModel?.modelId;
}
