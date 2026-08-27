function cancellationError(): Error {
  const error = new Error("On-device transcription was cancelled.");
  error.name = "AbortError";
  return error;
}

function waitForTurn(turn: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return turn;
  if (signal.aborted) return Promise.reject(cancellationError());

  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(cancellationError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    turn.then(
      () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export interface ParakeetTranscriptionLaneOptions {
  signal?: AbortSignal;
  onCancelActive?: () => void;
}

/**
 * Serializes every consumer of the single Parakeet worker. A queued abort only
 * removes that request; an active abort may terminate the worker without
 * affecting work that has not started yet.
 */
export class ParakeetTranscriptionLane {
  private tail: Promise<void> = Promise.resolve();

  run<T>(operation: () => Promise<T>, options: ParakeetTranscriptionLaneOptions = {}): Promise<T> {
    const predecessor = this.tail;
    let release!: () => void;
    const slot = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.tail = predecessor.catch(() => {}).then(() => slot);

    return (async () => {
      try {
        await waitForTurn(predecessor, options.signal);

        let active = true;
        let cancellationHandled = false;
        const onAbort = () => {
          if (!active || cancellationHandled) return;
          cancellationHandled = true;
          options.onCancelActive?.();
        };
        options.signal?.addEventListener("abort", onAbort, { once: true });
        if (options.signal?.aborted) onAbort();

        try {
          if (options.signal?.aborted) throw cancellationError();
          const result = await operation();
          if (options.signal?.aborted) throw cancellationError();
          return result;
        } catch (error) {
          if (options.signal?.aborted) throw cancellationError();
          throw error;
        } finally {
          active = false;
          options.signal?.removeEventListener("abort", onAbort);
        }
      } finally {
        release();
      }
    })();
  }
}
