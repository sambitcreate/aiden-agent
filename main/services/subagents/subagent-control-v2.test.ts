import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_SUBAGENT_CONTROL_STEERING_PER_RUN,
  MAX_SUBAGENT_CONTROL_WAITERS_PER_RUN,
  SubagentControlRegistryV2,
  type SubagentControlOwnerV2,
  type SubagentControlRegistrationV2,
} from "./subagent-control-v2.js";
import type { SubagentRunSnapshotV2 } from "../../../renderer/shared/subagent-runs.js";

function snapshot(
  overrides: Partial<SubagentRunSnapshotV2> = {},
): SubagentRunSnapshotV2 {
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
    taskPreview: "Review the cancellation path.",
    state: "running",
    activity: "Reviewing workspace context",
    startedAt: 100,
    updatedAt: 100,
    modelId: "model-one",
    turns: 0,
    tools: 0,
    tokens: 0,
    milestones: [],
    warnings: [],
    depth: 1,
    execution: "foreground",
    context: "fresh",
    authorityRevision: 7,
    ...overrides,
  };
}

const owner: SubagentControlOwnerV2 = {
  chatId: "chat-one",
  workspaceId: "workspace-one",
  ownerDocumentId: "document-one",
  authorityRevision: 7,
};

function registration(
  run = snapshot(),
  hooks: Partial<Omit<SubagentControlRegistrationV2, "snapshot" | "ownerDocumentId">> = {},
): SubagentControlRegistrationV2 {
  return {
    snapshot: run,
    ownerDocumentId: "document-one",
    revokeApprovals: () => {},
    stop: () => {},
    ...hooks,
  };
}

function terminal(
  state: "completed" | "failed" | "timed_out" | "interrupted" | "stopped" = "completed",
): SubagentRunSnapshotV2 {
  return snapshot({
    revision: 2,
    state,
    activity: undefined,
    updatedAt: 200,
    finishedAt: 200,
    terminalMarkdown: state === "completed" ? "Done." : "No result.",
  });
}

test("every management action requires exact chat, workspace, document, and authority revision", async () => {
  const registry = new SubagentControlRegistryV2();
  registry.register(registration());
  for (const mismatch of [
    { ...owner, chatId: "chat-two" },
    { ...owner, workspaceId: "workspace-two" },
    { ...owner, ownerDocumentId: "document-two" },
    { ...owner, authorityRevision: 8 },
  ]) {
    assert.throws(() => registry.status(mismatch, "run-one"), /authority does not match/u);
    await assert.rejects(
      registry.execute(mismatch, { version: 2, action: "wait", runId: "run-one", timeoutMs: 0 }),
      /authority does not match/u,
    );
  }
  assert.equal(registry.status(owner, "run-one").runId, "run-one");
});

test("stop is exact, one-shot, approval-fencing, and immune to late terminal overwrite", () => {
  let stops = 0;
  let revocations = 0;
  const published: SubagentRunSnapshotV2[] = [];
  const registry = new SubagentControlRegistryV2({ now: () => 250 });
  registry.register(
    registration(snapshot(), {
      stop: () => {
        stops += 1;
      },
      revokeApprovals: () => {
        revocations += 1;
      },
      onSnapshot: (run) => published.push(run),
    }),
  );
  const first = registry.stop(owner, "run-one");
  assert.equal(first.changed, true);
  assert.equal(first.snapshot.state, "stopped");
  assert.equal(first.snapshot.revision, 2);
  assert.equal(first.snapshot.finishedAt, 250);
  assert.equal(stops, 1);
  assert.ok(revocations >= 1);
  assert.equal(published[published.length - 1]?.state, "stopped");

  const repeated = registry.stop(owner, "run-one");
  assert.equal(repeated.changed, false);
  assert.equal(stops, 1);
  assert.throws(() => registry.update(owner, terminal()), /lifecycle cannot move backward/u);
  assert.equal(registry.status(owner, "run-one").state, "stopped");
});

test("a natural terminal transition wins a later stop without being rewritten", () => {
  let stops = 0;
  const registry = new SubagentControlRegistryV2();
  registry.register(registration(snapshot(), { stop: () => void (stops += 1) }));
  registry.update(owner, terminal());
  const stopped = registry.stop(owner, "run-one");
  assert.equal(stopped.changed, false);
  assert.equal(stopped.snapshot.state, "completed");
  assert.equal(stops, 0);
  assert.throws(
    () => registry.update(owner, { ...terminal(), revision: 3, updatedAt: 300, finishedAt: 300 }),
    /lifecycle cannot move backward/u,
  );
});

test("control updates preserve task provenance and only add report facts at terminal", () => {
  const registry = new SubagentControlRegistryV2();
  const running = snapshot({ projectionNotices: ["task_truncated"] });
  registry.register(registration(running));

  assert.throws(
    () => registry.update(owner, snapshot({ revision: 2, updatedAt: 150 })),
    /lifecycle cannot move backward/u,
  );
  assert.throws(
    () =>
      registry.update(
        owner,
        snapshot({
          revision: 2,
          updatedAt: 150,
          projectionNotices: ["task_truncated", "display_filtered"],
        }),
      ),
    /lifecycle cannot move backward/u,
  );

  const completed: SubagentRunSnapshotV2 = {
    ...terminal(),
    projectionNotices: ["task_truncated", "report_truncated", "display_filtered"],
    terminalMarkdown: "Done.\n\n... [report truncated]",
  };
  registry.update(owner, completed);
  assert.deepEqual(registry.status(owner, "run-one").projectionNotices, completed.projectionNotices);
});

test("mandatory hook failures prevent false terminal acknowledgement", () => {
  const approvalFailure = new SubagentControlRegistryV2({ now: () => 250 });
  approvalFailure.register(
    registration(snapshot(), {
      revokeApprovals: () => {
        throw new Error("approval ledger unavailable");
      },
    }),
  );
  assert.throws(() => approvalFailure.stop(owner, "run-one"), /approval ledger/u);
  assert.equal(approvalFailure.status(owner, "run-one").state, "running");

  let revocations = 0;
  const runtimeFailure = new SubagentControlRegistryV2({ now: () => 250 });
  runtimeFailure.register(
    registration(snapshot(), {
      revokeApprovals: () => {
        revocations += 1;
      },
      stop: () => {
        throw new Error("runtime stop callback failed");
      },
    }),
  );
  assert.throws(() => runtimeFailure.stop(owner, "run-one"), /runtime stop/u);
  assert.equal(runtimeFailure.status(owner, "run-one").state, "running");
  assert.equal(revocations, 1);
});

test("waits are bounded, return timeout snapshots, and all terminal waiters settle", async () => {
  const registry = new SubagentControlRegistryV2();
  registry.register(registration());
  const immediate = await registry.wait(owner, "run-one", 0);
  assert.equal(immediate.timedOut, true);
  assert.equal(immediate.snapshot.state, "running");

  const waits = Array.from({ length: MAX_SUBAGENT_CONTROL_WAITERS_PER_RUN }, () =>
    registry.wait(owner, "run-one", 30_000),
  );
  await assert.rejects(registry.wait(owner, "run-one", 30_000), /Too many waits/u);
  registry.update(owner, terminal());
  const results = await Promise.all(waits);
  assert.ok(results.every((result) => !result.timedOut && result.snapshot.state === "completed"));
  const after = await registry.wait(owner, "run-one", 30_000);
  assert.equal(after.timedOut, false);
});

test("steering is serial, bounded, abort-aware, and closes at terminal state", async () => {
  const accepted: string[] = [];
  const releases: Array<() => void> = [];
  const registry = new SubagentControlRegistryV2();
  registry.register(
    registration(snapshot(), {
      steer: (instruction, signal) =>
        new Promise<void>((resolve, reject) => {
          accepted.push(instruction);
          releases.push(resolve);
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    }),
  );
  const pending = Array.from({ length: MAX_SUBAGENT_CONTROL_STEERING_PER_RUN }, (_, index) =>
    registry.steer(owner, "run-one", `instruction-${index}`),
  );
  await assert.rejects(
    registry.steer(owner, "run-one", "one-too-many"),
    /steering queue is full/u,
  );
  assert.deepEqual(accepted, ["instruction-0"]);
  releases.shift()?.();
  await pending[0];
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(accepted, ["instruction-0", "instruction-1"]);
  registry.stop(owner, "run-one");
  const results = await Promise.allSettled(pending.slice(1));
  assert.ok(results.every((result) => result.status === "rejected"));
  await assert.rejects(registry.steer(owner, "run-one", "late"), /terminal/u);
});

test("stop settles an active steering request even when an integration ignores abort", async () => {
  const registry = new SubagentControlRegistryV2();
  registry.register(
    registration(snapshot(), {
      steer: () => new Promise<void>(() => {}),
    }),
  );
  const steering = registry.steer(owner, "run-one", "Check one more thing.");
  await new Promise<void>((resolve) => setImmediate(resolve));
  registry.stop(owner, "run-one");
  await assert.rejects(steering, /stopped by its owner|ended before steering/u);
});

test("retry mints fresh identities, links the source, clears runtime state, and starts only after registration", async () => {
  let uuidCalls = 0;
  let sourceRevocations = 0;
  let startedRegistered = false;
  let requestedRunId = "";
  const registry = new SubagentControlRegistryV2({
    randomUUID: () => `00000000-0000-4000-8000-${String(++uuidCalls).padStart(12, "0")}`,
    prepareRetry: (request) => {
      requestedRunId = request.runId;
      const retry = snapshot({
        runId: request.runId,
        childId: request.childId,
        groupId: request.groupId,
        retryOfRunId: request.retryOfRunId,
        revision: 1,
        state: "queued",
        activity: "Waiting for an execution slot",
        startedAt: 300,
        updatedAt: 300,
        finishedAt: undefined,
        terminalMarkdown: undefined,
        turns: 0,
        tools: 0,
        tokens: 0,
        milestones: [],
        warnings: [],
      });
      return {
        registration: registration(retry),
        start: () => {
          startedRegistered = registry.status(
            { ...owner, authorityRevision: retry.authorityRevision },
            retry.runId,
          ).runId === retry.runId;
        },
      };
    },
  });
  registry.register(
    registration(terminal(), {
      revokeApprovals: () => {
        sourceRevocations += 1;
      },
    }),
  );
  const result = await registry.retry(owner, "run-one");
  assert.equal(result.snapshot.runId, requestedRunId);
  assert.notEqual(result.snapshot.runId, result.sourceSnapshot.runId);
  assert.notEqual(result.snapshot.childId, result.sourceSnapshot.childId);
  assert.equal(result.snapshot.retryOfRunId, "run-one");
  assert.equal(result.snapshot.state, "queued");
  assert.equal(result.snapshot.revision, 1);
  assert.ok(sourceRevocations >= 1);
  assert.equal(startedRegistered, true);
});

test("retry rejects active sources and invalid preparations before launch", async () => {
  let starts = 0;
  const registry = new SubagentControlRegistryV2({
    randomUUID: () => "00000000-0000-4000-8000-000000000001",
    prepareRetry: (request) => ({
      registration: registration(
        snapshot({
          runId: request.runId,
          childId: request.childId,
          groupId: request.groupId,
          retryOfRunId: "wrong-source",
          state: "queued",
          activity: "Waiting for an execution slot",
        }),
      ),
      start: () => {
        starts += 1;
      },
    }),
  });
  registry.register(registration());
  await assert.rejects(registry.retry(owner, "run-one"), /Only a terminal/u);
  registry.update(owner, terminal());
  await assert.rejects(registry.retry(owner, "run-one"), /bound lineage|runtime state/u);
  assert.equal(starts, 0);
  assert.equal(registry.size, 1);
});

test("execute uses the strict management parser and returns action-tagged results", async () => {
  const registry = new SubagentControlRegistryV2();
  registry.register(registration());
  const status = await registry.execute(owner, {
    version: 2,
    action: "status",
    runId: "run-one",
  });
  assert.equal(status.action, "status");
  await assert.rejects(
    registry.execute(owner, {
      version: 2,
      action: "status",
      runId: "run-one",
      extra: true,
    }),
    /fields/u,
  );
});

test("terminal records are evicted oldest-first before they can exhaust capacity", () => {
  const registry = new SubagentControlRegistryV2({ maxRecords: 2 });
  registry.register(
    registration({
      ...terminal(),
      runId: "run-old",
      childId: "child-old",
      updatedAt: 100,
      finishedAt: 100,
    }),
  );
  registry.register(
    registration({ ...terminal(), runId: "run-new", childId: "child-new", updatedAt: 200 }),
  );
  registry.register(registration(snapshot({ runId: "run-live", childId: "child-live" })));
  assert.equal(registry.size, 2);
  assert.throws(
    () => registry.status(owner, "run-old"),
    /authority does not match/u,
  );
  assert.equal(
    registry.status({ ...owner }, "run-live").state,
    "running",
  );
});

test("failed terminal admission preserves every accepted record at capacity", () => {
  const registry = new SubagentControlRegistryV2({ maxRecords: 2 });
  registry.register(
    registration({ ...terminal(), runId: "run-old", childId: "child-old", updatedAt: 100 }),
  );
  registry.register(
    registration({ ...terminal(), runId: "run-new", childId: "child-new", updatedAt: 200 }),
  );

  assert.throws(
    () =>
      registry.register({
        ...registration({
          ...terminal(),
          runId: "run-rejected",
          childId: "child-rejected",
          updatedAt: 300,
          finishedAt: 300,
        }),
        revokeApprovals: () => {
          throw new Error("Approval ledger unavailable.");
        },
      }),
    /ledger unavailable/u,
  );

  assert.equal(registry.size, 2);
  assert.equal(registry.status(owner, "run-old").state, "completed");
  assert.equal(registry.status(owner, "run-new").state, "completed");
  assert.throws(
    () => registry.status(owner, "run-rejected"),
    /authority does not match/u,
  );
});

test("only a pristine queued preparation can be unregistered before launch", () => {
  const registry = new SubagentControlRegistryV2();
  let revoked = 0;
  registry.register(
    registration(snapshot({ state: "queued", activity: "Waiting for an execution slot" }), {
      revokeApprovals: () => {
        revoked += 1;
      },
    }),
  );
  assert.equal(registry.unregisterPrepared(owner, "run-one"), true);
  assert.equal(revoked, 1);
  assert.throws(() => registry.status(owner, "run-one"), /authority does not match/u);

  registry.register(
    registration(
      snapshot({
        runId: "run-started",
        state: "queued",
        activity: "Waiting for an execution slot",
      }),
    ),
  );
  registry.update(
    { ...owner },
    snapshot({
      runId: "run-started",
      revision: 2,
      state: "starting",
      activity: "Starting a fresh child agent",
      updatedAt: 200,
    }),
  );
  assert.throws(
    () => registry.unregisterPrepared(owner, "run-started"),
    /unlaunched queued/u,
  );
});
