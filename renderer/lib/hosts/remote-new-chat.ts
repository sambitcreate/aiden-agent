import { mintPeerIdempotencyKey } from "../../shared/peer-host";
import { chatIntentLedger, type ChatIntent, type ChatIntentLedger, type ChatIntentRef } from "./chat-intent-ledger";
import { chatControlRefusal, releaseAttachments, stageAttachments } from "./chat-session-control";
import {
  HostChatControlError,
  isOutcomeUnknown,
  type HostChatAdapter,
  type HostChatAttachmentUpload,
  type HostChatCapability,
  type HostChatSendInput,
  type HostChatStatus,
  type HostChatTurnReceipt,
} from "./host-chat-adapter";
import type {
  HostCreatedChat,
  HostCreatedWorkspace,
  HostFolderSelection,
  HostNewChatInput,
  HostWorkspaceCreate,
} from "./host-resources";

/** What starting new work on a paired host needs from its adapter. */
export interface RemoteNewChatHost
  extends Pick<HostChatAdapter, "hostId" | "capabilities" | "status" | "onStatus" | "send" | "uploadAttachment" | "removeAttachment"> {
  createChat(input: HostNewChatInput, idempotencyKey: string): Promise<HostCreatedChat>;
  createWorkspace(body: HostWorkspaceCreate, idempotencyKey: string): Promise<HostCreatedWorkspace>;
  createBotChat(botId: string, idempotencyKey: string): Promise<HostCreatedChat>;
  selectFolder(location: string): Promise<HostFolderSelection>;
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

/** A keyed project or Bot request whose answer is not known yet. */
interface PendingIntent {
  key: string;
  /** The exact request, replayed as-is: a folder selection is single-use, so it is never re-minted for a retry. */
  body?: HostWorkspaceCreate;
}

/** A first turn whose outcome is unknown. The turn itself lives in the chat intent ledger. */
interface FirstTurn {
  chatId: string;
  key: string;
  signature: string;
}

interface HostNewChatState {
  pending: PendingChat | null;
  firstTurn: FirstTurn | null;
  intents: Map<string, PendingIntent>;
}

/**
 * What starting new work on each host keeps for this window: the key of a
 * chat or project whose create answer was lost, and the chat whose first
 * turn is unresolved. It outlives the route and adapter that started the
 * work, so leaving the page or a grants change cannot make a retry mint a
 * new key and create a second chat or project.
 */
export class RemoteNewChatMemory {
  private readonly hosts = new Map<string, HostNewChatState>();
  private readonly listeners = new Map<string, Set<() => void>>();

  state(hostId: string): HostNewChatState {
    let state = this.hosts.get(hostId);
    if (!state) {
      state = { pending: null, firstTurn: null, intents: new Map() };
      this.hosts.set(hostId, state);
    }
    return state;
  }

  setFirstTurn(hostId: string, firstTurn: FirstTurn | null): void {
    const state = this.state(hostId);
    if (state.firstTurn === firstTurn) return;
    state.firstTurn = firstTurn;
    for (const listener of [...(this.listeners.get(hostId) ?? [])]) listener();
  }

  subscribe(hostId: string, listener: () => void): () => void {
    const set = this.listeners.get(hostId) ?? new Set();
    set.add(listener);
    this.listeners.set(hostId, set);
    return () => {
      set.delete(listener);
      if (set.size === 0 && this.listeners.get(hostId) === set) this.listeners.delete(hostId);
    };
  }
}

/** This window's new-chat memory, shared by every new-chat route it opens. */
export const remoteNewChatMemory = new RemoteNewChatMemory();

function targetSignature(target: HostNewChatInput): string {
  return JSON.stringify([target.workspaceId, target.model?.providerId ?? null, target.model?.modelId ?? null]);
}

function firstTurnInput(text: string, idempotencyKey: string, attachmentIds: readonly string[]): HostChatSendInput {
  return { text, idempotencyKey, ...(attachmentIds.length > 0 ? { attachmentIds: [...attachmentIds] } : {}) };
}

const FIRST_TURN_MESSAGE = "Your first message may not have been sent.";

/**
 * Starts new work on one paired host: a project, a chat with its first
 * message, or a Bot's chat. Every step runs on that host through its adapter;
 * nothing falls back to this Mac.
 *
 * A new chat takes three steps, each safe to repeat: create the chat (keyed),
 * stage its attachments (unkeyed; unused uploads expire on the host), and
 * start the first turn (keyed). A lost answer to the create is safe to resend:
 * the next attempt for the same project and model reuses its key, so the host
 * returns the chat it already made. A lost answer to the first turn is
 * recorded in the window's chat intent ledger, so this route or the opened
 * chat can retry it with the same key and uploads, even after navigation.
 */
export class RemoteNewChatControl {
  readonly host: RemoteNewChatHost;
  private readonly ledger: ChatIntentLedger;
  private readonly memory: RemoteNewChatMemory;
  private readonly state: HostNewChatState;
  private snapshot: RemoteNewChatSnapshot;
  private readonly listeners = new Set<() => void>();
  private offStatus: (() => void) | null = null;
  private offMemory: (() => void) | null = null;
  private offLedger: (() => void) | null = null;

  constructor(
    host: RemoteNewChatHost,
    { ledger = chatIntentLedger, memory = remoteNewChatMemory }: { ledger?: ChatIntentLedger; memory?: RemoteNewChatMemory } = {},
  ) {
    this.host = host;
    this.ledger = ledger;
    this.memory = memory;
    this.state = memory.state(host.hostId);
    this.snapshot = { status: host.status(), starting: false, unresolved: this.firstTurn() };
  }

  attach(): () => void {
    if (!this.offStatus) {
      this.offStatus = this.host.onStatus((status) => this.update({ status }));
      this.offMemory = this.memory.subscribe(this.host.hostId, () => this.follow());
      this.follow();
      this.update({ status: this.host.status() });
    }
    return () => {
      this.offStatus?.();
      this.offStatus = null;
      this.offMemory?.();
      this.offMemory = null;
      this.offLedger?.();
      this.offLedger = null;
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

  private ref(chatId: string): ChatIntentRef {
    return { hostId: this.host.hostId, chatId };
  }

  /** The unresolved first turn, read from the ledger; null once it was retried or dismissed anywhere. */
  private firstTurn(): RemoteNewChatUnresolved | null {
    const turn = this.state.firstTurn;
    if (!turn) return null;
    const recorded = this.ledger.unresolved(this.ref(turn.chatId));
    if (!recorded || recorded.intent.idempotencyKey !== turn.key) return null;
    return { chatId: turn.chatId, text: recorded.intent.text ?? "", message: FIRST_TURN_MESSAGE, retrying: recorded.retrying };
  }

  /** Follows the ledger entry of the current unresolved first turn, if any. */
  private follow(): void {
    this.offLedger?.();
    this.offLedger = null;
    const turn = this.state.firstTurn;
    if (turn) this.offLedger = this.ledger.subscribe(this.ref(turn.chatId), () => this.refresh());
    this.refresh();
  }

  private refresh(): void {
    const unresolved = this.firstTurn();
    // Retried or dismissed from the chat itself: nothing is pending here any more.
    if (!unresolved && this.state.firstTurn) this.memory.setFirstTurn(this.host.hostId, null);
    this.update({ unresolved });
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

  /** Runs a keyed intent, keeping its key (and request) while the host's answer is unknown. */
  private async keyed<T>(intent: string, run: (pending: PendingIntent) => Promise<T>, body?: () => Promise<HostWorkspaceCreate>): Promise<T> {
    let pending = this.state.intents.get(intent);
    if (!pending) {
      pending = { key: mintPeerIdempotencyKey(), ...(body ? { body: await body() } : {}) };
      this.state.intents.set(intent, pending);
    }
    try {
      const value = await run(pending);
      if (this.state.intents.get(intent) === pending) this.state.intents.delete(intent);
      return value;
    } catch (error) {
      if (!isOutcomeUnknown(error) && this.state.intents.get(intent) === pending) this.state.intents.delete(intent);
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
    if (this.firstTurn()) {
      throw new HostChatControlError({ code: "unresolved", message: "Retry or dismiss the message that may not have been sent first." });
    }
    if (this.snapshot.starting) throw new HostChatControlError({ code: "busy", message: "Your new chat is still starting." });
    const signature = targetSignature(target);
    if (!this.state.pending || this.state.pending.signature !== signature) {
      this.state.pending = { signature, key: mintPeerIdempotencyKey() };
    }
    const pending = this.state.pending;
    const settle = () => {
      if (this.state.pending === pending) this.state.pending = null;
    };
    this.update({ starting: true });
    try {
      if (!pending.chatId) {
        try {
          pending.chatId = (await this.host.createChat(target, pending.key)).id;
        } catch (error) {
          if (!isOutcomeUnknown(error)) {
            settle();
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
      const ref = this.ref(chatId);
      const attachmentIds = await stageAttachments(this.host, chatId, uploads);
      const key = mintPeerIdempotencyKey();
      // The turn is recorded in the window's ledger, so the opened chat can retry it with this key.
      const intent: ChatIntent = {
        kind: "send",
        idempotencyKey: key,
        text,
        ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
        replay: (adapter, idempotencyKey) => adapter.send(chatId, firstTurnInput(text, idempotencyKey, attachmentIds)),
      };
      this.ledger.begin(ref, intent);
      try {
        const receipt = await this.host.send(chatId, firstTurnInput(text, key, attachmentIds));
        this.ledger.settle(ref, key, "known");
        settle();
        return { chatId, receipt };
      } catch (error) {
        if (isOutcomeUnknown(error)) {
          this.ledger.settle(ref, key, "unknown");
          settle();
          this.memory.setFirstTurn(this.host.hostId, { chatId, key, signature });
        } else {
          this.ledger.settle(ref, key, "known");
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
    const turn = this.state.firstTurn;
    const recorded = turn ? this.ledger.unresolved(this.ref(turn.chatId)) : null;
    if (!turn || !recorded || recorded.intent.idempotencyKey !== turn.key || recorded.retrying) {
      throw new HostChatControlError({ code: "invalid", message: "Nothing is waiting to be retried." });
    }
    this.guard("send");
    const ref = this.ref(turn.chatId);
    const { intent } = recorded;
    this.ledger.retrying(ref, turn.key, true);
    try {
      await this.host.send(turn.chatId, firstTurnInput(intent.text ?? "", turn.key, intent.attachmentIds ?? []));
      this.ledger.resolve(ref, turn.key);
      return turn.chatId;
    } catch (error) {
      if (isOutcomeUnknown(error)) {
        this.ledger.retrying(ref, turn.key, false);
      } else {
        // The host refused the turn: it never used the uploads, and the empty chat is reused by the next send.
        this.ledger.resolve(ref, turn.key);
        releaseAttachments(this.host, turn.chatId, intent.attachmentIds ?? []);
        this.state.pending = { signature: turn.signature, key: mintPeerIdempotencyKey(), chatId: turn.chatId };
      }
      throw error;
    }
  }

  /**
   * Forgets the unresolved first message without resending it, releasing its
   * uploads (a no-op if the host did start that turn and used them).
   */
  dismissUnresolved(): RemoteNewChatUnresolved | null {
    const unresolved = this.firstTurn();
    const turn = this.state.firstTurn;
    if (!unresolved || !turn) return null;
    const ref = this.ref(turn.chatId);
    const recorded = this.ledger.unresolved(ref);
    this.ledger.resolve(ref, turn.key);
    releaseAttachments(this.host, turn.chatId, recorded?.intent.attachmentIds ?? []);
    return unresolved;
  }

  /** Creates a project on the host. Retrying the same request after a lost answer reuses its key. */
  async createWorkspace(body: HostWorkspaceCreate): Promise<HostCreatedWorkspace> {
    this.guard("createWorkspace");
    return this.keyed(`workspace:${JSON.stringify(body)}`, ({ key }) => this.host.createWorkspace(body, key));
  }

  /**
   * Makes a browsed folder a project on the host. The folder's selection is
   * minted just before it is spent, and only once per intent: after a lost
   * answer, choosing the same folder again replays the original request and
   * key, which the host answers from its record instead of refusing the
   * folder as already registered.
   */
  async createFolderWorkspace(location: string): Promise<HostCreatedWorkspace> {
    this.guard("createWorkspace");
    this.guard("browseFolders");
    return this.keyed(
      `folder:${location}`,
      ({ key, body }) => this.host.createWorkspace(body!, key),
      async () => ({ mode: "selected-folder", selection: (await this.host.selectFolder(location)).selection }),
    );
  }

  /** Opens a Bot's chat on the host, which returns the Bot's existing chat when it has one. */
  async openBotChat(botId: string): Promise<string> {
    this.guard("botChats");
    const chat = await this.keyed(`bot:${botId}`, ({ key }) => this.host.createBotChat(botId, key));
    return chat.id;
  }
}
