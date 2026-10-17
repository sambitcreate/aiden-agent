/* global console, process */

import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { buildNativeCExecutable } from "./native-c-build-core.mjs";

const executeFile = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (process.platform !== "darwin" && process.platform !== "linux") {
  console.log("Skipping the lease flock helper build on this platform.");
  process.exit(0);
}
const output = path.join(repositoryRoot, "build/native/aiden-lease-flock");
await buildNativeCExecutable({
  executeFile,
  repositoryRoot,
  source: path.join(repositoryRoot, "native/lease-flock/main.c"),
  output,
  testing: false,
});
console.log(`Built ${path.relative(repositoryRoot, output)}`);
