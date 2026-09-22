import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { DataStore } from "./data-store.js";
import { isDesignProjectOpaqueId } from "./design-project-contract.js";

const STORE_FILE = "design-project-exports.json";
const STORE_VERSION = 1 as const;
const MAX_RECORDS = 2_000;
const MAX_STORE_BYTES = 2 * 1024 * 1024;
const SAFE_HASH = /^[a-f0-9]{64}$/u;

export interface DesignProjectExportRecordV1 {
  version: 1;
  id: string;
  projectId: string;
  lineageId: string;
  mediaId: string;
  contentHash: string;
  filePath: string;
  exportedAt: number;
}

interface DesignProjectExportDatabaseV1 {
  version: 1;
  records: DesignProjectExportRecordV1[];
}

function safeTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function safeFilePath(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 4_096 ||
    value.normalize("NFKC") !== value ||
    !path.isAbsolute(value) ||
    path.normalize(value) !== value
  ) {
    return false;
  }
  return !Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}

function parseRecord(value: unknown): DesignProjectExportRecordV1 | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 8 ||
    record.version !== STORE_VERSION ||
    !isDesignProjectOpaqueId(record.id) ||
    !isDesignProjectOpaqueId(record.projectId) ||
    !isDesignProjectOpaqueId(record.lineageId) ||
    !isDesignProjectOpaqueId(record.mediaId) ||
    typeof record.contentHash !== "string" ||
    !SAFE_HASH.test(record.contentHash) ||
    !safeFilePath(record.filePath) ||
    !safeTimestamp(record.exportedAt)
  ) {
    return undefined;
  }
  return record as unknown as DesignProjectExportRecordV1;
}

function parseDatabase(
  value: unknown,
): DesignProjectExportDatabaseV1 | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 2 ||
    record.version !== STORE_VERSION ||
    !Array.isArray(record.records) ||
    record.records.length > MAX_RECORDS
  ) {
    return undefined;
  }
  const records = record.records.map(parseRecord);
  if (records.some((item) => !item)) return undefined;
  const parsed = records as DesignProjectExportRecordV1[];
  if (new Set(parsed.map(({ id }) => id)).size !== parsed.length)
    return undefined;
  const database = {
    version: STORE_VERSION,
    records: parsed,
  } satisfies DesignProjectExportDatabaseV1;
  return Buffer.byteLength(JSON.stringify(database), "utf8") <= MAX_STORE_BYTES
    ? database
    : undefined;
}

export class DesignProjectExportHistoryStore {
  private readonly data: DataStore<DesignProjectExportDatabaseV1>;
  private initialized = false;
  private unavailableReason: string | null = null;

  constructor(
    options: {
      root?: () => string;
      now?: () => number;
      mintId?: () => string;
    } = {},
  ) {
    this.now = options.now ?? Date.now;
    this.mintId = options.mintId ?? (() => `export:${randomUUID()}`);
    this.data = new DataStore(
      STORE_FILE,
      { version: STORE_VERSION, records: [] },
      options.root,
      {
        maxBytes: MAX_STORE_BYTES,
        fileMode: 0o600,
        normalize: (value) =>
          parseDatabase(value) ?? { version: STORE_VERSION, records: [] },
        isSafe: (value) => parseDatabase(value) !== undefined,
        rejectCorruptWrite: true,
        rejectUnsafeWrite: true,
        rejectExternalChanges: true,
        reloadBeforeWrite: true,
      },
    );
  }

  private readonly now: () => number;
  private readonly mintId: () => string;

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.data.load();
    if (await this.data.loadedFromCorruptFile()) {
      this.unavailableReason = "Design export history is unreadable.";
    } else if (await this.data.loadedFromUnsafeFile()) {
      this.unavailableReason =
        "Design export history has an unsupported shape.";
    }
    this.initialized = true;
  }

  availability(): { available: true } | { available: false; reason: string } {
    if (!this.initialized)
      return {
        available: false,
        reason: "Design export history is not initialized.",
      };
    return this.unavailableReason
      ? { available: false, reason: this.unavailableReason }
      : { available: true };
  }

  async record(input: {
    projectId: string;
    lineageId: string;
    mediaId: string;
    contentHash: string;
    filePath: string;
  }): Promise<{ id: string; fileName: string }> {
    const availability = this.availability();
    if (!availability.available) throw new Error(availability.reason);
    const exportedAt = Math.floor(this.now());
    const candidate = parseRecord({
      version: STORE_VERSION,
      id: this.mintId(),
      ...input,
      exportedAt,
    });
    if (!candidate) throw new Error("Invalid Design export history record.");
    await this.data.update((database) => {
      if (database.records.some(({ id }) => id === candidate.id)) {
        throw new Error("Design export history identity was reused.");
      }
      database.records.push(candidate);
      database.records.sort(
        (left, right) =>
          right.exportedAt - left.exportedAt || left.id.localeCompare(right.id),
      );
      if (database.records.length > MAX_RECORDS)
        database.records.length = MAX_RECORDS;
    });
    return { id: candidate.id, fileName: path.basename(candidate.filePath) };
  }

  async get(id: string): Promise<DesignProjectExportRecordV1 | undefined> {
    const availability = this.availability();
    if (!availability.available) throw new Error(availability.reason);
    if (!isDesignProjectOpaqueId(id)) return undefined;
    const record = (await this.data.load()).records.find(
      (candidate) => candidate.id === id,
    );
    return record ? structuredClone(record) : undefined;
  }

  async latestForProject(
    projectId: string,
  ): Promise<{ id: string; fileName: string } | undefined> {
    const availability = this.availability();
    if (!availability.available) throw new Error(availability.reason);
    if (!isDesignProjectOpaqueId(projectId)) return undefined;
    const record = (await this.data.load()).records.find(
      (candidate) => candidate.projectId === projectId,
    );
    return record
      ? { id: record.id, fileName: path.basename(record.filePath) }
      : undefined;
  }
}

export const designProjectExportHistoryStore =
  new DesignProjectExportHistoryStore();
