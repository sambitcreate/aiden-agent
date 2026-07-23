import assert from "node:assert/strict";
import test from "node:test";
import { isTrustedPillSender } from "./pill-window-security.js";

const expectedUrl = "file:///Applications/Aiden/pill.html";

test("only the current pill main document is trusted", () => {
  assert.equal(
    isTrustedPillSender(7, expectedUrl, {
      webContentsId: 7,
      frameUrl: expectedUrl,
      isMainFrame: true,
    }),
    true,
  );
  for (const actual of [
    { webContentsId: 8, frameUrl: expectedUrl, isMainFrame: true },
    { webContentsId: 7, frameUrl: "file:///Applications/Aiden/index.html", isMainFrame: true },
    { webContentsId: 7, frameUrl: expectedUrl, isMainFrame: false },
  ]) {
    assert.equal(isTrustedPillSender(7, expectedUrl, actual), false);
  }
});
