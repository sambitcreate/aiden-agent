// Production wiring of `child_chats` (Phase 5, D3).

import { configStore } from "../config-store.js";
import { chatStore } from "../chat-store.js";
import { approvalCeilingOf, currentWorkspaceApproval } from "../approval-gate/run-approval.js";
import { ChildChats } from "./child-chats.js";
import { chatLinks } from "./links-main.js";

async function remote() {
  return import("../aiden-remote-service-main.js");
}

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
});

/** A deleted chat's links go with it. */
export async function deleteChatLinks(chatId: string): Promise<void> {
  await chatLinks.restore();
  await chatLinks.deleteChat(chatId);
}
