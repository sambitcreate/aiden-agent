import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { createReadStream } from "node:fs";
import { access, lstat, realpath } from "node:fs/promises";
import path from "node:path";
import {
  CUA_DRIVER_BROKER_BUNDLE_ID,
  CUA_DRIVER_BROKER_EXECUTABLE,
  CUA_DRIVER_HOST_BUNDLE_ID,
  CUA_DRIVER_VERSION,
  CuaDriverError,
  type CuaDriverInvocation,
  buildCuaDriverEnvironment,
} from "./contract.js";
import { runCuaDriverCommand } from "./process.js";

// Security pins are compiled into Aiden. The packaged artifact JSON is release
// provenance for humans/build tooling, never runtime security authority.
const CUA_DRIVER_BINARY_SHA256 = "87c7e782e69703d95524e4ceb7ceba03c8a159caabf1f1ce2c118eade7d2a5ec";
const CUA_DRIVER_UPSTREAM_SIGNING_IDENTIFIER = "cua-driver";
const CUA_DRIVER_UPSTREAM_SIGNING_TEAM_ID = "YCK386LBJ7";

/**
 * The pinned upstream driver's identity, for a copy Aiden checks somewhere
 * other than this Mac: a Bot computer's guest verifies the copied
 * executable against these before it is put in place (docs/bot-computers.md).
 */
export const CUA_DRIVER_UPSTREAM_PIN = Object.freeze({
  version: CUA_DRIVER_VERSION,
  binarySha256: CUA_DRIVER_BINARY_SHA256,
  signingRequirement: `anchor apple generic and identifier "${CUA_DRIVER_UPSTREAM_SIGNING_IDENTIFIER}" and certificate leaf[subject.OU] = "${CUA_DRIVER_UPSTREAM_SIGNING_TEAM_ID}"`,
});

export interface CuaDriverPathOptions {
  appPath: string;
  isPackaged: boolean;
  platform: NodeJS.Platform;
  resourcesPath: string;
}

export interface CuaDriverInstallation {
  brokerAppPath: string;
  invocation: CuaDriverInvocation;
}

interface CodeSigningDescription {
  executable?: string;
  identifier?: string;
  teamIdentifier?: string;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new CuaDriverError("cancelled", "Computer Use verification was cancelled.");
  }
}

function preserveCancellation(error: unknown): never {
  if (error instanceof CuaDriverError && error.code === "cancelled") throw error;
  throw new CuaDriverError("identity_verification_failed", "A code signature is unavailable.");
}

async function hashFile(filePath: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    throwIfAborted(signal);
    hash.update(chunk);
  }
  throwIfAborted(signal);
  return hash.digest("hex");
}

async function verifyRegularExecutable(
  candidate: string,
  message: string,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  try {
    const info = await lstat(candidate);
    throwIfAborted(signal);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("not a regular file");
    await access(candidate, constants.R_OK | constants.X_OK);
    throwIfAborted(signal);
  } catch {
    throwIfAborted(signal);
    throw new CuaDriverError("driver_missing", message);
  }
}

function signingRequirement(identifier: string, teamIdentifier: string): string {
  return `anchor apple generic and identifier "${identifier}" and certificate leaf[subject.OU] = "${teamIdentifier}"`;
}

function parseCodeSigningDescription(output: string): CodeSigningDescription {
  const result: CodeSigningDescription = {};
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith("Executable=")) result.executable = line.slice("Executable=".length);
    else if (line.startsWith("Identifier=")) result.identifier = line.slice("Identifier=".length);
    else if (line.startsWith("TeamIdentifier=")) {
      const value = line.slice("TeamIdentifier=".length);
      if (value !== "not set") result.teamIdentifier = value;
    }
  }
  return result;
}

async function describeCode(target: string, signal?: AbortSignal): Promise<CodeSigningDescription> {
  const result = await runCuaDriverCommand(
    { command: "/usr/bin/codesign" },
    ["--display", "--verbose=4", target],
    { env: buildCuaDriverEnvironment(process.env), signal, timeoutMs: 6_000 },
  ).catch(preserveCancellation);
  return parseCodeSigningDescription(`${result.stdout}\n${result.stderr}`);
}

export function codesignVerifyArguments(target: string, requirement?: string): string[] {
  if (/^\+[1-9]\d*$/.test(target)) {
    // macOS 27 rejects --strict/--verbose and explicit requirements for live
    // process disk representations. Callers separately compare the displayed
    // identifier, Team ID, and executable before requesting dynamic validity.
    return ["--verify", target];
  }
  const args = ["--verify", "--strict", "--verbose=2"];
  if (requirement) args.push(`-R=${requirement}`);
  args.push(target);
  return args;
}

async function verifyCode(
  target: string,
  requirement?: string,
  signal?: AbortSignal,
): Promise<void> {
  await runCuaDriverCommand(
    { command: "/usr/bin/codesign" },
    codesignVerifyArguments(target, requirement),
    {
      env: buildCuaDriverEnvironment(process.env),
      signal,
      timeoutMs: 6_000,
    },
  );
}

async function currentAidenSigningTeam(signal?: AbortSignal): Promise<string> {
  const target = `+${process.pid}`;
  const description = await describeCode(target, signal);
  if (
    description.identifier !== CUA_DRIVER_HOST_BUNDLE_ID ||
    !description.teamIdentifier ||
    !/^[A-Z0-9]{10}$/.test(description.teamIdentifier)
  ) {
    throw new CuaDriverError(
      "host_identity_invalid",
      "Computer Use requires a signed packaged build of Aiden.",
    );
  }
  await verifyCode(target, undefined, signal).catch((error: unknown) => {
    if (error instanceof CuaDriverError && error.code === "cancelled") throw error;
    throw new CuaDriverError(
      "host_identity_invalid",
      "Aiden's running code signature could not be verified.",
    );
  });
  return description.teamIdentifier;
}

/** Verify the exact, already-spawned bridge process before accepting readiness. */
export async function verifyCuaDriverBridgeProcess(
  pid: number,
  expectedExecutable: string,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  if (!Number.isSafeInteger(pid) || pid <= 1) {
    throw new CuaDriverError("bridge_identity_invalid", "Computer Use started an invalid bridge.");
  }
  const expectedPath = await realpath(expectedExecutable).catch(() => {
    throw new CuaDriverError("bridge_identity_invalid", "The Computer Use bridge disappeared.");
  });
  throwIfAborted(signal);
  const teamIdentifier = await currentAidenSigningTeam(signal);
  const target = `+${pid}`;
  const description = await describeCode(target, signal);
  const actualPath = description.executable
    ? await realpath(description.executable).catch(() => "")
    : "";
  throwIfAborted(signal);
  if (
    actualPath !== expectedPath ||
    description.identifier !== CUA_DRIVER_BROKER_BUNDLE_ID ||
    description.teamIdentifier !== teamIdentifier
  ) {
    throw new CuaDriverError(
      "bridge_identity_invalid",
      "The running Computer Use bridge did not match Aiden's signed helper.",
    );
  }
  await verifyCode(target, undefined, signal).catch((error: unknown) => {
    if (error instanceof CuaDriverError && error.code === "cancelled") throw error;
    throw new CuaDriverError(
      "bridge_identity_invalid",
      "The running Computer Use bridge signature could not be verified.",
    );
  });
}

function vendoredHelperAppPath(options: CuaDriverPathOptions): string {
  return options.isPackaged
    ? path.resolve(options.resourcesPath, "..", "Helpers", "CuaDriver.app")
    : path.join(options.appPath, "build", "computer-use", "CuaDriver.app");
}

/**
 * The cua-driver licence notice the vendor step puts inside the helper
 * bundle (`Contents/Resources/LICENSE.cua-driver.md`, which the package
 * verifier requires). A copy of the driver made elsewhere, such as in a Bot
 * computer's guest, carries this notice beside it.
 */
export function vendoredCuaDriverNoticePath(options: CuaDriverPathOptions): string {
  return path.join(vendoredHelperAppPath(options), "Contents", "Resources", "LICENSE.cua-driver.md");
}

/**
 * The vendored, untouched upstream `cua-driver` executable inside Aiden's
 * helper bundle, after the same hash and signing-requirement checks the
 * helper gets. Bot computers copy this one file into a guest; the broker is
 * never copied, since it authenticates the Aiden process it runs under.
 */
export async function resolveVendoredCuaDriverExecutable(
  options: CuaDriverPathOptions,
  signal?: AbortSignal,
): Promise<string> {
  throwIfAborted(signal);
  if (options.platform !== "darwin") {
    throw new CuaDriverError("unsupported_platform", "The guest driver is copied only from a Mac.");
  }
  const brokerAppPath = vendoredHelperAppPath(options);
  const driverPath = path.join(brokerAppPath, "Contents", "MacOS", "cua-driver");
  const missing = options.isPackaged
    ? "The packaged cua-driver executable is missing or invalid."
    : "The pinned cua-driver has not been vendored. Run npm run computer-use:vendor.";
  // As for the helper itself: a symlinked bundle is never the vendored one.
  try {
    const appInfo = await lstat(brokerAppPath);
    throwIfAborted(signal);
    if (!appInfo.isDirectory() || appInfo.isSymbolicLink()) throw new Error("invalid app");
  } catch {
    throwIfAborted(signal);
    throw new CuaDriverError("driver_missing", missing);
  }
  await verifyRegularExecutable(driverPath, missing, signal);
  const resolvedApp = await realpath(brokerAppPath);
  const resolvedDriver = await realpath(driverPath);
  if (!resolvedDriver.startsWith(`${resolvedApp}${path.sep}Contents${path.sep}MacOS${path.sep}`)) {
    throw new CuaDriverError("invalid_driver_path", "The cua-driver executable escaped its helper bundle.");
  }
  if ((await hashFile(resolvedDriver, signal)) !== CUA_DRIVER_BINARY_SHA256) {
    throw new CuaDriverError(
      "driver_integrity_failed",
      `The cua-driver executable does not match Aiden's pinned ${CUA_DRIVER_VERSION} release.`,
    );
  }
  await verifyCode(resolvedDriver, CUA_DRIVER_UPSTREAM_PIN.signingRequirement, signal).catch((error: unknown) => {
    if (error instanceof CuaDriverError && error.code === "cancelled") throw error;
    throw new CuaDriverError(
      "driver_integrity_failed",
      "The cua-driver executable failed its pinned signing requirement.",
    );
  });
  return resolvedDriver;
}

export async function resolveCuaDriverInstallation(
  options: CuaDriverPathOptions,
  signal?: AbortSignal,
): Promise<CuaDriverInstallation> {
  throwIfAborted(signal);
  if (options.platform !== "darwin") {
    throw new CuaDriverError(
      "unsupported_platform",
      "Aiden Computer Use is not available on this platform.",
    );
  }
  const brokerAppPath = options.isPackaged
    ? path.resolve(options.resourcesPath, "..", "Helpers", "CuaDriver.app")
    : path.join(options.appPath, "build", "computer-use", "CuaDriver.app");
  const executableDirectory = path.join(brokerAppPath, "Contents", "MacOS");
  const driverPath = path.join(executableDirectory, "cua-driver");
  const brokerPath = path.join(executableDirectory, CUA_DRIVER_BROKER_EXECUTABLE);
  const infoPlistPath = path.join(brokerAppPath, "Contents", "Info.plist");
  try {
    const appInfo = await lstat(brokerAppPath);
    throwIfAborted(signal);
    if (!appInfo.isDirectory() || appInfo.isSymbolicLink()) throw new Error("invalid app");
  } catch {
    throwIfAborted(signal);
    throw new CuaDriverError(
      "driver_missing",
      options.isPackaged
        ? "The packaged Aiden Computer Use helper is missing or invalid."
        : "The pinned Computer Use helper has not been built. Run npm run computer-use:vendor.",
    );
  }
  await verifyRegularExecutable(
    brokerPath,
    "The Aiden Computer Use broker executable is missing or invalid.",
    signal,
  );
  await verifyRegularExecutable(
    driverPath,
    "The pinned cua-driver executable is missing or invalid.",
    signal,
  );
  const resolvedApp = await realpath(brokerAppPath);
  const resolvedDriver = await realpath(driverPath);
  const resolvedBroker = await realpath(brokerPath);
  throwIfAborted(signal);
  for (const executable of [resolvedDriver, resolvedBroker]) {
    if (!executable.startsWith(`${resolvedApp}${path.sep}Contents${path.sep}MacOS${path.sep}`)) {
      throw new CuaDriverError(
        "invalid_driver_path",
        "The Computer Use executable escaped its signed helper bundle.",
      );
    }
  }

  const plist = await runCuaDriverCommand(
    { command: "/usr/bin/plutil" },
    ["-extract", "CFBundleIdentifier", "raw", "-o", "-", infoPlistPath],
    { env: buildCuaDriverEnvironment(process.env), signal, timeoutMs: 6_000 },
  ).catch((error: unknown) => {
    if (error instanceof CuaDriverError && error.code === "cancelled") throw error;
    throw new CuaDriverError("driver_integrity_failed", "The helper bundle metadata is invalid.");
  });
  if (plist.stdout.trim() !== CUA_DRIVER_BROKER_BUNDLE_ID) {
    throw new CuaDriverError(
      "driver_integrity_failed",
      "The Computer Use helper has an unexpected bundle identity.",
    );
  }

  if ((await hashFile(resolvedDriver, signal)) !== CUA_DRIVER_BINARY_SHA256) {
    throw new CuaDriverError(
      "driver_integrity_failed",
      `The cua-driver executable does not match Aiden's pinned ${CUA_DRIVER_VERSION} release.`,
    );
  }
  await verifyCode(
    resolvedDriver,
    signingRequirement(CUA_DRIVER_UPSTREAM_SIGNING_IDENTIFIER, CUA_DRIVER_UPSTREAM_SIGNING_TEAM_ID),
    signal,
  ).catch((error: unknown) => {
    if (error instanceof CuaDriverError && error.code === "cancelled") throw error;
    throw new CuaDriverError(
      "driver_integrity_failed",
      "The cua-driver executable failed its pinned signing requirement.",
    );
  });

  if (options.isPackaged) {
    const teamIdentifier = await currentAidenSigningTeam(signal);
    const helperRequirement = signingRequirement(CUA_DRIVER_BROKER_BUNDLE_ID, teamIdentifier);
    await Promise.all([
      verifyCode(resolvedApp, helperRequirement, signal),
      verifyCode(resolvedBroker, helperRequirement, signal),
    ]).catch(() => {
      throwIfAborted(signal);
      throw new CuaDriverError(
        "driver_integrity_failed",
        "The Aiden Computer Use helper did not match Aiden's signing identity.",
      );
    });
  } else {
    // Development helpers may be ad-hoc signed so packaging can be exercised.
    // The runtime bridge check still fails closed outside a signed production app.
    await Promise.all([
      verifyCode(resolvedApp, undefined, signal),
      verifyCode(resolvedBroker, undefined, signal),
    ]).catch(() => {
      throwIfAborted(signal);
      throw new CuaDriverError(
        "driver_integrity_failed",
        "The Aiden Computer Use helper signature is invalid.",
      );
    });
  }

  return { brokerAppPath: resolvedApp, invocation: { command: resolvedBroker } };
}
