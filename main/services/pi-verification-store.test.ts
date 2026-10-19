import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiVerificationStore, verificationSnapshot, type HostVerificationCheck } from "./pi-verification-store.js";
import { ToolOutputStore, toolOutputScope } from "./tool-output-store.js";
const scope = toolOutputScope("authority");
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "aiden-verification-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
function check(overrides: Partial<HostVerificationCheck> = {}): HostVerificationCheck {
  return { checkId: "check-1", runId: "run-1", turnId: "turn-1", artifactId: "artifact-1", kind: "task_predicate", snapshot: async () => verificationSnapshot("actual bytes"), observe: async () => ({ result: "passed", evidence: "private output" }), ...overrides };
}
test("host observations survive restart, remain scoped, and duplicates never run twice", async (t) => {
  const root = await fixture(t); const store = new PiVerificationStore(() => root); let runs = 0;
  const spec = check({ observe: async () => { runs++; return { result: "passed", evidence: "SECRET raw command output" }; } });
  const [receipt, duplicate] = await Promise.all([store.check("chat", scope, spec), store.check("chat", scope, spec)]);
  assert.equal(runs, 1); assert.deepEqual(receipt, duplicate);
  assert.equal(receipt.result, "passed");
  assert.match(await store.readEvidence("chat", scope, receipt.checkId), /SECRET raw command output/);
  await assert.rejects(store.readEvidence("other-chat", scope, receipt.checkId), /unavailable/);
  assert.equal((await store.inspect("chat", scope, receipt, verificationSnapshot("edited bytes"))).stale, true);
  const restarted = new PiVerificationStore(() => root);
  assert.deepEqual(await restarted.list("chat", scope), [receipt]);
  assert.deepEqual(await restarted.list("other-chat", scope), []);
  assert.deepEqual(await restarted.list("chat", toolOutputScope("revoked")), []);
  assert.equal((await restarted.inspect("chat", scope, receipt, receipt.snapshot)).evidence, "available");
  assert.equal((await readFile(join(root, "pi-verification-receipts.json"), "utf8")).includes("SECRET"), false);
  await new ToolOutputStore(() => root, Date.now, "pi-verification-evidence.json").deleteByChat("chat");
  // Fresh process view avoids intentionally process-owned DataStore caching.
  assert.equal((await new PiVerificationStore(() => root).inspect("chat", scope, receipt, receipt.snapshot)).evidence, "missing");
  await restarted.deleteByChat("chat"); assert.deepEqual(await restarted.list("chat", scope), []);
});
test("failed, not-run, cancelled, observer failure and changing artifacts have distinct evidence", async (t) => {
  const root = await fixture(t); const store = new PiVerificationStore(() => root);
  const failed = await store.check("chat", scope, check({ observe: async () => ({ result: "failed" }) }));
  assert.equal(failed.result, "failed");
  let invoked = false; const cancel = new AbortController(); cancel.abort();
  const skipped = await store.check("chat", scope, check({ checkId: "skip", observe: async () => { invoked = true; return { result: "passed" }; } }), cancel.signal);
  assert.equal(invoked, false); assert.equal(skipped.result, "not_run"); assert.deepEqual(skipped.limitations, ["cancelled"]);
  const errored = await store.check("chat", scope, check({ checkId: "error", observe: async () => { throw new Error("private secret"); } }));
  assert.equal(errored.result, "inconclusive"); assert.deepEqual(errored.limitations, ["observer_failed"]);
  let bytes = "before";
  const stale = await store.check("chat", scope, check({ checkId: "edit", snapshot: async () => verificationSnapshot(bytes), observe: async () => { bytes = "after"; return { result: "passed" }; } }));
  assert.equal(stale.result, "inconclusive"); assert.deepEqual(stale.limitations, ["artifact_changed"]);
  const during = new AbortController();
  const interrupted = await store.check("chat", scope, check({ checkId: "during", observe: async () => { during.abort(); return { result: "passed" }; } }), during.signal);
  assert.equal(interrupted.result, "inconclusive"); assert.deepEqual(interrupted.limitations, ["cancelled"]);
});
test("expired evidence and corrupt receipts fail closed", async (t) => {
  const root = await fixture(t); let now = 10; const store = new PiVerificationStore(() => root, () => now);
  await store.check("chat", scope, check()); now += 8 * 86400000;
  assert.deepEqual(await store.list("chat", scope), []);
  await writeFile(join(root, "pi-verification-receipts.json"), '[{"result":"passed","version":999}]');
  await assert.rejects(new PiVerificationStore(() => root).list("chat", scope), /unreadable/);
});
test("deletion and orphan reconciliation revoke an in-flight observation publication", async (t) => {
  for (const deletion of ["delete", "reconcile"]) {
    const root = await fixture(t); const store = new PiVerificationStore(() => root);
    let release!: () => void; let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const pending = store.check("chat", scope, check({ observe: async () => { entered(); await waiting; return { result: "passed", evidence: "private output" }; } }));
    await started;
    if (deletion === "delete") await store.deleteByChat("chat");
    else await store.reconcileChats(new Set());
    release(); await assert.rejects(pending, /deleted/);
    assert.deepEqual(await new PiVerificationStore(() => root).list("chat", scope), []);
    assert.deepEqual(JSON.parse(await readFile(join(root, "pi-verification-evidence.json"), "utf8")), []);
  }
});
test("orphan reconciliation revokes queued checks before their first observation", async (t) => {
  const root = await fixture(t); const store = new PiVerificationStore(() => root);
  let release!: () => void; let entered!: () => void; let orphanObserved = false;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const active = store.check("kept", scope, check({ observe: async () => { entered(); await waiting; return { result: "passed" }; } }));
  await started;
  const orphan = store.check("orphan", scope, check({ observe: async () => { orphanObserved = true; return { result: "passed", evidence: "private" }; } }));
  const rejected = assert.rejects(orphan, /deleted/);
  await store.reconcileChats(new Set(["kept"]));
  release(); await active; await rejected;
  assert.equal(orphanObserved, false);
  assert.deepEqual(await store.list("orphan", scope), []);
  // Reconciliation must still permit an unrelated newly created chat later.
  assert.equal((await store.check("new-chat", scope, check())).result, "passed");
});
