import { ASSISTANT_WORKSPACE_ID } from "../../renderer/shared/assistant.js";
import { persistedChatWorkspaceId } from "../../renderer/shared/chat-workspace.js";
import { AidenRemoteServiceError } from "./aiden-remote-errors.js";
import type { ChatProgressEvents } from "./chat-progress-events.js";
import type { AidenRemoteCapability } from "./aiden-remote-protocol.js";
import type { Chat, ChatMeta } from "./types.js";

export interface ChatProgressAuthorizeDevice {
  id: string;
  revokedAt?: number;
  capabilities: readonly string[];
  acceptsProgressCapabilities?: boolean;
}

export interface ChatProgressAuthorizePorts {
  /** Synchronous revocation fence held for the duration of each read. */
  acquireDeviceAuthorization(deviceId: string): () => void;
  device(deviceId: string): Promise<ChatProgressAuthorizeDevice | undefined>;
  chatMetadata(): Promise<readonly ChatMeta[]>;
  readChat(chatId: string): Promise<Chat | undefined>;
  authorizeRetainedBotChat(input: {
    deviceId: string;
    chatId: string;
    botId: string;
    access: "read";
  }): Promise<boolean>;
  events: ChatProgressEvents;
}

export interface ChatProgressAuthorizedChat {
  id: string;
  latestGenerationId?: string;
}

/**
 * Per-read authority for progress surfaces: current device grant, retained
 * chat/Bot ownership, and a fenced lookup of the latest durable generation so
 * idle reads can observe an inactive renderer's work without blocking on the
 * ordinary transcript path.
 */
export function createChatProgressAuthorizer(
  ports: ChatProgressAuthorizePorts,
): (
  deviceId: string,
  chatId: string,
  capability: Extract<AidenRemoteCapability, "tasks:read" | "agents:read">,
) => Promise<ChatProgressAuthorizedChat> {
  const latestGenerations = new Map<
    string,
    { updatedAt: number; generationId?: string }
  >();
  return async (deviceId, chatId, capability) => {
    const release = ports.acquireDeviceAuthorization(deviceId);
    try {
      const device = await ports.device(deviceId);
      if (!device || device.revokedAt !== undefined)
        throw new AidenRemoteServiceError(
          "credential_revoked",
          "This device is no longer paired.",
          403,
        );
      if (
        !device.acceptsProgressCapabilities ||
        !device.capabilities.includes("chat:read") ||
        !device.capabilities.includes(capability)
      ) {
        throw new AidenRemoteServiceError(
          "capability_denied",
          "Progress access is unavailable.",
          403,
        );
      }
      const metadata = (await ports.chatMetadata()).find(
        (entry) => entry.id === chatId,
      );
      if (
        !metadata ||
        persistedChatWorkspaceId(metadata.workspaceId) === ASSISTANT_WORKSPACE_ID
      ) {
        throw new AidenRemoteServiceError(
          "not_found",
          "This chat is unavailable.",
          404,
        );
      }
      if (
        metadata.botId &&
        (!device.capabilities.includes("bot:read") ||
          !(await ports.authorizeRetainedBotChat({
            deviceId,
            chatId,
            botId: metadata.botId,
            access: "read",
          })))
      ) {
        throw new AidenRemoteServiceError(
          "not_found",
          "This chat is unavailable.",
          404,
        );
      }
      // Reading the ordinary chat service can wait for an inactive renderer's
      // generation to finish. Progress must observe that generation
      // immediately, without reading its whole transcript.
      let latest = latestGenerations.get(chatId);
      if (
        !ports.events.current(chatId) &&
        latest?.updatedAt !== metadata.updatedAt
      ) {
        const readRevision = ports.events.revision(chatId);
        const chat = await ports.readChat(chatId);
        if (!chat)
          throw new AidenRemoteServiceError(
            "not_found",
            "This chat is unavailable.",
            404,
          );
        // Discard an idle read if a generation began or settled while it was
        // pending. The projection's revision fence retries it.
        if (
          readRevision === ports.events.revision(chatId) &&
          !ports.events.current(chatId)
        ) {
          latest = {
            updatedAt: metadata.updatedAt,
            generationId: [...chat.messages]
              .reverse()
              .find((message) => message.role === "assistant" && message.timeline)
              ?.timeline?.generationId,
          };
          if (latestGenerations.size >= 128)
            latestGenerations.delete(latestGenerations.keys().next().value!);
          latestGenerations.set(chatId, latest);
        }
      }
      // Recheck revocation after the asynchronous reads: acquire throws if the
      // device was blocked while metadata or the transcript read was pending.
      ports.acquireDeviceAuthorization(deviceId)();
      return { id: chatId, latestGenerationId: latest?.generationId };
    } finally {
      release();
    }
  };
}
