import assert from "node:assert/strict";
import test from "node:test";
import {
  MEDIA_RECORDER_TIMESLICE_MS,
  RECORDING_TAIL_FLUSH_MS,
  scheduleRecorderStopWithTail,
  startChunkedMediaRecorder,
} from "./media-recorder-stop.js";

test("chunked capture uses a timeslice so the encoder emits trailing audio", () => {
  const starts: number[] = [];
  startChunkedMediaRecorder({ start: (timeslice) => starts.push(timeslice ?? -1) });
  assert.deepEqual(starts, [MEDIA_RECORDER_TIMESLICE_MS]);
});

test("stop waits for the hangover, flushes, then stops once", () => {
  const calls: string[] = [];
  const recorder = {
    state: "recording" as string,
    requestData: () => {
      calls.push("flush");
    },
    stop: () => {
      calls.push("stop");
      recorder.state = "inactive";
    },
  };
  const timers: Array<() => void> = [];
  scheduleRecorderStopWithTail(recorder, (callback) => {
    timers.push(callback);
    return 1 as unknown as ReturnType<typeof setTimeout>;
  }, RECORDING_TAIL_FLUSH_MS);
  assert.deepEqual(calls, []);
  assert.equal(timers.length, 1);
  timers[0]?.();
  assert.deepEqual(calls, ["flush", "stop"]);
});

test("stop is a no-op when the recorder is already inactive", () => {
  let stopped = 0;
  const recorder = {
    state: "inactive",
    stop: () => {
      stopped += 1;
    },
  };
  const timers: Array<() => void> = [];
  scheduleRecorderStopWithTail(recorder, (callback) => {
    timers.push(callback);
    return 1 as unknown as ReturnType<typeof setTimeout>;
  });
  timers[0]?.();
  assert.equal(stopped, 0);
});
