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

function validateStdinOutcome(error, result) {
  if (error && !(error.code === "EPIPE" && result.code === 1 && result.signal === null)) {
    throw error;
  }
}

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
  child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
  child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
  const completion = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  let stdinError;
  const inputCompletion = new Promise((resolve) => {
    child.stdin.on("error", (error) => {
      stdinError ??= error;
      resolve();
    });
    child.stdin.end(input, (error) => {
      stdinError ??= error;
      resolve();
    });
  });
  const result = await completion;
  await inputCompletion;
  // Early destination rejection can close stdin before the parent finishes.
  // A pipe error alone is never evidence that the helper rejected correctly.
  validateStdinOutcome(stdinError, result);
  return {
    ...result,
    stdinError,
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
  };
}

test("native Bot inbox writer rejects the wrong managed-home inode before creation", async (t) => {
  if (process.platform !== "darwin") return;
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-native-inbox-identity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await runWriter(root, { inode: "1" });
  assert.equal(result.code, 1);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, "");
  assert.deepEqual(await readdir(root), []);
});

test("inbox harness does not accept unrelated stdin errors, success, or a signal as rejection", () => {
  const pipeError = Object.assign(new Error("closed pipe"), { code: "EPIPE" });
  const otherError = Object.assign(new Error("other stdin failure"), { code: "EIO" });
  for (const result of [{ code: 0, signal: null }, { code: null, signal: "SIGTERM" }]) {
    assert.throws(() => validateStdinOutcome(pipeError, result), (error) => error === pipeError);
  }
  assert.throws(() => validateStdinOutcome(otherError, { code: 1, signal: null }), (error) => error === otherError);
});

test("native Bot inbox writer preserves early rejection when stdin gets EPIPE", async (t) => {
  if (process.platform !== "darwin") return;
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-native-inbox-pipe-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  // This exceeds pipe capacity. The invalid inode makes the real helper exit
  // before reading any bytes, so the queued write must encounter a closed pipe.
  const result = await runWriter(root, { inode: "1" }, Buffer.alloc(4 * 1024 * 1024));
  assert.equal(result.stdinError?.code, "EPIPE");
  assert.equal(result.code, 1);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Bot inbox write failed/u);
  assert.deepEqual(await readdir(root), []);
});

test("native Bot inbox writer rejects extra stdin bytes and removes the leaf", async (t) => {
  if (process.platform !== "darwin") return;
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-native-inbox-length-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await runWriter(root, { size: "3" }, Buffer.from([0, 1, 2, 3]));
  assert.equal(result.code, 1);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, "");
  assert.deepEqual(
    await readdir(path.join(root, ".aiden", "telegram-inbox", "default")),
    [],
  );
});

test("native Bot inbox writer rejects values above Telegram's 20 MB ceiling", async (t) => {
  if (process.platform !== "darwin") return;
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-native-inbox-limit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await runWriter(root, { size: String(20 * 1024 * 1024 + 1) });
  assert.equal(result.code, 1);
  assert.equal(result.signal, null);
  assert.deepEqual(await readdir(root), []);
});
