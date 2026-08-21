import assert from "node:assert/strict";
import test from "node:test";
import {
  CREATE_IMAGES_MAX_DOWNSTREAM_PATH_CHOICES,
  CREATE_IMAGES_MAX_DOWNSTREAM_PATH_SEARCH_STEPS,
  enumerateWorkflowDownstreamPaths,
  isWorkflowDownstreamPathExplicit,
  isWorkflowRunScopeExecutable,
  planWorkflowExecution,
  reduceWorkflowRunTransition,
  runWorkflowPlan,
  type WorkflowExecutionPlan,
  type WorkflowNodeRunTransition,
} from "./execution.js";
import type { WorkflowDocumentV1, WorkflowNodeV1 } from "./schema.js";

const NOW = "2026-08-11T12:00:00.000Z";

function documentWith(nodes: WorkflowNodeV1[]): WorkflowDocumentV1 {
  return {
    schemaVersion: 1,
    id: "workflow-1",
    title: "Execution test",
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
    nodes,
    edges: [],
    assetRefs: [],
    settings: { concurrency: 1 },
  };
}

function prompt(id: string): WorkflowNodeV1 {
  return { id, type: "prompt", position: { x: 0, y: 0 }, data: { text: id } };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

test("scheduler respects concurrency and stable plan order", async () => {
  const document = documentWith([prompt("node-a"), prompt("node-b"), prompt("node-c")]);
  const plan = planWorkflowExecution(document, { kind: "all" });
  const gates = new Map(plan.orderedNodeIds.map((nodeId) => [nodeId, deferred<void>()]));
  let active = 0;
  let maximumActive = 0;
  const started: string[] = [];
  const run = runWorkflowPlan(document, plan, {
    runId: "run-concurrency",
    concurrency: 2,
    executeNode: async ({ node }) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      started.push(node.id);
      await gates.get(node.id)?.promise;
      active -= 1;
      return node.id;
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ["node-a", "node-b"]);
  gates.get("node-a")?.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ["node-a", "node-b", "node-c"]);
  gates.get("node-b")?.resolve();
  gates.get("node-c")?.resolve();
  const result = await run;
  assert.equal(maximumActive, 2);
  assert.deepEqual(result.statuses, {
    "node-a": "succeeded",
    "node-b": "succeeded",
    "node-c": "succeeded",
  });
});

test("failed nodes block descendants while independent work completes", async () => {
  const document = documentWith([
    prompt("prompt-1"),
    {
      id: "generate-1",
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
    },
    { id: "output-1", type: "output", position: { x: 200, y: 0 }, data: {} },
    prompt("independent"),
  ]);
  document.edges = [
    {
      id: "edge-1",
      source: "prompt-1",
      sourcePort: "text",
      target: "generate-1",
      targetPort: "prompt",
    },
    {
      id: "edge-2",
      source: "generate-1",
      sourcePort: "images",
      target: "output-1",
      targetPort: "images",
    },
  ];
  const plan = planWorkflowExecution(document, { kind: "all" });
  const result = await runWorkflowPlan(document, plan, {
    runId: "run-failure",
    concurrency: 2,
    executeNode: async ({ node }) => {
      if (node.id === "generate-1") throw new Error("provider failed");
      return node.id;
    },
  });
  assert.equal(result.statuses["prompt-1"], "succeeded");
  assert.equal(result.statuses["generate-1"], "failed");
  assert.equal(result.statuses["output-1"], "blocked");
  assert.equal(result.statuses.independent, "succeeded");
});

test("cancellation rejects late completion instead of publishing it", async () => {
  const document = documentWith([prompt("node-a")]);
  const plan = planWorkflowExecution(document, { kind: "all" });
  const gate = deferred<string>();
  const controller = new AbortController();
  const run = runWorkflowPlan(document, plan, {
    runId: "run-cancel",
    concurrency: 1,
    signal: controller.signal,
    executeNode: () => gate.promise,
  });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort(new Error("cancelled by test"));
  gate.resolve("late output");
  const result = await run;
  assert.equal(result.statuses["node-a"], "cancelled");
  assert.equal(result.outputs.has("node-a"), false);
});

test("scheduler normalizes synchronous executor failures", async () => {
  const document = documentWith([prompt("node-a")]);
  const plan = planWorkflowExecution(document, { kind: "all" });
  const result = await runWorkflowPlan(document, plan, {
    runId: "run-sync-failure",
    concurrency: 1,
    executeNode: () => {
      throw new Error("synchronous failure");
    },
  });
  assert.equal(result.statuses["node-a"], "failed");
  assert.match(
    result.transitions[result.transitions.length - 1]?.error ?? "",
    /synchronous failure/u,
  );
});

test("run-from-node includes required ancestors and optional downstream nodes", () => {
  const document = documentWith([
    prompt("prompt-1"),
    {
      id: "generate-1",
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
    },
    { id: "output-1", type: "output", position: { x: 200, y: 0 }, data: {} },
  ]);
  document.edges = [
    {
      id: "edge-1",
      source: "prompt-1",
      sourcePort: "text",
      target: "generate-1",
      targetPort: "prompt",
    },
    {
      id: "edge-2",
      source: "generate-1",
      sourcePort: "images",
      target: "output-1",
      targetPort: "images",
    },
  ];
  const selected: WorkflowExecutionPlan = planWorkflowExecution(document, {
    kind: "from-node",
    nodeId: "generate-1",
  });
  assert.deepEqual(selected.orderedNodeIds, ["prompt-1", "generate-1"]);
  const downstream = planWorkflowExecution(document, {
    kind: "from-node",
    nodeId: "generate-1",
    downstreamPath: ["output-1"],
  });
  assert.deepEqual(downstream.orderedNodeIds, ["prompt-1", "generate-1", "output-1"]);
  assert.equal(
    isWorkflowRunScopeExecutable(document, {
      kind: "from-node",
      nodeId: "generate-1",
      downstreamPath: ["output-1"],
    }),
    true,
  );
  assert.equal(
    isWorkflowRunScopeExecutable(document, {
      kind: "from-node",
      nodeId: "generate-1",
      downstreamPath: ["missing-output"],
    }),
    false,
  );
  assert.equal(isWorkflowDownstreamPathExplicit(document, "generate-1", ["output-1"]), true);
});

test("downstream path choices are deterministic, connected, and deduplicate parallel edges", () => {
  const document = documentWith([
    prompt("start"),
    prompt("branch-b"),
    prompt("branch-a"),
    prompt("sink-b"),
    prompt("sink-a"),
  ]);
  document.edges = [
    { id: "z", source: "start", sourcePort: "text", target: "branch-a", targetPort: "text" },
    { id: "a", source: "start", sourcePort: "text", target: "branch-b", targetPort: "text" },
    {
      id: "parallel",
      source: "start",
      sourcePort: "text",
      target: "branch-b",
      targetPort: "text",
    },
    {
      id: "sink-a",
      source: "branch-a",
      sourcePort: "text",
      target: "sink-a",
      targetPort: "text",
    },
    {
      id: "sink-b",
      source: "branch-b",
      sourcePort: "text",
      target: "sink-b",
      targetPort: "text",
    },
  ];
  const result = enumerateWorkflowDownstreamPaths(document, "start");
  assert.equal(result.truncated, false);
  assert.deepEqual(
    result.choices.map((choice) => choice.downstreamPath),
    [
      ["branch-b", "sink-b"],
      ["branch-a", "sink-a"],
    ],
  );
  assert.deepEqual(
    result.choices.map((choice) => choice.id),
    ["path:1", "path:2"],
  );
});

test("a downstream choice is rejected when a rejoining branch would run invisibly", () => {
  const generation = (id: string): WorkflowNodeV1 => ({
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
  });
  const document = documentWith([
    prompt("start"),
    generation("generation-a"),
    generation("generation-b"),
    {
      id: "gallery",
      type: "output-gallery",
      position: { x: 200, y: 0 },
      data: {},
    },
  ]);
  document.edges = [
    {
      id: "prompt-a",
      source: "start",
      sourcePort: "text",
      target: "generation-a",
      targetPort: "prompt",
    },
    {
      id: "prompt-b",
      source: "start",
      sourcePort: "text",
      target: "generation-b",
      targetPort: "prompt",
    },
    {
      id: "images-a",
      source: "generation-a",
      sourcePort: "images",
      target: "gallery",
      targetPort: "images",
    },
    {
      id: "images-b",
      source: "generation-b",
      sourcePort: "images",
      target: "gallery",
      targetPort: "images",
    },
  ];
  const choices = enumerateWorkflowDownstreamPaths(document, "start").choices;
  assert.equal(choices.length, 2);
  assert.equal(
    isWorkflowDownstreamPathExplicit(document, "start", choices[0]!.downstreamPath),
    false,
  );
  assert.equal(
    isWorkflowDownstreamPathExplicit(document, "start", choices[1]!.downstreamPath),
    false,
  );
  assert.throws(
    () =>
      planWorkflowExecution(document, {
        kind: "from-node",
        nodeId: "start",
        downstreamPath: choices[0]!.downstreamPath,
      }),
    /additional branch work/u,
  );
});

test("downstream enumeration caps exponential fan-out and explains overflow", () => {
  const layers = Array.from({ length: 7 }, (_, layer) =>
    layer === 0 ? ["start"] : [`layer-${layer}-a`, `layer-${layer}-b`],
  );
  const document = documentWith(layers.flat().map(prompt));
  document.edges = layers.slice(0, -1).flatMap((layer, layerIndex) =>
    layer.flatMap((source) =>
      layers[layerIndex + 1]!.map((target) => ({
        id: `${source}-${target}`,
        source,
        sourcePort: "text",
        target,
        targetPort: "text",
      })),
    ),
  );
  const result = enumerateWorkflowDownstreamPaths(document, "start");
  assert.equal(result.choices.length, CREATE_IMAGES_MAX_DOWNSTREAM_PATH_CHOICES);
  assert.equal(result.truncated, true);
  assert.equal(result.overflowReason, "choice-limit");
  assert.ok(result.searchSteps <= CREATE_IMAGES_MAX_DOWNSTREAM_PATH_SEARCH_STEPS);
  assert.equal(
    new Set(result.choices.map((choice) => choice.downstreamPath.join(">"))).size,
    CREATE_IMAGES_MAX_DOWNSTREAM_PATH_CHOICES,
  );
});

test("downstream enumeration handles the maximum path depth without recursion", () => {
  const nodes = Array.from({ length: 500 }, (_, index) => prompt(`node-${index}`));
  const document = documentWith(nodes);
  document.edges = nodes.slice(0, -1).map((node, index) => ({
    id: `edge-${index}`,
    source: node.id,
    sourcePort: "text",
    target: nodes[index + 1]!.id,
    targetPort: "text",
  }));
  const result = enumerateWorkflowDownstreamPaths(document, "node-0");
  assert.equal(result.truncated, false);
  assert.equal(result.choices.length, 1);
  assert.equal(result.choices[0]?.downstreamPath.length, 499);
  assert.ok(result.searchSteps <= CREATE_IMAGES_MAX_DOWNSTREAM_PATH_SEARCH_STEPS);
});

test("cancellation terminalizes without waiting for a non-cooperative executor", async () => {
  const document = documentWith([prompt("node-a")]);
  const plan = planWorkflowExecution(document, { kind: "all" });
  const controller = new AbortController();
  const never = new Promise<never>(() => undefined);
  const run = runWorkflowPlan(document, plan, {
    runId: "run-non-cooperative",
    concurrency: 1,
    signal: controller.signal,
    executeNode: () => never,
  });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  const result = await Promise.race([
    run,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("cancelled run did not terminalize")), 100),
    ),
  ]);
  assert.equal(result.statuses["node-a"], "cancelled");
  assert.equal(result.outputs.size, 0);
});

test("a rejection without a reason is still a failure", async () => {
  const document = documentWith([prompt("node-a")]);
  const plan = planWorkflowExecution(document, { kind: "all" });
  const result = await runWorkflowPlan(document, plan, {
    runId: "run-undefined-rejection",
    concurrency: 1,
    executeNode: () => Promise.reject(),
  });
  assert.equal(result.statuses["node-a"], "failed");
  assert.equal(result.outputs.has("node-a"), false);
});

test("execution uses the immutable plan snapshot after the live document mutates", async () => {
  const document = documentWith([prompt("node-a")]);
  const plan = planWorkflowExecution(document, { kind: "all" });
  const liveNode = document.nodes[0];
  assert.ok(liveNode?.type === "prompt");
  liveNode.data.text = "MUTATED";
  const observed: string[] = [];
  await runWorkflowPlan(document, plan, {
    runId: "run-snapshot",
    concurrency: 1,
    executeNode: async ({ node }) => {
      if (node.type === "prompt") observed.push(node.data.text);
      return node.id;
    },
  });
  assert.deepEqual(observed, ["node-a"]);
  assert.equal(Object.isFrozen(plan.snapshot.nodes[0]?.data), true);
});

test("explicit downstream paths reject target ancestors that were not selected", () => {
  const document = documentWith([
    prompt("prompt-1"),
    prompt("prompt-2"),
    {
      id: "generate-1",
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
    },
    {
      id: "generate-2",
      type: "generate-image",
      position: { x: 200, y: 0 },
      data: {
        providerId: "gemini",
        modelId: "gemini-3.1-flash-image",
        aspectRatio: "1:1",
        imageSize: "1K",
        outputMime: "image/png",
        count: 1,
      },
    },
    { id: "output-selected", type: "output", position: { x: 300, y: 0 }, data: {} },
    { id: "output-other", type: "output", position: { x: 300, y: 100 }, data: {} },
  ]);
  document.edges = [
    {
      id: "e1",
      source: "prompt-1",
      sourcePort: "text",
      target: "generate-1",
      targetPort: "prompt",
    },
    {
      id: "e2",
      source: "prompt-2",
      sourcePort: "text",
      target: "generate-2",
      targetPort: "prompt",
    },
    {
      id: "e3",
      source: "generate-1",
      sourcePort: "images",
      target: "generate-2",
      targetPort: "references",
    },
    {
      id: "e4",
      source: "generate-2",
      sourcePort: "images",
      target: "output-selected",
      targetPort: "images",
    },
    {
      id: "e5",
      source: "generate-1",
      sourcePort: "images",
      target: "output-other",
      targetPort: "images",
    },
  ];
  assert.throws(
    () =>
      planWorkflowExecution(document, {
        kind: "from-node",
        nodeId: "generate-1",
        downstreamPath: ["generate-2", "output-selected"],
      }),
    /additional branch work/u,
  );
  assert.throws(
    () =>
      planWorkflowExecution(document, {
        kind: "from-node",
        nodeId: "generate-1",
        downstreamPath: ["output-selected"],
      }),
    /not connected/u,
  );
});

test("transition reduction rejects cross-run, duplicate, stale, and out-of-order events", () => {
  const cursor = {
    workflowId: "workflow-1",
    workflowRevision: 1,
    runId: "run-current",
    lastSequence: 0,
  };
  const transition = (overrides: Partial<WorkflowNodeRunTransition> = {}) => ({
    workflowId: "workflow-1",
    workflowRevision: 1,
    runId: "run-current",
    nodeId: "node-a",
    status: "running" as const,
    sequence: 1,
    ...overrides,
  });
  const accepted = reduceWorkflowRunTransition(cursor, transition());
  assert.equal(accepted.lastSequence, 1);
  assert.equal(reduceWorkflowRunTransition(accepted, transition()), accepted);
  assert.equal(reduceWorkflowRunTransition(accepted, transition({ sequence: 3 })), accepted);
  assert.equal(
    reduceWorkflowRunTransition(accepted, transition({ runId: "run-stale", sequence: 2 })),
    accepted,
  );
  assert.equal(
    reduceWorkflowRunTransition(accepted, transition({ workflowRevision: 2, sequence: 2 })),
    accepted,
  );
});
