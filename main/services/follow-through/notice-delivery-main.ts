// Main-process wiring for follow-up notices: the running-turn queue, the
// unattended follow-up turn, and plain appends all go through llmClient and
// the chat store so turn admission and transcript order stay main-owned.

import { randomUUID } from "node:crypto";
import { ipcMain, logger } from "../../platform.js";
import type { NotificationChannel } from "../../../renderer/preload-channels.js";
import { chatStore } from "../chat-store.js";
import { configStore } from "../config-store.js";
import type { ChatGenerationOwner } from "../chat-generation-owner.js";
import { llmClient } from "../llm-client.js";
import type { Chat } from "../types.js";
import {
  NoticeDelivery,
  type AgentNoticePost,
  type AppendResult,
  type QueueIntoRunResult,
  type StartTurnResult,
} from "./notice-delivery.js";

/** A headless owner for a turn nobody is watching; the Mac's run journal still mirrors it. */
function createUnattendedOwner(streamId: string): ChatGenerationOwner {
  return {
    id: 0,
    documentId: `follow-up:${streamId}`,
    isDestroyed: () => false,
    send: (_channel: NotificationChannel, _payload: unknown) => undefined,
    onInvalidated: () => () => undefined,
  };
}

/**
 * A notice was saved into the transcript. The chat list re-reads, and an open
 * chat re-reads its messages: a notice saved without a turn has no stream to
 * show it.
 */
function transcriptChanged(chatId: string): void {
  ipcMain.broadcast("chats:changed", {});
  ipcMain.broadcast("chats:follow-through-changed", { chatId, transcript: true });
}

function lastMessageId(chat: Chat): string {
  return chat.messages[chat.messages.length - 1]?.id ?? "";
}

type FollowUpChat = { chat: Chat; workspaceId: string; providerId: string; model: string };

async function followUpChat(chatId: string): Promise<FollowUpChat | { unavailable: string }> {
  const chat = await chatStore.get(chatId);
  if (!chat) return { unavailable: "The chat no longer exists." };
  if (chat.botId || chat.owner !== undefined) return { unavailable: "This conversation runs its own way." };
  if (!chat.providerId || !chat.model) return { unavailable: "The chat has no model yet." };
  if (!chat.workspaceId) return { unavailable: "The chat has no folder." };
  const workspace = await configStore.getWorkspace(chat.workspaceId);
  if (!workspace?.folderPath || workspace.permission === "none") {
    return { unavailable: "Folder access is off for this chat." };
  }
  return { chat, workspaceId: workspace.id, providerId: chat.providerId, model: chat.model };
}

async function queueIntoRun(post: AgentNoticePost): Promise<QueueIntoRunResult> {
  const result = await llmClient.admitAgentNotice(post.chatId, { text: post.text, notice: post.notice });
  if (!result) return { kind: "no-run" };
  if (result.committed) transcriptChanged(post.chatId);
  if (result.admitted && result.messageId) return { kind: "queued", messageId: result.messageId };
  if (result.committed && result.messageId) return { kind: "saved", messageId: result.messageId };
  return { kind: "rejected" };
}

async function startTurn(chatId: string, post?: AgentNoticePost): Promise<StartTurnResult> {
  const target = await followUpChat(chatId);
  if ("unavailable" in target) return { kind: "unavailable", reason: target.unavailable };
  const streamId = `followup-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const owner = createUnattendedOwner(streamId);
  const lease = llmClient.beginChatTurn(chatId, streamId, owner.documentId);
  if (!lease) return { kind: "busy" };
  let messageId: string | undefined;
  try {
    if (post) {
      lease.reserveAppendPayload(Buffer.byteLength(post.text, "utf8") + 1_024);
      const saved = await chatStore.appendMessage(
        chatId,
        { role: "user", content: post.text, notice: post.notice },
        {
          providerId: target.providerId,
          model: target.model,
          expectedWorkspaceId: target.workspaceId,
          isCurrent: () => lease.isActive(),
        },
      );
      messageId = lastMessageId(saved);
      transcriptChanged(chatId);
    }
    lease.settleAsyncWork();
    const started = await llmClient.start(
      streamId,
      {
        chatId,
        workspaceId: target.workspaceId,
        providerId: target.providerId,
        model: target.model,
        messages: [],
      },
      owner,
      {
        turnId: streamId,
        usageSource: "chat",
        unattended: true,
        allowSubagents: false,
        allowComputerUse: false,
        allowMcpTools: false,
      },
    );
    if (!started) {
      lease.release();
      return { kind: "unavailable", reason: "The follow-up turn stopped before it began.", ...(messageId ? { messageId } : {}) };
    }
    return { kind: "started", streamId, ...(messageId ? { messageId } : {}) };
  } catch (error) {
    lease.release();
    lease.settleAsyncWork();
    logger.warn("follow-through", "A follow-up turn could not start.", error);
    return {
      kind: "unavailable",
      reason: error instanceof Error ? error.message : "The follow-up turn could not start.",
      ...(messageId ? { messageId } : {}),
    };
  }
}

async function append(post: AgentNoticePost): Promise<AppendResult> {
  const chat = await chatStore.get(post.chatId);
  if (!chat) return { kind: "gone", reason: "The chat no longer exists." };
  const turnId = `notice-${randomUUID()}`;
  const ownerId = `follow-up-append:${turnId}`;
  const lease = llmClient.beginChatTurn(post.chatId, turnId, ownerId);
  if (!lease) return { kind: "busy" };
  try {
    const saved = await chatStore.appendMessage(
      post.chatId,
      { role: "user", content: post.text, notice: post.notice },
      { isCurrent: () => lease.isActive() },
    );
    transcriptChanged(post.chatId);
    return { kind: "appended", messageId: lastMessageId(saved) };
  } catch (error) {
    return { kind: "gone", reason: error instanceof Error ? error.message : "The notice could not be saved." };
  } finally {
    lease.release();
    lease.settleAsyncWork();
  }
}

export const noticeDelivery = new NoticeDelivery({
  queueIntoRun,
  startTurn,
  append,
  waitForIdle: async (chatId) => {
    await llmClient.waitForChatIdle(chatId);
  },
  now: Date.now,
  onError: (error) => logger.warn("follow-through", "A follow-up notice was not delivered.", error),
});
