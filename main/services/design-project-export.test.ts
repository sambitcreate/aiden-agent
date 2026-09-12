import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { writeDesignProjectExport } from "./design-project-export.js";

test("Design bundle publication atomically installs only the chosen bytes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "aiden-design-export-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = join(root, "prototype.zip");

  await writeDesignProjectExport(target, Buffer.from("first"));
  assert.equal(await readFile(target, "utf8"), "first");
  assert.equal((await stat(target)).mode & 0o777, 0o600);

  await writeDesignProjectExport(target, Buffer.from("second"));
  assert.equal(await readFile(target, "utf8"), "second");
});

test("Design bundle publication rejects empty or oversized inputs before touching disk", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "aiden-design-export-invalid-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = join(root, "prototype.zip");
  await assert.rejects(writeDesignProjectExport(target, Buffer.alloc(0)), /invalid/u);
  await assert.rejects(
    writeDesignProjectExport(target, new Uint8Array(82 * 1024 * 1024 + 1)),
    /invalid/u,
  );
  await assert.rejects(readFile(target), /ENOENT/u);
});
