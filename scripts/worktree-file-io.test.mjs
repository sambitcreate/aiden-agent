/* global Buffer, process */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const binary = path.join(root, "build", "native", "aiden-worktree-file-io-test");

async function directory(t) {
  const value = await mkdtemp(path.join(os.tmpdir(), "aiden-worktree-file-io-"));
  t.after(() => rm(value, { recursive: true, force: true }));
  return value;
}

async function identity(value) {
  const metadata = await stat(value, { bigint: true });
  return [value, String(metadata.dev), String(metadata.ino)];
}

async function runWithCheckpoints(args, onCheckpoint) {
  const child = spawn(binary, args, {
    stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"],
    env: { ...process.env, AIDEN_WORKTREE_FILE_IO_HANDSHAKE: "1" },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  let checkpointError;
  child.stdio[3].setEncoding("utf8").on("data", (marker) => {
    void Promise.resolve(onCheckpoint(marker)).then(
      () => child.stdio[4].write(marker),
      (error) => { checkpointError = error; child.kill("SIGKILL"); },
    );
  });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  if (checkpointError) throw checkpointError;
  assert.equal(code, 0, stderr);
  return stdout;
}

test("source read stays on an opened directory when its pathname becomes an outside symlink", async (t) => {
  if (process.platform !== "darwin") return;
  const source = await directory(t);
  const destination = await directory(t);
  const outside = await directory(t);
  await mkdir(path.join(source, "inside"));
  await writeFile(path.join(source, "inside", "secret.txt"), "inside\n");
  await writeFile(path.join(outside, "secret.txt"), "outside\n");
  const args = ["copy", ...await identity(source), "inside/secret.txt",
    ...await identity(destination), "copied.txt", "4096", "-", "source"];
  const result = await runWithCheckpoints(args, async (marker) => {
    if (marker === "S") {
      await rename(path.join(source, "inside"), path.join(source, "moved"));
      await symlink(outside, path.join(source, "inside"));
    }
  });
  assert.match(result, /^7 \d+ \d+ [0-9a-f]{64}\n$/u);
  assert.equal(await readFile(path.join(destination, "copied.txt"), "utf8"), "inside\n");
});

test("restore writes through its opened parent when the pathname becomes an outside symlink", async (t) => {
  if (process.platform !== "darwin") return;
  const source = await directory(t);
  const destination = await directory(t);
  const outside = await directory(t);
  await mkdir(path.join(destination, "inside"));
  const bytes = Buffer.from("captured\n");
  const digest = createHash("sha256").update(bytes).digest("hex");
  await writeFile(path.join(source, "blob"), bytes);
  await writeFile(path.join(outside, "file.txt"), "outside\n");
  const args = ["restore", ...await identity(source), "blob",
    ...await identity(destination), "inside/file.txt", String(bytes.length), digest, "384"];
  await runWithCheckpoints(args, async (marker) => {
    if (marker === "D") {
      await rename(path.join(destination, "inside"), path.join(destination, "moved"));
      await symlink(outside, path.join(destination, "inside"));
    }
  });
  assert.equal(await readFile(path.join(destination, "moved", "file.txt"), "utf8"), "captured\n");
  assert.equal(await readFile(path.join(outside, "file.txt"), "utf8"), "outside\n");
});
