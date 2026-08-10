import {
  IDLE_APP_UPDATE_SNAPSHOT,
  normalizeAppUpdateVersion,
  type AppUpdateCheckResult,
  type AppUpdateSnapshot,
} from "../../renderer/shared/app-update.js";

export interface AppUpdaterEnvironment {
  isPackaged: boolean;
  platform: NodeJS.Platform;
  runtimeProfile: "production" | "development";
  updateConfigExists: boolean;
}

export interface AppUpdateDriverResult {
  isUpdateAvailable: boolean;
  version: unknown;
}

export interface AppUpdateDriver {
  checkForUpdates(): Promise<AppUpdateDriverResult | null>;
  downloadUpdate(): Promise<unknown>;
}

export interface ConfigurableAppUpdater {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowDowngrade: boolean;
  allowPrerelease: boolean;
  disableDifferentialDownload: boolean;
  fullChangelog: boolean;
}

export function configureAppUpdater(updater: ConfigurableAppUpdater): void {
  // Aiden's GitHub release flow intentionally publishes one verified ZIP and
  // no separate blockmaps. Own the full download so failures and retries are
  // observable instead of letting electron-updater start a detached promise.
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = true;
  updater.allowDowngrade = false;
  updater.allowPrerelease = false;
  updater.disableDifferentialDownload = true;
  updater.fullChangelog = false;
}

const APP_UPDATE_RETRY_DELAYS_MS = [30_000, 5 * 60_000, 30 * 60_000] as const;

export function appUpdateRetryDelay(attempt: number): number | null {
  return Number.isSafeInteger(attempt) && attempt >= 0
    ? (APP_UPDATE_RETRY_DELAYS_MS[attempt] ?? null)
    : null;
}

export class AppUpdateController {
  private operationPromise: Promise<AppUpdateCheckResult> | null = null;
  private currentSnapshot: AppUpdateSnapshot = IDLE_APP_UPDATE_SNAPSHOT;
  private readonly listeners = new Set<(snapshot: AppUpdateSnapshot) => void>();

  constructor(private readonly driver: AppUpdateDriver) {}

  snapshot(): AppUpdateSnapshot {
    return this.currentSnapshot;
  }

  subscribe(listener: (snapshot: AppUpdateSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  announceSnapshot(): void {
    for (const listener of this.listeners) {
      try {
        listener(this.currentSnapshot);
      } catch {
        // A renderer notification failure must not abort or duplicate the
        // signed download. Other listeners still receive the state change.
      }
    }
  }

  recordDownloadProgress(progress: {
    percent?: unknown;
    transferred?: unknown;
    total?: unknown;
  }): boolean {
    if (this.currentSnapshot.status !== "downloading") return false;
    const previous = this.currentSnapshot;
    const percent =
      typeof progress.percent === "number" &&
      Number.isFinite(progress.percent) &&
      progress.percent >= 0 &&
      progress.percent <= 100
        ? progress.percent
        : null;
    const transferred =
      typeof progress.transferred === "number" &&
      Number.isSafeInteger(progress.transferred) &&
      progress.transferred >= 0
        ? progress.transferred
        : null;
    const total =
      typeof progress.total === "number" &&
      Number.isSafeInteger(progress.total) &&
      progress.total > 0
        ? progress.total
        : null;
    const validBytes = transferred !== null && total !== null && transferred <= total;
    const acceptedPercent =
      percent !== null && (previous.percent === null || percent >= previous.percent)
        ? percent
        : null;
    const acceptedBytes =
      validBytes &&
      transferred !== null &&
      (previous.transferred === null || transferred >= previous.transferred);
    const nextPercent = acceptedPercent ?? previous.percent;
    const nextTransferred = acceptedBytes ? transferred : previous.transferred;
    const nextTotal = acceptedBytes ? total : previous.total;
    const madeProgress =
      (acceptedPercent !== null &&
        (previous.percent === null || acceptedPercent > previous.percent)) ||
      (acceptedBytes &&
        transferred !== null &&
        (previous.transferred === null || transferred > previous.transferred));
    if (
      nextPercent === previous.percent &&
      nextTransferred === previous.transferred &&
      nextTotal === previous.total
    ) {
      return false;
    }
    this.setSnapshot({
      ...previous,
      percent: nextPercent,
      transferred: nextTransferred,
      total: nextTotal,
    });
    return madeProgress;
  }

  checkNow(): Promise<AppUpdateCheckResult> {
    if (this.currentSnapshot.status === "ready") {
      return Promise.resolve({ outcome: "ready" });
    }
    if (this.operationPromise) return this.operationPromise;

    const operation = this.runCheck().finally(() => {
      if (this.operationPromise === operation) this.operationPromise = null;
    });
    this.operationPromise = operation;
    return operation;
  }

  private async runCheck(): Promise<AppUpdateCheckResult> {
    this.setSnapshot({ status: "checking", version: null });
    let result: AppUpdateDriverResult | null;
    try {
      result = await this.driver.checkForUpdates();
    } catch {
      this.setSnapshot({ status: "error", version: null, error: "check-failed" });
      return { outcome: "failed" };
    }

    if (!result?.isUpdateAvailable) {
      this.setSnapshot(IDLE_APP_UPDATE_SNAPSHOT);
      return { outcome: "up-to-date" };
    }

    const version = normalizeAppUpdateVersion(result.version);
    if (!version) {
      this.setSnapshot({ status: "error", version: null, error: "check-failed" });
      return { outcome: "failed" };
    }

    this.setSnapshot({
      status: "downloading",
      version,
      percent: null,
      transferred: null,
      total: null,
    });
    try {
      await this.driver.downloadUpdate();
    } catch {
      this.setSnapshot({ status: "error", version, error: "download-failed" });
      return { outcome: "failed" };
    }

    this.setSnapshot({ status: "ready", version });
    return { outcome: "ready" };
  }

  private setSnapshot(snapshot: AppUpdateSnapshot): void {
    this.currentSnapshot = snapshot;
    this.announceSnapshot();
  }
}

export function shouldEnableAppUpdates(environment: AppUpdaterEnvironment): boolean {
  return (
    environment.platform === "darwin" &&
    environment.isPackaged &&
    environment.runtimeProfile === "production" &&
    environment.updateConfigExists
  );
}
