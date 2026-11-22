// Chromium keeps one zoom level per host per session, and a window zoomed
// on a host zooms every other window showing that host in the same session.
// The hidden export and inspect windows share the offline session, and a
// frame's address is the same for its PNG (2×), its PDF and its inspect
// (1×), so a PNG export would lay out a concurrent inspect at half its width.
// The gate lets windows of one zoom run together and makes a window of
// another zoom wait until they have all closed; waiters go in arrival order,
// so a stream of one zoom cannot hold back the other for ever.

export type DesignZoomGate = {
  /** Waits until a window at `zoom` may open; call the returned function once it is destroyed. */
  enter(zoom: number, signal?: AbortSignal): Promise<() => void>;
};

type Waiter = { zoom: number; admit(): void };

export function createDesignZoomGate(): DesignZoomGate {
  let zoom: number | null = null;
  let open = 0;
  const waiting: Waiter[] = [];

  const leave = () => {
    open -= 1;
    if (open > 0) return;
    zoom = null;
    const next = waiting[0];
    if (!next) return;
    // Admit the first waiter and every other waiter at its zoom.
    for (const waiter of waiting.filter((entry) => entry.zoom === next.zoom)) waiter.admit();
  };

  const admitted = (): (() => void) => {
    let left = false;
    return () => {
      if (left) return;
      left = true;
      leave();
    };
  };

  return {
    enter(wanted, signal) {
      if (signal?.aborted) return Promise.reject(new Error("The inspect was stopped."));
      if (open === 0 || (zoom === wanted && waiting.length === 0)) {
        zoom = wanted;
        open += 1;
        return Promise.resolve(admitted());
      }
      return new Promise((resolve, reject) => {
        const onAbort = () => {
          const index = waiting.indexOf(waiter);
          if (index >= 0) waiting.splice(index, 1);
          // Whoever queued behind it at the open zoom need not wait any more.
          while (open > 0 && waiting[0]?.zoom === zoom) waiting[0]!.admit();
          reject(new Error("The inspect was stopped."));
        };
        const waiter: Waiter = {
          zoom: wanted,
          admit() {
            const index = waiting.indexOf(waiter);
            if (index >= 0) waiting.splice(index, 1);
            signal?.removeEventListener("abort", onAbort);
            zoom = wanted;
            open += 1;
            resolve(admitted());
          },
        };
        waiting.push(waiter);
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    },
  };
}
