import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";

const executeFile = promisify(execFile);
const OUTPUT_LIMIT = 1024;

export type ManagedWorktreeFileIoCode =
  | "invalid_input"
  | "unsafe_source"
  | "unsafe_destination"
  | "destination_exists"
  | "source_changed"
  | "too_many_bytes"
  | "blob_corrupt"
  | "io_failed";

export class ManagedWorktreeFileIoError extends Error {
  declare readonly cause: unknown;
  constructor(readonly code: ManagedWorktreeFileIoCode, cause?: unknown) {
    super(`Managed worktree file operation failed: ${code}`);
    this.name = "ManagedWorktreeFileIoError";
    this.cause = cause;
  }
}

export function resolveManagedWorktreeFileIoBinary(): string {
  if (process.defaultApp !== true && typeof process.resourcesPath === "string") {
    return path.resolve(process.resourcesPath, "..", "Helpers", "aiden-worktree-file-io");
  }
  return path.resolve(process.cwd(), "build", "native", "aiden-worktree-file-io");
}

export interface ManagedWorktreeRootIdentity {
  path: string;
  device: string;
  inode: string;
}

export async function captureManagedWorktreeRootIdentity(root: string): Promise<ManagedWorktreeRootIdentity> {
  const canonical = await fs.realpath(root);
  const stat = await fs.lstat(canonical, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new ManagedWorktreeFileIoError("unsafe_source");
  }
  return { path: canonical, device: stat.dev.toString(), inode: stat.ino.toString() };
}

function errorCode(stderr: string): ManagedWorktreeFileIoCode {
  const value = stderr.trim();
  switch (value) {
    case "invalid_input":
    case "unsafe_source":
    case "unsafe_destination":
    case "destination_exists":
    case "source_changed":
    case "too_many_bytes":
    case "blob_corrupt":
    case "io_failed":
      return value;
    default:
      return "io_failed";
  }
}

export async function transferManagedWorktreeFile(options: {
  operation: "copy" | "restore";
  sourceRoot: string;
  sourceIdentity?: ManagedWorktreeRootIdentity;
  sourceRelativePath: string;
  destinationRoot: string;
  destinationIdentity?: ManagedWorktreeRootIdentity;
  destinationRelativePath: string;
  /** Maximum source bytes for copy; exact bytes for restore. */
  byteLimit: number;
  digest?: string;
  mode: number | "source";
}): Promise<{ size: number; mode: number; sourceMode: number; digest: string }> {
  const source = options.sourceIdentity ?? await captureManagedWorktreeRootIdentity(options.sourceRoot);
  const destination = options.destinationIdentity ??
    await captureManagedWorktreeRootIdentity(options.destinationRoot);
  const args = [
    options.operation,
    source.path,
    source.device,
    source.inode,
    options.sourceRelativePath,
    destination.path,
    destination.device,
    destination.inode,
    options.destinationRelativePath,
    String(options.byteLimit),
    options.digest ?? "-",
    String(options.mode),
  ];
  let stdout: string;
  try {
    ({ stdout } = await executeFile(resolveManagedWorktreeFileIoBinary(), args, {
      encoding: "utf8",
      maxBuffer: OUTPUT_LIMIT,
      timeout: 120_000,
    }));
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? "";
    throw new ManagedWorktreeFileIoError(errorCode(stderr), error);
  }
  const match = /^(\d+) (\d+) (\d+) ([0-9a-f]{64})\n$/u.exec(stdout);
  if (!match) {
    // Restore of an identical destination is a successful no-op.
    if (options.operation === "restore" && stdout === "") {
      return { size: options.byteLimit, mode: Number(options.mode), sourceMode: 0, digest: options.digest! };
    }
    throw new ManagedWorktreeFileIoError("io_failed");
  }
  return { size: Number(match[1]), mode: Number(match[2]), sourceMode: Number(match[3]), digest: match[4] };
}

/** Enumerate only through the root-bound native directory descriptor. */
export async function listConfinedWorkspaceDirectory(
  root: string,
  relativePath: string,
  signal?: AbortSignal,
): Promise<{ entries: Array<{ name: string; kind: "file" | "directory" }>; truncated: boolean }> {
  const rootIdentity = await captureManagedWorktreeRootIdentity(root);
  const directory = await captureManagedWorktreeRootIdentity(path.join(rootIdentity.path, relativePath));
  const { stdout } = await executeFile(resolveManagedWorktreeFileIoBinary(), [
    "list", rootIdentity.path, rootIdentity.device, rootIdentity.inode,
    relativePath, directory.device, directory.inode,
  ], { encoding: "utf8", maxBuffer: 4 * 1_048_576, timeout: 30_000, signal });
  const lines = stdout.trimEnd().split("\n");
  const status = lines.pop();
  if ((status !== "c" && status !== "t") || lines.length > 4_000) throw new ManagedWorktreeFileIoError("io_failed");
  let truncated = status === "t";
  const entries: Array<{ name: string; kind: "file" | "directory" }> = [];
  for (const line of lines) {
    const match = /^([df]) ((?:[0-9a-f]{2}){1,255})$/u.exec(line);
    if (!match) throw new ManagedWorktreeFileIoError("io_failed");
    try {
      const name = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(match[2], "hex"));
      if (!name || name.includes("/") || name === "." || name === "..") throw new Error("Invalid name");
      entries.push({ name, kind: match[1] === "d" ? "directory" : "file" });
    } catch { truncated = true; }
  }
  return { entries, truncated };
}
