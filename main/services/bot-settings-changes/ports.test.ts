import assert from "node:assert/strict";
import { test } from "node:test";
import type { BotAccessView } from "../../../renderer/shared/bot-capabilities.js";
import { DEFAULT_BOT_AVATAR, type BotDefinition } from "../../../renderer/shared/bots.js";
import { BotComputerError } from "../bot-computers/types.js";
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
  /** Runs once, inside the next identity write, before its revision check. */
  let duringIdentityWrite: (() => void) | undefined;
  /** Runs once, right after the next identity write lands, before it returns. */
  let afterIdentityWrite: (() => void) | undefined;
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
      const hook = duringIdentityWrite;
      duringIdentityWrite = undefined;
      hook?.();
      if (input.expectedRevision !== bot.revision) throw new BotIdentityRevisionConflictError(bot.revision);
      botRevision += 1;
      bot = { ...bot, name: input.name, description: input.description, instructions: input.instructions, avatar: input.avatar, revision: `bot-${botRevision}` };
      const written = structuredClone(bot);
      const after = afterIdentityWrite;
      afterIdentityWrite = undefined;
      after?.();
      return written;
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
    raceIdentityWrite(edit: () => void) { duringIdentityWrite = edit; },
    followIdentityWrite(edit: () => void) { afterIdentityWrite = edit; },
    /** A desktop identity edit: moves only the Bot's revision. */
    renameOnDesktop(name: string) {
      botRevision += 1;
      bot = { ...bot, name, revision: `bot-${botRevision}` };
    },
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

test("a name and model change whose name write loses a race to a desktop edit changes neither", async () => {
  for (const mode of ["full", "custom"] as const) {
    const fake = stores(mode);
    const { revision } = await fake.ports.read(BOT);
    // The desktop renames the Bot after the up-front check, just before the store's own check.
    fake.raceIdentityWrite(() => fake.renameOnDesktop("Desk name"));

    await assert.rejects(fake.ports.write(BOT, { name: "Planner", model: FAST }, revision), BotSettingsConflictError);

    const after = await fake.current();
    assert.equal(after.name, "Desk name", mode);
    assert.deepEqual(after.model, { providerId: "provider:a", modelId: "model:slow" }, mode);
  }
});

test("a desktop rename landing between the name write and a refused model write stands", async () => {
  for (const mode of ["full", "custom"] as const) {
    const fake = stores(mode);
    const { revision } = await fake.ports.read(BOT);
    // The desktop renames the Bot right after this change's name write, then
    // saves access so the model half is refused and the name is put back.
    fake.followIdentityWrite(() => fake.renameOnDesktop("Desk name"));
    fake.raceAccessWrite(() => fake.bumpAccess());

    await assert.rejects(fake.ports.write(BOT, { name: "Planner", model: FAST }, revision), BotSettingsConflictError);

    const after = await fake.current();
    assert.equal(after.name, "Desk name", `${mode}: the undo must not overwrite the later desktop edit`);
    assert.deepEqual(after.model, { providerId: "provider:a", modelId: "model:slow" }, mode);
  }
});

test("a failed computer assignment in a combined settings patch leaves identity and model untouched", async () => {
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
  let botRevision = 1;
  let accessRevision = 1;
  const ports = createBotSettingsPorts({
    profileDir: () => "/unused",
    getBot: async () => structuredClone(bot),
    modelSelection: async () => ({ ...model }),
    getBotAccess: async () => ({
      botId: BOT,
      revision: `access-${accessRevision}`,
      policyEpoch: "1",
      summary: "",
      accessMode: "full",
    }),
    capabilityCatalog: async () => ({
      revision: "catalog-1",
      providers: [{ id: "provider:a", label: "A", available: true, models: [{ id: "model:fast", label: "Fast", available: true }] }],
    }),
    botWebSearchEnabled: async () => false,
    updateBotAccess: async ({ access }) => {
      const next = access.accessMode === "full" ? { providerId: access.providerId!, modelId: access.modelId! } : access.custom;
      model = { providerId: next.providerId, modelId: next.modelId };
      accessRevision += 1;
    },
    updateBot: async (input) => {
      botRevision += 1;
      bot = { ...bot, name: input.name, description: input.description, instructions: input.instructions, avatar: input.avatar, revision: `bot-${botRevision}` };
      return structuredClone(bot);
    },
    assignComputer: async () => {
      throw new Error("lume clone failed: out of disk");
    },
    cancelWakeUps: async () => {},
    broadcastChanged: () => {},
    appendEntry: async () => {},
  });

  const { revision } = await ports.read(BOT);
  await assert.rejects(
    ports.write(BOT, { name: "Renamed", model: FAST, computer: { kind: "new", name: "Big VM" } }, revision),
    /out of disk/u,
  );
  const after = (await ports.read(BOT)).values;
  assert.equal(after.name, "Chief");
  assert.deepEqual(after.model, { providerId: "provider:a", modelId: "model:slow" });
});

test("a combined computer + identity + model write rolls back the assignment and deletes a newly cloned VM when identity or model fails", async () => {
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
  let botRevision = 1;
  let accessRevision = 1;
  let currentComputer: { kind: "shared" } | { kind: "existing"; computerId: string } = { kind: "shared" };
  const vms = [{ id: "shared", name: "Shared computer", kind: "shared" as const }];
  const deletedVms: string[] = [];
  let broadcasts = 0;

  const ports = createBotSettingsPorts({
    profileDir: () => "/unused",
    getBot: async () => structuredClone(bot),
    modelSelection: async () => ({ ...model }),
    getBotAccess: async () => ({
      botId: BOT,
      revision: `access-${accessRevision}`,
      policyEpoch: "1",
      summary: "",
      accessMode: "full",
    }),
    capabilityCatalog: async () => ({
      revision: "catalog-1",
      providers: [{ id: "provider:a", label: "A", available: true, models: [{ id: "model:fast", label: "Fast", available: true }] }],
    }),
    botWebSearchEnabled: async () => false,
    readComputer: async () => currentComputer,
    listComputers: async () => vms.map((vm) => ({ ...vm })),
    assignComputer: async (_botId, target) => {
      if (target.kind === "new") {
        const createdId = "vm-leaked-1";
        vms.push({ id: createdId, name: target.name ?? "New", kind: "dedicated" as never });
        currentComputer = { kind: "existing", computerId: createdId };
      } else {
        currentComputer = target;
      }
    },
    deleteComputer: async (computerId) => {
      deletedVms.push(computerId);
      const idx = vms.findIndex((vm) => vm.id === computerId);
      if (idx >= 0) vms.splice(idx, 1);
    },
    updateBotAccess: async () => {
      throw new BotCapabilityRevisionConflictError("access-2");
    },
    updateBot: async (input) => {
      botRevision += 1;
      bot = { ...bot, name: input.name, description: input.description, instructions: input.instructions, avatar: input.avatar, revision: `bot-${botRevision}` };
      return structuredClone(bot);
    },
    cancelWakeUps: async () => {},
    broadcastChanged: () => {
      broadcasts += 1;
    },
    appendEntry: async () => {},
  });

  const { revision } = await ports.read(BOT);
  await assert.rejects(
    ports.write(BOT, { name: "Planner", model: FAST, computer: { kind: "new", name: "Big Box" } }, revision),
    BotSettingsConflictError,
  );
  assert.deepEqual(currentComputer, { kind: "shared" }, "assignment rolled back to shared");
  assert.deepEqual(deletedVms, ["vm-leaked-1"], "newly cloned VM was deleted instead of leaked");
  assert.equal(bot.name, "Chief", "identity write was undone");
  assert.deepEqual(model, { providerId: "provider:a", modelId: "model:slow" });
  assert.equal(broadcasts, 0, "clean full rollback did not need a partial broadcast");
});

test("rollbackComputer unassigns a previously computer-less Bot and deletes a freshly cloned shared VM on conflict", async () => {
  const makeCase = (opts: {
    initialComputer: { kind: "shared" } | { kind: "existing"; computerId: string } | null;
    initialVms: Array<{ id: string; name: string; kind: "shared" | "dedicated" }>;
  }) => {
    const bot: BotDefinition = {
      id: BOT,
      revision: "bot-1",
      name: "Chief",
      instructions: "Help me plan.",
      avatar: { ...DEFAULT_BOT_AVATAR },
      createdAt: 0,
      updatedAt: 0,
    };
    let currentComputer = opts.initialComputer;
    const vms = opts.initialVms.map((vm) => ({ ...vm }));
    const unassigned: string[] = [];
    const deleted: string[] = [];
    const ports = createBotSettingsPorts({
      profileDir: () => "/unused",
      getBot: async () => structuredClone(bot),
      modelSelection: async () => ({ providerId: "provider:a", modelId: "model:slow" }),
      getBotAccess: async () => ({
        botId: BOT,
        revision: "access-1",
        policyEpoch: "1",
        summary: "",
        accessMode: "full",
      }),
      capabilityCatalog: async () => ({
        revision: "catalog-1",
        providers: [{ id: "provider:a", label: "A", available: true, models: [{ id: "model:fast", label: "Fast", available: true }] }],
      }),
      botWebSearchEnabled: async () => false,
      readComputer: async () => currentComputer,
      listComputers: async () => vms.map((vm) => ({ ...vm })),
      assignComputer: async (_botId, target) => {
        if (target.kind === "shared") {
          if (!vms.some((vm) => vm.id === "shared")) {
            vms.push({ id: "shared", name: "Shared computer", kind: "shared" });
          }
          currentComputer = { kind: "shared" };
        } else if (target.kind === "existing") {
          currentComputer = target;
        }
      },
      unassignComputer: async (botId) => {
        unassigned.push(botId);
        currentComputer = null;
      },
      deleteComputer: async (computerId) => {
        deleted.push(computerId);
        const idx = vms.findIndex((vm) => vm.id === computerId);
        if (idx >= 0) vms.splice(idx, 1);
        if (currentComputer?.kind === "shared" && computerId === "shared") currentComputer = null;
      },
      updateBotAccess: async () => {},
      updateBot: async () => {
        throw new BotIdentityRevisionConflictError("bot-2");
      },
      cancelWakeUps: async () => {},
      broadcastChanged: () => {},
      appendEntry: async () => {},
    });
    return {
      ports,
      currentComputer: () => currentComputer,
      vms: () => vms,
      unassigned,
      deleted,
    };
  };

  // Case 1: no prior computer + "shared" already exists -> unassigns Bot without deleting "shared".
  const existingShared = makeCase({
    initialComputer: null,
    initialVms: [{ id: "shared", name: "Shared computer", kind: "shared" }],
  });
  const rev1 = (await existingShared.ports.read(BOT)).revision;
  await assert.rejects(
    existingShared.ports.write(BOT, { name: "Renamed", computer: { kind: "shared" } }, rev1),
    BotSettingsConflictError,
  );
  assert.deepEqual(existingShared.unassigned, [BOT]);
  assert.deepEqual(existingShared.deleted, []);
  assert.equal(existingShared.currentComputer(), null);
  assert.equal(existingShared.vms().length, 1);

  // Case 2: no prior computer + "shared" did NOT exist -> deletes freshly cloned "shared".
  const freshShared = makeCase({ initialComputer: null, initialVms: [] });
  const rev2 = (await freshShared.ports.read(BOT)).revision;
  await assert.rejects(
    freshShared.ports.write(BOT, { name: "Renamed", computer: { kind: "shared" } }, rev2),
    BotSettingsConflictError,
  );
  assert.deepEqual(freshShared.deleted, ["shared"]);
  assert.equal(freshShared.currentComputer(), null);
  assert.equal(freshShared.vms().length, 0);

  // Case 3: had "vm-old" + "shared" did NOT exist -> restores "vm-old" AND deletes freshly cloned "shared".
  const hadOld = makeCase({
    initialComputer: { kind: "existing", computerId: "vm-old" },
    initialVms: [{ id: "vm-old", name: "Old Box", kind: "dedicated" }],
  });
  const rev3 = (await hadOld.ports.read(BOT)).revision;
  await assert.rejects(
    hadOld.ports.write(BOT, { name: "Renamed", computer: { kind: "shared" } }, rev3),
    BotSettingsConflictError,
  );
  assert.deepEqual(hadOld.currentComputer(), { kind: "existing", computerId: "vm-old" });
  assert.deepEqual(hadOld.deleted, ["shared"]);
});

test("computer write fails before assignComputer when readComputer or listComputers fails", async () => {
  const bot: BotDefinition = {
    id: BOT,
    revision: "bot-1",
    name: "Chief",
    instructions: "Help me plan.",
    avatar: { ...DEFAULT_BOT_AVATAR },
    createdAt: 0,
    updatedAt: 0,
  };
  let assignCalls = 0;

  const makePorts = (overrides: { failRead?: boolean; failList?: boolean }) =>
    createBotSettingsPorts({
      profileDir: () => "/unused",
      getBot: async () => structuredClone(bot),
      modelSelection: async () => ({ providerId: "provider:a", modelId: "model:slow" }),
      getBotAccess: async () => ({
        botId: BOT,
        revision: "access-1",
        policyEpoch: "1",
        summary: "",
        accessMode: "full",
      }),
      capabilityCatalog: async () => ({ revision: "catalog-1", providers: [] }),
      botWebSearchEnabled: async () => false,
      readComputer: async () => {
        if (overrides.failRead) throw new Error("state store corrupt");
        return null;
      },
      listComputers: async () => {
        if (overrides.failList) throw new Error("lume state unavailable");
        return [];
      },
      assignComputer: async () => {
        assignCalls += 1;
      },
      updateBotAccess: async () => {},
      updateBot: async () => ({ revision: "bot-2" }),
      cancelWakeUps: async () => {},
      broadcastChanged: () => {},
      appendEntry: async () => {},
    });

  const readFailPorts = makePorts({ failRead: true });
  await assert.rejects(
    readFailPorts.write(BOT, { computer: { kind: "shared" } }, JSON.stringify(["bot-1", "access-1"])),
    /state store corrupt/u,
  );
  assert.equal(assignCalls, 0);

  const listFailPorts = makePorts({ failList: true });
  await assert.rejects(
    listFailPorts.write(BOT, { computer: { kind: "shared" } }, JSON.stringify(["bot-1", "access-1"])),
    /lume state unavailable/u,
  );
  assert.equal(assignCalls, 0);
});

test("rollback restores prior assignment before non-forced deleteComputer and preserves VM when another Bot attached", async () => {
  let bot: BotDefinition = {
    id: BOT,
    revision: "bot-1",
    name: "Chief",
    instructions: "Help me plan.",
    avatar: { ...DEFAULT_BOT_AVATAR },
    createdAt: 0,
    updatedAt: 0,
  };
  let botRevision = 1;
  let currentComputer: { kind: "shared" } | { kind: "existing"; computerId: string } = { kind: "shared" };
  const vms = [{ id: "shared", name: "Shared computer", kind: "shared" as const }];
  const operations: string[] = [];
  const deleteCalls: Array<{ computerId: string; options?: { force?: boolean; creationToken?: string } }> = [];

  const ports = createBotSettingsPorts({
    profileDir: () => "/unused",
    getBot: async () => structuredClone(bot),
    modelSelection: async () => ({ providerId: "provider:a", modelId: "model:slow" }),
    getBotAccess: async () => ({
      botId: BOT,
      revision: "access-1",
      policyEpoch: "1",
      summary: "",
      accessMode: "full",
    }),
    capabilityCatalog: async () => ({
      revision: "catalog-1",
      providers: [{ id: "provider:a", label: "A", available: true, models: [{ id: "model:fast", label: "Fast", available: true }] }],
    }),
    botWebSearchEnabled: async () => false,
    readComputer: async () => currentComputer,
    listComputers: async () => vms.map((vm) => ({ ...vm })),
    assignComputer: async (_botId, target) => {
      if (target.kind === "new") {
        const createdId = "vm-shared-later";
        operations.push(`assign-new:${createdId}`);
        vms.push({ id: createdId, name: target.name ?? "New", kind: "dedicated" as never });
        currentComputer = { kind: "existing", computerId: createdId };
        return { createdComputer: { computerId: createdId, creationToken: "token-123" } };
      }
      operations.push(`assign-restore:${target.kind}`);
      currentComputer = target;
      return undefined;
    },
    deleteComputer: async (computerId, options) => {
      operations.push(`delete:${computerId}`);
      deleteCalls.push({ computerId, options });
      throw new BotComputerError("busy", "Another Bot is now assigned to this computer.");
    },
    updateBotAccess: async () => {
      throw new BotCapabilityRevisionConflictError("access-2");
    },
    updateBot: async (input) => {
      botRevision += 1;
      bot = { ...bot, name: input.name, description: input.description, instructions: input.instructions, avatar: input.avatar, revision: `bot-${botRevision}` };
      return structuredClone(bot);
    },
    cancelWakeUps: async () => {},
    broadcastChanged: () => {},
    appendEntry: async () => {},
  });

  const { revision } = await ports.read(BOT);
  await assert.rejects(
    ports.write(BOT, { name: "Planner", model: FAST, computer: { kind: "new", name: "Shared Later" } }, revision),
    BotSettingsConflictError,
  );
  assert.deepEqual(operations, ["assign-new:vm-shared-later", "assign-restore:shared", "delete:vm-shared-later"]);
  assert.equal(deleteCalls.length, 1);
  assert.deepEqual(deleteCalls[0], {
    computerId: "vm-shared-later",
    options: { force: false, creationToken: "token-123" },
  });
  assert.deepEqual(currentComputer, { kind: "shared" });
  assert.equal(vms.some((vm) => vm.id === "vm-shared-later"), true, "VM busy with another Bot is preserved");
  assert.equal(bot.name, "Chief");
});
