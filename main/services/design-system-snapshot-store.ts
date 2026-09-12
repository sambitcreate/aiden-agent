import { randomUUID } from "node:crypto";
import { DataStore } from "./data-store.js";
import {
  DESIGN_SYSTEM_MAX_RECORD_BYTES,
  createDesignSystemAttachment,
  detachDesignSystemAttachment,
  getCurrentDesignSystemSnapshot,
  parseDesignSystemAttachmentRecord,
  refreshDesignSystemAttachment,
  type DesignSystemAttachmentRecordV1,
  type DesignSystemAuthorizedSource,
  type DesignSystemFreshness,
  type DesignSystemSnapshotV1,
} from "./design-system-snapshot-core.js";

export const DESIGN_SYSTEM_STORE_VERSION = 1 as const;
export const DESIGN_SYSTEM_STORE_FILENAME = "design-system-snapshots.json";
export const DESIGN_SYSTEM_MAX_ATTACHMENTS = 64;
export const DESIGN_SYSTEM_STORE_MAX_BYTES = 8 * 1024 * 1024;

interface DesignSystemSnapshotDatabaseV1 {
  version: 1;
  revision: number;
  attachments: DesignSystemAttachmentRecordV1[];
}

export interface DesignSystemRendererProjectionV1 {
  version: 1;
  attachmentId: string;
  revision: number;
  state: "attached" | "detached";
  updatedAt: number;
  freshness: DesignSystemFreshness;
  /** Path-free normalized data; null unless current source bytes were proven. */
  snapshot: DesignSystemSnapshotV1 | null;
}

export interface DesignSystemSnapshotStoreOptions {
  root?: () => string;
  filename?: string;
  now?: () => number;
  mintAttachmentId?: () => string;
  dataStore?: DataStore<DesignSystemSnapshotDatabaseV1>;
}

export class DesignSystemSnapshotStoreUnavailableError extends Error {
  constructor(message = "Design-system snapshot storage is unavailable.") {
    super(message);
    this.name = "DesignSystemSnapshotStoreUnavailableError";
  }
}

export class DesignSystemSnapshotStoreNotFoundError extends Error {
  constructor() {
    super("Design-system attachment was not found.");
    this.name = "DesignSystemSnapshotStoreNotFoundError";
  }
}

export class DesignSystemSnapshotStoreConflictError extends Error {
  readonly currentRevision: number;

  constructor(currentRevision: number) {
    super("Design-system attachment changed since it was opened.");
    this.name = "DesignSystemSnapshotStoreConflictError";
    this.currentRevision = currentRevision;
  }
}

function emptyDatabase(): DesignSystemSnapshotDatabaseV1 {
  return { version: 1, revision: 0, attachments: [] };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function parseDatabase(value: unknown): DesignSystemSnapshotDatabaseV1 | undefined {
  try {
    if (
      !isPlainRecord(value) ||
      Object.keys(value).length !== 3 ||
      !Object.keys(value).every((key) => ["version", "revision", "attachments"].includes(key)) ||
      value.version !== 1 ||
      !Number.isSafeInteger(value.revision) ||
      (value.revision as number) < 0 ||
      !Array.isArray(value.attachments) ||
      value.attachments.length > DESIGN_SYSTEM_MAX_ATTACHMENTS
    ) {
      return undefined;
    }
    const attachments = value.attachments.map(parseDesignSystemAttachmentRecord);
    if (new Set(attachments.map(({ attachmentId }) => attachmentId)).size !== attachments.length) {
      return undefined;
    }
    const database = {
      version: 1 as const,
      revision: value.revision as number,
      attachments: attachments.sort((left, right) =>
        left.attachmentId.localeCompare(right.attachmentId, "en"),
      ),
    };
    if (
      database.attachments.some(
        (record) =>
          Buffer.byteLength(JSON.stringify(record), "utf8") > DESIGN_SYSTEM_MAX_RECORD_BYTES,
      ) ||
      Buffer.byteLength(JSON.stringify(database), "utf8") > DESIGN_SYSTEM_STORE_MAX_BYTES
    ) {
      return undefined;
    }
    return database;
  } catch {
    return undefined;
  }
}

function createDataStore(options: DesignSystemSnapshotStoreOptions) {
  return new DataStore<DesignSystemSnapshotDatabaseV1>(
    options.filename ?? DESIGN_SYSTEM_STORE_FILENAME,
    emptyDatabase(),
    options.root,
    {
      maxBytes: DESIGN_SYSTEM_STORE_MAX_BYTES,
      fileMode: 0o600,
      normalize: (value) => parseDatabase(value) ?? emptyDatabase(),
      isSafe: (value) => parseDatabase(value) !== undefined,
      reloadBeforeWrite: true,
      rejectCorruptWrite: true,
      rejectUnsafeWrite: true,
      rejectExternalChanges: true,
    },
  );
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function requireRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error("Invalid design-system attachment revision.");
  }
  return value as number;
}

function monotonicTimestamp(now: () => number, previous = -1): number {
  const value = Math.floor(now());
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Design-system snapshot clock returned an invalid timestamp.");
  }
  return Math.max(value, previous + 1);
}

export class DesignSystemSnapshotStore {
  private readonly persistence: DataStore<DesignSystemSnapshotDatabaseV1>;
  private readonly now: () => number;
  private readonly mintAttachmentId: () => string;

  constructor(options: DesignSystemSnapshotStoreOptions = {}) {
    this.persistence = options.dataStore ?? createDataStore(options);
    this.now = options.now ?? Date.now;
    this.mintAttachmentId = options.mintAttachmentId ?? (() => `design-system:${randomUUID()}`);
  }

  private async healthy(): Promise<DesignSystemSnapshotDatabaseV1> {
    const loaded = await this.persistence.load();
    if (await this.persistence.loadedFromCorruptFile()) {
      throw new DesignSystemSnapshotStoreUnavailableError(
        "The design-system snapshot store is corrupt and was preserved for recovery.",
      );
    }
    if (await this.persistence.loadedFromUnsafeFile()) {
      throw new DesignSystemSnapshotStoreUnavailableError(
        "The design-system snapshot store is unsafe and was preserved for recovery.",
      );
    }
    const parsed = parseDatabase(loaded);
    if (!parsed) throw new DesignSystemSnapshotStoreUnavailableError();
    return parsed;
  }

  async initialize(): Promise<void> {
    await this.healthy();
  }

  async getRecord(attachmentId: string): Promise<DesignSystemAttachmentRecordV1 | undefined> {
    const database = await this.healthy();
    return clone(database.attachments.find((record) => record.attachmentId === attachmentId));
  }

  async create(index: unknown): Promise<DesignSystemAttachmentRecordV1> {
    await this.healthy();
    return this.persistence.update((draft) => {
      const database = parseDatabase(draft);
      if (!database) throw new DesignSystemSnapshotStoreUnavailableError();
      if (database.attachments.length >= DESIGN_SYSTEM_MAX_ATTACHMENTS) {
        throw new DesignSystemSnapshotStoreUnavailableError(
          "The design-system attachment limit has been reached.",
        );
      }
      const attachmentId = this.mintAttachmentId();
      if (database.attachments.some((record) => record.attachmentId === attachmentId)) {
        throw new DesignSystemSnapshotStoreUnavailableError(
          "A generated design-system attachment identity was already in use.",
        );
      }
      const record = createDesignSystemAttachment(index, {
        attachmentId,
        now: monotonicTimestamp(this.now),
      });
      database.attachments.push(record);
      database.attachments.sort((left, right) =>
        left.attachmentId.localeCompare(right.attachmentId, "en"),
      );
      database.revision += 1;
      Object.assign(draft, database);
      return clone(record);
    });
  }

  async refresh(
    attachmentId: string,
    expectedRevision: number,
    index: unknown,
  ): Promise<DesignSystemAttachmentRecordV1> {
    const expected = requireRevision(expectedRevision);
    await this.healthy();
    return this.persistence.update((draft) => {
      const database = parseDatabase(draft);
      if (!database) throw new DesignSystemSnapshotStoreUnavailableError();
      const position = database.attachments.findIndex(
        (record) => record.attachmentId === attachmentId,
      );
      const current = database.attachments[position];
      if (!current) throw new DesignSystemSnapshotStoreNotFoundError();
      if (current.revision !== expected) {
        throw new DesignSystemSnapshotStoreConflictError(current.revision);
      }
      const next = refreshDesignSystemAttachment(
        current,
        index,
        monotonicTimestamp(this.now, current.updatedAt),
      );
      database.attachments[position] = next;
      database.revision += 1;
      Object.assign(draft, database);
      return clone(next);
    });
  }

  async detach(
    attachmentId: string,
    expectedRevision: number,
  ): Promise<DesignSystemAttachmentRecordV1> {
    const expected = requireRevision(expectedRevision);
    await this.healthy();
    return this.persistence.update((draft) => {
      const database = parseDatabase(draft);
      if (!database) throw new DesignSystemSnapshotStoreUnavailableError();
      const position = database.attachments.findIndex(
        (record) => record.attachmentId === attachmentId,
      );
      const current = database.attachments[position];
      if (!current) throw new DesignSystemSnapshotStoreNotFoundError();
      if (current.revision !== expected) {
        throw new DesignSystemSnapshotStoreConflictError(current.revision);
      }
      const next = detachDesignSystemAttachment(
        current,
        monotonicTimestamp(this.now, current.updatedAt),
      );
      database.attachments[position] = next;
      database.revision += 1;
      Object.assign(draft, database);
      return clone(next);
    });
  }

  async rendererProjection(
    attachmentId: string,
    currentAuthorizedSources: readonly DesignSystemAuthorizedSource[],
  ): Promise<DesignSystemRendererProjectionV1> {
    const record = await this.getRecord(attachmentId);
    if (!record) throw new DesignSystemSnapshotStoreNotFoundError();
    const availability = getCurrentDesignSystemSnapshot(record, currentAuthorizedSources);
    return {
      version: 1,
      attachmentId: record.attachmentId,
      revision: record.revision,
      state: record.state,
      updatedAt: record.updatedAt,
      freshness: availability.freshness,
      snapshot: availability.snapshot ? clone(availability.snapshot) : null,
    };
  }
}
