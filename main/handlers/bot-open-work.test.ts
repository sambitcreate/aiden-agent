import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { registerBotOpenWorkHandlers } from "./bot-open-work.js";
import { BOT_OPEN_WORK_CHANNELS as CHANNELS, type BotOpenWorkResult } from "../../renderer/shared/bot-open-work.js";
import { createBotOpenWorkStore } from "../services/bot-open-work/store.js";
import { createBotOpenWorkService } from "../services/bot-open-work/service.js";

test("registered Open work IPC uses exact owner controls, stable replay and no model submission for Add", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "aiden-open-work-ipc-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  let inspected = 0; let stopped = 0;
  const service = createBotOpenWorkService({ store: createBotOpenWorkStore({ profileDir: () => root, botExists: async () => true }), execution: { inspect: async () => { inspected++; return { kind: "missing" }; }, stop: async () => { stopped++; return "not_running"; } } });
  const handlers = new Map<string, (event: { active: boolean }, value: unknown) => Promise<unknown>>();
  registerBotOpenWorkHandlers({ handle: (channel, handler) => { handlers.set(channel, handler); }, owner: (event: { active: boolean }) => ({ isDestroyed: () => !event.active }), service: async () => service });
  assert.equal(handlers.size, 3);
  const before = await service.snapshot("bot_test");
  const input = { botId: "bot_test", mutation: { action: "add", mutationId: randomUUID(), expectedRevision: before.revision, title: "Review the brief", note: "Check the assumptions." } };
  const first = await handlers.get(CHANNELS.mutate)!({ active: true }, input) as BotOpenWorkResult;
  assert.equal(first.ok, true); if (!first.ok) return;
  assert.deepEqual(first.snapshot.items[0]!.source, { kind: "person" }); assert.deepEqual(first.snapshot.items[0]!.links, []);
  assert.equal(inspected, 0); assert.equal(stopped, 0);
  const replay = await handlers.get(CHANNELS.mutate)!({ active: true }, input) as BotOpenWorkResult;
  assert.equal(replay.ok && replay.replayed, true); assert.equal(replay.ok && replay.itemId, first.itemId);
  assert.equal(await handlers.get(CHANNELS.evidence)!({ active: true }, { botId: "bot_test", id: first.itemId, kind: "source" }), null);
  await assert.rejects(handlers.get(CHANNELS.snapshot)!({ active: false }, { botId: "bot_test" }), /inactive/u);
  const denied = await handlers.get(CHANNELS.mutate)!({ active: true }, { ...input, mutation: { ...input.mutation, source: { submissionId: "42" } } }) as BotOpenWorkResult;
  assert.equal(denied.ok, false); assert.equal(!denied.ok && denied.code, "invalid"); assert.equal((await service.snapshot("bot_test")).items.length, 1);
});

test("IPC evidence accepts item-owned kind selection and refuses arbitrary source/result identities", async () => {
  let lookups = 0;
  const handlers = new Map<string, (event: unknown, value: unknown) => Promise<unknown>>();
  registerBotOpenWorkHandlers({ handle: (channel, handler) => { handlers.set(channel, handler); }, owner: () => ({ isDestroyed: () => false }), service: async () => ({ snapshot: async () => { throw new Error("unused"); }, mutateByPerson: async () => { throw new Error("unused"); }, evidence: async () => { lookups++; return undefined; } }) });
  await assert.rejects(handlers.get(CHANNELS.evidence)!({}, { botId: "bot_test", id: "item", kind: "source", entryId: "900" }), /Invalid Open work/u);
  await assert.rejects(handlers.get(CHANNELS.evidence)!({}, { botId: "bot_test", id: "item", kind: "arbitrary-url" }), /Invalid Open work/u);
  assert.equal(lookups, 0);
});
