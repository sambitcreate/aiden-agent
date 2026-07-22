/* global Buffer, console, process */

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  AIDEN_APP_BUNDLE_ID,
  AIDEN_COMPUTER_USE_BUNDLE_ID,
  AIDEN_SIGNING_TEAM_ID,
  CUA_DRIVER_HELPER_EXECUTABLE,
  CUA_DRIVER_SHA256,
  CUA_DRIVER_SIGNING_IDENTIFIER,
  CUA_DRIVER_SIGNING_TEAM_ID,
  appleRequirement,
  assertCuaDriverArtifactProvenance,
  packagedComputerUsePaths,
} from "./computer-use-signing-pins.mjs";
import { verifyAidenFuses } from "./configure-electron-fuses.mjs";

const executeFile = promisify(execFile);
const modulePath = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(modulePath), "..");
const reviewedProvenancePath = path.join(
  repositoryRoot,
  "resources",
  "computer-use",
  "cua-driver-artifact.json",
);
const reviewedLicenseNoticePath = path.join(
  repositoryRoot,
  "resources",
  "computer-use",
  "LICENSE.cua-driver.md",
);
const reviewedHelperInfoPlistPath = path.join(
  repositoryRoot,
  "native",
  "computer-use-broker",
  "Info.plist",
);
const EXPECTED_COMPUTER_USE_HELPER_TREE = Object.freeze(
  [
    ["Contents", "directory"],
    [path.join("Contents", "Info.plist"), "file"],
    [path.join("Contents", "MacOS"), "directory"],
    [path.join("Contents", "MacOS", "aiden-cua-broker"), "file"],
    [path.join("Contents", "MacOS", "cua-driver"), "file"],
    [path.join("Contents", "Resources"), "directory"],
    [path.join("Contents", "Resources", "LICENSE.cua-driver.md"), "file"],
    [path.join("Contents", "Resources", "cua-driver-artifact.json"), "file"],
    [path.join("Contents", "_CodeSignature"), "directory"],
    [path.join("Contents", "_CodeSignature", "CodeResources"), "file"],
  ]
    .map(([relativePath, type]) => `${type}:${relativePath}`)
    .sort(),
);

async function run(command, args) {
  return executeFile(command, args, {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    timeout: 30_000,
  });
}

async function sha256(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

export async function assertRegularFile(file) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || (await realpath(file)) !== file) {
    throw new Error(`Expected a regular non-symlinked package file: ${file}`);
  }
  return info;
}

export function assertComputerUseExecutableMode(mode, file) {
  const permissions = mode & 0o777;
  if (permissions !== 0o755) {
    throw new Error(
      `Expected Computer Use executable mode 0755 for ${file}, received 0${permissions.toString(8)}`,
    );
  }
}

export function assertByteForByteMatch(actual, expected, file) {
  if (!Buffer.from(actual).equals(Buffer.from(expected))) {
    throw new Error(`Packaged Computer Use resource differs from the reviewed copy: ${file}`);
  }
}

export function assertComputerUseBundleExecutable(executable) {
  if (executable !== CUA_DRIVER_HELPER_EXECUTABLE) {
    throw new Error(
      `Unexpected Computer Use CFBundleExecutable: expected ${CUA_DRIVER_HELPER_EXECUTABLE}, received ${executable}`,
    );
  }
}

export function assertComputerUseMinimumSystemVersion(version) {
  if (version !== "14.4") {
    throw new Error(
      `Unexpected Computer Use minimum macOS version: expected 14.4, received ${version}`,
    );
  }
}

export function assertMatchingHostCodeHashes(bundleCdHash, executableCdHash) {
  const pattern = /^[0-9a-f]{40}$/;
  if (!pattern.test(bundleCdHash) || bundleCdHash !== executableCdHash) {
    throw new Error(
      "The signed Aiden bundle and its live host executable do not share one exact CDHash.",
    );
  }
}

export function assertHardenedRuntime(codeDisplay, target = "signed code") {
  if (!/^CodeDirectory .* flags=0x[0-9a-f]+\([^\n)]*\bruntime\b[^\n)]*\)/m.test(codeDisplay)) {
    throw new Error(`Hardened runtime is not enabled for ${target}`);
  }
}

export function assertComputerUseMachOMinimum(buildDisplay) {
  const platforms = [...buildDisplay.matchAll(/^\s*platform\s+(\S+)\s*$/gm)].map(
    (match) => match[1],
  );
  const minimums = [...buildDisplay.matchAll(/^\s*minos\s+(\S+)\s*$/gm)].map(
    (match) => match[1],
  );
  if (
    platforms.length !== 1 ||
    platforms[0] !== "MACOS" ||
    minimums.length !== 1 ||
    minimums[0] !== "14.4"
  ) {
    throw new Error(
      `Computer Use broker LC_BUILD_VERSION is not pinned to macOS 14.4: ${platforms.join(",")}/${minimums.join(",")}`,
    );
  }
}

async function verifySignature(target, { deep = false, identifier, teamId }) {
  const args = ["--verify"];
  if (deep) args.push("--deep");
  args.push("--strict", "--verbose=2", `-R=${appleRequirement({ identifier, teamId })}`, target);
  await run("/usr/bin/codesign", args);
}

async function readEntitlements(target) {
  const { stdout } = await run("/usr/bin/codesign", [
    "--display",
    "--xml",
    "--entitlements",
    "/dev/stdout",
    target,
  ]);
  return stdout;
}

async function readCodeDisplay(target) {
  const result = await run("/usr/bin/codesign", ["--display", "--verbose=4", target]);
  return `${result.stdout}\n${result.stderr}`;
}

function cdHashFromCodeDisplay(display, target) {
  const match = display.match(/^CDHash=([0-9a-f]{40})$/m);
  if (!match) throw new Error(`Signed code omitted an exact SHA-1 CDHash: ${target}`);
  return match[1];
}

export function assertMinimalComputerUseEntitlements(entitlements) {
  const keys = [...entitlements.matchAll(/<key>([^<]+)<\/key>/g)].map((match) => match[1]);
  if (keys.length > 0) {
    throw new Error(`Computer Use broker has unexpected entitlements: ${keys.join(", ")}`);
  }
}

export function assertElectronEntitlements(entitlements) {
  const expected = [
    "com.apple.security.cs.allow-jit",
    "com.apple.security.cs.allow-unsigned-executable-memory",
    "com.apple.security.cs.disable-library-validation",
  ].sort();
  const actual = [...entitlements.matchAll(/<key>([^<]+)<\/key>/g)].map((match) => match[1]).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Electron executable entitlements differ from the pinned runtime set: ${actual.join(", ")}`,
    );
  }
}

async function readInfoPlistValue(infoPlist, key) {
  const { stdout } = await run("/usr/bin/plutil", ["-extract", key, "raw", "-o", "-", infoPlist]);
  return stdout.trim();
}

async function verifyReviewedResource(packagedFile, reviewedFile) {
  await Promise.all([assertRegularFile(packagedFile), assertRegularFile(reviewedFile)]);
  const [packagedBytes, reviewedBytes] = await Promise.all([
    readFile(packagedFile),
    readFile(reviewedFile),
  ]);
  assertByteForByteMatch(packagedBytes, reviewedBytes, packagedFile);
}

export async function verifyReviewedComputerUseInfoPlist(
  packagedFile,
  reviewedFile = reviewedHelperInfoPlistPath,
) {
  await verifyReviewedResource(packagedFile, reviewedFile);
}

async function collectComputerUseHelperTree(root, directory = root, entries = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name);
    const info = await lstat(absolutePath);
    const relativePath = path.relative(root, absolutePath);
    const type = info.isSymbolicLink()
      ? "symlink"
      : info.isDirectory()
        ? "directory"
        : info.isFile()
          ? "file"
          : "other";
    entries.push(`${type}:${relativePath}`);
    if (info.isDirectory()) {
      await collectComputerUseHelperTree(root, absolutePath, entries);
    }
  }
  return entries;
}

export async function verifyExactComputerUseHelperTree(helperApp) {
  const rootInfo = await lstat(helperApp);
  if (
    !rootInfo.isDirectory() ||
    rootInfo.isSymbolicLink() ||
    (await realpath(helperApp)) !== helperApp
  ) {
    throw new Error(`Expected a regular non-symlinked Computer Use helper: ${helperApp}`);
  }
  const actual = (await collectComputerUseHelperTree(helperApp)).sort();
  if (JSON.stringify(actual) !== JSON.stringify(EXPECTED_COMPUTER_USE_HELPER_TREE)) {
    throw new Error(
      `Computer Use helper tree differs from the reviewed payload: ${actual.join(", ")}`,
    );
  }
}

export async function verifyMacPackage(appPath) {
  if (process.platform !== "darwin") {
    throw new Error("Packaged macOS verification can only run on macOS.");
  }
  const paths = packagedComputerUsePaths(appPath);
  for (const file of [
    paths.broker,
    paths.driver,
    paths.helperInfoPlist,
    paths.helperProvenance,
    paths.helperLicenseNotice,
    paths.outerProvenance,
    paths.outerLicenseNotice,
    paths.electronExecutable,
  ]) {
    await assertRegularFile(file);
  }
  await verifyExactComputerUseHelperTree(paths.helperApp);
  assertComputerUseExecutableMode((await lstat(paths.broker)).mode, paths.broker);
  assertComputerUseExecutableMode((await lstat(paths.driver)).mode, paths.driver);
  if (
    (await readInfoPlistValue(paths.helperInfoPlist, "CFBundleIdentifier")) !==
    AIDEN_COMPUTER_USE_BUNDLE_ID
  ) {
    throw new Error(`Unexpected Computer Use helper bundle identifier in ${paths.helperInfoPlist}`);
  }
  assertComputerUseBundleExecutable(
    await readInfoPlistValue(paths.helperInfoPlist, "CFBundleExecutable"),
  );
  assertComputerUseMinimumSystemVersion(
    await readInfoPlistValue(paths.helperInfoPlist, "LSMinimumSystemVersion"),
  );

  const reviewedProvenance = await readFile(reviewedProvenancePath, "utf8");
  assertCuaDriverArtifactProvenance(JSON.parse(reviewedProvenance));
  await Promise.all([
    verifyReviewedComputerUseInfoPlist(paths.helperInfoPlist),
    verifyReviewedResource(paths.helperProvenance, reviewedProvenancePath),
    verifyReviewedResource(paths.outerProvenance, reviewedProvenancePath),
    verifyReviewedResource(paths.helperLicenseNotice, reviewedLicenseNoticePath),
    verifyReviewedResource(paths.outerLicenseNotice, reviewedLicenseNoticePath),
  ]);

  await verifySignature(paths.app, {
    deep: true,
    identifier: AIDEN_APP_BUNDLE_ID,
    teamId: AIDEN_SIGNING_TEAM_ID,
  });
  await verifySignature(paths.helperApp, {
    deep: true,
    identifier: AIDEN_COMPUTER_USE_BUNDLE_ID,
    teamId: AIDEN_SIGNING_TEAM_ID,
  });
  await verifySignature(paths.broker, {
    identifier: AIDEN_COMPUTER_USE_BUNDLE_ID,
    teamId: AIDEN_SIGNING_TEAM_ID,
  });
  const codeDisplays = new Map(
    await Promise.all(
      [paths.app, paths.helperApp, paths.broker, paths.driver, paths.electronExecutable].map(
        async (target) => [target, await readCodeDisplay(target)],
      ),
    ),
  );
  for (const [target, display] of codeDisplays) assertHardenedRuntime(display, target);
  assertMatchingHostCodeHashes(
    cdHashFromCodeDisplay(codeDisplays.get(paths.app), paths.app),
    cdHashFromCodeDisplay(codeDisplays.get(paths.electronExecutable), paths.electronExecutable),
  );
  const { stdout: brokerBuild, stderr: brokerBuildErrors } = await run("/usr/bin/vtool", [
    "-show-build",
    paths.broker,
  ]);
  assertComputerUseMachOMinimum(`${brokerBuild}\n${brokerBuildErrors}`);

  const driverHash = await sha256(paths.driver);
  if (driverHash !== CUA_DRIVER_SHA256) {
    throw new Error(
      `Packaged cua-driver hash mismatch: expected ${CUA_DRIVER_SHA256}, received ${driverHash}`,
    );
  }
  await verifySignature(paths.driver, {
    identifier: CUA_DRIVER_SIGNING_IDENTIFIER,
    teamId: CUA_DRIVER_SIGNING_TEAM_ID,
  });

  assertMinimalComputerUseEntitlements(await readEntitlements(paths.helperApp));
  assertMinimalComputerUseEntitlements(await readEntitlements(paths.broker));
  assertElectronEntitlements(await readEntitlements(paths.electronExecutable));
  await verifyAidenFuses(paths.app);
  console.log(`Verified hardened macOS package: ${paths.app}`);
}

async function discoverPackagedApp() {
  const releaseDirectory = path.join(repositoryRoot, "release");
  const candidates = [];
  for (const entry of await readdir(releaseDirectory, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith("mac")) continue;
    const candidate = path.join(releaseDirectory, entry.name, "Aiden Agent.app");
    try {
      if ((await lstat(candidate)).isDirectory()) candidates.push(candidate);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  if (candidates.length !== 1) {
    throw new Error(
      `Expected exactly one unpacked Aiden macOS package, found ${candidates.length}. Pass an explicit .app path.`,
    );
  }
  return candidates[0];
}

export async function verifyAfterSign(context) {
  if (context.electronPlatformName !== "darwin") return;
  await verifyMacPackage(
    path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`),
  );
}

export default verifyAfterSign;

if (process.argv[1] && path.resolve(process.argv[1]) === modulePath) {
  await verifyMacPackage(
    process.argv[2] ? path.resolve(process.argv[2]) : await discoverPackagedApp(),
  );
}
