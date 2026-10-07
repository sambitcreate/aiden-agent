import assert from "node:assert/strict";
import test from "node:test";
import type { OutputRef } from "../../../renderer/shared/images/run-types.js";
import type { WorkflowDocV1, WorkflowEdge, WorkflowNode } from "../../../renderer/shared/images/schema.js";
import { planRun, runPlan, staleNodeIds, summarizeRunState, type PlanContext, type StepOutcome, type StepTransition } from "./scheduler-core.js";

const MODEL = { provider: "openrouter", id: "google/gemini-3.1-flash-image" };
const ref = (seed: string): OutputRef => ({ assetId: seed.repeat(64), width: 8, height: 8, mediaType: "image/png" });
const at = { x: 0, y: 0 };
const prompt = (id: string, text = `prompt ${id}`): WorkflowNode => ({ id, type: "prompt", position: at, data: { text } });
const generate = (id: string): WorkflowNode => ({ id, type: "generate-image", position: at, data: { model: MODEL, count: 1 } });
const input = (id: string, seed: string): WorkflowNode => ({ id, type: "image-input", position: at, data: { assetId: seed.repeat(64) } });
const output = (id: string): WorkflowNode => ({ id, type: "output", position: at, data: {} });
const edge = (source: string, sourcePort: string, target: string, targetPort: string): WorkflowEdge =>
  ({ id: `${source}-${target}-${targetPort}`, source, sourcePort, target, targetPort });
const doc = (nodes: WorkflowNode[], edges: WorkflowEdge[]): WorkflowDocV1 =>
  ({ schemaVersion: 1, id: "wf", title: "T", revision: 1, createdAt: 0, updatedAt: 0, nodes, edges, settings: { concurrency: 2 } });
const context = (overrides: Partial<PlanContext> = {}): PlanContext => ({
  priorOutputs: {},
  asset: (assetId) => ({ assetId, width: 8, height: 8, mediaType: "image/png" }),
  maxRequests: 4,
  ...overrides,
});

// p1 → g1 → o1, image i → g1 refs, p2 → g2, g1 → g2 refs, g2 → o2
const graph = doc(
  [prompt("p1"), input("i", "a"), generate("g1"), output("o1"), prompt("p2"), generate("g2"), output("o2")],
  [
    edge("p1", "text", "g1", "prompt"),
    edge("i", "image", "g1", "references"),
    edge("g1", "images", "o1", "images"),
    edge("p2", "text", "g2", "prompt"),
    edge("g1", "images", "g2", "references"),
    edge("g2", "images", "o2", "images"),
  ],
);

test("a run-all plan lists one request per Generate node with its references", () => {
  const result = planRun(graph, { kind: "all" }, context());
  assert.ok(result.ok);
  assert.deepEqual(result.plan.steps.map((step) => step.nodeId), ["p1", "i", "g1", "o1", "p2", "g2", "o2"]);
  assert.deepEqual(
    result.plan.requests.map((request) => [request.nodeId, request.provider, request.model, request.referenceCount, request.pendingReferenceCount]),
    [["g1", "openrouter", MODEL.id, 1, 0], ["g2", "openrouter", MODEL.id, 1, 1]],
  );
  assert.deepEqual(result.plan.requests[0]?.knownReferences, [ref("a")]);
});

test("run from here runs the node and its descendants and seeds upstream Generate output", () => {
  const missing = planRun(graph, { kind: "from-node", nodeId: "g2" }, context());
  assert.deepEqual(missing.ok ? [] : missing.issues.map((issue) => [issue.code, issue.nodeId]), [["upstream_not_run", "g1"]]);

  const seeded = planRun(graph, { kind: "from-node", nodeId: "g2" }, context({ priorOutputs: { g1: [ref("b")] } }));
  assert.ok(seeded.ok);
  assert.deepEqual(seeded.plan.steps.map((step) => step.nodeId), ["p2", "g2", "o2"]);
  assert.deepEqual(seeded.plan.requests.map((request) => [request.nodeId, request.referenceCount, request.pendingReferenceCount]), [["g2", 1, 0]]);
  assert.deepEqual(seeded.plan.seeded.g1, { kind: "images", images: [ref("b")] });
});

test("node-only plans run one Generate node, and the cap counts each scope's own requests", () => {
  const missing = planRun(graph, { kind: "node-only", nodeId: "g2" }, context());
  assert.deepEqual(missing.ok ? [] : missing.issues.map((issue) => [issue.code, issue.nodeId]), [["upstream_not_run", "g1"]]);

  // Free upstream nodes are recomputed; nothing after g1 is planned.
  const first = planRun(graph, { kind: "node-only", nodeId: "g1" }, context());
  assert.ok(first.ok);
  assert.deepEqual(first.plan.steps.map((step) => step.nodeId), ["p1", "i", "g1"]);
  assert.deepEqual(first.plan.requests.map((request) => request.nodeId), ["g1"]);

  const alone = planRun(graph, { kind: "node-only", nodeId: "g2" }, context({ priorOutputs: { g1: [ref("b")] } }));
  assert.ok(alone.ok);
  assert.deepEqual(alone.plan.steps.map((step) => step.nodeId), ["p2", "g2"]);
  assert.deepEqual(alone.plan.seeded.g1, { kind: "images", images: [ref("b")] });
  // The same node run from here also carries its Output node.
  const fromHere = planRun(graph, { kind: "from-node", nodeId: "g2" }, context({ priorOutputs: { g1: [ref("b")] } }));
  assert.deepEqual(fromHere.ok ? fromHere.plan.steps.map((step) => step.nodeId) : [], ["p2", "g2", "o2"]);

  const notGenerate = planRun(graph, { kind: "node-only", nodeId: "o1" }, context());
  assert.deepEqual(notGenerate.ok ? [] : notGenerate.issues.map((issue) => [issue.code, issue.nodeId]), [["node_only_requires_generate", "o1"]]);
  const unknown = planRun(graph, { kind: "node-only", nodeId: "gone" }, context());
  assert.deepEqual(unknown.ok ? [] : unknown.issues.map((issue) => issue.code), ["unknown_scope"]);

  // Five Generate nodes in a chain: from the first that is 5 requests, on its own it is 1.
  const ids = ["a", "b", "c", "d", "e"];
  const chain = doc(
    [prompt("p"), ...ids.map((id) => generate(id))],
    [
      ...ids.map((id) => edge("p", "text", id, "prompt")),
      ...ids.slice(1).map((id, index) => edge(ids[index]!, "images", id, "references")),
    ],
  );
  const capped = planRun(chain, { kind: "from-node", nodeId: "a" }, context());
  assert.deepEqual(capped.ok ? [] : capped.issues.map((issue) => issue.code), ["request_cap"]);
  const single = planRun(chain, { kind: "node-only", nodeId: "a" }, context());
  assert.ok(single.ok);
  assert.equal(single.plan.requests.length, 1);
  const tail = planRun(chain, { kind: "from-node", nodeId: "c" }, context({ priorOutputs: { b: [ref("b")] } }));
  assert.ok(tail.ok);
  assert.equal(tail.plan.requests.length, 3);
});

test("staleNodeIds marks outputs older than a newer upstream Generate result and ignores local nodes", () => {
  // Attempt row ids from one run-all, in plan order.
  const all = { p1: 1, i: 2, g1: 3, o1: 4, p2: 5, g2: 6, o2: 7 };
  assert.deepEqual(staleNodeIds(graph, all), []);
  // Node-only re-run of g1 (row 9): its Output, the node that takes its images as references, and that node's Output are out of date.
  assert.deepEqual(staleNodeIds(graph, { ...all, g1: 9 }).sort(), ["g2", "o1", "o2"]);
  // Free local nodes are recomputed by every run; that alone makes nothing stale.
  assert.deepEqual(staleNodeIds(graph, { ...all, p1: 10, i: 10 }), []);
  // A node that never produced an output is not stale, it just has not run.
  assert.deepEqual(staleNodeIds(graph, { p1: 1, i: 2, g1: 9 }), []);
  // Run from here: g1 and everything after it re-ran, so nothing is out of date.
  assert.deepEqual(staleNodeIds(graph, { ...all, g1: 9, o1: 10, g2: 11, o2: 12 }), []);
});

test("plans over the request cap, without requests, or with missing assets are refused", () => {
  const five = doc(
    [prompt("p"), ...["a", "b", "c", "d", "e"].map((id) => generate(id))],
    ["a", "b", "c", "d", "e"].map((id) => edge("p", "text", id, "prompt")),
  );
  const capped = planRun(five, { kind: "all" }, context());
  assert.deepEqual(capped.ok ? [] : capped.issues.map((issue) => issue.code), ["request_cap"]);
  assert.match(capped.ok ? "" : capped.issues[0]!.message, /5 image requests.*at most 4/u);

  const none = planRun(doc([prompt("p")], []), { kind: "all" }, context());
  assert.deepEqual(none.ok ? [] : none.issues.map((issue) => issue.code), ["no_requests"]);

  const gone = planRun(graph, { kind: "all" }, context({ asset: () => undefined }));
  assert.deepEqual(gone.ok ? [] : gone.issues.map((issue) => [issue.code, issue.nodeId]), [["missing_asset", "i"]]);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}
const images = (seed: string): StepOutcome => ({ ok: true, value: { kind: "images", images: [ref(seed)] } });

test("dispatch honors the concurrency limit and resolves local nodes inline", async () => {
  const four = doc(
    [prompt("p"), ...["a", "b", "c", "d"].map((id) => generate(id))],
    ["a", "b", "c", "d"].map((id) => edge("p", "text", id, "prompt")),
  );
  const planned = planRun(four, { kind: "all" }, context());
  assert.ok(planned.ok);
  let running = 0;
  let peak = 0;
  const prompts: string[] = [];
  const states = await runPlan(planned.plan, {
    concurrency: 2,
    signal: new AbortController().signal,
    onSettled: () => undefined,
    executeProvider: async (step, inputs) => {
      prompts.push(inputs.prompt);
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setImmediate(resolve));
      running -= 1;
      return images(step.nodeId);
    },
  });
  assert.equal(peak, 2);
  assert.deepEqual(prompts, ["prompt p", "prompt p", "prompt p", "prompt p"]);
  assert.deepEqual([...states.values()], ["succeeded", "succeeded", "succeeded", "succeeded", "succeeded"]);
  assert.equal(summarizeRunState(planned.plan, states, false), "succeeded");
});

test("a failure skips only its descendants and independent branches continue", async () => {
  const planned = planRun(graph, { kind: "all" }, context());
  assert.ok(planned.ok);
  const states = await runPlan(planned.plan, {
    concurrency: 2,
    signal: new AbortController().signal,
    onSettled: () => undefined,
    executeProvider: async (step) => (step.nodeId === "g1" ? { ok: false, state: "failed" } : images(step.nodeId)),
  });
  assert.deepEqual(Object.fromEntries(states), {
    p1: "succeeded", i: "succeeded", p2: "succeeded", g1: "failed", o1: "skipped", g2: "skipped", o2: "skipped",
  });
  assert.equal(summarizeRunState(planned.plan, states, false), "failed");
});

test("abort cancels steps that have not started and keeps a result that settles first", async () => {
  const two = doc(
    [prompt("p"), generate("a"), generate("b")],
    [edge("p", "text", "a", "prompt"), edge("p", "text", "b", "prompt")],
  );
  const planned = planRun(two, { kind: "all" }, context());
  assert.ok(planned.ok);
  const controller = new AbortController();
  const first = deferred<StepOutcome>();
  const called: string[] = [];
  const done = runPlan(planned.plan, {
    concurrency: 1,
    signal: controller.signal,
    onSettled: () => undefined,
    executeProvider: (step) => {
      called.push(step.nodeId);
      return first.promise;
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort("user-cancel");
  first.resolve(images("a"));
  const states = await done;
  assert.deepEqual(called, ["a"]);
  assert.deepEqual(Object.fromEntries(states), { p: "succeeded", a: "succeeded", b: "cancelled" });
  assert.equal(summarizeRunState(planned.plan, states, true), "cancelled");
});

test("transitions are coalesced: each scheduler tick reports once", async () => {
  const small = doc(
    [prompt("p"), input("i", "a"), generate("g"), output("o")],
    [edge("p", "text", "g", "prompt"), edge("i", "image", "g", "references"), edge("g", "images", "o", "images")],
  );
  const planned = planRun(small, { kind: "all" }, context());
  assert.ok(planned.ok);
  const batches: StepTransition[][] = [];
  await runPlan(planned.plan, {
    concurrency: 2,
    signal: new AbortController().signal,
    onSettled: (transitions) => batches.push(transitions),
    executeProvider: async (step, inputs) => {
      assert.deepEqual(inputs.references, [ref("a")]);
      return images(step.nodeId);
    },
  });
  assert.deepEqual(
    batches.map((batch) => batch.map((transition) => [transition.nodeId, transition.state, transition.executed])),
    [
      [["p", "succeeded", false], ["i", "succeeded", false]],
      [["g", "succeeded", true], ["o", "succeeded", false]],
    ],
  );
  assert.deepEqual(batches[1]?.[1]?.value, { kind: "images", images: [ref("g")] });
});
