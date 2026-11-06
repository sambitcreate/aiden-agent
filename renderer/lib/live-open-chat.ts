// The chat currently on screen in the main window, as Aiden Live sees it.
// ChatPane publishes it; Live's chat tools and voice approvals read it. Only
// one chat pane publishes at a time, and the last mount wins.

export interface LiveOpenChatSnapshot {
  chatId: string;
  title: string;
  workspaceId: string | null;
  /** True while this pane's turn is starting or streaming. */
  busy: boolean;
  /** The pane's current generation stream, when it owns one. */
  streamId: string | null;
}

type Listener = () => void;

export class LiveOpenChatStore {
  private snapshot: LiveOpenChatSnapshot | null = null;
  private owner: symbol | null = null;
  private readonly listeners = new Set<Listener>();

  /** Publishes for one pane; returns a function that clears it only if still owned. */
  publish(owner: symbol, snapshot: LiveOpenChatSnapshot): void {
    const previous = this.snapshot;
    this.owner = owner;
    if (
      previous &&
      previous.chatId === snapshot.chatId &&
      previous.title === snapshot.title &&
      previous.workspaceId === snapshot.workspaceId &&
      previous.busy === snapshot.busy &&
      previous.streamId === snapshot.streamId
    ) {
      return;
    }
    this.snapshot = { ...snapshot };
    this.emit();
  }

  clear(owner: symbol): void {
    if (this.owner !== owner) return;
    this.owner = null;
    if (this.snapshot === null) return;
    this.snapshot = null;
    this.emit();
  }

  get(): LiveOpenChatSnapshot | null {
    return this.snapshot;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

export const liveOpenChat = new LiveOpenChatStore();
