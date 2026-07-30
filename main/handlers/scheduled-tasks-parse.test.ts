import assert from "node:assert/strict";
import test from "node:test";
import { parseScheduledTaskInput } from "./scheduled-tasks-parse.js";

const valid = {
  name: "Daily brief",
  mode: "llm",
  cron: "0 9 * * *",
  prompt: "Summarize changes.",
};

test("scheduled task parser accepts exact permission values", () => {
  assert.equal(parseScheduledTaskInput(valid).permission, undefined);
  assert.equal(
    parseScheduledTaskInput({ ...valid, permission: "read-only" }).permission,
    "read-only",
  );
  assert.equal(parseScheduledTaskInput({ ...valid, permission: "full" }).permission, "full");
});

test("scheduled task parser rejects malformed permission values instead of preserving access", () => {
  for (const permission of ["ask", "read_only", "", null, undefined]) {
    assert.throws(
      () => parseScheduledTaskInput({ ...valid, permission }),
      /invalid scheduled task permission/iu,
    );
  }
});

test("renderer task mutations cannot forge the main-owned Assistant execution profile", () => {
  const parsed = parseScheduledTaskInput({
    ...valid,
    executionProfile: "assistant",
  });
  assert.equal("executionProfile" in parsed, false);
});

test("scheduled task parser normalizes a bounded exact MCP server scope", () => {
  assert.deepEqual(
    parseScheduledTaskInput({
      ...valid,
      permission: "full",
      mcpServerIds: [" gmail ", "gmail", "notion"],
    }).mcpServerIds,
    ["gmail", "notion"],
  );
  for (const mcpServerIds of [
    [""],
    [42],
    Array.from({ length: 17 }, (_, index) => `mcp-${index}`),
  ]) {
    assert.throws(
      () => parseScheduledTaskInput({ ...valid, permission: "full", mcpServerIds }),
      /MCP server/iu,
    );
  }
});
