// Bot delete and Bot data, end to end on real stores in a temp profile:
// the durable session runtime, Bot identity, access, managed home, photo,
// chat rows and lifecycle journal, wired the way production wires them.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { BOT_FULL_ACCESS_NOTICE_VERSION } from "../../../renderer/shared/bot-capabilities.js";
import { createBotApplicationService } from "../bot-application-service.js";
import { createFileBotAvatarStore } from "../bot-avatar-store.js";
import type { BotAvatarNormalizer } from "../bot-avatar-store-core.js";
import { createBotCapabilityCatalogMainService } from "../bot-capability-catalog-main.js";
import { createBotCapabilityIncarnationStore } from "../bot-capability-incarnation-store.js";
import { createBotCapabilityInventoryPorts } from "../bot-capability-inventory-ports.js";
import { createBotCapabilityMigrationSeal } from "../bot-capability-migration-seal.js";
import { createBotCapabilityStore } from "../bot-capability-store.js";
import { createBotLegacyTranscriptWipeMarker } from "../bot-legacy-transcript-wipe.js";
import { createBotLifecycleJournal } from "../bot-lifecycle-journal.js";
import { createBotManagedWorkspaceService } from "../bot-managed-workspace.js";
import { BotMutationGate } from "../bot-mutation-gate.js";
import { createBotStore } from "../bot-store-core.js";
import { createChatStore } from "../chat-store-core.js";
import { createBotSessionService, type BotSessionRuntime } from "./bot-session-service.js";
import { botDirectoryName } from "./harness-host.js";
import { recordingDeps } from "./test-support/fixtures.js";
import { createFauxModels, FAUX_MODEL_REF, slowAnswer, waitFor, type FauxModels } from "./test-support/faux.js";

const OWNER = "owner:local-aiden";
const AUDIENCE = "desktop:local";

const roots: string[] = [];
after(async () => {
  for (const root of roots) await fs.rm(root, { recursive: true, force: true });
});

async function tempProfile(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-bot-delete-"));
  roots.push(root);
  await fs.mkdir(path.join(root, "bot-service"), { mode: 0o700 });
  await fs.mkdir(path.join(root, "chats"), { mode: 0o700 });
  return root;
}

function png(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(41);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  bytes[24] = 8;
  bytes[25] = 6;
  return bytes;
}

const normalizer: BotAvatarNormalizer = { async normalize() { return png(512, 512); } };

/** One process's view of the profile: fresh store instances, as after a restart. */
function openProfile(
  profile: string,
  options: { wipe?: boolean; failPhotoDeleteOnce?: boolean } = {},
) {
  const service = path.join(profile, "bot-service");
  const botStore = createBotStore({ root: () => profile });
  const capabilityStore = createBotCapabilityStore({ root: () => service });
  const catalog = createBotCapabilityCatalogMainService(
    createBotCapabilityInventoryPorts({
      loadOpaqueSelectionKey: async () => Buffer.alloc(32, 9),
      loadNoticeStatus: async () => ({
        version: BOT_FULL_ACCESS_NOTICE_VERSION,
        requiresAcknowledgement: false,
        acceptedAt: "2026-10-07T00:00:00.000Z",
        acceptedDecision: "continue_full",
      }),
      listProviders: async () => [{
        id: "provider",
        kind: "openai",
        label: "Provider",
        baseUrl: "https://provider.invalid/v1",
        models: ["chat"],
        needsKey: true,
        hasKey: true,
      }],
      providerCredentialSignature: async () => createHash("sha256").update("credential").digest("hex"),
      listMcpServers: async () => [],
      inspectMcpScopes: async () => [],
      listSkills: async () => [],
      listApprovedLocations: async () => [],
      incarnations: createBotCapabilityIncarnationStore(capabilityStore),
      getSettings: async () => ({}),
      webSearchAvailability: async () => ({ ready: false }),
      subagentsAvailable: () => false,
    }),
  );
  const managedWorkspace = createBotManagedWorkspaceService({ root: () => service });
  const chatStore = createChatStore(async () => path.join(profile, "chats"), async (id) => id);
  const avatars = createFileBotAvatarStore({ root: () => path.join(profile, "bot-avatar-store"), normalizer });
  const clearedJournals: string[] = [];
  let photoFailures = options.failPhotoDeleteOnce ? 1 : 0;
  const app = createBotApplicationService({
    botStore,
    chatStore,
    capabilityStore,
    catalog,
    managedWorkspace,
    lifecycleJournal: createBotLifecycleJournal({ root: () => service }),
    migrationSeal: createBotCapabilityMigrationSeal({ root: () => service }),
    mutationGate: new BotMutationGate(),
    deleteBotPhoto: async (botId) => {
      if (photoFailures > 0) {
        photoFailures -= 1;
        throw new Error("Aiden quit while erasing the photo.");
      }
      await avatars.deleteBot(botId);
    },
    ...(options.wipe === false
      ? {}
      : {
          legacyTranscriptWipe: {
            ...createBotLegacyTranscriptWipeMarker(() => profile),
            clearChatJournal: async (chatId: string) => void clearedJournals.push(chatId),
          },
        }),
  });
  return { app, botStore, capabilityStore, managedWorkspace, chatStore, avatars, clearedJournals };
}

type Profile = ReturnType<typeof openProfile>;

async function sessionFor(
  profile: string,
  opened: Profile,
  fauxModels: FauxModels,
  routines: Map<string, string[]>,
): Promise<BotSessionRuntime> {
  return createBotSessionService({
    profileDir: profile,
    models: fauxModels.models,
    extension: recordingDeps(),
    resolveModel: async () => FAUX_MODEL_REF,
    knownBotIds: async () => new Set((await opened.botStore.list()).map(({ id }) => id)),
    // Production order: routines and bindings, then the Bot's stored data.
    deleteEffects: [
      async (botId) => void routines.delete(botId),
      (botId) => opened.app.deleteBot({ botId }),
    ],
  });
}

async function createBotWithData(opened: Profile, name: string) {
  const bot = await opened.app.createBot({
    audienceId: AUDIENCE,
    bot: { name, instructions: `Help as ${name}.`, avatar: "spark", openingGreeting: "Hi!" },
  });
  const chat = await opened.app.createChat({ audienceId: AUDIENCE, botId: bot.id });
  await opened.avatars.put({
    ownerId: OWNER,
    botId: bot.id,
    expectedAssetRevision: null,
    operationId: `photo:${bot.id}`,
    source: { mimeType: "image/png", bytes: png(640, 640) },
  });
  const home = await opened.app.resolveManagedWorkspace(bot.id);
  await fs.writeFile(path.join(home.homePath, "memory.md"), `${name} remembers.`);
  return { bot, chat, homePath: home.homePath };
}

/** Everything a deleted Bot must no longer have, checked against the stores on disk. */
async function assertErased(profile: string, botId: string, homePath: string, chatId: string) {
  const fresh = openProfile(profile, { wipe: false });
  await fresh.app.initialize();
  assert.equal(await fresh.botStore.get(botId), null, "record");
  assert.equal((await fresh.botStore.storedIds()).includes(botId), false, "record on disk");
  assert.equal(existsSync(homePath), false, "managed home directory");
  assert.equal((await fresh.managedWorkspace.listBindings()).some((home) => home.botId === botId), false, "home binding");
  await assert.rejects(fresh.capabilityStore.getBotPolicy(botId), "access policy");
  await assert.rejects(fresh.capabilityStore.getChatPolicy(chatId), "chat access policy");
  assert.equal(await fresh.chatStore.get(chatId), null, "chat row");
  assert.deepEqual(await fresh.chatStore.listByBot(botId), [], "chat rows");
  assert.equal(await fresh.avatars.metadata(OWNER, botId), null, "photo");
  assert.equal(existsSync(path.join(profile, "bots", botDirectoryName(botId))), false, "session directory");
}

test("deleting a Bot mid-turn stops the provider and erases its session, photo, home, access, routines, chats and record", async () => {
  const profile = await tempProfile();
  const opened = openProfile(profile);
  await opened.app.initialize();
  const doomed = await createBotWithData(opened, "Doomed");
  const survivor = await createBotWithData(opened, "Survivor");
  const routines = new Map([[doomed.bot.id, ["routine-1"]], [survivor.bot.id, ["routine-2"]]]);
  const fauxModels = createFauxModels([slowAnswer(), fauxAssistantMessage("never")], { tokensPerSecond: 40 });
  const session = await sessionFor(profile, opened, fauxModels, routines);
  try {
    const sent = await session.send(doomed.bot.id, { text: "write a lot", requestId: "desk-1" });
    await waitFor(async () => (await session.state(doomed.bot.id)).kind === "running" && fauxModels.calls() === 1, {
      what: "turn start",
    });
    const waiting = session.awaitReply(doomed.bot.id, sent.submissionId, new AbortController().signal);

    await session.deleteBot(doomed.bot.id);

    assert.equal((await waiting).kind, "interrupted");
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(fauxModels.calls(), 1, "the provider stops receiving requests");
    assert.equal(routines.has(doomed.bot.id), false);
    assert.deepEqual((await opened.app.list()).map(({ id }) => id), [survivor.bot.id]);
    await assertErased(profile, doomed.bot.id, doomed.homePath, doomed.chat.id);

    // Idempotent: deleting again, through either layer, changes nothing.
    await session.deleteBot(doomed.bot.id);
    await opened.app.deleteBot({ botId: doomed.bot.id });

    // The other Bot keeps everything.
    assert.equal(routines.has(survivor.bot.id), true);
    assert.equal(await fs.readFile(path.join(survivor.homePath, "memory.md"), "utf8"), "Survivor remembers.");
    assert.notEqual(await opened.avatars.metadata(OWNER, survivor.bot.id), null);
    assert.equal((await opened.app.getCanonicalChat(survivor.bot.id))?.id, survivor.chat.id);
  } finally {
    await session.shutdown();
  }
});

test("a delete interrupted between steps leaves the Bot listed and finishes on retry or restart", async () => {
  const profile = await tempProfile();
  const opened = openProfile(profile, { failPhotoDeleteOnce: true });
  await opened.app.initialize();
  const first = await createBotWithData(opened, "First");
  const second = await createBotWithData(opened, "Second");
  const routines = new Map<string, string[]>();
  const session = await sessionFor(profile, opened, createFauxModels([]), routines);
  try {
    // The session is gone, but the stored-data step failed part-way.
    await assert.rejects(session.deleteBot(first.bot.id), /quit while erasing the photo/u);
    assert.deepEqual(
      (await opened.app.list()).map(({ id }) => id).sort(),
      [first.bot.id, second.bot.id].sort(),
      "the Bot stays listed so the person can delete it again",
    );

    // Retry in the same process.
    await session.deleteBot(first.bot.id);
    assert.deepEqual((await opened.app.list()).map(({ id }) => id), [second.bot.id]);
    await assertErased(profile, first.bot.id, first.homePath, first.chat.id);
  } finally {
    await session.shutdown();
  }

  // Interrupted again, then the app restarts instead of retrying.
  const crashed = openProfile(profile, { failPhotoDeleteOnce: true });
  await crashed.app.initialize();
  await assert.rejects(crashed.app.deleteBot({ botId: second.bot.id }), /quit while erasing the photo/u);
  assert.equal((await crashed.app.list()).length, 1);

  const restarted = openProfile(profile);
  await restarted.app.initialize();
  assert.deepEqual(await restarted.app.list(), []);
  await assertErased(profile, second.bot.id, second.homePath, second.chat.id);
});

test("Bots archived by an older release are erased at startup with all their data", async () => {
  const profile = await tempProfile();
  const before = openProfile(profile);
  await before.app.initialize();
  const archived = await createBotWithData(before, "Archived");
  const live = await createBotWithData(before, "Live");
  const fauxModels = createFauxModels([fauxAssistantMessage("hi")]);
  const oldSession = await sessionFor(profile, before, fauxModels, new Map());
  await oldSession.conversation(archived.bot.id);
  await oldSession.shutdown();

  // An older release archived the Bot instead of deleting it.
  const botsFile = path.join(profile, "bots.json");
  const disk = JSON.parse(await fs.readFile(botsFile, "utf8")) as { bots: Array<Record<string, unknown>> };
  for (const entry of disk.bots) if (entry.id === archived.bot.id) entry.archivedAt = Date.now();
  await fs.writeFile(botsFile, JSON.stringify(disk));

  const after = openProfile(profile);
  await after.app.initialize();
  assert.deepEqual((await after.app.list()).map(({ id }) => id), [live.bot.id]);
  const session = await sessionFor(profile, after, fauxModels, new Map());
  try {
    await session.initialize();
    await assertErased(profile, archived.bot.id, archived.homePath, archived.chat.id);
    assert.equal(await fs.readFile(path.join(live.homePath, "memory.md"), "utf8"), "Live remembers.");
  } finally {
    await session.shutdown();
  }
});

test("legacy Bot transcripts are wiped once, and the Bot keeps working afterwards", async () => {
  const profile = await tempProfile();
  // The previous release: no wipe, and Bot turns written into ChatStore.
  const legacy = openProfile(profile, { wipe: false });
  await legacy.app.initialize();
  await legacy.app.acknowledgeNotice(AUDIENCE, {
    version: BOT_FULL_ACCESS_NOTICE_VERSION,
    decision: "continue_full",
    confirmedForeground: true,
  });
  const { bot, chat } = await createBotWithData(legacy, "Chatty");
  // A second, historical Bot chat: policy first, then the chat, as Bot chat creation does.
  const accessCatalog = await legacy.app.capabilityCatalog(AUDIENCE, bot.id);
  await legacy.capabilityStore.createChatPolicy({
    chatId: "historical-chat",
    botId: bot.id,
    expectedBotPolicyRevision: (await legacy.capabilityStore.getBotPolicy(bot.id)).revision,
    catalog: accessCatalog,
  });
  const historical = await legacy.chatStore.create({
    id: "historical-chat",
    title: "Old",
    workspaceId: (await legacy.app.resolveManagedWorkspace(bot.id)).workspaceId,
    botId: bot.id,
  });
  await legacy.chatStore.appendMessage(historical.id, { role: "user", content: "older secret" });
  // The canonical chat is the one with the newest activity.
  await legacy.chatStore.appendMessage(chat.id, { role: "user", content: "remember my secret" });
  await legacy.chatStore.appendMessage(chat.id, { role: "assistant", content: "I will." });

  const upgraded = openProfile(profile);
  await upgraded.app.initialize();
  const canonical = await upgraded.chatStore.get(chat.id);
  assert.deepEqual(canonical?.messages, [], "the canonical chat keeps its row with an empty transcript");
  assert.equal(canonical?.botId, bot.id);
  assert.equal(await upgraded.chatStore.get(historical.id), null, "historical chats are removed");
  await assert.rejects(upgraded.capabilityStore.getChatPolicy(historical.id));
  assert.deepEqual(upgraded.clearedJournals, [chat.id]);
  assert.equal((await upgraded.chatStore.listByBot(bot.id))[0]?.preview, undefined);

  // The Bot still works: its authority admits against the same chat, and a turn runs.
  assert.equal((await upgraded.app.getCanonicalChat(bot.id))?.id, chat.id);
  assert.equal(
    await upgraded.app.authorizeRetainedChat({ audienceId: AUDIENCE, botId: bot.id, chatId: chat.id, access: "write" }),
    true,
  );
  const fauxModels = createFauxModels([fauxAssistantMessage("fresh start")]);
  const session = await sessionFor(profile, upgraded, fauxModels, new Map());
  try {
    const sent = await session.send(bot.id, { text: "hello again", requestId: "after-wipe" });
    const reply = await session.awaitReply(bot.id, sent.submissionId, new AbortController().signal);
    assert.deepEqual(reply, { kind: "completed", text: "fresh start" });
  } finally {
    await session.shutdown();
  }

  // The wipe never repeats.
  await upgraded.chatStore.appendMessage(chat.id, { role: "user", content: "new message" });
  const again = openProfile(profile);
  await again.app.initialize();
  assert.equal((await again.chatStore.get(chat.id))?.messages.length, 1);
  assert.deepEqual(again.clearedJournals, []);
});
