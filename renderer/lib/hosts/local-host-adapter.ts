import {
  admitChatRunInput,
  aidenRemoteApi,
  chatsApi,
  stopDetachedGeneration,
} from "../ipc";
import { LOCAL_HOST_ID } from "../../shared/peer-host";
import type { ChatRunInputAdmissionResult } from "../../shared/chat-run-input";
import {
  HostChatControlError,
  type HostChatAdapter,
  type HostChatApprovalInput,
  type HostChatApprovalResult,
  type HostChatCancelInput,
  type HostChatCapability,
  type HostChatInput,
  type HostChatQuestionInput,
  type HostChatQuestionResult,
  type HostChatRenameInput,
  type HostChatResult,
  type HostChatSendInput,
  type HostChatStatus,
  type HostChatTurnReceipt,
} from "./host-chat-adapter";
import type { RemoteMessagesWindow } from "./remote-chat-mapper";

/** The local chat APIs the adapter wraps; tests pass recording fakes. */
export interface LocalChatApis {
  rename: (chatId: string, title: string) => Promise<void>;
  remove: (chatId: string) => Promise<void>;
  markRead: (chatId: string, throughMessageId?: string) => Promise<unknown>;
  approve: typeof chatsApi.approve;
  answerQuestionnaire: typeof chatsApi.answerQuestionnaire;
  respondRemoteApproval: typeof aidenRemoteApi.respondApproval;
  stop: (streamId: string) => Promise<boolean>;
  admitRunInput: typeof admitChatRunInput;
}

const defaultApis: LocalChatApis = {
  rename: (chatId, title) => chatsApi.rename(chatId, title),
  remove: (chatId) => chatsApi.remove(chatId),
  markRead: (chatId, throughMessageId) => chatsApi.markRead(chatId, throughMessageId),
  approve: (approvalId, decision, options) => chatsApi.approve(approvalId, decision, options),
  answerQuestionnaire: (promptId, response) => chatsApi.answerQuestionnaire(promptId, response),
  respondRemoteApproval: (chatId, approvalId, decision, scope) =>
    aidenRemoteApi.respondApproval(chatId, approvalId, decision, scope),
  stop: (streamId) => stopDetachedGeneration(streamId),
  admitRunInput: (streamId, input) => admitChatRunInput(streamId, input),
};

const LOCAL_CAPABILITIES: ReadonlySet<HostChatCapability> = new Set<HostChatCapability>([
  "markRead",
  "send",
  "cancel",
  "respondApproval",
  "answerQuestion",
  "steer",
  "rename",
  "remove",
  "localPanels",
]);

const LOCAL_STATUS: HostChatStatus = { availability: "online", generation: 0 };

const NOT_A_HOST_READ = {
  code: "unsupported",
  message: "Local chats are read from this Mac's chat store.",
} as const;

/**
 * `HostChatAdapter` for this Mac. A pass-through over the existing local chat
 * APIs: it adds no behaviour, so local keys, routes, stores and IPC stay the
 * same. Local transcripts and streaming keep their own paths (`chatsApi.get`
 * and `startGeneration`), so the read side reports itself unsupported.
 */
export class LocalHostAdapter implements HostChatAdapter {
  readonly hostId = LOCAL_HOST_ID;
  private readonly apis: LocalChatApis;

  constructor(apis: LocalChatApis = defaultApis) {
    this.apis = apis;
  }

  capabilities(): ReadonlySet<HostChatCapability> {
    return LOCAL_CAPABILITIES;
  }

  ready(): Promise<void> {
    return Promise.resolve();
  }

  status(): HostChatStatus {
    return LOCAL_STATUS;
  }

  onStatus(): () => void {
    // This Mac is always reachable from itself.
    return () => {};
  }

  onChatChanged(): () => void {
    // Local chats are read from the store, which publishes its own changes.
    return () => {};
  }

  getMessagesWindow(): Promise<HostChatResult<RemoteMessagesWindow>> {
    return Promise.resolve({ ok: false, error: NOT_A_HOST_READ });
  }

  observe(): () => void {
    return () => {};
  }

  async markRead(chatId: string, throughMessageId?: string): Promise<HostChatResult<void>> {
    try {
      await this.apis.markRead(chatId, throughMessageId);
      return { ok: true, value: undefined };
    } catch (error) {
      return { ok: false, error: { code: "failed", message: error instanceof Error ? error.message : "Couldn't mark this chat read." } };
    }
  }

  send(_chatId: string, _input: HostChatSendInput): Promise<HostChatTurnReceipt> {
    // Local turns stream through the pane's own generation, which owns the transcript cache.
    return Promise.reject(new HostChatControlError({ code: "unsupported", message: "Local chats send through their own generation." }));
  }

  cancel(_chatId: string, input: HostChatCancelInput): Promise<boolean> {
    return this.apis.stop(input.runId);
  }

  async respondApproval(chatId: string, input: HostChatApprovalInput): Promise<HostChatApprovalResult> {
    if (input.source === "remote") {
      // A turn this Mac hosts for a paired phone resolves through the Remote service.
      await this.apis.respondRemoteApproval(
        chatId,
        input.approvalId,
        input.decision,
        input.decision === "allow" ? input.scope : undefined,
      );
    } else {
      const options =
        input.formFillExcludedOrders !== undefined || input.scope !== undefined
          ? {
              ...(input.formFillExcludedOrders !== undefined ? { formFillExcludedOrders: input.formFillExcludedOrders } : {}),
              ...(input.scope !== undefined ? { scope: input.scope } : {}),
            }
          : undefined;
      await this.apis.approve(input.approvalId, input.decision, options);
    }
    return { resolution: "applied" };
  }

  async answerQuestion(_chatId: string, input: HostChatQuestionInput): Promise<HostChatQuestionResult> {
    const answer = await this.apis.answerQuestionnaire(input.promptId, input.response);
    return { status: answer?.status };
  }

  submitInput(_chatId: string, input: HostChatInput): Promise<ChatRunInputAdmissionResult> {
    return this.apis.admitRunInput(input.runId, { mode: input.mode, text: input.text });
  }

  rename(chatId: string, input: HostChatRenameInput): Promise<void> {
    return this.apis.rename(chatId, input.title);
  }

  remove(chatId: string): Promise<void> {
    return this.apis.remove(chatId);
  }

  dispose(): void {
    // The local adapter is a process-wide singleton with nothing to release.
  }
}

/** The one local adapter every local chat pane shares. */
export const localHostAdapter = new LocalHostAdapter();
