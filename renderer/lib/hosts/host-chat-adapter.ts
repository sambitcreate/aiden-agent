import type { AskUserQuestionAnswerStatus, AskUserQuestionResponseV1 } from "../../shared/ask-user-question";
import type { ChatRunInputAdmissionResult, ChatRunInputMode } from "../../shared/chat-run-input";
import type {
  PeerBlockedReason,
  PeerOperationErrorDetails,
  PeerRunEvent,
  PeerRunStreamState,
  PeerRunSubscription,
} from "../../shared/peer-host";
import type { SkillInvocationV1 } from "../../shared/slash-commands";
import type { ToolApprovalScope } from "../../shared/tool-approval-scope";
import type { RemoteMessagesWindow } from "./remote-chat-mapper";

/**
 * One machine's chats, as a chat pane reads and drives them. Every method is
 * keyed by chat ID so one adapter serves every chat on its host. Reads return
 * a `HostChatResult` so a fenced answer can be told apart; control methods
 * reject with a `HostChatControlError`, which keeps the pane's existing
 * try/catch and toast paths.
 */

export type HostChatCapability =
  // Read side.
  | "messagesWindow"
  | "observe"
  | "markRead"
  // Control side.
  | "send"
  | "cancel"
  | "respondApproval"
  | "answerQuestion"
  | "steer"
  | "rename"
  | "remove"
  /** Stage attachments on the host for the next turn. */
  | "attach"
  /** Read the host's skill catalog and invoke a skill with a turn. */
  | "skills"
  // Host-wide: starting new work on the host.
  | "createChat"
  | "browseFolders"
  | "createWorkspace"
  | "botChats"
  // Panels that act on this Mac's filesystem, terminal, browser or screen.
  | "localPanels";

export type HostAvailability = "online" | "connecting" | "offline" | "blocked";

export interface HostChatStatus {
  availability: HostAvailability;
  blockedReason?: PeerBlockedReason;
  /** The supervisor generation; a response read under an older one is dropped. */
  generation: number;
}

export interface HostChatError {
  /**
   * A transport or host code. `fenced` means the response arrived after the
   * host's connection changed or the adapter was disposed, and was dropped.
   */
  code: string;
  message: string;
  status?: number;
  remoteCode?: string;
  retryable?: boolean;
}

export type HostChatResult<T> = { ok: true; value: T } | { ok: false; error: HostChatError };

export interface HostChatWindowRequest {
  /** Read the page that ends just before this message. */
  before?: string;
  limit?: number;
}

/** Live run frames for one chat. Calls stop once the returned unsubscribe runs. */
export interface HostChatObserver {
  /** The subscription's buffered events, delivered before any live frame. */
  onSubscription(subscription: PeerRunSubscription): void;
  onEvent(event: PeerRunEvent): void;
  onState(state: PeerRunStreamState): void;
  onError?(error: HostChatError): void;
}

export interface HostChatSendInput {
  text: string;
  /** Minted once per user intent and reused by a retry, so a lost acknowledgement never starts a second turn. */
  idempotencyKey: string;
  /** Uploads already staged on the chat's host for this turn. */
  attachmentIds?: string[];
  /** A skill from the host's own catalog. */
  skill?: SkillInvocationV1;
}

/** A file this Mac read, in the shape the host's attachment upload accepts. */
export type HostChatAttachmentUpload =
  | { name: string; mimeType: "image/png" | "image/jpeg"; kind: "image"; data: string }
  | { name: string; mimeType: string; kind: "text"; text: string };

/** An upload staged on the host, unused until a turn references it. */
export interface HostStagedAttachment {
  id: string;
  name: string;
  size: number;
}

export interface HostChatTurnReceipt {
  turnId: string;
  streamId: string;
}

export interface HostChatCancelInput {
  /** The run to stop (a local stream ID or a host run ID), wherever it was started. */
  runId: string;
  idempotencyKey?: string;
}

export interface HostChatApprovalInput {
  /** The run that raised the prompt. A paired host requires it. */
  runId?: string;
  approvalId: string;
  decision: "allow" | "deny";
  scope?: ToolApprovalScope;
  formFillExcludedOrders?: number[];
  /** Local only: the prompt belongs to a turn this Mac hosts for a paired phone. */
  source?: "remote";
  idempotencyKey?: string;
}

/** `elsewhere`: another device or the host's own screen answered first; `decision` is the winner's. */
export type HostChatApprovalResult =
  | { resolution: "applied" }
  | { resolution: "elsewhere"; decision?: "allow" | "deny" };

export interface HostChatQuestionInput {
  runId?: string;
  promptId: string;
  response: AskUserQuestionResponseV1;
  idempotencyKey?: string;
}

/** `elsewhere`: another responder answered first. `undefined`: the prompt was already gone locally. */
export interface HostChatQuestionResult {
  status: AskUserQuestionAnswerStatus | "elsewhere" | undefined;
}

export interface HostChatInput {
  runId: string;
  mode: ChatRunInputMode;
  text: string;
  idempotencyKey?: string;
}

export interface HostChatRenameInput {
  title: string;
  /** The host's chat revision; a paired host refuses a rename made against an older one. */
  revision?: string;
}

/**
 * Why a control call failed. `outcome_unknown` means the request may or may
 * not have been applied: retry it with the same idempotency key, never a new
 * one.
 */
export class HostChatControlError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly remoteCode?: string;
  readonly retryable?: boolean;
  readonly details?: PeerOperationErrorDetails;
  readonly reconciled?: unknown;

  constructor(error: HostChatError & { details?: PeerOperationErrorDetails; reconciled?: unknown }) {
    super(error.message);
    this.name = "HostChatControlError";
    this.code = error.code;
    if (error.status !== undefined) this.status = error.status;
    if (error.remoteCode !== undefined) this.remoteCode = error.remoteCode;
    if (error.retryable !== undefined) this.retryable = error.retryable;
    if (error.details !== undefined) this.details = error.details;
    if (error.reconciled !== undefined) this.reconciled = error.reconciled;
  }
}

export function isOutcomeUnknown(error: unknown): error is HostChatControlError {
  return error instanceof HostChatControlError && error.code === "outcome_unknown";
}

export interface HostChatAdapter {
  readonly hostId: string;
  capabilities(): ReadonlySet<HostChatCapability>;
  /** Settles once the first status is known, so reads start under a real generation. */
  ready(): Promise<void>;
  status(): HostChatStatus;
  onStatus(listener: (status: HostChatStatus) => void): () => void;
  getMessagesWindow(chatId: string, request?: HostChatWindowRequest): Promise<HostChatResult<RemoteMessagesWindow>>;
  /** Follows the chat's current run, wherever it was started. */
  observe(chatId: string, observer: HostChatObserver): () => void;
  markRead(chatId: string, throughMessageId?: string): Promise<HostChatResult<void>>;
  /** Starts a new turn. Local chats stream through the pane's own generation instead. */
  send(chatId: string, input: HostChatSendInput): Promise<HostChatTurnReceipt>;
  /** Stops a run. Resolves false when there was nothing left to stop. */
  cancel(chatId: string, input: HostChatCancelInput): Promise<boolean>;
  respondApproval(chatId: string, input: HostChatApprovalInput): Promise<HostChatApprovalResult>;
  answerQuestion(chatId: string, input: HostChatQuestionInput): Promise<HostChatQuestionResult>;
  /** Steers the running turn, or queues a follow-up behind it. */
  submitInput(chatId: string, input: HostChatInput): Promise<ChatRunInputAdmissionResult>;
  rename(chatId: string, input: HostChatRenameInput): Promise<void>;
  remove(chatId: string, input?: { revision?: string }): Promise<void>;
  /** Stages one attachment on the chat's host. Adapters without staged uploads omit it. */
  uploadAttachment?(chatId: string, upload: HostChatAttachmentUpload): Promise<HostStagedAttachment>;
  /** Drops a staged attachment no turn will use. */
  removeAttachment?(chatId: string, attachmentId: string): Promise<void>;
  dispose(): void;
}

export const FENCED_ERROR: HostChatError = {
  code: "fenced",
  message: "The host connection changed before this response arrived.",
};
