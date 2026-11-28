import {
  appImageIdentity,
  canUpdateLinuxAppImage,
  replaceAppImageAtomically,
  type AppImageIdentity,
} from "./app-updater-linux.js";
import {
  canUpdateLinuxPackage,
  installLinuxPackageUpdate,
  type LinuxPackageInstallOutcome,
  type LinuxPackageKind,
} from "./app-updater-linux-package.js";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { AppUpdater, CancellationToken as UpdaterCancellationToken } from "electron-updater";

import { app, dialog, logger } from "../platform.js";
import {
  normalizeAppUpdateVersion,
  type AppUpdateCheckResult,
  type AppUpdateSnapshot,
} from "../../renderer/shared/app-update.js";
import { isPackagedRuntime } from "../runtime-mode.js";
import { currentRuntimeProfile } from "../runtime-profile.js";
import {
  AppUpdateController,
  AppUpdateInstallHandoff,
  appUpdateRetryDelay,
  configureAppUpdater,
  shouldEnableAppUpdates,
} from "./app-updater-core.js";

const INITIAL_CHECK_DELAY_MS = 15_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1_000;
const DOWNLOAD_STALL_TIMEOUT_MS = 2 * 60 * 1_000;
type ElectronUpdaterModule = typeof import("electron-updater");
type GuardedAppImageUpdater = InstanceType<ReturnType<typeof defineGuardedAppImageUpdater>>;
type GuardedPackageUpdater = InstanceType<ReturnType<typeof defineGuardedPackageUpdater>>;

// electron-updater is loaded on first use, not at module evaluation: it is
// only reachable from start() (after the main window) or a user update action,
// so it stays off the startup path. It is CommonJS, so a synchronous require
// keeps the install handoff synchronous.
let loadedUpdaterModule: ElectronUpdaterModule | null = null;
function electronUpdaterModule(): ElectronUpdaterModule {
  loadedUpdaterModule ??= createRequire(import.meta.url)(
    "electron-updater",
  ) as ElectronUpdaterModule;
  return loadedUpdaterModule;
}

function defineGuardedAppImageUpdater({ AppImageUpdater }: ElectronUpdaterModule) {
  return class GuardedAppImageUpdater extends AppImageUpdater {
    private originalImage: AppImageIdentity | undefined;
    private readonly installHandoff = new AppUpdateInstallHandoff();

    override install(isSilent = false, isForceRunAfter = false): boolean {
      return this.installHandoff.recordInstall(() => super.install(isSilent, isForceRunAfter));
    }

    quitAndInstallWithResult(): boolean {
      return this.installHandoff.run(() => this.quitAndInstall(false, true));
    }

    pinCurrentImage(): void {
      this.originalImage = appImageIdentity(process.env.APPIMAGE!);
    }

    protected override doInstall(options: { isForceRunAfter: boolean }): boolean {
      if (!this.originalImage || !this.installerPath) return false;
      const sha512 = this.downloadedUpdateHelper?.downloadedFileInfo?.sha512;
      if (!sha512) return false;
      const destination = replaceAppImageAtomically({
        current: this.originalImage,
        installer: this.installerPath,
        sha512,
        eligible: () => process.env.APPIMAGE === this.originalImage?.path && supportsAppUpdates(),
      });
      // Upstream download/checksum behavior is retained; replace without shell tools
      // and preserve the current filename. A normal quit needs no helper execution.
      if (options.isForceRunAfter)
        void this.spawnLog(destination, [], { ...process.env, APPIMAGE_SILENT_INSTALL: "true" });
      return true;
    }
  };
}

/**
 * DEB and RPM installs check and download through electron-updater (which
 * verifies the feed's SHA-512), but never install through it: its Linux
 * install builds a shell command line for sudo. Aiden installs the package
 * itself with installLinuxPackageUpdate, only when the person chooses
 * Update and restart, never on an ordinary quit.
 */
function defineGuardedPackageUpdater(
  { DebUpdater, RpmUpdater }: ElectronUpdaterModule,
  kind: LinuxPackageKind,
) {
  // Both share LinuxUpdater's download path; only the file extension they pick differs.
  const Base = (kind === "deb" ? DebUpdater : RpmUpdater) as typeof DebUpdater;
  return class GuardedPackageUpdater extends Base {
    readonly packageKind = kind;

    protected override doInstall(): boolean {
      return false;
    }

    downloadedPackage(): { installer: string; sha512: string } | null {
      const installer = this.downloadedUpdateHelper?.file;
      const sha512 = this.downloadedUpdateHelper?.downloadedFileInfo?.sha512;
      return installer && sha512 ? { installer, sha512 } : null;
    }
  };
}

function linuxPackageRuntime() {
  return {
    resourcesPath: process.resourcesPath,
    executablePath: process.execPath,
    appImage: process.env.APPIMAGE,
    uid: process.getuid?.(),
  };
}

let linuxPackageEligibility: LinuxPackageKind | null | undefined;
/** The DEB or RPM install that may update itself; fixed for the life of the process. */
export function linuxPackageUpdateKind(): LinuxPackageKind | null {
  if (process.platform !== "linux") return null;
  linuxPackageEligibility ??= canUpdateLinuxPackage(linuxPackageRuntime());
  return linuxPackageEligibility;
}

let loadedAutoUpdater: AppUpdater | null = null;
let guardedAppImageUpdater: GuardedAppImageUpdater | null = null;
let guardedPackageUpdater: GuardedPackageUpdater | null = null;
function updater(): AppUpdater {
  if (loadedAutoUpdater) return loadedAutoUpdater;
  const updaterModule = electronUpdaterModule();
  const packageKind = linuxPackageUpdateKind();
  if (packageKind) {
    const GuardedUpdater = defineGuardedPackageUpdater(updaterModule, packageKind);
    guardedPackageUpdater = new GuardedUpdater();
    loadedAutoUpdater = guardedPackageUpdater;
  } else if (process.platform === "linux") {
    // Never let electron-updater select a DEB/RPM installer from package-type.
    const GuardedUpdater = defineGuardedAppImageUpdater(updaterModule);
    guardedAppImageUpdater = new GuardedUpdater();
    loadedAutoUpdater = guardedAppImageUpdater;
  } else {
    loadedAutoUpdater = updaterModule.autoUpdater;
  }
  return loadedAutoUpdater;
}

export function supportsAppUpdates(): boolean {
  return shouldEnableAppUpdates({
    isPackaged: isPackagedRuntime(),
    platform: process.platform,
    runtimeProfile: currentRuntimeProfile().id,
    updateConfigExists:
      typeof process.resourcesPath === "string" &&
      existsSync(path.join(process.resourcesPath, "app-update.yml")),
    linuxAppImageEligible:
      process.platform === "linux" &&
      canUpdateLinuxAppImage({
        appImage: process.env.APPIMAGE,
        appDir: process.env.APPDIR,
        resourcesPath: process.resourcesPath,
        executablePath: process.execPath,
        uid: process.getuid?.(),
      }),
    linuxPackageEligible: linuxPackageUpdateKind() !== null,
  });
}

/** Installing the downloaded update asks for the person's password first (Linux DEB/RPM). */
export function appUpdateInstallNeedsPassword(): boolean {
  return linuxPackageUpdateKind() !== null && process.getuid?.() !== 0 && supportsAppUpdates();
}

function updaterLogger() {
  return {
    debug: (message: unknown) => logger.debug("updater", String(message)),
    error: (message: unknown) => logger.error("updater", String(message)),
    info: (message: unknown) => logger.info("updater", String(message)),
    warn: (message: unknown) => logger.warn("updater", String(message)),
  };
}

function safeUpdaterError(error: unknown): string {
  const value = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return value.replace(/(https?:\/\/[^\s?]+)\?[^\s)]+/gu, "$1?[redacted]").slice(0, 1_000);
}

export class AppUpdateService {
  private initialTimer: NodeJS.Timeout | null = null;
  private intervalTimer: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private downloadStallTimer: NodeJS.Timeout | null = null;
  private activeDownloadCancellation: UpdaterCancellationToken | null = null;
  private retryAttempt = 0;
  private checkPromise: Promise<AppUpdateCheckResult> | null = null;
  private manualResultPending = false;
  private readonly controller = new AppUpdateController({
    checkForUpdates: async () => {
      try {
        const result = await updater().checkForUpdates();
        return result
          ? {
              isUpdateAvailable: result.isUpdateAvailable,
              version: result.updateInfo.version,
            }
          : null;
      } catch (error) {
        logger.warn("updater", "Update check failed", safeUpdaterError(error));
        throw error;
      }
    },
    downloadUpdate: async () => {
      try {
        return await this.downloadUpdateWithWatchdog();
      } catch (error) {
        logger.warn("updater", "Update download failed", safeUpdaterError(error));
        throw error;
      }
    },
  });
  private readonly downloadProgressHandler = (progress: {
    percent?: unknown;
    transferred?: unknown;
    total?: unknown;
  }) => {
    if (this.controller.recordDownloadProgress(progress)) this.armDownloadStallWatchdog();
  };
  private readonly updateDownloadedHandler = ({ version }: { version: string }) => {
    const normalizedVersion = normalizeAppUpdateVersion(version);
    logger.info(
      "updater",
      normalizedVersion
        ? `Electron downloaded update ${normalizedVersion}; waiting for installer handoff to finish.`
        : "Electron downloaded an update without a safe version string.",
    );
  };
  private started = false;
  private disposed = false;
  private packageInstall: Promise<LinuxPackageInstallOutcome> | null = null;
  private installedPackageVersion: string | null = null;

  snapshot(): AppUpdateSnapshot {
    return this.controller.snapshot();
  }

  subscribe(listener: (snapshot: AppUpdateSnapshot) => void): () => void {
    return this.controller.subscribe(listener);
  }

  announceSnapshot(): void {
    this.controller.announceSnapshot();
  }

  canInstallDownloadedUpdate(): boolean {
    return supportsAppUpdates() && this.snapshot().status === "ready";
  }

  /**
   * DEB/RPM: install the downloaded package while Aiden is still open, so a
   * closed password prompt or a failed install leaves Aiden running. Other
   * installs have nothing to prepare.
   */
  async prepareDownloadedUpdateInstall(): Promise<"ready" | "cancelled" | "failed"> {
    if (!guardedPackageUpdater) return "ready";
    const snapshot = this.snapshot();
    if (!this.canInstallDownloadedUpdate() || snapshot.status !== "ready") return "failed";
    if (this.installedPackageVersion === snapshot.version) return "ready";
    const downloaded = guardedPackageUpdater.downloadedPackage();
    if (!downloaded) return "failed";
    const packageUpdater = guardedPackageUpdater;
    this.packageInstall ??= installLinuxPackageUpdate({
      kind: packageUpdater.packageKind,
      runtime: linuxPackageRuntime(),
      installer: downloaded.installer,
      sha512: downloaded.sha512,
      version: snapshot.version,
      uid: process.getuid?.(),
      log: (message) => logger.warn("updater", message),
    }).finally(() => {
      this.packageInstall = null;
    });
    const outcome = await this.packageInstall;
    if (outcome === "installed") {
      this.installedPackageVersion = snapshot.version;
      logger.info(
        "updater",
        `Installed the Aiden Agent ${snapshot.version} ${packageUpdater.packageKind} package; restarting.`,
      );
      return "ready";
    }
    if (outcome === "cancelled")
      logger.info("updater", "The update was not installed: the password prompt was closed.");
    return outcome;
  }

  installDownloadedUpdateAndRestart(): boolean {
    if (!this.canInstallDownloadedUpdate()) return false;
    if (guardedPackageUpdater) {
      // The package manager already replaced the files; start the new version.
      const snapshot = this.snapshot();
      if (snapshot.status !== "ready" || this.installedPackageVersion !== snapshot.version)
        return false;
      app.relaunch();
      app.quit();
      return true;
    }
    try {
      const autoUpdater = updater();
      autoUpdater.autoRunAppAfterInstall = true;
      if (guardedAppImageUpdater) return guardedAppImageUpdater.quitAndInstallWithResult();
      autoUpdater.quitAndInstall(false, true);
      return true;
    } catch (error) {
      logger.error("updater", "Could not launch the downloaded update installer", error);
      return false;
    }
  }

  start(): void {
    if (this.disposed || this.started || !supportsAppUpdates()) return;
    const autoUpdater = updater();
    if (guardedAppImageUpdater) {
      try {
        guardedAppImageUpdater.pinCurrentImage();
      } catch {
        return;
      }
    }
    this.started = true;
    autoUpdater.logger = updaterLogger();
    configureAppUpdater(autoUpdater);
    // A package install needs the person's password, so it never runs on an ordinary quit.
    if (guardedPackageUpdater) autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.on("download-progress", this.downloadProgressHandler);
    autoUpdater.on("update-downloaded", this.updateDownloadedHandler);

    this.initialTimer = setTimeout(() => void this.checkNow(false), INITIAL_CHECK_DELAY_MS);
    this.initialTimer.unref();
    this.intervalTimer = setInterval(() => void this.checkNow(false), CHECK_INTERVAL_MS);
    this.intervalTimer.unref();
  }

  async checkNow(manual: boolean): Promise<AppUpdateCheckResult> {
    if (this.disposed) return { outcome: "unavailable" };
    if (!supportsAppUpdates()) {
      if (manual) {
        await dialog.showMessageBox({
          type: "info",
          title: "Updates unavailable in this build",
          message:
            process.platform === "linux"
              ? "In-app updates need the Aiden Agent .deb or .rpm package (with pkexec), or a writable Aiden Agent AppImage. Otherwise, update with your package manager."
              : "Automatic updates are available in signed Aiden Agent distribution builds.",
          buttons: ["OK"],
          defaultId: 0,
          noLink: true,
        });
      }
      return { outcome: "unavailable" };
    }
    if (!this.started) this.start();
    if (!this.started) return { outcome: "unavailable" };
    // The newer package is already installed; only a restart is left.
    if (this.installedPackageVersion) return { outcome: "ready" };
    if (this.checkPromise) {
      // A user's "Check for Updates…" joining a background check still gets
      // the result dialog once that shared check settles.
      if (manual) this.manualResultPending = true;
      return this.checkPromise;
    }
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.manualResultPending = manual;

    this.checkPromise = (async (): Promise<AppUpdateCheckResult> => {
      const result = await this.controller.checkNow();
      if (this.disposed) return { outcome: "unavailable" };
      if (result.outcome !== "failed" && result.outcome !== "unavailable") {
        this.retryAttempt = 0;
      }
      if (this.manualResultPending) {
        this.manualResultPending = false;
        try {
          await this.showManualResult(result);
        } catch (error) {
          logger.warn("updater", "Could not show manual update result", safeUpdaterError(error));
        }
      }
      if (this.disposed) return { outcome: "unavailable" };
      if (result.outcome === "failed") this.scheduleRetry();
      return result;
    })();
    try {
      return await this.checkPromise;
    } finally {
      this.checkPromise = null;
    }
  }

  private async showManualResult(result: AppUpdateCheckResult): Promise<void> {
    if (result.outcome === "up-to-date") {
      await dialog.showMessageBox({
        type: "info",
        title: "Aiden Agent is up to date",
        message: `You’re using the latest version (${app.getVersion()}).`,
        buttons: ["OK"],
        defaultId: 0,
        noLink: true,
      });
      return;
    }
    if (result.outcome === "ready") {
      const snapshot = this.snapshot();
      await dialog.showMessageBox({
        type: "info",
        title: "Update ready",
        message:
          snapshot.status === "ready"
            ? `Aiden Agent ${snapshot.version} downloaded successfully.`
            : "The Aiden Agent update downloaded successfully.",
        detail: guardedPackageUpdater
          ? "Use Update and restart in Aiden. Linux asks for your password to install it."
          : "Use Update and restart in Aiden, or quit normally to finish installing.",
        buttons: ["OK"],
        defaultId: 0,
        noLink: true,
      });
      return;
    }
    if (result.outcome === "failed") {
      const snapshot = this.snapshot();
      const downloadFailed = snapshot.status === "error" && snapshot.error === "download-failed";
      await dialog.showMessageBox({
        type: "warning",
        title: downloadFailed ? "Couldn’t download the update" : "Couldn’t check for updates",
        message: downloadFailed
          ? "Aiden Agent couldn’t finish downloading the update."
          : "Aiden Agent couldn’t reach its update feed.",
        detail: "Check your internet connection and try again from Settings → About.",
        buttons: ["OK"],
        defaultId: 0,
        noLink: true,
      });
    }
  }

  private async downloadUpdateWithWatchdog(): Promise<unknown> {
    const cancellation = new (electronUpdaterModule().CancellationToken)();
    this.activeDownloadCancellation = cancellation;
    this.armDownloadStallWatchdog();
    try {
      return await updater().downloadUpdate(cancellation);
    } finally {
      this.clearDownloadStallWatchdog();
      if (this.activeDownloadCancellation === cancellation) {
        this.activeDownloadCancellation = null;
      }
    }
  }

  private armDownloadStallWatchdog(): void {
    this.clearDownloadStallWatchdog();
    if (!this.activeDownloadCancellation) return;
    this.downloadStallTimer = setTimeout(() => {
      this.downloadStallTimer = null;
      logger.warn(
        "updater",
        `Update download made no progress for ${DOWNLOAD_STALL_TIMEOUT_MS / 1_000} seconds; retrying.`,
      );
      this.activeDownloadCancellation?.cancel();
    }, DOWNLOAD_STALL_TIMEOUT_MS);
    this.downloadStallTimer.unref();
  }

  private clearDownloadStallWatchdog(): void {
    if (this.downloadStallTimer) clearTimeout(this.downloadStallTimer);
    this.downloadStallTimer = null;
  }

  private scheduleRetry(): void {
    if (!this.started || this.retryTimer) return;
    const delay = appUpdateRetryDelay(this.retryAttempt);
    if (delay === null) return;
    this.retryAttempt += 1;
    logger.info("updater", `Scheduling update retry in ${Math.round(delay / 1_000)} seconds.`);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.checkNow(false);
    }, delay);
    this.retryTimer.unref();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.controller.dispose();
    if (this.initialTimer) clearTimeout(this.initialTimer);
    if (this.intervalTimer) clearInterval(this.intervalTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.initialTimer = null;
    this.intervalTimer = null;
    this.retryTimer = null;
    this.clearDownloadStallWatchdog();
    this.activeDownloadCancellation?.cancel();
    this.activeDownloadCancellation = null;
    if (this.started && loadedAutoUpdater) {
      const autoUpdater = loadedAutoUpdater;
      autoUpdater.off("download-progress", this.downloadProgressHandler);
      autoUpdater.off("update-downloaded", this.updateDownloadedHandler);
    }
    this.started = false;
  }
}

export const appUpdateService = new AppUpdateService();
