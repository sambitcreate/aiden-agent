import { createHash, randomUUID } from "node:crypto";
import { persistedChatWorkspaceId } from "../../renderer/shared/chat-workspace.js";
import { isGenerationThinkingLevel } from "../../renderer/shared/generation-thinking.js";
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
import type { Chat, ChatMessage, ChatStartParams } from "./types.js";

const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/u;
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{16,128}$/u;
type ChatApplicationService = ReturnType<typeof createChatApplicationService>;

export interface AidenRemoteMessageProjection {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
  attachments?: AidenRemoteMessageAttachmentProjection[];
}

export interface AidenRemoteMessageAttachmentProjection {
  id: string;
  name: string;
  mimeType: string;
  kind: "image" | "text";
  size: number;
}

export interface AidenRemoteChatProjection {
  id: string;
  workspaceId: string;
  title: string;
  providerId?: string;
  modelId?: string;
  messages: AidenRemoteMessageProjection[];
  createdAt: string;
  updatedAt: string;
  revision: string;
}

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

function projectMessageAttachments(value: unknown): AidenRemoteMessageAttachmentProjection[] {
  return (safeStoredAttachments(value) ?? []).map((attachment) => ({
    id: /^[A-Za-z0-9._:-]{1,256}$/u.test(attachment.id)
      ? attachment.id
      : `legacy_${createHash("sha256").update(attachment.id).digest("base64url")}`,
    name: safeAttachmentDisplayName(attachment.name),
    mimeType: /^[\x21-\x7e]{1,120}$/u.test(attachment.mimeType)
      ? attachment.mimeType
      : attachment.kind === "image" ? "image/unknown" : "text/plain",
    kind: attachment.kind,
    size: attachment.size,
  }));
}

function chatRevision(chat: Chat): string {
  const visible = {
    id: chat.id,
    workspaceId: persistedChatWorkspaceId(chat.workspaceId),
    title: chat.title,
    providerId: chat.providerId ?? null,
    model: chat.model ?? null,
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
      })),
  };
  return `rev_${createHash("sha256").update(JSON.stringify(visible)).digest("base64url")}`;
}

export function projectAidenRemoteChat(chat: Chat): AidenRemoteChatProjection {
  return {
    id: chat.id,
    workspaceId: persistedChatWorkspaceId(chat.workspaceId),
    title: chat.title.slice(0, 1_024),
    ...(chat.providerId ? { providerId: chat.providerId } : {}),
    ...(chat.model ? { modelId: chat.model } : {}),
    messages: chat.messages.flatMap((message) => {
      if (message.role !== "user" && message.role !== "assistant") return [];
      const attachments = projectMessageAttachments(message.attachments);
      return [{
        id: message.id,
        role: message.role,
        text: message.content.slice(0, 200_000),
        createdAt: new Date(message.createdAt).toISOString(),
        ...(attachments.length > 0 ? { attachments } : {}),
      }];
    }),
    createdAt: new Date(chat.createdAt).toISOString(),
    updatedAt: new Date(chat.updatedAt).toISOString(),
    revision: chatRevision(chat),
  };
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
      application: Pick<ChatApplicationService, "list" | "get" | "create" | "rename" | "moveEmptyToWorkspace" | "remove">;
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
            onTurnAccepted(): void;
          },
        ): Promise<boolean>;
      };
      streams: AidenRemoteStreamService;
      models: Pick<AidenRemoteModelService, "resolve">;
      attachments?: AidenRemoteAttachmentStore;
      idempotency?: AidenIdempotencyLedger;
      persistIdempotency?: (snapshot: AidenIdempotencySnapshot) => Promise<void>;
      notifyChanged?: (chatId?: string) => void;
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
    if (!result.chat) {
      throw new AidenRemoteServiceError("not_found", "This Aiden chat no longer exists.", 404);
    }
    if (result.reconciliation) {
      throw new AidenRemoteServiceError("operation_in_progress", "This chat is still reconciling.", 409, true);
    }
    return result.chat;
  }

  async list(workspaceId?: string): Promise<{ chats: AidenRemoteChatProjection[] }> {
    if (workspaceId) safeId(workspaceId, "workspace");
    const metadata = await this.options.application.list(workspaceId);
    const chats = await Promise.all(metadata.map((entry) => this.chat(entry.id)));
    return { chats: chats.map(projectAidenRemoteChat) };
  }

  async get(chatId: string): Promise<AidenRemoteChatProjection> {
    return projectAidenRemoteChat(await this.chat(chatId));
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
          const selection = await this.options.models.resolve(
            parsed.providerId ?? authoritative.providerId,
            parsed.modelId ?? authoritative.model,
          );
          if (
            parsed.thinkingLevel &&
            selection.thinkingLevels.length > 0 &&
            !selection.thinkingLevels.includes(parsed.thinkingLevel)
          ) {
            throw new AidenRemoteServiceError("invalid_request", "That thinking level is unavailable.", 400);
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
