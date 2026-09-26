/* global process */
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";

if (process.platform !== "linux") {
  throw new Error("Run the Secret Service integration suite inside an isolated Linux container.");
}
const root = await mkdtemp(path.join(os.tmpdir(), "aiden-private-keyring-"));
try {
  for (const name of ["runtime", "data", "config", "cache"]) await mkdir(path.join(root, name), { mode: 0o700 });
  const env = {
    PATH: "/usr/bin:/bin", LANG: "C.UTF-8",
    XDG_RUNTIME_DIR: path.join(root, "runtime"), XDG_DATA_HOME: path.join(root, "data"),
    XDG_CONFIG_HOME: path.join(root, "config"), XDG_CACHE_HOME: path.join(root, "cache"),
    AIDEN_PRIVATE_KEYRING_TEST_ROOT: root,
    AIDEN_AUTHORITY_TEST_HELPER: process.env.AIDEN_AUTHORITY_TEST_HELPER ?? fileURLToPath(new URL("../build/native/aiden-secret-service-authority", import.meta.url)),
  };
  const exitCode = await new Promise((resolve, reject) => {
    // A fresh session bus and all-new XDG directories prevent host-keyring access.
    const child = spawn("/usr/bin/dbus-run-session", ["--", process.execPath, "--test", fileURLToPath(new URL("./secret-service-authority.integration.test.mjs", import.meta.url))], { env, stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
  process.exitCode = exitCode;
} finally { await rm(root, { recursive: true, force: true }); }
