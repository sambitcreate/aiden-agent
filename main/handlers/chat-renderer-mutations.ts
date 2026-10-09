// The renderer's chat mutations: rename, a model-titled rename, delete and append.
// Each asks its service to refuse a chat another Aiden feature owns (a Design
// project's hidden chat). The handlers live here, apart from chats.ts, so they
// load without Electron and the refusal is pinned by invoking them; chats.ts
// registers them under the same channels.
import type { IpcMainInvokeEvent } from "electron";
import { randomUUID } from "node:crypto";
import { appendReconciliationFailureMessage } from "../../renderer/shared/chat-message-contract.js";
import { persistedChatWorkspaceId } from "../../renderer/shared/chat-workspace.js";
import {
  appendChatMessageWithReconciliation,
  isAppendReconciliationRequiredError,
} from "../services/chat-append-commit.js";
import type { createChatApplicationService } from "../services/chat-application-service.js";
import type { createChatStore } from "../services/chat-store-core.js";
import type { ChatTurnLease } from "../services/chat-turn-admission.js";
import type { RendererDocumentOwner } from "../services/renderer-document-owner.js";
import {
  commitSkillInvocationForAppend,
  requireSkillInvocationWorkspace,
} from "../services/skill-invocation-turn.js";
import { chatForRenderer } from "../services/visible-chat-projection.js";
import type { WorkspaceMutationGate } from "../services/workspace-mutation-gate.js";
import { parseChatAppend } from "./chat-append-params.js";

export function asString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Expected non-empty string for "${name}".`);
  }
  return value;
}

/** The app singletons these handlers use; chats.ts passes the real ones. */
export interface RendererChatMutationDeps {
  chatStore: Pick<ReturnType<typeof createChatStore>, "get" | "appendMessage">;
  chatApplicationService: Pick<ReturnType<typeof createChatApplicationService>, "rename" | "remove">;
  chatTitleService: {
    renameWithFoundationModels(chatId: string, options: { rejectFeatureOwned?: boolean }): Promise<unknown>;
  };
  botApplicationService: { deleteChat(input: { botId: string; chatId: string }): Promise<unknown> };
  hostPlatformCapabilities(): { bots: boolean };
  closeDeviceSessionsForChat(chatId: string): void;
  chatReadMarkers: { remove(chatId: string): Promise<unknown> };
  rendererDocumentOwner(event: IpcMainInvokeEvent, invalidRequest: () => Error): RendererDocumentOwner;
  llmClient: {
    requiresAppendReconciliation(ownerId: string): boolean;
    beginChatTurn(chatId: string, turnId: string, ownerId: string): ChatTurnLease | null;
    markAppendReconciliationRequired(ownerId: string): void;
    clearAppendReconciliationRequired(ownerId: string): void;
  };
  unresolvedGuiArtifactMessage(chatId: string): Promise<string | undefined>;
  artifactRecoveryMessage(unresolved: string, recoveredMessage: string): string;
  workspaceMutationGate: Pick<WorkspaceMutationGate, "admit">;
  skillRegistry: { resolveFresh: Parameters<typeof commitSkillInvocationForAppend>[1]["resolveFresh"] };
}

export function createRendererChatMutationHandlers(deps: RendererChatMutationDeps) {
  const {
    chatStore,
    chatApplicationService,
    chatTitleService,
    botApplicationService,
    hostPlatformCapabilities,
    closeDeviceSessionsForChat,
    chatReadMarkers,
    rendererDocumentOwner,
    llmClient,
    unresolvedGuiArtifactMessage,
    artifactRecoveryMessage,
    workspaceMutationGate,
    skillRegistry,
  } = deps;
  return {
    rename: async (_event: IpcMainInvokeEvent, id: unknown, title: unknown) => {
      await chatApplicationService.rename(asString(id, "id"), asString(title, "title"), {
        rejectFeatureOwned: true,
      });
    },

    renameWithFoundationModels: async (_event: IpcMainInvokeEvent, id: unknown) =>
      chatTitleService.renameWithFoundationModels(asString(id, "id"), { rejectFeatureOwned: true }),

    remove: async (_event: IpcMainInvokeEvent, id: unknown) => {
      const chatId = asString(id, "id");
      const chat = await chatStore.get(chatId);
      const result = chat?.botId && hostPlatformCapabilities().bots
        ? await botApplicationService.deleteChat({ botId: chat.botId, chatId })
        : await chatApplicationService.remove(chatId, { rejectFeatureOwned: true });
      closeDeviceSessionsForChat(chatId);
      void chatReadMarkers.remove(chatId).catch(() => undefined);
      return result;
    },

    appendMessage: (event: IpcMainInvokeEvent, id: unknown, message: unknown, meta?: unknown) => {
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
          const unresolvedSend = await unresolvedGuiArtifactMessage(chatId);
          if (unresolvedSend) {
            throw new Error(
              artifactRecoveryMessage(
                unresolvedSend,
                "A previous visual artifact could not be recovered. Delete this chat to discard it before sending another message.",
              ),
            );
          }
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
                    rejectFeatureOwned: true,
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
  };
}
