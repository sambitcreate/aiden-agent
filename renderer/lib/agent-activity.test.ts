import assert from "node:assert/strict";
import test from "node:test";
import { resolveAgentActivity, type ToolActivity } from "./agent-activity";

const idle = {
  isStarting: false,
  isStopping: false,
  streamingText: null,
  pendingApproval: false,
  toolActivity: null,
};

test("maps each active generation phase to a purposeful orb", () => {
  assert.equal(resolveAgentActivity(idle), null);
  assert.deepEqual(resolveAgentActivity({ ...idle, isStarting: true }), {
    phase: "preparing",
    label: "Preparing…",
    orbState: "shaping",
  });
  assert.deepEqual(resolveAgentActivity({ ...idle, streamingText: "" }), {
    phase: "thinking",
    label: "Thinking…",
    orbState: "solving",
  });
  assert.deepEqual(resolveAgentActivity({ ...idle, streamingText: "Hello" }), {
    phase: "responding",
    label: "Responding…",
    orbState: "composing",
  });
});

test("shows model loading ahead of empty-stream thinking", () => {
  assert.deepEqual(
    resolveAgentActivity({
      ...idle,
      isModelLoading: true,
      streamingText: "",
    }),
    {
      phase: "loading",
      label: "Model loading…",
      orbState: "shaping",
    },
  );
  assert.equal(
    resolveAgentActivity({
      ...idle,
      isStarting: true,
      isModelLoading: true,
      streamingText: "",
    })?.phase,
    "preparing",
  );
});

test("distinguishes discovery tools from other agent work", () => {
  const reading: ToolActivity = {
    state: "running",
    label: "Read file…",
    toolName: "read_file",
  };
  const editing: ToolActivity = {
    state: "running",
    label: "Edit file…",
    toolName: "edit_file",
  };

  assert.deepEqual(resolveAgentActivity({ ...idle, toolActivity: reading }), {
    phase: "searching",
    label: "Read file…",
    orbState: "searching",
  });
  assert.deepEqual(resolveAgentActivity({ ...idle, toolActivity: editing }), {
    phase: "working",
    label: "Edit file…",
    orbState: "working",
  });
});

test("stopping and approval take precedence over other live signals", () => {
  const running: ToolActivity = {
    state: "running",
    label: "Run command…",
    toolName: "run_command",
  };

  assert.equal(
    resolveAgentActivity({
      ...idle,
      streamingText: "Partial answer",
      pendingApproval: true,
      toolActivity: running,
    })?.phase,
    "waiting",
  );
  assert.equal(
    resolveAgentActivity({
      ...idle,
      isStopping: true,
      pendingApproval: true,
      toolActivity: running,
    })?.phase,
    "stopping",
  );
});

test("terminal tool states do not keep the activity animation running", () => {
  const finished: ToolActivity = {
    state: "finished",
    label: "Read file finished",
    toolName: "read_file",
  };

  assert.equal(resolveAgentActivity({ ...idle, toolActivity: finished }), null);
});
