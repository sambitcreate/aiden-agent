import assert from "node:assert/strict";
import test from "node:test";
import {
  PiRuntimeEventChannel,
  initialPiRuntimeEventState,
  projectPiRuntimeAgentEvent,
  reducePiRuntimeEventState,
  type PiRuntimeEventEnvelope,
} from "./pi-runtime-events.js";

const identity = {
  runId: "run-one",
  sessionId: "chat-one",
  lane: "foreground" as const,
};

test("canonical Pi runtime events keep monotonic run, attempt, and turn identity", async () => {
  const observed: PiRuntimeEventEnvelope[] = [];
  const observerErrors: string[] = [];
  let clock = 100;
  const channel = new PiRuntimeEventChannel(
    identity,
    (error) => observerErrors.push(error instanceof Error ? error.message : String(error)),
    () => ++clock,
  );
  identity.runId = "MUTATED_AFTER_CONSTRUCTION";
  channel.observe(async (event) => {
    observed.push(event);
    if (event.sequence === 2) throw new Error("projection failed");
  });

  channel.emit({ type: "run_start", input: "append-and-run" });
  channel.setAttempt(1);
  channel.emit({
    type: "agent_event",
    event: { type: "turn_start" },
    durable: false,
  });
  channel.emit({
    type: "agent_event",
    event: {
      type: "message_end",
      messageRole: "user",
    },
    durable: true,
  });
  channel.emit({ type: "retry", attempt: 2, reason: "provider", delayMs: 5 });
  channel.setAttempt(2);
  channel.emit({ type: "run_end", outcome: "completed", attempts: 2 });
  await channel.settleObservers();

  assert.deepEqual(
    observed.map((event) => event.sequence),
    [1, 2, 3, 4, 5],
  );
  assert.equal(observed[1]?.turn?.id, "run-one:turn:0");
  assert.equal(observed[1]?.identity.runId, "run-one");
  assert.equal(observed[4]?.attempt, 2);
  assert.deepEqual(observerErrors, ["projection failed"]);
  assert.deepEqual(channel.snapshot(), {
    lastSequence: 5,
    phase: "settled",
    attempt: 2,
    turnIndex: 0,
    durableMessageCount: 1,
    activeToolCalls: new Set(),
    outcome: { type: "run_end", outcome: "completed", attempts: 2 },
  });
});

test("canonical Pi events omit private reasoning, tool payloads, and provider errors", () => {
  const reasoning = projectPiRuntimeAgentEvent({
    type: "message_update",
    message: {
      role: "assistant",
      content: [{ type: "thinking", thinking: "PRIVATE_REASONING" }],
      api: "openai-responses",
      provider: "openai",
      model: "test",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 1,
    },
    assistantMessageEvent: {
      type: "thinking_delta",
      contentIndex: 0,
      delta: "PRIVATE_REASONING",
      partial: {
        role: "assistant",
        content: [],
        api: "openai-responses",
        provider: "openai",
        model: "test",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 1,
      },
    },
  });
  const tool = projectPiRuntimeAgentEvent({
    type: "tool_execution_end",
    toolCallId: "call-1",
    toolName: "read_file",
    result: { content: [{ type: "text", text: "PRIVATE_TOOL_RESULT" }] },
    isError: true,
  });
  assert.doesNotMatch(JSON.stringify({ reasoning, tool }), /PRIVATE_/u);
  assert.deepEqual(reasoning, {
    type: "message_update",
    update: "thinking_delta",
    contentIndex: 0,
  });
  assert.deepEqual(tool, {
    type: "tool_execution_end",
    toolCallId: "call-1",
    toolName: "read_file",
    isError: true,
  });
});

test("the critical canonical reducer rejects sequence gaps before projection", () => {
  assert.throws(
    () =>
      reducePiRuntimeEventState(initialPiRuntimeEventState(), {
        version: 1,
        identity,
        sequence: 2,
        attempt: 0,
        turn: null,
        timestamp: 1,
        payload: { type: "run_start", input: "continue-durable-tail" },
      }),
    /not contiguous/u,
  );
});

test("closing the canonical channel aborts passive observer work", async () => {
  const channel = new PiRuntimeEventChannel(identity);
  let observerAborted = false;
  channel.observe(async (_event, signal) => {
    await new Promise<void>((resolve) => {
      if (signal.aborted) {
        observerAborted = true;
        resolve();
        return;
      }
      signal.addEventListener(
        "abort",
        () => {
          observerAborted = true;
          resolve();
        },
        { once: true },
      );
    });
  });
  channel.emit({ type: "run_start", input: "continue-durable-tail" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  channel.close();
  await channel.settleObservers();
  assert.equal(observerAborted, true);
});
