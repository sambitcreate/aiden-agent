import assert from "node:assert/strict";
import test from "node:test";
import {
  ADVISOR_DISCLOSURE_VERSION,
  emptyAdvisorConfiguration,
  parseAdvisorConfiguration,
  parseAdvisorSelection,
} from "./advisor.js";

test("advisor configuration parser is strict and versioned", () => {
  const selection = {
    providerId: "anthropic",
    modelId: "claude-reviewer",
    effort: "high",
    disabledForExecutors: [{ providerId: "openai", modelId: "strong", minEffort: "high" }],
    disclosureVersion: ADVISOR_DISCLOSURE_VERSION,
  };
  assert.deepEqual(parseAdvisorSelection(selection), selection);
  assert.deepEqual(
    parseAdvisorConfiguration({
      version: 1,
      selection,
      disabledForExecutors: selection.disabledForExecutors,
    }),
    { version: 1, selection, disabledForExecutors: selection.disabledForExecutors },
  );
  assert.equal(parseAdvisorSelection({ ...selection, future: true }), undefined);
  assert.equal(parseAdvisorSelection({ ...selection, effort: "ultra" }), undefined);
  assert.equal(
    parseAdvisorConfiguration({ version: 2, selection: null, disabledForExecutors: [] }),
    null,
  );
  assert.equal(
    parseAdvisorConfiguration({ version: 1, selection, disabledForExecutors: [] }),
    null,
  );
  assert.deepEqual(emptyAdvisorConfiguration(), {
    version: 1,
    selection: null,
    disabledForExecutors: [],
  });
});
