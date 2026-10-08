import assert from "node:assert/strict";
import test from "node:test";
import { DEVICE_CLIPBOARD_MAX_BYTES } from "../../../renderer/shared/device-features.js";
import type { DevicePlatform } from "../../../renderer/shared/devices.js";
import {
  deviceClipboardReadCommand,
  deviceClipboardWriteCommand,
  deviceEraseCommands,
  deviceRecordVideoCommand,
  eraseDevice,
  readDeviceClipboard,
  writeDeviceClipboard,
  type DeviceErasePhase,
} from "./device-actions.js";
import type { DeviceCommandOptions, DeviceCommandResult } from "./device-host.js";

const UDID = "5C1E4B7A-0000-4000-8000-000000000001";

function fakeRun(results: Record<string, Partial<DeviceCommandResult>> = {}) {
  const calls: Array<{ command: string; args: readonly string[]; options?: DeviceCommandOptions }> = [];
  const run = async (command: string, args: readonly string[], options?: DeviceCommandOptions) => {
    calls.push({ command, args, ...(options ? { options } : {}) });
    const verb = args[1] ?? "";
    return { stdout: "", stderr: "", code: 0, ...results[verb] };
  };
  return { run, calls, verbs: () => calls.map((call) => call.args[1]) };
}

test("every feature command is a single xcrun simctl argv with the UDID in place", () => {
  const erase = deviceEraseCommands("ios", UDID);
  assert.deepEqual(erase.shutdown, { command: "xcrun", args: ["simctl", "shutdown", UDID] });
  assert.deepEqual(erase.erase, { command: "xcrun", args: ["simctl", "erase", UDID] });
  // Clipboard text travels on stdin, never as an argument a shell could see.
  assert.deepEqual(deviceClipboardWriteCommand("ios", UDID, "$(rm -rf ~) 'x'"), {
    command: "xcrun",
    args: ["simctl", "pbcopy", UDID],
    options: { stdin: "$(rm -rf ~) 'x'" },
  });
  assert.deepEqual(deviceClipboardReadCommand("ios", UDID), { command: "xcrun", args: ["simctl", "pbpaste", UDID] });
  assert.deepEqual(deviceRecordVideoCommand("ios", UDID, "/tmp/r/abc.mp4"), {
    command: "xcrun",
    args: ["simctl", "io", UDID, "recordVideo", "--codec=h264", "--force", "/tmp/r/abc.mp4"],
  });
});

test("a platform without an implementation is refused before anything runs", async () => {
  const android = "android" as unknown as DevicePlatform;
  assert.throws(() => deviceEraseCommands(android, UDID), /not available for this device/u);
  assert.throws(() => deviceRecordVideoCommand(android, UDID, "/tmp/x.mp4"), /not available/u);
  const { run, calls } = fakeRun();
  await assert.rejects(eraseDevice(run, { platform: android, deviceId: UDID, booted: true }), /not available/u);
  await assert.rejects(writeDeviceClipboard(run, { platform: android, deviceId: UDID }, "hi"), /not available/u);
  assert.equal(calls.length, 0);
});

test("erasing a booted simulator shuts it down first, then erases, reporting each phase", async () => {
  const { run, verbs } = fakeRun();
  const phases: DeviceErasePhase[] = [];
  assert.deepEqual(await eraseDevice(run, { platform: "ios", deviceId: UDID, booted: true }, (phase) => phases.push(phase)), {
    wasBooted: true,
  });
  assert.deepEqual(verbs(), ["shutdown", "erase"]);
  assert.deepEqual(phases, ["shutting-down", "erasing", "erased"]);
});

test("erasing a simulator that is already off skips the shutdown", async () => {
  const { run, verbs } = fakeRun();
  const phases: DeviceErasePhase[] = [];
  await eraseDevice(run, { platform: "ios", deviceId: UDID, booted: false }, (phase) => phases.push(phase));
  assert.deepEqual(verbs(), ["erase"]);
  assert.deepEqual(phases, ["erasing", "erased"]);
});

test("a shutdown that lost a race to another shutdown still erases", async () => {
  const { run, verbs } = fakeRun({
    shutdown: { code: 149, stderr: "Unable to shutdown device in current state: Shutdown" },
  });
  await eraseDevice(run, { platform: "ios", deviceId: UDID, booted: true });
  assert.deepEqual(verbs(), ["shutdown", "erase"]);
});

test("a failed shutdown never erases, and a failed erase reports simctl's reason", async () => {
  const stuck = fakeRun({ shutdown: { code: 1, stderr: "boom\nDevice is busy" } });
  const phases: DeviceErasePhase[] = [];
  await assert.rejects(
    eraseDevice(stuck.run, { platform: "ios", deviceId: UDID, booted: true }, (phase) => phases.push(phase)),
    /did not shut down, so it was not erased: Device is busy/u,
  );
  assert.deepEqual(stuck.verbs(), ["shutdown"]);
  assert.deepEqual(phases, ["shutting-down"]);

  const failing = fakeRun({ erase: { code: 1, stderr: "Invalid device state" } });
  await assert.rejects(
    eraseDevice(failing.run, { platform: "ios", deviceId: UDID, booted: false }),
    /could not be erased: Invalid device state/u,
  );
});

test("paste refuses empty, non-text, and oversized text before running simctl", async () => {
  const { run, calls } = fakeRun();
  const target = { platform: "ios" as const, deviceId: UDID };
  await assert.rejects(writeDeviceClipboard(run, target, ""), /no text/u);
  await assert.rejects(writeDeviceClipboard(run, target, { image: true }), /Only text/u);
  await assert.rejects(writeDeviceClipboard(run, target, "x".repeat(DEVICE_CLIPBOARD_MAX_BYTES + 1)), /64 KB/u);
  assert.equal(calls.length, 0);

  assert.deepEqual(await writeDeviceClipboard(run, target, "héllo"), { bytes: 6 });
  assert.equal(calls[0]!.options?.stdin, "héllo");
});

test("copy returns the simulator's text and refuses an empty or oversized pasteboard", async () => {
  const target = { platform: "ios" as const, deviceId: UDID };
  assert.deepEqual(await readDeviceClipboard(fakeRun({ pbpaste: { stdout: "hello\n" } }).run, target), {
    text: "hello\n",
    bytes: 6,
  });
  await assert.rejects(readDeviceClipboard(fakeRun().run, target), /has no text/u);
  await assert.rejects(
    readDeviceClipboard(fakeRun({ pbpaste: { stdout: "y".repeat(DEVICE_CLIPBOARD_MAX_BYTES + 1) } }).run, target),
    /larger than 64 KB/u,
  );
  await assert.rejects(
    readDeviceClipboard(fakeRun({ pbpaste: { code: 1, stderr: "No such device" } }).run, target),
    /could not be read: No such device/u,
  );
});
