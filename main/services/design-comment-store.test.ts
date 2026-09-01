import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { DesignCommentTargetV1 } from "./design-comment-contract.js";
import {
  DesignCommentRevisionConflictError,
  DesignCommentStore,
  DesignCommentUnavailableError,
} from "./design-comment-store.js";

function target(
  mediaId = "design:revision-one",
  artifactId = "a".repeat(64),
): DesignCommentTargetV1 {
  return {
    projectId: "project:one",
    lineageId: "lineage:hero",
    mediaId,
    element: {
      selector: '[data-aiden-id="hero"]',
      selectorMatchCount: 1,
      tagName: "section",
    },
    source: { kind: "generated-artifact", artifactId },
  };
}

async function temporaryStore(nowValues = [100, 200, 300, 400, 500]) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-design-comments-"));
  const ids = ["comment:one", "comment:two"];
  const store = new DesignCommentStore({
    root: () => root,
    now: () => nowValues.shift() ?? 1_000,
    mintCommentId: () => ids.shift() ?? "comment:fallback",
  });
  await store.initialize();
  return { root, store };
}

test("create, resolve, reopen use database and comment CAS and persist owner-only", async (t) => {
  const { root, store } = await temporaryStore();
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const created = await store.create({
    expectedDatabaseRevision: 0,
    target: target(),
    body: "Tighten the spacing.",
  });
  assert.equal(created.revision, 1);
  assert.equal(created.status, "open");
  await assert.rejects(
    store.create({
      expectedDatabaseRevision: 0,
      target: target(),
      body: "Stale writer",
    }),
    DesignCommentRevisionConflictError,
  );

  const resolved = await store.resolve({
    id: created.id,
    expectedRevision: created.revision,
    expectedDatabaseRevision: 1,
  });
  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.resolvedAt, 200);
  await assert.rejects(
    store.reopen({
      id: created.id,
      expectedRevision: 1,
      expectedDatabaseRevision: 2,
    }),
    (error: unknown) =>
      error instanceof DesignCommentRevisionConflictError && error.currentCommentRevision === 2,
  );
  const reopened = await store.reopen({
    id: created.id,
    expectedRevision: 2,
    expectedDatabaseRevision: 2,
  });
  assert.equal(reopened.status, "open");
  assert.equal(reopened.resolvedAt, undefined);

  const mode = (await fs.stat(path.join(root, "design-comments.json"))).mode & 0o777;
  assert.equal(mode, 0o600);
  const restarted = new DesignCommentStore({ root: () => root });
  await restarted.initialize();
  assert.equal((await restarted.listProject("project:one")).comments[0]?.status, "open");
});

test("reconcile marks old revision or source identity stale and never revives it", async (t) => {
  const { root, store } = await temporaryStore();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const created = await store.create({
    expectedDatabaseRevision: 0,
    target: target(),
    body: "Keep this attached to one immutable revision.",
  });
  const reconciled = await store.reconcileTarget({
    expectedDatabaseRevision: 1,
    current: target("design:revision-two", "b".repeat(64)),
  });
  const stale = reconciled.comments[0];
  assert.equal(stale?.stale, true);
  assert.equal(stale?.revision, created.revision + 1);
  assert.equal(reconciled.databaseRevision, 2);
  const again = await store.reconcileTarget({
    expectedDatabaseRevision: 2,
    current: target(),
  });
  assert.equal(again.databaseRevision, 2);
  assert.equal(again.comments[0]?.stale, true);
});

test("same-revision reconciliation does not stale comments on a different exact element", async (t) => {
  const { root, store } = await temporaryStore();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await store.create({
    expectedDatabaseRevision: 0,
    target: target(),
    body: "This targets the hero.",
  });
  const other = target();
  other.element = {
    selector: '[data-aiden-id="footer"]',
    selectorMatchCount: 1,
    tagName: "footer",
  };
  const reconciled = await store.reconcileTarget({
    expectedDatabaseRevision: 1,
    current: other,
  });
  assert.equal(reconciled.databaseRevision, 1);
  assert.equal(reconciled.comments[0]?.stale, false);
});

test("project cascade deletion is idempotent and rejects comments added after confirmation", async (t) => {
  const { root, store } = await temporaryStore();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const first = await store.create({
    expectedDatabaseRevision: 0,
    target: target(),
    body: "Captured by the deletion preview.",
  });
  assert.equal(await store.deleteProject("project:one", [first.id]), 1);
  assert.equal(await store.deleteProject("project:one", [first.id]), 0);
  const later = await store.create({
    expectedDatabaseRevision: 2,
    target: target(),
    body: "Created after the old confirmation.",
  });
  await assert.rejects(store.deleteProject("project:one", [first.id]), /changed after deletion/u);
  assert.equal((await store.listProject("project:one")).comments[0]?.id, later.id);
});

test("corrupt and unsafe stores fail closed without overwriting", async (t) => {
  for (const [name, contents] of [
    ["corrupt", "{not-json"],
    ["unsafe", JSON.stringify({ version: 99, revision: 0, comments: [] })],
  ] as const) {
    await t.test(name, async (nested) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-design-comments-bad-"));
      nested.after(() => fs.rm(root, { recursive: true, force: true }));
      const file = path.join(root, "design-comments.json");
      await fs.writeFile(file, contents);
      const store = new DesignCommentStore({ root: () => root });
      await store.initialize();
      assert.equal(store.availability().available, false);
      await assert.rejects(store.listProject("project:one"), DesignCommentUnavailableError);
      assert.equal(await fs.readFile(file, "utf8"), contents);
    });
  }
});
