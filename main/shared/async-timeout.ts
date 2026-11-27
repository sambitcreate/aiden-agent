/**
 * Wait up to `ms` milliseconds for `promise` to settle, swallowing any
 * rejection and clearing (and unref'ing where supported) the timeout handle.
 */
export function settleWithin(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise.then(
      () => undefined,
      () => undefined,
    ),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}
