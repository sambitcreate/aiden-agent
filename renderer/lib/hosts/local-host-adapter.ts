import {
  admitChatRunInput,
  aidenRemoteApi,
  chatsApi,
  localRunsApi,
  stopDetachedGeneration,
} from "../ipc";
import type { LocalRunFrame, LocalRunFrameMessage } from "../../shared/local-run-frames";
import { LOCAL_HOST_ID, type PeerRunSubscription } from "../../shared/peer-host";
import type { ChatRunInputAdmissionResult } from "../../shared/chat-run-input";
import {
  HostChatControlError,
  type HostChatAdapter,
  type HostChatApprovalInput,
  type HostChatApprovalResult,
  type HostChatCancelInput,
  type HostChatCapability,
  type HostChatInput,
  type HostChatObserver,
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
  respondRemoteQuestion: typeof aidenRemoteApi.respondQuestion;
  stop: (streamId: string) => Promise<boolean>;
  admitRunInput: typeof admitChatRunInput;
  /** Mirror of a run this Mac hosts for the chat (a phone's turn, another window's). */
  observeRun: (chatId: string) => Promise<PeerRunSubscription>;
  unobserveRun: (subscriptionId: string) => Promise<boolean>;
  onRunFrame: (handler: (message: LocalRunFrameMessage) => void) => () => void;
  /** Host-authority Stop for an observed run this window does not own. */
  stopHostRun: (runId: string) => Promise<boolean>;
}

const defaultApis: LocalChatApis = {
  rename: (chatId, title) => chatsApi.rename(chatId, title),
  remove: (chatId) => chatsApi.remove(chatId),
  markRead: (chatId, throughMessageId) => chatsApi.markRead(chatId, throughMessageId),
  approve: (approvalId, decision, options) => chatsApi.approve(approvalId, decision, options),
  answerQuestionnaire: (promptId, response) => chatsApi.answerQuestionnaire(promptId, response),
  respondRemoteApproval: (chatId, approvalId, decision, scope) =>
    aidenRemoteApi.respondApproval(chatId, approvalId, decision, scope),
  respondRemoteQuestion: (chatId, promptId, response) =>
    aidenRemoteApi.respondQuestion(chatId, promptId, response),
  stop: (streamId) => stopDetachedGeneration(streamId),
  admitRunInput: (streamId, input) => admitChatRunInput(streamId, input),
  observeRun: (chatId) => localRunsApi.observe(chatId),
  unobserveRun: (subscriptionId) => localRunsApi.unobserve(subscriptionId),
  onRunFrame: (handler) => localRunsApi.onFrame(handler),
  stopHostRun: (runId) => localRunsApi.stop(runId),
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
  "observe",
  // No "fork": the local pane forks through `chatsApi` directly.
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
  /** Runs each open observation has seen; Stop escalates to host authority only for these. */
  private readonly observedRuns = new Set<Set<string>>();

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

  /**
   * Follows the chat's current run on this Mac while this window is not the
   * one running it. Frames that land before the subscription resolves are
   * held, then replayed after its buffered events, so nothing is lost or
   * reordered.
   */
  observe(chatId: string, observer: HostChatObserver): () => void {
    let closed = false;
    let subscriptionId: string | null = null;
    let pending: LocalRunFrameMessage[] | null = [];
    const runs = new Set<string>();
    this.observedRuns.add(runs);
    const deliver = (frame: LocalRunFrame) => {
      if (closed) return;
      if (frame.kind === "event") {
        runs.add(frame.event.streamId);
        observer.onEvent(frame.event);
      } else {
        if (frame.runId) runs.add(frame.runId);
        observer.onState(frame.state);
      }
    };
    const offFrames = this.apis.onRunFrame((message) => {
      if (closed || message.chatId !== chatId) return;
      if (pending) pending.push(message);
      else if (message.subscriptionId === subscriptionId) for (const frame of message.frames) deliver(frame);
    });
    this.apis.observeRun(chatId).then(
      (subscription) => {
        if (closed) {
          void this.apis.unobserveRun(subscription.subscriptionId).catch(() => {});
          return;
        }
        subscriptionId = subscription.subscriptionId;
        if (subscription.runId) runs.add(subscription.runId);
        observer.onSubscription(subscription);
        const held = pending ?? [];
        pending = null;
        for (const message of held) {
          if (message.subscriptionId !== subscriptionId) continue;
          for (const frame of message.frames) deliver(frame);
        }
      },
      (error: unknown) => {
        pending = null;
        if (!closed) {
          observer.onError?.({
            code: "failed",
            message: error instanceof Error ? error.message : "Couldn't follow this chat's response.",
          });
        }
      },
    );
    return () => {
      if (closed) return;
      closed = true;
      offFrames();
      this.observedRuns.delete(runs);
      if (subscriptionId) void this.apis.unobserveRun(subscriptionId).catch(() => {});
    };
  }

  private isObserved(runId: string): boolean {
    for (const runs of this.observedRuns) if (runs.has(runId)) return true;
    return false;
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

  async cancel(_chatId: string, input: HostChatCancelInput): Promise<boolean> {
    // This window's own generations stop through their owner check. A run it
    // only observes (a phone's turn) stops with the host authority a paired
    // phone's Stop has.
    const stopped = await this.apis.stop(input.runId);
    if (stopped || !this.isObserved(input.runId)) return stopped;
    return this.apis.stopHostRun(input.runId);
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

  async answerQuestion(chatId: string, input: HostChatQuestionInput): Promise<HostChatQuestionResult> {
    if (input.source === "remote") {
      return this.apis.respondRemoteQuestion(chatId, input.promptId, input.response);
    }
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
