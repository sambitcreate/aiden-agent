import assert from "node:assert/strict";
import { test } from "node:test";
import type { BotAccessView } from "../../../renderer/shared/bot-capabilities.js";
import { DEFAULT_BOT_AVATAR, type BotDefinition } from "../../../renderer/shared/bots.js";
import { BotCapabilityRevisionConflictError } from "../bot-capability-store-core.js";
import { BotIdentityRevisionConflictError } from "../bot-store-core.js";
import { createBotSettingsPorts } from "./ports.js";
import { BotSettingsConflictError } from "./service.js";

const BOT = "bot:one";
const FAST = { providerId: "provider:a", modelId: "model:fast" };

/**
 * One Bot in two in-memory stores that behave like the real ones: the Bot
 * record and its access each carry their own revision, every write is a
 * compare-and-swap on it, and a desktop edit to either moves only its own.
 */
function stores(accessMode: "full" | "custom" = "full") {
  let bot: BotDefinition = {
    id: BOT,
    revision: "bot-1",
    name: "Chief",
    instructions: "Help me plan.",
    avatar: { ...DEFAULT_BOT_AVATAR },
    createdAt: 0,
    updatedAt: 0,
  };
  let model = { providerId: "provider:a", modelId: "model:slow" };
  let accessRevision = 1;
  let accessReadable = true;
  /** Runs once, inside the next access write, before its revision check. */
  let duringAccessWrite: (() => void) | undefined;
  let botRevision = 1;
  const view = (): BotAccessView => {
    const base = { botId: BOT, revision: `access-${accessRevision}`, policyEpoch: "1", summary: "" };
    return accessMode === "full"
      ? { ...base, accessMode: "full" }
      : {
          ...base,
          accessMode: "custom",
          custom: { ...model, fileScopeIds: ["scope:docs"], shellEnabled: false, connectionIds: [], skillIds: [], otherCapabilityIds: [] },
        };
  };
  const ports = createBotSettingsPorts({
    profileDir: () => "/unused",
    getBot: async () => structuredClone(bot),
    modelSelection: async () => ({ ...model }),
    getBotAccess: async () => {
      if (!accessReadable) throw new Error("access store unavailable");
      return view();
    },
    capabilityCatalog: async () => ({
      revision: "catalog-1",
      providers: [{ id: "provider:a", label: "A", available: true, models: [{ id: "model:fast", label: "Fast", available: true }] }],
    }),
    botWebSearchEnabled: async () => false,
    updateBotAccess: async ({ expectedRevision, access }) => {
      const hook = duringAccessWrite;
      duringAccessWrite = undefined;
      hook?.();
      if (expectedRevision !== `access-${accessRevision}`) throw new BotCapabilityRevisionConflictError(`access-${accessRevision}`);
      const next = access.accessMode === "full" ? { providerId: access.providerId!, modelId: access.modelId! } : access.custom;
      model = { providerId: next.providerId, modelId: next.modelId };
      accessRevision += 1;
    },
    updateBot: async (input) => {
      if (input.expectedRevision !== bot.revision) throw new BotIdentityRevisionConflictError(bot.revision);
      botRevision += 1;
      bot = { ...bot, name: input.name, description: input.description, instructions: input.instructions, avatar: input.avatar, revision: `bot-${botRevision}` };
    },
    cancelWakeUps: async () => {},
    broadcastChanged: () => {},
    appendEntry: async () => {},
  });
  return {
    ports,
    /** A desktop model or tools edit: moves only the access revision. */
    bumpAccess() { accessRevision += 1; },
    setAccessReadable(readable: boolean) { accessReadable = readable; },
    raceAccessWrite(edit: () => void) { duringAccessWrite = edit; },
    current: () => ports.read(BOT).then(({ values }) => values),
  };
}

test("a model change decided before a desktop access edit is refused and writes nothing", async () => {
  const fake = stores();
  const { revision } = await fake.ports.read(BOT);
  fake.bumpAccess();

  await assert.rejects(fake.ports.write(BOT, { name: "Planner", model: FAST }, revision), BotSettingsConflictError);

  const after = await fake.current();
  assert.equal(after.name, "Chief");
  assert.deepEqual(after.model, { providerId: "provider:a", modelId: "model:slow" });
});

test("a name or description change does not care that the access moved since the read", async () => {
  const fake = stores();
  const { revision } = await fake.ports.read(BOT);
  fake.bumpAccess();

  await fake.ports.write(BOT, { name: "Planner", description: "Keeps my week" }, revision);

  const after = await fake.current();
  assert.equal(after.name, "Planner");
  assert.equal(after.description, "Keeps my week");
});

test("when the Bot's access can't be read, a model change is refused and nothing is written", async () => {
  const fake = stores();
  fake.setAccessReadable(false);
  const { revision } = await fake.ports.read(BOT);

  // Still unreadable at write time.
  await assert.rejects(fake.ports.write(BOT, { name: "Planner", model: FAST }, revision));
  // Readable again: the change was decided on no access revision at all.
  fake.setAccessReadable(true);
  await assert.rejects(fake.ports.write(BOT, { name: "Planner", model: FAST }, revision), BotSettingsConflictError);

  const after = await fake.current();
  assert.equal(after.name, "Chief");
  assert.deepEqual(after.model, { providerId: "provider:a", modelId: "model:slow" });
});

test("a name and model change whose model write loses a race leaves the name as it was", async () => {
  for (const mode of ["full", "custom"] as const) {
    const fake = stores(mode);
    const { revision } = await fake.ports.read(BOT);
    // The desktop saves access after the up-front check, just before the store's own check.
    fake.raceAccessWrite(() => fake.bumpAccess());

    await assert.rejects(fake.ports.write(BOT, { name: "Planner", model: FAST }, revision), BotSettingsConflictError);

    const after = await fake.current();
    assert.equal(after.name, "Chief", mode);
    assert.deepEqual(after.model, { providerId: "provider:a", modelId: "model:slow" }, mode);
  }
});

test("an uncontested name and model change lands both", async () => {
  for (const mode of ["full", "custom"] as const) {
    const fake = stores(mode);
    const { revision } = await fake.ports.read(BOT);

    await fake.ports.write(BOT, { name: "Planner", model: FAST }, revision);

    const after = await fake.current();
    assert.equal(after.name, "Planner", mode);
    assert.deepEqual(after.model, FAST, mode);
  }
});
