export interface ChatTurnLease {
  readonly chatId: string;
  readonly ownerId: string;
  readonly turnId: string;
  onReleased(cleanup: () => void): void;
  release(): void;
}

interface ChatTurnRecord {
  lease: ChatTurnLease;
}

/**
 * Owns the append-to-generation critical section for one chat.
 *
 * A lease can cross awaits while a user message is persisted, then hand off
 * synchronously to generation registration. JavaScript cannot interleave
 * another renderer or scheduler claim between the registration callback and
 * release of the lease.
 */
export class ChatTurnAdmission {
  private readonly turns = new Map<string, ChatTurnRecord>();

  tryBegin(
    chatId: string,
    turnId: string,
    ownerId: string,
    generationBusy: boolean,
  ): ChatTurnLease | null {
    if (generationBusy || this.turns.has(chatId)) return null;

    let released = false;
    const cleanups = new Set<() => void>();
    const lease: ChatTurnLease = {
      chatId,
      turnId,
      ownerId,
      onReleased: (cleanup) => {
        if (released) cleanup();
        else cleanups.add(cleanup);
      },
      release: () => {
        if (released) return;
        released = true;
        if (this.turns.get(chatId)?.lease === lease) this.turns.delete(chatId);
        for (const cleanup of cleanups) cleanup();
        cleanups.clear();
      },
    };
    this.turns.set(chatId, { lease });
    return lease;
  }

  isAdmitted(chatId: string): boolean {
    return this.turns.has(chatId);
  }

  owns(chatId: string, turnId: string, ownerId: string): boolean {
    const lease = this.turns.get(chatId)?.lease;
    return lease?.turnId === turnId && lease.ownerId === ownerId;
  }

  releaseMatching(chatId: string, turnId: string, ownerId: string): boolean {
    const lease = this.turns.get(chatId)?.lease;
    if (lease?.turnId !== turnId || lease.ownerId !== ownerId) return false;
    lease.release();
    return true;
  }

  /**
   * Register generation ownership and release the matching append lease as one
   * synchronous operation. A throwing registration keeps the lease intact so
   * the caller can fail closed or release it deliberately.
   */
  handoff(
    chatId: string,
    turnId: string,
    ownerId: string,
    registerGeneration: () => void,
  ): boolean {
    const lease = this.turns.get(chatId)?.lease;
    if (lease?.turnId !== turnId || lease.ownerId !== ownerId) return false;
    registerGeneration();
    lease.release();
    return true;
  }
}
