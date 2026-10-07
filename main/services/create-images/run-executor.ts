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
  /** Receives a secondary failure that must not replace the error being thrown. */
  reportIssue?(error: unknown): void;
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

/** Observers are advisory: a throwing one must not fail a step or relabel a request. */
function observer(callback: (() => void) | undefined): () => void {
  return () => {
    try {
      callback?.();
    } catch {
      // A listener bug is not a run failure.
    }
  };
}

const FAULT_MESSAGE = "Aiden hit an internal error while running this step.";

export async function executeRun(deps: RunExecutorDependencies, run: RunExecution): Promise<RunState> {
  const changed = observer(deps.onChange);
  const requestStarted = observer(deps.onRequestStart);
  const requestEnded = observer(deps.onRequestEnd);
  // The scheduler gets this signal, not run.signal: an executor fault can then stop
  // in-flight provider requests without pretending the user cancelled.
  const internal = new AbortController();
  const relay = () => internal.abort(run.signal.reason);
  if (run.signal.aborted) relay();
  else run.signal.addEventListener("abort", relay, { once: true });
  const outstanding = new Set<Promise<unknown>>();
  const abortReason = () => (typeof run.signal.reason === "string" ? run.signal.reason : "user-cancel");
  const finish = (step: PlannedStep, update: Omit<AttemptFinish, "runId" | "nodeId" | "variant">) =>
    guarded(() => deps.ledger.finishAttempts([{ runId: run.runId, nodeId: step.nodeId, variant: step.variant, ...update }]), undefined);

  function generate(step: PlannedStep, inputs: StepInputs, signal: AbortSignal): Promise<StepOutcome> {
    const task = generateStep(step, inputs, signal);
    outstanding.add(task);
    const forget = () => outstanding.delete(task);
    task.then(forget, forget);
    return task;
  }

  async function generateStep(step: PlannedStep, inputs: StepInputs, signal: AbortSignal): Promise<StepOutcome> {
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
    changed();
    requestStarted();
    // Once the claim is spent the request may have been billed: a fault from here on is recorded
    // against this attempt, with whatever cost the provider reported, instead of escaping the step.
    let reported: Usage | undefined;
    try {
      return await sendAndStore(step, inputs, references, signal, (usage) => (reported = usage));
    } catch {
      finish(step, { state: "failed", errorCode: "executor-fault", errorMessage: FAULT_MESSAGE, ...cost(reported) });
      return { ok: false, state: "failed" };
    }
  }

  async function sendAndStore(
    step: PlannedStep,
    inputs: StepInputs,
    sentReferences: { mimeType: string; bytes: Uint8Array }[],
    signal: AbortSignal,
    reportUsage: (usage: Usage | undefined) => void,
  ): Promise<StepOutcome> {
    let references = sentReferences;
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
      requestEnded();
      references = [];
    }
    reportUsage(result.usage);
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
      signal: internal.signal,
      executeProvider: generate,
      onSettled: (transitions) => {
        const unrecorded = transitions
          .filter((transition) => !transition.executed)
          .map((transition) => ({
            runId: run.runId,
            nodeId: transition.nodeId,
            variant: transition.variant,
            state: transition.state,
            ...(transition.errorCode ? { errorCode: transition.errorCode, errorMessage: FAULT_MESSAGE } : {}),
            ...(transition.value?.kind === "images" ? { output: transition.value.images } : {}),
          }));
        guarded(() => deps.ledger.finishAttempts(unrecorded), undefined);
        changed();
      },
    });
  } catch (error) {
    // The scheduler itself failed. Stop what is still in flight, let it record its own outcome
    // (a paid request keeps its cost), and only then end every live attempt.
    internal.abort("executor-fault");
    await Promise.allSettled([...outstanding]);
    try {
      guarded(() => deps.ledger.terminateRun(run.runId, "failed", "executor-fault"), undefined);
    } catch (secondary) {
      // The original failure is the one the caller needs; this one is only reported.
      try {
        deps.reportIssue?.(secondary);
      } catch {
        // Reporting is best effort.
      }
    }
    throw error;
  } finally {
    run.signal.removeEventListener("abort", relay);
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
