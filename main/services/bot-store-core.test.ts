import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBotStore } from "./bot-store-core.js";
import { DEFAULT_BOT_AVATAR } from "../../renderer/shared/bots.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "aiden-bots-"));
  let timestamp = 100;
  return { root, store: createBotStore({ root: () => root, now: () => ++timestamp }) };
}

test("bot store persists create and edit, and delete erases the record", async () => {
  const { root, store } = await fixture();
  try {
    const created = await store.create({
      name: "  Reviewer  ",
      description: "Checks changes",
      instructions: "Review carefully.",
      openingGreeting: "  What should we review?  ",
      avatar: { version: 1, shape: "hex", color: "sun" },
    });
    assert.equal(created.name, "Reviewer");
    assert.equal(created.openingGreeting, "What should we review?");
    assert.deepEqual(
      (await store.list()).map((bot) => bot.id),
      [created.id],
    );
    const updated = await store.update({
      id: created.id,
      expectedRevision: created.revision,
      name: "Reviewer",
      description: "Finds regressions",
      instructions: "Review carefully and cite evidence.",
      openingGreeting: "Start with the changed files.",
      avatar: { version: 1, shape: "orb", color: "sky" },
    });
    assert.deepEqual(updated.avatar, { version: 1, shape: "orb", color: "sky" });
    assert.equal(updated.openingGreeting, "Start with the changed files.");
    assert.equal(updated.createdAt, created.createdAt);
    const disk = JSON.parse(await readFile(join(root, "bots.json"), "utf8")) as {
      version: number;
      bots: unknown[];
    };
    assert.equal(disk.version, 1);
    assert.equal(disk.bots.length, 1);

    const shaped = await store.create({
      name: "Shaped",
      instructions: "Keep a full appearance.",
      avatar: { version: 1, shape: "orb", color: "aqua" },
    });
    assert.equal(await store.delete(shaped.id), true);
    assert.equal(await store.get(shaped.id), null);
    // Idempotent: a second delete finds nothing and changes nothing.
    assert.equal(await store.delete(shaped.id), false);
    assert.deepEqual((await store.list()).map(({ id }) => id), [created.id]);
    const after = JSON.parse(await readFile(join(root, "bots.json"), "utf8")) as {
      bots: Array<{ id: string }>;
    };
    assert.deepEqual(after.bots.map(({ id }) => id), [created.id]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy archived records are hidden and reported for erase until deleted", async () => {
  const { root, store } = await fixture();
  try {
    const live = await store.create({ name: "Live", instructions: "Stay.", avatar: { version: 1, shape: "orb", color: "sky" } });
    const disk = JSON.parse(await readFile(join(root, "bots.json"), "utf8")) as {
      version: number;
      bots: Array<Record<string, unknown>>;
    };
    disk.bots.push({
      id: "bot:archived-legacy",
      name: "Archived",
      instructions: "Archived by an older release.",
      avatar: "orbit",
      createdAt: 1,
      updatedAt: 2,
      archivedAt: 3,
    });
    await writeFile(join(root, "bots.json"), JSON.stringify(disk));
    const reopened = createBotStore({ root: () => root });

    assert.deepEqual((await reopened.list()).map(({ id }) => id), [live.id]);
    assert.equal(await reopened.get("bot:archived-legacy"), null);
    assert.equal("archivedAt" in ((await reopened.list())[0] ?? {}), false);
    assert.deepEqual(await reopened.legacyArchivedIds(), ["bot:archived-legacy"]);
    assert.deepEqual((await reopened.storedIds()).sort(), [live.id, "bot:archived-legacy"].sort());

    assert.equal(await reopened.delete("bot:archived-legacy"), true);
    assert.deepEqual(await reopened.legacyArchivedIds(), []);
    assert.deepEqual(await reopened.storedIds(), [live.id]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bot identity revisions cannot repeat when the wall clock is unchanged", async () => {
  const root = await mkdtemp(join(tmpdir(), "aiden-bots-same-clock-"));
  const store = createBotStore({ root: () => root, now: () => 100 });
  try {
    const created = await store.create({
      name: "ABA guard",
      instructions: "Never reuse an identity revision.",
      avatar: { version: 1, shape: "wisp", color: "lilac" },
    });
    const edited = await store.update({
      id: created.id,
      expectedRevision: created.revision,
      name: "Changed and restored",
      instructions: created.instructions,
      avatar: created.avatar,
    });
    const reverted = await store.update({
      id: created.id,
      expectedRevision: edited.revision,
      name: created.name,
      instructions: created.instructions,
      avatar: created.avatar,
    });
    assert.equal(reverted.name, created.name);
    assert.notEqual(reverted.revision, created.revision);
    await assert.rejects(
      store.update({
        id: created.id,
        expectedRevision: created.revision,
        name: "Stale write",
        instructions: created.instructions,
        avatar: created.avatar,
      }),
      /changed on another surface/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("main-owned creation can commit one pre-minted bounded identity exactly once", async () => {
  const { root, store } = await fixture();
  try {
    const input = {
      name: "Managed helper",
      instructions: "Use the main-owned lifecycle.",
      avatar: { version: 1 as const, shape: "wisp" as const, color: "lilac" as const },
    };
    const created = await store.createWithId("bot:managed-1", input);
    assert.equal(created.id, "bot:managed-1");
    assert.equal((await store.get("bot:managed-1"))?.name, "Managed helper");
    await assert.rejects(
      store.createWithId("bot:managed-1", input),
      /already exists/u,
    );
    for (const id of ["", "../escape", "bot/escape", "\u212b", "x".repeat(161)]) {
      await assert.rejects(store.createWithId(id, input), /Invalid bot id/u);
    }
    assert.equal((await store.list()).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bot identity text uses Unicode-scalar bounds and rejects unpaired UTF-16", async () => {
  const { root, store } = await fixture();
  try {
    const created = await store.createWithId("bot:unicode", {
      name: `${"n".repeat(79)}😀`,
      instructions: "Remain well formed.",
      avatar: { version: 1, shape: "wisp", color: "lilac" },
    });
    assert.equal(Array.from(created.name).length, 80);
    await assert.rejects(
      store.createWithId("bot:too-long", {
        name: `${"n".repeat(80)}😀`,
        instructions: "Remain bounded.",
        avatar: { version: 1, shape: "wisp", color: "lilac" },
      }),
      /name/u,
    );
    await assert.rejects(
      store.createWithId("bot:surrogate", {
        name: "private-\ud800-tail",
        instructions: "Remain well formed.",
        avatar: { version: 1, shape: "wisp", color: "lilac" },
      }),
      /name/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a stored avatar that is not a current recipe reads as the default and is rewritten on edit", async () => {
  const { root } = await fixture();
  try {
    await writeFile(
      join(root, "bots.json"),
      JSON.stringify({
        version: 1,
        bots: [
          { id: "bot:old-id", name: "Old id", instructions: "x", avatar: "spark", avatarAppearance: { version: 1, shape: "hex", color: "sun" }, createdAt: 1, updatedAt: 3 },
          { id: "bot:old-axes", name: "Old axes", instructions: "x", avatar: { version: 1, shape: "orb", color: "sky", eyes: "dots", detail: "none" }, createdAt: 1, updatedAt: 2 },
          { id: "bot:current", name: "Current", instructions: "x", avatar: { version: 1, shape: "peak", color: "plum" }, createdAt: 1, updatedAt: 1 },
        ],
      }),
    );
    const store = createBotStore({ root: () => root, now: () => 50 });
    const bots = await store.list();
    assert.deepEqual(
      bots.map((bot) => [bot.id, bot.avatar]),
      [
        ["bot:old-id", DEFAULT_BOT_AVATAR],
        ["bot:old-axes", DEFAULT_BOT_AVATAR],
        ["bot:current", { version: 1, shape: "peak", color: "plum" }],
      ],
    );
    const old = bots[0]!;
    const edited = await store.update({
      id: old.id,
      expectedRevision: old.revision,
      name: old.name,
      instructions: old.instructions,
      avatar: { version: 1, shape: "drop", color: "rose" },
    });
    assert.deepEqual(edited.avatar, { version: 1, shape: "drop", color: "rose" });
    const disk = JSON.parse(await readFile(join(root, "bots.json"), "utf8")) as {
      bots: Array<Record<string, unknown>>;
    };
    const written = disk.bots.find((bot) => bot.id === old.id)!;
    assert.deepEqual(written.avatar, { version: 1, shape: "drop", color: "rose" });
    assert.equal("avatarAppearance" in written, false);
    await assert.rejects(readFile(join(root, "bot-avatar-appearances.json"), "utf8"), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bot store rejects unsupported document versions and enforces bounded required fields", async (t) => {
  const { root } = await fixture();
  try {
    await writeFile(
      join(root, "bots.json"),
      JSON.stringify({ version: 99, bots: [{ id: "unsafe", name: "", instructions: "x" }] }),
    );
    const store = createBotStore({ root: () => root });
    await assert.rejects(store.list(), /unsupported version/u);
    assert.equal(
      await readFile(join(root, "bots.json"), "utf8"),
      JSON.stringify({ version: 99, bots: [{ id: "unsafe", name: "", instructions: "x" }] }),
    );
    const cleanRoot = await mkdtemp(join(tmpdir(), "aiden-bots-validation-"));
    t.after(() => rm(cleanRoot, { recursive: true, force: true }));
    const cleanStore = createBotStore({ root: () => cleanRoot });
    await assert.rejects(cleanStore.create({ name: "", instructions: "x", avatar: { version: 1, shape: "wisp", color: "lilac" } }), /name/u);
    await assert.rejects(
      cleanStore.create({ name: "x", instructions: "x".repeat(32_001), avatar: { version: 1, shape: "wisp", color: "lilac" } }),
      /instructions/u,
    );
    await assert.rejects(
      cleanStore.create({
        name: "x",
        instructions: "x",
        avatar: { version: 1, shape: "orb", color: "custom", eyes: "dots", detail: "none" },
      } as never),
      /avatar/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
