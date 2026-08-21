import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const PRESENTATION_FILE = "presentation.json";
const PRESENTATION_VERSION = 1;
const MAX_WORKFLOWS = 500;
const MAX_HIDDEN_ASSETS_PER_WORKFLOW = 50;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const ASSET_ID_PATTERN = /^[a-f0-9]{64}$/u;

interface PresentationDocumentV1 {
  version: 1;
  workflows: Record<string, { hiddenAssetIds: string[] }>;
}

function emptyDocument(): PresentationDocumentV1 {
  return { version: PRESENTATION_VERSION, workflows: {} };
}

function parseDocument(value: unknown): PresentationDocumentV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid");
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some((key) => key !== "version" && key !== "workflows") ||
    record.version !== PRESENTATION_VERSION ||
    !record.workflows ||
    typeof record.workflows !== "object" ||
    Array.isArray(record.workflows)
  ) {
    throw new Error("invalid");
  }
  const entries = Object.entries(record.workflows as Record<string, unknown>);
  if (entries.length > MAX_WORKFLOWS) throw new Error("invalid");
  const workflows: PresentationDocumentV1["workflows"] = {};
  for (const [workflowId, raw] of entries) {
    if (!OPAQUE_ID_PATTERN.test(workflowId) || !raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("invalid");
    }
    const entry = raw as Record<string, unknown>;
    if (
      Object.keys(entry).some((key) => key !== "hiddenAssetIds") ||
      !Array.isArray(entry.hiddenAssetIds) ||
      entry.hiddenAssetIds.length > MAX_HIDDEN_ASSETS_PER_WORKFLOW ||
      !entry.hiddenAssetIds.every(
        (assetId) => typeof assetId === "string" && ASSET_ID_PATTERN.test(assetId),
      ) ||
      new Set(entry.hiddenAssetIds).size !== entry.hiddenAssetIds.length
    ) {
      throw new Error("invalid");
    }
    workflows[workflowId] = { hiddenAssetIds: [...entry.hiddenAssetIds] };
  }
  return { version: PRESENTATION_VERSION, workflows };
}

/** Device-local presentation state. This never owns or retains an asset. */
export class CreateImagesPresentationStore {
  private readonly filePath: string;
  private tail: Promise<void> = Promise.resolve();

  constructor(rootDirectory: string) {
    this.filePath = path.join(rootDirectory, PRESENTATION_FILE);
  }

  private serialized<Result>(operation: () => Promise<Result>): Promise<Result> {
    const result = this.tail.then(operation, operation);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async read(): Promise<PresentationDocumentV1> {
    try {
      const bytes = await fs.readFile(this.filePath, "utf8");
      if (Buffer.byteLength(bytes, "utf8") > 256 * 1024) throw new Error("invalid");
      return parseDocument(JSON.parse(bytes) as unknown);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyDocument();
      // Presentation is disposable and never authoritative. Corrupt/future data
      // fails closed to an empty view without touching run journals or assets.
      return emptyDocument();
    }
  }

  private async write(document: PresentationDocumentV1): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, `${JSON.stringify(document)}\n`, { encoding: "utf8", mode: 0o600 });
      await fs.rename(temporary, this.filePath);
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  hiddenAssetIds(workflowId: string): Promise<string[]> {
    return this.serialized(async () => {
      if (!OPAQUE_ID_PATTERN.test(workflowId)) throw new Error("invalid");
      return [...(await this.read()).workflows[workflowId]?.hiddenAssetIds ?? []];
    });
  }

  setAssetHidden(workflowId: string, assetId: string, hidden: boolean): Promise<string[]> {
    return this.serialized(async () => {
      if (!OPAQUE_ID_PATTERN.test(workflowId) || !ASSET_ID_PATTERN.test(assetId)) {
        throw new Error("invalid");
      }
      const document = await this.read();
      const hiddenAssetIds = new Set(document.workflows[workflowId]?.hiddenAssetIds ?? []);
      if (hidden) hiddenAssetIds.add(assetId);
      else hiddenAssetIds.delete(assetId);
      if (hiddenAssetIds.size > MAX_HIDDEN_ASSETS_PER_WORKFLOW) {
        throw new Error("limit");
      }
      if (hiddenAssetIds.size > 0) {
        if (!document.workflows[workflowId] && Object.keys(document.workflows).length >= MAX_WORKFLOWS) {
          throw new Error("limit");
        }
        document.workflows[workflowId] = { hiddenAssetIds: [...hiddenAssetIds].sort() };
      } else {
        delete document.workflows[workflowId];
      }
      await this.write(document);
      return [...hiddenAssetIds].sort();
    });
  }
}
