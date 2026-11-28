import { join } from "node:path";
import { app, logger } from "../platform.js";
import { peekLoadedSubsystem } from "../loaded-subsystems.js";
import { createAcpScratchDirectories } from "./acp/scratch-directory.js";
import { ChatDeletionGate } from "./chat-deletion-gate.js";
import { ChatTurnAdmission, type ChatTurnLease } from "./chat-turn-admission.js";
import { ChatWorkspaceMutationGate } from "./chat-workspace-mutation-gate.js";

/**
 * Lightweight main-process chat turn and mutation gates shared between
 * `llm-client.ts` and lifecycle/history services (`chat-application-service`,
 * `workspace-application-service`, `chats.ts`) so chat CRUD, startup
 * reconciliation, and sidebar reads never pull `llm-client.ts` (or Pi/ACP/MCP)
 * until a generation actually begins.
 */
export const chatDeletionGate = new ChatDeletionGate();
export const chatWorkspaceMutationGate = new ChatWorkspaceMutationGate();
export const chatCopyGate = new ChatWorkspaceMutationGate();
export const chatTurnAdmission = new ChatTurnAdmission();
export const acpScratch = createAcpScratchDirectories({
  root: () => join(app.getPath("userData"), "acp", "scratch"),
  onPrepareError: (error) =>
    logger.warn("acp", "Could not prepare the agent scratch directory.", error),
});

export const lazyLlmLifecycleClient = {
  isChatBusy(chatId: string): boolean {
    const loaded = peekLoadedSubsystem("llmClient");
    if (loaded) return loaded.isChatBusy(chatId);
    return chatTurnAdmission.isAdmitted(chatId);
  },

  isChatOwnedByInactiveRenderer(chatId: string): boolean {
    return peekLoadedSubsystem("llmClient")?.isChatOwnedByInactiveRenderer(chatId) ?? false;
  },

  async waitForChatIdle(chatId: string): Promise<boolean> {
    const loaded = peekLoadedSubsystem("llmClient");
    if (loaded) return loaded.waitForChatIdle(chatId);
    return !chatTurnAdmission.isAdmitted(chatId);
  },

  async cancelChat(chatId: string): Promise<void> {
    const loaded = peekLoadedSubsystem("llmClient");
    if (loaded) {
      await loaded.cancelChat(chatId);
    }
  },

  async cancelWorkspaceAndSettle(workspaceId: string): Promise<void> {
    const loaded = peekLoadedSubsystem("llmClient");
    if (loaded) {
      await loaded.cancelWorkspaceAndSettle(workspaceId);
    }
  },

  forgetDeletedChat(chatId: string): Promise<void> {
    const loaded = peekLoadedSubsystem("llmClient");
    if (loaded) return loaded.forgetDeletedChat(chatId);
    return acpScratch.forget(chatId);
  },

  resetChatWorkspaceSession(chatId: string): Promise<void> {
    const loaded = peekLoadedSubsystem("llmClient");
    if (loaded) return loaded.resetChatWorkspaceSession(chatId);
    return acpScratch.forget(chatId);
  },

  beginChatDeletion(chatId: string): () => void {
    const loaded = peekLoadedSubsystem("llmClient");
    if (loaded) return loaded.beginChatDeletion(chatId);
    const finish = chatDeletionGate.begin(chatId);
    chatTurnAdmission.releaseChat(chatId);
    return finish;
  },

  beginChatWorkspaceChange(chatId: string): (() => void) | null {
    const loaded = peekLoadedSubsystem("llmClient");
    if (loaded) return loaded.beginChatWorkspaceChange(chatId);
    if (chatDeletionGate.isDeleting(chatId)) return null;
    return chatWorkspaceMutationGate.tryBegin(chatId, this.isChatBusy(chatId));
  },

  beginChatCopy(chatId: string): (() => void) | null {
    const loaded = peekLoadedSubsystem("llmClient");
    if (loaded) return loaded.beginChatCopy(chatId);
    if (chatDeletionGate.isDeleting(chatId)) return null;
    return chatCopyGate.tryBegin(chatId, this.isChatBusy(chatId));
  },

  beginChatExport(chatId: string): (() => void) | null {
    const loaded = peekLoadedSubsystem("llmClient");
    if (loaded) return loaded.beginChatExport(chatId);
    if (chatDeletionGate.isDeleting(chatId)) return null;
    return chatCopyGate.tryBegin(chatId, this.isChatBusy(chatId));
  },

  beginChatTurn(chatId: string, turnId: string, ownerId: string): ChatTurnLease | null {
    const loaded = peekLoadedSubsystem("llmClient");
    if (loaded) return loaded.beginChatTurn(chatId, turnId, ownerId);
    if (
      !turnId ||
      !ownerId ||
      chatTurnAdmission.requiresAppendReconciliation(ownerId) ||
      chatDeletionGate.isDeleting(chatId) ||
      chatCopyGate.isChanging(chatId) ||
      chatWorkspaceMutationGate.isChanging(chatId)
    ) {
      return null;
    }
    return chatTurnAdmission.tryBegin(chatId, turnId, ownerId, false);
  },

  markAppendReconciliationRequired(ownerId: string): void {
    chatTurnAdmission.markAppendReconciliationRequired(ownerId);
  },

  requiresAppendReconciliation(ownerId: string): boolean {
    return chatTurnAdmission.requiresAppendReconciliation(ownerId);
  },

  clearAppendReconciliationRequired(ownerId: string): void {
    chatTurnAdmission.clearAppendReconciliationRequired(ownerId);
  },

  abandonChatTurn(chatId: string, turnId: string, ownerId: string): boolean {
    const loaded = peekLoadedSubsystem("llmClient");
    if (loaded) return loaded.abandonChatTurn(chatId, turnId, ownerId);
    return chatTurnAdmission.releaseMatching(chatId, turnId, ownerId);
  },
};
