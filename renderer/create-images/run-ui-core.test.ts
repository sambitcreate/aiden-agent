import assert from "node:assert/strict";
import test from "node:test";
import {
  createImagesRunConfirmationViewModel,
  createImagesDegradedRunDiscardRequest,
  createImagesRunErrorViewModel,
  createImagesSafeRunDiagnosticSummary,
  createImagesRunUiProjection,
  createImagesTerminalRunHistoryViews,
  formatCreateImagesEstimate,
  reduceCreateImagesRunUiEvent,
  summarizeCreateImagesRunProgress,
  type CreateImagesNodeRunUiState,
  type CreateImagesRunConfirmationInput,
  type CreateImagesRunUiEvent,
  type CreateImagesRunUiSnapshot,
} from "./run-ui-core";
import {
  createImagesRunProjectionFromView,
  createImagesSelectedRunSnapshotTransition,
  createImagesRunSubscriptionController,
  isCreateImagesRunAmbiguityRequestCurrent,
  isCreateImagesRunHistoryRequestCurrent,
  isCreateImagesRunRecoveryRequestCurrent,
  reconcileCreateImagesRunMutation,
  reconcileCreateImagesRunState,
  removeCreateImagesRunRecord,
} from "./run-ui-adapter";
import type {
  CreateImagesRunChangedNotification,
  CreateImagesRunListResult,
  CreateImagesRunSubscriptionResult,
  CreateImagesTerminalRunView,
  CreateImagesRunView,
} from "../shared/create-images/ipc";
import {
  CREATE_IMAGES_LOCAL_MOCK_RETRY_POLICY,
  createImagesLocalMockAttemptBudget,
} from "../shared/create-images/retry-policy";

const identity = {
  workflowId: "workflow-1",
  workflowRevision: 7,
  runId: "run-1",
} as const;

function confirmation(
  overrides: Partial<CreateImagesRunConfirmationInput> = {},
): CreateImagesRunConfirmationInput {
  return {
    workflowId: "workflow-1",
    workflowTitle: "Campaign key art",
    workflowRevision: 7,
    scope: { kind: "all", includedNodeCount: 4 },
    executionMode: "local-mock",
    providerLabel: "Aiden local mock",
    modelLabel: "Deterministic checkerboard",
    remoteRequestCount: 1,
    outputCount: 1,
    imageSizeLabel: "1024 × 1024",
    qualityLabel: "Preview quality",
    referenceImageCount: 0,
    sendsPrompt: true,
    estimate: {
      kind: "mock",
      amount: 0,
      currency: "USD",
      estimatedAt: "2026-08-11T12:00:00.000Z",
      sourceLabel: "Deterministic Phase 3 estimate",
    },
    ...overrides,
  };
}

function snapshot(overrides: Partial<CreateImagesRunUiSnapshot> = {}): CreateImagesRunUiSnapshot {
  return {
    ...identity,
    status: "running",
    lastSequence: 0,
    nodes: [
      { nodeId: "prompt-1", label: "Prompt", status: "queued", attempt: 0 },
      { nodeId: "generate-1", label: "Generate Image", status: "queued", attempt: 0 },
    ],
    ...overrides,
  };
}

type EventWithoutIdentity<T> = T extends CreateImagesRunUiEvent
  ? Omit<T, keyof typeof identity>
  : never;

function event(value: EventWithoutIdentity<CreateImagesRunUiEvent>): CreateImagesRunUiEvent {
  return { ...identity, ...value } as CreateImagesRunUiEvent;
}

test("local mock confirmation states $0 and no network or billable work", () => {
  const model = createImagesRunConfirmationViewModel(confirmation());
  assert.equal(model.title, "Run workflow?");
  assert.equal(model.confirmLabel, "Run mock workflow");
  assert.match(model.estimateLabel, /0[.,]00.*mock estimate/iu);
  assert.equal(model.isMock, true);
  assert.match(
    model.rows.find((row) => row.id === "privacy")?.value ?? "",
    /nothing leaves this Mac/u,
  );
  assert.match(model.privacyNotices.join(" "), /no provider request/u);
  assert.match(model.privacyNotices.join(" "), /no billable work/u);
  assert.match(model.consentStatement, /reviewed this mock run plan/u);
});

test("authoritative snapshots accept terminal local nodes without a provider attempt", () => {
  const projection = createImagesRunUiProjection(
    snapshot({
      status: "failed",
      lastSequence: 8,
      nodes: [
        { nodeId: "prompt-1", label: "Prompt", status: "succeeded", attempt: 0 },
        { nodeId: "image-1", label: "Image Input", status: "succeeded", attempt: 0 },
        { nodeId: "generate-1", label: "Generate Image", status: "failed", attempt: 1 },
        { nodeId: "output-1", label: "Output", status: "blocked", attempt: 0 },
      ],
    }),
  );
  assert.equal(projection.status, "failed");
  assert.equal(projection.nodes["prompt-1"]?.attempt, 0);
  assert.equal(projection.nodes["image-1"]?.status, "succeeded");
});

test("degraded-run discard echoes only the reviewed plan's CAS revisions and token", () => {
  const plan = {
    status: "ready" as const,
    runId: "run-unsafe-1",
    reason: "unsafe-storage" as const,
    association: "unassociated" as const,
    expectedCurrentJournalRevision: 9,
    authorizationToken: "c".repeat(64),
    mayLoseOutputs: true as const,
    mayDuplicateProviderWork: true as const,
  };
  assert.equal(createImagesDegradedRunDiscardRequest(plan, false), undefined);
  assert.deepEqual(createImagesDegradedRunDiscardRequest(plan, true), {
    runId: "run-unsafe-1",
    expectedCurrentJournalRevision: 9,
    authorizationToken: "c".repeat(64),
    confirmed: true,
  });
});

function runView(overrides: Partial<CreateImagesRunView> = {}): CreateImagesRunView {
  return {
    runId: "run-1",
    workflowId: "workflow-1",
    workflowRevision: 7,
    journalRevision: 1,
    status: "running",
    lastSequence: 0,
    scope: { kind: "all" },
    createdAt: "2026-08-11T12:00:00.000Z",
    updatedAt: "2026-08-11T12:00:00.000Z",
    nodes: [
      {
        nodeId: "generate-1",
        label: "Generate Image",
        status: "queued",
        attempt: 0,
        outputAssetIds: [],
      },
    ],
    ...overrides,
  };
}

function terminalRunView(
  overrides: Partial<CreateImagesTerminalRunView> = {},
): CreateImagesTerminalRunView {
  return {
    runId: "run-1",
    workflowRevision: 7,
    status: "succeeded",
    scope: { kind: "all" },
    createdAt: "2026-08-11T12:00:00.000Z",
    updatedAt: "2026-08-11T12:01:00.000Z",
    requestCount: 1,
    outputCount: 1,
    completedNodeCount: 1,
    totalNodeCount: 1,
    ...overrides,
  };
}

test("safe run diagnostics include states and codes without content or assets", () => {
  const diagnostic = createImagesSafeRunDiagnosticSummary(
    runView({
      status: "needs_attention",
      executionMode: "gemini",
      nodes: [
        {
          nodeId: "generate-1",
          label: "Secret prompt label",
          status: "failed",
          attempt: 1,
          outputAssetIds: ["a".repeat(64)],
          errorCode: "request_rejected",
        },
      ],
    }),
  );
  assert.match(diagnostic, /"errorCode": "request_rejected"/u);
  assert.match(diagnostic, /"outputCount": 1/u);
  assert.doesNotMatch(diagnostic, /Secret prompt label/u);
  assert.doesNotMatch(diagnostic, new RegExp("a{64}", "u"));
  assert.doesNotMatch(diagnostic, /prompt|credential|providerResponse|path/u);
});

test("shared run snapshots map retries, ambiguity, safe errors, and output IDs", () => {
  const assetId = "a".repeat(64);
  const projection = createImagesRunProjectionFromView(
    runView({
      lastSequence: 9,
      nodes: [
        {
          nodeId: "generate-1",
          label: "Generate Image",
          status: "running",
          attempt: 1,
          outputAssetIds: [assetId],
          retrySafety: "confirmed-not-submitted",
          errorCode: "rate-limited",
        },
        {
          nodeId: "generate-2",
          label: "Generate Image 2",
          status: "ambiguous",
          attempt: 1,
          outputAssetIds: [],
        },
      ],
    }),
  );
  assert.equal(projection.nodes["generate-1"]?.status, "retry");
  assert.equal(projection.nodes["generate-1"]?.retryMode, "automatic-mock");
  assert.deepEqual(projection.nodes["generate-1"]?.outputAssetIds, [assetId]);
  assert.equal(projection.nodes["generate-2"]?.status, "retry");
  assert.equal(projection.nodes["generate-2"]?.retryMode, "manual-review");
  assert.equal(projection.nodes["generate-2"]?.error?.code, "submission_ambiguous");
  assert.equal(projection.nodes["generate-2"]?.error?.retryKind, "none");
});

test("an acknowledged ambiguity preserves the warning but releases the renderer admission block", () => {
  const projection = createImagesRunProjectionFromView(
    runView({
      status: "needs_attention",
      journalRevision: 8,
      lastSequence: 7,
      ambiguityResolution: {
        kind: "acknowledged-unresolved-submission",
        acknowledgedAt: "2026-08-11T12:00:07.000Z",
        acknowledgedAtJournalRevision: 8,
      },
      nodes: [
        {
          nodeId: "generate-1",
          label: "Generate Image",
          status: "ambiguous",
          attempt: 1,
          outputAssetIds: [],
        },
      ],
    }),
  );
  assert.equal(projection.status, "retry");
  assert.equal(projection.nodes["generate-1"]?.retryMode, "manual-review");
  assert.equal(projection.ambiguityAcknowledged, true);
});

test("an authoritative acknowledgement snapshot immediately clears the renderer admission block", () => {
  const ambiguousRun = runView({
    status: "needs_attention",
    lastSequence: 7,
    nodes: [
      {
        nodeId: "generate-1",
        label: "Generate Image",
        status: "ambiguous",
        attempt: 1,
        outputAssetIds: [],
      },
    ],
  });
  const terminal = {
    runId: "run-1",
    workflowRevision: 7,
    status: "needs_attention" as const,
    scope: { kind: "all" as const },
    createdAt: "2026-08-11T12:00:00.000Z",
    updatedAt: "2026-08-11T12:00:07.000Z",
    requestCount: 1,
    outputCount: 0,
    completedNodeCount: 0,
    totalNodeCount: 1,
  };
  const unresolved = reconcileCreateImagesRunState(
    undefined,
    {
      status: "ready",
      authoritative: true,
      latestTerminalRun: ambiguousRun,
      history: [terminal],
      recoveries: [],
    },
    "workflow-1",
  );
  assert.equal(unresolved.projection?.ambiguityAcknowledged, undefined);

  const ambiguityResolution = {
    kind: "acknowledged-unresolved-submission" as const,
    acknowledgedAt: "2026-08-11T12:00:08.000Z",
    acknowledgedAtJournalRevision: 9,
  };
  const acknowledged = reconcileCreateImagesRunState(
    unresolved,
    {
      status: "ready",
      authoritative: true,
      latestTerminalRun: {
        ...ambiguousRun,
        journalRevision: 9,
        lastSequence: 8,
        updatedAt: ambiguityResolution.acknowledgedAt,
        ambiguityResolution,
      },
      history: [
        { ...terminal, updatedAt: ambiguityResolution.acknowledgedAt, ambiguityResolution },
      ],
      recoveries: [],
    },
    "workflow-1",
  );
  assert.equal(acknowledged.projection?.ambiguityAcknowledged, true);
  assert.equal(acknowledged.history[0]?.ambiguityAcknowledged, true);
});

test("self-contained snapshots accept gaps, reject stale sequence, and retain terminal outputs", () => {
  const assetId = "b".repeat(64);
  const initial = reconcileCreateImagesRunState(
    undefined,
    { status: "ready", authoritative: true, activeRun: runView(), history: [], recoveries: [] },
    "workflow-1",
  );
  const jumped = reconcileCreateImagesRunState(
    initial,
    {
      status: "ready",
      authoritative: true,
      activeRun: runView({
        lastSequence: 7,
        nodes: [
          {
            nodeId: "generate-1",
            label: "Generate Image",
            status: "succeeded",
            attempt: 1,
            outputAssetIds: [assetId],
          },
        ],
      }),
      history: [],
      recoveries: [],
    },
    "workflow-1",
  );
  assert.equal(jumped.projection?.lastSequence, 7);
  assert.equal(jumped.runAssetOwners[assetId], "run-1");

  const stale = reconcileCreateImagesRunState(
    jumped,
    {
      status: "ready",
      authoritative: true,
      activeRun: runView({ lastSequence: 5 }),
      history: [],
      recoveries: [],
    },
    "workflow-1",
  );
  assert.equal(stale.projection?.lastSequence, 7);

  const terminal: CreateImagesRunListResult = {
    status: "ready",
    authoritative: true,
    history: [
      {
        runId: "run-1",
        workflowRevision: 7,
        status: "needs_attention",
        scope: { kind: "all" },
        createdAt: "2026-08-11T12:00:00.000Z",
        updatedAt: "2026-08-11T12:00:03.000Z",
        requestCount: 1,
        outputCount: 1,
        completedNodeCount: 1,
        totalNodeCount: 1,
      },
    ],
    recoveries: [],
  };
  const sealed = reconcileCreateImagesRunState(stale, terminal, "workflow-1");
  assert.equal(sealed.projection?.status, "retry");
  assert.equal(sealed.history[0]?.status, "retry");
  assert.equal(sealed.runAssetOwners[assetId], "run-1");
});

test("a cold terminal snapshot restores node details and run-authorized output ownership", () => {
  const assetId = "c".repeat(64);
  const latestTerminalRun = runView({
    status: "succeeded",
    lastSequence: 4,
    updatedAt: "2026-08-11T12:00:04.000Z",
    nodes: [
      {
        nodeId: "generate-1",
        label: "Generate Image",
        status: "succeeded",
        attempt: 1,
        outputAssetIds: [assetId],
      },
    ],
  });
  const restored = reconcileCreateImagesRunState(
    undefined,
    {
      status: "ready",
      authoritative: true,
      latestTerminalRun,
      history: [
        {
          runId: "run-1",
          workflowRevision: 7,
          status: "succeeded",
          scope: { kind: "all" },
          createdAt: "2026-08-11T12:00:00.000Z",
          updatedAt: "2026-08-11T12:00:04.000Z",
          requestCount: 1,
          outputCount: 1,
          completedNodeCount: 1,
          totalNodeCount: 1,
        },
      ],
      recoveries: [],
    },
    "workflow-1",
  );
  assert.equal(restored.projection?.status, "succeeded");
  assert.deepEqual(restored.projection?.nodes["generate-1"]?.outputAssetIds, [assetId]);
  assert.equal(restored.runAssetOwners[assetId], "run-1");
});

test("a stale same-run terminal snapshot cannot regress sequence or output ownership", () => {
  const currentAssetId = "3".repeat(64);
  const staleAssetId = "4".repeat(64);
  const current = reconcileCreateImagesRunState(
    undefined,
    {
      status: "ready",
      authoritative: true,
      latestTerminalRun: runView({
        runId: "run-b",
        status: "succeeded",
        lastSequence: 8,
        updatedAt: "2026-08-11T12:00:08.000Z",
        nodes: [
          {
            nodeId: "generate-1",
            label: "Generate Image",
            status: "succeeded",
            attempt: 1,
            outputAssetIds: [currentAssetId],
          },
        ],
      }),
      history: [],
      recoveries: [],
    },
    "workflow-1",
  );

  const stale = reconcileCreateImagesRunState(
    current,
    {
      status: "ready",
      authoritative: true,
      latestTerminalRun: runView({
        runId: "run-b",
        status: "succeeded",
        lastSequence: 5,
        updatedAt: "2026-08-11T12:00:05.000Z",
        nodes: [
          {
            nodeId: "generate-1",
            label: "Generate Image",
            status: "succeeded",
            attempt: 1,
            outputAssetIds: [staleAssetId],
          },
        ],
      }),
      history: [],
      recoveries: [],
    },
    "workflow-1",
  );
  assert.equal(stale.projection?.runId, "run-b");
  assert.equal(stale.projection?.lastSequence, 8);
  assert.deepEqual(stale.projection?.nodes["generate-1"]?.outputAssetIds, [currentAssetId]);
  assert.deepEqual(stale.runAssetOwners, { [currentAssetId]: "run-b" });
  assert.equal(stale.runAssetOwners[staleAssetId], undefined);
});

test("authoritative retention snapshots replace or clear a tombstoned terminal projection", () => {
  const newerAssetId = "5".repeat(64);
  const olderAssetId = "6".repeat(64);
  const currentB = reconcileCreateImagesRunState(
    undefined,
    {
      status: "ready",
      authoritative: true,
      latestTerminalRun: runView({
        runId: "run-b",
        status: "succeeded",
        lastSequence: 8,
        createdAt: "2026-08-11T13:00:00.000Z",
        updatedAt: "2026-08-11T13:01:00.000Z",
        nodes: [
          {
            nodeId: "generate-1",
            label: "Generate Image",
            status: "succeeded",
            attempt: 1,
            outputAssetIds: [newerAssetId],
          },
        ],
      }),
      history: [
        {
          runId: "run-b",
          workflowRevision: 7,
          status: "succeeded",
          scope: { kind: "all" },
          createdAt: "2026-08-11T13:00:00.000Z",
          updatedAt: "2026-08-11T13:01:00.000Z",
          requestCount: 1,
          outputCount: 1,
          completedNodeCount: 1,
          totalNodeCount: 1,
        },
      ],
      recoveries: [],
    },
    "workflow-1",
  );

  const fallbackA = reconcileCreateImagesRunState(
    currentB,
    {
      status: "ready",
      authoritative: true,
      latestTerminalRun: runView({
        runId: "run-a",
        status: "succeeded",
        lastSequence: 4,
        createdAt: "2026-08-11T12:00:00.000Z",
        updatedAt: "2026-08-11T12:01:00.000Z",
        nodes: [
          {
            nodeId: "generate-1",
            label: "Generate Image",
            status: "succeeded",
            attempt: 1,
            outputAssetIds: [olderAssetId],
          },
        ],
      }),
      history: [
        {
          runId: "run-a",
          workflowRevision: 7,
          status: "succeeded",
          scope: { kind: "all" },
          createdAt: "2026-08-11T12:00:00.000Z",
          updatedAt: "2026-08-11T12:01:00.000Z",
          requestCount: 1,
          outputCount: 1,
          completedNodeCount: 1,
          totalNodeCount: 1,
        },
      ],
      recoveries: [],
    },
    "workflow-1",
  );
  assert.equal(fallbackA.projection?.runId, "run-a");
  assert.deepEqual(fallbackA.projection?.nodes["generate-1"]?.outputAssetIds, [olderAssetId]);
  assert.deepEqual(fallbackA.runAssetOwners, { [olderAssetId]: "run-a" });
  assert.equal(fallbackA.runAssetOwners[newerAssetId], undefined);

  const cleared = reconcileCreateImagesRunState(
    currentB,
    { status: "ready", authoritative: true, history: [], recoveries: [] },
    "workflow-1",
  );
  assert.equal(cleared.projection, undefined);
  assert.deepEqual(cleared.runAssetOwners, {});
});

test("mutation acknowledgements reject inverse races without changing history or recoveries", () => {
  const terminalAssetId = "7".repeat(64);
  const activeAssetId = "8".repeat(64);
  const higherAssetId = "9".repeat(64);
  const terminalB = reconcileCreateImagesRunState(
    undefined,
    {
      status: "ready",
      authoritative: true,
      latestTerminalRun: runView({
        runId: "run-b",
        status: "succeeded",
        lastSequence: 8,
        createdAt: "2026-08-11T13:00:00.000Z",
        updatedAt: "2026-08-11T13:01:00.000Z",
        nodes: [
          {
            nodeId: "generate-1",
            label: "Generate Image",
            status: "succeeded",
            attempt: 1,
            outputAssetIds: [terminalAssetId],
          },
        ],
      }),
      history: [
        {
          runId: "run-b",
          workflowRevision: 7,
          status: "succeeded",
          scope: { kind: "all" },
          createdAt: "2026-08-11T13:00:00.000Z",
          updatedAt: "2026-08-11T13:01:00.000Z",
          requestCount: 1,
          outputCount: 1,
          completedNodeCount: 1,
          totalNodeCount: 1,
        },
        {
          runId: "run-a",
          workflowRevision: 7,
          status: "succeeded",
          scope: { kind: "all" },
          createdAt: "2026-08-11T12:00:00.000Z",
          updatedAt: "2026-08-11T12:01:00.000Z",
          requestCount: 1,
          outputCount: 0,
          completedNodeCount: 1,
          totalNodeCount: 1,
        },
      ],
      recoveries: [
        {
          status: "recovery-required",
          workflowId: "workflow-1",
          runId: "run-damaged",
          reason: "current-missing",
        },
      ],
    },
    "workflow-1",
  );

  const delayedA = reconcileCreateImagesRunMutation(
    terminalB,
    runView({
      runId: "run-a",
      lastSequence: 2,
      createdAt: "2026-08-11T12:00:00.000Z",
      updatedAt: "2026-08-11T12:01:00.000Z",
    }),
    "workflow-1",
  );
  assert.equal(delayedA, terminalB);
  assert.deepEqual(delayedA.runAssetOwners, { [terminalAssetId]: "run-b" });

  const activeC = reconcileCreateImagesRunMutation(
    terminalB,
    runView({
      runId: "run-c",
      lastSequence: 5,
      createdAt: "2026-08-10T13:02:00.000Z",
      updatedAt: "2026-08-10T13:02:00.000Z",
      nodes: [
        {
          nodeId: "generate-1",
          label: "Generate Image",
          status: "succeeded",
          attempt: 1,
          outputAssetIds: [activeAssetId],
        },
      ],
    }),
    "workflow-1",
  );
  assert.equal(activeC.projection?.runId, "run-c");
  assert.equal(activeC.history, terminalB.history);
  assert.equal(activeC.recoveries, terminalB.recoveries);
  assert.deepEqual(activeC.runAssetOwners, { [activeAssetId]: "run-c" });

  const delayedRecoveryMutation = reconcileCreateImagesRunMutation(
    terminalB,
    runView({ runId: "run-damaged", lastSequence: 2 }),
    "workflow-1",
  );
  assert.equal(delayedRecoveryMutation, terminalB);

  const newerDifferentActive = reconcileCreateImagesRunMutation(
    activeC,
    runView({
      runId: "run-d",
      lastSequence: 1,
      createdAt: "2026-08-11T13:03:00.000Z",
      updatedAt: "2026-08-11T13:03:00.000Z",
    }),
    "workflow-1",
  );
  assert.equal(newerDifferentActive, activeC);

  const lowerC = reconcileCreateImagesRunMutation(
    activeC,
    runView({ runId: "run-c", lastSequence: 4, updatedAt: "2026-08-11T13:02:01.000Z" }),
    "workflow-1",
  );
  assert.equal(lowerC, activeC);

  const higherC = reconcileCreateImagesRunMutation(
    activeC,
    runView({
      runId: "run-c",
      lastSequence: 6,
      updatedAt: "2026-08-11T13:02:02.000Z",
      nodes: [
        {
          nodeId: "generate-1",
          label: "Generate Image",
          status: "succeeded",
          attempt: 1,
          outputAssetIds: [higherAssetId],
        },
      ],
    }),
    "workflow-1",
  );
  assert.equal(higherC.projection?.lastSequence, 6);
  assert.equal(higherC.history, terminalB.history);
  assert.equal(higherC.recoveries, terminalB.recoveries);
  assert.deepEqual(higherC.runAssetOwners, { [higherAssetId]: "run-c" });

  const wrongWorkflow = reconcileCreateImagesRunMutation(
    higherC,
    runView({ workflowId: "workflow-other", runId: "run-d" }),
    "workflow-1",
  );
  assert.equal(wrongWorkflow, higherC);
});

test("a partial ambiguity mutation cannot replace a newer terminal projection", () => {
  const currentAssetId = "a".repeat(64);
  const currentC = reconcileCreateImagesRunState(
    undefined,
    {
      status: "ready",
      authoritative: true,
      latestTerminalRun: runView({
        runId: "run-c",
        status: "succeeded",
        lastSequence: 12,
        updatedAt: "2026-08-11T14:00:00.000Z",
        nodes: [
          {
            nodeId: "generate-1",
            label: "Generate Image",
            status: "succeeded",
            attempt: 1,
            outputAssetIds: [currentAssetId],
          },
        ],
      }),
      history: [
        {
          runId: "run-c",
          workflowRevision: 7,
          status: "succeeded",
          scope: { kind: "all" },
          createdAt: "2026-08-11T13:59:00.000Z",
          updatedAt: "2026-08-11T14:00:00.000Z",
          requestCount: 1,
          outputCount: 1,
          completedNodeCount: 1,
          totalNodeCount: 1,
        },
        {
          runId: "run-b",
          workflowRevision: 7,
          status: "needs_attention",
          scope: { kind: "all" },
          createdAt: "2026-08-11T12:00:00.000Z",
          updatedAt: "2026-08-11T12:01:00.000Z",
          requestCount: 1,
          outputCount: 0,
          completedNodeCount: 0,
          totalNodeCount: 1,
        },
      ],
      recoveries: [],
    },
    "workflow-1",
  );

  const delayedAmbiguityB = reconcileCreateImagesRunMutation(
    currentC,
    runView({
      runId: "run-b",
      status: "needs_attention",
      lastSequence: 9,
      ambiguityResolution: {
        kind: "acknowledged-unresolved-submission",
        acknowledgedAt: "2026-08-11T12:02:00.000Z",
        acknowledgedAtJournalRevision: 10,
      },
    }),
    "workflow-1",
  );
  assert.equal(delayedAmbiguityB, currentC);
  assert.deepEqual(delayedAmbiguityB.runAssetOwners, { [currentAssetId]: "run-c" });
});

test("causal discard, prune, and recovery state reject delayed run mutations", () => {
  const discardedAssetId = "b".repeat(64);
  const keptAssetId = "c".repeat(64);
  const beforeDiscard = reconcileCreateImagesRunState(
    undefined,
    {
      status: "ready",
      authoritative: true,
      latestTerminalRun: runView({
        runId: "run-discarded",
        status: "failed",
        lastSequence: 7,
        nodes: [
          {
            nodeId: "generate-1",
            label: "Generate Image",
            status: "failed",
            attempt: 1,
            outputAssetIds: [discardedAssetId],
          },
        ],
      }),
      history: [
        {
          runId: "run-discarded",
          workflowRevision: 7,
          status: "failed",
          scope: { kind: "all" },
          createdAt: "2026-08-11T12:00:00.000Z",
          updatedAt: "2026-08-11T12:01:00.000Z",
          requestCount: 1,
          outputCount: 1,
          completedNodeCount: 0,
          totalNodeCount: 1,
        },
        {
          runId: "run-kept",
          workflowRevision: 7,
          status: "succeeded",
          scope: { kind: "all" },
          createdAt: "2026-08-11T11:00:00.000Z",
          updatedAt: "2026-08-11T11:01:00.000Z",
          requestCount: 1,
          outputCount: 1,
          completedNodeCount: 1,
          totalNodeCount: 1,
        },
      ],
      recoveries: [
        {
          status: "recovery-required",
          workflowId: "workflow-1",
          runId: "run-recovery",
          reason: "current-missing",
        },
      ],
    },
    "workflow-1",
  );
  const withUnrelatedOwner = {
    ...beforeDiscard,
    runAssetOwners: Object.freeze({
      ...beforeDiscard.runAssetOwners,
      [keptAssetId]: "run-kept",
    }),
  };
  const discarded = removeCreateImagesRunRecord(withUnrelatedOwner, "run-discarded");
  assert.equal(discarded.projection, undefined);
  assert.deepEqual(
    discarded.history.map((item) => item.runId),
    ["run-kept"],
  );
  assert.deepEqual(
    discarded.recoveries.map((item) => item.runId),
    ["run-recovery"],
  );
  assert.deepEqual(discarded.runAssetOwners, { [keptAssetId]: "run-kept" });
  assert.equal(discarded.runTombstones?.includes("run-discarded"), true);

  const delayedDiscardedStart = reconcileCreateImagesRunMutation(
    discarded,
    runView({ runId: "run-discarded", status: "running", lastSequence: 8 }),
    "workflow-1",
  );
  assert.equal(delayedDiscardedStart, discarded);
  const delayedRecoveryStop = reconcileCreateImagesRunMutation(
    discarded,
    runView({ runId: "run-recovery", status: "cancel_requested", lastSequence: 8 }),
    "workflow-1",
  );
  assert.equal(delayedRecoveryStop, discarded);

  const beforePrune = reconcileCreateImagesRunState(
    undefined,
    {
      status: "ready",
      authoritative: true,
      latestTerminalRun: runView({ runId: "run-pruned", status: "succeeded", lastSequence: 5 }),
      history: [
        {
          runId: "run-pruned",
          workflowRevision: 7,
          status: "succeeded",
          scope: { kind: "all" },
          createdAt: "2026-08-11T10:00:00.000Z",
          updatedAt: "2026-08-11T10:01:00.000Z",
          requestCount: 1,
          outputCount: 0,
          completedNodeCount: 1,
          totalNodeCount: 1,
        },
      ],
      recoveries: [],
    },
    "workflow-1",
  );
  const pruned = reconcileCreateImagesRunState(
    beforePrune,
    { status: "ready", authoritative: true, history: [], recoveries: [] },
    "workflow-1",
  );
  assert.equal(pruned.runTombstones?.includes("run-pruned"), true);
  const delayedPrunedStop = reconcileCreateImagesRunMutation(
    pruned,
    runView({ runId: "run-pruned", status: "cancel_requested", lastSequence: 6 }),
    "workflow-1",
  );
  assert.equal(delayedPrunedStop, pruned);

  let bounded = discarded;
  for (let index = 0; index < 300; index += 1) {
    bounded = removeCreateImagesRunRecord(bounded, `run-removed-${index}`);
  }
  assert.equal(bounded.runTombstones?.length, 256);
  assert.equal(bounded.runTombstones?.includes("run-removed-0"), false);
  assert.equal(bounded.runTombstones?.includes("run-removed-299"), true);
});

test("unrelated authoritative snapshots preserve selected detail and ambiguity continuations", async () => {
  const selectedTerminal = terminalRunView({
    runId: "run-a",
    status: "needs_attention",
  });
  let state = reconcileCreateImagesRunState(
    undefined,
    {
      status: "ready",
      authoritative: true,
      latestTerminalRun: runView({
        runId: "run-a",
        status: "needs_attention",
        lastSequence: 7,
      }),
      history: [selectedTerminal],
      recoveries: [],
    },
    "workflow-1",
  );
  const authority = {
    mounted: true,
    lifecycleGeneration: 4,
    selectedRunId: "run-a" as string | undefined,
    requestSequence: 12,
  };
  const detailRequest = {
    runId: "run-a",
    lifecycleGeneration: 4,
    requestSequence: 12,
  };
  let detailCommits = 0;
  let resolveDetail!: () => void;
  const pendingDetail = new Promise<void>((resolve) => {
    resolveDetail = resolve;
  }).then(() => {
    if (isCreateImagesRunHistoryRequestCurrent(state, authority, detailRequest)) {
      detailCommits += 1;
    }
  });

  for (const lastSequence of [1, 2]) {
    const unrelatedSnapshot = {
      status: "ready" as const,
      authoritative: true as const,
      activeRun: runView({ runId: "run-b", lastSequence }),
      latestTerminalRun: runView({
        runId: "run-a",
        status: "needs_attention",
        lastSequence: 7,
      }),
      history: [selectedTerminal],
      recoveries: [],
    };
    assert.deepEqual(createImagesSelectedRunSnapshotTransition(unrelatedSnapshot, "run-a"), {
      kind: "unchanged",
    });
    state = reconcileCreateImagesRunState(state, unrelatedSnapshot, "workflow-1");
    assert.equal(isCreateImagesRunHistoryRequestCurrent(state, authority, detailRequest), true);
  }
  resolveDetail();
  await pendingDetail;
  assert.equal(detailCommits, 1);

  const ambiguityRequest = { ...detailRequest, expectedLastSequence: 7 };
  let ambiguityState = reconcileCreateImagesRunState(
    undefined,
    {
      status: "ready",
      authoritative: true,
      latestTerminalRun: runView({
        runId: "run-a",
        status: "needs_attention",
        lastSequence: 7,
      }),
      history: [selectedTerminal],
      recoveries: [],
    },
    "workflow-1",
  );
  const acknowledgement = {
    kind: "acknowledged-unresolved-submission" as const,
    acknowledgedAt: "2026-08-11T12:02:00.000Z",
    acknowledgedAtJournalRevision: 2,
  };
  const ownPublication = {
    status: "ready" as const,
    authoritative: true as const,
    latestTerminalRun: runView({
      runId: "run-a",
      status: "needs_attention",
      lastSequence: 8,
      ambiguityResolution: acknowledgement,
    }),
    history: [
      terminalRunView({
        ...selectedTerminal,
        ambiguityResolution: acknowledgement,
      }),
    ],
    recoveries: [],
  };
  assert.deepEqual(createImagesSelectedRunSnapshotTransition(ownPublication, "run-a"), {
    kind: "unchanged",
  });
  ambiguityState = reconcileCreateImagesRunState(ambiguityState, ownPublication, "workflow-1");
  assert.equal(
    isCreateImagesRunAmbiguityRequestCurrent(ambiguityState, authority, ambiguityRequest),
    true,
  );
  const completionEffects = { dialogClosed: 0, detail: 0, toast: 0, focus: 0 };
  if (isCreateImagesRunAmbiguityRequestCurrent(ambiguityState, authority, ambiguityRequest)) {
    completionEffects.dialogClosed += 1;
    completionEffects.detail += 1;
    completionEffects.toast += 1;
    completionEffects.focus += 1;
  }
  assert.deepEqual(completionEffects, { dialogClosed: 1, detail: 1, toast: 1, focus: 1 });

  const unacknowledgedHigherSequence = {
    ...ambiguityState,
    projection: createImagesRunProjectionFromView(
      runView({ runId: "run-a", status: "needs_attention", lastSequence: 8 }),
    ),
  };
  assert.equal(
    isCreateImagesRunAmbiguityRequestCurrent(
      unacknowledgedHigherSequence,
      authority,
      ambiguityRequest,
    ),
    false,
  );
  const differentProjection = {
    ...ambiguityState,
    projection: createImagesRunProjectionFromView(
      runView({
        runId: "run-b",
        status: "needs_attention",
        lastSequence: 8,
        ambiguityResolution: acknowledgement,
      }),
    ),
  };
  assert.equal(
    isCreateImagesRunAmbiguityRequestCurrent(differentProjection, authority, ambiguityRequest),
    false,
  );
});

test("selected recovery candidate changes and removal invalidate async ownership", () => {
  const recovery = {
    status: "recovery-required" as const,
    workflowId: "workflow-1",
    runId: "run-a",
    reason: "current-corrupt" as const,
    currentJournalRevision: 9,
    recoverySource: "current" as const,
    expectedCandidateJournalRevision: 9,
  };
  const snapshot = {
    status: "ready" as const,
    authoritative: true as const,
    history: [],
    recoveries: [recovery],
  };
  assert.deepEqual(createImagesSelectedRunSnapshotTransition(snapshot, "run-a", recovery), {
    kind: "unchanged",
  });
  const revisionChanged = {
    ...snapshot,
    recoveries: [{ ...recovery, expectedCandidateJournalRevision: 10 }],
  };
  assert.equal(
    createImagesSelectedRunSnapshotTransition(revisionChanged, "run-a", recovery).kind,
    "recovery-changed",
  );
  const sourceChanged = {
    ...snapshot,
    recoveries: [
      {
        ...recovery,
        reason: "last-known-good-corrupt" as const,
        recoverySource: "last-known-good" as const,
      },
    ],
  };
  assert.equal(
    createImagesSelectedRunSnapshotTransition(sourceChanged, "run-a", recovery).kind,
    "recovery-changed",
  );
  const statusChanged = {
    ...snapshot,
    recoveries: [
      {
        status: "unsafe" as const,
        workflowId: "workflow-1",
        runId: "run-a",
        reason: "current-future-schema" as const,
      },
    ],
  };
  assert.equal(
    createImagesSelectedRunSnapshotTransition(statusChanged, "run-a", recovery).kind,
    "recovery-changed",
  );

  const removedSnapshot = {
    status: "ready" as const,
    authoritative: true as const,
    history: [],
    recoveries: [],
  };
  assert.deepEqual(createImagesSelectedRunSnapshotTransition(removedSnapshot, "run-a"), {
    kind: "removed",
  });
  const becameHealthy = { ...removedSnapshot, history: [terminalRunView({ runId: "run-a" })] };
  assert.deepEqual(createImagesSelectedRunSnapshotTransition(becameHealthy, "run-a", recovery), {
    kind: "became-healthy",
  });

  let authority = {
    mounted: true,
    lifecycleGeneration: 5,
    selectedRunId: "run-a" as string | undefined,
    requestSequence: 20,
  };
  const request = {
    runId: "run-a",
    lifecycleGeneration: 5,
    requestSequence: 20,
    source: "current" as const,
    expectedCandidateJournalRevision: 9,
  };
  let state = reconcileCreateImagesRunState(undefined, snapshot, "workflow-1");
  assert.equal(isCreateImagesRunRecoveryRequestCurrent(state, authority, request), true);
  authority = { ...authority, requestSequence: 21 };
  state = reconcileCreateImagesRunState(state, revisionChanged, "workflow-1");
  assert.equal(isCreateImagesRunRecoveryRequestCurrent(state, authority, request), false);
  state = removeCreateImagesRunRecord(state, "run-a");
  assert.equal(isCreateImagesRunHistoryRequestCurrent(state, authority, request), false);
});

test("async recovery authority expires on selection, candidate, or tombstone changes", () => {
  const selectedAssetId = "d".repeat(64);
  const state = reconcileCreateImagesRunState(
    undefined,
    {
      status: "ready",
      authoritative: true,
      activeRun: runView({
        runId: "run-b",
        lastSequence: 3,
        nodes: [
          {
            nodeId: "generate-1",
            label: "Generate Image",
            status: "succeeded",
            attempt: 1,
            outputAssetIds: [selectedAssetId],
          },
        ],
      }),
      history: [],
      recoveries: [
        {
          status: "recovery-required",
          workflowId: "workflow-1",
          runId: "run-a",
          reason: "current-corrupt",
          recoverySource: "last-known-good",
          expectedCandidateJournalRevision: 7,
        },
      ],
    },
    "workflow-1",
  );
  const request = {
    runId: "run-a",
    lifecycleGeneration: 2,
    requestSequence: 4,
    source: "last-known-good" as const,
    expectedCandidateJournalRevision: 7,
  };
  const authority = {
    mounted: true,
    lifecycleGeneration: 2,
    selectedRunId: "run-a",
    requestSequence: 4,
  };
  assert.equal(isCreateImagesRunRecoveryRequestCurrent(state, authority, request), true);

  const selectedOther = isCreateImagesRunRecoveryRequestCurrent(
    state,
    { ...authority, selectedRunId: "run-b", requestSequence: 5 },
    request,
  );
  assert.equal(selectedOther, false);
  assert.equal(state.projection?.runId, "run-b");
  assert.deepEqual(state.runAssetOwners, { [selectedAssetId]: "run-b" });

  const changedCandidate = {
    ...state,
    recoveries: state.recoveries.map((recovery) =>
      recovery.runId === "run-a" && recovery.status === "recovery-required"
        ? { ...recovery, expectedCandidateJournalRevision: 8 }
        : recovery,
    ),
  };
  assert.equal(
    isCreateImagesRunRecoveryRequestCurrent(changedCandidate, authority, request),
    false,
  );

  const tombstoned = removeCreateImagesRunRecord(state, "run-a");
  assert.equal(isCreateImagesRunRecoveryRequestCurrent(tombstoned, authority, request), false);
  assert.equal(tombstoned.projection?.runId, "run-b");
  assert.deepEqual(tombstoned.runAssetOwners, { [selectedAssetId]: "run-b" });
});

test("unmount invalidates deferred history detail and recovery continuations", async () => {
  const state = reconcileCreateImagesRunState(
    undefined,
    {
      status: "ready",
      authoritative: true,
      history: [],
      recoveries: [
        {
          status: "recovery-required",
          workflowId: "workflow-1",
          runId: "run-a",
          reason: "current-corrupt",
          recoverySource: "current",
          expectedCandidateJournalRevision: 9,
        },
      ],
    },
    "workflow-1",
  );
  const effects = { commit: 0, cache: 0, detail: 0, preview: 0, toast: 0, focus: 0 };
  let authority = {
    mounted: true,
    lifecycleGeneration: 3,
    selectedRunId: "run-a" as string | undefined,
    requestSequence: 6,
  };
  const recoveryRequest = {
    runId: "run-a",
    lifecycleGeneration: 3,
    requestSequence: 6,
    source: "current" as const,
    expectedCandidateJournalRevision: 9,
  };
  let resolveRecovery!: () => void;
  const recoveryResponse = new Promise<void>((resolve) => {
    resolveRecovery = resolve;
  }).then(() => {
    if (!isCreateImagesRunRecoveryRequestCurrent(state, authority, recoveryRequest)) return;
    effects.commit += 1;
    effects.cache += 1;
    effects.detail += 1;
    effects.preview += 1;
    effects.toast += 1;
    effects.focus += 1;
  });
  authority = {
    mounted: false,
    lifecycleGeneration: 4,
    selectedRunId: undefined,
    requestSequence: 7,
  };
  resolveRecovery();
  await recoveryResponse;
  assert.deepEqual(effects, { commit: 0, cache: 0, detail: 0, preview: 0, toast: 0, focus: 0 });

  authority = {
    mounted: true,
    lifecycleGeneration: 5,
    selectedRunId: "run-b",
    requestSequence: 8,
  };
  const detailRequest = {
    runId: "run-b",
    lifecycleGeneration: 5,
    requestSequence: 8,
  };
  let resolveDetail!: () => void;
  const detailResponse = new Promise<void>((resolve) => {
    resolveDetail = resolve;
  }).then(() => {
    if (!isCreateImagesRunHistoryRequestCurrent(state, authority, detailRequest)) return;
    effects.cache += 1;
    effects.detail += 1;
    effects.preview += 1;
  });
  authority = {
    mounted: false,
    lifecycleGeneration: 6,
    selectedRunId: undefined,
    requestSequence: 9,
  };
  resolveDetail();
  await detailResponse;
  assert.deepEqual(effects, { commit: 0, cache: 0, detail: 0, preview: 0, toast: 0, focus: 0 });
});

test("ambiguity response authority expires on another projection, recovery, prune, or lifecycle", () => {
  const ambiguous = reconcileCreateImagesRunState(
    undefined,
    {
      status: "ready",
      authoritative: true,
      latestTerminalRun: runView({
        runId: "run-a",
        status: "needs_attention",
        lastSequence: 7,
      }),
      history: [
        {
          runId: "run-a",
          workflowRevision: 7,
          status: "needs_attention",
          scope: { kind: "all" },
          createdAt: "2026-08-11T12:00:00.000Z",
          updatedAt: "2026-08-11T12:01:00.000Z",
          requestCount: 1,
          outputCount: 0,
          completedNodeCount: 0,
          totalNodeCount: 1,
        },
      ],
      recoveries: [],
    },
    "workflow-1",
  );
  const request = {
    runId: "run-a",
    lifecycleGeneration: 7,
    requestSequence: 10,
    expectedLastSequence: 7,
  };
  const authority = {
    mounted: true,
    lifecycleGeneration: 7,
    selectedRunId: "run-a",
    requestSequence: 10,
  };
  assert.equal(isCreateImagesRunAmbiguityRequestCurrent(ambiguous, authority, request), true);
  const terminalB = reconcileCreateImagesRunState(
    undefined,
    {
      status: "ready",
      authoritative: true,
      latestTerminalRun: runView({ runId: "run-b", status: "succeeded", lastSequence: 4 }),
      history: [
        {
          runId: "run-b",
          workflowRevision: 7,
          status: "succeeded",
          scope: { kind: "all" },
          createdAt: "2026-08-11T12:02:00.000Z",
          updatedAt: "2026-08-11T12:03:00.000Z",
          requestCount: 1,
          outputCount: 1,
          completedNodeCount: 1,
          totalNodeCount: 1,
        },
      ],
      recoveries: [],
    },
    "workflow-1",
  );
  const newerProjection = { ...ambiguous, projection: terminalB.projection };
  assert.equal(
    isCreateImagesRunAmbiguityRequestCurrent(newerProjection, authority, request),
    false,
  );
  assert.equal(
    isCreateImagesRunAmbiguityRequestCurrent(
      ambiguous,
      { ...authority, selectedRunId: "run-b", requestSequence: 11 },
      request,
    ),
    false,
  );
  assert.equal(
    isCreateImagesRunAmbiguityRequestCurrent(
      ambiguous,
      { ...authority, mounted: false, lifecycleGeneration: 8, requestSequence: 11 },
      request,
    ),
    false,
  );

  const recovering = {
    ...ambiguous,
    projection: undefined,
    recoveries: [
      {
        status: "recovery-required" as const,
        workflowId: "workflow-1",
        runId: "run-a",
        reason: "current-corrupt" as const,
        recoverySource: "current" as const,
        expectedCandidateJournalRevision: 8,
      },
    ],
  };
  assert.equal(isCreateImagesRunAmbiguityRequestCurrent(recovering, authority, request), false);
  const pruned = removeCreateImagesRunRecord(ambiguous, "run-a");
  assert.equal(isCreateImagesRunAmbiguityRequestCurrent(pruned, authority, request), false);
});

test("a delayed pre-start terminal snapshot cannot replace a newer active run", () => {
  const active = reconcileCreateImagesRunState(
    undefined,
    {
      status: "ready",
      authoritative: true,
      activeRun: runView({ runId: "run-new", lastSequence: 3 }),
      history: [],
      recoveries: [],
    },
    "workflow-1",
  );
  const delayed = reconcileCreateImagesRunState(
    active,
    {
      status: "ready",
      authoritative: true,
      latestTerminalRun: runView({
        runId: "run-old",
        status: "succeeded",
        lastSequence: 9,
      }),
      history: [],
      recoveries: [],
    },
    "workflow-1",
  );
  assert.equal(delayed.projection?.runId, "run-new");
  assert.equal(delayed.projection?.status, "running");
});

test("a coalesced terminal-to-active handoff follows the new run through completion", () => {
  const oldAssetId = "e".repeat(64);
  const newAssetId = "f".repeat(64);
  const activeA = reconcileCreateImagesRunState(
    undefined,
    {
      status: "ready",
      authoritative: true,
      activeRun: runView({
        runId: "run-a",
        lastSequence: 3,
        updatedAt: "2026-08-11T12:00:02.000Z",
        nodes: [
          {
            nodeId: "generate-1",
            label: "Generate Image",
            status: "succeeded",
            attempt: 1,
            outputAssetIds: [oldAssetId],
          },
        ],
      }),
      history: [],
      recoveries: [],
    },
    "workflow-1",
  );

  const staleDifferentRun = reconcileCreateImagesRunState(
    activeA,
    {
      status: "ready",
      authoritative: true,
      activeRun: runView({
        runId: "run-b",
        updatedAt: "2026-08-11T12:00:01.000Z",
      }),
      history: [],
      recoveries: [],
    },
    "workflow-1",
  );
  assert.equal(staleDifferentRun.projection?.runId, "run-a");
  assert.equal(staleDifferentRun.runAssetOwners[oldAssetId], "run-a");

  const activeB = reconcileCreateImagesRunState(
    staleDifferentRun,
    {
      status: "ready",
      authoritative: true,
      activeRun: runView({
        runId: "run-b",
        lastSequence: 1,
        createdAt: "2026-08-11T12:00:04.000Z",
        updatedAt: "2026-08-11T12:00:04.000Z",
      }),
      history: [
        {
          runId: "run-a",
          workflowRevision: 7,
          status: "succeeded",
          scope: { kind: "all" },
          createdAt: "2026-08-11T12:00:00.000Z",
          updatedAt: "2026-08-11T12:00:03.000Z",
          requestCount: 1,
          outputCount: 1,
          completedNodeCount: 1,
          totalNodeCount: 1,
        },
      ],
      recoveries: [],
    },
    "workflow-1",
  );
  assert.equal(activeB.projection?.runId, "run-b");
  assert.equal(activeB.projection?.status, "running");
  assert.equal(activeB.runAssetOwners[oldAssetId], undefined);

  const terminalB = reconcileCreateImagesRunState(
    activeB,
    {
      status: "ready",
      authoritative: true,
      latestTerminalRun: runView({
        runId: "run-b",
        status: "succeeded",
        lastSequence: 4,
        createdAt: "2026-08-11T12:00:04.000Z",
        updatedAt: "2026-08-11T12:00:05.000Z",
        nodes: [
          {
            nodeId: "generate-1",
            label: "Generate Image",
            status: "succeeded",
            attempt: 1,
            outputAssetIds: [newAssetId],
          },
        ],
      }),
      history: [
        {
          runId: "run-b",
          workflowRevision: 7,
          status: "succeeded",
          scope: { kind: "all" },
          createdAt: "2026-08-11T12:00:04.000Z",
          updatedAt: "2026-08-11T12:00:05.000Z",
          requestCount: 1,
          outputCount: 1,
          completedNodeCount: 1,
          totalNodeCount: 1,
        },
        {
          runId: "run-a",
          workflowRevision: 7,
          status: "succeeded",
          scope: { kind: "all" },
          createdAt: "2026-08-11T12:00:00.000Z",
          updatedAt: "2026-08-11T12:00:03.000Z",
          requestCount: 1,
          outputCount: 1,
          completedNodeCount: 1,
          totalNodeCount: 1,
        },
      ],
      recoveries: [],
    },
    "workflow-1",
  );
  assert.equal(terminalB.projection?.runId, "run-b");
  assert.equal(terminalB.projection?.status, "succeeded");
  assert.deepEqual(terminalB.projection?.nodes["generate-1"]?.outputAssetIds, [newAssetId]);
  assert.deepEqual(terminalB.runAssetOwners, { [newAssetId]: "run-b" });
});

test("a coalesced active-to-new-terminal handoff replaces the sealed prior run", () => {
  const oldAssetId = "1".repeat(64);
  const newAssetId = "2".repeat(64);
  const activeA = reconcileCreateImagesRunState(
    undefined,
    {
      status: "ready",
      authoritative: true,
      activeRun: runView({
        runId: "run-a",
        lastSequence: 3,
        updatedAt: "2026-08-11T12:00:02.000Z",
        nodes: [
          {
            nodeId: "generate-1",
            label: "Generate Image",
            status: "succeeded",
            attempt: 1,
            outputAssetIds: [oldAssetId],
          },
        ],
      }),
      history: [],
      recoveries: [],
    },
    "workflow-1",
  );

  const terminalB = reconcileCreateImagesRunState(
    activeA,
    {
      status: "ready",
      authoritative: true,
      latestTerminalRun: runView({
        runId: "run-b",
        status: "succeeded",
        lastSequence: 4,
        createdAt: "2026-08-11T12:00:04.000Z",
        updatedAt: "2026-08-11T12:00:05.000Z",
        nodes: [
          {
            nodeId: "generate-1",
            label: "Generate Image",
            status: "succeeded",
            attempt: 1,
            outputAssetIds: [newAssetId],
          },
        ],
      }),
      history: [
        {
          runId: "run-b",
          workflowRevision: 7,
          status: "succeeded",
          scope: { kind: "all" },
          createdAt: "2026-08-11T12:00:04.000Z",
          updatedAt: "2026-08-11T12:00:05.000Z",
          requestCount: 1,
          outputCount: 1,
          completedNodeCount: 1,
          totalNodeCount: 1,
        },
        {
          runId: "run-a",
          workflowRevision: 7,
          status: "succeeded",
          scope: { kind: "all" },
          createdAt: "2026-08-11T12:00:00.000Z",
          updatedAt: "2026-08-11T12:00:03.000Z",
          requestCount: 1,
          outputCount: 1,
          completedNodeCount: 1,
          totalNodeCount: 1,
        },
      ],
      recoveries: [],
    },
    "workflow-1",
  );
  assert.equal(terminalB.projection?.runId, "run-b");
  assert.equal(terminalB.projection?.status, "succeeded");
  assert.deepEqual(terminalB.projection?.nodes["generate-1"]?.outputAssetIds, [newAssetId]);
  assert.deepEqual(terminalB.runAssetOwners, { [newAssetId]: "run-b" });
  assert.equal(terminalB.runAssetOwners[oldAssetId], undefined);
});

test("authoritative snapshots remove stale history and a recovery tombstones its healthy view", () => {
  const assetId = "d".repeat(64);
  const newer = reconcileCreateImagesRunState(
    undefined,
    {
      status: "ready",
      authoritative: true,
      latestTerminalRun: runView({
        runId: "run-new",
        status: "succeeded",
        lastSequence: 8,
        createdAt: "2026-08-11T13:00:00.000Z",
        updatedAt: "2026-08-11T13:01:00.000Z",
        nodes: [
          {
            nodeId: "generate-1",
            label: "Generate Image",
            status: "succeeded",
            attempt: 1,
            outputAssetIds: [assetId],
          },
        ],
      }),
      history: [
        {
          runId: "run-new",
          workflowRevision: 7,
          status: "succeeded",
          scope: { kind: "all" },
          createdAt: "2026-08-11T13:00:00.000Z",
          updatedAt: "2026-08-11T13:01:00.000Z",
          requestCount: 1,
          outputCount: 1,
          completedNodeCount: 1,
          totalNodeCount: 1,
        },
      ],
      recoveries: [
        {
          status: "recovery-required",
          workflowId: "workflow-1",
          runId: "run-damaged",
          reason: "current-corrupt",
          lastKnownGoodJournalRevision: 4,
          recoverySource: "last-known-good",
          expectedCandidateJournalRevision: 4,
        },
      ],
    },
    "workflow-1",
  );
  assert.equal(newer.runAssetOwners[assetId], "run-new");

  const authoritative = reconcileCreateImagesRunState(
    newer,
    {
      status: "ready",
      authoritative: true,
      latestTerminalRun: runView({ runId: "run-new", status: "succeeded" }),
      history: [
        {
          runId: "run-new",
          workflowRevision: 7,
          status: "succeeded",
          scope: { kind: "all" },
          createdAt: "2026-08-11T13:00:00.000Z",
          updatedAt: "2026-08-11T13:01:00.000Z",
          requestCount: 1,
          outputCount: 1,
          completedNodeCount: 1,
          totalNodeCount: 1,
        },
      ],
      recoveries: [
        {
          status: "recovery-required",
          workflowId: "workflow-1",
          runId: "run-new",
          reason: "last-known-good-missing",
          currentJournalRevision: 8,
          recoverySource: "current",
          expectedCandidateJournalRevision: 8,
        },
      ],
    },
    "workflow-1",
  );
  assert.equal(authoritative.projection, undefined);
  assert.deepEqual(authoritative.history, []);
  assert.deepEqual(authoritative.runAssetOwners, {});
  assert.deepEqual(
    authoritative.recoveries.map((item) => item.runId),
    ["run-new"],
  );
});

test("authoritative snapshots clear removed projections and recoveries", () => {
  const previous = reconcileCreateImagesRunState(
    undefined,
    {
      status: "ready",
      authoritative: true,
      activeRun: runView(),
      history: [],
      recoveries: [
        {
          status: "recovery-required",
          workflowId: "workflow-1",
          runId: "run-damaged",
          reason: "current-missing",
        },
      ],
    },
    "workflow-1",
  );
  const cleared = reconcileCreateImagesRunState(
    previous,
    { status: "ready", authoritative: true, history: [], recoveries: [] },
    "workflow-1",
  );
  assert.equal(cleared.projection, undefined);
  assert.equal(cleared.projectionUpdatedAt, undefined);
  assert.deepEqual(cleared.runAssetOwners, {});
  assert.deepEqual(cleared.recoveries, []);
});

test("run subscriptions retry with backoff and keep stream sequence monotonic", async () => {
  const subscriptions: CreateImagesRunSubscriptionResult[] = [
    { status: "unavailable", message: "busy", retryAfterMs: 750 },
    {
      status: "ready",
      subscriptionId: "subscription-1",
      streamSequence: 4,
      snapshot: { status: "ready", authoritative: true, history: [], recoveries: [] },
    },
  ];
  const applied: CreateImagesRunListResult[] = [];
  const scheduled: Array<{ callback: () => void; delayMs: number }> = [];
  let listener: ((notification: CreateImagesRunChangedNotification) => void) | undefined;
  const controller = createImagesRunSubscriptionController({
    workflowId: "workflow-1",
    subscribe: async () => subscriptions.shift() ?? { status: "not-found" },
    unsubscribe: () => true,
    onChanged: (handler) => {
      listener = handler;
      return () => {
        listener = undefined;
      };
    },
    apply: (result) => applied.push(result),
    retryDelaysMs: [500],
    schedule: (callback, delayMs) => {
      scheduled.push({ callback, delayMs });
      return 1;
    },
    cancelSchedule: () => undefined,
  });
  controller.start();
  await Promise.resolve();
  assert.equal(scheduled[0]?.delayMs, 750);
  scheduled.shift()?.callback();
  await Promise.resolve();
  listener?.({
    subscriptionId: "subscription-1",
    streamSequence: 3,
    snapshot: { status: "not-found" },
  });
  listener?.({
    subscriptionId: "subscription-1",
    streamSequence: 5,
    snapshot: { status: "not-found" },
  });
  assert.deepEqual(
    applied.map((result) => result.status),
    ["unavailable", "ready", "not-found"],
  );
  controller.dispose();
});

test("run subscription retries are bounded until an explicit retry signal", async () => {
  let calls = 0;
  const scheduled: Array<() => void> = [];
  const controller = createImagesRunSubscriptionController({
    workflowId: "workflow-1",
    subscribe: async () => {
      calls += 1;
      return { status: "unavailable", message: "busy" };
    },
    unsubscribe: () => true,
    onChanged: () => () => undefined,
    apply: () => undefined,
    retryDelaysMs: [1, 2],
    schedule: (callback) => {
      scheduled.push(callback);
      return scheduled.length;
    },
    cancelSchedule: () => undefined,
  });
  controller.start();
  await Promise.resolve();
  scheduled.shift()?.();
  await Promise.resolve();
  scheduled.shift()?.();
  await Promise.resolve();
  assert.equal(calls, 3);
  assert.equal(scheduled.length, 0);
  controller.retryNow();
  await Promise.resolve();
  assert.equal(calls, 4);
  controller.dispose();
});

test("an unavailable subscribed snapshot releases the stale stream and resubscribes", async () => {
  let listener: ((notification: CreateImagesRunChangedNotification) => void) | undefined;
  const scheduled: Array<{ callback: () => void; delayMs: number }> = [];
  const released: string[] = [];
  const applied: CreateImagesRunListResult[] = [];
  let subscribeCount = 0;
  const controller = createImagesRunSubscriptionController({
    workflowId: "workflow-1",
    subscribe: async () => {
      subscribeCount += 1;
      return {
        status: "ready",
        subscriptionId: `subscription-${subscribeCount}`,
        streamSequence: subscribeCount === 1 ? 4 : 10,
        snapshot: { status: "ready", authoritative: true, history: [], recoveries: [] },
      };
    },
    unsubscribe: ({ subscriptionId }) => {
      released.push(subscriptionId);
      return true;
    },
    onChanged: (handler) => {
      listener = handler;
      return () => {
        listener = undefined;
      };
    },
    apply: (result) => applied.push(result),
    retryDelaysMs: [500],
    schedule: (callback, delayMs) => {
      scheduled.push({ callback, delayMs });
      return scheduled.length;
    },
    cancelSchedule: () => undefined,
  });
  controller.start();
  await Promise.resolve();
  listener?.({
    subscriptionId: "subscription-1",
    streamSequence: 5,
    snapshot: { status: "unavailable", message: "snapshot read failed", retryAfterMs: 900 },
  });
  assert.deepEqual(released, ["subscription-1"]);
  assert.equal(scheduled[0]?.delayMs, 900);
  scheduled.shift()?.callback();
  await Promise.resolve();
  listener?.({
    subscriptionId: "subscription-1",
    streamSequence: 99,
    snapshot: { status: "not-found" },
  });
  listener?.({
    subscriptionId: "subscription-2",
    streamSequence: 11,
    snapshot: { status: "ready", authoritative: true, history: [], recoveries: [] },
  });
  assert.deepEqual(
    applied.map((result) => result.status),
    ["ready", "unavailable", "ready", "ready"],
  );
  controller.dispose();
  assert.deepEqual(released, ["subscription-1", "subscription-2"]);
});

test("overlapping subscription controllers retain independent ownership through disposal and retry", async () => {
  const listeners = new Set<(notification: CreateImagesRunChangedNotification) => void>();
  const subscriptionIds = ["subscription-old", "subscription-new", "subscription-new-retry"];
  const released: string[] = [];
  const oldApplied: CreateImagesRunListResult[] = [];
  const newApplied: CreateImagesRunListResult[] = [];
  const scheduled: Array<() => void> = [];
  const common = {
    workflowId: "workflow-1",
    subscribe: async (): Promise<CreateImagesRunSubscriptionResult> => ({
      status: "ready",
      subscriptionId: subscriptionIds.shift() ?? "unexpected-subscription",
      streamSequence: 0,
      snapshot: { status: "ready", authoritative: true, history: [], recoveries: [] },
    }),
    unsubscribe: ({ subscriptionId }: { subscriptionId: string }) => {
      released.push(subscriptionId);
      return true;
    },
    onChanged: (handler: (notification: CreateImagesRunChangedNotification) => void) => {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
    retryDelaysMs: [1],
    schedule: (callback: () => void) => {
      scheduled.push(callback);
      return scheduled.length;
    },
    cancelSchedule: () => undefined,
  };
  const oldController = createImagesRunSubscriptionController({
    ...common,
    apply: (result) => oldApplied.push(result),
  });
  const newController = createImagesRunSubscriptionController({
    ...common,
    apply: (result) => newApplied.push(result),
  });

  oldController.start();
  await Promise.resolve();
  newController.start();
  await Promise.resolve();
  oldController.dispose();
  assert.deepEqual(released, ["subscription-old"]);

  for (const listener of listeners) {
    listener({
      subscriptionId: "subscription-new",
      streamSequence: 1,
      snapshot: { status: "unavailable", message: "retry this stream" },
    });
  }
  assert.deepEqual(released, ["subscription-old", "subscription-new"]);
  assert.equal(scheduled.length, 1);
  scheduled.shift()?.();
  await Promise.resolve();
  for (const listener of listeners) {
    listener({
      subscriptionId: "subscription-new-retry",
      streamSequence: 1,
      snapshot: { status: "not-found" },
    });
  }

  assert.deepEqual(
    oldApplied.map((result) => result.status),
    ["ready"],
  );
  assert.deepEqual(
    newApplied.map((result) => result.status),
    ["ready", "unavailable", "ready", "not-found"],
  );
  newController.dispose();
  assert.deepEqual(released, ["subscription-old", "subscription-new", "subscription-new-retry"]);
  assert.equal(listeners.size, 0);
});

test("a notification that races the subscribe response applies only above its baseline", async () => {
  let listener: ((notification: CreateImagesRunChangedNotification) => void) | undefined;
  let resolveSubscription: ((result: CreateImagesRunSubscriptionResult) => void) | undefined;
  const applied: CreateImagesRunListResult[] = [];
  const controller = createImagesRunSubscriptionController({
    workflowId: "workflow-1",
    subscribe: () =>
      new Promise((resolve) => {
        resolveSubscription = resolve;
      }),
    unsubscribe: () => true,
    onChanged: (handler) => {
      listener = handler;
      return () => undefined;
    },
    apply: (result) => applied.push(result),
  });
  controller.start();
  listener?.({
    subscriptionId: "subscription-race",
    streamSequence: 6,
    snapshot: { status: "not-found" },
  });
  resolveSubscription?.({
    status: "ready",
    subscriptionId: "subscription-race",
    streamSequence: 5,
    snapshot: { status: "ready", authoritative: true, history: [], recoveries: [] },
  });
  await Promise.resolve();
  assert.deepEqual(
    applied.map((result) => result.status),
    ["ready", "not-found"],
  );
  controller.dispose();
});

test("run-from-here confirmation names the path and exact bounded retry accounting", () => {
  const model = createImagesRunConfirmationViewModel(
    confirmation({
      scope: {
        kind: "from-node",
        startNodeId: "generate-1",
        startNodeLabel: "Generate Image",
        includedNodeCount: 3,
        downstreamPathLabels: ["Generate Image", "Output Gallery"],
      },
      remoteRequestCount: 2,
    }),
  );
  assert.equal(model.title, "Run from here?");
  assert.match(model.rows[0]?.value ?? "", /Generate Image · 3 nodes/u);
  assert.match(model.rows[0]?.detail ?? "", /Generate Image → Output Gallery/u);
  const budget = createImagesLocalMockAttemptBudget(2);
  assert.equal(
    model.rows.find((row) => row.id === "requests")?.value,
    `${budget.initialGenerationRequests} initial requests · up to ${budget.maximumTotalAttempts} total attempts`,
  );
  assert.match(
    model.rows.find((row) => row.id === "requests")?.detail ?? "",
    new RegExp(
      `up to ${budget.maximumAutomaticRetryAttempts} safe automatic retry attempts \\(${CREATE_IMAGES_LOCAL_MOCK_RETRY_POLICY.maxRetriesPerNode} per generation node\\)`,
      "u",
    ),
  );
  assert.match(model.rows.find((row) => row.id === "requests")?.detail ?? "", /costs \$0/u);
});

test("local mock attempt budget fails closed before integer overflow", () => {
  assert.throws(
    () => createImagesLocalMockAttemptBudget(Number.MAX_SAFE_INTEGER),
    /safe integer range/u,
  );
});

test("long selected paths stay readable without hiding their endpoint", () => {
  const model = createImagesRunConfirmationViewModel(
    confirmation({
      scope: {
        kind: "from-node",
        startNodeId: "prompt-1",
        startNodeLabel: "Prompt · prompt-1",
        includedNodeCount: 8,
        downstreamPathLabels: [
          "Generate · generation-1",
          "Output · output-1",
          "Generate · generation-2",
          "Output · output-2",
          "Generate · generation-3",
          "Gallery · gallery-1",
        ],
      },
    }),
  );
  assert.equal(
    model.rows[0]?.detail,
    "Selected path: Generate · generation-1 → Output · output-1 → … 3 more → Gallery · gallery-1",
  );
});

test("cloud confirmation makes transfer, rights, cost, and advisory cancellation explicit", () => {
  const model = createImagesRunConfirmationViewModel(
    confirmation({
      executionMode: "cloud",
      providerLabel: "Example Images",
      modelLabel: "Example v1",
      referenceImageCount: 2,
      firstCloudUse: true,
      estimate: {
        kind: "best-effort",
        amount: 0.08,
        currency: "USD",
        estimatedAt: "2026-08-11T12:00:00.000Z",
        sourceLabel: "Provider price snapshot",
      },
    }),
  );
  assert.equal(model.isMock, false);
  assert.equal(model.confirmLabel, "Confirm & run");
  assert.match(
    model.rows.find((row) => row.id === "privacy")?.value ?? "",
    /sent to Example Images/u,
  );
  assert.match(model.privacyNotices.join(" "), /leave this Mac/u);
  assert.match(model.privacyNotices.join(" "), /rights and consent/u);
  assert.match(model.privacyNotices.join(" "), /may not prevent provider completion or billing/u);
  assert.match(model.privacyNotices.join(" "), /first cloud image run/u);
});

test("confirmation rejects unsafe counts and estimate precision", () => {
  assert.throws(
    () => createImagesRunConfirmationViewModel(confirmation({ remoteRequestCount: -1 })),
    /Remote request count/u,
  );
  assert.throws(
    () =>
      formatCreateImagesEstimate({
        kind: "best-effort",
        amount: Number.NaN,
        currency: "USD",
        estimatedAt: "2026-08-11T12:00:00.000Z",
        sourceLabel: "Snapshot",
      }),
    /priced estimate/u,
  );
  assert.equal(
    formatCreateImagesEstimate({
      kind: "unavailable",
      estimatedAt: "2026-08-11T12:00:00.000Z",
      sourceLabel: "Provider did not publish a price",
    }),
    "Estimate unavailable",
  );
});

test("projection accepts only contiguous events for the exact run identity", () => {
  const initial = createImagesRunUiProjection(snapshot());
  assert.equal(initial.nodes["prompt-1"]?.attempt, 0);
  const running = reduceCreateImagesRunUiEvent(
    initial,
    event({ kind: "node-status", sequence: 1, nodeId: "prompt-1", status: "running", attempt: 1 }),
  );
  assert.equal(running.lastSequence, 1);
  assert.equal(running.nodes["prompt-1"]?.status, "running");
  assert.match(running.announcement, /Prompt: running/u);

  const progressed = reduceCreateImagesRunUiEvent(
    running,
    event({
      kind: "node-progress",
      sequence: 2,
      nodeId: "prompt-1",
      completed: 1,
      total: 4,
      label: "Preparing prompt",
    }),
  );
  assert.equal(progressed.nodes["prompt-1"]?.progress?.completed, 1);
  assert.match(progressed.announcement, /25 percent/u);
});

test("projection suppresses another revision, run, duplicate, and sequence gap", () => {
  const initial = createImagesRunUiProjection(snapshot());
  const wrongRevision = reduceCreateImagesRunUiEvent(initial, {
    ...event({ kind: "run-status", sequence: 1, status: "succeeded" }),
    workflowRevision: 8,
  });
  const wrongRun = reduceCreateImagesRunUiEvent(wrongRevision, {
    ...event({ kind: "run-status", sequence: 1, status: "succeeded" }),
    runId: "run-2",
  });
  const gap = reduceCreateImagesRunUiEvent(
    wrongRun,
    event({ kind: "run-status", sequence: 2, status: "succeeded" }),
  );
  const accepted = reduceCreateImagesRunUiEvent(
    gap,
    event({ kind: "node-status", sequence: 1, nodeId: "prompt-1", status: "running", attempt: 1 }),
  );
  const duplicate = reduceCreateImagesRunUiEvent(
    accepted,
    event({ kind: "node-status", sequence: 1, nodeId: "prompt-1", status: "running", attempt: 1 }),
  );
  assert.equal(duplicate.lastSequence, 1);
  assert.equal(duplicate.ignoredEventCount, 4);
});

test("automatic local mock retry advances only at the next attempt", () => {
  const initial = createImagesRunUiProjection(
    snapshot({
      nodes: [{ nodeId: "generate-1", label: "Generate Image", status: "running", attempt: 1 }],
    }),
  );
  const waiting = reduceCreateImagesRunUiEvent(
    initial,
    event({
      kind: "node-status",
      sequence: 1,
      nodeId: "generate-1",
      status: "retry",
      attempt: 1,
      retryMode: "automatic-mock",
      error: { code: "rate_limited", retryKind: "local" },
    }),
  );
  const wrongAttempt = reduceCreateImagesRunUiEvent(
    waiting,
    event({
      kind: "node-status",
      sequence: 2,
      nodeId: "generate-1",
      status: "running",
      attempt: 3,
    }),
  );
  assert.equal(wrongAttempt.lastSequence, 1);
  const resumed = reduceCreateImagesRunUiEvent(
    wrongAttempt,
    event({
      kind: "node-status",
      sequence: 2,
      nodeId: "generate-1",
      status: "running",
      attempt: 2,
    }),
  );
  assert.equal(resumed.lastSequence, 2);
  assert.equal(resumed.nodes["generate-1"]?.attempt, 2);
  assert.equal(resumed.nodes["generate-1"]?.status, "running");
  assert.equal(resumed.nodes["generate-1"]?.error, undefined);
});

test("manual or paid retry remains terminal for the current run attempt", () => {
  const initial = createImagesRunUiProjection(
    snapshot({
      nodes: [{ nodeId: "generate-1", label: "Generate Image", status: "running", attempt: 1 }],
    }),
  );
  const review = reduceCreateImagesRunUiEvent(
    initial,
    event({
      kind: "node-status",
      sequence: 1,
      nodeId: "generate-1",
      status: "retry",
      attempt: 1,
      retryMode: "manual-review",
      error: { code: "rate_limited", retryKind: "remote" },
    }),
  );
  const forbiddenResume = reduceCreateImagesRunUiEvent(
    review,
    event({
      kind: "node-status",
      sequence: 2,
      nodeId: "generate-1",
      status: "running",
      attempt: 2,
    }),
  );
  assert.equal(forbiddenResume.lastSequence, 1);
  assert.equal(forbiddenResume.nodes["generate-1"]?.status, "retry");
  assert.equal(forbiddenResume.ignoredEventCount, 1);
});

test("terminal run state suppresses late completion even with the next sequence", () => {
  const initial = createImagesRunUiProjection(snapshot({ status: "stopping" }));
  const cancelled = reduceCreateImagesRunUiEvent(
    initial,
    event({ kind: "run-status", sequence: 1, status: "cancelled" }),
  );
  const late = reduceCreateImagesRunUiEvent(
    cancelled,
    event({
      kind: "node-status",
      sequence: 2,
      nodeId: "prompt-1",
      status: "succeeded",
      attempt: 0,
    }),
  );
  assert.equal(late.status, "cancelled");
  assert.equal(late.lastSequence, 1);
  assert.equal(late.nodes["prompt-1"]?.status, "queued");
});

test("safe error presentation never enables ambiguous or automatic retry", () => {
  const ambiguous = createImagesRunErrorViewModel({
    code: "submission_ambiguous",
    retryKind: "remote",
  });
  assert.equal(ambiguous.retry.available, false);
  assert.equal(ambiguous.retry.automatic, false);
  assert.doesNotMatch(ambiguous.nextStep, /retry now/iu);
  assert.match(ambiguous.nextStep, /Do not retry/u);
  assert.match(ambiguous.nextStep, /explicitly acknowledge/u);

  const limited = createImagesRunErrorViewModel({
    code: "rate_limited",
    retryKind: "remote",
    retainedOutputCount: 2,
  });
  assert.equal(limited.retry.available, true);
  assert.equal(limited.retry.requiresConfirmation, true);
  assert.equal(limited.retry.label, "Review & retry");
  assert.match(limited.retainedOutputLabel ?? "", /2 completed outputs retained locally/u);
  assert.match(limited.nextStep, /will not submit a paid retry automatically/u);

  const interrupted = createImagesRunErrorViewModel({
    code: "interrupted",
    retryKind: "local",
  });
  assert.match(interrupted.description, /could not safely continue/u);
  assert.doesNotMatch(interrupted.description, /restart/iu);

  const rejected = createImagesRunErrorViewModel({
    code: "request_rejected",
    retryKind: "none",
  });
  assert.match(rejected.title, /rejected the request/u);
  assert.deepEqual(rejected.actions, ["view-history", "open-provider-settings"]);

  const invalidOutput = createImagesRunErrorViewModel({
    code: "output_invalid",
    retryKind: "remote",
  });
  assert.match(invalidOutput.title, /unusable image/u);
  assert.doesNotMatch(invalidOutput.title, /saved/u);

  const saveFailure = createImagesRunErrorViewModel({
    code: "output_save_failed",
    retryKind: "remote",
  });
  assert.match(saveFailure.title, /could not be saved/u);
  assert.match(saveFailure.description, /local storage/u);
});

test("progress summary counts every visible terminal outcome without using color", () => {
  const nodes: CreateImagesNodeRunUiState[] = [
    { nodeId: "1", label: "One", status: "succeeded", sequence: 1, attempt: 1 },
    { nodeId: "2", label: "Two", status: "running", sequence: 1, attempt: 1 },
    { nodeId: "3", label: "Three", status: "queued", sequence: 1, attempt: 1 },
    { nodeId: "4", label: "Four", status: "blocked", sequence: 1, attempt: 1 },
    {
      nodeId: "5",
      label: "Five",
      status: "retry",
      sequence: 1,
      attempt: 1,
      retryMode: "manual-review",
    },
  ];
  assert.deepEqual(summarizeCreateImagesRunProgress(nodes), {
    completed: 3,
    total: 5,
    active: 1,
    waiting: 1,
    failed: 1,
    percentage: 60,
    label: "3 nodes finished of 5",
  });
});

test("automatic mock retry-wait remains nonterminal progress", () => {
  const nodes: CreateImagesNodeRunUiState[] = [
    { nodeId: "1", label: "One", status: "succeeded", sequence: 1, attempt: 1 },
    {
      nodeId: "2",
      label: "Two",
      status: "retry",
      sequence: 2,
      attempt: 1,
      retryMode: "automatic-mock",
    },
    { nodeId: "3", label: "Three", status: "queued", sequence: 2, attempt: 0 },
  ];
  assert.deepEqual(summarizeCreateImagesRunProgress(nodes), {
    completed: 1,
    total: 3,
    active: 0,
    waiting: 2,
    failed: 0,
    percentage: 33,
    label: "1 node finished of 3",
  });
});

test("terminal history is newest first, durable, and does not mutate its input", () => {
  const input = [
    {
      runId: "older",
      workflowRevision: 6,
      scopeLabel: "Entire workflow",
      status: "succeeded" as const,
      startedAt: "2026-08-11T10:00:00.000Z",
      finishedAt: "2026-08-11T10:01:05.000Z",
      providerLabel: "Aiden local mock",
      modelLabel: "Checkerboard",
      requestCount: 1,
      completedNodeCount: 4,
      totalNodeCount: 4,
      outputCount: 1,
      costLabel: "$0.00 mock actual",
    },
    {
      runId: "newer",
      workflowRevision: 7,
      scopeLabel: "From Generate Image",
      status: "interrupted" as const,
      startedAt: "2026-08-11T11:00:00.000Z",
      finishedAt: "2026-08-11T11:00:09.000Z",
      providerLabel: "Aiden local mock",
      modelLabel: "Checkerboard",
      requestCount: 1,
      completedNodeCount: 1,
      totalNodeCount: 3,
      outputCount: 0,
      costLabel: "$0.00 mock actual",
    },
  ];
  const views = createImagesTerminalRunHistoryViews(input);
  assert.deepEqual(
    input.map((item) => item.runId),
    ["older", "newer"],
  );
  assert.deepEqual(
    views.map((item) => item.runId),
    ["newer", "older"],
  );
  assert.equal(views[0]?.durationLabel, "9s");
  assert.equal(views[0]?.nodeSummary, "1 of 3 nodes succeeded");
  assert.equal(views[1]?.durationLabel, "1m 5s");
});
