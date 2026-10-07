import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { ImageGenerationPort } from "../../../renderer/shared/images/port.js";
import type {
  GetRunResponse,
  GetWorkflowResponse,
  ImportImageResponse,
  ListWorkflowsResponse,
  PrepareRunResponse,
  WorkflowResponse,
} from "../../../renderer/shared/images/ipc-types.js";
import type { WorkflowDocV1 } from "../../../renderer/shared/images/schema.js";
import { createPiImageGenerationPort } from "../../services/create-images/image-port.js";
import type { CreateImagesServices } from "../../services/create-images/runtime.js";
import { CreateImagesRuntime } from "../../services/create-images/runtime.js";
import { fakeImageModels, until, type FakeImageReply } from "../../services/create-images/test-fixture.js";
import { StudioAssetGrants, type StudioAssetGrantOwner } from "../../services/studio-assets/delivery-core.js";
import { StudioAssetStore } from "../../services/studio-assets/store.js";
import { fakeThumbnailer, pngBytes } from "../../services/studio-assets/test-fixture.js";
import { registerCreateImagesHandlers, type CreateImagesOwner } from "./register.js";

interface FakeEvent { owner: CreateImagesOwner }
function documentOwner(id: number, documentId: string): CreateImagesOwner {
  const grants: StudioAssetGrantOwner = { id, documentId, isDestroyed: () => false, onInvalidated: () => () => undefined };
  return { key: `${id}:${documentId}`, grants };
}
const WINDOW_A: FakeEvent = { owner: documentOwner(1, "doc-a") };
const WINDOW_B: FakeEvent = { owner: documentOwner(1, "doc-b") };

const CHANNELS = [
  "imageWorkflows:cancel-run", "imageWorkflows:create", "imageWorkflows:get", "imageWorkflows:get-run",
  "imageWorkflows:import-image", "imageWorkflows:list", "imageWorkflows:list-models", "imageWorkflows:list-runs",
  "imageWorkflows:mutate", "imageWorkflows:prepare-run", "imageWorkflows:save", "imageWorkflows:start-run",
];

/**
 * Handlers may read the provider catalog and nothing else: generation is reachable only through
 * the coordinator's start, which consumes the consent and claims the ledger first.
 */
function listModelsOnly(port: ImageGenerationPort): ImageGenerationPort {
  return new Proxy(port, {
    get(target, property) {
      if (property !== "listModels") throw new Error(`The handler reached the image port through ${String(property)}.`);
      return target.listModels.bind(target);
    },
  });
}

async function harness(t: TestContext, reply?: (index: number) => FakeImageReply) {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-image-ipc-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const assets = new StudioAssetStore({ root: () => path.join(root, "assets"), thumbnailer: fakeThumbnailer().thumbnailer });
  await assets.initialize();
  t.after(() => assets.close());
  const fake = fakeImageModels(reply ? { reply: (_call, index) => reply(index) } : {});
  const runtime = new CreateImagesRuntime({
    root: () => path.join(root, "create-images"),
    assets,
    port: () => createPiImageGenerationPort({ models: fake.models, providerLabel: () => "OpenRouter" }),
    notify: () => undefined,
  });
  assert.equal(await runtime.initialize({ enabled: true, onError: (error) => assert.fail(String(error)) }), true);
  t.after(async () => {
    fake.release();
    await runtime.services().coordinator.whenIdle();
    await runtime.shutdown("test-end");
  });
  const guardedServices = (): CreateImagesServices => {
    const services = runtime.services();
    return { ...services, port: listModelsOnly(services.port) };
  };
  const listeners = new Map<string, (event: FakeEvent, input: unknown) => unknown>();
  let picked: Uint8Array | null = null;
  const registered = registerCreateImagesHandlers<FakeEvent>({
    enabled: true,
    handle: (channel, listener) => listeners.set(channel, listener),
    owner: (event) => event.owner,
    services: guardedServices,
    grants: new StudioAssetGrants(),
    pickImage: async () => picked,
  });
  const invoke = async <T>(channel: string, input: unknown, event: FakeEvent = WINDOW_A): Promise<T> => {
    const listener = listeners.get(channel);
    if (!listener) throw new Error(`No handler for ${channel}`);
    return (await listener(event, input)) as T;
  };
  return { invoke, listeners, registered, fake, runtime, assets, pick: (bytes: Uint8Array | null) => (picked = bytes) };
}

async function starter(env: Awaited<ReturnType<typeof harness>>, prompt = "A red bicycle"): Promise<WorkflowDocV1> {
  const { workflow } = await env.invoke<WorkflowResponse>("imageWorkflows:create", { template: "starter" });
  const document = structuredClone(workflow);
  const node = document.nodes.find((entry) => entry.type === "prompt");
  if (node?.type === "prompt") node.data.text = prompt;
  assert.deepEqual(await env.invoke("imageWorkflows:save", { workflowId: workflow.id, baseRevision: 1, document }), { ok: true, revision: 2 });
  return (await env.invoke<GetWorkflowResponse>("imageWorkflows:get", { workflowId: workflow.id })).workflow;
}

test("the inventory is exactly the twelve ADR channels, and the flag gates all of them", async (t) => {
  const env = await harness(t);
  assert.equal(env.registered, 12);
  assert.deepEqual([...env.listeners.keys()].sort(), CHANNELS);
  let calls = 0;
  const none = registerCreateImagesHandlers<FakeEvent>({
    enabled: false,
    handle: () => (calls += 1),
    owner: (event) => event.owner,
    services: () => env.runtime.services(),
    grants: new StudioAssetGrants(),
    pickImage: async () => null,
  });
  assert.deepEqual([none, calls], [0, 0]);
});

test("every channel rejects unexpected fields before touching storage", async (t) => {
  const env = await harness(t);
  for (const channel of CHANNELS) {
    await assert.rejects(env.invoke(channel, { unexpected: true }), /Invalid Create Images request/u, channel);
  }
  assert.deepEqual(await env.invoke("imageWorkflows:list", {}), { workflows: [], imageCounts: {} });
  assert.equal(env.fake.calls.length, 0);
});

test("create defaults the Generate node to Nano Banana 2, and get returns document-bound image URLs", async (t) => {
  const env = await harness(t);
  const doc = await starter(env);
  const generate = doc.nodes.find((node) => node.type === "generate-image");
  assert.deepEqual(generate?.data, { model: { provider: "openrouter", id: "google/gemini-3.1-flash-image" }, count: 1 });

  const imported = await env.invoke<ImportImageResponse>("imageWorkflows:import-image", {
    source: "bytes", name: "ref.png", mimeType: "image/png", data: pngBytes(20, 10, 4),
  });
  assert.ok(!("cancelled" in imported));
  assert.deepEqual([imported.width, imported.height, imported.mimeType], [20, 10, "image/png"]);
  const withImage = { ...doc, nodes: [...doc.nodes, { id: "in", type: "image-input" as const, position: { x: 0, y: 0 }, data: { assetId: imported.assetId } }] };
  assert.equal((await env.invoke<{ ok: boolean }>("imageWorkflows:save", { workflowId: doc.id, baseRevision: doc.revision, document: withImage })).ok, true);
  const loaded = await env.invoke<GetWorkflowResponse>("imageWorkflows:get", { workflowId: doc.id });
  assert.match(loaded.assetUrls[imported.assetId] ?? "", /^aiden-asset:\/\/grant\/[A-Za-z0-9_-]{43}$/u);

  env.fake.models.deleteProvider("openrouter");
  const bare = await env.invoke<WorkflowResponse>("imageWorkflows:create", { template: "starter" });
  assert.deepEqual(bare.workflow.nodes.find((node) => node.type === "generate-image")?.data, { count: 1 });
});

test("prepare and start are bound to the window that asked, and get-run grants only the run's outputs", async (t) => {
  const env = await harness(t);
  const doc = await starter(env);
  const prepared = await env.invoke<PrepareRunResponse>("imageWorkflows:prepare-run", { workflowId: doc.id, revision: doc.revision, scope: { kind: "all" } });
  assert.ok("plan" in prepared);
  assert.equal(env.fake.calls.length, 0);
  assert.deepEqual(await env.invoke("imageWorkflows:start-run", { consentId: prepared.plan.consentId }, WINDOW_B), { error: "expired" });
  const started = await env.invoke<{ runId: string }>("imageWorkflows:start-run", { consentId: prepared.plan.consentId });
  await env.runtime.services().coordinator.whenIdle();
  assert.equal(env.fake.calls.length, 1);
  const run = await env.invoke<GetRunResponse>("imageWorkflows:get-run", { runId: started.runId });
  assert.equal(run.snapshot?.run.state, "succeeded");
  const outputs = [...new Set(run.snapshot!.attempts.flatMap((attempt) => attempt.output.map((ref) => ref.assetId)))];
  assert.equal(outputs.length, 1);
  assert.deepEqual(Object.keys(run.assetUrls), outputs);
  const latest = await env.invoke<GetRunResponse>("imageWorkflows:get-run", { workflowId: doc.id });
  assert.equal(latest.snapshot?.run.runId, started.runId);
  const runs = await env.invoke<{ runs: { runId: string }[] }>("imageWorkflows:list-runs", { workflowId: doc.id, limit: 5 });
  assert.deepEqual(runs.runs.map((summary) => summary.runId), [started.runId]);
  // The delete confirmation names this number, and nothing is stale after a full run.
  assert.deepEqual((await env.invoke<ListWorkflowsResponse>("imageWorkflows:list", {})).imageCounts, { [doc.id]: 1 });
  assert.deepEqual((await env.invoke<GetWorkflowResponse>("imageWorkflows:get", { workflowId: doc.id })).staleNodeIds, []);
});

test("prepare-run takes the all, from-node and node-only scopes, rejects anything else, and a node-only run leaves its Output out of date", async (t) => {
  const env = await harness(t);
  const doc = await starter(env);
  const generate = doc.nodes.find((node) => node.type === "generate-image")!;
  const output = doc.nodes.find((node) => node.type === "output")!;
  const prepare = (scope: unknown) =>
    env.invoke<PrepareRunResponse>("imageWorkflows:prepare-run", { workflowId: doc.id, revision: doc.revision, scope });

  for (const scope of [{ kind: "all" }, { kind: "from-node", nodeId: generate.id }, { kind: "node-only", nodeId: generate.id }]) {
    const prepared = await prepare(scope);
    assert.ok("plan" in prepared, JSON.stringify(scope));
    assert.deepEqual(prepared.plan.scope, scope);
    assert.equal(prepared.plan.totalRequests, 1);
  }
  const malformed = [
    { kind: "node-only" },
    { kind: "node-only", nodeId: generate.id, extra: 1 },
    { kind: "all", nodeId: generate.id },
    { kind: "downstream", nodeId: generate.id },
    { kind: "node-only", nodeId: "" },
    { kind: "from-node", nodeId: "   " },
    { kind: "node-only", nodeId: " \t " },
    "node-only",
  ];
  for (const scope of malformed) {
    await assert.rejects(prepare(scope), /Invalid Create Images request/u, JSON.stringify(scope));
  }
  // A node-only run of a node that is not a Generate node is a planning issue, not a request.
  const refused = await prepare({ kind: "node-only", nodeId: output.id });
  assert.deepEqual("issues" in refused ? refused.issues.map((issue) => issue.code) : [], ["node_only_requires_generate"]);
  assert.equal(env.fake.calls.length, 0);

  // Run everything, then retry the Generate node on its own: one more request, and its Output keeps its image but is out of date.
  const { coordinator } = env.runtime.services();
  for (const scope of [{ kind: "all" }, { kind: "node-only", nodeId: generate.id }]) {
    const prepared = await prepare(scope);
    assert.ok("plan" in prepared);
    assert.ok("runId" in (await env.invoke<{ runId: string }>("imageWorkflows:start-run", { consentId: prepared.plan.consentId })));
    await coordinator.whenIdle();
  }
  assert.equal(env.fake.calls.length, 2);
  const loaded = await env.invoke<GetWorkflowResponse>("imageWorkflows:get", { workflowId: doc.id });
  assert.deepEqual(loaded.staleNodeIds, [output.id]);
  assert.equal(loaded.latestOutputs[output.id]?.length, 1);
});

test("import refuses oversized and non-image bytes, and a cancelled dialog is not an error", async (t) => {
  const env = await harness(t);
  await assert.rejects(
    env.invoke("imageWorkflows:import-image", { source: "bytes", name: "big.png", mimeType: "image/png", data: new Uint8Array(8 * 1024 * 1024 + 1) }),
    /Invalid Create Images request/u,
  );
  await assert.rejects(
    env.invoke("imageWorkflows:import-image", { source: "bytes", name: "x.png", mimeType: "image/png", data: Buffer.from("GIF89a not a png") }),
    /PNG, JPEG and WebP/u,
  );
  env.pick(null);
  assert.deepEqual(await env.invoke("imageWorkflows:import-image", { source: "dialog" }), { cancelled: true });
  env.pick(pngBytes(9, 9, 1));
  const picked = await env.invoke<ImportImageResponse>("imageWorkflows:import-image", { source: "dialog" });
  assert.ok("assetId" in picked && picked.width === 9);
});

test("delete waits for a stopped run, then removes the workflow's runs and image holds", async (t) => {
  const env = await harness(t, () => ({ kind: "hold" }));
  const doc = await starter(env);
  const imported = await env.invoke<ImportImageResponse>("imageWorkflows:import-image", { source: "bytes", name: "r.png", mimeType: "image/png", data: pngBytes(8, 8, 2) });
  assert.ok("assetId" in imported);
  const withImage = { ...doc, nodes: [...doc.nodes, { id: "in", type: "image-input" as const, position: { x: 0, y: 0 }, data: { assetId: imported.assetId } }] };
  await env.invoke("imageWorkflows:save", { workflowId: doc.id, baseRevision: doc.revision, document: withImage });
  const saved = (await env.invoke<GetWorkflowResponse>("imageWorkflows:get", { workflowId: doc.id })).workflow;
  const prepared = await env.invoke<PrepareRunResponse>("imageWorkflows:prepare-run", { workflowId: doc.id, revision: saved.revision, scope: { kind: "all" } });
  assert.ok("plan" in prepared);
  const started = await env.invoke<{ runId: string }>("imageWorkflows:start-run", { consentId: prepared.plan.consentId });
  // Wait for the provider to hold the request, not just for the ledger claim, so the cancel below lands on a request in flight.
  await until(() => env.fake.calls.length === 1, "the held request");

  assert.deepEqual(await env.invoke("imageWorkflows:mutate", { op: "delete", workflowId: doc.id }), { ok: false });
  assert.deepEqual(await env.invoke("imageWorkflows:cancel-run", { runId: started.runId }), { ok: true });
  await env.runtime.services().coordinator.whenIdle();
  assert.deepEqual(await env.invoke("imageWorkflows:mutate", { op: "delete", workflowId: doc.id }), { ok: true });
  assert.deepEqual(await env.invoke("imageWorkflows:mutate", { op: "delete", workflowId: doc.id }), { ok: false });
  assert.deepEqual(await env.invoke("imageWorkflows:list-runs", { workflowId: doc.id, limit: 5 }), { runs: [] });
  assert.deepEqual(env.assets.holders(imported.assetId), []);
  await assert.rejects(env.invoke("imageWorkflows:get", { workflowId: doc.id }), /no longer exists/u);
});

test("the delete confirmation counts each distinct image once: run outputs plus Image Input assets", async (t) => {
  const env = await harness(t);
  const doc = await starter(env);
  const imported = await env.invoke<ImportImageResponse>("imageWorkflows:import-image", { source: "bytes", name: "ref.png", mimeType: "image/png", data: pngBytes(12, 12, 7) });
  assert.ok("assetId" in imported);
  // The same asset on two Image Input nodes is still one image.
  const withImages = {
    ...doc,
    nodes: [
      ...doc.nodes,
      { id: "in-a", type: "image-input" as const, position: { x: 0, y: 0 }, data: { assetId: imported.assetId } },
      { id: "in-b", type: "image-input" as const, position: { x: 0, y: 0 }, data: { assetId: imported.assetId } },
    ],
  };
  assert.equal((await env.invoke<{ ok: boolean }>("imageWorkflows:save", { workflowId: doc.id, baseRevision: doc.revision, document: withImages })).ok, true);
  const other = await starter(env, "Another prompt");
  const current = (await env.invoke<GetWorkflowResponse>("imageWorkflows:get", { workflowId: doc.id })).workflow;
  assert.deepEqual((await env.invoke<ListWorkflowsResponse>("imageWorkflows:list", {})).imageCounts, { [doc.id]: 1 });

  const prepared = await env.invoke<PrepareRunResponse>("imageWorkflows:prepare-run", { workflowId: doc.id, revision: current.revision, scope: { kind: "all" } });
  assert.ok("plan" in prepared);
  await env.invoke("imageWorkflows:start-run", { consentId: prepared.plan.consentId });
  await env.runtime.services().coordinator.whenIdle();
  const counts = (await env.invoke<ListWorkflowsResponse>("imageWorkflows:list", {})).imageCounts;
  // One generated image plus the imported one; the other workflow holds nothing and is absent.
  assert.deepEqual(counts, { [doc.id]: 2 });
  assert.equal(other.id in counts, false);
});

test("handlers reach the image port only to list models; generation starts only through a consent", async (t) => {
  const env = await harness(t);
  const doc = await starter(env);
  // Every handler runs against the guarded port here; any port call other than listModels throws.
  await env.invoke("imageWorkflows:list-models", {});
  await env.invoke("imageWorkflows:create", { template: "blank" });
  const prepared = await env.invoke<PrepareRunResponse>("imageWorkflows:prepare-run", { workflowId: doc.id, revision: doc.revision, scope: { kind: "all" } });
  assert.ok("plan" in prepared);
  assert.equal(env.fake.calls.length, 0);
  await env.invoke("imageWorkflows:start-run", { consentId: prepared.plan.consentId });
  await env.runtime.services().coordinator.whenIdle();
  assert.equal(env.fake.calls.length, 1);
  // A consent is single-use: replaying it starts no second paid request.
  assert.deepEqual(await env.invoke("imageWorkflows:start-run", { consentId: prepared.plan.consentId }), { error: "expired" });
  assert.equal(env.fake.calls.length, 1);
});
