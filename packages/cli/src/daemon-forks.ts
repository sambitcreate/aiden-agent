import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";
import { parseAttachments } from "../../../main/services/attachment-contract.js";
import { createChatForkService } from "../../../main/services/chat-fork-service.js";
import type { ChatMessage } from "../../../main/services/types.js";
import type { createDaemonChats } from "./daemon-chats.ts";
import type { createCliWorkspaceApplication } from "./workspace-application.ts";

/** The pi message a daemon turn would have produced for one visible message. */
function journalMessage(message: ChatMessage): Message {
  if (message.role === "assistant") {
    return { role: "assistant", content: [{ type: "text", text: message.content }], timestamp: message.createdAt,
      api: "openai-completions", provider: "forked", model: message.model ?? "forked", stopReason: "stop",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  }
  const attachments = parseAttachments(message.attachments ?? []) ?? [];
  return { role: "user", timestamp: message.createdAt, content: [{ type: "text", text: message.content }, ...attachments.map((attachment) => attachment.kind === "image" && attachment.data
    ? { type: "image" as const, data: attachment.data, mimeType: attachment.mimeType }
    : { type: "text" as const, text: `Attachment: ${attachment.name}\n${attachment.text ?? ""}` })] };
}

/**
 * Forks for `aiden serve`. A daemon turn prompts only the newest message and
 * reads everything earlier from the chat's pi journal, so a fork gets its own
 * journal seeded from the copied visible history. Tool results before the cut
 * are not carried; the model sees the conversation as the user saw it.
 */
export function createCliChatForks(daemon: ReturnType<typeof createDaemonChats>, workspace: ReturnType<typeof createCliWorkspaceApplication>) {
  const service = createChatForkService({
    chatStore: daemon.chatStore,
    // Holding the deletion gate closes turn admission while the source is copied.
    beginChatCopy: (chatId) => daemon.deletion.isDeleting(chatId) || daemon.llmClient.isChatBusy(chatId) ? null : daemon.deletion.begin(chatId),
    workspaceExists: async (workspaceId) => Boolean(await workspace.configStore.getWorkspace(workspaceId)),
    journal: {
      async forkChat(input) {
        const file = daemon.sessionPath(input.targetChatId);
        // Each turn opens the journal with the workspace folder as its cwd.
        const manager = SessionManager.create(dirname(file), dirname(file));
        for (const message of input.visible) manager.appendMessage(journalMessage(message));
        // Pi defers persistence until a reply, so write the seeded journal now.
        mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
        const temporary = `${file}.${randomUUID()}.tmp`;
        try {
          writeFileSync(temporary, [manager.getHeader(), ...manager.getEntries()].map((entry) => JSON.stringify(entry)).join("\n") + "\n", { flag: "wx", mode: 0o600 });
          renameSync(temporary, file);
        } finally { rmSync(temporary, { force: true }); }
        return true;
      },
      deleteChat: async (chatId) => { await rm(daemon.sessionPath(chatId), { force: true }); },
    },
  });
  return {
    service,
    admitWorkspace(workspaceId: string) {
      const admission = workspace.mutationGate.admit(workspaceId);
      return { isAborted: () => admission.signal.aborted, release: () => admission.release() };
    },
  };
}
