import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { BotWatchCheck } from "./bot-routine-events/watch-sources.js";
import { runScheduledScript } from "./schedule-script.js";
import type { ScheduledRunTrigger } from "./schedule-service-core.js";
import { createScheduledTaskTriggers } from "./scheduled-task-triggers.js";
import { UNKNOWN_LINK_CALLS_PER_MINUTE } from "./scheduled-task-link-trigger.js";
import { compareImcpWatch, type ConnectorWatchBaseline, type ConnectorWatchItem } from "./bot-routine-events/connector-watch-imcp.js";
import type { BotConnectorWatchBinding } from "./bot-routine-events/connector-types.js";
import { TaskConnectorChoiceError, connectorTriggerForSave, createTaskConnectorTriggers, type TaskConnectorTriggers } from "./scheduled-task-connector-trigger.js";
import type { ScheduledTaskConnectorTrigger } from "../../renderer/shared/scheduled-task-trigger.js";
import { createScheduledTaskTriggerStore, hashTaskLinkToken } from "./scheduled-task-triggers-store.js";
import type { ScheduledRun, ScheduledTask } from "./types.js";

class MemoryPersistence<T> {
  constructor(private data: T) {}
  async load(): Promise<T> { return structuredClone(this.data); }
  async update<R>(mutation: (draft: T) => R | Promise<R>): Promise<R> {
    const draft = structuredClone(this.data);
    const result = await mutation(draft);
    this.data = draft;
    return result;
  }
  snapshot(): T { return structuredClone(this.data); }
}

const MINUTE = 60_000;

function watchTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "task-1", name: "Status page", enabled: true, mode: "llm", cron: "", timezone: "UTC",
    prompt: "Tell me what changed.", permission: "read-only", notify: true, webSearchEnabled: false,
    trigger: { kind: "watch", source: { type: "url", url: "https://example.com/status" }, everyMinutes: 15 },
    createdAt: 1, updatedAt: 1, ...overrides,
  } as ScheduledTask;
}

function harness(options: { tasks?: ScheduledTask[]; checks?: BotWatchCheck[]; runResult?: ScheduledRun["result"]; runResults?: Array<Pick<ScheduledRun, "result" | "reason">>; stateDir?: string; fireDueTimers?: boolean; connector?: TaskConnectorTriggers } = {}) {
  let clock = 1_800_000_000_000;
  const tasks = options.tasks ?? [watchTask()];
  const checks = [...(options.checks ?? [])];
  const events: Array<{ taskId: string; event: Extract<ScheduledRunTrigger, { kind: "event" }>; runId: string }> = [];
  const cards: Array<{ taskId: string; error: string; afterFailures: boolean }> = [];
  const runs = new Map<string, ScheduledRun>();
  const notices: Array<{ taskId: string; text: string }> = [];
  const released: string[] = [];
  const persistence = new MemoryPersistence<unknown>({ version: 1, tasks: {} });
  const store = createScheduledTaskTriggerStore({
    persistence,
    tasks: async () => structuredClone(tasks),
    pauseTask: async (taskId, reason) => {
      const index = tasks.findIndex((task) => task.id === taskId);
      tasks[index] = { ...tasks[index]!, enabled: false, lastError: reason, updatedAt: tasks[index]!.updatedAt + 1 };
    },
    released: (taskId) => { released.push(taskId); },
    now: () => clock,
  });
  const triggers = createScheduledTaskTriggers({
    store,
    isActive: () => true,
    runEvent: async (taskId, event, runId) => {
      events.push({ taskId, event, runId });
      const outcome = options.runResults?.shift() ?? { result: options.runResult ?? "success" };
      const run: ScheduledRun = { id: runId, taskId, startedAt: clock, finishedAt: clock, ...outcome, output: "" };
      runs.set(runId, run);
      return run;
    },
    findRun: async (_taskId, runId) => runs.get(runId),
    fetchUrl: async () => checks.shift() ?? { ok: false, error: "No more checks." },
    resolveScript: async (_task, script) => {
      const dir = options.stateDir!;
      return { path: path.join(dir, script), cwd: dir };
    },
    execScript: (scriptPath, execOptions) => runScheduledScript(scriptPath, execOptions),
    checkStateDir: async () => path.join(options.stateDir ?? os.tmpdir(), "state"),
    linkSecret: async () => null,
    ...(options.connector ? { connector: options.connector } : {}),
    paused: async (task, error, afterFailures) => { cards.push({ taskId: task.id, error, afterFailures }); },
    dailyLimit: async (task, text) => { notices.push({ taskId: task.id, text }); },
    now: () => clock,
    timeZone: () => "UTC",
    // Timers that are already due fire on the next tick when asked; later ones wait for the test.
    setTimer: (fn, ms) => {
      if (!options.fireDueTimers || ms > 0) return { cancel() {} };
      const handle = setTimeout(fn, 0);
      return { cancel: () => clearTimeout(handle) };
    },
  });
  const bytes = (text: string): BotWatchCheck => ({ ok: true, bytes: new TextEncoder().encode(text) });
  return {
    tasks, store, triggers, events, cards, persistence, bytes, runs, notices, released,
    advance: (ms: number) => { clock += ms; },
    async check(taskId = "task-1") {
      const outcome = await triggers.checkNow(taskId);
      await triggers.idle();
      return outcome;
    },
  };
}

test("a watched page that changes runs the task once with what changed", async () => {
  const pages = ["Status: all good", "Status: all good", "Status: degraded"];
  const checks = pages.map((page): BotWatchCheck => ({ ok: true, bytes: new TextEncoder().encode(page) }));
  const local = harness({ checks });
  await local.triggers.start();

  assert.equal(await local.check(), "baseline");
  assert.equal(local.events.length, 0, "the first look only records a baseline");
  local.advance(15 * MINUTE);
  assert.equal(await local.check(), "no_change");
  assert.equal(local.events.length, 0, "an unchanged page runs no model");
  local.advance(15 * MINUTE);
  assert.equal(await local.check(), "changed");

  assert.equal(local.events.length, 1);
  const [{ event, runId, taskId }] = local.events;
  assert.equal(taskId, "task-1");
  assert.equal(event.kind, "event");
  assert.equal(event.source, "watch");
  assert.match(event.payload, /degraded/u);
  assert.match(event.payload, /all good/u, "the payload carries the change, not only the new page");
  assert.equal(runId, `event:task-1:${event.eventId}`);
  local.triggers.stop();
});

test("three failed checks pause the task with one card, and the bookkeeping survives without re-running", async () => {
  const value = harness({ checks: [
    { ok: false, error: "Aiden couldn't reach example.com." },
    { ok: false, error: "Aiden couldn't reach example.com." },
    { ok: false, error: "Aiden couldn't reach example.com." },
  ] });
  await value.triggers.start();
  assert.equal(await value.check(), "error");
  value.advance(15 * MINUTE);
  assert.equal(await value.check(), "error");
  value.advance(15 * MINUTE);
  assert.equal(await value.check(), "paused");

  assert.equal(value.tasks[0]!.enabled, false, "the task itself is turned off");
  assert.deepEqual(value.cards, [{ taskId: "task-1", error: "Aiden couldn't reach example.com.", afterFailures: true }]);
  assert.equal(value.events.length, 0);
  value.advance(15 * MINUTE);
  assert.equal(await value.check(), "skipped", "a paused task isn't checked");
  assert.equal(value.cards.length, 1);

  // Turning it back on clears the failures and checks again right away.
  value.tasks[0] = { ...value.tasks[0]!, enabled: true, updatedAt: value.tasks[0]!.updatedAt + 1 };
  const [routine] = await value.store.list("task-1");
  assert.equal(routine!.watch?.failures, 0);
  value.triggers.stop();
});

test("recording a run doesn't retire a change, but editing the prompt or source does", async () => {
  const value = harness();
  const [first] = await value.store.list("task-1");
  // A recorded run bumps the task's own revision; the trigger's stays.
  value.tasks[0] = { ...value.tasks[0]!, updatedAt: 99, lastRunAt: 5 };
  const [afterRun] = await value.store.list("task-1");
  assert.equal(afterRun!.updatedAt, first!.updatedAt);

  value.advance(MINUTE);
  value.tasks[0] = { ...value.tasks[0]!, prompt: "Only tell me about outages." };
  const [edited] = await value.store.list("task-1");
  assert.ok(edited!.updatedAt > first!.updatedAt);

  value.advance(MINUTE);
  value.tasks[0] = { ...value.tasks[0]!, trigger: { kind: "watch", source: { type: "url", url: "https://example.com/other" }, everyMinutes: 15 } };
  const [moved] = await value.store.list("task-1");
  assert.ok(moved!.updatedAt > edited!.updatedAt);
  assert.equal(moved!.watch?.hash, undefined, "a new source starts with a new baseline");

  // A task that loses its trigger leaves no bookkeeping behind.
  value.tasks[0] = { ...value.tasks[0]!, trigger: undefined, cron: "0 9 * * *" };
  assert.deepEqual(await value.store.list("task-1"), []);
  assert.deepEqual((value.persistence.snapshot() as { tasks: Record<string, unknown> }).tasks, {});
});

test("a script watch stays quiet on empty output, reports what it prints, and keeps a capped private state file", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-task-trigger-"));
  try {
    // Prints the run count once AIDEN_CHECK_RUNS reaches 2; always appends to its state.
    await fs.writeFile(path.join(dir, "check.sh"), [
      "#!/bin/bash",
      "printf 'run-%s\\n' \"$AIDEN_CHECK_RUNS\" >> \"$AIDEN_CHECK_STATE\"",
      "head -c 9000 /dev/zero | tr '\\0' 'x' >> \"$AIDEN_CHECK_STATE\"",
      "if [ \"$AIDEN_CHECK_RUNS\" -ge 2 ]; then echo \"new build $AIDEN_CHECK_RUNS\"; fi",
    ].join("\n"), { mode: 0o755 });
    const task = watchTask({ permission: "full", trigger: { kind: "watch", source: { type: "script", script: "check.sh" }, everyMinutes: 5 } });
    const value = harness({ tasks: [task], stateDir: dir });
    await value.triggers.start();

    assert.equal(await value.check(), "no_change");
    value.advance(5 * MINUTE);
    assert.equal(await value.check(), "no_change");
    assert.equal(value.events.length, 0, "a quiet script runs no model");
    value.advance(5 * MINUTE);
    assert.equal(await value.check(), "changed");
    assert.equal(value.events.length, 1);
    assert.equal(value.events[0]!.event.payload, "new build 2");

    const stateFile = (await fs.readdir(path.join(dir, "state")))[0]!;
    const state = await fs.readFile(path.join(dir, "state", stateFile), "utf8");
    assert.equal(Buffer.byteLength(state), 8 * 1024, "the state file is capped at 8 KB");
    assert.match(state, /^run-0\n/u, "the state file persists between checks and keeps its start");
    value.triggers.stop();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("trigger runs share one cap of four at once across every task", async () => {
  // Every task watches its own address; each sees "a" first, then "b".
  const tasks = Array.from({ length: 6 }, (_, index) => watchTask({
    id: `task-${index}`,
    trigger: { kind: "watch", source: { type: "url", url: `https://example.com/${index}` }, everyMinutes: 15 },
  }));
  let running = 0;
  let peak = 0;
  const releases: Array<() => void> = [];
  const persistence = new MemoryPersistence<unknown>({ version: 1, tasks: {} });
  let clock = 1_800_000_000_000;
  const store = createScheduledTaskTriggerStore({ persistence, tasks: async () => structuredClone(tasks), pauseTask: async () => {}, now: () => clock });
  const emitted = createScheduledTaskTriggers({
    store,
    isActive: () => true,
    runEvent: async (taskId, _event, runId) => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise<void>((resolve) => releases.push(resolve));
      running -= 1;
      return { id: runId, taskId, startedAt: 0, finishedAt: 0, result: "success", output: "" };
    },
    findRun: async () => undefined,
    fetchUrl: (() => {
      const seen = new Map<string, number>();
      return async (url: string) => {
        const count = seen.get(url) ?? 0;
        seen.set(url, count + 1);
        return { ok: true as const, bytes: new TextEncoder().encode(count === 0 ? "a" : "b") };
      };
    })(),
    resolveScript: async () => { throw new Error("unused"); },
    execScript: async () => { throw new Error("unused"); },
    checkStateDir: async () => os.tmpdir(),
    linkSecret: async () => null,
    paused: async () => {},
    now: () => clock,
    timeZone: () => "UTC",
    setTimer: () => ({ cancel() {} }),
  });
  await emitted.start();
  for (const task of tasks) assert.equal(await emitted.checkNow(task.id), "baseline");
  clock += 15 * MINUTE;
  const changes = tasks.map((task) => emitted.checkNow(task.id));
  for (let tick = 0; tick < 50 && releases.length < 4; tick += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(running, 4, "four runs start");
  assert.equal(peak, 4);
  while (releases.length) {
    releases.shift()!();
    for (let tick = 0; tick < 20; tick += 1) await new Promise((resolve) => setImmediate(resolve));
  }
  await Promise.all(changes);
  await emitted.idle();
  assert.equal(peak, 4, "never more than four at once");
  emitted.stop();
});

function linkHarness(trigger: Record<string, unknown> = { kind: "webhook", gapMinutes: 10 }, runResults?: Array<Pick<ScheduledRun, "result" | "reason">>) {
  const value = harness({ tasks: [watchTask({ trigger: trigger as ScheduledTask["trigger"] })], fireDueTimers: true, ...(runResults ? { runResults } : {}) });
  const token = "L".repeat(43);
  return {
    ...value,
    token,
    async setUp() {
      await value.store.setTokenHash("task-1", hashTaskLinkToken(token));
      await value.triggers.start();
    },
    async call(body: unknown, contentType = "application/json") {
      const admitted = await value.triggers.webhook.admit({ token, contentType });
      if ("status" in admitted) return admitted.status;
      const text = typeof body === "string" ? body : JSON.stringify(body);
      const answer = await value.triggers.webhook.deliver({ token, contentType, body: new TextEncoder().encode(text) });
      await value.triggers.idle();
      return answer.status;
    },
  };
}

test("link calls inside the gap run once together, 20 at most, saying how many were dropped", async () => {
  const link = linkHarness();
  await link.setUp();
  assert.equal(await link.call({ n: 0 }), 202);
  assert.equal(link.events.length, 1, "the first call runs at once");
  for (let n = 1; n <= 21; n += 1) assert.equal(await link.call({ n }), 202);
  assert.equal(link.events.length, 1, "calls inside the 10-minute gap wait");
  const [routine] = await link.store.list("task-1");
  assert.ok(routine!.held, "they are held as one batch");
  link.advance(10 * MINUTE);
  await link.triggers.rearm();
  // The held batch runs once the gap ends (the rearm arms its timer, now due).
  for (let tick = 0; tick < 20 && link.events.length < 2; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await link.triggers.idle();
  }
  const batch = link.events[1]?.event;
  assert.equal(batch?.source, "webhook");
  assert.match(batch?.payload ?? "", /^20 calls arrived while the task waited\. 1 more call was dropped\./u);
  assert.match(batch?.payload ?? "", /Call 1:\n\{\n {2}"n": 2\n\}/u, "the oldest call was dropped");
  assert.match(batch?.payload ?? "", /Call 20:\n\{\n {2}"n": 21\n\}/u);
  link.triggers.stop();
});

test("a link withholds credentials, passes only the chosen fields, drops repeats and keeps 50 log entries", async () => {
  const link = linkHarness({ kind: "webhook", gapMinutes: 1, includeFields: ["pull_request.title", "auth"], dedupePath: "delivery" });
  await link.setUp();
  assert.equal(await link.call({ delivery: "d-1", pull_request: { title: "Fix login", body: "secret plan" }, auth: { token: "abc", password: "hunter2" } }), 202);
  const payload = JSON.parse(link.events[0]!.event.payload) as Record<string, unknown>;
  assert.deepEqual(payload, { "pull_request.title": "Fix login", auth: { token: "[withheld]", password: "[withheld]" } });
  link.advance(2 * MINUTE);
  assert.equal(await link.call({ delivery: "d-1", pull_request: { title: "Again" } }), 202);
  assert.equal(link.events.length, 1, "the same delivery id is one event");

  const plain = linkHarness({ kind: "webhook", gapMinutes: 1 });
  await plain.setUp();
  await plain.call("deploy failed, key sk-live-abcdefghijklmnop0123", "text/plain");
  assert.doesNotMatch(plain.events[0]!.event.payload, /sk-live-abcdefghijklmnop0123/u);
  for (let n = 0; n < 60; n += 1) {
    plain.advance(MINUTE + 1);
    await plain.call({ n });
  }
  const state = await plain.store.linkState("task-1");
  assert.equal(state?.log.length, 50);
  assert.match(state!.log[0]!.preview, /"n": 59/u, "newest first");
  plain.triggers.stop();
  link.triggers.stop();
});

test("a task's link stops at once when it is rotated, and a stopped or paused task's link is unknown", async () => {
  const link = linkHarness();
  await link.setUp();
  assert.equal(await link.call({ a: 1 }), 202);
  await link.store.setTokenHash("task-1", hashTaskLinkToken("N".repeat(43)));
  assert.equal(await link.call({ a: 2 }), 404);
  link.tasks[0] = { ...link.tasks[0]!, enabled: false };
  await link.store.setTokenHash("task-1", hashTaskLinkToken(link.token));
  assert.equal(await link.call({ a: 3 }), 404);
  link.triggers.stop();
});

/** Moves past the gap and lets the held run go. */
async function runHeld(value: { advance(ms: number): void; triggers: ReturnType<typeof createScheduledTaskTriggers>; events: unknown[] }, gapMs: number, expected: number) {
  value.advance(gapMs);
  await value.triggers.rearm();
  for (let tick = 0; tick < 20 && value.events.length < expected; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await value.triggers.idle();
  }
}

test("a link call whose run was skipped for a busy chat runs with the calls that came after it", async () => {
  const link = linkHarness({ kind: "webhook", gapMinutes: 10 }, [{ result: "skipped", reason: "chat_busy" }]);
  await link.setUp();
  assert.equal(await link.call({ n: 0 }), 202);
  assert.equal(link.events.length, 1, "the run went ahead and its chat was busy");
  assert.equal(await link.call({ n: 1 }), 202);
  assert.equal(await link.call({ n: 2 }), 202);

  await runHeld(link, 10 * MINUTE, 2);
  const next = link.events[1]?.event;
  assert.match(next?.payload ?? "", /^3 calls arrived while the task waited\.\n/u);
  assert.match(next?.payload ?? "", /Call 1:\n\{\n {2}"n": 0\n\}/u, "the skipped call comes first");
  assert.match(next?.payload ?? "", /Call 3:\n\{\n {2}"n": 2\n\}/u);
  assert.notEqual(link.events[1]?.runId, link.events[0]?.runId, "it is a new run, not the recorded skip");
  link.triggers.stop();
});

test("a skipped link batch stays bounded to 20 calls and says how many were dropped", async () => {
  const link = linkHarness({ kind: "webhook", gapMinutes: 10 }, [{ result: "success" }, { result: "skipped", reason: "chat_budget" }]);
  await link.setUp();
  assert.equal(await link.call({ n: 0 }), 202);
  for (let n = 1; n <= 15; n += 1) assert.equal(await link.call({ n }), 202);
  await runHeld(link, 10 * MINUTE, 2);
  assert.match(link.events[1]?.event.payload ?? "", /^15 calls arrived/u, "this batch was skipped: the chat used its hourly share");
  for (let n = 16; n <= 25; n += 1) assert.equal(await link.call({ n }), 202);

  // A chat out of task runs for the hour has room again within the hour, not after the link's gap.
  await runHeld(link, 10 * MINUTE, 3);
  assert.equal(link.events.length, 2, "nothing retries while the chat's hour is used up");
  await runHeld(link, 50 * MINUTE, 3);
  const payload = link.events[2]?.event.payload ?? "";
  assert.match(payload, /^20 calls arrived while the task waited\. 5 more calls were dropped\./u);
  assert.match(payload, /Call 1:\n\{\n {2}"n": 6\n\}/u, "the oldest calls are the ones dropped");
  assert.match(payload, /Call 20:\n\{\n {2}"n": 25\n\}/u);
  link.triggers.stop();
});

test("a watched change whose run was skipped for a busy chat is delivered in the next allowed run", async () => {
  const pages = ["Status: all good", "Status: degraded", "Status: down"];
  const value = harness({ checks: pages.map((page) => ({ ok: true, bytes: new TextEncoder().encode(page) })), runResults: [{ result: "skipped", reason: "chat_busy" }], fireDueTimers: true });
  await value.triggers.start();
  assert.equal(await value.check(), "baseline");
  value.advance(15 * MINUTE);
  assert.equal(await value.check(), "changed");
  assert.equal(value.events.length, 1);
  assert.match(value.events[0]!.event.payload, /degraded/u);

  await runHeld(value, 5 * MINUTE, 2);
  assert.equal(value.events.length, 2, "the change runs again once the gap allows");
  assert.match(value.events[1]!.event.payload, /degraded/u);

  // A newer change waiting alongside a skipped one keeps both, newest first.
  const second = harness({ checks: pages.map((page) => ({ ok: true, bytes: new TextEncoder().encode(page) })), runResults: [{ result: "skipped", reason: "chat_budget" }], fireDueTimers: true });
  await second.triggers.start();
  assert.equal(await second.check(), "baseline");
  second.advance(15 * MINUTE);
  assert.equal(await second.check(), "changed");
  second.advance(MINUTE);
  assert.equal(await second.check(), "changed");
  await runHeld(second, 60 * MINUTE, 2);
  const combined = second.events[1]?.event.payload ?? "";
  assert.match(combined, /down[\s\S]*An earlier change that wasn't delivered yet:[\s\S]*degraded/u);
  value.triggers.stop();
  second.triggers.stop();
});

const MAIL_BINDING: BotConnectorWatchBinding = {
  adapter: "imcp-mail-v1", serverId: "imcp", mailbox: "V10:12", account: "private-account-id",
  connection: { sourceId: "imcp", connectionFingerprint: "a".repeat(64), toolsetFingerprint: "b".repeat(64), exactFingerprint: "c".repeat(64), tools: [] },
  tools: [
    { name: "mail_mailboxes_list", toolId: "one", effect: "read", inputSchemaFingerprint: "schema-one", outputSchemaFingerprint: "no-schema", effectFingerprint: "read", exactFingerprint: "exact-one" },
    { name: "mail_messages_search", toolId: "two", effect: "read", inputSchemaFingerprint: "schema-two", outputSchemaFingerprint: "no-schema", effectFingerprint: "read", exactFingerprint: "exact-two" },
  ],
  labels: { providerLabel: "iMCP Mail", accountLabel: "person@example.test", resourceLabel: "Inbox" },
};

function mailTask(): ScheduledTask {
  const trigger: ScheduledTaskConnectorTrigger = {
    kind: "connector", everyMinutes: 15, condition: { kind: "email", unreadOnly: false },
    source: { providerLabel: "Mail", accountLabel: "Account", resourceLabel: "Mailbox" },
  };
  return watchTask({ name: "New mail", trigger });
}

/** A connected app behind fake ports: what Find sources lists, what a read returns, and the connector's configuration. */
function connectedMail() {
  const app = {
    server: { id: "imcp", name: "iMCP", transport: "stdio", command: "/Applications/iMCP.app/Contents/MacOS/imcp-server", presetId: "imcp", enabled: true } as import("./types.js").McpServer | undefined,
    messages: [{ id: "m1", title: "Project kickoff", signature: "kickoff" }] as ConnectorWatchItem[],
    discovered: 0,
    reads: 0,
    now: 1_800_000_000_000,
  };
  const connector = createTaskConnectorTriggers({
    discover: async () => { app.discovered += 1; return { bindings: [structuredClone(MAIL_BINDING)], unavailableReasons: [] }; },
    read: async (_taskId, _binding, _condition, baseline) => {
      app.reads += 1;
      const items = structuredClone(app.messages);
      return { items, ...compareImcpWatch("email", baseline as ConnectorWatchBaseline | undefined, items, app.now) };
    },
    server: async () => (app.server ? structuredClone(app.server) : undefined),
    now: () => app.now,
  });
  return { app, connector };
}

async function bindMail(value: ReturnType<typeof harness>, connector: TaskConnectorTriggers) {
  const found = await connector.findSources(new AbortController().signal);
  assert.equal(found.choices.length, 1);
  assert.deepEqual(
    { provider: found.choices[0]!.providerLabel, account: found.choices[0]!.accountLabel, mailbox: found.choices[0]!.resourceLabel },
    { provider: "iMCP Mail", account: "person@example.test", mailbox: "Inbox" },
  );
  assert.ok(!JSON.stringify(found).includes("private-account-id"), "choices never carry the account or tool identities");
  const trigger = value.tasks[0]!.trigger as ScheduledTaskConnectorTrigger;
  const { trigger: saved, source } = connector.takeChoice({ ...trigger, sourceChoiceId: found.choices[0]!.id });
  assert.equal(saved.sourceChoiceId, undefined);
  assert.equal(saved.source.resourceLabel, "Inbox", "the saved labels are the source's own");
  value.tasks[0] = { ...value.tasks[0]!, trigger: saved };
  assert.equal(await value.triggers.bindConnectorSource("task-1", source), true);
}

test("a connected-app task waits for its source, records a baseline first, then runs once for new mail without ever connecting", async () => {
  const { app, connector } = connectedMail();
  const value = harness({ tasks: [mailTask()], connector });
  await value.triggers.start();
  assert.equal(await value.check(), "skipped", "nothing is checked before a source is bound");
  assert.equal(app.reads, 0);

  await bindMail(value, connector);
  assert.equal(await value.check(), "baseline");
  assert.equal(value.events.length, 0, "the first check only records what's there");

  value.advance(15 * MINUTE);
  app.now += 15 * MINUTE;
  assert.equal(await value.check(), "no_change");
  app.messages.push({ id: "m2", title: "Invoice overdue", signature: "invoice" });
  value.advance(15 * MINUTE);
  app.now += 15 * MINUTE;
  assert.equal(await value.check(), "changed");
  assert.equal(value.events.length, 1);
  assert.equal(value.events[0]!.event.source, "watch", "connected-app runs count as watch runs");
  assert.match(value.events[0]!.event.payload, /Invoice overdue/u);
  assert.doesNotMatch(value.events[0]!.event.payload, /Project kickoff/u);

  assert.equal(app.reads, 3);
  assert.equal(app.discovered, 1, "only the foreground Find sources lists sources; background checks just read");
  value.triggers.stop();
});

test("a connected app whose setup changed is refused without a read; one removed or turned off pauses the task", async () => {
  const { app, connector } = connectedMail();
  const value = harness({ tasks: [mailTask()], connector });
  await value.triggers.start();
  await bindMail(value, connector);
  assert.equal(await value.check(), "baseline");

  app.server = { ...app.server!, command: "/tmp/other-imcp" };
  value.advance(15 * MINUTE);
  assert.equal(await value.check(), "error");
  assert.equal(app.reads, 1, "a drifted connector is never read");
  assert.equal(value.tasks[0]!.enabled, true);
  const [routine] = await value.store.list("task-1");
  assert.match(routine!.watch?.lastError ?? "", /setup changed/u);

  app.server = { ...app.server!, enabled: false };
  value.advance(15 * MINUTE);
  assert.equal(await value.check(), "paused");
  assert.equal(value.tasks[0]!.enabled, false, "a revoked connector pauses the task at once");
  assert.equal(value.cards.length, 1);
  assert.match(value.cards[0]!.error, /removed or turned off/u);
  assert.equal(value.cards[0]!.afterFailures, false, "one revoked check pauses the task, not three failures");
  assert.equal(app.reads, 1);
  value.triggers.stop();
});

test("a Find sources choice expires, and one of the wrong kind is refused", async () => {
  const { app, connector } = connectedMail();
  const found = await connector.findSources(new AbortController().signal);
  const calendar: ScheduledTaskConnectorTrigger = {
    kind: "connector", everyMinutes: 30, condition: { kind: "calendar", lookAheadMinutes: 60, timezone: "UTC" },
    source: { providerLabel: "Calendar", accountLabel: "Account", resourceLabel: "Work" }, sourceChoiceId: found.choices[0]!.id,
  };
  assert.throws(() => connector.takeChoice(calendar), /Choose a calendar/u);
  app.now += 16 * MINUTE;
  assert.throws(() => connector.takeChoice({ ...(mailTask().trigger as ScheduledTaskConnectorTrigger), sourceChoiceId: found.choices[0]!.id }), /expired/u);
});

test("saving a connected-app task needs a fresh choice, unless an edit keeps watching the same kind", async () => {
  const { connector } = connectedMail();
  const draft = mailTask().trigger as ScheduledTaskConnectorTrigger;
  assert.throws(() => connectorTriggerForSave(draft, undefined, connector.takeChoice), TaskConnectorChoiceError, "a new task needs Find sources");

  const saved: ScheduledTaskConnectorTrigger = { ...draft, source: { providerLabel: "iMCP Mail", accountLabel: "person@example.test", resourceLabel: "Inbox" } };
  const edit = connectorTriggerForSave({ ...draft, condition: { kind: "email", unreadOnly: true }, source: { providerLabel: "Typed", accountLabel: "By", resourceLabel: "Renderer" } }, saved, connector.takeChoice);
  assert.equal(edit.source, undefined, "the bound source stays as it is");
  assert.deepEqual(edit.trigger.source, saved.source, "names always come from the saved source, not the renderer");
  assert.equal(edit.trigger.condition.kind, "email");

  const calendar: ScheduledTaskConnectorTrigger = { ...draft, condition: { kind: "calendar", lookAheadMinutes: 60, timezone: "UTC" } };
  assert.throws(() => connectorTriggerForSave(calendar, saved, connector.takeChoice), TaskConnectorChoiceError, "switching mail to calendar needs a new source");

  const found = await connector.findSources(new AbortController().signal);
  const fresh = connectorTriggerForSave({ ...draft, sourceChoiceId: found.choices[0]!.id }, saved, connector.takeChoice);
  assert.equal(fresh.source?.binding.adapter, "imcp-mail-v1");
});

test("an unknown link token is refused without reading the tasks or writing the file, and a flood of them is shed", async () => {
  const link = linkHarness();
  await link.setUp();
  let writes = 0;
  const update = link.persistence.update.bind(link.persistence);
  link.persistence.update = (mutation) => { writes += 1; return update(mutation); };
  for (let n = 0; n < UNKNOWN_LINK_CALLS_PER_MINUTE; n += 1) {
    const admitted = await link.triggers.webhook.admit({ token: `unknown${String(n).padStart(20, "0")}`, contentType: "application/json" });
    assert.deepEqual(admitted, { status: 404 });
  }
  assert.equal(writes, 0, "made-up tokens never touch the bookkeeping file");
  assert.deepEqual(await link.triggers.webhook.admit({ token: "unknown-over-the-limit-0000", contentType: "application/json" }), { status: 429 });
  assert.equal(await link.call({ a: 1 }), 429, "during a flood every call is shed before a lookup");
  await link.store.linkState("task-1");
  assert.equal(writes, 0, "an open link panel only reads");
  link.advance(MINUTE + 1);
  assert.equal(await link.call({ a: 1 }), 202, "the real link works once the flood passes");
  link.triggers.stop();
});

test("bad calls don't use a link's 60 a minute and share one log entry", async () => {
  const link = linkHarness();
  await link.setUp();
  for (let n = 0; n < 25; n += 1) assert.equal(await link.call("{not json"), 400);
  assert.equal(await link.call({ a: 1 }), 202, "real calls still get through");
  const state = await link.store.linkState("task-1");
  assert.deepEqual(state?.log.map((entry) => [entry.outcome, entry.repeats ?? 0]), [["ran", 0], ["invalid", 24]]);
  link.triggers.stop();
});

test("a long link batch reaches the run with its heading and every call, inside one bound", async () => {
  const link = linkHarness();
  await link.setUp();
  assert.equal(await link.call({ n: 0 }), 202);
  for (let n = 1; n <= 25; n += 1) assert.equal(await link.call({ n, filler: "x".repeat(1_500) }), 202);
  await runHeld(link, 10 * MINUTE, 2);
  const payload = link.events[1]?.event.payload ?? "";
  assert.ok(payload.length <= 24_000, `the run's text is within the bound (${payload.length})`);
  assert.match(payload, /^20 calls arrived while the task waited\. 5 more calls were dropped\./u);
  for (const n of [1, 20]) assert.match(payload, new RegExp(`Call ${n}:\\n`, "u"));
  assert.match(payload, /"n": 6,/u, "the oldest kept call is there");
  assert.match(payload, /"n": 25,/u, "and so is the newest");
  link.triggers.stop();
});

test("a skipped run doesn't count toward the day's runs, and held calls dropped at 48 leave a card and a log line", async () => {
  const link = linkHarness({ kind: "webhook", gapMinutes: 10 }, [{ result: "skipped", reason: "chat_busy" }]);
  await link.setUp();
  assert.equal(await link.call({ n: 0 }), 202);
  let [routine] = await link.store.list("task-1");
  assert.equal(routine!.day?.count, 0, "the busy chat's skip gave its run back");
  assert.ok(routine!.held, "and the call waits for the next run");

  // Today's runs are used up while the call waits: it is dropped, visibly.
  await link.store.mutate("task-1", "task-1", (current) => ({ next: { ...current, day: { key: current.day!.key, count: 48 } }, result: undefined }));
  await runHeld(link, 10 * MINUTE, 2);
  for (let tick = 0; tick < 5; tick += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  [routine] = await link.store.list("task-1");
  assert.equal(routine!.held, undefined);
  assert.equal(link.events.length, 1);
  assert.equal(link.notices.length, 1);
  assert.match(link.notices[0]!.text, /already ran 48 times today/u);
  assert.equal((await link.store.linkState("task-1"))?.log[0]?.outcome, "daily_limit");
  link.triggers.stop();
});

test("a skipped run recorded just before Aiden stopped runs again at the next start", async () => {
  const value = harness();
  await value.store.mutate("task-1", "task-1", (current) => ({
    next: { ...current, running: [{ eventId: "change-1", payload: "Status: degraded", at: 1 }] },
    result: undefined,
  }));
  value.runs.set("event:task-1:change-1", { id: "event:task-1:change-1", taskId: "task-1", startedAt: 1, finishedAt: 1, result: "skipped", reason: "chat_busy", output: "" });
  await value.triggers.start();
  await value.triggers.idle();
  assert.equal(value.events.length, 1, "the undelivered change runs instead of counting as settled");
  assert.match(value.events[0]!.event.payload, /degraded/u);
  value.triggers.stop();
});

test("changing a link task to a schedule or removing it releases its secret, and a new signature header asks for a new link", async () => {
  const link = linkHarness();
  await link.setUp();
  link.tasks[0] = { ...link.tasks[0]!, trigger: { kind: "webhook", gapMinutes: 10, signatureHeader: "x-signature-256" }, updatedAt: 2 };
  assert.equal((await link.store.linkState("task-1"))?.needsNewLink, false, "nothing changes until the bookkeeping catches up");
  await link.triggers.rearm();
  assert.equal((await link.store.linkState("task-1"))?.needsNewLink, true);
  await link.store.setTokenHash("task-1", hashTaskLinkToken("R".repeat(43)));
  assert.equal((await link.store.linkState("task-1"))?.needsNewLink, false, "rotating clears it");
  assert.deepEqual(link.released, []);
  link.tasks[0] = { ...link.tasks[0]!, trigger: { kind: "watch", source: { type: "url", url: "https://example.com/" }, everyMinutes: 15 }, updatedAt: 3 };
  await link.triggers.rearm();
  assert.deepEqual(link.released, ["task-1"]);
  link.tasks.splice(0, 1);
  await link.triggers.rearm();
  assert.deepEqual(link.released, ["task-1"], "a URL watch leaves nothing behind");
  link.triggers.stop();
});
