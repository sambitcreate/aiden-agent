import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiVerificationStore, verificationSnapshot, type HostVerificationCheck } from "./pi-verification-store.js";
import { PiRuntimeEffectStore } from "./pi-runtime-effect-store.js";
import { toolOutputScope } from "./tool-output-store.js";
import { WorkflowEvidenceStore, type WorkflowLessonInput } from "./workflow-evidence-store.js";
const scope = toolOutputScope("workspace-authority");
const component = { id: "protected-task-adapter", version: "v2" };
const proposal = { applicability: "When resuming a durable plan", operation: "Read the existing checkpoint before updating its status.", limitations: ["The six fixtures do not establish live-model gains."] };
const input = { requestId: "request-1", lessonId: "lesson-1", bundleId: "bundle-1", outcome: "candidate", proposal } as const;
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "aiden-workflow-evidence-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let now = 1000; let artifact = "actual solution";
  const verification = new PiVerificationStore(() => root, () => now);
  const store = new WorkflowEvidenceStore(verification, () => root, () => now);
  const snapshot = async () => verificationSnapshot(artifact);
  const check = (overrides: Partial<HostVerificationCheck> = {}) => verification.check("chat", scope, {
    checkId: "predicate", runId: "run", turnId: "turn", artifactId: "solution", kind: "task_predicate", snapshot,
    observe: async () => ({ result: "passed", evidence: "SECRET raw evaluation observation" }), ...overrides,
  });
  const capture = (bundleId = "bundle-1", checkIds = ["predicate"]) => store.capture("chat", scope, { bundleId, workflowId: "workflow", component, checkIds }, snapshot);
  return { root, verification, store, check, capture, snapshot, setNow: (value: number) => { now = value; }, edit: () => { artifact += " edited"; } };
}
test("private host evidence and tentative lessons survive restart without copying raw output", async (t) => {
  const f = await fixture(t); const receipt = await f.check(); const bundle = await f.capture();
  assert.deepEqual(bundle.checks, [{ checkId: "predicate", receiptDigest: verificationSnapshot(JSON.stringify(receipt)), runId: "run", artifactId: "solution", snapshot: receipt.snapshot, observation: "current" }]);
  assert.deepEqual(await f.capture(), bundle);
  const record = await f.store.propose("chat", scope, input, f.snapshot);
  assert.equal(record.confidence, "tentative"); assert.equal(record.review, "pending");
  assert.deepEqual(record.limitations, ["selection_is_not_causation", "not_adopted"]);
  assert.deepEqual(await f.store.propose("chat", scope, input, f.snapshot), record);
  const restarted = new WorkflowEvidenceStore(new PiVerificationStore(() => f.root, () => 1000), () => f.root, () => 1000);
  assert.deepEqual(await restarted.list("chat", scope), [{ record, expired: false }]);
  assert.deepEqual(await restarted.list("other-chat", scope), []);
  assert.deepEqual(await restarted.list("chat", toolOutputScope("revoked")), []);
  await assert.rejects(restarted.inspect("other-chat", scope, bundle.bundleId, f.snapshot), /unavailable/);
  const bytes = await readFile(join(f.root, "workflow-evidence.json"), "utf8");
  assert.equal(bytes.includes("SECRET"), false); assert.equal(bytes.includes("workspace-authority"), false);
  assert.equal((await stat(join(f.root, "workflow-evidence.json"))).mode & 0o777, 0o600);
  record.proposal!.operation = "Caller mutates returned copy";
  assert.equal((await f.store.list("chat", scope))[0]!.record.proposal!.operation, proposal.operation);
});
test("command success, lifecycle, failed predicates and missing checks cannot support lesson candidates", async (t) => {
  const f = await fixture(t);
  for (const [checkId, kind, result] of [["command", "tool_execution", "passed"], ["ended", "response_ended", "passed"], ["failed", "task_predicate", "failed"], ["skipped", "task_predicate", "not_run"], ["unknown", "artifact_check", "inconclusive"]] as const) {
    await f.check({ checkId, kind, observe: async () => ({ result, evidence: "host result" }) });
    await f.capture(checkId, [checkId]);
    await assert.rejects(f.store.propose("chat", scope, { ...input, bundleId: checkId }, f.snapshot), /current host-observed/);
  }
  await f.capture("missing", ["no-such-check"]);
  await assert.rejects(f.store.propose("chat", scope, { ...input, bundleId: "missing" }, f.snapshot), /current host-observed/);
  const abstention = await f.store.propose("chat", scope, { requestId: "none", lessonId: "none", bundleId: "missing", outcome: "no_lesson" }, f.snapshot);
  assert.equal(abstention.confidence, "unassessed"); assert.equal(abstention.proposal, undefined);
  await f.check(); await f.capture("mixed", ["predicate", "failed"]);
  await assert.rejects(f.store.propose("chat", scope, { ...input, bundleId: "mixed" }, f.snapshot), /current host-observed/);
  const conflicting = await f.store.propose("chat", scope, { requestId: "conflict", lessonId: "conflict", bundleId: "mixed", outcome: "conflicting_evidence" }, f.snapshot);
  assert.equal(conflicting.outcome, "conflicting_evidence"); assert.equal(conflicting.proposal, undefined);
});
test("captured evidence must still match the actual artifact and retained host observation", async (t) => {
  const f = await fixture(t); await f.check(); await f.capture(); f.edit();
  assert.deepEqual((await f.store.inspect("chat", scope, "bundle-1", f.snapshot)).supportingChecks, []);
  assert.equal((await f.store.inspect("chat", scope, "bundle-1", f.snapshot)).checks[0]!.observation, "stale");
  await assert.rejects(f.store.propose("chat", scope, input, f.snapshot), /current host-observed/);
  await assert.rejects(f.store.propose("chat", scope, input, async () => "not-a-digest"), /current host-observed/);
  const expired = await fixture(t); await expired.check(); await expired.capture(); expired.setNow(8 * 86400000);
  assert.equal((await expired.store.inspect("chat", scope, "bundle-1", expired.snapshot)).expired, true);
  await assert.rejects(expired.store.propose("chat", scope, input, expired.snapshot), /expired/);
  const absent = await fixture(t); await absent.capture(); await absent.check();
  assert.deepEqual((await absent.store.inspect("chat", scope, "bundle-1", absent.snapshot)).supportingChecks, []);
  await assert.rejects(absent.store.propose("chat", scope, input, absent.snapshot), /current host-observed/);
  const forgotten = await fixture(t); await forgotten.check(); await forgotten.capture(); await forgotten.verification.deleteByChat("chat");
  await assert.rejects(forgotten.store.propose("chat", scope, input, forgotten.snapshot), /current host-observed/);
});
test("missing retained evidence is explicit even when the check itself passed", async (t) => {
  const f = await fixture(t); await f.check({ observe: async () => ({ result: "passed" }) });
  const bundle = await f.capture(); assert.equal(bundle.checks[0]!.observation, "evidence_missing");
  await assert.rejects(f.store.propose("chat", scope, input, f.snapshot), /current host-observed/);
});
test("lesson revision, rollback lineage and withdrawal are scoped immutable draft history", async (t) => {
  const f = await fixture(t); await f.check(); await f.capture();
  const original = await f.store.propose("chat", scope, input, f.snapshot);
  const revised = await f.store.propose("chat", scope, { ...input, requestId: "revision-2", previousRecordId: original.recordId, outcome: "no_lesson", proposal: undefined }, f.snapshot);
  assert.equal(revised.revision, 2); assert.equal(revised.previousRecordId, original.recordId);
  const rollback = await f.store.propose("chat", scope, { ...input, requestId: "rollback-draft", previousRecordId: revised.recordId, rollbackOfRecordId: original.recordId }, f.snapshot);
  assert.equal(rollback.rollbackOfRecordId, original.recordId); assert.equal(rollback.review, "pending");
  await assert.rejects(f.store.propose("chat", scope, { ...input, requestId: "stale", previousRecordId: original.recordId }, f.snapshot), /lineage changed/);
  await assert.rejects(f.store.propose("chat", scope, { ...input, requestId: "forged-rollback", previousRecordId: rollback.recordId, rollbackOfRecordId: "unknown-record" }, f.snapshot), /rollback lineage/);
  const withdrawn = await f.store.withdraw("chat", scope, "lesson-1", rollback.recordId, "withdraw-1");
  assert.equal(withdrawn.revision, 4); assert.equal(withdrawn.review, "withdrawn"); assert.equal(withdrawn.proposal, undefined);
  assert.deepEqual(await f.store.withdraw("chat", scope, "lesson-1", rollback.recordId, "withdraw-1"), withdrawn);
  await assert.rejects(f.store.withdraw("chat", scope, "lesson-1", rollback.recordId, "withdraw-2"), /lineage changed/);
  assert.deepEqual(await f.store.list("chat", scope), [{ record: withdrawn, expired: false }]);
  const restarted = new WorkflowEvidenceStore(new PiVerificationStore(() => f.root), () => f.root, () => 1000);
  assert.equal((await restarted.list("chat", scope))[0]!.record.revision, 4);
});
test("untrusted proposal fields never authorize adoption, inflate confidence or forge receipts", async (t) => {
  const f = await fixture(t); await f.check(); await f.capture();
  for (const extra of [{ adopted: true }, { confidence: "high" }, { permissions: ["network"] }, { evidence: { result: "passed" } }]) {
    await assert.rejects(f.store.propose("chat", scope, { ...input, ...extra } as WorkflowLessonInput, f.snapshot), /Invalid/);
  }
  await assert.rejects(f.store.capture("chat", scope, { bundleId: "forged", workflowId: "workflow", component, checkIds: ["forged"], receipt: { result: "passed" } } as Parameters<WorkflowEvidenceStore["capture"]>[2], f.snapshot), /Invalid/);
  await assert.rejects(f.store.propose("chat", scope, { ...input, proposal: { ...proposal, operation: "é".repeat(1025) } }, f.snapshot), /Invalid/);
  await assert.rejects(f.store.propose("chat", scope, { ...input, proposal: { ...proposal, limitations: Array(9).fill("too many") } }, f.snapshot), /Invalid/);
  await assert.rejects(f.store.capture("chat", scope, { bundleId: "duplicates", workflowId: "workflow", component, checkIds: ["predicate", "predicate"] }, f.snapshot), /Invalid/);
  await assert.rejects(f.store.capture("chat", scope, { bundleId: "oversized", workflowId: "workflow", component, checkIds: Array.from({ length: 17 }, (_, index) => `check-${index}`) }, f.snapshot), /Invalid/);
  await assert.rejects(f.store.capture("chat", "not-an-authority-scope", { bundleId: "bad-scope", workflowId: "workflow", component, checkIds: ["predicate"] }, f.snapshot), /scope/);
  await assert.rejects(f.store.capture("chat", scope, { bundleId: "bundle-1", workflowId: "different-workflow", component, checkIds: ["predicate"] }, f.snapshot), /identity reused/);
  const record = await f.store.propose("chat", scope, input, f.snapshot);
  await assert.rejects(f.store.propose("chat", scope, { ...input, proposal: { ...proposal, operation: "Altered request" } }, f.snapshot), /identity reused/);
  assert.equal((await f.store.list("chat", scope))[0]!.record.recordId, record.recordId);
});
test("bounded stores reject excess active history and reclaim expired bundles", async (t) => {
  const f = await fixture(t);
  for (let index = 0; index < 64; index++) await f.capture(`bundle-${index}`);
  await assert.rejects(f.capture("overflow"), /capacity/);
  f.setNow(8 * 86400000);
  assert.equal((await f.capture("after-expiry")).bundleId, "after-expiry");
  await assert.rejects(f.store.inspect("chat", scope, "bundle-0", f.snapshot), /unavailable/);
});
test("withdrawal after expiry retains immutable bundle and rollback history until the chain expires", async (t) => {
  const f = await fixture(t); await f.check(); const originalBundle = await f.capture();
  const original = await f.store.propose("chat", scope, input, f.snapshot);
  f.setNow(8 * 86400000);
  const withdrawn = await f.store.withdraw("chat", scope, "lesson-1", original.recordId, "late-withdrawal");
  assert.equal(withdrawn.previousRecordId, original.recordId);
  await f.capture("fresh-bundle");
  const retained = await f.capture(); assert.deepEqual(retained, originalBundle);
  assert.equal((await f.store.inspect("chat", scope, "bundle-1", f.snapshot)).expired, true);
  const restarted = new WorkflowEvidenceStore(new PiVerificationStore(() => f.root), () => f.root, () => 8 * 86400000);
  assert.equal((await restarted.list("chat", scope))[0]!.record.recordId, withdrawn.recordId);
  f.setNow(16 * 86400000); await f.capture("after-chain-expiry");
  assert.deepEqual(await f.store.list("chat", scope), []);
  await assert.rejects(f.store.inspect("chat", scope, "bundle-1", f.snapshot), /unavailable/);
});
test("cancelled and deleted in-flight capture cannot republish private evidence", async (t) => {
  for (const action of ["cancel", "delete", "reconcile"] as const) {
    const f = await fixture(t); await f.check(); const cancellation = new AbortController();
    let entered!: () => void; const inside = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void; const paused = new Promise<void>((resolve) => { release = resolve; });
    const capturing = f.store.capture("chat", scope, { bundleId: "bundle-1", workflowId: "workflow", component, checkIds: ["predicate"] }, async () => { entered(); await paused; return f.snapshot(); }, cancellation.signal);
    const rejection = assert.rejects(capturing, /cancelled|no longer active/);
    await inside;
    const deleting = action === "delete" ? f.store.deleteByChat("chat") : action === "reconcile" ? f.store.reconcileChats(new Set()) : undefined;
    if (action === "cancel") cancellation.abort();
    release(); await rejection; await deleting;
    if (action !== "cancel") {
      const restarted = new WorkflowEvidenceStore(new PiVerificationStore(() => f.root), () => f.root);
      assert.deepEqual(await restarted.list("chat", scope), []);
    }
  }
});
test("unsupported, malformed and conflicting durable history fails closed without overwriting", async (t) => {
  const f = await fixture(t); await f.check(); await f.capture(); await f.store.propose("chat", scope, input, f.snapshot);
  const path = join(f.root, "workflow-evidence.json"); const source = JSON.parse(await readFile(path, "utf8"));
  const lineage = structuredClone(source); lineage.lessons[0].value.previousRecordId = "unavailable"; lineage.lessons[0].value.revision = 2;
  for (const corrupt of ["{bad json", JSON.stringify({ ...source, version: 2 }), JSON.stringify(lineage), JSON.stringify({ ...source, executable: true })]) {
    await writeFile(path, corrupt);
    const restarted = new WorkflowEvidenceStore(new PiVerificationStore(() => f.root), () => f.root, () => 1000);
    await assert.rejects(restarted.list("chat", scope), /unreadable/);
    await assert.rejects(restarted.capture("chat", scope, { bundleId: "new", workflowId: "workflow", component, checkIds: ["predicate"] }, f.snapshot), /unreadable/);
    assert.equal(await readFile(path, "utf8"), corrupt);
  }
});
test("runtime chat deletion and orphan reconciliation also remove private workflow records", async (t) => {
  for (const action of ["delete", "reconcile"] as const) {
    const f = await fixture(t); const effects = new PiRuntimeEffectStore({ root: () => f.root, now: () => 1000 });
    await effects.initialize();
    for (const chatId of ["chat", "kept-chat"]) {
      await effects.verification.check(chatId, scope, { checkId: "predicate", runId: "run", turnId: "turn", artifactId: "solution", kind: "task_predicate", snapshot: f.snapshot, observe: async () => ({ result: "passed", evidence: "host predicate" }) });
      await effects.workflowEvidence.capture(chatId, scope, { bundleId: "bundle-1", workflowId: "workflow", component, checkIds: ["predicate"] }, f.snapshot);
      await effects.workflowEvidence.propose(chatId, scope, input, f.snapshot);
    }
    if (action === "delete") await effects.deleteChat("chat");
    else await effects.reconcileChats(new Set(["kept-chat"]));
    const restarted = new PiRuntimeEffectStore({ root: () => f.root, now: () => 1000 }); await restarted.initialize();
    assert.deepEqual(await restarted.workflowEvidence.list("chat", scope), []);
    assert.equal((await restarted.workflowEvidence.list("kept-chat", scope)).length, 1);
    assert.deepEqual(await restarted.verification.list("chat", scope), []);
  }
});
