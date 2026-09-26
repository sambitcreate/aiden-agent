import type { ChatContextPressureV1 } from "../shared/context-pressure";

export interface ContextPressureFeedOptions<Draft> {
  /** Ambient next-request projection for a chat (chats:contextPressure). */
  fetch(
    chatId: string,
    draft: Draft | undefined,
  ): Promise<ChatContextPressureV1 | null>;
  /** Render a reading; null means the quiet "unknown" meter. */
  publish(pressure: ChatContextPressureV1 | null): void;
  draftDelayMs?: number;
  schedule?(run: () => void, delayMs: number): unknown;
  cancel?(handle: unknown): void;
}

/**
 * Decides which ambient context-pressure readings may reach the composer meter.
 *
 * ChatPane stays mounted across chat navigation, and a live generation pushes
 * the harness's authoritative in-turn projection. Ambient journal reads that
 * resolve after either of those changes are stale and are dropped, as are
 * debounced draft refreshes queued before them.
 */
export class ContextPressureFeed<Draft> {
  private chatId: string | null = null;
  private request = 0;
  private live = false;
  private draftTimer: unknown = null;
  private readonly draftDelayMs: number;
  private readonly schedule: (run: () => void, delayMs: number) => unknown;
  private readonly cancel: (handle: unknown) => void;

  constructor(private readonly options: ContextPressureFeedOptions<Draft>) {
    this.draftDelayMs = options.draftDelayMs ?? 500;
    this.schedule =
      options.schedule ?? ((run, delayMs) => setTimeout(run, delayMs));
    this.cancel =
      options.cancel ??
      ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  /** Show a chat (or none, for an unsaved draft chat); clears the old reading. */
  showChat(chatId: string | null): void {
    if (chatId === this.chatId) return;
    this.chatId = chatId;
    this.invalidate();
    this.options.publish(null);
  }

  /** While live, only pushed readings reach the meter. */
  setLive(live: boolean): void {
    this.live = live;
    if (live) this.invalidate();
  }

  async refresh(draft?: Draft): Promise<void> {
    const chatId = this.chatId;
    if (chatId === null || this.live) return;
    const request = ++this.request;
    let pressure: ChatContextPressureV1 | null;
    try {
      pressure = await this.options.fetch(chatId, draft);
    } catch {
      // Best-effort: keep the last good reading.
      return;
    }
    if (request === this.request && !this.live && chatId === this.chatId) {
      this.options.publish(pressure);
    }
  }

  /** Debounced refresh for composer typing and attachment changes. */
  draftChanged(draft: Draft | undefined): void {
    this.cancelDraft();
    this.draftTimer = this.schedule(() => {
      this.draftTimer = null;
      void this.refresh(draft);
    }, this.draftDelayMs);
  }

  /** A main-process push (live turn or manual compaction) for some chat. */
  pushed(chatId: string, pressure: ChatContextPressureV1 | null): void {
    if (chatId === this.chatId) this.options.publish(pressure);
  }

  dispose(): void {
    this.invalidate();
  }

  private invalidate(): void {
    this.request += 1;
    this.cancelDraft();
  }

  private cancelDraft(): void {
    if (this.draftTimer !== null) this.cancel(this.draftTimer);
    this.draftTimer = null;
  }
}
