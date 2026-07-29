import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { shouldEnableAppUpdates } from "./app-updater-core.js";

test("auto updates require a packaged macOS app with embedded feed metadata", () => {
  assert.equal(
    shouldEnableAppUpdates({
      isPackaged: true,
      platform: "darwin",
      runtimeProfile: "production",
      updateConfigExists: true,
    }),
    true,
  );
  assert.equal(
    shouldEnableAppUpdates({
      isPackaged: false,
      platform: "darwin",
      runtimeProfile: "production",
      updateConfigExists: true,
    }),
    false,
  );
  assert.equal(
    shouldEnableAppUpdates({
      isPackaged: true,
      platform: "darwin",
      runtimeProfile: "production",
      updateConfigExists: false,
    }),
    false,
  );
  assert.equal(
    shouldEnableAppUpdates({
      isPackaged: true,
      platform: "linux",
      runtimeProfile: "production",
      updateConfigExists: true,
    }),
    false,
  );
});

test("development profiles never contact the production update feed", () => {
  assert.equal(
    shouldEnableAppUpdates({
      isPackaged: true,
      platform: "darwin",
      runtimeProfile: "development",
      updateConfigExists: true,
    }),
    false,
  );
});

test("Restart now uses Aiden's protected shutdown before launching the installer", () => {
  const main = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
  const shutdownStart = main.indexOf("async function shutdownAndQuit");
  const shutdownEnd = main.indexOf("async function refreshCloseGuardFromRenderer", shutdownStart);
  const shutdown = main.slice(shutdownStart, shutdownEnd);
  const cleanupIndex = shutdown.indexOf("cleanupApplication();");
  const settleIndex = shutdown.indexOf("scheduleService.stopAndSettle()");
  const installIndex = shutdown.indexOf("appUpdateService.installDownloadedUpdateAndRestart()");

  assert.ok(cleanupIndex >= 0);
  assert.ok(settleIndex > cleanupIndex);
  assert.ok(installIndex > settleIndex);

  const handlerStart = main.indexOf('ipcMain.handle("app:restartToUpdate"');
  const handlerEnd = main.indexOf("\n});", handlerStart);
  const handler = main.slice(handlerStart, handlerEnd);
  assert.match(handler, /setImmediate\(\(\) => void requestApplicationQuit\(window\)\)/u);
  assert.doesNotMatch(handler, /installDownloadedUpdateAndRestart/u);
});
