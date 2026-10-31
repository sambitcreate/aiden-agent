import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import {
  BOT_RULE_CHANNELS,
  defaultBotRules,
  type BotRulesUpdateResult,
  type BotRulesView,
} from "../../renderer/shared/bot-rules.js";
import { createBotRuleStore } from "../services/bot-rules/store.js";
import { botExistsIn } from "./bot-memory.js";
import { registerBotRuleHandlers } from "./bot-rules.js";

const BOT = "bot:chief";
const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function setup() {
  const root = mkdtempSync(path.join(os.tmpdir(), "aiden-bot-rules-ipc-"));
  roots.push(root);
  const bots = new Map([[BOT, { id: BOT }]]);
  // The Bot store answers null for a Bot it doesn't have.
  const botExists = botExistsIn({ get: async (botId) => bots.get(botId) ?? null });
  const rules = createBotRuleStore({ profileDir: root, knownBot: botExists });
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  registerBotRuleHandlers({ handle: (channel, handler) => handlers.set(channel, handler), rules, botExists });
  const get = (botId: unknown) => Promise.resolve(handlers.get(BOT_RULE_CHANNELS.get)!({}, botId)) as Promise<BotRulesView>;
  const update = (input: unknown) =>
    Promise.resolve(handlers.get(BOT_RULE_CHANNELS.update)!({}, input)) as Promise<BotRulesUpdateResult>;
  return { bots, rules, get, update };
}

test("a Bot's rules round-trip: change a built-in rule, add, edit and remove one of its own", async () => {
  const { get, update, rules } = setup();
  assert.deepEqual(await get(BOT), { botId: BOT, revision: 0, rules: defaultBotRules() });

  const changed = await update({ botId: BOT, revision: 0, change: { type: "set_behavior", ruleId: "default.purchase", behavior: "hand_off" } });
  assert.equal(changed.ok, true);
  const added = await update({ botId: BOT, revision: 1, change: { type: "add_custom", text: "book a flight", behavior: "ask" } });
  assert.equal(added.ok, true);
  const custom = added.view.rules.find((rule) => rule.text === "book a flight")!;
  const edited = await update({ botId: BOT, revision: 2, change: { type: "edit_custom", ruleId: custom.id, behavior: "hand_off" } });
  assert.equal(edited.ok, true);

  // What the next turn enforces is what the page shows.
  const view = await get(BOT);
  assert.equal(view.revision, 3);
  assert.deepEqual(await rules.rules(BOT), view.rules);
  assert.equal(view.rules.find((rule) => rule.id === "default.purchase")!.behavior, "hand_off");
  assert.equal(view.rules.find((rule) => rule.id === custom.id)!.behavior, "hand_off");

  const removed = await update({ botId: BOT, revision: 3, change: { type: "remove_custom", ruleId: custom.id } });
  assert.equal(removed.ok, true);
  assert.equal((await get(BOT)).rules.some((rule) => rule.id === custom.id), false);
});

test("a refused edit is a result with the current rules, and changes nothing", async () => {
  const { get, update } = setup();
  await update({ botId: BOT, revision: 0, change: { type: "add_custom", text: "order food", behavior: "ask" } });
  const before = await get(BOT);
  const refusals: Array<[unknown, string]> = [
    [{ type: "set_behavior", ruleId: "locked.money", behavior: "ask" }, "locked"],
    [{ type: "remove_custom", ruleId: "default.delete" }, "locked"],
    [{ type: "remove_custom", ruleId: "custom.0b8a3f5e-2c11-4d5f-9b7a-0123456789ab" }, "not_found"],
    [{ type: "add_custom", text: "x".repeat(121), behavior: "ask" }, "invalid"],
    [{ type: "add_custom", text: "do something", behavior: "ask" }, "invalid"],
  ];
  for (const [change, reason] of refusals) {
    const result = await update({ botId: BOT, revision: before.revision, change });
    assert.equal(result.ok, false, JSON.stringify(change));
    assert.equal(!result.ok && result.reason, reason, JSON.stringify(change));
    assert.deepEqual(result.view, before);
  }
  // Another window's edit made against the old revision.
  const stale = await update({ botId: BOT, revision: 0, change: { type: "add_custom", text: "book a hotel", behavior: "ask" } });
  assert.equal(!stale.ok && stale.reason, "stale");
  assert.deepEqual(stale.view, before);
  assert.deepEqual(await get(BOT), before);
});

test("malformed requests throw, and an unknown or deleted Bot has no rules", async () => {
  const { bots, get, update } = setup();
  await assert.rejects(get(42), /Invalid bot id/u);
  await assert.rejects(get("bot/../../etc"), /Invalid bot id/u);
  await assert.rejects(get("bot:someone-else"), /no longer exists/u);

  const valid = { botId: BOT, revision: 0, change: { type: "set_behavior", ruleId: "default.purchase", behavior: "ask" } };
  for (const input of [
    null,
    [],
    { botId: BOT, revision: 0 },
    { ...valid, extra: true },
    { ...valid, revision: -1 },
    { ...valid, revision: 1.5 },
    { ...valid, revision: "0" },
    { ...valid, change: { ...valid.change, behavior: "allowed" } },
    { ...valid, change: { ...valid.change, text: "smuggled" } },
    { ...valid, change: { type: "set_behavior", ruleId: "../rules", behavior: "ask" } },
    { ...valid, change: { type: "rewrite_all", rules: [] } },
    { ...valid, change: { type: "toString" } },
    { ...valid, change: { type: "add_custom", text: 7, behavior: "ask" } },
    { ...valid, change: { type: "add_custom", text: "x".repeat(5_000), behavior: "ask" } },
    { ...valid, change: { type: "edit_custom", ruleId: "custom.0b8a3f5e-2c11-4d5f-9b7a-0123456789ab" } },
  ]) {
    await assert.rejects(update(input), Error, JSON.stringify(input));
  }
  assert.equal((await get(BOT)).revision, 0, "nothing malformed was written");

  await assert.rejects(update({ ...valid, botId: "bot:someone-else" }), /no longer exists/u);
  bots.delete(BOT);
  await assert.rejects(get(BOT), /no longer exists/u);
  await assert.rejects(update(valid), /no longer exists/u);
});
