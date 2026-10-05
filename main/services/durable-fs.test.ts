import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { writeFileAtomic, writeJsonAtomic } from "./durable-fs.js";

async function scratch(t: test.TestContext): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-durable-fs-"));
  t.after(async () => {
    await fs.chmod(directory, 0o700).catch(() => undefined);
    await fs.rm(directory, { recursive: true, force: true });
  });
  return directory;
}

async function siblings(directory: string): Promise<string[]> {
  return (await fs.readdir(directory)).sort();
}

test("replaces a file atomically with the requested owner-only mode", async (t) => {
  const directory = await scratch(t);
  const target = path.join(directory, "state.json");
  await fs.writeFile(target, "old", { mode: 0o644 });

  await writeFileAtomic(target, "new", { mode: 0o600 });

  assert.equal(await fs.readFile(target, "utf8"), "new");
  assert.equal((await fs.stat(target)).mode & 0o777, 0o600);
  assert.deepEqual(await siblings(directory), ["state.json"]);
});

test("a failed staged-file fsync keeps the previous bytes and leaves no staging file", async (t) => {
  const directory = await scratch(t);
  const target = path.join(directory, "state.json");
  await fs.writeFile(target, "previous");

  await assert.rejects(
    writeFileAtomic(target, "replacement", {
      io: {
        syncFile: async () => {
          throw Object.assign(new Error("injected EIO"), { code: "EIO" });
        },
      },
    }),
    /injected EIO/u,
  );

  assert.equal(await fs.readFile(target, "utf8"), "previous");
  assert.deepEqual(await siblings(directory), ["state.json"]);
});

test("a crash-equivalent rename failure keeps the previous bytes", async (t) => {
  const directory = await scratch(t);
  const target = path.join(directory, "state.json");
  await fs.writeFile(target, "previous");

  await assert.rejects(
    writeFileAtomic(target, "replacement", {
      io: {
        rename: async () => {
          throw Object.assign(new Error("injected ENOSPC"), { code: "ENOSPC" });
        },
      },
    }),
    /injected ENOSPC/u,
  );

  assert.equal(await fs.readFile(target, "utf8"), "previous");
  assert.deepEqual(await siblings(directory), ["state.json"]);
});

test("a post-rename directory fsync failure is reported after the new bytes are whole", async (t) => {
  const directory = await scratch(t);
  const target = path.join(directory, "state.json");
  await fs.writeFile(target, "previous");

  await assert.rejects(
    writeFileAtomic(target, "replacement", {
      io: {
        syncDirectory: async () => {
          throw Object.assign(new Error("injected dir sync"), { code: "EIO" });
        },
      },
    }),
    /injected dir sync/u,
  );

  // The caller learns durability is uncertain, but readers never see a mix.
  assert.equal(await fs.readFile(target, "utf8"), "replacement");
  assert.deepEqual(await siblings(directory), ["state.json"]);
});

test("an unwritable directory (EACCES) rejects without touching the destination", async (t) => {
  if (process.getuid?.() === 0) {
    t.skip("root bypasses directory permissions");
    return;
  }
  const directory = await scratch(t);
  const target = path.join(directory, "state.json");
  await fs.writeFile(target, "previous");
  await fs.chmod(directory, 0o500);

  await assert.rejects(writeFileAtomic(target, "replacement"), (error: unknown) => {
    return (error as NodeJS.ErrnoException).code === "EACCES";
  });

  await fs.chmod(directory, 0o700);
  assert.equal(await fs.readFile(target, "utf8"), "previous");
  assert.deepEqual(await siblings(directory), ["state.json"]);
});

test("exclusive publication never replaces an existing file", async (t) => {
  const directory = await scratch(t);
  const target = path.join(directory, "lease.json");
  await fs.writeFile(target, "owner-a");

  await assert.rejects(
    writeFileAtomic(target, "owner-b", { exclusive: true }),
    (error: unknown) => (error as NodeJS.ErrnoException).code === "EEXIST",
  );
  assert.equal(await fs.readFile(target, "utf8"), "owner-a");
  assert.deepEqual(await siblings(directory), ["lease.json"]);

  const fresh = path.join(directory, "fresh.json");
  await writeFileAtomic(fresh, "owner-b", { exclusive: true, mode: 0o600 });
  assert.equal(await fs.readFile(fresh, "utf8"), "owner-b");
  assert.deepEqual(await siblings(directory), ["fresh.json", "lease.json"]);
});

test("concurrent writers to one destination never collide on a staging name", async (t) => {
  const directory = await scratch(t);
  const target = path.join(directory, "state.json");
  const values = Array.from({ length: 24 }, (_, index) => `value-${index}`);

  await Promise.all(values.map((value) => writeFileAtomic(target, value, { fsync: false })));

  assert.ok(values.includes(await fs.readFile(target, "utf8")));
  assert.deepEqual(await siblings(directory), ["state.json"]);
});

test("writeJsonAtomic creates missing parents and round-trips JSON", async (t) => {
  const directory = await scratch(t);
  const target = path.join(directory, "nested", "deeper", "doc.json");

  await writeJsonAtomic(target, { version: 1, items: [1, 2] }, {
    mkdirMode: 0o700,
    trailingNewline: true,
  });

  const text = await fs.readFile(target, "utf8");
  assert.ok(text.endsWith("\n"));
  assert.deepEqual(JSON.parse(text), { version: 1, items: [1, 2] });
  await assert.rejects(writeJsonAtomic(target, undefined), TypeError);
  assert.deepEqual(JSON.parse(await fs.readFile(target, "utf8")), { version: 1, items: [1, 2] });
});
