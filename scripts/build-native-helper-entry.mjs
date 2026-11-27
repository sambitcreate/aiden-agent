/* global console, process */

import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { buildNativeCExecutable } from "./native-c-build-core.mjs";

const executeFile = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export async function runNativeHelperBuild({
  name,
  source,
  platforms = ["darwin", "linux"],
  testing = process.argv.includes("--test"),
  testingDefine,
  skipMessage,
  after,
}) {
  if (!platforms.includes(process.platform)) {
    console.log(skipMessage);
    process.exit(0);
  }
  const output = path.join(repositoryRoot, "build", "native", testing ? `${name}-test` : name);
  await buildNativeCExecutable({
    executeFile,
    repositoryRoot,
    source: path.join(repositoryRoot, source),
    output,
    testing,
    ...(testingDefine === undefined ? {} : { testingDefine }),
  });
  await after?.({ executeFile, repositoryRoot, testing, output });
  console.log(`Built ${path.relative(repositoryRoot, output)}`);
}
