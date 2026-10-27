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

async function harness(gate: BotDeliveryGate = ALWAYS_NOW_GATE) {
  const profile = await mkdtemp(path.join(os.tmpdir(), "aiden-bot-delivery-"));
  const log = createBotDeliveryLog({ profileDir: () => profile });
  const calls = { mac: [] as BotDeliveryInput[], telegram: [] as BotDeliveryInput[] };
  const funnel = createBotDeliveryFunnel({
    log,
    gate,
    mac: async (input) => void calls.mac.push(input),
    telegram: async (input) => void calls.telegram.push(input),
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
      sentAt: NOW,
    },
  );
  assert.ok(rows[0]!.id.length > 0);
});

test("a deferred row is invisible to phones until it is due", async (t) => {
  const h = await harness({ decide: async () => ({ kind: "defer", until: NOW + HOUR }) });
  t.after(h.cleanup);

  assert.equal(await h.funnel.deliver(routineResult()), "deferred");
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

  assert.equal(await h.funnel.deliver(routineResult()), "suppressed");
  assert.equal((await h.log.due(undefined, NOW)).length, 1, "the row is kept");
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

test("a send that failed is retried under the same row, not treated as a duplicate", async (t) => {
  const profile = await mkdtemp(path.join(os.tmpdir(), "aiden-bot-delivery-"));
  t.after(() => rm(profile, { recursive: true, force: true }));
  const log = createBotDeliveryLog({ profileDir: () => profile });
  let telegramCalls = 0;
  const funnel = createBotDeliveryFunnel({
    log,
    gate: ALWAYS_NOW_GATE,
    mac: async () => undefined,
    telegram: async () => {
      telegramCalls += 1;
      if (telegramCalls === 1) throw new Error("The Telegram outbox is unavailable.");
    },
    now: () => NOW,
  });

  await assert.rejects(funnel.deliver(routineResult()), /outbox is unavailable/u);
  assert.equal(await funnel.deliver(routineResult()), "sent");
  assert.equal(telegramCalls, 2);
  assert.equal((await log.due(undefined, NOW)).length, 1, "the retry reused the row");
});
