import assert from "node:assert/strict";
import test from "node:test";
import type { BotHealthReport } from "../../renderer/shared/bot-health.js";
import { registerBotHealthHandlers } from "./bot-health.js";

function register() {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const checked: string[] = [];
  const report: BotHealthReport = { botId: "bot-1", checkedAt: 1, trigger: "manual", results: [] };
  registerBotHealthHandlers({
    handle: (channel, handler) => handlers.set(channel, handler),
    report: (botId) => (botId === "bot-1" ? report : undefined),
    check: async (botId) => {
      checked.push(botId);
      return { ...report, botId };
    },
  });
  const invoke = (channel: string, input: unknown) => handlers.get(channel)!({}, input);
  return { invoke, checked };
}

test("report returns the newest report or null", async () => {
  const h = register();
  assert.equal(((await h.invoke("bots:health:report", { botId: "bot-1" })) as BotHealthReport).botId, "bot-1");
  assert.equal(await h.invoke("bots:health:report", { botId: "bot-2" }), null);
});

test("check runs the checks for that Bot once", async () => {
  const h = register();
  await h.invoke("bots:health:check", { botId: "bot-2" });
  assert.deepEqual(h.checked, ["bot-2"]);
});

test("extra fields are rejected before anything runs", async () => {
  const h = register();
  await assert.rejects(() => Promise.resolve(h.invoke("bots:health:check", { botId: "bot-2", force: true })));
  assert.deepEqual(h.checked, []);
});
