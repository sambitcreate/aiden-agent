import { randomUUID } from "node:crypto";
import { DataStore } from "./data-store.js";
import {
  DESIGN_COMMENT_VERSION,
  MAX_DESIGN_COMMENTS,
  MAX_DESIGN_COMMENTS_PER_PROJECT,
  MAX_DESIGN_COMMENT_STORE_BYTES,
  designCommentElementMatches,
  designCommentTargetMatches,
  emptyDesignCommentDatabase,
  isDesignCommentId,
  parseDesignCommentBody,
  parseDesignCommentDatabase,
  parseDesignCommentTarget,
  type DesignCommentDatabaseV1,
  type DesignCommentTargetV1,
  type DesignCommentV1,
} from "./design-comment-contract.js";

const STORE_FILE = "design-comments.json";

export class DesignCommentUnavailableError extends Error {
  constructor(message = "Design comment storage is unavailable.") {
    super(message);
    this.name = "DesignCommentUnavailableError";
  }
}

export class DesignCommentNotFoundError extends Error {
  constructor() {
    super("Design comment was not found.");
    this.name = "DesignCommentNotFoundError";
  }
}

export class DesignCommentRevisionConflictError extends Error {
  constructor(
    readonly currentDatabaseRevision: number,
    readonly currentCommentRevision?: number,
  ) {
    super("Design comments changed since they were opened.");
    this.name = "DesignCommentRevisionConflictError";
  }
}

export interface DesignCommentProjectViewV1 {
  databaseRevision: number;
  comments: DesignCommentV1[];
}

export interface DesignCommentStoreOptions {
  root?: () => string;
  filename?: string;
  now?: () => number;
  mintCommentId?: () => string;
  dataStore?: DataStore<DesignCommentDatabaseV1>;
}

function createDataStore(options: DesignCommentStoreOptions): DataStore<DesignCommentDatabaseV1> {
  return new DataStore(options.filename ?? STORE_FILE, emptyDesignCommentDatabase(), options.root, {
    maxBytes: MAX_DESIGN_COMMENT_STORE_BYTES,
    fileMode: 0o600,
    normalize: (value) => parseDesignCommentDatabase(value) ?? emptyDesignCommentDatabase(),
    isSafe: (value) => parseDesignCommentDatabase(value) !== undefined,
    rejectCorruptWrite: true,
    rejectUnsafeWrite: true,
    rejectExternalChanges: true,
    reloadBeforeWrite: true,
  });
}

function timestamp(now: () => number, previous = -1): number {
  const value = Math.floor(now());
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error("Design comment clock is invalid.");
  return Math.max(value, previous + 1);
}

function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error("Invalid Design comment database revision.");
  }
  return value as number;
}

function commentRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error("Invalid Design comment revision.");
  }
  return value as number;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function requireDatabaseRevision(database: DesignCommentDatabaseV1, expected: number): void {
  if (database.revision !== expected) {
    throw new DesignCommentRevisionConflictError(database.revision);
  }
}

function requireCurrent(
  database: DesignCommentDatabaseV1,
  id: string,
  expectedRevision: number,
): { index: number; comment: DesignCommentV1 } {
  const index = database.comments.findIndex((comment) => comment.id === id);
  const comment = database.comments[index];
  if (!comment) throw new DesignCommentNotFoundError();
  if (comment.revision !== expectedRevision) {
    throw new DesignCommentRevisionConflictError(database.revision, comment.revision);
  }
  return { index, comment };
}

export class DesignCommentStore {
  private readonly data: DataStore<DesignCommentDatabaseV1>;
  private readonly now: () => number;
  private readonly mintCommentId: () => string;
  private initialized = false;
  private unavailableReason: string | null = null;

  constructor(options: DesignCommentStoreOptions = {}) {
    this.data = options.dataStore ?? createDataStore(options);
    this.now = options.now ?? Date.now;
    this.mintCommentId = options.mintCommentId ?? (() => `comment:${randomUUID()}`);
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.data.load();
    if (await this.data.loadedFromCorruptFile()) {
      this.unavailableReason = "Design comment storage is unreadable.";
    } else if (await this.data.loadedFromUnsafeFile()) {
      this.unavailableReason = "Design comment storage has an unsupported shape.";
    }
    this.initialized = true;
  }

  private requireAvailable(): void {
    if (!this.initialized) {
      throw new DesignCommentUnavailableError("Design comment storage is not initialized.");
    }
    if (this.unavailableReason) throw new DesignCommentUnavailableError(this.unavailableReason);
  }

  availability(): { available: true } | { available: false; reason: string } {
    if (!this.initialized) {
      throw new DesignCommentUnavailableError("Design comment storage is not initialized.");
    }
    return this.unavailableReason
      ? { available: false, reason: this.unavailableReason }
      : { available: true };
  }

  async listProject(projectIdValue: string): Promise<DesignCommentProjectViewV1> {
    this.requireAvailable();
    if (!isDesignCommentId(projectIdValue)) throw new Error("Invalid Design Project identity.");
    const database = await this.data.load();
    return {
      databaseRevision: database.revision,
      comments: database.comments
        .filter(({ target }) => target.projectId === projectIdValue)
        .map(clone)
        .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id)),
    };
  }

  /**
   * Remove the comments captured by a committed Design Project deletion.
   * Restart recovery may call this after a prefix of the same deletion already
   * succeeded, but a newly appeared comment fails closed instead of being
   * silently swept into an older cascade plan.
   */
  async deleteProject(projectIdValue: string, expectedIds: readonly string[]): Promise<number> {
    this.requireAvailable();
    if (!isDesignCommentId(projectIdValue) || expectedIds.some((id) => !isDesignCommentId(id))) {
      throw new Error("Invalid Design comment cascade identity.");
    }
    const expected = new Set(expectedIds);
    if (expected.size !== expectedIds.length) {
      throw new Error("Invalid Design comment cascade identity.");
    }
    return this.data.update((database) => {
      const current = database.comments.filter(({ target }) => target.projectId === projectIdValue);
      if (current.some(({ id }) => !expected.has(id))) {
        throw new Error("Design comments changed after deletion was confirmed.");
      }
      if (current.length === 0) return 0;
      const currentIds = new Set(current.map(({ id }) => id));
      database.comments = database.comments.filter(({ id }) => !currentIds.has(id));
      database.revision += 1;
      return current.length;
    });
  }

  async create(input: {
    expectedDatabaseRevision: number;
    target: DesignCommentTargetV1;
    body: string;
  }): Promise<DesignCommentV1> {
    this.requireAvailable();
    const expectedDatabaseRevision = revision(input.expectedDatabaseRevision);
    const target = parseDesignCommentTarget(input.target);
    const body = parseDesignCommentBody(input.body);
    if (!target || !body) throw new Error("Invalid Design comment.");
    return this.data.update((database) => {
      requireDatabaseRevision(database, expectedDatabaseRevision);
      if (database.comments.length >= MAX_DESIGN_COMMENTS) {
        throw new Error("Design comment storage is at capacity.");
      }
      if (
        database.comments.filter(({ target: existing }) => existing.projectId === target.projectId)
          .length >= MAX_DESIGN_COMMENTS_PER_PROJECT
      ) {
        throw new Error("This Design Project has reached its comment limit.");
      }
      const id = this.mintCommentId();
      if (!isDesignCommentId(id)) throw new Error("Invalid Design comment identity.");
      if (database.comments.some(({ id: existing }) => existing === id)) {
        throw new Error("Design comment identity was reused.");
      }
      const createdAt = timestamp(this.now);
      const comment: DesignCommentV1 = {
        version: DESIGN_COMMENT_VERSION,
        id,
        revision: 1,
        target,
        body,
        status: "open",
        stale: false,
        createdAt,
        updatedAt: createdAt,
      };
      database.comments.push(comment);
      database.revision += 1;
      return clone(comment);
    });
  }

  private async changeStatus(input: {
    id: string;
    expectedRevision: number;
    expectedDatabaseRevision: number;
    status: "open" | "resolved";
  }): Promise<DesignCommentV1> {
    this.requireAvailable();
    if (!isDesignCommentId(input.id)) throw new Error("Invalid Design comment identity.");
    const expectedRevision = commentRevision(input.expectedRevision);
    const expectedDatabaseRevision = revision(input.expectedDatabaseRevision);
    return this.data.update((database) => {
      requireDatabaseRevision(database, expectedDatabaseRevision);
      const { index, comment } = requireCurrent(database, input.id, expectedRevision);
      if (comment.status === input.status) return clone(comment);
      const updatedAt = timestamp(this.now, comment.updatedAt);
      const updated: DesignCommentV1 = {
        ...comment,
        revision: comment.revision + 1,
        status: input.status,
        updatedAt,
        ...(input.status === "resolved" ? { resolvedAt: updatedAt } : { resolvedAt: undefined }),
      };
      delete updated.resolvedAt;
      if (input.status === "resolved") updated.resolvedAt = updatedAt;
      database.comments[index] = updated;
      database.revision += 1;
      return clone(updated);
    });
  }

  resolve(input: {
    id: string;
    expectedRevision: number;
    expectedDatabaseRevision: number;
  }): Promise<DesignCommentV1> {
    return this.changeStatus({ ...input, status: "resolved" });
  }

  reopen(input: {
    id: string;
    expectedRevision: number;
    expectedDatabaseRevision: number;
  }): Promise<DesignCommentV1> {
    return this.changeStatus({ ...input, status: "open" });
  }

  /**
   * Mark every comment on one artboard lineage stale unless its immutable
   * revision and full selector/source identity exactly match the current one.
   */
  async reconcileTarget(input: {
    expectedDatabaseRevision: number;
    current: DesignCommentTargetV1;
  }): Promise<DesignCommentProjectViewV1> {
    this.requireAvailable();
    const expectedDatabaseRevision = revision(input.expectedDatabaseRevision);
    const current = parseDesignCommentTarget(input.current);
    if (!current) throw new Error("Invalid current Design comment target.");
    return this.data.update((database) => {
      requireDatabaseRevision(database, expectedDatabaseRevision);
      let changed = false;
      for (let index = 0; index < database.comments.length; index += 1) {
        const comment = database.comments[index];
        if (
          !comment ||
          comment.target.projectId !== current.projectId ||
          comment.target.lineageId !== current.lineageId ||
          comment.stale
        ) {
          continue;
        }
        const revisionChanged = comment.target.mediaId !== current.mediaId;
        const selectedElementBindingChanged =
          comment.target.mediaId === current.mediaId &&
          designCommentElementMatches(comment.target, current) &&
          !designCommentTargetMatches(comment.target, current);
        if (!revisionChanged && !selectedElementBindingChanged) continue;
        const updatedAt = timestamp(this.now, comment.updatedAt);
        database.comments[index] = {
          ...comment,
          revision: comment.revision + 1,
          stale: true,
          staleAt: updatedAt,
          updatedAt,
        };
        changed = true;
      }
      if (changed) database.revision += 1;
      return {
        databaseRevision: database.revision,
        comments: database.comments
          .filter(({ target }) => target.projectId === current.projectId)
          .map(clone),
      };
    });
  }
}
