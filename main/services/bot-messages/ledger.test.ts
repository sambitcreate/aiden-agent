import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile, stat, readFile, readdir } from "node:fs/promises";
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
      {
        id: `${id}:target`,
        kind: "target",
        botId: to,
        requestId: botMessageRequestId(from, 1, id),
        text: "hello",
      },
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
  assert.deepEqual(await f.ledger.reserve(f.row("A", "E")), {
    refused: { reason: "in_flight" },
  });
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
  assert.deepEqual(refusal, {
    refused: { reason: "burst", retryAfter: 4 * 60000 },
  });
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
  assert.deepEqual(await f.open().reserve(first), {
    row: first,
    created: false,
  });
  await assert.rejects(f.ledger.reserve({ ...first, message: "changed" }), /does not match/);
  // The original pair's count remains even though its first display row was pruned.
  for (let i = 0; i < 29; i++) {
    f.clock(301000);
    const row = f.row();
    assert.ok("row" in (await f.open().reserve(row)));
    await f.settle(row.id);
  }
  assert.deepEqual(await f.open().reserve(f.row()), {
    refused: { reason: "pair_daily" },
  });
});
test("capacity never evicts unfinished work and corruption preserves the file", async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 500; i++) await f.ledger.reserve(f.row(`A${i}`, `B${i}`));
  assert.deepEqual(await f.ledger.reserve(f.row()), {
    refused: { reason: "capacity" },
  });
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

test("unchanged transitions do not rewrite the ledger", async (t) => {
  const f = await fixture(t),
    row = f.row();
  await f.ledger.reserve(row);
  const before = await stat(f.file);
  await f.ledger.update(row.id, (r) => r);
  assert.equal((await stat(f.file)).ino, before.ino);
  assert.equal((await stat(f.file)).mtimeMs, before.mtimeMs);
});
test("corrupt ledger deletion preserves the file and rolls deferred purges forward after repair", async (t) => {
  const f = await fixture(t),
    row = f.row();
  await f.ledger.reserve(row);
  const good = await readFile(f.file, "utf8");
  await writeFile(f.file, "corrupt private bookkeeping");
  assert.deepEqual(await f.ledger.forgetBot("B"), []);
  assert.equal(await readFile(f.file, "utf8"), "corrupt private bookkeeping");
  const directory = path.join(path.dirname(f.file), ".bot-messages.json.pending-purges");
  const [marker] = await readdir(directory);
  assert.equal(JSON.parse(await readFile(path.join(directory, marker!), "utf8")), "B");
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.equal((await stat(path.join(directory, marker!))).mode & 0o777, 0o600);
  await assert.rejects(f.ledger.reserve(f.row()), /bookkeeping/);
  await writeFile(f.file, good);
  assert.equal(await f.open().get(row.id), undefined);
  await assert.rejects(f.open().reserve(f.row()), /no longer exists/);
  assert.equal((await f.open().open())[0]?.outcome, "failed");
});
test("damaged purge markers preserve evidence without blocking durable concurrent deletions", async (t) => {
  const f = await fixture(t);
  const prior = f.row("A", "B"),
    next = f.row("C", "D"),
    same = f.row("E", "B"),
    kept = f.row("F", "G");
  for (const row of [prior, next, same, kept]) await f.ledger.reserve(row);
  const good = await readFile(f.file, "utf8");
  await writeFile(f.file, "damaged main ledger");
  await f.ledger.forgetBot("B");
  await writeFile(f.file, good);
  const directory = path.join(path.dirname(f.file), ".bot-messages.json.pending-purges");
  const [name] = await readdir(directory);
  const marker = path.join(directory, name!);
  const saved = await readFile(marker, "utf8");
  await writeFile(marker, "{damaged purge intent");

  // A repeated deletion must also preserve its own damaged earlier marker.
  assert.deepEqual(await Promise.all([f.ledger.forgetBot("D"), f.open().forgetBot("B")]), [[], []]);
  assert.equal(await readFile(marker, "utf8"), "{damaged purge intent");
  assert.equal(await readFile(f.file, "utf8"), good, "unreadable bookkeeping never partially rewrites the ledger");
  const markers = await readdir(directory);
  assert.equal(markers.length, 3);
  for (const name of markers) {
    assert.equal((await stat(path.join(directory, name))).mode & 0o777, 0o600);
  }
  assert.ok(markers.some((name) => name.startsWith(createHash("sha256").update("D").digest("hex"))));

  // A fresh process has none of this module's in-memory tombstones.
  const checkRestart = async (repaired: boolean) => {
    await promisify(execFile)(process.execPath, [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `
      import assert from 'node:assert/strict';
      import { createBotMessageLedger, BotMessageLedgerUnavailable } from ${JSON.stringify(new URL("./ledger.ts", import.meta.url).href)};
      const [file, input, repaired] = process.argv.slice(1);
      const { prior, next, same, kept } = JSON.parse(input);
      const ledger = createBotMessageLedger({ file: () => file, now: () => kept.createdAt });
      if (repaired === 'false') {
        await assert.rejects(ledger.open(), BotMessageLedgerUnavailable);
        await assert.rejects(ledger.reserve(prior), BotMessageLedgerUnavailable);
        await assert.rejects(ledger.receipt(next.id), BotMessageLedgerUnavailable);
      } else {
        for (const row of [prior, next, same]) {
          assert.equal(await ledger.get(row.id), undefined);
          assert.equal(await ledger.receipt(row.id), undefined);
          await assert.rejects(ledger.reserve(row), /no longer exists/);
        }
        assert.equal((await ledger.get(kept.id)).id, kept.id);
      }
    `,
      f.file,
      JSON.stringify({ prior, next, same, kept }),
      String(repaired),
    ]);
  };
  await checkRestart(false);
  await writeFile(marker, saved);
  await checkRestart(true);
});
test("receipts keep hashed replay identity without private messages and collect independently from display rows", async (t) => {
  const f = await fixture(t),
    row = { ...f.row(), message: "Private receipt text", taskId: "41" };
  row.effects[0]!.text = row.message;
  await f.ledger.reserve(row);
  const receipt = await f.ledger.receipt(row.id);
  assert.equal(receipt?.taskId, "41");
  assert.equal(JSON.stringify(receipt).includes(row.message), false);
  await f.ledger.collectReceipt(row.id, "wrong-task");
  assert.ok(await f.ledger.receipt(row.id));
  await f.ledger.collectReceipt(row.id, "41");
  assert.equal(await f.ledger.receipt(row.id), undefined);
  assert.equal((await f.ledger.get(row.id))?.message, row.message);
});

test("replay hashes keep the same Unicode identity across English and Turkish processes", async () => {
  // 'Iİ' has the locale-independent fold 'ii' followed by COMBINING DOT ABOVE.
  const expected = "257d2d04f84629f77c6248fd9b9c24e9165a79ad4b9dc9d795327c2c8623df41";
  for (const locale of ["en_US.UTF-8", "tr_TR.UTF-8"]) {
    const result = await promisify(execFile)(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `
      import { botMessageReplayHash } from ${JSON.stringify(new URL("./ledger.ts", import.meta.url).href)};
      process.stdout.write(botMessageReplayHash({fromBotId: 'A', target: 'Iİ', message: 'hello', hop: 1}));
    `,
      ],
      { env: { ...process.env, LANG: locale, LC_ALL: locale } },
    );
    assert.equal(result.stdout, expected);
  }
});
