import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import type { OutputRef } from "../../../renderer/shared/images/run-types.js";
import { ImageRunLedger, type CreateRunInput } from "./run-ledger.js";

async function directory(t: TestContext): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-image-ledger-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function open(root: string, t: TestContext): ImageRunLedger {
  let clock = 1_000;
  const ledger = ImageRunLedger.open({ directory: root, now: () => (clock += 1) });
  t.after(() => ledger.close());
  return ledger;
}

const run = (overrides: Partial<CreateRunInput> = {}): CreateRunInput => ({
  runId: "run-1",
  workflowId: "wf",
  workflowRevision: 3,
  scope: { kind: "all" },
  requestLimit: 2,
  attempts: [
    { nodeId: "p", variant: 0 },
    { nodeId: "g1", variant: 0, provider: "openrouter", model: "google/gemini-3.1-flash-image" },
    { nodeId: "g2", variant: 0, provider: "openrouter", model: "google/gemini-3.1-flash-image" },
  ],
  ...overrides,
});
const out = (seed: string): OutputRef => ({ assetId: seed.repeat(64), width: 8, height: 8, mediaType: "image/png" });

test("a run and its attempts round-trip into a snapshot", async (t) => {
  const ledger = open(await directory(t), t);
  ledger.createRun(run({ scope: { kind: "from-node", nodeId: "g1" } }));
  const snapshot = ledger.snapshot("run-1");
  assert.deepEqual(snapshot?.run, {
    runId: "run-1", workflowId: "wf", workflowRevision: 3, scope: { kind: "from-node", nodeId: "g1" },
    state: "running", requestLimit: 2, requestsSent: 0, createdAt: 1_001,
  });
  assert.deepEqual(snapshot?.attempts.map((attempt) => [attempt.nodeId, attempt.state, attempt.mayHaveBeenBilled]), [
    ["p", "queued", false], ["g1", "queued", false], ["g2", "queued", false],
  ]);
  assert.equal(ledger.snapshot("missing"), null);
});

test("from-node and node-only scopes round-trip with their node, and a scope the table does not know is refused", async (t) => {
  const ledger = open(await directory(t), t);
  ledger.createRun(run({ runId: "r-here", scope: { kind: "from-node", nodeId: "g1" } }));
  ledger.createRun(run({ runId: "r-only", scope: { kind: "node-only", nodeId: "g2" } }));
  assert.deepEqual(ledger.snapshot("r-here")!.run.scope, { kind: "from-node", nodeId: "g1" });
  assert.deepEqual(ledger.snapshot("r-only")!.run.scope, { kind: "node-only", nodeId: "g2" });
  assert.deepEqual(ledger.snapshot("r-here")!.attempts.length, 3);
  assert.throws(() => ledger.createRun(run({ runId: "r-bad", scope: { kind: "everything" } as never })));
});

test("claims are bounded by the request limit and record submission first", async (t) => {
  const ledger = open(await directory(t), t);
  ledger.createRun(run({ requestLimit: 2 }));
  assert.equal(ledger.claimProviderRequest("run-1", "g1", 0), true);
  // The limit (2) is not reached, so this claim passes the counter and fails on the
  // attempt, which is already running. The increment must roll back with it.
  assert.equal(ledger.claimProviderRequest("run-1", "g1", 0), false);
  assert.equal(ledger.snapshot("run-1")!.run.requestsSent, 1);
  assert.equal(ledger.claimProviderRequest("run-1", "g2", 0), true);
  // The limit is now reached: a third request is refused and its attempt stays queued.
  assert.equal(ledger.claimProviderRequest("run-1", "p", 0), false);
  const snapshot = ledger.snapshot("run-1")!;
  assert.equal(snapshot.run.requestsSent, 2);
  const byNode = new Map(snapshot.attempts.map((attempt) => [attempt.nodeId, attempt]));
  assert.equal(byNode.get("g1")?.state, "running");
  assert.equal(typeof byNode.get("g1")?.submittedAt, "number");
  assert.equal(byNode.get("g2")?.state, "running");
  assert.equal(byNode.get("p")?.state, "queued");
  assert.equal(byNode.get("p")?.submittedAt, undefined);
});

test("terminal attempts are never overwritten and cancel requests mark live attempts only", async (t) => {
  const ledger = open(await directory(t), t);
  ledger.createRun(run());
  ledger.claimProviderRequest("run-1", "g1", 0);
  ledger.finishAttempts([
    { runId: "run-1", nodeId: "g1", variant: 0, state: "succeeded", output: [out("a")], costUsd: 0.039, costStatus: "reported" },
  ]);
  ledger.finishAttempts([{ runId: "run-1", nodeId: "g1", variant: 0, state: "cancelled" }]);
  ledger.requestCancel("run-1");
  const attempts = new Map(ledger.snapshot("run-1")!.attempts.map((attempt) => [attempt.nodeId, attempt]));
  assert.equal(attempts.get("g1")?.state, "succeeded");
  assert.deepEqual(attempts.get("g1")?.output, [out("a")]);
  assert.equal(attempts.get("g1")?.costUsd, 0.039);
  assert.equal(attempts.get("g1")?.cancelRequested, false);
  assert.equal(attempts.get("g2")?.cancelRequested, true);
});

test("a restart marks queued and running work interrupted and never revives it", async (t) => {
  const root = await directory(t);
  const before = ImageRunLedger.open({ directory: root });
  before.createRun(run());
  before.claimProviderRequest("run-1", "g1", 0);
  before.close(); // the process dies with the request in flight

  const after = open(root, t);
  assert.deepEqual(after.interruptInFlight(), ["run-1"]);
  const snapshot = after.snapshot("run-1")!;
  assert.equal(snapshot.run.state, "interrupted");
  assert.equal(snapshot.run.endReason, "app-restart");
  assert.deepEqual(
    snapshot.attempts.map((attempt) => [attempt.nodeId, attempt.state, attempt.mayHaveBeenBilled]),
    [["p", "interrupted", false], ["g1", "interrupted", true], ["g2", "interrupted", false]],
  );
  assert.equal(after.claimProviderRequest("run-1", "g2", 0), false);
  assert.equal(after.snapshot("run-1")!.run.requestsSent, 1);
  assert.deepEqual(after.interruptInFlight(), []);
});

test("latest outputs come from each node's newest succeeded attempt across runs", async (t) => {
  const ledger = open(await directory(t), t);
  for (const [runId, seed] of [["run-1", "a"], ["run-2", "b"]] as const) {
    ledger.createRun(run({ runId }));
    ledger.finishAttempts([
      { runId, nodeId: "g1", variant: 0, state: "succeeded", output: [out(seed)] },
      { runId, nodeId: "g2", variant: 0, state: "failed", errorCode: "provider-error", errorMessage: "No" },
    ]);
    ledger.finishRun(runId, "partial");
  }
  assert.deepEqual(ledger.latestOutputs("wf"), { g1: [out("b")] });
  assert.deepEqual(ledger.latestOutputs("other"), {});
  assert.equal(ledger.latestRunId("wf"), "run-2");
  assert.deepEqual(ledger.listRuns("wf", 1).map((summary) => summary.runId), ["run-2"]);
});

test("output sequence orders nodes by their newest output, and image counts de-duplicate shared images", async (t) => {
  const ledger = open(await directory(t), t);
  ledger.createRun(run({ runId: "r1" }));
  ledger.finishAttempts([
    { runId: "r1", nodeId: "g1", variant: 0, state: "succeeded", output: [out("a"), out("b")] },
    { runId: "r1", nodeId: "g2", variant: 0, state: "succeeded", output: [out("a")] },
  ]);
  ledger.finishRun("r1", "succeeded");
  const first = ledger.latestOutputSequence("wf");
  assert.deepEqual(Object.keys(first).sort(), ["g1", "g2"]);
  assert.ok(first.g2! > first.g1!, "attempts are inserted in plan order, so a later node has the larger id");

  // A node-only run touches g1 alone: g1 becomes newer than g2, and g2 is untouched.
  ledger.createRun(run({ runId: "r2", scope: { kind: "node-only", nodeId: "g1" }, attempts: [{ nodeId: "g1", variant: 0, provider: "openrouter", model: "m" }] }));
  ledger.finishAttempts([{ runId: "r2", nodeId: "g1", variant: 0, state: "succeeded", output: [out("c")] }]);
  const second = ledger.latestOutputSequence("wf");
  assert.ok(second.g1! > second.g2!);
  assert.equal(second.g2, first.g2);
  assert.deepEqual(ledger.latestOutputSequence("other"), {});

  // Images a, b (shared with g2) and c: three distinct images, however many attempts hold them.
  assert.deepEqual(ledger.imageCounts(), { wf: 3 });
  ledger.deleteWorkflowRuns("wf");
  assert.deepEqual(ledger.imageCounts(), {});
});

test("retention keeps the newest runs plus every run holding a node's latest output", async (t) => {
  const ledger = open(await directory(t), t);
  ledger.createRun(run({ runId: "r1" }));
  ledger.finishAttempts([{ runId: "r1", nodeId: "g1", variant: 0, state: "succeeded", output: [out("a")] }]);
  ledger.finishRun("r1", "partial");
  for (const runId of ["r2", "r3", "r4"]) {
    ledger.createRun(run({ runId }));
    ledger.finishAttempts([{ runId, nodeId: "g1", variant: 0, state: "failed", errorCode: "provider-error" }]);
    ledger.finishRun(runId, "failed");
  }
  ledger.createRun(run({ runId: "live", workflowId: "wf-2" }));
  // Keep 2 newest (r4, live); r1 holds g1's latest output; a running run is never pruned.
  assert.deepEqual(ledger.pruneRuns(2).sort(), ["r2", "r3"]);
  assert.equal(ledger.snapshot("r2"), null);
  assert.ok(ledger.snapshot("r1"));
  assert.ok(ledger.snapshot("live"));
  assert.deepEqual(ledger.pruneRuns(2), []);
});

test("deleting a workflow's runs leaves other workflows untouched", async (t) => {
  const ledger = open(await directory(t), t);
  ledger.createRun(run({ runId: "a1", workflowId: "wf-a" }));
  ledger.createRun(run({ runId: "b1", workflowId: "wf-b" }));
  assert.deepEqual(ledger.deleteWorkflowRuns("wf-a"), ["a1"]);
  assert.equal(ledger.snapshot("a1"), null);
  assert.equal(ledger.snapshot("b1")?.attempts.length, 3);
});

test("the ledger refuses a symlinked file, an unversioned database and an unknown schema", async (t) => {
  const root = await directory(t);
  const target = path.join(root, "elsewhere.sqlite");
  await writeFile(target, "");
  await symlink(target, path.join(root, "runs-v1.sqlite"));
  assert.throws(() => ImageRunLedger.open({ directory: root }), { code: "unsafe" });

  const unversioned = await directory(t);
  const foreign = new DatabaseSync(path.join(unversioned, "runs-v1.sqlite"));
  foreign.exec("CREATE TABLE something (id INTEGER)");
  foreign.close();
  assert.throws(() => ImageRunLedger.open({ directory: unversioned }), { code: "unsafe" });

  const future = await directory(t);
  ImageRunLedger.open({ directory: future }).close();
  const raw = new DatabaseSync(path.join(future, "runs-v1.sqlite"));
  raw.exec("PRAGMA user_version=2");
  raw.close();
  assert.throws(() => ImageRunLedger.open({ directory: future }), { code: "unsupported" });
});
