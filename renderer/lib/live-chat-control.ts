// The open chat's controls, as Aiden Live's chat tools use them. ChatPane
// registers one controller while it shows a chat, built on the composer's own
// send, steer, queue and Stop paths, so a voice send follows the same rules as
// a typed one. Only the last registration is current.

import type { LiveChatReadMessage, LiveChatSendMode } from "../shared/live-chat-tools";
import type { LiveRendererToolResult } from "./live-session-bus";

export interface LiveChatReadSnapshot {
  title: string;
  /** A reply is starting or running. */
  busy: boolean;
  /** A tool approval in this chat is waiting on the person. */
  waitingForApproval: boolean;
  messages: LiveChatReadMessage[];
  truncated: boolean;
}

export interface LiveChatController {
  chatId: string;
  workspaceId: string | null;
  /** The chat is a draft whose first message has not been sent. */
  isDraft: boolean;
  read(limit?: number): LiveChatReadSnapshot;
  /** Sends as the person, marked "By voice". Resolves with a tool result. */
  send(text: string, mode: LiveChatSendMode): Promise<LiveRendererToolResult>;
  /** Same as pressing Stop. */
  stop(): LiveRendererToolResult;
}

type Listener = () => void;

export class LiveChatControlRegistry {
  private entry: { owner: symbol; controller: LiveChatController } | null = null;
  private readonly listeners = new Set<Listener>();

  register(owner: symbol, controller: LiveChatController): () => void {
    this.entry = { owner, controller };
    this.emit();
    return () => {
      if (this.entry?.owner !== owner) return;
      this.entry = null;
      this.emit();
    };
  }

  current(): LiveChatController | null {
    return this.entry?.controller ?? null;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Resolves with the first controller that matches, or null on timeout or abort. */
  waitFor(
    predicate: (controller: LiveChatController) => boolean,
    signal: AbortSignal,
    timeoutMs = 5_000,
  ): Promise<LiveChatController | null> {
    const now = this.current();
    if (now && predicate(now)) return Promise.resolve(now);
    return new Promise((resolve) => {
      let unsubscribe = () => {};
      const finish = (value: LiveChatController | null) => {
        clearTimeout(timer);
        unsubscribe();
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      };
      const onAbort = () => finish(null);
      const timer = setTimeout(() => finish(null), timeoutMs);
      unsubscribe = this.subscribe(() => {
        const next = this.current();
        if (next && predicate(next)) finish(next);
      });
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

export const liveChatControl = new LiveChatControlRegistry();
