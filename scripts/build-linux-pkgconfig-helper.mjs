/* global console, process */
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { compileNativeC, nativeCCompileInvocation } from "./native-c-build-core.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const execute = promisify(execFile);

export async function buildLinuxPkgConfigHelper({
  name,
  sourceDirectory,
  pkgConfigPackage,
  skipMessage,
}) {
  if (process.platform !== "linux") {
    console.log(skipMessage);
    return;
  }
  const relativeOutput = `build/native/${name}`;
  const output = path.join(root, relativeOutput);
  const source = path.join(root, "native", sourceDirectory, "main.c");
  const invocation = await nativeCCompileInvocation({ source, output });
  const { stdout } = await execute("/usr/bin/pkg-config", ["--cflags", "--libs", pkgConfigPackage], {
    env: invocation.env,
    timeout: 10_000,
    maxBuffer: 16_384,
  });
  await compileNativeC({
    executeFile: execute,
    executable: invocation.executable,
    args: [...invocation.args, ...stdout.trim().split(/\s+/u).filter(Boolean)],
    env: invocation.env,
    cwd: root,
    source,
    output,
  });
  console.log(`Built ${relativeOutput}`);
}
