import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  AppUpdateController,
  AppUpdateInstallHandoff,
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

test("Linux install handoff reports swallowed installer failure so protected shutdown can quit", () => {
  const handoff = new AppUpdateInstallHandoff();
  let quitScheduled = false;
  const upstreamQuitAndInstall = (install: () => boolean): void => {
    // Model BaseUpdater: install catches doInstall errors, while quitAndInstall
    // returns void and schedules quit only when install actually returned true.
    const installed = handoff.recordInstall(() => {
      try { return install(); } catch { return false; }
    });
    if (installed) quitScheduled = true;
  };
  for (const install of [() => false, () => { throw new Error("checksum changed"); }, () => { throw new Error("disk failure"); }, () => { throw new Error("inode changed"); }]) {
    assert.equal(handoff.run(() => upstreamQuitAndInstall(install)), false);
    assert.equal(quitScheduled, false);
  }
  assert.equal(handoff.run(() => upstreamQuitAndInstall(() => true)), true);
  assert.equal(quitScheduled, true);
  // A duplicate or early-return call must not reuse a previous success.
  assert.equal(handoff.run(() => {}), false);
});

test("disposed controller cannot start a download from a late feed response", async () => {
  const check = deferred<{ isUpdateAvailable: boolean; version: unknown }>();
  let downloads = 0;
  const controller = new AppUpdateController({
    checkForUpdates: () => check.promise,
    downloadUpdate: async () => {
      downloads += 1;
    },
  });
  const received: string[] = [];
  controller.subscribe(({ status }) => received.push(status));
  const operation = controller.checkNow();
  controller.dispose();
  check.resolve({ isUpdateAvailable: true, version: "0.28.32" });
  assert.deepEqual(await operation, { outcome: "unavailable" });
  assert.deepEqual(await controller.checkNow(), { outcome: "unavailable" });
  assert.equal(downloads, 0);
  assert.deepEqual(received, ["checking"]);
});

for (const completion of ["success", "failure"] as const) {
  test(`disposed controller ignores late download ${completion} and progress`, async () => {
    const download = deferred<unknown>();
    const controller = new AppUpdateController({
      checkForUpdates: async () => ({ isUpdateAvailable: true, version: "0.28.32" }),
      downloadUpdate: () => download.promise,
    });
    const operation = controller.checkNow();
    await Promise.resolve();
    assert.equal(controller.snapshot().status, "downloading");
    controller.dispose();
    const snapshot = controller.snapshot();
    const received: string[] = [];
    controller.subscribe(({ status }) => received.push(status));
    assert.equal(controller.recordDownloadProgress({ percent: 99 }), false);
    if (completion === "success") download.resolve([]);
    else download.reject(new Error("cancelled"));
    assert.deepEqual(await operation, { outcome: "unavailable" });
    assert.deepEqual(controller.snapshot(), snapshot);
    assert.deepEqual(received, []);
  });
}

test("disposing an already-ready controller preserves the protected restart handoff", async () => {
  const controller = new AppUpdateController({
    checkForUpdates: async () => ({ isUpdateAvailable: true, version: "0.28.32" }),
    downloadUpdate: async () => [],
  });
  await controller.checkNow();
  controller.dispose();
  assert.deepEqual(controller.snapshot(), { status: "ready", version: "0.28.32" });
  assert.deepEqual(await controller.checkNow(), { outcome: "unavailable" });
});

// Execute the real service with an in-memory SDK and platform. No Electron,
// network, installed application, or user-data directory is involved.
async function simulatedService() {
  const { build } = await import("esbuild");
  const { EventEmitter } = await import("node:events");
  const nodePath = await import("node:path");
  const check = deferred<{ isUpdateAvailable: boolean; updateInfo: { version: string } }>();
  const download = deferred<unknown>();
  let downloads = 0;
  let cancellations = 0;
  let installs = 0;
  const dialogs: unknown[] = [];
  const updater = Object.assign(new EventEmitter(), {
    checkForUpdates: () => check.promise,
    downloadUpdate: () => {
      downloads += 1;
      return download.promise;
    },
    quitAndInstall: () => {
      installs += 1;
    },
  });
  class CancellationToken {
    cancel() {
      cancellations += 1;
    }
  }
  const mocks: Record<string, unknown> = {
    "electron-updater": {
      autoUpdater: updater,
      CancellationToken,
      AppImageUpdater: class AppImageUpdater {},
    },
    "../platform.js": {
      app: { getVersion: () => "0.28.31" },
      dialog: {
        showMessageBox: async (options: unknown) => {
          dialogs.push(options);
        },
      },
      logger: { debug() {}, error() {}, info() {}, warn() {} },
    },
    "../runtime-mode.js": { isPackagedRuntime: () => true },
    "../runtime-profile.js": { currentRuntimeProfile: () => ({ id: "production" }) },
    "node:fs": { existsSync: () => true },
    "node:path": nodePath,
    "node:crypto": await import("node:crypto"),
  };
  const bundle = await build({
    entryPoints: [new URL("./app-updater.ts", import.meta.url).pathname],
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    external: Object.keys(mocks),
  });
  const module = { exports: {} as typeof import("./app-updater.js") };
  const run = new Function("require", "module", "exports", "process", bundle.outputFiles[0]!.text);
  run(
    (name: string) => {
      assert.ok(name in mocks, `unexpected dependency: ${name}`);
      return mocks[name];
    },
    module,
    module.exports,
    { platform: "darwin", resourcesPath: "/simulated-resources" },
  );
  return {
    service: new module.exports.AppUpdateService(),
    check,
    download,
    updater,
    dialogs,
    downloads: () => downloads,
    cancellations: () => cancellations,
    installs: () => installs,
  };
}

async function flushUpdater() {
  for (let step = 0; step < 12; step += 1) await Promise.resolve();
}

test("service disposal prevents late feed downloads, manual dialogs, and restarts", async () => {
  const fixture = await simulatedService();
  try {
    const operation = fixture.service.checkNow(true);
    fixture.service.dispose();
    fixture.check.resolve({ isUpdateAvailable: true, updateInfo: { version: "0.28.32" } });
    await flushUpdater();
    assert.equal(fixture.downloads(), 0, "shutdown must not launch a new download");
    assert.deepEqual(await operation, { outcome: "unavailable" });
    fixture.service.start();
    assert.deepEqual(await fixture.service.checkNow(true), { outcome: "unavailable" });
    assert.equal(fixture.updater.listenerCount("download-progress"), 0);
    assert.deepEqual(fixture.dialogs, []);
  } finally {
    fixture.download.resolve([]);
    fixture.service.dispose();
  }
});

for (const completion of ["success", "failure"] as const) {
  test(`service disposal suppresses late download ${completion}`, async () => {
    const fixture = await simulatedService();
    try {
      const operation = fixture.service.checkNow(true);
      fixture.check.resolve({ isUpdateAvailable: true, updateInfo: { version: "0.28.32" } });
      await flushUpdater();
      assert.equal(fixture.downloads(), 1);
      fixture.service.dispose();
      assert.equal(fixture.cancellations(), 1);
      fixture.updater.emit("download-progress", { percent: 100 });
      if (completion === "success") fixture.download.resolve([]);
      else fixture.download.reject(new Error("cancelled"));
      assert.deepEqual(await operation, { outcome: "unavailable" });
      assert.equal(fixture.service.canInstallDownloadedUpdate(), false);
      assert.deepEqual(fixture.dialogs, []);
    } finally {
      fixture.service.dispose();
    }
  });
}

test("service preserves a completed installer across shutdown cleanup", async () => {
  const fixture = await simulatedService();
  try {
    const operation = fixture.service.checkNow(false);
    fixture.check.resolve({ isUpdateAvailable: true, updateInfo: { version: "0.28.32" } });
    fixture.download.resolve([]);
    assert.deepEqual(await operation, { outcome: "ready" });
    fixture.service.dispose();
    assert.equal(fixture.service.installDownloadedUpdateAndRestart(), true);
    assert.equal(fixture.installs(), 1);
  } finally {
    fixture.service.dispose();
  }
});

for (const boundary of ["checking", "downloading"] as const) {
  test(`disposal from a ${boundary} subscriber prevents starting the next SDK operation`, async () => {
    let checks = 0;
    let downloads = 0;
    const controller = new AppUpdateController({
      checkForUpdates: async () => {
        checks += 1;
        return { isUpdateAvailable: true, version: "0.28.32" };
      },
      downloadUpdate: async () => {
        downloads += 1;
      },
    });
    controller.subscribe(({ status }) => {
      if (status === boundary) controller.dispose();
    });
    assert.deepEqual(await controller.checkNow(), { outcome: "unavailable" });
    assert.equal(checks, boundary === "checking" ? 0 : 1);
    assert.equal(downloads, 0);
  });
}

test("service disposal ignores a late feed error without a manual failure dialog", async () => {
  const fixture = await simulatedService();
  try {
    const operation = fixture.service.checkNow(true);
    fixture.service.dispose();
    fixture.check.reject(new Error("offline"));
    assert.deepEqual(await operation, { outcome: "unavailable" });
    assert.equal(fixture.downloads(), 0);
    assert.deepEqual(fixture.dialogs, []);
  } finally {
    fixture.service.dispose();
  }
});
