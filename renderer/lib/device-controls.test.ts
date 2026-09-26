// Adapted from t3code apps/web/src/components/device/useDeviceControls.test.tsx @ 1c127066 (MIT)
import assert from "node:assert/strict";
import test from "node:test";

import { createDeviceControls, type DeviceControlsState } from "./device-controls";
import type { DeviceActionInput, DeviceSettings } from "../shared/devices";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function harness() {
  const reads: Array<ReturnType<typeof deferred<DeviceSettings>>> = [];
  const runs: Array<{ input: DeviceActionInput; result: ReturnType<typeof deferred<DeviceSettings>> }> = [];
  const states: DeviceControlsState[] = [];
  const controls = createDeviceControls({
    target: { hostId: "local", deviceId: "UDID" },
    read: () => {
      const next = deferred<DeviceSettings>();
      reads.push(next);
      return next.promise;
    },
    run: (input) => {
      const result = deferred<DeviceSettings>();
      runs.push({ input, result });
      return result.promise;
    },
    onChange: (state) => states.push(state),
  });
  return { controls, reads, runs, states };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("actions wait for settings, run one at a time, and adopt the confirmed settings", async () => {
  const h = harness();
  assert.equal(await h.controls.act({ type: "setAppearance", value: "dark" }), false);
  h.controls.show();
  assert.equal(await h.controls.act({ type: "setAppearance", value: "dark" }), false);
  h.reads[0]!.resolve({ appearance: "light" });
  await tick();
  assert.deepEqual(h.controls.getState(), { settings: { appearance: "light" }, pending: false, error: null });

  const first = h.controls.act({ type: "setAppearance", value: "dark" });
  assert.equal(await h.controls.act({ type: "setTextSize", value: "large" }), false);
  assert.deepEqual(h.runs.map((run) => run.input), [
    { hostId: "local", deviceId: "UDID", type: "setAppearance", value: "dark" },
  ]);
  assert.equal(h.controls.getState().pending, true);
  h.runs[0]!.result.resolve({ appearance: "dark" });
  assert.equal(await first, true);
  assert.deepEqual(h.controls.getState(), { settings: { appearance: "dark" }, pending: false, error: null });
});

test("a failed action keeps the last confirmed settings and reports the error", async () => {
  const h = harness();
  h.controls.show();
  h.reads[0]!.resolve({ appearance: "light" });
  await tick();
  const action = h.controls.act({ type: "openUrl", url: "https://example.com" });
  h.runs[0]!.result.reject(new Error("The simulator could not open the link: bad scheme"));
  assert.equal(await action, false);
  assert.deepEqual(h.controls.getState(), {
    settings: { appearance: "light" },
    pending: false,
    error: "The simulator could not open the link: bad scheme",
  });
});

test("an action that settles after hide and reopen re-reads instead of trusting a stale read", async () => {
  const h = harness();
  h.controls.show();
  h.reads[0]!.resolve({ appearance: "light" });
  await tick();
  const action = h.controls.act({ type: "setAppearance", value: "dark" });
  h.controls.hide();
  h.controls.show();
  // The reopened read raced the host command and saw the old value.
  h.reads[1]!.resolve({ appearance: "light" });
  await tick();
  h.runs[0]!.result.resolve({ appearance: "dark" });
  await tick();
  assert.equal(h.reads.length, 3);
  h.reads[2]!.resolve({ appearance: "dark" });
  assert.equal(await action, true);
  assert.deepEqual(h.controls.getState().settings, { appearance: "dark" });
});

test("a read that fails leaves settings unknown so controls stay disabled", async () => {
  const h = harness();
  h.controls.show();
  h.reads[0]!.reject(new Error("Simulator is not booted"));
  await tick();
  assert.deepEqual(h.controls.getState(), { settings: null, pending: false, error: "Simulator is not booted" });
  // A read that lands after hide is ignored.
  h.controls.show();
  h.controls.hide();
  h.reads[1]!.resolve({ appearance: "dark" });
  await tick();
  assert.equal(h.controls.getState().settings, null);
});
