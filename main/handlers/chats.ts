// Chat history CRUD IPC handlers.

import { BrowserWindow, dialog, ipcMain, logger } from "../platform.js";
import { chatStore } from "../services/chat-store.js";
import { chatTitleService } from "../services/chat-title.js";
import { configStore } from "../services/config-store.js";
import { computerUseStatus } from "../services/computer-use/status.js";
import { llmClient } from "../services/llm-client.js";
import { rendererDocumentOwner } from "../services/renderer-document-owner.js";
import { subagentRunStore } from "../services/subagents/subagent-run-store.js";
import { persistedChatWorkspaceId } from "../../renderer/shared/chat-workspace.js";
import { isSafeSubagentIdentifier } from "../../renderer/shared/subagent-runs.js";
import { piCompactionSessionStore } from "../services/pi-compaction-session-store.js";
import { skillRegistry } from "../services/skill-registry-main.js";
import {
  commitSkillInvocationForAppend,
  requireSkillInvocationWorkspace,
} from "../services/skill-invocation-turn.js";
import { randomUUID } from "node:crypto";
import { workspaceMutationGate } from "../services/workspace-mutation-gate.js";
import {
  admitRendererOwnedWorkspaceOperation,
  workspaceOperationRegistry,
} from "../services/workspace-operation-registry.js";
import { parseChatAppend } from "./chat-append-params.js";
import {
  appendChatMessageWithReconciliation,
  isAppendReconciliationRequiredError,
} from "../services/chat-append-commit.js";
import { appendReconciliationFailureMessage } from "../../renderer/shared/chat-message-contract.js";
import { ASSISTANT_WORKSPACE_ID } from "../../renderer/shared/assistant.js";
import {
  parseAssistantChatCreate,
  parseChatCreate,
} from "./chat-create-params.js";
import { isChatCreateReconciliationRequiredError } from "../services/chat-store-core.js";
import {
  parseChatCopyRequest,
  parseChatOnlyRequest,
} from "./chat-session-params.js";
import {
  safeExportFileName,
  writeAidenChatExportForRenderer,
} from "../services/chat-export.js";
import { chatForRenderer } from "../services/visible-chat-projection.js";

function asString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Expected non-empty string for "${name}".`);
  }
  return value;
}

export function registerChatHistoryHandlers(): void {
  let chatCopyActive = false;
  let chatExportActive = false;
  ipcMain.handle("chats:list", async (_event, workspaceId?: unknown) =>
    chatStore.list(
      typeof workspaceId === "string" && workspaceId ? workspaceId : undefined,
    ),
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
      chat: chatForRenderer(chat),
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

  ipcMain.handle("chats:create", async (event, input: unknown) => {
    const owner = rendererDocumentOwner(
      event,
      () => new Error("Chats require the active application document."),
    );
    if (llmClient.requiresAppendReconciliation(owner.documentId)) {
      throw new Error(appendReconciliationFailureMessage("blocked"));
    }
    const parsed = parseChatCreate(input);
    if (parsed.workspaceId === ASSISTANT_WORKSPACE_ID) {
      throw new Error(
        "Aiden Assistant chats require the Assistant chat creation path.",
      );
    }
    const mutationAdmission = parsed.workspaceId
      ? workspaceMutationGate.admit(parsed.workspaceId)
      : undefined;
    let workspaceOperation:
      ReturnType<typeof admitRendererOwnedWorkspaceOperation> | undefined;
    try {
      workspaceOperation = parsed.workspaceId
        ? admitRendererOwnedWorkspaceOperation(
            workspaceOperationRegistry,
            owner,
            parsed.workspaceId,
          )
        : undefined;
      if (
        parsed.workspaceId &&
        !(await configStore.getWorkspace(parsed.workspaceId))
      ) {
        throw new Error("The selected workspace is no longer available.");
      }
      const assertCurrent = () => {
        if (owner.isDestroyed())
          throw new Error("The renderer document is no longer active.");
        if (
          mutationAdmission?.signal.aborted ||
          workspaceOperation?.signal.aborted
        ) {
          throw new Error("The workspace changed before the chat was created.");
        }
        if (llmClient.requiresAppendReconciliation(owner.documentId)) {
          throw new Error(appendReconciliationFailureMessage("blocked"));
        }
      };
      try {
        return chatForRenderer(
          await chatStore.create({ ...parsed, assertCurrent }),
        );
      } catch (error) {
        if (isChatCreateReconciliationRequiredError(error)) {
          llmClient.markAppendReconciliationRequired(owner.documentId);
          owner.onInvalidated(() => {
            llmClient.clearAppendReconciliationRequired(owner.documentId);
          });
          throw new Error(appendReconciliationFailureMessage("blocked"));
        }
        throw error;
      }
    } finally {
      workspaceOperation?.release();
      mutationAdmission?.release();
    }
  });

  ipcMain.handle("chats:createAssistant", async (event, input: unknown) => {
    // Attended Assistant is an intentional renderer capability: its dock and
    // approval UI live in this same document. This dedicated, bounded path does
    // not hide Assistant from its own renderer; it prevents ordinary chat
    // creation from forging the persisted identity that main treats as mode.
    const owner = rendererDocumentOwner(
      event,
      () =>
        new Error("Assistant chats require the active application document."),
    );
    if (llmClient.requiresAppendReconciliation(owner.documentId)) {
      throw new Error(appendReconciliationFailureMessage("blocked"));
    }
    const parsed = parseAssistantChatCreate(input);
    const assertCurrent = () => {
      if (owner.isDestroyed())
        throw new Error("The renderer document is no longer active.");
      if (llmClient.requiresAppendReconciliation(owner.documentId)) {
        throw new Error(appendReconciliationFailureMessage("blocked"));
      }
    };
    try {
      return chatForRenderer(
        await chatStore.create({
          ...parsed,
          workspaceId: ASSISTANT_WORKSPACE_ID,
          assertCurrent,
        }),
      );
    } catch (error) {
      if (isChatCreateReconciliationRequiredError(error)) {
        llmClient.markAppendReconciliationRequired(owner.documentId);
        owner.onInvalidated(() => {
          llmClient.clearAppendReconciliationRequired(owner.documentId);
        });
        throw new Error(appendReconciliationFailureMessage("blocked"));
      }
      throw error;
    }
  });

  ipcMain.handle(
    "chats:rename",
    async (_event, id: unknown, title: unknown) => {
      await chatStore.rename(asString(id, "id"), asString(title, "title"));
    },
  );

  ipcMain.handle(
    "chats:renameWithFoundationModels",
    async (_event, id: unknown) =>
      chatTitleService.renameWithFoundationModels(asString(id, "id")),
  );

  ipcMain.handle("chats:copyVisibleHistory", async (event, input: unknown) => {
    const owner = rendererDocumentOwner(
      event,
      () => new Error("Chat copying requires the active application document."),
    );
    if (llmClient.requiresAppendReconciliation(owner.documentId)) {
      throw new Error(appendReconciliationFailureMessage("blocked"));
    }
    const parsed = parseChatCopyRequest(input);
    if (chatCopyActive) {
      throw new Error("Another chat copy is already in progress.");
    }
    chatCopyActive = true;
    let finishCopy: (() => void) | null = null;
    try {
      finishCopy = llmClient.beginChatCopy(parsed.chatId);
      if (!finishCopy) {
        throw new Error(
          "Finish the current response or approval before copying this chat.",
        );
      }
      const source = await chatStore.get(parsed.chatId);
      if (!source) throw new Error("The chat is no longer available.");
      const workspaceId = persistedChatWorkspaceId(source.workspaceId);
      if (workspaceId === ASSISTANT_WORKSPACE_ID) {
        throw new Error(
          "Assistant chats cannot be copied into the main chat surface.",
        );
      }
      const mutationAdmission = workspaceMutationGate.admit(workspaceId);
      const workspaceOperation = admitRendererOwnedWorkspaceOperation(
        workspaceOperationRegistry,
        owner,
        workspaceId,
      );
      const assertCurrent = () => {
        if (
          owner.isDestroyed() ||
          mutationAdmission.signal.aborted ||
          workspaceOperation.signal.aborted
        ) {
          throw new Error("The workspace changed before the chat was copied.");
        }
        if (llmClient.requiresAppendReconciliation(owner.documentId)) {
          throw new Error(appendReconciliationFailureMessage("blocked"));
        }
      };
      try {
        if (!(await configStore.getWorkspace(workspaceId))) {
          throw new Error("The chat workspace is no longer available.");
        }
        const copied = await chatStore.copyVisibleHistory({
          sourceChatId: parsed.chatId,
          expectedWorkspaceId: workspaceId,
          throughAssistantMessageId: parsed.throughMessageId,
          assertCurrent,
        });
        ipcMain.broadcast("chats:metadata-updated", {
          chatId: copied.id,
          title: copied.title,
          workspaceId: persistedChatWorkspaceId(copied.workspaceId),
          updatedAt: copied.updatedAt,
        });
        return chatForRenderer(copied);
      } catch (error) {
        if (isChatCreateReconciliationRequiredError(error)) {
          llmClient.markAppendReconciliationRequired(owner.documentId);
          owner.onInvalidated(() => {
            llmClient.clearAppendReconciliationRequired(owner.documentId);
          });
          throw new Error(appendReconciliationFailureMessage("blocked"));
        }
        throw error;
      } finally {
        workspaceOperation.release();
        mutationAdmission.release();
      }
    } finally {
      finishCopy?.();
      chatCopyActive = false;
    }
  });

  ipcMain.handle("chats:export", async (event, input: unknown) => {
    const owner = rendererDocumentOwner(
      event,
      () => new Error("Chat export requires the active application document."),
    );
    const { chatId } = parseChatOnlyRequest(input);
    if (chatExportActive) {
      throw new Error("Another chat export is already in progress.");
    }
    chatExportActive = true;
    let finishExport: (() => void) | null = null;
    try {
      finishExport = llmClient.beginChatExport(chatId);
      if (!finishExport) {
        throw new Error(
          "Finish the current response or approval before exporting this chat.",
        );
      }
      const chat = await chatStore.get(chatId);
      if (!chat) throw new Error("The chat is no longer available.");
      if (owner.isDestroyed()) {
        throw new Error("The renderer document is no longer active.");
      }
      const parent = BrowserWindow.fromWebContents(event.sender);
      if (!parent || parent.isDestroyed()) {
        throw new Error("The export window is unavailable.");
      }
      const result = await dialog.showSaveDialog(parent, {
        title: "Export Aiden chat",
        defaultPath: safeExportFileName(chat.title),
        filters: [{ name: "Aiden chat", extensions: ["json"] }],
        properties: ["createDirectory", "showOverwriteConfirmation"],
      });
      if (result.canceled || !result.filePath)
        return { status: "cancelled" as const };
      if (owner.isDestroyed()) {
        throw new Error("The renderer document is no longer active.");
      }
      const latestChat = await chatStore.get(chatId);
      if (!latestChat) throw new Error("The chat is no longer available.");
      if (owner.isDestroyed()) {
        throw new Error("The renderer document is no longer active.");
      }
      await writeAidenChatExportForRenderer(result.filePath, latestChat);
      return { status: "saved" as const };
    } finally {
      finishExport?.();
      chatExportActive = false;
    }
  });

  ipcMain.handle(
    "chats:moveEmptyToWorkspace",
    async (_event, id: unknown, workspaceId: unknown) => {
      const chatId = asString(id, "id");
      const nextWorkspaceId = asString(workspaceId, "workspaceId");
      const finishMove = llmClient.beginChatWorkspaceChange(chatId);
      if (!finishMove) {
        throw new Error(
          "Finish or stop the current response before changing workspaces.",
        );
      }
      try {
        if (!(await configStore.getWorkspace(nextWorkspaceId))) {
          throw new Error(`Workspace ${nextWorkspaceId} not found.`);
        }
        return chatForRenderer(
          await chatStore.moveEmptyChatToWorkspace(chatId, nextWorkspaceId),
        );
      } finally {
        finishMove();
      }
    },
  );

  ipcMain.handle(
    "chats:setComputerUse",
    async (event, id: unknown, enabled: unknown) => {
      const owner = rendererDocumentOwner(
        event,
        () =>
          new Error(
            "Computer Use settings require the active application document.",
          ),
      );
      const chatId = asString(id, "id");
      if (typeof enabled !== "boolean")
        throw new Error("Invalid Computer Use chat setting.");
      const release = llmClient.beginComputerUseSettingChange(chatId);
      if (!release) {
        throw new Error(
          "Finish or stop the current response before changing Computer Use.",
        );
      }
      const controller = new AbortController();
      const removeInvalidation = owner.onInvalidated(() =>
        controller.abort(
          new Error("The renderer document is no longer active."),
        ),
      );
      try {
        if (enabled) {
          const status = await computerUseStatus.status({
            signal: controller.signal,
          });
          if (owner.isDestroyed())
            throw new Error("The renderer document is no longer active.");
          if (!status.ready) throw new Error(status.detail);
        }
        if (owner.isDestroyed())
          throw new Error("The renderer document is no longer active.");
        return chatForRenderer(
          await chatStore.setComputerUseEnabled(
            chatId,
            enabled,
            () => !owner.isDestroyed(),
          ),
        );
      } finally {
        removeInvalidation();
        release();
      }
    },
  );

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
        logger.error(
          "subagents",
          "Could not delete private subagent history.",
          error,
        );
        throw new Error("Aiden could not delete this chat's subagent history.");
      }
      try {
        await piCompactionSessionStore.deleteChat(chatId);
      } catch (error) {
        logger.error(
          "pi",
          "Could not delete the private compaction journal.",
          error,
        );
        throw new Error(
          "Aiden could not delete this chat's compaction history.",
        );
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
          releaseAdmission = !(
            await subagentRunStore.pendingChatDeletions()
          ).includes(chatId);
        } catch (error) {
          // An indeterminate durable state must keep generation admission
          // closed until restart reconciliation can safely finish the delete.
          logger.error(
            "subagents",
            "Could not inspect pending chat deletion state.",
            error,
          );
        }
      }
      // A durable but incomplete intent keeps admission closed for this
      // process. Startup reconciliation finishes it before the next renderer.
      if (releaseAdmission) finishDeletion();
    }
  });

  ipcMain.handle(
    "chats:appendMessage",
    (event, id: unknown, message: unknown, meta?: unknown) => {
      // Parse and project the entire renderer envelope synchronously. The raw
      // IPC objects are never captured by the asynchronous persistence frame.
      const parsed = parseChatAppend(id, message, meta);
      const {
        chatId,
        role,
        content,
        messageModel,
        attachments,
        providerId,
        metaModel,
        autoTitle,
        turnId,
        skillReference,
        retainedBytes,
      } = parsed;
      const owner = rendererDocumentOwner(
        event,
        () =>
          new Error("Chat messages require the active application document."),
      );
      if (llmClient.requiresAppendReconciliation(owner.documentId)) {
        throw new Error(appendReconciliationFailureMessage("blocked"));
      }
      const turn = llmClient.beginChatTurn(chatId, turnId, owner.documentId);
      if (!turn) {
        throw new Error(
          "Wait for the previous response to finish saving before sending again.",
        );
      }
      turn.onReleased(owner.onInvalidated(turn.release));
      try {
        if (skillReference) turn.reserveSkillPreparation();
        turn.reserveAppendPayload(retainedBytes);
      } catch (error) {
        turn.release();
        turn.settleAsyncWork();
        throw error;
      }

      return (async () => {
        let appended = false;
        try {
          const authoritativeChat = skillReference
            ? await chatStore.get(chatId)
            : undefined;
          if (skillReference && !authoritativeChat) {
            throw new Error("This chat is no longer available.");
          }
          if (!turn.isActive()) {
            throw new Error(
              "This message turn expired before it could be saved.",
            );
          }
          const workspaceId = authoritativeChat
            ? persistedChatWorkspaceId(authoritativeChat.workspaceId)
            : undefined;
          const skillWorkspaceId = skillReference
            ? requireSkillInvocationWorkspace(workspaceId)
            : undefined;
          const workspaceAdmission = skillWorkspaceId
            ? workspaceMutationGate.admit(skillWorkspaceId)
            : undefined;
          if (workspaceAdmission) {
            const abortTurn = () => turn.release();
            workspaceAdmission.signal.addEventListener("abort", abortTurn, {
              once: true,
            });
            turn.onReleased(() => {
              workspaceAdmission.signal.removeEventListener("abort", abortTurn);
              workspaceAdmission.release();
            });
          }
          const userMessageId = randomUUID();
          const isCurrent = () =>
            turn.isActive() && workspaceAdmission?.signal.aborted !== true;
          const append = (skill?: {
            provenance: {
              version: 1;
              name: string;
              source: "configured" | "workspace" | "global";
            };
          }) =>
            appendChatMessageWithReconciliation({
              messageId: userMessageId,
              append: () =>
                chatStore.appendMessage(
                  chatId,
                  {
                    id: userMessageId,
                    role,
                    content,
                    model: messageModel,
                    attachments,
                    skill: skill?.provenance,
                    // Reasoning and generation timelines are persisted by the trusted
                    // main-process generation owner, never accepted from renderer data.
                    reasoning: undefined,
                    timeline: undefined,
                    subagents: undefined,
                  },
                  {
                    providerId,
                    model: metaModel,
                    autoTitle,
                    expectedWorkspaceId: workspaceId,
                    isCurrent,
                  },
                ),
              recover: () => chatStore.get(chatId),
            });
          const chat = skillReference
            ? await commitSkillInvocationForAppend(
                {
                  invocationId: skillReference.invocationId,
                  role,
                  content,
                  attachments,
                  workspaceId: skillWorkspaceId!,
                  userMessageId,
                },
                {
                  resolveFresh: (resolvedWorkspaceId, invocationId) =>
                    skillRegistry.resolveFresh(
                      resolvedWorkspaceId,
                      invocationId,
                    ),
                  isCurrent,
                  prepareLease: (prepared) =>
                    turn.prepareSkillInvocation(prepared),
                  append,
                },
              )
            : await append();
          appended = true;
          return chatForRenderer(chat);
        } catch (error) {
          if (isAppendReconciliationRequiredError(error)) {
            llmClient.markAppendReconciliationRequired(owner.documentId);
            owner.onInvalidated(() => {
              llmClient.clearAppendReconciliationRequired(owner.documentId);
            });
          }
          throw error;
        } finally {
          if (!appended) turn.release();
          turn.settleAsyncWork();
        }
      })();
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
    return llmClient.abandonChatTurn(
      asString(id, "id"),
      parsedTurnId,
      owner.documentId,
    );
  });
}
