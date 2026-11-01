import assert from "node:assert/strict";
import { lstat, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import type { OutputRef } from "../../../renderer/shared/images/run-types.js";
import { ImageRunLedger, type CreateRunInput, type ImageRunLedgerOptions } from "./run-ledger.js";

async function directory(t: TestContext): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-image-ledger-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function open(root: string, t: TestContext, options: Partial<ImageRunLedgerOptions> = {}): ImageRunLedger {
  let clock = 1_000;
  const ledger = ImageRunLedger.open({ directory: root, now: () => (clock += 1), ...options });
  const raw = new DatabaseSync(path.join(root, "runs-v1.sqlite"));
  assert.equal(raw.prepare("PRAGMA auto_vacuum").get()?.auto_vacuum, 2);
  raw.close();
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
  // A node id is passed so that the scope CHECK, not a missing value, is what refuses these.
  assert.throws(() => ledger.createRun(run({ runId: "r-bad", scope: { kind: "everything", nodeId: "g1" } as never })));
  assert.equal(ledger.snapshot("r-bad"), null);
});

test("a from-node or node-only scope without a node id is refused", async (t) => {
  const ledger = open(await directory(t), t);
  assert.throws(() => ledger.createRun(run({ runId: "r-empty", scope: { kind: "from-node", nodeId: "" } })));
  assert.throws(() => ledger.createRun(run({ runId: "r-null", scope: { kind: "node-only", nodeId: null } as never })));
  for (const runId of ["r-empty", "r-null"]) assert.equal(ledger.snapshot(runId), null);
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

test("a claim after a cancel request is refused and does not count", async (t) => {
  const ledger = open(await directory(t), t);
  ledger.createRun(run({ requestLimit: 2 }));
  ledger.requestCancel("run-1");
  assert.equal(ledger.claimProviderRequest("run-1", "g1", 0), false);
  const snapshot = ledger.snapshot("run-1")!;
  assert.equal(snapshot.run.requestsSent, 0);
  assert.equal(snapshot.attempts.find((attempt) => attempt.nodeId === "g1")?.state, "queued");
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

test("a node named like an Object.prototype member still gets its own latest output and sequence", async (t) => {
  const ledger = open(await directory(t), t);
  const names = ["constructor", "toString", "valueOf", "hasOwnProperty"];
  ledger.createRun(run({ attempts: names.map((nodeId) => ({ nodeId, variant: 0, provider: "openrouter", model: "m" })) }));
  ledger.finishAttempts(names.map((nodeId, index) => ({ runId: "run-1", nodeId, variant: 0, state: "succeeded" as const, output: [out(String(index))] })));
  ledger.finishRun("run-1", "succeeded");
  const outputs = ledger.latestOutputs("wf");
  const sequence = ledger.latestOutputSequence("wf");
  names.forEach((name, index) => {
    assert.deepEqual(Object.getOwnPropertyDescriptor(outputs, name)?.value, [out(String(index))], name);
    assert.equal(typeof Object.getOwnPropertyDescriptor(sequence, name)?.value, "number", name);
  });
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

  // A local node's output (no provider) forwards an image some other holder keeps; deleting the
  // workflow's runs does not release it, so it is not counted.
  ledger.createRun(run({ runId: "r3", attempts: [{ nodeId: "o1", variant: 0 }] }));
  ledger.finishAttempts([{ runId: "r3", nodeId: "o1", variant: 0, state: "succeeded", output: [out("d")] }]);
  ledger.finishRun("r3", "succeeded");

  // Images a, b (shared with g2) and c: three distinct images, however many attempts hold them.
  assert.deepEqual(ledger.imageAssetIds(), { wf: ["a", "b", "c"].map((seed) => seed.repeat(64)) });
  ledger.deleteWorkflowRuns("wf");
  assert.deepEqual(ledger.imageAssetIds(), {});
});

test("retention keeps the newest runs plus every run holding a node's latest output", async (t) => {
  const ledger = open(await directory(t), t);
  // The running run is the oldest, so only its state keeps it: it falls outside the newest two.
  ledger.createRun(run({ runId: "live", workflowId: "wf-2" }));
  ledger.createRun(run({ runId: "r1" }));
  ledger.finishAttempts([{ runId: "r1", nodeId: "g1", variant: 0, state: "succeeded", output: [out("a")] }]);
  ledger.finishRun("r1", "partial");
  for (const runId of ["r2", "r3", "r4"]) {
    ledger.createRun(run({ runId }));
    ledger.finishAttempts([{ runId, nodeId: "g1", variant: 0, state: "failed", errorCode: "provider-error" }]);
    ledger.finishRun(runId, "failed");
  }
  // Keep 2 newest (r3, r4); r1 holds g1's latest output; the older running run is never pruned.
  assert.deepEqual(ledger.pruneRuns(2), ["r2"]);
  assert.equal(ledger.snapshot("r2"), null);
  assert.ok(ledger.snapshot("r3"));
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
  assert.throws(() => ImageRunLedger.open({ directory: unversioned }), { code: "corrupt" });

  const future = await directory(t);
  ImageRunLedger.open({ directory: future }).close();
  const raw = new DatabaseSync(path.join(future, "runs-v1.sqlite"));
  raw.exec("PRAGMA user_version=2");
  raw.close();
  assert.throws(() => ImageRunLedger.open({ directory: future }), { code: "unsupported" });
});

test("retention stays bounded when every run uses fresh node ids, keeping latest outputs only for live nodes", async (t) => {
  const live = new Map<string, Set<string>>([["wf", new Set()]]);
  const ledger = open(await directory(t), t, { liveNodeIds: (workflowId) => live.get(workflowId) });
  for (let index = 0; index < 300; index += 1) {
    const runId = `r${index}`;
    const nodeId = `g-${index}`;
    ledger.createRun(run({ runId, attempts: [{ nodeId, variant: 0, provider: "openrouter", model: "m" }] }));
    ledger.finishAttempts([{ runId, nodeId, variant: 0, state: "succeeded", output: [out((index % 10).toString())] }]);
    ledger.finishRun(runId, "succeeded");
  }
  // The document now holds one node from an old run: only that run is kept beyond the newest 100.
  live.set("wf", new Set(["g-5"]));
  assert.equal(ledger.pruneRuns(100).length, 199);
  assert.ok(ledger.snapshot("r5"), "the run holding a live node's latest output is kept");
  assert.ok(ledger.snapshot("r299"));
  assert.equal(ledger.snapshot("r6"), null);
  assert.equal(ledger.listRuns("wf", 500).length, 101);

  // Once the workflow's document is gone, nothing is exempt.
  live.delete("wf");
  assert.deepEqual(ledger.pruneRuns(100), ["r5"]);
});

test("retention keeps every latest output of a workflow whose file is unreadable but kept for repair", async (t) => {
  let state: ReadonlySet<string> | "all" | undefined = "all";
  const ledger = open(await directory(t), t, { liveNodeIds: (workflowId) => (workflowId === "wf" ? state : new Set()) });
  ledger.createRun(run({ runId: "kept", attempts: [{ nodeId: "g1", variant: 0, provider: "openrouter", model: "m" }] }));
  ledger.finishAttempts([{ runId: "kept", nodeId: "g1", variant: 0, state: "succeeded", output: [out("a")] }]);
  ledger.finishRun("kept", "succeeded");
  for (let index = 0; index < 3; index += 1) {
    const runId = `other${index}`;
    ledger.createRun(run({ runId, workflowId: "other", attempts: [{ nodeId: `n${index}`, variant: 0, provider: "openrouter", model: "m" }] }));
    ledger.finishRun(runId, "succeeded");
  }
  // The unreadable workflow's last output survives even outside the newest runs.
  assert.ok(!ledger.pruneRuns(1).includes("kept"));
  assert.ok(ledger.snapshot("kept"));
  // Deleted for real, it is pruned like any other.
  state = undefined;
  assert.deepEqual(ledger.pruneRuns(1), ["kept"]);
});

test("a node's latest output follows insertion order, not a wall clock that steps backwards", async (t) => {
  const times = [5_000, 6_000, 7_000, 1_000, 1_100];
  let call = 0;
  const ledger = open(await directory(t), t, { now: () => times[Math.min(call++, times.length - 1)]! });
  ledger.createRun(run({ runId: "early", attempts: [{ nodeId: "g1", variant: 0, provider: "openrouter", model: "m" }] }));
  ledger.finishAttempts([{ runId: "early", nodeId: "g1", variant: 0, state: "succeeded", output: [out("a")] }]);
  ledger.finishRun("early", "succeeded");
  // The clock jumps back before the second run finishes: it is still the newer output.
  ledger.createRun(run({ runId: "later", attempts: [{ nodeId: "g1", variant: 0, provider: "openrouter", model: "m" }] }));
  ledger.finishAttempts([{ runId: "later", nodeId: "g1", variant: 0, state: "succeeded", output: [out("b")] }]);
  ledger.finishRun("later", "succeeded");
  assert.deepEqual(ledger.latestOutputs("wf"), { g1: [out("b")] });
  // Retention agrees with the display: with room for one recent run, the newest output's run is the one kept.
  const kept = new Set(["g1"]);
  const pruning = open(await directory(t), t, { liveNodeIds: () => kept });
  pruning.createRun(run({ runId: "x1", attempts: [{ nodeId: "g1", variant: 0, provider: "openrouter", model: "m" }] }));
  pruning.finishAttempts([{ runId: "x1", nodeId: "g1", variant: 0, state: "succeeded", output: [out("c")] }]);
  pruning.finishRun("x1", "succeeded");
  pruning.createRun(run({ runId: "x2", attempts: [{ nodeId: "g1", variant: 0, provider: "openrouter", model: "m" }] }));
  pruning.finishAttempts([{ runId: "x2", nodeId: "g1", variant: 0, state: "succeeded", output: [out("d")] }]);
  pruning.finishRun("x2", "succeeded");
  assert.deepEqual(pruning.pruneRuns(0), ["x1"]);
  assert.deepEqual(pruning.latestOutputs("wf"), { g1: [out("d")] });
});

test("runAssetIds lists every run with the generated assets its holder keeps", async (t) => {
  const ledger = open(await directory(t), t);
  ledger.createRun(run({ runId: "with-output" }));
  ledger.finishAttempts([
    { runId: "with-output", nodeId: "g1", variant: 0, state: "succeeded", output: [out("a"), out("b")] },
    { runId: "with-output", nodeId: "p", variant: 0, state: "succeeded", output: [out("c")] },
  ]);
  ledger.createRun(run({ runId: "empty" }));
  assert.deepEqual(
    [...ledger.runAssetIds()].sort(([left], [right]) => left.localeCompare(right)),
    [["empty", []], ["with-output", [out("a").assetId, out("b").assetId]]],
  );
});

test("a damaged ledger is moved aside and replaced by an empty one when quarantine is enabled", async (t) => {
  const tablesIn = (file: string) => {
    const raw = new DatabaseSync(file);
    try {
      return (raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map((row) => row.name);
    } finally {
      raw.close();
    }
  };
  const cases: Array<[string, (file: string) => Promise<void>, (moved: string) => Promise<void>]> = [
    [
      "not a database",
      (file) => writeFile(file, "x".repeat(4096)),
      async (moved) => assert.equal(await readFile(moved, "utf8"), "x".repeat(4096)),
    ],
    [
      "no schema version",
      async (file) => {
        const raw = new DatabaseSync(file);
        raw.exec("CREATE TABLE something (id INTEGER)");
        raw.close();
      },
      async (moved) => assert.deepEqual(tablesIn(moved), ["something"]),
    ],
    [
      "an unsupported schema",
      async (file) => {
        const raw = new DatabaseSync(file);
        raw.exec("CREATE TABLE runs (id TEXT); PRAGMA user_version=9");
        raw.close();
      },
      async (moved) => assert.deepEqual(tablesIn(moved), ["runs"]),
    ],
  ];
  for (const [label, damage, verify] of cases) {
    const root = await directory(t);
    await damage(path.join(root, "runs-v1.sqlite"));
    const moved: string[] = [];
    const ledger = open(root, t, { quarantineDamaged: (target) => void moved.push(target) });
    assert.equal(moved.length, 1, label);
    assert.match(path.basename(moved[0]!), /^runs-v1\.sqlite\.corrupt-\d+$/u, label);
    await verify(moved[0]!);
    ledger.createRun(run());
    assert.equal(ledger.snapshot("run-1")?.attempts.length, 3, `${label}: the fresh ledger works`);
    // Without quarantine the same damage is refused, as before.
    const strict = await directory(t);
    await damage(path.join(strict, "runs-v1.sqlite"));
    assert.throws(() => ImageRunLedger.open({ directory: strict }), label);
  }
});

test("a file-safety refusal is never quarantined", async (t) => {
  const root = await directory(t);
  const target = path.join(root, "elsewhere.sqlite");
  await writeFile(target, "");
  await symlink(target, path.join(root, "runs-v1.sqlite"));
  const moved: string[] = [];
  assert.throws(() => ImageRunLedger.open({ directory: root, quarantineDamaged: (file) => void moved.push(file) }), { code: "unsafe" });
  assert.deepEqual(moved, []);
  assert.ok((await lstat(path.join(root, "runs-v1.sqlite"))).isSymbolicLink());
  assert.deepEqual((await readdir(root)).sort(), ["elsewhere.sqlite", "runs-v1.sqlite"]);
});

test("the prompt a claimed request sends is kept with its attempt and goes away with the run", async (t) => {
  const root = await directory(t);
  const ledger = open(root, t);
  ledger.createRun(run({ runId: "r1" }));
  assert.equal(ledger.claimProviderRequest("r1", "g1", 0, "A red bicycle at dusk"), true);
  ledger.finishAttempts([{ runId: "r1", nodeId: "g1", variant: 0, state: "succeeded", output: [out("a")] }]);
  ledger.finishRun("r1", "partial");
  const prompts = Object.fromEntries(ledger.snapshot("r1")!.attempts.map((attempt) => [attempt.nodeId, attempt.prompt]));
  // Only the request that was sent has a prompt; the unsent Generate and the local Prompt node have none.
  assert.deepEqual(prompts, { p: undefined, g1: "A red bicycle at dusk", g2: undefined });
  assert.equal(ledger.generatedAttempts("wf", 10)[0]?.prompt, "A red bicycle at dusk");

  // A newer run replaces g1's latest output, so pruning may drop r1 and its prompt with it.
  ledger.createRun(run({ runId: "r2" }));
  ledger.claimProviderRequest("r2", "g1", 0, "A blue bicycle");
  ledger.finishAttempts([{ runId: "r2", nodeId: "g1", variant: 0, state: "succeeded", output: [out("b")] }]);
  ledger.finishRun("r2", "partial");
  assert.deepEqual(ledger.pruneRuns(1), ["r1"]);
  const raw = new DatabaseSync(path.join(root, "runs-v1.sqlite"));
  t.after(() => raw.close());
  assert.deepEqual(
    (raw.prepare("SELECT prompt FROM attempts WHERE prompt IS NOT NULL").all() as { prompt: string }[]).map((row) => row.prompt),
    ["A blue bicycle"],
  );
});

test("a ledger written before prompts and exports existed gains both on open and keeps its history", async (t) => {
  const root = await directory(t);
  const first = ImageRunLedger.open({ directory: root });
  first.createRun(run({ runId: "old" }));
  first.finishAttempts([{ runId: "old", nodeId: "g1", variant: 0, state: "succeeded", output: [out("a")] }]);
  first.close();
  // Reproduce the file an earlier build left: no prompt column and no exports table, still user_version 1.
  const raw = new DatabaseSync(path.join(root, "runs-v1.sqlite"));
  raw.exec("ALTER TABLE attempts DROP COLUMN prompt; DROP TABLE exports;");
  raw.close();

  const ledger = open(root, t);
  assert.deepEqual(ledger.latestOutputs("wf"), { g1: [out("a")] });
  ledger.createRun(run({ runId: "new" }));
  assert.equal(ledger.claimProviderRequest("new", "g1", 0, "Fresh prompt"), true);
  assert.equal(ledger.snapshot("new")!.attempts.find((attempt) => attempt.nodeId === "g1")?.prompt, "Fresh prompt");
  ledger.recordExport(out("a").assetId, "/pictures/a.png");
  assert.equal(ledger.exportPath(out("a").assetId), "/pictures/a.png");
  const check = new DatabaseSync(path.join(root, "runs-v1.sqlite"));
  t.after(() => check.close());
  assert.equal(check.prepare("PRAGMA user_version").get()?.user_version, 1);
});

test("generated attempts list Generate outputs newest first, per workflow or across all of them", async (t) => {
  const ledger = open(await directory(t), t);
  ledger.createRun(run({ runId: "a1", workflowId: "wf-a" }));
  ledger.createRun(run({ runId: "b1", workflowId: "wf-b" }));
  // b1 finishes first even though a1 started first; the Prompt node's forwarded text never counts.
  ledger.finishAttempts([{ runId: "b1", nodeId: "g1", variant: 0, state: "succeeded", output: [out("b")] }]);
  ledger.finishAttempts([
    { runId: "a1", nodeId: "g1", variant: 0, state: "succeeded", output: [out("a"), out("c")] },
    { runId: "a1", nodeId: "g2", variant: 0, state: "failed", errorCode: "provider-error" },
    { runId: "a1", nodeId: "p", variant: 0, state: "succeeded", output: [out("d")] },
  ]);
  const all = ledger.generatedAttempts(undefined, 10);
  assert.deepEqual(all.map((attempt) => [attempt.runId, attempt.nodeId, attempt.output.length]), [["a1", "g1", 2], ["b1", "g1", 1]]);
  assert.ok(all[0]!.finishedAt > all[1]!.finishedAt);
  assert.deepEqual(all[0]!.provider, "openrouter");
  assert.deepEqual(ledger.generatedAttempts("wf-b", 10).map((attempt) => attempt.runId), ["b1"]);
  assert.deepEqual(ledger.generatedAttempts(undefined, 1).map((attempt) => attempt.runId), ["a1"]);
  assert.equal(ledger.generatedAsset(out("c").assetId)?.attempt.runId, "a1");
  assert.equal(ledger.generatedAsset(out("c").assetId)?.ref.assetId, out("c").assetId);
  // Forwarded by a local node only: not something the ledger generated.
  assert.equal(ledger.generatedAsset(out("d").assetId), undefined);
});

test("export records round-trip and are forgotten once no remaining run names their image", async (t) => {
  const ledger = open(await directory(t), t);
  ledger.createRun(run({ runId: "r1", workflowId: "wf-a" }));
  ledger.finishAttempts([{ runId: "r1", nodeId: "g1", variant: 0, state: "succeeded", output: [out("a")] }]);
  ledger.finishRun("r1", "partial");
  ledger.createRun(run({ runId: "r2", workflowId: "wf-b" }));
  ledger.finishAttempts([{ runId: "r2", nodeId: "g1", variant: 0, state: "succeeded", output: [out("b")] }]);
  ledger.finishRun("r2", "partial");
  ledger.recordExport(out("a").assetId, "/p/a.png");
  ledger.recordExport(out("b").assetId, "/p/b.png");
  ledger.recordExport(out("b").assetId, "/p/b (1).png");
  assert.deepEqual([...ledger.exportPaths()].sort(), [[out("a").assetId, "/p/a.png"], [out("b").assetId, "/p/b (1).png"]]);
  assert.equal(ledger.exportPath(out("c").assetId), undefined);

  ledger.deleteWorkflowRuns("wf-a");
  assert.equal(ledger.exportPath(out("a").assetId), undefined);
  assert.equal(ledger.exportPath(out("b").assetId), "/p/b (1).png");
});
