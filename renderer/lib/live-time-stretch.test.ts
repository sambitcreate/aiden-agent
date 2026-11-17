import assert from "node:assert/strict";
import test from "node:test";
import { LiveTimeStretcher } from "./live-time-stretch.js";

const RATE = 24_000;

function tone(frequency: number, seconds: number, amplitude = 0.5): Float32Array {
  return Float32Array.from({ length: Math.round(RATE * seconds) }, (_, n) => amplitude * Math.sin((2 * Math.PI * frequency * n) / RATE));
}

/** Streams `input` through the stretcher in Live-sized chunks, then drains it. */
function stretch(input: Float32Array, speed: number, chunk = 1_920): Float32Array {
  const stretcher = new LiveTimeStretcher();
  stretcher.setSpeed(speed);
  const parts: number[] = [];
  for (let offset = 0; offset < input.length; offset += chunk) {
    parts.push(...stretcher.process(input.subarray(offset, offset + chunk)));
  }
  parts.push(...stretcher.drain());
  return Float32Array.from(parts);
}

/** Frequency from rising zero crossings in the steady middle of a signal. */
function measuredFrequency(signal: Float32Array): number {
  const from = Math.floor(signal.length * 0.2);
  const to = Math.floor(signal.length * 0.8);
  const crossings: number[] = [];
  for (let n = from + 1; n < to; n += 1) {
    if (signal[n - 1]! < 0 && signal[n]! >= 0) crossings.push(n);
  }
  assert.ok(crossings.length > 10, "the signal still oscillates");
  return ((crossings.length - 1) * RATE) / (crossings[crossings.length - 1]! - crossings[0]!);
}

test("1× passes audio through untouched", () => {
  const input = tone(330, 0.25);
  const output = stretch(input, 1);
  assert.deepEqual(output, input);
});

test("faster and slower speeds change the length by the speed", () => {
  const input = tone(220, 2);
  for (const speed of [0.75, 1.25, 1.5, 2]) {
    const output = stretch(input, speed);
    const expected = input.length / speed;
    assert.ok(
      Math.abs(output.length - expected) / expected < 0.03,
      `${speed}×: ${output.length} samples, expected about ${Math.round(expected)}`,
    );
  }
});

test("a pure tone keeps its pitch at every offered speed", () => {
  for (const frequency of [180, 440]) {
    const input = tone(frequency, 1.5);
    for (const speed of [0.75, 1.25, 1.5, 2]) {
      const measured = measuredFrequency(stretch(input, speed));
      assert.ok(
        Math.abs(measured - frequency) / frequency < 0.03,
        `${frequency} Hz at ${speed}× came out at ${measured.toFixed(1)} Hz`,
      );
    }
  }
});

test("a stretched tone keeps its level and has no clicks at frame or chunk joins", () => {
  const output = stretch(tone(200, 1.5, 0.5), 1.5, 1_000);
  const steady = output.subarray(Math.floor(output.length * 0.1), Math.floor(output.length * 0.9));
  let peak = 0;
  let largestStep = 0;
  for (let n = 1; n < steady.length; n += 1) {
    peak = Math.max(peak, Math.abs(steady[n]!));
    largestStep = Math.max(largestStep, Math.abs(steady[n]! - steady[n - 1]!));
  }
  assert.ok(peak > 0.4 && peak < 0.6, `peak ${peak}`);
  // A 200 Hz sine at 0.5 moves at most 0.026 per sample; a click jumps far more.
  assert.ok(largestStep < 0.06, `largest step ${largestStep}`);
});

test("reset drops held-back audio so a barge-in leaves nothing queued", () => {
  const stretcher = new LiveTimeStretcher();
  stretcher.setSpeed(1.5);
  stretcher.process(tone(220, 0.1));
  assert.equal(stretcher.pending, true);
  stretcher.reset();
  assert.equal(stretcher.pending, false);
  assert.equal(stretcher.drain().length, 0);
});

test("returning to 1× mid-reply first releases what was held back, then passes through", () => {
  const stretcher = new LiveTimeStretcher();
  stretcher.setSpeed(2);
  const first = stretcher.process(tone(220, 0.2));
  stretcher.setSpeed(1);
  const next = tone(220, 0.1);
  const released = stretcher.process(next);
  assert.ok(released.length > next.length, "held audio comes out with the new chunk");
  assert.equal(stretcher.pending, false);
  assert.deepEqual(stretcher.process(next), next);
  assert.ok(first.length > 0);
});

test("speeds that are not positive numbers are refused", () => {
  const stretcher = new LiveTimeStretcher();
  for (const speed of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => stretcher.setSpeed(speed));
  }
});
