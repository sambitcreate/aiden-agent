// The chat currently on screen in the main window, as Aiden Live sees it.
// ChatPane publishes it; Live's chat tools and voice approvals read it. Panes
// stack in mount order: the newest pane is the one on screen, and when it
// unmounts the snapshot falls back to the newest pane still mounted.

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
  /** Each mounted pane's latest snapshot, oldest first. */
  private readonly panes = new Map<symbol, LiveOpenChatSnapshot>();
  private readonly listeners = new Set<Listener>();

  /** Publishes for one pane. A pane's first publish puts it on top. */
  publish(owner: symbol, snapshot: LiveOpenChatSnapshot): void {
    this.panes.set(owner, { ...snapshot });
    this.refresh();
  }

  /** Forgets one pane; the newest pane still mounted takes over. */
  clear(owner: symbol): void {
    if (!this.panes.delete(owner)) return;
    this.refresh();
  }

  private refresh(): void {
    let top: LiveOpenChatSnapshot | null = null;
    for (const snapshot of this.panes.values()) top = snapshot;
    const previous = this.snapshot;
    if (
      previous === top ||
      (previous &&
        top &&
        previous.chatId === top.chatId &&
        previous.title === top.title &&
        previous.workspaceId === top.workspaceId &&
        previous.busy === top.busy &&
        previous.streamId === top.streamId)
    ) {
      return;
    }
    this.snapshot = top ? { ...top } : null;
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
