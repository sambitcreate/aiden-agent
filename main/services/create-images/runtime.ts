// Owns the Create Images stores for one app session. Electron-free; main.ts
// supplies the userData root, the studio asset store, the Pi port and IPC.
import type { ImageGenerationPort } from "../../../renderer/shared/images/port.js";
import type { RunSnapshot } from "../../../renderer/shared/images/run-types.js";
import type { StudioAssetHolder, StudioAssetHolderKind } from "../studio-assets/contract.js";
import type { StudioAssetStore } from "../studio-assets/store.js";
import { CreateImagesExports, type ExportFileSystem } from "./image-export.js";
import { ImageRunCoordinator } from "./run-coordinator.js";
import { ImageRunLedger, ImageRunLedgerError } from "./run-ledger.js";
import { ImageWorkflowStore } from "./workflow-store.js";

export type CreateImagesAssets = Pick<
  StudioAssetStore,
  "status" | "get" | "read" | "put" | "retain" | "release" | "releaseAllForHolder" | "replaceHolder" | "holders" | "usage"
> & {
  /**
   * Every holder id of one kind. When the store offers it, startup reconciliation finds orphaned
   * holders whatever asset they keep; without it, only holders of assets Create Images still
   * references can be found.
   */
  holderIds?(kind: StudioAssetHolderKind): string[];
};

export interface CreateImagesServices {
  workflows: ImageWorkflowStore;
  coordinator: ImageRunCoordinator;
  port: ImageGenerationPort;
  assets: CreateImagesAssets;
  /** Auto-saved copies in the Pictures folder, and on-demand exports. */
  exports: CreateImagesExports;
}

export interface CreateImagesRuntimeOptions {
  root: () => string;
  assets: CreateImagesAssets;
  port: () => ImageGenerationPort;
  notify(snapshot: RunSnapshot): void;
  /**
   * The auto-save folder, `<Pictures>/Aiden/Create Images` in the app. Without it nothing is
   * written outside userData: tests opt in with a temporary folder.
   */
  saveRoot?: () => string;
  /** File system for exports (tests inject failures). */
  exportFs?: ExportFileSystem;
  /** Non-fatal failures from the workflow store and the run coordinator. */
  reportIssue?(message: string, error: unknown): void;
  now?: () => number;
  retainRuns?: number;
  /** After a failed open, calls within this window repeat its error instead of retrying. Default 5 s. */
  retryCooldownMs?: number;
}

const UNAVAILABLE = "Create Images storage is unavailable.";
const RETRY_COOLDOWN_MS = 5_000;

/** What a caller sees when storage could not open; `cause` keeps the underlying failure for logs. */
export class CreateImagesUnavailableError extends Error {
  readonly cause: unknown;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "CreateImagesUnavailableError";
    this.cause = options?.cause;
  }
}

function unavailable(error: unknown): CreateImagesUnavailableError {
  if (error instanceof CreateImagesUnavailableError) return error;
  if (error instanceof ImageRunLedgerError && error.code === "unsafe") {
    return new CreateImagesUnavailableError(
      "Create Images storage is unavailable because its run history file (create-images/runs-v1.sqlite) is a link, has extra hard links, or belongs to another user. Aiden won't open it. Move that file out of Aiden's data folder to start a new run history.",
      { cause: error },
    );
  }
  return new CreateImagesUnavailableError(`${UNAVAILABLE} Aiden will try again the next time you use Images.`, { cause: error });
}

export class CreateImagesRuntime {
  private current: CreateImagesServices | null = null;
  private opening: Promise<boolean> | null = null;
  private enabled = false;
  private onError: (error: unknown) => void = () => undefined;
  private failure: { error: CreateImagesUnavailableError; at: number } | null = null;

  constructor(private readonly options: CreateImagesRuntimeOptions) {}

  /** Disabled means no directory, ledger or port. A failure is reported and the app still starts. */
  async initialize(input: { enabled: boolean; onError(error: unknown): void }): Promise<boolean> {
    if (!input.enabled) return false;
    this.enabled = true;
    this.onError = input.onError;
    return this.openOnce();
  }

  /**
   * The services, opening storage again if an earlier open failed (for example the studio asset
   * store opened late). Repeated failures within the cooldown repeat the last error.
   */
  async ready(): Promise<CreateImagesServices> {
    if (this.current) return this.current;
    if (!this.enabled) throw new CreateImagesUnavailableError(UNAVAILABLE);
    const cooldown = this.options.retryCooldownMs ?? RETRY_COOLDOWN_MS;
    if (this.failure && Date.now() - this.failure.at < cooldown) throw this.failure.error;
    await this.openOnce();
    return this.services();
  }

  services(): CreateImagesServices {
    if (this.current) return this.current;
    throw this.failure?.error ?? new CreateImagesUnavailableError(UNAVAILABLE);
  }

  inFlightRequests(): number {
    return this.current?.coordinator.inFlightRequests() ?? 0;
  }

  async shutdown(reason = "app-quit"): Promise<void> {
    const current = this.current;
    this.current = null;
    this.enabled = false;
    await current?.coordinator.shutdown(reason);
  }

  private openOnce(): Promise<boolean> {
    if (this.current) return Promise.resolve(true);
    // One open at a time: the restart sweep must run exactly once, before any run can start.
    this.opening ??= this.open().finally(() => {
      this.opening = null;
    });
    return this.opening;
  }

  private async open(): Promise<boolean> {
    let ledger: ImageRunLedger | undefined;
    try {
      if (this.options.assets.status() !== "open") {
        throw new CreateImagesUnavailableError(`${UNAVAILABLE} The studio image store isn't open.`);
      }
      const root = this.options.root();
      const now = this.options.now ? { now: this.options.now } : {};
      const reportIssue = this.options.reportIssue ? { reportIssue: this.options.reportIssue } : {};
      const workflows = new ImageWorkflowStore({ root: () => root, assets: this.options.assets, ...now, ...reportIssue });
      await workflows.initialize();
      ledger = ImageRunLedger.open({
        directory: root,
        ...now,
        liveNodeIds: (workflowId) => workflows.nodeIds(workflowId),
        quarantineDamaged: (moved, error) =>
          this.options.reportIssue?.(`The image run history could not be read and was moved to ${moved}. Aiden started an empty run history.`, error),
      });
      const port = this.options.port();
      const exports = new CreateImagesExports({
        root: this.options.saveRoot ?? null,
        ledger,
        assets: this.options.assets,
        ...(this.options.exportFs ? { fs: this.options.exportFs } : {}),
        ...now,
        ...reportIssue,
      });
      const coordinator = new ImageRunCoordinator({
        ledger,
        port,
        assets: this.options.assets,
        workflows,
        exports,
        notify: this.options.notify,
        ...now,
        ...reportIssue,
        ...(this.options.retainRuns !== undefined ? { retainRuns: this.options.retainRuns } : {}),
      });
      coordinator.recoverAfterRestart();
      const workflowAssets = await workflowHolds(workflows);
      try {
        reconcileImageHolds({
          assets: this.options.assets,
          runs: ledger.runAssetIds(),
          workflows: workflowAssets,
          keepWorkflows: workflows.unreadableIds(),
          reportIssue: this.options.reportIssue ?? (() => undefined),
        });
      } catch (error) {
        // Holds are repaired on the next start; they never block opening.
        this.options.reportIssue?.("Could not reconcile Create Images asset holds.", error);
      }
      this.current = { workflows, coordinator, port, assets: this.options.assets, exports };
      this.failure = null;
      return true;
    } catch (error) {
      ledger?.close();
      this.failure = { error: unavailable(error), at: Date.now() };
      this.onError(error);
      return false;
    }
  }
}

async function workflowHolds(workflows: ImageWorkflowStore): Promise<Map<string, string[]>> {
  const inputs = await workflows.imageInputAssets();
  return new Map(workflows.list().map((entry) => [entry.id, inputs[entry.id] ?? []]));
}

/**
 * Makes the `images-run` holders equal the runs in the ledger (holding their generated outputs)
 * and the `images-workflow` holders equal the stored documents (holding their Image Input assets).
 * The ledger, the documents and the asset index commit separately, so a crash or a failed release
 * between them can strand holds or, after an asset index rebuild, lose them. Only assets that still
 * exist are re-held. Other holder kinds (Design Studio) are never touched, and holders of documents
 * that exist but cannot be parsed are kept in case the file is repaired.
 */
export function reconcileImageHolds(input: {
  assets: CreateImagesAssets;
  runs: ReadonlyMap<string, readonly string[]>;
  workflows: ReadonlyMap<string, readonly string[]>;
  keepWorkflows?: ReadonlySet<string>;
  reportIssue(message: string, error: unknown): void;
}): void {
  const { assets, reportIssue } = input;
  const desired: Record<"images-run" | "images-workflow", ReadonlyMap<string, readonly string[]>> = {
    "images-run": input.runs,
    "images-workflow": input.workflows,
  };
  const attempt = (holder: StudioAssetHolder, work: () => void) => {
    try {
      work();
    } catch (error) {
      reportIssue(`Could not reconcile the image holds of ${holder.kind}:${holder.id}.`, error);
    }
  };
  const existing = new Set<string>();
  for (const assetIds of [...input.runs.values(), ...input.workflows.values()]) {
    for (const assetId of assetIds) if (!existing.has(assetId) && assets.get(assetId)) existing.add(assetId);
  }
  for (const kind of ["images-run", "images-workflow"] as const) {
    for (const id of currentHolderIds(assets, kind, existing)) {
      if (desired[kind].has(id) || (kind === "images-workflow" && input.keepWorkflows?.has(id))) continue;
      attempt({ kind, id }, () => assets.releaseAllForHolder({ kind, id }));
    }
    for (const [id, assetIds] of desired[kind]) {
      attempt({ kind, id }, () => assets.replaceHolder({ kind, id }, assetIds.filter((assetId) => existing.has(assetId))));
    }
  }
}

function currentHolderIds(assets: CreateImagesAssets, kind: StudioAssetHolderKind, known: ReadonlySet<string>): Set<string> {
  if (assets.holderIds) return new Set(assets.holderIds(kind));
  const found = new Set<string>();
  for (const assetId of known) {
    for (const holder of assets.holders(assetId)) if (holder.kind === kind) found.add(holder.id);
  }
  return found;
}
