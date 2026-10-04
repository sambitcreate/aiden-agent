/* global console, process */
/**
 * Builds every native C helper concurrently. Each builder skips its compile
 * when the output's fingerprint stamp still matches (see native-c-build-core),
 * so a warm run costs a few hashes instead of eight serial compiles.
 */
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const executeFile = promisify(execFile);
const scripts = path.dirname(fileURLToPath(import.meta.url));

export const NATIVE_C_HELPER_BUILDERS = Object.freeze([
  "build-global-shortcuts-portal.mjs",
  "build-secret-service-authority.mjs",
  "build-worktree-remover.mjs",
  "build-worktree-file-io.mjs",
  "build-bot-inbox-writer.mjs",
  "build-subagent-run-store.mjs",
  "build-subagent-file-mutator.mjs",
  "build-subagent-shell-runner.mjs",
]);

const results = await Promise.allSettled(NATIVE_C_HELPER_BUILDERS.map(async (builder) => {
  const { stdout, stderr } = await executeFile(process.execPath, [path.join(scripts, builder)], {
    maxBuffer: 4 * 1024 * 1024,
  });
  process.stdout.write(stdout);
  process.stderr.write(stderr);
}));
const failures = results.flatMap((result, index) => result.status === "rejected"
  ? [`${NATIVE_C_HELPER_BUILDERS[index]}: ${result.reason?.stderr || result.reason?.message || result.reason}`]
  : []);
if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
