import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createPeerProjectSource } from "./peer-project-source.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
async function fixture(t: test.TestContext) {
  const folder = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "aiden-project-source-")));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  git(folder, "init", "-q");
  git(folder, "remote", "add", "origin", "https://example.invalid/acme/widget.git");
  await fs.writeFile(path.join(folder, ".gitignore"), ".env*\n.dev.vars*\n");
  const workspace = { id: "workspace", name: "Widget", folderPath: folder, permission: "ask" as const, createdAt: 0, updatedAt: 0 };
  return { folder, workspace, source: createPeerProjectSource({ getWorkspace: async () => workspace }) };
}

test("project preview lists only bounded ignored root environment files without their contents", async t => {
  const { folder, source } = await fixture(t);
  await fs.writeFile(path.join(folder, ".env"), "KEY=synthetic-private-value");
  await fs.writeFile(path.join(folder, ".dev.vars"), "PORT=3000");
  await fs.writeFile(path.join(folder, ".env.large"), "x".repeat(128 * 1024 + 1));
  await fs.writeFile(path.join(folder, ".env.tracked"), "tracked");
  git(folder, "add", "-f", ".env.tracked");
  await fs.symlink(path.join(folder, ".env"), path.join(folder, ".env.link"));
  await fs.link(path.join(folder, ".env"), path.join(folder, ".env.hardlink"));
  const preview = await source.preview("workspace");
  assert.deepEqual(preview.files.map(file => file.name), [".dev.vars"]);
  assert.equal(JSON.stringify(preview).includes("synthetic-private-value"), false);
  assert.deepEqual((await source.read("workspace", [])).files, []);
  assert.deepEqual((await source.read("workspace", [".dev.vars"])).files, [{ name: ".dev.vars", content: "PORT=3000" }]);
  await assert.rejects(source.read("workspace", [".env.link"]), /file list changed/);
  await assert.rejects(source.read("workspace", ["../private"]), /valid environment/);
});

test("explicit transfer rechecks eligibility and rejects binary, oversized and duplicate selections", async t => {
  const { folder, source } = await fixture(t);
  await fs.writeFile(path.join(folder, ".env"), "A=1");
  assert.deepEqual((await source.preview("workspace")).files, [{ name: ".env", bytes: 3 }]);
  await fs.writeFile(path.join(folder, ".env"), "binary\0data");
  await assert.rejects(source.read("workspace", [".env"]), /UTF-8/);
  await assert.rejects(source.read("workspace", [".env", ".env"]), /valid environment/);
  await fs.writeFile(path.join(folder, ".env"), "x".repeat(128 * 1024 + 1));
  await assert.rejects(source.read("workspace", [".env"]), /file list changed/);
});

test("cloning requires the repository root and a credential-free remote", async t => {
  const { folder, workspace, source } = await fixture(t);
  git(folder, "remote", "set-url", "origin", "https://private:synthetic-secret@example.invalid/acme/widget.git");
  await assert.rejects(source.preview("workspace"), /credential-free/);
  await fs.mkdir(path.join(folder, "nested"));
  workspace.folderPath = path.join(folder, "nested");
  await assert.rejects(source.preview("workspace"), /repository root/);
});
