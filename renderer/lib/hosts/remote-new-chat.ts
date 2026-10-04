import { mintPeerIdempotencyKey } from "../../shared/peer-host";
import { chatControlRefusal, releaseAttachments, stageAttachments } from "./chat-session-control";
import {
  HostChatControlError,
  isOutcomeUnknown,
  type HostChatAdapter,
  type HostChatAttachmentUpload,
  type HostChatCapability,
  type HostChatStatus,
  type HostChatTurnReceipt,
} from "./host-chat-adapter";
import type {
  HostCreatedChat,
  HostCreatedWorkspace,
  HostNewChatInput,
  HostWorkspaceCreate,
} from "./host-resources";

/** What starting new work on a paired host needs from its adapter. */
export interface RemoteNewChatHost
  extends Pick<HostChatAdapter, "hostId" | "capabilities" | "status" | "onStatus" | "send" | "uploadAttachment" | "removeAttachment"> {
  createChat(input: HostNewChatInput, idempotencyKey: string): Promise<HostCreatedChat>;
  createWorkspace(body: HostWorkspaceCreate, idempotencyKey: string): Promise<HostCreatedWorkspace>;
  createBotChat(botId: string, idempotencyKey: string): Promise<HostCreatedChat>;
}

/** The first message of a chat the host created, whose turn may or may not have started. */
export interface RemoteNewChatUnresolved {
  chatId: string;
  text: string;
  message: string;
  retrying: boolean;
}

export interface RemoteNewChatSnapshot {
  status: HostChatStatus;
  starting: boolean;
  unresolved: RemoteNewChatUnresolved | null;
}

export interface RemoteNewChatStarted {
  chatId: string;
  receipt: HostChatTurnReceipt;
}

interface PendingChat {
  /** The project and model the chat was asked for; a different target needs a different chat. */
  signature: string;
  key: string;
  /** Set once the host created the chat. */
  chatId?: string;
}

function targetSignature(target: HostNewChatInput): string {
  return JSON.stringify([target.workspaceId, target.model?.providerId ?? null, target.model?.modelId ?? null]);
}

/**
 * Starts new work on one paired host: a project, a chat with its first
 * message, or a Bot's chat. Every step runs on that host through its adapter;
 * nothing falls back to this Mac.
 *
 * A new chat takes three steps, each safe to repeat: create the chat (keyed),
 * stage its attachments (unkeyed; unused uploads expire on the host), and
 * start the first turn (keyed). A lost answer to the create is safe to resend:
 * the next attempt for the same project and model reuses its key, so the host
 * returns the chat it already made. A lost answer to the first turn is held as
 * unresolved, and a retry replays the same key with the same uploads.
 */
export class RemoteNewChatControl {
  readonly host: RemoteNewChatHost;
  private snapshot: RemoteNewChatSnapshot;
  private readonly listeners = new Set<() => void>();
  private offStatus: (() => void) | null = null;
  private pending: PendingChat | null = null;
  private replay: { signature: string; run: () => Promise<HostChatTurnReceipt> } | null = null;
  /** One key per project or Bot intent until the host gives a definite answer. */
  private readonly intentKeys = new Map<string, string>();

  constructor(host: RemoteNewChatHost) {
    this.host = host;
    this.snapshot = { status: host.status(), starting: false, unresolved: null };
  }

  attach(): () => void {
    if (!this.offStatus) {
      this.offStatus = this.host.onStatus((status) => this.update({ status }));
      this.update({ status: this.host.status() });
    }
    return () => {
      this.offStatus?.();
      this.offStatus = null;
    };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getSnapshot(): RemoteNewChatSnapshot {
    return this.snapshot;
  }

  refusal(capability: HostChatCapability): string | null {
    return chatControlRefusal(this.host, capability);
  }

  private update(patch: Partial<RemoteNewChatSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of [...this.listeners]) listener();
  }

  private guard(capability: HostChatCapability): void {
    const reason = this.refusal(capability);
    if (reason) {
      throw new HostChatControlError({
        code: this.host.capabilities().has(capability) ? "host_unavailable" : "unsupported",
        message: reason,
      });
    }
  }

  /** Runs a keyed intent, keeping its key while the host's answer is unknown. */
  private async keyed<T>(intent: string, run: (key: string) => Promise<T>): Promise<T> {
    let key = this.intentKeys.get(intent);
    if (!key) {
      key = mintPeerIdempotencyKey();
      this.intentKeys.set(intent, key);
    }
    try {
      const value = await run(key);
      this.intentKeys.delete(intent);
      return value;
    } catch (error) {
      if (!isOutcomeUnknown(error)) this.intentKeys.delete(intent);
      throw error;
    }
  }

  /**
   * Creates the chat in `target` on the host and starts its first turn. A
   * definite failure rejects with the draft intact; the chat, once created,
   * is reused by the next attempt for the same project and model.
   */
  async start(target: HostNewChatInput, text: string, uploads: readonly HostChatAttachmentUpload[] = []): Promise<RemoteNewChatStarted> {
    this.guard("createChat");
    this.guard("send");
    if (uploads.length > 0) this.guard("attach");
    if (this.snapshot.unresolved) {
      throw new HostChatControlError({ code: "unresolved", message: "Retry or dismiss the message that may not have been sent first." });
    }
    if (this.snapshot.starting) throw new HostChatControlError({ code: "busy", message: "Your new chat is still starting." });
    const signature = targetSignature(target);
    if (!this.pending || this.pending.signature !== signature) {
      this.pending = { signature, key: mintPeerIdempotencyKey() };
    }
    const pending = this.pending;
    this.update({ starting: true });
    try {
      if (!pending.chatId) {
        try {
          pending.chatId = (await this.host.createChat(target, pending.key)).id;
        } catch (error) {
          if (!isOutcomeUnknown(error)) {
            if (this.pending === pending) this.pending = null;
            throw error;
          }
          // The key stays with this target, so sending again cannot create a second chat.
          throw new HostChatControlError({
            code: "create_unconfirmed",
            message: "That Mac didn't confirm the new chat. Send again to continue; it won't create a second one.",
            retryable: true,
          });
        }
      }
      const chatId = pending.chatId;
      const attachmentIds = await stageAttachments(this.host, chatId, uploads);
      const sendKey = mintPeerIdempotencyKey();
      const run = () =>
        this.host.send(chatId, {
          text,
          idempotencyKey: sendKey,
          ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
        });
      try {
        const receipt = await run();
        if (this.pending === pending) this.pending = null;
        return { chatId, receipt };
      } catch (error) {
        if (isOutcomeUnknown(error)) {
          if (this.pending === pending) this.pending = null;
          this.replay = { signature, run };
          this.update({
            unresolved: { chatId, text, message: "Your first message may not have been sent.", retrying: false },
          });
        } else {
          releaseAttachments(this.host, chatId, attachmentIds);
        }
        throw error;
      }
    } finally {
      this.update({ starting: false });
    }
  }

  /** Replays the unresolved first message with its original key; resolves with the chat it belongs to. */
  async retryUnresolved(): Promise<string> {
    const unresolved = this.snapshot.unresolved;
    const replay = this.replay;
    if (!unresolved || !replay || unresolved.retrying) throw new HostChatControlError({ code: "invalid", message: "Nothing is waiting to be retried." });
    this.guard("send");
    this.update({ unresolved: { ...unresolved, retrying: true } });
    try {
      await replay.run();
      this.replay = null;
      this.update({ unresolved: null });
      return unresolved.chatId;
    } catch (error) {
      if (isOutcomeUnknown(error)) {
        this.update({ unresolved: { ...unresolved, retrying: false } });
      } else {
        // The host refused the turn: the empty chat stays and the next send reuses it.
        this.replay = null;
        this.pending = { signature: replay.signature, key: mintPeerIdempotencyKey(), chatId: unresolved.chatId };
        this.update({ unresolved: null });
      }
      throw error;
    }
  }

  /** Forgets the unresolved first message without resending it. */
  dismissUnresolved(): RemoteNewChatUnresolved | null {
    const unresolved = this.snapshot.unresolved;
    this.replay = null;
    this.update({ unresolved: null });
    return unresolved;
  }

  /** Creates a project on the host. Retrying the same request after a lost answer reuses its key. */
  async createWorkspace(body: HostWorkspaceCreate): Promise<HostCreatedWorkspace> {
    this.guard("createWorkspace");
    return this.keyed(`workspace:${JSON.stringify(body)}`, (key) => this.host.createWorkspace(body, key));
  }

  /** Opens a Bot's chat on the host, which returns the Bot's existing chat when it has one. */
  async openBotChat(botId: string): Promise<string> {
    this.guard("botChats");
    const chat = await this.keyed(`bot:${botId}`, (key) => this.host.createBotChat(botId, key));
    return chat.id;
  }
}
