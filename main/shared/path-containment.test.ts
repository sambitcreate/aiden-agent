import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { assertPathInside, isPathInside, resolveRealPathInside } from "./path-containment.js";

test("isPathInside rejects traversal, sibling prefixes, and foreign absolute paths", () => {
  const root = path.resolve("/srv/aiden/root");
  for (const hostile of [
    path.join(root, ".."),
    path.join(root, "..", "root-evil", "file"),
    path.join(root, "a", "..", "..", "etc", "passwd"),
    `${root}-evil`,
    path.resolve("/etc/passwd"),
  ]) {
    assert.equal(isPathInside(root, hostile), false, hostile);
  }
});

test("isPathInside accepts in-root names that merely begin with two dots", () => {
  const root = path.resolve("/srv/aiden/root");
  assert.equal(isPathInside(root, path.join(root, "..cache")), true);
  assert.equal(isPathInside(root, path.join(root, "nested", "..hidden", "x.txt")), true);
  assert.equal(isPathInside(root, path.join(root, "a", "..", "b")), true);
});

test("isPathInside treats the root itself according to allowRoot", () => {
  const root = path.resolve("/srv/aiden/root");
  assert.equal(isPathInside(root, `${root}${path.sep}`), true);
  assert.equal(isPathInside(root, root, { allowRoot: false }), false);
  assert.equal(isPathInside(root, path.join(root, "child"), { allowRoot: false }), true);
});

test("isPathInside handles Windows separators, drives, and UNC roots", () => {
  const win = path.win32;
  const root = "C:\\Users\\aiden\\work";
  assert.equal(isPathInside(root, "C:\\Users\\aiden\\work\\src\\a.ts", { pathApi: win }), true);
  assert.equal(isPathInside(root, "C:\\Users\\aiden\\work\\..cache", { pathApi: win }), true);
  assert.equal(isPathInside(root, "C:\\Users\\aiden\\work\\..\\secret", { pathApi: win }), false);
  assert.equal(isPathInside(root, "D:\\Users\\aiden\\work\\src", { pathApi: win }), false);
  assert.equal(isPathInside(root, "\\\\server\\share\\work", { pathApi: win }), false);
});

test("assertPathInside throws the caller's message only for escapes", () => {
  const root = path.resolve("/srv/aiden/root");
  assert.doesNotThrow(() => assertPathInside(root, path.join(root, "ok"), "escaped"));
  assert.throws(() => assertPathInside(root, path.join(root, "..", "x"), "escaped"), /^Error: escaped$/);
});

test("resolveRealPathInside follows symlinks before deciding containment", async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), "aiden-path-containment-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, "root");
  const outside = path.join(base, "outside");
  await mkdir(path.join(root, "inner"), { recursive: true });
  await mkdir(outside);
  await writeFile(path.join(root, "inner", "file.txt"), "inside");
  await writeFile(path.join(outside, "secret.txt"), "outside");
  await symlink(outside, path.join(root, "escape"), "dir");
  await symlink(path.join(root, "inner"), path.join(root, "alias"), "dir");

  const escaped = path.join(root, "escape", "secret.txt");
  assert.equal(isPathInside(root, escaped), true, "lexical check cannot see the link");
  assert.equal(await resolveRealPathInside(root, escaped), null);

  const aliased = await resolveRealPathInside(root, path.join(root, "alias", "file.txt"));
  assert.ok(aliased?.endsWith(path.join("inner", "file.txt")));

  await assert.rejects(resolveRealPathInside(root, path.join(root, "missing")), { code: "ENOENT" });
});
