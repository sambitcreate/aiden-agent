// Owns the Create Images stores for one app session. Electron-free; main.ts
// supplies the userData root, the studio asset store, the Pi port and IPC.
import type { ImageGenerationPort } from "../../../renderer/shared/images/port.js";
import type { RunSnapshot } from "../../../renderer/shared/images/run-types.js";
import type { StudioAssetStore } from "../studio-assets/store.js";
import { ImageRunCoordinator } from "./run-coordinator.js";
import { ImageRunLedger } from "./run-ledger.js";
import { ImageWorkflowStore } from "./workflow-store.js";

export type CreateImagesAssets = Pick<
  StudioAssetStore,
  "status" | "get" | "read" | "put" | "retain" | "releaseAllForHolder" | "replaceHolder"
>;

export interface CreateImagesServices {
  workflows: ImageWorkflowStore;
  coordinator: ImageRunCoordinator;
  port: ImageGenerationPort;
  assets: CreateImagesAssets;
}

export interface CreateImagesRuntimeOptions {
  root: () => string;
  assets: CreateImagesAssets;
  port: () => ImageGenerationPort;
  notify(snapshot: RunSnapshot): void;
  /** Non-fatal failures from the workflow store and the run coordinator. */
  reportIssue?(message: string, error: unknown): void;
  now?: () => number;
  retainRuns?: number;
}

export class CreateImagesRuntime {
  private current: CreateImagesServices | null = null;
  private opening: Promise<boolean> | null = null;

  constructor(private readonly options: CreateImagesRuntimeOptions) {}

  /** Disabled means no directory, ledger or port. A failure is reported and the app still starts. */
  async initialize(input: { enabled: boolean; onError(error: unknown): void }): Promise<boolean> {
    if (!input.enabled) return false;
    if (this.current) return true;
    // One open at a time: the restart sweep must run exactly once, before any run can start.
    this.opening ??= this.open(input.onError).finally(() => {
      this.opening = null;
    });
    return this.opening;
  }

  private async open(onError: (error: unknown) => void): Promise<boolean> {
    let ledger: ImageRunLedger | undefined;
    try {
      if (this.options.assets.status() !== "open") throw new Error("Studio assets are unavailable.");
      const root = this.options.root();
      const now = this.options.now ? { now: this.options.now } : {};
      const reportIssue = this.options.reportIssue ? { reportIssue: this.options.reportIssue } : {};
      const workflows = new ImageWorkflowStore({ root: () => root, assets: this.options.assets, ...now, ...reportIssue });
      await workflows.initialize();
      ledger = ImageRunLedger.open({ directory: root, ...now });
      const port = this.options.port();
      const coordinator = new ImageRunCoordinator({
        ledger,
        port,
        assets: this.options.assets,
        workflows,
        notify: this.options.notify,
        ...now,
        ...reportIssue,
        ...(this.options.retainRuns !== undefined ? { retainRuns: this.options.retainRuns } : {}),
      });
      coordinator.recoverAfterRestart();
      this.current = { workflows, coordinator, port, assets: this.options.assets };
      return true;
    } catch (error) {
      ledger?.close();
      onError(error);
      return false;
    }
  }

  services(): CreateImagesServices {
    if (!this.current) throw new Error("Create Images storage is unavailable. Restart Aiden to try again.");
    return this.current;
  }

  inFlightRequests(): number {
    return this.current?.coordinator.inFlightRequests() ?? 0;
  }

  async shutdown(reason = "app-quit"): Promise<void> {
    const current = this.current;
    this.current = null;
    await current?.coordinator.shutdown(reason);
  }
}
