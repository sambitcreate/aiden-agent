/* global console, process */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  chooseBestXcodeToolchain,
  discoverXcodeDeveloperDirectories,
} from "./apple-developer-tools.mjs";

const required = process.argv.includes("--required");
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packagePath = path.join(projectRoot, "native", "cua-s1-forms");
const scratchPath = path.join(projectRoot, "build", "native-swift-cua-s1-forms");
const moduleCachePath = path.join(projectRoot, "build", "native-module-cache");
const helperAppName = "Aiden CUA-S1 Forms Helper.app";
const destination = path.join(projectRoot, "build", "native", helperAppName);
const destinationExecutable = path.join(
  destination,
  "Contents",
  "MacOS",
  "aiden-cua-s1-forms-helper",
);
const infoPlist = path.join(packagePath, "Info.plist");
const product = "AidenCuaS1FormsHelper";

function fail(message, status = 1) {
  fs.rmSync(destination, { force: true, recursive: true });
  if (required) {
    console.error(message);
    process.exit(status || 1);
  }
  console.warn(`${message} The form-fill specialist will be unavailable in this development build.`);
  process.exit(0);
}

if (process.platform !== "darwin") {
  fail("The CUA-S1 forms helper can only be built on macOS.");
}

// The helper needs only Foundation + CoreML: any full Xcode with a macOS SDK is
// sufficient. It deliberately does not require the macOS 26 FoundationModels
// toolchain that apple-developer-tools.mjs validates for the title helper.
const inspected = discoverXcodeDeveloperDirectories().map((candidate) => {
  const developerDir = candidate.developerDir;
  const env = { ...process.env, DEVELOPER_DIR: developerDir };
  const version = spawnSync("/usr/bin/xcodebuild", ["-version"], {
    encoding: "utf8",
    env,
    maxBuffer: 1024 * 1024,
    timeout: 15_000,
  });
  const sdk = spawnSync("/usr/bin/xcrun", ["--sdk", "macosx", "--show-sdk-path"], {
    encoding: "utf8",
    env,
    maxBuffer: 1024 * 1024,
    timeout: 15_000,
  });
  const sdkVersion = spawnSync("/usr/bin/xcrun", ["--sdk", "macosx", "--show-sdk-version"], {
    encoding: "utf8",
    env,
    maxBuffer: 1024 * 1024,
    timeout: 15_000,
  });
  const sdkPath = sdk.status === 0 ? sdk.stdout.trim() : "";
  const match = version.status === 0 ? version.stdout.match(/\d+(?:\.\d+)*/u) : null;
  const sdkMatch = sdkVersion.status === 0 ? sdkVersion.stdout.match(/\d+(?:\.\d+)*/u) : null;
  return {
    ...candidate,
    developerDir,
    compatible: Boolean(sdkPath && fs.existsSync(sdkPath)),
    reason: sdkPath ? undefined : "a macOS SDK is missing",
    xcodeVersion: match?.[0] ?? "0",
    sdkVersion: sdkMatch?.[0] ?? "0",
    isPrerelease: /(?:beta|rc|release candidate)/iu.test(`${developerDir} ${version.stdout}`),
  };
});
const toolchain = chooseBestXcodeToolchain(inspected);
if (!toolchain) {
  fail("Could not find a full Xcode installation with a macOS SDK.");
}
console.log(
  `Apple developer tools: Xcode ${toolchain.xcodeVersion} (${toolchain.buildVersion ?? "unknown"}), macOS SDK ${toolchain.sdkVersion}, ${toolchain.developerDir}`,
);

fs.mkdirSync(scratchPath, { recursive: true });
fs.mkdirSync(moduleCachePath, { recursive: true });
fs.rmSync(destination, { force: true, recursive: true });
fs.mkdirSync(path.dirname(destinationExecutable), { recursive: true });

const helperBuildEnv = {
  ...process.env,
  CLANG_MODULE_CACHE_PATH: moduleCachePath,
  DEVELOPER_DIR: toolchain.developerDir,
  SWIFT_MODULECACHE_PATH: moduleCachePath,
  MACOSX_DEPLOYMENT_TARGET: "14.4",
};
const commonArgs = [
  "swift",
  "build",
  "--disable-sandbox",
  "--package-path",
  packagePath,
  "--scratch-path",
  scratchPath,
  "--configuration",
  "release",
  "--product",
  product,
];

const build = spawnSync("xcrun", commonArgs, {
  cwd: projectRoot,
  env: helperBuildEnv,
  encoding: "utf8",
  stdio: "inherit",
});
if (build.error || build.status !== 0) {
  fail("Could not build the CUA-S1 forms helper.", build.status ?? 1);
}

const binPath = spawnSync("xcrun", [...commonArgs, "--show-bin-path"], {
  cwd: projectRoot,
  env: helperBuildEnv,
  encoding: "utf8",
});
if (binPath.error || binPath.status !== 0) {
  fail("Could not locate the built CUA-S1 forms helper.", binPath.status ?? 1);
}

const source = path.join(binPath.stdout.trim(), product);
if (!fs.existsSync(source)) {
  fail("The CUA-S1 forms helper build completed without an executable.");
}

fs.copyFileSync(source, destinationExecutable);
fs.copyFileSync(infoPlist, path.join(destination, "Contents", "Info.plist"));
fs.chmodSync(destinationExecutable, 0o755);
const sign = spawnSync("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", destination], {
  cwd: projectRoot,
  encoding: "utf8",
  stdio: "inherit",
});
if (sign.error || sign.status !== 0) {
  fail("Could not sign the CUA-S1 forms helper app.", sign.status ?? 1);
}
console.log(`CUA-S1 forms helper: ${path.relative(projectRoot, destination)}`);
