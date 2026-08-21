import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test, { type TestContext } from "node:test";
import {
  appendCreateImagesRunEvent,
  createCreateImagesRunJournal,
  projectCreateImagesRun,
  type CreateImagesRunEventV1,
  type CreateImagesRunJournalV1,
} from "../../../renderer/shared/create-images/run-contract.js";
import type { WorkflowDocumentV1 } from "../../../renderer/shared/create-images/schema.js";
import {
  CreateImagesRunJournalLoadError,
  CreateImagesRunJournalRevisionConflictError,
  CreateImagesRunJournalStore,
  createImagesWorkflowSnapshotFingerprint,
} from "./run-journal-store.js";

const NOW = "2026-08-11T12:00:00.000Z";
const LATER = "2026-08-11T12:00:01.000Z";
const ASSET_ID = "c".repeat(64);
const INPUT_ASSET_ID = "a".repeat(64);

async function temporaryRoot(t: TestContext): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-run-journal-"));
  t.after(() => fs.rm(root, { force: true, recursive: true }));
  return root;
}

function workflow(): WorkflowDocumentV1 {
  return {
    schemaVersion: 1,
    id: "workflow-1",
    title: "Durable run",
    revision: 3,
    createdAt: NOW,
    updatedAt: NOW,
    nodes: [
      {
        id: "prompt-1",
        type: "prompt",
        position: { x: 0, y: 0 },
        data: { text: "A durable prompt" },
      },
      {
        id: "generate-1",
        type: "generate-image",
        position: { x: 100, y: 0 },
        data: {
          providerId: "gemini",
          modelId: "gemini-3.1-flash-image",
          aspectRatio: "1:1",
          imageSize: "1K",
          outputMime: "image/png",
          count: 1,
        },
      },
      { id: "output-1", type: "output", position: { x: 200, y: 0 }, data: {} },
    ],
    edges: [
      {
        id: "edge-prompt",
        source: "prompt-1",
        sourcePort: "text",
        target: "generate-1",
        targetPort: "prompt",
      },
      {
        id: "edge-output",
        source: "generate-1",
        sourcePort: "images",
        target: "output-1",
        targetPort: "images",
      },
    ],
    assetRefs: [],
    settings: { concurrency: 1 },
  };
}

function startInput(runId = "run-1") {
  return {
    runId,
    workflowSnapshot: workflow(),
    plan: {
      scope: { kind: "all" } as const,
      orderedNodeIds: ["prompt-1", "generate-1", "output-1"],
      dependencies: {
        "prompt-1": [],
        "generate-1": ["prompt-1"],
        "output-1": ["generate-1"],
      },
    },
    createdAt: NOW,
  };
}

function emptyStartInput(runId: string) {
  const snapshot: WorkflowDocumentV1 = {
    ...workflow(),
    id: `workflow-${runId}`,
    nodes: [
      {
        id: "prompt-only",
        type: "prompt",
        position: { x: 0, y: 0 },
        data: { text: "retire me" },
      },
    ],
    edges: [],
    assetRefs: [],
  };
  return {
    runId,
    workflowSnapshot: snapshot,
    plan: {
      scope: { kind: "all" } as const,
      orderedNodeIds: ["prompt-only"],
      dependencies: { "prompt-only": [] },
    },
    createdAt: NOW,
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
    at: LATER,
    ...fields,
  } as Extract<CreateImagesRunEventV1, { type: T }>;
}

async function append<T extends CreateImagesRunEventV1["type"]>(
  store: CreateImagesRunJournalStore,
  journal: CreateImagesRunJournalV1,
  type: T,
  fields: Omit<
    Extract<CreateImagesRunEventV1, { type: T }>,
    "type" | "workflowId" | "workflowRevision" | "runId" | "sequence" | "at"
  >,
): Promise<CreateImagesRunJournalV1> {
  return store.append(journal.runId, journal.journalRevision, event(journal, type, fields));
}

interface PendingAppendFixture {
  kind: "append";
  event: CreateImagesRunEventV1;
  targetJournalDigest: string;
}

async function expectedPendingEventRecord(
  root: string,
  runId: string,
  checkpointFile: "run.json" | "run.last-known-good.json",
  eventLogFile: "run.events.jsonl" | "run.last-known-good.events.jsonl",
): Promise<{ pending: PendingAppendFixture; bytes: Buffer }> {
  const directory = path.join(root, "runs", runId);
  const pending = JSON.parse(
    await fs.readFile(path.join(directory, "run.pending.json"), "utf8"),
  ) as PendingAppendFixture;
  assert.equal(pending.kind, "append");
  const checkpoint = JSON.parse(
    await fs.readFile(path.join(directory, checkpointFile), "utf8"),
  ) as CreateImagesRunJournalV1;
  let previousDigest = createHash("sha256")
    .update(JSON.stringify(checkpoint), "utf8")
    .digest("hex");
  const log = await fs.readFile(path.join(directory, eventLogFile), "utf8").catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  });
  const lines = log.trimEnd().split("\n");
  const lastLine = lines[lines.length - 1];
  if (lastLine) previousDigest = (JSON.parse(lastLine) as { digest: string }).digest;
  const journalRevision = pending.event.sequence + 1;
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        runId,
        journalRevision,
        previousDigest,
        event: pending.event,
      }),
      "utf8",
    )
    .digest("hex");
  return {
    pending,
    bytes: Buffer.from(
      `${JSON.stringify({
        version: 1,
        runId,
        journalRevision,
        previousDigest,
        digest,
        event: pending.event,
      })}\n`,
      "utf8",
    ),
  };
}

async function startGenerateNode(
  store: CreateImagesRunJournalStore,
  journal: CreateImagesRunJournalV1,
): Promise<CreateImagesRunJournalV1> {
  let next = await append(store, journal, "node-started", {
    nodeId: "prompt-1",
  });
  next = await append(store, next, "node-output-published", {
    nodeId: "prompt-1",
    outputAssetIds: [],
  });
  next = await append(store, next, "node-succeeded", {
    nodeId: "prompt-1",
    outputAssetIds: [],
  });
  return append(store, next, "node-started", { nodeId: "generate-1" });
}

async function terminalFailedRun(
  store: CreateImagesRunJournalStore,
  runId: string,
  workflowId = `workflow-${runId}`,
): Promise<CreateImagesRunJournalV1> {
  const input = emptyStartInput(runId);
  input.workflowSnapshot.id = workflowId;
  let journal = await store.start(input, () => true);
  journal = await append(store, journal, "run-started", {});
  journal = await append(store, journal, "node-started", {
    nodeId: "prompt-only",
  });
  journal = await append(store, journal, "node-failed", {
    nodeId: "prompt-only",
    errorCode: "test-failure",
  });
  return append(store, journal, "run-terminal", { status: "failed" });
}

async function terminalAmbiguousRun(
  store: CreateImagesRunJournalStore,
  runId = "run-ambiguous",
  beforeTerminal?: () => void,
): Promise<CreateImagesRunJournalV1> {
  let journal = await store.start(startInput(runId), () => true);
  journal = await append(store, journal, "run-started", {});
  journal = await startGenerateNode(store, journal);
  journal = await append(store, journal, "node-submission-prepared", {
    nodeId: "generate-1",
    attempt: 1,
    idempotencyKey: `idem-${runId}-0001`,
    providerId: "mock",
    modelId: "mock-image-v1",
  });
  journal = await append(store, journal, "node-submission-ambiguous", {
    nodeId: "generate-1",
    attempt: 1,
  });
  journal = await append(store, journal, "node-ambiguous", {
    nodeId: "generate-1",
    attempt: 1,
  });
  journal = await append(store, journal, "node-blocked", {
    nodeId: "output-1",
    upstreamNodeIds: ["generate-1"],
  });
  beforeTerminal?.();
  return append(store, journal, "run-terminal", { status: "needs_attention" });
}

test("start publishes fingerprinted current and recovery journals atomically", async (t) => {
  const root = await temporaryRoot(t);
  const store = new CreateImagesRunJournalStore(() => root);
  const journal = await store.start(startInput(), () => true);
  assert.equal(journal.workflowFingerprint, createImagesWorkflowSnapshotFingerprint(workflow()));
  assert.equal((await store.health("run-1")).status, "healthy");
  assert.equal((await store.get("run-1"))?.journalRevision, 1);
  assert.equal(
    await fs.readFile(path.join(root, "runs", "run-1", "run.json"), "utf8"),
    await fs.readFile(path.join(root, "runs", "run-1", "run.last-known-good.json"), "utf8"),
  );
  await assert.rejects(
    store.start(startInput(), () => true),
    CreateImagesRunJournalRevisionConflictError,
  );
});

test("stale renderer ownership blocks only pre-intent start publication", async (t) => {
  const root = await temporaryRoot(t);
  const store = new CreateImagesRunJournalStore(() => root);
  await assert.rejects(
    store.start(startInput(), () => false),
    /no longer active/u,
  );
  assert.equal((await store.health("run-1")).status, "missing");

  let journal = await store.start(startInput(), () => true);
  journal = await append(store, journal, "run-started", {});
  assert.equal(projectCreateImagesRun(journal).status, "running");
});

test("restart completes a start that crashed after durable intent without renderer liveness", async (t) => {
  const root = await temporaryRoot(t);
  let crash = true;
  const crashing = new CreateImagesRunJournalStore(() => root, {
    afterPendingPublished: async () => {
      if (crash) throw new Error("simulated process loss");
    },
  });
  await assert.rejects(
    crashing.start(startInput(), () => true),
    /simulated process loss/u,
  );
  crash = false;
  const restarted = new CreateImagesRunJournalStore(() => root);
  const health = await restarted.initialize();
  assert.equal(health[0]?.status, "healthy");
  assert.equal((await restarted.get("run-1"))?.journalRevision, 1);
});

for (const boundary of ["pending", "current", "last-known-good"] as const) {
  test(`restart completes append crashed after ${boundary} publication`, async (t) => {
    const root = await temporaryRoot(t);
    let crash = false;
    const store = new CreateImagesRunJournalStore(() => root, {
      afterPendingPublished: async () => {
        if (crash && boundary === "pending") throw new Error("crash-pending");
      },
      afterCurrentPublished: async () => {
        if (crash && boundary === "current") throw new Error("crash-current");
      },
      afterLastKnownGoodPublished: async () => {
        if (crash && boundary === "last-known-good") throw new Error("crash-last-known-good");
      },
    });
    const initial = await store.start(startInput(), () => true);
    crash = true;
    await assert.rejects(
      append(store, initial, "run-started", {}),
      new RegExp(`crash-${boundary}`, "u"),
    );
    const restarted = new CreateImagesRunJournalStore(() => root);
    const recovered = await restarted.get("run-1");
    assert.equal(recovered?.journalRevision, 2);
    assert.equal(recovered && projectCreateImagesRun(recovered).status, "running");
    await assert.rejects(
      restarted.append("run-1", 1, event(initial, "run-started", {})),
      CreateImagesRunJournalRevisionConflictError,
    );
  });
}

for (const boundary of ["current", "last-known-good"] as const) {
  for (const fragment of ["partial-json", "valid-json-without-newline"] as const) {
    test(`restart atomically repairs a ${fragment} torn ${boundary} event append`, async (t) => {
      const root = await temporaryRoot(t);
      let tear = false;
      const tearEventLog = async (runId: string): Promise<void> => {
        if (!tear) return;
        tear = false;
        const checkpointFile = boundary === "current" ? "run.json" : "run.last-known-good.json";
        const eventLogFile =
          boundary === "current" ? "run.events.jsonl" : "run.last-known-good.events.jsonl";
        const expected = await expectedPendingEventRecord(
          root,
          runId,
          checkpointFile,
          eventLogFile,
        );
        const tornBytes =
          fragment === "partial-json"
            ? expected.bytes.subarray(0, Math.floor(expected.bytes.length / 2))
            : expected.bytes.subarray(0, expected.bytes.length - 1);
        await fs.appendFile(path.join(root, "runs", runId, eventLogFile), tornBytes);
        throw new Error(`crash-torn-${boundary}`);
      };
      const store = new CreateImagesRunJournalStore(() => root, {
        ...(boundary === "current"
          ? { afterPendingPublished: tearEventLog }
          : { afterCurrentPublished: tearEventLog }),
      });
      const initial = await store.start(startInput(), () => true);
      const started = await append(store, initial, "run-started", {});
      tear = true;
      await assert.rejects(
        append(store, started, "node-started", { nodeId: "prompt-1" }),
        new RegExp(`crash-torn-${boundary}`, "u"),
      );

      const restarted = new CreateImagesRunJournalStore(() => root);
      const recovered = await restarted.get(started.runId);
      assert.equal(recovered?.journalRevision, started.journalRevision + 1);
      assert.equal(recovered?.events[recovered.events.length - 1]?.type, "node-started");
      assert.equal((await restarted.health(started.runId)).status, "healthy");
      await assert.rejects(fs.lstat(path.join(root, "runs", started.runId, "run.pending.json")), {
        code: "ENOENT",
      });
      assert.equal(
        (await new CreateImagesRunJournalStore(() => root).get(started.runId))?.journalRevision,
        started.journalRevision + 1,
      );
    });
  }
}

test("torn append recovery refuses a pending target digest mismatch", async (t) => {
  const root = await temporaryRoot(t);
  let tear = false;
  const store = new CreateImagesRunJournalStore(() => root, {
    afterPendingPublished: async (runId) => {
      if (!tear) return;
      tear = false;
      const expected = await expectedPendingEventRecord(
        root,
        runId,
        "run.json",
        "run.events.jsonl",
      );
      const directory = path.join(root, "runs", runId);
      await fs.appendFile(
        path.join(directory, "run.events.jsonl"),
        expected.bytes.subarray(0, Math.floor(expected.bytes.length / 2)),
      );
      await fs.writeFile(
        path.join(directory, "run.pending.json"),
        `${JSON.stringify({ ...expected.pending, targetJournalDigest: "0".repeat(64) }, null, 2)}\n`,
        "utf8",
      );
      throw new Error("crash-with-wrong-target-digest");
    },
  });
  const initial = await store.start(startInput(), () => true);
  const started = await append(store, initial, "run-started", {});
  tear = true;
  await assert.rejects(
    append(store, started, "node-started", { nodeId: "prompt-1" }),
    /crash-with-wrong-target-digest/u,
  );

  const restarted = new CreateImagesRunJournalStore(() => root);
  await assert.rejects(restarted.get(started.runId), CreateImagesRunJournalLoadError);
  const health = await restarted.health(started.runId);
  assert.equal(health.status, "recovery-required");
  if (health.status === "recovery-required") assert.equal(health.reason, "pending-conflict");
  await fs.access(path.join(root, "runs", started.runId, "run.pending.json"));
});

test("CAS and monotonic event identity reject stale, duplicate, and out-of-order writes", async (t) => {
  const root = await temporaryRoot(t);
  const store = new CreateImagesRunJournalStore(() => root);
  const journal = await store.start(startInput(), () => true);
  const started = await append(store, journal, "run-started", {});
  await assert.rejects(
    store.append("run-1", 1, event(journal, "run-started", {})),
    CreateImagesRunJournalRevisionConflictError,
  );
  await assert.rejects(
    store.append("run-1", started.journalRevision, {
      ...event(started, "node-started", { nodeId: "generate-1" }),
      sequence: 99,
    }),
    /monotonic/u,
  );
  await assert.rejects(
    store.append("run-1", started.journalRevision, {
      ...event(started, "node-started", { nodeId: "generate-1" }),
      runId: "run-stale",
    }),
    /identity/u,
  );
  assert.equal((await store.get("run-1"))?.journalRevision, 2);
});

for (const authoritativeFile of [
  "run.json",
  "run.last-known-good.json",
  "run.events.jsonl",
  "run.last-known-good.events.jsonl",
] as const) {
  test(`cached authority detects same-size ${authoritativeFile} tampering before append`, async (t) => {
    const root = await temporaryRoot(t);
    const store = new CreateImagesRunJournalStore(() => root);
    const initial = await store.start(startInput(), () => true);
    const started = await append(store, initial, "run-started", {});
    assert.equal((await store.get(started.runId))?.journalRevision, started.journalRevision);

    const target = path.join(root, "runs", started.runId, authoritativeFile);
    const before = await fs.stat(target);
    const bytes = await fs.readFile(target);
    assert.ok(bytes.length > 0);
    bytes[0] = bytes[0] === 0x7b ? 0x5b : bytes[0] === 0x5b ? 0x7b : bytes[0] ^ 1;
    await fs.writeFile(target, bytes);
    await fs.utimes(target, before.atime, before.mtime);
    assert.equal((await fs.stat(target)).size, before.size);

    await assert.rejects(
      append(store, started, "node-started", { nodeId: "prompt-1" }),
      CreateImagesRunJournalLoadError,
    );
  });
}

for (const authoritativeFile of [
  "run.json",
  "run.last-known-good.json",
  "run.events.jsonl",
  "run.last-known-good.events.jsonl",
] as const) {
  test(`durable append intent detects post-pending ${authoritativeFile} replacement`, async (t) => {
    const root = await temporaryRoot(t);
    let tamperAfterPending = false;
    let tampered = false;
    const store = new CreateImagesRunJournalStore(() => root, {
      afterPendingPublished: async (runId) => {
        if (!tamperAfterPending) return;
        tamperAfterPending = false;
        const target = path.join(root, "runs", runId, authoritativeFile);
        const before = await fs.stat(target);
        const bytes = await fs.readFile(target);
        assert.ok(bytes.length > 0);
        if (authoritativeFile.endsWith(".jsonl")) {
          const digestOffset = bytes.indexOf(Buffer.from('"digest":"', "utf8"));
          assert.notEqual(digestOffset, -1);
          const firstDigestByte = digestOffset + Buffer.byteLength('"digest":"', "utf8");
          bytes[firstDigestByte] = bytes[firstDigestByte] === 0x61 ? 0x62 : 0x61;
        } else {
          bytes[0] = bytes[0] === 0x7b ? 0x5b : bytes[0] === 0x5b ? 0x7b : bytes[0] ^ 1;
        }
        await fs.writeFile(target, bytes);
        await fs.utimes(target, before.atime, before.mtime);
        const after = await fs.stat(target);
        assert.equal(after.size, before.size);
        assert.ok(Math.abs(after.mtimeMs - before.mtimeMs) < 1);
        tampered = true;
      },
    });
    const initial = await store.start(startInput(), () => true);
    const started = await append(store, initial, "run-started", {});
    tamperAfterPending = true;

    await assert.rejects(
      append(store, started, "node-started", { nodeId: "prompt-1" }),
      CreateImagesRunJournalLoadError,
    );
    assert.equal(tampered, true);
    const pendingPath = path.join(root, "runs", started.runId, "run.pending.json");
    const pendingBytes = await fs.readFile(pendingPath, "utf8");
    assert.match(pendingBytes, /"authority"/u);
    const health = await store.health(started.runId);
    assert.equal(health.status, "recovery-required");
    if (health.status !== "recovery-required") return;
    assert.equal(health.reason, "pending-conflict");
    assert.equal(health.canRecover, false);
    assert.equal(health.workflowId, started.workflowId);
    await assert.rejects(
      append(store, started, "node-started", { nodeId: "prompt-1" }),
      CreateImagesRunJournalLoadError,
    );
    assert.equal(await fs.readFile(pendingPath, "utf8"), pendingBytes);
  });
}

test("safe retry state survives a crash before the next attempt", async (t) => {
  const root = await temporaryRoot(t);
  let crashOnRetry = false;
  const store = new CreateImagesRunJournalStore(() => root, {
    afterPendingPublished: async () => {
      if (crashOnRetry) throw new Error("crash-after-retry-intent");
    },
  });
  let journal = await store.start(startInput(), () => true);
  journal = await append(store, journal, "run-started", {});
  journal = await startGenerateNode(store, journal);
  journal = await append(store, journal, "node-submission-prepared", {
    nodeId: "generate-1",
    attempt: 1,
    idempotencyKey: "idem-run1-node1-0001",
    providerId: "mock",
    modelId: "mock-image-v1",
  });
  crashOnRetry = true;
  await assert.rejects(
    append(store, journal, "node-retry-scheduled", {
      nodeId: "generate-1",
      attempt: 1,
      errorCode: "rate-limited",
      delayMs: 2_000,
      retrySafety: "confirmed-not-submitted",
    }),
    /crash-after-retry-intent/u,
  );
  const restarted = new CreateImagesRunJournalStore(() => root);
  journal = (await restarted.get("run-1")) as CreateImagesRunJournalV1;
  assert.equal(
    projectCreateImagesRun(journal).nodes["generate-1"]?.attempts[0]?.submission,
    "retry-scheduled",
  );
  journal = await append(restarted, journal, "node-submission-prepared", {
    nodeId: "generate-1",
    attempt: 2,
    idempotencyKey: "idem-run1-node1-0002",
    providerId: "mock",
    modelId: "mock-image-v1",
  });
  assert.equal(projectCreateImagesRun(journal).nodes["generate-1"]?.attempts.length, 2);
});

test("unresolved ambiguity is durable terminal history and never looks runnable after restart", async (t) => {
  const root = await temporaryRoot(t);
  const store = new CreateImagesRunJournalStore(() => root);
  let journal = await store.start(startInput(), () => true);
  journal = await append(store, journal, "run-started", {});
  journal = await startGenerateNode(store, journal);
  journal = await append(store, journal, "node-submission-prepared", {
    nodeId: "generate-1",
    attempt: 1,
    idempotencyKey: "idem-run1-node1-0001",
    providerId: "mock",
    modelId: "mock-image-v1",
  });
  journal = await append(store, journal, "node-submission-ambiguous", {
    nodeId: "generate-1",
    attempt: 1,
  });
  journal = await append(store, journal, "node-ambiguous", {
    nodeId: "generate-1",
    attempt: 1,
  });
  journal = await append(store, journal, "node-blocked", {
    nodeId: "output-1",
    upstreamNodeIds: ["generate-1"],
  });
  await append(store, journal, "run-terminal", { status: "needs_attention" });

  const restarted = new CreateImagesRunJournalStore(() => root);
  const loaded = (await restarted.get("run-1")) as CreateImagesRunJournalV1;
  assert.equal(projectCreateImagesRun(loaded).status, "needs_attention");
  assert.equal((await restarted.terminalHistory())[0]?.status, "needs_attention");
  await assert.rejects(
    append(restarted, loaded, "node-submission-prepared", {
      nodeId: "generate-1",
      attempt: 2,
      idempotencyKey: "idem-run1-node1-0001",
      providerId: "mock",
      modelId: "mock-image-v1",
    }),
    /Terminal runs/u,
  );
});

test("unresolved ambiguity cannot be retired until its CAS acknowledgement is durable", async (t) => {
  const root = await temporaryRoot(t);
  const store = new CreateImagesRunJournalStore(() => root);
  let journal = await terminalAmbiguousRun(store);
  assert.deepEqual(await store.terminalRetentionCandidates({ keepLatest: 0, limit: 100 }), []);
  await assert.rejects(
    store.planTerminalPrune([{ runId: journal.runId, journalRevision: journal.journalRevision }]),
    /must be acknowledged/u,
  );

  journal = await append(store, journal, "run-ambiguity-acknowledged", {
    expectedNeedsAttentionJournalRevision: journal.journalRevision,
  });
  assert.equal(
    (await store.terminalRetentionCandidates({ keepLatest: 0, limit: 100 }))[0]?.runId,
    journal.runId,
  );
});

test("an index write failure after terminal ambiguity dirties admission until rebuild", async (t) => {
  const root = await temporaryRoot(t);
  let failIndex = false;
  const store = new CreateImagesRunJournalStore(() => root, {
    beforeIndexPublished: async () => {
      if (failIndex) throw new Error("simulated-index-write-failure");
    },
  });
  await assert.rejects(
    terminalAmbiguousRun(store, "run-index-dirty", () => {
      failIndex = true;
    }),
    /simulated-index-write-failure/u,
  );
  const authoritative = await store.get("run-index-dirty");
  assert.equal(projectCreateImagesRun(authoritative!).status, "needs_attention");
  const health = await store.indexHealth();
  assert.equal(health.status, "degraded");
  if (health.status === "degraded") assert.equal(health.diagnostic, "stale-derived-index");
  await assert.rejects(
    store.hasUnresolvedAmbiguity("workflow-1"),
    /simulated-index-write-failure/u,
  );

  failIndex = false;
  assert.equal(await store.hasUnresolvedAmbiguity("workflow-1"), true);
  assert.equal((await store.indexHealth()).status, "healthy");
});

test("the workflow admission audit exposes authoritative nonterminal runs", async (t) => {
  const queuedRoot = await temporaryRoot(t);
  const queuedStore = new CreateImagesRunJournalStore(() => queuedRoot);
  await queuedStore.start(startInput(), () => true);
  assert.equal(await queuedStore.hasNonterminalRun("workflow-1"), true);
  assert.deepEqual(await queuedStore.auditWorkflowAdmission("workflow-1"), {
    hasDegradedAuthority: false,
    hasNonterminalRun: true,
    hasUnresolvedAmbiguity: false,
  });

  const terminalRoot = await temporaryRoot(t);
  const terminalStore = new CreateImagesRunJournalStore(() => terminalRoot);
  await terminalFailedRun(terminalStore, "terminal-run", "workflow-1");
  assert.equal(await terminalStore.hasNonterminalRun("workflow-1"), false);
  assert.deepEqual(await terminalStore.auditWorkflowAdmission("workflow-1"), {
    hasDegradedAuthority: false,
    hasNonterminalRun: false,
    hasUnresolvedAmbiguity: false,
  });
});

test("same-process checkpoint corruption cannot be hidden by journal or index caches", async (t) => {
  const root = await temporaryRoot(t);
  const store = new CreateImagesRunJournalStore(() => root);
  await terminalFailedRun(store, "cached-terminal", "workflow-1");
  assert.deepEqual(await store.auditWorkflowAdmission("workflow-1"), {
    hasDegradedAuthority: false,
    hasNonterminalRun: false,
    hasUnresolvedAmbiguity: false,
  });
  const directory = path.join(root, "runs", "cached-terminal");
  await Promise.all([
    fs.writeFile(path.join(directory, "run.json"), "{broken-current", "utf8"),
    fs.writeFile(path.join(directory, "run.last-known-good.json"), "{broken-recovery", "utf8"),
  ]);

  assert.deepEqual(await store.auditWorkflowAdmission("workflow-1"), {
    hasDegradedAuthority: true,
    hasNonterminalRun: false,
    hasUnresolvedAmbiguity: false,
  });
  assert.equal(
    (await store.auditWorkflowAdmission("unrelated-workflow")).hasDegradedAuthority,
    true,
  );
  await assert.rejects(store.get("cached-terminal"), CreateImagesRunJournalLoadError);
  assert.deepEqual(
    (await store.workflowDegradedCandidates("workflow-1")).map((candidate) => candidate.runId),
    ["cached-terminal"],
  );
});

test("the admission audit completes a valid crash-pending mutation before deciding", async (t) => {
  const root = await temporaryRoot(t);
  let crash = true;
  const store = new CreateImagesRunJournalStore(() => root, {
    afterPendingPublished: async () => {
      if (crash) throw new Error("simulated crash after pending authority");
    },
  });
  await assert.rejects(
    store.start(startInput("pending-run"), () => true),
    /simulated crash/u,
  );
  crash = false;

  assert.deepEqual(await store.auditWorkflowAdmission("workflow-1"), {
    hasDegradedAuthority: false,
    hasNonterminalRun: true,
    hasUnresolvedAmbiguity: false,
  });
  assert.equal((await store.health("pending-run")).status, "healthy");
});

test("durable cancellation intent survives restart before node cancellation", async (t) => {
  const root = await temporaryRoot(t);
  const store = new CreateImagesRunJournalStore(() => root);
  let journal = await store.start(startInput(), () => true);
  journal = await append(store, journal, "run-started", {});
  journal = await startGenerateNode(store, journal);
  const cancelled = await store.requestCancellation("run-1", journal.journalRevision, {
    at: LATER,
    reason: "renderer-disconnected",
  });
  assert.equal(projectCreateImagesRun(cancelled).status, "cancel_requested");
  const restarted = new CreateImagesRunJournalStore(() => root);
  const projection = projectCreateImagesRun(
    (await restarted.get("run-1")) as CreateImagesRunJournalV1,
  );
  assert.equal(projection.status, "cancel_requested");
  assert.equal(projection.cancellation?.reason, "renderer-disconnected");
  assert.deepEqual(
    (await restarted.reconciliationCandidates()).map((candidate) => candidate.runId),
    ["run-1"],
  );
});

test("restart removes only strictly named orphan atomic staging files", async (t) => {
  const root = await temporaryRoot(t);
  const store = new CreateImagesRunJournalStore(() => root);
  await store.start(startInput(), () => true);
  const runDirectory = path.join(root, "runs", "run-1");
  const staged = path.join(runDirectory, ".run.json.12345678-1234-4123-8123-123456789abc.tmp");
  await fs.writeFile(staged, "partial", "utf8");
  assert.equal((await store.initialize())[0]?.status, "healthy");
  await assert.rejects(fs.lstat(staged), { code: "ENOENT" });

  await fs.writeFile(path.join(runDirectory, ".unexpected.tmp"), "untrusted", "utf8");
  await assert.rejects(store.initialize(), CreateImagesRunJournalLoadError);
});

test("corrupt current is distinguishable and explicit last-known-good recovery is CAS guarded", async (t) => {
  const root = await temporaryRoot(t);
  const store = new CreateImagesRunJournalStore(() => root);
  await store.start(startInput(), () => true);
  const currentPath = path.join(root, "runs", "run-1", "run.json");
  await fs.writeFile(currentPath, "{broken", "utf8");
  const health = await store.health("run-1");
  assert.equal(health.status, "recovery-required");
  if (health.status === "recovery-required") assert.equal(health.reason, "current-corrupt");
  await assert.rejects(store.get("run-1"), CreateImagesRunJournalLoadError);
  await assert.rejects(
    store.recoverFromLastKnownGood("run-1", 99),
    CreateImagesRunJournalRevisionConflictError,
  );
  const recovered = await store.recoverFromLastKnownGood("run-1", 1);
  assert.equal(recovered.journalRevision, 1);
  assert.equal((await store.health("run-1")).status, "healthy");
});

test("degraded discard refuses healthy and recoverable records and binds corrupt state", async (t) => {
  const root = await temporaryRoot(t);
  const store = new CreateImagesRunJournalStore(() => root);
  await store.start(startInput("healthy-run"), () => true);
  assert.deepEqual(await store.planDegradedRunDiscard("healthy-run"), {
    status: "not-degraded",
  });

  await store.start(startInput("recoverable-run"), () => true);
  await fs.writeFile(
    path.join(root, "runs", "recoverable-run", "run.json"),
    "{broken-current",
    "utf8",
  );
  assert.deepEqual(await store.planDegradedRunDiscard("recoverable-run"), {
    status: "recoverable",
  });

  await store.start(startInput("discard-run"), () => true);
  await Promise.all([
    fs.writeFile(path.join(root, "runs", "discard-run", "run.json"), "{broken", "utf8"),
    fs.writeFile(
      path.join(root, "runs", "discard-run", "run.last-known-good.json"),
      "{broken",
      "utf8",
    ),
  ]);
  const planned = await store.planDegradedRunDiscard("discard-run");
  assert.equal(planned.status, "ready");
  if (planned.status !== "ready") return;
  assert.equal(planned.plan.association, "workflow");
  assert.equal(planned.plan.workflowId, "workflow-1");
  await fs.writeFile(
    path.join(root, "runs", "discard-run", "run.json"),
    "{changed-corruption",
    "utf8",
  );
  assert.deepEqual(
    await store.discardDegradedRun({
      runId: planned.plan.runId,
      authorizationToken: planned.plan.authorizationToken,
    }),
    { status: "conflict" },
  );
  assert.notEqual((await store.health("discard-run")).status, "missing");
});

test("unassociated degraded discard is crash-resumable and fail-closed for references", async (t) => {
  const root = await temporaryRoot(t);
  const seeded = new CreateImagesRunJournalStore(() => root);
  await seeded.start(startInput("unassociated-run"), () => true);
  await Promise.all([
    fs.writeFile(
      path.join(root, "runs", "unassociated-run", "run.json"),
      "{broken-current",
      "utf8",
    ),
    fs.writeFile(
      path.join(root, "runs", "unassociated-run", "run.last-known-good.json"),
      "{broken-recovery",
      "utf8",
    ),
    fs.rm(path.join(root, "run-index.json")),
  ]);
  const rebuilt = new CreateImagesRunJournalStore(() => root);
  await rebuilt.initialize();
  const planned = await rebuilt.planDegradedRunDiscard("unassociated-run");
  assert.equal(planned.status, "ready");
  if (planned.status !== "ready") return;
  assert.equal(planned.plan.association, "unassociated");

  const crashing = new CreateImagesRunJournalStore(() => root, {
    afterDiscardManifestPublished: async () => {
      throw new Error("discard-manifest-crash");
    },
  });
  await assert.rejects(
    crashing.discardDegradedRun({
      runId: planned.plan.runId,
      authorizationToken: planned.plan.authorizationToken,
    }),
    /discard-manifest-crash/u,
  );
  assert.equal((await crashing.referenceInventory()).complete, false);
  assert.equal(await crashing.get("unassociated-run"), undefined);

  const restarted = new CreateImagesRunJournalStore(() => root);
  await restarted.initialize();
  assert.equal(await restarted.get("unassociated-run"), undefined);
  assert.equal(await restarted.degradedRunCount(), 0);
  assert.equal((await restarted.referenceInventory()).complete, true);
  await assert.rejects(fs.lstat(path.join(root, "run-discard.pending.json")), {
    code: "ENOENT",
  });
});

test("degraded discard resumes after atomic retirement and post-delete crash boundaries", async (t) => {
  for (const boundary of ["afterDegradedRunRetired", "afterDiscardedRunDeleted"] as const) {
    const root = await temporaryRoot(t);
    const seeded = new CreateImagesRunJournalStore(() => root);
    await seeded.start(startInput(`discard-${boundary}`), () => true);
    await Promise.all([
      fs.writeFile(
        path.join(root, "runs", `discard-${boundary}`, "run.json"),
        "{broken-current",
        "utf8",
      ),
      fs.writeFile(
        path.join(root, "runs", `discard-${boundary}`, "run.last-known-good.json"),
        "{broken-recovery",
        "utf8",
      ),
    ]);
    const planned = await seeded.planDegradedRunDiscard(`discard-${boundary}`);
    assert.equal(planned.status, "ready");
    if (planned.status !== "ready") continue;
    const crashing = new CreateImagesRunJournalStore(() => root, {
      [boundary]: async () => {
        throw new Error(`crash-${boundary}`);
      },
    });
    await assert.rejects(
      crashing.discardDegradedRun({
        runId: planned.plan.runId,
        authorizationToken: planned.plan.authorizationToken,
      }),
      new RegExp(`crash-${boundary}`, "u"),
    );
    assert.equal((await crashing.referenceInventory()).complete, false);

    const restarted = new CreateImagesRunJournalStore(() => root);
    await restarted.initialize();
    assert.equal(await restarted.get(planned.plan.runId), undefined);
    assert.equal(await restarted.degradedRunCount(), 0);
    assert.equal((await restarted.referenceInventory()).complete, true);
  }
});

test("a forged discard manifest cannot retire a healthy journal", async (t) => {
  const root = await temporaryRoot(t);
  const store = new CreateImagesRunJournalStore(() => root);
  await store.start(startInput("healthy-authority"), () => true);
  const forgedPlan = {
    version: 1 as const,
    runId: "healthy-authority",
    reason: "current-corrupt" as const,
    association: "workflow" as const,
    workflowId: "workflow-1",
    expectedCurrentJournalRevision: 1,
    expectedLastKnownGoodJournalRevision: 1,
    recordFingerprint: "d".repeat(64),
  };
  await fs.writeFile(
    path.join(root, "run-discard.pending.json"),
    `${JSON.stringify({
      ...forgedPlan,
      authorizationToken: createHash("sha256")
        .update(JSON.stringify(forgedPlan), "utf8")
        .digest("hex"),
      createdAt: NOW,
    })}\n`,
    "utf8",
  );
  const restarted = new CreateImagesRunJournalStore(() => root);
  await assert.rejects(restarted.initialize(), CreateImagesRunJournalRevisionConflictError);
  const persisted = JSON.parse(
    await fs.readFile(path.join(root, "runs", "healthy-authority", "run.json"), "utf8"),
  ) as { runId?: string };
  assert.equal(persisted.runId, "healthy-authority");
});

test("future schema and corrupt pending metadata fail closed without overwrite", async (t) => {
  const root = await temporaryRoot(t);
  const store = new CreateImagesRunJournalStore(() => root);
  const journal = await store.start(startInput(), () => true);
  const runDirectory = path.join(root, "runs", "run-1");
  const currentPath = path.join(runDirectory, "run.json");
  const future = { ...journal, version: 2 };
  await fs.writeFile(currentPath, `${JSON.stringify(future)}\n`, "utf8");
  const unsafe = await store.health("run-1");
  assert.equal(unsafe.status, "unsafe");
  await assert.rejects(
    store.append("run-1", 1, event(journal, "run-started", {})),
    CreateImagesRunJournalLoadError,
  );
  assert.equal(JSON.parse(await fs.readFile(currentPath, "utf8")).version, 2);

  const root2 = await temporaryRoot(t);
  const second = new CreateImagesRunJournalStore(() => root2);
  await second.start(startInput(), () => true);
  await fs.writeFile(path.join(root2, "runs", "run-1", "run.pending.json"), "{broken", "utf8");
  const corrupt = await second.health("run-1");
  assert.equal(corrupt.status, "recovery-required");
  if (corrupt.status === "recovery-required") assert.equal(corrupt.reason, "pending-corrupt");
});

test("reference inventory retains durable outputs and fails closed around corruption", async (t) => {
  const root = await temporaryRoot(t);
  const store = new CreateImagesRunJournalStore(() => root);
  let journal = await store.start(startInput(), () => true);
  journal = await append(store, journal, "run-started", {});
  journal = await startGenerateNode(store, journal);
  journal = await append(store, journal, "node-submission-prepared", {
    nodeId: "generate-1",
    attempt: 1,
    idempotencyKey: "idem-run1-node1-0001",
    providerId: "mock",
    modelId: "mock-image-v1",
  });
  journal = await append(store, journal, "node-submission-accepted", {
    nodeId: "generate-1",
    attempt: 1,
    providerJobId: "mock-job-1",
  });
  const indexBeforeOutput = await fs.readFile(path.join(root, "run-index.json"), "utf8");
  journal = await append(store, journal, "node-output-published", {
    nodeId: "generate-1",
    outputAssetIds: [ASSET_ID],
  });
  assert.equal(await fs.readFile(path.join(root, "run-index.json"), "utf8"), indexBeforeOutput);
  await append(store, journal, "node-succeeded", {
    nodeId: "generate-1",
    outputAssetIds: [ASSET_ID],
  });
  let inventory = await store.referenceInventory();
  assert.deepEqual(inventory, {
    complete: true,
    records: [{ runId: "run-1", assetIds: [ASSET_ID] }],
  });
  await fs.writeFile(path.join(root, "runs", "run-1", "run.json"), "{broken", "utf8");
  inventory = await store.referenceInventory();
  assert.equal(inventory.complete, false);
  assert.deepEqual(inventory.records[0]?.assetIds, [ASSET_ID]);
});

test("reference inventory unions immutable snapshot inputs before any run event", async (t) => {
  const root = await temporaryRoot(t);
  const snapshot: WorkflowDocumentV1 = {
    ...workflow(),
    nodes: [
      {
        id: "input-1",
        type: "image-input",
        position: { x: -100, y: 0 },
        data: { assetId: INPUT_ASSET_ID },
      },
      ...workflow().nodes,
    ],
    assetRefs: [INPUT_ASSET_ID],
  };
  const store = new CreateImagesRunJournalStore(() => root);
  await store.start(
    {
      ...startInput(),
      workflowSnapshot: snapshot,
      plan: {
        scope: { kind: "all" },
        orderedNodeIds: ["input-1", "prompt-1", "generate-1", "output-1"],
        dependencies: {
          "input-1": [],
          "prompt-1": [],
          "generate-1": ["prompt-1"],
          "output-1": ["generate-1"],
        },
      },
    },
    () => true,
  );
  assert.deepEqual(await store.referenceInventory(), {
    complete: true,
    records: [{ runId: "run-1", assetIds: [INPUT_ASSET_ID] }],
  });
});

test("corrupt recovery copies remain listable with trusted identity and explicit repair direction", async (t) => {
  const root = await temporaryRoot(t);
  const store = new CreateImagesRunJournalStore(() => root);
  await store.start(startInput(), () => true);
  await fs.writeFile(
    path.join(root, "runs", "run-1", "run.last-known-good.json"),
    "{broken",
    "utf8",
  );
  const health = await store.health("run-1");
  assert.deepEqual(health, {
    status: "recovery-required",
    runId: "run-1",
    reason: "last-known-good-corrupt",
    canRecover: "from-current",
    workflowId: "workflow-1",
    workflowRevision: 3,
    currentJournalRevision: 1,
  });
  assert.deepEqual(await store.recoveryCandidates(), [
    {
      runId: "run-1",
      workflowId: "workflow-1",
      workflowRevision: 3,
      reason: "last-known-good-corrupt",
      canRecover: "from-current",
      expectedJournalRevision: 1,
    },
  ]);
  await assert.rejects(
    store.recoverLastKnownGoodFromCurrent("run-1", 2),
    CreateImagesRunJournalRevisionConflictError,
  );
  await store.recoverLastKnownGoodFromCurrent("run-1", 1);
  assert.equal((await store.health("run-1")).status, "healthy");
});

test("future-schema event logs and hostile durable indexes fail closed without overwrite", async (t) => {
  const root = await temporaryRoot(t);
  const store = new CreateImagesRunJournalStore(() => root);
  const journal = await store.start(startInput(), () => true);
  await append(store, journal, "run-started", {});
  const logPath = path.join(root, "runs", "run-1", "run.events.jsonl");
  const record = JSON.parse((await fs.readFile(logPath, "utf8")).trim()) as Record<string, unknown>;
  record.version = 2;
  await fs.writeFile(logPath, `${JSON.stringify(record)}\n`, "utf8");
  const health = await store.health("run-1");
  assert.equal(health.status, "unsafe");
  if (health.status === "unsafe") assert.equal(health.reason, "current-future-schema");

  const indexPath = path.join(root, "run-index.json");
  const hostile = '{"version":1,"revision":1,"entries":[{"runId":"../escape"}]}\n';
  await fs.writeFile(indexPath, hostile, "utf8");
  const restarted = new CreateImagesRunJournalStore(() => root);
  assert.deepEqual(await restarted.indexHealth(), { status: "corrupt" });
  await restarted.initialize();
  const rebuiltHealth = await restarted.indexHealth();
  assert.equal(rebuiltHealth.status, "degraded");
  if (rebuiltHealth.status === "degraded") {
    assert.equal(rebuiltHealth.degradedEntryCount, 1);
    assert.equal(rebuiltHealth.diagnostic, "rebuilt-corrupt-index");
    assert.equal(rebuiltHealth.quarantinedIndexCount, 1);
  }
  const quarantine = (await fs.readdir(root)).find((name) =>
    /^run-index\.corrupt\..+\.json$/u.test(name),
  );
  assert.ok(quarantine);
  assert.equal(await fs.readFile(path.join(root, quarantine), "utf8"), hostile);

  await fs.writeFile(indexPath, '{"version":2,"revision":1,"entries":[]}\n', "utf8");
  const future = new CreateImagesRunJournalStore(() => root);
  assert.deepEqual(await future.indexHealth(), { status: "unsafe" });
  await assert.rejects(future.initialize(), (error: unknown) => {
    assert.ok(error instanceof CreateImagesRunJournalLoadError);
    assert.equal(error.status, "unsafe");
    return true;
  });
});

test("same-process index cache rejects an atomically replaced future schema without overwrite", async (t) => {
  const root = await temporaryRoot(t);
  const store = new CreateImagesRunJournalStore(() => root);
  await store.start(startInput(), () => true);
  await store.initialize();
  assert.deepEqual(await store.auditWorkflowAdmission("workflow-1"), {
    hasDegradedAuthority: false,
    hasNonterminalRun: true,
    hasUnresolvedAmbiguity: false,
  });

  const indexPath = path.join(root, "run-index.json");
  const replacementPath = path.join(root, "run-index.future-replacement.json");
  const futureBytes = '{"version":2,"revision":99,"entries":[],"degraded":[]}\n';
  await fs.writeFile(replacementPath, futureBytes, "utf8");
  await fs.rename(replacementPath, indexPath);

  await assert.rejects(store.auditWorkflowAdmission("workflow-1"), (error: unknown) => {
    assert.ok(error instanceof CreateImagesRunJournalLoadError);
    assert.equal(error.status, "unsafe");
    return true;
  });
  assert.equal(await fs.readFile(indexPath, "utf8"), futureBytes);
  assert.deepEqual(await store.indexHealth(), { status: "unsafe" });
});

test("restart preserves future-schema and both-corrupt runs as bounded degraded records", async (t) => {
  const root = await temporaryRoot(t);
  const store = new CreateImagesRunJournalStore(() => root);
  await store.start(startInput("future-run"), () => true);
  await store.start(startInput("corrupt-run"), () => true);

  const futurePath = path.join(root, "runs", "future-run", "run.json");
  const future = JSON.parse(await fs.readFile(futurePath, "utf8")) as Record<string, unknown>;
  future.version = 2;
  await fs.writeFile(futurePath, `${JSON.stringify(future)}\n`, "utf8");
  await Promise.all([
    fs.writeFile(path.join(root, "runs", "corrupt-run", "run.json"), "{broken-current", "utf8"),
    fs.writeFile(
      path.join(root, "runs", "corrupt-run", "run.last-known-good.json"),
      "{broken-recovery",
      "utf8",
    ),
  ]);

  const restarted = new CreateImagesRunJournalStore(() => root);
  await restarted.initialize();
  const indexHealth = await restarted.indexHealth();
  assert.equal(indexHealth.status, "degraded");
  if (indexHealth.status === "degraded") assert.equal(indexHealth.degradedEntryCount, 2);
  assert.deepEqual(await restarted.workflowDegradedCandidates("workflow-1"), [
    {
      status: "recovery-required",
      runId: "corrupt-run",
      workflowId: "workflow-1",
      workflowRevision: 3,
      reason: "current-corrupt",
      canRecover: false,
    },
    {
      status: "unsafe",
      runId: "future-run",
      workflowId: "workflow-1",
      workflowRevision: 3,
      reason: "current-future-schema",
    },
  ]);
  assert.equal((await restarted.degradedRuns()).length, 2);
  assert.deepEqual(await restarted.referenceInventory(), {
    complete: false,
    records: [
      { runId: "corrupt-run", assetIds: [] },
      { runId: "future-run", assetIds: [] },
    ],
  });
});

test("startup revalidates a stale terminal index entry before reconciliation", async (t) => {
  const root = await temporaryRoot(t);
  const store = new CreateImagesRunJournalStore(() => root);
  await store.start(startInput("queued-run"), () => true);
  const indexPath = path.join(root, "run-index.json");
  const index = JSON.parse(await fs.readFile(indexPath, "utf8")) as {
    entries: Array<Record<string, unknown>>;
  };
  index.entries[0]!.status = "succeeded";
  index.entries[0]!.terminal = true;
  await fs.writeFile(indexPath, `${JSON.stringify(index)}\n`, "utf8");

  const restarted = new CreateImagesRunJournalStore(() => root);
  const health = await restarted.initialize();
  assert.deepEqual(health, [
    {
      status: "healthy",
      runId: "queued-run",
      journalRevision: 1,
      runStatus: "queued",
    },
  ]);
  assert.deepEqual(
    (await restarted.reconciliationCandidates()).map((journal) => journal.runId),
    ["queued-run"],
  );
  assert.deepEqual(await restarted.terminalHistory(), []);
});

test("startup surfaces a corrupt oldest terminal run beyond a 100-item history window", async (t) => {
  const root = await temporaryRoot(t);
  const runsPath = path.join(root, "runs");
  await fs.mkdir(runsPath, { recursive: true });
  const snapshot = emptyStartInput("seed").workflowSnapshot;
  snapshot.id = "workflow-1";
  const plan = {
    scope: { kind: "all" } as const,
    orderedNodeIds: ["prompt-only"],
    dependencies: { "prompt-only": [] },
  };
  const entries: Array<Record<string, unknown>> = [];
  for (let index = 1; index <= 101; index += 1) {
    const runId = `terminal-${String(index).padStart(3, "0")}`;
    const createdAt = new Date(Date.parse(NOW) + index * 10_000).toISOString();
    let journal = createCreateImagesRunJournal({
      runId,
      workflowSnapshot: snapshot,
      workflowFingerprint: createImagesWorkflowSnapshotFingerprint(snapshot),
      plan,
      createdAt,
    });
    for (const next of [
      { type: "run-started" as const },
      { type: "node-started" as const, nodeId: "prompt-only" },
      {
        type: "node-failed" as const,
        nodeId: "prompt-only",
        errorCode: "test-failure",
      },
      { type: "run-terminal" as const, status: "failed" as const },
    ]) {
      journal = appendCreateImagesRunEvent(journal, {
        ...next,
        workflowId: journal.workflowId,
        workflowRevision: journal.workflowRevision,
        runId,
        sequence: journal.events.length + 1,
        at: new Date(Date.parse(createdAt) + (journal.events.length + 1) * 1_000).toISOString(),
      } as CreateImagesRunEventV1);
    }
    const directory = path.join(runsPath, runId);
    await fs.mkdir(directory);
    const serialized = `${JSON.stringify(journal)}\n`;
    await Promise.all([
      fs.writeFile(path.join(directory, "run.json"), serialized, "utf8"),
      fs.writeFile(path.join(directory, "run.last-known-good.json"), serialized, "utf8"),
    ]);
    entries.push({
      runId,
      workflowId: "workflow-1",
      workflowRevision: snapshot.revision,
      journalRevision: journal.journalRevision,
      status: "failed",
      createdAt: journal.createdAt,
      updatedAt: journal.updatedAt,
      terminal: true,
      health: "healthy",
    });
  }
  await fs.writeFile(
    path.join(root, "run-index.json"),
    `${JSON.stringify({ version: 1, revision: 1, entries })}\n`,
    "utf8",
  );
  await fs.writeFile(
    path.join(runsPath, "terminal-001", "run.last-known-good.json"),
    "{broken-oldest",
    "utf8",
  );

  const restarted = new CreateImagesRunJournalStore(() => root);
  await restarted.initialize();
  const degraded = await restarted.workflowDegradedCandidates("workflow-1");
  assert.equal(degraded.length, 1);
  assert.equal(degraded[0]?.runId, "terminal-001");
  assert.equal((await restarted.terminalHistory()).length, 100);
  const health = await restarted.indexHealth();
  assert.equal(health.status, "degraded");
  assert.equal((await restarted.referenceInventory()).complete, false);
});

test("terminal pruning is explicit, CAS-bound, and releases references only after durable retirement", async (t) => {
  const root = await temporaryRoot(t);
  const store = new CreateImagesRunJournalStore(() => root);
  let journal = await store.start(emptyStartInput("run-prune"), () => true);
  journal = await append(store, journal, "run-started", {});
  journal = await append(store, journal, "node-started", {
    nodeId: "prompt-only",
  });
  journal = await append(store, journal, "node-failed", {
    nodeId: "prompt-only",
    errorCode: "test-failure",
  });
  journal = await append(store, journal, "run-terminal", { status: "failed" });
  const plan = await store.planTerminalPrune([
    { runId: journal.runId, journalRevision: journal.journalRevision },
  ]);
  assert.match(plan.token, /^[a-f0-9]{64}$/u);
  assert.equal((await store.terminalHistory()).length, 1);
  assert.deepEqual(await store.terminalPruneStatus(), { status: "none" });
  await assert.rejects(
    store.pruneTerminalRuns({
      ...plan,
      candidates: [{ runId: journal.runId, journalRevision: journal.journalRevision - 1 }],
    }),
    /stale|changed/u,
  );
  assert.equal((await store.terminalHistory()).length, 1);
  const result = await store.pruneTerminalRuns(plan);
  assert.deepEqual(result, {
    removedRunIds: ["run-prune"],
    releasedAssetIds: [],
  });
  assert.deepEqual(await store.referenceInventory(), {
    complete: true,
    records: [],
  });
  assert.deepEqual(await store.terminalHistory(), []);
  assert.equal((await store.health("run-prune")).status, "missing");
});

test("directory identity mismatches and copied journals fail closed", async (t) => {
  const root = await temporaryRoot(t);
  const store = new CreateImagesRunJournalStore(() => root);
  await store.start(startInput("run-source"), () => true);
  await fs.cp(path.join(root, "runs", "run-source"), path.join(root, "runs", "run-copy"), {
    recursive: true,
  });
  const copiedStore = new CreateImagesRunJournalStore(() => root);
  const copied = await copiedStore.health("run-copy");
  assert.equal(copied.status, "recovery-required");
  if (copied.status === "recovery-required") {
    assert.equal(copied.reason, "current-corrupt");
    assert.equal(copied.canRecover, false);
    assert.equal(copied.workflowId, undefined);
  }
  assert.equal((await copiedStore.referenceInventory()).complete, false);

  const pendingRoot = await temporaryRoot(t);
  const crashing = new CreateImagesRunJournalStore(() => pendingRoot, {
    afterPendingPublished: async () => {
      throw new Error("pending-boundary");
    },
  });
  await assert.rejects(
    crashing.start(startInput("run-pending-source"), () => true),
    /pending-boundary/u,
  );
  await fs.rename(
    path.join(pendingRoot, "runs", "run-pending-source"),
    path.join(pendingRoot, "runs", "run-pending-copy"),
  );
  const pendingHealth = await new CreateImagesRunJournalStore(() => pendingRoot).health(
    "run-pending-copy",
  );
  assert.equal(pendingHealth.status, "recovery-required");
  if (pendingHealth.status === "recovery-required") {
    assert.equal(pendingHealth.reason, "pending-corrupt");
  }
});

test("journal and tail caches remain count-and-byte bounded across initialize", async (t) => {
  const root = await temporaryRoot(t);
  const limits = {
    maxJournalCacheCount: 2,
    maxJournalCacheBytes: 256 * 1024,
    maxTailCacheCount: 2,
    maxTailCacheBytes: 4 * 1024,
  };
  const store = new CreateImagesRunJournalStore(() => root, {}, limits);
  for (let index = 1; index <= 5; index += 1) {
    await store.start(startInput(`run-cache-${index}`), () => true);
  }
  assert.ok(store.cacheStats().journalCount <= 2);
  assert.ok(store.cacheStats().journalBytes <= limits.maxJournalCacheBytes);

  const restarted = new CreateImagesRunJournalStore(() => root, {}, limits);
  await restarted.initialize();
  const stats = restarted.cacheStats();
  assert.ok(stats.journalCount <= 2);
  assert.ok(stats.journalBytes <= limits.maxJournalCacheBytes);
  assert.ok(stats.tailCount <= 2);
  assert.ok(stats.tailBytes <= limits.maxTailCacheBytes);
});

test("terminal prune crash boundaries retain the manifest, tombstone caches, and resume on startup", async (t) => {
  for (const boundary of [
    "afterPruneManifestPublished",
    "afterRunRetired",
    "beforeRetiredDelete",
    "afterRetiredDelete",
  ] as const) {
    const root = await temporaryRoot(t);
    let fail = true;
    const hook = async () => {
      if (!fail) return;
      fail = false;
      throw new Error(`crash-${boundary}`);
    };
    const store = new CreateImagesRunJournalStore(() => root, {
      [boundary]: hook,
    });
    const journal = await terminalFailedRun(store, `run-prune-${boundary}`);
    const plan = await store.planTerminalPrune([
      { runId: journal.runId, journalRevision: journal.journalRevision },
    ]);
    await assert.rejects(store.pruneTerminalRuns(plan), new RegExp(`crash-${boundary}`, "u"));
    assert.equal((await store.terminalPruneStatus()).status, "pending");
    assert.equal(await store.get(journal.runId), undefined);
    await fs.lstat(path.join(root, "run-prune.pending.json"));

    const restarted = new CreateImagesRunJournalStore(() => root);
    await restarted.initialize();
    assert.deepEqual(await restarted.terminalPruneStatus(), { status: "none" });
    assert.equal(await restarted.get(journal.runId), undefined);
    assert.deepEqual(await restarted.terminalHistory(), []);
  }
});

test("workflow recovery refresh and retention candidates are bounded index seams", async (t) => {
  const root = await temporaryRoot(t);
  const store = new CreateImagesRunJournalStore(() => root);
  const first = await terminalFailedRun(store, "run-retention-1", "workflow-retention");
  const second = await terminalFailedRun(store, "run-retention-2", "workflow-retention");
  const global = await store.terminalRetentionCandidates({
    keepLatest: 1,
    limit: 100,
  });
  assert.equal(global.length, 1);
  assert.equal(global[0]?.workflowId, "workflow-retention");
  const scoped = await store.terminalRetentionCandidates({
    workflowId: "workflow-retention",
    keepLatest: 1,
    limit: 100,
  });
  assert.deepEqual(scoped, global);

  await fs.writeFile(
    path.join(root, "runs", first.runId, "run.last-known-good.json"),
    "{broken",
    "utf8",
  );
  const refreshed = await store.refreshWorkflowRecoveryMetadata("workflow-retention", [
    first.runId,
    second.runId,
  ]);
  assert.equal(refreshed.length, 1);
  assert.equal(refreshed[0]?.runId, first.runId);
  assert.equal(refreshed[0]?.canRecover, "from-current");
  assert.deepEqual(await store.workflowRecoveryCandidates("workflow-retention"), refreshed);
});

test("run count and aggregate bytes are bounded before publication", async (t) => {
  const root = await temporaryRoot(t);
  const countBounded = new CreateImagesRunJournalStore(() => root, {}, { maxRunCount: 1 });
  await countBounded.start(startInput("run-1"), () => true);
  await assert.rejects(
    countBounded.start(startInput("run-2"), () => true),
    /run count limit/u,
  );

  const root2 = await temporaryRoot(t);
  const byteBounded = new CreateImagesRunJournalStore(() => root2, {}, { maxAggregateRunBytes: 1 });
  await assert.rejects(
    byteBounded.start(startInput(), () => true),
    /byte limit/u,
  );
  assert.equal((await byteBounded.health("run-1")).status, "missing");
});
