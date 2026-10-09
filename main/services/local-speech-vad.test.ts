import { test } from "node:test";
import assert from "node:assert/strict";
import { fixedChunks, planSegments, VAD_PAD_SAMPLES } from "./local-speech-vad.js";

const SR = 16_000;
const s = (seconds: number) => Math.round(seconds * SR);

test("no speech plans nothing", () => {
  assert.deepEqual(planSegments([], s(10), 30), []);
  assert.deepEqual(planSegments([], s(10), null), []);
});

test("unwindowed models get one trimmed range with padding", () => {
  const plan = planSegments([{ start: s(2), end: s(3) }, { start: s(6), end: s(7) }], s(10), null);
  assert.deepEqual(plan, [{ start: s(2) - VAD_PAD_SAMPLES, end: s(7) + VAD_PAD_SAMPLES }]);
});

test("padding clamps to the clip", () => {
  const plan = planSegments([{ start: 100, end: s(1) }], s(1.2), null);
  assert.deepEqual(plan, [{ start: 0, end: s(1.2) }]);
});

test("close regions merge; windows never exceed 28 s", () => {
  const regions = [{ start: s(1), end: s(10) }, { start: s(10.2), end: s(20) }, { start: s(25), end: s(40) }];
  const plan = planSegments(regions, s(45), 30);
  for (const range of plan) assert.ok(range.end - range.start <= s(28), JSON.stringify(range));
  assert.ok(plan.length >= 2);
});

test("a 10-minute recording is fully covered without overlap", () => {
  const regions = Array.from({ length: 120 }, (_, i) => ({ start: s(i * 5), end: s(i * 5 + 4) }));
  const total = s(600);
  const plan = planSegments(regions, total, 30);
  assert.ok(plan.length >= 21);
  for (const range of plan) assert.ok(range.end - range.start <= s(28));
  for (let i = 1; i < plan.length; i++) assert.ok(plan[i]!.start >= plan[i - 1]!.end, "windows must not overlap");
  for (const region of regions) {
    const covering = plan.filter((r) => r.start <= region.start && r.end >= region.end);
    assert.equal(covering.length, 1, `region ${region.start} covered exactly once`);
  }
});

test("a single region longer than the window is split at the limit", () => {
  const plan = planSegments([{ start: 0, end: s(70) }], s(70), 30);
  assert.equal(plan.length, 3);
  assert.equal(plan[0]!.end - plan[0]!.start, s(28));
  assert.equal(plan[plan.length - 1]!.end, s(70));
});

test("fixedChunks covers the clip in ≤28 s pieces for windowed models", () => {
  assert.deepEqual(fixedChunks(s(60), 30).map((r) => r.end - r.start), [s(28), s(28), s(4)]);
  assert.deepEqual(fixedChunks(s(60), null), [{ start: 0, end: s(60) }]);
});

test("tiny window limits clamp to at least one second instead of looping forever", () => {
  for (const maxWindow of [2, 1, 0, -5]) {
    const plan = planSegments([{ start: 0, end: s(5) }], s(5), maxWindow);
    assert.ok(plan.length > 0 && plan.length <= 5, `${maxWindow}: ${plan.length}`);
    for (const range of plan) assert.ok(range.end - range.start <= s(1));
    assert.equal(plan[plan.length - 1]!.end, s(5));
    const chunks = fixedChunks(s(3), maxWindow);
    assert.deepEqual(chunks.map((r) => r.end - r.start), [s(1), s(1), s(1)]);
  }
});

test("overlapping and nested regions are merged so no audio is dropped", () => {
  const plan = planSegments([{ start: s(1), end: s(9) }, { start: s(2), end: s(3) }], s(10), null);
  assert.equal(plan.length, 1);
  assert.ok(plan[0]!.start <= s(1) && plan[0]!.end >= s(9), JSON.stringify(plan));
  const touching = planSegments([{ start: s(4), end: s(6) }, { start: s(1), end: s(4) }, { start: s(5), end: s(5.5) }], s(10), 30);
  const covered = touching.filter((r) => r.start <= s(1) && r.end >= s(6));
  assert.equal(covered.length, 1, JSON.stringify(touching));
});
