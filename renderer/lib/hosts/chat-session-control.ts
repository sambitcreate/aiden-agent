import type { ChatRunInputAdmissionResult, ChatRunInputMode } from "../../shared/chat-run-input";
import type { SkillInvocationV1 } from "../../shared/slash-commands";
import { mintPeerIdempotencyKey } from "../../shared/peer-host";
import { chatIntentLedger, type ChatIntent, type ChatIntentKind, type ChatIntentLedger } from "./chat-intent-ledger";
import {
  HostChatControlError,
  isOutcomeUnknown,
  type HostChatAdapter,
  type HostChatApprovalInput,
  type HostChatApprovalResult,
  type HostChatAttachmentUpload,
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
  cancel: "The stop request may not have reached that Mac.",
  respondApproval: "Your approval decision may not have reached that Mac.",
  answerQuestion: "Your answer may not have reached that Mac.",
  submitInput: "Your guidance may not have reached that Mac.",
  rename: "The rename may not have been applied.",
  remove: "The chat may not have been deleted.",
};

const OFFLINE_REASON: Record<"connecting" | "offline" | "blocked", string> = {
  connecting: "Connecting to that Mac…",
  offline: "That Mac is offline. Nothing is sent until it is back online.",
  blocked: "That Mac needs attention in Settings before it can be controlled.",
};

const UNSUPPORTED_REASON: Partial<Record<HostChatCapability, string>> = {
  send: "That Mac doesn't allow sending from here.",
  cancel: "That Mac doesn't allow stopping runs from here.",
  respondApproval: "Answer this approval on the other Mac. It doesn't allow approvals from here.",
  answerQuestion: "Answer this question on the other Mac. It doesn't allow answers from here.",
  steer: "That Mac doesn't allow steering from here.",
  rename: "That Mac doesn't allow renaming from here.",
  remove: "That Mac doesn't allow deleting from here.",
  attach: "That Mac doesn't accept attachments from here.",
  skills: "That Mac doesn't allow skills from here.",
  createChat: "That Mac doesn't allow new chats from here.",
  browseFolders: "That Mac doesn't allow browsing its folders from here.",
  createWorkspace: "That Mac doesn't allow new projects from here.",
  botChats: "That Mac doesn't allow Bot chats from here.",
};

/** What a turn carries besides its text. */
export interface ChatSendExtras {
  /** Files this Mac read, uploaded to the chat's host before the turn starts. */
  attachments?: HostChatAttachmentUpload[];
  /** A skill from the host's own catalog. */
  skill?: SkillInvocationV1;
}

/**
 * Uploads a turn's attachments to the chat's host, one at a time. When one
 * fails, the ones already staged are dropped again (best effort; unused
 * uploads also expire on the host) and the failure is rethrown as a plain,
 * retryable error: an upload is not keyed, so it is never left unresolved.
 */
export async function stageAttachments(
  adapter: Pick<HostChatAdapter, "uploadAttachment" | "removeAttachment">,
  chatId: string,
  uploads: readonly HostChatAttachmentUpload[],
): Promise<string[]> {
  if (uploads.length === 0) return [];
  if (!adapter.uploadAttachment) {
    throw new HostChatControlError({ code: "unsupported", message: UNSUPPORTED_REASON.attach! });
  }
  const staged: string[] = [];
  try {
    for (const upload of uploads) staged.push((await adapter.uploadAttachment(chatId, upload)).id);
    return staged;
  } catch (error) {
    releaseAttachments(adapter, chatId, staged);
    if (isOutcomeUnknown(error)) {
      throw new HostChatControlError({
        code: "upload_failed",
        message: "An attachment didn't reach that Mac. Nothing was sent; try again.",
        retryable: true,
      });
    }
    throw error;
  }
}

/** Drops staged uploads no turn will use. Failures are ignored: the host expires them anyway. */
export function releaseAttachments(adapter: Pick<HostChatAdapter, "removeAttachment">, chatId: string, ids: readonly string[]): void {
  for (const id of ids) void adapter.removeAttachment?.(chatId, id).catch(() => {});
}

/**
 * Why `capability` is unavailable on this adapter right now, or null when it
 * can run. Unsupported actions are refused rather than falling back to this
 * Mac; an offline or blocked host refuses every mutation.
 */
export function chatControlRefusal(adapter: Pick<HostChatAdapter, "capabilities" | "status">, capability: HostChatCapability): string | null {
  if (!adapter.capabilities().has(capability)) return UNSUPPORTED_REASON[capability] ?? "Not available for this chat.";
  const { availability } = adapter.status();
  return availability === "online" ? null : OFFLINE_REASON[availability];
}

/**
 * Framework-free control for one chat on one host. The adapter and chat are
 * fixed at construction, so every operation is bound to the host and chat it
 * started on: closing the session (switching chats) never retargets in-flight
 * work, it only stops late answers from updating this session's state.
 *
 * Keyed intents are recorded in a ledger that outlives the session, so an
 * unknown outcome (even one that lands after the pane moved on) is recovered
 * by the next session opened for the same chat, with its original key.
 */
export class ChatSessionControl {
  readonly adapter: HostChatAdapter;
  readonly ref: ChatSessionRef;
  private readonly ledger: ChatIntentLedger;
  private snapshot: ChatSessionSnapshot;
  private readonly listeners = new Set<() => void>();
  private offStatus: (() => void) | null = null;
  private offLedger: (() => void) | null = null;
  private attached = false;
  /** True while a send's attachments upload, before its keyed turn is recorded in the ledger. */
  private staging = false;

  constructor(adapter: HostChatAdapter, ref: ChatSessionRef, ledger: ChatIntentLedger = chatIntentLedger) {
    if (adapter.hostId !== ref.hostId) throw new Error("The adapter belongs to another host.");
    this.adapter = adapter;
    this.ref = ref;
    this.ledger = ledger;
    this.snapshot = {
      ref,
      status: adapter.status(),
      stopping: false,
      decidingApprovalId: null,
      answeringQuestionId: null,
      elsewhere: null,
      ...this.recorded(),
    };
  }

  /** The ledger's view of this chat: a send still in flight, and any unknown outcome. */
  private recorded(): Pick<ChatSessionSnapshot, "sending" | "unresolved"> {
    const unresolved = this.ledger.unresolved(this.ref);
    const sending = this.staging || this.ledger.sending(this.ref);
    if (!unresolved) return { sending, unresolved: null };
    const { intent, retrying } = unresolved;
    return {
      sending,
      unresolved: {
        kind: intent.kind,
        idempotencyKey: intent.idempotencyKey,
        ...(intent.text !== undefined ? { text: intent.text } : {}),
        message: ACTION_LABEL[intent.kind],
        retrying,
      },
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
      this.offLedger = this.ledger.subscribe(this.ref, () => this.update(this.recorded()));
      this.update({ status: this.adapter.status(), ...this.recorded() });
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
    this.offLedger?.();
    this.offLedger = null;
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
   * the user can retry it safely; nothing is resent automatically. The
   * outcome is recorded even if this session detached while it was in flight.
   */
  private async intent<T>(
    kind: ChatIntentKind,
    run: (adapter: HostChatAdapter, key: string) => Promise<T>,
    text?: string,
  ): Promise<T> {
    const key = mintPeerIdempotencyKey();
    const intent: ChatIntent = { kind, idempotencyKey: key, ...(text !== undefined ? { text } : {}), replay: run };
    this.ledger.begin(this.ref, intent);
    try {
      const result = await run(this.adapter, key);
      this.ledger.settle(this.ref, key, "known");
      return result;
    } catch (error) {
      this.ledger.settle(this.ref, key, isOutcomeUnknown(error) ? "unknown" : "known");
      throw error;
    }
  }

  /**
   * Starts a turn with a fresh key, after staging its attachments on the
   * host. Throws `outcome_unknown` when the host's answer was lost; a retry
   * then replays the same key with the same staged uploads.
   */
  async send(text: string, extras: ChatSendExtras = {}): Promise<HostChatTurnReceipt> {
    this.guard("send");
    const uploads = extras.attachments ?? [];
    if (uploads.length > 0) this.guard("attach");
    if (extras.skill) this.guard("skills");
    if (this.ledger.unresolved(this.ref)) {
      throw new HostChatControlError({ code: "unresolved", message: "Retry or dismiss the message that may not have been sent first." });
    }
    const { chatId } = this.ref;
    let attachmentIds: string[];
    this.staging = true;
    this.update(this.recorded());
    try {
      attachmentIds = await stageAttachments(this.adapter, chatId, uploads);
    } catch (error) {
      this.staging = false;
      this.update(this.recorded());
      throw error;
    }
    // `intent` records the send in the ledger synchronously, so `sending` stays true across the hand-off.
    this.staging = false;
    try {
      return await this.intent(
        "send",
        (adapter, idempotencyKey) =>
          adapter.send(chatId, {
            text,
            idempotencyKey,
            ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
            ...(extras.skill ? { skill: extras.skill } : {}),
          }),
        text,
      );
    } catch (error) {
      // A definite refusal leaves the uploads unused; an unknown outcome may have consumed them.
      if (!isOutcomeUnknown(error)) releaseAttachments(this.adapter, chatId, attachmentIds);
      throw error;
    }
  }

  /** Retries the unresolved intent with its original key, so it is applied at most once. */
  async retryUnresolved(): Promise<void> {
    const unresolved = this.ledger.unresolved(this.ref);
    if (!unresolved || unresolved.retrying) return;
    const { intent } = unresolved;
    this.guard(intent.kind === "submitInput" ? "steer" : intent.kind);
    this.ledger.retrying(this.ref, intent.idempotencyKey, true);
    try {
      await intent.replay(this.adapter, intent.idempotencyKey);
      this.ledger.resolve(this.ref, intent.idempotencyKey);
    } catch (error) {
      // Still unknown: keep the same key for the next retry.
      if (isOutcomeUnknown(error)) this.ledger.retrying(this.ref, intent.idempotencyKey, false);
      else this.ledger.resolve(this.ref, intent.idempotencyKey);
      throw error;
    }
  }

  /** Forgets the unresolved intent without resending it. */
  dismissUnresolved(): ChatSessionUnresolved | null {
    const unresolved = this.recorded().unresolved;
    if (unresolved) this.ledger.resolve(this.ref, unresolved.idempotencyKey);
    return unresolved;
  }

  async cancel(runId: string): Promise<boolean> {
    this.guard("cancel");
    if (this.snapshot.stopping) return false;
    const { chatId } = this.ref;
    this.update({ stopping: true });
    try {
      return await this.intent("cancel", (adapter, idempotencyKey) => adapter.cancel(chatId, { runId, idempotencyKey }));
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
      const result = await this.intent("respondApproval", (adapter, idempotencyKey) =>
        adapter.respondApproval(chatId, { ...input, idempotencyKey }),
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
      const result = await this.intent("answerQuestion", (adapter, idempotencyKey) =>
        adapter.answerQuestion(chatId, { ...input, idempotencyKey }),
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
      (adapter, idempotencyKey) => adapter.submitInput(chatId, { runId, mode, text, idempotencyKey }),
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
