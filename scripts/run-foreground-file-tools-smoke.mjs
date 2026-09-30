/* global clearTimeout, console, process, setTimeout */

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";
import { build, stop } from "esbuild";
import electron from "electron";

const repository = fileURLToPath(new URL("../", import.meta.url));

async function run() {
  await mkdir(path.join(repository, "build"), { recursive: true });
  const temporary = await mkdtemp(path.join(repository, "build", "foreground-smoke-"));
  try {
    const entry = path.join(temporary, "smoke.mjs");
    const workspace = path.join(temporary, "workspace");
    const profile = path.join(temporary, "profile");
    await Promise.all([mkdir(workspace), mkdir(profile)]);
    try {
      await build({
        entryPoints: [path.join(repository, "scripts/smoke-foreground-file-tools.ts")],
        outfile: entry,
        bundle: true,
        platform: "node",
        format: "esm",
        packages: "external",
        external: ["electron"],
      });
    } finally {
      stop();
    }
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    await new Promise((resolve, reject) => {
      const child = spawn(electron, [entry, workspace, profile], {
        cwd: repository,
        env,
        stdio: "inherit",
        detached: process.platform !== "win32",
      });
      let failure;
      const terminate = (reason) => {
        failure ??= new Error(reason);
        if (child.pid && child.exitCode === null && child.signalCode === null) {
          try {
            if (process.platform === "win32") child.kill("SIGKILL");
            else process.kill(-child.pid, "SIGKILL");
          } catch (error) {
            if (error.code !== "ESRCH") failure = error;
          }
        }
      };
      const interrupt = () => terminate("Electron foreground smoke interrupted.");
      const timer = setTimeout(
        () => terminate("Electron foreground smoke exceeded 30 seconds."),
        30_000,
      );
      process.once("SIGINT", interrupt);
      process.once("SIGTERM", interrupt);
      child.once("error", (error) => {
        failure ??= error;
      });
      // Wait for close even after timeout/signal before removing owned fixtures.
      child.once("close", (code, signal) => {
        clearTimeout(timer);
        process.off("SIGINT", interrupt);
        process.off("SIGTERM", interrupt);
        if (failure) reject(failure);
        else if (code !== 0)
          reject(new Error(`Electron foreground smoke exited with ${signal ?? code}.`));
        else resolve();
      });
    });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
