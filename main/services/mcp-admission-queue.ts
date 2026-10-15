// Ordering for MCP credential cleanup and configured-server admission. Kept
// free of Electron, config and credential imports so the ordering contract can
// be exercised directly.
//
// Exclusive operations (config/credential mutations, journal reconciliation)
// run one at a time, after every operation queued before them. Shared
// operations (admitting one server's connection) run after every exclusive
// operation queued before them and after earlier shared operations for the
// same key, but concurrently with other keys. An exclusive operation also
// waits for shared operations already in flight, so admission can never
// interleave with a mutation.

const settle = (operation: Promise<unknown>): Promise<void> =>
  operation.then(() => undefined, () => undefined);

export function createMcpAdmissionQueue() {
  let exclusiveTail: Promise<void> = Promise.resolve();
  let exclusiveQueued = 0;
  const sharedTails = new Map<string, Promise<void>>();
  const sharedInFlight = new Set<Promise<void>>();

  return {
    exclusive<R>(operation: () => Promise<R>): Promise<R> {
      const prior = Promise.all([exclusiveTail, ...sharedInFlight]);
      exclusiveQueued += 1;
      const result = prior.then(operation);
      const done = settle(result).then(() => { exclusiveQueued -= 1; });
      exclusiveTail = done;
      return result;
    },

    shared<R>(key: string, operation: () => Promise<R>): Promise<R> {
      const result = Promise.all([exclusiveTail, sharedTails.get(key)]).then(operation);
      const done = settle(result);
      sharedTails.set(key, done);
      sharedInFlight.add(done);
      void done.then(() => {
        sharedInFlight.delete(done);
        if (sharedTails.get(key) === done) sharedTails.delete(key);
      });
      return result;
    },

    /** True while an exclusive operation is queued or running. */
    exclusiveBusy(): boolean {
      return exclusiveQueued > 0;
    },
  };
}

/**
 * What this process knows about the pending-cleanup journal. It is the only
 * writer, so after one read (or its own write/clear) it need not re-read the
 * file. `unknown` (startup, or after an I/O failure) always reads.
 */
export class McpPendingJournalState {
  private state: "unknown" | "empty" | "pending" = "unknown";

  knownEmpty(): boolean {
    return this.state === "empty";
  }

  observed(pending: boolean): void {
    this.state = pending ? "pending" : "empty";
  }

  written(): void {
    this.state = "pending";
  }

  cleared(): void {
    this.state = "empty";
  }

  /** A failed read or write leaves the file's content uncertain. */
  uncertain(): void {
    this.state = "unknown";
  }
}

/** Concurrent callers share one in-flight run; the next call starts afresh. */
export function singleFlight(run: () => Promise<void>): () => Promise<void> {
  let inFlight: Promise<void> | undefined;
  return () => {
    inFlight ??= run().finally(() => { inFlight = undefined; });
    return inFlight;
  };
}
