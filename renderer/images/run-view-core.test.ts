import assert from "node:assert/strict";
import test from "node:test";
import type { AttemptSnapshot, ImageRunConsentRequest, RunSnapshot } from "../shared/images/run-types";
import {
  acceptSnapshot,
  attemptDetail,
  attemptStatus,
  consentTitle,
  costLabel,
  deleteWorkflowDescription,
  formatBytes,
  outputsForNode,
  referenceSummary,
  runHeadline,
  scopeNote,
} from "./run-view-core";

const attempt = (patch: Partial<AttemptSnapshot>): AttemptSnapshot => ({
  nodeId: "g", variant: 0, state: "queued", cancelRequested: false, truncated: false, output: [], mayHaveBeenBilled: false, ...patch,
});
const snapshot = (runId: string, version: number, createdAt = 1, attempts: AttemptSnapshot[] = []): RunSnapshot => ({
  version,
  run: { runId, workflowId: "wf", workflowRevision: 1, scope: { kind: "all" }, state: "running", requestLimit: 2, requestsSent: 1, createdAt },
  attempts,
});
const ref = { assetId: "a".repeat(64), width: 8, height: 8, mediaType: "image/png" as const };

test("snapshots replace wholesale, older versions of the same run are dropped, and a newer run wins", () => {
  const v2 = snapshot("r1", 2);
  assert.equal(acceptSnapshot(v2, snapshot("r1", 1)), v2);
  assert.equal(acceptSnapshot(v2, snapshot("r1", 3)).version, 3);
  assert.equal(acceptSnapshot(v2, snapshot("r2", 1, 5)).run.runId, "r2");
  assert.equal(acceptSnapshot(snapshot("r2", 1, 5), snapshot("r1", 9, 1)).run.runId, "r2");
  assert.equal(acceptSnapshot(null, snapshot("r1", 0)).version, 0);
});

test("stopped and interrupted requests that were sent say they may have been billed", () => {
  assert.deepEqual(attemptStatus(attempt({ state: "cancelled", mayHaveBeenBilled: true })), { label: "Stopped", tone: "warning" });
  assert.match(attemptDetail(attempt({ state: "cancelled", submittedAt: 5, mayHaveBeenBilled: true })) ?? "", /may have been billed/u);
  assert.equal(attemptDetail(attempt({ state: "cancelled" })), null);
  assert.match(attemptDetail(attempt({ state: "interrupted", submittedAt: 5, mayHaveBeenBilled: true })) ?? "", /quit.*may have been billed/u);
  assert.equal(attemptDetail(attempt({ state: "failed", errorMessage: "Rate limited" })), "Rate limited");
  assert.deepEqual(attemptStatus(attempt({ state: "running", submittedAt: 1 })), { label: "Generating", tone: "blue" });
  assert.match(attemptDetail(attempt({ state: "succeeded", cancelRequested: true })) ?? "", /before Stop/u);
});

test("headlines, costs and consent copy are honest about counts and unknown prices", () => {
  assert.equal(runHeadline(snapshot("r", 1).run), "Running · 1 of 2 requests sent");
  assert.equal(runHeadline({ ...snapshot("r", 1).run, state: "cancelled", endReason: "app-quit" }), "Stopped when Aiden quit");
  assert.equal(costLabel(attempt({ state: "succeeded", submittedAt: 1, costUsd: 0.039, costStatus: "reported" })), "$0.0390 reported");
  assert.equal(costLabel(attempt({ state: "succeeded", submittedAt: 1, costStatus: "unavailable" })), "Cost not reported");
  assert.equal(costLabel(attempt({ state: "skipped" })), null);
  const request: ImageRunConsentRequest = {
    nodeId: "g", variant: 0, provider: "openrouter", providerLabel: "OpenRouter", model: "m", modelLabel: "M",
    referenceCount: 3, referenceBytes: 1_572_864, pendingReferenceCount: 1,
  };
  assert.equal(referenceSummary(request), "2 reference images (1.5 MB) + images from 1 earlier step in this run");
  assert.equal(referenceSummary({ ...request, referenceCount: 0, pendingReferenceCount: 0 }), null);
  assert.equal(formatBytes(900), "900 B");
  assert.equal(consentTitle({ totalRequests: 1 } as Parameters<typeof consentTitle>[0]), "Send 1 image request?");
  assert.equal(consentTitle({ totalRequests: 3 } as Parameters<typeof consentTitle>[0]), "Send 3 image requests?");
});

test("an Output node shows this run's images, falling back to the latest saved output", () => {
  const latest = { o: [ref] };
  assert.deepEqual(outputsForNode(null, latest, "o"), [ref]);
  const other = { ...ref, assetId: "b".repeat(64) };
  const run = snapshot("r", 1, 1, [attempt({ nodeId: "o", state: "succeeded", output: [other] })]);
  assert.deepEqual(outputsForNode(run, latest, "o"), [other]);
  assert.deepEqual(outputsForNode(run, latest, "missing"), []);
});

test("every scope's consent says which nodes will run, and node-only says what happens downstream", () => {
  assert.equal(scopeNote({ kind: "all" }), null);
  assert.match(scopeNote({ kind: "from-node", nodeId: "g" }) ?? "", /everything after it will run.*reuse their images/u);
  assert.match(scopeNote({ kind: "node-only", nodeId: "g" }) ?? "", /Only this node will run.*keep their previous images.*Out of date/u);
});

test("the delete confirmation names the image count and says it cannot be undone", () => {
  assert.doesNotMatch(deleteWorkflowDescription(0), /generated image/u);
  assert.match(deleteWorkflowDescription(1), /and 1 generated image\./u);
  assert.match(deleteWorkflowDescription(12), /and 12 generated images\./u);
  for (const count of [0, 1, 12]) {
    assert.match(deleteWorkflowDescription(count), /permanently deletes the workflow and its run history.*cannot be undone/u);
  }
});
