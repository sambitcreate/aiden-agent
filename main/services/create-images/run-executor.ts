// Runs one approved plan. Provider-agnostic: it sees only ImageGenerationPort.
// Every paid request is claimed through the ledger counter before it is sent,
// and reference bytes are read only at the Generate boundary. The executor
// never retries a provider request: a failed attempt stays failed until the
// user starts a new, separately consented run.
import type { Usage } from "@earendil-works/pi-ai";
import type { ImageGenerationPort, ImageGenerationResult } from "../../../renderer/shared/images/port.js";
import type { OutputRef, RunState } from "../../../renderer/shared/images/run-types.js";
import { IMAGE_WORKFLOW_LIMITS } from "../../../renderer/shared/images/schema.js";
import type { StudioAssetStore } from "../studio-assets/store.js";
import { ImageRunLedgerError, type AttemptFinish, type ImageRunLedger } from "./run-ledger.js";
import { runPlan, summarizeRunState, type PlannedStep, type RunPlan, type StepInputs, type StepOutcome } from "./scheduler-core.js";

export interface RunExecutorDependencies {
  ledger: Pick<ImageRunLedger, "claimProviderRequest" | "finishAttempts" | "finishRun" | "terminateRun" | "snapshot">;
  port: Pick<ImageGenerationPort, "generate">;
  assets: Pick<StudioAssetStore, "read" | "put" | "retain">;
  onChange(): void;
  onRequestStart?(): void;
  onRequestEnd?(): void;
}

export interface RunExecution {
  runId: string;
  plan: RunPlan;
  concurrency: number;
  signal: AbortSignal;
}

function cost(usage: Usage | undefined): Pick<AttemptFinish, "costUsd" | "costStatus"> {
  const total = usage?.cost?.total;
  return typeof total === "number" && Number.isFinite(total) && total > 0
    ? { costUsd: total, costStatus: "reported" }
    : { costStatus: "unavailable" };
}

/** After quit closes the ledger, late writes are dropped: shutdown already recorded the end state. */
function guarded<T>(write: () => T, fallback: T): T {
  try {
    return write();
  } catch (error) {
    if (error instanceof ImageRunLedgerError && error.code === "closed") return fallback;
    throw error;
  }
}

export async function executeRun(deps: RunExecutorDependencies, run: RunExecution): Promise<RunState> {
  const abortReason = () => (typeof run.signal.reason === "string" ? run.signal.reason : "user-cancel");
  const finish = (step: PlannedStep, update: Omit<AttemptFinish, "runId" | "nodeId" | "variant">) =>
    guarded(() => deps.ledger.finishAttempts([{ runId: run.runId, nodeId: step.nodeId, variant: step.variant, ...update }]), undefined);

  async function generate(step: PlannedStep, inputs: StepInputs, signal: AbortSignal): Promise<StepOutcome> {
    if (inputs.references.length > IMAGE_WORKFLOW_LIMITS.maxReferences) {
      finish(step, {
        state: "failed",
        errorCode: "too-many-references",
        errorMessage: `This node would send ${inputs.references.length} reference images. The limit is ${IMAGE_WORKFLOW_LIMITS.maxReferences}.`,
      });
      return { ok: false, state: "failed" };
    }
    let references: { mimeType: string; bytes: Uint8Array }[];
    try {
      references = await Promise.all(
        inputs.references.map(async (reference) => {
          const { record, bytes } = await deps.assets.read(reference.assetId);
          return { mimeType: record.mediaType, bytes };
        }),
      );
    } catch {
      finish(step, { state: "failed", errorCode: "reference-unavailable", errorMessage: "A reference image is no longer available." });
      return { ok: false, state: "failed" };
    }
    if (signal.aborted) {
      finish(step, { state: "cancelled" });
      return { ok: false, state: "cancelled" };
    }
    if (!guarded(() => deps.ledger.claimProviderRequest(run.runId, step.nodeId, step.variant), false)) {
      // The ledger also refuses a claim once a cancel was requested; that is a cancel, not a spent budget.
      if (signal.aborted) {
        finish(step, { state: "cancelled" });
        return { ok: false, state: "cancelled" };
      }
      finish(step, {
        state: "failed",
        errorCode: "request-limit",
        errorMessage: "This run already used every request it was approved for.",
      });
      return { ok: false, state: "failed" };
    }
    deps.onChange();
    deps.onRequestStart?.();
    let result: ImageGenerationResult;
    try {
      result = await deps.port.generate({
        provider: step.provider!.provider,
        model: step.provider!.model,
        prompt: inputs.prompt,
        references,
        signal,
      });
    } finally {
      deps.onRequestEnd?.();
      references = [];
    }
    if (result.kind === "failed") {
      const state = result.code === "aborted" ? "cancelled" : "failed";
      finish(step, { state, errorCode: result.code, errorMessage: result.message, ...cost(result.usage) });
      return { ok: false, state };
    }
    const output: OutputRef[] = [];
    for (const image of result.images) {
      try {
        const record = await deps.assets.put({ bytes: image.bytes, declaredMimeType: image.mimeType });
        output.push({ assetId: record.assetId, width: record.width, height: record.height, mediaType: record.mediaType });
      } catch {
        // An image the store rejects is dropped; the attempt fails below only if none survive.
      }
    }
    if (output.length === 0) {
      finish(step, {
        state: "failed",
        errorCode: "output-invalid",
        errorMessage: "The provider returned images Aiden could not store.",
        ...cost(result.usage),
      });
      return { ok: false, state: "failed" };
    }
    deps.assets.retain({ kind: "images-run", id: run.runId }, output.map((ref) => ref.assetId));
    finish(step, {
      state: "succeeded",
      output,
      truncated: result.truncated || output.length < result.images.length,
      ...cost(result.usage),
    });
    return { ok: true, value: { kind: "images", images: output } };
  }

  let states: Awaited<ReturnType<typeof runPlan>>;
  try {
    states = await runPlan(run.plan, {
      concurrency: run.concurrency,
      signal: run.signal,
      executeProvider: generate,
      onSettled: (transitions) => {
        const unrecorded = transitions
          .filter((transition) => !transition.executed)
          .map((transition) => ({
            runId: run.runId,
            nodeId: transition.nodeId,
            variant: transition.variant,
            state: transition.state,
            ...(transition.value?.kind === "images" ? { output: transition.value.images } : {}),
          }));
        guarded(() => deps.ledger.finishAttempts(unrecorded), undefined);
        deps.onChange();
      },
    });
  } catch (error) {
    // The scheduler itself failed: end every live attempt so nothing is left looking in flight.
    guarded(() => deps.ledger.terminateRun(run.runId, "failed", "executor-fault"), undefined);
    throw error;
  }

  // finishRun records a run as over; it is honest only when no attempt is still live.
  const snapshot = guarded(() => deps.ledger.snapshot(run.runId), null);
  const live = snapshot?.attempts.some((attempt) => attempt.state === "queued" || attempt.state === "running") ?? false;
  if (live) {
    const state = run.signal.aborted ? "cancelled" : "failed";
    guarded(() => deps.ledger.terminateRun(run.runId, state, run.signal.aborted ? abortReason() : "executor-fault"), undefined);
    return state;
  }
  const state = summarizeRunState(run.plan, states, run.signal.aborted);
  guarded(() => deps.ledger.finishRun(run.runId, state, run.signal.aborted ? abortReason() : undefined), undefined);
  return state;
}
