import type { BotAccessState } from "../../lib/ipc";
import type { BotEditorAccessDraft } from "../../shared/bot-editor-save";
import {
  botFileScopeSelectionGuidance,
  BOT_WEB_SEARCH_CAPABILITY_LABEL,
  botFileScopeSelectionIsCoherent,
  type BotAccessUpdate,
  type BotCapabilityCatalog,
  type BotCapabilityOption,
} from "../../shared/bot-capabilities";

/** One model selection shared by Full and Custom access, as on iOS. */
export type BotAccessDraft = BotEditorAccessDraft;

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
    // A Bot with no saved access yet starts with Web Search, as a new Bot does.
    webSearchEnabled: state ? state.webSearchEnabled === true : true,
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
      webSearchEnabled: draft.webSearchEnabled,
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
    throw new Error(botFileScopeSelectionGuidance());
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
      || (update.webSearchEnabled !== undefined
        && update.webSearchEnabled !== (state.webSearchEnabled === true))
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

// ---------------------------------------------------------------------------
// Advanced → Tools (plan §3.5): "Disable a tool" instead of the Everything /
// Only what I choose picker. Storage is unchanged: an Everything Bot is Full
// access, and a Bot with a tool turned off is Custom access with the rest on.

export type BotToolKey = "connectionIds" | "skillIds" | "otherCapabilityIds" | "shell" | "webSearch";

export interface BotTool {
  key: BotToolKey;
  /** The grant id; "shell" and "web" for the two switches. */
  id: string;
  label: string;
  /** "Connected apps", "Skills", "More". */
  group: string;
  description?: string;
}

const isWeb = (option: BotCapabilityOption) => option.label === BOT_WEB_SEARCH_CAPABILITY_LABEL;

function toolOptions(catalog: BotCapabilityCatalog, draft: BotAccessDraft): BotTool[] {
  const skillsAvailable = (option: BotCapabilityOption) => option.available || catalog.skillsEnabled === false;
  const others = catalog.otherCapabilities.filter((option) => option.available && !(draft.usesFullAccess && isWeb(option)));
  return [
    ...catalog.connections.filter((option) => option.available).map((option) => ({ key: "connectionIds" as const, id: option.id, label: option.label, group: "Connected apps", ...(option.description ? { description: option.description } : {}) })),
    ...catalog.skills.filter(skillsAvailable).map((option) => ({ key: "skillIds" as const, id: option.id, label: option.label, group: "Skills", ...(option.description ? { description: option.description } : {}) })),
    ...others.map((option) => ({ key: "otherCapabilityIds" as const, id: option.id, label: option.label, group: "More", ...(option.description ? { description: option.description } : {}) })),
    ...(catalog.shellAvailable ? [{ key: "shell" as const, id: "shell", label: "Run commands", group: "More", description: "Commands in Terminal on this Mac" }] : []),
    // In Full access, Web search is its own switch; in Custom it is one of the capabilities above.
    ...(draft.usesFullAccess ? [{ key: "webSearch" as const, id: "web", label: BOT_WEB_SEARCH_CAPABILITY_LABEL, group: "More", description: "Look things up with Aiden’s Web Search" }] : []),
  ];
}

function toolIsOn(draft: BotAccessDraft, tool: BotTool): boolean {
  if (tool.key === "webSearch") return draft.webSearchEnabled;
  if (draft.usesFullAccess) return true;
  if (tool.key === "shell") return draft.shellEnabled;
  return draft[tool.key].includes(tool.id);
}

/** What this Bot can use and what is off, from the same draft the save sends. */
export function botToolsOf(catalog: BotCapabilityCatalog, draft: BotAccessDraft): { on: BotTool[]; off: BotTool[] } {
  const on: BotTool[] = [];
  const off: BotTool[] = [];
  for (const tool of toolOptions(catalog, draft)) (toolIsOn(draft, tool) ? on : off).push(tool);
  return { on, off };
}

/**
 * Turn one tool off. An Everything Bot becomes Custom access with every
 * other tool still on and the widest file access it can name (the whole Mac
 * when offered), so turning a tool off only ever narrows what it can reach.
 */
export function disableBotTool(catalog: BotCapabilityCatalog, draft: BotAccessDraft, tool: Pick<BotTool, "key" | "id">): BotAccessDraft {
  if (tool.key === "webSearch") return draft.usesFullAccess ? { ...draft, webSearchEnabled: false } : draft;
  let next = draft;
  if (draft.usesFullAccess) {
    const whole = catalog.fileScopes.find((scope) => scope.kind === "full_mac" && scope.available);
    const home = catalog.fileScopes.find((scope) => scope.kind === "bot_home" && scope.available);
    next = {
      ...draft,
      usesFullAccess: false,
      fileScopeIds: whole ? [whole.id] : home ? [home.id, ...catalog.fileScopes.filter((scope) => scope.kind === "approved_location" && scope.available).map((scope) => scope.id)] : [],
      shellEnabled: catalog.shellAvailable,
      connectionIds: catalog.connections.filter((option) => option.available).map((option) => option.id),
      skillIds: catalog.skills.filter((option) => option.available || catalog.skillsEnabled === false).map((option) => option.id),
      // Web search stays as it was: on only if it was on.
      otherCapabilityIds: catalog.otherCapabilities.filter((option) => option.available && (draft.webSearchEnabled || !isWeb(option))).map((option) => option.id),
    };
  }
  if (tool.key === "shell") return { ...next, shellEnabled: false };
  return { ...next, [tool.key]: next[tool.key].filter((id) => id !== tool.id) };
}

/** Turn one tool back on. It never turns a Custom Bot back into Everything. */
export function enableBotTool(draft: BotAccessDraft, tool: Pick<BotTool, "key" | "id">): BotAccessDraft {
  if (tool.key === "webSearch") return draft.usesFullAccess ? { ...draft, webSearchEnabled: true } : draft;
  if (draft.usesFullAccess) return draft;
  if (tool.key === "shell") return { ...draft, shellEnabled: true };
  return draft[tool.key].includes(tool.id) ? draft : { ...draft, [tool.key]: [...draft[tool.key], tool.id] };
}
