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
  replay(adapter: HostChatAdapter, idempotencyKey: string): Promise<unknown>;
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
}

const refKey = ({ hostId, chatId }: ChatIntentRef) => `${hostId}\u0000${chatId}`;

/**
 * Keyed intents for every chat in this window, outliving the pane and adapter
 * that started them. An answer that arrives after the pane moved on still
 * records its outcome here, so reopening the chat recovers the unknown
 * outcome and its key instead of losing the text or resending under a new key.
 */
export class ChatIntentLedger {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Map<string, Set<() => void>>();

  /** Records an intent as in flight. */
  begin(ref: ChatIntentRef, intent: ChatIntent): void {
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
    if (outcome === "unknown" && entry.unresolved?.intent.kind !== "send") {
      entry.unresolved = { intent: pending.intent, retrying: false };
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
    entry.unresolved = null;
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
      entry = { pending: new Map(), unresolved: null };
      this.entries.set(key, entry);
    }
    return entry;
  }

  private prune(ref: ChatIntentRef, entry: Entry): void {
    if (entry.pending.size === 0 && !entry.unresolved) this.entries.delete(refKey(ref));
  }

  private changed(ref: ChatIntentRef): void {
    for (const listener of [...(this.listeners.get(refKey(ref)) ?? [])]) listener();
  }
}

/** This window's ledger, shared by every chat pane it opens. */
export const chatIntentLedger = new ChatIntentLedger();
