import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import test from "node:test";
import type { SubagentRunSnapshotV1 } from "../../renderer/shared/subagent-runs.js";
import type { TodoSnapshotViewV1 } from "../../renderer/shared/todo.js";
import { boundedUnicodePrefix } from "../../renderer/shared/unicode-prefix.js";
import { AidenRemoteChatProgressService } from "./aiden-remote-chat-progress.js";
import { ChatProgressEvents } from "./chat-progress-events.js";
import { parseAidenRemoteChatAgentRoster } from "./aiden-remote-protocol.js";

const todo: TodoSnapshotViewV1 = {
  version: 1,
  chatId: "chat-1",
  availability: "ready",
  tasks: [{ id: 1, subject: "Verify changes", status: "pending" }],
};
const run: SubagentRunSnapshotV1 = {
  version: 1,
  runId: "private-run",
  groupId: "private-group",
  childId: "private-child",
  generationId: "generation-1",
  chatId: "chat-1",
  workspaceId: "workspace-1",
  revision: 1,
  role: "reviewer",
  label: "Review changes",
  taskPreview: "Private child instruction",
  state: "completed",
  startedAt: 10,
  updatedAt: 20,
  finishedAt: 20,
  modelId: "test-model",
  turns: 1,
  tools: 2,
  tokens: 30,
  warnings: [],
  terminalMarkdown: "Private child result",
};

function fixture(
  overrides: Partial<
    ConstructorParameters<typeof AidenRemoteChatProgressService>[0]
  > = {},
) {
  const events = new ChatProgressEvents();
  const service = new AidenRemoteChatProgressService({
    instanceId: "instance-1",
    events,
    now: () => 1000,
    authorize: async (deviceId, chatId) => {
      assert.equal(deviceId, "device-1");
      assert.equal(chatId, "chat-1");
      return { id: chatId, latestGenerationId: "generation-1" };
    },
    readTodo: async () => structuredClone(todo),
    readAgents: async () => [structuredClone(run)],
    ...overrides,
  });
  return { service, events };
}

class Response extends EventEmitter {
  chunks: string[] = [];
  ended = false;
  writeHead() {}
  flushHeaders() {}
  write(chunk: string) {
    this.chunks.push(chunk);
    return true;
  }
  end() {
    this.ended = true;
  }
  get wire() {
    return this as unknown as ServerResponse;
  }
}

test("idle task reads replay durable state and unchanged reads retain revisions", async () => {
  const { service } = fixture();
  const first = await service.taskSnapshot("device-1", "chat-1");
  assert.deepEqual(first.tasks, todo.tasks);
  assert.deepEqual(await service.taskSnapshot("device-1", "chat-1"), first);
});

test("inactive background coordinator runs do not appear in foreground mobile rosters", async () => {
  const { service } = fixture({
    readAgents: async () => [{
      ...run, version: 2, execution: "background", context: "fresh",
      depth: 1, authorityRevision: 1,
    }],
  });
  const roster = await service.agentRoster("device-1", "chat-1");
  assert.deepEqual(roster.agents, []);
  assert.equal(roster.previousTurns, undefined);
});

test("escaped task text and dense dependencies cannot exceed native frame budgets", async () => {
  const ids = Array.from({ length: 256 }, (_, index) => Number.MAX_SAFE_INTEGER - index);
  const { service } = fixture({
    readTodo: async () => ({
      ...todo,
      tasks: ids.map((id, index) => ({
        id, subject: '"'.repeat(512), activeForm: '"'.repeat(512),
        status: "pending", blockedBy: ids.slice(0, index),
      })),
    }),
  });
  const snapshot = await service.taskSnapshot("device-1", "chat-1");
  assert.equal(snapshot.availability, "unavailable");
  assert.equal(snapshot.unavailableReason, "invalid_snapshot");
  assert.deepEqual(snapshot.tasks, []);
});

test("running task state is exposed only by a durable publication, not in-memory journal reads", async () => {
  let reads = 0;
  const { service, events } = fixture({
    readTodo: async () => {
      reads++;
      return todo;
    },
  });
  events.begin("chat-1", "generation-1");
  assert.equal(
    (await service.taskSnapshot("device-1", "chat-1")).availability,
    "unavailable",
  );
  events.durableTodo("chat-1", "generation-1", todo);
  assert.deepEqual(
    (await service.taskSnapshot("device-1", "chat-1")).tasks,
    todo.tasks,
  );
  assert.equal(reads, 0);
  events.settle("chat-1", "generation-1");
  await service.taskSnapshot("device-1", "chat-1");
  assert.equal(reads, 1);
});

test("a slow idle read cannot replace a newly started turn's durable task state", async () => {
  let resolve!: (value: TodoSnapshotViewV1) => void;
  const { service, events } = fixture({
    readTodo: () =>
      new Promise((done) => {
        resolve = done;
      }),
  });
  const pending = service.taskSnapshot("device-1", "chat-1");
  await new Promise((done) => setImmediate(done));
  events.begin("chat-1", "generation-2");
  events.durableTodo("chat-1", "generation-2", { ...todo, tasks: [] });
  resolve(todo);
  assert.deepEqual((await pending).tasks, []);
});

test("public agents retain display facts but omit private identities, instructions and results", async () => {
  const { service } = fixture();
  const roster = await service.agentRoster("device-1", "chat-1");
  assert.equal(roster.agents[0]?.label, run.label);
  assert.equal(roster.agents[0]?.state, "completed");
  assert.match(roster.agents[0]!.agentId, /^agent_/);
  assert.match(roster.turnId!, /^turn_/);
  const json = JSON.stringify(roster);
  for (const value of [
    run.runId,
    run.childId,
    run.groupId,
    run.generationId,
    run.workspaceId,
    run.taskPreview,
    run.terminalMarkdown!,
  ])
    assert.ok(!json.includes(value), value);
  assert.deepEqual(
    await service.agentRoster("device-1", "chat-1", roster.turnId),
    { ...roster, revision: roster.revision + 1 },
  );
  await assert.rejects(
    service.agentRoster("device-1", "chat-1", "turn_other"),
    /unavailable/,
  );
});

test("public agent text keeps surrogate pairs at the protocol bounds", async () => {
  const labelAtBoundary = `${"l".repeat(119)}😀`;
  const modelIdAtBoundary = `${"m".repeat(159)}🚀`;
  const boundedLabel = boundedUnicodePrefix(labelAtBoundary, 120);
  const boundedModelId = boundedUnicodePrefix(modelIdAtBoundary, 160);

  assert.equal(labelAtBoundary.length, 121);
  assert.equal(modelIdAtBoundary.length, 161);
  assert.equal([...boundedLabel].length, 120);
  assert.equal([...boundedModelId].length, 160);
  assert.equal(boundedLabel, labelAtBoundary);
  assert.equal(boundedModelId, modelIdAtBoundary);
  const wireRoster = {
    version: 1 as const,
    chatId: "chat-1",
    turnId: "turn_boundary",
    availability: "ready" as const,
    epoch: "epoch_boundary",
    revision: 1,
    updatedAt: "2026-09-14T00:00:00.000Z",
    agents: [{
      agentId: "agent_boundary",
      depth: 1,
      revision: 1,
      role: "reviewer" as const,
      label: boundedLabel,
      taskPreview: "Reviewer task",
      state: "completed" as const,
      startedAt: "2026-09-14T00:00:00.000Z",
      updatedAt: "2026-09-14T00:00:01.000Z",
      finishedAt: "2026-09-14T00:00:01.000Z",
      modelId: boundedModelId,
      turns: 1,
      tools: 1,
      tokens: 1,
    }],
  };
  assert.throws(
    () => parseAidenRemoteChatAgentRoster({
      ...wireRoster,
      agents: [{ ...wireRoster.agents[0]!, label: labelAtBoundary.slice(0, 120) }],
    }),
    /characters/u,
  );
  assert.throws(
    () => parseAidenRemoteChatAgentRoster({
      ...wireRoster,
      agents: [{ ...wireRoster.agents[0]!, modelId: modelIdAtBoundary.slice(0, 160) }],
    }),
    /characters/u,
  );
  assert.doesNotThrow(() =>
    parseAidenRemoteChatAgentRoster(wireRoster),
  );

  const sourceLabel = `${"l".repeat(118)}😀`;
  const sourceModelId = `${"m".repeat(158)}🚀`;
  const { service } = fixture({
    readAgents: async () => [{ ...run, label: sourceLabel, modelId: sourceModelId }],
  });
  const roster = await service.agentRoster("device-1", "chat-1");
  assert.equal(roster.agents[0]?.label, sourceLabel);
  assert.equal(roster.agents[0]?.modelId, sourceModelId);
  assert.doesNotThrow(() => parseAidenRemoteChatAgentRoster(roster));
});

test("new parent turns reset the roster instead of showing the prior agents", async () => {
  const { service, events } = fixture();
  const prior = await service.agentRoster("device-1", "chat-1");
  events.begin("chat-1", "generation-2");
  const current = await service.agentRoster("device-1", "chat-1");
  assert.notEqual(prior.turnId, current.turnId);
  assert.deepEqual(current.agents, []);
  assert.equal(
    (await service.agentRoster("device-1", "chat-1", prior.turnId)).agents
      .length,
    1,
  );
});

test("a valid roster recovers with a newer revision after a corrupt read", async () => {
  let corrupt = false;
  const { service } = fixture({
    readAgents: async () =>
      corrupt ? [{ ...run, chatId: "other-chat" }] : [run],
  });
  const before = await service.agentRoster("device-1", "chat-1");
  corrupt = true;
  const invalid = await service.agentRoster("device-1", "chat-1");
  assert.equal(invalid.availability, "unavailable");
  corrupt = false;
  const recovered = await service.agentRoster("device-1", "chat-1");
  assert.equal(recovered.availability, "ready");
  assert.ok(
    before.revision < invalid.revision && invalid.revision < recovered.revision,
  );
});

test("public identities are scoped to the Mac and prior turns are discoverable after reopening", async () => {
  const prior = { ...run, generationId: "older-generation", runId: "older-run", startedAt: 1 };
  const first = fixture({ readAgents: async () => [run, prior] }).service;
  const otherMac = fixture({ instanceId: "other-mac", readAgents: async () => [run, prior] }).service;
  const current = await first.agentRoster("device-1", "chat-1");
  const other = await otherMac.agentRoster("device-1", "chat-1");
  assert.notEqual(current.turnId, other.turnId);
  assert.notEqual(current.agents[0]?.agentId, other.agents[0]?.agentId);
  assert.equal(current.previousTurns?.length, 1);
  const previous = await first.agentRoster("device-1", "chat-1", current.previousTurns![0]!.turnId);
  assert.equal(previous.agents.length, 1);
  assert.notEqual(previous.agents[0]?.agentId, current.agents[0]?.agentId);
});

test("restart preserves terminal failures and marks abandoned active runs interrupted", async () => {
  const failed = {
    ...run,
    state: "failed" as const,
    error: "private provider error",
  };
  const { service } = fixture({
    readAgents: async () => [
      failed,
      {
        ...run,
        runId: "run-2",
        state: "running",
        finishedAt: undefined,
        terminalMarkdown: undefined,
      },
    ],
  });
  const roster = await service.agentRoster("device-1", "chat-1");
  assert.deepEqual(
    roster.agents.map(({ state }) => state),
    ["failed", "interrupted"],
  );
  assert.ok(!JSON.stringify(roster).includes("private provider error"));
  assert.notEqual(
    roster.epoch,
    (await fixture().service.agentRoster("device-1", "chat-1")).epoch,
  );
});

test("authorization is rechecked after asynchronous storage before returning data", async () => {
  let revoked = false;
  const { service } = fixture({
    authorize: async () => {
      if (revoked) throw new Error("revoked");
      return { id: "chat-1" };
    },
    readTodo: async () => {
      revoked = true;
      return todo;
    },
  });
  await assert.rejects(service.taskSnapshot("device-1", "chat-1"), /revoked/);
});

test("SSE is scoped by read grants, publishes fresh state on reconnect, and closes on revocation", async () => {
  const { service, events } = fixture();
  const response = new Response();
  await service.openEvents(
    "device-1",
    "chat-1",
    new Set(["tasks:read"]),
    99999,
    response.wire,
  );
  assert.match(response.chunks.join(""), /event: task_update/);
  assert.doesNotMatch(response.chunks.join(""), /agents_update/);
  const count = response.chunks.length;
  events.changed("chat-1");
  await new Promise((done) => setImmediate(done));
  assert.equal(
    response.chunks.length,
    count,
    "unchanged state does not emit duplicate snapshots",
  );
  service.revokeDevice("device-1");
  assert.ok(response.ended);
  assert.equal(events.current("chat-1"), undefined);
  service.close();
});

test("disconnect removes the observer without ending Mac-owned work", async () => {
  const { service, events } = fixture();
  events.begin("chat-1", "generation-1");
  events.durableTodo("chat-1", "generation-1", todo);
  const response = new Response();
  await service.openEvents(
    "device-1",
    "chat-1",
    new Set(["tasks:read", "agents:read"]),
    0,
    response.wire,
  );
  response.emit("close");
  assert.equal(events.current("chat-1")?.generationId, "generation-1");
  service.close();
});

test("late publications and old turn settlement cannot change the active chat", () => {
  const events = new ChatProgressEvents();
  events.begin("chat-1", "generation-2");
  events.durableTodo("chat-1", "generation-1", todo);
  events.settle("chat-1", "generation-1");
  assert.deepEqual(events.current("chat-1"), { generationId: "generation-2" });
});

test("chat-scoped subscribers see desktop task changes and do not close on ordinary socket backpressure", async () => {
  const { service, events } = fixture();
  events.begin("chat-1", "generation-1");
  events.durableTodo("chat-1", "generation-1", todo);
  const response = new Response();
  response.write = (chunk) => {
    response.chunks.push(chunk);
    return false;
  };
  await service.openEvents(
    "device-1",
    "chat-1",
    new Set(["tasks:read", "agents:read"]),
    0,
    response.wire,
  );
  assert.equal(response.ended, false);
  assert.match(response.chunks.join(""), /agents_update/);
  events.durableTodo("chat-1", "generation-1", {
    ...todo,
    tasks: [{ ...todo.tasks[0]!, status: "completed" }],
  });
  await new Promise((resolve) => setTimeout(resolve, 150));
  const taskEvents = response.chunks.filter((chunk) =>
    chunk.includes("event: task_update"),
  );
  assert.equal(taskEvents.length, 2);
  assert.match(taskEvents[1]!, /"status":"completed"/);
  service.close();
});
