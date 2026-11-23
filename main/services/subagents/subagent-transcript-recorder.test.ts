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
import { SubagentTranscriptRecordings } from "./subagent-supervisor-core.js";
import {
  SUBAGENT_TRANSCRIPT_FINAL_SAVE_ATTEMPTS,
  SUBAGENT_TRANSCRIPT_RETRIES_BEFORE_PAUSE,
  SubagentTranscriptRecorder,
  streamingVisibleText,
} from "./subagent-transcript-recorder.js";

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

test("a failed save streams nothing, keeps the change and tries again", async () => {
  const clock = fakeClock();
  const errors: unknown[] = [];
  const saved: SubagentTranscriptV1[] = [];
  const published: SubagentTranscriptUpdateV1[] = [];
  let failing = true;
  const recorder = new SubagentTranscriptRecorder({
    runId: "run-1",
    task: "Task.",
    sink: {
      persist: async (transcript) => {
        if (failing) throw new Error("disk full");
        saved.push(transcript);
      },
      publish: (update) => published.push(update),
    },
    onError: (error) => errors.push(error),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  await settle();
  recorder.messageStarted();
  recorder.textDelta("Hello there. ");
  clock.advance(250);
  await settle();
  // The retry backs off, so a second failure needs a longer wait.
  clock.advance(1_000);
  await settle();
  assert.equal(errors.length, 1, "a run of failed saves is reported once");
  assert.equal(published.length, 0, "nothing is streamed past what is saved");

  failing = false;
  clock.advance(5_000);
  await settle();
  await recorder.finish("completed");
  assert.ok(saved.length >= 1);
  assert.equal(saved[0]!.revision, 1, "the first save that worked is revision 1");
  // The stream starts from nothing and chains, so a window can follow it.
  published.forEach((update, index) => {
    assert.equal(update.baseRevision, index === 0 ? 0 : published[index - 1]!.revision);
  });
  let live: SubagentTranscriptUpdateV1 | undefined;
  for (const update of published) live = accumulateSubagentTranscriptUpdate(live, update);
  assert.deepEqual(mergeSubagentTranscript(null, live), { transcript: saved[saved.length - 1]!, complete: true });
  assert.equal(messages(saved[saved.length - 1]!)[0]!.text, "Hello there.");
});

test("the final save is retried a bounded number of times", async () => {
  let attempts = 0;
  const errors: unknown[] = [];
  const recorder = new SubagentTranscriptRecorder({
    runId: "run-1",
    task: "Task.",
    sink: {
      persist: async (_transcript, final) => {
        if (final) attempts += 1;
        throw new Error("disk full");
      },
    },
    onError: (error) => errors.push(error),
    intervalMs: 1,
  });
  recorder.messageStarted();
  recorder.textDelta("Hello.");
  // The retry waits do not hold the process open, so the test holds it.
  const keepAlive = setInterval(() => {}, 1_000);
  try {
    await recorder.finish("failed");
  } finally {
    clearInterval(keepAlive);
  }
  assert.equal(attempts, 3);
  // Finishing again returns the same settlement and does not try again.
  await recorder.finish("failed");
  assert.equal(attempts, 3);
});

test("a store that keeps failing is reported once and left alone until something changes", async () => {
  const clock = fakeClock();
  const errors: unknown[] = [];
  let attempts = 0;
  let failing = true;
  const recorder = new SubagentTranscriptRecorder({
    runId: "run-1",
    task: "Task.",
    sink: {
      persist: async () => {
        attempts += 1;
        if (failing) throw new Error("permission denied");
      },
    },
    onError: (error) => errors.push(error),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  await settle();
  recorder.messageStarted();
  recorder.textDelta("Hello.");
  // Ten minutes with no new events.
  for (let minute = 0; minute < 600; minute += 1) {
    clock.advance(1_000);
    await settle();
  }
  assert.equal(attempts, SUBAGENT_TRANSCRIPT_RETRIES_BEFORE_PAUSE, "retries stop after a few failures");
  assert.equal(clock.pending(), 0, "no retry stays armed");
  assert.equal(errors.length, 1, "the failing store is reported once");

  // A new event tries again, and the save that works carries everything.
  failing = false;
  recorder.textDelta(" More.");
  clock.advance(10_000);
  await settle();
  assert.equal(attempts, SUBAGENT_TRANSCRIPT_RETRIES_BEFORE_PAUSE + 1);
  assert.equal(errors.length, 1);

  // A later failure after a success is a new run, so it is reported again.
  failing = true;
  recorder.textDelta(" Again.");
  clock.advance(10_000);
  await settle();
  assert.equal(errors.length, 2);
});

test("the final save's retry wait does not hold the process open", async () => {
  let unrefs = 0;
  const recorder = new SubagentTranscriptRecorder({
    runId: "run-1",
    task: "Task.",
    sink: {
      persist: async (_transcript, final) => {
        if (final) throw new Error("disk full");
      },
    },
    intervalMs: 1,
    setTimer: (callback, ms) => {
      // Counted but kept referenced, so the test itself stays alive.
      const handle = setTimeout(callback, ms);
      handle.unref = () => {
        unrefs += 1;
        return handle;
      };
      return handle;
    },
  });
  recorder.messageStarted();
  await recorder.finish("failed");
  assert.equal(unrefs, SUBAGENT_TRANSCRIPT_FINAL_SAVE_ATTEMPTS - 1);
});

test("a slow save keeps one save in flight and the throttle intact", async () => {
  const clock = fakeClock();
  let inFlight = 0;
  let most = 0;
  let saves = 0;
  const releases: Array<() => void> = [];
  const recorder = new SubagentTranscriptRecorder({
    runId: "run-1",
    task: "Task.",
    sink: {
      persist: () => {
        inFlight += 1;
        saves += 1;
        most = Math.max(most, inFlight);
        return new Promise<void>((resolve) => releases.push(() => {
          inFlight -= 1;
          resolve();
        }));
      },
    },
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  recorder.messageStarted();
  // Two seconds of streaming while the first save is stuck.
  for (let tick = 0; tick < 20; tick += 1) {
    recorder.textDelta(`word${tick} `);
    clock.advance(100);
    await settle();
  }
  assert.equal(saves, 1, "no save starts while one is in flight");
  assert.equal(clock.pending(), 0, "no timer is armed while a save runs");
  releases.shift()!();
  await settle();
  clock.advance(250);
  await settle();
  assert.equal(saves, 2, "the next save waits for the first, then picks up everything");
  releases.shift()!();
  await settle();
  const done = recorder.finish("completed");
  await settle();
  while (releases.length > 0) {
    releases.shift()!();
    await settle();
  }
  await done;
  assert.equal(most, 1);
});

test("a complete or cut-off private key never reaches a save or the stream", async () => {
  // Assembled at runtime so no key block sits in the source.
  const begin = ["-----BEGIN", "PRIVATE", "KEY-----"].join(" ");
  const end = ["-----END", "PRIVATE", "KEY-----"].join(" ");
  const body = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7";
  for (const [label, text] of [
    ["complete", `Found:\n${begin}\n${body}\n${body}\n${end}\nDone.`],
    ["cut off", `Found:\n${begin}\n${body}\n${body}`],
  ] as const) {
    const clock = fakeClock();
    const memory = memorySink();
    const recorder = new SubagentTranscriptRecorder({
      runId: "run-1",
      task: "Look for keys.",
      sink: memory.sink,
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    recorder.messageStarted();
    // Stream it a few characters at a time, saving in between.
    for (let index = 0; index < text.length; index += 7) {
      recorder.textDelta(text.slice(index, index + 7));
      clock.advance(250);
      await settle();
    }
    await recorder.finish("completed");
    const everything = JSON.stringify(memory.saved) + JSON.stringify(memory.published);
    assert.equal(everything.includes(body.slice(0, 20)), false, `${label}: no key body`);
    assert.equal(everything.includes("BEGIN PRIVATE"), false, `${label}: no key header`);
    const final = messages(memory.saved[memory.saved.length - 1]!.transcript)[0]!.text;
    assert.match(final, /^Found:\n\[REDACTED PRIVATE KEY\]/u, label);
    if (label === "complete") assert.match(final, /Done\.$/u);
  }
});

test("streaming text holds back an unfinished word and an open key block", () => {
  assert.equal(streamingVisibleText("I found sk-pro"), "I found ");
  assert.equal(streamingVisibleText("Reading the file. "), "Reading the file. ");
  assert.equal(streamingVisibleText("Key:\n-----BEG"), "Key:\n");
  assert.equal(streamingVisibleText("Key:\n-----BEGIN RSA PRIVATE KEY-----\nMIIE abc "), "Key:\n");
  const closed = "A\n-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----\nNext ";
  assert.equal(streamingVisibleText(closed), closed);
});

test("a key in a tool command or search is hidden in the step", async () => {
  const memory = memorySink();
  const recorder = new SubagentTranscriptRecorder({
    runId: "run-1",
    task: "Check the logs.",
    sink: memory.sink,
    setTimer: () => null,
    clearTimer: () => {},
  });
  recorder.messageStarted();
  recorder.toolStarted("call-a", "grep", { pattern: FAKE_KEY, path: "src/config" });
  recorder.toolFinished("call-a", "completed");
  recorder.toolStarted("call-b", "bash", { command: `curl -H "Authorization: Bearer ${FAKE_KEY}" https://example.test` });
  recorder.toolFinished("call-b", "completed");
  await recorder.finish("completed");
  const everything = JSON.stringify(memory.saved) + JSON.stringify(memory.published);
  assert.equal(everything.includes(FAKE_KEY), false);
  const steps = messages(memory.saved[memory.saved.length - 1]!.transcript)[0]!.steps;
  assert.equal(steps.length, 2);
  // The path a search runs in stays readable.
  assert.match(JSON.stringify(steps[0]), /src\/config/u);
});

test("a finished file edit shows its line counts", async () => {
  const memory = memorySink();
  const recorder = new SubagentTranscriptRecorder({
    runId: "run-1",
    task: "Fix it.",
    sink: memory.sink,
    setTimer: () => null,
    clearTimer: () => {},
  });
  recorder.observe({ type: "message_start", message: { role: "assistant", content: [] } } as unknown as AgentEvent);
  recorder.observe({ type: "tool_execution_start", toolCallId: "call-a", toolName: "edit_file", args: { path: "src/a.ts", old_string: "a", new_string: "b" } } as unknown as AgentEvent);
  recorder.observe({
    type: "tool_execution_end",
    toolCallId: "call-a",
    toolName: "edit_file",
    isError: false,
    result: { content: [], details: { kind: "file_line_changes", version: 1, additions: 3, deletions: 1 } },
  } as unknown as AgentEvent);
  await recorder.finish("completed");
  const [step] = messages(memory.saved[memory.saved.length - 1]!.transcript)[0]!.steps;
  assert.equal(step?.kind, "tool");
  assert.deepEqual(step?.kind === "tool" ? step.lineChanges : undefined, { additions: 3, deletions: 1 });
});

test("a tool call shows as pending while its arguments stream, then runs in place", async () => {
  const clock = fakeClock();
  const memory = memorySink();
  const recorder = new SubagentTranscriptRecorder({
    runId: "run-1",
    task: "Read.",
    sink: memory.sink,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  await settle();
  const toolCall = { type: "toolCall", id: "call-a", name: "read_file", arguments: {} };
  const emit = (event: unknown) => recorder.observe(event as AgentEvent);
  emit({ type: "message_start", message: { role: "assistant", content: [] } });
  emit({ type: "message_update", assistantMessageEvent: { type: "thinking_start" } });
  emit({ type: "message_update", assistantMessageEvent: { type: "thinking_end" } });
  emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Reading it now. " } });
  emit({ type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, partial: { content: [toolCall] } } });
  clock.advance(250);
  await settle();
  const pending = messages(memory.saved[memory.saved.length - 1]!.transcript)[0]!.steps;
  assert.deepEqual(pending.map((step) => [step.kind, step.kind === "tool" ? step.status : null]), [["thinking", null], ["tool", "pending"]]);

  emit({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "thinking", thinking: "" }, { type: "text", text: "Reading it now." }, toolCall] },
  });
  emit({ type: "tool_execution_start", toolCallId: "call-a", toolName: "read_file", args: { path: "src/a.ts" } });
  emit({ type: "tool_execution_update", toolCallId: "call-a" });
  emit({ type: "tool_execution_end", toolCallId: "call-a", toolName: "read_file", isError: false, result: { content: [] } });
  await recorder.finish("completed");
  const final = messages(memory.saved[memory.saved.length - 1]!.transcript)[0]!;
  assert.equal(final.text, "Reading it now.");
  const tools = final.steps.filter((step) => step.kind === "tool");
  assert.equal(tools.length, 1, "the pending step became the running tool, not a second one");
  assert.deepEqual(tools.map((step) => step.kind === "tool" && [step.label, step.target, step.status]), [["Read file", "src/a.ts", "completed"]]);
  // Anchored where the settled message puts them: thinking first, the tool after the text.
  assert.deepEqual(final.steps.map((step) => step.contentOffset), [0, final.text.length]);
});

for (const [status, expected] of [["cancelled", "cancelled"], ["failed", "failed"]] as const) {
  test(`a helper that ends ${status} marks its unfinished tools ${expected}`, async () => {
    const memory = memorySink();
    const recorder = new SubagentTranscriptRecorder({
      runId: "run-1",
      task: "Read.",
      sink: memory.sink,
      setTimer: () => null,
      clearTimer: () => {},
    });
    recorder.messageStarted();
    recorder.textDelta("Reading.");
    recorder.toolStarted("call-a", "read_file", { path: "src/a.ts" });
    await recorder.finish(status);
    const [entry] = messages(memory.saved[memory.saved.length - 1]!.transcript);
    const [step] = entry!.steps;
    assert.equal(step?.kind === "tool" ? step.status : undefined, expected);
    assert.ok(entry!.finishedAt !== undefined);
  });
}

test("content the size cap removed stays removed in later saves", async () => {
  const clock = fakeClock();
  const memory = memorySink();
  const recorder = new SubagentTranscriptRecorder({
    runId: "run-1",
    task: "Read everything.",
    sink: memory.sink,
    maxBytes: 8_000,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  for (let message = 0; message < 3; message += 1) {
    recorder.messageStarted();
    recorder.textDelta(`Message ${message}. `);
    for (let index = 0; index < 20; index += 1) {
      const id = `m${message}-t${index}`;
      recorder.toolStarted(id, "read_file", { path: `src/folder-${message}/file-${index}.ts` });
      recorder.toolFinished(id, "completed");
    }
    clock.advance(250);
    await settle();
  }
  const firstTrim = memory.saved.findIndex((entry) => entry.transcript.trimmed);
  assert.ok(firstTrim > 0, "the cap was reached while streaming");
  const droppedAt = memory.saved[firstTrim]!.transcript;
  const firstSteps = messages(droppedAt)[0]!.steps.length;
  // A later message ends with little to show; the dropped steps do not come back.
  recorder.messageStarted();
  recorder.textDelta("Short. ");
  await recorder.finish("completed");
  const final = memory.saved[memory.saved.length - 1]!.transcript;
  assert.ok(messages(final)[0]!.steps.length <= firstSteps);
  for (const entry of memory.saved.slice(firstTrim)) assert.ok(Buffer.byteLength(JSON.stringify(entry.transcript)) <= 8_000);
  let live: SubagentTranscriptUpdateV1 | undefined;
  for (const update of memory.published) live = accumulateSubagentTranscriptUpdate(live, update);
  assert.deepEqual(mergeSubagentTranscript(null, live), { transcript: final, complete: true });
});

test("the supervisor recordings hand back a result without waiting for the final save", async () => {
  const memory = memorySink();
  let release = (): void => undefined;
  const slowSink = {
    ...memory.sink,
    async persist(transcript: SubagentTranscriptV1, final: boolean) {
      if (final) await new Promise<void>((resolve) => { release = resolve; });
      await memory.sink.persist(transcript, final);
    },
  };
  const created: Array<{ runId: string; chatId: string; task: string }> = [];
  const recordings = new SubagentTranscriptRecordings((input) => {
    created.push(input);
    return new SubagentTranscriptRecorder({ ...input, sink: slowSink, setTimer: () => null, clearTimer: () => {} });
  });
  const runChild = recordings.wrap(async (input) => {
    input.transcript?.messageStarted();
    input.transcript?.textDelta("Done looking.");
    return { status: "completed" } as never;
  });
  const result = await runChild({ runId: "run-1", authority: { chatId: "chat-1" }, request: { task: "Look." } } as never);
  assert.deepEqual(result, { status: "completed" });
  assert.deepEqual(created, [{ runId: "run-1", chatId: "chat-1", task: "Look." }]);
  assert.equal(memory.saved.some((entry) => entry.final), false, "the final save is still running");

  const flushed = recordings.flush();
  await settle();
  release();
  await flushed;
  const last = memory.saved[memory.saved.length - 1]!;
  assert.equal(last.final, true);
  assert.equal(messages(last.transcript)[0]!.text, "Done looking.");
});

test("a child that throws or never returns still gets its final save", async () => {
  const memory = memorySink();
  const recordings = new SubagentTranscriptRecordings((input) =>
    new SubagentTranscriptRecorder({ ...input, sink: memory.sink, setTimer: () => null, clearTimer: () => {} }));
  const failure = new Error("child crashed");
  await assert.rejects(
    recordings.wrap(async () => { throw failure; })(
      { runId: "run-2", authority: { chatId: "chat-1" }, request: { task: "Look." } } as never),
    failure,
  );
  await recordings.flush();
  assert.equal(memory.saved[memory.saved.length - 1]!.transcript.runId, "run-2");
  assert.equal(memory.saved[memory.saved.length - 1]!.final, true);

  // A runner that never settles: the supervisor's seal settles it instead.
  void recordings.wrap(async (input) => {
    input.transcript?.messageStarted();
    input.transcript?.toolStarted("call-a", "read_file", { path: "src/a.ts" });
    return new Promise<never>(() => {});
  })({ runId: "run-3", authority: { chatId: "chat-1" }, request: { task: "Look." } } as never);
  await settle();
  recordings.settle("run-3", "cancelled");
  await recordings.flush();
  const last = memory.saved[memory.saved.length - 1]!;
  assert.equal(last.transcript.runId, "run-3");
  assert.equal(last.final, true);
  const [step] = messages(last.transcript)[0]!.steps;
  assert.equal(step?.kind === "tool" ? step.status : undefined, "cancelled");
});
