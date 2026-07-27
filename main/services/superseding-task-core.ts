export interface SupersedingTaskToken {
  readonly promise: Promise<void>;
}

interface TrackedTask extends SupersedingTaskToken {
  error: unknown;
  resolveSuperseded: () => void;
  state: "pending" | "fulfilled" | "rejected";
  superseded: Promise<void>;
}

/**
 * Tracks async work whose newest generation owns the outcome. Waiters follow
 * replacements, while stale failures remain observable to their own callers
 * without being allowed to decide the current generation's fate.
 */
export function createSupersedingTaskGate() {
  let current: TrackedTask | null = null;

  const replace = (promise: Promise<void>): SupersedingTaskToken => {
    current?.resolveSuperseded();
    let resolveSuperseded!: () => void;
    const superseded = new Promise<void>((resolve) => {
      resolveSuperseded = resolve;
    });
    const task: TrackedTask = {
      error: undefined,
      promise,
      resolveSuperseded,
      state: "pending",
      superseded,
    };
    current = task;
    void promise.then(
      () => {
        task.state = "fulfilled";
      },
      (error: unknown) => {
        task.error = error;
        task.state = "rejected";
      },
    );
    return task;
  };

  const isCurrent = (token: SupersedingTaskToken): boolean => current === token;

  const wait = async (): Promise<void> => {
    while (current) {
      const task = current;
      await Promise.race([
        task.promise.catch(() => undefined),
        task.superseded,
      ]);
      if (current !== task) continue;
      if (task.state === "rejected") throw task.error;
      current = null;
    }
  };

  const clear = (): void => {
    current?.resolveSuperseded();
    current = null;
  };

  return { clear, isCurrent, replace, wait };
}
