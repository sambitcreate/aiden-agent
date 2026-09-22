/* global process, URL */

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptName = process.argv[2];
if (!scriptName || process.argv.length !== 3) {
  throw new Error("Usage: node scripts/run-registered-tests-with-coverage.mjs <package-script>");
}

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const packageJson = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
const registeredCommand = packageJson.scripts?.[scriptName];
if (typeof registeredCommand !== "string") {
  throw new Error(`Unknown package script: ${scriptName}`);
}

const tokens = registeredCommand.trim().split(/\s+/u);
if (tokens[0] !== "tsx" || tokens[1] !== "--test" || tokens.length < 3) {
  throw new Error(`${scriptName} must be a direct "tsx --test <files...>" command`);
}
const testFiles = tokens.slice(2);
for (const testFile of testFiles) {
  if (!/^[a-zA-Z0-9_./-]+\.test\.(?:ts|tsx|mjs)$/u.test(testFile)) {
    throw new Error(`${scriptName} contains an unsupported test argument: ${testFile}`);
  }
}

const require = createRequire(import.meta.url);
const tsxCli = require.resolve("tsx/cli");
const result = spawnSync(
  process.execPath,
  [tsxCli, "--test", "--experimental-test-coverage", ...testFiles],
  {
    cwd: projectRoot,
    env: process.env,
    stdio: "inherit",
  },
);

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
