/* global console, process */
import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { nativeCCompileInvocation } from "./native-c-build-core.mjs";

if (process.platform !== "linux") {
  console.log("Secret Service authority is built only on Linux.");
} else {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const output = path.join(root, "build/native/aiden-secret-service-authority");
  const execute = promisify(execFile);
  const invocation = await nativeCCompileInvocation({ source: path.join(root, "native/secret-service-authority/main.c"), output });
  const { stdout } = await execute("/usr/bin/pkg-config", ["--cflags", "--libs", "libsecret-1"], {
    env: invocation.env, timeout: 10_000, maxBuffer: 16_384,
  });
  await mkdir(path.dirname(output), { recursive: true });
  await execute(invocation.executable, [...invocation.args, ...stdout.trim().split(/\s+/u).filter(Boolean)], {
    cwd: root, env: invocation.env, timeout: 120_000, maxBuffer: 1024 * 1024,
  });
  console.log("Built build/native/aiden-secret-service-authority");
}
