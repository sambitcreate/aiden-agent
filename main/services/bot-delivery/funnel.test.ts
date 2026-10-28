import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ALWAYS_NOW_GATE,
  createBotDeliveryFunnel,
  type BotDeliveryGate,
  type BotDeliveryInput,
} from "./funnel.js";
import { createBotDeliveryLog } from "./log.js";
import type { ScheduledTask } from "../types.js";

const NOW = Date.parse("2026-10-27T09:00:00.000Z");
const HOUR = 60 * 60 * 1_000;

function task(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "routine-1",
    name: "Morning brief",
    enabled: true,
    mode: "llm",
    cron: "0 9 * * *",
    timezone: "UTC",
    permission: "read-only",
    botId: "bot:scout",
    routineSchedule: { kind: "daily", time: "09:00" },
    notify: true,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function routineResult(overrides: Partial<BotDeliveryInput> = {}): BotDeliveryInput {
  return {
    botId: "bot:scout",
    class: "routine_result",
    dedupeKey: "routine:routine-1:1761555600000",
    title: "Morning brief",
    body: "Your first meeting is at 9:30 with Priya.",
    status: "succeeded",
    routineTask: task(),
    requestId: "routine:routine-1:1761555600000",
    ...overrides,
  };
}

async function harness(
  gate: BotDeliveryGate = ALWAYS_NOW_GATE,
  ports: { mac?(input: BotDeliveryInput): Promise<void>; telegram?(input: BotDeliveryInput): Promise<void> } = {},
) {
  const profile = await mkdtemp(path.join(os.tmpdir(), "aiden-bot-delivery-"));
  const log = createBotDeliveryLog({ profileDir: () => profile, now: () => NOW });
  const calls = { mac: [] as BotDeliveryInput[], telegram: [] as BotDeliveryInput[] };
  const funnel = createBotDeliveryFunnel({
    log,
    gate,
    mac: async (input) => {
      calls.mac.push(input);
      await ports.mac?.(input);
    },
    telegram: async (input) => {
      calls.telegram.push(input);
      await ports.telegram?.(input);
    },
    now: () => NOW,
  });
  return { profile, log, funnel, calls, cleanup: () => rm(profile, { recursive: true, force: true }) };
}

test("sends a routine result to mac, telegram and the phone feed once", async (t) => {
  const h = await harness();
  t.after(h.cleanup);
  const input = routineResult();

  assert.equal(await h.funnel.deliver(input), "sent");
  assert.equal(await h.funnel.deliver(input), "duplicate");

  assert.equal(h.calls.mac.length, 1, "one Mac banner");
  assert.equal(h.calls.telegram.length, 1, "one Telegram message");
  assert.equal(h.calls.telegram[0]!.requestId, input.requestId, "Telegram dedupes by the routine fire");
  assert.equal(h.calls.telegram[0]!.title, "Morning brief");

  const rows = await h.log.due(undefined, NOW);
  assert.equal(rows.length, 1);
  assert.deepEqual(
    { ...rows[0], id: undefined },
    {
      id: undefined,
      botId: "bot:scout",
      class: "routine_result",
      dedupeKey: input.dedupeKey,
      title: "Morning brief",
      body: input.body,
      routineId: "routine-1",
      requestId: input.requestId,
      status: "succeeded",
      createdAt: NOW,
      deliverAfter: NOW,
      macSentAt: NOW,
      telegramSentAt: NOW,
      sentAt: NOW,
    },
  );
  assert.ok(rows[0]!.id.length > 0);
});

test("a deferred row is invisible to phones until it is due", async (t) => {
  const h = await harness({ decide: async () => ({ kind: "defer", until: NOW + HOUR }) });
  t.after(h.cleanup);

  assert.equal(await h.funnel.deliver(routineResult()), "deferred");
  assert.equal(await h.funnel.deliver(routineResult()), "deferred", "a held row stays held");
  assert.deepEqual(await h.log.due(undefined, NOW), []);
  assert.deepEqual(
    (await h.log.due(undefined, NOW + HOUR)).map(({ title }) => title),
    ["Morning brief"],
  );
  assert.equal(h.calls.mac.length, 0);
  assert.equal(h.calls.telegram.length, 0);
});

test("suppressed rows are logged but never notified", async (t) => {
  const h = await harness({ decide: async () => ({ kind: "suppress", reason: "daily_limit" }) });
  t.after(h.cleanup);
  const input = routineResult();

  assert.equal(await h.funnel.deliver(input), "suppressed");
  const row = await h.log.find(input.botId, input.dedupeKey);
  assert.equal(row?.suppressed, true, "the row is kept for the record");
  assert.deepEqual(await h.log.due(undefined, NOW), [], "phones never hear it");
  assert.deepEqual(await h.log.due(undefined, NOW + 24 * HOUR), [], "it never becomes due");
  assert.equal(h.calls.mac.length, 0);
  assert.equal(h.calls.telegram.length, 0);
});

test("forgetBot removes the Bot's rows", async (t) => {
  const h = await harness();
  t.after(h.cleanup);
  await h.funnel.deliver(routineResult());
  await h.funnel.deliver(routineResult({ botId: "bot:chef", dedupeKey: "routine:routine-2:1", title: "Dinner" }));

  await h.log.forgetBot("bot:scout");

  assert.deepEqual(
    (await h.log.due(undefined, NOW)).map(({ botId, title }) => ({ botId, title })),
    [{ botId: "bot:chef", title: "Dinner" }],
  );
});

test("one message is deduped per Bot, not across Bots", async (t) => {
  const h = await harness();
  t.after(h.cleanup);

  assert.equal(await h.funnel.deliver(routineResult()), "sent");
  assert.equal(await h.funnel.deliver(routineResult({ botId: "bot:chef" })), "sent");
  assert.equal((await h.log.due(undefined, NOW)).length, 2);
});

test("a Telegram failure retries only Telegram, never the Mac banner again", async (t) => {
  let telegramAttempts = 0;
  const h = await harness(ALWAYS_NOW_GATE, {
    telegram: async () => {
      telegramAttempts += 1;
      if (telegramAttempts === 1) throw new Error("The Telegram outbox is unavailable.");
    },
  });
  t.after(h.cleanup);
  const input = routineResult();

  await assert.rejects(h.funnel.deliver(input), /outbox is unavailable/u);
  assert.equal(h.calls.mac.length, 1);
  assert.equal((await h.log.find(input.botId, input.dedupeKey))?.sentAt, undefined, "not yet sent");

  assert.equal(await h.funnel.deliver(input), "sent");
  assert.equal(h.calls.mac.length, 1, "the Mac banner is shown exactly once");
  assert.equal(h.calls.telegram.length, 2);

  const row = await h.log.find(input.botId, input.dedupeKey);
  assert.equal(row?.macSentAt, NOW, "the Mac send is remembered");
  assert.equal(row?.telegramSentAt, NOW, "the retry stamped Telegram");
  assert.equal(row?.sentAt, NOW, "sentAt is all channels done");
  assert.equal((await h.log.due(undefined, NOW)).length, 1, "the retry reused the row");

  assert.equal(await h.funnel.deliver(input), "duplicate");
  assert.equal(h.calls.mac.length, 1);
  assert.equal(h.calls.telegram.length, 2);
});

test("a gate that counts calls is asked once across a delivery and its retry", async (t) => {
  let gateCalls = 0;
  let holdNewMessages = false;
  const gate: BotDeliveryGate = {
    decide: async () => {
      gateCalls += 1;
      return holdNewMessages ? { kind: "defer", until: NOW + HOUR } : { kind: "now" };
    },
  };
  let telegramAttempts = 0;
  const h = await harness(gate, {
    telegram: async () => {
      telegramAttempts += 1;
      if (telegramAttempts === 1) throw new Error("The Telegram outbox is unavailable.");
    },
  });
  t.after(h.cleanup);
  const input = routineResult();

  await assert.rejects(h.funnel.deliver(input), /outbox is unavailable/u);
  // A cap arriving between the two attempts would hold a new message, but the
  // stored row already passed the gate and must still be finished.
  holdNewMessages = true;

  assert.equal(await h.funnel.deliver(input), "sent");
  assert.equal(gateCalls, 1, "the gate saw the delivery, not its retry");
  assert.equal(h.calls.mac.length, 1);
  assert.equal(h.calls.telegram.length, 2);

  assert.equal(await h.funnel.deliver(input), "duplicate");
  assert.equal(gateCalls, 1, "a duplicate never reaches the gate");
});

test("three held rows produce one digest banner and stay three rows for phones", async (t) => {
  const h = await harness({ decide: async () => ({ kind: "defer", until: NOW + HOUR }) });
  t.after(h.cleanup);
  for (const key of ["a", "b", "c"]) {
    assert.equal(await h.funnel.deliver(routineResult({ dedupeKey: key, requestId: key })), "deferred");
  }
  assert.equal(await h.funnel.flush(NOW), NOW + HOUR, "nothing is due yet; the next held row is");
  assert.equal(h.calls.mac.length, 0);
  assert.equal(await h.funnel.flush(NOW + HOUR), undefined);
  assert.equal(h.calls.mac.length, 1);
  assert.equal(h.calls.mac[0]?.class, "digest");
  assert.equal(h.calls.mac[0]?.body, "While you were away: 3 updates.");
  assert.equal(h.calls.telegram.length, 1);
  assert.equal((await h.log.due(undefined, NOW + HOUR)).filter((row) => row.class === "routine_result").length, 3);
  assert.ok((await h.log.list("bot:scout")).every((row) => row.sentAt !== undefined));
  await h.funnel.flush(NOW + 2 * HOUR);
  assert.equal(h.calls.mac.length, 1, "a flushed row is never sent again");
});

test("an away digest whose Telegram keeps failing shows one Mac banner and keeps one Telegram identity", async (t) => {
  let telegramUp = false;
  const h = await harness({ decide: async () => ({ kind: "defer", until: NOW + HOUR }) }, {
    telegram: async () => {
      if (!telegramUp) throw new Error("The Telegram outbox is unavailable.");
    },
  });
  t.after(h.cleanup);
  for (const key of ["a", "b"]) await h.funnel.deliver(routineResult({ dedupeKey: key, requestId: key }));
  await h.funnel.flush(NOW + HOUR);
  await h.funnel.flush(NOW + HOUR + 5 * 60_000);
  await h.funnel.flush(NOW + HOUR + 10 * 60_000);
  assert.equal(h.calls.mac.length, 1, "the banner went out once");
  telegramUp = true;
  await h.funnel.flush(NOW + HOUR + 15 * 60_000);
  await h.funnel.flush(NOW + HOUR + 20 * 60_000);
  assert.equal(h.calls.mac.length, 1);
  const ids = new Set(h.calls.telegram.map((input) => input.requestId));
  assert.equal(ids.size, 1, "every Telegram attempt carries the same request id");
  assert.equal(h.calls.telegram.length, 4, "three failures, then one success, then nothing");
  assert.equal((await h.log.due(undefined, NOW + 2 * HOUR)).filter((row) => row.class === "routine_result").length, 2);
});

test("a held issue is sent on its own, from the stored row", async (t) => {
  const h = await harness({ decide: async () => ({ kind: "defer", until: NOW + HOUR }) });
  t.after(h.cleanup);
  await h.funnel.deliver({ botId: "bot:scout", class: "issue", dedupeKey: "issue:1", title: "Briefing needs you", body: "Sign in again.", status: "info" });
  await h.funnel.deliver(routineResult());
  await h.funnel.flush(NOW + HOUR);
  assert.deepEqual(h.calls.mac.map((input) => [input.class, input.title]), [
    ["issue", "Briefing needs you"],
    ["routine_result", "Morning brief"],
  ]);
});

test("the first row over the daily limit leaves one note that more is in the chat", async (t) => {
  const h = await harness({ decide: async () => ({ kind: "suppress", reason: "daily_limit", digestKey: "digest:limit:2026-10-27" }) });
  t.after(h.cleanup);
  assert.equal(await h.funnel.deliver(routineResult({ dedupeKey: "a" })), "suppressed");
  assert.equal(await h.funnel.deliver(routineResult({ dedupeKey: "b" })), "suppressed");
  assert.deepEqual(h.calls.mac.map((input) => input.body), ["More updates are in the chat."]);
  assert.deepEqual((await h.log.due(undefined, NOW)).map((row) => row.class), ["digest"]);
});

test("two deliveries of one key at once send once", async (t) => {
  const h = await harness();
  t.after(h.cleanup);
  const [first, second] = await Promise.all([h.funnel.deliver(routineResult()), h.funnel.deliver(routineResult())]);
  assert.deepEqual([first, second].sort(), ["duplicate", "sent"]);
  assert.equal(h.calls.mac.length, 1);
});

test("a delivery after the Bot is forgotten writes nothing and sends nothing", async (t) => {
  const h = await harness();
  t.after(h.cleanup);
  await h.log.forgetBot("bot:scout");
  assert.equal(await h.funnel.deliver(routineResult()), "duplicate");
  assert.equal(h.calls.mac.length, 0);
  assert.deepEqual(await h.log.list("bot:scout"), []);
});
