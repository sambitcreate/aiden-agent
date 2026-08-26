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

const executeFile = promisify(execFile);
const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
export const COMPUTER_USE_ENTITLEMENTS = path.resolve(
  moduleDirectory,
  "..",
  "resources",
  "entitlements.computer-use.plist",
);

const MINIMAL_ENTITLEMENT_HELPERS = Object.freeze([
  "aiden-subagent-file-mutator",
  "aiden-subagent-shell-runner",
  "aiden-subagent-run-store",
  "aiden-worktree-remover",
]);
const AMBIENT_MUSIC_HELPER_APP = "Aiden Ambient Music Helper.app";

function minimalEntitlementHelperPaths(app) {
  return new Set(
    MINIMAL_ENTITLEMENT_HELPERS.map((name) => path.resolve(app, "Contents", "Helpers", name)),
  );
}

function ambientMusicMetallibPath(app) {
  return path.resolve(
    app,
    "Contents",
    "Helpers",
    AMBIENT_MUSIC_HELPER_APP,
    "Contents",
    "MacOS",
    "mlx.metallib",
  );
}

export function ambientMusicMetallibSignArguments(options) {
  if (typeof options.identity !== "string" || options.identity.trim().length === 0) {
    throw new Error("Ambient Music metallib signing requires the selected code-signing identity.");
  }
  const args = ["--sign", options.identity, "--force"];
  if (options.keychain) args.push("--keychain", options.keychain);
  args.push(
    "--timestamp",
    "--options",
    "runtime",
    "--entitlements",
    COMPUTER_USE_ENTITLEMENTS,
    ambientMusicMetallibPath(options.app),
  );
  return args;
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
  const ambientMusicHelper = path.resolve(
    options.app,
    "Contents",
    "Helpers",
    AMBIENT_MUSIC_HELPER_APP,
  );
  const ambientMusicMetallib = ambientMusicMetallibPath(options.app);
  const originalIgnore = options.ignore;
  const originalOptionsForFile = options.optionsForFile;
  return {
    ...options,
    binaries: [...new Set([...(options.binaries ?? []), ambientMusicMetallib])],
    ignore(file) {
      if (path.resolve(file) === paths.driver) return true;
      return ignoredBy(originalIgnore, file);
    },
    optionsForFile(file) {
      const resolved = path.resolve(file);
      const inherited = originalOptionsForFile?.(file) ?? {};
      if (
        resolved === paths.helperApp ||
        resolved.startsWith(`${paths.helperApp}${path.sep}`) ||
        resolved === ambientMusicHelper ||
        resolved.startsWith(`${ambientMusicHelper}${path.sep}`) ||
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
  const ambientMusicMetallib = ambientMusicMetallibPath(options.app);
  await verifyPinnedDriver(driver);
  const metallibInfo = await lstat(ambientMusicMetallib);
  if (
    !metallibInfo.isFile() ||
    metallibInfo.isSymbolicLink() ||
    (await realpath(ambientMusicMetallib)) !== ambientMusicMetallib
  ) {
    throw new Error(
      `The Ambient Music metallib is not a regular, non-symlinked file: ${ambientMusicMetallib}`,
    );
  }
  await executeFile("/usr/bin/codesign", ambientMusicMetallibSignArguments(options), {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  await signAsync(createAidenMacSignOptions(options));
  await verifyPinnedDriver(driver);
}

export default sign;
