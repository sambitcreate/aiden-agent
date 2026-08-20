import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from "../platform.js";
import { rendererDocumentOwner } from "../services/renderer-document-owner.js";
import { createImagesEnabled } from "../services/create-images/feature-flag.js";
import { createImagesService } from "../services/create-images/create-images-service.js";
import {
  CREATE_IMAGES_GEMINI_CREDENTIAL_PROVIDER_ID,
  createImagesGeminiProviderStatus,
} from "../services/create-images/gemini-provider-status-core.js";
import { CreateImagesMutationRateLimiter } from "../services/create-images/mutation-rate-limit-core.js";
import { shouldReleaseCreateImagesRunOwner } from "../services/create-images/run-publication-binding-core.js";
import { providerRegistry } from "../services/provider-registry.js";
import {
  WorkflowManifestLoadError,
  WorkflowRevisionConflictError,
  type WorkflowRecoveryHealth,
} from "../services/create-images/workflow-manifest-store.js";
import {
  DEFAULT_ASSET_STORE_LIMITS,
  AssetStoreError,
  type AssetMetadataDto,
} from "../services/create-images/asset-store-core.js";
import { AssetImageValidationError } from "../services/create-images/asset-image-validation-core.js";
import {
  CreateImagesImageImportError,
  ingestCreateImagesImageFile,
} from "../services/create-images/electron-asset-import.js";
import { CreateImagesNativeArchiveError } from "../services/create-images/native-archive-service.js";
import { CreateImagesNodeBananaServiceError } from "../services/create-images/node-banana-import-service.js";
import type { CreateImagesWorkspaceStatus as CreateImagesWorkspaceStoreStatus } from "../services/create-images/workspace-store.js";
import {
  createImagesAssetGrantUrl,
  parseCreateImagesCreateWorkflowRequest,
  parseCreateImagesApplyAssetCleanupRequest,
  parseCreateImagesDeleteWorkflowRequest,
  parseCreateImagesDiscardDegradedRunRequest,
  parseCreateImagesDiscardAutosaveRequest,
  parseCreateImagesDownloadRunAssetRequest,
  parseCreateImagesDroppedAssetImportRequest,
  parseCreateImagesDuplicateWorkflowRequest,
  parseCreateImagesExportArchiveRequest,
  parseCreateImagesGetWorkflowRequest,
  parseCreateImagesImportArchiveRequest,
  parseCreateImagesImportNodeBananaRequest,
  parseCreateImagesGrantAssetRequest,
  parseCreateImagesGrantRunAssetRequest,
  parseCreateImagesGetRunRequest,
  parseCreateImagesListRunsRequest,
  parseCreateImagesPlanRunHistoryPruneRequest,
  parseCreateImagesPlanAssetCleanupRequest,
  parseCreateImagesPasteImageRequest,
  parseCreateImagesPrepareRunRequest,
  parseCreateImagesPickAssetRequest,
  parseCreateImagesPlanDegradedRunDiscardRequest,
  parseCreateImagesPruneRunHistoryRequest,
  parseCreateImagesRecoverWorkflowRequest,
  parseCreateImagesRecoverRunRequest,
  parseCreateImagesResolveRunAmbiguityRequest,
  parseCreateImagesRenameWorkflowRequest,
  parseCreateImagesRepairWorkflowRequest,
  parseCreateImagesRevokeAssetGrantRequest,
  parseCreateImagesSaveWorkflowRequest,
  parseCreateImagesStartRunRequest,
  parseCreateImagesStopRunRequest,
  parseCreateImagesSubscribeRunsRequest,
  parseCreateImagesUnsubscribeRunsRequest,
  parseCreateImagesWorkspaceRequest,
  type CreateImagesAssetGrantView,
  type CreateImagesAssetCleanupPlanResult,
  type CreateImagesAssetCleanupResult,
  type CreateImagesAssetView,
  type CreateImagesDroppedAssetImportItem,
  type CreateImagesDroppedAssetImportResult,
  type CreateImagesDownloadRunAssetResult,
  type CreateImagesExportArchiveResult,
  type CreateImagesImportArchiveResult,
  type CreateImagesImportNodeBananaResult,
  type CreateImagesRunChangedNotification,
  type CreateImagesRunMutationResult,
  type CreateImagesPrepareRunResult,
  type CreateImagesPasteImageResult,
  type CreateImagesWorkflowMutationResult,
  type CreateImagesWorkflowRecoveryView,
  type CreateImagesWorkspaceStatus,
  type CreateImagesChooseWorkspaceResult,
  type CreateImagesOpenWorkspaceResult,
  type CreateImagesSyncWorkspaceResult,
} from "../../renderer/shared/create-images/ipc.js";
import { createImagesWorkflowFromTemplate } from "../../renderer/shared/create-images/templates.js";
import {
  CREATE_IMAGES_GEMINI_PROVIDER_ID,
  CREATE_IMAGES_PROVIDER_STATUS_VERSION,
  type CreateImagesProviderStatus,
} from "../../renderer/shared/create-images/providers.js";

const CREATE_IMAGES_ASSET_CLEANUP_GRACE_MS = 7 * 24 * 60 * 60_000;

function recoveryView(health: WorkflowRecoveryHealth): CreateImagesWorkflowRecoveryView {
  if (health.status === "missing") return { status: "missing", workflowId: health.workflowId };
  const { currentPath: _path, ...safe } = health;
  return safe;
}

function assetView(asset: AssetMetadataDto): CreateImagesAssetView {
  return {
    assetId: asset.assetId,
    mediaType: asset.mediaType,
    byteLength: asset.byteLength,
    width: asset.width,
    height: asset.height,
    importedAt: asset.createdAt,
    ...(asset.displayName ? { originalName: asset.displayName } : {}),
  };
}

function archiveBaseName(title: string): string {
  const safe = [...title.normalize("NFKC")]
    .map((character) =>
      character.charCodeAt(0) <= 0x1f || '\\/:*?"<>|'.includes(character) ? "-" : character,
    )
    .join("")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 80);
  return safe || "Image workflow";
}

function archiveFailureMessage(error: unknown): string {
  if (!(error instanceof CreateImagesNativeArchiveError)) {
    return "The native workflow archive operation failed safely.";
  }
  if (error.code === "archive_invalid") {
    return "This .aiden-images file is invalid, unsafe, or unsupported.";
  }
  if (error.code === "archive_revision_conflict") {
    return "The workflow changed before the archive was written. Try exporting again.";
  }
  if (error.code === "archive_workflow_missing") return "The workflow no longer exists.";
  return "Aiden could not read or write the native workflow archive.";
}

function nodeBananaImportFailureMessage(error: unknown): string {
  if (error instanceof CreateImagesNodeBananaServiceError && error.code === "invalid") {
    return "This Node Banana JSON file is invalid, too large, or unsupported.";
  }
  return "Aiden could not import the Node Banana workflow safely.";
}

async function mutationFailure(error: unknown): Promise<CreateImagesWorkflowMutationResult> {
  const service = createImagesService();
  if (error instanceof WorkflowRevisionConflictError) {
    if (error.actualRevision === null) return { status: "not-found" };
    const current = await service.workflows.get(error.workflowId).catch(() => undefined);
    if (!current) return { status: "not-found" };
    return {
      status: "conflict",
      expectedRevision: error.expectedRevision ?? 1,
      currentRevision: error.actualRevision,
      current,
    };
  }
  if (error instanceof WorkflowManifestLoadError) {
    return {
      status: "unavailable",
      message:
        error.status === "unsafe"
          ? "This workflow was created by a newer version of Aiden and is read-only."
          : "This workflow needs recovery before it can be changed.",
    };
  }
  return {
    status: "unavailable",
    message: "The device-local workflow store failed safely. Try again.",
  };
}

function assetImportFailureMessage(error: unknown): string {
  if (error instanceof CreateImagesImageImportError) {
    if (error.code === "animated_image") {
      return "Animated images are not supported yet. Export a still frame and try again.";
    }
    if (error.code === "vector_image") {
      return "Vector images such as SVG are not supported. Export a static raster image and try again.";
    }
    return "This image format could not be converted safely.";
  }
  if (error instanceof AssetImageValidationError) {
    if (error.code === "image_dimensions_exceeded") {
      return "The selected image exceeds the 16 megapixel import limit.";
    }
    return "The selected file is not a supported, valid static image.";
  }
  if (!(error instanceof AssetStoreError)) return "The selected image could not be imported.";
  if (error.code === "asset_ingest_too_large") {
    return "The selected image is larger than the 64 MB import limit.";
  }
  if (error.code === "asset_store_quota_exceeded") {
    return "Create Images storage is full. Remove unused assets before importing another image.";
  }
  if (error.code === "asset_store_repair_required") {
    return "Image storage needs repair before another image can be imported.";
  }
  return "The selected file is not a supported, valid static image.";
}

function reportAssetImportFailure(error: unknown): void {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code ?? "unknown")
      : "unknown";
  console.warn("[create-images] Image import failed safely.", {
    name: error instanceof Error ? error.name : "UnknownError",
    code,
    message: error instanceof Error ? error.message : "Unknown image import failure.",
  });
}

function workspaceStatusView(
  status: CreateImagesWorkspaceStoreStatus,
): CreateImagesWorkspaceStatus {
  if (!status.configured || status.state === "unconfigured") return { status: "unconfigured" };
  if (status.state === "ready") {
    return {
      status: "ready",
      displayName: status.displayName ?? "Image workspace",
      importedAssetCount: status.importedCount,
      generatedAssetCount: status.generatedCount,
      conflictCount: status.conflictCount + status.driftedCount,
      ...(status.lastSyncedAt ? { lastSyncedAt: status.lastSyncedAt } : {}),
    };
  }
  const reason =
    status.state === "unwritable"
      ? "permission-denied"
      : status.state === "drifted"
        ? "changed"
        : "unsafe";
  const message =
    status.state === "unwritable"
      ? "Aiden cannot write to the selected image workspace. Check its permissions or choose another folder."
      : status.state === "drifted"
        ? "The selected image workspace moved, was replaced, or is no longer available."
        : status.state === "repair_required"
          ? "The image workspace configuration needs repair before it can be used."
          : "The selected image workspace contains an unsafe or conflicting entry.";
  return {
    status: "unavailable",
    reason,
    ...(status.displayName ? { displayName: status.displayName } : {}),
    message,
  };
}

function grantView(
  grant: { token: string; expiresAt: number },
  asset: AssetMetadataDto,
): CreateImagesAssetGrantView {
  return {
    token: grant.token,
    url: createImagesAssetGrantUrl(grant.token),
    expiresAt: grant.expiresAt,
    asset: assetView(asset),
  };
}

async function ingestSelectedImage(
  service: ReturnType<typeof createImagesService>,
  filePath: string,
) {
  return ingestCreateImagesImageFile(service.assets, filePath);
}

async function* clipboardImageBytes(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  yield bytes;
}

async function ingestClipboardImage(service: ReturnType<typeof createImagesService>) {
  const image = clipboard.readImage();
  if (image.isEmpty()) return undefined;
  const size = image.getSize();
  const pixels = size.width * size.height;
  if (
    !Number.isSafeInteger(size.width) ||
    !Number.isSafeInteger(size.height) ||
    size.width < 1 ||
    size.height < 1 ||
    size.width > DEFAULT_ASSET_STORE_LIMITS.maxWidth ||
    size.height > DEFAULT_ASSET_STORE_LIMITS.maxHeight ||
    !Number.isSafeInteger(pixels) ||
    pixels > DEFAULT_ASSET_STORE_LIMITS.maxPixels
  ) {
    throw new AssetImageValidationError(
      "image_dimensions_exceeded",
      "The clipboard image dimensions exceed Aiden's configured safety limit.",
    );
  }
  const bytes = image.toPNG();
  if (bytes.byteLength < 1) {
    throw new AssetStoreError("invalid_asset_request", "The clipboard image is empty.");
  }
  if (bytes.byteLength > DEFAULT_ASSET_STORE_LIMITS.maxImportBytes) {
    throw new AssetStoreError(
      "asset_ingest_too_large",
      `The clipboard image exceeds the ${DEFAULT_ASSET_STORE_LIMITS.maxImportBytes}-byte ingest limit.`,
    );
  }
  return service.assets.ingest(clipboardImageBytes(bytes), {
    origin: { kind: "import" },
    declaredMimeType: "image/png",
    displayName: "Clipboard image.png",
    validationDisplayName: "clipboard.png",
  });
}

export function registerCreateImagesHandlers(): void {
  if (!createImagesEnabled()) return;
  let pickerActive = false;
  let clipboardPasteActive = false;
  let archiveDialogActive = false;
  let workspacePickerActive = false;
  const mutationRateLimiter = new CreateImagesMutationRateLimiter();
  const mutationAllowed = (owner: { id: number }, cost = 1): boolean =>
    mutationRateLimiter.consume(`webcontents:${owner.id}`, cost);
  const mutationRateFailure = (): CreateImagesWorkflowMutationResult => ({
    status: "unavailable",
    message: "Too many workflow changes were requested. Wait a moment and try again.",
  });
  const runRateFailure = (): CreateImagesRunMutationResult => ({
    status: "unavailable",
    message: "Too many run requests were made. Wait a moment and try again.",
  });
  const prepareRunRateFailure = (): CreateImagesPrepareRunResult => ({
    status: "unavailable",
    message: "Too many run requests were made. Wait a moment and try again.",
  });
  const runSubscriptions = new Map<
    string,
    {
      workflowId: string;
      ownerId: number;
      documentId: string;
      streamSequence: number;
      send(payload: CreateImagesRunChangedNotification): void;
      release(): void;
    }
  >();
  const runOwners = new Map<string, { workflowId: string; releaseInvalidation(): void }>();
  let removeRunListener: (() => void) | undefined;
  const readRateLimiter = new CreateImagesMutationRateLimiter(Date.now, 120, 60_000, 64);
  const readOwnerKey = (owner: { id: number }): string => `webcontents:${owner.id}:run-read`;
  const readAllowed = (owner: { id: number }, cost: number): boolean =>
    readRateLimiter.consume(readOwnerKey(owner), cost);
  const runReadRateFailure = (owner: { id: number }) => ({
    status: "unavailable" as const,
    message: "Too many run history requests were made. Wait a moment and try again.",
    retryAfterMs: Math.max(500, readRateLimiter.retryAfterMs(readOwnerKey(owner))),
  });
  const providerStatusRateFailure = (owner: { id: number }): CreateImagesProviderStatus => ({
    schemaVersion: CREATE_IMAGES_PROVIDER_STATUS_VERSION,
    providerId: CREATE_IMAGES_GEMINI_PROVIDER_ID,
    displayName: "Google Gemini",
    connectionState: "unavailable",
    safeErrorCode: "rate-limited",
    retryAfterMs: Math.max(500, readRateLimiter.retryAfterMs(readOwnerKey(owner))),
  });
  const runPublicationStates = new Map<string, { dirty: boolean; running: boolean }>();
  const runOperationsByOwner = new Map<number, number>();
  let activeRunOperations = 0;
  const acquireRunOperation = (ownerId: number): (() => void) | undefined => {
    const ownerOperations = runOperationsByOwner.get(ownerId) ?? 0;
    if (activeRunOperations >= 8 || ownerOperations >= 2) return undefined;
    activeRunOperations += 1;
    runOperationsByOwner.set(ownerId, ownerOperations + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      activeRunOperations -= 1;
      const remaining = (runOperationsByOwner.get(ownerId) ?? 1) - 1;
      if (remaining > 0) runOperationsByOwner.set(ownerId, remaining);
      else runOperationsByOwner.delete(ownerId);
    };
  };
  const runBounded = async <Result>(
    ownerId: number,
    operation: () => Promise<Result>,
  ): Promise<{ status: "completed"; value: Result } | { status: "busy" }> => {
    const release = acquireRunOperation(ownerId);
    if (!release) return { status: "busy" };
    try {
      return { status: "completed", value: await operation() };
    } finally {
      release();
    }
  };

  const releaseRunOwner = (runId: string): void => {
    const binding = runOwners.get(runId);
    if (!binding) return;
    runOwners.delete(runId);
    binding.releaseInvalidation();
  };

  const scheduleRunPublication = (workflowId: string): void => {
    const service = createImagesService();
    const hasConsumer =
      [...runOwners.values()].some((binding) => binding.workflowId === workflowId) ||
      [...runSubscriptions.values()].some((subscription) => subscription.workflowId === workflowId);
    if (!hasConsumer) return;
    if (!runPublicationStates.has(workflowId) && runPublicationStates.size >= 256) return;
    const state = runPublicationStates.get(workflowId) ?? {
      dirty: false,
      running: false,
    };
    state.dirty = true;
    runPublicationStates.set(workflowId, state);
    if (state.running) return;
    state.running = true;
    void (async () => {
      try {
        while (state.dirty) {
          state.dirty = false;
          let snapshot: Awaited<ReturnType<typeof service.runs.list>> | undefined;
          for (let attempt = 0; attempt < 3 && !snapshot; attempt += 1) {
            try {
              const bounded = await runBounded(-1, () => service.runs.list(workflowId));
              if (bounded.status === "completed") {
                snapshot = bounded.value;
                break;
              }
            } catch {
              // A failed local snapshot follows the same bounded retry path
              // as queue pressure and never creates an unbounded task.
            }
            await new Promise<void>((resolve) => {
              const timeout = setTimeout(resolve, 25 * 2 ** attempt);
              timeout.unref?.();
            });
          }
          if (!snapshot) {
            snapshot = {
              status: "unavailable",
              message: "Run updates are temporarily busy.",
              retryAfterMs: 500,
            };
          }
          for (const [runId, binding] of runOwners) {
            if (binding.workflowId !== workflowId) continue;
            if (shouldReleaseCreateImagesRunOwner(runId, snapshot)) {
              releaseRunOwner(runId);
            }
          }
          for (const [subscriptionId, subscription] of runSubscriptions) {
            if (subscription.workflowId !== workflowId) continue;
            try {
              subscription.streamSequence += 1;
              subscription.send({
                subscriptionId,
                streamSequence: subscription.streamSequence,
                snapshot,
              });
            } catch {
              subscription.release();
            }
          }
        }
      } catch {
        // A coalesced notification retries once; any later durable run change
        // also schedules a fresh complete snapshot.
      } finally {
        state.running = false;
        if (state.dirty) queueMicrotask(() => scheduleRunPublication(workflowId));
        else if (runPublicationStates.get(workflowId) === state) {
          runPublicationStates.delete(workflowId);
        }
      }
    })();
  };

  const ensureRunListener = (): void => {
    if (removeRunListener) return;
    removeRunListener = createImagesService().runs.subscribe(scheduleRunPublication);
  };

  const bindRunToOwner = (
    owner: ReturnType<typeof rendererDocumentOwner>,
    workflowId: string,
    runId: string,
  ): void => {
    releaseRunOwner(runId);
    let live = true;
    let releaseInvalidation: () => void = () => undefined;
    const invalidate = (): void => {
      if (!live) return;
      live = false;
      const current = runOwners.get(runId);
      if (current?.releaseInvalidation === releaseInvalidation) runOwners.delete(runId);
      void createImagesService().runs.stop(workflowId, runId, "renderer-disconnected");
    };
    releaseInvalidation = owner.onInvalidated(invalidate);
    if (!live || owner.isDestroyed()) {
      releaseInvalidation();
      invalidate();
      return;
    }
    runOwners.set(runId, { workflowId, releaseInvalidation });
    ensureRunListener();
  };

  ipcMain.handle(
    "imageWorkflows:workspaceStatus",
    async (event, value: unknown): Promise<CreateImagesWorkspaceStatus> => {
      const owner = rendererDocumentOwner(event, () => new Error("Untrusted workspace request."));
      parseCreateImagesWorkspaceRequest(value);
      if (!readAllowed(owner, 2)) {
        return {
          status: "unavailable",
          reason: "sync-failed",
          message: "Too many workspace requests were made. Wait a moment and try again.",
        };
      }
      const bounded = await runBounded(owner.id, () => createImagesService().workspace.status());
      if (bounded.status === "busy" || owner.isDestroyed()) {
        return {
          status: "unavailable",
          reason: "sync-failed",
          message: "The image workspace is busy. Wait a moment and try again.",
        };
      }
      return workspaceStatusView(bounded.value);
    },
  );

  ipcMain.handle(
    "imageWorkflows:chooseWorkspace",
    async (event, value: unknown): Promise<CreateImagesChooseWorkspaceResult> => {
      const owner = rendererDocumentOwner(event, () => new Error("Untrusted workspace request."));
      parseCreateImagesWorkspaceRequest(value);
      if (!mutationAllowed(owner, 2)) {
        return {
          status: "unavailable",
          message: "Too many workspace changes were requested. Wait a moment and try again.",
        };
      }
      if (workspacePickerActive) {
        return { status: "unavailable", message: "Another workspace picker is already open." };
      }
      const parent = BrowserWindow.fromWebContents(event.sender);
      if (!parent) return { status: "unavailable", message: "The Aiden window is unavailable." };
      workspacePickerActive = true;
      try {
        const picked = await dialog.showOpenDialog(parent, {
          title: "Choose an image workspace",
          defaultPath: app.getPath("pictures"),
          buttonLabel: "Use Folder",
          properties: ["openDirectory", "createDirectory"],
        });
        if (picked.canceled || !picked.filePaths[0]) return { status: "canceled" };
        if (owner.isDestroyed()) {
          return { status: "unavailable", message: "The Aiden window was closed." };
        }
        const status = await createImagesService().workspace.configureChosenDirectory(
          picked.filePaths[0],
        );
        const workspace = workspaceStatusView(status);
        return workspace.status === "ready"
          ? { status: "ready", workspace }
          : {
              status: "unavailable",
              message:
                workspace.status === "unavailable"
                  ? workspace.message
                  : "The image workspace was not configured.",
            };
      } catch {
        return {
          status: "unavailable",
          message: "Aiden could not safely configure that image workspace.",
        };
      } finally {
        workspacePickerActive = false;
      }
    },
  );

  ipcMain.handle(
    "imageWorkflows:openWorkspace",
    async (event, value: unknown): Promise<CreateImagesOpenWorkspaceResult> => {
      const owner = rendererDocumentOwner(event, () => new Error("Untrusted workspace request."));
      parseCreateImagesWorkspaceRequest(value);
      if (!readAllowed(owner, 1)) {
        return { status: "unavailable", message: "The image workspace is temporarily busy." };
      }
      try {
        const status = await createImagesService().workspace.status();
        if (!status.configured) return { status: "unconfigured" };
        const target = await createImagesService().workspace.openRoot();
        if (owner.isDestroyed()) {
          return { status: "unavailable", message: "The Aiden window was closed." };
        }
        const error = await shell.openPath(target.filePath);
        return error
          ? { status: "unavailable", message: "Finder could not open the image workspace." }
          : { status: "opened" };
      } catch {
        return {
          status: "unavailable",
          message: "Reconnect the image workspace before opening it in Finder.",
        };
      }
    },
  );

  ipcMain.handle(
    "imageWorkflows:syncWorkspace",
    async (event, value: unknown): Promise<CreateImagesSyncWorkspaceResult> => {
      const owner = rendererDocumentOwner(event, () => new Error("Untrusted workspace request."));
      parseCreateImagesWorkspaceRequest(value);
      if (!mutationAllowed(owner, 2)) {
        return { status: "unavailable", message: "The image workspace is temporarily busy." };
      }
      const current = await createImagesService().workspace.status();
      if (!current.configured) return { status: "unconfigured" };
      const bounded = await runBounded(owner.id, async () => {
        await createImagesService().workspace.syncAll();
        return createImagesService().workspace.status();
      });
      if (bounded.status === "busy" || owner.isDestroyed()) {
        return { status: "unavailable", message: "The image workspace is temporarily busy." };
      }
      const workspace = workspaceStatusView(bounded.value);
      return workspace.status === "ready"
        ? { status: "synced", workspace }
        : {
            status: "unavailable",
            message:
              workspace.status === "unavailable"
                ? workspace.message
                : "The image workspace is not configured.",
          };
    },
  );

  ipcMain.handle("imageWorkflows:providerStatus", async (event) => {
    const owner = rendererDocumentOwner(event, () => new Error("Untrusted provider request."));
    if (!readAllowed(owner, 2)) return providerStatusRateFailure(owner);
    const bounded = await runBounded(owner.id, () =>
      createImagesGeminiProviderStatus({
        credentialKind: () =>
          providerRegistry.getBuiltinCredentialKind(CREATE_IMAGES_GEMINI_CREDENTIAL_PROVIDER_ID),
        requestAuth: () =>
          providerRegistry.getBuiltinRequestAuth(CREATE_IMAGES_GEMINI_CREDENTIAL_PROVIDER_ID),
      }),
    );
    if (bounded.status === "busy" || owner.isDestroyed()) {
      return providerStatusRateFailure(owner);
    }
    return bounded.value;
  });

  ipcMain.handle("imageWorkflows:list", async (event) => {
    const owner = rendererDocumentOwner(event, () => new Error("Untrusted workflow request."));
    const service = createImagesService();
    try {
      await service.initializeReadOnlyLibrary();
      const summaries = await service.workflows.list();
      const recoveries = [] as CreateImagesWorkflowRecoveryView[];
      for (const summary of summaries) {
        if (summary.health === "healthy") continue;
        recoveries.push(recoveryView(await service.workflows.inspect(summary.id)));
      }
      if (owner.isDestroyed()) throw new Error("The renderer document is no longer active.");
      return {
        status: "ready" as const,
        workflows: summaries.map((summary) => ({
          id: summary.id,
          title: summary.title,
          revision: summary.revision,
          createdAt: summary.createdAt,
          updatedAt: summary.updatedAt,
          nodeCount: summary.nodeCount,
          edgeCount: summary.edgeCount,
          assetCount: summary.assetCount,
          missingAssetCount: service.missingAssetIdsForWorkflow(summary.id).length,
          health: summary.health,
        })),
        recoveries,
      };
    } catch {
      return {
        status: "unavailable" as const,
        message: "Workflow storage is unavailable.",
      };
    }
  });

  ipcMain.handle("imageWorkflows:get", async (event, value: unknown) => {
    const owner = rendererDocumentOwner(event, () => new Error("Untrusted workflow request."));
    const { workflowId } = parseCreateImagesGetWorkflowRequest(value);
    const service = createImagesService();
    try {
      await service.initialize();
      const workflow = await service.workflows.get(workflowId);
      if (owner.isDestroyed()) throw new Error("The renderer document is no longer active.");
      return workflow
        ? {
            status: "ready" as const,
            workflow,
            missingAssetIds: service.missingAssetIdsForWorkflow(workflow.id),
          }
        : { status: "not-found" as const };
    } catch (error) {
      if (error instanceof WorkflowManifestLoadError) {
        const recovery = recoveryView(await service.workflows.inspect(workflowId));
        return recovery.status === "unsafe"
          ? {
              status: "unsafe" as const,
              recovery,
              message: "This workflow belongs to an unsupported future schema.",
            }
          : { status: "recovery-required" as const, recovery };
      }
      return {
        status: "unavailable" as const,
        message: "Workflow storage is unavailable.",
      };
    }
  });

  ipcMain.handle("imageWorkflows:create", async (event, value: unknown) => {
    const owner = rendererDocumentOwner(event, () => new Error("Untrusted workflow request."));
    const input = parseCreateImagesCreateWorkflowRequest(value);
    if (!mutationAllowed(owner)) return mutationRateFailure();
    const now = new Date().toISOString();
    const workflowId = randomUUID();
    const workflow = createImagesWorkflowFromTemplate({
      template: input.template,
      workflowId,
      now,
      nextId: randomUUID,
      ...(input.title ? { title: input.title } : {}),
    });
    try {
      const saved = await createImagesService().mutateWorkflow(workflowId, [], () =>
        createImagesService().workflows.create(workflow, () => !owner.isDestroyed()),
      );
      return { status: "saved" as const, workflow: saved };
    } catch (error) {
      return mutationFailure(error);
    }
  });

  ipcMain.handle("imageWorkflows:importArchive", async (event, value: unknown) => {
    const owner = rendererDocumentOwner(event, () => new Error("Untrusted archive request."));
    parseCreateImagesImportArchiveRequest(value);
    if (!mutationAllowed(owner, 10)) {
      return {
        status: "unavailable" as const,
        message: "Too many workflow changes were requested. Wait a moment and try again.",
      } satisfies CreateImagesImportArchiveResult;
    }
    if (archiveDialogActive) {
      return {
        status: "unavailable" as const,
        message: "Another workflow archive dialog is open.",
      } satisfies CreateImagesImportArchiveResult;
    }
    const parent = BrowserWindow.fromWebContents(event.sender);
    if (!parent || parent.isDestroyed()) {
      return {
        status: "unavailable" as const,
        message: "The workflow archive picker is unavailable.",
      } satisfies CreateImagesImportArchiveResult;
    }
    archiveDialogActive = true;
    const service = createImagesService();
    try {
      await service.initialize();
      const picked = await dialog.showOpenDialog(parent, {
        properties: ["openFile"],
        filters: [{ name: "Aiden Image Workflow", extensions: ["aiden-images"] }],
      });
      if (picked.canceled || !picked.filePaths[0]) return { status: "canceled" as const };
      if (owner.isDestroyed()) {
        return { status: "unavailable" as const, message: "The workflow library was closed." };
      }
      const imported = await service.archives.importFromFile(
        picked.filePaths[0],
        () => !owner.isDestroyed(),
      );
      return { status: "imported" as const, ...imported };
    } catch (error) {
      return { status: "unavailable" as const, message: archiveFailureMessage(error) };
    } finally {
      archiveDialogActive = false;
    }
  });

  ipcMain.handle("imageWorkflows:importNodeBanana", async (event, value: unknown) => {
    const owner = rendererDocumentOwner(event, () => new Error("Untrusted compatibility import."));
    parseCreateImagesImportNodeBananaRequest(value);
    if (!mutationAllowed(owner, 10)) {
      return {
        status: "unavailable" as const,
        message: "Too many workflow changes were requested. Wait a moment and try again.",
      } satisfies CreateImagesImportNodeBananaResult;
    }
    if (archiveDialogActive) {
      return {
        status: "unavailable" as const,
        message: "Another workflow import or export dialog is open.",
      } satisfies CreateImagesImportNodeBananaResult;
    }
    const parent = BrowserWindow.fromWebContents(event.sender);
    if (!parent || parent.isDestroyed()) {
      return {
        status: "unavailable" as const,
        message: "The workflow compatibility picker is unavailable.",
      } satisfies CreateImagesImportNodeBananaResult;
    }
    archiveDialogActive = true;
    const service = createImagesService();
    try {
      await service.initialize();
      const picked = await dialog.showOpenDialog(parent, {
        properties: ["openFile"],
        filters: [{ name: "Node Banana Workflow", extensions: ["json"] }],
      });
      if (picked.canceled || !picked.filePaths[0]) return { status: "canceled" as const };
      if (owner.isDestroyed()) {
        return { status: "unavailable" as const, message: "The workflow library was closed." };
      }
      const imported = await service.nodeBananaImports.importFromFile(
        picked.filePaths[0],
        () => !owner.isDestroyed(),
      );
      return { status: "imported" as const, ...imported };
    } catch (error) {
      return {
        status: "unavailable" as const,
        message: nodeBananaImportFailureMessage(error),
      };
    } finally {
      archiveDialogActive = false;
    }
  });

  ipcMain.handle("imageWorkflows:exportArchive", async (event, value: unknown) => {
    const owner = rendererDocumentOwner(event, () => new Error("Untrusted archive request."));
    const input = parseCreateImagesExportArchiveRequest(value);
    if (!readAllowed(owner, 12)) {
      return {
        status: "unavailable" as const,
        message: "Too many workflow reads were requested. Wait a moment and try again.",
      } satisfies CreateImagesExportArchiveResult;
    }
    if (archiveDialogActive) {
      return {
        status: "unavailable" as const,
        message: "Another workflow archive dialog is open.",
      } satisfies CreateImagesExportArchiveResult;
    }
    const parent = BrowserWindow.fromWebContents(event.sender);
    if (!parent || parent.isDestroyed()) {
      return {
        status: "unavailable" as const,
        message: "The workflow archive dialog is unavailable.",
      } satisfies CreateImagesExportArchiveResult;
    }
    archiveDialogActive = true;
    const service = createImagesService();
    try {
      await service.initialize();
      const workflow = await service.workflows.get(input.workflowId);
      if (!workflow) return { status: "not-found" as const };
      if (workflow.revision !== input.expectedRevision) {
        return { status: "conflict" as const, currentRevision: workflow.revision };
      }
      const picked = await dialog.showSaveDialog(parent, {
        defaultPath: `${archiveBaseName(workflow.title)}.aiden-images`,
        filters: [{ name: "Aiden Image Workflow", extensions: ["aiden-images"] }],
        properties: ["createDirectory", "showOverwriteConfirmation"],
      });
      if (picked.canceled || !picked.filePath) return { status: "canceled" as const };
      if (owner.isDestroyed()) {
        return { status: "unavailable" as const, message: "The workflow library was closed." };
      }
      const exported = await service.archives.exportToFile({
        ...input,
        destination: picked.filePath,
      });
      shell.showItemInFolder(
        picked.filePath.endsWith(".aiden-images")
          ? picked.filePath
          : `${picked.filePath}.aiden-images`,
      );
      return { status: "exported" as const, ...exported };
    } catch (error) {
      if (
        error instanceof CreateImagesNativeArchiveError &&
        error.code === "archive_revision_conflict"
      ) {
        const current = await service.workflows.get(input.workflowId).catch(() => undefined);
        return {
          status: "conflict" as const,
          ...(current ? { currentRevision: current.revision } : {}),
        };
      }
      if (
        error instanceof CreateImagesNativeArchiveError &&
        error.code === "archive_workflow_missing"
      ) {
        return { status: "not-found" as const };
      }
      return { status: "unavailable" as const, message: archiveFailureMessage(error) };
    } finally {
      archiveDialogActive = false;
    }
  });

  ipcMain.handle("imageWorkflows:save", async (event, value: unknown) => {
    const owner = rendererDocumentOwner(event, () => new Error("Untrusted workflow request."));
    const input = parseCreateImagesSaveWorkflowRequest(value);
    if (!mutationAllowed(owner)) return mutationRateFailure();
    try {
      const saved = await createImagesService().mutateWorkflow(
        input.workflow.id,
        input.workflow.assetRefs,
        () =>
          createImagesService().workflows.save(
            input.workflow,
            input.expectedRevision,
            () => !owner.isDestroyed(),
          ),
      );
      return { status: "saved" as const, workflow: saved };
    } catch (error) {
      return mutationFailure(error);
    }
  });

  ipcMain.handle("imageWorkflows:rename", async (event, value: unknown) => {
    const owner = rendererDocumentOwner(event, () => new Error("Untrusted workflow request."));
    const input = parseCreateImagesRenameWorkflowRequest(value);
    if (!mutationAllowed(owner)) return mutationRateFailure();
    try {
      const current = await createImagesService().workflows.get(input.workflowId);
      if (!current) return { status: "not-found" as const };
      const saved = await createImagesService().mutateWorkflow(
        input.workflowId,
        current.assetRefs,
        () =>
          createImagesService().workflows.rename(
            input.workflowId,
            input.title,
            input.expectedRevision,
            new Date().toISOString(),
            () => !owner.isDestroyed(),
          ),
      );
      return { status: "saved" as const, workflow: saved };
    } catch (error) {
      return mutationFailure(error);
    }
  });

  ipcMain.handle("imageWorkflows:duplicate", async (event, value: unknown) => {
    const owner = rendererDocumentOwner(event, () => new Error("Untrusted workflow request."));
    const input = parseCreateImagesDuplicateWorkflowRequest(value);
    if (!mutationAllowed(owner)) return mutationRateFailure();
    const service = createImagesService();
    try {
      const source = await service.workflows.get(input.workflowId);
      if (!source) return { status: "not-found" as const };
      const workflowId = randomUUID();
      const saved = await service.mutateWorkflow(
        workflowId,
        source.assetRefs,
        () =>
          service.workflows.duplicate(
            input.workflowId,
            {
              workflowId,
              expectedRevision: input.expectedRevision,
              ...(input.title ? { title: input.title } : {}),
              now: new Date().toISOString(),
            },
            () => !owner.isDestroyed(),
          ),
        { allowMissingAssetIds: source.assetRefs },
      );
      return { status: "saved" as const, workflow: saved };
    } catch (error) {
      return mutationFailure(error);
    }
  });

  ipcMain.handle("imageWorkflows:delete", async (event, value: unknown) => {
    const owner = rendererDocumentOwner(event, () => new Error("Untrusted workflow request."));
    const input = parseCreateImagesDeleteWorkflowRequest(value);
    if (!mutationAllowed(owner)) return mutationRateFailure();
    const service = createImagesService();
    try {
      return await service.deleteWorkflow(
        input.workflowId,
        input.expectedRevision,
        () => !owner.isDestroyed(),
      );
    } catch (error) {
      return mutationFailure(error);
    }
  });

  ipcMain.handle("imageWorkflows:recover", async (event, value: unknown) => {
    const owner = rendererDocumentOwner(event, () => new Error("Untrusted workflow request."));
    const input = parseCreateImagesRecoverWorkflowRequest(value);
    if (!mutationAllowed(owner)) return mutationRateFailure();
    const service = createImagesService();
    try {
      await service.initialize();
      const workflow = await service.workflows.recover(
        input.workflowId,
        input.source,
        input.expectedCandidateRevision,
        new Date().toISOString(),
        () => !owner.isDestroyed(),
      );
      await service.refreshReferenceAuthority();
      return { status: "saved" as const, workflow };
    } catch (error) {
      return mutationFailure(error);
    }
  });

  ipcMain.handle("imageWorkflows:repairRecoveryMetadata", async (event, value: unknown) => {
    const owner = rendererDocumentOwner(event, () => new Error("Untrusted workflow request."));
    const input = parseCreateImagesRepairWorkflowRequest(value);
    if (!mutationAllowed(owner)) return mutationRateFailure();
    const service = createImagesService();
    try {
      await service.initialize();
      const workflow = await service.workflows.repairRecoveryMetadata(
        input.workflowId,
        input.expectedRevision,
        () => !owner.isDestroyed(),
      );
      await service.refreshReferenceAuthority();
      return { status: "saved" as const, workflow };
    } catch (error) {
      return mutationFailure(error);
    }
  });

  ipcMain.handle("imageWorkflows:discardAutosave", async (event, value: unknown) => {
    const owner = rendererDocumentOwner(event, () => new Error("Untrusted workflow request."));
    const input = parseCreateImagesDiscardAutosaveRequest(value);
    if (!mutationAllowed(owner)) return mutationRateFailure();
    const service = createImagesService();
    try {
      await service.initialize();
      await service.workflows.discardAutosave(
        input.workflowId,
        input.expectedTargetRevision,
        () => !owner.isDestroyed(),
      );
      const workflow = await service.workflows.get(input.workflowId);
      if (!workflow) return { status: "not-found" as const };
      await service.refreshReferenceAuthority();
      return { status: "saved" as const, workflow };
    } catch (error) {
      return mutationFailure(error);
    }
  });

  ipcMain.handle("imageWorkflows:pickAsset", async (event, value: unknown) => {
    const owner = rendererDocumentOwner(event, () => new Error("Untrusted asset request."));
    const { workflowId } = parseCreateImagesPickAssetRequest(value);
    if (pickerActive)
      return {
        status: "unavailable" as const,
        message: "Another image picker is open.",
      };
    const parent = BrowserWindow.fromWebContents(event.sender);
    if (!parent || parent.isDestroyed()) {
      return {
        status: "unavailable" as const,
        message: "The image picker is unavailable.",
      };
    }
    pickerActive = true;
    const service = createImagesService();
    try {
      await service.initialize();
      const workflow = await service.workflows.get(workflowId);
      if (!workflow)
        return {
          status: "unavailable" as const,
          message: "The workflow no longer exists.",
        };
      const picked = await dialog.showOpenDialog(parent, {
        properties: ["openFile"],
      });
      if (picked.canceled || !picked.filePaths[0]) return { status: "canceled" as const };
      if (owner.isDestroyed())
        return {
          status: "unavailable" as const,
          message: "The workflow was closed.",
        };
      const filePath = picked.filePaths[0];
      const result = await ingestSelectedImage(service, filePath);
      service.noteAssetAvailable(result.asset.assetId);
      if (owner.isDestroyed())
        return {
          status: "unavailable" as const,
          message: "The workflow was closed.",
        };
      const grant = await service.grantAsset(owner, result.asset.assetId, () => true);
      return {
        status: "imported" as const,
        grant: grantView(grant, result.asset),
      };
    } catch (error) {
      reportAssetImportFailure(error);
      return {
        status: "unavailable" as const,
        message: assetImportFailureMessage(error),
      };
    } finally {
      pickerActive = false;
    }
  });

  ipcMain.handle(
    "imageWorkflows:pasteImage",
    async (event, value: unknown): Promise<CreateImagesPasteImageResult> => {
      const owner = rendererDocumentOwner(event, () => new Error("Untrusted asset request."));
      let input;
      try {
        input = parseCreateImagesPasteImageRequest(value);
      } catch {
        return {
          status: "unavailable",
          message: "The clipboard image request was invalid.",
        };
      }
      if (clipboardPasteActive) {
        return {
          status: "unavailable",
          message: "Another clipboard image import is already in progress.",
        };
      }
      if (!mutationAllowed(owner)) {
        return {
          status: "unavailable",
          message: "Too many image imports were requested. Wait a moment and try again.",
        };
      }
      clipboardPasteActive = true;
      const service = createImagesService();
      try {
        await service.initialize();
        const workflow = await service.workflows.get(input.workflowId);
        if (!workflow) {
          return { status: "unavailable", message: "The workflow no longer exists." };
        }
        const result = await ingestClipboardImage(service);
        if (!result) return { status: "no-image" };
        service.noteAssetAvailable(result.asset.assetId);
        if (owner.isDestroyed()) {
          return { status: "unavailable", message: "The workflow was closed." };
        }
        const grant = await service.grantAsset(owner, result.asset.assetId, () => true);
        return {
          status: "imported",
          grant: grantView(grant, result.asset),
        };
      } catch (error) {
        return {
          status: "unavailable",
          message: assetImportFailureMessage(error),
        };
      } finally {
        clipboardPasteActive = false;
      }
    },
  );

  ipcMain.handle("aiden:create-images:import-dropped-files", async (event, value: unknown) => {
    const owner = rendererDocumentOwner(event, () => new Error("Untrusted asset request."));
    let input;
    try {
      input = parseCreateImagesDroppedAssetImportRequest(value);
    } catch {
      return {
        status: "unavailable",
        message: "The dropped image request was invalid.",
      } satisfies CreateImagesDroppedAssetImportResult;
    }
    if (!input.filePaths.every((filePath) => path.isAbsolute(filePath))) {
      return {
        status: "unavailable",
        message: "Aiden could not access the dropped files.",
      } satisfies CreateImagesDroppedAssetImportResult;
    }
    if (!mutationAllowed(owner, input.filePaths.length)) {
      return {
        status: "unavailable",
        message: "Too many images were imported at once. Wait a moment and try again.",
      } satisfies CreateImagesDroppedAssetImportResult;
    }
    const bounded = await runBounded(
      owner.id,
      async (): Promise<CreateImagesDroppedAssetImportResult> => {
        const service = createImagesService();
        await service.initialize();
        const workflow = await service.workflows.get(input.workflowId);
        if (!workflow) {
          return { status: "unavailable", message: "The workflow no longer exists." };
        }
        const items: CreateImagesDroppedAssetImportItem[] = [];
        for (const filePath of input.filePaths) {
          if (owner.isDestroyed()) {
            return { status: "unavailable", message: "The workflow was closed." };
          }
          try {
            const result = await ingestSelectedImage(service, filePath);
            service.noteAssetAvailable(result.asset.assetId);
            const grant = await service.grantAsset(owner, result.asset.assetId, () => true);
            items.push({ status: "imported", grant: grantView(grant, result.asset) });
          } catch (error) {
            items.push({
              status: "unavailable",
              fileName: path.basename(filePath).slice(0, 255) || "Image",
              message: assetImportFailureMessage(error),
            });
          }
        }
        return { status: "completed", items };
      },
    );
    return bounded.status === "completed"
      ? bounded.value
      : ({
          status: "unavailable",
          message: "Image import is busy. Wait a moment and try again.",
        } satisfies CreateImagesDroppedAssetImportResult);
  });

  ipcMain.handle("imageWorkflows:grantAsset", async (event, value: unknown) => {
    const owner = rendererDocumentOwner(event, () => new Error("Untrusted asset request."));
    const input = parseCreateImagesGrantAssetRequest(value);
    const service = createImagesService();
    try {
      await service.initialize();
      if (!service.references.isWorkflowAssetReferenced(input.workflowId, input.assetId)) {
        return { status: "forbidden" as const };
      }
      const asset = await service.assets.getAvailable(input.assetId);
      if (!asset) {
        service.noteAssetMissing(input.assetId);
        return { status: "not-found" as const };
      }
      const grant = await service.grantAsset(owner, input.assetId, (assetId) =>
        service.references.isWorkflowAssetReferenced(input.workflowId, assetId),
      );
      return { status: "ready" as const, grant: grantView(grant, asset) };
    } catch (error) {
      if (
        error instanceof AssetStoreError &&
        (error.code === "asset_not_found" || error.code === "asset_source_missing")
      ) {
        service.noteAssetMissing(input.assetId);
        return { status: "not-found" as const };
      }
      return {
        status: "unavailable" as const,
        message: "The asset preview is unavailable.",
      };
    }
  });

  ipcMain.handle("imageWorkflows:revokeAssetGrant", (event, value: unknown) => {
    const owner = rendererDocumentOwner(event, () => new Error("Untrusted asset request."));
    const { token } = parseCreateImagesRevokeAssetGrantRequest(value);
    return createImagesService().grants.revoke(token, owner);
  });

  ipcMain.handle("imageWorkflows:prepareRun", async (event, value: unknown) => {
    const owner = rendererDocumentOwner(event, () => new Error("Untrusted run request."));
    const input = parseCreateImagesPrepareRunRequest(value);
    if (!mutationAllowed(owner, 2)) return prepareRunRateFailure();
    try {
      const bounded = await runBounded(owner.id, () =>
        createImagesService().runs.prepareGeminiRun({
          workflowId: input.workflowId,
          expectedRevision: input.expectedRevision,
          scope: input.scope,
        }),
      );
      if (bounded.status === "busy" || owner.isDestroyed()) return prepareRunRateFailure();
      return bounded.value;
    } catch {
      return {
        status: "unavailable" as const,
        message: "The Gemini run plan could not be prepared safely.",
      };
    }
  });

  ipcMain.handle("imageWorkflows:startRun", async (event, value: unknown) => {
    const owner = rendererDocumentOwner(event, () => new Error("Untrusted run request."));
    const input = parseCreateImagesStartRunRequest(value);
    if (!mutationAllowed(owner)) return runRateFailure();
    try {
      const bounded = await runBounded(owner.id, () =>
        createImagesService().runs.start(
          {
            workflowId: input.workflowId,
            expectedRevision: input.expectedRevision,
            scope: input.scope,
            executionMode: input.consent.executionMode,
            ...(input.consent.executionMode === "gemini"
              ? {
                  providerConsent: {
                    version: input.consent.version,
                    authorizationId: input.consent.authorizationId,
                    consentFingerprint: input.consent.consentFingerprint,
                    token: input.consent.token,
                    reviewed: true as const,
                  },
                }
              : {}),
          },
          () => !owner.isDestroyed(),
        ),
      );
      if (bounded.status === "busy") return runRateFailure();
      const result = bounded.value;
      if (result.status === "started") {
        bindRunToOwner(owner, input.workflowId, result.run.runId);
      }
      return result;
    } catch {
      return {
        status: "unavailable" as const,
        message: "The reviewed image run could not be started safely.",
      };
    }
  });

  ipcMain.handle("imageWorkflows:stopRun", async (event, value: unknown) => {
    const owner = rendererDocumentOwner(event, () => new Error("Untrusted run request."));
    const input = parseCreateImagesStopRunRequest(value);
    if (!mutationAllowed(owner, 2)) return runRateFailure();
    try {
      const bounded = await runBounded(owner.id, () =>
        createImagesService().runs.stop(input.workflowId, input.runId, "user"),
      );
      return bounded.status === "completed" ? bounded.value : runRateFailure();
    } catch {
      return {
        status: "unavailable" as const,
        message: "The stop request could not be recorded safely.",
      };
    }
  });

  ipcMain.handle("imageWorkflows:resolveRunAmbiguity", async (event, value: unknown) => {
    const owner = rendererDocumentOwner(event, () => new Error("Untrusted run request."));
    const input = parseCreateImagesResolveRunAmbiguityRequest(value);
    if (!mutationAllowed(owner, 2)) return runRateFailure();
    try {
      const bounded = await runBounded(owner.id, () =>
        createImagesService().runs.resolveRunAmbiguity(input),
      );
      return bounded.status === "completed" ? bounded.value : runRateFailure();
    } catch {
      return {
        status: "unavailable" as const,
        message: "The unresolved submission acknowledgement could not be recorded safely.",
      };
    }
  });

  ipcMain.handle("imageWorkflows:planDegradedRunDiscard", async (event, value: unknown) => {
    const owner = rendererDocumentOwner(event, () => new Error("Untrusted run request."));
    const input = parseCreateImagesPlanDegradedRunDiscardRequest(value);
    if (!readAllowed(owner, 12)) return runReadRateFailure(owner);
    try {
      const bounded = await runBounded(owner.id, () =>
        createImagesService().runs.planDegradedRunDiscard(input.runId),
      );
      return bounded.status === "completed" ? bounded.value : runReadRateFailure(owner);
    } catch {
      return {
        status: "unavailable" as const,
        message: "The damaged run discard plan is unavailable.",
      };
    }
  });

  ipcMain.handle("imageWorkflows:discardDegradedRun", async (event, value: unknown) => {
    const owner = rendererDocumentOwner(event, () => new Error("Untrusted run request."));
    const input = parseCreateImagesDiscardDegradedRunRequest(value);
    if (!mutationAllowed(owner, 20)) return runRateFailure();
    try {
      const bounded = await runBounded(owner.id, () =>
        createImagesService().runs.discardDegradedRun(input),
      );
      return bounded.status === "completed" ? bounded.value : runRateFailure();
    } catch {
      return {
        status: "unavailable" as const,
        message: "The damaged run record could not be discarded safely.",
      };
    }
  });

  ipcMain.handle("imageWorkflows:listRuns", async (event, value: unknown) => {
    const owner = rendererDocumentOwner(event, () => new Error("Untrusted run request."));
    const { workflowId } = parseCreateImagesListRunsRequest(value);
    if (!readAllowed(owner, 12)) return runReadRateFailure(owner);
    try {
      const bounded = await runBounded(owner.id, async () => {
        const service = createImagesService();
        await service.initialize();
        if (!(await service.workflows.get(workflowId))) return { status: "not-found" as const };
        return service.runs.list(workflowId);
      });
      if (bounded.status === "busy") return runReadRateFailure(owner);
      const result = bounded.value;
      if (owner.isDestroyed()) throw new Error("The renderer document is no longer active.");
      return result;
    } catch {
      return {
        status: "unavailable" as const,
        message: "Local run history is unavailable.",
      };
    }
  });

  ipcMain.handle("imageWorkflows:subscribeRuns", async (event, value: unknown) => {
    const owner = rendererDocumentOwner(event, () => new Error("Untrusted run request."));
    const { workflowId } = parseCreateImagesSubscribeRunsRequest(value);
    if (!readAllowed(owner, 12)) return runReadRateFailure(owner);
    const service = createImagesService();
    try {
      await service.initialize();
      if (!(await service.workflows.get(workflowId))) return { status: "not-found" as const };
      if (owner.isDestroyed()) throw new Error("The renderer document is no longer active.");
      if (runSubscriptions.size >= 128) {
        return {
          status: "unavailable" as const,
          message: "Too many run subscriptions are open.",
        };
      }
      const subscriptionId = randomUUID();
      let live = true;
      let releaseInvalidation: () => void = () => undefined;
      const release = (): void => {
        if (!live) return;
        live = false;
        releaseInvalidation();
        runSubscriptions.delete(subscriptionId);
      };
      releaseInvalidation = owner.onInvalidated(release);
      if (!live || owner.isDestroyed()) {
        release();
        throw new Error("The renderer document is no longer active.");
      }
      runSubscriptions.set(subscriptionId, {
        workflowId,
        ownerId: owner.id,
        documentId: owner.documentId,
        streamSequence: 0,
        send: (payload) => owner.send("imageWorkflows:run-changed", payload),
        release,
      });
      ensureRunListener();
      // The subscription is live before this initial read begins. Any durable
      // change in the gap is delivered with a higher stream sequence and the
      // renderer applies it after this baseline snapshot.
      try {
        const bounded = await runBounded(owner.id, () => service.runs.list(workflowId));
        if (bounded.status === "busy") {
          runSubscriptions.get(subscriptionId)?.release();
          return runReadRateFailure(owner);
        }
        const snapshot = bounded.value;
        return {
          status: "ready" as const,
          subscriptionId,
          streamSequence: 0,
          snapshot,
        };
      } catch (error) {
        runSubscriptions.get(subscriptionId)?.release();
        throw error;
      }
    } catch {
      return {
        status: "unavailable" as const,
        message: "Run updates are unavailable.",
      };
    }
  });

  ipcMain.handle("imageWorkflows:getRun", async (event, value: unknown) => {
    const owner = rendererDocumentOwner(event, () => new Error("Untrusted run request."));
    const input = parseCreateImagesGetRunRequest(value);
    if (!readAllowed(owner, 3)) return runReadRateFailure(owner);
    const service = createImagesService();
    try {
      await service.initialize();
      if (!(await service.workflows.get(input.workflowId))) return { status: "not-found" as const };
      const bounded = await runBounded(owner.id, () =>
        service.runs.get(input.workflowId, input.runId),
      );
      if (bounded.status === "busy") return runReadRateFailure(owner);
      const result = bounded.value;
      if (owner.isDestroyed()) throw new Error("The renderer document is no longer active.");
      return result;
    } catch {
      return {
        status: "unavailable" as const,
        message: "The durable run record is unavailable.",
      };
    }
  });

  ipcMain.handle("imageWorkflows:recoverRun", async (event, value: unknown) => {
    const owner = rendererDocumentOwner(event, () => new Error("Untrusted run request."));
    const input = parseCreateImagesRecoverRunRequest(value);
    if (!mutationAllowed(owner)) return runRateFailure();
    const service = createImagesService();
    try {
      const bounded = await runBounded(owner.id, async () => {
        await service.initialize();
        if (!(await service.workflows.get(input.workflowId))) {
          return { status: "not-found" as const };
        }
        return service.runs.recover(
          input.workflowId,
          input.runId,
          input.source,
          input.expectedCandidateJournalRevision,
        );
      });
      return bounded.status === "completed" ? bounded.value : runRateFailure();
    } catch {
      return {
        status: "unavailable" as const,
        message: "The run record could not be recovered safely.",
      };
    }
  });

  ipcMain.handle("imageWorkflows:planRunHistoryPrune", async (event, value: unknown) => {
    const owner = rendererDocumentOwner(event, () => new Error("Untrusted run request."));
    const input = parseCreateImagesPlanRunHistoryPruneRequest(value);
    if (!readAllowed(owner, 12)) return runReadRateFailure(owner);
    try {
      const bounded = await runBounded(owner.id, () =>
        createImagesService().runs.planHistoryPrune(input.keepLatest),
      );
      return bounded.status === "completed" ? bounded.value : runReadRateFailure(owner);
    } catch {
      return {
        status: "unavailable" as const,
        message: "The run history cleanup plan is unavailable.",
      };
    }
  });

  ipcMain.handle("imageWorkflows:pruneRunHistory", async (event, value: unknown) => {
    const owner = rendererDocumentOwner(event, () => new Error("Untrusted run request."));
    const input = parseCreateImagesPruneRunHistoryRequest(value);
    if (!mutationAllowed(owner, 20)) return runRateFailure();
    try {
      const bounded = await runBounded(owner.id, () =>
        createImagesService().runs.pruneHistory(input.keepLatest, input.authorizationToken),
      );
      return bounded.status === "completed" ? bounded.value : runRateFailure();
    } catch {
      return {
        status: "unavailable" as const,
        message: "Run history could not be pruned safely.",
      };
    }
  });

  ipcMain.handle("imageWorkflows:unsubscribeRuns", (event, value: unknown) => {
    const owner = rendererDocumentOwner(event, () => new Error("Untrusted run request."));
    const { subscriptionId } = parseCreateImagesUnsubscribeRunsRequest(value);
    const subscription = runSubscriptions.get(subscriptionId);
    if (
      !subscription ||
      subscription.ownerId !== owner.id ||
      subscription.documentId !== owner.documentId
    ) {
      return false;
    }
    subscription.release();
    return true;
  });

  ipcMain.handle("imageWorkflows:grantRunAsset", async (event, value: unknown) => {
    const owner = rendererDocumentOwner(event, () => new Error("Untrusted run asset request."));
    const input = parseCreateImagesGrantRunAssetRequest(value);
    if (!readAllowed(owner, 3)) return runReadRateFailure(owner);
    const service = createImagesService();
    try {
      const bounded = await runBounded(owner.id, async () => {
        await service.initialize();
        if (
          !(await service.runs.isRunAssetReferenced(
            input.workflowId,
            input.runId,
            input.assetId,
          )) ||
          !service.references.isRunAssetReferenced(input.runId, input.assetId)
        ) {
          return { status: "forbidden" as const };
        }
        const asset = await service.assets.getAvailable(input.assetId);
        if (!asset) return { status: "not-found" as const };
        const grant = await service.grantAsset(owner, input.assetId, (assetId) =>
          service.references.isRunAssetReferenced(input.runId, assetId),
        );
        return { status: "ready" as const, grant: grantView(grant, asset) };
      });
      return bounded.status === "completed" ? bounded.value : runReadRateFailure(owner);
    } catch (error) {
      if (
        error instanceof AssetStoreError &&
        (error.code === "asset_not_found" || error.code === "asset_source_missing")
      ) {
        return { status: "not-found" as const };
      }
      return {
        status: "unavailable" as const,
        message: "The run output is unavailable.",
      };
    }
  });

  ipcMain.handle("imageWorkflows:downloadRunAsset", async (event, value: unknown) => {
    const owner = rendererDocumentOwner(event, () => new Error("Untrusted run asset request."));
    const input = parseCreateImagesDownloadRunAssetRequest(value);
    if (!readAllowed(owner, 8)) {
      return {
        status: "unavailable" as const,
        message: "Too many image export requests were made. Wait a moment and try again.",
      } satisfies CreateImagesDownloadRunAssetResult;
    }
    if (archiveDialogActive) {
      return {
        status: "unavailable" as const,
        message: "Another image or workflow save dialog is open.",
      } satisfies CreateImagesDownloadRunAssetResult;
    }
    const parent = BrowserWindow.fromWebContents(event.sender);
    if (!parent || parent.isDestroyed()) {
      return {
        status: "unavailable" as const,
        message: "The image save dialog is unavailable.",
      } satisfies CreateImagesDownloadRunAssetResult;
    }
    archiveDialogActive = true;
    const service = createImagesService();
    try {
      await service.initialize();
      const authorized =
        (await service.runs.isRunAssetReferenced(input.workflowId, input.runId, input.assetId)) &&
        service.references.isRunAssetReferenced(input.runId, input.assetId);
      if (!authorized) return { status: "forbidden" as const };
      const asset = await service.assets.getAvailable(input.assetId);
      if (!asset) return { status: "not-found" as const };
      const extension = asset.mediaType === "image/png" ? "png" : "jpg";
      const picked = await dialog.showSaveDialog(parent, {
        defaultPath: `Aiden image ${input.assetId.slice(0, 8)}.${extension}`,
        filters: [
          {
            name: asset.mediaType === "image/png" ? "PNG Image" : "JPEG Image",
            extensions: [extension],
          },
        ],
        properties: ["createDirectory", "showOverwriteConfirmation"],
      });
      if (picked.canceled || !picked.filePath) return { status: "canceled" as const };
      if (owner.isDestroyed()) {
        return { status: "unavailable" as const, message: "The workflow was closed." };
      }
      if (
        !(await service.runs.isRunAssetReferenced(input.workflowId, input.runId, input.assetId)) ||
        !service.references.isRunAssetReferenced(input.runId, input.assetId)
      ) {
        return { status: "forbidden" as const };
      }
      await service.assets.exportAssetToFile(input.assetId, picked.filePath);
      shell.showItemInFolder(picked.filePath);
      return { status: "saved" as const, fileName: path.basename(picked.filePath) };
    } catch (error) {
      if (
        error instanceof AssetStoreError &&
        (error.code === "asset_not_found" || error.code === "asset_source_missing")
      ) {
        return { status: "not-found" as const };
      }
      return {
        status: "unavailable" as const,
        message: "Aiden could not save this retained image.",
      };
    } finally {
      archiveDialogActive = false;
    }
  });

  ipcMain.handle("imageWorkflows:planAssetCleanup", async (event, value: unknown) => {
    const owner = rendererDocumentOwner(event, () => new Error("Untrusted storage request."));
    parseCreateImagesPlanAssetCleanupRequest(value);
    if (!readAllowed(owner, 12)) {
      return {
        status: "unavailable" as const,
        message: "Too many storage requests were made. Wait a moment and try again.",
      } satisfies CreateImagesAssetCleanupPlanResult;
    }
    try {
      const bounded = await runBounded(owner.id, async () => {
        const service = createImagesService();
        await service.initialize();
        const plan = await service.assets.planGarbageCollection(
          CREATE_IMAGES_ASSET_CLEANUP_GRACE_MS,
        );
        if (plan.candidateAssetIds.length === 0) return { status: "empty" as const };
        return {
          status: "ready" as const,
          planId: plan.planId,
          candidateCount: plan.candidateAssetIds.length,
          reclaimableBytes: plan.reclaimableBytes,
          expiresAt: plan.expiresAt,
        };
      });
      return bounded.status === "completed"
        ? bounded.value
        : {
            status: "unavailable" as const,
            message: "Storage cleanup is busy. Try again in a moment.",
          };
    } catch {
      return {
        status: "unavailable" as const,
        message: "Aiden could not safely plan unused image cleanup.",
      };
    }
  });

  ipcMain.handle("imageWorkflows:applyAssetCleanup", async (event, value: unknown) => {
    const owner = rendererDocumentOwner(event, () => new Error("Untrusted storage request."));
    const input = parseCreateImagesApplyAssetCleanupRequest(value);
    if (!mutationAllowed(owner, 10)) {
      return {
        status: "unavailable" as const,
        message: "Too many storage changes were requested. Wait a moment and try again.",
      } satisfies CreateImagesAssetCleanupResult;
    }
    try {
      const bounded = await runBounded(owner.id, async () => {
        const service = createImagesService();
        await service.initialize();
        const result = await service.assets.applyGarbageCollection(input.planId);
        if (result.stale || !result.applied) return { status: "stale" as const };
        return {
          status: "cleaned" as const,
          deletedCount: result.deletedAssetIds.length,
          reclaimedBytes: result.reclaimedBytes,
          skippedCount: result.skipped.length,
        };
      });
      return bounded.status === "completed"
        ? bounded.value
        : {
            status: "unavailable" as const,
            message: "Storage cleanup is busy. Try again in a moment.",
          };
    } catch {
      return {
        status: "unavailable" as const,
        message: "Aiden did not delete any images because storage cleanup could not be verified.",
      };
    }
  });

  ipcMain.handle("imageWorkflows:storageHealth", async (event) => {
    const owner = rendererDocumentOwner(event, () => new Error("Untrusted storage request."));
    if (!readAllowed(owner, 12)) {
      throw new Error("Too many storage health requests were made. Wait a moment and try again.");
    }
    const bounded = await runBounded(owner.id, async () => {
      const service = createImagesService();
      await service.initializeReadOnlyLibrary();
      const [workflows, status, assets, runIndex] = await Promise.all([
        service.workflows.list(),
        service.assets.status(),
        service.assets.list(),
        service.runs.journals.indexHealth(),
      ]);
      const degradedInventory = await Promise.all([
        service.runs.journals.degradedRuns(100),
        service.runs.journals.degradedRunCount(),
      ]).then(
        ([records, count]) => ({ records, count, unavailable: false }),
        () => ({ records: [], count: 0, unavailable: true }),
      );
      const degradedRecords = degradedInventory.records.map((record) => {
        const workflowId =
          "workflowId" in record && typeof record.workflowId === "string"
            ? record.workflowId
            : undefined;
        return {
          runId: record.runId,
          association: workflowId ? ("workflow" as const) : ("unassociated" as const),
          ...(workflowId ? { workflowId } : {}),
          status: record.status,
          reason: record.reason,
          discardEligible:
            record.status === "unsafe" ||
            (record.status === "recovery-required" && record.canRecover === false),
        };
      });
      const degradedDetails = {
        degradedRecordCount: degradedInventory.count,
        degradedRecordsTruncated:
          degradedInventory.unavailable || degradedInventory.count > degradedRecords.length,
        degradedRecords,
      };
      if (owner.isDestroyed()) throw new Error("The renderer document is no longer active.");
      return {
        workflowCount: workflows.length,
        assetCount: status.assetCount,
        assetBytes: status.totalAssetBytes,
        recoverableWorkflowCount: workflows.filter((workflow) => workflow.recoveryAvailable).length,
        orphanAssetCount: assets.filter((asset) => asset.referenceCount === 0).length,
        missingAssetCount: service.missingAssetCount(),
        runIndex:
          runIndex.status === "healthy"
            ? {
                status:
                  runIndex.diagnostic === "rebuilt-corrupt-index"
                    ? ("recovered" as const)
                    : ("healthy" as const),
                entryCount: runIndex.entryCount,
                ...(runIndex.quarantinedIndexCount === undefined
                  ? {}
                  : { quarantinedIndexCount: runIndex.quarantinedIndexCount }),
                ...degradedDetails,
              }
            : {
                status:
                  runIndex.status === "unsafe" ? ("unsafe" as const) : ("needs-attention" as const),
                ...degradedDetails,
              },
      };
    });
    if (bounded.status === "busy") {
      throw new Error("Device-local storage health is busy. Wait a moment and try again.");
    }
    return bounded.value;
  });
}
