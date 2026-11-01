// Create Images IPC. Every handler checks its renderer document first, parses
// an exact request shape second, and only then touches a store.
import * as fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  GALLERY_MAX_ITEMS,
  IMAGE_IMPORT_MAX_BYTES,
  type GalleryResponse,
  type ImageActionRequest,
  type ImageActionResponse,
  type ImportImageResponse,
} from "../../../renderer/shared/images/ipc-types.js";
import { pickDefaultImageModel } from "../../../renderer/shared/images/port.js";
import type { ImageMediaType, OutputRef } from "../../../renderer/shared/images/run-types.js";
import { selectGalleryImages, toGalleryItems } from "../../services/create-images/gallery-core.js";
import { CreateImagesExportUnavailableError, writeUniqueFile } from "../../services/create-images/image-export.js";
import type { CreateImagesServices } from "../../services/create-images/runtime.js";
import type { StudioAssetGrantOwner, StudioAssetGrants } from "../../services/studio-assets/delivery-core.js";
import {
  parseConsentRequest,
  parseCreateRequest,
  parseEmptyRequest,
  parseGalleryRequest,
  parseGetRunRequest,
  parseImageActionRequest,
  parseImportRequest,
  parseListRunsRequest,
  parseMutateRequest,
  parsePrepareRequest,
  parseRunRequest,
  parseSaveRequest,
  parseWorkflowRequest,
} from "./parse.js";

export interface CreateImagesOwner {
  /** `${webContentsId}:${documentId}`: consents are bound to exactly this document. */
  key: string;
  grants: StudioAssetGrantOwner;
}

export interface CreateImagesHandlerDependencies<Event> {
  enabled: boolean;
  handle(channel: string, listener: (event: Event, input: unknown) => unknown): void;
  owner(event: Event): CreateImagesOwner;
  /** May open storage again after an earlier failure, so it can be asynchronous. */
  services(): CreateImagesServices | Promise<CreateImagesServices>;
  grants: Pick<StudioAssetGrants, "issue">;
  pickImage(event: Event): Promise<Uint8Array | null>;
  files: CreateImagesFileActions<Event>;
}

/** The Electron side of image actions: dialogs, clipboard, file manager and native drag. */
export interface CreateImagesFileActions<Event> {
  /** A Save dialog; the chosen path, or null when cancelled. Overwrite is confirmed by the dialog. */
  chooseSavePath(event: Event, options: { defaultPath: string; mediaType: ImageMediaType }): Promise<string | null>;
  /** Where Save and Save All dialogs open: the person's Downloads folder. */
  downloadsFolder(): string;
  /** A folder picker; the chosen folder, or null when cancelled. */
  chooseFolder(event: Event, options: { defaultPath: string }): Promise<string | null>;
  /** Puts the image on the clipboard; false when the bytes cannot be decoded (some WebP). */
  copyImage(bytes: Uint8Array): boolean;
  showItemInFolder(file: string): void;
  openFolder(folder: string): Promise<void>;
  /** Starts a native drag of the file out of the sender's window. */
  startDrag(event: Event, file: string): void;
}

const ACTION_FAILED = "Aiden couldn't finish that image action.";

/** Longest a gallery read waits for background auto-saves before answering. */
const GALLERY_AUTO_SAVE_WAIT_MS = 2_000;

/** Most saves this session remembers for "Show in Finder" after Save… or Save All. */
const SAVED_TARGETS_MAX = 50;

/**
 * What Save… and Save All wrote, by an opaque id the renderer gets back, so a toast can show
 * the file or folder without a path crossing IPC. Session-only and bounded.
 */
class SavedTargets {
  private readonly targets = new Map<string, { kind: "file" | "folder"; path: string }>();

  remember(kind: "file" | "folder", target: string): string {
    const savedId = randomUUID();
    this.targets.set(savedId, { kind, path: target });
    for (const oldest of this.targets.keys()) {
      if (this.targets.size <= SAVED_TARGETS_MAX) break;
      this.targets.delete(oldest);
    }
    return savedId;
  }

  get(savedId: string): { kind: "file" | "folder"; path: string } | undefined {
    return this.targets.get(savedId);
  }
}

/** An image an action may touch: a Generate output the ledger knows, or an Image Input a workflow holds. */
interface AuthorizedImage {
  ref: Pick<OutputRef, "assetId" | "mediaType">;
  workflowTitle?: string;
}

const PICKED_IMAGE_REFUSED = "Choose a PNG, JPEG or WebP image of 8 MiB or less.";

/**
 * Reads a file the person picked, never more than the import limit: the size is checked on the
 * opened handle and the read itself is bounded, so a file swapped or grown after the check
 * cannot make Aiden read an unbounded amount.
 */
export async function readPickedImage(file: string, limit = IMAGE_IMPORT_MAX_BYTES): Promise<Uint8Array> {
  const handle = await fs.open(file, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) throw new Error(PICKED_IMAGE_REFUSED);
    const buffer = new Uint8Array(limit + 1);
    let length = 0;
    while (length < buffer.byteLength) {
      const { bytesRead } = await handle.read(buffer, length, buffer.byteLength - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > limit) throw new Error(PICKED_IMAGE_REFUSED);
    return buffer.slice(0, length);
  } finally {
    await handle.close();
  }
}

export function registerCreateImagesHandlers<Event>(deps: CreateImagesHandlerDependencies<Event>): number {
  if (!deps.enabled) return 0;
  let registered = 0;
  const handle = (channel: string, listener: (event: Event, input: unknown) => unknown) => {
    deps.handle(channel, listener);
    registered += 1;
  };
  const urls = (owner: CreateImagesOwner, assetIds: Iterable<string>): Record<string, string> => {
    const granted: Record<string, string> = {};
    for (const assetId of new Set(assetIds)) {
      try {
        granted[assetId] = deps.grants.issue(owner.grants, assetId, "thumb-512");
      } catch {
        // A collected or invalid asset simply has no URL; the UI shows its placeholder.
      }
    }
    return granted;
  };

  handle("imageWorkflows:list", async (event, input) => {
    deps.owner(event);
    parseEmptyRequest(input);
    const { workflows, coordinator } = await deps.services();
    return { workflows: workflows.list(), imageCounts: await coordinator.imageCounts() };
  });

  handle("imageWorkflows:create", async (event, input) => {
    deps.owner(event);
    const request = parseCreateRequest(input);
    const services = await deps.services();
    const model = pickDefaultImageModel(await services.port.listModels());
    const workflow = await services.workflows.create(request.template, {
      ...(request.title !== undefined ? { title: request.title } : {}),
      ...(model ? { model } : {}),
    });
    return { workflow };
  });

  handle("imageWorkflows:get", async (event, input) => {
    const owner = deps.owner(event);
    const { workflowId } = parseWorkflowRequest(input);
    const services = await deps.services();
    const workflow = await services.workflows.get(workflowId);
    if (!workflow) throw new Error("This workflow no longer exists.");
    const latestOutputs = services.coordinator.latestOutputs(workflowId);
    const assetIds = [
      ...workflow.nodes.flatMap((node) => (node.type === "image-input" && node.data.assetId ? [node.data.assetId] : [])),
      ...Object.values(latestOutputs).flatMap((refs) => refs.map((ref) => ref.assetId)),
    ];
    return { workflow, latestOutputs, staleNodeIds: services.coordinator.staleNodeIds(workflow), assetUrls: urls(owner, assetIds) };
  });

  handle("imageWorkflows:save", async (event, input) => {
    deps.owner(event);
    const request = parseSaveRequest(input);
    return (await deps.services()).workflows.save(request.workflowId, request.baseRevision, request.document);
  });

  handle("imageWorkflows:mutate", async (event, input) => {
    deps.owner(event);
    const request = parseMutateRequest(input);
    const { workflows, coordinator } = await deps.services();
    if (request.op === "rename") return { ok: (await workflows.rename(request.workflowId, request.title)).ok };
    if (request.op === "duplicate") {
      const copy = await workflows.duplicate(request.workflowId);
      return copy ? { ok: true, workflowId: copy.id } : { ok: false };
    }
    // Refused while a run is starting or running; the coordinator also clears the workflow's run history and image holds.
    const outcome = await coordinator.deleteWorkflow(request.workflowId);
    return outcome === "deleted" ? { ok: true } : { ok: false, reason: outcome };
  });

  handle("imageWorkflows:list-models", async (event, input) => {
    deps.owner(event);
    parseEmptyRequest(input);
    const { port } = await deps.services();
    return { models: await port.listModels() };
  });

  handle("imageWorkflows:import-image", async (event, input): Promise<ImportImageResponse> => {
    const owner = deps.owner(event);
    const request = parseImportRequest(input);
    const bytes = request.source === "dialog" ? await deps.pickImage(event) : request.data;
    if (!bytes) return { cancelled: true };
    if (bytes.byteLength > IMAGE_IMPORT_MAX_BYTES) throw new Error("Choose an image of 8 MiB or less.");
    // The store sniffs the content; a declared type must agree with it.
    const { assets } = await deps.services();
    const record = await assets.put({
      bytes,
      ...(request.source === "bytes" ? { declaredMimeType: request.mimeType } : {}),
    });
    return {
      assetId: record.assetId,
      mimeType: record.mediaType,
      width: record.width,
      height: record.height,
      bytes: record.bytes,
      url: deps.grants.issue(owner.grants, record.assetId, "thumb-512"),
    };
  });

  handle("imageWorkflows:prepare-run", async (event, input) => {
    const owner = deps.owner(event);
    return (await deps.services()).coordinator.prepare(owner.key, parsePrepareRequest(input));
  });

  handle("imageWorkflows:start-run", async (event, input) => {
    const owner = deps.owner(event);
    return (await deps.services()).coordinator.start(owner.key, parseConsentRequest(input).consentId);
  });

  handle("imageWorkflows:cancel-run", async (event, input) => {
    // Any Aiden document may stop any run (ADR-CI, Cancel): stopping only reduces spend, and a
    // reloaded or second Images window has a new document id yet must still be able to stop it.
    deps.owner(event);
    return { ok: (await deps.services()).coordinator.cancel(parseRunRequest(input).runId) };
  });

  handle("imageWorkflows:get-run", async (event, input) => {
    const owner = deps.owner(event);
    const snapshot = (await deps.services()).coordinator.getRun(parseGetRunRequest(input));
    const assetIds = snapshot ? snapshot.attempts.flatMap((attempt) => attempt.output.map((ref) => ref.assetId)) : [];
    return { snapshot, assetUrls: urls(owner, assetIds) };
  });

  handle("imageWorkflows:list-runs", async (event, input) => {
    deps.owner(event);
    const request = parseListRunsRequest(input);
    return { runs: (await deps.services()).coordinator.listRuns(request.workflowId, request.limit) };
  });

  handle("imageWorkflows:gallery", async (event, input): Promise<GalleryResponse> => {
    const owner = deps.owner(event);
    const request = parseGalleryRequest(input);
    const { coordinator, workflows, assets, exports } = await deps.services();
    // A run's images are auto-saved in the background after it ends, and renderers re-read the
    // gallery the moment it ends; wait briefly for those local writes so `saved` is not stale.
    await exports.whenIdle(GALLERY_AUTO_SAVE_WAIT_MS);
    const titles = new Map(workflows.list().map((entry) => [entry.id, entry.title]));
    const images = selectGalleryImages(coordinator.generatedAttempts(request.workflowId, GALLERY_MAX_ITEMS), {
      exists: (assetId) => assets.get(assetId) !== undefined,
    });
    const assetIds = images.map((image) => image.ref.assetId);
    const saved = await exports.savedAssetIds(assetIds);
    const thumbs = new Map(Object.entries(urls(owner, assetIds)));
    return {
      items: toGalleryItems(images, {
        workflowTitle: (workflowId) => titles.get(workflowId),
        nodeTitle: (workflowId, nodeId) => workflows.generateNodeTitle(workflowId, nodeId),
        saved,
        thumbUrl: (assetId) => thumbs.get(assetId),
      }),
      saveFolderLabel: exports.folderLabel,
    };
  });

  const saved = new SavedTargets();
  handle("imageWorkflows:image-action", async (event, input): Promise<ImageActionResponse> => {
    const owner = deps.owner(event);
    const request = parseImageActionRequest(input);
    const services = await deps.services();
    try {
      return await imageAction(deps, event, owner, request, services, saved);
    } catch (error) {
      if (error instanceof CreateImagesExportUnavailableError) return { ok: false, reason: "unsupported", message: error.message };
      // File system details (paths, titles) stay in main.
      return { ok: false, reason: "failed", message: ACTION_FAILED };
    }
  });

  return registered;
}

function authorizeImage(services: CreateImagesServices, assetId: string): AuthorizedImage | undefined {
  return authorizeImages(services, [assetId])[0];
}

/**
 * Authorizes every asset in one pass over the ledger, in order; an entry is undefined for an
 * asset an action may not touch.
 */
function authorizeImages(services: CreateImagesServices, assetIds: readonly string[]): (AuthorizedImage | undefined)[] {
  const records = new Map(assetIds.flatMap((assetId) => {
    const record = services.assets.get(assetId);
    return record ? [[assetId, record] as const] : [];
  }));
  // One asset (view, copy, reveal) takes the ledger's targeted lookup; Save All takes one pass.
  const [only] = records.keys();
  let generated: ReadonlyMap<string, { attempt: { workflowId: string } }>;
  if (records.size === 1 && only !== undefined) {
    const found = services.coordinator.generatedAsset(only);
    generated = new Map(found ? [[only, found]] : []);
  } else {
    generated = services.coordinator.generatedAssets(records.keys());
  }
  let titles: Map<string, string> | undefined;
  const title = (workflowId: string) => (titles ??= new Map(services.workflows.list().map((entry) => [entry.id, entry.title]))).get(workflowId);
  return assetIds.map((assetId) => {
    const record = records.get(assetId);
    if (!record) return undefined;
    const workflowId =
      generated.get(assetId)?.attempt.workflowId ?? services.assets.holders(assetId).find((holder) => holder.kind === "images-workflow")?.id;
    if (workflowId === undefined) return undefined;
    const workflowTitle = title(workflowId);
    return { ref: { assetId, mediaType: record.mediaType }, ...(workflowTitle !== undefined ? { workflowTitle } : {}) };
  });
}

async function imageAction<Event>(
  deps: CreateImagesHandlerDependencies<Event>,
  event: Event,
  owner: CreateImagesOwner,
  request: ImageActionRequest,
  services: CreateImagesServices,
  saved: SavedTargets,
): Promise<ImageActionResponse> {
  const { exports, assets } = services;
  const fileSystem = exports.fileSystem();
  if (request.op === "reveal-folder") {
    const folder = exports.folder();
    await fileSystem.mkdir(folder, { recursive: true });
    await deps.files.openFolder(folder);
    return { ok: true };
  }
  if (request.op === "reveal-saved") {
    const target = saved.get(request.savedId);
    if (!target) return { ok: false, reason: "not-found" };
    if (target.kind === "file") deps.files.showItemInFolder(target.path);
    else await deps.files.openFolder(target.path);
    return { ok: true };
  }
  if (request.op === "save-all") {
    // Strict: one unknown image refuses the whole request before any dialog opens.
    const authorized = authorizeImages(services, [...new Set(request.assetIds)]);
    const images = authorized.filter((image): image is AuthorizedImage => image !== undefined);
    if (images.length !== authorized.length) return { ok: false, reason: "not-found" };
    const folder = await deps.files.chooseFolder(event, { defaultPath: deps.files.downloadsFolder() });
    if (!folder) return { ok: false, reason: "cancelled" };
    let count = 0;
    for (const image of images) {
      try {
        const { bytes } = await assets.read(image.ref.assetId);
        await writeUniqueFile(fileSystem, folder, exports.target(image.ref, image.workflowTitle).fileName, bytes);
        count += 1;
      } catch {
        // Counted below; one unreadable image does not stop the rest.
      }
    }
    if (count === images.length) return { ok: true, count, savedId: saved.remember("folder", folder) };
    // Some files were written: the folder can still be shown.
    return {
      ok: false,
      reason: "failed",
      message: `Aiden saved ${count} of ${images.length} images.`,
      ...(count > 0 ? { savedId: saved.remember("folder", folder) } : {}),
    };
  }
  const image = authorizeImage(services, request.assetId);
  if (!image) return { ok: false, reason: "not-found" };
  switch (request.op) {
    case "view":
      return { ok: true, url: deps.grants.issue(owner.grants, image.ref.assetId, "original") };
    case "copy": {
      const { bytes } = await assets.read(image.ref.assetId);
      return deps.files.copyImage(bytes) ? { ok: true } : { ok: false, reason: "unsupported", message: "This image can't be copied." };
    }
    case "reveal":
      deps.files.showItemInFolder(await exports.ensureExported(image.ref, image.workflowTitle));
      return { ok: true };
    case "drag":
      deps.files.startDrag(event, await exports.ensureExported(image.ref, image.workflowTitle));
      return { ok: true };
    case "save-as": {
      // Offer the auto-saved copy's name, in Downloads: saving beside the auto-saved copy would
      // only duplicate it (or ask to replace it with the same bytes).
      const autoSaved = await exports.savedPath(image.ref.assetId);
      const fileName = autoSaved ? path.basename(autoSaved) : exports.target(image.ref, image.workflowTitle).fileName;
      const chosen = await deps.files.chooseSavePath(event, {
        defaultPath: path.join(deps.files.downloadsFolder(), fileName),
        mediaType: image.ref.mediaType,
      });
      if (!chosen) return { ok: false, reason: "cancelled" };
      const { bytes } = await assets.read(image.ref.assetId);
      // The dialog already confirmed any overwrite.
      const handle = await fileSystem.open(chosen, "w", 0o644);
      try {
        await handle.writeFile(bytes);
      } finally {
        await handle.close();
      }
      return { ok: true, savedId: saved.remember("file", chosen) };
    }
  }
}
