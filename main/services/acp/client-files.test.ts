import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { captureRootIdentity, readClientTextFile, writeClientTextFile } from "./client-files.js";
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

test("reads keep Aiden's .env exclusion, including through a symlink alias", async () => {
  const { root } = workspace();
  writeFileSync(path.join(root, ".env"), "SECRET=1");
  writeFileSync(path.join(root, ".env.local"), "SECRET=2");
  writeFileSync(path.join(root, ".env.example"), "SECRET=");
  symlinkSync(path.join(root, ".env"), path.join(root, "innocent.txt"));
  const policy = { roots: [root], canWrite: () => false };
  await assert.rejects(readClientTextFile({ path: path.join(root, ".env") }, policy), /\.env files is disabled/u);
  await assert.rejects(readClientTextFile({ path: path.join(root, ".env.local") }, policy), /\.env files is disabled/u);
  await assert.rejects(readClientTextFile({ path: path.join(root, "innocent.txt") }, policy), /\.env files is disabled/u);
  assert.equal((await readClientTextFile({ path: path.join(root, ".env.example") }, policy)).content, "SECRET=");
});

test("a symlink swapped in after validation never redirects a write outside the folder", async () => {
  const { root, outside } = workspace();
  const target = path.join(root, "a.txt");
  const victim = path.join(outside, "secret.txt");
  let checks = 0;
  await writeClientTextFile(
    { path: target, content: "agent text" },
    {
      roots: [root],
      canWrite: () => {
        checks += 1;
        // Between validation and the write, replace the file with a link out.
        if (checks === 2) {
          rmSync(target);
          symlinkSync(victim, target);
        }
        return true;
      },
    },
  ).catch(() => undefined);
  assert.equal(readFileSync(victim, "utf8"), "secret", "the outside file is untouched");
});

test("a parent swapped for a link out right before creation never creates anything outside", { skip: process.platform !== "darwin" && process.platform !== "linux" }, async () => {
  const { root, outside } = workspace();
  const sub = path.join(root, "sub");
  mkdirSync(sub);
  const before = readdirSync(outside).sort();
  await assert.rejects(
    writeClientTextFile(
      { path: path.join(sub, "new.txt"), content: "agent text" },
      {
        roots: [root],
        canWrite: () => true,
        beforeCreate: () => {
          renameSync(sub, path.join(root, "sub-moved"));
          symlinkSync(outside, sub);
        },
      },
    ),
    /could not be created safely|outside/u,
  );
  assert.deepEqual(readdirSync(outside).sort(), before, "nothing was created outside the folder");
});

test("an ancestor of the folder swapped after the turn started cannot move file access elsewhere", { skip: process.platform !== "darwin" && process.platform !== "linux" }, async () => {
  const base = realpathSync(tempDir());
  const outside = realpathSync(tempDir());
  mkdirSync(path.join(base, "a", "ws"), { recursive: true });
  writeFileSync(path.join(base, "a", "ws", "notes.txt"), "inside");
  mkdirSync(path.join(outside, "ws"));
  writeFileSync(path.join(outside, "ws", "notes.txt"), "outside");
  const identity = await captureRootIdentity(path.join(base, "a", "ws"));
  // Replace an ancestor (not the folder itself) with a link out.
  renameSync(path.join(base, "a"), path.join(base, "a-moved"));
  symlinkSync(outside, path.join(base, "a"));
  const policy = { roots: [identity], canWrite: () => true };
  await assert.rejects(
    writeClientTextFile({ path: path.join(base, "a", "ws", "new.txt"), content: "x" }, policy),
    /no folder|outside|could not be created/u,
  );
  await assert.rejects(
    writeClientTextFile({ path: path.join(base, "a", "ws", "notes.txt"), content: "x" }, policy),
    /no folder|outside/u,
  );
  await assert.rejects(readClientTextFile({ path: path.join(base, "a", "ws", "notes.txt") }, policy), /no folder|outside/u);
  assert.deepEqual(readdirSync(path.join(outside, "ws")), ["notes.txt"]);
  assert.equal(readFileSync(path.join(outside, "ws", "notes.txt"), "utf8"), "outside");
});
