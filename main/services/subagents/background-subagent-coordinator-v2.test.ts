import assert from "node:assert/strict";
import test from "node:test";
import type { SubagentRunSnapshotV2 } from "../../../renderer/shared/subagent-runs.js";
import { createSubagentAuthorityV2 } from "./authority-v2.js";
import {
  BackgroundSubagentLifecycleV2,
  type BackgroundSubagentRunV2,
  type BackgroundSubagentStoreV2,
} from "./background-lifecycle-v2.js";
import {
  BackgroundSubagentCoordinatorV2,
  type BackgroundSubagentChildStartV2,
  type PreparedBackgroundSubagentRunV2,
} from "./background-subagent-coordinator-v2.js";

class MemoryStore implements BackgroundSubagentStoreV2 {
  readonly records = new Map<string, BackgroundSubagentRunV2>();

  async get(runId: string) {
    return structuredClone(this.records.get(runId) ?? null);
  }

  async put(run: BackgroundSubagentRunV2, expectedRevision: number | null) {
    const current = this.records.get(run.snapshot.runId);
    if (
      expectedRevision === null
        ? current !== undefined
        : current?.snapshot.revision !== expectedRevision
    )
      return false;
    this.records.set(run.snapshot.runId, structuredClone(run));
    return true;
  }

  async list() {
    return structuredClone([...this.records.values()]);
  }
}

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

interface FakeChild {
  readonly runId: string;
  readonly done: Deferred;
  delivered: string[];
  start?: BackgroundSubagentChildStartV2;
  stopped?: Error;
}

function prepared(
  runId: string,
  chatId = "chat-background",
  workspaceId = "workspace-background",
): PreparedBackgroundSubagentRunV2 {
  const authority = createSubagentAuthorityV2({
    grantId: `grant-${runId}`,
    treeRootId: runId,
    runId,
    depth: 1,
    authorityRevision: 1,
    generationId: `generation-${runId}`,
    chatId,
    workspaceId,
    workspaceRevision: "a".repeat(64),
    ownerDocumentId: `1:2:${runId}`,
    providerFingerprint: "b".repeat(64),
    modelFingerprint: "c".repeat(64),
    contextRevision: "d".repeat(64),
    execution: "background",
    context: "fresh",
    thinkingLevel: "high",
    capabilities: {
      workspaceRead: true,
      workspaceWrite: false,
      shell: false,
      web: false,
      delegation: false,
      mcp: [],
    },
    budgets: {
      deadlineMs: 30_000,
      maxTurns: 8,
      maxToolCalls: 32,
      maxOutputChars: 64_000,
      maxTokens: 64_000,
      maxLaunches: 1,
      maxDepth: 1,
      maxActive: 1,
      maxQueued: 1,
      maxNetworkOperations: 1,
    },
    expiresAt: 99_000_000_000_000,
  });
  const snapshot: SubagentRunSnapshotV2 = {
    version: 2,
    runId,
    groupId: `group-${runId}`,
    generationId: authority.generationId,
    childId: `child-${runId}`,
    chatId,
    workspaceId,
    revision: 1,
    role: "scout",
    label: "Background scout",
    taskPreview: "Inspect durable evidence",
    state: "queued",
    activity: "Queued",
    startedAt: 10,
    updatedAt: 10,
    modelId: "model",
    turns: 0,
    tools: 0,
    tokens: 0,
    warnings: [],
    depth: 1,
    execution: "background",
    context: "fresh",
    authorityRevision: authority.authorityRevision,
  };
  return { authority, snapshot, task: "Inspect durable evidence" };
}

function management(
  run: BackgroundSubagentRunV2,
  action: "status" | "wait" | "stop" | "steer",
  timeoutMs = 100,
) {
  const authority = run.manifest.authority;
  return {
    version: 2 as const,
    action,
    runId: run.snapshot.runId,
    chatId: authority.chatId,
    workspaceId: authority.workspaceId,
    ownerDocumentId: authority.ownerDocumentId,
    authorityRevision: authority.authorityRevision,
    expectedRevision: run.snapshot.revision,
    ...(action === "wait" ? { timeoutMs } : {}),
    ...(action === "steer"
      ? { instruction: "Check the newest evidence." }
      : {}),
  };
}

async function until(
  description: string,
  predicate: () => boolean,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

function harness() {
  const store = new MemoryStore();
  let clock = 20;
  const lifecycle = new BackgroundSubagentLifecycleV2(store, {}, () => ++clock);
  const children = new Map<string, FakeChild>();
  const order: string[] = [];
  const coordinator = new BackgroundSubagentCoordinatorV2(lifecycle, {
    createChild(run) {
      assert.equal(
        store.records.get(run.snapshot.runId)?.snapshot.state,
        "queued",
      );
      order.push(`create:${run.snapshot.runId}`);
      const child: FakeChild = {
        runId: run.snapshot.runId,
        done: deferred(),
        delivered: [],
      };
      children.set(child.runId, child);
      return child;
    },
    async startChild(child, input) {
      child.start = input;
      order.push(`start:${child.runId}`);
      await Promise.race([
        child.done.promise,
        new Promise<void>((_resolve, reject) => {
          input.signal.addEventListener(
            "abort",
            () => reject(input.signal.reason),
            { once: true },
          );
        }),
      ]);
    },
    deliverSteer(child, instruction) {
      child.delivered.push(instruction);
    },
    stopChild(child, reason) {
      child.stopped = reason;
    },
  });
  return { store, lifecycle, children, order, coordinator };
}

test("durable acceptance precedes unique child creation and detached work outlives launch", async () => {
  const { store, children, order, coordinator } = harness();
  const input = prepared("run-one");
  const [first, duplicate] = await Promise.allSettled([
    coordinator.launch(input),
    coordinator.launch(input),
  ]);
  assert.equal(first.status, "fulfilled");
  assert.equal(duplicate.status, "rejected");
  assert.deepEqual(order.slice(0, 1), ["create:run-one"]);
  assert.equal(children.size, 1);
  assert.equal(coordinator.activeCount, 1);
  input.snapshot.activity = "Caller mutated after launch";
  await until(
    "detached child start",
    () => children.get("run-one")?.start !== undefined,
  );
  assert.equal(
    store.records.get("run-one")?.snapshot.activity,
    "Running in the background.",
  );
  children.get("run-one")!.done.resolve();
  await until(
    "detached completion",
    () => store.records.get("run-one")?.snapshot.state === "completed",
  );
  assert.equal(coordinator.activeCount, 0);
});

test("wait observes terminal work or times out, and steering is delivered only at a safe boundary", async () => {
  const { store, children, coordinator } = harness();
  await coordinator.launch(prepared("run-wait"));
  await until(
    "running state",
    () => store.records.get("run-wait")?.snapshot.state === "running",
  );

  let current = store.records.get("run-wait")!;
  const steered = await coordinator.manage(management(current, "steer"));
  assert.equal(children.get("run-wait")?.delivered.length, 0);
  await children.get("run-wait")!.start!.safeBoundary();
  assert.deepEqual(children.get("run-wait")?.delivered, [
    "Check the newest evidence.",
  ]);

  const terminalWait = coordinator.manage(management(steered, "wait", 500));
  children.get("run-wait")!.done.resolve();
  assert.equal((await terminalWait).snapshot.state, "completed");

  await coordinator.launch(prepared("run-timeout"));
  await until(
    "second running state",
    () => store.records.get("run-timeout")?.snapshot.state === "running",
  );
  current = store.records.get("run-timeout")!;
  const timedOut = await coordinator.manage(management(current, "wait", 5));
  assert.equal(timedOut.snapshot.state, "running");
  children.get("run-timeout")!.done.resolve();
});

test("stop and bulk boundaries terminalize before abort, while startup never recreates work", async () => {
  const { store, lifecycle, children, coordinator } = harness();
  await coordinator.launch(prepared("run-stop", "chat-stop", "workspace-stop"));
  await until(
    "stop run",
    () => store.records.get("run-stop")?.snapshot.state === "running",
  );
  const stopped = await coordinator.manage(
    management(store.records.get("run-stop")!, "stop"),
  );
  assert.equal(stopped.snapshot.state, "stopped");
  assert.ok(children.get("run-stop")?.start?.signal.aborted);
  assert.match(
    children.get("run-stop")?.stopped?.message ?? "",
    /stopped by its owner/u,
  );

  await coordinator.launch(prepared("run-chat", "chat-bulk", "workspace-a"));
  await coordinator.launch(
    prepared("run-workspace", "chat-other", "workspace-bulk"),
  );
  await until(
    "bulk runs",
    () =>
      store.records.get("run-chat")?.snapshot.state === "running" &&
      store.records.get("run-workspace")?.snapshot.state === "running",
  );
  assert.equal(await coordinator.chatDeleted("chat-bulk"), 1);
  assert.equal(store.records.get("run-chat")?.snapshot.state, "stopped");
  assert.ok(children.get("run-chat")?.start?.signal.aborted);
  assert.equal(await coordinator.workspaceRevoked("workspace-bulk"), 1);
  assert.equal(store.records.get("run-workspace")?.snapshot.state, "stopped");

  const dormant = prepared("run-dormant", "chat-dormant", "workspace-dormant");
  await lifecycle.accept(dormant);
  await lifecycle.transition(
    management(store.records.get("run-dormant")!, "status"),
    "starting",
    "Starting",
  );
  await lifecycle.transition(
    management(store.records.get("run-dormant")!, "status"),
    "running",
    "Running",
  );
  const createdBeforeRestart = children.size;
  assert.equal(await coordinator.reconcileStartup(), 1);
  assert.equal(store.records.get("run-dormant")?.snapshot.state, "interrupted");
  assert.equal(children.size, createdBeforeRestart);

  await coordinator.launch(
    prepared("run-shutdown", "chat-shutdown", "workspace-shutdown"),
  );
  await until(
    "shutdown run",
    () => store.records.get("run-shutdown")?.snapshot.state === "running",
  );
  assert.equal(await coordinator.shutdown(), 1);
  assert.equal(
    store.records.get("run-shutdown")?.snapshot.state,
    "interrupted",
  );
  assert.ok(children.get("run-shutdown")?.start?.signal.aborted);
});
