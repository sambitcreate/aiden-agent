import assert from "node:assert/strict";
import test from "node:test";
import { BOT_CONNECTOR_WATCH_CHANNELS as CHANNELS } from "../../renderer/shared/bot-connector-watches.js";
import { BotConnectorWatchError, type BotConnectorWatchService } from "../services/bot-routine-events/connector-service.js";
import { registerBotConnectorWatchHandlers } from "./bot-connector-watches.js";

test("registered watch IPC invokes the host service and returns a typed definitive conflict without private details", async () => {
  const handlers = new Map<string, (event: { active: boolean }, input: unknown) => Promise<unknown>>();
  let calls = 0;
  const service = { list: async () => { calls++; return { supported: true, templates: [], watches: [] }; }, update: async () => { calls++; throw new BotConnectorWatchError("revision_conflict", "Refresh this watch.", { currentRevision: "42", privateBinding: "secret" }); } } as unknown as BotConnectorWatchService;
  registerBotConnectorWatchHandlers({ handle: (channel, handler) => { handlers.set(channel, handler); }, requireOwner: (event: { active: boolean }) => { if (!event.active) throw new Error("Inactive renderer"); }, service: async () => service });
  assert.equal(handlers.size, 8);
  const list = await handlers.get(CHANNELS.list)!({ active: true }, { botId: "bot_test" });
  assert.deepEqual(list, { supported: true, templates: [], watches: [] });
  const rejection = await handlers.get(CHANNELS.update)!({ active: true }, { botId: "bot_test" });
  assert.deepEqual(rejection, { ok: false, code: "revision_conflict", message: "Refresh this watch.", currentRevision: "42" });
  await assert.rejects(handlers.get(CHANNELS.list)!({ active: false }, { botId: "bot_test" }), /Inactive renderer/);
  assert.equal(calls, 2, "inactive documents cannot invoke source services");
});

test("watch IPC rejects executable extra fields before loading the service", async () => {
  const handlers = new Map<string, (event: unknown, input: unknown) => Promise<unknown>>();
  let loaded = false;
  registerBotConnectorWatchHandlers({ handle: (channel, handler) => { handlers.set(channel, handler); }, requireOwner() {}, service: async () => { loaded = true; throw new Error("unexpected"); } });
  const result = await handlers.get(CHANNELS.create)!({}, { botId: "bot_test", arguments: { tool: "shell" } });
  assert.equal((result as { code: string }).code, "invalid_request"); assert.equal(loaded, false);
});


test("IPC accepts maximum UTF-16 prompts whose UTF-8 or escaped JSON exceeds sixty-four KiB", async () => {
  const handlers = new Map<string, (event: unknown, input: unknown) => Promise<unknown>>();
  const service = { create: async (input: { prompt: string }) => ({ id: "11111111-1111-4111-8111-111111111111", prompt: input.prompt }) } as unknown as BotConnectorWatchService;
  registerBotConnectorWatchHandlers({ handle: (channel, handler) => { handlers.set(channel, handler); }, requireOwner() {}, service: async () => service });
  for (const prompt of ["界".repeat(22_000), "\u0001".repeat(32_768)]) {
    const result = await handlers.get(CHANNELS.create)!({}, { botId: "bot_test", prompt });
    assert.equal((result as { id: string }).id, "11111111-1111-4111-8111-111111111111");
    assert.equal((result as { prompt: string }).prompt.length, prompt.length);
  }
});
