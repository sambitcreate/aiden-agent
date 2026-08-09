// Chat history CRUD IPC handlers.

import { ipcMain, logger } from "../platform.js";
import { chatStore } from "../services/chat-store.js";
import { chatTitleService } from "../services/chat-title.js";
import { configStore } from "../services/config-store.js";
import { computerUseStatus } from "../services/computer-use/status.js";
import { llmClient } from "../services/llm-client.js";
import { rendererDocumentOwner } from "../services/renderer-document-owner.js";
import { subagentRunStore } from "../services/subagents/subagent-run-store.js";
import { persistedChatWorkspaceId } from "../../renderer/shared/chat-workspace.js";
import { isSafeSubagentIdentifier } from "../../renderer/shared/subagent-runs.js";
import type { Attachment, ChatRole } from "../services/types.js";
import { piCompactionSessionStore } from "../services/pi-compaction-session-store.js";

function asString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Expected non-empty string for "${name}".`);
  }
  return value;
}

const ROLES: ChatRole[] = ["user", "assistant", "system"];

export function registerChatHistoryHandlers(): void {
  ipcMain.handle("chats:list", async (_event, workspaceId?: unknown) =>
    chatStore.list(typeof workspaceId === "string" && workspaceId ? workspaceId : undefined),
  );

  ipcMain.handle("chats:get", async (_event, id: unknown) => {
    const chatId = asString(id, "id");
    let reconciliationRequired = false;
    if (llmClient.isChatOwnedByInactiveRenderer(chatId)) {
      reconciliationRequired = !(await llmClient.waitForChatIdle(chatId));
    }
    const chat = await chatStore.get(chatId);
    // The former renderer can be invalidated while this asynchronous read is
    // already in flight. Mark that result provisional as well; the renderer
    // retains a retry marker even if the one-shot settlement event was missed.
    reconciliationRequired ||= llmClient.isChatOwnedByInactiveRenderer(chatId);
    return {
      chat,
      reconciliation: reconciliationRequired
        ? {
            chatId,
            workspaceId: persistedChatWorkspaceId(chat?.workspaceId),
          }
        : null,
    };
  });

  ipcMain.handle("chats:waitUntilIdle", async (_event, id: unknown) =>
    llmClient.waitForChatIdle(asString(id, "id")),
  );

  ipcMain.handle("chats:create", async (_event, input: unknown) => {
    const i = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
    return chatStore.create({
      title: typeof i.title === "string" ? i.title : undefined,
      workspaceId: typeof i.workspaceId === "string" ? i.workspaceId : undefined,
      providerId: typeof i.providerId === "string" ? i.providerId : undefined,
      model: typeof i.model === "string" ? i.model : undefined,
    });
  });

  ipcMain.handle("chats:rename", async (_event, id: unknown, title: unknown) => {
    await chatStore.rename(asString(id, "id"), asString(title, "title"));
  });

  ipcMain.handle("chats:renameWithFoundationModels", async (_event, id: unknown) =>
    chatTitleService.renameWithFoundationModels(asString(id, "id")),
  );

  ipcMain.handle(
    "chats:moveEmptyToWorkspace",
    async (_event, id: unknown, workspaceId: unknown) => {
      const chatId = asString(id, "id");
      const nextWorkspaceId = asString(workspaceId, "workspaceId");
      const finishMove = llmClient.beginChatWorkspaceChange(chatId);
      if (!finishMove) {
        throw new Error("Finish or stop the current response before changing workspaces.");
      }
      try {
        if (!(await configStore.getWorkspace(nextWorkspaceId))) {
          throw new Error(`Workspace ${nextWorkspaceId} not found.`);
        }
        return await chatStore.moveEmptyChatToWorkspace(chatId, nextWorkspaceId);
      } finally {
        finishMove();
      }
    },
  );

  ipcMain.handle("chats:setComputerUse", async (event, id: unknown, enabled: unknown) => {
    const owner = rendererDocumentOwner(
      event,
      () => new Error("Computer Use settings require the active application document."),
    );
    const chatId = asString(id, "id");
    if (typeof enabled !== "boolean") throw new Error("Invalid Computer Use chat setting.");
    const release = llmClient.beginComputerUseSettingChange(chatId);
    if (!release) {
      throw new Error("Finish or stop the current response before changing Computer Use.");
    }
    const controller = new AbortController();
    const removeInvalidation = owner.onInvalidated(() =>
      controller.abort(new Error("The renderer document is no longer active.")),
    );
    try {
      if (enabled) {
        const status = await computerUseStatus.status({ signal: controller.signal });
        if (owner.isDestroyed()) throw new Error("The renderer document is no longer active.");
        if (!status.ready) throw new Error(status.detail);
      }
      if (owner.isDestroyed()) throw new Error("The renderer document is no longer active.");
      return await chatStore.setComputerUseEnabled(chatId, enabled, () => !owner.isDestroyed());
    } finally {
      removeInvalidation();
      release();
    }
  });

  ipcMain.handle("chats:remove", async (_event, id: unknown) => {
    const chatId = asString(id, "id");
    const finishDeletion = llmClient.beginChatDeletion(chatId);
    let releaseAdmission = false;
    try {
      await llmClient.cancelChat(chatId);
      // Privacy data is removed first so a partial cross-store failure cannot
      // leave orphaned inspector reports after the chat disappears from the UI.
      try {
        await subagentRunStore.deleteChat(chatId);
      } catch (error) {
        logger.error("subagents", "Could not delete private subagent history.", error);
        throw new Error("Aiden could not delete this chat's subagent history.");
      }
      try {
        await piCompactionSessionStore.deleteChat(chatId);
      } catch (error) {
        logger.error("pi", "Could not delete the private compaction journal.", error);
        throw new Error("Aiden could not delete this chat's compaction history.");
      }
      // remove() also reconciles an index entry whose payload is already
      // missing or corrupt, while propagating real filesystem failures.
      await chatStore.remove(chatId);
      // Clear the crash-recovery intent only after both stores have crossed
      // their durability barriers.
      await subagentRunStore.completeChatDeletion(chatId);
      releaseAdmission = true;
    } finally {
      if (!releaseAdmission) {
        try {
          releaseAdmission = !(await subagentRunStore.pendingChatDeletions()).includes(chatId);
        } catch (error) {
          // An indeterminate durable state must keep generation admission
          // closed until restart reconciliation can safely finish the delete.
          logger.error("subagents", "Could not inspect pending chat deletion state.", error);
        }
      }
      // A durable but incomplete intent keeps admission closed for this
      // process. Startup reconciliation finishes it before the next renderer.
      if (releaseAdmission) finishDeletion();
    }
  });

  ipcMain.handle(
    "chats:appendMessage",
    async (event, id: unknown, message: unknown, meta?: unknown) => {
      const chatId = asString(id, "id");
      const m = (typeof message === "object" && message !== null ? message : {}) as Record<
        string,
        unknown
      >;
      const role = ROLES.includes(m.role as ChatRole) ? (m.role as ChatRole) : "user";
      const metaObj = (typeof meta === "object" && meta !== null ? meta : {}) as Record<
        string,
        unknown
      >;
      const turnId = asString(metaObj.turnId, "turnId");
      if (!isSafeSubagentIdentifier(turnId)) {
        throw new Error("Invalid chat message turn identifier.");
      }
      const owner = rendererDocumentOwner(
        event,
        () => new Error("Chat messages require the active application document."),
      );
      const turn = llmClient.beginChatTurn(chatId, turnId, owner.documentId);
      if (!turn) {
        throw new Error("Wait for the previous response to finish saving before sending again.");
      }
      turn.onReleased(owner.onInvalidated(turn.release));
      let appended = false;
      try {
        const chat = await chatStore.appendMessage(
          chatId,
          {
            role,
            content: typeof m.content === "string" ? m.content : "",
            model: typeof m.model === "string" ? m.model : undefined,
            attachments: Array.isArray(m.attachments) ? (m.attachments as Attachment[]) : undefined,
            // Reasoning and generation timelines are persisted by the trusted
            // main-process generation owner, never accepted from renderer data.
            reasoning: undefined,
            timeline: undefined,
            subagents: undefined,
          },
          {
            providerId: typeof metaObj.providerId === "string" ? metaObj.providerId : undefined,
            model: typeof metaObj.model === "string" ? metaObj.model : undefined,
            autoTitle: metaObj.autoTitle === true,
          },
        );
        appended = true;
        return chat;
      } finally {
        if (!appended) turn.release();
      }
    },
  );

  ipcMain.handle("chats:abandonTurn", (event, id: unknown, turnId: unknown) => {
    const owner = rendererDocumentOwner(
      event,
      () => new Error("Chat turns require the active application document."),
    );
    const parsedTurnId = asString(turnId, "turnId");
    if (!isSafeSubagentIdentifier(parsedTurnId)) {
      throw new Error("Invalid chat message turn identifier.");
    }
    return llmClient.abandonChatTurn(asString(id, "id"), parsedTurnId, owner.documentId);
  });
}
