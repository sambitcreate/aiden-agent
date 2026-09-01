export interface BtwOperation {
  chatId: string;
  requestId: string;
  ownerDocumentId: string;
  controller: AbortController;
  settlement: Promise<void>;
}

export class BtwOperationRegistry {
  private readonly active = new Map<string, BtwOperation>();

  constructor(private readonly globalLimit: number) {}

  reserve(
    chatId: string,
    requestId: string,
    ownerDocumentId: string,
    controller: AbortController,
  ): (() => void) | null {
    if (this.active.has(chatId) || this.active.size >= this.globalLimit) return null;
    let settle!: () => void;
    const settlement = new Promise<void>((resolve) => { settle = resolve; });
    this.active.set(chatId, { chatId, requestId, ownerDocumentId, controller, settlement });
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const current = this.active.get(chatId);
      if (current?.requestId === requestId) this.active.delete(chatId);
      settle();
    };
  }

  abortForForeground(chatId: string): boolean {
    const operation = this.active.get(chatId);
    if (!operation) return false;
    operation.controller.abort(new Error("A foreground chat turn started."));
    return true;
  }

  cancel(chatId: string, requestId?: string, ownerDocumentId?: string): boolean {
    const operation = this.active.get(chatId);
    if (
      !operation ||
      (requestId && operation.requestId !== requestId) ||
      (ownerDocumentId && operation.ownerDocumentId !== ownerDocumentId)
    ) return false;
    operation.controller.abort(new Error("Side question cancelled."));
    return true;
  }

  async cancelAndSettle(chatId: string, graceMs: number): Promise<boolean> {
    const operation = this.active.get(chatId);
    if (!operation) return true;
    operation.controller.abort(new Error("Chat lifecycle ended."));
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const settled = await Promise.race([
      operation.settlement.then(() => true),
      new Promise<false>((resolve) => {
        // This timer owns the bounded lifecycle promise. Keep it referenced so
        // callers awaiting chat deletion always receive a deterministic result,
        // even when the ignored provider has no remaining event-loop handles.
        graceTimer = setTimeout(() => resolve(false), Math.max(0, graceMs));
      }),
    ]);
    if (graceTimer) clearTimeout(graceTimer);
    if (!settled && this.active.get(chatId)?.requestId === operation.requestId) {
      // The provider ignored abort. Release the admission slot and fence all
      // subsequent publication while its in-process timeout finishes draining.
      this.active.delete(chatId);
    }
    return settled;
  }

  abortAll(): void {
    for (const operation of this.active.values()) {
      operation.controller.abort(new Error("Application shutdown."));
    }
  }

  has(chatId: string): boolean {
    return this.active.has(chatId);
  }

  isCurrent(chatId: string, requestId: string): boolean {
    return this.active.get(chatId)?.requestId === requestId;
  }
}
