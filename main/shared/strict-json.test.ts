import assert from "node:assert/strict";
import test from "node:test";
import {
  isValidJsonString,
  scanStrictJson,
  type StrictJsonScanOptions,
} from "./strict-json.js";

class StrictJsonTestError extends Error {
  readonly name = "StrictJsonTestError";
}

function options(overrides: Partial<StrictJsonScanOptions> = {}): StrictJsonScanOptions {
  return {
    maxDepth: 8,
    maxObjectKeys: 32,
    rejectLoneSurrogates: true,
    rejectNonFiniteNumbers: true,
    onInvalid: () => {
      throw new StrictJsonTestError("invalid json");
    },
    ...overrides,
  };
}

test("isValidJsonString accepts well-formed UTF-16 and rejects unpaired surrogates", () => {
  assert.equal(isValidJsonString(""), true);
  assert.equal(isValidJsonString("plain ascii and café"), true);
  assert.equal(isValidJsonString("😀\ud83d\ude80"), true);

  assert.equal(isValidJsonString("\ud800"), false);
  assert.equal(isValidJsonString("\udc00"), false);
  assert.equal(isValidJsonString("prefix-\udbff"), false);
  assert.equal(isValidJsonString("\ud800x"), false);
  assert.equal(isValidJsonString("\udc00\ud800"), false);
});

test("scanStrictJson accepts RFC 8259 values, escapes, whitespace, and distinct sibling keys", () => {
  const validDocuments = [
    ' \t\r\n { "emptyObj": {}, "emptyArr": [], "bools": [true, false, null] } \r\n ',
    '{"numbers":[0,-0,42,-42,3.14159,-0.25,1e10,2.5E-4,-9e+3]}',
    '{"escapes":"\\"\\\\\\/\\b\\f\\n\\r\\t\\u0041\\ud83d\\ude00"}',
    '{"sameKeyInChildren":{"id":1,"nested":{"id":2}},"sibling":{"id":3}}',
    '{"__proto__":1,"constructor":2,"hasOwnProperty":3}',
  ];

  for (const doc of validDocuments) {
    scanStrictJson(doc, options());
    assert.ok(JSON.parse(doc) !== undefined);
  }
});

test("scanStrictJson rejects literal and escaped duplicate object keys at every depth", () => {
  const duplicates = [
    '{"a":1,"a":2}',
    '{"a":1,"\\u0061":2}',
    '{"\\u0061":1,"a":2}',
    '{"\\/":1,"/":2}',
    '{"😀":1,"\\ud83d\\ude00":2}',
    '{"outer":[{"nested":{"key":true,"k\\u0065y":false}}]}',
    '{"__proto__":1,"__proto__":2}',
  ];

  for (const doc of duplicates) {
    assert.throws(() => scanStrictJson(doc, options()), StrictJsonTestError, doc);
    assert.throws(
      () => scanStrictJson(doc, options({ rejectLoneSurrogates: false })),
      StrictJsonTestError,
      doc,
    );
  }
});

test("scanStrictJson enforces maxDepth and cumulative maxObjectKeys boundaries", () => {
  scanStrictJson('{"a":{"b":[1]}}', options({ maxDepth: 3 }));
  assert.throws(
    () => scanStrictJson('{"a":{"b":[1]}}', options({ maxDepth: 2 })),
    StrictJsonTestError,
  );

  scanStrictJson('[{"a":1,"b":2},{"c":3,"d":4}]', options({ maxObjectKeys: 4 }));
  assert.throws(
    () => scanStrictJson('[{"a":1,"b":2},{"c":3,"d":4}]', options({ maxObjectKeys: 3 })),
    StrictJsonTestError,
  );
});

test("rejectLoneSurrogates controls lone-surrogate rejection in both keys and string values", () => {
  const loneSurrogateCases = [
    '{"value":"\\ud800"}',
    '{"value":"\\udc00"}',
    '{"value":"\ud800"}',
    '{"\\ud800":1}',
    '{"\\ud800\\u0041":"ok"}',
  ];

  for (const doc of loneSurrogateCases) {
    assert.throws(
      () => scanStrictJson(doc, options({ rejectLoneSurrogates: true })),
      StrictJsonTestError,
      doc,
    );
    scanStrictJson(doc, options({ rejectLoneSurrogates: false }));
  }

  // Escaped lone-surrogate duplicate keys still collide when lone surrogates are permitted.
  assert.throws(
    () => scanStrictJson('{"\\ud800":1,"\\uD800":2}', options({ rejectLoneSurrogates: false })),
    StrictJsonTestError,
  );

  // Invalid escape syntax in non-decoded string values still fails when rejectLoneSurrogates is false.
  for (const malformed of ['{"v":"\\x41"}', '{"v":"\\u123g"}', '{"v":"unterminated\\"}', '{"v":"raw\nnewline"}']) {
    assert.throws(
      () => scanStrictJson(malformed, options({ rejectLoneSurrogates: false })),
      StrictJsonTestError,
      malformed,
    );
  }
});

test("rejectNonFiniteNumbers toggles IEEE-754 overflow rejection while always rejecting non-JSON tokens", () => {
  for (const overflow of ["1e400", "-1e400", '{"count":1e309}']) {
    assert.throws(
      () => scanStrictJson(overflow, options({ rejectNonFiniteNumbers: true })),
      StrictJsonTestError,
      overflow,
    );
    scanStrictJson(overflow, options({ rejectNonFiniteNumbers: false }));
  }

  for (const nonJsonNumber of ["Infinity", "-Infinity", "NaN", "+1", "01", "-01", ".5", "1.", "1e", "1e+", "-"]) {
    assert.throws(
      () => scanStrictJson(nonJsonNumber, options({ rejectNonFiniteNumbers: false })),
      StrictJsonTestError,
      nonJsonNumber,
    );
  }
});

test("scanStrictJson rejects malformed structure and propagates custom onInvalid errors", () => {
  class CustomCallerError extends Error {}
  const custom = options({
    onInvalid: () => {
      throw new CustomCallerError("caller-defined failure");
    },
  });

  const malformed = [
    "",
    "   ",
    '{"a":1,}',
    "[1,]",
    '{"a" 1}',
    "{a:1}",
    '{"a":1} trailing',
    "undefined",
    "'single-quoted'",
    "\u0000",
  ];

  for (const doc of malformed) {
    assert.throws(() => scanStrictJson(doc, custom), CustomCallerError, doc);
  }
});
