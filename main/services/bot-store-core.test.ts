import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBotStore } from "./bot-store-core.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "aiden-bots-"));
  let timestamp = 100;
  return { root, store: createBotStore({ root: () => root, now: () => ++timestamp }) };
}

test("bot store persists create, edit, archive, and restore without deleting identity", async () => {
  const { root, store } = await fixture();
  try {
    const created = await store.create({
      name: "  Reviewer  ", description: "Checks changes", instructions: "Review carefully.", avatar: "prism",
    });
    assert.equal(created.name, "Reviewer");
    assert.deepEqual((await store.list()).map((bot) => bot.id), [created.id]);
    const updated = await store.update({
      id: created.id, name: "Reviewer", description: "Finds regressions",
      instructions: "Review carefully and cite evidence.", avatar: "orbit",
    });
    assert.equal(updated.avatar, "orbit");
    assert.equal(updated.createdAt, created.createdAt);
    assert.ok((await store.archive(created.id)).archivedAt);
    assert.deepEqual(await store.list(), []);
    assert.equal((await store.list(true)).length, 1);
    assert.equal((await store.restore(created.id)).archivedAt, undefined);
    const disk = JSON.parse(await readFile(join(root, "bots.json"), "utf8")) as { version: number; bots: unknown[] };
    assert.equal(disk.version, 1);
    assert.equal(disk.bots.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bot store filters malformed records and enforces bounded required fields", async () => {
  const { root } = await fixture();
  try {
    await writeFile(join(root, "bots.json"), JSON.stringify({ version: 99, bots: [{ id: "unsafe", name: "", instructions: "x" }] }));
    const store = createBotStore({ root: () => root });
    assert.deepEqual(await store.list(true), []);
    await assert.rejects(store.create({ name: "", instructions: "x", avatar: "spark" }), /name/u);
    await assert.rejects(
      store.create({ name: "x", instructions: "x".repeat(32_001), avatar: "spark" }),
      /instructions/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
