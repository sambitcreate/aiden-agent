import {
  BOT_ACCESS_SUMMARIES,
  BOT_CAPABILITY_LIMITS,
  BOT_CAPABILITY_STORE_VERSION,
  BOT_FULL_ACCESS_NOTICE_VERSION,
  assertBotIdentity,
  assertBotRevision,
  botCustomSelectionIsSubset,
  botCustomSelectionNarrows,
  botCustomSelectionsEqual,
  cloneBotCustomSelection,
  intersectBotCustomSelections,
  isPathSafeBotCapabilityId,
  parseBotAccessUpdate,
  parseBotChatAccessUpdate,
  parseBotCustomSelection,
  parseBotNoticeAcknowledgement,
  validateSelectionAgainstCatalog,
  validateVisionSelectionAgainstCatalog,
  type BotAccessUpdate,
  type BotAccessView,
  type BotCapabilityCatalog,
  type BotChatAccessUpdate,
  type BotChatAccessView,
  type BotCustomSelection,
  type BotNoticeAcknowledgement,
  type BotNoticeDecision,
  type BotNoticeStatus,
} from "../../renderer/shared/bot-capabilities.js";
import {
  assertBoundBotCustomSelectionCurrent,
  assertBoundBotProviderModelCurrent,
  boundBotProviderModelFingerprint,
  boundBotCustomSelectionFingerprint,
  cloneBoundBotProviderModel,
  cloneBoundBotCustomSelection,
  parseBoundBotProviderModel,
  parseBoundBotCustomSelection,
  type BoundBotProviderModel,
  type BoundBotCustomSelection,
} from "./bot-capability-bindings.js";
import type { BotCapabilityCatalogSnapshot } from "./bot-capability-catalog-core.js";

const MAX_DATE_MILLISECONDS = 8_640_000_000_000_000;
const MAX_INCARNATIONS_PER_NAMESPACE = 4_096;
const EXACT_HASH = /^[a-f0-9]{64}$/u;
const INCARNATION_ID = /^[A-Za-z0-9._:@/+-]{1,512}$/u;
const INCARNATION_TOKEN = /^[A-Za-z0-9_-]{43}$/u;

export type BotCapabilityAuthorityStatus = "active" | "archived";
export type BotCapabilityIncarnationNamespace = "provider" | "mcp" | "skill";

export interface BotCapabilityIncarnationInput {
  sourceId: string;
  credentialSignature: string;
}

export interface BotCapabilityIncarnationReconcileOptions {
  /** Main-only inventory partition. Resources in another partition are not marked absent. */
  partition?: string;
}

export interface BotCapabilityIncarnation {
  sourceId: string;
  resourceIncarnation: string;
  credentialIncarnation: string;
}

export interface StoredBotCapabilityIncarnation extends BotCapabilityIncarnation {
  partition: string;
  credentialSignature: string;
  present: boolean;
}

export type StoredBotCapabilityIncarnations = Record<
  BotCapabilityIncarnationNamespace,
  StoredBotCapabilityIncarnation[]
>;

interface StoredRevision {
  revision: string;
  revisionSequence: number;
}

interface StoredBotPolicyBase extends StoredRevision {
  botId: string;
  authorityStatus: BotCapabilityAuthorityStatus;
  catalogRevision: string;
  policyEpoch: number;
  createdAt: number;
  updatedAt: number;
  /** Main-only exact companion used solely for image inspection by text-only primary models. */
  visionModel?: StoredBotModelAuthority;
}

export type StoredBotCapabilityPolicy = StoredBotPolicyBase &
  (
    | {
        accessMode: "full";
        custom?: never;
        binding?: never;
        /** Main-only durable model authority. Older Full policies may omit it. */
        model?: StoredBotModelAuthority;
      }
    | {
        accessMode: "custom";
        custom: BotCustomSelection;
        /** Main-only exact facts. Never include this field in a public projection. */
        binding: BoundBotCustomSelection;
      }
  );

export interface StoredBotModelAuthority {
  selection: { providerId: string; modelId: string };
  binding: BoundBotProviderModel;
}

interface StoredBotChatPolicyBase extends StoredRevision {
  chatId: string;
  botId: string;
  catalogRevision: string;
  policyEpoch: number;
  createdAt: number;
  updatedAt: number;
}

export type StoredBotChatCapabilityPolicy = StoredBotChatPolicyBase &
  (
    | { mode: "inherit"; custom?: never }
    | { mode: "custom"; custom: BotCustomSelection }
  );

export interface BotArchivedReadAuthoritySnapshot {
  policy: StoredBotCapabilityPolicy;
  chat: StoredBotChatCapabilityPolicy;
  effectiveCustom?: BotCustomSelection;
}

export interface StoredBotNoticeAcceptance extends StoredRevision {
  /** Main-owned paired-device/principal identity; never a display label. */
  audienceId: string;
  version: typeof BOT_FULL_ACCESS_NOTICE_VERSION;
  decision: BotNoticeDecision;
  acceptedAt: number;
}

export interface StoredBotLegacyMigration extends StoredRevision {
  completedAt: number;
}

export interface BotCapabilityState {
  version: typeof BOT_CAPABILITY_STORE_VERSION;
  /** Monotonic commit sequence; each durable revision records its source value. */
  sequence: number;
  policies: StoredBotCapabilityPolicy[];
  chats: StoredBotChatCapabilityPolicy[];
  notices: StoredBotNoticeAcceptance[];
  incarnations: StoredBotCapabilityIncarnations;
  legacyMigration?: StoredBotLegacyMigration;
}

export type BotCapabilityRevisionKind = "policy" | "chat" | "notice" | "migration";

export interface BotCapabilityCoreDependencies {
  now(): number;
  mintRevision(kind: BotCapabilityRevisionKind, sequence: number): string;
  mintIncarnation(): string;
}

export class BotCapabilityUnavailableError extends Error {
  constructor(message = "Bot access is unavailable and must be repaired.") {
    super(message);
    this.name = "BotCapabilityUnavailableError";
  }
}

export class BotCapabilityRevisionConflictError extends Error {
  readonly currentRevision: string;

  constructor(currentRevision: string) {
    super("Bot access changed on another surface.");
    this.name = "BotCapabilityRevisionConflictError";
    this.currentRevision = currentRevision;
  }
}

export class BotCapabilityCatalogConflictError extends Error {
  readonly currentRevision: string;

  constructor(currentRevision: string) {
    super("Bot capability choices changed. Review the current choices and try again.");
    this.name = "BotCapabilityCatalogConflictError";
    this.currentRevision = currentRevision;
  }
}

export class BotCapabilitySubsetError extends Error {
  constructor() {
    super("This chat cannot use more access than its Bot allows.");
    this.name = "BotCapabilitySubsetError";
  }
}

export class BotCapabilityNoticeRequiredError extends Error {
  constructor() {
    super("Review the current Bot access notice before this Bot acts.");
    this.name = "BotCapabilityNoticeRequiredError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}

function safeInteger(value: unknown, minimum = 0): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum;
}

function safeTimestamp(value: unknown): value is number {
  return safeInteger(value) && (value as number) <= MAX_DATE_MILLISECONDS;
}

function parseAuthorityStatus(value: unknown): BotCapabilityAuthorityStatus {
  if (value !== "active" && value !== "archived") {
    throw new BotCapabilityUnavailableError("Bot authority status storage is invalid.");
  }
  return value;
}

function parseIncarnationToken(value: unknown): string {
  if (typeof value !== "string" || !INCARNATION_TOKEN.test(value)) {
    throw new BotCapabilityUnavailableError("Bot capability incarnation token is invalid.");
  }
  return value;
}

function parseIncarnationNamespace(
  value: unknown,
): StoredBotCapabilityIncarnation[] {
  if (!Array.isArray(value) || value.length > MAX_INCARNATIONS_PER_NAMESPACE) {
    throw new BotCapabilityUnavailableError("Bot capability incarnation storage exceeds its bound.");
  }
  const seen = new Set<string>();
  let previousKey: string | undefined;
  return value.map((candidate) => {
    if (
      !isRecord(candidate) ||
      !exactKeys(candidate, [
        "partition",
        "sourceId",
        "resourceIncarnation",
        "credentialSignature",
        "credentialIncarnation",
        "present",
      ]) ||
      typeof candidate.partition !== "string" ||
      !INCARNATION_ID.test(candidate.partition) ||
      typeof candidate.sourceId !== "string" ||
      !INCARNATION_ID.test(candidate.sourceId) ||
      typeof candidate.credentialSignature !== "string" ||
      !EXACT_HASH.test(candidate.credentialSignature) ||
      typeof candidate.present !== "boolean"
    ) {
      throw new BotCapabilityUnavailableError(
        "Bot capability incarnation storage contains an invalid entry.",
      );
    }
    const key = `${candidate.partition}\0${candidate.sourceId}`;
    if (seen.has(key) || (previousKey !== undefined && previousKey >= key)) {
      throw new BotCapabilityUnavailableError(
        "Bot capability incarnation storage is duplicate or non-canonical.",
      );
    }
    seen.add(key);
    previousKey = key;
    return {
      partition: candidate.partition,
      sourceId: candidate.sourceId,
      resourceIncarnation: parseIncarnationToken(candidate.resourceIncarnation),
      credentialSignature: candidate.credentialSignature,
      credentialIncarnation: parseIncarnationToken(candidate.credentialIncarnation),
      present: candidate.present,
    };
  });
}

function parseIncarnations(value: unknown): StoredBotCapabilityIncarnations {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["provider", "mcp", "skill"])
  ) {
    throw new BotCapabilityUnavailableError("Bot capability incarnation storage is invalid.");
  }
  return {
    provider: parseIncarnationNamespace(value.provider),
    mcp: parseIncarnationNamespace(value.mcp),
    skill: parseIncarnationNamespace(value.skill),
  };
}

function assertNoticeAudience(value: unknown): string {
  if (!isPathSafeBotCapabilityId(value, BOT_CAPABILITY_LIMITS.chatIdChars)) {
    throw new BotCapabilityUnavailableError("Invalid Bot notice audience identity.");
  }
  return value;
}

function parseRevision(value: Record<string, unknown>, stateSequence: number): StoredRevision {
  if (!safeInteger(value.revisionSequence, 1) || value.revisionSequence > stateSequence) {
    throw new BotCapabilityUnavailableError("Bot access revision history is invalid.");
  }
  return {
    revision: assertBotRevision(value.revision),
    revisionSequence: value.revisionSequence,
  };
}

function parseStoredBotModelAuthority(value: unknown): StoredBotModelAuthority {
  if (!isRecord(value) || !exactKeys(value, ["selection", "binding"]) || !isRecord(value.selection)) {
    throw new BotCapabilityUnavailableError("Bot model authority storage is invalid.");
  }
  if (!exactKeys(value.selection, ["providerId", "modelId"])) {
    throw new BotCapabilityUnavailableError("Bot model selection storage is invalid.");
  }
  const providerId = value.selection.providerId;
  const modelId = value.selection.modelId;
  if (!isPathSafeBotCapabilityId(providerId) || !isPathSafeBotCapabilityId(modelId)) {
    throw new BotCapabilityUnavailableError("Bot model selection storage is invalid.");
  }
  const binding = parseBoundBotProviderModel(value.binding);
  if (
    binding.providerOption.id !== providerId ||
    binding.modelOption.id !== modelId
  ) {
    throw new BotCapabilityUnavailableError(
      "Bot model selection does not match its private binding.",
    );
  }
  return {
    selection: { providerId, modelId },
    binding,
  };
}

function cloneStoredBotModelAuthority(
  value: StoredBotModelAuthority,
): StoredBotModelAuthority {
  return {
    selection: { ...value.selection },
    binding: cloneBoundBotProviderModel(value.binding),
  };
}

function modelAuthorityFingerprint(value: StoredBotModelAuthority | undefined): string | undefined {
  return value
    ? `${value.selection.providerId}\0${value.selection.modelId}\0${boundBotProviderModelFingerprint(value.binding)}`
    : undefined;
}

export function storedBotModelAuthority(
  policy: StoredBotCapabilityPolicy,
): StoredBotModelAuthority | undefined {
  return policy.accessMode === "custom"
    ? {
        selection: {
          providerId: policy.custom.providerId,
          modelId: policy.custom.modelId,
        },
        binding: cloneBoundBotProviderModel(policy.binding.provider),
      }
    : policy.model
      ? cloneStoredBotModelAuthority(policy.model)
      : undefined;
}

function parsePolicy(value: unknown, stateSequence: number): StoredBotCapabilityPolicy {
  if (!isRecord(value)) throw new BotCapabilityUnavailableError();
  const common = [
    "botId",
    "authorityStatus",
    "accessMode",
    "catalogRevision",
    "policyEpoch",
    "revision",
    "revisionSequence",
    "createdAt",
    "updatedAt",
  ] as const;
  if (
    !exactKeys(
      value,
      common,
      value.accessMode === "custom"
        ? ["custom", "binding", "visionModel"]
        : ["model", "visionModel"],
    ) ||
    (value.accessMode !== "full" && value.accessMode !== "custom") ||
    !safeInteger(value.policyEpoch, 1) ||
    !safeTimestamp(value.createdAt) ||
    !safeTimestamp(value.updatedAt) ||
    value.updatedAt < value.createdAt
  ) {
    throw new BotCapabilityUnavailableError("Bot access policy storage is invalid.");
  }
  const base: StoredBotPolicyBase = {
    botId: assertBotIdentity(value.botId, "bot"),
    authorityStatus: parseAuthorityStatus(value.authorityStatus),
    accessMode: undefined as never,
    catalogRevision: assertBotRevision(value.catalogRevision, "catalog revision"),
    policyEpoch: value.policyEpoch,
    ...parseRevision(value, stateSequence),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    ...(value.visionModel === undefined
      ? {}
      : { visionModel: parseStoredBotModelAuthority(value.visionModel) }),
  } as StoredBotPolicyBase;
  if (value.accessMode === "full") {
    return {
      ...base,
      accessMode: "full",
      ...(value.model === undefined ? {} : { model: parseStoredBotModelAuthority(value.model) }),
    };
  }
  const custom = parseBotCustomSelection(value.custom);
  const binding = parseBoundBotCustomSelection(value.binding);
  if (
    binding.catalogRevision !== base.catalogRevision ||
    !botCustomSelectionsEqual(binding.selection, custom)
  ) {
    throw new BotCapabilityUnavailableError(
      "Bot Custom access binding does not match its stored policy.",
    );
  }
  return { ...base, accessMode: "custom", custom, binding };
}

function parseChatPolicy(value: unknown, stateSequence: number): StoredBotChatCapabilityPolicy {
  if (!isRecord(value)) throw new BotCapabilityUnavailableError();
  const common = [
    "chatId",
    "botId",
    "mode",
    "catalogRevision",
    "policyEpoch",
    "revision",
    "revisionSequence",
    "createdAt",
    "updatedAt",
  ] as const;
  if (
    !exactKeys(value, common, value.mode === "custom" ? ["custom"] : []) ||
    (value.mode !== "inherit" && value.mode !== "custom") ||
    !safeInteger(value.policyEpoch, 1) ||
    !safeTimestamp(value.createdAt) ||
    !safeTimestamp(value.updatedAt) ||
    value.updatedAt < value.createdAt
  ) {
    throw new BotCapabilityUnavailableError("Bot chat access storage is invalid.");
  }
  const base: StoredBotChatPolicyBase = {
    chatId: assertBotIdentity(value.chatId, "chat"),
    botId: assertBotIdentity(value.botId, "bot"),
    mode: undefined as never,
    catalogRevision: assertBotRevision(value.catalogRevision, "catalog revision"),
    policyEpoch: value.policyEpoch,
    ...parseRevision(value, stateSequence),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  } as StoredBotChatPolicyBase;
  return value.mode === "custom"
    ? { ...base, mode: "custom", custom: parseBotCustomSelection(value.custom) }
    : { ...base, mode: "inherit" };
}

function parseNotice(
  value: unknown,
  stateSequence: number,
): StoredBotNoticeAcceptance {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "audienceId",
      "version",
      "decision",
      "acceptedAt",
      "revision",
      "revisionSequence",
    ]) ||
    value.version !== BOT_FULL_ACCESS_NOTICE_VERSION ||
    (value.decision !== "continue_full" && value.decision !== "customize_first") ||
    !safeTimestamp(value.acceptedAt)
  ) {
    throw new BotCapabilityUnavailableError("Bot access notice storage is invalid.");
  }
  return {
    audienceId: assertNoticeAudience(value.audienceId),
    version: BOT_FULL_ACCESS_NOTICE_VERSION,
    decision: value.decision,
    acceptedAt: value.acceptedAt,
    ...parseRevision(value, stateSequence),
  };
}

function parseLegacyMigration(
  value: unknown,
  stateSequence: number,
): StoredBotLegacyMigration | undefined {
  if (value === undefined) return undefined;
  if (
    !isRecord(value) ||
    !exactKeys(value, ["completedAt", "revision", "revisionSequence"]) ||
    !safeTimestamp(value.completedAt)
  ) {
    throw new BotCapabilityUnavailableError("Bot access migration storage is invalid.");
  }
  return {
    completedAt: value.completedAt,
    ...parseRevision(value, stateSequence),
  };
}

export function emptyBotCapabilityState(): BotCapabilityState {
  return {
    version: BOT_CAPABILITY_STORE_VERSION,
    sequence: 0,
    policies: [],
    chats: [],
    notices: [],
    incarnations: { provider: [], mcp: [], skill: [] },
  };
}

/** Strict current-version parser. Old, damaged, or future documents never become Full. */
export function parseBotCapabilityState(value: unknown): BotCapabilityState {
  if (
    !isRecord(value) ||
    !exactKeys(
      value,
      ["version", "sequence", "policies", "chats", "notices", "incarnations"],
      ["legacyMigration"],
    ) ||
    value.version !== BOT_CAPABILITY_STORE_VERSION ||
    !safeInteger(value.sequence) ||
    !Array.isArray(value.policies) ||
    value.policies.length > BOT_CAPABILITY_LIMITS.bots ||
    !Array.isArray(value.chats) ||
    value.chats.length > BOT_CAPABILITY_LIMITS.chats ||
    !Array.isArray(value.notices) ||
    value.notices.length > BOT_CAPABILITY_LIMITS.noticeAudiences
  ) {
    throw new BotCapabilityUnavailableError("Bot access storage has an unsupported version or shape.");
  }
  const policies = value.policies.map((entry) => parsePolicy(entry, value.sequence as number));
  const chats = value.chats.map((entry) => parseChatPolicy(entry, value.sequence as number));
  const notices = value.notices.map((entry) => parseNotice(entry, value.sequence as number));
  const incarnations = parseIncarnations(value.incarnations);
  const legacyMigration = parseLegacyMigration(value.legacyMigration, value.sequence as number);
  if (new Set(policies.map(({ botId }) => botId)).size !== policies.length) {
    throw new BotCapabilityUnavailableError("Bot access storage contains duplicate Bot identities.");
  }
  if (new Set(chats.map(({ chatId }) => chatId)).size !== chats.length) {
    throw new BotCapabilityUnavailableError("Bot access storage contains duplicate chat identities.");
  }
  const revisions = [
    ...policies.map(({ revision }) => revision),
    ...chats.map(({ revision }) => revision),
    ...notices.map(({ revision }) => revision),
    ...(legacyMigration ? [legacyMigration.revision] : []),
  ];
  if (new Set(revisions).size !== revisions.length) {
    throw new BotCapabilityUnavailableError("Bot access storage contains duplicate revisions.");
  }
  if (new Set(notices.map(({ audienceId }) => audienceId)).size !== notices.length) {
    throw new BotCapabilityUnavailableError("Bot access notice storage contains duplicate audiences.");
  }
  if (
    value.sequence === 0 &&
    Object.values(incarnations).some((entries) => entries.length > 0)
  ) {
    throw new BotCapabilityUnavailableError("Bot capability incarnation history is invalid.");
  }
  const policyByBot = new Map(policies.map((policy) => [policy.botId, policy] as const));
  for (const chat of chats) {
    const policy = policyByBot.get(chat.botId);
    if (!policy) {
      throw new BotCapabilityUnavailableError("Bot chat access has no owning policy.");
    }
    if (
      chat.mode === "custom" &&
      policy.accessMode === "custom" &&
      !botCustomSelectionIsSubset(
        chat.custom,
        policy.custom,
        policy.binding.fileScopes.map(({ option }) => option),
      )
    ) {
      throw new BotCapabilityUnavailableError("Bot chat access exceeds its stored Bot policy.");
    }
  }
  return {
    version: BOT_CAPABILITY_STORE_VERSION,
    sequence: value.sequence,
    policies,
    chats,
    notices,
    incarnations,
    ...(legacyMigration ? { legacyMigration } : {}),
  };
}

function clonePolicy(policy: StoredBotCapabilityPolicy): StoredBotCapabilityPolicy {
  return policy.accessMode === "custom"
    ? {
        ...policy,
        ...(policy.visionModel
          ? { visionModel: cloneStoredBotModelAuthority(policy.visionModel) }
          : {}),
        custom: cloneBotCustomSelection(policy.custom),
        binding: cloneBoundBotCustomSelection(policy.binding),
      }
    : {
        ...policy,
        ...(policy.visionModel
          ? { visionModel: cloneStoredBotModelAuthority(policy.visionModel) }
          : {}),
        ...(policy.model ? { model: cloneStoredBotModelAuthority(policy.model) } : {}),
      };
}

function cloneChatPolicy(policy: StoredBotChatCapabilityPolicy): StoredBotChatCapabilityPolicy {
  return policy.mode === "custom"
    ? { ...policy, custom: cloneBotCustomSelection(policy.custom) }
    : { ...policy };
}

export function projectBotNoticeStatus(
  state: Readonly<BotCapabilityState>,
  audienceId: string,
): BotNoticeStatus {
  const safeAudienceId = assertNoticeAudience(audienceId);
  const notice = state.notices.find((entry) => entry.audienceId === safeAudienceId);
  if (!notice) {
    return {
      version: BOT_FULL_ACCESS_NOTICE_VERSION,
      requiresAcknowledgement: true,
    };
  }
  return {
    version: BOT_FULL_ACCESS_NOTICE_VERSION,
    requiresAcknowledgement: false,
    acceptedAt: new Date(notice.acceptedAt).toISOString(),
    acceptedDecision: notice.decision,
  };
}

export function projectBotAccessView(
  state: Readonly<BotCapabilityState>,
  botId: string,
): BotAccessView {
  assertBotIdentity(botId, "bot");
  const policy = state.policies.find((entry) => entry.botId === botId);
  if (!policy) throw new BotCapabilityUnavailableError();
  const base = {
    botId,
    revision: policy.revision,
    policyEpoch: `epoch:${policy.policyEpoch}`,
    summary:
      policy.accessMode === "full" ? BOT_ACCESS_SUMMARIES.full : BOT_ACCESS_SUMMARIES.custom,
  };
  return policy.accessMode === "custom"
    ? { ...base, accessMode: "custom", custom: cloneBotCustomSelection(policy.custom) }
    : { ...base, accessMode: "full" };
}

export function projectBotChatAccessView(
  state: Readonly<BotCapabilityState>,
  chatId: string,
): BotChatAccessView {
  assertBotIdentity(chatId, "chat");
  const chat = state.chats.find((entry) => entry.chatId === chatId);
  if (!chat) throw new BotCapabilityUnavailableError();
  const policy = state.policies.find((entry) => entry.botId === chat.botId);
  if (!policy) throw new BotCapabilityUnavailableError();
  const base = {
    chatId,
    botId: chat.botId,
    revision: chat.revision,
    botPolicyRevision: policy.revision,
    summary:
      chat.mode === "inherit" && policy.accessMode === "full"
        ? BOT_ACCESS_SUMMARIES.full
        : BOT_ACCESS_SUMMARIES.custom,
  };
  return chat.mode === "custom"
    ? { ...base, mode: "custom", custom: cloneBotCustomSelection(chat.custom) }
    : { ...base, mode: "inherit" };
}

export interface BotCapabilityPolicyAudit {
  complete: boolean;
  missingBotIds: string[];
  orphanedBotIds: string[];
}

export interface BotPolicyUpdateResult {
  view: BotAccessView;
  narrowed: boolean;
  authorityChanged: boolean;
  policyEpoch: number;
  narrowedChats: Array<{ chatId: string; policyEpoch: number }>;
}

export interface BotChatPolicyUpdateResult {
  view: BotChatAccessView;
  narrowed: boolean;
  policyEpoch: number;
}

export function botPolicyTransitionNarrows(
  previous: StoredBotCapabilityPolicy,
  next: BotAccessUpdate,
): boolean {
  return previous.accessMode === "full"
    ? next.accessMode === "custom"
    : next.accessMode === "custom" && botCustomSelectionNarrows(previous.custom, next.custom);
}

export function botChatTransitionNarrows(
  previous: StoredBotChatCapabilityPolicy,
  next: BotChatAccessUpdate,
): boolean {
  return previous.mode === "inherit"
    ? next.mode === "custom"
    : next.mode === "custom" && botCustomSelectionNarrows(previous.custom, next.custom);
}

export class BotCapabilityStateEditor {
  constructor(
    private readonly state: BotCapabilityState,
    private readonly dependencies: BotCapabilityCoreDependencies,
  ) {}

  private timestamp(): number {
    const value = this.dependencies.now();
    if (!safeTimestamp(value)) throw new Error("Invalid Bot capability clock.");
    return value;
  }

  private issueRevision(kind: BotCapabilityRevisionKind): StoredRevision {
    if (this.state.sequence >= Number.MAX_SAFE_INTEGER) {
      throw new Error("Bot capability revision sequence is exhausted.");
    }
    const sequence = this.state.sequence + 1;
    const revision = this.dependencies.mintRevision(kind, sequence);
    assertBotRevision(revision);
    const used = new Set([
      ...this.state.policies.map((entry) => entry.revision),
      ...this.state.chats.map((entry) => entry.revision),
      ...this.state.notices.map((entry) => entry.revision),
      ...(this.state.legacyMigration ? [this.state.legacyMigration.revision] : []),
    ]);
    if (used.has(revision)) throw new Error("Bot capability revision identity was reused.");
    this.state.sequence = sequence;
    return { revision, revisionSequence: sequence };
  }

  /** Advance the document commit clock for a deletion that has no surviving record revision. */
  private issueDeletionCommit(): void {
    if (this.state.sequence >= Number.MAX_SAFE_INTEGER) {
      throw new Error("Bot capability revision sequence is exhausted.");
    }
    this.state.sequence += 1;
  }

  private mintIncarnation(): string {
    return parseIncarnationToken(this.dependencies.mintIncarnation());
  }

  private policy(botId: string): StoredBotCapabilityPolicy {
    const safeBotId = assertBotIdentity(botId, "bot");
    const policy = this.state.policies.find((entry) => entry.botId === safeBotId);
    if (!policy) throw new BotCapabilityUnavailableError();
    return policy;
  }

  private chat(chatId: string): StoredBotChatCapabilityPolicy {
    const safeChatId = assertBotIdentity(chatId, "chat");
    const chat = this.state.chats.find((entry) => entry.chatId === safeChatId);
    if (!chat) throw new BotCapabilityUnavailableError();
    return chat;
  }

  private assertCatalog(catalog: BotCapabilityCatalog, expectedRevision: string): void {
    const current = assertBotRevision(catalog.revision, "catalog revision");
    const expected = assertBotRevision(expectedRevision, "catalog revision");
    if (current !== expected) throw new BotCapabilityCatalogConflictError(current);
  }

  private assertPolicyRevision(policy: StoredBotCapabilityPolicy, expected: string): void {
    if (policy.revision !== assertBotRevision(expected, "expected policy revision")) {
      throw new BotCapabilityRevisionConflictError(policy.revision);
    }
  }

  private assertChatRevision(chat: StoredBotChatCapabilityPolicy, expected: string): void {
    if (chat.revision !== assertBotRevision(expected, "expected chat revision")) {
      throw new BotCapabilityRevisionConflictError(chat.revision);
    }
  }

  private bindingForCustomAccess(
    access: BotAccessUpdate,
    bindingValue: unknown,
  ): BoundBotCustomSelection | undefined {
    if (access.accessMode === "full") {
      if (bindingValue !== undefined) {
        throw new BotCapabilityUnavailableError(
          "Full Access cannot persist a Custom private binding.",
        );
      }
      return undefined;
    }
    if (bindingValue === undefined) {
      throw new BotCapabilityUnavailableError(
        "Custom Bot access requires an exact main-owned binding.",
      );
    }
    const binding = parseBoundBotCustomSelection(bindingValue);
    if (
      binding.catalogRevision !== access.catalogRevision ||
      !botCustomSelectionsEqual(binding.selection, access.custom)
    ) {
      throw new BotCapabilityUnavailableError(
        "Custom Bot access binding does not match the requested policy.",
      );
    }
    return binding;
  }

  private modelForFullAccess(
    access: BotAccessUpdate,
    bindingValue: unknown,
    previous?: StoredBotCapabilityPolicy,
  ): StoredBotModelAuthority | undefined {
    if (access.accessMode !== "full") {
      if (bindingValue !== undefined) {
        throw new BotCapabilityUnavailableError(
          "Custom Access cannot persist a separate Full model binding.",
        );
      }
      return undefined;
    }
    const hasSelection = access.providerId !== undefined && access.modelId !== undefined;
    if (!hasSelection) {
      if (bindingValue !== undefined) {
        throw new BotCapabilityUnavailableError(
          "A Full model binding requires an exact provider and model selection.",
        );
      }
      const retained = previous ? storedBotModelAuthority(previous) : undefined;
      return retained ? cloneStoredBotModelAuthority(retained) : undefined;
    }
    if (bindingValue === undefined) {
      throw new BotCapabilityUnavailableError(
        "A Full Bot model selection requires an exact main-owned binding.",
      );
    }
    const binding = parseBoundBotProviderModel(bindingValue);
    if (
      binding.providerOption.id !== access.providerId ||
      binding.modelOption.id !== access.modelId
    ) {
      throw new BotCapabilityUnavailableError(
        "The Full Bot model binding does not match the requested selection.",
      );
    }
    return {
      selection: { providerId: access.providerId, modelId: access.modelId },
      binding,
    };
  }

  private visionModelForAccess(
    access: BotAccessUpdate,
    bindingValue: unknown,
    previous?: StoredBotModelAuthority,
  ): StoredBotModelAuthority | undefined {
    if (access.visionModel === undefined) {
      if (bindingValue !== undefined) {
        throw new BotCapabilityUnavailableError(
          "A companion vision binding requires an exact provider and model selection.",
        );
      }
      return previous ? cloneStoredBotModelAuthority(previous) : undefined;
    }
    if (access.visionModel === null) {
      if (bindingValue !== undefined) {
        throw new BotCapabilityUnavailableError(
          "A cleared companion vision model cannot include a binding.",
        );
      }
      return undefined;
    }
    if (bindingValue === undefined) {
      throw new BotCapabilityUnavailableError(
        "A companion vision model requires an exact main-owned binding.",
      );
    }
    const binding = parseBoundBotProviderModel(bindingValue);
    if (
      binding.providerOption.id !== access.visionModel.providerId ||
      binding.modelOption.id !== access.visionModel.modelId ||
      binding.modelOption.supportsImages !== true
    ) {
      throw new BotCapabilityUnavailableError(
        "The companion vision binding does not match an image-capable selection.",
      );
    }
    return {
      selection: {
        providerId: access.visionModel.providerId,
        modelId: access.visionModel.modelId,
      },
      binding,
    };
  }

  auditBotInventory(botIds: readonly string[]): BotCapabilityPolicyAudit {
    if (botIds.length > BOT_CAPABILITY_LIMITS.bots) {
      throw new BotCapabilityUnavailableError("Bot inventory exceeds its limit.");
    }
    const authoritative = new Set<string>();
    for (const botId of botIds) {
      const safe = assertBotIdentity(botId, "bot");
      if (authoritative.has(safe)) {
        throw new BotCapabilityUnavailableError("Bot inventory contains duplicate identities.");
      }
      authoritative.add(safe);
    }
    const stored = new Set(this.state.policies.map(({ botId }) => botId));
    const missingBotIds = [...authoritative].filter((botId) => !stored.has(botId));
    const orphanedBotIds = [...stored].filter((botId) => !authoritative.has(botId));
    return {
      complete: missingBotIds.length === 0,
      missingBotIds,
      orphanedBotIds,
    };
  }

  getBotAuthorityStatus(botId: string): BotCapabilityAuthorityStatus {
    return this.policy(botId).authorityStatus;
  }

  assertBotAuthorityMatchesIdentity(input: { botId: string; archived: boolean }): void {
    const policy = this.policy(input.botId);
    const expected: BotCapabilityAuthorityStatus = input.archived ? "archived" : "active";
    if (policy.authorityStatus !== expected) {
      throw new BotCapabilityUnavailableError(
        "Bot identity and protected authority state do not match; access remains disabled for repair.",
      );
    }
  }

  private setBotAuthorityStatus(
    botId: string,
    authorityStatus: BotCapabilityAuthorityStatus,
  ): boolean {
    const policy = this.policy(botId);
    if (policy.authorityStatus === authorityStatus) return false;
    if (policy.policyEpoch >= Number.MAX_SAFE_INTEGER) {
      throw new Error("Bot capability policy epoch is exhausted.");
    }
    const timestamp = this.timestamp();
    const index = this.state.policies.indexOf(policy);
    this.state.policies[index] = {
      ...policy,
      authorityStatus,
      policyEpoch: policy.policyEpoch + 1,
      ...this.issueRevision("policy"),
      updatedAt: Math.max(policy.updatedAt, timestamp),
    };
    return true;
  }

  archiveBotAuthority(botId: string): boolean {
    return this.setBotAuthorityStatus(botId, "archived");
  }

  restoreBotAuthority(botId: string): boolean {
    return this.setBotAuthorityStatus(botId, "active");
  }

  /** Main-only strict clone; never return this through renderer or Remote projections. */
  getBotBinding(botId: string): BoundBotCustomSelection | undefined {
    const policy = this.policy(botId);
    return policy.accessMode === "custom"
      ? cloneBoundBotCustomSelection(policy.binding)
      : undefined;
  }

  /** Main-only durable provider/model authority for New/Edit Bot and runtime repair. */
  getBotModelAuthority(botId: string): StoredBotModelAuthority | undefined {
    return storedBotModelAuthority(this.policy(botId));
  }

  getBotVisionModelAuthority(botId: string): StoredBotModelAuthority | undefined {
    const authority = this.policy(botId).visionModel;
    return authority ? cloneStoredBotModelAuthority(authority) : undefined;
  }

  migrateLegacyBotsToFull(input: {
    botIds: readonly string[];
    archivedBotIds?: readonly string[];
    chats?: readonly { chatId: string; botId: string }[];
    catalogRevision: string;
    confirmedExplicitFull: true;
  }): BotAccessView[] {
    if (input.confirmedExplicitFull !== true) {
      throw new BotCapabilityUnavailableError("Legacy Bot migration must explicitly choose Full Access.");
    }
    const catalogRevision = assertBotRevision(input.catalogRevision, "catalog revision");
    const audit = this.auditBotInventory(input.botIds);
    const authoritativeBots = new Set(input.botIds.map((botId) => assertBotIdentity(botId, "bot")));
    const archivedBots = new Set(
      (input.archivedBotIds ?? []).map((botId) => assertBotIdentity(botId, "bot")),
    );
    if (
      archivedBots.size !== (input.archivedBotIds?.length ?? 0) ||
      [...archivedBots].some((botId) => !authoritativeBots.has(botId))
    ) {
      throw new BotCapabilityUnavailableError("Legacy archived Bot inventory is invalid.");
    }
    const authoritativeChats = new Map<string, string>();
    for (const entry of input.chats ?? []) {
      const chatId = assertBotIdentity(entry.chatId, "chat");
      const botId = assertBotIdentity(entry.botId, "bot");
      if (!authoritativeBots.has(botId) || authoritativeChats.has(chatId)) {
        throw new BotCapabilityUnavailableError("Legacy Bot chat inventory is invalid.");
      }
      authoritativeChats.set(chatId, botId);
    }
    const storedChats = new Map(this.state.chats.map((chat) => [chat.chatId, chat.botId] as const));
    const missingChats = [...authoritativeChats].filter(([chatId]) => !storedChats.has(chatId));
    const orphanedChats = [...storedChats].filter(([chatId]) => !authoritativeChats.has(chatId));
    const mismatchedChat = [...authoritativeChats].some(
      ([chatId, botId]) => storedChats.has(chatId) && storedChats.get(chatId) !== botId,
    );
    if (orphanedChats.length > 0 || mismatchedChat) {
      throw new BotCapabilityUnavailableError("Bot chat access inventory does not match chat storage.");
    }
    if (this.state.legacyMigration) {
      if (audit.missingBotIds.length > 0 || missingChats.length > 0) {
        throw new BotCapabilityUnavailableError("Legacy Bot migration is already sealed.");
      }
      for (const botId of input.botIds) {
        this.assertBotAuthorityMatchesIdentity({
          botId,
          archived: archivedBots.has(botId),
        });
      }
      return input.botIds.map((botId) => projectBotAccessView(this.state, botId));
    }
    const timestamp = this.timestamp();
    for (const botId of audit.missingBotIds) {
      const revision = this.issueRevision("policy");
      this.state.policies.push({
        botId,
        authorityStatus: archivedBots.has(botId) ? "archived" : "active",
        accessMode: "full",
        catalogRevision,
        policyEpoch: 1,
        ...revision,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    }
    if (this.state.chats.length + missingChats.length > BOT_CAPABILITY_LIMITS.chats) {
      throw new BotCapabilityUnavailableError("Bot chat access policy storage is at capacity.");
    }
    for (const [chatId, botId] of missingChats) {
      this.state.chats.push({
        chatId,
        botId,
        mode: "inherit",
        catalogRevision,
        policyEpoch: 1,
        ...this.issueRevision("chat"),
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    }
    this.state.legacyMigration = {
      completedAt: timestamp,
      ...this.issueRevision("migration"),
    };
    return input.botIds.map((botId) => projectBotAccessView(this.state, botId));
  }

  createBotPolicy(input: {
    botId: string;
    catalog: BotCapabilityCatalog;
    access: unknown;
    binding?: unknown;
    modelBinding?: unknown;
    visionModelBinding?: unknown;
  }): BotAccessView {
    const botId = assertBotIdentity(input.botId, "bot");
    if (this.state.policies.some((entry) => entry.botId === botId)) {
      throw new BotCapabilityUnavailableError("This Bot already has an access policy.");
    }
    if (this.state.policies.length >= BOT_CAPABILITY_LIMITS.bots) {
      throw new BotCapabilityUnavailableError("Bot access policy storage is at capacity.");
    }
    const access = parseBotAccessUpdate(input.access);
    this.assertCatalog(input.catalog, access.catalogRevision);
    if (access.accessMode === "custom") {
      validateSelectionAgainstCatalog(access.custom, input.catalog);
    }
    validateVisionSelectionAgainstCatalog(access.visionModel, input.catalog);
    const binding = this.bindingForCustomAccess(access, input.binding);
    const model = this.modelForFullAccess(access, input.modelBinding);
    const visionModel = this.visionModelForAccess(access, input.visionModelBinding);
    const timestamp = this.timestamp();
    const common: StoredBotPolicyBase = {
      botId,
      authorityStatus: "active",
      accessMode: undefined as never,
      catalogRevision: access.catalogRevision,
      policyEpoch: 1,
      ...this.issueRevision("policy"),
      createdAt: timestamp,
      updatedAt: timestamp,
      ...(visionModel ? { visionModel: cloneStoredBotModelAuthority(visionModel) } : {}),
    } as StoredBotPolicyBase;
    this.state.policies.push(
      access.accessMode === "custom"
        ? {
            ...common,
            accessMode: "custom",
            custom: cloneBotCustomSelection(access.custom),
            binding: cloneBoundBotCustomSelection(binding!),
          }
        : {
            ...common,
            accessMode: "full",
            ...(model ? { model: cloneStoredBotModelAuthority(model) } : {}),
          },
    );
    return projectBotAccessView(this.state, botId);
  }

  updateBotPolicy(input: {
    botId: string;
    expectedRevision: string;
    catalog: BotCapabilityCatalog;
    access: unknown;
    binding?: unknown;
    modelBinding?: unknown;
    visionModelBinding?: unknown;
    canonicalChatId?: string;
  }): BotPolicyUpdateResult {
    const policy = this.policy(input.botId);
    this.assertPolicyRevision(policy, input.expectedRevision);
    const access = parseBotAccessUpdate(input.access);
    this.assertCatalog(input.catalog, access.catalogRevision);
    if (access.accessMode === "custom") {
      validateSelectionAgainstCatalog(access.custom, input.catalog);
    }
    validateVisionSelectionAgainstCatalog(access.visionModel, input.catalog);
    const binding = this.bindingForCustomAccess(access, input.binding);
    const previousModel = storedBotModelAuthority(policy);
    const previousVisionModel = policy.visionModel;
    const fullModel = this.modelForFullAccess(access, input.modelBinding, policy);
    const nextModel = access.accessMode === "custom"
      ? {
          selection: {
            providerId: access.custom.providerId,
            modelId: access.custom.modelId,
          },
          binding: cloneBoundBotProviderModel(binding!.provider),
        }
      : fullModel;
    const nextVisionModel = this.visionModelForAccess(
      access,
      input.visionModelBinding,
      previousVisionModel,
    );
    const modelChanged =
      modelAuthorityFingerprint(previousModel) !== modelAuthorityFingerprint(nextModel);
    const visionModelChanged =
      modelAuthorityFingerprint(previousVisionModel) !==
        modelAuthorityFingerprint(nextVisionModel);
    const bindingChanged =
      policy.accessMode === "custom" &&
      access.accessMode === "custom" &&
      boundBotCustomSelectionFingerprint(policy.binding) !==
        boundBotCustomSelectionFingerprint(binding!);
    const narrowed = botPolicyTransitionNarrows(policy, access) || bindingChanged;
    const authorityChanged = narrowed || modelChanged || visionModelChanged;
    if (authorityChanged && policy.policyEpoch >= Number.MAX_SAFE_INTEGER) {
      throw new Error("Bot capability policy epoch is exhausted.");
    }
    const unchanged =
      policy.accessMode === access.accessMode &&
      policy.catalogRevision === access.catalogRevision &&
      !modelChanged &&
      !visionModelChanged &&
      (policy.accessMode === "full" ||
        (access.accessMode === "custom" &&
          botCustomSelectionsEqual(policy.custom, access.custom) &&
          !bindingChanged));
    if (unchanged) {
      return {
        view: projectBotAccessView(this.state, policy.botId),
        narrowed: false,
        authorityChanged: false,
        policyEpoch: policy.policyEpoch,
        narrowedChats: [],
      };
    }
    const timestamp = this.timestamp();
    const policyIndex = this.state.policies.indexOf(policy);
    const common: StoredBotPolicyBase = {
      botId: policy.botId,
      authorityStatus: policy.authorityStatus,
      accessMode: undefined as never,
      catalogRevision: access.catalogRevision,
      policyEpoch: authorityChanged ? policy.policyEpoch + 1 : policy.policyEpoch,
      ...this.issueRevision("policy"),
      createdAt: policy.createdAt,
      updatedAt: Math.max(policy.updatedAt, timestamp),
      ...(nextVisionModel
        ? { visionModel: cloneStoredBotModelAuthority(nextVisionModel) }
        : {}),
    } as StoredBotPolicyBase;
    const nextPolicy: StoredBotCapabilityPolicy =
      access.accessMode === "custom"
        ? {
            ...common,
            accessMode: "custom",
            custom: cloneBotCustomSelection(access.custom),
            binding: cloneBoundBotCustomSelection(binding!),
          }
        : {
            ...common,
            accessMode: "full",
            ...(fullModel ? { model: cloneStoredBotModelAuthority(fullModel) } : {}),
          };
    this.state.policies[policyIndex] = nextPolicy;

    const narrowedChats: Array<{ chatId: string; policyEpoch: number }> = [];
    if ((narrowed && nextPolicy.accessMode === "custom") || (modelChanged && nextModel)) {
      for (let index = 0; index < this.state.chats.length; index += 1) {
        const chat = this.state.chats[index]!;
        if (chat.botId !== policy.botId || chat.mode !== "custom") continue;
        if (input.canonicalChatId !== undefined && chat.chatId !== input.canonicalChatId) continue;
        const custom = narrowed && nextPolicy.accessMode === "custom"
          ? intersectBotCustomSelections(
              chat.custom,
              nextPolicy.custom,
              input.catalog.fileScopes,
            )
          : {
              ...cloneBotCustomSelection(chat.custom),
              providerId: nextModel!.selection.providerId,
              modelId: nextModel!.selection.modelId,
            };
        if (botCustomSelectionsEqual(custom, chat.custom)) continue;
        if (chat.policyEpoch >= Number.MAX_SAFE_INTEGER) {
          throw new Error("Bot chat capability policy epoch is exhausted.");
        }
        this.state.chats[index] = {
          ...chat,
          catalogRevision: access.catalogRevision,
          custom,
          policyEpoch: chat.policyEpoch + 1,
          ...this.issueRevision("chat"),
          updatedAt: Math.max(chat.updatedAt, timestamp),
        };
        narrowedChats.push({ chatId: chat.chatId, policyEpoch: chat.policyEpoch + 1 });
      }
    }
    return {
      view: projectBotAccessView(this.state, policy.botId),
      narrowed,
      authorityChanged,
      policyEpoch: nextPolicy.policyEpoch,
      narrowedChats,
    };
  }

  createChatPolicy(input: {
    chatId: string;
    botId: string;
    expectedBotPolicyRevision: string;
    catalog: BotCapabilityCatalog;
    custom?: unknown;
  }): BotChatAccessView {
    const chatId = assertBotIdentity(input.chatId, "chat");
    const policy = this.policy(input.botId);
    if (policy.authorityStatus !== "active") {
      throw new BotCapabilityUnavailableError("Archived Bots cannot create conversations.");
    }
    this.assertPolicyRevision(policy, input.expectedBotPolicyRevision);
    this.assertCatalog(input.catalog, input.catalog.revision);
    if (this.state.chats.some((entry) => entry.chatId === chatId)) {
      throw new BotCapabilityUnavailableError("This chat already has a Bot access policy.");
    }
    if (this.state.chats.length >= BOT_CAPABILITY_LIMITS.chats) {
      throw new BotCapabilityUnavailableError("Bot chat access policy storage is at capacity.");
    }
    const custom = input.custom === undefined ? undefined : parseBotCustomSelection(input.custom);
    if (custom) {
      validateSelectionAgainstCatalog(custom, input.catalog);
      if (
        policy.accessMode === "custom" &&
        !botCustomSelectionIsSubset(custom, policy.custom, input.catalog.fileScopes)
      ) {
        throw new BotCapabilitySubsetError();
      }
    }
    const timestamp = this.timestamp();
    const common: StoredBotChatPolicyBase = {
      chatId,
      botId: policy.botId,
      mode: undefined as never,
      catalogRevision: input.catalog.revision,
      policyEpoch: 1,
      ...this.issueRevision("chat"),
      createdAt: timestamp,
      updatedAt: timestamp,
    } as StoredBotChatPolicyBase;
    this.state.chats.push(
      custom
        ? { ...common, mode: "custom", custom: cloneBotCustomSelection(custom) }
        : { ...common, mode: "inherit" },
    );
    return projectBotChatAccessView(this.state, chatId);
  }

  updateChatPolicy(input: {
    chatId: string;
    expectedRevision: string;
    catalog: BotCapabilityCatalog;
    access: unknown;
  }): BotChatPolicyUpdateResult {
    const chat = this.chat(input.chatId);
    this.assertChatRevision(chat, input.expectedRevision);
    const policy = this.policy(chat.botId);
    const access = parseBotChatAccessUpdate(input.access);
    this.assertCatalog(input.catalog, access.catalogRevision);
    this.assertPolicyRevision(policy, access.expectedBotPolicyRevision);
    if (access.mode === "custom") {
      validateSelectionAgainstCatalog(access.custom, input.catalog);
      const model = storedBotModelAuthority(policy);
      if (
        model &&
        (access.custom.providerId !== model.selection.providerId ||
          access.custom.modelId !== model.selection.modelId)
      ) {
        throw new BotCapabilitySubsetError();
      }
      if (
        policy.accessMode === "custom" &&
        !botCustomSelectionIsSubset(access.custom, policy.custom, input.catalog.fileScopes)
      ) {
        throw new BotCapabilitySubsetError();
      }
    }
    const narrowed = botChatTransitionNarrows(chat, access);
    if (narrowed && chat.policyEpoch >= Number.MAX_SAFE_INTEGER) {
      throw new Error("Bot chat capability policy epoch is exhausted.");
    }
    const unchanged =
      chat.mode === access.mode &&
      chat.catalogRevision === access.catalogRevision &&
      (chat.mode === "inherit" ||
        (access.mode === "custom" && botCustomSelectionsEqual(chat.custom, access.custom)));
    if (unchanged) {
      return {
        view: projectBotChatAccessView(this.state, chat.chatId),
        narrowed: false,
        policyEpoch: chat.policyEpoch,
      };
    }
    const timestamp = this.timestamp();
    const common: StoredBotChatPolicyBase = {
      chatId: chat.chatId,
      botId: chat.botId,
      mode: undefined as never,
      catalogRevision: access.catalogRevision,
      policyEpoch: narrowed ? chat.policyEpoch + 1 : chat.policyEpoch,
      ...this.issueRevision("chat"),
      createdAt: chat.createdAt,
      updatedAt: Math.max(chat.updatedAt, timestamp),
    } as StoredBotChatPolicyBase;
    this.state.chats[this.state.chats.indexOf(chat)] =
      access.mode === "custom"
        ? { ...common, mode: "custom", custom: cloneBotCustomSelection(access.custom) }
        : { ...common, mode: "inherit" };
    return {
      view: projectBotChatAccessView(this.state, chat.chatId),
      narrowed,
      policyEpoch: narrowed ? chat.policyEpoch + 1 : chat.policyEpoch,
    };
  }

  copyChatPolicy(input: {
    sourceChatId: string;
    targetChatId: string;
    botId: string;
  }): BotChatAccessView {
    const source = this.chat(input.sourceChatId);
    const botId = assertBotIdentity(input.botId, "bot");
    if (this.policy(botId).authorityStatus !== "active") {
      throw new BotCapabilityUnavailableError("Archived Bots cannot copy conversations.");
    }
    const targetChatId = assertBotIdentity(input.targetChatId, "chat");
    if (source.botId !== botId) throw new BotCapabilityUnavailableError();
    if (this.state.chats.some((entry) => entry.chatId === targetChatId)) {
      throw new BotCapabilityUnavailableError("The copied chat already has an access policy.");
    }
    if (this.state.chats.length >= BOT_CAPABILITY_LIMITS.chats) {
      throw new BotCapabilityUnavailableError("Bot chat access policy storage is at capacity.");
    }
    const timestamp = this.timestamp();
    const common: StoredBotChatPolicyBase = {
      chatId: targetChatId,
      botId,
      mode: undefined as never,
      catalogRevision: source.catalogRevision,
      policyEpoch: 1,
      ...this.issueRevision("chat"),
      createdAt: timestamp,
      updatedAt: timestamp,
    } as StoredBotChatPolicyBase;
    this.state.chats.push(
      source.mode === "custom"
        ? { ...common, mode: "custom", custom: cloneBotCustomSelection(source.custom) }
        : { ...common, mode: "inherit" },
    );
    return projectBotChatAccessView(this.state, targetChatId);
  }

  deleteChatPolicy(input: { chatId: string; botId: string }): boolean {
    const chatId = assertBotIdentity(input.chatId, "chat");
    const botId = assertBotIdentity(input.botId, "bot");
    const index = this.state.chats.findIndex((entry) => entry.chatId === chatId);
    if (index < 0) return false;
    if (this.state.chats[index]!.botId !== botId) throw new BotCapabilityUnavailableError();
    this.state.chats.splice(index, 1);
    this.issueDeletionCommit();
    return true;
  }

  /**
   * Create-journal compensation only. Once identity commits, policy deletion is
   * forbidden; archive and ordinary delete retain the explicit policy.
   */
  rollbackUncommittedBotPolicy(input: {
    botId: string;
    identityCommitted: false;
  }): boolean {
    if (input.identityCommitted !== false) {
      throw new BotCapabilityUnavailableError(
        "A committed Bot identity cannot hard-delete its access policy.",
      );
    }
    const botId = assertBotIdentity(input.botId, "bot");
    const index = this.state.policies.findIndex((entry) => entry.botId === botId);
    if (index < 0) return false;
    this.state.policies.splice(index, 1);
    this.state.chats = this.state.chats.filter((entry) => entry.botId !== botId);
    this.issueDeletionCommit();
    return true;
  }

  reconcileIncarnationNamespace(
    namespace: BotCapabilityIncarnationNamespace,
    resources: readonly BotCapabilityIncarnationInput[],
    options: BotCapabilityIncarnationReconcileOptions = {},
  ): readonly BotCapabilityIncarnation[] {
    if (!(["provider", "mcp", "skill"] as const).includes(namespace)) {
      throw new BotCapabilityUnavailableError("Bot capability incarnation namespace is invalid.");
    }
    if (resources.length > MAX_INCARNATIONS_PER_NAMESPACE) {
      throw new BotCapabilityUnavailableError("Bot capability incarnation request exceeds its bound.");
    }
    const partition = options.partition ?? "global";
    if (!INCARNATION_ID.test(partition)) {
      throw new BotCapabilityUnavailableError("Bot capability incarnation partition is invalid.");
    }
    const seen = new Set<string>();
    for (const resource of resources) {
      if (
        !INCARNATION_ID.test(resource.sourceId) ||
        !EXACT_HASH.test(resource.credentialSignature) ||
        seen.has(resource.sourceId)
      ) {
        throw new BotCapabilityUnavailableError(
          "Bot capability incarnation request contains an invalid resource.",
        );
      }
      seen.add(resource.sourceId);
    }

    const entries = this.state.incarnations[namespace];
    const partitionEntries = entries.filter((entry) => entry.partition === partition);
    const byId = new Map(partitionEntries.map((entry) => [entry.sourceId, entry] as const));
    const previouslyPresent = new Map(
      partitionEntries.map((entry) => [entry.sourceId, entry.present] as const),
    );
    let changed = false;
    const result = resources.map((resource) => {
      let entry = byId.get(resource.sourceId);
      if (!entry) {
        if (entries.length >= MAX_INCARNATIONS_PER_NAMESPACE) {
          throw new BotCapabilityUnavailableError(
            "Bot capability incarnation storage is at capacity.",
          );
        }
        entry = {
          partition,
          sourceId: resource.sourceId,
          resourceIncarnation: this.mintIncarnation(),
          credentialSignature: resource.credentialSignature,
          credentialIncarnation: this.mintIncarnation(),
          present: true,
        };
        entries.push(entry);
        byId.set(entry.sourceId, entry);
        changed = true;
      } else {
        if (previouslyPresent.get(entry.sourceId) === false) {
          entry.resourceIncarnation = this.mintIncarnation();
          entry.credentialIncarnation = this.mintIncarnation();
          changed = true;
        } else if (entry.credentialSignature !== resource.credentialSignature) {
          entry.credentialIncarnation = this.mintIncarnation();
          changed = true;
        }
        if (entry.credentialSignature !== resource.credentialSignature || !entry.present) {
          changed = true;
        }
        entry.credentialSignature = resource.credentialSignature;
        entry.present = true;
      }
      return {
        sourceId: entry.sourceId,
        resourceIncarnation: entry.resourceIncarnation,
        credentialIncarnation: entry.credentialIncarnation,
      };
    });
    for (const entry of partitionEntries) {
      const present = seen.has(entry.sourceId);
      if (entry.present !== present) changed = true;
      entry.present = present;
    }
    if (changed) {
      entries.sort((left, right) => {
        const leftKey = `${left.partition}\0${left.sourceId}`;
        const rightKey = `${right.partition}\0${right.sourceId}`;
        return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
      });
      this.issueDeletionCommit();
    }
    return result;
  }

  acknowledgeNotice(audienceId: string, value: unknown): BotNoticeStatus {
    const safeAudienceId = assertNoticeAudience(audienceId);
    const acknowledgement: BotNoticeAcknowledgement = parseBotNoticeAcknowledgement(value);
    const existing = this.state.notices.find((entry) => entry.audienceId === safeAudienceId);
    if (existing) {
      if (existing.decision !== acknowledgement.decision) {
        if (
          existing.decision !== "customize_first" ||
          acknowledgement.decision !== "continue_full"
        ) {
          throw new BotCapabilityRevisionConflictError(existing.revision);
        }
        existing.decision = "continue_full";
        existing.acceptedAt = this.timestamp();
        Object.assign(existing, this.issueRevision("notice"));
      }
      return projectBotNoticeStatus(this.state, safeAudienceId);
    }
    if (this.state.notices.length >= BOT_CAPABILITY_LIMITS.noticeAudiences) {
      throw new BotCapabilityUnavailableError("Bot access notice storage is at capacity.");
    }
    this.state.notices.push({
      audienceId: safeAudienceId,
      version: BOT_FULL_ACCESS_NOTICE_VERSION,
      decision: acknowledgement.decision,
      acceptedAt: this.timestamp(),
      ...this.issueRevision("notice"),
    });
    return projectBotNoticeStatus(this.state, safeAudienceId);
  }

  revokeNoticeAudience(audienceId: string): boolean {
    const safeAudienceId = assertNoticeAudience(audienceId);
    const index = this.state.notices.findIndex((entry) => entry.audienceId === safeAudienceId);
    if (index < 0) return false;
    this.state.notices.splice(index, 1);
    this.issueDeletionCommit();
    return true;
  }

  assertBotMayAct(input: { audienceId: string; botId: string; chatId?: string }): {
    policy: StoredBotCapabilityPolicy;
    chat?: StoredBotChatCapabilityPolicy;
    effectiveCustom?: BotCustomSelection;
  } {
    const audienceId = assertNoticeAudience(input.audienceId);
    const notice = this.state.notices.find((entry) => entry.audienceId === audienceId);
    if (!notice) {
      throw new BotCapabilityNoticeRequiredError();
    }
    const policy = this.policy(input.botId);
    if (policy.authorityStatus !== "active") {
      throw new BotCapabilityUnavailableError("This Bot is archived and cannot act.");
    }
    if (!input.chatId) {
      if (notice.decision !== "continue_full" && policy.accessMode === "full") {
        throw new BotCapabilityNoticeRequiredError();
      }
      return policy.accessMode === "custom"
        ? { policy: clonePolicy(policy), effectiveCustom: cloneBotCustomSelection(policy.custom) }
        : { policy: clonePolicy(policy) };
    }
    const chat = this.chat(input.chatId);
    if (chat.botId !== policy.botId) throw new BotCapabilityUnavailableError();
    const effectiveCustom =
      chat.mode === "custom"
        ? chat.custom
        : policy.accessMode === "custom"
          ? policy.custom
          : undefined;
    if (notice.decision !== "continue_full" && !effectiveCustom) {
      throw new BotCapabilityNoticeRequiredError();
    }
    return {
      policy: clonePolicy(policy),
      chat: cloneChatPolicy(chat),
      ...(effectiveCustom ? { effectiveCustom: cloneBotCustomSelection(effectiveCustom) } : {}),
    };
  }

  /** Fail closed on exact binding/catalog drift before the resolver assembles tools. */
  assertAuthorityBindingsCurrent(input: {
    botId: string;
    chatId?: string;
    snapshot: BotCapabilityCatalogSnapshot;
  }): BoundBotCustomSelection | undefined {
    const policy = this.policy(input.botId);
    const model = storedBotModelAuthority(policy);
    if (model) {
      assertBoundBotProviderModelCurrent(model.binding, input.snapshot);
    }
    if (policy.visionModel) {
      assertBoundBotProviderModelCurrent(policy.visionModel.binding, input.snapshot);
    }
    if (policy.accessMode === "custom") {
      assertBoundBotCustomSelectionCurrent(policy.binding, input.snapshot);
    }
    if (input.chatId) {
      const chat = this.chat(input.chatId);
      if (chat.botId !== policy.botId) throw new BotCapabilityUnavailableError();
      if (chat.mode === "custom") {
        validateSelectionAgainstCatalog(chat.custom, input.snapshot.catalog);
      }
    }
    return policy.accessMode === "custom"
      ? cloneBoundBotCustomSelection(policy.binding)
      : undefined;
  }

  /**
   * Main-only read authority for immutable history and managed-home reads.
   * Unlike turn admission this deliberately ignores notice state and mints no
   * effect lease, so its caller must serialize the complete read with Bot
   * lifecycle/policy mutations and independently fence live inventory.
   */
  inspectArchivedReadAuthority(
    botId: string,
    chatId: string,
  ): BotArchivedReadAuthoritySnapshot {
    const policy = this.policy(botId);
    if (policy.authorityStatus !== "archived") {
      throw new BotCapabilityUnavailableError("This Bot is not archived.");
    }
    const chat = this.chat(chatId);
    if (chat.botId !== policy.botId) throw new BotCapabilityUnavailableError();
    const effectiveCustom = chat.mode === "custom"
      ? chat.custom
      : policy.accessMode === "custom"
        ? policy.custom
        : undefined;
    return {
      policy: clonePolicy(policy),
      chat: cloneChatPolicy(chat),
      ...(effectiveCustom ? { effectiveCustom: cloneBotCustomSelection(effectiveCustom) } : {}),
    };
  }
}

export function isSafeBotCapabilityState(value: unknown): boolean {
  try {
    parseBotCapabilityState(value);
    return true;
  } catch {
    return false;
  }
}

export function isSafeBotCapabilityRevisionToken(value: unknown): value is string {
  return isPathSafeBotCapabilityId(value, BOT_CAPABILITY_LIMITS.revisionChars);
}
