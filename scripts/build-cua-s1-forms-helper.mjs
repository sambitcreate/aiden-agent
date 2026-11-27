/* global console, process */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  chooseBestXcodeToolchain,
  discoverXcodeDeveloperDirectories,
} from "./apple-developer-tools.mjs";
import { buildSwiftHelperApp } from "./swift-helper-build.mjs";

const required = process.argv.includes("--required");
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packagePath = path.join(projectRoot, "native", "cua-s1-forms");
const scratchPath = path.join(projectRoot, "build", "native-swift-cua-s1-forms");
const moduleCachePath = path.join(projectRoot, "build", "native-module-cache");
const destination = path.join(projectRoot, "build", "native", "Aiden CUA-S1 Forms Helper.app");

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

buildSwiftHelperApp({
  projectRoot,
  packagePath,
  scratchPath,
  moduleCachePath,
  destination,
  executableName: "aiden-cua-s1-forms-helper",
  product: "AidenCuaS1FormsHelper",
  deploymentTarget: "14.4",
  developerDir: toolchain.developerDir,
  label: "CUA-S1 forms helper",
  fail,
});
