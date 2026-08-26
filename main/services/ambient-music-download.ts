import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  copyFile,
  link,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  statfs,
  writeFile,
} from "node:fs/promises";
import https from "node:https";
import path from "node:path";
import { Readable } from "node:stream";

import type {
  AmbientMusicModelId,
  AmbientMusicModelStatus,
} from "../../renderer/shared/ambient-music.js";
import {
  ambientMusicAssetUrl,
  ambientMusicAssetsForModel,
  ambientMusicDiskBudget,
  type AmbientMusicAsset,
  type AmbientMusicAssetManifest,
  AmbientMusicDownloadError,
  type AmbientMusicPartialMetadata,
  ambientMusicModelDownloadBytes,
  ambientMusicRoleAssets,
  canResumeAmbientMusicPartial,
  parseAmbientMusicAssetManifest,
  parseAmbientMusicContentRange,
  resolveAmbientMusicOwnedPath,
  validateAmbientMusicRedirect,
  type AmbientMusicAssetRole,
} from "./ambient-music-download-core.js";
import type { AmbientMusicVerifiedInstall } from "./ambient-music-service.js";

const MAX_REDIRECTS = 5;

export interface AmbientMusicHttpResponse {
  statusCode: number;
  headers: Record<string, string | undefined>;
  body: Readable;
}

export interface AmbientMusicHttpClient {
  request(url: URL, headers: Record<string, string>, signal: AbortSignal): Promise<AmbientMusicHttpResponse>;
}

export interface AmbientMusicModelStoreOptions {
  root: string;
  manifest: AmbientMusicAssetManifest;
  httpClient?: AmbientMusicHttpClient;
  availableBytes?: (target: string) => Promise<number>;
}

export interface AmbientMusicDownloadRequest {
  termsAccepted: true;
  repair?: boolean;
}

interface RoleReceipt {
  version: 1;
  revision: string;
  role: AmbientMusicAssetRole;
  files: Array<{ relativePath: string; size: number; sha256: string }>;
  verifiedAt: string;
}

interface FileAvailability {
  source: "installed" | "staged" | "partial" | "missing";
  bytes: number;
}

function normalizeHeaders(headers: import("node:http").IncomingHttpHeaders): Record<string, string | undefined> {
  const result: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(headers)) {
    result[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
  }
  return result;
}

class NodeHttpsClient implements AmbientMusicHttpClient {
  request(url: URL, headers: Record<string, string>, signal: AbortSignal): Promise<AmbientMusicHttpResponse> {
    return new Promise((resolve, reject) => {
      const request = https.request(url, {
        method: "GET",
        headers,
        signal,
      }, (response) => {
        resolve({
          statusCode: response.statusCode ?? 0,
          headers: normalizeHeaders(response.headers),
          body: response,
        });
      });
      request.once("error", reject);
      request.end();
    });
  }
}

async function defaultAvailableBytes(target: string): Promise<number> {
  const stats = await statfs(target);
  return Number(stats.bavail) * Number(stats.bsize);
}

async function readJson(filePath: string): Promise<unknown | null> {
  try {
    const stats = await lstat(filePath);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 1024 * 1024) return null;
    return JSON.parse(await readFile(filePath, "utf8")) as unknown;
  } catch {
    return null;
  }
}

async function regularFileSize(filePath: string): Promise<number | null> {
  try {
    const stats = await lstat(filePath);
    return stats.isFile() && !stats.isSymbolicLink() ? stats.size : null;
  } catch {
    return null;
  }
}

async function sha256File(filePath: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash("sha256");
  const source = createReadStream(filePath);
  signal?.addEventListener("abort", () => source.destroy(signal.reason as Error), { once: true });
  for await (const chunk of source) {
    if (signal?.aborted) throw signal.reason;
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

function cancellationError(): AmbientMusicDownloadError {
  return new AmbientMusicDownloadError("download_cancelled", "The Ambient Music download was cancelled.", true);
}

function modelLabel(model: AmbientMusicModelId): string {
  return model === "mrt2_small" ? "Small" : "Base";
}

export class AmbientMusicModelStore {
  readonly root: string;
  readonly manifest: AmbientMusicAssetManifest;
  private readonly httpClient: AmbientMusicHttpClient;
  private readonly availableBytes: (target: string) => Promise<number>;
  private listeners = new Set<(models: AmbientMusicModelStatus[]) => void>();
  private modelState = new Map<AmbientMusicModelId, AmbientMusicModelStatus>();
  private activeController: AbortController | null = null;
  private activePromise: Promise<AmbientMusicVerifiedInstall> | null = null;
  private availableStorageBytes?: number;
  private roleValid = new Map<AmbientMusicAssetRole, boolean>();
  private rolePresent = new Map<AmbientMusicAssetRole, boolean>();
  private roleOccupiedBytes = new Map<AmbientMusicAssetRole, number>();
  private roleReusableBytes = new Map<AmbientMusicAssetRole, number>();

  constructor(options: AmbientMusicModelStoreOptions) {
    this.root = path.resolve(options.root);
    this.manifest = parseAmbientMusicAssetManifest(options.manifest);
    this.httpClient = options.httpClient ?? new NodeHttpsClient();
    this.availableBytes = options.availableBytes ?? defaultAvailableBytes;
    for (const model of ["mrt2_small", "mrt2_base"] as const) {
      this.modelState.set(model, this.baseStatus(model, "not_installed"));
    }
    for (const role of ["shared", "mrt2_small", "mrt2_base"] as const) {
      this.roleValid.set(role, false);
      this.rolePresent.set(role, false);
      this.roleOccupiedBytes.set(role, 0);
      this.roleReusableBytes.set(role, 0);
    }
  }

  static async fromManifestFile(root: string, manifestPath: string): Promise<AmbientMusicModelStore> {
    const value = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
    return new AmbientMusicModelStore({ root, manifest: parseAmbientMusicAssetManifest(value) });
  }

  subscribe(listener: (models: AmbientMusicModelStatus[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private baseStatus(model: AmbientMusicModelId, state: AmbientMusicModelStatus["state"]): AmbientMusicModelStatus {
    return {
      model,
      label: modelLabel(model),
      recommended: model === "mrt2_small",
      state,
      downloadBytes: ambientMusicModelDownloadBytes(this.manifest, model),
      installedBytes: state === "ready" ? ambientMusicModelDownloadBytes(this.manifest, model) : 0,
      additionalDownloadBytes: ambientMusicModelDownloadBytes(this.manifest, model),
      reclaimableBytes: state === "ready" ? ambientMusicModelDownloadBytes(this.manifest, model) : 0,
    };
  }

  private setStatus(model: AmbientMusicModelId, patch: Partial<AmbientMusicModelStatus>): void {
    const current = this.modelState.get(model) ?? this.baseStatus(model, "not_installed");
    this.modelState.set(model, { ...current, ...patch });
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }

  snapshot(): AmbientMusicModelStatus[] {
    const models = ["mrt2_small", "mrt2_base"] as const;
    const statuses = new Map(models.map((model) => [
      model,
      this.modelState.get(model) ?? this.baseStatus(model, "not_installed"),
    ]));
    const sharedBytes = ambientMusicRoleAssets(this.manifest, "shared")
      .reduce((total, asset) => total + asset.size, 0);
    return models.map((model) => {
      const current = statuses.get(model)!;
      const other = model === "mrt2_small" ? "mrt2_base" : "mrt2_small";
      const uniqueBytes = ambientMusicRoleAssets(this.manifest, model)
        .reduce((total, asset) => total + asset.size, 0);
      const sharedReusable = this.roleReusableBytes.get("shared") ?? 0;
      const uniqueReusable = this.roleReusableBytes.get(model) ?? 0;
      const uniqueOccupied = this.roleOccupiedBytes.get(model) ?? 0;
      const sharedOccupied = this.roleOccupiedBytes.get("shared") ?? 0;
      const hasModelData = uniqueOccupied > 0 || current.state !== "not_installed";
      return {
        ...current,
        installedBytes: uniqueOccupied + (hasModelData ? sharedOccupied : 0),
        additionalDownloadBytes: Math.max(0, uniqueBytes - uniqueReusable) +
          Math.max(0, sharedBytes - sharedReusable),
        reclaimableBytes: uniqueOccupied + (this.rolePresent.get(other) ? 0 : sharedOccupied),
      };
    });
  }

  storageSnapshot(): { sharedBytes: number; availableBytes?: number; locationLabel: "Aiden application data" } {
    return {
      sharedBytes: ambientMusicRoleAssets(this.manifest, "shared")
        .reduce((total, asset) => total + asset.size, 0),
      availableBytes: this.availableStorageBytes,
      locationLabel: "Aiden application data",
    };
  }

  private installRoot(): string {
    return resolveAmbientMusicOwnedPath(this.root, `installs/${this.manifest.revision}`);
  }

  private stageRoleRoot(role: AmbientMusicAssetRole): string {
    return resolveAmbientMusicOwnedPath(this.root, `staging/${this.manifest.revision}/${role}`);
  }

  private receiptPath(role: AmbientMusicAssetRole): string {
    return resolveAmbientMusicOwnedPath(this.installRoot(), `.receipts/${role}.json`);
  }

  private installedAssetPath(asset: AmbientMusicAsset): string {
    return resolveAmbientMusicOwnedPath(this.installRoot(), asset.relativePath);
  }

  private stagedAssetPath(role: AmbientMusicAssetRole, asset: AmbientMusicAsset): string {
    return resolveAmbientMusicOwnedPath(this.stageRoleRoot(role), asset.relativePath);
  }

  private partialPath(asset: AmbientMusicAsset): string {
    return resolveAmbientMusicOwnedPath(
      this.root,
      `partials/${this.manifest.revision}/${asset.relativePath}.part`,
    );
  }

  private partialMetadataPath(asset: AmbientMusicAsset): string {
    return `${this.partialPath(asset)}.json`;
  }

  private async ensureLayout(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    const rootStats = await lstat(this.root);
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
      throw new AmbientMusicDownloadError("unsafe_storage_root", "Ambient Music storage must be a real local directory.");
    }
    await this.ensureOwnedDirectory(resolveAmbientMusicOwnedPath(this.root, "manifests"));
    await this.ensureOwnedDirectory(resolveAmbientMusicOwnedPath(this.root, "installs"));
    await this.ensureOwnedDirectory(resolveAmbientMusicOwnedPath(this.root, "staging"));
    await this.ensureOwnedDirectory(resolveAmbientMusicOwnedPath(this.root, "partials"));
    const manifestTarget = resolveAmbientMusicOwnedPath(this.root, `manifests/${this.manifest.revision}.json`);
    const temporary = `${manifestTarget}.tmp`;
    await this.removeOwnedPath(temporary);
    await writeFile(temporary, `${JSON.stringify(this.manifest, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, manifestTarget);
  }

  private async ensureOwnedDirectory(directory: string): Promise<void> {
    const resolved = path.resolve(directory);
    const relative = path.relative(this.root, resolved);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new AmbientMusicDownloadError("unsafe_path", "Ambient Music storage escaped its owned root.");
    }
    let current = this.root;
    for (const segment of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      try {
        await mkdir(current);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const stats = await lstat(current);
      if (!stats.isDirectory() || stats.isSymbolicLink()) {
        throw new AmbientMusicDownloadError("unsafe_path", "Ambient Music storage contains a symlink or non-directory parent.");
      }
    }
  }

  private async hasSafeOwnedParent(target: string): Promise<boolean> {
    const parent = path.dirname(path.resolve(target));
    const relative = path.relative(this.root, parent);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return false;
    let current = this.root;
    try {
      const rootStats = await lstat(current);
      if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) return false;
      for (const segment of relative.split(path.sep).filter(Boolean)) {
        current = path.join(current, segment);
        const stats = await lstat(current);
        if (!stats.isDirectory() || stats.isSymbolicLink()) return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  private async removeOwnedPath(target: string, recursive = false): Promise<void> {
    await this.ensureOwnedDirectory(path.dirname(target));
    await rm(target, { recursive, force: true });
  }

  private groupDirectory(root: string, role: AmbientMusicAssetRole): string {
    return role === "shared"
      ? resolveAmbientMusicOwnedPath(root, "resources")
      : resolveAmbientMusicOwnedPath(root, `models/${role}`);
  }

  private backupDirectory(role: AmbientMusicAssetRole): string {
    return resolveAmbientMusicOwnedPath(
      this.installRoot(),
      role === "shared" ? ".resources.backup" : `.models-${role}.backup`,
    );
  }

  private async recoverInterruptedPublish(role: AmbientMusicAssetRole): Promise<void> {
    const target = this.groupDirectory(this.installRoot(), role);
    const backup = this.backupDirectory(role);
    const targetExists = await this.ownedPathExists(target);
    const backupExists = await this.directoryExists(backup);
    if (!targetExists && backupExists) await rename(backup, target);
    else if (targetExists && backupExists) {
      const targetValid = await this.directoryExists(target) && await this.validateRoleDirectory(role, target);
      if (targetValid) {
        await this.removeOwnedPath(backup, true);
        return;
      }
      if (await this.validateRoleDirectory(role, backup)) {
        await this.removeOwnedPath(target, true);
        await rename(backup, target);
      }
    }
  }

  private async ownedPathExists(target: string): Promise<boolean> {
    if (!await this.hasSafeOwnedParent(target)) return false;
    try {
      await lstat(target);
      return true;
    } catch {
      return false;
    }
  }

  private async validateRoleDirectory(role: AmbientMusicAssetRole, directory: string): Promise<boolean> {
    const prefix = role === "shared" ? "resources/" : `models/${role}/`;
    for (const asset of ambientMusicRoleAssets(this.manifest, role)) {
      const relative = asset.relativePath.slice(prefix.length);
      const candidate = resolveAmbientMusicOwnedPath(directory, relative);
      if (!await this.validateAsset(candidate, asset, true)) return false;
    }
    return true;
  }

  private async directoryExists(directory: string): Promise<boolean> {
    if (!await this.hasSafeOwnedParent(directory)) return false;
    try {
      const stats = await lstat(directory);
      return stats.isDirectory() && !stats.isSymbolicLink();
    } catch {
      return false;
    }
  }

  private async validateAsset(filePath: string, asset: AmbientMusicAsset, deep: boolean, signal?: AbortSignal): Promise<boolean> {
    if (!await this.hasSafeOwnedParent(filePath)) return false;
    if (await regularFileSize(filePath) !== asset.size) return false;
    if (!deep) return true;
    return await sha256File(filePath, signal) === asset.sha256;
  }

  private validReceipt(value: unknown, role: AmbientMusicAssetRole): value is RoleReceipt {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const receipt = value as Partial<RoleReceipt>;
    if (
      receipt.version !== 1 ||
      receipt.revision !== this.manifest.revision ||
      receipt.role !== role ||
      !Array.isArray(receipt.files)
    ) return false;
    const expected = ambientMusicRoleAssets(this.manifest, role);
    return expected.length === receipt.files.length && expected.every((asset) =>
      receipt.files?.some((file) =>
        file.relativePath === asset.relativePath && file.size === asset.size && file.sha256 === asset.sha256));
  }

  async validateRole(role: AmbientMusicAssetRole, deep = false, signal?: AbortSignal): Promise<boolean> {
    await this.recoverInterruptedPublish(role);
    const receipt = await readJson(this.receiptPath(role));
    if (!this.validReceipt(receipt, role)) return false;
    for (const asset of ambientMusicRoleAssets(this.manifest, role)) {
      if (signal?.aborted) throw cancellationError();
      if (!await this.validateAsset(this.installedAssetPath(asset), asset, deep, signal)) return false;
    }
    return true;
  }

  async validateModel(model: AmbientMusicModelId, deep = false, signal?: AbortSignal): Promise<boolean> {
    return await this.validateRole("shared", deep, signal) && await this.validateRole(model, deep, signal);
  }

  private async refreshAvailableStorage(): Promise<void> {
    try {
      this.availableStorageBytes = await this.availableBytes(this.root);
    } catch {
      this.availableStorageBytes = undefined;
    }
  }

  private async safeRegularFileSize(filePath: string): Promise<number> {
    if (!await this.hasSafeOwnedParent(filePath)) return 0;
    return await regularFileSize(filePath) ?? 0;
  }

  private async refreshRoleAccounting(deep: boolean): Promise<void> {
    for (const role of ["shared", "mrt2_small", "mrt2_base"] as const) {
      const valid = await this.validateRole(role, deep);
      const present = await this.directoryExists(this.groupDirectory(this.installRoot(), role));
      let occupiedBytes = 0;
      let reusableBytes = valid
        ? ambientMusicRoleAssets(this.manifest, role).reduce((total, asset) => total + asset.size, 0)
        : 0;
      for (const asset of ambientMusicRoleAssets(this.manifest, role)) {
        if (deep && !valid) {
          reusableBytes += (await this.fileAvailability(asset, new AbortController().signal)).bytes;
        }
        occupiedBytes += await this.safeRegularFileSize(this.installedAssetPath(asset));
        occupiedBytes += await this.safeRegularFileSize(this.stagedAssetPath(role, asset));
        occupiedBytes += await this.safeRegularFileSize(this.partialPath(asset));
      }
      this.roleValid.set(role, valid);
      this.rolePresent.set(role, present);
      this.roleOccupiedBytes.set(role, occupiedBytes);
      this.roleReusableBytes.set(role, reusableBytes);
    }
  }

  async refreshStatus(deep = false): Promise<AmbientMusicModelStatus[]> {
    await this.ensureLayout();
    await this.refreshAvailableStorage();
    await this.refreshRoleAccounting(deep);
    for (const model of ["mrt2_small", "mrt2_base"] as const) {
      try {
        const valid = this.roleValid.get("shared") === true && this.roleValid.get(model) === true;
        const anyModelFile = (this.roleOccupiedBytes.get(model) ?? 0) > 0 ||
          this.rolePresent.get(model) === true;
        this.setStatus(model, {
          state: valid ? "ready" : (anyModelFile ? "needs_repair" : "not_installed"),
          progress: undefined,
          error: undefined,
        });
      } catch (error) {
        const failure = this.asDownloadError(error);
        this.setStatus(model, {
          state: "failed",
          error: { code: failure.code, message: failure.message, retryable: failure.retryable },
        });
      }
    }
    return this.snapshot();
  }

  async verifiedInstall(model: AmbientMusicModelId): Promise<AmbientMusicVerifiedInstall> {
    await this.ensureLayout();
    if (!await this.validateModel(model, true)) {
      await this.refreshStatus(true);
      throw new AmbientMusicDownloadError("model_needs_repair", `${modelLabel(model)} needs repair before playback.`, true);
    }
    await this.refreshStatus(true);
    return { root: this.installRoot(), revision: this.manifest.revision, verified: true };
  }

  download(model: AmbientMusicModelId, request: AmbientMusicDownloadRequest): Promise<AmbientMusicVerifiedInstall> {
    if (request.termsAccepted !== true) {
      return Promise.reject(new AmbientMusicDownloadError(
        "terms_not_accepted",
        "Review and accept the Magenta RealTime 2 model terms before downloading.",
      ));
    }
    if (this.activePromise) {
      return Promise.reject(new AmbientMusicDownloadError("download_busy", "Another Ambient Music download is active.", true));
    }
    const controller = new AbortController();
    this.activeController = controller;
    const operation = this.performDownload(model, request.repair === true, controller.signal);
    this.activePromise = operation;
    void operation.finally(() => {
      if (this.activePromise === operation) this.activePromise = null;
      if (this.activeController === controller) this.activeController = null;
    }).catch(() => undefined);
    return operation;
  }

  async cancelDownload(): Promise<void> {
    const active = this.activePromise;
    if (!active || !this.activeController) return;
    this.activeController.abort(cancellationError());
    try {
      await active;
    } catch (error) {
      if (this.asDownloadError(error).code !== "download_cancelled") throw error;
    }
  }

  private async performDownload(
    model: AmbientMusicModelId,
    repair: boolean,
    signal: AbortSignal,
  ): Promise<AmbientMusicVerifiedInstall> {
    await this.ensureLayout();
    this.setStatus(model, {
      state: "downloading",
      progress: { downloadedBytes: 0, totalBytes: ambientMusicModelDownloadBytes(this.manifest, model), currentFile: 0, fileCount: ambientMusicAssetsForModel(this.manifest, model).length },
      error: undefined,
    });
    try {
      if (!repair && await this.validateModel(model, false, signal)) return await this.verifiedInstall(model);
      const assets = ambientMusicAssetsForModel(this.manifest, model);
      const availability = await Promise.all(assets.map((asset) => this.fileAvailability(asset, signal)));
      const remaining = availability.reduce((total, item, index) => total + assets[index].size - item.bytes, 0);
      const free = await this.availableBytes(this.root);
      this.availableStorageBytes = free;
      const required = ambientMusicDiskBudget(remaining);
      if (free < required) {
        throw new AmbientMusicDownloadError(
          "insufficient_disk_space",
          `Ambient Music needs ${required} free bytes, but only ${free} are available.`,
          true,
        );
      }

      let completedBytes = availability.reduce((total, item) => total + item.bytes, 0);
      let currentFile = 0;
      for (const role of ["shared", model] as const) {
        const roleValid = await this.validateRole(role, repair, signal);
        if (roleValid) {
          currentFile += ambientMusicRoleAssets(this.manifest, role).length;
          continue;
        }
        const roleAssets = ambientMusicRoleAssets(this.manifest, role);
        for (const asset of roleAssets) {
          if (signal.aborted) throw cancellationError();
          currentFile += 1;
          const staged = this.stagedAssetPath(role, asset);
          if (await this.validateAsset(staged, asset, true, signal)) {
            this.reportProgress(model, completedBytes, assets, currentFile);
            continue;
          }
          const installed = this.installedAssetPath(asset);
          if (await this.validateAsset(installed, asset, true, signal)) {
            await this.ensureOwnedDirectory(path.dirname(staged));
            await this.removeOwnedPath(staged);
            try {
              await link(installed, staged);
            } catch {
              await copyFile(installed, staged);
            }
            this.reportProgress(model, completedBytes, assets, currentFile);
            continue;
          }
          const partialBefore = await regularFileSize(this.partialPath(asset)) ?? 0;
          await this.downloadAsset(asset, signal, (assetBytes) => {
            this.reportProgress(model, completedBytes - partialBefore + assetBytes, assets, currentFile);
          });
          const partial = this.partialPath(asset);
          if (!await this.validateAsset(partial, asset, true, signal)) {
            await this.removePartial(asset);
            throw new AmbientMusicDownloadError("asset_integrity_failed", `Downloaded ${asset.relativePath} failed verification.`, true);
          }
          await this.ensureOwnedDirectory(path.dirname(staged));
          await this.removeOwnedPath(staged);
          await rename(partial, staged);
          await this.removeOwnedPath(this.partialMetadataPath(asset));
          completedBytes = Math.min(
            assets.reduce((total, value) => total + value.size, 0),
            completedBytes - partialBefore + asset.size,
          );
        }
        this.setStatus(model, { state: "verifying" });
        for (const asset of roleAssets) {
          if (!await this.validateAsset(this.stagedAssetPath(role, asset), asset, true, signal)) {
            throw new AmbientMusicDownloadError("asset_integrity_failed", `${asset.relativePath} failed staged verification.`, true);
          }
        }
        await this.publishRole(role);
        await this.writeReceipt(role);
      }
      return await this.verifiedInstall(model);
    } catch (error) {
      const failure = signal.aborted ? cancellationError() : this.asDownloadError(error);
      try {
        await this.refreshRoleAccounting(true);
        await this.refreshAvailableStorage();
      } catch {
        // Preserve the authoritative download failure below.
      }
      const anyModelFiles = await this.directoryExists(this.groupDirectory(this.installRoot(), model));
      this.setStatus(model, {
        state: anyModelFiles
          ? "needs_repair"
          : failure.code === "download_cancelled"
            ? "not_installed"
            : "failed",
        progress: undefined,
        error: failure.code === "download_cancelled" ? undefined : {
          code: failure.code,
          message: failure.message,
          retryable: failure.retryable,
        },
      });
      throw failure;
    }
  }

  private reportProgress(
    model: AmbientMusicModelId,
    downloadedBytes: number,
    assets: AmbientMusicAsset[],
    currentFile: number,
  ): void {
    this.setStatus(model, {
      state: "downloading",
      progress: {
        downloadedBytes: Math.max(0, Math.min(downloadedBytes, assets.reduce((total, asset) => total + asset.size, 0))),
        totalBytes: assets.reduce((total, asset) => total + asset.size, 0),
        currentFile,
        fileCount: assets.length,
      },
    });
  }

  private async fileAvailability(asset: AmbientMusicAsset, signal: AbortSignal): Promise<FileAvailability> {
    if (await this.validateAsset(this.installedAssetPath(asset), asset, true, signal)) {
      return { source: "installed", bytes: asset.size };
    }
    if (await this.validateAsset(this.stagedAssetPath(asset.role, asset), asset, true, signal)) {
      return { source: "staged", bytes: asset.size };
    }
    const partialSize = await regularFileSize(this.partialPath(asset)) ?? 0;
    const metadata = await readJson(this.partialMetadataPath(asset));
    if (canResumeAmbientMusicPartial(metadata, this.manifest, asset, partialSize)) {
      return { source: "partial", bytes: partialSize };
    }
    if (partialSize > 0) await this.removePartial(asset);
    return { source: "missing", bytes: 0 };
  }

  private async requestFollowingRedirects(
    initial: URL,
    headers: Record<string, string>,
    signal: AbortSignal,
  ): Promise<AmbientMusicHttpResponse> {
    let url = initial;
    for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
      if (signal.aborted) throw cancellationError();
      let response: AmbientMusicHttpResponse;
      try {
        response = await this.httpClient.request(url, headers, signal);
      } catch {
        if (signal.aborted) throw cancellationError();
        throw new AmbientMusicDownloadError("download_offline", "Could not reach the official model host.", true);
      }
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        const location = response.headers.location;
        await this.closeResponseBody(response.body);
        if (!location) {
          throw new AmbientMusicDownloadError("invalid_redirect", "The model host returned an empty redirect.");
        }
        if (redirect === MAX_REDIRECTS) {
          throw new AmbientMusicDownloadError("too_many_redirects", "The model host redirected too many times.", true);
        }
        url = validateAmbientMusicRedirect(url, location);
        continue;
      }
      return response;
    }
    throw new AmbientMusicDownloadError("too_many_redirects", "The model host redirected too many times.", true);
  }

  private async closeResponseBody(body: Readable): Promise<void> {
    if (body.closed) return;
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        body.off("close", finish);
        resolve();
      };
      body.once("close", finish);
      body.destroy();
      if (body.closed) finish();
    });
  }

  private async downloadAsset(
    asset: AmbientMusicAsset,
    signal: AbortSignal,
    onProgress: (bytes: number) => void,
  ): Promise<void> {
    const partial = this.partialPath(asset);
    const metadataPath = this.partialMetadataPath(asset);
    await this.ensureOwnedDirectory(path.dirname(partial));
    let partialSize = await regularFileSize(partial) ?? 0;
    let metadata = await readJson(metadataPath);
    let resumable = canResumeAmbientMusicPartial(metadata, this.manifest, asset, partialSize);
    if (!resumable && partialSize > 0) {
      await this.removePartial(asset);
      partialSize = 0;
      metadata = null;
    }

    const perform = async (resume: boolean): Promise<"complete" | "restart"> => {
      const headers: Record<string, string> = { "Accept-Encoding": "identity" };
      if (resume && canResumeAmbientMusicPartial(metadata, this.manifest, asset, partialSize)) {
        headers.Range = `bytes=${partialSize}-`;
        headers["If-Range"] = metadata.etag;
      }
      const response = await this.requestFollowingRedirects(
        ambientMusicAssetUrl(this.manifest, asset),
        headers,
        signal,
      );
      const etag = response.headers.etag;
      if (resume) {
        const range = parseAmbientMusicContentRange(response.headers["content-range"]);
        if (
          response.statusCode !== 206 ||
          !range ||
          range.start !== partialSize ||
          range.total !== asset.size ||
          !etag ||
          !canResumeAmbientMusicPartial(metadata, this.manifest, asset, partialSize) ||
          etag !== metadata.etag
        ) {
          await this.closeResponseBody(response.body);
          return "restart";
        }
      } else if (response.statusCode !== 200) {
        await this.closeResponseBody(response.body);
        throw new AmbientMusicDownloadError(
          "download_http_error",
          `The model host returned HTTP ${response.statusCode} for ${asset.relativePath}.`,
          true,
        );
      }

      if (!resume) {
        await this.removeOwnedPath(partial);
        partialSize = 0;
      }
      if (etag) {
        const nextMetadata: AmbientMusicPartialMetadata = {
          version: 1,
          revision: this.manifest.revision,
          relativePath: asset.relativePath,
          expectedSize: asset.size,
          etag,
        };
        await this.removeOwnedPath(metadataPath);
        await writeFile(metadataPath, `${JSON.stringify(nextMetadata)}\n`, { mode: 0o600, flag: "wx" });
      } else {
        await this.removeOwnedPath(metadataPath);
      }
      let received = partialSize;
      const destination = createWriteStream(partial, { flags: resume ? "a" : "w", mode: 0o600 });
      let destinationError: Error | undefined;
      destination.on("error", (error) => { destinationError = error; });
      const writeChunk = async (chunk: Buffer): Promise<void> => {
        await new Promise<void>((resolve, reject) => {
          destination.write(chunk, (error) => error ? reject(error) : resolve());
        });
      };
      const closeDestination = async (): Promise<void> => {
        if (destination.closed) {
          if (destinationError) throw destinationError;
          return;
        }
        await new Promise<void>((resolve, reject) => {
          destination.once("close", () => destinationError ? reject(destinationError) : resolve());
          if (!destination.writableEnded) destination.end();
        });
      };
      const abortBody = () => response.body.destroy(cancellationError());
      signal.addEventListener("abort", abortBody, { once: true });
      let transferError: unknown;
      try {
        for await (const value of response.body) {
          const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
          received += chunk.byteLength;
          if (received > asset.size) {
            throw new AmbientMusicDownloadError(
              "asset_size_mismatch",
              `${asset.relativePath} exceeded its manifest size.`,
            );
          }
          await writeChunk(chunk);
          onProgress(received);
        }
      } catch (error) {
        transferError = error;
      } finally {
        signal.removeEventListener("abort", abortBody);
        try {
          await closeDestination();
        } catch (error) {
          transferError ??= error;
        }
        if (transferError && !response.body.closed) {
          await this.closeResponseBody(response.body);
        }
      }
      if (signal.aborted) throw cancellationError();
      if (transferError instanceof AmbientMusicDownloadError) throw transferError;
      if (transferError) {
        throw new AmbientMusicDownloadError(
          "download_interrupted",
          "The model download was interrupted.",
          true,
        );
      }
      if (await regularFileSize(partial) !== asset.size) {
        throw new AmbientMusicDownloadError("asset_size_mismatch", `${asset.relativePath} did not match its manifest size.`, true);
      }
      return "complete";
    };

    if (resumable && await perform(true) === "restart") {
      await this.removePartial(asset);
      partialSize = 0;
      metadata = null;
      resumable = false;
    }
    if (!resumable) await perform(false);
  }

  private async removePartial(asset: AmbientMusicAsset): Promise<void> {
    await this.removeOwnedPath(this.partialPath(asset));
    await this.removeOwnedPath(this.partialMetadataPath(asset));
  }

  private async publishRole(role: AmbientMusicAssetRole): Promise<void> {
    await this.ensureOwnedDirectory(this.installRoot());
    const source = this.groupDirectory(this.stageRoleRoot(role), role);
    const target = this.groupDirectory(this.installRoot(), role);
    const backup = this.backupDirectory(role);
    await this.ensureOwnedDirectory(path.dirname(target));
    await this.removeOwnedPath(backup, true);
    const targetExists = await this.directoryExists(target);
    if (targetExists) await rename(target, backup);
    try {
      await rename(source, target);
    } catch (error) {
      if (targetExists && await this.directoryExists(backup)) await rename(backup, target);
      throw error;
    }
    await this.removeOwnedPath(backup, true);
    await this.removeOwnedPath(this.stageRoleRoot(role), true);
  }

  private async writeReceipt(role: AmbientMusicAssetRole): Promise<void> {
    const receipt: RoleReceipt = {
      version: 1,
      revision: this.manifest.revision,
      role,
      files: ambientMusicRoleAssets(this.manifest, role).map((asset) => ({
        relativePath: asset.relativePath,
        size: asset.size,
        sha256: asset.sha256,
      })),
      verifiedAt: new Date().toISOString(),
    };
    const target = this.receiptPath(role);
    const temporary = `${target}.tmp`;
    await this.ensureOwnedDirectory(path.dirname(target));
    await this.removeOwnedPath(temporary);
    await writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, target);
  }

  async removeModel(model: AmbientMusicModelId): Promise<void> {
    if (this.activePromise) {
      throw new AmbientMusicDownloadError("download_busy", "Cancel the active download before removing a model.", true);
    }
    await this.ensureLayout();
    const modelDirectory = this.groupDirectory(this.installRoot(), model);
    await this.removeOwnedPath(modelDirectory, true);
    await this.removeOwnedPath(this.receiptPath(model));
    await this.removeOwnedPath(this.stageRoleRoot(model), true);
    for (const asset of ambientMusicRoleAssets(this.manifest, model)) await this.removePartial(asset);

    const other = model === "mrt2_small" ? "mrt2_base" : "mrt2_small";
    if (!await this.directoryExists(this.groupDirectory(this.installRoot(), other))) {
      await this.removeOwnedPath(this.groupDirectory(this.installRoot(), "shared"), true);
      await this.removeOwnedPath(this.receiptPath("shared"));
      await this.removeOwnedPath(this.stageRoleRoot("shared"), true);
      for (const asset of ambientMusicRoleAssets(this.manifest, "shared")) await this.removePartial(asset);
    }
    await this.refreshRoleAccounting(true);
    await this.refreshAvailableStorage();
    this.setStatus(model, {
      state: "not_installed",
      installedBytes: 0,
      progress: undefined,
      error: undefined,
    });
  }

  private asDownloadError(error: unknown): AmbientMusicDownloadError {
    if (error instanceof AmbientMusicDownloadError) return error;
    if (error instanceof Error && error.name === "AbortError") return cancellationError();
    return new AmbientMusicDownloadError(
      "model_storage_failed",
      "Ambient Music could not safely read or write its model storage.",
      true,
    );
  }
}
