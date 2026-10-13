export interface ComputerUseRefreshState {
  refreshing: boolean;
  error: string | null;
}

export type ComputerUseRefreshEvent =
  | { type: "start" }
  | { type: "succeeded" }
  | { type: "failed"; error: string };

/** A fresh status always replaces any stale manual-retry error. */
export function reduceComputerUseRefreshState(
  _state: ComputerUseRefreshState,
  event: ComputerUseRefreshEvent,
): ComputerUseRefreshState {
  if (event.type === "start") return { refreshing: true, error: null };
  if (event.type === "failed") return { refreshing: false, error: event.error };
  return { refreshing: false, error: null };
}

/** Stale cached readiness cannot survive a failed readiness query. */
export function computerUseReadinessReady(statusReady: boolean, statusFailed: boolean): boolean {
  return statusReady && !statusFailed;
}
