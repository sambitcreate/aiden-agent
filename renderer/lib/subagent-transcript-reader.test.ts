import assert from "node:assert/strict";
import test from "node:test";
import type { SubagentTranscriptV1 } from "../shared/subagent-transcript";
import {
  createSubagentTranscriptReader,
  SUBAGENT_TRANSCRIPT_FINAL_READ_ATTEMPTS,
} from "./subagent-transcript-reader";

function transcript(runId: string, revision: number, open = false): SubagentTranscriptV1 {
  return {
    version: 1,
    runId,
    revision,
    trimmed: false,
    entries: [
      { kind: "task", text: "Find the parser." },
      ...(open ? [{ kind: "message" as const, text: "Still writ", steps: [], startedAt: 1_000 }] : []),
    ],
  };
}

// The tests' stand-in for a final copy: every message is closed.
const isFinal = (value: SubagentTranscriptV1) =>
  value.entries.every((entry) => entry.kind !== "message" || entry.finishedAt !== undefined);

function last<T>(items: readonly T[]): T | undefined {
  return items[items.length - 1];
}

interface PendingRead {
  chatId: string;
  runId: string;
  resolve(value: SubagentTranscriptV1 | null): void;
  reject(error: Error): void;
}

/** A reader whose reads, clock and timers the test drives by hand. */
function harness() {
  const reads: PendingRead[] = [];
  const timers: Array<{ at: number; callback: () => void; cleared: boolean }> = [];
  const transcripts: Array<{ chatId: string; transcript: SubagentTranscriptV1 }> = [];
  const settled: Array<{ chatId: string; runId: string; failedReason: string | null }> = [];
  let clock = 10_000;
  const reader = createSubagentTranscriptReader({
    read: (chatId, runId) =>
      new Promise((resolve, reject) => reads.push({ chatId, runId, resolve, reject })),
    onTranscript: (chatId, value) => transcripts.push({ chatId, transcript: value }),
    onSettled: (chatId, runId, failedReason) => settled.push({ chatId, runId, failedReason }),
    isFinal,
    minIntervalMs: 1_000,
    now: () => clock,
    setTimer: (callback, ms) => {
      const timer = { at: clock + ms, callback, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (handle) => {
      (handle as { cleared: boolean }).cleared = true;
    },
  });
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
  return {
    reader,
    reads,
    transcripts,
    settled,
    flush,
    async advance(ms: number) {
      clock += ms;
      for (const timer of timers.splice(0)) {
        if (timer.cleared) continue;
        if (timer.at <= clock) timer.callback();
        else timers.push(timer);
      }
      await flush();
    },
  };
}

test("an empty answer for a helper with nothing saved yet is not a failure", async () => {
  const h = harness();
  h.reader.request("chat-1", "run-a", { reason: "join" });
  assert.equal(h.reads.length, 1);
  h.reads[0]!.resolve(null);
  await h.flush();
  assert.deepEqual(h.settled, [{ chatId: "chat-1", runId: "run-a", failedReason: null }]);
  assert.deepEqual(h.transcripts, []);
});

test("only a rejected read is a failure, and the same reason can be asked again after it", async () => {
  const h = harness();
  h.reader.request("chat-1", "run-a", { reason: "gap:3" });
  h.reads[0]!.reject(new Error("IPC closed"));
  await h.flush();
  assert.deepEqual(last(h.settled), { chatId: "chat-1", runId: "run-a", failedReason: "gap:3" });

  await h.advance(1_000);
  h.reader.request("chat-1", "run-a", { reason: "gap:3" });
  assert.equal(h.reads.length, 2);
  h.reads[1]!.resolve(transcript("run-a", 4));
  await h.flush();
  assert.deepEqual(last(h.settled), { chatId: "chat-1", runId: "run-a", failedReason: null });
  assert.equal(last(h.transcripts)?.transcript.revision, 4);
});

test("each run has one read in flight and at most one trailing read, at most once a second", async () => {
  const h = harness();
  // A helper streaming to another window: its revision moves many times a second.
  for (let revision = 10; revision < 20; revision += 1) {
    h.reader.request("chat-1", "run-a", { reason: `run:running:${revision}`, skipIfLoadedAt: revision });
  }
  assert.equal(h.reads.length, 1, "one read in flight");
  h.reads[0]!.resolve(transcript("run-a", 5));
  await h.flush();
  assert.equal(h.reads.length, 1, "the trailing read waits out the interval");

  await h.advance(999);
  assert.equal(h.reads.length, 1);
  await h.advance(1);
  assert.equal(h.reads.length, 2, "one trailing read for the newest revision");
  h.reads[1]!.resolve(transcript("run-a", 9));
  await h.advance(5_000);
  assert.equal(h.reads.length, 2, "nothing more was asked");
  assert.deepEqual(
    h.transcripts.map((entry) => entry.transcript.revision),
    [5, 9],
  );
});

test("another run is read on its own schedule", () => {
  const h = harness();
  h.reader.request("chat-1", "run-a", { reason: "join:1", skipIfLoadedAt: 1 });
  h.reader.request("chat-1", "run-b", { reason: "join:1", skipIfLoadedAt: 1 });
  assert.deepEqual(
    h.reads.map((read) => read.runId),
    ["run-a", "run-b"],
  );
});

test("a read that fails while a newer one waits leaves the newer answer standing", async () => {
  const h = harness();
  h.reader.request("chat-1", "run-a", { reason: "run:running:40", skipIfLoadedAt: 40 });
  h.reader.request("chat-1", "run-a", { reason: "run:running:41", skipIfLoadedAt: 41 });
  h.reads[0]!.reject(new Error("busy"));
  await h.advance(1_000);
  assert.equal(h.reads.length, 2, "the newer reason is still read");
  h.reads[1]!.resolve(transcript("run-a", 9));
  await h.flush();
  assert.deepEqual(
    h.settled.map((entry) => entry.failedReason),
    ["run:running:40", null],
  );
  assert.equal(last(h.transcripts)?.transcript.revision, 9);
});

test("a finished helper whose last state was already read is not read again", async () => {
  const h = harness();
  // The saved-run detail already read the copy at the run's final revision.
  h.reader.noteLoaded("chat-1", "run-a", 50);
  h.reader.request("chat-1", "run-a", { reason: "run:completed:50", skipIfLoadedAt: 50 });
  assert.equal(h.reads.length, 0);

  // A read that answered at the final revision also counts, across a remount.
  h.reader.request("chat-1", "run-b", { reason: "run:completed:12", skipIfLoadedAt: 12 });
  h.reads[0]!.resolve(transcript("run-b", 3));
  await h.flush();
  h.reader.finish("run-b");
  await h.advance(5_000);
  h.reader.request("chat-1", "run-b", { reason: "run:completed:12", skipIfLoadedAt: 12 });
  await h.advance(5_000);
  assert.equal(h.reads.length, 1);
});

test("a gap waiting behind a skipped reason is still read", async () => {
  const h = harness();
  h.reader.noteLoaded("chat-1", "run-a", 30);
  h.reader.request("chat-1", "run-a", { reason: "run:running:29", skipIfLoadedAt: 29 });
  assert.equal(h.reads.length, 0);
  h.reader.request("chat-1", "run-a", { reason: "gap:4" });
  assert.equal(h.reads.length, 1);
});

test("Try again reads a failed reason even though it was asked before", async () => {
  const h = harness();
  h.reader.request("chat-1", "run-a", { reason: "run:completed:7", skipIfLoadedAt: 7 });
  h.reads[0]!.reject(new Error("busy"));
  await h.flush();
  await h.advance(1_000);
  h.reader.retry("chat-1", "run-a", "run:completed:7");
  assert.equal(h.reads.length, 2);
});

test("a chat switch drops answers still on their way and forgets every reason", async () => {
  const h = harness();
  h.reader.request("chat-1", "run-a", { reason: "join" });
  h.reader.switchChat("chat-2");
  h.reads[0]!.resolve(transcript("run-a", 3));
  await h.flush();
  assert.deepEqual(h.transcripts, []);
  assert.deepEqual(h.settled, []);

  // Back in the first chat, the same reason is read again, without waiting.
  h.reader.request("chat-1", "run-a", { reason: "join" });
  assert.equal(h.reads.length, 2);
  assert.equal(h.reads[1]!.chatId, "chat-1");
});

test("staying on the same chat keeps the reads already started for it", async () => {
  const h = harness();
  h.reader.request("chat-1", "run-a", { reason: "join" });
  h.reader.switchChat("chat-1");
  h.reads[0]!.resolve(transcript("run-a", 3));
  await h.flush();
  assert.equal(last(h.transcripts)?.transcript.revision, 3);
  h.reader.request("chat-1", "run-a", { reason: "join" });
  assert.equal(h.reads.length, 1, "the reason it already read is not read again");
});

test("a read that fails after the copy arrived another way is not a failure", async () => {
  const h = harness();
  h.reader.request("chat-1", "run-a", { reason: "run:completed:12", skipIfLoadedAt: 12 });
  // The saved run's own detail read lands first, then the reader's read is rejected.
  h.reader.noteLoaded("chat-1", "run-a", 12);
  h.reads[0]!.reject(new Error("IPC closed"));
  await h.flush();
  assert.deepEqual(h.settled, [{ chatId: "chat-1", runId: "run-a", failedReason: null }]);
});

test("a failure clears once a newer request finds its copy already read", async () => {
  const h = harness();
  h.reader.request("chat-1", "run-a", { reason: "run:running:40", skipIfLoadedAt: 40 });
  h.reads[0]!.reject(new Error("busy"));
  await h.flush();
  assert.deepEqual(last(h.settled), { chatId: "chat-1", runId: "run-a", failedReason: "run:running:40" });

  h.reader.noteLoaded("chat-1", "run-a", 41);
  await h.advance(1_000);
  h.reader.request("chat-1", "run-a", { reason: "run:running:41", skipIfLoadedAt: 41 });
  assert.equal(h.reads.length, 1, "nothing new to read");
  assert.deepEqual(last(h.settled), { chatId: "chat-1", runId: "run-a", failedReason: null });
});

test("a finished helper with nothing saved yet is read again until its final copy lands", async () => {
  const h = harness();
  h.reader.request("chat-1", "run-a", { reason: "final:7", skipIfLoadedAt: 7, final: true });
  h.reader.finish("run-a");
  h.reads[0]!.resolve(null);
  await h.flush();
  assert.deepEqual(last(h.settled), { chatId: "chat-1", runId: "run-a", failedReason: null }, "not a failure");

  // The run's own record asks again at the same revision: an empty answer did not count as read.
  h.reader.request("chat-1", "run-a", { reason: "run:completed:7", skipIfLoadedAt: 7, final: true });
  await h.advance(1_000);
  assert.equal(h.reads.length, 2);
  h.reads[1]!.resolve(transcript("run-a", 4, true));
  await h.flush();
  assert.equal(last(h.transcripts)?.transcript.revision, 4, "the unfinished copy still shows meanwhile");

  await h.advance(1_999);
  assert.equal(h.reads.length, 2, "each read waits longer than the one before");
  await h.advance(1);
  assert.equal(h.reads.length, 3);
  h.reads[2]!.resolve(transcript("run-a", 5));
  await h.flush();
  assert.equal(last(h.transcripts)?.transcript.revision, 5);

  // The final copy answers: nothing more is read, and asking again for that revision is skipped.
  await h.advance(60_000);
  h.reader.request("chat-1", "run-a", { reason: "final:7", skipIfLoadedAt: 7, final: true });
  await h.advance(60_000);
  assert.equal(h.reads.length, 3);
});

test("a finished helper whose final copy never lands is read a bounded number of times", async () => {
  const h = harness();
  h.reader.request("chat-1", "run-a", { reason: "final:3", skipIfLoadedAt: 3, final: true });
  for (let index = 0; index < SUBAGENT_TRANSCRIPT_FINAL_READ_ATTEMPTS; index += 1) {
    assert.equal(h.reads.length, index + 1);
    h.reads[index]!.resolve(transcript("run-a", 2, true));
    await h.flush();
    await h.advance(60_000);
  }
  assert.equal(h.reads.length, SUBAGENT_TRANSCRIPT_FINAL_READ_ATTEMPTS, "the last copy is accepted");
  assert.equal(h.settled.every((entry) => entry.failedReason === null), true);

  // Accepted at that revision, so the same ask is not read again.
  h.reader.request("chat-1", "run-a", { reason: "run:completed:3", skipIfLoadedAt: 3, final: true });
  await h.advance(60_000);
  assert.equal(h.reads.length, SUBAGENT_TRANSCRIPT_FINAL_READ_ATTEMPTS);
});

test("a running helper's unfinished copy answers its read", async () => {
  const h = harness();
  h.reader.request("chat-1", "run-a", { reason: "run:running:3", skipIfLoadedAt: 3 });
  h.reads[0]!.resolve(transcript("run-a", 2, true));
  await h.flush();
  await h.advance(60_000);
  assert.equal(h.reads.length, 1);
});
