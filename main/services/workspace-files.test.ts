import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  listWorkspaceFiles,
  listWorkspaceDirectory,
  readWorkspaceFile,
  WorkspaceFileError,
  writeWorkspaceFile,
} from "./workspace-files.js";

async function workspace(t: test.TestContext): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-files-test-"));
  t.after(() => fs.rm(root, { force: true, recursive: true }));
  return root;
}

test("workspace file index stays bounded to the workspace and skips generated directories", async (t) => {
  const root = await workspace(t);
  const outside = await workspace(t);
  await fs.mkdir(path.join(root, "src"));
  await fs.mkdir(path.join(root, "node_modules"));
  await fs.writeFile(path.join(root, "src", "index.ts"), "export {};\n");
  await fs.writeFile(path.join(root, "node_modules", "ignored.js"), "ignored\n");
  await fs.writeFile(path.join(outside, "secret.txt"), "secret\n");
  await fs.symlink(path.join(outside, "secret.txt"), path.join(root, "escape.txt"));

  const index = await listWorkspaceFiles(root);
  assert.equal(index.entries.some((entry) => entry.path === "src/index.ts"), true);
  assert.equal(index.entries.some((entry) => entry.path.includes("node_modules")), false);
  assert.equal(index.entries.find((entry) => entry.path === "escape.txt")?.kind, "symlink");
  await assert.rejects(readWorkspaceFile(root, "escape.txt"), /outside the workspace/);
});

test("workspace file index cannot starve root files behind a large early directory", async (t) => {
  const root = await workspace(t);
  const archive = path.join(root, ".archive");
  await fs.mkdir(archive);
  await fs.mkdir(path.join(root, ".build"));
  await fs.writeFile(path.join(root, ".build", "ignored.swiftmodule"), "generated\n");
  await fs.writeFile(path.join(root, "package.json"), "{}\n");
  for (let start = 0; start < 4_100; start += 100) {
    await Promise.all(
      Array.from({ length: 100 }, (_, offset) =>
        fs.writeFile(path.join(archive, `entry-${String(start + offset).padStart(4, "0")}.txt`), ""),
      ),
    );
  }

  const index = await listWorkspaceFiles(root);
  assert.equal(index.truncated, true);
  assert.equal(index.entries.length, 4_000);
  assert.equal(index.entries.some((entry) => entry.path === "package.json"), true);
  assert.equal(index.entries.some((entry) => entry.path.startsWith(".build/")), false);
});

test("workspace editor saves only the version the user opened", async (t) => {
  const root = await workspace(t);
  const file = path.join(root, "notes.txt");
  await fs.writeFile(file, "first\n");
  const opened = await readWorkspaceFile(root, "notes.txt");
  const saved = await writeWorkspaceFile(root, "notes.txt", "second\n", opened.version);
  assert.equal(saved.content, "second\n");
  if (process.platform === "darwin") assert.equal(saved.warning, undefined);
  assert.equal(await fs.readFile(file, "utf8"), "second\n");

  await fs.writeFile(file, "external\n");
  await assert.rejects(
    writeWorkspaceFile(root, "notes.txt", "stale\n", saved.version),
    /changed on disk/,
  );
  assert.equal(await fs.readFile(file, "utf8"), "external\n");
});

test("workspace editor preserves permission bits across atomic replacement", async (t) => {
  const root = await workspace(t);
  const file = path.join(root, "shared.txt");
  await fs.writeFile(file, "opened\n");
  await fs.chmod(file, 0o664);
  const opened = await readWorkspaceFile(root, "shared.txt");

  await writeWorkspaceFile(
    root,
    "shared.txt",
    "saved\n",
    opened.version,
    undefined,
    { recoveryUse: async () => "clear" },
  );

  assert.equal((await fs.stat(file)).mode & 0o7777, 0o664);
});

test("workspace editor preserves an external save that races atomic replacement", async (t) => {
  const root = await workspace(t);
  const file = path.join(root, "notes.txt");
  await fs.writeFile(file, "opened\n");
  const opened = await readWorkspaceFile(root, "notes.txt");

  await assert.rejects(
    writeWorkspaceFile(
      root,
      "notes.txt",
      "aiden draft\n",
      opened.version,
      undefined,
      {
        beforeDisplace: async () => {
          await fs.writeFile(file, "external save\n");
        },
      },
    ),
    (error) => error instanceof WorkspaceFileError && error.code === "changed_on_disk",
  );
  assert.equal(await fs.readFile(file, "utf8"), "external save\n");
  assert.deepEqual(
    (await fs.readdir(root)).filter((name) => name.includes("aiden-recovery")),
    [],
  );
});

test("workspace editor retains an inode still open in another process", async (t) => {
  const root = await workspace(t);
  const file = path.join(root, "notes.txt");
  await fs.writeFile(file, "opened\n");
  const opened = await readWorkspaceFile(root, "notes.txt");
  const externalHandle = await fs.open(file, "r+");
  t.after(() => externalHandle.close());

  const saved = await writeWorkspaceFile(
    root,
    "notes.txt",
    "aiden draft\n",
    opened.version,
    undefined,
    {
      recoveryUse: async () => "open",
    },
  );

  assert.match(saved.warning ?? "", /still had the previous file open/);
  assert.equal(await fs.readFile(file, "utf8"), "aiden draft\n");
  const recoveryFiles = (await fs.readdir(root)).filter((name) => name.includes("aiden-recovery"));
  assert.equal(recoveryFiles.length, 1);
  await externalHandle.truncate(0);
  await externalHandle.writeFile("external descriptor write\n");
  assert.equal(
    await fs.readFile(path.join(root, recoveryFiles[0]), "utf8"),
    "external descriptor write\n",
  );
});

test("workspace editor retains a displaced inode written and closed before inspection", async (t) => {
  const root = await workspace(t);
  const file = path.join(root, "notes.txt");
  await fs.writeFile(file, "opened\n");
  const opened = await readWorkspaceFile(root, "notes.txt");
  const externalHandle = await fs.open(file, "r+");
  let externalClosed = false;
  t.after(async () => {
    if (!externalClosed) await externalHandle.close();
  });

  const saved = await writeWorkspaceFile(
    root,
    "notes.txt",
    "aiden draft\n",
    opened.version,
    undefined,
    {
      beforeRecoveryCleanup: async () => {
        await externalHandle.truncate(0);
        await externalHandle.writeFile("external closed write\n");
        await externalHandle.close();
        externalClosed = true;
      },
      recoveryUse: async () => "clear",
    },
  );

  assert.match(saved.warning ?? "", /wrote to the previous file/);
  const recoveryFiles = (await fs.readdir(root)).filter((name) => name.includes("aiden-recovery"));
  assert.equal(recoveryFiles.length, 1);
  assert.equal(
    await fs.readFile(path.join(root, recoveryFiles[0]), "utf8"),
    "external closed write\n",
  );
});

test("workspace editor rejects traversal and binary files", async (t) => {
  const root = await workspace(t);
  await fs.writeFile(path.join(root, "binary.dat"), Buffer.from([1, 0, 2]));
  await assert.rejects(readWorkspaceFile(root, "../outside.txt"), /outside the workspace/);
  await assert.rejects(readWorkspaceFile(root, "binary.dat"), /binary/);
});

test("workspace editor rejects a file that grows after the pathname size check", async (t) => {
  const root = await workspace(t);
  const file = path.join(root, "growing.txt");
  await fs.writeFile(file, "small");
  const canonicalFile = await fs.realpath(file);
  const originalStat = fsPromises.stat;
  let grew = false;
  t.mock.method(fsPromises, "stat", async (...args: Parameters<typeof originalStat>) => {
    const info = await originalStat(...args);
    if (args[0] === canonicalFile && !grew) {
      grew = true;
      await fs.writeFile(file, "x".repeat(1_500_001));
    }
    return info;
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });

  await assert.rejects(readWorkspaceFile(root, "growing.txt"), /too large to edit/);
  assert.equal(grew, true);
});

test("workspace editor bounds bytes even when a file grows after descriptor stat", async (t) => {
  const root = await workspace(t);
  const file = path.join(root, "growing.txt");
  await fs.writeFile(file, "small");
  const canonicalFile = await fs.realpath(file);
  const originalOpen = fsPromises.open;
  let grew = false;
  let bytesRead = 0;
  let closed = false;
  t.mock.method(fsPromises, "open", async (...args: Parameters<typeof originalOpen>) => {
    const handle = await originalOpen(...args);
    if (args[0] !== canonicalFile) return handle;
    const originalStat = handle.stat.bind(handle);
    t.mock.method(handle, "stat", async () => {
      const info = await originalStat();
      grew = true;
      await fs.writeFile(file, "x".repeat(2_000_000));
      return info;
    });
    const originalRead = handle.read.bind(handle);
    t.mock.method(handle, "read", async (buffer: Buffer, offset: number, length: number, position: number) => {
      const result = await originalRead(buffer, offset, length, position);
      bytesRead += result.bytesRead;
      return result;
    });
    const originalClose = handle.close.bind(handle);
    t.mock.method(handle, "close", async () => {
      await originalClose();
      closed = true;
    });
    return handle;
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });

  await assert.rejects(readWorkspaceFile(root, "growing.txt"), /too large to edit/);
  assert.equal(grew, true);
  assert.equal(bytesRead, 1_500_001, "only the editor budget plus one overflow sentinel is read");
  assert.equal(closed, true, "rejected reads close the opened descriptor");
});

test("workspace editor accepts the exact byte limit and rejects one byte over it", async (t) => {
  const root = await workspace(t);
  const file = path.join(root, "limit.txt");
  const content = "é".repeat(750_000);
  await fs.writeFile(file, content);
  const document = await readWorkspaceFile(root, "limit.txt");
  assert.equal(document.content, content);
  assert.equal(document.size, 1_500_000);
  await fs.appendFile(file, "x");
  await assert.rejects(readWorkspaceFile(root, "limit.txt"), /too large to edit/);
});

test("workspace editor still follows a stable symlink to a file inside the workspace", async (t) => {
  const root = await workspace(t);
  await fs.writeFile(path.join(root, "target.txt"), "linked content\n");
  await fs.symlink("target.txt", path.join(root, "linked.txt"));
  const document = await readWorkspaceFile(root, "linked.txt");
  assert.equal(document.path, "linked.txt");
  assert.equal(document.content, "linked content\n");
});

test("lazy directory scan rejects a directory symlink", { skip: process.platform !== "darwin" }, async (t) => {
  const root = await workspace(t);
  const outside = await workspace(t);
  await fs.writeFile(path.join(outside, "secret"), "private");
  await fs.symlink(outside, path.join(root, "child"));
  await assert.rejects(listWorkspaceDirectory(root, "child"));
});

test("lazy directory scan includes files at the legacy depth boundary", { skip: process.platform !== "darwin" }, async (t) => {
  const root = await workspace(t);
  const directory = Array.from({ length: 20 }, () => "a").join("/");
  await fs.mkdir(path.join(root, directory), { recursive: true });
  await fs.writeFile(path.join(root, directory, "last.txt"), "last");
  assert.equal((await listWorkspaceDirectory(root, directory)).entries[0]?.name, "last.txt");
});
