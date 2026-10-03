import assert from "node:assert/strict";
import test from "node:test";
import {
  HostRunRegistry,
  type HostRunEvent,
  type HostRunRead,
  type HostRunRegistryOptions,
  type HostRunSummary,
} from "./host-run-registry.js";

function harness(options: Partial<HostRunRegistryOptions> = {}) {
  const clock = { now: 1_000 };
  const registry = new HostRunRegistry({ now: () => clock.now, epoch: "epoch-test", ...options });
  const changes: Array<{ summary: HostRunSummary; removed: boolean }> = [];
  registry.onChange((summary, removed) => changes.push({ summary, removed }));
  return { clock, registry, changes };
}

function last<T>(items: readonly T[]): T {
  assert.ok(items.length > 0);
  return items[items.length - 1]!;
}

function events(read: HostRunRead): HostRunEvent[] {
  assert.equal(read.kind, "events");
  return read.events;
}

const question = {
  question: "Which branch should I target?",
  header: "Branch",
  options: [
    { label: "main", description: "The default branch." },
    { label: "release", description: "The release branch." },
  ],
};

function questionnaire(promptId: string, runId: string) {
  return {
    version: 1,
    promptId,
    streamId: runId,
    toolCallId: "call-q",
    questions: [question],
    expiresAt: "2026-10-02T12:00:00.000Z",
  };
}

function approval(approvalId: string) {
  return { approvalId, summary: "Run npm test", toolCallId: "call-a", toolName: "run_command" };
}

test("begin journals run_started once and announces the run", () => {
  const { registry, changes } = harness();
  registry.begin({ runId: "run-1", chatId: "chat-1", origin: "renderer" });
  registry.begin({ runId: "run-1", chatId: "chat-other", origin: "remote" });

  const read = registry.read("run-1", 0);
  assert.deepEqual(events(read), [
    {
      runId: "run-1",
      sequence: 1,
      timestamp: new Date(1_000).toISOString(),
      type: "run_started",
      terminal: false,
      payload: { chatId: "chat-1", origin: "renderer" },
    },
  ]);
  assert.equal(read.epoch, "epoch-test");
  assert.equal(read.summary.state, "working");
  assert.equal(read.summary.chatId, "chat-1");
  assert.equal(read.summary.origin, "renderer");
  assert.equal(changes.length, 1);
  assert.equal(changes[0]!.removed, false);
  assert.equal(changes[0]!.summary.runId, "run-1");
});

test("deltas append contiguous text events without announcing a change", () => {
  const { registry, changes } = harness();
  registry.begin({ runId: "run-1", chatId: "chat-1", origin: "renderer" });
  for (const delta of ["Hel", "lo", " there"]) registry.publish("run-1", "chat:delta", { delta });

  const read = registry.read("run-1", 1);
  assert.deepEqual(
    events(read).map(({ sequence, type, payload }) => ({ sequence, type, payload })),
    [
      { sequence: 2, type: "text_delta", payload: { text: "Hel" } },
      { sequence: 3, type: "text_delta", payload: { text: "lo" } },
      { sequence: 4, type: "text_delta", payload: { text: " there" } },
    ],
  );
  assert.equal(read.summary.lastSequence, 4);
  assert.equal(changes.length, 1, "only begin announced a change");
});

test("a run needs approval until its last pending approval resolves", () => {
  const { registry, changes } = harness();
  registry.begin({ runId: "run-1", chatId: "chat-1", origin: "remote" });
  registry.publish("run-1", "chat:approval", approval("approval-1"));
  registry.publish("run-1", "chat:approval", approval("approval-2"));
  registry.publish("run-1", "chat:delta", { delta: "still streaming" });

  let summary = registry.summary("run-1")!;
  assert.equal(summary.state, "needs_approval");
  assert.deepEqual(summary.pendingApprovalIds, ["approval-1", "approval-2"]);

  registry.resolveAttention("approval-1");
  summary = registry.summary("run-1")!;
  assert.equal(summary.state, "needs_approval");
  assert.deepEqual(summary.pendingApprovalIds, ["approval-2"]);

  registry.resolveAttention("approval-2");
  summary = registry.summary("run-1")!;
  assert.equal(summary.state, "working");
  assert.deepEqual(summary.pendingApprovalIds, []);

  const journal = events(registry.read("run-1", 1));
  assert.deepEqual(
    journal.map(({ type }) => type),
    ["approval_required", "approval_required", "text_delta", "approval_resolved", "approval_resolved"],
  );
  assert.deepEqual(journal[0]!.payload, {
    approvalId: "approval-1",
    summary: "Run npm test",
    toolCallId: "call-a",
    toolName: "run_command",
  });
  assert.deepEqual(journal[4]!.payload, { approvalId: "approval-2" });
  // begin, two arrivals and two resolutions; the delta announced nothing.
  assert.equal(changes.length, 5);
});

test("a pending approval outranks a pending question, which then needs input", () => {
  const { registry } = harness();
  registry.begin({ runId: "run-1", chatId: "chat-1", origin: "renderer" });
  registry.publish("run-1", "chat:questionnaire", questionnaire("prompt-1", "run-1"));
  registry.publish("run-1", "chat:approval", approval("approval-1"));

  let summary = registry.summary("run-1")!;
  assert.equal(summary.state, "needs_approval");
  assert.deepEqual(summary.pendingQuestionIds, ["prompt-1"]);

  registry.resolveAttention("approval-1");
  summary = registry.summary("run-1")!;
  assert.equal(summary.state, "needs_input");
  assert.deepEqual(summary.pendingApprovalIds, []);
  assert.deepEqual(summary.pendingQuestionIds, ["prompt-1"]);

  registry.resolveAttention("prompt-1");
  assert.equal(registry.summary("run-1")!.state, "working");
  const journal = events(registry.read("run-1", 1));
  assert.deepEqual(journal[0]!.payload, {
    promptId: "prompt-1",
    questions: [{ ...question, multiSelect: false }],
    toolCallId: "call-q",
    expiresAt: "2026-10-02T12:00:00.000Z",
  });
  assert.deepEqual(last(journal).payload, { promptId: "prompt-1" });
});

test("chat:done ends the run, clears pending prompts and freezes the journal", () => {
  const { registry } = harness();
  registry.begin({ runId: "run-1", chatId: "chat-1", origin: "renderer" });
  registry.publish("run-1", "chat:approval", approval("approval-1"));
  registry.publish("run-1", "chat:done", {
    chat: { messages: [{ id: "user-1", role: "user" }, { id: "assistant-1", role: "assistant" }] },
  });

  const summary = registry.summary("run-1")!;
  assert.equal(summary.state, "done");
  assert.deepEqual(summary.pendingApprovalIds, []);
  const outcome = last(events(registry.read("run-1", 0)));
  assert.equal(outcome.type, "done");
  assert.equal(outcome.terminal, true);
  assert.deepEqual(outcome.payload, { messageId: "assistant-1" });

  registry.publish("run-1", "chat:delta", { delta: "late" });
  registry.publish("run-1", "chat:approval", approval("approval-2"));
  registry.resolveAttention("approval-1");
  assert.equal(registry.summary("run-1")!.lastSequence, summary.lastSequence);
  assert.equal(registry.summary("run-1")!.state, "done");
});

test("a cancelled chat:done ends the run as cancelled", () => {
  const { registry } = harness();
  registry.begin({ runId: "run-1", chatId: "chat-1", origin: "renderer" });
  registry.publish("run-1", "chat:done", { cancelled: true });

  assert.equal(registry.summary("run-1")!.state, "cancelled");
  const last = events(registry.read("run-1", 1))[0]!;
  assert.equal(last.type, "cancelled");
  assert.equal(last.terminal, true);
});

test("settling a run without an outcome fails it exactly once", () => {
  const { registry, changes } = harness();
  registry.begin({ runId: "run-1", chatId: "chat-1", origin: "headless" });
  registry.publish("run-1", "chat:questionnaire", questionnaire("prompt-1", "run-1"));
  registry.settle("run-1");
  registry.settle("run-1");

  const summary = registry.summary("run-1")!;
  assert.equal(summary.state, "failed");
  assert.deepEqual(summary.pendingQuestionIds, []);
  const journal = events(registry.read("run-1", 2));
  assert.equal(journal.length, 1);
  assert.equal(journal[0]!.type, "error");
  assert.equal(journal[0]!.terminal, true);
  assert.equal(journal[0]!.payload.code, "run_ended_without_outcome");
  assert.equal(last(changes).summary.state, "failed");

  // A run that already reached its outcome is left alone.
  registry.begin({ runId: "run-2", chatId: "chat-1", origin: "headless" });
  registry.publish("run-2", "chat:done", {});
  registry.settle("run-2");
  assert.equal(registry.summary("run-2")!.state, "done");
  assert.equal(registry.summary("run-2")!.lastSequence, 2);
});

test("a cursor behind per-run retention must snapshot while a recent cursor replays", () => {
  const { registry } = harness({ maxEventsPerRun: 5 });
  registry.begin({ runId: "run-1", chatId: "chat-1", origin: "renderer" });
  for (let index = 0; index < 10; index += 1) {
    registry.publish("run-1", "chat:delta", { delta: `d${index}` });
  }
  const last = registry.summary("run-1")!.lastSequence;
  assert.equal(last, 11);

  const behind = registry.read("run-1", 0);
  assert.equal(behind.kind, "snapshot_required");
  assert.equal(behind.epoch, "epoch-test");
  assert.equal(behind.summary.lastSequence, 11);

  assert.deepEqual(
    events(registry.read("run-1", last - 2)).map(({ sequence }) => sequence),
    [10, 11],
  );
  // The oldest retained event is still reachable from just before it.
  assert.deepEqual(
    events(registry.read("run-1", 6)).map(({ sequence }) => sequence),
    [7, 8, 9, 10, 11],
  );
});

test("read rejects an unknown run or a cursor ahead of the journal", () => {
  const { registry } = harness();
  registry.begin({ runId: "run-1", chatId: "chat-1", origin: "renderer" });
  assert.throws(() => registry.read("run-1", 2), RangeError);
  assert.throws(() => registry.read("missing", 0), RangeError);
  assert.deepEqual(events(registry.read("run-1", 1)), []);
});

test("terminal runs past retention are pruned lazily and their observers woken", () => {
  const { clock, registry, changes } = harness({ terminalRetentionMs: 60_000 });
  registry.begin({ runId: "run-1", chatId: "chat-1", origin: "renderer" });
  let wakes = 0;
  registry.subscribe("run-1", () => {
    wakes += 1;
  });
  registry.publish("run-1", "chat:done", {});
  assert.equal(wakes, 1);

  clock.now += 60_000;
  assert.deepEqual(registry.list().map(({ runId }) => runId), ["run-1"]);

  clock.now += 1;
  assert.deepEqual(registry.list(), []);
  assert.equal(wakes, 2);
  assert.equal(registry.summary("run-1"), undefined);
  assert.throws(() => registry.read("run-1", 0), RangeError);
  const removal = last(changes);
  assert.equal(removal.removed, true);
  assert.equal(removal.summary.runId, "run-1");
  assert.equal(removal.summary.state, "done");
});

test("the total byte budget evicts terminal runs before trimming live ones", () => {
  const { registry, changes } = harness({ maxTotalEventBytes: 4_000 });
  const kilobyte = "x".repeat(1_000);
  registry.begin({ runId: "finished", chatId: "chat-1", origin: "renderer" });
  registry.publish("finished", "chat:delta", { delta: kilobyte });
  registry.publish("finished", "chat:done", {});
  registry.begin({ runId: "live", chatId: "chat-2", origin: "remote" });
  registry.publish("live", "chat:delta", { delta: kilobyte });
  registry.publish("live", "chat:delta", { delta: kilobyte });
  assert.deepEqual(registry.list().map(({ runId }) => runId), ["finished", "live"]);

  registry.publish("live", "chat:delta", { delta: kilobyte });
  assert.deepEqual(registry.list().map(({ runId }) => runId), ["live"]);
  assert.deepEqual(
    changes.filter(({ removed }) => removed).map(({ summary }) => summary.runId),
    ["finished"],
  );
  assert.equal(events(registry.read("live", 0)).length, 4, "the live run kept its whole journal");

  // With no terminal run left to evict, the live run loses its oldest events.
  registry.publish("live", "chat:delta", { delta: kilobyte });
  assert.equal(registry.read("live", 0).kind, "snapshot_required");
  assert.deepEqual(events(registry.read("live", 4)).map(({ sequence }) => sequence), [5]);
});

test("the run cap evicts the oldest terminal run, then the oldest-updated live run", () => {
  const { clock, registry, changes } = harness({ maxRuns: 2 });
  registry.begin({ runId: "a", chatId: "chat-1", origin: "renderer" });
  clock.now += 1;
  registry.begin({ runId: "b", chatId: "chat-1", origin: "renderer" });
  clock.now += 1;
  registry.publish("b", "chat:done", {});
  clock.now += 1;
  registry.begin({ runId: "c", chatId: "chat-1", origin: "renderer" });
  assert.deepEqual(registry.list().map(({ runId }) => runId), ["a", "c"]);

  clock.now += 1;
  registry.publish("a", "chat:delta", { delta: "keep a fresh" });
  clock.now += 1;
  registry.begin({ runId: "d", chatId: "chat-1", origin: "renderer" });
  assert.deepEqual(registry.list().map(({ runId }) => runId), ["a", "d"]);
  assert.deepEqual(
    changes.filter(({ removed }) => removed).map(({ summary }) => summary.runId),
    ["b", "c"],
  );
});

test("currentRunForChat returns the chat's newest retained run", () => {
  const { clock, registry } = harness();
  registry.begin({ runId: "run-b", chatId: "chat-1", origin: "renderer" });
  registry.begin({ runId: "run-a", chatId: "chat-1", origin: "renderer" });
  assert.equal(registry.currentRunForChat("chat-1")!.runId, "run-b", "ties break by runId");

  clock.now += 1;
  registry.begin({ runId: "run-0", chatId: "chat-1", origin: "remote" });
  registry.begin({ runId: "run-z", chatId: "chat-2", origin: "remote" });
  assert.equal(registry.currentRunForChat("chat-1")!.runId, "run-0");
  assert.equal(registry.currentRunForChat("chat-3"), undefined);
});

test("malformed or oversized payloads never throw", () => {
  const { registry } = harness();
  registry.begin({ runId: "run-1", chatId: "chat-1", origin: "renderer" });
  const channels = [
    "chat:delta",
    "chat:reasoning-delta",
    "chat:status",
    "chat:tool",
    "chat:timeline",
    "chat:approval",
    "chat:questionnaire",
    "remote:changed",
  ] as const;
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const malformed: unknown[] = [null, undefined, [], ["a"], 42, "text", { details: () => 1 }, cyclic];
  for (const channel of channels) {
    for (const payload of malformed) {
      assert.doesNotThrow(() => registry.publish("run-1", channel, payload));
    }
  }
  assert.doesNotThrow(() => registry.publish("missing", "chat:delta", { delta: "x" }));
  assert.deepEqual(registry.summary("run-1")!.pendingApprovalIds, []);
  assert.deepEqual(registry.summary("run-1")!.pendingQuestionIds, []);

  registry.publish("run-1", "chat:approval", { approvalId: "a".repeat(129), summary: "too long id" });
  registry.publish("run-1", "chat:approval", {
    approvalId: "approval-1",
    summary: "s".repeat(10_000),
    toolName: "t".repeat(500),
    toolCallId: "c".repeat(500),
    details: { kind: "scheduled-task", render: () => "not cloneable" },
  });
  const summary = registry.summary("run-1")!;
  assert.deepEqual(summary.pendingApprovalIds, ["approval-1"]);
  const required = events(registry.read("run-1", summary.lastSequence - 1))[0]!;
  assert.equal((required.payload.summary as string).length, 2_000);
  assert.equal((required.payload.toolName as string).length, 120);
  assert.equal((required.payload.toolCallId as string).length, 128);
  assert.equal("details" in required.payload, false);

  registry.publish("run-1", "chat:questionnaire", { ...questionnaire("prompt-1", "run-1"), questions: [] });
  assert.deepEqual(registry.summary("run-1")!.pendingQuestionIds, []);
});

test("approval scopes and details are copied into the journal", () => {
  const { registry } = harness();
  registry.begin({ runId: "run-1", chatId: "chat-1", origin: "renderer" });
  const details = { kind: "scheduled-task", task: { name: "Nightly" } };
  registry.publish("run-1", "chat:approval", {
    ...approval("approval-1"),
    scopes: ["chat", "bogus", "once"],
    details,
  });
  details.task.name = "Mutated after publish";

  const payload = events(registry.read("run-1", 1))[0]!.payload;
  assert.deepEqual(payload.scopes, ["chat", "once"]);
  assert.deepEqual(payload.details, { kind: "scheduled-task", task: { name: "Nightly" } });
});

test("an oversized approval detail cannot push retained events past the byte budgets", () => {
  // Each detail fits the default allowance but not these smaller budgets.
  const { registry } = harness({ maxEventBytesPerRun: 32 * 1_024, maxTotalEventBytes: 64 * 1_024 });
  const workspaceLabel = "w".repeat(40 * 1_024);
  for (const runId of ["run-1", "run-2", "run-3", "run-4"]) {
    registry.begin({ runId, chatId: `chat-${runId}`, origin: "renderer" });
    registry.publish(runId, "chat:approval", {
      ...approval(`approval-${runId}`),
      details: { kind: "subagent-shell", workspaceLabel, command: "npm test" },
    });
  }

  let retainedBytes = 0;
  for (const runId of ["run-1", "run-2", "run-3", "run-4"]) {
    assert.equal(registry.summary(runId)?.state, "needs_approval");
    assert.deepEqual(registry.summary(runId)?.pendingApprovalIds, [`approval-${runId}`]);
    const retained = events(registry.read(runId, 0));
    const required = last(retained);
    assert.equal(required.type, "approval_required");
    assert.equal(required.payload.approvalId, `approval-${runId}`);
    assert.equal("details" in required.payload, false);
    assert.equal(required.payload.detailsOmitted, true);
    for (const event of retained) retainedBytes += Buffer.byteLength(JSON.stringify(event));
  }
  assert.ok(retainedBytes <= 64 * 1_024, `retained ${retainedBytes} bytes`);
});

test("returned events and summaries are copies", () => {
  const { registry } = harness();
  registry.begin({ runId: "run-1", chatId: "chat-1", origin: "renderer" });
  registry.publish("run-1", "chat:approval", approval("approval-1"));

  const first = events(registry.read("run-1", 0));
  first[0]!.payload.chatId = "tampered";
  first[1]!.type = "tampered";
  registry.summary("run-1")!.pendingApprovalIds.push("tampered");
  registry.list()[0]!.pendingApprovalIds.length = 0;

  const again = events(registry.read("run-1", 0));
  assert.equal(again[0]!.payload.chatId, "chat-1");
  assert.equal(again[1]!.type, "approval_required");
  assert.deepEqual(registry.summary("run-1")!.pendingApprovalIds, ["approval-1"]);
});

test("each registry has its own epoch unless one is supplied", () => {
  const first = new HostRunRegistry({ now: () => 0 });
  const second = new HostRunRegistry({ now: () => 0 });
  assert.notEqual(first.epoch, second.epoch);
  assert.ok(first.epoch.length > 0);
  assert.equal(new HostRunRegistry({ now: () => 0, epoch: "fixed" }).epoch, "fixed");
});

test("subscribers are woken per append until they unsubscribe, and faulty observers are contained", () => {
  const { registry } = harness();
  registry.onChange(() => {
    throw new Error("listener fault");
  });
  registry.begin({ runId: "run-1", chatId: "chat-1", origin: "renderer" });
  const seen: number[] = [];
  registry.subscribe("run-1", () => {
    throw new Error("wake fault");
  });
  const unsubscribe = registry.subscribe("run-1", () => {
    seen.push(registry.summary("run-1")!.lastSequence);
  });
  registry.publish("run-1", "chat:delta", { delta: "a" });
  registry.publish("run-1", "chat:approval", approval("approval-1"));
  unsubscribe();
  registry.publish("run-1", "chat:delta", { delta: "b" });

  assert.deepEqual(seen, [2, 3]);
  assert.equal(registry.summary("run-1")!.lastSequence, 4);
  assert.equal(registry.summary("run-1")!.state, "needs_approval");
});
