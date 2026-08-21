import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as yauzl from "yauzl";
import * as yazl from "yazl";
import {
  CREATE_IMAGES_ARCHIVE_EXTENSION,
  CREATE_IMAGES_ARCHIVE_MANIFEST_PATH,
  CREATE_IMAGES_ARCHIVE_MAX_ENTRIES,
  CREATE_IMAGES_ARCHIVE_MAX_MANIFEST_BYTES,
  CREATE_IMAGES_ARCHIVE_MAX_TOTAL_BYTES,
  CREATE_IMAGES_ARCHIVE_WORKFLOW_PATH,
  CREATE_IMAGES_ARCHIVE_FORMAT,
  CREATE_IMAGES_ARCHIVE_VERSION,
  parseCreateImagesArchiveManifestBytes,
  validateCreateImagesArchiveBootstrap,
  validateCreateImagesArchiveExtractedEntries,
  validateCreateImagesArchiveInventory,
  validateCreateImagesArchiveWorkflowAssets,
  type CreateImagesArchiveExtractedEntry,
  type CreateImagesArchiveInventoryEntry,
  type CreateImagesArchiveManifestV1,
  type CreateImagesArchiveValidatedAsset,
} from "../../../renderer/shared/create-images/archive.js";
import {
  CREATE_IMAGES_MAX_WORKFLOW_BYTES,
  parseWorkflowDocument,
  type WorkflowDocumentV1,
} from "../../../renderer/shared/create-images/schema.js";
import type { ContentAddressedAssetStore } from "./asset-store-core.js";
import type { WorkflowManifestStore } from "./workflow-manifest-store.js";

const ARCHIVE_QUARANTINE_DIRECTORY = "archive-quarantine";
const UNIX_FILE_TYPE_MASK = 0o170000;
const UNIX_DIRECTORY = 0o040000;
const UNIX_SYMLINK = 0o120000;

export type CreateImagesNativeArchiveErrorCode =
  | "archive_invalid"
  | "archive_io"
  | "archive_revision_conflict"
  | "archive_workflow_missing";

export class CreateImagesNativeArchiveError extends Error {
  constructor(
    readonly code: CreateImagesNativeArchiveErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CreateImagesNativeArchiveError";
  }
}

export interface CreateImagesNativeArchiveDependencies {
  rootDirectory: string;
  workflows: WorkflowManifestStore;
  assets: ContentAddressedAssetStore;
  publishImportedWorkflow(
    workflow: WorkflowDocumentV1,
    isCurrent: () => boolean,
  ): Promise<WorkflowDocumentV1>;
  now?: () => number;
  randomId?: () => string;
}

export interface CreateImagesNativeArchiveExportResult {
  workflowId: string;
  revision: number;
  fileName: string;
  assetCount: number;
}

export interface CreateImagesNativeArchiveImportResult {
  workflow: WorkflowDocumentV1;
  sourceFileName: string;
  importedAssetCount: number;
}

interface QuarantinedEntry {
  path: string;
  filePath: string;
  extracted: CreateImagesArchiveExtractedEntry;
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value >>> 1) ^ (value & 1 ? 0xedb8_8320 : 0);
    }
    table[index] = value >>> 0;
  }
  return table;
})();

class Crc32Accumulator {
  private value = 0xffff_ffff;

  update(bytes: Uint8Array): void {
    for (const byte of bytes) {
      this.value = (this.value >>> 8) ^ CRC32_TABLE[(this.value ^ byte) & 0xff]!;
    }
  }

  digest(): number {
    return (this.value ^ 0xffff_ffff) >>> 0;
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

async function ensurePrivateDirectory(directory: string): Promise<void> {
  const created = await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await fs.lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new CreateImagesNativeArchiveError("archive_io", "Archive storage is unavailable.");
  }
  await fs.chmod(directory, 0o700);
  if (created !== undefined) await syncDirectory(path.dirname(directory));
}

function serializeWorkflow(workflow: WorkflowDocumentV1): Buffer {
  const bytes = Buffer.from(`${JSON.stringify(workflow, null, 2)}\n`, "utf8");
  if (bytes.byteLength < 1 || bytes.byteLength > CREATE_IMAGES_MAX_WORKFLOW_BYTES) {
    throw new CreateImagesNativeArchiveError(
      "archive_invalid",
      "The workflow exceeds the native archive limit.",
    );
  }
  return bytes;
}

function inventoryKind(entry: yauzl.Entry): CreateImagesArchiveInventoryEntry["kind"] {
  const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
  const fileType = unixMode & UNIX_FILE_TYPE_MASK;
  if (fileType === UNIX_SYMLINK) return "symlink";
  if (entry.fileName.endsWith("/") || fileType === UNIX_DIRECTORY) return "directory";
  return "file";
}

function inventoryEntry(entry: yauzl.Entry): CreateImagesArchiveInventoryEntry {
  return {
    path: entry.fileName,
    kind: inventoryKind(entry),
    encrypted: entry.isEncrypted(),
    compressionMethod: entry.compressionMethod,
    compressedBytes: entry.compressedSize,
    uncompressedBytes: entry.uncompressedSize,
    crc32: entry.crc32 >>> 0,
  };
}

async function boundedEntryBytes(
  zip: yauzl.ZipFile,
  entry: yauzl.Entry,
  maximumBytes: number,
): Promise<Buffer> {
  const stream = await zip.openReadStreamPromise(entry);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const raw of stream) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array);
    total += chunk.byteLength;
    if (total > maximumBytes) {
      stream.destroy();
      throw new CreateImagesNativeArchiveError("archive_invalid", "Archive entry is too large.");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

async function extractEntry(
  zip: yauzl.ZipFile,
  entry: yauzl.Entry,
  inventory: CreateImagesArchiveInventoryEntry,
  filePath: string,
): Promise<CreateImagesArchiveExtractedEntry> {
  const stream = await zip.openReadStreamPromise(entry);
  const handle = await fs.open(filePath, "wx", 0o600);
  const digest = createHash("sha256");
  const crc = new Crc32Accumulator();
  let byteLength = 0;
  try {
    for await (const raw of stream) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array);
      byteLength += chunk.byteLength;
      if (
        byteLength > inventory.uncompressedBytes ||
        byteLength > CREATE_IMAGES_ARCHIVE_MAX_TOTAL_BYTES
      ) {
        stream.destroy();
        throw new CreateImagesNativeArchiveError(
          "archive_invalid",
          "Archive entry exceeded its declared size.",
        );
      }
      digest.update(chunk);
      crc.update(chunk);
      let offset = 0;
      while (offset < chunk.byteLength) {
        const result = await handle.write(chunk, offset, chunk.byteLength - offset, null);
        if (result.bytesWritten < 1) throw new Error("Archive extraction made no progress.");
        offset += result.bytesWritten;
      }
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
  return {
    path: inventory.path,
    byteLength,
    crc32: crc.digest(),
    sha256: digest.digest("hex"),
  };
}

async function copyAssetToStage(source: string, destination: string): Promise<void> {
  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  const sourceHandle = await fs.open(source, constants.O_RDONLY | noFollow);
  const destinationHandle = await fs.open(destination, "wx", 0o600);
  try {
    const info = await sourceHandle.stat();
    if (!info.isFile()) throw new Error("The asset is not a regular file.");
    await pipeline(
      sourceHandle.createReadStream({ autoClose: true }),
      destinationHandle.createWriteStream({ autoClose: true }),
    );
  } finally {
    await Promise.allSettled([sourceHandle.close(), destinationHandle.close()]);
  }
  const durable = await fs.open(destination, "r");
  try {
    await durable.sync();
  } finally {
    await durable.close();
  }
}

async function writeZipAtomically(
  zip: yazl.ZipFile,
  destination: string,
): Promise<void> {
  const directory = path.dirname(destination);
  const temp = path.join(directory, `.${path.basename(destination)}.${randomUUID()}.tmp`);
  try {
    const output = createWriteStream(temp, { flags: "wx", mode: 0o600 });
    zip.end();
    await pipeline(zip.outputStream as Readable, output);
    const handle = await fs.open(temp, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
  try {
    await fs.rename(temp, destination);
    await fs.chmod(destination, 0o600);
    await syncDirectory(directory);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

function safeArchiveDestination(destination: string): string {
  if (!path.isAbsolute(destination) || destination.includes("\0")) {
    throw new CreateImagesNativeArchiveError("archive_io", "The archive destination is invalid.");
  }
  return destination.endsWith(CREATE_IMAGES_ARCHIVE_EXTENSION)
    ? destination
    : `${destination}${CREATE_IMAGES_ARCHIVE_EXTENSION}`;
}

export class CreateImagesNativeArchiveService {
  private readonly now: () => number;
  private readonly randomId: () => string;

  constructor(private readonly dependencies: CreateImagesNativeArchiveDependencies) {
    this.now = dependencies.now ?? Date.now;
    this.randomId = dependencies.randomId ?? randomUUID;
  }

  private async operationDirectory(): Promise<string> {
    const root = path.join(this.dependencies.rootDirectory, ARCHIVE_QUARANTINE_DIRECTORY);
    await ensurePrivateDirectory(root);
    return fs.mkdtemp(path.join(root, "operation-"));
  }

  async exportToFile(input: {
    workflowId: string;
    expectedRevision: number;
    destination: string;
  }): Promise<CreateImagesNativeArchiveExportResult> {
    const destination = safeArchiveDestination(input.destination);
    const workflow = await this.dependencies.workflows.get(input.workflowId);
    if (!workflow) {
      throw new CreateImagesNativeArchiveError(
        "archive_workflow_missing",
        "The workflow no longer exists.",
      );
    }
    if (workflow.revision !== input.expectedRevision) {
      throw new CreateImagesNativeArchiveError(
        "archive_revision_conflict",
        "The workflow changed before export.",
      );
    }
    const operationDirectory = await this.operationDirectory();
    try {
      const workflowBytes = serializeWorkflow(workflow);
      const exportedAt = new Date(this.now()).toISOString();
      const assets: CreateImagesArchiveManifestV1["assets"] = [];
      const stagedAssets: Array<{ path: string; filePath: string }> = [];
      for (const [index, assetId] of workflow.assetRefs.entries()) {
        await this.dependencies.assets.withAssetFile(assetId, async ({ filePath, asset }) => {
          const extension = asset.mediaType === "image/png" ? "png" : "jpg";
          const archivePath = `assets/${assetId}.${extension}`;
          const stagedPath = path.join(operationDirectory, `asset-${index}.${extension}`);
          await copyAssetToStage(filePath, stagedPath);
          const validated = await this.dependencies.assets.validateQuarantinedAssetFile(stagedPath, {
            declaredMimeType: asset.mediaType,
            displayName: `asset.${extension}`,
          });
          if (
            validated.sha256 !== assetId ||
            validated.mediaType !== asset.mediaType ||
            validated.byteLength !== asset.byteLength ||
            validated.width !== asset.width ||
            validated.height !== asset.height
          ) {
            throw new CreateImagesNativeArchiveError(
              "archive_invalid",
              "A referenced image changed before export.",
            );
          }
          assets.push({
            assetId,
            sha256: assetId,
            path: archivePath,
            mediaType: asset.mediaType,
            byteLength: asset.byteLength,
            width: asset.width,
            height: asset.height,
          });
          stagedAssets.push({ path: archivePath, filePath: stagedPath });
        });
      }
      const manifest: CreateImagesArchiveManifestV1 = {
        format: CREATE_IMAGES_ARCHIVE_FORMAT,
        version: CREATE_IMAGES_ARCHIVE_VERSION,
        exportedAt,
        workflow: {
          path: CREATE_IMAGES_ARCHIVE_WORKFLOW_PATH,
          sha256: createHash("sha256").update(workflowBytes).digest("hex"),
          byteLength: workflowBytes.byteLength,
        },
        assets,
      };
      const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      if (manifestBytes.byteLength > CREATE_IMAGES_ARCHIVE_MAX_MANIFEST_BYTES) {
        throw new CreateImagesNativeArchiveError(
          "archive_invalid",
          "The native archive manifest is too large.",
        );
      }
      const zip = new yazl.ZipFile();
      const zipOptions = { compress: false, mode: 0o100600, mtime: new Date(exportedAt) };
      zip.addBuffer(manifestBytes, CREATE_IMAGES_ARCHIVE_MANIFEST_PATH, zipOptions);
      zip.addBuffer(workflowBytes, CREATE_IMAGES_ARCHIVE_WORKFLOW_PATH, zipOptions);
      for (const asset of stagedAssets) zip.addFile(asset.filePath, asset.path, zipOptions);
      await writeZipAtomically(zip, destination);
      return {
        workflowId: workflow.id,
        revision: workflow.revision,
        fileName: path.basename(destination),
        assetCount: assets.length,
      };
    } catch (error) {
      if (error instanceof CreateImagesNativeArchiveError) throw error;
      throw new CreateImagesNativeArchiveError("archive_io", "The workflow could not be exported.");
    } finally {
      await fs.rm(operationDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async importFromFile(
    source: string,
    isCurrent: () => boolean = () => true,
  ): Promise<CreateImagesNativeArchiveImportResult> {
    if (!path.isAbsolute(source) || !source.endsWith(CREATE_IMAGES_ARCHIVE_EXTENSION)) {
      throw new CreateImagesNativeArchiveError("archive_invalid", "Choose an .aiden-images file.");
    }
    const operationDirectory = await this.operationDirectory();
    let zip: yauzl.ZipFile | undefined;
    try {
      zip = await yauzl.openPromise(source, {
        autoClose: false,
        lazyEntries: true,
        strictFileNames: true,
        validateEntrySizes: true,
      });
      if (zip.entryCount > CREATE_IMAGES_ARCHIVE_MAX_ENTRIES) {
        throw new CreateImagesNativeArchiveError(
          "archive_invalid",
          "The archive contains too many entries.",
        );
      }
      const entries: yauzl.Entry[] = [];
      for await (const entry of zip.eachEntry()) {
        entries.push(entry);
        if (entries.length > CREATE_IMAGES_ARCHIVE_MAX_ENTRIES) {
          throw new CreateImagesNativeArchiveError(
            "archive_invalid",
            "The archive contains too many entries.",
          );
        }
      }
      const inventory = entries.map(inventoryEntry);
      if (validateCreateImagesArchiveBootstrap(inventory).length > 0) {
        throw new CreateImagesNativeArchiveError("archive_invalid", "The archive is unsafe.");
      }
      const manifestIndex = inventory.findIndex(
        (entry) => entry.path === CREATE_IMAGES_ARCHIVE_MANIFEST_PATH,
      );
      const manifestBytes = await boundedEntryBytes(
        zip,
        entries[manifestIndex]!,
        CREATE_IMAGES_ARCHIVE_MAX_MANIFEST_BYTES,
      );
      const manifestResult = parseCreateImagesArchiveManifestBytes(
        manifestBytes,
        inventory[manifestIndex]!,
      );
      if (!manifestResult.success) {
        throw new CreateImagesNativeArchiveError("archive_invalid", "The archive manifest is invalid.");
      }
      const manifest = manifestResult.value;
      if (validateCreateImagesArchiveInventory(manifest, inventory).length > 0) {
        throw new CreateImagesNativeArchiveError("archive_invalid", "The archive inventory is invalid.");
      }

      const quarantined: QuarantinedEntry[] = [];
      let extractedTotal = 0;
      for (const [index, entry] of entries.entries()) {
        const filePath = path.join(operationDirectory, `entry-${index}.bin`);
        const extracted = await extractEntry(zip, entry, inventory[index]!, filePath);
        extractedTotal += extracted.byteLength;
        if (extractedTotal > CREATE_IMAGES_ARCHIVE_MAX_TOTAL_BYTES) {
          throw new CreateImagesNativeArchiveError("archive_invalid", "The archive is too large.");
        }
        quarantined.push({ path: entry.fileName, filePath, extracted });
      }
      if (
        validateCreateImagesArchiveExtractedEntries(
          manifest,
          inventory,
          quarantined.map((entry) => entry.extracted),
        ).length > 0
      ) {
        throw new CreateImagesNativeArchiveError("archive_invalid", "Archive contents are invalid.");
      }

      const workflowEntry = quarantined.find(
        (entry) => entry.path === CREATE_IMAGES_ARCHIVE_WORKFLOW_PATH,
      );
      if (!workflowEntry) {
        throw new CreateImagesNativeArchiveError("archive_invalid", "The workflow entry is missing.");
      }
      const workflowBytes = await fs.readFile(workflowEntry.filePath);
      let workflowValue: unknown;
      try {
        workflowValue = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(workflowBytes));
      } catch {
        throw new CreateImagesNativeArchiveError("archive_invalid", "The workflow JSON is invalid.");
      }
      const parsedWorkflow = parseWorkflowDocument(workflowValue);
      if (!parsedWorkflow.success) {
        throw new CreateImagesNativeArchiveError("archive_invalid", "The workflow schema is invalid.");
      }

      const validatedAssets: CreateImagesArchiveValidatedAsset[] = [];
      for (const expected of manifest.assets) {
        const archived = quarantined.find((entry) => entry.path === expected.path);
        if (!archived) {
          throw new CreateImagesNativeArchiveError("archive_invalid", "An image entry is missing.");
        }
        const actual = await this.dependencies.assets.validateQuarantinedAssetFile(
          archived.filePath,
          { declaredMimeType: expected.mediaType, displayName: path.basename(expected.path) },
        );
        if (actual.sha256 !== expected.assetId) {
          throw new CreateImagesNativeArchiveError("archive_invalid", "An image digest is invalid.");
        }
        validatedAssets.push({
          assetId: expected.assetId,
          mediaType: actual.mediaType,
          byteLength: actual.byteLength,
          width: actual.width,
          height: actual.height,
        });
      }
      if (
        validateCreateImagesArchiveWorkflowAssets(
          manifest,
          parsedWorkflow.value,
          validatedAssets,
        ).length > 0
      ) {
        throw new CreateImagesNativeArchiveError(
          "archive_invalid",
          "Workflow image references are invalid.",
        );
      }

      for (const expected of manifest.assets) {
        const archived = quarantined.find((entry) => entry.path === expected.path)!;
        const result = await this.dependencies.assets.ingest(createReadStream(archived.filePath), {
          origin: { kind: "import" },
          declaredMimeType: expected.mediaType,
          displayName: path.basename(expected.path),
          validationDisplayName: path.basename(expected.path),
        });
        if (result.asset.assetId !== expected.assetId) {
          throw new CreateImagesNativeArchiveError("archive_invalid", "An imported image changed.");
        }
      }

      const now = new Date(this.now()).toISOString();
      const imported: WorkflowDocumentV1 = {
        ...structuredClone(parsedWorkflow.value),
        id: this.randomId(),
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      const published = await this.dependencies.publishImportedWorkflow(imported, isCurrent);
      return {
        workflow: published,
        sourceFileName: path.basename(source),
        importedAssetCount: manifest.assets.length,
      };
    } catch (error) {
      if (error instanceof CreateImagesNativeArchiveError) throw error;
      throw new CreateImagesNativeArchiveError("archive_invalid", "The archive could not be imported.");
    } finally {
      zip?.close();
      await fs.rm(operationDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
