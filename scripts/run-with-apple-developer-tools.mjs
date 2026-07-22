/* global console, process */

import { spawnSync } from "node:child_process";
import { findBestFoundationModelsToolchain } from "./apple-developer-tools.mjs";

const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error("Usage: run-with-apple-developer-tools.mjs <xcrun-command> [...args]");
  process.exit(64);
}

const selection = findBestFoundationModelsToolchain();
const explicitFailure = selection.inspected.find(
  (candidate) => candidate.explicit && !candidate.compatible,
);
if (!selection.toolchain) {
  const details = selection.inspected
    .map((candidate) => `${candidate.developerDir}: ${candidate.reason}`)
    .join("\n");
  console.error(
    `Could not find a full Xcode installation with a macOS 26+ SDK and FoundationModelsMacros.${details ? `\n${details}` : ""}`,
  );
  process.exit(1);
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
const result = spawnSync("/usr/bin/xcrun", [command, ...args], {
  env: { ...process.env, DEVELOPER_DIR: toolchain.developerDir },
  stdio: "inherit",
});
if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
