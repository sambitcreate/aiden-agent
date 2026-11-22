import assert from "node:assert/strict";
import test from "node:test";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import {
  accumulateSubagentTranscriptUpdate,
  mergeSubagentTranscript,
  type SubagentTranscriptMessageEntry,
  type SubagentTranscriptUpdateV1,
  type SubagentTranscriptV1,
} from "../../../renderer/shared/subagent-transcript.js";
import { recordSubagentTranscripts } from "./subagent-supervisor-core.js";
import { SubagentTranscriptRecorder } from "./subagent-transcript-recorder.js";

// Assembled at runtime so no literal key shape sits in the source.
const FAKE_KEY = ["sk", "proj", "Q7wX2mN9pL4kR8tV1yB6cZ3hJ5gF0dS7aE2uI9oP"].join("-");

function fakeClock() {
  let now = 10_000;
  let timers: Array<{ callback: () => void; at: number }> = [];
  return {
    now: () => now,
    setTimer(callback: () => void, ms: number) {
      const timer = { callback, at: now + ms };
      timers.push(timer);
      return timer;
    },
    clearTimer(handle: unknown) {
      timers = timers.filter((timer) => timer !== handle);
    },
    pending: () => timers.length,
    advance(ms: number) {
      now += ms;
      const due = timers.filter((timer) => timer.at <= now);
      timers = timers.filter((timer) => timer.at > now);
      for (const timer of due) timer.callback();
    },
  };
}

function memorySink() {
  const saved: Array<{ transcript: SubagentTranscriptV1; final: boolean }> = [];
  const published: SubagentTranscriptUpdateV1[] = [];
  const order: string[] = [];
  return {
    saved,
    published,
    order,
    sink: {
      async persist(transcript: SubagentTranscriptV1, final: boolean) {
        order.push(`persist:${transcript.revision}`);
        saved.push({ transcript, final });
      },
      publish(update: SubagentTranscriptUpdateV1) {
        order.push(`publish:${update.revision}`);
        published.push(update);
      },
    },
  };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

function messages(transcript: SubagentTranscriptV1): SubagentTranscriptMessageEntry[] {
  return transcript.entries.slice(1) as SubagentTranscriptMessageEntry[];
}

test("a helper run of a task, two tool calls and an answer is recorded in order", async () => {
  const clock = fakeClock();
  const memory = memorySink();
  const recorder = new SubagentTranscriptRecorder({
    runId: "run-1",
    task: "Find where the retry limit is read.",
    sink: memory.sink,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });

  // Pi agent events, as the desktop helper emits them.
  const events = [
    { type: "message_start", message: { role: "assistant", content: [] } },
    { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "I will read " } },
    { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "the config files." } },
    {
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "I will read the config files." }] },
    },
    { type: "tool_execution_start", toolCallId: "provider-a", toolName: "read_file", args: { path: "src/config.ts" } },
    { type: "tool_execution_start", toolCallId: "provider-b", toolName: "read_file", args: { path: "src/retry.ts" } },
    { type: "tool_execution_end", toolCallId: "provider-a", isError: false },
    { type: "tool_execution_end", toolCallId: "provider-b", isError: true },
    { type: "message_start", message: { role: "assistant", content: [] } },
    { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "The limit is read in src/retry.ts." } },
    {
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "The limit is read in src/retry.ts." }] },
    },
  ] as unknown as AgentEvent[];
  for (const event of events) {
    recorder.observe(event);
    clock.advance(100);
    await settle();
  }
  await recorder.finish("completed");

  const final = memory.saved[memory.saved.length - 1]!;
  assert.equal(final.final, true);
  assert.equal(memory.saved.filter((entry) => entry.final).length, 1, "only the last write is final");
  assert.deepEqual(final.transcript.entries[0], { kind: "task", text: "Find where the retry limit is read." });
  const [first, second] = messages(final.transcript);
  assert.equal(first!.text, "I will read the config files.");
  assert.deepEqual(
    first!.steps.map((step) => step.kind === "tool" && [step.label, step.target, step.status]),
    [
      ["Read file", "src/config.ts", "completed"],
      ["Read file", "src/retry.ts", "failed"],
    ],
  );
  assert.equal(second!.text, "The limit is read in src/retry.ts.");
  assert.ok(first!.finishedAt !== undefined && second!.finishedAt !== undefined);

  // Every revision is saved before it is streamed, and revisions chain.
  for (const update of memory.published) {
    assert.ok(memory.order.indexOf(`persist:${update.revision}`) < memory.order.indexOf(`publish:${update.revision}`));
  }
  memory.published.forEach((update, index) => {
    assert.equal(update.baseRevision, index === 0 ? 0 : memory.published[index - 1]!.revision);
  });

  // A window that saw the whole stream ends up with exactly the saved copy.
  let live: SubagentTranscriptUpdateV1 | undefined;
  for (const update of memory.published) live = accumulateSubagentTranscriptUpdate(live, update);
  assert.deepEqual(mergeSubagentTranscript(null, live), { transcript: final.transcript, complete: true });

  // A window that joined halfway converges from the saved copy it read.
  const half = Math.floor(memory.published.length / 2);
  const savedAtJoin = memory.saved[half - 1]!.transcript;
  let joined: SubagentTranscriptUpdateV1 | undefined;
  for (const update of memory.published.slice(half)) joined = accumulateSubagentTranscriptUpdate(joined, update);
  assert.deepEqual(mergeSubagentTranscript(savedAtJoin, joined), { transcript: final.transcript, complete: true });

  // Nothing is written after the helper finished.
  recorder.textDelta("late");
  await recorder.finish("completed");
  assert.equal(memory.saved[memory.saved.length - 1], final);
});

test("bursts of streamed text are batched to about four writes a second", async () => {
  const clock = fakeClock();
  const memory = memorySink();
  const recorder = new SubagentTranscriptRecorder({
    runId: "run-1",
    task: "Summarize.",
    sink: memory.sink,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  await settle();
  assert.equal(memory.saved.length, 1, "the task is written straight away");

  recorder.messageStarted();
  for (let index = 0; index < 50; index += 1) recorder.textDelta(`word${index} `);
  await settle();
  assert.equal(memory.saved.length, 1, "nothing more until the interval passes");
  assert.equal(clock.pending(), 1);
  clock.advance(250);
  await settle();
  assert.equal(memory.saved.length, 2);
  assert.match(messages(memory.saved[1]!.transcript)[0]!.text, /word0 .* word49$/u);

  // A change with nothing new to show writes nothing.
  recorder.messageEnded(messages(memory.saved[1]!.transcript)[0]!.text);
  clock.advance(250);
  await settle();
  assert.equal(memory.saved.length, 2);
});

test("helper text hides a secret but keeps file paths readable", async () => {
  const memory = memorySink();
  const recorder = new SubagentTranscriptRecorder({
    runId: "run-1",
    task: `Check whether ${FAKE_KEY} is still used.`,
    sink: memory.sink,
    setTimer: () => null,
    clearTimer: () => {},
  });
  recorder.messageStarted();
  recorder.textDelta(`I found ${FAKE_KEY} in /Users/sam/project/src/config.ts at line 4.`);
  recorder.toolStarted("call-a", "read_file", { path: "src/config.ts" });
  recorder.toolFinished("call-a", "completed");
  await recorder.finish("completed");

  const final = memory.saved[memory.saved.length - 1]!.transcript;
  const json = JSON.stringify(final);
  assert.equal(json.includes(FAKE_KEY), false);
  assert.equal(JSON.stringify(memory.published).includes(FAKE_KEY), false);
  const [entry] = messages(final);
  assert.match(entry!.text, /\/Users\/sam\/project\/src\/config\.ts at line 4\./u);
  assert.match(entry!.text, /\[REDACTED CREDENTIAL\]/u);
  assert.match(final.entries[0]!.text, /\[REDACTED CREDENTIAL\]/u);
  // The step that followed the text still points at the end of the shown text.
  assert.equal(entry!.steps[0]!.contentOffset, entry!.text.length);
});

test("a recorder over its size cap drops the oldest steps and marks itself trimmed", async () => {
  const memory = memorySink();
  const recorder = new SubagentTranscriptRecorder({
    runId: "run-1",
    task: "Read everything.",
    sink: memory.sink,
    maxBytes: 12_000,
    setTimer: () => null,
    clearTimer: () => {},
  });
  for (let message = 0; message < 4; message += 1) {
    recorder.messageStarted();
    recorder.textDelta(`Message ${message}.`);
    for (let index = 0; index < 20; index += 1) {
      const id = `m${message}-t${index}`;
      recorder.toolStarted(id, "read_file", { path: `src/folder-${message}/file-${index}.ts` });
      recorder.toolFinished(id, "completed");
    }
  }
  await recorder.finish("completed");
  const final = memory.saved[memory.saved.length - 1]!.transcript;
  assert.equal(final.trimmed, true);
  assert.ok(Buffer.byteLength(JSON.stringify(final)) <= 12_000);
  const kept = messages(final).map((entry) => entry.steps.length);
  assert.equal(kept[0], 0, "the oldest message lost its steps first");
  assert.equal(kept[kept.length - 1], 20, "the newest message kept all of its steps");
  assert.deepEqual(
    messages(final).map((entry) => entry.text),
    ["Message 0.", "Message 1.", "Message 2.", "Message 3."],
  );
  assert.equal(memory.published[memory.published.length - 1]!.trimmed, true);
});

test("a failing save is reported and the stream carries on", async () => {
  const errors: unknown[] = [];
  const published: SubagentTranscriptUpdateV1[] = [];
  const recorder = new SubagentTranscriptRecorder({
    runId: "run-1",
    task: "Task.",
    sink: {
      persist: async () => {
        throw new Error("disk full");
      },
      publish: (update) => published.push(update),
    },
    onError: (error) => errors.push(error),
    setTimer: () => null,
    clearTimer: () => {},
  });
  recorder.messageStarted();
  recorder.textDelta("Hello.");
  await recorder.finish("failed");
  assert.ok(errors.length >= 1);
  const last = published[published.length - 1]!;
  assert.equal(last.entryCount, 2);
  assert.equal(last.changes.find((change) => change.index === 1)?.entry.text, "Hello.");
});

test("the supervisor wrapper settles each child's conversation before returning", async () => {
  const memory = memorySink();
  const created: Array<{ runId: string; chatId: string; task: string }> = [];
  const runChild = recordSubagentTranscripts(
    async (input) => {
      input.transcript?.messageStarted();
      input.transcript?.textDelta("Done looking.");
      return { status: "completed" } as never;
    },
    (input) => {
      created.push(input);
      return new SubagentTranscriptRecorder({ ...input, sink: memory.sink, setTimer: () => null, clearTimer: () => {} });
    },
  );
  await runChild({ runId: "run-1", authority: { chatId: "chat-1" }, request: { task: "Look." } } as never);
  assert.deepEqual(created, [{ runId: "run-1", chatId: "chat-1", task: "Look." }]);
  const last = memory.saved[memory.saved.length - 1]!;
  assert.equal(last.final, true);
  assert.equal(messages(last.transcript)[0]!.text, "Done looking.");

  // A child that throws still gets a final write, and the error passes through.
  const failure = new Error("child crashed");
  const failing = recordSubagentTranscripts(
    async () => {
      throw failure;
    },
    (input) => new SubagentTranscriptRecorder({ ...input, sink: memory.sink, setTimer: () => null, clearTimer: () => {} }),
  );
  const before = memory.saved.length;
  await assert.rejects(
    failing({ runId: "run-2", authority: { chatId: "chat-1" }, request: { task: "Look." } } as never),
    failure,
  );
  assert.equal(memory.saved[memory.saved.length - 1]!.transcript.runId, "run-2");
  assert.ok(memory.saved.length > before);
});
