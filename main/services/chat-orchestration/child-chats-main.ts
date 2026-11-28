// Production wiring of `child_chats` (Phase 5, D3).

import { configStore } from "../config-store.js";
import { chatStore } from "../chat-store.js";
import { approvalCeilingOf, currentWorkspaceApproval } from "../approval-gate/run-approval.js";
import { ipcMain, logger } from "../../platform.js";
import { ChildChats } from "./child-chats.js";
import { ChildChatCompletions } from "./completion-delivery.js";
import { chatLinks, markPersonTookOver } from "./links-main.js";

async function remote() {
  return import("../aiden-remote-service-main.js");
}

export const childChatCompletions = new ChildChatCompletions({
  links: chatLinks,
  post: async (post) =>
    (await import("../follow-through/notice-delivery-main.js")).noticeDelivery.post(post),
  lastReply: async (chatId) => {
    const { chats } = await (await remote()).aidenChatOrchestrationServices();
    const window = await chats.messagesWindow(chatId, { limit: 5 });
    return [...window.messages].reverse().find((message) => message.role === "assistant")?.text;
  },
  setTimer: (run, ms) => {
    const timer = setTimeout(run, ms);
    timer.unref?.();
    return timer;
  },
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
  onError: (error) =>
    logger.warn(
      "chat-orchestration",
      "Could not tell a lead chat that a started chat ended.",
      error,
    ),
});

export const childChats = new ChildChats({
  services: async () => (await remote()).aidenChatOrchestrationServices(),
  links: chatLinks,
  lead: async (leadChatId) => {
    const meta = await chatStore.getMeta(leadChatId);
    if (!meta?.workspaceId) throw new Error("This chat has no workspace to start chats in.");
    const policy = await currentWorkspaceApproval(configStore, meta.workspaceId);
    if (!policy) throw new Error("This chat's workspace is gone.");
    return { workspaceId: meta.workspaceId, title: meta.title, ceiling: approvalCeilingOf(policy) };
  },
  answerIn: async () => `Aiden on ${await (await remote()).aidenHostDisplayName()}`,
  discardWorktree: async (workspaceId) => {
    const { workspaceWorktreeApplicationService } =
      await import("../workspace-worktree-application-service-main.js");
    // Main itself removes it: no window or device owns this operation, so nothing invalidates it.
    await workspaceWorktreeApplicationService.remove(
      { isDestroyed: () => false, onInvalidated: () => () => undefined },
      workspaceId,
      undefined,
      { force: false },
    );
  },
  onRunEnded: (event) => void childChatCompletions.runEnded(event),
  onChanged: (leadChatId) => childChatsChanged(leadChatId),
});

/** Tells the desktop a lead's started chats changed: `{leadChatId}`. */
export function childChatsChanged(leadChatId: string): void {
  ipcMain.broadcast("chats:child-chats-changed", { leadChatId });
}

/** The person wrote in a started chat: it is theirs now. */
export async function personTookOverStartedChat(chatId: string): Promise<void> {
  await markPersonTookOver(chatId);
  const lead = chatLinks.get(chatId)?.leadChatId;
  if (lead) childChatsChanged(lead);
}

/**
 * The person pressed Stop in a chat. If it leads started chats, their running
 * turns stop too (except chats the person took over), and their endings stop
 * waking it until the person next sends there.
 */
export async function leadChatStopped(chatId: string): Promise<void> {
  await chatLinks.restore();
  if (chatLinks.childrenOf(chatId).length === 0) return;
  childChatCompletions.quietLead(chatId);
  await childChats.stopAll(chatId);
}

/** The person sent in a chat: endings of the chats it started may wake it again. */
export function leadChatResumed(chatId: string): void {
  childChatCompletions.resumeLead(chatId);
}

/** A deleted chat's links go with it. */
export async function deleteChatLinks(chatId: string): Promise<void> {
  await chatLinks.restore();
  await chatLinks.deleteChat(chatId);
}
