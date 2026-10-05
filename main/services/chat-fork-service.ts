import { randomUUID } from "node:crypto";
import { ASSISTANT_WORKSPACE_ID } from "../../renderer/shared/assistant.js";
import type { ChatHtmlArtifactV1 } from "../../renderer/shared/chat-artifacts.js";
import type { ChatForkPosition } from "../../renderer/shared/chat-copy-contract.js";
import { persistedChatWorkspaceId } from "../../renderer/shared/chat-workspace.js";
import { selectedHtmlArtifactMediaIds } from "./chat-copy-artifacts.js";
import { ChatForkError } from "./chat-fork-error.js";
import type { ChatStore } from "./chat-store-core.js";
import { isChatCreateReconciliationRequiredError } from "./chat-store-core.js";
import type { Chat, ChatMessage } from "./types.js";

export interface ChatForkRequest {
  chatId: string;
  /** Where to cut. Without it the whole visible history is copied. */
  forkAt?: { messageId: string; position: ChatForkPosition };
  /** Start the fork with a pending summary of what followed the cut. */
  summary?: { instructions?: string };
}

/** A caller's hold on the destination workspace while the fork is created. */
export interface ChatForkWorkspaceAdmission {
  isAborted(): boolean;
  release(): void;
}

/** What differs between the desktop window and a paired Remote device. */
export interface ChatForkCaller {
  admitWorkspace(workspaceId: string): ChatForkWorkspaceAdmission;
  /** Throw when the caller may no longer create the fork. */
  assertCurrent?(): void;
  /** Throw when the source no longer matches what the caller saw. Runs under the copy lock. */
  assertSource?(source: Chat): void;
  /** Throw to refuse the prepared fork before it is installed. */
  assertInstallable?(chat: Chat): void;
  /** Copy a Bot chat. Without it Bot chats cannot be forked. */
  copyBotChat?(source: Chat, request: ChatForkRequest): Promise<Chat>;
}

export interface ChatForkJournal {
  forkChat(input: {
    sourceChatId: string;
    targetChatId: string;
    targetCreatedAt: number;
    messages: readonly { sourceId: string; id: string }[];
    /** The fork's copied messages, for a journal rebuilt from visible history. */
    visible: readonly ChatMessage[];
  }): Promise<boolean>;
  deleteChat(chatId: string): Promise<void>;
}

export interface ChatForkHtmlArtifacts {
  prepareSelectedCopy(
    sourceChatId: string,
    targetChatId: string,
    mediaIds: readonly string[],
  ): Promise<ChatHtmlArtifactV1[]>;
  commit(chatId: string, mediaIds: readonly string[]): Promise<void>;
  deleteChat(chatId: string): Promise<void>;
}

export interface ChatForkServiceDependencies {
  chatStore: Pick<ChatStore, "get" | "copyVisibleHistory">;
  /** Hold the source still for the copy; null while it is busy. */
  beginChatCopy(chatId: string): (() => void) | null;
  workspaceExists(workspaceId: string): Promise<boolean>;
  /** Why the chat cannot be copied yet, such as an unrecovered visual artifact. */
  blockedReason?(chatId: string): Promise<string | undefined>;
  htmlArtifacts?: ChatForkHtmlArtifacts;
  /** Carries the model-side journal to the fork. Without it the fork rebuilds context from visible history. */
  journal?: ChatForkJournal;
  /**
   * The fork's model context exists only in its journal, so a journal that
   * cannot be prepared fails the fork instead of degrading it.
   */
  journalRequired?: boolean;
  /** Begin summarizing a fork whose summary is pending. Summaries need this. */
  startSummary?(chatId: string): void;
  /** The journal could not be carried; the fork still works. */
  reportDegraded?(error: unknown): void;
  /** Tell every surface a new chat exists. */
  published?(chat: Chat): void;
  newChatId?(): string;
}

export type ChatForkService = ReturnType<typeof createChatForkService>;

/**
 * Creates forks for every surface. One copy runs at a time, the source stays
 * idle while it is copied, and dependent records (visual artifacts, the model
 * journal) are prepared before the fork becomes visible.
 */
export function createChatForkService(deps: ChatForkServiceDependencies) {
  let active = false;

  return {
    supportsSummaries: deps.startSummary !== undefined,

    async fork(request: ChatForkRequest, caller: ChatForkCaller): Promise<Chat> {
      if (request.summary && !deps.startSummary) {
        throw new ChatForkError("unavailable", "Fork with summary is unavailable here.");
      }
      if (active) {
        throw new ChatForkError("busy", "Another chat copy is already in progress.");
      }
      active = true;
      let finishCopy: (() => void) | null = null;
      try {
        finishCopy = deps.beginChatCopy(request.chatId);
        if (!finishCopy) {
          throw new ChatForkError(
            "busy",
            "Finish the current response or approval before copying this chat.",
          );
        }
        const source = await deps.chatStore.get(request.chatId);
        if (!source) throw new ChatForkError("not_found", "The chat is no longer available.");
        caller.assertSource?.(source);
        const blocked = await deps.blockedReason?.(request.chatId);
        if (blocked) throw new ChatForkError("unavailable", blocked);

        if (source.botId) {
          if (!caller.copyBotChat) {
            throw new ChatForkError("not_found", "The chat is no longer available.");
          }
          const copied = await caller.copyBotChat(source, request);
          deps.published?.(copied);
          return copied;
        }

        const workspaceId = persistedChatWorkspaceId(source.workspaceId);
        if (workspaceId === ASSISTANT_WORKSPACE_ID) {
          throw new ChatForkError(
            "ineligible",
            "Assistant chats cannot be copied into the main chat surface.",
          );
        }
        const admission = caller.admitWorkspace(workspaceId);
        try {
          const assertCurrent = () => {
            if (admission.isAborted()) {
              throw new ChatForkError("busy", "The workspace changed before the chat was copied.");
            }
            caller.assertCurrent?.();
          };
          if (!(await deps.workspaceExists(workspaceId))) {
            throw new ChatForkError("unavailable", "The chat workspace is no longer available.");
          }
          const copied = await copyRegular(source, workspaceId, request, caller, assertCurrent);
          deps.published?.(copied);
          return copied;
        } finally {
          admission.release();
        }
      } finally {
        finishCopy?.();
        active = false;
      }
    },
  };

  async function copyRegular(
    source: Chat,
    workspaceId: string,
    request: ChatForkRequest,
    caller: ChatForkCaller,
    assertCurrent: () => void,
  ): Promise<Chat> {
    const targetChatId = deps.newChatId?.() ?? randomUUID();
    let preparedHtmlArtifacts: ChatHtmlArtifactV1[] = [];
    let journalForked = false;
    let copied: Chat;
    try {
      copied = await deps.chatStore.copyVisibleHistory({
        sourceChatId: request.chatId,
        targetChatId,
        expectedWorkspaceId: workspaceId,
        forkAt: request.forkAt,
        ...(request.summary ? { forkSummary: request.summary } : {}),
        assertCurrent,
        ...(caller.assertSource ? { assertSource: caller.assertSource } : {}),
        beforeInstall: async (chat, sourceMessageIds) => {
          caller.assertInstallable?.(chat);
          // The store has validated the cut, so the boundary exists here.
          const htmlMediaIds = deps.htmlArtifacts
            ? selectedHtmlArtifactMediaIds(source.messages, request.forkAt)
            : [];
          if (htmlMediaIds.length > 0) {
            preparedHtmlArtifacts = await deps.htmlArtifacts!.prepareSelectedCopy(
              source.id,
              targetChatId,
              htmlMediaIds,
            );
          }
          if (!deps.journal) return;
          // Carry the source's model-side journal (tool results and
          // compactions) up to the cut. Without it the fork still works;
          // it rebuilds model context from visible history.
          try {
            journalForked = await deps.journal.forkChat({
              sourceChatId: source.id,
              targetChatId,
              targetCreatedAt: chat.createdAt,
              messages: chat.messages.map((message, index) => ({
                sourceId: sourceMessageIds[index]!,
                id: message.id,
              })),
              visible: chat.messages,
            });
          } catch (error) {
            if (deps.journalRequired) {
              // A seed write may have landed before it failed.
              journalForked = true;
              throw new ChatForkError("unavailable", "Aiden could not prepare the fork's history.");
            }
            deps.reportDegraded?.(error);
            return;
          }
          if (!journalForked && deps.journalRequired) {
            throw new ChatForkError("unavailable", "Aiden could not prepare the fork's history.");
          }
        },
      });
    } catch (error) {
      if (!isChatCreateReconciliationRequiredError(error)) {
        if (preparedHtmlArtifacts.length > 0) {
          await deps.htmlArtifacts?.deleteChat(targetChatId).catch(() => undefined);
        }
        if (journalForked) {
          await deps.journal?.deleteChat(targetChatId).catch(() => undefined);
        }
      }
      throw error;
    }
    if (copied.forkedFrom?.summary?.state === "pending") {
      deps.startSummary?.(copied.id);
    }
    if (preparedHtmlArtifacts.length > 0) {
      await deps.htmlArtifacts!.commit(
        copied.id,
        preparedHtmlArtifacts.map((artifact) => artifact.mediaId),
      );
    }
    return copied;
  }
}
