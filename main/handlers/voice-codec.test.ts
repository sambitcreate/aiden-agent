import assert from "node:assert/strict";
import test from "node:test";
import { asString, pcm16FromIpc } from "./voice-codec.js";

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

test("pcm16FromIpc reads ArrayBuffer and Uint8Array audio as Int16 samples", () => {
  const source = new Int16Array([-32_768, -1, 0, 1, 32_767]);
  for (const payload of [source.buffer.slice(0), new Uint8Array(source.buffer.slice(0)), Buffer.from(source.buffer)]) {
    const decoded = pcm16FromIpc(payload);
    assert.ok(decoded instanceof Int16Array);
    assert.deepEqual(Array.from(decoded), Array.from(source));
  }
});

test("pcm16FromIpc copies unaligned byte views instead of throwing", () => {
  const backing = new Uint8Array(5);
  backing.set(new Uint8Array(new Int16Array([7, -7]).buffer), 1);
  assert.deepEqual(Array.from(pcm16FromIpc(backing.subarray(1, 5))), [7, -7]);
});

test("pcm16FromIpc rejects non-binary, empty, odd-length and over-long audio", () => {
  for (const invalid of ["AAA=", [1, 2], null, new Float32Array(2), new ArrayBuffer(0)]) {
    assert.throws(() => pcm16FromIpc(invalid), /Invalid on-device audio/);
  }
  assert.throws(() => pcm16FromIpc(new ArrayBuffer(3)), /Invalid on-device audio/);
  assert.throws(() => pcm16FromIpc(new ArrayBuffer(8), 3), /too long/);
  assert.equal(pcm16FromIpc(new ArrayBuffer(6), 3).length, 3);
});
