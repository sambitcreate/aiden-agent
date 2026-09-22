import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBotStore } from "./bot-store-core.js";
import {
  BOT_AVATARS,
  BOT_AVATAR_SHAPES,
  resolveBotAvatar,
} from "../../renderer/shared/bots.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "aiden-bots-"));
  let timestamp = 100;
  return { root, store: createBotStore({ root: () => root, now: () => ++timestamp }) };
}

test("bot store persists create, edit, archive, and restore without deleting identity", async () => {
  const { root, store } = await fixture();
  try {
    const created = await store.create({
      name: "  Reviewer  ",
      description: "Checks changes",
      instructions: "Review carefully.",
      openingGreeting: "  What should we review?  ",
      avatar: "prism",
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
      avatar: "orbit",
    });
    assert.equal(updated.avatar, "orbit");
    assert.equal(updated.openingGreeting, "Start with the changed files.");
    assert.equal(updated.createdAt, created.createdAt);
    const archived = await store.archive(created.id, updated.revision);
    assert.ok(archived.archivedAt);
    assert.deepEqual(await store.list(), []);
    assert.equal((await store.list(true)).length, 1);
    assert.equal((await store.restore(created.id, archived.revision)).archivedAt, undefined);
    const disk = JSON.parse(await readFile(join(root, "bots.json"), "utf8")) as {
      version: number;
      bots: unknown[];
    };
    assert.equal(disk.version, 1);
    assert.equal(disk.bots.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bot identity revisions reject stale update, archive, and restore mutations", async () => {
  const { root, store } = await fixture();
  try {
    const created = await store.create({
      name: "Revision guard",
      instructions: "Reject stale identity writes.",
      avatar: "spark",
    });
    const updated = await store.update({
      id: created.id,
      expectedRevision: created.revision,
      name: "Revision guard updated",
      instructions: "Reject every stale identity write.",
      avatar: "orbit",
    });
    assert.notEqual(updated.revision, created.revision);

    await assert.rejects(
      store.update({
        id: created.id,
        expectedRevision: created.revision,
        name: "Stale overwrite",
        instructions: "This must not commit.",
        avatar: "leaf",
      }),
      /changed on another surface/u,
    );
    await assert.rejects(
      store.archive(created.id, created.revision),
      /changed on another surface/u,
    );

    const archived = await store.archive(created.id, updated.revision);
    assert.notEqual(archived.revision, updated.revision);
    await assert.rejects(
      store.restore(created.id, updated.revision),
      /changed on another surface/u,
    );

    const restored = await store.restore(created.id, archived.revision);
    assert.notEqual(restored.revision, archived.revision);
    assert.equal(restored.archivedAt, undefined);
    assert.equal(restored.name, "Revision guard updated");
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
      avatar: "spark",
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
    const archived = await store.archive(created.id, reverted.revision);
    const restored = await store.restore(created.id, archived.revision);

    assert.equal(restored.name, created.name);
    assert.equal(restored.archivedAt, undefined);
    assert.notEqual(reverted.revision, created.revision);
    assert.notEqual(restored.revision, created.revision);
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
      avatar: "spark" as const,
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
    assert.equal((await store.list(true)).length, 1);
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
      avatar: "spark",
    });
    assert.equal(Array.from(created.name).length, 80);
    await assert.rejects(
      store.createWithId("bot:too-long", {
        name: `${"n".repeat(80)}😀`,
        instructions: "Remain bounded.",
        avatar: "spark",
      }),
      /name/u,
    );
    await assert.rejects(
      store.createWithId("bot:surrogate", {
        name: "private-\ud800-tail",
        instructions: "Remain well formed.",
        avatar: "spark",
      }),
      /name/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bot store persists versioned custom appearances while retaining legacy ids", async () => {
  const { root, store } = await fixture();
  try {
    const avatar = {
      version: 1,
      shape: "squircle",
      color: "peach",
      eyes: "happy",
      detail: "halo",
    } as const;
    const created = await store.create({
      name: "Designer",
      instructions: "Keep the interface coherent.",
      avatar,
    });
    assert.deepEqual(created.avatar, avatar);
    assert.deepEqual((await store.get(created.id))?.avatar, avatar);
    const persisted = JSON.parse(await readFile(join(root, "bots.json"), "utf8")) as {
      bots: Array<{ avatar: unknown; avatarAppearance?: unknown }>;
    };
    const persistedAppearances = JSON.parse(
      await readFile(join(root, "bot-avatar-appearances.json"), "utf8"),
    ) as { appearances: Array<{ botId: string; legacyAvatar: unknown; avatar: unknown }> };
    assert.equal(typeof persisted.bots[0]?.avatar, "string");
    assert.deepEqual(persisted.bots[0]?.avatarAppearance, avatar);
    assert.deepEqual(
      persistedAppearances.appearances.find((entry) => entry.botId === created.id)?.avatar,
      avatar,
    );
    assert.equal(
      persistedAppearances.appearances.find((entry) => entry.botId === created.id)?.legacyAvatar,
      "spark",
    );
    const legacy = await store.create({
      name: "Legacy",
      instructions: "Keep working.",
      avatar: "spark",
    });
    assert.equal((await store.get(legacy.id))?.avatar, "spark");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("custom faces survive a real previous-release projection and mutation", async () => {
  const { root, store } = await fixture();
  try {
    const expected = new Map<string, ReturnType<typeof resolveBotAvatar>>();
    for (const shape of BOT_AVATAR_SHAPES) {
      const avatar = {
        version: 1 as const,
        shape,
        color: "aqua" as const,
        eyes: "focus" as const,
        detail: "orbit" as const,
      };
      const created = await store.create({
        name: `Bot ${shape}`,
        instructions: "Stay available across releases.",
        avatar,
      });
      expected.set(created.id, avatar);
    }
    const legacy = await store.create({
      name: "Legacy edit",
      instructions: "Keep the identity.",
      avatar: "orbit",
    });
    const legacyAppearance = resolveBotAvatar(legacy.avatar);
    await store.update({
      id: legacy.id,
      expectedRevision: legacy.revision,
      name: legacy.name,
      instructions: legacy.instructions,
      avatar: legacyAppearance,
    });
    expected.set(legacy.id, legacyAppearance);
    const editedLegacy = await store.get(legacy.id);
    await store.archive(legacy.id, editedLegacy!.revision);

    const disk = JSON.parse(await readFile(join(root, "bots.json"), "utf8")) as {
      bots: Array<Record<string, unknown>>;
    };
    const previousReleaseProjection = disk.bots
      .filter(
        (bot) => typeof bot.avatar === "string" && BOT_AVATARS.includes(bot.avatar as never),
      )
      .map((bot) => ({
        id: bot.id,
        name: bot.name,
        ...(typeof bot.description === "string" ? { description: bot.description } : {}),
        instructions: bot.instructions,
        avatar: bot.avatar,
        createdAt: bot.createdAt,
        updatedAt: bot.updatedAt,
        ...(typeof bot.archivedAt === "number" ? { archivedAt: bot.archivedAt } : {}),
      }));
    assert.equal(previousReleaseProjection.length, BOT_AVATAR_SHAPES.length + 1);
    assert.equal(previousReleaseProjection.find((bot) => bot.id === legacy.id)?.avatar, "orbit");
    const downgradedAvatarId = previousReleaseProjection[0]?.id as string;
    expected.delete(downgradedAvatarId);
    previousReleaseProjection[0] = {
      ...previousReleaseProjection[0],
      name: "Edited while downgraded",
      avatar: "orbit",
      updatedAt: Number(previousReleaseProjection[0]?.updatedAt) + 1,
    };
    await writeFile(
      join(root, "bots.json"),
      `${JSON.stringify({ version: 1, bots: previousReleaseProjection }, null, 2)}\n`,
    );

    const restored = createBotStore({ root: () => root });
    const restoredBots = await restored.list(true);
    assert.equal(restoredBots.length, BOT_AVATAR_SHAPES.length + 1);
    assert.equal(
      restoredBots.find((bot) => bot.id === previousReleaseProjection[0]?.id)?.name,
      "Edited while downgraded",
    );
    assert.equal(restoredBots.find((bot) => bot.id === downgradedAvatarId)?.avatar, "orbit");
    for (const [botId, avatar] of expected) {
      assert.deepEqual(restoredBots.find((bot) => bot.id === botId)?.avatar, avatar);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("readers never observe a companion appearance before the primary update commits", async () => {
  const root = await mkdtemp(join(tmpdir(), "aiden-bots-atomic-"));
  let blockWrite = false;
  let entered!: () => void;
  let release!: () => void;
  const writeEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const writeRelease = new Promise<void>((resolve) => {
    release = resolve;
  });
  const store = createBotStore({
    root: () => root,
    beforeBotWrite: async () => {
      if (!blockWrite) return;
      entered();
      await writeRelease;
      throw new Error("forced primary publication failure");
    },
  });
  try {
    const original = {
      version: 1 as const,
      shape: "squircle" as const,
      color: "peach" as const,
      eyes: "happy" as const,
      detail: "halo" as const,
    };
    const created = await store.create({
      name: "Atomic",
      instructions: "Never expose a partial face update.",
      avatar: original,
    });
    blockWrite = true;
    const update = store.update({
      id: created.id,
      expectedRevision: created.revision,
      name: created.name,
      instructions: created.instructions,
      avatar: { ...original, shape: "capsule" },
    });
    await writeEntered;

    let readSettled = false;
    const read = store.list(true).then((bots) => {
      readSettled = true;
      return bots;
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    assert.equal(readSettled, false);

    release();
    await assert.rejects(update, /forced primary publication failure/u);
    assert.deepEqual((await read).find((bot) => bot.id === created.id)?.avatar, original);
  } finally {
    release?.();
    await rm(root, { recursive: true, force: true });
  }
});

test("restart ignores an uncommitted companion face with the same legacy projection", async () => {
  const { root, store } = await fixture();
  try {
    const committed = {
      version: 1 as const,
      shape: "squircle" as const,
      color: "peach" as const,
      eyes: "happy" as const,
      detail: "halo" as const,
    };
    const uncommitted = {
      version: 1 as const,
      shape: "capsule" as const,
      color: "aqua" as const,
      eyes: "focus" as const,
      detail: "bolts" as const,
    };
    const created = await store.create({
      name: "Crash-safe",
      instructions: "Expose only committed identity.",
      avatar: committed,
    });
    const appearancePath = join(root, "bot-avatar-appearances.json");
    const appearanceState = JSON.parse(await readFile(appearancePath, "utf8")) as {
      version: number;
      appearances: Array<{ botId: string; legacyAvatar: string; avatar: unknown }>;
    };
    const entry = appearanceState.appearances.find((candidate) => candidate.botId === created.id);
    assert.ok(entry);
    entry.legacyAvatar = "spark";
    entry.avatar = uncommitted;
    await writeFile(appearancePath, `${JSON.stringify(appearanceState, null, 2)}\n`);

    const restarted = createBotStore({ root: () => root });
    const restored = await restarted.get(created.id);
    assert.equal(restored?.name, "Crash-safe");
    assert.equal(restored?.instructions, "Expose only committed identity.");
    assert.deepEqual(restored?.avatar, committed);
    const repairedAppearanceState = JSON.parse(await readFile(appearancePath, "utf8")) as {
      appearances: Array<{ botId: string; avatar: unknown }>;
    };
    assert.deepEqual(
      repairedAppearanceState.appearances.find((candidate) => candidate.botId === created.id)
        ?.avatar,
      committed,
    );

    const botPath = join(root, "bots.json");
    const botState = JSON.parse(await readFile(botPath, "utf8")) as {
      version: number;
      bots: Array<Record<string, unknown>>;
    };
    botState.bots = botState.bots.map(({ avatarAppearance: _appearance, ...bot }) =>
      bot.id === created.id ? { ...bot, name: "Edited while downgraded" } : bot,
    );
    await writeFile(botPath, `${JSON.stringify(botState, null, 2)}\n`);

    const upgradedAgain = createBotStore({ root: () => root });
    const restoredAgain = await upgradedAgain.get(created.id);
    assert.equal(restoredAgain?.name, "Edited while downgraded");
    assert.deepEqual(restoredAgain?.avatar, committed);
    const backfilledBotState = JSON.parse(await readFile(botPath, "utf8")) as {
      bots: Array<{ id: string; avatarAppearance?: unknown }>;
    };
    assert.deepEqual(
      backfilledBotState.bots.find((bot) => bot.id === created.id)?.avatarAppearance,
      committed,
    );

    const crashAppearanceState = JSON.parse(await readFile(appearancePath, "utf8")) as {
      appearances: Array<{ botId: string; legacyAvatar: string; avatar: unknown }>;
    };
    const crashEntry = crashAppearanceState.appearances.find(
      (candidate) => candidate.botId === created.id,
    );
    assert.ok(crashEntry);
    crashEntry.legacyAvatar = "spark";
    crashEntry.avatar = uncommitted;
    await writeFile(appearancePath, `${JSON.stringify(crashAppearanceState, null, 2)}\n`);

    const afterInterruptedEdit = createBotStore({ root: () => root });
    assert.deepEqual((await afterInterruptedEdit.get(created.id))?.avatar, committed);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an older-release primary rewrite cannot publish a newer uncommitted companion face", async () => {
  const { root, store } = await fixture();
  try {
    const committed = {
      version: 1 as const,
      shape: "squircle" as const,
      color: "peach" as const,
      eyes: "happy" as const,
      detail: "halo" as const,
    };
    const uncommitted = {
      ...committed,
      shape: "capsule" as const,
      color: "aqua" as const,
    };
    const created = await store.create({
      name: "Rollback-safe face",
      instructions: "Keep companion writes tied to the primary commit.",
      avatar: committed,
    });
    const appearancePath = join(root, "bot-avatar-appearances.json");
    const primaryPath = join(root, "bots.json");
    const appearances = JSON.parse(await readFile(appearancePath, "utf8")) as {
      appearances: Array<{ botId: string; primaryRevision?: string; avatar: unknown }>;
    };
    const pending = appearances.appearances.find((entry) => entry.botId === created.id)!;
    pending.avatar = uncommitted;
    pending.primaryRevision = `botavatar_${"a".repeat(43)}`;
    await writeFile(appearancePath, `${JSON.stringify(appearances, null, 2)}\n`);

    const primary = JSON.parse(await readFile(primaryPath, "utf8")) as {
      bots: Array<{ id: string; avatarAppearance?: unknown }>;
    };
    const olderReleaseBot = primary.bots.find((entry) => entry.id === created.id)!;
    delete olderReleaseBot.avatarAppearance;
    await writeFile(primaryPath, `${JSON.stringify(primary, null, 2)}\n`);

    const restarted = createBotStore({ root: () => root });
    const restored = await restarted.get(created.id);
    assert.equal(restored?.avatar, "spark");
    assert.notDeepEqual(restored?.avatar, uncommitted);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("restart prunes orphan companions before enforcing appearance capacity", async () => {
  const root = await mkdtemp(join(tmpdir(), "aiden-bots-orphans-"));
  try {
    const avatar = {
      version: 1 as const,
      shape: "orb" as const,
      color: "lilac" as const,
      eyes: "dots" as const,
      detail: "none" as const,
    };
    await writeFile(
      join(root, "bot-avatar-appearances.json"),
      `${JSON.stringify(
        {
          version: 1,
          appearances: Array.from({ length: 256 }, (_, index) => ({
            botId: `orphan-${index}`,
            legacyAvatar: "orbit",
            avatar,
          })),
        },
        null,
        2,
      )}\n`,
    );

    const restarted = createBotStore({ root: () => root });
    const created = await restarted.create({
      name: "First real bot",
      instructions: "Create after orphan recovery.",
      avatar,
    });
    assert.deepEqual(created.avatar, avatar);
    const appearanceState = JSON.parse(
      await readFile(join(root, "bot-avatar-appearances.json"), "utf8"),
    ) as { appearances: Array<{ botId: string }> };
    assert.deepEqual(appearanceState.appearances.map((entry) => entry.botId), [created.id]);
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
    await assert.rejects(store.list(true), /unsupported version/u);
    assert.equal(
      await readFile(join(root, "bots.json"), "utf8"),
      JSON.stringify({ version: 99, bots: [{ id: "unsafe", name: "", instructions: "x" }] }),
    );
    const cleanRoot = await mkdtemp(join(tmpdir(), "aiden-bots-validation-"));
    t.after(() => rm(cleanRoot, { recursive: true, force: true }));
    const cleanStore = createBotStore({ root: () => cleanRoot });
    await assert.rejects(cleanStore.create({ name: "", instructions: "x", avatar: "spark" }), /name/u);
    await assert.rejects(
      cleanStore.create({ name: "x", instructions: "x".repeat(32_001), avatar: "spark" }),
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
