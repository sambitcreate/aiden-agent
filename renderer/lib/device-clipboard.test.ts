import assert from "node:assert/strict";
import test from "node:test";
import { isDevicePasteShortcut, pasteHostClipboardToDevice } from "./device-clipboard.js";

const TARGET = { platform: "ios" as const, hostId: "local", deviceId: "ABCD-1234" };

test("Cmd+V on the device pastes once the pasteboard is set, holding Cmd in its own frame around V", async () => {
  const events: string[] = [];
  const result = await pasteHostClipboardToDevice({
    target: TARGET,
    copy: async (target) => {
      events.push(`copy:${target.deviceId}`);
      return { bytes: 5 };
    },
    sendKey: (code, phase) => events.push(`${code}:${phase}`),
    wait: async (ms) => {
      assert.ok(ms > 0);
      events.push("pause");
    },
  });
  assert.deepEqual(result, { bytes: 5 });
  // Sent in one burst, iOS on a real simulator sometimes saw V before Cmd and typed "v".
  assert.deepEqual(events, [
    "copy:ABCD-1234",
    "MetaLeft:down",
    "pause",
    "KeyV:down",
    "pause",
    "KeyV:up",
    "pause",
    "MetaLeft:up",
  ]);
});

test("no keys are sent when the clipboard was refused or input is disconnected", async () => {
  const keys: string[] = [];
  await assert.rejects(
    pasteHostClipboardToDevice({
      target: TARGET,
      copy: async () => {
        throw new Error("Only text can be pasted to the simulator.");
      },
      sendKey: (code) => keys.push(code),
    }),
    /Only text/u,
  );
  await assert.rejects(
    pasteHostClipboardToDevice({ target: TARGET, copy: async () => ({ bytes: 1 }), sendKey: null }),
    /not accepting input/u,
  );
  assert.deepEqual(keys, []);
});

test("only a plain Cmd+V is the paste shortcut", () => {
  const base = { code: "KeyV", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false };
  assert.equal(isDevicePasteShortcut(base), true);
  assert.equal(isDevicePasteShortcut({ ...base, shiftKey: true }), false);
  assert.equal(isDevicePasteShortcut({ ...base, metaKey: false, ctrlKey: true }), false);
  assert.equal(isDevicePasteShortcut({ ...base, code: "KeyC" }), false);
});

test("an emulator paste is typed by main, so no Cmd+V follows, but it still needs live input", async () => {
  const android = { platform: "android" as const, hostId: "local", deviceId: "emulator-5554" };
  const events: string[] = [];
  const result = await pasteHostClipboardToDevice({
    target: android,
    copy: async (target) => {
      events.push(`copy:${target.deviceId}`);
      return { bytes: 700 };
    },
    sendKey: (code, phase) => events.push(`${code}:${phase}`),
  });
  assert.deepEqual(result, { bytes: 700 });
  assert.deepEqual(events, ["copy:emulator-5554"]);
  await assert.rejects(
    pasteHostClipboardToDevice({ target: android, copy: async () => ({ bytes: 1 }), sendKey: null }),
    /emulator is not accepting input/u,
  );
});
