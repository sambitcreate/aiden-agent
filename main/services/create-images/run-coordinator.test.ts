import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { RunScope, RunSnapshot } from "../../../renderer/shared/images/run-types.js";
import type { WorkflowDocV1 } from "../../../renderer/shared/images/schema.js";
import { StudioAssetStore } from "../studio-assets/store.js";
import { fakeThumbnailer, pngBytes } from "../studio-assets/test-fixture.js";
import { createPiImageGenerationPort } from "./image-port.js";
import { ImageRunCoordinator } from "./run-coordinator.js";
import { ImageRunLedger } from "./run-ledger.js";
import { fakeImageModels, generateChains, NANO_BANANA, saveWorkflow, until, type FakeImageReply } from "./test-fixture.js";
import { ImageWorkflowStore } from "./workflow-store.js";

const OWNER = "1:document-a";
const OTHER = "1:document-b";

interface FixtureOptions {
  reply?: (index: number) => FakeImageReply;
  now?: () => number;
  throttleMs?: number;
  maxRequestsPerRun?: number;
  retainRuns?: number;
  /** Rewrites every document the coordinator loads, as a store that does not enforce the schema's limits would. */
  alterDocument?: (doc: WorkflowDocV1) => WorkflowDocV1;
  /** Holds every workflow delete until it resolves, to observe the window in which a delete is in flight. */
  beforeDelete?: () => Promise<void>;
  /** Wraps the real ledger, e.g. to make one write fail. */
  wrapLedger?: (ledger: ImageRunLedger) => ImageRunLedger;
}

async function fixture(t: TestContext, options: FixtureOptions = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-image-coordinator-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const assets = new StudioAssetStore({ root: () => path.join(root, "assets"), thumbnailer: fakeThumbnailer().thumbnailer });
  await assets.initialize();
  const workflows = new ImageWorkflowStore({ root: () => path.join(root, "create-images"), assets });
  await workflows.initialize();
  const fake = fakeImageModels(options.reply ? { reply: (_call, index) => options.reply!(index) } : {});
  const snapshots: RunSnapshot[] = [];
  const issues: string[] = [];
  const realLedger = ImageRunLedger.open({ directory: path.join(root, "create-images") });
  const ledger = options.wrapLedger ? options.wrapLedger(realLedger) : realLedger;
  const alter = options.alterDocument ?? (options.beforeDelete ? (doc: WorkflowDocV1) => doc : undefined);
  const coordinator = new ImageRunCoordinator({
    ledger,
    port: createPiImageGenerationPort({ models: fake.models, providerLabel: (id) => (id === "openrouter" ? "OpenRouter" : id) }),
    assets,
    workflows: alter
      ? {
          get: async (id) => {
            const doc = await workflows.get(id);
            return doc && alter(structuredClone(doc));
          },
          delete: async (id) => {
            await options.beforeDelete?.();
            return workflows.delete(id);
          },
          imageInputAssets: () => workflows.imageInputAssets(),
        }
      : workflows,
    notify: (snapshot) => snapshots.push(snapshot),
    reportIssue: (message) => void issues.push(message),
    throttleMs: options.throttleMs ?? 0,
    ...(options.now ? { now: options.now } : {}),
    ...(options.maxRequestsPerRun !== undefined ? { maxRequestsPerRun: options.maxRequestsPerRun } : {}),
    ...(options.retainRuns !== undefined ? { retainRuns: options.retainRuns } : {}),
  });
  t.after(async () => {
    fake.release();
    await coordinator.whenIdle();
    await coordinator.shutdown("test-end");
    await assets.close();
  });
  return { workflows, fake, coordinator, snapshots, assets, issues, ledger: realLedger };
}

async function prepared(env: Awaited<ReturnType<typeof fixture>>, doc: { id: string; revision: number }, owner = OWNER) {
  const result = await env.coordinator.prepare(owner, { workflowId: doc.id, revision: doc.revision, scope: { kind: "all" } });
  if (!("plan" in result)) assert.fail(`prepare returned issues: ${JSON.stringify(result.issues)}`);
  return result.plan;
}

test("prepare sends nothing; start sends exactly the consented requests", async (t) => {
  const env = await fixture(t);
  const doc = await saveWorkflow(env.workflows, generateChains(2));
  const plan = await prepared(env, doc);
  assert.equal(env.fake.calls.length, 0);
  assert.equal(plan.totalRequests, 2);
  assert.deepEqual(plan.estimate, { kind: "unknown" });
  assert.equal(plan.expiresAt - plan.createdAt, 300_000);
  assert.deepEqual(
    plan.requests.map((request) => [request.providerLabel, request.modelLabel, request.referenceCount]),
    [["OpenRouter", "Google: Nano Banana 2 (Gemini 3.1 Flash Image)", 0], ["OpenRouter", "Google: Nano Banana 2 (Gemini 3.1 Flash Image)", 0]],
  );
  const started = await env.coordinator.start(OWNER, plan.consentId);
  assert.ok("runId" in started);
  await env.coordinator.whenIdle();
  assert.equal(env.fake.calls.length, 2);
  const snapshot = env.coordinator.getRun({ runId: started.runId })!;
  assert.equal(snapshot.run.state, "succeeded");
  assert.equal(snapshot.run.requestsSent, 2);
  assert.equal(snapshot.run.requestLimit, 2);
});

test("expired, foreign and replayed consents send nothing", async (t) => {
  let clock = 1_000_000;
  const env = await fixture(t, { now: () => clock });
  const doc = await saveWorkflow(env.workflows, generateChains(1));
  const first = await prepared(env, doc);
  assert.deepEqual(await env.coordinator.start(OTHER, first.consentId), { error: "expired" });
  clock += 300_000;
  assert.deepEqual(await env.coordinator.start(OWNER, first.consentId), { error: "expired" });
  const second = await prepared(env, doc);
  assert.ok("runId" in (await env.coordinator.start(OWNER, second.consentId)));
  assert.deepEqual(await env.coordinator.start(OWNER, second.consentId), { error: "expired" });
  await env.coordinator.whenIdle();
  assert.equal(env.fake.calls.length, 1);
});

test("an edit after consent, or a model that disappears, stops start without sending", async (t) => {
  const env = await fixture(t);
  const doc = await saveWorkflow(env.workflows, generateChains(1));
  const plan = await prepared(env, doc);
  assert.equal((await env.workflows.save(doc.id, doc.revision, { ...doc, title: "Edited" })).ok, true);
  assert.deepEqual(await env.coordinator.start(OWNER, plan.consentId), { error: "stale" });
  const edited = (await env.workflows.get(doc.id))!;
  const again = await prepared(env, edited);
  env.fake.models.deleteProvider("openrouter");
  assert.deepEqual(await env.coordinator.start(OWNER, again.consentId), { error: "model-unavailable" });
  assert.equal(env.fake.calls.length, 0);
});

test("the owner cap holds: a fifth Generate node is refused before any consent exists", async (t) => {
  const env = await fixture(t);
  const doc = await saveWorkflow(env.workflows, generateChains(5));
  const result = await env.coordinator.prepare(OWNER, { workflowId: doc.id, revision: doc.revision, scope: { kind: "all" } });
  assert.deepEqual("issues" in result ? result.issues.map((issue) => issue.code) : [], ["request_cap"]);
  assert.equal(env.fake.calls.length, 0);
});

test("a failed request is never retried without a fresh consent", async (t) => {
  const env = await fixture(t, { reply: (index) => (index === 0 ? { kind: "error", message: "Upstream 500" } : { kind: "images" }) });
  const doc = await saveWorkflow(env.workflows, generateChains(1));
  const first = await env.coordinator.start(OWNER, (await prepared(env, doc)).consentId);
  await env.coordinator.whenIdle();
  assert.ok("runId" in first);
  assert.equal(env.coordinator.getRun({ runId: first.runId })!.run.state, "failed");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(env.fake.calls.length, 1);
  const second = await env.coordinator.start(OWNER, (await prepared(env, doc)).consentId);
  await env.coordinator.whenIdle();
  assert.ok("runId" in second);
  assert.equal(env.coordinator.getRun({ runId: second.runId })!.run.state, "succeeded");
  assert.equal(env.fake.calls.length, 2);
});

test("cancel stops a request on the wire and records it as may-have-been-billed", async (t) => {
  const env = await fixture(t, { reply: () => ({ kind: "hold" }) });
  const doc = await saveWorkflow(env.workflows, generateChains(1));
  const started = await env.coordinator.start(OWNER, (await prepared(env, doc)).consentId);
  assert.ok("runId" in started);
  await until(() => env.coordinator.inFlightRequests() === 1, "the request to be in flight");
  assert.equal(env.coordinator.hasActiveRun(doc.id), true);
  assert.equal(env.coordinator.cancel(started.runId), true);
  await env.coordinator.whenIdle();
  const snapshot = env.coordinator.getRun({ workflowId: doc.id })!;
  assert.equal(snapshot.run.state, "cancelled");
  const generate = snapshot.attempts.find((attempt) => attempt.nodeId === "g1")!;
  assert.deepEqual([generate.state, generate.cancelRequested, generate.mayHaveBeenBilled], ["cancelled", true, true]);
  assert.equal(env.coordinator.inFlightRequests(), 0);
  assert.equal(env.coordinator.cancel(started.runId), false);
});

test("a run that finishes inside one throttle window publishes at most three versioned snapshots", async (t) => {
  // A window far longer than the run makes the bound independent of disk speed; the rule is the same at 250 ms.
  const env = await fixture(t, { throttleMs: 60_000 });
  const doc = await saveWorkflow(env.workflows, generateChains(4));
  const started = await env.coordinator.start(OWNER, (await prepared(env, doc)).consentId);
  await env.coordinator.whenIdle();
  assert.ok("runId" in started);
  // Initial, one throttled update and the terminal snapshot, despite 9 nodes changing state.
  assert.ok(env.snapshots.length >= 2 && env.snapshots.length <= 3, `got ${env.snapshots.length}`);
  const versions = env.snapshots.map((snapshot) => snapshot.version);
  assert.deepEqual(versions, [...versions].sort((left, right) => left - right));
  assert.equal(new Set(versions).size, versions.length);
  const last = env.snapshots[env.snapshots.length - 1]!;
  assert.equal(last.run.state, "succeeded");
  assert.equal(env.coordinator.getRun({ runId: started.runId })!.version, last.version);
});

/** p → g1 → g2 (g1's images as references) → o2. */
function twoStepChain(doc: WorkflowDocV1): WorkflowDocV1 {
  const at = { x: 0, y: 0 };
  doc.nodes = [
    { id: "p", type: "prompt", position: at, data: { text: "A red bicycle" } },
    { id: "g1", type: "generate-image", position: at, data: { model: { ...NANO_BANANA }, count: 1 as const } },
    { id: "g2", type: "generate-image", position: at, data: { model: { ...NANO_BANANA }, count: 1 as const } },
    { id: "o2", type: "output", position: at, data: {} },
  ];
  doc.edges = [
    { id: "e1", source: "p", sourcePort: "text", target: "g1", targetPort: "prompt" },
    { id: "e2", source: "p", sourcePort: "text", target: "g2", targetPort: "prompt" },
    { id: "e3", source: "g1", sourcePort: "images", target: "g2", targetPort: "references" },
    { id: "e4", source: "g2", sourcePort: "images", target: "o2", targetPort: "images" },
  ];
  return doc;
}

test("retry after a failure offers from-here and node-only, each with its own consent and exact request count", async (t) => {
  // Provider calls: 0 and 1 are run 1 (g1, g2); 2 is run 2's g1, which fails; the rest succeed.
  const env = await fixture(t, { reply: (index) => (index === 2 ? { kind: "error", message: "Upstream 500" } : { kind: "images" }) });
  const doc = await saveWorkflow(env.workflows, twoStepChain);
  const approve = async (scope: RunScope) => {
    const result = await env.coordinator.prepare(OWNER, { workflowId: doc.id, revision: doc.revision, scope });
    if (!("plan" in result)) assert.fail(`prepare returned issues: ${JSON.stringify(result.issues)}`);
    return result.plan;
  };

  await env.coordinator.start(OWNER, (await prepared(env, doc)).consentId);
  await env.coordinator.whenIdle();
  assert.equal(env.fake.calls.length, 2);

  // Run 2 fails at g1. g2 and o2 are skipped and still hold run 1's images; nothing is out of date yet.
  const failed = await env.coordinator.start(OWNER, (await prepared(env, doc)).consentId);
  await env.coordinator.whenIdle();
  assert.ok("runId" in failed);
  assert.equal(env.coordinator.getRun({ runId: failed.runId })!.run.state, "failed");
  assert.equal(env.fake.calls.length, 3);
  assert.deepEqual(env.coordinator.staleNodeIds(doc), []);

  // Both retry choices are offered, each with a separate consent and its own exact count. Preparing sends nothing.
  const fromHere = await approve({ kind: "from-node", nodeId: "g1" });
  const nodeOnly = await approve({ kind: "node-only", nodeId: "g1" });
  assert.deepEqual([fromHere.totalRequests, nodeOnly.totalRequests], [2, 1]);
  assert.deepEqual(fromHere.requests.map((request) => request.nodeId), ["g1", "g2"]);
  assert.deepEqual(nodeOnly.requests.map((request) => request.nodeId), ["g1"]);
  assert.notEqual(fromHere.consentId, nodeOnly.consentId);
  assert.equal(env.fake.calls.length, 3);

  // Retry this node only: one request, and the downstream nodes keep their old images but are out of date.
  const only = await env.coordinator.start(OWNER, nodeOnly.consentId);
  await env.coordinator.whenIdle();
  assert.ok("runId" in only);
  const onlyRun = env.coordinator.getRun({ runId: only.runId })!;
  assert.deepEqual([onlyRun.run.state, onlyRun.run.requestLimit, onlyRun.run.scope], ["succeeded", 1, { kind: "node-only", nodeId: "g1" }]);
  assert.deepEqual(onlyRun.attempts.map((attempt) => attempt.nodeId), ["p", "g1"]);
  assert.equal(env.fake.calls.length, 4);
  assert.deepEqual(env.coordinator.staleNodeIds(doc).sort(), ["g2", "o2"]);
  assert.equal(env.coordinator.latestOutputs(doc.id).o2?.length, 1);

  // Retry from here (a fresh consent): the node and everything after it run again, and nothing is out of date.
  const here = await env.coordinator.start(OWNER, (await approve({ kind: "from-node", nodeId: "g1" })).consentId);
  await env.coordinator.whenIdle();
  assert.ok("runId" in here);
  const hereRun = env.coordinator.getRun({ runId: here.runId })!;
  assert.deepEqual([hereRun.run.state, hereRun.run.requestLimit], ["succeeded", 2]);
  assert.deepEqual(hereRun.attempts.map((attempt) => attempt.nodeId), ["p", "g1", "g2", "o2"]);
  assert.equal(env.fake.calls.length, 6);
  assert.deepEqual(env.coordinator.staleNodeIds(doc), []);
});

test("the request cap holds for every scope", async (t) => {
  const env = await fixture(t);
  const ids = ["g1", "g2", "g3", "g4", "g5"];
  const doc = await saveWorkflow(env.workflows, (draft) => {
    const at = { x: 0, y: 0 };
    draft.nodes = [
      { id: "p", type: "prompt", position: at, data: { text: "A red bicycle" } },
      ...ids.map((id) => ({ id, type: "generate-image" as const, position: at, data: { model: { ...NANO_BANANA }, count: 1 as const } })),
    ];
    draft.edges = [
      ...ids.map((id) => ({ id: `p-${id}`, source: "p", sourcePort: "text", target: id, targetPort: "prompt" })),
      ...ids.slice(1).map((id, index) => ({ id: `${ids[index]}-${id}`, source: ids[index]!, sourcePort: "images", target: id, targetPort: "references" })),
    ];
    return draft;
  });
  const prepare = (scope: RunScope) => env.coordinator.prepare(OWNER, { workflowId: doc.id, revision: doc.revision, scope });
  for (const scope of [{ kind: "all" }, { kind: "from-node", nodeId: "g1" }] as const) {
    const refused = await prepare(scope);
    assert.deepEqual("issues" in refused ? refused.issues.map((issue) => issue.code) : [], ["request_cap"], scope.kind);
  }
  const single = await prepare({ kind: "node-only", nodeId: "g1" });
  assert.ok("plan" in single);
  assert.equal(single.plan.totalRequests, 1);
  assert.equal(env.fake.calls.length, 0);
  const started = await env.coordinator.start(OWNER, single.plan.consentId);
  await env.coordinator.whenIdle();
  assert.ok("runId" in started);
  assert.equal(env.coordinator.getRun({ runId: started.runId })!.run.requestLimit, 1);
  assert.equal(env.fake.calls.length, 1);
});

test("run from here reuses the latest upstream output and asks for a run when there is none", async (t) => {
  const env = await fixture(t);
  const at = { x: 0, y: 0 };
  const doc = await saveWorkflow(env.workflows, (draft) => ({
    ...draft,
    nodes: [
      { id: "p", type: "prompt", position: at, data: { text: "A red bicycle" } },
      { id: "g1", type: "generate-image", position: at, data: { model: { ...NANO_BANANA }, count: 1 as const } },
      { id: "g2", type: "generate-image", position: at, data: { model: { ...NANO_BANANA }, count: 1 as const } },
    ],
    edges: [
      { id: "e1", source: "p", sourcePort: "text", target: "g1", targetPort: "prompt" },
      { id: "e2", source: "p", sourcePort: "text", target: "g2", targetPort: "prompt" },
      { id: "e3", source: "g1", sourcePort: "images", target: "g2", targetPort: "references" },
    ],
  }));
  const fromHere = { workflowId: doc.id, revision: doc.revision, scope: { kind: "from-node", nodeId: "g2" } as const };
  const blocked = await env.coordinator.prepare(OWNER, fromHere);
  assert.deepEqual("issues" in blocked ? blocked.issues.map((issue) => [issue.code, issue.nodeId]) : [], [["upstream_not_run", "g1"]]);
  await env.coordinator.start(OWNER, (await prepared(env, doc)).consentId);
  await env.coordinator.whenIdle();
  const scoped = await env.coordinator.prepare(OWNER, fromHere);
  assert.ok("plan" in scoped);
  assert.equal(scoped.plan.totalRequests, 1);
  assert.equal(scoped.plan.requests[0]?.referenceCount, 1);
  assert.ok((scoped.plan.requests[0]?.referenceBytes ?? 0) > 0);
  await env.coordinator.start(OWNER, scoped.plan.consentId);
  await env.coordinator.whenIdle();
  assert.equal(env.fake.calls.length, 3);
  assert.equal(env.fake.calls[2]?.references, 1);
});

/** Resolves once exactly one request has reached the provider. */
function onTheWire(env: Pick<Awaited<ReturnType<typeof fixture>>, "coordinator" | "fake">) {
  return until(() => env.coordinator.inFlightRequests() === 1 && env.fake.calls.length === 1, "the request to be on the wire");
}

/** Wraps a ledger so individual methods can be replaced, as a failing disk would. */
function withLedgerOverrides(overrides: Partial<Record<keyof ImageRunLedger, (...args: never[]) => unknown>>) {
  return (ledger: ImageRunLedger): ImageRunLedger =>
    new Proxy(ledger, {
      get(target, property) {
        const replaced = overrides[property as keyof ImageRunLedger];
        if (replaced) return replaced;
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
}

test("the owner request cap cannot be raised by configuration", async (t) => {
  const env = await fixture(t, { maxRequestsPerRun: 9 });
  const doc = await saveWorkflow(env.workflows, generateChains(5));
  const result = await env.coordinator.prepare(OWNER, { workflowId: doc.id, revision: doc.revision, scope: { kind: "all" } });
  assert.deepEqual("issues" in result ? result.issues.map((issue) => issue.code) : [], ["request_cap"]);
  assert.equal(env.fake.calls.length, 0);
});

test("run concurrency is clamped to between one and four and defaults to two", async (t) => {
  const cases: [label: string, concurrency: number | undefined, expectedInFlight: number][] = [
    ["missing", undefined, 2],
    ["below range", -3, 1],
    ["above range", 9, 4],
  ];
  for (const [label, concurrency, expectedInFlight] of cases) {
    const env = await fixture(t, {
      reply: () => ({ kind: "hold" }),
      alterDocument: (doc) => ({ ...doc, settings: { concurrency: concurrency as number } }),
    });
    const doc = await saveWorkflow(env.workflows, generateChains(4));
    const started = await env.coordinator.start(OWNER, (await prepared(env, doc)).consentId);
    assert.ok("runId" in started, label);
    await until(() => env.coordinator.inFlightRequests() === expectedInFlight, `${label}: ${expectedInFlight} in flight`);
    for (let tick = 0; tick < 5; tick += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(env.coordinator.inFlightRequests(), expectedInFlight, label);
    assert.equal(env.fake.calls.length, expectedInFlight, label);
    env.coordinator.cancel(started.runId);
    await env.coordinator.whenIdle();
  }
});

test("cancel aborts the request and records the cancel in one synchronous step; a ledger failure is reported, not thrown", async (t) => {
  const env = await fixture(t, { reply: () => ({ kind: "hold" }) });
  const doc = await saveWorkflow(env.workflows, generateChains(1));
  const started = await env.coordinator.start(OWNER, (await prepared(env, doc)).consentId);
  assert.ok("runId" in started);
  await onTheWire(env);
  const signal = env.fake.calls[0]!.options!.signal!;
  assert.equal(signal.aborted, false);
  assert.equal(env.coordinator.cancel(started.runId), true);
  // No await since cancel(): both halves of the stop are already visible.
  assert.equal(signal.aborted, true);
  const attempt = env.ledger.snapshot(started.runId)!.attempts.find((entry) => entry.nodeId === "g1")!;
  assert.equal(attempt.cancelRequested, true);
  await env.coordinator.whenIdle();

  const broken = await fixture(t, {
    reply: () => ({ kind: "hold" }),
    wrapLedger: withLedgerOverrides({
      requestCancel: () => {
        throw new Error("disk full");
      },
    }),
  });
  const brokenDoc = await saveWorkflow(broken.workflows, generateChains(1));
  const brokenRun = await broken.coordinator.start(OWNER, (await prepared(broken, brokenDoc)).consentId);
  assert.ok("runId" in brokenRun);
  await onTheWire(broken);
  // The stop still lands, is reported rather than thrown, and the caller is told the run was stopped.
  assert.equal(broken.coordinator.cancel(brokenRun.runId), true);
  assert.equal(broken.fake.calls[0]!.options!.signal!.aborted, true);
  assert.equal(broken.issues.length, 1);
  await broken.coordinator.whenIdle();
});

test("only one run is active per workflow: concurrent starts, and a prepare during a run", async (t) => {
  const env = await fixture(t, { reply: () => ({ kind: "hold" }) });
  const doc = await saveWorkflow(env.workflows, generateChains(1));
  const [first, second] = [await prepared(env, doc), await prepared(env, doc)];
  const results = await Promise.all([env.coordinator.start(OWNER, first.consentId), env.coordinator.start(OWNER, second.consentId)]);
  assert.deepEqual(results.map((result) => ("runId" in result ? "started" : result.error)).sort(), ["stale", "started"]);
  const started = results.find((result): result is { runId: string } => "runId" in result)!;
  await onTheWire(env);
  assert.equal(env.fake.calls.length, 1);
  const during = await env.coordinator.prepare(OWNER, { workflowId: doc.id, revision: doc.revision, scope: { kind: "all" } });
  assert.deepEqual("issues" in during ? during.issues.map((issue) => issue.code) : [], ["run_in_progress"]);
  env.coordinator.cancel(started.runId);
  await env.coordinator.whenIdle();
  assert.equal(env.coordinator.hasActiveRun(doc.id), false);
  assert.ok("plan" in (await env.coordinator.prepare(OWNER, { workflowId: doc.id, revision: doc.revision, scope: { kind: "all" } })));
});

test("in-flight requests count only requests on the wire, not consents or queued steps", async (t) => {
  const env = await fixture(t, { reply: () => ({ kind: "hold" }), alterDocument: (doc) => ({ ...doc, settings: { concurrency: 1 } }) });
  const doc = await saveWorkflow(env.workflows, generateChains(2));
  const plan = await prepared(env, doc);
  assert.equal(env.coordinator.inFlightRequests(), 0);
  const started = await env.coordinator.start(OWNER, plan.consentId);
  assert.ok("runId" in started);
  await until(() => env.coordinator.inFlightRequests() === 1, "the first request");
  assert.equal(env.coordinator.inFlightRequests(), 1, "the second Generate step is queued, not sent");
  env.coordinator.cancel(started.runId);
  await env.coordinator.whenIdle();
  assert.equal(env.coordinator.inFlightRequests(), 0);
});

test("deleting a workflow is refused while a run is active, then removes its history and releases its holds", async (t) => {
  const env = await fixture(t, { reply: (index) => (index === 0 ? { kind: "hold" } : { kind: "images" }) });
  const doc = await saveWorkflow(env.workflows, generateChains(1));
  const started = await env.coordinator.start(OWNER, (await prepared(env, doc)).consentId);
  assert.ok("runId" in started);
  await onTheWire(env);
  assert.equal(await env.coordinator.deleteWorkflow(doc.id), "busy");
  assert.notEqual(await env.workflows.get(doc.id), null);
  env.coordinator.cancel(started.runId);
  await env.coordinator.whenIdle();

  // A finished run's output is held by its run; deleting the workflow drops the run and the hold.
  const second = await env.coordinator.start(OWNER, (await prepared(env, doc)).consentId);
  assert.ok("runId" in second);
  await env.coordinator.whenIdle();
  const output = env.coordinator.getRun({ runId: second.runId })!.attempts.find((entry) => entry.nodeId === "g1")!.output[0]!;
  assert.deepEqual(env.assets.holders(output.assetId), [{ kind: "images-run", id: second.runId }]);
  assert.equal(await env.coordinator.deleteWorkflow(doc.id), "deleted");
  assert.equal(await env.workflows.get(doc.id), null);
  assert.equal(env.coordinator.getRun({ runId: second.runId }), null);
  assert.deepEqual(env.assets.holders(output.assetId), []);
  assert.equal(await env.coordinator.deleteWorkflow(doc.id), "not-found");
});

test("a start is refused while its workflow is being deleted", async (t) => {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  const env = await fixture(t, { beforeDelete: () => gate });
  const doc = await saveWorkflow(env.workflows, generateChains(1));
  const plan = await prepared(env, doc);
  const deleting = env.coordinator.deleteWorkflow(doc.id);
  // The document still exists while the delete is in flight, yet no run may begin on it.
  assert.deepEqual(await env.coordinator.start(OWNER, plan.consentId), { error: "stale" });
  open();
  assert.equal(await deleting, "deleted");
  assert.equal(env.fake.calls.length, 0);
});

test("finishing a run releases the holds of the runs retention drops", async (t) => {
  const env = await fixture(t, { retainRuns: 1 });
  const doc = await saveWorkflow(env.workflows, generateChains(1));
  const first = await env.coordinator.start(OWNER, (await prepared(env, doc)).consentId);
  await env.coordinator.whenIdle();
  assert.ok("runId" in first);
  const firstOutput = env.coordinator.getRun({ runId: first.runId })!.attempts.find((entry) => entry.nodeId === "g1")!.output[0]!;
  assert.equal(env.assets.holders(firstOutput.assetId).length, 1);
  const second = await env.coordinator.start(OWNER, (await prepared(env, doc)).consentId);
  await env.coordinator.whenIdle();
  assert.ok("runId" in second);
  // The newest run keeps the node's latest output; the first run is no longer needed by anything.
  assert.equal(env.coordinator.getRun({ runId: first.runId }), null);
  assert.deepEqual(env.assets.holders(firstOutput.assetId), []);
});

test("image counts are the distinct union of generated images and Image Input assets", async (t) => {
  const env = await fixture(t);
  // The fake's first image is pngBytes(16, 16, 10); importing the same bytes yields the same asset.
  const shared = await env.assets.put({ bytes: pngBytes(16, 16, 10) });
  const imported = await env.assets.put({ bytes: pngBytes(16, 16, 77) });
  const at = { x: 0, y: 0 };
  const nodes: WorkflowDocV1["nodes"] = [
    { id: "p", type: "prompt", position: at, data: { text: "A red bicycle" } },
    { id: "in1", type: "image-input", position: at, data: { assetId: shared.assetId } },
    { id: "in2", type: "image-input", position: at, data: { assetId: imported.assetId } },
    { id: "g", type: "generate-image", position: at, data: { model: { ...NANO_BANANA }, count: 1 } },
    { id: "o", type: "output", position: at, data: {} },
  ];
  const edges: WorkflowDocV1["edges"] = [
    { id: "e1", source: "p", sourcePort: "text", target: "g", targetPort: "prompt" },
    { id: "e2", source: "in1", sourcePort: "image", target: "g", targetPort: "references" },
    { id: "e3", source: "in2", sourcePort: "image", target: "g", targetPort: "references" },
    { id: "e4", source: "g", sourcePort: "images", target: "o", targetPort: "images" },
  ];
  const doc = await saveWorkflow(env.workflows, (draft) => ({ ...draft, nodes, edges }));
  assert.deepEqual(await env.coordinator.imageCounts(), { [doc.id]: 2 });
  await env.coordinator.start(OWNER, (await prepared(env, doc)).consentId);
  await env.coordinator.whenIdle();
  const generated = env.coordinator.latestOutputs(doc.id).g!;
  assert.equal(generated.length, 1);
  // Two Image Inputs plus one generated image, but the generated image is the same bytes as the first input.
  assert.equal(generated[0]!.assetId, shared.assetId);
  assert.deepEqual(await env.coordinator.imageCounts(), { [doc.id]: 2 });
  const other = await saveWorkflow(env.workflows, (draft) => draft);
  assert.equal((await env.coordinator.imageCounts())[other.id], undefined);
});

test("a ledger failure inside a run is reported, ends the run as failed and never rejects whenIdle", async (t) => {
  const env = await fixture(t, {
    wrapLedger: (ledger) =>
      withLedgerOverrides({
        finishAttempts: (...args: never[]) => {
          const [updates] = args as unknown as [{ state: string }[]];
          if (updates.some((update) => update.state === "succeeded")) throw new Error("disk full");
          return ledger.finishAttempts(...(args as unknown as Parameters<ImageRunLedger["finishAttempts"]>));
        },
      })(ledger),
  });
  const doc = await saveWorkflow(env.workflows, generateChains(1));
  const started = await env.coordinator.start(OWNER, (await prepared(env, doc)).consentId);
  assert.ok("runId" in started);
  await env.coordinator.whenIdle();
  const snapshot = env.coordinator.getRun({ runId: started.runId })!;
  assert.equal(snapshot.run.state, "failed");
  assert.ok(env.issues.some((message) => message.includes(started.runId)), JSON.stringify(env.issues));
  assert.equal(env.coordinator.hasActiveRun(doc.id), false);
});

test("shutdown ends active runs, closes the ledger even if recording fails, and refuses new work", async (t) => {
  const env = await fixture(t, {
    reply: () => ({ kind: "hold" }),
    wrapLedger: withLedgerOverrides({
      terminateRun: () => {
        throw new Error("disk full");
      },
    }),
  });
  const doc = await saveWorkflow(env.workflows, generateChains(1));
  const plan = await prepared(env, doc);
  const started = await env.coordinator.start(OWNER, plan.consentId);
  assert.ok("runId" in started);
  await onTheWire(env);
  await env.coordinator.shutdown("app-quit");
  assert.equal(env.fake.calls[0]!.options!.signal!.aborted, true);
  assert.equal(env.issues.length > 0, true);
  assert.throws(() => env.ledger.snapshot(started.runId), /closed/u);
  await assert.rejects(env.coordinator.prepare(OWNER, { workflowId: doc.id, revision: doc.revision, scope: { kind: "all" } }), /shutting down/u);
  assert.equal(env.coordinator.cancel(started.runId), false);
});

test("a snapshot failure on the first publish cannot strand the workflow as busy", async (t) => {
  let failFirst = true;
  const env = await fixture(t, {
    wrapLedger: withLedgerOverrides({
      snapshot: (...args: never[]) => {
        if (failFirst) {
          failFirst = false;
          throw new Error("disk full");
        }
        return (env.ledger.snapshot as (...a: never[]) => unknown)(...args);
      },
    }),
  });
  const doc = await saveWorkflow(env.workflows, generateChains(1));
  const started = await env.coordinator.start(OWNER, (await prepared(env, doc)).consentId);
  assert.ok("runId" in started, JSON.stringify(started));
  await env.coordinator.whenIdle();
  assert.equal(env.coordinator.getRun({ runId: started.runId })!.run.state, "succeeded");
  assert.equal(env.coordinator.hasActiveRun(doc.id), false);
  assert.equal(env.fake.calls.length, 1);
  assert.equal(env.issues.length, 1);
});

test("a crash while quitting is not reported as an internal error", async (t) => {
  let broken = false;
  let sawBreak = false;
  const env = await fixture(t, {
    reply: () => ({ kind: "hold" }),
    wrapLedger: withLedgerOverrides({
      snapshot: (...args: never[]) => {
        if (broken) {
          sawBreak = true;
          throw new Error("late failure");
        }
        return (env.ledger.snapshot as (...a: never[]) => unknown)(...args);
      },
    }),
  });
  const doc = await saveWorkflow(env.workflows, generateChains(1));
  const started = await env.coordinator.start(OWNER, (await prepared(env, doc)).consentId);
  assert.ok("runId" in started);
  await onTheWire(env);
  broken = true;
  await env.coordinator.shutdown("app-quit");
  await until(() => sawBreak, "the aborted run to wind down");
  for (let tick = 0; tick < 10; tick += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(env.issues, []);
});

test("deleting runs first: a ledger failure leaves the workflow and its holds intact", async (t) => {
  let failDelete = true;
  const env = await fixture(t, {
    wrapLedger: withLedgerOverrides({
      deleteWorkflowRuns: (...args: never[]) => {
        if (failDelete) throw new Error("disk full");
        return (env.ledger.deleteWorkflowRuns as (...a: never[]) => unknown)(...args);
      },
    }),
  });
  const doc = await saveWorkflow(env.workflows, generateChains(1));
  const started = await env.coordinator.start(OWNER, (await prepared(env, doc)).consentId);
  await env.coordinator.whenIdle();
  assert.ok("runId" in started);
  const output = env.coordinator.getRun({ runId: started.runId })!.attempts.find((entry) => entry.nodeId === "g1")!.output[0]!;
  await assert.rejects(env.coordinator.deleteWorkflow(doc.id), /disk full/u);
  assert.notEqual(await env.workflows.get(doc.id), null);
  assert.notEqual(env.coordinator.getRun({ runId: started.runId }), null);
  assert.deepEqual(env.assets.holders(output.assetId), [{ kind: "images-run", id: started.runId }]);
  failDelete = false;
  assert.equal(await env.coordinator.deleteWorkflow(doc.id), "deleted");
  assert.deepEqual(env.assets.holders(output.assetId), []);
});

test("a document delete that fails after the runs are gone is reported and leaves no stranded holds", async (t) => {
  const env = await fixture(t, {
    beforeDelete: async () => {
      throw new Error("permission denied");
    },
  });
  const doc = await saveWorkflow(env.workflows, generateChains(1));
  const started = await env.coordinator.start(OWNER, (await prepared(env, doc)).consentId);
  await env.coordinator.whenIdle();
  assert.ok("runId" in started);
  const output = env.coordinator.getRun({ runId: started.runId })!.attempts.find((entry) => entry.nodeId === "g1")!.output[0]!;
  await assert.rejects(env.coordinator.deleteWorkflow(doc.id), /permission denied/u);
  assert.equal(env.issues.length, 1);
  assert.notEqual(await env.workflows.get(doc.id), null);
  assert.equal(env.coordinator.getRun({ runId: started.runId }), null);
  assert.deepEqual(env.assets.holders(output.assetId), []);
  assert.equal(env.coordinator.hasActiveRun(doc.id), false);
});

test("preparing while the workflow is being deleted says so", async (t) => {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  const env = await fixture(t, { beforeDelete: () => gate });
  const doc = await saveWorkflow(env.workflows, generateChains(1));
  const deleting = env.coordinator.deleteWorkflow(doc.id);
  const result = await env.coordinator.prepare(OWNER, { workflowId: doc.id, revision: doc.revision, scope: { kind: "all" } });
  assert.deepEqual("issues" in result ? result.issues.map((issue) => issue.code) : [], ["workflow_deleting"]);
  assert.equal(await env.coordinator.deleteWorkflow(doc.id), "busy");
  open();
  assert.equal(await deleting, "deleted");
});
