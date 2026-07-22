/* global process */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const FOUNDATION_MODELS_MACRO_PATHS = [
  path.join(
    "Platforms",
    "MacOSX.platform",
    "Developer",
    "usr",
    "lib",
    "swift",
    "host",
    "plugins",
    "libFoundationModelsMacros.dylib",
  ),
  path.join(
    "Toolchains",
    "XcodeDefault.xctoolchain",
    "usr",
    "lib",
    "swift",
    "host",
    "plugins",
    "libFoundationModelsMacros.dylib",
  ),
];

function run(command, args, env = process.env) {
  return spawnSync(command, args, {
    encoding: "utf8",
    env,
    maxBuffer: 1024 * 1024,
    timeout: 5_000,
  });
}

function successfulOutput(result) {
  return !result.error && result.status === 0 ? result.stdout.trim() : "";
}

export function normalizeDeveloperDirectory(value) {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const candidate = path.resolve(value.trim());
  return candidate.toLocaleLowerCase().endsWith(".app")
    ? path.join(candidate, "Contents", "Developer")
    : candidate;
}

function addCandidate(candidates, value, source, explicit = false) {
  const developerDir = normalizeDeveloperDirectory(value);
  if (!developerDir) return;
  const existing = candidates.get(developerDir);
  if (!existing || (explicit && !existing.explicit)) {
    candidates.set(developerDir, { developerDir, explicit, source });
  }
}

function addApplicationCandidates(candidates, root) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if ((entry.isDirectory() || entry.isSymbolicLink()) && /^Xcode.*\.app$/iu.test(entry.name)) {
      addCandidate(candidates, path.join(root, entry.name), root);
    }
  }
}

export function discoverXcodeDeveloperDirectories(options = {}) {
  const env = options.env ?? process.env;
  const execute = options.run ?? run;
  const candidates = new Map();

  addCandidate(candidates, env.DEVELOPER_DIR, "DEVELOPER_DIR", true);

  const active = successfulOutput(execute("/usr/bin/xcode-select", ["-p"], env));
  addCandidate(candidates, active, "xcode-select");

  const applicationRoots = options.applicationRoots ?? [
    "/Applications",
    path.join(options.home ?? os.homedir(), "Applications"),
  ];
  for (const root of applicationRoots) addApplicationCandidates(candidates, root);

  const spotlight = successfulOutput(
    execute("/usr/bin/mdfind", ['kMDItemCFBundleIdentifier == "com.apple.dt.Xcode"'], env),
  );
  for (const bundle of spotlight.split("\n")) {
    addCandidate(candidates, bundle, "Spotlight");
  }

  return [...candidates.values()];
}

function parseVersion(value) {
  const match = value.match(/\d+(?:\.\d+)*/u);
  return match ? match[0] : null;
}

function compareVersions(left, right) {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  const count = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < count; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export function inspectXcodeToolchain(candidate, options = {}) {
  const execute = options.run ?? run;
  let developerDir;
  try {
    developerDir = fs.realpathSync(candidate.developerDir);
    if (!fs.statSync(developerDir).isDirectory()) throw new Error("not a directory");
  } catch {
    return { ...candidate, compatible: false, reason: "developer directory is unavailable" };
  }

  if (
    !FOUNDATION_MODELS_MACRO_PATHS.some((relativePath) =>
      fs.existsSync(path.join(developerDir, relativePath)),
    )
  ) {
    return {
      ...candidate,
      developerDir,
      compatible: false,
      reason: "FoundationModelsMacros compiler plugin is missing",
    };
  }

  const env = { ...(options.env ?? process.env), DEVELOPER_DIR: developerDir };
  const xcodeBuild = execute("/usr/bin/xcodebuild", ["-version"], env);
  const xcodeOutput = successfulOutput(xcodeBuild);
  const xcodeVersion = parseVersion(xcodeOutput);
  if (!xcodeVersion || compareVersions(xcodeVersion, "26.0") < 0) {
    return {
      ...candidate,
      developerDir,
      compatible: false,
      reason: "Xcode 26 or newer is unavailable",
    };
  }

  const sdkPath = successfulOutput(
    execute("/usr/bin/xcrun", ["--sdk", "macosx", "--show-sdk-path"], env),
  );
  const sdkVersionOutput = successfulOutput(
    execute("/usr/bin/xcrun", ["--sdk", "macosx", "--show-sdk-version"], env),
  );
  const sdkVersion = parseVersion(sdkVersionOutput);
  if (
    !sdkPath ||
    !sdkVersion ||
    compareVersions(sdkVersion, "26.0") < 0 ||
    !fs.existsSync(
      path.join(sdkPath, "System", "Library", "Frameworks", "FoundationModels.framework"),
    )
  ) {
    return {
      ...candidate,
      developerDir,
      compatible: false,
      reason: "a macOS 26 or newer Foundation Models SDK is missing",
    };
  }

  const buildVersion = xcodeOutput.match(/^Build version\s+(.+)$/mu)?.[1]?.trim() ?? "unknown";
  return {
    ...candidate,
    buildVersion,
    compatible: true,
    developerDir,
    isPrerelease: /(?:beta|rc|release candidate)/iu.test(`${developerDir} ${xcodeOutput}`),
    sdkPath,
    sdkVersion,
    xcodeVersion,
  };
}

export function chooseBestXcodeToolchain(toolchains) {
  const compatible = toolchains.filter((toolchain) => toolchain.compatible);
  compatible.sort((left, right) => {
    if (left.explicit !== right.explicit) return left.explicit ? -1 : 1;
    const xcodeDifference = compareVersions(right.xcodeVersion, left.xcodeVersion);
    if (xcodeDifference !== 0) return xcodeDifference;
    const sdkDifference = compareVersions(right.sdkVersion, left.sdkVersion);
    if (sdkDifference !== 0) return sdkDifference;
    if (left.isPrerelease !== right.isPrerelease) return left.isPrerelease ? 1 : -1;
    if (left.source !== right.source) {
      if (left.source === "xcode-select") return -1;
      if (right.source === "xcode-select") return 1;
    }
    return left.developerDir.localeCompare(right.developerDir);
  });
  return compatible[0] ?? null;
}

export function findBestFoundationModelsToolchain(options = {}) {
  const candidates = discoverXcodeDeveloperDirectories(options);
  const inspected = candidates.map((candidate) => inspectXcodeToolchain(candidate, options));
  return { inspected, toolchain: chooseBestXcodeToolchain(inspected) };
}
