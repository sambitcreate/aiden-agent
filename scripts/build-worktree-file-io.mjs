/* global console, process */

import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { compileNativeC } from "./native-c-build-core.mjs";

const executeFile = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testing = process.argv.includes("--test");
const output = path.join(root, "build", "native", testing
  ? "aiden-worktree-file-io-test" : "aiden-worktree-file-io");

if (process.platform !== "darwin") {
  console.log("Skipping the macOS managed-worktree file helper build on this platform.");
  process.exit(0);
}

const source = path.join(root, "native", "worktree-file-io", "main.c");
await compileNativeC({
  executeFile,
  executable: "/usr/bin/xcrun",
  args: [
    "--sdk", "macosx",
    "clang", "-std=c17", "-Wall", "-Wextra", "-Werror", "-O2",
    "-Wno-deprecated-declarations", "-mmacosx-version-min=14.4",
    ...(testing ? ["-DAIDEN_WORKTREE_FILE_IO_TESTING=1"] : ["-arch", "arm64", "-arch", "x86_64"]),
    source,
    "-o", output,
  ],
  cwd: root,
  env: {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", LC_ALL: "C",
    ...(process.env.SDKROOT ? { SDKROOT: process.env.SDKROOT } : {}),
  },
  source,
  output,
});
console.log(`Built ${path.relative(root, output)}`);
