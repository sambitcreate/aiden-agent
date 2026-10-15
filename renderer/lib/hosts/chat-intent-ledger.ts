import { peerHostsApi } from "../ipc";
import { chatIntentRetryAllowed, replayChatRequest, type SavedChatIntent, type SavedChatRequest } from "../../shared/chat-intent";
import type { HostChatAdapter } from "./host-chat-adapter";

/** The chat an intent belongs to. */
export interface ChatIntentRef {
  hostId: string;
  chatId: string;
}

export type ChatIntentKind = "send" | "cancel" | "respondApproval" | "answerQuestion" | "submitInput";

/**
 * One keyed mutation. `replay` takes the adapter to send it through, so a
 * retry made after navigation goes through the reopened chat's adapter with
 * the original key, never through a disposed one.
 */
export interface ChatIntent {
  kind: ChatIntentKind;
  idempotencyKey: string;
  /** For a send or guidance: the text that may not have arrived. */
  text?: string;
  /**
   * For a send: the uploads it was staged with. They are released when the
   * send is dismissed or definitely refused, so they never count against the
   * host's limit on unused uploads.
   */
  attachmentIds?: readonly string[];
  createdAt?: number;
  request?: SavedChatRequest;
  replay(adapter: HostChatAdapter, idempotencyKey: string): Promise<unknown>;
}

/**
 * A fork whose answer was lost: what it asked for and the key it was sent
 * under. Forks don't block the chat the way an unresolved intent does; the
 * key is only reused when the same fork is asked for again.
 */
export interface ChatForkIntent {
  /** The request the host fingerprints with the key: message, position, summary and revision. */
  signature: string;
  idempotencyKey: string;
  createdAt?: number;
  request?: SavedChatRequest;
  uncertain?: boolean;
}

export interface ChatIntentUnresolved {
  intent: ChatIntent;
  retrying: boolean;
}

interface PendingIntent {
  intent: ChatIntent;
  /** Resolves when the host's answer, or its loss, is recorded. */
  settled: Promise<void>;
  done(): void;
}

interface Entry {
  pending: Map<string, PendingIntent>;
  unresolved: ChatIntentUnresolved | null;
  fork: ChatForkIntent | null;
  waiting: ChatIntent[];
}

const refKey = ({ hostId, chatId }: ChatIntentRef) => `${hostId}\u0000${chatId}`;

/**
 * Keyed intents for every chat in this window, outliving the pane and adapter
 * that started them. An answer that arrives after the pane moved on still
 * records its outcome here, so reopening the chat recovers the unknown
 * outcome and its key instead of losing the text or resending under a new key.
 */
export interface ChatIntentPersistence {
  list(hostId: string, chatId: string): Promise<SavedChatIntent[]>;
  put(intent: SavedChatIntent): Promise<void>;
  remove(hostId: string, chatId: string, key: string): Promise<void>;
}
export class ChatIntentLedger {
  get durable(): boolean { return Boolean(this.persistence); }
  private readonly hydrated = new Set<string>();
  private readonly hydration = new Map<string, Promise<void>>();
  constructor(private readonly persistence?: ChatIntentPersistence, private readonly now: () => number = Date.now) {}
  isReady(ref: ChatIntentRef): boolean { return !this.persistence || ref.hostId === "local" || this.hydrated.has(refKey(ref)); }
  ready(ref: ChatIntentRef): Promise<void> {
    if (!this.persistence || ref.hostId === "local") return Promise.resolve();
    const key = refKey(ref);
    let loading = this.hydration.get(key);
    if (!loading) {
      loading = this.persistence.list(ref.hostId, ref.chatId).then(rows => {
        for (const row of rows) {
          if (row.hostId !== ref.hostId || row.chatId !== ref.chatId) continue;
          const request = row.request;
          if (request.kind === "fork") {
            if (this.entry(ref).fork && this.entry(ref).fork!.idempotencyKey !== row.idempotencyKey) throw new Error("Several saved forks need recovery on the host.");
            this.entry(ref).fork = { uncertain: true, signature: request.signature, idempotencyKey: row.idempotencyKey, createdAt: row.createdAt, request };
          } else {
            const intent: ChatIntent = { kind: request.kind, idempotencyKey: row.idempotencyKey, createdAt: row.createdAt, request,
              ...("text" in request.input ? { text: request.input.text } : {}),
              ...(request.kind === "send" ? { attachmentIds: request.input.attachmentIds } : {}),
              replay: adapter => replayChatRequest(adapter, ref.chatId, request, this.durable) };
            this.begin(ref, intent); this.settle(ref, intent.idempotencyKey, "unknown");
          }
        }
        this.hydrated.add(key);
        this.changed(ref);
      }).catch(error => { this.hydration.delete(key); throw error; });
      this.hydration.set(key, loading);
    }
    return loading;
  }
  async persist(ref: ChatIntentRef, intent: ChatIntent | ChatForkIntent): Promise<void> {
    intent.createdAt ??= this.now();
    if (this.persistence && ref.hostId !== "local") {
      if (!intent.request) throw new Error("The request could not be saved. Nothing was sent.");
      await this.persistence.put({ ...ref, idempotencyKey: intent.idempotencyKey, createdAt: intent.createdAt, request: intent.request });
    }
  }
  async validateRetry(ref: ChatIntentRef, intent: ChatIntent | ChatForkIntent): Promise<void> {
    if (this.persistence && ref.hostId !== "local") {
      const rows = await this.persistence.list(ref.hostId, ref.chatId);
      if (!rows.some(row => row.idempotencyKey === intent.idempotencyKey && row.createdAt === intent.createdAt
        && JSON.stringify(row.request) === JSON.stringify(intent.request))) {
        throw new Error("The saved request no longer belongs to this pairing. Check the host before dismissing it.");
      }
    }
    if (!this.retryAllowed(intent)) throw new Error("The safe retry window has ended. Check the host before dismissing this request.");
  }
  retryAllowed(intent: ChatIntent | ChatForkIntent): boolean {
    return chatIntentRetryAllowed(intent.createdAt ?? 0, this.now());
  }
  async forgetSaved(ref: ChatIntentRef, key: string): Promise<void> {
    if (ref.hostId !== "local") await this.persistence?.remove(ref.hostId, ref.chatId, key);
  }
  forkIntent(ref: ChatIntentRef): ChatForkIntent | null { return this.entries.get(refKey(ref))?.fork ?? null; }

  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Map<string, Set<() => void>>();

  /** Records an intent as in flight. */
  begin(ref: ChatIntentRef, intent: ChatIntent): void {
    intent.createdAt ??= this.now();
    let done!: () => void;
    const settled = new Promise<void>((resolve) => {
      done = resolve;
    });
    this.entry(ref).pending.set(intent.idempotencyKey, { intent, settled, done });
    this.changed(ref);
  }

  /**
   * Settles an in-flight intent. An unknown outcome is kept for a same-key
   * retry; it never replaces an unknown send, whose text is still unsaved.
   */
  settle(ref: ChatIntentRef, idempotencyKey: string, outcome: "known" | "unknown"): void {
    const entry = this.entries.get(refKey(ref));
    const pending = entry?.pending.get(idempotencyKey);
    if (!entry || !pending) return;
    entry.pending.delete(idempotencyKey);
    if (outcome === "unknown") {
      if (!entry.unresolved) entry.unresolved = { intent: pending.intent, retrying: false };
      else if (entry.unresolved.intent.idempotencyKey !== idempotencyKey) entry.waiting.push(pending.intent);
    }
    pending.done();
    this.prune(ref, entry);
    this.changed(ref);
  }

  unresolved(ref: ChatIntentRef): ChatIntentUnresolved | null {
    return this.entries.get(refKey(ref))?.unresolved ?? null;
  }

  /** True while a send for this chat is still waiting for the host's answer. */
  sending(ref: ChatIntentRef): boolean {
    const pending = this.entries.get(refKey(ref))?.pending;
    return pending ? [...pending.values()].some(({ intent }) => intent.kind === "send") : false;
  }

  /**
   * Resolves once every send and guidance for this chat now in flight is
   * settled, whichever pane submitted it; null when none is in flight.
   * Never rejects.
   */
  submissionsSettled(ref: ChatIntentRef): Promise<void> | null {
    const pending = this.entries.get(refKey(ref))?.pending;
    const inFlight = [...(pending?.values() ?? [])].filter(({ intent }) => intent.text !== undefined);
    return inFlight.length === 0 ? null : Promise.all(inFlight.map(({ settled }) => settled)).then(() => undefined);
  }

  /** Marks the unresolved intent as being retried, or not; ignored if it was replaced. */
  retrying(ref: ChatIntentRef, idempotencyKey: string, retrying: boolean): void {
    const entry = this.entries.get(refKey(ref));
    if (entry?.unresolved?.intent.idempotencyKey !== idempotencyKey) return;
    entry.unresolved = { ...entry.unresolved, retrying };
    this.changed(ref);
  }

  /** Forgets the unresolved intent (resolved by a retry, or dismissed). */
  resolve(ref: ChatIntentRef, idempotencyKey: string): void {
    const entry = this.entries.get(refKey(ref));
    if (entry?.unresolved?.intent.idempotencyKey !== idempotencyKey) return;
    const next = entry.waiting.shift();
    entry.unresolved = next ? { intent: next, retrying: false } : null;
    this.prune(ref, entry);
    this.changed(ref);
  }

  /** The key of this chat's fork with `signature` whose outcome is still unknown, if any. */
  forkKey(ref: ChatIntentRef, signature: string): string | null {
    const fork = this.entries.get(refKey(ref))?.fork;
    return fork?.signature === signature ? fork.idempotencyKey : null;
  }

  /** Remembers the fork now being sent, replacing any earlier one for this chat. */
  beginFork(ref: ChatIntentRef, fork: ChatForkIntent): void {
    this.entry(ref).fork = fork;
    this.changed(ref);
  }

  /** Forgets the fork sent under `idempotencyKey` once its outcome is known; ignored if it was replaced. */
  settleFork(ref: ChatIntentRef, idempotencyKey: string): void {
    const entry = this.entries.get(refKey(ref));
    if (entry?.fork?.idempotencyKey !== idempotencyKey) return;
    entry.fork = null;
    this.prune(ref, entry);
    this.changed(ref);
  }

  subscribe(ref: ChatIntentRef, listener: () => void): () => void {
    const key = refKey(ref);
    const set = this.listeners.get(key) ?? new Set();
    set.add(listener);
    this.listeners.set(key, set);
    return () => {
      set.delete(listener);
      if (set.size === 0 && this.listeners.get(key) === set) this.listeners.delete(key);
    };
  }

  private entry(ref: ChatIntentRef): Entry {
    const key = refKey(ref);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { pending: new Map(), unresolved: null, fork: null, waiting: [] };
      this.entries.set(key, entry);
    }
    return entry;
  }

  private prune(ref: ChatIntentRef, entry: Entry): void {
    if (entry.pending.size === 0 && !entry.unresolved && !entry.fork) this.entries.delete(refKey(ref));
  }

  private changed(ref: ChatIntentRef): void {
    for (const listener of [...(this.listeners.get(refKey(ref)) ?? [])]) listener();
  }
}

/** This window's ledger, shared by every chat pane it opens. */
export const chatIntentLedger = new ChatIntentLedger(typeof window === "undefined" ? undefined : {
  list: peerHostsApi.pendingIntents,
  put: peerHostsApi.saveIntent,
  remove: peerHostsApi.removeIntent,
});
