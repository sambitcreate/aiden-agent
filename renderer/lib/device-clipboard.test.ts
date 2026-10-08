import assert from "node:assert/strict";
import test from "node:test";
import { isDevicePasteShortcut, pasteHostClipboardToDevice } from "./device-clipboard.js";

const TARGET = { platform: "ios" as const, hostId: "local", deviceId: "ABCD-1234" };

test("Cmd+V on the device pastes once the pasteboard is set, pressing and releasing Cmd around V", async () => {
  const events: string[] = [];
  const result = await pasteHostClipboardToDevice({
    target: TARGET,
    copy: async (target) => {
      events.push(`copy:${target.deviceId}`);
      return { bytes: 5 };
    },
    sendKey: (code, phase) => events.push(`${code}:${phase}`),
  });
  assert.deepEqual(result, { bytes: 5 });
  assert.deepEqual(events, ["copy:ABCD-1234", "MetaLeft:down", "KeyV:down", "KeyV:up", "MetaLeft:up"]);
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
