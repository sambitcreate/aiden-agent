/* global process */

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

if (process.platform === "darwin") {
  const child = spawn(
    process.execPath,
    [path.join(repositoryRoot, "scripts", "prepare-macos-dev-runtime.mjs"), "--run"],
    { cwd: repositoryRoot, env: process.env, stdio: "inherit" },
  );
  child.once("exit", (code, signal) => {
    process.exitCode = signal ? 1 : (code ?? 1);
  });
} else if (process.platform === "linux") {
  const electron = path.join(repositoryRoot, "node_modules", ".bin", "electron");
  const child = spawn(electron, [repositoryRoot], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      AIDEN_RUNTIME_PROFILE: "development",
      AIDEN_RENDERER_URL:
        process.env.AIDEN_RENDERER_URL ?? "http://127.0.0.1:4143",
    },
    stdio: "inherit",
  });
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => child.kill(signal));
  }
  child.once("exit", (code, signal) => {
    process.exitCode = signal ? 1 : (code ?? 1);
  });
} else {
  throw new Error(`Aiden development is unsupported on ${process.platform}.`);
}
