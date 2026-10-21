import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import {
  BOT_CUSTOM_RULES_MAX,
  BOT_RULE_TEXT_MAX_CHARS,
  defaultBotRules,
  type BotRule,
} from "../../../renderer/shared/bot-rules.js";
import { BotRulesUnavailableError, createBotRuleStore } from "./store.js";

const BOT = "bot:1";
// `botDirectoryName("bot:1")`: the colon is written as its UTF-8 byte.
const BOT_DIR = "bot~3a1";
const OTHER = "bot:2";

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function profile(known = new Set([BOT, OTHER])) {
  const root = mkdtempSync(path.join(os.tmpdir(), "aiden-bot-rules-"));
  roots.push(root);
  const file = path.join(root, "bots", BOT_DIR, "rules.json");
  const store = createBotRuleStore({ profileDir: root, knownBot: async (botId) => known.has(botId) });
  return { root, file, store, known };
}

function handWrite(file: string, content: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function byId(rules: readonly BotRule[], id: string): BotRule | undefined {
  return rules.find((rule) => rule.id === id);
}

test("a Bot with no rules file has the defaults at revision 0, without creating anything", async () => {
  const p = profile();
  const view = await p.store.get(BOT);
  assert.deepEqual(view, { botId: BOT, revision: 0, rules: defaultBotRules() });
  assert.deepEqual(await p.store.rules(BOT), defaultBotRules());
  assert.equal(existsSync(path.join(p.root, "bots")), false);
});

test("changes persist across stores, bump the revision and keep the order locked, built-in, custom", async () => {
  const p = profile();
  const changed = await p.store.update(BOT, 0, { type: "set_behavior", ruleId: "default.purchase", behavior: "hand_off" });
  assert.equal(changed.ok, true);
  const added = await p.store.update(BOT, 1, { type: "add_custom", text: "  book   a flight. ", behavior: "ask" });
  assert.equal(added.ok, true);
  assert.equal(added.view.revision, 2);

  const reopened = createBotRuleStore({ profileDir: p.root, knownBot: async () => true });
  const view = await reopened.get(BOT);
  assert.equal(view.revision, 2);
  assert.deepEqual(
    view.rules.map((rule) => rule.id.split(".")[0]),
    ["locked", "locked", "default", "default", "default", "default", "default", "custom"],
  );
  assert.equal(byId(view.rules, "default.purchase")?.behavior, "hand_off");
  const customRule = view.rules[view.rules.length - 1]!;
  assert.match(customRule.id, /^custom\.[0-9a-f-]{36}$/u);
  assert.equal(customRule.text, "book a flight");
  assert.equal(customRule.behavior, "ask");
  assert.equal(customRule.locked, false);
  // Private to this user, like the session database next to it.
  assert.equal(statSync(p.file).mode & 0o777, 0o600);
  // Only what the person changed is stored; locked rules never are.
  const stored = JSON.parse(readFileSync(p.file, "utf8")) as Record<string, unknown>;
  assert.equal(JSON.stringify(stored).includes("locked"), false);
});

test("edit and remove a custom rule", async () => {
  const p = profile();
  const added = await p.store.update(BOT, 0, { type: "add_custom", text: "email my landlord", behavior: "ask" });
  const id = added.view.rules[added.view.rules.length - 1]!.id;
  const edited = await p.store.update(BOT, 1, { type: "edit_custom", ruleId: id, behavior: "hand_off" });
  assert.equal(byId(edited.view.rules, id)?.behavior, "hand_off");
  assert.equal(byId(edited.view.rules, id)?.text, "email my landlord");
  const renamed = await p.store.update(BOT, 2, { type: "edit_custom", ruleId: id, text: "email the landlord" });
  assert.equal(byId(renamed.view.rules, id)?.text, "email the landlord");
  const removed = await p.store.update(BOT, 3, { type: "remove_custom", ruleId: id });
  assert.equal(removed.ok, true);
  assert.equal(byId(removed.view.rules, id), undefined);
  const again = await p.store.update(BOT, 4, { type: "remove_custom", ruleId: id });
  assert.deepEqual([again.ok, again.ok ? undefined : again.reason], [false, "not_found"]);
});

test("locked rules can't be changed or removed, and built-in rules can't be removed", async () => {
  const p = profile();
  for (const change of [
    { type: "set_behavior", ruleId: "locked.money", behavior: "ask" },
    { type: "remove_custom", ruleId: "locked.credentials" },
    { type: "edit_custom", ruleId: "locked.money", behavior: "ask" },
    { type: "remove_custom", ruleId: "default.delete" },
  ] as const) {
    const result = await p.store.update(BOT, 0, change);
    assert.equal(result.ok, false, change.ruleId);
    assert.equal(result.ok ? undefined : result.reason, "locked", change.ruleId);
    assert.deepEqual(result.view.rules, defaultBotRules());
  }
  assert.equal(existsSync(p.file), false);
});

test("a tampered file can't remove or weaken a locked rule", async () => {
  const p = profile();
  handWrite(
    p.file,
    JSON.stringify({ version: 1, revision: 4, behaviors: { money: "ask", purchase: "hand_off" }, custom: [] }),
  );
  const view = await p.store.get(BOT);
  // `money` is not a stored behavior, so the whole file is invalid.
  assert.equal(view.revision, 0);
  assert.equal(byId(view.rules, "locked.money")?.behavior, "hand_off");
  assert.equal(byId(view.rules, "default.purchase")?.behavior, "ask");
});

test("only an exactly valid file is read; anything else reads as the defaults", async () => {
  const p = profile();
  const valid = { version: 1, revision: 3, behaviors: { delete: "hand_off" }, custom: [] };
  const id = "custom.0b8a3f5e-2c11-4d5f-9b7a-0123456789ab";
  const variants: unknown[] = [
    "{not json",
    "[]",
    { ...valid, extra: true },
    { ...valid, version: 2 },
    { ...valid, revision: 0 },
    { ...valid, revision: 1.5 },
    { ...valid, behaviors: { delete: "allowed" } },
    { ...valid, custom: [{ id, text: "x".repeat(BOT_RULE_TEXT_MAX_CHARS + 1), behavior: "ask" }] },
    { ...valid, custom: [{ id: "custom.1", text: "book a flight", behavior: "ask" }] },
    { ...valid, custom: [{ id, text: "book a flight", behavior: "ask", locked: true }] },
    { ...valid, custom: [{ id, text: "book a flight", behavior: "ask" }, { id, text: "order food", behavior: "ask" }] },
    { ...valid, custom: [{ id, text: "  book a flight", behavior: "ask" }] },
  ];
  for (const variant of variants) {
    handWrite(p.file, typeof variant === "string" ? variant : JSON.stringify(variant));
    const view = await p.store.get(BOT);
    assert.equal(view.revision, 0, JSON.stringify(variant));
    assert.deepEqual(view.rules, defaultBotRules());
  }
  handWrite(p.file, JSON.stringify({ ...valid, custom: [{ id, text: "book a flight", behavior: "ask" }] }));
  const view = await p.store.get(BOT);
  assert.equal(view.revision, 3);
  assert.equal(byId(view.rules, "default.delete")?.behavior, "hand_off");
  assert.equal(byId(view.rules, id)?.text, "book a flight");
});

test("an unreadable rules file throws instead of reading as the defaults", async () => {
  const p = profile();
  mkdirSync(p.file, { recursive: true });
  await assert.rejects(p.store.get(BOT));
  await assert.rejects(p.store.rules(BOT));
});

test("an edit made against an old revision is refused with the current rules", async () => {
  const p = profile();
  await p.store.update(BOT, 0, { type: "set_behavior", ruleId: "default.install", behavior: "hand_off" });
  const stale = await p.store.update(BOT, 0, { type: "set_behavior", ruleId: "default.install", behavior: "ask" });
  assert.equal(stale.ok, false);
  assert.equal(stale.ok ? undefined : stale.reason, "stale");
  assert.equal(stale.view.revision, 1);
  assert.equal(byId(stale.view.rules, "default.install")?.behavior, "hand_off");
});

test("concurrent edits against one revision: exactly one wins", async () => {
  const p = profile();
  const results = await Promise.all([
    p.store.update(BOT, 0, { type: "add_custom", text: "order food", behavior: "ask" }),
    p.store.update(BOT, 0, { type: "add_custom", text: "book a flight", behavior: "ask" }),
  ]);
  assert.deepEqual(results.map((result) => result.ok).sort(), [false, true]);
  assert.equal((await p.store.get(BOT)).rules.filter((rule) => rule.text !== undefined).length, 1);
});

test("invalid text and the custom-rule limit are refusals, not throws", async () => {
  const p = profile();
  for (const text of ["", "   ", "do something", "x".repeat(BOT_RULE_TEXT_MAX_CHARS + 1)]) {
    const result = await p.store.update(BOT, 0, { type: "add_custom", text, behavior: "ask" });
    assert.equal(result.ok ? undefined : result.reason, "invalid", JSON.stringify(text));
  }
  let revision = 0;
  for (let index = 0; index < BOT_CUSTOM_RULES_MAX; index += 1) {
    const result = await p.store.update(BOT, revision, { type: "add_custom", text: `water plant ${index}`, behavior: "ask" });
    assert.equal(result.ok, true);
    revision = result.view.revision;
  }
  const over = await p.store.update(BOT, revision, { type: "add_custom", text: "one more thing to stop at", behavior: "ask" });
  assert.equal(over.ok ? undefined : over.reason, "limit");
  assert.equal(over.view.rules.filter((rule) => rule.text !== undefined).length, BOT_CUSTOM_RULES_MAX);
});

test("set_behavior is for built-in rules and edit_custom for custom ones", async () => {
  const p = profile();
  const added = await p.store.update(BOT, 0, { type: "add_custom", text: "order food", behavior: "ask" });
  const id = added.view.rules[added.view.rules.length - 1]!.id;
  const wrongKind = await p.store.update(BOT, 1, { type: "set_behavior", ruleId: id, behavior: "hand_off" });
  assert.equal(wrongKind.ok ? undefined : wrongKind.reason, "invalid");
  const builtIn = await p.store.update(BOT, 1, { type: "edit_custom", ruleId: "default.publish", text: "post" });
  assert.equal(builtIn.ok ? undefined : builtIn.reason, "invalid");
  const unknown = await p.store.update(BOT, 1, { type: "set_behavior", ruleId: "default.nothing", behavior: "ask" });
  assert.equal(unknown.ok ? undefined : unknown.reason, "not_found");
  const empty = await p.store.update(BOT, 1, { type: "edit_custom", ruleId: id });
  assert.equal(empty.ok ? undefined : empty.reason, "invalid");
});

test("a Bot the Bot store doesn't know can't write rules", async () => {
  const p = profile(new Set([OTHER]));
  await assert.rejects(
    p.store.update(BOT, 0, { type: "add_custom", text: "order food", behavior: "ask" }),
    BotRulesUnavailableError,
  );
  assert.equal(existsSync(path.join(p.root, "bots", BOT_DIR)), false);
});

test("deleting a Bot removes its rules, refuses later writes and never brings its directory back", async () => {
  const p = profile();
  await p.store.update(BOT, 0, { type: "add_custom", text: "order food", behavior: "hand_off" });
  await p.store.update(OTHER, 0, { type: "set_behavior", ruleId: "default.delete", behavior: "hand_off" });
  // Deleting the Bot's session removes its directory first (`host.destroy`).
  rmSync(path.join(p.root, "bots", BOT_DIR), { recursive: true, force: true });

  await p.store.forgetBot(BOT);
  await assert.rejects(
    p.store.update(BOT, 0, { type: "add_custom", text: "book a flight", behavior: "ask" }),
    BotRulesUnavailableError,
  );
  assert.equal(existsSync(path.join(p.root, "bots", BOT_DIR)), false);
  assert.deepEqual(await p.store.rules(BOT), defaultBotRules());
  // The other Bot keeps its rules.
  assert.equal(byId(await p.store.rules(OTHER), "default.delete")?.behavior, "hand_off");
});

test("a write racing the Bot's deletion is refused before it publishes, and its directory is cleaned up", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "aiden-bot-rules-"));
  roots.push(root);
  let checks = 0;
  let forgotten: Promise<void> | undefined;
  const store = createBotRuleStore({
    profileDir: root,
    knownBot: async () => {
      checks += 1;
      // The second check is the one right before publishing: the Bot is deleted meanwhile.
      if (checks === 2) forgotten = store.forgetBot(BOT);
      return true;
    },
  });
  await assert.rejects(
    store.update(BOT, 0, { type: "add_custom", text: "order food", behavior: "hand_off" }),
    BotRulesUnavailableError,
  );
  assert.equal(checks, 2);
  await forgotten;
  assert.equal(existsSync(path.join(root, "bots", BOT_DIR)), false);
  assert.deepEqual(await store.rules(BOT), defaultBotRules());
});
