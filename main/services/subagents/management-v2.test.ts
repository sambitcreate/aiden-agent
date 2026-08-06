import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_SUBAGENT_MANAGEMENT_WAIT_MS,
  parseSubagentManagementRequestV2,
} from "./management-v2.js";

test("management V2 accepts only exact action-specific envelopes", () => {
  assert.deepEqual(
    parseSubagentManagementRequestV2({ version: 2, action: "stop", runId: "run-1" }),
    { version: 2, action: "stop", runId: "run-1" },
  );
  assert.deepEqual(
    parseSubagentManagementRequestV2({
      version: 2,
      action: "wait",
      runId: "run-1",
      timeoutMs: MAX_SUBAGENT_MANAGEMENT_WAIT_MS,
    }),
    {
      version: 2,
      action: "wait",
      runId: "run-1",
      timeoutMs: MAX_SUBAGENT_MANAGEMENT_WAIT_MS,
    },
  );
  assert.deepEqual(
    parseSubagentManagementRequestV2({
      version: 2,
      action: "steer",
      runId: "run-1",
      instruction: "Recheck the cancellation path.",
    }),
    {
      version: 2,
      action: "steer",
      runId: "run-1",
      instruction: "Recheck the cancellation path.",
    },
  );
  assert.throws(
    () =>
      parseSubagentManagementRequestV2({
        version: 2,
        action: "stop",
        runId: "run-1",
        reason: "extra",
      }),
    /fields/u,
  );
  assert.throws(
    () =>
      parseSubagentManagementRequestV2({
        version: 2,
        action: "wait",
        runId: "run-1",
        timeoutMs: MAX_SUBAGENT_MANAGEMENT_WAIT_MS + 1,
      }),
    /fields/u,
  );
  assert.throws(
    () =>
      parseSubagentManagementRequestV2({
        version: 2,
        action: "steer",
        runId: "run-1",
        instruction: "\0",
      }),
    /fields/u,
  );
});
