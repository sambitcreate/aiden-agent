import assert from "node:assert/strict";
import test from "node:test";
import { captureAnalyticsEvents } from "../analytics/test-support.js";
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

type Coordinator = ReturnType<typeof harness>["coordinator"];

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

test("a child that cannot be created fails its accepted run and surfaces the real cause", async () => {
  const store = new MemoryStore();
  let clock = 20;
  const lifecycle = new BackgroundSubagentLifecycleV2(store, {}, () => ++clock);
  const coordinator = new BackgroundSubagentCoordinatorV2<never>(lifecycle, {
    createChild() {
      throw new Error("The app-wide subagent runtime limit was reached.");
    },
    async startChild() {},
    deliverSteer() {},
  });

  await assert.rejects(
    coordinator.launch(prepared("run-uncreated")),
    /^Error: The app-wide subagent runtime limit was reached\.$/u,
  );

  assert.equal(store.records.get("run-uncreated")?.snapshot.state, "failed");
  assert.equal(coordinator.activeCount, 0);
});

test("a creation failure that cannot be recorded still reports the creation failure", async () => {
  const store = new MemoryStore();
  let clock = 20;
  const lifecycle = new BackgroundSubagentLifecycleV2(store, {}, () => ++clock);
  const coordinator = new BackgroundSubagentCoordinatorV2<never>(lifecycle, {
    createChild() {
      store.put = async () => false; // the durable store rejects every later write
      throw new Error("The app-wide subagent runtime limit was reached.");
    },
    async startChild() {},
    deliverSteer() {},
  });

  const rejection = await coordinator.launch(prepared("run-unrecorded")).then(
    () => assert.fail("launch must reject"),
    (error: unknown) => error,
  );

  assert.ok(rejection instanceof Error);
  assert.equal(rejection.message, "The app-wide subagent runtime limit was reached.");
  assert.ok(
    (rejection as Error & { cause?: unknown }).cause instanceof Error,
    "the recording failure is kept as the cause",
  );
  assert.equal(coordinator.activeCount, 0);
});

function holdStatusAfterCreate(
  store: MemoryStore,
  order: readonly string[],
  action: () => Promise<void>,
) {
  const reached = deferred();
  const original = store.get.bind(store);
  let armed = true;
  store.get = async (runId) => {
    if (armed && order.includes(`create:${runId}`)) {
      armed = false;
      reached.resolve();
      await action();
    }
    return original(runId);
  };
  return reached;
}

test("a Stop during launch ends the run instead of acknowledging it as queued", async () => {
  const { store, children, order, coordinator } = harness();
  const release = deferred();
  const reached = holdStatusAfterCreate(store, order, () => release.promise);
  const launching = coordinator.launch(prepared("run-early-stop"));
  await reached.promise;

  const stopping = coordinator.manage(
    management(store.records.get("run-early-stop")!, "stop"),
  );
  release.resolve();
  await launching;
  const stopped = await stopping;

  assert.equal(stopped.snapshot.state, "stopped");
  assert.equal(store.records.get("run-early-stop")?.snapshot.state, "stopped");
  await until("the launch to finish", () => coordinator.activeCount === 0);
  assert.equal(children.get("run-early-stop")?.start, undefined, "The child never started");
  assert.match(children.get("run-early-stop")?.stopped?.message ?? "", /stopped by its owner/u);
});

test("a Stop sent the moment a run is accepted cannot pass the launch", async () => {
  const { store, children, coordinator } = harness();
  const put = store.put.bind(store);
  let stopping: Promise<unknown> | undefined;
  // The sender learns the run from the durable record, before launch resumes.
  store.put = async (run, expectedRevision) => {
    const saved = await put(run, expectedRevision);
    if (expectedRevision === null) {
      stopping = coordinator.manage(management(store.records.get(run.snapshot.runId)!, "stop"));
    }
    return saved;
  };
  await coordinator.launch(prepared("run-instant-stop"));
  const stopped = await stopping as { snapshot: { state: string } };
  assert.equal(stopped.snapshot.state, "stopped");
  await until("the launch to finish", () => coordinator.activeCount === 0);
  assert.equal(children.get("run-instant-stop")?.start, undefined);
});

test("an invalidation that beats durable acceptance leaves no queued run behind", async () => {
  const { store, children, coordinator } = harness();
  const put = store.put.bind(store);
  const reached = deferred();
  const release = deferred();
  let held = false;
  store.put = async (run, expectedRevision) => {
    if (!held && expectedRevision === null) {
      held = true;
      reached.resolve();
      await release.promise;
    }
    return put(run, expectedRevision);
  };
  const launching = coordinator.launch(prepared("run-late-accept"));
  await reached.promise;
  await coordinator.chatDeleted("chat-background");
  release.resolve();
  await assert.rejects(launching, /chat was deleted/u);
  assert.equal(store.records.get("run-late-accept")?.snapshot.state, "failed");
  assert.equal(children.has("run-late-accept"), false, "No child is created for a dead run");
});

test("a run accepted after an invalidation read the store is not left queued", async () => {
  const { store, order, coordinator } = harness();
  const list = store.list.bind(store);
  const scanned = deferred();
  const releaseScan = deferred();
  store.list = async () => {
    const runs = await list();
    scanned.resolve();
    await releaseScan.promise;
    return runs;
  };
  const statusRead = deferred();
  const releaseStatus = deferred();
  const get = store.get.bind(store);
  let armed = true;
  store.get = async (runId) => {
    const answer = await get(runId);
    if (armed && order.includes(`create:${runId}`)) {
      armed = false;
      statusRead.resolve();
      await releaseStatus.promise;
    }
    return answer;
  };
  const invalidating = coordinator.chatDeleted("chat-background");
  await scanned.promise;
  const launching = coordinator.launch(prepared("run-after-scan"));
  await statusRead.promise;
  releaseScan.resolve();
  await invalidating;
  releaseStatus.resolve();
  await assert.rejects(launching, /chat was deleted/u);
  assert.equal(store.records.get("run-after-scan")?.snapshot.state, "failed");
});

test("two launches of one run cannot both own it", async () => {
  const { children, coordinator } = harness();
  const first = coordinator.launch(prepared("run-twice"));
  await assert.rejects(coordinator.launch(prepared("run-twice")), /already active/u);
  await first;
  await until("the child to start", () => Boolean(children.get("run-twice")?.start));
  children.get("run-twice")?.done.resolve();
  await until("the launch to finish", () => coordinator.activeCount === 0);
});

test("a child created for a launch that then fails is stopped, not abandoned", async () => {
  const { store, children, order, coordinator } = harness();
  holdStatusAfterCreate(store, order, async () => {
    throw new Error("store unavailable");
  });
  await assert.rejects(coordinator.launch(prepared("run-orphan")), /store unavailable/u);
  assert.equal(coordinator.activeCount, 0);
  assert.equal(children.get("run-orphan")?.start, undefined);
  assert.ok(children.get("run-orphan")?.stopped, "The created child is released");
});

test("an invalidation that lands during launch still stops the created child", async () => {
  const invalidations = [
    ["chat deletion", (c: Coordinator) => c.chatDeleted("chat-background")],
    ["workspace revocation", (c: Coordinator) => c.workspaceRevoked("workspace-background")],
    ["shutdown", (c: Coordinator) => c.shutdown()],
    ["startup reconciliation", (c: Coordinator) => c.reconcileStartup()],
  ] as const;
  for (const [name, invalidate] of invalidations) {
    const { store, children, order, coordinator } = harness();
    const release = deferred();
    const reached = deferred();
    const original = store.get.bind(store);
    let armed = true;
    // The status read has its answer, and delivers it after the run has moved on.
    store.get = async (runId) => {
      const answer = await original(runId);
      if (armed && order.includes(`create:${runId}`)) {
        armed = false;
        reached.resolve();
        await release.promise;
      }
      return answer;
    };
    const launching = coordinator.launch(prepared("run-invalidated"));
    await reached.promise;
    await invalidate(coordinator);
    // The install is still stalled, so this is the invalidation's own work.
    assert.ok(children.get("run-invalidated")?.stopped, `${name} stops the child before it returns`);
    let stops = 0;
    const child = children.get("run-invalidated")!;
    Object.defineProperty(child, "stopped", { set: () => { stops += 1; } });
    release.resolve();
    await assert.rejects(launching);
    await until(`${name} to settle`, () => coordinator.activeCount === 0);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(child.start, undefined, name);
    assert.equal(stops, 0, `${name} stops the child once`);
  }
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

test("a background subagent counts once by role, and one that could not start counts nothing", async (t) => {
  const sent = captureAnalyticsEvents(t);
  const { children, coordinator } = harness();
  const input = prepared("run-counted");
  await coordinator.launch(input);
  assert.deepEqual(sent, [{ event: "subagent_launched", props: { role: input.snapshot.role } }]);
  await until("detached child start", () => children.get("run-counted")?.start !== undefined);
  children.get("run-counted")!.done.resolve();
  await until("detached completion", () => coordinator.activeCount === 0);

  sent.length = 0;
  const failing = new BackgroundSubagentCoordinatorV2<never>(
    new BackgroundSubagentLifecycleV2(new MemoryStore(), {}, () => 1),
    {
      createChild() {
        throw new Error("The app-wide subagent runtime limit was reached.");
      },
      async startChild() {},
      deliverSteer() {},
    },
  );
  await assert.rejects(failing.launch(prepared("run-uncreated")));
  assert.deepEqual(sent, []);
});
