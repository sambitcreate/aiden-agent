import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import test, { type TestContext } from "node:test";
import type { WorkflowDocV1 } from "../../../renderer/shared/images/schema.js";
import { StudioAssetStore } from "../studio-assets/store.js";
import { fakeThumbnailer } from "../studio-assets/test-fixture.js";
import { createPiImageGenerationPort } from "./image-port.js";
import { ImageRunCoordinator } from "./run-coordinator.js";
import { ImageRunLedger } from "./run-ledger.js";
import { fakeImageModels, NANO_BANANA, saveWorkflow } from "./test-fixture.js";
import { ImageWorkflowStore } from "./workflow-store.js";

/**
 * Timing budget for the run ledger. Run it alone: `npm run test:create-images:perf`.
 * It is deliberately not part of `npm test`, so parallel CPU contention cannot make it flaky.
 */
const BUDGET_MS = 1_000;

/** Proxies the ledger and sums wall time spent inside its methods, so provider and store time never count. */
function timedLedger(ledger: ImageRunLedger) {
  let total = 0;
  const calls = new Map<string, number>();
  const proxy = new Proxy(ledger, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const started = performance.now();
        try {
          return (value as (...input: unknown[]) => unknown).apply(target, args);
        } finally {
          total += performance.now() - started;
          calls.set(String(key), (calls.get(String(key)) ?? 0) + 1);
        }
      };
    },
  });
  return { ledger: proxy, total: () => total, calls };
}

async function root(t: TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "aiden-image-perf-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

/** 1 prompt, 4 Generate nodes (the request cap) and 495 Output nodes: 500 nodes, 499 edges. */
function fiveHundredNodes(doc: WorkflowDocV1): WorkflowDocV1 {
  const at = { x: 0, y: 0 };
  doc.nodes = [{ id: "p", type: "prompt", position: at, data: { text: "A red bicycle at dawn" } }];
  doc.edges = [];
  for (let index = 0; index < 4; index += 1) {
    doc.nodes.push({ id: `g${index}`, type: "generate-image", position: at, data: { model: { ...NANO_BANANA }, count: 1 } });
    doc.edges.push({ id: `p-g${index}`, source: "p", sourcePort: "text", target: `g${index}`, targetPort: "prompt" });
  }
  for (let index = 0; index < 495; index += 1) {
    doc.nodes.push({ id: `o${index}`, type: "output", position: at, data: {} });
    doc.edges.push({ id: `g-o${index}`, source: `g${index % 4}`, sourcePort: "images", target: `o${index}`, targetPort: "images" });
  }
  return doc;
}

test("a 500-node run spends under one second inside the ledger", async (t) => {
  const directory = await root(t);
  const assets = new StudioAssetStore({ root: () => path.join(directory, "assets"), thumbnailer: fakeThumbnailer().thumbnailer });
  await assets.initialize();
  t.after(() => assets.close());
  const workflows = new ImageWorkflowStore({ root: () => path.join(directory, "create-images"), assets });
  await workflows.initialize();
  const timing = timedLedger(ImageRunLedger.open({ directory: path.join(directory, "create-images") }));
  const fake = fakeImageModels();
  const coordinator = new ImageRunCoordinator({
    ledger: timing.ledger,
    port: createPiImageGenerationPort({ models: fake.models, providerLabel: () => "OpenRouter" }),
    assets,
    workflows,
    notify: () => undefined,
  });
  t.after(() => coordinator.shutdown("test-end"));

  const doc = await saveWorkflow(workflows, fiveHundredNodes);
  assert.equal(doc.nodes.length, 500);
  const prepared = await coordinator.prepare("1:doc", { workflowId: doc.id, revision: doc.revision, scope: { kind: "all" } });
  assert.ok("plan" in prepared);
  const started = await coordinator.start("1:doc", prepared.plan.consentId);
  assert.ok("runId" in started);
  await coordinator.whenIdle();

  const snapshot = coordinator.getRun({ runId: started.runId })!;
  assert.equal(snapshot.attempts.length, 500);
  assert.equal(snapshot.run.state, "succeeded");
  assert.equal(fake.calls.length, 4);
  assert.ok(
    timing.total() < BUDGET_MS,
    `ledger time ${timing.total().toFixed(1)} ms >= ${BUDGET_MS} ms; calls ${JSON.stringify(Object.fromEntries(timing.calls))}`,
  );
});

test("500 provider-shaped attempts claim and finish in under one second", async (t) => {
  const ledger = ImageRunLedger.open({ directory: await root(t) });
  t.after(() => ledger.close());
  const nodes = Array.from({ length: 500 }, (_, index) => `g${index}`);
  const started = performance.now();
  ledger.createRun({
    runId: "perf",
    workflowId: "wf",
    workflowRevision: 1,
    scope: { kind: "all" },
    requestLimit: 500,
    attempts: nodes.map((nodeId) => ({ nodeId, variant: 0, provider: "openrouter", model: NANO_BANANA.id })),
  });
  for (const nodeId of nodes) {
    assert.equal(ledger.claimProviderRequest("perf", nodeId, 0), true);
    ledger.finishAttempts([
      {
        runId: "perf",
        nodeId,
        variant: 0,
        state: "succeeded",
        costStatus: "unavailable",
        output: [{ assetId: "a".repeat(64), width: 8, height: 8, mediaType: "image/png" }],
      },
    ]);
  }
  ledger.finishRun("perf", "succeeded");
  const elapsed = performance.now() - started;
  assert.equal(ledger.snapshot("perf")!.run.requestsSent, 500);
  assert.ok(elapsed < BUDGET_MS, `500 claims and finishes took ${elapsed.toFixed(1)} ms`);
});
