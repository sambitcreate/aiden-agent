export interface SubagentStopPendingState {
  ownerKey: string | null;
  runIds: readonly string[];
  errors: Readonly<Record<string, string>>;
}

export const EMPTY_SUBAGENT_STOP_PENDING_STATE: SubagentStopPendingState = {
  ownerKey: null,
  runIds: [],
  errors: {},
};

export function replaceSubagentStopPendingOwner(
  state: SubagentStopPendingState,
  ownerKey: string | null,
): SubagentStopPendingState {
  if (state.ownerKey === ownerKey) return state;
  return { ownerKey, runIds: [], errors: {} };
}

function omitStopRuns(
  values: Readonly<Record<string, string>>,
  runIds: ReadonlySet<string>,
): Readonly<Record<string, string>> {
  if (![...runIds].some((runId) => runId in values)) return values;
  return Object.fromEntries(Object.entries(values).filter(([runId]) => !runIds.has(runId)));
}

export function beginSubagentStopPending(
  state: SubagentStopPendingState,
  ownerKey: string,
  runId: string,
): { accepted: boolean; state: SubagentStopPendingState } {
  const owned = replaceSubagentStopPendingOwner(state, ownerKey);
  if (owned.runIds.includes(runId)) return { accepted: false, state: owned };
  const errors = omitStopRuns(owned.errors, new Set([runId]));
  return {
    accepted: true,
    state: { ownerKey, runIds: [...owned.runIds, runId], errors },
  };
}

export function clearSubagentStopPending(
  state: SubagentStopPendingState,
  ownerKey: string,
  runIds: ReadonlySet<string>,
): SubagentStopPendingState {
  if (state.ownerKey !== ownerKey || runIds.size === 0) return state;
  const remaining = state.runIds.filter((runId) => !runIds.has(runId));
  const errors = omitStopRuns(state.errors, runIds);
  return remaining.length === state.runIds.length && errors === state.errors
    ? state
    : { ownerKey, runIds: remaining, errors };
}

/**
 * Settle a rejected Stop request only while that exact owner/run is pending.
 * An authoritative terminal snapshot clears pending first, so a late rejection
 * becomes a deterministic no-op instead of replacing the terminal outcome.
 */
export function failSubagentStopPending(
  state: SubagentStopPendingState,
  ownerKey: string,
  runId: string,
  message: string,
): { accepted: boolean; state: SubagentStopPendingState } {
  if (state.ownerKey !== ownerKey || !state.runIds.includes(runId)) {
    return { accepted: false, state };
  }
  return {
    accepted: true,
    state: {
      ownerKey,
      runIds: state.runIds.filter((candidate) => candidate !== runId),
      errors: { ...state.errors, [runId]: message },
    },
  };
}
