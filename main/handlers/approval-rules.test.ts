// Register-and-invoke: the rules page's list, change and remove over IPC,
// with the real stores behind them (plan §3.5, §7). Every legacy grant is
// listed where it was stored, answers only for its owner, and goes away
// through its own store, so a removed allow-list entry is never restored.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

import { APPROVAL_RULE_CHANNELS, type ApprovalRuleRow, type ApprovalRulesView } from "../../renderer/shared/approval-rules.js";
import type { MacGrantClass } from "../../renderer/shared/approval-mode.js";
import { createBotApprovalTallies } from "../services/bot-runtime/bot-approval-tallies.js";
import { createBotAllowList } from "../services/bot-runtime/bot-allow-list.js";
import { createBotApprovals } from "../services/bot-runtime/bot-approvals.js";
import { createBotRuleStore } from "../services/bot-rules/store.js";
import { emptyToolApprovalRulesDocument, ToolApprovalRuleBook, type ToolApprovalRuleStore } from "../services/tool-approval-rules.js";
import { ApprovalRuleBook, memoryApprovalRuleStore } from "../services/approval-rules/store.js";
import { fileApprovalRuleStore } from "../services/approval-rules/file-store.js";
import { createApprovalRulesPage, type ApprovalRulesPageWorkspace } from "../services/approval-rules/rules-page.js";
import { registerApprovalRuleHandlers } from "./approval-rules.js";

const CAL = { kind: "connection", serverId: "calendar", tool: "create_event" } as const;

async function setup(t: TestContext, options: { fileBook?: true } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "approval-rules-ipc-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let document = emptyToolApprovalRulesDocument(), tail: Promise<unknown> = Promise.resolve(), id = 0;
  const bots = new Map([["bot:ada", "Ada"], ["bot:jo", "Jo"]]);
  const store: ToolApprovalRuleStore = {
    load: async () => structuredClone(document),
    update: (mutation) => {
      const result = tail.then(async () => {
        const draft = structuredClone(document);
        const value = await mutation(draft);
        document = draft;
        return value;
      });
      tail = result.catch(() => {});
      return result;
    },
  };
  const legacy = new ToolApprovalRuleBook(store, () => new Date("2026-11-04T12:00:00Z"), () => `rule_${++id}`, {
    knownBot: async (botId) => bots.has(botId),
  });
  const folders = [{ kind: "folder" as const, id: "folder_projects", botId: "bot:ada", what: "~/Projects", createdAt: "2026-11-03T00:00:00.000Z" }];
  const revokedFolders: string[] = [];
  const allowed = createBotAllowList({
    rules: legacy,
    tallies: createBotApprovalTallies({ profileDir: () => dir }),
    approvals: createBotApprovals({ publish() {} }),
    botName: async (botId) => bots.get(botId),
    connectionName: async () => "Calendar",
    folderEntries: async (botId) => folders.filter((row) => !botId || row.botId === botId),
    revokeFolder: async (botId, sourceId) => {
      revokedFolders.push(`${botId}/${sourceId}`);
      return true;
    },
    log() {},
  });
  const botRules = createBotRuleStore({ profileDir: dir, knownBot: async (botId) => bots.has(botId) });
  const clock = () => new Date("2026-11-12T12:00:00Z");
  const book = new ApprovalRuleBook(options.fileBook ? fileApprovalRuleStore(() => dir) : memoryApprovalRuleStore(), clock);
  // A fresh book over the same file, as the next launch reads it.
  const reopen = () => new ApprovalRuleBook(fileApprovalRuleStore(() => dir), clock);
  const workspaces: ApprovalRulesPageWorkspace[] = [
    { id: "w-full", name: "Old project", permission: "full" },
    { id: "w-ask", name: "Site", permission: "ask", approvalMode: "ask", macGrants: { shell: true } },
    { id: "w-chat", name: "Notes", permission: "none", macGrants: { files: true } },
  ];
  const revokedMac: Array<[string, MacGrantClass]> = [];
  let everywhere = true;
  const page = createApprovalRulesPage({
    book,
    workspaceExact: legacy,
    botAllowed: { list: () => allowed.list(), remove: (botId, entryId) => allowed.remove(botId, entryId), targets: (botId) => legacy.listBot(botId) },
    botRules,
    computerUseEverywhere: { get: async () => everywhere, turnOff: async () => { everywhere = false; } },
    bots: async () => [...bots].map(([botId, name]) => ({ id: botId, name })),
    workspaces: async () => workspaces,
    revokeWorkspaceMac: async (workspaceId, grant) => {
      revokedMac.push([workspaceId, grant]);
    },
    picker: async () => [{ target: { kind: "tool", tool: "browser_click" }, label: "Click on a web page", group: "Aiden" }],
  });
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const broadcasts: string[] = [];
  const listeners = new Set<() => void>();
  const dispose = registerApprovalRuleHandlers({
    handle: (channel, handler) => handlers.set(channel, handler),
    page,
    onChange: (listener) => {
      const offs = [book.onChange(listener), legacy.onChange(listener), allowed.onChange(() => listener())];
      listeners.add(listener);
      return () => offs.forEach((off) => off());
    },
    broadcast: (channel) => broadcasts.push(channel),
  });
  t.after(dispose);
  const invoke = <T>(channel: string, input?: unknown) => Promise.resolve().then(() => handlers.get(channel)!({}, input) as T);
  const list = async () => (await invoke<ApprovalRulesView>(APPROVAL_RULE_CHANNELS.list)).rows;
  return { legacy, allowed, botRules, book, reopen, invoke, list, broadcasts, revokedMac, revokedFolders, bots, get everywhere() { return everywhere; } };
}

const brief = (row: ApprovalRuleRow) => [row.group, row.kind, row.title, row.scope.kind, row.scope.label ?? "", row.legacy === true];

test("list shows every legacy grant in place, scoped to its owner, with the page's own rules", async (t) => {
  const f = await setup(t);
  await f.legacy.grant("always", "chat-1", { toolName: "run_command", pattern: "npm test", workspaceId: "w-ask" }, "Site");
  await f.legacy.grantBot("bot:ada", CAL, "Calendar · Create event", "ada-decision");
  const view = await f.botRules.get("bot:ada");
  await f.botRules.update("bot:ada", view.revision, { type: "add_custom", text: "book a flight", behavior: "ask" });
  const next = await f.botRules.get("bot:ada");
  await f.botRules.update("bot:ada", next.revision, { type: "set_behavior", ruleId: "default.purchase", behavior: "hand_off" });
  await f.invoke(APPROVAL_RULE_CHANNELS.add, { target: { kind: "site", host: "bank.example" }, decision: "block" });

  const rows = (await f.list()).map(brief).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  assert.deepEqual(rows, [
    ["allow", "Command", "Run exactly: npm test", "workspace", "Site", true],
    ["allow", "Tool", "Calendar · Create event", "bot", "Ada", true],
    ["ask", "Built-in", "Make a purchase or booking", "bot", "Ada", true],
    ["ask", "When a Bot wants to", "Book a flight", "bot", "Ada", true],
    ["block", "Site", "bank.example", "mac", "", false],
    ["mac", "Commands", "Run commands", "workspace", "Old project", true],
    ["mac", "Commands", "Run commands", "workspace", "Site", false],
    ["mac", "Computer Use", "Use your Mac with Computer Use", "mac", "Every chat", true],
    ["mac", "Files", "Change files", "workspace", "Old project", true],
    ["mac", "Folder", "~/Projects", "bot", "Ada", true],
  ], "Chat-only workspaces list no Mac grants; Jo has nothing");
  const handOff = (await f.list()).find((row) => row.title === "Make a purchase or booking")!;
  assert.deepEqual(handOff.handOff, { on: true });
  assert.deepEqual(handOff.decisions, ["ask"]);
});

test("Allow → Block on a Bot's allowance removes it for good and blocks it for that Bot only", async (t) => {
  const f = await setup(t);
  await f.legacy.grantBot("bot:ada", CAL, "Calendar · Create event", "ada-decision");
  await f.legacy.grantBot("bot:jo", CAL, "Calendar · Create event", "jo-decision");
  const ada = (await f.list()).find((row) => row.ref.source === "bot-allow" && row.scope.label === "Ada")!;
  assert.deepEqual(await f.invoke(APPROVAL_RULE_CHANNELS.change, { ref: ada.ref, decision: "block" }), { changed: true });

  assert.equal(await f.legacy.matchBot("bot:ada", CAL), undefined);
  assert.ok(await f.legacy.matchBot("bot:jo", CAL), "Jo's own allowance is untouched");
  // The tombstone holds: replaying Ada's original decision restores nothing.
  assert.deepEqual(await f.legacy.grantBot("bot:ada", CAL, "Calendar · Create event", "ada-decision"), { status: "revoked" });
  assert.equal(await f.legacy.matchBot("bot:ada", CAL), undefined);

  const rules = await f.book.list();
  assert.deepEqual(rules.map((rule) => [rule.decision, rule.owner, rule.target]), [
    ["block", { kind: "bot", botId: "bot:ada" }, { kind: "connector-tool", serverId: "calendar", tool: "create_event" }],
  ]);
  const blocked = (await f.list()).find((row) => row.group === "block")!;
  assert.deepEqual([blocked.scope, blocked.legacy], [{ kind: "bot", label: "Ada" }, true]);
});

test("Remove reaches each grant's own store, and Ask drops an allowance without widening anything", async (t) => {
  const f = await setup(t);
  await f.legacy.grant("always", "chat-1", { toolName: "edit_file", pattern: "src/a.ts", workspaceId: "w-ask" }, "Site");
  await f.legacy.grantBot("bot:ada", CAL, "Calendar · Create event", "ada-decision");
  const view = await f.botRules.get("bot:ada");
  await f.botRules.update("bot:ada", view.revision, { type: "set_behavior", ruleId: "default.delete", behavior: "hand_off" });

  const rows = await f.list();
  const exact = rows.find((row) => row.ref.source === "workspace-exact")!;
  assert.deepEqual(await f.invoke(APPROVAL_RULE_CHANNELS.change, { ref: exact.ref, decision: "ask" }), { changed: true });
  assert.equal((await f.legacy.list()).length, 0);
  await assert.rejects(f.invoke(APPROVAL_RULE_CHANNELS.change, { ref: { source: "workspace-exact", id: "rule_9" }, decision: "block" }));

  const allow = rows.find((row) => row.ref.source === "bot-allow")!;
  assert.deepEqual(await f.invoke(APPROVAL_RULE_CHANNELS.remove, { ref: allow.ref }), { removed: true });
  assert.deepEqual(await f.legacy.grantBot("bot:ada", CAL, "Calendar · Create event", "ada-decision"), { status: "revoked" });

  const builtIn = rows.find((row) => row.ref.source === "bot-rule")!;
  assert.deepEqual(await f.invoke(APPROVAL_RULE_CHANNELS.remove, { ref: builtIn.ref }), { removed: true });
  assert.equal((await f.botRules.get("bot:ada")).rules.find((rule) => rule.id === "default.delete")?.behavior, "ask", "back to the built-in default");

  const folder = rows.find((row) => row.ref.source === "bot-folder")!;
  await f.invoke(APPROVAL_RULE_CHANNELS.remove, { ref: folder.ref });
  assert.deepEqual(f.revokedFolders, ["bot:ada/projects"]);

  const mac = rows.find((row) => row.ref.source === "workspace-mac" && row.scope.label === "Site")!;
  await f.invoke(APPROVAL_RULE_CHANNELS.remove, { ref: mac.ref });
  assert.deepEqual(f.revokedMac, [["w-ask", "shell"]]);

  await f.invoke(APPROVAL_RULE_CHANNELS.remove, { ref: { source: "computer-use-everywhere" } });
  assert.equal(f.everywhere, false);
  assert.ok(f.broadcasts.length >= 3 && f.broadcasts.every((channel) => channel === APPROVAL_RULE_CHANNELS.changed));
});

test("Do it myself turns a Bot's rule in words into a hand-off and back; words never allow", async (t) => {
  const f = await setup(t);
  const view = await f.botRules.get("bot:jo");
  await f.botRules.update("bot:jo", view.revision, { type: "add_custom", text: "post on social media", behavior: "ask" });
  const row = (await f.list()).find((entry) => entry.ref.source === "bot-rule")!;
  assert.deepEqual(row.handOff, { on: false });
  await f.invoke(APPROVAL_RULE_CHANNELS.change, { ref: row.ref, handOff: true });
  assert.equal((await f.botRules.get("bot:jo")).rules.find((rule) => rule.text === "post on social media")?.behavior, "hand_off");
  await assert.rejects(f.invoke(APPROVAL_RULE_CHANNELS.change, { ref: row.ref, decision: "allow" }), /only ask or block/u);
  await f.invoke(APPROVAL_RULE_CHANNELS.change, { ref: row.ref, decision: "block" });
  assert.equal((await f.botRules.get("bot:jo")).rules.some((rule) => rule.text === "post on social media"), false);
  assert.deepEqual((await f.book.list()).map((rule) => [rule.decision, rule.owner, rule.target]), [
    ["block", { kind: "bot", botId: "bot:jo" }, { kind: "text", text: "post on social media" }],
  ]);

  const added = await f.invoke<{ id: string }>(APPROVAL_RULE_CHANNELS.add, { target: { kind: "text", text: "Book a flight." }, decision: "ask", handOff: true });
  const mine = (await f.list()).find((entry) => entry.ref.source === "rule" && entry.ref.id === added.id)!;
  assert.deepEqual([mine.title, mine.scope, mine.handOff], ["Book a flight", { kind: "mac" }, { on: true }]);
});

test("malformed or forged requests are refused before any store is touched", async (t) => {
  const f = await setup(t);
  await f.legacy.grantBot("bot:ada", CAL, "Calendar · Create event", "ada-decision");
  for (const [channel, input] of [
    [APPROVAL_RULE_CHANNELS.remove, { ref: { source: "bot-allow", botId: "bot:ada" } }],
    [APPROVAL_RULE_CHANNELS.remove, { ref: { source: "rule", id: "../x" } }],
    [APPROVAL_RULE_CHANNELS.remove, { ref: { source: "computer-use-everywhere" }, everything: true }],
    [APPROVAL_RULE_CHANNELS.change, { ref: { source: "workspace-mac", workspaceId: "w-ask", grant: "shell" }, decision: "allow" }],
    [APPROVAL_RULE_CHANNELS.add, { target: { kind: "connector", serverId: "gmail" }, decision: "allow", owner: { kind: "bot", botId: "bot:ada" } }],
    [APPROVAL_RULE_CHANNELS.add, { target: { kind: "site", host: "localhost" }, decision: "allow" }],
  ] as const) {
    await assert.rejects(f.invoke(channel, input), Error, JSON.stringify(input));
  }
  assert.ok(await f.legacy.matchBot("bot:ada", CAL));
  assert.deepEqual(await f.book.list(), []);
  assert.deepEqual(f.revokedMac, []);
  assert.equal(f.everywhere, true);
});

test("Block on a Bot's rule in words keeps every character, emoji included, and survives the next launch", async (t) => {
  const f = await setup(t, { fileBook: true });
  const view = await f.botRules.get("bot:ada");
  // A family emoji is one character to the Bot's editor but several code
  // units, and is joined with a zero-width joiner.
  const words = "message my family 👩‍👧";
  await f.botRules.update("bot:ada", view.revision, { type: "add_custom", text: words, behavior: "ask" });
  const row = (await f.list()).find((entry) => entry.ref.source === "bot-rule")!;
  assert.deepEqual(await f.invoke(APPROVAL_RULE_CHANNELS.change, { ref: row.ref, decision: "block" }), { changed: true });

  const after = await f.reopen().list();
  assert.deepEqual(after.map((rule) => [rule.decision, rule.owner, rule.target]), [
    ["block", { kind: "bot", botId: "bot:ada" }, { kind: "text", text: words }],
  ]);
  assert.equal((await f.botRules.get("bot:ada")).rules.some((rule) => rule.text === words), false);
});

test("a Block the rules page can't hold is refused, and the Bot's rule or allowance stays as it was", async (t) => {
  const f = await setup(t, { fileBook: true });
  // Hidden direction marks are kept by a Bot's editor but never by the page.
  const words = "send money to \u202Eemoh";
  const view = await f.botRules.get("bot:ada");
  await f.botRules.update("bot:ada", view.revision, { type: "add_custom", text: words, behavior: "ask" });
  // Allowances from cards can name a host or tool the page can't store.
  await f.legacy.grantBot("bot:ada", { kind: "site", host: "localhost", action: "click" }, "localhost · Click", "ada-local");
  await f.legacy.grantBot("bot:jo", { kind: "connection", serverId: "calendar", tool: "create event" }, "Calendar · create event", "jo-odd");

  const rows = (await f.list()).filter((entry) => entry.ref.source === "bot-allow" || entry.kind === "When a Bot wants to");
  assert.equal(rows.length, 3);
  for (const row of rows) {
    await assert.rejects(f.invoke(APPROVAL_RULE_CHANNELS.change, { ref: row.ref, decision: "block" }), /can’t be saved/u, row.title);
  }

  assert.ok((await f.botRules.get("bot:ada")).rules.some((rule) => rule.text === words), "the Bot's rule still asks");
  assert.ok(await f.legacy.matchBot("bot:ada", { kind: "site", host: "localhost", action: "click" }), "the site allowance stays");
  assert.ok(await f.legacy.matchBot("bot:jo", { kind: "connection", serverId: "calendar", tool: "create event" }), "the tool allowance stays");
  assert.deepEqual(await f.reopen().list(), []);
});
