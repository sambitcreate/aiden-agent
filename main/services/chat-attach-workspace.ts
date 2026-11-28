// Bounded inspection and collision-safe file carry-over when attaching a
// No workspace or ephemeral chat's private scratch folder to a real workspace.

import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type {
  AttachScratchFileEntry,
  InspectAttachFilesResult,
} from "../../renderer/shared/chat-attach-workspace.js";
import { assertPathInside } from "../shared/path-containment.js";
import { assertAgentMayWriteConfigPath } from "./protected-agent-config-paths.js";

const MAX_INSPECT_ENTRIES = 100;
const MAX_WALK_DEPTH = 6;
const MAX_COPY_FILES = 200;
const MAX_COPY_TOTAL_BYTES = 250 * 1024 * 1024; // 250 MiB safety cap

function toPosixRelative(relativePath: string): string {
  return relativePath.split(path.sep).join("/");
}

function hasForbiddenSegment(relativePath: string): boolean {
  const segments = relativePath.split(path.sep).filter(Boolean);
  return segments.some((segment) => {
    const folded = segment.toLowerCase();
    return folded === ".git" || folded === ".aiden" || folded === ".." || folded === ".";
  });
}

function isProtectedDestination(relativePosixPath: string, fullDestPath: string): boolean {
  try {
    assertAgentMayWriteConfigPath(relativePosixPath, fullDestPath);
    return false;
  } catch {
    return true;
  }
}

/**
 * Inspect files inside a chat's private scratch folder without following symlinks.
 * Missing folders report `{ hasFiles: false, ... }`.
 */
export async function inspectScratchFolderFiles(
  folderPath: string,
): Promise<InspectAttachFilesResult> {
  const entries: AttachScratchFileEntry[] = [];
  let totalBytes = 0;
  let truncated = false;

  const walk = async (dir: string, relBase: string, depth: number): Promise<void> => {
    if (depth > MAX_WALK_DEPTH) {
      truncated = true;
      return;
    }
    let dirEntries: Dirent[];
    try {
      dirEntries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return;
      throw error;
    }
    dirEntries.sort((a, b) => a.name.localeCompare(b.name));
    for (const dirent of dirEntries) {
      if (dirent.name === ".DS_Store") continue;
      const fullPath = path.join(dir, dirent.name);
      const relPath = relBase ? path.join(relBase, dirent.name) : dirent.name;
      if (hasForbiddenSegment(relPath)) continue;
      let stat: Awaited<ReturnType<typeof fs.lstat>>;
      try {
        stat = await fs.lstat(fullPath);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        await walk(fullPath, relPath, depth + 1);
        continue;
      }
      if (!stat.isFile()) continue;
      const relPosix = toPosixRelative(relPath);
      // Mirror copyScratchFilesToWorkspaceWithRollback so the Attach dialog never
      // lists protected hook/agent config files that Copy will skip.
      if (isProtectedDestination(relPosix, fullPath)) continue;
      totalBytes += stat.size;
      if (entries.length < MAX_INSPECT_ENTRIES) {
        entries.push({
          relativePath: relPosix,
          sizeBytes: stat.size,
          isDirectory: false,
        });
      } else {
        truncated = true;
      }
    }
  };

  await walk(folderPath, "", 0);
  return {
    hasFiles: entries.length > 0,
    totalBytes,
    truncated,
    entries,
  };
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await fs.lstat(candidate);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function pickScratchSubfolder(targetRoot: string): Promise<string> {
  for (let suffix = 1; suffix <= 999; suffix += 1) {
    const name = suffix === 1 ? "aiden-scratch" : `aiden-scratch-${suffix}`;
    const candidate = path.join(targetRoot, name);
    assertPathInside(
      targetRoot,
      candidate,
      "Scratch destination resolves outside the workspace folder.",
    );
    if (!(await pathExists(candidate))) return name;
  }
  throw new Error("Could not allocate a collision-free folder inside the target workspace.");
}

async function ensureDirTrackingCreated(
  dirPath: string,
  stopAtRoot: string,
  createdDirs: string[],
): Promise<void> {
  const missing: string[] = [];
  let cursor = dirPath;
  while (cursor !== stopAtRoot && cursor.startsWith(`${stopAtRoot}${path.sep}`)) {
    if (await pathExists(cursor)) break;
    missing.push(cursor);
    cursor = path.dirname(cursor);
  }
  for (let i = missing.length - 1; i >= 0; i -= 1) {
    const dir = missing[i]!;
    await fs.mkdir(dir);
    createdDirs.push(dir);
  }
}

export interface ScratchCopyTransaction {
  copiedPaths: string[];
  /** Best-effort undo of files and empty directories created by this copy. */
  rollback(): Promise<void>;
}

/**
 * Copy regular files from a chat's private scratch folder into a target workspace
 * without overwriting any existing file or following symlinks, returning a
 * rollback handle so callers can clean up if the subsequent store commit fails.
 */
export async function copyScratchFilesToWorkspaceWithRollback(
  sourceFolderPath: string,
  targetWorkspaceRoot: string,
): Promise<ScratchCopyTransaction> {
  const canonicalSource = await fs
    .realpath(sourceFolderPath)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
  if (!canonicalSource) return { copiedPaths: [], rollback: async () => undefined };
  const canonicalTarget = await fs.realpath(targetWorkspaceRoot);
  if (canonicalSource === canonicalTarget)
    return { copiedPaths: [], rollback: async () => undefined };

  const collected: Array<{ sourceFull: string; relPath: string; size: number }> = [];
  let totalBytes = 0;

  const collect = async (dir: string, relBase: string, depth: number): Promise<void> => {
    if (depth > MAX_WALK_DEPTH) {
      throw new Error("Scratch folder nesting is too deep to copy automatically.");
    }
    const dirEntries = await fs.readdir(dir, { withFileTypes: true });
    dirEntries.sort((a, b) => a.name.localeCompare(b.name));
    for (const dirent of dirEntries) {
      if (dirent.name === ".DS_Store") continue;
      const fullPath = path.join(dir, dirent.name);
      const relPath = relBase ? path.join(relBase, dirent.name) : dirent.name;
      if (hasForbiddenSegment(relPath)) continue;
      const stat = await fs.lstat(fullPath);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        await collect(fullPath, relPath, depth + 1);
        continue;
      }
      if (!stat.isFile()) continue;
      // Skip protected agent-config files upfront so they never trigger a subfolder fallback.
      const directCandidate = path.join(canonicalTarget, relPath);
      if (isProtectedDestination(toPosixRelative(relPath), directCandidate)) continue;
      if (collected.length >= MAX_COPY_FILES) {
        throw new Error(
          `Scratch folder contains more than ${MAX_COPY_FILES} files to copy automatically.`,
        );
      }
      totalBytes += stat.size;
      if (totalBytes > MAX_COPY_TOTAL_BYTES) {
        throw new Error("Scratch folder files exceed the automatic copy size limit.");
      }
      collected.push({ sourceFull: fullPath, relPath, size: stat.size });
    }
  };

  await collect(canonicalSource, "", 0);
  if (collected.length === 0) return { copiedPaths: [], rollback: async () => undefined };

  // Check if any top-level segment already exists in targetWorkspaceRoot.
  const topSegments = new Set(collected.map((item) => item.relPath.split(path.sep)[0]!));
  let needsSubfolder = false;
  for (const seg of topSegments) {
    const topDest = path.join(canonicalTarget, seg);
    if (await pathExists(topDest)) {
      needsSubfolder = true;
      break;
    }
  }

  const prefix = needsSubfolder ? await pickScratchSubfolder(canonicalTarget) : "";
  const copiedPaths: string[] = [];
  const createdFiles: string[] = [];
  const createdDirs: string[] = [];

  const rollback = async (): Promise<void> => {
    for (let i = createdFiles.length - 1; i >= 0; i -= 1) {
      await fs.unlink(createdFiles[i]!).catch(() => undefined);
    }
    for (let i = createdDirs.length - 1; i >= 0; i -= 1) {
      await fs.rmdir(createdDirs[i]!).catch(() => undefined);
    }
  };

  try {
    for (const item of collected) {
      const destRel = prefix ? path.join(prefix, item.relPath) : item.relPath;
      const destPosix = toPosixRelative(destRel);
      const destFull = path.join(canonicalTarget, destRel);
      assertPathInside(
        canonicalTarget,
        destFull,
        `Destination "${destPosix}" resolves outside the workspace folder.`,
      );
      if (isProtectedDestination(destPosix, destFull)) continue;
      await ensureDirTrackingCreated(path.dirname(destFull), canonicalTarget, createdDirs);
      // COPYFILE_EXCL guarantees we never overwrite an existing file even under a race.
      await fs.copyFile(item.sourceFull, destFull, fs.constants.COPYFILE_EXCL);
      createdFiles.push(destFull);
      copiedPaths.push(destPosix);
    }
  } catch (error) {
    await rollback();
    throw error;
  }

  return { copiedPaths, rollback };
}

/**
 * Copy regular files from a chat's private scratch folder into a target workspace
 * without overwriting any existing file or following symlinks.
 */
export async function copyScratchFilesToWorkspace(
  sourceFolderPath: string,
  targetWorkspaceRoot: string,
): Promise<string[]> {
  return (await copyScratchFilesToWorkspaceWithRollback(sourceFolderPath, targetWorkspaceRoot))
    .copiedPaths;
}
