import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
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
  | "recovery_limit"
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
    case "recovery_limit":
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
  // Only documented macOS system aliases are normalized. Do not realpath
  // arbitrary ancestors: native no-follow traversal must reject substitution.
  const fixedAliasPath = (value: string) => process.platform === "darwin"
    ? value.replace(/^\/(tmp|var|etc)(?=\/|$)/u, "/private/$1") : value;
  const sourcePath = fixedAliasPath(source.path);
  const destinationPath = fixedAliasPath(destination.path);
  const args = [
    options.operation,
    sourcePath,
    source.device,
    source.inode,
    options.sourceRelativePath,
    destinationPath,
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

/**
 * Batch-copy `.worktreeinclude`-selected files into a freshly created managed
 * worktree in a single helper invocation. Streams `p <index> <bytes>` lines so
 * `onProvisioned` records every installed file even if a later file fails.
 */
export async function provisionManagedWorktreeFilesBatch(options: {
  sourceRoot: string;
  sourceIdentity?: ManagedWorktreeRootIdentity;
  destinationRoot: string;
  destinationIdentity?: ManagedWorktreeRootIdentity;
  relativePaths: readonly string[];
  totalByteLimit: number;
  signal?: AbortSignal;
  onProvisioned?(relativePath: string, bytes: number): void;
}): Promise<{ provisioned: string[]; totalBytes: number }> {
  if (options.relativePaths.length === 0) return { provisioned: [], totalBytes: 0 };
  if (
    !Number.isSafeInteger(options.totalByteLimit) ||
    options.totalByteLimit < 0
  ) {
    throw new ManagedWorktreeFileIoError("invalid_input");
  }
  for (const entry of options.relativePaths) {
    if (!entry || entry.includes("\u0000")) {
      throw new ManagedWorktreeFileIoError("invalid_input");
    }
  }
  const source = options.sourceIdentity ?? await captureManagedWorktreeRootIdentity(options.sourceRoot);
  const destination = options.destinationIdentity ??
    await captureManagedWorktreeRootIdentity(options.destinationRoot);
  const fixedAliasPath = (value: string) => process.platform === "darwin"
    ? value.replace(/^\/(tmp|var|etc)(?=\/|$)/u, "/private/$1") : value;
  const args = [
    "provision",
    fixedAliasPath(source.path),
    source.device,
    source.inode,
    fixedAliasPath(destination.path),
    destination.device,
    destination.inode,
    String(options.totalByteLimit),
  ];

  const payload = Buffer.from(options.relativePaths.map((entry) => `${entry}\u0000`).join(""), "utf8");
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new Error("Provision aborted."));
      return;
    }
    // Do not pass `signal` directly to `spawn`: Node emits `AbortError` before
    // the helper exits, which would let rollback race with a still-running
    // helper. Instead send SIGTERM (with SIGKILL fallback) and settle ONLY on
    // `close` after stdout drains so `onProvisioned` stays 1:1 with disk.
    const child = spawn(resolveManagedWorktreeFileIoBinary(), args, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const provisioned: string[] = [];
    let totalBytes = 0;
    let nextIndex = 0;
    let sawDone = false;
    let protocolError = false;
    let callbackError: unknown;
    let hasCallbackError = false;
    let stdoutCarry = "";
    let stderr = "";
    let killEscalation: ReturnType<typeof setTimeout> | undefined;
    const STDERR_LIMIT = 4096;
    const STDOUT_LINE_LIMIT = 128;

    const terminateChild = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      try { child.kill("SIGTERM"); } catch { /* already exited */ }
      if (!killEscalation) {
        killEscalation = setTimeout(() => {
          try { child.kill("SIGKILL"); } catch { /* already exited */ }
        }, 2_000);
        killEscalation.unref?.();
      }
    };

    const onAbort = () => {
      terminateChild();
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    const cleanup = () => {
      clearTimeout(timer);
      if (killEscalation) {
        clearTimeout(killEscalation);
        killEscalation = undefined;
      }
      options.signal?.removeEventListener("abort", onAbort);
    };

    const processLine = (line: string) => {
      if (protocolError || hasCallbackError) return;
      if (!line || sawDone) {
        protocolError = true;
        return;
      }
      if (line === "done") {
        sawDone = true;
        return;
      }
      const match = /^p (\d+) (\d+)$/u.exec(line);
      if (!match) {
        protocolError = true;
        return;
      }
      const index = Number(match[1]);
      const bytes = Number(match[2]);
      if (
        !Number.isSafeInteger(index) ||
        index !== nextIndex ||
        index >= options.relativePaths.length ||
        !Number.isSafeInteger(bytes) ||
        bytes < 0 ||
        !Number.isSafeInteger(totalBytes + bytes) ||
        totalBytes + bytes > options.totalByteLimit
      ) {
        protocolError = true;
        return;
      }
      nextIndex += 1;
      totalBytes += bytes;
      const relativePath = options.relativePaths[index]!;
      provisioned.push(relativePath);
      try {
        options.onProvisioned?.(relativePath, bytes);
      } catch (error) {
        hasCallbackError = true;
        callbackError = error;
        terminateChild();
      }
    };

    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already exited */ }
    }, 120_000);
    timer.unref?.();

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdoutCarry += chunk;
      let newline = stdoutCarry.indexOf("\n");
      while (newline >= 0) {
        processLine(stdoutCarry.slice(0, newline));
        stdoutCarry = stdoutCarry.slice(newline + 1);
        newline = stdoutCarry.indexOf("\n");
      }
      if (stdoutCarry.length > STDOUT_LINE_LIMIT) {
        protocolError = true;
        stdoutCarry = "";
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < STDERR_LIMIT) {
        stderr += chunk.slice(0, STDERR_LIMIT - stderr.length);
      }
    });
    child.stdin.on("error", () => { /* Close handler owns exit errors. */ });
    child.stdin.end(payload);

    let settled = false;
    child.once("error", (error) => {
      // Only spawn failure (no child process started) settles here; otherwise
      // `close` waits for exit and stdout drain.
      if (child.pid !== undefined || settled) return;
      settled = true;
      cleanup();
      reject(new ManagedWorktreeFileIoError("io_failed", error));
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      // Every valid stdout record is newline-terminated; a non-empty remainder
      // at EOF is a truncated/corrupt protocol line.
      if (stdoutCarry.length > 0) {
        protocolError = true;
        stdoutCarry = "";
      }
      if (hasCallbackError) {
        reject(callbackError);
        return;
      }
      if (options.signal?.aborted) {
        reject(new Error("Provision aborted."));
        return;
      }
      if (code !== 0) {
        reject(new ManagedWorktreeFileIoError(errorCode(stderr)));
        return;
      }
      if (
        protocolError ||
        !sawDone ||
        nextIndex !== options.relativePaths.length ||
        !Number.isSafeInteger(totalBytes) ||
        totalBytes > options.totalByteLimit
      ) {
        reject(new ManagedWorktreeFileIoError("io_failed"));
        return;
      }
      resolve({ provisioned, totalBytes });
    });
  });
}

/** Enumerate only through the root-bound native directory descriptor. */
export interface WorkspaceDirectoryIdentities {
  root: ManagedWorktreeRootIdentity;
  directory: Pick<ManagedWorktreeRootIdentity, "device" | "inode">;
}

export async function listConfinedWorkspaceDirectory(
  root: string,
  relativePath: string,
  signal?: AbortSignal,
  identities?: WorkspaceDirectoryIdentities,
): Promise<{ entries: Array<{ name: string; kind: "file" | "directory"; device: string; inode: string }>; truncated: boolean }> {
  const rootIdentity = identities?.root ?? await captureManagedWorktreeRootIdentity(root);
  const directory = identities?.directory ?? await captureManagedWorktreeRootIdentity(path.join(rootIdentity.path, relativePath));
  const { stdout } = await executeFile(resolveManagedWorktreeFileIoBinary(), [
    "list", rootIdentity.path, rootIdentity.device, rootIdentity.inode,
    relativePath, directory.device, directory.inode,
  ], { encoding: "utf8", maxBuffer: 4 * 1_048_576, timeout: 30_000, signal });
  const lines = stdout.trimEnd().split("\n");
  const status = lines.pop();
  if ((status !== "c" && status !== "t") || lines.length > 4_000) throw new ManagedWorktreeFileIoError("io_failed");
  let truncated = status === "t";
  const entries: Array<{ name: string; kind: "file" | "directory"; device: string; inode: string }> = [];
  for (const line of lines) {
    const match = /^([df]) ([0-9]+) ([0-9]+) ((?:[0-9a-f]{2}){1,255})$/u.exec(line);
    if (!match) throw new ManagedWorktreeFileIoError("io_failed");
    try {
      const name = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(match[4], "hex"));
      if (!name || name.includes("/") || name === "." || name === "..") throw new Error("Invalid name");
      entries.push({ name, kind: match[1] === "d" ? "directory" : "file", device: match[2], inode: match[3] });
    } catch { truncated = true; }
  }
  return { entries, truncated };
}

export interface ConfinedWorkspaceFileIdentity {
  root: ManagedWorktreeRootIdentity;
  file: Pick<ManagedWorktreeRootIdentity, "device" | "inode">;
}

async function runConfinedFile(args: string[], signal?: AbortSignal, input?: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = execFile(resolveManagedWorktreeFileIoBinary(), args,
      { encoding: "buffer", maxBuffer: 1_501_024, timeout: 30_000, signal },
      (error, stdout, stderr) => {
        if (error) reject(new ManagedWorktreeFileIoError(errorCode(stderr.toString("utf8")), error));
        else resolve(stdout);
      });
    child.stdin?.on("error", () => { /* Process callback owns failures. */ });
    child.stdin?.end(input);
  });
}

export async function readConfinedWorkspaceFile(identity: ConfinedWorkspaceFileIdentity, relativePath: string, signal?: AbortSignal): Promise<Buffer> {
  const output = await runConfinedFile(["read", identity.root.path, identity.root.device, identity.root.inode,
    relativePath, identity.file.device, identity.file.inode], signal);
  const split = output.indexOf(10);
  const header = /^r ([0-9]+) ([0-9]+) (-?[0-9]+) ([0-9]+) ([a-f0-9]{64})$/u.exec(output.subarray(0, split).toString("ascii"));
  if (split < 0 || !header || Number(header[1]) !== output.length - split - 1 || Number(header[1]) > 1_500_000) {
    throw new ManagedWorktreeFileIoError("io_failed");
  }
  const content = output.subarray(split + 1);
  if (createHash("sha256").update(content).digest("hex") !== header[5]) throw new ManagedWorktreeFileIoError("io_failed");
  return content;
}

export async function editConfinedWorkspaceFile(identity: ConfinedWorkspaceFileIdentity, relativePath: string,
  content: Buffer, expectedVersion: string, signal?: AbortSignal): Promise<{ device: string; inode: string; recoveryName: string }> {
  if (content.length > 1_500_000 || !/^[a-f0-9]{64}$/u.test(expectedVersion)) throw new ManagedWorktreeFileIoError("invalid_input");
  const output = await runConfinedFile(["edit", identity.root.path, identity.root.device, identity.root.inode,
    relativePath, identity.file.device, identity.file.inode, expectedVersion, String(content.length)], signal, content);
  const header = /^w ([0-9]+) ([0-9]+) ([0-9]+) (-?[0-9]+) ([0-9]+) ([a-f0-9]{64}) ((?:[a-f0-9]{2})+)\n$/u.exec(output.toString("ascii"));
  if (!header || header[6] !== createHash("sha256").update(content).digest("hex")) throw new ManagedWorktreeFileIoError("io_failed");
  const recoveryName = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(header[7], "hex"));
  if (!recoveryName || recoveryName.includes("/") || recoveryName === "." || recoveryName === "..") throw new ManagedWorktreeFileIoError("io_failed");
  return { device: header[1], inode: header[2], recoveryName };
}

/**
 * Create a new file beneath `root`, walking every component with
 * descriptor-relative, no-follow opens (missing directories are created
 * along the way). A replaced ancestor cannot redirect the creation.
 */
export async function createConfinedWorkspaceFile(
  root: ManagedWorktreeRootIdentity,
  relativePath: string,
  content: Buffer,
  signal?: AbortSignal,
): Promise<{ device: string; inode: string }> {
  if (content.length > 8 * 1024 * 1024) throw new ManagedWorktreeFileIoError("invalid_input");
  const output = await runConfinedFile(
    ["create", root.path, root.device, root.inode, relativePath, String(content.length)],
    signal,
    content,
  );
  const header = /^c ([0-9]+) ([0-9]+)\n$/u.exec(output.toString("ascii"));
  if (!header) throw new ManagedWorktreeFileIoError("io_failed");
  return { device: header[1]!, inode: header[2]! };
}

/** Private, exclusive creation for explicitly transferred environment secrets. */
export async function createPrivateConfinedWorkspaceFile(root: ManagedWorktreeRootIdentity, relativePath: string, content: Buffer, signal?: AbortSignal): Promise<void> {
  if (content.length > 128 * 1024) throw new ManagedWorktreeFileIoError("invalid_input");
  const output = await runConfinedFile(["create-private", root.path, root.device, root.inode, relativePath, String(content.length)], signal, content);
  if (!/^c ([0-9]+) ([0-9]+)\n$/u.test(output.toString("ascii"))) throw new ManagedWorktreeFileIoError("io_failed");
}

/**
 * Create or replace a regular file beneath `root`. The helper walks every
 * component with descriptor-relative, no-follow opens (creating missing
 * directories), writes a fresh temporary in the held parent, and renames it
 * over the leaf through that same descriptor. A replaced ancestor cannot
 * redirect the write, and an existing file is replaced, never truncated.
 */
export async function saveConfinedWorkspaceFile(
  root: ManagedWorktreeRootIdentity,
  relativePath: string,
  content: Buffer,
  signal?: AbortSignal,
): Promise<{ device: string; inode: string }> {
  if (content.length > 64 * 1024 * 1024) throw new ManagedWorktreeFileIoError("invalid_input");
  const output = await runConfinedFile(
    ["save", root.path, root.device, root.inode, relativePath, String(content.length)],
    signal,
    content,
  );
  const header = /^c ([0-9]+) ([0-9]+)\n$/u.exec(output.toString("ascii"));
  if (!header) throw new ManagedWorktreeFileIoError("io_failed");
  return { device: header[1]!, inode: header[2]! };
}
