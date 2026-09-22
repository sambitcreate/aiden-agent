import assert from "node:assert/strict";
import test from "node:test";
import { parseWorkflowDocument } from "../shared/create-images/schema.js";
import { validateWorkflowGraph } from "../shared/create-images/ports.js";
import { CREATE_IMAGES_FIXTURES, createImagesFixture } from "./fixtures.js";

test("every shipped image-workflow fixture satisfies the strict document and graph contracts", () => {
  const ids = ["blank", ...CREATE_IMAGES_FIXTURES.map((fixture) => fixture.id), "stress-250"];
  for (const id of ids) {
    const document = createImagesFixture(id);
    assert.ok(document, `missing fixture ${id}`);
    const parsed = parseWorkflowDocument(document);
    if (!parsed.success) assert.fail(`${id}: ${JSON.stringify(parsed.issues)}`);
    assert.deepEqual(validateWorkflowGraph(document), [], `${id} has an invalid graph`);
  }
});

test("stress fixtures expose exact bounded canvas sizes without leaking mutable instances", () => {
  const hundred = createImagesFixture("stress-100");
  const twoHundredFifty = createImagesFixture("stress-250");
  assert.equal(hundred?.nodes.length, 100);
  assert.equal(twoHundredFifty?.nodes.length, 250);
  assert.ok((twoHundredFifty?.edges.length ?? 0) > (hundred?.edges.length ?? 0));
  assert.ok(
    (hundred?.nodes.find((node) => node.id === "stress-prompt-1")?.position.y ?? 0) -
      (hundred?.nodes.find((node) => node.id === "stress-prompt-0")?.position.y ?? 0) >=
      1_000,
    "stress rows must remain clear of the full capability-driven Generate Image card",
  );

  const starter = createImagesFixture("starter");
  assert.ok(starter);
  starter.title = "mutated";
  assert.notEqual(createImagesFixture("starter")?.title, "mutated");
});

test("fixture lookup rejects inherited, encoded, and oversized route identifiers", () => {
  for (const id of [
    "constructor",
    "toString",
    "__proto__",
    "%5F%5Fproto%5F%5F",
    "../starter",
    "x".repeat(129),
    "",
  ]) {
    assert.equal(createImagesFixture(id), undefined, id);
  }
});
