// Durable registry for managed-worktree snapshots plus the private file
// payloads that never enter Git object storage. The registry lives outside the
// workspace list on purpose: deleting a managed worktree may remove the
// workspace record itself, and the snapshot has to outlive it.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { constants as fsConstants } from "node:fs";
import { DataStore, ensureUserDataDir } from "./data-store.js";
import {
  isContainedRelativePath,
  isWorktreeSnapshotId,
  MAX_PROVISIONED_FILE_BYTES,
  MAX_PROVISIONED_FILES_PER_SNAPSHOT,
  MAX_PROVISIONED_TOTAL_BYTES,
  MAX_WORKTREE_SNAPSHOTS,
  emptyWorktreeSnapshotDatabase,
  parseWorktreeSnapshotDatabase,
  parseWorktreeSnapshotRecord,
  type WorktreeSnapshotDatabaseV1,
  type WorktreeSnapshotProvisionedFile,
  type WorktreeSnapshotRecord,
} from "./worktree-snapshot-store-core.js";

export class WorktreeSnapshotStoreError extends Error {
  constructor(
    readonly code: "corrupt" | "unsafe" | "invalid" | "capacity" | "io",
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "WorktreeSnapshotStoreError";
  }
}

export interface ProvisionedFileSource {
  relativePath: string;
  mode: number;
}

export interface WorktreeSnapshotStoreOptions {
  /** Registry/payload root. Defaults to `<userData>/worktree-snapshots`. */
  root?: () => string;
  filename?: string;
  now?: () => number;
  dataStore?: DataStore<WorktreeSnapshotDatabaseV1>;
  /** Test seams for the payload budgets. */
  maxProvisionedFiles?: number;
  maxProvisionedFileBytes?: number;
  maxProvisionedTotalBytes?: number;
}

export class WorktreeSnapshotStore {
  private readonly now: () => number;
  private data: DataStore<WorktreeSnapshotDatabaseV1> | undefined;
  private resolvedRoot: string | undefined;
  private initialized = false;

  constructor(private readonly options: WorktreeSnapshotStoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.data = options.dataStore;
  }

  private timestamp(): number {
    const value = this.now();
    if (!Number.isFinite(value) || value < 0) {
      throw new WorktreeSnapshotStoreError("io", "Invalid worktree snapshot clock.");
    }
    return value;
  }

  private async root(): Promise<string> {
    if (!this.resolvedRoot) {
      this.resolvedRoot = this.options.root
        ? this.options.root()
        : await ensureUserDataDir("worktree-snapshots");
    }
    return this.resolvedRoot;
  }

  private async store(): Promise<DataStore<WorktreeSnapshotDatabaseV1>> {
    if (!this.data) {
      const root = await this.root();
      this.data = new DataStore<WorktreeSnapshotDatabaseV1>(
        this.options.filename ?? "snapshots.json",
        emptyWorktreeSnapshotDatabase(),
        () => root,
        {
          maxBytes: 4 * 1024 * 1024,
          fileMode: 0o600,
          normalize: (value) =>
            parseWorktreeSnapshotDatabase(value) ?? emptyWorktreeSnapshotDatabase(),
          isSafe: (value) => parseWorktreeSnapshotDatabase(value) !== null,
          rejectCorruptWrite: true,
          rejectUnsafeWrite: true,
        },
      );
    }
    return this.data;
  }

  private requireInitialized(): void {
    if (!this.initialized) {
      throw new WorktreeSnapshotStoreError("io", "Worktree snapshot storage is not initialized.");
    }
  }

  /** Load once; fail closed on an unreadable or unsupported registry file. */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    const data = await this.store();
    await data.load();
    if (await data.loadedFromCorruptFile()) {
      throw new WorktreeSnapshotStoreError(
        "corrupt",
        "The worktree snapshot registry is unreadable and was preserved.",
      );
    }
    if (await data.loadedFromUnsafeFile()) {
      throw new WorktreeSnapshotStoreError(
        "unsafe",
        "The worktree snapshot registry has an unsupported shape and was preserved.",
      );
    }
    this.initialized = true;
  }

  async list(): Promise<WorktreeSnapshotRecord[]> {
    this.requireInitialized();
    return structuredClone((await (await this.store()).load()).snapshots);
  }

  async get(snapshotId: string): Promise<WorktreeSnapshotRecord | undefined> {
    this.requireInitialized();
    if (!isWorktreeSnapshotId(snapshotId)) return undefined;
    const snapshot = (await (await this.store()).load()).snapshots.find(
      (entry) => entry.id === snapshotId,
    );
    return snapshot ? structuredClone(snapshot) : undefined;
  }

  async listForRepository(repositoryCommonDir: string): Promise<WorktreeSnapshotRecord[]> {
    this.requireInitialized();
    const snapshots = (await (await this.store()).load()).snapshots.filter(
      (snapshot) => snapshot.repositoryCommonDir === repositoryCommonDir,
    );
    return structuredClone(snapshots);
  }

  /**
   * Persist a snapshot record. The caller publishes the Git ref first; this
   * write must succeed before the removal journal may reference it.
   */
  async record(
    input: Omit<WorktreeSnapshotRecord, "provisionedFiles"> & {
      provisionedFiles: WorktreeSnapshotProvisionedFile[];
    },
  ): Promise<WorktreeSnapshotRecord> {
    this.requireInitialized();
    const candidate = parseWorktreeSnapshotRecord(structuredClone(input));
    if (!candidate) {
      throw new WorktreeSnapshotStoreError(
        "invalid",
        "The worktree snapshot record could not be validated.",
      );
    }
    return (await this.store()).update((database) => {
      if (database.snapshots.some((snapshot) => snapshot.id === candidate.id)) {
        throw new WorktreeSnapshotStoreError(
          "invalid",
          "The worktree snapshot identity was reused.",
        );
      }
      while (database.snapshots.length >= MAX_WORKTREE_SNAPSHOTS) {
        const now = this.timestamp();
        const expired = database.snapshots.findIndex(
          (snapshot) => snapshot.expiresAt !== undefined && snapshot.expiresAt <= now,
        );
        if (expired < 0) {
          throw new WorktreeSnapshotStoreError(
            "capacity",
            "Aiden is already tracking the maximum number of worktree snapshots.",
          );
        }
        database.snapshots.splice(expired, 1);
      }
      database.snapshots.push(candidate);
      database.revision += 1;
      return structuredClone(candidate);
    });
  }

  /** Drop the registry row and any provisioned payloads for a snapshot. */
  async remove(snapshotId: string): Promise<void> {
    this.requireInitialized();
    if (!isWorktreeSnapshotId(snapshotId)) {
      throw new WorktreeSnapshotStoreError("invalid", "The snapshot identifier is invalid.");
    }
    await (
      await this.store()
    ).update((database) => {
      const index = database.snapshots.findIndex((snapshot) => snapshot.id === snapshotId);
      if (index < 0) return false;
      database.snapshots.splice(index, 1);
      database.revision += 1;
      return true;
    });
    await this.dropPayload(snapshotId);
  }

  /** Snapshots whose expiry has passed — consumed by retention GC (P1). */
  async listExpired(now: number = this.timestamp()): Promise<WorktreeSnapshotRecord[]> {
    this.requireInitialized();
    const snapshots = (await (await this.store()).load()).snapshots.filter(
      (snapshot) => snapshot.expiresAt !== undefined && snapshot.expiresAt <= now,
    );
    return structuredClone(snapshots);
  }

  private payloadRoot(snapshotId: string): string {
    if (!isWorktreeSnapshotId(snapshotId)) {
      throw new WorktreeSnapshotStoreError("invalid", "The snapshot identifier is invalid.");
    }
    if (!this.resolvedRoot) {
      throw new WorktreeSnapshotStoreError("io", "Worktree snapshot storage is not initialized.");
    }
    return path.join(this.resolvedRoot, "payloads", snapshotId);
  }

  /**
   * Copy the files Aiden provisioned into the private payload area. Only paths
   * recorded in the creation manifest are candidates: regular files only,
   * symlinks skipped, destinations never overwritten, modes preserved, and the
   * whole transfer bounded by count and byte budgets.
   */
  async storeProvisionedFiles(
    snapshotId: string,
    worktreePath: string,
    manifest: ProvisionedFileSource[],
  ): Promise<WorktreeSnapshotProvisionedFile[]> {
    const maxFiles = this.options.maxProvisionedFiles ?? MAX_PROVISIONED_FILES_PER_SNAPSHOT;
    const maxFileBytes = this.options.maxProvisionedFileBytes ?? MAX_PROVISIONED_FILE_BYTES;
    const maxTotalBytes = this.options.maxProvisionedTotalBytes ?? MAX_PROVISIONED_TOTAL_BYTES;
    if (manifest.length > maxFiles) {
      throw new WorktreeSnapshotStoreError(
        "invalid",
        "The provisioned-file manifest is too large to snapshot.",
      );
    }
    await this.root();
    const payloads = this.payloadRoot(snapshotId);
    const filesRoot = path.join(payloads, "files");
    const stored: WorktreeSnapshotProvisionedFile[] = [];
    let totalBytes = 0;
    await fs.mkdir(filesRoot, { recursive: true, mode: 0o700 });
    try {
      // Containment is compared on canonical paths: a root reached through a
      // symlink (macOS `/var` -> `/private/var`) must not make every realpath
      // look like it escaped and silently drop the whole payload.
      const worktreeRoot = await fs.realpath(worktreePath);
      const canonicalFilesRoot = await fs.realpath(filesRoot);
      for (const entry of manifest) {
        if (!isContainedRelativePath(entry.relativePath)) {
          throw new WorktreeSnapshotStoreError(
            "invalid",
            "A provisioned file path escapes the worktree.",
          );
        }
        const source = path.join(worktreeRoot, entry.relativePath);
        let info;
        try {
          info = await fs.lstat(source);
        } catch (error) {
          // A provisioned file the user deleted before snapshotting is simply
          // absent from the payload — it must not abort the whole snapshot.
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
        if (info.isSymbolicLink() || !info.isFile()) continue;
        const canonicalSource = await fs.realpath(source);
        if (!canonicalSource.startsWith(`${worktreeRoot}${path.sep}`)) {
          // A symlinked directory in the middle of the path resolved outside
          // the checkout — never follow it.
          continue;
        }
        if (info.size > maxFileBytes) {
          throw new WorktreeSnapshotStoreError(
            "invalid",
            `The provisioned file ${entry.relativePath} is too large to snapshot.`,
          );
        }
        totalBytes += info.size;
        if (totalBytes > maxTotalBytes) {
          throw new WorktreeSnapshotStoreError(
            "invalid",
            "The provisioned files are too large to snapshot together.",
          );
        }
        const destination = path.join(filesRoot, entry.relativePath);
        if (path.resolve(destination) !== destination) {
          throw new WorktreeSnapshotStoreError(
            "invalid",
            "A provisioned file destination could not be verified.",
          );
        }
        const parent = path.dirname(destination);
        await fs.mkdir(parent, { recursive: true, mode: 0o700 });
        const canonicalParent = await fs.realpath(parent);
        if (
          canonicalParent !== canonicalFilesRoot &&
          !canonicalParent.startsWith(`${canonicalFilesRoot}${path.sep}`)
        ) {
          throw new WorktreeSnapshotStoreError(
            "invalid",
            "A provisioned file destination escaped its snapshot store.",
          );
        }
        await fs.copyFile(source, destination, fsConstants.COPYFILE_EXCL);
        const mode = info.mode & 0o777;
        await fs.chmod(destination, mode);
        stored.push({ relativePath: entry.relativePath, mode, storedPath: destination });
      }
    } catch (error) {
      await fs.rm(payloads, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
    await this.syncDirectory(filesRoot);
    return stored;
  }

  /**
   * Restore provisioned payloads into a recreated checkout. The recorded
   * manifest — not the original `.worktreeinclude` — is authoritative. Existing
   * destination files are never overwritten.
   */
  async restoreProvisionedFiles(
    snapshot: WorktreeSnapshotRecord,
    worktreePath: string,
  ): Promise<void> {
    if (snapshot.provisionedFiles.length === 0) return;
    await this.root();
    const filesRoot = path.join(this.payloadRoot(snapshot.id), "files");
    const canonicalFilesRoot = await fs.realpath(filesRoot);
    const worktreeRoot = await fs.realpath(worktreePath);
    for (const entry of snapshot.provisionedFiles) {
      if (!isContainedRelativePath(entry.relativePath)) {
        throw new WorktreeSnapshotStoreError(
          "invalid",
          "A provisioned file path escapes the worktree.",
        );
      }
      const stored = path.join(filesRoot, entry.relativePath);
      const canonicalStoredParent = await fs.realpath(path.dirname(stored)).catch(() => "");
      if (
        canonicalStoredParent !== canonicalFilesRoot &&
        !canonicalStoredParent.startsWith(`${canonicalFilesRoot}${path.sep}`)
      ) {
        throw new WorktreeSnapshotStoreError(
          "invalid",
          "A stored provisioned file could not be verified.",
        );
      }
      const info = await fs.lstat(stored);
      if (info.isSymbolicLink() || !info.isFile()) continue;
      const destination = path.join(worktreeRoot, entry.relativePath);
      const parent = path.dirname(destination);
      await fs.mkdir(parent, { recursive: true });
      const canonicalParent = await fs.realpath(parent);
      if (
        canonicalParent !== worktreeRoot &&
        !canonicalParent.startsWith(`${worktreeRoot}${path.sep}`)
      ) {
        throw new WorktreeSnapshotStoreError(
          "invalid",
          "A provisioned file destination escaped the worktree.",
        );
      }
      await fs.copyFile(stored, destination, fsConstants.COPYFILE_EXCL);
      await fs.chmod(destination, entry.mode & 0o777);
    }
  }

  async dropPayload(snapshotId: string): Promise<void> {
    if (!isWorktreeSnapshotId(snapshotId)) return;
    const payloads = path.join(await this.root(), "payloads");
    const target = path.join(payloads, snapshotId);
    if (path.resolve(target) !== target) return;
    await fs.rm(target, { recursive: true, force: true }).catch(() => undefined);
  }

  private async syncDirectory(directory: string): Promise<void> {
    try {
      const handle = await fs.open(directory, "r");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch {
      // Directory fsync is best-effort on filesystems that support it.
    }
  }
}

export const worktreeSnapshotStore = new WorktreeSnapshotStore();
