// The rules page's resolution, store and gate steps (plan §3.5): Block wins,
// then the most specific rule (site > tool > connector); a rule a Bot or a
// workspace owns answers only for that owner; an Always-allow rule never
// reaches the person's Mac; in Never ask only Block rules apply.

import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import {
  normalizeApprovalRulesDocument,
  resolveApprovalRule,
  approvalTextRulesFor,
  parseApprovalRuleAddInput,
  parseApprovalRuleChangeInput,
  type ApprovalRule,
  type ApprovalRuleDecision,
  type ApprovalRuleOwner,
  type ApprovalRuleTarget,
} from "../../../renderer/shared/approval-rules.js";
import type { ApprovalMode } from "../../../renderer/shared/approval-mode.js";
import { planActionGate, type GateAction } from "../approval-gate/gate.js";
import { ApprovalRuleBook, ApprovalRuleLimitError, ApprovalRulesUnreadableError, memoryApprovalRuleStore } from "./store.js";
import { fileApprovalRuleStore } from "./file-store.js";

const MAC: ApprovalRuleOwner = { kind: "mac" };
let next = 0;
function rule(target: ApprovalRuleTarget, decision: ApprovalRuleDecision, owner: ApprovalRuleOwner = MAC): ApprovalRule {
  next += 1;
  return { id: `r${next}`, target, decision, owner, createdAt: "2026-11-12T00:00:00.000Z" };
}

const GMAIL_SEND = { serverId: "gmail", tool: "send_email" };

test("Block wins over a more specific Allow, and over an Allow owned by the Bot", () => {
  const rules = [
    rule({ kind: "site", host: "shop.example" }, "allow"),
    rule({ kind: "connector", serverId: "gmail" }, "block"),
    rule({ kind: "connector-tool", ...GMAIL_SEND }, "allow", { kind: "bot", botId: "ada" }),
  ];
  assert.equal(resolveApprovalRule(rules, { connector: GMAIL_SEND, botId: "ada" })?.decision, "block");
  const siteBlock = [rule({ kind: "site", host: "shop.example" }, "allow"), rule({ kind: "tool", tool: "browser_click" }, "block")];
  assert.equal(resolveApprovalRule(siteBlock, { tool: "browser_click", host: "shop.example" })?.decision, "block");
});

test("without a Block, the most specific rule decides: site, then tool, then connector", () => {
  const connector = rule({ kind: "connector", serverId: "gmail" }, "allow");
  const tool = rule({ kind: "connector-tool", ...GMAIL_SEND }, "ask");
  assert.deepEqual(resolveApprovalRule([connector, tool], { connector: GMAIL_SEND })?.rule.id, tool.id);
  assert.equal(resolveApprovalRule([connector, tool], { connector: { serverId: "gmail", tool: "list_threads" } })?.decision, "allow");

  const site = rule({ kind: "site", host: "example.com" }, "allow");
  const click = rule({ kind: "tool", tool: "browser_click" }, "ask");
  assert.equal(resolveApprovalRule([click, site], { tool: "browser_click", host: "www.shop.example.com" })?.decision, "allow");
  assert.equal(resolveApprovalRule([click, site], { tool: "browser_click", host: "example.org" })?.decision, "ask");
  assert.equal(resolveApprovalRule([click, site], { tool: "browser_type", host: "notexample.com" }), undefined);
});

test("a rule a Bot or a workspace owns answers only for that owner, and beats the Mac's at equal specificity", () => {
  const legacy = rule({ kind: "connector-tool", ...GMAIL_SEND }, "allow", { kind: "bot", botId: "ada" });
  const own = rule({ kind: "connector-tool", ...GMAIL_SEND }, "allow", { kind: "workspace", workspaceId: "w1" });
  const mac = rule({ kind: "connector-tool", ...GMAIL_SEND }, "ask");
  const rules = [mac, legacy, own];
  assert.equal(resolveApprovalRule(rules, { connector: GMAIL_SEND, botId: "ada" })?.rule.id, legacy.id);
  assert.equal(resolveApprovalRule(rules, { connector: GMAIL_SEND, botId: "jo" })?.rule.id, mac.id, "another Bot");
  assert.equal(resolveApprovalRule(rules, { connector: GMAIL_SEND, workspaceId: "w1" })?.rule.id, own.id);
  assert.equal(resolveApprovalRule(rules, { connector: GMAIL_SEND, workspaceId: "w2" })?.rule.id, mac.id, "another workspace");
  assert.equal(resolveApprovalRule([legacy], { connector: GMAIL_SEND, workspaceId: "ada" }), undefined, "a Bot id is never a workspace id");
  assert.equal(resolveApprovalRule([legacy], { connector: GMAIL_SEND }), undefined);
});

test("natural-language rules are for Bots, matched by their owner only", () => {
  const mine = rule({ kind: "text", text: "book a flight" }, "ask", { kind: "bot", botId: "ada" });
  const all = rule({ kind: "text", text: "post on social media" }, "block");
  assert.equal(resolveApprovalRule([mine, all], { tool: "book a flight" }), undefined);
  assert.deepEqual(approvalTextRulesFor([mine, all], "ada").map((entry) => entry.id), [mine.id, all.id]);
  assert.deepEqual(approvalTextRulesFor([mine, all], "jo").map((entry) => entry.id), [all.id]);
});

test("a stored document never widens: words cannot allow, Do it myself needs an Ask rule in words, duplicates keep the stricter rule", () => {
  const document = normalizeApprovalRulesDocument({
    version: 1,
    rules: [
      { id: "a", target: { kind: "text", text: "book a flight" }, decision: "allow", owner: MAC, createdAt: "2026-11-12T00:00:00Z" },
      { id: "b", target: { kind: "tool", tool: "browser_click" }, decision: "ask", owner: MAC, handOff: true, createdAt: "2026-11-12T00:00:00Z" },
      { id: "c", target: { kind: "site", host: "WWW.Shop.Example" }, decision: "allow", owner: MAC, createdAt: "2026-11-12T00:00:00Z" },
      { id: "d", target: { kind: "site", host: "shop.example" }, decision: "block", owner: MAC, createdAt: "2026-11-12T00:00:00Z" },
      { id: "e", target: { kind: "tool", tool: "x" }, decision: "allow", owner: { kind: "team" }, createdAt: "2026-11-12T00:00:00Z" },
      { id: "f", target: { kind: "text", text: "pay‮a bill" }, decision: "ask", owner: MAC, createdAt: "2026-11-12T00:00:00Z" },
    ],
  });
  assert.deepEqual(document.rules.map((entry) => [entry.id, entry.decision, entry.handOff ?? false]), [
    ["b", "ask", false],
    ["c", "block", false],
  ]);
  assert.deepEqual(document.rules[1]!.target, { kind: "site", host: "shop.example" });
  assert.deepEqual(normalizeApprovalRulesDocument({ version: 2, rules: [] }).rules, []);
});

test("the book adds one rule per owner and target, changes and removes it, and keeps its cap", async () => {
  let id = 0;
  const book = new ApprovalRuleBook(memoryApprovalRuleStore(), () => new Date("2026-11-12T10:00:00Z"), () => `id${++id}`);
  let changes = 0;
  book.onChange(() => (changes += 1));
  const first = await book.add({ target: { kind: "site", host: "shop.example" }, decision: "allow", owner: MAC });
  const again = await book.add({ target: { kind: "site", host: "shop.example" }, decision: "block", owner: MAC });
  assert.equal(again.id, first.id);
  assert.equal((await book.list()).length, 1);
  assert.equal((await book.list())[0]!.decision, "block");
  const words = await book.add({ target: { kind: "text", text: "book a flight" }, decision: "ask", owner: MAC, handOff: true });
  assert.equal(words.handOff, true);
  assert.equal(await book.change(words.id, { decision: "block" }), true);
  assert.equal((await book.list()).find((entry) => entry.id === words.id)?.handOff, undefined, "Block clears Do it myself");
  await assert.rejects(book.change(words.id, { decision: "allow" }));
  await assert.rejects(book.change(first.id, { handOff: true }), /Always ask rule in your own words/u);
  assert.equal(await book.remove(first.id), true);
  assert.equal(await book.remove(first.id), false);
  assert.equal(changes, 5, "three adds, one change, one removal");

  const full = new ApprovalRuleBook(memoryApprovalRuleStore(), undefined, () => `x${++id}`);
  for (let index = 0; index < 500; index += 1) await full.add({ target: { kind: "tool", tool: `t${index}` }, decision: "ask", owner: MAC });
  await assert.rejects(full.add({ target: { kind: "tool", tool: "one-more" }, decision: "ask", owner: MAC }), ApprovalRuleLimitError);
});

test("the book forgets a deleted owner's rules and nobody else's", async () => {
  const book = new ApprovalRuleBook(memoryApprovalRuleStore());
  await book.add({ target: { kind: "tool", tool: "browser_click" }, decision: "block", owner: { kind: "bot", botId: "ada" } });
  await book.add({ target: { kind: "tool", tool: "browser_click" }, decision: "block", owner: { kind: "bot", botId: "jo" } });
  await book.add({ target: { kind: "tool", tool: "browser_click" }, decision: "allow", owner: MAC });
  assert.equal(await book.forgetOwner({ kind: "bot", botId: "ada" }), 1);
  assert.deepEqual((await book.list()).map((entry) => entry.owner), [{ kind: "bot", botId: "jo" }, MAC]);
});

test("Add and Change inputs are strict: no Bot owner from the page, no allow in words, no unknown fields", () => {
  assert.deepEqual(parseApprovalRuleAddInput({ target: { kind: "site", host: "https://www.Shop.example/cart" }, decision: "block" }), {
    target: { kind: "site", host: "shop.example" },
    decision: "block",
  });
  for (const input of [
    { target: { kind: "text", text: "book a flight" }, decision: "allow" },
    { target: { kind: "tool", tool: "browser_click" }, decision: "allow", owner: { kind: "bot", botId: "ada" } },
    { target: { kind: "tool", tool: "browser_click" }, decision: "allow", scope: "everything" },
    { target: { kind: "site", host: "localhost" }, decision: "allow" },
    { target: { kind: "tool", tool: "a b" }, decision: "allow" },
  ]) {
    assert.throws(() => parseApprovalRuleAddInput(input), Error, JSON.stringify(input));
  }
  assert.throws(() => parseApprovalRuleChangeInput({ ref: { source: "rule", id: "r1" } }));
  assert.throws(() => parseApprovalRuleChangeInput({ ref: { source: "bot-allow", botId: "ada", entryId: "e", extra: 1 }, decision: "ask" }));
  assert.deepEqual(parseApprovalRuleChangeInput({ ref: { source: "workspace-mac", workspaceId: "w1", grant: "shell" }, decision: "ask" }), {
    ref: { source: "workspace-mac", workspaceId: "w1", grant: "shell" },
    decision: "ask",
  });
});

// The gate's three rule steps, written out from the plan.
const SEND: GateAction = { toolName: "gmail_send_email", consequential: true };
const READ: GateAction = { toolName: "gmail_list_threads" };
const SHELL: GateAction = { toolName: "run_command", consequential: true, mac: true, macClass: "shell" };
const SHARE: GateAction = { toolName: "share_image", explicitOnly: true };
const short = (mode: ApprovalMode, action: GateAction) => {
  const decision = planActionGate({ surface: "workspace", access: "ask", mode }, action);
  return decision.outcome === "block" ? `block:${decision.reason}` : decision.outcome === "allow" ? `allow:${decision.via ?? decision.step}` : `${decision.outcome}@${decision.step}`;
};

test("gate: a Block rule refuses in every mode, before explicit-only and the Mac", () => {
  for (const mode of ["ask", "auto", "never"] as const) {
    for (const action of [SEND, READ, SHELL, SHARE, { ...SHELL, macGranted: true }]) {
      assert.equal(short(mode, { ...action, pageRule: "block" }), "block:rule", `${mode} ${action.toolName}`);
    }
  }
});

test("gate: an Ask rule asks in Ask and Auto, even for a read, and does not apply in Never ask", () => {
  assert.equal(short("ask", { ...READ, pageRule: "ask" }), "ask@ask-rule");
  assert.equal(short("auto", { ...SEND, pageRule: "ask" }), "ask@ask-rule", "never judged into running");
  assert.equal(short("never", { ...SEND, pageRule: "ask" }), "allow:never-ask");
  assert.equal(short("ask", { ...SHELL, macGranted: true, pageRule: "ask" }), "ask@ask-rule", "asks even where the workspace allowed the shell");
  assert.equal(short("never", SHARE), "ask@explicit-only");
  assert.equal(short("never", { ...SHARE, pageRule: "allow" }), "ask@explicit-only", "an Allow rule never skips an explicit-only card");
  const routine = planActionGate({ surface: "bot", access: "ask", mode: "ask", attendance: "routine" }, { ...READ, pageRule: "ask" });
  assert.equal(routine.outcome === "block" && routine.reason, "unattended-rule");
});

test("gate: an Allow rule runs a consequential action without a card, but never the person's Mac", () => {
  assert.equal(short("ask", { ...SEND, pageRule: "allow" }), "allow:rule");
  assert.equal(short("auto", { ...SEND, pageRule: "allow" }), "allow:rule");
  assert.equal(short("ask", { ...SHELL, pageRule: "allow" }), "ask@consequential");
  assert.equal(short("never", { ...SHELL, pageRule: "allow" }), "ask@consequential");
  assert.equal(short("ask", { ...SEND, rule: { behavior: "hand_off", locked: true }, pageRule: "allow" }), "hand-off@money", "money stays with the person");
  assert.equal(short("ask", { ...SEND, rule: { behavior: "ask", locked: false }, pageRule: "allow" }), "ask@ask-rule", "a Bot's own Ask first rule still asks");
});

async function rulesDir(t: TestContext, contents?: string) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "approval-rules-file-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  if (contents !== undefined) await writeFile(path.join(dir, "approval-rules.json"), contents);
  return dir;
}

const BLOCK_BANK = { id: "r1", target: { kind: "site", host: "bank.example" }, decision: "block", owner: MAC, createdAt: "2026-11-12T00:00:00.000Z" };

for (const [name, contents] of [
  ["a file that doesn't parse", `{"version":1,"rules":[${JSON.stringify(BLOCK_BANK)}`],
  ["a file from a newer Aiden", JSON.stringify({ version: 2, rules: [BLOCK_BANK], groups: [] })],
  ["a file holding a rule this Aiden can't read", JSON.stringify({ version: 1, rules: [BLOCK_BANK, { ...BLOCK_BANK, id: "r2", target: { kind: "app", app: "Mail" } }] })],
] as const) {
  test(`${name} is never read around or written over, until the person sets it aside`, async (t) => {
    const dir = await rulesDir(t, contents);
    const book = new ApprovalRuleBook(fileApprovalRuleStore(() => dir, () => new Date("2026-11-12T10:00:00Z")));
    await assert.rejects(book.list(), ApprovalRulesUnreadableError, "no rule list: its Blocks may be the ones missing");
    assert.equal(await book.readable(), false);
    await assert.rejects(book.add({ target: { kind: "tool", tool: "browser_click" }, decision: "allow", owner: MAC }));
    await book.refresh();
    await assert.rejects(book.list(), ApprovalRulesUnreadableError, "Try again reads the same file the same way");
    assert.equal(await readFile(path.join(dir, "approval-rules.json"), "utf8"), contents, "the file is untouched");

    await book.setAside();
    assert.deepEqual(await book.list(), []);
    const aside = (await readdir(dir)).filter((file) => file.startsWith("approval-rules.json.unreadable-"));
    assert.equal(aside.length, 1);
    assert.equal(await readFile(path.join(dir, aside[0]!), "utf8"), contents, "the bytes are kept beside it");
    await book.add({ target: { kind: "site", host: "bank.example" }, decision: "block", owner: MAC });
    assert.deepEqual((await new ApprovalRuleBook(fileApprovalRuleStore(() => dir)).list()).map((entry) => entry.decision), ["block"]);
  });
}

test("a readable file is never set aside, and its rules come back on the next launch", async (t) => {
  const dir = await rulesDir(t, JSON.stringify({ version: 1, rules: [BLOCK_BANK] }));
  const book = new ApprovalRuleBook(fileApprovalRuleStore(() => dir));
  await book.setAside();
  assert.deepEqual((await book.list()).map((entry) => entry.target), [{ kind: "site", host: "bank.example" }]);
  assert.deepEqual(await readdir(dir), ["approval-rules.json"]);
});

test("the book refuses a rule it couldn't read back, so nothing it saves is lost on the next launch", async () => {
  const book = new ApprovalRuleBook(memoryApprovalRuleStore());
  for (const target of [
    { kind: "text", text: "pay \u202Ea bill" },
    { kind: "text", text: "x".repeat(121) },
    { kind: "site", host: "localhost" },
    { kind: "tool", tool: "create event" },
  ] as ApprovalRuleTarget[]) {
    await assert.rejects(book.add({ target, decision: "block", owner: MAC }), /can’t be saved/u, JSON.stringify(target));
  }
  const family = await book.add({ target: { kind: "text", text: "message my family 👩‍👧" }, decision: "block", owner: MAC });
  assert.deepEqual(family.target, { kind: "text", text: "message my family 👩‍👧" });
  const long = await book.add({ target: { kind: "text", text: "🛫".repeat(120) }, decision: "ask", owner: MAC });
  assert.equal([...(long.target as { text: string }).text].length, 120, "counted in characters, as a Bot's editor counts");
});

test("gate: a rules file that can't be read asks once in every mode, and an unattended run refuses", () => {
  for (const mode of ["ask", "auto", "never"] as const) {
    assert.equal(short(mode, { ...READ, pageRule: "unreadable" }), "ask@explicit-only", mode);
    assert.equal(short(mode, { ...SEND, pageRule: "unreadable" }), "ask@explicit-only", mode);
  }
  const routine = planActionGate({ surface: "bot", access: "ask", mode: "never", attendance: "routine" }, { ...READ, pageRule: "unreadable" });
  assert.equal(routine.outcome, "block");
});
