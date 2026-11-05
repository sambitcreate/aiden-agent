/**
 * Pure run gate for PiAgentRuntimeHarness: whether a managed run is live,
 * whether it takes queued input, and whether a Stop applies to it. Queue
 * contents, tools, durability and abort controllers stay with the harness.
 */

export interface PiManagedRunState {
  readonly running: boolean;
  /** Opens at agent_start. Pi does not drain its queues after any terminal turn. */
  readonly queue: "closed" | "open";
  readonly stop: "none" | "requested";
  /** A Stop that arrived with no run live; the next run honours it. */
  readonly stopBeforeRun: boolean;
  /** The Stop came from quitting, so the run is recorded as interrupted. */
  readonly shutdownInterrupted: boolean;
}

export type PiManagedRunEvent =
  | { readonly type: "run-started" }
  | { readonly type: "agent-started" }
  | { readonly type: "queue-closed" }
  | { readonly type: "stop-requested" }
  | { readonly type: "shutdown-requested" }
  | { readonly type: "parent-aborted" }
  | { readonly type: "shutdown-recorded" }
  | { readonly type: "run-settled" }
  | { readonly type: "reset" };

export const INITIAL_PI_MANAGED_RUN_STATE: PiManagedRunState = {
  running: false,
  queue: "closed",
  stop: "none",
  stopBeforeRun: false,
  shutdownInterrupted: false,
};

export function transitionPiManagedRun(
  state: PiManagedRunState,
  event: PiManagedRunEvent,
): PiManagedRunState {
  switch (event.type) {
    case "run-started":
      return {
        ...state,
        running: true,
        queue: "closed",
        stop: state.stopBeforeRun ? "requested" : "none",
        stopBeforeRun: false,
      };
    case "agent-started":
      return state.running && state.stop === "none" ? { ...state, queue: "open" } : state;
    case "queue-closed":
      return { ...state, queue: "closed" };
    case "stop-requested":
      return {
        ...state,
        stop: "requested",
        queue: "closed",
        stopBeforeRun: state.running ? state.stopBeforeRun : true,
      };
    case "shutdown-requested":
      return { ...state, shutdownInterrupted: true };
    case "parent-aborted":
      return { ...state, stop: "requested" };
    case "shutdown-recorded":
      return { ...state, shutdownInterrupted: false };
    case "run-settled":
      return { ...state, running: false, queue: "closed" };
    case "reset":
      return { ...state, stop: "none", stopBeforeRun: false, queue: "closed" };
  }
}

/** Why queued input cannot enter this run right now, before capacity is read. */
export function piManagedQueueBlock(
  state: PiManagedRunState,
  disposed: boolean,
): "not-active" | "cancelled" | undefined {
  if (disposed || !state.running || state.queue === "closed") return "not-active";
  return state.stop === "requested" ? "cancelled" : undefined;
}
