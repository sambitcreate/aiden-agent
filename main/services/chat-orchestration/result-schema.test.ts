// Structured results (Phase 5, D6): what a lead's schema may be, and how a
// started chat's result is checked against it.

import assert from "node:assert/strict";
import test from "node:test";

import { RESULT_MAX_BYTES, RESULT_MAX_VALUES, RESULT_SCHEMA_MAX_BYTES, checkResult, compileResultSchema, isStorableResultSchema } from "./result-schema.js";

const SCHEMA = {
  type: "object",
  properties: { files: { type: "array", items: { type: "string" } }, passed: { type: "boolean" } },
  required: ["files", "passed"],
  additionalProperties: false,
};

test("a result that matches is accepted, and one that doesn't names the field to fix", () => {
  assert.deepEqual(checkResult(SCHEMA, { files: ["a.ts"], passed: true }), { ok: true });
  const error = (value: unknown) => (checkResult(SCHEMA, value) as { error: string }).error;
  assert.match(error({ files: "a.ts", passed: true }), /\/files must be array/u);
  assert.match(error({ files: [] }), /\/passed is required/u);
  assert.match(error({ files: [], passed: true, extra: 1 }), /\/extra is not allowed/u);
  assert.match((checkResult(SCHEMA, undefined) as { error: string }).error, /needs a result/u);
});

test("a schema that refers outside itself, is too large or doesn't compile is refused", () => {
  assert.equal(compileResultSchema(SCHEMA).ok, true);
  assert.equal(compileResultSchema({ $defs: { n: { type: "number" } }, $ref: "#/$defs/n" }).ok, true, "local refs are fine");
  assert.equal(compileResultSchema({ definitions: { n: { type: "number" } }, $ref: "#/definitions/n" }).ok, true);
  const loop = compileResultSchema({ type: "object", properties: { child: { $ref: "#" } } });
  assert.match(loop.ok ? "" : loop.error, /refs must not loop/u, "a reference back to the root loops");
  const defsLoop = { $defs: { a: { $ref: "#/$defs/b" }, b: { anyOf: [{ type: "string" }, { $ref: "#/$defs/a" }] } }, $ref: "#/$defs/a" };
  assert.equal(compileResultSchema(defsLoop).ok, false);
  assert.equal(isStorableResultSchema(defsLoop), false);
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

/** The reviewer's shape: each level an anyOf of ten references to the next; the leaf a string. */
function branching(depth: number, width = 10): Record<string, unknown> {
  const $defs: Record<string, unknown> = { [`d${depth}`]: { type: "string" } };
  for (let level = depth - 1; level >= 0; level--) {
    $defs[`d${level}`] = { anyOf: Array.from({ length: width }, () => ({ $ref: `#/$defs/d${level + 1}` })) };
  }
  return { $defs, $ref: "#/$defs/d0" };
}

test("a schema whose branches multiply through references is refused before ajv sees it, in milliseconds", () => {
  for (let depth = 4; depth <= 8; depth++) {
    const schema = branching(depth);
    const started = performance.now();
    const compiled = compileResultSchema(schema);
    const checked = checkResult(schema, 1);
    assert.equal(compiled.ok, false, `depth ${depth}`);
    assert.match(compiled.ok ? "" : compiled.error, /could take too long to check/u);
    assert.equal(checked.ok, false);
    assert.equal(isStorableResultSchema(schema), false);
    assert.ok(performance.now() - started < 100, `depth ${depth} took ${performance.now() - started} ms`);
  }
  const refs = { $defs: { s: { type: "string" } }, type: "object", properties: Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`f${i}`, { $ref: "#/$defs/s" }])) };
  assert.match((compileResultSchema(refs) as { error: string }).error, /more than 256 references/u);
  const unique = { type: "array", uniqueItems: true };
  assert.match((compileResultSchema(unique) as { error: string }).error, /uniqueItems needs items with a plain type/u);
  assert.equal(compileResultSchema({ type: "array", uniqueItems: true, items: { type: "string" } }).ok, true);
});

test("a reasonable nested schema is accepted, and checking hostile values against it stays fast", () => {
  const schema = {
    type: "object",
    $defs: {
      file: { type: "object", properties: { path: { type: "string" }, lines: { type: "array", items: { type: "integer" } } }, required: ["path"] },
      status: { enum: ["passed", "failed", "skipped"] },
      note: { anyOf: [{ type: "string" }, { type: "null" }, { $ref: "#/$defs/file" }] },
    },
    properties: {
      files: { type: "array", items: { $ref: "#/$defs/file" } },
      status: { $ref: "#/$defs/status" },
      notes: { type: "array", items: { $ref: "#/$defs/note" } },
      tags: { type: "array", uniqueItems: true, items: { type: "string" } },
      groups: { type: "array", items: { type: "array", items: { anyOf: [{ type: "string" }, { type: "boolean" }, { type: "integer" }] } } },
    },
    required: ["files", "status"],
  };
  assert.equal(compileResultSchema(schema).ok, true);
  assert.equal(branching(2).$ref, "#/$defs/d0");
  assert.equal(compileResultSchema(branching(2)).ok, true, "ten-by-ten branching is fine");
  const hostile: unknown[] = [
    { files: [], status: "passed", notes: Array.from({ length: 16_000 }, () => [1]) },
    { files: [], status: "passed", tags: Array.from({ length: 6_000 }, (_, i) => `t${i}`) },
    { files: [], status: "passed", groups: Array.from({ length: 12_000 }, () => [{}]) },
    { files: Array.from({ length: 5_000 }, () => ({ path: 1 })), status: "nope" },
  ];
  for (const value of hostile) {
    assert.ok(Buffer.byteLength(JSON.stringify(value)) <= RESULT_MAX_BYTES, "a value the size limit lets through");
    const started = performance.now();
    checkResult(schema, value);
    assert.ok(performance.now() - started < 100, `took ${performance.now() - started} ms`);
  }
});

/** `$defs` d0…d<depth-1>, each an anyOf of `fan` refs to the next, ending in `leaf`. */
function tree(depth: number, fan: number, leaf: unknown): Record<string, unknown> {
  const $defs: Record<string, unknown> = { [`d${depth}`]: leaf };
  for (let level = 0; level < depth; level++) {
    $defs[`d${level}`] = { anyOf: Array.from({ length: fan }, () => ({ $ref: `#/$defs/d${level + 1}` })) };
  }
  return $defs;
}

function timedCheck(schema: unknown, value: unknown) {
  const started = performance.now();
  const checked = checkResult(schema, value);
  return { checked, ms: performance.now() - started };
}

test("a large result against a schema whose branches are costly is refused quickly, before ajv walks it", () => {
  const minLengths = { anyOf: Array.from({ length: 8 }, () => ({ minLength: 999_999 })) };
  const attacks: Array<[string, unknown, unknown]> = [
    // Each array item tries a ~8,700-node branch tree before the plain number branch matches.
    ["items through a branch tree", { $defs: tree(3, 16, { type: "string" }), type: "array", items: { anyOf: [{ $ref: "#/$defs/d0" }, { type: "number" }] } }, Array(9_000).fill(0)],
    // Every branch measures the whole 64 KB string again.
    ["minLength per branch", { $defs: tree(3, 8, minLengths), anyOf: [{ $ref: "#/$defs/d0" }, { type: "string" }] }, "a".repeat(64_000)],
    ["minLength per branch, surrogate pairs", { $defs: tree(3, 8, minLengths), anyOf: [{ $ref: "#/$defs/d0" }, { type: "string" }] }, "\u{1F600}".repeat(10_000)],
    ["minLength inside items", { $defs: tree(3, 8, minLengths), type: "array", items: { anyOf: [{ $ref: "#/$defs/d0" }, { type: "string" }] } }, ["a".repeat(63_000)]],
  ];
  for (const [name, schema, value] of attacks) {
    assert.equal(compileResultSchema(schema).ok, true, `${name}: the schema alone is allowed`);
    assert.ok(Buffer.byteLength(JSON.stringify(value)) <= RESULT_MAX_BYTES, `${name}: within the size limit`);
    const { checked, ms } = timedCheck(schema, value);
    assert.equal(checked.ok, false, name);
    assert.match(checked.ok ? "" : checked.error, /too large to check against this schema/u, name);
    assert.ok(ms < 100, `${name} took ${ms} ms`);
  }

  // A normal result still checks against the same costly schema, pass or fail.
  const costly = attacks[0]![1];
  assert.deepEqual(checkResult(costly, [1, 2, 3, "x"]), { ok: true });
  assert.equal(checkResult(costly, [1, {}]).ok, false);
  assert.match((checkResult(costly, [1, {}]) as { error: string }).error, /doesn't match the schema/u);
});

test("a result with too many values or too deep a nesting is refused before it is checked or serialized", () => {
  const many = timedCheck({ type: "array" }, Array(32_000).fill(0));
  assert.equal(many.checked.ok, false);
  assert.match((many.checked as { error: string }).error, new RegExp(`more than ${RESULT_MAX_VALUES.toLocaleString("en-US")} values`, "u"));
  assert.ok(many.ms < 100, `took ${many.ms} ms`);

  let deep: unknown = 0;
  for (let level = 0; level < 50_000; level++) deep = [deep];
  const nested = timedCheck({ type: "array" }, deep);
  assert.equal(nested.checked.ok, false);
  assert.match((nested.checked as { error: string }).error, /nested more than 64 levels/u);
  assert.ok(nested.ms < 100, `took ${nested.ms} ms`);

  assert.deepEqual(checkResult({ type: "array" }, [1, [2, [3]], []]), { ok: true });
  // Plenty of room for an ordinary structured answer.
  const report = { files: Array.from({ length: 400 }, (_, i) => `src/file-${i}.ts`), passed: true };
  assert.deepEqual(checkResult(SCHEMA, report), { ok: true });
});

test("long enum, const and required lists count toward a schema's cost, so branching over them is refused quickly", () => {
  const sixThousand = { enum: Array.from({ length: 6_000 }, (_, i) => i % 10) };
  const names = Array.from({ length: 1_700 }, (_, i) => `k${i}`);
  const constObject = Object.fromEntries(Array.from({ length: 1_200 }, (_, i) => [`a${i}`, i % 10]));
  const refused: Array<[string, unknown, unknown]> = [
    // A 15 KB schema whose 4,900 branches each compare against 6,000 members.
    ["enum under 70 × 70 branches", { $defs: tree(2, 70, sixThousand), $ref: "#/$defs/d0" }, -1],
    ["enum under 70 × 70 branches, as items", { $defs: tree(2, 70, sixThousand), type: "array", items: { anyOf: [{ $ref: "#/$defs/d0" }, { type: "string" }] } }, Array(90).fill(-1)],
    ["enum under 12 × 12 × 12 branches", { $defs: tree(3, 12, { enum: Array.from({ length: 5_000 }, (_, i) => i % 10) }), type: "array", items: { anyOf: [{ $ref: "#/$defs/d0" }, { type: "string" }] } }, [-1]],
    ["required under 70 × 70 branches", { $defs: tree(2, 70, { required: names }), $ref: "#/$defs/d0" }, {}],
    ["const under 70 × 70 branches", { $defs: tree(2, 70, { const: constObject }), $ref: "#/$defs/d0" }, { ...constObject, a1199: 99 }],
  ];
  for (const [name, schema, value] of refused) {
    const started = performance.now();
    const compiled = compileResultSchema(schema);
    const checked = checkResult(schema, value);
    const ms = performance.now() - started;
    assert.equal(compiled.ok, false, name);
    assert.match(compiled.ok ? "" : compiled.error, /could take too long to check/u, name);
    assert.equal(checked.ok, false, name);
    assert.equal(isStorableResultSchema(schema), false, name);
    assert.ok(ms < 100, `${name} took ${ms} ms`);
  }

  // An ordinary list of choices, used for every item, still works.
  const labels = { type: "array", items: { enum: Array.from({ length: 200 }, (_, i) => `label-${i}`) } };
  assert.deepEqual(checkResult(labels, Array.from({ length: 100 }, (_, i) => `label-${i}`)), { ok: true });
  assert.match((checkResult(labels, ["label-1", "nope"]) as { error: string }).error, /\/1 must be equal to one of the allowed values/u);
});

test("a schema whose shared $defs entry is referred to from many branches compiles and checks quickly", () => {
  // Many keywords in one ref-free entry, referred to 240 times: inlined, ajv
  // copied it into every branch and took seconds to compile.
  const keywords = {
    type: ["number", "string", "object", "array"], minimum: 1, maximum: 2, exclusiveMinimum: 0, exclusiveMaximum: 3, multipleOf: 0.37,
    minLength: 5, maxLength: 9, minItems: 1, maxItems: 3, minProperties: 1, maxProperties: 4,
  };
  const leaf = { properties: Object.fromEntries(Array.from({ length: 38 }, (_, i) => [`p${i}`, keywords])) };
  for (const [outer, inner] of [[2, 120], [3, 80]] as const) {
    const schema = {
      description: `shared entry ${outer}x${inner}`,
      $defs: { leaf, middle: { anyOf: Array.from({ length: inner }, () => ({ $ref: "#/$defs/leaf" })) } },
      anyOf: Array.from({ length: outer }, () => ({ $ref: "#/$defs/middle" })),
    };
    const started = performance.now();
    const checked = checkResult(schema, -1);
    const ms = performance.now() - started;
    assert.deepEqual(checked, { ok: true }, `${outer}x${inner}`);
    assert.ok(ms < 100, `${outer}x${inner}: compile and check took ${ms} ms`);
    assert.equal(checkResult(schema, { p0: 1.5 }).ok, false, "the shared entry still applies its keywords");
  }
});

test("a schema is compiled once: the same schema, in any key order, reuses its validator", () => {
  const schema = { type: "object", properties: { done: { type: "boolean" }, notes: { type: "string" } }, required: ["done"], description: "compiled once" };
  const first = compileResultSchema(schema);
  const reordered = compileResultSchema({ description: "compiled once", required: ["done"], properties: { notes: { type: "string" }, done: { type: "boolean" } }, type: "object" });
  assert.ok(first.ok && reordered.ok);
  assert.equal(reordered.validate, first.validate);
  assert.deepEqual(checkResult(structuredClone(schema), { done: true }), { ok: true });
  const other = compileResultSchema({ ...schema, required: ["notes"] });
  assert.ok(other.ok);
  assert.notEqual(other.validate, first.validate, "a different schema gets its own");

  // Only the most recent schemas are kept.
  for (let i = 0; i < 40; i++) compileResultSchema({ type: "string", description: `filler ${i}` });
  const again = compileResultSchema(schema);
  assert.ok(again.ok);
  assert.notEqual(again.validate, first.validate);
  assert.deepEqual(checkResult(schema, { done: false }), { ok: true });
});
