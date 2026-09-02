import { ASSISTANT_WORKSPACE_ID } from "../../renderer/shared/assistant.js";
import { DESIGN_PROJECT_CHAT_WORKSPACE_ID } from "../../renderer/shared/design-projects.js";
import { appendReconciliationFailureMessage } from "../../renderer/shared/chat-message-contract.js";
import { persistedChatWorkspaceId } from "../../renderer/shared/chat-workspace.js";
import type { ParsedPublicChatCreate } from "../handlers/chat-create-params.js";
import type { chatStore } from "./chat-store.js";
import type { configStore } from "./config-store.js";
import type { displayImageArtifactStore } from "./display-image-artifact-store.js";
import type { generativeUiArtifactStore } from "./generative-ui-artifact-store.js";
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
  /**
   * Main-owned notification that cross-store deletion has durably installed its
   * subagent tombstone. From this point restart reconciliation can only roll the
   * deletion forward, even if a later private-store or chat-store step fails.
   */
  onDeletionRollForward?: () => void;
}

export interface ChatApplicationDependencies {
  chatStore: Pick<
    typeof chatStore,
    "list" | "listRegular" | "get" | "create" | "rename" | "moveEmptyChatToWorkspace" | "remove"
  > & Partial<Pick<typeof chatStore, "listSummaryMetadata">>;
  configStore: Pick<typeof configStore, "getWorkspace">;
  llmClient: Pick<
    typeof llmClient,
    | "isChatOwnedByInactiveRenderer"
    | "isChatBusy"
    | "waitForChatIdle"
    | "requiresAppendReconciliation"
    | "markAppendReconciliationRequired"
    | "clearAppendReconciliationRequired"
    | "beginChatWorkspaceChange"
    | "beginChatDeletion"
    | "cancelChat"
  >;
  displayImageArtifactStore: Pick<
    typeof displayImageArtifactStore,
    "availability" | "hasPending" | "deleteChat"
  >;
  generativeUiArtifactStore: Pick<
    typeof generativeUiArtifactStore,
    "availability" | "hasPending" | "deleteChat"
  >;
  workspaceMutationGate: Pick<typeof workspaceMutationGate, "admit">;
  workspaceOperationRegistry: typeof workspaceOperationRegistry;
  subagentRunStore: Pick<
    typeof subagentRunStore,
    "deleteChat" | "completeChatDeletion" | "pendingChatDeletions"
  >;
  piRuntimeEffectStore: Pick<typeof piRuntimeEffectStore, "deleteChat">;
  piCompactionSessionStore: Pick<typeof piCompactionSessionStore, "deleteChat">;
  memoryStore?: { deleteSourceChat(chatId: string): Promise<number> };
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

    listRegular(workspaceId?: string) {
      return deps.chatStore.listRegular(workspaceId);
    },

    listSummaryMetadata() {
      if (!deps.chatStore.listSummaryMetadata) {
        throw new Error("The transcript-free chat summary index is unavailable.");
      }
      return deps.chatStore.listSummaryMetadata();
    },

    async get(chatId: string) {
      let reconciliationRequired = false;
      if (deps.llmClient.isChatOwnedByInactiveRenderer(chatId)) {
        reconciliationRequired = !(await deps.llmClient.waitForChatIdle(chatId));
      }
      const imageArtifactAvailability = deps.displayImageArtifactStore.availability();
      const htmlArtifactAvailability = deps.generativeUiArtifactStore.availability();
      const imageArtifactRecoveryUnavailable =
        !imageArtifactAvailability.available || !htmlArtifactAvailability.available;
      const [chat, stagedImageArtifact, stagedHtmlArtifact] = await Promise.all([
        deps.chatStore.get(chatId),
        !imageArtifactAvailability.available
          ? Promise.resolve(false)
          : deps.displayImageArtifactStore.hasPending(chatId),
        !htmlArtifactAvailability.available
          ? Promise.resolve(false)
          : deps.generativeUiArtifactStore.hasPending(chatId),
      ]);
      reconciliationRequired ||= deps.llmClient.isChatOwnedByInactiveRenderer(chatId);
      const imageArtifactRecoveryPending =
        (stagedImageArtifact || stagedHtmlArtifact) && !deps.llmClient.isChatBusy(chatId)
          ? ((stagedImageArtifact
              ? await deps.displayImageArtifactStore.hasPending(chatId)
              : false) ||
              (stagedHtmlArtifact
                ? await deps.generativeUiArtifactStore.hasPending(chatId)
                : false)) &&
            !deps.llmClient.isChatBusy(chatId)
          : false;
      return {
        chat: chatForRenderer(chat),
        imageArtifactRecoveryPending,
        imageArtifactRecoveryUnavailable,
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

    /**
     * Create the private backing conversation for a Design Project. Its
     * reserved workspace id is a storage namespace only: it is deliberately
     * not resolved through configStore and cannot convey folder authority.
     */
    async createDesignConversation(
      input: { title: string },
      owner: ChatApplicationOwner,
    ) {
      if (deps.llmClient.requiresAppendReconciliation(owner.documentId)) {
        throw new Error(appendReconciliationFailureMessage("blocked"));
      }
      const assertCurrent = () => {
        if (owner.isDestroyed()) {
          throw new Error("The renderer document is no longer active.");
        }
        if (deps.llmClient.requiresAppendReconciliation(owner.documentId)) {
          throw new Error(appendReconciliationFailureMessage("blocked"));
        }
      };
      try {
        return chatForRenderer(
          await deps.chatStore.create({
            title: input.title,
            workspaceId: DESIGN_PROJECT_CHAT_WORKSPACE_ID,
            assertCurrent,
          }),
        );
      } catch (error) {
        if (isChatCreateReconciliationRequiredError(error)) {
          return markReconciliationRequired(owner);
        }
        throw error;
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
        const current = await deps.chatStore.get(chatId);
        if (!current) throw new Error(`Chat ${chatId} not found`);
        if (current.botId) {
          throw new Error("Bot conversations stay in their Aiden-managed folder.");
        }
        if (!(await deps.configStore.getWorkspace(workspaceId))) {
          throw new Error(`Workspace ${workspaceId} not found.`);
        }
        return chatForRenderer(
          await deps.chatStore.moveEmptyChatToWorkspace(
            chatId,
            workspaceId,
            async (chat) => {
              if (chat.botId) {
                throw new Error("Bot conversations stay in their Aiden-managed folder.");
              }
              await options.assertCurrent?.(chat);
            },
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
      let rollForwardPublished = false;
      const publishRollForward = () => {
        if (rollForwardPublished) return;
        rollForwardPublished = true;
        options.onDeletionRollForward?.();
      };
      try {
        const current = await deps.chatStore.get(chatId);
        if (!current) throw new Error(`Chat ${chatId} not found`);
        await options.assertCurrent?.(current);
        await deps.llmClient.cancelChat(chatId);
        try {
          await deps.subagentRunStore.deleteChat(chatId);
        } catch (error) {
          // The V1/V2 dispatcher can fail after one durable tombstone commits.
          // If its status is unreadable, conservatively retain roll-forward:
          // startup may still observe that tombstone and delete the chat.
          let deletionIsPending = true;
          try {
            deletionIsPending = (await deps.subagentRunStore.pendingChatDeletions()).includes(chatId);
          } catch (pendingError) {
            deps.logError(
              "subagents",
              "Could not inspect a failed chat deletion's durable state.",
              pendingError,
            );
          }
          if (deletionIsPending) publishRollForward();
          deps.logError("subagents", "Could not delete private subagent history.", error);
          throw new Error("Aiden could not delete this chat's subagent history.");
        }
        publishRollForward();
        try {
          await deps.displayImageArtifactStore.deleteChat(chatId);
        } catch (error) {
          deps.logError("pi", "Could not delete staged image artifacts.", error);
          throw new Error("Aiden could not delete this chat's staged image artifacts.");
        }
        try {
          await deps.generativeUiArtifactStore.deleteChat(chatId);
        } catch (error) {
          deps.logError("pi", "Could not delete staged HTML artifacts.", error);
          throw new Error("Aiden could not delete this chat's staged HTML artifacts.");
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
        try {
          await deps.memoryStore?.deleteSourceChat(chatId);
        } catch (error) {
          deps.logError("memory", "Could not delete facts sourced from this chat.", error);
          throw new Error("Aiden could not delete this chat's sourced memory.");
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
