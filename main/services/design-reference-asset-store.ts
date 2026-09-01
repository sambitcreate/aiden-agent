import { createHash } from "node:crypto";
import { DataStore } from "./data-store.js";
import { validateDisplayImageDimensions } from "./display-image-extension.js";
import { isCanonicalRasterImageMimeType } from "../../renderer/shared/attachment-contract.js";
import {
  DESIGN_REFERENCE_ASSET_VERSION,
  type DesignReferenceAssetV1,
} from "../../renderer/shared/design-reference-assets.js";

const STORE_VERSION = DESIGN_REFERENCE_ASSET_VERSION;
const STORE_FILE = "design-reference-assets.json";
export const MAX_DESIGN_REFERENCE_ASSET_BYTES = 8 * 1024 * 1024;
export const MAX_DESIGN_REFERENCE_ASSET_RECORDS = 256;
export const MAX_DESIGN_REFERENCE_ASSET_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_STORE_BYTES = 96 * 1024 * 1024;
const DATABASE_KEYS = new Set(["version", "revision", "records"]);
const RECORD_KEYS = new Set([
  "version",
  "id",
  "name",
  "mimeType",
  "size",
  "width",
  "height",
  "createdAt",
  "data",
]);
const ASSET_ID = /^[a-f0-9]{64}$/u;

interface StoredDesignReferenceAssetV1 extends DesignReferenceAssetV1 {
  /** Canonical base64 without a data-URL prefix. */
  data: string;
}

interface DesignReferenceAssetDatabaseV1 {
  version: typeof STORE_VERSION;
  revision: number;
  records: StoredDesignReferenceAssetV1[];
}

export interface DesignReferenceAssetStoreOptions {
  root?: () => string;
  filename?: string;
  now?: () => number;
  dataStore?: DataStore<DesignReferenceAssetDatabaseV1>;
}

function exactKeys(value: Record<string, unknown>, expected: ReadonlySet<string>): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.size && keys.every((key) => expected.has(key));
}

function boundedText(value: unknown, maxCharacters: number): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxCharacters ||
    value.trim() !== value
  ) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return false;
  }
  return true;
}

function canonicalBase64(value: unknown, expectedBytes: number): Buffer | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length % 4 !== 0) return undefined;
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    return undefined;
  }
  const bytes = Buffer.from(value, "base64");
  return bytes.byteLength === expectedBytes && bytes.toString("base64") === value
    ? bytes
    : undefined;
}

function parseRecord(value: unknown): StoredDesignReferenceAssetV1 | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    !exactKeys(record, RECORD_KEYS) ||
    record.version !== STORE_VERSION ||
    typeof record.id !== "string" ||
    !ASSET_ID.test(record.id) ||
    !boundedText(record.name, 255) ||
    !isCanonicalRasterImageMimeType(record.mimeType) ||
    !Number.isSafeInteger(record.size) ||
    (record.size as number) < 1 ||
    (record.size as number) > MAX_DESIGN_REFERENCE_ASSET_BYTES ||
    !Number.isSafeInteger(record.width) ||
    (record.width as number) < 1 ||
    !Number.isSafeInteger(record.height) ||
    (record.height as number) < 1 ||
    typeof record.createdAt !== "number" ||
    !Number.isFinite(record.createdAt) ||
    record.createdAt < 0
  ) {
    return undefined;
  }
  const bytes = canonicalBase64(record.data, record.size as number);
  if (!bytes || createHash("sha256").update(bytes).digest("hex") !== record.id) return undefined;
  try {
    const dimensions = validateDisplayImageDimensions(bytes, record.mimeType, record.name);
    if (dimensions.width !== record.width || dimensions.height !== record.height) return undefined;
  } catch {
    return undefined;
  }
  return record as unknown as StoredDesignReferenceAssetV1;
}

function parseDatabase(value: unknown): DesignReferenceAssetDatabaseV1 | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const database = value as Record<string, unknown>;
  if (
    !exactKeys(database, DATABASE_KEYS) ||
    database.version !== STORE_VERSION ||
    !Number.isSafeInteger(database.revision) ||
    (database.revision as number) < 0 ||
    !Array.isArray(database.records) ||
    database.records.length > MAX_DESIGN_REFERENCE_ASSET_RECORDS
  ) {
    return undefined;
  }
  const records = database.records.map(parseRecord);
  if (records.some((record) => !record)) return undefined;
  const parsed = records as StoredDesignReferenceAssetV1[];
  if (new Set(parsed.map((record) => record.id)).size !== parsed.length) return undefined;
  if (
    parsed.reduce((total, record) => total + record.size, 0) >
    MAX_DESIGN_REFERENCE_ASSET_TOTAL_BYTES
  ) {
    return undefined;
  }
  return {
    version: STORE_VERSION,
    revision: database.revision as number,
    records: parsed,
  };
}

function emptyDatabase(): DesignReferenceAssetDatabaseV1 {
  return { version: STORE_VERSION, revision: 0, records: [] };
}

function descriptor(record: StoredDesignReferenceAssetV1): DesignReferenceAssetV1 {
  const { data: _data, ...asset } = record;
  return structuredClone(asset);
}

function createDataStore(
  options: DesignReferenceAssetStoreOptions,
): DataStore<DesignReferenceAssetDatabaseV1> {
  return new DataStore(options.filename ?? STORE_FILE, emptyDatabase(), options.root, {
    maxBytes: MAX_STORE_BYTES,
    fileMode: 0o600,
    normalize: (value) => parseDatabase(value) ?? emptyDatabase(),
    isSafe: (value) => parseDatabase(value) !== undefined,
    rejectCorruptWrite: true,
    rejectUnsafeWrite: true,
  });
}

/** Device-local, content-addressed storage for reusable Design reference images. */
export class DesignReferenceAssetStore {
  private readonly data: DataStore<DesignReferenceAssetDatabaseV1>;
  private readonly now: () => number;
  private initialized = false;
  private unavailableReason: string | null = null;

  constructor(options: DesignReferenceAssetStoreOptions = {}) {
    this.data = options.dataStore ?? createDataStore(options);
    this.now = options.now ?? Date.now;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.data.load();
    if (await this.data.loadedFromCorruptFile()) {
      this.unavailableReason = "Design reference asset storage is unreadable.";
    } else if (await this.data.loadedFromUnsafeFile()) {
      this.unavailableReason = "Design reference asset storage has an unsupported shape.";
    }
    this.initialized = true;
  }

  availability(): { available: true } | { available: false; reason: string } {
    this.requireInitialized();
    return this.unavailableReason
      ? { available: false, reason: this.unavailableReason }
      : { available: true };
  }

  private requireInitialized(): void {
    if (!this.initialized) throw new Error("Design reference asset storage is not initialized.");
  }

  private requireAvailable(): void {
    this.requireInitialized();
    if (this.unavailableReason) throw new Error(this.unavailableReason);
  }

  async put(input: {
    name: string;
    mimeType: string;
    bytes: Uint8Array;
  }): Promise<DesignReferenceAssetV1> {
    this.requireAvailable();
    if (!boundedText(input.name, 255) || !isCanonicalRasterImageMimeType(input.mimeType)) {
      throw new Error("Invalid Design reference image metadata.");
    }
    const bytes = Buffer.from(input.bytes);
    if (bytes.byteLength < 1 || bytes.byteLength > MAX_DESIGN_REFERENCE_ASSET_BYTES) {
      throw new Error("Design reference images must be 8 MB or smaller.");
    }
    const dimensions = validateDisplayImageDimensions(bytes, input.mimeType, input.name);
    const id = createHash("sha256").update(bytes).digest("hex");
    return this.data.update((database) => {
      const existing = database.records.find((record) => record.id === id);
      if (existing) return descriptor(existing);
      if (database.records.length >= MAX_DESIGN_REFERENCE_ASSET_RECORDS) {
        throw new Error("Design reference image storage is at capacity.");
      }
      const totalBytes = database.records.reduce(
        (total, record) => total + record.size,
        bytes.byteLength,
      );
      if (totalBytes > MAX_DESIGN_REFERENCE_ASSET_TOTAL_BYTES) {
        throw new Error("Design reference image storage reached its byte limit.");
      }
      const record: StoredDesignReferenceAssetV1 = {
        version: STORE_VERSION,
        id,
        name: input.name,
        mimeType: input.mimeType,
        size: bytes.byteLength,
        width: dimensions.width,
        height: dimensions.height,
        createdAt: this.now(),
        data: bytes.toString("base64"),
      };
      database.records.push(record);
      database.revision += 1;
      return descriptor(record);
    });
  }

  async list(): Promise<DesignReferenceAssetV1[]> {
    this.requireAvailable();
    return (await this.data.load()).records.map(descriptor);
  }

  async read(id: string): Promise<{ asset: DesignReferenceAssetV1; bytes: Buffer } | undefined> {
    this.requireAvailable();
    if (!ASSET_ID.test(id)) return undefined;
    const record = (await this.data.load()).records.find((candidate) => candidate.id === id);
    if (!record) return undefined;
    return { asset: descriptor(record), bytes: Buffer.from(record.data, "base64") };
  }

  async collectGarbage(liveIds: ReadonlySet<string>): Promise<number> {
    this.requireAvailable();
    if ([...liveIds].some((id) => !ASSET_ID.test(id))) {
      throw new Error("Invalid live Design reference image identity.");
    }
    return this.data.update((database) => {
      const before = database.records.length;
      database.records = database.records.filter((record) => liveIds.has(record.id));
      const removed = before - database.records.length;
      if (removed > 0) database.revision += 1;
      return removed;
    });
  }

  /**
   * Delete only identities captured by an earlier project cascade after the
   * caller has revalidated the current project graph. Unlike broad garbage
   * collection, unattached uploads outside that deletion remain untouched.
   */
  async deleteUnreferencedCandidates(
    candidateIds: readonly string[],
    liveIds: ReadonlySet<string>,
  ): Promise<number> {
    this.requireAvailable();
    if (
      candidateIds.some((id) => !ASSET_ID.test(id)) ||
      new Set(candidateIds).size !== candidateIds.length ||
      [...liveIds].some((id) => !ASSET_ID.test(id))
    ) {
      throw new Error("Invalid Design reference image deletion identity.");
    }
    const candidates = new Set(candidateIds.filter((id) => !liveIds.has(id)));
    if (candidates.size === 0) return 0;
    return this.data.update((database) => {
      const before = database.records.length;
      database.records = database.records.filter((record) => !candidates.has(record.id));
      const removed = before - database.records.length;
      if (removed > 0) database.revision += 1;
      return removed;
    });
  }
}

export const designReferenceAssetStore = new DesignReferenceAssetStore();
