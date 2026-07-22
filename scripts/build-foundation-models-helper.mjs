/* global console, process */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { findBestFoundationModelsToolchain } from "./apple-developer-tools.mjs";

const required = process.argv.includes("--required");
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packagePath = path.join(projectRoot, "native", "apple-foundation-models");
const scratchPath = path.join(projectRoot, "build", "native-swift");
const moduleCachePath = path.join(projectRoot, "build", "native-module-cache");
const helperAppName = "Aiden Foundation Models Helper.app";
const destination = path.join(projectRoot, "build", "native", helperAppName);
const destinationExecutable = path.join(
  destination,
  "Contents",
  "MacOS",
  "aiden-foundation-models-helper",
);
const infoPlist = path.join(packagePath, "Info.plist");
const product = "AidenFoundationModelsHelper";

function fail(message, status = 1) {
  fs.rmSync(destination, { force: true, recursive: true });
  if (required) {
    console.error(message);
    process.exit(status || 1);
  }
  console.warn(`${message} Apple Foundation Models will be unavailable in this development build.`);
  process.exit(0);
}

if (process.platform !== "darwin") {
  fail("The Apple Foundation Models helper can only be built on macOS.");
}

const selection = findBestFoundationModelsToolchain();
const explicitFailure = selection.inspected.find(
  (candidate) => candidate.explicit && !candidate.compatible,
);
if (!selection.toolchain) {
  const detail = explicitFailure
    ? ` DEVELOPER_DIR was rejected because ${explicitFailure.reason}.`
    : "";
  fail(
    `Could not find a full Xcode installation with a macOS 26+ SDK and FoundationModelsMacros.${detail}`,
  );
}
const toolchain = selection.toolchain;
if (explicitFailure) {
  console.warn(
    `Ignoring incompatible DEVELOPER_DIR ${explicitFailure.developerDir}: ${explicitFailure.reason}.`,
  );
}
console.log(
  `Apple developer tools: Xcode ${toolchain.xcodeVersion} (${toolchain.buildVersion}), macOS SDK ${toolchain.sdkVersion}, ${toolchain.developerDir}`,
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
  MACOSX_DEPLOYMENT_TARGET: "26.0",
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
  fail("Could not build the Apple Foundation Models helper.", build.status ?? 1);
}

const binPath = spawnSync("xcrun", [...commonArgs, "--show-bin-path"], {
  cwd: projectRoot,
  env: helperBuildEnv,
  encoding: "utf8",
});
if (binPath.error || binPath.status !== 0) {
  fail("Could not locate the built Apple Foundation Models helper.", binPath.status ?? 1);
}

const source = path.join(binPath.stdout.trim(), product);
if (!fs.existsSync(source)) {
  fail("The Apple Foundation Models helper build completed without an executable.");
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
  fail("Could not sign the Apple Foundation Models helper app.", sign.status ?? 1);
}
console.log(`Apple Foundation Models helper: ${path.relative(projectRoot, destination)}`);
