import assert from "node:assert/strict";
import test from "node:test";
import { hasExactKeys, isRecord } from "./guards.js";

test("isRecord accepts only non-array objects", () => {
  assert.equal(isRecord({}), true);
  assert.equal(isRecord(Object.create(null)), true);
  for (const value of [null, undefined, [], "x", 1, true]) assert.equal(isRecord(value), false);
});

test("hasExactKeys enforces own required keys and rejects unknown keys", () => {
  assert.equal(hasExactKeys({ a: 1, b: 2 }, ["a"], ["b"]), true);
  assert.equal(hasExactKeys({ a: 1 }, ["a"], ["b"]), true);
  assert.equal(hasExactKeys({ b: 2 }, ["a"], ["b"]), false);
  assert.equal(hasExactKeys({ a: 1, extra: true }, ["a"]), false);
  assert.equal(hasExactKeys(Object.create({ a: 1 }) as Record<string, unknown>, ["a"]), false);
  const parsed = JSON.parse('{"a":1,"__proto__":{"b":2}}') as Record<string, unknown>;
  assert.equal(hasExactKeys(parsed, ["a"], ["b"]), false);
});
