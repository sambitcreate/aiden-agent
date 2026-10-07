import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { StudioAssetStore } from "../studio-assets/store.js";
import { fakeThumbnailer, pngBytes } from "../studio-assets/test-fixture.js";
import { createPiImageGenerationPort } from "./image-port.js";
import { ImageRunLedger } from "./run-ledger.js";
import { CreateImagesRuntime } from "./runtime.js";
import { fakeImageModels, generateChains, saveWorkflow, until } from "./test-fixture.js";

async function environment(t: TestContext, options: Parameters<typeof fakeImageModels>[0] = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-image-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const assets = new StudioAssetStore({ root: () => path.join(root, "assets"), thumbnailer: fakeThumbnailer().thumbnailer });
  await assets.initialize();
  t.after(() => assets.close());
  const fake = fakeImageModels(options);
  t.after(() => fake.release());
  const runtime = (overrides: { retainRuns?: number; reportIssue?: (message: string, error: unknown) => void } = {}) => {
    const instance = new CreateImagesRuntime({
      root: () => path.join(root, "create-images"),
      assets,
      port: () => createPiImageGenerationPort({ models: fake.models, providerLabel: () => "OpenRouter" }),
      notify: () => undefined,
      ...overrides,
    });
    t.after(() => instance.shutdown("test-end"));
    return instance;
  };
  return { root, assets, fake, runtime };
}

const OWNER = "1:document-a";
const failOnError = (error: unknown) => assert.fail(error instanceof Error ? error : String(error));

test("a disabled runtime creates no files and exposes no services", async (t) => {
  const env = await environment(t);
  const runtime = env.runtime();
  assert.equal(await runtime.initialize({ enabled: false, onError: failOnError }), false);
  await assert.rejects(access(path.join(env.root, "create-images")));
  assert.throws(() => runtime.services(), /Create Images storage is unavailable/u);
  assert.equal(runtime.inFlightRequests(), 0);
});

test("a crash mid-request leaves the attempt interrupted and may-be-billed, and nothing is resubmitted", async (t) => {
  const env = await environment(t, { reply: (_call, index) => (index === 0 ? { kind: "hold" } : { kind: "images" }) });
  // Session A starts a paid request, then the process "dies": it is never shut down.
  const sessionA = env.runtime();
  assert.equal(await sessionA.initialize({ enabled: true, onError: failOnError }), true);
  const doc = await saveWorkflow(sessionA.services().workflows, generateChains(1));
  const plan = await sessionA.services().coordinator.prepare(OWNER, { workflowId: doc.id, revision: doc.revision, scope: { kind: "all" } });
  assert.ok("plan" in plan);
  const started = await sessionA.services().coordinator.start(OWNER, plan.plan.consentId);
  assert.ok("runId" in started);
  await until(() => env.fake.calls.length === 1, "the first request");

  // Session B opens the same userData, which is the restart boundary.
  const sessionB = env.runtime();
  assert.equal(await sessionB.initialize({ enabled: true, onError: failOnError }), true);
  const interrupted = sessionB.services().coordinator.getRun({ workflowId: doc.id })!;
  assert.equal(interrupted.run.state, "interrupted");
  const attempt = interrupted.attempts.find((entry) => entry.nodeId === "g1")!;
  assert.deepEqual([attempt.state, attempt.mayHaveBeenBilled], ["interrupted", true]);

  // A late result from the dead session cannot revive the run, and nothing is resent.
  env.fake.release();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(sessionB.services().coordinator.getRun({ runId: started.runId })!.run.state, "interrupted");
  assert.equal(env.fake.calls.length, 1);
  assert.deepEqual(
    await sessionB.services().coordinator.start(OWNER, plan.plan.consentId),
    { error: "expired" },
  );

  // Only a fresh consent sends exactly one more request.
  const retry = await sessionB.services().coordinator.prepare(OWNER, { workflowId: doc.id, revision: doc.revision, scope: { kind: "all" } });
  assert.ok("plan" in retry);
  await sessionB.services().coordinator.start(OWNER, retry.plan.consentId);
  await sessionB.services().coordinator.whenIdle();
  assert.equal(env.fake.calls.length, 2);
});

test("shutdown aborts in-flight requests and records app-quit", async (t) => {
  const env = await environment(t, { reply: () => ({ kind: "hold" }) });
  const runtime = env.runtime();
  await runtime.initialize({ enabled: true, onError: failOnError });
  const doc = await saveWorkflow(runtime.services().workflows, generateChains(1));
  const plan = await runtime.services().coordinator.prepare(OWNER, { workflowId: doc.id, revision: doc.revision, scope: { kind: "all" } });
  assert.ok("plan" in plan);
  const started = await runtime.services().coordinator.start(OWNER, plan.plan.consentId);
  assert.ok("runId" in started);
  await until(() => runtime.inFlightRequests() === 1, "the request to be in flight");
  await runtime.shutdown("app-quit");
  assert.throws(() => runtime.services());

  const ledger = ImageRunLedger.open({ directory: path.join(env.root, "create-images") });
  t.after(() => ledger.close());
  const snapshot = ledger.snapshot(started.runId)!;
  assert.deepEqual([snapshot.run.state, snapshot.run.endReason], ["cancelled", "app-quit"]);
  const attempt = snapshot.attempts.find((entry) => entry.nodeId === "g1")!;
  assert.deepEqual([attempt.state, attempt.mayHaveBeenBilled], ["cancelled", true]);
});

test("startup prunes runs beyond retention and releases their asset holds", async (t) => {
  const env = await environment(t);
  const older = await env.assets.put({ bytes: pngBytes(8, 8, 1) });
  const newer = await env.assets.put({ bytes: pngBytes(8, 8, 2) });
  let clock = 1_000;
  // Distinct timestamps make r2 unambiguously the newest output for node g.
  const ledger = ImageRunLedger.open({ directory: path.join(env.root, "create-images"), now: () => (clock += 1) });
  for (const [runId, asset] of [["r1", older], ["r2", newer]] as const) {
    ledger.createRun({ runId, workflowId: "wf", workflowRevision: 1, scope: { kind: "all" }, requestLimit: 1, attempts: [{ nodeId: "g", variant: 0 }] });
    ledger.finishAttempts([{ runId, nodeId: "g", variant: 0, state: "succeeded",
      output: [{ assetId: asset.assetId, width: 8, height: 8, mediaType: "image/png" }] }]);
    ledger.finishRun(runId, "succeeded");
    env.assets.retain({ kind: "images-run", id: runId }, [asset.assetId]);
  }
  ledger.close();

  const runtime = env.runtime({ retainRuns: 1 });
  await runtime.initialize({ enabled: true, onError: failOnError });
  assert.equal(runtime.services().coordinator.getRun({ runId: "r1" }), null);
  assert.deepEqual(env.assets.holders(older.assetId), []);
  assert.deepEqual(env.assets.holders(newer.assetId), [{ kind: "images-run", id: "r2" }]);
});

test("opening twice sweeps once: work started after the first open is never marked interrupted", async (t) => {
  const env = await environment(t, { reply: () => ({ kind: "hold" }) });
  const runtime = env.runtime();
  assert.deepEqual(
    await Promise.all([
      runtime.initialize({ enabled: true, onError: failOnError }),
      runtime.initialize({ enabled: true, onError: failOnError }),
    ]),
    [true, true],
  );
  const { coordinator, workflows } = runtime.services();
  const doc = await saveWorkflow(workflows, generateChains(1));
  const plan = await coordinator.prepare(OWNER, { workflowId: doc.id, revision: doc.revision, scope: { kind: "all" } });
  assert.ok("plan" in plan);
  const started = await coordinator.start(OWNER, plan.plan.consentId);
  assert.ok("runId" in started);
  await until(() => env.fake.calls.length === 1, "the request to be sent");
  assert.equal(await runtime.initialize({ enabled: true, onError: failOnError }), true);
  assert.equal(coordinator.getRun({ runId: started.runId })!.run.state, "running");
  assert.equal(runtime.services().coordinator, coordinator);
});

test("a failed open reports the error and leaves no services", async (t) => {
  const env = await environment(t);
  await env.assets.close();
  const runtime = env.runtime();
  const errors: unknown[] = [];
  assert.equal(await runtime.initialize({ enabled: true, onError: (error) => errors.push(error) }), false);
  assert.equal(errors.length, 1);
  assert.throws(() => runtime.services(), /Create Images storage is unavailable/u);
});

test("workflow store problems reach the issue reporter instead of vanishing", async (t) => {
  const env = await environment(t);
  // A directory where the index cache belongs: the cache write fails, which is non-fatal.
  await mkdir(path.join(env.root, "create-images", "index.json"), { recursive: true });
  const issues: string[] = [];
  const runtime = env.runtime({ reportIssue: (message) => void issues.push(message) });
  assert.equal(await runtime.initialize({ enabled: true, onError: failOnError }), true);
  assert.deepEqual(issues, ["Could not write the image workflow index."]);
});
