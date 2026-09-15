import assert from "node:assert/strict";
import test from "node:test";
import { ASSISTANT_AUTOMATION_DRAFT } from "./assistant-dock.js";

test("automation entry point seeds a bounded sentence the user can complete", () => {
  assert.equal(ASSISTANT_AUTOMATION_DRAFT, "Create an automation that ");
  assert.equal(ASSISTANT_AUTOMATION_DRAFT.length < 80, true);
});
