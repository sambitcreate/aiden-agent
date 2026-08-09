import assert from "node:assert/strict";
import test from "node:test";
import type { SubagentRunSnapshotV2 } from "../../../renderer/shared/subagent-runs.js";
import {
  SubagentControlMainV2,
  type SubagentControlMainRegistrationV2,
} from "./subagent-control-main.js";

function snapshot(overrides: Partial<SubagentRunSnapshotV2> = {}): SubagentRunSnapshotV2 {
  return {
    version: 2,
    runId: "run-one",
    groupId: "group-one",
    generationId: "generation-one",
    childId: "child-one",
    chatId: "chat-one",
    workspaceId: "workspace-one",
    revision: 1,
    role: "reviewer",
    label: "Review",
    taskPreview: "Review the owner boundary.",
    state: "queued",
    startedAt: 100,
    updatedAt: 100,
    modelId: "model-one",
    turns: 0,
    tools: 0,
    tokens: 0,
    warnings: [],
    depth: 1,
    execution: "foreground",
    context: "fresh",
    authorityRevision: 3,
    ...overrides,
  };
}

function registration(
  run = snapshot(),
  hooks: Partial<
    Omit<SubagentControlMainRegistrationV2, "snapshot" | "ownerDocumentId">
  > = {},
): SubagentControlMainRegistrationV2 {
  return {
    snapshot: run,
    ownerDocumentId: "document-one",
    revokeApprovals: () => {},
    stop: () => {},
    settle: async () => {},
    ...hooks,
  };
}

const scope = {
  chatId: "chat-one",
  workspaceId: "workspace-one",
  ownerDocumentId: "document-one",
};

test("main resolves the registered authority revision behind an exact document scope", async () => {
  const controls = new SubagentControlMainV2();
  controls.register(registration());
  const status = await controls.executeForDocument(scope, {
    version: 2,
    action: "status",
    runId: "run-one",
  });
  assert.equal(status.snapshot.authorityRevision, 3);
  for (const mismatch of [
    { ...scope, chatId: "chat-two" },
    { ...scope, workspaceId: "workspace-two" },
    { ...scope, ownerDocumentId: "document-two" },
  ]) {
    await assert.rejects(
      controls.executeForDocument(mismatch, { version: 2, action: "status", runId: "run-one" }),
      /authority does not match/u,
    );
  }
});

test("preflight registration makes stop reach the exact runtime hook", async () => {
  let stopped = 0;
  const controls = new SubagentControlMainV2({ now: () => 200 });
  controls.register(registration(snapshot(), { stop: () => void (stopped += 1) }));
  const result = await controls.executeForDocument(scope, {
    version: 2,
    action: "stop",
    runId: "run-one",
  });
  assert.equal(result.action, "stop");
  if (result.action !== "stop") return;
  assert.equal(result.changed, true);
  assert.equal(result.snapshot.state, "stopped");
  assert.equal(stopped, 1);
  assert.equal(
    (await controls.executeForDocument(scope, { version: 2, action: "status", runId: "run-one" }))
      .snapshot.state,
    "stopped",
  );
});

test("control drains queued projector persistence before deriving a stop revision", async () => {
  const order: string[] = [];
  const controls = new SubagentControlMainV2({ now: () => 200 });
  controls.register(
    registration(snapshot(), {
      settle: async () => {
        order.push("settle");
      },
      stop: () => {
        order.push("stop");
      },
    }),
  );
  await controls.executeForDocument(scope, {
    version: 2,
    action: "stop",
    runId: "run-one",
  });
  assert.deepEqual(order.slice(0, 2), ["settle", "stop"]);
});

test("stop rebases over non-durable live telemetry before acknowledgement", async () => {
  const published: SubagentRunSnapshotV2[] = [];
  const live = snapshot({
    revision: 3,
    state: "running",
    activity: "Reviewing workspace context",
    updatedAt: 175,
    turns: 2,
    tools: 1,
    tokens: 40,
  });
  const controls = new SubagentControlMainV2({ now: () => 200 });
  controls.register(
    registration(snapshot(), {
      currentSnapshot: () => live,
      onSnapshot: (next) => published.push(next),
    }),
  );

  const result = await controls.executeForDocument(scope, {
    version: 2,
    action: "stop",
    runId: "run-one",
  });
  assert.equal(result.action, "stop");
  if (result.action !== "stop") return;
  assert.equal(result.snapshot.revision, 4);
  assert.equal(result.snapshot.turns, 2);
  assert.equal(result.snapshot.tools, 1);
  assert.equal(result.snapshot.tokens, 40);
  assert.equal(published[published.length - 1]?.state, "stopped");
});

test("stop is not acknowledged before canonical publication settles", async () => {
  let settle = true;
  const controls = new SubagentControlMainV2({ now: () => 200 });
  controls.register(
    registration(snapshot(), {
      settle: async () => {
        if (!settle) throw new Error("canonical publication failed");
      },
    }),
  );
  settle = false;
  await assert.rejects(
    controls.executeForDocument(scope, { version: 2, action: "stop", runId: "run-one" }),
    /canonical publication failed/u,
  );
  await assert.rejects(
    controls.executeForDocument(scope, { version: 2, action: "status", runId: "run-one" }),
    /canonical publication failed/u,
  );
});

test("projector updates reuse private registration authority", () => {
  const controls = new SubagentControlMainV2();
  controls.register(registration());
  const updated = controls.update(
    "run-one",
    snapshot({ revision: 2, state: "running", activity: "Reviewing workspace context", updatedAt: 150 }),
  );
  assert.equal(updated.state, "running");
  assert.throws(
    () => controls.update("run-unknown", snapshot({ runId: "run-unknown" })),
    /registration is unavailable/u,
  );
});

test("main unregisters an exact unlaunched preparation and hides its state", () => {
  const controls = new SubagentControlMainV2();
  controls.register(registration());
  assert.equal(controls.stateForRun("run-one", "document-one"), "queued");
  assert.equal(controls.unregisterPrepared("run-one", "document-two"), false);
  assert.equal(controls.unregisterPrepared("run-one", "document-one"), true);
  assert.equal(controls.stateForRun("run-one", "document-one"), undefined);
  assert.equal(controls.size, 0);
});

test("retry preparation is installed once and fresh registration precedes start", async () => {
  const terminal = snapshot({
    state: "completed",
    revision: 2,
    updatedAt: 200,
    finishedAt: 200,
    terminalMarkdown: "Done.",
  });
  let started = 0;
  const controls = new SubagentControlMainV2({ randomUUID: () => "retry-id" });
  controls.register(registration(terminal));
  const dispose = controls.installRetryPreparation((request) => ({
    registration: registration(
      snapshot({
        runId: request.runId,
        childId: request.childId,
        groupId: request.groupId,
        retryOfRunId: request.retryOfRunId,
        state: "queued",
        revision: 1,
        startedAt: 300,
        updatedAt: 300,
        finishedAt: undefined,
        terminalMarkdown: undefined,
        turns: 0,
        tools: 0,
        tokens: 0,
        warnings: [],
      }),
    ),
    start: () => void (started += 1),
  }));
  assert.throws(() => controls.installRetryPreparation(() => Promise.reject()), /already installed/u);
  const result = await controls.executeForDocument(scope, {
    version: 2,
    action: "retry",
    runId: "run-one",
  });
  assert.equal(result.action, "retry");
  if (result.action !== "retry") return;
  assert.equal(started, 1);
  assert.equal(result.snapshot.retryOfRunId, "run-one");
  assert.equal(
    (
      await controls.executeForDocument(scope, {
        version: 2,
        action: "status",
        runId: result.snapshot.runId,
      })
    ).snapshot.runId,
    result.snapshot.runId,
  );
  dispose();
});
