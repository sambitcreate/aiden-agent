import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { capturePeerProjectRoot, createPeerProjectFile, readPeerProjectFile } from "./peer-project-file-io.js";

const executeFile = promisify(execFile);

test("environment transfer pins the root and leaf identities, refuses overwrites, and creates private files", async t => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "aiden-env-io-")));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const rootPath = path.join(directory, "project");
  const outside = path.join(directory, "outside");
  await fs.mkdir(rootPath); await fs.mkdir(outside);
  const root = await capturePeerProjectRoot(rootPath);
  const signal = new AbortController().signal;
  await createPeerProjectFile(root, ".env", "A=private", signal);
  assert.equal((await fs.stat(path.join(rootPath, ".env"))).mode & 0o777, 0o600);
  const stat = await fs.stat(path.join(rootPath, ".env"), { bigint: true });
  const file = { device: String(stat.dev), inode: String(stat.ino) };
  assert.equal((await readPeerProjectFile(root, ".env", file)).toString(), "A=private");
  await assert.rejects(createPeerProjectFile(root, ".env", "overwritten", signal));
  await fs.rename(path.join(rootPath, ".env"), path.join(rootPath, ".env.original"));
  await fs.writeFile(path.join(outside, "kept"), "outside");
  await fs.symlink(path.join(outside, "kept"), path.join(rootPath, ".env"));
  await assert.rejects(readPeerProjectFile(root, ".env", file));
  await fs.rename(rootPath, `${rootPath}-moved`);
  await fs.symlink(outside, rootPath);
  await assert.rejects(createPeerProjectFile(root, ".env.new", "private", signal));
  assert.deepEqual(await fs.readdir(outside), ["kept"]);
});

test("Linux environment reads reject a FIFO substituted after admission without waiting for a writer", { skip: process.platform !== "linux" }, async t => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "aiden-env-fifo-")));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const root = await capturePeerProjectRoot(directory);
  const filename = path.join(directory, ".env");
  await fs.writeFile(filename, "APPROVED=1");
  const admitted = await fs.lstat(filename, { bigint: true });
  await fs.rename(filename, `${filename}.original`);
  await executeFile("mkfifo", [filename]);

  // Isolate the reader so the regression cannot leave a libuv worker blocked in
  // open(2). The deadline kills and reaps the child if it ever waits for a writer.
  const { stdout } = await executeFile(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", `
    import assert from "node:assert/strict";
    import { readPeerProjectFile } from ${JSON.stringify(new URL("./peer-project-file-io.ts", import.meta.url).href)};
    const { root, identity } = JSON.parse(process.argv[1]);
    await assert.rejects(readPeerProjectFile(root, ".env", identity), /environment file changed/u);
    process.stdout.write("rejected");
  `, JSON.stringify({ root, identity: { device: String(admitted.dev), inode: String(admitted.ino) } })], {
    timeout: 5_000, killSignal: "SIGKILL",
  });
  assert.equal(stdout, "rejected");
  assert.equal((await fs.lstat(filename)).isFIFO(), true);
  assert.equal(await fs.readFile(`${filename}.original`, "utf8"), "APPROVED=1");
});
