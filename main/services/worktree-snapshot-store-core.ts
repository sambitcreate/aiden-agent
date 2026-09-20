// Pure validation for the durable managed-worktree snapshot registry. The IO
// half lives in worktree-snapshot-store.ts; everything here is deterministic so
// the disk format can be tested without a filesystem.

export const WORKTREE_SNAPSHOT_REF_PREFIX = "refs/aiden/snapshots/";
export const WORKTREE_SNAPSHOT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_WORKTREE_SNAPSHOTS = 512;
export const MAX_PROVISIONED_FILES_PER_SNAPSHOT = 512;
export const MAX_PROVISIONED_FILE_BYTES = 64 * 1024 * 1024;
export const MAX_PROVISIONED_TOTAL_BYTES = 512 * 1024 * 1024;

const SNAPSHOT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const COMMIT_OID = /^[0-9a-f]{40,64}$/u;
const MAX_PATH_CHARS = 4_096;
const MAX_BRANCH_CHARS = 255;
const MAX_NAME_CHARS = 255;

export interface WorktreeSnapshotProvisionedFile {
  relativePath: string;
  mode: number;
  storedPath: string;
}

export interface WorktreeSnapshotRecord {
  id: string;
  /** Common Git dir of the owning repository (`<repo>/.git`). */
  repositoryCommonDir: string;
  /** Canonical repository top-level the worktree was created from. */
  repositoryPath: string;
  branch: string;
  baseCommit: string;
  snapshotCommit: string;
  snapshotRef: string;
  /** Absolute path the managed checkout occupied when it was removed. */
  originalWorktreePath: string;
  /** Display name of the workspace the worktree served, when known. */
  originalName?: string;
  owner: "manual" | "session";
  /** Workspace folder relative to the worktree root; "" when it is the root. */
  workspaceSubdir?: string;
  provisionedFiles: WorktreeSnapshotProvisionedFile[];
  createdAt: number;
  expiresAt?: number;
}

export interface WorktreeSnapshotDatabaseV1 {
  version: 1;
  revision: number;
  snapshots: WorktreeSnapshotRecord[];
}

export function emptyWorktreeSnapshotDatabase(): WorktreeSnapshotDatabaseV1 {
  return { version: 1, revision: 0, snapshots: [] };
}

export function isWorktreeSnapshotId(value: unknown): value is string {
  return typeof value === "string" && SNAPSHOT_ID.test(value);
}

export function worktreeSnapshotRef(snapshotId: string): string {
  return `${WORKTREE_SNAPSHOT_REF_PREFIX}${snapshotId}`;
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null
    ? (value as Record<string, unknown>)
    : undefined;
}

function hasKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  return (
    Object.keys(value).every((key) => required.includes(key) || optional.includes(key)) &&
    required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

function boundedAbsolutePath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_PATH_CHARS) {
    return false;
  }
  return path_isAbsolute(value);
}

function path_isAbsolute(value: string): boolean {
  // The store runs on macOS/Linux hosts; POSIX absolute is the on-disk contract.
  return value.startsWith("/") && !value.includes("\u0000");
}

/** A path that stays inside its container: relative, no dot-dot, no NUL. */
export function isContainedRelativePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_PATH_CHARS &&
    !path_isAbsolute(value) &&
    !value.includes("\u0000") &&
    !value.split("/").some((segment) => segment === ".." || segment === "")
  );
}

function boundedName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    [...value].length <= MAX_NAME_CHARS &&
    !/[\p{Cc}\p{Cf}]/u.test(value)
  );
}

function safeFileMode(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 0o7777;
}

function timestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function parseProvisionedFile(value: unknown): WorktreeSnapshotProvisionedFile | null {
  const input = record(value);
  if (
    !input ||
    !hasKeys(input, ["relativePath", "mode", "storedPath"]) ||
    !isContainedRelativePath(input.relativePath) ||
    !safeFileMode(input.mode) ||
    !boundedAbsolutePath(input.storedPath)
  ) {
    return null;
  }
  return structuredClone(input) as unknown as WorktreeSnapshotProvisionedFile;
}

export function parseWorktreeSnapshotRecord(value: unknown): WorktreeSnapshotRecord | null {
  const input = record(value);
  if (
    !input ||
    !hasKeys(
      input,
      [
        "id",
        "repositoryCommonDir",
        "repositoryPath",
        "branch",
        "baseCommit",
        "snapshotCommit",
        "snapshotRef",
        "originalWorktreePath",
        "owner",
        "provisionedFiles",
        "createdAt",
      ],
      ["originalName", "workspaceSubdir", "expiresAt"],
    ) ||
    !isWorktreeSnapshotId(input.id) ||
    !boundedAbsolutePath(input.repositoryCommonDir) ||
    !boundedAbsolutePath(input.repositoryPath) ||
    typeof input.branch !== "string" ||
    input.branch.length === 0 ||
    [...input.branch].length > MAX_BRANCH_CHARS ||
    /[\p{Cc}\p{Cf}]/u.test(input.branch) ||
    typeof input.baseCommit !== "string" ||
    !COMMIT_OID.test(input.baseCommit) ||
    typeof input.snapshotCommit !== "string" ||
    !COMMIT_OID.test(input.snapshotCommit) ||
    input.snapshotRef !== worktreeSnapshotRef(input.id) ||
    !boundedAbsolutePath(input.originalWorktreePath) ||
    (input.originalName !== undefined && !boundedName(input.originalName)) ||
    (input.owner !== "manual" && input.owner !== "session") ||
    (input.workspaceSubdir !== undefined &&
      input.workspaceSubdir !== "" &&
      !isContainedRelativePath(input.workspaceSubdir)) ||
    !Array.isArray(input.provisionedFiles) ||
    input.provisionedFiles.length > MAX_PROVISIONED_FILES_PER_SNAPSHOT ||
    !timestamp(input.createdAt) ||
    (input.expiresAt !== undefined &&
      (!timestamp(input.expiresAt) || input.expiresAt < input.createdAt))
  ) {
    return null;
  }
  const provisionedFiles = input.provisionedFiles.map(parseProvisionedFile);
  if (provisionedFiles.some((entry) => entry === null)) return null;
  const relativePaths = new Set(
    (provisionedFiles as WorktreeSnapshotProvisionedFile[]).map((entry) => entry.relativePath),
  );
  if (relativePaths.size !== provisionedFiles.length) return null;
  return {
    ...(structuredClone(input) as unknown as WorktreeSnapshotRecord),
    provisionedFiles: provisionedFiles as WorktreeSnapshotProvisionedFile[],
  };
}

export function parseWorktreeSnapshotDatabase(value: unknown): WorktreeSnapshotDatabaseV1 | null {
  const input = record(value);
  if (
    !input ||
    !hasKeys(input, ["version", "revision", "snapshots"]) ||
    input.version !== 1 ||
    !Number.isSafeInteger(input.revision) ||
    (input.revision as number) < 0 ||
    !Array.isArray(input.snapshots) ||
    input.snapshots.length > MAX_WORKTREE_SNAPSHOTS
  ) {
    return null;
  }
  const snapshots = input.snapshots.map(parseWorktreeSnapshotRecord);
  if (snapshots.some((snapshot) => snapshot === null)) return null;
  if (
    new Set((snapshots as WorktreeSnapshotRecord[]).map((snapshot) => snapshot.id)).size !==
    snapshots.length
  ) {
    return null;
  }
  return {
    version: 1,
    revision: input.revision as number,
    snapshots: snapshots as WorktreeSnapshotRecord[],
  };
}
