import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DataStore, DataStoreExternalChangeError } from "../data-store.js";
import { readRegularFile } from "../regular-file-read.js";
import type {
  AssetMetadataDto,
  AssetOrigin,
  ContentAddressedAssetStore,
} from "./asset-store-core.js";

const ASSET_ID = /^[a-f0-9]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SAFE_FILENAME = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,220}\.(?:jpg|png)$/u;
const WORKSPACE_MARKER = ".aiden-create-images-workspace.json";
const WORKSPACE_README = "README.txt";
const WORKSPACE_SCHEMA_VERSION = 1 as const;
const MAX_CONFIG_BYTES = 64 * 1024 * 1024;
const MAX_ENTRIES = 100_000;
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
const MAX_MARKER_BYTES = 16 * 1024;
const COPY_CHUNK_BYTES = 64 * 1024;
const NO_FOLLOW = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;

export type CreateImagesWorkspaceState =
  | "unconfigured"
  | "ready"
  | "drifted"
  | "conflict"
  | "unwritable"
  | "repair_required";

export type CreateImagesWorkspaceEntryState = "materialized" | "conflict" | "drifted" | "orphaned";

export type CreateImagesWorkspaceErrorCode =
  | "workspace_not_configured"
  | "workspace_config_invalid"
  | "workspace_config_conflict"
  | "workspace_root_invalid"
  | "workspace_root_missing"
  | "workspace_root_changed"
  | "workspace_root_unsafe"
  | "workspace_not_writable"
  | "workspace_marker_missing"
  | "workspace_marker_conflict"
  | "workspace_target_conflict"
  | "workspace_target_missing"
  | "workspace_asset_missing"
  | "workspace_sync_failed";

export class CreateImagesWorkspaceError extends Error {
  constructor(
    public readonly code: CreateImagesWorkspaceErrorCode,
    message: string,
    public readonly assetId?: string,
  ) {
    super(message);
    this.name = "CreateImagesWorkspaceError";
  }
}

export interface CreateImagesWorkspaceStatus {
  state: CreateImagesWorkspaceState;
  configured: boolean;
  workspaceId?: string;
  /** Finder-facing label only; this never contains the selected path. */
  displayName?: string;
  lastSyncedAt?: string;
  revision: number;
  entryCount: number;
  materializedCount: number;
  driftedCount: number;
  conflictCount: number;
  importedCount: number;
  generatedCount: number;
  writable: boolean;
}

export type CreateImagesWorkspacePreflightIssueCode =
  | "root_missing"
  | "root_changed"
  | "root_unsafe"
  | "not_writable"
  | "marker_missing"
  | "marker_conflict"
  | "directory_missing"
  | "directory_unsafe"
  | "target_missing"
  | "target_conflict"
  | "target_drifted";

export interface CreateImagesWorkspacePreflightIssue {
  code: CreateImagesWorkspacePreflightIssueCode;
  assetId?: string;
}

export interface CreateImagesWorkspacePreflight extends CreateImagesWorkspaceStatus {
  ok: boolean;
  issues: CreateImagesWorkspacePreflightIssue[];
}

export interface CreateImagesWorkspaceSyncResult {
  state: CreateImagesWorkspaceState;
  revision: number;
  totalAssets: number;
  materializedAssetIds: string[];
  alreadyMaterializedAssetIds: string[];
  conflictedAssetIds: string[];
  driftedAssetIds: string[];
  failed: Array<{ assetId: string; message: string }>;
}

export interface CreateImagesWorkspaceOpenTarget {
  /** Main-process-only absolute path. Never return this over renderer IPC. */
  filePath: string;
  assetId: string;
  relativePath: string;
}

export interface CreateImagesWorkspaceOpenRoot {
  /** Main-process-only absolute path. Never return this over renderer IPC. */
  filePath: string;
  displayName: string;
}

export interface CreateImagesWorkspaceAssetSource {
  list(): Promise<AssetMetadataDto[]>;
  get(assetId: string): Promise<AssetMetadataDto | undefined>;
  withAssetFile<Result>(
    assetId: string,
    callback: (input: {
      filePath: string;
      asset: AssetMetadataDto;
      byteLength: number;
      mediaType: AssetMetadataDto["mediaType"];
    }) => Promise<Result>,
  ): Promise<Result>;
}

interface WorkspacePathIdentity {
  device: string;
  inode: string;
}

interface WorkspaceEntry {
  assetId: string;
  relativePath: string;
  mediaType: AssetMetadataDto["mediaType"];
  byteLength: number;
  state: CreateImagesWorkspaceEntryState;
  updatedAt: string;
}

interface WorkspaceConfig {
  schemaVersion: typeof WORKSPACE_SCHEMA_VERSION;
  revision: number;
  selectedPath: string | null;
  workspaceId: string | null;
  identity: WorkspacePathIdentity | null;
  lastSyncedAt: string | null;
  entries: Record<string, WorkspaceEntry>;
}

interface WorkspaceMarker {
  schemaVersion: typeof WORKSPACE_SCHEMA_VERSION;
  workspaceId: string;
  createdAt: string;
}

interface WorkspaceRootContext {
  selectedPath: string;
  identity: WorkspacePathIdentity;
}

type TargetInspection = "missing" | "materialized" | "conflict";

const EMPTY_CONFIG: WorkspaceConfig = {
  schemaVersion: WORKSPACE_SCHEMA_VERSION,
  revision: 0,
  selectedPath: null,
  workspaceId: null,
  identity: null,
  lastSyncedAt: null,
  entries: {},
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isAbsolutePath(value: unknown): value is string {
  return typeof value === "string" && path.isAbsolute(value) && !value.includes("\0");
}

function isIdentity(value: unknown): value is WorkspacePathIdentity {
  return (
    isRecord(value) &&
    typeof value.device === "string" &&
    /^[0-9]+$/u.test(value.device) &&
    typeof value.inode === "string" &&
    /^[0-9]+$/u.test(value.inode)
  );
}

function isSafeRelativePath(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > 240) return false;
  if (value.includes("\0") || value.includes("\\") || path.isAbsolute(value)) return false;
  const parts = value.split("/");
  return (
    parts.length === 2 &&
    (parts[0] === "Imports" || parts[0] === "Generated") &&
    SAFE_FILENAME.test(parts[1] ?? "")
  );
}

function isWorkspaceEntry(value: unknown, assetId: string): value is WorkspaceEntry {
  if (!isRecord(value)) return false;
  return (
    value.assetId === assetId &&
    ASSET_ID.test(assetId) &&
    isSafeRelativePath(value.relativePath) &&
    (value.mediaType === "image/jpeg" || value.mediaType === "image/png") &&
    Number.isSafeInteger(value.byteLength) &&
    (value.byteLength as number) > 0 &&
    (value.byteLength as number) <= MAX_ENTRY_BYTES &&
    (value.state === "materialized" ||
      value.state === "conflict" ||
      value.state === "drifted" ||
      value.state === "orphaned") &&
    isFiniteDate(value.updatedAt)
  );
}

function isWorkspaceConfig(value: unknown): value is WorkspaceConfig {
  if (!isRecord(value) || value.schemaVersion !== WORKSPACE_SCHEMA_VERSION) return false;
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 0) return false;
  const selectedPath = value.selectedPath;
  const workspaceId = value.workspaceId;
  const identity = value.identity;
  const unconfigured = selectedPath === null && workspaceId === null && identity === null;
  const configured =
    isAbsolutePath(selectedPath) &&
    typeof workspaceId === "string" &&
    SAFE_ID.test(workspaceId) &&
    isIdentity(identity);
  if (!unconfigured && !configured) return false;
  if (
    unconfigured &&
    (value.lastSyncedAt !== null || Object.keys(value.entries ?? {}).length > 0)
  ) {
    return false;
  }
  if (value.lastSyncedAt !== null && !isFiniteDate(value.lastSyncedAt)) return false;
  if (!isRecord(value.entries)) return false;
  const entries = Object.entries(value.entries);
  if (entries.length > MAX_ENTRIES) return false;
  return entries.every(([assetId, entry]) => isWorkspaceEntry(entry, assetId));
}

function cloneConfig(config: WorkspaceConfig): WorkspaceConfig {
  return structuredClone(config);
}

function normalizeConfig(value: unknown): WorkspaceConfig {
  return isWorkspaceConfig(value) ? cloneConfig(value) : cloneConfig(EMPTY_CONFIG);
}

function assertAbsoluteDirectoryPath(directory: string): string {
  if (!isAbsolutePath(directory)) {
    throw new CreateImagesWorkspaceError(
      "workspace_root_invalid",
      "The Create Images workspace directory must be an absolute path.",
    );
  }
  return path.resolve(directory);
}

function sameIdentity(left: WorkspacePathIdentity, right: WorkspacePathIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function directoryForOrigin(origin: AssetOrigin): "Imports" | "Generated" {
  return origin.kind === "import" || origin.kind === "repair" ? "Imports" : "Generated";
}

function safeStem(displayName: string | undefined, origin: AssetOrigin): string {
  const slashNormalized = (displayName ?? "").replace(/\\/gu, "/");
  const basename = slashNormalized.slice(slashNormalized.lastIndexOf("/") + 1);
  const withoutExtension = basename.replace(/\.[A-Za-z0-9]{1,12}$/u, "");
  const stem = withoutExtension
    .normalize("NFKC")
    .replace(/[^A-Za-z0-9._ -]/gu, "-")
    .replace(/[ ._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 80);
  if (stem) return stem;
  return origin.kind === "import" || origin.kind === "repair" ? "import" : "generated";
}

export function createImagesWorkspaceRelativePath(
  asset: Pick<AssetMetadataDto, "assetId" | "mediaType" | "displayName" | "origin">,
): string {
  if (!ASSET_ID.test(asset.assetId)) {
    throw new CreateImagesWorkspaceError(
      "workspace_asset_missing",
      "The workspace asset ID is invalid.",
      asset.assetId,
    );
  }
  const extension = asset.mediaType === "image/jpeg" ? "jpg" : "png";
  return `${directoryForOrigin(asset.origin)}/${safeStem(asset.displayName, asset.origin)}-${asset.assetId}.${extension}`;
}

function nowIso(now: () => number): string {
  return new Date(now()).toISOString();
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function safeLstat(directory: string): Promise<import("node:fs").Stats> {
  try {
    return await fs.lstat(directory);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new CreateImagesWorkspaceError(
        "workspace_root_missing",
        "The configured Create Images workspace directory is missing.",
      );
    }
    throw error;
  }
}

async function identityFor(directory: string): Promise<WorkspacePathIdentity> {
  const info = await fs.stat(directory, { bigint: true });
  return { device: info.dev.toString(), inode: info.ino.toString() };
}

async function ensureDirectoryChild(root: string, name: string): Promise<string> {
  const child = path.join(root, name);
  try {
    const info = await fs.lstat(child);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new CreateImagesWorkspaceError(
        "workspace_root_unsafe",
        `The Create Images workspace entry ${name} is not a regular directory.`,
      );
    }
    return child;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    try {
      await fs.mkdir(child, { mode: 0o700 });
    } catch (mkdirError) {
      if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
    }
    const info = await fs.lstat(child);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new CreateImagesWorkspaceError(
        "workspace_root_unsafe",
        `The Create Images workspace entry ${name} is not a regular directory.`,
      );
    }
    await syncDirectory(root);
    return child;
  }
}

async function readWorkspaceMarker(root: string): Promise<WorkspaceMarker | null> {
  const markerPath = path.join(root, WORKSPACE_MARKER);
  let info;
  try {
    info = await fs.lstat(markerPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new CreateImagesWorkspaceError(
      "workspace_root_unsafe",
      "The Create Images workspace marker is not a regular file.",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse((await readRegularFile(markerPath, MAX_MARKER_BYTES)).toString("utf8"));
  } catch {
    throw new CreateImagesWorkspaceError(
      "workspace_marker_conflict",
      "The selected directory contains an invalid Create Images workspace marker.",
    );
  }
  if (
    !isRecord(parsed) ||
    parsed.schemaVersion !== WORKSPACE_SCHEMA_VERSION ||
    typeof parsed.workspaceId !== "string" ||
    !SAFE_ID.test(parsed.workspaceId) ||
    !isFiniteDate(parsed.createdAt)
  ) {
    throw new CreateImagesWorkspaceError(
      "workspace_marker_conflict",
      "The selected directory contains an incompatible Create Images workspace marker.",
    );
  }
  return {
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    workspaceId: parsed.workspaceId,
    createdAt: parsed.createdAt,
  };
}

async function createWorkspaceMarker(root: string, workspaceId: string): Promise<void> {
  const markerPath = path.join(root, WORKSPACE_MARKER);
  const existing = await readWorkspaceMarker(root);
  if (existing) {
    if (existing.workspaceId !== workspaceId) {
      throw new CreateImagesWorkspaceError(
        "workspace_marker_conflict",
        "The selected directory belongs to another Create Images workspace.",
      );
    }
    return;
  }
  const staged = path.join(root, `.${WORKSPACE_MARKER}.${randomUUID()}.tmp`);
  const contents = `${JSON.stringify({
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    workspaceId,
    createdAt: new Date().toISOString(),
  })}\n`;
  try {
    const handle = await fs.open(
      staged,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(contents, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await fs.link(staged, markerPath);
      await syncDirectory(root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const raced = await readWorkspaceMarker(root);
      if (!raced || raced.workspaceId !== workspaceId) {
        throw new CreateImagesWorkspaceError(
          "workspace_marker_conflict",
          "Another workspace marker appeared in the selected directory.",
        );
      }
    }
  } finally {
    await fs.rm(staged, { force: true }).catch(() => undefined);
  }
}

async function createWorkspaceReadme(root: string): Promise<void> {
  const destination = path.join(root, WORKSPACE_README);
  let existing;
  try {
    existing = await fs.lstat(destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (existing) {
    if (existing.isSymbolicLink() || !existing.isFile()) {
      throw new CreateImagesWorkspaceError(
        "workspace_root_unsafe",
        "The Create Images workspace README is not a regular file.",
      );
    }
    return;
  }
  const staged = path.join(root, `.${WORKSPACE_README}.${randomUUID()}.tmp`);
  try {
    const handle = await fs.open(
      staged,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(
        "This folder is a Finder-visible mirror of Aiden Create Images assets.\n\n" +
          "Imports are files added to Aiden. Generated contains provider outputs.\n" +
          "Aiden's internal Create Images library remains the source of truth.\n",
        "utf8",
      );
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await fs.link(staged, destination);
      await syncDirectory(root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const raced = await fs.lstat(destination);
      if (raced.isSymbolicLink() || !raced.isFile()) {
        throw new CreateImagesWorkspaceError(
          "workspace_root_unsafe",
          "The Create Images workspace README changed during setup.",
        );
      }
    }
  } finally {
    await fs.rm(staged, { force: true }).catch(() => undefined);
  }
}

async function hashRegularFile(
  filePath: string,
  maxBytes: number,
): Promise<{ byteLength: number; digest: string }> {
  const handle = await fs.open(filePath, constants.O_RDONLY | constants.O_NONBLOCK | NO_FOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size < 1 || before.size > maxBytes) {
      throw new Error("The workspace target is not a bounded regular file.");
    }
    const hash = createHash("sha256");
    let total = 0;
    while (total <= maxBytes) {
      const chunk = Buffer.allocUnsafe(Math.min(COPY_CHUNK_BYTES, maxBytes + 1 - total));
      const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, total);
      if (bytesRead === 0) break;
      hash.update(chunk.subarray(0, bytesRead));
      total += bytesRead;
    }
    if (total > maxBytes) throw new Error("The workspace target grew beyond its byte limit.");
    const after = await handle.stat();
    if (after.size !== before.size || total !== before.size) {
      throw new Error("The workspace target changed while it was being read.");
    }
    return { byteLength: total, digest: hash.digest("hex") };
  } finally {
    await handle.close();
  }
}

async function inspectTarget(
  filePath: string,
  assetId: string,
  byteLength: number,
): Promise<TargetInspection> {
  let info;
  try {
    info = await fs.lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile()) return "conflict";
  try {
    const hashed = await hashRegularFile(filePath, byteLength);
    return hashed.byteLength === byteLength && hashed.digest === assetId
      ? "materialized"
      : "conflict";
  } catch {
    return "conflict";
  }
}

async function copyVerifiedFile(
  sourcePath: string,
  destination: string,
  assetId: string,
  byteLength: number,
): Promise<"materialized" | "already" | "conflict"> {
  const directory = path.dirname(destination);
  const staged = path.join(directory, `.${path.basename(destination)}.${randomUUID()}.tmp`);
  const source = await fs.open(sourcePath, constants.O_RDONLY | constants.O_NONBLOCK | NO_FOLLOW);
  let stagedHandle: fs.FileHandle | undefined;
  try {
    const sourceInfo = await source.stat();
    if (!sourceInfo.isFile() || sourceInfo.size !== byteLength) {
      throw new CreateImagesWorkspaceError(
        "workspace_sync_failed",
        "The canonical asset changed before workspace materialization.",
        assetId,
      );
    }
    stagedHandle = await fs.open(
      staged,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
      0o600,
    );
    const hash = createHash("sha256");
    let total = 0;
    while (total <= byteLength) {
      const chunk = Buffer.allocUnsafe(Math.min(COPY_CHUNK_BYTES, byteLength + 1 - total));
      const { bytesRead } = await source.read(chunk, 0, chunk.byteLength, total);
      if (bytesRead === 0) break;
      const part = chunk.subarray(0, bytesRead);
      hash.update(part);
      let written = 0;
      while (written < part.byteLength) {
        const result = await stagedHandle.write(part, written, part.byteLength - written, null);
        if (result.bytesWritten < 1) throw new Error("The workspace write made no progress.");
        written += result.bytesWritten;
      }
      total += bytesRead;
    }
    if (total !== byteLength || hash.digest("hex") !== assetId) {
      throw new CreateImagesWorkspaceError(
        "workspace_sync_failed",
        "The canonical asset changed during workspace materialization.",
        assetId,
      );
    }
    await stagedHandle.sync();
    await stagedHandle.close();
    stagedHandle = undefined;
    try {
      await fs.link(staged, destination);
      await syncDirectory(directory);
      return "materialized";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await inspectTarget(destination, assetId, byteLength);
      if (existing === "materialized") return "already";
      return "conflict";
    }
  } finally {
    await stagedHandle?.close().catch(() => undefined);
    await source.close().catch(() => undefined);
    await fs.rm(staged, { force: true }).catch(() => undefined);
  }
}

export class CreateImagesWorkspaceStore {
  private readonly configStore: DataStore<WorkspaceConfig>;
  private config = cloneConfig(EMPTY_CONFIG);
  private configHealthy = true;
  private configCorrupt = false;
  private configUnsafe = false;
  private initializePromise: Promise<void> | undefined;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly rootDirectory: string,
    private readonly assets: CreateImagesWorkspaceAssetSource | ContentAddressedAssetStore,
    private readonly options: { now?: () => number } = {},
  ) {
    if (!path.isAbsolute(rootDirectory)) {
      throw new Error("The Create Images workspace config root must be absolute.");
    }
    this.configStore = new DataStore(
      "workspace.json",
      cloneConfig(EMPTY_CONFIG),
      () => this.rootDirectory,
      {
        maxBytes: MAX_CONFIG_BYTES,
        preserveCorruptFile: true,
        normalize: normalizeConfig,
        isSafe: (value) => isWorkspaceConfig(value),
        reloadBeforeWrite: true,
        rejectExternalChanges: true,
        rejectUnsafeWrite: true,
      },
    );
  }

  private get now(): () => number {
    return this.options.now ?? Date.now;
  }

  private serialized<Result>(operation: () => Promise<Result>): Promise<Result> {
    const result = this.mutationTail.then(operation, operation);
    this.mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async initialize(): Promise<void> {
    if (!this.initializePromise) {
      this.initializePromise = (async () => {
        await fs.mkdir(this.rootDirectory, { recursive: true, mode: 0o700 });
        const rootInfo = await fs.lstat(this.rootDirectory);
        if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
          throw new CreateImagesWorkspaceError(
            "workspace_config_invalid",
            "The Create Images config root is not a regular directory.",
          );
        }
        this.config = cloneConfig(await this.configStore.load());
        this.configCorrupt = await this.configStore.loadedFromCorruptFile();
        this.configUnsafe = await this.configStore.loadedFromUnsafeFile();
        this.configHealthy = !this.configCorrupt && !this.configUnsafe;
      })();
    }
    try {
      await this.initializePromise;
    } catch (error) {
      this.initializePromise = undefined;
      throw error;
    }
  }

  private async configuredRoot(): Promise<WorkspaceRootContext> {
    if (!this.configHealthy) {
      throw new CreateImagesWorkspaceError(
        "workspace_config_invalid",
        "The Create Images workspace configuration needs repair.",
      );
    }
    if (!this.config.selectedPath || !this.config.workspaceId || !this.config.identity) {
      throw new CreateImagesWorkspaceError(
        "workspace_not_configured",
        "No Create Images workspace directory has been configured.",
      );
    }
    const info = await safeLstat(this.config.selectedPath);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new CreateImagesWorkspaceError(
        "workspace_root_unsafe",
        "The configured Create Images workspace is not a regular directory.",
      );
    }
    const identity = await identityFor(this.config.selectedPath);
    if (!sameIdentity(identity, this.config.identity)) {
      throw new CreateImagesWorkspaceError(
        "workspace_root_changed",
        "The configured Create Images workspace was replaced or moved.",
      );
    }
    const marker = await readWorkspaceMarker(this.config.selectedPath);
    if (!marker) {
      throw new CreateImagesWorkspaceError(
        "workspace_marker_missing",
        "The configured Create Images workspace marker is missing.",
      );
    }
    if (marker.workspaceId !== this.config.workspaceId) {
      throw new CreateImagesWorkspaceError(
        "workspace_marker_conflict",
        "The configured directory belongs to another Create Images workspace.",
      );
    }
    return { selectedPath: this.config.selectedPath, identity };
  }

  private async writableRoot(context: WorkspaceRootContext): Promise<boolean> {
    try {
      await fs.access(context.selectedPath, constants.W_OK);
      await fs.access(path.join(context.selectedPath, "Imports"), constants.W_OK);
      await fs.access(path.join(context.selectedPath, "Generated"), constants.W_OK);
      return true;
    } catch {
      return false;
    }
  }

  private statusFromConfig(
    state: CreateImagesWorkspaceState,
    writable: boolean,
  ): CreateImagesWorkspaceStatus {
    const entries = Object.values(this.config.entries);
    const materialized = entries.filter((entry) => entry.state === "materialized");
    return {
      state,
      configured: this.config.selectedPath !== null,
      ...(this.config.workspaceId ? { workspaceId: this.config.workspaceId } : {}),
      ...(this.config.selectedPath
        ? { displayName: path.basename(this.config.selectedPath) || "Workspace" }
        : {}),
      ...(this.config.lastSyncedAt ? { lastSyncedAt: this.config.lastSyncedAt } : {}),
      revision: this.config.revision,
      entryCount: entries.length,
      materializedCount: materialized.length,
      driftedCount: entries.filter(
        (entry) => entry.state === "drifted" || entry.state === "orphaned",
      ).length,
      conflictCount: entries.filter((entry) => entry.state === "conflict").length,
      importedCount: materialized.filter((entry) => entry.relativePath.startsWith("Imports/"))
        .length,
      generatedCount: materialized.filter((entry) => entry.relativePath.startsWith("Generated/"))
        .length,
      writable,
    };
  }

  private async statusInside(): Promise<CreateImagesWorkspaceStatus> {
    if (!this.configHealthy) return this.statusFromConfig("repair_required", false);
    if (!this.config.selectedPath) return this.statusFromConfig("unconfigured", false);
    try {
      const context = await this.configuredRoot();
      const writable = await this.writableRoot(context);
      return this.statusFromConfig(writable ? "ready" : "unwritable", writable);
    } catch (error) {
      const code = error instanceof CreateImagesWorkspaceError ? error.code : undefined;
      const state: CreateImagesWorkspaceState =
        code === "workspace_marker_conflict"
          ? "conflict"
          : code === "workspace_root_unsafe"
            ? "conflict"
            : code === "workspace_marker_missing"
              ? "drifted"
              : code === "workspace_not_writable"
                ? "unwritable"
                : code === "workspace_root_missing" || code === "workspace_root_changed"
                  ? "drifted"
                  : "drifted";
      return this.statusFromConfig(state, false);
    }
  }

  async status(): Promise<CreateImagesWorkspaceStatus> {
    return this.serialized(async () => {
      await this.initialize();
      return this.statusInside();
    });
  }

  async configureChosenDirectory(directory: string): Promise<CreateImagesWorkspaceStatus> {
    return this.serialized(async () => {
      await this.initialize();
      if (!this.configHealthy && !this.configCorrupt) {
        throw new CreateImagesWorkspaceError(
          "workspace_config_invalid",
          "The Create Images workspace configuration needs repair.",
        );
      }
      const requestedPath = assertAbsoluteDirectoryPath(directory);
      const requestedInfo = await safeLstat(requestedPath);
      if (requestedInfo.isSymbolicLink() || !requestedInfo.isDirectory()) {
        throw new CreateImagesWorkspaceError(
          "workspace_root_unsafe",
          "The selected Create Images workspace must be a regular directory, not a symlink.",
        );
      }
      const selectedPath = await fs.realpath(requestedPath);
      const identity = await identityFor(selectedPath);
      const sameConfiguredPath =
        this.config.selectedPath === selectedPath &&
        this.config.identity !== null &&
        sameIdentity(this.config.identity, identity);
      const marker = await readWorkspaceMarker(selectedPath);
      const workspaceId =
        sameConfiguredPath && this.config.workspaceId
          ? this.config.workspaceId
          : this.configCorrupt && marker
            ? marker.workspaceId
            : randomUUID();
      if (marker && marker.workspaceId !== workspaceId) {
        throw new CreateImagesWorkspaceError(
          "workspace_marker_conflict",
          "The selected directory belongs to another Create Images workspace.",
        );
      }
      await createWorkspaceMarker(selectedPath, workspaceId);
      await createWorkspaceReadme(selectedPath);
      await ensureDirectoryChild(selectedPath, "Imports");
      await ensureDirectoryChild(selectedPath, "Generated");
      const next: WorkspaceConfig = {
        schemaVersion: WORKSPACE_SCHEMA_VERSION,
        revision: this.config.revision + 1,
        selectedPath,
        workspaceId,
        identity,
        lastSyncedAt: sameConfiguredPath ? this.config.lastSyncedAt : null,
        entries: sameConfiguredPath ? this.config.entries : {},
      };
      try {
        await this.configStore.save(next);
      } catch (error) {
        if (error instanceof DataStoreExternalChangeError) {
          throw new CreateImagesWorkspaceError(
            "workspace_config_conflict",
            "The Create Images workspace configuration changed outside Aiden.",
          );
        }
        throw error;
      }
      this.config = cloneConfig(next);
      this.configCorrupt = false;
      this.configUnsafe = false;
      this.configHealthy = true;
      const assets = await this.assets.list();
      await this.syncAssets(assets, true);
      return this.statusInside();
    });
  }

  async preflight(): Promise<CreateImagesWorkspacePreflight> {
    return this.serialized(async () => {
      await this.initialize();
      const base = await this.statusInside();
      const issues: CreateImagesWorkspacePreflightIssue[] = [];
      if (!this.configHealthy) {
        issues.push({ code: "root_unsafe" });
        return { ...base, ok: false, issues };
      }
      if (!this.config.selectedPath)
        return { ...base, ok: false, issues: [{ code: "root_missing" }] };
      let context: WorkspaceRootContext;
      try {
        context = await this.configuredRoot();
      } catch (error) {
        const code = error instanceof CreateImagesWorkspaceError ? error.code : undefined;
        const issue: CreateImagesWorkspacePreflightIssue =
          code === "workspace_root_changed"
            ? { code: "root_changed" }
            : code === "workspace_root_missing"
              ? { code: "root_missing" }
              : code === "workspace_marker_missing"
                ? { code: "marker_missing" }
                : code === "workspace_marker_conflict"
                  ? { code: "marker_conflict" }
                  : { code: "root_unsafe" };
        return { ...base, ok: false, issues: [issue] };
      }
      if (!(await this.writableRoot(context))) issues.push({ code: "not_writable" });
      for (const directory of ["Imports", "Generated"] as const) {
        try {
          const info = await fs.lstat(path.join(context.selectedPath, directory));
          if (info.isSymbolicLink() || !info.isDirectory())
            issues.push({ code: "directory_unsafe" });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT")
            issues.push({ code: "directory_missing" });
          else issues.push({ code: "directory_unsafe" });
        }
      }
      for (const entry of Object.values(this.config.entries)) {
        const target = path.join(context.selectedPath, ...entry.relativePath.split("/"));
        const inspection = await inspectTarget(target, entry.assetId, entry.byteLength);
        if (inspection === "missing")
          issues.push({ code: "target_missing", assetId: entry.assetId });
        else if (inspection === "conflict")
          issues.push({ code: "target_conflict", assetId: entry.assetId });
      }
      return { ...base, ok: issues.length === 0, issues };
    });
  }

  private async syncOne(
    context: WorkspaceRootContext,
    asset: AssetMetadataDto,
  ): Promise<"materialized" | "already" | "conflict"> {
    const relativePath = createImagesWorkspaceRelativePath(asset);
    const destination = path.join(context.selectedPath, ...relativePath.split("/"));
    const current = await inspectTarget(destination, asset.assetId, asset.byteLength);
    if (current === "materialized") return "already";
    if (current === "conflict") return "conflict";
    const parent = path.dirname(destination);
    const parentInfo = await fs.lstat(parent);
    if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory()) {
      throw new CreateImagesWorkspaceError(
        "workspace_root_unsafe",
        "The workspace materialization directory is not safe.",
        asset.assetId,
      );
    }
    const result = await this.assets.withAssetFile(asset.assetId, async (source) => {
      if (source.asset.assetId !== asset.assetId || source.byteLength !== asset.byteLength) {
        throw new CreateImagesWorkspaceError(
          "workspace_sync_failed",
          "The canonical asset metadata changed during workspace sync.",
          asset.assetId,
        );
      }
      return copyVerifiedFile(source.filePath, destination, asset.assetId, asset.byteLength);
    });
    if (result === "conflict") return "conflict";
    const final = await inspectTarget(destination, asset.assetId, asset.byteLength);
    if (final !== "materialized") {
      throw new CreateImagesWorkspaceError(
        "workspace_sync_failed",
        "The workspace target could not be verified after publication.",
        asset.assetId,
      );
    }
    return "materialized";
  }

  private async syncAssets(
    assets: AssetMetadataDto[],
    fullInventory = false,
  ): Promise<CreateImagesWorkspaceSyncResult> {
    const base = await this.statusInside();
    if (base.state !== "ready") {
      return {
        state: base.state,
        revision: base.revision,
        totalAssets: assets.length,
        materializedAssetIds: [],
        alreadyMaterializedAssetIds: [],
        conflictedAssetIds: [],
        driftedAssetIds: [],
        failed: [],
      };
    }
    const context = await this.configuredRoot();
    const next = cloneConfig(this.config);
    const materializedAssetIds: string[] = [];
    const alreadyMaterializedAssetIds: string[] = [];
    const conflictedAssetIds: string[] = [];
    const driftedAssetIds: string[] = [];
    const failed: Array<{ assetId: string; message: string }> = [];
    if (fullInventory) {
      const active = new Set(assets.map((asset) => asset.assetId));
      for (const entry of Object.values(next.entries)) {
        if (!active.has(entry.assetId)) entry.state = "orphaned";
      }
    }
    for (const asset of assets) {
      try {
        const result = await this.syncOne(context, asset);
        const relativePath = createImagesWorkspaceRelativePath(asset);
        const entry: WorkspaceEntry = {
          assetId: asset.assetId,
          relativePath,
          mediaType: asset.mediaType,
          byteLength: asset.byteLength,
          state: result === "conflict" ? "conflict" : "materialized",
          updatedAt: nowIso(this.now),
        };
        next.entries[asset.assetId] = entry;
        if (result === "materialized") materializedAssetIds.push(asset.assetId);
        else if (result === "already") alreadyMaterializedAssetIds.push(asset.assetId);
        else conflictedAssetIds.push(asset.assetId);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "The asset could not be materialized.";
        failed.push({ assetId: asset.assetId, message });
        if (
          error instanceof CreateImagesWorkspaceError &&
          error.code === "workspace_root_changed"
        ) {
          driftedAssetIds.push(asset.assetId);
          break;
        }
        const previous = next.entries[asset.assetId];
        if (previous) previous.state = "drifted";
      }
    }
    const entriesChanged = JSON.stringify(next.entries) !== JSON.stringify(this.config.entries);
    const changed = entriesChanged || (assets.length > 0 && this.config.lastSyncedAt === null);
    if (changed) {
      next.lastSyncedAt = nowIso(this.now);
      next.revision += 1;
      try {
        await this.configStore.save(next);
      } catch (error) {
        if (error instanceof DataStoreExternalChangeError) {
          throw new CreateImagesWorkspaceError(
            "workspace_config_conflict",
            "The Create Images workspace configuration changed outside Aiden.",
          );
        }
        throw error;
      }
      this.config = next;
    }
    const state: CreateImagesWorkspaceState =
      conflictedAssetIds.length > 0
        ? "conflict"
        : failed.length > 0 || driftedAssetIds.length > 0
          ? "drifted"
          : "ready";
    return {
      state,
      revision: this.config.revision,
      totalAssets: assets.length,
      materializedAssetIds: materializedAssetIds.sort(),
      alreadyMaterializedAssetIds: alreadyMaterializedAssetIds.sort(),
      conflictedAssetIds: conflictedAssetIds.sort(),
      driftedAssetIds: driftedAssetIds.sort(),
      failed,
    };
  }

  async syncAll(): Promise<CreateImagesWorkspaceSyncResult> {
    return this.serialized(async () => {
      await this.initialize();
      const assets = this.configHealthy ? await this.assets.list() : [];
      return this.syncAssets(assets, true);
    });
  }

  async syncAsset(assetId: string): Promise<CreateImagesWorkspaceSyncResult> {
    return this.serialized(async () => {
      await this.initialize();
      if (!ASSET_ID.test(assetId)) {
        throw new CreateImagesWorkspaceError("workspace_asset_missing", "The asset ID is invalid.");
      }
      const asset = await this.assets.get(assetId);
      if (!asset) {
        throw new CreateImagesWorkspaceError(
          "workspace_asset_missing",
          "The requested asset does not exist.",
          assetId,
        );
      }
      return this.syncAssets([asset]);
    });
  }

  async openTarget(assetId: string): Promise<CreateImagesWorkspaceOpenTarget> {
    return this.serialized(async () => {
      await this.initialize();
      if (!ASSET_ID.test(assetId)) {
        throw new CreateImagesWorkspaceError("workspace_asset_missing", "The asset ID is invalid.");
      }
      const asset = await this.assets.get(assetId);
      if (!asset) {
        throw new CreateImagesWorkspaceError(
          "workspace_asset_missing",
          "The requested asset does not exist.",
          assetId,
        );
      }
      const context = await this.configuredRoot();
      const relativePath = createImagesWorkspaceRelativePath(asset);
      const filePath = path.join(context.selectedPath, ...relativePath.split("/"));
      const inspection = await inspectTarget(filePath, asset.assetId, asset.byteLength);
      if (inspection === "missing") {
        throw new CreateImagesWorkspaceError(
          "workspace_target_missing",
          "The workspace copy is missing.",
          assetId,
        );
      }
      if (inspection === "conflict") {
        throw new CreateImagesWorkspaceError(
          "workspace_target_conflict",
          "The workspace copy is not an Aiden-created asset.",
          assetId,
        );
      }
      return { filePath, assetId, relativePath };
    });
  }

  async openRoot(): Promise<CreateImagesWorkspaceOpenRoot> {
    return this.serialized(async () => {
      await this.initialize();
      const context = await this.configuredRoot();
      return {
        filePath: context.selectedPath,
        displayName: path.basename(context.selectedPath) || "Workspace",
      };
    });
  }
}
