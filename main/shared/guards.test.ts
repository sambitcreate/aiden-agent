import assert from "node:assert/strict";
import test from "node:test";
import { hasExactKeys, isPlainObject, isRecord, snapshotPlainDataRecord } from "./guards.js";

test("isRecord accepts only non-array objects", () => {
  assert.equal(isRecord({}), true);
  assert.equal(isRecord(Object.create(null)), true);
  assert.equal(isRecord(new Date()), true);
  for (const value of [null, undefined, [], "x", 1, true]) assert.equal(isRecord(value), false);
});

test("isPlainObject rejects arrays, class instances, and inherited prototypes", () => {
  class Box {}
  assert.equal(isPlainObject({}), true);
  assert.equal(isPlainObject(Object.create(null)), true);
  for (const value of [null, undefined, [], "x", 1, true, new Date(), new Map(), new Box(), Object.create({ a: 1 })]) {
    assert.equal(isPlainObject(value), false);
  }
});

test("hasExactKeys enforces own required keys, accepts Set and empty required iterables, and rejects unknown keys", () => {
  assert.equal(hasExactKeys({ a: 1, b: 2 }, ["a"], ["b"]), true);
  assert.equal(hasExactKeys({ a: 1 }, ["a"], ["b"]), true);
  assert.equal(hasExactKeys({ b: 2 }, ["a"], ["b"]), false);
  assert.equal(hasExactKeys({ a: 1, extra: true }, ["a"]), false);
  assert.equal(hasExactKeys(Object.create({ a: 1 }) as Record<string, unknown>, ["a"]), false);

  const requiredSet: ReadonlySet<string> = new Set(["a", "b"]);
  const optionalSet: ReadonlySet<string> = new Set(["c"]);
  assert.equal(hasExactKeys({ a: 1, b: 2 }, requiredSet, optionalSet), true);
  assert.equal(hasExactKeys({ a: 1, b: 2, c: 3 }, requiredSet, optionalSet), true);
  assert.equal(hasExactKeys({ a: 1, c: 3 }, requiredSet, optionalSet), false);
  assert.equal(hasExactKeys({ b: 2 }, [], optionalSet), false);
  assert.equal(hasExactKeys({ c: 3 }, [], optionalSet), true);
  assert.equal(hasExactKeys({}, [], optionalSet), true);

  const parsed = JSON.parse('{"a":1,"__proto__":{"b":2}}') as Record<string, unknown>;
  assert.equal(hasExactKeys(parsed, ["a"], ["b"]), false);
});

test("snapshotPlainDataRecord rejects hostile shapes without running accessors and preserves __proto__ as own data", () => {
  assert.equal(snapshotPlainDataRecord(null), undefined);
  assert.equal(snapshotPlainDataRecord([]), undefined);
  assert.equal(snapshotPlainDataRecord(Object.create({ inherited: 1 })), undefined);

  let getterRuns = 0;
  const withGetter = Object.defineProperty({ ok: 1 }, "secret", {
    enumerable: true,
    get() {
      getterRuns += 1;
      return "leaked";
    },
  });
  assert.equal(snapshotPlainDataRecord(withGetter), undefined);
  assert.equal(getterRuns, 0);

  const withHidden = Object.defineProperty({ ok: 1 }, "hidden", {
    value: 2,
    enumerable: false,
  });
  assert.equal(snapshotPlainDataRecord(withHidden), undefined);

  const withSymbol = { ok: 1, [Symbol("tag")]: true };
  assert.equal(snapshotPlainDataRecord(withSymbol), undefined);

  const nullProto = Object.assign(Object.create(null) as Record<string, unknown>, { a: 1, b: "two" });
  const fromNullProto = snapshotPlainDataRecord(nullProto);
  assert.deepEqual(fromNullProto, { a: 1, b: "two" });
  assert.equal(Object.getPrototypeOf(fromNullProto), Object.prototype);

  const protoPayload = JSON.parse('{"a":1,"__proto__":{"polluted":true}}') as unknown;
  const snap = snapshotPlainDataRecord(protoPayload);
  assert.ok(snap);
  assert.equal(Object.getPrototypeOf(snap), Object.prototype);
  assert.equal("polluted" in snap, false);
  assert.equal(Object.prototype.hasOwnProperty.call(snap, "__proto__"), true);
  assert.deepEqual(Object.getOwnPropertyDescriptor(snap, "__proto__")?.value, { polluted: true });
});
