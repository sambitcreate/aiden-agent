import assert from "node:assert/strict";
import test from "node:test";
import { planWorkflowExecution } from "./execution.js";
import {
  appendCreateImagesRunEvent,
  CREATE_IMAGES_MAX_RUN_EVENTS,
  createCreateImagesRunJournal,
  hasUnresolvedCreateImagesRunAmbiguity,
  isFutureCreateImagesRunJournal,
  parseCreateImagesRunJournal,
  projectCreateImagesRun,
  type CreateImagesRunEventV1,
  type CreateImagesRunJournalV1,
} from "./run-contract.js";
import type { WorkflowDocumentV1 } from "./schema.js";

const NOW = "2026-08-11T12:00:00.000Z";
const LATER = "2026-08-11T12:00:01.000Z";
const FINGERPRINT = "a".repeat(64);
const ASSET_ID = "b".repeat(64);

function workflow(): WorkflowDocumentV1 {
  return {
    schemaVersion: 1,
    id: "workflow-1",
    title: "Run contract",
    revision: 7,
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

function scopedWorkflow(): WorkflowDocumentV1 {
  const snapshot = workflow();
  snapshot.nodes = [
    ...snapshot.nodes,
    {
      id: "unrelated-prompt",
      type: "prompt",
      position: { x: 0, y: 200 },
      data: { text: "Not selected" },
    },
  ];
  return snapshot;
}

function scopedJournal(): CreateImagesRunJournalV1 {
  const snapshot = scopedWorkflow();
  const scope = {
    kind: "from-node" as const,
    nodeId: "generate-1",
    downstreamPath: ["output-1"],
  };
  const plan = planWorkflowExecution(snapshot, scope);
  return createCreateImagesRunJournal({
    runId: "run-scoped",
    workflowSnapshot: snapshot,
    workflowFingerprint: FINGERPRINT,
    plan: {
      scope,
      orderedNodeIds: [...plan.orderedNodeIds],
      dependencies: Object.fromEntries(
        plan.orderedNodeIds.map((nodeId) => [nodeId, [...(plan.dependencies[nodeId] ?? [])]]),
      ),
    },
    createdAt: NOW,
  });
}

function initial(): CreateImagesRunJournalV1 {
  return createCreateImagesRunJournal({
    runId: "run-1",
    workflowSnapshot: workflow(),
    workflowFingerprint: FINGERPRINT,
    plan: {
      scope: { kind: "all" },
      orderedNodeIds: ["prompt-1", "generate-1", "output-1"],
      dependencies: {
        "prompt-1": [],
        "generate-1": ["prompt-1"],
        "output-1": ["generate-1"],
      },
    },
    createdAt: NOW,
  });
}

function event<T extends CreateImagesRunEventV1["type"]>(
  journal: CreateImagesRunJournalV1,
  type: T,
  fields: Omit<
    Extract<CreateImagesRunEventV1, { type: T }>,
    "type" | "workflowId" | "workflowRevision" | "runId" | "sequence" | "at"
  >,
  at = LATER,
): Extract<CreateImagesRunEventV1, { type: T }> {
  return {
    type,
    workflowId: journal.workflowId,
    workflowRevision: journal.workflowRevision,
    runId: journal.runId,
    sequence: journal.events.length + 1,
    at,
    ...fields,
  } as Extract<CreateImagesRunEventV1, { type: T }>;
}

function append<T extends CreateImagesRunEventV1["type"]>(
  journal: CreateImagesRunJournalV1,
  type: T,
  fields: Omit<
    Extract<CreateImagesRunEventV1, { type: T }>,
    "type" | "workflowId" | "workflowRevision" | "runId" | "sequence" | "at"
  >,
): CreateImagesRunJournalV1 {
  return appendCreateImagesRunEvent(journal, event(journal, type, fields));
}

function startGenerateNode(journal: CreateImagesRunJournalV1): CreateImagesRunJournalV1 {
  let next = append(journal, "node-started", { nodeId: "prompt-1" });
  next = append(next, "node-output-published", { nodeId: "prompt-1", outputAssetIds: [] });
  next = append(next, "node-succeeded", { nodeId: "prompt-1", outputAssetIds: [] });
  return append(next, "node-started", { nodeId: "generate-1" });
}

test("paused checkpoints are recoverable and resume the same immutable run", () => {
  let journal = initial();
  journal = append(journal, "run-started", {});
  journal = append(journal, "node-started", { nodeId: "prompt-1" });
  journal = append(journal, "node-output-published", {
    nodeId: "prompt-1",
    outputAssetIds: [],
  });
  journal = append(journal, "node-succeeded", { nodeId: "prompt-1", outputAssetIds: [] });
  journal = append(journal, "run-paused", {
    checkpointId: "checkpoint-1",
    beforeNodeId: "generate-1",
    edgeIds: ["edge-prompt"],
  });
  const paused = projectCreateImagesRun(journal);
  assert.equal(paused.status, "paused");
  assert.equal(paused.pause?.beforeNodeId, "generate-1");
  assert.equal(paused.nodes["generate-1"]?.status, "queued");

  journal = append(journal, "run-resumed", { checkpointId: "checkpoint-1" });
  journal = append(journal, "node-started", { nodeId: "generate-1" });
  const resumed = projectCreateImagesRun(journal);
  assert.equal(resumed.status, "running");
  assert.equal(resumed.pause?.resumedAt, LATER);
  assert.equal(resumed.nodes["prompt-1"]?.status, "succeeded");
  assert.equal(resumed.nodes["generate-1"]?.status, "running");
});

test("batch items journal ordered submission, output, usage, and unknown cost independently", () => {
  let journal = append(initial(), "run-started", {});
  journal = startGenerateNode(journal);
  journal = append(journal, "node-submission-prepared", {
    nodeId: "generate-1",
    attempt: 1,
    idempotencyKey: "aiden-batch-idempotency-0001",
    providerId: "gemini",
    modelId: "gemini-3.1-flash-image",
  });
  journal = append(journal, "batch-item-state", {
    nodeId: "generate-1",
    itemId: "batch-item-1",
    itemIndex: 0,
    state: "queued",
  });
  journal = append(journal, "batch-item-state", {
    nodeId: "generate-1",
    itemId: "batch-item-1",
    itemIndex: 0,
    state: "submission_prepared",
  });
  journal = append(journal, "batch-item-state", {
    nodeId: "generate-1",
    itemId: "batch-item-1",
    itemIndex: 0,
    state: "submitted",
  });
  journal = append(journal, "batch-item-state", {
    nodeId: "generate-1",
    itemId: "batch-item-1",
    itemIndex: 0,
    state: "succeeded",
    outputAssetIds: [ASSET_ID],
    usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
    cost: { kind: "unknown" },
  });
  journal = append(journal, "node-submission-accepted", {
    nodeId: "generate-1",
    attempt: 1,
    providerJobId: "gemini-batch-job-1",
  });
  journal = append(journal, "node-output-published", {
    nodeId: "generate-1",
    outputAssetIds: [ASSET_ID],
  });
  journal = append(journal, "node-succeeded", {
    nodeId: "generate-1",
    outputAssetIds: [ASSET_ID],
  });
  const item = projectCreateImagesRun(journal).nodes["generate-1"]?.batchItems?.["batch-item-1"];
  assert.equal(item?.state, "succeeded");
  assert.deepEqual(item?.outputAssetIds, [ASSET_ID]);
  assert.deepEqual(item?.usage, { inputTokens: 10, outputTokens: 20, totalTokens: 30 });
  assert.deepEqual(item?.cost, { kind: "unknown" });
});

function startedGenerateJournal(): CreateImagesRunJournalV1 {
  return startGenerateNode(append(initial(), "run-started", {}));
}

test("creates a strict immutable path-free and credential-free journal", () => {
  const journal = initial();
  assert.equal(journal.journalRevision, 1);
  assert.equal(journal.workflowRevision, 7);
  assert.equal(journal.workflowFingerprint, FINGERPRINT);
  assert.equal(Object.isFrozen(journal), true);
  assert.equal(Object.isFrozen(journal.workflowSnapshot.nodes[0]?.data), true);
  assert.equal(JSON.stringify(journal).includes("credential"), false);
  assert.equal(JSON.stringify(journal).includes("Path"), false);

  const withCredential = { ...structuredClone(journal), credential: "secret" };
  const parsedCredential = parseCreateImagesRunJournal(withCredential);
  assert.equal(parsedCredential.success, false);
  if (!parsedCredential.success) {
    assert.ok(parsedCredential.issues.some((candidate) => candidate.code === "unknown_field"));
  }
  assert.equal(
    parseCreateImagesRunJournal({
      ...structuredClone(journal),
      workflowFingerprint: "/tmp/key",
    }).success,
    false,
  );
});

test("persists ambiguous attempts and forbids a retry until not-found reconciliation", () => {
  let journal = startedGenerateJournal();
  journal = append(journal, "node-submission-prepared", {
    nodeId: "generate-1",
    attempt: 1,
    idempotencyKey: "idem-run1-node1-0001",
    providerId: "mock",
    modelId: "mock-image-v1",
  });
  journal = append(journal, "node-submission-ambiguous", {
    nodeId: "generate-1",
    attempt: 1,
  });
  assert.throws(
    () =>
      append(journal, "node-failed", {
        nodeId: "generate-1",
        errorCode: "interrupted",
      }),
    /ambiguous submission/u,
  );
  assert.throws(
    () =>
      append(journal, "node-submission-prepared", {
        nodeId: "generate-1",
        attempt: 2,
        idempotencyKey: "idem-run1-node1-0002",
        providerId: "mock",
        modelId: "mock-image-v1",
      }),
    /safely sealed/u,
  );
  journal = append(journal, "node-submission-reconciled", {
    nodeId: "generate-1",
    attempt: 1,
    outcome: "not-found",
  });
  journal = append(journal, "node-submission-prepared", {
    nodeId: "generate-1",
    attempt: 2,
    idempotencyKey: "idem-run1-node1-0002",
    providerId: "mock",
    modelId: "mock-image-v1",
  });
  journal = append(journal, "node-submission-accepted", {
    nodeId: "generate-1",
    attempt: 2,
    providerJobId: "mock-job-2",
  });
  const projection = projectCreateImagesRun(journal);
  assert.deepEqual(
    projection.nodes["generate-1"]?.attempts.map((attempt) => attempt.submission),
    ["reconciled-not-found", "accepted"],
  );
});

test("accepted reconciliation requires a durable job ID and rejects duplicate idempotency keys", () => {
  let journal = startedGenerateJournal();
  journal = append(journal, "node-submission-prepared", {
    nodeId: "generate-1",
    attempt: 1,
    idempotencyKey: "idem-run1-node1-0001",
    providerId: "mock",
    modelId: "mock-image-v1",
  });
  journal = append(journal, "node-submission-ambiguous", {
    nodeId: "generate-1",
    attempt: 1,
  });
  assert.throws(
    () =>
      append(journal, "node-submission-reconciled", {
        nodeId: "generate-1",
        attempt: 1,
        outcome: "accepted",
      }),
    /provider job ID/u,
  );
  journal = append(journal, "node-submission-reconciled", {
    nodeId: "generate-1",
    attempt: 1,
    outcome: "not-found",
  });
  assert.throws(
    () =>
      append(journal, "node-submission-prepared", {
        nodeId: "generate-1",
        attempt: 2,
        idempotencyKey: "idem-run1-node1-0001",
        providerId: "mock",
        modelId: "mock-image-v1",
      }),
    /unique per run/u,
  );
});

test("safe retry scheduling seals an attempt and makes idempotency relation explicit", () => {
  let journal = startedGenerateJournal();
  journal = append(journal, "node-submission-prepared", {
    nodeId: "generate-1",
    attempt: 1,
    idempotencyKey: "idem-run1-node1-0001",
    providerId: "mock",
    modelId: "mock-image-v1",
  });
  journal = append(journal, "node-submission-ambiguous", {
    nodeId: "generate-1",
    attempt: 1,
  });
  journal = append(journal, "node-retry-scheduled", {
    nodeId: "generate-1",
    attempt: 1,
    errorCode: "transport-timeout",
    delayMs: 1_000,
    retrySafety: "same-idempotency-key",
  });
  assert.throws(
    () =>
      append(journal, "node-submission-prepared", {
        nodeId: "generate-1",
        attempt: 2,
        idempotencyKey: "idem-run1-node1-0002",
        providerId: "mock",
        modelId: "mock-image-v1",
      }),
    /reuse the prior/u,
  );
  journal = append(journal, "node-submission-prepared", {
    nodeId: "generate-1",
    attempt: 2,
    idempotencyKey: "idem-run1-node1-0001",
    providerId: "mock",
    modelId: "mock-image-v1",
  });
  const first = projectCreateImagesRun(journal).nodes["generate-1"]?.attempts[0];
  assert.deepEqual(first?.retry, {
    errorCode: "transport-timeout",
    delayMs: 1_000,
    safety: "same-idempotency-key",
  });
});

test("same-idempotency retry exception never authorizes cross-node key reuse", () => {
  const snapshot = workflow();
  snapshot.nodes.splice(2, 0, {
    ...structuredClone(snapshot.nodes[1]!),
    id: "generate-2",
    position: { x: 100, y: 100 },
  });
  snapshot.edges.splice(1, 0, {
    id: "edge-prompt-2",
    source: "prompt-1",
    sourcePort: "text",
    target: "generate-2",
    targetPort: "prompt",
  });
  const canonical = planWorkflowExecution(snapshot, { kind: "all" });
  let journal = createCreateImagesRunJournal({
    runId: "run-cross-node",
    workflowSnapshot: snapshot,
    workflowFingerprint: FINGERPRINT,
    plan: {
      scope: { kind: "all" },
      orderedNodeIds: [...canonical.orderedNodeIds],
      dependencies: Object.fromEntries(
        canonical.orderedNodeIds.map((nodeId) => [
          nodeId,
          [...(canonical.dependencies[nodeId] ?? [])],
        ]),
      ),
    },
    createdAt: NOW,
  });
  journal = append(journal, "run-started", {});
  journal = append(journal, "node-started", { nodeId: "prompt-1" });
  journal = append(journal, "node-output-published", {
    nodeId: "prompt-1",
    outputAssetIds: [],
  });
  journal = append(journal, "node-succeeded", { nodeId: "prompt-1", outputAssetIds: [] });
  journal = append(journal, "node-started", { nodeId: "generate-1" });
  journal = append(journal, "node-submission-prepared", {
    nodeId: "generate-1",
    attempt: 1,
    idempotencyKey: "idem-shared-node-0001",
    providerId: "mock",
    modelId: "mock-image-v1",
  });
  journal = append(journal, "node-started", { nodeId: "generate-2" });
  assert.throws(
    () =>
      append(journal, "node-submission-prepared", {
        nodeId: "generate-2",
        attempt: 1,
        idempotencyKey: "idem-shared-node-0001",
        providerId: "mock",
        modelId: "mock-image-v1",
      }),
    /unique per run/u,
  );
});

test("unresolved ambiguity is explicit terminal history and cannot silently resubmit", () => {
  let journal = startedGenerateJournal();
  journal = append(journal, "node-submission-prepared", {
    nodeId: "generate-1",
    attempt: 1,
    idempotencyKey: "idem-run1-node1-0001",
    providerId: "mock",
    modelId: "mock-image-v1",
  });
  journal = append(journal, "node-submission-ambiguous", {
    nodeId: "generate-1",
    attempt: 1,
  });
  journal = append(journal, "node-ambiguous", {
    nodeId: "generate-1",
    attempt: 1,
  });
  journal = append(journal, "node-blocked", {
    nodeId: "output-1",
    upstreamNodeIds: ["generate-1"],
  });
  assert.throws(() => append(journal, "run-terminal", { status: "failed" }), /needs-attention/u);
  journal = append(journal, "run-terminal", { status: "needs_attention" });
  const projection = projectCreateImagesRun(journal);
  assert.equal(projection.status, "needs_attention");
  assert.equal(projection.nodes["generate-1"]?.status, "ambiguous");
  assert.equal(hasUnresolvedCreateImagesRunAmbiguity(projection), true);
  assert.throws(
    () =>
      append(journal, "node-submission-prepared", {
        nodeId: "generate-1",
        attempt: 2,
        idempotencyKey: "idem-run1-node1-0001",
        providerId: "mock",
        modelId: "mock-image-v1",
      }),
    /Terminal runs/u,
  );
  assert.throws(
    () =>
      append(journal, "run-ambiguity-acknowledged", {
        expectedNeedsAttentionJournalRevision: journal.journalRevision - 1,
      }),
    /exact needs-attention journal revision/u,
  );
  const needsAttentionJournalRevision = journal.journalRevision;
  journal = append(journal, "run-ambiguity-acknowledged", {
    expectedNeedsAttentionJournalRevision: needsAttentionJournalRevision,
  });
  const acknowledged = projectCreateImagesRun(journal);
  assert.equal(acknowledged.status, "needs_attention");
  assert.equal(acknowledged.nodes["generate-1"]?.status, "ambiguous");
  assert.equal(hasUnresolvedCreateImagesRunAmbiguity(acknowledged), false);
  assert.deepEqual(acknowledged.ambiguityResolution, {
    kind: "acknowledged-unresolved-submission",
    acknowledgedAt: LATER,
    acknowledgedAtJournalRevision: needsAttentionJournalRevision + 1,
  });
  assert.throws(
    () =>
      append(journal, "run-ambiguity-acknowledged", {
        expectedNeedsAttentionJournalRevision: journal.journalRevision,
      }),
    /only once/u,
  );
});

test("monotonic identity-bound events reject gaps, duplicates, stale revisions, and time reversal", () => {
  const journal = initial();
  const started = event(journal, "run-started", {});
  for (const mutation of [
    { ...started, sequence: 2 },
    { ...started, runId: "run-old" },
    { ...started, workflowRevision: 8 },
    { ...started, at: "2026-08-11T11:59:59.000Z" },
  ]) {
    assert.throws(() => appendCreateImagesRunEvent(journal, mutation), /Run|Event|time/u);
  }
  const next = appendCreateImagesRunEvent(journal, started);
  assert.throws(() => appendCreateImagesRunEvent(next, started), /monotonic/u);
});

test("durable cancellation prevents new starts and requires all nodes terminal before the run", () => {
  let journal = startedGenerateJournal();
  journal = append(journal, "run-cancel-requested", { reason: "user" });
  assert.throws(() => append(journal, "node-started", { nodeId: "output-1" }), /non-cancelled/u);
  assert.throws(
    () => append(journal, "node-failed", { nodeId: "output-1", errorCode: "interrupted" }),
    /queued interruption/u,
  );
  assert.throws(
    () => append(journal, "run-terminal", { status: "cancelled" }),
    /Every planned node/u,
  );
  journal = append(journal, "node-cancelled", { nodeId: "generate-1" });
  journal = append(journal, "node-cancelled", { nodeId: "output-1" });
  journal = append(journal, "run-terminal", { status: "cancelled" });
  const projection = projectCreateImagesRun(journal);
  assert.equal(projection.status, "cancelled");
  assert.deepEqual(projection.cancellation, {
    reason: "user",
    requestedAt: LATER,
  });
  assert.throws(
    () => append(journal, "run-cancel-requested", { reason: "user" }),
    /Terminal runs/u,
  );
});

test("queued interruption can terminalize a never-started run without fabricated provenance", () => {
  const snapshot: WorkflowDocumentV1 = {
    ...workflow(),
    nodes: [
      {
        id: "prompt-only",
        type: "prompt",
        position: { x: 0, y: 0 },
        data: { text: "Interrupted before launch" },
      },
    ],
    edges: [],
  };
  const queued = createCreateImagesRunJournal({
    runId: "run-interrupted-before-start",
    workflowSnapshot: snapshot,
    workflowFingerprint: FINGERPRINT,
    plan: {
      scope: { kind: "all" },
      orderedNodeIds: ["prompt-only"],
      dependencies: { "prompt-only": [] },
    },
    createdAt: NOW,
  });
  let interrupted = append(queued, "node-failed", {
    nodeId: "prompt-only",
    errorCode: "interrupted",
  });
  interrupted = append(interrupted, "run-terminal", { status: "interrupted" });
  const projection = projectCreateImagesRun(interrupted);
  assert.equal(projection.status, "interrupted");
  assert.equal(projection.nodes["prompt-only"]?.status, "failed");
  assert.equal(projection.cancellation, undefined);
  assert.equal(
    interrupted.events.some((candidate) => candidate.type === "run-started"),
    false,
  );
  assert.equal(
    interrupted.events.some((candidate) => candidate.type === "node-started"),
    false,
  );

  assert.throws(
    () => append(queued, "node-failed", { nodeId: "prompt-only", errorCode: "provider-error" }),
    /queued interruption/u,
  );
});

test("terminal history retains durable asset outputs and enforces dependency order", () => {
  let journal = append(initial(), "run-started", {});
  assert.throws(() => append(journal, "node-started", { nodeId: "output-1" }), /dependencies/u);
  journal = startGenerateNode(journal);
  journal = append(journal, "node-submission-prepared", {
    nodeId: "generate-1",
    attempt: 1,
    idempotencyKey: "idem-run1-node1-0001",
    providerId: "mock",
    modelId: "mock-image-v1",
  });
  journal = append(journal, "node-submission-accepted", {
    nodeId: "generate-1",
    attempt: 1,
    providerJobId: "mock-job-1",
  });
  assert.throws(
    () =>
      append(journal, "node-succeeded", {
        nodeId: "generate-1",
        outputAssetIds: [ASSET_ID],
      }),
    /published durable output positions/u,
  );
  journal = append(journal, "node-output-published", {
    nodeId: "generate-1",
    outputAssetIds: [ASSET_ID, ASSET_ID],
  });
  journal = append(journal, "node-succeeded", {
    nodeId: "generate-1",
    outputAssetIds: [ASSET_ID, ASSET_ID],
  });
  journal = append(journal, "node-started", { nodeId: "output-1" });
  journal = append(journal, "node-output-published", {
    nodeId: "output-1",
    outputAssetIds: [],
  });
  journal = append(journal, "node-succeeded", {
    nodeId: "output-1",
    outputAssetIds: [],
  });
  journal = append(journal, "run-terminal", { status: "succeeded" });
  const projection = projectCreateImagesRun(journal);
  assert.equal(projection.status, "succeeded");
  assert.deepEqual(projection.nodes["generate-1"]?.durableOutputAssetIds, [ASSET_ID, ASSET_ID]);
  assert.deepEqual(projection.nodes["generate-1"]?.outputAssetIds, [ASSET_ID, ASSET_ID]);
  assert.equal(projection.terminal?.status, "succeeded");
});

test("strict plan validation rejects forged dependencies and unknown plan fields", () => {
  const journal = structuredClone(initial());
  journal.plan.dependencies["output-1"] = [];
  const forged = parseCreateImagesRunJournal(journal);
  assert.equal(forged.success, false);
  if (!forged.success)
    assert.ok(forged.issues.some((candidate) => candidate.path.includes("dependencies")));
  const unknown = structuredClone(initial()) as CreateImagesRunJournalV1 & {
    plan: CreateImagesRunJournalV1["plan"] & { credentialPath: string };
  };
  unknown.plan.credentialPath = "/tmp/key";
  assert.equal(parseCreateImagesRunJournal(unknown).success, false);
  const omittedRunAllNode = structuredClone(initial());
  omittedRunAllNode.plan.orderedNodeIds = ["generate-1"];
  omittedRunAllNode.plan.dependencies = { "generate-1": [] };
  assert.equal(parseCreateImagesRunJournal(omittedRunAllNode).success, false);
});

test("strict scoped plans cannot omit required ancestors or selected downstream nodes", () => {
  const omittedAncestor = structuredClone(scopedJournal());
  omittedAncestor.plan.orderedNodeIds = ["generate-1", "output-1"];
  omittedAncestor.plan.dependencies = {
    "generate-1": [],
    "output-1": ["generate-1"],
  };
  const parsedAncestor = parseCreateImagesRunJournal(omittedAncestor);
  assert.equal(parsedAncestor.success, false);
  if (!parsedAncestor.success) {
    assert.ok(
      parsedAncestor.issues.some(
        (candidate) =>
          candidate.path === "plan.orderedNodeIds" && candidate.message.includes("run scope"),
      ),
    );
  }

  const omittedDownstream = structuredClone(scopedJournal());
  omittedDownstream.plan.orderedNodeIds = ["prompt-1", "generate-1"];
  omittedDownstream.plan.dependencies = {
    "prompt-1": [],
    "generate-1": ["prompt-1"],
  };
  const parsedDownstream = parseCreateImagesRunJournal(omittedDownstream);
  assert.equal(parsedDownstream.success, false);
  if (!parsedDownstream.success) {
    assert.ok(parsedDownstream.issues.some((candidate) => candidate.path === "plan.scope"));
  }
});

test("strict scoped plans cannot add unrelated work or change deterministic order", () => {
  const unrelated = structuredClone(scopedJournal());
  unrelated.plan.orderedNodeIds.push("unrelated-prompt");
  unrelated.plan.dependencies["unrelated-prompt"] = [];
  const parsedUnrelated = parseCreateImagesRunJournal(unrelated);
  assert.equal(parsedUnrelated.success, false);
  if (!parsedUnrelated.success) {
    assert.ok(parsedUnrelated.issues.some((candidate) => candidate.path === "plan.orderedNodeIds"));
  }

  const snapshot: WorkflowDocumentV1 = {
    ...workflow(),
    nodes: [
      { id: "prompt-a", type: "prompt", position: { x: 0, y: 0 }, data: { text: "A" } },
      { id: "prompt-b", type: "prompt", position: { x: 100, y: 0 }, data: { text: "B" } },
    ],
    edges: [],
  };
  const reordered = createCreateImagesRunJournal({
    runId: "run-stable-order",
    workflowSnapshot: snapshot,
    workflowFingerprint: FINGERPRINT,
    plan: {
      scope: { kind: "all" },
      orderedNodeIds: ["prompt-a", "prompt-b"],
      dependencies: { "prompt-a": [], "prompt-b": [] },
    },
    createdAt: NOW,
  });
  const forgedOrder = structuredClone(reordered);
  forgedOrder.plan.orderedNodeIds = ["prompt-b", "prompt-a"];
  forgedOrder.plan.dependencies = { "prompt-b": [], "prompt-a": [] };
  const parsedOrder = parseCreateImagesRunJournal(forgedOrder);
  assert.equal(parsedOrder.success, false);
  if (!parsedOrder.success) {
    assert.ok(parsedOrder.issues.some((candidate) => candidate.path === "plan.orderedNodeIds"));
  }
});

test("future schemas and bounded event/byte histories fail closed", () => {
  assert.equal(isFutureCreateImagesRunJournal({ version: 2 }), true);
  assert.equal(
    parseCreateImagesRunJournal({ ...structuredClone(initial()), version: 2 }).success,
    false,
  );
  const tooMany = {
    ...structuredClone(initial()),
    journalRevision: CREATE_IMAGES_MAX_RUN_EVENTS + 2,
    events: new Array(CREATE_IMAGES_MAX_RUN_EVENTS + 1).fill({}),
  };
  const parsedCount = parseCreateImagesRunJournal(tooMany);
  assert.equal(parsedCount.success, false);
  if (!parsedCount.success)
    assert.ok(parsedCount.issues.some((candidate) => candidate.code === "too_large"));
  const oversized = structuredClone(initial()) as unknown as Record<string, unknown>;
  oversized.padding = "x".repeat(16 * 1024 * 1024);
  const parsedBytes = parseCreateImagesRunJournal(oversized);
  assert.equal(parsedBytes.success, false);
  if (!parsedBytes.success) assert.equal(parsedBytes.issues[0]?.code, "too_large");
});
