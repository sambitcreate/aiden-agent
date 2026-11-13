/** Electron retains sessions for the process lifetime. Reuse one private session. */
export class BrowserPrivateSession<T extends {
  clearStorageData(): Promise<void>;
  clearCache(): Promise<void>;
}> {
  private session?: T;
  private cleanup: Promise<void> = Promise.resolve();

  constructor(private readonly create: () => T) {}

  async open<R>(open: (session: T) => R): Promise<R> {
    // A failed cleanup must refuse a new tab rather than expose the old state.
    let cleanup: Promise<void>;
    do {
      cleanup = this.cleanup;
      await cleanup;
    } while (cleanup !== this.cleanup);
    // Register the tab in this same turn, before a last-close can start cleanup.
    return open(this.session ??= this.create());
  }

  clear(): void {
    const session = this.session;
    if (!session) return;
    this.cleanup = this.cleanup.catch(() => {}).then(async () => {
      // Wait for both operations, including when one fails before the other.
      const results = await Promise.allSettled([
        session.clearStorageData(),
        session.clearCache(),
      ]);
      const failure = results.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    });
    // Closing a tab is synchronous. open() still observes and reports failure.
    void this.cleanup.catch(() => {});
  }
}
