// Adapted from t3code apps/desktop/src/window/DesktopWindow.test.ts @ a6ec88f7 (MIT).
import assert from "node:assert/strict";
import test from "node:test";
import { NOTIFICATION_CHANNELS } from "../../../renderer/preload-channels.js";
import { forwardTrackpadScrollEnd, TRACKPAD_SCROLL_END_CHANNEL } from "./trackpad-scroll-end.js";

function fakeWebContents() {
  const listeners = new Map<string, (event: unknown, input: { type: string }) => void>();
  const sent: string[] = [];
  let destroyed = false;
  return {
    sent,
    destroy: () => (destroyed = true),
    input: (type: string) => listeners.get("input-event")?.({}, { type }),
    webContents: {
      on(event: "input-event", listener: (event: unknown, input: { type: string }) => void) {
        listeners.set(event, listener);
      },
      send: (channel: string) => void sent.push(channel),
      isDestroyed: () => destroyed,
    },
  };
}

test("a native trackpad release reaches the renderer, and other input does not", () => {
  const window = fakeWebContents();
  forwardTrackpadScrollEnd(window.webContents);
  window.input("gestureScrollUpdate");
  window.input("mouseWheel");
  assert.deepEqual(window.sent, []);
  window.input("gestureScrollEnd");
  assert.deepEqual(window.sent, [TRACKPAD_SCROLL_END_CHANNEL]);
  // The preload bridge lets the renderer subscribe to it.
  assert.equal(NOTIFICATION_CHANNELS.has(TRACKPAD_SCROLL_END_CHANNEL), true);
  window.destroy();
  window.input("gestureScrollEnd");
  assert.equal(window.sent.length, 1, "a destroyed window is not sent to");
});
