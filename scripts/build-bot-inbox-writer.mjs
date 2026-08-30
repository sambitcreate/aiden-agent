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
  testing ? "aiden-bot-inbox-writer-test" : "aiden-bot-inbox-writer",
);

if (process.platform !== "darwin" && process.platform !== "linux") {
  console.log("Skipping the Bot inbox writer build on this platform.");
  process.exit(0);
}

await buildNativeCExecutable({
  executeFile,
  repositoryRoot,
  source: path.join(repositoryRoot, "native", "bot-inbox-writer", "main.c"),
  output,
  testing,
  testingDefine: "AIDEN_BOT_INBOX_WRITER_TESTING",
});
console.log(`Built ${path.relative(repositoryRoot, output)}`);
