import assert from "node:assert/strict";
import test from "node:test";
import {
  boundedString,
  hasExactKeys,
  hasOwn,
  isFiniteTimestamp,
  isPlainRecord,
  isRecord,
  isTimestamp,
  ownEntry,
  parseUtf8BoundedString,
  recordOf,
  requireAllowedKeys,
  requirePlainShape,
  setOwnEntry,
  timestampOf,
} from "./guards.js";

test("isRecord and recordOf accept only non-array objects", () => {
  const plain = { a: 1 };
  const nullProto = Object.create(null) as Record<string, unknown>;
  assert.equal(isRecord(plain), true);
  assert.equal(isRecord(nullProto), true);
  assert.equal(recordOf(plain), plain);
  assert.equal(recordOf(nullProto), nullProto);
  for (const value of [null, undefined, [], "x", 1, true]) {
    assert.equal(isRecord(value), false);
    assert.equal(recordOf(value), undefined);
  }
});

test("isPlainRecord rejects built-ins and class instances while accepting plain and null-proto objects", () => {
  class Box {}
  assert.equal(isPlainRecord({}), true);
  assert.equal(isPlainRecord(Object.create(null)), true);
  for (const value of [null, undefined, [], new Date(), new Map(), new Box(), /x/]) {
    assert.equal(isPlainRecord(value), false);
  }
});

test("hasOwn, ownEntry, and setOwnEntry handle prototype keys safely", () => {
  const target: Record<string, string> = {};
  assert.equal(hasOwn(target, "toString"), false);
  assert.equal(ownEntry(target, "toString"), undefined);
  assert.equal(ownEntry(target, "__proto__"), undefined);

  setOwnEntry(target, "__proto__", "literal-proto");
  setOwnEntry(target, "constructor", "literal-ctor");

  assert.equal(Object.getPrototypeOf(target), Object.prototype);
  assert.equal(hasOwn(target, "__proto__"), true);
  assert.equal(ownEntry(target, "__proto__"), "literal-proto");
  assert.equal(ownEntry(target, "constructor"), "literal-ctor");
  const descriptor = Object.getOwnPropertyDescriptor(target, "__proto__");
  assert.deepEqual(descriptor, {
    value: "literal-proto",
    enumerable: true,
    configurable: true,
    writable: true,
  });
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

test("requireAllowedKeys supports single and split error messages", () => {
  const allowed = new Set(["a", "b"]);
  const input = { a: 1 };
  assert.equal(requireAllowedKeys(input, allowed, "Invalid thing."), input);
  assert.equal(requireAllowedKeys(input, ["a", "b"], "Invalid thing."), input);
  assert.throws(() => requireAllowedKeys(null, allowed, "Invalid thing."), /Invalid thing\./);
  assert.throws(() => requireAllowedKeys({ c: 1 }, allowed, "Invalid thing."), /Invalid thing\./);
  assert.throws(
    () => requireAllowedKeys([], allowed, { record: "Invalid envelope.", fields: "Invalid fields." }),
    /Invalid envelope\./,
  );
  assert.throws(
    () => requireAllowedKeys({ a: 1, extra: 2 }, allowed, { record: "Invalid envelope.", fields: "Invalid fields." }),
    /Invalid fields\./,
  );

  // Lazy rejection: stops inspecting properties on the first disallowed key rather than scanning every key.
  const keys = ["a", ...Array.from({ length: 1_000 }, (_, index) => `extra-${index}`)];
  let inspected = 0;
  const hostile = new Proxy(
    {},
    {
      ownKeys: () => keys,
      getOwnPropertyDescriptor(_target, key) {
        inspected += 1;
        return typeof key === "string" ? { configurable: true, enumerable: true, value: 1 } : undefined;
      },
    },
  );
  assert.throws(() => requireAllowedKeys(hostile, allowed, "Invalid thing."), /Invalid thing\./);
  assert.ok(inspected <= (allowed.size + 1) * 2, `expected lazy stop, inspected ${inspected} keys`);
});

test("requirePlainShape rejects class instances and missing or extra keys", () => {
  const input = { a: 1, b: 2 };
  assert.equal(requirePlainShape(input, ["a"], ["b"], "Invalid shape."), input);
  assert.throws(() => requirePlainShape(new Date(), [], [], "Invalid shape."), /Invalid shape\./);
  assert.throws(() => requirePlainShape({ b: 2 }, ["a"], ["b"], "Invalid shape."), /Invalid shape\./);
  assert.throws(() => requirePlainShape({ a: 1, c: 3 }, ["a"], ["b"], "Invalid shape."), /Invalid shape\./);
});

test("boundedString counts Unicode scalars without splitting surrogate pairs", () => {
  assert.equal(boundedString("a", 1), true);
  assert.equal(boundedString("😀", 1), true);
  assert.equal(boundedString("😀😀", 1), false);
  assert.equal(boundedString("😀😀", 2), true);
  assert.equal(boundedString("", 5), false);
  assert.equal(boundedString("x", 0), false);
  assert.equal(boundedString(123, 5), false);
});

test("parseUtf8BoundedString enforces UTF-16 code units and UTF-8 bytes matching Buffer.byteLength", () => {
  assert.deepEqual(parseUtf8BoundedString(undefined, "field", 10, 10, true), { value: undefined, bytes: 0 });
  assert.throws(() => parseUtf8BoundedString(undefined, "field", 10, 10), /^Error: Invalid field\.$/);
  assert.throws(() => parseUtf8BoundedString("", "field", 10, 10), /^Error: Invalid field\.$/);

  const samples = [
    "ascii",
    "café",
    "日本語",
    "😀",
    "\ud83d", // lone high surrogate
    "\ude00", // lone low surrogate
    "\ud83dA", // high surrogate followed by non-low
  ];
  for (const sample of samples) {
    const expectedBytes = Buffer.byteLength(sample, "utf8");
    assert.deepEqual(
      parseUtf8BoundedString(sample, "field", sample.length, expectedBytes),
      { value: sample, bytes: expectedBytes },
    );
    assert.throws(
      () => parseUtf8BoundedString(sample, "field", sample.length, expectedBytes - 1),
      /^Error: Invalid field\.$/,
    );
    if (sample.length > 1) {
      assert.throws(
        () => parseUtf8BoundedString(sample, "field", sample.length - 1, expectedBytes + 10),
        /^Error: Invalid field\.$/,
      );
    }
  }
});

test("timestamp guards distinguish safe-integer and finite non-negative numbers", () => {
  assert.equal(isTimestamp(0), true);
  assert.equal(isTimestamp(1_700_000_000_000), true);
  assert.equal(isTimestamp(1.5), false);
  assert.equal(isTimestamp(-1), false);
  assert.equal(isTimestamp(Number.MAX_SAFE_INTEGER + 1), false);
  assert.equal(isTimestamp(Number.NaN), false);
  assert.equal(isTimestamp("0"), false);

  assert.equal(isFiniteTimestamp(0), true);
  assert.equal(isFiniteTimestamp(1.5), true);
  assert.equal(isFiniteTimestamp(-0.1), false);
  assert.equal(isFiniteTimestamp(Number.POSITIVE_INFINITY), false);
  assert.equal(isFiniteTimestamp(Number.NaN), false);

  assert.equal(timestampOf(42.5), 42.5);
  assert.equal(timestampOf(-1), undefined);
  assert.equal(timestampOf("42"), undefined);
});
