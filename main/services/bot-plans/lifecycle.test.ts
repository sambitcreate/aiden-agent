import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createBotPlans } from "./plans.js";
import { botPlanProposalFingerprint } from "./validate.js";
import { createBotPlanLifecycle } from "./lifecycle.js";

test("initial idle reads preserve recoverable plans, and observed running to idle ends them", () => {
  const ended: string[] = [];
  const lifecycle = createBotPlanLifecycle({ plans: { endRuns: async (id, reason) => { ended.push(`${id}:${reason}`); } } });
  lifecycle.stateChanged("b", { kind: "idle" });
  assert.deepEqual(ended, []);
  lifecycle.stateChanged("b", { kind: "running" });
  lifecycle.stateChanged("b", { kind: "idle" });
  lifecycle.stateChanged("b", { kind: "idle" });
  assert.deepEqual(ended, ["b:finished"]);
});

test("actual projection settlement ends a plan even without a published running state", () => {
  const ended: string[] = [];
  const lifecycle = createBotPlanLifecycle({ plans: { endRuns: async (id, reason) => { ended.push(`${id}:${reason}`); } } });
  lifecycle.settled("b", { kind: "idle" });
  assert.deepEqual(ended, ["b:finished"]);
});

test("Stop clears the observed run and no later idle read changes it to finished", () => {
  const ended: string[] = [];
  const lifecycle = createBotPlanLifecycle({ plans: { endRuns: async (id, reason) => { ended.push(`${id}:${reason}`); } } });
  lifecycle.stateChanged("b", { kind: "running" });
  lifecycle.stopped("b");
  lifecycle.stateChanged("b", { kind: "idle" });
  assert.deepEqual(ended, ["b:stopped"]);
});

test("termination failures are reported without an unhandled rejection or a blocked caller", async () => {
  const failure = new Error("store unavailable"), reports: unknown[] = [];
  const lifecycle = createBotPlanLifecycle({ plans: { endRuns: async () => { throw failure; } }, onError: (_id, error) => reports.push(error) });
  assert.equal(lifecycle.stopped("b"), undefined);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(reports, [failure]);
});

test("forget and shutdown clear observed runs without ending persisted approvals", () => {
  const ended: string[] = [];
  const lifecycle = createBotPlanLifecycle({ plans: { endRuns: async (id, reason) => { ended.push(`${id}:${reason}`); } } });
  lifecycle.stateChanged("b", { kind: "running" });
  lifecycle.forget("b");
  lifecycle.stateChanged("b", { kind: "idle" });
  lifecycle.stateChanged("c", { kind: "running" });
  lifecycle.clear();
  lifecycle.stateChanged("c", { kind: "idle" });
  assert.deepEqual(ended, []);
});


for (const terminal of ["needs_model", "model_error"] as const) {
  test(`an observed run ending ${terminal} finishes its real plan, while initial/recoverable states preserve it`, async () => {
    const profileDir = await mkdtemp(path.join(tmpdir(), "plan-terminal-model-"));
    const revoked: string[] = [];
    const plans = createBotPlans({ profileDir, knownBot: async () => true, revalidate: async () => {}, revokeAccess: (_botId, planId) => revoked.push(planId) });
    try {
      const proposal = { title: "Prepare a report", why: "Review the notes", steps: ["Read notes", "Write a report"], items: [{ id: "i1", kind: "shell" as const }],
        authorization: { policyRevision: "policy-1", bindingRevision: "binding-1", proposalFingerprint: "", rules: [] } };
      proposal.authorization.proposalFingerprint = botPlanProposalFingerprint(proposal);
      const waiting = plans.request({ botId: "b", planId: "p1", toolCallId: "plan-call", requestIds: ["person-1"], proposal, signal: undefined });
      await plans.current("b");
      await plans.respond("b", "p1", "approve");
      assert.equal((await waiting).status, "approved");
      const lifecycle = createBotPlanLifecycle({ plans });
      lifecycle.stateChanged("b", { kind: terminal });
      assert.equal((await plans.current("b"))?.status, "active", "an initial model-state read cannot discard recoverable approval");
      lifecycle.stateChanged("b", { kind: "running" });
      lifecycle.stateChanged("b", { kind: "paused" });
      lifecycle.settled("b", { kind: "interrupted" });
      assert.equal((await plans.current("b"))?.status, "active", "pause and interruption preserve recovery");
      lifecycle.stateChanged("b", { kind: terminal });
      assert.equal((await plans.current("b"))?.status, "finished");
      assert.deepEqual(revoked, ["p1"]);
    } finally { await rm(profileDir, { recursive: true, force: true }); }
  });
  test(`actual projection settlement at ${terminal} ends the run without an observed running event`, () => {
    const ended: string[] = [];
    const lifecycle = createBotPlanLifecycle({ plans: { endRuns: async (id, reason) => { ended.push(`${id}:${reason}`); } } });
    lifecycle.settled("b", { kind: terminal });
    assert.deepEqual(ended, ["b:finished"]);
  });
}
