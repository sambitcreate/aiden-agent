import assert from "node:assert/strict";
import test from "node:test";
import {
  isUnproxiedPlainObject,
  snapshotExactPlainRecord,
  snapshotPlainRecord,
} from "./plain-record.js";

test("snapshotPlainRecord rejects proxies before running traps and preserves __proto__ snapshots", () => {
  for (const value of [null, undefined, [], "x", 1, true, new Date(), Object.create({ a: 1 })]) {
    assert.equal(isUnproxiedPlainObject(value), false);
    assert.equal(snapshotPlainRecord(value), undefined);
  }

  let trapCalls = 0;
  const hostileProxy = new Proxy(
    { a: 1 },
    {
      getPrototypeOf() {
        trapCalls += 1;
        throw new Error("getPrototypeOf trap must not run");
      },
      ownKeys() {
        trapCalls += 1;
        throw new Error("ownKeys trap must not run");
      },
      getOwnPropertyDescriptor() {
        trapCalls += 1;
        throw new Error("getOwnPropertyDescriptor trap must not run");
      },
    },
  );
  assert.equal(isUnproxiedPlainObject(hostileProxy), false);
  assert.equal(snapshotPlainRecord(hostileProxy), undefined);
  assert.equal(trapCalls, 0);

  let getterCalls = 0;
  const withGetter = Object.defineProperty({ a: 1 }, "b", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return 2;
    },
  });
  assert.equal(snapshotPlainRecord(withGetter), undefined);
  assert.equal(getterCalls, 0);

  const withSymbol = { a: 1, [Symbol("hidden")]: 2 };
  assert.equal(snapshotPlainRecord(withSymbol), undefined);

  const nonEnumerable = Object.defineProperty({ a: 1 }, "hidden", {
    value: 2,
    enumerable: false,
  });
  assert.equal(snapshotPlainRecord(nonEnumerable), undefined);

  const reserved = JSON.parse('{"__proto__":{"sentinel":"kept"},"id":"ok"}') as unknown;
  const snap = snapshotPlainRecord(reserved);
  assert.ok(snap);
  assert.equal(Object.getPrototypeOf(snap), Object.prototype);
  assert.equal("sentinel" in snap, false);
  assert.equal(Object.prototype.hasOwnProperty.call(snap, "__proto__"), true);
  assert.deepEqual(Object.getOwnPropertyDescriptor(snap, "__proto__")?.value, { sentinel: "kept" });
  assert.equal(snap.id, "ok");
});

test("snapshotExactPlainRecord enforces required and optional key allowlists on plain data snapshots", () => {
  assert.deepEqual(snapshotExactPlainRecord({ a: 1, b: 2 }, ["a"], ["b"]), { a: 1, b: 2 });
  assert.deepEqual(snapshotExactPlainRecord({ a: 1 }, new Set(["a"]), new Set(["b"])), { a: 1 });
  assert.equal(snapshotExactPlainRecord({ b: 2 }, ["a"], ["b"]), undefined);
  assert.equal(snapshotExactPlainRecord({ a: 1, extra: 3 }, ["a"], ["b"]), undefined);
  assert.equal(
    snapshotExactPlainRecord(new Proxy({ a: 1 }, {}), ["a"]),
    undefined,
  );
});
