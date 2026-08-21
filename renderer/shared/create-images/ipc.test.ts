import assert from "node:assert/strict";
import test from "node:test";
import { createStarterWorkflow, parseWorkflowDocument } from "./schema.js";
import {
  CREATE_IMAGES_MAX_DROPPED_FILES,
  CREATE_IMAGES_MAX_RECENT_OUTPUTS,
  createImagesAssetGrantUrl,
  parseCreateImagesCreateWorkflowRequest,
  parseCreateImagesApplyAssetCleanupRequest,
  parseCreateImagesDeleteWorkflowRequest,
  parseCreateImagesDiscardDegradedRunRequest,
  parseCreateImagesDroppedAssetImportRequest,
  parseCreateImagesDownloadWorkflowAssetRequest,
  parseCreateImagesDownloadRunAssetRequest,
  parseCreateImagesDownloadRunAssetsZipRequest,
  parseCreateImagesExportArchiveRequest,
  parseCreateImagesGrantAssetRequest,
  parseCreateImagesGrantRunAssetRequest,
  parseCreateImagesGetRunRequest,
  parseCreateImagesImportArchiveRequest,
  parseCreateImagesImportNodeBananaRequest,
  parseCreateImagesListRecentOutputsRequest,
  parseCreateImagesGetPresentationRequest,
  parseCreateImagesSetAssetHiddenRequest,
  parseCreateImagesPlanRunHistoryPruneRequest,
  parseCreateImagesPlanAssetCleanupRequest,
  parseCreateImagesPasteImageRequest,
  parseCreateImagesPrepareRunRequest,
  parseCreateImagesProposeWorkflowRequest,
  parseCreateImagesPlanDegradedRunDiscardRequest,
  parseCreateImagesPruneRunHistoryRequest,
  parseCreateImagesRecoverRunRequest,
  parseCreateImagesResolveRunAmbiguityRequest,
  parseCreateImagesSaveWorkflowRequest,
  parseCreateImagesStartRunRequest,
  parseCreateImagesStopRunRequest,
  parseCreateImagesUnsubscribeRunsRequest,
  parseCreateImagesWorkspaceRequest,
} from "./ipc.js";

function starter() {
  return createStarterWorkflow({
    workflowId: "workflow-1",
    promptNodeId: "prompt-1",
    generationNodeId: "generate-1",
    outputNodeId: "output-1",
    promptEdgeId: "edge-1",
    outputEdgeId: "edge-2",
    now: "2026-08-11T12:00:00.000Z",
  });
}

test("workflow save requests require strict CAS revision advancement", () => {
  const workflow = { ...starter(), revision: 2 };
  assert.deepEqual(parseCreateImagesSaveWorkflowRequest({ expectedRevision: 1, workflow }), {
    expectedRevision: 1,
    workflow,
  });
  assert.throws(() => parseCreateImagesSaveWorkflowRequest({ expectedRevision: 2, workflow }));
  assert.throws(() =>
    parseCreateImagesSaveWorkflowRequest({
      expectedRevision: 1,
      workflow,
      future: true,
    }),
  );
});

test("workflow proposal IPC binds the exact current draft and selected chat model", () => {
  const workflow = starter();
  const request = {
    workflowId: workflow.id,
    expectedRevision: workflow.revision,
    workflow,
    providerId: "openai-codex",
    model: "gpt-5.6",
    request: "  Build a portrait workflow.  ",
  };
  assert.deepEqual(parseCreateImagesProposeWorkflowRequest(request), {
    ...request,
    request: "Build a portrait workflow.",
  });
  assert.throws(() =>
    parseCreateImagesProposeWorkflowRequest({ ...request, expectedRevision: 2 }),
  );
  assert.throws(() =>
    parseCreateImagesProposeWorkflowRequest({ ...request, path: "/private/workflow.json" }),
  );
  assert.throws(() =>
    parseCreateImagesProposeWorkflowRequest({ ...request, request: "x".repeat(4_001) }),
  );
});

test("schema, IPC, and persistence share the same workflow byte ceiling", () => {
  const underLimit = { ...starter(), revision: 2 };
  underLimit.nodes.push(
    ...Array.from({ length: 140 }, (_, index) => ({
      id: `large-prompt-${index}`,
      type: "prompt" as const,
      position: { x: index, y: index },
      data: { text: "x".repeat(30_000) },
    })),
  );
  assert.equal(parseWorkflowDocument(underLimit).success, true);
  assert.equal(
    parseCreateImagesSaveWorkflowRequest({
      expectedRevision: 1,
      workflow: underLimit,
    }).workflow.nodes.length,
    underLimit.nodes.length,
  );

  const overLimit = structuredClone(underLimit);
  overLimit.nodes.push(
    ...Array.from({ length: 140 }, (_, index) => ({
      id: `overflow-prompt-${index}`,
      type: "prompt" as const,
      position: { x: index, y: index + 200 },
      data: { text: "y".repeat(30_000) },
    })),
  );
  assert.equal(parseWorkflowDocument(overLimit).success, false);
  assert.throws(() =>
    parseCreateImagesSaveWorkflowRequest({
      expectedRevision: 1,
      workflow: overLimit,
    }),
  );
});

test("workflow and asset IPC requests reject hostile object keys and identifiers", () => {
  assert.deepEqual(
    parseCreateImagesCreateWorkflowRequest({
      template: "blank",
      title: " New ",
    }),
    {
      template: "blank",
      title: "New",
    },
  );
  assert.deepEqual(parseCreateImagesCreateWorkflowRequest({ template: "reference-edit" }), {
    template: "reference-edit",
  });
  assert.deepEqual(parseCreateImagesCreateWorkflowRequest({ template: "variant-set" }), {
    template: "variant-set",
  });
  assert.throws(() =>
    parseCreateImagesCreateWorkflowRequest({
      template: "blank",
      __proto__: {},
    }),
  );
  assert.throws(() =>
    parseCreateImagesGrantAssetRequest({
      workflowId: "constructor",
      assetId: "a".repeat(63),
    }),
  );
});

test("workflow delete requests accept only the exact CAS contract", () => {
  assert.deepEqual(
    parseCreateImagesDeleteWorkflowRequest({
      workflowId: "workflow-1",
      expectedRevision: 3,
    }),
    { workflowId: "workflow-1", expectedRevision: 3 },
  );
  assert.throws(() =>
    parseCreateImagesDeleteWorkflowRequest({
      workflowId: "workflow-1",
      expectedRevision: 3,
      future: true,
    }),
  );
  assert.throws(() =>
    parseCreateImagesDeleteWorkflowRequest({
      workflowId: "../workflow",
      expectedRevision: 3,
    }),
  );
  assert.throws(() =>
    parseCreateImagesDeleteWorkflowRequest({
      workflowId: "workflow-1",
      expectedRevision: 0,
    }),
  );
  assert.throws(() =>
    parseCreateImagesDeleteWorkflowRequest(
      Object.assign(Object.create({ inherited: true }), {
        workflowId: "workflow-1",
        expectedRevision: 3,
      }),
    ),
  );
});

test("native archive requests expose no renderer-controlled file paths", () => {
  assert.deepEqual(
    parseCreateImagesExportArchiveRequest({ workflowId: "workflow-1", expectedRevision: 3 }),
    { workflowId: "workflow-1", expectedRevision: 3 },
  );
  assert.deepEqual(parseCreateImagesImportArchiveRequest({}), {});
  assert.deepEqual(parseCreateImagesImportNodeBananaRequest({}), {});
  assert.deepEqual(parseCreateImagesWorkspaceRequest({}), {});
  assert.throws(() =>
    parseCreateImagesExportArchiveRequest({
      workflowId: "workflow-1",
      expectedRevision: 3,
      destination: "/tmp/stolen.aiden-images",
    }),
  );
  assert.throws(() =>
    parseCreateImagesImportArchiveRequest({ source: "/tmp/hostile.aiden-images" }),
  );
  assert.throws(() =>
    parseCreateImagesImportNodeBananaRequest({ source: "/tmp/node-banana.json" }),
  );
  assert.throws(() => parseCreateImagesWorkspaceRequest({ path: "/tmp/hostile" }));
});

test("asset cleanup is an exact two-step confirmation with no asset IDs from renderer", () => {
  assert.deepEqual(parseCreateImagesPlanAssetCleanupRequest({}), {});
  assert.deepEqual(
    parseCreateImagesApplyAssetCleanupRequest({ planId: "a".repeat(32), confirmed: true }),
    { planId: "a".repeat(32), confirmed: true },
  );
  assert.throws(() => parseCreateImagesPlanAssetCleanupRequest({ graceMs: 0 }));
  assert.throws(() =>
    parseCreateImagesApplyAssetCleanupRequest({
      planId: "a".repeat(32),
      confirmed: false,
    }),
  );
  assert.throws(() =>
    parseCreateImagesApplyAssetCleanupRequest({
      planId: "a".repeat(32),
      confirmed: true,
      assetIds: ["b".repeat(64)],
    }),
  );
});

test("retained image download identifies only an authorized run asset and never a path", () => {
  const request = {
    workflowId: "workflow-1",
    runId: "run-1",
    assetId: "a".repeat(64),
  };
  assert.deepEqual(parseCreateImagesDownloadRunAssetRequest(request), request);
  assert.throws(() =>
    parseCreateImagesDownloadRunAssetRequest({ ...request, destination: "/tmp/output.png" }),
  );
  assert.throws(() => parseCreateImagesDownloadRunAssetRequest({ ...request, assetId: "bad" }));
});

test("multi-image ZIP export is opaque, unique, and bounded", () => {
  const request = {
    workflowId: "workflow-1",
    runId: "run-1",
    assetIds: ["a".repeat(64), "b".repeat(64)],
  };
  assert.deepEqual(parseCreateImagesDownloadRunAssetsZipRequest(request), request);
  assert.throws(() => parseCreateImagesDownloadRunAssetsZipRequest({ ...request, path: "/tmp" }));
  assert.throws(() =>
    parseCreateImagesDownloadRunAssetsZipRequest({ ...request, assetIds: ["a".repeat(64), "a".repeat(64)] }),
  );
  assert.throws(() =>
    parseCreateImagesDownloadRunAssetsZipRequest({
      ...request,
      assetIds: Array.from({ length: 51 }, (_, index) => index.toString(16).padStart(64, "0")),
    }),
  );
});

test("workflow image download identifies only an authorized opaque asset and never a path", () => {
  const request = {
    workflowId: "workflow-1",
    assetId: "a".repeat(64),
  };
  assert.deepEqual(parseCreateImagesDownloadWorkflowAssetRequest(request), request);
  assert.throws(() =>
    parseCreateImagesDownloadWorkflowAssetRequest({
      ...request,
      destination: "/tmp/output.png",
    }),
  );
  assert.throws(() =>
    parseCreateImagesDownloadWorkflowAssetRequest({ ...request, assetId: "bad" }),
  );
});

test("recent output queries are exact and capped to the retained presentation contract", () => {
  assert.deepEqual(parseCreateImagesListRecentOutputsRequest({ limit: 50 }), { limit: 50 });
  assert.deepEqual(
    parseCreateImagesListRecentOutputsRequest({ limit: CREATE_IMAGES_MAX_RECENT_OUTPUTS }),
    { limit: 50 },
  );
  assert.throws(() => parseCreateImagesListRecentOutputsRequest({ limit: 0 }));
  assert.throws(() => parseCreateImagesListRecentOutputsRequest({ limit: 51 }));
  assert.throws(() => parseCreateImagesListRecentOutputsRequest({ limit: 5, path: "/tmp" }));
});

test("presentation IPC is document scoped, opaque, and exact", () => {
  const assetId = "a".repeat(64);
  assert.deepEqual(parseCreateImagesGetPresentationRequest({ workflowId: "workflow-1" }), {
    workflowId: "workflow-1",
  });
  assert.deepEqual(
    parseCreateImagesSetAssetHiddenRequest({
      workflowId: "workflow-1",
      runId: "run-1",
      assetId,
      hidden: true,
    }),
    { workflowId: "workflow-1", runId: "run-1", assetId, hidden: true },
  );
  assert.throws(() =>
    parseCreateImagesSetAssetHiddenRequest({
      workflowId: "workflow-1",
      runId: "run-1",
      assetId,
      hidden: true,
      path: "/private/output.png",
    }),
  );
  assert.throws(() =>
    parseCreateImagesSetAssetHiddenRequest({
      workflowId: "workflow-1",
      runId: "run-1",
      assetId: "not-an-asset",
      hidden: false,
    }),
  );
});

test("asset delivery URLs contain only opaque grant tokens", () => {
  const token = "A".repeat(43);
  assert.equal(createImagesAssetGrantUrl(token), `aiden-asset://asset/${token}`);
  assert.equal(
    createImagesAssetGrantUrl(token, "preview-128"),
    `aiden-asset://asset/${token}/preview-128`,
  );
  assert.equal(
    createImagesAssetGrantUrl(token, "original"),
    `aiden-asset://asset/${token}/original`,
  );
  assert.throws(() => createImagesAssetGrantUrl("../../etc/passwd"));
});

test("clipboard image paste requests carry only the workflow identifier", () => {
  assert.deepEqual(parseCreateImagesPasteImageRequest({ workflowId: "workflow-1" }), {
    workflowId: "workflow-1",
  });
  assert.throws(() =>
    parseCreateImagesPasteImageRequest({
      workflowId: "workflow-1",
      bytes: "data:image/png;base64,not-allowed",
    }),
  );
  assert.throws(() =>
    parseCreateImagesPasteImageRequest({
      workflowId: "workflow-1",
      filePath: "/tmp/clipboard.png",
    }),
  );
  assert.throws(() => parseCreateImagesPasteImageRequest({ workflowId: "../workflow" }));
});

test("dropped asset imports accept only a bounded exact preload-owned path batch", () => {
  assert.deepEqual(
    parseCreateImagesDroppedAssetImportRequest({
      workflowId: "workflow-1",
      filePaths: ["/private/tmp/photo.webp", "/private/tmp/reference.heic"],
    }),
    {
      workflowId: "workflow-1",
      filePaths: ["/private/tmp/photo.webp", "/private/tmp/reference.heic"],
    },
  );
  assert.throws(() =>
    parseCreateImagesDroppedAssetImportRequest({ workflowId: "workflow-1", filePaths: [] }),
  );
  assert.throws(() =>
    parseCreateImagesDroppedAssetImportRequest({
      workflowId: "workflow-1",
      filePaths: Array.from(
        { length: CREATE_IMAGES_MAX_DROPPED_FILES + 1 },
        (_, index) => `/private/tmp/${index}.png`,
      ),
    }),
  );
  assert.throws(() =>
    parseCreateImagesDroppedAssetImportRequest({
      workflowId: "workflow-1",
      filePaths: ["/private/tmp/photo.png\0.jpg"],
    }),
  );
  assert.throws(() =>
    parseCreateImagesDroppedAssetImportRequest({
      workflowId: "workflow-1",
      filePaths: ["/private/tmp/photo.png"],
      arbitraryPath: "/etc/passwd",
    }),
  );
});

test("run preparation and start accept only exact bounded local or main-minted Gemini consent", () => {
  assert.deepEqual(
    parseCreateImagesStartRunRequest({
      workflowId: "workflow-1",
      expectedRevision: 3,
      scope: {
        kind: "from-node",
        nodeId: "generate-1",
        downstreamPath: ["output-1"],
      },
      consent: { executionMode: "local-mock", reviewed: true },
    }),
    {
      workflowId: "workflow-1",
      expectedRevision: 3,
      scope: {
        kind: "from-node",
        nodeId: "generate-1",
        downstreamPath: ["output-1"],
      },
      consent: { executionMode: "local-mock", reviewed: true },
    },
  );
  assert.throws(() =>
    parseCreateImagesStartRunRequest({
      workflowId: "workflow-1",
      expectedRevision: 3,
      scope: { kind: "all" },
      consent: { executionMode: "cloud", reviewed: true },
    }),
  );
  assert.deepEqual(
    parseCreateImagesPrepareRunRequest({
      workflowId: "workflow-1",
      expectedRevision: 3,
      scope: { kind: "all" },
      executionMode: "gemini",
    }),
    {
      workflowId: "workflow-1",
      expectedRevision: 3,
      scope: { kind: "all" },
      executionMode: "gemini",
    },
  );
  const fingerprint = "a".repeat(64);
  const token = "b".repeat(64);
  assert.deepEqual(
    parseCreateImagesStartRunRequest({
      workflowId: "workflow-1",
      expectedRevision: 3,
      scope: { kind: "all" },
      consent: {
        executionMode: "gemini",
        version: 1,
        authorizationId: "authorization-1",
        consentFingerprint: fingerprint,
        token,
        reviewed: true,
      },
    }).consent,
    {
      executionMode: "gemini",
      version: 1,
      authorizationId: "authorization-1",
      consentFingerprint: fingerprint,
      token,
      reviewed: true,
    },
  );
  assert.throws(() =>
    parseCreateImagesStartRunRequest({
      workflowId: "workflow-1",
      expectedRevision: 3,
      scope: { kind: "all" },
      consent: {
        executionMode: "gemini",
        version: 1,
        authorizationId: "authorization-1",
        consentFingerprint: fingerprint,
        token,
        reviewed: true,
        apiKey: "must-never-cross-ipc",
      },
    }),
  );
  assert.throws(() =>
    parseCreateImagesStartRunRequest({
      workflowId: "workflow-1",
      expectedRevision: 3,
      scope: {
        kind: "from-node",
        nodeId: "generate-1",
        downstreamPath: ["output-1", "output-1"],
      },
      consent: { executionMode: "local-mock", reviewed: true },
    }),
  );
  assert.throws(() =>
    parseCreateImagesStartRunRequest({
      workflowId: "workflow-1",
      expectedRevision: 3,
      scope: { kind: "all" },
      consent: { executionMode: "local-mock", reviewed: true },
      endpoint: "https://example.invalid",
    }),
  );
});

test("run stop, subscription, and output grants accept only opaque identifiers", () => {
  assert.deepEqual(
    parseCreateImagesStopRunRequest({
      workflowId: "workflow-1",
      runId: "run-1",
    }),
    {
      workflowId: "workflow-1",
      runId: "run-1",
    },
  );
  assert.deepEqual(
    parseCreateImagesGrantRunAssetRequest({
      workflowId: "workflow-1",
      runId: "run-1",
      assetId: "a".repeat(64),
    }),
    { workflowId: "workflow-1", runId: "run-1", assetId: "a".repeat(64) },
  );
  assert.deepEqual(
    parseCreateImagesUnsubscribeRunsRequest({
      subscriptionId: "subscription_1234",
    }),
    { subscriptionId: "subscription_1234" },
  );
  assert.throws(() =>
    parseCreateImagesGrantRunAssetRequest({
      workflowId: "workflow-1",
      runId: "../run",
      assetId: "a".repeat(64),
    }),
  );
  assert.throws(() => parseCreateImagesUnsubscribeRunsRequest({ subscriptionId: "short" }));
});

test("run detail and recovery requests are exact, opaque, and CAS guarded", () => {
  assert.deepEqual(
    parseCreateImagesGetRunRequest({
      workflowId: "workflow-1",
      runId: "run-1",
    }),
    {
      workflowId: "workflow-1",
      runId: "run-1",
    },
  );
  assert.deepEqual(
    parseCreateImagesRecoverRunRequest({
      workflowId: "workflow-1",
      runId: "run-1",
      source: "current",
      expectedCandidateJournalRevision: 9,
    }),
    {
      workflowId: "workflow-1",
      runId: "run-1",
      source: "current",
      expectedCandidateJournalRevision: 9,
    },
  );
  assert.throws(() =>
    parseCreateImagesGetRunRequest({
      workflowId: "workflow-1",
      runId: "../run-1",
    }),
  );
  assert.throws(() =>
    parseCreateImagesRecoverRunRequest({
      workflowId: "workflow-1",
      runId: "run-1",
      source: "last-known-good",
      expectedCandidateJournalRevision: 0,
    }),
  );
  assert.throws(() =>
    parseCreateImagesRecoverRunRequest({
      workflowId: "workflow-1",
      runId: "run-1",
      source: "last-known-good",
      expectedCandidateJournalRevision: 9,
      path: "/private/run.json",
    }),
  );
  assert.throws(() =>
    parseCreateImagesRecoverRunRequest({
      workflowId: "workflow-1",
      runId: "run-1",
      source: "other",
      expectedCandidateJournalRevision: 9,
    }),
  );
});

test("ambiguity acknowledgement is an exact CAS-bound resolution request", () => {
  const request = {
    workflowId: "workflow-1",
    runId: "run-1",
    expectedJournalRevision: 9,
    resolution: "acknowledge-unresolved-submission" as const,
  };
  assert.deepEqual(parseCreateImagesResolveRunAmbiguityRequest(request), request);
  assert.throws(() =>
    parseCreateImagesResolveRunAmbiguityRequest({
      ...request,
      expectedJournalRevision: 0,
    }),
  );
  assert.throws(() =>
    parseCreateImagesResolveRunAmbiguityRequest({
      ...request,
      resolution: "retry",
    }),
  );
  assert.throws(() =>
    parseCreateImagesResolveRunAmbiguityRequest({
      ...request,
      providerJobId: "secret-provider-state",
    }),
  );
});

test("run history prune requests require bounded retention and explicit CAS confirmation", () => {
  assert.deepEqual(parseCreateImagesPlanRunHistoryPruneRequest({ keepLatest: 100 }), {
    keepLatest: 100,
  });
  const authorizationToken = "a".repeat(64);
  assert.deepEqual(
    parseCreateImagesPruneRunHistoryRequest({
      keepLatest: 500,
      authorizationToken,
      confirmed: true,
    }),
    { keepLatest: 500, authorizationToken, confirmed: true },
  );
  assert.throws(() => parseCreateImagesPlanRunHistoryPruneRequest({ keepLatest: 99 }));
  assert.throws(() =>
    parseCreateImagesPruneRunHistoryRequest({
      keepLatest: 100,
      authorizationToken,
      confirmed: false,
    }),
  );
  assert.throws(() =>
    parseCreateImagesPruneRunHistoryRequest({
      keepLatest: 100,
      authorizationToken: "../token",
      confirmed: true,
    }),
  );
});

test("degraded run discard requires an exact two-step CAS token and never accepts paths", () => {
  assert.deepEqual(parseCreateImagesPlanDegradedRunDiscardRequest({ runId: "run-1" }), {
    runId: "run-1",
  });
  const request = {
    runId: "run-1",
    expectedCurrentJournalRevision: 7,
    expectedLastKnownGoodJournalRevision: 6,
    authorizationToken: "b".repeat(64),
    confirmed: true as const,
  };
  assert.deepEqual(parseCreateImagesDiscardDegradedRunRequest(request), request);
  assert.throws(() => parseCreateImagesDiscardDegradedRunRequest({ ...request, confirmed: false }));
  assert.throws(() =>
    parseCreateImagesDiscardDegradedRunRequest({
      ...request,
      expectedCurrentJournalRevision: 0,
    }),
  );
  assert.throws(() =>
    parseCreateImagesDiscardDegradedRunRequest({
      ...request,
      authorizationToken: "../discard",
    }),
  );
  assert.throws(() =>
    parseCreateImagesDiscardDegradedRunRequest({
      ...request,
      path: "/private/run-journal.json",
    }),
  );
});
