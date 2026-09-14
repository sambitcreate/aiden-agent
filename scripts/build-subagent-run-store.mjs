/* global console, process */

import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const executeFile = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testing = process.argv.includes("--test");
const output = path.join(
  repositoryRoot,
  "build",
  "native",
  testing ? "aiden-subagent-run-store-test" : "aiden-subagent-run-store",
);

if (!["darwin", "linux"].includes(process.platform)) throw new Error("Subagent run storage requires macOS or Linux.");

await mkdir(path.dirname(output), { recursive: true });
const args = [
  ...(process.platform === "darwin" ? ["clang"] : []),
  "-std=c17",
  "-Wall",
  "-Wextra",
  "-Werror",
  "-O2",
  ...(process.platform === "darwin" ? ["-mmacosx-version-min=14.4"] : []),
  ...(testing ? ["-DAIDEN_SUBAGENT_RUN_STORE_TESTING=1"] : process.platform === "darwin" ? ["-arch", "arm64", "-arch", "x86_64"] : []),
  path.join(repositoryRoot, "native", "subagent-run-store", "main.c"),
  "-o",
  output,
];
await executeFile(process.platform === "darwin" ? "/usr/bin/xcrun" : "cc", args, {
  cwd: repositoryRoot,
  env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", LC_ALL: "C", ...(process.env.DEVELOPER_DIR ? { DEVELOPER_DIR: process.env.DEVELOPER_DIR } : {}) },
  maxBuffer: 1024 * 1024,
  timeout: 120_000,
});
console.log(`Built ${path.relative(repositoryRoot, output)}`);
