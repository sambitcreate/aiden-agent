import assert from "node:assert/strict";
import test from "node:test";
import { isTrustedWindowSender } from "./window-sender.js";

const url = "file:///app/build/renderer/assistant.html";

test("accepts the current window's main frame at the expected url", () => {
  assert.equal(
    isTrustedWindowSender(7, url, { webContentsId: 7, frameUrl: url, isMainFrame: true }),
    true,
  );
});

test("rejects a sender when no window is open", () => {
  assert.equal(
    isTrustedWindowSender(null, url, { webContentsId: 7, frameUrl: url, isMainFrame: true }),
    false,
  );
});

test("rejects a different webContents, a subframe, and a navigated url", () => {
  assert.equal(
    isTrustedWindowSender(7, url, { webContentsId: 8, frameUrl: url, isMainFrame: true }),
    false,
  );
  assert.equal(
    isTrustedWindowSender(7, url, { webContentsId: 7, frameUrl: url, isMainFrame: false }),
    false,
  );
  assert.equal(
    isTrustedWindowSender(7, url, {
      webContentsId: 7,
      frameUrl: "https://evil.example/",
      isMainFrame: true,
    }),
    false,
  );
});
