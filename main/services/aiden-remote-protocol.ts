import { parseGenerationTimeline } from "../../renderer/shared/generation-timeline.js";
import type { AidenRemoteChatProjection } from "./aiden-remote-chats.js";

export const AIDEN_REMOTE_PROTOCOL_VERSION = 1 as const;
export const AIDEN_REMOTE_BASE_PATH = "/api/aiden/v1" as const;
export const AIDEN_REMOTE_MAX_SSE_FRAME_BYTES = 1_048_576;
export const AIDEN_REMOTE_MAX_JSON_RESPONSE_BYTES = 1_048_576;
export const AIDEN_REMOTE_MAX_CHAT_MESSAGES = 10_000;
export const AIDEN_REMOTE_BOT_ACCESS_NOTICE_VERSION = "bot-full-access-v1" as const;

const AIDEN_REMOTE_MAX_IDENTIFIER_LENGTH = 128;
const AIDEN_REMOTE_MAX_ENDPOINT_UTF8_BYTES = 2_048;
const AIDEN_REMOTE_MAX_ENDPOINT_PORT = 65_535;
const AIDEN_REMOTE_MAX_JSON_NESTING_DEPTH = 128;
const AIDEN_REMOTE_MAX_JSON_OBJECT_KEYS = 16_384;

export const AIDEN_REMOTE_LEGACY_CAPABILITIES = [
  "server:read",
  "chat:read",
  "chat:write",
  "approval:respond",
  "workspace:read",
  "workspace:browse",
  "workspace:manage",
  "files:read",
  "files:write",
  "git:read",
  "git:write",
  "schedule:read",
  "schedule:write",
] as const;

export const AIDEN_REMOTE_BOT_CAPABILITIES = [
  "bot:read",
  "bot:write",
] as const;

export const AIDEN_REMOTE_CAPABILITIES = [
  ...AIDEN_REMOTE_LEGACY_CAPABILITIES,
  ...AIDEN_REMOTE_BOT_CAPABILITIES,
] as const;

export type AidenRemoteCapability = (typeof AIDEN_REMOTE_CAPABILITIES)[number];

export const AIDEN_REMOTE_EVENT_TYPES = [
  "snapshot",
  "status",
  "text_delta",
  "reasoning_delta",
  "tool_started",
  "tool_finished",
  "timeline",
  "approval_required",
  "done",
  "error",
  "cancelled",
  "heartbeat",
] as const;

export type AidenRemoteEventType = (typeof AIDEN_REMOTE_EVENT_TYPES)[number];
export type AidenRemoteTerminalEventType = "done" | "error" | "cancelled";

export const AIDEN_REMOTE_ERROR_CODES = [
  "invalid_request",
  "payload_too_large",
  "rate_limited",
  "authentication_required",
  "credential_revoked",
  "capability_denied",
  "pairing_closed",
  "pairing_expired",
  "pairing_already_used",
  "server_identity_changed",
  "not_found",
  "already_exists",
  "revision_conflict",
  "idempotency_conflict",
  "idempotency_capacity",
  "idempotency_in_flight",
  "bot_archived",
  "workspace_unavailable",
  "workspace_changing",
  "permission_confirmation_required",
  "handle_invalid",
  "handle_expired",
  "handle_wrong_device",
  "root_policy_changed",
  "filesystem_identity_changed",
  "path_outside_root",
  "handle_capacity",
  "turn_already_active",
  "stream_gone",
  "approval_already_resolved",
  "approval_expired",
  "operation_in_progress",
  "operation_stale",
  "git_capability_denied",
  "schedule_disabled",
  "schedule_run_in_progress",
  "server_interrupted",
  "internal_error",
] as const;

export type AidenRemoteErrorCode = (typeof AIDEN_REMOTE_ERROR_CODES)[number];

export interface AidenRemoteErrorEnvelope {
  error: {
    code: AidenRemoteErrorCode;
    message: string;
    requestId: string;
    retryable: boolean;
    details?: {
      currentRevision?: string;
      retryAfterSeconds?: number;
      chatId?: string;
      minimumClientVersion?: string;
      limit?: number;
      field?: string;
    };
  };
}

export interface AidenRemoteStreamEvent {
  protocolVersion: typeof AIDEN_REMOTE_PROTOCOL_VERSION;
  streamId: string;
  sequence: number;
  timestamp: string;
  type: AidenRemoteEventType;
  terminal: boolean;
  payload: Record<string, unknown>;
}

export const AIDEN_REMOTE_BOT_HEALTH_STATES = [
  "ready",
  "degraded",
  "unavailable",
  "archived",
] as const;

export type AidenRemoteBotHealth = (typeof AIDEN_REMOTE_BOT_HEALTH_STATES)[number];

export const AIDEN_REMOTE_BOT_LEGACY_AVATARS = [
  "spark",
  "orbit",
  "leaf",
  "prism",
  "wave",
  "ember",
] as const;

export type AidenRemoteBotLegacyAvatar =
  (typeof AIDEN_REMOTE_BOT_LEGACY_AVATARS)[number];

export interface AidenRemoteBotAvatarRecipe {
  version: 1;
  shape: "wisp" | "orb" | "drop" | "hex" | "cloud" | "peak" | "squircle" | "capsule";
  color: "lilac" | "sky" | "mint" | "sun" | "periwinkle" | "coral" | "peach" | "aqua";
  eyes: "dots" | "wide" | "happy" | "sleepy" | "focus" | "wink";
  detail: "none" | "halo" | "orbit" | "sparkles" | "antenna" | "bolts";
}

export type AidenRemoteBotSemanticAvatar =
  | AidenRemoteBotLegacyAvatar
  | AidenRemoteBotAvatarRecipe;

export interface AidenRemoteBotAvatarAsset {
  assetRevision: string;
  mimeType: "image/png";
  width: 512;
  height: 512;
  byteSize: number;
}

export interface AidenRemoteBotAvatarView {
  semantic: AidenRemoteBotSemanticAvatar;
  asset?: AidenRemoteBotAvatarAsset;
}

export interface AidenRemoteBotSummaryBase {
  id: string;
  name: string;
  purpose: string;
  avatar: AidenRemoteBotAvatarView;
  createdAt: string;
  updatedAt: string;
  revision: string;
}

export type AidenRemoteBotSummary = AidenRemoteBotSummaryBase & (
  | { health: "archived"; archivedAt: string }
  | { health: "ready" | "degraded" | "unavailable"; archivedAt?: never }
);

export interface AidenRemoteBotCustomSelection {
  fileScopeIds: string[];
  shellEnabled: boolean;
  connectionIds: string[];
  skillIds: string[];
  otherCapabilityIds: string[];
  providerId: string;
  modelId: string;
}

export interface AidenRemoteBotAccessViewBase {
  botId: string;
  revision: string;
  policyEpoch: string;
  summary: string;
}

export type AidenRemoteBotAccessView = AidenRemoteBotAccessViewBase & (
  | { accessMode: "full"; custom?: never }
  | { accessMode: "custom"; custom: AidenRemoteBotCustomSelection }
);

export type AidenRemoteBotDetail = AidenRemoteBotSummary & {
  instructions: string;
  access: AidenRemoteBotAccessView;
  openingGreeting?: string;
};

export interface AidenRemoteBotList {
  bots: AidenRemoteBotSummary[];
  maxBots: number;
  favorites: AidenRemoteBotFavoritesView;
}

export interface AidenRemoteBotCreateRequest {
  name: string;
  purpose: string;
  instructions: string;
  avatar: AidenRemoteBotSemanticAvatar;
  access: AidenRemoteBotAccessUpdateRequest;
  openingGreeting?: string;
}

export interface AidenRemoteBotIdentityPatchRequest {
  name?: string;
  purpose?: string;
  instructions?: string;
  avatar?: AidenRemoteBotSemanticAvatar;
  /** An empty string explicitly clears the greeting. JSON null is invalid. */
  openingGreeting?: string;
}

export interface AidenRemoteBotConversationItemBase {
  chatId: string;
  botId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  revision: string;
  preview?: string;
}

export type AidenRemoteBotConversationItem = AidenRemoteBotConversationItemBase & (
  | {
      activityState: "waiting_for_approval";
      canRespondToApproval: boolean;
    }
  | {
      activityState: "idle" | "queued" | "running" | "reconciling";
      canRespondToApproval: false;
    }
);

export interface AidenRemoteBotConversationPage {
  conversations: AidenRemoteBotConversationItem[];
  nextCursor?: string;
}

export interface AidenRemoteBotConversationQuery {
  cursor?: string;
  query?: string;
  botId?: string;
  limit?: number;
}

export type AidenRemoteBotChatCreateRequest =
  | { providerId?: never; modelId?: never }
  | { providerId: string; modelId: string };

export interface AidenRemoteBotCapabilityOption {
  id: string;
  label: string;
  available: boolean;
  description?: string;
}

export interface AidenRemoteBotFileScopeOption extends AidenRemoteBotCapabilityOption {
  kind: "full_mac" | "bot_home" | "approved_location";
}

export interface AidenRemoteBotModelOption {
  id: string;
  label: string;
  available: boolean;
}

export interface AidenRemoteBotProviderOption {
  id: string;
  label: string;
  available: boolean;
  models: AidenRemoteBotModelOption[];
}

export type AidenRemoteBotNoticeDecision = "continue_full" | "customize_first";

export interface AidenRemoteBotAccessNoticeStatusBase {
  version: typeof AIDEN_REMOTE_BOT_ACCESS_NOTICE_VERSION;
}

export type AidenRemoteBotAccessNoticeStatus = AidenRemoteBotAccessNoticeStatusBase & (
  | {
      requiresAcknowledgement: true;
      acceptedAt?: never;
      acceptedDecision?: never;
    }
  | {
      requiresAcknowledgement: false;
      acceptedAt: string;
      acceptedDecision: AidenRemoteBotNoticeDecision;
    }
);

export interface AidenRemoteBotCapabilityCatalog {
  revision: string;
  providers: AidenRemoteBotProviderOption[];
  fileScopes: AidenRemoteBotFileScopeOption[];
  shellAvailable: boolean;
  connections: AidenRemoteBotCapabilityOption[];
  skills: AidenRemoteBotCapabilityOption[];
  otherCapabilities: AidenRemoteBotCapabilityOption[];
  notice: AidenRemoteBotAccessNoticeStatus;
}

export type AidenRemoteBotAccessUpdateRequest =
  | {
      accessMode: "full";
      catalogRevision: string;
      confirmedForeground: true;
    }
  | {
      accessMode: "custom";
      catalogRevision: string;
      custom: AidenRemoteBotCustomSelection;
    };

export interface AidenRemoteBotChatAccessViewBase {
  chatId: string;
  botId: string;
  revision: string;
  botPolicyRevision: string;
  summary: string;
}

export type AidenRemoteBotChatAccessView = AidenRemoteBotChatAccessViewBase & (
  | { mode: "inherit"; custom?: never }
  | { mode: "custom"; custom: AidenRemoteBotCustomSelection }
);

export type AidenRemoteBotChatAccessUpdateRequest =
  | {
      mode: "inherit";
      catalogRevision: string;
      expectedBotPolicyRevision: string;
    }
  | {
      mode: "custom";
      catalogRevision: string;
      expectedBotPolicyRevision: string;
      custom: AidenRemoteBotCustomSelection;
    };

export interface AidenRemoteBotFavoritesView {
  botIds: string[];
  revision: string;
}

export interface AidenRemoteBotFavoritesUpdateRequest {
  botIds: string[];
}

export interface AidenRemoteBotNoticeAcknowledgementRequest {
  version: typeof AIDEN_REMOTE_BOT_ACCESS_NOTICE_VERSION;
  decision: AidenRemoteBotNoticeDecision;
  confirmedForeground: true;
}

export interface AidenRemoteBotAvatarUploadRequest {
  mimeType: "image/png" | "image/jpeg";
  data: string;
}

export interface AidenRemoteBotCreateFixture {
  request: AidenRemoteBotCreateRequest;
  response: AidenRemoteBotDetail;
}

export interface AidenRemoteBotIdentityFixture {
  request: AidenRemoteBotIdentityPatchRequest;
  response: AidenRemoteBotDetail;
}

export interface AidenRemoteBotChatCreateFixture {
  request: AidenRemoteBotChatCreateRequest;
  response: AidenRemoteChatProjection;
}

export interface AidenRemoteBotPolicyUpdateFixture {
  request: AidenRemoteBotAccessUpdateRequest;
  response: AidenRemoteBotAccessView;
}

export interface AidenRemoteBotChatSubsetUpdateFixture {
  request: AidenRemoteBotChatAccessUpdateRequest;
  response: AidenRemoteBotChatAccessView;
}

export interface AidenRemoteBotFavoritesUpdateFixture {
  request: AidenRemoteBotFavoritesUpdateRequest;
  response: AidenRemoteBotFavoritesView;
}

export interface AidenRemoteBotNoticeAcknowledgementFixture {
  request: AidenRemoteBotNoticeAcknowledgementRequest;
  response: AidenRemoteBotAccessNoticeStatus;
}

export interface AidenRemoteBotAvatarUploadFixture {
  request: AidenRemoteBotAvatarUploadRequest;
  response: AidenRemoteBotAvatarAsset;
}

export interface AidenRemoteLegacyNonNegotiatingFixture {
  pairingExchange: {
    protocolVersion: typeof AIDEN_REMOTE_PROTOCOL_VERSION;
    instanceId: string;
    deviceId: string;
    credential: string;
    capabilities: (typeof AIDEN_REMOTE_LEGACY_CAPABILITIES)[number][];
    displayName?: string;
    endpoint: string;
    serverSpkiSha256: string;
  };
  server: {
    protocolVersion: typeof AIDEN_REMOTE_PROTOCOL_VERSION;
    instanceId: string;
    name: string;
    appVersion: string;
    capabilities: (typeof AIDEN_REMOTE_LEGACY_CAPABILITIES)[number][];
    connectionMode: "lan" | "tailscale" | "both";
    minimumClientVersion?: string;
    serverTime: string;
  };
}

export interface AidenRemoteContractFixture {
  contractRevision: number;
  protocolVersion: typeof AIDEN_REMOTE_PROTOCOL_VERSION;
  generated: false;
  notice: string;
  capabilities: AidenRemoteCapability[];
  health: { ok: true; protocolVersion: typeof AIDEN_REMOTE_PROTOCOL_VERSION };
  pairingBootstrap: {
    protocolVersion: typeof AIDEN_REMOTE_PROTOCOL_VERSION;
    instanceId: string;
    endpoint: string;
    serverSpkiSha256: string;
    secret: string;
    expiresAt: string;
  };
  pairingExchange: {
    protocolVersion: typeof AIDEN_REMOTE_PROTOCOL_VERSION;
    instanceId: string;
    deviceId: string;
    credential: string;
    capabilities: AidenRemoteCapability[];
    displayName: string;
    endpoint: string;
    serverSpkiSha256: string;
  };
  server: {
    protocolVersion: typeof AIDEN_REMOTE_PROTOCOL_VERSION;
    instanceId: string;
    name: string;
    appVersion: string;
    capabilities: AidenRemoteCapability[];
    serverCapabilities: AidenRemoteCapability[];
    connectionMode: "lan" | "tailscale" | "both";
    minimumClientVersion?: string;
    serverTime: string;
  };
  workspaces: unknown;
  browser: unknown;
  chat: AidenRemoteChatProjection;
  turnStart: unknown;
  streamStatus: unknown;
  streamApproval: unknown;
  events: AidenRemoteStreamEvent[];
  fileIndex: unknown;
  fileDocument: unknown;
  git: unknown;
  scheduledTask: unknown;
  scheduleSettings: unknown;
  scheduleRunAccepted: unknown;
  scheduleRun: unknown;
  botSummary: AidenRemoteBotSummary;
  botList: AidenRemoteBotList;
  botDetail: AidenRemoteBotDetail;
  botAvatar: AidenRemoteBotAvatarView;
  botCreate: AidenRemoteBotCreateFixture;
  botIdentity: AidenRemoteBotIdentityFixture;
  botArchive: AidenRemoteBotDetail;
  botRestore: AidenRemoteBotDetail;
  botConversation: AidenRemoteBotConversationItem;
  botConversations: AidenRemoteBotConversationPage;
  botConversationQuery: AidenRemoteBotConversationQuery;
  botChatCreate: AidenRemoteBotChatCreateFixture;
  botCapabilityCatalog: AidenRemoteBotCapabilityCatalog;
  botPolicy: AidenRemoteBotAccessView;
  botPolicyUpdate: AidenRemoteBotPolicyUpdateFixture;
  botChatSubset: AidenRemoteBotChatAccessView;
  botChatSubsetUpdate: AidenRemoteBotChatSubsetUpdateFixture;
  botFavorites: AidenRemoteBotFavoritesView;
  botFavoritesUpdate: AidenRemoteBotFavoritesUpdateFixture;
  botNotice: AidenRemoteBotAccessNoticeStatus;
  botNoticeAcknowledgement: AidenRemoteBotNoticeAcknowledgementFixture;
  botAvatarUpload: AidenRemoteBotAvatarUploadFixture;
  botAvatarMetadata: AidenRemoteBotAvatarAsset;
  legacyNonNegotiating: AidenRemoteLegacyNonNegotiatingFixture;
  error: AidenRemoteErrorEnvelope;
}

export const AIDEN_REMOTE_FORBIDDEN_WIRE_KEYS = new Set([
  "authorization",
  "credentialDigest",
  "providerFingerprint",
  "mcpServerBindings",
  "folderPath",
  "repositoryPath",
  "worktreePath",
  "worktreeGitDir",
  "ownershipToken",
  "worktreeDevice",
  "worktreeInode",
  "createdFromHead",
  "canonicalPath",
  "absolutePath",
  "scriptPath",
  "managedHomePath",
  "managedWorkspacePath",
  "workspacePath",
  "botHomePath",
  "systemPrompt",
  "skillContent",
  "skillContents",
  "skillPath",
  "skillPaths",
  "providerCredential",
  "mcpCredential",
  "connectionCredential",
  "authorizationHeader",
  "providerHeaders",
  "mcpHeaders",
  "connectionHeaders",
  "providerApiKey",
  "mcpApiKey",
  "connectionApiKey",
  "credentialMaterial",
  "assetFilename",
  "avatarAssetFilename",
  "temporaryAssetURL",
  "temporaryURL",
  "environment",
  "stdout",
  "stderr",
]);

const AIDEN_REMOTE_PRIVATE_BOT_WIRE_KEYS = new Set([
  "credential",
  "credentials",
  "secret",
  "secrets",
  "apikey",
  "token",
  "accesstoken",
  "refreshtoken",
  "header",
  "headers",
  "endpoint",
  "path",
  "prompt",
  "instructions",
  "openinggreeting",
  "argument",
  "arguments",
  "args",
  "toolargument",
  "toolarguments",
  "toolargs",
  "result",
  "results",
  "toolresult",
  "toolresults",
  "reasoning",
  "reasoningcontent",
]);

const AIDEN_REMOTE_PRIVATE_BOT_FIXTURE_ROOTS = new Set([
  "chat",
  "botSummary",
  "botList",
  "botDetail",
  "botAvatar",
  "botCreate",
  "botIdentity",
  "botArchive",
  "botRestore",
  "botConversation",
  "botConversations",
  "botConversationQuery",
  "botChatCreate",
  "botCapabilityCatalog",
  "botPolicy",
  "botPolicyUpdate",
  "botChatSubset",
  "botChatSubsetUpdate",
  "botFavorites",
  "botFavoritesUpdate",
  "botNotice",
  "botNoticeAcknowledgement",
  "botAvatarUpload",
  "botAvatarMetadata",
]);

function normalizedPrivateWireKey(key: string): string {
  return key.replace(/[-_.\s]/gu, "").toLocaleLowerCase("en-US");
}

function isPrivateBotWireKey(key: string): boolean {
  const normalized = normalizedPrivateWireKey(key);
  return (
    AIDEN_REMOTE_PRIVATE_BOT_WIRE_KEYS.has(normalized) ||
    [...AIDEN_REMOTE_FORBIDDEN_WIRE_KEYS].some(
      (forbidden) => normalizedPrivateWireKey(forbidden) === normalized,
    )
  );
}

function isAllowedBotIdentityField(root: string, path: readonly string[]): boolean {
  const key = path[path.length - 1];
  if (key !== "instructions" && key !== "openingGreeting") return false;
  if (["botDetail", "botArchive", "botRestore"].includes(root)) {
    return path.length === 1;
  }
  if (root === "botCreate" || root === "botIdentity") {
    return path.length === 2 && (path[0] === "request" || path[0] === "response");
  }
  return false;
}

function assertNoPrivateBotWireFields(value: unknown): void {
  if (!isRecord(value)) return;
  const visit = (current: unknown, root: string, path: readonly string[]): void => {
    if (Array.isArray(current)) {
      for (const entry of current) visit(entry, root, [...path, "[]"]);
      return;
    }
    if (!isRecord(current)) return;
    for (const [key, child] of Object.entries(current)) {
      const childPath = [...path, key];
      if (
        isPrivateBotWireKey(key) &&
        !isAllowedBotIdentityField(root, childPath)
      ) {
        throw new Error(`Forbidden private Bot wire key ${key} at ${root}.${childPath.join(".")}.`);
      }
      visit(child, root, childPath);
    }
  };
  for (const [root, child] of Object.entries(value)) {
    if (AIDEN_REMOTE_PRIVATE_BOT_FIXTURE_ROOTS.has(root)) visit(child, root, []);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isValidJsonString(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (
        Number.isNaN(nextCodeUnit) ||
        nextCodeUnit < 0xdc00 ||
        nextCodeUnit > 0xdfff
      ) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function assertAidenRemoteJsonValue(value: unknown, location: string): void {
  let objectKeyCount = 0;
  const activeObjects = new WeakSet<object>();

  function fail(message: string): never {
    throw new Error(`Invalid Aiden Remote JSON value at ${location}: ${message}`);
  }

  function visit(current: unknown, depth: number, currentLocation: string): void {
    if (depth > AIDEN_REMOTE_MAX_JSON_NESTING_DEPTH) {
      fail(`maximum nesting depth is ${AIDEN_REMOTE_MAX_JSON_NESTING_DEPTH}.`);
    }
    if (current === null) return;
    if (typeof current === "string") {
      if (!isValidJsonString(current)) fail("strings must not contain unpaired UTF-16 surrogates.");
      return;
    }
    if (typeof current === "boolean") return;
    if (typeof current === "number") {
      if (!Number.isFinite(current)) fail("numbers must be finite.");
      return;
    }
    if (typeof current !== "object") {
      fail("value must be a JSON-compatible primitive, array, or plain object.");
    }

    if (activeObjects.has(current)) fail("cycles are not supported.");
    activeObjects.add(current);

    try {
      if (Array.isArray(current)) {
        const ownKeys = Reflect.ownKeys(current);
        const arrayIndexes = new Set<number>();
        for (const ownKey of ownKeys) {
          if (ownKey === "length") {
            const descriptor = Object.getOwnPropertyDescriptor(current, ownKey);
            if (
              !descriptor ||
              descriptor.enumerable ||
              !Object.prototype.hasOwnProperty.call(descriptor, "value") ||
              descriptor.value !== current.length
            ) {
              fail("arrays must have the standard length property.");
            }
            continue;
          }
          if (typeof ownKey !== "string") fail("symbol array properties are not supported.");
          const descriptor = Object.getOwnPropertyDescriptor(current, ownKey);
          const index = Number(ownKey);
          if (
            !descriptor ||
            !descriptor.enumerable ||
            !Object.prototype.hasOwnProperty.call(descriptor, "value") ||
            !Number.isSafeInteger(index) ||
            index < 0 ||
            index >= current.length ||
            String(index) !== ownKey ||
            arrayIndexes.has(index)
          ) {
            fail("arrays must contain only dense numeric JSON elements.");
          }
          arrayIndexes.add(index);
        }
        if (arrayIndexes.size !== current.length) {
          fail("arrays must contain only dense numeric JSON elements.");
        }
        for (let index = 0; index < current.length; index += 1) {
          visit(current[index], depth + 1, `${currentLocation}[${index}]`);
        }
        return;
      }

      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) {
        fail("objects must use the plain JSON object prototype.");
      }
      const ownKeys = Reflect.ownKeys(current);
      const objectEntries: Array<[string, unknown]> = [];
      for (const ownKey of ownKeys) {
        if (typeof ownKey !== "string") fail("symbol object properties are not supported.");
        const descriptor = Object.getOwnPropertyDescriptor(current, ownKey);
        if (
          !descriptor ||
          !descriptor.enumerable ||
          !Object.prototype.hasOwnProperty.call(descriptor, "value")
        ) {
          fail(`object property ${ownKey} must be an enumerable data property.`);
        }
        if (!isValidJsonString(ownKey)) fail("object keys must not contain unpaired UTF-16 surrogates.");
        if (AIDEN_REMOTE_FORBIDDEN_WIRE_KEYS.has(ownKey)) {
          throw new Error(`Forbidden Aiden Remote wire key ${ownKey} at ${currentLocation}.`);
        }
        objectKeyCount += 1;
        if (objectKeyCount > AIDEN_REMOTE_MAX_JSON_OBJECT_KEYS) {
          fail(`maximum object-key count is ${AIDEN_REMOTE_MAX_JSON_OBJECT_KEYS}.`);
        }
        objectEntries.push([ownKey, descriptor.value]);
      }
      for (const [key, child] of objectEntries) {
        visit(child, depth + 1, `${currentLocation}.${key}`);
      }
    } finally {
      activeObjects.delete(current);
    }
  }

  visit(value, 0, location);
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Aiden Remote fixture field ${key} must be a non-empty string.`);
  }
  return value;
}

function requiredInteger(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (!Number.isSafeInteger(value)) {
    throw new Error(`Aiden Remote fixture field ${key} must be a safe integer.`);
  }
  return value as number;
}

function parseCapabilityList(value: unknown, label: string): AidenRemoteCapability[] {
  if (!Array.isArray(value) || value.length > AIDEN_REMOTE_CAPABILITIES.length) {
    throw new Error(`${label} capabilities must be an array.`);
  }
  const capabilities = value.map((entry) => {
    if (
      typeof entry !== "string" ||
      !(AIDEN_REMOTE_CAPABILITIES as readonly string[]).includes(entry)
    ) {
      throw new Error(`Unknown ${label} capability ${String(entry)}.`);
    }
    return entry as AidenRemoteCapability;
  });
  if (new Set(capabilities).size !== capabilities.length) {
    throw new Error(`${label} capabilities must be unique.`);
  }
  if (capabilities.includes("bot:write") && !capabilities.includes("bot:read")) {
    throw new Error(`${label} bot:write capability requires bot:read.`);
  }
  return capabilities;
}

function characterLength(value: string): number {
  let length = 0;
  for (const _character of value) length += 1;
  return length;
}

export function assertNoForbiddenWireKeys(value: unknown, location = "fixture"): void {
  assertAidenRemoteJsonValue(value, location);
}

const EVENT_PAYLOAD_KEYS: Record<AidenRemoteEventType, readonly string[]> = {
  snapshot: ["chatId", "turnId", "nextSequence"],
  status: ["state"],
  text_delta: ["text"],
  reasoning_delta: ["text"],
  tool_started: ["toolId", "name"],
  tool_finished: ["toolId", "status"],
  timeline: ["timeline"],
  approval_required: ["approvalId", "summary", "expiresAt"],
  done: ["messageId"],
  error: ["code", "message"],
  cancelled: ["source"],
  heartbeat: [],
};

const TERMINAL_EVENT_TYPES = new Set<AidenRemoteEventType>(["done", "error", "cancelled"]);

function assertExactKeys(record: Record<string, unknown>, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) throw new Error(`${label} contains unsupported field ${key}.`);
  }
}

function assertBoundedString(record: Record<string, unknown>, key: string, maxLength: number): string {
  const value = requiredString(record, key);
  if (characterLength(value) > maxLength) throw new Error(`Aiden Remote field ${key} exceeds ${maxLength} characters.`);
  return value;
}

function parseStrictRfc3339Parts(
  value: string,
  label: string,
): { epochSecond: number; fractionDigits: string; milliseconds: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})$/u.exec(value);
  if (!match) throw new Error(`${label} must be a strict RFC 3339 date-time.`);

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const fraction = match[7] ?? "";
  const offset = match[8]!;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (
    !Number.isInteger(daysInMonth) ||
    day < 1 || day > daysInMonth ||
    hour > 23 || minute > 59 || second > 59
  ) {
    throw new Error(`${label} must be a valid strict RFC 3339 date-time.`);
  }

  const offsetHours = offset === "Z" ? 0 : Number(offset.slice(1, 3));
  const offsetMinutes = offset === "Z" ? 0 : Number(offset.slice(4, 6));
  if (offsetHours > 23 || offsetMinutes > 59) {
    throw new Error(`${label} must have a valid RFC 3339 UTC offset.`);
  }
  const fractionDigits = fraction.slice(1);
  const millisecondsWithinSecond = Number(
    fractionDigits.padEnd(3, "0").slice(0, 3) || "0",
  );
  const date = new Date(Date.UTC(2000, month - 1, day, hour, minute, second, 0));
  date.setUTCFullYear(year);
  const signedOffsetMinutes = offset === "Z" ? 0 : (offset[0] === "+" ? 1 : -1) * (offsetHours * 60 + offsetMinutes);
  const wholeSecondMilliseconds = date.getTime() - signedOffsetMinutes * 60_000;
  return {
    epochSecond: wholeSecondMilliseconds / 1_000,
    fractionDigits,
    milliseconds: wholeSecondMilliseconds + millisecondsWithinSecond,
  };
}

function parseStrictRfc3339(value: string, label: string): number {
  return parseStrictRfc3339Parts(value, label).milliseconds;
}

function compareStrictRfc3339(
  left: string,
  leftLabel: string,
  right: string,
  rightLabel: string,
): number {
  const leftValue = parseStrictRfc3339Parts(left, leftLabel);
  const rightValue = parseStrictRfc3339Parts(right, rightLabel);
  if (leftValue.epochSecond !== rightValue.epochSecond) {
    return leftValue.epochSecond < rightValue.epochSecond ? -1 : 1;
  }
  const fractionLength = Math.max(
    leftValue.fractionDigits.length,
    rightValue.fractionDigits.length,
  );
  const leftFraction = leftValue.fractionDigits.padEnd(fractionLength, "0");
  const rightFraction = rightValue.fractionDigits.padEnd(fractionLength, "0");
  return leftFraction < rightFraction ? -1 : leftFraction > rightFraction ? 1 : 0;
}

const AIDEN_REMOTE_BOT_MAX_COUNT = 256;
const AIDEN_REMOTE_BOT_MAX_FAVORITES = 20;
const AIDEN_REMOTE_BOT_MAX_CONVERSATIONS = 50;
const AIDEN_REMOTE_BOT_MAX_CATALOG_MODELS = 512;
const AIDEN_REMOTE_BOT_MAX_AVATAR_BYTES = 4 * 1_048_576;
const AIDEN_REMOTE_BOT_MAX_AVATAR_BASE64_CHARACTERS = 5_592_408;
const AIDEN_REMOTE_BOT_ID = /^[A-Za-z0-9._:-]+$/u;
const AIDEN_REMOTE_BOT_AVATAR_SHAPES = [
  "wisp", "orb", "drop", "hex", "cloud", "peak", "squircle", "capsule",
] as const;
const AIDEN_REMOTE_BOT_AVATAR_COLORS = [
  "lilac", "sky", "mint", "sun", "periwinkle", "coral", "peach", "aqua",
] as const;
const AIDEN_REMOTE_BOT_AVATAR_EYES = [
  "dots", "wide", "happy", "sleepy", "focus", "wink",
] as const;
const AIDEN_REMOTE_BOT_AVATAR_DETAILS = [
  "none", "halo", "orbit", "sparkles", "antenna", "bolts",
] as const;

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function boundedText(
  value: unknown,
  label: string,
  maximum: number,
  allowEmpty = false,
): string {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.length === 0) ||
    !isValidJsonString(value) ||
    characterLength(value) > maximum
  ) {
    throw new Error(`${label} must be ${allowEmpty ? "at most" : "1–"} ${maximum} characters.`);
  }
  return value;
}

function optionalBoundedText(
  record: Record<string, unknown>,
  key: string,
  label: string,
  maximum: number,
  allowEmpty = false,
): string | undefined {
  if (!hasOwn(record, key)) return undefined;
  return boundedText(record[key], label, maximum, allowEmpty);
}

function boundedBotId(value: unknown, label: string): string {
  const id = boundedText(value, label, 160);
  if (!AIDEN_REMOTE_BOT_ID.test(id)) {
    throw new Error(`${label} must use the canonical Bot identifier grammar.`);
  }
  return id;
}

function boundedRevision(value: unknown, label: string): string {
  return boundedText(value, label, 128);
}

function boundedOpaqueSelectionId(value: unknown, label: string): string {
  const id = boundedText(value, label, 128);
  if (!AIDEN_REMOTE_BOT_ID.test(id)) {
    throw new Error(`${label} must be a path-safe opaque identifier.`);
  }
  return id;
}

function enumMember<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
  label: string,
): Values[number] {
  if (typeof value !== "string" || !(values as readonly string[]).includes(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value as Values[number];
}

function requiredBooleanValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean.`);
  return value;
}

function boundedIntegerValue(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} through ${maximum}.`);
  }
  return Number(value);
}

function dateTimeValue(value: unknown, label: string): string {
  const timestamp = boundedText(value, label, 80);
  parseStrictRfc3339(timestamp, label);
  return timestamp;
}

function parseBotSemanticAvatar(
  value: unknown,
  exactRequest: boolean,
): AidenRemoteBotSemanticAvatar {
  if (
    typeof value === "string" &&
    (AIDEN_REMOTE_BOT_LEGACY_AVATARS as readonly string[]).includes(value)
  ) {
    return value as AidenRemoteBotLegacyAvatar;
  }
  if (!isRecord(value)) throw new Error("Bot semantic avatar is invalid.");
  if (exactRequest) {
    assertExactKeys(
      value,
      ["version", "shape", "color", "eyes", "detail"],
      "Bot semantic avatar",
    );
  }
  if (value.version !== 1) throw new Error("Bot semantic avatar version must be 1.");
  return {
    version: 1,
    shape: enumMember(value.shape, AIDEN_REMOTE_BOT_AVATAR_SHAPES, "Bot avatar shape"),
    color: enumMember(value.color, AIDEN_REMOTE_BOT_AVATAR_COLORS, "Bot avatar color"),
    eyes: enumMember(value.eyes, AIDEN_REMOTE_BOT_AVATAR_EYES, "Bot avatar eyes"),
    detail: enumMember(value.detail, AIDEN_REMOTE_BOT_AVATAR_DETAILS, "Bot avatar detail"),
  };
}

function parseBotAvatarAsset(value: unknown): AidenRemoteBotAvatarAsset {
  if (!isRecord(value)) throw new Error("Bot avatar asset metadata must be an object.");
  if (value.width !== 512 || value.height !== 512) {
    throw new Error("Canonical Bot avatars must be 512 × 512 pixels.");
  }
  return {
    assetRevision: (() => {
      const revision = boundedRevision(value.assetRevision, "Bot avatar asset revision");
      if (!AIDEN_REMOTE_BOT_ID.test(revision)) {
        throw new Error("Bot avatar asset revision has invalid characters.");
      }
      return revision;
    })(),
    mimeType: enumMember(
      value.mimeType,
      ["image/png"] as const,
      "Bot avatar MIME type",
    ),
    width: 512,
    height: 512,
    byteSize: boundedIntegerValue(
      value.byteSize,
      "Bot avatar byte size",
      1,
      AIDEN_REMOTE_BOT_MAX_AVATAR_BYTES,
    ),
  };
}

function parseBotAvatarView(value: unknown): AidenRemoteBotAvatarView {
  if (!isRecord(value)) throw new Error("Bot avatar view must be an object.");
  return {
    semantic: parseBotSemanticAvatar(value.semantic, false),
    ...(value.asset === undefined ? {} : { asset: parseBotAvatarAsset(value.asset) }),
  };
}

function parseBotSummary(value: unknown): AidenRemoteBotSummary {
  if (!isRecord(value)) throw new Error("Bot summary must be an object.");
  const health = enumMember(value.health, AIDEN_REMOTE_BOT_HEALTH_STATES, "Bot health");
  const createdAt = dateTimeValue(value.createdAt, "Bot createdAt");
  const updatedAt = dateTimeValue(value.updatedAt, "Bot updatedAt");
  if (
    compareStrictRfc3339(
      updatedAt,
      "Bot updatedAt",
      createdAt,
      "Bot createdAt",
    ) < 0
  ) {
    throw new Error("Bot updatedAt must not precede createdAt.");
  }
  const archivedAt = optionalBoundedText(value, "archivedAt", "Bot archivedAt", 80);
  if (archivedAt !== undefined) parseStrictRfc3339(archivedAt, "Bot archivedAt");
  if ((health === "archived") !== (archivedAt !== undefined)) {
    throw new Error("Bot archived health and archivedAt must agree.");
  }
  const base: AidenRemoteBotSummaryBase = {
    id: boundedBotId(value.id, "Bot id"),
    name: boundedText(value.name, "Bot name", 80),
    purpose: boundedText(value.purpose, "Bot purpose", 280, true),
    avatar: parseBotAvatarView(value.avatar),
    createdAt,
    updatedAt,
    revision: boundedRevision(value.revision, "Bot revision"),
  };
  return health === "archived"
    ? { ...base, health, archivedAt: archivedAt! }
    : { ...base, health };
}

function parseUniqueBotIds(
  value: unknown,
  label: string,
  maximum: number,
): string[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new Error(`${label} must contain at most ${maximum} Bot ids.`);
  }
  const ids = value.map((entry) => boundedBotId(entry, `${label} item`));
  if (new Set(ids).size !== ids.length) throw new Error(`${label} must be unique.`);
  return ids;
}

function parseBotFavoritesView(value: unknown): AidenRemoteBotFavoritesView {
  if (!isRecord(value)) throw new Error("Bot favorites view must be an object.");
  return {
    botIds: parseUniqueBotIds(value.botIds, "Bot favorites", AIDEN_REMOTE_BOT_MAX_FAVORITES),
    revision: boundedRevision(value.revision, "Bot favorites revision"),
  };
}

function parseBotList(value: unknown): AidenRemoteBotList {
  if (!isRecord(value) || !Array.isArray(value.bots)) {
    throw new Error("Bot list must contain a bots array.");
  }
  if (value.bots.length > AIDEN_REMOTE_BOT_MAX_COUNT) {
    throw new Error("Bot list exceeds 256 entries.");
  }
  if (value.maxBots !== AIDEN_REMOTE_BOT_MAX_COUNT) {
    throw new Error("Bot list maxBots must be 256.");
  }
  const bots = value.bots.map(parseBotSummary);
  const botIds = new Set(bots.map((bot) => bot.id));
  if (botIds.size !== bots.length) throw new Error("Bot list ids must be unique.");
  const favorites = parseBotFavoritesView(value.favorites);
  if (favorites.botIds.some((botId) => !botIds.has(botId))) {
    throw new Error("Bot favorites must refer to Bots in the list fixture.");
  }
  const archivedBotIds = new Set(
    bots.filter((bot) => bot.health === "archived").map((bot) => bot.id),
  );
  if (favorites.botIds.some((botId) => archivedBotIds.has(botId))) {
    throw new Error("Archived Bots cannot remain in favorites.");
  }
  return { bots, maxBots: AIDEN_REMOTE_BOT_MAX_COUNT, favorites };
}

function parseBotCreateRequest(value: unknown): AidenRemoteBotCreateRequest {
  if (!isRecord(value)) throw new Error("Bot create request must be an object.");
  assertExactKeys(
    value,
    ["name", "purpose", "openingGreeting", "instructions", "avatar", "access"],
    "Bot create request",
  );
  return {
    name: boundedText(value.name, "Bot create name", 80),
    purpose: boundedText(value.purpose, "Bot create purpose", 280, true),
    instructions: boundedText(value.instructions, "Bot create instructions", 32_000),
    avatar: parseBotSemanticAvatar(value.avatar, true),
    access: parseBotAccessUpdateRequest(value.access),
    ...(hasOwn(value, "openingGreeting")
      ? {
          openingGreeting: boundedText(
            value.openingGreeting,
            "Bot create openingGreeting",
            2_000,
            true,
          ),
        }
      : {}),
  };
}

function parseBotIdentityPatch(value: unknown): AidenRemoteBotIdentityPatchRequest {
  if (!isRecord(value)) throw new Error("Bot identity patch must be an object.");
  const allowed = ["name", "purpose", "openingGreeting", "instructions", "avatar"] as const;
  assertExactKeys(value, allowed, "Bot identity patch");
  if (Object.keys(value).length === 0) {
    throw new Error("Bot identity patch must change at least one field.");
  }
  return {
    ...(hasOwn(value, "name")
      ? { name: boundedText(value.name, "Bot identity name", 80) }
      : {}),
    ...(hasOwn(value, "purpose")
      ? { purpose: boundedText(value.purpose, "Bot identity purpose", 280, true) }
      : {}),
    ...(hasOwn(value, "openingGreeting")
      ? {
          openingGreeting: boundedText(
            value.openingGreeting,
            "Bot identity openingGreeting",
            2_000,
            true,
          ),
        }
      : {}),
    ...(hasOwn(value, "instructions")
      ? { instructions: boundedText(value.instructions, "Bot identity instructions", 32_000) }
      : {}),
    ...(hasOwn(value, "avatar")
      ? { avatar: parseBotSemanticAvatar(value.avatar, true) }
      : {}),
  };
}

function parseBotConversationItem(value: unknown): AidenRemoteBotConversationItem {
  if (!isRecord(value)) throw new Error("Bot conversation item must be an object.");
  const activityState = enumMember(
    value.activityState,
    ["idle", "queued", "running", "waiting_for_approval", "reconciling"] as const,
    "Bot conversation activity state",
  );
  const createdAt = dateTimeValue(value.createdAt, "Bot conversation createdAt");
  const updatedAt = dateTimeValue(value.updatedAt, "Bot conversation updatedAt");
  if (
    compareStrictRfc3339(
      updatedAt,
      "Bot conversation updatedAt",
      createdAt,
      "Bot conversation createdAt",
    ) < 0
  ) {
    throw new Error("Bot conversation updatedAt must not precede createdAt.");
  }
  const canRespondToApproval = requiredBooleanValue(
    value.canRespondToApproval,
    "Bot conversation canRespondToApproval",
  );
  if (canRespondToApproval && activityState !== "waiting_for_approval") {
    throw new Error(
      "Bot conversation approval responses require waiting_for_approval state.",
    );
  }
  const base: AidenRemoteBotConversationItemBase = {
    chatId: boundedText(value.chatId, "Bot conversation chatId", 128),
    botId: boundedBotId(value.botId, "Bot conversation botId"),
    title: boundedText(value.title, "Bot conversation title", 1_024, true),
    createdAt,
    updatedAt,
    revision: boundedRevision(value.revision, "Bot conversation revision"),
    ...(hasOwn(value, "preview")
      ? { preview: boundedText(value.preview, "Bot conversation preview", 500, true) }
      : {}),
  };
  return activityState === "waiting_for_approval"
    ? { ...base, activityState, canRespondToApproval }
    : { ...base, activityState, canRespondToApproval: false };
}

function parseBotConversationPage(value: unknown): AidenRemoteBotConversationPage {
  if (!isRecord(value) || !Array.isArray(value.conversations)) {
    throw new Error("Bot conversation page must contain conversations.");
  }
  if (value.conversations.length > AIDEN_REMOTE_BOT_MAX_CONVERSATIONS) {
    throw new Error("Bot conversation page exceeds 50 entries.");
  }
  const conversations = value.conversations.map(parseBotConversationItem);
  if (new Set(conversations.map((item) => item.chatId)).size !== conversations.length) {
    throw new Error("Bot conversation page chat ids must be unique.");
  }
  return {
    conversations,
    ...(hasOwn(value, "nextCursor")
      ? { nextCursor: boundedText(value.nextCursor, "Bot conversation cursor", 128) }
      : {}),
  };
}

function parseBotConversationQuery(value: unknown): AidenRemoteBotConversationQuery {
  if (!isRecord(value)) throw new Error("Bot conversation query fixture must be an object.");
  assertExactKeys(value, ["cursor", "query", "botId", "limit"], "Bot conversation query");
  return {
    ...(hasOwn(value, "cursor")
      ? { cursor: boundedText(value.cursor, "Bot conversation query cursor", 128) }
      : {}),
    ...(hasOwn(value, "query")
      ? { query: boundedText(value.query, "Bot conversation search query", 200, true) }
      : {}),
    ...(hasOwn(value, "botId")
      ? { botId: boundedBotId(value.botId, "Bot conversation query botId") }
      : {}),
    ...(hasOwn(value, "limit")
      ? { limit: boundedIntegerValue(value.limit, "Bot conversation query limit", 1, 50) }
      : {}),
  };
}

function parseBotChatCreateRequest(value: unknown): AidenRemoteBotChatCreateRequest {
  if (!isRecord(value)) throw new Error("Bot chat create request must be an object.");
  assertExactKeys(value, ["providerId", "modelId"], "Bot chat create request");
  const hasProviderId = hasOwn(value, "providerId");
  const hasModelId = hasOwn(value, "modelId");
  if (hasProviderId !== hasModelId) {
    throw new Error(
      "Bot chat create providerId and modelId must be supplied together.",
    );
  }
  return hasProviderId
    ? {
        providerId: boundedText(value.providerId, "Bot chat providerId", 256),
        modelId: boundedText(value.modelId, "Bot chat modelId", 512),
      }
    : {};
}

function parseChatMessageAttachments(
  value: unknown,
  label: string,
): NonNullable<AidenRemoteChatProjection["messages"][number]["attachments"]> {
  if (!Array.isArray(value) || value.length > 20) {
    throw new Error(`${label} attachments must contain at most 20 items.`);
  }
  return value.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`${label} attachment ${index} must be an object.`);
    const id = boundedText(entry.id, `${label} attachment ${index} id`, 256);
    if (!/^[A-Za-z0-9._:-]{1,256}$/u.test(id)) {
      throw new Error(`${label} attachment ${index} id is invalid.`);
    }
    const name = boundedText(entry.name, `${label} attachment ${index} name`, 255);
    const hasUnsafeNameCharacter =
      /[/\\]/u.test(name) ||
      Array.from(name).some((character) => {
        const codePoint = character.codePointAt(0);
        return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
      });
    if (hasUnsafeNameCharacter) {
      throw new Error(`${label} attachment ${index} name is unsafe.`);
    }
    return {
      id,
      name,
      mimeType: boundedText(
        entry.mimeType,
        `${label} attachment ${index} mimeType`,
        120,
      ),
      kind: enumMember(
        entry.kind,
        ["image", "text"] as const,
        `${label} attachment ${index} kind`,
      ),
      size: boundedIntegerValue(
        entry.size,
        `${label} attachment ${index} size`,
        0,
        Number.MAX_SAFE_INTEGER,
      ),
    };
  });
}

function parseChatMessageOutcome(
  value: unknown,
  label: string,
): NonNullable<AidenRemoteChatProjection["messages"][number]["outcome"]> {
  if (!isRecord(value)) throw new Error(`${label} outcome must be an object.`);
  return {
    status: enumMember(
      value.status,
      ["failed", "cancelled"] as const,
      `${label} outcome status`,
    ),
    ...(hasOwn(value, "category")
      ? {
          category: enumMember(
            value.category,
            [
              "network",
              "timeout",
              "service_unavailable",
              "rate_limit",
              "authentication",
              "quota",
              "invalid_request",
              "context_window",
              "output_limit",
              "interrupted",
              "context_management",
              "unknown",
            ] as const,
            `${label} outcome category`,
          ),
        }
      : {}),
    ...(hasOwn(value, "attempts")
      ? {
          attempts: boundedIntegerValue(
            value.attempts,
            `${label} outcome attempts`,
            0,
            16,
          ),
        }
      : {}),
    ...(hasOwn(value, "retryExhausted")
      ? {
          retryExhausted: requiredBooleanValue(
            value.retryExhausted,
            `${label} outcome retryExhausted`,
          ),
        }
      : {}),
  };
}

export function parseAidenRemoteChatProjection(
  value: unknown,
  label = "Chat response",
): AidenRemoteChatProjection {
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error(`${label} must be JSON serializable.`);
  }
  if (
    serialized === undefined ||
    Buffer.byteLength(serialized, "utf8") > AIDEN_REMOTE_MAX_JSON_RESPONSE_BYTES
  ) {
    throw new Error(`${label} exceeds the 1 MiB JSON response ceiling.`);
  }
  if (
    !Array.isArray(value.messages) ||
    value.messages.length > AIDEN_REMOTE_MAX_CHAT_MESSAGES
  ) {
    throw new Error(
      `${label} messages must contain at most ${AIDEN_REMOTE_MAX_CHAT_MESSAGES} items.`,
    );
  }
  const messages: AidenRemoteChatProjection["messages"] = value.messages.map(
    (entry, index) => {
      if (!isRecord(entry)) throw new Error(`${label} message ${index} must be an object.`);
      const text = boundedText(
        entry.text,
        `${label} message ${index} text`,
        200_000,
        true,
      );
      const message: AidenRemoteChatProjection["messages"][number] = {
        id: boundedText(entry.id, `${label} message ${index} id`, 128),
        role: enumMember(
          entry.role,
          ["user", "assistant"] as const,
          `${label} message ${index} role`,
        ),
        text,
        createdAt: dateTimeValue(entry.createdAt, `${label} message ${index} createdAt`),
        ...(hasOwn(entry, "attachments")
          ? {
              attachments: parseChatMessageAttachments(
                entry.attachments,
                `${label} message ${index}`,
              ),
            }
          : {}),
        ...(hasOwn(entry, "outcome")
          ? {
              outcome: parseChatMessageOutcome(
                entry.outcome,
                `${label} message ${index}`,
              ),
            }
          : {}),
      };
      if (hasOwn(entry, "timeline")) {
        // Generation timeline offsets are persisted as JavaScript UTF-16 code
        // units, while the public text ceiling remains Unicode-scalar based.
        const timeline = parseGenerationTimeline(entry.timeline, text.length);
        if (!timeline) throw new Error(`${label} message ${index} timeline is invalid.`);
        message.timeline = timeline;
      }
      return message;
    },
  );
  const createdAt = dateTimeValue(value.createdAt, `${label} createdAt`);
  const updatedAt = dateTimeValue(value.updatedAt, `${label} updatedAt`);
  if (
    compareStrictRfc3339(
      updatedAt,
      `${label} updatedAt`,
      createdAt,
      `${label} createdAt`,
    ) < 0
  ) {
    throw new Error(`${label} updatedAt must not precede createdAt.`);
  }
  const hasProviderId = hasOwn(value, "providerId");
  const hasModelId = hasOwn(value, "modelId");
  if (hasProviderId !== hasModelId) {
    throw new Error(`${label} providerId and modelId must be supplied together.`);
  }
  return {
    id: boundedText(value.id, `${label} id`, 128),
    workspaceId: boundedText(value.workspaceId, `${label} workspaceId`, 128),
    ...(hasOwn(value, "botId")
      ? { botId: boundedBotId(value.botId, `${label} botId`) }
      : {}),
    title: boundedText(value.title, `${label} title`, 1_024, true),
    messages,
    createdAt,
    updatedAt,
    revision: boundedRevision(value.revision, `${label} revision`),
    ...(hasProviderId
      ? { providerId: boundedText(value.providerId, `${label} providerId`, 256) }
      : {}),
    ...(hasModelId
      ? { modelId: boundedText(value.modelId, `${label} modelId`, 512) }
      : {}),
    ...(hasOwn(value, "titlePending")
      ? value.titlePending === true
        ? { titlePending: true as const }
        : (() => { throw new Error(`${label} titlePending may only be true.`); })()
      : {}),
  };
}

function parseBotCapabilityOption(
  value: unknown,
  label: string,
): AidenRemoteBotCapabilityOption {
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
  return {
    id: boundedOpaqueSelectionId(value.id, `${label} id`),
    label: boundedText(value.label, `${label} label`, 120),
    available: requiredBooleanValue(value.available, `${label} available`),
    ...(hasOwn(value, "description")
      ? { description: boundedText(value.description, `${label} description`, 280, true) }
      : {}),
  };
}

function parseBotFileScopeOption(value: unknown): AidenRemoteBotFileScopeOption {
  if (!isRecord(value)) throw new Error("Bot file scope must be an object.");
  return {
    ...parseBotCapabilityOption(value, "Bot file scope"),
    kind: enumMember(
      value.kind,
      ["full_mac", "bot_home", "approved_location"] as const,
      "Bot file scope kind",
    ),
  };
}

function parseBotProviderOption(value: unknown): AidenRemoteBotProviderOption {
  if (!isRecord(value) || !Array.isArray(value.models)) {
    throw new Error("Bot provider option must contain models.");
  }
  if (value.models.length > 256) throw new Error("Bot provider model list exceeds 256 entries.");
  const models = value.models.map((model, index): AidenRemoteBotModelOption => {
    if (!isRecord(model)) throw new Error(`Bot provider model ${index} must be an object.`);
    return {
      id: boundedText(model.id, `Bot provider model ${index} id`, 512),
      label: boundedText(model.label, `Bot provider model ${index} label`, 160),
      available: requiredBooleanValue(
        model.available,
        `Bot provider model ${index} available`,
      ),
    };
  });
  if (new Set(models.map((model) => model.id)).size !== models.length) {
    throw new Error("Bot provider model ids must be unique per provider.");
  }
  return {
    id: boundedText(value.id, "Bot provider id", 256),
    label: boundedText(value.label, "Bot provider label", 120),
    available: requiredBooleanValue(value.available, "Bot provider available"),
    models,
  };
}

function parseBotNoticeDecision(value: unknown, label: string): AidenRemoteBotNoticeDecision {
  return enumMember(
    value,
    ["continue_full", "customize_first"] as const,
    label,
  );
}

function parseBotAccessNoticeStatus(value: unknown): AidenRemoteBotAccessNoticeStatus {
  if (!isRecord(value)) throw new Error("Bot access notice status must be an object.");
  const version = boundedText(value.version, "Bot access notice version", 80);
  if (version !== AIDEN_REMOTE_BOT_ACCESS_NOTICE_VERSION) {
    throw new Error("Bot access notice version is unsupported by this contract.");
  }
  const requiresAcknowledgement = requiredBooleanValue(
    value.requiresAcknowledgement,
    "Bot access notice requiresAcknowledgement",
  );
  const hasAcceptedAt = hasOwn(value, "acceptedAt");
  const hasAcceptedDecision = hasOwn(value, "acceptedDecision");
  if (requiresAcknowledgement) {
    if (hasAcceptedAt || hasAcceptedDecision) {
      throw new Error("A pending Bot access notice cannot contain an acceptance.");
    }
    return { version, requiresAcknowledgement: true };
  }
  if (!hasAcceptedAt || !hasAcceptedDecision) {
    throw new Error("An acknowledged Bot access notice requires its time and decision.");
  }
  return {
    version,
    requiresAcknowledgement: false,
    acceptedAt: dateTimeValue(value.acceptedAt, "Bot access notice acceptedAt"),
    acceptedDecision: parseBotNoticeDecision(
      value.acceptedDecision,
      "Bot access notice acceptedDecision",
    ),
  };
}

function assertUniqueOptionIds(
  options: readonly { id: string }[],
  label: string,
): void {
  if (new Set(options.map((option) => option.id)).size !== options.length) {
    throw new Error(`${label} ids must be unique.`);
  }
}

function parseBotCapabilityCatalog(value: unknown): AidenRemoteBotCapabilityCatalog {
  if (!isRecord(value)) throw new Error("Bot capability catalog must be an object.");
  const boundedArray = (
    candidate: unknown,
    label: string,
    maximum: number,
  ): unknown[] => {
    if (!Array.isArray(candidate) || candidate.length > maximum) {
      throw new Error(`${label} must contain at most ${maximum} entries.`);
    }
    return candidate;
  };
  const providers = boundedArray(value.providers, "Bot catalog providers", 64)
    .map(parseBotProviderOption);
  if (
    providers.reduce((total, provider) => total + provider.models.length, 0) >
    AIDEN_REMOTE_BOT_MAX_CATALOG_MODELS
  ) {
    throw new Error("Bot catalog exceeds 512 total provider models.");
  }
  const fileScopes = boundedArray(value.fileScopes, "Bot catalog file scopes", 64)
    .map(parseBotFileScopeOption);
  const connections = boundedArray(value.connections, "Bot catalog connections", 128)
    .map((option) => parseBotCapabilityOption(option, "Bot connection"));
  const skills = boundedArray(value.skills, "Bot catalog skills", 256)
    .map((option) => parseBotCapabilityOption(option, "Bot skill"));
  const otherCapabilities = boundedArray(
    value.otherCapabilities,
    "Bot catalog other capabilities",
    128,
  ).map((option) => parseBotCapabilityOption(option, "Bot other capability"));
  assertUniqueOptionIds(providers, "Bot provider");
  assertUniqueOptionIds(fileScopes, "Bot file scope");
  assertUniqueOptionIds(connections, "Bot connection");
  assertUniqueOptionIds(skills, "Bot skill");
  assertUniqueOptionIds(otherCapabilities, "Bot other capability");
  return {
    revision: boundedRevision(value.revision, "Bot capability catalog revision"),
    providers,
    fileScopes,
    shellAvailable: requiredBooleanValue(value.shellAvailable, "Bot catalog shellAvailable"),
    connections,
    skills,
    otherCapabilities,
    notice: parseBotAccessNoticeStatus(value.notice),
  };
}

function parseBoundedUniqueIds(
  value: unknown,
  label: string,
  maximum: number,
  itemMaximum = 128,
): string[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new Error(`${label} must contain at most ${maximum} entries.`);
  }
  const ids = value.map((entry) => {
    const id = boundedText(entry, `${label} item`, itemMaximum);
    if (!AIDEN_REMOTE_BOT_ID.test(id)) {
      throw new Error(`${label} items must be path-safe opaque identifiers.`);
    }
    return id;
  });
  if (new Set(ids).size !== ids.length) throw new Error(`${label} must be unique.`);
  return ids;
}

function parseBotCustomSelection(
  value: unknown,
  exactRequest: boolean,
): AidenRemoteBotCustomSelection {
  if (!isRecord(value)) throw new Error("Bot custom selection must be an object.");
  if (exactRequest) {
    assertExactKeys(
      value,
      [
        "providerId",
        "modelId",
        "fileScopeIds",
        "shellEnabled",
        "connectionIds",
        "skillIds",
        "otherCapabilityIds",
      ],
      "Bot custom selection",
    );
  }
  return {
    fileScopeIds: parseBoundedUniqueIds(
      value.fileScopeIds,
      "Bot custom file scopes",
      64,
    ),
    shellEnabled: requiredBooleanValue(value.shellEnabled, "Bot custom shellEnabled"),
    connectionIds: parseBoundedUniqueIds(
      value.connectionIds,
      "Bot custom connections",
      128,
    ),
    skillIds: parseBoundedUniqueIds(value.skillIds, "Bot custom skills", 256),
    otherCapabilityIds: parseBoundedUniqueIds(
      value.otherCapabilityIds,
      "Bot custom other capabilities",
      128,
    ),
    providerId: boundedText(value.providerId, "Bot custom providerId", 256),
    modelId: boundedText(value.modelId, "Bot custom modelId", 512),
  };
}

function validateBotSelectionAgainstCatalog(
  selection: AidenRemoteBotCustomSelection,
  catalog: AidenRemoteBotCapabilityCatalog,
  label: string,
  requireAvailability: boolean,
): void {
  const requireCatalogOption = (
    ids: readonly string[],
    options: readonly { id: string; available: boolean }[],
    optionLabel: string,
  ) => {
    for (const id of ids) {
      const option = options.find((candidate) => candidate.id === id);
      if (!option) throw new Error(`${label} contains an unknown ${optionLabel}.`);
      if (requireAvailability && !option.available) {
        throw new Error(`${label} contains an unavailable ${optionLabel}.`);
      }
    }
  };
  requireCatalogOption(selection.fileScopeIds, catalog.fileScopes, "file scope");
  requireCatalogOption(selection.connectionIds, catalog.connections, "connection");
  requireCatalogOption(selection.skillIds, catalog.skills, "skill");
  requireCatalogOption(
    selection.otherCapabilityIds,
    catalog.otherCapabilities,
    "capability",
  );
  if (requireAvailability && selection.shellEnabled && !catalog.shellAvailable) {
    throw new Error(`${label} enables unavailable shell access.`);
  }
  const provider = catalog.providers.find((candidate) => candidate.id === selection.providerId);
  if (!provider) throw new Error(`${label} contains an unknown provider.`);
  if (requireAvailability && !provider.available) {
    throw new Error(`${label} contains an unavailable provider.`);
  }
  const model = provider.models.find((candidate) => candidate.id === selection.modelId);
  if (!model) throw new Error(`${label} contains an unknown provider model.`);
  if (requireAvailability && !model.available) {
    throw new Error(`${label} contains an unavailable provider model.`);
  }
}

function botSelectionsEqual(
  left: AidenRemoteBotCustomSelection,
  right: AidenRemoteBotCustomSelection,
): boolean {
  const arraysEqual = (first: readonly string[], second: readonly string[]) =>
    first.length === second.length && first.every((entry) => second.includes(entry));
  return (
    left.providerId === right.providerId &&
    left.modelId === right.modelId &&
    left.shellEnabled === right.shellEnabled &&
    arraysEqual(left.fileScopeIds, right.fileScopeIds) &&
    arraysEqual(left.connectionIds, right.connectionIds) &&
    arraysEqual(left.skillIds, right.skillIds) &&
    arraysEqual(left.otherCapabilityIds, right.otherCapabilityIds)
  );
}

function botAccessViewsEqual(
  left: AidenRemoteBotAccessView,
  right: AidenRemoteBotAccessView,
): boolean {
  return (
    left.botId === right.botId &&
    left.revision === right.revision &&
    left.policyEpoch === right.policyEpoch &&
    left.summary === right.summary &&
    left.accessMode === right.accessMode &&
    (left.accessMode === "full"
      ? right.accessMode === "full"
      : right.accessMode === "custom" && botSelectionsEqual(left.custom, right.custom))
  );
}

function assertAvailableBotChatModel(
  providerId: string | undefined,
  modelId: string | undefined,
  catalog: AidenRemoteBotCapabilityCatalog,
  label: string,
): void {
  if (providerId === undefined && modelId === undefined) return;
  if (providerId === undefined || modelId === undefined) {
    throw new Error(`${label} providerId and modelId must be supplied together.`);
  }
  const provider = catalog.providers.find((candidate) => candidate.id === providerId);
  if (!provider || !provider.available) {
    throw new Error(`${label} contains an unknown or unavailable provider.`);
  }
  const model = provider.models.find((candidate) => candidate.id === modelId);
  if (!model || !model.available) {
    throw new Error(`${label} contains an unknown or unavailable provider model.`);
  }
}

function assertBotAccessRequestMatchesView(
  request: AidenRemoteBotAccessUpdateRequest,
  response: AidenRemoteBotAccessView,
  label: string,
): void {
  if (request.accessMode !== response.accessMode) {
    throw new Error(`${label} request and response access modes do not agree.`);
  }
  if (
    request.accessMode === "custom" &&
    (response.accessMode !== "custom" ||
      !botSelectionsEqual(request.custom, response.custom))
  ) {
    throw new Error(`${label} request and response Custom selections do not agree.`);
  }
}

function botSummaryFieldsEqual(
  left: AidenRemoteBotSummary,
  right: AidenRemoteBotSummary,
): boolean {
  return (
    left.id === right.id &&
    left.name === right.name &&
    left.purpose === right.purpose &&
    JSON.stringify(left.avatar) === JSON.stringify(right.avatar) &&
    left.health === right.health &&
    left.archivedAt === right.archivedAt &&
    left.createdAt === right.createdAt &&
    left.updatedAt === right.updatedAt &&
    left.revision === right.revision
  );
}

function botIdentityFieldsEqual(
  left: AidenRemoteBotDetail,
  right: AidenRemoteBotDetail,
): boolean {
  return (
    left.id === right.id &&
    left.name === right.name &&
    left.purpose === right.purpose &&
    left.instructions === right.instructions &&
    left.openingGreeting === right.openingGreeting &&
    JSON.stringify(left.avatar) === JSON.stringify(right.avatar) &&
    left.createdAt === right.createdAt
  );
}

function validateBotChatSelectionAgainstPolicy(
  selection: AidenRemoteBotCustomSelection,
  policy: AidenRemoteBotAccessView,
  label: string,
): void {
  if (policy.accessMode === "full") return;
  const isSubset = (candidate: readonly string[], ceiling: readonly string[]) => {
    const allowed = new Set(ceiling);
    return candidate.every((id) => allowed.has(id));
  };
  if (
    selection.providerId !== policy.custom.providerId ||
    selection.modelId !== policy.custom.modelId ||
    (selection.shellEnabled && !policy.custom.shellEnabled) ||
    !isSubset(selection.fileScopeIds, policy.custom.fileScopeIds) ||
    !isSubset(selection.connectionIds, policy.custom.connectionIds) ||
    !isSubset(selection.skillIds, policy.custom.skillIds) ||
    !isSubset(selection.otherCapabilityIds, policy.custom.otherCapabilityIds)
  ) {
    throw new Error(`${label} exceeds the authoritative Bot access ceiling.`);
  }
}

function parseBotAccessView(value: unknown): AidenRemoteBotAccessView {
  if (!isRecord(value)) throw new Error("Bot access view must be an object.");
  const accessMode = enumMember(
    value.accessMode,
    ["full", "custom"] as const,
    "Bot access mode",
  );
  const custom = value.custom === undefined
    ? undefined
    : parseBotCustomSelection(value.custom, false);
  if ((accessMode === "custom") !== (custom !== undefined)) {
    throw new Error("Bot Custom access and custom selection must agree.");
  }
  const base: AidenRemoteBotAccessViewBase = {
    botId: boundedBotId(value.botId, "Bot access botId"),
    revision: boundedRevision(value.revision, "Bot access revision"),
    policyEpoch: boundedRevision(value.policyEpoch, "Bot access policyEpoch"),
    summary: boundedText(value.summary, "Bot access summary", 280),
  };
  return accessMode === "custom"
    ? { ...base, accessMode, custom: custom! }
    : { ...base, accessMode };
}

function parseBotDetail(value: unknown): AidenRemoteBotDetail {
  if (!isRecord(value)) throw new Error("Bot detail must be an object.");
  const summary = parseBotSummary(value);
  const access = parseBotAccessView(value.access);
  if (access.botId !== summary.id) throw new Error("Bot detail access belongs to another Bot.");
  return {
    ...summary,
    instructions: boundedText(value.instructions, "Bot instructions", 32_000),
    access,
    ...(hasOwn(value, "openingGreeting")
      ? {
          openingGreeting: boundedText(
            value.openingGreeting,
            "Bot openingGreeting",
            2_000,
            true,
          ),
        }
      : {}),
  };
}

function parseBotAccessUpdateRequest(value: unknown): AidenRemoteBotAccessUpdateRequest {
  if (!isRecord(value)) throw new Error("Bot access update request must be an object.");
  if (value.accessMode === "full") {
    assertExactKeys(
      value,
      ["accessMode", "catalogRevision", "confirmedForeground"],
      "Full Bot access update",
    );
    if (value.confirmedForeground !== true) {
      throw new Error("Full Bot access update requires foreground confirmation.");
    }
    return {
      accessMode: "full",
      catalogRevision: boundedRevision(
        value.catalogRevision,
        "Full Bot access catalogRevision",
      ),
      confirmedForeground: true,
    };
  }
  if (value.accessMode === "custom") {
    assertExactKeys(
      value,
      ["accessMode", "catalogRevision", "custom"],
      "Custom Bot access update",
    );
    return {
      accessMode: "custom",
      catalogRevision: boundedRevision(
        value.catalogRevision,
        "Custom Bot access catalogRevision",
      ),
      custom: parseBotCustomSelection(value.custom, true),
    };
  }
  throw new Error("Bot access update mode is invalid.");
}

function parseBotChatAccessView(value: unknown): AidenRemoteBotChatAccessView {
  if (!isRecord(value)) throw new Error("Bot chat access view must be an object.");
  const mode = enumMember(value.mode, ["inherit", "custom"] as const, "Bot chat access mode");
  const custom = value.custom === undefined
    ? undefined
    : parseBotCustomSelection(value.custom, false);
  if ((mode === "custom") !== (custom !== undefined)) {
    throw new Error("Bot chat Custom mode and custom selection must agree.");
  }
  const base: AidenRemoteBotChatAccessViewBase = {
    chatId: boundedText(value.chatId, "Bot chat access chatId", 128),
    botId: boundedBotId(value.botId, "Bot chat access botId"),
    revision: boundedRevision(value.revision, "Bot chat access revision"),
    botPolicyRevision: boundedRevision(
      value.botPolicyRevision,
      "Bot chat access botPolicyRevision",
    ),
    summary: boundedText(value.summary, "Bot chat access summary", 280),
  };
  return mode === "custom"
    ? { ...base, mode, custom: custom! }
    : { ...base, mode };
}

function parseBotChatAccessUpdateRequest(
  value: unknown,
): AidenRemoteBotChatAccessUpdateRequest {
  if (!isRecord(value)) throw new Error("Bot chat access update request must be an object.");
  if (value.mode === "inherit") {
    assertExactKeys(
      value,
      ["mode", "catalogRevision", "expectedBotPolicyRevision"],
      "Inherited Bot chat access update",
    );
    return {
      mode: "inherit",
      catalogRevision: boundedRevision(
        value.catalogRevision,
        "Inherited Bot chat access catalogRevision",
      ),
      expectedBotPolicyRevision: boundedRevision(
        value.expectedBotPolicyRevision,
        "Inherited Bot chat access expectedBotPolicyRevision",
      ),
    };
  }
  if (value.mode === "custom") {
    assertExactKeys(
      value,
      ["mode", "catalogRevision", "expectedBotPolicyRevision", "custom"],
      "Custom Bot chat access update",
    );
    return {
      mode: "custom",
      catalogRevision: boundedRevision(
        value.catalogRevision,
        "Custom Bot chat access catalogRevision",
      ),
      expectedBotPolicyRevision: boundedRevision(
        value.expectedBotPolicyRevision,
        "Custom Bot chat access expectedBotPolicyRevision",
      ),
      custom: parseBotCustomSelection(value.custom, true),
    };
  }
  throw new Error("Bot chat access update mode is invalid.");
}

function parseBotFavoritesUpdateRequest(value: unknown): AidenRemoteBotFavoritesUpdateRequest {
  if (!isRecord(value)) throw new Error("Bot favorites update request must be an object.");
  assertExactKeys(value, ["botIds"], "Bot favorites update request");
  return {
    botIds: parseUniqueBotIds(value.botIds, "Bot favorites update", AIDEN_REMOTE_BOT_MAX_FAVORITES),
  };
}

function parseBotNoticeAcknowledgementRequest(
  value: unknown,
): AidenRemoteBotNoticeAcknowledgementRequest {
  if (!isRecord(value)) throw new Error("Bot notice acknowledgement must be an object.");
  assertExactKeys(
    value,
    ["version", "decision", "confirmedForeground"],
    "Bot notice acknowledgement",
  );
  if (value.confirmedForeground !== true) {
    throw new Error("Bot notice acknowledgement requires foreground confirmation.");
  }
  return {
    version: (() => {
      const version = boundedText(
        value.version,
        "Bot notice acknowledgement version",
        80,
      );
      if (version !== AIDEN_REMOTE_BOT_ACCESS_NOTICE_VERSION) {
        throw new Error("Bot notice acknowledgement version is unsupported.");
      }
      return version;
    })(),
    decision: parseBotNoticeDecision(
      value.decision,
      "Bot notice acknowledgement decision",
    ),
    confirmedForeground: true,
  };
}

function parseBotAvatarUploadRequest(value: unknown): AidenRemoteBotAvatarUploadRequest {
  if (!isRecord(value)) throw new Error("Bot avatar upload request must be an object.");
  assertExactKeys(value, ["mimeType", "data"], "Bot avatar upload request");
  const mimeType = enumMember(
    value.mimeType,
    ["image/png", "image/jpeg"] as const,
    "Bot avatar upload MIME type",
  );
  const data = boundedText(
    value.data,
    "Bot avatar upload data",
    AIDEN_REMOTE_BOT_MAX_AVATAR_BASE64_CHARACTERS,
  );
  if (
    data.length < 4 ||
    data.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/u.test(data)
  ) {
    throw new Error("Bot avatar upload data must be canonical base64.");
  }
  const decoded = Buffer.from(data, "base64");
  if (
    decoded.length > AIDEN_REMOTE_BOT_MAX_AVATAR_BYTES ||
    decoded.toString("base64") !== data
  ) {
    throw new Error("Bot avatar upload data exceeds the decoded limit or is noncanonical.");
  }
  return { mimeType, data };
}

function parseLegacyNonNegotiatingFixture(
  value: unknown,
  canonical: {
    instanceId: string;
  },
): AidenRemoteLegacyNonNegotiatingFixture {
  if (!isRecord(value) || !isRecord(value.pairingExchange) || !isRecord(value.server)) {
    throw new Error("Legacy non-negotiating fixture is invalid.");
  }
  assertExactKeys(
    value,
    ["pairingExchange", "server"],
    "Legacy non-negotiating fixture",
  );
  const pairing = value.pairingExchange;
  assertExactKeys(
    pairing,
    [
      "protocolVersion",
      "instanceId",
      "deviceId",
      "credential",
      "capabilities",
      "displayName",
      "endpoint",
      "serverSpkiSha256",
    ],
    "Legacy pairing exchange",
  );
  const server = value.server;
  assertExactKeys(
    server,
    [
      "protocolVersion",
      "instanceId",
      "name",
      "appVersion",
      "capabilities",
      "connectionMode",
      "minimumClientVersion",
      "serverTime",
    ],
    "Legacy server projection",
  );
  if (pairing.protocolVersion !== 1 || server.protocolVersion !== 1) {
    throw new Error("Legacy fixture protocolVersion must be 1.");
  }
  if (pairing.instanceId !== canonical.instanceId || server.instanceId !== canonical.instanceId) {
    throw new Error("Legacy fixture instance does not match the canonical fixture.");
  }
  const legacyEndpoint = boundedText(pairing.endpoint, "Legacy pairing endpoint", 2_048);
  assertAidenRemoteEndpoint(legacyEndpoint);
  const legacyFingerprint = boundedText(
    pairing.serverSpkiSha256,
    "Legacy pairing fingerprint",
    80,
  );
  if (!/^sha256\/[A-Za-z0-9+/]{43}=$/u.test(legacyFingerprint)) {
    throw new Error("Legacy pairing fingerprint must be a SHA-256 SPKI digest.");
  }
  const pairingCapabilities = parseCapabilityList(
    pairing.capabilities,
    "legacy pairing",
  );
  const serverCapabilities = parseCapabilityList(
    server.capabilities,
    "legacy server device-grant",
  );
  const isLegacy = (capability: AidenRemoteCapability) =>
    (AIDEN_REMOTE_LEGACY_CAPABILITIES as readonly string[]).includes(capability);
  if (
    pairingCapabilities.some((capability) => !isLegacy(capability)) ||
    serverCapabilities.some((capability) => !isLegacy(capability)) ||
    pairingCapabilities.length !== serverCapabilities.length ||
    pairingCapabilities.some((capability, index) => capability !== serverCapabilities[index])
  ) {
    throw new Error("Legacy non-negotiating fixture must contain only matching legacy grants.");
  }
  return {
    pairingExchange: {
      protocolVersion: 1,
      instanceId: boundedText(pairing.instanceId, "Legacy pairing instanceId", 128),
      deviceId: boundedText(pairing.deviceId, "Legacy pairing deviceId", 128),
      credential: (() => {
        const credential = boundedText(pairing.credential, "Legacy pairing credential", 43);
        assertBase64Url32(credential, "Legacy pairing credential");
        return credential;
      })(),
      capabilities: pairingCapabilities as (typeof AIDEN_REMOTE_LEGACY_CAPABILITIES)[number][],
      ...(hasOwn(pairing, "displayName")
        ? { displayName: boundedText(pairing.displayName, "Legacy pairing displayName", 80) }
        : {}),
      endpoint: legacyEndpoint,
      serverSpkiSha256: legacyFingerprint,
    },
    server: {
      protocolVersion: 1,
      instanceId: boundedText(server.instanceId, "Legacy server instanceId", 128),
      name: boundedText(server.name, "Legacy server name", 80),
      appVersion: boundedText(server.appVersion, "Legacy server appVersion", 40),
      capabilities: serverCapabilities as (typeof AIDEN_REMOTE_LEGACY_CAPABILITIES)[number][],
      connectionMode: enumMember(
        server.connectionMode,
        ["lan", "tailscale", "both"] as const,
        "Legacy server connectionMode",
      ),
      ...(hasOwn(server, "minimumClientVersion")
        ? {
            minimumClientVersion: boundedText(
              server.minimumClientVersion,
              "Legacy server minimumClientVersion",
              40,
            ),
          }
        : {}),
      serverTime: dateTimeValue(server.serverTime, "Legacy serverTime"),
    },
  };
}

function validateEventPayload(type: AidenRemoteEventType, payload: Record<string, unknown>): void {
  const keys = EVENT_PAYLOAD_KEYS[type];
  assertExactKeys(payload, keys, `${type} payload`);
  for (const key of keys) {
    if (!(key in payload)) throw new Error(`${type} payload is missing required field ${key}.`);
  }
  if (type === "snapshot") {
    assertBoundedString(payload, "chatId", 128);
    assertBoundedString(payload, "turnId", 128);
    if (!Number.isSafeInteger(payload.nextSequence) || (payload.nextSequence as number) < 1) throw new Error("snapshot nextSequence must be positive.");
  } else if (type === "status") {
    const state = requiredString(payload, "state");
    if (!["queued", "running", "waiting_for_approval", "reconciling"].includes(state)) throw new Error("status state is invalid.");
  } else if (type === "text_delta" || type === "reasoning_delta") {
    assertBoundedString(payload, "text", 200_000);
  } else if (type === "tool_started") {
    assertBoundedString(payload, "toolId", 128);
    assertBoundedString(payload, "name", 120);
  } else if (type === "tool_finished") {
    assertBoundedString(payload, "toolId", 128);
    if (!["succeeded", "failed", "cancelled"].includes(requiredString(payload, "status"))) throw new Error("tool status is invalid.");
  } else if (type === "timeline") {
    if (!parseGenerationTimeline(payload.timeline)) {
      throw new Error("timeline payload must contain a renderer-safe generation timeline.");
    }
  } else if (type === "approval_required") {
    assertBoundedString(payload, "approvalId", 128);
    assertBoundedString(payload, "summary", 2_000);
    parseStrictRfc3339(requiredString(payload, "expiresAt"), "Approval expiry");
  } else if (type === "done") {
    assertBoundedString(payload, "messageId", 128);
  } else if (type === "error") {
    const code = assertBoundedString(payload, "code", 80);
    if (!(AIDEN_REMOTE_ERROR_CODES as readonly string[]).includes(code)) throw new Error("stream error code is invalid.");
    assertBoundedString(payload, "message", 2_000);
  } else if (type === "cancelled") {
    if (!["device", "server"].includes(requiredString(payload, "source"))) throw new Error("cancellation source is invalid.");
  }
}

function assertBase64Url32(value: string, label: string): void {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value) || Buffer.from(value, "base64url").length !== 32) {
    throw new Error(`${label} must encode exactly 32 random bytes as unpadded base64url.`);
  }
}

function isCanonicalAidenIPv4(value: string): boolean {
  const octets = value.split(".");
  return octets.length === 4 && octets.every((octet) => {
    if (!/^(?:0|[1-9][0-9]{0,2})$/u.test(octet)) return false;
    const number = Number(octet);
    return number >= 0 && number <= 255;
  });
}

function parseAidenIPv6Side(value: string): number | null {
  if (!value) return 0;
  const groups = value.split(":");
  if (groups.some((group) => group.length === 0)) return null;
  let count = 0;
  for (const [index, group] of groups.entries()) {
    if (group.includes(".")) {
      if (index !== groups.length - 1 || !isCanonicalAidenIPv4(group)) return null;
      count += 2;
    } else {
      if (!/^[0-9A-Fa-f]{1,4}$/u.test(group)) return null;
      count += 1;
    }
  }
  return count;
}

function isCanonicalAidenIPv6(value: string): boolean {
  if (!value || !/^[0-9A-Fa-f:.]+$/u.test(value)) return false;
  const sides = value.split("::");
  if (sides.length > 2) return false;
  if (sides.length === 2) {
    if (sides[0]!.includes(".")) return false;
    const left = parseAidenIPv6Side(sides[0]!);
    const right = parseAidenIPv6Side(sides[1]!);
    return left !== null && right !== null && left + right < 8;
  }
  return parseAidenIPv6Side(value) === 8;
}

function isCanonicalAidenDnsHost(value: string): boolean {
  if (!value || value.length > 253) return false;
  const labels = value.split(".");
  if (labels.some((label) => label.length === 0 || label.length > 63)) return false;
  if (labels.every((label) => /^[0-9]+$/u.test(label))) {
    // Numeric-only authorities are ambiguous under WHATWG URL parsing. Keep
    // only canonical dotted-decimal IPv4 rather than letting `123` become
    // `0.0.0.123` on one platform and a DNS name on another.
    return isCanonicalAidenIPv4(value);
  }
  // A DNS authority must not end in a numeric-only label. This keeps
  // `aiden.123` distinct from canonical IPv4 while retaining numeric labels
  // in non-terminal positions.
  if (/^[0-9]+$/u.test(labels[labels.length - 1]!)) return false;
  return labels.every((label) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/u.test(label));
}

function isCanonicalAidenPort(value: string): boolean {
  if (!/^[1-9][0-9]{0,4}$/u.test(value)) return false;
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= AIDEN_REMOTE_MAX_ENDPOINT_PORT;
}

function isCanonicalAidenAuthority(value: string): boolean {
  // Keep the raw grammar ASCII-only. This rejects C0/DEL, all Unicode
  // whitespace and normalization-sensitive host spellings before either URL
  // implementation can decode or normalize them.
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint > 0x7f || codePoint <= 0x20 || codePoint === 0x7f) return false;
  }

  let host: string;
  let rawPort: string | undefined;
  if (value.startsWith("[")) {
    const closingBracket = value.indexOf("]");
    if (closingBracket <= 1 || value.indexOf("[", 1) >= 0 || value.indexOf("]", closingBracket + 1) >= 0) return false;
    host = value.slice(1, closingBracket);
    const suffix = value.slice(closingBracket + 1);
    if (suffix) {
      if (!suffix.startsWith(":")) return false;
      rawPort = suffix.slice(1);
    }
    if (!isCanonicalAidenIPv6(host)) return false;
  } else {
    if (value.includes("[") || value.includes("]")) return false;
    const firstColon = value.indexOf(":");
    if (firstColon >= 0) {
      if (firstColon !== value.lastIndexOf(":")) return false;
      host = value.slice(0, firstColon);
      rawPort = value.slice(firstColon + 1);
    } else {
      host = value;
    }
    if (!isCanonicalAidenDnsHost(host)) return false;
  }

  return rawPort === undefined || isCanonicalAidenPort(rawPort);
}

function hasCanonicalRawEndpointSyntax(value: string): boolean {
  // WHATWG URL parsing removes raw and percent-encoded dot segments and
  // normalizes empty trailing query/fragment markers. Match the complete wire
  // syntax first so only one exact HTTPS endpoint spelling reaches URL parsing.
  const match = /^https:\/\/([^/?#]+)\/api\/aiden\/v1$/u.exec(value);
  if (!match) return false;

  const authority = match[1]!;
  return isCanonicalAidenAuthority(authority);
}

export function assertAidenRemoteEndpoint(value: string): void {
  if (Buffer.byteLength(value, "utf8") > AIDEN_REMOTE_MAX_ENDPOINT_UTF8_BYTES) {
    throw new Error(`Pairing endpoint exceeds ${AIDEN_REMOTE_MAX_ENDPOINT_UTF8_BYTES} UTF-8 bytes.`);
  }
  if (!hasCanonicalRawEndpointSyntax(value)) {
    throw new Error("Pairing endpoint must be the canonical HTTPS Aiden v1 URL.");
  }
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error("Pairing endpoint must be the canonical HTTPS Aiden v1 URL.");
  }
  if (
    endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search ||
    endpoint.hash || endpoint.pathname !== AIDEN_REMOTE_BASE_PATH
  ) throw new Error("Pairing endpoint must be the canonical HTTPS Aiden v1 URL.");
}

export function parseAidenRemoteStreamEvent(value: unknown): AidenRemoteStreamEvent | null {
  if (!isRecord(value)) throw new Error("Aiden Remote event must be an object.");
  if ("payload" in value && !isRecord(value.payload)) {
    throw new Error("Aiden Remote event payload must be an object.");
  }
  if (value.protocolVersion !== AIDEN_REMOTE_PROTOCOL_VERSION) {
    throw new Error("Aiden Remote event has an unsupported protocolVersion.");
  }
  const streamId = assertBoundedString(value, "streamId", 128);
  const sequence = requiredInteger(value, "sequence");
  if (sequence < 1) throw new Error("Aiden Remote event sequence must be positive.");
  const timestamp = requiredString(value, "timestamp");
  parseStrictRfc3339(timestamp, "Aiden Remote event timestamp");
  const type = assertBoundedString(value, "type", 80);
  if (typeof value.terminal !== "boolean") throw new Error("Aiden Remote event terminal must be boolean.");
  if (!isRecord(value.payload)) throw new Error("Aiden Remote event payload must be an object.");
  if (Object.keys(value.payload).length > 32) throw new Error("Aiden Remote event payload has too many properties.");
  if (!(AIDEN_REMOTE_EVENT_TYPES as readonly string[]).includes(type)) {
    if (value.terminal) throw new Error(`Unknown terminal Aiden Remote event type ${type}.`);
    assertNoForbiddenWireKeys(value, "event");
    return null;
  }
  const knownType = type as AidenRemoteEventType;
  if (value.terminal !== TERMINAL_EVENT_TYPES.has(knownType)) {
    throw new Error(`Aiden Remote event ${type} has an invalid terminal classification.`);
  }
  validateEventPayload(knownType, value.payload);
  assertNoForbiddenWireKeys(value, "event");
  return {
    protocolVersion: AIDEN_REMOTE_PROTOCOL_VERSION,
    streamId,
    sequence,
    timestamp,
    type: knownType,
    terminal: value.terminal,
    payload: value.payload,
  };
}

export function assertOrderedAidenRemoteEvents(events: readonly AidenRemoteStreamEvent[]): void {
  const lastByStream = new Map<string, number>();
  const terminalStreams = new Set<string>();
  for (const event of events) {
    if (terminalStreams.has(event.streamId)) {
      throw new Error(`Aiden Remote stream ${event.streamId} contains an event after terminal state.`);
    }
    const previous = lastByStream.get(event.streamId) ?? 0;
    if (event.sequence !== previous + 1) {
      throw new Error(
        `Aiden Remote stream ${event.streamId} expected sequence ${previous + 1}, received ${event.sequence}.`,
      );
    }
    lastByStream.set(event.streamId, event.sequence);
    if (event.terminal) {
      terminalStreams.add(event.streamId);
    }
  }
}

export function parseAidenRemoteContractFixture(value: unknown): AidenRemoteContractFixture {
  if (!isRecord(value)) throw new Error("Aiden Remote contract fixture must be an object.");
  assertNoPrivateBotWireFields(value);
  if (value.protocolVersion !== AIDEN_REMOTE_PROTOCOL_VERSION) {
    throw new Error("Aiden Remote contract fixture protocolVersion must be 1.");
  }
  const contractRevision = requiredInteger(value, "contractRevision");
  if (contractRevision < 8) {
    throw new Error("The canonical Bot fixture requires contractRevision 8 or newer.");
  }
  if (value.generated !== false) throw new Error("The canonical fixture must be synthetic.");
  const fixtureNotice = boundedText(value.notice, "Fixture notice", 280);
  const capabilities = parseCapabilityList(value.capabilities, "fixture");
  if (!isRecord(value.health) || value.health.ok !== true || value.health.protocolVersion !== 1) {
    throw new Error("Fixture health response is invalid.");
  }
  assertExactKeys(value.health, ["ok", "protocolVersion"], "Fixture health response");
  if (!isRecord(value.pairingBootstrap)) {
    throw new Error("Fixture pairing bootstrap is invalid.");
  }
  const pairingBootstrap = value.pairingBootstrap;
  assertExactKeys(
    pairingBootstrap,
    ["protocolVersion", "instanceId", "endpoint", "serverSpkiSha256", "secret", "expiresAt"],
    "Fixture pairing bootstrap",
  );
  if (pairingBootstrap.protocolVersion !== AIDEN_REMOTE_PROTOCOL_VERSION) {
    throw new Error("Fixture pairing bootstrap protocolVersion must be 1.");
  }
  const instanceId = assertBoundedString(pairingBootstrap, "instanceId", AIDEN_REMOTE_MAX_IDENTIFIER_LENGTH);
  const endpoint = requiredString(pairingBootstrap, "endpoint");
  const fingerprint = requiredString(pairingBootstrap, "serverSpkiSha256");
  const secret = requiredString(pairingBootstrap, "secret");
  assertAidenRemoteEndpoint(endpoint);
  if (!/^sha256\/[A-Za-z0-9+/]{43}=$/.test(fingerprint)) {
    throw new Error("Pairing bootstrap fingerprint must be a SHA-256 SPKI digest.");
  }
  assertBase64Url32(secret, "Pairing bootstrap secret");
  const expiresAt = requiredString(pairingBootstrap, "expiresAt");
  const expiryTime = parseStrictRfc3339(expiresAt, "Pairing bootstrap expiry");
  if (!isRecord(value.server) || typeof value.server.serverTime !== "string") {
    throw new Error("Fixture serverTime must be a strict RFC 3339 date-time.");
  }
  const server = value.server;
  assertExactKeys(
    server,
    [
      "protocolVersion",
      "instanceId",
      "name",
      "appVersion",
      "capabilities",
      "serverCapabilities",
      "connectionMode",
      "minimumClientVersion",
      "serverTime",
    ],
    "Fixture server projection",
  );
  if (server.protocolVersion !== AIDEN_REMOTE_PROTOCOL_VERSION) {
    throw new Error("Fixture server protocolVersion must be 1.");
  }
  if (assertBoundedString(server, "instanceId", AIDEN_REMOTE_MAX_IDENTIFIER_LENGTH) !== instanceId) {
    throw new Error("Fixture server instance does not match bootstrap.");
  }
  assertBoundedString(server, "name", 80);
  assertBoundedString(server, "appVersion", 40);
  if (server.minimumClientVersion !== undefined) {
    assertBoundedString(server, "minimumClientVersion", 40);
  }
  const deviceCapabilities = parseCapabilityList(server.capabilities, "server device-grant");
  const serverCapabilities = parseCapabilityList(server.serverCapabilities, "server-supported");
  if (!deviceCapabilities.every((capability) => serverCapabilities.includes(capability))) {
    throw new Error("Fixture device capabilities must be a subset of server-supported capabilities.");
  }
  if (!(["lan", "tailscale", "both"] as const).includes(server.connectionMode as never)) {
    throw new Error("Fixture server connectionMode is invalid.");
  }
  const serverTime = parseStrictRfc3339(
    requiredString(server, "serverTime"),
    "Fixture serverTime",
  );
  if (expiryTime <= serverTime) throw new Error("Pairing bootstrap must not be expired.");
  if (expiryTime - serverTime > 5 * 60_000) throw new Error("Pairing bootstrap TTL must not exceed five minutes.");
  if (!isRecord(value.pairingExchange)) throw new Error("Fixture pairing exchange is invalid.");
  const pairingExchange = value.pairingExchange;
  assertExactKeys(
    pairingExchange,
    ["protocolVersion", "instanceId", "deviceId", "credential", "capabilities", "displayName", "endpoint", "serverSpkiSha256"],
    "Fixture pairing exchange",
  );
  if (pairingExchange.protocolVersion !== 1) throw new Error("Pairing exchange protocolVersion must be 1.");
  if (assertBoundedString(pairingExchange, "instanceId", AIDEN_REMOTE_MAX_IDENTIFIER_LENGTH) !== instanceId) throw new Error("Pairing exchange instance does not match bootstrap.");
  assertBoundedString(pairingExchange, "deviceId", AIDEN_REMOTE_MAX_IDENTIFIER_LENGTH);
  assertBase64Url32(requiredString(pairingExchange, "credential"), "Pairing device credential");
  const exchangeCapabilities = parseCapabilityList(
    pairingExchange.capabilities,
    "pairing",
  );
  if (
    exchangeCapabilities.length !== deviceCapabilities.length ||
    exchangeCapabilities.some((capability, index) => capability !== deviceCapabilities[index])
  ) {
    throw new Error("Pairing exchange and server device capabilities must match.");
  }
  assertBoundedString(pairingExchange, "displayName", 80);
  if (requiredString(pairingExchange, "endpoint") !== endpoint || requiredString(pairingExchange, "serverSpkiSha256") !== fingerprint) throw new Error("Pairing exchange identity does not match bootstrap.");

  const chat = parseAidenRemoteChatProjection(value.chat, "Fixture Chat response");
  const botSummary = parseBotSummary(value.botSummary);
  const botList = parseBotList(value.botList);
  const botDetail = parseBotDetail(value.botDetail);
  const botAvatar = parseBotAvatarView(value.botAvatar);
  const botCreateRecord = isRecord(value.botCreate) ? value.botCreate : null;
  if (!botCreateRecord) throw new Error("Bot create fixture must be an object.");
  assertExactKeys(botCreateRecord, ["request", "response"], "Bot create fixture");
  const botCreate: AidenRemoteBotCreateFixture = {
    request: parseBotCreateRequest(botCreateRecord.request),
    response: parseBotDetail(botCreateRecord.response),
  };
  const botIdentityRecord = isRecord(value.botIdentity) ? value.botIdentity : null;
  if (!botIdentityRecord) throw new Error("Bot identity fixture must be an object.");
  assertExactKeys(botIdentityRecord, ["request", "response"], "Bot identity fixture");
  const botIdentity: AidenRemoteBotIdentityFixture = {
    request: parseBotIdentityPatch(botIdentityRecord.request),
    response: parseBotDetail(botIdentityRecord.response),
  };
  const botArchive = parseBotDetail(value.botArchive);
  const botRestore = parseBotDetail(value.botRestore);
  const botConversation = parseBotConversationItem(value.botConversation);
  const botConversations = parseBotConversationPage(value.botConversations);
  const botConversationQuery = parseBotConversationQuery(value.botConversationQuery);
  const botChatCreateRecord = isRecord(value.botChatCreate) ? value.botChatCreate : null;
  if (!botChatCreateRecord) throw new Error("Bot chat create fixture must be an object.");
  assertExactKeys(
    botChatCreateRecord,
    ["request", "response"],
    "Bot chat create fixture",
  );
  const botChatCreate: AidenRemoteBotChatCreateFixture = {
    request: parseBotChatCreateRequest(botChatCreateRecord.request),
    response: parseAidenRemoteChatProjection(
      botChatCreateRecord.response,
      "Bot chat create response",
    ),
  };
  const botCapabilityCatalog = parseBotCapabilityCatalog(value.botCapabilityCatalog);
  const botPolicy = parseBotAccessView(value.botPolicy);
  const botPolicyUpdateRecord = isRecord(value.botPolicyUpdate)
    ? value.botPolicyUpdate
    : null;
  if (!botPolicyUpdateRecord) throw new Error("Bot policy update fixture must be an object.");
  assertExactKeys(
    botPolicyUpdateRecord,
    ["request", "response"],
    "Bot policy update fixture",
  );
  const botPolicyUpdate: AidenRemoteBotPolicyUpdateFixture = {
    request: parseBotAccessUpdateRequest(botPolicyUpdateRecord.request),
    response: parseBotAccessView(botPolicyUpdateRecord.response),
  };
  const botChatSubset = parseBotChatAccessView(value.botChatSubset);
  const botChatSubsetUpdateRecord = isRecord(value.botChatSubsetUpdate)
    ? value.botChatSubsetUpdate
    : null;
  if (!botChatSubsetUpdateRecord) {
    throw new Error("Bot chat subset update fixture must be an object.");
  }
  assertExactKeys(
    botChatSubsetUpdateRecord,
    ["request", "response"],
    "Bot chat subset update fixture",
  );
  const botChatSubsetUpdate: AidenRemoteBotChatSubsetUpdateFixture = {
    request: parseBotChatAccessUpdateRequest(botChatSubsetUpdateRecord.request),
    response: parseBotChatAccessView(botChatSubsetUpdateRecord.response),
  };
  const botFavorites = parseBotFavoritesView(value.botFavorites);
  const botFavoritesUpdateRecord = isRecord(value.botFavoritesUpdate)
    ? value.botFavoritesUpdate
    : null;
  if (!botFavoritesUpdateRecord) {
    throw new Error("Bot favorites update fixture must be an object.");
  }
  assertExactKeys(
    botFavoritesUpdateRecord,
    ["request", "response"],
    "Bot favorites update fixture",
  );
  const botFavoritesUpdate: AidenRemoteBotFavoritesUpdateFixture = {
    request: parseBotFavoritesUpdateRequest(botFavoritesUpdateRecord.request),
    response: parseBotFavoritesView(botFavoritesUpdateRecord.response),
  };
  const botNotice = parseBotAccessNoticeStatus(value.botNotice);
  const botNoticeAcknowledgementRecord = isRecord(value.botNoticeAcknowledgement)
    ? value.botNoticeAcknowledgement
    : null;
  if (!botNoticeAcknowledgementRecord) {
    throw new Error("Bot notice acknowledgement fixture must be an object.");
  }
  assertExactKeys(
    botNoticeAcknowledgementRecord,
    ["request", "response"],
    "Bot notice acknowledgement fixture",
  );
  const botNoticeAcknowledgement: AidenRemoteBotNoticeAcknowledgementFixture = {
    request: parseBotNoticeAcknowledgementRequest(
      botNoticeAcknowledgementRecord.request,
    ),
    response: parseBotAccessNoticeStatus(botNoticeAcknowledgementRecord.response),
  };
  const botAvatarUploadRecord = isRecord(value.botAvatarUpload)
    ? value.botAvatarUpload
    : null;
  if (!botAvatarUploadRecord) throw new Error("Bot avatar upload fixture must be an object.");
  assertExactKeys(
    botAvatarUploadRecord,
    ["request", "response"],
    "Bot avatar upload fixture",
  );
  const botAvatarUpload: AidenRemoteBotAvatarUploadFixture = {
    request: parseBotAvatarUploadRequest(botAvatarUploadRecord.request),
    response: parseBotAvatarAsset(botAvatarUploadRecord.response),
  };
  const botAvatarMetadata = parseBotAvatarAsset(value.botAvatarMetadata);
  const legacyNonNegotiating = parseLegacyNonNegotiatingFixture(
    value.legacyNonNegotiating,
    { instanceId },
  );

  const canonicalBotId = botSummary.id;
  const canonicalDetails = [
    botDetail,
    botCreate.response,
    botIdentity.response,
    botArchive,
    botRestore,
  ];
  if (
    canonicalDetails.some((detail) => detail.id !== canonicalBotId) ||
    !botList.bots.some((summary) => summary.id === canonicalBotId)
  ) {
    throw new Error("Canonical Bot fixture identities do not agree.");
  }
  const summaryProjections: AidenRemoteBotSummary[] = [
    botSummary,
    ...botList.bots,
    botDetail,
  ];
  for (let leftIndex = 0; leftIndex < summaryProjections.length; leftIndex += 1) {
    const left = summaryProjections[leftIndex]!;
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < summaryProjections.length;
      rightIndex += 1
    ) {
      const right = summaryProjections[rightIndex]!;
      if (
        left.id === right.id &&
        left.revision === right.revision &&
        !botSummaryFieldsEqual(left, right)
      ) {
        throw new Error(
          "Same-revision Bot summary, list, and detail projections do not agree.",
        );
      }
    }
  }
  if (
    botCreate.response.name !== botCreate.request.name ||
    botCreate.response.purpose !== botCreate.request.purpose ||
    botCreate.response.instructions !== botCreate.request.instructions ||
    botCreate.response.openingGreeting !== botCreate.request.openingGreeting ||
    JSON.stringify(botCreate.response.avatar.semantic) !==
      JSON.stringify(botCreate.request.avatar)
  ) {
    throw new Error("Bot create response does not apply the exact requested identity.");
  }
  if (
    (botIdentity.request.name !== undefined &&
      botIdentity.response.name !== botIdentity.request.name) ||
    (botIdentity.request.purpose !== undefined &&
      botIdentity.response.purpose !== botIdentity.request.purpose) ||
    (botIdentity.request.instructions !== undefined &&
      botIdentity.response.instructions !== botIdentity.request.instructions) ||
    (botIdentity.request.avatar !== undefined &&
      JSON.stringify(botIdentity.response.avatar.semantic) !==
        JSON.stringify(botIdentity.request.avatar)) ||
    (botIdentity.request.openingGreeting !== undefined &&
      (botIdentity.request.openingGreeting === ""
        ? botIdentity.response.openingGreeting !== undefined
        : botIdentity.response.openingGreeting !==
          botIdentity.request.openingGreeting))
  ) {
    throw new Error("Bot identity response does not apply the exact requested patch.");
  }
  if (
    !botIdentityFieldsEqual(botIdentity.response, botArchive) ||
    !botIdentityFieldsEqual(botArchive, botRestore)
  ) {
    throw new Error(
      "Bot identity and avatar must survive archive and restore unchanged.",
    );
  }
  if (botArchive.health !== "archived" || botRestore.health === "archived") {
    throw new Error("Bot archive and restore fixtures have invalid health states.");
  }
  if (
    botConversation.botId !== canonicalBotId ||
    botConversations.conversations.some(
      (conversation) => !botList.bots.some((bot) => bot.id === conversation.botId),
    ) ||
    (botConversationQuery.botId !== undefined &&
      !botList.bots.some((bot) => bot.id === botConversationQuery.botId)) ||
    botChatCreate.response.botId !== canonicalBotId
  ) {
    throw new Error("Canonical Bot conversation identities do not agree.");
  }
  const matchingConversation = botConversations.conversations.find(
    (conversation) =>
      conversation.chatId === botConversation.chatId &&
      conversation.revision === botConversation.revision,
  );
  if (
    !matchingConversation ||
    JSON.stringify(matchingConversation) !== JSON.stringify(botConversation)
  ) {
    throw new Error(
      "Same-revision Bot conversation and page projections do not agree.",
    );
  }
  if (
    chat.botId !== canonicalBotId ||
    (botChatCreate.request.providerId !== undefined &&
      botChatCreate.response.providerId !== botChatCreate.request.providerId) ||
    (botChatCreate.request.modelId !== undefined &&
      botChatCreate.response.modelId !== botChatCreate.request.modelId)
  ) {
    throw new Error("Canonical Chat response selections or Bot identity do not agree.");
  }
  if (
    botPolicy.botId !== canonicalBotId ||
    botPolicyUpdate.response.botId !== canonicalBotId ||
    botDetail.access.botId !== canonicalBotId ||
    (botPolicy.revision === botDetail.access.revision &&
      !botAccessViewsEqual(botPolicy, botDetail.access))
  ) {
    throw new Error("Canonical Bot policy identities do not agree.");
  }
  if (JSON.stringify(botAvatar) !== JSON.stringify(botDetail.avatar)) {
    throw new Error("Canonical Bot avatar and detail projections do not agree.");
  }
  assertAvailableBotChatModel(
    botChatCreate.request.providerId,
    botChatCreate.request.modelId,
    botCapabilityCatalog,
    "Bot chat create request",
  );
  assertAvailableBotChatModel(
    botChatCreate.response.providerId,
    botChatCreate.response.modelId,
    botCapabilityCatalog,
    "Bot chat create response",
  );
  assertAvailableBotChatModel(
    chat.providerId,
    chat.modelId,
    botCapabilityCatalog,
    "Canonical Bot Chat",
  );
  const responseSelections: Array<
    readonly [string, AidenRemoteBotCustomSelection | undefined]
  > = [
    ["Bot detail", botDetail.access.custom],
    ["Bot create response", botCreate.response.access.custom],
    ["Bot identity response", botIdentity.response.access.custom],
    ["Bot archive response", botArchive.access.custom],
    ["Bot restore response", botRestore.access.custom],
    ["Bot policy", botPolicy.custom],
    ["Bot policy update response", botPolicyUpdate.response.custom],
    ["Bot chat subset", botChatSubset.custom],
    ["Bot chat subset update response", botChatSubsetUpdate.response.custom],
  ];
  for (const [label, selection] of responseSelections) {
    if (selection) {
      validateBotSelectionAgainstCatalog(
        selection,
        botCapabilityCatalog,
        label,
        false,
      );
    }
  }
  const requestSelections: Array<
    readonly [string, AidenRemoteBotCustomSelection | undefined]
  > = [
    [
      "Bot create request",
      botCreate.request.access.accessMode === "custom"
        ? botCreate.request.access.custom
        : undefined,
    ],
    [
      "Bot policy update request",
      botPolicyUpdate.request.accessMode === "custom"
        ? botPolicyUpdate.request.custom
        : undefined,
    ],
    [
      "Bot chat subset update request",
      botChatSubsetUpdate.request.mode === "custom"
        ? botChatSubsetUpdate.request.custom
        : undefined,
    ],
  ];
  for (const [label, selection] of requestSelections) {
    if (selection) {
      validateBotSelectionAgainstCatalog(
        selection,
        botCapabilityCatalog,
        label,
        true,
      );
    }
  }
  for (const [label, revision] of [
    ["Bot create request", botCreate.request.access.catalogRevision],
    ["Bot policy update request", botPolicyUpdate.request.catalogRevision],
    ["Bot chat subset update request", botChatSubsetUpdate.request.catalogRevision],
  ] as const) {
    if (revision !== botCapabilityCatalog.revision) {
      throw new Error(`${label} does not target the canonical catalog revision.`);
    }
  }
  assertBotAccessRequestMatchesView(
    botCreate.request.access,
    botCreate.response.access,
    "Bot create",
  );
  assertBotAccessRequestMatchesView(
    botPolicyUpdate.request,
    botPolicyUpdate.response,
    "Bot policy update",
  );
  if (botChatSubset.botPolicyRevision !== botPolicy.revision) {
    throw new Error("Bot chat subset does not target the current Bot policy revision.");
  }
  if (
    botChatSubsetUpdate.request.expectedBotPolicyRevision !==
      botChatSubsetUpdate.response.botPolicyRevision ||
    botChatSubsetUpdate.request.expectedBotPolicyRevision !==
      botPolicyUpdate.response.revision
  ) {
    throw new Error("Bot chat subset update Bot policy revisions do not agree.");
  }
  if (botChatSubsetUpdate.request.mode !== botChatSubsetUpdate.response.mode) {
    throw new Error("Bot chat subset update request and response modes do not agree.");
  }
  if (
    botChatSubsetUpdate.request.mode === "custom" &&
    (botChatSubsetUpdate.response.mode !== "custom" ||
      !botSelectionsEqual(
        botChatSubsetUpdate.request.custom,
        botChatSubsetUpdate.response.custom,
      ))
  ) {
    throw new Error(
      "Bot chat subset update request and response Custom selections do not agree.",
    );
  }
  if (botChatSubset.mode === "custom") {
    validateBotChatSelectionAgainstPolicy(
      botChatSubset.custom,
      botPolicy,
      "Bot chat subset",
    );
  }
  if (botChatSubsetUpdate.request.mode === "custom") {
    validateBotChatSelectionAgainstPolicy(
      botChatSubsetUpdate.request.custom,
      botPolicyUpdate.response,
      "Bot chat subset update request",
    );
  }
  if (botChatSubsetUpdate.response.mode === "custom") {
    validateBotChatSelectionAgainstPolicy(
      botChatSubsetUpdate.response.custom,
      botPolicyUpdate.response,
      "Bot chat subset update response",
    );
  }
  const chatFixtureIdentities = [botChatSubset, botChatSubsetUpdate.response];
  if (
    chatFixtureIdentities.some(
      (view) => view.chatId !== botConversation.chatId || view.botId !== canonicalBotId,
    )
  ) {
    throw new Error("Canonical Bot chat-subset identities do not agree.");
  }
  if (
    JSON.stringify(botList.favorites) !== JSON.stringify(botFavorites) ||
    JSON.stringify(botFavoritesUpdate.response) !== JSON.stringify(botFavorites) ||
    JSON.stringify(botFavoritesUpdate.request.botIds) !==
      JSON.stringify(botFavoritesUpdate.response.botIds) ||
    botFavoritesUpdate.request.botIds.some(
      (botId) => !botList.bots.some((bot) => bot.id === botId),
    )
  ) {
    throw new Error("Canonical Bot favorites fixtures do not agree.");
  }
  if (
    JSON.stringify(botCapabilityCatalog.notice) !== JSON.stringify(botNotice) ||
    botNoticeAcknowledgement.request.version !== botNotice.version ||
    botNoticeAcknowledgement.response.version !== botNotice.version ||
    botNoticeAcknowledgement.response.requiresAcknowledgement ||
    botNoticeAcknowledgement.response.acceptedDecision !==
      botNoticeAcknowledgement.request.decision
  ) {
    throw new Error("Canonical Bot notice fixtures do not agree.");
  }
  if (
    JSON.stringify(botAvatarUpload.response) !== JSON.stringify(botAvatarMetadata) ||
    (botAvatar.asset !== undefined &&
      JSON.stringify(botAvatar.asset) !== JSON.stringify(botAvatarMetadata))
  ) {
    throw new Error("Canonical Bot avatar metadata fixtures do not agree.");
  }
  if (!Array.isArray(value.events)) throw new Error("Fixture events must be an array.");
  const events = value.events.map(parseAidenRemoteStreamEvent).filter((event): event is AidenRemoteStreamEvent => event !== null);
  assertOrderedAidenRemoteEvents(events);
  if (!isRecord(value.error) || !isRecord(value.error.error)) {
    throw new Error("Fixture error envelope is invalid.");
  }
  assertExactKeys(value.error, ["error"], "Error envelope");
  const errorBody = value.error.error;
  assertExactKeys(errorBody, ["code", "message", "requestId", "retryable", "details"], "Error envelope error");
  const code = requiredString(errorBody, "code");
  if (!(AIDEN_REMOTE_ERROR_CODES as readonly string[]).includes(code)) {
    throw new Error(`Unknown Aiden Remote error code ${code}.`);
  }
  if (characterLength(requiredString(errorBody, "message")) > 2_000) throw new Error("Error message is too long.");
  if (characterLength(requiredString(errorBody, "requestId")) > 128) throw new Error("Error requestId is too long.");
  if (typeof errorBody.retryable !== "boolean") throw new Error("Error retryable must be boolean.");
  if (errorBody.details !== undefined) {
    if (!isRecord(errorBody.details)) throw new Error("Error details must be an object.");
    assertExactKeys(errorBody.details, ["currentRevision", "retryAfterSeconds", "chatId", "minimumClientVersion", "limit", "field"], "Error details");
    const stringDetailMaxima = {
      currentRevision: 128,
      chatId: 128,
      minimumClientVersion: 40,
      field: 120,
    } as const;
    for (const [key, maximum] of Object.entries(stringDetailMaxima)) {
      const detail = errorBody.details[key];
      if (detail !== undefined && (typeof detail !== "string" || detail.length === 0 || characterLength(detail) > maximum)) throw new Error(`Error detail ${key} is invalid.`);
    }
    const boundedNumericDetails = {
      retryAfterSeconds: 86_400,
      limit: 1_000_000,
    } as const;
    for (const [key, maximum] of Object.entries(boundedNumericDetails)) {
      const detail = errorBody.details[key];
      if (detail !== undefined && (!Number.isSafeInteger(detail) || (detail as number) < 0 || (detail as number) > maximum)) throw new Error(`Error detail ${key} is invalid.`);
    }
  }
  assertNoForbiddenWireKeys(value);
  return {
    ...value,
    contractRevision,
    protocolVersion: AIDEN_REMOTE_PROTOCOL_VERSION,
    generated: false,
    notice: fixtureNotice,
    capabilities,
    health: { ok: true, protocolVersion: AIDEN_REMOTE_PROTOCOL_VERSION },
    pairingBootstrap: pairingBootstrap as unknown as AidenRemoteContractFixture["pairingBootstrap"],
    pairingExchange: { ...(pairingExchange as unknown as AidenRemoteContractFixture["pairingExchange"]), capabilities: exchangeCapabilities },
    server: {
      ...(server as unknown as AidenRemoteContractFixture["server"]),
      capabilities: deviceCapabilities,
      serverCapabilities,
    },
    workspaces: value.workspaces,
    browser: value.browser,
    chat,
    turnStart: value.turnStart,
    streamStatus: value.streamStatus,
    streamApproval: value.streamApproval,
    fileIndex: value.fileIndex,
    fileDocument: value.fileDocument,
    git: value.git,
    scheduledTask: value.scheduledTask,
    scheduleSettings: value.scheduleSettings,
    scheduleRunAccepted: value.scheduleRunAccepted,
    scheduleRun: value.scheduleRun,
    botSummary,
    botList,
    botDetail,
    botAvatar,
    botCreate,
    botIdentity,
    botArchive,
    botRestore,
    botConversation,
    botConversations,
    botConversationQuery,
    botChatCreate,
    botCapabilityCatalog,
    botPolicy,
    botPolicyUpdate,
    botChatSubset,
    botChatSubsetUpdate,
    botFavorites,
    botFavoritesUpdate,
    botNotice,
    botNoticeAcknowledgement,
    botAvatarUpload,
    botAvatarMetadata,
    legacyNonNegotiating,
    events,
    error: value.error as unknown as AidenRemoteErrorEnvelope,
  };
}

export interface AidenSseFrame { id: string; data: unknown }

/**
 * JSON.parse keeps only the last occurrence of a duplicate object key. Scan
 * the raw JSON first so that no duplicate can hide an SSE envelope field.
 * Keys are decoded while scanning, which also catches escaped-equivalent
 * spellings such as "a" and "\\u0061" at every nesting level.
 */
export function parseAidenRemoteJson(
  serialized: string,
  label = "JSON data",
): unknown {
  let offset = 0;
  let objectKeys = 0;

  function fail(): never {
    throw new Error(`Malformed Aiden ${label}.`);
  }

  function skipWhitespace(): void {
    while (serialized[offset] === " " || serialized[offset] === "\t" || serialized[offset] === "\n" || serialized[offset] === "\r") {
      offset += 1;
    }
  }

  function readString(decode: boolean): string | undefined {
    if (serialized[offset] !== '"') fail();
    offset += 1;
    let segmentStart = offset;
    let decoded = "";
    while (offset < serialized.length) {
      const character = serialized[offset]!;
      if (character === '"') {
        decoded += serialized.slice(segmentStart, offset);
        if (!isValidJsonString(decoded)) fail();
        offset += 1;
        return decode ? decoded : undefined;
      }
      if (character === "\\") {
        decoded += serialized.slice(segmentStart, offset);
        offset += 1;
        const escaped = serialized[offset];
        if (escaped === undefined) fail();
        if (escaped === "u") {
          const hexadecimal = serialized.slice(offset + 1, offset + 5);
          if (!/^[0-9a-fA-F]{4}$/u.test(hexadecimal)) fail();
          decoded += String.fromCharCode(Number.parseInt(hexadecimal, 16));
          offset += 5;
          segmentStart = offset;
          continue;
        }
        const replacement = escaped === '"'
          ? '"'
          : escaped === "\\"
            ? "\\"
            : escaped === "/"
              ? "/"
              : escaped === "b"
                ? "\b"
                : escaped === "f"
                  ? "\f"
                  : escaped === "n"
                    ? "\n"
                    : escaped === "r"
                      ? "\r"
                      : escaped === "t"
                        ? "\t"
                        : undefined;
        if (replacement === undefined) fail();
        decoded += replacement;
        offset += 1;
        segmentStart = offset;
        continue;
      }
      if (character.charCodeAt(0) < 0x20) fail();
      offset += 1;
    }
    fail();
  }

  function readNumber(): void {
    const numberStart = offset;
    if (serialized[offset] === "-") offset += 1;
    if (serialized[offset] === "0") {
      offset += 1;
    } else {
      const first = serialized.charCodeAt(offset);
      if (first < 0x31 || first > 0x39) fail();
      do {
        offset += 1;
      } while (serialized.charCodeAt(offset) >= 0x30 && serialized.charCodeAt(offset) <= 0x39);
    }
    if (serialized[offset] === ".") {
      offset += 1;
      const firstFraction = serialized.charCodeAt(offset);
      if (firstFraction < 0x30 || firstFraction > 0x39) fail();
      do {
        offset += 1;
      } while (serialized.charCodeAt(offset) >= 0x30 && serialized.charCodeAt(offset) <= 0x39);
    }
    if (serialized[offset] === "e" || serialized[offset] === "E") {
      offset += 1;
      if (serialized[offset] === "+" || serialized[offset] === "-") offset += 1;
      const firstExponent = serialized.charCodeAt(offset);
      if (firstExponent < 0x30 || firstExponent > 0x39) fail();
      do {
        offset += 1;
      } while (serialized.charCodeAt(offset) >= 0x30 && serialized.charCodeAt(offset) <= 0x39);
    }
    if (!Number.isFinite(Number(serialized.slice(numberStart, offset)))) fail();
  }

  function readValue(depth: number): void {
    if (depth > AIDEN_REMOTE_MAX_JSON_NESTING_DEPTH) fail();
    skipWhitespace();
    const character = serialized[offset];
    if (character === "{") {
      offset += 1;
      skipWhitespace();
      const keys = new Set<string>();
      if (serialized[offset] === "}") {
        offset += 1;
        return;
      }
      for (;;) {
        const key = readString(true);
        objectKeys += 1;
        if (objectKeys > AIDEN_REMOTE_MAX_JSON_OBJECT_KEYS || key === undefined || keys.has(key)) fail();
        keys.add(key);
        skipWhitespace();
        if (serialized[offset] !== ":") fail();
        offset += 1;
        readValue(depth + 1);
        skipWhitespace();
        if (serialized[offset] === "}") {
          offset += 1;
          return;
        }
        if (serialized[offset] !== ",") fail();
        offset += 1;
        skipWhitespace();
      }
    }
    if (character === "[") {
      offset += 1;
      skipWhitespace();
      if (serialized[offset] === "]") {
        offset += 1;
        return;
      }
      for (;;) {
        readValue(depth + 1);
        skipWhitespace();
        if (serialized[offset] === "]") {
          offset += 1;
          return;
        }
        if (serialized[offset] !== ",") fail();
        offset += 1;
        skipWhitespace();
      }
    }
    if (character === '"') {
      readString(false);
      return;
    }
    if (character === "-" || (character !== undefined && character >= "0" && character <= "9")) {
      readNumber();
      return;
    }
    for (const literal of ["true", "false", "null"]) {
      if (serialized.startsWith(literal, offset)) {
        offset += literal.length;
        return;
      }
    }
    fail();
  }

  readValue(0);
  skipWhitespace();
  if (offset !== serialized.length) fail();
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized) as unknown;
  } catch {
    throw new Error(`Malformed Aiden Remote ${label}.`);
  }
  assertNoForbiddenWireKeys(parsed, label);
  return parsed;
}

export function parseAidenSseFrames(input: string): AidenSseFrame[] {
  return input.split(/\r?\n\r?\n/).filter(Boolean).map((frame) => {
    if (Buffer.byteLength(frame, "utf8") > AIDEN_REMOTE_MAX_SSE_FRAME_BYTES) {
      throw new Error("Aiden SSE frame exceeds the byte limit.");
    }
    let id: string | undefined;
    const data: string[] = [];
    for (const line of frame.split(/\r?\n/)) {
      if (line.startsWith("id:")) id = line.slice(3).trim();
      if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
    if (!id || data.length === 0) throw new Error("Malformed Aiden SSE frame.");
    return { id, data: parseAidenRemoteJson(data.join("\n"), "SSE JSON data") };
  });
}

export function reconcileAidenSseFrames(
  frames: readonly AidenSseFrame[],
  lastEventId: number,
  expectedStreamId: string,
): { events: AidenRemoteStreamEvent[]; reconcileRequired: boolean } {
  if (expectedStreamId.length === 0 || expectedStreamId.length > 128) {
    throw new Error("Aiden SSE expected streamId must be a bounded non-empty string.");
  }
  const events: AidenRemoteStreamEvent[] = [];
  let expected = lastEventId + 1;
  let terminalSeen = false;
  for (const frame of frames) {
    const event = parseAidenRemoteStreamEvent(frame.data);
    const streamId = event?.streamId ?? (isRecord(frame.data) && typeof frame.data.streamId === "string" ? frame.data.streamId : undefined);
    if (streamId !== expectedStreamId) return { events, reconcileRequired: true };
    const sequence = event?.sequence ?? (isRecord(frame.data) ? frame.data.sequence : undefined);
    if (!Number.isSafeInteger(sequence) || frame.id !== String(sequence)) return { events, reconcileRequired: true };
    if ((sequence as number) <= lastEventId) continue;
    if (sequence !== expected) return { events, reconcileRequired: true };
    if (terminalSeen) return { events, reconcileRequired: true };
    if (event) {
      events.push(event);
      terminalSeen = event.terminal;
    }
    expected += 1;
  }
  return { events, reconcileRequired: false };
}
