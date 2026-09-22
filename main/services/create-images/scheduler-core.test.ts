import assert from "node:assert/strict";
import test from "node:test";
import type { WorkflowExecutionPlan } from "../../../renderer/shared/create-images/execution.js";
import type {
  GenerateImageNodeV1,
  PromptNodeV1,
  WorkflowDocumentV1,
  WorkflowNodeV1,
} from "../../../renderer/shared/create-images/schema.js";
import {
  CoordinatorCancellationRequest,
  createCoordinatorEventCursor,
  createWorkflowCoordinatorPlan,
  reconcileRestartNode,
  reduceCoordinatorEvent,
  rendererDisconnectDecision,
  runWorkflowCoordinator,
  type CoordinatorClock,
  type CoordinatorDurability,
  type CoordinatorEvent,
  type CoordinatorEventPayload,
  type CoordinatorEventReduction,
  type CoordinatorRetryPolicy,
} from "./scheduler-core.js";

const NOW = "2026-08-11T12:00:00.000Z";

function prompt(id: string): PromptNodeV1 {
  return { id, type: "prompt", position: { x: 0, y: 0 }, data: { text: id } };
}

function generate(id: string): GenerateImageNodeV1 {
  return {
    id,
    type: "generate-image",
    position: { x: 100, y: 0 },
    data: {
      providerId: "gemini",
      modelId: "gemini-3.1-flash-image",
      aspectRatio: "1:1",
      imageSize: "1K",
      outputMime: "image/png",
      count: 1,
    },
  };
}

function documentWith(
  nodes: WorkflowNodeV1[],
  edges: WorkflowDocumentV1["edges"] = [],
): WorkflowDocumentV1 {
  return {
    schemaVersion: 1,
    id: "workflow-1",
    title: "Coordinator test",
    revision: 7,
    createdAt: NOW,
    updatedAt: NOW,
    nodes,
    edges,
    assetRefs: [],
    settings: { concurrency: 1 },
  };
}

function edge(id: string, source: string, sourcePort: string, target: string, targetPort: string) {
  return { id, source, sourcePort, target, targetPort };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function settleUntil(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 50 && !predicate(); index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(
    predicate(),
    true,
    "The deterministic coordinator did not reach the expected point.",
  );
}

class TestClock implements CoordinatorClock {
  time = 1_000;
  readonly sleeps: number[] = [];

  now(): number {
    this.time += 1;
    return this.time;
  }

  async sleep(delayMs: number, signal: AbortSignal): Promise<void> {
    this.sleeps.push(delayMs);
    if (signal.aborted) throw signal.reason;
    this.time += delayMs;
  }
}

const POLICY: CoordinatorRetryPolicy = {
  maxRetriesPerNode: 2,
  baseDelayMs: 100,
  maxDelayMs: 1_000,
  maxTotalDelayMs: 5_000,
  jitterRatio: 0,
  retryRemoteNotSubmitted: true,
  retryRemoteIdempotent: true,
};

function harness() {
  const log: string[] = [];
  const events: CoordinatorEvent[] = [];
  const durability: CoordinatorDurability = {
    async persistPlan() {
      log.push("plan");
    },
    async appendEvent(event) {
      log.push(`event:${event.kind}:${"status" in event ? event.status : "job"}`);
      events.push(event);
    },
    async persistCancelIntent() {
      log.push("cancel-intent");
    },
    async persistSubmissionPrepared(record) {
      log.push(`prepared:${record.nodeId}:${record.attempt}:${record.idempotencyKey}`);
    },
    async persistRemoteJob(record) {
      log.push(`remote-job:${record.nodeId}`);
    },
    async publishOutput(record) {
      log.push(`publish:${record.nodeId}`);
      return record.output;
    },
  };
  return { log, events, durability };
}

function options(durability: CoordinatorDurability, clock = new TestClock()) {
  return {
    runId: "run-1",
    localConcurrency: 1,
    remoteConcurrency: 1,
    clock,
    jitter: { sample: () => 0.5 },
    retryPolicy: POLICY,
    durability,
  } as const;
}

test("coordinator uses stable plan order with independent local and remote gates", async () => {
  const document = documentWith(
    [prompt("prompt-a"), prompt("prompt-b"), generate("generate-a"), generate("generate-b")],
    [
      edge("edge-a", "prompt-a", "text", "generate-a", "prompt"),
      edge("edge-b", "prompt-b", "text", "generate-b", "prompt"),
    ],
  );
  const plan = createWorkflowCoordinatorPlan(document, { kind: "all" });
  const gates = new Map(plan.orderedNodeIds.map((nodeId) => [nodeId, deferred<void>()]));
  const started: string[] = [];
  const idempotencyKeys = new Map<string, string>();
  const active = { local: 0, remote: 0 };
  const maximum = { local: 0, remote: 0 };
  const { durability, log } = harness();
  const run = runWorkflowCoordinator(plan, {
    ...options(durability),
    executeNode: async ({ node, lane, idempotencyKey, recordRemoteJobId }) => {
      log.push(`execute:${node.id}`);
      active[lane] += 1;
      maximum[lane] = Math.max(maximum[lane], active[lane]);
      started.push(node.id);
      if (lane === "remote") {
        idempotencyKeys.set(node.id, idempotencyKey ?? "");
        await recordRemoteJobId(`job-${node.id}`);
      }
      await gates.get(node.id)?.promise;
      active[lane] -= 1;
      return { kind: "success", output: node.id };
    },
  });
  await settleUntil(() => started.length >= 1);
  assert.deepEqual(started, ["prompt-a"]);
  gates.get("prompt-a")?.resolve();
  await settleUntil(() => started.length >= 3);
  assert.deepEqual(started, ["prompt-a", "prompt-b", "generate-a"]);
  gates.get("prompt-b")?.resolve();
  gates.get("generate-a")?.resolve();
  await settleUntil(() => started.length >= 4);
  assert.deepEqual(started, ["prompt-a", "prompt-b", "generate-a", "generate-b"]);
  gates.get("generate-b")?.resolve();
  const result = await run;
  assert.deepEqual(maximum, { local: 1, remote: 1 });
  assert.notEqual(idempotencyKeys.get("generate-a"), idempotencyKeys.get("generate-b"));
  assert.match(idempotencyKeys.get("generate-a") ?? "", /^[A-Za-z0-9][A-Za-z0-9._:-]{15,191}$/u);
  assert.ok(
    log.findIndex((entry) => entry.startsWith("prepared:generate-a:1:")) <
      log.indexOf("execute:generate-a"),
  );
  assert.equal(result.status, "succeeded");
  assert.deepEqual(result.nodeStatuses, {
    "prompt-a": "succeeded",
    "prompt-b": "succeeded",
    "generate-a": "succeeded",
    "generate-b": "succeeded",
  });
  let cursor = createCoordinatorEventCursor(
    {
      workflowId: result.workflowId,
      workflowRevision: result.workflowRevision,
      runId: result.runId,
    },
    plan.orderedNodeIds,
  );
  for (const event of result.events) {
    const reduced = reduceCoordinatorEvent(cursor, event);
    assert.equal(reduced.accepted, true);
    if (reduced.accepted) cursor = reduced.cursor;
  }
  assert.equal(cursor.runStatus, "succeeded");
});

test("durable checkpoints pause before downstream admission and resume without rerunning upstream", async () => {
  const document = documentWith(
    [prompt("prompt-a"), generate("generate-a")],
    [edge("edge-a", "prompt-a", "text", "generate-a", "prompt")],
  );
  const plan = createWorkflowCoordinatorPlan(document, { kind: "all" });
  const firstHarness = harness();
  const executed: string[] = [];
  const paused = await runWorkflowCoordinator(plan, {
    ...options(firstHarness.durability),
    pauseBeforeNode: async ({ nodeId }) => nodeId === "generate-a",
    executeNode: async ({ node }) => {
      executed.push(node.id);
      return { kind: "success", output: node.id };
    },
  });
  assert.equal(paused.status, "paused");
  assert.deepEqual(executed, ["prompt-a"]);
  assert.equal(paused.nodeStatuses["prompt-a"], "succeeded");
  assert.equal(paused.nodeStatuses["generate-a"], "queued");

  const resumedHarness = harness();
  const resumed = await runWorkflowCoordinator(plan, {
    ...options(resumedHarness.durability),
    resuming: true,
    initialSucceededOutputs: new Map([["prompt-a", "prompt-a"]]),
    pauseBeforeNode: async () => false,
    executeNode: async ({ node, recordRemoteJobId }) => {
      executed.push(node.id);
      await recordRemoteJobId("job-resumed");
      return { kind: "success", output: node.id };
    },
  });
  assert.equal(resumed.status, "succeeded");
  assert.deepEqual(executed, ["prompt-a", "generate-a"]);
  assert.equal(
    resumedHarness.events.some((candidate) => candidate.kind === "run" && candidate.status === "running"),
    false,
  );
});

test("coordinator snapshots plan inputs and publishes output before durable success", async () => {
  const document = documentWith([prompt("prompt-a")]);
  const plan = createWorkflowCoordinatorPlan(document, { kind: "all" });
  document.nodes[0] = prompt("mutated-node");
  const observed: string[] = [];
  const { durability, log } = harness();
  const result = await runWorkflowCoordinator(plan, {
    ...options(durability),
    executeNode: async ({ node }) => {
      observed.push(node.id);
      return { kind: "success", output: "durable-output" };
    },
  });
  assert.deepEqual(observed, ["prompt-a"]);
  assert.ok(log.indexOf("plan") < log.indexOf("event:run:running"));
  assert.ok(log.indexOf("publish:prompt-a") < log.lastIndexOf("event:node:succeeded"));
  assert.equal(result.outputs.get("prompt-a"), "durable-output");
  assert.equal(Object.isFrozen(plan.snapshot), true);
});

test("only durable publication projections enter outputs and downstream dependencies", async () => {
  const graph = documentWith(
    [prompt("prompt-a"), generate("generate-a")],
    [edge("edge-a", "prompt-a", "text", "generate-a", "prompt")],
  );
  const rawPrompt = { bytes: Uint8Array.from([1, 2, 3]) };
  const rawImage = { bytes: Uint8Array.from([4, 5, 6]) };
  const durablePrompt = { kind: "text", value: "durable prompt" };
  const durableImage = { kind: "assets", assetIds: ["a".repeat(64)] };
  const observedDependencies: unknown[] = [];
  const { durability } = harness();
  const result = await runWorkflowCoordinator(
    createWorkflowCoordinatorPlan(graph, { kind: "all" }),
    {
      ...options({
        ...durability,
        async publishOutput(record) {
          return record.nodeId === "prompt-a" ? durablePrompt : durableImage;
        },
      }),
      executeNode: async ({ lane, dependencyOutputs }) => {
        if (lane === "local") return { kind: "success", output: rawPrompt };
        observedDependencies.push(dependencyOutputs.get("prompt-a"));
        return { kind: "success", output: rawImage };
      },
    },
  );
  assert.deepEqual(observedDependencies, [durablePrompt]);
  assert.deepEqual(result.outputs.get("prompt-a"), durablePrompt);
  assert.deepEqual(result.outputs.get("generate-a"), durableImage);
  assert.notEqual(result.outputs.get("prompt-a"), rawPrompt);
  assert.notEqual(result.outputs.get("generate-a"), rawImage);
});

test("failure and node cancellation block required descendants while independent work succeeds", async () => {
  const graph = documentWith(
    [
      prompt("prompt-a"),
      generate("generate-a"),
      { id: "output-a", type: "output", position: { x: 200, y: 0 }, data: {} },
      prompt("independent"),
    ],
    [
      edge("edge-a", "prompt-a", "text", "generate-a", "prompt"),
      edge("edge-b", "generate-a", "images", "output-a", "images"),
    ],
  );
  const { durability } = harness();
  const result = await runWorkflowCoordinator(
    createWorkflowCoordinatorPlan(graph, { kind: "all" }),
    {
      ...options(durability),
      localConcurrency: 2,
      executeNode: async ({ node }) =>
        node.id === "generate-a"
          ? { kind: "failure", error: "mock refused", retrySafety: "never" }
          : { kind: "success", output: node.id },
    },
  );
  assert.equal(result.status, "failed");
  assert.equal(result.nodeStatuses["generate-a"], "failed");
  assert.equal(result.nodeStatuses["output-a"], "blocked");
  assert.equal(result.nodeStatuses.independent, "succeeded");
});

test("run-from-here executes required ancestors and only the explicitly selected downstream path", async () => {
  const graph = documentWith(
    [
      prompt("prompt-a"),
      generate("generate-a"),
      { id: "output-a", type: "output", position: { x: 200, y: 0 }, data: {} },
      prompt("independent"),
    ],
    [
      edge("edge-a", "prompt-a", "text", "generate-a", "prompt"),
      edge("edge-b", "generate-a", "images", "output-a", "images"),
    ],
  );
  const runScope = async (plan: WorkflowExecutionPlan) => {
    const { durability } = harness();
    const executed: string[] = [];
    const result = await runWorkflowCoordinator(plan, {
      ...options(durability),
      executeNode: async ({ node }) => {
        executed.push(node.id);
        return { kind: "success", output: node.id };
      },
    });
    return { executed, result };
  };
  const selected = await runScope(
    createWorkflowCoordinatorPlan(graph, {
      kind: "from-node",
      nodeId: "generate-a",
    }),
  );
  assert.deepEqual(selected.executed, ["prompt-a", "generate-a"]);
  assert.deepEqual(Object.keys(selected.result.nodeStatuses), ["prompt-a", "generate-a"]);

  const downstream = await runScope(
    createWorkflowCoordinatorPlan(graph, {
      kind: "from-node",
      nodeId: "generate-a",
      downstreamPath: ["output-a"],
    }),
  );
  assert.deepEqual(downstream.executed, ["prompt-a", "generate-a", "output-a"]);
});

test("main coordinator planning rejects a forged path whose rejoin hides sibling work", () => {
  const graph = documentWith(
    [
      prompt("start"),
      generate("generate-a"),
      generate("generate-b"),
      {
        id: "gallery",
        type: "output-gallery",
        position: { x: 200, y: 0 },
        data: {},
      },
    ],
    [
      edge("prompt-a", "start", "text", "generate-a", "prompt"),
      edge("prompt-b", "start", "text", "generate-b", "prompt"),
      edge("image-a", "generate-a", "images", "gallery", "images"),
      edge("image-b", "generate-b", "images", "gallery", "images"),
    ],
  );
  assert.throws(
    () =>
      createWorkflowCoordinatorPlan(graph, {
        kind: "from-node",
        nodeId: "start",
        downstreamPath: ["generate-a", "gallery"],
      }),
    /additional branch work/u,
  );
});

test("bounded retry uses injected clock and explicit safety classifications", async () => {
  const clock = new TestClock();
  const { durability } = harness();
  let attempts = 0;
  const result = await runWorkflowCoordinator(
    createWorkflowCoordinatorPlan(documentWith([prompt("prompt-a")]), {
      kind: "all",
    }),
    {
      ...options(durability, clock),
      executeNode: async () => {
        attempts += 1;
        return attempts < 3
          ? {
              kind: "rate-limited",
              error: "slow down",
              retrySafety: "local-safe",
            }
          : { kind: "success", output: "done" };
      },
    },
  );
  assert.equal(attempts, 3);
  assert.deepEqual(clock.sleeps, [100, 200]);
  assert.equal(result.retryDelayMs, 300);
  assert.deepEqual(
    result.events
      .filter((event) => event.kind === "node" && event.nodeId === "prompt-a")
      .map((event) => (event.kind === "node" ? [event.status, event.attempt] : [])),
    [
      ["queued", 0],
      ["running", 1],
      ["retry_wait", 1],
      ["running", 2],
      ["retry_wait", 2],
      ["running", 3],
      ["succeeded", 3],
    ],
  );
});

test("ambiguous remote submission is terminal and can never be auto-retried", async () => {
  const graph = documentWith(
    [prompt("prompt-a"), generate("generate-a")],
    [edge("edge-a", "prompt-a", "text", "generate-a", "prompt")],
  );
  const { durability, log } = harness();
  let remoteAttempts = 0;
  const result = await runWorkflowCoordinator(
    createWorkflowCoordinatorPlan(graph, { kind: "all" }),
    {
      ...options(durability),
      executeNode: async ({ lane }) => {
        if (lane === "local") return { kind: "success", output: "prompt" };
        remoteAttempts += 1;
        return { kind: "ambiguous-submit", error: "accepted, response lost" };
      },
    },
  );
  assert.equal(remoteAttempts, 1);
  assert.equal(result.nodeStatuses["generate-a"], "ambiguous");
  assert.equal(result.status, "needs_attention");
  assert.equal(result.retryDelayMs, 0);
  assert.ok(log.some((entry) => entry.startsWith("prepared:generate-a:1:")));
  assert.equal(log.includes("remote-job:generate-a"), false);
});

test("unknown remote exceptions after durable preparation are ambiguous, while typed non-submission can retry", async () => {
  const graph = documentWith(
    [prompt("prompt-a"), generate("generate-a")],
    [edge("edge-a", "prompt-a", "text", "generate-a", "prompt")],
  );
  const plan = createWorkflowCoordinatorPlan(graph, { kind: "all" });
  const unknownHarness = harness();
  let unknownAttempts = 0;
  const unknown = await runWorkflowCoordinator(plan, {
    ...options(unknownHarness.durability),
    executeNode: async ({ lane }) => {
      if (lane === "local") return { kind: "success", output: "prompt" };
      unknownAttempts += 1;
      throw new Error("socket closed after send");
    },
  });
  assert.equal(unknownAttempts, 1);
  assert.equal(unknown.status, "needs_attention");
  assert.equal(unknown.nodeStatuses["generate-a"], "ambiguous");
  assert.equal(unknown.retryDelayMs, 0);

  const safeHarness = harness();
  let safeAttempts = 0;
  const safe = await runWorkflowCoordinator(plan, {
    ...options(safeHarness.durability),
    executeNode: async ({ lane }) => {
      if (lane === "local") return { kind: "success", output: "prompt" };
      safeAttempts += 1;
      return safeAttempts === 1
        ? {
            kind: "failure",
            error: "failed before transport",
            retrySafety: "confirmed-not-submitted",
          }
        : { kind: "success", output: "image" };
    },
  });
  assert.equal(safeAttempts, 2);
  assert.equal(safe.status, "succeeded");
});

test("remote retry requires confirmed non-submission or the exact bounded idempotency class", async () => {
  const graph = documentWith(
    [prompt("prompt-a"), generate("generate-a")],
    [edge("edge-a", "prompt-a", "text", "generate-a", "prompt")],
  );
  const plan = createWorkflowCoordinatorPlan(graph, { kind: "all" });
  const runCase = async (
    firstRemoteResult:
      | {
          kind: "rate-limited";
          error: string;
          retrySafety: "confirmed-not-submitted" | "same-idempotency-key";
          retryAfterMs?: number;
          idempotencyKey?: string;
        }
      | {
          kind: "failure";
          error: string;
          retrySafety: "same-idempotency-key";
          idempotencyKey?: string;
        },
    retryPolicy: CoordinatorRetryPolicy = POLICY,
  ) => {
    const { durability } = harness();
    const clock = new TestClock();
    let remoteAttempts = 0;
    const attemptKeys: string[] = [];
    const result = await runWorkflowCoordinator(plan, {
      ...options(durability, clock),
      retryPolicy,
      executeNode: async ({ lane, idempotencyKey }) => {
        if (lane === "local") return { kind: "success", output: "prompt" };
        remoteAttempts += 1;
        attemptKeys.push(idempotencyKey ?? "");
        if (remoteAttempts !== 1) return { kind: "success", output: "image" };
        return firstRemoteResult.idempotencyKey === "USE_CONTEXT_KEY"
          ? { ...firstRemoteResult, idempotencyKey }
          : firstRemoteResult;
      },
    });
    return { result, remoteAttempts, clock, attemptKeys };
  };

  const disabled = await runCase(
    {
      kind: "rate-limited",
      error: "not submitted",
      retrySafety: "confirmed-not-submitted",
    },
    { ...POLICY, retryRemoteNotSubmitted: false },
  );
  assert.equal(disabled.remoteAttempts, 1);
  assert.equal(disabled.result.status, "failed");

  const missingKey = await runCase({
    kind: "failure",
    error: "accepted under a key",
    retrySafety: "same-idempotency-key",
  });
  assert.equal(missingKey.remoteAttempts, 1);

  const sameKey = await runCase({
    kind: "rate-limited",
    error: "retry same request",
    retrySafety: "same-idempotency-key",
    idempotencyKey: "USE_CONTEXT_KEY",
    retryAfterMs: 250,
  });
  assert.equal(sameKey.remoteAttempts, 2);
  assert.equal(sameKey.result.status, "succeeded");
  assert.deepEqual(sameKey.clock.sleeps, [250]);
  assert.equal(sameKey.attemptKeys.length, 2);
  assert.equal(sameKey.attemptKeys[0], sameKey.attemptKeys[1]);

  const freshKey = await runCase({
    kind: "rate-limited",
    error: "definitely not submitted",
    retrySafety: "confirmed-not-submitted",
  });
  assert.equal(freshKey.remoteAttempts, 2);
  assert.notEqual(freshKey.attemptKeys[0], freshKey.attemptKeys[1]);

  const excessiveRetryAfter = await runCase({
    kind: "rate-limited",
    error: "retry much later",
    retrySafety: "confirmed-not-submitted",
    retryAfterMs: 1_001,
  });
  assert.equal(excessiveRetryAfter.remoteAttempts, 1);
  assert.deepEqual(excessiveRetryAfter.clock.sleeps, []);

  const { durability } = harness();
  let contradictoryAttempts = 0;
  const contradictory = await runWorkflowCoordinator(plan, {
    ...options(durability),
    executeNode: async ({ lane, recordRemoteJobId }) => {
      if (lane === "local") return { kind: "success", output: "prompt" };
      contradictoryAttempts += 1;
      await recordRemoteJobId("accepted-job-1");
      return {
        kind: "rate-limited",
        error: "incorrect classification",
        retrySafety: "confirmed-not-submitted",
      };
    },
  });
  assert.equal(contradictoryAttempts, 1);
  assert.equal(contradictory.status, "needs_attention");
  assert.equal(contradictory.nodeStatuses["generate-a"], "ambiguous");

  for (const acceptedResult of [
    {
      kind: "rate-limited" as const,
      error: "polling was rate limited",
      retrySafety: "same-idempotency-key" as const,
    },
    {
      kind: "failure" as const,
      error: "accepted job lookup failed",
      retrySafety: "same-idempotency-key" as const,
    },
  ]) {
    const acceptedHarness = harness();
    let acceptedAttempts = 0;
    const accepted = await runWorkflowCoordinator(plan, {
      ...options(acceptedHarness.durability),
      executeNode: async ({ lane, idempotencyKey, recordRemoteJobId }) => {
        if (lane === "local") return { kind: "success", output: "prompt" };
        acceptedAttempts += 1;
        await recordRemoteJobId("accepted-same-key-job");
        return { ...acceptedResult, idempotencyKey };
      },
    });
    assert.equal(acceptedAttempts, 1);
    assert.equal(accepted.status, "needs_attention");
    assert.equal(accepted.nodeStatuses["generate-a"], "ambiguous");
    assert.deepEqual(
      accepted.events
        .filter((event) => event.kind === "node" && event.nodeId === "generate-a")
        .map((event) => (event.kind === "node" ? event.status : undefined)),
      ["queued", "running", "ambiguous"],
    );
    assert.equal(
      acceptedHarness.log.some((entry) => entry.includes("retry_wait")),
      false,
    );
  }
});

test("durable cancellation precedes abort/provider cancel and suppresses late completion", async () => {
  const graph = documentWith(
    [
      prompt("prompt-a"),
      generate("generate-a"),
      { id: "output-a", type: "output", position: { x: 200, y: 0 }, data: {} },
    ],
    [
      edge("edge-a", "prompt-a", "text", "generate-a", "prompt"),
      edge("edge-b", "generate-a", "images", "output-a", "images"),
    ],
  );
  const controller = new AbortController();
  const remoteStarted = deferred<void>();
  const late = deferred<never>();
  const { durability, log } = harness();
  const run = runWorkflowCoordinator(createWorkflowCoordinatorPlan(graph, { kind: "all" }), {
    ...options(durability),
    signal: controller.signal,
    cancelRemoteJob: async (record) => {
      log.push(`cancel-remote:${record.nodeId}`);
    },
    executeNode: async ({ lane, signal, recordRemoteJobId }) => {
      if (lane === "local") return { kind: "success", output: "prompt" };
      await recordRemoteJobId("remote-job-1");
      signal.addEventListener("abort", () => log.push("executor-abort"), {
        once: true,
      });
      remoteStarted.resolve();
      return late.promise;
    },
  });
  await remoteStarted.promise;
  controller.abort(new CoordinatorCancellationRequest("renderer-disconnected"));
  const result = await Promise.race([
    run,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("non-cooperative cancel did not terminalize")), 100),
    ),
  ]);
  const intentIndex = log.indexOf("cancel-intent");
  assert.ok(intentIndex >= 0);
  assert.ok(intentIndex < log.indexOf("executor-abort"));
  assert.ok(intentIndex < log.indexOf("cancel-remote:generate-a"));
  assert.equal(result.nodeStatuses["generate-a"], "cancelled");
  assert.equal(result.nodeStatuses["output-a"], "blocked");
  assert.equal(result.outputs.has("generate-a"), false);
});

test("a prepared remote submission remains ambiguous when cancellation becomes durable", async () => {
  const graph = documentWith(
    [
      prompt("prompt-a"),
      generate("generate-a"),
      { id: "output-a", type: "output", position: { x: 200, y: 0 }, data: {} },
    ],
    [
      edge("edge-a", "prompt-a", "text", "generate-a", "prompt"),
      edge("edge-b", "generate-a", "images", "output-a", "images"),
    ],
  );
  const controller = new AbortController();
  const remoteStarted = deferred<void>();
  const { durability, log } = harness();
  const run = runWorkflowCoordinator(createWorkflowCoordinatorPlan(graph, { kind: "all" }), {
    ...options(durability),
    signal: controller.signal,
    executeNode: async ({ lane, signal }) => {
      if (lane === "local") return { kind: "success", output: "prompt" };
      remoteStarted.resolve();
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      return { kind: "cancelled" };
    },
  });
  await remoteStarted.promise;
  controller.abort(new CoordinatorCancellationRequest("app-quit"));
  const result = await run;

  assert.equal(result.status, "needs_attention");
  assert.equal(result.nodeStatuses["generate-a"], "ambiguous");
  assert.equal(result.nodeStatuses["output-a"], "blocked");
  assert.ok(
    log.findIndex((entry) => entry.startsWith("prepared:generate-a:1:")) <
      log.indexOf("cancel-intent"),
  );
  assert.equal(
    result.events.some(
      (event) =>
        event.kind === "node" && event.nodeId === "generate-a" && event.status === "cancelled",
    ),
    false,
  );
});

test("durable cancellation during output publication keeps the output on a cancelled run", async () => {
  const controller = new AbortController();
  const { durability, log, events } = harness();
  const result = await runWorkflowCoordinator(
    createWorkflowCoordinatorPlan(documentWith([prompt("prompt-a")]), { kind: "all" }),
    {
      ...options({
        ...durability,
        async persistCancelIntent() {
          log.push("cancel-intent");
        },
        async publishOutput(record) {
          log.push("publish-start");
          controller.abort(new CoordinatorCancellationRequest("app-quit"));
          await new Promise((resolve) => setImmediate(resolve));
          log.push("publish-end");
          return record.output;
        },
      }),
      signal: controller.signal,
      executeNode: async () => ({ kind: "success", output: "durable prompt" }),
    },
  );

  assert.deepEqual(log.slice(log.indexOf("publish-start"), log.indexOf("publish-end") + 1), [
    "publish-start",
    "cancel-intent",
    "publish-end",
  ]);
  assert.equal(result.status, "cancelled");
  assert.equal(result.nodeStatuses["prompt-a"], "succeeded");
  assert.equal(result.outputs.get("prompt-a"), "durable prompt");
  const terminalEvent = events[events.length - 1];
  assert.equal(terminalEvent?.kind, "run");
  assert.equal(terminalEvent?.kind === "run" ? terminalEvent.status : undefined, "cancelled");
});

test("typed abort reasons durably distinguish user, renderer disconnect, and app quit", async () => {
  for (const [expected, reason] of [
    ["user", new Error("untrusted renderer text")],
    ["renderer-disconnected", new CoordinatorCancellationRequest("renderer-disconnected")],
    ["app-quit", new CoordinatorCancellationRequest("app-quit")],
  ] as const) {
    const controller = new AbortController();
    controller.abort(reason);
    const persisted: string[] = [];
    const { durability } = harness();
    const result = await runWorkflowCoordinator(
      createWorkflowCoordinatorPlan(documentWith([prompt("prompt-a")]), {
        kind: "all",
      }),
      {
        ...options({
          ...durability,
          async persistCancelIntent(intent) {
            persisted.push(intent.reason);
          },
        }),
        signal: controller.signal,
        executeNode: async () => {
          throw new Error("A pre-cancelled run must not execute nodes.");
        },
      },
    );
    assert.deepEqual(persisted, [expected]);
    assert.equal(result.status, "cancelled");
  }
});

test("event reducer rejects cross-run, duplicate, out-of-order, invalid, and late events", () => {
  const identity = {
    workflowId: "workflow-1",
    workflowRevision: 7,
    runId: "run-1",
  };
  let cursor = createCoordinatorEventCursor(identity, ["node-a"]);
  const event = (sequence: number, value: CoordinatorEventPayload): CoordinatorEvent =>
    ({ ...identity, sequence, atMs: sequence, ...value }) as CoordinatorEvent;
  const rejectionReason = (reduction: CoordinatorEventReduction) => {
    assert.equal(reduction.accepted, false);
    return reduction.accepted ? undefined : reduction.reason;
  };
  const started = reduceCoordinatorEvent(cursor, event(1, { kind: "run", status: "running" }));
  assert.equal(started.accepted, true);
  if (!started.accepted) return;
  cursor = started.cursor;
  assert.equal(
    rejectionReason(reduceCoordinatorEvent(cursor, event(2, { kind: "run", status: "failed" }))),
    "invalid-transition",
  );
  assert.equal(
    rejectionReason(reduceCoordinatorEvent(cursor, event(1, { kind: "run", status: "running" }))),
    "duplicate-or-stale",
  );
  assert.equal(
    rejectionReason(
      reduceCoordinatorEvent(
        cursor,
        event(3, {
          kind: "node",
          nodeId: "node-a",
          status: "queued",
          attempt: 0,
        }),
      ),
    ),
    "out-of-order",
  );
  assert.equal(
    rejectionReason(
      reduceCoordinatorEvent(cursor, {
        ...event(2, {
          kind: "node",
          nodeId: "node-a",
          status: "queued",
          attempt: 0,
        }),
        runId: "other",
      }),
    ),
    "wrong-run",
  );
  for (const next of [
    event(2, { kind: "node", nodeId: "node-a", status: "queued", attempt: 0 }),
    event(3, { kind: "node", nodeId: "node-a", status: "running", attempt: 1 }),
    event(4, {
      kind: "node",
      nodeId: "node-a",
      status: "succeeded",
      attempt: 1,
    }),
    event(5, { kind: "run", status: "succeeded" }),
  ]) {
    const reduced = reduceCoordinatorEvent(cursor, next);
    assert.equal(reduced.accepted, true);
    if (reduced.accepted) cursor = reduced.cursor;
  }
  assert.equal(
    rejectionReason(
      reduceCoordinatorEvent(
        cursor,
        event(6, {
          kind: "node",
          nodeId: "node-a",
          status: "failed",
          attempt: 1,
        }),
      ),
    ),
    "late-after-terminal",
  );
});

test("renderer lifecycle and every restart phase have explicit no-auto-submit decisions", () => {
  assert.equal(
    rendererDisconnectDecision("document-1", {
      kind: "route-change",
      documentId: "document-1",
    }),
    "continue-and-resubscribe",
  );
  assert.equal(
    rendererDisconnectDecision("document-1", {
      kind: "document-destroyed",
      documentId: "document-1",
    }),
    "request-best-effort-cancel",
  );
  assert.equal(
    rendererDisconnectDecision("document-1", {
      kind: "document-destroyed",
      documentId: "document-2",
    }),
    "ignore",
  );
  const decisions = [
    reconcileRestartNode({ phase: "never-started", lane: "local" }),
    reconcileRestartNode({ phase: "local-running", lane: "local" }),
    reconcileRestartNode({ phase: "remote-submitting", lane: "remote" }),
    reconcileRestartNode({
      phase: "remote-submitting",
      lane: "remote",
      remoteJobId: "job-1",
    }),
    reconcileRestartNode({ phase: "remote-submitted", lane: "remote" }),
    reconcileRestartNode({
      phase: "remote-submitted",
      lane: "remote",
      remoteJobId: "job-1",
    }),
    reconcileRestartNode({
      phase: "output-publishing",
      lane: "remote",
      durableOutputAvailable: true,
    }),
    reconcileRestartNode({
      phase: "cancel-requested",
      lane: "remote",
      remoteJobId: "job-1",
    }),
    reconcileRestartNode({ phase: "terminal", lane: "remote" }),
  ];
  assert.ok(decisions.every((decision) => decision.autoSubmit === false));
  assert.deepEqual(
    decisions.map((decision) => decision.category),
    [
      "await-explicit-resume",
      "mark-interrupted",
      "ambiguous-submit",
      "reconcile-remote-job",
      "ambiguous-submit",
      "reconcile-remote-job",
      "resume-output-publication",
      "reconcile-cancel",
      "terminal",
    ],
  );
});

test("altered and invalid plans, retry policies, and concurrency fail before execution", async () => {
  const plan = createWorkflowCoordinatorPlan(documentWith([prompt("prompt-a")]), { kind: "all" });
  const forged = {
    ...plan,
    orderedNodeIds: ["missing"],
  } as WorkflowExecutionPlan;
  const { durability } = harness();
  await assert.rejects(
    runWorkflowCoordinator(forged, {
      ...options(durability),
      executeNode: async () => ({ kind: "success", output: undefined }),
    }),
    /altered/u,
  );
  await assert.rejects(
    runWorkflowCoordinator(plan, {
      ...options(durability),
      remoteConcurrency: 5,
      executeNode: async () => ({ kind: "success", output: undefined }),
    }),
    /between 1 and 4/u,
  );
  await assert.rejects(
    runWorkflowCoordinator(plan, {
      ...options(durability),
      retryPolicy: { ...POLICY, maxRetriesPerNode: 6 },
      executeNode: async () => ({ kind: "success", output: undefined }),
    }),
    /Retry count/u,
  );
});
