import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import test from "node:test";

test("the onboarding reset closes the renderer before destructive cleanup and preserves unrelated local storage", async () => {
  const source = await fs.readFile(
    new URL("../index.ts", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("async function requestOnboardingReset");
  const end = source.indexOf('ipcMain.handle("app:setCloseGuard"', start);
  assert.ok(
    start >= 0 && end > start,
    "onboarding reset lifecycle is registered in main",
  );
  const reset = source.slice(start, end);

  assert.match(reset, /shutdownStarted\s*\|\|\s*installUpdateOnQuit/u);
  const authorize = reset.indexOf('authorizeProtectedAction(window, "close")');
  const clearCompletion = reset.indexOf(
    "await clearRendererOnboardingCompletion(window)",
  );
  const closeRenderer = reset.indexOf(
    "await closeRendererBeforeShutdown(window)",
  );
  const clearData = reset.indexOf("await resetOnboardingData()");
  const relaunch = reset.indexOf("app.relaunch()");
  const shutdown = reset.indexOf("await shutdownAndQuit(true)");

  assert.ok(authorize >= 0, "protected edits are checked before reset");
  assert.ok(
    clearCompletion > authorize,
    "only the onboarding completion marker is cleared after close authorization",
  );
  assert.ok(
    closeRenderer > clearCompletion,
    "renderer close begins after its completion marker is cleared",
  );
  assert.ok(
    clearData > closeRenderer,
    "persistent setup is untouched until the renderer has closed",
  );
  assert.ok(
    relaunch > clearData,
    "relaunch is armed only after destructive cleanup succeeds",
  );
  assert.ok(
    shutdown > relaunch,
    "normal service shutdown runs after relaunch is armed",
  );
  assert.doesNotMatch(
    reset,
    /clearStorageData/u,
    "unrelated renderer preferences are preserved",
  );
  assert.match(reset, /protectedAction = "onboarding-reset"/u);
  assert.match(reset, /restoreRendererOnboardingCompletion/u);
  assert.match(
    reset,
    /protectedAction = null;[\s\S]*?await createMainWindow\(\)/u,
    "a recovered window restores normal close protection",
  );
  assert.match(
    reset,
    /await createMainWindow\(\)/u,
    "a failed post-close reset reopens the app",
  );
});
