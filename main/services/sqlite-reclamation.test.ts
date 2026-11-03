import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { initializeSqliteReclamation, reclaimSqlitePages } from "./sqlite-reclamation.js";

function pragma(database: DatabaseSync, name: string): number {
  return Number(Object.values(database.prepare(`PRAGMA ${name}`).get()!)[0]);
}

test("new stores reclaim a bounded number of deleted pages and retain live rows across reopen", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "aiden-sqlite-reclaim-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "store.sqlite");
  const database = new DatabaseSync(file);
  initializeSqliteReclamation(database);
  assert.equal(pragma(database, "auto_vacuum"), 2);
  database.exec("CREATE TABLE payload (id INTEGER PRIMARY KEY, bytes BLOB); BEGIN");
  const insert = database.prepare("INSERT INTO payload VALUES (?, zeroblob(8192))");
  for (let id = 0; id < 512; id++) insert.run(id);
  database.exec("COMMIT; DELETE FROM payload WHERE id > 0");
  const before = statSync(file).size;
  const freeBefore = pragma(database, "freelist_count");
  reclaimSqlitePages(database);
  const reclaimed = freeBefore - pragma(database, "freelist_count");
  assert.ok(reclaimed > 0 && reclaimed <= 128, `reclaimed ${reclaimed} pages`);
  assert.ok(statSync(file).size < before, "returns pages to the filesystem");
  assert.ok(pragma(database, "freelist_count") > 0, "large backlog is left for later passes");
  database.close();
  const reopened = new DatabaseSync(file);
  try {
    initializeSqliteReclamation(reopened);
    assert.equal(pragma(reopened, "auto_vacuum"), 2);
    assert.equal(reopened.prepare("SELECT length(bytes) AS size FROM payload WHERE id=0").get()?.size, 8192);
    assert.equal(reopened.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok");
  } finally {
    reopened.close();
  }
});

test("existing databases retain their format and contents without a full rewrite", () => {
  for (const mode of [0, 1]) {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(`PRAGMA auto_vacuum=${mode}; CREATE TABLE payload (text TEXT); INSERT INTO payload VALUES ('keep')`);
      initializeSqliteReclamation(database);
      reclaimSqlitePages(database);
      assert.equal(pragma(database, "auto_vacuum"), mode);
      assert.equal(database.prepare("SELECT text FROM payload").get()?.text, "keep");
    } finally {
      database.close();
    }
  }
});

test("a competing writer defers reclamation without changing committed rows", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "aiden-sqlite-busy-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "store.sqlite");
  const database = new DatabaseSync(file);
  initializeSqliteReclamation(database);
  database.exec("CREATE TABLE payload (text TEXT); INSERT INTO payload VALUES ('keep')");
  const blocker = new DatabaseSync(file);
  try {
    blocker.exec("BEGIN IMMEDIATE");
    reclaimSqlitePages(database);
    assert.equal(database.prepare("SELECT text FROM payload").get()?.text, "keep");
    blocker.exec("ROLLBACK");
    database.exec("INSERT INTO payload VALUES ('still writable')");
    assert.equal(database.prepare("SELECT count(*) AS count FROM payload").get()?.count, 2);
  } finally {
    blocker.close();
    database.close();
  }
});
