import assert from "node:assert/strict";
import test from "node:test";
import { copyBoundedJson, utf8Size, worstCaseJsonSize, type JsonCopyBounds } from "./bounded-json.js";

const roomy: JsonCopyBounds = { maxNodes: 1000, maxDepth: 16, maxSize: 100_000, measure: utf8Size };

test("plain JSON is copied exactly into detached null-prototype containers", () => {
  const shared = { tag: "reused" };
  const source = { text: "héllo", count: -0.5, flag: false, none: null, list: [1, "two", [shared, shared]], nested: { shared } };
  const copy = copyBoundedJson(source, roomy) as Record<string, unknown>;
  assert.deepEqual(JSON.parse(JSON.stringify(copy)), JSON.parse(JSON.stringify(source)));
  assert.equal(Object.getPrototypeOf(copy), null);
  shared.tag = "changed";
  (source.list as unknown[]).push("late");
  assert.match(JSON.stringify(copy), /"reused"/u);
  assert.equal((copy.list as unknown[]).length, 3);
  assert.equal(copyBoundedJson("just a string", roomy), "just a string");
});

test("non-JSON shapes are rejected whole and accessors never run", () => {
  let accessed = false;
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  const sparse: number[] = [];
  sparse[2] = 3;
  const extended = Object.assign([1, 2], { extra: true });
  const rejected: unknown[] = [
    cycle, sparse, extended, new Date(0), new Map(), { value: undefined }, { value: () => 1 }, { value: Number.NaN },
    { value: Infinity }, { value: 1n }, { value: Symbol("x") },
    { get secret() { accessed = true; return 1; } },
  ];
  for (const value of rejected) assert.equal(copyBoundedJson(value, roomy), undefined);
  assert.equal(accessed, false);
});

test("node, depth and size bounds each reject oversized input", () => {
  const deep = (levels: number) => {
    let value: unknown = "leaf";
    for (let index = 0; index < levels; index += 1) value = [value];
    return value;
  };
  assert.notEqual(copyBoundedJson(deep(16), roomy), undefined);
  assert.equal(copyBoundedJson(deep(17), roomy), undefined);
  assert.notEqual(copyBoundedJson(Array.from({ length: 999 }, () => 0), roomy), undefined);
  assert.equal(copyBoundedJson(Array.from({ length: 1000 }, () => 0), roomy), undefined);
  // A repeated reference counts each time it appears.
  const block = Array.from({ length: 400 }, () => 0);
  assert.equal(copyBoundedJson([block, block, block], roomy), undefined);
});

test("the string measure decides the size budget", () => {
  const accented = "é".repeat(1000); // 1000 UTF-16 units, 2000 UTF-8 bytes
  const bytes: JsonCopyBounds = { ...roomy, maxSize: 2002 };
  assert.equal(copyBoundedJson(accented, bytes), accented);
  assert.equal(copyBoundedJson(accented, { ...bytes, maxSize: 2001 }), undefined);
  assert.equal(copyBoundedJson(accented, { ...bytes, measure: worstCaseJsonSize }), undefined);
  assert.equal(copyBoundedJson(accented, { ...bytes, maxSize: 6002, measure: worstCaseJsonSize }), accented);
  // Keys are charged as well as values.
  assert.equal(copyBoundedJson({ [accented]: 1 }, { ...roomy, maxSize: 2004 }), undefined);
  assert.notEqual(copyBoundedJson({ [accented]: 1 }, { ...roomy, maxSize: 2050 }), undefined);
});

test("ordinary objects keep Object.prototype while __proto__ stays an own key", () => {
  const source = JSON.parse('{"__proto__": {"polluted": true}, "nested": {"value": 1}}') as Record<string, unknown>;
  const copy = copyBoundedJson(source, { ...roomy, ordinaryObjects: true }) as Record<string, unknown>;
  assert.equal(Object.getPrototypeOf(copy), Object.prototype);
  assert.equal(Object.getPrototypeOf(copy.nested), Object.prototype);
  assert.equal((copy as { polluted?: unknown }).polluted, undefined);
  assert.equal(({} as { polluted?: unknown }).polluted, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(copy)), { ["__proto__"]: { polluted: true }, nested: { value: 1 } });
  assert.deepStrictEqual(copyBoundedJson({ a: [1, { b: "c" }] }, { ...roomy, ordinaryObjects: true }), { a: [1, { b: "c" }] });
});
