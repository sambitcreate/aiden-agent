import assert from "node:assert/strict";
import test from "node:test";
import { resolveCreateImagesPromptVariables } from "./prompt-variables.js";

const variables = [
  { id: "subject-id", name: "subject", required: true },
  { id: "mood-id", name: "mood", required: false },
];

test("prompt variables resolve stable IDs and preserve escaped literals", () => {
  assert.deepEqual(
    resolveCreateImagesPromptVariables(
      "Paint ${subject} in a ${mood} room; write \\${subject} literally.",
      variables,
      { "subject-id": "a fox", "mood-id": "quiet" },
    ),
    { status: "ready", text: "Paint a fox in a quiet room; write ${subject} literally." },
  );
});

test("prompt variables fail closed for missing required and undeclared tokens", () => {
  assert.equal(
    resolveCreateImagesPromptVariables("${subject}", variables, {}).status,
    "invalid",
  );
  assert.equal(
    resolveCreateImagesPromptVariables("${unknown}", [], {}).status,
    "invalid",
  );
});
