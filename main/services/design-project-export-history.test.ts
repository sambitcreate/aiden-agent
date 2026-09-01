import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { DesignProjectExportHistoryStore } from "./design-project-export-history.js";

test("records only user-chosen absolute export locations and returns opaque reveal handles", async (t) => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "aiden-design-export-history-"),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new DesignProjectExportHistoryStore({
    root: () => root,
    now: () => 123,
    mintId: () => "export:one",
  });
  await store.initialize();
  const filePath = path.join(root, "prototype.zip");
  const result = await store.record({
    projectId: "project:one",
    lineageId: "lineage:one",
    mediaId: "design:one",
    contentHash: "a".repeat(64),
    filePath,
  });
  assert.deepEqual(result, { id: "export:one", fileName: "prototype.zip" });
  assert.deepEqual(await store.latestForProject("project:one"), result);
  assert.equal((await store.get(result.id))?.filePath, filePath);
  assert.equal(
    (await fs.stat(path.join(root, "design-project-exports.json"))).mode &
      0o777,
    0o600,
  );
});

test("rejects relative paths and fails closed on corrupt history", async (t) => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "aiden-design-export-history-bad-"),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new DesignProjectExportHistoryStore({ root: () => root });
  await store.initialize();
  await assert.rejects(
    store.record({
      projectId: "project:one",
      lineageId: "lineage:one",
      mediaId: "design:one",
      contentHash: "a".repeat(64),
      filePath: "relative.zip",
    }),
    /Invalid Design export history record/u,
  );

  const corruptRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "aiden-design-export-history-corrupt-"),
  );
  t.after(() => fs.rm(corruptRoot, { recursive: true, force: true }));
  const file = path.join(corruptRoot, "design-project-exports.json");
  await fs.writeFile(file, "{bad-json");
  const corrupt = new DesignProjectExportHistoryStore({
    root: () => corruptRoot,
  });
  await corrupt.initialize();
  assert.equal(corrupt.availability().available, false);
  await assert.rejects(corrupt.get("export:one"), /unreadable/u);
  assert.equal(await fs.readFile(file, "utf8"), "{bad-json");
});
