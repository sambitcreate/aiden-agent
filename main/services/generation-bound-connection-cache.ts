interface ConnectionRecord<T> {
  value: T;
  close: () => Promise<void>;
}

interface PendingConnection<T> extends ConnectionRecord<T> {
  generation: number;
  cancel: () => Promise<void>;
  promise: Promise<T>;
}

export function closeAgainAfterSettled(
  operation: Promise<unknown>,
  close: () => Promise<void>,
): void {
  void operation.then(
    () => close().catch(() => undefined),
    () => close().catch(() => undefined),
  );
}

/**
 * Per-id generation counters drawn from one monotonic sequence. An id is
 * assigned a fresh value the first time it is observed, so a forgotten id can
 * be pruned without a stale caller's captured generation ever matching again.
 */
class GenerationCounters {
  private readonly values = new Map<string, number>();
  private last = 0;

  get(id: string): number {
    let value = this.values.get(id);
    if (value === undefined) {
      value = ++this.last;
      this.values.set(id, value);
    }
    return value;
  }

  advance(id: string): void {
    this.values.set(id, ++this.last);
  }

  forget(id: string): void {
    this.values.delete(id);
  }

  get size(): number {
    return this.values.size;
  }
}

export class GenerationBoundConnectionCache<T> {
  private readonly generations = new GenerationCounters();
  private readonly connected = new Map<string, ConnectionRecord<T>>();
  private readonly pending = new Map<string, PendingConnection<T>>();

  async getOrConnect(
    id: string,
    create: () => T,
    connect: (
      value: T,
      isCurrent: () => boolean,
      onClosed: () => void,
    ) => Promise<void>,
    close: (value: T) => Promise<void>,
    expectedGeneration: number = this.generation(id),
  ): Promise<T> {
    if (expectedGeneration !== this.generation(id)) {
      throw new Error("The MCP connection was superseded.");
    }
    const ready = this.connected.get(id);
    if (ready) return ready.value;
    const generation = expectedGeneration;
    const inFlight = this.pending.get(id);
    if (inFlight?.generation === generation) return inFlight.promise;

    const value = create();
    let cancelled = false;
    let closedAfterConnect = false;
    const closeOnce = async () => {
      if (closedAfterConnect) return;
      closedAfterConnect = true;
      await close(value).catch(() => undefined);
    };
    const cancel = async () => {
      cancelled = true;
      // Best effort can interrupt transports that already exist. A second close
      // after connect settles is still required because pre-connect close may
      // be a no-op for clients awaiting auth or transport construction.
      await close(value).catch(() => undefined);
    };
    const attempt: PendingConnection<T> = {
      generation,
      value,
      close: closeOnce,
      cancel,
      promise: undefined as unknown as Promise<T>,
    };
    const connectedRecord: ConnectionRecord<T> = { value, close: closeOnce };
    const isCurrent = () =>
      !cancelled &&
      this.generation(id) === generation &&
      (this.pending.get(id) === attempt || this.connected.get(id) === connectedRecord);
    const onClosed = () => {
      // Transport loss expires this client's lease, not its configuration.
      // SDK close callbacks must not recursively close the transport, and a
      // delayed callback from an old client must not evict its replacement.
      cancelled = true;
      if (this.pending.get(id) === attempt) this.pending.delete(id);
      if (this.connected.get(id) === connectedRecord) this.connected.delete(id);
    };
    let begin!: () => void;
    const admitted = new Promise<void>((resolve) => {
      begin = resolve;
    });
    attempt.promise = (async () => {
      await admitted;
      try {
        try {
          await connect(value, isCurrent, onClosed);
        } catch (error) {
          await closeOnce();
          throw error;
        }
        if (!isCurrent()) {
          await closeOnce();
          throw new Error("The MCP connection was superseded.");
        }
        this.connected.set(id, connectedRecord);
        return value;
      } finally {
        if (this.pending.get(id) === attempt) this.pending.delete(id);
      }
    })();
    this.pending.set(id, attempt);
    begin();
    return attempt.promise;
  }

  async disconnect(id: string): Promise<void> {
    this.generations.advance(id);
    const pending = this.pending.get(id);
    const connected = this.connected.get(id);
    this.pending.delete(id);
    this.connected.delete(id);
    await Promise.all([pending?.cancel(), connected?.close()]);
  }

  /**
   * Close an established connection that is no longer in use without
   * superseding its generation: callers holding that generation may reconnect
   * transparently. An in-flight connection attempt is left alone.
   */
  async closeIdle(id: string): Promise<boolean> {
    if (this.pending.has(id)) return false;
    const connected = this.connected.get(id);
    if (!connected) return false;
    this.connected.delete(id);
    await connected.close();
    return true;
  }

  /** Disconnect and drop all bookkeeping for an id that is no longer configured. */
  async forget(id: string): Promise<void> {
    await this.disconnect(id);
    if (!this.pending.has(id) && !this.connected.has(id)) this.generations.forget(id);
  }

  ids(): string[] {
    return [...new Set([...this.pending.keys(), ...this.connected.keys()])];
  }

  connectedIds(): string[] {
    return [...this.connected.keys()];
  }

  isConnected(id: string, value: T): boolean {
    return this.connected.get(id)?.value === value;
  }

  generation(id: string): number {
    return this.generations.get(id);
  }

  /** Number of ids with generation bookkeeping; bounded by configured servers. */
  trackedIdCount(): number {
    return this.generations.size;
  }
}

interface ConnectionAttempt<T> {
  value: T;
  cancelled: boolean;
  connection: Promise<void> | null;
  close: () => Promise<void>;
}

/** Tracks one-shot connection attempts that must be invalidated as a group. */
export class GenerationBoundConnectionAttempts<T> {
  private readonly generations = new GenerationCounters();
  private readonly attempts = new Map<string, Set<ConnectionAttempt<T>>>();

  generation(id: string): number {
    return this.generations.get(id);
  }

  async run<R>(
    id: string,
    expectedGeneration: number,
    create: () => T,
    connect: (value: T, isCurrent: () => boolean) => Promise<void>,
    use: (value: T, isCurrent: () => boolean) => Promise<R>,
    close: (value: T) => Promise<void>,
  ): Promise<R> {
    if (expectedGeneration !== this.generation(id)) {
      throw new Error("The MCP connection was superseded.");
    }
    const value = create();
    const attempt: ConnectionAttempt<T> = {
      value,
      cancelled: false,
      connection: null,
      close: () => close(value).catch(() => undefined),
    };
    const current = () => !attempt.cancelled && expectedGeneration === this.generation(id);
    const records = this.attempts.get(id) ?? new Set();
    records.add(attempt);
    this.attempts.set(id, records);
    try {
      if (!current()) throw new Error("The MCP connection was superseded.");
      attempt.connection = connect(value, current);
      await attempt.connection;
      if (!current()) throw new Error("The MCP connection was superseded.");
      const result = await use(value, current);
      if (!current()) throw new Error("The MCP connection was superseded.");
      return result;
    } finally {
      attempt.cancelled = true;
      await attempt.close();
      records.delete(attempt);
      if (records.size === 0 && this.attempts.get(id) === records) {
        this.attempts.delete(id);
      }
    }
  }

  async disconnect(id: string): Promise<void> {
    this.generations.advance(id);
    const records = [...(this.attempts.get(id) ?? [])];
    this.attempts.delete(id);
    for (const attempt of records) {
      attempt.cancelled = true;
      if (attempt.connection) {
        closeAgainAfterSettled(attempt.connection, attempt.close);
      }
    }
    await Promise.all(records.map((attempt) => attempt.close()));
  }

  /** Disconnect and drop all bookkeeping for an id that is no longer configured. */
  async forget(id: string): Promise<void> {
    await this.disconnect(id);
    if (!this.attempts.has(id)) this.generations.forget(id);
  }

  ids(): string[] {
    return [...this.attempts.keys()];
  }

  trackedIdCount(): number {
    return this.generations.size;
  }
}
