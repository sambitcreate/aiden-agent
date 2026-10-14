import { isSafeSubagentIdentifier } from "../../renderer/shared/subagent-runs.js";
import {
  parseLocalRunCursor,
  type LOCAL_RUN_FRAME_CHANNEL,
  type LocalRunFrameMessage,
} from "../../renderer/shared/local-run-frames.js";
import type { LocalRunObservers } from "../services/local-run-observers.js";

/** The renderer document that made a request. */
export interface LocalRunOwner {
  /** Stable for one document; a reload or navigation is a new owner. */
  readonly key: string;
  isDestroyed(): boolean;
  send(channel: typeof LOCAL_RUN_FRAME_CHANNEL, payload: LocalRunFrameMessage): void;
  /** Runs once when the document goes away; returns a detach function. */
  onInvalidated(listener: () => void): () => void;
}

export interface LocalRunHandlerDependencies<Event> {
  handle(channel: string, handler: (event: Event, ...args: unknown[]) => unknown): void;
  /** Throws for a sender that is not the current main frame. */
  owner(event: Event): LocalRunOwner;
  observers(): LocalRunObservers;
  /**
   * Host-authority Stop for a run this process hosts, whoever started it: the
   * same control a paired phone with `runs:control` has. Resolves false when
   * the run is unknown or already finished.
   */
  stopRun(runId: string): boolean;
  /**
   * Whether a generation has finished for good: the host journal holds its
   * terminal state and nothing in this process is still running it. Unknown
   * runs are not proof, so they report false.
   */
  isRunSettled(runId: string): boolean;
}

/** Bound on one settled query; a document retains far fewer detached streams. */
const MAX_SETTLED_QUERY = 64;

const INACTIVE = "The application document changed.";

function identifier(value: unknown, label: string): string {
  if (!isSafeSubagentIdentifier(value)) throw new Error(`Invalid ${label}.`);
  return value;
}

/**
 * The Mac's own live mirror of runs it hosts but this document did not start
 * (a phone's turn, another window's). Frames go only to the subscribing
 * document and stop with it.
 */
export function registerLocalRunHandlers<Event>(dependencies: LocalRunHandlerDependencies<Event>): void {
  const { handle } = dependencies;

  const active = (event: Event): LocalRunOwner => {
    const owner = dependencies.owner(event);
    if (owner.isDestroyed()) throw new Error(INACTIVE);
    return owner;
  };

  handle("runs:observeLocal", (event, chatId, cursor) => {
    const owner = active(event);
    const id = identifier(chatId, "chat identifier");
    const after = parseLocalRunCursor(cursor);
    return dependencies.observers().observe(
      {
        key: owner.key,
        isDestroyed: () => owner.isDestroyed(),
        // A literal so the IPC inventory sees it; the parameter type pins it to the shared constant.
        send: (message) => owner.send("runs:local-frame", message),
        onInvalidated: (listener) => owner.onInvalidated(listener),
      },
      id,
      after,
    );
  });

  handle("runs:unobserveLocal", (event, subscriptionId) => {
    const owner = dependencies.owner(event);
    const id = identifier(subscriptionId, "run subscription");
    return dependencies.observers().unobserve(owner.key, id);
  });

  handle("runs:stopLocal", (event, runId) => {
    active(event);
    return dependencies.stopRun(identifier(runId, "run identifier"));
  });

  // Lets a document drop a drain marker it holds for a run that ended while
  // the chat stayed busy with a newer run (a phone's turn right after it).
  handle("runs:settledLocal", (event, runIds) => {
    active(event);
    if (!Array.isArray(runIds) || runIds.length > MAX_SETTLED_QUERY) throw new Error("Invalid run identifiers.");
    const ids = runIds.map((runId) => identifier(runId, "run identifier"));
    return [...new Set(ids)].filter((runId) => dependencies.isRunSettled(runId));
  });
}
