import assert from "node:assert/strict";
import test from "node:test";
import { parseAdvisorSelection } from "./advisor.js";

test("one-call advisor selection parser is strict and never carries persisted policy", () => {
  const selection = {
    providerId: "anthropic",
    modelId: "claude-reviewer",
    effort: "high",
  };
  assert.deepEqual(parseAdvisorSelection(selection), selection);
  assert.equal(parseAdvisorSelection({ ...selection, future: true }), undefined);
  assert.equal(parseAdvisorSelection({ ...selection, effort: "ultra" }), undefined);
  assert.equal(parseAdvisorSelection({ providerId: "anthropic" }), undefined);
  assert.equal(
    parseAdvisorSelection({ ...selection, providerId: "anthropic\u202Eoverride" }),
    undefined,
  );
  assert.equal(parseAdvisorSelection({ ...selection, modelId: "claude\u2028reviewer" }), undefined);
  assert.equal(parseAdvisorSelection(null), undefined);
});
