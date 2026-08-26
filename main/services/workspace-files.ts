// Bounded, workspace-confined file operations for the user-facing Files panel.
// Renderer paths are always resolved against the persisted workspace root and
// existing symlinks are followed only when their canonical target stays inside it.

import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { trackDiagnosticChild } from "./performance-child.js";
import { recordDiagnosticCounter } from "./performance-diagnostics.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const MAX_INDEX_ENTRIES = 4_000;
const MAX_INDEX_DEPTH = 20;
const MAX_EDITOR_BYTES = 1_500_000;
const MAX_EDITOR_LINES = 50_000;
const SKIP_DIRECTORIES = new Set([
  ".git",
  ".cache",
  ".build",
  ".next",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "release",
]);

export type WorkspaceFileKind = "directory" | "file" | "symlink";

export interface WorkspaceFileEntry {
  path: string;
  name: string;
  parentPath: string;
  depth: number;
  kind: WorkspaceFileKind;
  symbolic?: boolean;
  size?: number;
  modifiedAt?: number;
}

export interface WorkspaceFileIndex {
  entries: WorkspaceFileEntry[];
  truncated: boolean;
  skippedDirectories: number;
}

export interface WorkspaceFileDocument {
  path: string;
  content: string;
  size: number;
  modifiedAt: number;
  version: string;
  warning?: string;
}

export type WorkspaceFileErrorCode = "changed_on_disk" | "io_error";

export class WorkspaceFileError extends Error {
  readonly cause: unknown;

  constructor(
    readonly code: WorkspaceFileErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message);
    this.name = "WorkspaceFileError";
    this.cause = options?.cause;
  }
}

export interface WorkspaceFileWriteHooks {
  /** Test-only interleaving point after the optimistic read and before displacement. */
  beforeDisplace?: () => Promise<void>;
  /** Test-only interleaving point after verification, before recovery cleanup. */
  beforeRecoveryCleanup?: (recoveryPath: string) => Promise<void>;
  /** Test-only override for the open-descriptor safety probe. */
  recoveryUse?: (recoveryPath: string) => Promise<"clear" | "open" | "unknown">;
}

async function recoveryUse(recoveryPath: string): Promise<"clear" | "open" | "unknown"> {
  if (process.platform !== "darwin") return "unknown";
  return new Promise((resolve) => {
    const child = execFile(
      "/usr/sbin/lsof",
      ["-F", "p", "--", recoveryPath],
      { maxBuffer: 64 * 1024, timeout: 2_000 },
      (error, stdout) => {
        if (!error) {
          resolve(stdout.split(/\r?\n/).some((line) => /^p\d+$/.test(line)) ? "open" : "clear");
          return;
        }
        const exitCode = typeof error.code === "number" ? error.code : undefined;
        resolve(exitCode === 1 && !stdout.trim() ? "clear" : "unknown");
      },
    );
    trackDiagnosticChild("workspace-search", child);
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("The workspace operation was cancelled.");
}

function toPortablePath(value: string): string {
  return value.split(path.sep).join("/");
}

function sortWorkspaceEntries(entries: WorkspaceFileEntry[]): void {
  const byPath = new Map(entries.map((entry) => [entry.path, entry] as const));
  const segments = new Map(entries.map((entry) => [entry.path, entry.path.split("/")] as const));
  entries.sort((left, right) => {
    const leftParts = segments.get(left.path) ?? [];
    const rightParts = segments.get(right.path) ?? [];
    const sharedLength = Math.min(leftParts.length, rightParts.length);
    for (let index = 0; index < sharedLength; index += 1) {
      if (leftParts[index] === rightParts[index]) continue;
      const leftNode = byPath.get(leftParts.slice(0, index + 1).join("/"));
      const rightNode = byPath.get(rightParts.slice(0, index + 1).join("/"));
      const leftDirectory = leftNode?.kind === "directory";
      const rightDirectory = rightNode?.kind === "directory";
      if (leftDirectory !== rightDirectory) return leftDirectory ? -1 : 1;
      return leftParts[index].localeCompare(rightParts[index], undefined, { numeric: true });
    }
    return leftParts.length - rightParts.length;
  });
}

function assertRelativePath(value: string): string {
  if (!value || value.includes("\u0000") || path.isAbsolute(value)) {
    throw new Error("Choose a file inside the workspace.");
  }
  const normalized = path.normalize(value);
  if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
    throw new Error(`Path "${value}" is outside the workspace folder.`);
  }
  return normalized;
}

function assertInRoot(root: string, candidate: string, suppliedPath: string): string {
  const relative = path.relative(root, candidate);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Path "${suppliedPath}" resolves outside the workspace folder.`);
  }
  return candidate;
}

async function canonicalRoot(root: string): Promise<string> {
  const realRoot = await fs.realpath(root);
  if (!(await fs.stat(realRoot)).isDirectory())
    throw new Error("The workspace folder is unavailable.");
  return realRoot;
}

async function resolveExistingPath(
  root: string,
  suppliedPath: string,
): Promise<{ root: string; fullPath: string; relativePath: string }> {
  const realRoot = await canonicalRoot(root);
  const relativePath = assertRelativePath(suppliedPath);
  const lexicalPath = path.resolve(realRoot, relativePath);
  assertInRoot(realRoot, lexicalPath, suppliedPath);
  const fullPath = assertInRoot(realRoot, await fs.realpath(lexicalPath), suppliedPath);
  return { root: realRoot, fullPath, relativePath: toPortablePath(relativePath) };
}

function contentVersion(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function decodeText(buffer: Buffer, suppliedPath: string): string {
  if (buffer.subarray(0, 8_192).includes(0)) {
    throw new Error(`${suppliedPath} is binary and cannot be edited as text.`);
  }
  try {
    const content = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    if (content.split("\n", MAX_EDITOR_LINES + 1).length > MAX_EDITOR_LINES) {
      throw new Error(`${suppliedPath} has too many lines to edit safely in Aiden.`);
    }
    return content;
  } catch {
    if (buffer.toString("utf8").split("\n", MAX_EDITOR_LINES + 1).length > MAX_EDITOR_LINES) {
      throw new Error(`${suppliedPath} has too many lines to edit safely in Aiden.`);
    }
    throw new Error(`${suppliedPath} is not valid UTF-8 text.`);
  }
}

export async function listWorkspaceFiles(
  root: string,
  signal?: AbortSignal,
): Promise<WorkspaceFileIndex> {
  const realRoot = await canonicalRoot(root);
  const entries: WorkspaceFileEntry[] = [];
  let truncated = false;
  let skippedDirectories = 0;

  const directories: Array<{ relativeDirectory: string; depth: number }> = [
    { relativeDirectory: "", depth: 0 },
  ];
  for (let directoryIndex = 0; directoryIndex < directories.length; directoryIndex += 1) {
    throwIfAborted(signal);
    const { relativeDirectory, depth } = directories[directoryIndex];
    if (depth > MAX_INDEX_DEPTH) {
      truncated = true;
      break;
    }

    const directoryPath = path.join(realRoot, relativeDirectory);
    const children = await fs.readdir(directoryPath, { withFileTypes: true });
    children.sort((left, right) => {
      const leftDirectory = left.isDirectory() ? 0 : 1;
      const rightDirectory = right.isDirectory() ? 0 : 1;
      return (
        leftDirectory - rightDirectory ||
        left.name.localeCompare(right.name, undefined, { numeric: true })
      );
    });

    for (const child of children) {
      throwIfAborted(signal);
      if (entries.length >= MAX_INDEX_ENTRIES) {
        truncated = true;
        break;
      }
      if (child.isDirectory() && SKIP_DIRECTORIES.has(child.name)) {
        skippedDirectories += 1;
        continue;
      }

      const relativePath = path.join(relativeDirectory, child.name);
      const portablePath = toPortablePath(relativePath);
      const parentPath = toPortablePath(relativeDirectory);
      const lexicalPath = path.join(realRoot, relativePath);

      if (child.isSymbolicLink()) {
        try {
          const target = assertInRoot(realRoot, await fs.realpath(lexicalPath), portablePath);
          const targetStats = await fs.stat(target);
          entries.push({
            path: portablePath,
            name: child.name,
            parentPath,
            depth,
            kind: targetStats.isFile() ? "file" : "symlink",
            symbolic: true,
            size: targetStats.isFile() ? targetStats.size : undefined,
            modifiedAt: targetStats.mtimeMs,
          });
        } catch {
          entries.push({
            path: portablePath,
            name: child.name,
            parentPath,
            depth,
            kind: "symlink",
            symbolic: true,
          });
        }
        continue;
      }

      if (child.isDirectory()) {
        entries.push({
          path: portablePath,
          name: child.name,
          parentPath,
          depth,
          kind: "directory",
        });
        directories.push({ relativeDirectory: relativePath, depth: depth + 1 });
        continue;
      }

      if (child.isFile()) {
        const stats = await fs.stat(lexicalPath);
        entries.push({
          path: portablePath,
          name: child.name,
          parentPath,
          depth,
          kind: "file",
          size: stats.size,
          modifiedAt: stats.mtimeMs,
        });
      }
    }
    if (truncated) break;
  }

  sortWorkspaceEntries(entries);
  return { entries, truncated, skippedDirectories };
}

export async function readWorkspaceFile(
  root: string,
  suppliedPath: string,
  signal?: AbortSignal,
): Promise<WorkspaceFileDocument> {
  throwIfAborted(signal);
  const { fullPath, relativePath } = await resolveExistingPath(root, suppliedPath);
  const stats = await fs.stat(fullPath);
  if (!stats.isFile()) throw new Error(`${relativePath} is not a file.`);
  if (stats.size > MAX_EDITOR_BYTES) {
    throw new Error(
      `${relativePath} is too large to edit in Aiden (${Math.ceil(stats.size / 1_000_000)} MB).`,
    );
  }
  const buffer = await fs.readFile(fullPath);
  recordDiagnosticCounter("filesystem:read", { bytesOut: buffer.byteLength });
  throwIfAborted(signal);
  return {
    path: relativePath,
    content: decodeText(buffer, relativePath),
    size: buffer.byteLength,
    modifiedAt: stats.mtimeMs,
    version: contentVersion(buffer),
  };
}

export async function writeWorkspaceFile(
  root: string,
  suppliedPath: string,
  content: string,
  expectedVersion: string,
  signal?: AbortSignal,
  hooks?: WorkspaceFileWriteHooks,
): Promise<WorkspaceFileDocument> {
  throwIfAborted(signal);
  const nextBuffer = Buffer.from(content, "utf8");
  if (nextBuffer.byteLength > MAX_EDITOR_BYTES) {
    throw new Error(`${suppliedPath} is too large to save in Aiden.`);
  }
  if (content.split("\n", MAX_EDITOR_LINES + 1).length > MAX_EDITOR_LINES) {
    throw new Error(`${suppliedPath} has too many lines to save safely in Aiden.`);
  }

  const { fullPath, relativePath } = await resolveExistingPath(root, suppliedPath);
  const stats = await fs.stat(fullPath);
  if (!stats.isFile()) throw new Error(`${relativePath} is not a file.`);
  const currentBuffer = await fs.readFile(fullPath);
  recordDiagnosticCounter("filesystem:read", { bytesOut: currentBuffer.byteLength });
  if (contentVersion(currentBuffer) !== expectedVersion) {
    throw new WorkspaceFileError(
      "changed_on_disk",
      `${relativePath} changed on disk. Reload it before saving so newer work is not overwritten.`,
    );
  }

  const temporaryPath = path.join(
    path.dirname(fullPath),
    `.${path.basename(fullPath)}.aiden-${randomUUID()}.tmp`,
  );
  const recoveryPath = path.join(
    path.dirname(fullPath),
    `.${path.basename(fullPath)}.aiden-recovery-${randomUUID()}`,
  );
  let displaced = false;
  let installed = false;
  let warning: string | undefined;
  try {
    await fs.writeFile(temporaryPath, nextBuffer, { flag: "wx", mode: stats.mode });
    recordDiagnosticCounter("filesystem:write", { bytesIn: nextBuffer.byteLength });
    // Creation mode is filtered through the process umask. Restore the exact
    // permission and special bits before the inode can become the saved file.
    await fs.chmod(temporaryPath, stats.mode & 0o7777);
    await hooks?.beforeDisplace?.();
    throwIfAborted(signal);
    await fs.rename(fullPath, recoveryPath);
    displaced = true;
    const displacedBuffer = await fs.readFile(recoveryPath);
    recordDiagnosticCounter("filesystem:read", { bytesOut: displacedBuffer.byteLength });
    if (contentVersion(displacedBuffer) !== expectedVersion) {
      throw new WorkspaceFileError(
        "changed_on_disk",
        `${relativePath} changed while Aiden prepared the save. The newer on-disk file was not overwritten.`,
      );
    }
    throwIfAborted(signal);
    try {
      // A hard link is an atomic create-if-absent. Unlike rename, it refuses
      // to overwrite a file recreated by an external editor after displacement.
      await fs.link(temporaryPath, fullPath);
      installed = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new WorkspaceFileError(
          "changed_on_disk",
          `${relativePath} changed while Aiden prepared the save. The newer on-disk file was not overwritten.`,
          { cause: error },
        );
      }
      throw error;
    }
    const [savedBuffer, verifiedDisplaced] = await Promise.all([
      fs.readFile(fullPath),
      fs.readFile(recoveryPath),
    ]);
    recordDiagnosticCounter("filesystem:read", {
      bytesOut: savedBuffer.byteLength + verifiedDisplaced.byteLength,
    });
    if (
      contentVersion(savedBuffer) !== contentVersion(nextBuffer) ||
      contentVersion(verifiedDisplaced) !== expectedVersion
    ) {
      throw new WorkspaceFileError(
        "changed_on_disk",
        `${relativePath} changed during the save. Aiden preserved the displaced file for recovery.`,
      );
    }
    await hooks?.beforeRecoveryCleanup?.(recoveryPath);
    const use = hooks?.recoveryUse
      ? await hooks.recoveryUse(recoveryPath)
      : await recoveryUse(recoveryPath);
    let recoveryMatches: boolean | undefined;
    try {
      const recoveryBuffer = await fs.readFile(recoveryPath);
      recordDiagnosticCounter("filesystem:read", { bytesOut: recoveryBuffer.byteLength });
      recoveryMatches = contentVersion(recoveryBuffer) === expectedVersion;
    } catch {
      recoveryMatches = undefined;
    }
    if (use === "clear" && recoveryMatches) {
      await fs.rm(recoveryPath);
      displaced = false;
    } else if (recoveryMatches === false) {
      warning = `Another app wrote to the previous file during Aiden's save. Your draft was saved, and that app's version remains at ${path.basename(recoveryPath)}.`;
    } else {
      warning =
        use === "open"
          ? `Another app still had the previous file open. Aiden saved your draft and kept that app's in-flight copy at ${path.basename(recoveryPath)}.`
          : recoveryMatches
            ? `Aiden could not verify that the previous file was closed. Your draft was saved, and a recovery copy remains at ${path.basename(recoveryPath)}.`
            : "Aiden saved your draft but could not verify the previous file's recovery copy. Review the workspace before making another save.";
    }
  } catch (error) {
    if (displaced && !installed) {
      try {
        // Restore without replacing anything an external editor may have
        // recreated at the destination in the meantime.
        await fs.link(recoveryPath, fullPath);
        await fs.rm(recoveryPath);
        displaced = false;
      } catch {
        // Both paths are preserved. The surfaced recovery name lets the user
        // reconcile the extremely narrow external-write race without loss.
      }
    }
    const detail =
      error instanceof WorkspaceFileError
        ? error
        : new WorkspaceFileError(
            "io_error",
            error instanceof Error ? error.message : `Aiden could not save ${relativePath}.`,
            { cause: error },
          );
    if (displaced) {
      throw new WorkspaceFileError(
        detail.code,
        `${detail.message} A recovery copy remains at ${path.basename(recoveryPath)}.`,
        { cause: detail },
      );
    }
    throw detail;
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
  }

  const savedStats = await fs.stat(fullPath);
  return {
    path: relativePath,
    content,
    size: nextBuffer.byteLength,
    modifiedAt: savedStats.mtimeMs,
    version: contentVersion(nextBuffer),
    ...(warning ? { warning } : {}),
  };
}
