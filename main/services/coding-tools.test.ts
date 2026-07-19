import assert from "node:assert/strict";
import test from "node:test";
import { summarizeToolCall } from "./coding-tools.js";

test("approval summaries describe the consequence of mutating tools", () => {
  assert.equal(
    summarizeToolCall("write_file", { path: "src/app.ts" }),
    "Create or replace file: src/app.ts",
  );
  assert.equal(summarizeToolCall("edit_file", { path: "src/app.ts" }), "Edit file: src/app.ts");
  assert.equal(summarizeToolCall("run_command", { command: "npm test" }), "Run command: npm test");
});
