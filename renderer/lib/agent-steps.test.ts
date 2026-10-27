import assert from "node:assert/strict";
import test from "node:test";
import {
  isToolStep,
  hasActiveThinkingStep,
  hasActiveToolStep,
  type AgentStep,
  type AgentThinkingStep,
  type AgentToolStep,
  type GenerationTimeline,
} from "../shared/generation-timeline.js";
import {
  activityIssueCount,
  activityLine,
  activityLineText,
  activityTrailNeedsAttention,
  formatThinkingDuration,
  isActiveStep,
  isCompactContextOnly,
  reasoningActivityLabel,
  summarizeActivity,
} from "./agent-steps.js";
import {
  activityTimelineFragment,
  assistantPresentationRows,
} from "./assistant-message-presentation.js";

function step(
  id: string,
  order: number,
  toolName: string,
  status: AgentToolStep["status"] = "completed",
  extra: Partial<AgentToolStep> = {},
): AgentToolStep {
  return {
    id,
    order,
    kind: "tool",
    toolCallId: `call-${order + 1}`,
    toolName,
    label: toolName,
    status,
    startedAt: order,
    updatedAt: order,
    ...extra,
  };
}

test("all browser actions have readable activity labels", () => {
  const expected = [["browser","Loading browser tools","Loaded browser tools"],["browser_status","Checking browser","Checked browser"],["browser_open","Opening browser","Opened browser"],["browser_navigate","Navigating browser","Navigated browser"],["browser_resize","Resizing browser","Resized browser"],["browser_set_appearance","Setting browser appearance","Set browser appearance"],["browser_snapshot","Inspecting browser","Inspected browser"],["browser_click","Clicking in browser","Clicked in browser"],["browser_type","Typing in browser","Typed in browser"],["browser_press","Pressing browser keys","Pressed browser keys"],["browser_scroll","Scrolling browser","Scrolled browser"],["browser_evaluate","Evaluating page","Evaluated page"],["browser_wait_for","Waiting for page","Waited for page"],["browser_recording_start","Starting browser recording","Started browser recording"],["browser_recording_stop","Stopping browser recording","Stopped browser recording"]];
  for (const [name, active, complete] of expected) {
    assert.equal(activityLine(step(name, 0, name, "running")).verb, active);
    assert.equal(activityLine(step(name, 0, name, "completed")).verb, complete);
  }
});

test("a Bot's own computer reads as its computer, not the person's Mac", () => {
  assert.equal(activityLine(step("c", 0, "computer", "running")).verb, "Using its computer");
  assert.equal(activityLine(step("c", 0, "computer", "completed")).verb, "Used its computer");
  assert.equal(activityLine(step("s", 0, "computer_shell", "completed")).verb, "Ran in its computer");
});

test("simulator device tools read as compact timeline rows", () => {
  const rows = [
    ["device_list", "List simulators", "Listed simulators"],
    ["device_open", "Open simulator", "Opened simulator"],
    ["device_screenshot", "Screenshot simulator", "Took simulator screenshot"],
    ["device_close", "Close simulator", "Closed simulator"],
  ];
  for (const [name, label, complete] of rows) {
    assert.equal(activityLineText(step(name, 0, name, "completed", { label })), complete);
    // Failures and approval waits keep the tool's own label, so the row still names the device action.
    assert.equal(activityLineText(step(name, 0, name, "failed", { label })), `${label} failed`);
  }
  assert.equal(
    activityLineText(step("close", 0, "device_close", "awaiting_approval", { label: "Shut down simulator" })),
    "Shut down simulator needs approval",
  );
});

function thinking(id: string, order: number, durationMs?: number): AgentThinkingStep {
  return {
    id,
    order,
    kind: "thinking",
    startedAt: order,
    updatedAt: order,
    ...(durationMs === undefined ? {} : { durationMs, finishedAt: order + 1 }),
  };
}

function timeline(status: GenerationTimeline["status"], steps: AgentStep[]): GenerationTimeline {
  return {
    version: 3,
    generationId: "generation-1",
    status,
    startedAt: 1,
    ...(status === "running" ? {} : { finishedAt: 2 }),
    steps,
  };
}

function tools(counts: Record<string, number>): AgentToolStep[] {
  const steps: AgentToolStep[] = [];
  for (const [toolName, count] of Object.entries(counts)) {
    for (let index = 0; index < count; index += 1) {
      steps.push(step(`${toolName}-${index}`, steps.length, toolName));
    }
  }
  return steps;
}

function positionedTool(
  order: number,
  contentOffset: number,
  toolName = "read_file",
): AgentToolStep {
  return step(`tool-${order + 1}`, order, toolName, "completed", { contentOffset });
}

test("splits a row into a verb and the object it acted on", () => {
  assert.deepEqual(
    activityLine(step("read", 0, "read_file", "completed", { target: "src/app.ts" })),
    {
      verb: "Read",
      object: "src/app.ts",
      tone: "normal",
    },
  );
  assert.deepEqual(activityLine(step("glob", 1, "glob", "running", { detail: "src/**/*.ts" })), {
    verb: "Searching files",
    object: "src/**/*.ts",
    tone: "normal",
  });
  assert.equal(
    activityLineText(step("automation", 2, "edit_automation", "completed")),
    "Edited automation",
  );
});

test("a tool call whose arguments are still streaming reads as preparing, not as work", () => {
  const preparing = step("read", 0, "read_file", "pending", { label: "Read file", target: "src/app.ts" });
  assert.equal(activityLineText(preparing), "Preparing Read file");
  assert.equal(activityLine(preparing).stage, "preparing");
  // Still in flight, so the turn keeps its live treatment.
  assert.equal(isActiveStep(preparing), true);

  const running = { ...preparing, status: "running" as const };
  assert.equal(activityLineText(running), "Reading src/app.ts");
  assert.equal(activityLine(running).stage, undefined);
});

test("alternates prose and grouped activity at exact assistant-text boundaries", () => {
  const content = "Before.Between.After.";
  const rows = assistantPresentationRows(
    content,
    timeline("completed", [
      positionedTool(0, 7),
      positionedTool(1, 15, "grep"),
      positionedTool(2, 15, "subagent"),
    ]),
  );

  assert.deepEqual(
    rows?.map((row) =>
      row.kind === "text"
        ? [row.kind, row.content]
        : row.kind === "activity"
          ? [row.kind, row.steps.map((entry) => entry.id)]
          : [row.kind],
    ),
    [
      ["text", "Before."],
      ["activity", ["tool-1"]],
      ["text", "Between."],
      ["activity", ["tool-2", "tool-3"]],
      ["text", "After."],
    ],
  );
});

test("an answered questionnaire becomes its own row and leaves the activity group", () => {
  const recap = {
    version: 1 as const,
    outcome: "answered" as const,
    items: [{ question: "Which database?", header: "Database", kind: "option" as const, answers: ["Postgres"] }],
  };
  const asked = step("ask", 1, "ask_user_question", "completed", { contentOffset: 7, questionnaire: recap });
  const rows = assistantPresentationRows(
    "Before.After.",
    timeline("completed", [
      positionedTool(0, 7),
      asked,
      positionedTool(2, 7, "grep"),
    ]),
  );
  assert.deepEqual(
    rows?.map((row) =>
      row.kind === "text"
        ? [row.kind, row.content]
        : row.kind === "activity"
          ? [row.kind, row.steps.map((entry) => entry.id)]
          : row.kind === "questionnaire"
            ? [row.kind, row.step.questionnaire.items[0]?.answers]
            : [row.kind],
    ),
    [
      ["text", "Before."],
      ["activity", ["tool-1"]],
      ["questionnaire", ["Postgres"]],
      ["activity", ["tool-3"]],
      ["text", "After."],
    ],
  );

  // A questionnaire that settled without a recap (a stopped run) keeps its activity line.
  const stopped = step("ask", 1, "ask_user_question", "cancelled", { contentOffset: 7 });
  const stoppedRows = assistantPresentationRows("Before.", timeline("cancelled", [stopped]));
  assert.deepEqual(
    stoppedRows?.map((row) => row.kind),
    ["text", "activity"],
  );
});

test("extracted values show as a card under their activity line, which stays in the group", () => {
  const recap = {
    version: 1 as const,
    host: "acme.example",
    cut: false,
    fields: [{ name: "price", status: "extracted" as const, value: "20", confidence: 0.97, sourceLine: "Pro is $20 per month." }],
  };
  const fetched = step("fetch", 1, "web_fetch", "completed", { contentOffset: 7, extraction: recap });
  const rows = assistantPresentationRows(
    "Before.After.",
    timeline("completed", [positionedTool(0, 7), fetched, positionedTool(2, 7, "grep")]),
  );
  assert.deepEqual(
    rows?.map((row) =>
      row.kind === "text"
        ? [row.kind, row.content]
        : row.kind === "activity"
          ? [row.kind, row.steps.map((entry) => entry.id)]
          : row.kind === "extraction"
            ? [row.kind, row.step.extraction.fields[0]?.value]
            : [row.kind],
    ),
    [
      ["text", "Before."],
      ["activity", ["tool-1", "fetch", "tool-3"]],
      ["extraction", "20"],
      ["text", "After."],
    ],
  );
});

test("unreadable thinking remains a chronological status row", () => {
  const thought = { ...thinking("think-1", 0, 1_000), contentOffset: 7 };
  const rows = assistantPresentationRows("Before.After.", timeline("completed", [thought]));
  assert.deepEqual(
    rows?.map((row) => (row.kind === "text" ? [row.kind, row.content] : [row.kind])),
    [["text", "Before."], ["reasoning"], ["text", "After."]],
  );
  assert.equal(
    reasoningActivityLabel(timeline("running", [thinking("think-2", 0)]), true),
    "Thinking",
  );
  assert.equal(reasoningActivityLabel(timeline("completed", [thought]), false), "Thought briefly");
});

test("reasoning rows follow prose and tools in event order", () => {
  const steps: AgentStep[] = [
    { ...thinking("think-1", 0, 500), contentOffset: 0, reasoningStartOffset: 0, reasoningEndOffset: 5 },
    positionedTool(1, 0),
    { ...thinking("think-2", 2, 600), contentOffset: 7, reasoningStartOffset: 7, reasoningEndOffset: 13 },
  ];
  const rows = assistantPresentationRows("Before.After.", timeline("completed", steps), "First\n\nSecond");
  assert.deepEqual(rows?.map((row) => [row.kind, row.kind === "activity" ? row.steps[0]?.id : "content" in row ? row.content : row.step.id]), [
    ["reasoning", "First"],
    ["activity", "tool-2"],
    ["text", "Before."],
    ["reasoning", "Second"],
    ["text", "After."],
  ]);
  assert.equal(assistantPresentationRows("", timeline("completed", steps), "First\n\nSecond"), null);
});

test("assistant presentation fails closed for legacy or invalid offsets", () => {
  const current = timeline("completed", [positionedTool(0, 2), positionedTool(1, 3)]);
  assert.equal(
    assistantPresentationRows("text", {
      ...current,
      steps: current.steps.map(({ contentOffset: _offset, ...entry }) => entry),
    }),
    null,
  );
  assert.equal(
    assistantPresentationRows("text", {
      ...current,
      steps: [positionedTool(0, 3), positionedTool(1, 2)],
    }),
    null,
  );
  assert.equal(
    assistantPresentationRows("text", {
      ...current,
      steps: [positionedTool(0, 5)],
    }),
    null,
  );
});

test("the active prose segment keeps a stable key while streaming grows", () => {
  const positioned = timeline("running", [positionedTool(0, 7)]);
  const first = assistantPresentationRows("Before.A", positioned);
  const second = assistantPresentationRows("Before.A longer tail", positioned);
  assert.ok(first && second);
  assert.equal(first[first.length - 1]?.key, second[second.length - 1]?.key);
});

test("activity fragments keep only local claim checks and settle inactive live groups", () => {
  const first = positionedTool(0, 0);
  const second = {
    ...positionedTool(1, 0, "edit_file"),
    status: "failed" as const,
  };
  const source: GenerationTimeline = {
    ...timeline("running", [first, second]),
    claimCheck: { kind: "unverified_success", stepIds: [second.id] },
  };
  const firstFragment = activityTimelineFragment(source, [first]);
  const secondFragment = activityTimelineFragment(source, [second]);
  assert.equal(firstFragment.status, "completed");
  assert.equal(firstFragment.claimCheck, undefined);
  assert.deepEqual(secondFragment.claimCheck?.stepIds, [second.id]);
});

test("grep reads as a pattern scoped to a directory", () => {
  assert.equal(
    activityLineText(
      step("grep", 0, "grep", "completed", {
        detail: "export (function|const|class)",
        target: "services",
      }),
    ),
    "Grepped export (function|const|class) in services",
  );
});

test("a command shows the model's description, never the command", () => {
  assert.equal(
    activityLineText(
      step("run", 0, "run_command", "completed", { detail: "Count tests in the workspace" }),
    ),
    "Ran Count tests in the workspace",
  );
  assert.equal(activityLineText(step("bare", 1, "run_command", "completed")), "Ran");
});

test("terminal outcomes name the action and carry a tone", () => {
  assert.deepEqual(activityLine(step("cancel", 0, "run_command", "cancelled")), {
    verb: "run_command cancelled",
    object: undefined,
    tone: "warning",
  });
  assert.equal(activityLine(step("fail", 1, "edit_file", "failed")).tone, "error");
  assert.equal(activityLine(step("deny", 2, "write_file", "blocked")).tone, "warning");
  assert.equal(activityLine(step("ask", 3, "write_file", "awaiting_approval")).tone, "warning");
});

test("reasoning rows report measured time and stay active until they settle", () => {
  assert.equal(formatThinkingDuration(undefined), "briefly");
  assert.equal(formatThinkingDuration(900), "briefly");
  assert.equal(formatThinkingDuration(4_200), "for 4s");
  assert.equal(formatThinkingDuration(65_000), "for 1m 5s");
  assert.equal(formatThinkingDuration(120_000), "for 2m");

  assert.equal(activityLineText(thinking("think-1", 0, 4_200)), "Thought for 4s");
  assert.equal(activityLineText(thinking("think-1", 0)), "Thinking");
  assert.equal(isActiveStep(thinking("think-1", 0)), true);
  assert.equal(isActiveStep(thinking("think-1", 0, 100)), false);
});

test("summarizes a finished turn as one deterministic sentence", () => {
  assert.equal(
    summarizeActivity(
      timeline("completed", tools({ read_file: 8, grep: 3, glob: 1, run_command: 1 })),
    ),
    "Explored 8 files, 4 searches, ran 1 command",
  );
  assert.equal(
    summarizeActivity(timeline("completed", tools({ read_file: 1, list_dir: 2, edit_file: 3 }))),
    "Explored 1 file, 2 directories, edited 3 files",
  );
  assert.equal(
    summarizeActivity(timeline("completed", tools({ web_search: 2, computer_use: 1 }))),
    "2 web searches, 1 Computer Use action",
  );
  assert.equal(
    summarizeActivity(timeline("completed", tools({ web_search: 1, web_fetch: 2 }))),
    "1 web search, 2 web pages",
  );
});

test("summary leads with the work when nothing was explored", () => {
  assert.equal(summarizeActivity(timeline("completed", tools({ edit_file: 2 }))), "Edited 2 files");
  assert.equal(
    summarizeActivity(timeline("completed", tools({ run_command: 1 }))),
    "Ran 1 command",
  );
  assert.equal(
    activityLineText(step("compact", 0, "compact_context", "running")),
    "Compacting context",
  );
  assert.equal(
    summarizeActivity(timeline("completed", tools({ compact_context: 1 }))),
    "Compacted context",
  );
  assert.equal(isCompactContextOnly(tools({ compact_context: 1 })), true);
  assert.equal(isCompactContextOnly(tools({ compact_context: 1, read_file: 1 })), false);
  // Each repeated compaction carries its own metrics, so the trail must stay.
  assert.equal(isCompactContextOnly(tools({ compact_context: 2 })), false);
  assert.equal(isCompactContextOnly([]), false);
  assert.equal(
    isCompactContextOnly([thinking("think-1", 0, 1_000), step("compact", 1, "compact_context")]),
    false,
  );
});

test("uncounted tools fall back to a neutral tool-call tally", () => {
  assert.equal(
    summarizeActivity(
      timeline("completed", tools({ read_file: 1, schedule_task: 1, notion__search: 1 })),
    ),
    "Explored 1 file, 2 tool calls",
  );
});

test("a denied call is skipped, not counted as work done", () => {
  assert.equal(
    summarizeActivity(timeline("completed", [step("deny", 0, "run_command", "blocked")])),
    "Skipped 1 command",
  );
  assert.equal(
    summarizeActivity(
      timeline("completed", [
        step("read", 0, "read_file"),
        step("deny-edit", 1, "edit_file", "blocked"),
        step("deny-write", 2, "write_file", "blocked"),
      ]),
    ),
    "Explored 1 file, skipped 2 file changes",
  );
  assert.equal(
    summarizeActivity(
      timeline("completed", [
        step("run", 0, "run_command"),
        step("deny-run", 1, "run_command", "blocked"),
        step("deny-fetch", 2, "web_fetch", "blocked"),
      ]),
    ),
    "Ran 1 command, skipped 2 actions",
  );
  // A stopped call may have run partway, so it still counts.
  assert.equal(
    summarizeActivity(timeline("cancelled", [step("stop", 0, "run_command", "cancelled")])),
    "Ran 1 command",
  );
});

test("a call waiting for approval is not reported as running", () => {
  assert.equal(
    summarizeActivity(timeline("running", [step("ask", 0, "run_command", "awaiting_approval")])),
    "Waiting for approval",
  );
  assert.equal(
    summarizeActivity(
      timeline("running", [step("read", 0, "read_file"), step("ask", 1, "edit_file", "awaiting_approval")]),
    ),
    "Exploring 1 file",
  );
});

test("a live turn reads in the present tense", () => {
  assert.equal(
    summarizeActivity(timeline("running", tools({ read_file: 2, run_command: 1 }))),
    "Exploring 2 files, running 1 command",
  );
  assert.equal(summarizeActivity(timeline("running", [thinking("think-1", 0)])), "Thinking");
  assert.equal(
    summarizeActivity(timeline("completed", [thinking("think-1", 0, 3_000)])),
    "Thought for 3s",
  );
});

test("reasoning never inflates the tool tally", () => {
  const steps: AgentStep[] = [
    thinking("think-1", 0, 3_000),
    step("read", 1, "read_file"),
    thinking("think-2", 2, 1_000),
  ];
  assert.equal(summarizeActivity(timeline("completed", steps)), "Explored 1 file");
});

test("issues surface for review without reopening a healthy trail", () => {
  const clean = timeline("completed", tools({ read_file: 1 }));
  assert.equal(activityIssueCount(clean), 0);
  assert.equal(activityTrailNeedsAttention(clean), false);

  const failed = timeline("completed", [
    step("edit", 0, "edit_file", "failed"),
    step("run", 1, "run_command", "cancelled"),
  ]);
  assert.equal(activityIssueCount(failed), 2);
  assert.equal(activityTrailNeedsAttention(failed), true);
});

test("active thinking and named tool helpers match live timeline steps", () => {
  const liveThink = timeline("running", [thinking("think-1", 0)]);
  const doneThink = timeline("completed", [thinking("think-1", 0, 3_000)]);
  const rendering = timeline("running", [
    step("render", 0, "render_artifact", "running"),
  ]);
  assert.equal(hasActiveThinkingStep(liveThink), true);
  assert.equal(hasActiveThinkingStep(doneThink), false);
  assert.equal(hasActiveThinkingStep(null), false);
  assert.equal(hasActiveToolStep(rendering, "render_artifact"), true);
  assert.equal(hasActiveToolStep(rendering, "read_file"), false);
  assert.equal(isToolStep(rendering.steps[0]!), true);
});

test("agent-run activity changes tense like Aiden's own tools, with the same lines as both phone apps", () => {
  // Persisted labels as Google Antigravity steps record them; the expected lines
  // are mirrored in the iOS and Android presentation tests.
  const expected: Array<[string, string, "running" | "completed", string | undefined, string | undefined, string]> = [
    ["delete_file", "Delete file", "running", "old.ts", undefined, "Deleting old.ts"],
    ["delete_file", "Delete file", "completed", "old.ts", undefined, "Deleted old.ts"],
    ["move_file", "Move file", "completed", "src/a.ts", undefined, "Moved src/a.ts"],
    ["web_fetch", "Fetch web page", "completed", undefined, undefined, "Fetched web page"],
    ["agent_subagents", "Run subagents", "completed", undefined, undefined, "Ran subagents"],
    ["agent_tool", "Use agent tool", "running", undefined, undefined, "Using an agent tool"],
    ["agent_context_rebuilt", "Started a fresh agent session from this chat", "completed", undefined, undefined, "Started a fresh agent session"],
    ["run_command", "Run command", "completed", undefined, "a command", "Ran a command"],
  ];
  for (const [toolName, label, status, target, detail, line] of expected) {
    const row = { ...step(toolName, 0, toolName, status), label, ...(target ? { target } : {}), ...(detail ? { detail } : {}) };
    assert.equal(activityLineText(row), line);
  }
});

test("an image generation row reads naturally and names its ratio once settled", () => {
  const base = {
    id: "tool-1",
    order: 0,
    kind: "tool" as const,
    toolCallId: "call-1",
    toolName: "generate_image",
    label: "Generate image",
    startedAt: 1,
    updatedAt: 1,
    detail: "16:9",
  };
  assert.equal(activityLineText({ ...base, status: "running" }), "Generating image");
  assert.equal(activityLineText({ ...base, status: "completed" }), "Generated image 16:9");
  assert.equal(activityLineText({ ...base, status: "failed" }), "Generate image failed 16:9");
  // The model id never shows raw: a curated name, else the id's last segment.
  assert.equal(
    activityLineText({ ...base, status: "completed", target: "fal/fal-ai/nano-banana-pro" }),
    "Generated image 16:9 · Nano Banana Pro",
  );
  const { detail: _ratio, ...unshaped } = base;
  assert.equal(
    activityLineText({ ...unshaped, status: "completed", target: "openrouter/google/gemini-2.5-flash-image" }),
    "Generated image gemini-2.5-flash-image",
  );
  assert.equal(activityLineText({ ...unshaped, status: "completed", target: "unknown/model" }), "Generated image");
});
