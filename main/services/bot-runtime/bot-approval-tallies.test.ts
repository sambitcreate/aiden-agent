import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { botSessionDirectory } from "../bot-routine-notes.js";
import { DataStore } from "../data-store.js";
import { ToolApprovalRuleBook, emptyToolApprovalRulesDocument, normalizeToolApprovalRulesDocument,
  TOOL_APPROVAL_RULES_MAX_BYTES, type ToolApprovalRulesDocument } from "../tool-approval-rules.js";
import {
  createBotApprovalTallies,
  type BotApprovalAnswer,
  type BotApprovalDecision,
  type BotApprovalTallyKey,
} from "./bot-approval-tallies.js";

const DAY = 86_400_000;
const START = Date.parse("2026-11-04T12:00:00.000Z");
const CAL = { kind: "connection", serverId: "gcal", tool: "create_event" } as const;
const FOLDER = { kind: "folder", path: "/Users/p/Taxes" } as const;

async function setup(t: test.TestContext) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-bot-tallies-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  let clock = START;
  let ids = 0;
  const open = () => createBotApprovalTallies({ profileDir: () => dir, now: () => clock });
  const tallies = open();
  const file = (botId = "bot:a") => path.join(botSessionDirectory(dir, botId), "approval-tallies.json");
  const person = (answer: BotApprovalAnswer = "allow", offered = false) => ({
    id: `decision-${++ids}`, authorizationFingerprint: `fingerprint-${ids}`, source: "person" as const, answer, offered,
  });
  const allow = (key: BotApprovalTallyKey = CAL, botId = "bot:a") => tallies.record(botId, key, person());
  return { dir, file, open, tallies, person, allow, at: (days: number, ms = 0) => { clock = START + days * DAY + ms; } };
}

test("an absent ledger has no decisions or nudge and read-only queries create no file", async (t) => {
  const { tallies, file } = await setup(t);
  assert.equal(await tallies.decision("bot:a", "missing", "fp"), undefined);
  assert.equal(await tallies.nudge("bot:a", CAL), undefined);
  await assert.rejects(fs.stat(file()), { code: "ENOENT" });
});

test("offers on the third approval and retains the exact inclusive 14-day boundary", async (t) => {
  const { tallies, allow, at } = await setup(t);
  assert.deepEqual(await allow(), { counted: true });
  await allow();
  assert.equal(await tallies.nudge("bot:a", CAL), undefined);
  await allow();
  assert.deepEqual(await tallies.nudge("bot:a", CAL), { count: 3 });
  at(14);
  assert.deepEqual(await tallies.nudge("bot:a", CAL), { count: 3 });
  at(14, 1);
  assert.equal(await tallies.nudge("bot:a", CAL), undefined);
});

test("one person denial withholds the offer through 14 days, then three recent approvals offer again", async (t) => {
  const { tallies, allow, person, at } = await setup(t);
  await allow(); await allow();
  at(1); await allow();
  at(2); await allow(); await allow();
  at(3);
  assert.deepEqual(await tallies.record("bot:a", CAL, person("deny")), { counted: true });
  at(4);
  assert.equal(await tallies.nudge("bot:a", CAL), undefined);
  at(15); await allow();
  at(16); await allow();
  at(17); await allow();
  assert.equal(await tallies.nudge("bot:a", CAL), undefined, "a denial exactly 14 days ago still counts");
  at(17, 1);
  assert.deepEqual(await tallies.nudge("bot:a", CAL), { count: 3 });
});

test("hint ownership is atomic, at most once per seven days, and replay never moves its cooldown", async (t) => {
  const { tallies, allow, person, at, open } = await setup(t);
  await allow(); await allow(); await allow();
  const first = person("allow", true);
  assert.deepEqual(await tallies.record("bot:a", CAL, first), { counted: true, hintCount: 4 });
  at(6);
  assert.deepEqual(await tallies.record("bot:a", CAL, person("allow", true)), { counted: true });
  at(7);
  assert.deepEqual(await tallies.record("bot:a", CAL, person("allow", true)), { counted: true, hintCount: 6 });
  at(13);
  assert.deepEqual(await open().record("bot:a", CAL, first), { counted: true, hintCount: 4 });
  at(14);
  assert.deepEqual(await tallies.record("bot:a", CAL, person("allow", true)), { counted: true, hintCount: 7 });
});

test("a hint requires an offered eligible Allow once; Always and denial never own a hint", async (t) => {
  const { tallies, person } = await setup(t);
  assert.deepEqual(await tallies.record("bot:a", CAL, person("allow", true)), { counted: true });
  await tallies.record("bot:a", CAL, person());
  await tallies.record("bot:a", CAL, person());
  assert.deepEqual(await tallies.record("bot:a", CAL, person("allow_always", true)), { counted: true });
  assert.deepEqual(await tallies.record("bot:a", CAL, person("allow", false)), { counted: true });
  assert.deepEqual(await tallies.record("bot:a", CAL, person("deny", true)), { counted: true });
  assert.deepEqual(await tallies.record("bot:a", CAL, person("allow", true)), { counted: true });
});

test("connection, site and folder classes and different Bots remain independent", async (t) => {
  const { tallies, allow } = await setup(t);
  await allow(); await allow(); await allow();
  await allow(FOLDER); await allow(FOLDER);
  const site = { kind: "site", host: "amazon.com", action: "click" } as const;
  await allow(site);
  await allow(CAL, "bot:b");
  assert.deepEqual(await tallies.nudge("bot:a", CAL), { count: 3 });
  assert.equal(await tallies.nudge("bot:a", FOLDER), undefined);
  assert.equal(await tallies.nudge("bot:a", site), undefined);
  assert.equal(await tallies.nudge("bot:b", CAL), undefined);
  assert.equal(await tallies.nudge("bot:a", { ...CAL, tool: "delete_event" }), undefined);
  await allow(FOLDER);
  await tallies.forget("bot:a", CAL);
  assert.equal(await tallies.nudge("bot:a", CAL), undefined);
  assert.deepEqual(await tallies.nudge("bot:a", FOLDER), { count: 3 });
});

test("approval history survives reopen, caps at 20, and the private file is mode 0600", async (t) => {
  const { tallies, allow, file, open, at } = await setup(t);
  for (let i = 0; i < 30; i++) { at(0, i); await allow(); }
  assert.deepEqual(await open().nudge("bot:a", CAL), { count: 20 });
  const stored = JSON.parse(await fs.readFile(file(), "utf8"));
  assert.equal(stored.classes.length, 1);
  assert.deepEqual(stored.classes[0].allowed, Array.from({ length: 20 }, (_, i) => START + 10 + i));
  assert.equal(stored.decisions.length, 30, "the display cap must never remove replay receipts");
  assert.equal((await fs.stat(file())).mode & 0o777, 0o600);
  at(14, 30);
  assert.equal(await tallies.nudge("bot:a", CAL), undefined);
});

test("crash after commit before task memo replays the original result and immutable person decision", async (t) => {
  const { tallies, allow, person, file, open, at } = await setup(t);
  await allow(); await allow(); await allow();
  const decision = person("allow", true);
  const expected = { counted: true, hintCount: 4 };
  assert.deepEqual(await tallies.record("bot:a", CAL, decision), expected);
  const bytes = await fs.readFile(file(), "utf8");
  at(30);
  const restarted = open();
  assert.deepEqual(await restarted.record("bot:a", CAL, decision), expected);
  assert.deepEqual(await restarted.record("bot:a", CAL, decision), expected);
  assert.equal(await fs.readFile(file(), "utf8"), bytes, "an exact replay does not rewrite the ledger");
  assert.deepEqual(await restarted.decision("bot:a", decision.id, decision.authorizationFingerprint), {
    id: decision.id, authorizationFingerprint: decision.authorizationFingerprint, answer: "allow", source: "person",
  });
  assert.equal(await restarted.decision("bot:a", decision.id, "different-requirements"), undefined);
  assert.equal(await restarted.nudge("bot:a", CAL), undefined);
});

test("an existing decision id cannot change fingerprint, class, answer, provenance or offered state", async (t) => {
  const { tallies, person, file } = await setup(t);
  const decision = person();
  await tallies.record("bot:a", CAL, decision);
  const before = await fs.readFile(file(), "utf8");
  await assert.rejects(tallies.record("bot:a", CAL, { ...decision, authorizationFingerprint: "new" }), /decision.*changed|conflict/iu);
  await assert.rejects(tallies.record("bot:a", FOLDER, decision), /decision.*changed|conflict/iu);
  await assert.rejects(tallies.record("bot:a", CAL, { ...decision, answer: "deny" }), /decision.*changed|conflict/iu);
  await assert.rejects(tallies.record("bot:a", CAL, { ...decision, source: "expiry" }), /decision.*changed|conflict/iu);
  await assert.rejects(tallies.record("bot:a", CAL, { ...decision, offered: true }), /decision.*changed|conflict/iu);
  assert.equal(await fs.readFile(file(), "utf8"), before);
  assert.deepEqual(await tallies.record("bot:a", CAL, decision), { counted: true });
});

test("record snapshots caller inputs before asynchronous work", async (t) => {
  const { tallies, person, allow } = await setup(t);
  const target: { kind: "connection"; serverId: string; tool: string } = { ...CAL };
  const decision = person();
  const identity = { ...decision };
  const pending = tallies.record("bot:a", target, decision);
  target.tool = "delete_event";
  decision.answer = "deny";
  await pending;
  assert.deepEqual(await tallies.decision("bot:a", identity.id, identity.authorizationFingerprint), {
    id: identity.id, authorizationFingerprint: identity.authorizationFingerprint, answer: "allow", source: "person",
  });
  await allow(); await allow();
  assert.deepEqual(await tallies.nudge("bot:a", CAL), { count: 3 });
});

test("concurrent replay and fresh decisions across reopened factories never lose or duplicate receipts", async (t) => {
  const { tallies, person, open, file } = await setup(t);
  const first = person();
  const other = open();
  const results = await Promise.all(Array.from({ length: 30 }, (_, i) => (i % 2 ? other : tallies).record("bot:a", CAL, first)));
  assert.deepEqual(results, Array.from({ length: 30 }, () => ({ counted: true })));
  assert.equal(JSON.parse(await fs.readFile(file(), "utf8")).decisions.length, 1);
  assert.equal(await tallies.nudge("bot:a", CAL), undefined);
  await Promise.all(Array.from({ length: 30 }, (_, i) => (i % 2 ? other : tallies).record("bot:a", CAL, person())));
  const stored = JSON.parse(await fs.readFile(file(), "utf8"));
  assert.equal(stored.decisions.length, 31);
  assert.deepEqual(await tallies.nudge("bot:a", CAL), { count: 20 });
});

test("two concurrent offered decisions assign one hint entitlement", async (t) => {
  const { tallies, allow, person, open } = await setup(t);
  await allow(); await allow(); await allow();
  const first = person("allow", true);
  const second = person("allow", true);
  assert.deepEqual(await Promise.all([tallies.record("bot:a", CAL, first), open().record("bot:a", CAL, second)]), [
    { counted: true, hintCount: 4 }, { counted: true },
  ]);
  assert.deepEqual(await open().record("bot:a", CAL, first), { counted: true, hintCount: 4 });
});

test("forgetting a class retains receipts, pending Always entitlement, and hint cooldown", async (t) => {
  const { tallies, allow, person, open, at } = await setup(t);
  await allow(); await allow(); await allow();
  const hinted = person("allow", true);
  await tallies.record("bot:a", CAL, hinted);
  const always = person("allow_always", true);
  await tallies.record("bot:a", CAL, always);
  await tallies.forget("bot:a", CAL);
  assert.equal(await tallies.nudge("bot:a", CAL), undefined);
  const reopened = open();
  assert.deepEqual(await reopened.record("bot:a", CAL, hinted), { counted: true, hintCount: 4 });
  assert.deepEqual(await reopened.record("bot:a", CAL, always), { counted: true });
  const entitlement: BotApprovalDecision = { id: always.id, authorizationFingerprint: always.authorizationFingerprint, answer: "allow_always", source: "person" };
  assert.deepEqual(await reopened.decision("bot:a", always.id, always.authorizationFingerprint), entitlement);
  assert.equal(await tallies.nudge("bot:a", CAL), undefined, "replay never restores cleared counts");
  at(1); await allow(); await allow(); await allow();
  assert.deepEqual(await reopened.record("bot:a", CAL, person("allow", true)), { counted: true });
  at(7, 1);
  assert.deepEqual(await reopened.record("bot:a", CAL, person("allow", true)), { counted: true, hintCount: 5 });
});

test("100-class eviction never erases replay protection or hint cooldown", async (t) => {
  const { tallies, allow, person, file, open, at } = await setup(t);
  await allow(); await allow(); await allow();
  const hinted = person("allow", true);
  await tallies.record("bot:a", CAL, hinted);
  for (let i = 0; i < 100; i++) await allow({ ...CAL, tool: `tool${i}` });
  const stored = JSON.parse(await fs.readFile(file(), "utf8"));
  assert.equal(stored.classes.length, 100);
  assert.equal(stored.decisions.length, 104);
  assert.equal(await tallies.nudge("bot:a", CAL), undefined);
  assert.deepEqual(await open().record("bot:a", CAL, hinted), { counted: true, hintCount: 4 });
  assert.equal(await tallies.nudge("bot:a", CAL), undefined);
  at(1); await allow(); await allow(); await allow();
  assert.deepEqual(await tallies.record("bot:a", CAL, person("allow", true)), { counted: true });
});

test("recent denials survive class eviction and class forget", async (t) => {
  const { tallies, person, allow, at } = await setup(t);
  await tallies.record("bot:a", CAL, person("deny"));
  await tallies.forget("bot:a", CAL);
  for (let i = 0; i < 101; i++) await allow({ ...CAL, tool: `tool${i}` });
  at(1); await allow(); await allow(); await allow();
  assert.equal(await tallies.nudge("bot:a", CAL), undefined);
  assert.deepEqual(await tallies.record("bot:a", CAL, person("allow", true)), { counted: true });
});

test("non-person decisions persist their provenance but never count, deny or own a hint", async (t) => {
  const { tallies, allow, person, file, open } = await setup(t);
  await allow(); await allow(); await allow();
  const expiry = { ...person("deny", true), source: "expiry" as const };
  const sibling = { ...person("allow", true), source: "allow_list" as const };
  assert.deepEqual(await tallies.record("bot:a", CAL, expiry), { counted: false });
  assert.deepEqual(await tallies.record("bot:a", CAL, sibling), { counted: false });
  assert.deepEqual(await tallies.nudge("bot:a", CAL), { count: 3 });
  assert.deepEqual(await open().decision("bot:a", expiry.id, expiry.authorizationFingerprint), {
    id: expiry.id, authorizationFingerprint: expiry.authorizationFingerprint, answer: "deny", source: "expiry",
  });
  assert.deepEqual(await open().record("bot:a", CAL, sibling), { counted: false });
  assert.deepEqual(await tallies.record("bot:a", CAL, person("allow", true)), { counted: true, hintCount: 4 });
  assert.equal(JSON.parse(await fs.readFile(file(), "utf8")).decisions.length, 6);
});

test("malformed JSON is preserved and cannot reset replay protection, even after a later repair", async (t) => {
  const { tallies, person, file, open } = await setup(t);
  const decision = person();
  await tallies.record("bot:a", CAL, decision);
  const evidence = '{"version":1,"decisions":[';
  await fs.writeFile(file(), evidence);
  await assert.rejects(open().record("bot:a", CAL, decision), /read|receipt|ledger/iu);
  assert.equal(await fs.readFile(file(), "utf8"), evidence);
  await assert.rejects(tallies.decision("bot:a", decision.id, decision.authorizationFingerprint), /read|receipt|ledger/iu);
  await assert.rejects(tallies.nudge("bot:a", CAL), /read|receipt|ledger/iu);
  await assert.rejects(tallies.forget("bot:a", CAL), /read|receipt|ledger/iu);
  await fs.writeFile(file(), JSON.stringify({ version: 1, classes: [], decisions: [] }));
  await assert.rejects(open().record("bot:a", CAL, decision), /read|receipt|ledger/iu);
});

test("malformed or missing receipt state is refused without salvaging a partial ledger", async (t) => {
  const changes: Array<[string, (v: Record<string, unknown>) => void]> = [
    ["missing receipts", (v) => { delete v.decisions; }],
    ["duplicate identity", (v) => { (v.decisions as unknown[]).push((v.decisions as unknown[])[0]); }],
    ["bad provenance", (v) => { ((v.decisions as Record<string, unknown>[])[0]!).source = "renderer"; }],
    ["invalid count", (v) => { ((v.decisions as Record<string, unknown>[])[0]!).result = { counted: false }; }],
    ["bad class", (v) => { ((v.classes as Record<string, unknown>[])[0]!).allowed = [-1]; }],
    ["missing cache identities", (v) => { delete ((v.classes as Record<string, unknown>[])[0]!).allowedDecisionIds; }],
    ["wrong cache identity", (v) => { ((v.classes as Record<string, unknown>[])[0]!).allowedDecisionIds = ["not-a-receipt"]; }],
    ["duplicate cache identity", (v) => {
      const history = (v.classes as Record<string, unknown>[])[0]!;
      (history.allowed as number[]).push(START);
      (history.allowedDecisionIds as string[]).push((history.allowedDecisionIds as string[])[0]!);
    }],
    ["extra contract fields", (v) => { v.unknown = true; }],
  ];
  for (const [name, change] of changes) await t.test(name, async (child) => {
    const { tallies, person, file, open } = await setup(child);
    const decision = person();
    await tallies.record("bot:a", CAL, decision);
    const document = JSON.parse(await fs.readFile(file(), "utf8"));
    change(document);
    const evidence = JSON.stringify(document);
    await fs.writeFile(file(), evidence);
    await assert.rejects(open().record("bot:a", CAL, decision), /read|receipt|ledger/iu);
    assert.equal(await fs.readFile(file(), "utf8"), evidence);
  });
});

test("a file or receipt lost after observation cannot become an empty ledger", async (t) => {
  for (const mode of ["file", "receipt"]) await t.test(mode, async (child) => {
    const { tallies, person, file, open } = await setup(child);
    const decision = person();
    await tallies.record("bot:a", CAL, decision);
    if (mode === "file") await fs.rm(file());
    else {
      const document = JSON.parse(await fs.readFile(file(), "utf8"));
      document.decisions = [];
      await fs.writeFile(file(), JSON.stringify(document));
    }
    await assert.rejects(open().record("bot:a", CAL, decision), /read|receipt|ledger/iu);
    if (mode === "file") await assert.rejects(fs.stat(file()), { code: "ENOENT" });
  });
});

test("an unreadable ledger path is preserved and blocks bookkeeping", async (t) => {
  const { tallies, person, file, open } = await setup(t);
  await fs.mkdir(file(), { recursive: true });
  await assert.rejects(tallies.record("bot:a", CAL, person()), /read|receipt|ledger/iu);
  assert.equal((await fs.stat(file())).isDirectory(), true);
  await fs.rmdir(file());
  await assert.rejects(open().record("bot:a", CAL, person()), /read|receipt|ledger/iu);
});

test("forgetBot fences in-flight and queued writers and preserves other Bots and sibling files", async (t) => {
  const { dir, person, file, tallies, open } = await setup(t);
  await tallies.record("bot:a", CAL, person());
  await tallies.record("bot:b", CAL, person());
  const sibling = path.join(path.dirname(file()), "rules.json");
  await fs.writeFile(sibling, "keep");
  let deletion: Promise<void> | undefined;
  const racing = createBotApprovalTallies({ profileDir: () => dir, now: () => {
    deletion = racing.forgetBot("bot:a");
    return START;
  } });
  const active = racing.record("bot:a", CAL, person());
  const queued = open().record("bot:a", CAL, person());
  const results = await Promise.allSettled([active, queued]);
  assert.deepEqual(results.map((r) => r.status), ["rejected", "rejected"]);
  assert.ok(deletion);
  await deletion;
  await assert.rejects(fs.stat(file()), { code: "ENOENT" });
  assert.equal(await fs.readFile(sibling, "utf8"), "keep");
  assert.equal(JSON.parse(await fs.readFile(file("bot:b"), "utf8")).decisions.length, 1);
  await assert.rejects(open().record("bot:a", CAL, person()), /no longer exists|deleted/iu);
  await racing.forgetBot("bot:a");
});

test("a hint counts the current approval beyond the 20-time display cache", async (t) => {
  const { tallies, person, allow, open } = await setup(t);
  for (let i = 0; i < 25; i++) await allow();
  assert.deepEqual(await tallies.nudge("bot:a", CAL), { count: 20 });
  const decision = person("allow", true);
  assert.deepEqual(await tallies.record("bot:a", CAL, decision), { counted: true, hintCount: 21 });
  assert.deepEqual(await open().record("bot:a", CAL, decision), { counted: true, hintCount: 21 });
  assert.deepEqual(await open().nudge("bot:a", CAL), { count: 20 });
});

test("non-person receipts leave class history unchanged and withdrawal cannot mint a decision", async (t) => {
  const { tallies, person, allow, file, at } = await setup(t);
  await allow(); await allow(); await allow();
  const history = JSON.parse(await fs.readFile(file(), "utf8")).classes;
  at(20);
  await tallies.record("bot:a", CAL, { ...person("deny", true), source: "expiry" });
  await tallies.record("bot:a", CAL, { ...person("allow", true), source: "allow_list" });
  assert.deepEqual(JSON.parse(await fs.readFile(file(), "utf8")).classes, history);
  const bytes = await fs.readFile(file(), "utf8");
  const withdrawal = { ...person(), answer: "withdrawal" };
  await assert.rejects(tallies.record("bot:a", CAL, withdrawal as never), /Invalid.*decision/iu);
  assert.equal(await fs.readFile(file(), "utf8"), bytes);
  assert.equal(await tallies.decision("bot:a", withdrawal.id, withdrawal.authorizationFingerprint), undefined);
});

test("evidence changed between read and atomic publication is never overwritten", async (t) => {
  const { dir, tallies, person, file } = await setup(t);
  await tallies.record("bot:a", CAL, person());
  // Replacing the file synchronously in the clock hook places the corruption
  // after the transaction read, while the real atomic writer still runs normally.
  const { writeFileSync } = await import("node:fs");
  const evidence = '{"decisions":';
  const racing = createBotApprovalTallies({ profileDir: () => dir, now: () => {
    writeFileSync(file(), evidence);
    return START;
  } });
  await assert.rejects(racing.record("bot:a", CAL, person()), /read|receipt|ledger/iu);
  assert.equal(await fs.readFile(file(), "utf8"), evidence);
  assert.deepEqual((await fs.readdir(path.dirname(file()))).filter((name) => name.endsWith(".tmp")), []);
});

test("historical decidedAt preserves the original event and normal replay never substitutes a new clock", async (t) => {
  const { tallies, allow, person, at, open, file } = await setup(t);
  await allow(); await allow(); await allow();
  at(3); await allow();
  at(5);
  const original = { ...person("allow_always", false), decidedAt: START + DAY };
  assert.deepEqual(await tallies.record("bot:a", CAL, original), { counted: true });
  const history = JSON.parse(await fs.readFile(file(), "utf8")).classes[0].allowed;
  assert.deepEqual(history, [START, START, START, START + DAY, START + 3 * DAY], "recovering an old event preserves later approvals");
  const bytes = await fs.readFile(file(), "utf8");
  const { decidedAt: _time, ...ordinaryReplay } = original;
  at(30);
  assert.deepEqual(await open().record("bot:a", CAL, ordinaryReplay), { counted: true });
  assert.deepEqual(await open().record("bot:a", CAL, original), { counted: true });
  await assert.rejects(open().record("bot:a", CAL, { ...original, decidedAt: START + 2 * DAY }), /decision.*changed|conflict/iu);
  assert.equal(await fs.readFile(file(), "utf8"), bytes);
  await assert.rejects(open().record("bot:a", CAL, { ...ordinaryReplay, answer: "deny" }), /decision.*changed|conflict/iu);
  await assert.rejects(open().record("bot:a", CAL, { ...ordinaryReplay, answer: "allow" }), /decision.*changed|conflict/iu);
});

test("published completion clears only history preceding the original Always and is durably idempotent", async (t) => {
  const { tallies, person, allow, at, file, open } = await setup(t);
  await allow(); await allow(); await allow();
  await tallies.record("bot:a", CAL, person("deny"));
  at(1);
  const always = person("allow_always", false);
  await tallies.record("bot:a", CAL, always);
  at(2); await allow(); await allow();
  at(3);
  await tallies.completePublication("bot:a", always.id, always.authorizationFingerprint, "published");
  assert.equal(await open().nudge("bot:a", CAL), undefined, "the publishing Always is excluded while two later approvals remain");
  assert.deepEqual(JSON.parse(await fs.readFile(file(), "utf8")).classes[0].allowed, [START + 2 * DAY, START + 2 * DAY]);
  await allow();
  assert.deepEqual(await open().nudge("bot:a", CAL), { count: 3 }, "the third later approval offers again");
  at(4);
  await tallies.record("bot:a", CAL, person("deny"));
  const before = await fs.readFile(file(), "utf8");
  await open().completePublication("bot:a", always.id, always.authorizationFingerprint, "published");
  assert.equal(await fs.readFile(file(), "utf8"), before, "recovered completion does not rewrite or reset later decisions");
  assert.equal(await tallies.nudge("bot:a", CAL), undefined);
  assert.deepEqual(await open().record("bot:a", CAL, always), { counted: true });
});

test("revoked completion grants nothing and cannot later clear history as a publication", async (t) => {
  const { tallies, person, allow, at, file, open } = await setup(t);
  await allow(); await allow(); await allow();
  at(1);
  const always = person("allow_always", false);
  await tallies.record("bot:a", CAL, always);
  await tallies.completePublication("bot:a", always.id, always.authorizationFingerprint, "revoked");
  assert.deepEqual(await tallies.nudge("bot:a", CAL), { count: 4 });
  const bytes = await fs.readFile(file(), "utf8");
  await open().completePublication("bot:a", always.id, always.authorizationFingerprint, "revoked");
  await open().completePublication("bot:a", always.id, always.authorizationFingerprint, "published");
  assert.equal(await fs.readFile(file(), "utf8"), bytes, "the first terminal publication outcome wins");
  assert.deepEqual(await tallies.nudge("bot:a", CAL), { count: 4 });
  await assert.rejects(tallies.completePublication("bot:a", always.id, "changed", "published"), /decision|publication/iu);
  await assert.rejects(tallies.completePublication("bot:a", "unknown", "fingerprint", "published"), /decision|publication/iu);
  const once = person();
  await tallies.record("bot:a", CAL, once);
  await assert.rejects(tallies.completePublication("bot:a", once.id, once.authorizationFingerprint, "published"), /decision|publication/iu);
});

test("publication retains all ambiguous equal-time approvals and denials", async (t) => {
  const { tallies, person, allow, file } = await setup(t);
  await allow(); await allow(); await allow();
  const always = person("allow_always", false);
  await tallies.record("bot:a", CAL, always);
  await allow();
  await tallies.record("bot:a", CAL, person("deny"));
  await tallies.completePublication("bot:a", always.id, always.authorizationFingerprint, "published");
  assert.deepEqual(JSON.parse(await fs.readFile(file(), "utf8")).classes[0].allowed, [START, START, START, START], "only the exact publishing receipt is removed");
  assert.equal(await tallies.nudge("bot:a", CAL), undefined);
});

test("delayed original completions and decisions cannot erase or resurrect history across a newer publication", async (t) => {
  const { tallies, person, allow, at, open, file } = await setup(t);
  await allow();
  at(2);
  const latest = person("allow_always", false);
  await tallies.record("bot:a", CAL, latest);
  await tallies.completePublication("bot:a", latest.id, latest.authorizationFingerprint, "published");
  at(3); await allow(); await allow(); await allow();
  await tallies.record("bot:a", CAL, { ...person("deny"), decidedAt: START + DAY });
  assert.deepEqual(await tallies.nudge("bot:a", CAL), { count: 3 }, "a recovered denial before the completed grant stays cleared");
  const oldAlways = { ...person("allow_always", false), decidedAt: START + DAY };
  await tallies.record("bot:a", CAL, oldAlways);
  await open().completePublication("bot:a", oldAlways.id, oldAlways.authorizationFingerprint, "published");
  assert.deepEqual(await tallies.nudge("bot:a", CAL), { count: 3 });
  assert.deepEqual(JSON.parse(await fs.readFile(file(), "utf8")).classes[0].allowed, [START + 3 * DAY, START + 3 * DAY, START + 3 * DAY]);
});

test("publication resets preserve the original weekly hint entitlement", async (t) => {
  const { tallies, person, allow, at, open } = await setup(t);
  await allow(); await allow(); await allow();
  const hint = person("allow", true);
  await tallies.record("bot:a", CAL, hint);
  at(1);
  const always = person("allow_always", false);
  await tallies.record("bot:a", CAL, always);
  await tallies.completePublication("bot:a", always.id, always.authorizationFingerprint, "published");
  at(2); await allow(); await allow(); await allow();
  assert.deepEqual(await tallies.record("bot:a", CAL, person("allow", true)), { counted: true });
  assert.deepEqual(await open().record("bot:a", CAL, hint), { counted: true, hintCount: 4 });
  at(7);
  assert.deepEqual(await open().record("bot:a", CAL, person("allow", true)), { counted: true, hintCount: 5 });
});

test("published Always does not make two later Once approvals nudge; the third does", async (t) => {
  const { tallies, person, allow, at, open } = await setup(t);
  const always = person("allow_always", false);
  const immutableResult = await tallies.record("bot:a", CAL, always);
  await tallies.completePublication("bot:a", always.id, always.authorizationFingerprint, "published");
  at(1); await allow();
  at(2); await allow();
  assert.equal(await open().nudge("bot:a", CAL), undefined);
  assert.deepEqual(await open().record("bot:a", CAL, always), immutableResult);
  await open().completePublication("bot:a", always.id, always.authorizationFingerprint, "published");
  assert.equal(await tallies.nudge("bot:a", CAL), undefined, "replay cannot restore its own counted event");
  at(3); await allow();
  assert.deepEqual(await open().nudge("bot:a", CAL), { count: 3 });
});

test("historical Always completion excludes itself without losing later Once history", async (t) => {
  const { tallies, person, allow, at, open } = await setup(t);
  await allow();
  at(2); await allow();
  at(5);
  const original = { ...person("allow_always", false), decidedAt: START + DAY };
  await tallies.record("bot:a", CAL, original);
  await tallies.completePublication("bot:a", original.id, original.authorizationFingerprint, "published");
  at(6); await allow();
  assert.equal(await open().nudge("bot:a", CAL), undefined);
  const { decidedAt: _at, ...replay } = original;
  assert.deepEqual(await open().record("bot:a", CAL, replay), { counted: true });
  await open().completePublication("bot:a", original.id, original.authorizationFingerprint, "published");
  at(7); await allow();
  assert.deepEqual(await tallies.nudge("bot:a", CAL), { count: 3 });
});

test("published identity filtering handles an older cached publication without restoring its own event", async (t) => {
  const { tallies, person, at, file, open } = await setup(t);
  const always = person("allow_always", false);
  await tallies.record("bot:a", CAL, always);
  await tallies.completePublication("bot:a", always.id, always.authorizationFingerprint, "published");
  at(1);
  const first = person();
  await tallies.record("bot:a", CAL, first);
  at(2);
  const second = person();
  await tallies.record("bot:a", CAL, second);
  const document = JSON.parse(await fs.readFile(file(), "utf8"));
  // The receipt is already published but a stale cache still names its exact event.
  document.classes[0].allowed = [START, START + DAY, START + 2 * DAY];
  document.classes[0].allowedDecisionIds = [always.id, first.id, second.id];
  await fs.writeFile(file(), JSON.stringify(document));
  assert.equal(await open().nudge("bot:a", CAL), undefined);
  assert.deepEqual(await open().record("bot:a", CAL, always), { counted: true });
  await open().completePublication("bot:a", always.id, always.authorizationFingerprint, "published");
  assert.equal(await open().nudge("bot:a", CAL), undefined);
  at(3);
  const third = person();
  await tallies.record("bot:a", CAL, third);
  assert.deepEqual(await open().nudge("bot:a", CAL), { count: 3 });
  assert.deepEqual(JSON.parse(await fs.readFile(file(), "utf8")).classes[0].allowedDecisionIds, [first.id, second.id, third.id]);
});

test("publication never subtracts another equal-time event when its own event fell out of the 20-time cache", async (t) => {
  const { tallies, person, allow, file, open } = await setup(t);
  const always = person("allow_always", false);
  await tallies.record("bot:a", CAL, always);
  for (let i = 0; i < 25; i++) await allow();
  await tallies.completePublication("bot:a", always.id, always.authorizationFingerprint, "published");
  assert.deepEqual(await open().nudge("bot:a", CAL), { count: 20 });
  assert.equal(JSON.parse(await fs.readFile(file(), "utf8")).classes[0].allowed.length, 20);
});

test("published receipt replay cannot reintroduce its count after class forget or eviction", async (t) => {
  for (const mode of ["forget", "evict"]) await t.test(mode, async (child) => {
    const { tallies, person, allow, at, open } = await setup(child);
    const always = person("allow_always", false);
    await tallies.record("bot:a", CAL, always);
    await tallies.completePublication("bot:a", always.id, always.authorizationFingerprint, "published");
    if (mode === "forget") await tallies.forget("bot:a", CAL);
    else for (let i = 0; i < 100; i++) await allow({ ...CAL, tool: `other${i}` });
    assert.deepEqual(await open().record("bot:a", CAL, always), { counted: true });
    await open().completePublication("bot:a", always.id, always.authorizationFingerprint, "published");
    at(1); await allow(); await allow();
    assert.equal(await tallies.nudge("bot:a", CAL), undefined);
    await allow();
    assert.deepEqual(await open().nudge("bot:a", CAL), { count: 3 });
  });
});

const PUBLICATION_CONTEXT = { consentRevision: "a".repeat(64), label: "Google Calendar · Create event", title: "Create event" };

test("publication context is captured immutably and survives reopen and connection rename", async (t) => {
  const { tallies, person, open, file } = await setup(t);
  const decision = person("allow_always", true);
  const context = { ...PUBLICATION_CONTEXT };
  const pending = tallies.record("bot:a", CAL, { ...decision, publicationContext: context });
  context.label = "Renamed calendar";
  await pending;
  const expected = { decision: { id: decision.id, authorizationFingerprint: decision.authorizationFingerprint, answer: "allow_always", source: "person" },
    target: CAL, offered: true, decidedAt: START, context: PUBLICATION_CONTEXT, status: "pending" };
  assert.deepEqual(await open().publication("bot:a", decision.id, decision.authorizationFingerprint), expected);
  const cloned = (await tallies.publication("bot:a", decision.id, decision.authorizationFingerprint))!;
  cloned.context.title = "Mutated return value";
  cloned.target = { kind: "site", host: "evil.example", action: "click" };
  assert.deepEqual(await open().publication("bot:a", decision.id, decision.authorizationFingerprint), expected);
  const before = await fs.readFile(file(), "utf8");
  assert.deepEqual(await open().record("bot:a", CAL, decision), { counted: true });
  assert.deepEqual(await open().record("bot:a", CAL, { ...decision, publicationContext: { ...PUBLICATION_CONTEXT } }), { counted: true });
  await assert.rejects(open().record("bot:a", CAL, { ...decision, publicationContext: context }), /decision.*changed|context|conflict/iu);
  assert.equal(await fs.readFile(file(), "utf8"), before);
});

test("pending publication reads never count, grant or invent legacy context", async (t) => {
  const { tallies, person, open, file, allow } = await setup(t);
  const connection = person("allow_always", false);
  const site = person("allow_always", true);
  const legacy = person("allow_always", false);
  await tallies.record("bot:a", CAL, { ...connection, publicationContext: PUBLICATION_CONTEXT });
  await tallies.record("bot:a", { kind: "site", host: "amazon.com", action: "click" }, { ...site,
    publicationContext: { ...PUBLICATION_CONTEXT, label: "Click on amazon.com", title: "amazon.com" } });
  await tallies.record("bot:a", FOLDER, legacy);
  await allow();
  const bytes = await fs.readFile(file(), "utf8");
  assert.deepEqual((await open().pendingPublications("bot:a")).map((r) => [r.decision.id, r.target.kind, r.status]), [
    [connection.id, "connection", "pending"], [site.id, "site", "pending"],
  ]);
  assert.equal(await open().publication("bot:a", legacy.id, legacy.authorizationFingerprint), undefined);
  assert.equal((await open().decision("bot:a", legacy.id, legacy.authorizationFingerprint))?.answer, "allow_always");
  assert.equal(await tallies.publication("bot:a", connection.id, "changed"), undefined);
  assert.equal(await tallies.publication("bot:a", "unknown", "fingerprint"), undefined);
  assert.equal(await fs.readFile(file(), "utf8"), bytes);
  await tallies.completePublication("bot:a", connection.id, connection.authorizationFingerprint, "published");
  await tallies.completePublication("bot:a", site.id, site.authorizationFingerprint, "revoked");
  assert.equal((await open().publication("bot:a", connection.id, connection.authorizationFingerprint))?.status, "published");
  assert.equal((await open().publication("bot:a", site.id, site.authorizationFingerprint))?.status, "revoked");
  assert.deepEqual(await open().pendingPublications("bot:a"), []);
});

test("legacy connection decisions stay acknowledgeable but cannot acquire new publication context", async (t) => {
  const { tallies, person, open } = await setup(t);
  const legacy = person("allow_always", false);
  await tallies.record("bot:a", CAL, legacy);
  assert.deepEqual(await open().record("bot:a", CAL, legacy), { counted: true });
  assert.equal((await open().decision("bot:a", legacy.id, legacy.authorizationFingerprint))?.answer, "allow_always");
  assert.equal(await open().publication("bot:a", legacy.id, legacy.authorizationFingerprint), undefined);
  assert.deepEqual(await open().pendingPublications("bot:a"), []);
  await assert.rejects(tallies.record("bot:a", CAL, { ...legacy, publicationContext: PUBLICATION_CONTEXT }), /decision.*changed|context|conflict/iu);
});

test("publication context is allowed only on person Always connection/site decisions and has strict safe display fields", async (t) => {
  const { tallies, person, file } = await setup(t);
  const decision = person("allow_always", false);
  for (const context of [
    { ...PUBLICATION_CONTEXT, consentRevision: "not-a-digest" },
    { ...PUBLICATION_CONTEXT, label: "x".repeat(201) },
    { ...PUBLICATION_CONTEXT, title: "two  spaces" },
    { ...PUBLICATION_CONTEXT, label: " Calendar" },
    { ...PUBLICATION_CONTEXT, title: "Create\u202eevent" },
    { ...PUBLICATION_CONTEXT, label: "https://owner.example/private" },
    { consentRevision: PUBLICATION_CONTEXT.consentRevision, label: "Calendar" },
    { ...PUBLICATION_CONTEXT, rawArgs: { secret: "do-not-persist" } },
  ]) {
    await assert.rejects(tallies.record("bot:a", CAL, { ...decision, publicationContext: context } as never), /context|publication/iu);
  }
  await assert.rejects(tallies.record("bot:a", FOLDER, { ...decision, publicationContext: PUBLICATION_CONTEXT }), /context|publication/iu);
  await assert.rejects(tallies.record("bot:a", CAL, { ...person("allow"), publicationContext: PUBLICATION_CONTEXT }), /context|publication/iu);
  await assert.rejects(tallies.record("bot:a", CAL, { ...decision, source: "allow_list", publicationContext: PUBLICATION_CONTEXT }), /context|publication/iu);
  await assert.rejects(fs.stat(file()), { code: "ENOENT" });
});

test("changed or missing observed publication context fails closed and preserves evidence", async (t) => {
  for (const variant of ["rename", "missing", "malformed"]) await t.test(variant, async (child) => {
    const { tallies, person, file, open } = await setup(child);
    const decision = person("allow_always", false);
    await tallies.record("bot:a", CAL, { ...decision, publicationContext: PUBLICATION_CONTEXT });
    const document = JSON.parse(await fs.readFile(file(), "utf8"));
    if (variant === "missing") delete document.decisions[0].publicationContext;
    else document.decisions[0].publicationContext.label = variant === "rename" ? "Valid but different label" : "bad\nlabel";
    const evidence = JSON.stringify(document);
    await fs.writeFile(file(), evidence);
    await assert.rejects(open().pendingPublications("bot:a"), /read|receipt|ledger/iu);
    assert.equal(await fs.readFile(file(), "utf8"), evidence);
  });
});

test("committed publication recovery preserves context and never resets a later denial twice", async (t) => {
  const { tallies, person, allow, at, open } = await setup(t);
  await allow(); await allow(); await allow();
  at(1);
  const always = person("allow_always", false);
  await tallies.record("bot:a", CAL, { ...always, publicationContext: PUBLICATION_CONTEXT });
  // The book has committed. A crash leaves this tally pending until a read-only
  // reconciler supplies that exact historical operation's result.
  assert.equal((await open().pendingPublications("bot:a")).length, 1);
  await open().completePublication("bot:a", always.id, always.authorizationFingerprint, "published");
  at(2);
  await tallies.record("bot:a", CAL, person("deny"));
  await open().completePublication("bot:a", always.id, always.authorizationFingerprint, "published");
  assert.equal(await tallies.nudge("bot:a", CAL), undefined);
  assert.deepEqual(await open().record("bot:a", CAL, always), { counted: true });
  assert.deepEqual((await open().publication("bot:a", always.id, always.authorizationFingerprint))?.context, PUBLICATION_CONTEXT);
  assert.deepEqual(await open().pendingPublications("bot:a"), []);
});

test("publication queries and context writes respect the shared deletion fence", async (t) => {
  const { tallies, person, open, file } = await setup(t);
  await tallies.record("bot:b", CAL, { ...person("allow_always"), publicationContext: PUBLICATION_CONTEXT });
  const pending = tallies.record("bot:a", CAL, { ...person("allow_always"), publicationContext: PUBLICATION_CONTEXT });
  const deleted = open().forgetBot("bot:a");
  await assert.rejects(pending, /no longer exists/u);
  await deleted;
  await assert.rejects(open().pendingPublications("bot:a"), /no longer exists/u);
  assert.equal((await open().pendingPublications("bot:b")).length, 1);
  await assert.rejects(fs.stat(file()), { code: "ENOENT" });
});


test("real book commit with a lost acknowledgement reconciles the pending tally without regrant or a second reset", async (t) => {
  const { dir, tallies, person, allow, at, open } = await setup(t);
  const store = new DataStore<ToolApprovalRulesDocument>("tool-approval-rules.json", emptyToolApprovalRulesDocument(), () => dir,
    { normalize: normalizeToolApprovalRulesDocument, maxBytes: TOOL_APPROVAL_RULES_MAX_BYTES, reloadBeforeWrite: true, fileMode: 0o600 });
  let uncertain = true;
  const rules = new ToolApprovalRuleBook({
    load: () => store.load(), loadedFromCorruptFile: () => store.loadedFromCorruptFile(),
    async update<R>(mutation: (draft: ToolApprovalRulesDocument) => R | Promise<R>): Promise<R> {
      const result = await store.update(mutation);
      if (uncertain) { uncertain = false; throw new Error("Acknowledgement lost after the book committed"); }
      return result;
    },
  }, () => new Date(START + DAY), undefined, { knownBot: async () => true });
  await allow(); await allow(); await allow();
  at(1);
  const always = person("allow_always", true);
  const context = { ...PUBLICATION_CONTEXT, consentRevision: await rules.botConsentRevision("bot:a", CAL) };
  await tallies.record("bot:a", CAL, { ...always, publicationContext: context });
  const pending = (await open().pendingPublications("bot:a"))[0]!;
  assert.equal(await rules.botGrantOperation("bot:a", pending.decision.id), undefined);
  assert.deepEqual(await rules.listBot(), [], "pending entitlement reads install no authority");
  let guards = 0;
  await assert.rejects(rules.grantBot("bot:a", pending.target, pending.context.label, pending.decision.id, {
    expectedConsentRevision: pending.context.consentRevision, validatePublication: async () => { guards++; },
  }), /Acknowledgement lost/u);
  assert.equal((await open().pendingPublications("bot:a")).length, 1);
  at(2);
  await tallies.record("bot:a", CAL, person("deny"));
  const committed = await rules.botGrantOperation("bot:a", always.id);
  assert.ok(committed);
  assert.equal(committed.status, "published");
  await open().completePublication("bot:a", always.id, always.authorizationFingerprint, committed.status);
  await open().completePublication("bot:a", always.id, always.authorizationFingerprint, committed.status);
  assert.deepEqual(await open().record("bot:a", CAL, always), { counted: true });
  assert.equal(await tallies.nudge("bot:a", CAL), undefined, "the later denial survives acknowledgement recovery");
  await rules.revokeBot("bot:a", (await rules.listBot())[0]!.id);
  const removed = await rules.botGrantOperation("bot:a", always.id);
  assert.equal(removed?.status, "revoked");
  await open().completePublication("bot:a", always.id, always.authorizationFingerprint, removed!.status);
  assert.deepEqual(await rules.listBot(), []);
  assert.deepEqual(await open().pendingPublications("bot:a"), []);
  assert.equal(await tallies.nudge("bot:a", CAL), undefined);
  assert.equal(guards, 1, "historical reconciliation never calls the first-publication guard again");
});
