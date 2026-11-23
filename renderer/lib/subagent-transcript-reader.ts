import type { SubagentTranscriptV1 } from "../shared/subagent-transcript";

/** The quietest a helper's saved conversation is read again, per run. */
export const SUBAGENT_TRANSCRIPT_READ_INTERVAL_MS = 1_000;

export interface SubagentTranscriptReadRequest {
  /** Why it is read; each distinct reason is read once until it fails. */
  reason: string;
  /**
   * The run's revision when this was asked. A read that starts once a saved
   * copy was already read at this revision or later is skipped.
   */
  skipIfLoadedAt?: number;
}

export interface SubagentTranscriptReaderOptions {
  /** Reads the saved copy; null when nothing is saved yet. */
  read(chatId: string, runId: string): Promise<SubagentTranscriptV1 | null>;
  /** A saved copy arrived. */
  onTranscript(chatId: string, transcript: SubagentTranscriptV1): void;
  /**
   * A read settled: `reason` when it was rejected, so the person can try
   * again, or null when it answered (an empty answer is not a failure).
   */
  onSettled(chatId: string, runId: string, failedReason: string | null): void;
  minIntervalMs?: number;
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface SubagentTranscriptReader {
  /** Reads once per reason, at most one read in flight per run. */
  request(chatId: string, runId: string, request: SubagentTranscriptReadRequest): void;
  /** Reads again for a reason that failed, skipping the de-duplication. */
  retry(chatId: string, runId: string, reason: string): void;
  /** Records a saved copy read elsewhere at this run revision. */
  noteLoaded(chatId: string, runId: string, runRevision: number): void;
  /** The run finished: forget its reasons once its reads settle. */
  finish(runId: string): void;
  /** A chat switch: drop every run, and ignore answers still on their way. */
  reset(chatId: string | null): void;
}

interface PendingRead {
  reason: string;
  skipIfLoadedAt?: number;
  forced: boolean;
}

interface RunReads {
  lastReason: string | null;
  inFlight: boolean;
  pending: PendingRead | null;
  timer: unknown;
  lastStartedAt: number;
  /** Sequence of the newest read started, and of the newest that answered. */
  seq: number;
  answeredSeq: number;
  /** The newest run revision a saved copy was read at. */
  loadedAt: number;
  finished: boolean;
}

// One read serves every waiting reason: it skips only if each of them would.
function mergePendingReads(older: PendingRead, newer: PendingRead): PendingRead {
  const skipIfLoadedAt =
    older.skipIfLoadedAt === undefined || newer.skipIfLoadedAt === undefined
      ? undefined
      : Math.max(older.skipIfLoadedAt, newer.skipIfLoadedAt);
  return { reason: newer.reason, skipIfLoadedAt, forced: older.forced || newer.forced };
}

/**
 * Coalesces the re-reads of helpers' saved conversations. Each run has at
 * most one read in flight and one waiting, the waiting one keeps only the
 * newest reason, and reads start at most once per interval. A late or
 * failed answer never overrides a newer one, and a chat switch drops every
 * answer still on its way.
 */
export function createSubagentTranscriptReader(
  options: SubagentTranscriptReaderOptions,
): SubagentTranscriptReader {
  const minIntervalMs = options.minIntervalMs ?? SUBAGENT_TRANSCRIPT_READ_INTERVAL_MS;
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
  const clearTimer =
    options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  let chatId: string | null = null;
  let generation = 0;
  let runs = new Map<string, RunReads>();

  const forChat = (nextChatId: string) => {
    if (chatId !== nextChatId) reset(nextChatId);
  };
  const runFor = (runId: string): RunReads => {
    let run = runs.get(runId);
    if (!run) {
      run = {
        lastReason: null,
        inFlight: false,
        pending: null,
        timer: null,
        lastStartedAt: Number.NEGATIVE_INFINITY,
        seq: 0,
        answeredSeq: 0,
        loadedAt: Number.NEGATIVE_INFINITY,
        finished: false,
      };
      runs.set(runId, run);
    }
    return run;
  };
  // A finished run keeps only the revision it was read at, so a repeated
  // request for its last state is skipped rather than read again.
  const settleIdle = (run: RunReads) => {
    if (run.finished && !run.inFlight && !run.pending) run.lastReason = null;
  };

  const start = (runId: string, run: RunReads, read: PendingRead) => {
    if (!read.forced && read.skipIfLoadedAt !== undefined && run.loadedAt >= read.skipIfLoadedAt) {
      settleIdle(run);
      return;
    }
    const startedChat = chatId;
    const startedGeneration = generation;
    if (startedChat === null) return;
    run.inFlight = true;
    run.lastStartedAt = now();
    const seq = ++run.seq;
    const loadedAt = read.skipIfLoadedAt;
    const current = () => generation === startedGeneration && runs.get(runId) === run;
    void options
      .read(startedChat, runId)
      .then(
        (transcript) => {
          if (!current()) return;
          run.inFlight = false;
          if (seq > run.answeredSeq) {
            run.answeredSeq = seq;
            if (loadedAt !== undefined) run.loadedAt = Math.max(run.loadedAt, loadedAt);
            if (transcript?.runId === runId) options.onTranscript(startedChat, transcript);
            options.onSettled(startedChat, runId, null);
          }
          drain(runId, run);
        },
        () => {
          if (!current()) return;
          run.inFlight = false;
          // The same reason may be asked again; a newer answer stands.
          if (run.lastReason === read.reason) run.lastReason = null;
          if (seq > run.answeredSeq) options.onSettled(startedChat, runId, read.reason);
          drain(runId, run);
        },
      );
  };

  const schedule = (runId: string, run: RunReads, read: PendingRead) => {
    if (run.inFlight || run.timer !== null) {
      run.pending = run.pending ? mergePendingReads(run.pending, read) : read;
      return;
    }
    const wait = run.lastStartedAt + minIntervalMs - now();
    if (wait <= 0) {
      start(runId, run, read);
      return;
    }
    run.pending = read;
    const scheduledGeneration = generation;
    run.timer = setTimer(() => {
      if (generation !== scheduledGeneration || runs.get(runId) !== run) return;
      run.timer = null;
      const next = run.pending;
      run.pending = null;
      if (next) start(runId, run, next);
    }, wait);
  };

  const drain = (runId: string, run: RunReads) => {
    const next = run.pending;
    if (next && run.timer === null) {
      run.pending = null;
      schedule(runId, run, next);
      return;
    }
    settleIdle(run);
  };

  function reset(nextChatId: string | null) {
    generation += 1;
    for (const run of runs.values()) if (run.timer !== null) clearTimer(run.timer);
    runs = new Map();
    chatId = nextChatId;
  }

  return {
    request(nextChatId, runId, request) {
      forChat(nextChatId);
      const run = runFor(runId);
      if (run.lastReason === request.reason) return;
      run.lastReason = request.reason;
      schedule(runId, run, { ...request, forced: false });
    },
    retry(nextChatId, runId, reason) {
      forChat(nextChatId);
      const run = runFor(runId);
      run.lastReason = reason;
      schedule(runId, run, { reason, forced: true });
    },
    noteLoaded(nextChatId, runId, runRevision) {
      forChat(nextChatId);
      const run = runFor(runId);
      run.loadedAt = Math.max(run.loadedAt, runRevision);
    },
    finish(runId) {
      const run = runs.get(runId);
      if (!run) return;
      run.finished = true;
      settleIdle(run);
    },
    reset,
  };
}
