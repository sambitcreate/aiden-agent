import { existsSync } from "node:fs";
import path from "node:path";
import electronUpdater, {
  type CancellationToken as UpdaterCancellationToken,
} from "electron-updater";

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
  appUpdateRetryDelay,
  configureAppUpdater,
  shouldEnableAppUpdates,
} from "./app-updater-core.js";

const INITIAL_CHECK_DELAY_MS = 15_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1_000;
const DOWNLOAD_STALL_TIMEOUT_MS = 2 * 60 * 1_000;
const { autoUpdater, CancellationToken } = electronUpdater;

function updaterEnabled(): boolean {
  return shouldEnableAppUpdates({
    isPackaged: isPackagedRuntime(),
    platform: process.platform,
    runtimeProfile: currentRuntimeProfile().id,
    updateConfigExists: existsSync(path.join(process.resourcesPath, "app-update.yml")),
  });
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
  private readonly controller = new AppUpdateController({
    checkForUpdates: async () => {
      try {
        const result = await autoUpdater.checkForUpdates();
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
    return this.snapshot().status === "ready";
  }

  installDownloadedUpdateAndRestart(): boolean {
    if (!this.canInstallDownloadedUpdate()) return false;
    try {
      autoUpdater.autoRunAppAfterInstall = true;
      autoUpdater.quitAndInstall(false, true);
      return true;
    } catch (error) {
      logger.error("updater", "Could not launch the downloaded update installer", error);
      return false;
    }
  }

  start(): void {
    if (this.started || !updaterEnabled()) return;
    this.started = true;
    autoUpdater.logger = updaterLogger();
    configureAppUpdater(autoUpdater);
    autoUpdater.on("download-progress", this.downloadProgressHandler);
    autoUpdater.on("update-downloaded", this.updateDownloadedHandler);

    this.initialTimer = setTimeout(() => void this.checkNow(false), INITIAL_CHECK_DELAY_MS);
    this.initialTimer.unref();
    this.intervalTimer = setInterval(() => void this.checkNow(false), CHECK_INTERVAL_MS);
    this.intervalTimer.unref();
  }

  async checkNow(manual: boolean): Promise<AppUpdateCheckResult> {
    if (!updaterEnabled()) {
      if (manual) {
        await dialog.showMessageBox({
          type: "info",
          title: "Updates unavailable in this build",
          message: "Automatic updates are available in signed Aiden Agent distribution builds.",
          buttons: ["OK"],
          defaultId: 0,
          noLink: true,
        });
      }
      return { outcome: "unavailable" };
    }
    if (!this.started) this.start();
    if (this.checkPromise) return this.checkPromise;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;

    this.checkPromise = (async () => {
      const result = await this.controller.checkNow();
      if (result.outcome !== "failed" && result.outcome !== "unavailable") {
        this.retryAttempt = 0;
      }
      if (manual) {
        try {
          await this.showManualResult(result);
        } catch (error) {
          logger.warn("updater", "Could not show manual update result", safeUpdaterError(error));
        }
      }
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
        detail: "Use Update and restart in Aiden, or quit normally to finish installing.",
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
    const cancellation = new CancellationToken();
    this.activeDownloadCancellation = cancellation;
    this.armDownloadStallWatchdog();
    try {
      return await autoUpdater.downloadUpdate(cancellation);
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
    if (this.initialTimer) clearTimeout(this.initialTimer);
    if (this.intervalTimer) clearInterval(this.intervalTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.initialTimer = null;
    this.intervalTimer = null;
    this.retryTimer = null;
    this.clearDownloadStallWatchdog();
    this.activeDownloadCancellation?.cancel();
    this.activeDownloadCancellation = null;
    if (this.started) {
      autoUpdater.off("download-progress", this.downloadProgressHandler);
      autoUpdater.off("update-downloaded", this.updateDownloadedHandler);
    }
    this.started = false;
  }
}

export const appUpdateService = new AppUpdateService();
