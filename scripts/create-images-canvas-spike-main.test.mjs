import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { inspectElectronConsoleMessage } = require("./fixtures/electron-console-message.cjs");

test("canvas gate rejects legacy numeric console error severity without relying on message text", () => {
  assert.deepEqual(inspectElectronConsoleMessage([{}, 3, "boom"]), {
    message: "boom",
    isError: true,
  });
  assert.equal(inspectElectronConsoleMessage([{}, 2, "ordinary warning"]).isError, false);
});

test("canvas gate rejects structured console errors and CSP violations", () => {
  assert.equal(
    inspectElectronConsoleMessage([{ level: "error", message: "boom" }]).isError,
    true,
  );
  assert.equal(
    inspectElectronConsoleMessage([{ level: "warning", message: "Refused to connect" }]).isError,
    true,
  );
  assert.equal(
    inspectElectronConsoleMessage([{}, { level: "error", message: "service worker error" }])
      .isError,
    true,
  );
});
