/** User previews and restoration share a queue so a late preview cannot undo Cancel. */
export class BrowserAnnotationPreviewQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private revision = 0;

  run<T>(operation: () => Promise<T>): Promise<T | null> {
    const revision = this.revision;
    const pending = this.tail.catch(() => undefined).then(async () => {
      if (revision !== this.revision) return null;
      const result = await operation();
      return revision === this.revision ? result : null;
    });
    this.tail = pending;
    return pending;
  }

  reset(operation: () => Promise<unknown>): Promise<void> {
    this.revision += 1;
    const pending = this.tail.catch(() => undefined).then(operation).then(() => undefined);
    this.tail = pending;
    return pending;
  }
}

/** Every desired-state change is scheduled, including a return to the last completed state. */
export function scheduleBrowserAnnotationPreview<T>(operation: () => Promise<T>, settled: (result: T | null) => void, timer: {
  schedule: (callback: () => void) => unknown;
  cancel: (token: unknown) => void;
} = { schedule: (callback) => setTimeout(callback, 180), cancel: (token) => clearTimeout(token as ReturnType<typeof setTimeout>) }): () => void {
  let cancelled = false;
  const token = timer.schedule(() => {
    void operation().then((result) => { if (!cancelled) settled(result); }, () => { if (!cancelled) settled(null); });
  });
  return () => { cancelled = true; timer.cancel(token); };
}
