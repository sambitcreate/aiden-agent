import path from "node:path";
import * as electron from "electron";
import type {
  AssetDeepValidator,
  AssetPreviewLeaseDto,
  AssetReferenceAuthority,
  AssetReferenceSnapshot,
  AssetThumbnailGenerator,
} from "./asset-store-core.js";
import { AssetStoreError, ContentAddressedAssetStore } from "./asset-store-core.js";
import {
  ASSET_DELIVERY_GRANT_TTL_MS,
  AssetDeliveryGrantRegistry,
  type AssetDeliveryGrantView,
} from "./asset-delivery-core.js";
import type { RendererDocumentOwner } from "../renderer-document-owner.js";
import {
  WorkflowManifestStore,
  type WorkflowManifestDurability,
} from "./workflow-manifest-store.js";
import {
  CreateImagesRunService,
  type CreateImagesRunReferenceAuthority,
  type CreateImagesRunReferenceReservation,
} from "./run-service.js";
import type { CreateImagesRunJournalStore } from "./run-journal-store.js";
import { resolveCreateImagesGeminiApiKeyAuth } from "./gemini-provider-status-core.js";
import { CreateImagesNativeArchiveService } from "./native-archive-service.js";
import { CreateImagesNodeBananaImportService } from "./node-banana-import-service.js";
import { CreateImagesWorkspaceStore, type CreateImagesWorkspaceStatus } from "./workspace-store.js";
import { CreateImagesWorkflowProposalService } from "./workflow-proposal-service.js";
import { CreateImagesPresentationStore } from "./presentation-store.js";

const defaultAssetDeepValidator: AssetDeepValidator = {
  async validate(input) {
    const { electronAssetDeepValidator } = await import("./electron-asset-images.js");
    return electronAssetDeepValidator.validate(input);
  },
};

const defaultAssetThumbnailGenerator: AssetThumbnailGenerator = {
  async generate(input) {
    const { electronAssetThumbnailGenerator } = await import("./electron-asset-images.js");
    return electronAssetThumbnailGenerator.generate(input);
  },
};

interface WorkflowReferenceReservation {
  workflowId: string;
  next: ReadonlySet<string>;
  active: boolean;
}

class CreateImagesReferenceAuthority
  implements AssetReferenceAuthority, CreateImagesRunReferenceAuthority
{
  private readonly workflows = new Map<string, ReadonlySet<string>>();
  private readonly runs = new Map<string, ReadonlySet<string>>();
  private readonly runReservations = new Map<string, Set<CreateImagesRunReferenceReservation>>();
  private tail: Promise<void> = Promise.resolve();
  private epoch = 0;
  private workflowsComplete = false;
  private runsComplete = false;

  private serialized<Result>(operation: () => Promise<Result>): Promise<Result> {
    const result = this.tail.then(operation, operation);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async initializeWorkflowsInsideFence(store: WorkflowManifestStore): Promise<boolean> {
    this.workflowsComplete = false;
    this.epoch += 1;
    try {
      const inventory = await store.referenceInventory();
      this.workflows.clear();
      for (const record of inventory.records) {
        this.workflows.set(record.workflowId, new Set(record.assetIds));
      }
      this.workflowsComplete = inventory.complete;
      this.epoch += 1;
      return inventory.complete;
    } catch (error) {
      this.workflowsComplete = false;
      this.epoch += 1;
      throw error;
    }
  }

  private async initializeRunsInsideFence(store: CreateImagesRunJournalStore): Promise<boolean> {
    this.runsComplete = false;
    this.epoch += 1;
    try {
      const inventory = await store.referenceInventory();
      this.runs.clear();
      for (const record of inventory.records) {
        this.runs.set(record.runId, new Set(record.assetIds));
      }
      for (const [runId, reservations] of this.runReservations) {
        const protectedIds = new Set(this.runs.get(runId) ?? []);
        for (const reservation of reservations) {
          if (!reservation.active) continue;
          for (const assetId of reservation.next) protectedIds.add(assetId);
        }
        if (protectedIds.size > 0) this.runs.set(runId, protectedIds);
      }
      this.runsComplete = inventory.complete;
      this.epoch += 1;
      return inventory.complete;
    } catch (error) {
      this.runsComplete = false;
      this.epoch += 1;
      throw error;
    }
  }

  async initialize(
    workflows: WorkflowManifestStore,
    runs: CreateImagesRunJournalStore,
  ): Promise<boolean> {
    return this.serialized(async () => {
      const workflowsComplete = await this.initializeWorkflowsInsideFence(workflows);
      const runsComplete = await this.initializeRunsInsideFence(runs);
      return workflowsComplete && runsComplete;
    });
  }

  async reserve(
    workflowId: string,
    assetIds: readonly string[],
  ): Promise<WorkflowReferenceReservation> {
    return this.serialized(async () => {
      const previous = this.workflows.get(workflowId) ?? new Set<string>();
      const next = new Set(assetIds);
      this.workflows.set(workflowId, new Set([...previous, ...next]));
      this.epoch += 1;
      return { workflowId, next, active: true };
    });
  }

  async commit(reservation: WorkflowReferenceReservation): Promise<void> {
    if (!reservation.active) return;
    await this.serialized(async () => {
      if (!reservation.active) return;
      reservation.active = false;
      if (reservation.next.size === 0) this.workflows.delete(reservation.workflowId);
      else this.workflows.set(reservation.workflowId, new Set(reservation.next));
      this.epoch += 1;
    });
  }

  async reconcileFailedMutation(
    reservation: WorkflowReferenceReservation,
    store: WorkflowManifestStore,
  ): Promise<boolean> {
    return this.serialized(async () => {
      if (reservation.active) {
        reservation.active = false;
        // Keep the reservation's previous+next union protected until the
        // durable current/LKG/journal inventory replaces it below. If that
        // inventory cannot be read safely, initializeInsideFence leaves GC
        // fail-closed while this conservative union remains available.
        this.epoch += 1;
      }
      return this.initializeWorkflowsInsideFence(store);
    });
  }

  async reserveRun(
    runId: string,
    assetIds: readonly string[],
  ): Promise<CreateImagesRunReferenceReservation> {
    return this.serialized(async () => {
      const previous = this.runs.get(runId) ?? new Set<string>();
      const next = new Set([...previous, ...assetIds]);
      this.runs.set(runId, next);
      this.epoch += 1;
      const reservation = { runId, next, active: true };
      const reservations = this.runReservations.get(runId) ?? new Set();
      reservations.add(reservation);
      this.runReservations.set(runId, reservations);
      return reservation;
    });
  }

  async commitRun(reservation: CreateImagesRunReferenceReservation): Promise<void> {
    if (!reservation.active) return;
    await this.serialized(async () => {
      if (!reservation.active) return;
      reservation.active = false;
      const reservations = this.runReservations.get(reservation.runId);
      reservations?.delete(reservation);
      if (reservations?.size === 0) this.runReservations.delete(reservation.runId);
      const current = this.runs.get(reservation.runId) ?? new Set<string>();
      const committed = new Set([...current, ...reservation.next]);
      if (committed.size === 0) this.runs.delete(reservation.runId);
      else this.runs.set(reservation.runId, committed);
      this.epoch += 1;
    });
  }

  async releaseRunReservations(runId: string): Promise<void> {
    await this.serialized(async () => {
      const reservations = this.runReservations.get(runId);
      if (!reservations) return;
      for (const reservation of reservations) reservation.active = false;
      this.runReservations.delete(runId);
      this.epoch += 1;
    });
  }

  async reconcileRuns(store: CreateImagesRunJournalStore): Promise<boolean> {
    return this.serialized(() => this.initializeRunsInsideFence(store));
  }

  isWorkflowAssetReferenced(workflowId: string, assetId: string): boolean {
    return this.workflows.get(workflowId)?.has(assetId) ?? false;
  }

  isRunAssetReferenced(runId: string, assetId: string): boolean {
    return this.runs.get(runId)?.has(assetId) ?? false;
  }

  workflowAssetIds(workflowId: string): string[] {
    return [...(this.workflows.get(workflowId) ?? [])].sort();
  }

  allReferencedAssetIds(): Set<string> {
    return new Set(
      [...this.workflows.values(), ...this.runs.values()].flatMap((assetIds) => [...assetIds]),
    );
  }

  async withSnapshot<Result>(
    callback: (snapshot: AssetReferenceSnapshot) => Promise<Result>,
  ): Promise<Result> {
    return this.serialized(async () => {
      if (!this.workflowsComplete || !this.runsComplete) {
        throw new Error(
          "Asset collection is disabled until every workflow recovery issue is resolved.",
        );
      }
      return callback({
        epoch: String(this.epoch),
        completeKinds: ["export", "run", "workflow"],
        records: [
          ...[...this.workflows.entries()].map(([id, assetIds]) => ({
            kind: "workflow" as const,
            id,
            assetIds: [...assetIds].sort(),
          })),
          ...[...this.runs.entries()].map(([id, assetIds]) => ({
            kind: "run" as const,
            id,
            assetIds: [...assetIds].sort(),
          })),
        ],
      });
    });
  }
}

export interface CreateImagesServiceOptions {
  workflowDurability?: WorkflowManifestDurability;
  /** Production requires first-open Finder workspace setup; isolated stores/tests may opt out. */
  workspaceRequired?: boolean;
  assetStore?: {
    now?: () => number;
    deepValidator?: AssetDeepValidator;
    thumbnailGenerator?: AssetThumbnailGenerator;
  };
  runService?: Pick<
    ConstructorParameters<typeof CreateImagesRunService>[0],
    "resolveGeminiAuth" | "createGeminiProvider" | "annotationRasterizer"
  >;
}

export type CreateImagesDeleteWorkflowResult =
  | { status: "deleted" }
  | { status: "not-found" }
  | { status: "unavailable"; message: string };

export class CreateImagesService {
  readonly workflows: WorkflowManifestStore;
  readonly runs: CreateImagesRunService;
  readonly archives: CreateImagesNativeArchiveService;
  readonly nodeBananaImports: CreateImagesNodeBananaImportService;
  readonly workspace: CreateImagesWorkspaceStore;
  readonly proposals = new CreateImagesWorkflowProposalService();
  readonly presentation: CreateImagesPresentationStore;
  readonly grants = new AssetDeliveryGrantRegistry();
  readonly assets: ContentAddressedAssetStore;
  readonly references = new CreateImagesReferenceAuthority();
  private readonly workspaceRequired: boolean;
  private initializePromise: Promise<void> | undefined;
  private missingAssetIds = new Set<string>();

  private pruneResolvedMissingAssets(): void {
    const referenced = this.references.allReferencedAssetIds();
    for (const assetId of this.missingAssetIds) {
      if (!referenced.has(assetId)) this.missingAssetIds.delete(assetId);
    }
  }

  constructor(rootDirectory: string, options: CreateImagesServiceOptions = {}) {
    this.workspaceRequired = options.workspaceRequired ?? false;
    this.workflows = new WorkflowManifestStore(() => rootDirectory, options.workflowDurability);
    this.presentation = new CreateImagesPresentationStore(rootDirectory);
    let workspaceStore: CreateImagesWorkspaceStore | undefined;
    this.assets = new ContentAddressedAssetStore(rootDirectory, this.references, {
      deepValidator: options.assetStore?.deepValidator ?? defaultAssetDeepValidator,
      thumbnailGenerator: options.assetStore?.thumbnailGenerator ?? defaultAssetThumbnailGenerator,
      ...(options.assetStore?.now ? { now: options.assetStore.now } : {}),
      onAssetPublished: async (asset) => {
        await workspaceStore?.syncAsset(asset.assetId);
      },
    });
    this.workspace = new CreateImagesWorkspaceStore(rootDirectory, this.assets, {
      ...(options.assetStore?.now ? { now: options.assetStore.now } : {}),
    });
    workspaceStore = this.workspace;
    this.runs = new CreateImagesRunService({
      rootResolver: () => rootDirectory,
      workflows: this.workflows,
      assets: this.assets,
      references: this.references,
      ...(options.assetStore?.now ? { now: options.assetStore.now } : {}),
      workspaceStatus: (): Promise<Pick<CreateImagesWorkspaceStatus, "configured" | "state">> =>
        this.workspace.status(),
      workspaceRequired: options.workspaceRequired ?? false,
      ...options.runService,
      annotationRasterizer: options.runService?.annotationRasterizer ?? {
        async rasterize(input) {
          const { electronAnnotationRasterizer } = await import("./electron-asset-images.js");
          return electronAnnotationRasterizer.rasterize(input);
        },
      },
    });
    this.archives = new CreateImagesNativeArchiveService({
      rootDirectory,
      workflows: this.workflows,
      assets: this.assets,
      publishImportedWorkflow: (workflow, isCurrent) =>
        this.mutateWorkflow(workflow.id, workflow.assetRefs, () =>
          this.workflows.create(workflow, isCurrent),
        ),
      ...(options.assetStore?.now ? { now: options.assetStore.now } : {}),
    });
    this.nodeBananaImports = new CreateImagesNodeBananaImportService({
      rootDirectory,
      assets: this.assets,
      publishImportedWorkflow: (workflow, isCurrent) =>
        this.mutateWorkflow(workflow.id, workflow.assetRefs, () =>
          this.workflows.create(workflow, isCurrent),
        ),
      ...(options.assetStore?.now ? { now: options.assetStore.now } : {}),
    });
  }

  async initialize(): Promise<void> {
    this.initializePromise ??= (async () => {
      const workspace = await this.workspace.status();
      if (this.workspaceRequired && (!workspace.configured || workspace.state !== "ready")) {
        throw new Error("Configure a writable Create Images workspace before continuing.");
      }
      const summaries = await this.workflows.initialize();
      await this.runs.initialize();
      const referencesComplete = await this.references.initialize(
        this.workflows,
        this.runs.journals,
      );
      const status = await this.assets.status();
      if (
        status.healthy &&
        referencesComplete &&
        summaries.every((summary) => summary.health === "healthy")
      ) {
        const rebuilt = await this.assets.rebuildReferenceAccounting();
        this.missingAssetIds = new Set(rebuilt.missingAssetIds);
      } else {
        this.missingAssetIds.clear();
      }
    })();
    try {
      await this.initializePromise;
    } catch (error) {
      this.initializePromise = undefined;
      throw error;
    }
  }

  /**
   * Initializes the read-only workflow library even when a future run-index
   * schema prevents the run service from opening. This fallback is deliberately
   * limited to an explicitly unsafe run index: every mutating/run path continues
   * to use initialize() and therefore remains fail-closed.
   */
  async initializeReadOnlyLibrary(): Promise<void> {
    try {
      await this.initialize();
    } catch (error) {
      const [, runIndex] = await Promise.all([
        this.workflows.initialize(),
        this.runs.journals.indexHealth(),
      ]);
      if (runIndex.status !== "unsafe") throw error;
      this.missingAssetIds.clear();
    }
  }

  async mutateWorkflow<Result>(
    workflowId: string,
    assetIds: readonly string[],
    operation: () => Promise<Result>,
    options: { allowMissingAssetIds?: readonly string[] } = {},
  ): Promise<Result> {
    await this.initialize();
    const current = assetIds.length > 0 ? await this.workflows.get(workflowId) : undefined;
    const allowedMissingAssetIds = new Set([
      ...(current?.assetRefs ?? []),
      ...(options.allowMissingAssetIds ?? []),
    ]);
    const reservation = await this.references.reserve(workflowId, assetIds);
    const presentAssetIds: string[] = [];
    try {
      for (const assetId of assetIds) {
        if (await this.assets.getAvailable(assetId)) presentAssetIds.push(assetId);
        else if (!allowedMissingAssetIds.has(assetId))
          throw new Error(`Asset ${assetId} does not exist.`);
        else this.missingAssetIds.add(assetId);
      }
      const result = await operation();
      await this.references.commit(reservation);
      for (const assetId of presentAssetIds) this.missingAssetIds.delete(assetId);
      this.pruneResolvedMissingAssets();
      try {
        await this.assets.replaceReferences({ kind: "workflow", id: workflowId }, presentAssetIds);
      } catch {
        // The workflow and the in-memory reference authority are already
        // committed. Persisted accounting is rebuildable and GC still consults
        // the authoritative snapshot, so do not misreport a successful save as
        // a CAS failure that the renderer should retry.
        console.warn("[create-images] Asset reference accounting needs a rebuild.");
      }
      return result;
    } catch (error) {
      await this.references.reconcileFailedMutation(reservation, this.workflows).catch(() => {
        // Reconciliation marks the authority incomplete before reading disk, so
        // collection remains fail-closed even when the inventory itself is unsafe.
      });
      throw error;
    }
  }

  async deleteWorkflow(
    workflowId: string,
    expectedRevision: number,
    isRendererCurrent: () => boolean,
  ): Promise<CreateImagesDeleteWorkflowResult> {
    await this.initialize();
    const guarded = await this.runs.deleteWorkflowIfRunLifecycleEmpty(workflowId, async () => {
      await this.mutateWorkflow(workflowId, [], () =>
        this.workflows.delete(workflowId, expectedRevision, isRendererCurrent),
      );
    });
    if (guarded.status !== "allowed") return guarded;
    return { status: "deleted" };
  }

  async refreshReferenceAuthority(): Promise<void> {
    const referencesComplete = await this.references.initialize(this.workflows, this.runs.journals);
    if (referencesComplete) {
      const rebuilt = await this.assets.rebuildReferenceAccounting();
      this.missingAssetIds = new Set(rebuilt.missingAssetIds);
    } else {
      this.missingAssetIds.clear();
    }
  }

  missingAssetIdsForWorkflow(workflowId: string): string[] {
    return this.references
      .workflowAssetIds(workflowId)
      .filter((assetId) => this.missingAssetIds.has(assetId));
  }

  missingAssetCount(): number {
    return this.missingAssetIds.size;
  }

  noteAssetAvailable(assetId: string): void {
    this.missingAssetIds.delete(assetId);
  }

  noteAssetMissing(assetId: string): void {
    this.missingAssetIds.add(assetId);
  }

  async assetResponse(
    assetId: string,
    rendition: "preview" | "preview-128" | "preview-256" | "preview-512" | "original" = "preview",
  ): Promise<Response | undefined> {
    await this.initialize();
    let preview: {
      bytes: Uint8Array;
      byteLength: number;
      mediaType: "image/jpeg" | "image/png";
    };
    if (rendition === "original") {
      const ownerId = "asset-protocol-original";
      let lease: AssetPreviewLeaseDto | undefined;
      try {
        lease = await this.assets.acquirePreviewLease(assetId, ownerId, 1_000);
        const original = await this.assets.readPreview(lease.token, ownerId);
        preview = {
          bytes: original.bytes,
          byteLength: original.bytes.byteLength,
          mediaType: original.asset.mediaType,
        };
      } catch (fallbackError) {
        if (
          fallbackError instanceof AssetStoreError &&
          fallbackError.code === "asset_source_missing"
        ) {
          this.noteAssetMissing(assetId);
          return undefined;
        }
        throw fallbackError;
      } finally {
        if (lease) await this.assets.releasePreviewLease(lease.token, ownerId).catch(() => false);
      }
    } else {
      try {
        const size =
          rendition === "preview-128" ? 128 : rendition === "preview-256" ? 256 : 512;
        preview = await this.assets.getThumbnail(assetId, size);
      } catch (error) {
        if (error instanceof AssetStoreError && error.code === "asset_source_missing") {
          this.noteAssetMissing(assetId);
          return undefined;
        }
        if (!(error instanceof AssetStoreError) || error.code !== "thumbnail_unavailable") {
          throw error;
        }

        // A derived thumbnail is an optimization, not the authority for whether
        // an otherwise-valid reference can be shown. When the isolated thumbnail
        // worker is temporarily unavailable, stream the already-validated
        // canonical PNG/JPEG through the same opaque protocol grant instead of
        // leaving the canvas with a permanent blank preview.
        const ownerId = "asset-protocol-fallback";
        let lease: AssetPreviewLeaseDto | undefined;
        try {
          lease = await this.assets.acquirePreviewLease(assetId, ownerId, 1_000);
          const original = await this.assets.readPreview(lease.token, ownerId);
          preview = {
            bytes: original.bytes,
            byteLength: original.bytes.byteLength,
            mediaType: original.asset.mediaType,
          };
        } catch (fallbackError) {
          if (
            fallbackError instanceof AssetStoreError &&
            fallbackError.code === "asset_source_missing"
          ) {
            this.noteAssetMissing(assetId);
            return undefined;
          }
          throw fallbackError;
        } finally {
          if (lease) await this.assets.releasePreviewLease(lease.token, ownerId).catch(() => false);
        }
      }
    }
    const body = new Uint8Array(preview.bytes.byteLength);
    body.set(preview.bytes);
    return new Response(body.buffer, {
      headers: {
        "Content-Length": String(preview.byteLength),
        "Content-Type": preview.mediaType,
      },
    });
  }

  async grantAsset(
    owner: RendererDocumentOwner,
    assetId: string,
    isAuthorized: (assetId: string) => boolean,
  ): Promise<AssetDeliveryGrantView> {
    await this.initialize();
    if (!isAuthorized(assetId)) {
      throw new Error("The renderer document is not authorized to access this asset.");
    }
    const leaseOwnerId = `document-${owner.id}`;
    const lease = await this.assets.acquirePreviewLease(
      assetId,
      leaseOwnerId,
      ASSET_DELIVERY_GRANT_TTL_MS,
    );
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      void this.assets.releasePreviewLease(lease.token, leaseOwnerId).catch(() => {
        console.warn("[create-images] Asset preview lease cleanup needs reconciliation.");
      });
    };
    try {
      return this.grants.mint(owner, assetId, isAuthorized, {
        expiresAt: lease.expiresAt,
        release,
      });
    } catch (error) {
      release();
      throw error;
    }
  }
}

let singleton: CreateImagesService | undefined;

export function createImagesService(): CreateImagesService {
  singleton ??= new CreateImagesService(
    path.join(electron.app.getPath("userData"), "create-images"),
    {
      workspaceRequired: true,
      runService: {
        resolveGeminiAuth: async () => {
          const { providerRegistry } = await import("../provider-registry.js");
          return resolveCreateImagesGeminiApiKeyAuth({
            credentialKind: () => providerRegistry.getBuiltinCredentialKind("google"),
            requestAuth: () => providerRegistry.getBuiltinRequestAuth("google"),
          });
        },
      },
    },
  );
  return singleton;
}
