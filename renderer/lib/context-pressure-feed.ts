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
 *
 * The feed retains the composer's current draft so every ambient refresh
 * (model switch, turn settle, workspace change) prices what the next send
 * will carry, not an empty composer.
 */
export class ContextPressureFeed<Draft> {
  private chatId: string | null = null;
  private request = 0;
  private live = false;
  private draftTimer: unknown = null;
  private draft: Draft | undefined;
  private scope: string | undefined;
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
    // The incoming chat's composer re-reports its own draft after mounting.
    // The workspace scope is kept: ChatPane only re-reports it when it
    // changes, so it stays the baseline across chats in the same workspace.
    this.draft = undefined;
    this.invalidate();
    this.options.publish(null);
  }

  /**
   * The chat's workspace scope (permission + folder) shapes the next request's
   * prompt and tools. On a change, clear the reading at once so the previous
   * scope's pressure is never shown as current while the re-read is pending
   * or if it fails. The scope belongs to the pane, not the shown chat, so a
   * change that coincides with a chat switch just repeats showChat's clear.
   */
  setScope(scope: string): void {
    const previous = this.scope;
    this.scope = scope;
    if (previous === undefined || previous === scope) return;
    this.invalidate();
    this.options.publish(null);
  }

  /** While live, only pushed readings reach the meter. */
  setLive(live: boolean): void {
    this.live = live;
    if (live) this.invalidate();
  }

  /** Ambient refresh priced with the composer's current draft. */
  async refresh(): Promise<void> {
    const chatId = this.chatId;
    if (chatId === null || this.live) return;
    const draft = this.draft;
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
    this.draft = draft;
    this.cancelDraft();
    this.draftTimer = this.schedule(() => {
      this.draftTimer = null;
      void this.refresh();
    }, this.draftDelayMs);
  }

  /**
   * A main-process push for some chat. Mid-turn pushes are the harness's
   * authoritative projection and paint directly. Outside a turn (manual
   * compaction) main only knows the persisted model and no draft, so the push
   * just signals a re-read with the live selection and current draft.
   */
  pushed(chatId: string, pressure: ChatContextPressureV1 | null): void {
    if (chatId !== this.chatId) return;
    if (this.live) this.options.publish(pressure);
    else void this.refresh();
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
