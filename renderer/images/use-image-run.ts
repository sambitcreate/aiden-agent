import * as React from "react";
import { createImagesIpc } from "../lib/create-images-ipc";
import type { GraphIssue } from "../shared/images/ipc-types";
import type { ImageRunConsentPlan, RunScope, RunSnapshot } from "../shared/images/run-types";
import { acceptSnapshot, START_ERROR_MESSAGES } from "./run-view-core";
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

  // Subscribe first, then read the current snapshot: nothing between the two is lost.
  React.useEffect(() => {
    let active = true;
    const accept = (next: RunSnapshot) => {
      if (next.run.workflowId === workflowId) setSnapshot((current) => acceptSnapshot(current, next));
    };
    const unsubscribe = createImagesIpc.onRunChanged(accept);
    void createImagesIpc.getRun({ workflowId }).then((response) => {
      if (!active) return;
      addAssetUrls(response.assetUrls);
      if (response.snapshot) accept(response.snapshot);
    });
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
    const missing = snapshot.attempts.some((attempt) => attempt.output.some((ref) => !(ref.assetId in grantedUrls.current)));
    if (!missing) return;
    void createImagesIpc.getRun({ runId: snapshot.run.runId }).then((response) => addAssetUrls(response.assetUrls));
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
        setIssues([{ code: "error", message: failure instanceof Error ? failure.message : "The run could not be prepared." }]);
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
      if (snapshot?.run.state === "running") void createImagesIpc.cancelRun(snapshot.run.runId);
    },
    clearIssues: () => setIssues([]),
  };
}
