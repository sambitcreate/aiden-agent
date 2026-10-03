import type {
  PeerBlockedReason,
  PeerRunEvent,
  PeerRunStreamState,
  PeerRunSubscription,
} from "../../shared/peer-host";
import type { RemoteMessagesWindow } from "./remote-chat-mapper";

/**
 * One machine's chats, as the chat view reads them. Every method is keyed by
 * chat ID so one adapter serves every chat on its host. PR 6 implements the
 * read side for paired hosts; PR 7 adds the control methods named in
 * `HostChatCapability` and a local adapter for this Mac.
 */

export type HostChatCapability =
  // Read side (PR 6).
  | "messagesWindow"
  | "observe"
  | "markRead"
  // Control side (PR 7).
  | "send"
  | "cancel"
  | "respondApproval"
  | "answerQuestion"
  | "steer"
  | "rename"
  | "remove"
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
  dispose(): void;
}

export const FENCED_ERROR: HostChatError = {
  code: "fenced",
  message: "The host connection changed before this response arrived.",
};
