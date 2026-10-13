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

/** The persisted transcript fields that say which run wrote a reply. */
export interface ObservedTranscriptMessage {
  readonly role: string;
  readonly id?: string;
  readonly timeline?: { readonly generationId: string } | null;
}

/** What one re-read of the persisted chat produced. */
export type ObservedChatRead =
  | { readonly kind: "read"; readonly messages: readonly ObservedTranscriptMessage[] }
  /** The chat was deleted or no longer exists: there is no reply to wait for. */
  | { readonly kind: "gone" }
  /** The read failed or a competing read cancelled it; it proves nothing. */
  | { readonly kind: "failed" };

export interface ObserveLocalRunOptions {
  adapter: Pick<HostChatAdapter, "observe">;
  chatId: string;
  workspaceId: string;
  /** Re-reads the persisted chat into the cache (a new turn's message, a finished reply). */
  refetch(): Promise<ObservedChatRead>;
  now?: () => number;
  /** Defers publishing to the end of the current frame batch. */
  schedule?: (callback: () => void) => void;
  /** Waits before retrying a read that failed or predates the saved reply. */
  delay?: (ms: number) => Promise<void>;
}

export interface ObservedLocalRun {
  /** Stops at once and drops the projection (the pane left or took over). */
  close(): void;
  /**
   * The chat went idle: keep showing the run until its saved reply is in the
   * cache, then stop. Closes at once when nothing is shown.
   */
  release(): void;
  /** The chat became busy again before a release finished. */
  retain(): void;
  readonly closed: boolean;
}

/** Backoff between reads that did not return what the projection waits for. */
export const OBSERVED_READ_RETRY_MS: readonly number[] = [100, 400, 1_500, 4_000];

/** Bound on how long a release waits for the run's end to arrive. */
export const OBSERVED_RELEASE_GRACE_MS = 5_000;

function settled(view: RemoteRunView): boolean {
  return view.status === "done" || view.status === "error" || view.status === "cancelled";
}

function hasReplyFrom(
  messages: readonly ObservedTranscriptMessage[],
  runId: string,
  doneMessageId: string | null = null,
): boolean {
  return messages.some(
    (message) =>
      message.role === "assistant" &&
      (message.timeline?.generationId === runId || (doneMessageId !== null && message.id === doneMessageId)),
  );
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Mirrors the chat's current run on this Mac (one a paired phone or another
 * window started) into the detached projection store, so the pane shows its
 * live text, reasoning, timeline and Stop through the path a route-detached
 * run already uses. The projection stays until a completed read has put the
 * run's saved reply in the cache, so nothing flashes.
 */
export function observeLocalRun(options: ObserveLocalRunOptions): ObservedLocalRun {
  const { adapter, chatId, workspaceId } = options;
  const now = options.now ?? Date.now;
  const schedule = options.schedule ?? queueMicrotask;
  const delay = options.delay ?? wait;
  let view = initialRemoteRunView(null, chatId);
  let closed = false;
  let publishQueued = false;
  let reading = false;
  let readRequested = false;
  /** A read that never completed; the next frame asks again. */
  let readOwed = false;
  let releasing = false;
  let releaseTimer: ReturnType<typeof setTimeout> | null = null;
  let stopObserving: () => void = () => {};

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

  const showing = () => view.runId !== null && !view.handedOff && view.status !== "idle";

  const close = () => {
    if (closed) return;
    closed = true;
    if (releaseTimer !== null) clearTimeout(releaseTimer);
    releaseTimer = null;
    stopObserving();
    if (view.runId !== null) clearObservedRunProjection(chatId, workspaceId, view.runId);
  };

  const closeIfReleased = () => {
    if (releasing && !showing() && !reading) close();
  };

  const handOff = (runId: string) => {
    view = handOffRemoteRun(view);
    clearObservedRunProjection(chatId, workspaceId, runId);
  };

  const read = async (): Promise<ObservedChatRead> => {
    try {
      return await options.refetch();
    } catch {
      return { kind: "failed" };
    }
  };

  const drainReads = async () => {
    if (reading) return;
    reading = true;
    let attempt = 0;
    try {
      while (readRequested && !closed) {
        readRequested = false;
        const runAtRead = view.runId;
        const settledAtRead = settled(view);
        // With no reply text on screen, nothing can flash: any completed read will do.
        const mirroredReply = !view.incomplete && view.text.length > 0;
        // Capture doneMessageId before the async read, as view may change.
        const doneMessageIdAtRead = view.doneMessageId;
        const outcome = await read();
        if (closed) return;
        const waitingForReply = settledAtRead && runAtRead !== null && view.runId === runAtRead;
        const complete =
          outcome.kind === "gone" ||
          (outcome.kind === "read" &&
            (!waitingForReply || !mirroredReply || hasReplyFrom(outcome.messages, runAtRead!, doneMessageIdAtRead)));
        if (complete) {
          readOwed = false;
          attempt = 0;
          if (waitingForReply) handOff(runAtRead!);
          continue;
        }
        if (attempt < OBSERVED_READ_RETRY_MS.length) {
          await delay(OBSERVED_READ_RETRY_MS[attempt]!);
          attempt++;
          readRequested = true;
          continue;
        }
        attempt = 0;
        if (waitingForReply) {
          // The reply was never saved; the persisted transcript is all there is.
          handOff(runAtRead!);
        } else {
          readOwed = true;
        }
      }
    } finally {
      reading = false;
    }
    closeIfReleased();
  };

  const requestRead = () => {
    readRequested = true;
    void drainReads();
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
    if (step.refetch || readOwed) requestRead();
    else closeIfReleased();
  };

  stopObserving = adapter.observe(chatId, {
    onSubscription: (subscription) => apply(applyRemoteRunSubscription(view, subscription)),
    onEvent: (event) => apply(applyRemoteRunEvent(view, event)),
    onState: (state) => apply(applyRemoteRunStreamState(view, state)),
    onError: () => {
      // Nothing to mirror; the pane keeps its persisted transcript.
      closeIfReleased();
    },
  });

  return {
    close,
    release: () => {
      if (closed || releasing) return;
      releasing = true;
      if (!showing() && !reading) {
        close();
        return;
      }
      // The run's end normally follows within one frame batch; if it never
      // arrives, a final read replaces the mirror before it goes.
      releaseTimer = setTimeout(() => {
        releaseTimer = null;
        if (closed || !releasing) return;
        void read().then(() => {
          // Recheck release authority: retain() might have revoked it while the read was pending.
          if (releasing && !closed) close();
        });
      }, OBSERVED_RELEASE_GRACE_MS);
    },
    retain: () => {
      if (closed) return;
      releasing = false;
      if (releaseTimer !== null) clearTimeout(releaseTimer);
      releaseTimer = null;
    },
    get closed() {
      return closed;
    },
  };
}

export interface ObservedRunTarget {
  readonly chatId: string;
  readonly workspaceId: string;
}

export interface ObservedRunLifecycleState {
  /** The pane's chat, or null while it shows a draft or runs its own turn. */
  readonly target: ObservedRunTarget | null;
  /** Main reports the chat busy. */
  readonly active: boolean;
}

/**
 * Keeps at most one observation per pane. It starts when the chat becomes
 * busy, stops at once when the pane switches chat or runs its own turn, and
 * lets a run that just ended stay on screen until its saved reply replaces it.
 */
export function createObservedRunLifecycle(start: (target: ObservedRunTarget) => ObservedLocalRun) {
  let current: { target: ObservedRunTarget; run: ObservedLocalRun } | null = null;
  const stop = () => {
    current?.run.close();
    current = null;
  };
  return {
    update({ target, active }: ObservedRunLifecycleState): void {
      const moved =
        current !== null &&
        (target === null || current.target.chatId !== target.chatId || current.target.workspaceId !== target.workspaceId);
      if (current && (moved || current.run.closed)) stop();
      if (target === null) return;
      if (active) {
        if (current) current.run.retain();
        else current = { target, run: start(target) };
      } else {
        current?.run.release();
      }
    },
    dispose: stop,
  };
}
