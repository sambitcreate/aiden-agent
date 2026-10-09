import assert from "node:assert/strict";
import test from "node:test";
import {
  BOT_PRESETS,
  botPresetAvatar,
  botPresetCreateInput,
  botPresetIdempotencyKey,
  createBotPresetCreator,
  getBotPreset,
  type BotPresetStore,
} from "./bot-presets.js";
import { connectionSuggestionFor } from "./bot-connections.js";
import { BOT_LIMITS, isBotAvatarAppearance, type BotCreateInput, type BotDefinition } from "./bots.js";

test("the four starter Bots are available by id", () => {
  assert.deepEqual(
    BOT_PRESETS.map((preset) => preset.name),
    ["Chief of Staff", "Meal Planner", "Inbox Helper", "Researcher"],
  );
  for (const preset of BOT_PRESETS) {
    assert.equal(getBotPreset(preset.id), preset);
  }
  assert.equal(getBotPreset("nope"), null);
  assert.equal(getBotPreset("__proto__"), null);
});

test("every preset creates a valid Bot whose suggested connections can be set up", () => {
  for (const preset of BOT_PRESETS) {
    const input = botPresetCreateInput(preset);
    assert.ok(isBotAvatarAppearance(input.avatar), `${preset.id} avatar`);
    assert.equal(input.name, preset.name);
    assert.equal(input.description, preset.subtitle);
    assert.ok(input.name.length <= BOT_LIMITS.nameChars);
    assert.ok((input.description ?? "").length <= BOT_LIMITS.descriptionChars);
    assert.ok(input.instructions.trim().length > 0);
    assert.ok(input.instructions.length <= 1_200, `${preset.id} instructions stay short`);
    assert.ok(preset.suggestedConnections.length > 0);
    for (const pluginId of preset.suggestedConnections) {
      assert.ok(connectionSuggestionFor(pluginId), `${preset.id} suggests ${pluginId}`);
    }
  }
});

test("starter characters are distinct so the carousel never shows twins", () => {
  const looks = BOT_PRESETS.map((preset) => {
    const avatar = botPresetAvatar(preset);
    return `${avatar.shape}/${avatar.color}`;
  });
  assert.equal(new Set(looks).size, looks.length);
});

test("preset copy avoids internal jargon", () => {
  for (const preset of BOT_PRESETS) {
    const copy = [preset.name, preset.subtitle, preset.instructions, preset.suggestedRoutine?.name ?? ""]
      .join(" ");
    assert.doesNotMatch(copy, /\b(Pi|provider|workspace|capability|canonical|MCP)\b/iu, preset.id);
  }
});

function memoryStore() {
  const byKey = new Map<string, BotDefinition>();
  const creates: Array<{ input: BotCreateInput; key: string }> = [];
  const store: BotPresetStore = {
    async findBotByCreationKey(key) {
      await Promise.resolve();
      return byKey.get(key) ?? null;
    },
    async createBot(input, key) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      creates.push({ input, key });
      const bot: BotDefinition = {
        id: `bot-${creates.length}`,
        revision: "1",
        name: input.name,
        description: input.description,
        instructions: input.instructions,
        avatar: input.avatar,
        createdAt: 1,
        updatedAt: 1,
      };
      byKey.set(key, bot);
      return bot;
    },
  };
  return { store, creates };
}

test("Start Chat twice gives one Bot, and only the first call counts as created", async () => {
  const { store, creates } = memoryStore();
  const createFromPreset = createBotPresetCreator(store);
  const first = await createFromPreset("meal-planner");
  const second = await createFromPreset("meal-planner");
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.bot.id, first.bot.id);
  assert.equal(creates.length, 1);
  assert.equal(creates[0]?.key, "preset:meal-planner");
  assert.equal(botPresetIdempotencyKey("meal-planner"), "preset:meal-planner");
});

test("concurrent Start Chat taps create one Bot", async () => {
  const { store, creates } = memoryStore();
  const createFromPreset = createBotPresetCreator(store);
  const results = await Promise.all([
    createFromPreset("researcher"),
    createFromPreset("researcher"),
    createFromPreset("researcher"),
  ]);
  assert.equal(creates.length, 1);
  assert.equal(new Set(results.map((result) => result.bot.id)).size, 1);
  assert.equal(results.filter((result) => result.created).length, 1);
});

test("different presets create different Bots", async () => {
  const { store, creates } = memoryStore();
  const createFromPreset = createBotPresetCreator(store);
  await Promise.all([createFromPreset("researcher"), createFromPreset("inbox-helper")]);
  assert.deepEqual(creates.map((create) => create.key).sort(), [
    "preset:inbox-helper",
    "preset:researcher",
  ]);
});

test("an unknown preset is refused without touching the store", async () => {
  const { store, creates } = memoryStore();
  await assert.rejects(createBotPresetCreator(store)("nope"), /isn't available/u);
  assert.equal(creates.length, 0);
});

test("a failed create can be retried", async () => {
  let attempts = 0;
  const createFromPreset = createBotPresetCreator({
    async findBotByCreationKey() {
      return null;
    },
    async createBot(input) {
      attempts += 1;
      if (attempts === 1) throw new Error("disk full");
      return { id: "bot-1", revision: "1", name: input.name, instructions: input.instructions, avatar: input.avatar, createdAt: 1, updatedAt: 1 };
    },
  });
  await assert.rejects(createFromPreset("researcher"), /disk full/u);
  assert.equal((await createFromPreset("researcher")).created, true);
});
