// Single-lane promise-tail queue for serializing async read-modify-write work.
// Pure and Electron-free so both desktop main services and the headless CLI can use it.

export interface SerialQueue {
  run<R>(operation: () => Promise<R>): Promise<R>;
  idle(): Promise<void>;
}

export function createSerialQueue(): SerialQueue {
  let tail: Promise<void> = Promise.resolve();
  return {
    run<R>(operation: () => Promise<R>): Promise<R> {
      const result = tail.then(operation, operation);
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
    idle(): Promise<void> {
      return tail;
    },
  };
}
