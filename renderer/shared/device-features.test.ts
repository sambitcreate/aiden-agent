import assert from "node:assert/strict";
import test from "node:test";
import {
  DEVICE_CLIPBOARD_MAX_BYTES,
  checkDeviceClipboardText,
  deviceCaptureFileName,
  deviceFeatureCapabilities,
  parseDeviceFeatureTarget,
  parseDeviceRecordingInfo,
  parseDeviceRecordingList,
  parseDeviceSaveResult,
} from "./device-features.js";

const UDID = "5C1E4B7A-0000-4000-8000-000000000001";

test("Android emulators are feature targets by serial or AVD name", () => {
  for (const deviceId of ["emulator-5554", "Pixel_9_API_36", "Pixel_9.API-36"]) {
    assert.deepEqual(parseDeviceFeatureTarget({ platform: "android", hostId: "local", deviceId }), {
      platform: "android",
      hostId: "local",
      deviceId,
    });
  }
  // A leading dash or dot could read as an adb or emulator flag, or a hidden path.
  for (const deviceId of ["-wipe-data", ".avd", "emulator 5554", "a/b", ""]) {
    assert.equal(parseDeviceFeatureTarget({ platform: "android", hostId: "local", deviceId }), null, deviceId);
  }
});

test("each device offers only the controls that work for it", () => {
  const iosHere = deviceFeatureCapabilities("ios", { local: true });
  const androidHere = deviceFeatureCapabilities("android", { local: true });
  const androidElsewhere = deviceFeatureCapabilities("android", { local: false });

  // The hub carries the overlay, the event log, multi-touch, and screenshots for every device.
  for (const capabilities of [iosHere, androidHere, androidElsewhere]) {
    assert.equal(capabilities.axOverlay && capabilities.eventLog && capabilities.multiTouch, true);
    assert.equal(capabilities.screenshotSave, true);
  }
  // Clipboard, erase, and recording run simctl or adb, so only devices on this Mac get them.
  assert.equal(androidHere.erase && androidHere.recording && androidHere.clipboardPaste, true);
  assert.equal(androidElsewhere.erase || androidElsewhere.recording || androidElsewhere.clipboardPaste, false);
  // adb cannot read an emulator's clipboard; the control says why instead of failing.
  assert.equal(iosHere.clipboardCopy.available, true);
  assert.equal(androidHere.clipboardCopy.available, false);
  assert.match(androidHere.clipboardCopy.available ? "" : androidHere.clipboardCopy.reason, /adb/u);
  // screenrecord's 180-second segment caps emulator recordings at three minutes.
  assert.equal(androidHere.recordingMaxMs, 3 * 60_000);
  assert.equal(iosHere.recordingMaxMs, 10 * 60_000);
});

test("feature targets need a known platform, a host, and a simulator id", () => {
  assert.deepEqual(parseDeviceFeatureTarget({ platform: "ios", hostId: "local", deviceId: UDID, extra: 1 }), {
    platform: "ios",
    hostId: "local",
    deviceId: UDID,
  });
  assert.equal(parseDeviceFeatureTarget({ hostId: "local", deviceId: UDID }), null, "platform is required");
  assert.equal(parseDeviceFeatureTarget({ platform: "windows", hostId: "local", deviceId: UDID }), null);
  assert.equal(parseDeviceFeatureTarget({ platform: "ios", hostId: "local", deviceId: "../../etc" }), null);
  assert.equal(parseDeviceFeatureTarget({ platform: "ios", hostId: "a b", deviceId: UDID }), null);
  assert.equal(parseDeviceFeatureTarget(null), null);
});

test("clipboard text is capped at 64 KB of UTF-8, and only non-empty text passes", () => {
  const fits = "a".repeat(DEVICE_CLIPBOARD_MAX_BYTES);
  assert.deepEqual(checkDeviceClipboardText(fits), { ok: true, text: fits, bytes: DEVICE_CLIPBOARD_MAX_BYTES });
  const over = checkDeviceClipboardText(`${fits}a`);
  assert.equal(over.ok, false);
  // Multi-byte characters count by their encoded size, not their string length.
  const emoji = "😀".repeat(DEVICE_CLIPBOARD_MAX_BYTES / 4 + 1);
  assert.ok(emoji.length < DEVICE_CLIPBOARD_MAX_BYTES);
  assert.equal(checkDeviceClipboardText(emoji).ok, false);
  assert.deepEqual(checkDeviceClipboardText("héllo"), { ok: true, text: "héllo", bytes: 6 });
  assert.equal(checkDeviceClipboardText("").ok, false);
  assert.equal(checkDeviceClipboardText(new Uint8Array([1, 2])).ok, false);
  assert.equal(checkDeviceClipboardText(undefined).ok, false);
});

test("capture file names keep the device name readable and safe, with a local timestamp", () => {
  const at = new Date(2026, 9, 8, 14, 5, 9);
  assert.equal(deviceCaptureFileName("iPhone 17 Pro", at, "png"), "iPhone-17-Pro-2026-10-08-140509.png");
  assert.equal(deviceCaptureFileName("../../iPad: Air/(M4)", at, "mp4"), "iPad-Air-M4-2026-10-08-140509.mp4");
  assert.equal(deviceCaptureFileName("///", at, "mp4"), "Simulator-2026-10-08-140509.mp4");
  assert.ok(!deviceCaptureFileName("a/b\\c", at, "png").includes("/"));
});

test("recording info and save results are parsed fail-closed", () => {
  const info = {
    id: "rec_ABCDEFGH12",
    chatId: "chat-1",
    platform: "ios",
    hostId: "local",
    deviceId: UDID,
    status: "ready",
    startedAt: 1,
    endsBy: 600_001,
    stoppedAt: 2,
    reason: "max-duration",
  };
  assert.deepEqual(parseDeviceRecordingInfo({ ...info, file: "/tmp/secret.mp4" }), info, "the temp path is dropped");
  assert.equal(parseDeviceRecordingInfo({ ...info, status: "uploading" }), null);
  assert.equal(parseDeviceRecordingInfo({ ...info, id: "x" }), null);
  assert.equal(parseDeviceRecordingInfo({ ...info, reason: "crash" }), null);
  assert.deepEqual(parseDeviceRecordingList([info]), [info]);
  assert.equal(parseDeviceRecordingList([info, { ...info, startedAt: "now" }]), null);

  assert.deepEqual(parseDeviceSaveResult({ status: "saved", path: "/Users/me/Downloads/a.png" }), {
    status: "saved",
    path: "/Users/me/Downloads/a.png",
  });
  assert.deepEqual(parseDeviceSaveResult({ status: "cancelled", path: "/x" }), { status: "cancelled" });
  assert.equal(parseDeviceSaveResult({ status: "saved", path: "relative.png" }), null);
});
