import type { BlockerFn, HistoryLocation, RouterHistory } from "@tanstack/react-router";

type HistoryAction = Parameters<BlockerFn>[0]["action"];
type TraversalOptions = Parameters<RouterHistory["back"]>[0];

function entryIndex(location: HistoryLocation): number {
  const index: unknown = location.state.__TSR_index;
  return typeof index === "number" ? index : 0;
}

/**
 * Make Back and Forward honour route leave guards (`useBlocker`).
 *
 * TanStack's history only consults blockers for push and replace, so a
 * traversal would skip guards such as the Images editor's unsaved-changes
 * prompt. This wraps a history in place: it remembers each entry's location so
 * blockers see where a traversal leads, runs them in registration order, and
 * traverses only when none blocks and nothing else navigated meanwhile.
 */
export function guardHistoryTraversal<T extends RouterHistory>(history: T): T {
  const blockers = new Set<Parameters<RouterHistory["block"]>[0]>();
  const entries: HistoryLocation[] = [];
  entries[entryIndex(history.location)] = history.location;
  history.subscribe(({ location, action }) => {
    const index = entryIndex(location);
    if (action.type === "PUSH") entries.length = index;
    entries[index] = location;
  });

  const block = history.block;
  history.block = (blocker) => {
    blockers.add(blocker);
    const release = block(blocker);
    return () => {
      blockers.delete(blocker);
      release();
    };
  };

  const guarded =
    (traverse: RouterHistory["back"], delta: -1 | 1, action: HistoryAction) =>
    (options?: TraversalOptions) => {
      const current = history.location;
      const next = entries[entryIndex(current) + delta];
      if (options?.ignoreBlocker || blockers.size === 0 || !next) {
        traverse(options);
        return;
      }
      void (async () => {
        for (const blocker of [...blockers]) {
          if (await blocker.blockerFn({ currentLocation: current, nextLocation: next, action })) {
            return;
          }
        }
        if (history.location.state.key !== current.state.key) return;
        traverse({ ...options, ignoreBlocker: true });
      })();
    };
  history.back = guarded(history.back, -1, "BACK");
  history.forward = guarded(history.forward, 1, "FORWARD");
  return history;
}
