import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import type { AuthResult } from "@earendil-works/pi-ai";
import { CREATE_IMAGES_NODE_DEFINITIONS } from "../../../renderer/shared/create-images/ports.js";
import {
  hasUnresolvedCreateImagesRunAmbiguity,
  projectCreateImagesRun,
  type CreateImagesCancellationReason,
  type CreateImagesRunEventV1,
  type CreateImagesRunJournalV1,
  type CreateImagesRunProviderAuthorizationV1,
} from "../../../renderer/shared/create-images/run-contract.js";
import type {
  CreateImagesDegradedRunDiscardPlanResult,
  CreateImagesDegradedRunDiscardResult,
  CreateImagesDiscardDegradedRunRequest,
  CreateImagesRunDetailResult,
  CreateImagesRunAmbiguityResolutionResult,
  CreateImagesRunListResult,
  CreateImagesRunHistoryPrunePlanResult,
  CreateImagesRunHistoryPruneResult,
  CreateImagesRunMutationResult,
  CreateImagesPrepareRunResult,
  CreateImagesProviderConsentPlanView,
  CreateImagesRunRecoveryMutationResult,
  CreateImagesRunRecoveryRequiredView,
  CreateImagesRunRecoveryView,
  CreateImagesRunUnsafeRecoveryView,
  CreateImagesRunView,
  CreateImagesResolveRunAmbiguityRequest,
  CreateImagesTerminalRunView,
} from "../../../renderer/shared/create-images/ipc.js";
import type { WorkflowRunScope } from "../../../renderer/shared/create-images/execution.js";
import { CREATE_IMAGES_LOCAL_MOCK_RETRY_POLICY } from "../../../renderer/shared/create-images/retry-policy.js";
import type { WorkflowNodeV1 } from "../../../renderer/shared/create-images/schema.js";
import type { ContentAddressedAssetStore } from "./asset-store-core.js";
import {
  admitCreateImagesProviderExecution,
  createCreateImagesMainCredentialBinding,
  createCreateImagesProviderCapabilitySnapshot,
  CreateImagesProviderAdmissionError,
  CreateImagesProviderAdmissionGate,
  prepareCreateImagesProviderExecutionConsent,
  type CreateImagesMainCredentialBindingV1,
  type CreateImagesProviderConsentAuthority,
  type CreateImagesProviderConsentClaimV1,
  type CreateImagesProviderExecutionConsentPlanV1,
  type CreateImagesProviderInvocationFactsV1,
} from "./image-provider-execution-core.js";
import type {
  ImageGenerationReference,
  ValidatedImageGenerationRequest,
} from "./provider-contract.js";
import {
  GeminiImageProvider,
  type GeminiImageProviderErrorCode,
  type GeminiImageProviderOutput,
} from "./providers/gemini-image-provider-core.js";
import {
  DeterministicMockImageProvider,
  MockProviderEventCoordinator,
  type MockImageOutputBatch,
  type MockImageProviderScript,
} from "./mock-image-provider-core.js";
import {
  CoordinatorCancellationRequest,
  createWorkflowCoordinatorPlan,
  reconcileRestartNode,
  runWorkflowCoordinator,
  type CoordinatorClock,
  type CoordinatorErrorCode,
  type CoordinatorDurability,
  type CoordinatorNodeExecutionContext,
} from "./scheduler-core.js";
import {
  CreateImagesRunJournalLoadError,
  CreateImagesRunJournalRevisionConflictError,
  CreateImagesRunJournalStore,
  type CreateImagesRunJournalHealth,
  type CreateImagesRunStartInput,
  type CreateImagesWorkflowAdmissionAudit,
} from "./run-journal-store.js";
import type { WorkflowManifestStore } from "./workflow-manifest-store.js";
import type { CreateImagesWorkspaceState } from "./workspace-store.js";

interface DurableNodeOutput {
  kind: "images" | "text";
  assetIds: string[];
  text?: string;
}

type CreateImagesRunExecution = { mode: "local-mock" } | { mode: "gemini"; auth: AuthResult };

export interface CreateImagesRunReferenceReservation {
  runId: string;
  next: ReadonlySet<string>;
  active: boolean;
}

export interface CreateImagesRunReferenceAuthority {
  reserveRun(
    runId: string,
    assetIds: readonly string[],
  ): Promise<CreateImagesRunReferenceReservation>;
  commitRun(reservation: CreateImagesRunReferenceReservation): Promise<void>;
  releaseRunReservations(runId: string): Promise<void>;
  reconcileRuns(store: CreateImagesRunJournalStore): Promise<boolean>;
  isRunAssetReferenced(runId: string, assetId: string): boolean;
}

interface ActiveRun {
  runId: string;
  workflowId: string;
  journal: CreateImagesRunJournalV1;
  execution: CreateImagesRunExecution;
  controller: AbortController;
  mutationTail: Promise<void>;
  publicationTail: Promise<void>;
  publishedOutputs: Map<string, DurableNodeOutput>;
  reservations: Map<string, CreateImagesRunReferenceReservation>;
  cancelDurable: Promise<void>;
  resolveCancelDurable(): void;
  cancellationRequest?: Promise<void>;
  needsReconciliation?: boolean;
  reconciliationAttempt?: Promise<void>;
  ownershipReleaseAttempt?: Promise<boolean>;
  settled: Promise<void>;
}

export type CreateImagesRunStopAllResult =
  | { status: "safe-to-quit"; unsettledRunIds: string[] }
  | { status: "blocked"; failedRunIds: string[] };

export type CreateImagesWorkflowDeletionDecision =
  | { status: "allowed" }
  | { status: "not-found" }
  | { status: "unavailable"; message: string };

export function evaluateCreateImagesWorkflowDeletion(
  snapshot: CreateImagesRunListResult,
): CreateImagesWorkflowDeletionDecision {
  if (snapshot.status === "not-found") return { status: "not-found" };
  if (snapshot.status !== "ready" || snapshot.authoritative !== true) {
    return {
      status: "unavailable",
      message: "Run history could not be verified safely. No workflow was deleted.",
    };
  }
  if (snapshot.activeRun) {
    return {
      status: "unavailable",
      message: "Stop the active image run before deleting this workflow.",
    };
  }
  if (snapshot.recoveries.length > 0) {
    return {
      status: "unavailable",
      message:
        "This workflow has retained run recovery records. Resolve or retain them; workflow deletion is unavailable while those records remain.",
    };
  }
  if (snapshot.latestTerminalRun || snapshot.history.length > 0) {
    return {
      status: "unavailable",
      message:
        "This workflow has retained run history. Workflow deletion is unavailable while those records remain; Aiden will not remove them implicitly.",
    };
  }
  return { status: "allowed" };
}

export interface CreateImagesRunServiceOptions {
  rootResolver: () => string;
  workflows: WorkflowManifestStore;
  assets: ContentAddressedAssetStore;
  references: CreateImagesRunReferenceAuthority;
  journalStore?: CreateImagesRunJournalStore;
  now?: () => number;
  createRunId?: () => string;
  mockScript?: (nodeIds: readonly string[]) => MockImageProviderScript;
  resolveGeminiAuth?: () => Promise<AuthResult>;
  createGeminiProvider?: () => GeminiImageProvider;
  /** Fast root/config check before a run can start provider work. */
  workspaceStatus?: () => Promise<{ configured: boolean; state: CreateImagesWorkspaceState }>;
  workspaceRequired?: boolean;
  shutdownTimeoutMs?: number;
}

export interface CreateImagesRunStartRequest {
  workflowId: string;
  expectedRevision: number;
  scope: WorkflowRunScope;
  executionMode?: "local-mock" | "gemini";
  providerConsent?: CreateImagesProviderConsentClaimV1;
}

export interface CreateImagesPrepareGeminiRunRequest {
  workflowId: string;
  expectedRevision: number;
  scope: WorkflowRunScope;
}

interface PendingGeminiConsent {
  mainPlan: CreateImagesProviderExecutionConsentPlanV1;
  scope: WorkflowRunScope;
}

const TERMINAL_RUN_STATUSES = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
  "needs_attention",
]);
export const CREATE_IMAGES_MAX_ACTIVE_RUNS = 4;
const CREATE_IMAGES_MAX_CACHED_WORKFLOW_HISTORIES = 64;
const CREATE_IMAGES_GEMINI_RETRY_POLICY = Object.freeze({
  maxRetriesPerNode: 0,
  baseDelayMs: 0,
  maxDelayMs: 0,
  maxTotalDelayMs: 0,
  jitterRatio: 0,
  retryRemoteNotSubmitted: false,
  retryRemoteIdempotent: false,
});
const CREATE_IMAGES_GEMINI_CATALOG_REVISION = 1;
const CREATE_IMAGES_GEMINI_CATALOG_OBSERVED_AT = "2026-08-11T00:00:00.000Z";
const CREATE_IMAGES_GEMINI_CONSENT_LIFETIME_MS = 15 * 60_000;
const CREATE_IMAGES_MAX_PENDING_GEMINI_CONSENTS = 32;
const CREATE_IMAGES_GEMINI_ESTIMATE_SOURCE_FINGERPRINT = createHash("sha256")
  .update("google-gemini-interactions-pricing-unavailable-2026-08-11")
  .digest("hex");

function realClock(now: () => number): CoordinatorClock {
  return {
    now,
    sleep(delayMs, signal) {
      if (signal.aborted) return Promise.reject(signal.reason);
      return new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(finish, delayMs);
        const abort = () => {
          clearTimeout(timeout);
          signal.removeEventListener("abort", abort);
          reject(signal.reason);
        };
        function finish(): void {
          signal.removeEventListener("abort", abort);
          resolve();
        }
        signal.addEventListener("abort", abort, { once: true });
      });
    },
  };
}

function defaultMockScript(nodeIds: readonly string[]): MockImageProviderScript {
  return {
    nodes: Object.fromEntries(
      nodeIds.map((nodeId, index) => [
        nodeId,
        [
          {
            outcome: "success" as const,
            delayMs: 450 + (index % 3) * 150,
            seed: index + 1,
            width: 96,
            height: 96,
          },
        ],
      ]),
    ),
  };
}

function isDurableNodeOutput(value: unknown): value is DurableNodeOutput {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as DurableNodeOutput).kind !== undefined &&
    Array.isArray((value as DurableNodeOutput).assetIds)
  );
}

type ProviderImageOutputBatch = MockImageOutputBatch | GeminiImageProviderOutput;

function geminiCoordinatorErrorCode(code: GeminiImageProviderErrorCode): CoordinatorErrorCode {
  if (code === "refused") return "provider-refused";
  if (
    code === "response-too-large" ||
    code === "response-malformed" ||
    code === "response-mime-mismatch" ||
    code === "incomplete"
  ) {
    return "output-invalid";
  }
  return code === "rate-limited" ? "rate-limited" : "provider-unavailable";
}

function isProviderImageOutputBatch(value: unknown): value is ProviderImageOutputBatch {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as ProviderImageOutputBatch).images) &&
    (value as ProviderImageOutputBatch).images.length > 0 &&
    (value as ProviderImageOutputBatch).images.every(
      (image) => image?.bytes instanceof Uint8Array && typeof image.metadata === "object",
    )
  );
}

function assetIdsFrom(value: unknown): string[] {
  return isDurableNodeOutput(value) ? [...value.assetIds] : [];
}

async function* bytesOf(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  yield bytes;
}

function iso(atMs: number): string {
  return new Date(atMs).toISOString();
}

function createEventBase(journal: CreateImagesRunJournalV1, atMs: number) {
  const durableAtMs = Date.parse(journal.updatedAt);
  return {
    workflowId: journal.workflowId,
    workflowRevision: journal.workflowRevision,
    runId: journal.runId,
    sequence: journal.events.length + 1,
    at: iso(Math.max(atMs, durableAtMs)),
  };
}

function runView(journal: CreateImagesRunJournalV1): CreateImagesRunView {
  const projection = projectCreateImagesRun(journal);
  const nodes = new Map(journal.workflowSnapshot.nodes.map((node) => [node.id, node]));
  return {
    runId: journal.runId,
    workflowId: journal.workflowId,
    workflowRevision: journal.workflowRevision,
    journalRevision: journal.journalRevision,
    status: projection.status,
    lastSequence: projection.lastSequence,
    scope: structuredClone(journal.plan.scope),
    createdAt: journal.createdAt,
    updatedAt: journal.updatedAt,
    executionMode: journal.providerAuthorization ? "gemini" : "local-mock",
    ...(projection.ambiguityResolution
      ? { ambiguityResolution: { ...projection.ambiguityResolution } }
      : {}),
    nodes: journal.plan.orderedNodeIds.map((nodeId) => {
      const node = nodes.get(nodeId);
      const projected = projection.nodes[nodeId]!;
      const attempt = projected.attempts[projected.attempts.length - 1];
      return {
        nodeId,
        label: `${node ? CREATE_IMAGES_NODE_DEFINITIONS[node.type].title : "Workflow node"} · ${nodeId}`,
        status: projected.status,
        attempt: attempt?.attempt ?? 0,
        outputAssetIds: [...projected.outputAssetIds],
        ...(projected.errorCode ? { errorCode: projected.errorCode } : {}),
        ...(attempt?.retry ? { retrySafety: attempt.retry.safety } : {}),
      };
    }),
  };
}

function terminalView(journal: CreateImagesRunJournalV1): CreateImagesTerminalRunView | undefined {
  const projection = projectCreateImagesRun(journal);
  if (!projection.terminal) return undefined;
  const providerNodeIds = new Set(
    journal.workflowSnapshot.nodes
      .filter((node) => node.type === "generate-image")
      .map((node) => node.id),
  );
  const outputCount = [...providerNodeIds].reduce(
    (total, nodeId) => total + (projection.nodes[nodeId]?.outputAssetIds.length ?? 0),
    0,
  );
  const geminiModelId = journal.workflowSnapshot.nodes.find(
    (node) => node.type === "generate-image",
  )?.data.modelId;
  const isGemini = journal.providerAuthorization !== undefined;
  return {
    runId: journal.runId,
    workflowRevision: journal.workflowRevision,
    status: projection.terminal.status,
    scope: structuredClone(journal.plan.scope),
    createdAt: journal.createdAt,
    updatedAt: journal.updatedAt,
    executionMode: isGemini ? "gemini" : "local-mock",
    providerLabel: isGemini ? "Google Gemini" : "Aiden local mock",
    modelLabel: isGemini ? (geminiModelId ?? "Gemini image model") : "Deterministic Phase 3",
    costLabel: isGemini ? "Provider cost not reported" : "$0.00 mock",
    ...(projection.ambiguityResolution
      ? { ambiguityResolution: { ...projection.ambiguityResolution } }
      : {}),
    requestCount: [...providerNodeIds].reduce(
      (total, nodeId) => total + (projection.nodes[nodeId]?.attempts.length ?? 0),
      0,
    ),
    outputCount,
    completedNodeCount: Object.values(projection.nodes).filter(
      (node) => node.status === "succeeded",
    ).length,
    totalNodeCount: journal.plan.orderedNodeIds.length,
  };
}

function recoveryRequiredView(
  health: Pick<
    Extract<CreateImagesRunJournalHealth, { status: "recovery-required" }>,
    | "workflowId"
    | "runId"
    | "reason"
    | "canRecover"
    | "currentJournalRevision"
    | "lastKnownGoodJournalRevision"
  > & { expectedJournalRevision?: number },
): CreateImagesRunRecoveryRequiredView | undefined {
  if (!health.workflowId) return undefined;
  const recoverySource =
    health.canRecover === "from-last-known-good"
      ? "last-known-good"
      : health.canRecover === "from-current"
        ? "current"
        : undefined;
  const expectedCandidateJournalRevision =
    health.expectedJournalRevision ??
    (recoverySource === "last-known-good"
      ? health.lastKnownGoodJournalRevision
      : recoverySource === "current"
        ? health.currentJournalRevision
        : undefined);
  return {
    status: "recovery-required",
    workflowId: health.workflowId,
    runId: health.runId,
    reason: health.reason,
    ...(recoverySource && expectedCandidateJournalRevision !== undefined
      ? { recoverySource, expectedCandidateJournalRevision }
      : {}),
    ...(health.currentJournalRevision === undefined
      ? {}
      : { currentJournalRevision: health.currentJournalRevision }),
    ...(health.lastKnownGoodJournalRevision === undefined
      ? {}
      : { lastKnownGoodJournalRevision: health.lastKnownGoodJournalRevision }),
  };
}

function unsafeRecoveryView(
  health: Pick<
    Extract<CreateImagesRunJournalHealth, { status: "unsafe" }>,
    "workflowId" | "runId" | "reason"
  >,
): CreateImagesRunUnsafeRecoveryView | undefined {
  if (!health.workflowId) return undefined;
  return {
    status: "unsafe",
    workflowId: health.workflowId,
    runId: health.runId,
    reason: health.reason,
  };
}

export class CreateImagesRunService {
  readonly journals: CreateImagesRunJournalStore;
  private readonly now: () => number;
  private readonly createRunId: () => string;
  private readonly mockScript: (nodeIds: readonly string[]) => MockImageProviderScript;
  private readonly shutdownTimeoutMs: number;
  private readonly activeByWorkflow = new Map<string, ActiveRun>();
  private readonly activeByRun = new Map<string, ActiveRun>();
  private startAdmissionTail: Promise<void> = Promise.resolve();
  private shutdownAdmissionBarrier = false;
  private readonly listeners = new Set<(workflowId: string) => void>();
  private readonly terminalCache = new Map<
    string,
    {
      history: CreateImagesTerminalRunView[];
      latestTerminalRun?: CreateImagesRunView;
    }
  >();
  private initializePromise: Promise<void> | undefined;
  private readonly providerConsentAuthority: CreateImagesProviderConsentAuthority = {
    secret: randomBytes(32),
  };
  private readonly pendingGeminiConsents = new Map<string, PendingGeminiConsent>();
  private readonly providerAdmissionGate = new CreateImagesProviderAdmissionGate([
    {
      providerId: "gemini",
      maxConcurrency: 2,
      maxStartsPerWindow: 500,
      windowMs: 60_000,
      minimumStartIntervalMs: 0,
    },
  ]);

  constructor(private readonly options: CreateImagesRunServiceOptions) {
    this.journals = options.journalStore ?? new CreateImagesRunJournalStore(options.rootResolver);
    this.now = options.now ?? Date.now;
    this.createRunId = options.createRunId ?? randomUUID;
    this.mockScript = options.mockScript ?? defaultMockScript;
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? 5_000;
    if (!Number.isSafeInteger(this.shutdownTimeoutMs) || this.shutdownTimeoutMs < 1) {
      throw new Error("Invalid Create Images shutdown timeout.");
    }
  }

  subscribe(listener: (workflowId: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(workflowId: string): void {
    for (const listener of this.listeners) {
      try {
        listener(workflowId);
      } catch {
        // Publication is already durable. Observers cannot roll it back.
      }
    }
  }

  private cacheTerminalHistory(
    workflowId: string,
    value: {
      history: CreateImagesTerminalRunView[];
      latestTerminalRun?: CreateImagesRunView;
    },
  ): void {
    this.terminalCache.delete(workflowId);
    this.terminalCache.set(workflowId, value);
    while (this.terminalCache.size > CREATE_IMAGES_MAX_CACHED_WORKFLOW_HISTORIES) {
      const oldest = this.terminalCache.keys().next().value as string | undefined;
      if (!oldest) break;
      this.terminalCache.delete(oldest);
    }
  }

  private async recoveryViewsForWorkflow(
    workflowId: string,
  ): Promise<CreateImagesRunRecoveryView[]> {
    const candidates = await this.journals.workflowDegradedCandidates(workflowId);
    return this.recoveryViews(candidates);
  }

  private recoveryViews(
    candidates: Awaited<ReturnType<CreateImagesRunJournalStore["workflowDegradedCandidates"]>>,
  ): CreateImagesRunRecoveryView[] {
    const recoveries: CreateImagesRunRecoveryView[] = [];
    for (const candidate of candidates) {
      const view =
        candidate.status === "unsafe"
          ? unsafeRecoveryView(candidate)
          : recoveryRequiredView(candidate);
      if (view) recoveries.push(view);
    }
    return recoveries;
  }

  async initialize(): Promise<void> {
    this.initializePromise ??= (async () => {
      await this.journals.initialize();
      await this.options.references.reconcileRuns(this.journals);
      for (const journal of await this.journals.reconciliationCandidates()) {
        const projection = projectCreateImagesRun(journal);
        if (projection.terminal) continue;
        await this.reconcileAfterRestart(journal);
      }
      await this.options.references.reconcileRuns(this.journals);
    })();
    try {
      await this.initializePromise;
    } catch (error) {
      this.initializePromise = undefined;
      throw error;
    }
  }

  private recoveryActive(journal: CreateImagesRunJournalV1): ActiveRun {
    let resolveCancelDurable: () => void = () => undefined;
    const cancelDurable = new Promise<void>((resolve) => {
      resolveCancelDurable = resolve;
    });
    return {
      runId: journal.runId,
      workflowId: journal.workflowId,
      journal,
      execution: { mode: "local-mock" },
      controller: new AbortController(),
      mutationTail: Promise.resolve(),
      publicationTail: Promise.resolve(),
      publishedOutputs: new Map(),
      reservations: new Map(),
      cancelDurable,
      resolveCancelDurable,
      settled: Promise.resolve(),
    };
  }

  private async reconcileAfterRestart(initial: CreateImagesRunJournalV1): Promise<void> {
    const active = this.recoveryActive(initial);
    const durability = this.durability(active);
    const nodes = new Map(initial.workflowSnapshot.nodes.map((node) => [node.id, node]));
    let provider: DeterministicMockImageProvider | undefined;
    const providerForAcceptedJob = (): DeterministicMockImageProvider => {
      provider ??= new DeterministicMockImageProvider({
        clock: realClock(this.now),
        script: this.mockScript(
          initial.workflowSnapshot.nodes
            .filter((node) => node.type === "generate-image")
            .map((node) => node.id),
        ),
      });
      return provider;
    };
    const appendNode = async (
      nodeId: string,
      status: "succeeded" | "failed" | "cancelled" | "blocked" | "ambiguous",
      attempt: number,
      errorCode?:
        | "execution-failed"
        | "interrupted"
        | "output-publication-failed"
        | "cancelled"
        | "submission-ambiguous",
    ): Promise<void> =>
      durability.appendEvent({
        workflowId: active.workflowId,
        workflowRevision: active.journal.workflowRevision,
        runId: active.runId,
        sequence: projectCreateImagesRun(active.journal).lastSequence + 1,
        atMs: Math.max(this.now(), Date.parse(active.journal.updatedAt)),
        kind: "node",
        nodeId,
        status,
        attempt,
        ...(errorCode ? { errorCode } : {}),
      });
    let recoveryInterrupted = false;

    for (const nodeId of initial.plan.orderedNodeIds) {
      let projection = projectCreateImagesRun(active.journal);
      const nodeRun = projection.nodes[nodeId];
      if (
        !nodeRun ||
        ["succeeded", "failed", "cancelled", "blocked", "ambiguous"].includes(nodeRun.status)
      ) {
        continue;
      }
      if (nodeRun.status === "queued") continue;
      const node = nodes.get(nodeId);
      const attempt = nodeRun.attempts[nodeRun.attempts.length - 1];
      if (nodeRun.durableOutputAssetIds !== undefined) {
        const decision = reconcileRestartNode({
          phase: "output-publishing",
          lane: node?.type === "generate-image" ? "remote" : "local",
          durableOutputAvailable: true,
        });
        if (decision.category !== "resume-output-publication") {
          throw new Error("Durable output publication did not produce a resumable decision.");
        }
        const uniqueAssetIds = [...new Set(nodeRun.durableOutputAssetIds)];
        const availability = await Promise.all(
          uniqueAssetIds.map((assetId) => this.options.assets.getAvailable(assetId)),
        );
        if (availability.some((asset) => asset === undefined)) {
          await appendNode(nodeId, "failed", attempt?.attempt ?? 0, "output-publication-failed");
          continue;
        }
        active.publishedOutputs.set(nodeId, {
          kind: node?.type === "prompt" ? "text" : "images",
          assetIds: [...nodeRun.durableOutputAssetIds],
        });
        await appendNode(nodeId, "succeeded", attempt?.attempt ?? 0);
        continue;
      }
      if (
        node?.type === "generate-image" &&
        attempt &&
        (attempt.submission === "prepared" || attempt.submission === "ambiguous")
      ) {
        const decision = reconcileRestartNode({
          phase: "remote-submitting",
          lane: "remote",
        });
        if (decision.category !== "ambiguous-submit") {
          throw new Error("Prepared submission did not produce an ambiguous restart decision.");
        }
        await appendNode(nodeId, "ambiguous", attempt.attempt, "submission-ambiguous");
        continue;
      }
      if (projection.cancellation) {
        const decision = reconcileRestartNode({
          phase: "cancel-requested",
          lane: node?.type === "generate-image" ? "remote" : "local",
          ...(attempt?.providerJobId ? { remoteJobId: attempt.providerJobId } : {}),
        });
        if (decision.category !== "reconcile-cancel" && decision.category !== "finalize-cancel") {
          throw new Error("Durable cancellation did not produce a cancellation restart decision.");
        }
        await appendNode(nodeId, "cancelled", attempt?.attempt ?? 0, "cancelled");
        continue;
      }
      if (node?.type !== "generate-image" || !attempt) {
        if (nodeRun.status === "running") {
          recoveryInterrupted = true;
          await appendNode(nodeId, "failed", attempt?.attempt ?? 0, "interrupted");
        }
        continue;
      }
      if (attempt.submission !== "accepted") {
        recoveryInterrupted = true;
        await appendNode(nodeId, "failed", attempt.attempt, "interrupted");
        continue;
      }
      if (active.journal.providerAuthorization) {
        await appendNode(nodeId, "ambiguous", attempt.attempt, "submission-ambiguous");
        continue;
      }
      const decision = reconcileRestartNode({
        phase: "remote-submitted",
        lane: "remote",
        ...(attempt.providerJobId ? { remoteJobId: attempt.providerJobId } : {}),
      });
      if (decision.category !== "reconcile-remote-job" || !decision.remoteJobId) {
        await appendNode(nodeId, "ambiguous", attempt.attempt, "submission-ambiguous");
        continue;
      }
      const result = providerForAcceptedJob().reconcileAccepted({
        runId: active.runId,
        node,
        attempt: attempt.attempt,
        idempotencyKey: attempt.idempotencyKey,
        remoteJobId: decision.remoteJobId,
      });
      if (result.kind === "success") {
        await durability.publishOutput({
          workflowId: active.workflowId,
          workflowRevision: active.journal.workflowRevision,
          runId: active.runId,
          nodeId,
          output: result.output,
        });
        await appendNode(nodeId, "succeeded", attempt.attempt);
      } else if (result.kind === "ambiguous-submit") {
        await appendNode(nodeId, "ambiguous", attempt.attempt, "submission-ambiguous");
      } else {
        await appendNode(nodeId, "failed", attempt.attempt, "execution-failed");
      }
    }

    let projection = projectCreateImagesRun(active.journal);
    for (const nodeId of active.journal.plan.orderedNodeIds) {
      const nodeRun = projection.nodes[nodeId];
      if (!nodeRun || nodeRun.status !== "queued") continue;
      const upstream = active.journal.plan.dependencies[nodeId] ?? [];
      if (
        upstream.some((dependency) =>
          ["failed", "cancelled", "blocked", "ambiguous"].includes(
            projection.nodes[dependency]?.status ?? "",
          ),
        )
      ) {
        await appendNode(nodeId, "blocked", 0);
        projection = projectCreateImagesRun(active.journal);
        continue;
      }
      if (projection.cancellation) {
        await appendNode(nodeId, "cancelled", 0, "cancelled");
      } else {
        recoveryInterrupted = true;
        await appendNode(nodeId, "failed", 0, "interrupted");
      }
      projection = projectCreateImagesRun(active.journal);
    }
    const finalProjection = projectCreateImagesRun(active.journal);
    const values = Object.values(finalProjection.nodes);
    const terminalStatus = values.some((node) => node.status === "ambiguous")
      ? "needs_attention"
      : finalProjection.cancellation
        ? "cancelled"
        : recoveryInterrupted
          ? "interrupted"
          : values.every((node) => node.status === "succeeded")
            ? "succeeded"
            : values.some((node) => node.status === "failed" || node.status === "blocked")
              ? "failed"
              : "interrupted";
    await this.mutateJournal(active, (journal) =>
      this.journals.append(journal.runId, journal.journalRevision, {
        ...createEventBase(journal, this.now()),
        type: "run-terminal",
        status: terminalStatus,
      }),
    );
    await active.publicationTail;
    await active.mutationTail;
    await this.options.references.releaseRunReservations(active.runId).catch(() => undefined);
    this.terminalCache.delete(active.workflowId);
    await this.options.references.reconcileRuns(this.journals);
    this.notify(active.workflowId);
  }

  private async releaseActiveOwnershipIfTerminalOrDegradedCore(
    active: ActiveRun,
  ): Promise<boolean> {
    let releasable = projectCreateImagesRun(active.journal).terminal !== undefined;
    if (!releasable) {
      try {
        const health = await this.journals.health(active.runId);
        if (health.status === "healthy") {
          const journal = await this.journals.get(active.runId);
          if (!journal) return false;
          active.journal = journal;
          releasable = projectCreateImagesRun(journal).terminal !== undefined;
        } else {
          releasable = health.status === "recovery-required" || health.status === "unsafe";
        }
      } catch {
        return false;
      }
    }
    if (!releasable) return false;

    await active.publicationTail;
    await active.mutationTail;
    await this.options.references.releaseRunReservations(active.runId).catch(() => undefined);
    await this.options.references.reconcileRuns(this.journals).catch(() => undefined);
    this.activeByRun.delete(active.runId);
    if (this.activeByWorkflow.get(active.workflowId) === active) {
      this.activeByWorkflow.delete(active.workflowId);
    }
    active.needsReconciliation = false;
    this.notify(active.workflowId);
    return true;
  }

  private async releaseActiveOwnershipIfTerminalOrDegraded(
    active: ActiveRun,
    deadline = Date.now() + this.shutdownTimeoutMs,
  ): Promise<boolean> {
    if (!active.ownershipReleaseAttempt) {
      const operation = this.releaseActiveOwnershipIfTerminalOrDegradedCore(active);
      const attempt = operation.finally(() => {
        if (active.ownershipReleaseAttempt === attempt) {
          active.ownershipReleaseAttempt = undefined;
        }
      });
      active.ownershipReleaseAttempt = attempt;
    }
    const attempt = active.ownershipReleaseAttempt;
    if (!(await this.waitUntilDeadline(attempt, deadline))) return false;
    return attempt.catch(() => false);
  }

  private async reconcileFailedLaunch(
    active: ActiveRun,
    deadline = Date.now() + this.shutdownTimeoutMs,
  ): Promise<boolean> {
    if (!active.needsReconciliation) return true;

    const joinedExistingAttempt = active.reconciliationAttempt !== undefined;
    if (!active.reconciliationAttempt) {
      const operation = (async () => {
        try {
          await active.publicationTail;
          await active.mutationTail;
          const health = await this.journals.health(active.runId);
          if (health.status === "healthy") {
            const journal = await this.journals.get(active.runId);
            if (journal) {
              active.journal = journal;
              if (!projectCreateImagesRun(journal).terminal) {
                await this.reconcileAfterRestart(journal);
              }
            }
          }
        } catch {
          // Keep ownership of healthy nonterminal work. A later list or
          // admission can join this single attempt, but never resubmits work.
        }
        await this.releaseActiveOwnershipIfTerminalOrDegraded(active);
      })();
      const attempt = operation.finally(() => {
        if (active.reconciliationAttempt === attempt) active.reconciliationAttempt = undefined;
      });
      active.reconciliationAttempt = attempt;
    }
    if (!(await this.waitUntilDeadline(active.reconciliationAttempt, deadline))) return false;
    // A foreground caller that merely joined an earlier failed attempt gets
    // one fresh reconciliation opportunity within the same deadline. The
    // recovery path never invokes the live executor or resubmits provider work.
    if (joinedExistingAttempt && active.needsReconciliation && !active.reconciliationAttempt) {
      return this.reconcileFailedLaunch(active, deadline);
    }
    return true;
  }

  private mutateJournal(
    active: ActiveRun,
    mutate: (journal: CreateImagesRunJournalV1) => Promise<CreateImagesRunJournalV1>,
  ): Promise<void> {
    const operation = active.mutationTail.then(async () => {
      active.journal = await mutate(active.journal);
      this.notify(active.workflowId);
    });
    active.mutationTail = operation.catch(() => undefined);
    return operation;
  }

  private durability(active: ActiveRun): CoordinatorDurability {
    const append = (create: (journal: CreateImagesRunJournalV1) => CreateImagesRunEventV1) =>
      this.mutateJournal(active, (journal) =>
        this.journals.append(journal.runId, journal.journalRevision, create(journal)),
      );
    return {
      persistPlan: async (record) => {
        if (
          record.runId !== active.runId ||
          record.workflowId !== active.workflowId ||
          record.workflowRevision !== active.journal.workflowRevision ||
          record.plan.workflowId !== active.journal.workflowId ||
          record.plan.workflowRevision !== active.journal.workflowRevision ||
          JSON.stringify(record.plan.scope) !== JSON.stringify(active.journal.plan.scope) ||
          JSON.stringify(record.plan.snapshot) !==
            JSON.stringify(active.journal.workflowSnapshot) ||
          JSON.stringify(record.plan.orderedNodeIds) !==
            JSON.stringify(active.journal.plan.orderedNodeIds) ||
          JSON.stringify(record.plan.dependencies) !==
            JSON.stringify(active.journal.plan.dependencies)
        ) {
          throw new Error("The coordinator plan does not match the durable run snapshot.");
        }
      },
      persistCancelIntent: async (intent) => {
        await this.mutateJournal(active, (journal) =>
          projectCreateImagesRun(journal).cancellation
            ? Promise.resolve(journal)
            : this.journals.requestCancellation(journal.runId, journal.journalRevision, {
                at: createEventBase(journal, this.now()).at,
                reason: intent.reason,
              }),
        );
        active.resolveCancelDurable();
      },
      persistSubmissionPrepared: (record) => {
        const node = active.journal.workflowSnapshot.nodes.find(
          (candidate) => candidate.id === record.nodeId,
        );
        if (active.execution.mode === "gemini" && node?.type !== "generate-image") {
          throw new Error("Gemini submission preparation requires a generation node.");
        }
        const modelId =
          active.execution.mode === "gemini" && node?.type === "generate-image"
            ? node.data.modelId
            : "deterministic-v1";
        if (!modelId) throw new Error("Gemini submission preparation requires a curated model.");
        return append((journal) => ({
          ...createEventBase(journal, this.now()),
          type: "node-submission-prepared",
          nodeId: record.nodeId,
          attempt: record.attempt,
          idempotencyKey: record.idempotencyKey,
          providerId: active.execution.mode === "gemini" ? "gemini" : "local-mock",
          modelId,
        }));
      },
      persistRemoteJob: (record) =>
        append((journal) => ({
          ...createEventBase(journal, this.now()),
          type: "node-submission-accepted",
          nodeId: record.nodeId,
          attempt: record.attempt,
          providerJobId: record.remoteJobId,
        })),
      publishOutput: async (record) => {
        const durable = await this.publishNodeOutput(active, record.nodeId, record.output);
        active.publishedOutputs.set(record.nodeId, durable);
        await append((journal) => ({
          ...createEventBase(journal, this.now()),
          type: "node-output-published",
          nodeId: record.nodeId,
          outputAssetIds: [...durable.assetIds],
        }));
        return durable;
      },
      appendEvent: async (event) => {
        if (event.kind === "remote-job" || (event.kind === "node" && event.status === "queued")) {
          return;
        }
        if (event.kind === "run") {
          if (event.status !== "running") this.terminalCache.delete(active.workflowId);
          await append(
            (journal) =>
              ({
                ...createEventBase(journal, event.atMs),
                type: event.status === "running" ? "run-started" : "run-terminal",
                ...(event.status === "running" ? {} : { status: event.status }),
              }) as CreateImagesRunEventV1,
          );
          return;
        }
        if (event.status === "running") {
          if (event.attempt === 1) {
            await append((journal) => ({
              ...createEventBase(journal, event.atMs),
              type: "node-started",
              nodeId: event.nodeId,
            }));
          }
          return;
        }
        if (event.status === "retry_wait") {
          const safety = event.retrySafety;
          if (safety !== "confirmed-not-submitted" && safety !== "same-idempotency-key") {
            throw new Error("Remote retries require a durable safety classification.");
          }
          await append((journal) => ({
            ...createEventBase(journal, event.atMs),
            type: "node-retry-scheduled",
            nodeId: event.nodeId,
            attempt: event.attempt,
            errorCode: event.errorCode ?? "execution-failed",
            delayMs: event.retryDelayMs ?? 0,
            retrySafety: safety,
          }));
          return;
        }
        if (event.status === "ambiguous") {
          const projection = projectCreateImagesRun(active.journal);
          const attempts = projection.nodes[event.nodeId]?.attempts ?? [];
          const attempt = attempts[attempts.length - 1];
          if (attempt?.submission === "prepared") {
            await append((journal) => ({
              ...createEventBase(journal, event.atMs),
              type: "node-submission-ambiguous",
              nodeId: event.nodeId,
              attempt: event.attempt,
            }));
          }
          await append((journal) => ({
            ...createEventBase(journal, event.atMs),
            type: "node-ambiguous",
            nodeId: event.nodeId,
            attempt: event.attempt,
          }));
          return;
        }
        if (event.status === "succeeded") {
          const output = active.publishedOutputs.get(event.nodeId);
          if (!output) {
            throw new Error("A node cannot succeed before its output is durably published.");
          }
          await append((journal) => ({
            ...createEventBase(journal, event.atMs),
            type: "node-succeeded",
            nodeId: event.nodeId,
            outputAssetIds: [...output.assetIds],
          }));
          const reservation = active.reservations.get(event.nodeId);
          if (reservation) {
            try {
              await this.options.references.commitRun(reservation);
            } catch (error) {
              if (!(await this.options.references.reconcileRuns(this.journals))) throw error;
            }
            active.reservations.delete(event.nodeId);
            await this.options.assets
              .replaceReferences({ kind: "run", id: active.runId }, [...reservation.next].sort())
              .catch(() => undefined);
          }
          return;
        }
        if (event.status === "failed") {
          await append((journal) => ({
            ...createEventBase(journal, event.atMs),
            type: "node-failed",
            nodeId: event.nodeId,
            errorCode: event.errorCode ?? "execution-failed",
          }));
          return;
        }
        if (event.status === "cancelled") {
          await append((journal) => ({
            ...createEventBase(journal, event.atMs),
            type: "node-cancelled",
            nodeId: event.nodeId,
          }));
          return;
        }
        const projection = projectCreateImagesRun(active.journal);
        const upstreamNodeIds = (active.journal.plan.dependencies[event.nodeId] ?? []).filter(
          (nodeId) =>
            ["failed", "cancelled", "blocked", "ambiguous"].includes(
              projection.nodes[nodeId]?.status ?? "",
            ),
        );
        await append((journal) => ({
          ...createEventBase(journal, event.atMs),
          type: "node-blocked",
          nodeId: event.nodeId,
          upstreamNodeIds,
        }));
      },
    };
  }

  private async publishNodeOutput(
    active: ActiveRun,
    nodeId: string,
    output: unknown,
  ): Promise<DurableNodeOutput> {
    const operation = active.publicationTail.then(() =>
      this.publishNodeOutputInternal(active, nodeId, output),
    );
    active.publicationTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private cumulativeRunAssetIds(active: ActiveRun, nextAssetIds: readonly string[]): string[] {
    const cumulative = new Set(nextAssetIds);
    for (const published of active.publishedOutputs.values()) {
      for (const assetId of published.assetIds) cumulative.add(assetId);
    }
    return [...cumulative].sort();
  }

  private async publishNodeOutputInternal(
    active: ActiveRun,
    nodeId: string,
    output: unknown,
  ): Promise<DurableNodeOutput> {
    if (isDurableNodeOutput(output)) {
      if (output.assetIds.length === 0) {
        return { ...output, assetIds: [] };
      }
      const reservation = await this.options.references.reserveRun(
        active.runId,
        this.cumulativeRunAssetIds(active, output.assetIds),
      );
      active.reservations.set(nodeId, reservation);
      return { ...output, assetIds: [...output.assetIds] };
    }
    if (!isProviderImageOutputBatch(output)) {
      throw new Error("The node executor returned an unsupported output.");
    }
    const batch = output;
    const remoteMetadata =
      batch.metadata.source === "gemini-interactions" ? batch.metadata : undefined;
    const remote = remoteMetadata !== undefined;
    const providerId = remote ? "gemini" : "local-mock";
    const modelId = remoteMetadata?.modelId ?? "deterministic-v1";
    const expectedIds = batch.images.map((image) =>
      createHash("sha256").update(image.bytes).digest("hex"),
    );
    const reservation = await this.options.references.reserveRun(
      active.runId,
      this.cumulativeRunAssetIds(active, expectedIds),
    );
    active.reservations.set(nodeId, reservation);
    const assetIds: string[] = [];
    for (const [index, image] of batch.images.entries()) {
      const ingested = await this.options.assets.ingest(bytesOf(image.bytes), {
        origin: {
          kind: "provider",
          providerId,
          modelId,
          runId: active.runId,
        },
        declaredMimeType: image.metadata.mimeType,
        generationMetadata: {
          source: image.metadata.source,
          mock: !remote,
          outputIndex: index,
          width: image.metadata.width,
          height: image.metadata.height,
          ...(image.metadata.source === "deterministic-local-mock"
            ? { seed: image.metadata.seed }
            : {
                modelId: image.metadata.modelId,
                ...(remoteMetadata?.interactionId
                  ? { interactionId: remoteMetadata.interactionId }
                  : {}),
                ...(remoteMetadata?.usage?.totalInputTokens === undefined
                  ? {}
                  : { inputTokens: remoteMetadata.usage.totalInputTokens }),
                ...(remoteMetadata?.usage?.totalOutputTokens === undefined
                  ? {}
                  : { outputTokens: remoteMetadata.usage.totalOutputTokens }),
                ...(remoteMetadata?.usage?.totalThoughtTokens === undefined
                  ? {}
                  : { thoughtTokens: remoteMetadata.usage.totalThoughtTokens }),
                ...(remoteMetadata?.usage?.totalTokens === undefined
                  ? {}
                  : { totalTokens: remoteMetadata.usage.totalTokens }),
              }),
        },
      });
      if (ingested.asset.assetId !== expectedIds[index]) {
        throw new Error("The durable asset digest differs from the validated mock output.");
      }
      assetIds.push(ingested.asset.assetId);
    }
    return { kind: "images", assetIds };
  }

  private async executeNode(
    provider: DeterministicMockImageProvider,
    providerEvents: MockProviderEventCoordinator,
    context: CoordinatorNodeExecutionContext,
  ) {
    if (context.node.type === "generate-image") {
      const result = await provider.execute(context);
      if (
        result.kind === "success" &&
        providerEvents.acceptedTerminalKind({
          runId: context.runId,
          nodeId: context.node.id,
          attempt: context.attempt,
        }) !== "completed"
      ) {
        return {
          kind: "ambiguous-submit" as const,
          error: "The mock provider completion was not accepted by the ordered event reducer.",
        };
      }
      return result;
    }
    if (context.node.type === "prompt") {
      return {
        kind: "success" as const,
        output: {
          kind: "text",
          text: context.node.data.text,
          assetIds: [],
        } satisfies DurableNodeOutput,
      };
    }
    if (context.node.type === "image-input") {
      const assetId = context.node.data.assetId;
      if (!assetId || !(await this.options.assets.getAvailable(assetId))) {
        return {
          kind: "failure" as const,
          error: "The referenced image is unavailable.",
          retrySafety: "never" as const,
        };
      }
      return {
        kind: "success" as const,
        output: {
          kind: "images",
          assetIds: [assetId],
        } satisfies DurableNodeOutput,
      };
    }
    const assetIds = new Set<string>();
    for (const value of context.dependencyOutputs.values()) {
      for (const assetId of assetIdsFrom(value)) assetIds.add(assetId);
    }
    return {
      kind: "success" as const,
      output: {
        kind: "images",
        assetIds: [...assetIds],
      } satisfies DurableNodeOutput,
    };
  }

  private async executeGeminiNode(
    active: ActiveRun,
    provider: GeminiImageProvider,
    context: CoordinatorNodeExecutionContext,
  ) {
    if (context.node.type !== "generate-image") {
      return this.executeNode(
        new DeterministicMockImageProvider({ clock: realClock(this.now), script: { nodes: {} } }),
        new MockProviderEventCoordinator(),
        context,
      );
    }
    if (active.execution.mode !== "gemini") {
      return {
        kind: "failure" as const,
        error: "Gemini execution authority is unavailable.",
        retrySafety: "confirmed-not-submitted" as const,
      };
    }
    if (!this.options.resolveGeminiAuth || !active.journal.providerAuthorization) {
      return {
        kind: "failure" as const,
        error: "Gemini credential authority is unavailable after durable preparation.",
        retrySafety: "confirmed-not-submitted" as const,
      };
    }
    let currentAuth: AuthResult;
    try {
      currentAuth = await this.options.resolveGeminiAuth();
      const binding = this.geminiCredentialBinding(currentAuth);
      if (
        binding.recordId !== active.journal.providerAuthorization.credentialRecordId ||
        binding.revision !== active.journal.providerAuthorization.credentialRevision
      ) {
        return {
          kind: "failure" as const,
          error: "The reviewed Gemini credential changed before submission.",
          retrySafety: "confirmed-not-submitted" as const,
        };
      }
    } catch {
      return {
        kind: "failure" as const,
        error: "The reviewed Gemini credential is no longer available.",
        retrySafety: "confirmed-not-submitted" as const,
      };
    }
    const promptOutputs = [...context.dependencyOutputs.values()].filter(
      (value): value is DurableNodeOutput & { text: string } =>
        isDurableNodeOutput(value) &&
        value.kind === "text" &&
        typeof value.text === "string" &&
        value.text.trim().length > 0,
    );
    if (promptOutputs.length !== 1) {
      return {
        kind: "failure" as const,
        error: "Gemini generation requires exactly one durable prompt input.",
        retrySafety: "confirmed-not-submitted" as const,
      };
    }
    const referenceIds = [
      ...new Set(
        [...context.dependencyOutputs.values()].flatMap((value) =>
          isDurableNodeOutput(value) && value.kind === "images" ? value.assetIds : [],
        ),
      ),
    ];
    const ownerId = `provider-${createHash("sha256")
      .update(active.runId)
      .update("\0")
      .update(context.node.id)
      .digest("hex")
      .slice(0, 32)}`;
    const leases: string[] = [];
    try {
      const references: ImageGenerationReference[] = [];
      for (const assetId of referenceIds) {
        const lease = await this.options.assets.acquirePreviewLease(assetId, ownerId, 60_000);
        leases.push(lease.token);
        const preview = await this.options.assets.readPreview(lease.token, ownerId);
        if (!["image/png", "image/jpeg", "image/webp"].includes(preview.asset.mediaType)) {
          return {
            kind: "failure" as const,
            error: "A reference image has an unsupported media type.",
            retrySafety: "confirmed-not-submitted" as const,
          };
        }
        references.push({
          assetId,
          bytes: preview.bytes,
          mimeType: preview.asset.mediaType as "image/png" | "image/jpeg" | "image/webp",
        });
      }
      const request: ValidatedImageGenerationRequest = {
        providerId: "gemini",
        modelId: context.node.data.modelId ?? "",
        prompt: promptOutputs[0]!.text,
        aspectRatio: context.node.data.aspectRatio,
        imageSize: context.node.data.imageSize,
        outputMime: context.node.data.outputMime,
        count: context.node.data.count,
        references,
      };
      const gate = this.providerAdmissionGate.tryAcquire("gemini", this.now());
      if (gate.status === "deferred") {
        return {
          kind: "rate-limited" as const,
          providerErrorCode: "rate-limited" as const,
          error: "Gemini request admission is temporarily busy. Review and start a new run later.",
          retrySafety: "never" as const,
          retryAfterMs: gate.retryAfterMs,
        };
      }
      try {
        const result = await provider.execute(currentAuth, request, {
          runId: active.runId,
          nodeId: context.node.id,
          signal: context.signal,
        });
        if (result.kind === "success") {
          const acceptanceId = `gemini-sync-${createHash("sha256")
            .update(result.output.metadata.interactionId ?? "no-interaction-id")
            .update("\0")
            .update(active.runId)
            .update("\0")
            .update(context.node.id)
            .digest("hex")}`;
          try {
            await context.recordRemoteJobId(acceptanceId);
          } catch {
            return {
              kind: "ambiguous-submit" as const,
              providerErrorCode: "submission-ambiguous" as const,
              error: "Gemini completed, but Aiden could not durably bind the response.",
            };
          }
          return result;
        }
        return result.kind === "failure" || result.kind === "rate-limited"
          ? { ...result, errorCode: geminiCoordinatorErrorCode(result.providerErrorCode) }
          : result;
      } finally {
        this.providerAdmissionGate.release(gate.lease);
      }
    } catch {
      return {
        kind: "failure" as const,
        error: "Aiden could not prepare the bounded Gemini image request.",
        retrySafety: "confirmed-not-submitted" as const,
      };
    } finally {
      await Promise.all(
        leases.map((token) =>
          this.options.assets.releasePreviewLease(token, ownerId).catch(() => false),
        ),
      );
    }
  }

  private launch(active: ActiveRun, nodes: readonly WorkflowNodeV1[]): void {
    active.settled = Promise.resolve()
      .then(async () => {
        const remoteNodeIds = nodes
          .filter((node) => node.type === "generate-image")
          .map((node) => node.id);
        const clock = realClock(this.now);
        const providerEvents = new MockProviderEventCoordinator();
        const provider = new DeterministicMockImageProvider({
          clock,
          script: this.mockScript(remoteNodeIds),
          onProviderEvent: (event) => {
            providerEvents.observe(event);
          },
        });
        const plan = createWorkflowCoordinatorPlan(
          active.journal.workflowSnapshot,
          active.journal.plan.scope,
        );
        const geminiProvider =
          active.execution.mode === "gemini"
            ? (this.options.createGeminiProvider?.() ?? new GeminiImageProvider())
            : undefined;
        await runWorkflowCoordinator(plan, {
          runId: active.runId,
          localConcurrency: 4,
          remoteConcurrency:
            active.execution.mode === "gemini"
              ? Math.min(active.journal.workflowSnapshot.settings.concurrency, 2)
              : active.journal.workflowSnapshot.settings.concurrency,
          clock,
          jitter: { sample: () => 0.5 },
          retryPolicy:
            active.execution.mode === "gemini"
              ? CREATE_IMAGES_GEMINI_RETRY_POLICY
              : CREATE_IMAGES_LOCAL_MOCK_RETRY_POLICY,
          durability: this.durability(active),
          signal: active.controller.signal,
          executeNode: (context) =>
            geminiProvider
              ? this.executeGeminiNode(active, geminiProvider, context)
              : this.executeNode(provider, providerEvents, context),
        });
      })
      .catch(async () => {
        active.needsReconciliation = true;
        await this.reconcileFailedLaunch(active);
      })
      .finally(async () => {
        await this.releaseActiveOwnershipIfTerminalOrDegraded(active);
      });
  }

  private currentGeminiCapability(modelId: string) {
    const provider = this.options.createGeminiProvider?.() ?? new GeminiImageProvider();
    const model = provider.listModels().find((candidate) => candidate.id === modelId);
    if (!model) {
      throw new CreateImagesProviderAdmissionError(
        "capability-drift",
        "The reviewed Gemini model is no longer in Aiden's release catalog.",
      );
    }
    return createCreateImagesProviderCapabilitySnapshot({
      catalogRevision: CREATE_IMAGES_GEMINI_CATALOG_REVISION,
      observedAt: CREATE_IMAGES_GEMINI_CATALOG_OBSERVED_AT,
      model,
      transport: {
        kind: "synchronous",
        supportsIdempotency: false,
        supportsReconciliation: false,
      },
    });
  }

  private geminiCredentialBinding(auth: AuthResult): CreateImagesMainCredentialBindingV1 {
    const apiKey = auth.auth.apiKey;
    if (typeof apiKey !== "string" || apiKey.length === 0) {
      throw new CreateImagesProviderAdmissionError(
        "credential-required",
        "A compatible Google Gemini API key is required.",
      );
    }
    const recordId = `google-${createHmac("sha256", this.providerConsentAuthority.secret)
      .update("aiden-create-images-google-api-key-v1\0")
      .update(apiKey)
      .digest("hex")}`;
    return createCreateImagesMainCredentialBinding({
      providerId: "gemini",
      recordId,
      revision: 1,
      authKind: "api-key",
    });
  }

  private async geminiInvocations(plan: ReturnType<typeof createWorkflowCoordinatorPlan>): Promise<{
    capability: ReturnType<typeof createCreateImagesProviderCapabilitySnapshot>;
    invocations: CreateImagesProviderInvocationFactsV1[];
  }> {
    const nodes = new Map(plan.snapshot.nodes.map((node) => [node.id, node]));
    const generationNodes = plan.orderedNodeIds
      .map((nodeId) => nodes.get(nodeId))
      .filter(
        (node): node is Extract<WorkflowNodeV1, { type: "generate-image" }> =>
          node?.type === "generate-image",
      );
    if (generationNodes.length === 0) {
      throw new CreateImagesProviderAdmissionError(
        "invalid-input",
        "This run scope contains no Gemini generation request.",
      );
    }
    const modelIds = new Set(generationNodes.map((node) => node.data.modelId));
    if (modelIds.size !== 1 || generationNodes[0]?.data.modelId === undefined) {
      throw new CreateImagesProviderAdmissionError(
        "invalid-input",
        "One reviewed Gemini run must use exactly one curated model.",
      );
    }
    const capability = this.currentGeminiCapability(generationNodes[0].data.modelId);
    const invocations: CreateImagesProviderInvocationFactsV1[] = [];
    for (const node of generationNodes) {
      const dependencies = (plan.dependencies[node.id] ?? [])
        .map((nodeId) => nodes.get(nodeId))
        .filter((candidate): candidate is WorkflowNodeV1 => candidate !== undefined);
      const prompts = dependencies.filter(
        (candidate): candidate is Extract<WorkflowNodeV1, { type: "prompt" }> =>
          candidate.type === "prompt",
      );
      if (prompts.length !== 1 || !prompts[0]!.data.text.trim()) {
        throw new CreateImagesProviderAdmissionError(
          "invalid-input",
          "Each Gemini request requires exactly one non-empty prompt input.",
        );
      }
      if (dependencies.some((candidate) => candidate.type === "generate-image")) {
        throw new CreateImagesProviderAdmissionError(
          "invalid-input",
          "Chained cloud generations require a separate reviewed run in this release.",
        );
      }
      const referenceNodes = dependencies.filter(
        (candidate): candidate is Extract<WorkflowNodeV1, { type: "image-input" }> =>
          candidate.type === "image-input" && candidate.data.assetId !== undefined,
      );
      const referenceAssets = await Promise.all(
        referenceNodes.map((candidate) =>
          this.options.assets.getAvailable(candidate.data.assetId!),
        ),
      );
      if (referenceAssets.some((asset) => asset === undefined)) {
        throw new CreateImagesProviderAdmissionError(
          "invalid-input",
          "A reviewed Gemini reference image is unavailable.",
        );
      }
      invocations.push({
        nodeId: node.id,
        promptBytes: Buffer.byteLength(prompts[0]!.data.text, "utf8"),
        referenceImageCount: referenceAssets.length,
        referenceImageBytes: referenceAssets.reduce(
          (total, asset) => total + (asset?.byteLength ?? 0),
          0,
        ),
        requestedOutputs: node.data.count,
        aspectRatio: node.data.aspectRatio,
        imageSize: node.data.imageSize,
        outputMime: node.data.outputMime,
      });
    }
    return { capability, invocations };
  }

  private purgeExpiredGeminiConsents(): void {
    const now = this.now();
    for (const [authorizationId, pending] of this.pendingGeminiConsents) {
      if (Date.parse(pending.mainPlan.expiresAt) < now) {
        this.pendingGeminiConsents.delete(authorizationId);
      }
    }
    while (this.pendingGeminiConsents.size >= CREATE_IMAGES_MAX_PENDING_GEMINI_CONSENTS) {
      const oldest = this.pendingGeminiConsents.keys().next().value as string | undefined;
      if (!oldest) break;
      this.pendingGeminiConsents.delete(oldest);
    }
  }

  private async prepareGeminiInternal(
    input: CreateImagesPrepareGeminiRunRequest,
  ): Promise<CreateImagesPrepareRunResult> {
    await this.initialize();
    const workflow = await this.options.workflows.get(input.workflowId);
    if (!workflow) return { status: "not-found", message: "The workflow no longer exists." };
    if (workflow.revision !== input.expectedRevision) {
      return {
        status: "conflict",
        expectedRevision: input.expectedRevision,
        currentRevision: workflow.revision,
      };
    }
    const audit = await this.journals.auditWorkflowAdmission(workflow.id);
    if (
      audit.hasDegradedAuthority ||
      audit.hasNonterminalRun ||
      audit.hasUnresolvedAmbiguity ||
      this.activeByWorkflow.has(workflow.id)
    ) {
      return {
        status: "unavailable",
        message: "Resolve the workflow's retained run state before reviewing a new cloud run.",
      };
    }
    if (!this.options.resolveGeminiAuth) {
      return {
        status: "unavailable",
        message: "Google Gemini image execution is unavailable in this Aiden runtime.",
      };
    }
    try {
      const plan = createWorkflowCoordinatorPlan(workflow, input.scope);
      const { capability, invocations } = await this.geminiInvocations(plan);
      const auth = await this.options.resolveGeminiAuth();
      const credentialBinding = this.geminiCredentialBinding(auth);
      const createdAtMs = this.now();
      const prepared = prepareCreateImagesProviderExecutionConsent(
        {
          authorizationId: randomUUID(),
          workflowId: workflow.id,
          workflowRevision: workflow.revision,
          executionMode: "gemini",
          capability,
          credentialBinding,
          invocations,
          maximumAttempts: invocations.length,
          estimate: {
            kind: "unavailable",
            estimatedAt: iso(createdAtMs),
            sourceFingerprint: CREATE_IMAGES_GEMINI_ESTIMATE_SOURCE_FINGERPRINT,
          },
          createdAt: iso(createdAtMs),
          expiresAt: iso(createdAtMs + CREATE_IMAGES_GEMINI_CONSENT_LIFETIME_MS),
        },
        this.providerConsentAuthority,
      );
      this.purgeExpiredGeminiConsents();
      this.pendingGeminiConsents.set(prepared.mainPlan.authorizationId, {
        mainPlan: prepared.mainPlan,
        scope: structuredClone(plan.scope),
      });
      return {
        status: "ready",
        plan: prepared.rendererPlan as CreateImagesProviderConsentPlanView,
      };
    } catch (error) {
      return {
        status: error instanceof CreateImagesProviderAdmissionError ? "invalid" : "unavailable",
        message:
          error instanceof Error
            ? error.message
            : "Aiden could not prepare a bounded Gemini consent plan.",
      };
    }
  }

  async prepareGeminiRun(
    input: CreateImagesPrepareGeminiRunRequest,
  ): Promise<CreateImagesPrepareRunResult> {
    const previous = this.startAdmissionTail;
    const operation = previous.then(() => this.prepareGeminiInternal(input));
    this.startAdmissionTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async startInternal(
    input: CreateImagesRunStartRequest,
    isRendererCurrent: () => boolean,
  ): Promise<CreateImagesRunMutationResult> {
    if (this.shutdownAdmissionBarrier) {
      return {
        status: "unavailable",
        message: "Aiden is preparing to quit and is not accepting new image runs.",
      };
    }
    await this.initialize();
    if (this.shutdownAdmissionBarrier) {
      return {
        status: "unavailable",
        message: "Aiden is preparing to quit and is not accepting new image runs.",
      };
    }
    const orphaned = this.activeByWorkflow.get(input.workflowId);
    if (
      orphaned?.needsReconciliation &&
      !(await this.reconcileFailedLaunch(orphaned, Date.now() + this.shutdownTimeoutMs))
    ) {
      return {
        status: "unavailable",
        message: "The previous durable run is still being reconciled. No new work was started.",
      };
    }
    const existing = this.activeByWorkflow.get(input.workflowId);
    if (existing)
      return projectCreateImagesRun(existing.journal).terminal
        ? {
            status: "unavailable",
            message: "The previous durable run is still releasing its ownership.",
          }
        : {
            status: "already-running",
            run: runView(existing.journal),
          };
    if (this.activeByRun.size >= CREATE_IMAGES_MAX_ACTIVE_RUNS) {
      return {
        status: "unavailable",
        message: `Create Images supports at most ${CREATE_IMAGES_MAX_ACTIVE_RUNS} active runs at once.`,
      };
    }
    const workflow = await this.options.workflows.get(input.workflowId);
    if (!workflow) return { status: "not-found", message: "The workflow no longer exists." };
    if (workflow.revision !== input.expectedRevision) {
      return {
        status: "conflict",
        expectedRevision: input.expectedRevision,
        currentRevision: workflow.revision,
      };
    }
    let admissionAudit: CreateImagesWorkflowAdmissionAudit;
    try {
      admissionAudit = await this.journals.auditWorkflowAdmission(workflow.id);
    } catch {
      return {
        status: "unavailable",
        message: "Run authority could not be revalidated safely. No new image run was started.",
      };
    }
    if (admissionAudit.hasDegradedAuthority) {
      return {
        status: "unavailable",
        message:
          "Resolve the workflow's damaged or unsupported run records before starting another run.",
      };
    }
    if (admissionAudit.hasNonterminalRun) {
      return {
        status: "unavailable",
        message: "A previous durable run must be reconciled before another image run can start.",
      };
    }
    if (admissionAudit.hasUnresolvedAmbiguity) {
      return {
        status: "unavailable",
        message:
          "A previous submission is unresolved. Acknowledge its duplicate-generation risk before starting another run.",
      };
    }
    let plan;
    try {
      plan = createWorkflowCoordinatorPlan(workflow, input.scope);
    } catch (error) {
      return {
        status: "invalid",
        message: error instanceof Error ? error.message : "The workflow cannot run.",
      };
    }
    if (this.options.workspaceStatus) {
      const workspace = await this.options.workspaceStatus();
      if (
        (this.options.workspaceRequired && !workspace.configured) ||
        (workspace.configured && workspace.state !== "ready")
      ) {
        return {
          status: "unavailable",
          message:
            "The configured Create Images workspace is not ready. Reconnect it before starting this run.",
        };
      }
    }
    if (
      input.executionMode !== undefined &&
      input.executionMode !== "local-mock" &&
      input.executionMode !== "gemini"
    ) {
      return { status: "invalid", message: "The execution mode is unsupported." };
    }
    let execution: CreateImagesRunExecution = { mode: "local-mock" };
    let providerAuthorization: CreateImagesRunProviderAuthorizationV1 | undefined;
    let consumedAuthorizationId: string | undefined;
    if (input.executionMode === "gemini") {
      const claim = input.providerConsent;
      if (!claim) {
        return {
          status: "invalid",
          message: "Review the current Gemini consent plan before starting this run.",
        };
      }
      this.purgeExpiredGeminiConsents();
      const pending = this.pendingGeminiConsents.get(claim.authorizationId);
      if (
        !pending ||
        pending.mainPlan.workflowId !== workflow.id ||
        pending.mainPlan.workflowRevision !== workflow.revision ||
        JSON.stringify(pending.scope) !== JSON.stringify(plan.scope)
      ) {
        return {
          status: "invalid",
          message: "The reviewed Gemini consent no longer matches this exact saved run scope.",
        };
      }
      if (!this.options.resolveGeminiAuth) {
        return {
          status: "unavailable",
          message: "Google Gemini image execution is unavailable in this Aiden runtime.",
        };
      }
      try {
        const auth = await this.options.resolveGeminiAuth();
        const credentialBinding = this.geminiCredentialBinding(auth);
        const capability = this.currentGeminiCapability(pending.mainPlan.capability.model.id);
        const authorization = admitCreateImagesProviderExecution({
          mainPlan: pending.mainPlan,
          claim,
          authority: this.providerConsentAuthority,
          currentCapability: capability,
          currentCredential: credentialBinding,
          now: iso(this.now()),
        });
        const generationNodeIds = plan.orderedNodeIds.filter(
          (nodeId) =>
            plan.snapshot.nodes.find((candidate) => candidate.id === nodeId)?.type ===
            "generate-image",
        );
        if (
          JSON.stringify(authorization.invocations.map((invocation) => invocation.nodeId)) !==
          JSON.stringify(generationNodeIds)
        ) {
          throw new CreateImagesProviderAdmissionError(
            "forged-consent",
            "The reviewed Gemini requests no longer match the immutable run plan.",
          );
        }
        execution = { mode: "gemini", auth };
        providerAuthorization = {
          version: 1,
          executionMode: "gemini",
          authorizationId: authorization.authorizationId,
          consentFingerprint: authorization.consentFingerprint,
          capabilityFingerprint: authorization.capability.fingerprint,
          credentialRecordId: authorization.credentialBinding!.recordId,
          credentialRevision: authorization.credentialBinding!.revision,
          initialRequestCount: authorization.accounting.initialRequestCount,
          expectedOutputCount: authorization.accounting.expectedOutputCount,
          maximumAttempts: authorization.accounting.maximumAttempts,
          createdAt: pending.mainPlan.createdAt,
          expiresAt: authorization.expiresAt,
        };
        consumedAuthorizationId = authorization.authorizationId;
      } catch (error) {
        return {
          status: error instanceof CreateImagesProviderAdmissionError ? "invalid" : "unavailable",
          message:
            error instanceof Error
              ? error.message
              : "The reviewed Gemini authorization could not be admitted safely.",
        };
      }
    } else if (input.providerConsent) {
      return { status: "invalid", message: "Local mock runs cannot carry cloud consent." };
    }
    const runId = this.createRunId();
    const createdAt = iso(this.now());
    const start: CreateImagesRunStartInput = {
      runId,
      workflowSnapshot: plan.snapshot,
      plan: {
        scope: structuredClone(plan.scope),
        orderedNodeIds: [...plan.orderedNodeIds],
        dependencies: Object.fromEntries(
          Object.entries(plan.dependencies).map(([nodeId, values]) => [nodeId, [...values]]),
        ),
      },
      ...(providerAuthorization ? { providerAuthorization } : {}),
      createdAt,
    };
    const inputReservation = await this.options.references.reserveRun(
      runId,
      plan.snapshot.assetRefs,
    );
    let journal: CreateImagesRunJournalV1;
    try {
      if (consumedAuthorizationId) {
        this.pendingGeminiConsents.delete(consumedAuthorizationId);
      }
      journal = await this.journals.start(start, isRendererCurrent);
    } catch (error) {
      const authoritative = await this.journals.get(runId).catch(() => undefined);
      if (authoritative && !projectCreateImagesRun(authoritative).terminal) {
        await this.reconcileAfterRestart(authoritative).catch(() => undefined);
      }
      await this.options.references.releaseRunReservations(runId).catch(() => undefined);
      await this.options.references.reconcileRuns(this.journals).catch(() => undefined);
      throw error;
    }
    try {
      await this.options.references.commitRun(inputReservation);
    } catch (error) {
      if (!(await this.options.references.reconcileRuns(this.journals))) throw error;
    }
    await this.options.assets
      .replaceReferences({ kind: "run", id: runId }, [...new Set(plan.snapshot.assetRefs)].sort())
      .catch(() => undefined);
    await this.options.references.releaseRunReservations(runId).catch(() => undefined);
    let resolveCancelDurable: () => void = () => undefined;
    const cancelDurable = new Promise<void>((resolve) => {
      resolveCancelDurable = resolve;
    });
    const active: ActiveRun = {
      runId,
      workflowId: workflow.id,
      journal,
      execution,
      controller: new AbortController(),
      mutationTail: Promise.resolve(),
      publicationTail: Promise.resolve(),
      publishedOutputs: new Map(),
      reservations: new Map(),
      cancelDurable,
      resolveCancelDurable,
      settled: Promise.resolve(),
    };
    this.activeByRun.set(runId, active);
    this.activeByWorkflow.set(workflow.id, active);
    this.notify(workflow.id);
    this.launch(active, plan.snapshot.nodes);
    return { status: "started", run: runView(journal) };
  }

  async start(
    input: CreateImagesRunStartRequest,
    isRendererCurrent: () => boolean,
  ): Promise<CreateImagesRunMutationResult> {
    const previous = this.startAdmissionTail;
    const operation = previous.then(() => this.startInternal(input, isRendererCurrent));
    const tail = operation.then(
      () => undefined,
      () => undefined,
    );
    this.startAdmissionTail = tail;
    return operation;
  }

  async deleteWorkflowIfRunLifecycleEmpty<Result>(
    workflowId: string,
    deleteWorkflow: () => Promise<Result>,
  ): Promise<
    | { status: "allowed"; value: Result }
    | Exclude<CreateImagesWorkflowDeletionDecision, { status: "allowed" }>
  > {
    const previous = this.startAdmissionTail;
    const operation = previous.then(async () => {
      let snapshot: CreateImagesRunListResult;
      let authority: CreateImagesWorkflowAdmissionAudit;
      try {
        authority = await this.journals.auditWorkflowAdmission(workflowId);
        snapshot = await this.list(workflowId);
      } catch {
        return {
          status: "unavailable" as const,
          message: "Run history could not be verified safely. No workflow was deleted.",
        };
      }
      const decision = evaluateCreateImagesWorkflowDeletion(snapshot);
      if (decision.status !== "allowed") return decision;
      if (authority.hasDegradedAuthority) {
        return {
          status: "unavailable" as const,
          message:
            "Damaged or unassociated run recovery authority prevents Aiden from proving this workflow is safe to delete. No workflow was deleted.",
        };
      }
      if (authority.hasNonterminalRun) {
        return {
          status: "unavailable" as const,
          message:
            "A durable nonterminal image run must be reconciled before deleting this workflow. No workflow was deleted.",
        };
      }
      if (authority.hasUnresolvedAmbiguity) {
        return {
          status: "unavailable" as const,
          message:
            "An unresolved image submission must remain reviewable before deleting this workflow. No workflow was deleted.",
        };
      }
      return { status: "allowed" as const, value: await deleteWorkflow() };
    });
    this.startAdmissionTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async stop(
    workflowId: string,
    runId: string,
    reason: CreateImagesCancellationReason,
  ): Promise<CreateImagesRunMutationResult> {
    await this.initialize();
    const active = this.activeByRun.get(runId);
    if (!active || active.workflowId !== workflowId) {
      const journal = await this.journals.get(runId);
      if (!journal || journal.workflowId !== workflowId) {
        return {
          status: "not-found",
          message: "The workflow run no longer exists.",
        };
      }
      return TERMINAL_RUN_STATUSES.has(projectCreateImagesRun(journal).status)
        ? {
            status: "unavailable",
            message: "This workflow run is already finished.",
          }
        : {
            status: "unavailable",
            message: "This run must be reconciled before it can stop.",
          };
    }
    if (!active.controller.signal.aborted) {
      active.controller.abort(new CoordinatorCancellationRequest(reason));
    }
    this.beginActiveCancellation(active, reason);
    const outcome = await this.waitForActiveStop(active, Date.now() + this.shutdownTimeoutMs);
    if (outcome === "blocked") {
      return {
        status: "unavailable",
        message: "The cancellation request was not durably saved. Aiden will keep this run open.",
      };
    }
    if (outcome === "terminal") {
      return {
        status: "unavailable",
        message: "This workflow run is already finished.",
      };
    }
    return {
      status: "stopping",
      // Avoid a post-deadline store read: an interrupted pending publication
      // may still own the store's serialization lock.
      run: runView(active.journal),
    };
  }

  private beginActiveCancellation(active: ActiveRun, reason: CreateImagesCancellationReason): void {
    if (!active.controller.signal.aborted) {
      active.controller.abort(new CoordinatorCancellationRequest(reason));
    }
    if (projectCreateImagesRun(active.journal).cancellation) {
      active.resolveCancelDurable();
      return;
    }
    if (active.cancellationRequest) return;
    const request = this.mutateJournal(active, (journal) =>
      projectCreateImagesRun(journal).cancellation
        ? Promise.resolve(journal)
        : this.journals.requestCancellation(journal.runId, journal.journalRevision, {
            at: createEventBase(journal, this.now()).at,
            reason,
          }),
    );
    active.cancellationRequest = request;
    void request.then(
      () => {
        active.resolveCancelDurable();
        if (active.cancellationRequest === request) active.cancellationRequest = undefined;
      },
      () => {
        // The bounded waiter below turns this into an observable failure. The
        // reference is cleared so a later explicit stop may safely retry.
        if (active.cancellationRequest === request) active.cancellationRequest = undefined;
      },
    );
  }

  private async waitForActiveStop(
    active: ActiveRun,
    deadline: number,
  ): Promise<"durable" | "terminal" | "blocked"> {
    const projection = projectCreateImagesRun(active.journal);
    if (projection.cancellation) return "durable";
    if (projection.terminal) return "terminal";
    const remaining = deadline - Date.now();
    if (remaining <= 0) return "blocked";
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        active.cancelDurable.then(() => "durable" as const),
        active.settled.then(() => {
          const settled = projectCreateImagesRun(active.journal);
          return settled.cancellation
            ? ("durable" as const)
            : settled.terminal
              ? ("terminal" as const)
              : ("blocked" as const);
        }),
        new Promise<"blocked">((resolve) => {
          timeout = setTimeout(() => resolve("blocked"), remaining);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private async waitUntilDeadline(promise: Promise<unknown>, deadline: number): Promise<boolean> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise.then(
          () => true,
          () => true,
        ),
        new Promise<false>((resolve) => {
          timeout = setTimeout(() => resolve(false), remaining);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  async stopAll(reason: "app-quit"): Promise<CreateImagesRunStopAllResult> {
    this.shutdownAdmissionBarrier = true;
    const deadline = Date.now() + this.shutdownTimeoutMs;
    const admittedBeforeShutdown = this.startAdmissionTail;
    if (!(await this.waitUntilDeadline(admittedBeforeShutdown, deadline))) {
      return { status: "blocked", failedRunIds: [] };
    }
    const activeRuns = [...this.activeByRun.values()];
    const alreadyDurable = activeRuns.every((active) => {
      const projection = projectCreateImagesRun(active.journal);
      return projection.cancellation !== undefined || projection.terminal !== undefined;
    });
    for (const active of activeRuns) this.beginActiveCancellation(active, reason);
    const outcomes = await Promise.all(
      activeRuns.map((active) => this.waitForActiveStop(active, deadline)),
    );
    const failedRunIds = activeRuns
      .filter((_active, index) => outcomes[index] === "blocked")
      .map((active) => active.runId)
      .sort();
    if (failedRunIds.length > 0) return { status: "blocked", failedRunIds };
    if (alreadyDurable) {
      return {
        status: "safe-to-quit",
        unsettledRunIds: activeRuns
          .filter((active) => this.activeByRun.has(active.runId))
          .map((active) => active.runId)
          .sort(),
      };
    }
    const remaining = deadline - Date.now();
    if (remaining > 0) {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.allSettled(activeRuns.map((active) => active.settled)).then(() => undefined),
          new Promise<void>((resolve) => {
            timeout = setTimeout(resolve, remaining);
          }),
        ]);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    }
    return {
      status: "safe-to-quit",
      unsettledRunIds: activeRuns
        .filter((active) => this.activeByRun.has(active.runId))
        .map((active) => active.runId)
        .sort(),
    };
  }

  /** Reopens admission only after main has explicitly abandoned a quit attempt. */
  resumeRunAdmissionsAfterCancelledShutdown(): void {
    this.shutdownAdmissionBarrier = false;
  }

  async activeRuns(): Promise<CreateImagesRunView[]> {
    await this.initialize();
    const views = [...this.activeByRun.values()].map((active) => runView(active.journal));
    return views.sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) || left.runId.localeCompare(right.runId),
    );
  }

  async list(workflowId: string): Promise<CreateImagesRunListResult> {
    await this.initialize();
    if (!(await this.options.workflows.get(workflowId))) return { status: "not-found" };
    const orphaned = this.activeByWorkflow.get(workflowId);
    if (
      orphaned?.needsReconciliation &&
      !(await this.reconcileFailedLaunch(orphaned, Date.now() + this.shutdownTimeoutMs))
    ) {
      return {
        status: "unavailable",
        message: "The durable run is still being reconciled. Try again shortly.",
        retryAfterMs: this.shutdownTimeoutMs,
      };
    }
    const active = this.activeByWorkflow.get(workflowId);
    let cached = this.terminalCache.get(workflowId);
    let refreshedRecoveries: CreateImagesRunRecoveryView[] | undefined;
    if (!cached) {
      const summaries = (await this.journals.terminalHistory())
        .filter((summary) => summary.workflowId === workflowId)
        .slice(0, 100);
      refreshedRecoveries = this.recoveryViews(
        await this.journals.refreshWorkflowDegradedMetadata(
          workflowId,
          summaries.map((summary) => summary.runId),
        ),
      );
      const refreshedRecoveryIds = new Set(refreshedRecoveries.map((recovery) => recovery.runId));
      const history: CreateImagesTerminalRunView[] = [];
      let latestTerminalRun: CreateImagesRunView | undefined;
      for (const summary of summaries) {
        if (refreshedRecoveryIds.has(summary.runId)) continue;
        const journal = await this.journals.get(summary.runId);
        if (!journal) continue;
        const view = terminalView(journal);
        if (view) {
          history.push(view);
          latestTerminalRun ??= runView(journal);
        }
      }
      cached = { history, ...(latestTerminalRun ? { latestTerminalRun } : {}) };
      this.cacheTerminalHistory(workflowId, cached);
    } else {
      this.cacheTerminalHistory(workflowId, cached);
    }
    const recoveries = refreshedRecoveries ?? (await this.recoveryViewsForWorkflow(workflowId));
    const recoveryRunIds = new Set(recoveries.map((recovery) => recovery.runId));
    const history = cached.history.filter((entry) => !recoveryRunIds.has(entry.runId));
    const latestTerminalRun =
      cached.latestTerminalRun && !recoveryRunIds.has(cached.latestTerminalRun.runId)
        ? cached.latestTerminalRun
        : undefined;
    return {
      status: "ready",
      authoritative: true,
      ...(active ? { activeRun: runView(active.journal) } : {}),
      ...(!active && latestTerminalRun
        ? { latestTerminalRun: structuredClone(latestTerminalRun) }
        : {}),
      history: structuredClone(history),
      recoveries,
    };
  }

  async get(workflowId: string, runId: string): Promise<CreateImagesRunDetailResult> {
    await this.initialize();
    if (!(await this.options.workflows.get(workflowId))) return { status: "not-found" };
    const health = await this.journals.health(runId);
    if (health.status === "missing") return { status: "not-found" };
    if (health.status === "unsafe") {
      const recovery = unsafeRecoveryView(health);
      return recovery?.workflowId === workflowId
        ? {
            status: "unsafe",
            recovery,
            message: "This run uses an unsupported schema or unsafe storage and is read-only.",
          }
        : { status: "not-found" };
    }
    if (health.status === "recovery-required") {
      const recovery = recoveryRequiredView(health);
      return recovery?.workflowId === workflowId
        ? { status: "recovery-required", recovery }
        : { status: "not-found" };
    }
    const journal = await this.journals.get(runId);
    return journal?.workflowId === workflowId
      ? { status: "ready", run: runView(journal) }
      : { status: "not-found" };
  }

  async resolveRunAmbiguity(
    input: CreateImagesResolveRunAmbiguityRequest,
  ): Promise<CreateImagesRunAmbiguityResolutionResult> {
    await this.initialize();
    if (
      input.resolution !== "acknowledge-unresolved-submission" ||
      !(await this.options.workflows.get(input.workflowId))
    ) {
      return { status: "not-found" };
    }
    const health = await this.journals.health(input.runId);
    if (health.status === "missing") return { status: "not-found" };
    if (health.status !== "healthy") {
      return {
        status: "unavailable",
        message: "This run must be recovered before its unresolved submission can be acknowledged.",
      };
    }
    let journal = await this.journals.get(input.runId);
    if (!journal || journal.workflowId !== input.workflowId) {
      return { status: "not-found" };
    }
    if (journal.journalRevision !== input.expectedJournalRevision) {
      return {
        status: "conflict",
        expectedJournalRevision: input.expectedJournalRevision,
        currentJournalRevision: journal.journalRevision,
      };
    }
    let projection = projectCreateImagesRun(journal);
    const wasAlreadyResolved = projection.ambiguityResolution !== undefined;
    if (!wasAlreadyResolved && !hasUnresolvedCreateImagesRunAmbiguity(projection)) {
      return { status: "not-ambiguous" };
    }
    if (!wasAlreadyResolved) {
      try {
        journal = await this.journals.append(journal.runId, input.expectedJournalRevision, {
          ...createEventBase(journal, this.now()),
          type: "run-ambiguity-acknowledged",
          expectedNeedsAttentionJournalRevision: input.expectedJournalRevision,
        });
      } catch (error) {
        if (error instanceof CreateImagesRunJournalRevisionConflictError) {
          if (error.actualJournalRevision === null) return { status: "not-found" };
          return {
            status: "conflict",
            expectedJournalRevision: input.expectedJournalRevision,
            currentJournalRevision: error.actualJournalRevision,
          };
        }
        if (error instanceof CreateImagesRunJournalLoadError) {
          return {
            status: "unavailable",
            message: "The unresolved submission acknowledgement could not be saved safely.",
          };
        }
        throw error;
      }
      projection = projectCreateImagesRun(journal);
      if (!projection.ambiguityResolution) {
        return {
          status: "unavailable",
          message: "The unresolved submission acknowledgement was not durably projected.",
        };
      }
      this.terminalCache.delete(input.workflowId);
      this.notify(input.workflowId);
    }
    const authoritativeList = await this.list(input.workflowId);
    if (authoritativeList.status !== "ready") {
      return {
        status: "unavailable",
        message: "The updated run history could not be loaded safely.",
      };
    }
    return {
      status: wasAlreadyResolved ? "already-resolved" : "resolved",
      run: runView(journal),
      authoritativeList,
    };
  }

  async planDegradedRunDiscard(runId: string): Promise<CreateImagesDegradedRunDiscardPlanResult> {
    await this.initialize();
    if (this.activeByRun.has(runId)) {
      return {
        status: "unavailable",
        message: "An active run cannot be discarded.",
      };
    }
    try {
      const planned = await this.journals.planDegradedRunDiscard(runId);
      if (planned.status !== "ready") return planned;
      const { recordFingerprint: _recordFingerprint, version: _version, ...safe } = planned.plan;
      return {
        status: "ready",
        ...safe,
        mayLoseOutputs: true,
        mayDuplicateProviderWork: true,
      };
    } catch {
      return {
        status: "unavailable",
        message: "The damaged run record could not be authorized for discard safely.",
      };
    }
  }

  async discardDegradedRun(
    input: CreateImagesDiscardDegradedRunRequest,
  ): Promise<CreateImagesDegradedRunDiscardResult> {
    await this.initialize();
    if (this.activeByRun.has(input.runId)) {
      return {
        status: "unavailable",
        message: "An active run cannot be discarded.",
      };
    }
    const referencedAssetCount = (await this.options.assets.list()).filter((asset) =>
      this.options.references.isRunAssetReferenced(input.runId, asset.assetId),
    ).length;
    try {
      const discarded = await this.journals.discardDegradedRun({
        runId: input.runId,
        authorizationToken: input.authorizationToken,
        ...(input.expectedCurrentJournalRevision === undefined
          ? {}
          : {
              expectedCurrentJournalRevision: input.expectedCurrentJournalRevision,
            }),
        ...(input.expectedLastKnownGoodJournalRevision === undefined
          ? {}
          : {
              expectedLastKnownGoodJournalRevision: input.expectedLastKnownGoodJournalRevision,
            }),
      });
      if (discarded.status !== "discarded") return discarded;
      const assetReferencesReleased = await this.options.assets
        .replaceReferences({ kind: "run", id: input.runId }, [])
        .then(
          () => true,
          () => false,
        );
      const releasedAssetCount = assetReferencesReleased ? referencedAssetCount : 0;
      await this.options.references.reconcileRuns(this.journals).catch(() => false);
      const workflowId = discarded.result.workflowId;
      if (!workflowId) {
        return { status: "discarded", runId: input.runId, releasedAssetCount };
      }
      this.terminalCache.delete(workflowId);
      this.notify(workflowId);
      const authoritativeList = await this.list(workflowId);
      return {
        status: "discarded",
        runId: input.runId,
        releasedAssetCount,
        authoritativeList,
      };
    } catch {
      return {
        status: "unavailable",
        message: "The damaged run record was preserved because discard could not finish safely.",
      };
    }
  }

  async planHistoryPrune(keepLatest: number): Promise<CreateImagesRunHistoryPrunePlanResult> {
    await this.initialize();
    const candidates = await this.journals.terminalRetentionCandidates({
      keepLatest,
      limit: 100,
    });
    if (candidates.length === 0) return { status: "nothing-to-prune" };
    const plan = await this.journals.planTerminalPrune(candidates);
    return {
      status: "ready",
      scope: "all-workflows",
      mayReleaseUniqueOutputs: true,
      authorizationToken: plan.token,
      keepLatest,
      candidateRunCount: plan.candidates.length,
      releasedAssetCount: plan.assetIds.length,
    };
  }

  async pruneHistory(
    keepLatest: number,
    authorizationToken: string,
  ): Promise<CreateImagesRunHistoryPruneResult> {
    await this.initialize();
    const candidates = await this.journals.terminalRetentionCandidates({
      keepLatest,
      limit: 100,
    });
    if (candidates.length === 0) return { status: "nothing-to-prune" };
    const affectedWorkflowIds = new Set(candidates.map((candidate) => candidate.workflowId));
    const plan = await this.journals.planTerminalPrune(candidates);
    if (plan.token !== authorizationToken) {
      return {
        status: "conflict",
        message: "Run history changed after confirmation. Review the updated cleanup plan.",
      };
    }
    const result = await this.journals.pruneTerminalRuns(plan);
    for (const runId of result.removedRunIds) {
      await this.options.assets
        .replaceReferences({ kind: "run", id: runId }, [])
        .catch(() => undefined);
    }
    await this.options.references.reconcileRuns(this.journals);
    for (const workflowId of affectedWorkflowIds) {
      this.terminalCache.delete(workflowId);
      this.notify(workflowId);
    }
    return {
      status: "pruned",
      removedRunCount: result.removedRunIds.length,
      releasedAssetCount: result.releasedAssetIds.length,
    };
  }

  async recover(
    workflowId: string,
    runId: string,
    source: "last-known-good" | "current",
    expectedCandidateJournalRevision: number,
  ): Promise<CreateImagesRunRecoveryMutationResult> {
    await this.initialize();
    if (!(await this.options.workflows.get(workflowId))) return { status: "not-found" };
    if (this.activeByRun.has(runId)) {
      return {
        status: "unavailable",
        message: "An active run cannot be recovered.",
      };
    }
    const health = await this.journals.health(runId);
    if (health.status === "missing") return { status: "not-found" };
    if (health.status === "unsafe") {
      const recovery = unsafeRecoveryView(health);
      return recovery?.workflowId === workflowId
        ? {
            status: "unsafe",
            recovery,
            message:
              "This run uses an unsupported schema or unsafe storage and cannot be recovered by this version.",
          }
        : { status: "not-found" };
    }
    if (health.status === "healthy") {
      const journal = await this.journals.get(runId);
      return journal?.workflowId === workflowId
        ? { status: "recovered", run: runView(journal) }
        : { status: "not-found" };
    }
    const recovery = recoveryRequiredView(health);
    if (!recovery || recovery.workflowId !== workflowId) return { status: "not-found" };
    const expectedSource =
      health.canRecover === "from-last-known-good"
        ? "last-known-good"
        : health.canRecover === "from-current"
          ? "current"
          : undefined;
    const currentCandidateJournalRevision =
      expectedSource === "last-known-good"
        ? health.lastKnownGoodJournalRevision
        : expectedSource === "current"
          ? health.currentJournalRevision
          : undefined;
    if (!expectedSource || currentCandidateJournalRevision === undefined) {
      return { status: "recovery-required", recovery };
    }
    if (
      expectedSource !== source ||
      currentCandidateJournalRevision !== expectedCandidateJournalRevision
    ) {
      return {
        status: "conflict",
        source,
        expectedCandidateJournalRevision,
        currentCandidateJournalRevision,
      };
    }
    let journal: CreateImagesRunJournalV1;
    try {
      journal =
        source === "last-known-good"
          ? await this.journals.recoverFromLastKnownGood(runId, expectedCandidateJournalRevision)
          : await this.journals.recoverLastKnownGoodFromCurrent(
              runId,
              expectedCandidateJournalRevision,
            );
    } catch (error) {
      if (error instanceof CreateImagesRunJournalRevisionConflictError) {
        return {
          status: "conflict",
          source,
          expectedCandidateJournalRevision,
          ...(error.actualJournalRevision === null
            ? {}
            : {
                currentCandidateJournalRevision: error.actualJournalRevision,
              }),
        };
      }
      if (error instanceof CreateImagesRunJournalLoadError) {
        const latest = await this.journals.health(runId);
        if (latest.status === "unsafe") {
          const latestRecovery = unsafeRecoveryView(latest);
          if (latestRecovery?.workflowId === workflowId) {
            return {
              status: "unsafe",
              recovery: latestRecovery,
              message:
                "This run uses an unsupported schema or unsafe storage and cannot be recovered by this version.",
            };
          }
        }
        if (latest.status === "recovery-required") {
          const latestRecovery = recoveryRequiredView(latest);
          if (latestRecovery?.workflowId === workflowId) {
            return { status: "recovery-required", recovery: latestRecovery };
          }
        }
        return {
          status: "unavailable",
          message: "The run record could not be recovered safely.",
        };
      }
      throw error;
    }
    if (journal.workflowId !== workflowId) return { status: "not-found" };
    if (!projectCreateImagesRun(journal).terminal) {
      await this.reconcileAfterRestart(journal);
      journal = (await this.journals.get(runId)) ?? journal;
    }
    this.terminalCache.delete(workflowId);
    await this.options.references.reconcileRuns(this.journals);
    this.notify(workflowId);
    return { status: "recovered", run: runView(journal) };
  }

  async isRunAssetReferenced(workflowId: string, runId: string, assetId: string): Promise<boolean> {
    const journal = await this.journals.get(runId);
    return (
      journal?.workflowId === workflowId &&
      Object.values(projectCreateImagesRun(journal).nodes).some((node) =>
        node.outputAssetIds.includes(assetId),
      )
    );
  }
}
