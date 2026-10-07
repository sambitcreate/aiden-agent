import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { Usage } from "@earendil-works/pi-ai";
import type { ImageGenerationRequest, ImageGenerationResult } from "../../../renderer/shared/images/port.js";
import type { OutputRef, RunScope } from "../../../renderer/shared/images/run-types.js";
import type { WorkflowDocV1, WorkflowEdge, WorkflowNode } from "../../../renderer/shared/images/schema.js";
import { StudioAssetStore } from "../studio-assets/store.js";
import { fakeThumbnailer, pngBytes } from "../studio-assets/test-fixture.js";
import { executeRun, type RunExecutorDependencies } from "./run-executor.js";
import { ImageRunLedger } from "./run-ledger.js";
import { planRun } from "./scheduler-core.js";

const MODEL = { provider: "openrouter", id: "google/gemini-3.1-flash-image" };
const at = { x: 0, y: 0 };
const usage = (total: number): Usage => ({
  input: 10, output: 1290, cacheRead: 0, cacheWrite: 0, totalTokens: 1300,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
});
const generated = (seed: number, count = 1): ImageGenerationResult => ({
  kind: "images",
  truncated: false,
  usage: usage(0.039),
  images: Array.from({ length: count }, (_, index) => ({ mimeType: "image/png", bytes: pngBytes(16, 16, seed * 10 + index), width: 16, height: 16 })),
});

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-image-executor-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const assets = new StudioAssetStore({ root: () => path.join(root, "assets"), thumbnailer: fakeThumbnailer().thumbnailer });
  await assets.initialize();
  t.after(() => assets.close());
  const ledger = ImageRunLedger.open({ directory: path.join(root, "runs") });
  t.after(() => ledger.close());
  return { assets, ledger };
}

function workflow(nodes: WorkflowNode[], edges: WorkflowEdge[]): WorkflowDocV1 {
  return { schemaVersion: 1, id: "wf", title: "T", revision: 1, createdAt: 0, updatedAt: 0, nodes, edges, settings: { concurrency: 1 } };
}
const prompt = (id: string): WorkflowNode => ({ id, type: "prompt", position: at, data: { text: `prompt ${id}` } });
const gen = (id: string): WorkflowNode => ({ id, type: "generate-image", position: at, data: { model: MODEL, count: 1 } });
const out = (id: string): WorkflowNode => ({ id, type: "output", position: at, data: {} });
const link = (source: string, sourcePort: string, target: string, targetPort: string): WorkflowEdge =>
  ({ id: `${source}-${target}-${targetPort}`, source, sourcePort, target, targetPort });

async function start(
  env: Awaited<ReturnType<typeof fixture>>,
  doc: WorkflowDocV1,
  reply: (request: ImageGenerationRequest, index: number) => Promise<ImageGenerationResult> | ImageGenerationResult,
  options: {
    requestLimit?: number;
    controller?: AbortController;
    concurrency?: number;
    runId?: string;
    scope?: RunScope;
    priorOutputs?: Readonly<Record<string, readonly OutputRef[]>>;
    ledger?: RunExecutorDependencies["ledger"];
  } = {},
) {
  const scope = options.scope ?? { kind: "all" };
  const runId = options.runId ?? "run-1";
  const planned = planRun(doc, scope, {
    priorOutputs: options.priorOutputs ?? {},
    asset: (assetId) => {
      const record = env.assets.get(assetId);
      return record && { assetId, width: record.width, height: record.height, mediaType: record.mediaType };
    },
    maxRequests: 4,
  });
  assert.ok(planned.ok, planned.ok ? "" : JSON.stringify(planned.issues));
  const calls: ImageGenerationRequest[] = [];
  env.ledger.createRun({
    runId,
    workflowId: doc.id,
    workflowRevision: doc.revision,
    scope,
    requestLimit: options.requestLimit ?? planned.plan.requests.length,
    attempts: planned.plan.steps.map((step) => ({ nodeId: step.nodeId, variant: step.variant, ...(step.provider ? { provider: step.provider.provider, model: step.provider.model } : {}) })),
  });
  const controller = options.controller ?? new AbortController();
  const done = executeRun(
    {
      ledger: options.ledger ?? env.ledger,
      assets: env.assets,
      onChange: () => undefined,
      port: { generate: async (request) => { calls.push(request); return reply(request, calls.length - 1); } },
    },
    { runId, plan: planned.plan, concurrency: options.concurrency ?? 1, signal: controller.signal },
  );
  return { calls, done, controller };
}

const attempts = (env: Awaited<ReturnType<typeof fixture>>, runId = "run-1") =>
  new Map(env.ledger.snapshot(runId)!.attempts.map((attempt) => [attempt.nodeId, attempt]));

test("a Generate step stores validated outputs held by the run, and Output shows them", async (t) => {
  const env = await fixture(t);
  const run = await start(env, workflow([prompt("p"), gen("g"), out("o")], [link("p", "text", "g", "prompt"), link("g", "images", "o", "images")]), () => generated(1));
  assert.equal(await run.done, "succeeded");
  assert.deepEqual(run.calls.map((call) => [call.provider, call.model, call.prompt, call.references.length]), [["openrouter", MODEL.id, "prompt p", 0]]);
  const byNode = attempts(env);
  const output = byNode.get("g")!.output;
  assert.equal(output.length, 1);
  assert.deepEqual(byNode.get("o")!.output, output);
  assert.deepEqual([byNode.get("g")!.costUsd, byNode.get("g")!.costStatus], [0.039, "reported"]);
  assert.deepEqual(env.assets.holders(output[0]!.assetId), [{ kind: "images-run", id: "run-1" }]);
  assert.equal(env.ledger.snapshot("run-1")!.run.requestsSent, 1);
});

test("a node-only run sends exactly one provider request and records only its own steps", async (t) => {
  const env = await fixture(t);
  const doc = workflow(
    [prompt("p"), gen("a"), gen("b"), out("o")],
    [link("p", "text", "a", "prompt"), link("p", "text", "b", "prompt"), link("a", "images", "b", "references"), link("b", "images", "o", "images")],
  );
  const first = await start(env, doc, () => generated(6));
  assert.equal(await first.done, "succeeded");
  assert.equal(first.calls.length, 2);
  const before = attempts(env);

  const second = await start(env, doc, () => generated(7), {
    runId: "run-2",
    scope: { kind: "node-only", nodeId: "b" },
    priorOutputs: { a: before.get("a")!.output },
  });
  assert.equal(await second.done, "succeeded");
  assert.equal(second.calls.length, 1);
  assert.equal(second.calls[0]?.references.length, 1, "a's previous image is reused as b's reference");
  const redo = attempts(env, "run-2");
  assert.deepEqual([...redo.keys()], ["p", "b"]);
  assert.equal(redo.get("b")!.state, "succeeded");
  const summary = env.ledger.snapshot("run-2")!.run;
  assert.deepEqual([summary.requestsSent, summary.requestLimit, summary.scope], [1, 1, { kind: "node-only", nodeId: "b" }]);
  // Nothing downstream was touched: o still holds the image from the first run.
  assert.deepEqual(env.ledger.latestOutputs("wf").o, before.get("o")!.output);
  assert.notDeepEqual(env.ledger.latestOutputs("wf").b, before.get("b")!.output);
});

test("Image Input references reach the provider as the stored bytes", async (t) => {
  const env = await fixture(t);
  const bytes = pngBytes(12, 12, 3);
  const asset = await env.assets.put({ bytes });
  const doc = workflow(
    [prompt("p"), { id: "i", type: "image-input", position: at, data: { assetId: asset.assetId } }, gen("g")],
    [link("p", "text", "g", "prompt"), link("i", "image", "g", "references")],
  );
  const run = await start(env, doc, () => generated(2));
  await run.done;
  assert.equal(run.calls[0]?.references[0]?.mimeType, "image/png");
  assert.deepEqual([...run.calls[0]!.references[0]!.bytes], [...bytes]);
});

test("the run's request counter refuses a provider call beyond its limit", async (t) => {
  const env = await fixture(t);
  const doc = workflow([prompt("p"), gen("a"), gen("b")], [link("p", "text", "a", "prompt"), link("p", "text", "b", "prompt")]);
  const run = await start(env, doc, () => generated(3), { requestLimit: 1 });
  assert.equal(await run.done, "partial");
  assert.equal(run.calls.length, 1);
  const refused = attempts(env).get("b")!;
  assert.deepEqual([refused.state, refused.errorCode, refused.mayHaveBeenBilled], ["failed", "request-limit", false]);
});

test("cancel aborts the in-flight request, never starts queued ones and records may-have-been-billed", async (t) => {
  const env = await fixture(t);
  const doc = workflow([prompt("p"), gen("a"), gen("b")], [link("p", "text", "a", "prompt"), link("p", "text", "b", "prompt")]);
  const run = await start(env, doc, (request) =>
    new Promise((resolve) => request.signal.addEventListener("abort", () => resolve({ kind: "failed", code: "aborted", message: "Cancelled." }))),
  );
  while (run.calls.length === 0) await new Promise((resolve) => setImmediate(resolve));
  run.controller.abort("user-cancel");
  assert.equal(await run.done, "cancelled");
  assert.equal(run.calls.length, 1);
  const byNode = attempts(env);
  assert.deepEqual([byNode.get("a")!.state, byNode.get("a")!.mayHaveBeenBilled], ["cancelled", true]);
  assert.deepEqual([byNode.get("b")!.state, byNode.get("b")!.mayHaveBeenBilled], ["cancelled", false]);
  assert.equal(env.ledger.snapshot("run-1")!.run.endReason, "user-cancel");
  assert.equal(env.ledger.snapshot("run-1")!.run.requestsSent, 1, "the queued request was never claimed");
});

test("a result that settles before the abort is observed is kept and marked cancel-requested", async (t) => {
  const env = await fixture(t);
  let finish!: (result: ImageGenerationResult) => void;
  const run = await start(env, workflow([prompt("p"), gen("g")], [link("p", "text", "g", "prompt")]), () => new Promise((resolve) => (finish = resolve)));
  while (run.calls.length === 0) await new Promise((resolve) => setImmediate(resolve));
  env.ledger.requestCancel("run-1");
  run.controller.abort("user-cancel");
  finish(generated(4));
  await run.done;
  const kept = attempts(env).get("g")!;
  assert.deepEqual([kept.state, kept.cancelRequested, kept.output.length], ["succeeded", true, 1]);
});

test("more than four references fail locally without a provider request", async (t) => {
  const env = await fixture(t);
  const extra = await env.assets.put({ bytes: pngBytes(10, 10, 9) });
  const doc = workflow(
    [prompt("p"), gen("first"), { id: "i", type: "image-input", position: at, data: { assetId: extra.assetId } }, gen("second")],
    [
      link("p", "text", "first", "prompt"),
      link("p", "text", "second", "prompt"),
      link("first", "images", "second", "references"),
      link("i", "image", "second", "references"),
    ],
  );
  // The first node returns four images; with the Image Input that is five references.
  const run = await start(env, doc, () => generated(5, 4));
  assert.equal(await run.done, "partial");
  assert.equal(run.calls.length, 1);
  const refused = attempts(env).get("second")!;
  assert.deepEqual([refused.state, refused.errorCode, refused.mayHaveBeenBilled], ["failed", "too-many-references", false]);
});

test("output the asset store rejects fails as output-invalid and is still marked billed", async (t) => {
  const env = await fixture(t);
  const run = await start(env, workflow([prompt("p"), gen("g")], [link("p", "text", "g", "prompt")]), () => ({
    kind: "images",
    truncated: false,
    usage: usage(0.02),
    images: [{ mimeType: "image/png", bytes: new Uint8Array([1, 2, 3]), width: 1, height: 1 }],
  }));
  assert.equal(await run.done, "failed");
  const failed = attempts(env).get("g")!;
  assert.deepEqual([failed.state, failed.errorCode, failed.mayHaveBeenBilled, failed.costUsd], ["failed", "output-invalid", true, 0.02]);
});

test("a failed or faulting provider request is never retried by the executor", async (t) => {
  const env = await fixture(t);
  const doc = workflow([prompt("p"), gen("a"), gen("b")], [link("p", "text", "a", "prompt"), link("p", "text", "b", "prompt")]);
  // Plenty of request headroom: only the executor's own choice stops a second call.
  const run = await start(env, doc, (_request, index) => {
    if (index === 0) return { kind: "failed", code: "provider-error", message: "Upstream said no." };
    throw new Error("port broke its never-throws contract");
  }, { requestLimit: 4 });
  assert.equal(await run.done, "failed");
  assert.equal(run.calls.length, 2, "one call per Generate node, none repeated");
  assert.equal(env.ledger.snapshot("run-1")!.run.requestsSent, 2);
  const byNode = attempts(env);
  assert.deepEqual([byNode.get("a")!.state, byNode.get("a")!.errorCode, byNode.get("a")!.mayHaveBeenBilled], ["failed", "provider-error", true]);
  assert.deepEqual([byNode.get("b")!.state, byNode.get("b")!.mayHaveBeenBilled], ["failed", true]);
});

test("the run is finished only once every attempt is terminal; otherwise it is terminated", async (t) => {
  const env = await fixture(t);
  const doc = workflow([prompt("p"), gen("g"), out("o")], [link("p", "text", "g", "prompt"), link("g", "images", "o", "images")]);
  const calls: string[] = [];
  const tracking: RunExecutorDependencies["ledger"] = {
    claimProviderRequest: (...args) => env.ledger.claimProviderRequest(...args),
    snapshot: (runId) => env.ledger.snapshot(runId),
    finishAttempts: (updates) => env.ledger.finishAttempts(updates),
    finishRun: (...args) => { calls.push("finishRun"); env.ledger.finishRun(...args); },
    terminateRun: (...args) => { calls.push("terminateRun"); env.ledger.terminateRun(...args); },
  };
  const clean = await start(env, doc, () => generated(8), { ledger: tracking });
  assert.equal(await clean.done, "succeeded");
  assert.deepEqual(calls, ["finishRun"]);
  assert.equal(env.ledger.snapshot("run-1")!.run.state, "succeeded");

  // A lost write leaves Output queued: finishing the run would hide a live attempt.
  calls.length = 0;
  const lossy: RunExecutorDependencies["ledger"] = {
    ...tracking,
    finishAttempts: (updates) => env.ledger.finishAttempts(updates.filter((update) => update.nodeId !== "o")),
  };
  const faulty = await start(env, doc, () => generated(9), { runId: "run-2", ledger: lossy });
  assert.equal(await faulty.done, "failed");
  assert.deepEqual(calls, ["terminateRun"]);
  const snapshot = env.ledger.snapshot("run-2")!;
  assert.equal(snapshot.run.state, "failed");
  assert.equal(snapshot.run.endReason, "executor-fault");
  assert.ok(snapshot.attempts.every((attempt) => attempt.state !== "queued" && attempt.state !== "running"));
  assert.equal(snapshot.attempts.find((attempt) => attempt.nodeId === "g")!.state, "succeeded");
});

test("a cancel that lands just before the claim sends nothing and records a cancel, not a spent budget", async (t) => {
  const env = await fixture(t);
  const doc = workflow([prompt("p"), gen("g")], [link("p", "text", "g", "prompt")]);
  const controller = new AbortController();
  const racing: RunExecutorDependencies["ledger"] = {
    claimProviderRequest: (...args) => {
      env.ledger.requestCancel(args[0]);
      controller.abort("user-cancel");
      return env.ledger.claimProviderRequest(...args);
    },
    snapshot: (runId) => env.ledger.snapshot(runId),
    finishAttempts: (updates) => env.ledger.finishAttempts(updates),
    finishRun: (...args) => env.ledger.finishRun(...args),
    terminateRun: (...args) => env.ledger.terminateRun(...args),
  };
  const run = await start(env, doc, () => generated(10), { controller, ledger: racing });
  assert.equal(await run.done, "cancelled");
  assert.equal(run.calls.length, 0);
  const attempt = attempts(env).get("g")!;
  assert.deepEqual([attempt.state, attempt.mayHaveBeenBilled, attempt.errorCode], ["cancelled", false, undefined]);
  assert.equal(env.ledger.snapshot("run-1")!.run.requestsSent, 0);
});
