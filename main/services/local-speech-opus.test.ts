import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { decodeOggOpusToPcm16k } from "./local-speech-opus.js";

// 1 s of a 440 Hz sine (ffmpeg default amplitude 1/8) on the left channel of a
// 48 kHz stereo Ogg/Opus file; the right channel is silent.
const fixture = new URL("./fixtures/voice-note-440hz-left.ogg", import.meta.url);

function rms(samples: Float32Array, from: number, to: number): number {
  let sum = 0;
  for (let index = from; index < to; index += 1) sum += samples[index]! ** 2;
  return Math.sqrt(sum / (to - from));
}

function zeroCrossings(samples: Float32Array, from: number, to: number): number {
  let count = 0;
  for (let index = from + 1; index < to; index += 1) {
    if (samples[index - 1]! < 0 !== samples[index]! < 0) count += 1;
  }
  return count;
}

test("Ogg/Opus decodes to 16 kHz mono with channels averaged", async () => {
  const samples = await decodeOggOpusToPcm16k(new Uint8Array(await readFile(fixture)));
  // Exactly one second: the decoder drops pre-skip and the final granule trims padding.
  assert.equal(samples.length, 16_000);
  // Steady-state window away from codec warm-up at the edges.
  const from = 2_000;
  const to = 14_000;
  const seconds = (to - from) / 16_000;
  const frequency = zeroCrossings(samples, from, to) / 2 / seconds;
  assert.ok(Math.abs(frequency - 440) < 10, `frequency ${frequency}`);
  // A full-scale-1/8 sine has RMS ≈ 0.088; averaging with a silent channel halves it.
  const level = rms(samples, from, to);
  assert.ok(level > 0.035 && level < 0.055, `rms ${level}`);
});

test("a chained file decodes each stream to its exact length", async () => {
  const first = new Uint8Array(await readFile(fixture));
  // 0.5 s of 880 Hz, mono, its own stream serial.
  const second = new Uint8Array(await readFile(new URL("./fixtures/voice-note-880hz-half-second.ogg", import.meta.url)));
  const chained = new Uint8Array(first.length + second.length);
  chained.set(first);
  chained.set(second, first.length);
  const samples = await decodeOggOpusToPcm16k(chained);
  // Pre-skip and end padding are trimmed per stream, so the lengths add up exactly.
  assert.equal(samples.length, 16_000 + 8_000);
  const secondHz = zeroCrossings(samples, 18_000, 23_000) / 2 / (5_000 / 16_000);
  assert.ok(Math.abs(secondHz - 880) < 20, `second stream frequency ${secondHz}`);
});

test("bytes that are not Ogg/Opus are rejected", async () => {
  await assert.rejects(decodeOggOpusToPcm16k(new Uint8Array(4_096).fill(7)), /Ogg\/Opus/);
});
