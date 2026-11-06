// What Aiden Live is doing that needs the floating ribbon's attention: acting
// in Aiden, waiting on an approval, or waiting for a spoken confirmation. The
// chat, approval and app-control features publish here; the ribbon renders the
// most urgent entry. Only the user's taps call these callbacks.

export type LiveActivity =
  | {
      kind: "acting";
      /** Short present-tense label, e.g. "Opening Settings". */
      label: string;
      /** Stops what Live is doing and gives control back. */
      takeOver(): void;
    }
  | {
      kind: "approval";
      id: string;
      /** What the chat wants to do, e.g. "Run npm test". */
      title: string;
      /** The chat it is in. */
      chatTitle: string;
      /** True once Live has read it out and takes a spoken allow or deny. */
      voice: boolean;
      /**
       * Allow once. Absent when the approval's own card does not offer Allow
       * once (it cannot be allowed here, or it needs its specialised review);
       * the ribbon then offers Deny only and points to the card.
       */
      allow?: () => void;
      deny(): void;
    }
  | {
      kind: "confirm";
      id: string;
      /** The guarded action, e.g. "Delete the chat “Fix login”". */
      label: string;
      confirm(): void;
      cancel(): void;
    };

const PRIORITY: Record<LiveActivity["kind"], number> = { approval: 3, confirm: 2, acting: 1 };

type Listener = () => void;

export class LiveActivityStore {
  private readonly entries = new Map<string, { activity: LiveActivity; order: number }>();
  private readonly listeners = new Set<Listener>();
  private order = 0;
  private current: LiveActivity | null = null;

  /** Sets or replaces one source's activity; null clears it. */
  set(source: string, activity: LiveActivity | null): void {
    if (activity) this.entries.set(source, { activity, order: ++this.order });
    else if (!this.entries.delete(source)) return;
    this.recompute();
  }

  /** The entry the ribbon shows: highest priority, then the newest. */
  get(): LiveActivity | null {
    return this.current;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private recompute(): void {
    let best: { activity: LiveActivity; order: number } | null = null;
    for (const entry of this.entries.values()) {
      if (
        !best ||
        PRIORITY[entry.activity.kind] > PRIORITY[best.activity.kind] ||
        (PRIORITY[entry.activity.kind] === PRIORITY[best.activity.kind] && entry.order > best.order)
      ) {
        best = entry;
      }
    }
    this.current = best?.activity ?? null;
    for (const listener of [...this.listeners]) listener();
  }
}

export const liveActivity = new LiveActivityStore();
