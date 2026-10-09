import * as React from "react";
import { createImagesIpc } from "../lib/create-images-ipc";
import type { GraphIssue } from "../shared/images/ipc-types";
import type { ImageRunConsentPlan, RunScope, RunSnapshot } from "../shared/images/run-types";
import { acceptSnapshot, ownValue, START_ERROR_MESSAGES } from "./run-view-core";

const failureText = (failure: unknown, fallback: string) => (failure instanceof Error ? failure.message : fallback);
import type { WorkflowController } from "./use-workflow-controller";

export function useImageRun(
  workflowId: string,
  controller: Pick<WorkflowController, "flush" | "addAssetUrls" | "assetUrls" | "refreshOutputs">,
) {
  const [snapshot, setSnapshot] = React.useState<RunSnapshot | null>(null);
  const [plan, setPlan] = React.useState<ImageRunConsentPlan | null>(null);
  const [issues, setIssues] = React.useState<GraphIssue[]>([]);
  const [busy, setBusy] = React.useState(false);
  const { addAssetUrls, flush, refreshOutputs, assetUrls } = controller;
  const latestSnapshot = React.useRef(snapshot);
  latestSnapshot.current = snapshot;

  // Subscribe first, then read the current snapshot: nothing between the two is lost.
  React.useEffect(() => {
    let active = true;
    const accept = (next: RunSnapshot) => {
      if (next.run.workflowId === workflowId) setSnapshot((current) => acceptSnapshot(current, next));
    };
    const unsubscribe = createImagesIpc.onRunChanged(accept);
    createImagesIpc.getRun({ workflowId }).then(
      (response) => {
        if (!active) return;
        addAssetUrls(response.assetUrls);
        if (response.snapshot) accept(response.snapshot);
      },
      (failure: unknown) => {
        if (active) setIssues([{ code: "error", message: failureText(failure, "Aiden could not read this workflow's last run.") }]);
      },
    );
    return () => {
      active = false;
      unsubscribe();
    };
  }, [workflowId, addAssetUrls]);

  // Broadcast snapshots carry asset ids only; fetch this document's grants for new outputs.
  // Read the grants through a ref so the fetch runs once per snapshot version, not per URL update.
  const grantedUrls = React.useRef(assetUrls);
  grantedUrls.current = assetUrls;
  React.useEffect(() => {
    if (!snapshot) return;
    const missing = snapshot.attempts.some((attempt) => attempt.output.some((ref) => ownValue(grantedUrls.current, ref.assetId) === undefined));
    if (!missing) return;
    createImagesIpc.getRun({ runId: snapshot.run.runId }).then(
      (response) => addAssetUrls(response.assetUrls),
      // The images stay as loading placeholders; the next snapshot or reopening the workflow asks again.
      () => undefined,
    );
  }, [snapshot?.run.runId, snapshot?.version, addAssetUrls]);

  // A settled run changes what each node last produced and which nodes are out of date
  // (a node-only retry leaves its descendants behind), so re-read both once it ends.
  const settledRunId = snapshot && snapshot.run.state !== "running" ? snapshot.run.runId : null;
  React.useEffect(() => {
    if (settledRunId) void refreshOutputs();
  }, [settledRunId, refreshOutputs]);

  // Retry from here and Retry this node only both come through here as a scope; each opens its own consent.
  const prepare = React.useCallback(
    async (scope: RunScope) => {
      setBusy(true);
      setIssues([]);
      try {
        const revision = await flush();
        if (revision === null) {
          setIssues([{ code: "unsaved", message: "Aiden could not save this workflow, so it cannot run yet." }]);
          return;
        }
        const response = await createImagesIpc.prepareRun({ workflowId, revision, scope });
        if ("issues" in response) setIssues(response.issues);
        else setPlan(response.plan);
      } catch (failure) {
        setIssues([{ code: "error", message: failureText(failure, "The run could not be prepared.") }]);
      } finally {
        setBusy(false);
      }
    },
    [flush, workflowId],
  );

  const confirm = React.useCallback(async () => {
    if (!plan) return;
    setBusy(true);
    try {
      const response = await createImagesIpc.startRun(plan.consentId);
      if ("error" in response) setIssues([{ code: response.error, message: START_ERROR_MESSAGES[response.error] }]);
    } catch (failure) {
      setIssues([{ code: "error", message: failureText(failure, "The run could not be started.") }]);
    } finally {
      setPlan(null);
      setBusy(false);
    }
  }, [plan]);

  return {
    snapshot,
    plan,
    issues,
    busy,
    running: snapshot?.run.state === "running",
    prepare: (scope: RunScope) => void prepare(scope),
    confirm: () => void confirm(),
    // Dismissing sends nothing; the unused consent expires in main.
    dismiss: () => setPlan(null),
    stop: () => {
      if (snapshot?.run.state !== "running") return;
      const stopFailed = (detail?: string) =>
        setIssues([{ code: "error", message: detail ?? "Aiden could not stop this run. Try Stop again." }]);
      createImagesIpc.cancelRun(snapshot.run.runId).then(
        (result) => {
          // A refusal for a run that has since ended is the race with its last request, not a failure.
          if (!result.ok && latestSnapshot.current?.run.runId === snapshot.run.runId && latestSnapshot.current.run.state === "running") {
            stopFailed();
          }
        },
        (failure: unknown) => stopFailed(failureText(failure, "Aiden could not stop this run. Try Stop again.")),
      );
    },
    clearIssues: () => setIssues([]),
  };
}
