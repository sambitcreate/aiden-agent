/* global process */

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { signAsync } from "@electron/osx-sign";
import {
  CUA_DRIVER_SHA256,
  CUA_DRIVER_SIGNING_IDENTIFIER,
  CUA_DRIVER_SIGNING_TEAM_ID,
  appleRequirement,
  packagedComputerUsePaths,
} from "./computer-use-signing-pins.mjs";
import {
  LUME_ARTIFACT_PROVENANCE,
  isPackagedLumePath,
  lumeRequirement,
  packagedLumePaths,
} from "./bot-computers-lume-pins.mjs";

const executeFile = promisify(execFile);
const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
export const COMPUTER_USE_ENTITLEMENTS = path.resolve(
  moduleDirectory,
  "..",
  "resources",
  "entitlements.computer-use.plist",
);

const MINIMAL_ENTITLEMENT_HELPERS = Object.freeze([
  "aiden-bot-inbox-writer",
  "aiden-lease-flock",
  "aiden-subagent-file-mutator",
  "aiden-subagent-shell-runner",
  "aiden-subagent-run-store",
  "aiden-worktree-remover",
  "aiden-worktree-file-io",
]);

function minimalEntitlementHelperPaths(app) {
  return new Set(
    MINIMAL_ENTITLEMENT_HELPERS.map((name) => path.resolve(app, "Contents", "Helpers", name)),
  );
}

async function sha256(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function verifyPinnedDriver(driver) {
  const info = await lstat(driver);
  if (!info.isFile() || info.isSymbolicLink() || (await realpath(driver)) !== driver) {
    throw new Error(`The packaged cua-driver is not a regular, non-symlinked file: ${driver}`);
  }
  const actualHash = await sha256(driver);
  if (actualHash !== CUA_DRIVER_SHA256) {
    throw new Error(
      `Packaging changed the pinned cua-driver: expected ${CUA_DRIVER_SHA256}, received ${actualHash}`,
    );
  }
  await executeFile(
    "/usr/bin/codesign",
    [
      "--verify",
      "--strict",
      "--verbose=2",
      `-R=${appleRequirement({
        identifier: CUA_DRIVER_SIGNING_IDENTIFIER,
        teamId: CUA_DRIVER_SIGNING_TEAM_ID,
      })}`,
      driver,
    ],
    { encoding: "utf8", maxBuffer: 1024 * 1024 },
  );
}

/**
 * Lume ships with its upstream Developer ID signature, which carries the
 * virtualization entitlement and the provisioning profile for vm.networking.
 * Check the exact pinned binary and the deep bundle signature before and after
 * Aiden signs everything else, so a re-sign can never slip through.
 */
export async function verifyPinnedLume(appPath, { hash = sha256, execute = executeFile } = {}) {
  const { lumeApp, binary } = packagedLumePaths(appPath);
  const bundle = await lstat(lumeApp);
  if (!bundle.isDirectory() || bundle.isSymbolicLink() || (await realpath(lumeApp)) !== lumeApp) {
    throw new Error(`The packaged lume.app is not a regular, non-symlinked bundle: ${lumeApp}`);
  }
  const info = await lstat(binary);
  if (!info.isFile() || info.isSymbolicLink() || (await realpath(binary)) !== binary) {
    throw new Error(`The packaged Lume binary is not a regular, non-symlinked file: ${binary}`);
  }
  const actualHash = await hash(binary);
  if (info.size !== LUME_ARTIFACT_PROVENANCE.binaryBytes || actualHash !== LUME_ARTIFACT_PROVENANCE.binarySha256) {
    throw new Error(
      `Packaging changed the pinned Lume binary: expected ${LUME_ARTIFACT_PROVENANCE.binarySha256}, received ${actualHash}`,
    );
  }
  await execute(
    "/usr/bin/codesign",
    ["--verify", "--deep", "--strict", "--verbose=2", `-R=${lumeRequirement()}`, lumeApp],
    { encoding: "utf8", maxBuffer: 1024 * 1024 },
  );
}

function ignoredBy(originalIgnore, file) {
  const matchers = Array.isArray(originalIgnore)
    ? originalIgnore
    : originalIgnore
      ? [originalIgnore]
      : [];
  return matchers.some((matcher) => {
    if (typeof matcher === "function") return matcher(file);
    const expression = matcher instanceof RegExp ? matcher : new RegExp(matcher);
    expression.lastIndex = 0;
    return expression.test(file);
  });
}

export function createAidenMacSignOptions(options) {
  const paths = packagedComputerUsePaths(options.app);
  const minimalHelpers = minimalEntitlementHelperPaths(options.app);
  const originalIgnore = options.ignore;
  const originalOptionsForFile = options.optionsForFile;
  return {
    ...options,
    ignore(file) {
      if (path.resolve(file) === paths.driver) return true;
      if (isPackagedLumePath(options.app, file)) return true;
      return ignoredBy(originalIgnore, file);
    },
    optionsForFile(file) {
      const resolved = path.resolve(file);
      const inherited = originalOptionsForFile?.(file) ?? {};
      if (
        resolved === paths.helperApp ||
        resolved.startsWith(`${paths.helperApp}${path.sep}`) ||
        minimalHelpers.has(resolved)
      ) {
        return {
          ...inherited,
          entitlements: COMPUTER_USE_ENTITLEMENTS,
          hardenedRuntime: true,
        };
      }
      return inherited;
    },
  };
}

export async function sign(options) {
  if (process.platform !== "darwin") {
    throw new Error("The Aiden macOS signing hook can only run on macOS.");
  }
  const { driver } = packagedComputerUsePaths(options.app);
  await verifyPinnedDriver(driver);
  await verifyPinnedLume(options.app);
  await signAsync(createAidenMacSignOptions(options));
  await verifyPinnedDriver(driver);
  await verifyPinnedLume(options.app);
}

export default sign;
