import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import test from "node:test";

test("the onboarding reset clears storage before relaunching through normal shutdown", async () => {
  const source = await fs.readFile(new URL("../index.ts", import.meta.url), "utf8");
  const start = source.indexOf("async function requestOnboardingReset");
  const end = source.indexOf('ipcMain.handle("app:setCloseGuard"', start);
  assert.ok(start >= 0 && end > start, "onboarding reset lifecycle is registered in main");
  const reset = source.slice(start, end);

  const authorize = reset.indexOf('authorizeProtectedAction(window, "close")');
  const clearData = reset.indexOf("await resetOnboardingData()");
  const clearRendererPreferences = reset.indexOf(
    'clearStorageData({ storages: ["localstorage"] })',
  );
  const closeRenderer = reset.indexOf("await closeRendererBeforeShutdown(window)");
  const relaunch = reset.indexOf("app.relaunch()");
  const shutdown = reset.indexOf("await shutdownAndQuit(true)");

  assert.ok(authorize >= 0, "protected edits are checked before reset");
  assert.ok(clearData > authorize, "persistent setup is cleared only after close authorization");
  assert.ok(
    clearRendererPreferences > clearData,
    "renderer preferences and onboarding completion are cleared after persistent setup",
  );
  assert.ok(closeRenderer > clearRendererPreferences, "renderer closes after storage is cleared");
  assert.ok(relaunch > closeRenderer, "relaunch is armed only after renderer shutdown succeeds");
  assert.ok(shutdown > relaunch, "normal service shutdown runs after relaunch is armed");
});
