// Runs one approved plan. Provider-agnostic: it sees only ImageGenerationPort.
// Every local check (references, model, storage room) runs before the ledger
// claim, so a local refusal is never recorded as sent; every paid request is
// claimed through the ledger counter before it is sent, and reference bytes
// are read only at the Generate boundary. The executor
// never retries a provider request: a failed attempt stays failed until the
// user starts a new, separately consented run.
import type { Usage } from "@earendil-works/pi-ai";
import type { ImageGenerationPort, ImageGenerationResult } from "../../../renderer/shared/images/port.js";
import type { OutputRef, RunState } from "../../../renderer/shared/images/run-types.js";
import { IMAGE_WORKFLOW_LIMITS } from "../../../renderer/shared/images/schema.js";
import { STUDIO_ASSET_LIMITS, StudioAssetError, type StudioAssetLimits } from "../studio-assets/contract.js";
import type { StudioAssetStore } from "../studio-assets/store.js";
import { ImageRunLedgerError, type AttemptFinish, type ImageRunLedger } from "./run-ledger.js";
import { runPlan, summarizeRunState, type PlannedStep, type RunPlan, type StepInputs, type StepOutcome } from "./scheduler-core.js";

export interface RunExecutorDependencies {
  ledger: Pick<ImageRunLedger, "claimProviderRequest" | "finishAttempts" | "finishRun" | "terminateRun" | "snapshot">;
  port: Pick<ImageGenerationPort, "preflight">;
  /** Without `usage` the storage headroom check is skipped; without `release` a fault after retain leaves the hold for pruning. */
  assets: Pick<StudioAssetStore, "read" | "put" | "retain"> & Partial<Pick<StudioAssetStore, "usage" | "release">>;
  /** The asset store's capacity, for the headroom check. Defaults to STUDIO_ASSET_LIMITS. */
  storageLimits?: Pick<StudioAssetLimits, "maxAssets" | "maxTotalBytes">;
  onChange(): void;
  onRequestStart?(): void;
  onRequestEnd?(): void;
  /** Receives a secondary failure that must not replace the error being thrown. */
  reportIssue?(error: unknown): void;
  /** How long an executor fault waits for provider requests that ignore the abort. Defaults to 10 s. */
  faultWaitMs?: number;
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

const DEFAULT_FAULT_WAIT_MS = 10_000;
const FAULT_MESSAGE = "Aiden hit an internal error while running this step.";

/** The most one request can add to the asset store: the port keeps at most 4 images and 8 MiB in all. */
const WORST_CASE_OUTPUT = { assets: 4, bytes: 8 * 1024 * 1024 } as const;

export const STORAGE_FULL_UNSENT =
  "Aiden's image storage is full, so this request was not sent. Delete unused workflows or Design Studio projects to free space.";
export const STORAGE_FAILED_UNSENT = "Aiden's image storage is unavailable, so this request was not sent.";
export const STORAGE_FULL_AFTER_SEND =
  "The image was generated and may have been billed, but Aiden's image storage is full, so it could not be kept. Delete unused workflows or Design Studio projects to free space.";
export const STORAGE_FAILED_AFTER_SEND =
  "The image was generated and may have been billed, but Aiden could not save it to image storage.";

type PutFailure = "invalid" | "storage-full" | "storage-failed";

/** Only image bytes the store rejects as an image are invalid output; anything else is the store failing. */
function classifyPutFailure(error: unknown): PutFailure {
  if (error instanceof StudioAssetError) {
    if (error.code === "invalid_image" || error.code === "too_large") return "invalid";
    if (error.code === "quota") return "storage-full";
  }
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOSPC" || code === "EDQUOT" ? "storage-full" : "storage-failed";
}

/** Waits for the tasks, but not past `ms`: a provider that ignores the abort must not hold the run open. */
async function settleOrGiveUp(tasks: Promise<unknown>[], ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  try {
    await Promise.race([Promise.allSettled(tasks), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

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
  // An abort the user asked for is a cancel. The executor's own fault abort is a failure.
  const stopped = (): { state: "cancelled" } | { state: "failed"; errorCode: string; errorMessage: string } =>
    run.signal.aborted
      ? { state: "cancelled" }
      : { state: "failed", errorCode: "executor-fault", errorMessage: FAULT_MESSAGE };
  const finish = (step: PlannedStep, update: Omit<AttemptFinish, "runId" | "nodeId" | "variant">) =>
    guarded(() => deps.ledger.finishAttempts([{ runId: run.runId, nodeId: step.nodeId, variant: step.variant, ...update }]), undefined);

  function generate(step: PlannedStep, inputs: StepInputs, signal: AbortSignal): Promise<StepOutcome> {
    const task = generateStep(step, inputs, signal);
    outstanding.add(task);
    const forget = () => outstanding.delete(task);
    task.then(forget, forget);
    return task;
  }

  const report = (error: unknown) => {
    try {
      deps.reportIssue?.(error);
    } catch {
      // Reporting is best effort.
    }
  };
  /** Assets this run already holds, so a fault on one attempt never releases another's hold. */
  const held = new Set<string>();
  const attemptLive = (step: PlannedStep) =>
    guarded(() => deps.ledger.snapshot(run.runId), null)?.attempts.some(
      (attempt) => attempt.nodeId === step.nodeId && attempt.variant === step.variant && attempt.state === "running",
    ) ?? false;

  /** Refuses locally when the store clearly cannot keep one more request's worst-case output. */
  function storageRefusal(): Pick<AttemptFinish, "errorCode" | "errorMessage"> | undefined {
    if (!deps.assets.usage) return undefined;
    const limits = deps.storageLimits ?? STUDIO_ASSET_LIMITS;
    let usage: { assets: number; bytes: number };
    try {
      usage = deps.assets.usage();
    } catch {
      return { errorCode: "storage-failed", errorMessage: STORAGE_FAILED_UNSENT };
    }
    return usage.assets + WORST_CASE_OUTPUT.assets > limits.maxAssets || usage.bytes + WORST_CASE_OUTPUT.bytes > limits.maxTotalBytes
      ? { errorCode: "storage-full", errorMessage: STORAGE_FULL_UNSENT }
      : undefined;
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
      const update = stopped();
      finish(step, update);
      return { ok: false, state: update.state };
    }
    const noRoom = storageRefusal();
    if (noRoom) {
      finish(step, { state: "failed", ...noRoom });
      return { ok: false, state: "failed" };
    }
    // Every check the port can make without the network, before anything is claimed.
    const checked = await deps.port.preflight({
      provider: step.provider!.provider,
      model: step.provider!.model,
      prompt: inputs.prompt,
      references,
      signal,
    });
    references = [];
    if (checked.kind === "failed") {
      const update = checked.code === "aborted" || signal.aborted ? stopped() : undefined;
      finish(step, update ?? { state: "failed", errorCode: checked.code, errorMessage: checked.message });
      return { ok: false, state: update?.state ?? "failed" };
    }
    if (!guarded(() => deps.ledger.claimProviderRequest(run.runId, step.nodeId, step.variant), false)) {
      // The ledger also refuses a claim once a cancel was requested; that is a cancel, not a spent budget.
      if (signal.aborted) {
        const update = stopped();
        finish(step, update);
        return { ok: false, state: update.state };
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
      return await sendAndStore(step, checked.send, (usage) => (reported = usage));
    } catch {
      finish(step, { state: "failed", errorCode: "executor-fault", errorMessage: FAULT_MESSAGE, ...cost(reported) });
      return { ok: false, state: "failed" };
    }
  }

  async function sendAndStore(
    step: PlannedStep,
    send: () => Promise<ImageGenerationResult>,
    reportUsage: (usage: Usage | undefined) => void,
  ): Promise<StepOutcome> {
    let result: ImageGenerationResult;
    try {
      result = await send();
    } finally {
      requestEnded();
    }
    reportUsage(result.usage);
    if (result.kind === "failed") {
      if (result.code === "aborted") {
        const update = stopped();
        const detail = update.state === "cancelled" ? { errorCode: result.code, errorMessage: result.message } : update;
        finish(step, { ...detail, state: update.state, ...cost(result.usage) });
        return { ok: false, state: update.state };
      }
      finish(step, { state: "failed", errorCode: result.code, errorMessage: result.message, ...cost(result.usage) });
      return { ok: false, state: "failed" };
    }
    const output: OutputRef[] = [];
    let storageFailure: Exclude<PutFailure, "invalid"> | undefined;
    for (const image of result.images) {
      try {
        const record = await deps.assets.put({ bytes: image.bytes, declaredMimeType: image.mimeType });
        output.push({ assetId: record.assetId, width: record.width, height: record.height, mediaType: record.mediaType });
      } catch (error) {
        // An image the store rejects as invalid is dropped. A full or failing store is not the
        // provider's fault: the paid image is reported, never silently relabelled as bad output.
        const failure = classifyPutFailure(error);
        if (failure === "invalid") continue;
        if (storageFailure !== "storage-full") storageFailure = failure;
        report(error);
      }
    }
    if (output.length === 0) {
      finish(step, {
        state: "failed",
        ...(storageFailure === "storage-full"
          ? { errorCode: "storage-full", errorMessage: STORAGE_FULL_AFTER_SEND }
          : storageFailure === "storage-failed"
            ? { errorCode: "storage-failed", errorMessage: STORAGE_FAILED_AFTER_SEND }
            : { errorCode: "output-invalid", errorMessage: "The provider returned images Aiden could not store." }),
        ...cost(result.usage),
      });
      return { ok: false, state: "failed" };
    }
    // A result that arrives after the run already ended (an executor fault gave up waiting, or quit)
    // cannot be recorded; holding its images would pin them to a run that never names them.
    if (!attemptLive(step)) {
      report(new Error(`An image for run ${run.runId} arrived after the run ended and was not kept.`));
      return { ok: false, state: "failed" };
    }
    const holder = { kind: "images-run" as const, id: run.runId };
    const added = [...new Set(output.map((ref) => ref.assetId))].filter((assetId) => !held.has(assetId));
    deps.assets.retain(holder, added);
    try {
      finish(step, {
        state: "succeeded",
        output,
        truncated: result.truncated || output.length < result.images.length,
        ...cost(result.usage),
      });
    } catch (error) {
      // The attempt could not record these images, so this attempt must not keep them held.
      try {
        deps.assets.release?.(holder, added);
      } catch (secondary) {
        report(secondary);
      }
      throw error;
    }
    for (const assetId of added) held.add(assetId);
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
    await settleOrGiveUp([...outstanding], deps.faultWaitMs ?? DEFAULT_FAULT_WAIT_MS);
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
