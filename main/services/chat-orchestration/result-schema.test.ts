// Structured results (Phase 5, D6): what a lead's schema may be, and how a
// started chat's result is checked against it.

import assert from "node:assert/strict";
import test from "node:test";

import { RESULT_SCHEMA_MAX_BYTES, checkResult, compileResultSchema } from "./result-schema.js";

const SCHEMA = {
  type: "object",
  properties: { files: { type: "array", items: { type: "string" } }, passed: { type: "boolean" } },
  required: ["files", "passed"],
  additionalProperties: false,
};

test("a result that matches is accepted, and one that doesn't names the fields to fix", () => {
  assert.deepEqual(checkResult(SCHEMA, { files: ["a.ts"], passed: true }), { ok: true });
  const wrong = checkResult(SCHEMA, { files: "a.ts", extra: 1 });
  assert.equal(wrong.ok, false);
  const error = (wrong as { error: string }).error;
  assert.match(error, /\/files must be array/u);
  assert.match(error, /\/passed is required/u);
  assert.match(error, /\/extra is not allowed/u);
  assert.match((checkResult(SCHEMA, undefined) as { error: string }).error, /needs a result/u);
});

test("a schema that refers outside itself, is too large or doesn't compile is refused", () => {
  assert.equal(compileResultSchema(SCHEMA).ok, true);
  assert.equal(compileResultSchema({ $defs: { n: { type: "number" } }, $ref: "#/$defs/n" }).ok, true, "local refs are fine");
  const cases: Array<[string, unknown, RegExp]> = [
    ["remote $ref", { $ref: "https://example.com/schema.json" }, /only refer inside itself; https:\/\/example\.com\/schema\.json/u],
    ["nested remote $ref", { properties: { a: { $ref: "other.json#/a" } } }, /other\.json#\/a points elsewhere/u],
    ["too large", { description: "x".repeat(RESULT_SCHEMA_MAX_BYTES) }, /larger than 16 KB/u],
    ["not an object", [1, 2], /must be a JSON Schema object/u],
    ["won't compile", { type: "not-a-type" }, /doesn't compile/u],
  ];
  for (const [name, schema, pattern] of cases) {
    const outcome = compileResultSchema(schema);
    assert.equal(outcome.ok, false, name);
    assert.match((outcome as { error: string }).error, pattern, name);
  }
});
