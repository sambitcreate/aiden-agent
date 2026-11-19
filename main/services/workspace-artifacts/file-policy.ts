import { readLinuxArtifactFile, LinuxArtifactFileChangedError } from "./linux-file-read.js";
/** Model-authored artifact files use the model reader's credential-path policy. */
import * as fs from "node:fs/promises";
import path from "node:path";
import { isProtectedCredentialPath } from "../model-file-policy.js";
import { captureManagedWorktreeRootIdentity, readConfinedWorkspaceFile, ManagedWorktreeFileIoError } from "../managed-worktree-file-io.js";
import { decodeWorkspaceFileText } from "../workspace-files.js";

export const ARTIFACT_FILE_DENIED = "Credential files are unavailable to workspace artifacts.";
/** A read the policy refuses. The page drops whatever it read from that source before. */
export class WorkspaceArtifactFileDeniedError extends Error {
  constructor(message = ARTIFACT_FILE_DENIED) { super(message); }
}
/**
 * The file, or a folder on its path, was replaced or changed between Aiden
 * checking it and reading it. Nothing was read; what the page read from it
 * before was read under the policy, so the page keeps it, marked stale.
 */
export class WorkspaceArtifactFileChangedError extends Error {
  constructor(file: string) { super(`${file} changed while Aiden was reading it, so the page keeps the data it read before. The next refresh reads it again.`); }
}
/**
 * The workspace folder, or a folder on the way to the file, is not a plain
 * folder Aiden can open (a link, a file, or one it may not enter). Nothing
 * was read, and this lasts until the folder is fixed, so unlike a change
 * mid-read it does not promise that the next refresh reads the file.
 */
export class WorkspaceArtifactFileUnsafeError extends Error {
  constructor(file: string) {
    super(`Aiden could not safely read ${file}: the workspace folder, or a folder on the way to the file, is a link or not a folder, or Aiden may not open it. Nothing was read.`);
  }
}
const isUnsafeSource = (error: unknown) => error instanceof ManagedWorktreeFileIoError && error.code === "unsafe_source";

export function assertArtifactFilePath(file: string): void {
  if (isProtectedCredentialPath(file, "file")) throw new WorkspaceArtifactFileDeniedError();
}

/**
 * One answer for a path that leaves the folder and for one that cannot be
 * resolved past a link, so a page cannot tell from its errors which files
 * exist outside the workspace folder.
 */
const missingOrOutside = (file: string) => `${file} is missing or leads outside the workspace folder.`;

/**
 * A file the system would not let Aiden read for a reason of its own (a
 * folder on the path is a file, or may not be entered). The system's message
 * names the folder's full path, so the page is told only this.
 */
export class WorkspaceArtifactFileUnreadableError extends Error {
  constructor(file: string) { super(`${file} cannot be read.`); }
}

/** Whether a part of `file` that exists inside `root` is a link. */
async function linkOnPath(root: string, file: string): Promise<boolean> {
  let at = root;
  for (const part of file.split(/[\\/]/u).filter((piece) => piece && piece !== ".")) {
    at = path.join(at, part);
    try {
      if ((await fs.lstat(at)).isSymbolicLink()) return true;
    } catch {
      return false;
    }
  }
  return false;
}

async function admittedFile(root: string, file: string) {
  assertArtifactFilePath(file);
  if (!file || path.isAbsolute(file) || file.split(/[\\/]/u).includes("..")) throw new WorkspaceArtifactFileDeniedError(`${file || "The file"} is not a path inside the workspace folder.`);
  const identity = await captureManagedWorktreeRootIdentity(root).catch((error: unknown) => {
    throw isUnsafeSource(error) ? new WorkspaceArtifactFileUnsafeError(file) : error;
  });
  let canonical: string;
  try {
    canonical = await fs.realpath(path.resolve(identity.path, file));
  } catch (error) {
    // Past a link the path may lead anywhere: whether something is missing out there is not the page's to learn.
    if (await linkOnPath(identity.path, file)) throw new WorkspaceArtifactFileDeniedError(missingOrOutside(file));
    // A missing file is the one failure the page is told in its own words; the runner says there is no file there.
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") throw error;
    throw new WorkspaceArtifactFileUnreadableError(file);
  }
  const relative = path.relative(identity.path, canonical);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new WorkspaceArtifactFileDeniedError(missingOrOutside(file));
  assertArtifactFilePath(relative);
  const info = await fs.lstat(canonical, { bigint: true });
  if (!info.isFile() || info.isSymbolicLink()) throw new WorkspaceArtifactFileDeniedError(`${file} is not a file.`);
  if (info.nlink !== 1n) throw new WorkspaceArtifactFileDeniedError(`${file} has more than one hard link, so an artifact cannot read it.`);
  return { identity, relative, file: { device: String(info.dev), inode: String(info.ino) } };
}

/** Metadata-only check for cached data. Missing/unavailable files inside the folder keep ordinary transient cache semantics; one missing past a link is refused. */
export async function artifactFileAllowed(root: string, file: string): Promise<boolean> {
  try { await admittedFile(root, file); return true; }
  catch (error) { if (error instanceof WorkspaceArtifactFileDeniedError) return false; throw error; }
}

export async function readWorkspaceArtifactFile(root: string, file: string, signal?: AbortSignal, hooks: { beforeRead?: () => Promise<void> } = {}): Promise<string> {
  const admitted = await admittedFile(root, file);
  signal?.throwIfAborted();
  await hooks.beforeRead?.();
  const identity = { root: admitted.identity, file: admitted.file };
  const reading = process.platform === "linux"
    ? readLinuxArtifactFile(identity, admitted.relative, signal)
    : readConfinedWorkspaceFile(identity, admitted.relative, signal);
  const bytes = await reading.catch((error: unknown) => {
    if (error instanceof LinuxArtifactFileChangedError || (error instanceof ManagedWorktreeFileIoError && error.code === "source_changed")) {
      throw new WorkspaceArtifactFileChangedError(file);
    }
    if (isUnsafeSource(error)) throw new WorkspaceArtifactFileUnsafeError(file);
    throw error;
  });
  signal?.throwIfAborted();
  return decodeWorkspaceFileText(bytes, file);
}
