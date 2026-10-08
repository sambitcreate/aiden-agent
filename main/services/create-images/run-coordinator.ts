// The consent-gated front of Create Images runs. Provider-agnostic: it sees
// ImageGenerationPort, the ledger, the studio assets and the workflow store.
import { randomUUID } from "node:crypto";
import type { ImageGenerationPort, ImageModelOption } from "../../../renderer/shared/images/port.js";
import type {
  ImageRunConsentPlan,
  OutputRef,
  RunScope,
  RunSnapshot,
  RunSummary,
} from "../../../renderer/shared/images/run-types.js";
import { IMAGE_WORKFLOW_LIMITS, type WorkflowDocV1 } from "../../../renderer/shared/images/schema.js";
import { createThrottledTrigger } from "../portable-config-watch-core.js";
import type { StudioAssetStore } from "../studio-assets/store.js";
import { RunConsentStore } from "./consent-core.js";
import { executeRun } from "./run-executor.js";
import { RUN_RETENTION, type ImageRunLedger } from "./run-ledger.js";
import { clampRunConcurrency, planDigest, planRun, staleNodeIds, type PlanIssue, type RunPlan } from "./scheduler-core.js";
import type { ImageWorkflowStore } from "./workflow-store.js";

export type PrepareRunResult = { plan: ImageRunConsentPlan } | { issues: PlanIssue[] };
export type StartRunResult = { runId: string } | { error: "expired" | "stale" | "model-unavailable" };

export interface RunCoordinatorDependencies {
  ledger: ImageRunLedger;
  port: ImageGenerationPort;
  assets: Pick<StudioAssetStore, "get" | "read" | "put" | "retain" | "releaseAllForHolder">;
  workflows: Pick<ImageWorkflowStore, "get" | "delete" | "imageInputAssets">;
  notify(snapshot: RunSnapshot): void;
  /** Receives failures that have no caller to throw to: a run that crashed, a ledger that would not close. */
  reportIssue?(message: string, error: unknown): void;
  now?: () => number;
  newId?: () => string;
  throttleMs?: number;
  maxRequestsPerRun?: number;
  retainRuns?: number;
}

interface ActiveRun {
  runId: string;
  workflowId: string;
  controller: AbortController;
  trigger: { trigger(): void; dispose(): void };
  done: Promise<void>;
}

function findModel(models: readonly ImageModelOption[], provider: string, model: string) {
  return models.find((option) => option.provider === provider && option.model === model);
}

/** The owner caps are enforced here whatever the caller or a stored document asks for. */
const MAX_REQUESTS = IMAGE_WORKFLOW_LIMITS.maxRequestsPerRun;

function refused(code: string, message: string): PrepareRunResult {
  return { issues: [{ code, message }] };
}

export class ImageRunCoordinator {
  private readonly consents: RunConsentStore<{ digest: string }>;
  private readonly active = new Map<string, ActiveRun>();
  private readonly starting = new Set<string>();
  private readonly deleting = new Set<string>();
  private readonly versions = new Map<string, number>();
  private readonly newId: () => string;
  /**
   * Requests between their ledger claim and the port's answer. After an executor fault gives up on a
   * provider that ignores the abort, that request stays counted until it answers (or the app quits),
   * so the quit prompt may over-count rather than hide a request that could still be billed.
   */
  private inFlight = 0;
  private closed = false;

  constructor(private readonly deps: RunCoordinatorDependencies) {
    this.newId = deps.newId ?? randomUUID;
    this.consents = new RunConsentStore(deps.now ? { now: deps.now } : {});
  }

  /** The restart boundary: unfinished work becomes interrupted history, then retention runs. */
  recoverAfterRestart(): string[] {
    const interrupted = this.deps.ledger.interruptInFlight();
    this.prune();
    return interrupted;
  }

  async prepare(
    ownerKey: string,
    request: { workflowId: string; revision: number; scope: RunScope },
  ): Promise<PrepareRunResult> {
    this.requireOpen();
    const doc = await this.deps.workflows.get(request.workflowId);
    if (!doc) return refused("unknown_workflow", "This workflow no longer exists.");
    if (doc.revision !== request.revision) return refused("stale_revision", "Aiden is still saving this workflow. Try again.");
    if (this.deleting.has(doc.id)) return refused("workflow_deleting", "This workflow is being deleted.");
    if (this.hasActiveRun(doc.id)) return refused("run_in_progress", "A run is already in progress for this workflow.");
    const planned = this.plan(doc, request.scope);
    if (!planned.ok) return { issues: planned.issues };
    const models = await this.deps.port.listModels();
    const missing = planned.plan.requests.filter((item) => !findModel(models, item.provider, item.model));
    if (missing.length > 0) {
      return {
        issues: missing.map((item) => ({
          code: "model_unavailable",
          nodeId: item.nodeId,
          message: "This image model is not available. Choose another model, or add its provider in Settings → Providers.",
        })),
      };
    }
    const plan = this.consents.issue(
      ownerKey,
      {
        workflowId: doc.id,
        workflowRevision: doc.revision,
        scope: request.scope,
        requests: planned.plan.requests.map((item) => {
          const option = findModel(models, item.provider, item.model)!;
          return {
            nodeId: item.nodeId,
            variant: item.variant,
            provider: item.provider,
            providerLabel: option.providerLabel,
            model: item.model,
            modelLabel: option.label,
            referenceCount: item.referenceCount,
            referenceBytes: item.knownReferences.reduce((sum, ref) => sum + (this.deps.assets.get(ref.assetId)?.bytes ?? 0), 0),
            pendingReferenceCount: item.pendingReferenceCount,
          };
        }),
        totalRequests: planned.plan.requests.length,
        estimate: { kind: "unknown" },
      },
      { digest: planDigest(planned.plan) },
    );
    return { plan };
  }

  async start(ownerKey: string, consentId: string): Promise<StartRunResult> {
    this.requireOpen();
    const consent = this.consents.consume(consentId, ownerKey);
    if (!consent.ok) return { error: "expired" };
    const workflowId = consent.plan.workflowId;
    if (this.deleting.has(workflowId) || this.hasActiveRun(workflowId)) return { error: "stale" };
    this.starting.add(workflowId);
    try {
      const doc = await this.deps.workflows.get(workflowId);
      if (!doc || doc.revision !== consent.plan.workflowRevision) return { error: "stale" };
      const planned = this.plan(doc, consent.plan.scope);
      if (!planned.ok || planDigest(planned.plan) !== consent.internal.digest) return { error: "stale" };
      const models = await this.deps.port.listModels();
      if (planned.plan.requests.some((item) => !findModel(models, item.provider, item.model))) {
        return { error: "model-unavailable" };
      }
      if (this.closed) return { error: "stale" };
      return { runId: this.launch(doc, planned.plan, consent.plan.totalRequests) };
    } finally {
      this.starting.delete(workflowId);
    }
  }

  cancel(runId: string): boolean {
    const run = this.active.get(runId);
    if (!run) return false;
    // Back to back, nothing awaited between them: once the ledger refuses new claims the signal is
    // already aborted, so a request cannot slip out in between. The abort happens even if the ledger
    // throws; the failure is reported, and the run is still stopped.
    try {
      this.deps.ledger.requestCancel(runId);
    } catch (error) {
      this.deps.reportIssue?.(`Could not record the stop of image run ${runId}.`, error);
    }
    run.controller.abort("user-cancel");
    run.trigger.trigger();
    return true;
  }

  getRun(query: { runId: string } | { workflowId: string }): RunSnapshot | null {
    const runId = "runId" in query ? query.runId : this.deps.ledger.latestRunId(query.workflowId);
    if (!runId) return null;
    const body = this.deps.ledger.snapshot(runId);
    return body ? { version: this.versions.get(runId) ?? 0, ...body } : null;
  }

  listRuns(workflowId: string, limit: number): RunSummary[] {
    return this.deps.ledger.listRuns(workflowId, limit);
  }

  latestOutputs(workflowId: string): Record<string, OutputRef[]> {
    return this.deps.ledger.latestOutputs(workflowId);
  }

  /** Nodes whose output is older than a newer upstream Generate result, e.g. after a node-only run. */
  staleNodeIds(doc: WorkflowDocV1): string[] {
    return staleNodeIds(doc, this.deps.ledger.latestOutputSequence(doc.id));
  }

  /** Distinct images per workflow: what its runs generated plus its Image Input assets. Each is released on delete. */
  async imageCounts(): Promise<Record<string, number>> {
    const found = new Map<string, Set<string>>();
    const add = (byWorkflow: Record<string, string[]>) => {
      for (const [workflowId, assetIds] of Object.entries(byWorkflow)) {
        const ids = found.get(workflowId) ?? new Set<string>();
        for (const assetId of assetIds) ids.add(assetId);
        found.set(workflowId, ids);
      }
    };
    add(this.deps.ledger.imageAssetIds());
    add(await this.deps.workflows.imageInputAssets());
    return Object.fromEntries([...found].filter(([, ids]) => ids.size > 0).map(([workflowId, ids]) => [workflowId, ids.size]));
  }

  hasActiveRun(workflowId: string): boolean {
    return this.starting.has(workflowId) || [...this.active.values()].some((run) => run.workflowId === workflowId);
  }

  inFlightRequests(): number {
    return this.inFlight;
  }

  /**
   * Deletes a workflow and its run history. Refused while a run is starting or running, and a start is
   * refused while the delete is in flight, so no run can begin on a document that is going away.
   */
  async deleteWorkflow(workflowId: string): Promise<"deleted" | "not-found" | "busy"> {
    this.requireOpen();
    if (this.deleting.has(workflowId) || this.hasActiveRun(workflowId)) return "busy";
    this.deleting.add(workflowId);
    try {
      // History first: if the ledger fails, nothing was removed and the workflow is intact. If the
      // document delete then fails, the workflow remains with an empty history, which holds nothing.
      this.releaseRuns(this.deps.ledger.deleteWorkflowRuns(workflowId), `deleting workflow ${workflowId}`);
      try {
        return (await this.deps.workflows.delete(workflowId)) ? "deleted" : "not-found";
      } catch (error) {
        this.deps.reportIssue?.(`Could not delete workflow ${workflowId} after clearing its runs.`, error);
        throw error;
      }
    } finally {
      this.deleting.delete(workflowId);
    }
  }

  /** Quit: abort everything and record the end now; requests already sent may still be billed. */
  async shutdown(reason = "app-quit"): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      for (const run of this.active.values()) {
        run.trigger.dispose();
        run.controller.abort(reason);
        try {
          this.deps.ledger.terminateRun(run.runId, "cancelled", reason);
        } catch (error) {
          this.deps.reportIssue?.(`Could not record the end of image run ${run.runId}.`, error);
        }
      }
      this.active.clear();
    } finally {
      this.deps.ledger.close();
    }
  }

  /** Resolves once every active run has settled. Used by tests and by the perf lane. */
  async whenIdle(): Promise<void> {
    while (this.active.size > 0) await Promise.all([...this.active.values()].map((run) => run.done));
  }

  private launch(doc: WorkflowDocV1, plan: RunPlan, requestLimit: number): string {
    const runId = this.newId();
    const limit = Math.min(requestLimit, MAX_REQUESTS);
    this.deps.ledger.createRun({
      runId,
      workflowId: doc.id,
      workflowRevision: doc.revision,
      scope: plan.scope,
      requestLimit: limit,
      attempts: plan.steps.map((step) => ({
        nodeId: step.nodeId,
        variant: step.variant,
        ...(step.provider ? { provider: step.provider.provider, model: step.provider.model } : {}),
      })),
    });
    const controller = new AbortController();
    const trigger = createThrottledTrigger(() => this.publish(runId), this.deps.throttleMs ?? 250);
    const run: ActiveRun = { runId, workflowId: doc.id, controller, trigger, done: Promise.resolve() };
    this.active.set(runId, run);
    this.publish(runId);
    run.done = executeRun(
      {
        ledger: this.deps.ledger,
        port: this.deps.port,
        assets: this.deps.assets,
        onChange: () => trigger.trigger(),
        onRequestStart: () => {
          this.inFlight += 1;
        },
        onRequestEnd: () => {
          this.inFlight -= 1;
        },
        ...(this.deps.reportIssue ? { reportIssue: (error: unknown) => this.deps.reportIssue!("An image run hit a secondary failure.", error) } : {}),
      },
      { runId, plan, concurrency: clampRunConcurrency(doc.settings.concurrency), signal: controller.signal },
    )
      .then(
        () => undefined,
        (error: unknown) => {
          // Quitting aborts the run and closes the ledger under it; that is not an internal error.
          if (this.closed) return;
          this.deps.reportIssue?.(`Image run ${runId} stopped on an internal error.`, error);
          try {
            // A no-op when the executor already ended the run; otherwise the run must not stay "running".
            this.deps.ledger.terminateRun(runId, "failed", "internal-error");
          } catch (secondary) {
            this.deps.reportIssue?.(`Could not record the end of image run ${runId}.`, secondary);
          }
        },
      )
      .finally(() => {
        trigger.dispose();
        this.active.delete(runId);
        if (this.closed) return;
        this.publish(runId); // terminal snapshot: never lost to the throttle's dispose()
        this.prune();
      });
    return runId;
  }

  /** Progress is advisory: a snapshot or listener failure is reported and never strands a run or a workflow. */
  private publish(runId: string): void {
    if (this.closed) return;
    try {
      const body = this.deps.ledger.snapshot(runId);
      if (!body) return;
      const version = (this.versions.get(runId) ?? 0) + 1;
      this.versions.set(runId, version);
      this.deps.notify({ version, ...body });
    } catch (error) {
      this.deps.reportIssue?.(`Could not publish progress for image run ${runId}.`, error);
    }
  }

  private plan(doc: WorkflowDocV1, scope: RunScope) {
    return planRun(doc, scope, {
      priorOutputs: this.deps.ledger.latestOutputs(doc.id),
      asset: (assetId) => {
        const record = this.deps.assets.get(assetId);
        return record ? { assetId, width: record.width, height: record.height, mediaType: record.mediaType } : undefined;
      },
      maxRequests: Math.min(this.deps.maxRequestsPerRun ?? MAX_REQUESTS, MAX_REQUESTS),
    });
  }

  private prune(): void {
    try {
      this.releaseRuns(this.deps.ledger.pruneRuns(this.deps.retainRuns ?? RUN_RETENTION), "pruning old runs");
    } catch (error) {
      this.deps.reportIssue?.("Could not prune old image runs.", error);
    }
  }

  /** Releases every run's holds. One failing release is reported and never strands the runs after it. */
  private releaseRuns(runIds: readonly string[], context: string): void {
    for (const runId of runIds) {
      try {
        this.deps.assets.releaseAllForHolder({ kind: "images-run", id: runId });
      } catch (error) {
        this.deps.reportIssue?.(`Could not release the images held by run ${runId} while ${context}.`, error);
      } finally {
        this.versions.delete(runId);
      }
    }
  }

  private requireOpen(): void {
    if (this.closed) throw new Error("Create Images is shutting down.");
  }
}
