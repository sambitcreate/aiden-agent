import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { registerBotRoutineModels, type BotRoutineModelSettingsPort } from "./bot-routine-models.js";

function fixture() {
  const handlers = new Map<string, (event: unknown, input: unknown) => Promise<unknown>>();
  let destroyed = false, invalidate = () => {}, effects = 0;
  let beforeSave = async () => {};
  const settings = { botId: "bot_test", routineId: "routine_test", revision: "revision_1", selection: { mode: "inherit" as const }, updatedAt: 1 };
  const service: BotRoutineModelSettingsPort = {
    listRoutines: async () => ({ botId: settings.botId, routines: [] }),
    resumeStatus: async () => ({ requiresUnknownCostAcknowledgement: false }),
    read: async () => settings,
    readRuns: async () => [],
    catalog: async () => ({ revision: "catalog_1", providers: [] }),
    save: async (input, lifetime) => { await beforeSave(); await lifetime.assertCurrent(); effects++; return { ok: true, mutationId: input.mutationId, replayed: false, settings }; },
  };
  registerBotRoutineModels({ handle: (channel, handler) => handlers.set(channel, handler), owner: () => ({ isDestroyed: () => destroyed, onInvalidated: (listener) => { invalidate = listener; return () => {}; } }), service: async () => service });
  return { settings, get effects() { return effects; }, invoke: (action: string, value: unknown) => handlers.get(`bots:routineModels:${action}`)!({}, value),
    destroy: () => { destroyed = true; invalidate(); }, beforeSave: (callback: () => Promise<void>) => { beforeSave = callback; } };
}
const save = () => ({ botId: "bot_test", routineId: "routine_test", mutationId: randomUUID(), expectedRevision: "revision_1", catalogRevision: "catalog_1", selection: { mode: "inherit" } });

test("registered model controls read settings and reject caller-authored private grants", async () => {
  const f = fixture();
  assert.deepEqual(await f.invoke("read", { botId: "bot_test", routineId: "routine_test" }), f.settings);
  await assert.rejects(f.invoke("save", { ...save(), grant: { connection: "forged" } }));
  await assert.rejects(f.invoke("catalog", { botId: "bot_test", routineId: "../other" }));
  assert.equal(f.effects, 0);
  const result = await f.invoke("save", save()) as { ok: boolean }; assert.equal(result.ok, true); assert.equal(f.effects, 1);
});
test("closing the document during a save prevents later authorization publication", async () => {
  const f = fixture(); let entered!: () => void, release!: () => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; }); const gate = new Promise<void>((resolve) => { release = resolve; });
  f.beforeSave(async () => { entered(); await gate; });
  const pending = f.invoke("save", save()); await ready; f.destroy(); release();
  await assert.rejects(pending); assert.equal(f.effects, 0);
});
