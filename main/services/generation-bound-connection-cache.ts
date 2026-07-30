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

export class GenerationBoundConnectionCache<T> {
  private readonly generations = new Map<string, number>();
  private readonly connected = new Map<string, ConnectionRecord<T>>();
  private readonly pending = new Map<string, PendingConnection<T>>();

  async getOrConnect(
    id: string,
    create: () => T,
    connect: (value: T, isCurrent: () => boolean) => Promise<void>,
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
      (this.generations.get(id) ?? 0) === generation &&
      (this.pending.get(id) === attempt || this.connected.get(id) === connectedRecord);
    let begin!: () => void;
    const admitted = new Promise<void>((resolve) => {
      begin = resolve;
    });
    attempt.promise = (async () => {
      await admitted;
      try {
        try {
          await connect(value, isCurrent);
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
    this.generations.set(id, (this.generations.get(id) ?? 0) + 1);
    const pending = this.pending.get(id);
    const connected = this.connected.get(id);
    this.pending.delete(id);
    this.connected.delete(id);
    await Promise.all([pending?.cancel(), connected?.close()]);
  }

  ids(): string[] {
    return [...new Set([...this.pending.keys(), ...this.connected.keys()])];
  }

  generation(id: string): number {
    return this.generations.get(id) ?? 0;
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
  private readonly generations = new Map<string, number>();
  private readonly attempts = new Map<string, Set<ConnectionAttempt<T>>>();

  generation(id: string): number {
    return this.generations.get(id) ?? 0;
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
      await attempt.close();
      records.delete(attempt);
      if (records.size === 0 && this.attempts.get(id) === records) {
        this.attempts.delete(id);
      }
    }
  }

  async disconnect(id: string): Promise<void> {
    this.generations.set(id, this.generation(id) + 1);
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

  ids(): string[] {
    return [...this.attempts.keys()];
  }
}
