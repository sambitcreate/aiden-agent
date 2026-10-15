import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
  applyBotLiveEvent,
  botLastReplyAt,
  botRetryableFailedTurn,
  type BotLiveEvent,
  type BotLiveSnapshot,
  type BotPendingQuestion,
} from "../../../renderer/shared/bot-live.js";
import { botTranscriptRows } from "../../../renderer/main/bots/bot-transcript-rows.js";
import { createBotSessionService, type BotSessionRuntime, type BotSessionServiceDeps } from "./bot-session-service.js";
import {
  BOT_CONNECT_CARD_ENTRY_KIND,
  createBotLiveProjection,
  liveBotActivity,
  liveQueuedInputIds,
  liveQueuedMessages,
  projectBotTranscript,
  type BotLiveProjection,
  type BotLiveProjectionDeps,
} from "./live-projection.js";
import { createBotQuestions } from "./bot-questions.js";
import { createBotTurnIntents, stopWithIntents, wireBotLiveTurnIntents } from "./bot-turn-intents.js";
import { spawnHarnessChild } from "./test-support/child.js";
import { countingTool, recordingDeps } from "./test-support/fixtures.js";
import { optionAnswer, QUESTION_ARGS, QUESTION_TOOL_NAME, questionEntries } from "./test-support/question-fixtures.js";
import { createFauxModels, FAUX_MODEL_REF, slowAnswer, waitFor, type FauxModels } from "./test-support/faux.js";

const ctx = BACKGROUND_CONTEXT;
const roots: string[] = [];
function tempProfile(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "aiden-bot-live-"));
  roots.push(root);
  return root;
}
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

interface Harness {
  service: BotSessionRuntime;
  projection: BotLiveProjection;
  close(): Promise<void>;
}

async function start(
  fauxModels: FauxModels,
  options: { service?: Partial<BotSessionServiceDeps>; projection?: Partial<BotLiveProjectionDeps> } = {},
): Promise<Harness> {
  let projection: BotLiveProjection | undefined;
  const service = await createBotSessionService({
    profileDir: tempProfile(),
    models: fauxModels.models,
    extension: recordingDeps(),
    resolveModel: async () => FAUX_MODEL_REF,
    knownBotIds: async () => new Set(["bot:a"]),
    onStateChange: (botId, state) => projection?.notifyState(botId, state),
    ...options.service,
  });
  projection = createBotLiveProjection({
    conversation: (botId) => service.conversation(botId),
    state: (botId) => service.state(botId),
    quietInputs: (botId, ids) => service.quietInputs(botId, ids),
    ...options.projection,
  });
  return {
    service,
    projection,
    async close() {
      await projection!.close();
      await service.shutdown();
    },
  };
}

/** A renderer stand-in: applies events like `useBotLive` and records what arrived. */
function recorder() {
  const events: BotLiveEvent[] = [];
  let view: BotLiveSnapshot | null = null;
  let gaps = 0;
  return {
    events,
    sink: {
      send(event: BotLiveEvent) {
        events.push(event);
        if (!view) return;
        const next = applyBotLiveEvent(view, event);
        if (next === null) gaps += 1;
        else view = next;
      },
    },
    start(snapshot: BotLiveSnapshot) {
      view = snapshot;
    },
    get view() {
      return view;
    },
    get gaps() {
      return gaps;
    },
  };
}

/** Wait, outside the projection, until the reply has streamed some text into `pi.live`. */
async function waitForStreamedText(service: BotSessionRuntime, botId: string): Promise<void> {
  const watch = await (await service.conversation(botId)).watch(ctx);
  const hasText = () => {
    const live = watch.value.docs["pi.live"] as { generation?: { message?: { content?: Array<{ text?: string }> } } } | undefined;
    return (live?.generation?.message?.content ?? []).some((part) => (part.text ?? "").length > 0);
  };
  watch.start(async () => undefined);
  try {
    await waitFor(hasText, { what: "streamed text" });
  } finally {
    await watch.stop();
  }
}

function observedPhases(events: readonly BotLiveEvent[]): Array<string | null> {
  const phases: Array<string | null> = [];
  for (const event of events) {
    const activity = event.type === "activity" ? event.activity : event.type === "snapshot" ? event.snapshot.activity : undefined;
    if (activity === undefined) continue;
    const phase = activity?.phase ?? null;
    if (phases[phases.length - 1] !== phase) phases.push(phase);
  }
  return phases;
}

/** Every phase seen appears in `allowed`, in that order (frames may coalesce, so some can be skipped). */
function inOrder(phases: ReadonlyArray<string | null>, allowed: readonly string[]): boolean {
  let at = 0;
  for (const phase of phases) {
    if (phase === null) continue;
    const found = allowed.indexOf(phase, at);
    if (found === -1) return false;
    at = found;
  }
  return true;
}

const visibleText =(snapshot: BotLiveSnapshot | null) =>
  (snapshot?.entries ?? []).map((entry) =>
    entry.type === "user" || entry.type === "assistant"
      ? `${entry.type}:${entry.text}`
      : entry.type === "routine"
        ? `routine:${entry.label}`
        : entry.type,
  );

test("subscribing mid-stream returns a snapshot that already has the partial reply", async () => {
  const fauxModels = createFauxModels([slowAnswer()], { tokensPerSecond: 40 });
  const live = await start(fauxModels);
  try {
    await live.service.send("bot:a", { text: "tell me a story", requestId: "desk-1" });
    await waitForStreamedText(live.service, "bot:a");

    const tape = recorder();
    const { snapshot, unsubscribe } = await live.projection.subscribe("bot:a", tape.sink);
    try {
      assert.equal(snapshot.state.kind, "running");
      assert.match(snapshot.partial ?? "", /^word word/u);
      assert.equal(snapshot.activity?.phase, "writing");
      assert.deepEqual(visibleText(snapshot), ["user:tell me a story"]);
    } finally {
      unsubscribe();
    }
  } finally {
    await live.close();
  }
});

test("events extend the snapshot, and a fresh subscription after a drop starts further along", async () => {
  const fauxModels = createFauxModels([fauxAssistantMessage("first answer"), fauxAssistantMessage("second answer")]);
  const live = await start(fauxModels);
  try {
    const tape = recorder();
    const first = await live.projection.subscribe("bot:a", tape.sink);
    tape.start(first.snapshot);
    const sent = await live.service.send("bot:a", { text: "one", requestId: "desk-1" });
    await live.service.awaitReply("bot:a", sent.submissionId, new AbortController().signal);
    await waitFor(() => visibleText(tape.view).includes("assistant:first answer") && tape.view?.state.kind === "idle", {
      what: "the reply to reach the subscriber",
    });
    assert.equal(tape.gaps, 0);
    assert.deepEqual(visibleText(tape.view), ["user:one", "assistant:first answer"]);
    assert.equal(tape.view?.partial, null);

    // The renderer reloads: its subscription is gone while another turn runs.
    first.unsubscribe();
    const again = await live.service.send("bot:a", { text: "two", requestId: "desk-2" });
    await live.service.awaitReply("bot:a", again.submissionId, new AbortController().signal);

    const reloaded = recorder();
    const second = await live.projection.subscribe("bot:a", reloaded.sink);
    try {
      assert.ok(second.snapshot.seq > tape.view!.seq, "a fresh snapshot is numbered after everything already seen");
      assert.deepEqual(visibleText(second.snapshot), [
        "user:one",
        "assistant:first answer",
        "user:two",
        "assistant:second answer",
      ]);
    } finally {
      second.unsubscribe();
    }
  } finally {
    await live.close();
  }
});

test("reopening the Bot's session starts a new epoch and re-sends a snapshot", async () => {
  const fauxModels = createFauxModels([fauxAssistantMessage("before close"), fauxAssistantMessage("after reopen")]);
  const live = await start(fauxModels, { service: { idleCloseMs: 80 } });
  try {
    const tape = recorder();
    const { snapshot, unsubscribe } = await live.projection.subscribe("bot:a", tape.sink);
    tape.start(snapshot);
    // A watch of our own on the same session: it closes when the harness does.
    const sessionWatch = await (await live.service.conversation("bot:a")).watch(ctx);
    sessionWatch.start(async () => undefined);
    let watchEnd: string | undefined;
    void sessionWatch.closed.then((end) => (watchEnd = end.reason));
    const first = await live.service.send("bot:a", { text: "hi", requestId: "desk-1" });
    await live.service.awaitReply("bot:a", first.submissionId, new AbortController().signal);
    // Idle close ends the watch; the next send reopens the harness. (Polled: the idle timer is unref'd.)
    await waitFor(() => watchEnd !== undefined, { what: "the idle close" });
    assert.equal(watchEnd, "session_closed");
    const second = await live.service.send("bot:a", { text: "again", requestId: "desk-2" });
    await live.service.awaitReply("bot:a", second.submissionId, new AbortController().signal);
    await waitFor(() => visibleText(tape.view).includes("assistant:after reopen"), { what: "the reopened feed" });
    try {
      assert.notEqual(tape.view?.epoch, snapshot.epoch);
      assert.ok(tape.events.some((event) => event.type === "snapshot" && event.epoch !== snapshot.epoch));
      assert.deepEqual(visibleText(tape.view), ["user:hi", "assistant:before close", "user:again", "assistant:after reopen"]);
    } finally {
      unsubscribe();
    }
  } finally {
    await live.close();
  }
});

test("more than 100 undelivered events collapse into one snapshot", async () => {
  const fauxModels = createFauxModels([]);
  const flushes: Array<() => void> = [];
  const live = await start(fauxModels, { projection: { schedule: (flush) => flushes.push(flush) } });
  try {
    const tape = recorder();
    const { snapshot, unsubscribe } = await live.projection.subscribe("bot:a", tape.sink);
    tape.start(snapshot);
    const conversation = await live.service.conversation("bot:a");
    for (let index = 0; index < 120; index += 1) {
      await conversation.submit(
        {
          type: "write",
          entry: { kind: BOT_CONNECT_CARD_ENTRY_KIND, data: { type: "connect_card", pluginId: "notion", reason: `card ${index}`, status: "pending" } },
        },
        ctx,
      );
    }
    await live.projection.refresh("bot:a");
    for (const flush of flushes.splice(0)) flush();
    try {
      assert.equal(tape.events.length, 1);
      assert.equal(tape.events[0]!.type, "snapshot");
      assert.equal(tape.view?.entries.filter((entry) => entry.type === "connect_card").length, 120);
    } finally {
      unsubscribe();
    }
  } finally {
    await live.close();
  }
});

test("a routine turn shows as its label, and a [SILENT] answer hides the whole turn", async () => {
  const fauxModels = createFauxModels([
    fauxAssistantMessage("Here is your meal plan."),
    fauxAssistantMessage("[SILENT]"),
  ]);
  const live = await start(fauxModels);
  try {
    const shown = await live.service.send("bot:a", {
      text: "Plan this week's meals.",
      requestId: "routine:t1:1",
      label: "Weekly meal plan",
    });
    await live.service.awaitReply("bot:a", shown.submissionId, new AbortController().signal);
    const quiet = await live.service.send("bot:a", {
      text: "Anything new?",
      requestId: "routine:t2:1",
      label: "Inbox check",
    });
    await live.service.awaitReply("bot:a", quiet.submissionId, new AbortController().signal);
    await live.service.markSilent("bot:a", quiet.submissionId);

    const tape = recorder();
    const { snapshot, unsubscribe } = await live.projection.subscribe("bot:a", tape.sink);
    unsubscribe();
    assert.deepEqual(visibleText(snapshot), ["routine:Weekly meal plan", "assistant:Here is your meal plan."]);
    const summary = await live.projection.summary("bot:a");
    assert.equal(summary.preview, "Here is your meal plan.");
  } finally {
    await live.close();
  }
});

test("a failed reply is a typed failed turn, and Retry as a new submission answers after it", async () => {
  const failure = fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider is down" });
  const fauxModels = createFauxModels([failure, fauxAssistantMessage("Here it is.")]);
  const live = await start(fauxModels);
  try {
    const first = await live.service.send("bot:a", { text: "Plan dinner", requestId: "desk-1" });
    await live.service.awaitReply("bot:a", first.submissionId, new AbortController().signal).catch(() => undefined);
    const tape = recorder();
    const failed = await live.projection.subscribe("bot:a", tape.sink);
    failed.unsubscribe();
    const last = failed.snapshot.entries[failed.snapshot.entries.length - 1];
    assert.equal(last?.type, "failed_turn");
    assert.equal(last?.type === "failed_turn" && last.retryText, "Plan dinner");
    assert.equal(last?.type === "failed_turn" && last.errorMessage, "provider is down");
    assert.equal(botRetryableFailedTurn(failed.snapshot.entries), last);

    // Retry: the same text, a new request id.
    const retry = await live.service.send("bot:a", { text: last.type === "failed_turn" ? last.retryText! : "", requestId: "desk-2" });
    assert.equal(retry.deduped, false);
    await live.service.awaitReply("bot:a", retry.submissionId, new AbortController().signal);
    const after = await live.projection.subscribe("bot:a", recorder().sink);
    after.unsubscribe();
    assert.deepEqual(visibleText(after.snapshot).slice(-2), ["user:Plan dinner", "assistant:Here it is."]);
    assert.equal(botRetryableFailedTurn(after.snapshot.entries), null);
  } finally {
    await live.close();
  }
});

test("files the Bot wrote in its folder and images it shared become chips; failed or elsewhere writes do not", () => {
  const call = (id: string, name: string, args: Record<string, unknown>) => ({ type: "toolCall", id, name, arguments: args });
  const result = (id: number, toolCallId: string, toolName: string, details: unknown, isError = false) => ({
    id,
    kind: "pi.tool-result",
    model: [{ role: "toolResult", toolCallId, toolName, isError, details, content: [], timestamp: 5 }],
  });
  const entries = projectBotTranscript([
    { id: 1, kind: "pi.user", model: [{ role: "user", content: [{ type: "text", text: "Write my list" }], timestamp: 1 }] },
    {
      id: 2,
      kind: "pi.assistant",
      model: [{
        role: "assistant",
        stopReason: "toolUse",
        timestamp: 2,
        content: [
          call("c1", "write_file", { path: "lists/groceries.md", content: "eggs" }),
          call("c2", "edit_file", { path: "notes.md", old: "a", new: "b" }),
          call("c3", "write_file", { path: "Desktop/x.md", content: "x", location: "full-mac" }),
          call("c4", "write_file", { path: "broken.md", content: "x" }),
        ],
      }],
    },
    result(3, "c1", "write_file", { producedFile: { relativePath: "lists/groceries.md", operation: "written", bytes: 4 } }),
    result(4, "c2", "edit_file", { producedFile: { relativePath: "notes.md", operation: "edited", bytes: 9 } }),
    result(5, "c3", "write_file", { producedFile: { relativePath: "Desktop/x.md", operation: "written", bytes: 1 } }),
    result(6, "c4", "write_file", { producedFile: { relativePath: "broken.md", operation: "written", bytes: 1 } }, true),
    { id: 7, kind: "aiden.bot-shared-image", data: { id: "img-1", name: "chart.png", mimeType: "image/png", size: 3, data: "AAAA" } },
  ] as never);
  assert.deepEqual(
    entries.filter((entry) => entry.type === "file" || entry.type === "shared_image"),
    [
      { id: "3:file", type: "file", path: "lists/groceries.md", operation: "written", at: 5 },
      { id: "4:file", type: "file", path: "notes.md", operation: "edited", at: 5 },
      { id: "7", type: "shared_image", name: "chart.png", mimeType: "image/png", size: 3, data: "AAAA" },
    ],
  );
});

test("tool calls carry a kind, a past-tense label and a short safe detail; results say ok, failed or blocked", () => {
  const result = (id: number, toolCallId: string, toolName: string, timestamp: number, code?: string) => ({
    id,
    kind: "pi.tool-result",
    data: { diagnostics: code ? [{ severity: "error", code, message: code }] : [] },
    model: [{ role: "toolResult", toolCallId, toolName, isError: code !== undefined, content: [], timestamp }],
  });
  const entries = projectBotTranscript([
    { id: 1, kind: "pi.user", model: [{ role: "user", content: [{ type: "text", text: "Plan dinners" }], timestamp: 900 }] },
    {
      id: 2,
      kind: "pi.assistant",
      model: [{
        role: "assistant",
        stopReason: "toolUse",
        timestamp: 1_000,
        content: [
          { type: "toolCall", id: "c1", name: "read_file", arguments: { path: "/Users/sam/lists/grocery-list.md" } },
          { type: "toolCall", id: "c2", name: "run_command", arguments: { command: "cat /Users/sam/.ssh/id_rsa" } },
          { type: "toolCall", id: "c3", name: "web_search", arguments: { query: "lisbon trains" } },
          { type: "toolCall", id: "c4", name: "web_search", arguments: { query: "slow thing" } },
          { type: "toolCall", id: "c5", name: "read_file", arguments: { path: "restart.md" } },
        ],
      }],
    },
    result(3, "c1", "read_file", 1_400),
    result(4, "c2", "run_command", 1_050, "blocked"),
    result(5, "c3", "web_search", 2_000, "tool_error"),
    result(6, "c4", "web_search", 2_500, "aborted"),
    result(7, "c5", "read_file", 2_600, "interrupted"),
  ] as never);
  const assistant = entries.find((entry) => entry.type === "assistant");
  assert.ok(assistant?.type === "assistant");
  assert.deepEqual(assistant.toolCalls[0], { id: "c1", name: "read_file", kind: "reading", label: "Read 1 file", detail: "grocery-list.md" });
  // A command with no description shows no detail: the command itself never reaches the chat.
  assert.deepEqual(assistant.toolCalls[1], { id: "c2", name: "run_command", kind: "command", label: "Ran a command" });
  assert.deepEqual(assistant.toolCalls[2], { id: "c3", name: "web_search", kind: "searching", label: "Searched the web", detail: "lisbon trains" });
  const results = entries.flatMap((entry) =>
    entry.type === "tool_result" ? [[entry.toolCallId, entry.status, entry.durationMs, entry.at]] : [],
  );
  assert.deepEqual(results, [
    ["c1", "ok", 400, 1_400],
    ["c2", "blocked", 50, 1_050],
    ["c3", "failed", 1_000, 2_000],
    ["c4", "stopped", 1_500, 2_500],
    ["c5", "stopped", 1_600, 2_600],
  ]);
});

test("a tool the Bot's access or the person refused is blocked, a tool that broke is failed, and neither looks like the other", async () => {
  const shell = countingTool("run_command");
  const gated = countingTool("send_email");
  const search = countingTool("web_search", async () => {
    throw new Error("The search service is down.");
  });
  const fauxModels = createFauxModels([
    fauxAssistantMessage([fauxToolCall("run_command", { text: "ls" }), fauxToolCall("web_search", { text: "trains" }), fauxToolCall("send_email", { text: "hi" })], {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("I couldn't do that one."),
  ]);
  const live = await start(fauxModels, {
    service: {
      extension: recordingDeps({
        tools: [
          { tool: shell, replay: "unsafe" },
          { tool: search, replay: "unsafe" },
          { tool: gated, replay: "unsafe" },
        ],
        policy: (name) =>
          name === "run_command"
            ? { allowed: false, reason: "The shell is off for this Bot." }
            : name === "send_email"
              ? { allowed: true, approval: { summary: "Send an email" } }
              : { allowed: true },
        approve: async () => "deny",
      }),
    },
  });
  try {
    const sent = await live.service.send("bot:a", { text: "go", requestId: "desk-1" });
    await live.service.awaitReply("bot:a", sent.submissionId, new AbortController().signal);
    const view = await (await live.service.conversation("bot:a")).context(ctx);
    const statuses = new Map(
      projectBotTranscript(view.entries).flatMap((entry) => (entry.type === "tool_result" ? [[entry.toolName, entry] as const] : [])),
    );
    assert.equal(statuses.get("run_command")?.status, "blocked");
    assert.equal(statuses.get("web_search")?.status, "failed");
    assert.equal(statuses.get("send_email")?.status, "blocked", "a declined approval is blocked, not failed");
    assert.deepEqual(shell.executions, [], "a refused tool never runs");
    assert.deepEqual(gated.executions, [], "a declined tool never runs");
    for (const entry of statuses.values()) {
      assert.ok(typeof entry.durationMs === "number" && entry.durationMs >= 0);
    }
  } finally {
    await live.close();
  }
});

test("memory saves show one quiet line each: in-turn saves that changed something and reviews that added", () => {
  const result = (id: number, toolCallId: string, details: unknown, isError = false) => ({
    id,
    kind: "pi.tool-result",
    model: [{ role: "toolResult", toolCallId, toolName: "bot_memory", isError, details, content: [], timestamp: 5 }],
  });
  const entries = projectBotTranscript([
    { id: 1, kind: "pi.user", model: [{ role: "user", content: [{ type: "text", text: "I have a dog" }], timestamp: 1 }] },
    {
      id: 2,
      kind: "pi.assistant",
      model: [{ role: "assistant", stopReason: "toolUse", timestamp: 2, content: [{ type: "toolCall", id: "m1", name: "bot_memory", arguments: {} }] }],
    },
    result(3, "m1", { changed: 1, targets: ["user"] }),
    result(4, "m2", { changed: 0, targets: [] }),
    result(5, "m3", { changed: 0, targets: [] }, true),
    { id: 6, kind: "aiden.memory-review", data: { source: "review", added: 2, targets: ["user", "memory"] } },
    { id: 7, kind: "aiden.memory-review", data: { source: "review", added: 0, targets: [] } },
    { id: 8, kind: "aiden.memory-review", data: { source: "review", added: 0, targets: [], failed: true } },
    { id: 9, kind: "aiden.memory-review", data: { source: "compaction", added: 1, targets: ["memory"] } },
  ] as never);
  assert.deepEqual(
    entries.filter((entry) => entry.type === "memory_update"),
    [
      { id: "3:memory", type: "memory_update", targets: ["user"], source: "turn", at: 5 },
      { id: "6", type: "memory_update", targets: ["user", "memory"], source: "review" },
      { id: "9", type: "memory_update", targets: ["memory"], source: "compaction" },
    ],
  );
});

test("a routine proposal is one card that shows its newest decision", () => {
  const proposal = (id: number, proposalId: string, name: string) => ({
    id,
    kind: "aiden.routine-proposal",
    data: {
      proposalId,
      name,
      prompt: "Plan this week's meals.",
      schedule: { kind: "weekly", time: "09:00", days: [0] },
      timezone: "Asia/Kolkata",
      label: "Every Sunday at 9:00 AM",
    },
  });
  const entries = projectBotTranscript([
    proposal(1, "p-1", "Weekly meal plan"),
    proposal(2, "p-2", "Daily check-in"),
    { id: 3, kind: "aiden.routine-proposal-status", data: { proposalId: "p-1", status: "dismissed" } },
    { id: 4, kind: "aiden.routine-proposal-status", data: { proposalId: "p-1", status: "accepted", routineId: "task-9" } },
    { id: 5, kind: "aiden.routine-proposal-status", data: { proposalId: "unknown", status: "accepted" } },
  ] as never);
  assert.deepEqual(
    entries.map((entry) => (entry.type === "routine_proposal" ? [entry.id, entry.proposal.name, entry.status, entry.routineId] : entry.type)),
    [
      ["1", "Weekly meal plan", "accepted", "task-9"],
      ["2", "Daily check-in", "pending", undefined],
    ],
  );
});

test("a hidden prompt never shows, but its reply does", async () => {
  const fauxModels = createFauxModels([fauxAssistantMessage("Hi! I'm your Meal Planner.")]);
  const live = await start(fauxModels);
  try {
    const intro = await live.service.send("bot:a", {
      text: "Introduce yourself.",
      requestId: "intro:bot:a",
      hidden: true,
    });
    await live.service.awaitReply("bot:a", intro.submissionId, new AbortController().signal);
    const tape = recorder();
    const { snapshot, unsubscribe } = await live.projection.subscribe("bot:a", tape.sink);
    unsubscribe();
    assert.deepEqual(visibleText(snapshot), ["assistant:Hi! I'm your Meal Planner."]);
  } finally {
    await live.close();
  }
});

test("Stop ends the running reply, keeps what was written, and the Bot is idle again", async () => {
  const fauxModels = createFauxModels([slowAnswer()], { tokensPerSecond: 40 });
  const live = await start(fauxModels);
  try {
    const tape = recorder();
    const { snapshot, unsubscribe } = await live.projection.subscribe("bot:a", tape.sink);
    tape.start(snapshot);
    await live.service.send("bot:a", { text: "go", requestId: "desk-1" });
    await waitFor(() => (tape.view?.partial ?? "").length > 0, { what: "a partial reply" });
    live.projection.notifyStopping("bot:a");
    const state = await live.service.stop("bot:a");
    assert.equal(state.kind, "idle");
    await waitFor(() => tape.view?.partial === null && tape.view.state.kind === "idle", { what: "the stop to land" });
    const phases = observedPhases(tape.events);
    assert.ok(phases.includes("stopping"), phases.join(" → "));
    assert.equal(phases[phases.length - 1], null);
    const last = tape.view!.entries[tape.view!.entries.length - 1];
    assert.equal(last?.type, "assistant");
    assert.equal(last?.type === "assistant" ? last.stopReason : null, "aborted");
    assert.match(last?.type === "assistant" ? last.text : "", /^word/u);
    assert.equal(fauxModels.calls(), 1);
    unsubscribe();
  } finally {
    await live.close();
  }
});

test("two windows on one Bot both follow the reply, and one leaving does not stop the other", async () => {
  const fauxModels = createFauxModels([fauxAssistantMessage("first answer"), fauxAssistantMessage("second answer")]);
  const live = await start(fauxModels);
  try {
    const left = recorder();
    const right = recorder();
    const a = await live.projection.subscribe("bot:a", left.sink);
    left.start(a.snapshot);
    const b = await live.projection.subscribe("bot:a", right.sink);
    right.start(b.snapshot);
    const sent = await live.service.send("bot:a", { text: "one", requestId: "desk-1" });
    await live.service.awaitReply("bot:a", sent.submissionId, new AbortController().signal);
    const answered = (tape: ReturnType<typeof recorder>, text: string) =>
      visibleText(tape.view).includes(`assistant:${text}`) && tape.view?.state.kind === "idle";
    await waitFor(() => answered(left, "first answer") && answered(right, "first answer"), { what: "both windows" });

    a.unsubscribe();
    const again = await live.service.send("bot:a", { text: "two", requestId: "desk-2" });
    await live.service.awaitReply("bot:a", again.submissionId, new AbortController().signal);
    await waitFor(() => answered(right, "second answer"), { what: "the remaining window" });
    assert.equal(visibleText(left.view).includes("assistant:second answer"), false);
    assert.equal(left.gaps + right.gaps, 0);
    b.unsubscribe();
  } finally {
    await live.close();
  }
});

test("a Bot deleted while its chat is open sends that chat nothing more and cannot be reopened", async () => {
  const fauxModels = createFauxModels([fauxAssistantMessage("hello")]);
  const flushes: Array<() => void> = [];
  const live = await start(fauxModels, { projection: { schedule: (flush) => flushes.push(flush) } });
  try {
    const tape = recorder();
    const { snapshot } = await live.projection.subscribe("bot:a", tape.sink);
    tape.start(snapshot);
    const sent = await live.service.send("bot:a", { text: "hi", requestId: "desk-1" });
    await live.service.awaitReply("bot:a", sent.submissionId, new AbortController().signal);
    // Events are waiting to be flushed when the Bot is deleted.
    await waitFor(() => flushes.length > 0, { what: "pending events" });
    await live.service.deleteBot("bot:a");
    await live.projection.close("bot:a");
    for (const flush of flushes.splice(0)) flush();
    assert.equal(tape.events.length, 0, "nothing is delivered after the delete");
    // A late state change for the deleted Bot opens nothing.
    live.projection.notifyState("bot:a", { kind: "idle" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(tape.events.length, 0);
    await assert.rejects(live.projection.subscribe("bot:a", recorder().sink));
  } finally {
    await live.close();
  }
});

test("connect cards carry their current status, and refresh re-sends a changed one", async () => {
  const dismissed = new Set<string>();
  const fauxModels = createFauxModels([]);
  const live = await start(fauxModels, {
    projection: {
      connectCardStatus: async (_botId, card) => (dismissed.has(card.pluginId) ? "dismissed" : card.status),
    },
  });
  try {
    const conversation = await live.service.conversation("bot:a");
    await conversation.submit(
      {
        type: "write",
        entry: { kind: BOT_CONNECT_CARD_ENTRY_KIND, data: { type: "connect_card", pluginId: "notion", reason: "Notes", status: "pending" } },
      },
      ctx,
    );
    const tape = recorder();
    const { snapshot, unsubscribe } = await live.projection.subscribe("bot:a", tape.sink);
    tape.start(snapshot);
    const status = () => {
      const card = tape.view?.entries.find((entry) => entry.type === "connect_card");
      return card?.type === "connect_card" ? card.card.status : null;
    };
    assert.equal(status(), "pending");
    dismissed.add("notion");
    await live.projection.refresh("bot:a");
    await waitFor(() => status() === "dismissed", { what: "the dismissed status" });
    unsubscribe();
  } finally {
    await live.close();
  }
});

test("a waiting question reaches subscribers and late joiners, and its answer replaces it with a reply", async () => {
  const questions = createBotQuestions();
  const fauxModels = createFauxModels([
    fauxAssistantMessage([fauxToolCall(QUESTION_TOOL_NAME, QUESTION_ARGS)], { stopReason: "toolUse" }),
    fauxAssistantMessage("Blue banner coming up."),
  ]);
  const live = await start(fauxModels, {
    service: { extension: recordingDeps({ tools: questionEntries(questions, "bot:a") }) },
    projection: { question: (botId) => questions.pending(botId)[0] ?? null },
  });
  const stopListening = questions.onChange((botId) => void live.projection.refreshQuestion(botId));
  try {
    const tape = recorder();
    const first = await live.projection.subscribe("bot:a", tape.sink);
    tape.start(first.snapshot);
    assert.equal(first.snapshot.question, null);
    await live.service.send("bot:a", { text: "pick a colour", requestId: "desk-1" });
    await waitFor(() => tape.view?.question != null, { what: "the question event" });
    const waitId = tape.view!.question!.waitId;
    assert.equal(tape.view!.question!.questions[0]!.question, QUESTION_ARGS.questions[0]!.question);

    const late = await live.projection.subscribe("bot:a", recorder().sink);
    assert.equal(late.snapshot.question?.waitId, waitId, "a window opened later sees the same card");
    late.unsubscribe();

    assert.equal(questions.answer("bot:a", waitId, optionAnswer(waitId, "Blue")), "answered");
    await waitFor(
      () => tape.view?.question === null && visibleText(tape.view).includes("assistant:Blue banner coming up."),
      { what: "the answer and the reply" },
    );
    assert.equal(tape.gaps, 0);
    const answer = tape.view!.entries.find((entry) => entry.type === "question_answer");
    assert.equal(answer?.type === "question_answer" ? answer.text : undefined, "Blue");
    first.unsubscribe();
  } finally {
    stopListening();
    await live.close();
  }
});

test("Stop pressed while a slow tool runs ends the chat with the person's stopped line", async () => {
  const reader = countingTool(
    "read_file",
    (_params, signal) =>
      new Promise<string>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
  );
  const fauxModels = createFauxModels(
    [
      fauxAssistantMessage([fauxToolCall("read_file", { text: "groceries" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("word ".repeat(40)),
    ],
    { tokensPerSecond: 40 },
  );
  const live = await start(fauxModels, {
    service: { extension: recordingDeps({ tools: [{ tool: reader, replay: "safe" }] }) },
  });
  try {
    const tape = recorder();
    const { snapshot, unsubscribe } = await live.projection.subscribe("bot:a", tape.sink);
    tape.start(snapshot);
    await live.service.send("bot:a", { text: "What's on my list?", requestId: "desk-1" });
    await waitFor(() => tape.view?.activity?.phase === "reading", { what: "the tool to run" });
    live.projection.notifyStopping("bot:a");
    const state = await live.service.stop("bot:a");
    assert.equal(state.kind, "idle");
    await waitFor(() => tape.view?.activity === null && tape.view.state.kind === "idle", { what: "the stop to land" });
    const entries = tape.view!.entries;
    const results = entries.filter((entry) => entry.type === "tool_result");
    assert.deepEqual(
      results.map((entry) => (entry.type === "tool_result" ? entry.status : null)),
      ["stopped"],
    );
    for (const level of ["quiet", "summary"] as const) {
      const rows = botTranscriptRows(entries, tape.view!.partial, { running: false, level });
      assert.equal(rows[rows.length - 1]?.kind, "stopped", `${level}: ${rows.map((row) => row.kind).join(", ")}`);
      const recap = rows.find((row) => row.kind === "recap");
      if (recap?.kind === "recap") assert.deepEqual(recap.steps.map((step) => step.status), ["stopped"]);
    }
    assert.equal(fauxModels.calls(), 1, "the second reply never ran");
    unsubscribe();
  } finally {
    await live.close();
  }
});

test("a reply's activity follows the work: getting ready, reading while a file tool runs, writing, then nothing", async () => {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  const reader = countingTool("read_file", async () => {
    await released;
    return "eggs, milk";
  });
  const fauxModels = createFauxModels(
    [
      fauxAssistantMessage([fauxToolCall("read_file", { text: "groceries" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("word ".repeat(60)),
    ],
    { tokensPerSecond: 40 },
  );
  const live = await start(fauxModels, {
    service: { extension: recordingDeps({ tools: [{ tool: reader, replay: "safe" }] }) },
  });
  try {
    const tape = recorder();
    const { snapshot, unsubscribe } = await live.projection.subscribe("bot:a", tape.sink);
    tape.start(snapshot);
    assert.equal(snapshot.activity, null);
    const sent = await live.service.send("bot:a", { text: "What's on my list?", requestId: "desk-1" });
    await waitFor(() => tape.view?.activity?.phase === "reading", { what: "the reading phase" });
    assert.deepEqual(tape.view?.activity?.step, { kind: "reading", label: "Reading" });
    assert.ok((tape.view?.activity?.startedAt ?? 0) > 0);
    release();
    await live.service.awaitReply("bot:a", sent.submissionId, new AbortController().signal);
    await waitFor(() => tape.view?.activity === null && tape.view.state.kind === "idle", { what: "the line to clear" });
    const phases = observedPhases(tape.events);
    assert.ok(inOrder(phases, ["preparing", "thinking", "reading", "thinking", "writing"]), phases.join(" → "));
    assert.ok(phases.includes("writing"), phases.join(" → "));
    assert.equal(phases[phases.length - 1], null);
    unsubscribe();
  } finally {
    await live.close();
  }
});

test("thinking text is never projected, in the transcript or the live activity", () => {
  const entries = [
    { id: 1, kind: "pi.user", model: [{ role: "user", content: [{ type: "text", text: "Hi" }], timestamp: 1 }] },
    {
      id: 2,
      kind: "pi.assistant",
      model: [{ role: "assistant", stopReason: "stop", timestamp: 2, content: [fauxThinking("SECRET-PLAN"), fauxText("Done.")] }],
    },
  ];
  assert.doesNotMatch(JSON.stringify(projectBotTranscript(entries as never)), /SECRET-PLAN/u);
  const activity = liveBotActivity({
    entries: entries as never,
    docs: { "pi.live": { run: { taskId: 1, inputs: [1] }, generation: { attempt: 1, message: { content: [fauxThinking("SECRET-PLAN")] } } } },
    waiting: false,
    stopping: false,
    resuming: false,
    startedAt: 5,
  });
  assert.deepEqual(activity, { phase: "thinking", startedAt: 5 });
});

test("the live phase reads stop, a waiting card, compaction, the newest running tool, and resume, in that order", () => {
  const user = { id: 1, kind: "pi.user", model: [{ role: "user", content: "go", timestamp: 1 }] };
  const calling = {
    id: 2,
    kind: "pi.assistant",
    model: [{
      role: "assistant",
      stopReason: "toolUse",
      timestamp: 2,
      content: [
        { type: "toolCall", id: "c1", name: "read_file", arguments: { path: "lists/a.md" } },
        { type: "toolCall", id: "c2", name: "web_search", arguments: { query: "tofu bowls" } },
      ],
    }],
  };
  const tools = [
    { callId: "c1", name: "read_file", status: "running" },
    { callId: "c2", name: "web_search", status: "running" },
  ];
  const base = { entries: [user, calling] as never, waiting: false, stopping: false, resuming: false, startedAt: 9 };
  const docs = (live: Record<string, unknown>) => ({ "pi.live": { run: { taskId: 1, inputs: [1] }, ...live } });
  assert.equal(liveBotActivity({ ...base, docs: {} }), null, "no run, no line");
  assert.deepEqual(liveBotActivity({ ...base, docs: docs({ tools }) }), {
    phase: "searching",
    startedAt: 9,
    step: { kind: "searching", label: "Searching the web", detail: "tofu bowls" },
  });
  assert.equal(liveBotActivity({ ...base, docs: docs({ compactions: [{ blocking: true }], tools }) })?.phase, "tidying");
  assert.equal(liveBotActivity({ ...base, waiting: true, docs: docs({ tools }) })?.phase, "waiting");
  assert.equal(liveBotActivity({ ...base, waiting: true, stopping: true, docs: docs({ tools }) })?.phase, "stopping");
  assert.equal(liveBotActivity({ ...base, entries: [user] as never, docs: docs({}) })?.phase, "preparing");
  assert.equal(liveBotActivity({ ...base, docs: docs({}) })?.phase, "thinking");
  assert.equal(liveBotActivity({ ...base, resuming: true, docs: docs({}) })?.phase, "resuming");
  // A paused run's text and tool, still in `pi.live` when the Resume began, are not the resumed run's work.
  const paused = docs({ tools, generation: { attempt: 1, message: { content: [{ type: "text", text: "Half a" }] } } });
  const resumed = { ...base, resuming: true, resumedFrom: JSON.stringify(paused["pi.live"]) };
  assert.equal(liveBotActivity({ ...resumed, docs: paused })?.phase, "resuming");
  assert.equal(liveBotActivity({ ...resumed, stopping: true, docs: paused })?.phase, "stopping");
  assert.equal(liveBotActivity({ ...resumed, docs: docs({ generation: { attempt: 1 } }) })?.phase, "resuming");
  assert.equal(
    liveBotActivity({ ...resumed, docs: docs({ generation: { attempt: 1, message: { content: [{ type: "text", text: "Half a" }] } } }) })?.phase,
    "writing",
    "once anything live happened, text is the resumed run's",
  );
  assert.equal(
    liveBotActivity({ ...base, docs: docs({ generation: { attempt: 1, message: { content: [{ type: "text", text: "Here" }] } } }) })?.phase,
    "writing",
  );
});

test("Stop pressed while nothing runs is ignored, so the next reply never starts at Stopping", async () => {
  const fauxModels = createFauxModels([fauxAssistantMessage("word ".repeat(40))], { tokensPerSecond: 40 });
  const live = await start(fauxModels);
  try {
    const tape = recorder();
    const { snapshot, unsubscribe } = await live.projection.subscribe("bot:a", tape.sink);
    tape.start(snapshot);
    live.projection.notifyStopping("bot:a");
    const sent = await live.service.send("bot:a", { text: "hi", requestId: "desk-1" });
    await live.service.awaitReply("bot:a", sent.submissionId, new AbortController().signal);
    await waitFor(() => tape.view?.activity === null && tape.view.state.kind === "idle", { what: "the reply to land" });
    assert.equal(observedPhases(tape.events).includes("stopping"), false);
    unsubscribe();
  } finally {
    await live.close();
  }
});

/** A reply that waits for `open()` before the model answers: the run holds its "before any output" line. */
function gatedAnswer(text: string) {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return {
    open: () => open(),
    step: async () => {
      await opened;
      return fauxAssistantMessage(text);
    },
  };
}

test("each Stop and Resume intent reaches the desktop projection as its own call, until unwired", async () => {
  const reported: string[] = [];
  const intents = createBotTurnIntents({
    onError: (botId, intent, error) => void reported.push(`${intent} ${botId}: ${(error as Error).message}`),
  });
  const calls: string[] = [];
  const projection = {
    notifyStopping: (botId: string) => void calls.push(`stopping ${botId}`),
    cancelStopping: (botId: string) => void calls.push(`cancel ${botId}`),
    notifyResuming: (botId: string) => void calls.push(`resuming ${botId}`),
  };
  // A listener that throws never keeps the next one from hearing the intent.
  intents.onIntent(() => {
    throw new Error("a broken surface");
  });
  const unwire = wireBotLiveTurnIntents({ intents, projection: () => projection });

  assert.equal(await stopWithIntents(intents, "bot:a", async () => "stopped"), "stopped");
  assert.deepEqual(calls, ["stopping bot:a"], "a Stop that took is never taken back");
  assert.deepEqual(reported, ["stopping bot:a: a broken surface"], "the surface that missed it is reported");

  calls.length = 0;
  const refused = new Error("The Bot is held by another Aiden.");
  await assert.rejects(stopWithIntents(intents, "bot:b", async () => Promise.reject(refused)), (error) => error === refused);
  assert.deepEqual(calls, ["stopping bot:b", "cancel bot:b"], "a Stop that failed takes Stopping back");

  calls.length = 0;
  intents.announce("bot:c", "resuming");
  assert.deepEqual(calls, ["resuming bot:c"]);

  calls.length = 0;
  unwire();
  intents.announce("bot:a", "stopping");
  assert.deepEqual(calls, []);
  // The broken listener is still registered: each intent it missed is reported once.
  assert.deepEqual(reported, [
    "stopping bot:a: a broken surface",
    "stopping bot:b: a broken surface",
    "stopCancelled bot:b: a broken surface",
    "resuming bot:c: a broken surface",
    "stopping bot:a: a broken surface",
  ]);
});

test("a Stop for one Bot leaves another Bot's running reply on its work, never Stopping", async () => {
  const live = await start(createFauxModels([slowAnswer(), slowAnswer()], { tokensPerSecond: 40 }), {
    service: { knownBotIds: async () => new Set(["bot:a", "bot:b"]) },
  });
  const intents = createBotTurnIntents();
  const unwire = wireBotLiveTurnIntents({ intents, projection: () => live.projection });
  try {
    const tapeA = recorder();
    const tapeB = recorder();
    const a = await live.projection.subscribe("bot:a", tapeA.sink);
    tapeA.start(a.snapshot);
    const b = await live.projection.subscribe("bot:b", tapeB.sink);
    tapeB.start(b.snapshot);
    await live.service.send("bot:a", { text: "tell me a story", requestId: "desk-a" });
    await live.service.send("bot:b", { text: "tell me another", requestId: "desk-b" });
    await waitFor(() => tapeA.view?.activity?.phase === "writing" && tapeB.view?.activity?.phase === "writing", {
      what: "both replies to stream",
    });

    await stopWithIntents(intents, "bot:a", () => live.service.stop("bot:a"));
    await waitFor(() => tapeA.view?.activity === null && tapeA.view.state.kind === "idle", { what: "Bot A to stop" });
    assert.ok(observedPhases(tapeA.events).includes("stopping"), observedPhases(tapeA.events).join(" → "));
    // Bot B's feed has handled every intent by now: a refresh runs after it on the same queue.
    await live.projection.refreshActivity("bot:b");
    assert.equal(tapeB.view?.state.kind, "running");
    assert.equal(tapeB.view?.activity?.phase, "writing");
    assert.equal(observedPhases(tapeB.events).includes("stopping"), false, observedPhases(tapeB.events).join(" → "));
    a.unsubscribe();
    b.unsubscribe();
  } finally {
    unwire();
    await live.close();
  }
});

test("a Stop announced while nothing runs changes nothing, and the next reply starts at Getting ready", async () => {
  const answer = gatedAnswer("word ".repeat(20));
  const live = await start(createFauxModels([answer.step], { tokensPerSecond: 40 }));
  const intents = createBotTurnIntents();
  const unwire = wireBotLiveTurnIntents({ intents, projection: () => live.projection });
  try {
    const tape = recorder();
    const { snapshot, unsubscribe } = await live.projection.subscribe("bot:a", tape.sink);
    tape.start(snapshot);
    // A double-tap on Stop after the last reply landed, from the Mac or a phone.
    await stopWithIntents(intents, "bot:a", () => live.service.stop("bot:a"));
    const sent = await live.service.send("bot:a", { text: "hi", requestId: "desk-1" });
    await waitFor(() => tape.view?.activity != null, { what: "the next reply's line" });
    assert.equal(tape.view?.activity?.phase, "preparing");
    answer.open();
    await live.service.awaitReply("bot:a", sent.submissionId, new AbortController().signal);
    await waitFor(() => tape.view?.activity === null && tape.view.state.kind === "idle", { what: "the reply to land" });
    assert.equal(observedPhases(tape.events).includes("stopping"), false, observedPhases(tape.events).join(" → "));
    unsubscribe();
  } finally {
    answer.open();
    unwire();
    await live.close();
  }
});

test("a Stop that fails stops reading Stopping and the reply goes on; the Stop after it ends the reply", async () => {
  const live = await start(createFauxModels([slowAnswer()], { tokensPerSecond: 40 }));
  const intents = createBotTurnIntents();
  const unwire = wireBotLiveTurnIntents({ intents, projection: () => live.projection });
  try {
    const tape = recorder();
    const { snapshot, unsubscribe } = await live.projection.subscribe("bot:a", tape.sink);
    tape.start(snapshot);
    await live.service.send("bot:a", { text: "tell me a story", requestId: "desk-1" });
    await waitFor(() => tape.view?.activity?.phase === "writing", { what: "the reply to stream" });
    const pressed = tape.events.length;
    await assert.rejects(
      stopWithIntents(intents, "bot:a", async () => {
        throw new Error("The Bot is held by another Aiden.");
      }),
    );
    const sincePressed = () => observedPhases(tape.events.slice(pressed));
    await waitFor(() => sincePressed()[sincePressed().length - 1] === "writing", { what: "the line to return to the work" });
    assert.deepEqual(observedPhases(tape.events.slice(pressed)), ["stopping", "writing"]);
    assert.equal(tape.view?.state.kind, "running", "the reply goes on");

    assert.equal((await stopWithIntents(intents, "bot:a", () => live.service.stop("bot:a"))).kind, "idle");
    await waitFor(() => tape.view?.activity === null && tape.view.state.kind === "idle", { what: "the stop to land" });
    assert.ok(observedPhases(tape.events.slice(pressed)).lastIndexOf("stopping") > 0);
    unsubscribe();
  } finally {
    unwire();
    await live.close();
  }
});

test("Resume is announced only for a Resume the session carried out, and before the resumed run is published", async () => {
  const profileDir = tempProfile();
  const child = spawnHarnessChild("stream", [profileDir, "bot:killed", "req-killed"]);
  await child.waitFor("STREAMING");
  await child.kill();
  const intents = createBotTurnIntents();
  const heard: string[] = [];
  intents.onIntent((botId, intent) => void heard.push(`${intent} ${botId}`));
  let projection: BotLiveProjection | undefined;
  const live = await start(createFauxModels([fauxAssistantMessage("resumed answer")]), {
    service: {
      profileDir,
      knownBotIds: async () => new Set(["bot:a", "bot:killed"]),
      // The desktop wiring (`bot-session-main.ts`): the session announces a Resume it carried out.
      onResumed: (botId) => intents.announce(botId, "resuming"),
      onStateChange: (botId, state) => {
        heard.push(`${state.kind} ${botId}`);
        projection?.notifyState(botId, state);
      },
    },
  });
  projection = live.projection;
  const unwire = wireBotLiveTurnIntents({ intents, projection: () => live.projection });
  try {
    await live.service.initialize();
    heard.length = 0;
    // Nothing to pick up: an idle Bot's Resume announces nothing.
    assert.equal((await live.service.resume("bot:a", "desk-1")).kind, "idle");
    assert.equal(heard.length, 0, heard.join(", "));

    await live.service.resume("bot:killed", "desk-2");
    await live.service.resume("bot:killed", "desk-2");
    // Heard before the running state, so the projection marks the run it starts.
    assert.deepEqual(heard.slice(0, 2), ["resuming bot:killed", "running bot:killed"]);
    await waitFor(async () => (await live.service.state("bot:killed")).kind === "idle", { what: "the resumed turn to finish" });
    assert.equal(heard.filter((line) => line.startsWith("resuming")).length, 1, heard.join(", "));
  } finally {
    unwire();
    await live.close();
  }
});

test("a Resume after a crash mid-reply picks up where it left off; the killed run's text is not new writing", async () => {
  const profileDir = tempProfile();
  const child = spawnHarnessChild("stream", [profileDir, "bot:killed", "req-killed"]);
  await child.waitFor("STREAMING");
  await child.kill();
  const answer = gatedAnswer("resumed answer");
  const intents = createBotTurnIntents();
  let projection: BotLiveProjection | undefined;
  const live = await start(createFauxModels([answer.step]), {
    service: {
      profileDir,
      knownBotIds: async () => new Set(["bot:killed"]),
      // The desktop wiring (`bot-session-main.ts`).
      onResumed: (botId) => intents.announce(botId, "resuming"),
      onStateChange: (botId, state) => projection?.notifyState(botId, state),
    },
  });
  projection = live.projection;
  const unwire = wireBotLiveTurnIntents({ intents, projection: () => live.projection });
  try {
    await live.service.initialize();
    const tape = recorder();
    const { snapshot, unsubscribe } = await live.projection.subscribe("bot:killed", tape.sink);
    tape.start(snapshot);
    assert.equal(snapshot.state.kind, "interrupted");
    assert.ok(snapshot.partial?.includes("word"), "the killed run's text is still on screen");

    await live.service.resume("bot:killed", "desk-1");
    // The model has not answered yet: the line holds through the resumed run's first live events.
    await waitFor(() => tape.view?.activity != null, { what: "the resumed run's line" });
    await live.projection.refreshActivity("bot:killed");
    assert.equal(tape.view?.activity?.phase, "resuming", observedPhases(tape.events).join(" → "));
    answer.open();
    await waitFor(() => tape.view?.activity === null && tape.view.state.kind === "idle", { what: "the resumed turn to land" });
    const phases = observedPhases(tape.events).filter((phase) => phase !== null);
    assert.equal(phases[0], "resuming", phases.join(" → "));
    assert.ok(inOrder(phases, ["resuming", "writing"]), phases.join(" → "));
    unsubscribe();
  } finally {
    answer.open();
    unwire();
    await live.close();
  }
});

/** Every distinct (turn start, phase) the line showed, in order. */
function observedTurns(events: readonly BotLiveEvent[]): Array<{ startedAt: number; phase: string }> {
  const seen: Array<{ startedAt: number; phase: string }> = [];
  for (const event of events) {
    const activity = event.type === "activity" ? event.activity : event.type === "snapshot" ? event.snapshot.activity : null;
    if (!activity) continue;
    const last = seen[seen.length - 1];
    if (last?.startedAt !== activity.startedAt || last.phase !== activity.phase) {
      seen.push({ startedAt: activity.startedAt, phase: activity.phase });
    }
  }
  return seen;
}

test("a Resume marks the run it started, and the turn after it reads normally", async () => {
  const fauxModels = createFauxModels(
    [fauxAssistantMessage("word ".repeat(30)), fauxAssistantMessage("word ".repeat(30))],
    { tokensPerSecond: 40 },
  );
  const live = await start(fauxModels);
  try {
    const tape = recorder();
    const { snapshot, unsubscribe } = await live.projection.subscribe("bot:a", tape.sink);
    tape.start(snapshot);
    const reply = async (text: string, requestId: string) => {
      const sent = await live.service.send("bot:a", { text, requestId });
      await live.service.awaitReply("bot:a", sent.submissionId, new AbortController().signal);
      await waitFor(() => tape.view?.activity === null && tape.view.state.kind === "idle", { what: "the reply to land" });
    };
    live.projection.notifyResuming("bot:a");
    await reply("resumed turn", "desk-1");
    assert.ok(observedPhases(tape.events).includes("resuming"));
    const after = tape.events.length;
    await reply("the next turn", "desk-2");
    assert.equal(observedPhases(tape.events.slice(after)).includes("resuming"), false);
    unsubscribe();
  } finally {
    await live.close();
  }
});

test("a tool round hands the run to a new generation but is still one turn: one start time, and Stop keeps reading Stopping", async () => {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  const reader = countingTool("read_file", async () => {
    await released;
    return "eggs, milk";
  });
  const fauxModels = createFauxModels(
    [
      fauxAssistantMessage([fauxToolCall("read_file", { text: "groceries" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("word ".repeat(40)),
    ],
    { tokensPerSecond: 40 },
  );
  let tick = 1_000;
  const live = await start(fauxModels, {
    service: { extension: recordingDeps({ tools: [{ tool: reader, replay: "safe" }] }) },
    projection: { now: () => (tick += 1_000) },
  });
  try {
    const tape = recorder();
    const { snapshot, unsubscribe } = await live.projection.subscribe("bot:a", tape.sink);
    tape.start(snapshot);
    const sent = await live.service.send("bot:a", { text: "list?", requestId: "desk-1" });
    await waitFor(() => tape.view?.activity?.phase === "reading", { what: "the reading phase" });
    live.projection.notifyStopping("bot:a");
    await waitFor(() => tape.view?.activity?.phase === "stopping", { what: "the stopping line" });
    const stoppedAt = tape.events.length;
    release();
    await live.service.awaitReply("bot:a", sent.submissionId, new AbortController().signal);
    await waitFor(() => tape.view?.activity === null && tape.view.state.kind === "idle", { what: "the reply to land" });
    const turns = observedTurns(tape.events);
    assert.equal(new Set(turns.map((turn) => turn.startedAt)).size, 1, JSON.stringify(turns));
    const after = observedPhases(tape.events.slice(stoppedAt)).filter((phase) => phase !== null);
    // The line never left Stopping after the hand-over: no other phase appears before it clears.
    assert.deepEqual(after, [], after.join(" → "));
    unsubscribe();
  } finally {
    await live.close();
  }
});

test("a follow-up turn queued behind a running one gets its own start time and a clean line", async () => {
  const fauxModels = createFauxModels([slowAnswer(), fauxAssistantMessage("word ".repeat(20))], { tokensPerSecond: 40 });
  let tick = 1_000;
  const live = await start(fauxModels, { projection: { now: () => (tick += 1_000) } });
  try {
    const tape = recorder();
    const { snapshot, unsubscribe } = await live.projection.subscribe("bot:a", tape.sink);
    tape.start(snapshot);
    await live.service.send("bot:a", { text: "tell me a story", requestId: "desk-1" });
    await waitFor(() => tape.view?.activity?.phase === "writing", { what: "the first reply to stream" });
    live.projection.notifyStopping("bot:a");
    await waitFor(() => tape.view?.activity?.phase === "stopping", { what: "the stopping line" });
    const queued = await live.service.send("bot:a", { text: "and another", requestId: "desk-2" });
    await live.service.awaitReply("bot:a", queued.submissionId, new AbortController().signal);
    await waitFor(() => tape.view?.activity === null && tape.view.state.kind === "idle", { what: "the replies to land" });
    const turns = observedTurns(tape.events);
    const starts = [...new Set(turns.map((turn) => turn.startedAt))];
    assert.ok(starts.length >= 2, JSON.stringify(turns));
    assert.ok(starts[1]! > starts[0]!, JSON.stringify(turns));
    const second = turns.filter((turn) => turn.startedAt === starts[1]);
    assert.notEqual(second[0]?.phase, "stopping", JSON.stringify(turns));
    unsubscribe();
  } finally {
    await live.close();
  }
});

test("a follow-up sent while the Bot works shows as queued, and Remove withdraws it before it runs", async () => {
  const fauxModels = createFauxModels([slowAnswer(), fauxAssistantMessage("never")], { tokensPerSecond: 40 });
  const live = await start(fauxModels);
  try {
    const tape = recorder();
    const { snapshot, unsubscribe } = await live.projection.subscribe("bot:a", tape.sink);
    tape.start(snapshot);
    assert.deepEqual(snapshot.queued, []);
    await live.service.send("bot:a", { text: "Plan dinners", requestId: "desk-1" });
    await waitFor(() => (tape.view?.partial ?? "").length > 0, { what: "the first reply to stream" });
    const queued = await live.service.send("bot:a", { text: "Also add dessert", requestId: "desk-2", whenBusy: "followUp" });
    await waitFor(() => tape.view?.queued.length === 1, { what: "the queued message" });
    assert.deepEqual(tape.view?.queued, [
      { submissionId: queued.submissionId, mode: "followUp", text: "Also add dessert", imageCount: 0 },
    ]);
    assert.equal(await live.service.withdraw("bot:a", queued.submissionId), "withdrawn");
    await waitFor(() => tape.view?.queued.length === 0, { what: "the queued message to leave" });
    await live.service.stop("bot:a");
    await waitFor(() => tape.view?.state.kind === "idle", { what: "the stop" });
    assert.equal(fauxModels.calls(), 1, "the withdrawn follow-up never reached the model");
    assert.equal(visibleText(tape.view).includes("user:Also add dessert"), false);
    unsubscribe();
  } finally {
    await live.close();
  }
});

test("Remove on a queued message whose turn already started withdraws nothing", async () => {
  const fauxModels = createFauxModels([fauxAssistantMessage("word ".repeat(30)), slowAnswer()], { tokensPerSecond: 40 });
  const live = await start(fauxModels);
  try {
    const tape = recorder();
    const { snapshot, unsubscribe } = await live.projection.subscribe("bot:a", tape.sink);
    tape.start(snapshot);
    await live.service.send("bot:a", { text: "one", requestId: "desk-1" });
    await waitFor(() => (tape.view?.partial ?? "").length > 0, { what: "the first reply" });
    const second = await live.service.send("bot:a", { text: "two", requestId: "desk-2", whenBusy: "followUp" });
    await waitFor(() => visibleText(tape.view).includes("user:two"), { what: "the follow-up to start" });
    assert.equal(await live.service.withdraw("bot:a", second.submissionId), "started");
    assert.equal(await live.service.withdraw("bot:a", "999999"), "gone");
    await live.service.stop("bot:a");
    unsubscribe();
  } finally {
    await live.close();
  }
});

test("queued inputs are listed by the person's ids only; passive writes never show", () => {
  const notice = (data: unknown) => ({ id: 1, mode: "write", entry: { kind: "aiden.bot-notice", data } });
  const docs = {
    "pi.inbox": {
      items: [
        notice({ notice: "routine", label: "Morning check-in", requestId: "routine:r1:1" }),
        { id: 2, mode: "followUp", content: "Check in on today" },
        { id: 4, mode: "followUp", content: "Introduce yourself" },
        { id: 5, mode: "steer", content: [{ type: "text", text: "Make it vegetarian" }, { type: "image", data: "AA", mimeType: "image/png" }] },
      ],
    },
  };
  assert.deepEqual(liveQueuedInputIds(docs), ["2", "4", "5"]);
  // Only the ids classified as the person's own are listed; 2 and 4 are a routine's and the self-intro.
  assert.deepEqual(liveQueuedMessages(docs, new Set(["5"])), [
    { submissionId: "5", mode: "steer", text: "Make it vegetarian", imageCount: 1 },
  ]);
  // An id not classified yet (or a passive write's) never shows.
  assert.deepEqual(liveQueuedMessages(docs, new Set(["1"])), []);
  assert.deepEqual(liveQueuedMessages({}, new Set(["5"])), []);
});

/** Wait, outside the projection, until the conversation's `pi.inbox` satisfies `predicate`. */
async function waitForInbox(
  service: BotSessionRuntime,
  botId: string,
  predicate: (items: Array<{ mode?: string }>) => boolean,
): Promise<void> {
  const watch = await (await service.conversation(botId)).watch(ctx);
  const items = () => ((watch.value.docs["pi.inbox"] as { items?: Array<{ mode?: string }> } | undefined)?.items ?? []);
  watch.start(async () => undefined);
  try {
    await waitFor(() => predicate(items()), { what: "the inbox" });
  } finally {
    await watch.stop();
  }
}

const queuedTexts = (events: readonly BotLiveEvent[]) =>
  events.flatMap((event) => (event.type === "queued" ? event.queued.map((item) => item.text) : []));

test("a routine queued behind a reply that calls a tool is never listed, even once its notice is placed", async () => {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  const reader = countingTool("read_file", async () => {
    await released;
    return "eggs, milk";
  });
  const fauxModels = createFauxModels(
    [
      fauxAssistantMessage([fauxToolCall("read_file", { text: "groceries" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("word ".repeat(10)),
      fauxAssistantMessage("routine reply"),
    ],
    { tokensPerSecond: 40 },
  );
  const live = await start(fauxModels, {
    service: { extension: recordingDeps({ tools: [{ tool: reader, replay: "safe" }] }) },
  });
  try {
    const tape = recorder();
    const { snapshot, unsubscribe } = await live.projection.subscribe("bot:a", tape.sink);
    tape.start(snapshot);
    await live.service.send("bot:a", { text: "list?", requestId: "desk-1" });
    await waitFor(() => tape.view?.activity?.phase === "reading", { what: "the tool to run" });
    await live.service.send("bot:a", { text: "Check in on today", requestId: "routine:r1:1", label: "Morning check-in" });
    await waitForInbox(live.service, "bot:a", (items) => items.some((item) => item.mode === "followUp"));
    release();
    await waitFor(() => visibleText(tape.view).includes("assistant:routine reply"), { what: "the routine's reply" });
    await waitFor(() => tape.view?.state.kind === "idle", { what: "the Bot to settle" });
    assert.deepEqual(queuedTexts(tape.events), []);
    assert.deepEqual(tape.view?.queued, []);
    unsubscribe();
  } finally {
    await live.close();
  }
});

test("a notice left behind by Stop does not hide the person's next queued message", async () => {
  const fauxModels = createFauxModels([slowAnswer(), slowAnswer(), fauxAssistantMessage("never")], { tokensPerSecond: 40 });
  const live = await start(fauxModels);
  try {
    const tape = recorder();
    const { snapshot, unsubscribe } = await live.projection.subscribe("bot:a", tape.sink);
    tape.start(snapshot);
    await live.service.send("bot:a", { text: "one", requestId: "desk-1" });
    await waitFor(() => (tape.view?.partial ?? "").length > 0, { what: "the first reply to stream" });
    await live.service.send("bot:a", { text: "Check in on today", requestId: "routine:r1:1", label: "Morning check-in" });
    await live.service.stop("bot:a");
    await waitFor(() => tape.view?.state.kind === "idle", { what: "the stop" });
    await live.service.send("bot:a", { text: "two", requestId: "desk-2" });
    await waitFor(() => (tape.view?.partial ?? "").length > 0, { what: "the next reply to stream" });
    await live.service.send("bot:a", { text: "three", requestId: "desk-3", whenBusy: "followUp" });
    await waitFor(() => tape.view?.queued.some((item) => item.text === "three") === true, { what: "the queued message" });
    assert.equal(queuedTexts(tape.events).includes("Check in on today"), false);
    await live.service.stop("bot:a");
    unsubscribe();
  } finally {
    await live.close();
  }
});

test("an intro prompt queued behind a running reply is not listed as the person's message", async () => {
  const fauxModels = createFauxModels([slowAnswer(), fauxAssistantMessage("hello there")], { tokensPerSecond: 40 });
  const live = await start(fauxModels);
  try {
    const tape = recorder();
    const { snapshot, unsubscribe } = await live.projection.subscribe("bot:a", tape.sink);
    tape.start(snapshot);
    await live.service.send("bot:a", { text: "one", requestId: "desk-1" });
    await waitFor(() => (tape.view?.partial ?? "").length > 0, { what: "the first reply to stream" });
    await live.service.send("bot:a", { text: "Introduce yourself", requestId: "intro:bot:a", hidden: true });
    await live.service.send("bot:a", { text: "two", requestId: "desk-2" });
    await waitFor(() => tape.view?.queued.some((item) => item.text === "two") === true, { what: "the person's message" });
    assert.deepEqual(tape.view?.queued.map((item) => item.text), ["two"]);
    assert.equal(queuedTexts(tape.events).includes("Introduce yourself"), false);
    await live.service.stop("bot:a");
    unsubscribe();
  } finally {
    await live.close();
  }
});

/** A projection whose classification can be made to fail or come back empty, with every call and report counted. */
async function startFlaky() {
  const fauxModels = createFauxModels([slowAnswer(), fauxAssistantMessage("never")], { tokensPerSecond: 40 });
  const control = { mode: "ok" as "ok" | "throw" | "empty", calls: 0, reports: 0, callTimes: [] as number[] };
  const live = await start(fauxModels, {
    projection: {
      classifyRetryMs: 150,
      onError: () => {
        control.reports += 1;
      },
      quietInputs: async (botId, ids) => {
        control.calls += 1;
        control.callTimes.push(performance.now());
        if (control.mode === "throw") throw new Error("inspect failed");
        if (control.mode === "empty") return new Map();
        return live.service.quietInputs(botId, ids);
      },
    },
  });
  return { live, control };
}

test("while classifying fails, a cached routine stays hidden and the person's classified message stays listed; the new one waits, then appears", async () => {
  const { live, control } = await startFlaky();
  try {
    const tape = recorder();
    const { snapshot, unsubscribe } = await live.projection.subscribe("bot:a", tape.sink);
    tape.start(snapshot);
    await live.service.send("bot:a", { text: "one", requestId: "desk-1" });
    await waitFor(() => (tape.view?.partial ?? "").length > 0, { what: "the first reply to stream" });
    await live.service.send("bot:a", { text: "Check in on today", requestId: "routine:r1:1", label: "Morning check-in" });
    await live.service.send("bot:a", { text: "dessert", requestId: "desk-2" });
    await waitFor(() => tape.view?.queued.some((item) => item.text === "dessert") === true, { what: "dessert, classified" });
    control.mode = "throw";
    control.calls = 0;
    control.callTimes = [];
    control.reports = 0;
    await live.service.send("bot:a", { text: "drinks", requestId: "desk-3" });
    // The first failure and two retries, while the reply keeps streaming frames.
    await waitFor(() => control.calls >= 3, { what: "two classification retries" });
    assert.deepEqual(tape.view?.queued.map((item) => item.text), ["dessert"], "drinks waits; the routine never shows");
    assert.equal(queuedTexts(tape.events).includes("Check in on today"), false);
    assert.equal(control.reports, 1, "one report per failure streak");
    // Frames arrive every ~25 ms; retries wait out the 150 ms pause instead of following them.
    const [firstCall, , thirdCall] = control.callTimes;
    assert.ok(thirdCall! - firstCall! >= 2 * 150 - 5, `retries are throttled, saw ${control.callTimes.length} calls`);
    control.mode = "ok";
    await waitFor(() => tape.view?.queued.some((item) => item.text === "drinks") === true, {
      what: "drinks after the retry, with no new frame needed",
    });
    assert.deepEqual(tape.view?.queued.map((item) => item.text), ["dessert", "drinks"]);
    await live.service.stop("bot:a");
    unsubscribe();
  } finally {
    await live.close();
  }
});

test("an id the session cannot find stays hidden and is retried", async () => {
  const { live, control } = await startFlaky();
  try {
    const tape = recorder();
    const { snapshot, unsubscribe } = await live.projection.subscribe("bot:a", tape.sink);
    tape.start(snapshot);
    await live.service.send("bot:a", { text: "one", requestId: "desk-1" });
    await waitFor(() => (tape.view?.partial ?? "").length > 0, { what: "the first reply to stream" });
    control.mode = "empty";
    control.calls = 0;
    await live.service.send("bot:a", { text: "dessert", requestId: "desk-2" });
    // The first answer leaves dessert out, and so does the retry (whose outcome has landed once a third call starts).
    await waitFor(() => control.calls >= 3, { what: "two classification retries" });
    assert.deepEqual(tape.view?.queued, []);
    control.mode = "ok";
    await waitFor(() => tape.view?.queued.some((item) => item.text === "dessert") === true, { what: "dessert after the retry" });
    await live.service.stop("bot:a");
    unsubscribe();
  } finally {
    await live.close();
  }
});

test("the last reply time ignores the person's newer messages and replies with no text", () => {
  assert.equal(botLastReplyAt([]), null);
  assert.equal(
    botLastReplyAt([
      { id: "a1", type: "assistant", text: "Here you go.", toolCalls: [], stopReason: "stop", at: 10 },
      { id: "a2", type: "assistant", text: "  ", toolCalls: [], stopReason: "toolUse", at: 20 },
      { id: "u2", type: "user", text: "Thanks", imageCount: 0, at: 30 },
    ]),
    10,
  );
});

test("the last reply time falls back past a reply that has no time", () => {
  assert.equal(
    botLastReplyAt([
      { id: "a1", type: "assistant", text: "Older reply.", toolCalls: [], stopReason: "stop", at: 10 },
      { id: "a2", type: "assistant", text: "Newer reply with no time.", toolCalls: [], stopReason: "stop" },
    ]),
    10,
  );
});

test("a Bot held by another process is never reported as needing the person", async () => {
  const live = await start(createFauxModels([fauxAssistantMessage("Hello.")]), {
    projection: {
      state: async () => ({ kind: "unavailable", reason: "held_by_live_process" }),
      approvalPending: () => true,
    },
  });
  try {
    const summary = await live.projection.summary("bot:a");
    assert.equal(summary.needsYou, false);
    assert.equal(summary.lastReplyAt, null);
  } finally {
    await live.close();
  }
});

test("a message the person sent after the last reply does not move the last reply time", async () => {
  const live = await start(createFauxModels([fauxAssistantMessage("First answer."), slowAnswer()], { tokensPerSecond: 40 }));
  try {
    const first = await live.service.send("bot:a", { text: "One", requestId: "desk-1" });
    await live.service.awaitReply("bot:a", first.submissionId, new AbortController().signal);
    const answered = await live.projection.summary("bot:a");
    await live.service.send("bot:a", { text: "Two", requestId: "desk-2" });
    const waiting = await live.projection.summary("bot:a");
    assert.equal(waiting.preview, "Two", "the newest message is the person's");
    assert.equal(waiting.lastReplyAt, answered.lastReplyAt);
    assert.equal(typeof waiting.lastReplyAt, "number");
  } finally {
    await live.close();
  }
});

test("a list summary says when the last reply arrived and whether the Bot is waiting on the person", async () => {
  let waiting = false;
  const live = await start(createFauxModels([fauxAssistantMessage("Here is your meal plan.")]), {
    projection: { approvalPending: () => waiting },
  });
  try {
    const before = await live.projection.summary("bot:a");
    assert.equal(before.lastReplyAt, null);
    assert.equal(before.needsYou, false);
    const sent = await live.service.send("bot:a", { text: "Plan dinners", requestId: "desk-1" });
    await live.service.awaitReply("bot:a", sent.submissionId, new AbortController().signal);
    const after = await live.projection.summary("bot:a");
    assert.equal(after.preview, "Here is your meal plan.");
    assert.equal(typeof after.lastReplyAt, "number");
    assert.equal(after.lastReplyAt, after.updatedAt, "the newest message is the reply");
    waiting = true;
    assert.equal((await live.projection.summary("bot:a")).needsYou, true);
  } finally {
    await live.close();
  }
});

test("a list summary reads a waiting question and approval whether or not a chat is open", async () => {
  let question: BotPendingQuestion | null = null;
  let approval = false;
  const live = await start(createFauxModels([fauxAssistantMessage("Hello.")]), {
    projection: { question: () => question, approvalPending: () => approval },
  });
  try {
    const closed = async () => (await live.projection.summary("bot:a")).needsYou;
    assert.equal(await closed(), false);
    question = { botId: "bot:a", waitId: "w1", toolCallId: "t1", questions: [] };
    assert.equal(await closed(), true, "a question waits with no chat open");
    question = null;
    approval = true;
    assert.equal(await closed(), true, "an approval waits with no chat open");
    approval = false;
    const { unsubscribe } = await live.projection.subscribe("bot:a", { send() {} });
    try {
      assert.equal(await closed(), false, "settled with a chat open");
      approval = true;
      assert.equal(await closed(), true, "an approval waits with a chat open");
    } finally {
      unsubscribe();
    }
  } finally {
    await live.close();
  }
});
