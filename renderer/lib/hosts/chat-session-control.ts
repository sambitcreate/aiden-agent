import type { ChatRunInputAdmissionResult, ChatRunInputMode } from "../../shared/chat-run-input";
import { mintPeerIdempotencyKey } from "../../shared/peer-host";
import {
  HostChatControlError,
  isOutcomeUnknown,
  type HostChatAdapter,
  type HostChatApprovalInput,
  type HostChatApprovalResult,
  type HostChatCapability,
  type HostChatQuestionInput,
  type HostChatQuestionResult,
  type HostChatStatus,
  type HostChatTurnReceipt,
} from "./host-chat-adapter";

/** The chat a session is bound to, fixed for the session's lifetime. */
export interface ChatSessionRef {
  hostId: string;
  chatId: string;
}

export type ChatSessionIntentKind = "send" | "cancel" | "respondApproval" | "answerQuestion" | "submitInput" | "rename" | "remove";

/** A mutation whose outcome is unknown: the host may or may not have applied it. */
export interface ChatSessionUnresolved {
  kind: ChatSessionIntentKind;
  /** The idempotency key a retry reuses, so the host can return the original result. */
  idempotencyKey: string;
  /** For a send: the text that may not have been sent. */
  text?: string;
  message: string;
  retrying: boolean;
}

/** A prompt another device or the host's own screen answered first. */
export interface ChatSessionElsewhereNotice {
  kind: "approval" | "question";
  id: string;
  decision?: "allow" | "deny";
}

export interface ChatSessionSnapshot {
  ref: ChatSessionRef;
  status: HostChatStatus;
  sending: boolean;
  stopping: boolean;
  /** The approval being answered, if any; one at a time. */
  decidingApprovalId: string | null;
  answeringQuestionId: string | null;
  unresolved: ChatSessionUnresolved | null;
  elsewhere: ChatSessionElsewhereNotice | null;
}

const ACTION_LABEL: Record<ChatSessionIntentKind, string> = {
  send: "Your message may not have been sent.",
  cancel: "The stop request may not have reached this Mac.",
  respondApproval: "Your approval decision may not have reached this Mac.",
  answerQuestion: "Your answer may not have reached this Mac.",
  submitInput: "Your guidance may not have reached this Mac.",
  rename: "The rename may not have been applied.",
  remove: "The chat may not have been deleted.",
};

const OFFLINE_REASON: Record<"connecting" | "offline" | "blocked", string> = {
  connecting: "Connecting to this Mac…",
  offline: "This Mac is offline. Nothing is sent until it is back online.",
  blocked: "This Mac needs attention in Settings before it can be controlled.",
};

const UNSUPPORTED_REASON: Partial<Record<HostChatCapability, string>> = {
  send: "This Mac doesn't allow sending from here.",
  cancel: "This Mac doesn't allow stopping runs from here.",
  respondApproval: "Answer this approval on the other Mac. It doesn't allow approvals from here.",
  answerQuestion: "Answer this question on the other Mac. It doesn't allow answers from here.",
  steer: "This Mac doesn't allow steering from here.",
  rename: "This Mac doesn't allow renaming from here.",
  remove: "This Mac doesn't allow deleting from here.",
};

/**
 * Why `capability` is unavailable on this adapter right now, or null when it
 * can run. Unsupported actions are refused rather than falling back to this
 * Mac; an offline or blocked host refuses every mutation.
 */
export function chatControlRefusal(adapter: HostChatAdapter, capability: HostChatCapability): string | null {
  if (!adapter.capabilities().has(capability)) return UNSUPPORTED_REASON[capability] ?? "Not available for this chat.";
  const { availability } = adapter.status();
  return availability === "online" ? null : OFFLINE_REASON[availability];
}

/**
 * Framework-free control for one chat on one host. The adapter and chat are
 * fixed at construction, so every operation is bound to the host and chat it
 * started on: closing the session (switching chats) never retargets in-flight
 * work, it only stops late answers from updating this session's state.
 */
export class ChatSessionControl {
  readonly adapter: HostChatAdapter;
  readonly ref: ChatSessionRef;
  private snapshot: ChatSessionSnapshot;
  private readonly listeners = new Set<() => void>();
  private offStatus: (() => void) | null = null;
  private attached = false;
  /** Replays the unresolved intent with its original key. */
  private replay: ((key: string) => Promise<unknown>) | null = null;

  constructor(adapter: HostChatAdapter, ref: ChatSessionRef) {
    if (adapter.hostId !== ref.hostId) throw new Error("The adapter belongs to another host.");
    this.adapter = adapter;
    this.ref = ref;
    this.snapshot = {
      ref,
      status: adapter.status(),
      sending: false,
      stopping: false,
      decidingApprovalId: null,
      answeringQuestionId: null,
      unresolved: null,
      elsewhere: null,
    };
  }

  /**
   * Starts applying results and host status to this session; the returned
   * function detaches it again. While detached (the pane moved to another
   * chat), in-flight work still finishes on its own host and chat, but its
   * results no longer change this session's state.
   */
  attach(): () => void {
    if (!this.attached) {
      this.attached = true;
      this.offStatus = this.adapter.onStatus((status) => this.update({ status }));
      this.update({ status: this.adapter.status() });
    }
    return () => this.detach();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getSnapshot(): ChatSessionSnapshot {
    return this.snapshot;
  }

  /** False once the pane moved on; results from a detached session are not applied to any pane. */
  get isAttached(): boolean {
    return this.attached;
  }

  refusal(capability: HostChatCapability): string | null {
    return chatControlRefusal(this.adapter, capability);
  }

  private detach(): void {
    if (!this.attached) return;
    this.attached = false;
    this.offStatus?.();
    this.offStatus = null;
  }

  private update(patch: Partial<ChatSessionSnapshot>): void {
    if (!this.attached) return;
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of [...this.listeners]) listener();
  }

  private guard(capability: HostChatCapability): void {
    const reason = this.refusal(capability);
    if (reason) throw new HostChatControlError({ code: this.adapter.capabilities().has(capability) ? "host_unavailable" : "unsupported", message: reason });
  }

  /**
   * Runs one keyed intent. An unknown outcome keeps the intent and its key so
   * the user can retry it safely; nothing is resent automatically.
   */
  private async intent<T>(
    kind: ChatSessionIntentKind,
    key: string,
    run: (key: string) => Promise<T>,
    text?: string,
  ): Promise<T> {
    try {
      return await run(key);
    } catch (error) {
      if (isOutcomeUnknown(error)) {
        this.replay = run;
        this.update({
          unresolved: { kind, idempotencyKey: key, ...(text !== undefined ? { text } : {}), message: ACTION_LABEL[kind], retrying: false },
        });
      }
      throw error;
    }
  }

  /** Starts a turn with a fresh key. Throws `outcome_unknown` when the host's answer was lost. */
  async send(text: string): Promise<HostChatTurnReceipt> {
    this.guard("send");
    if (this.snapshot.unresolved) {
      throw new HostChatControlError({ code: "unresolved", message: "Retry or dismiss the message that may not have been sent first." });
    }
    const { chatId } = this.ref;
    this.update({ sending: true });
    try {
      return await this.intent("send", mintPeerIdempotencyKey(), (idempotencyKey) => this.adapter.send(chatId, { text, idempotencyKey }), text);
    } finally {
      this.update({ sending: false });
    }
  }

  /** Retries the unresolved intent with its original key, so it is applied at most once. */
  async retryUnresolved(): Promise<void> {
    const unresolved = this.snapshot.unresolved;
    const replay = this.replay;
    if (!unresolved || !replay || unresolved.retrying) return;
    this.guard(unresolved.kind === "submitInput" ? "steer" : unresolved.kind);
    this.update({ unresolved: { ...unresolved, retrying: true } });
    try {
      await replay(unresolved.idempotencyKey);
      this.replay = null;
      this.update({ unresolved: null });
    } catch (error) {
      // Still unknown: keep the same key for the next retry.
      this.update({ unresolved: { ...unresolved, retrying: false } });
      if (!isOutcomeUnknown(error)) {
        this.replay = null;
        this.update({ unresolved: null });
      }
      throw error;
    }
  }

  /** Forgets the unresolved intent without resending it. */
  dismissUnresolved(): ChatSessionUnresolved | null {
    const unresolved = this.snapshot.unresolved;
    this.replay = null;
    this.update({ unresolved: null });
    return unresolved;
  }

  async cancel(runId: string): Promise<boolean> {
    this.guard("cancel");
    if (this.snapshot.stopping) return false;
    const { chatId } = this.ref;
    this.update({ stopping: true });
    try {
      return await this.intent("cancel", mintPeerIdempotencyKey(), (idempotencyKey) =>
        this.adapter.cancel(chatId, { runId, idempotencyKey }),
      );
    } finally {
      this.update({ stopping: false });
    }
  }

  /** Answers one approval at a time. Resolves null while another decision is in flight. */
  async respondApproval(input: Omit<HostChatApprovalInput, "idempotencyKey">): Promise<HostChatApprovalResult | null> {
    this.guard("respondApproval");
    if (this.snapshot.decidingApprovalId) return null;
    const { chatId } = this.ref;
    this.update({ decidingApprovalId: input.approvalId });
    try {
      const result = await this.intent("respondApproval", mintPeerIdempotencyKey(), (idempotencyKey) =>
        this.adapter.respondApproval(chatId, { ...input, idempotencyKey }),
      );
      if (result.resolution === "elsewhere") {
        this.update({
          elsewhere: { kind: "approval", id: input.approvalId, ...(result.decision ? { decision: result.decision } : {}) },
        });
      }
      return result;
    } finally {
      this.update({ decidingApprovalId: null });
    }
  }

  async answerQuestion(input: Omit<HostChatQuestionInput, "idempotencyKey">): Promise<HostChatQuestionResult | null> {
    this.guard("answerQuestion");
    if (this.snapshot.answeringQuestionId) return null;
    const { chatId } = this.ref;
    this.update({ answeringQuestionId: input.promptId });
    try {
      const result = await this.intent("answerQuestion", mintPeerIdempotencyKey(), (idempotencyKey) =>
        this.adapter.answerQuestion(chatId, { ...input, idempotencyKey }),
      );
      if (result.status === "elsewhere") this.update({ elsewhere: { kind: "question", id: input.promptId } });
      return result;
    } finally {
      this.update({ answeringQuestionId: null });
    }
  }

  async submitInput(runId: string, mode: ChatRunInputMode, text: string): Promise<ChatRunInputAdmissionResult> {
    this.guard("steer");
    const { chatId } = this.ref;
    return this.intent(
      "submitInput",
      mintPeerIdempotencyKey(),
      (idempotencyKey) => this.adapter.submitInput(chatId, { runId, mode, text, idempotencyKey }),
      text,
    );
  }

  async rename(title: string, revision?: string): Promise<void> {
    this.guard("rename");
    return this.adapter.rename(this.ref.chatId, { title, ...(revision ? { revision } : {}) });
  }

  async remove(revision?: string): Promise<void> {
    this.guard("remove");
    return this.adapter.remove(this.ref.chatId, revision ? { revision } : {});
  }

  dismissElsewhere(): void {
    this.update({ elsewhere: null });
  }
}
