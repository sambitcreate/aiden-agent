/* global console, process */

import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const executeFile = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testing = process.argv.includes("--test");
const output = path.join(root, "build", "native", testing
  ? "aiden-worktree-file-io-test" : "aiden-worktree-file-io");

if (process.platform !== "darwin") {
  console.log("Skipping the macOS managed-worktree file helper build on this platform.");
  process.exit(0);
}

await mkdir(path.dirname(output), { recursive: true });
await executeFile("/usr/bin/xcrun", [
  "--sdk", "macosx",
  "clang", "-std=c17", "-Wall", "-Wextra", "-Werror", "-O2",
  "-Wno-deprecated-declarations", "-mmacosx-version-min=14.4",
  ...(testing ? ["-DAIDEN_WORKTREE_FILE_IO_TESTING=1"] : ["-arch", "arm64", "-arch", "x86_64"]),
  path.join(root, "native", "worktree-file-io", "main.c"),
  "-o", output,
], {
  cwd: root,
  env: {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", LC_ALL: "C",
    ...(process.env.SDKROOT ? { SDKROOT: process.env.SDKROOT } : {}),
  },
  maxBuffer: 1024 * 1024,
  timeout: 120_000,
});
console.log(`Built ${path.relative(root, output)}`);
