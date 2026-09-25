import assert from "node:assert/strict";
import test from "node:test";

import {
  REQUIRED_JOB_RULES,
  evaluateRequiredEnvironment,
  evaluateRequiredGate,
  parseChangedAreaDecisions,
} from "./ci-required.mjs";

const allTrue = { android: true, apple: true, desktop: true, ios: true };

function needsFor(decisions = allTrue, overrides = {}) {
  const needs = {
    android: { result: "success" },
    apple: { result: "success" },
    changes: { result: "success" },
    e2e: { result: "success" },
    ios: { result: "success" },
    linux: { result: "success" },
    "linux-rpm": { result: "success" },
    policy: { result: "success" },
    static: { result: "success" },
    unit: { result: "success" },
    verify: { result: "success" },
  };
  return { decisions, needs: { ...needs, ...overrides } };
}

test("the aggregate gate accepts successful required jobs", () => {
  const { decisions, needs } = needsFor();
  const result = evaluateRequiredGate(needs, decisions);
  assert.equal(result.ok, true);
  assert.equal(result.failures.length, 0);
  assert.equal(result.checkedCount, Object.keys(REQUIRED_JOB_RULES).length);
});

test("a conditional job may be skipped only for its explicitly false area", () => {
  const decisions = { ...allTrue, desktop: false, android: false };
  const { needs } = needsFor(decisions, {
    android: { result: "skipped" },
    e2e: { result: "skipped" },
    unit: { result: "skipped" },
    verify: { result: "skipped" },
  });
  assert.equal(evaluateRequiredGate(needs, decisions).ok, true);

  const { needs: allAreaNeeds } = needsFor(allTrue, { verify: { result: "skipped" } });
  const unexpected = evaluateRequiredGate(allAreaNeeds, allTrue);
  assert.equal(unexpected.ok, false);
  assert.deepEqual(unexpected.failures, [{ job: "verify", reason: "unexpected-skip" }]);
});

test("failed, canceled, unknown, and missing results fail the aggregate", () => {
  const { needs, decisions } = needsFor();
  const cases = [
    ["failure", { result: "failure" }, "result-failure"],
    ["cancelled", { result: "cancelled" }, "result-cancelled"],
    ["unknown", { result: "neutral" }, "result-neutral"],
    ["missing", {}, "missing-result"],
  ];
  for (const [name, entry, reason] of cases) {
    const result = evaluateRequiredGate({ ...needs, e2e: entry }, decisions);
    assert.equal(result.ok, false, name);
    assert.deepEqual(result.failures, [{ job: "e2e", reason }], name);
  }
});

test("GitHub matrix jobs expose one aggregate result on their needs entry", () => {
  const { needs, decisions } = needsFor();
  const successful = evaluateRequiredGate(
    { ...needs, unit: { result: "success" } },
    decisions,
  );
  assert.equal(successful.ok, true);

  const failed = evaluateRequiredGate(
    { ...needs, unit: { result: "failure" } },
    decisions,
  );
  assert.deepEqual(failed.failures, [{ job: "unit", reason: "result-failure" }]);
});

test("malformed needs entries fail closed instead of authorizing a skip", () => {
  const { needs, decisions } = needsFor({ ...allTrue, desktop: false });
  for (const entry of ["skipped", ["skipped"], { results: "skipped" }, { result: ["skipped"] }]) {
    const result = evaluateRequiredGate({ ...needs, unit: entry }, decisions);
    assert.equal(result.ok, false, JSON.stringify(entry));
    assert.deepEqual(result.failures, [{ job: "unit", reason: "missing-result" }], JSON.stringify(entry));
  }
});

test("changes decisions reject malformed or incomplete values", () => {
  assert.deepEqual(parseChangedAreaDecisions({ outputs: { desktop: "true", apple: "false", ios: true, android: false } }), {
    desktop: true,
    apple: false,
    ios: true,
    android: false,
  });
  assert.throws(() => parseChangedAreaDecisions({ desktop: "maybe" }), /changes-invalid/u);
  assert.throws(() => parseChangedAreaDecisions({ desktop: true, apple: true, ios: true }), /changes-invalid/u);
  assert.throws(() => parseChangedAreaDecisions("[]"), /changes-malformed/u);

  const { needs } = needsFor();
  const malformed = evaluateRequiredGate(needs, { desktop: "maybe" });
  assert.equal(malformed.ok, false);
  assert.equal(malformed.failures[0].job, "changes");
});

test("the environment adapter requires both JSON inputs and keeps failures safe", () => {
  const { needs, decisions } = needsFor();
  const pass = evaluateRequiredEnvironment({
    CI_CHANGES_JSON: JSON.stringify({ outputs: decisions }),
    CI_NEEDS_JSON: JSON.stringify(needs),
  });
  assert.equal(pass.ok, true);

  const missing = evaluateRequiredEnvironment({ CI_CHANGES_JSON: JSON.stringify(decisions) });
  assert.equal(missing.ok, false);
  assert.ok(missing.failures.some(({ job }) => job === "needs"));

  const malformed = evaluateRequiredEnvironment({ CI_CHANGES_JSON: "not-json", CI_NEEDS_JSON: "{}" });
  assert.equal(malformed.ok, false);
  assert.ok(malformed.failures.length > 0);
});
