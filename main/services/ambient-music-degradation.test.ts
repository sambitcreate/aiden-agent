import assert from "node:assert/strict";
import test from "node:test";

import { AmbientMusicDegradationMonitor } from "./ambient-music-degradation.js";

function metrics(frameMs: number, bufferAvailable: number, droppedFrames: number) {
  return {
    transformerMs: Math.max(0, frameMs - 5),
    frameMs,
    bufferAvailable,
    bufferCapacity: 10,
    droppedFrames,
  };
}

test("runtime pressure needs two samples and three healthy samples to clear", () => {
  const monitor = new AmbientMusicDegradationMonitor();
  assert.equal(monitor.observe(metrics(45, 2, 0), 1_000), undefined);
  const warning = monitor.observe(metrics(46, 2, 0), 2_000);
  assert.equal(warning?.code, "realtime_pressure");
  assert.equal(warning?.since, new Date(2_000).toISOString());
  assert.equal(warning?.bufferRatio, 0.2);
  assert.ok(monitor.observe(metrics(20, 8, 0), 3_000));
  assert.ok(monitor.observe(metrics(20, 8, 0), 4_000));
  assert.equal(monitor.observe(metrics(20, 8, 0), 5_000), undefined);
});

test("startup and newly dropped frames trigger pressure while a reset baseline preserves session history", () => {
  const monitor = new AmbientMusicDegradationMonitor();
  assert.equal(monitor.observe(metrics(20, 8, 12)), undefined);
  assert.equal(monitor.observe(metrics(20, 8, 13))?.droppedFramesSinceLastSample, 1);
  monitor.reset(99);
  assert.equal(monitor.observe(metrics(20, 8, 99)), undefined);
  assert.equal(monitor.observe(metrics(20, 8, 100)), undefined);
  assert.equal(monitor.observe(metrics(20, 8, 101))?.droppedFramesSinceLastSample, 1);
});
