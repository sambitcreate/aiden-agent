import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test, { type TestContext } from "node:test";
import {
  CREATE_IMAGES_SCHEMA_VERSION,
  createStarterWorkflow,
} from "../../../renderer/shared/create-images/schema.js";
import {
  WorkflowManifestLoadError,
  WorkflowManifestStore,
  WorkflowRevisionConflictError,
} from "./workflow-manifest-store.js";

async function harness(t: TestContext) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-create-images-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { directory, store: new WorkflowManifestStore(() => directory) };
}

function workflow(workflowId = "workflow-1", now = "2026-08-11T12:00:00.000Z") {
  return createStarterWorkflow({
    workflowId,
    promptNodeId: `${workflowId}-prompt`,
    generationNodeId: `${workflowId}-generate`,
    outputNodeId: `${workflowId}-output`,
    promptEdgeId: `${workflowId}-edge-1`,
    outputEdgeId: `${workflowId}-edge-2`,
    now,
  });
}

function nextRevision(
  current: ReturnType<typeof workflow>,
  title: string,
  updatedAt = "2026-08-11T12:01:00.000Z",
) {
  return { ...structuredClone(current), title, revision: current.revision + 1, updatedAt };
}

test("workflow manifests persist independently with a rebuildable metadata-only index", async (t) => {
  const { directory, store } = await harness(t);
  assert.deepEqual(await store.health(), {
    status: "healthy",
    source: "missing",
    path: path.join(directory, "index.json"),
  });
  const first = workflow();
  await store.create(first);
  assert.deepEqual(await store.get(first.id), first);
  assert.deepEqual(await store.list(), [
    {
      id: first.id,
      title: first.title,
      revision: 1,
      createdAt: first.createdAt,
      updatedAt: first.updatedAt,
      nodeCount: 3,
      edgeCount: 2,
      assetCount: 0,
      health: "healthy",
      recoveryAvailable: true,
    },
  ]);
  assert.deepEqual(await store.health(), {
    status: "healthy",
    source: "disk",
    path: path.join(directory, "index.json"),
  });
  assert.deepEqual((await fs.readdir(path.join(directory, "workflows", first.id))).sort(), [
    "workflow.json",
    "workflow.last-known-good.json",
  ]);
  const indexText = await fs.readFile(path.join(directory, "index.json"), "utf8");
  assert.equal(indexText.includes("nodes"), false);
  assert.equal(indexText.includes("prompt"), false);
});

test("save, rename, duplicate, and recoverable delete enforce exact revisions", async (t) => {
  const { directory, store } = await harness(t);
  const first = workflow();
  await store.put(first, null);
  await assert.rejects(
    () => store.put(nextRevision(first, "stale create"), null),
    WorkflowRevisionConflictError,
  );
  const saved = nextRevision(first, "Saved revision");
  await store.put(saved, 1);
  await assert.rejects(() => store.delete(first.id, 1), WorkflowRevisionConflictError);
  const renamed = await store.rename(first.id, "Renamed", 2, "2026-08-11T12:02:00.000Z");
  assert.equal(renamed.revision, 3);
  assert.equal(renamed.title, "Renamed");
  await assert.rejects(
    () =>
      store.duplicate(first.id, {
        workflowId: "stale-copy",
        expectedRevision: 2,
        now: "2026-08-11T12:03:00.000Z",
      }),
    WorkflowRevisionConflictError,
  );
  const duplicate = await store.duplicate(first.id, {
    workflowId: "workflow-copy",
    expectedRevision: 3,
    title: "A durable copy",
    now: "2026-08-11T12:03:00.000Z",
  });
  assert.equal(duplicate.id, "workflow-copy");
  assert.equal(duplicate.revision, 1);
  assert.equal(duplicate.nodes.length, renamed.nodes.length);
  assert.deepEqual(await store.delete(first.id, 3), renamed);
  assert.equal(await store.get(first.id), undefined);
  assert.deepEqual(
    (await store.list()).map((item) => item.id),
    ["workflow-copy"],
  );
  const deletedQuarantine = path.join(directory, "quarantine", "deleted-workflows");
  const quarantined = await fs.readdir(deletedQuarantine);
  assert.equal(quarantined.length, 1);
  const quarantineEntry = quarantined[0];
  assert.ok(quarantineEntry?.startsWith("deleted-workflow-1-"));
  const quarantinePath = path.join(deletedQuarantine, quarantineEntry);
  assert.equal((await fs.lstat(quarantinePath)).isDirectory(), true);
  assert.deepEqual((await fs.readdir(quarantinePath)).sort(), [
    "workflow.json",
    "workflow.last-known-good.json",
  ]);
});

test("concurrent stores serialize mutations and reject the stale autosave", async (t) => {
  const { directory, store } = await harness(t);
  const first = workflow();
  await store.put(first, null);
  const left = new WorkflowManifestStore(() => directory);
  const right = new WorkflowManifestStore(() => directory);
  const results = await Promise.allSettled([
    left.put(nextRevision(first, "Left"), 1),
    right.put(nextRevision(first, "Right"), 1),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = results.find((result) => result.status === "rejected");
  assert.equal(rejected?.status, "rejected");
  if (rejected?.status === "rejected") {
    assert.equal(rejected.reason instanceof WorkflowRevisionConflictError, true);
  }
  const current = await new WorkflowManifestStore(() => directory).get(first.id);
  assert.equal(current?.revision, 2);
  assert.equal(["Left", "Right"].includes(current?.title ?? ""), true);
  assert.equal((await store.list())[0]?.revision, 2);
});

test("autosave can be staged, observed, flushed, and discarded with CAS", async (t) => {
  const { store } = await harness(t);
  const first = workflow();
  await store.put(first, null);
  const second = nextRevision(first, "Pending autosave");
  await store.stageAutosave(second, 1);
  assert.deepEqual(await store.autosaveStatus(first.id), {
    workflowId: first.id,
    state: "pending",
    baseRevision: 1,
    targetRevision: 2,
    stagedAt: second.updatedAt,
  });
  const pendingHealth = await store.inspect(first.id);
  assert.equal(pendingHealth.status, "recovery-required");
  if (pendingHealth.status === "recovery-required") {
    assert.equal(pendingHealth.reason, "journal-pending");
  }
  await assert.rejects(() => store.get(first.id), WorkflowManifestLoadError);
  await assert.rejects(() => store.flushAutosave(first.id, null), WorkflowRevisionConflictError);
  assert.deepEqual(await store.flushAutosave(first.id, 1), second);
  assert.deepEqual(await store.autosaveStatus(first.id), {
    workflowId: first.id,
    state: "none",
  });

  const third = nextRevision(second, "Discard me", "2026-08-11T12:02:00.000Z");
  await store.stageAutosave(third, 2);
  await assert.rejects(() => store.discardAutosave(first.id, 4), WorkflowRevisionConflictError);
  await store.discardAutosave(first.id, 3);
  assert.equal((await store.get(first.id))?.revision, 2);
});

test("a crash-survived newer journal requires explicit autosave recovery", async (t) => {
  const { directory, store } = await harness(t);
  const first = workflow();
  await store.put(first, null);
  const second = nextRevision(first, "Journal survived");
  const interrupted = new WorkflowManifestStore(() => directory, {
    afterJournalPublished: async () => {
      throw new Error("simulated journal crash");
    },
  });
  await assert.rejects(() => interrupted.put(second, 1), /simulated journal crash/u);
  const reopened = new WorkflowManifestStore(() => directory);
  const journalPath = path.join(directory, "workflows", first.id, "autosave.journal");
  const durableJournal = await fs.readFile(journalPath, "utf8");
  const health = await reopened.inspect(first.id);
  assert.equal(health.status, "recovery-required");
  if (health.status === "recovery-required") assert.equal(health.reason, "journal-pending");
  await assert.rejects(() => reopened.get(first.id), WorkflowManifestLoadError);
  await assert.rejects(
    () => reopened.stageAutosave(nextRevision(first, "Must not replace it"), 1),
    WorkflowManifestLoadError,
  );
  assert.equal(await fs.readFile(journalPath, "utf8"), durableJournal);
  assert.equal((await reopened.autosaveStatus(first.id)).state, "pending");
  const recovered = await reopened.recover(first.id, "autosave", 2, "2026-08-11T12:03:00.000Z");
  assert.equal(recovered.title, second.title);
  assert.equal(recovered.revision, 3);
  assert.equal((await reopened.inspect(first.id)).status, "healthy");
});

test("a crash after current publication is idempotently reconciled on restart", async (t) => {
  for (const entrypoint of ["initialize", "get"] as const) {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), `aiden-create-images-${entrypoint}-reconcile-`),
    );
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const first = workflow(`workflow-${entrypoint}`);
    await new WorkflowManifestStore(() => directory).put(first, null);
    const second = nextRevision(first, "Current survived");
    const interrupted = new WorkflowManifestStore(() => directory, {
      afterCurrentPublished: async () => {
        throw new Error("simulated post-current crash");
      },
    });
    await assert.rejects(() => interrupted.put(second, 1), /simulated post-current crash/u);

    const workflowDirectory = path.join(directory, "workflows", first.id);
    const lastKnownGoodPath = path.join(workflowDirectory, "workflow.last-known-good.json");
    const journalPath = path.join(workflowDirectory, "autosave.journal");
    assert.deepEqual(JSON.parse(await fs.readFile(lastKnownGoodPath, "utf8")), first);
    await fs.access(journalPath);

    const reopened = new WorkflowManifestStore(() => directory);
    if (entrypoint === "initialize") {
      assert.equal((await reopened.initialize())[0]?.revision, second.revision);
    } else {
      assert.deepEqual(await reopened.get(first.id), second);
    }
    assert.deepEqual(JSON.parse(await fs.readFile(lastKnownGoodPath, "utf8")), second);
    await assert.rejects(() => fs.lstat(journalPath), { code: "ENOENT" });
    assert.deepEqual(await reopened.get(first.id), second);
    assert.equal((await reopened.autosaveStatus(first.id)).state, "none");
    assert.equal((await reopened.initialize())[0]?.health, "healthy");
  }
});

test("a divergent autosave conflict can be recovered without overwriting either revision", async (t) => {
  const { directory, store } = await harness(t);
  const first = workflow();
  await store.put(first, null);
  const autosave = nextRevision(first, "Autosaved branch");
  await store.stageAutosave(autosave, 1);
  const independentlySaved = nextRevision(first, "Saved elsewhere");
  await fs.writeFile(
    path.join(directory, "workflows", first.id, "workflow.json"),
    `${JSON.stringify(independentlySaved)}\n`,
    "utf8",
  );

  const reopened = new WorkflowManifestStore(() => directory);
  assert.deepEqual(await reopened.inspect(first.id), {
    status: "recovery-required",
    workflowId: first.id,
    currentPath: path.join(directory, "workflows", first.id, "workflow.json"),
    reason: "journal-conflict",
    currentRevision: 2,
    lastKnownGoodAvailable: true,
    lastKnownGoodRevision: 1,
    autosave: "pending",
    autosaveTargetRevision: 2,
  });
  await assert.rejects(() => reopened.get(first.id), WorkflowManifestLoadError);
  const recovered = await reopened.recover(first.id, "autosave", 2, "2026-08-11T12:04:00.000Z");
  assert.equal(recovered.title, "Autosaved branch");
  assert.equal(recovered.revision, 3);
  assert.equal((await reopened.inspect(first.id)).status, "healthy");
  assert.deepEqual(await reopened.autosaveStatus(first.id), {
    workflowId: first.id,
    state: "none",
  });
});

test("an autosave can recover when last-known-good metadata is also corrupt", async (t) => {
  const { directory, store } = await harness(t);
  const first = workflow();
  await store.put(first, null);
  const pending = nextRevision(first, "Pending survives damaged metadata");
  await store.stageAutosave(pending, 1);
  const lastGoodPath = path.join(directory, "workflows", first.id, "workflow.last-known-good.json");
  await fs.writeFile(lastGoodPath, "{broken", "utf8");

  const reopened = new WorkflowManifestStore(() => directory);
  const health = await reopened.inspect(first.id);
  assert.equal(health.status, "recovery-required");
  if (health.status === "recovery-required") {
    assert.equal(health.reason, "last-known-good-corrupt");
    assert.equal(health.autosave, "pending");
    assert.equal(health.autosaveTargetRevision, 2);
  }
  await assert.rejects(
    () => reopened.repairRecoveryMetadata(first.id, 1),
    /Flush or discard the pending autosave/u,
  );
  await assert.rejects(
    () => reopened.recover(first.id, "last-known-good", 1, "2026-08-11T12:04:00.000Z"),
    /healthy workflow does not require recovery/u,
  );
  const recovered = await reopened.recover(first.id, "autosave", 2, "2026-08-11T12:04:00.000Z");
  assert.equal(recovered.title, pending.title);
  assert.equal(recovered.revision, 3);
  assert.equal((await reopened.inspect(first.id)).status, "healthy");
});

test("corrupt current data opens recovery state and restores an incremented last-known-good", async (t) => {
  const { directory, store } = await harness(t);
  const first = workflow();
  await store.put(first, null);
  const currentPath = path.join(directory, "workflows", first.id, "workflow.json");
  await fs.writeFile(currentPath, "{broken", "utf8");
  const reopened = new WorkflowManifestStore(() => directory);
  assert.deepEqual(await reopened.inspect(first.id), {
    status: "recovery-required",
    workflowId: first.id,
    currentPath,
    reason: "current-corrupt",
    lastKnownGoodAvailable: true,
    lastKnownGoodRevision: 1,
    autosave: "none",
  });
  await assert.rejects(() => reopened.get(first.id), WorkflowManifestLoadError);
  await assert.rejects(
    () => reopened.put(nextRevision(first, "Never overwrite"), 1),
    WorkflowManifestLoadError,
  );
  assert.equal(await fs.readFile(currentPath, "utf8"), "{broken");
  const recovered = await reopened.recover(
    first.id,
    "last-known-good",
    1,
    "2026-08-11T12:05:00.000Z",
  );
  assert.equal(recovered.revision, 2);
  assert.equal((await reopened.inspect(first.id)).status, "healthy");
  assert.equal(
    (await fs.readdir(path.join(directory, "quarantine"))).some((name) =>
      name.startsWith(`${first.id}-current-corrupt-`),
    ),
    true,
  );
});

test("recovery advances past every durable candidate revision", async (t) => {
  const { directory, store } = await harness(t);
  const first = workflow();
  await store.put(first, null);
  const pending = nextRevision(first, "Newer pending edit");
  await store.stageAutosave(pending, 1);
  await fs.writeFile(
    path.join(directory, "workflows", first.id, "workflow.json"),
    "{broken",
    "utf8",
  );
  const reopened = new WorkflowManifestStore(() => directory);
  const recovered = await reopened.recover(
    first.id,
    "last-known-good",
    1,
    "2026-08-11T12:05:00.000Z",
  );
  assert.equal(recovered.revision, 3);
  assert.equal(recovered.title, first.title);
  assert.equal((await reopened.autosaveStatus(first.id)).state, "none");
});

test("missing current and corrupt journal states remain explicit and non-destructive", async (t) => {
  const { directory, store } = await harness(t);
  const first = workflow();
  await store.put(first, null);
  const paths = path.join(directory, "workflows", first.id);
  await fs.rm(path.join(paths, "workflow.json"));
  const missing = new WorkflowManifestStore(() => directory);
  const missingHealth = await missing.inspect(first.id);
  assert.equal(missingHealth.status, "recovery-required");
  if (missingHealth.status === "recovery-required") {
    assert.equal(missingHealth.reason, "current-missing");
  }
  await assert.rejects(() => missing.get(first.id), WorkflowManifestLoadError);
  const restored = await missing.recover(
    first.id,
    "last-known-good",
    1,
    "2026-08-11T12:06:00.000Z",
  );
  assert.equal(restored.revision, 2);

  await fs.writeFile(path.join(paths, "autosave.journal"), "{bad", "utf8");
  const corruptJournal = new WorkflowManifestStore(() => directory);
  assert.deepEqual(await corruptJournal.autosaveStatus(first.id), {
    workflowId: first.id,
    state: "corrupt",
  });
  await assert.rejects(
    () => corruptJournal.stageAutosave(nextRevision(restored, "blocked"), 2),
    WorkflowManifestLoadError,
  );
  assert.equal(await fs.readFile(path.join(paths, "autosave.journal"), "utf8"), "{bad");
  assert.equal((await corruptJournal.inspect(first.id)).status, "recovery-required");
  await corruptJournal.repairRecoveryMetadata(first.id, 2);
  assert.deepEqual(await corruptJournal.autosaveStatus(first.id), {
    workflowId: first.id,
    state: "none",
  });
  assert.equal((await corruptJournal.inspect(first.id)).status, "healthy");
});

test("future workflow and journal schemas are read-only and never quarantined implicitly", async (t) => {
  const { directory, store } = await harness(t);
  const first = workflow();
  await store.put(first, null);
  const workflowPath = path.join(directory, "workflows", first.id, "workflow.json");
  const future = `${JSON.stringify({ ...first, schemaVersion: CREATE_IMAGES_SCHEMA_VERSION + 1 })}\n`;
  await fs.writeFile(workflowPath, future, "utf8");
  const reopened = new WorkflowManifestStore(() => directory);
  const health = await reopened.inspect(first.id);
  assert.equal(health.status, "unsafe");
  await assert.rejects(() => reopened.get(first.id), WorkflowManifestLoadError);
  await assert.rejects(
    () => reopened.recover(first.id, "last-known-good", 1, "2026-08-11T12:07:00.000Z"),
    WorkflowManifestLoadError,
  );
  assert.equal(await fs.readFile(workflowPath, "utf8"), future);

  await fs.writeFile(workflowPath, `${JSON.stringify(first)}\n`, "utf8");
  const journalPath = path.join(directory, "workflows", first.id, "autosave.journal");
  const futureJournal = `${JSON.stringify({ version: 2 })}\n`;
  await fs.writeFile(journalPath, futureJournal, "utf8");
  const journalStore = new WorkflowManifestStore(() => directory);
  assert.equal((await journalStore.inspect(first.id)).status, "unsafe");
  await assert.rejects(
    () => journalStore.stageAutosave(nextRevision(first, "blocked"), 1),
    WorkflowManifestLoadError,
  );
  assert.equal(await fs.readFile(journalPath, "utf8"), futureJournal);
});

test("non-SHA asset references are isolated as workflow recovery instead of poisoning inventory", async (t) => {
  const { directory, store } = await harness(t);
  const first = workflow();
  await store.put(first, null);
  const malformed = structuredClone(first);
  malformed.nodes.push({
    id: "bad-image",
    type: "image-input",
    position: { x: 0, y: 0 },
    data: { assetId: "asset-1" },
  });
  malformed.assetRefs = ["asset-1"];
  const workflowDirectory = path.join(directory, "workflows", first.id);
  await Promise.all([
    fs.writeFile(path.join(workflowDirectory, "workflow.json"), `${JSON.stringify(malformed)}\n`),
    fs.writeFile(
      path.join(workflowDirectory, "workflow.last-known-good.json"),
      `${JSON.stringify(malformed)}\n`,
    ),
  ]);

  const reopened = new WorkflowManifestStore(() => directory);
  const summaries = await reopened.initialize();
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0]?.health, "recovery-required");
  assert.equal((await reopened.inspect(first.id)).status, "recovery-required");
  await assert.rejects(() => reopened.get(first.id), WorkflowManifestLoadError);
});

test("future last-known-good metadata is explicit and cannot be replaced by save or repair", async (t) => {
  const { directory, store } = await harness(t);
  const first = workflow();
  await store.put(first, null);
  const lastGoodPath = path.join(directory, "workflows", first.id, "workflow.last-known-good.json");
  const future = `${JSON.stringify({ ...first, schemaVersion: CREATE_IMAGES_SCHEMA_VERSION + 1 })}\n`;
  await fs.writeFile(lastGoodPath, future, "utf8");
  const reopened = new WorkflowManifestStore(() => directory);
  const health = await reopened.inspect(first.id);
  assert.equal(health.status, "unsafe");
  if (health.status === "unsafe") {
    assert.equal(health.reason, "last-known-good-future-schema");
  }
  await assert.rejects(
    () => reopened.put(nextRevision(first, "blocked"), 1),
    WorkflowManifestLoadError,
  );
  await assert.rejects(
    () => reopened.repairRecoveryMetadata(first.id, 1),
    WorkflowManifestLoadError,
  );
  assert.equal(await fs.readFile(lastGoodPath, "utf8"), future);
});

test("Phase 0 aggregate storage migrates without changing workflow revisions", async (t) => {
  const { directory } = await harness(t);
  const first = workflow();
  await fs.writeFile(
    path.join(directory, "workflows.json"),
    `${JSON.stringify({ version: 1, workflows: { [first.id]: first } })}\n`,
    "utf8",
  );
  const store = new WorkflowManifestStore(() => directory);
  assert.deepEqual(await store.get(first.id), first);
  assert.equal((await store.list())[0]?.revision, 1);
  await assert.rejects(() => fs.readFile(path.join(directory, "workflows.json")), {
    code: "ENOENT",
  });
  assert.equal(
    (await fs.readdir(directory)).some((name) => name.startsWith("workflows.phase-0-migrated-")),
    true,
  );
});

test("corrupt or future Phase 0 aggregate data is preserved and blocks migration", async (t) => {
  const { directory } = await harness(t);
  const legacyPath = path.join(directory, "workflows.json");
  await fs.writeFile(legacyPath, "{broken", "utf8");
  const corrupt = new WorkflowManifestStore(() => directory);
  assert.deepEqual(await corrupt.health(), { status: "corrupt", path: legacyPath });
  await assert.rejects(() => corrupt.list(), WorkflowManifestLoadError);
  await assert.rejects(() => corrupt.put(workflow(), null), WorkflowManifestLoadError);
  assert.equal(await fs.readFile(legacyPath, "utf8"), "{broken");

  await fs.writeFile(legacyPath, JSON.stringify({ version: 2, workflows: {} }), "utf8");
  const future = new WorkflowManifestStore(() => directory);
  assert.deepEqual(await future.health(), { status: "unsafe", path: legacyPath });
  await assert.rejects(() => future.get("workflow-1"), WorkflowManifestLoadError);
  assert.deepEqual(JSON.parse(await fs.readFile(legacyPath, "utf8")), {
    version: 2,
    workflows: {},
  });
});

test("corrupt index is rebuilt from manifests while a future index is preserved", async (t) => {
  const { directory, store } = await harness(t);
  await store.put(workflow(), null);
  const indexPath = path.join(directory, "index.json");
  await fs.writeFile(indexPath, "{broken", "utf8");
  const reopened = new WorkflowManifestStore(() => directory);
  assert.deepEqual(await reopened.health(), { status: "corrupt", path: indexPath });
  assert.equal((await reopened.list()).length, 1);
  assert.equal(JSON.parse(await fs.readFile(indexPath, "utf8")).version, 1);
  assert.equal(
    (await fs.readdir(path.join(directory, "quarantine"))).some((name) =>
      name.startsWith("index-corrupt-"),
    ),
    true,
  );

  const future = `${JSON.stringify({ version: 2, workflows: [] })}\n`;
  await fs.writeFile(indexPath, future, "utf8");
  const futureStore = new WorkflowManifestStore(() => directory);
  assert.deepEqual(await futureStore.health(), { status: "unsafe", path: indexPath });
  assert.equal((await futureStore.list()).length, 1);
  assert.equal(await fs.readFile(indexPath, "utf8"), future);
});

test("workflow IDs are path-bounded and object-prototype names remain safe", async (t) => {
  const { store } = await harness(t);
  const document = workflow("constructor");
  await store.put(document, null);
  assert.deepEqual(await store.get("constructor"), document);
  assert.equal(await store.get("toString"), undefined);
  await assert.rejects(() => store.get("../escape"), /Invalid Create Images workflow ID/u);
  await assert.rejects(
    () =>
      store.duplicate("constructor", {
        workflowId: "../copy",
        expectedRevision: 1,
        now: document.updatedAt,
      }),
    /Invalid Create Images workflow ID/u,
  );
});

test("workflow inventory fails closed on a same-name directory symlink", async (t) => {
  const { directory, store } = await harness(t);
  await store.initialize();
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-create-images-outside-"));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  const document = workflow("redirected");
  await fs.writeFile(path.join(outside, "workflow.json"), `${JSON.stringify(document)}\n`, "utf8");
  await fs.symlink(outside, path.join(directory, "workflows", document.id));
  await assert.rejects(() => store.get(document.id), WorkflowManifestLoadError);
  await assert.rejects(() => store.put(document, null), WorkflowManifestLoadError);
  await assert.rejects(() => store.list(), WorkflowManifestLoadError);
});

test("workflow inventory fails closed when a workflow directory is renamed to an invalid ID", async (t) => {
  const { directory, store } = await harness(t);
  const first = workflow();
  await store.put(first, null);
  const original = path.join(directory, "workflows", first.id);
  const invalid = path.join(directory, "workflows", `${first.id}.renamed`);
  await fs.rename(original, invalid);

  await assert.rejects(() => store.list(), WorkflowManifestLoadError);
  await assert.rejects(() => store.put(workflow("workflow-2"), null), WorkflowManifestLoadError);
  assert.equal((await fs.readdir(invalid)).includes("workflow.json"), true);
  await assert.rejects(() => fs.lstat(path.join(directory, "workflows", "workflow-2")), {
    code: "ENOENT",
  });
});

test("workflow inventory fails closed on unknown workflow files", async (t) => {
  const { directory, store } = await harness(t);
  await store.create(workflow());
  const unknown = path.join(directory, "workflows", "workflow-1", "unexpected.bin");
  await fs.writeFile(unknown, "not workflow metadata", "utf8");

  await assert.rejects(
    () => store.initialize(),
    (error: unknown) => {
      assert.equal(error instanceof WorkflowManifestLoadError, true);
      assert.equal((error as WorkflowManifestLoadError).status, "unsafe");
      return true;
    },
  );
});

test("workflow count and aggregate byte preflights prevent durable unindexed growth", async (t) => {
  const { directory } = await harness(t);
  const countLimited = new WorkflowManifestStore(() => directory, {}, { maxWorkflowCount: 1 });
  const first = workflow();
  await countLimited.put(first, null);
  await assert.rejects(
    () => countLimited.put(workflow("workflow-2"), null),
    /workflow count limit/u,
  );
  await assert.rejects(() => fs.lstat(path.join(directory, "workflows", "workflow-2")), {
    code: "ENOENT",
  });

  const firstDirectory = path.join(directory, "workflows", first.id);
  const existingBytes = (
    await Promise.all(
      (
        await fs.readdir(firstDirectory)
      ).map(async (name) => (await fs.lstat(path.join(firstDirectory, name))).size),
    )
  ).reduce((sum, size) => sum + size, 0);
  const byteLimited = new WorkflowManifestStore(
    () => directory,
    {},
    { maxAggregateWorkflowBytes: existingBytes + 16 },
  );
  await assert.rejects(
    () => byteLimited.stageAutosave(nextRevision(first, "This cannot fit"), 1),
    /aggregate byte limit/u,
  );
  await assert.rejects(() => fs.lstat(path.join(firstDirectory, "autosave.journal")), {
    code: "ENOENT",
  });
  assert.deepEqual(await byteLimited.get(first.id), first);
});

test("hostile prepopulated inventory hits the aggregate limit before manifest parsing", async (t) => {
  const { directory } = await harness(t);
  const workflowDirectory = path.join(directory, "workflows", "hostile-workflow");
  await fs.mkdir(workflowDirectory, { recursive: true });
  const hostileBody = "{".repeat(128);
  const manifestPath = path.join(workflowDirectory, "workflow.json");
  await fs.writeFile(manifestPath, hostileBody, "utf8");
  const store = new WorkflowManifestStore(() => directory, {}, { maxAggregateWorkflowBytes: 64 });

  await assert.rejects(() => store.initialize(), /aggregate byte limit/u);
  assert.equal(await fs.readFile(manifestPath, "utf8"), hostileBody);
  await assert.rejects(() => fs.lstat(path.join(directory, "index.json")), { code: "ENOENT" });
});

test("deleted workflow quarantine is bounded without pruning recovery evidence", async (t) => {
  const { directory } = await harness(t);
  const store = new WorkflowManifestStore(() => directory, {}, { maxDeletedQuarantineEntries: 1 });
  const recoveryEvidence = path.join(directory, "quarantine", "workflow-corrupt-evidence.json");
  await store.initialize();
  await fs.writeFile(recoveryEvidence, "{broken", "utf8");

  const first = workflow("workflow-1");
  await store.put(first, null);
  await store.delete(first.id, 1);
  const second = workflow("workflow-2", "2026-08-11T12:01:00.000Z");
  await store.put(second, null);
  await store.delete(second.id, 1);

  const quarantine = await fs.readdir(path.join(directory, "quarantine", "deleted-workflows"));
  assert.equal(quarantine.filter((name) => name.startsWith("deleted-")).length, 1);
  assert.equal(await fs.readFile(recoveryEvidence, "utf8"), "{broken");
});

test("recovery evidence cannot exhaust the deleted-workflow quarantine scan", async (t) => {
  const { directory, store } = await harness(t);
  await store.initialize();
  const recoveryPath = path.join(directory, "quarantine");
  for (let offset = 0; offset < 4_100; offset += 100) {
    await Promise.all(
      Array.from({ length: 100 }, (_, index) =>
        fs.writeFile(path.join(recoveryPath, `recovery-${offset + index}.json`), "{}"),
      ),
    );
  }
  const first = workflow("workflow-separated-quarantine");
  await store.put(first, null);
  await store.delete(first.id, 1);
  assert.equal(
    (await fs.readdir(path.join(directory, "quarantine", "deleted-workflows"))).filter((name) =>
      name.startsWith("deleted-"),
    ).length,
    1,
  );
});

test("deleted workflow quarantine also enforces its aggregate byte budget", async (t) => {
  const { directory, store } = await harness(t);
  const first = workflow("workflow-1");
  await store.put(first, null);
  await store.delete(first.id, 1);
  const quarantinePath = path.join(directory, "quarantine", "deleted-workflows");
  const firstDeleted = (await fs.readdir(quarantinePath)).find((name) =>
    name.startsWith("deleted-workflow-1-"),
  );
  assert.ok(firstDeleted);
  const firstDeletedPath = path.join(quarantinePath, firstDeleted);
  const firstBytes = (
    await Promise.all(
      (
        await fs.readdir(firstDeletedPath)
      ).map(async (name) => (await fs.lstat(path.join(firstDeletedPath, name))).size),
    )
  ).reduce((sum, size) => sum + size, 0);

  const byteBounded = new WorkflowManifestStore(
    () => directory,
    {},
    { maxDeletedQuarantineBytes: firstBytes + 16 },
  );
  const second = workflow("workflow-2", "2026-08-11T12:01:00.000Z");
  await byteBounded.put(second, null);
  await byteBounded.delete(second.id, 1);
  assert.equal(
    (await fs.readdir(quarantinePath)).filter((name) => name.startsWith("deleted-")).length,
    1,
  );
});

test("a projection rebuild failure after publication does not misreport a durable create", async (t) => {
  const { directory } = await harness(t);
  const unexpected = path.join(directory, "workflows", "invalid.workflow");
  const store = new WorkflowManifestStore(() => directory, {
    afterCurrentPublished: async () => {
      await fs.mkdir(unexpected);
    },
  });
  const first = workflow();
  assert.deepEqual(await store.put(first, null), first);
  assert.deepEqual(await store.get(first.id), first);
  await assert.rejects(() => store.list(), WorkflowManifestLoadError);
  await fs.rmdir(unexpected);
  assert.equal((await store.list()).length, 1);
});

test("every renderer-owned publication checks document liveness", async (t) => {
  const { directory, store } = await harness(t);
  const first = workflow();
  await assert.rejects(
    () => store.put(first, null, () => false),
    /renderer document is no longer active/u,
  );
  await assert.rejects(
    () => fs.readFile(path.join(directory, "workflows", first.id, "workflow.json")),
    { code: "ENOENT" },
  );
  await assert.rejects(
    () => fs.readFile(path.join(directory, "workflows", first.id, "autosave.journal")),
    { code: "ENOENT" },
  );
  await assert.rejects(() => fs.lstat(path.join(directory, "workflows", first.id)), {
    code: "ENOENT",
  });
  assert.deepEqual(await store.list(), []);

  await store.put(first, null);
  const second = nextRevision(first, "not current");
  await assert.rejects(
    () => store.stageAutosave(second, 1, () => false),
    /renderer document is no longer active/u,
  );
  assert.equal((await store.get(first.id))?.revision, 1);
  await assert.rejects(
    () => store.delete(first.id, 1, () => false),
    /renderer document is no longer active/u,
  );
  assert.equal((await store.get(first.id))?.revision, 1);
});
