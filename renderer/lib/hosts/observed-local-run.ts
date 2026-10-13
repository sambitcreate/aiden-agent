import {
  clearObservedRunProjection,
  publishObservedRunProjection,
} from "../chat-terminal-sync";
import type { HostChatAdapter } from "./host-chat-adapter";
import {
  applyRemoteRunEvent,
  applyRemoteRunStreamState,
  applyRemoteRunSubscription,
  handOffRemoteRun,
  initialRemoteRunView,
  type RemoteRunStep,
  type RemoteRunView,
} from "./remote-stream-translator";

export interface ObserveLocalRunOptions {
  adapter: Pick<HostChatAdapter, "observe">;
  chatId: string;
  workspaceId: string;
  /** Re-reads the persisted chat into the cache (a new turn's message, a finished reply). */
  refetch(): Promise<void>;
  now?: () => number;
  /** Defers publishing to the end of the current frame batch. */
  schedule?: (callback: () => void) => void;
}

function settled(view: RemoteRunView): boolean {
  return view.status === "done" || view.status === "error" || view.status === "cancelled";
}

/**
 * Mirrors the chat's current run on this Mac (one a paired phone or another
 * window started) into the detached projection store, so the pane shows its
 * live text, reasoning, timeline and Stop through the path a route-detached
 * run already uses. The projection stays until the refetch that follows the
 * run's end has put the persisted reply in the cache, so nothing flashes.
 * Returns the function that stops observing and drops the projection.
 */
export function observeLocalRun(options: ObserveLocalRunOptions): () => void {
  const { adapter, chatId, workspaceId } = options;
  const now = options.now ?? Date.now;
  const schedule = options.schedule ?? queueMicrotask;
  let view = initialRemoteRunView(null, chatId);
  let closed = false;
  let publishQueued = false;
  let refetching = false;
  let refetchAgain = false;

  const publish = () => {
    publishQueued = false;
    if (closed || view.runId === null || view.handedOff || view.status === "idle") return;
    publishObservedRunProjection(
      { streamId: view.runId, chatId, workspaceId },
      // A run with undelivered text shows no partial reply; the persisted one replaces it.
      {
        text: view.incomplete ? "" : view.text,
        reasoning: view.incomplete ? "" : view.reasoning,
        timeline: view.timeline,
        textStreaming: view.textStreaming,
      },
      now(),
    );
  };

  const refetch = async () => {
    if (refetching) {
      refetchAgain = true;
      return;
    }
    refetching = true;
    try {
      do {
        refetchAgain = false;
        const runAtRead = view.runId;
        const settledAtRead = settled(view);
        try {
          await options.refetch();
        } catch {
          // The next settlement or revisit re-reads the chat; the run still ends below.
        }
        if (closed) return;
        // Hand off only the run whose settled state this read followed.
        if (settledAtRead && view.runId === runAtRead && runAtRead !== null) {
          view = handOffRemoteRun(view);
          clearObservedRunProjection(chatId, workspaceId, runAtRead);
        }
      } while (refetchAgain && !closed);
    } finally {
      refetching = false;
    }
  };

  const apply = (step: RemoteRunStep) => {
    if (closed) return;
    const previousRun = view.runId;
    view = step.view;
    if (previousRun !== null && previousRun !== view.runId) {
      clearObservedRunProjection(chatId, workspaceId, previousRun);
    }
    if (!publishQueued) {
      publishQueued = true;
      schedule(publish);
    }
    if (step.refetch) void refetch();
  };

  const close = adapter.observe(chatId, {
    onSubscription: (subscription) => apply(applyRemoteRunSubscription(view, subscription)),
    onEvent: (event) => apply(applyRemoteRunEvent(view, event)),
    onState: (state) => apply(applyRemoteRunStreamState(view, state)),
    onError: () => {
      // Nothing to mirror; the pane keeps its persisted transcript.
    },
  });

  return () => {
    if (closed) return;
    closed = true;
    close();
    if (view.runId !== null) clearObservedRunProjection(chatId, workspaceId, view.runId);
  };
}
