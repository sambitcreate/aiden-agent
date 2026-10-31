import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { prepareTaskQualityCase, runTaskQualityCase, TASK_QUALITY_CASES, assertCompatibleTaskQualityResume, taskQualityExperimentIdentity, classifyTaskQualityComparison, type PreparedTaskQualityCase } from "./task-quality-adapter.js";
async function trajectory(prepared: PreparedTaskQualityCase, control: string, extra: { skipRead?: boolean; prohibitedPlan?: boolean; source?: string } = {}) {
  const core = createFauxCore({ provider: "offline-task-controls", api: "faux-offline-task-controls" });
  const responses = [];
  if (prepared.output && !extra.skipRead) responses.push(fauxAssistantMessage([fauxToolCall("read_tool_output", { handle: prepared.output.handle, offset: prepared.output.offset, length: 1000 })], { stopReason: "toolUse" }));
  if (control !== "starter") {
    const source = extra.source ?? await readFile(join(prepared.fixtureRoot, prepared.task.id, "controls", control, "solution.py"), "utf8");
    responses.push(fauxAssistantMessage([fauxToolCall("write_file", { path: "solution.py", content: source })], { stopReason: "toolUse" }));
  }
  if (prepared.task.durable_todo_state && control !== "starter") {
    responses.push(fauxAssistantMessage([fauxToolCall("todo", { action: "list" })], { stopReason: "toolUse" }));
    if (control === "wrong_new_plan" || extra.prohibitedPlan) responses.push(fauxAssistantMessage([fauxToolCall("todo", { action: "clear" })], { stopReason: "toolUse" }));
    for (const id of [8, 12]) responses.push(fauxAssistantMessage([fauxToolCall("todo", { action: "update", id, status: "completed" })], { stopReason: "toolUse" }));
  }
  responses.push(fauxAssistantMessage("All tasks are done and all checks passed."));
  core.setResponses(responses);
  return { model: core.getModel(), streamFn: core.streamSimple };
}
test("six protected production-harness cases preserve all seven positive and twenty-two negative controls", { timeout: 180000 }, async (t) => {
  let positives = 0; let negatives = 0;
  for (const caseId of TASK_QUALITY_CASES) {
    const parent = await mkdtemp(join(tmpdir(), "aiden-protected-case-"));
    t.after(() => rm(parent, { recursive: true, force: true }));
    const catalog = JSON.parse(await readFile(join("docs/research/experiments/task-quality-fixtures", caseId, "task.json"), "utf8"));
    for (const [control, expectation] of Object.entries(catalog.candidate_controls) as Array<[string, { expected: string }]>) {
      const root = await mkdtemp(join(parent, `${control}-`));
      const prepared = await prepareTaskQualityCase(root, caseId);
      const outcome = await runTaskQualityCase(prepared, await trajectory(prepared, control));
      assert.equal(outcome.lifecycle, "completed", `${caseId}/${control}: task correctness is separate from lifecycle`);
      assert.equal(outcome.accepted, expectation.expected === "pass", `${caseId}/${control}: ${outcome.receipt.result}`);
      if (expectation.expected === "pass") positives++; else negatives++;
      assert.equal(outcome.receipt.kind, "task_predicate");
      assert.equal(outcome.workflowEvidence.checks[0]?.receiptDigest, createHash("sha256").update(JSON.stringify(outcome.receipt)).digest("hex"));
      assert.equal(outcome.workflowEvidence.checks[0]?.observation, "current");
      if (prepared.output) assert.equal(outcome.outputRead, true);
      if (prepared.task.durable_todo_state && control === "correct") assert.ok(outcome.planHistory.some((state) => state.tasks.find((item) => item.id === 8)?.status === "completed" && state.tasks.find((item) => item.id === 12)?.status === "pending"));
      await outcome.harness.dispose();
    }
  }
  assert.equal(positives, 7); assert.equal(negatives, 22);
});
test("correct final artifacts cannot hide skipped output reads or prohibited plan replacement", { timeout: 45000 }, async (t) => {
  for (const caseId of ["output_recovery", "resumed_plans"] as const) {
    const root = await mkdtemp(join(tmpdir(), "aiden-protected-falsify-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const prepared = await prepareTaskQualityCase(root, caseId);
    const outcome = await runTaskQualityCase(prepared, await trajectory(prepared, "correct", { skipRead: true, prohibitedPlan: true }));
    assert.equal(outcome.lifecycle, "completed"); assert.equal(outcome.accepted, false);
    assert.equal(outcome.receipt.result, "failed"); await outcome.harness.dispose();
  }
});
test("candidate verifier OS boundary denies grading reads, protected writes and network", { timeout: 45000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "aiden-protected-isolation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const prepared = await prepareTaskQualityCase(root, "comfortable_window_control");
  const original = await readFile(join(prepared.fixtureRoot, prepared.task.id, "controls/correct/solution.py"), "utf8");
  const oracle = join(prepared.fixtureRoot, prepared.task.id, "oracle.py");
  const protectedFile = join(prepared.host, "attempted-forgery.json");
  const listener = createServer((socket) => socket.end());
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => listener.close(() => resolve())));
  const address = listener.address();
  assert.ok(address && typeof address !== "string");
  const { stdout } = await promisify(execFile)("python3", ["-I", resolve("scripts/task-quality-protected-verifier.py"), prepared.workspace, "--isolation-probe", oracle, protectedFile, String(address.port)], { timeout: 15000 });
  assert.deepEqual(JSON.parse(stdout), { isolated: true });
  const outcome = await runTaskQualityCase(prepared, await trajectory(prepared, "correct", { source: original }));
  assert.equal(outcome.accepted, true);
  await assert.rejects(readFile(protectedFile), /ENOENT/); await outcome.harness.dispose();
});

test("no-op and harmful policy controls retain the baseline with fresh paired workspaces", { timeout: 45000 }, async (t) => {
  const outcomes = [];
  for (const control of ["correct", "correct", "wrong_touching"]) {
    const root = await mkdtemp(join(tmpdir(), "aiden-policy-control-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const prepared = await prepareTaskQualityCase(root, "comfortable_window_control");
    const config = await trajectory(prepared, control);
    const identity = await taskQualityExperimentIdentity(prepared, config.model);
    assertCompatibleTaskQualityResume(identity, structuredClone(identity));
    assert.throws(() => assertCompatibleTaskQualityResume(identity, { ...identity, rootLockHash: "changed" }), /Incompatible/);
    const outcome = await runTaskQualityCase(prepared, config);
    outcomes.push([{ caseId: prepared.task.id, accepted: outcome.accepted }]);
    await outcome.harness.dispose();
  }
  assert.equal(classifyTaskQualityComparison(outcomes[0]!, outcomes[1]!), "baseline_retained");
  assert.equal(classifyTaskQualityComparison(outcomes[0]!, outcomes[2]!), "baseline_retained");
});

test("agent tools cannot read or overwrite grading material and attempted authority escape fails acceptance", { timeout: 45000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "aiden-agent-grade-denial-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const prepared = await prepareTaskQualityCase(root, "comfortable_window_control");
  const oracle = join(prepared.fixtureRoot, prepared.task.id, "oracle.py");
  const before = await readFile(oracle, "utf8");
  const core = createFauxCore({ provider: "offline-task-controls", api: "faux-offline-task-controls" });
  core.setResponses([
    fauxAssistantMessage([fauxToolCall("read_file", { path: oracle })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("write_file", { path: join(prepared.host, "forged-receipt.json"), content: '{"accepted":true}' })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("write_file", { path: "solution.py", content: await readFile(join(prepared.fixtureRoot, prepared.task.id, "controls/correct/solution.py"), "utf8") })], { stopReason: "toolUse" }),
    fauxAssistantMessage("The protected grade passed."),
  ]);
  const outcome = await runTaskQualityCase(prepared, { model: core.getModel(), streamFn: core.streamSimple });
  assert.equal(outcome.accepted, false);
  const denials = outcome.harness.state.messages.filter((message) => message.role === "toolResult" && message.isError);
  assert.equal(denials.length, 2);
  assert.ok(denials.every((message) => JSON.stringify(message).includes("Path escapes") || JSON.stringify(message).includes("outside") || JSON.stringify(message).includes("relative")));
  assert.equal(await readFile(oracle, "utf8"), before);
  await assert.rejects(readFile(join(prepared.host, "forged-receipt.json")), /ENOENT/);
  await outcome.harness.dispose();
});

test("persistent candidate state matches the frozen oracle and introspection cannot falsify mutation evidence", { timeout: 45000 }, async (t) => {
  const original = await readFile("docs/research/experiments/task-quality-fixtures/comfortable_window_control/controls/correct/solution.py", "utf8");
  const attacks = [
    original + '\noriginal_merge = merge_ranges\ncalls = 0\ndef merge_ranges(source):\n    global calls\n    calls += 1\n    if calls > 1: raise RuntimeError("second call fails")\n    return original_merge(source)\n',
    'import __main__\n' + original + '\noriginal_merge = merge_ranges\ndef merge_ranges(source):\n    saved = list(source)\n    result = original_merge(source)\n    source.sort()\n    __main__.request["args"] = [saved]\n    return result\n',
  ];
  for (const source of attacks) {
    const root = await mkdtemp(join(tmpdir(), "aiden-candidate-fidelity-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const prepared = await prepareTaskQualityCase(root, "comfortable_window_control");
    const outcome = await runTaskQualityCase(prepared, await trajectory(prepared, "correct", { source }));
    assert.equal(outcome.accepted, false);
    assert.notEqual(outcome.receipt.result, "passed");
    if (source.includes("second call fails")) {
      await assert.rejects(promisify(execFile)("python3", ["-I", join(prepared.fixtureRoot, prepared.task.id, "oracle.py"), prepared.workspace]), (error: unknown) => String((error as { stderr?: string }).stderr).includes("second call fails"));
    }
    await outcome.harness.dispose();
  }
});

test("cross-call retained aliases cannot hide mutation of an earlier oracle argument", { timeout: 45000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "aiden-cross-call-alias-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const prepared = await prepareTaskQualityCase(root, "old_only_constraints");
  const original = await readFile(join(prepared.fixtureRoot, prepared.task.id, "controls/correct/solution.py"), "utf8");
  const source = original + '\noriginal_render = render_events\n_saved = None\n_calls = 0\ndef render_events(rows):\n    global _saved, _calls\n    _calls += 1\n    result = original_render(rows)\n    if _calls == 1:\n        _saved = rows\n    elif _calls == 2:\n        _saved.append({"id": "forged", "label": "mutated"})\n    return result\n';
  const outcome = await runTaskQualityCase(prepared, await trajectory(prepared, "correct", { source }));
  assert.equal(outcome.accepted, false);
  assert.equal(outcome.receipt.result, "failed");
  await assert.rejects(promisify(execFile)("python3", ["-I", join(prepared.fixtureRoot, prepared.task.id, "oracle.py"), prepared.workspace]), (error: unknown) => String((error as { stderr?: string }).stderr).includes("input_unchanged"));
  await outcome.harness.dispose();
});
