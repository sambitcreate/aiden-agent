import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createBotDeliveryLog, type BotDeliveryRow } from "./bot-delivery/log.js";
import { ALWAYS_NOW_GATE, createBotDeliveryFunnel } from "./bot-delivery/funnel.js";
import { createBotNotificationFeed } from "./bot-routine-notifications.js";
import { createBotRoutineExecutor } from "./scheduled-bot-routines.js";
import type { BotRoutinePorts, BotRoutineSubmissionOutcome, BotSessionState } from "./bot-routines-port.js";
import type { ScheduledRun, ScheduledTask } from "./types.js";

const NOW = Date.parse("2026-08-19T15:01:00.000Z");
const HOUR = 60 * 60 * 1_000;

function delivery(overrides: Partial<Omit<BotDeliveryRow, "id">> = {}): Omit<BotDeliveryRow, "id"> {
  return {
    botId: "bot_fixture_01",
    class: "routine_result",
    dedupeKey: "run_fixture_bot_01",
    title: "Morning brief",
    body: "Your first meeting is at 9:30 with Priya.",
    routineId: "task_fixture_routine_01",
    requestId: "run_fixture_bot_01",
    status: "succeeded",
    createdAt: Date.parse("2026-08-19T15:00:09.000Z"),
    deliverAfter: Date.parse("2026-08-19T15:00:09.000Z"),
    ...overrides,
  };
}

async function harness(options: { names?: Record<string, string> } = {}) {
  const profile = await mkdtemp(path.join(os.tmpdir(), "aiden-bot-feed-"));
  const log = createBotDeliveryLog({ profileDir: () => profile });
  let now = NOW;
  const feed = createBotNotificationFeed({
    log,
    botName: async (botId) => options.names?.[botId] ?? (botId === "bot_fixture_01" ? "Scout" : `Bot ${botId}`),
    now: () => now,
  });
  return {
    profile,
    log,
    feed,
    advanceTo: (at: number) => {
      now = at;
    },
    cleanup: () => rm(profile, { recursive: true, force: true }),
  };
}

test("the feed serves the shared fixture's notification for a routine's visible reply", async (t) => {
  const fixture = JSON.parse(
    await readFile(path.resolve(process.cwd(), "protocol/aiden-remote/v1/fixtures/contract.json"), "utf8"),
  ) as { botRoutineNotifications: unknown };
  const h = await harness();
  t.after(h.cleanup);
  await h.log.append(delivery());

  assert.deepEqual(await h.feed.list(undefined), fixture.botRoutineNotifications);
});

test("lists due rows newest first, at most 100, after since", async (t) => {
  const h = await harness();
  t.after(h.cleanup);
  for (let index = 0; index < 130; index += 1) {
    const at = NOW - 200_000 + index * 1_000;
    await h.log.append(delivery({
      botId: "bot_fixture_01",
      dedupeKey: `run-${index}`,
      requestId: `run-${index}`,
      createdAt: at,
      deliverAfter: at,
    }));
  }
  await h.log.append(delivery({
    dedupeKey: "held",
    requestId: "held",
    createdAt: NOW - 500,
    deliverAfter: NOW + HOUR,
  }));

  const all = await h.feed.list(undefined);
  assert.equal(all.notifications.length, 100);
  assert.equal(all.notifications[0]!.id, "run-129");
  assert.equal(all.notifications[99]!.id, "run-30");
  assert.equal(all.notifications.some(({ id }) => id === "held"), false, "a held row is not due yet");

  const after = await h.feed.list(NOW - 200_000 + 50 * 1_000);
  assert.equal(after.notifications[0]!.id, "run-129");
  assert.equal(after.notifications.length, 79, "since is exclusive");
  assert.equal(after.notifications[after.notifications.length - 1]!.id, "run-51");

  h.advanceTo(NOW + HOUR);
  const due = await h.feed.list(undefined);
  assert.deepEqual(due.notifications[0]?.id, "held", "the held row joins once it is due");
});

test("never lists silent, skipped or blocked runs", async (t) => {
  const h = await harness();
  t.after(h.cleanup);
  const log = h.log;
  const funnel = createBotDeliveryFunnel({
    log,
    gate: ALWAYS_NOW_GATE,
    mac: async () => undefined,
    telegram: async () => undefined,
    now: () => NOW,
  });
  const runs: ScheduledRun[] = [];
  const store = {
    recordRun: async (run: Omit<ScheduledRun, "id"> & { id?: string }) => {
      const recorded: ScheduledRun = { ...run, id: run.id ?? `run-${runs.length}` };
      runs.push(recorded);
      return recorded;
    },
    runById: async (taskId: string, runId: string) =>
      runs.find((run) => run.taskId === taskId && run.id === runId),
    get: async (): Promise<ScheduledTask | undefined> => undefined,
    settleRoutineFire: async () => undefined,
  };
  const task: ScheduledTask = {
    id: "routine-1",
    name: "Inbox sweep",
    enabled: true,
    mode: "llm",
    cron: "0 9 * * *",
    timezone: "UTC",
    permission: "read-only",
    botId: "bot_fixture_01",
    routineSchedule: { kind: "daily", time: "09:00" },
    prompt: "Check the inbox.",
    notify: true,
    createdAt: 1,
    updatedAt: 1,
  };
  const session = (state: BotSessionState, reply: BotRoutineSubmissionOutcome): BotRoutinePorts => ({
    submissionForRequest: async () => undefined,
    async state() {
      return state;
    },
    async send() {
      return { submissionId: "sub-1", deduped: false };
    },
    async awaitReply() {
      return reply;
    },
    async markSilent() {
      return undefined;
    },
  });
  const executor = (ports: BotRoutinePorts) =>
    createBotRoutineExecutor({ store, ports: () => ports, deliver: funnel.deliver, broadcast: () => undefined });

  const silent = await executor(session({ kind: "idle" }, { kind: "completed", text: "[SILENT]" })).run(task, {
    signal: new AbortController().signal,
    trigger: { kind: "manual", key: "silent" },
  });
  const skipped = await executor(
    session({ kind: "paused", since: NOW - HOUR, by: "mac" }, { kind: "completed", text: "Hello." }),
  ).run(task, {
    signal: new AbortController().signal,
    trigger: { kind: "manual", key: "paused" },
  });
  const cancelled = new AbortController();
  cancelled.abort();
  const blocked = await executor(session({ kind: "idle" }, { kind: "completed", text: "Hello." })).run(task, {
    signal: cancelled.signal,
    trigger: { kind: "manual", key: "blocked" },
  });

  assert.deepEqual([silent.result, skipped.result, blocked.result], ["silent", "skipped", "blocked"]);
  assert.deepEqual(await log.due(undefined, NOW), []);
  assert.deepEqual((await h.feed.list(undefined)).notifications, []);
});

test("a failure is announced with the fixed line, never its error text", async (t) => {
  const h = await harness();
  t.after(h.cleanup);
  await h.log.append(delivery({
    body: "Provider at /Users/sam/key.txt said 401 Unauthorized.",
    status: "failed",
  }));

  const [notification] = (await h.feed.list(undefined)).notifications;
  assert.equal(notification?.status, "failed");
  assert.equal(notification.preview, "I couldn't finish this routine.");
});

test("previews are cut to 160 characters and never carry local paths or key-shaped secrets", async (t) => {
  const h = await harness();
  t.after(h.cleanup);
  const body = `Saved the report to /Users/sam/Library/Aiden/report.md using sk-abcdefghijklmnop1234. ${"More detail. ".repeat(30)}`;
  await h.log.append(delivery({ body }));

  const [notification] = (await h.feed.list(undefined)).notifications;
  assert.ok(notification);
  assert.doesNotMatch(notification.preview, /\/Users|sk-abcdef/u);
  assert.match(notification.preview, /^Saved the report to \[path\] using \[redacted\]\./u);
  assert.ok([...notification.preview].length <= 160);
});

test("other delivery classes stay out of the routine feed", async (t) => {
  const h = await harness();
  t.after(h.cleanup);
  await h.log.append(delivery({ class: "issue", dedupeKey: "issue-1", requestId: undefined, title: "Needs a sign-in" }));
  await h.log.append(delivery());

  assert.deepEqual(
    (await h.feed.list(undefined)).notifications.map(({ id }) => id),
    ["run_fixture_bot_01"],
  );
});

test("a suppressed row is kept but never reaches the feed", async (t) => {
  const h = await harness();
  t.after(h.cleanup);
  await h.log.append(delivery({ suppressed: true }));

  assert.equal((await h.log.find("bot_fixture_01", "run_fixture_bot_01"))?.suppressed, true, "the row is kept");
  assert.deepEqual((await h.feed.list(undefined)).notifications, []);
});
