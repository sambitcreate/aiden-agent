interface ConnectionRecord<T> {
  value: T;
  close: () => Promise<void>;
}

interface PendingConnection<T> extends ConnectionRecord<T> {
  generation: number;
  cancel: () => Promise<void>;
  promise: Promise<T>;
}

import { McpDeadlineError } from "./mcp-tool-discovery-core.js";

export interface ConnectionBounds {
  /**
   * Deadline for one whole connection attempt, including transport start
   * (an SSE `endpoint` event, OAuth refresh) which the SDK's initialize
   * timeout does not cover. A timed-out attempt is cancelled and never cached.
   */
  connectTimeoutMs?: number;
  /** How long a disconnect waits for an in-flight attempt to finish tearing down. */
  disconnectWaitMs?: number;
}

export type ConnectionLifecycleEvent =
  | { type: "connecting" }
  | { type: "connected" }
  | { type: "failed"; error: unknown }
  | { type: "closed" };

export interface ConnectionCacheOptions extends ConnectionBounds {
  /**
   * Observes each id's current connection: attempts that start, publish, fail
   * or end. Superseded attempts report `closed`, never `failed`.
   */
  onLifecycle?: (id: string, event: ConnectionLifecycleEvent) => void;
}

const DEFAULT_DISCONNECT_WAIT_MS = 2_000;
const SHUT_DOWN = "MCP connections are shut down.";

/**
 * Settle with `operation`, or reject after `ms` and run `onTimeout` so the
 * caller can cancel the attempt. A late settlement is still observed.
 */
function withinDeadline<T>(operation: Promise<T>, ms: number | undefined, onTimeout: () => void): Promise<T> {
  if (ms === undefined) return operation;
  operation.catch(() => undefined);
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout();
      reject(new McpDeadlineError("The MCP connection", ms));
    }, ms);
    operation.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error: unknown) => { clearTimeout(timer); reject(error); },
    );
  });
}

/** Wait for an attempt to settle, but never longer than `ms`. */
async function settledWithin(operation: Promise<unknown> | null | undefined, ms: number): Promise<void> {
  if (!operation) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    operation.then(() => undefined, () => undefined),
    new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); }),
  ]);
  clearTimeout(timer);
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
  private closed = false;

  constructor(private readonly bounds: ConnectionCacheOptions = {}) {}

  private lifecycle(id: string, event: ConnectionLifecycleEvent): void {
    try {
      this.bounds.onLifecycle?.(id, event);
    } catch {
      // Observers never change connection outcomes.
    }
  }

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
    if (this.closed) throw new Error(SHUT_DOWN);
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
      const wasCurrent = this.pending.get(id) === attempt || this.connected.get(id) === connectedRecord;
      if (this.pending.get(id) === attempt) this.pending.delete(id);
      if (this.connected.get(id) === connectedRecord) this.connected.delete(id);
      if (wasCurrent) this.lifecycle(id, { type: "closed" });
    };
    let begin!: () => void;
    const admitted = new Promise<void>((resolve) => {
      begin = resolve;
    });
    attempt.promise = (async () => {
      await admitted;
      try {
        try {
          const connecting = connect(value, isCurrent, onClosed);
          await withinDeadline(connecting, this.bounds.connectTimeoutMs, () => {
            cancelled = true;
            // The pre-settlement close below may be a no-op for a transport
            // still starting; close for real once the raw attempt settles.
            closeAgainAfterSettled(connecting, () => close(value));
          });
        } catch (error) {
          const current = this.generation(id) === generation && this.pending.get(id) === attempt;
          await closeOnce();
          if (current) this.lifecycle(id, { type: "failed", error });
          throw error;
        }
        if (!isCurrent()) {
          await closeOnce();
          throw new Error("The MCP connection was superseded.");
        }
        this.connected.set(id, connectedRecord);
        this.lifecycle(id, { type: "connected" });
        return value;
      } finally {
        if (this.pending.get(id) === attempt) this.pending.delete(id);
      }
    })();
    this.pending.set(id, attempt);
    this.lifecycle(id, { type: "connecting" });
    begin();
    return attempt.promise;
  }

  async disconnect(id: string): Promise<void> {
    this.generations.advance(id);
    const pending = this.pending.get(id);
    const connected = this.connected.get(id);
    this.pending.delete(id);
    this.connected.delete(id);
    if (pending || connected) this.lifecycle(id, { type: "closed" });
    await Promise.all([pending?.cancel(), connected?.close()]);
    // Let a cancelled attempt finish its own teardown, so a caller that
    // disconnects and then exits does not leave a half-open transport behind.
    await settledWithin(pending?.promise, this.bounds.disconnectWaitMs ?? DEFAULT_DISCONNECT_WAIT_MS);
  }

  /** Close everything and refuse any later connection (application shutdown). */
  async shutdown(): Promise<void> {
    this.closed = true;
    await Promise.all(this.ids().map((id) => this.disconnect(id)));
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
    this.lifecycle(id, { type: "closed" });
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
  private closed = false;

  constructor(private readonly bounds: ConnectionBounds = {}) {}

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
    if (this.closed) throw new Error(SHUT_DOWN);
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
      const connecting = connect(value, current);
      attempt.connection = connecting;
      await withinDeadline(connecting, this.bounds.connectTimeoutMs, () => {
        attempt.cancelled = true;
        closeAgainAfterSettled(connecting, attempt.close);
      });
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
    const wait = this.bounds.disconnectWaitMs ?? DEFAULT_DISCONNECT_WAIT_MS;
    await Promise.all(records.map((attempt) => settledWithin(attempt.connection, wait)));
  }

  /** Close every attempt and refuse later ones (application shutdown). */
  async shutdown(): Promise<void> {
    this.closed = true;
    await Promise.all(this.ids().map((id) => this.disconnect(id)));
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
