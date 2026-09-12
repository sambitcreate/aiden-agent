/* global Buffer, process */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const binary = path.join(repositoryRoot, "build", "native", "aiden-bot-inbox-writer");

async function runWriter(root, overrides = {}, input = Buffer.alloc(0)) {
  const metadata = await stat(root, { bigint: true });
  const values = {
    device: metadata.dev.toString(),
    inode: metadata.ino.toString(),
    profile: "default",
    leaf: "file.bin",
    size: String(input.byteLength),
    ...overrides,
  };
  const child = spawn(
    binary,
    [
      "--home",
      root,
      "--device",
      values.device,
      "--inode",
      values.inode,
      "--profile",
      values.profile,
      "--leaf",
      values.leaf,
      "--size",
      values.size,
    ],
    {
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", LC_ALL: "C" },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const stdout = [];
  const stderr = [];
  let stdinFailure;
  child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
  child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
  child.stdin.on("error", (error) => {
    // Invalid metadata is rejected before the helper reads stdin. Linux can
    // report that intentional early close as EPIPE while end() is flushing.
    if (error?.code !== "EPIPE") stdinFailure = error;
  });
  child.stdin.end(input);
  const result = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  if (stdinFailure) throw stdinFailure;
  return {
    ...result,
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
  };
}

test("native Bot inbox writer rejects the wrong managed-home inode before creation", async (t) => {
  if (process.platform !== "darwin" && process.platform !== "linux") return;
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-native-inbox-identity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await runWriter(root, { inode: "1" });
  assert.notEqual(result.code, 0);
  assert.equal(result.stdout, "");
  assert.deepEqual(await readdir(root), []);
});

test("native Bot inbox writer rejects extra stdin bytes and removes the leaf", async (t) => {
  if (process.platform !== "darwin" && process.platform !== "linux") return;
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-native-inbox-length-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await runWriter(root, { size: "3" }, Buffer.from([0, 1, 2, 3]));
  assert.notEqual(result.code, 0);
  assert.equal(result.stdout, "");
  assert.deepEqual(
    await readdir(path.join(root, ".aiden", "telegram-inbox", "default")),
    [],
  );
});

test("native Bot inbox writer rejects values above Telegram's 20 MB ceiling", async (t) => {
  if (process.platform !== "darwin" && process.platform !== "linux") return;
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-native-inbox-limit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await runWriter(root, { size: String(20 * 1024 * 1024 + 1) });
  assert.notEqual(result.code, 0);
  assert.deepEqual(await readdir(root), []);
});
