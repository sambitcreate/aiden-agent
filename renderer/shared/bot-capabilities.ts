/**
 * Renderer-safe Bot capability vocabulary. These values are deliberately
 * limited to display metadata and opaque grant ids. Runtime bindings,
 * fingerprints, credentials, and filesystem paths are main-process only.
 */

export const BOT_CAPABILITY_STORE_VERSION = 3 as const;
export const BOT_FULL_ACCESS_NOTICE_VERSION = "bot-full-access-v1" as const;

export const BOT_CAPABILITY_LIMITS = {
  bots: 256,
  chats: 10_000,
  botIdChars: 160,
  chatIdChars: 128,
  revisionChars: 128,
  catalogRevisionChars: 128,
  opaqueIdChars: 128,
  providerIdChars: 256,
  modelIdChars: 512,
  labelChars: 120,
  descriptionChars: 280,
  providers: 64,
  modelsPerProvider: 256,
  modelsTotal: 512,
  fileScopes: 64,
  connections: 128,
  skills: 256,
  otherCapabilities: 128,
  noticeAudiences: 256,
} as const;

export const BOT_ACCESS_SUMMARIES = {
  full: "Can use your Mac, shell, enabled connections, and skills.",
  custom: "Uses only the access you select. This chat can reduce it further.",
} as const;

export type BotAccessMode = "full" | "custom";
export type BotChatAccessMode = "inherit" | "custom";
export type BotNoticeDecision = "continue_full" | "customize_first";
export type BotFileScopeKind = "full_mac" | "bot_home" | "approved_location";

export interface BotModelSelection {
  providerId: string;
  modelId: string;
}

export interface BotCapabilityOption {
  /** Opaque, main-minted grant id. It is not a provider/server/skill id. */
  id: string;
  label: string;
  available: boolean;
  description?: string;
}

export interface BotFileScopeOption extends BotCapabilityOption {
  kind: BotFileScopeKind;
}

export interface BotModelOption {
  id: string;
  label: string;
  available: boolean;
  supportsImages?: boolean;
}

export interface BotProviderOption {
  id: string;
  label: string;
  available: boolean;
  models: BotModelOption[];
}

export type BotNoticeStatus =
  | {
      version: typeof BOT_FULL_ACCESS_NOTICE_VERSION;
      requiresAcknowledgement: true;
      acceptedAt?: never;
      acceptedDecision?: never;
    }
  | {
      version: typeof BOT_FULL_ACCESS_NOTICE_VERSION;
      requiresAcknowledgement: false;
      acceptedAt: string;
      acceptedDecision: BotNoticeDecision;
    };

export interface BotCapabilityCatalog {
  revision: string;
  providers: BotProviderOption[];
  fileScopes: BotFileScopeOption[];
  shellAvailable: boolean;
  connections: BotCapabilityOption[];
  skills: BotCapabilityOption[];
  otherCapabilities: BotCapabilityOption[];
  notice: BotNoticeStatus;
}

/** Exact positive grants selected from one catalog revision. */
export interface BotCustomSelection {
  providerId: string;
  modelId: string;
  fileScopeIds: string[];
  shellEnabled: boolean;
  connectionIds: string[];
  skillIds: string[];
  otherCapabilityIds: string[];
}

export type BotAccessUpdate =
  | {
      accessMode: "full";
      catalogRevision: string;
      confirmedForeground: true;
      /** Optional Bot model authority. Older clients omit this pair. */
      providerId?: string;
      modelId?: string;
      /** Explicit Web Search authority. Omission never grants network access. */
      webSearchEnabled?: boolean;
      /** Omitted preserves, null clears, and an object exact-binds a companion. */
      visionModel?: BotModelSelection | null;
    }
  | {
      accessMode: "custom";
      catalogRevision: string;
      custom: BotCustomSelection;
      /** Omitted preserves, null clears, and an object exact-binds a companion. */
      visionModel?: BotModelSelection | null;
    };

export interface BotAccessViewBase {
  botId: string;
  revision: string;
  policyEpoch: string;
  summary: string;
}

export type BotAccessView = BotAccessViewBase &
  ({ accessMode: "full"; custom?: never } | { accessMode: "custom"; custom: BotCustomSelection });

export type BotChatAccessUpdate =
  | {
      mode: "inherit";
      catalogRevision: string;
      expectedBotPolicyRevision: string;
    }
  | {
      mode: "custom";
      catalogRevision: string;
      expectedBotPolicyRevision: string;
      custom: BotCustomSelection;
    };

export interface BotChatAccessViewBase {
  chatId: string;
  botId: string;
  revision: string;
  botPolicyRevision: string;
  summary: string;
}

export type BotChatAccessView = BotChatAccessViewBase &
  ({ mode: "inherit"; custom?: never } | { mode: "custom"; custom: BotCustomSelection });

export interface BotNoticeAcknowledgement {
  version: typeof BOT_FULL_ACCESS_NOTICE_VERSION;
  decision: BotNoticeDecision;
  confirmedForeground: true;
}

export class BotCapabilityValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BotCapabilityValidationError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function hasWellFormedUtf16(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

export function isBoundedBotText(
  value: unknown,
  maximumScalars: number,
  options: { allowEmpty?: boolean } = {},
): value is string {
  if (typeof value !== "string" || !hasWellFormedUtf16(value)) return false;
  if (!options.allowEmpty && value.length === 0) return false;
  let scalars = 0;
  for (const _scalar of value) {
    scalars += 1;
    if (scalars > maximumScalars) return false;
  }
  return true;
}

export function isPathSafeBotCapabilityId(
  value: unknown,
  maximumScalars: number = BOT_CAPABILITY_LIMITS.opaqueIdChars,
): value is string {
  return (
    isBoundedBotText(value, maximumScalars) &&
    value.normalize("NFKC") === value &&
    /^[A-Za-z0-9._:-]+$/u.test(value)
  );
}

export function assertBotIdentity(value: unknown, kind: "bot" | "chat"): string {
  const maximum =
    kind === "bot" ? BOT_CAPABILITY_LIMITS.botIdChars : BOT_CAPABILITY_LIMITS.chatIdChars;
  if (!isPathSafeBotCapabilityId(value, maximum)) {
    throw new BotCapabilityValidationError(`Invalid Bot ${kind} identity.`);
  }
  return value;
}

export function assertBotRevision(value: unknown, label = "revision"): string {
  if (!isPathSafeBotCapabilityId(value, BOT_CAPABILITY_LIMITS.revisionChars)) {
    throw new BotCapabilityValidationError(`Invalid Bot ${label}.`);
  }
  return value;
}

function parseUniqueOpaqueIds(value: unknown, maximum: number, label: string): string[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new BotCapabilityValidationError(`Invalid Bot ${label}.`);
  }
  const result: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!isPathSafeBotCapabilityId(entry) || seen.has(entry)) {
      throw new BotCapabilityValidationError(`Invalid Bot ${label}.`);
    }
    seen.add(entry);
    result.push(entry);
  }
  return result;
}

/**
 * Strict parser for renderer/remote selections. Unknown fields are rejected so
 * a caller cannot smuggle main-only bindings, paths, or fingerprints into disk.
 */
export function parseBotCustomSelection(value: unknown): BotCustomSelection {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "providerId",
      "modelId",
      "fileScopeIds",
      "shellEnabled",
      "connectionIds",
      "skillIds",
      "otherCapabilityIds",
    ]) ||
    Object.keys(value).length !== 7 ||
    !isBoundedBotText(value.providerId, BOT_CAPABILITY_LIMITS.providerIdChars) ||
    !isBoundedBotText(value.modelId, BOT_CAPABILITY_LIMITS.modelIdChars) ||
    typeof value.shellEnabled !== "boolean"
  ) {
    throw new BotCapabilityValidationError("Invalid Bot Custom access selection.");
  }
  return {
    providerId: value.providerId,
    modelId: value.modelId,
    fileScopeIds: parseUniqueOpaqueIds(
      value.fileScopeIds,
      BOT_CAPABILITY_LIMITS.fileScopes,
      "Custom file scopes",
    ),
    shellEnabled: value.shellEnabled,
    connectionIds: parseUniqueOpaqueIds(
      value.connectionIds,
      BOT_CAPABILITY_LIMITS.connections,
      "Custom connections",
    ),
    skillIds: parseUniqueOpaqueIds(value.skillIds, BOT_CAPABILITY_LIMITS.skills, "Custom skills"),
    otherCapabilityIds: parseUniqueOpaqueIds(
      value.otherCapabilityIds,
      BOT_CAPABILITY_LIMITS.otherCapabilities,
      "Custom capabilities",
    ),
  };
}

function validOptionalModelSelection(value: Record<string, unknown>, key: string): boolean {
  if (!Object.prototype.hasOwnProperty.call(value, key) || value[key] === null) return true;
  const selection = value[key];
  return (
    isRecord(selection) &&
    hasOnlyKeys(selection, ["providerId", "modelId"]) &&
    Object.keys(selection).length === 2 &&
    isBoundedBotText(selection.providerId, BOT_CAPABILITY_LIMITS.providerIdChars) &&
    isBoundedBotText(selection.modelId, BOT_CAPABILITY_LIMITS.modelIdChars)
  );
}

function parseNullableModelSelection(value: unknown): BotModelSelection | null {
  if (value === null) return null;
  if (!isRecord(value) || !validOptionalModelSelection({ selection: value }, "selection")) {
    throw new BotCapabilityValidationError("Invalid Bot companion vision model.");
  }
  return { providerId: value.providerId as string, modelId: value.modelId as string };
}

export function parseBotAccessUpdate(value: unknown): BotAccessUpdate {
  if (!isRecord(value)) {
    throw new BotCapabilityValidationError("Invalid Bot access update.");
  }
  if (value.accessMode === "full") {
    const hasProviderId = Object.prototype.hasOwnProperty.call(value, "providerId");
    const hasModelId = Object.prototype.hasOwnProperty.call(value, "modelId");
    if (
      !hasOnlyKeys(value, [
        "accessMode",
        "catalogRevision",
        "confirmedForeground",
        "providerId",
        "modelId",
        "webSearchEnabled",
        "visionModel",
      ]) ||
      value.confirmedForeground !== true ||
      hasProviderId !== hasModelId ||
      (hasProviderId &&
        (!isBoundedBotText(value.providerId, BOT_CAPABILITY_LIMITS.providerIdChars) ||
          !isBoundedBotText(value.modelId, BOT_CAPABILITY_LIMITS.modelIdChars))) ||
      (value.webSearchEnabled !== undefined && typeof value.webSearchEnabled !== "boolean") ||
      !validOptionalModelSelection(value, "visionModel")
    ) {
      throw new BotCapabilityValidationError("Full Access requires foreground confirmation.");
    }
    return {
      accessMode: "full",
      catalogRevision: assertBotRevision(value.catalogRevision, "catalog revision"),
      confirmedForeground: true,
      ...(hasProviderId
        ? {
            providerId: value.providerId as string,
            modelId: value.modelId as string,
          }
        : {}),
      ...(value.webSearchEnabled === undefined ? {} : { webSearchEnabled: value.webSearchEnabled }),
      ...(Object.prototype.hasOwnProperty.call(value, "visionModel")
        ? { visionModel: parseNullableModelSelection(value.visionModel) }
        : {}),
    };
  }
  if (
    value.accessMode !== "custom" ||
    !hasOnlyKeys(value, ["accessMode", "catalogRevision", "custom", "visionModel"]) ||
    !validOptionalModelSelection(value, "visionModel")
  ) {
    throw new BotCapabilityValidationError("Invalid Bot access update.");
  }
  return {
    accessMode: "custom",
    catalogRevision: assertBotRevision(value.catalogRevision, "catalog revision"),
    custom: parseBotCustomSelection(value.custom),
    ...(Object.prototype.hasOwnProperty.call(value, "visionModel")
      ? { visionModel: parseNullableModelSelection(value.visionModel) }
      : {}),
  };
}

export function parseBotChatAccessUpdate(value: unknown): BotChatAccessUpdate {
  if (!isRecord(value)) {
    throw new BotCapabilityValidationError("Invalid Bot chat access update.");
  }
  if (value.mode === "inherit") {
    if (
      !hasOnlyKeys(value, ["mode", "catalogRevision", "expectedBotPolicyRevision"]) ||
      Object.keys(value).length !== 3
    ) {
      throw new BotCapabilityValidationError("Invalid inherited Bot chat access update.");
    }
    return {
      mode: "inherit",
      catalogRevision: assertBotRevision(value.catalogRevision, "catalog revision"),
      expectedBotPolicyRevision: assertBotRevision(
        value.expectedBotPolicyRevision,
        "expected policy revision",
      ),
    };
  }
  if (
    value.mode !== "custom" ||
    !hasOnlyKeys(value, ["mode", "catalogRevision", "expectedBotPolicyRevision", "custom"]) ||
    Object.keys(value).length !== 4
  ) {
    throw new BotCapabilityValidationError("Invalid Custom Bot chat access update.");
  }
  return {
    mode: "custom",
    catalogRevision: assertBotRevision(value.catalogRevision, "catalog revision"),
    expectedBotPolicyRevision: assertBotRevision(
      value.expectedBotPolicyRevision,
      "expected policy revision",
    ),
    custom: parseBotCustomSelection(value.custom),
  };
}

export function parseBotNoticeAcknowledgement(value: unknown): BotNoticeAcknowledgement {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["version", "decision", "confirmedForeground"]) ||
    Object.keys(value).length !== 3 ||
    value.version !== BOT_FULL_ACCESS_NOTICE_VERSION ||
    (value.decision !== "continue_full" && value.decision !== "customize_first") ||
    value.confirmedForeground !== true
  ) {
    throw new BotCapabilityValidationError("Invalid Bot access notice acknowledgement.");
  }
  return {
    version: BOT_FULL_ACCESS_NOTICE_VERSION,
    decision: value.decision,
    confirmedForeground: true,
  };
}

export function cloneBotCustomSelection(selection: BotCustomSelection): BotCustomSelection {
  return {
    ...selection,
    fileScopeIds: [...selection.fileScopeIds],
    connectionIds: [...selection.connectionIds],
    skillIds: [...selection.skillIds],
    otherCapabilityIds: [...selection.otherCapabilityIds],
  };
}

export const BOT_FILE_SCOPE_SELECTION_GUIDANCE =
  "Choose Full Mac, Bot folder, approved locations with the Bot folder, or Files Off.";

/** True when Custom file scopes match the grant rules the binder will enforce. */
export function botFileScopeSelectionIsCoherent(
  fileScopeIds: readonly string[],
  fileScopes: readonly Pick<BotFileScopeOption, "id" | "kind">[],
): boolean {
  const scopes = fileScopeIds.map((id) => fileScopes.find((scope) => scope.id === id));
  if (scopes.some((scope) => !scope)) return false;
  const kinds = scopes.map((scope) => scope!.kind);
  const fullMac = kinds.filter((kind) => kind === "full_mac").length;
  const botHome = kinds.filter((kind) => kind === "bot_home").length;
  const approved = kinds.filter((kind) => kind === "approved_location").length;
  if (fullMac > 0) return fullMac === 1 && kinds.length === 1;
  if (approved > 0) return botHome === 1;
  return botHome <= 1;
}

/** Apply one file-scope toggle while preserving binder-coherent grants. */
export function nextBotFileScopeIds(
  fileScopeIds: readonly string[],
  fileScopes: readonly Pick<BotFileScopeOption, "id" | "kind">[],
  id: string,
  enabled: boolean,
): string[] {
  const option = fileScopes.find((scope) => scope.id === id);
  if (!option) return [...fileScopeIds];
  const selected = new Set(fileScopeIds);
  const removeKind = (kind: BotFileScopeOption["kind"]) => {
    for (const scope of fileScopes) {
      if (scope.kind === kind) selected.delete(scope.id);
    }
  };
  if (!enabled) {
    selected.delete(id);
    if (option.kind === "bot_home") removeKind("approved_location");
    return [...selected];
  }
  if (option.kind === "full_mac") return [id];
  removeKind("full_mac");
  selected.add(id);
  if (option.kind === "approved_location") {
    const botHome = fileScopes.find((scope) => scope.kind === "bot_home");
    if (botHome) selected.add(botHome.id);
  }
  return [...selected];
}

export function botCustomSelectionIsSubset(
  candidate: BotCustomSelection,
  ceiling: BotCustomSelection,
  fileScopes?: readonly Pick<BotFileScopeOption, "id" | "kind">[],
): boolean {
  const subset = (values: readonly string[], allowed: readonly string[]) => {
    const set = new Set(allowed);
    return values.every((value) => set.has(value));
  };
  const rawFileSubset = subset(candidate.fileScopeIds, ceiling.fileScopeIds);
  const ceilingHasFullMac = fileScopes?.some(
    (scope) => scope.kind === "full_mac" && ceiling.fileScopeIds.includes(scope.id),
  );
  return (
    candidate.providerId === ceiling.providerId &&
    candidate.modelId === ceiling.modelId &&
    (!candidate.shellEnabled || ceiling.shellEnabled) &&
    (rawFileSubset || ceilingHasFullMac === true) &&
    subset(candidate.connectionIds, ceiling.connectionIds) &&
    subset(candidate.skillIds, ceiling.skillIds) &&
    subset(candidate.otherCapabilityIds, ceiling.otherCapabilityIds)
  );
}

export function botCustomSelectionsEqual(
  left: BotCustomSelection,
  right: BotCustomSelection,
): boolean {
  return botCustomSelectionIsSubset(left, right) && botCustomSelectionIsSubset(right, left);
}

/** True when moving between two Custom selections removes any prior grant. */
export function botCustomSelectionNarrows(
  previous: BotCustomSelection,
  next: BotCustomSelection,
): boolean {
  return !botCustomSelectionIsSubset(previous, next);
}

/**
 * Keep only grants allowed by both selections. Provider/model follows the new
 * authoritative Bot policy; all independently reducible capability groups are
 * intersected so a parent update cannot widen an explicitly reduced chat.
 */
export function intersectBotCustomSelections(
  chat: BotCustomSelection,
  bot: BotCustomSelection,
  fileScopes?: readonly Pick<BotFileScopeOption, "id" | "kind">[],
): BotCustomSelection {
  const intersection = (left: readonly string[], right: readonly string[]) => {
    const allowed = new Set(right);
    return left.filter((value) => allowed.has(value));
  };
  const includesFullMac = (selection: BotCustomSelection) =>
    fileScopes?.some(
      (scope) => scope.kind === "full_mac" && selection.fileScopeIds.includes(scope.id),
    ) === true;
  const fileScopeIds = includesFullMac(bot)
    ? [...chat.fileScopeIds]
    : includesFullMac(chat)
      ? [...bot.fileScopeIds]
      : intersection(chat.fileScopeIds, bot.fileScopeIds);
  return {
    providerId: bot.providerId,
    modelId: bot.modelId,
    fileScopeIds,
    shellEnabled: chat.shellEnabled && bot.shellEnabled,
    connectionIds: intersection(chat.connectionIds, bot.connectionIds),
    skillIds: intersection(chat.skillIds, bot.skillIds),
    otherCapabilityIds: intersection(chat.otherCapabilityIds, bot.otherCapabilityIds),
  };
}

export function validateSelectionAgainstCatalog(
  selection: BotCustomSelection,
  catalog: BotCapabilityCatalog,
  options: { requireAvailable?: boolean } = {},
): void {
  const requireAvailable = options.requireAvailable ?? true;
  const requireOptions = (
    ids: readonly string[],
    choices: readonly { id: string; available: boolean }[],
    label: string,
  ) => {
    for (const id of ids) {
      const option = choices.find((candidate) => candidate.id === id);
      if (!option || (requireAvailable && !option.available)) {
        throw new BotCapabilityValidationError(
          `Bot Custom access contains an unavailable ${label}.`,
        );
      }
    }
  };
  const provider = catalog.providers.find(({ id }) => id === selection.providerId);
  const model = provider?.models.find(({ id }) => id === selection.modelId);
  if (!provider || !model || (requireAvailable && (!provider.available || !model.available))) {
    throw new BotCapabilityValidationError(
      "Bot Custom access contains an unavailable AI connection.",
    );
  }
  if (requireAvailable && selection.shellEnabled && !catalog.shellAvailable) {
    throw new BotCapabilityValidationError("Bot Custom access enables unavailable shell access.");
  }
  requireOptions(selection.fileScopeIds, catalog.fileScopes, "file scope");
  requireOptions(selection.connectionIds, catalog.connections, "connection");
  requireOptions(selection.skillIds, catalog.skills, "skill");
  requireOptions(selection.otherCapabilityIds, catalog.otherCapabilities, "capability");
}

export function validateVisionSelectionAgainstCatalog(
  selection: BotModelSelection | null | undefined,
  catalog: BotCapabilityCatalog,
): void {
  if (!selection) return;
  const provider = catalog.providers.find(({ id }) => id === selection.providerId);
  const model = provider?.models.find(({ id }) => id === selection.modelId);
  if (!provider?.available || !model?.available || model.supportsImages !== true) {
    throw new BotCapabilityValidationError(
      "Choose an available image-capable model for image understanding.",
    );
  }
}
