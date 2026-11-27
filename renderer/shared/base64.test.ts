import assert from "node:assert/strict";
import test from "node:test";
import { base64Value, decodedBase64Bytes } from "./base64.js";

test("base64Value maps standard base64 alphabet and rejects everything else", () => {
  assert.equal(base64Value("A".charCodeAt(0)), 0);
  assert.equal(base64Value("Z".charCodeAt(0)), 25);
  assert.equal(base64Value("a".charCodeAt(0)), 26);
  assert.equal(base64Value("z".charCodeAt(0)), 51);
  assert.equal(base64Value("0".charCodeAt(0)), 52);
  assert.equal(base64Value("9".charCodeAt(0)), 61);
  assert.equal(base64Value("+".charCodeAt(0)), 62);
  assert.equal(base64Value("/".charCodeAt(0)), 63);
  assert.equal(base64Value("=".charCodeAt(0)), undefined);
  assert.equal(base64Value("-".charCodeAt(0)), undefined);
  assert.equal(base64Value("_".charCodeAt(0)), undefined);
  assert.equal(base64Value(" ".charCodeAt(0)), undefined);
});

test("decodedBase64Bytes validates canonical base64 length, padding, trailing bits, and maxChars", () => {
  assert.equal(decodedBase64Bytes("AA=="), 1);
  assert.equal(decodedBase64Bytes("AAA="), 2);
  assert.equal(decodedBase64Bytes("AAAA"), 3);
  assert.equal(decodedBase64Bytes(Buffer.from("hello world").toString("base64")), 11);

  assert.equal(decodedBase64Bytes("AAAA", 4), 3);
  assert.equal(decodedBase64Bytes("AAAA", 3), undefined);

  for (const invalid of ["", "AAA", "====", "A===", "AB==", "AAB=", "AA=A", "AA_=", "AA-="]) {
    assert.equal(decodedBase64Bytes(invalid), undefined, `expected ${JSON.stringify(invalid)} to fail`);
  }
});
