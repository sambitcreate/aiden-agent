import assert from "node:assert/strict";
import test from "node:test";
import { encodeMonoPcm16Wav } from "./wav-audio.js";

test("encodes supported 16 kHz mono PCM16 WAV with a correct header", () => {
  const bytes = encodeMonoPcm16Wav(Float32Array.from([-1, 0, 1]), 16_000);
  const view = new DataView(bytes.buffer);
  assert.equal(new TextDecoder().decode(bytes.subarray(0, 4)), "RIFF");
  assert.equal(new TextDecoder().decode(bytes.subarray(8, 12)), "WAVE");
  assert.equal(view.getUint16(20, true), 1);
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint32(24, true), 16_000);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(view.getUint32(40, true), 6);
  assert.deepEqual(
    [view.getInt16(44, true), view.getInt16(46, true), view.getInt16(48, true)],
    [-32768, 0, 32767],
  );
});
