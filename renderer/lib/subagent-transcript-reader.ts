import type { SubagentTranscriptV1 } from "../shared/subagent-transcript";

/** The quietest a helper's saved conversation is read again, per run. */
export const SUBAGENT_TRANSCRIPT_READ_INTERVAL_MS = 1_000;
/**
 * Reads of a finished helper's saved conversation before an empty or
 * unfinished copy is accepted. Its final save lands just after the run
 * finishes; spaced one, two, three… intervals apart, these cover its tries.
 */
export const SUBAGENT_TRANSCRIPT_FINAL_READ_ATTEMPTS = 6;

export interface SubagentTranscriptReadRequest {
  /** Why it is read; each distinct reason is read once until it fails. */
  reason: string;
  /**
   * The run's revision when this was asked. A read that starts once a saved
   * copy was already read at this revision or later is skipped.
   */
  skipIfLoadedAt?: number;
  /**
   * The helper has finished. Only its final saved copy answers: an empty or
   * unfinished one, saved before the run ended, is read again a few times
   * while the final save lands.
   */
  final?: boolean;
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
  /** Whether a saved copy is a finished helper's final one. Defaults to any copy. */
  isFinal?(transcript: SubagentTranscriptV1): boolean;
  minIntervalMs?: number;
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface SubagentTranscriptReader {
  /** Reads once per reason, at most one read in flight per run. */
  request(chatId: string, runId: string, request: SubagentTranscriptReadRequest): void;
  /** Reads again for a reason that failed, skipping the de-duplication. */
  retry(chatId: string, runId: string, reason: string, options?: { final?: boolean }): void;
  /** Records a saved copy read elsewhere at this run revision. */
  noteLoaded(chatId: string, runId: string, runRevision: number): void;
  /** The run finished: forget its reasons once its reads settle. */
  finish(runId: string): void;
  /**
   * Moves to this chat. A different chat drops every run and ignores answers
   * still on their way; the chat already read leaves its reads alone.
   */
  switchChat(chatId: string | null): void;
  /** Drops every run, and ignores answers still on their way. */
  reset(chatId: string | null): void;
}

interface PendingRead {
  reason: string;
  skipIfLoadedAt?: number;
  forced: boolean;
  final: boolean;
  /** Earlier reads of this finished helper that found no final copy. */
  attempt: number;
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
  return {
    reason: newer.reason,
    skipIfLoadedAt,
    forced: older.forced || newer.forced,
    final: older.final || newer.final,
    attempt: Math.max(older.attempt, newer.attempt),
  };
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
  const isFinal = options.isFinal ?? (() => true);
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
  const clearTimer =
    options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  let chatId: string | null = null;
  let generation = 0;
  let runs = new Map<string, RunReads>();

  const forChat = (nextChatId: string | null) => {
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
  const coveredByLoad = (run: RunReads, read: PendingRead) =>
    read.skipIfLoadedAt !== undefined && run.loadedAt >= read.skipIfLoadedAt;
  // A finished run keeps only the revision it was read at, so a repeated
  // request for its last state is skipped rather than read again.
  const settleIdle = (run: RunReads) => {
    if (run.finished && !run.inFlight && !run.pending) run.lastReason = null;
  };

  const start = (runId: string, run: RunReads, read: PendingRead) => {
    if (!read.forced && coveredByLoad(run, read)) {
      // A copy at least this new was already read, so an earlier failure is moot.
      if (chatId !== null) options.onSettled(chatId, runId, null);
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
          let readAgain: PendingRead | null = null;
          if (seq > run.answeredSeq) {
            run.answeredSeq = seq;
            const copy = transcript?.runId === runId ? transcript : null;
            // A finished helper's copy saved before it ended does not answer
            // yet; its final save is on its way.
            const waitingForFinal =
              read.final &&
              (!copy || !isFinal(copy)) &&
              read.attempt + 1 < SUBAGENT_TRANSCRIPT_FINAL_READ_ATTEMPTS;
            if (waitingForFinal) readAgain = { ...read, forced: true, attempt: read.attempt + 1 };
            else if (loadedAt !== undefined) run.loadedAt = Math.max(run.loadedAt, loadedAt);
            if (copy) options.onTranscript(startedChat, copy);
            options.onSettled(startedChat, runId, null);
          }
          if (readAgain && !run.pending && run.timer === null) {
            readLater(runId, run, readAgain, minIntervalMs * readAgain.attempt);
            return;
          }
          if (readAgain && run.pending) run.pending = mergePendingReads(readAgain, run.pending);
          drain(runId, run);
        },
        () => {
          if (!current()) return;
          run.inFlight = false;
          if (coveredByLoad(run, read)) {
            // A copy this new arrived another way while it was in flight.
            if (seq > run.answeredSeq) {
              run.answeredSeq = seq;
              options.onSettled(startedChat, runId, null);
            }
          } else {
            // The same reason may be asked again; a newer answer stands.
            if (run.lastReason === read.reason) run.lastReason = null;
            if (seq > run.answeredSeq) options.onSettled(startedChat, runId, read.reason);
          }
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
    readLater(runId, run, read, wait);
  };

  const readLater = (runId: string, run: RunReads, read: PendingRead, wait: number) => {
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
      schedule(runId, run, {
        reason: request.reason,
        ...(request.skipIfLoadedAt === undefined ? {} : { skipIfLoadedAt: request.skipIfLoadedAt }),
        forced: false,
        final: request.final === true,
        attempt: 0,
      });
    },
    retry(nextChatId, runId, reason, retryOptions) {
      forChat(nextChatId);
      const run = runFor(runId);
      run.lastReason = reason;
      schedule(runId, run, { reason, forced: true, final: retryOptions?.final === true, attempt: 0 });
    },
    noteLoaded(nextChatId, runId, runRevision) {
      forChat(nextChatId);
      const run = runFor(runId);
      run.loadedAt = Math.max(run.loadedAt, runRevision);
    },
    switchChat: forChat,
    finish(runId) {
      const run = runs.get(runId);
      if (!run) return;
      run.finished = true;
      settleIdle(run);
    },
    reset,
  };
}
