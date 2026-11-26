// While the main window stays open, ask main every hour to revalidate the
// built-in providers' model lists, so a model released while Aiden runs (a new
// Gemini, say) shows up without a restart. Main refreshes only lists older than
// its 4-hour freshness window (PI_REMOTE_CATALOG_REFRESH_INTERVAL_MS), from
// pi.dev, and never contacts models.dev; a check with every list fresh stays
// local. Checking hourly rather than every 4 hours keeps a tick that lands just
// before a list goes stale from pushing its refresh out to 8 hours.

export const PROVIDER_CATALOG_REVALIDATE_MS = 60 * 60 * 1000;

export interface ProviderCatalogRevalidation<Providers> {
  refresh: () => Promise<{ providers: Providers }>;
  onProviders: (providers: Providers) => void;
  intervalMs?: number;
  setInterval?: (callback: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

/** Start the periodic revalidation; returns a function that stops it. */
export function startProviderCatalogRevalidation<Providers>({
  refresh,
  onProviders,
  intervalMs = PROVIDER_CATALOG_REVALIDATE_MS,
  setInterval: schedule = (callback, ms) => globalThis.setInterval(callback, ms),
  clearInterval: cancel = (handle) => globalThis.clearInterval(handle as ReturnType<typeof globalThis.setInterval>),
}: ProviderCatalogRevalidation<Providers>): () => void {
  let running = false;
  let stopped = false;
  const handle = schedule(() => {
    // A slow refresh is never stacked with the next one.
    if (running || stopped) return;
    running = true;
    void refresh()
      .then((result) => {
        if (!stopped) onProviders(result.providers);
      })
      // Quiet: cached lists stay in place, and the next tick tries again.
      .catch(() => undefined)
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  return () => {
    stopped = true;
    cancel(handle);
  };
}
