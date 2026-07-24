import assert from "node:assert/strict";
import test from "node:test";
import { GenerationTimelineProjector, safeToolDescriptor } from "./generation-timeline.js";
import {
  parseGenerationTimeline,
  type GenerationTimeline,
} from "../../renderer/shared/generation-timeline.js";

test("keeps tool order stable when parallel calls finish out of order", () => {
  let now = 100;
  const snapshots: GenerationTimeline[] = [];
  const projector = new GenerationTimelineProjector(
    "generation-1",
    (timeline) => snapshots.push(timeline),
    () => ++now,
  );

  projector.toolStarted("call-a", "read_file", { path: "src/a.ts" });
  projector.toolStarted("call-b", "grep", { path: "src", query: "secret-search-value" });
  projector.toolRunning("call-a");
  projector.toolRunning("call-b");
  projector.toolFinished("call-b", "completed");
  projector.toolFinished("call-a", "completed");

  const final = projector.finish("completed");
  assert.deepEqual(
    final.steps.map((step) => [step.toolCallId, step.order, step.status]),
    [
      ["call-1", 0, "completed"],
      ["call-2", 1, "completed"],
    ],
  );
  assert.equal(snapshots[snapshots.length - 1]?.status, "completed");
});

test("binds approval and denial to the existing tool step", () => {
  const projector = new GenerationTimelineProjector("generation-1", () => {});
  projector.toolStarted("call-a", "edit_file", {
    path: "renderer/app.tsx",
    old_string: "private-old-value",
    new_string: "private-new-value",
  });
  projector.toolAwaitingApproval("call-a");
  projector.toolFinished("call-a", "blocked");

  assert.deepEqual(projector.snapshot().steps[0], {
    id: "tool-1",
    order: 0,
    kind: "tool",
    toolCallId: "call-1",
    toolName: "edit_file",
    label: "Edit file",
    status: "blocked",
    startedAt: projector.snapshot().steps[0]?.startedAt,
    updatedAt: projector.snapshot().steps[0]?.updatedAt,
    finishedAt: projector.snapshot().steps[0]?.finishedAt,
    target: "renderer/app.tsx",
  });
});

test("does not expose raw command, search, content, or absolute path arguments", () => {
  const snapshots: GenerationTimeline[] = [];
  const projector = new GenerationTimelineProjector("generation-1", (timeline) =>
    snapshots.push(timeline),
  );

  projector.toolStarted("command", "run_command", {
    command: "echo SUPER_SECRET_TOKEN",
  });
  projector.toolStarted("search", "grep", {
    path: "/Users/person/private",
    query: "SUPER_SECRET_QUERY",
  });
  projector.toolStarted("write", "write_file", {
    path: "../outside.txt",
    content: "SUPER_SECRET_CONTENT",
  });

  const serialized = JSON.stringify(snapshots);
  assert.equal(serialized.includes("SUPER_SECRET"), false);
  assert.equal(serialized.includes("/Users/person"), false);
  assert.equal(serialized.includes("../outside"), false);
});

test("terminal cancellation settles active steps", () => {
  const projector = new GenerationTimelineProjector("generation-1", () => {});
  projector.toolStarted("call-a", "read_file", { path: "README.md" });
  projector.toolRunning("call-a");

  const final = projector.finish("cancelled");
  assert.equal(final.status, "cancelled");
  assert.equal(final.steps[0]?.status, "cancelled");
  assert.equal(typeof final.finishedAt, "number");
  assert.equal(typeof final.steps[0]?.finishedAt, "number");
});

test("explicit tool cancellation remains cancelled at generation settlement", () => {
  const projector = new GenerationTimelineProjector("generation-1", () => {});
  projector.toolStarted("provider-call-id", "run_command", { command: "long private command" });
  projector.toolRunning("provider-call-id");
  projector.toolFinished("provider-call-id", "cancelled");

  const final = projector.finish("cancelled");
  assert.equal(final.steps[0]?.status, "cancelled");
});

test("terminal steps and timelines ignore replayed lifecycle events", () => {
  const projector = new GenerationTimelineProjector("generation-1", () => {});
  projector.toolStarted("provider-call-id", "read_file", { path: "README.md" });
  projector.toolRunning("provider-call-id");
  projector.toolFinished("provider-call-id", "completed");
  projector.toolRunning("provider-call-id");
  projector.toolFinished("provider-call-id", "failed");
  projector.finish("completed");
  projector.toolStarted("late-call-id", "read_file", { path: "late.txt" });

  const final = projector.snapshot();
  assert.equal(final.steps.length, 1);
  assert.equal(final.steps[0]?.status, "completed");
});

test("provider call ids never cross the safe timeline boundary", () => {
  const projector = new GenerationTimelineProjector("generation-1", () => {});
  const hostileId = `provider-private-${"x".repeat(1_000)}`;
  projector.toolStarted(hostileId, "read_file", { path: "README.md" });

  const serialized = JSON.stringify(projector.snapshot());
  assert.equal(serialized.includes("provider-private"), false);
  assert.equal(projector.publicToolCallId(hostileId), "call-1");
});

test("safe tool descriptors retain only relative targets", () => {
  assert.deepEqual(safeToolDescriptor("read_file", { path: "src/index.ts" }), {
    label: "Read file",
    target: "src/index.ts",
  });
  assert.deepEqual(safeToolDescriptor("run_command", { command: "npm test" }), {
    label: "Run command",
  });
  assert.deepEqual(safeToolDescriptor("read_file", { path: "/tmp/private.txt" }), {
    label: "Read file",
    target: undefined,
  });
});

test("validates persisted timelines and rejects unsafe replay data", () => {
  const projector = new GenerationTimelineProjector(
    "generation-1",
    () => {},
    () => 100,
  );
  projector.toolStarted("provider-call", "read_file", { path: "src/index.ts" });
  projector.toolFinished("provider-call", "completed");
  const final = projector.finish("completed");

  assert.deepEqual(parseGenerationTimeline(JSON.parse(JSON.stringify(final))), final);
  assert.equal(
    parseGenerationTimeline({
      ...final,
      steps: [{ ...final.steps[0], target: "/Users/person/private.txt" }],
    }),
    undefined,
  );
  assert.equal(
    parseGenerationTimeline({
      ...final,
      steps: [{ ...final.steps[0], label: "x".repeat(121) }],
    }),
    undefined,
  );
  assert.deepEqual(
    parseGenerationTimeline({
      ...final,
      steps: [{ ...final.steps[0], status: "failed" }],
      claimCheck: { kind: "unverified_success", stepIds: ["tool-1"] },
    })?.claimCheck,
    { kind: "unverified_success", stepIds: ["tool-1"] },
  );
  assert.equal(
    parseGenerationTimeline({
      ...final,
      claimCheck: { kind: "unverified_success", stepIds: ["tool-404"] },
    }),
    undefined,
  );
});
