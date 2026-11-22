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

test("a schema with a regular expression anywhere is refused, so a crafted pattern can't freeze Aiden", () => {
  const nested = { type: "object", properties: { id: { type: "string", pattern: "^(a+)+$" } } };
  const keyed = { type: "object", patternProperties: { "^x": { type: "string" } } };
  const names = { type: "object", propertyNames: { pattern: "^[a-z]+$" } };
  const deep = { type: "object", $defs: { item: { anyOf: [{ type: "string", pattern: "(.*a){20}" }] } }, properties: { item: { $ref: "#/$defs/item" } } };
  for (const [schema, keyword] of [[nested, "pattern"], [keyed, "patternProperties"], [names, "propertyNames"], [deep, "pattern"]] as const) {
    const compiled = compileResultSchema(schema);
    assert.equal(compiled.ok, false, keyword);
    assert.match(compiled.ok ? "" : compiled.error, new RegExp(`can't use ${keyword}`, "u"));
  }
  // A field merely named "pattern", or an enum value that reads like one, is fine.
  const fieldNamed = { type: "object", properties: { pattern: { type: "string", enum: ["pattern"] } }, required: ["pattern"] };
  assert.equal(compileResultSchema(fieldNamed).ok, true);
  assert.deepEqual(checkResult(fieldNamed, { pattern: "pattern" }), { ok: true });

  // The catastrophic pattern would hang a check of this short value; refused, nothing runs.
  const started = Date.now();
  const outcome = checkResult(nested, { id: `${"a".repeat(28)}!` });
  assert.equal(outcome.ok, false);
  assert.ok(Date.now() - started < 1_000);
});
