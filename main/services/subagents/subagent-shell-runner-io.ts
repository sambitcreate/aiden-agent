import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { trackDiagnosticChild } from "../performance-child.js";

export const SUBAGENT_SHELL_COMMAND_BYTES = 64 * 1024;
export const SUBAGENT_SHELL_STREAM_BYTES = 512 * 1024;
const RESPONSE_FIXED_BYTES = 164;
const MAX_PROTOCOL_BYTES = RESPONSE_FIXED_BYTES + SUBAGENT_SHELL_STREAM_BYTES * 2;
const SHA256 = /^[a-f0-9]{64}$/u;

export interface SubagentShellWorkspaceRoot {
  path: string;
  device: string;
  inode: string;
}

export type SubagentShellOutcome =
  | "exited"
  | "signaled"
  | "timed_out"
  | "output_limit"
  | "cancelled"
  | "spawn_failed"
  | "protocol_failed"
  | "cleanup_unconfirmed";

export interface SubagentShellResult {
  outcome: SubagentShellOutcome;
  exitCode?: number;
  signal?: number;
  cleanupConfirmed: boolean;
  stdout: string;
  stderr: string;
}

export interface SubagentShellRunnerRuntimePaths {
  defaultApp: boolean;
  resourcesPath?: string;
  cwd: string;
}

export function resolveSubagentShellRunnerBinary(
  runtime: SubagentShellRunnerRuntimePaths = {
    defaultApp: process.defaultApp === true,
    resourcesPath: typeof process.resourcesPath === "string" ? process.resourcesPath : undefined,
    cwd: process.cwd(),
  },
): string {
  if (
    runtime.defaultApp !== true &&
    typeof runtime.resourcesPath === "string" &&
    runtime.resourcesPath.length > 0
  ) {
    return path.resolve(runtime.resourcesPath, "..", "Helpers", "aiden-subagent-shell-runner");
  }
  return path.resolve(runtime.cwd, "build", "native", "aiden-subagent-shell-runner");
}

export async function pinSubagentShellWorkspaceRoot(
  candidate: string,
): Promise<SubagentShellWorkspaceRoot> {
  const canonical = await realpath(candidate);
  if (canonical !== path.resolve(candidate)) {
    throw new Error("The shell workspace root must be canonical and non-symlinked.");
  }
  const info = await lstat(canonical, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error("The shell workspace root must be a directory.");
  }
  return { path: canonical, device: info.dev.toString(), inode: info.ino.toString() };
}

function validCommand(command: string): Buffer {
  const bytes = Buffer.from(command, "utf8");
  const forbiddenCodePoint = [...command].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return (
      codePoint === 0 ||
      codePoint === 0x0d ||
      codePoint === 0x1b ||
      (codePoint < 0x20 && codePoint !== 0x09 && codePoint !== 0x0a) ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      codePoint === 0x2028 ||
      codePoint === 0x2029 ||
      (codePoint >= 0x202a && codePoint <= 0x202e) ||
      (codePoint >= 0x2066 && codePoint <= 0x2069)
    );
  });
  if (
    command.length === 0 ||
    bytes.length > SUBAGENT_SHELL_COMMAND_BYTES ||
    bytes.toString("utf8") !== command ||
    forbiddenCodePoint
  ) {
    throw new Error("The shell command is invalid or exceeds the fixed bound.");
  }
  return bytes;
}

export function encodeSubagentShellRequest(input: {
  command: string;
  effectDigest: string;
  nonce: string;
  timeoutMs: number;
}): Buffer {
  const command = validCommand(input.command);
  if (!SHA256.test(input.effectDigest) || !SHA256.test(input.nonce)) {
    throw new Error("The shell request identity is invalid.");
  }
  if (
    !Number.isSafeInteger(input.timeoutMs) ||
    input.timeoutMs < 1 ||
    input.timeoutMs > 3_600_000
  ) {
    throw new Error("The shell timeout is invalid.");
  }
  const fixed = Buffer.alloc(28);
  fixed.write("AIDSH001", 0, "ascii");
  fixed.writeUInt32BE(1, 8);
  fixed.writeUInt32BE(64, 12);
  fixed.writeUInt32BE(64, 16);
  fixed.writeUInt32BE(input.timeoutMs, 20);
  fixed.writeUInt32BE(command.length, 24);
  return Buffer.concat([
    fixed,
    Buffer.from(input.nonce, "ascii"),
    Buffer.from(input.effectDigest, "ascii"),
    command,
  ]);
}

function decodeUtf8(bytes: Buffer): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes).replace(/\0/gu, "�");
}

export function decodeSubagentShellResponse(
  response: Buffer,
  expected: { nonce: string; effectDigest: string },
): SubagentShellResult {
  if (response.length < RESPONSE_FIXED_BYTES || response.length > MAX_PROTOCOL_BYTES) {
    throw new Error("The shell helper response was malformed.");
  }
  if (response.subarray(0, 8).toString("ascii") !== "AIDSR001" || response.readUInt32BE(8) !== 1) {
    throw new Error("The shell helper response was malformed.");
  }
  const outcomeNames: readonly SubagentShellOutcome[] = [
    "exited",
    "signaled",
    "timed_out",
    "output_limit",
    "cancelled",
    "spawn_failed",
    "protocol_failed",
    "cleanup_unconfirmed",
  ];
  const outcome = outcomeNames[response.readUInt32BE(12) - 1];
  const exitCodeRaw = response.readUInt32BE(16);
  const signalRaw = response.readUInt32BE(20);
  const cleanupRaw = response.readUInt32BE(24);
  const stdoutLength = response.readUInt32BE(28);
  const stderrLength = response.readUInt32BE(32);
  const nonce = response.subarray(36, 100).toString("ascii");
  const digest = response.subarray(100, 164).toString("ascii");
  if (
    !outcome ||
    cleanupRaw > 1 ||
    stdoutLength > SUBAGENT_SHELL_STREAM_BYTES ||
    stderrLength > SUBAGENT_SHELL_STREAM_BYTES ||
    RESPONSE_FIXED_BYTES + stdoutLength + stderrLength !== response.length ||
    nonce !== expected.nonce ||
    digest !== expected.effectDigest
  ) {
    throw new Error("The shell helper response was malformed.");
  }
  const stdoutStart = RESPONSE_FIXED_BYTES;
  return {
    outcome,
    ...(exitCodeRaw === 0xffffffff ? {} : { exitCode: exitCodeRaw }),
    ...(signalRaw === 0 ? {} : { signal: signalRaw }),
    cleanupConfirmed: cleanupRaw === 1,
    stdout: decodeUtf8(response.subarray(stdoutStart, stdoutStart + stdoutLength)),
    stderr: decodeUtf8(response.subarray(stdoutStart + stdoutLength)),
  };
}

type SpawnRunner = typeof spawn;

export async function runSubagentShellProductionInert(input: {
  workspaceRoot: Readonly<SubagentShellWorkspaceRoot>;
  command: string;
  effectDigest: string;
  timeoutMs: number;
  signal: AbortSignal;
  binary?: string;
  nonce?: string;
  spawnProcess?: SpawnRunner;
}): Promise<SubagentShellResult> {
  if (input.signal.aborted) throw new Error("The shell request was cancelled.");
  const nonce = input.nonce ?? randomBytes(32).toString("hex");
  const request = encodeSubagentShellRequest({
    command: input.command,
    effectDigest: input.effectDigest,
    nonce,
    timeoutMs: input.timeoutMs,
  });
  const spawnRunner = input.spawnProcess ?? spawn;
  const child: ChildProcessWithoutNullStreams = spawnRunner(
    input.binary ?? resolveSubagentShellRunnerBinary(),
    [
      "serve",
      "--root",
      input.workspaceRoot.path,
      "--device",
      input.workspaceRoot.device,
      "--inode",
      input.workspaceRoot.inode,
    ],
    {
      cwd: "/",
      detached: false,
      shell: false,
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", LC_ALL: "C" },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  if (!input.spawnProcess) trackDiagnosticChild("subagent-shell", child);
  const chunks: Buffer[] = [];
  let bytes = 0;
  let helperErrorBytes = 0;
  const closeControl = (): void => {
    child.stdin.destroy();
  };
  input.signal.addEventListener("abort", closeControl, { once: true });
  const watchdog = setTimeout(() => child.kill("SIGKILL"), input.timeoutMs + 2_500);
  child.stdout.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > MAX_PROTOCOL_BYTES) child.kill("SIGKILL");
    else chunks.push(Buffer.from(chunk));
  });
  child.stderr.on("data", (chunk: Buffer) => {
    helperErrorBytes += chunk.length;
    if (helperErrorBytes > 16 * 1024) child.kill("SIGKILL");
  });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    },
  );
  child.stdin.write(request);
  try {
    const ended = await closed;
    if (ended.code !== 0 || ended.signal !== null) {
      throw new Error("The shell helper failed before returning a verified outcome.");
    }
    return decodeSubagentShellResponse(Buffer.concat(chunks), {
      nonce,
      effectDigest: input.effectDigest,
    });
  } finally {
    clearTimeout(watchdog);
    input.signal.removeEventListener("abort", closeControl);
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
  }
}
