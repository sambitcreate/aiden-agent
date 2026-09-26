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
  testing ? "aiden-subagent-file-mutator-test" : "aiden-subagent-file-mutator",
);

if (process.platform !== "darwin" && process.platform !== "linux") {
  console.log("Skipping the subagent file-mutator build on this platform.");
  process.exit(0);
}

await buildNativeCExecutable({
  executeFile,
  repositoryRoot,
  source: path.join(repositoryRoot, "native", "subagent-file-mutator", "main.c"),
  output,
  testing,
  testingDefine: "AIDEN_SUBAGENT_FILE_MUTATOR_TESTING",
});
console.log(`Built ${path.relative(repositoryRoot, output)}`);
