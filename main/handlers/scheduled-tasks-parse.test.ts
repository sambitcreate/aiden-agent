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
