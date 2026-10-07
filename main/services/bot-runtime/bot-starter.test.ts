import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import type { BotCreateInput, BotDefinition } from "../../../renderer/shared/bots.js";
import { createBotCreationKeyStore } from "../bot-creation-keys.js";
import { createBotSessionService, type BotSessionRuntime } from "./bot-session-service.js";
import { createBotStarter, type BotStarterDeps } from "./bot-starter.js";
import { createBotLiveProjection } from "./live-projection.js";
import { recordingDeps } from "./test-support/fixtures.js";
import { createFauxModels, FAUX_MODEL_REF, type FauxModels } from "./test-support/faux.js";

const roots: string[] = [];
function tempDir(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "aiden-bot-starter-"));
  roots.push(root);
  return root;
}
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** Bots and their creation keys, persisted like production so a restart keeps them. */
function botDirectory(root: string) {
  const bots = new Map<string, BotDefinition>();
  const keys = createBotCreationKeyStore({ root: () => root });
  let next = 0;
  const created: BotCreateInput[] = [];
  const deps: Pick<BotStarterDeps, "findBotByCreationKey" | "createBot"> = {
    async findBotByCreationKey(key) {
      const botId = await keys.get(key);
      return botId === null ? null : (bots.get(botId) ?? null);
    },
    async createBot(input, _access, key) {
      // Creating takes a moment, so concurrent taps really overlap.
      await new Promise((resolve) => setTimeout(resolve, 20));
      next += 1;
      const bot = { id: `bot:${next}`, ...input } as BotDefinition;
      bots.set(bot.id, bot);
      created.push(input);
      await keys.set(key, bot.id);
      return bot;
    },
  };
  return { deps, bots, created };
}

async function sessionFor(profileDir: string, fauxModels: FauxModels, model = true): Promise<BotSessionRuntime> {
  return createBotSessionService({
    profileDir,
    models: fauxModels.models,
    extension: recordingDeps(),
    resolveModel: async () => (model ? FAUX_MODEL_REF : null),
    knownBotIds: async () => new Set(["bot:1"]),
  });
}

async function visibleTranscript(session: BotSessionRuntime, botId: string): Promise<string[]> {
  const projection = createBotLiveProjection({
    conversation: (id) => session.conversation(id),
    state: (id) => session.state(id),
  });
  const { snapshot, unsubscribe } = await projection.subscribe(botId, { send: () => undefined });
  unsubscribe();
  await projection.close();
  return snapshot.entries.map((entry) => (entry.type === "assistant" || entry.type === "user" ? `${entry.type}:${entry.text}` : entry.type));
}

test("Start Chat twice on one starter Bot makes one Bot and one self-intro", async () => {
  const profile = tempDir();
  const directory = botDirectory(profile);
  const fauxModels = createFauxModels([fauxAssistantMessage("Hi, I'm your Meal Planner.\nA) Plan this week\nB) Make a list")]);
  const session = await sessionFor(profile, fauxModels);
  try {
    const starter = createBotStarter({ ...directory.deps, session });
    const [first, second] = await Promise.all([
      starter.startFromPreset("meal-planner"),
      starter.startFromPreset("meal-planner"),
    ]);
    const third = await starter.startFromPreset("meal-planner");

    assert.equal(directory.created.length, 1);
    assert.equal(first.bot.id, second.bot.id);
    assert.equal(third.bot.id, first.bot.id);
    assert.deepEqual([first.created, second.created, third.created].filter(Boolean), [true]);
    assert.equal(directory.created[0]!.name, "Meal Planner");

    // The intro reply shows; the prompt that asked for it never does.
    const state = await session.state(first.bot.id);
    if (state.kind === "running") {
      await session.awaitReply(first.bot.id, state.submissionId, new AbortController().signal);
    }
    assert.equal(fauxModels.calls(), 1);
    assert.deepEqual(await visibleTranscript(session, first.bot.id), [
      "assistant:Hi, I'm your Meal Planner.\nA) Plan this week\nB) Make a list",
    ]);
  } finally {
    await session.shutdown();
  }
});

test("the self-intro is not sent again when the Bot is reopened after a restart", async () => {
  const profile = tempDir();
  const directory = botDirectory(profile);
  const fauxModels = createFauxModels([
    fauxAssistantMessage("Hello, I'm your Researcher."),
    fauxAssistantMessage("never asked"),
  ]);
  const before = await sessionFor(profile, fauxModels);
  const first = await createBotStarter({ ...directory.deps, session: before }).startFromPreset("researcher");
  const running = await before.state(first.bot.id);
  if (running.kind === "running") {
    await before.awaitReply(first.bot.id, running.submissionId, new AbortController().signal);
  }
  await before.shutdown();

  const after = await sessionFor(profile, fauxModels);
  try {
    const starter = createBotStarter({ ...directory.deps, session: after });
    const again = await starter.startFromPreset("researcher");
    // Even an explicit second intro request is deduped by its fixed request id.
    await starter.introduce(again.bot.id);
    await new Promise((resolve) => setTimeout(resolve, 100));

    assert.equal(again.bot.id, first.bot.id);
    assert.equal(again.created, false);
    assert.equal(again.introduced, false);
    assert.equal(fauxModels.calls(), 1);
    assert.deepEqual(await visibleTranscript(after, first.bot.id), ["assistant:Hello, I'm your Researcher."]);
  } finally {
    await after.shutdown();
  }
});

test("a starter Bot without an AI model is created but does not introduce itself", async () => {
  const profile = tempDir();
  const directory = botDirectory(profile);
  const fauxModels = createFauxModels([fauxAssistantMessage("never")]);
  const session = await sessionFor(profile, fauxModels, false);
  try {
    const result = await createBotStarter({ ...directory.deps, session }).startFromPreset("inbox-helper");
    assert.equal(result.created, true);
    assert.equal(result.introduced, false);
    assert.deepEqual(await session.state(result.bot.id), { kind: "needs_model" });
    assert.equal(fauxModels.calls(), 0);
  } finally {
    await session.shutdown();
  }
});
