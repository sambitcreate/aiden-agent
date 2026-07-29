import { existsSync } from "node:fs";
import path from "node:path";
import electronUpdater from "electron-updater";

import { app, dialog, logger } from "../platform.js";
import {
  IDLE_APP_UPDATE_SNAPSHOT,
  normalizeAppUpdateVersion,
  type AppUpdateSnapshot,
} from "../../renderer/shared/app-update.js";
import { isPackagedRuntime } from "../runtime-mode.js";
import { currentRuntimeProfile } from "../runtime-profile.js";
import { shouldEnableAppUpdates } from "./app-updater-core.js";

const INITIAL_CHECK_DELAY_MS = 15_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1_000;
const { autoUpdater } = electronUpdater;

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

export class AppUpdateService {
  private initialTimer: NodeJS.Timeout | null = null;
  private intervalTimer: NodeJS.Timeout | null = null;
  private checkPromise: Promise<void> | null = null;
  private downloadedVersion: string | null = null;
  private readonly stateListeners = new Set<(snapshot: AppUpdateSnapshot) => void>();
  private started = false;

  snapshot(): AppUpdateSnapshot {
    return this.downloadedVersion
      ? {
          status: "ready",
          version: this.downloadedVersion,
        }
      : IDLE_APP_UPDATE_SNAPSHOT;
  }

  subscribe(listener: (snapshot: AppUpdateSnapshot) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  announceSnapshot(): void {
    const snapshot = this.snapshot();
    for (const listener of this.stateListeners) listener(snapshot);
  }

  canInstallDownloadedUpdate(): boolean {
    return this.downloadedVersion !== null;
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
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowDowngrade = false;
    autoUpdater.allowPrerelease = false;
    autoUpdater.fullChangelog = false;
    autoUpdater.on("update-downloaded", ({ version }) => {
      const normalizedVersion = normalizeAppUpdateVersion(version);
      if (!normalizedVersion) {
        logger.warn("updater", "Downloaded update did not report a safe version string.");
        return;
      }
      this.downloadedVersion = normalizedVersion;
      logger.info("updater", "Update downloaded and will install after Aiden exits", {
        version: normalizedVersion,
      });
      this.announceSnapshot();
    });

    this.initialTimer = setTimeout(() => void this.checkNow(false), INITIAL_CHECK_DELAY_MS);
    this.initialTimer.unref();
    this.intervalTimer = setInterval(() => void this.checkNow(false), CHECK_INTERVAL_MS);
    this.intervalTimer.unref();
  }

  async checkNow(manual: boolean): Promise<void> {
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
      return;
    }
    if (!this.started) this.start();
    if (this.checkPromise) return this.checkPromise;

    this.checkPromise = (async () => {
      try {
        const result = await autoUpdater.checkForUpdatesAndNotify({
          title: "Aiden Agent update ready",
          body: "Restart Aiden Agent to finish installing version {{version}}.",
        });
        if (!manual) return;
        if (result?.isUpdateAvailable) {
          await dialog.showMessageBox({
            type: "info",
            title: "Downloading update",
            message: `Aiden Agent ${result.updateInfo.version} is downloading in the background.`,
            detail:
              "Aiden will install it after you quit normally. Your open work will not be interrupted.",
            buttons: ["OK"],
            defaultId: 0,
            noLink: true,
          });
        } else {
          await dialog.showMessageBox({
            type: "info",
            title: "Aiden Agent is up to date",
            message: `You’re using the latest version (${app.getVersion()}).`,
            buttons: ["OK"],
            defaultId: 0,
            noLink: true,
          });
        }
      } catch (error) {
        logger.warn("updater", "Update check failed", error);
        if (manual) {
          await dialog.showMessageBox({
            type: "warning",
            title: "Couldn’t check for updates",
            message: "Aiden Agent couldn’t reach its update feed.",
            detail: "Check your internet connection and try again.",
            buttons: ["OK"],
            defaultId: 0,
            noLink: true,
          });
        }
      } finally {
        this.checkPromise = null;
      }
    })();
    return this.checkPromise;
  }

  dispose(): void {
    if (this.initialTimer) clearTimeout(this.initialTimer);
    if (this.intervalTimer) clearInterval(this.intervalTimer);
    this.initialTimer = null;
    this.intervalTimer = null;
  }
}

export const appUpdateService = new AppUpdateService();
