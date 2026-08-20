import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import test, { type TestContext } from "node:test";
import {
  appendCreateImagesRunEvent,
  createCreateImagesRunJournal,
  type CreateImagesRunEventV1,
  type CreateImagesRunJournalV1,
} from "../../../renderer/shared/create-images/run-contract.js";
import type { WorkflowDocumentV1 } from "../../../renderer/shared/create-images/schema.js";
import {
  CreateImagesRunJournalStore,
  createImagesWorkflowSnapshotFingerprint,
} from "./run-journal-store.js";

const NOW = "2026-08-11T12:00:00.000Z";

async function temporaryRoot(t: TestContext): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-run-journal-performance-"));
  t.after(() => fs.rm(root, { force: true, recursive: true }));
  return root;
}

function workload(nodeCount: number): {
  snapshot: WorkflowDocumentV1;
  orderedNodeIds: string[];
} {
  const orderedNodeIds = Array.from({ length: nodeCount }, (_, index) => `prompt-${index + 1}`);
  return {
    snapshot: {
      schemaVersion: 1,
      id: "workflow-performance",
      title: "Journal performance gate",
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
      nodes: orderedNodeIds.map((id, index) => ({
        id,
        type: "prompt" as const,
        position: { x: (index % 25) * 100, y: Math.floor(index / 25) * 100 },
        data: { text: `Prompt ${index + 1}` },
      })),
      edges: [],
      assetRefs: [],
      settings: { concurrency: 4 },
    },
    orderedNodeIds,
  };
}

function event<T extends CreateImagesRunEventV1["type"]>(
  journal: CreateImagesRunJournalV1,
  type: T,
  fields: Omit<
    Extract<CreateImagesRunEventV1, { type: T }>,
    "type" | "workflowId" | "workflowRevision" | "runId" | "sequence" | "at"
  >,
): Extract<CreateImagesRunEventV1, { type: T }> {
  return {
    type,
    workflowId: journal.workflowId,
    workflowRevision: journal.workflowRevision,
    runId: journal.runId,
    sequence: journal.events.length + 1,
    at: NOW,
    ...fields,
  } as Extract<CreateImagesRunEventV1, { type: T }>;
}

test("100/250/500-node successful journals append and replay within bounded linear-storage gates", async (t) => {
  const root = await temporaryRoot(t);
  const store = new CreateImagesRunJournalStore(() => root);
  const { snapshot, orderedNodeIds } = workload(500);
  let journal = await store.start(
    {
      runId: "run-performance",
      workflowSnapshot: snapshot,
      plan: {
        scope: { kind: "all" },
        orderedNodeIds,
        dependencies: Object.fromEntries(orderedNodeIds.map((nodeId) => [nodeId, []])),
      },
      createdAt: NOW,
    },
    () => true,
  );
  const runDirectory = path.join(root, "runs", journal.runId);
  const checkpointBytes = (await fs.lstat(path.join(runDirectory, "run.json"))).size;
  const startedAt = performance.now();
  journal = await store.append(
    journal.runId,
    journal.journalRevision,
    event(journal, "run-started", {}),
  );
  const indexBeforeProgress = await fs.readFile(path.join(root, "run-index.json"), "utf8");
  const elapsedByNode = new Map<number, number>();
  for (const [index, nodeId] of orderedNodeIds.entries()) {
    journal = await store.append(
      journal.runId,
      journal.journalRevision,
      event(journal, "node-started", { nodeId }),
    );
    journal = await store.append(
      journal.runId,
      journal.journalRevision,
      event(journal, "node-output-published", { nodeId, outputAssetIds: [] }),
    );
    journal = await store.append(
      journal.runId,
      journal.journalRevision,
      event(journal, "node-succeeded", { nodeId, outputAssetIds: [] }),
    );
    const completedNodes = index + 1;
    if ([100, 250, 500].includes(completedNodes)) {
      elapsedByNode.set(completedNodes, performance.now() - startedAt);
    }
  }

  assert.ok((elapsedByNode.get(100) ?? Infinity) < 45_000, "100-node append gate exceeded 45s");
  assert.ok((elapsedByNode.get(250) ?? Infinity) < 105_000, "250-node append gate exceeded 105s");
  assert.ok((elapsedByNode.get(500) ?? Infinity) < 240_000, "500-node append gate exceeded 240s");
  assert.equal(await fs.readFile(path.join(root, "run-index.json"), "utf8"), indexBeforeProgress);
  journal = await store.append(
    journal.runId,
    journal.journalRevision,
    event(journal, "run-terminal", { status: "succeeded" }),
  );
  assert.equal((await fs.lstat(path.join(runDirectory, "run.json"))).size, checkpointBytes);
  assert.equal(
    (await fs.lstat(path.join(runDirectory, "run.last-known-good.json"))).size,
    checkpointBytes,
  );
  await assert.rejects(fs.lstat(path.join(runDirectory, "run.pending.json")), {
    code: "ENOENT",
  });

  const replayStartedAt = performance.now();
  const replayed = await new CreateImagesRunJournalStore(() => root).get(journal.runId);
  const replayMs = performance.now() - replayStartedAt;
  assert.equal(replayed?.journalRevision, journal.journalRevision);
  assert.ok(replayMs < 3_500, "500-node replay gate exceeded 3.5s");

  t.diagnostic(
    JSON.stringify({
      appendMs: Object.fromEntries(elapsedByNode),
      replayMs: Math.round(replayMs),
      eventCount: journal.events.length,
      currentLogBytes: (await fs.lstat(path.join(runDirectory, "run.events.jsonl"))).size,
    }),
  );
});

test("1,000 output-rich terminal journals restart, reconcile, and inventory within bounded storage gates", async (t) => {
  const root = await temporaryRoot(t);
  const runsPath = path.join(root, "runs");
  await fs.mkdir(runsPath, { recursive: true });
  const { snapshot, orderedNodeIds } = workload(1);
  const plan = {
    scope: { kind: "all" } as const,
    orderedNodeIds,
    dependencies: { [orderedNodeIds[0] as string]: [] },
  };
  const entries: Array<Record<string, unknown>> = [];
  const writes: Array<Promise<void>> = [];
  for (let index = 1; index <= 1_000; index += 1) {
    const runId = `retained-${String(index).padStart(4, "0")}`;
    let journal = createCreateImagesRunJournal({
      runId,
      workflowSnapshot: snapshot,
      workflowFingerprint: createImagesWorkflowSnapshotFingerprint(snapshot),
      plan,
      createdAt: NOW,
    });
    journal = appendCreateImagesRunEvent(journal, event(journal, "run-started", {}));
    journal = appendCreateImagesRunEvent(
      journal,
      event(journal, "node-started", { nodeId: orderedNodeIds[0] as string }),
    );
    journal = appendCreateImagesRunEvent(
      journal,
      event(journal, "node-output-published", {
        nodeId: orderedNodeIds[0] as string,
        outputAssetIds: Array.from({ length: 250 }, (_, assetIndex) =>
          (index * 1_000 + assetIndex).toString(16).padStart(64, "0"),
        ),
      }),
    );
    const outputAssetIds = (
      journal.events[journal.events.length - 1] as Extract<
        CreateImagesRunEventV1,
        { type: "node-output-published" }
      >
    ).outputAssetIds;
    journal = appendCreateImagesRunEvent(
      journal,
      event(journal, "node-succeeded", {
        nodeId: orderedNodeIds[0] as string,
        outputAssetIds,
      }),
    );
    journal = appendCreateImagesRunEvent(
      journal,
      event(journal, "run-terminal", { status: "succeeded" }),
    );
    const directory = path.join(runsPath, runId);
    const serialized = `${JSON.stringify(journal, null, 2)}\n`;
    writes.push(
      (async () => {
        await fs.mkdir(directory, { recursive: true });
        await Promise.all([
          fs.writeFile(path.join(directory, "run.json"), serialized, "utf8"),
          fs.writeFile(path.join(directory, "run.last-known-good.json"), serialized, "utf8"),
        ]);
      })(),
    );
    entries.push({
      runId,
      workflowId: journal.workflowId,
      workflowRevision: journal.workflowRevision,
      journalRevision: journal.journalRevision,
      status: "succeeded",
      createdAt: journal.createdAt,
      updatedAt: journal.updatedAt,
      terminal: true,
      health: "healthy",
    });
    if (writes.length === 50) {
      await Promise.all(writes.splice(0));
    }
  }
  await Promise.all(writes);
  await fs.writeFile(
    path.join(root, "run-index.json"),
    `${JSON.stringify({ version: 1, revision: 1, entries }, null, 2)}\n`,
    "utf8",
  );

  const restarted = new CreateImagesRunJournalStore(() => root);
  const productPathStartedAt = performance.now();
  await restarted.initialize();
  const initializedAt = performance.now();
  const admissionStartedAt = performance.now();
  const admission = await restarted.auditWorkflowAdmission("workflow-performance");
  const admissionMs = performance.now() - admissionStartedAt;
  const firstReferences = await restarted.referenceInventory();
  const secondReferences = await restarted.referenceInventory();
  const reconciliation = await restarted.reconciliationCandidates();
  const thirdReferences = await restarted.referenceInventory();
  const productPathMs = performance.now() - productPathStartedAt;
  const restartMs = initializedAt - productPathStartedAt;
  assert.ok(restartMs < 20_000, "1,000-journal restart gate exceeded 20s");
  assert.ok(admissionMs < 20_000, "1,000-journal admission audit exceeded 20s");
  assert.deepEqual(admission, {
    hasDegradedAuthority: false,
    hasNonterminalRun: false,
    hasUnresolvedAmbiguity: false,
  });
  assert.ok(
    productPathMs < 60_000,
    "1,000-journal product reference/reconciliation gate exceeded 60s",
  );
  assert.equal(firstReferences.complete, true);
  assert.equal(secondReferences.complete, true);
  assert.equal(thirdReferences.complete, true);
  assert.equal(firstReferences.records.length, 1_000);
  assert.equal(
    firstReferences.records.reduce((total, record) => total + record.assetIds.length, 0),
    250_000,
  );
  assert.deepEqual(reconciliation, []);
  const cache = restarted.cacheStats();
  assert.ok(cache.journalCount <= 32);
  assert.ok(cache.journalBytes <= 32 * 1024 * 1024);
  assert.ok(cache.tailCount <= 128);
  assert.ok(cache.tailBytes <= 64 * 1024);
  assert.equal((await restarted.terminalHistory()).length, 1_000);
  assert.ok(
    (await fs.lstat(path.join(root, "run-index.json"))).size < 1024 * 1024,
    "metadata-only run index exceeded 1 MiB",
  );
  const retentionStartedAt = performance.now();
  const retention = await restarted.terminalRetentionCandidates({
    keepLatest: 900,
    limit: 100,
  });
  const retentionMs = performance.now() - retentionStartedAt;
  assert.equal(retention.length, 40);
  assert.ok(retentionMs < 5_000, "1,000-journal high-reference retention lookup exceeded 5s");
  t.diagnostic(
    JSON.stringify({
      terminalJournalCount: 1_000,
      outputAssetIdsPerRun: 250,
      restartMs: Math.round(restartMs),
      admissionMs: Math.round(admissionMs),
      productPathMs: Math.round(productPathMs),
      retentionMs: Math.round(retentionMs),
      indexBytes: (await fs.lstat(path.join(root, "run-index.json"))).size,
      cache,
    }),
  );
});
