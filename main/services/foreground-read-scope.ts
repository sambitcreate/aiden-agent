/** A failed close cannot establish that the descriptor was released. */
export class ForegroundReadCleanupError extends Error {
  constructor(message: string, readonly cause: unknown) { super(message); }
}

/**
 * Cancellation settles the caller, but cannot cancel an issued kernel syscall.
 * Keep a bounded owner until its original operation and all cleanup settle.
 */
export class ForegroundReadOperations {
  private active = 0;

  constructor(private readonly limit = 4) {}

  run<T>(
    signal: AbortSignal | undefined,
    durationMs: number | undefined,
    operation: (signal: AbortSignal) => Promise<T>,
    timeoutResult: () => T,
  ): Promise<T> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.active >= this.limit) {
      return Promise.reject(new Error("Filesystem operations are busy; try again shortly."));
    }
    this.active++;
    const controller = new AbortController();
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (outcome: { result: T } | { error: unknown }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if ("error" in outcome) reject(outcome.error);
        else resolve(outcome.result);
      };
      const abort = () => {
        controller.abort(signal?.reason);
        finish({ error: controller.signal.reason });
      };
      const timer = durationMs === undefined ? undefined : setTimeout(() => {
        controller.abort(new Error("File search deadline reached."));
        try { finish({ result: timeoutResult() }); }
        catch (error) { finish({ error }); }
      }, durationMs);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      // Both handlers remain installed after caller settlement. Late failures
      // are observed and never produce a second result or release capacity early.
      void Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return operation(controller.signal);
      }).then(
        (result) => { this.active--; finish({ result }); },
        (error: unknown) => {
          if (!(error instanceof ForegroundReadCleanupError)) this.active--;
          finish({ error });
        },
      );
    });
  }
}

export async function closeForegroundResource(resource: { close(): Promise<void> }): Promise<void> {
  try {
    await resource.close();
  } catch (error) {
    throw new ForegroundReadCleanupError("Filesystem cleanup failed; capacity remains reserved.", error);
  }
}
