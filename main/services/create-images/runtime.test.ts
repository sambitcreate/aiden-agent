import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { access, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { StudioAssetStore } from "../studio-assets/store.js";
import { fakeThumbnailer, pngBytes } from "../studio-assets/test-fixture.js";
import type { RunSnapshot } from "../../../renderer/shared/images/run-types.js";
import type { ExportFileSystem } from "./image-export.js";
import { createPiImageGenerationPort } from "./image-port.js";
import { ImageRunLedger } from "./run-ledger.js";
import { CreateImagesRuntime, type CreateImagesAssets } from "./runtime.js";
import { fakeImageModels, generateChains, saveWorkflow, until } from "./test-fixture.js";

async function environment(t: TestContext, options: Parameters<typeof fakeImageModels>[0] = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-image-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const assets = new StudioAssetStore({ root: () => path.join(root, "assets"), thumbnailer: fakeThumbnailer().thumbnailer });
  await assets.initialize();
  t.after(() => assets.close());
  const fake = fakeImageModels(options);
  t.after(() => fake.release());
  const runtime = (
    overrides: {
      retainRuns?: number;
      reportIssue?: (message: string, error: unknown) => void;
      retryCooldownMs?: number;
      assets?: CreateImagesAssets;
      saveRoot?: () => string;
      exportFs?: ExportFileSystem;
      notify?: (snapshot: RunSnapshot) => void;
    } = {},
  ) => {
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

test("quit waits for an auto-save still writing, so the file is complete and recorded before storage closes", async (t) => {
  const env = await environment(t);
  // The auto-save's write is held until quit has begun.
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  // Signalled from the write itself: the run, its storage and the save folder touch the real
  // disk first, which can outlast any fixed number of event-loop turns on a busy machine.
  let writing!: () => void;
  const writeStarted = new Promise<void>((resolve) => {
    writing = resolve;
  });
  const real = fs as unknown as ExportFileSystem;
  const held: ExportFileSystem = {
    ...real,
    open: async (target, flags, mode) => {
      const handle = await real.open(target, flags, mode);
      return {
        writeFile: async (data: Uint8Array) => {
          writing();
          await gate;
          return handle.writeFile(data);
        },
        close: () => handle.close(),
      };
    },
  };
  let ended!: () => void;
  const runEnded = new Promise<void>((resolve) => {
    ended = resolve;
  });
  const saveRoot = path.join(env.root, "Pictures");
  const runtime = env.runtime({
    saveRoot: () => saveRoot,
    exportFs: held,
    notify: (snapshot) => {
      if (snapshot.run.state === "succeeded") ended();
    },
  });
  await runtime.initialize({ enabled: true, onError: failOnError });
  const doc = await saveWorkflow(runtime.services().workflows, generateChains(1));
  const plan = await runtime.services().coordinator.prepare(OWNER, { workflowId: doc.id, revision: doc.revision, scope: { kind: "all" } });
  assert.ok("plan" in plan);
  const started = await runtime.services().coordinator.start(OWNER, plan.plan.consentId);
  assert.ok("runId" in started);
  // The image's auto-save starts as soon as it is stored; the run ends while the write is held.
  await Promise.all([writeStarted, runEnded]);

  const quitting = runtime.shutdown("app-quit");
  setTimeout(release, 30);
  await quitting;

  const ledger = ImageRunLedger.open({ directory: path.join(env.root, "create-images") });
  t.after(() => ledger.close());
  const recorded = [...ledger.exportPaths()];
  assert.equal(recorded.length, 1, "the auto-save was recorded before the ledger closed");
  const [assetId, file] = recorded[0]!;
  assert.deepEqual(await fs.readFile(file), Buffer.from((await env.assets.read(assetId)).bytes));
  // Only the finished image is in the folder.
  const saved = (await readdir(saveRoot, { recursive: true, withFileTypes: true })).filter((entry) => entry.isFile());
  assert.deepEqual(saved.map((entry) => path.join(entry.parentPath, entry.name)), [file]);
});

test("startup prunes runs beyond retention and releases their asset holds", async (t) => {
  const env = await environment(t);
  const older = await env.assets.put({ bytes: pngBytes(8, 8, 1) });
  const newer = await env.assets.put({ bytes: pngBytes(8, 8, 2) });
  let clock = 1_000;
  // Distinct timestamps make r2 unambiguously the newest output for node g.
  const ledger = ImageRunLedger.open({ directory: path.join(env.root, "create-images"), now: () => (clock += 1) });
  for (const [runId, asset] of [["r1", older], ["r2", newer]] as const) {
    ledger.createRun({ runId, workflowId: "wf", workflowRevision: 1, scope: { kind: "all" }, requestLimit: 1, attempts: [{ nodeId: "g", variant: 0, provider: "openrouter", model: "m" }] });
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
  assert.throws(() => runtime.services(), (error: unknown) => error instanceof Error && !/Restart Aiden/u.test(error.message));
});

test("a failed open is retried by a later call once the cause is gone", async (t) => {
  const env = await environment(t);
  await env.assets.close();
  const runtime = env.runtime({ retryCooldownMs: 60_000 });
  const errors: unknown[] = [];
  assert.equal(await runtime.initialize({ enabled: true, onError: (error) => errors.push(error) }), false);
  await env.assets.initialize();
  // Within the cooldown the last failure is repeated without another attempt.
  await assert.rejects(runtime.ready(), /studio image store isn't open/u);
  assert.equal(errors.length, 1);

  const retrying = env.runtime({ retryCooldownMs: 0 });
  await env.assets.close();
  assert.equal(await retrying.initialize({ enabled: true, onError: () => undefined }), false);
  await env.assets.initialize();
  const services = await retrying.ready();
  assert.ok(services.workflows.list());
  assert.equal(retrying.services(), services);
});

test("a ledger that fails the file-safety checks is refused with an accurate message and never moved", async (t) => {
  const env = await environment(t);
  const directory = path.join(env.root, "create-images");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(env.root, "elsewhere.sqlite"), "");
  await symlink(path.join(env.root, "elsewhere.sqlite"), path.join(directory, "runs-v1.sqlite"));
  const runtime = env.runtime();
  assert.equal(await runtime.initialize({ enabled: true, onError: () => undefined }), false);
  assert.throws(() => runtime.services(), /run history file \(create-images\/runs-v1\.sqlite\) is a link, has extra hard links, or belongs to another user/u);
  assert.equal((await readdir(directory)).filter((name) => name.includes("corrupt")).length, 0);
});

test("a corrupt run ledger is quarantined and the workflows still list and open", async (t) => {
  const env = await environment(t);
  const first = env.runtime();
  assert.equal(await first.initialize({ enabled: true, onError: failOnError }), true);
  const doc = await saveWorkflow(first.services().workflows, generateChains(1));
  await first.shutdown("test");

  const directory = path.join(env.root, "create-images");
  for (const suffix of ["-wal", "-shm"]) await rm(path.join(directory, `runs-v1.sqlite${suffix}`), { force: true });
  await writeFile(path.join(directory, "runs-v1.sqlite"), "not a database ".repeat(400));
  const issues: string[] = [];
  const second = env.runtime({ reportIssue: (message) => void issues.push(message) });
  assert.equal(await second.initialize({ enabled: true, onError: failOnError }), true);
  assert.deepEqual(second.services().workflows.list().map((entry) => entry.id), [doc.id]);
  assert.equal((await second.services().workflows.get(doc.id))?.id, doc.id);
  assert.deepEqual(second.services().coordinator.listRuns(doc.id, 10), []);
  assert.equal(issues.filter((message) => /run history could not be read and was moved to .*runs-v1\.sqlite\.corrupt-\d+/u.test(message)).length, 1);
  assert.equal((await readdir(directory)).filter((name) => /^runs-v1\.sqlite\.corrupt-\d+$/u.test(name)).length, 1);
});

/** The real store, plus the holder listing reconciliation can use (computed over the assets this test made). */
function withHolderListing(assets: StudioAssetStore, known: () => string[]): CreateImagesAssets {
  return Object.assign(Object.create(assets) as StudioAssetStore, {
    holderIds: (kind: string) => [
      ...new Set(known().flatMap((assetId) => assets.holders(assetId).filter((holder) => holder.kind === kind).map((holder) => holder.id))),
    ],
  });
}

test("reopening reconciles image holds with the ledger and the documents, leaving Design holds alone", async (t) => {
  const env = await environment(t);
  const output = await env.assets.put({ bytes: pngBytes(8, 8, 21) });
  const input = await env.assets.put({ bytes: pngBytes(8, 8, 22) });
  const strayRun = await env.assets.put({ bytes: pngBytes(8, 8, 23) });
  const strayWorkflow = await env.assets.put({ bytes: pngBytes(8, 8, 24) });
  const known = () => [output, input, strayRun, strayWorkflow].map((record) => record.assetId);
  const first = env.runtime();
  assert.equal(await first.initialize({ enabled: true, onError: failOnError }), true);
  const doc = await saveWorkflow(first.services().workflows, (draft) => ({
    ...draft,
    nodes: [{ id: "in", type: "image-input", position: { x: 0, y: 0 }, data: { assetId: input.assetId } }],
    edges: [],
  }));
  await first.shutdown("test");

  const ledger = ImageRunLedger.open({ directory: path.join(env.root, "create-images") });
  ledger.createRun({ runId: "kept", workflowId: doc.id, workflowRevision: 1, scope: { kind: "all" }, requestLimit: 1, attempts: [{ nodeId: "g", variant: 0, provider: "openrouter", model: "m" }] });
  ledger.finishAttempts([{ runId: "kept", nodeId: "g", variant: 0, state: "succeeded", output: [{ assetId: output.assetId, width: 8, height: 8, mediaType: "image/png" }] }]);
  ledger.finishRun("kept", "succeeded");
  ledger.close();
  // A crash lost the run's hold and the workflow's hold (or the asset index was rebuilt),
  // and left holders for a pruned run and a deleted workflow behind.
  env.assets.releaseAllForHolder({ kind: "images-workflow", id: doc.id });
  env.assets.retain({ kind: "images-run", id: "pruned-run" }, [strayRun.assetId]);
  env.assets.retain({ kind: "images-workflow", id: "deleted-workflow" }, [strayWorkflow.assetId]);
  env.assets.retain({ kind: "design", id: "project-1" }, [strayRun.assetId]);

  const second = env.runtime({ assets: withHolderListing(env.assets, known) });
  assert.equal(await second.initialize({ enabled: true, onError: failOnError }), true);
  assert.deepEqual(env.assets.holders(output.assetId), [{ kind: "images-run", id: "kept" }]);
  assert.deepEqual(env.assets.holders(input.assetId), [{ kind: "images-workflow", id: doc.id }]);
  assert.deepEqual(env.assets.holders(strayRun.assetId), [{ kind: "design", id: "project-1" }]);
  assert.deepEqual(env.assets.holders(strayWorkflow.assetId), []);
});

test("without a holder listing, stray image holders on assets still in use are released", async (t) => {
  const env = await environment(t);
  const shared = await env.assets.put({ bytes: pngBytes(8, 8, 31) });
  const ledger = ImageRunLedger.open({ directory: path.join(env.root, "create-images") });
  ledger.createRun({ runId: "kept", workflowId: "wf", workflowRevision: 1, scope: { kind: "all" }, requestLimit: 1, attempts: [{ nodeId: "g", variant: 0, provider: "openrouter", model: "m" }] });
  ledger.finishAttempts([{ runId: "kept", nodeId: "g", variant: 0, state: "succeeded", output: [{ assetId: shared.assetId, width: 8, height: 8, mediaType: "image/png" }] }]);
  ledger.finishRun("kept", "succeeded");
  ledger.close();
  env.assets.retain({ kind: "images-run", id: "pruned-run" }, [shared.assetId]);

  const runtime = env.runtime();
  assert.equal(await runtime.initialize({ enabled: true, onError: failOnError }), true);
  assert.deepEqual(env.assets.holders(shared.assetId), [{ kind: "images-run", id: "kept" }]);
});

test("startup retention keeps latest outputs only for nodes the document still has", async (t) => {
  const env = await environment(t);
  const first = env.runtime();
  assert.equal(await first.initialize({ enabled: true, onError: failOnError }), true);
  const doc = await saveWorkflow(first.services().workflows, generateChains(1));
  await first.shutdown("test");
  const asset = await env.assets.put({ bytes: pngBytes(8, 8, 41) });
  const ledger = ImageRunLedger.open({ directory: path.join(env.root, "create-images") });
  for (const [runId, nodeId] of [["live-node", "g1"], ["deleted-node", "g-removed"], ["newest", "g-other"]] as const) {
    ledger.createRun({ runId, workflowId: doc.id, workflowRevision: 1, scope: { kind: "all" }, requestLimit: 1, attempts: [{ nodeId, variant: 0, provider: "openrouter", model: "m" }] });
    ledger.finishAttempts([{ runId, nodeId, variant: 0, state: "succeeded", output: [{ assetId: asset.assetId, width: 8, height: 8, mediaType: "image/png" }] }]);
    ledger.finishRun(runId, "succeeded");
  }
  ledger.close();

  const runtime = env.runtime({ retainRuns: 1 });
  assert.equal(await runtime.initialize({ enabled: true, onError: failOnError }), true);
  const remaining = runtime.services().coordinator.listRuns(doc.id, 10).map((summary) => summary.runId).sort();
  assert.deepEqual(remaining, ["live-node", "newest"]);
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
