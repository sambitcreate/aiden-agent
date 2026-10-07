import assert from "node:assert/strict";
import { mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { readClientTextFile, writeClientTextFile } from "./client-files.js";
import { tempDir } from "./test-support.js";

function workspace() {
  const root = realpathSync(tempDir());
  const outside = realpathSync(tempDir());
  writeFileSync(path.join(root, "a.txt"), "one\ntwo\nthree\n");
  writeFileSync(path.join(outside, "secret.txt"), "secret");
  return { root, outside };
}

const writable = (roots: string[]) => ({ roots, canWrite: () => true });

test("reads inside the workspace, with optional 1-indexed line windows", async () => {
  const { root } = workspace();
  const file = path.join(root, "a.txt");
  assert.equal((await readClientTextFile({ path: file }, writable([root]))).content, "one\ntwo\nthree\n");
  assert.equal((await readClientTextFile({ path: file, line: 2, limit: 1 }, writable([root]))).content, "two");
});

test("refuses relative paths, paths outside the roots, and symlink escapes", async () => {
  const { root, outside } = workspace();
  symlinkSync(path.join(outside, "secret.txt"), path.join(root, "link.txt"));
  symlinkSync(outside, path.join(root, "linked-dir"));
  await assert.rejects(readClientTextFile({ path: "a.txt" }, writable([root])), /absolute/u);
  await assert.rejects(readClientTextFile({ path: path.join(outside, "secret.txt") }, writable([root])), /outside/u);
  await assert.rejects(readClientTextFile({ path: path.join(root, "link.txt") }, writable([root])), /outside/u);
  await assert.rejects(
    writeClientTextFile({ path: path.join(root, "linked-dir", "new.txt"), content: "x" }, writable([root])),
    /outside/u,
  );
  await assert.rejects(
    readClientTextFile({ path: path.join(root, "..", path.basename(outside), "secret.txt") }, writable([root])),
    /outside/u,
  );
});

test("writes create missing folders inside the workspace and report the change", async () => {
  const { root } = workspace();
  const writes: Array<[string, string | undefined, string]> = [];
  const target = path.join(root, "new", "deep", "file.txt");
  await writeClientTextFile(
    { path: target, content: "hello" },
    { roots: [root], canWrite: () => true, onWrite: (file, before, after) => writes.push([file, before, after]) },
  );
  assert.equal(readFileSync(target, "utf8"), "hello");
  assert.deepEqual(writes, [[target, undefined, "hello"]]);
  await writeClientTextFile(
    { path: path.join(root, "a.txt"), content: "changed" },
    { roots: [root], canWrite: () => true, onWrite: (file, before, after) => writes.push([file, before, after]) },
  );
  assert.equal(writes[1]?.[1], "one\ntwo\nthree\n");
});

test("a read-only policy refuses every write", async () => {
  const { root } = workspace();
  await assert.rejects(
    writeClientTextFile({ path: path.join(root, "a.txt"), content: "x" }, { roots: [root], canWrite: () => false }),
    /read-only/u,
  );
  assert.equal(readFileSync(path.join(root, "a.txt"), "utf8"), "one\ntwo\nthree\n");
});

test("no usable root means no file access", async () => {
  const { root } = workspace();
  mkdirSync(path.join(root, "x"));
  await assert.rejects(readClientTextFile({ path: path.join(root, "a.txt") }, writable([])), /no folder/u);
  await assert.rejects(readClientTextFile({ path: path.join(root, "x") }, writable([root])), /not a file/u);
});
