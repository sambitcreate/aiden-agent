/** Scoped exceptions to Electron's normal background scheduling policy. */
export class BrowserBackgroundThrottling {
  private releases = new Set<() => void>();
  constructor(private readonly target: {
    isDestroyed(): boolean;
    setBackgroundThrottling(enabled: boolean): void;
  }) {}

  acquire(signal?: AbortSignal): () => void {
    if (signal?.aborted || this.target.isDestroyed()) return () => {};
    if (!this.releases.size) this.target.setBackgroundThrottling(false);
    const release = () => {
      signal?.removeEventListener("abort", release);
      if (!this.releases.delete(release)) return;
      if (!this.releases.size && !this.target.isDestroyed())
        this.target.setBackgroundThrottling(true);
    };
    this.releases.add(release);
    signal?.addEventListener("abort", release, { once: true });
    return release;
  }

  reset(): void {
    for (const release of this.releases) release();
  }
}
