import assert from "node:assert/strict";
import test from "node:test";

// Bot months start at local midnight; pin the zone so the oracle is fixed.
process.env.TZ = "UTC";

const { parseSpendingDocument, SpendingLedger, spendingBlockMessage, spendingMonth } = await import("./spending-core.js");

const NOW = Date.UTC(2026, 9, 26, 15, 0, 0);
const CHAT = { kind: "chat", id: "chat-1" } as const;

test("a chat stops after the request that crosses its limit, and Allow more adds the limit again", () => {
  const ledger = new SpendingLedger();
  const settings = { chatUsd: 5 };
  ledger.record(CHAT, 3.9, settings, NOW);
  assert.equal(ledger.status("chat", "chat-1", settings, NOW)?.state, "under");
  assert.equal(ledger.block(CHAT, settings, NOW), undefined);
  ledger.record(CHAT, 0.2, settings, NOW);
  assert.equal(ledger.status("chat", "chat-1", settings, NOW)?.state, "nearing");
  // The crossing request still counts in full.
  ledger.record(CHAT, 1.3, settings, NOW);
  const block = ledger.block(CHAT, settings, NOW);
  assert.deepEqual(block && { ...block, spentUsd: Math.round(block.spentUsd * 100) / 100 }, { kind: "chat", allowedUsd: 5, spentUsd: 5.4 });
  assert.equal(spendingBlockMessage(block!), "This chat reached its $5.00 spending limit. Allow more to keep going.");

  const allowed = ledger.allowMore("chat", "chat-1", settings, NOW);
  assert.equal(allowed?.extraUsd, 5);
  assert.equal(allowed?.state, "under");
  assert.equal(ledger.block(CHAT, settings, NOW), undefined);
  // Allow more only acts on a chat at or near its limit.
  assert.equal(ledger.allowMore("chat", "chat-1", settings, NOW)?.extraUsd, 5);
});

test("without a limit nothing is shown or refused, and other chats are their own", () => {
  const ledger = new SpendingLedger();
  ledger.record(CHAT, 50, {}, NOW);
  assert.equal(ledger.status("chat", "chat-1", {}, NOW), undefined);
  assert.equal(ledger.block(CHAT, {}, NOW), undefined);
  // The spend was kept: a limit set later sees it.
  assert.equal(ledger.block(CHAT, { chatUsd: 10 }, NOW)?.kind, "chat");
  assert.equal(ledger.block({ kind: "chat", id: "chat-2" }, { chatUsd: 10 }, NOW), undefined);
});

test("a Bot's month starts over on the chosen day, and its own limit wins over the default", () => {
  assert.deepEqual(spendingMonth(Date.UTC(2026, 9, 10), 15), {
    key: "2026-09-15",
    start: Date.UTC(2026, 8, 15),
    end: Date.UTC(2026, 9, 15),
  });
  assert.equal(spendingMonth(Date.UTC(2026, 0, 3), 5).key, "2025-12-05");
  assert.equal(spendingMonth(Date.UTC(2026, 9, 1)).key, "2026-10-01");

  const ledger = new SpendingLedger();
  const settings = { botMonthUsd: 20, monthStartDay: 15 };
  const bot = { kind: "bot", id: "ada" } as const;
  ledger.record(bot, 21, settings, Date.UTC(2026, 9, 14, 23));
  assert.equal(ledger.block(bot, settings, Date.UTC(2026, 9, 14, 23))?.kind, "bot-month");
  // The 15th: a new month, nothing spent yet.
  assert.equal(ledger.block(bot, settings, Date.UTC(2026, 9, 15, 0)), undefined);
  assert.equal(ledger.status("bot", "ada", settings, Date.UTC(2026, 9, 15, 0))?.spentUsd, 0);

  ledger.record(bot, 21, settings, NOW);
  ledger.setBotLimit("ada", 50);
  assert.equal(ledger.block(bot, settings, NOW), undefined, "the Bot's own $50 applies");
  ledger.setBotLimit("ada", null);
  assert.equal(ledger.status("bot", "ada", settings, NOW), undefined, "this Bot has no limit");
  ledger.setBotLimit("ada", undefined);
  assert.equal(ledger.block(bot, settings, NOW)?.allowedUsd, 20, "back to the default");
});

test("a routine run has its own limit and also counts toward its Bot's month", () => {
  const ledger = new SpendingLedger();
  const settings = { botMonthUsd: 10, routineRunUsd: 1 };
  const run1 = { kind: "bot", id: "ada", run: "routine:t1:100" } as const;
  const run2 = { kind: "bot", id: "ada", run: "routine:t1:200" } as const;
  ledger.record(run1, 1.2, settings, NOW);
  assert.deepEqual(ledger.block(run1, settings, NOW), { kind: "run", allowedUsd: 1, spentUsd: 1.2 });
  assert.match(spendingBlockMessage(ledger.block(run1, settings, NOW)!), /The next run starts fresh\.$/u);
  assert.equal(ledger.block(run2, settings, NOW), undefined, "the next run starts fresh");
  assert.equal(ledger.status("bot", "ada", settings, NOW)?.spentUsd, 1.2);
  ledger.record(run2, 9, settings, NOW);
  // Over the month: the month's limit is what stops it.
  assert.equal(ledger.block(run2, settings, NOW)?.kind, "bot-month");
  assert.match(spendingBlockMessage(ledger.block(run2, settings, NOW)!, "Ada"), /^Ada reached its \$10\.00 spending limit for this month\./u);
});

test("the saved document survives a reload and drops anything malformed", () => {
  const ledger = new SpendingLedger();
  ledger.record(CHAT, 2, {}, NOW);
  ledger.record({ kind: "bot", id: "ada" }, 3, {}, NOW);
  ledger.setBotLimit("ada", 40);
  const run = { kind: "bot", id: "ada", run: "routine:t1:100" } as const;
  ledger.record(run, 1.2, {}, NOW);
  const reloaded = new SpendingLedger(parseSpendingDocument(JSON.parse(JSON.stringify(ledger.snapshot()))));
  assert.equal(reloaded.status("chat", "chat-1", { chatUsd: 5 }, NOW)?.spentUsd, 2);
  assert.equal(reloaded.status("bot", "ada", {}, NOW)?.limitUsd, 40);
  // A routine run resumed after a restart keeps its balance; a new run starts fresh.
  assert.deepEqual(reloaded.block(run, { routineRunUsd: 1 }, NOW), { kind: "run", allowedUsd: 1, spentUsd: 1.2 });
  assert.equal(reloaded.block({ ...run, run: "routine:t1:200" }, { routineRunUsd: 1 }, NOW), undefined);

  const parsed = parseSpendingDocument(
    JSON.parse(
      '{"version":1,"chats":{"__proto__":{"spentUsd":9},"ok":{"spentUsd":-4,"extraUsd":"x"}},' +
        '"bots":{"bad":{"period":"October","spentUsd":1}},"botLimits":{"a":0,"b":null,"c":12.345},' +
        '"runs":{"constructor":3,"routine:t1:1":"x","routine:t1:2":0.5}}',
    ),
  );
  assert.deepEqual(parsed, {
    version: 1,
    chats: { ok: { spentUsd: 0, extraUsd: 0 } },
    bots: {},
    botLimits: { b: null, c: 12.35 },
    runs: { "routine:t1:2": 0.5 },
  });
  assert.equal(Object.getPrototypeOf(parsed.chats), Object.prototype);
  assert.deepEqual(parseSpendingDocument({ version: 2, chats: { a: { spentUsd: 1 } } }).chats, {});
});
