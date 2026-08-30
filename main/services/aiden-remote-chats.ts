import { createHash, randomUUID } from "node:crypto";
import { persistedChatWorkspaceId } from "../../renderer/shared/chat-workspace.js";
import { isGenerationThinkingLevel } from "../../renderer/shared/generation-thinking.js";
import {
  parseGenerationTimeline,
  type GenerationTimeline,
} from "../../renderer/shared/generation-timeline.js";
import { parseProviderFailureV1 } from "../../renderer/shared/provider-failure.js";
import {
  appendChatMessageWithReconciliation,
  isAppendReconciliationRequiredError,
} from "./chat-append-commit.js";
import type { createChatApplicationService } from "./chat-application-service.js";
import type { ChatGenerationOwner } from "./chat-generation-owner.js";
import { AidenRemoteServiceError } from "./aiden-remote-errors.js";
import {
  AidenIdempotencyLedger,
  type AidenIdempotencySnapshot,
  AidenOperationContractError,
  AidenOperationUnknownOutcomeError,
  assertRevision,
} from "./aiden-remote-operation-contract.js";
import type { AidenRemoteModelService } from "./aiden-remote-models.js";
import type { AidenRemoteStreamService } from "./aiden-remote-streams.js";
import {
  AidenRemoteAttachmentStore,
  MAX_AIDEN_REMOTE_ATTACHMENTS_PER_TURN,
  type AidenRemoteAttachmentProjection,
} from "./aiden-remote-attachments.js";
import {
  attachmentRepresentationBytes,
  safeStoredAttachments,
} from "./attachment-contract.js";
import {
  imageBytesMatchMime,
  MAX_IMAGE_BYTES,
} from "./attachments.js";
import type { Chat, ChatMessage, ChatStartParams } from "./types.js";
import type { BotStore } from "./bot-store-core.js";
import type { BotMutationGate } from "./bot-mutation-gate.js";
import {
  AIDEN_REMOTE_MAX_CHAT_MESSAGES,
  AIDEN_REMOTE_MAX_JSON_RESPONSE_BYTES,
  parseAidenRemoteChatProjection,
} from "./aiden-remote-protocol.js";

const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/u;
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{16,128}$/u;
type ChatApplicationService = ReturnType<typeof createChatApplicationService>;

function remoteImageHasCompleteTrailer(bytes: Uint8Array, mimeType: "image/png" | "image/jpeg"): boolean {
  if (mimeType === "image/jpeg") {
    return bytes.length >= 2 && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9;
  }
  const iend = [0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130];
  return bytes.length >= iend.length && iend.every((value, index) => bytes[bytes.length - iend.length + index] === value);
}

export interface AidenRemoteMessageProjection {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
  attachments?: AidenRemoteMessageAttachmentProjection[];
  htmlArtifacts?: AidenRemoteHtmlArtifactProjection[];
  outcome?: AidenRemoteMessageOutcomeProjection;
  timeline?: GenerationTimeline;
}

export interface AidenRemoteHtmlArtifactProjection {
  id: string;
  title: string;
}

export interface AidenRemoteMessageAttachmentProjection {
  id: string;
  name: string;
  mimeType: string;
  kind: "image" | "text";
  size: number;
}

export interface AidenRemoteMessageOutcomeProjection {
  status: "failed" | "cancelled";
  category?: string;
  attempts?: number;
  retryExhausted?: boolean;
}

export interface AidenRemoteAttachmentContent {
  bytes: Buffer;
  mimeType: string;
}

export interface AidenRemoteChatProjection {
  id: string;
  workspaceId: string;
  botId?: string;
  title: string;
  providerId?: string;
  modelId?: string;
  messages: AidenRemoteMessageProjection[];
  createdAt: string;
  updatedAt: string;
  revision: string;
  titlePending?: true;
}

export interface AidenRemoteChatClassification {
  botId?: string;
  botArchived?: true;
}

export interface AidenRemoteRetainedBotChatAuthorizationRequest {
  deviceId: string;
  chatId: string;
  botId: string;
  access: "read" | "write";
}

export type AidenRemoteRetainedBotChatAuthorizer = (
  request: Readonly<AidenRemoteRetainedBotChatAuthorizationRequest>,
) => boolean | Promise<boolean>;

export interface AidenRemoteBotTurnAuthorityPreflightRequest {
  audienceId: string;
  botId: string;
  chatId: string;
  providerId: string;
  model: string;
}

export type AidenRemoteBotTurnAuthorityPreflight = (
  request: Readonly<AidenRemoteBotTurnAuthorityPreflightRequest>,
) => Promise<{ supportsCompanionImages: boolean } | void>;

function ownRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function exactKeys(record: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.prototype.hasOwnProperty.call(record, key))
    && Object.keys(record).every((key) => allowed.has(key));
}

function boundedString(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && Array.from(value).length <= maximum;
}

/** Return at most `maximum` Unicode scalars without splitting a surrogate pair. */
function boundedUnicodeScalarPrefix(value: string, maximum: number): string {
  let end = 0;
  let scalars = 0;
  while (end < value.length && scalars < maximum) {
    const leading = value.charCodeAt(end);
    const trailing = value.charCodeAt(end + 1);
    end +=
      leading >= 0xd800 &&
      leading <= 0xdbff &&
      trailing >= 0xdc00 &&
      trailing <= 0xdfff
        ? 2
        : 1;
    scalars += 1;
  }
  return value.slice(0, end);
}

function safeId(value: string, label: string): string {
  if (!SAFE_ID.test(value)) {
    throw new AidenRemoteServiceError("invalid_request", `The ${label} identifier is invalid.`, 400);
  }
  return value;
}

function safeAttachmentDisplayName(value: string): string {
  const segments = value.replace(/\\/gu, "/").split("/");
  const leaf = segments[segments.length - 1] ?? "";
  const cleaned = Array.from(leaf)
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code > 0x1f && code !== 0x7f;
    })
    .slice(0, 255)
    .join("")
    .trim();
  return cleaned || "Attachment";
}

function projectedAttachmentId(value: string): string {
  return /^[A-Za-z0-9._:-]{1,256}$/u.test(value)
    ? value
    : `legacy_${createHash("sha256").update(value).digest("base64url")}`;
}

function projectMessageAttachments(value: unknown): AidenRemoteMessageAttachmentProjection[] {
  return (safeStoredAttachments(value) ?? []).map((attachment) => ({
    id: projectedAttachmentId(attachment.id),
    name: safeAttachmentDisplayName(attachment.name),
    mimeType: /^[\x21-\x7e]{1,120}$/u.test(attachment.mimeType)
      ? attachment.mimeType
      : attachment.kind === "image" ? "image/unknown" : "text/plain",
    kind: attachment.kind,
    size: attachment.size,
  }));
}

function projectMessageOutcome(message: ChatMessage): AidenRemoteMessageOutcomeProjection | undefined {
  const failure = parseProviderFailureV1(message.providerFailure);
  if (failure) {
    return {
      status: "failed",
      category: failure.category,
      attempts: failure.attempts,
      retryExhausted: failure.retryExhausted,
    };
  }
  const timeline = parseGenerationTimeline(message.timeline, message.content.length);
  if (timeline?.status === "failed" || timeline?.status === "cancelled") {
    return { status: timeline.status };
  }
  return undefined;
}

function projectMessageTimeline(message: ChatMessage): GenerationTimeline | undefined {
  if (message.role !== "assistant") return undefined;
  return parseGenerationTimeline(message.timeline, message.content.length);
}

function chatRevision(chat: Chat): string {
  const hasModelSelection = Boolean(chat.providerId && chat.model);
  const visible = {
    id: chat.id,
    workspaceId: persistedChatWorkspaceId(chat.workspaceId),
    ...(chat.botId ? { botId: chat.botId } : {}),
    title: chat.title,
    providerId: hasModelSelection ? chat.providerId : null,
    model: hasModelSelection ? chat.model : null,
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt,
    messages: chat.messages
      .filter((message) => message.role === "user" || message.role === "assistant")
      .map((message) => ({
        id: message.id,
        role: message.role,
        content: message.content,
        createdAt: message.createdAt,
        attachments: projectMessageAttachments(message.attachments),
        htmlArtifacts: (message.htmlArtifacts ?? []).map((artifact) => ({
          id: artifact.mediaId,
          title: artifact.title,
        })),
        outcome: projectMessageOutcome(message) ?? null,
        timeline: projectMessageTimeline(message) ?? null,
      })),
  };
  return `rev_${createHash("sha256").update(JSON.stringify(visible)).digest("base64url")}`;
}

export function projectAidenRemoteChat(
  chat: Chat,
  options: { titlePending?: boolean } = {},
): AidenRemoteChatProjection {
  try {
    const visibleMessages = chat.messages.filter(
      (message): message is ChatMessage & { role: "user" | "assistant" } =>
        message.role === "user" || message.role === "assistant",
    );
    if (visibleMessages.length > AIDEN_REMOTE_MAX_CHAT_MESSAGES) {
      throw new AidenRemoteServiceError(
        "payload_too_large",
        "This chat exceeds the Aiden Remote message limit.",
        413,
      );
    }
    const projection: AidenRemoteChatProjection = {
      id: chat.id,
      workspaceId: persistedChatWorkspaceId(chat.workspaceId),
      ...(chat.botId ? { botId: chat.botId } : {}),
      title: boundedUnicodeScalarPrefix(chat.title, 1_024),
      ...(chat.providerId && chat.model
        ? { providerId: chat.providerId, modelId: chat.model }
        : {}),
      messages: visibleMessages.map((message) => {
        const attachments = projectMessageAttachments(message.attachments);
        const outcome = projectMessageOutcome(message);
        const text = boundedUnicodeScalarPrefix(message.content, 200_000);
        const storedTimeline = projectMessageTimeline(message);
        // A stored timeline can be valid for the full assistant message while
        // pointing beyond the prefix exposed to Remote. Omit it as a unit in
        // that case instead of clamping or fabricating offsets.
        const timeline = storedTimeline
          ? parseGenerationTimeline(storedTimeline, text.length) ?? undefined
          : undefined;
        return {
          id: message.id,
          role: message.role,
          text,
          createdAt: new Date(message.createdAt).toISOString(),
          ...(attachments.length > 0 ? { attachments } : {}),
          ...(message.htmlArtifacts && message.htmlArtifacts.length > 0
            ? {
                htmlArtifacts: message.htmlArtifacts.map((artifact) => ({
                  id: artifact.mediaId,
                  title: artifact.title,
                })),
              }
            : {}),
          ...(outcome ? { outcome } : {}),
          ...(timeline ? { timeline } : {}),
        };
      }),
      createdAt: new Date(chat.createdAt).toISOString(),
      updatedAt: new Date(chat.updatedAt).toISOString(),
      revision: chatRevision(chat),
      ...(options.titlePending === true ? { titlePending: true as const } : {}),
    };
    const serialized = JSON.stringify(projection);
    if (Buffer.byteLength(serialized, "utf8") > AIDEN_REMOTE_MAX_JSON_RESPONSE_BYTES) {
      throw new AidenRemoteServiceError(
        "payload_too_large",
        "This response exceeds the Aiden Remote JSON limit.",
        413,
      );
    }
    // aiden-remote-protocol.ts refers back to this projection with an erased
    // `import type`; keep this as the only runtime dependency direction.
    parseAidenRemoteChatProjection(projection, "Aiden Remote Chat projection");
    return projection;
  } catch (error) {
    if (error instanceof AidenRemoteServiceError) throw error;
    throw new AidenRemoteServiceError(
      "internal_error",
      "Aiden could not safely project this chat.",
      500,
    );
  }
}

function parseCreate(input: unknown): { workspaceId: string; providerId?: string; model?: string } {
  const record = ownRecord(input);
  if (
    !record ||
    !exactKeys(record, ["workspaceId"], ["providerId", "modelId"]) ||
    !boundedString(record.workspaceId, 128) ||
    (record.providerId !== undefined && !boundedString(record.providerId, 256)) ||
    (record.modelId !== undefined && !boundedString(record.modelId, 256))
  ) {
    throw new AidenRemoteServiceError("invalid_request", "The chat creation request is invalid.", 400);
  }
  return {
    workspaceId: safeId(record.workspaceId, "workspace"),
    ...(typeof record.providerId === "string" ? { providerId: record.providerId } : {}),
    ...(typeof record.modelId === "string" ? { model: record.modelId } : {}),
  };
}

function parseTitle(input: unknown): string {
  const record = ownRecord(input);
  if (!record || !exactKeys(record, ["title"]) || !boundedString(record.title, 200)) {
    throw new AidenRemoteServiceError("invalid_request", "The chat title is invalid.", 400);
  }
  const title = record.title.trim();
  if (!title) {
    throw new AidenRemoteServiceError("invalid_request", "The chat title is invalid.", 400);
  }
  return title;
}

function parseMove(input: unknown): { workspaceId: string; confirmedForeground: true } {
  const record = ownRecord(input);
  if (
    !record ||
    !exactKeys(record, ["workspaceId", "confirmedForeground"]) ||
    !boundedString(record.workspaceId, 128) ||
    record.confirmedForeground !== true
  ) {
    throw new AidenRemoteServiceError("invalid_request", "The chat move request is invalid.", 400);
  }
  return { workspaceId: safeId(record.workspaceId, "workspace"), confirmedForeground: true };
}

function parseTurn(input: unknown): {
  text: string;
  providerId?: string;
  modelId?: string;
  thinkingLevel?: ChatStartParams["thinkingLevel"];
  attachmentIds?: string[];
} {
  const record = ownRecord(input);
  const attachmentIds = record?.attachmentIds;
  const structurallyValidAttachmentIds =
    attachmentIds === undefined ||
    (Array.isArray(attachmentIds) &&
      attachmentIds.length > 0 &&
      attachmentIds.length <= MAX_AIDEN_REMOTE_ATTACHMENTS_PER_TURN &&
      attachmentIds.every((value) => typeof value === "string"));
  if (
    !record ||
    !exactKeys(record, ["text"], ["providerId", "modelId", "thinkingLevel", "attachmentIds"]) ||
    typeof record.text !== "string" ||
    Array.from(record.text).length > 200_000 ||
    (!record.text.trim() && (!Array.isArray(attachmentIds) || attachmentIds.length === 0)) ||
    (record.providerId !== undefined && !boundedString(record.providerId, 256)) ||
    (record.modelId !== undefined && !boundedString(record.modelId, 256)) ||
    (record.thinkingLevel !== undefined && !isGenerationThinkingLevel(record.thinkingLevel)) ||
    !structurallyValidAttachmentIds
  ) {
    throw new AidenRemoteServiceError(
      "invalid_request",
      "The turn must contain bounded text or valid attachment references.",
      400,
    );
  }
  return {
    text: record.text,
    ...(typeof record.providerId === "string" ? { providerId: record.providerId } : {}),
    ...(typeof record.modelId === "string" ? { modelId: record.modelId } : {}),
    ...(isGenerationThinkingLevel(record.thinkingLevel)
      ? { thinkingLevel: record.thinkingLevel }
      : {}),
    ...(Array.isArray(attachmentIds) ? { attachmentIds: [...attachmentIds] as string[] } : {}),
  };
}

function ephemeralOwner(deviceId: string, operationId: string): ChatGenerationOwner {
  let destroyed = false;
  const listeners = new Set<() => void>();
  return {
    id: 0,
    documentId: `remote-chat:${createHash("sha256").update(`${deviceId}:${operationId}`).digest("base64url")}`,
    isDestroyed: () => destroyed,
    send: () => undefined,
    onInvalidated: (listener) => {
      if (destroyed) listener();
      else listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function requireRevision(expected: string, chat: Chat): void {
  try {
    assertRevision(expected, chatRevision(chat));
  } catch {
    throw new AidenRemoteServiceError(
      "revision_conflict",
      "The chat changed. Refresh it before trying again.",
      409,
      false,
      { currentRevision: chatRevision(chat) },
    );
  }
}

export class AidenRemoteChatService {
  private readonly idempotency: AidenIdempotencyLedger;
  private readonly attachments: AidenRemoteAttachmentStore;

  constructor(
    private readonly options: {
      application: Pick<ChatApplicationService, "list" | "listRegular" | "get" | "create" | "rename" | "moveEmptyToWorkspace" | "remove">;
      chatStore: {
        get(id: string): Promise<Chat | null>;
        appendMessage(
          id: string,
          message: Omit<ChatMessage, "id" | "createdAt"> & { id?: string; createdAt?: number },
          meta?: {
            providerId?: string;
            model?: string;
            expectedWorkspaceId?: string;
            isCurrent?: () => boolean;
          },
        ): Promise<Chat>;
      };
      generation: {
        beginChatTurn(chatId: string, turnId: string, ownerId: string): {
          isActive(): boolean;
          reserveAppendPayload(bytes: number): void;
          settleAsyncWork(): void;
          onReleased(cleanup: () => void): void;
          release(): void;
        } | null;
        start(
          streamId: string,
          params: ChatStartParams,
          owner: ChatGenerationOwner,
          options: {
            allowSubagents: boolean;
            allowComputerUse: false;
            usageSource: "chat";
            turnId: string;
            botAudienceId?: string;
            onTurnAccepted(): void;
          },
        ): Promise<boolean>;
      };
      streams: AidenRemoteStreamService;
      models: Pick<AidenRemoteModelService, "resolve">;
      bots: Pick<BotStore, "get">;
      botMutations: Pick<BotMutationGate, "run">;
      /**
       * Phase 2 supplies the main-owned versioned notice and Full/Custom
       * policy authority. Until then, omission deliberately denies every
       * retained Bot-chat read and write even when device grants are present.
       */
      retainedBotChatAuthorizer?: AidenRemoteRetainedBotChatAuthorizer;
      botTurnAuthorityPreflight?: AidenRemoteBotTurnAuthorityPreflight;
      attachments?: AidenRemoteAttachmentStore;
      idempotency?: AidenIdempotencyLedger;
      persistIdempotency?: (snapshot: AidenIdempotencySnapshot) => Promise<void>;
      notifyChanged?: (chatId?: string) => void;
      isTitlePending?: (chatId: string) => boolean;
    },
  ) {
    this.idempotency = options.idempotency ?? new AidenIdempotencyLedger();
    this.attachments = options.attachments ?? new AidenRemoteAttachmentStore();
  }

  private async executeIdempotent<T>(
    scope: { deviceId: string; route: string; resourceId: string; key: string },
    input: unknown,
    action: () => Promise<T>,
  ): Promise<T> {
    if (!IDEMPOTENCY_KEY.test(scope.key)) {
      throw new AidenRemoteServiceError("invalid_request", "Idempotency-Key is invalid.", 400);
    }
    if (!this.options.persistIdempotency) return this.idempotency.execute(scope, input, action);
    let admit!: () => void;
    let reject!: (error: unknown) => void;
    const durable = new Promise<void>((resolve, rejectPromise) => {
      admit = resolve;
      reject = rejectPromise;
    });
    const pending = this.idempotency.execute(scope, input, async () => {
      await durable;
      return action();
    });
    try {
      await this.options.persistIdempotency(this.idempotency.snapshot());
      admit();
    } catch (error) {
      reject(error);
      await pending.catch(() => undefined);
      throw new AidenRemoteServiceError("internal_error", "Aiden could not prepare this chat request.", 500);
    }
    let result: T | undefined;
    let failure: unknown;
    try {
      result = await pending;
    } catch (error) {
      failure = error;
    }
    try {
      await this.options.persistIdempotency(this.idempotency.snapshot());
    } catch {
      throw new AidenRemoteServiceError(
        "idempotency_in_flight",
        "The chat request may have completed, but its outcome could not be recorded.",
        409,
      );
    }
    if (failure) throw failure;
    return result!;
  }

  private async chat(chatId: string): Promise<Chat> {
    const result = await this.options.application.get(safeId(chatId, "chat"));
    if (!result.chat || result.chat.id !== chatId) {
      throw new AidenRemoteServiceError("not_found", "This Aiden chat no longer exists.", 404);
    }
    if (result.reconciliation) {
      throw new AidenRemoteServiceError("operation_in_progress", "This chat is still reconciling.", 409, true);
    }
    if (result.imageArtifactRecoveryUnavailable) {
      throw new AidenRemoteServiceError(
        "operation_in_progress",
        "This chat is waiting for image-artifact storage repair on the desktop.",
        409,
        true,
      );
    }
    if (result.imageArtifactRecoveryPending) {
      throw new AidenRemoteServiceError(
        "operation_in_progress",
        "This chat is still recovering an interrupted image response.",
        409,
        true,
      );
    }
    return result.chat;
  }

  private project(chat: Chat): AidenRemoteChatProjection {
    return projectAidenRemoteChat(chat, {
      titlePending: this.options.isTitlePending?.(chat.id) === true,
    });
  }

  async list(workspaceId?: string): Promise<{ chats: AidenRemoteChatProjection[] }> {
    if (workspaceId) safeId(workspaceId, "workspace");
    const metadata = await this.options.application.listRegular(workspaceId);
    const chats = await Promise.all(metadata.map((entry) => this.chat(entry.id)));
    return { chats: chats.map((chat) => this.project(chat)) };
  }

  /**
   * Resolve only immutable chat classification from the main-owned metadata
   * index. Authorization callers use this before any payload read that could
   * wait on renderer ownership or expose reconciliation state.
   */
  async classify(chatId: string): Promise<AidenRemoteChatClassification> {
    const id = safeId(chatId, "chat");
    const metadata = (await this.options.application.list()).find((entry) => entry.id === id);
    if (!metadata) {
      throw new AidenRemoteServiceError("not_found", "This Aiden chat no longer exists.", 404);
    }
    if (!metadata.botId) return {};
    const bot = await this.options.bots.get(metadata.botId);
    if (!bot || bot.id !== metadata.botId) {
      throw new AidenRemoteServiceError("not_found", "This Aiden chat no longer exists.", 404);
    }
    return {
      botId: metadata.botId,
      ...(bot.archivedAt !== undefined ? { botArchived: true as const } : {}),
    };
  }

  /**
   * Consult the main-owned Bot policy authority without exposing policy
   * details to the transport. Missing, throwing, or non-true authority is a
   * denial; ordinary chats never call this seam.
   */
  async authorizeRetainedBotChat(
    request: AidenRemoteRetainedBotChatAuthorizationRequest,
  ): Promise<boolean> {
    const authorizer = this.options.retainedBotChatAuthorizer;
    if (!authorizer) return false;
    try {
      return (await authorizer({ ...request })) === true;
    } catch {
      return false;
    }
  }

  /**
   * Serialize a Bot-chat mutation with Bot lifecycle changes, then re-resolve
   * both chat ownership and archive state inside that shared gate. The initial
   * classification is supplied by the router only after capability and policy
   * preflight; policy is then checked again immediately before the effect.
   */
  async runMutation<T>(
    deviceId: string,
    chatId: string,
    expected: AidenRemoteChatClassification,
    action: () => Promise<T>,
  ): Promise<T> {
    const run = async () => {
      const current = await this.classify(chatId);
      if (current.botId !== expected.botId) {
        throw new AidenRemoteServiceError("not_found", "This Aiden chat no longer exists.", 404);
      }
      if (
        current.botId &&
        !(await this.authorizeRetainedBotChat({
          deviceId,
          chatId,
          botId: current.botId,
          access: "write",
        }))
      ) {
        throw new AidenRemoteServiceError("not_found", "This Aiden chat no longer exists.", 404);
      }
      if (current.botArchived) {
        throw new AidenRemoteServiceError(
          "bot_archived",
          "Restore this bot before making changes.",
          409,
        );
      }
      return action();
    };
    return expected.botId
      ? this.options.botMutations.run(expected.botId, run)
      : run();
  }

  async get(chatId: string): Promise<AidenRemoteChatProjection> {
    return this.project(await this.chat(chatId));
  }

  async uploadAttachment(
    deviceId: string,
    chatId: string,
    input: unknown,
  ): Promise<AidenRemoteAttachmentProjection> {
    await this.chat(chatId);
    return this.attachments.upload(deviceId, safeId(chatId, "chat"), input);
  }

  async removeAttachment(deviceId: string, chatId: string, attachmentId: string): Promise<void> {
    await this.chat(chatId);
    this.attachments.remove(deviceId, safeId(chatId, "chat"), attachmentId);
  }

  async attachmentContent(
    chatId: string,
    attachmentId: string,
  ): Promise<AidenRemoteAttachmentContent> {
    safeId(chatId, "chat");
    if (!/^[A-Za-z0-9._:-]{1,256}$/u.test(attachmentId)) {
      throw new AidenRemoteServiceError("invalid_request", "The attachment identifier is invalid.", 400);
    }
    const authoritative = await this.chat(chatId);
    const matches = authoritative.messages.flatMap((message) =>
      message.role === "user" || message.role === "assistant"
        ? (safeStoredAttachments(message.attachments) ?? []).filter(
            (attachment) => projectedAttachmentId(attachment.id) === attachmentId,
          )
        : [],
    );
    if (matches.length !== 1) {
      throw new AidenRemoteServiceError("not_found", "This attachment is unavailable.", 404);
    }
    const attachment = matches[0]!;
    if (attachment.kind === "image") {
      if (
        (attachment.mimeType !== "image/png" && attachment.mimeType !== "image/jpeg") ||
        typeof attachment.data !== "string"
      ) {
        throw new AidenRemoteServiceError("not_found", "This image is unavailable.", 404);
      }
      const bytes = Buffer.from(attachment.data, "base64");
      if (
        bytes.length === 0 ||
        bytes.length > MAX_IMAGE_BYTES ||
        bytes.length !== attachment.size ||
        !imageBytesMatchMime(bytes, attachment.mimeType) ||
        !remoteImageHasCompleteTrailer(bytes, attachment.mimeType)
      ) {
        throw new AidenRemoteServiceError("not_found", "This image is unavailable.", 404);
      }
      return { bytes, mimeType: attachment.mimeType };
    }
    throw new AidenRemoteServiceError("not_found", "This image is unavailable.", 404);
  }

  revokeDevice(deviceId: string): void {
    this.attachments.revokeDevice(deviceId);
  }

  async create(deviceId: string, key: string, input: unknown): Promise<AidenRemoteChatProjection> {
    const parsed = parseCreate(input);
    try {
      return await this.executeIdempotent(
        { deviceId, route: "POST /chats", resourceId: "chat-registry", key },
        parsed,
        async () => {
          const owner = ephemeralOwner(deviceId, key);
          const selection = parsed.providerId || parsed.model
            ? await this.options.models.resolve(parsed.providerId, parsed.model)
            : undefined;
          const created = await this.options.application.create(
            {
              workspaceId: parsed.workspaceId,
              ...(selection
                ? { providerId: selection.providerId, model: selection.modelId }
                : {}),
            },
            owner,
          );
          if (!created) throw new AidenRemoteServiceError("internal_error", "Aiden could not create the chat.", 500);
          this.options.notifyChanged?.(created.id);
          return projectAidenRemoteChat(created);
        },
      );
    } catch (error) {
      return this.mapOperationError(error);
    }
  }

  async rename(chatId: string, revision: string, input: unknown): Promise<AidenRemoteChatProjection> {
    const title = parseTitle(input);
    const updated = await this.options.application.rename(safeId(chatId, "chat"), title, {
      assertCurrent: (chat) => requireRevision(revision, chat),
    });
    this.options.notifyChanged?.(chatId);
    return projectAidenRemoteChat(updated);
  }

  async move(
    deviceId: string,
    chatId: string,
    revision: string,
    key: string,
    input: unknown,
  ): Promise<AidenRemoteChatProjection> {
    const classification = await this.classify(chatId);
    if (classification.botId) {
      // Bot chats are permanently bound to their hidden managed home. The
      // ordinary workspace move route must never be able to rebind them.
      throw new AidenRemoteServiceError("not_found", "This Aiden chat no longer exists.", 404);
    }
    const parsed = parseMove(input);
    try {
      return await this.executeIdempotent(
        { deviceId, route: "POST /chats/{id}/move", resourceId: safeId(chatId, "chat"), key },
        { revision, ...parsed },
        async () => {
          const moved = await this.options.application.moveEmptyToWorkspace(chatId, parsed.workspaceId, {
            assertCurrent: (chat) => requireRevision(revision, chat),
          });
          this.options.notifyChanged?.(chatId);
          return projectAidenRemoteChat(moved!);
        },
      );
    } catch (error) {
      return this.mapOperationError(error);
    }
  }

  async remove(chatId: string, revision: string): Promise<void> {
    const classification = await this.classify(chatId);
    if (classification.botId) {
      // A Bot owns one persistent conversation. It can be retained by
      // archiving the Bot, but the generic chat endpoint must never delete it.
      throw new AidenRemoteServiceError("not_found", "This Aiden chat no longer exists.", 404);
    }
    await this.options.application.remove(safeId(chatId, "chat"), {
      assertCurrent: (chat) => requireRevision(revision, chat),
    });
    this.options.notifyChanged?.(chatId);
  }

  async startTurn(
    deviceId: string,
    chatId: string,
    key: string,
    input: unknown,
  ): Promise<{
    turnId: string;
    streamId: string;
    status: "accepted";
    message: AidenRemoteMessageProjection;
  }> {
    const parsed = parseTurn(input);
    try {
      return await this.executeIdempotent(
        { deviceId, route: "POST /chats/{id}/turns", resourceId: safeId(chatId, "chat"), key },
        parsed,
        async () => {
          const authoritative = await this.chat(chatId);
          const requestedProviderId = parsed.providerId ?? authoritative.providerId;
          const requestedModelId = parsed.modelId ?? authoritative.model;
          const preservesPinnedGemini =
            authoritative.providerId === "google" &&
            requestedProviderId === authoritative.providerId &&
            requestedModelId === authoritative.model;
          const selection = await this.options.models.resolve(
            requestedProviderId,
            requestedModelId,
            { allowExistingPinnedGemini: preservesPinnedGemini },
          );
          if (authoritative.botId && (
            !authoritative.providerId ||
            !authoritative.model ||
            selection.providerId !== authoritative.providerId ||
            selection.modelId !== authoritative.model
          )) {
            throw new AidenRemoteServiceError(
              "invalid_request",
              "This Bot uses its saved AI connection and model. Reload it before sending.",
              400,
            );
          }
          let supportsCompanionImages = false;
          if (authoritative.botId) {
            const preflight = this.options.botTurnAuthorityPreflight;
            if (!preflight) {
              throw new Error("Bot turn authority is unavailable.");
            }
            const preflightResult = await preflight({
              audienceId: deviceId,
              botId: authoritative.botId,
              chatId: authoritative.id,
              providerId: selection.providerId,
              model: selection.modelId,
            });
            supportsCompanionImages = preflightResult?.supportsCompanionImages === true;
          }
          if (
            parsed.thinkingLevel &&
            selection.thinkingLevels.length > 0 &&
            !selection.thinkingLevels.includes(parsed.thinkingLevel)
          ) {
            throw new AidenRemoteServiceError("invalid_request", "That thinking level is unavailable.", 400);
          }
          if (
            this.attachments.requiresImageInput(deviceId, chatId, parsed.attachmentIds) &&
            !selection.supportsImages && !supportsCompanionImages
          ) {
            throw new AidenRemoteServiceError(
              "invalid_request",
              authoritative.botId
                ? "This Bot needs an image model before it can read photos. Open Edit Bot, choose Image Understanding, then try again."
                : "The selected model can’t read images. Choose an image-capable model, then try again.",
              400,
            );
          }
          const turnId = `turn_${randomUUID()}`;
          const streamId = `stream_${randomUUID()}`;
          const owner = this.options.streams.create(deviceId, streamId, chatId, turnId);
          const turn = this.options.generation.beginChatTurn(chatId, turnId, owner.owner.documentId);
          if (!turn) {
            owner.invalidate();
            this.options.streams.markStartError(deviceId, streamId, new Error("This chat already has a response in progress."));
            throw new AidenRemoteServiceError("turn_already_active", "This chat already has a response in progress.", 409);
          }
          const attachments = this.attachments.consume(deviceId, chatId, parsed.attachmentIds);
          turn.onReleased(owner.owner.onInvalidated(turn.release));
          turn.reserveAppendPayload(
            Buffer.byteLength(parsed.text, "utf8") +
              attachmentRepresentationBytes(attachments) +
              1_024,
          );
          const messageId = `message_${randomUUID()}`;
          let appended = false;
          let accepted = false;
          let appendedChat: Chat | undefined;
          try {
            const workspaceId = persistedChatWorkspaceId(authoritative.workspaceId);
            const chat = await appendChatMessageWithReconciliation({
              messageId,
              append: () => this.options.chatStore.appendMessage(
                chatId,
                {
                  id: messageId,
                  role: "user",
                  content: parsed.text,
                  ...(attachments?.length ? { attachments } : {}),
                },
                {
                  providerId: selection.providerId,
                  model: selection.modelId,
                  expectedWorkspaceId: workspaceId,
                  isCurrent: turn.isActive,
                },
              ),
              recover: () => this.options.chatStore.get(chatId),
            });
            appended = true;
            appendedChat = chat;
            turn.settleAsyncWork();
            const started = await this.options.generation.start(
              streamId,
              {
                chatId,
                workspaceId,
                providerId: selection.providerId,
                model: selection.modelId,
                ...(parsed.thinkingLevel ? { thinkingLevel: parsed.thinkingLevel } : {}),
                messages: [],
              },
              owner.owner,
              {
                allowSubagents: true,
                allowComputerUse: false,
                usageSource: "chat",
                turnId,
                ...(authoritative.botId ? { botAudienceId: deviceId } : {}),
                onTurnAccepted: () => {
                  accepted = true;
                  this.options.streams.markRunning(deviceId, streamId);
                },
              },
            );
            if (!started && !accepted) {
              this.options.streams.markStartError(
                deviceId,
                streamId,
                new Error("Generation stopped before it could begin."),
              );
            }
            this.options.notifyChanged?.(chatId);
            const message = chat.messages.find((candidate) => candidate.id === messageId)!;
            return {
              turnId,
              streamId,
              status: "accepted" as const,
              message: projectAidenRemoteChat({ ...chat, messages: [message] }).messages[0]!,
            };
          } catch (error) {
            if (!appended) turn.release();
            turn.settleAsyncWork();
            this.options.streams.markStartError(deviceId, streamId, error);
            if (isAppendReconciliationRequiredError(error)) {
              throw new AidenOperationUnknownOutcomeError();
            }
            if (appended && appendedChat) {
              this.options.notifyChanged?.(chatId);
              const message = appendedChat.messages.find((candidate) => candidate.id === messageId)!;
              return {
                turnId,
                streamId,
                status: "accepted" as const,
                message: projectAidenRemoteChat({ ...appendedChat, messages: [message] }).messages[0]!,
              };
            }
            throw error;
          }
        },
      );
    } catch (error) {
      return this.mapOperationError(error);
    }
  }

  private mapOperationError(error: unknown): never {
    if (error instanceof AidenRemoteServiceError) throw error;
    if (error instanceof AidenOperationContractError) {
      const status = error.code === "idempotency_capacity" ? 429 : 409;
      throw new AidenRemoteServiceError(error.code, "This chat request cannot be safely repeated.", status);
    }
    throw error;
  }
}
