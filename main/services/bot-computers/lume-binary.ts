import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { access, lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { runBoundedProcess } from "./bounded-process.js";
import type { LumeInvocation } from "./lume-cli.js";
import { BotComputerError } from "./types.js";

// Security pins are compiled into Aiden. resources/bot-computers/lume-artifact.json
// is human-readable provenance; scripts/bot-computers-lume-pins.mjs is the
// packaging authority. lume-binary.test.ts fails when any of the three drift.
export const LUME_PINS = Object.freeze({
  version: "0.6.1",
  tag: "lume-v0.6.1",
  bundleIdentifier: "com.trycua.lume",
  bundleVersion: "0.6.1",
  binarySha256: "a369d63746690afe79626e357241df2f95b523e7f6f60ac9bc7665762abfc904",
  binaryBytes: 21_425_024,
  upstreamSigningTeamId: "YCK386LBJ7",
  archiveSha256: "2675b7981b7d3eb525cd27f40a385c986052eb71b3360c0b2579644725f1bad8",
});

export function lumeSigningRequirement(): string {
  return `anchor apple generic and identifier "${LUME_PINS.bundleIdentifier}" and certificate leaf[subject.OU] = "${LUME_PINS.upstreamSigningTeamId}"`;
}

export interface LumeInstallationOptions {
  platform: NodeJS.Platform;
  arch: string;
  isPackaged: boolean;
  /** `process.resourcesPath`: `<App>.app/Contents/Resources` when packaged. */
  resourcesPath: string;
  /** `app.getAppPath()`: the repository root in development. */
  appPath: string;
  /** Runs fixed system tools (`plutil`, `codesign`); injected in tests. */
  run?: (command: string, args: string[], signal?: AbortSignal) => Promise<{ exitCode: number | null; stdout: string }>;
  hash?: (file: string, signal?: AbortSignal) => Promise<string>;
  signal?: AbortSignal;
}

export interface LumeInstallation {
  appPath: string;
  binaryPath: string;
  invocation: LumeInvocation;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new BotComputerError("cancelled", "Checking the computer helper was cancelled.");
}

async function hashFile(file: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) {
    throwIfAborted(signal);
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

const SYSTEM_ENV = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" };

async function runSystemTool(
  command: string,
  args: string[],
  signal?: AbortSignal,
): Promise<{ exitCode: number | null; stdout: string }> {
  const result = await runBoundedProcess(command, args, {
    env: SYSTEM_ENV,
    signal,
    timeoutMs: 15_000,
    maxStdoutBytes: 64 * 1024,
    overflow: "fail",
  });
  return { exitCode: result.timedOut ? null : result.exitCode, stdout: result.stdout };
}

/** Where the pinned bundle lives: inside the app when packaged, under build/ in development. */
export function lumeAppPath(options: Pick<LumeInstallationOptions, "isPackaged" | "resourcesPath" | "appPath">): string {
  return options.isPackaged
    ? path.resolve(options.resourcesPath, "..", "Helpers", "lume.app")
    : path.join(options.appPath, "build", "bot-computers", "lume.app");
}

/**
 * Find and verify the vendored Lume before Aiden runs it. The checks match
 * `computer-use/binary.ts`: a real (non-symlink) bundle and executable that
 * stay inside the bundle after realpath, the pinned bundle identity, the
 * pinned SHA-256 and size, and the upstream signing requirement. Lume keeps
 * its own signature (it is never re-signed), so packaged and development
 * builds use the same requirement.
 */
export async function resolveLumeInstallation(options: LumeInstallationOptions): Promise<LumeInstallation> {
  const { signal } = options;
  throwIfAborted(signal);
  if (options.platform !== "darwin" || options.arch !== "arm64") {
    throw new BotComputerError("unsupported", "Bot computers need a Mac with Apple silicon.");
  }
  const run = options.run ?? runSystemTool;
  const hash = options.hash ?? hashFile;
  const app = lumeAppPath(options);
  const binary = path.join(app, "Contents", "MacOS", "lume");
  const missing = options.isPackaged
    ? "The packaged computer helper is missing or invalid."
    : "The pinned Lume helper has not been vendored. Run npm run bot-computers:vendor.";
  try {
    const appInfo = await lstat(app);
    if (!appInfo.isDirectory() || appInfo.isSymbolicLink()) throw new Error("not a bundle");
    const binaryInfo = await lstat(binary);
    if (!binaryInfo.isFile() || binaryInfo.isSymbolicLink()) throw new Error("not a regular file");
    await access(binary, constants.R_OK | constants.X_OK);
    if (binaryInfo.size !== LUME_PINS.binaryBytes) throw new Error("size");
  } catch {
    throwIfAborted(signal);
    throw new BotComputerError("lume_failed", missing);
  }
  const resolvedApp = await realpath(app);
  const resolvedBinary = await realpath(binary);
  throwIfAborted(signal);
  if (resolvedBinary !== path.join(resolvedApp, "Contents", "MacOS", "lume")) {
    throw new BotComputerError("lume_failed", "The computer helper escaped its signed bundle.");
  }
  if ((await hash(resolvedBinary, signal)) !== LUME_PINS.binarySha256) {
    throw new BotComputerError("lume_failed", `The computer helper does not match Aiden's pinned Lume ${LUME_PINS.version}.`);
  }
  throwIfAborted(signal);
  const plist = path.join(resolvedApp, "Contents", "Info.plist");
  for (const [key, expected] of [
    ["CFBundleIdentifier", LUME_PINS.bundleIdentifier],
    ["CFBundleVersion", LUME_PINS.bundleVersion],
  ] as const) {
    const result = await run("/usr/bin/plutil", ["-extract", key, "raw", "-o", "-", plist], signal);
    if (result.exitCode !== 0 || result.stdout.trim() !== expected) {
      throw new BotComputerError("lume_failed", "The computer helper has an unexpected bundle identity.");
    }
  }
  const verify = await run(
    "/usr/bin/codesign",
    ["--verify", "--strict", "--deep", "--verbose=2", `-R=${lumeSigningRequirement()}`, resolvedApp],
    signal,
  );
  if (verify.exitCode !== 0) {
    throw new BotComputerError("lume_failed", "The computer helper failed its pinned signing requirement.");
  }
  throwIfAborted(signal);
  return { appPath: resolvedApp, binaryPath: resolvedBinary, invocation: { command: resolvedBinary } };
}
