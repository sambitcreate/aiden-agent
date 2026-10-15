/* global console, process */
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { compileNativeC, nativeCCompileInvocation } from "./native-c-build-core.mjs";

if (process.platform !== "linux") {
  console.log("Global Shortcuts portal is built only on Linux.");
} else {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const output = path.join(root, "build/native/aiden-global-shortcuts-portal");
  const execute = promisify(execFile);
  const source = path.join(root, "native/global-shortcuts-portal/main.c");
  const invocation = await nativeCCompileInvocation({ source, output });
  const { stdout } = await execute("/usr/bin/pkg-config", ["--cflags", "--libs", "gio-unix-2.0"], {
    env: invocation.env, timeout: 10_000, maxBuffer: 16_384,
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
  console.log("Built build/native/aiden-global-shortcuts-portal");
}
