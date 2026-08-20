import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test, { type TestContext } from "node:test";
import { projectCreateImagesRun } from "../../../renderer/shared/create-images/run-contract.js";
import { createStarterWorkflow } from "../../../renderer/shared/create-images/schema.js";
import { CreateImagesService } from "./create-images-service.js";
import { shouldReleaseCreateImagesRunOwner } from "./run-publication-binding-core.js";

const NOW = "2026-08-11T12:00:00.000Z";
const RUN_TIMEOUT_MS = 10_000;

interface StoredAssetIndex {
  schemaVersion: 1;
  revision: number;
  assets: Record<string, { referenceOwners: string[] }>;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffff_ffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb8_8320 : 0);
    }
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

function u32(value: number): Uint8Array {
  return Uint8Array.from([
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ]);
}

function concatenate(...parts: readonly Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const checksum = concatenate(typeBytes, data);
  return concatenate(u32(data.byteLength), checksum, u32(crc32(checksum)));
}

function staticPng(): Uint8Array {
  const header = new Uint8Array(13);
  header.set(u32(1));
  header.set(u32(1), 4);
  header[8] = 8;
  header[9] = 6;
  return concatenate(
    Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", Uint8Array.from([0x78, 0x9c, 0, 0, 0, 0, 0, 1])),
    pngChunk("IEND", new Uint8Array()),
  );
}

async function temporaryRoot(t: TestContext): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-create-images-phase-three-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

function serviceOptions(now: () => number) {
  const thumbnail = staticPng();
  return {
    assetStore: {
      now,
      deepValidator: {
        async validate({ descriptor }: { descriptor: { width: number; height: number } }) {
          return { width: descriptor.width, height: descriptor.height };
        },
      },
      thumbnailGenerator: {
        async generate() {
          return {
            bytes: thumbnail,
            width: 1,
            height: 1,
            mediaType: "image/png" as const,
          };
        },
      },
    },
  };
}

async function waitUntil<Result>(
  description: string,
  inspect: () => Promise<Result | undefined>,
): Promise<Result> {
  const deadline = Date.now() + RUN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const result = await inspect();
    if (result !== undefined) return result;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

test("a future run index leaves the workflow library readable while run admission stays closed", async (t) => {
  const root = await temporaryRoot(t);
  let clock = Date.parse(NOW);
  const now = () => clock++;
  const first = new CreateImagesService(root, serviceOptions(now));
  await first.initialize();
  const workflow = createStarterWorkflow({
    workflowId: "workflow-future-run-index",
    promptNodeId: "prompt-1",
    generationNodeId: "generate-1",
    outputNodeId: "output-1",
    promptEdgeId: "edge-prompt",
    outputEdgeId: "edge-output",
    now: NOW,
  });
  await first.mutateWorkflow(workflow.id, [], () => first.workflows.create(workflow));

  const futureIndex = '{"version":2,"revision":1,"entries":[]}\n';
  const indexPath = path.join(root, "run-index.json");
  await fs.writeFile(indexPath, futureIndex, "utf8");
  const restarted = new CreateImagesService(root, serviceOptions(now));

  await assert.rejects(restarted.initialize());
  await restarted.initializeReadOnlyLibrary();
  assert.deepEqual(
    (await restarted.workflows.list()).map(({ id, title }) => ({ id, title })),
    [{ id: workflow.id, title: workflow.title }],
  );
  assert.deepEqual(await restarted.runs.journals.indexHealth(), { status: "unsafe" });
  assert.equal(await fs.readFile(indexPath, "utf8"), futureIndex);
  await assert.rejects(
    restarted.runs.start(
      {
        workflowId: workflow.id,
        expectedRevision: workflow.revision,
        scope: { kind: "all" },
      },
      () => true,
    ),
  );
  assert.equal(await fs.readFile(indexPath, "utf8"), futureIndex);
});

test("an authoritative run-free workflow can still be deleted through the lifecycle fence", async (t) => {
  const root = await temporaryRoot(t);
  const service = new CreateImagesService(
    root,
    serviceOptions(() => Date.parse(NOW)),
  );
  const workflow = createStarterWorkflow({
    workflowId: "workflow-without-runs",
    promptNodeId: "prompt-1",
    generationNodeId: "generate-1",
    outputNodeId: "output-1",
    promptEdgeId: "edge-prompt",
    outputEdgeId: "edge-output",
    now: NOW,
  });
  await service.mutateWorkflow(workflow.id, [], () => service.workflows.create(workflow));

  assert.deepEqual(await service.deleteWorkflow(workflow.id, workflow.revision, () => true), {
    status: "deleted",
  });
  assert.equal(await service.workflows.get(workflow.id), undefined);
  assert.deepEqual(await service.runs.list(workflow.id), { status: "not-found" });
});

test("same-process unassociated corruption is discovered authoritatively before deletion", async (t) => {
  const root = await temporaryRoot(t);
  const service = new CreateImagesService(
    root,
    serviceOptions(() => Date.parse(NOW)),
  );
  const workflow = createStarterWorkflow({
    workflowId: "workflow-post-init-unassociated-run",
    promptNodeId: "prompt-1",
    generationNodeId: "generate-1",
    outputNodeId: "output-1",
    promptEdgeId: "edge-prompt",
    outputEdgeId: "edge-output",
    now: NOW,
  });
  await service.mutateWorkflow(workflow.id, [], () => service.workflows.create(workflow));
  assert.equal(await service.runs.journals.hasUnassociatedDegradedRuns(), false);

  const injectedRunRoot = path.join(root, "runs", "post-init-unassociated-run");
  await fs.mkdir(injectedRunRoot);
  await Promise.all([
    fs.writeFile(path.join(injectedRunRoot, "run.json"), "{broken-current", "utf8"),
    fs.writeFile(
      path.join(injectedRunRoot, "run.last-known-good.json"),
      "{broken-recovery",
      "utf8",
    ),
  ]);
  assert.equal(await service.runs.journals.hasUnassociatedDegradedRuns(), false);

  const deletion = await service.deleteWorkflow(workflow.id, workflow.revision, () => true);
  assert.equal(deletion.status, "unavailable");
  if (deletion.status === "unavailable") {
    assert.match(deletion.message, /unassociated run recovery authority/u);
  }
  assert.deepEqual(await service.workflows.get(workflow.id), workflow);
  assert.equal(await service.runs.journals.hasUnassociatedDegradedRuns(), true);
});

test("unassociated degraded run authority blocks workflow deletion after restart", async (t) => {
  const root = await temporaryRoot(t);
  let clock = Date.parse(NOW);
  const now = () => clock++;
  const first = new CreateImagesService(root, serviceOptions(now));
  const workflow = createStarterWorkflow({
    workflowId: "workflow-unassociated-degraded-run",
    promptNodeId: "prompt-1",
    generationNodeId: "generate-1",
    outputNodeId: "output-1",
    promptEdgeId: "edge-prompt",
    outputEdgeId: "edge-output",
    now: NOW,
  });
  const prompt = workflow.nodes.find((node) => node.id === "prompt-1");
  const generation = workflow.nodes.find((node) => node.id === "generate-1");
  assert.equal(prompt?.type, "prompt");
  assert.equal(generation?.type, "generate-image");
  if (!prompt || prompt.type !== "prompt" || !generation || generation.type !== "generate-image") {
    return;
  }
  prompt.data.text = "Preserve this unassociated degraded run";
  generation.data.providerId = "gemini";
  generation.data.modelId = "gemini-3.1-flash-image";
  await first.mutateWorkflow(workflow.id, [], () => first.workflows.create(workflow));
  const started = await first.runs.start(
    {
      workflowId: workflow.id,
      expectedRevision: workflow.revision,
      scope: { kind: "all" },
    },
    () => true,
  );
  assert.equal(started.status, "started");
  if (started.status !== "started") return;
  await waitUntil("the run to become terminal", async () => {
    const journal = await first.runs.journals.get(started.run.runId);
    return journal && projectCreateImagesRun(journal).terminal ? journal : undefined;
  });

  const runRoot = path.join(root, "runs", started.run.runId);
  await Promise.all([
    fs.writeFile(path.join(runRoot, "run.json"), "{broken-current", "utf8"),
    fs.writeFile(path.join(runRoot, "run.last-known-good.json"), "{broken-recovery", "utf8"),
    fs.rm(path.join(root, "run-index.json")),
  ]);
  const restarted = new CreateImagesService(root, serviceOptions(now));
  await restarted.initialize();
  assert.equal(await restarted.runs.journals.hasUnassociatedDegradedRuns(), true);

  const deletion = await restarted.deleteWorkflow(workflow.id, workflow.revision, () => true);
  assert.equal(deletion.status, "unavailable");
  if (deletion.status === "unavailable") {
    assert.match(deletion.message, /unassociated run recovery authority/u);
  }
  assert.deepEqual(await restarted.workflows.get(workflow.id), workflow);
  assert.equal(await restarted.runs.journals.hasUnassociatedDegradedRuns(), true);
});

test("production services preserve a multi-output local run, ownership, and GC protection across restart", async (t) => {
  const root = await temporaryRoot(t);
  let clock = Date.parse(NOW);
  const now = () => clock++;
  const first = new CreateImagesService(root, serviceOptions(now));
  await first.initialize();

  const workflow = createStarterWorkflow({
    workflowId: "phase-three-production-join",
    promptNodeId: "prompt-1",
    generationNodeId: "generate-1",
    outputNodeId: "output-1",
    promptEdgeId: "edge-prompt",
    outputEdgeId: "edge-output",
    now: NOW,
  });
  const generation = workflow.nodes.find((node) => node.id === "generate-1");
  const prompt = workflow.nodes.find((node) => node.id === "prompt-1");
  assert.equal(generation?.type, "generate-image");
  assert.equal(prompt?.type, "prompt");
  if (!generation || generation.type !== "generate-image" || !prompt || prompt.type !== "prompt") {
    return;
  }
  prompt.data.text = "A deterministic three-image production join";
  generation.data.providerId = "gemini";
  generation.data.modelId = "gemini-3.1-flash-image";
  generation.data.count = 3;
  await first.mutateWorkflow(workflow.id, [], () => first.workflows.create(workflow));
  assert.deepEqual(await first.workflows.get(workflow.id), workflow);

  const started = await first.runs.start(
    {
      workflowId: workflow.id,
      expectedRevision: workflow.revision,
      scope: { kind: "all" },
    },
    () => true,
  );
  assert.equal(started.status, "started");
  if (started.status !== "started") return;
  const runId = started.run.runId;

  const terminalJournal = await waitUntil("the durable local run to finish", async () => {
    const journal = await first.runs.journals.get(runId);
    return journal && projectCreateImagesRun(journal).terminal ? journal : undefined;
  });
  const terminalList = await waitUntil("the completed run to leave active state", async () => {
    const snapshot = await first.runs.list(workflow.id);
    return snapshot.status === "ready" &&
      snapshot.activeRun === undefined &&
      snapshot.history.some((entry) => entry.runId === runId)
      ? snapshot
      : undefined;
  });
  const projection = projectCreateImagesRun(terminalJournal);
  assert.equal(projection.status, "succeeded");
  const generatedAssetIds = projection.nodes["generate-1"]?.outputAssetIds ?? [];
  assert.equal(generatedAssetIds.length, 3);
  assert.equal(new Set(generatedAssetIds).size, 3);
  assert.equal(
    terminalList.history.find((entry) => entry.runId === runId)?.outputCount,
    generatedAssetIds.length,
  );
  assert.equal(terminalList.history.find((entry) => entry.runId === runId)?.requestCount, 1);
  assert.deepEqual(
    terminalList.latestTerminalRun?.nodes.find((node) => node.nodeId === "generate-1")
      ?.outputAssetIds,
    generatedAssetIds,
  );
  const acceptedIndex = terminalJournal.events.findIndex(
    (event) => event.type === "node-submission-accepted" && event.nodeId === "generate-1",
  );
  const succeededIndex = terminalJournal.events.findIndex(
    (event) => event.type === "node-succeeded" && event.nodeId === "generate-1",
  );
  assert.ok(acceptedIndex >= 0 && succeededIndex > acceptedIndex);

  for (const assetId of generatedAssetIds) {
    const asset = await first.assets.getAvailable(assetId);
    assert.ok(asset);
    assert.deepEqual(asset.origin, {
      kind: "provider",
      providerId: "local-mock",
      modelId: "deterministic-v1",
      runId,
    });
    assert.equal(first.references.isRunAssetReferenced(runId, assetId), true);
    assert.equal(await first.runs.isRunAssetReferenced(workflow.id, runId, assetId), true);
  }
  const firstGc = await first.assets.planGarbageCollection(0);
  assert.deepEqual(
    firstGc.candidateAssetIds.filter((assetId) => generatedAssetIds.includes(assetId)),
    [],
  );

  const firstIndex = JSON.parse(
    await fs.readFile(path.join(root, "asset-index.json"), "utf8"),
  ) as StoredAssetIndex;
  assert.equal(firstIndex.schemaVersion, 1);
  for (const assetId of generatedAssetIds) {
    assert.deepEqual(firstIndex.assets[assetId]?.referenceOwners, [`run:${runId}`]);
  }

  clock += 1_000;
  const restarted = new CreateImagesService(root, serviceOptions(now));
  await restarted.initialize();
  assert.deepEqual(await restarted.workflows.get(workflow.id), workflow);
  const restartedJournal = await restarted.runs.journals.get(runId);
  assert.ok(restartedJournal);
  assert.equal(restartedJournal && projectCreateImagesRun(restartedJournal).status, "succeeded");
  assert.deepEqual(
    restartedJournal &&
      projectCreateImagesRun(restartedJournal).nodes["generate-1"]?.outputAssetIds,
    generatedAssetIds,
  );
  const restartedList = await restarted.runs.list(workflow.id);
  assert.equal(restartedList.status, "ready");
  if (restartedList.status !== "ready") return;
  assert.equal(restartedList.activeRun, undefined);
  assert.equal(restartedList.history.find((entry) => entry.runId === runId)?.status, "succeeded");
  assert.equal(
    restartedList.history.find((entry) => entry.runId === runId)?.outputCount,
    generatedAssetIds.length,
  );
  assert.deepEqual(
    restartedList.latestTerminalRun?.nodes.find((node) => node.nodeId === "generate-1")
      ?.outputAssetIds,
    generatedAssetIds,
  );
  const deletion = await restarted.deleteWorkflow(workflow.id, workflow.revision, () => true);
  assert.equal(deletion.status, "unavailable");
  if (deletion.status === "unavailable") assert.match(deletion.message, /retained run history/u);
  assert.deepEqual(await restarted.workflows.get(workflow.id), workflow);
  const retainedList = await restarted.runs.list(workflow.id);
  assert.equal(retainedList.status, "ready");
  assert.equal(
    retainedList.status === "ready"
      ? retainedList.history.some((entry) => entry.runId === runId)
      : false,
    true,
  );
  const retainedDetail = await restarted.runs.get(workflow.id, runId);
  assert.equal(retainedDetail.status, "ready");
  assert.equal(retainedDetail.status === "ready" ? retainedDetail.run.runId : undefined, runId);
  for (const assetId of generatedAssetIds) {
    assert.ok(await restarted.assets.getAvailable(assetId));
    assert.equal(restarted.references.isRunAssetReferenced(runId, assetId), true);
    assert.equal(await restarted.runs.isRunAssetReferenced(workflow.id, runId, assetId), true);
  }
  const restartedGc = await restarted.assets.planGarbageCollection(0);
  assert.deepEqual(
    restartedGc.candidateAssetIds.filter((assetId) => generatedAssetIds.includes(assetId)),
    [],
  );
  const restartedIndex = JSON.parse(
    await fs.readFile(path.join(root, "asset-index.json"), "utf8"),
  ) as StoredAssetIndex;
  for (const assetId of generatedAssetIds) {
    assert.deepEqual(restartedIndex.assets[assetId]?.referenceOwners, [`run:${runId}`]);
  }
});

test("transient publication contention retains every renderer-disconnect run owner", () => {
  const runIds = ["run-1", "run-2", "run-3", "run-4"];
  for (const status of ["unavailable", "busy", "not-found"]) {
    assert.deepEqual(
      runIds.map((runId) => shouldReleaseCreateImagesRunOwner(runId, { status })),
      [false, false, false, false],
    );
  }
  assert.deepEqual(
    runIds.map((runId) =>
      shouldReleaseCreateImagesRunOwner(runId, {
        status: "ready",
        activeRun: { runId: "run-1" },
      }),
    ),
    [false, true, true, true],
  );
  assert.deepEqual(
    runIds.map((runId) => shouldReleaseCreateImagesRunOwner(runId, { status: "ready" })),
    [true, true, true, true],
  );
});

test("durable workflow recovery and asset-picking handlers initialize fully before side effects", async () => {
  const handlers = (await fs.readFile(path.resolve("main/handlers/create-images.ts"), "utf8"))
    .replace(/\s+/gu, " ")
    .replace(/\( /gu, "(");
  const handlerSlice = (channel: string, nextChannel: string): string => {
    const start = handlers.indexOf(`ipcMain.handle("${channel}"`);
    const end = handlers.indexOf(`ipcMain.handle("${nextChannel}"`, start + 1);
    assert.ok(start >= 0, `${channel} must be registered`);
    assert.ok(end > start, `${channel} must precede ${nextChannel}`);
    return handlers.slice(start, end);
  };
  const assertInitializedBefore = (
    channel: string,
    nextChannel: string,
    sideEffects: readonly string[],
  ): void => {
    const source = handlerSlice(channel, nextChannel);
    const initializedAt = source.indexOf("await service.initialize()");
    assert.ok(initializedAt >= 0, `${channel} must perform full service initialization`);
    for (const sideEffect of sideEffects) {
      const sideEffectAt = source.indexOf(sideEffect);
      assert.ok(sideEffectAt >= 0, `${channel} must retain ${sideEffect}`);
      assert.ok(initializedAt < sideEffectAt, `${channel} must initialize before ${sideEffect}`);
    }
  };

  assertInitializedBefore("imageWorkflows:recover", "imageWorkflows:repairRecoveryMetadata", [
    "service.workflows.recover(",
  ]);
  assertInitializedBefore(
    "imageWorkflows:repairRecoveryMetadata",
    "imageWorkflows:discardAutosave",
    ["service.workflows.repairRecoveryMetadata("],
  );
  assertInitializedBefore("imageWorkflows:discardAutosave", "imageWorkflows:pickAsset", [
    "service.workflows.discardAutosave(",
  ]);
  assertInitializedBefore("imageWorkflows:pickAsset", "imageWorkflows:grantAsset", [
    "dialog.showOpenDialog(",
    "ingestSelectedImage(service",
  ]);
});

test("workflow deletion uses the admission-fenced run lifecycle guard and honest UI copy", async () => {
  const [handlers, service, runService, view] = await Promise.all([
    fs.readFile(path.resolve("main/handlers/create-images.ts"), "utf8"),
    fs.readFile(path.resolve("main/services/create-images/create-images-service.ts"), "utf8"),
    fs.readFile(path.resolve("main/services/create-images/run-service.ts"), "utf8"),
    fs.readFile(path.resolve("renderer/create-images/create-images-view.tsx"), "utf8"),
  ]);
  const deleteHandler = handlers.slice(
    handlers.indexOf('ipcMain.handle("imageWorkflows:delete"'),
    handlers.indexOf('ipcMain.handle("imageWorkflows:recover"'),
  );
  assert.match(deleteHandler, /service\.deleteWorkflow\(/u);
  assert.doesNotMatch(deleteHandler, /service\.runs\.list|service\.workflows\.delete/u);
  assert.match(service, /this\.runs\.deleteWorkflowIfRunLifecycleEmpty\(/u);
  const deletionGuard = runService.slice(
    runService.indexOf("async deleteWorkflowIfRunLifecycleEmpty"),
    runService.indexOf(
      "async stop(",
      runService.indexOf("async deleteWorkflowIfRunLifecycleEmpty"),
    ),
  );
  const fenceAt = deletionGuard.indexOf("const previous = this.startAdmissionTail");
  const auditAt = deletionGuard.indexOf("await this.journals.auditWorkflowAdmission(workflowId)");
  const listAt = deletionGuard.indexOf("await this.list(workflowId)");
  const deleteAt = deletionGuard.indexOf("value: await deleteWorkflow()");
  assert.ok(fenceAt >= 0 && fenceAt < auditAt);
  assert.ok(auditAt < listAt && listAt < deleteAt);
  assert.match(deletionGuard, /evaluateCreateImagesWorkflowDeletion\(snapshot\)/u);
  assert.match(runService, /snapshot\.latestTerminalRun \|\| snapshot\.history\.length > 0/u);
  assert.match(runService, /snapshot\.recoveries\.length > 0/u);
  assert.match(view, /can be deleted only when it has no active run, retained run history/u);
  assert.match(view, /mutationMessage\(result, "Aiden could not delete the workflow\."\)/u);
});

test("main, preload, and renderer sources keep the exact run lifecycle and authorization contract", async () => {
  const [handlers, preloadChannels, preload, rendererIpc, main] = await Promise.all([
    fs.readFile(path.resolve("main/handlers/create-images.ts"), "utf8"),
    fs.readFile(path.resolve("renderer/preload-channels.ts"), "utf8"),
    fs.readFile(path.resolve("renderer/preload.ts"), "utf8"),
    fs.readFile(path.resolve("renderer/lib/ipc.ts"), "utf8"),
    fs.readFile(path.resolve("main/index.ts"), "utf8"),
  ]);

  const runHandlerChannels = [
    ...handlers.matchAll(/ipcMain\.handle\(\s*"(imageWorkflows:[^"]+)"/gu),
  ]
    .map((match) => match[1]!)
    .filter((channel) => /Run|Runs/u.test(channel))
    .sort();
  assert.deepEqual(runHandlerChannels, [
    "imageWorkflows:discardDegradedRun",
    "imageWorkflows:downloadRunAsset",
    "imageWorkflows:getRun",
    "imageWorkflows:grantRunAsset",
    "imageWorkflows:listRuns",
    "imageWorkflows:planDegradedRunDiscard",
    "imageWorkflows:planRunHistoryPrune",
    "imageWorkflows:prepareRun",
    "imageWorkflows:pruneRunHistory",
    "imageWorkflows:recoverRun",
    "imageWorkflows:resolveRunAmbiguity",
    "imageWorkflows:startRun",
    "imageWorkflows:stopRun",
    "imageWorkflows:subscribeRuns",
    "imageWorkflows:unsubscribeRuns",
  ]);

  const ownerBinding = handlers.slice(
    handlers.indexOf("const bindRunToOwner"),
    handlers.indexOf('ipcMain.handle("imageWorkflows:list"'),
  );
  assert.match(ownerBinding, /owner\.onInvalidated\(invalidate\)/u);
  assert.match(
    ownerBinding,
    /runs\.stop\(\s*workflowId,\s*runId,\s*"renderer-disconnected",?\s*\)/u,
  );
  const normalizedHandlers = handlers.replace(/\s+/gu, " ").replace(/\( /gu, "(");
  assert.match(
    normalizedHandlers,
    /runs\.start\(\{ workflowId: input\.workflowId, expectedRevision: input\.expectedRevision, scope: input\.scope, executionMode: input\.consent\.executionMode,/u,
  );
  assert.match(
    normalizedHandlers,
    /if \(result\.status === "started"\) \{ bindRunToOwner\(owner, input\.workflowId, result\.run\.runId\); \}/u,
  );

  const grantRunAsset = normalizedHandlers.slice(
    normalizedHandlers.indexOf('ipcMain.handle("imageWorkflows:grantRunAsset"'),
    normalizedHandlers.indexOf('ipcMain.handle("imageWorkflows:storageHealth"'),
  );
  assert.match(
    grantRunAsset,
    /service\.runs\.isRunAssetReferenced\(input\.workflowId, input\.runId, input\.assetId, \)/u,
  );
  assert.match(
    grantRunAsset,
    /service\.references\.isRunAssetReferenced\(input\.runId, input\.assetId\)/u,
  );
  assert.match(
    grantRunAsset,
    /service\.grantAsset\(owner, input\.assetId, \(assetId\) => service\.references\.isRunAssetReferenced\(input\.runId, assetId\), \)/u,
  );

  assert.match(preloadChannels, /"imageWorkflows:run-changed"/u);
  assert.match(preload, /NOTIFICATION_CHANNELS\.has\(channel\)/u);
  const expectedRendererChannels = [
    "imageWorkflows:prepareRun",
    "imageWorkflows:startRun",
    "imageWorkflows:stopRun",
    "imageWorkflows:listRuns",
    "imageWorkflows:planRunHistoryPrune",
    "imageWorkflows:pruneRunHistory",
    "imageWorkflows:getRun",
    "imageWorkflows:recoverRun",
    "imageWorkflows:subscribeRuns",
    "imageWorkflows:unsubscribeRuns",
    "imageWorkflows:grantRunAsset",
    "imageWorkflows:downloadRunAsset",
    "imageWorkflows:run-changed",
  ];
  for (const channel of expectedRendererChannels) {
    assert.ok(rendererIpc.includes(`"${channel}"`), `${channel} must be wired by renderer IPC`);
  }

  assert.match(handlers, /The subscription is live before this initial read begins/u);
  const workflowListHandler = normalizedHandlers.slice(
    normalizedHandlers.indexOf('ipcMain.handle("imageWorkflows:list"'),
    normalizedHandlers.indexOf('ipcMain.handle("imageWorkflows:get"'),
  );
  assert.match(workflowListHandler, /service\.initializeReadOnlyLibrary\(\)/u);
  const startRunHandler = normalizedHandlers.slice(
    normalizedHandlers.indexOf('ipcMain.handle("imageWorkflows:startRun"'),
    normalizedHandlers.indexOf('ipcMain.handle("imageWorkflows:stopRun"'),
  );
  assert.match(
    startRunHandler,
    /await runBounded\(owner\.id, \(\) => createImagesService\(\)\.runs\.start/u,
  );
  assert.match(startRunHandler, /if \(bounded\.status === "busy"\) return runRateFailure\(\)/u);
  const subscriptionHandler = normalizedHandlers.slice(
    normalizedHandlers.indexOf('ipcMain.handle("imageWorkflows:subscribeRuns"'),
    normalizedHandlers.indexOf('ipcMain.handle("imageWorkflows:getRun"'),
  );
  assert.match(subscriptionHandler, /const subscriptionId = randomUUID\(\)/u);
  assert.doesNotMatch(subscriptionHandler, /runSubscriptions\.entries\(\)|const existing/u);
  const recoverRunHandler = normalizedHandlers.slice(
    normalizedHandlers.indexOf('ipcMain.handle("imageWorkflows:recoverRun"'),
    normalizedHandlers.indexOf('ipcMain.handle("imageWorkflows:planRunHistoryPrune"'),
  );
  assert.match(recoverRunHandler, /await runBounded\(owner\.id, async \(\) =>/u);
  assert.match(
    recoverRunHandler,
    /return bounded\.status === "completed" \? bounded\.value : runRateFailure\(\)/u,
  );
  assert.match(handlers, /streamSequence: subscription\.streamSequence/u);
  assert.match(handlers, /readRateLimiter/u);
  assert.match(handlers, /readOwnerKey/u);
  assert.doesNotMatch(handlers, /document:\$\{owner\.documentId\}:run-read/u);
  assert.match(handlers, /runBounded/u);
  assert.match(handlers, /readAllowed\(owner, 12\)/u);
  const storageHealthHandler = normalizedHandlers.slice(
    normalizedHandlers.indexOf('ipcMain.handle("imageWorkflows:storageHealth"'),
  );
  assert.match(storageHealthHandler, /if \(!readAllowed\(owner, 12\)\)/u);
  assert.match(storageHealthHandler, /await runBounded\(owner\.id, async \(\) =>/u);
  assert.match(storageHealthHandler, /service\.initializeReadOnlyLibrary\(\)/u);
  assert.match(storageHealthHandler, /if \(bounded\.status === "busy"\)/u);
  assert.match(handlers, /activeRunOperations >= 8 \|\| ownerOperations >= 2/u);
  assert.match(handlers, /runSubscriptions\.size >= 128/u);
  assert.match(handlers, /runPublicationStates\.size >= 256/u);
  assert.match(handlers, /attempt < 3 && !snapshot/u);
  assert.match(handlers, /shouldReleaseCreateImagesRunOwner\(runId, snapshot\)/u);
  assert.doesNotMatch(handlers, /snapshot\.status !== "ready" \|\|\s*snapshot\.activeRun/u);
  assert.match(handlers, /service\.runs\.journals\.indexHealth\(\)/u);
  assert.match(handlers, /runIndex\.diagnostic === "rebuilt-corrupt-index"/u);
  assert.match(handlers, /service\.workflows\.get\(workflowId\)/u);
  assert.match(handlers, /parseCreateImagesResolveRunAmbiguityRequest/u);
  assert.match(handlers, /runs\.resolveRunAmbiguity\(input\)/u);
  assert.match(main, /activeImageRunsWithinQuitDeadline/u);
  assert.match(main, /stopped\.status === "blocked"/u);
  assert.match(main, /confirmActiveImageRunsBeforeQuit/u);
  assert.match(main, /"Keep Aiden Open", stopLabel/u);
  assert.match(main, /showQuitMessageBox\(window/u);
  assert.match(main, /dialog\.showMessageBoxSync\(options\)/u);
  assert.match(main, /confirmActiveImageRunsBeforeQuit\(\)/u);
  assert.match(
    main,
    /function resumeCreateImagesAfterCancelledShutdown\(\): void \{[\s\S]*?resumeRunAdmissionsAfterCancelledShutdown\(\);[\s\S]*?\}/u,
  );
  const applicationQuit = main.slice(
    main.indexOf("async function requestApplicationQuit"),
    main.indexOf("async function clearRendererOnboardingCompletion"),
  );
  assert.match(
    applicationQuit,
    /finally \{[\s\S]*?if \(!shutdownStarted\) resumeCreateImagesAfterCancelledShutdown\(\);/u,
  );
  const shutdownAndQuit = main.slice(
    main.indexOf("async function shutdownAndQuit"),
    main.indexOf("async function refreshCloseGuardFromRenderer"),
  );
  assert.match(
    shutdownAndQuit,
    /computerUseSettings\.resumeAfterCancelledShutdown\(\);\s*resumeCreateImagesAfterCancelledShutdown\(\);/u,
  );
  const beforeQuit = main.slice(
    main.indexOf('app.on("before-quit"'),
    main.indexOf('app.on("will-quit"'),
  );
  assert.ok(
    beforeQuit.indexOf("confirmActiveImageRunsBeforeQuit()") <
      beforeQuit.indexOf("shutdownAndQuit()"),
    "windowless quit must confirm active image runs before shutdown can stop them",
  );

  assert.equal(main.match(/createImagesService\(\)\.runs\.stopAll\("app-quit"\)/gu)?.length, 2);
});

test("Phase 4 provider status is a bounded main-owned API-key capability read", async () => {
  const [handlers, statusCore, providerRegistry, rendererIpc, queries, preloadChannels] =
    await Promise.all([
      fs.readFile(path.resolve("main/handlers/create-images.ts"), "utf8"),
      fs.readFile(
        path.resolve("main/services/create-images/gemini-provider-status-core.ts"),
        "utf8",
      ),
      fs.readFile(path.resolve("main/services/provider-registry.ts"), "utf8"),
      fs.readFile(path.resolve("renderer/lib/ipc.ts"), "utf8"),
      fs.readFile(path.resolve("renderer/lib/queries.ts"), "utf8"),
      fs.readFile(path.resolve("renderer/preload-channels.ts"), "utf8"),
    ]);

  const normalizedHandlers = handlers.replace(/\s+/gu, " ").replace(/\( /gu, "(");
  const providerStatusHandler = normalizedHandlers.slice(
    normalizedHandlers.indexOf('ipcMain.handle("imageWorkflows:providerStatus"'),
    normalizedHandlers.indexOf('ipcMain.handle("imageWorkflows:list"'),
  );
  assert.match(providerStatusHandler, /rendererDocumentOwner\(event/u);
  assert.match(providerStatusHandler, /if \(!readAllowed\(owner, 2\)\)/u);
  assert.match(providerStatusHandler, /await runBounded\(owner\.id/u);
  assert.match(
    providerStatusHandler,
    /providerRegistry\.getBuiltinCredentialKind\(CREATE_IMAGES_GEMINI_CREDENTIAL_PROVIDER_ID/u,
  );
  assert.match(
    providerStatusHandler,
    /providerRegistry\.getBuiltinRequestAuth\(CREATE_IMAGES_GEMINI_CREDENTIAL_PROVIDER_ID\)/u,
  );
  assert.match(providerStatusHandler, /bounded\.status === "busy" \|\| owner\.isDestroyed\(\)/u);
  assert.doesNotMatch(providerStatusHandler, /console\.|onNotification|apiKey/u);

  assert.match(statusCore, /CREATE_IMAGES_GEMINI_CREDENTIAL_PROVIDER_ID = "google"/u);
  assert.match(statusCore, /kind !== "api_key"/u);
  assert.match(statusCore, /usableApiKey\(auth\)/u);
  assert.match(providerRegistry, /async getBuiltinCredentialKind\(/u);
  assert.match(providerRegistry, /await this\.credentials\.list\(\)/u);
  assert.match(providerRegistry, /this\.models\.getAuth\(providerId\)/u);

  assert.match(
    rendererIpc,
    /providerStatus:\s*\(\) =>\s*invoke<CreateImagesProviderStatus>\("imageWorkflows:providerStatus"\)/u,
  );
  assert.match(queries, /createImagesProviderStatus: \["createImagesProviderStatus", "gemini"\]/u);
  assert.match(queries, /export function useCreateImagesProviderStatus\(enabled = true\)/u);
  assert.match(queries, /queryFn: createImagesApi\.providerStatus/u);
  assert.match(queries, /retry: false/u);
  assert.match(queries, /refetchOnWindowFocus: true/u);
  assert.match(preloadChannels, /"imageWorkflows:"/u);
  assert.doesNotMatch(preloadChannels, /imageWorkflows:provider-status-changed/u);
});
