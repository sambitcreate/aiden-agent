import { ASSISTANT_WORKSPACE_ID } from "../../renderer/shared/assistant.js";
import { appendReconciliationFailureMessage } from "../../renderer/shared/chat-message-contract.js";
import { persistedChatWorkspaceId } from "../../renderer/shared/chat-workspace.js";
import type { ParsedPublicChatCreate } from "../handlers/chat-create-params.js";
import type { chatStore } from "./chat-store.js";
import type { configStore } from "./config-store.js";
import { isChatCreateReconciliationRequiredError } from "./chat-store-core.js";
import type { llmClient } from "./llm-client.js";
import type { Chat } from "./types.js";
import type { piCompactionSessionStore } from "./pi-compaction-session-store.js";
import type { piRuntimeEffectStore } from "./pi-runtime-effect-store.js";
import type { subagentRunStore } from "./subagents/subagent-run-store.js";
import { chatForRenderer } from "./visible-chat-projection.js";
import type { workspaceMutationGate } from "./workspace-mutation-gate.js";
import {
  admitOwnedWorkspaceOperation,
  type workspaceOperationRegistry,
  type WorkspaceOperationDocumentOwner,
} from "./workspace-operation-registry.js";

export interface ChatApplicationOwner extends WorkspaceOperationDocumentOwner {
  documentId: string;
}

export interface ChatApplicationMutationOptions {
  assertCurrent?: (chat: Chat) => void | Promise<void>;
}

export interface ChatApplicationDependencies {
  chatStore: Pick<
    typeof chatStore,
    "list" | "get" | "create" | "rename" | "moveEmptyChatToWorkspace" | "remove"
  >;
  configStore: Pick<typeof configStore, "getWorkspace">;
  llmClient: Pick<
    typeof llmClient,
    | "isChatOwnedByInactiveRenderer"
    | "waitForChatIdle"
    | "requiresAppendReconciliation"
    | "markAppendReconciliationRequired"
    | "clearAppendReconciliationRequired"
    | "beginChatWorkspaceChange"
    | "beginChatDeletion"
    | "cancelChat"
  >;
  workspaceMutationGate: Pick<typeof workspaceMutationGate, "admit">;
  workspaceOperationRegistry: typeof workspaceOperationRegistry;
  subagentRunStore: Pick<
    typeof subagentRunStore,
    "deleteChat" | "completeChatDeletion" | "pendingChatDeletions"
  >;
  piRuntimeEffectStore: Pick<typeof piRuntimeEffectStore, "deleteChat">;
  piCompactionSessionStore: Pick<typeof piCompactionSessionStore, "deleteChat">;
  logError(area: string, message: string, error: unknown): void;
}

export function createChatApplicationService(deps: ChatApplicationDependencies) {
  const markReconciliationRequired = (owner: ChatApplicationOwner): never => {
    deps.llmClient.markAppendReconciliationRequired(owner.documentId);
    owner.onInvalidated(() => {
      deps.llmClient.clearAppendReconciliationRequired(owner.documentId);
    });
    throw new Error(appendReconciliationFailureMessage("blocked"));
  };

  return {
    list(workspaceId?: string) {
      return deps.chatStore.list(workspaceId);
    },

    async get(chatId: string) {
      let reconciliationRequired = false;
      if (deps.llmClient.isChatOwnedByInactiveRenderer(chatId)) {
        reconciliationRequired = !(await deps.llmClient.waitForChatIdle(chatId));
      }
      const chat = await deps.chatStore.get(chatId);
      reconciliationRequired ||= deps.llmClient.isChatOwnedByInactiveRenderer(chatId);
      return {
        chat: chatForRenderer(chat),
        reconciliation: reconciliationRequired
          ? {
              chatId,
              workspaceId: persistedChatWorkspaceId(chat?.workspaceId),
            }
          : null,
      };
    },

    waitUntilIdle(chatId: string) {
      return deps.llmClient.waitForChatIdle(chatId);
    },

    async create(input: ParsedPublicChatCreate, owner: ChatApplicationOwner) {
      if (deps.llmClient.requiresAppendReconciliation(owner.documentId)) {
        throw new Error(appendReconciliationFailureMessage("blocked"));
      }
      if (input.workspaceId === ASSISTANT_WORKSPACE_ID) {
        throw new Error("Aiden Assistant chats require the Assistant chat creation path.");
      }
      const mutationAdmission = deps.workspaceMutationGate.admit(input.workspaceId);
      let workspaceOperation:
        ReturnType<typeof admitOwnedWorkspaceOperation> | undefined;
      try {
        workspaceOperation = admitOwnedWorkspaceOperation(
          deps.workspaceOperationRegistry,
          owner,
          input.workspaceId,
        );
        if (!(await deps.configStore.getWorkspace(input.workspaceId))) {
          throw new Error("The selected workspace is no longer available.");
        }
        const assertCurrent = () => {
          if (owner.isDestroyed()) {
            throw new Error("The renderer document is no longer active.");
          }
          if (mutationAdmission.signal.aborted || workspaceOperation?.signal.aborted) {
            throw new Error("The workspace changed before the chat was created.");
          }
          if (deps.llmClient.requiresAppendReconciliation(owner.documentId)) {
            throw new Error(appendReconciliationFailureMessage("blocked"));
          }
        };
        try {
          return chatForRenderer(await deps.chatStore.create({ ...input, assertCurrent }));
        } catch (error) {
          if (isChatCreateReconciliationRequiredError(error)) {
            return markReconciliationRequired(owner);
          }
          throw error;
        }
      } finally {
        workspaceOperation?.release();
        mutationAdmission.release();
      }
    },

    rename(chatId: string, title: string, options: ChatApplicationMutationOptions = {}) {
      return deps.chatStore.rename(chatId, title, async (chat) => options.assertCurrent?.(chat));
    },

    async moveEmptyToWorkspace(
      chatId: string,
      workspaceId: string,
      options: ChatApplicationMutationOptions = {},
    ) {
      const finishMove = deps.llmClient.beginChatWorkspaceChange(chatId);
      if (!finishMove) {
        throw new Error("Finish or stop the current response before changing workspaces.");
      }
      try {
        if (!(await deps.configStore.getWorkspace(workspaceId))) {
          throw new Error(`Workspace ${workspaceId} not found.`);
        }
        return chatForRenderer(
          await deps.chatStore.moveEmptyChatToWorkspace(
            chatId,
            workspaceId,
            async (chat) => options.assertCurrent?.(chat),
          ),
        );
      } finally {
        finishMove();
      }
    },

    async remove(
      chatId: string,
      options: ChatApplicationMutationOptions = {},
    ): Promise<void> {
      const finishDeletion = deps.llmClient.beginChatDeletion(chatId);
      let releaseAdmission = false;
      try {
        const current = await deps.chatStore.get(chatId);
        if (!current) throw new Error(`Chat ${chatId} not found`);
        await options.assertCurrent?.(current);
        await deps.llmClient.cancelChat(chatId);
        try {
          await deps.subagentRunStore.deleteChat(chatId);
        } catch (error) {
          deps.logError("subagents", "Could not delete private subagent history.", error);
          throw new Error("Aiden could not delete this chat's subagent history.");
        }
        try {
          await deps.piRuntimeEffectStore.deleteChat(chatId);
        } catch (error) {
          deps.logError("pi", "Could not delete private Pi effect history.", error);
          throw new Error("Aiden could not delete this chat's tool-effect history.");
        }
        try {
          await deps.piCompactionSessionStore.deleteChat(chatId);
        } catch (error) {
          deps.logError("pi", "Could not delete the private compaction journal.", error);
          throw new Error("Aiden could not delete this chat's compaction history.");
        }
        await deps.chatStore.remove(chatId, async (chat) => {
          if (!chat) throw new Error(`Chat ${chatId} not found`);
          await options.assertCurrent?.(chat);
        });
        await deps.subagentRunStore.completeChatDeletion(chatId);
        releaseAdmission = true;
      } finally {
        if (!releaseAdmission) {
          try {
            releaseAdmission = !(await deps.subagentRunStore.pendingChatDeletions()).includes(chatId);
          } catch (error) {
            deps.logError(
              "subagents",
              "Could not inspect pending chat deletion state.",
              error,
            );
          }
        }
        if (releaseAdmission) finishDeletion();
      }
    },
  };
}
