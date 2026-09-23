/* global Buffer, process */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
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
  const canonical = await realpath(value);
  const metadata = await stat(canonical, { bigint: true });
  return [canonical, String(metadata.dev), String(metadata.ino)];
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

async function runEditor(args, input = Buffer.alloc(0), onCheckpoint = async () => {}) {
  const child = spawn(binary, args, {
    stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"],
    env: { ...process.env, AIDEN_WORKTREE_FILE_IO_HANDSHAKE: "1" },
  });
  const chunks = [];
  let stderr = "";
  let checkpointError;
  child.stdout.on("data", chunk => chunks.push(chunk));
  child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
  child.stdio[3].setEncoding("utf8").on("data", marker => {
    void Promise.resolve(onCheckpoint(marker)).then(
      () => child.stdio[4].write(marker),
      error => { checkpointError = error; child.kill("SIGKILL"); },
    );
  });
  child.stdin.end(input);
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  if (checkpointError) throw checkpointError;
  return { code, stderr, stdout: Buffer.concat(chunks) };
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

test("directory listing stays on its held descriptor through a swap and swap-back", async (t) => {
  if (process.platform !== "darwin") return;
  const source = await directory(t);
  const outside = await directory(t);
  const inside = path.join(source, "inside");
  await mkdir(inside);
  await writeFile(path.join(inside, "allowed.txt"), "allowed");
  await writeFile(path.join(outside, "secret-one.txt"), "outside");
  await writeFile(path.join(outside, "secret-two.txt"), "outside");
  const insideIdentity = await identity(inside);
  const result = await runWithCheckpoints(["list", ...await identity(source), "inside", ...insideIdentity.slice(1)], async (marker) => {
    if (marker === "L") {
      await rename(inside, path.join(source, "moved"));
      await symlink(outside, inside);
    } else {
      assert.equal(marker, "E");
      await rm(inside);
      await rename(path.join(source, "moved"), inside);
    }
  });
  const allowed = await identity(path.join(inside, "allowed.txt"));
  assert.equal(result, `f ${allowed[1]} ${allowed[2]} ${Buffer.from("allowed.txt").toString("hex")}\nc\n`);
});

test("directory listing never follows a directory symlink", async (t) => {
  if (process.platform !== "darwin") return;
  const source = await directory(t);
  const outside = await directory(t);
  await symlink(outside, path.join(source, "linked"));
  const outsideIdentity = await identity(outside);
  const child = spawn(binary, ["list", ...await identity(source), "linked", ...outsideIdentity.slice(1)]);
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  assert.notEqual(code, 0);
  assert.equal(output, "");
});

test("editor read binds file identity and opened parent through a symlink swap", async (t) => {
  if (process.platform !== "darwin") return;
  const source = await directory(t);
  const outside = await directory(t);
  await mkdir(path.join(source, "inside"));
  const file = path.join(source, "inside", "file.txt");
  await writeFile(file, "inside\n");
  await writeFile(path.join(outside, "file.txt"), "outside\n");
  const args = ["read", ...await identity(source), "inside/file.txt", ...(await identity(file)).slice(1)];
  const result = await runEditor(args, Buffer.alloc(0), async marker => {
    assert.equal(marker, "R");
    await rename(path.join(source, "inside"), path.join(source, "moved"));
    await symlink(outside, path.join(source, "inside"));
  });
  assert.equal(result.code, 0, result.stderr);
  const divider = result.stdout.indexOf(10);
  assert.match(result.stdout.subarray(0, divider).toString(), /^r 7 \d+ -?\d+ \d+ [0-9a-f]{64}$/u);
  assert.equal(result.stdout.subarray(divider + 1).toString(), "inside\n");
  assert.equal(await readFile(path.join(outside, "file.txt"), "utf8"), "outside\n");
  const wrong = await runEditor(["read", ...await identity(source), "moved/file.txt", "0", "0"]);
  assert.notEqual(wrong.code, 0);
  assert.equal(wrong.stdout.length, 0);
});

test("editor save stays in held parent and retains the original as recovery", async (t) => {
  if (process.platform !== "darwin") return;
  const source = await directory(t);
  const outside = await directory(t);
  await mkdir(path.join(source, "inside"));
  const file = path.join(source, "inside", "file.txt");
  await writeFile(file, "before\n");
  await writeFile(path.join(outside, "file.txt"), "outside\n");
  const expected = createHash("sha256").update("before\n").digest("hex");
  const input = Buffer.from("after\n");
  const args = ["edit", ...await identity(source), "inside/file.txt", ...(await identity(file)).slice(1), expected, String(input.length)];
  const result = await runEditor(args, input, async marker => {
    if (marker === "E") return;
    assert.equal(marker, "D");
    await rename(path.join(source, "inside"), path.join(source, "moved"));
    await symlink(outside, path.join(source, "inside"));
  });
  assert.equal(result.code, 0, result.stderr);
  const header = result.stdout.toString();
  assert.match(header, /^w \d+ \d+ \d+ -?\d+ \d+ [0-9a-f]{64} [0-9a-f]+\n$/u);
  const recovery = Buffer.from(header.trim().split(" ").at(-1), "hex").toString();
  assert.equal(await readFile(path.join(source, "moved", "file.txt"), "utf8"), "after\n");
  assert.equal(await readFile(path.join(source, "moved", recovery), "utf8"), "before\n");
  assert.equal(await readFile(path.join(outside, "file.txt"), "utf8"), "outside\n");
});

test("editor operations reject a symlinked ancestor even when the root inode matches", async (t) => {
  if (process.platform !== "darwin") return;
  const base = await directory(t);
  const ancestor = path.join(base, "ancestor");
  const source = path.join(ancestor, "root");
  await mkdir(source, { recursive: true });
  const file = path.join(source, "file.txt");
  await writeFile(file, "secret\n");
  const rootIdentity = await identity(source);
  const fileIdentity = await identity(file);
  const moved = path.join(base, "moved");
  await rename(ancestor, moved);
  await symlink(moved, ancestor);
  const readResult = await runEditor(["read", ...rootIdentity, "file.txt", ...fileIdentity.slice(1)]);
  assert.notEqual(readResult.code, 0);
  assert.equal(readResult.stdout.length, 0);
  const listChild = spawn(binary, ["list", ...rootIdentity, "", ...rootIdentity.slice(1)]);
  const listChunks = [];
  listChild.stdout.on("data", chunk => listChunks.push(chunk));
  const listCode = await new Promise((resolve, reject) => {
    listChild.once("error", reject);
    listChild.once("close", resolve);
  });
  assert.notEqual(listCode, 0);
  assert.equal(Buffer.concat(listChunks).length, 0);
});

test("editor save rejects stale identity and version without creating recovery", async (t) => {
  if (process.platform !== "darwin") return;
  const source = await directory(t);
  const file = path.join(source, "file.txt");
  await writeFile(file, "current\n");
  const current = await identity(file);
  const input = Buffer.from("replacement\n");
  const hash = createHash("sha256").update("current\n").digest("hex");
  for (const [device, inode, expected] of [["0", "0", hash], [current[1], current[2], "0".repeat(64)]]) {
    const result = await runEditor(["edit", ...await identity(source), "file.txt", device, inode, expected, String(input.length)], input);
    assert.notEqual(result.code, 0);
    assert.equal(result.stdout.length, 0);
    assert.equal(await readFile(file, "utf8"), "current\n");
  }
  assert.deepEqual(await readdir(source), ["file.txt"]);
});

test("editor refuses a seventeenth retained recovery before changing the source", async (t) => {
  if (process.platform !== "darwin") return;
  const source = await directory(t);
  const file = path.join(source, "file.txt");
  await writeFile(file, "current\n");
  for (let index = 0; index < 16; index++) {
    await writeFile(path.join(source, `.aiden-recovery-${index}`), `prior-${index}\n`);
  }
  const before = (await readdir(source)).sort();
  const input = Buffer.from("replacement\n");
  const expected = createHash("sha256").update("current\n").digest("hex");
  const result = await runEditor(["edit", ...await identity(source), "file.txt",
    ...(await identity(file)).slice(1), expected, String(input.length)], input);
  assert.notEqual(result.code, 0);
  assert.equal(result.stderr.trim(), "recovery_limit");
  assert.equal(result.stdout.length, 0);
  assert.equal(await readFile(file, "utf8"), "current\n");
  assert.deepEqual((await readdir(source)).sort(), before);
});
