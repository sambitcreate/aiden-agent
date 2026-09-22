import assert from "node:assert/strict";
import test from "node:test";
import {
  analyserRms,
  SilenceStopDetector,
  SILENCE_ARM_MS,
  SILENCE_HANGOVER_MS,
} from "./dictation-vad.js";

test("rms is zero for silence and rises for a peak", () => {
  assert.equal(analyserRms(new Uint8Array(16).fill(128)), 0);
  const peak = new Uint8Array(16).fill(128);
  peak[0] = 255;
  assert.ok(analyserRms(peak) > 0.1);
});

test("silence stop waits for speech, hangover, and the arming window", () => {
  const stops: number[] = [];
  let now = 1_000;
  const detector = new SilenceStopDetector(() => stops.push(now), () => now);
  detector.reset(now);
  detector.sample(0.2, now);
  assert.deepEqual(stops, []);
  now += SILENCE_ARM_MS;
  detector.sample(0.2, now);
  now += SILENCE_HANGOVER_MS + 10;
  detector.sample(0, now);
  assert.deepEqual(stops, [now]);
  detector.sample(0, now + 1_000);
  assert.equal(stops.length, 1);
});
