import assert from "node:assert/strict";
import test from "node:test";
import {
  GenerationTimelineProjector,
  safeToolDescriptor,
  safeToolIssueDetails,
} from "./generation-timeline.js";
import {
  isToolStep,
  parseGenerationTimeline,
  type AgentToolStep,
  type GenerationTimeline,
} from "../../renderer/shared/generation-timeline.js";

function toolSteps(timeline: GenerationTimeline): AgentToolStep[] {
  return timeline.steps.filter(isToolStep);
}

test("keeps tool order stable when parallel calls finish out of order", () => {
  let now = 100;
  const snapshots: GenerationTimeline[] = [];
  const projector = new GenerationTimelineProjector(
    "generation-1",
    (timeline) => snapshots.push(timeline),
    () => ++now,
  );

  projector.toolStarted("call-a", "read_file", { path: "src/a.ts" });
  projector.toolStarted("call-b", "grep", {
    path: "src",
    query: "secret-search-value",
  });
  projector.toolRunning("call-a");
  projector.toolRunning("call-b");
  projector.toolFinished("call-b", "completed");
  projector.toolFinished("call-a", "completed");

  const final = projector.finish("completed");
  assert.deepEqual(
    toolSteps(final).map((step) => [step.toolCallId, step.order, step.status]),
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
    contentOffset: 0,
    target: "renderer/app.tsx",
  });
});

test("projects only safe completed file line changes", () => {
  const projector = new GenerationTimelineProjector("generation-1", () => {});
  projector.toolStarted("edit", "edit_file", { path: "src/app.ts" });
  projector.toolFinished("edit", "completed", {
    kind: "file_line_changes",
    version: 1,
    additions: 12,
    deletions: 3,
  });
  projector.toolStarted("read", "read_file", { path: "src/app.ts" });
  projector.toolFinished("read", "completed", {
    kind: "file_line_changes",
    version: 1,
    additions: 99,
    deletions: 99,
  });
  projector.toolStarted("failed", "write_file", { path: "failed.ts" });
  projector.toolFinished("failed", "failed", {
    kind: "file_line_changes",
    version: 1,
    additions: 2,
    deletions: 1,
  });
  projector.toolStarted("invalid", "write_file", { path: "invalid.ts" });
  projector.toolFinished("invalid", "completed", {
    kind: "file_line_changes",
    version: 1,
    additions: -1,
    deletions: 0,
    privateContent: "must not cross the renderer boundary",
  });

  const [edit, read, failed, invalid] = toolSteps(projector.snapshot());
  assert.deepEqual(edit?.lineChanges, { additions: 12, deletions: 3 });
  assert.equal(read?.lineChanges, undefined);
  assert.equal(failed?.lineChanges, undefined);
  assert.equal(invalid?.lineChanges, undefined);
  assert.doesNotMatch(JSON.stringify(projector.snapshot()), /privateContent|must not cross/u);
});

test("projects only allowlisted actionable terminal tool issues", () => {
  const projector = new GenerationTimelineProjector("generation-1", () => {});
  projector.toolStarted("budget", "subagent", {});
  projector.toolFinished(
    "budget",
    "failed",
    safeToolIssueDetails("subagent", "failed", {
      content: [
        {
          type: "text",
          text: "Subagent tree tokens budget exhausted (181,132 attempted; 128,000 allowed). Start a new parent turn with narrower tasks.",
        },
      ],
    }),
  );
  projector.toolStarted("approval", "share_image", {});
  projector.toolFinished(
    "approval",
    "blocked",
    safeToolIssueDetails("share_image", "blocked", {
      content: [
        {
          type: "text",
          text: "Approval is unavailable while this response continues in the background. Return to the chat and retry the action.",
        },
      ],
    }),
  );
  projector.toolStarted("private", "subagent", {});
  projector.toolFinished(
    "private",
    "failed",
    safeToolIssueDetails("subagent", "failed", {
      content: [{ type: "text", text: "Provider leaked /Users/alice/private and secret-token" }],
    }),
  );

  const [budget, approval, privateFailure] = toolSteps(projector.snapshot());
  assert.equal(budget?.detail, "budget exhausted; start a new parent turn with narrower tasks");
  assert.equal(
    approval?.detail,
    "approval unavailable while the response continues in the background",
  );
  assert.equal(privateFailure?.detail, undefined);
  assert.doesNotMatch(JSON.stringify(projector.snapshot()), /alice|secret-token/u);
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

test("projects display_image as a safe relative GUI artifact action", () => {
  assert.deepEqual(safeToolDescriptor("display_image", { path: "previews/page.png" }), {
    label: "Display image",
    target: "previews/page.png",
  });
  assert.deepEqual(safeToolDescriptor("render_artifact", { title: "Dependencies" }), {
    label: "Render artifact",
    detail: "Dependencies",
  });
  assert.deepEqual(safeToolDescriptor("display_image", { path: "/private/page.png" }), {
    label: "Display image",
    target: undefined,
  });
});

test("terminal cancellation settles active steps", () => {
  const projector = new GenerationTimelineProjector("generation-1", () => {});
  projector.toolStarted("call-a", "read_file", { path: "README.md" });
  projector.toolRunning("call-a");

  const final = projector.finish("cancelled", "user_stop");
  assert.equal(final.status, "cancelled");
  assert.equal(final.cancellationOrigin, "user_stop");
  assert.deepEqual(parseGenerationTimeline(JSON.parse(JSON.stringify(final))), final);
  assert.equal(
    parseGenerationTimeline({
      ...final,
      cancellationOrigin: "renderer_lifecycle",
    }),
    undefined,
  );
  assert.equal(parseGenerationTimeline({ ...final, status: "completed" }), undefined);
  assert.equal(toolSteps(final)[0]?.status, "cancelled");
  assert.equal(typeof final.finishedAt, "number");
  assert.equal(typeof final.steps[0]?.finishedAt, "number");
});

test("explicit tool cancellation remains cancelled at generation settlement", () => {
  const projector = new GenerationTimelineProjector("generation-1", () => {});
  projector.toolStarted("provider-call-id", "run_command", {
    command: "long private command",
  });
  projector.toolRunning("provider-call-id");
  projector.toolFinished("provider-call-id", "cancelled");

  const final = projector.finish("cancelled");
  assert.equal(toolSteps(final)[0]?.status, "cancelled");
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
  assert.equal(toolSteps(final)[0]?.status, "completed");
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
    detail: undefined,
  });
  assert.deepEqual(safeToolDescriptor("share_image", { path: "/Users/person/Result.png" }), {
    label: "Share image",
    target: undefined,
  });
  assert.deepEqual(safeToolDescriptor("read_file", { path: "/tmp/private.txt" }), {
    label: "Read file",
    target: undefined,
  });
});

test("a command's detail is the model's description, never the command", () => {
  assert.deepEqual(
    safeToolDescriptor("run_command", {
      command: "curl -H 'Authorization: SUPER_SECRET' https://example.com",
      description: "Fetch the release manifest",
    }),
    { label: "Run command", detail: "Fetch the release manifest" },
  );
});

test("displayable details survive while unsafe ones are collapsed or dropped", () => {
  assert.equal(
    safeToolDescriptor("grep", {
      path: "services",
      pattern: "export (const|class)",
    }).detail,
    "export (const|class)",
  );
  assert.equal(safeToolDescriptor("glob", { pattern: "  src/**/*.ts\n\n" }).detail, "src/**/*.ts");
  assert.equal(
    safeToolDescriptor("web_search", { query: "line one\nline two" }).detail,
    "line one line two",
  );
  assert.equal(safeToolDescriptor("glob", { pattern: "   " }).detail, undefined);
  assert.equal(safeToolDescriptor("glob", { pattern: 42 }).detail, undefined);
  assert.equal(safeToolDescriptor("glob", { pattern: "x".repeat(400) }).detail?.length, 120);
});

test("consecutive reasoning blocks merge into one timed stretch", () => {
  let now = 1_000;
  const projector = new GenerationTimelineProjector(
    "generation-1",
    () => {},
    () => (now += 500),
  );

  projector.thinkingStarted();
  projector.thinkingEnded();
  projector.thinkingStarted();
  projector.thinkingEnded();
  projector.toolStarted("call-a", "read_file", { path: "README.md" });
  projector.toolFinished("call-a", "completed");
  projector.thinkingStarted();

  const final = projector.finish("completed");
  assert.deepEqual(
    final.steps.map((step) => [step.id, step.kind]),
    [
      ["think-1", "thinking"],
      ["tool-1", "tool"],
      ["think-2", "thinking"],
    ],
  );
  const [merged, , trailing] = final.steps;
  assert.equal(merged?.kind === "thinking" && merged.durationMs, 1_000);
  // finish() settles reasoning that was still open when the turn ended.
  assert.equal(trailing?.kind === "thinking" && trailing.durationMs, 500);
  assert.equal(typeof trailing?.finishedAt, "number");
});

test("a reopened merged thinking step reads open again on the live timeline", () => {
  let now = 1_000;
  const snapshots: GenerationTimeline[] = [];
  const projector = new GenerationTimelineProjector(
    "generation-1",
    (timeline) => snapshots.push(timeline),
    () => (now += 500),
  );

  projector.thinkingStarted();
  projector.thinkingEnded();
  const settled = snapshots[snapshots.length - 1];
  const settledStep = settled?.steps[0];
  assert.equal(settledStep?.kind === "thinking" && settledStep.finishedAt, 2_500);
  assert.equal(settledStep?.kind === "thinking" && settledStep.durationMs, 500);

  projector.thinkingStarted();
  const reopened = snapshots[snapshots.length - 1];
  assert.equal(reopened?.steps.length, 1);
  assert.equal(reopened?.steps[0]?.finishedAt, undefined);

  projector.thinkingEnded();
  const final = projector.finish("completed");
  const finalStep = final.steps[0];
  assert.equal(finalStep?.kind === "thinking" && finalStep.finishedAt, 3_500);
  assert.equal(finalStep?.kind === "thinking" && finalStep.durationMs, 1_000);
});

test("an early toolcall_start step upgrades instead of duplicating", () => {
  let now = 100;
  const projector = new GenerationTimelineProjector(
    "generation-1",
    () => {},
    () => ++now,
  );

  // toolcall_start fires before arguments resolve, so args are empty.
  projector.toolStarted("call-a", "render_artifact", {});
  const early = projector.snapshot();
  assert.equal(early.steps.length, 1);
  assert.equal(toolSteps(early)[0]?.status, "pending");
  assert.equal(toolSteps(early)[0]?.detail, undefined);

  // beforeToolCall / tool_execution_start repeat the id with real args.
  projector.toolStarted("call-a", "render_artifact", { title: "Coverage", html: "<p>x</p>" });
  projector.toolRunning("call-a");
  projector.toolFinished("call-a", "completed");

  const final = projector.finish("completed");
  const steps = toolSteps(final);
  assert.equal(steps.length, 1);
  assert.equal(steps[0]?.status, "completed");
  assert.equal(steps[0]?.label, "Render artifact");
  assert.equal(steps[0]?.detail, "Coverage");
  // The raw HTML argument never crosses the timeline boundary.
  assert.equal(JSON.stringify(final).includes("<p>x</p>"), false);
});

test("terminal tool steps ignore late repeated toolStarted calls", () => {
  const projector = new GenerationTimelineProjector("generation-1", () => {});
  projector.toolStarted("call-a", "read_file", { path: "README.md" });
  projector.toolFinished("call-a", "failed");
  projector.toolStarted("call-a", "read_file", { path: "secret-path" });

  const final = projector.finish("completed");
  const steps = toolSteps(final);
  assert.equal(steps.length, 1);
  assert.equal(steps[0]?.status, "failed");
  assert.equal(steps[0]?.target, "README.md");
});

test("reasoning steps replay only from the current version", () => {
  const projector = new GenerationTimelineProjector(
    "generation-1",
    () => {},
    () => 100,
  );
  projector.thinkingStarted();
  projector.thinkingEnded();
  projector.toolStarted("call-a", "grep", { path: "src", pattern: "export" });
  projector.toolFinished("call-a", "completed");
  const final = projector.finish("completed");
  const stored = JSON.parse(JSON.stringify(final)) as Record<string, unknown>;

  assert.deepEqual(parseGenerationTimeline(stored), final);
  // Version 1 predates reasoning steps, so one appearing there is untrusted data.
  assert.equal(parseGenerationTimeline({ ...stored, version: 1 }), undefined);
  assert.equal(
    parseGenerationTimeline({
      ...final,
      steps: [{ ...final.steps[1], order: 0, detail: "multi\nline" }],
    }),
    undefined,
  );
});

test("anchors activity to assistant text and groups parallel calls at one boundary", () => {
  const projector = new GenerationTimelineProjector("generation-1", () => {});
  projector.setContentOffset(7);
  projector.toolStarted("call-a", "read_file", { path: "a.ts" });
  projector.toolStarted("call-b", "grep", { pattern: "export" });
  projector.setContentOffset(15);
  projector.thinkingStarted();
  projector.thinkingEnded();
  projector.toolStarted("call-c", "subagent", {});

  assert.deepEqual(
    projector.snapshot().steps.map((step) => step.contentOffset),
    [7, 7, 15, 15],
  );
});

test("terminal reconciliation and retry rewind keep future offsets monotonic", () => {
  const snapshots: GenerationTimeline[] = [];
  const projector = new GenerationTimelineProjector("generation-1", (timeline) =>
    snapshots.push(timeline),
  );
  projector.setContentOffset(20);
  projector.thinkingStarted();
  projector.thinkingEnded();
  projector.reconcileContentOffset(10, 15);
  projector.toolStarted("after-terminal", "read_file", {});
  projector.setContentOffset(30);
  projector.toolStarted("failed-attempt", "grep", {});
  projector.rewindContentOffset(15);
  projector.toolStarted("retry", "edit_file", {});

  assert.deepEqual(
    projector.snapshot().steps.map((step) => step.contentOffset),
    [15, 15, 15, 15],
  );
  assert.ok(snapshots.length > 0);
});

test("version 1 timelines replay without pretending to have presentation offsets", () => {
  const legacy = {
    version: 1,
    generationId: "generation-1",
    status: "completed",
    startedAt: 100,
    finishedAt: 200,
    steps: [
      {
        id: "tool-1",
        order: 0,
        kind: "tool",
        toolCallId: "call-1",
        toolName: "read_file",
        label: "Read file",
        status: "completed",
        startedAt: 100,
        updatedAt: 150,
        finishedAt: 150,
        target: "README.md",
      },
    ],
  };

  const parsed = parseGenerationTimeline(legacy);
  assert.equal(parsed?.version, 1);
  assert.equal(parsed?.steps.length, 1);
  assert.equal(toolSteps(parsed as GenerationTimeline)[0]?.target, "README.md");
});

test("version 2 reasoning timelines replay without presentation offsets", () => {
  const legacy = {
    version: 2,
    generationId: "generation-1",
    status: "completed",
    startedAt: 100,
    finishedAt: 200,
    steps: [
      {
        id: "think-1",
        order: 0,
        kind: "thinking",
        startedAt: 100,
        updatedAt: 150,
        finishedAt: 150,
        durationMs: 50,
      },
    ],
  };
  const parsed = parseGenerationTimeline(legacy);
  assert.equal(parsed?.version, 2);
  assert.equal(parsed?.steps[0]?.contentOffset, undefined);
});

test("compaction is a renderer-safe bounded activity milestone", () => {
  let now = 100;
  const projector = new GenerationTimelineProjector(
    "generation-1",
    () => {},
    () => now,
  );

  const id = projector.compactionStarted();
  now = 180;
  projector.compactionFinished(id, "completed");

  const [step] = toolSteps(projector.snapshot());
  assert.equal(step?.toolName, "compact_context");
  assert.equal(step?.label, "Compact context");
  assert.equal(step?.status, "completed");
  assert.equal(step?.detail, undefined);
  assert.equal(step?.target, undefined);
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
  const editable = {
    ...final,
    steps: [
      {
        ...final.steps[0],
        toolName: "edit_file",
        label: "Edit file",
        lineChanges: { additions: 7, deletions: 2 },
      },
    ],
  };
  assert.deepEqual(parseGenerationTimeline(editable), editable);
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
  assert.equal(
    parseGenerationTimeline({
      ...editable,
      steps: [{ ...editable.steps[0], lineChanges: { additions: -1, deletions: 2 } }],
    }),
    undefined,
  );
  assert.equal(
    parseGenerationTimeline({
      ...editable,
      steps: [{ ...editable.steps[0], status: "failed" }],
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
  assert.equal(
    parseGenerationTimeline({
      ...final,
      steps: [{ ...final.steps[0], contentOffset: -1 }],
    }),
    undefined,
  );
});

test("streaming tool updates do not republish a timeline whose visible status is unchanged", () => {
  const snapshots: GenerationTimeline[] = [];
  const projector = new GenerationTimelineProjector("generation-1", (timeline) =>
    snapshots.push(timeline),
  );
  projector.toolStarted("call-a", "run_command", { description: "install deps" });
  const afterStart = snapshots.length;
  projector.toolRunning("call-a");
  const afterFirstRunning = snapshots.length;
  assert.equal(afterFirstRunning, afterStart + 1);
  assert.equal(toolSteps(snapshots[afterFirstRunning - 1]!)[0]?.status, "running");

  for (let index = 0; index < 2_000; index += 1) {
    projector.toolRunning("call-a");
  }
  assert.equal(snapshots.length, afterFirstRunning);

  const serialized = JSON.stringify(projector.snapshot());
  const budgetBytes = 4_096;
  assert.ok(
    Buffer.byteLength(serialized, "utf8") < budgetBytes,
    `one-line tool timeline exceeded ${budgetBytes} bytes: ${Buffer.byteLength(serialized, "utf8")}`,
  );

  projector.toolFinished("call-a", "completed");
  assert.equal(snapshots.length, afterFirstRunning + 1);
  assert.equal(toolSteps(snapshots[snapshots.length - 1]!)[0]?.status, "completed");
});

test("history recall activity never projects queries or recalled excerpts", () => {
  assert.deepEqual(
    safeToolDescriptor("vcc_recall", { query: "private query", reference: "private-entry" }),
    {
      label: "Recall chat history",
    },
  );
});

test("automatic compaction publishes bounded engine metrics without summary content", () => {
  const projector = new GenerationTimelineProjector(
    "metrics",
    () => {},
    () => 100,
  );
  const id = projector.compactionStarted();
  const result = {
    engine: "vcc" as const,
    durationMs: 400,
    tokensBefore: 25900,
    estimatedTokensAfter: 6758,
    summary: "PRIVATE SUMMARY",
    retainedTail: [{ content: "PRIVATE TOOL OUTPUT" }],
  };
  projector.compactionFinished(id, "completed", result);
  const snapshot = projector.snapshot();
  assert.equal(toolSteps(snapshot)[0].detail, "pi-vcc · 0.4s · ~25900 → 6758 tokens");
  assert.deepEqual(parseGenerationTimeline(JSON.parse(JSON.stringify(snapshot))), snapshot);
  assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE/);
});

function thinkingBounds(timeline: GenerationTimeline) {
  return timeline.steps
    .filter((step) => !isToolStep(step))
    .map((step) => ({
      id: step.id,
      start: (step as { reasoningStart?: number }).reasoningStart,
      end: (step as { reasoningEnd?: number }).reasoningEnd,
    }));
}

test("thinking steps record reasoning-buffer bounds and tools settle open segments", () => {
  let now = 1_000;
  const projector = new GenerationTimelineProjector(
    "generation-1",
    () => {},
    () => (now += 100),
  );

  projector.thinkingStarted(0);
  projector.thinkingEnded(18);
  projector.toolStarted("call-a", "read_file", { path: "a.ts" }, 18);
  projector.toolFinished("call-a", "completed");
  projector.thinkingStarted(18);
  projector.thinkingEnded(44);

  const final = projector.finish("completed", undefined, 44);
  assert.deepEqual(thinkingBounds(final), [
    { id: "think-1", start: 0, end: 18 },
    { id: "think-2", start: 18, end: 44 },
  ]);
  assert.deepEqual(
    parseGenerationTimeline(JSON.parse(JSON.stringify(final)), undefined, 44),
    final,
  );
});

test("toolStarted settles a live thinking segment at the current reasoning length", () => {
  const projector = new GenerationTimelineProjector("generation-1", () => {});
  projector.thinkingStarted(0);
  // A tool call interrupts an unfinished thinking block: the segment ends at
  // the reasoning-buffer length the runtime reported.
  projector.toolStarted("call-a", "read_file", { path: "a.ts" }, 25);
  projector.toolFinished("call-a", "completed");

  const final = projector.finish("completed", undefined, 25);
  assert.deepEqual(thinkingBounds(final), [{ id: "think-1", start: 0, end: 25 }]);
});

test("adjacent reasoning blocks merge into one segment covering the whole stretch", () => {
  const projector = new GenerationTimelineProjector("generation-1", () => {});
  projector.thinkingStarted(0);
  projector.thinkingEnded(18);
  // Reopened before any tool/text boundary: still perceived as one stretch.
  projector.thinkingStarted(18);
  projector.thinkingEnded(44);

  const final = projector.finish("completed", undefined, 44);
  assert.equal(final.steps.length, 1);
  assert.deepEqual(thinkingBounds(final), [{ id: "think-1", start: 0, end: 44 }]);
});

test("settle drops a reasoning segment whose end precedes its start", () => {
  const projector = new GenerationTimelineProjector("generation-1", () => {});
  projector.thinkingStarted(30);
  // A lower offset than the recorded start can only come from a corrupted
  // runtime path — the segment must not keep its anchor.
  projector.thinkingEnded(10);

  const final = projector.finish("completed", undefined, 30);
  assert.deepEqual(thinkingBounds(final), [{ id: "think-1", start: undefined, end: undefined }]);
});

test("reconcile re-anchors segments verbatim to terminal canonical reasoning", () => {
  const projector = new GenerationTimelineProjector("generation-1", () => {});
  projector.thinkingStarted(0);
  projector.thinkingEnded(16);
  projector.toolStarted("call-a", "read_file", { path: "a.ts" }, 16);
  projector.toolFinished("call-a", "completed");
  projector.thinkingStarted(16);
  projector.thinkingEnded(40);

  const partA = "Streamed order one.";
  const partB = "Streamed order two.";
  // Pi's canonical buffer reordered the blocks: verbatim containment moves the
  // offsets to where the parts actually landed, keeping chronological slots.
  const reasoning = `${partB}\n\n${partA}`;
  projector.reconcileReasoningOffsets(0, [partB, partA], reasoning);

  const final = projector.finish("completed", undefined, reasoning.length);
  assert.deepEqual(thinkingBounds(final), [
    { id: "think-1", start: 0, end: 19 },
    { id: "think-2", start: 21, end: 40 },
  ]);
});

test("reconcile fails closed when terminal reasoning does not contain the parts", () => {
  const projector = new GenerationTimelineProjector("generation-1", () => {});
  projector.thinkingStarted(0);
  projector.thinkingEnded(10);
  projector.toolStarted("call-a", "read_file", {}, 10);
  projector.toolFinished("call-a", "completed");
  projector.thinkingStarted(10);
  projector.thinkingEnded(20);

  projector.reconcileReasoningOffsets(0, ["alpha", "beta"], "unrelated reasoning text");
  const final = projector.finish("completed", undefined, 20);
  assert.deepEqual(thinkingBounds(final), [
    { id: "think-1", start: undefined, end: undefined },
    { id: "think-2", start: undefined, end: undefined },
  ]);
});

test("merged perceived stretch reconciles to the whole terminal span", () => {
  const projector = new GenerationTimelineProjector("generation-1", () => {});
  projector.thinkingStarted(0);
  projector.thinkingEnded(60);

  // The provider sent two adjacent blocks; the timeline merged them into one
  // step, so the step owns the joined terminal span.
  const partA = "First block.";
  const partB = "Second block.";
  const reasoning = `Prefix.\n\n${partA}\n\n${partB}`;
  projector.reconcileReasoningOffsets(0, [partA, partB], reasoning);

  const final = projector.finish("completed", undefined, reasoning.length);
  assert.deepEqual(thinkingBounds(final), [{ id: "think-1", start: 9, end: reasoning.length }]);
});

test("rewind drops segments past the truncation point and clamps a retained open one", () => {
  const projector = new GenerationTimelineProjector("generation-1", () => {});
  projector.thinkingStarted(0);
  projector.thinkingEnded(10);
  projector.toolStarted("call-a", "read_file", {}, 10);
  projector.toolFinished("call-a", "completed");
  projector.thinkingStarted(10);
  projector.thinkingEnded(30);

  projector.rewindReasoningOffset(20);
  const final = projector.finish("completed", undefined, 20);
  assert.deepEqual(thinkingBounds(final), [
    { id: "think-1", start: 0, end: 10 },
    { id: "think-2", start: 10, end: 20 },
  ]);
});

test("finish settles a still-open segment at the final reasoning length", () => {
  const projector = new GenerationTimelineProjector("generation-1", () => {});
  projector.thinkingStarted(0);
  const final = projector.finish("cancelled", undefined, 33);
  assert.deepEqual(thinkingBounds(final), [{ id: "think-1", start: 0, end: 33 }]);
});

test("reasoning bounds replay: open steps allow start-only, settled steps need both", () => {
  const projector = new GenerationTimelineProjector("generation-1", () => {});
  projector.thinkingStarted(0);
  projector.thinkingEnded(12);
  projector.toolStarted("call-a", "read_file", {}, 12);
  projector.toolFinished("call-a", "completed");
  projector.thinkingStarted(12);

  const live = projector.snapshot();
  const liveStep = live.steps[2] as { reasoningStart?: number; reasoningEnd?: number };
  assert.equal(liveStep.reasoningStart, 12);
  assert.equal(liveStep.reasoningEnd, undefined);
  const parsedLive = parseGenerationTimeline(
    JSON.parse(JSON.stringify(live)),
    undefined,
    undefined,
  );
  const parsedLiveStep = parsedLive?.steps[2] as
    | { reasoningStart?: number; reasoningEnd?: number }
    | undefined;
  assert.equal(parsedLiveStep?.reasoningStart, 12);
  assert.equal(parsedLiveStep?.reasoningEnd, undefined);

  const final = projector.finish("completed", undefined, 40);
  const stored = JSON.parse(JSON.stringify(final)) as Record<string, unknown>;
  assert.deepEqual(parseGenerationTimeline(stored, undefined, 40), final);
  // A settled step carrying only a start is malformed and loses its bounds.
  const malformed = JSON.parse(JSON.stringify(final)) as Record<string, unknown>;
  const firstStep = (malformed.steps as Record<string, unknown>[])[0]!;
  delete firstStep.reasoningEnd;
  const parsed = parseGenerationTimeline(malformed, undefined, 40);
  const parsedStep = parsed?.steps[0] as
    | { reasoningStart?: number; reasoningEnd?: number }
    | undefined;
  assert.equal(parsedStep?.reasoningStart, undefined);
});

test("reasoning bounds fail closed against out-of-range and out-of-order offsets", () => {
  const projector = new GenerationTimelineProjector("generation-1", () => {});
  projector.thinkingStarted(0);
  projector.thinkingEnded(12);
  projector.toolStarted("call-a", "read_file", {}, 12);
  projector.toolFinished("call-a", "completed");
  projector.thinkingStarted(12);
  projector.thinkingEnded(30);
  const final = projector.finish("completed", undefined, 30);

  const stored = JSON.parse(JSON.stringify(final)) as Record<string, unknown>;
  // End beyond the persisted reasoning buffer: that step's bounds are stripped,
  // the step and the rest of the timeline survive.
  const overflow = JSON.parse(JSON.stringify(stored)) as Record<string, unknown>;
  (overflow.steps as Record<string, unknown>[])[2]!.reasoningEnd = 31;
  const parsedOverflow = parseGenerationTimeline(overflow, undefined, 30);
  const overflowStep = parsedOverflow?.steps[2] as
    | { reasoningStart?: number; reasoningEnd?: number }
    | undefined;
  assert.equal(parsedOverflow?.steps.length, 3);
  assert.equal(overflowStep?.reasoningStart, undefined);

  // A second segment rewound before the first one's start is dropped.
  const reordered = JSON.parse(JSON.stringify(stored)) as Record<string, unknown>;
  (reordered.steps as Record<string, unknown>[])[2]!.reasoningStart = 4;
  (reordered.steps as Record<string, unknown>[])[2]!.reasoningEnd = 8;
  const parsedReordered = parseGenerationTimeline(reordered, undefined, 30);
  const reorderedStep = parsedReordered?.steps[2] as
    | { reasoningStart?: number; reasoningEnd?: number }
    | undefined;
  assert.equal(reorderedStep?.reasoningStart, undefined);
});
