/* global console, process */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { findBestFoundationModelsToolchain } from "./apple-developer-tools.mjs";
import { buildSwiftHelperApp } from "./swift-helper-build.mjs";

const required = process.argv.includes("--required");
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packagePath = path.join(projectRoot, "native", "apple-foundation-models");
const scratchPath = path.join(projectRoot, "build", "native-swift");
const moduleCachePath = path.join(projectRoot, "build", "native-module-cache");
const destination = path.join(projectRoot, "build", "native", "Aiden Foundation Models Helper.app");

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

buildSwiftHelperApp({
  projectRoot,
  packagePath,
  scratchPath,
  moduleCachePath,
  destination,
  executableName: "aiden-foundation-models-helper",
  product: "AidenFoundationModelsHelper",
  deploymentTarget: "26.0",
  developerDir: toolchain.developerDir,
  label: "Apple Foundation Models helper",
  fail,
});
