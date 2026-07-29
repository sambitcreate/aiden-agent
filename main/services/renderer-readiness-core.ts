/**
 * A reload replaces the renderer document while callers may already be waiting
 * for its command listener. Reset wakes those callers, but wait() follows the
 * generation change and does not release them until the newest document is
 * ready.
 */
export function createRendererReadinessGate() {
  let generation = 0;
  let readyPromise = Promise.resolve();
  let resolveReady: (() => void) | null = null;

  const reset = () => {
    resolveReady?.();
    generation += 1;
    readyPromise = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
  };

  const markReady = () => {
    resolveReady?.();
    resolveReady = null;
  };

  const wait = async () => {
    while (true) {
      const expectedGeneration = generation;
      const expectedReady = readyPromise;
      await expectedReady;
      if (expectedGeneration === generation) return;
    }
  };

  const dispose = () => {
    resolveReady?.();
    resolveReady = null;
  };

  return { dispose, markReady, reset, wait };
}
