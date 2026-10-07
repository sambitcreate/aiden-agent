import { AIDEN_REMOTE_PROVIDER_CREATE_FEATURE, type AidenRemoteProviderService } from "./aiden-remote-providers.js";
import { AidenRemoteTtsService, REMOTE_TTS_FEATURE } from "./aiden-remote-tts.js";
import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { createGzip } from "node:zlib";
import {
  parseToolApprovalScope,
  type ToolApprovalScope,
} from "../../renderer/shared/tool-approval-scope.js";
import {
  AIDEN_REMOTE_BASE_PATH,
  AIDEN_REMOTE_BOT_CAPABILITIES,
  AIDEN_REMOTE_LEGACY_CAPABILITIES,
  AIDEN_REMOTE_MAX_JSON_RESPONSE_BYTES,
  AIDEN_REMOTE_PROGRESS_CAPABILITIES,
  AIDEN_REMOTE_SIMULATOR_CAPABILITIES,
  AIDEN_REMOTE_HOST_CAPABILITIES,
  AIDEN_REMOTE_PHONE_RUN_CAPABILITIES,
  AIDEN_REMOTE_PHONE_RUN_CONTROL_FEATURE,
  AIDEN_REMOTE_PROTOCOL_VERSION,
  AIDEN_REMOTE_CHAT_SUMMARY_DEFAULT_LIMIT,
  AIDEN_REMOTE_CHAT_SUMMARY_FEATURE,
  AIDEN_REMOTE_CHAT_READ_STATE_FEATURE,
  AIDEN_REMOTE_CHAT_SUMMARY_MAX_CURSOR_LENGTH,
  AIDEN_REMOTE_CHAT_SUMMARY_MAX_LIMIT,
  AIDEN_REMOTE_CHAT_TASKS_FEATURE,
  AIDEN_REMOTE_CHAT_AGENTS_FEATURE,
  AIDEN_REMOTE_CHAT_AGENT_INTERRUPT_FEATURE,
  AIDEN_REMOTE_CHAT_RUN_INPUT_FEATURE,
  AIDEN_REMOTE_CHAT_QUESTION_PROMPTS_FEATURE,
  AIDEN_REMOTE_CHAT_SKILLS_FEATURE,
  AIDEN_REMOTE_CHAT_MESSAGES_WINDOW_DEFAULT_LIMIT,
  AIDEN_REMOTE_CHAT_MESSAGES_WINDOW_FEATURE,
  AIDEN_REMOTE_CHAT_MESSAGES_WINDOW_METADATA_FEATURE,
  AIDEN_REMOTE_CHAT_FORK_FEATURE,
  AIDEN_REMOTE_CHAT_FORK_SUMMARY_FEATURE,
  AIDEN_REMOTE_CHAT_MESSAGES_WINDOW_MAX_LIMIT,
  AIDEN_REMOTE_CONTRACT_REVISION,
  AIDEN_REMOTE_HOST_EVENTS_FEATURE,
  AIDEN_REMOTE_PAIRING_REQUESTS_FEATURE,
  AIDEN_REMOTE_RUN_CONTROL_FEATURE,
  AIDEN_REMOTE_RUN_STREAMS_FEATURE,
  parseAidenRemoteBotConversationQuery,
  parseAidenRemoteDeviceCapabilitiesUpdateRequest,
  parseAidenRemoteJson,
  parseAidenRemoteQuestionRespondRequest,
  type AidenRemoteCapability,
  type AidenRemoteProgressCapability,
  type AidenRemoteBotConversationQuery,
  type AidenRemoteChatAgentRoster,
  type AidenRemoteChatTaskProgress,
  type AidenRemoteErrorEnvelope,
  type AidenRemoteHostCapability,
  type AidenRemoteHostPlatform,
} from "./aiden-remote-protocol.js";
import type { AidenRemoteHostRunService } from "./aiden-remote-host-runs.js";
import type { AidenRemoteHostFeedService } from "./aiden-remote-host-feed.js";
import {
  AidenRemoteServiceError,
  asAidenRemoteServiceError,
} from "./aiden-remote-errors.js";
import type { AidenRemotePairingService } from "./aiden-remote-pairing.js";
import type { AidenRemotePairingRequestService } from "./aiden-remote-pairing-requests.js";
import { AIDEN_PAIRING_REQUEST_ID_PATTERN } from "./aiden-remote-sealed-envelope.js";
import type {
  AidenRemoteAuthenticatedDevice,
  AidenRemoteConnectionMode,
  AidenRemoteStateRegistry,
} from "./aiden-remote-state.js";
import { normalizeAidenRemoteDisplayName } from "./aiden-remote-state.js";
import type { AidenRemoteWorkspaceBrowserService } from "./aiden-remote-workspace-browser.js";
import type { AidenRemoteWorkspaceService } from "./aiden-remote-workspaces.js";
import type {
  AidenRemoteChatClassification,
  AidenRemoteChatService,
} from "./aiden-remote-chats.js";
import type { AidenRemoteModelService } from "./aiden-remote-models.js";
import type { AidenRemoteStreamService } from "./aiden-remote-streams.js";
import type { AidenRemoteFileService } from "./aiden-remote-files.js";
import type { AidenRemoteBotFileService } from "./aiden-remote-bot-files.js";
import type { AidenRemoteGitService } from "./aiden-remote-git.js";
import type { AidenRemoteScheduleService } from "./aiden-remote-schedules.js";
import type { AidenRemoteMemorySettingsService } from "./aiden-remote-memory-settings.js";
import type { AidenRemoteBotService } from "./aiden-remote-bots.js";
import type { UsageDateRange, UsageSummary } from "./types.js";
import { MAX_AIDEN_REMOTE_ATTACHMENT_REQUEST_BYTES } from "./aiden-remote-attachments.js";
import type { AidenRemoteSpeechService } from "./aiden-remote-speech.js";
import {
  AIDEN_REMOTE_SIMULATOR_HUB_PREFIX,
  simulatorsUnavailable,
  type AidenRemoteSimulatorRelay,
} from "./aiden-remote-simulators.js";
import { refuseUpgrade } from "./devices/device-hub-proxy.js";
import { AIDEN_REMOTE_MAX_SPEECH_REQUEST_BYTES } from "./aiden-remote-speech-codec.js";
import {
  parseBotNoticeAcknowledgement,
  type BotNoticeAcknowledgement,
  type BotNoticeStatus,
} from "../../renderer/shared/bot-capabilities.js";
const MAX_REQUEST_BODY_BYTES = 1_048_576;
const MAX_FILE_REQUEST_BODY_BYTES = 6 * 1_048_576;
const MAX_REQUEST_URL_LENGTH = 2_048;
export interface AidenRemoteServerProjection {
  protocolVersion: typeof AIDEN_REMOTE_PROTOCOL_VERSION;
  instanceId: string;
  name: string;
  appVersion: string;
  /** Authenticated device grants. This field is retained for strict v1 clients. */
  capabilities: AidenRemoteCapability[];
  /** Server-supported inventory, emitted only after an additive vocabulary opt-in. */
  serverCapabilities?: AidenRemoteCapability[];
  /** Presentation-only label currently stored for the authenticated device. */
  deviceName?: string;
  connectionMode: AidenRemoteConnectionMode;
  minimumClientVersion?: string;
  features: string[];
  serverTime: string;
  peerRoutes?: import("./peer-transport.js").PeerTrust[];
}

type AidenRemoteRouterAuthenticatedDevice = Omit<
  AidenRemoteAuthenticatedDevice,
  "acceptsBotCapabilities" | "acceptsProgressCapabilities" | "name" | "type"
> & {
  /** Omitted by legacy dependency adapters and treated as a non-desktop device. */
  type?: AidenRemoteAuthenticatedDevice["type"];
  /** Omitted by legacy dependency adapters and treated as not negotiated. */
  acceptsBotCapabilities?: boolean;
  /** Omitted by legacy dependency adapters and treated as not negotiated. */
  acceptsProgressCapabilities?: boolean;
  /** Omitted by legacy dependency adapters. */
  name?: string;
};

type AidenRemoteRouterDeviceRegistry = {
  authenticate(
    credential: string,
  ): Promise<AidenRemoteRouterAuthenticatedDevice | null>;
  acquireDeviceAuthorization: AidenRemoteStateRegistry["acquireDeviceAuthorization"];
  updateDeviceName?: AidenRemoteStateRegistry["updateDeviceName"];
  upgradeDeviceCapabilities?: AidenRemoteStateRegistry["upgradeDeviceCapabilities"];
};

export interface AidenRemoteRouterDependencies {
  instanceId: string;
  displayName(): string;
  appVersion: string;
  /** Trust material disclosed only after authentication by a paired desktop. */
  peerRoutes?(): Promise<import("./peer-transport.js").PeerTrust[]>;
  devices: AidenRemoteRouterDeviceRegistry;
  pairing: Pick<AidenRemotePairingService, "exchange">
    & Partial<Pick<AidenRemotePairingService, "manualBootstrap">>;
  /**
   * Unauthenticated desktop connection requests (`pairing-requests-v1`).
   * Absent: `/pairing/requests*` is `not_found`, `/health?detail=host`
   * reports `pairingRequests: false` and `/server` omits the feature.
   */
  pairingRequests?: Pick<
    AidenRemotePairingRequestService,
    "accepting" | "create" | "reveal" | "poll" | "cancel"
  >;
  workspaces?: Pick<AidenRemoteWorkspaceService, "list" | "get" | "create" | "update" | "remove">;
  workspaceBrowser?: Pick<
    AidenRemoteWorkspaceBrowserService,
    "listRoots" | "listChildren" | "createSelection"
  >;
  chats?: Pick<
    AidenRemoteChatService,
    "list" | "classify" | "authorizeRetainedBotChat" | "runMutation" | "get" | "create" | "rename" | "move" | "remove" | "startTurn"
  > & Partial<Pick<AidenRemoteChatService, "listSummaries" | "uploadAttachment" | "removeAttachment" | "attachmentContent" | "chatSkillCatalog" | "markRead" | "supportsReadMarkers" | "messagesWindow" | "fork" | "supportsForks" | "supportsForkSummaries" | "retryForkSummary" | "skipForkSummary" | "cancelForkSummary">>;
  /**
   * Chat-scoped task/agent progress projections (Phase 2 runtime). When
   * absent, the contract routes return `not_found` and `/server` omits the
   * `chat-tasks-v1`/`chat-agents-v1` feature tokens.
   */
  chatProgress?: {
    /** Authoritative bounded task-progress snapshot for one chat. */
    taskSnapshot(deviceId: string, chatId: string): Promise<AidenRemoteChatTaskProgress>;
    /** Authoritative bounded delegated-agent roster for the chat's current turn. */
    agentRoster(
      deviceId: string,
      chatId: string,
      turnId?: string,
    ): Promise<AidenRemoteChatAgentRoster>;
    /**
     * Stop one running delegated agent addressed by its public `agentId`
     * through the main-owned subagent control path and return the refreshed
     * current-turn roster. Absent (or `supportsAgentInterrupt === false`)
     * when the host does not wire subagent control; the route then returns
     * `not_found` and `/server` omits `chat-agent-interrupt-v1`.
     */
    interruptAgent?(
      deviceId: string,
      chatId: string,
      agentId: string,
    ): Promise<AidenRemoteChatAgentRoster>;
    readonly supportsAgentInterrupt?: boolean;
    /**
     * Opens the resumable chat-scoped progress journal whose `streamId` is
     * the chat ID. The implementation must emit `task_update` events only
     * when `grants` contains `tasks:read` and `agents_update` events only
     * when it contains `agents:read`.
     */
    openEvents(
      deviceId: string,
      chatId: string,
      grants: ReadonlySet<AidenRemoteCapability>,
      after: number,
      response: ServerResponse,
      epoch?: string,
    ): void | Promise<void>;
  };
  models?: Pick<AidenRemoteModelService, "list">;
  streams?: Pick<
    AidenRemoteStreamService,
    "streamChatId" | "status" | "pendingApproval" | "approvalRequiredCapability" | "cancel" | "respondApproval" | "openEvents"
  > &
    Partial<
      Pick<
        AidenRemoteStreamService,
        "submitInput" | "supportsRunInput" | "pendingQuestion" | "respondQuestion" | "supportsQuestionPrompts"
      >
    >;
  files?: Pick<AidenRemoteFileService, "list" | "read" | "write"> & Partial<Pick<AidenRemoteFileService, "children">>;
  botFiles?: Pick<AidenRemoteBotFileService, "list" | "read" | "write">;
  git?: Pick<AidenRemoteGitService, "review" | "diff" | "branches" | "checkout" | "createBranch" | "commit" | "pushCapability" | "push" | "compare" | "comparisonDiff" | "worktrees" | "createWorktree" | "deleteManagedWorktree">;
  schedules?: Pick<AidenRemoteScheduleService, "list" | "get" | "create" | "update" | "remove" | "pause" | "resume" | "run" | "runs" | "notifications" | "preview" | "scripts" | "mcpServers" | "settings" | "updateSettings">;
  providers?: Pick<AidenRemoteProviderService, "create">;
  memorySettings?: Pick<AidenRemoteMemorySettingsService, "get" | "update">;
  usage?: { summary(range: UsageDateRange): Promise<UsageSummary> };
  readAloud?: Pick<AidenRemoteTtsService, "status" | "start" | "read" | "stop">;
  speech?: Pick<
    AidenRemoteSpeechService,
    "status" | "select" | "startDownload" | "cancelDownload" | "deleteModel" | "transcribe"
  >;
  botNotice?: {
    status(deviceId: string): Promise<BotNoticeStatus>;
    acknowledge(
      deviceId: string,
      acknowledgement: BotNoticeAcknowledgement,
    ): Promise<BotNoticeStatus>;
  };
  bots?: Pick<
    AidenRemoteBotService,
    | "list"
    | "get"
    | "create"
    | "updateIdentity"
    | "archive"
    | "restore"
    | "capabilityCatalog"
    | "updateAccess"
    | "createChat"
    | "getChatAccess"
    | "updateChatAccess"
    | "favorites"
    | "updateFavorites"
  > & Partial<Pick<
    AidenRemoteBotService,
    "listConversations" | "putAvatar" | "deleteAvatar" | "avatarContent"
  >>;
  /**
   * Simulator sharing with paired Macs (Simulator devices Phase 5). Absent
   * when the feature is off; `/simulators` routes then return `not_found`.
   */
  simulators?: AidenRemoteSimulatorRelay;
  /**
   * Host-wide feed for paired desktop controllers (`host:events`, contract
   * revision 19). Absent: `/host/events` is `not_found` and the grant and
   * `host-events-v1` are never advertised.
   */
  hostFeed?: Pick<AidenRemoteHostFeedService, "open">;
  /**
   * Host-wide run streams (`runs:observe`) and controls (`runs:control`).
   * Absent: `/runs/*` is `not_found` and neither grant is advertised.
   */
  hostRuns?: Pick<
    AidenRemoteHostRunService,
    | "chatIdForRun"
    | "currentRunId"
    | "openRunEvents"
    | "cancel"
    | "respondApproval"
    | "respondQuestion"
    | "submitInput"
  >;
  /** The host platform published by the opt-in `/health?detail=host` descriptor. */
  platform?: AidenRemoteHostPlatform;
  connectionMode(): AidenRemoteConnectionMode;
  now(): number;
  /** Tailscale Serve strips the public API prefix before loopback proxying. */
  acceptStrippedBasePath?: boolean;
  log(entry: {
    requestId: string;
    route: AidenRemoteRouteLabel;
    /** The request HTTP method (GET/POST/...). */
    method?: string;
    /**
     * The matched route template (for example `/chats/:id/turns`) without any
     * query string. Present only when the request resolved to a known route;
     * caller-controlled literal paths are never reflected here.
     */
    routePath?: string;
    status: number;
    latencyMs: number;
    deviceIdSuffix?: string;
    errorCode?: string;
  }): void;
}

export type AidenRemoteRouteLabel =
  | "health"
  | "pairingManualBootstrap"
  | "pairingExchange"
  | "pairingRequests"
  | "pairingRequest"
  | "pairingRequestReveal"
  | "server"
  | "deviceIdentity"
  | "deviceCapabilities"
  | "botAccessNotice"
  | "bots"
  | "bot"
  | "botCapabilities"
  | "botChatCapabilities"
  | "botFavorites"
  | "botConversations"
  | "botAvatar"
  | "botFiles"
  | "botFile"
  | "workspaces"
  | "workspace"
  | "workspaceBrowserRoots"
  | "workspaceBrowserChildren"
  | "workspaceBrowserSelection"
  | "workspaceFiles"
  | "workspaceFile"
  | "workspaceGit"
  | "scheduledTasks"
  | "providers"
  | "memorySettings"
  | "usage"
  | "readAloud"
  | "speech"
  | "chats"
  | "chatSummaries"
  | "chat"
  | "chatMove"
  | "chatFork"
  | "chatForkSummary"
  | "chatRead"
  | "chatTasks"
  | "chatAgents"
  | "chatAgentInterrupt"
  | "chatSkills"
  | "chatProgressEvents"
  | "chatAttachment"
  | "turns"
  | "models"
  | "stream"
  | "streamApproval"
  | "streamEvents"
  | "streamCancel"
  | "streamInputs"
  | "streamQuestion"
  | "approvalRespond"
  | "questionRespond"
  | "simulators"
  | "simulatorHub"
  | "hostEvents"
  | "chatMessages"
  | "runEvents"
  | "chatCurrentRunEvents"
  | "runCancel"
  | "runApprovalRespond"
  | "runQuestionRespond"
  | "runInputs"
  | "unknown";

/** Canonical template(s) for every router route label. */
export const AIDEN_REMOTE_ROUTE_TEMPLATES: Readonly<Record<AidenRemoteRouteLabel, readonly string[]>> = {
  health: ["/health"],
  pairingManualBootstrap: ["/pairing/manual-bootstrap"],
  pairingExchange: ["/pairing/exchange"],
  pairingRequests: ["/pairing/requests"],
  pairingRequest: ["/pairing/requests/:requestId"],
  pairingRequestReveal: ["/pairing/requests/:requestId/reveal"],
  server: ["/server"],
  deviceIdentity: ["/device/identity"],
  deviceCapabilities: ["/device/capabilities"],
  botAccessNotice: ["/bot-access-notice", "/bot-access-notice/acknowledgement"],
  bots: ["/bots", "/bots/:botId/chats"],
  bot: ["/bots/:botId", "/bots/:botId/restore"],
  botCapabilities: ["/bot-capabilities", "/bots/:botId/capabilities"],
  botChatCapabilities: ["/chats/:chatId/capabilities"],
  botFavorites: ["/bot-favorites"],
  botConversations: ["/bot-conversations"],
  botFiles: ["/bot-conversations/:chatId/files"],
  botFile: ["/bot-conversations/:chatId/files/:fileId"],
  botAvatar: ["/bots/:botId/avatar", "/bots/:botId/avatar/:avatarRevision"],
  workspaces: ["/workspaces"],
  workspace: ["/workspaces/:id"],
  workspaceBrowserRoots: ["/workspace-browser/roots"],
  workspaceBrowserChildren: ["/workspace-browser/children"],
  workspaceBrowserSelection: ["/workspace-browser/selections"],
  workspaceFiles: ["/workspaces/:id/files"],
  workspaceFile: ["/workspaces/:id/files/:fileId"],
  workspaceGit: ["/workspaces/:id/git/managed-worktree", "/workspaces/:id/git/:action"],
  scheduledTasks: [
    "/scheduled-tasks",
    "/scheduled-tasks/preview",
    "/scheduled-tasks/scripts",
    "/scheduled-tasks/mcp-servers",
    "/scheduled-tasks/settings",
    "/scheduled-tasks/:id/runs",
    "/scheduled-tasks/:id/:action",
    "/scheduled-tasks/:id",
  ],
  providers: ["/providers"],
  memorySettings: ["/memory/settings"],
  usage: ["/usage"],
  readAloud: ["/read-aloud", "/chats/:id/read-aloud", "/chats/:id/read-aloud/stop", "/chats/:id/read-aloud/audio/:jobId/:segment/:offset"],
  speech: ["/speech", "/speech/transcriptions", "/speech/models/:modelId/download", "/speech/models/:modelId"],
  chats: ["/chats"],
  chatSummaries: ["/chat-summaries"],
  chat: ["/chats/:id"],
  chatMove: ["/chats/:id/move"],
  chatFork: ["/chats/:id/fork"],
  chatForkSummary: ["/chats/:id/fork-summary/:action"],
  chatRead: ["/chats/:id/read"],
  chatTasks: ["/chats/:id/tasks"],
  chatAgents: ["/chats/:id/agents"],
  chatAgentInterrupt: ["/chats/:id/agents/:agentId/interrupt"],
  chatSkills: ["/chats/:id/skills"],
  chatProgressEvents: ["/chats/:id/progress/events"],
  chatAttachment: [
    "/chats/:id/attachments",
    "/chats/:id/attachments/:attachmentId",
    "/chats/:id/attachments/:attachmentName/content",
  ],
  turns: ["/chats/:id/turns"],
  models: ["/models"],
  stream: ["/streams/:streamId"],
  streamApproval: ["/streams/:streamId/approval"],
  streamQuestion: ["/streams/:streamId/question"],
  streamEvents: ["/streams/:streamId/events"],
  streamCancel: ["/streams/:streamId/cancel"],
  streamInputs: ["/streams/:streamId/inputs"],
  approvalRespond: ["/approvals/:approvalId/respond"],
  questionRespond: ["/questions/:promptId/respond"],
  simulators: ["/simulators", "/simulators/:action"],
  simulatorHub: ["/simulators/hub/:path"],
  hostEvents: ["/host/events"],
  chatMessages: ["/chats/:id/messages"],
  runEvents: ["/runs/:runId/events"],
  chatCurrentRunEvents: ["/chats/:id/runs/current/events"],
  runCancel: ["/runs/:runId/cancel"],
  runApprovalRespond: ["/runs/:runId/approvals/:approvalId/respond"],
  runQuestionRespond: ["/runs/:runId/questions/:promptId/respond"],
  runInputs: ["/runs/:runId/inputs"],
  unknown: [],
};

/** Resolve the canonical route template for a classified route and concrete request path. */
export function remoteRouteTemplate(
  route: AidenRemoteRouteLabel,
  requestPath: string,
): string | undefined {
  const candidates = AIDEN_REMOTE_ROUTE_TEMPLATES[route];
  if (candidates.length === 0) return undefined;
  const requestSegments = requestPath.split("/");
  let best: { template: string; parameterSegments: number } | undefined;
  for (const template of candidates) {
    const templateSegments = template.split("/");
    if (templateSegments.length !== requestSegments.length) continue;
    let parameterSegments = 0;
    let matched = true;
    for (let index = 0; index < requestSegments.length; index += 1) {
      const expected = templateSegments[index];
      if (expected === undefined) {
        matched = false;
        break;
      }
      if (expected.startsWith(":")) {
        parameterSegments += 1;
        continue;
      }
      if (expected !== requestSegments[index]) {
        matched = false;
        break;
      }
    }
    if (!matched) continue;
    // Prefer the most specific template (fewest parameter segments), so static
    // endpoints such as `/scheduled-tasks/scripts` never resolve to a `:id`.
    if (!best || parameterSegments < best.parameterSegments) {
      best = { template, parameterSegments };
    }
  }
  return best?.template;
}

function requestId(): string {
  return `req_${randomBytes(18).toString("base64url")}`;
}

function parseDeviceIdentityRequest(value: unknown): { name: string } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new AidenRemoteServiceError(
      "invalid_request",
      "The device identity must contain one valid name.",
      400,
    );
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 1 || !("name" in record)) {
    throw new AidenRemoteServiceError(
      "invalid_request",
      "The device identity must contain one valid name.",
      400,
    );
  }
  try {
    return { name: normalizeAidenRemoteDisplayName(record.name) };
  } catch {
    throw new AidenRemoteServiceError(
      "invalid_request",
      "The device identity name must be 1–80 visible characters.",
      400,
    );
  }
}

function hasAsciiControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function responseHeaders(contentType = "application/json; charset=utf-8") {
  return {
    "aiden-protocol-version": String(AIDEN_REMOTE_PROTOCOL_VERSION),
    "cache-control": "no-store",
    "content-type": contentType,
    "cross-origin-resource-policy": "same-site",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  };
}

/**
 * The request behind each in-flight response, so successful JSON reads can
 * negotiate compression and conditional revalidation without threading the
 * request through every route.
 */
const negotiatedRequests = new WeakMap<ServerResponse, IncomingMessage>();
/** Smaller bodies gain little from gzip and pay its fixed framing cost. */
const GZIP_MIN_RESPONSE_BYTES = 1024;

/** Members of a comma-separated header list such as `Accept-Encoding` or `If-None-Match`. */
function listMembers(header: string | string[] | undefined): string[] {
  const value = Array.isArray(header) ? header.join(",") : header;
  return value ? value.split(",").map((member) => member.trim()).filter(Boolean) : [];
}

/** True only when the client explicitly accepts gzip (or `*`) with a non-zero weight. */
function acceptsGzipEncoding(header: string | string[] | undefined): boolean {
  let gzip: number | undefined;
  let wildcard: number | undefined;
  for (const member of listMembers(header)) {
    const [coding = "", ...params] = member.split(";").map((part) => part.trim());
    const qParam = params.find((param) => /^q=/iu.test(param));
    const q = qParam === undefined ? 1 : Number(qParam.slice(2));
    const weight = Number.isFinite(q) ? q : 0;
    const name = coding.toLowerCase();
    if (name === "gzip" || name === "x-gzip") gzip = weight;
    else if (name === "*") wildcard = weight;
  }
  return (gzip ?? wildcard ?? 0) > 0;
}

/** Weak comparison (RFC 9110 §13.1.2) of `If-None-Match` against the response ETag. */
function ifNoneMatchSatisfied(header: string | string[] | undefined, etag: string): boolean {
  const opaque = etag.replace(/^W\//u, "");
  return listMembers(header).some(
    (member) => member === "*" || member.replace(/^W\//u, "") === opaque,
  );
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  const length = body === undefined ? 0 : Buffer.byteLength(body, "utf8");
  if (body === undefined || length > AIDEN_REMOTE_MAX_JSON_RESPONSE_BYTES) {
    throw new AidenRemoteServiceError(
      "payload_too_large",
      "This response exceeds the Aiden Remote JSON limit.",
      413,
    );
  }
  const request = status === 200 ? negotiatedRequests.get(response) : undefined;
  if (request?.method !== "GET") {
    response.writeHead(status, {
      ...responseHeaders(),
      "content-length": String(length),
    });
    response.end(body);
    return;
  }
  // Successful reads are revalidatable and compressible. Both are opt-in:
  // a client that sends neither `If-None-Match` nor a gzip-accepting
  // `Accept-Encoding` receives the same identity body as before.
  const etag = `W/"${createHash("sha256").update(body).digest("base64url")}"`;
  if (ifNoneMatchSatisfied(request.headers["if-none-match"], etag)) {
    const { "content-type": _contentType, ...headers } = responseHeaders();
    response.writeHead(304, { ...headers, etag, vary: "accept-encoding" });
    response.end();
    return;
  }
  const headers = { ...responseHeaders(), etag, vary: "accept-encoding" };
  if (
    length >= GZIP_MIN_RESPONSE_BYTES &&
    acceptsGzipEncoding(request.headers["accept-encoding"])
  ) {
    // Stream through zlib's thread pool rather than blocking main on a
    // multi-megabyte transcript; the body is chunked without a length.
    response.writeHead(200, { ...headers, "content-encoding": "gzip" });
    const gzip = createGzip();
    gzip.on("error", () => response.destroy());
    gzip.pipe(response);
    gzip.end(body);
    return;
  }
  response.writeHead(200, { ...headers, "content-length": String(length) });
  response.end(body);
}

function writeAttachmentContent(
  response: ServerResponse,
  content: { bytes: Buffer; mimeType: string },
): void {
  response.writeHead(200, {
    ...responseHeaders(content.mimeType),
    "content-length": String(content.bytes.length),
    "content-security-policy": "default-src 'none'; sandbox",
  });
  response.end(content.bytes);
}

function writeError(
  response: ServerResponse,
  id: string,
  error: AidenRemoteServiceError,
): void {
  const envelope: AidenRemoteErrorEnvelope = {
    error: {
      code: error.code,
      message: error.message,
      requestId: id,
      retryable: error.retryable,
      ...(error.details ? { details: error.details } : {}),
    },
  };
  writeJson(response, error.status, envelope);
}

async function readJsonBody(
  request: IncomingMessage,
  maximumBytes = MAX_REQUEST_BODY_BYTES,
): Promise<unknown> {
  const contentType = request.headers["content-type"];
  if (
    typeof contentType !== "string" ||
    contentType.toLowerCase().split(";", 1)[0]?.trim() !== "application/json"
  ) {
    throw new AidenRemoteServiceError(
      "invalid_request",
      "This endpoint requires an application/json request body.",
      415,
    );
  }
  const declaredLength = request.headers["content-length"];
  if (
    typeof declaredLength === "string" &&
    (!/^\d+$/u.test(declaredLength) || Number(declaredLength) > maximumBytes)
  ) {
    throw new AidenRemoteServiceError(
      "payload_too_large",
      "The request body is too large.",
      413,
    );
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maximumBytes) {
      throw new AidenRemoteServiceError(
        "payload_too_large",
        "The request body is too large.",
        413,
      );
    }
    chunks.push(buffer);
  }
  if (bytes === 0) {
    throw new AidenRemoteServiceError(
      "invalid_request",
      "The request body is required.",
      400,
    );
  }
  let serialized: string;
  try {
    serialized = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    throw new AidenRemoteServiceError(
      "invalid_request",
      "The request body must be valid UTF-8 JSON.",
      400,
    );
  }
  try {
    return parseAidenRemoteJson(serialized, "request JSON data");
  } catch {
    throw new AidenRemoteServiceError(
      "invalid_request",
      "The request body must be valid JSON with unique safe fields.",
      400,
    );
  }
}

function bearerCredential(request: IncomingMessage): string | null {
  const authorization = request.headers.authorization;
  if (typeof authorization !== "string") return null;
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/u.exec(authorization);
  return match?.[1] ?? null;
}

function negotiatedDeviceCapabilities(
  device: AidenRemoteRouterAuthenticatedDevice,
): ReadonlySet<AidenRemoteCapability> {
  return new Set(
    [...device.capabilities].filter((capability) =>
      (capability !== "bot:read" && capability !== "bot:write" ||
        device.acceptsBotCapabilities === true) &&
      (!(AIDEN_REMOTE_PROGRESS_CAPABILITIES as readonly string[]).includes(capability) ||
        device.acceptsProgressCapabilities === true) &&
      (capability !== "simulators:control" &&
        !(AIDEN_REMOTE_HOST_CAPABILITIES as readonly string[]).includes(capability) ||
        device.type === "mac" || device.type === "linux" ||
        (AIDEN_REMOTE_PHONE_RUN_CAPABILITIES as readonly string[]).includes(capability)),
    ),
  );
}

async function authenticateCredential(
  request: IncomingMessage,
  devices: Pick<AidenRemoteRouterDeviceRegistry, "authenticate">,
  capability: AidenRemoteCapability,
): Promise<AidenRemoteRouterAuthenticatedDevice> {
  if (request.headers["aiden-protocol-version"] !== "1") {
    throw new AidenRemoteServiceError(
      "invalid_request",
      "Aiden-Protocol-Version must be 1.",
      400,
      false,
      { minimumClientVersion: "1" },
    );
  }
  const credential = bearerCredential(request);
  if (!credential) {
    throw new AidenRemoteServiceError(
      "authentication_required",
      "Pair this device in Aiden Settings before connecting.",
      401,
    );
  }
  const device = await devices.authenticate(credential);
  if (!device) {
    throw new AidenRemoteServiceError(
      "authentication_required",
      "This device credential is not valid for this Aiden installation.",
      401,
    );
  }
  if (device.revoked) {
    throw new AidenRemoteServiceError(
      "credential_revoked",
      "This device was revoked in Aiden Settings.",
      403,
    );
  }
  const capabilities = negotiatedDeviceCapabilities(device);
  if (!capabilities.has(capability)) {
    throw new AidenRemoteServiceError(
      "capability_denied",
      "This device does not have access to that Aiden capability.",
      403,
    );
  }
  return { ...device, capabilities };
}

type BotChatResource = "chat" | "stream" | "approval" | "question";

function unavailableBotChatResource(resource: BotChatResource): AidenRemoteServiceError {
  if (resource === "approval") {
    return new AidenRemoteServiceError(
      "approval_expired",
      "This approval is no longer available.",
      409,
    );
  }
  if (resource === "question") {
    return new AidenRemoteServiceError(
      "question_expired",
      "This question prompt is no longer available.",
      409,
    );
  }
  return new AidenRemoteServiceError(
    "not_found",
    resource === "stream"
      ? "This Aiden stream is unavailable."
      : "This Aiden chat no longer exists.",
    404,
  );
}

function requireBotChatAccess(
  device: AidenRemoteRouterAuthenticatedDevice,
  chat: AidenRemoteChatClassification,
  access: "read" | "write",
  resource: BotChatResource = "chat",
): void {
  if (!chat.botId) return;
  const allowed = device.capabilities.has("bot:read")
    && (access === "read" || device.capabilities.has("bot:write"));
  if (allowed) return;
  throw unavailableBotChatResource(resource);
}

async function requireChatAccess(
  chats: Pick<AidenRemoteChatService, "classify" | "authorizeRetainedBotChat">,
  device: AidenRemoteRouterAuthenticatedDevice,
  chatId: string,
  access: "read" | "write",
  resource: BotChatResource = "chat",
): Promise<AidenRemoteChatClassification> {
  let classification: AidenRemoteChatClassification;
  try {
    classification = await chats.classify(chatId);
  } catch {
    // Classification must not expose reconciliation, deleted-payload, or
    // storage state through a retained chat/stream/approval identifier.
    throw unavailableBotChatResource(resource);
  }
  requireBotChatAccess(device, classification, access, resource);
  if (classification.botId) {
    let authorized = false;
    try {
      authorized = await chats.authorizeRetainedBotChat({
        deviceId: device.id,
        chatId,
        botId: classification.botId,
        access,
        // A desktop controller reading host-wide sees Bot chats as the host
        // owner does. Writes and every other caller keep the device audience.
        ...(access === "read" && device.capabilities.has("host:events")
          ? { audience: "host-owner" as const }
          : {}),
      });
    } catch {
      authorized = false;
    }
    if (!authorized) throw unavailableBotChatResource(resource);
  }
  return classification;
}

async function runChatMutation<T>(
  chats: Pick<
    AidenRemoteChatService,
    "classify" | "authorizeRetainedBotChat" | "runMutation"
  >,
  device: AidenRemoteRouterAuthenticatedDevice,
  chatId: string,
  resource: BotChatResource,
  action: () => Promise<T>,
): Promise<T> {
  const classification = await requireChatAccess(chats, device, chatId, "write", resource);
  let actionStarted = false;
  try {
    return await chats.runMutation(device.id, chatId, classification, async () => {
      actionStarted = true;
      return action();
    });
  } catch (error) {
    if (
      !actionStarted &&
      !(error instanceof AidenRemoteServiceError && error.code === "bot_archived")
    ) {
      throw unavailableBotChatResource(resource);
    }
    throw error;
  }
}

function requestTarget(
  request: IncomingMessage,
  acceptStrippedBasePath: boolean,
): { path: string; query: string } {
  const raw = request.url;
  if (
    !raw ||
    raw.length > MAX_REQUEST_URL_LENGTH ||
    raw.includes("#") ||
    raw.includes("%") ||
    raw.includes("\\") ||
    hasAsciiControl(raw)
  ) {
    throw new AidenRemoteServiceError(
      "invalid_request",
      "The request URL is invalid.",
      400,
    );
  }
  const query = raw.indexOf("?");
  const path = query < 0 ? raw : raw.slice(0, query);
  if (
    !path.startsWith("/") ||
    path.includes("//") ||
    path.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    throw new AidenRemoteServiceError(
      "invalid_request",
      "The request URL is invalid.",
      400,
    );
  }
  const queryString = query < 0 ? "" : raw.slice(query + 1);
  if (path.startsWith(`${AIDEN_REMOTE_BASE_PATH}/`)) {
    return { path: path.slice(AIDEN_REMOTE_BASE_PATH.length), query: queryString };
  }
  if (acceptStrippedBasePath) {
    return { path, query: queryString };
  }
  return { path: "", query: queryString };
}

function requireNoQuery(query: string): void {
  if (query) {
    throw new AidenRemoteServiceError(
      "invalid_request",
      "This endpoint does not accept query parameters.",
      400,
    );
  }
}

function browserQuery(query: string): { location: string; cursor?: string } {
  const values = new Map<string, string>();
  for (const component of query.split("&")) {
    const separator = component.indexOf("=");
    if (separator <= 0) {
      throw new AidenRemoteServiceError("invalid_request", "The folder-browser query is invalid.", 400);
    }
    const key = component.slice(0, separator);
    const value = component.slice(separator + 1);
    if (values.has(key) || (key !== "location" && key !== "cursor")) {
      throw new AidenRemoteServiceError("invalid_request", "The folder-browser query is invalid.", 400);
    }
    values.set(key, value);
  }
  const location = values.get("location");
  const cursor = values.get("cursor");
  if (
    !location ||
    !/^loc_[A-Za-z0-9_-]{43}$/u.test(location) ||
    (cursor !== undefined && !/^cur_[A-Za-z0-9_-]{43}$/u.test(cursor))
  ) {
    throw new AidenRemoteServiceError("invalid_request", "The folder-browser query is invalid.", 400);
  }
  return { location, ...(cursor ? { cursor } : {}) };
}

function chatsQuery(query: string): { workspaceId?: string } {
  if (!query) return {};
  const separator = query.indexOf("=");
  if (
    separator <= 0 ||
    query.slice(0, separator) !== "workspaceId" ||
    query.indexOf("&") >= 0 ||
    !/^[A-Za-z0-9._:-]{1,128}$/u.test(query.slice(separator + 1))
  ) {
    throw new AidenRemoteServiceError("invalid_request", "The chats query is invalid.", 400);
  }
  return { workspaceId: query.slice(separator + 1) };
}

function chatAgentsQuery(query: string): { turnId?: string } {
  if (!query) return {};
  const params = new URLSearchParams(query);
  if (
    params.size !== 1 ||
    params.getAll("turnId").length !== 1 ||
    params.keys().next().value !== "turnId"
  ) {
    throw new AidenRemoteServiceError(
      "invalid_request",
      "The chat agent roster query is invalid.",
      400,
    );
  }
  const turnId = params.get("turnId");
  if (!turnId || !/^[A-Za-z0-9._:-]{1,128}$/u.test(turnId)) {
    throw new AidenRemoteServiceError(
      "invalid_request",
      "The chat agent roster query is invalid.",
      400,
    );
  }
  return { turnId };
}

function chatSummariesQuery(query: string): { limit: number; cursor?: string } {
  if (!query) return { limit: AIDEN_REMOTE_CHAT_SUMMARY_DEFAULT_LIMIT };
  const params = new URLSearchParams(query);
  if (
    [...params.keys()].some((key) => key !== "limit" && key !== "cursor") ||
    params.getAll("limit").length > 1 ||
    params.getAll("cursor").length > 1
  ) {
    throw new AidenRemoteServiceError(
      "invalid_request",
      "The chat summaries query is invalid.",
      400,
    );
  }
  const rawLimit = params.get("limit");
  const limit = rawLimit === null
    ? AIDEN_REMOTE_CHAT_SUMMARY_DEFAULT_LIMIT
    : /^\d{1,3}$/u.test(rawLimit)
      ? Number(rawLimit)
      : Number.NaN;
  const cursor = params.get("cursor");
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > AIDEN_REMOTE_CHAT_SUMMARY_MAX_LIMIT ||
    (cursor !== null &&
      (cursor.length === 0 ||
        cursor.length > AIDEN_REMOTE_CHAT_SUMMARY_MAX_CURSOR_LENGTH ||
        !/^[\x21-\x7e]+$/u.test(cursor)))
  ) {
    throw new AidenRemoteServiceError(
      "invalid_request",
      "The chat summaries query is invalid.",
      400,
    );
  }
  return { limit, ...(cursor !== null ? { cursor } : {}) };
}

function usageQuery(query: string): UsageDateRange {
  const params = new URLSearchParams(query);
  const range = params.get("range") ?? "30d";
  if (params.size !== 1 || !["7d", "30d", "90d", "1y", "all"].includes(range)) {
    throw new AidenRemoteServiceError("invalid_request", "The usage range is invalid.", 400);
  }
  return range as UsageDateRange;
}

function scheduledNotificationsQuery(query: string): { since?: number } {
  if (!query) return {};
  const separator = query.indexOf("=");
  if (
    separator <= 0 ||
    query.slice(0, separator) !== "since" ||
    query.indexOf("&") >= 0 ||
    !/^(?:0|[1-9]\d{0,15})$/u.test(query.slice(separator + 1))
  ) {
    throw new AidenRemoteServiceError("invalid_request", "The scheduled-notification query is invalid.", 400);
  }
  const parsed = Number(query.slice(separator + 1));
  if (!Number.isSafeInteger(parsed)) {
    throw new AidenRemoteServiceError("invalid_request", "The scheduled-notification query is invalid.", 400);
  }
  return { since: parsed };
}

function scheduledScriptsQuery(query: string): { workspaceId?: string } {
  if (!query) return {};
  const separator = query.indexOf("=");
  if (
    separator <= 0 ||
    query.slice(0, separator) !== "workspaceId" ||
    query.indexOf("&") >= 0 ||
    !/^[A-Za-z0-9_-]{1,128}$/u.test(query.slice(separator + 1))
  ) {
    throw new AidenRemoteServiceError("invalid_request", "The scheduled-script query is invalid.", 400);
  }
  return { workspaceId: query.slice(separator + 1) };
}

function streamAfter(request: IncomingMessage, query: string): number {
  let after: string | undefined;
  if (query) {
    const separator = query.indexOf("=");
    if (
      separator <= 0 ||
      query.slice(0, separator) !== "after" ||
      query.indexOf("&") >= 0
    ) {
      throw new AidenRemoteServiceError("invalid_request", "The stream cursor is invalid.", 400);
    }
    after = query.slice(separator + 1);
  }
  const lastEventId = request.headers["last-event-id"];
  if (Array.isArray(lastEventId) || (lastEventId !== undefined && typeof lastEventId !== "string")) {
    throw new AidenRemoteServiceError("invalid_request", "Last-Event-ID is invalid.", 400);
  }
  if (after !== undefined && lastEventId !== undefined && after !== lastEventId) {
    throw new AidenRemoteServiceError("invalid_request", "Stream cursors disagree.", 400);
  }
  const value = after ?? lastEventId ?? "0";
  if (!/^(?:0|[1-9]\d{0,15})$/u.test(value)) {
    throw new AidenRemoteServiceError("invalid_request", "The stream cursor is invalid.", 400);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new AidenRemoteServiceError("invalid_request", "The stream cursor is invalid.", 400);
  }
  return parsed;
}

function approvalDecision(value: unknown): {
  decision: "allow" | "deny";
  scope?: ToolApprovalScope;
} {
  const record = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
  const keys = record ? Object.keys(record) : [];
  const scope = record && "scope" in record ? parseToolApprovalScope(record.scope) : undefined;
  if (
    !record ||
    keys.some((key) => key !== "decision" && key !== "scope") ||
    (record.decision !== "allow" && record.decision !== "deny") ||
    // A scope is optional, must be known, and only widens an allow.
    ("scope" in record && (!scope || record.decision !== "allow"))
  ) {
    throw new AidenRemoteServiceError("invalid_request", "The approval response is invalid.", 400);
  }
  return scope ? { decision: record.decision, scope } : { decision: record.decision };
}

function pairingSecretHeader(request: IncomingMessage): string | undefined {
  const value = request.headers["aiden-pairing-secret"];
  return typeof value === "string" ? value : undefined;
}

function requiredHeader(
  request: IncomingMessage,
  name: "if-match" | "idempotency-key",
  pattern: RegExp,
): string {
  const value = request.headers[name];
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new AidenRemoteServiceError(
      "invalid_request",
      `${name === "if-match" ? "If-Match" : "Idempotency-Key"} is required and invalid.`,
      400,
    );
  }
  return value;
}

function selectionLocation(value: unknown): string {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    typeof (value as { location?: unknown }).location !== "string" ||
    !/^loc_[A-Za-z0-9_-]{43}$/u.test((value as { location: string }).location)
  ) {
    throw new AidenRemoteServiceError("invalid_request", "The folder selection request is invalid.", 400);
  }
  return (value as { location: string }).location;
}

function sourceIdentity(request: IncomingMessage): string {
  const address = request.socket.remoteAddress ?? "unknown";
  return address.length <= 128 ? address : "unknown";
}

function requireEmptyObject(value: unknown): void {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.keys(value).length !== 0
  ) {
    throw new AidenRemoteServiceError(
      "invalid_request",
      "This request body must be an empty JSON object.",
      400,
    );
  }
}

function botNoticeAcknowledgement(value: unknown): BotNoticeAcknowledgement {
  try {
    return parseBotNoticeAcknowledgement(value);
  } catch {
    throw new AidenRemoteServiceError(
      "invalid_request",
      "The Bot access notice acknowledgement is invalid.",
      400,
    );
  }
}

function requireDeviceCapabilities(
  device: AidenRemoteRouterAuthenticatedDevice,
  capabilities: readonly AidenRemoteCapability[],
): void {
  if (capabilities.every((capability) => device.capabilities.has(capability))) return;
  throw new AidenRemoteServiceError(
    "capability_denied",
    "This device does not have access to that Aiden capability.",
    403,
  );
}

function requireNegotiatedProgressCapability(
  device: AidenRemoteRouterAuthenticatedDevice,
  capability: AidenRemoteProgressCapability,
): void {
  if (
    device.acceptsProgressCapabilities === true &&
    device.capabilities.has(capability)
  ) {
    return;
  }
  throw new AidenRemoteServiceError(
    "capability_denied",
    "This device does not have access to that Aiden capability.",
    403,
  );
}

function progressCapabilitySupported(
  dependencies: AidenRemoteRouterDependencies,
  capability: AidenRemoteProgressCapability,
): boolean {
  if (capability === "questions:respond") {
    return dependencies.streams?.supportsQuestionPrompts?.() === true;
  }
  if (capability === "skills:invoke") {
    return typeof dependencies.chats?.chatSkillCatalog === "function";
  }
  if (!dependencies.chats || !dependencies.chatProgress?.openEvents) return false;
  return capability === "tasks:read"
    ? Boolean(dependencies.chatProgress.taskSnapshot)
    : Boolean(dependencies.chatProgress.agentRoster);
}

function hostCapabilitySupported(
  dependencies: AidenRemoteRouterDependencies,
  capability: AidenRemoteHostCapability,
): boolean {
  return capability === "host:events"
    ? Boolean(dependencies.hostFeed)
    : Boolean(dependencies.hostRuns && dependencies.chats);
}

function isDesktopDevice(device: Pick<AidenRemoteRouterAuthenticatedDevice, "type">): boolean {
  return device.type === "mac" || device.type === "linux";
}

/**
 * A phone's run grants never widen what it may already do in a chat (contract
 * revision 24): each run route also requires the phone's own per-chat grant.
 * Desktops keep the host-wide authority their run grant carries.
 */
function requirePhoneRunGrant(
  device: AidenRemoteRouterAuthenticatedDevice,
  capability: AidenRemoteCapability,
): void {
  if (isDesktopDevice(device) || device.capabilities.has(capability)) return;
  throw new AidenRemoteServiceError(
    "capability_denied",
    "This device does not have access to that Aiden capability.",
    403,
  );
}

/** `/health` takes no query, or exactly `detail=host` for the desktop descriptor. */
function healthDetailQuery(query: string): boolean {
  if (!query) return false;
  if (query === "detail=host") return true;
  throw new AidenRemoteServiceError("invalid_request", "The health query is invalid.", 400);
}

function chatMessagesQuery(query: string): { before?: string; limit: number } {
  let before: string | undefined;
  let limit: number | undefined;
  for (const component of query ? query.split("&") : []) {
    const separator = component.indexOf("=");
    const name = separator < 0 ? component : component.slice(0, separator);
    const value = separator < 0 ? "" : component.slice(separator + 1);
    if (name === "before" && before === undefined && /^[A-Za-z0-9._:-]{1,128}$/u.test(value)) {
      before = value;
    } else if (name === "limit" && limit === undefined && /^[1-9]\d{0,3}$/u.test(value)) {
      limit = Number(value);
      if (limit > AIDEN_REMOTE_CHAT_MESSAGES_WINDOW_MAX_LIMIT) {
        throw new AidenRemoteServiceError(
          "invalid_request",
          `The message window limit must be between 1 and ${AIDEN_REMOTE_CHAT_MESSAGES_WINDOW_MAX_LIMIT}.`,
          400,
        );
      }
    } else {
      throw new AidenRemoteServiceError("invalid_request", "The message window query is invalid.", 400);
    }
  }
  return {
    ...(before === undefined ? {} : { before }),
    limit: limit ?? AIDEN_REMOTE_CHAT_MESSAGES_WINDOW_DEFAULT_LIMIT,
  };
}

/**
 * The host-feed cursor from `?after=` or `Last-Event-ID`. The value is opaque
 * here; the feed answers anything it does not recognise with a snapshot.
 */
function hostFeedCursor(request: IncomingMessage, query: string): string | undefined {
  let after: string | undefined;
  if (query) {
    if (!query.startsWith("after=") || query.includes("&")) {
      throw new AidenRemoteServiceError("invalid_request", "The host feed cursor is invalid.", 400);
    }
    after = decodeURIComponent(query.slice("after=".length));
  }
  const lastEventId = request.headers["last-event-id"];
  if (Array.isArray(lastEventId)) {
    throw new AidenRemoteServiceError("invalid_request", "Last-Event-ID is invalid.", 400);
  }
  if (after !== undefined && lastEventId !== undefined && after !== lastEventId) {
    throw new AidenRemoteServiceError("invalid_request", "Stream cursors disagree.", 400);
  }
  const value = after ?? lastEventId;
  if (value === undefined || value === "") return undefined;
  if (!/^[\x21-\x7e]{1,128}$/u.test(value)) {
    throw new AidenRemoteServiceError("invalid_request", "The host feed cursor is invalid.", 400);
  }
  return value;
}

function hostRunsUnavailable(): AidenRemoteServiceError {
  return new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
}

function agentInterruptSupported(dependencies: AidenRemoteRouterDependencies): boolean {
  return (
    progressCapabilitySupported(dependencies, "agents:read") &&
    typeof dependencies.chatProgress?.interruptAgent === "function" &&
    dependencies.chatProgress.supportsAgentInterrupt !== false
  );
}

function advertisedServerCapabilities(
  device: AidenRemoteRouterAuthenticatedDevice,
  dependencies: AidenRemoteRouterDependencies,
): AidenRemoteCapability[] {
  return [
    ...AIDEN_REMOTE_LEGACY_CAPABILITIES,
    ...(device.acceptsBotCapabilities === true
      ? AIDEN_REMOTE_BOT_CAPABILITIES
      : []),
    ...(device.acceptsProgressCapabilities === true
      ? AIDEN_REMOTE_PROGRESS_CAPABILITIES.filter((capability) =>
          progressCapabilitySupported(dependencies, capability),
        )
      : []),
    // Desktop-only: phones and tablets are never told this vocabulary exists.
    ...((device.type === "mac" || device.type === "linux") &&
    dependencies.simulators?.host()
      ? AIDEN_REMOTE_SIMULATOR_CAPABILITIES
      : []),
    ...(isDesktopDevice(device) && device.acceptsProgressCapabilities === true
      ? AIDEN_REMOTE_HOST_CAPABILITIES.filter((capability) =>
          hostCapabilitySupported(dependencies, capability),
        )
      : []),
    // Phones are offered only the phone-scoped run subset (contract revision 24).
    ...(!isDesktopDevice(device)
      ? AIDEN_REMOTE_PHONE_RUN_CAPABILITIES.filter((capability) =>
          hostCapabilitySupported(dependencies, capability),
        )
      : []),
  ];
}

function includeArchivedBotsQuery(query: string): boolean {
  if (!query) return false;
  if (query === "includeArchived=true") return true;
  if (query === "includeArchived=false") return false;
  throw new AidenRemoteServiceError(
    "invalid_request",
    "The Bot list query is invalid.",
    400,
  );
}

function botCapabilityCatalogQuery(query: string): string | undefined {
  if (!query) return undefined;
  const components = query.split("&");
  if (components.length !== 1) {
    throw new AidenRemoteServiceError(
      "invalid_request",
      "The Bot capability catalog query is invalid.",
      400,
    );
  }
  const component = components[0]!;
  const separator = component.indexOf("=");
  const botId = separator < 0 ? "" : component.slice(separator + 1);
  if (
    component.slice(0, separator) !== "botId" ||
    botId.includes("=") ||
    !/^[A-Za-z0-9._:-]{1,160}$/u.test(botId)
  ) {
    throw new AidenRemoteServiceError(
      "invalid_request",
      "The Bot capability catalog query is invalid.",
      400,
    );
  }
  return botId;
}

function botConversationsQuery(query: string): AidenRemoteBotConversationQuery {
  if (!query) return {};
  const params = new URLSearchParams(query);
  const allowed = new Set(["cursor", "query", "botId", "limit"]);
  for (const key of params.keys()) {
    if (!allowed.has(key) || params.getAll(key).length !== 1) {
      throw new AidenRemoteServiceError(
        "invalid_request",
        "The Bot inbox query is invalid.",
        400,
      );
    }
  }
  const value: Record<string, unknown> = {};
  const cursor = params.get("cursor");
  const search = params.get("query");
  const botId = params.get("botId");
  const limit = params.get("limit");
  if (cursor !== null) value.cursor = cursor;
  if (search !== null) value.query = search;
  if (botId !== null) value.botId = botId;
  if (limit !== null) {
    if (!/^(?:[1-9]|[1-4][0-9]|50)$/u.test(limit)) {
      throw new AidenRemoteServiceError(
        "invalid_request",
        "The Bot inbox query is invalid.",
        400,
      );
    }
    value.limit = Number(limit);
  }
  try {
    return parseAidenRemoteBotConversationQuery(value);
  } catch {
    throw new AidenRemoteServiceError(
      "invalid_request",
      "The Bot inbox query is invalid.",
      400,
    );
  }
}

export function createAidenRemoteRequestHandler(
  dependencies: AidenRemoteRouterDependencies,
): (request: IncomingMessage, response: ServerResponse) => void {
  /**
   * Revocation fence for a long-lived subscription, crossed synchronously at
   * registration. Like the simulator relay, it does not join the mutation
   * drain: revocation closes registered subscriptions through `revokeDevice`,
   * and this check refuses one whose admission was still awaiting.
   */
  const admitDevice = (deviceId: string) => () => {
    dependencies.devices.acquireDeviceAuthorization(deviceId, false)();
  };
  return (request, response) => {
    negotiatedRequests.set(response, request);
    const id = requestId();
    const startedAt = dependencies.now();
    let route: Parameters<AidenRemoteRouterDependencies["log"]>[0]["route"] = "unknown";
    let deviceIdSuffix: string | undefined;
    let releaseDeviceAuthorization: (() => void) | undefined;
    let requestPath: string | undefined;
    const logRequest = (
      status: number,
      options: { errorCode?: string } = {},
    ) => {
      const routePath = requestPath === undefined
        ? undefined
        : remoteRouteTemplate(route, requestPath);
      dependencies.log({
        requestId: id,
        route,
        method: request.method,
        ...(routePath !== undefined ? { routePath } : {}),
        status,
        latencyMs: Math.max(0, dependencies.now() - startedAt),
        ...(deviceIdSuffix ? { deviceIdSuffix } : {}),
        ...(options.errorCode ? { errorCode: options.errorCode } : {}),
      });
    };
    void (async () => {
      if (request.headers.origin !== undefined) {
        throw new AidenRemoteServiceError(
          "invalid_request",
          "Browser-origin requests are not accepted by Aiden Remote.",
          403,
        );
      }
      const target = requestTarget(
        request,
        dependencies.acceptStrippedBasePath === true,
      );
      const { path, query } = target;
      requestPath = path;
      const authenticate = async (
        _request: IncomingMessage,
        _devices: Pick<AidenRemoteRouterDeviceRegistry, "authenticate">,
        capability: AidenRemoteCapability,
      ): Promise<AidenRemoteRouterAuthenticatedDevice> => {
        const device = await authenticateCredential(request, dependencies.devices, capability);
        // Every authenticated operation crosses the synchronous revocation
        // fence. Only mutations participate in the drain; SSE/read lifetimes
        // must not postpone durable revocation or cleanup. Simulator controls
        // can wait minutes on a boot and are closed by `revokeDevice` instead.
        releaseDeviceAuthorization = dependencies.devices.acquireDeviceAuthorization(
          device.id,
          request.method !== "GET" && path !== "/simulators" && !path.startsWith("/simulators/"),
        );
        return device;
      };
      if (request.method === "GET" && path === "/health") {
        route = "health";
        const detail = healthDetailQuery(query);
        // The default body stays exactly `{ok, protocolVersion}`; the
        // non-secret host descriptor is opt-in so strict decoders are unaffected.
        writeJson(response, 200, {
          ok: true,
          protocolVersion: AIDEN_REMOTE_PROTOCOL_VERSION,
          ...(detail
            ? {
                instanceId: dependencies.instanceId,
                displayName: dependencies.displayName(),
                ...(dependencies.platform ? { platform: dependencies.platform } : {}),
                contractRevision: AIDEN_REMOTE_CONTRACT_REVISION,
                pairingRequests: dependencies.pairingRequests?.accepting() === true,
              }
            : {}),
        });
        return;
      }
      if (request.method === "POST" && path === "/pairing/exchange") {
        requireNoQuery(query);
        route = "pairingExchange";
        const result = await dependencies.pairing.exchange(
          await readJsonBody(request),
          sourceIdentity(request),
        );
        writeJson(response, 200, result);
        return;
      }
      const pairingRequestMatch = /^\/pairing\/requests\/([A-Za-z0-9_-]{1,64})$/u.exec(path);
      const pairingRequestRevealMatch = /^\/pairing\/requests\/([A-Za-z0-9_-]{1,64})\/reveal$/u.exec(path);
      if (path === "/pairing/requests" || pairingRequestMatch || pairingRequestRevealMatch) {
        const requestIdSegment = pairingRequestMatch?.[1] ?? pairingRequestRevealMatch?.[1];
        route = pairingRequestMatch
          ? "pairingRequest"
          : pairingRequestRevealMatch
            ? "pairingRequestReveal"
            : "pairingRequests";
        const service = dependencies.pairingRequests;
        if (
          !service ||
          (requestIdSegment !== undefined && !AIDEN_PAIRING_REQUEST_ID_PATTERN.test(requestIdSegment))
        ) {
          throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        }
        requireNoQuery(query);
        // The poll secret travels only in a header so it never reaches a URL.
        const secret = pairingSecretHeader(request);
        if (route === "pairingRequests" && request.method === "POST") {
          const created = await service.create(await readJsonBody(request, 2_048), {
            source: sourceIdentity(request),
            transport: dependencies.acceptStrippedBasePath === true ? "tailscale" : "lan",
          });
          writeJson(response, 201, created);
          return;
        }
        if (route === "pairingRequestReveal" && request.method === "POST") {
          writeJson(response, 200, service.reveal(requestIdSegment!, secret, await readJsonBody(request, 256)));
          return;
        }
        if (route === "pairingRequest" && request.method === "GET") {
          const controller = new AbortController();
          const abort = () => controller.abort();
          response.once("close", abort);
          try {
            const status = await service.poll(requestIdSegment!, secret, controller.signal);
            if (controller.signal.aborted) return;
            writeJson(response, 200, status);
          } finally {
            response.off("close", abort);
          }
          return;
        }
        if (route === "pairingRequest" && request.method === "DELETE") {
          writeJson(response, 200, await service.cancel(requestIdSegment!, secret));
          return;
        }
        throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
      }
      if (request.method === "POST" && path === "/pairing/manual-bootstrap") {
        requireNoQuery(query);
        route = "pairingManualBootstrap";
        requireEmptyObject(await readJsonBody(request, 64));
        if (!dependencies.pairing.manualBootstrap) {
          throw new AidenRemoteServiceError(
            "not_found",
            "This endpoint is unavailable.",
            404,
          );
        }
        writeJson(response, 200, dependencies.pairing.manualBootstrap());
        return;
      }
      if (request.method === "GET" && path === "/server") {
        requireNoQuery(query);
        route = "server";
        const device = await authenticate(request, dependencies.devices, "server:read");
        deviceIdSuffix = device.id.slice(-8);
        const peerRoutes = (device.type === "mac" || device.type === "linux") && dependencies.peerRoutes
          ? await dependencies.peerRoutes() : undefined;
        const projection: AidenRemoteServerProjection = {
          protocolVersion: AIDEN_REMOTE_PROTOCOL_VERSION,
          instanceId: dependencies.instanceId,
          name: dependencies.displayName(),
          appVersion: dependencies.appVersion,
          ...(peerRoutes === undefined ? {} : { peerRoutes }),
          capabilities: [...device.capabilities],
          ...(device.name ? { deviceName: device.name } : {}),
          ...(device.acceptsBotCapabilities === true ||
            device.acceptsProgressCapabilities === true
            ? {
                serverCapabilities: advertisedServerCapabilities(
                  device,
                  dependencies,
                ),
              }
            : {}),
          connectionMode: dependencies.connectionMode(),
          features: [
            ...(peerRoutes === undefined ? [] : ["peer-routes-v1"]),
            ...(dependencies.providers ? [AIDEN_REMOTE_PROVIDER_CREATE_FEATURE] : []),
            ...(dependencies.readAloud ? [REMOTE_TTS_FEATURE] : []),
            ...(dependencies.chats?.listSummaries
              ? [AIDEN_REMOTE_CHAT_SUMMARY_FEATURE]
              : []),
            ...(dependencies.chats?.markRead && dependencies.chats.supportsReadMarkers === true
              ? [AIDEN_REMOTE_CHAT_READ_STATE_FEATURE]
              : []),
            ...(progressCapabilitySupported(dependencies, "tasks:read")
              ? [AIDEN_REMOTE_CHAT_TASKS_FEATURE]
              : []),
            ...(progressCapabilitySupported(dependencies, "agents:read")
              ? [AIDEN_REMOTE_CHAT_AGENTS_FEATURE]
              : []),
            ...(agentInterruptSupported(dependencies)
              ? [AIDEN_REMOTE_CHAT_AGENT_INTERRUPT_FEATURE]
              : []),
            ...(dependencies.streams?.supportsRunInput?.() === true
              ? [AIDEN_REMOTE_CHAT_RUN_INPUT_FEATURE]
              : []),
            ...(dependencies.streams?.supportsQuestionPrompts?.() === true
              ? [AIDEN_REMOTE_CHAT_QUESTION_PROMPTS_FEATURE]
              : []),
            ...(progressCapabilitySupported(dependencies, "skills:invoke")
              ? [AIDEN_REMOTE_CHAT_SKILLS_FEATURE]
              : []),
            ...(dependencies.chats?.messagesWindow
              ? [AIDEN_REMOTE_CHAT_MESSAGES_WINDOW_FEATURE, AIDEN_REMOTE_CHAT_MESSAGES_WINDOW_METADATA_FEATURE]
              : []),
            ...(dependencies.chats?.fork && dependencies.chats.supportsForks === true
              ? [AIDEN_REMOTE_CHAT_FORK_FEATURE]
              : []),
            ...(dependencies.chats?.fork && dependencies.chats.supportsForkSummaries === true
              ? [AIDEN_REMOTE_CHAT_FORK_SUMMARY_FEATURE]
              : []),
            // Host-wide features are announced to desktops only.
            ...(isDesktopDevice(device) && hostCapabilitySupported(dependencies, "host:events")
              ? [AIDEN_REMOTE_HOST_EVENTS_FEATURE]
              : []),
            ...(isDesktopDevice(device) && hostCapabilitySupported(dependencies, "runs:observe")
              ? [AIDEN_REMOTE_RUN_STREAMS_FEATURE, AIDEN_REMOTE_RUN_CONTROL_FEATURE]
              : []),
            ...(isDesktopDevice(device) && dependencies.pairingRequests
              ? [AIDEN_REMOTE_PAIRING_REQUESTS_FEATURE]
              : []),
            // Phones get only the phone-scoped run subset (contract revision 24).
            ...(!isDesktopDevice(device) && hostCapabilitySupported(dependencies, "runs:observe")
              ? [AIDEN_REMOTE_PHONE_RUN_CONTROL_FEATURE]
              : []),
          ],
          serverTime: new Date(dependencies.now()).toISOString(),
        };
        writeJson(response, 200, projection);
        return;
      }
      if (request.method === "PATCH" && path === "/device/identity") {
        requireNoQuery(query);
        route = "deviceIdentity";
        const device = await authenticate(request, dependencies.devices, "server:read");
        deviceIdSuffix = device.id.slice(-8);
        if (!dependencies.devices.updateDeviceName) {
          throw new AidenRemoteServiceError(
            "not_found",
            "This endpoint is unavailable.",
            404,
          );
        }
        const input = parseDeviceIdentityRequest(await readJsonBody(request, 1_024));
        const updated = await dependencies.devices.updateDeviceName(device.id, input.name);
        if (!updated) {
          throw new AidenRemoteServiceError(
            "credential_revoked",
            "This device is no longer available.",
            403,
          );
        }
        writeJson(response, 200, { name: updated.name });
        return;
      }
      if (request.method === "POST" && path === "/device/capabilities") {
        requireNoQuery(query);
        route = "deviceCapabilities";
        const device = await authenticate(request, dependencies.devices, "server:read");
        deviceIdSuffix = device.id.slice(-8);
        if (!dependencies.devices.upgradeDeviceCapabilities) {
          throw new AidenRemoteServiceError(
            "not_found",
            "This endpoint is unavailable.",
            404,
          );
        }
        const body = await readJsonBody(request, 1_024);
        let input;
        try {
          input = parseAidenRemoteDeviceCapabilitiesUpdateRequest(body);
        } catch {
          throw new AidenRemoteServiceError(
            "invalid_request",
            "The requested capabilities are not negotiable.",
            400,
          );
        }
        for (const capability of input.accepts) {
          if (capability === "simulators:control") {
            // Refuse non-desktops first so they never learn whether this Mac has simulators.
            if (device.type !== "mac" && device.type !== "linux") {
              throw new AidenRemoteServiceError(
                "capability_denied",
                "Only paired desktops may control this Mac's simulators.",
                403,
              );
            }
            if (!dependencies.simulators?.host()) throw simulatorsUnavailable();
          } else if ((AIDEN_REMOTE_HOST_CAPABILITIES as readonly string[]).includes(capability)) {
            // Refuse non-desktops first so they never learn whether host control
            // exists; phones may hold only the phone-scoped run subset.
            if (
              !isDesktopDevice(device) &&
              !(AIDEN_REMOTE_PHONE_RUN_CAPABILITIES as readonly string[]).includes(capability)
            ) {
              throw new AidenRemoteServiceError(
                "capability_denied",
                "Only paired desktops may observe or control this host's runs.",
                403,
              );
            }
            if (!hostCapabilitySupported(dependencies, capability as AidenRemoteHostCapability)) {
              throw new AidenRemoteServiceError(
                "not_found",
                "Host control is unavailable on this Aiden installation.",
                404,
              );
            }
          } else if (!progressCapabilitySupported(dependencies, capability as AidenRemoteProgressCapability)) {
            throw new AidenRemoteServiceError(
              "not_found",
              "This progress capability is unavailable on this Aiden installation.",
              404,
            );
          }
        }
        const updated = await dependencies.devices.upgradeDeviceCapabilities(
          device.id,
          input.accepts,
        );
        if (!updated) {
          throw new AidenRemoteServiceError(
            "credential_revoked",
            "This device is no longer available.",
            403,
          );
        }
        writeJson(response, 200, { capabilities: updated.capabilities });
        return;
      }
      if (request.method === "GET" && path === "/bot-access-notice") {
        requireNoQuery(query);
        route = "botAccessNotice";
        const device = await authenticate(request, dependencies.devices, "bot:read");
        deviceIdSuffix = device.id.slice(-8);
        if (!dependencies.botNotice) {
          throw new AidenRemoteServiceError(
            "not_found",
            "This endpoint is unavailable.",
            404,
          );
        }
        writeJson(response, 200, await dependencies.botNotice.status(device.id));
        return;
      }
      if (
        request.method === "POST" &&
        path === "/bot-access-notice/acknowledgement"
      ) {
        requireNoQuery(query);
        route = "botAccessNotice";
        const body = botNoticeAcknowledgement(await readJsonBody(request));
        const device = await authenticate(request, dependencies.devices, "bot:write");
        deviceIdSuffix = device.id.slice(-8);
        if (!device.capabilities.has("bot:read")) {
          throw new AidenRemoteServiceError(
            "capability_denied",
            "This device does not have access to that Aiden capability.",
            403,
          );
        }
        if (!dependencies.botNotice) {
          throw new AidenRemoteServiceError(
            "not_found",
            "This endpoint is unavailable.",
            404,
          );
        }
        writeJson(
          response,
          200,
          await dependencies.botNotice.acknowledge(device.id, body),
        );
        return;
      }
      if (path === "/bots" && request.method === "GET") {
        route = "bots";
        const device = await authenticate(request, dependencies.devices, "bot:read");
        deviceIdSuffix = device.id.slice(-8);
        if (!dependencies.bots) {
          throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        }
        writeJson(response, 200, await dependencies.bots.list(includeArchivedBotsQuery(query)));
        return;
      }
      if (path === "/bots" && request.method === "POST") {
        requireNoQuery(query);
        route = "bots";
        const body = await readJsonBody(request);
        const device = await authenticate(request, dependencies.devices, "bot:write");
        deviceIdSuffix = device.id.slice(-8);
        requireDeviceCapabilities(device, ["bot:read"]);
        if (!dependencies.bots) {
          throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        }
        const key = requiredHeader(request, "idempotency-key", /^[\x21-\x7e]{16,128}$/u);
        writeJson(
          response,
          201,
          await dependencies.bots.create(device.id, key, body),
        );
        return;
      }
      if (path === "/bot-capabilities" && request.method === "GET") {
        const botId = botCapabilityCatalogQuery(query);
        route = "botCapabilities";
        const device = await authenticate(request, dependencies.devices, "bot:read");
        deviceIdSuffix = device.id.slice(-8);
        if (!dependencies.bots) {
          throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        }
        writeJson(response, 200, await dependencies.bots.capabilityCatalog(device.id, botId));
        return;
      }
      if (path === "/bot-favorites" && request.method === "GET") {
        requireNoQuery(query);
        route = "botFavorites";
        const device = await authenticate(request, dependencies.devices, "bot:read");
        deviceIdSuffix = device.id.slice(-8);
        if (!dependencies.bots) {
          throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        }
        writeJson(response, 200, await dependencies.bots.favorites());
        return;
      }
      if (path === "/bot-favorites" && request.method === "PATCH") {
        requireNoQuery(query);
        route = "botFavorites";
        const body = await readJsonBody(request);
        const device = await authenticate(request, dependencies.devices, "bot:write");
        deviceIdSuffix = device.id.slice(-8);
        requireDeviceCapabilities(device, ["bot:read"]);
        if (!dependencies.bots) {
          throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        }
        const revision = requiredHeader(request, "if-match", /^[\x21-\x7e]{1,128}$/u);
        writeJson(
          response,
          200,
          await dependencies.bots.updateFavorites(revision, body),
        );
        return;
      }
      if (path === "/bot-conversations" && request.method === "GET") {
        route = "botConversations";
        const device = await authenticate(request, dependencies.devices, "bot:read");
        deviceIdSuffix = device.id.slice(-8);
        requireDeviceCapabilities(device, ["chat:read"]);
        if (!dependencies.bots?.listConversations) {
          throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        }
        writeJson(
          response,
          200,
          await dependencies.bots.listConversations(
            device.id,
            botConversationsQuery(query),
          ),
        );
        return;
      }
      const botConversationFilesMatch =
        /^\/bot-conversations\/([A-Za-z0-9._:-]{1,128})\/files$/u.exec(path);
      if (botConversationFilesMatch && request.method === "GET") {
        requireNoQuery(query);
        route = "botFiles";
        const device = await authenticate(request, dependencies.devices, "files:read");
        deviceIdSuffix = device.id.slice(-8);
        requireDeviceCapabilities(device, ["bot:read"]);
        if (!dependencies.botFiles) {
          throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        }
        writeJson(
          response,
          200,
          await dependencies.botFiles.list(device.id, botConversationFilesMatch[1]!),
        );
        return;
      }
      const botConversationFileMatch =
        /^\/bot-conversations\/([A-Za-z0-9._:-]{1,128})\/files\/(file_[A-Za-z0-9_-]{43})$/u.exec(path);
      if (botConversationFileMatch && request.method === "GET") {
        requireNoQuery(query);
        route = "botFile";
        const device = await authenticate(request, dependencies.devices, "files:read");
        deviceIdSuffix = device.id.slice(-8);
        requireDeviceCapabilities(device, ["bot:read"]);
        if (!dependencies.botFiles) {
          throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        }
        writeJson(
          response,
          200,
          await dependencies.botFiles.read(
            device.id,
            botConversationFileMatch[1]!,
            botConversationFileMatch[2]!,
          ),
        );
        return;
      }
      if (botConversationFileMatch && request.method === "PUT") {
        requireNoQuery(query);
        route = "botFile";
        // Complete the bounded upload before acquiring the paired-device and
        // Bot runtime leases, so stalled clients cannot delay revocation.
        const body = await readJsonBody(request, MAX_FILE_REQUEST_BODY_BYTES);
        const device = await authenticate(request, dependencies.devices, "files:write");
        deviceIdSuffix = device.id.slice(-8);
        requireDeviceCapabilities(device, ["bot:read", "bot:write"]);
        if (!dependencies.botFiles) {
          throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        }
        writeJson(
          response,
          200,
          await dependencies.botFiles.write(
            device.id,
            botConversationFileMatch[1]!,
            botConversationFileMatch[2]!,
            body,
          ),
        );
        return;
      }
      const botAvatarContentMatch =
        /^\/bots\/([A-Za-z0-9._:-]{1,160})\/avatar\/(avatar_revision_[0-9a-f]{32})$/u.exec(path);
      if (botAvatarContentMatch && request.method === "GET") {
        requireNoQuery(query);
        route = "botAvatar";
        const device = await authenticate(request, dependencies.devices, "bot:read");
        deviceIdSuffix = device.id.slice(-8);
        if (!dependencies.bots?.avatarContent) {
          throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        }
        const content = await dependencies.bots.avatarContent(
          botAvatarContentMatch[1]!,
          botAvatarContentMatch[2]!,
        );
        writeAttachmentContent(response, {
          bytes: content.bytes,
          mimeType: content.metadata.mimeType,
        });
        return;
      }
      const botAvatarMatch =
        /^\/bots\/([A-Za-z0-9._:-]{1,160})\/avatar$/u.exec(path);
      if (botAvatarMatch && request.method === "PUT") {
        requireNoQuery(query);
        route = "botAvatar";
        // Bound and parse the body before taking a device runtime lease. A
        // slow or stalled phone upload must not hold the revocation drain.
        const body = await readJsonBody(request, MAX_FILE_REQUEST_BODY_BYTES);
        const device = await authenticate(request, dependencies.devices, "bot:write");
        deviceIdSuffix = device.id.slice(-8);
        requireDeviceCapabilities(device, ["bot:read"]);
        if (!dependencies.bots?.putAvatar) {
          throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        }
        const revision = requiredHeader(request, "if-match", /^[\x21-\x7e]{1,128}$/u);
        const key = requiredHeader(request, "idempotency-key", /^[\x21-\x7e]{16,128}$/u);
        writeJson(
          response,
          200,
          await dependencies.bots.putAvatar(
            device.id,
            botAvatarMatch[1]!,
            revision,
            key,
            body,
          ),
        );
        return;
      }
      if (botAvatarMatch && request.method === "DELETE") {
        requireNoQuery(query);
        route = "botAvatar";
        const device = await authenticate(request, dependencies.devices, "bot:write");
        deviceIdSuffix = device.id.slice(-8);
        requireDeviceCapabilities(device, ["bot:read"]);
        if (!dependencies.bots?.deleteAvatar) {
          throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        }
        const revision = requiredHeader(request, "if-match", /^[\x21-\x7e]{1,128}$/u);
        writeJson(
          response,
          200,
          await dependencies.bots.deleteAvatar(botAvatarMatch[1]!, revision),
        );
        return;
      }
      const botRestoreMatch = /^\/bots\/([A-Za-z0-9._:-]{1,160})\/restore$/u.exec(path);
      if (botRestoreMatch && request.method === "POST") {
        requireNoQuery(query);
        route = "bot";
        const device = await authenticate(request, dependencies.devices, "bot:write");
        deviceIdSuffix = device.id.slice(-8);
        requireDeviceCapabilities(device, ["bot:read"]);
        if (!dependencies.bots) {
          throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        }
        const revision = requiredHeader(request, "if-match", /^[\x21-\x7e]{1,128}$/u);
        const key = requiredHeader(request, "idempotency-key", /^[\x21-\x7e]{16,128}$/u);
        writeJson(
          response,
          200,
          await dependencies.bots.restore(
            device.id,
            botRestoreMatch[1]!,
            revision,
            key,
          ),
        );
        return;
      }
      const botChatsMatch = /^\/bots\/([A-Za-z0-9._:-]{1,160})\/chats$/u.exec(path);
      if (botChatsMatch && request.method === "POST") {
        requireNoQuery(query);
        route = "bots";
        const body = await readJsonBody(request);
        const device = await authenticate(request, dependencies.devices, "bot:write");
        deviceIdSuffix = device.id.slice(-8);
        requireDeviceCapabilities(device, ["bot:read", "chat:write"]);
        if (!dependencies.bots) {
          throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        }
        const key = requiredHeader(request, "idempotency-key", /^[\x21-\x7e]{16,128}$/u);
        writeJson(
          response,
          201,
          await dependencies.bots.createChat(
            device.id,
            botChatsMatch[1]!,
            key,
            body,
          ),
        );
        return;
      }
      const botCapabilitiesMatch = /^\/bots\/([A-Za-z0-9._:-]{1,160})\/capabilities$/u.exec(path);
      if (botCapabilitiesMatch && request.method === "PATCH") {
        requireNoQuery(query);
        route = "botCapabilities";
        const body = await readJsonBody(request);
        const device = await authenticate(request, dependencies.devices, "bot:write");
        deviceIdSuffix = device.id.slice(-8);
        requireDeviceCapabilities(device, ["bot:read"]);
        if (!dependencies.bots) {
          throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        }
        const revision = requiredHeader(request, "if-match", /^[\x21-\x7e]{1,128}$/u);
        writeJson(
          response,
          200,
          await dependencies.bots.updateAccess(
            device.id,
            botCapabilitiesMatch[1]!,
            revision,
            body,
          ),
        );
        return;
      }
      const botMatch = /^\/bots\/([A-Za-z0-9._:-]{1,160})$/u.exec(path);
      if (botMatch && request.method === "GET") {
        requireNoQuery(query);
        route = "bot";
        const device = await authenticate(request, dependencies.devices, "bot:read");
        deviceIdSuffix = device.id.slice(-8);
        if (!dependencies.bots) {
          throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        }
        writeJson(response, 200, await dependencies.bots.get(botMatch[1]!, device.id));
        return;
      }
      if (botMatch && request.method === "PATCH") {
        requireNoQuery(query);
        route = "bot";
        const body = await readJsonBody(request);
        const device = await authenticate(request, dependencies.devices, "bot:write");
        deviceIdSuffix = device.id.slice(-8);
        requireDeviceCapabilities(device, ["bot:read"]);
        if (!dependencies.bots) {
          throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        }
        const revision = requiredHeader(request, "if-match", /^[\x21-\x7e]{1,128}$/u);
        writeJson(
          response,
          200,
          await dependencies.bots.updateIdentity(
            botMatch[1]!,
            revision,
            body,
            device.id,
          ),
        );
        return;
      }
      if (botMatch && request.method === "DELETE") {
        requireNoQuery(query);
        route = "bot";
        const device = await authenticate(request, dependencies.devices, "bot:write");
        deviceIdSuffix = device.id.slice(-8);
        requireDeviceCapabilities(device, ["bot:read"]);
        if (!dependencies.bots) {
          throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        }
        const revision = requiredHeader(request, "if-match", /^[\x21-\x7e]{1,128}$/u);
        writeJson(response, 200, await dependencies.bots.archive(botMatch[1]!, revision));
        return;
      }
      const botChatCapabilitiesMatch = /^\/chats\/([A-Za-z0-9._:-]{1,128})\/capabilities$/u.exec(path);
      if (botChatCapabilitiesMatch && request.method === "GET") {
        requireNoQuery(query);
        route = "botChatCapabilities";
        const device = await authenticate(request, dependencies.devices, "bot:read");
        deviceIdSuffix = device.id.slice(-8);
        requireDeviceCapabilities(device, ["chat:read"]);
        if (!dependencies.bots) {
          throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        }
        writeJson(response, 200, await dependencies.bots.getChatAccess(botChatCapabilitiesMatch[1]!));
        return;
      }
      if (botChatCapabilitiesMatch && request.method === "PATCH") {
        requireNoQuery(query);
        route = "botChatCapabilities";
        const body = await readJsonBody(request);
        const device = await authenticate(request, dependencies.devices, "bot:write");
        deviceIdSuffix = device.id.slice(-8);
        requireDeviceCapabilities(device, ["bot:read", "chat:write"]);
        if (!dependencies.bots) {
          throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        }
        const revision = requiredHeader(request, "if-match", /^[\x21-\x7e]{1,128}$/u);
        writeJson(
          response,
          200,
          await dependencies.bots.updateChatAccess(
            device.id,
            botChatCapabilitiesMatch[1]!,
            revision,
            body,
          ),
        );
        return;
      }
      if (path === "/workspaces" && request.method === "GET") {
        requireNoQuery(query);
        route = "workspaces";
        const device = await authenticate(request, dependencies.devices, "workspace:read");
        deviceIdSuffix = device.id.slice(-8);
        if (!dependencies.workspaces) throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        writeJson(response, 200, await dependencies.workspaces.list());
        return;
      }
      if (path === "/workspaces" && request.method === "POST") {
        requireNoQuery(query);
        route = "workspaces";
        const body = await readJsonBody(request);
        const device = await authenticate(request, dependencies.devices, "workspace:manage");
        deviceIdSuffix = device.id.slice(-8);
        if (!dependencies.workspaces) throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        const key = requiredHeader(request, "idempotency-key", /^[\x21-\x7e]{16,128}$/u);
        writeJson(
          response,
          201,
          await dependencies.workspaces.create(device.id, key, body),
        );
        return;
      }
      const workspaceMatch = /^\/workspaces\/([A-Za-z0-9_-]{1,128})$/u.exec(path);
      if (workspaceMatch && request.method === "GET") {
        requireNoQuery(query);
        route = "workspace";
        const device = await authenticate(request, dependencies.devices, "workspace:read");
        deviceIdSuffix = device.id.slice(-8);
        if (!dependencies.workspaces) throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        writeJson(response, 200, await dependencies.workspaces.get(workspaceMatch[1]!));
        return;
      }
      if (workspaceMatch && request.method === "PATCH") {
        requireNoQuery(query);
        route = "workspace";
        const body = await readJsonBody(request);
        const device = await authenticate(request, dependencies.devices, "workspace:manage");
        deviceIdSuffix = device.id.slice(-8);
        if (!dependencies.workspaces) throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        const revision = requiredHeader(request, "if-match", /^[\x21-\x7e]{1,128}$/u);
        writeJson(
          response,
          200,
          await dependencies.workspaces.update(
            workspaceMatch[1]!,
            revision,
            body,
          ),
        );
        return;
      }
      if (workspaceMatch && request.method === "DELETE") {
        requireNoQuery(query);
        route = "workspace";
        const device = await authenticate(request, dependencies.devices, "workspace:manage");
        deviceIdSuffix = device.id.slice(-8);
        if (!dependencies.workspaces) throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        const revision = requiredHeader(request, "if-match", /^[\x21-\x7e]{1,128}$/u);
        await dependencies.workspaces.remove(workspaceMatch[1]!, revision);
        response.writeHead(204, responseHeaders());
        response.end();
        return;
      }
      const workspaceFilesMatch = /^\/workspaces\/([A-Za-z0-9_-]{1,128})\/files$/u.exec(path);
      if (workspaceFilesMatch && request.method === "GET") {
        const params = new URLSearchParams(query);
        if (query && (params.get("tree") !== "1" || [...params.keys()].some(key =>
          !["tree", "directory", "cursor"].includes(key) || params.getAll(key).length !== 1) ||
          (params.has("directory") && !/^file_[A-Za-z0-9_-]{43}$/u.test(params.get("directory")!)) ||
          (params.has("cursor") && !/^cur_[A-Za-z0-9_-]{43}$/u.test(params.get("cursor")!)))) {
          throw new AidenRemoteServiceError("invalid_request", "The file page request is invalid.", 400);
        }
        route = "workspaceFiles";
        const device = await authenticate(request, dependencies.devices, "files:read");
        deviceIdSuffix = device.id.slice(-8);
        if (!dependencies.files) throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        if (query && !dependencies.files.children) throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        writeJson(response, 200, query
          ? await dependencies.files.children!(device.id, workspaceFilesMatch[1]!, params.get("directory") ?? undefined, params.get("cursor") ?? undefined)
          : await dependencies.files.list(device.id, workspaceFilesMatch[1]!));
        return;
      }
      const workspaceFileMatch = /^\/workspaces\/([A-Za-z0-9_-]{1,128})\/files\/(file_[A-Za-z0-9_-]{43})$/u.exec(path);
      if (workspaceFileMatch && request.method === "GET") {
        requireNoQuery(query);
        route = "workspaceFile";
        const device = await authenticate(request, dependencies.devices, "files:read");
        deviceIdSuffix = device.id.slice(-8);
        if (!dependencies.files) throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        writeJson(
          response,
          200,
          await dependencies.files.read(device.id, workspaceFileMatch[1]!, workspaceFileMatch[2]!),
        );
        return;
      }
      if (workspaceFileMatch && request.method === "PUT") {
        requireNoQuery(query);
        route = "workspaceFile";
        const body = await readJsonBody(request, MAX_FILE_REQUEST_BODY_BYTES);
        const device = await authenticate(request, dependencies.devices, "files:write");
        deviceIdSuffix = device.id.slice(-8);
        if (!dependencies.files) throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        writeJson(
          response,
          200,
          await dependencies.files.write(
            device.id,
            workspaceFileMatch[1]!,
            workspaceFileMatch[2]!,
            body,
          ),
        );
        return;
      }
      const gitBaseMatch = /^\/workspaces\/([A-Za-z0-9_-]{1,128})\/git\/(review|diff|branches|checkout|commit|push-capability|push|compare|comparison-diff|worktrees)$/u.exec(path);
      if (gitBaseMatch) {
        requireNoQuery(query);
        route = "workspaceGit";
        const workspaceId = gitBaseMatch[1]!;
        const action = gitBaseMatch[2]!;
        const readRoute =
          (action === "review" && request.method === "GET") ||
          (action === "diff" && request.method === "POST") ||
          (action === "branches" && request.method === "GET") ||
          (action === "push-capability" && request.method === "GET") ||
          (action === "compare" && request.method === "POST") ||
          (action === "comparison-diff" && request.method === "POST") ||
          (action === "worktrees" && request.method === "GET");
        const writeRoute =
          (action === "branches" && request.method === "POST") ||
          (action === "checkout" && request.method === "POST") ||
          (action === "commit" && request.method === "POST") ||
          (action === "push" && request.method === "POST") ||
          (action === "worktrees" && request.method === "POST");
        if (readRoute || writeRoute) {
          const body = request.method === "POST" ? await readJsonBody(request) : undefined;
          const device = await authenticate(
            request,
            dependencies.devices,
            writeRoute ? "git:write" : "git:read",
          );
          deviceIdSuffix = device.id.slice(-8);
          if (!dependencies.git) throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
          if (action === "review" && request.method === "GET") {
            writeJson(response, 200, await dependencies.git.review(device.id, workspaceId));
            return;
          }
          if (action === "diff" && request.method === "POST") {
            writeJson(response, 200, await dependencies.git.diff(device.id, workspaceId, body));
            return;
          }
          if (action === "branches" && request.method === "GET") {
            writeJson(response, 200, await dependencies.git.branches(device.id, workspaceId));
            return;
          }
          if (action === "branches" && request.method === "POST") {
            const key = requiredHeader(request, "idempotency-key", /^[\x21-\x7e]{16,128}$/u);
            writeJson(response, 202, await dependencies.git.createBranch(device.id, workspaceId, key, body));
            return;
          }
          if (action === "checkout" && request.method === "POST") {
            const key = requiredHeader(request, "idempotency-key", /^[\x21-\x7e]{16,128}$/u);
            writeJson(response, 202, await dependencies.git.checkout(device.id, workspaceId, key, body));
            return;
          }
          if (action === "commit" && request.method === "POST") {
            const key = requiredHeader(request, "idempotency-key", /^[\x21-\x7e]{16,128}$/u);
            writeJson(response, 202, await dependencies.git.commit(device.id, workspaceId, key, body));
            return;
          }
          if (action === "push-capability" && request.method === "GET") {
            writeJson(response, 200, await dependencies.git.pushCapability(device.id, workspaceId));
            return;
          }
          if (action === "push" && request.method === "POST") {
            const key = requiredHeader(request, "idempotency-key", /^[\x21-\x7e]{16,128}$/u);
            writeJson(response, 202, await dependencies.git.push(device.id, workspaceId, key, body));
            return;
          }
          if (action === "compare" && request.method === "POST") {
            writeJson(response, 200, await dependencies.git.compare(device.id, workspaceId, body));
            return;
          }
          if (action === "comparison-diff" && request.method === "POST") {
            writeJson(response, 200, await dependencies.git.comparisonDiff(device.id, workspaceId, body));
            return;
          }
          if (action === "worktrees" && request.method === "GET") {
            writeJson(response, 200, await dependencies.git.worktrees(device.id, workspaceId));
            return;
          }
          if (action === "worktrees" && request.method === "POST") {
            const key = requiredHeader(request, "idempotency-key", /^[\x21-\x7e]{16,128}$/u);
            writeJson(response, 202, await dependencies.git.createWorktree(device.id, workspaceId, key, body));
            return;
          }
        }
      }
      const managedWorktreeMatch = /^\/workspaces\/([A-Za-z0-9_-]{1,128})\/git\/managed-worktree$/u.exec(path);
      if (managedWorktreeMatch && request.method === "DELETE") {
        requireNoQuery(query);
        route = "workspaceGit";
        const body = await readJsonBody(request);
        const device = await authenticate(request, dependencies.devices, "git:write");
        deviceIdSuffix = device.id.slice(-8);
        if (!dependencies.git) throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        const revision = requiredHeader(request, "if-match", /^[\x21-\x7e]{1,128}$/u);
        const key = requiredHeader(request, "idempotency-key", /^[\x21-\x7e]{16,128}$/u);
        writeJson(
          response,
          202,
          await dependencies.git.deleteManagedWorktree(
            device.id,
            managedWorktreeMatch[1]!,
            revision,
            key,
            body,
          ),
        );
        return;
      }
      if (path === "/scheduled-tasks" && request.method === "GET") {
        requireNoQuery(query);
        route = "scheduledTasks";
        const device = await authenticate(request, dependencies.devices, "schedule:read");
        deviceIdSuffix = device.id.slice(-8);
        if (!dependencies.schedules) throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        writeJson(response, 200, await dependencies.schedules.list(device.id));
        return;
      }
      if (path === "/scheduled-tasks" && request.method === "POST") {
        requireNoQuery(query);
        route = "scheduledTasks";
        const body = await readJsonBody(request);
        const device = await authenticate(request, dependencies.devices, "schedule:write");
        deviceIdSuffix = device.id.slice(-8);
        if (!dependencies.schedules) throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        const key = requiredHeader(request, "idempotency-key", /^[\x21-\x7e]{16,128}$/u);
        writeJson(response, 201, await dependencies.schedules.create(device.id, key, body));
        return;
      }
      if (path === "/scheduled-tasks/preview" && request.method === "POST") {
        requireNoQuery(query);
        route = "scheduledTasks";
        const body = await readJsonBody(request);
        const device = await authenticate(request, dependencies.devices, "schedule:read");
        deviceIdSuffix = device.id.slice(-8);
        if (!dependencies.schedules) throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        writeJson(response, 200, dependencies.schedules.preview(body));
        return;
      }
      if (path === "/scheduled-tasks/scripts" && request.method === "GET") {
        route = "scheduledTasks";
        const device = await authenticate(request, dependencies.devices, "schedule:read");
        deviceIdSuffix = device.id.slice(-8);
        if (!dependencies.schedules) throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        writeJson(response, 200, await dependencies.schedules.scripts(device.id, scheduledScriptsQuery(query).workspaceId));
        return;
      }
      if (path === "/scheduled-tasks/mcp-servers" && request.method === "GET") {
        requireNoQuery(query);
        route = "scheduledTasks";
        const device = await authenticate(request, dependencies.devices, "schedule:read");
        deviceIdSuffix = device.id.slice(-8);
        if (!dependencies.schedules) throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        writeJson(response, 200, await dependencies.schedules.mcpServers());
        return;
      }
      if (path === "/scheduled-tasks/notifications" && request.method === "GET") {
        route = "scheduledTasks";
        const device = await authenticate(request, dependencies.devices, "schedule:read");
        deviceIdSuffix = device.id.slice(-8);
        if (!dependencies.schedules) throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        writeJson(response, 200, await dependencies.schedules.notifications(scheduledNotificationsQuery(query).since));
        return;
      }
      if (path === "/scheduled-tasks/settings" && request.method === "GET") {
        requireNoQuery(query);
        route = "scheduledTasks";
        const device = await authenticate(request, dependencies.devices, "schedule:read");
        deviceIdSuffix = device.id.slice(-8);
        if (!dependencies.schedules) throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        writeJson(response, 200, await dependencies.schedules.settings());
        return;
      }
      if (path === "/memory/settings" && request.method === "GET") {
        requireNoQuery(query);
        route = "memorySettings";
        const device = await authenticate(request, dependencies.devices, "workspace:read");
        deviceIdSuffix = device.id.slice(-8);
        if (!dependencies.memorySettings) throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        writeJson(response, 200, await dependencies.memorySettings.get());
        return;
      }
      if (path === "/memory/settings" && request.method === "PATCH") {
        requireNoQuery(query);
        route = "memorySettings";
        const body = await readJsonBody(request);
        const device = await authenticate(request, dependencies.devices, "workspace:manage");
        deviceIdSuffix = device.id.slice(-8);
        if (!dependencies.memorySettings) throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        const revision = requiredHeader(request, "if-match", /^[\x21-\x7e]{1,128}$/u);
        writeJson(response, 200, await dependencies.memorySettings.update(revision, body));
        return;
      }
      if (path === "/scheduled-tasks/settings" && request.method === "PATCH") {
        requireNoQuery(query);
        route = "scheduledTasks";
        const body = await readJsonBody(request);
        const device = await authenticate(request, dependencies.devices, "schedule:write");
        deviceIdSuffix = device.id.slice(-8);
        if (!dependencies.schedules) throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        const revision = requiredHeader(request, "if-match", /^[\x21-\x7e]{1,128}$/u);
        writeJson(response, 200, await dependencies.schedules.updateSettings(revision, body));
        return;
      }
      const scheduledRunsMatch = /^\/scheduled-tasks\/([A-Za-z0-9._:-]{1,160})\/runs$/u.exec(path);
      if (scheduledRunsMatch && request.method === "GET") {
        requireNoQuery(query);
        route = "scheduledTasks";
        const device = await authenticate(request, dependencies.devices, "schedule:read");
        deviceIdSuffix = device.id.slice(-8);
        if (!dependencies.schedules) throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        writeJson(response, 200, await dependencies.schedules.runs(scheduledRunsMatch[1]!));
        return;
      }
      const scheduledActionMatch = /^\/scheduled-tasks\/([A-Za-z0-9._:-]{1,160})\/(pause|resume|run)$/u.exec(path);
      if (scheduledActionMatch && request.method === "POST") {
        requireNoQuery(query);
        route = "scheduledTasks";
        const device = await authenticate(request, dependencies.devices, "schedule:write");
        deviceIdSuffix = device.id.slice(-8);
        if (!dependencies.schedules) throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        const taskId = scheduledActionMatch[1]!;
        const action = scheduledActionMatch[2]!;
        const key = requiredHeader(request, "idempotency-key", /^[\x21-\x7e]{16,128}$/u);
        const revision = requiredHeader(request, "if-match", /^[\x21-\x7e]{1,128}$/u);
        if (action === "run") {
          writeJson(response, 202, await dependencies.schedules.run(device.id, taskId, revision, key));
          return;
        }
        writeJson(response, 202, action === "pause"
          ? await dependencies.schedules.pause(device.id, taskId, revision, key)
          : await dependencies.schedules.resume(device.id, taskId, revision, key));
        return;
      }
      const scheduledTaskMatch = /^\/scheduled-tasks\/([A-Za-z0-9._:-]{1,160})$/u.exec(path);
      if (scheduledTaskMatch && request.method === "GET") {
        requireNoQuery(query);
        route = "scheduledTasks";
        const device = await authenticate(request, dependencies.devices, "schedule:read");
        deviceIdSuffix = device.id.slice(-8);
        if (!dependencies.schedules) throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        writeJson(response, 200, await dependencies.schedules.get(device.id, scheduledTaskMatch[1]!));
        return;
      }
      if (scheduledTaskMatch && request.method === "PATCH") {
        requireNoQuery(query);
        route = "scheduledTasks";
        const body = await readJsonBody(request);
        const device = await authenticate(request, dependencies.devices, "schedule:write");
        deviceIdSuffix = device.id.slice(-8);
        if (!dependencies.schedules) throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        const revision = requiredHeader(request, "if-match", /^[\x21-\x7e]{1,128}$/u);
        writeJson(response, 200, await dependencies.schedules.update(device.id, scheduledTaskMatch[1]!, revision, body));
        return;
      }
      if (scheduledTaskMatch && request.method === "DELETE") {
        requireNoQuery(query);
        route = "scheduledTasks";
        const device = await authenticate(request, dependencies.devices, "schedule:write");
        deviceIdSuffix = device.id.slice(-8);
        if (!dependencies.schedules) throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        const revision = requiredHeader(request, "if-match", /^[\x21-\x7e]{1,128}$/u);
        await dependencies.schedules.remove(scheduledTaskMatch[1]!, revision);
        response.writeHead(204, responseHeaders());
        response.end();
        return;
      }
      if (path === "/workspace-browser/roots" && request.method === "GET") {
        requireNoQuery(query);
        route = "workspaceBrowserRoots";
        const device = await authenticate(request, dependencies.devices, "workspace:browse");
        deviceIdSuffix = device.id.slice(-8);
        if (!dependencies.workspaceBrowser) throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        writeJson(response, 200, await dependencies.workspaceBrowser.listRoots(device.id));
        return;
      }
      if (path === "/workspace-browser/children" && request.method === "GET") {
        route = "workspaceBrowserChildren";
        const device = await authenticate(request, dependencies.devices, "workspace:browse");
        deviceIdSuffix = device.id.slice(-8);
        if (!dependencies.workspaceBrowser) throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        const parsed = browserQuery(query);
        writeJson(
          response,
          200,
          await dependencies.workspaceBrowser.listChildren(
            device.id,
            parsed.location,
            parsed.cursor,
          ),
        );
        return;
      }
      if (path === "/workspace-browser/selections" && request.method === "POST") {
        requireNoQuery(query);
        route = "workspaceBrowserSelection";
        const body = await readJsonBody(request);
        const device = await authenticate(request, dependencies.devices, "workspace:browse");
        deviceIdSuffix = device.id.slice(-8);
        if (!dependencies.workspaceBrowser) throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        writeJson(
          response,
          201,
          await dependencies.workspaceBrowser.createSelection(
            device.id,
            selectionLocation(body),
          ),
        );
        return;
      }
      if (path === "/providers" && request.method === "POST") {
        requireNoQuery(query);
        route = "providers";
        const device = await authenticate(request, dependencies.devices, "workspace:manage");
        requireDeviceCapabilities(device, ["server:read"]);
        deviceIdSuffix = device.id.slice(-8);
        if (!dependencies.providers) throw new AidenRemoteServiceError("not_found", "Provider creation requires an updated desktop app.", 404);
        const key = requiredHeader(request, "idempotency-key", /^[\x21-\x7e]{16,128}$/u);
        const body = await readJsonBody(request);
        const release = dependencies.devices.acquireDeviceAuthorization(device.id, true);
        try {
          writeJson(response, 201, await dependencies.providers.create(device.id, key, body, () => {
            try { admitDevice(device.id)(); return true; } catch { return false; }
          }));
        } finally { release(); }
        return;
      }
      if (path === "/models" && request.method === "GET") {
        requireNoQuery(query);
        route = "models";
        const device = await authenticate(request, dependencies.devices, "chat:read");
        deviceIdSuffix = device.id.slice(-8);
        if (!dependencies.models) throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        writeJson(response, 200, await dependencies.models.list());
        return;
      }
      if (path === "/usage" && request.method === "GET") {
        route = "usage";
        const device = await authenticate(request, dependencies.devices, "server:read");
        deviceIdSuffix = device.id.slice(-8);
        if (!dependencies.usage) throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        writeJson(response, 200, await dependencies.usage.summary(usageQuery(query)));
        return;
      }
      const readAloudChatMatch = /^\/chats\/([A-Za-z0-9._:-]{1,128})\/read-aloud$/u.exec(path);
      const readAloudStopMatch = /^\/chats\/([A-Za-z0-9._:-]{1,128})\/read-aloud\/stop$/u.exec(path);
      const readAloudAudioMatch = /^\/chats\/([A-Za-z0-9._:-]{1,128})\/read-aloud\/audio\/([A-Za-z0-9-]{1,128})\/(\d{1,5})\/(\d{1,9})$/u.exec(path);
      const readAloudMatch = readAloudChatMatch ?? readAloudStopMatch ?? readAloudAudioMatch;
      if ((path === "/read-aloud" && request.method === "GET") || readAloudMatch) {
        requireNoQuery(query);
        route = "readAloud";
        const method = request.method;
        const device = await authenticate(request, dependencies.devices, method === "GET" ? "chat:read" : "chat:write");
        deviceIdSuffix = device.id.slice(-8);
        const service = dependencies.readAloud;
        if (!service || !dependencies.chats) throw new AidenRemoteServiceError("not_found", "Read Aloud requires an updated desktop app.", 404);
        if (!readAloudMatch) { writeJson(response, 200, await service.status()); return; }
        const chatId = readAloudMatch[1]!;
        await requireChatAccess(dependencies.chats, device, chatId, method === "GET" ? "read" : "write");
        const chats = dependencies.chats;
        const authority = {
          deviceId: device.id, chatId,
          current: () => { try { dependencies.devices.acquireDeviceAuthorization(device.id, false)(); return true; } catch { return false; } },
          authorize: async () => { await requireChatAccess(chats, device, chatId, "write"); },
        };
        if (method === "GET" && readAloudAudioMatch) {
          writeJson(response, 200, await service.read(authority, readAloudAudioMatch[2]!, Number(readAloudAudioMatch[3]), Number(readAloudAudioMatch[4])));
        } else if (method === "GET" && readAloudChatMatch) {
          writeJson(response, 200, await service.status(authority));
        } else if (method === "POST" && !readAloudAudioMatch) {
          const body = await readJsonBody(request, 4096);
          writeJson(response, 200, readAloudStopMatch ? service.stop(authority, body) : await service.start(authority, body));
        } else throw new AidenRemoteServiceError("not_found", "Read Aloud configuration is available only on the desktop.", 404);
        return;
      }
      if (path === "/speech" && request.method === "GET") {
        requireNoQuery(query);
        route = "speech";
        const device = await authenticate(request, dependencies.devices, "server:read");
        deviceIdSuffix = device.id.slice(-8);
        if (!dependencies.speech) throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        writeJson(response, 200, await dependencies.speech.status());
        return;
      }
      if (path === "/speech" && request.method === "PATCH") {
        requireNoQuery(query);
        route = "speech";
        const body = await readJsonBody(request, 1_024);
        const device = await authenticate(request, dependencies.devices, "chat:write");
        deviceIdSuffix = device.id.slice(-8);
        if (!dependencies.speech) throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        writeJson(response, 200, await dependencies.speech.select(body));
        return;
      }
      const speechModelDownloadMatch = /^\/speech\/models\/([A-Za-z0-9._-]{1,64})\/download$/u.exec(path);
      if (speechModelDownloadMatch && request.method === "POST") {
        requireNoQuery(query);
        route = "speech";
        const device = await authenticate(request, dependencies.devices, "chat:write");
        deviceIdSuffix = device.id.slice(-8);
        if (!dependencies.speech) throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        writeJson(response, 202, await dependencies.speech.startDownload(speechModelDownloadMatch[1]!));
        return;
      }
      if (speechModelDownloadMatch && request.method === "DELETE") {
        requireNoQuery(query);
        route = "speech";
        const device = await authenticate(request, dependencies.devices, "chat:write");
        deviceIdSuffix = device.id.slice(-8);
        if (!dependencies.speech) throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        writeJson(response, 200, await dependencies.speech.cancelDownload(speechModelDownloadMatch[1]!));
        return;
      }
      const speechModelMatch = /^\/speech\/models\/([A-Za-z0-9._-]{1,64})$/u.exec(path);
      if (speechModelMatch && request.method === "DELETE") {
        requireNoQuery(query);
        route = "speech";
        const device = await authenticate(request, dependencies.devices, "chat:write");
        deviceIdSuffix = device.id.slice(-8);
        if (!dependencies.speech) throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        writeJson(response, 200, await dependencies.speech.deleteModel(speechModelMatch[1]!));
        return;
      }
      if (path === "/speech/transcriptions" && request.method === "POST") {
        requireNoQuery(query);
        route = "speech";
        // Reject unpaired peers before buffering the larger bounded speech body.
        // Re-authenticate through the mutation fence after parsing so revocation
        // that races the upload still prevents application-service admission.
        await authenticateCredential(request, dependencies.devices, "chat:write");
        const body = await readJsonBody(request, AIDEN_REMOTE_MAX_SPEECH_REQUEST_BYTES);
        const device = await authenticate(request, dependencies.devices, "chat:write");
        deviceIdSuffix = device.id.slice(-8);
        if (!dependencies.speech) throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        writeJson(response, 200, await dependencies.speech.transcribe(body));
        return;
      }
      if (path === "/chats" && request.method === "GET") {
        route = "chats";
        const device = await authenticate(request, dependencies.devices, "chat:read");
        deviceIdSuffix = device.id.slice(-8);
        if (!dependencies.chats) throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        writeJson(response, 200, await dependencies.chats.list(chatsQuery(query).workspaceId));
        return;
      }
      if (path === "/chat-summaries" && request.method === "GET") {
        route = "chatSummaries";
        const device = await authenticate(request, dependencies.devices, "chat:read");
        deviceIdSuffix = device.id.slice(-8);
        if (!dependencies.chats?.listSummaries) {
          throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        }
        const input = chatSummariesQuery(query);
        writeJson(
          response,
          200,
          await dependencies.chats.listSummaries(input.limit, input.cursor),
        );
        return;
      }
      if (path === "/chats" && request.method === "POST") {
        requireNoQuery(query);
        route = "chats";
        const body = await readJsonBody(request);
        const device = await authenticate(request, dependencies.devices, "chat:write");
        deviceIdSuffix = device.id.slice(-8);
        if (!dependencies.chats) throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        const key = requiredHeader(request, "idempotency-key", /^[\x21-\x7e]{16,128}$/u);
        writeJson(response, 201, await dependencies.chats.create(device.id, key, body));
        return;
      }
      const chatMatch = /^\/chats\/([A-Za-z0-9._:-]{1,128})$/u.exec(path);
      if (chatMatch && request.method === "GET") {
        requireNoQuery(query);
        route = "chat";
        const device = await authenticate(request, dependencies.devices, "chat:read");
        deviceIdSuffix = device.id.slice(-8);
        if (!dependencies.chats) throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        await requireChatAccess(dependencies.chats, device, chatMatch[1]!, "read");
        const chat = await dependencies.chats.get(chatMatch[1]!);
        writeJson(response, 200, chat);
        return;
      }
      if (chatMatch && request.method === "PATCH") {
        requireNoQuery(query);
        route = "chat";
        const body = await readJsonBody(request);
        const device = await authenticate(request, dependencies.devices, "chat:write");
        deviceIdSuffix = device.id.slice(-8);
        if (!dependencies.chats) throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        const revision = requiredHeader(request, "if-match", /^[\x21-\x7e]{1,128}$/u);
        writeJson(
          response,
          200,
          await runChatMutation(dependencies.chats, device, chatMatch[1]!, "chat", () =>
            dependencies.chats!.rename(chatMatch[1]!, revision, body)),
        );
        return;
      }
      if (chatMatch && request.method === "DELETE") {
        requireNoQuery(query);
        route = "chat";
        const device = await authenticate(request, dependencies.devices, "chat:write");
        deviceIdSuffix = device.id.slice(-8);
        if (!dependencies.chats) throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        const revision = requiredHeader(request, "if-match", /^[\x21-\x7e]{1,128}$/u);
        await runChatMutation(dependencies.chats, device, chatMatch[1]!, "chat", () =>
          dependencies.chats!.remove(chatMatch[1]!, revision));
        response.writeHead(204, responseHeaders());
        response.end();
        return;
      }
      const readMatch = /^\/chats\/([A-Za-z0-9._:-]{1,128})\/read$/u.exec(path);
      if (readMatch && request.method === "POST") {
        requireNoQuery(query);
        route = "chatRead";
        const body = await readJsonBody(request, 1_024);
        // Viewing is a read: a read-only device may still clear its own unread dot.
        const device = await authenticate(request, dependencies.devices, "chat:read");
        deviceIdSuffix = device.id.slice(-8);
        const chats = dependencies.chats;
        if (!chats?.markRead || chats.supportsReadMarkers !== true) {
          throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        }
        await requireChatAccess(chats, device, readMatch[1]!, "read");
        await chats.markRead(readMatch[1]!, body);
        response.writeHead(204, responseHeaders());
        response.end();
        return;
      }
      const moveMatch = /^\/chats\/([A-Za-z0-9._:-]{1,128})\/move$/u.exec(path);
      if (moveMatch && request.method === "POST") {
        requireNoQuery(query);
        route = "chatMove";
        const body = await readJsonBody(request);
        const device = await authenticate(request, dependencies.devices, "chat:write");
        deviceIdSuffix = device.id.slice(-8);
        if (!dependencies.chats) throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        const revision = requiredHeader(request, "if-match", /^[\x21-\x7e]{1,128}$/u);
        const key = requiredHeader(request, "idempotency-key", /^[\x21-\x7e]{16,128}$/u);
        writeJson(
          response,
          200,
          await runChatMutation(dependencies.chats, device, moveMatch[1]!, "chat", () =>
            dependencies.chats!.move(device.id, moveMatch[1]!, revision, key, body)),
        );
        return;
      }
      const forkMatch = /^\/chats\/([A-Za-z0-9._:-]{1,128})\/fork$/u.exec(path);
      if (forkMatch && request.method === "POST") {
        requireNoQuery(query);
        route = "chatFork";
        const body = await readJsonBody(request, 4_096);
        const device = await authenticate(request, dependencies.devices, "chat:write");
        deviceIdSuffix = device.id.slice(-8);
        const chats = dependencies.chats;
        if (!chats?.fork || chats.supportsForks !== true) {
          throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        }
        const revision = requiredHeader(request, "if-match", /^[\x21-\x7e]{1,128}$/u);
        const key = requiredHeader(request, "idempotency-key", /^[\x21-\x7e]{16,128}$/u);
        writeJson(
          response,
          201,
          await runChatMutation(chats, device, forkMatch[1]!, "chat", () =>
            chats.fork!(device.id, forkMatch[1]!, revision, key, body)),
        );
        return;
      }
      const forkSummaryMatch = /^\/chats\/([A-Za-z0-9._:-]{1,128})\/fork-summary\/(retry|skip|cancel)$/u.exec(path);
      if (forkSummaryMatch && request.method === "POST") {
        requireNoQuery(query);
        route = "chatForkSummary";
        const device = await authenticate(request, dependencies.devices, "chat:write");
        deviceIdSuffix = device.id.slice(-8);
        const chats = dependencies.chats;
        if (
          !chats?.retryForkSummary ||
          !chats.skipForkSummary ||
          !chats.cancelForkSummary ||
          chats.supportsForkSummaries !== true
        ) {
          throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        }
        const chatId = forkSummaryMatch[1]!;
        const action = forkSummaryMatch[2] as "retry" | "skip" | "cancel";
        writeJson(
          response,
          200,
          await runChatMutation<unknown>(chats, device, chatId, "chat", () =>
            action === "retry"
              ? chats.retryForkSummary!(chatId)
              : action === "skip"
                ? chats.skipForkSummary!(chatId)
                : chats.cancelForkSummary!(chatId)),
        );
        return;
      }
      const chatTasksMatch = /^\/chats\/([A-Za-z0-9._:-]{1,128})\/tasks$/u.exec(path);
      if (chatTasksMatch && request.method === "GET") {
        requireNoQuery(query);
        route = "chatTasks";
        const device = await authenticate(request, dependencies.devices, "chat:read");
        deviceIdSuffix = device.id.slice(-8);
        const chatProgress = dependencies.chatProgress;
        if (!dependencies.chats || !chatProgress || !progressCapabilitySupported(dependencies, "tasks:read")) {
          throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        }
        requireNegotiatedProgressCapability(device, "tasks:read");
        await requireChatAccess(dependencies.chats, device, chatTasksMatch[1]!, "read");
        writeJson(
          response,
          200,
          await chatProgress.taskSnapshot(device.id, chatTasksMatch[1]!),
        );
        return;
      }
      const chatAgentsMatch = /^\/chats\/([A-Za-z0-9._:-]{1,128})\/agents$/u.exec(path);
      if (chatAgentsMatch && request.method === "GET") {
        const agentsQuery = chatAgentsQuery(query);
        route = "chatAgents";
        const device = await authenticate(request, dependencies.devices, "chat:read");
        deviceIdSuffix = device.id.slice(-8);
        const chatProgress = dependencies.chatProgress;
        if (!dependencies.chats || !chatProgress || !progressCapabilitySupported(dependencies, "agents:read")) {
          throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        }
        requireNegotiatedProgressCapability(device, "agents:read");
        await requireChatAccess(dependencies.chats, device, chatAgentsMatch[1]!, "read");
        writeJson(
          response,
          200,
          await chatProgress.agentRoster(
            device.id,
            chatAgentsMatch[1]!,
            agentsQuery.turnId,
          ),
        );
        return;
      }
      const chatAgentInterruptMatch =
        /^\/chats\/([A-Za-z0-9._:-]{1,128})\/agents\/([A-Za-z0-9._:-]{1,128})\/interrupt$/u.exec(path);
      if (chatAgentInterruptMatch && request.method === "POST") {
        requireNoQuery(query);
        route = "chatAgentInterrupt";
        const device = await authenticate(request, dependencies.devices, "chat:write");
        deviceIdSuffix = device.id.slice(-8);
        const chatProgress = dependencies.chatProgress;
        if (!dependencies.chats || !chatProgress?.interruptAgent || !agentInterruptSupported(dependencies)) {
          throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        }
        // Targeting an agent requires being able to see it: the stop is
        // gated on the same negotiated read grant as the roster.
        requireNegotiatedProgressCapability(device, "agents:read");
        const [, chatId, agentId] = chatAgentInterruptMatch;
        writeJson(
          response,
          200,
          await runChatMutation(dependencies.chats, device, chatId!, "chat", () =>
            chatProgress.interruptAgent!(device.id, chatId!, agentId!)),
        );
        return;
      }
      const chatSkillsMatch = /^\/chats\/([A-Za-z0-9._:-]{1,128})\/skills$/u.exec(path);
      if (chatSkillsMatch && request.method === "GET") {
        requireNoQuery(query);
        route = "chatSkills";
        const device = await authenticate(request, dependencies.devices, "chat:read");
        deviceIdSuffix = device.id.slice(-8);
        if (typeof dependencies.chats?.chatSkillCatalog !== "function") {
          throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        }
        requireNegotiatedProgressCapability(device, "skills:invoke");
        await requireChatAccess(dependencies.chats, device, chatSkillsMatch[1]!, "read");
        writeJson(
          response,
          200,
          await dependencies.chats.chatSkillCatalog(device.id, chatSkillsMatch[1]!),
        );
        return;
      }
      const chatProgressEventsMatch = /^\/chats\/([A-Za-z0-9._:-]{1,128})\/progress\/events$/u.exec(path);
      if (chatProgressEventsMatch && request.method === "GET") {
        route = "chatProgressEvents";
        const device = await authenticate(request, dependencies.devices, "chat:read");
        deviceIdSuffix = device.id.slice(-8);
        if (!dependencies.chats || !dependencies.chatProgress?.openEvents) {
          throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        }
        const canReadTasks =
          device.acceptsProgressCapabilities === true &&
          device.capabilities.has("tasks:read") &&
          progressCapabilitySupported(dependencies, "tasks:read");
        const canReadAgents =
          device.acceptsProgressCapabilities === true &&
          device.capabilities.has("agents:read") &&
          progressCapabilitySupported(dependencies, "agents:read");
        if (!canReadTasks && !canReadAgents) {
          throw new AidenRemoteServiceError(
            device.acceptsProgressCapabilities === true
              ? "not_found"
              : "capability_denied",
            device.acceptsProgressCapabilities === true
              ? "This progress capability is unavailable on this Aiden installation."
              : "This device does not have access to that Aiden capability.",
            device.acceptsProgressCapabilities === true ? 404 : 403,
          );
        }
        // The progress service must receive only the projections this device
        // can both read and the current server implementation can produce.
        // Passing the complete device grant set would let a partial-support
        // adapter emit a snapshot for an unsupported progress capability.
        const progressGrants = new Set<AidenRemoteCapability>();
        if (canReadTasks) progressGrants.add("tasks:read");
        if (canReadAgents) progressGrants.add("agents:read");
        await requireChatAccess(dependencies.chats, device, chatProgressEventsMatch[1]!, "read");
        const progressEpoch = request.headers["aiden-progress-epoch"];
        if (progressEpoch !== undefined && (typeof progressEpoch !== "string" || !/^[A-Za-z0-9._:-]{1,64}$/u.test(progressEpoch))) {
          throw new AidenRemoteServiceError("invalid_request", "The progress epoch is invalid.", 400);
        }
        await dependencies.chatProgress.openEvents(
          device.id,
          chatProgressEventsMatch[1]!,
          progressGrants,
          streamAfter(request, query),
          response,
          progressEpoch,
        );
        return;
      }
      const turnsMatch = /^\/chats\/([A-Za-z0-9._:-]{1,128})\/turns$/u.exec(path);
      if (turnsMatch && request.method === "POST") {
        requireNoQuery(query);
        route = "turns";
        const body = await readJsonBody(request);
        const device = await authenticate(request, dependencies.devices, "chat:write");
        deviceIdSuffix = device.id.slice(-8);
        if (!dependencies.chats) throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        const key = requiredHeader(request, "idempotency-key", /^[\x21-\x7e]{16,128}$/u);
        writeJson(
          response,
          202,
          await runChatMutation(dependencies.chats, device, turnsMatch[1]!, "chat", () =>
            dependencies.chats!.startTurn(device.id, turnsMatch[1]!, key, body)),
        );
        return;
      }
      const attachmentCollectionMatch = /^\/chats\/([A-Za-z0-9._:-]{1,128})\/attachments$/u.exec(path);
      if (attachmentCollectionMatch && request.method === "POST") {
        requireNoQuery(query);
        route = "chatAttachment";
        const body = await readJsonBody(request, MAX_AIDEN_REMOTE_ATTACHMENT_REQUEST_BYTES);
        const device = await authenticate(request, dependencies.devices, "chat:write");
        deviceIdSuffix = device.id.slice(-8);
        if (!dependencies.chats?.uploadAttachment) throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        writeJson(
          response,
          201,
          await runChatMutation(
            dependencies.chats,
            device,
            attachmentCollectionMatch[1]!,
            "chat",
            () => dependencies.chats!.uploadAttachment!(
              device.id,
              attachmentCollectionMatch[1]!,
              body,
            ),
          ),
        );
        return;
      }
      const attachmentMatch = /^\/chats\/([A-Za-z0-9._:-]{1,128})\/attachments\/(att_[A-Za-z0-9_-]{43})$/u.exec(path);
      if (attachmentMatch && request.method === "DELETE") {
        requireNoQuery(query);
        route = "chatAttachment";
        const device = await authenticate(request, dependencies.devices, "chat:write");
        deviceIdSuffix = device.id.slice(-8);
        if (!dependencies.chats?.removeAttachment) throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        await runChatMutation(dependencies.chats, device, attachmentMatch[1]!, "chat", () =>
          dependencies.chats!.removeAttachment!(device.id, attachmentMatch[1]!, attachmentMatch[2]!));
        response.writeHead(204, responseHeaders());
        response.end();
        return;
      }
      const attachmentContentMatch = /^\/chats\/([A-Za-z0-9._:-]{1,128})\/attachments\/([A-Za-z0-9._:-]{1,256})\/content$/u.exec(path);
      if (attachmentContentMatch && request.method === "GET") {
        requireNoQuery(query);
        route = "chatAttachment";
        const device = await authenticate(request, dependencies.devices, "chat:read");
        deviceIdSuffix = device.id.slice(-8);
        if (!dependencies.chats?.attachmentContent) {
          throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        }
        await requireChatAccess(dependencies.chats, device, attachmentContentMatch[1]!, "read");
        writeAttachmentContent(
          response,
          await dependencies.chats.attachmentContent(
            attachmentContentMatch[1]!,
            attachmentContentMatch[2]!,
          ),
        );
        return;
      }
      const streamMatch = /^\/streams\/([A-Za-z0-9._:-]{1,128})$/u.exec(path);
      if (streamMatch && request.method === "GET") {
        requireNoQuery(query);
        route = "stream";
        const device = await authenticate(request, dependencies.devices, "chat:read");
        deviceIdSuffix = device.id.slice(-8);
        if (!dependencies.streams || !dependencies.chats) throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        const chatId = dependencies.streams.streamChatId(device.id, streamMatch[1]!);
        await requireChatAccess(dependencies.chats, device, chatId, "read", "stream");
        const status = dependencies.streams.status(device.id, streamMatch[1]!);
        writeJson(response, 200, status);
        return;
      }
      const eventsMatch = /^\/streams\/([A-Za-z0-9._:-]{1,128})\/events$/u.exec(path);
      if (eventsMatch && request.method === "GET") {
        route = "streamEvents";
        const device = await authenticate(request, dependencies.devices, "chat:read");
        deviceIdSuffix = device.id.slice(-8);
        if (!dependencies.streams || !dependencies.chats) throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        const chatId = dependencies.streams.streamChatId(device.id, eventsMatch[1]!);
        await requireChatAccess(dependencies.chats, device, chatId, "read", "stream");
        dependencies.streams.openEvents(device.id, eventsMatch[1]!, streamAfter(request, query), response);
        return;
      }
      const streamApprovalMatch = /^\/streams\/([A-Za-z0-9._:-]{1,128})\/approval$/u.exec(path);
      if (streamApprovalMatch && request.method === "GET") {
        requireNoQuery(query);
        route = "streamApproval";
        const device = await authenticate(request, dependencies.devices, "chat:read");
        deviceIdSuffix = device.id.slice(-8);
        if (!dependencies.streams || !dependencies.chats) throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        const chatId = dependencies.streams.streamChatId(device.id, streamApprovalMatch[1]!);
        await requireChatAccess(dependencies.chats, device, chatId, "read", "stream");
        const pending = dependencies.streams.pendingApproval(
          device.id,
          streamApprovalMatch[1]!,
        );
        const requiredCapability = pending
          ? dependencies.streams.approvalRequiredCapability(
              device.id,
              pending.approvalId,
            )
          : undefined;
        const approval =
          pending &&
          requiredCapability &&
          !device.capabilities.has(requiredCapability)
            ? { ...pending, canAllow: false }
            : pending;
        writeJson(response, 200, { approval });
        return;
      }
      const streamQuestionMatch = /^\/streams\/([A-Za-z0-9._:-]{1,128})\/question$/u.exec(path);
      if (streamQuestionMatch && request.method === "GET") {
        requireNoQuery(query);
        route = "streamQuestion";
        const device = await authenticate(request, dependencies.devices, "chat:read");
        deviceIdSuffix = device.id.slice(-8);
        if (
          !dependencies.streams?.pendingQuestion ||
          dependencies.streams.supportsQuestionPrompts?.() !== true ||
          !dependencies.chats
        ) {
          throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        }
        const chatId = dependencies.streams.streamChatId(device.id, streamQuestionMatch[1]!);
        await requireChatAccess(dependencies.chats, device, chatId, "read", "stream");
        writeJson(response, 200, {
          question: dependencies.streams.pendingQuestion(
            device.id,
            streamQuestionMatch[1]!,
          ),
        });
        return;
      }
      const cancelMatch = /^\/streams\/([A-Za-z0-9._:-]{1,128})\/cancel$/u.exec(path);
      if (cancelMatch && request.method === "POST") {
        requireNoQuery(query);
        route = "streamCancel";
        const device = await authenticate(request, dependencies.devices, "chat:write");
        deviceIdSuffix = device.id.slice(-8);
        const key = requiredHeader(request, "idempotency-key", /^[\x21-\x7e]{16,128}$/u);
        if (!dependencies.streams || !dependencies.chats) throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        const chatId = dependencies.streams.streamChatId(device.id, cancelMatch[1]!);
        writeJson(
          response,
          202,
          await runChatMutation(dependencies.chats, device, chatId, "stream", () =>
            dependencies.streams!.cancel(device.id, cancelMatch[1]!, key)),
        );
        return;
      }
      const streamInputsMatch = /^\/streams\/([A-Za-z0-9._:-]{1,128})\/inputs$/u.exec(path);
      if (streamInputsMatch && request.method === "POST") {
        requireNoQuery(query);
        route = "streamInputs";
        const device = await authenticate(request, dependencies.devices, "chat:write");
        deviceIdSuffix = device.id.slice(-8);
        const key = requiredHeader(request, "idempotency-key", /^[\x21-\x7e]{16,128}$/u);
        const body = await readJsonBody(request);
        if (
          !dependencies.streams?.submitInput ||
          dependencies.streams.supportsRunInput?.() !== true ||
          !dependencies.chats
        ) {
          throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        }
        writeJson(
          response,
          200,
          await dependencies.streams.submitInput(
            device.id,
            streamInputsMatch[1]!,
            body,
            key,
            (chatId, action) =>
              runChatMutation(dependencies.chats!, device, chatId, "stream", action),
          ),
        );
        return;
      }
      const questionMatch = /^\/questions\/([A-Za-z0-9._:-]{1,128})\/respond$/u.exec(path);
      if (questionMatch && request.method === "POST") {
        requireNoQuery(query);
        route = "questionRespond";
        const body = await readJsonBody(request);
        let input;
        try {
          input = parseAidenRemoteQuestionRespondRequest(body);
        } catch {
          throw new AidenRemoteServiceError(
            "invalid_request",
            "The question response is invalid.",
            400,
          );
        }
        const device = await authenticate(request, dependencies.devices, "questions:respond");
        deviceIdSuffix = device.id.slice(-8);
        const key = requiredHeader(request, "idempotency-key", /^[\x21-\x7e]{16,128}$/u);
        if (
          !dependencies.streams?.respondQuestion ||
          dependencies.streams.supportsQuestionPrompts?.() !== true ||
          !dependencies.chats
        ) {
          throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        }
        writeJson(
          response,
          200,
          await dependencies.streams.respondQuestion(
            device.id,
            questionMatch[1]!,
            input,
            key,
            (chatId, action) =>
              runChatMutation(dependencies.chats!, device, chatId, "question", action),
          ),
        );
        return;
      }
      const approvalMatch = /^\/approvals\/([A-Za-z0-9._:-]{1,128})\/respond$/u.exec(path);
      if (approvalMatch && request.method === "POST") {
        requireNoQuery(query);
        route = "approvalRespond";
        const body = await readJsonBody(request);
        const { decision, scope } = approvalDecision(body);
        const device = await authenticate(request, dependencies.devices, "approval:respond");
        deviceIdSuffix = device.id.slice(-8);
        const key = requiredHeader(request, "idempotency-key", /^[\x21-\x7e]{16,128}$/u);
        if (!dependencies.streams || !dependencies.chats) throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        writeJson(
          response,
          200,
          await dependencies.streams.respondApproval(
            device.id,
            approvalMatch[1]!,
            decision,
            key,
            (chatId, action) =>
              runChatMutation(dependencies.chats!, device, chatId, "approval", async () => {
                const requiredCapability =
                  dependencies.streams!.approvalRequiredCapability(
                    device.id,
                    approvalMatch[1]!,
                  );
                if (decision === "allow" && requiredCapability) {
                  requireDeviceCapabilities(device, [requiredCapability]);
                }
                return action();
              }),
            scope,
          ),
        );
        return;
      }
      if (path === "/host/events" && request.method === "GET") {
        route = "hostEvents";
        const cursor = hostFeedCursor(request, query);
        const device = await authenticate(request, dependencies.devices, "host:events");
        deviceIdSuffix = device.id.slice(-8);
        if (!dependencies.hostFeed) throw hostRunsUnavailable();
        await dependencies.hostFeed.open(device, cursor, response, admitDevice(device.id));
        return;
      }
      const chatMessagesMatch = /^\/chats\/([A-Za-z0-9._:-]{1,128})\/messages$/u.exec(path);
      if (chatMessagesMatch && request.method === "GET") {
        route = "chatMessages";
        const input = chatMessagesQuery(query);
        const device = await authenticate(request, dependencies.devices, "chat:read");
        deviceIdSuffix = device.id.slice(-8);
        if (!dependencies.chats?.messagesWindow) throw hostRunsUnavailable();
        await requireChatAccess(dependencies.chats, device, chatMessagesMatch[1]!, "read");
        writeJson(
          response,
          200,
          await dependencies.chats.messagesWindow(chatMessagesMatch[1]!, input),
        );
        return;
      }
      const currentRunMatch = /^\/chats\/([A-Za-z0-9._:-]{1,128})\/runs\/current\/events$/u.exec(path);
      if (currentRunMatch && request.method === "GET") {
        route = "chatCurrentRunEvents";
        const after = streamAfter(request, query);
        const device = await authenticate(request, dependencies.devices, "runs:observe");
        deviceIdSuffix = device.id.slice(-8);
        requirePhoneRunGrant(device, "chat:read");
        if (!dependencies.hostRuns || !dependencies.chats) throw hostRunsUnavailable();
        if (after !== 0) {
          // A cursor names a run; resume it through /runs/{runId}/events.
          throw new AidenRemoteServiceError(
            "invalid_request",
            "Resume a run through its run ID.",
            400,
          );
        }
        await requireChatAccess(dependencies.chats, device, currentRunMatch[1]!, "read", "stream");
        const runId = dependencies.hostRuns.currentRunId(currentRunMatch[1]!);
        dependencies.hostRuns.openRunEvents(device, runId, 0, response, admitDevice(device.id));
        return;
      }
      const runEventsMatch = /^\/runs\/([A-Za-z0-9._:-]{1,128})\/events$/u.exec(path);
      if (runEventsMatch && request.method === "GET") {
        route = "runEvents";
        const after = streamAfter(request, query);
        const device = await authenticate(request, dependencies.devices, "runs:observe");
        deviceIdSuffix = device.id.slice(-8);
        requirePhoneRunGrant(device, "chat:read");
        if (!dependencies.hostRuns || !dependencies.chats) throw hostRunsUnavailable();
        const chatId = dependencies.hostRuns.chatIdForRun(runEventsMatch[1]!);
        await requireChatAccess(dependencies.chats, device, chatId, "read", "stream");
        dependencies.hostRuns.openRunEvents(device, runEventsMatch[1]!, after, response, admitDevice(device.id));
        return;
      }
      const runControlMatch =
        /^\/runs\/([A-Za-z0-9._:-]{1,128})\/(cancel|inputs|approvals\/([A-Za-z0-9._:-]{1,128})\/respond|questions\/([A-Za-z0-9._:-]{1,128})\/respond)$/u
          .exec(path);
      if (runControlMatch && request.method === "POST") {
        requireNoQuery(query);
        const runId = runControlMatch[1]!;
        const action = runControlMatch[2]!;
        route = action === "cancel"
          ? "runCancel"
          : action === "inputs"
            ? "runInputs"
            : runControlMatch[3] !== undefined
              ? "runApprovalRespond"
              : "runQuestionRespond";
        const body = await readJsonBody(request);
        const device = await authenticate(request, dependencies.devices, "runs:control");
        deviceIdSuffix = device.id.slice(-8);
        requirePhoneRunGrant(
          device,
          route === "runApprovalRespond"
            ? "approval:respond"
            : route === "runQuestionRespond"
              ? "questions:respond"
              : "chat:write",
        );
        const key = requiredHeader(request, "idempotency-key", /^[\x21-\x7e]{16,128}$/u);
        const hostRuns = dependencies.hostRuns;
        const chats = dependencies.chats;
        if (!hostRuns || !chats) throw hostRunsUnavailable();
        // Chat-level write access is still required, so a Bot chat's run
        // needs bot:write and the device's own Bot audience.
        const access = (resource: BotChatResource) =>
          async <T>(chatId: string, effect: () => Promise<T>): Promise<T> => {
            await requireChatAccess(chats, device, chatId, "write", resource);
            return effect();
          };
        if (route === "runCancel") {
          requireEmptyObject(body);
          writeJson(response, 202, await hostRuns.cancel(device.id, runId, key, access("stream")));
        } else if (route === "runInputs") {
          writeJson(
            response,
            200,
            await hostRuns.submitInput(device.id, runId, body, key, (chatId, effect) =>
              runChatMutation(chats, device, chatId, "stream", effect)),
          );
        } else if (route === "runApprovalRespond") {
          writeJson(
            response,
            200,
            await hostRuns.respondApproval(
              device.id,
              runId,
              runControlMatch[3]!,
              body,
              key,
              access("approval"),
              { phoneScoped: !isDesktopDevice(device), capabilities: device.capabilities },
            ),
          );
        } else {
          writeJson(
            response,
            200,
            await hostRuns.respondQuestion(
              device.id,
              runId,
              runControlMatch[4]!,
              body,
              key,
              access("question"),
            ),
          );
        }
        return;
      }
      if (path === "/simulators" || path.startsWith("/simulators/")) {
        const relay = dependencies.simulators;
        route = path.startsWith(`${AIDEN_REMOTE_SIMULATOR_HUB_PREFIX}/`)
          ? "simulatorHub"
          : "simulators";
        const device = await authenticate(request, dependencies.devices, "simulators:control");
        deviceIdSuffix = device.id.slice(-8);
        if (!relay) throw simulatorsUnavailable();
        await relay.handle({
          request,
          response,
          path,
          query,
          deviceId: device.id,
          readJson: (maximumBytes) => readJsonBody(request, maximumBytes),
          writeJson: (status, value) => writeJson(response, status, value),
        });
        return;
      }
      throw new AidenRemoteServiceError(
        "not_found",
        "This Aiden Remote endpoint does not exist.",
        404,
      );
    })()
      .finally(() => releaseDeviceAuthorization?.())
      .then(() => {
        logRequest(response.statusCode);
      })
      .catch((error: unknown) => {
        const safe = asAidenRemoteServiceError(error);
        if (!response.headersSent) writeError(response, id, safe);
        else response.destroy();
        logRequest(safe.status, { errorCode: safe.code });
      });
  };
}

/**
 * WebSocket upgrades are accepted only for the simulator hub relay. The
 * same Origin, URL, protocol-version, credential and capability checks as
 * HTTP apply; refusals are a bare status line.
 */
export function createAidenRemoteUpgradeHandler(
  dependencies: Pick<
    AidenRemoteRouterDependencies,
    "devices" | "simulators" | "acceptStrippedBasePath" | "log" | "now"
  >,
): (request: IncomingMessage, socket: Duplex, head: Buffer) => void {
  return (request, socket, head) => {
    const id = requestId();
    const startedAt = dependencies.now();
    let deviceIdSuffix: string | undefined;
    socket.on("error", () => socket.destroy());
    void (async () => {
      if (request.headers.origin !== undefined) {
        throw new AidenRemoteServiceError(
          "invalid_request",
          "Browser-origin requests are not accepted by Aiden Remote.",
          403,
        );
      }
      const { path, query } = requestTarget(request, dependencies.acceptStrippedBasePath === true);
      if (request.method !== "GET" || !path.startsWith(`${AIDEN_REMOTE_SIMULATOR_HUB_PREFIX}/`)) {
        throw new AidenRemoteServiceError("not_found", "This Aiden Remote endpoint does not exist.", 404);
      }
      const device = await authenticateCredential(request, dependencies.devices, "simulators:control");
      deviceIdSuffix = device.id.slice(-8);
      // Cross the revocation fence; a long-lived socket must not delay revocation,
      // which closes it through `revokeDevice` instead.
      dependencies.devices.acquireDeviceAuthorization(device.id, false)();
      const relay = dependencies.simulators;
      if (!relay?.host()) throw simulatorsUnavailable();
      relay.upgrade({ request, socket, head, path, query, deviceId: device.id });
    })()
      .then(() => {
        dependencies.log({
          requestId: id,
          route: "simulatorHub",
          method: request.method,
          status: 101,
          latencyMs: Math.max(0, dependencies.now() - startedAt),
          ...(deviceIdSuffix ? { deviceIdSuffix } : {}),
        });
      })
      .catch((error: unknown) => {
        const safe = asAidenRemoteServiceError(error);
        refuseUpgrade(socket, safe.status, safe.status === 404 ? "Not Found" : "Refused");
        dependencies.log({
          requestId: id,
          route: "simulatorHub",
          method: request.method,
          status: safe.status,
          latencyMs: Math.max(0, dependencies.now() - startedAt),
          ...(deviceIdSuffix ? { deviceIdSuffix } : {}),
          errorCode: safe.code,
        });
      });
  };
}
