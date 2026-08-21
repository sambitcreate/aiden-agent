import assert from "node:assert/strict";
import test from "node:test";
import { parseCreateImagesPromptList } from "./prompt-list.js";

test("prompt lists preserve order for newline and JSON input", () => {
  assert.deepEqual(parseCreateImagesPromptList("first\n\n second ", "lines"), {
    status: "ready",
    items: ["first", "second"],
  });
  assert.deepEqual(parseCreateImagesPromptList('["one", "two"]', "json"), {
    status: "ready",
    items: ["one", "two"],
  });
});

test("prompt lists fail closed on malformed, typed, empty, and oversized batches", () => {
  assert.equal(parseCreateImagesPromptList("{}", "json").status, "invalid");
  assert.equal(parseCreateImagesPromptList('["one", 2]', "json").status, "invalid");
  assert.equal(parseCreateImagesPromptList("\n", "lines").status, "invalid");
  assert.equal(
    parseCreateImagesPromptList(Array.from({ length: 9 }, (_, index) => `p${index}`).join("\n"), "lines").status,
    "invalid",
  );
});
