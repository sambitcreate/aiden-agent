import {
  CREATE_IMAGES_MAX_ASSET_REFS,
  CREATE_IMAGES_MAX_TOTAL_ASSET_BYTES,
  CREATE_IMAGES_MAX_WORKFLOW_BYTES,
  type WorkflowDocumentV1,
} from "./schema";

export const CREATE_IMAGES_ARCHIVE_EXTENSION = ".aiden-images" as const;
export const CREATE_IMAGES_ARCHIVE_FORMAT = "aiden-images-workflow" as const;
export const CREATE_IMAGES_ARCHIVE_VERSION = 1 as const;
export const CREATE_IMAGES_ARCHIVE_MANIFEST_PATH = "manifest.json" as const;
export const CREATE_IMAGES_ARCHIVE_WORKFLOW_PATH = "workflow.json" as const;
export const CREATE_IMAGES_ARCHIVE_MAX_WORKFLOW_BYTES = CREATE_IMAGES_MAX_WORKFLOW_BYTES;
export const CREATE_IMAGES_ARCHIVE_MAX_ASSET_BYTES = 64 * 1024 * 1024;
export const CREATE_IMAGES_ARCHIVE_MAX_ENTRY_BYTES = CREATE_IMAGES_ARCHIVE_MAX_ASSET_BYTES;
export const CREATE_IMAGES_ARCHIVE_MAX_MANIFEST_BYTES = 1024 * 1024;
export const CREATE_IMAGES_ARCHIVE_MAX_TOTAL_BYTES =
  CREATE_IMAGES_MAX_TOTAL_ASSET_BYTES +
  CREATE_IMAGES_ARCHIVE_MAX_WORKFLOW_BYTES +
  CREATE_IMAGES_ARCHIVE_MAX_MANIFEST_BYTES;
export const CREATE_IMAGES_ARCHIVE_MAX_COMPRESSION_RATIO = 100;
export const CREATE_IMAGES_ARCHIVE_MAX_ENTRIES = CREATE_IMAGES_MAX_ASSET_REFS + 2;

const ZIP_COMPRESSION_STORED = 0;
const ZIP_COMPRESSION_DEFLATE = 8;

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const MEDIA_TYPES = new Set(["image/jpeg", "image/png"]);

export interface CreateImagesArchiveAssetV1 {
  assetId: string;
  sha256: string;
  path: string;
  mediaType: "image/jpeg" | "image/png";
  byteLength: number;
  width: number;
  height: number;
}

export interface CreateImagesArchiveManifestV1 {
  format: typeof CREATE_IMAGES_ARCHIVE_FORMAT;
  version: typeof CREATE_IMAGES_ARCHIVE_VERSION;
  exportedAt: string;
  workflow: {
    path: typeof CREATE_IMAGES_ARCHIVE_WORKFLOW_PATH;
    sha256: string;
    byteLength: number;
  };
  assets: CreateImagesArchiveAssetV1[];
}

export interface CreateImagesArchiveInventoryEntry {
  path: string;
  kind: "file" | "directory" | "symlink";
  encrypted: boolean;
  compressionMethod: number;
  compressedBytes: number;
  uncompressedBytes: number;
  crc32: number;
}

/**
 * Result of consuming one quarantined entry through a bounded streaming
 * reader. Importers must produce these measurements from bytes actually read;
 * central-directory declarations are not sufficient.
 */
export interface CreateImagesArchiveExtractedEntry {
  path: string;
  byteLength: number;
  crc32: number;
  sha256: string;
}

export interface CreateImagesArchiveIssue {
  path: string;
  code:
    | "invalid_manifest"
    | "unsafe_path"
    | "unsupported_entry"
    | "duplicate_entry"
    | "missing_entry"
    | "unexpected_entry"
    | "entry_count"
    | "encrypted_entry"
    | "compression_method"
    | "size_limit"
    | "compression_limit"
    | "actual_size_mismatch"
    | "checksum_mismatch"
    | "digest_mismatch"
    | "asset_contract_mismatch";
  message: string;
}

export type CreateImagesArchiveManifestResult =
  | { success: true; value: CreateImagesArchiveManifestV1 }
  | { success: false; issues: CreateImagesArchiveIssue[] };

function crc32(bytes: Uint8Array): number {
  let crc = 0xffff_ffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb8_8320 : 0);
    }
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function ownKeysExactly(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(record).sort();
  if (keys.length !== expected.length) return false;
  const sortedExpected = [...expected].sort();
  return keys.every((key, index) => key === sortedExpected[index]);
}

function isSafeArchivePath(value: string): boolean {
  if (
    value.length === 0 ||
    value.length > 512 ||
    value.startsWith("/") ||
    value.startsWith("\\") ||
    /^[A-Za-z]:/u.test(value) ||
    value.includes("\\") ||
    value.includes("\0")
  ) {
    return false;
  }
  const segments = value.split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function safeInteger(value: unknown, minimum: number, maximum: number): value is number {
  return (
    typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum
  );
}

function manifestIssue(path: string, message: string): CreateImagesArchiveIssue {
  return { path, code: "invalid_manifest", message };
}

function isPotentialNativeArchivePath(value: string): boolean {
  return (
    value === CREATE_IMAGES_ARCHIVE_MANIFEST_PATH ||
    value === CREATE_IMAGES_ARCHIVE_WORKFLOW_PATH ||
    /^assets\/[a-f0-9]{64}\.(?:jpg|png)$/u.test(value)
  );
}

/**
 * Manifest-independent ZIP central-directory gate. An importer must run this
 * before selecting or reading any member, then bounded-read the sole canonical
 * manifest with `parseCreateImagesArchiveManifestBytes`.
 */
export function validateCreateImagesArchiveBootstrap(
  entries: readonly CreateImagesArchiveInventoryEntry[],
): CreateImagesArchiveIssue[] {
  if (entries.length > CREATE_IMAGES_ARCHIVE_MAX_ENTRIES) {
    return [
      {
        path: "entries",
        code: "entry_count",
        message: `Archive contains more than ${CREATE_IMAGES_ARCHIVE_MAX_ENTRIES} entries.`,
      },
    ];
  }
  const issues: CreateImagesArchiveIssue[] = [];
  const observed = new Set<string>();
  let manifestCount = 0;
  let totalBytes = 0;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const at = `entries[${index}]`;
    if (!isSafeArchivePath(entry.path)) {
      issues.push({ path: at, code: "unsafe_path", message: "Archive entry path is unsafe." });
      continue;
    }
    if (entry.path === CREATE_IMAGES_ARCHIVE_MANIFEST_PATH) manifestCount += 1;
    if (observed.has(entry.path)) {
      issues.push({ path: at, code: "duplicate_entry", message: "Duplicate archive entry." });
    }
    observed.add(entry.path);
    if (!isPotentialNativeArchivePath(entry.path)) {
      issues.push({ path: at, code: "unexpected_entry", message: "Unexpected archive entry." });
    }
    if (entry.kind !== "file") {
      issues.push({
        path: at,
        code: "unsupported_entry",
        message: "Only regular files are supported.",
      });
    }
    if (entry.encrypted) {
      issues.push({
        path: at,
        code: "encrypted_entry",
        message: "Encrypted archive entries are unsupported.",
      });
    }
    if (
      !Number.isSafeInteger(entry.compressionMethod) ||
      (entry.compressionMethod !== ZIP_COMPRESSION_STORED &&
        entry.compressionMethod !== ZIP_COMPRESSION_DEFLATE)
    ) {
      issues.push({
        path: at,
        code: "compression_method",
        message: "Archive entry uses an unsupported compression method.",
      });
    }
    if (!safeInteger(entry.crc32, 0, 0xffff_ffff)) {
      issues.push({
        path: at,
        code: "checksum_mismatch",
        message: "Archive entry CRC-32 is invalid.",
      });
    }
    const entryLimit =
      entry.path === CREATE_IMAGES_ARCHIVE_MANIFEST_PATH
        ? CREATE_IMAGES_ARCHIVE_MAX_MANIFEST_BYTES
        : CREATE_IMAGES_ARCHIVE_MAX_ENTRY_BYTES;
    if (
      !safeInteger(entry.compressedBytes, 0, CREATE_IMAGES_ARCHIVE_MAX_TOTAL_BYTES) ||
      !safeInteger(entry.uncompressedBytes, 1, entryLimit)
    ) {
      issues.push({
        path: at,
        code: "size_limit",
        message: "Archive entry exceeds its byte limit.",
      });
      continue;
    }
    if (entry.uncompressedBytes > CREATE_IMAGES_ARCHIVE_MAX_TOTAL_BYTES - totalBytes) {
      totalBytes = CREATE_IMAGES_ARCHIVE_MAX_TOTAL_BYTES + 1;
    } else {
      totalBytes += entry.uncompressedBytes;
    }
    if (
      entry.uncompressedBytes / Math.max(1, entry.compressedBytes) >
      CREATE_IMAGES_ARCHIVE_MAX_COMPRESSION_RATIO
    ) {
      issues.push({
        path: at,
        code: "compression_limit",
        message: "Archive entry exceeds the compression-ratio limit.",
      });
    }
  }
  if (manifestCount === 0) {
    issues.push({
      path: CREATE_IMAGES_ARCHIVE_MANIFEST_PATH,
      code: "missing_entry",
      message: "Archive manifest is missing.",
    });
  } else if (manifestCount > 1) {
    issues.push({
      path: CREATE_IMAGES_ARCHIVE_MANIFEST_PATH,
      code: "duplicate_entry",
      message: "Archive must contain exactly one manifest.",
    });
  }
  if (totalBytes > CREATE_IMAGES_ARCHIVE_MAX_TOTAL_BYTES) {
    issues.push({
      path: "entries",
      code: "size_limit",
      message: "Archive exceeds its total byte limit.",
    });
  }
  return issues;
}

export function parseCreateImagesArchiveManifestBytes(
  bytes: Uint8Array,
  inventoryEntry: CreateImagesArchiveInventoryEntry,
): CreateImagesArchiveManifestResult {
  const bootstrapIssues = validateCreateImagesArchiveBootstrap([inventoryEntry]);
  if (bootstrapIssues.length > 0) return { success: false, issues: bootstrapIssues };
  if (
    bytes.byteLength !== inventoryEntry.uncompressedBytes ||
    bytes.byteLength > CREATE_IMAGES_ARCHIVE_MAX_MANIFEST_BYTES
  ) {
    return {
      success: false,
      issues: [
        {
          path: CREATE_IMAGES_ARCHIVE_MANIFEST_PATH,
          code: "actual_size_mismatch",
          message: "Manifest bytes do not match the bounded inventory entry.",
        },
      ],
    };
  }
  if (crc32(bytes) !== inventoryEntry.crc32) {
    return {
      success: false,
      issues: [
        {
          path: CREATE_IMAGES_ARCHIVE_MANIFEST_PATH,
          code: "checksum_mismatch",
          message: "Manifest CRC-32 does not match the archive inventory.",
        },
      ],
    };
  }
  try {
    return parseCreateImagesArchiveManifest(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown,
    );
  } catch {
    return {
      success: false,
      issues: [manifestIssue(CREATE_IMAGES_ARCHIVE_MANIFEST_PATH, "Manifest JSON is invalid.")],
    };
  }
}

/**
 * Parse the small JSON manifest before an importer extracts any archive entry.
 * The workflow itself is parsed separately with `parseWorkflowDocument` after
 * its digest and byte length have been verified.
 */
export function parseCreateImagesArchiveManifest(
  value: unknown,
): CreateImagesArchiveManifestResult {
  const issues: CreateImagesArchiveIssue[] = [];
  if (
    !isRecord(value) ||
    !ownKeysExactly(value, ["format", "version", "exportedAt", "workflow", "assets"])
  ) {
    return { success: false, issues: [manifestIssue("$", "Archive manifest fields are invalid.")] };
  }
  if (value.format !== CREATE_IMAGES_ARCHIVE_FORMAT) {
    issues.push(manifestIssue("$.format", "Unsupported Create Images archive format."));
  }
  if (value.version !== CREATE_IMAGES_ARCHIVE_VERSION) {
    issues.push(manifestIssue("$.version", "Unsupported Create Images archive version."));
  }
  if (
    typeof value.exportedAt !== "string" ||
    value.exportedAt.length > 64 ||
    !Number.isFinite(Date.parse(value.exportedAt))
  ) {
    issues.push(manifestIssue("$.exportedAt", "Expected an ISO-8601 export timestamp."));
  }

  const workflow = value.workflow;
  if (!isRecord(workflow) || !ownKeysExactly(workflow, ["path", "sha256", "byteLength"])) {
    issues.push(manifestIssue("$.workflow", "Workflow entry metadata is invalid."));
  } else {
    if (workflow.path !== CREATE_IMAGES_ARCHIVE_WORKFLOW_PATH) {
      issues.push(
        manifestIssue("$.workflow.path", "Workflow must use the canonical archive path."),
      );
    }
    if (typeof workflow.sha256 !== "string" || !SHA256_PATTERN.test(workflow.sha256)) {
      issues.push(manifestIssue("$.workflow.sha256", "Workflow digest must be lowercase SHA-256."));
    }
    if (!safeInteger(workflow.byteLength, 1, CREATE_IMAGES_ARCHIVE_MAX_WORKFLOW_BYTES)) {
      issues.push(manifestIssue("$.workflow.byteLength", "Workflow byte length is invalid."));
    }
  }

  const assetValues = value.assets;
  if (!Array.isArray(assetValues) || assetValues.length > CREATE_IMAGES_MAX_ASSET_REFS) {
    issues.push(manifestIssue("$.assets", "Archive asset inventory is invalid or too large."));
  }
  const assets: CreateImagesArchiveAssetV1[] = [];
  const ids = new Set<string>();
  const paths = new Set<string>();
  if (Array.isArray(assetValues) && assetValues.length <= CREATE_IMAGES_MAX_ASSET_REFS) {
    for (let index = 0; index < assetValues.length; index += 1) {
      const asset = assetValues[index];
      const at = `$.assets[${index}]`;
      if (
        !isRecord(asset) ||
        !ownKeysExactly(asset, [
          "assetId",
          "sha256",
          "path",
          "mediaType",
          "byteLength",
          "width",
          "height",
        ])
      ) {
        issues.push(manifestIssue(at, "Asset entry metadata is invalid."));
        continue;
      }
      const validIdentity =
        typeof asset.assetId === "string" &&
        SHA256_PATTERN.test(asset.assetId) &&
        typeof asset.sha256 === "string" &&
        asset.sha256 === asset.assetId;
      if (!validIdentity) {
        issues.push(
          manifestIssue(`${at}.assetId`, "Asset ID must equal its lowercase SHA-256 digest."),
        );
      }
      const expectedPath =
        validIdentity && asset.mediaType === "image/png"
          ? `assets/${asset.assetId}.png`
          : validIdentity && asset.mediaType === "image/jpeg"
            ? `assets/${asset.assetId}.jpg`
            : undefined;
      if (
        typeof asset.path !== "string" ||
        !isSafeArchivePath(asset.path) ||
        !expectedPath ||
        asset.path !== expectedPath
      ) {
        issues.push(
          manifestIssue(`${at}.path`, "Asset path is unsafe or is not content addressed."),
        );
      }
      if (typeof asset.mediaType !== "string" || !MEDIA_TYPES.has(asset.mediaType)) {
        issues.push(manifestIssue(`${at}.mediaType`, "Unsupported image media type."));
      }
      if (!safeInteger(asset.byteLength, 1, CREATE_IMAGES_ARCHIVE_MAX_ENTRY_BYTES)) {
        issues.push(manifestIssue(`${at}.byteLength`, "Asset byte length is invalid."));
      }
      if (!safeInteger(asset.width, 1, 100_000) || !safeInteger(asset.height, 1, 100_000)) {
        issues.push(manifestIssue(`${at}.width`, "Asset dimensions are invalid."));
      }
      if (typeof asset.assetId === "string" && ids.has(asset.assetId)) {
        issues.push(manifestIssue(`${at}.assetId`, "Duplicate asset ID."));
      }
      if (typeof asset.path === "string" && paths.has(asset.path)) {
        issues.push(manifestIssue(`${at}.path`, "Duplicate asset path."));
      }
      if (typeof asset.assetId === "string") ids.add(asset.assetId);
      if (typeof asset.path === "string") paths.add(asset.path);
      if (
        validIdentity &&
        typeof asset.path === "string" &&
        isSafeArchivePath(asset.path) &&
        typeof asset.mediaType === "string" &&
        MEDIA_TYPES.has(asset.mediaType) &&
        safeInteger(asset.byteLength, 1, CREATE_IMAGES_ARCHIVE_MAX_ENTRY_BYTES) &&
        safeInteger(asset.width, 1, 100_000) &&
        safeInteger(asset.height, 1, 100_000)
      ) {
        assets.push(asset as unknown as CreateImagesArchiveAssetV1);
      }
    }
  }

  const declaredAssetBytes = assets.reduce((total, asset) => total + asset.byteLength, 0);
  if (declaredAssetBytes > CREATE_IMAGES_MAX_TOTAL_ASSET_BYTES) {
    issues.push(manifestIssue("$.assets", "Archive assets exceed the storage byte limit."));
  }
  const declaredPayloadBytes =
    (isRecord(workflow) &&
    safeInteger(workflow.byteLength, 1, CREATE_IMAGES_ARCHIVE_MAX_WORKFLOW_BYTES)
      ? workflow.byteLength
      : 0) + declaredAssetBytes;
  if (declaredPayloadBytes > CREATE_IMAGES_ARCHIVE_MAX_TOTAL_BYTES) {
    issues.push(manifestIssue("$", "Archive manifest exceeds its total byte limit."));
  }

  if (issues.length > 0 || !isRecord(workflow)) return { success: false, issues };
  return {
    success: true,
    value: {
      format: CREATE_IMAGES_ARCHIVE_FORMAT,
      version: CREATE_IMAGES_ARCHIVE_VERSION,
      exportedAt: value.exportedAt as string,
      workflow: workflow as unknown as CreateImagesArchiveManifestV1["workflow"],
      assets,
    },
  };
}

/** Validate the ZIP inventory before extraction to block zip-slip, symlinks,
 * duplicate names, unexpected payloads, and decompression bombs. */
export function validateCreateImagesArchiveInventory(
  manifest: CreateImagesArchiveManifestV1,
  entries: readonly CreateImagesArchiveInventoryEntry[],
): CreateImagesArchiveIssue[] {
  const bootstrapIssues = validateCreateImagesArchiveBootstrap(entries);
  if (bootstrapIssues.length > 0) return bootstrapIssues;
  const issues: CreateImagesArchiveIssue[] = [];
  const expected = new Set([
    CREATE_IMAGES_ARCHIVE_MANIFEST_PATH,
    CREATE_IMAGES_ARCHIVE_WORKFLOW_PATH,
    ...manifest.assets.map((asset) => asset.path),
  ]);
  const observed = new Set<string>();
  const manifestByteLengths = new Map<string, number>([
    [manifest.workflow.path, manifest.workflow.byteLength],
    ...manifest.assets.map((asset) => [asset.path, asset.byteLength] as const),
  ]);
  let totalBytes = 0;

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const at = `entries[${index}]`;
    if (!isSafeArchivePath(entry.path)) {
      issues.push({ path: at, code: "unsafe_path", message: "Archive entry path is unsafe." });
      continue;
    }
    if (entry.kind !== "file") {
      issues.push({
        path: at,
        code: "unsupported_entry",
        message: "Only regular files are supported.",
      });
      continue;
    }
    if (entry.encrypted) {
      issues.push({
        path: at,
        code: "encrypted_entry",
        message: "Encrypted archive entries are unsupported.",
      });
    }
    if (
      !Number.isSafeInteger(entry.compressionMethod) ||
      (entry.compressionMethod !== ZIP_COMPRESSION_STORED &&
        entry.compressionMethod !== ZIP_COMPRESSION_DEFLATE)
    ) {
      issues.push({
        path: at,
        code: "compression_method",
        message: "Archive entry uses an unsupported compression method.",
      });
    }
    if (!safeInteger(entry.crc32, 0, 0xffff_ffff)) {
      issues.push({
        path: at,
        code: "checksum_mismatch",
        message: "Archive entry CRC-32 is invalid.",
      });
    }
    if (observed.has(entry.path)) {
      issues.push({ path: at, code: "duplicate_entry", message: "Duplicate archive entry." });
      continue;
    }
    observed.add(entry.path);
    if (!expected.has(entry.path)) {
      issues.push({ path: at, code: "unexpected_entry", message: "Unexpected archive entry." });
    }
    if (
      !safeInteger(entry.compressedBytes, 0, CREATE_IMAGES_ARCHIVE_MAX_TOTAL_BYTES) ||
      !safeInteger(entry.uncompressedBytes, 1, CREATE_IMAGES_ARCHIVE_MAX_ENTRY_BYTES)
    ) {
      issues.push({
        path: at,
        code: "size_limit",
        message: "Archive entry exceeds its byte limit.",
      });
      continue;
    }
    totalBytes += entry.uncompressedBytes;
    const manifestByteLength = manifestByteLengths.get(entry.path);
    if (manifestByteLength !== undefined && entry.uncompressedBytes !== manifestByteLength) {
      issues.push({
        path: at,
        code: "actual_size_mismatch",
        message: "Archive entry byte length does not match the native manifest.",
      });
    }
    const ratio = entry.uncompressedBytes / Math.max(1, entry.compressedBytes);
    if (ratio > CREATE_IMAGES_ARCHIVE_MAX_COMPRESSION_RATIO) {
      issues.push({
        path: at,
        code: "compression_limit",
        message: "Archive entry exceeds the compression-ratio limit.",
      });
    }
  }

  if (totalBytes > CREATE_IMAGES_ARCHIVE_MAX_TOTAL_BYTES) {
    issues.push({
      path: "entries",
      code: "size_limit",
      message: "Archive exceeds its total byte limit.",
    });
  }
  for (const path of expected) {
    if (!observed.has(path)) {
      issues.push({ path, code: "missing_entry", message: "Required archive entry is missing." });
    }
  }
  return issues;
}

/**
 * Compare bounded, streamed quarantine measurements with both the ZIP
 * inventory and the signed-by-content native manifest. This is deliberately
 * separate from inventory validation so a future importer cannot accidentally
 * treat attacker-controlled declared sizes/checksums as observed facts.
 */
export function validateCreateImagesArchiveExtractedEntries(
  manifest: CreateImagesArchiveManifestV1,
  inventory: readonly CreateImagesArchiveInventoryEntry[],
  extracted: readonly CreateImagesArchiveExtractedEntry[],
): CreateImagesArchiveIssue[] {
  if (
    inventory.length > CREATE_IMAGES_ARCHIVE_MAX_ENTRIES ||
    extracted.length > CREATE_IMAGES_ARCHIVE_MAX_ENTRIES
  ) {
    return [
      { path: "entries", code: "entry_count", message: "Archive entry count exceeds its limit." },
    ];
  }
  const issues: CreateImagesArchiveIssue[] = [];
  const declared = new Map(inventory.map((entry) => [entry.path, entry] as const));
  const expectedDigests = new Map<string, string>([
    [manifest.workflow.path, manifest.workflow.sha256],
    ...manifest.assets.map((asset) => [asset.path, asset.sha256] as const),
  ]);
  const expectedByteLengths = new Map<string, number>([
    [manifest.workflow.path, manifest.workflow.byteLength],
    ...manifest.assets.map((asset) => [asset.path, asset.byteLength] as const),
  ]);
  const observed = new Set<string>();
  for (let index = 0; index < extracted.length; index += 1) {
    const entry = extracted[index];
    const at = `extracted[${index}]`;
    if (!isSafeArchivePath(entry.path) || observed.has(entry.path)) {
      issues.push({
        path: at,
        code: observed.has(entry.path) ? "duplicate_entry" : "unsafe_path",
        message: "Extracted archive entry identity is unsafe or duplicated.",
      });
      continue;
    }
    observed.add(entry.path);
    const inventoryEntry = declared.get(entry.path);
    if (!inventoryEntry) {
      issues.push({
        path: at,
        code: "unexpected_entry",
        message: "Extracted entry was not declared.",
      });
      continue;
    }
    if (entry.byteLength !== inventoryEntry.uncompressedBytes) {
      issues.push({
        path: at,
        code: "actual_size_mismatch",
        message: "Extracted byte length does not match the archive inventory.",
      });
    }
    const expectedByteLength = expectedByteLengths.get(entry.path);
    if (expectedByteLength !== undefined && entry.byteLength !== expectedByteLength) {
      issues.push({
        path: at,
        code: "actual_size_mismatch",
        message: "Extracted byte length does not match the native manifest.",
      });
    }
    if (entry.crc32 !== inventoryEntry.crc32) {
      issues.push({
        path: at,
        code: "checksum_mismatch",
        message: "Extracted CRC-32 does not match the archive inventory.",
      });
    }
    const expectedDigest = expectedDigests.get(entry.path);
    if (expectedDigest && entry.sha256 !== expectedDigest) {
      issues.push({
        path: at,
        code: "digest_mismatch",
        message: "Extracted SHA-256 does not match the native manifest.",
      });
    }
  }
  for (const entry of inventory) {
    if (!observed.has(entry.path)) {
      issues.push({
        path: entry.path,
        code: "missing_entry",
        message: "Declared entry was not extracted.",
      });
    }
  }
  return issues;
}

export interface CreateImagesArchiveValidatedAsset {
  assetId: string;
  mediaType: "image/jpeg" | "image/png";
  byteLength: number;
  width: number;
  height: number;
}

/**
 * Final pre-publication referential-integrity gate. Call only after the
 * workflow has passed `parseWorkflowDocument` and every image has passed the
 * main-owned structural/deep decoder boundary.
 */
export function validateCreateImagesArchiveWorkflowAssets(
  manifest: CreateImagesArchiveManifestV1,
  workflow: WorkflowDocumentV1,
  assets: readonly CreateImagesArchiveValidatedAsset[],
): CreateImagesArchiveIssue[] {
  const issues: CreateImagesArchiveIssue[] = [];
  const manifestIds = new Set(manifest.assets.map((asset) => asset.assetId));
  const workflowIds = new Set(workflow.assetRefs);
  if (
    manifestIds.size !== workflowIds.size ||
    [...manifestIds].some((assetId) => !workflowIds.has(assetId))
  ) {
    issues.push({
      path: "$.workflow.assetRefs",
      code: "asset_contract_mismatch",
      message: "Workflow asset references must exactly match the native archive manifest.",
    });
  }
  const validatedById = new Map<string, CreateImagesArchiveValidatedAsset>();
  for (const [index, asset] of assets.entries()) {
    if (validatedById.has(asset.assetId)) {
      issues.push({
        path: `validatedAssets[${index}]`,
        code: "duplicate_entry",
        message: "A validated archive asset was duplicated.",
      });
    }
    validatedById.set(asset.assetId, asset);
  }
  if (
    validatedById.size !== manifestIds.size ||
    [...validatedById.keys()].some((assetId) => !manifestIds.has(assetId))
  ) {
    issues.push({
      path: "validatedAssets",
      code: "asset_contract_mismatch",
      message: "Validated image assets must exactly match the native archive manifest.",
    });
  }
  for (const [index, expected] of manifest.assets.entries()) {
    const actual = validatedById.get(expected.assetId);
    if (
      !actual ||
      actual.mediaType !== expected.mediaType ||
      actual.byteLength !== expected.byteLength ||
      actual.width !== expected.width ||
      actual.height !== expected.height
    ) {
      issues.push({
        path: `$.assets[${index}]`,
        code: "asset_contract_mismatch",
        message: "Validated image metadata does not match the native archive manifest.",
      });
    }
  }
  return issues;
}
