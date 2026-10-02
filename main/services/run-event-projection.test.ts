import assert from "node:assert/strict";
import test from "node:test";
import {
  createRunProjectionState,
  projectRunContentNotification,
  type RunProjectionContext,
} from "./run-event-projection.js";

function context(overrides: Partial<RunProjectionContext> = {}): RunProjectionContext {
  return {
    chatId: "chat-1",
    turnId: "turn-1",
    lastSequence: 0,
    cancelRequested: false,
    cancellationSource: "device",
    ...overrides,
  };
}

const cancelledTimeline = {
  version: 3,
  generationId: "stream-1",
  status: "cancelled",
  startedAt: 1_000,
  finishedAt: 2_000,
  cancellationOrigin: "user_stop",
  steps: [],
};

test("a text delta projects a running text_delta event", () => {
  const result = projectRunContentNotification(
    createRunProjectionState(),
    "chat:delta",
    { delta: "Hello" },
    context(),
  );
  assert.deepEqual(result, {
    kind: "event",
    type: "text_delta",
    payload: { text: "Hello" },
    terminal: false,
    state: "running",
  });
});

test("empty or non-text deltas are handled without producing an event", () => {
  const state = createRunProjectionState();
  assert.deepEqual(
    projectRunContentNotification(state, "chat:delta", { delta: "" }, context()),
    { kind: "ignored" },
  );
  assert.deepEqual(
    projectRunContentNotification(state, "chat:reasoning-delta", { delta: 42 }, context()),
    { kind: "ignored" },
  );
});

test("a reasoning delta projects reasoning_delta and status projects running", () => {
  const state = createRunProjectionState();
  assert.deepEqual(
    projectRunContentNotification(state, "chat:reasoning-delta", { delta: "Think" }, context()),
    { kind: "event", type: "reasoning_delta", payload: { text: "Think" }, terminal: false, state: "running" },
  );
  assert.deepEqual(
    projectRunContentNotification(state, "chat:status", { status: "anything" }, context()),
    { kind: "event", type: "status", payload: { state: "running" }, terminal: false, state: "running" },
  );
});

test("a reset delta projects a reconciling snapshot that skips past its own sequence", () => {
  const result = projectRunContentNotification(
    createRunProjectionState(),
    "chat:delta",
    { reset: true, delta: "ignored text" },
    context({ chatId: "chat-9", turnId: "turn-9", lastSequence: 7 }),
  );
  assert.deepEqual(result, {
    kind: "event",
    type: "snapshot",
    payload: { chatId: "chat-9", turnId: "turn-9", nextSequence: 9 },
    terminal: false,
    state: "reconciling",
  });
});

test("tool calls and results pair by name in call order", () => {
  const state = createRunProjectionState();
  const project = (payload: Record<string, unknown>) =>
    projectRunContentNotification(state, "chat:tool", payload, context());

  assert.deepEqual(project({ phase: "call", toolName: "read_file" }), {
    kind: "event",
    type: "tool_started",
    payload: { toolId: "tool_1", name: "read_file" },
    terminal: false,
    state: "running",
  });
  assert.deepEqual(project({ phase: "call", toolName: "read_file" }), {
    kind: "event",
    type: "tool_started",
    payload: { toolId: "tool_2", name: "read_file" },
    terminal: false,
    state: "running",
  });
  assert.deepEqual(project({ phase: "result", toolName: "read_file" }), {
    kind: "event",
    type: "tool_finished",
    payload: { toolId: "tool_1", status: "succeeded" },
    terminal: false,
    state: "running",
  });
  assert.deepEqual(project({ phase: "error", toolName: "read_file" }), {
    kind: "event",
    type: "tool_finished",
    payload: { toolId: "tool_2", status: "failed" },
    terminal: false,
    state: "running",
  });
  // A result whose call was never seen mints the next id rather than reusing one.
  assert.deepEqual(project({ phase: "result", toolName: "write_file" }), {
    kind: "event",
    type: "tool_finished",
    payload: { toolId: "tool_3", status: "succeeded" },
    terminal: false,
    state: "running",
  });
});

test("tool projection state is per run", () => {
  const first = createRunProjectionState();
  const second = createRunProjectionState();
  projectRunContentNotification(first, "chat:tool", { phase: "call", toolName: "a" }, context());
  const result = projectRunContentNotification(
    second,
    "chat:tool",
    { phase: "call", toolName: "a" },
    context(),
  );
  assert.equal(result.kind, "event");
  assert.deepEqual(result.kind === "event" ? result.payload : null, { toolId: "tool_1", name: "a" });
});

test("a tool without a name is labelled Tool", () => {
  const result = projectRunContentNotification(
    createRunProjectionState(),
    "chat:tool",
    { phase: "call" },
    context(),
  );
  assert.deepEqual(result.kind === "event" ? result.payload : null, { toolId: "tool_1", name: "Tool" });
});

test("chat:done with cancelled true is a terminal server cancellation by default", () => {
  const result = projectRunContentNotification(
    createRunProjectionState(),
    "chat:done",
    { cancelled: true, chat: { messages: [{ id: "assistant-1", role: "assistant" }] } },
    context(),
  );
  assert.deepEqual(result, {
    kind: "event",
    type: "cancelled",
    payload: { source: "server" },
    terminal: true,
    state: "cancelled",
  });
});

test("chat:done with a cancelled timeline uses the requested cancellation source", () => {
  const result = projectRunContentNotification(
    createRunProjectionState(),
    "chat:done",
    { timeline: cancelledTimeline },
    context({ cancelRequested: true, cancellationSource: "device" }),
  );
  assert.deepEqual(result, {
    kind: "event",
    type: "cancelled",
    payload: { source: "device" },
    terminal: true,
    state: "cancelled",
  });
});

test("a requested cancel turns an otherwise successful chat:done into cancelled", () => {
  const result = projectRunContentNotification(
    createRunProjectionState(),
    "chat:done",
    { chat: { messages: [{ id: "assistant-1", role: "assistant" }] } },
    context({ cancelRequested: true, cancellationSource: "server" }),
  );
  assert.deepEqual(result, {
    kind: "event",
    type: "cancelled",
    payload: { source: "server" },
    terminal: true,
    state: "cancelled",
  });
});

test("chat:done names the last assistant message", () => {
  const result = projectRunContentNotification(
    createRunProjectionState(),
    "chat:done",
    {
      chat: {
        messages: [
          { id: "assistant-old", role: "assistant" },
          { id: "user-1", role: "user" },
          { id: "assistant-new", role: "assistant" },
          { id: "user-2", role: "user" },
        ],
      },
    },
    context(),
  );
  assert.deepEqual(result, {
    kind: "event",
    type: "done",
    payload: { messageId: "assistant-new" },
    terminal: true,
    state: "done",
  });
});

test("chat:done without an assistant message falls back to the turn id", () => {
  const result = projectRunContentNotification(
    createRunProjectionState(),
    "chat:done",
    { chat: { messages: [{ id: "user-1", role: "user" }] } },
    context({ turnId: "turn-42" }),
  );
  assert.deepEqual(result, {
    kind: "event",
    type: "done",
    payload: { messageId: "assistant_turn-42" },
    terminal: true,
    state: "done",
  });
});

test("chat:error is a terminal internal error unless the run was cancelled", () => {
  assert.deepEqual(
    projectRunContentNotification(
      createRunProjectionState(),
      "chat:error",
      { error: "provider exploded with secret details" },
      context(),
    ),
    {
      kind: "event",
      type: "error",
      payload: { code: "internal_error", message: "The model provider could not complete this response." },
      terminal: true,
      state: "error",
    },
  );
  assert.deepEqual(
    projectRunContentNotification(
      createRunProjectionState(),
      "chat:error",
      { cancelled: true },
      context(),
    ),
    { kind: "event", type: "cancelled", payload: { source: "server" }, terminal: true, state: "cancelled" },
  );
});

test("a valid timeline projects a running timeline event and an invalid one is ignored", () => {
  const timeline = {
    version: 3,
    generationId: "stream-1",
    status: "running",
    startedAt: 1_000,
    steps: [],
  };
  assert.deepEqual(
    projectRunContentNotification(createRunProjectionState(), "chat:timeline", { timeline }, context()),
    { kind: "event", type: "timeline", payload: { timeline }, terminal: false, state: "running" },
  );
  assert.deepEqual(
    projectRunContentNotification(
      createRunProjectionState(),
      "chat:timeline",
      { timeline: { version: 3 } },
      context(),
    ),
    { kind: "ignored" },
  );
});

test("approval, questionnaire and unknown channels are left to the caller", () => {
  const state = createRunProjectionState();
  for (const channel of ["chat:approval", "chat:questionnaire", "chat:todo"] as const) {
    assert.deepEqual(
      projectRunContentNotification(state, channel, { approvalId: "approval-1" }, context()),
      { kind: "unhandled" },
    );
  }
});
