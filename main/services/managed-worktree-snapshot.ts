// Managed-worktree snapshot records: a durable on-disk manifest plus the
// byte-exact blobs of ignored files Aiden provisioned into the worktree. The
// Git side (refs/aiden/snapshots/<id>) lives in git.ts; this module owns the
// private storage under userData/worktree-snapshots/<snapshot-id>/.

import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ManagedWorktreeFileIoError, transferManagedWorktreeFile, type ManagedWorktreeRootIdentity } from "./managed-worktree-file-io.js";

const SNAPSHOT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const GIT_OBJECT_ID = /^[0-9a-f]{40}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const MANIFEST_BYTES = 64 * 1024;
const RESTORE_BYTES = 16 * 1024;
const MAX_PROVISIONED_FILES = 4_096;
const MAX_PROVISIONED_BLOB_BYTES = 256 * 1024 * 1024;

export type ManagedWorktreeSnapshotErrorCode =
  | "snapshot_invalid"
  | "snapshot_incomplete"
  | "blob_missing"
  | "blob_corrupt"
  | "destination_exists";

export class ManagedWorktreeSnapshotError extends Error {
  readonly code: ManagedWorktreeSnapshotErrorCode;
  declare readonly cause: unknown;
  constructor(code: ManagedWorktreeSnapshotErrorCode, message: string, cause?: unknown) {
    super(message);
    this.code = code;
    this.cause = cause;
    this.name = "ManagedWorktreeSnapshotError";
  }
}

export interface ProvisionedFileSnapshot {
  relativePath: string;
  /** POSIX permission bits captured at snapshot time. */
  mode: number;
  size: number;
  /** sha256 hex of the captured bytes. */
  digest: string;
  /** Path of the stored blob relative to the snapshot directory. */
  blobPath: string;
}

export interface ManagedWorktreeSnapshot {
  id: string;
  workspaceId: string;
  repositoryPath: string;
  worktreePath: string;
  /** Worktree-relative path of the workspace directory; "" for the root. */
  workspaceSubpath: string;
  branch: string;
  /** The worktree HEAD captured as the snapshot commit's parent. */
  originalHead: string;
  /** refs/aiden/snapshots/<id> — present once the ref is durable. */
  snapshotRef: string;
  /** The synthetic snapshot commit oid. */
  snapshotCommit: string;
  /** The captured worktree tree oid — the deletion drift boundary. */
  snapshotTree: string;
  createdAt: number;
  provisionedFiles: ProvisionedFileSnapshot[];
  state: "creating" | "ready" | "restoring" | "expired";
}

function normalizedRelativePath(candidate: string): string | undefined {
  if (
    typeof candidate !== "string" ||
    candidate.length === 0 ||
    candidate.length > 512 ||
    candidate.includes("\\") ||
    candidate.includes("\u0000") ||
    candidate.startsWith("/") ||
    path.isAbsolute(candidate)
  ) {
    return undefined;
  }
  const normalized = path.posix.normalize(candidate);
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized !== candidate
  ) {
    return undefined;
  }
  return normalized;
}

function isBoundedString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function snapshotDir(root: string, snapshotId: string): string {
  if (!SNAPSHOT_ID.test(snapshotId)) {
    throw new ManagedWorktreeSnapshotError(
      "snapshot_invalid",
      "The managed worktree snapshot id is invalid.",
    );
  }
  return path.join(root, snapshotId);
}

function manifestPath(dir: string): string {
  return path.join(dir, "manifest.json");
}

function restoreJournalPath(dir: string): string {
  return path.join(dir, "restore.json");
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch {
    return false;
  }
}

async function syncDirectory(dir: string): Promise<void> {
  const handle = await fs.open(dir, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Durable small-file write: tmp + fsync + rename + directory fsync. */
async function persistJsonFile(target: string, value: unknown): Promise<void> {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  const temp = `${target}.${randomUUID()}.tmp`;
  await fs.writeFile(temp, bytes, { mode: 0o600 });
  try {
    const handle = await fs.open(temp, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temp, target);
    await syncDirectory(path.dirname(target));
  } catch (error) {
    await fs.unlink(temp).catch(() => undefined);
    throw error;
  }
}

async function readJsonFile(target: string, maxBytes: number): Promise<unknown | undefined> {
  let stat;
  try {
    stat = await fs.lstat(target);
  } catch {
    return undefined;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) {
    throw new ManagedWorktreeSnapshotError(
      "snapshot_invalid",
      "A managed worktree snapshot file could not be verified.",
    );
  }
  try {
    return JSON.parse(await fs.readFile(target, "utf8"));
  } catch (error) {
    throw new ManagedWorktreeSnapshotError(
      "snapshot_invalid",
      "A managed worktree snapshot file could not be parsed.",
      error,
    );
  }
}

function validatedProvisionedFile(value: unknown): ProvisionedFileSnapshot {
  const entry = value as Partial<ProvisionedFileSnapshot>;
  if (
    typeof entry !== "object" ||
    entry === null ||
    typeof entry.relativePath !== "string" ||
    normalizedRelativePath(entry.relativePath) !== entry.relativePath ||
    !Number.isSafeInteger(entry.mode) ||
    entry.mode! < 0 ||
    entry.mode! > 0o777 ||
    !Number.isSafeInteger(entry.size) ||
    entry.size! < 0 ||
    typeof entry.digest !== "string" ||
    !DIGEST.test(entry.digest) ||
    typeof entry.blobPath !== "string" ||
    normalizedRelativePath(entry.blobPath) !== entry.blobPath ||
    !entry.blobPath.startsWith("files/")
  ) {
    throw new ManagedWorktreeSnapshotError(
      "snapshot_invalid",
      "A provisioned-file snapshot entry could not be verified.",
    );
  }
  return {
    relativePath: entry.relativePath,
    mode: entry.mode!,
    size: entry.size!,
    digest: entry.digest,
    blobPath: entry.blobPath,
  };
}

function validatedManifest(value: unknown, snapshotId: string): ManagedWorktreeSnapshot {
  const manifest = value as Partial<ManagedWorktreeSnapshot>;
  if (
    typeof manifest !== "object" ||
    manifest === null ||
    manifest.id !== snapshotId ||
    !isBoundedString(manifest.workspaceId, 128) ||
    !isBoundedString(manifest.repositoryPath, 4096) ||
    !path.isAbsolute(manifest.repositoryPath) ||
    !isBoundedString(manifest.worktreePath, 4096) ||
    !path.isAbsolute(manifest.worktreePath) ||
    typeof manifest.workspaceSubpath !== "string" ||
    (manifest.workspaceSubpath !== "" &&
      normalizedRelativePath(manifest.workspaceSubpath) !== manifest.workspaceSubpath) ||
    !isBoundedString(manifest.branch, 512) ||
    typeof manifest.originalHead !== "string" ||
    !GIT_OBJECT_ID.test(manifest.originalHead) ||
    typeof manifest.snapshotRef !== "string" ||
    manifest.snapshotRef !== `refs/aiden/snapshots/${snapshotId}` ||
    typeof manifest.snapshotCommit !== "string" ||
    !GIT_OBJECT_ID.test(manifest.snapshotCommit) ||
    typeof manifest.snapshotTree !== "string" ||
    !GIT_OBJECT_ID.test(manifest.snapshotTree) ||
    !Number.isSafeInteger(manifest.createdAt) ||
    !Array.isArray(manifest.provisionedFiles) ||
    manifest.provisionedFiles.length > MAX_PROVISIONED_FILES ||
    (manifest.state !== "creating" &&
      manifest.state !== "ready" &&
      manifest.state !== "restoring" &&
      manifest.state !== "expired")
  ) {
    throw new ManagedWorktreeSnapshotError(
      "snapshot_invalid",
      "The managed worktree snapshot manifest could not be verified.",
    );
  }
  return {
    id: manifest.id,
    workspaceId: manifest.workspaceId,
    repositoryPath: manifest.repositoryPath,
    worktreePath: manifest.worktreePath,
    workspaceSubpath: manifest.workspaceSubpath,
    branch: manifest.branch,
    originalHead: manifest.originalHead,
    snapshotRef: manifest.snapshotRef,
    snapshotCommit: manifest.snapshotCommit,
    snapshotTree: manifest.snapshotTree,
    createdAt: manifest.createdAt!,
    provisionedFiles: manifest.provisionedFiles.map(validatedProvisionedFile),
    state: manifest.state,
  };
}

/** Read a snapshot manifest; undefined when the record does not exist. */
export async function readManagedWorktreeSnapshot(
  root: string,
  snapshotId: string,
): Promise<ManagedWorktreeSnapshot | undefined> {
  const dir = snapshotDir(root, snapshotId);
  const value = await readJsonFile(manifestPath(dir), MANIFEST_BYTES);
  if (value === undefined) return undefined;
  return validatedManifest(value, snapshotId);
}

/** Require a snapshot manifest in the ready (or restoring) state. */
export async function requireReadyManagedWorktreeSnapshot(
  root: string,
  snapshotId: string,
): Promise<ManagedWorktreeSnapshot> {
  const manifest = await readManagedWorktreeSnapshot(root, snapshotId);
  if (!manifest) {
    throw new ManagedWorktreeSnapshotError(
      "snapshot_incomplete",
      "The managed worktree snapshot does not exist.",
    );
  }
  if (manifest.state !== "ready" && manifest.state !== "restoring") {
    throw new ManagedWorktreeSnapshotError(
      "snapshot_incomplete",
      "The managed worktree snapshot is incomplete.",
    );
  }
  return manifest;
}

/**
 * Create the snapshot record directory and write the durable manifest. The
 * manifest is written last (tmp + rename) so a present manifest always implies
 * every listed provisioned blob is complete.
 */
export async function persistManagedWorktreeSnapshot(
  root: string,
  snapshot: Omit<ManagedWorktreeSnapshot, "state"> & { state?: ManagedWorktreeSnapshot["state"] },
): Promise<void> {
  const dir = snapshotDir(root, snapshot.id);
  const record = { ...snapshot, state: snapshot.state ?? "ready" };
  validatedManifest(record, snapshot.id);
  await fs.mkdir(path.join(dir, "files"), { recursive: true, mode: 0o700 });
  await persistJsonFile(manifestPath(dir), record);
}

export async function updateManagedWorktreeSnapshotState(
  root: string,
  snapshot: ManagedWorktreeSnapshot,
  state: ManagedWorktreeSnapshot["state"],
): Promise<ManagedWorktreeSnapshot> {
  const next = { ...snapshot, state };
  await persistJsonFile(manifestPath(snapshotDir(root, snapshot.id)), next);
  return next;
}

/**
 * Copy one ignored worktree file into private snapshot storage. Returns the
 * manifest entry; the blob is written 0o600, hashed while streaming, and only
 * then recorded by the caller's manifest write.
 */
export async function captureProvisionedFile(
  snapshotDirPath: string,
  worktreePath: string,
  relativePath: string,
  worktreeIdentity?: ManagedWorktreeRootIdentity,
): Promise<ProvisionedFileSnapshot> {
  const normalized = normalizedRelativePath(relativePath);
  if (normalized === undefined) {
    throw new ManagedWorktreeSnapshotError(
      "snapshot_invalid",
      "A provisioned file path could not be verified.",
    );
  }
  const tempRelative = path.posix.join("files", `${randomUUID()}.tmp`);
  const temp = path.join(snapshotDirPath, tempRelative);
  let copied;
  try {
    copied = await transferManagedWorktreeFile({
      operation: "copy",
      sourceRoot: worktreePath,
      sourceIdentity: worktreeIdentity,
      sourceRelativePath: normalized,
      destinationRoot: snapshotDirPath,
      destinationRelativePath: tempRelative,
      byteLimit: MAX_PROVISIONED_BLOB_BYTES,
      mode: 0o600,
    });
  } catch (error) {
    throw new ManagedWorktreeSnapshotError(
      "snapshot_invalid",
      "A provisioned file could not be captured safely.",
      error,
    );
  }
  const blobPath = path.posix.join("files", copied.digest);
  const blobTarget = path.join(snapshotDirPath, blobPath);
  try {
    if (await pathExists(blobTarget)) {
      const existing = createHash("sha256").update(await fs.readFile(blobTarget)).digest("hex");
      if (existing !== copied.digest) {
        throw new ManagedWorktreeSnapshotError(
          "blob_corrupt",
          "A provisioned-file snapshot blob failed verification.",
        );
      }
    } else {
      await fs.rename(temp, blobTarget);
      await syncDirectory(path.dirname(blobTarget));
    }
  } finally {
    await fs.unlink(temp).catch(() => undefined);
  }
  return {
    relativePath: normalized,
    mode: copied.sourceMode,
    size: copied.size,
    digest: copied.digest,
    blobPath,
  };
}

/** Verify every provisioned blob still hashes to its recorded digest. */
export async function verifyProvisionedFileBlobs(
  snapshotDirPath: string,
  provisionedFiles: readonly ProvisionedFileSnapshot[],
): Promise<void> {
  for (const file of provisionedFiles) {
    const target = path.join(snapshotDirPath, file.blobPath);
    let bytes: Buffer;
    try {
      bytes = await fs.readFile(target);
    } catch (error) {
      throw new ManagedWorktreeSnapshotError(
        "blob_missing",
        "A provisioned-file snapshot blob is missing.",
        error,
      );
    }
    if (
      bytes.length !== file.size ||
      createHash("sha256").update(bytes).digest("hex") !== file.digest
    ) {
      throw new ManagedWorktreeSnapshotError(
        "blob_corrupt",
        "A provisioned-file snapshot blob failed verification.",
      );
    }
  }
}

/** Restore each verified blob through descriptor-relative no-follow traversal. */
export async function restoreProvisionedFiles(
  snapshotDirPath: string,
  provisionedFiles: readonly ProvisionedFileSnapshot[],
  worktreePath: string,
  worktreeIdentity?: ManagedWorktreeRootIdentity,
): Promise<void> {
  await verifyProvisionedFileBlobs(snapshotDirPath, provisionedFiles);
  for (const file of provisionedFiles) {
    if (normalizedRelativePath(file.relativePath) !== file.relativePath ||
        normalizedRelativePath(file.blobPath) !== file.blobPath) {
      throw new ManagedWorktreeSnapshotError(
        "snapshot_invalid", "A provisioned-file snapshot entry could not be verified.",
      );
    }
    try {
      await transferManagedWorktreeFile({
        operation: "restore",
        sourceRoot: snapshotDirPath,
        sourceRelativePath: file.blobPath,
        destinationRoot: worktreePath,
        destinationIdentity: worktreeIdentity,
        destinationRelativePath: file.relativePath,
        byteLimit: file.size,
        digest: file.digest,
        mode: file.mode & 0o777,
      });
    } catch (error) {
      const code = error instanceof ManagedWorktreeFileIoError ? error.code : undefined;
      throw new ManagedWorktreeSnapshotError(
        code === "destination_exists" ? "destination_exists"
          : code === "blob_corrupt" ? "blob_corrupt" : "snapshot_invalid",
        "A provisioned-file destination could not be restored safely.",
        error,
      );
    }
  }
}

export type ManagedWorktreeRestorePhase =
  | "checkout_planned"
  | "checkout_created"
  | "snapshot_applied"
  | "complete";

export interface ManagedWorktreeRestoreJournal {
  version: 1;
  phase: ManagedWorktreeRestorePhase;
  snapshotId: string;
  workspaceId: string;
  worktreePath: string;
  /** Identity of the checkout created for this restore, for resume checks. */
  worktreeGitDir?: string;
  ownershipToken?: string;
  worktreeDevice?: number;
  worktreeInode?: number;
}

/** Read the partial-restore journal inside a snapshot directory. */
export async function readManagedWorktreeRestoreJournal(
  root: string,
  snapshotId: string,
): Promise<ManagedWorktreeRestoreJournal | undefined> {
  const dir = snapshotDir(root, snapshotId);
  const value = await readJsonFile(restoreJournalPath(dir), RESTORE_BYTES);
  if (value === undefined) return undefined;
  const journal = value as Partial<ManagedWorktreeRestoreJournal>;
  if (
    typeof journal !== "object" ||
    journal === null ||
    journal.version !== 1 ||
    (journal.phase !== "checkout_planned" &&
      journal.phase !== "checkout_created" &&
      journal.phase !== "snapshot_applied" &&
      journal.phase !== "complete") ||
    journal.snapshotId !== snapshotId ||
    !isBoundedString(journal.workspaceId, 128) ||
    !isBoundedString(journal.worktreePath, 4096) ||
    !path.isAbsolute(journal.worktreePath) ||
    (journal.ownershipToken !== undefined && !isBoundedString(journal.ownershipToken, 128)) ||
    (journal.worktreeGitDir !== undefined &&
      (!isBoundedString(journal.worktreeGitDir, 4096) ||
        !path.isAbsolute(journal.worktreeGitDir))) ||
    (journal.worktreeDevice !== undefined && !Number.isSafeInteger(journal.worktreeDevice)) ||
    (journal.worktreeInode !== undefined && !Number.isSafeInteger(journal.worktreeInode))
  ) {
    throw new ManagedWorktreeSnapshotError(
      "snapshot_invalid",
      "The managed worktree restore journal could not be verified.",
    );
  }
  return journal as ManagedWorktreeRestoreJournal;
}

export async function writeManagedWorktreeRestoreJournal(
  root: string,
  journal: ManagedWorktreeRestoreJournal,
): Promise<void> {
  await persistJsonFile(restoreJournalPath(snapshotDir(root, journal.snapshotId)), {
    ...journal,
    version: 1,
  });
}

/**
 * Publish the first restore journal atomically: fails with EEXIST when a
 * journal already exists so two concurrent restores cannot plan divergent
 * checkouts for the same snapshot.
 *
 * The journal is written and fsynced under a temporary name and then linked to
 * its final name. `link` publishes a complete file in one step and still fails
 * with EEXIST when a competing planner won the claim, so a crash can only leave
 * no readable journal or one complete journal, never a truncated one that the
 * retry would reject as invalid.
 */
export async function createManagedWorktreeRestoreJournal(
  root: string,
  journal: ManagedWorktreeRestoreJournal,
): Promise<void> {
  const dir = snapshotDir(root, journal.snapshotId);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const target = restoreJournalPath(dir);
  const temporary = `${target}.${randomUUID()}.tmp`;
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(temporary, "wx", 0o600);
    await handle.writeFile(JSON.stringify({ ...journal, version: 1 }), "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.link(temporary, target);
    await syncDirectory(dir);
  } finally {
    await handle?.close().catch(() => undefined);
    // The temporary name is never the published journal; the target link keeps
    // the bytes alive when the claim succeeded.
    await fs.unlink(temporary).catch(() => undefined);
  }
}

/** Remove a completed restore journal; absent journals are already clean. */
export async function clearManagedWorktreeRestoreJournal(
  root: string,
  snapshotId: string,
): Promise<void> {
  await fs.unlink(restoreJournalPath(snapshotDir(root, snapshotId))).catch(() => undefined);
}
