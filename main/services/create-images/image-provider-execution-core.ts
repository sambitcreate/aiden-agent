import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type {
  CreateImagesAspectRatio,
  CreateImagesImageSize,
  CreateImagesOutputMime,
} from "../../../renderer/shared/create-images/schema.js";
import { CREATE_IMAGES_ASSET_ID_PATTERN } from "../../../renderer/shared/create-images/schema.js";
import type { ImageProviderModelCapabilities } from "./provider-contract.js";

export const CREATE_IMAGES_PROVIDER_EXECUTION_VERSION = 1 as const;
export const CREATE_IMAGES_PROVIDER_CONSENT_VERSION = 1 as const;
export const CREATE_IMAGES_MAX_PROVIDER_INVOCATIONS = 500;
export const CREATE_IMAGES_MAX_PROVIDER_INPUT_BYTES = 512 * 1024 * 1024;
export const CREATE_IMAGES_MAX_PROVIDER_REQUEST_BYTES = 64 * 1024 * 1024;
export const CREATE_IMAGES_MAX_PROMPT_BYTES = 128 * 1024;
export const CREATE_IMAGES_MAX_PROVIDER_ATTEMPTS = 1_500;
export const CREATE_IMAGES_MAX_CONSENT_LIFETIME_MS = 30 * 60_000;

const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const PROVIDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,191}$/u;
const PROVIDER_JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/u;
const TOKEN_PATTERN = /^[a-f0-9]{64}$/u;
const SAFE_ERROR_CODE_PATTERN = /^[a-z][a-z0-9-]{0,95}$/u;
const CURRENCY_PATTERN = /^[A-Z]{3}$/u;
const ALLOWED_ASPECT_RATIOS = new Set<CreateImagesAspectRatio>([
  "1:1",
  "2:3",
  "3:2",
  "3:4",
  "4:3",
  "4:5",
  "5:4",
  "9:16",
  "16:9",
  "21:9",
]);
const ALLOWED_IMAGE_SIZES = new Set<CreateImagesImageSize>(["1K", "2K", "4K"]);
const ALLOWED_OUTPUT_MIMES = new Set<CreateImagesOutputMime>(["image/png", "image/jpeg"]);
const MAX_PROVIDER_USAGE_UNITS = 1_000_000_000;

export type CreateImagesExecutionMode = "local-mock" | "gemini";
export type CreateImagesProviderTransportKind = "local" | "synchronous" | "asynchronous";

export interface CreateImagesProviderTransportCapabilities {
  kind: CreateImagesProviderTransportKind;
  supportsIdempotency: boolean;
  supportsReconciliation: boolean;
}

export interface CreateImagesProviderCapabilitySnapshotV1 {
  version: typeof CREATE_IMAGES_PROVIDER_EXECUTION_VERSION;
  catalogRevision: number;
  observedAt: string;
  providerId: string;
  model: ImageProviderModelCapabilities;
  transport: CreateImagesProviderTransportCapabilities;
  fingerprint: string;
}

export interface CreateImagesMainCredentialBindingV1 {
  version: typeof CREATE_IMAGES_PROVIDER_EXECUTION_VERSION;
  providerId: "gemini";
  recordId: string;
  revision: number;
  authKind: "api-key";
}

export interface CreateImagesProviderInvocationFactsV1 {
  nodeId: string;
  promptBytes: number;
  referenceImageCount: number;
  referenceImageBytes: number;
  requestedOutputs: number;
  aspectRatio: CreateImagesAspectRatio;
  imageSize: CreateImagesImageSize;
  outputMime: CreateImagesOutputMime;
}

export interface CreateImagesProviderExecutionAccountingV1 {
  initialRequestCount: number;
  expectedOutputCount: number;
  maximumAttempts: number;
  promptBytes: number;
  referenceImageCount: number;
  referenceImageBytes: number;
  initialProviderInputBytes: number;
  dataLeavesDevice: boolean;
  retryPolicy: "bounded-local-automatic" | "manual-new-consent";
}

export type CreateImagesProviderEstimateV1 =
  | {
      kind: "mock" | "best-effort";
      amountMicros: number;
      currency: string;
      estimatedAt: string;
      sourceFingerprint: string;
    }
  | {
      kind: "unavailable";
      estimatedAt: string;
      sourceFingerprint: string;
    };

export interface CreateImagesProviderExecutionConsentPlanV1 {
  version: typeof CREATE_IMAGES_PROVIDER_EXECUTION_VERSION;
  authorizationId: string;
  workflowId: string;
  workflowRevision: number;
  executionMode: CreateImagesExecutionMode;
  capability: CreateImagesProviderCapabilitySnapshotV1;
  credentialBinding?: CreateImagesMainCredentialBindingV1;
  invocations: readonly CreateImagesProviderInvocationFactsV1[];
  accounting: CreateImagesProviderExecutionAccountingV1;
  estimate: CreateImagesProviderEstimateV1;
  createdAt: string;
  expiresAt: string;
  consentFingerprint: string;
}

export interface CreateImagesProviderRendererConsentPlanV1 {
  version: typeof CREATE_IMAGES_PROVIDER_CONSENT_VERSION;
  authorizationId: string;
  workflowId: string;
  workflowRevision: number;
  executionMode: CreateImagesExecutionMode;
  providerId: string;
  providerLabel: string;
  modelId: string;
  modelLabel: string;
  accounting: CreateImagesProviderExecutionAccountingV1;
  estimate: CreateImagesProviderEstimateV1;
  createdAt: string;
  expiresAt: string;
  consentFingerprint: string;
  /** Present only for a remote plan. The renderer may echo it but cannot mint it. */
  token?: string;
}

export interface CreateImagesProviderConsentClaimV1 {
  version: typeof CREATE_IMAGES_PROVIDER_CONSENT_VERSION;
  authorizationId: string;
  consentFingerprint: string;
  token: string;
  reviewed: true;
}

export interface CreateImagesProviderConsentAuthority {
  /** Main-owned process secret. Never persist it or expose it to a renderer. */
  secret: Uint8Array;
}

export interface CreateImagesPrepareProviderExecutionConsentInput {
  authorizationId: string;
  workflowId: string;
  workflowRevision: number;
  executionMode: CreateImagesExecutionMode;
  capability: CreateImagesProviderCapabilitySnapshotV1;
  credentialBinding?: CreateImagesMainCredentialBindingV1;
  invocations: readonly CreateImagesProviderInvocationFactsV1[];
  maximumAttempts: number;
  estimate: CreateImagesProviderEstimateV1;
  createdAt: string;
  expiresAt: string;
}

export interface CreateImagesPreparedProviderExecutionConsent {
  mainPlan: CreateImagesProviderExecutionConsentPlanV1;
  rendererPlan: CreateImagesProviderRendererConsentPlanV1;
}

export type CreateImagesProviderAdmissionErrorCode =
  | "invalid-input"
  | "invalid-consent"
  | "forged-consent"
  | "stale-consent"
  | "capability-drift"
  | "credential-drift"
  | "credential-required"
  | "unsafe-accounting";

export class CreateImagesProviderAdmissionError extends Error {
  constructor(
    readonly code: CreateImagesProviderAdmissionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CreateImagesProviderAdmissionError";
  }
}

export interface CreateImagesProviderExecutionAuthorizationV1 {
  version: typeof CREATE_IMAGES_PROVIDER_EXECUTION_VERSION;
  authorizationId: string;
  workflowId: string;
  workflowRevision: number;
  executionMode: CreateImagesExecutionMode;
  capability: CreateImagesProviderCapabilitySnapshotV1;
  credentialBinding?: CreateImagesMainCredentialBindingV1;
  invocations: readonly CreateImagesProviderInvocationFactsV1[];
  accounting: CreateImagesProviderExecutionAccountingV1;
  estimate: CreateImagesProviderEstimateV1;
  consentFingerprint: string;
  authorizedAt: string;
  expiresAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function canonicalTimestamp(value: string, label: string): string {
  let canonical = false;
  if (typeof value === "string" && value.length > 0 && value.length <= 64) {
    try {
      canonical = new Date(value).toISOString() === value;
    } catch {
      canonical = false;
    }
  }
  if (!canonical) {
    throw new CreateImagesProviderAdmissionError(
      "invalid-input",
      `${label} must be a canonical ISO-8601 timestamp.`,
    );
  }
  return value;
}

function opaqueId(value: string, label: string): string {
  if (!OPAQUE_ID_PATTERN.test(value)) {
    throw new CreateImagesProviderAdmissionError(
      "invalid-input",
      `${label} must be an opaque identifier.`,
    );
  }
  return value;
}

function safeInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new CreateImagesProviderAdmissionError(
      "unsafe-accounting",
      `${label} must be an integer from ${minimum} through ${maximum}.`,
    );
  }
  return value;
}

function safeAdd(left: number, right: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right) || right > maximum - left) {
    throw new CreateImagesProviderAdmissionError(
      "unsafe-accounting",
      `${label} exceeds its safe aggregate bound.`,
    );
  }
  return left + right;
}

function uniqueStrings(values: readonly string[], label: string): readonly string[] {
  if (values.length === 0 || new Set(values).size !== values.length) {
    throw new CreateImagesProviderAdmissionError(
      "invalid-input",
      `${label} must be a non-empty unique list.`,
    );
  }
  return Object.freeze([...values]);
}

function capabilityPayload(
  input: Omit<CreateImagesProviderCapabilitySnapshotV1, "fingerprint">,
): Omit<CreateImagesProviderCapabilitySnapshotV1, "fingerprint"> {
  return {
    version: input.version,
    catalogRevision: input.catalogRevision,
    observedAt: input.observedAt,
    providerId: input.providerId,
    model: input.model,
    transport: input.transport,
  };
}

export function createCreateImagesProviderCapabilitySnapshot(input: {
  catalogRevision: number;
  observedAt: string;
  model: ImageProviderModelCapabilities;
  transport: CreateImagesProviderTransportCapabilities;
}): CreateImagesProviderCapabilitySnapshotV1 {
  const providerId = input.model.providerId;
  if (!PROVIDER_ID_PATTERN.test(providerId) || !["local-mock", "gemini"].includes(providerId)) {
    throw new CreateImagesProviderAdmissionError(
      "invalid-input",
      "The execution core supports only local-mock and Gemini provider snapshots.",
    );
  }
  if (!MODEL_ID_PATTERN.test(input.model.id)) {
    throw new CreateImagesProviderAdmissionError("invalid-input", "Model ID is invalid.");
  }
  safeInteger(input.catalogRevision, 1, Number.MAX_SAFE_INTEGER, "Catalog revision");
  canonicalTimestamp(input.observedAt, "Capability observation time");
  if (!(["local", "synchronous", "asynchronous"] as const).includes(input.transport.kind)) {
    throw new CreateImagesProviderAdmissionError("invalid-input", "Provider transport is invalid.");
  }
  if (providerId === "local-mock" && input.transport.kind !== "local") {
    throw new CreateImagesProviderAdmissionError(
      "invalid-input",
      "The local mock requires a local transport snapshot.",
    );
  }
  if (providerId === "gemini" && input.transport.kind === "local") {
    throw new CreateImagesProviderAdmissionError(
      "invalid-input",
      "Gemini requires a remote transport snapshot.",
    );
  }
  if (input.transport.supportsReconciliation && input.transport.kind === "local") {
    throw new CreateImagesProviderAdmissionError(
      "invalid-input",
      "A local transport cannot advertise remote reconciliation.",
    );
  }
  const model: ImageProviderModelCapabilities = {
    id: input.model.id,
    label: input.model.label.trim(),
    providerId,
    aspectRatios: uniqueStrings(
      input.model.aspectRatios,
      "Aspect ratios",
    ) as readonly CreateImagesAspectRatio[],
    imageSizes: uniqueStrings(
      input.model.imageSizes,
      "Image sizes",
    ) as readonly CreateImagesImageSize[],
    outputMimes: uniqueStrings(
      input.model.outputMimes,
      "Output MIME types",
    ) as readonly CreateImagesOutputMime[],
    maxReferenceImages: safeInteger(
      input.model.maxReferenceImages,
      0,
      64,
      "Maximum reference images",
    ),
    maxOutputs: safeInteger(input.model.maxOutputs, 1, 4, "Maximum outputs"),
    supportsEditing: input.model.supportsEditing === true,
    supportsCancellation: input.model.supportsCancellation === true,
  };
  if (
    model.aspectRatios.some((value) => !ALLOWED_ASPECT_RATIOS.has(value)) ||
    model.imageSizes.some((value) => !ALLOWED_IMAGE_SIZES.has(value)) ||
    model.outputMimes.some((value) => !ALLOWED_OUTPUT_MIMES.has(value))
  ) {
    throw new CreateImagesProviderAdmissionError(
      "invalid-input",
      "The provider snapshot contains an unsupported image option.",
    );
  }
  if (!model.label || model.label.length > 128) {
    throw new CreateImagesProviderAdmissionError("invalid-input", "Model label is invalid.");
  }
  const base = deepFreeze({
    version: CREATE_IMAGES_PROVIDER_EXECUTION_VERSION,
    catalogRevision: input.catalogRevision,
    observedAt: input.observedAt,
    providerId,
    model,
    transport: {
      kind: input.transport.kind,
      supportsIdempotency: input.transport.supportsIdempotency === true,
      supportsReconciliation: input.transport.supportsReconciliation === true,
    },
  });
  return deepFreeze({ ...base, fingerprint: fingerprint(base) });
}

export function createCreateImagesMainCredentialBinding(input: {
  providerId: "gemini";
  recordId: string;
  revision: number;
  authKind: "api-key";
}): CreateImagesMainCredentialBindingV1 {
  if (input.providerId !== "gemini" || input.authKind !== "api-key") {
    throw new CreateImagesProviderAdmissionError(
      "invalid-input",
      "Gemini image execution requires an exact main-owned API-key credential binding.",
    );
  }
  return deepFreeze({
    version: CREATE_IMAGES_PROVIDER_EXECUTION_VERSION,
    providerId: input.providerId,
    recordId: opaqueId(input.recordId, "Credential record ID"),
    revision: safeInteger(input.revision, 1, Number.MAX_SAFE_INTEGER, "Credential revision"),
    authKind: input.authKind,
  });
}

function validateEstimate(
  estimate: CreateImagesProviderEstimateV1,
): CreateImagesProviderEstimateV1 {
  canonicalTimestamp(estimate.estimatedAt, "Estimate time");
  if (!FINGERPRINT_PATTERN.test(estimate.sourceFingerprint)) {
    throw new CreateImagesProviderAdmissionError(
      "invalid-input",
      "Estimate source fingerprint is invalid.",
    );
  }
  if (estimate.kind === "unavailable") return deepFreeze({ ...estimate });
  safeInteger(estimate.amountMicros, 0, Number.MAX_SAFE_INTEGER, "Estimate amount");
  if (!CURRENCY_PATTERN.test(estimate.currency)) {
    throw new CreateImagesProviderAdmissionError("invalid-input", "Estimate currency is invalid.");
  }
  return deepFreeze({ ...estimate });
}

function validateInvocation(
  invocation: CreateImagesProviderInvocationFactsV1,
  capability: CreateImagesProviderCapabilitySnapshotV1,
): CreateImagesProviderInvocationFactsV1 {
  opaqueId(invocation.nodeId, "Invocation node ID");
  safeInteger(invocation.promptBytes, 1, CREATE_IMAGES_MAX_PROMPT_BYTES, "Prompt bytes");
  safeInteger(
    invocation.referenceImageCount,
    0,
    capability.model.maxReferenceImages,
    "Reference image count",
  );
  safeInteger(
    invocation.referenceImageBytes,
    0,
    CREATE_IMAGES_MAX_PROVIDER_REQUEST_BYTES,
    "Reference image bytes",
  );
  if (invocation.referenceImageCount === 0 && invocation.referenceImageBytes !== 0) {
    throw new CreateImagesProviderAdmissionError(
      "unsafe-accounting",
      "Reference bytes require at least one reference image.",
    );
  }
  if (invocation.referenceImageCount > 0 && invocation.referenceImageBytes === 0) {
    throw new CreateImagesProviderAdmissionError(
      "unsafe-accounting",
      "Reference images require a positive byte count.",
    );
  }
  safeInteger(invocation.requestedOutputs, 1, capability.model.maxOutputs, "Requested outputs");
  if (!capability.model.aspectRatios.includes(invocation.aspectRatio)) {
    throw new CreateImagesProviderAdmissionError(
      "capability-drift",
      "The consent plan requests an unsupported aspect ratio.",
    );
  }
  if (!capability.model.imageSizes.includes(invocation.imageSize)) {
    throw new CreateImagesProviderAdmissionError(
      "capability-drift",
      "The consent plan requests an unsupported image size.",
    );
  }
  if (!capability.model.outputMimes.includes(invocation.outputMime)) {
    throw new CreateImagesProviderAdmissionError(
      "capability-drift",
      "The consent plan requests an unsupported output type.",
    );
  }
  if (
    invocation.promptBytes >
    CREATE_IMAGES_MAX_PROVIDER_REQUEST_BYTES - invocation.referenceImageBytes
  ) {
    throw new CreateImagesProviderAdmissionError(
      "unsafe-accounting",
      "A provider invocation exceeds its input byte bound.",
    );
  }
  return deepFreeze({ ...invocation });
}

function executionPlanPayload(
  plan: Omit<CreateImagesProviderExecutionConsentPlanV1, "consentFingerprint">,
): Omit<CreateImagesProviderExecutionConsentPlanV1, "consentFingerprint"> {
  return {
    version: plan.version,
    authorizationId: plan.authorizationId,
    workflowId: plan.workflowId,
    workflowRevision: plan.workflowRevision,
    executionMode: plan.executionMode,
    capability: plan.capability,
    ...(plan.credentialBinding ? { credentialBinding: plan.credentialBinding } : {}),
    invocations: plan.invocations,
    accounting: plan.accounting,
    estimate: plan.estimate,
    createdAt: plan.createdAt,
    expiresAt: plan.expiresAt,
  };
}

function consentToken(
  authority: CreateImagesProviderConsentAuthority,
  consentFingerprint: string,
): string {
  if (!(authority.secret instanceof Uint8Array) || authority.secret.byteLength < 32) {
    throw new CreateImagesProviderAdmissionError(
      "invalid-input",
      "Consent authority requires at least 32 bytes of main-owned secret material.",
    );
  }
  return createHmac("sha256", authority.secret)
    .update("aiden-create-images-provider-consent-v1\0")
    .update(consentFingerprint)
    .digest("hex");
}

export function prepareCreateImagesProviderExecutionConsent(
  input: CreateImagesPrepareProviderExecutionConsentInput,
  authority: CreateImagesProviderConsentAuthority,
): CreateImagesPreparedProviderExecutionConsent {
  opaqueId(input.authorizationId, "Authorization ID");
  opaqueId(input.workflowId, "Workflow ID");
  safeInteger(input.workflowRevision, 0, Number.MAX_SAFE_INTEGER, "Workflow revision");
  if (!(["local-mock", "gemini"] as const).includes(input.executionMode)) {
    throw new CreateImagesProviderAdmissionError("invalid-input", "Execution mode is invalid.");
  }
  const createdAt = canonicalTimestamp(input.createdAt, "Consent creation time");
  const expiresAt = canonicalTimestamp(input.expiresAt, "Consent expiry time");
  const createdMs = Date.parse(createdAt);
  const expiresMs = Date.parse(expiresAt);
  if (expiresMs <= createdMs || expiresMs - createdMs > CREATE_IMAGES_MAX_CONSENT_LIFETIME_MS) {
    throw new CreateImagesProviderAdmissionError(
      "invalid-input",
      "Consent expiry must be after creation and within the bounded lifetime.",
    );
  }
  const capability = input.capability;
  const expectedCapabilityFingerprint = fingerprint(capabilityPayload(capability));
  if (capability.fingerprint !== expectedCapabilityFingerprint) {
    throw new CreateImagesProviderAdmissionError(
      "capability-drift",
      "The provider capability snapshot fingerprint is invalid.",
    );
  }
  if (
    (input.executionMode === "local-mock" && capability.providerId !== "local-mock") ||
    (input.executionMode === "gemini" && capability.providerId !== "gemini")
  ) {
    throw new CreateImagesProviderAdmissionError(
      "invalid-input",
      "Execution mode does not match the provider snapshot.",
    );
  }
  if (input.executionMode === "gemini") {
    if (
      !input.credentialBinding ||
      input.credentialBinding.providerId !== "gemini" ||
      input.credentialBinding.authKind !== "api-key"
    ) {
      throw new CreateImagesProviderAdmissionError(
        "credential-required",
        "Remote Gemini execution requires a main-owned API-key binding.",
      );
    }
  } else if (input.credentialBinding) {
    throw new CreateImagesProviderAdmissionError(
      "invalid-input",
      "The local mock cannot carry a remote credential binding.",
    );
  }
  if (
    !Array.isArray(input.invocations) ||
    input.invocations.length < 1 ||
    input.invocations.length > CREATE_IMAGES_MAX_PROVIDER_INVOCATIONS
  ) {
    throw new CreateImagesProviderAdmissionError(
      "unsafe-accounting",
      "Provider invocation count is outside its bounded range.",
    );
  }
  const invocations = input.invocations.map((invocation) =>
    validateInvocation(invocation, capability),
  );
  if (new Set(invocations.map((invocation) => invocation.nodeId)).size !== invocations.length) {
    throw new CreateImagesProviderAdmissionError(
      "invalid-input",
      "A consent plan cannot contain duplicate provider node IDs.",
    );
  }
  let expectedOutputCount = 0;
  let promptBytes = 0;
  let referenceImageCount = 0;
  let referenceImageBytes = 0;
  for (const invocation of invocations) {
    expectedOutputCount = safeAdd(
      expectedOutputCount,
      invocation.requestedOutputs,
      CREATE_IMAGES_MAX_PROVIDER_INVOCATIONS * 4,
      "Expected output count",
    );
    promptBytes = safeAdd(
      promptBytes,
      invocation.promptBytes,
      CREATE_IMAGES_MAX_PROVIDER_INPUT_BYTES,
      "Prompt bytes",
    );
    referenceImageCount = safeAdd(
      referenceImageCount,
      invocation.referenceImageCount,
      CREATE_IMAGES_MAX_PROVIDER_INVOCATIONS * 64,
      "Reference image count",
    );
    referenceImageBytes = safeAdd(
      referenceImageBytes,
      invocation.referenceImageBytes,
      CREATE_IMAGES_MAX_PROVIDER_INPUT_BYTES,
      "Reference image bytes",
    );
  }
  const initialProviderInputBytes = safeAdd(
    promptBytes,
    referenceImageBytes,
    CREATE_IMAGES_MAX_PROVIDER_INPUT_BYTES,
    "Provider input bytes",
  );
  const maximumAttempts = safeInteger(
    input.maximumAttempts,
    invocations.length,
    CREATE_IMAGES_MAX_PROVIDER_ATTEMPTS,
    "Maximum attempts",
  );
  if (input.executionMode === "gemini" && maximumAttempts !== invocations.length) {
    throw new CreateImagesProviderAdmissionError(
      "unsafe-accounting",
      "Paid Gemini consent authorizes exactly one initial attempt per request and no automatic retry.",
    );
  }
  if (input.executionMode === "local-mock" && maximumAttempts > invocations.length * 3) {
    throw new CreateImagesProviderAdmissionError(
      "unsafe-accounting",
      "Local mock attempts exceed the bounded retry policy.",
    );
  }
  const accounting = deepFreeze({
    initialRequestCount: invocations.length,
    expectedOutputCount,
    maximumAttempts,
    promptBytes,
    referenceImageCount,
    referenceImageBytes,
    initialProviderInputBytes,
    dataLeavesDevice: input.executionMode === "gemini",
    retryPolicy:
      input.executionMode === "gemini"
        ? ("manual-new-consent" as const)
        : ("bounded-local-automatic" as const),
  });
  const estimate = validateEstimate(input.estimate);
  if (
    (input.executionMode === "local-mock" &&
      (estimate.kind !== "mock" || estimate.amountMicros !== 0)) ||
    (input.executionMode === "gemini" && estimate.kind === "mock")
  ) {
    throw new CreateImagesProviderAdmissionError(
      "invalid-input",
      "Estimate kind does not match the execution mode.",
    );
  }
  const base = deepFreeze({
    version: CREATE_IMAGES_PROVIDER_EXECUTION_VERSION,
    authorizationId: input.authorizationId,
    workflowId: input.workflowId,
    workflowRevision: input.workflowRevision,
    executionMode: input.executionMode,
    capability,
    ...(input.credentialBinding ? { credentialBinding: input.credentialBinding } : {}),
    invocations: Object.freeze(invocations),
    accounting,
    estimate,
    createdAt,
    expiresAt,
  });
  const consentFingerprint = fingerprint(base);
  const mainPlan = deepFreeze({ ...base, consentFingerprint });
  const rendererPlan = deepFreeze({
    version: CREATE_IMAGES_PROVIDER_CONSENT_VERSION,
    authorizationId: mainPlan.authorizationId,
    workflowId: mainPlan.workflowId,
    workflowRevision: mainPlan.workflowRevision,
    executionMode: mainPlan.executionMode,
    providerId: capability.providerId,
    providerLabel: capability.providerId === "gemini" ? "Google Gemini" : "Aiden local mock",
    modelId: capability.model.id,
    modelLabel: capability.model.label,
    accounting,
    estimate,
    createdAt,
    expiresAt,
    consentFingerprint,
    ...(mainPlan.executionMode === "gemini"
      ? { token: consentToken(authority, consentFingerprint) }
      : {}),
  });
  return deepFreeze({ mainPlan, rendererPlan });
}

export function parseCreateImagesProviderConsentClaim(
  value: unknown,
): CreateImagesProviderConsentClaimV1 {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["version", "authorizationId", "consentFingerprint", "token", "reviewed"]) ||
    value.version !== CREATE_IMAGES_PROVIDER_CONSENT_VERSION ||
    typeof value.authorizationId !== "string" ||
    !OPAQUE_ID_PATTERN.test(value.authorizationId) ||
    typeof value.consentFingerprint !== "string" ||
    !FINGERPRINT_PATTERN.test(value.consentFingerprint) ||
    typeof value.token !== "string" ||
    !TOKEN_PATTERN.test(value.token) ||
    value.reviewed !== true
  ) {
    throw new CreateImagesProviderAdmissionError(
      "invalid-consent",
      "Remote execution consent is malformed or contains unsupported fields.",
    );
  }
  return deepFreeze({
    version: value.version,
    authorizationId: value.authorizationId,
    consentFingerprint: value.consentFingerprint,
    token: value.token,
    reviewed: true,
  });
}

function sameCredential(
  left: CreateImagesMainCredentialBindingV1,
  right: CreateImagesMainCredentialBindingV1,
): boolean {
  return (
    left.providerId === right.providerId &&
    left.recordId === right.recordId &&
    left.revision === right.revision &&
    left.authKind === right.authKind
  );
}

function assertPlanIntegrity(plan: CreateImagesProviderExecutionConsentPlanV1): void {
  const { consentFingerprint: _consentFingerprint, ...withoutFingerprint } = plan;
  const expected = fingerprint(executionPlanPayload(withoutFingerprint));
  if (expected !== plan.consentFingerprint) {
    throw new CreateImagesProviderAdmissionError(
      "forged-consent",
      "The main-owned consent plan fingerprint does not match its contents.",
    );
  }
}

export function admitCreateImagesProviderExecution(input: {
  mainPlan: CreateImagesProviderExecutionConsentPlanV1;
  claim?: unknown;
  authority: CreateImagesProviderConsentAuthority;
  currentCapability: CreateImagesProviderCapabilitySnapshotV1;
  currentCredential?: CreateImagesMainCredentialBindingV1;
  now: string;
}): CreateImagesProviderExecutionAuthorizationV1 {
  assertPlanIntegrity(input.mainPlan);
  const now = canonicalTimestamp(input.now, "Admission time");
  const nowMs = Date.parse(now);
  if (
    nowMs < Date.parse(input.mainPlan.createdAt) ||
    nowMs > Date.parse(input.mainPlan.expiresAt)
  ) {
    throw new CreateImagesProviderAdmissionError(
      "stale-consent",
      "The provider consent is not currently valid.",
    );
  }
  if (
    input.currentCapability.fingerprint !==
      fingerprint(capabilityPayload(input.currentCapability)) ||
    input.currentCapability.fingerprint !== input.mainPlan.capability.fingerprint ||
    input.currentCapability.catalogRevision !== input.mainPlan.capability.catalogRevision ||
    input.currentCapability.providerId !== input.mainPlan.capability.providerId ||
    input.currentCapability.model.id !== input.mainPlan.capability.model.id
  ) {
    throw new CreateImagesProviderAdmissionError(
      "capability-drift",
      "Provider capabilities changed after the user reviewed the run.",
    );
  }
  if (input.mainPlan.executionMode === "gemini") {
    const plannedCredential = input.mainPlan.credentialBinding;
    if (!plannedCredential || !input.currentCredential) {
      throw new CreateImagesProviderAdmissionError(
        "credential-required",
        "The reviewed Gemini credential is no longer connected.",
      );
    }
    if (!sameCredential(plannedCredential, input.currentCredential)) {
      throw new CreateImagesProviderAdmissionError(
        "credential-drift",
        "The main-owned Gemini credential changed after review.",
      );
    }
    const claim = parseCreateImagesProviderConsentClaim(input.claim);
    if (
      claim.authorizationId !== input.mainPlan.authorizationId ||
      claim.consentFingerprint !== input.mainPlan.consentFingerprint
    ) {
      throw new CreateImagesProviderAdmissionError(
        "forged-consent",
        "Consent identity does not match the main-owned plan.",
      );
    }
    const expectedToken = Buffer.from(
      consentToken(input.authority, input.mainPlan.consentFingerprint),
      "hex",
    );
    const actualToken = Buffer.from(claim.token, "hex");
    if (
      expectedToken.byteLength !== actualToken.byteLength ||
      !timingSafeEqual(expectedToken, actualToken)
    ) {
      throw new CreateImagesProviderAdmissionError(
        "forged-consent",
        "Consent token was not minted by this main process.",
      );
    }
  } else if (input.claim !== undefined || input.currentCredential !== undefined) {
    throw new CreateImagesProviderAdmissionError(
      "invalid-input",
      "Local mock admission cannot carry remote consent or credentials.",
    );
  }
  return deepFreeze({
    version: CREATE_IMAGES_PROVIDER_EXECUTION_VERSION,
    authorizationId: input.mainPlan.authorizationId,
    workflowId: input.mainPlan.workflowId,
    workflowRevision: input.mainPlan.workflowRevision,
    executionMode: input.mainPlan.executionMode,
    capability: input.mainPlan.capability,
    ...(input.mainPlan.credentialBinding
      ? { credentialBinding: input.mainPlan.credentialBinding }
      : {}),
    invocations: input.mainPlan.invocations,
    accounting: input.mainPlan.accounting,
    estimate: input.mainPlan.estimate,
    consentFingerprint: input.mainPlan.consentFingerprint,
    authorizedAt: now,
    expiresAt: input.mainPlan.expiresAt,
  });
}

export interface CreateImagesProviderGateConfig {
  providerId: string;
  maxConcurrency: number;
  maxStartsPerWindow: number;
  windowMs: number;
  minimumStartIntervalMs: number;
}

export interface CreateImagesProviderGateLease {
  providerId: string;
  leaseId: string;
  acquiredAtMs: number;
}

export type CreateImagesProviderGateDecision =
  | { status: "acquired"; lease: CreateImagesProviderGateLease }
  | {
      status: "deferred";
      reason: "concurrency" | "rate";
      retryAfterMs: number;
    };

interface ProviderGateState {
  config: CreateImagesProviderGateConfig;
  active: Map<string, CreateImagesProviderGateLease>;
  starts: number[];
  nextLease: number;
}

export class CreateImagesProviderAdmissionGate {
  readonly #states = new Map<string, ProviderGateState>();

  constructor(configs: readonly CreateImagesProviderGateConfig[]) {
    if (
      configs.length < 1 ||
      new Set(configs.map((config) => config.providerId)).size !== configs.length
    ) {
      throw new Error("Provider gate configuration requires unique providers.");
    }
    for (const config of configs) {
      if (!PROVIDER_ID_PATTERN.test(config.providerId))
        throw new Error("Invalid provider gate ID.");
      for (const [value, minimum, maximum, label] of [
        [config.maxConcurrency, 1, 4, "concurrency"],
        [config.maxStartsPerWindow, 1, 10_000, "window start count"],
        [config.windowMs, 1, 60 * 60_000, "window"],
        [config.minimumStartIntervalMs, 0, 60 * 60_000, "start interval"],
      ] as const) {
        if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
          throw new Error(`Invalid provider gate ${label}.`);
        }
      }
      this.#states.set(config.providerId, {
        config: Object.freeze({ ...config }),
        active: new Map(),
        starts: [],
        nextLease: 1,
      });
    }
  }

  tryAcquire(providerId: string, nowMs: number): CreateImagesProviderGateDecision {
    if (!Number.isSafeInteger(nowMs) || nowMs < 0)
      throw new Error("Provider gate time is invalid.");
    const state = this.#states.get(providerId);
    if (!state) throw new Error("Provider gate is not configured for this provider.");
    state.starts = state.starts.filter((startedAt) => startedAt > nowMs - state.config.windowMs);
    if (state.active.size >= state.config.maxConcurrency) {
      return { status: "deferred", reason: "concurrency", retryAfterMs: 0 };
    }
    const lastStart = state.starts[state.starts.length - 1];
    if (lastStart !== undefined && nowMs - lastStart < state.config.minimumStartIntervalMs) {
      return {
        status: "deferred",
        reason: "rate",
        retryAfterMs: state.config.minimumStartIntervalMs - (nowMs - lastStart),
      };
    }
    if (state.starts.length >= state.config.maxStartsPerWindow) {
      return {
        status: "deferred",
        reason: "rate",
        retryAfterMs: Math.max(0, state.starts[0]! + state.config.windowMs - nowMs),
      };
    }
    const lease = Object.freeze({
      providerId,
      leaseId: `${providerId}:${state.nextLease}`,
      acquiredAtMs: nowMs,
    });
    state.nextLease += 1;
    state.active.set(lease.leaseId, lease);
    state.starts.push(nowMs);
    return { status: "acquired", lease };
  }

  release(lease: CreateImagesProviderGateLease): boolean {
    const state = this.#states.get(lease.providerId);
    if (!state) return false;
    const current = state.active.get(lease.leaseId);
    if (current !== lease) return false;
    state.active.delete(lease.leaseId);
    return true;
  }

  snapshot(providerId: string): Readonly<{ active: number; startsInWindow: number }> {
    const state = this.#states.get(providerId);
    if (!state) throw new Error("Provider gate is not configured for this provider.");
    return Object.freeze({ active: state.active.size, startsInWindow: state.starts.length });
  }
}

export type CreateImagesProviderBillingStatus =
  | "not-submitted"
  | "possibly-billable"
  | "provider-reported";

export interface CreateImagesProviderReportedUsageV1 {
  inputUnits?: number;
  outputUnits?: number;
  totalUnits?: number;
  billedRequestCount?: number;
  costMicros?: number;
  currency?: string;
}

export interface CreateImagesProviderUsageMetadataV1 {
  providerId: string;
  modelId: string;
  requestCount: 0 | 1;
  outputCount: number;
  billingStatus: CreateImagesProviderBillingStatus;
  reported?: CreateImagesProviderReportedUsageV1;
}

export type CreateImagesProviderAttemptStatus =
  | "ready"
  | "prepared"
  | "accepted"
  | "succeeded"
  | "failed"
  | "needs_attention"
  | "cancel_requested"
  | "cancelled";

export interface CreateImagesProviderAttemptProjectionV1 {
  version: typeof CREATE_IMAGES_PROVIDER_EXECUTION_VERSION;
  authorization: CreateImagesProviderExecutionAuthorizationV1;
  runId: string;
  nodeId: string;
  attempt: number;
  idempotencyKey: string;
  status: CreateImagesProviderAttemptStatus;
  submission: "not-prepared" | "prepared" | "accepted" | "confirmed-not-sent" | "unknown";
  providerJobId?: string;
  lastSequence: number;
  outputAssetIds: readonly string[];
  lateOutputAssetIds: readonly string[];
  usage: CreateImagesProviderUsageMetadataV1;
  errorCode?: string;
  cancellationReason?: "user" | "renderer-disconnected" | "app-quit";
}

interface CreateImagesProviderAttemptEventBase {
  authorizationId: string;
  runId: string;
  nodeId: string;
  attempt: number;
  sequence: number;
}

export type CreateImagesProviderAttemptEventV1 =
  | (CreateImagesProviderAttemptEventBase & { kind: "submission-prepared" })
  | (CreateImagesProviderAttemptEventBase & {
      kind: "submission-accepted";
      providerJobId: string;
      usage?: CreateImagesProviderReportedUsageV1;
    })
  | (CreateImagesProviderAttemptEventBase & {
      kind: "submission-confirmed-not-sent";
      errorCode: string;
    })
  | (CreateImagesProviderAttemptEventBase & {
      kind: "submission-unknown";
      errorCode: string;
    })
  | (CreateImagesProviderAttemptEventBase & {
      kind: "provider-failed";
      errorCode: string;
      usage?: CreateImagesProviderReportedUsageV1;
    })
  | (CreateImagesProviderAttemptEventBase & {
      kind: "output-published";
      outputAssetIds: readonly string[];
      usage?: CreateImagesProviderReportedUsageV1;
    })
  | (CreateImagesProviderAttemptEventBase & {
      kind: "cancellation-requested";
      reason: "user" | "renderer-disconnected" | "app-quit";
    })
  | (CreateImagesProviderAttemptEventBase & { kind: "cancelled" })
  | (CreateImagesProviderAttemptEventBase & {
      kind: "late-output-published";
      outputAssetIds: readonly string[];
      usage?: CreateImagesProviderReportedUsageV1;
    });

type CreateImagesProviderAttemptEventPayload =
  CreateImagesProviderAttemptEventV1 extends infer Event
    ? Event extends CreateImagesProviderAttemptEventV1
      ? Omit<Event, keyof CreateImagesProviderAttemptEventBase>
      : never
    : never;

export type CreateImagesProviderAttemptReduction =
  | { accepted: true; projection: CreateImagesProviderAttemptProjectionV1 }
  | {
      accepted: false;
      projection: CreateImagesProviderAttemptProjectionV1;
      reason:
        | "wrong-attempt"
        | "duplicate-or-stale"
        | "out-of-order"
        | "invalid-transition"
        | "output-mismatch"
        | "invalid-event";
    };

function invocationFor(
  authorization: CreateImagesProviderExecutionAuthorizationV1,
  nodeId: string,
): CreateImagesProviderInvocationFactsV1 | undefined {
  return authorization.invocations.find((invocation) => invocation.nodeId === nodeId);
}

function emptyUsage(
  authorization: CreateImagesProviderExecutionAuthorizationV1,
): CreateImagesProviderUsageMetadataV1 {
  return Object.freeze({
    providerId: authorization.capability.providerId,
    modelId: authorization.capability.model.id,
    requestCount: 0,
    outputCount: 0,
    billingStatus: "not-submitted",
  });
}

export function createCreateImagesProviderAttemptProjection(
  authorization: CreateImagesProviderExecutionAuthorizationV1,
  input: { runId: string; nodeId: string; attempt: number },
): CreateImagesProviderAttemptProjectionV1 {
  opaqueId(input.runId, "Run ID");
  opaqueId(input.nodeId, "Node ID");
  if (!invocationFor(authorization, input.nodeId)) {
    throw new CreateImagesProviderAdmissionError(
      "invalid-input",
      "The node was not included in the reviewed provider plan.",
    );
  }
  const maxAttempt = authorization.executionMode === "gemini" ? 1 : 3;
  safeInteger(input.attempt, 1, maxAttempt, "Provider attempt");
  const idempotencyKey = `aiden-ci-${createHash("sha256")
    .update(authorization.consentFingerprint)
    .update("\0")
    .update(input.runId)
    .update("\0")
    .update(input.nodeId)
    .update("\0")
    .update(String(input.attempt))
    .digest("hex")}`;
  return deepFreeze({
    version: CREATE_IMAGES_PROVIDER_EXECUTION_VERSION,
    authorization,
    runId: input.runId,
    nodeId: input.nodeId,
    attempt: input.attempt,
    idempotencyKey,
    status: "ready",
    submission: "not-prepared",
    lastSequence: 0,
    outputAssetIds: Object.freeze([]),
    lateOutputAssetIds: Object.freeze([]),
    usage: emptyUsage(authorization),
  });
}

function eventBase(
  projection: CreateImagesProviderAttemptProjectionV1,
): CreateImagesProviderAttemptEventBase {
  return {
    authorizationId: projection.authorization.authorizationId,
    runId: projection.runId,
    nodeId: projection.nodeId,
    attempt: projection.attempt,
    sequence: projection.lastSequence + 1,
  };
}

export function createCreateImagesProviderAttemptEvent<
  Event extends CreateImagesProviderAttemptEventPayload,
>(
  projection: CreateImagesProviderAttemptProjectionV1,
  event: Event,
): CreateImagesProviderAttemptEventV1 {
  return deepFreeze({ ...eventBase(projection), ...event } as CreateImagesProviderAttemptEventV1);
}

function validUsage(
  value: CreateImagesProviderReportedUsageV1 | undefined,
): CreateImagesProviderReportedUsageV1 | undefined {
  if (!value) return undefined;
  const output: CreateImagesProviderReportedUsageV1 = {};
  for (const key of [
    "inputUnits",
    "outputUnits",
    "totalUnits",
    "billedRequestCount",
    "costMicros",
  ] as const) {
    const candidate = value[key];
    if (candidate !== undefined) {
      const maximum = key === "costMicros" ? Number.MAX_SAFE_INTEGER : MAX_PROVIDER_USAGE_UNITS;
      if (!Number.isSafeInteger(candidate) || candidate < 0 || candidate > maximum) {
        return undefined;
      }
      output[key] = candidate;
    }
  }
  if (output.billedRequestCount !== undefined && output.billedRequestCount > 1) return undefined;
  if (
    output.totalUnits !== undefined &&
    ((output.inputUnits !== undefined && output.totalUnits < output.inputUnits) ||
      (output.outputUnits !== undefined && output.totalUnits < output.outputUnits))
  ) {
    return undefined;
  }
  if (value.currency !== undefined) {
    if (!CURRENCY_PATTERN.test(value.currency)) return undefined;
    output.currency = value.currency;
  }
  if ((output.costMicros === undefined) !== (output.currency === undefined)) return undefined;
  return deepFreeze(output);
}

function usageMetadata(
  projection: CreateImagesProviderAttemptProjectionV1,
  requestCount: 0 | 1,
  outputCount: number,
  billingStatus: CreateImagesProviderBillingStatus,
  reported?: CreateImagesProviderReportedUsageV1,
): CreateImagesProviderUsageMetadataV1 | undefined {
  const validated = validUsage(reported);
  if (reported && !validated) return undefined;
  return deepFreeze({
    providerId: projection.authorization.capability.providerId,
    modelId: projection.authorization.capability.model.id,
    requestCount,
    outputCount,
    billingStatus: validated ? "provider-reported" : billingStatus,
    ...(validated ? { reported: validated } : {}),
  });
}

function validOutputAssetIds(
  projection: CreateImagesProviderAttemptProjectionV1,
  assetIds: readonly string[],
): boolean {
  const invocation = invocationFor(projection.authorization, projection.nodeId);
  return (
    invocation !== undefined &&
    Array.isArray(assetIds) &&
    assetIds.length === invocation.requestedOutputs &&
    assetIds.every((assetId) => CREATE_IMAGES_ASSET_ID_PATTERN.test(assetId))
  );
}

function terminalAttempt(status: CreateImagesProviderAttemptStatus): boolean {
  return ["succeeded", "failed", "needs_attention", "cancelled"].includes(status);
}

function rejected(
  projection: CreateImagesProviderAttemptProjectionV1,
  reason: Extract<CreateImagesProviderAttemptReduction, { accepted: false }>["reason"],
): CreateImagesProviderAttemptReduction {
  return { accepted: false, projection, reason };
}

export function reduceCreateImagesProviderAttemptEvent(
  projection: CreateImagesProviderAttemptProjectionV1,
  event: CreateImagesProviderAttemptEventV1,
): CreateImagesProviderAttemptReduction {
  if (
    event.authorizationId !== projection.authorization.authorizationId ||
    event.runId !== projection.runId ||
    event.nodeId !== projection.nodeId ||
    event.attempt !== projection.attempt
  ) {
    return rejected(projection, "wrong-attempt");
  }
  if (event.sequence <= projection.lastSequence) return rejected(projection, "duplicate-or-stale");
  if (event.sequence !== projection.lastSequence + 1) return rejected(projection, "out-of-order");
  const nextBase = { ...projection, lastSequence: event.sequence };
  if (
    terminalAttempt(projection.status) &&
    event.kind !== "late-output-published" &&
    !(projection.status === "needs_attention" && event.kind === "cancellation-requested")
  ) {
    return rejected(projection, "invalid-transition");
  }
  if (event.kind === "submission-prepared") {
    if (projection.status !== "ready" || projection.submission !== "not-prepared") {
      return rejected(projection, "invalid-transition");
    }
    return {
      accepted: true,
      projection: deepFreeze({ ...nextBase, status: "prepared", submission: "prepared" }),
    };
  }
  if (event.kind === "submission-accepted") {
    if (
      projection.status !== "prepared" ||
      projection.authorization.capability.transport.kind !== "asynchronous" ||
      !PROVIDER_JOB_ID_PATTERN.test(event.providerJobId)
    ) {
      return rejected(projection, "invalid-transition");
    }
    const usage = usageMetadata(projection, 1, 0, "possibly-billable", event.usage);
    if (!usage) return rejected(projection, "invalid-event");
    return {
      accepted: true,
      projection: deepFreeze({
        ...nextBase,
        status: "accepted",
        submission: "accepted",
        providerJobId: event.providerJobId,
        usage,
      }),
    };
  }
  if (event.kind === "submission-confirmed-not-sent") {
    if (projection.status !== "prepared" || !SAFE_ERROR_CODE_PATTERN.test(event.errorCode)) {
      return rejected(projection, "invalid-transition");
    }
    return {
      accepted: true,
      projection: deepFreeze({
        ...nextBase,
        status: "failed",
        submission: "confirmed-not-sent",
        usage: emptyUsage(projection.authorization),
        errorCode: event.errorCode,
      }),
    };
  }
  if (event.kind === "submission-unknown") {
    if (
      !["prepared", "accepted"].includes(projection.status) ||
      !SAFE_ERROR_CODE_PATTERN.test(event.errorCode)
    ) {
      return rejected(projection, "invalid-transition");
    }
    const usage = usageMetadata(projection, 1, 0, "possibly-billable");
    return {
      accepted: true,
      projection: deepFreeze({
        ...nextBase,
        status: "needs_attention",
        submission: "unknown",
        usage: usage!,
        errorCode: event.errorCode,
      }),
    };
  }
  if (event.kind === "provider-failed") {
    if (
      !["prepared", "accepted"].includes(projection.status) ||
      !SAFE_ERROR_CODE_PATTERN.test(event.errorCode)
    ) {
      return rejected(projection, "invalid-transition");
    }
    const usage = usageMetadata(projection, 1, 0, "possibly-billable", event.usage);
    if (!usage) return rejected(projection, "invalid-event");
    return {
      accepted: true,
      projection: deepFreeze({
        ...nextBase,
        status: "failed",
        usage,
        errorCode: event.errorCode,
      }),
    };
  }
  if (event.kind === "output-published") {
    if (
      !["prepared", "accepted"].includes(projection.status) ||
      !validOutputAssetIds(projection, event.outputAssetIds)
    ) {
      return rejected(projection, "output-mismatch");
    }
    const usage = usageMetadata(
      projection,
      1,
      event.outputAssetIds.length,
      "possibly-billable",
      event.usage,
    );
    if (!usage) return rejected(projection, "invalid-event");
    return {
      accepted: true,
      projection: deepFreeze({
        ...nextBase,
        status: "succeeded",
        outputAssetIds: Object.freeze([...event.outputAssetIds]),
        usage,
      }),
    };
  }
  if (event.kind === "cancellation-requested") {
    if (
      !["ready", "prepared", "accepted", "needs_attention"].includes(projection.status) ||
      !(["user", "renderer-disconnected", "app-quit"] as const).includes(event.reason)
    ) {
      return rejected(projection, "invalid-transition");
    }
    return {
      accepted: true,
      projection: deepFreeze({
        ...nextBase,
        status: "cancel_requested",
        cancellationReason: event.reason,
      }),
    };
  }
  if (event.kind === "cancelled") {
    if (projection.status !== "cancel_requested") {
      return rejected(projection, "invalid-transition");
    }
    return {
      accepted: true,
      projection: deepFreeze({ ...nextBase, status: "cancelled" }),
    };
  }
  if (
    !["cancel_requested", "cancelled", "needs_attention"].includes(projection.status) ||
    !validOutputAssetIds(projection, event.outputAssetIds)
  ) {
    return rejected(projection, "output-mismatch");
  }
  const usage = usageMetadata(
    projection,
    1,
    event.outputAssetIds.length,
    "possibly-billable",
    event.usage,
  );
  if (!usage) return rejected(projection, "invalid-event");
  return {
    accepted: true,
    projection: deepFreeze({
      ...nextBase,
      status: projection.status === "needs_attention" ? "needs_attention" : "cancelled",
      lateOutputAssetIds: Object.freeze([...event.outputAssetIds]),
      usage,
    }),
  };
}

export type CreateImagesProviderRecoveryDecision =
  | { action: "resume-before-prepare" }
  | { action: "reconcile-only"; providerJobId?: string }
  | { action: "cancel-only"; providerJobId: string }
  | { action: "finalize-cancel" }
  | { action: "needs-attention"; reason: "prepared-or-unknown" | "accepted-unreconcilable" }
  | { action: "none" };

/**
 * A prepared remote attempt is never a submission permit after restart. The
 * caller may resume only before the durable prepared boundary. Synchronous
 * Gemini has no job ID to reconcile, so prepared/unknown always needs review.
 */
export function decideCreateImagesProviderAttemptRecovery(
  projection: CreateImagesProviderAttemptProjectionV1,
): CreateImagesProviderRecoveryDecision {
  if (projection.status === "ready") return { action: "resume-before-prepare" };
  if (["succeeded", "failed", "cancelled"].includes(projection.status)) return { action: "none" };
  const transport = projection.authorization.capability.transport;
  if (projection.status === "cancel_requested") {
    if (
      projection.providerJobId &&
      projection.authorization.capability.model.supportsCancellation
    ) {
      return { action: "cancel-only", providerJobId: projection.providerJobId };
    }
    if (
      projection.submission === "not-prepared" ||
      projection.submission === "confirmed-not-sent"
    ) {
      return { action: "finalize-cancel" };
    }
    if (projection.providerJobId && transport.supportsReconciliation) {
      return { action: "reconcile-only", providerJobId: projection.providerJobId };
    }
    return { action: "needs-attention", reason: "prepared-or-unknown" };
  }
  if (projection.status === "accepted") {
    return projection.providerJobId && transport.supportsReconciliation
      ? { action: "reconcile-only", providerJobId: projection.providerJobId }
      : { action: "needs-attention", reason: "accepted-unreconcilable" };
  }
  if (projection.status === "prepared") {
    return transport.supportsIdempotency && transport.supportsReconciliation
      ? { action: "reconcile-only" }
      : { action: "needs-attention", reason: "prepared-or-unknown" };
  }
  return { action: "needs-attention", reason: "prepared-or-unknown" };
}

export interface CreateImagesResolvedMainCredential<TCredential> {
  binding: CreateImagesMainCredentialBindingV1;
  credential: TCredential;
}

export type CreateImagesProviderSubmitResult<TOutput> =
  | {
      kind: "completed";
      output: TOutput;
      outputCount: number;
      usage?: CreateImagesProviderReportedUsageV1;
    }
  | {
      kind: "accepted";
      providerJobId: string;
      usage?: CreateImagesProviderReportedUsageV1;
    }
  | {
      kind: "failed" | "rate-limited";
      errorCode: string;
      usage?: CreateImagesProviderReportedUsageV1;
    }
  | { kind: "confirmed-not-sent"; errorCode: string }
  | { kind: "unknown"; errorCode: string };

export type CreateImagesProviderSubmissionOutcome<TOutput> =
  | { kind: "deferred"; reason: "concurrency" | "rate"; retryAfterMs: number }
  | { kind: "not-admitted"; reason: "consent-expired" }
  | { kind: "recovery"; decision: CreateImagesProviderRecoveryDecision }
  | {
      kind: "cancelled-before-submit";
      events: readonly [CreateImagesProviderAttemptEventV1, CreateImagesProviderAttemptEventV1];
    }
  | {
      kind: "completed";
      output: TOutput;
      outputCount: number;
      usage?: CreateImagesProviderReportedUsageV1;
    }
  | {
      kind: "event";
      event: CreateImagesProviderAttemptEventV1;
      retry: "none" | "new-consent-required";
    };

export interface ExecuteCreateImagesProviderSubmissionOptions<TCredential, TOutput> {
  projection: CreateImagesProviderAttemptProjectionV1;
  gate: CreateImagesProviderAdmissionGate;
  nowMs: number;
  signal?: AbortSignal;
  persistPrepared(
    event: CreateImagesProviderAttemptEventV1,
  ): Promise<CreateImagesProviderAttemptProjectionV1>;
  resolveCredential?(
    binding: CreateImagesMainCredentialBindingV1,
  ): Promise<CreateImagesResolvedMainCredential<TCredential>>;
  submit(input: {
    credential?: TCredential;
    authorization: CreateImagesProviderExecutionAuthorizationV1;
    runId: string;
    nodeId: string;
    attempt: number;
    idempotencyKey: string;
    signal?: AbortSignal;
  }): Promise<CreateImagesProviderSubmitResult<TOutput>>;
}

function preparedProjectionMatches(
  before: CreateImagesProviderAttemptProjectionV1,
  after: CreateImagesProviderAttemptProjectionV1,
): boolean {
  return (
    after.authorization.authorizationId === before.authorization.authorizationId &&
    after.runId === before.runId &&
    after.nodeId === before.nodeId &&
    after.attempt === before.attempt &&
    after.idempotencyKey === before.idempotencyKey &&
    after.lastSequence === before.lastSequence + 1 &&
    after.status === "prepared" &&
    after.submission === "prepared"
  );
}

function cancellationEvents(
  prepared: CreateImagesProviderAttemptProjectionV1,
): readonly [CreateImagesProviderAttemptEventV1, CreateImagesProviderAttemptEventV1] {
  const requested = createCreateImagesProviderAttemptEvent(prepared, {
    kind: "cancellation-requested",
    reason: "user",
  });
  const requestedProjection = reduceCreateImagesProviderAttemptEvent(prepared, requested);
  if (!requestedProjection.accepted) throw new Error("Cancellation event could not be projected.");
  return Object.freeze([
    requested,
    createCreateImagesProviderAttemptEvent(requestedProjection.projection, { kind: "cancelled" }),
  ]);
}

/**
 * Executes at most one fresh provider submission. It journals `prepared`
 * before resolving the credential/entering the adapter, never retries paid
 * work, and treats every thrown post-call failure as an unknown submission.
 * Callers must ingest `completed.output` before creating output-published.
 */
export async function executeCreateImagesProviderSubmission<TCredential, TOutput>(
  options: ExecuteCreateImagesProviderSubmissionOptions<TCredential, TOutput>,
): Promise<CreateImagesProviderSubmissionOutcome<TOutput>> {
  const recovery = decideCreateImagesProviderAttemptRecovery(options.projection);
  if (recovery.action !== "resume-before-prepare") {
    return { kind: "recovery", decision: recovery };
  }
  if (Date.parse(options.projection.authorization.expiresAt) < options.nowMs) {
    return { kind: "not-admitted", reason: "consent-expired" };
  }
  if (options.signal?.aborted) {
    const requested = createCreateImagesProviderAttemptEvent(options.projection, {
      kind: "cancellation-requested",
      reason: "user",
    });
    const reduced = reduceCreateImagesProviderAttemptEvent(options.projection, requested);
    if (!reduced.accepted) throw new Error("Cancellation event could not be projected.");
    return {
      kind: "cancelled-before-submit",
      events: Object.freeze([
        requested,
        createCreateImagesProviderAttemptEvent(reduced.projection, { kind: "cancelled" }),
      ]),
    };
  }
  const gateDecision = options.gate.tryAcquire(
    options.projection.authorization.capability.providerId,
    options.nowMs,
  );
  if (gateDecision.status === "deferred") return { kind: "deferred", ...gateDecision };
  try {
    const preparedEvent = createCreateImagesProviderAttemptEvent(options.projection, {
      kind: "submission-prepared",
    });
    const prepared = await options.persistPrepared(preparedEvent);
    if (!preparedProjectionMatches(options.projection, prepared)) {
      throw new Error("The durable prepared projection does not match the authorized attempt.");
    }
    if (options.signal?.aborted) {
      return { kind: "cancelled-before-submit", events: cancellationEvents(prepared) };
    }
    let credential: TCredential | undefined;
    if (prepared.authorization.executionMode === "gemini") {
      const binding = prepared.authorization.credentialBinding;
      if (!binding || !options.resolveCredential) {
        return {
          kind: "event",
          event: createCreateImagesProviderAttemptEvent(prepared, {
            kind: "submission-confirmed-not-sent",
            errorCode: "credential-unavailable",
          }),
          retry: "new-consent-required",
        };
      }
      let resolved: CreateImagesResolvedMainCredential<TCredential>;
      try {
        resolved = await options.resolveCredential(binding);
      } catch {
        return {
          kind: "event",
          event: createCreateImagesProviderAttemptEvent(prepared, {
            kind: "submission-confirmed-not-sent",
            errorCode: "credential-unavailable",
          }),
          retry: "new-consent-required",
        };
      }
      if (!sameCredential(binding, resolved.binding)) {
        return {
          kind: "event",
          event: createCreateImagesProviderAttemptEvent(prepared, {
            kind: "submission-confirmed-not-sent",
            errorCode: "credential-drift",
          }),
          retry: "new-consent-required",
        };
      }
      credential = resolved.credential;
    }
    if (options.signal?.aborted) {
      return { kind: "cancelled-before-submit", events: cancellationEvents(prepared) };
    }
    let result: CreateImagesProviderSubmitResult<TOutput>;
    try {
      result = await options.submit({
        ...(credential === undefined ? {} : { credential }),
        authorization: prepared.authorization,
        runId: prepared.runId,
        nodeId: prepared.nodeId,
        attempt: prepared.attempt,
        idempotencyKey: prepared.idempotencyKey,
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch {
      return {
        kind: "event",
        event: createCreateImagesProviderAttemptEvent(prepared, {
          kind: "submission-unknown",
          errorCode: "transport-unknown",
        }),
        retry: "none",
      };
    }
    if (result.kind === "completed") {
      const invocation = invocationFor(prepared.authorization, prepared.nodeId)!;
      if (
        result.outputCount !== invocation.requestedOutputs ||
        (result.usage !== undefined && !validUsage(result.usage))
      ) {
        return {
          kind: "event",
          event: createCreateImagesProviderAttemptEvent(prepared, {
            kind: "submission-unknown",
            errorCode: "provider-output-mismatch",
          }),
          retry: "none",
        };
      }
      if (options.signal?.aborted) {
        return {
          kind: "event",
          event: createCreateImagesProviderAttemptEvent(prepared, {
            kind: "submission-unknown",
            errorCode: "cancelled-after-send",
          }),
          retry: "none",
        };
      }
      return {
        kind: "completed",
        output: result.output,
        outputCount: result.outputCount,
        ...(result.usage ? { usage: validUsage(result.usage)! } : {}),
      };
    }
    if (result.kind === "accepted") {
      if (
        prepared.authorization.capability.transport.kind !== "asynchronous" ||
        !PROVIDER_JOB_ID_PATTERN.test(result.providerJobId) ||
        (result.usage !== undefined && !validUsage(result.usage))
      ) {
        return {
          kind: "event",
          event: createCreateImagesProviderAttemptEvent(prepared, {
            kind: "submission-unknown",
            errorCode: "provider-contract-mismatch",
          }),
          retry: "none",
        };
      }
      return {
        kind: "event",
        event: createCreateImagesProviderAttemptEvent(prepared, {
          kind: "submission-accepted",
          providerJobId: result.providerJobId,
          ...(result.usage ? { usage: validUsage(result.usage)! } : {}),
        }),
        retry: "none",
      };
    }
    if (result.kind === "confirmed-not-sent") {
      return {
        kind: "event",
        event: createCreateImagesProviderAttemptEvent(prepared, {
          kind: "submission-confirmed-not-sent",
          errorCode: SAFE_ERROR_CODE_PATTERN.test(result.errorCode)
            ? result.errorCode
            : "provider-error",
        }),
        retry: "new-consent-required",
      };
    }
    if (result.kind === "unknown") {
      return {
        kind: "event",
        event: createCreateImagesProviderAttemptEvent(prepared, {
          kind: "submission-unknown",
          errorCode: SAFE_ERROR_CODE_PATTERN.test(result.errorCode)
            ? result.errorCode
            : "provider-error",
        }),
        retry: "none",
      };
    }
    if (result.usage !== undefined && !validUsage(result.usage)) {
      return {
        kind: "event",
        event: createCreateImagesProviderAttemptEvent(prepared, {
          kind: "submission-unknown",
          errorCode: "provider-contract-mismatch",
        }),
        retry: "none",
      };
    }
    return {
      kind: "event",
      event: createCreateImagesProviderAttemptEvent(prepared, {
        kind: "provider-failed",
        errorCode: SAFE_ERROR_CODE_PATTERN.test(result.errorCode)
          ? result.errorCode
          : "provider-error",
        ...(result.usage ? { usage: validUsage(result.usage)! } : {}),
      }),
      retry: "new-consent-required",
    };
  } finally {
    options.gate.release(gateDecision.lease);
  }
}
