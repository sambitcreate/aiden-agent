/* global console, process */

import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { buildNativeCExecutable } from "./native-c-build-core.mjs";

const executeFile = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testing = process.argv.includes("--test");
const output = path.join(
  repositoryRoot,
  "build",
  "native",
  testing ? "aiden-subagent-shell-runner-test" : "aiden-subagent-shell-runner",
);

if (process.platform !== "darwin" && process.platform !== "linux") {
  console.log("Skipping the subagent shell-runner build on this platform.");
  process.exit(0);
}

await buildNativeCExecutable({
  executeFile,
  repositoryRoot,
  source: path.join(repositoryRoot, "native", "subagent-shell-runner", "main.c"),
  output,
  testing,
});
if (testing) {
  await buildNativeCExecutable({
    executeFile,
    repositoryRoot,
    source: path.join(repositoryRoot, "native", "subagent-shell-runner", "setsid-fixture.c"),
    output: path.join(
      repositoryRoot,
      "build",
      "native",
      "aiden-subagent-shell-setsid-fixture",
    ),
    testing: true,
    universalMac: false,
  });
}
console.log(`Built ${path.relative(repositoryRoot, output)}`);
