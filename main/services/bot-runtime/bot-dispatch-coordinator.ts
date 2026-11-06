/** Serialize live provider effects sharing a budget; durable pending receipts still fence crashes. */
export function createBotDispatchCoordinator() {
  const active = new Map<string, { id: string; done: Promise<void>; release(): void }>();
  return {
    async acquire(id: string, scopes: readonly string[], signal: AbortSignal): Promise<() => void> {
      const keys = [...new Set(scopes)].sort();
      for (;;) {
        signal.throwIfAborted();
        const waits = keys.flatMap((key) => active.has(key) ? [active.get(key)!.done] : []);
        if (!waits.length) break;
        await new Promise<void>((resolve, reject) => {
          const aborted = () => { cleanup(); reject(signal.reason); }, cleanup = () => signal.removeEventListener("abort", aborted);
          signal.addEventListener("abort", aborted, { once: true });
          if (signal.aborted) aborted();
          void Promise.all(waits).then(() => { cleanup(); resolve(); }, (error) => { cleanup(); reject(error); });
        });
      }
      let resolveDone!: () => void; const done = new Promise<void>((resolve) => { resolveDone = resolve; }); let held = true;
      const entry = { id, done, release() { if (!held) return; held = false; for (const key of keys) if (active.get(key) === entry) active.delete(key); resolveDone(); } };
      for (const key of keys) active.set(key, entry);
      return entry.release;
    },
  };
}
