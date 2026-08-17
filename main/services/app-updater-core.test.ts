import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  AppUpdateController,
  appUpdateRetryDelay,
  configureAppUpdater,
  shouldEnableAppUpdates,
  type AppUpdateDriver,
} from "./app-updater-core.js";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

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

test("updater configuration owns full-package downloads and observes their promise", () => {
  const updater = {
    autoDownload: true,
    autoInstallOnAppQuit: false,
    allowDowngrade: true,
    allowPrerelease: true,
    disableDifferentialDownload: false,
    fullChangelog: true,
  };

  configureAppUpdater(updater);

  assert.deepEqual(updater, {
    autoDownload: false,
    autoInstallOnAppQuit: true,
    allowDowngrade: false,
    allowPrerelease: false,
    disableDifferentialDownload: true,
    fullChangelog: false,
  });
});

test("automatic retries use a bounded backoff", () => {
  assert.equal(appUpdateRetryDelay(0), 30_000);
  assert.equal(appUpdateRetryDelay(1), 5 * 60_000);
  assert.equal(appUpdateRetryDelay(2), 30 * 60_000);
  assert.equal(appUpdateRetryDelay(3), null);
  assert.equal(appUpdateRetryDelay(-1), null);
  assert.equal(appUpdateRetryDelay(0.5), null);
});

test("update lifecycle reports check, progress, and readiness only after download completion", async () => {
  const download = deferred<unknown>();
  const driver: AppUpdateDriver = {
    checkForUpdates: async () => ({ isUpdateAvailable: true, version: "0.28.32" }),
    downloadUpdate: async () => download.promise,
  };
  const controller = new AppUpdateController(driver);
  const snapshots = [controller.snapshot()];
  controller.subscribe((snapshot) => snapshots.push(snapshot));

  const operation = controller.checkNow();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(controller.snapshot().status, "downloading");

  assert.equal(
    controller.recordDownloadProgress({
      percent: 38.5,
      transferred: 77_000_000,
      total: 200_000_000,
    }),
    true,
  );
  assert.equal(
    controller.recordDownloadProgress({
      percent: Number.NaN,
      transferred: 77_000_000,
      total: 200_000_000,
    }),
    false,
    "invalid or repeated events must not keep the stall watchdog alive",
  );
  assert.deepEqual(controller.snapshot(), {
    status: "downloading",
    version: "0.28.32",
    percent: 38.5,
    transferred: 77_000_000,
    total: 200_000_000,
  });

  download.resolve([]);
  assert.deepEqual(await operation, { outcome: "ready" });
  assert.deepEqual(controller.snapshot(), { status: "ready", version: "0.28.32" });
  assert.deepEqual(
    snapshots.map(({ status }) => status),
    ["idle", "checking", "downloading", "downloading", "ready"],
  );
});

test("one broken subscriber cannot interrupt update delivery", async () => {
  const controller = new AppUpdateController({
    checkForUpdates: async () => ({ isUpdateAvailable: true, version: "0.28.32" }),
    downloadUpdate: async () => [],
  });
  const received: string[] = [];
  controller.subscribe(() => {
    throw new Error("renderer disappeared");
  });
  controller.subscribe(({ status }) => received.push(status));

  assert.deepEqual(await controller.checkNow(), { outcome: "ready" });
  assert.deepEqual(received, ["checking", "downloading", "ready"]);
});

test("download progress cannot regress or erase the last valid measurement", async () => {
  const download = deferred<unknown>();
  const controller = new AppUpdateController({
    checkForUpdates: async () => ({ isUpdateAvailable: true, version: "0.28.32" }),
    downloadUpdate: async () => download.promise,
  });
  const operation = controller.checkNow();
  await Promise.resolve();
  await Promise.resolve();

  controller.recordDownloadProgress({
    percent: 38.5,
    transferred: 77_000_000,
    total: 200_000_000,
  });
  controller.recordDownloadProgress({ percent: 20, transferred: 40_000_000, total: 200_000_000 });
  controller.recordDownloadProgress({ percent: Infinity, transferred: -1, total: 0 });

  assert.deepEqual(controller.snapshot(), {
    status: "downloading",
    version: "0.28.32",
    percent: 38.5,
    transferred: 77_000_000,
    total: 200_000_000,
  });
  download.resolve([]);
  await operation;
});

test("download failures stay visible and a retry can recover", async () => {
  let attempt = 0;
  const driver: AppUpdateDriver = {
    checkForUpdates: async () => ({ isUpdateAvailable: true, version: "0.28.32" }),
    downloadUpdate: async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("socket closed with a signed URL");
      return [];
    },
  };
  const controller = new AppUpdateController(driver);

  assert.deepEqual(await controller.checkNow(), { outcome: "failed" });
  assert.deepEqual(controller.snapshot(), {
    status: "error",
    version: "0.28.32",
    error: "download-failed",
  });
  controller.recordDownloadProgress({ percent: 75, transferred: 75, total: 100 });
  assert.equal(controller.snapshot().status, "error", "late progress must not erase the error");

  assert.deepEqual(await controller.checkNow(), { outcome: "ready" });
  assert.deepEqual(controller.snapshot(), { status: "ready", version: "0.28.32" });
});

test("check failures and hostile versions fail closed without starting a download", async () => {
  let downloads = 0;
  const drivers: AppUpdateDriver[] = [
    {
      checkForUpdates: async () => {
        throw new Error("offline");
      },
      downloadUpdate: async () => {
        downloads += 1;
      },
    },
    {
      checkForUpdates: async () => ({
        isUpdateAvailable: true,
        version: "0.28.32\nRestart now",
      }),
      downloadUpdate: async () => {
        downloads += 1;
      },
    },
  ];

  for (const driver of drivers) {
    const controller = new AppUpdateController(driver);
    assert.deepEqual(await controller.checkNow(), { outcome: "failed" });
    assert.deepEqual(controller.snapshot(), {
      status: "error",
      version: null,
      error: "check-failed",
    });
  }
  assert.equal(downloads, 0);
});

test("concurrent checks coalesce and ready updates cannot be downloaded twice", async () => {
  const check = deferred<{ isUpdateAvailable: boolean; version: unknown }>();
  let checks = 0;
  let downloads = 0;
  const controller = new AppUpdateController({
    checkForUpdates: async () => {
      checks += 1;
      return check.promise;
    },
    downloadUpdate: async () => {
      downloads += 1;
      return [];
    },
  });

  const first = controller.checkNow();
  const second = controller.checkNow();
  assert.equal(first, second);
  check.resolve({ isUpdateAvailable: true, version: "0.28.32" });
  assert.deepEqual(await first, { outcome: "ready" });
  assert.deepEqual(await controller.checkNow(), { outcome: "ready" });
  assert.equal(checks, 1);
  assert.equal(downloads, 1);
});

test("no available update returns to idle", async () => {
  const controller = new AppUpdateController({
    checkForUpdates: async () => ({ isUpdateAvailable: false, version: "0.28.0" }),
    downloadUpdate: async () => {
      assert.fail("download must not start when the app is current");
    },
  });

  assert.deepEqual(await controller.checkNow(), { outcome: "up-to-date" });
  assert.deepEqual(controller.snapshot(), { status: "idle", version: null });
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

test("production updater awaits downloads and exposes a sender-scoped retry entry point", () => {
  const service = readFileSync(new URL("./app-updater.ts", import.meta.url), "utf8");
  const main = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
  const handlerStart = main.indexOf('"app:checkForUpdates"');
  const handlerEnd = main.indexOf("\n);", handlerStart);
  assert.ok(handlerStart >= 0);
  assert.ok(handlerEnd > handlerStart);
  const handler = main.slice(handlerStart, handlerEnd);

  assert.doesNotMatch(service, /checkForUpdatesAndNotify/u);
  assert.match(service, /await autoUpdater\.downloadUpdate\(cancellation\)/u);
  assert.match(service, /DOWNLOAD_STALL_TIMEOUT_MS/u);
  assert.match(service, /appUpdateRetryDelay\(this\.retryAttempt\)/u);
  assert.match(handler, /event\.sender\.id !== mainWindow\.webContents\.id/u);
  assert.match(handler, /appUpdateService\.checkNow\(false\)/u);
});
