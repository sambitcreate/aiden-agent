import assert from "node:assert/strict";
import test from "node:test";
import type { ImageProviderModelCapabilities } from "./provider-contract.js";
import {
  CREATE_IMAGES_MAX_PROVIDER_INPUT_BYTES,
  CreateImagesProviderAdmissionError,
  CreateImagesProviderAdmissionGate,
  admitCreateImagesProviderExecution,
  createCreateImagesMainCredentialBinding,
  createCreateImagesProviderAttemptEvent,
  createCreateImagesProviderAttemptProjection,
  createCreateImagesProviderCapabilitySnapshot,
  decideCreateImagesProviderAttemptRecovery,
  executeCreateImagesProviderSubmission,
  parseCreateImagesProviderConsentClaim,
  prepareCreateImagesProviderExecutionConsent,
  reduceCreateImagesProviderAttemptEvent,
  type CreateImagesProviderAttemptEventV1,
  type CreateImagesProviderAttemptProjectionV1,
  type CreateImagesProviderCapabilitySnapshotV1,
  type CreateImagesProviderExecutionAuthorizationV1,
} from "./image-provider-execution-core.js";

const AUTHORITY = { secret: new Uint8Array(32).fill(0x5a) };
const CREATED_AT = "2026-08-11T12:00:00.000Z";
const EXPIRES_AT = "2026-08-11T12:05:00.000Z";
const NOW = "2026-08-11T12:01:00.000Z";
const SOURCE_FINGERPRINT = "a".repeat(64);
const ASSET_A = "1".repeat(64);
const ASSET_B = "2".repeat(64);

function model(
  overrides: Partial<ImageProviderModelCapabilities> = {},
): ImageProviderModelCapabilities {
  return {
    id: "gemini-3.1-flash-image",
    label: "Nano Banana 2",
    providerId: "gemini",
    aspectRatios: ["1:1", "16:9"],
    imageSizes: ["1K", "2K"],
    outputMimes: ["image/png", "image/jpeg"],
    maxReferenceImages: 14,
    maxOutputs: 1,
    supportsEditing: true,
    supportsCancellation: false,
    ...overrides,
  };
}

function capability(
  overrides: {
    catalogRevision?: number;
    observedAt?: string;
    model?: Partial<ImageProviderModelCapabilities>;
    transport?: {
      kind: "synchronous" | "asynchronous";
      supportsIdempotency: boolean;
      supportsReconciliation: boolean;
    };
  } = {},
): CreateImagesProviderCapabilitySnapshotV1 {
  return createCreateImagesProviderCapabilitySnapshot({
    catalogRevision: overrides.catalogRevision ?? 7,
    observedAt: overrides.observedAt ?? CREATED_AT,
    model: model(overrides.model),
    transport: overrides.transport ?? {
      kind: "synchronous",
      supportsIdempotency: false,
      supportsReconciliation: false,
    },
  });
}

function localCapability(): CreateImagesProviderCapabilitySnapshotV1 {
  return createCreateImagesProviderCapabilitySnapshot({
    catalogRevision: 1,
    observedAt: CREATED_AT,
    model: model({
      id: "deterministic-v1",
      label: "Deterministic Phase 3",
      providerId: "local-mock",
      maxReferenceImages: 14,
      maxOutputs: 4,
      supportsCancellation: true,
    }),
    transport: {
      kind: "local",
      supportsIdempotency: true,
      supportsReconciliation: false,
    },
  });
}

const credential = createCreateImagesMainCredentialBinding({
  providerId: "gemini",
  recordId: "google-images-primary",
  revision: 4,
  authKind: "api-key",
});

function prepareRemote(
  overrides: Partial<Parameters<typeof prepareCreateImagesProviderExecutionConsent>[0]> = {},
) {
  const selectedCapability = overrides.capability ?? capability();
  return prepareCreateImagesProviderExecutionConsent(
    {
      authorizationId: "authorization-1",
      workflowId: "workflow-1",
      workflowRevision: 7,
      executionMode: "gemini",
      capability: selectedCapability,
      credentialBinding: credential,
      invocations: [
        {
          nodeId: "generate-1",
          promptBytes: 42,
          referenceImageCount: 1,
          referenceImageBytes: 1_024,
          requestedOutputs: 1,
          aspectRatio: "1:1",
          imageSize: "1K",
          outputMime: "image/png",
        },
      ],
      maximumAttempts: 1,
      estimate: {
        kind: "best-effort",
        amountMicros: 25_000,
        currency: "USD",
        estimatedAt: CREATED_AT,
        sourceFingerprint: SOURCE_FINGERPRINT,
      },
      createdAt: CREATED_AT,
      expiresAt: EXPIRES_AT,
      ...overrides,
    },
    AUTHORITY,
  );
}

function remoteClaim(prepared = prepareRemote()) {
  return {
    version: 1 as const,
    authorizationId: prepared.rendererPlan.authorizationId,
    consentFingerprint: prepared.rendererPlan.consentFingerprint,
    token: prepared.rendererPlan.token!,
    reviewed: true as const,
  };
}

function authorizeRemote(
  prepared = prepareRemote(),
  overrides: Partial<Parameters<typeof admitCreateImagesProviderExecution>[0]> = {},
): CreateImagesProviderExecutionAuthorizationV1 {
  return admitCreateImagesProviderExecution({
    mainPlan: prepared.mainPlan,
    claim: remoteClaim(prepared),
    authority: AUTHORITY,
    currentCapability: prepared.mainPlan.capability,
    currentCredential: credential,
    now: NOW,
    ...overrides,
  });
}

function attempt(authorization = authorizeRemote()): CreateImagesProviderAttemptProjectionV1 {
  return createCreateImagesProviderAttemptProjection(authorization, {
    runId: "run-1",
    nodeId: "generate-1",
    attempt: 1,
  });
}

function apply(
  projection: CreateImagesProviderAttemptProjectionV1,
  event: CreateImagesProviderAttemptEventV1,
): CreateImagesProviderAttemptProjectionV1 {
  const reduced = reduceCreateImagesProviderAttemptEvent(projection, event);
  assert.equal(reduced.accepted, true);
  return reduced.projection;
}

function expectAdmissionCode(operation: () => unknown, code: string): void {
  assert.throws(operation, (error) => {
    assert.ok(error instanceof CreateImagesProviderAdmissionError);
    assert.equal(error.code, code);
    return true;
  });
}

function gate(
  overrides: Partial<
    ConstructorParameters<typeof CreateImagesProviderAdmissionGate>[0][number]
  > = {},
) {
  return new CreateImagesProviderAdmissionGate([
    {
      providerId: "gemini",
      maxConcurrency: 1,
      maxStartsPerWindow: 3,
      windowMs: 1_000,
      minimumStartIntervalMs: 0,
      ...overrides,
    },
  ]);
}

test("capability snapshots are immutable, content-fingerprinted, and provider/model bound", () => {
  const snapshot = capability();
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.model.aspectRatios), true);
  assert.equal(snapshot.providerId, snapshot.model.providerId);
  assert.match(snapshot.fingerprint, /^[a-f0-9]{64}$/u);
  assert.notEqual(capability({ catalogRevision: 8 }).fingerprint, snapshot.fingerprint);
  assert.throws(() => {
    (snapshot.model.aspectRatios as string[]).push("21:9");
  });
  expectAdmissionCode(
    () => capability({ model: { aspectRatios: ["https://attacker.invalid" as "1:1"] } }),
    "invalid-input",
  );
});

test("renderer consent exposes accounting and a token but no credential record or provider endpoint", () => {
  const prepared = prepareRemote();
  const rendererJson = JSON.stringify(prepared.rendererPlan);
  assert.match(prepared.rendererPlan.token!, /^[a-f0-9]{64}$/u);
  assert.equal(prepared.rendererPlan.accounting.retryPolicy, "manual-new-consent");
  assert.equal(prepared.rendererPlan.accounting.maximumAttempts, 1);
  assert.equal(prepared.rendererPlan.accounting.initialRequestCount, 1);
  assert.equal(prepared.rendererPlan.accounting.dataLeavesDevice, true);
  assert.doesNotMatch(rendererJson, /google-images-primary/u);
  assert.doesNotMatch(rendererJson, /api-key/u);
  assert.doesNotMatch(rendererJson, /https?:\/\//u);
});

test("strict renderer claims reject credentials, URLs, model overrides, and unreviewed input", () => {
  const claim = remoteClaim();
  assert.deepEqual(parseCreateImagesProviderConsentClaim(claim), claim);
  for (const extra of [
    { apiKey: "secret" },
    { url: "https://attacker.invalid" },
    { modelId: "forged-model" },
  ]) {
    expectAdmissionCode(
      () => parseCreateImagesProviderConsentClaim({ ...claim, ...extra }),
      "invalid-consent",
    );
  }
  expectAdmissionCode(
    () => parseCreateImagesProviderConsentClaim({ ...claim, reviewed: false }),
    "invalid-consent",
  );
});

test("forged fingerprints and tokens cannot authorize remote work", () => {
  const prepared = prepareRemote();
  expectAdmissionCode(
    () =>
      authorizeRemote(prepared, {
        claim: { ...remoteClaim(prepared), consentFingerprint: "b".repeat(64) },
      }),
    "forged-consent",
  );
  expectAdmissionCode(
    () =>
      authorizeRemote(prepared, {
        claim: { ...remoteClaim(prepared), token: "b".repeat(64) },
      }),
    "forged-consent",
  );
  const forgedPlan = structuredClone(prepared.mainPlan);
  forgedPlan.accounting.maximumAttempts = 2;
  expectAdmissionCode(() => authorizeRemote(prepared, { mainPlan: forgedPlan }), "forged-consent");
});

test("expired and not-yet-valid consent fail before admission", () => {
  const prepared = prepareRemote();
  for (const now of ["2026-08-11T11:59:59.000Z", "2026-08-11T12:05:00.001Z"]) {
    expectAdmissionCode(() => authorizeRemote(prepared, { now }), "stale-consent");
  }
});

test("capability catalog, model, and option drift invalidate reviewed consent", () => {
  const prepared = prepareRemote();
  expectAdmissionCode(
    () =>
      authorizeRemote(prepared, {
        currentCapability: capability({ catalogRevision: 8 }),
      }),
    "capability-drift",
  );
  expectAdmissionCode(
    () =>
      authorizeRemote(prepared, {
        currentCapability: capability({ model: { imageSizes: ["1K"] } }),
      }),
    "capability-drift",
  );
});

test("main-owned credential record, revision, and auth kind are exact admission bindings", () => {
  const prepared = prepareRemote();
  const drifted = createCreateImagesMainCredentialBinding({
    providerId: "gemini",
    recordId: "google-images-primary",
    revision: 5,
    authKind: "api-key",
  });
  expectAdmissionCode(
    () => authorizeRemote(prepared, { currentCredential: drifted }),
    "credential-drift",
  );
  expectAdmissionCode(
    () => authorizeRemote(prepared, { currentCredential: undefined }),
    "credential-required",
  );
  expectAdmissionCode(
    () =>
      createCreateImagesMainCredentialBinding({
        providerId: "gemini",
        recordId: "google-images-primary",
        revision: 4,
        authKind: "oauth" as "api-key",
      }),
    "invalid-input",
  );
});

test("remote request, output, byte, and maximum-attempt accounting fails closed", () => {
  expectAdmissionCode(() => prepareRemote({ maximumAttempts: 2 }), "unsafe-accounting");
  expectAdmissionCode(
    () =>
      prepareRemote({
        invocations: [
          {
            nodeId: "generate-1",
            promptBytes: 42,
            referenceImageCount: 0,
            referenceImageBytes: 1,
            requestedOutputs: 1,
            aspectRatio: "1:1",
            imageSize: "1K",
            outputMime: "image/png",
          },
        ],
      }),
    "unsafe-accounting",
  );
  expectAdmissionCode(
    () =>
      prepareRemote({
        invocations: [
          {
            nodeId: "generate-1",
            promptBytes: 42,
            referenceImageCount: 1,
            referenceImageBytes: CREATE_IMAGES_MAX_PROVIDER_INPUT_BYTES,
            requestedOutputs: 1,
            aspectRatio: "1:1",
            imageSize: "1K",
            outputMime: "image/png",
          },
        ],
      }),
    "unsafe-accounting",
  );
  expectAdmissionCode(
    () =>
      prepareRemote({
        invocations: [
          {
            nodeId: "generate-1",
            promptBytes: 42,
            referenceImageCount: 1,
            referenceImageBytes: 1,
            requestedOutputs: 2,
            aspectRatio: "1:1",
            imageSize: "1K",
            outputMime: "image/png",
          },
        ],
      }),
    "unsafe-accounting",
  );
});

test("local mock stays credential-free and retains only its bounded automatic retry policy", () => {
  const selectedCapability = localCapability();
  const prepared = prepareCreateImagesProviderExecutionConsent(
    {
      authorizationId: "local-authorization",
      workflowId: "workflow-1",
      workflowRevision: 7,
      executionMode: "local-mock",
      capability: selectedCapability,
      invocations: [
        {
          nodeId: "generate-1",
          promptBytes: 10,
          referenceImageCount: 0,
          referenceImageBytes: 0,
          requestedOutputs: 2,
          aspectRatio: "1:1",
          imageSize: "1K",
          outputMime: "image/png",
        },
      ],
      maximumAttempts: 3,
      estimate: {
        kind: "mock",
        amountMicros: 0,
        currency: "USD",
        estimatedAt: CREATED_AT,
        sourceFingerprint: SOURCE_FINGERPRINT,
      },
      createdAt: CREATED_AT,
      expiresAt: EXPIRES_AT,
    },
    AUTHORITY,
  );
  assert.equal(prepared.rendererPlan.token, undefined);
  const authorization = admitCreateImagesProviderExecution({
    mainPlan: prepared.mainPlan,
    authority: AUTHORITY,
    currentCapability: selectedCapability,
    now: NOW,
  });
  assert.equal(authorization.credentialBinding, undefined);
  assert.equal(authorization.accounting.retryPolicy, "bounded-local-automatic");
  assert.equal(authorization.accounting.dataLeavesDevice, false);
  assert.equal(
    createCreateImagesProviderAttemptProjection(authorization, {
      runId: "run-local",
      nodeId: "generate-1",
      attempt: 3,
    }).attempt,
    3,
  );
});

test("paid Gemini attempts are single-attempt and cannot manufacture an automatic retry", () => {
  const authorization = authorizeRemote();
  assert.equal(authorization.accounting.retryPolicy, "manual-new-consent");
  assert.equal(authorization.accounting.maximumAttempts, 1);
  expectAdmissionCode(
    () =>
      createCreateImagesProviderAttemptProjection(authorization, {
        runId: "run-1",
        nodeId: "generate-1",
        attempt: 2,
      }),
    "unsafe-accounting",
  );
});

test("provider gates enforce exact concurrency ownership and reject forged or double release", () => {
  const admissionGate = gate();
  const first = admissionGate.tryAcquire("gemini", 100);
  assert.equal(first.status, "acquired");
  assert.deepEqual(admissionGate.tryAcquire("gemini", 101), {
    status: "deferred",
    reason: "concurrency",
    retryAfterMs: 0,
  });
  if (first.status !== "acquired") return;
  assert.equal(admissionGate.release({ ...first.lease }), false);
  assert.equal(admissionGate.release(first.lease), true);
  assert.equal(admissionGate.release(first.lease), false);
  assert.equal(admissionGate.snapshot("gemini").active, 0);
});

test("provider gates enforce minimum intervals and bounded rolling windows", () => {
  const admissionGate = gate({
    maxConcurrency: 2,
    maxStartsPerWindow: 2,
    windowMs: 1_000,
    minimumStartIntervalMs: 100,
  });
  const first = admissionGate.tryAcquire("gemini", 100);
  assert.equal(first.status, "acquired");
  if (first.status === "acquired") admissionGate.release(first.lease);
  assert.deepEqual(admissionGate.tryAcquire("gemini", 150), {
    status: "deferred",
    reason: "rate",
    retryAfterMs: 50,
  });
  const second = admissionGate.tryAcquire("gemini", 200);
  assert.equal(second.status, "acquired");
  if (second.status === "acquired") admissionGate.release(second.lease);
  assert.deepEqual(admissionGate.tryAcquire("gemini", 300), {
    status: "deferred",
    reason: "rate",
    retryAfterMs: 800,
  });
  assert.equal(admissionGate.tryAcquire("gemini", 1_100).status, "acquired");
});

test("attempt events are identity-bound, contiguous, and output-count checked", () => {
  const initial = attempt();
  const preparedEvent = createCreateImagesProviderAttemptEvent(initial, {
    kind: "submission-prepared",
  });
  const prepared = apply(initial, preparedEvent);
  assert.equal(prepared.status, "prepared");
  assert.equal(reduceCreateImagesProviderAttemptEvent(prepared, preparedEvent).accepted, false);
  assert.equal(
    reduceCreateImagesProviderAttemptEvent(prepared, {
      ...createCreateImagesProviderAttemptEvent(prepared, {
        kind: "output-published",
        outputAssetIds: [ASSET_A],
      }),
      runId: "run-other",
    }).accepted,
    false,
  );
  assert.equal(
    reduceCreateImagesProviderAttemptEvent(prepared, {
      ...createCreateImagesProviderAttemptEvent(prepared, {
        kind: "output-published",
        outputAssetIds: [ASSET_A],
      }),
      sequence: prepared.lastSequence + 2,
    }).accepted,
    false,
  );
  const mismatched = reduceCreateImagesProviderAttemptEvent(
    prepared,
    createCreateImagesProviderAttemptEvent(prepared, {
      kind: "output-published",
      outputAssetIds: [ASSET_A, ASSET_B],
    }),
  );
  assert.deepEqual(mismatched, {
    accepted: false,
    projection: prepared,
    reason: "output-mismatch",
  });
});

test("usage projection is aggregate-only, bounded, and marks reported billing", () => {
  let projection = attempt();
  projection = apply(
    projection,
    createCreateImagesProviderAttemptEvent(projection, { kind: "submission-prepared" }),
  );
  projection = apply(
    projection,
    createCreateImagesProviderAttemptEvent(projection, {
      kind: "output-published",
      outputAssetIds: [ASSET_A],
      usage: {
        inputUnits: 10,
        outputUnits: 20,
        totalUnits: 30,
        billedRequestCount: 1,
        costMicros: 25_000,
        currency: "USD",
      },
    }),
  );
  assert.equal(projection.status, "succeeded");
  assert.deepEqual(projection.usage, {
    providerId: "gemini",
    modelId: "gemini-3.1-flash-image",
    requestCount: 1,
    outputCount: 1,
    billingStatus: "provider-reported",
    reported: {
      inputUnits: 10,
      outputUnits: 20,
      totalUnits: 30,
      billedRequestCount: 1,
      costMicros: 25_000,
      currency: "USD",
    },
  });
});

test("synchronous prepared or unknown Gemini work needs attention and is never resubmitted", async () => {
  let projection = attempt();
  projection = apply(
    projection,
    createCreateImagesProviderAttemptEvent(projection, { kind: "submission-prepared" }),
  );
  assert.deepEqual(decideCreateImagesProviderAttemptRecovery(projection), {
    action: "needs-attention",
    reason: "prepared-or-unknown",
  });
  let submitCalls = 0;
  const outcome = await executeCreateImagesProviderSubmission({
    projection,
    gate: gate(),
    nowMs: Date.parse(NOW),
    persistPrepared: async () => {
      throw new Error("must not persist again");
    },
    submit: async () => {
      submitCalls += 1;
      return { kind: "completed", output: "impossible", outputCount: 1 };
    },
  });
  assert.deepEqual(outcome, {
    kind: "recovery",
    decision: { action: "needs-attention", reason: "prepared-or-unknown" },
  });
  assert.equal(submitCalls, 0);

  projection = apply(
    projection,
    createCreateImagesProviderAttemptEvent(projection, {
      kind: "submission-unknown",
      errorCode: "transport-unknown",
    }),
  );
  assert.equal(projection.status, "needs_attention");
  assert.equal(projection.usage.billingStatus, "possibly-billable");
  assert.deepEqual(decideCreateImagesProviderAttemptRecovery(projection), {
    action: "needs-attention",
    reason: "prepared-or-unknown",
  });
});

test("execution persists prepared before resolving main credentials and invokes the adapter once", async () => {
  const calls: string[] = [];
  const initial = attempt();
  let durable = initial;
  const output = { stagedAsset: "opaque-staging-record" };
  const outcome = await executeCreateImagesProviderSubmission<{ apiKey: string }, typeof output>({
    projection: initial,
    gate: gate(),
    nowMs: Date.parse(NOW),
    persistPrepared: async (event) => {
      calls.push("persist-prepared");
      durable = apply(durable, event);
      return durable;
    },
    resolveCredential: async (binding) => {
      calls.push("resolve-credential");
      return { binding, credential: { apiKey: "super-secret-key" } };
    },
    submit: async ({ credential: resolved, idempotencyKey }) => {
      calls.push("submit");
      assert.equal(resolved?.apiKey, "super-secret-key");
      assert.match(idempotencyKey, /^aiden-ci-[a-f0-9]{64}$/u);
      return {
        kind: "completed",
        output,
        outputCount: 1,
        usage: { billedRequestCount: 1 },
      };
    },
  });
  assert.deepEqual(calls, ["persist-prepared", "resolve-credential", "submit"]);
  assert.deepEqual(outcome, {
    kind: "completed",
    output,
    outputCount: 1,
    usage: { billedRequestCount: 1 },
  });
  assert.equal(durable.status, "prepared");
});

test("credential drift after durable preparation is confirmed not sent and requires new consent", async () => {
  const initial = attempt();
  let durable = initial;
  let submitted = false;
  const outcome = await executeCreateImagesProviderSubmission({
    projection: initial,
    gate: gate(),
    nowMs: Date.parse(NOW),
    persistPrepared: async (event) => {
      durable = apply(durable, event);
      return durable;
    },
    resolveCredential: async () => ({
      binding: createCreateImagesMainCredentialBinding({
        providerId: "gemini",
        recordId: "google-images-primary",
        revision: 99,
        authKind: "api-key",
      }),
      credential: "changed-secret",
    }),
    submit: async () => {
      submitted = true;
      return { kind: "completed" as const, output: "bad", outputCount: 1 };
    },
  });
  assert.equal(submitted, false);
  assert.equal(outcome.kind, "event");
  if (outcome.kind !== "event") return;
  assert.equal(outcome.retry, "new-consent-required");
  const failed = apply(durable, outcome.event);
  assert.equal(failed.submission, "confirmed-not-sent");
  assert.equal(failed.usage.billingStatus, "not-submitted");
});

test("post-send transport loss is ambiguous, possibly billable, and never automatically retried", async () => {
  const initial = attempt();
  let durable = initial;
  let submitCalls = 0;
  const outcome = await executeCreateImagesProviderSubmission({
    projection: initial,
    gate: gate(),
    nowMs: Date.parse(NOW),
    persistPrepared: async (event) => {
      durable = apply(durable, event);
      return durable;
    },
    resolveCredential: async (binding) => ({ binding, credential: "secret" }),
    submit: async () => {
      submitCalls += 1;
      throw new Error("socket reset after request write");
    },
  });
  assert.equal(submitCalls, 1);
  assert.equal(outcome.kind, "event");
  if (outcome.kind !== "event") return;
  assert.equal(outcome.event.kind, "submission-unknown");
  assert.equal(outcome.retry, "none");
  const ambiguous = apply(durable, outcome.event);
  assert.equal(ambiguous.status, "needs_attention");
  assert.equal(ambiguous.usage.requestCount, 1);
  assert.equal(ambiguous.usage.billingStatus, "possibly-billable");
});

test("rate limits and provider failures are terminal for this paid consent", async () => {
  for (const kind of ["rate-limited", "failed"] as const) {
    const initial = attempt();
    let durable = initial;
    const outcome = await executeCreateImagesProviderSubmission({
      projection: initial,
      gate: gate(),
      nowMs: Date.parse(NOW),
      persistPrepared: async (event) => {
        durable = apply(durable, event);
        return durable;
      },
      resolveCredential: async (binding) => ({ binding, credential: "secret" }),
      submit: async () => ({
        kind,
        errorCode: kind === "rate-limited" ? "rate-limited" : "refused",
      }),
    });
    assert.equal(outcome.kind, "event");
    if (outcome.kind !== "event") continue;
    assert.equal(outcome.retry, "new-consent-required");
    const failed = apply(durable, outcome.event);
    assert.equal(failed.status, "failed");
    assert.equal(failed.usage.requestCount, 1);
  }
});

test("malformed provider billing metadata becomes a contract ambiguity instead of disappearing", async () => {
  const initial = attempt();
  let durable = initial;
  const outcome = await executeCreateImagesProviderSubmission({
    projection: initial,
    gate: gate(),
    nowMs: Date.parse(NOW),
    persistPrepared: async (event) => {
      durable = apply(durable, event);
      return durable;
    },
    resolveCredential: async (binding) => ({ binding, credential: "secret" }),
    submit: async () => ({
      kind: "failed" as const,
      errorCode: "provider-failed",
      usage: { billedRequestCount: 2 },
    }),
  });
  assert.equal(outcome.kind, "event");
  if (outcome.kind !== "event") return;
  assert.equal(outcome.event.kind, "submission-unknown");
  assert.equal(outcome.retry, "none");
  assert.equal(apply(durable, outcome.event).status, "needs_attention");
});

test("cancellation before the adapter call is known not sent and does not consume provider work", async () => {
  const initial = attempt();
  const controller = new AbortController();
  controller.abort();
  let persisted = false;
  let submitted = false;
  const outcome = await executeCreateImagesProviderSubmission({
    projection: initial,
    gate: gate(),
    nowMs: Date.parse(NOW),
    signal: controller.signal,
    persistPrepared: async () => {
      persisted = true;
      return initial;
    },
    submit: async () => {
      submitted = true;
      return { kind: "completed" as const, output: "bad", outputCount: 1 };
    },
  });
  assert.equal(persisted, false);
  assert.equal(submitted, false);
  assert.equal(outcome.kind, "cancelled-before-submit");
  if (outcome.kind !== "cancelled-before-submit") return;
  let cancelled = apply(initial, outcome.events[0]);
  cancelled = apply(cancelled, outcome.events[1]);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.usage.billingStatus, "not-submitted");
});

test("cancellation after submit begins becomes unknown unless the adapter proves non-submission", async () => {
  const initial = attempt();
  const controller = new AbortController();
  let durable = initial;
  const outcome = await executeCreateImagesProviderSubmission({
    projection: initial,
    gate: gate(),
    nowMs: Date.parse(NOW),
    signal: controller.signal,
    persistPrepared: async (event) => {
      durable = apply(durable, event);
      return durable;
    },
    resolveCredential: async (binding) => ({ binding, credential: "secret" }),
    submit: async () => {
      controller.abort();
      return { kind: "completed" as const, output: "provider-output", outputCount: 1 };
    },
  });
  assert.equal(outcome.kind, "event");
  if (outcome.kind !== "event") return;
  assert.equal(outcome.event.kind, "submission-unknown");
  assert.equal(outcome.retry, "none");
  assert.equal(apply(durable, outcome.event).status, "needs_attention");
});

test("synchronous Gemini rejects an async acceptance contract without trusting its job ID", async () => {
  const initial = attempt();
  let durable = initial;
  const outcome = await executeCreateImagesProviderSubmission({
    projection: initial,
    gate: gate(),
    nowMs: Date.parse(NOW),
    persistPrepared: async (event) => {
      durable = apply(durable, event);
      return durable;
    },
    resolveCredential: async (binding) => ({ binding, credential: "secret" }),
    submit: async () => ({ kind: "accepted" as const, providerJobId: "unexpected-job" }),
  });
  assert.equal(outcome.kind, "event");
  if (outcome.kind !== "event") return;
  assert.equal(outcome.event.kind, "submission-unknown");
  assert.equal(apply(durable, outcome.event).providerJobId, undefined);
});

test("asynchronous accepted jobs reconcile or cancel by durable job ID without resubmission", () => {
  const prepared = prepareRemote({
    capability: capability({
      transport: {
        kind: "asynchronous",
        supportsIdempotency: true,
        supportsReconciliation: true,
      },
      model: { supportsCancellation: true },
    }),
  });
  let projection = attempt(authorizeRemote(prepared));
  projection = apply(
    projection,
    createCreateImagesProviderAttemptEvent(projection, { kind: "submission-prepared" }),
  );
  assert.deepEqual(decideCreateImagesProviderAttemptRecovery(projection), {
    action: "reconcile-only",
  });
  projection = apply(
    projection,
    createCreateImagesProviderAttemptEvent(projection, {
      kind: "submission-accepted",
      providerJobId: "job-1",
    }),
  );
  assert.deepEqual(decideCreateImagesProviderAttemptRecovery(projection), {
    action: "reconcile-only",
    providerJobId: "job-1",
  });
  projection = apply(
    projection,
    createCreateImagesProviderAttemptEvent(projection, {
      kind: "cancellation-requested",
      reason: "user",
    }),
  );
  assert.deepEqual(decideCreateImagesProviderAttemptRecovery(projection), {
    action: "cancel-only",
    providerJobId: "job-1",
  });
});

test("late valid outputs stay attached to the exact cancelled attempt without becoming success", () => {
  let projection = attempt();
  projection = apply(
    projection,
    createCreateImagesProviderAttemptEvent(projection, { kind: "submission-prepared" }),
  );
  projection = apply(
    projection,
    createCreateImagesProviderAttemptEvent(projection, {
      kind: "cancellation-requested",
      reason: "user",
    }),
  );
  projection = apply(
    projection,
    createCreateImagesProviderAttemptEvent(projection, { kind: "cancelled" }),
  );
  projection = apply(
    projection,
    createCreateImagesProviderAttemptEvent(projection, {
      kind: "late-output-published",
      outputAssetIds: [ASSET_A],
    }),
  );
  assert.equal(projection.status, "cancelled");
  assert.deepEqual(projection.outputAssetIds, []);
  assert.deepEqual(projection.lateOutputAssetIds, [ASSET_A]);
  assert.equal(projection.usage.billingStatus, "possibly-billable");

  const forged = reduceCreateImagesProviderAttemptEvent(projection, {
    ...createCreateImagesProviderAttemptEvent(projection, {
      kind: "late-output-published",
      outputAssetIds: [ASSET_A],
    }),
    nodeId: "generate-other",
  });
  assert.equal(forged.accepted, false);
});

test("durable authorization and projection contain no consent token, secret, prompt, URL, or raw output", async () => {
  const prepared = prepareRemote();
  const authorization = authorizeRemote(prepared);
  const initial = attempt(authorization);
  let durable = initial;
  const sensitive = {
    apiKey: "super-secret-key",
    prompt: "private prompt text",
    signedUrl: "https://storage.invalid/private-token",
  };
  const outcome = await executeCreateImagesProviderSubmission({
    projection: initial,
    gate: gate(),
    nowMs: Date.parse(NOW),
    persistPrepared: async (event) => {
      durable = apply(durable, event);
      return durable;
    },
    resolveCredential: async (binding) => ({
      binding,
      credential: sensitive.apiKey,
    }),
    submit: async () => ({ kind: "completed", output: sensitive, outputCount: 1 }),
  });
  assert.equal(outcome.kind, "completed");
  const durableJson = JSON.stringify({ authorization, projection: durable });
  for (const forbidden of [
    prepared.rendererPlan.token!,
    sensitive.apiKey,
    sensitive.prompt,
    sensitive.signedUrl,
    "https://",
  ]) {
    assert.equal(durableJson.includes(forbidden), false);
  }
  assert.equal(durableJson.includes("promptBytes"), true);
  assert.equal(durableJson.includes("referenceImageBytes"), true);
});
