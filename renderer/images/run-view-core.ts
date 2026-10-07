// Every user-facing run string lives here so its honesty rules are tested once.
import type {
  AttemptSnapshot,
  ImageRunConsentPlan,
  ImageRunConsentRequest,
  OutputRef,
  RunScope,
  RunSnapshot,
  RunSummary,
} from "../shared/images/run-types";

export function acceptSnapshot(current: RunSnapshot | null, next: RunSnapshot): RunSnapshot {
  if (!current) return next;
  if (current.run.runId !== next.run.runId) return next.run.createdAt >= current.run.createdAt ? next : current;
  return next.version >= current.version ? next : current;
}

export function attemptStatus(attempt: AttemptSnapshot): { label: string; tone: "gray" | "blue" | "green" | "red" | "warning" } {
  switch (attempt.state) {
    case "queued":
      return { label: "Waiting", tone: "gray" };
    case "running":
      return { label: attempt.submittedAt ? "Generating" : "Starting", tone: "blue" };
    case "succeeded":
      return { label: "Done", tone: "green" };
    case "failed":
      return { label: "Failed", tone: "red" };
    case "skipped":
      return { label: "Skipped", tone: "gray" };
    case "cancelled":
      return { label: "Stopped", tone: "warning" };
    case "interrupted":
      return { label: "Interrupted", tone: "warning" };
  }
}

export function attemptDetail(attempt: AttemptSnapshot): string | null {
  switch (attempt.state) {
    case "failed":
      return attempt.errorMessage ?? null;
    case "skipped":
      return "An earlier step failed.";
    case "cancelled":
      return attempt.mayHaveBeenBilled ? "Sent before Stop. It may have been billed." : null;
    case "interrupted":
      return attempt.mayHaveBeenBilled
        ? "Sent before Aiden quit. It may have been billed."
        : "Aiden quit before this was sent.";
    case "succeeded":
      if (attempt.cancelRequested) return "Finished before Stop took effect.";
      return attempt.truncated ? "Extra images were dropped." : null;
    default:
      return null;
  }
}

export function requestCountLabel(count: number): string {
  return `${count} image request${count === 1 ? "" : "s"}`;
}

export function runHeadline(run: RunSummary): string {
  switch (run.state) {
    case "running":
      return `Running · ${run.requestsSent} of ${run.requestLimit} request${run.requestLimit === 1 ? "" : "s"} sent`;
    case "succeeded":
      return "Finished";
    case "partial":
      return "Finished with errors";
    case "failed":
      return "Failed";
    case "cancelled":
      return run.endReason === "app-quit" ? "Stopped when Aiden quit" : "Stopped";
    case "interrupted":
      return "Interrupted when Aiden quit";
  }
}

export function costLabel(attempt: AttemptSnapshot): string | null {
  if (attempt.submittedAt === undefined && attempt.costStatus === undefined) return null;
  if (attempt.costStatus === "reported" && attempt.costUsd !== undefined) return `$${attempt.costUsd.toFixed(4)} reported`;
  return "Cost not reported";
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function referenceSummary(request: ImageRunConsentRequest): string | null {
  if (request.referenceCount === 0) return null;
  const known = request.referenceCount - request.pendingReferenceCount;
  const parts: string[] = [];
  if (known > 0) parts.push(`${known} reference image${known === 1 ? "" : "s"} (${formatBytes(request.referenceBytes)})`);
  if (request.pendingReferenceCount > 0) {
    const steps = request.pendingReferenceCount;
    parts.push(`images from ${steps} earlier step${steps === 1 ? "" : "s"} in this run`);
  }
  return parts.join(" + ");
}

export function consentTitle(plan: Pick<ImageRunConsentPlan, "totalRequests">): string {
  return `Send ${requestCountLabel(plan.totalRequests)}?`;
}

export type RetryScopeKind = "from-node" | "node-only";

/** The two choices after a Generate node fails (owner decision 1). Each opens its own consent. */
export const RETRY_OPTIONS: readonly { kind: RetryScopeKind; label: string; hint: string }[] = [
  { kind: "from-node", label: "Retry from here", hint: "Runs this node and everything after it again. Earlier results are reused." },
  { kind: "node-only", label: "Retry this node only", hint: "Runs just this node. Nodes after it keep their images and show Out of date until you run them." },
];

export const STALE_LABEL = "Out of date";

/** One sentence in the consent sheet saying which nodes the approved requests belong to. */
export function scopeNote(scope: RunScope): string | null {
  switch (scope.kind) {
    case "all":
      return null;
    case "from-node":
      return "This node and everything after it will run. Earlier nodes reuse their images.";
    case "node-only":
      return `Only this node will run. Nodes after it keep their previous images and show ${STALE_LABEL} until you run them.`;
  }
}

export function deleteWorkflowDescription(imageCount: number): string {
  const images = imageCount > 0 ? `, and ${imageCount} generated image${imageCount === 1 ? "" : "s"}` : "";
  return `This permanently deletes the workflow and its run history${images}. This cannot be undone. A workflow with a run in progress cannot be deleted.`;
}

export function outputsForNode(
  snapshot: RunSnapshot | null,
  latest: Readonly<Record<string, readonly OutputRef[]>>,
  nodeId: string,
): readonly OutputRef[] {
  const current = snapshot?.attempts.find((attempt) => attempt.nodeId === nodeId && attempt.state === "succeeded" && attempt.output.length > 0);
  return current?.output ?? latest[nodeId] ?? [];
}

export const START_ERROR_MESSAGES: Record<"expired" | "stale" | "model-unavailable", string> = {
  expired: "That approval expired. Choose Run again to review it.",
  stale: "The workflow changed after you reviewed it. Choose Run again to review the new plan.",
  "model-unavailable": "The chosen image model is no longer available. Choose another model.",
};
