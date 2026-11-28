/**
 * Memoized dynamic `import()` wrapper with synchronous loaded-state inspection
 * so application shutdown can skip subsystems that were never loaded instead of
 * importing them during quit.
 */

export interface LazyModule<T> {
  /** Memoized dynamic `import()` loader; retries if a prior import rejected. */
  load(): Promise<T>;
  /** Synchronous read of the loaded module, or `undefined` if not yet resolved. */
  peek(): T | undefined;
  /** True once `load()` has resolved in this process. */
  isLoaded(): boolean;
  /**
   * For async teardown: if `load()` resolved or is currently in flight, awaits
   * it (returning `undefined` on import failure); if `load()` was never called,
   * resolves to `undefined` without starting an import.
   */
  peekOrAwaitInFlight(): Promise<T | undefined>;
}

export function createLazyModule<T>(loader: () => Promise<T>): LazyModule<T> {
  let resolved: T | undefined;
  let loaded = false;
  let inflight: Promise<T> | null = null;

  return {
    load(): Promise<T> {
      if (loaded) return Promise.resolve(resolved as T);
      if (inflight) return inflight;
      inflight = Promise.resolve()
        .then(loader)
        .then(
          (mod) => {
            resolved = mod;
            loaded = true;
            return mod;
          },
          (error: unknown) => {
            inflight = null;
            throw error;
          },
        );
      return inflight;
    },
    peek(): T | undefined {
      return loaded ? resolved : undefined;
    },
    isLoaded(): boolean {
      return loaded;
    },
    peekOrAwaitInFlight(): Promise<T | undefined> {
      if (loaded) return Promise.resolve(resolved);
      if (!inflight) return Promise.resolve(undefined);
      return inflight.then(
        (mod) => mod,
        () => undefined,
      );
    },
  };
}
