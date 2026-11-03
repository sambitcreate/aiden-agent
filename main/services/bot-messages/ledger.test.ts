import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { botMessageRequestId } from "../../../renderer/shared/bot-messages.js";
import { createBotMessageLedger, type BotMessageDelivery } from "./ledger.js";
export function delivery(from = "A", to = "B", now = 1): BotMessageDelivery {
  const id = randomUUID();
  return {
    id,
    fromBotId: from,
    toBotId: to,
    fromName: from,
    toName: to,
    hop: 1,
    targetRequestId: botMessageRequestId(from, 1, id),
    createdAt: now,
    deadline: now + 1800000,
    status: "delivered",
    message: "hello",
    waiting: [],
    effects: [
      { id: `${id}:target`, kind: "target", botId: to, requestId: botMessageRequestId(from, 1, id), text: "hello" },
    ],
  };
}
async function fixture(t: TestContext) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "bot-ledger-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let now = new Date(2026, 10, 3, 12).getTime();
  const file = path.join(dir, "bots", "bot-messages.json");
  const open = () => createBotMessageLedger({ file: () => file, now: () => now });
  const ledger = open();
  const settle = async (id: string) =>
    ledger.update(id, (r) => ({
      ...r,
      status: "answered",
      settledAt: now,
      outcome: "silent",
      effects: r.effects.map((e) => ({ ...e, acknowledgedAt: now })),
    }));
  return {
    ledger,
    open,
    file,
    settle,
    clock: (n: number) => {
      now += n;
    },
    row: (from = "A", to = "B") => delivery(from, to, now),
  };
}
test("opposite direction quota admission at 29 is atomic across ledger instances", async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 29; i++) {
    const r = f.row(i % 2 ? "A" : "B", i % 2 ? "B" : "A");
    await f.ledger.reserve(r);
    await f.settle(r.id);
    f.clock(301000);
  }
  const results = await Promise.all([f.ledger.reserve(f.row()), f.open().reserve(f.row("B", "A"))]);
  assert.equal(results.filter((r) => "row" in r).length, 1);
  assert.equal(results.filter((r) => "refused" in r && r.refused.reason === "pair_daily").length, 1);
  assert.equal((await stat(f.file)).mode & 0o777, 0o600);
});
test("one child reservation and three in-flight slots are atomic", async (t) => {
  const f = await fixture(t);
  const parent = f.row();
  await f.ledger.reserve(parent);
  const children = [f.row("B", "C"), f.row("B", "D")].map((r) => ({
    ...r,
    hop: 2 as const,
    parentDeliveryId: parent.id,
  }));
  const result = await Promise.all(children.map((r) => f.ledger.reserve(r)));
  assert.equal(result.filter((r) => "row" in r).length, 1);
  assert.equal(result.filter((r) => "refused" in r && r.refused.reason === "once_per_turn").length, 1);
  await f.ledger.reserve(f.row("A", "C"));
  await f.ledger.reserve(f.row("A", "D"));
  assert.deepEqual(await f.ledger.reserve(f.row("A", "E")), { refused: { reason: "in_flight" } });
});
test("the twentieth send starts a durable ten-minute cooldown", async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 20; i++) {
    const r = f.row("A", `B${i}`);
    assert.ok("row" in (await f.ledger.reserve(r)));
    await f.settle(r.id);
  }
  f.clock(6 * 60000);
  const refusal = await f.open().reserve(f.row("A", "last"));
  assert.deepEqual(refusal, { refused: { reason: "burst", retryAfter: 4 * 60000 } });
  f.clock(4 * 60000);
  assert.ok("row" in (await f.open().reserve(f.row("A", "last"))));
});
test("replay receipts survive display pruning and mismatched replay fails closed", async (t) => {
  const f = await fixture(t);
  const first = f.row();
  await f.ledger.reserve(first);
  await f.settle(first.id);
  for (let i = 0; i < 502; i++) {
    const r = f.row(`A${i}`, `B${i}`);
    await f.ledger.reserve(r);
    await f.settle(r.id);
  }
  assert.equal(await f.ledger.get(first.id), undefined);
  assert.deepEqual(await f.open().reserve(first), { row: first, created: false });
  await assert.rejects(f.ledger.reserve({ ...first, message: "changed" }), /does not match/);
  // The original pair's count remains even though its first display row was pruned.
  for (let i = 0; i < 29; i++) {
    f.clock(301000);
    const row = f.row();
    assert.ok("row" in (await f.open().reserve(row)));
    await f.settle(row.id);
  }
  assert.deepEqual(await f.open().reserve(f.row()), { refused: { reason: "pair_daily" } });
});
test("capacity never evicts unfinished work and corruption preserves the file", async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 500; i++) await f.ledger.reserve(f.row(`A${i}`, `B${i}`));
  assert.deepEqual(await f.ledger.reserve(f.row()), { refused: { reason: "capacity" } });
  await writeFile(f.file, "broken");
  await assert.rejects(f.open().open(), /bookkeeping is unavailable/);
});
test("terminal compare-and-set retains pending effects and deletion fences writers", async (t) => {
  const f = await fixture(t);
  const row = f.row();
  await f.ledger.reserve(row);
  await Promise.all(
    ["answered", "expired"].map((status) =>
      f.ledger.update(row.id, (r) => ({
        ...r,
        status: status as "answered" | "expired",
        outcome: status === "answered" ? "silent" : "expired",
      })),
    ),
  );
  assert.equal((await f.ledger.get(row.id))?.status, "answered");
  assert.equal((await f.ledger.open()).length, 1);
  await f.ledger.forgetBot("B");
  assert.equal(await f.ledger.get(row.id), undefined);
  assert.equal(await f.ledger.update(row.id, (r) => r), undefined);
  await assert.rejects(f.ledger.reserve(row), /no longer exists/);
});
