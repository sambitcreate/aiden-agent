/** Model-authored artifact files use the model reader's credential-path policy. */
import * as fs from "node:fs/promises";
import path from "node:path";
import { isProtectedCredentialPath } from "../model-file-policy.js";
import { captureManagedWorktreeRootIdentity, readConfinedWorkspaceFile, ManagedWorktreeFileIoError } from "../managed-worktree-file-io.js";
import { decodeWorkspaceFileText } from "../workspace-files.js";

export const ARTIFACT_FILE_DENIED = "Credential files are unavailable to workspace artifacts.";
export class WorkspaceArtifactFileDeniedError extends Error {
  constructor() { super(ARTIFACT_FILE_DENIED); }
}
export function assertArtifactFilePath(file: string): void {
  if (isProtectedCredentialPath(file, "file")) throw new WorkspaceArtifactFileDeniedError();
}

async function admittedFile(root: string, file: string) {
  assertArtifactFilePath(file);
  if (!file || path.isAbsolute(file) || file.split(/[\\/]/u).includes("..")) throw new WorkspaceArtifactFileDeniedError();
  const identity = await captureManagedWorktreeRootIdentity(root);
  const canonical = await fs.realpath(path.resolve(identity.path, file));
  const relative = path.relative(identity.path, canonical);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new WorkspaceArtifactFileDeniedError();
  assertArtifactFilePath(relative);
  const info = await fs.lstat(canonical, { bigint: true });
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n) throw new WorkspaceArtifactFileDeniedError();
  return { identity, relative, file: { device: String(info.dev), inode: String(info.ino) } };
}

/** Metadata-only check for cached data. Missing/unavailable files keep ordinary transient cache semantics. */
export async function artifactFileAllowed(root: string, file: string): Promise<boolean> {
  try { await admittedFile(root, file); return true; }
  catch (error) { if (error instanceof WorkspaceArtifactFileDeniedError) return false; throw error; }
}

export async function readWorkspaceArtifactFile(root: string, file: string, signal?: AbortSignal, hooks: { beforeRead?: () => Promise<void> } = {}): Promise<string> {
  const admitted = await admittedFile(root, file);
  signal?.throwIfAborted();
  await hooks.beforeRead?.();
  const bytes = await readConfinedWorkspaceFile({ root: admitted.identity, file: admitted.file }, admitted.relative, signal).catch((error: unknown) => {
    if (error instanceof ManagedWorktreeFileIoError && ["unsafe_source", "source_changed"].includes(error.code)) throw new WorkspaceArtifactFileDeniedError();
    throw error;
  });
  signal?.throwIfAborted();
  return decodeWorkspaceFileText(bytes, file);
}
