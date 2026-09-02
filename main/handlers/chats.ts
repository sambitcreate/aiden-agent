// Chat history CRUD IPC handlers.

import { BrowserWindow, dialog, ipcMain } from "../platform.js";
import type { ChatHtmlArtifactV1 } from "../../renderer/shared/chat-artifacts.js";
import { chatStore } from "../services/chat-store.js";
import { chatApplicationService } from "../services/chat-application-service-main.js";
import { chatTitleService } from "../services/chat-title.js";
import { configStore } from "../services/config-store.js";
import { computerUseStatus } from "../services/computer-use/status.js";
import { llmClient } from "../services/llm-client.js";
import { rendererDocumentOwner } from "../services/renderer-document-owner.js";
import { persistedChatWorkspaceId } from "../../renderer/shared/chat-workspace.js";
import { isSafeSubagentIdentifier } from "../../renderer/shared/subagent-runs.js";
import {
  exportStoredHtmlArtifact,
  unresolvedGuiArtifactMessage,
  wrapStoredHtmlArtifact,
} from "../services/gui-artifact-recovery.js";
import { generativeUiArtifactStore } from "../services/generative-ui-artifact-store.js";
import { selectedHtmlArtifactMediaIds } from "../services/chat-copy-artifacts.js";
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
import { parseAssistantChatCreate, parseChatCreate } from "./chat-create-params.js";
import { isChatCreateReconciliationRequiredError } from "../services/chat-store-core.js";
import { parseChatCopyRequest, parseChatOnlyRequest } from "./chat-session-params.js";
import { safeExportFileName, writeAidenChatExportForRenderer } from "../services/chat-export.js";
import { chatForRenderer } from "../services/visible-chat-projection.js";
import { chatActivityRegistry } from "../services/chat-activity.js";
import { contextLifecycleService } from "../services/context-lifecycle-service-main.js";
import {
  cancelDesktopCompaction,
  compactDesktopChat,
} from "../services/context-lifecycle-adapters.js";
import { botApplicationService } from "../services/bot-application-service-main.js";
import { DesignProjectDeletionConfirmationRequiredError } from "../services/design-project-lifecycle.js";
import {
  designProjectLifecycle,
  designProjectStore,
} from "../services/design-project-store-main.js";
import { piCompactionSessionStore } from "../services/pi-compaction-session-store.js";
import { memoryStore } from "../services/memory-store-main.js";
import { isTodoSnapshotFailure, replayTodoState } from "../services/rpiv-todo/replay.js";
import { todoSnapshotForRenderer, unavailableTodoSnapshot } from "../../renderer/shared/todo.js";
import { createDesignProjectConnectionService } from "../services/design-project-connection-service.js";
import { workspaceEnvironmentApplicationService } from "../services/workspace-environment-application-service-main.js";
import { DESIGN_PROJECT_CHAT_WORKSPACE_ID } from "../../renderer/shared/design-projects.js";

const designProjectAppendService = createDesignProjectConnectionService({
  projects: designProjectStore,
  workspaces: workspaceEnvironmentApplicationService,
  runProjectMutation: (operation) => designProjectLifecycle.runProjectMutation(operation),
  chatWorkspaceId: async (chatId) => (await chatStore.get(chatId))?.workspaceId,
});

function asString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Expected non-empty string for "${name}".`);
  }
  return value;
}

function artifactRecoveryMessage(unresolved: string, recoveredMessage: string): string {
  if (unresolved.includes("could not be recovered")) return recoveredMessage;
  return unresolved.replace(
    "Open Aiden's developer log to locate",
    "Open Settings → About → Diagnostics and choose Reveal to locate",
  );
}

export function registerChatHistoryHandlers(): void {
  let chatCopyActive = false;
  let chatExportActive = false;
  ipcMain.handle("chats:activitySnapshot", () => chatActivityRegistry.snapshot());
  ipcMain.handle("chats:list", async (_event, workspaceId?: unknown) =>
    chatApplicationService.listRegular(
      typeof workspaceId === "string" && workspaceId ? workspaceId : undefined,
    ),
  );

  ipcMain.handle("chats:get", async (_event, id: unknown) =>
    chatApplicationService.get(asString(id, "id")),
  );

  ipcMain.handle("chats:todoSnapshot", async (event, id: unknown) => {
    const owner = rendererDocumentOwner(
      event,
      () => new Error("Todo state requires the active application document."),
    );
    const chatId = asString(id, "id");
    const chat = await chatStore.get(chatId);
    if (
      !chat ||
      chat.botId ||
      persistedChatWorkspaceId(chat.workspaceId) === ASSISTANT_WORKSPACE_ID
    ) {
      return null;
    }
    if (owner.isDestroyed()) throw new Error("The renderer document is no longer active.");
    try {
      const snapshot = todoSnapshotForRenderer(
        chatId,
        await replayTodoState(await piCompactionSessionStore.openChat(chatId, chat)),
      );
      if (owner.isDestroyed()) throw new Error("The renderer document is no longer active.");
      return snapshot;
    } catch (error) {
      if (owner.isDestroyed()) throw new Error("The renderer document is no longer active.");
      if (!isTodoSnapshotFailure(error)) throw error;
      return unavailableTodoSnapshot(chatId);
    }
  });

  ipcMain.handle("chats:waitUntilIdle", async (_event, id: unknown) =>
    chatApplicationService.waitUntilIdle(asString(id, "id")),
  );

  ipcMain.handle("chats:compact", async (event, id: unknown) => {
    const owner = rendererDocumentOwner(
      event,
      () => new Error("Compaction requires the active application document."),
    );
    return compactDesktopChat(contextLifecycleService, asString(id, "id"), owner.documentId);
  });
  ipcMain.handle("chats:cancelCompact", (event, id: unknown) => {
    const owner = rendererDocumentOwner(
      event,
      () => new Error("Compaction cancellation requires the active application document."),
    );
    return cancelDesktopCompaction(contextLifecycleService, asString(id, "id"), owner.documentId);
  });

  ipcMain.handle("chats:create", async (event, input: unknown) => {
    const owner = rendererDocumentOwner(
      event,
      () => new Error("Chats require the active application document."),
    );
    const parsed = parseChatCreate(input);
    return chatApplicationService.create(parsed, owner);
  });

  ipcMain.handle("chats:createAssistant", async (event, input: unknown) => {
    // Attended Assistant is an intentional renderer capability: its dock and
    // approval UI live in this same document. This dedicated, bounded path does
    // not hide Assistant from its own renderer; it prevents ordinary chat
    // creation from forging the persisted identity that main treats as mode.
    const owner = rendererDocumentOwner(
      event,
      () => new Error("Assistant chats require the active application document."),
    );
    if (llmClient.requiresAppendReconciliation(owner.documentId)) {
      throw new Error(appendReconciliationFailureMessage("blocked"));
    }
    const parsed = parseAssistantChatCreate(input);
    const assertCurrent = () => {
      if (owner.isDestroyed()) throw new Error("The renderer document is no longer active.");
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

  ipcMain.handle("chats:rename", async (_event, id: unknown, title: unknown) => {
    await chatApplicationService.rename(asString(id, "id"), asString(title, "title"));
  });

  ipcMain.handle("chats:renameWithFoundationModels", async (_event, id: unknown) =>
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
        throw new Error("Finish the current response or approval before copying this chat.");
      }
      const source = await chatStore.get(parsed.chatId);
      if (!source) throw new Error("The chat is no longer available.");
      const unresolved = await unresolvedGuiArtifactMessage(parsed.chatId);
      if (unresolved) {
        throw new Error(
          artifactRecoveryMessage(
            unresolved,
            "A previous visual artifact could not be recovered. Delete this chat to discard it before copying.",
          ),
        );
      }
      const runCopy = async () => {
        if (source.botId) {
          const assertCurrent = () => {
            if (owner.isDestroyed()) {
              throw new Error("The application changed before the Bot chat was copied.");
            }
            if (llmClient.requiresAppendReconciliation(owner.documentId)) {
              throw new Error(appendReconciliationFailureMessage("blocked"));
            }
          };
          const copied = await botApplicationService.copyChat({
            botId: source.botId,
            sourceChatId: parsed.chatId,
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
        }

        const workspaceId = persistedChatWorkspaceId(source.workspaceId);
        if (workspaceId === ASSISTANT_WORKSPACE_ID) {
          throw new Error("Assistant chats cannot be copied into the main chat surface.");
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
          const htmlMediaIds = selectedHtmlArtifactMediaIds(
            source.messages,
            parsed.throughMessageId,
          );
          const targetChatId = randomUUID();
          let preparedHtmlArtifacts: ChatHtmlArtifactV1[] = [];
          const copied = await (async () => {
            try {
              return await chatStore.copyVisibleHistory({
                sourceChatId: parsed.chatId,
                targetChatId,
                expectedWorkspaceId: workspaceId,
                throughAssistantMessageId: parsed.throughMessageId,
                assertCurrent,
                beforeInstall: async () => {
                  if (htmlMediaIds.length === 0) return;
                  preparedHtmlArtifacts = await generativeUiArtifactStore.prepareSelectedCopy(
                    source.id,
                    targetChatId,
                    htmlMediaIds,
                  );
                },
              });
            } catch (error) {
              if (
                preparedHtmlArtifacts.length > 0 &&
                !isChatCreateReconciliationRequiredError(error)
              ) {
                await generativeUiArtifactStore.deleteChat(targetChatId).catch(() => undefined);
              }
              throw error;
            }
          })();
          if (preparedHtmlArtifacts.length > 0) {
            await generativeUiArtifactStore.commit(
              copied.id,
              preparedHtmlArtifacts.map((artifact) => artifact.mediaId),
            );
          }
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
      };
      return runCopy();
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
        throw new Error("Finish the current response or approval before exporting this chat.");
      }
      const chat = await chatStore.get(chatId);
      if (!chat) throw new Error("The chat is no longer available.");
      const unresolvedExport = await unresolvedGuiArtifactMessage(chatId);
      if (unresolvedExport) {
        throw new Error(
          artifactRecoveryMessage(
            unresolvedExport,
            "A previous visual artifact could not be recovered. Delete this chat to discard it before exporting.",
          ),
        );
      }
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
      if (result.canceled || !result.filePath) return { status: "cancelled" as const };
      if (owner.isDestroyed()) {
        throw new Error("The renderer document is no longer active.");
      }
      const latestChat = await chatStore.get(chatId);
      if (!latestChat) throw new Error("The chat is no longer available.");
      const unresolvedExportAfterDialog = await unresolvedGuiArtifactMessage(chatId);
      if (unresolvedExportAfterDialog) {
        throw new Error(
          artifactRecoveryMessage(
            unresolvedExportAfterDialog,
            "A previous visual artifact could not be recovered. Delete this chat to discard it before exporting.",
          ),
        );
      }
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
      return chatApplicationService.moveEmptyToWorkspace(
        asString(id, "id"),
        asString(workspaceId, "workspaceId"),
      );
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
        const status = await computerUseStatus.status({
          signal: controller.signal,
        });
        if (owner.isDestroyed()) throw new Error("The renderer document is no longer active.");
        if (!status.ready) throw new Error(status.detail);
      }
      if (owner.isDestroyed()) throw new Error("The renderer document is no longer active.");
      return chatForRenderer(
        await chatStore.setComputerUseEnabled(chatId, enabled, () => !owner.isDestroyed()),
      );
    } finally {
      removeInvalidation();
      release();
    }
  });

  ipcMain.handle("chats:remove", async (_event, id: unknown, confirmationValue?: unknown) => {
    const chatId = asString(id, "id");
    const chat = await chatStore.get(chatId);
    if (chat?.botId) {
      const result = await botApplicationService.deleteChat({ botId: chat.botId, chatId });
      await memoryStore.deleteScope({ kind: "bot", id: chat.botId });
      return result;
    }
    let confirmation: { projectId: string; expectedRevision: number } | undefined;
    if (confirmationValue !== undefined) {
      if (
        !confirmationValue ||
        typeof confirmationValue !== "object" ||
        Array.isArray(confirmationValue)
      ) {
        throw new Error("Invalid Design Project deletion confirmation.");
      }
      const candidate = confirmationValue as Record<string, unknown>;
      if (
        Object.keys(candidate).length !== 2 ||
        typeof candidate.projectId !== "string" ||
        !Number.isSafeInteger(candidate.expectedRevision) ||
        (candidate.expectedRevision as number) < 1
      ) {
        throw new Error("Invalid Design Project deletion confirmation.");
      }
      confirmation = {
        projectId: candidate.projectId,
        expectedRevision: candidate.expectedRevision as number,
      };
    }
    try {
      const result = await designProjectLifecycle.routeChatDeletion({
        chatId,
        confirmation,
        deleteOrdinaryChat: (ordinaryChatId) => chatApplicationService.remove(ordinaryChatId),
        beforeDesignDelete: (plan) => {
          if (llmClient.isChatBusy(plan.chatId)) {
            throw new Error(
              "Finish or stop the current Design response before deleting this project.",
            );
          }
        },
      });
      return { status: "deleted" as const, kind: result.kind };
    } catch (error) {
      if (error instanceof DesignProjectDeletionConfirmationRequiredError) {
        return { status: "confirmation-required" as const, plan: error.plan };
      }
      throw error;
    }
  });

  ipcMain.handle("chats:appendMessage", (event, id: unknown, message: unknown, meta?: unknown) => {
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
      designPreflight,
      retainedBytes,
    } = parsed;
    const owner = rendererDocumentOwner(
      event,
      () => new Error("Chat messages require the active application document."),
    );
    if (llmClient.requiresAppendReconciliation(owner.documentId)) {
      throw new Error(appendReconciliationFailureMessage("blocked"));
    }
    const turn = llmClient.beginChatTurn(chatId, turnId, owner.documentId);
    if (!turn) {
      throw new Error("Wait for the previous response to finish saving before sending again.");
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
        const unresolvedSend = await unresolvedGuiArtifactMessage(chatId);
        if (unresolvedSend) {
          throw new Error(
            artifactRecoveryMessage(
              unresolvedSend,
              "A previous visual artifact could not be recovered. Delete this chat to discard it before sending another message.",
            ),
          );
        }
        const authoritativeChat = await chatStore.get(chatId);
        if (!authoritativeChat) {
          throw new Error("This chat is no longer available.");
        }
        if (!turn.isActive()) {
          throw new Error("This message turn expired before it could be saved.");
        }
        const workspaceId = persistedChatWorkspaceId(authoritativeChat.workspaceId);
        const isDesignChat =
          workspaceId === DESIGN_PROJECT_CHAT_WORKSPACE_ID ||
          (await designProjectStore.getByChatId(chatId)) !== undefined;
        if (isDesignChat && !designPreflight) {
          throw new Error(
            "This Design Project changed before the prompt could be saved. Review it and try again.",
          );
        }
        if (!isDesignChat && designPreflight) {
          throw new Error("Design Project authority cannot be used with this chat.");
        }
        if (isDesignChat && skillReference) {
          throw new Error("Design Project prompts cannot invoke workspace skills.");
        }
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
        const isCurrent = () => turn.isActive() && workspaceAdmission?.signal.aborted !== true;
        const append = (
          skill?: {
            provenance: {
              version: 1;
              name: string;
              source: "configured" | "workspace" | "global";
            };
          },
          appendIsCurrent: () => boolean = () => true,
        ) =>
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
                  isCurrent: () => isCurrent() && appendIsCurrent(),
                },
              ),
            recover: () => chatStore.get(chatId),
          });
        const appendDesignTurn = async () => {
          if (!designPreflight || designPreflight.chatId !== chatId) {
            throw new Error(
              "This Design Project changed before the prompt could be saved. Review it and try again.",
            );
          }
          return designProjectAppendService.runGenerationAppend(
            owner,
            designPreflight,
            (designIsCurrent) => append(undefined, designIsCurrent),
          );
        };
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
                  skillRegistry.resolveFresh(resolvedWorkspaceId, invocationId),
                isCurrent,
                prepareLease: (prepared) => turn.prepareSkillInvocation(prepared),
                append,
              },
            )
          : isDesignChat
            ? await appendDesignTurn()
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
  });

  ipcMain.handle("chats:htmlArtifactSrcdoc", async (event, input: unknown) => {
    rendererDocumentOwner(
      event,
      () => new Error("HTML artifact preview requires the active application document."),
    );
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new Error("Invalid HTML artifact request.");
    }
    const record = input as Record<string, unknown>;
    const chatId = asString(record.chatId, "chatId");
    const mediaId = asString(record.mediaId, "mediaId");
    return wrapStoredHtmlArtifact({
      chatId,
      mediaId,
      theme: record.theme,
      designStudio: record.designStudio === true,
    });
  });

  ipcMain.handle("chats:exportHtmlArtifact", async (event, input: unknown) => {
    const owner = rendererDocumentOwner(
      event,
      () => new Error("HTML artifact export requires the active application document."),
    );
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new Error("Invalid HTML artifact export request.");
    }
    const record = input as Record<string, unknown>;
    const chatId = asString(record.chatId, "chatId");
    const mediaId = asString(record.mediaId, "mediaId");
    const unresolved = await unresolvedGuiArtifactMessage(chatId);
    if (unresolved) {
      throw new Error(
        unresolved.includes("could not be recovered")
          ? "A previous visual artifact could not be recovered. Delete this chat to discard it before exporting."
          : unresolved,
      );
    }
    if (owner.isDestroyed()) {
      throw new Error("The renderer document is no longer active.");
    }
    const parent = BrowserWindow.fromWebContents(event.sender);
    if (!parent || parent.isDestroyed()) {
      throw new Error("The export window is unavailable.");
    }
    return exportStoredHtmlArtifact({ chatId, mediaId, parent });
  });

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
