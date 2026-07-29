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
  testing ? "aiden-worktree-remover-test" : "aiden-worktree-remover",
);

if (process.platform !== "darwin") {
  console.log("Skipping the macOS managed-worktree remover build on this platform.");
  process.exit(0);
}

await mkdir(path.dirname(output), { recursive: true });
const args = [
  "clang",
  "-std=c17",
  "-Wall",
  "-Wextra",
  "-Werror",
  "-O2",
  "-mmacosx-version-min=14.4",
  ...(testing ? ["-DAIDEN_REMOVER_TESTING=1"] : ["-arch", "arm64", "-arch", "x86_64"]),
  path.join(repositoryRoot, "native", "worktree-remover", "main.c"),
  "-o",
  output,
];
await executeFile("/usr/bin/xcrun", args, {
  cwd: repositoryRoot,
  env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", LC_ALL: "C" },
  maxBuffer: 1024 * 1024,
  timeout: 120_000,
});
console.log(`Built ${path.relative(repositoryRoot, output)}`);
