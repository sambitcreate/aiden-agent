import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  linuxRecoveryUse,
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


test("lazy listing preserves supplied root and directory identities across replacement", { skip: process.platform !== "darwin" }, async (t) => {
  const root = await workspace(t);
  await fs.mkdir(path.join(root, "inside"));
  const rootStat = await fs.stat(root, { bigint: true });
  const directoryStat = await fs.stat(path.join(root, "inside"), { bigint: true });
  const identities = {
    root: { path: await fs.realpath(root), device: rootStat.dev.toString(), inode: rootStat.ino.toString() },
    directory: { device: directoryStat.dev.toString(), inode: directoryStat.ino.toString() },
  };
  await fs.rename(path.join(root, "inside"), path.join(root, "original"));
  await fs.mkdir(path.join(root, "inside"));
  await fs.writeFile(path.join(root, "inside", "private.txt"), "private");
  await assert.rejects(listWorkspaceDirectory(root, "inside", undefined, identities));
  await fs.rm(path.join(root, "inside"), { recursive: true });
  await fs.rename(path.join(root, "original"), path.join(root, "inside"));
  const moved = root + "-original";
  await fs.rename(root, moved);
  t.after(() => fs.rm(moved, { recursive: true, force: true }));
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, "private.txt"), "private");
  await assert.rejects(listWorkspaceDirectory(root, "", undefined, { root: identities.root, directory: identities.root }));
});

test(
  "Linux recovery inspection detects current-user open descriptors",
  { skip: process.platform !== "linux" || !process.getuid },
  async (t) => {
    const root = await workspace(t);
    const file = path.join(root, "recovery.txt");
    await fs.writeFile(file, "original");
    const handle = await fs.open(file, "r");
    assert.equal(await linuxRecoveryUse(file), "open");
    await handle.close();
    assert.equal(await linuxRecoveryUse(file), "clear");
  },
);

test("workspace indexing overlaps at most four stats and preserves numeric tree ordering", async (t) => {
  const root = await workspace(t);
  await fs.mkdir(path.join(root, "src"));
  await fs.mkdir(path.join(root, "dist"));
  for (const name of ["file10.txt", "file2.txt", "file1.txt", "file3.txt", "file4.txt", "src/child.txt"]) {
    await fs.writeFile(path.join(root, name), name);
  }
  const original = fsPromises.stat;
  let active = 0;
  let peak = 0;
  let calls = 0;
  fsPromises.stat = (async (...args: Parameters<typeof fsPromises.stat>) => {
    if (!String(args[0]).endsWith(".txt")) return original(...args);
    calls += 1;
    peak = Math.max(peak, ++active);
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      return await original(...args);
    } finally { active -= 1; }
  }) as typeof fsPromises.stat;
  syncBuiltinESMExports();
  t.after(() => { fsPromises.stat = original; syncBuiltinESMExports(); });
  const index = await listWorkspaceFiles(root);
  assert.deepEqual(index.entries.map(entry => entry.path), [
    "src", "src/child.txt", "file1.txt", "file2.txt", "file3.txt", "file4.txt", "file10.txt",
  ]);
  assert.equal(index.skippedDirectories, 1);
  assert.equal(index.truncated, false);
  assert.equal(calls, 6);
  assert.ok(peak > 1 && peak <= 4, `peak metadata concurrency: ${peak}`);
  assert.equal(active, 0);
});

for (const failure of ["cancel", "stat failure"] as const) {
  test(`workspace indexing drains its bounded batch on ${failure}`, async (t) => {
    const root = await workspace(t);
    for (let index = 0; index < 12; index += 1) await fs.writeFile(path.join(root, `${index}.txt`), "data");
    const controller = new AbortController();
    const original = fsPromises.stat;
    let active = 0;
    let calls = 0;
    fsPromises.stat = (async (...args: Parameters<typeof fsPromises.stat>) => {
      if (!String(args[0]).endsWith(".txt")) return original(...args);
      const ordinal = ++calls;
      active += 1;
      try {
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (ordinal === 1) {
          if (failure === "cancel") controller.abort();
          else throw new Error("metadata unavailable");
        }
        return await original(...args);
      } finally { active -= 1; }
    }) as typeof fsPromises.stat;
    syncBuiltinESMExports();
    t.after(() => { fsPromises.stat = original; syncBuiltinESMExports(); });
    await assert.rejects(listWorkspaceFiles(root, controller.signal), failure === "cancel" ? /cancelled/ : /metadata unavailable/);
    assert.equal(active, 0, "operation must not release ownership before its reads settle");
    assert.ok(calls <= 4, `started ${calls} metadata operations after failure`);
  });
}

test("fresh workspace indexes observe external writes, renames and root replacement", async (t) => {
  const parent = await workspace(t);
  const root = path.join(parent, "root");
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, "first.txt"), "one");
  assert.equal((await listWorkspaceFiles(root)).entries[0]?.size, 3);
  await fs.writeFile(path.join(root, "first.txt"), "longer external edit");
  await fs.rename(path.join(root, "first.txt"), path.join(root, "second.txt"));
  const refreshed = await listWorkspaceFiles(root);
  assert.deepEqual(refreshed.entries.map(entry => [entry.path, entry.size]), [["second.txt", 20]]);
  await fs.rename(root, path.join(parent, "previous"));
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, "replacement.txt"), "new");
  assert.deepEqual((await listWorkspaceFiles(root)).entries.map(entry => entry.path), ["replacement.txt"]);
});

test("workspace batches preserve depth cutoff and file versus directory symlinks", async (t) => {
  const root = await workspace(t);
  await fs.writeFile(path.join(root, "source.txt"), "data");
  await fs.symlink(path.join(root, "source.txt"), path.join(root, "alias.txt"));
  await fs.symlink(path.join(root, "missing"), path.join(root, "broken"));
  let directory = root;
  for (let depth = 0; depth < 22; depth += 1) {
    directory = path.join(directory, "nested");
    await fs.mkdir(directory);
    await fs.writeFile(path.join(directory, "leaf.txt"), "leaf");
  }
  await fs.symlink(path.join(root, "nested"), path.join(root, "linked-directory"));
  const index = await listWorkspaceFiles(root);
  assert.equal(index.truncated, true);
  assert.equal(index.entries.filter(entry => entry.name === "leaf.txt").length, 20);
  assert.equal(Math.max(...index.entries.map(entry => entry.depth)), 20);
  assert.equal(index.entries.find(entry => entry.path === "alias.txt")?.kind, "file");
  assert.equal(index.entries.find(entry => entry.path === "alias.txt")?.size, 4);
  assert.equal(index.entries.find(entry => entry.path === "broken")?.kind, "symlink");
  assert.equal(index.entries.find(entry => entry.path === "linked-directory")?.kind, "symlink");
  assert.equal(index.entries.some(entry => entry.path.startsWith("linked-directory/")), false);
});
