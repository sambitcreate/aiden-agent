import assert from "node:assert/strict";
import test from "node:test";
import { asString, pcmToFloat32 } from "./voice-codec.js";

test("asString returns the string when non-empty", () => {
  assert.equal(asString("hello", "x"), "hello");
  assert.equal(asString("0", "x"), "0"); // "0" is non-empty
});

test("asString rejects empty and non-string input but preserves whitespace-only strings", () => {
  assert.throws(() => asString("", "name"), /Expected non-empty string for "name"/);
  assert.throws(() => asString(123, "name"), /Expected non-empty string for "name"/);
  assert.throws(() => asString(null, "name"), /Expected non-empty string for "name"/);
  assert.throws(() => asString(undefined, "name"), /Expected non-empty string for "name"/);
  // Note: the validation is "length === 0", so whitespace-only IS accepted.
  assert.equal(asString("   ", "x"), "   ");
});

test("pcmToFloat32 decodes little-endian Float32 samples in order", () => {
  // Build a buffer of three Float32 values: 1.0, -0.5, 0.25
  const source = new Float32Array([1.0, -0.5, 0.25]);
  const buf = Buffer.alloc(source.length * 4);
  for (let i = 0; i < source.length; i++) buf.writeFloatLE(source[i], i * 4);
  const decoded = pcmToFloat32(buf.toString("base64"));
  assert.ok(decoded instanceof Float32Array);
  assert.equal(decoded.length, 3);
  assert.deepEqual(Array.from(decoded), [1.0, -0.5, 0.25]);
});

test("pcmToFloat32 returns an empty array for empty input", () => {
  const decoded = pcmToFloat32("");
  assert.equal(decoded.length, 0);
});

test("pcmToFloat32 truncates a trailing partial sample (length not multiple of 4)", () => {
  const source = new Float32Array([0.5, 0.75]);
  const buf = Buffer.alloc(source.length * 4 + 2); // 2 trailing junk bytes
  for (let i = 0; i < source.length; i++) buf.writeFloatLE(source[i], i * 4);
  buf.writeUInt16LE(0xffff, source.length * 4);
  const decoded = pcmToFloat32(buf.toString("base64"));
  assert.equal(decoded.length, 2); // floor(10 / 4) = 2, partial dropped
  assert.deepEqual(Array.from(decoded), [0.5, 0.75]);
});

test("pcmToFloat32 preserves Float32 precision (including denormal-ish values)", () => {
  const source = new Float32Array([1e-38, 1.5e-39]);
  const buf = Buffer.alloc(source.length * 4);
  for (let i = 0; i < source.length; i++) buf.writeFloatLE(source[i], i * 4);
  const decoded = pcmToFloat32(buf.toString("base64"));
  assert.deepEqual(Array.from(decoded), Array.from(source));
});
