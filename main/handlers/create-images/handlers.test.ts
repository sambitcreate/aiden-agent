import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { ImageGenerationPort } from "../../../renderer/shared/images/port.js";
import type {
  GalleryResponse,
  GetRunResponse,
  GetWorkflowResponse,
  ImageActionResponse,
  ImportImageResponse,
  ListWorkflowsResponse,
  PrepareRunResponse,
  WorkflowResponse,
} from "../../../renderer/shared/images/ipc-types.js";
import type { WorkflowDocV1 } from "../../../renderer/shared/images/schema.js";
import type { ExportFileSystem } from "../../services/create-images/image-export.js";
import { createPiImageGenerationPort } from "../../services/create-images/image-port.js";
import type { CreateImagesServices } from "../../services/create-images/runtime.js";
import { CreateImagesRuntime } from "../../services/create-images/runtime.js";
import { fakeImageModels, until, type FakeImageReply } from "../../services/create-images/test-fixture.js";
import { StudioAssetGrants, studioAssetGrantToken, type StudioAssetGrantOwner } from "../../services/studio-assets/delivery-core.js";
import { StudioAssetStore } from "../../services/studio-assets/store.js";
import { fakeThumbnailer, pngBytes } from "../../services/studio-assets/test-fixture.js";
import { readPickedImage, registerCreateImagesHandlers, type CreateImagesFileActions, type CreateImagesOwner } from "./register.js";

/** `owner: null` is a document that is not an Aiden window: the production owner check throws for it. */
interface FakeEvent { owner: CreateImagesOwner | null }
const FOREIGN_OWNER = "Images can only be used from the active Aiden window.";
function documentOwner(id: number, documentId: string): CreateImagesOwner {
  const grants: StudioAssetGrantOwner = { id, documentId, isDestroyed: () => false, onInvalidated: () => () => undefined };
  return { key: `${id}:${documentId}`, grants };
}
const WINDOW_A: FakeEvent = { owner: documentOwner(1, "doc-a") };
const WINDOW_B: FakeEvent = { owner: documentOwner(1, "doc-b") };
const FOREIGN: FakeEvent = { owner: null };
function ownerOf(event: FakeEvent): CreateImagesOwner {
  if (!event.owner) throw new Error(FOREIGN_OWNER);
  return event.owner;
}

const CHANNELS = [
  "imageWorkflows:cancel-run", "imageWorkflows:create", "imageWorkflows:gallery", "imageWorkflows:get", "imageWorkflows:get-run",
  "imageWorkflows:image-action", "imageWorkflows:import-image", "imageWorkflows:list", "imageWorkflows:list-models",
  "imageWorkflows:list-runs", "imageWorkflows:mutate", "imageWorkflows:prepare-run", "imageWorkflows:save", "imageWorkflows:start-run",
];

const DOWNLOADS = path.join(path.sep, "fake-home", "Downloads");

/** Records every Electron-side file action; the dialogs answer with whatever the test sets. */
function fakeFiles() {
  const calls: { op: string; arg?: unknown }[] = [];
  const answers: { savePath: string | null; folder: string | null; copyDecodes: boolean } = { savePath: null, folder: null, copyDecodes: true };
  const files: CreateImagesFileActions<FakeEvent> = {
    chooseSavePath: async (_event, options) => {
      calls.push({ op: "save-dialog", arg: options });
      return answers.savePath;
    },
    downloadsFolder: () => DOWNLOADS,
    chooseFolder: async (_event, options) => {
      calls.push({ op: "folder-dialog", arg: options });
      return answers.folder;
    },
    copyImage: (bytes) => {
      calls.push({ op: "copy", arg: Buffer.from(bytes) });
      return answers.copyDecodes;
    },
    showItemInFolder: (file) => void calls.push({ op: "show", arg: file }),
    openFolder: async (folder) => void calls.push({ op: "open-folder", arg: folder }),
    startDrag: (_event, file) => void calls.push({ op: "drag", arg: file }),
  };
  return { files, calls, answers };
}

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

async function harness(t: TestContext, reply?: (index: number) => FakeImageReply, options: { exportFs?: ExportFileSystem } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-image-ipc-"));
  const saveRoot = path.join(root, "Pictures", "Aiden", "Create Images");
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
    saveRoot: () => saveRoot,
    ...(options.exportFs ? { exportFs: options.exportFs } : {}),
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
  let pickCalls = 0;
  const grants = new StudioAssetGrants();
  const files = fakeFiles();
  const registered = registerCreateImagesHandlers<FakeEvent>({
    enabled: true,
    handle: (channel, listener) => listeners.set(channel, listener),
    owner: ownerOf,
    services: guardedServices,
    grants,
    pickImage: async () => {
      pickCalls += 1;
      return picked;
    },
    files: files.files,
  });
  const invoke = async <T>(channel: string, input: unknown, event: FakeEvent = WINDOW_A): Promise<T> => {
    const listener = listeners.get(channel);
    if (!listener) throw new Error(`No handler for ${channel}`);
    return (await listener(event, input)) as T;
  };
  return {
    invoke, listeners, registered, fake, runtime, assets, grants, root, saveRoot, files,
    pick: (bytes: Uint8Array | null) => (picked = bytes),
    pickCalls: () => pickCalls,
  };
}

async function starter(env: Awaited<ReturnType<typeof harness>>, prompt = "A red bicycle"): Promise<WorkflowDocV1> {
  const { workflow } = await env.invoke<WorkflowResponse>("imageWorkflows:create", { template: "starter" });
  const document = structuredClone(workflow);
  const node = document.nodes.find((entry) => entry.type === "prompt");
  if (node?.type === "prompt") node.data.text = prompt;
  assert.deepEqual(await env.invoke("imageWorkflows:save", { workflowId: workflow.id, baseRevision: 1, document }), { ok: true, revision: 2 });
  return (await env.invoke<GetWorkflowResponse>("imageWorkflows:get", { workflowId: workflow.id })).workflow;
}

test("the inventory is exactly the fourteen ADR channels, and the flag gates all of them", async (t) => {
  const env = await harness(t);
  assert.equal(env.registered, 14);
  assert.deepEqual([...env.listeners.keys()].sort(), CHANNELS);
  let calls = 0;
  const none = registerCreateImagesHandlers<FakeEvent>({
    enabled: false,
    handle: () => (calls += 1),
    owner: ownerOf,
    services: () => env.runtime.services(),
    grants: new StudioAssetGrants(),
    pickImage: async () => null,
    files: fakeFiles().files,
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

test("every channel refuses a valid request from a document that is not an Aiden window, and changes nothing", async (t) => {
  const env = await harness(t, () => ({ kind: "hold" }));
  const doc = await starter(env);
  const generate = doc.nodes.find((node) => node.type === "generate-image")!;
  const prepared = await env.invoke<PrepareRunResponse>("imageWorkflows:prepare-run", { workflowId: doc.id, revision: doc.revision, scope: { kind: "all" } });
  assert.ok("plan" in prepared);
  const edited = structuredClone(doc);
  edited.title = "Renamed by a stranger";
  // Each request is one the owning window could send successfully, so only the owner check can refuse it.
  const valid: Record<string, unknown> = {
    "imageWorkflows:list": {},
    "imageWorkflows:create": { template: "starter", title: "Planted" },
    "imageWorkflows:get": { workflowId: doc.id },
    "imageWorkflows:save": { workflowId: doc.id, baseRevision: doc.revision, document: edited },
    "imageWorkflows:mutate": { op: "duplicate", workflowId: doc.id },
    "imageWorkflows:list-models": {},
    "imageWorkflows:import-image": { source: "bytes", name: "x.png", mimeType: "image/png", data: pngBytes(6, 6, 3) },
    "imageWorkflows:prepare-run": { workflowId: doc.id, revision: doc.revision, scope: { kind: "node-only", nodeId: generate.id } },
    "imageWorkflows:start-run": { consentId: prepared.plan.consentId },
    "imageWorkflows:cancel-run": { runId: "a-run-that-does-not-exist" },
    "imageWorkflows:get-run": { workflowId: doc.id },
    "imageWorkflows:list-runs": { workflowId: doc.id, limit: 5 },
    "imageWorkflows:gallery": {},
    "imageWorkflows:image-action": { op: "reveal-folder" },
  };
  assert.deepEqual(Object.keys(valid).sort(), CHANNELS);
  const before = await env.invoke<ListWorkflowsResponse>("imageWorkflows:list", {});
  const assetsBefore = env.assets.usage();
  for (const channel of CHANNELS) {
    await assert.rejects(env.invoke(channel, valid[channel], FOREIGN), { message: FOREIGN_OWNER }, channel);
  }
  await assert.rejects(env.invoke("imageWorkflows:import-image", { source: "dialog" }, FOREIGN), { message: FOREIGN_OWNER });
  assert.equal(env.pickCalls(), 0);
  assert.deepEqual(env.files.calls, []);
  assert.deepEqual(await env.invoke<ListWorkflowsResponse>("imageWorkflows:list", {}), before);
  assert.deepEqual((await env.invoke<GetWorkflowResponse>("imageWorkflows:get", { workflowId: doc.id })).workflow, doc);
  assert.deepEqual(env.assets.usage(), assetsBefore);
  assert.deepEqual(await env.invoke("imageWorkflows:list-runs", { workflowId: doc.id, limit: 5 }), { runs: [] });
  assert.equal(env.fake.calls.length, 0);
  // The owning window's consent survived the foreign attempts and still starts exactly one request.
  assert.ok("runId" in (await env.invoke<{ runId: string }>("imageWorkflows:start-run", { consentId: prepared.plan.consentId })));
  await until(() => env.fake.calls.length === 1, "the held request");
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

  assert.deepEqual(await env.invoke("imageWorkflows:mutate", { op: "delete", workflowId: doc.id }), { ok: false, reason: "busy" });
  assert.deepEqual(await env.invoke("imageWorkflows:cancel-run", { runId: started.runId }), { ok: true });
  await env.runtime.services().coordinator.whenIdle();
  assert.deepEqual(await env.invoke("imageWorkflows:mutate", { op: "delete", workflowId: doc.id }), { ok: true });
  assert.deepEqual(await env.invoke("imageWorkflows:mutate", { op: "delete", workflowId: doc.id }), { ok: false, reason: "not-found" });
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

test("a picked image is read through one handle and never beyond the import limit", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-image-pick-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const exact = path.join(root, "exact.png");
  await writeFile(exact, Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]));
  assert.deepEqual([...(await readPickedImage(exact, 8))], [1, 2, 3, 4, 5, 6, 7, 8]);
  const over = path.join(root, "over.png");
  await writeFile(over, new Uint8Array(9));
  await assert.rejects(readPickedImage(over, 8), /8 MiB or less/u);
  const folder = path.join(root, "folder.png");
  await mkdir(folder);
  await assert.rejects(readPickedImage(folder, 8), /8 MiB or less/u);
});

async function generate(env: Awaited<ReturnType<typeof harness>>, prompt: string, title?: string): Promise<{ doc: WorkflowDocV1; runId: string }> {
  let doc = await starter(env, prompt);
  if (title) {
    await env.invoke("imageWorkflows:mutate", { op: "rename", workflowId: doc.id, title });
    doc = (await env.invoke<GetWorkflowResponse>("imageWorkflows:get", { workflowId: doc.id })).workflow;
  }
  const prepared = await env.invoke<PrepareRunResponse>("imageWorkflows:prepare-run", { workflowId: doc.id, revision: doc.revision, scope: { kind: "all" } });
  assert.ok("plan" in prepared);
  const started = await env.invoke<{ runId: string }>("imageWorkflows:start-run", { consentId: prepared.plan.consentId });
  await env.runtime.services().coordinator.whenIdle();
  return { doc, runId: started.runId };
}

async function savedFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isFile()).map((entry) => path.join(entry.parentPath, entry.name)).sort();
}

test("a generated image is auto-saved under its workflow title, and the gallery shows what made it", async (t) => {
  const env = await harness(t);
  const { doc, runId } = await generate(env, "A secret prompt about a red bicycle", "Bikes");
  const saved = await savedFiles(env.saveRoot);
  assert.equal(saved.length, 1);
  const relative = path.relative(env.saveRoot, saved[0]!);
  assert.match(relative, /^\d{4}-\d{2}-\d{2}\/\d{6} Bikes [0-9a-f]{8}\.png$/u);
  assert.equal(relative.includes("secret"), false);

  const gallery = await env.invoke<GalleryResponse>("imageWorkflows:gallery", {});
  assert.equal(gallery.saveFolderLabel, "Pictures › Aiden › Create Images");
  assert.equal(gallery.items.length, 1);
  const [item] = gallery.items;
  const stored = await env.assets.read(item!.assetId);
  assert.deepEqual(await readFile(saved[0]!), Buffer.from(stored.bytes));
  assert.equal(path.basename(saved[0]!).includes(item!.assetId.slice(0, 8)), true);
  assert.deepEqual(
    { runId: item!.runId, workflowId: item!.workflowId, workflowTitle: item!.workflowTitle, nodeTitle: item!.nodeTitle, prompt: item!.prompt, provider: item!.provider, model: item!.model, saved: item!.saved, index: item!.index },
    { runId, workflowId: doc.id, workflowTitle: "Bikes", nodeTitle: "Generate Image", prompt: "A secret prompt about a red bicycle", provider: "openrouter", model: "google/gemini-3.1-flash-image", saved: true, index: 0 },
  );
  assert.equal(item!.nodeId, doc.nodes.find((node) => node.type === "generate-image")!.id);
  // The run snapshot shows the same prompt.
  const run = await env.invoke<GetRunResponse>("imageWorkflows:get-run", { runId });
  assert.equal(run.snapshot?.attempts.find((attempt) => attempt.nodeId === item!.nodeId)?.prompt, "A secret prompt about a red bicycle");

  // A moved copy is reported as unsaved; Reveal writes it again and shows the new file.
  await rm(saved[0]!);
  assert.equal((await env.invoke<GalleryResponse>("imageWorkflows:gallery", {})).items[0]?.saved, false);
  assert.deepEqual(await env.invoke("imageWorkflows:image-action", { op: "reveal", assetId: item!.assetId }), { ok: true });
  const rewritten = await savedFiles(env.saveRoot);
  assert.equal(rewritten.length, 1);
  assert.deepEqual(env.files.calls, [{ op: "show", arg: rewritten[0] }]);
  assert.equal((await env.invoke<GalleryResponse>("imageWorkflows:gallery", {})).items[0]?.saved, true);
});

test("the gallery lists one workflow or all of them newest first, and drops titles that no longer exist", async (t) => {
  const env = await harness(t);
  const first = await generate(env, "First", "Alpha");
  const second = await generate(env, "Second", "Beta");
  const all = await env.invoke<GalleryResponse>("imageWorkflows:gallery", {});
  assert.deepEqual(all.items.map((item) => item.workflowTitle), ["Beta", "Alpha"]);
  assert.ok(all.items[0]!.createdAt >= all.items[1]!.createdAt);
  const only = await env.invoke<GalleryResponse>("imageWorkflows:gallery", { workflowId: first.doc.id });
  assert.deepEqual(only.items.map((item) => item.runId), [first.runId]);

  // The gallery names the Generate node by its current title.
  const current = (await env.invoke<GetWorkflowResponse>("imageWorkflows:get", { workflowId: second.doc.id })).workflow;
  const generateId = current.nodes.find((node) => node.type === "generate-image")!.id;
  const renamed = structuredClone(current);
  renamed.nodes = renamed.nodes.map((node) => (node.id === generateId ? { ...node, title: "Hero shot" } : node));
  assert.equal((await env.invoke<{ ok: boolean }>("imageWorkflows:save", { workflowId: current.id, baseRevision: current.revision, document: renamed })).ok, true);
  assert.equal((await env.invoke<GalleryResponse>("imageWorkflows:gallery", { workflowId: second.doc.id })).items[0]?.nodeTitle, "Hero shot");

  await env.invoke("imageWorkflows:mutate", { op: "delete", workflowId: first.doc.id });
  assert.deepEqual((await env.invoke<GalleryResponse>("imageWorkflows:gallery", {})).items.map((item) => item.runId), [second.runId]);
  assert.deepEqual((await env.invoke<GalleryResponse>("imageWorkflows:gallery", { workflowId: first.doc.id })).items, []);
});

test("gallery thumbnails and the full-size view are bound to the document that asked", async (t) => {
  const env = await harness(t);
  await generate(env, "Bound");
  const fromA = (await env.invoke<GalleryResponse>("imageWorkflows:gallery", {}, WINDOW_A)).items[0]!;
  const fromB = (await env.invoke<GalleryResponse>("imageWorkflows:gallery", {}, WINDOW_B)).items[0]!;
  const view = await env.invoke<ImageActionResponse>("imageWorkflows:image-action", { op: "view", assetId: fromA.assetId }, WINDOW_A);
  assert.ok(view.ok && view.url);
  const resolve = (url: string) => env.grants.resolve(studioAssetGrantToken(url) ?? "");
  assert.deepEqual(resolve(fromA.thumbUrl), { assetId: fromA.assetId, rendition: "thumb-512" });
  assert.deepEqual(resolve(view.url), { assetId: fromA.assetId, rendition: "original" });
  assert.notEqual(fromA.thumbUrl, fromB.thumbUrl);
  // Closing document A revokes its URLs; B's keep working.
  env.grants.revokeDocument("1:doc-a");
  assert.equal(resolve(fromA.thumbUrl), undefined);
  assert.equal(resolve(view.url), undefined);
  assert.deepEqual(resolve(fromB.thumbUrl), { assetId: fromA.assetId, rendition: "thumb-512" });
});

test("image actions refuse assets Create Images neither generated nor holds for a workflow", async (t) => {
  const env = await harness(t);
  await starter(env);
  // In the asset store, but only as an unplaced import: no run made it and no workflow holds it.
  const loose = await env.invoke<ImportImageResponse>("imageWorkflows:import-image", { source: "bytes", name: "l.png", mimeType: "image/png", data: pngBytes(7, 7, 9) });
  assert.ok("assetId" in loose);
  const unknown = "0".repeat(64);
  for (const assetId of [loose.assetId, unknown]) {
    for (const op of ["view", "save-as", "copy", "reveal", "drag"]) {
      assert.deepEqual(await env.invoke("imageWorkflows:image-action", { op, assetId }), { ok: false, reason: "not-found" }, `${op} ${assetId}`);
    }
    assert.deepEqual(await env.invoke("imageWorkflows:image-action", { op: "save-all", assetIds: [assetId] }), { ok: false, reason: "not-found" });
  }
  assert.deepEqual(env.files.calls, []);
  assert.deepEqual(await savedFiles(env.saveRoot), []);
});

test("an Image Input a workflow holds can be viewed, copied and revealed", async (t) => {
  const env = await harness(t);
  const doc = await starter(env);
  const imported = await env.invoke<ImportImageResponse>("imageWorkflows:import-image", { source: "bytes", name: "r.png", mimeType: "image/png", data: pngBytes(10, 6, 5) });
  assert.ok("assetId" in imported);
  const withImage = { ...doc, nodes: [...doc.nodes, { id: "in", type: "image-input" as const, position: { x: 0, y: 0 }, data: { assetId: imported.assetId } }] };
  await env.invoke("imageWorkflows:save", { workflowId: doc.id, baseRevision: doc.revision, document: withImage });
  const view = await env.invoke<ImageActionResponse>("imageWorkflows:image-action", { op: "view", assetId: imported.assetId });
  assert.ok(view.ok && view.url?.startsWith("aiden-asset://grant/"));
  assert.deepEqual(await env.invoke("imageWorkflows:image-action", { op: "copy", assetId: imported.assetId }), { ok: true });
  assert.deepEqual(env.files.calls[0], { op: "copy", arg: Buffer.from(pngBytes(10, 6, 5)) });
  env.files.answers.copyDecodes = false;
  assert.deepEqual(await env.invoke("imageWorkflows:image-action", { op: "copy", assetId: imported.assetId }), {
    ok: false, reason: "unsupported", message: "This image can't be copied.",
  });
  assert.deepEqual(await env.invoke("imageWorkflows:image-action", { op: "reveal", assetId: imported.assetId }), { ok: true });
  const [file] = await savedFiles(env.saveRoot);
  // Named after the workflow that holds it.
  assert.ok(path.basename(file!).endsWith(` ${doc.title} ${imported.assetId.slice(0, 8)}.png`), path.basename(file!));
  assert.deepEqual(env.files.calls[env.files.calls.length - 1], { op: "show", arg: file });
});

test("save-as, save-all, reveal-saved, drag and reveal-folder write through main and honour a cancelled dialog", async (t) => {
  const env = await harness(t);
  await generate(env, "One", "Saver");
  await generate(env, "Two", "Saver");
  const items = (await env.invoke<GalleryResponse>("imageWorkflows:gallery", {})).items;
  assert.equal(items.length, 2);
  const [newest, older] = items as [typeof items[0], typeof items[0]];
  const autoSaved = await savedFiles(env.saveRoot);

  // Save As offers the auto-saved name in Downloads (not beside the auto-saved copy); cancelling writes nothing.
  assert.deepEqual(await env.invoke("imageWorkflows:image-action", { op: "save-as", assetId: newest.assetId }), { ok: false, reason: "cancelled" });
  const offered = env.files.calls[env.files.calls.length - 1]?.arg as { defaultPath: string; mediaType: string };
  assert.equal(path.dirname(offered.defaultPath), DOWNLOADS);
  assert.ok(autoSaved.map((file) => path.basename(file)).includes(path.basename(offered.defaultPath)), offered.defaultPath);
  assert.equal(offered.mediaType, "image/png");
  const target = path.join(env.root, "chosen", "mine.png");
  await mkdir(path.dirname(target));
  env.files.answers.savePath = target;
  const savedAs = await env.invoke<{ ok: true; savedId: string }>("imageWorkflows:image-action", { op: "save-as", assetId: newest.assetId });
  assert.equal(savedAs.ok, true);
  assert.deepEqual(await readFile(target), Buffer.from((await env.assets.read(newest.assetId)).bytes));
  // The returned id shows exactly the file that was written; no path crossed IPC.
  assert.deepEqual(await env.invoke("imageWorkflows:image-action", { op: "reveal-saved", savedId: savedAs.savedId }), { ok: true });
  assert.deepEqual(env.files.calls[env.files.calls.length - 1], { op: "show", arg: target });
  assert.deepEqual(
    await env.invoke("imageWorkflows:image-action", { op: "reveal-saved", savedId: "00000000-0000-4000-8000-000000000000" }),
    { ok: false, reason: "not-found" },
  );

  // Save All de-duplicates, keeps every name distinct, and reports the count.
  assert.deepEqual(await env.invoke("imageWorkflows:image-action", { op: "save-all", assetIds: [newest.assetId] }), { ok: false, reason: "cancelled" });
  assert.equal((env.files.calls[env.files.calls.length - 1]?.arg as { defaultPath: string }).defaultPath, DOWNLOADS);
  const folder = path.join(env.root, "export-folder");
  await mkdir(folder);
  env.files.answers.folder = folder;
  const assetIds = [newest.assetId, older.assetId, newest.assetId];
  const first = await env.invoke<{ ok: true; count: number; savedId: string }>("imageWorkflows:image-action", { op: "save-all", assetIds });
  assert.deepEqual({ ok: first.ok, count: first.count }, { ok: true, count: 2 });
  const second = await env.invoke<{ ok: true; count: number }>("imageWorkflows:image-action", { op: "save-all", assetIds });
  assert.equal(second.count, 2);
  assert.equal((await readdir(folder)).length, 4);
  assert.deepEqual(await env.invoke("imageWorkflows:image-action", { op: "reveal-saved", savedId: first.savedId }), { ok: true });
  assert.deepEqual(env.files.calls[env.files.calls.length - 1], { op: "open-folder", arg: folder });

  // Drag and reveal reuse the existing auto-saved copy rather than writing another.
  assert.deepEqual(await env.invoke("imageWorkflows:image-action", { op: "drag", assetId: older.assetId }), { ok: true });
  const dragged = env.files.calls[env.files.calls.length - 1];
  assert.equal(dragged?.op, "drag");
  assert.ok(autoSaved.includes(dragged?.arg as string));
  assert.deepEqual(await env.invoke("imageWorkflows:image-action", { op: "reveal-folder" }), { ok: true });
  assert.deepEqual(env.files.calls[env.files.calls.length - 1], { op: "open-folder", arg: env.saveRoot });
  assert.deepEqual(await savedFiles(env.saveRoot), autoSaved);
});

test("a gallery read right as a run ends waits for its auto-save, so the image is not shown as unsaved", async (t) => {
  // The auto-save's write is held until the run has ended and the gallery read has started.
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const real = await import("node:fs/promises");
  const slow: ExportFileSystem = {
    mkdir: (target, options) => real.mkdir(target, options),
    open: async (target, flags, mode) => {
      await gate;
      return real.open(target, flags, mode);
    },
    link: (existing, target) => real.link(existing, target),
    rename: (from, to) => real.rename(from, to),
    rm: (target, options) => real.rm(target, options),
    stat: (target) => real.stat(target),
  };
  const env = await harness(t, undefined, { exportFs: slow });
  const doc = await starter(env, "Saved before it is listed");
  const prepared = await env.invoke<PrepareRunResponse>("imageWorkflows:prepare-run", { workflowId: doc.id, revision: doc.revision, scope: { kind: "all" } });
  assert.ok("plan" in prepared);
  const { runId } = await env.invoke<{ runId: string }>("imageWorkflows:start-run", { consentId: prepared.plan.consentId });
  for (let attempt = 0; (await env.invoke<GetRunResponse>("imageWorkflows:get-run", { runId })).snapshot?.run.state !== "succeeded"; attempt += 1) {
    assert.ok(attempt < 2_000, "the run should finish while its auto-save is held");
    await new Promise((resolve) => setImmediate(resolve));
  }
  const read = env.invoke<GalleryResponse>("imageWorkflows:gallery", {});
  setTimeout(release, 50);
  const [item] = (await read).items;
  assert.equal(item?.saved, true);
  assert.equal((await savedFiles(env.saveRoot)).length, 1);
});

test("an auto-save that fails never fails the run", async (t) => {
  const denied: ExportFileSystem = {
    mkdir: async () => {
      throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    },
    open: async () => {
      throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    },
    link: async () => {
      throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    },
    rename: async () => {
      throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    },
    rm: async () => undefined,
    stat: async () => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
  };
  const env = await harness(t, undefined, { exportFs: denied });
  const { runId } = await generate(env, "Still works");
  const run = await env.invoke<GetRunResponse>("imageWorkflows:get-run", { runId });
  assert.equal(run.snapshot?.run.state, "succeeded");
  const [item] = (await env.invoke<GalleryResponse>("imageWorkflows:gallery", {})).items;
  assert.equal(item?.saved, false);
  assert.deepEqual(await env.invoke("imageWorkflows:image-action", { op: "reveal", assetId: item!.assetId }), {
    ok: false, reason: "failed", message: "Aiden couldn't finish that image action.",
  });
  assert.deepEqual(env.files.calls, []);
});

test("a Save As that fails while writing keeps the file it was replacing", async (t) => {
  const real = await import("node:fs/promises");
  // Writes into the chosen folder fail partway, as on a disk that fills up.
  let failInto: string | null = null;
  const filling: ExportFileSystem = {
    mkdir: (target, options) => real.mkdir(target, options),
    open: async (target, flags, mode) => {
      const handle = await real.open(target, flags, mode);
      if (failInto === null || !target.startsWith(failInto)) return handle;
      return {
        writeFile: async (data: Uint8Array) => {
          await handle.writeFile(data.subarray(0, 4));
          throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
        },
        close: () => handle.close(),
      };
    },
    link: (existing, target) => real.link(existing, target),
    rename: (from, to) => real.rename(from, to),
    rm: (target, options) => real.rm(target, options),
    stat: (target) => real.stat(target),
  };
  const env = await harness(t, undefined, { exportFs: filling });
  await generate(env, "One", "Replace");
  const [item] = (await env.invoke<GalleryResponse>("imageWorkflows:gallery", {})).items;
  const folder = path.join(env.root, "replace-folder");
  await mkdir(folder);
  const target = path.join(folder, "keep.png");
  await writeFile(target, "the picture already here");
  env.files.answers.savePath = target;
  failInto = folder;

  const result = await env.invoke<{ ok: boolean }>("imageWorkflows:image-action", { op: "save-as", assetId: item!.assetId });
  assert.equal(result.ok, false);
  assert.equal(await readFile(target, "utf8"), "the picture already here");
  assert.deepEqual(await readdir(folder), ["keep.png"], "no staging file is left behind");
});

test("a Save All that writes only some images says how many, and can still show the folder", async (t) => {
  const real = await import("node:fs/promises");
  // Writes into the chosen folder fail after the first one, as on a disk that fills up.
  let failInto: string | null = null;
  let writesInto = 0;
  const filling: ExportFileSystem = {
    mkdir: (target, options) => real.mkdir(target, options),
    open: async (target, flags, mode) => {
      if (failInto !== null && target.startsWith(failInto) && ++writesInto > 1) {
        throw Object.assign(new Error(`ENOSPC: no space left on device, open '${target}'`), { code: "ENOSPC" });
      }
      return real.open(target, flags, mode);
    },
    link: (existing, target) => real.link(existing, target),
    rename: (from, to) => real.rename(from, to),
    rm: (target, options) => real.rm(target, options),
    stat: (target) => real.stat(target),
  };
  const env = await harness(t, undefined, { exportFs: filling });
  await generate(env, "One", "Partial");
  await generate(env, "Two", "Partial");
  const assetIds = (await env.invoke<GalleryResponse>("imageWorkflows:gallery", {})).items.map((item) => item.assetId);
  assert.equal(assetIds.length, 2);
  const folder = path.join(env.root, "filling-folder");
  await mkdir(folder);
  env.files.answers.folder = folder;
  failInto = folder;

  const partial = await env.invoke<{ ok: false; reason: string; message: string; savedId?: string }>("imageWorkflows:image-action", { op: "save-all", assetIds });
  assert.deepEqual({ ok: partial.ok, reason: partial.reason, message: partial.message }, { ok: false, reason: "failed", message: "Aiden saved 1 of 2 images." });
  // Only the finished file is in the folder: no partial or staging file is left behind.
  assert.equal((await readdir(folder)).length, 1);
  assert.ok(partial.savedId, "a partial save names the folder it wrote to");
  assert.deepEqual(await env.invoke("imageWorkflows:image-action", { op: "reveal-saved", savedId: partial.savedId }), { ok: true });
  assert.deepEqual(env.files.calls[env.files.calls.length - 1], { op: "open-folder", arg: folder });

  // Nothing written at all: nothing to show.
  writesInto = 1;
  const none = await env.invoke<{ ok: false; message: string; savedId?: string }>("imageWorkflows:image-action", { op: "save-all", assetIds });
  assert.deepEqual([none.ok, none.message, none.savedId], [false, "Aiden saved 0 of 2 images.", undefined]);
});
