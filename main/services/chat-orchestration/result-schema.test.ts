// Structured results (Phase 5, D6): what a lead's schema may be, and how a
// started chat's result is checked against it.

import assert from "node:assert/strict";
import test from "node:test";

import { RESULT_SCHEMA_MAX_BYTES, checkResult, compileResultSchema, isStorableResultSchema } from "./result-schema.js";

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
  assert.equal(compileResultSchema({ definitions: { n: { type: "number" } }, $ref: "#/definitions/n" }).ok, true);
  assert.equal(compileResultSchema({ type: "object", properties: { child: { $ref: "#" } } }).ok, true, "the root is fine");
  const cases: Array<[string, unknown, RegExp]> = [
    ["remote $ref", { $ref: "https://example.com/schema.json" }, /may only refer to .*; https:\/\/example\.com\/schema\.json isn't/u],
    ["nested remote $ref", { properties: { a: { $ref: "other.json#/a" } } }, /other\.json#\/a isn't/u],
    ["pointer into another keyword", { properties: { a: { $ref: "#/properties/b" } } }, /#\/properties\/b isn't/u],
    ["escaped pointer", { $defs: { "a/b": {} }, $ref: "#/$defs/a~1b" }, /#\/\$defs\/a~1b isn't/u],
    ["anchor", { $ref: "#thing" }, /#thing isn't/u],
    ["nested too deeply", nest(70), /nested more than 64 levels/u],
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

function nest(levels: number): Record<string, unknown> {
  let schema: Record<string, unknown> = { type: "string" };
  for (let level = 0; level < levels; level++) schema = { anyOf: [schema] };
  return schema;
}

test("a schema with a regular expression anywhere is refused, so a crafted pattern can't freeze Aiden", () => {
  const nested = { type: "object", properties: { id: { type: "string", pattern: "^(a+)+$" } } };
  const keyed = { type: "object", patternProperties: { "^x": { type: "string" } } };
  const names = { type: "object", propertyNames: { pattern: "^[a-z]+$" } };
  const deep = { type: "object", $defs: { item: { anyOf: [{ type: "string", pattern: "(.*a){20}" }] } }, properties: { item: { $ref: "#/$defs/item" } } };
  for (const [schema, keyword] of [[nested, "pattern"], [keyed, "patternProperties"], [names, "pattern"], [deep, "pattern"]] as const) {
    const compiled = compileResultSchema(schema);
    assert.equal(compiled.ok, false, keyword);
    assert.match(compiled.ok ? "" : compiled.error, new RegExp(`can't contain the key "${keyword}"`, "u"));
    assert.equal(isStorableResultSchema(schema), false, keyword);
  }
  // An enum value that reads like a keyword is data and fine; a property literally
  // named "pattern" is refused, with a message that says so.
  const valueNamed = { type: "object", properties: { kind: { type: "string", enum: ["pattern"] } } };
  assert.equal(compileResultSchema(valueNamed).ok, true);
  assert.deepEqual(checkResult(valueNamed, { kind: "pattern" }), { ok: true });
  const fieldNamed = { type: "object", properties: { pattern: { type: "string" } } };
  assert.match((compileResultSchema(fieldNamed) as { error: string }).error, /even as a property name/u);

  // The catastrophic pattern would hang a check of this short value; refused, nothing runs.
  const started = Date.now();
  const outcome = checkResult(nested, { id: `${"a".repeat(28)}!` });
  assert.equal(outcome.ok, false);
  assert.ok(Date.now() - started < 1_000);
});

// Each bypass the loop-closing review measured (about 2.3 s on 27 characters
// through #/default): ajv would follow the reference into data, or compile a
// pattern under a map name, and run the catastrophic RegExp. Every one is
// refused before ajv sees it, both for a new start and for a stored link.
test("a pattern hidden in data keywords, $defs names or dependentSchemas is refused, and a ref can't reach it", () => {
  const evil = { type: "string", pattern: "^(a+)+$" };
  const refusals: Array<[string, unknown]> = [
    ["#/default", { default: evil, $ref: "#/default" }],
    ["#/examples/0", { examples: [evil], $ref: "#/examples/0" }],
    ["#/enum/0", { enum: [evil], $ref: "#/enum/0" }],
    ["#/const", { const: evil, $ref: "#/const" }],
    ["$defs named pattern", { $defs: { pattern: { type: "string" } }, $ref: "#/$defs/pattern" }],
    ["$defs map holding pattern", { $defs: { pattern: "^(a+)+$" } }],
    ["dependentSchemas", { type: "object", dependentSchemas: { pattern: { type: "object" } } }],
    ["dependentSchemas holding a pattern", { type: "object", dependentSchemas: { a: { properties: { b: evil } } } }],
    ["data keyword alone", { default: evil }],
  ];
  const value = `${"a".repeat(27)}!`;
  for (const [name, schema] of refusals) {
    const compiled = compileResultSchema(schema);
    assert.equal(compiled.ok, false, name);
    assert.equal(isStorableResultSchema(schema), false, `${name} must not survive a restart`);
    const started = Date.now();
    assert.equal(checkResult(schema, value).ok, false, name);
    assert.ok(Date.now() - started < 500, `${name} ran a regular expression`);
  }
  // Pointers into data are refused even when the data holds no pattern.
  for (const ref of ["#/default", "#/examples/0", "#/enum/0", "#/const"]) {
    assert.equal(compileResultSchema({ default: { type: "string" }, examples: [{}], enum: [{}], const: {}, $ref: ref }).ok, false, ref);
  }
  assert.equal(isStorableResultSchema({ $defs: { n: { type: "number" } }, $ref: "#/$defs/n" }), true);
});
