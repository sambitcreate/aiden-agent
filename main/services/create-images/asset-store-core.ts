import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { DataStore, DataStoreUnsafeWriteError } from "../data-store.js";
import { CREATE_IMAGES_MAX_TOTAL_ASSET_BYTES } from "../../../renderer/shared/create-images/schema.js";
import {
  AssetImageValidationError,
  type AssetImageLimits,
  type SafeAssetExtension,
  type SafeAssetMediaType,
  type ValidatedImageDescriptor,
  sanitizeAssetDisplayName,
  validateImageBytes,
} from "./asset-image-validation-core.js";
import { ByteBoundedLru } from "./asset-thumbnail-cache-core.js";

const ASSET_ID = /^[a-f0-9]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const PREVIEW_TOKEN = /^[A-Za-z0-9_-]{43}$/u;
const REQUIRED_REFERENCE_KINDS = ["export", "run", "workflow"] as const;
const THUMBNAIL_MEDIA_TYPE = "image/png" as const;

export type AssetReferenceKind = (typeof REQUIRED_REFERENCE_KINDS)[number];

export type AssetOrigin =
  | { kind: "import" }
  | { kind: "annotation"; sourceAssetId: string }
  | { kind: "provider"; providerId: string; modelId: string; runId: string }
  | { kind: "repair" };

export interface AssetReferenceOwner {
  kind: AssetReferenceKind;
  id: string;
}

export interface AssetReferenceRecord extends AssetReferenceOwner {
  assetIds: readonly string[];
}

export interface AssetReferenceSnapshot {
  /** Monotonic authority epoch owned by the workflow/run/export stores. */
  epoch: string;
  completeKinds: readonly AssetReferenceKind[];
  records: readonly AssetReferenceRecord[];
}

/**
 * The implementation must hold its mutation/read lock for the full callback.
 * GC relies on this fence remaining held through the final asset unlink.
 */
export interface AssetReferenceAuthority {
  withSnapshot<Result>(
    callback: (snapshot: AssetReferenceSnapshot) => Promise<Result>,
  ): Promise<Result>;
}

export interface AssetDeepValidator {
  validate(input: {
    /** Main-process-only quarantine path; it must never cross IPC. */
    filePath: string;
    descriptor: ValidatedImageDescriptor;
    byteLength: number;
  }): Promise<{ width: number; height: number }>;
}

export interface AssetThumbnailGenerator {
  generate(input: {
    /** Main-process-only immutable asset path; it must never cross IPC. */
    sourcePath: string;
    source: ValidatedImageDescriptor;
    maxDimension: number;
    maxOutputBytes: number;
  }): Promise<{ bytes: Uint8Array; width: number; height: number; mediaType: "image/png" }>;
}

export interface AssetStoreLimits extends AssetImageLimits {
  maxImportBytes: number;
  maxProviderResponseBytes: number;
  totalAssetBytes: number;
  warningAssetBytes: number;
  maxAssets: number;
  maxReferenceRecords: number;
  maxReferenceLinks: number;
  maxIndexBytes: number;
  maxRepairEntries: number;
  maxPreviewReadBytes: number;
  maxPreviewLeases: number;
  maxThumbnailBytes: number;
  thumbnailCacheBytes: number;
  thumbnailSizes: readonly number[];
}

export const DEFAULT_ASSET_STORE_LIMITS: Readonly<AssetStoreLimits> = Object.freeze({
  maxImportBytes: 64 * 1024 * 1024,
  maxProviderResponseBytes: 64 * 1024 * 1024,
  maxWidth: 32_768,
  maxHeight: 32_768,
  // A decode can still approach 64 MiB as RGBA. Codec work is isolated in a
  // disposable sandboxed renderer, and this ceiling keeps one decoder bounded on
  // supported hardware even for highly compressed images.
  maxPixels: 16_000_000,
  totalAssetBytes: CREATE_IMAGES_MAX_TOTAL_ASSET_BYTES,
  warningAssetBytes: 8 * 1024 * 1024 * 1024,
  maxAssets: 100_000,
  maxReferenceRecords: 100_000,
  maxReferenceLinks: 1_000_000,
  maxIndexBytes: 64 * 1024 * 1024,
  maxRepairEntries: 200_000,
  maxPreviewReadBytes: 64 * 1024 * 1024,
  maxPreviewLeases: 4_096,
  maxThumbnailBytes: 4 * 1024 * 1024,
  thumbnailCacheBytes: 64 * 1024 * 1024,
  thumbnailSizes: [128, 256, 512],
});

export interface AssetMetadataDto {
  assetId: string;
  mediaType: SafeAssetMediaType;
  byteLength: number;
  width: number;
  height: number;
  createdAt: string;
  displayName?: string;
  origin: AssetOrigin;
  generationMetadata?: Readonly<Record<string, string | number | boolean | null>>;
  referenceCount: number;
  thumbnailSizes: number[];
}

export interface AssetIngestRequest {
  origin: Exclude<AssetOrigin, { kind: "repair" }>;
  declaredMimeType?: string;
  displayName?: string;
  /**
   * Main-owned canonical filename used only for content/extension validation.
   * Normalized imports keep their original display name while stored bytes use
   * Aiden's canonical PNG extension.
   */
  validationDisplayName?: string;
  generationMetadata?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface AssetIngestResult {
  asset: AssetMetadataDto;
  deduplicated: boolean;
  quotaWarning: boolean;
  totalAssetBytes: number;
}

export interface ValidatedQuarantinedAsset {
  sha256: string;
  mediaType: SafeAssetMediaType;
  byteLength: number;
  width: number;
  height: number;
}

export interface AssetPreviewLeaseDto {
  token: string;
  assetId: string;
  expiresAt: number;
}

export interface AssetPreviewDto {
  asset: AssetMetadataDto;
  bytes: Uint8Array;
}

export interface AssetThumbnailDto {
  assetId: string;
  mediaType: typeof THUMBNAIL_MEDIA_TYPE;
  width: number;
  height: number;
  byteLength: number;
  bytes: Uint8Array;
}

export interface AssetRepairReport {
  applied: boolean;
  indexWasUnhealthy: boolean;
  addedAssetIds: string[];
  removedAssetIds: string[];
  correctedAssetIds: string[];
  quarantinedEntryIds: string[];
  invalidEntries: Array<{ entryId: string; reason: string }>;
  missingReferenceAssetIds: string[];
}

export interface AssetGarbageCollectionPlanDto {
  planId: string;
  createdAt: number;
  expiresAt: number;
  indexRevision: number;
  referenceEpoch: string;
  candidateAssetIds: string[];
  reclaimableBytes: number;
}

export interface AssetGarbageCollectionResult {
  applied: boolean;
  stale: boolean;
  deletedAssetIds: string[];
  reclaimedBytes: number;
  skipped: Array<{
    assetId: string;
    reason: "lease_active" | "not_found" | "referenced" | "too_new";
  }>;
}

export class AssetStoreError extends Error {
  constructor(
    public readonly code:
      | "asset_not_found"
      | "asset_source_missing"
      | "asset_store_repair_required"
      | "asset_store_quota_exceeded"
      | "asset_ingest_too_large"
      | "asset_index_limit_exceeded"
      | "invalid_asset_request"
      | "preview_lease_invalid"
      | "preview_too_large"
      | "thumbnail_unavailable",
    message: string,
  ) {
    super(message);
    this.name = "AssetStoreError";
  }
}

interface StoredThumbnail {
  mediaType: typeof THUMBNAIL_MEDIA_TYPE;
  byteLength: number;
  width: number;
  height: number;
  updatedAt: string;
}

interface StoredAsset {
  assetId: string;
  extension: SafeAssetExtension;
  mediaType: SafeAssetMediaType;
  byteLength: number;
  width: number;
  height: number;
  createdAt: string;
  displayName?: string;
  origin: AssetOrigin;
  generationMetadata?: Record<string, string | number | boolean | null>;
  referenceOwners: string[];
  unreferencedAt?: string;
  thumbnails: Record<string, StoredThumbnail>;
}

interface AssetIndexV1 {
  schemaVersion: 1;
  revision: number;
  assets: Record<string, StoredAsset>;
}

interface PreviewLease {
  token: string;
  assetId: string;
  ownerId: string;
  expiresAt: number;
}

interface InternalGcPlan extends AssetGarbageCollectionPlanDto {
  graceMs: number;
  referenceFingerprint: string;
}

interface ThumbnailCacheEntry {
  mediaType: typeof THUMBNAIL_MEDIA_TYPE;
  width: number;
  height: number;
  byteLength: number;
  bytes: Uint8Array;
}

interface ScannedAsset {
  entryId: string;
  filePath: string;
  descriptor: ValidatedImageDescriptor;
  byteLength: number;
  createdAt: string;
}

interface InvalidScannedEntry {
  entryId: string;
  filePath: string;
  reason: string;
}

const EMPTY_INDEX: AssetIndexV1 = { schemaVersion: 1, revision: 0, assets: {} };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStoredAsset(
  value: unknown,
  key: string,
  limits: AssetStoreLimits,
): value is StoredAsset {
  if (!isRecord(value)) return false;
  if (value.assetId !== key || !ASSET_ID.test(key)) return false;
  if (value.extension !== "jpg" && value.extension !== "png") return false;
  if (value.mediaType !== "image/jpeg" && value.mediaType !== "image/png") return false;
  if (
    (value.extension === "png" && value.mediaType !== "image/png") ||
    (value.extension === "jpg" && value.mediaType !== "image/jpeg")
  ) {
    return false;
  }
  const createdAt = typeof value.createdAt === "string" ? Date.parse(value.createdAt) : Number.NaN;
  const unreferencedAt =
    value.unreferencedAt === undefined
      ? undefined
      : typeof value.unreferencedAt === "string"
        ? Date.parse(value.unreferencedAt)
        : Number.NaN;
  const referenceOwners = value.referenceOwners;
  if (
    !Number.isSafeInteger(value.byteLength) ||
    (value.byteLength as number) < 1 ||
    (value.byteLength as number) >
      Math.max(limits.maxImportBytes, limits.maxProviderResponseBytes) ||
    !Number.isSafeInteger(value.width) ||
    (value.width as number) < 1 ||
    (value.width as number) > limits.maxWidth ||
    !Number.isSafeInteger(value.height) ||
    (value.height as number) < 1 ||
    (value.height as number) > limits.maxHeight ||
    (value.width as number) * (value.height as number) > limits.maxPixels ||
    !Number.isFinite(createdAt) ||
    (unreferencedAt !== undefined && !Number.isFinite(unreferencedAt)) ||
    !Array.isArray(referenceOwners) ||
    referenceOwners.length > limits.maxReferenceRecords ||
    new Set(referenceOwners).size !== referenceOwners.length ||
    !referenceOwners.every(
      (owner) =>
        typeof owner === "string" &&
        /^(?:workflow|run|export):[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(owner),
    ) ||
    !isRecord(value.thumbnails)
  ) {
    return false;
  }
  if (
    value.displayName !== undefined &&
    (typeof value.displayName !== "string" ||
      sanitizeAssetDisplayName(value.displayName) !== value.displayName)
  ) {
    return false;
  }
  try {
    validateOrigin(value.origin as AssetOrigin);
    validateGenerationMetadata(
      value.generationMetadata as
        | Readonly<Record<string, string | number | boolean | null>>
        | undefined,
    );
  } catch {
    return false;
  }
  for (const [size, thumbnail] of Object.entries(value.thumbnails)) {
    if (!limits.thumbnailSizes.includes(Number(size)) || !isRecord(thumbnail)) return false;
    if (
      thumbnail.mediaType !== THUMBNAIL_MEDIA_TYPE ||
      !Number.isSafeInteger(thumbnail.byteLength) ||
      (thumbnail.byteLength as number) < 33 ||
      (thumbnail.byteLength as number) > limits.maxThumbnailBytes ||
      !Number.isSafeInteger(thumbnail.width) ||
      (thumbnail.width as number) < 1 ||
      (thumbnail.width as number) > Number(size) ||
      !Number.isSafeInteger(thumbnail.height) ||
      (thumbnail.height as number) < 1 ||
      (thumbnail.height as number) > Number(size) ||
      typeof thumbnail.updatedAt !== "string" ||
      !Number.isFinite(Date.parse(thumbnail.updatedAt))
    ) {
      return false;
    }
  }
  return true;
}

function isAssetIndex(value: unknown, limits: AssetStoreLimits): value is AssetIndexV1 {
  if (!isRecord(value) || value.schemaVersion !== 1 || !Number.isSafeInteger(value.revision)) {
    return false;
  }
  if (!isRecord(value.assets)) return false;
  const entries = Object.entries(value.assets);
  if (entries.length > limits.maxAssets) return false;
  let aggregateBytes = 0;
  for (const [key, asset] of entries) {
    if (!isStoredAsset(asset, key, limits)) return false;
    if (asset.byteLength > limits.totalAssetBytes - aggregateBytes) return false;
    aggregateBytes += asset.byteLength;
  }
  return true;
}

function cloneEmptyIndex(): AssetIndexV1 {
  return structuredClone(EMPTY_INDEX);
}

function assertSafeId(value: string, label: string): void {
  if (!SAFE_ID.test(value)) {
    throw new AssetStoreError(
      "invalid_asset_request",
      `${label} must be a short opaque identifier.`,
    );
  }
}

function assertAssetId(assetId: string): void {
  if (!ASSET_ID.test(assetId)) {
    throw new AssetStoreError("invalid_asset_request", "Asset IDs must be SHA-256 identifiers.");
  }
}

function validateOrigin(origin: AssetOrigin): AssetOrigin {
  if (origin.kind === "import" || origin.kind === "repair") return { kind: origin.kind };
  if (origin.kind === "annotation") {
    assertAssetId(origin.sourceAssetId);
    return { kind: "annotation", sourceAssetId: origin.sourceAssetId };
  }
  if (origin.kind === "provider") {
    assertSafeId(origin.providerId, "Provider ID");
    assertSafeId(origin.modelId, "Model ID");
    assertSafeId(origin.runId, "Run ID");
    return {
      kind: "provider",
      providerId: origin.providerId,
      modelId: origin.modelId,
      runId: origin.runId,
    };
  }
  throw new AssetStoreError("invalid_asset_request", "The asset origin is unsupported.");
}

function validateGenerationMetadata(
  value: Readonly<Record<string, string | number | boolean | null>> | undefined,
): Record<string, string | number | boolean | null> | undefined {
  if (value === undefined) return undefined;
  const entries = Object.entries(value);
  if (entries.length > 32) {
    throw new AssetStoreError("invalid_asset_request", "Generation metadata has too many fields.");
  }
  const result: Record<string, string | number | boolean | null> = {};
  for (const [key, item] of entries) {
    if (!/^[A-Za-z][A-Za-z0-9._-]{0,63}$/u.test(key)) {
      throw new AssetStoreError(
        "invalid_asset_request",
        "Generation metadata contains an invalid key.",
      );
    }
    if (typeof item === "string" && item.length > 1_024) {
      throw new AssetStoreError(
        "invalid_asset_request",
        "Generation metadata contains a long string.",
      );
    }
    if (typeof item === "number" && !Number.isFinite(item)) {
      throw new AssetStoreError(
        "invalid_asset_request",
        "Generation metadata contains a non-finite number.",
      );
    }
    if (item !== null && !["string", "number", "boolean"].includes(typeof item)) {
      throw new AssetStoreError(
        "invalid_asset_request",
        "Generation metadata contains an invalid value.",
      );
    }
    result[key] = item;
  }
  return result;
}

function validateLimits(limits: AssetStoreLimits): void {
  const integerKeys: Array<keyof AssetStoreLimits> = [
    "maxImportBytes",
    "maxProviderResponseBytes",
    "maxWidth",
    "maxHeight",
    "maxPixels",
    "totalAssetBytes",
    "warningAssetBytes",
    "maxAssets",
    "maxReferenceRecords",
    "maxReferenceLinks",
    "maxIndexBytes",
    "maxRepairEntries",
    "maxPreviewReadBytes",
    "maxPreviewLeases",
    "maxThumbnailBytes",
    "thumbnailCacheBytes",
  ];
  if (
    integerKeys.some((key) => !Number.isSafeInteger(limits[key]) || (limits[key] as number) < 1)
  ) {
    throw new Error("Asset store limits must be positive safe integers.");
  }
  if (limits.warningAssetBytes > limits.totalAssetBytes) {
    throw new Error("The asset warning threshold cannot exceed the total quota.");
  }
  if (
    limits.thumbnailSizes.length < 1 ||
    limits.thumbnailSizes.length > 16 ||
    limits.thumbnailSizes.some(
      (size) => !Number.isSafeInteger(size) || size < 16 || size > 4_096,
    ) ||
    new Set(limits.thumbnailSizes).size !== limits.thumbnailSizes.length
  ) {
    throw new Error("Thumbnail sizes must be a bounded list of unique dimensions.");
  }
}

function ownerKey(owner: AssetReferenceOwner): string {
  if (!REQUIRED_REFERENCE_KINDS.includes(owner.kind)) {
    throw new AssetStoreError("invalid_asset_request", "The asset reference kind is unsupported.");
  }
  assertSafeId(owner.id, "Reference owner ID");
  return `${owner.kind}:${owner.id}`;
}

function descriptorFor(asset: StoredAsset): ValidatedImageDescriptor {
  return {
    mediaType: asset.mediaType,
    extension: asset.extension,
    width: asset.width,
    height: asset.height,
    pixels: asset.width * asset.height,
  };
}

function metadataDto(asset: StoredAsset): AssetMetadataDto {
  return {
    assetId: asset.assetId,
    mediaType: asset.mediaType,
    byteLength: asset.byteLength,
    width: asset.width,
    height: asset.height,
    createdAt: asset.createdAt,
    ...(asset.displayName ? { displayName: asset.displayName } : {}),
    origin: structuredClone(asset.origin),
    ...(asset.generationMetadata
      ? { generationMetadata: structuredClone(asset.generationMetadata) }
      : {}),
    referenceCount: asset.referenceOwners.length,
    thumbnailSizes: Object.keys(asset.thumbnails)
      .map(Number)
      .sort((left, right) => left - right),
  };
}

function thumbnailCacheEntry(
  metadata: Pick<StoredThumbnail, "mediaType" | "byteLength" | "width" | "height">,
  bytes: Uint8Array,
): ThumbnailCacheEntry {
  return {
    mediaType: metadata.mediaType,
    byteLength: metadata.byteLength,
    width: metadata.width,
    height: metadata.height,
    bytes: bytes.slice(),
  };
}

function totalBytes(index: AssetIndexV1): number {
  return Object.values(index.assets).reduce((sum, asset) => sum + asset.byteLength, 0);
}

function validateReferenceSnapshot(
  snapshot: AssetReferenceSnapshot,
  limits: AssetStoreLimits,
): Map<string, Set<string>> {
  if (!SAFE_ID.test(snapshot.epoch)) {
    throw new AssetStoreError("invalid_asset_request", "The reference snapshot epoch is invalid.");
  }
  const kinds = [...new Set(snapshot.completeKinds)].sort();
  if (
    kinds.length !== REQUIRED_REFERENCE_KINDS.length ||
    !REQUIRED_REFERENCE_KINDS.every((kind, index) => kind === kinds[index])
  ) {
    throw new AssetStoreError(
      "invalid_asset_request",
      "Asset reference snapshots must cover workflows, runs, and exports.",
    );
  }
  const byAsset = new Map<string, Set<string>>();
  const owners = new Set<string>();
  let referenceLinks = 0;
  if (snapshot.records.length > limits.maxReferenceRecords) {
    throw new AssetStoreError(
      "invalid_asset_request",
      "The reference snapshot has too many owners.",
    );
  }
  for (const record of snapshot.records) {
    const key = ownerKey(record);
    if (owners.has(key)) {
      throw new AssetStoreError(
        "invalid_asset_request",
        "The reference snapshot repeats an owner.",
      );
    }
    owners.add(key);
    referenceLinks += record.assetIds.length;
    if (
      referenceLinks > limits.maxReferenceLinks ||
      record.assetIds.length > limits.maxAssets ||
      new Set(record.assetIds).size !== record.assetIds.length
    ) {
      throw new AssetStoreError(
        "invalid_asset_request",
        "The reference snapshot contains invalid asset IDs.",
      );
    }
    for (const assetId of record.assetIds) {
      assertAssetId(assetId);
      const assetOwners = byAsset.get(assetId) ?? new Set<string>();
      assetOwners.add(key);
      byAsset.set(assetId, assetOwners);
    }
  }
  return byAsset;
}

function referenceFingerprint(snapshot: AssetReferenceSnapshot): string {
  const canonical = snapshot.records
    .map((record) => [ownerKey(record), [...record.assetIds].sort()] as const)
    .sort(([left], [right]) => left.localeCompare(right));
  return createHash("sha256")
    .update(JSON.stringify([snapshot.epoch, [...snapshot.completeKinds].sort(), canonical]))
    .digest("hex");
}

async function readBoundedRegularFile(filePath: string, maxBytes: number): Promise<Uint8Array> {
  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  const handle = await fs.open(filePath, constants.O_RDONLY | noFollow);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size < 1 || before.size > maxBytes) {
      throw new Error("The asset is not a bounded regular file.");
    }
    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= maxBytes) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - total));
      const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, total);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      total += bytesRead;
    }
    if (total > maxBytes) throw new Error("The asset grew beyond its byte limit while reading.");
    const bytes = Buffer.concat(chunks, total);
    const after = await handle.stat();
    if (bytes.byteLength !== before.size || after.size !== before.size) {
      throw new Error("The asset changed while it was being read.");
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function ensureSafeDirectory(directory: string): Promise<void> {
  const created = await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await fs.lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new AssetStoreError(
      "asset_store_repair_required",
      "The asset store contains an unsafe directory entry.",
    );
  }
  if (created !== undefined) await syncDirectory(path.dirname(directory));
}

function isSafeThumbnailPng(bytes: Uint8Array, width: number, height: number): boolean {
  try {
    const descriptor = validateImageBytes(bytes, "image/png", "thumbnail.png", {
      maxWidth: DEFAULT_ASSET_STORE_LIMITS.maxWidth,
      maxHeight: DEFAULT_ASSET_STORE_LIMITS.maxHeight,
      maxPixels: DEFAULT_ASSET_STORE_LIMITS.maxPixels,
    });
    return (
      descriptor.mediaType === "image/png" &&
      descriptor.width === width &&
      descriptor.height === height
    );
  } catch {
    return false;
  }
}

export class ContentAddressedAssetStore {
  private readonly limits: AssetStoreLimits;
  private readonly indexStore: DataStore<AssetIndexV1>;
  private readonly cache: ByteBoundedLru<ThumbnailCacheEntry>;
  private readonly leases = new Map<string, PreviewLease>();
  private readonly gcPlans = new Map<string, InternalGcPlan>();
  private index = cloneEmptyIndex();
  private indexHealthy = true;
  private initializePromise: Promise<void> | undefined;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly rootDirectory: string,
    private readonly referenceAuthority: AssetReferenceAuthority,
    private readonly options: {
      limits?: AssetStoreLimits;
      now?: () => number;
      deepValidator: AssetDeepValidator;
      thumbnailGenerator?: AssetThumbnailGenerator;
      /** Best-effort notification after the asset-store mutation lock is released. */
      onAssetPublished?: (asset: AssetMetadataDto) => Promise<void> | void;
    },
  ) {
    if (!path.isAbsolute(rootDirectory)) throw new Error("The asset store root must be absolute.");
    this.limits = structuredClone(options.limits ?? DEFAULT_ASSET_STORE_LIMITS);
    validateLimits(this.limits);
    this.cache = new ByteBoundedLru(this.limits.thumbnailCacheBytes);
    this.indexStore = new DataStore(
      "asset-index.json",
      cloneEmptyIndex(),
      () => this.rootDirectory,
      {
        maxBytes: this.limits.maxIndexBytes,
        preserveCorruptFile: true,
        normalize: (value) => (isAssetIndex(value, this.limits) ? value : cloneEmptyIndex()),
        isSafe: (value) => isAssetIndex(value, this.limits),
        rejectUnsafeWrite: false,
        reloadBeforeWrite: true,
        rejectExternalChanges: true,
      },
    );
  }

  private get now(): () => number {
    return this.options.now ?? Date.now;
  }

  private async initialize(): Promise<void> {
    if (!this.initializePromise) {
      this.initializePromise = (async () => {
        await ensureSafeDirectory(this.rootDirectory);
        await ensureSafeDirectory(path.join(this.rootDirectory, "assets"));
        await ensureSafeDirectory(this.assetsDirectory);
        await ensureSafeDirectory(this.thumbnailDirectory);
        await ensureSafeDirectory(this.quarantineDirectory);
        this.index = structuredClone(await this.indexStore.load());
        this.indexHealthy =
          !(await this.indexStore.loadedFromCorruptFile()) &&
          !(await this.indexStore.loadedFromUnsafeFile());
      })();
    }
    await this.initializePromise;
  }

  private serialized<Result>(operation: () => Promise<Result>): Promise<Result> {
    const result = this.mutationTail.then(operation, operation);
    this.mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private get assetsDirectory(): string {
    return path.join(this.rootDirectory, "assets", "sha256");
  }

  private get thumbnailDirectory(): string {
    return path.join(this.rootDirectory, "thumbnails");
  }

  private get quarantineDirectory(): string {
    return path.join(this.rootDirectory, "asset-quarantine");
  }

  private assetPath(assetId: string, extension: SafeAssetExtension): string {
    return path.join(this.assetsDirectory, assetId.slice(0, 2), `${assetId}.${extension}`);
  }

  private thumbnailPath(assetId: string, size: number): string {
    return path.join(this.thumbnailDirectory, assetId, `${size}.png`);
  }

  private ensureHealthy(): void {
    if (!this.indexHealthy) {
      throw new AssetStoreError(
        "asset_store_repair_required",
        "The Create Images asset index needs repair before it can be changed or served.",
      );
    }
  }

  private async saveIndex(next: AssetIndexV1): Promise<void> {
    if (Object.keys(next.assets).length > this.limits.maxAssets) {
      throw new AssetStoreError(
        "asset_index_limit_exceeded",
        "The asset index reached its entry limit.",
      );
    }
    try {
      await this.indexStore.save(next);
    } catch (error) {
      if (error instanceof DataStoreUnsafeWriteError) {
        throw new AssetStoreError(
          "asset_index_limit_exceeded",
          "The asset metadata index exceeds its configured byte limit.",
        );
      }
      throw error;
    }
    this.index = next;
    this.indexHealthy = true;
  }

  private pruneRuntimeState(): void {
    const now = this.now();
    for (const [token, lease] of this.leases) {
      if (lease.expiresAt <= now) this.leases.delete(token);
    }
    for (const [planId, plan] of this.gcPlans) {
      if (plan.expiresAt <= now) this.gcPlans.delete(planId);
    }
  }

  async status(): Promise<{
    healthy: boolean;
    assetCount: number;
    totalAssetBytes: number;
    quotaWarning: boolean;
    revision: number;
  }> {
    await this.initialize();
    const bytes = totalBytes(this.index);
    return {
      healthy: this.indexHealthy,
      assetCount: Object.keys(this.index.assets).length,
      totalAssetBytes: bytes,
      quotaWarning: bytes >= this.limits.warningAssetBytes,
      revision: this.index.revision,
    };
  }

  async list(): Promise<AssetMetadataDto[]> {
    await this.initialize();
    this.ensureHealthy();
    return Object.values(this.index.assets)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map(metadataDto);
  }

  async get(assetId: string): Promise<AssetMetadataDto | undefined> {
    assertAssetId(assetId);
    await this.initialize();
    this.ensureHealthy();
    const asset = this.index.assets[assetId];
    return asset ? metadataDto(asset) : undefined;
  }

  private async publishedAssetAvailable(asset: StoredAsset): Promise<boolean> {
    const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
    let handle: fs.FileHandle | undefined;
    try {
      handle = await fs.open(
        this.assetPath(asset.assetId, asset.extension),
        constants.O_RDONLY | constants.O_NONBLOCK | noFollow,
      );
      const info = await handle.stat();
      return info.isFile() && info.size === asset.byteLength;
    } catch {
      return false;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  async getAvailable(assetId: string): Promise<AssetMetadataDto | undefined> {
    assertAssetId(assetId);
    await this.initialize();
    this.ensureHealthy();
    const asset = this.index.assets[assetId];
    return asset && (await this.publishedAssetAvailable(asset)) ? metadataDto(asset) : undefined;
  }

  async ingest(
    source: AsyncIterable<Uint8Array>,
    request: AssetIngestRequest,
  ): Promise<AssetIngestResult> {
    const result = await this.serialized(async () => {
      await this.initialize();
      this.ensureHealthy();
      const origin = validateOrigin(request.origin);
      if (origin.kind === "annotation" && !this.index.assets[origin.sourceAssetId]) {
        throw new AssetStoreError("asset_not_found", "The annotation source asset does not exist.");
      }
      const generationMetadata = validateGenerationMetadata(request.generationMetadata);
      const displayName = sanitizeAssetDisplayName(request.displayName);
      const validationDisplayName = sanitizeAssetDisplayName(request.validationDisplayName);
      const maxBytes =
        origin.kind === "provider"
          ? this.limits.maxProviderResponseBytes
          : this.limits.maxImportBytes;
      const tempPath = path.join(this.quarantineDirectory, `.ingest-${randomUUID()}.tmp`);
      const handle = await fs.open(tempPath, "wx", 0o600);
      const hash = createHash("sha256");
      let byteLength = 0;
      try {
        try {
          for await (const rawChunk of source) {
            if (!(rawChunk instanceof Uint8Array)) {
              throw new AssetStoreError(
                "invalid_asset_request",
                "Asset ingest accepts byte chunks only.",
              );
            }
            if (rawChunk.byteLength === 0) continue;
            const chunk = new Uint8Array(rawChunk.buffer, rawChunk.byteOffset, rawChunk.byteLength);
            byteLength += chunk.byteLength;
            if (byteLength > maxBytes) {
              throw new AssetStoreError(
                "asset_ingest_too_large",
                `The image exceeds the ${maxBytes}-byte ingest limit.`,
              );
            }
            hash.update(chunk);
            let written = 0;
            while (written < chunk.byteLength) {
              const result = await handle.write(chunk, written, chunk.byteLength - written, null);
              if (result.bytesWritten < 1) throw new Error("The asset write made no progress.");
              written += result.bytesWritten;
            }
          }
          if (byteLength < 1) {
            throw new AssetStoreError("invalid_asset_request", "The imported image is empty.");
          }
          await handle.sync();
        } finally {
          await handle.close();
        }
      } catch (error) {
        await fs.rm(tempPath, { force: true }).catch(() => undefined);
        throw error;
      }
      try {
        const bytes = await readBoundedRegularFile(tempPath, maxBytes);
        const descriptor = validateImageBytes(
          bytes,
          request.declaredMimeType,
          validationDisplayName ?? displayName,
          this.limits,
        );
        const decoded = await this.options.deepValidator
          .validate({ filePath: tempPath, descriptor, byteLength })
          .catch(() => {
            throw new AssetStoreError(
              "invalid_asset_request",
              "The safe image decoder rejected the imported image.",
            );
          });
        if (decoded.width !== descriptor.width || decoded.height !== descriptor.height) {
          throw new AssetStoreError(
            "invalid_asset_request",
            "The image decoder dimensions do not match its validated header.",
          );
        }
        const assetId = hash.digest("hex");
        const decoderCheckedBytes = await readBoundedRegularFile(tempPath, maxBytes);
        if (
          decoderCheckedBytes.byteLength !== byteLength ||
          createHash("sha256").update(decoderCheckedBytes).digest("hex") !== assetId
        ) {
          throw new AssetStoreError(
            "invalid_asset_request",
            "The quarantined image changed during validation.",
          );
        }
        const existing = this.index.assets[assetId];
        if (existing) {
          if (
            existing.byteLength !== byteLength ||
            existing.extension !== descriptor.extension ||
            existing.mediaType !== descriptor.mediaType ||
            existing.width !== descriptor.width ||
            existing.height !== descriptor.height
          ) {
            throw new AssetStoreError(
              "asset_store_repair_required",
              "Existing asset metadata does not match the re-imported image.",
            );
          }
          try {
            await this.verifyPublishedAsset(existing);
          } catch (verificationError) {
            const destination = this.assetPath(assetId, existing.extension);
            try {
              await fs.lstat(destination);
              throw verificationError;
            } catch (inspectionError) {
              if ((inspectionError as NodeJS.ErrnoException).code !== "ENOENT") {
                throw inspectionError;
              }
            }
            await ensureSafeDirectory(path.dirname(destination));
            let republished = false;
            try {
              try {
                await fs.link(tempPath, destination);
                republished = true;
                await syncDirectory(path.dirname(destination));
              } catch (publishError) {
                if ((publishError as NodeJS.ErrnoException).code !== "EEXIST") throw publishError;
              }
              await this.verifyPublishedAsset(existing);
            } catch (publishError) {
              if (republished) {
                await fs.rm(destination, { force: true }).catch(() => undefined);
                await syncDirectory(path.dirname(destination)).catch(() => undefined);
              }
              throw publishError;
            }
          }
          const bytesUsed = totalBytes(this.index);
          return {
            asset: metadataDto(existing),
            deduplicated: true,
            quotaWarning: bytesUsed >= this.limits.warningAssetBytes,
            totalAssetBytes: bytesUsed,
          };
        }
        const currentBytes = totalBytes(this.index);
        if (Object.keys(this.index.assets).length >= this.limits.maxAssets) {
          throw new AssetStoreError(
            "asset_index_limit_exceeded",
            "The asset index reached its entry limit.",
          );
        }
        if (currentBytes + byteLength > this.limits.totalAssetBytes) {
          throw new AssetStoreError(
            "asset_store_quota_exceeded",
            "The Create Images asset storage quota is full.",
          );
        }
        const destination = this.assetPath(assetId, descriptor.extension);
        await ensureSafeDirectory(path.dirname(destination));
        let publishedByThisIngest = false;
        try {
          await fs.link(tempPath, destination);
          publishedByThisIngest = true;
          await syncDirectory(path.dirname(destination));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          const published = await readBoundedRegularFile(destination, maxBytes);
          if (
            createHash("sha256").update(published).digest("hex") !== assetId ||
            published.byteLength !== byteLength
          ) {
            throw new AssetStoreError(
              "asset_store_repair_required",
              "A published content-addressed asset does not match its identifier.",
            );
          }
        }
        const createdAt = new Date(this.now()).toISOString();
        const stored: StoredAsset = {
          assetId,
          extension: descriptor.extension,
          mediaType: descriptor.mediaType,
          byteLength,
          width: descriptor.width,
          height: descriptor.height,
          createdAt,
          ...(displayName ? { displayName } : {}),
          origin,
          ...(generationMetadata ? { generationMetadata } : {}),
          referenceOwners: [],
          unreferencedAt: createdAt,
          thumbnails: {},
        };
        const next = structuredClone(this.index);
        next.revision += 1;
        next.assets[assetId] = stored;
        try {
          await this.saveIndex(next);
        } catch (error) {
          if (publishedByThisIngest) {
            await fs.rm(destination, { force: true }).catch(() => undefined);
          }
          throw error;
        }
        const bytesUsed = currentBytes + byteLength;
        return {
          asset: metadataDto(stored),
          deduplicated: false,
          quotaWarning: bytesUsed >= this.limits.warningAssetBytes,
          totalAssetBytes: bytesUsed,
        };
      } finally {
        await fs.rm(tempPath, { force: true }).catch(() => undefined);
      }
    });
    // Workspace materialization and other observers must not run under the
    // asset-store mutation fence. A durable CAS publication remains successful
    // even when an optional Finder mirror is unavailable or has drifted.
    try {
      await this.options.onAssetPublished?.(result.asset);
    } catch {
      // The canonical asset is already durable; observers are best effort.
    }
    return result;
  }

  private async verifyPublishedAsset(asset: StoredAsset): Promise<void> {
    const bytes = await readBoundedRegularFile(
      this.assetPath(asset.assetId, asset.extension),
      Math.max(this.limits.maxImportBytes, this.limits.maxProviderResponseBytes),
    ).catch(() => undefined);
    if (
      !bytes ||
      bytes.byteLength !== asset.byteLength ||
      createHash("sha256").update(bytes).digest("hex") !== asset.assetId
    ) {
      throw new AssetStoreError(
        "asset_store_repair_required",
        "A published asset is missing or does not match its content identifier.",
      );
    }
    let descriptor: ValidatedImageDescriptor;
    try {
      descriptor = validateImageBytes(
        bytes,
        asset.mediaType,
        `${asset.assetId}.${asset.extension}`,
        this.limits,
      );
    } catch {
      throw new AssetStoreError(
        "asset_store_repair_required",
        "A published asset no longer passes image validation.",
      );
    }
    if (
      descriptor.width !== asset.width ||
      descriptor.height !== asset.height ||
      descriptor.extension !== asset.extension
    ) {
      throw new AssetStoreError(
        "asset_store_repair_required",
        "Published asset metadata does not match its image contents.",
      );
    }
  }

  async replaceReferences(owner: AssetReferenceOwner, assetIds: readonly string[]): Promise<void> {
    return this.serialized(async () => {
      await this.initialize();
      this.ensureHealthy();
      const key = ownerKey(owner);
      if (assetIds.length > this.limits.maxAssets || new Set(assetIds).size !== assetIds.length) {
        throw new AssetStoreError("invalid_asset_request", "The asset reference list is invalid.");
      }
      for (const assetId of assetIds) {
        assertAssetId(assetId);
        if (!this.index.assets[assetId]) {
          throw new AssetStoreError("asset_not_found", `Asset ${assetId} does not exist.`);
        }
      }
      const desired = new Set(assetIds);
      const next = structuredClone(this.index);
      let changed = false;
      const timestamp = new Date(this.now()).toISOString();
      for (const asset of Object.values(next.assets)) {
        const had = asset.referenceOwners.includes(key);
        const wants = desired.has(asset.assetId);
        if (had === wants) continue;
        changed = true;
        asset.referenceOwners = wants
          ? [...asset.referenceOwners, key].sort()
          : asset.referenceOwners.filter((candidate) => candidate !== key);
        if (asset.referenceOwners.length === 0) asset.unreferencedAt = timestamp;
        else delete asset.unreferencedAt;
      }
      if (!changed) return;
      next.revision += 1;
      await this.saveIndex(next);
    });
  }

  async rebuildReferenceAccounting(): Promise<{ missingAssetIds: string[]; revision: number }> {
    return this.serialized(async () => {
      await this.initialize();
      this.ensureHealthy();
      return this.referenceAuthority.withSnapshot(async (snapshot) => {
        const byAsset = validateReferenceSnapshot(snapshot, this.limits);
        const referencedAssetIds = [...byAsset.keys()];
        const missingAssetIds: string[] = [];
        let cursor = 0;
        await Promise.all(
          Array.from({ length: Math.min(16, referencedAssetIds.length) }, async () => {
            while (cursor < referencedAssetIds.length) {
              const assetId = referencedAssetIds[cursor++];
              if (!assetId) continue;
              const asset = this.index.assets[assetId];
              if (!asset || !(await this.publishedAssetAvailable(asset))) {
                missingAssetIds.push(assetId);
              }
            }
          }),
        );
        missingAssetIds.sort();
        const next = structuredClone(this.index);
        const timestamp = new Date(this.now()).toISOString();
        for (const asset of Object.values(next.assets)) {
          const previousCount = asset.referenceOwners.length;
          asset.referenceOwners = [...(byAsset.get(asset.assetId) ?? [])].sort();
          if (asset.referenceOwners.length === 0) {
            asset.unreferencedAt ??= timestamp;
          } else {
            delete asset.unreferencedAt;
          }
          if (previousCount > 0 && asset.referenceOwners.length === 0)
            asset.unreferencedAt = timestamp;
        }
        next.revision += 1;
        await this.saveIndex(next);
        return { missingAssetIds, revision: next.revision };
      });
    });
  }

  async acquirePreviewLease(
    assetId: string,
    ownerId: string,
    ttlMs = 60_000,
  ): Promise<AssetPreviewLeaseDto> {
    return this.serialized(async () => {
      assertAssetId(assetId);
      assertSafeId(ownerId, "Preview owner ID");
      if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 5 * 60_000) {
        throw new AssetStoreError(
          "invalid_asset_request",
          "Preview leases last between 1 and 300 seconds.",
        );
      }
      await this.initialize();
      this.ensureHealthy();
      const asset = this.index.assets[assetId];
      if (!asset) {
        throw new AssetStoreError("asset_not_found", `Asset ${assetId} does not exist.`);
      }
      if (!(await this.publishedAssetAvailable(asset))) {
        throw new AssetStoreError(
          "asset_source_missing",
          `Asset ${assetId} is missing its source.`,
        );
      }
      this.pruneRuntimeState();
      if (this.leases.size >= this.limits.maxPreviewLeases) {
        throw new AssetStoreError("invalid_asset_request", "The preview lease limit is reached.");
      }
      const token = randomBytes(32).toString("base64url");
      const lease = { token, assetId, ownerId, expiresAt: this.now() + ttlMs };
      this.leases.set(token, lease);
      return { token, assetId, expiresAt: lease.expiresAt };
    });
  }

  async readPreview(
    token: string,
    ownerId: string,
    maxBytes = this.limits.maxPreviewReadBytes,
  ): Promise<AssetPreviewDto> {
    return this.serialized(async () => {
      if (!PREVIEW_TOKEN.test(token)) {
        throw new AssetStoreError(
          "preview_lease_invalid",
          "The preview lease is invalid or expired.",
        );
      }
      assertSafeId(ownerId, "Preview owner ID");
      if (
        !Number.isSafeInteger(maxBytes) ||
        maxBytes < 1 ||
        maxBytes > this.limits.maxPreviewReadBytes
      ) {
        throw new AssetStoreError("invalid_asset_request", "The preview byte limit is invalid.");
      }
      await this.initialize();
      this.ensureHealthy();
      this.pruneRuntimeState();
      const lease = this.leases.get(token);
      if (!lease || lease.ownerId !== ownerId) {
        throw new AssetStoreError(
          "preview_lease_invalid",
          "The preview lease is invalid or expired.",
        );
      }
      const asset = this.index.assets[lease.assetId];
      if (!asset)
        throw new AssetStoreError("asset_not_found", "The preview asset no longer exists.");
      if (asset.byteLength > maxBytes) {
        throw new AssetStoreError(
          "preview_too_large",
          "The selected asset exceeds the preview byte limit.",
        );
      }
      const bytes = await readBoundedRegularFile(
        this.assetPath(asset.assetId, asset.extension),
        maxBytes,
      ).catch(() => {
        throw new AssetStoreError(
          "asset_store_repair_required",
          "The preview asset is missing or unsafe.",
        );
      });
      if (createHash("sha256").update(bytes).digest("hex") !== asset.assetId) {
        throw new AssetStoreError(
          "asset_store_repair_required",
          "The preview asset failed integrity validation.",
        );
      }
      try {
        const descriptor = validateImageBytes(
          bytes,
          asset.mediaType,
          `${asset.assetId}.${asset.extension}`,
          this.limits,
        );
        if (
          descriptor.width !== asset.width ||
          descriptor.height !== asset.height ||
          descriptor.extension !== asset.extension
        ) {
          throw new Error("metadata_mismatch");
        }
      } catch {
        throw new AssetStoreError(
          "asset_store_repair_required",
          "The preview asset metadata does not match its image contents.",
        );
      }
      return { asset: metadataDto(asset), bytes: bytes.slice() };
    });
  }

  async releasePreviewLease(token: string, ownerId: string): Promise<boolean> {
    return this.serialized(async () => {
      if (!PREVIEW_TOKEN.test(token)) return false;
      assertSafeId(ownerId, "Preview owner ID");
      const lease = this.leases.get(token);
      if (!lease || lease.ownerId !== ownerId) return false;
      return this.leases.delete(token);
    });
  }

  async releasePreviewOwner(ownerId: string): Promise<number> {
    return this.serialized(async () => {
      assertSafeId(ownerId, "Preview owner ID");
      let released = 0;
      for (const [token, lease] of this.leases) {
        if (lease.ownerId !== ownerId) continue;
        this.leases.delete(token);
        released += 1;
      }
      return released;
    });
  }

  async getThumbnail(assetId: string, size: number): Promise<AssetThumbnailDto> {
    return this.serialized(async () => {
      assertAssetId(assetId);
      if (!this.limits.thumbnailSizes.includes(size)) {
        throw new AssetStoreError("invalid_asset_request", "The thumbnail size is not allowed.");
      }
      await this.initialize();
      this.ensureHealthy();
      const asset = this.index.assets[assetId];
      if (!asset) throw new AssetStoreError("asset_not_found", `Asset ${assetId} does not exist.`);
      if (!(await this.publishedAssetAvailable(asset))) {
        throw new AssetStoreError(
          "asset_source_missing",
          `Asset ${assetId} is missing its source.`,
        );
      }
      const key = `${assetId}:${size}`;
      const cached = this.cache.get(key);
      if (cached) return { assetId, ...cached, bytes: cached.bytes.slice() };
      const thumbnailPath = this.thumbnailPath(assetId, size);
      const stored = asset.thumbnails[String(size)];
      if (stored) {
        try {
          const bytes = await this.readValidatedThumbnail(thumbnailPath, stored);
          const entry = thumbnailCacheEntry(stored, bytes);
          this.cache.set(key, entry);
          return { assetId, ...entry, bytes: entry.bytes.slice() };
        } catch {
          // A derived thumbnail is regenerable. Its immutable source remains untouched.
        }
      }
      if (!this.options.thumbnailGenerator) {
        throw new AssetStoreError(
          "thumbnail_unavailable",
          "No safe thumbnail generator is configured.",
        );
      }
      await this.verifyPublishedAsset(asset);
      const generated = await this.options.thumbnailGenerator.generate({
        sourcePath: this.assetPath(assetId, asset.extension),
        source: descriptorFor(asset),
        maxDimension: size,
        maxOutputBytes: this.limits.maxThumbnailBytes,
      });
      if (
        generated.mediaType !== THUMBNAIL_MEDIA_TYPE ||
        !(generated.bytes instanceof Uint8Array) ||
        generated.bytes.byteLength < 33 ||
        generated.bytes.byteLength > this.limits.maxThumbnailBytes ||
        !isSafeThumbnailPng(generated.bytes, generated.width, generated.height) ||
        !Number.isSafeInteger(generated.width) ||
        !Number.isSafeInteger(generated.height) ||
        generated.width < 1 ||
        generated.height < 1 ||
        generated.width > size ||
        generated.height > size
      ) {
        throw new AssetStoreError(
          "thumbnail_unavailable",
          "The thumbnail generator returned unsafe output.",
        );
      }
      await ensureSafeDirectory(path.dirname(thumbnailPath));
      const temp = `${thumbnailPath}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(temp, generated.bytes, { flag: "wx", mode: 0o600 });
        const handle = await fs.open(temp, "r");
        try {
          await handle.sync();
        } finally {
          await handle.close();
        }
        const decoded = await this.options.deepValidator
          .validate({
            filePath: temp,
            descriptor: {
              mediaType: "image/png",
              extension: "png",
              width: generated.width,
              height: generated.height,
              pixels: generated.width * generated.height,
            },
            byteLength: generated.bytes.byteLength,
          })
          .catch(() => {
            throw new AssetStoreError(
              "thumbnail_unavailable",
              "The safe image decoder rejected the generated thumbnail.",
            );
          });
        if (decoded.width !== generated.width || decoded.height !== generated.height) {
          throw new AssetStoreError(
            "thumbnail_unavailable",
            "The decoded thumbnail dimensions do not match its metadata.",
          );
        }
        await fs.rename(temp, thumbnailPath);
        await syncDirectory(path.dirname(thumbnailPath));
      } finally {
        await fs.rm(temp, { force: true }).catch(() => undefined);
      }
      const updatedAt = new Date(this.now()).toISOString();
      const metadata: StoredThumbnail = {
        mediaType: THUMBNAIL_MEDIA_TYPE,
        byteLength: generated.bytes.byteLength,
        width: generated.width,
        height: generated.height,
        updatedAt,
      };
      const next = structuredClone(this.index);
      next.revision += 1;
      next.assets[assetId]!.thumbnails[String(size)] = metadata;
      await this.saveIndex(next);
      const entry = thumbnailCacheEntry(metadata, generated.bytes);
      this.cache.set(key, entry);
      return { assetId, ...entry, bytes: entry.bytes.slice() };
    });
  }

  thumbnailCacheStatus(): { entries: number; byteLength: number; maxBytes: number } {
    return {
      entries: this.cache.size,
      byteLength: this.cache.byteLength,
      maxBytes: this.limits.thumbnailCacheBytes,
    };
  }

  /**
   * Main-only seam for protocol/export code. The callback must finish consuming
   * the file before it resolves; the asset-store mutation lock (and therefore
   * GC exclusion) is held for that full interval. Never forward filePath over IPC.
   */
  async withAssetFile<Result>(
    assetId: string,
    callback: (input: {
      filePath: string;
      asset: AssetMetadataDto;
      byteLength: number;
      mediaType: SafeAssetMediaType;
    }) => Promise<Result>,
  ): Promise<Result> {
    return this.serialized(async () => {
      assertAssetId(assetId);
      await this.initialize();
      this.ensureHealthy();
      const asset = this.index.assets[assetId];
      if (!asset) throw new AssetStoreError("asset_not_found", `Asset ${assetId} does not exist.`);
      await this.verifyPublishedAsset(asset);
      return callback({
        filePath: this.assetPath(assetId, asset.extension),
        asset: metadataDto(asset),
        byteLength: asset.byteLength,
        mediaType: asset.mediaType,
      });
    });
  }

  /**
   * Main-only validation seam for native archive quarantine files. This does
   * not publish bytes or mutate the asset index. Callers must keep the path in
   * a private main-owned directory and must never forward it over IPC.
   */
  async validateQuarantinedAssetFile(
    filePath: string,
    input: { declaredMimeType: string; displayName: string },
  ): Promise<ValidatedQuarantinedAsset> {
    const bytes = await readBoundedRegularFile(filePath, this.limits.maxImportBytes);
    const descriptor = validateImageBytes(
      bytes,
      input.declaredMimeType,
      sanitizeAssetDisplayName(input.displayName),
      this.limits,
    );
    const decoded = await this.options.deepValidator
      .validate({ filePath, descriptor, byteLength: bytes.byteLength })
      .catch(() => {
        throw new AssetStoreError(
          "invalid_asset_request",
          "The safe image decoder rejected the archived image.",
        );
      });
    if (decoded.width !== descriptor.width || decoded.height !== descriptor.height) {
      throw new AssetStoreError(
        "invalid_asset_request",
        "The archived image decoder dimensions do not match its validated header.",
      );
    }
    return {
      sha256: createHash("sha256").update(bytes).digest("hex"),
      mediaType: descriptor.mediaType,
      byteLength: bytes.byteLength,
      width: descriptor.width,
      height: descriptor.height,
    };
  }

  /** Main-dialog-only durable export. The destination must never come from a
   * renderer payload; callers are responsible for obtaining it from a native
   * save dialog. */
  async exportAssetToFile(assetId: string, destination: string): Promise<AssetMetadataDto> {
    return this.serialized(async () => {
      assertAssetId(assetId);
      if (!path.isAbsolute(destination) || destination.includes("\0")) {
        throw new AssetStoreError("invalid_asset_request", "The asset export path is invalid.");
      }
      await this.initialize();
      this.ensureHealthy();
      const asset = this.index.assets[assetId];
      if (!asset) throw new AssetStoreError("asset_not_found", "The exported asset is missing.");
      await this.verifyPublishedAsset(asset);
      const directory = path.dirname(destination);
      const temp = path.join(directory, `.${path.basename(destination)}.${randomUUID()}.tmp`);
      try {
        await fs.copyFile(this.assetPath(assetId, asset.extension), temp, constants.COPYFILE_EXCL);
        await fs.chmod(temp, 0o600);
        const handle = await fs.open(temp, "r");
        try {
          await handle.sync();
        } finally {
          await handle.close();
        }
        await fs.rename(temp, destination);
        await syncDirectory(directory);
      } catch (error) {
        await fs.rm(temp, { force: true }).catch(() => undefined);
        throw error;
      }
      return metadataDto(asset);
    });
  }

  async planGarbageCollection(graceMs: number): Promise<AssetGarbageCollectionPlanDto> {
    return this.serialized(async () => {
      await this.initialize();
      this.ensureHealthy();
      this.pruneRuntimeState();
      return this.referenceAuthority.withSnapshot(async (snapshot) => {
        const references = validateReferenceSnapshot(snapshot, this.limits);
        const missing = [...references.keys()].filter((assetId) => !this.index.assets[assetId]);
        if (missing.length > 0) {
          throw new AssetStoreError(
            "asset_store_repair_required",
            "Reference accounting includes missing assets; repair is required before collection.",
          );
        }
        const now = this.now();
        const leased = new Set([...this.leases.values()].map((lease) => lease.assetId));
        const candidates = Object.values(this.index.assets)
          .filter((asset) => {
            const unreferencedAt = Date.parse(asset.unreferencedAt ?? asset.createdAt);
            return (
              !references.has(asset.assetId) &&
              !leased.has(asset.assetId) &&
              Number.isFinite(unreferencedAt) &&
              unreferencedAt <= now - graceMs
            );
          })
          .sort((left, right) => left.assetId.localeCompare(right.assetId));
        while (this.gcPlans.size >= 32) {
          const oldest = this.gcPlans.keys().next().value as string | undefined;
          if (!oldest) break;
          this.gcPlans.delete(oldest);
        }
        const plan: InternalGcPlan = {
          planId: randomBytes(24).toString("base64url"),
          createdAt: now,
          expiresAt: now + 5 * 60_000,
          indexRevision: this.index.revision,
          referenceEpoch: snapshot.epoch,
          referenceFingerprint: referenceFingerprint(snapshot),
          graceMs,
          candidateAssetIds: candidates.map((asset) => asset.assetId),
          reclaimableBytes: candidates.reduce((sum, asset) => sum + asset.byteLength, 0),
        };
        this.gcPlans.set(plan.planId, plan);
        return {
          planId: plan.planId,
          createdAt: plan.createdAt,
          expiresAt: plan.expiresAt,
          indexRevision: plan.indexRevision,
          referenceEpoch: plan.referenceEpoch,
          candidateAssetIds: [...plan.candidateAssetIds],
          reclaimableBytes: plan.reclaimableBytes,
        };
      });
    });
  }

  async applyGarbageCollection(planId: string): Promise<AssetGarbageCollectionResult> {
    return this.serialized(async () => {
      if (!/^[A-Za-z0-9_-]{24,128}$/u.test(planId)) {
        throw new AssetStoreError(
          "invalid_asset_request",
          "The garbage-collection plan ID is invalid.",
        );
      }
      await this.initialize();
      this.ensureHealthy();
      this.pruneRuntimeState();
      const plan = this.gcPlans.get(planId);
      if (!plan) {
        return {
          applied: false,
          stale: true,
          deletedAssetIds: [],
          reclaimedBytes: 0,
          skipped: [],
        };
      }
      return this.referenceAuthority.withSnapshot(async (snapshot) => {
        const references = validateReferenceSnapshot(snapshot, this.limits);
        if (
          plan.expiresAt <= this.now() ||
          plan.indexRevision !== this.index.revision ||
          plan.referenceEpoch !== snapshot.epoch ||
          plan.referenceFingerprint !== referenceFingerprint(snapshot)
        ) {
          this.gcPlans.delete(planId);
          return {
            applied: false,
            stale: true,
            deletedAssetIds: [],
            reclaimedBytes: 0,
            skipped: [],
          };
        }
        const now = this.now();
        const leased = new Set([...this.leases.values()].map((lease) => lease.assetId));
        const skipped: AssetGarbageCollectionResult["skipped"] = [];
        const removable: StoredAsset[] = [];
        for (const assetId of plan.candidateAssetIds) {
          const asset = this.index.assets[assetId];
          if (!asset) {
            skipped.push({ assetId, reason: "not_found" });
            continue;
          }
          if (references.has(assetId)) {
            skipped.push({ assetId, reason: "referenced" });
            continue;
          }
          if (leased.has(assetId)) {
            skipped.push({ assetId, reason: "lease_active" });
            continue;
          }
          const unreferencedAt = Date.parse(asset.unreferencedAt ?? asset.createdAt);
          if (!Number.isFinite(unreferencedAt) || unreferencedAt > now - plan.graceMs) {
            skipped.push({ assetId, reason: "too_new" });
            continue;
          }
          removable.push(asset);
        }
        const staged: Array<{ asset: StoredAsset; stagedPath: string; destination: string }> = [];
        try {
          for (const asset of removable) {
            const destination = this.assetPath(asset.assetId, asset.extension);
            const stagedPath = path.join(
              this.quarantineDirectory,
              `.gc-${asset.assetId}-${randomUUID()}.${asset.extension}`,
            );
            try {
              const info = await fs.lstat(destination);
              if (!info.isFile() || info.isSymbolicLink()) {
                skipped.push({ assetId: asset.assetId, reason: "not_found" });
                continue;
              }
              await fs.rename(destination, stagedPath);
              staged.push({ asset, stagedPath, destination });
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                skipped.push({ assetId: asset.assetId, reason: "not_found" });
                continue;
              }
              throw error;
            }
          }
          if (staged.length > 0) {
            const next = structuredClone(this.index);
            next.revision += 1;
            for (const { asset } of staged) delete next.assets[asset.assetId];
            await this.saveIndex(next);
          }
        } catch (error) {
          for (const item of staged.reverse()) {
            await fs.rename(item.stagedPath, item.destination).catch(() => undefined);
          }
          throw error;
        }
        for (const { asset, stagedPath } of staged) {
          await fs.rm(stagedPath, { force: true }).catch(() => undefined);
          await fs
            .rm(path.join(this.thumbnailDirectory, asset.assetId), {
              recursive: true,
              force: true,
            })
            .catch(() => undefined);
          this.cache.deletePrefix(`${asset.assetId}:`);
        }
        this.gcPlans.delete(planId);
        return {
          applied: true,
          stale: false,
          deletedAssetIds: staged.map(({ asset }) => asset.assetId),
          reclaimedBytes: staged.reduce((sum, { asset }) => sum + asset.byteLength, 0),
          skipped,
        };
      });
    });
  }

  async repair(options: { apply: boolean }): Promise<AssetRepairReport> {
    return this.serialized(async () => {
      await this.initialize();
      const indexWasUnhealthy = !this.indexHealthy;
      return this.referenceAuthority.withSnapshot(async (snapshot) => {
        const references = validateReferenceSnapshot(snapshot, this.limits);
        const { scanned, invalid } = await this.scanPublishedAssets();
        if (scanned.size > this.limits.maxAssets) {
          throw new AssetStoreError(
            "asset_index_limit_exceeded",
            "The repaired asset index would exceed its entry limit.",
          );
        }
        const addedAssetIds: string[] = [];
        const correctedAssetIds: string[] = [];
        const removedAssetIds = Object.keys(this.index.assets)
          .filter((assetId) => !scanned.has(assetId))
          .sort();
        const repaired = cloneEmptyIndex();
        repaired.revision = this.index.revision + 1;
        const timestamp = new Date(this.now()).toISOString();
        for (const [assetId, entry] of [...scanned.entries()].sort(([left], [right]) =>
          left.localeCompare(right),
        )) {
          const existing = this.index.assets[assetId];
          if (!existing) addedAssetIds.push(assetId);
          const owners = [...(references.get(assetId) ?? [])].sort();
          const baseMatches =
            existing &&
            existing.extension === entry.descriptor.extension &&
            existing.mediaType === entry.descriptor.mediaType &&
            existing.byteLength === entry.byteLength &&
            existing.width === entry.descriptor.width &&
            existing.height === entry.descriptor.height;
          if (existing && !baseMatches) correctedAssetIds.push(assetId);
          const thumbnails = existing && baseMatches ? await this.validThumbnails(existing) : {};
          repaired.assets[assetId] = {
            assetId,
            extension: entry.descriptor.extension,
            mediaType: entry.descriptor.mediaType,
            byteLength: entry.byteLength,
            width: entry.descriptor.width,
            height: entry.descriptor.height,
            createdAt: existing?.createdAt ?? entry.createdAt,
            ...(existing?.displayName ? { displayName: existing.displayName } : {}),
            origin: existing?.origin ?? { kind: "repair" },
            ...(existing?.generationMetadata
              ? { generationMetadata: structuredClone(existing.generationMetadata) }
              : {}),
            referenceOwners: owners,
            ...(owners.length === 0
              ? { unreferencedAt: existing?.unreferencedAt ?? timestamp }
              : {}),
            thumbnails,
          };
        }
        const missingReferenceAssetIds = [...references.keys()]
          .filter((assetId) => !scanned.has(assetId))
          .sort();
        const report: AssetRepairReport = {
          applied: options.apply,
          indexWasUnhealthy,
          addedAssetIds: addedAssetIds.sort(),
          removedAssetIds,
          correctedAssetIds: correctedAssetIds.sort(),
          quarantinedEntryIds: [],
          invalidEntries: invalid.map(({ entryId, reason }) => ({ entryId, reason })),
          missingReferenceAssetIds,
        };
        if (!options.apply) return report;
        await ensureSafeDirectory(this.quarantineDirectory);
        for (const item of invalid) {
          const destination = path.join(
            this.quarantineDirectory,
            `repair-${randomUUID()}-${path.basename(item.filePath).slice(0, 80)}`,
          );
          try {
            await fs.rename(item.filePath, destination);
            report.quarantinedEntryIds.push(item.entryId);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        }
        await this.saveIndex(repaired);
        this.cache.clear();
        return report;
      });
    });
  }

  private async validThumbnails(asset: StoredAsset): Promise<Record<string, StoredThumbnail>> {
    const valid: Record<string, StoredThumbnail> = {};
    for (const [size, metadata] of Object.entries(asset.thumbnails)) {
      if (!this.limits.thumbnailSizes.includes(Number(size))) continue;
      try {
        await this.readValidatedThumbnail(
          this.thumbnailPath(asset.assetId, Number(size)),
          metadata,
        );
        valid[size] = metadata;
      } catch {
        // Derived content is omitted from the repaired index and regenerated lazily.
      }
    }
    return valid;
  }

  private async readValidatedThumbnail(
    filePath: string,
    metadata: Pick<StoredThumbnail, "byteLength" | "width" | "height">,
  ): Promise<Uint8Array> {
    const bytes = await readBoundedRegularFile(filePath, this.limits.maxThumbnailBytes);
    if (
      bytes.byteLength !== metadata.byteLength ||
      !isSafeThumbnailPng(bytes, metadata.width, metadata.height)
    ) {
      throw new Error("The thumbnail file does not match its metadata.");
    }
    const decoded = await this.options.deepValidator.validate({
      filePath,
      descriptor: {
        mediaType: "image/png",
        extension: "png",
        width: metadata.width,
        height: metadata.height,
        pixels: metadata.width * metadata.height,
      },
      byteLength: metadata.byteLength,
    });
    if (decoded.width !== metadata.width || decoded.height !== metadata.height) {
      throw new Error("The decoded thumbnail dimensions do not match its metadata.");
    }
    return bytes;
  }

  private async scanPublishedAssets(): Promise<{
    scanned: Map<string, ScannedAsset>;
    invalid: InvalidScannedEntry[];
  }> {
    const scanned = new Map<string, ScannedAsset>();
    const invalid: InvalidScannedEntry[] = [];
    let entryCount = 0;
    let scannedBytes = 0;
    const prefixDirectory = await fs.opendir(this.assetsDirectory);
    for await (const prefix of prefixDirectory) {
      entryCount += 1;
      if (entryCount > this.limits.maxRepairEntries) {
        throw new AssetStoreError(
          "asset_index_limit_exceeded",
          "The asset tree has too many entries.",
        );
      }
      const prefixPath = path.join(this.assetsDirectory, prefix.name);
      if (!prefix.isDirectory() || prefix.isSymbolicLink() || !/^[a-f0-9]{2}$/u.test(prefix.name)) {
        invalid.push({
          entryId: prefix.name.slice(0, 255),
          filePath: prefixPath,
          reason: "invalid_prefix",
        });
        continue;
      }
      const assetDirectory = await fs.opendir(prefixPath);
      for await (const entry of assetDirectory) {
        entryCount += 1;
        if (entryCount > this.limits.maxRepairEntries) {
          throw new AssetStoreError(
            "asset_index_limit_exceeded",
            "The asset tree has too many entries.",
          );
        }
        const entryId = `${prefix.name}/${entry.name.slice(0, 255)}`;
        const filePath = path.join(prefixPath, entry.name);
        const match = /^([a-f0-9]{64})\.(png|jpg)$/u.exec(entry.name);
        if (
          !entry.isFile() ||
          entry.isSymbolicLink() ||
          !match ||
          match[1]!.slice(0, 2) !== prefix.name
        ) {
          invalid.push({ entryId, filePath, reason: "invalid_asset_entry" });
          continue;
        }
        try {
          const bytes = await readBoundedRegularFile(
            filePath,
            Math.max(this.limits.maxImportBytes, this.limits.maxProviderResponseBytes),
          );
          if (bytes.byteLength > this.limits.totalAssetBytes - scannedBytes) {
            throw new AssetStoreError(
              "asset_store_quota_exceeded",
              "The asset tree exceeds its aggregate byte quota.",
            );
          }
          scannedBytes += bytes.byteLength;
          const assetId = createHash("sha256").update(bytes).digest("hex");
          if (assetId !== match[1]) throw new Error("digest_mismatch");
          const descriptor = validateImageBytes(bytes, undefined, entry.name, this.limits);
          if (descriptor.extension !== match[2]) throw new Error("extension_mismatch");
          const decoded = await this.options.deepValidator.validate({
            filePath,
            descriptor,
            byteLength: bytes.byteLength,
          });
          if (decoded.width !== descriptor.width || decoded.height !== descriptor.height) {
            throw new Error("decoder_dimension_mismatch");
          }
          const info = await fs.lstat(filePath);
          scanned.set(assetId, {
            entryId,
            filePath,
            descriptor,
            byteLength: bytes.byteLength,
            createdAt: new Date(info.birthtimeMs || info.mtimeMs).toISOString(),
          });
        } catch (error) {
          if (error instanceof AssetStoreError && error.code === "asset_store_quota_exceeded") {
            throw error;
          }
          invalid.push({
            entryId,
            filePath,
            reason:
              error instanceof AssetImageValidationError
                ? error.code
                : error instanceof Error &&
                    [
                      "digest_mismatch",
                      "extension_mismatch",
                      "decoder_dimension_mismatch",
                    ].includes(error.message)
                  ? error.message
                  : "decoder_or_file_validation_failed",
          });
        }
      }
    }
    return { scanned, invalid };
  }
}
