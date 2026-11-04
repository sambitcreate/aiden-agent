import assert from "node:assert/strict";
import { test } from "node:test";
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
