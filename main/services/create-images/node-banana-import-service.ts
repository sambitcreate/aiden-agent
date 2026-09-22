import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  convertNodeBananaWorkflow,
  CreateImagesNodeBananaImportError,
  type CreateImagesNodeBananaImportReport,
} from "../../../renderer/shared/create-images/node-banana-import.js";
import {
  CREATE_IMAGES_MAX_WORKFLOW_BYTES,
  parseWorkflowDocument,
  type WorkflowDocumentV1,
} from "../../../renderer/shared/create-images/schema.js";
import { decodeUtf8, readRegularFile } from "../regular-file-read.js";
import type { ContentAddressedAssetStore } from "./asset-store-core.js";
import { ingestCreateImagesImageFile } from "./electron-asset-import.js";

const COMPATIBILITY_QUARANTINE_DIRECTORY = "compatibility-import-quarantine";

export type CreateImagesNodeBananaServiceErrorCode = "invalid" | "io";

export class CreateImagesNodeBananaServiceError extends Error {
  constructor(
    readonly code: CreateImagesNodeBananaServiceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CreateImagesNodeBananaServiceError";
  }
}

export interface CreateImagesNodeBananaImportDependencies {
  rootDirectory: string;
  assets: ContentAddressedAssetStore;
  publishImportedWorkflow(
    workflow: WorkflowDocumentV1,
    isCurrent: () => boolean,
  ): Promise<WorkflowDocumentV1>;
  now?: () => number;
  randomId?: () => string;
}

export interface CreateImagesNodeBananaImportResult {
  workflow: WorkflowDocumentV1;
  sourceFileName: string;
  importedAssetCount: number;
  report: CreateImagesNodeBananaImportReport;
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
    throw new CreateImagesNodeBananaServiceError("io", "Compatibility import is unavailable.");
  }
  await fs.chmod(directory, 0o700);
  if (created !== undefined) await syncDirectory(path.dirname(directory));
}

function extensionFor(mediaType: string): string {
  const subtype = mediaType.slice("image/".length).toLowerCase();
  if (subtype === "jpeg" || subtype === "pjpeg") return "jpg";
  if (subtype === "svg+xml") return "svg";
  const safe = subtype.replace(/[^a-z0-9]/gu, "").slice(0, 12);
  return safe || "image";
}

function decodeCanonicalBase64(value: string): Buffer {
  const bytes = Buffer.from(value, "base64");
  if (bytes.byteLength < 1 || bytes.toString("base64") !== value) {
    throw new CreateImagesNodeBananaServiceError("invalid", "An embedded image is malformed.");
  }
  return bytes;
}

function updateImageEntry(
  report: CreateImagesNodeBananaImportReport,
  sourceNodeIndex: number,
  suffix: string,
): void {
  const entry = report.entries.find((candidate) => candidate.sourceNodeIndex === sourceNodeIndex);
  if (entry) entry.message = `${entry.message} ${suffix}`;
}

export class CreateImagesNodeBananaImportService {
  private readonly now: () => number;
  private readonly randomId: () => string;

  constructor(private readonly dependencies: CreateImagesNodeBananaImportDependencies) {
    this.now = dependencies.now ?? Date.now;
    this.randomId = dependencies.randomId ?? randomUUID;
  }

  private async operationDirectory(): Promise<string> {
    const root = path.join(this.dependencies.rootDirectory, COMPATIBILITY_QUARANTINE_DIRECTORY);
    await ensurePrivateDirectory(root);
    return fs.mkdtemp(path.join(root, "operation-"));
  }

  async importFromFile(
    source: string,
    isCurrent: () => boolean = () => true,
  ): Promise<CreateImagesNodeBananaImportResult> {
    if (!path.isAbsolute(source) || path.extname(source).toLowerCase() !== ".json") {
      throw new CreateImagesNodeBananaServiceError("invalid", "Choose a Node Banana JSON file.");
    }
    const operationDirectory = await this.operationDirectory();
    try {
      let value: unknown;
      try {
        const bytes = await readRegularFile(source, CREATE_IMAGES_MAX_WORKFLOW_BYTES);
        value = JSON.parse(decodeUtf8(bytes));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EFBIG") {
          throw new CreateImagesNodeBananaServiceError(
            "invalid",
            "The Node Banana workflow exceeds Aiden's import limit.",
          );
        }
        throw new CreateImagesNodeBananaServiceError("invalid", "The Node Banana JSON is invalid.");
      }

      const now = new Date(this.now()).toISOString();
      const converted = convertNodeBananaWorkflow(value, {
        workflowId: this.randomId(),
        now,
        nextId: this.randomId,
      });
      const assetIdsByNode = new Map<string, string>();
      for (const [index, image] of converted.inlineImages.entries()) {
        const extension = extensionFor(image.mediaType);
        const filePath = path.join(operationDirectory, `image-${index}.${extension}`);
        try {
          const bytes = decodeCanonicalBase64(image.base64);
          const handle = await fs.open(filePath, "wx", 0o600);
          try {
            await handle.writeFile(bytes);
            await handle.sync();
          } finally {
            await handle.close();
          }
          const imported = await ingestCreateImagesImageFile(this.dependencies.assets, filePath);
          assetIdsByNode.set(image.targetNodeId, imported.asset.assetId);
          converted.report.importedEmbeddedImageCount += 1;
          updateImageEntry(
            converted.report,
            image.sourceNodeIndex,
            imported.deduplicated
              ? "The validated image matched an existing device-local asset."
              : "The validated image was stored as a device-local asset.",
          );
        } catch {
          converted.report.skippedEmbeddedImageCount += 1;
          updateImageEntry(
            converted.report,
            image.sourceNodeIndex,
            "Its embedded image failed safe decoding and was left empty.",
          );
        }
      }

      const assetRefs: string[] = [];
      const seenAssetIds = new Set<string>();
      const nodes = converted.workflow.nodes.map((node) => {
        if (node.type !== "image-input") return node;
        const assetId = assetIdsByNode.get(node.id);
        if (!assetId) return node;
        if (!seenAssetIds.has(assetId)) {
          seenAssetIds.add(assetId);
          assetRefs.push(assetId);
        }
        return { ...node, data: { ...node.data, assetId } };
      });
      const finalized = parseWorkflowDocument({
        ...converted.workflow,
        nodes,
        assetRefs,
      });
      if (!finalized.success) {
        throw new CreateImagesNodeBananaServiceError(
          "invalid",
          "The converted workflow failed Aiden's schema.",
        );
      }
      const workflow = await this.dependencies.publishImportedWorkflow(finalized.value, isCurrent);
      return {
        workflow,
        sourceFileName: path.basename(source),
        importedAssetCount: assetRefs.length,
        report: converted.report,
      };
    } catch (error) {
      if (
        error instanceof CreateImagesNodeBananaServiceError ||
        error instanceof CreateImagesNodeBananaImportError
      ) {
        throw error;
      }
      throw new CreateImagesNodeBananaServiceError(
        "invalid",
        "The Node Banana workflow could not be imported safely.",
      );
    } finally {
      await fs.rm(operationDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
