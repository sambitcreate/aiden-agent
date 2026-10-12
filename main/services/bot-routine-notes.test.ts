import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test, { after } from "node:test";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { EntryRecord } from "@earendil-works/pi-durable";
import {
  BOT_ROUTINE_NOTES_LIMITS,
  createBotRoutineNotesStore,
  ROUTINE_NOTES_TOOL_NAME,
} from "./bot-routine-notes.js";
import { routineNotesCandidate, routineTaskIdOfRun } from "./bot-runtime/bot-tool-candidates.js";
import { botIngressAllowsTool } from "./bot-runtime/bot-tool-policy.js";
import type { BotToolCall } from "./bot-runtime/tool-adapter.js";
import type { BotRoutinePorts } from "./bot-routines-port.js";
import { createScheduleServiceCore } from "./schedule-service-core.js";
import { createScheduleStore } from "./schedule-store.js";
import {
  botRoutinePromptOf,
  createBotRoutineExecutor,
  createBotRoutineService,
} from "./scheduled-bot-routines.js";
import type { ScheduledTask } from "./types.js";

const roots: string[] = [];
function profile(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "aiden-routine-notes-"));
  roots.push(root);
  return root;
}
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function notesStore(root = profile()) {
  let clock = 1_000;
  return createBotRoutineNotesStore({ profileDir: () => root, now: () => (clock += 1) });
}

function text(result: AgentToolResult<unknown>): Record<string, unknown> {
  const part = result.content[0];
  assert.ok(part?.type === "text");
  return JSON.parse(part.text) as Record<string, unknown>;
}

function fakeCall(entries: EntryRecord[] = []): BotToolCall {
  return {
    callId: "call_1",
    signal: new AbortController().signal,
    entries: async () => entries,
    appendEntry: async () => undefined,
    memo: async (_name, candidate) => candidate,
  };
}

test("routine notes are offered only to runs made entirely of routine inputs", () => {
  const cases: Array<[readonly (string | undefined)[], boolean]> = [
    [["routine:task-1:1700000000000"], true],
    [["routine:task-1:1700000000000", "routine:task-2:manual-x"], true],
    [["desktop:abc"], false],
    [["tg:bot:1:0:5"], false],
    [["intro:bot"], false],
    // A person's message joined the routine's run: the notes are withheld.
    [["routine:task-1:1700000000000", "remote:device:key"], false],
    [[undefined], false],
    [[], false],
  ];
  for (const [requestIds, allowed] of cases) {
    assert.equal(botIngressAllowsTool(ROUTINE_NOTES_TOOL_NAME, requestIds), allowed, JSON.stringify(requestIds));
  }
  // Other tools keep their ingress rules.
  assert.equal(botIngressAllowsTool("routines", ["routine:task-1:1"]), false);
  assert.equal(botIngressAllowsTool("routines", ["desktop:abc"]), true);
});

test("notes round-trip through the file and render only for their own routine", async () => {
  const notes = notesStore();
  assert.equal(await notes.render("bot-a", "task-1"), "", "nothing renders before a note exists");
  assert.equal((await notes.set("bot-a", "task-1", "last headline", "Rates held at 5%")).ok, true);
  assert.equal((await notes.set("bot-a", "task-1", "week", "Oct 6\nsecond line")).ok, true);
  assert.equal((await notes.set("bot-a", "task-2", "other", "Not for task 1")).ok, true);

  assert.equal(
    await notes.render("bot-a", "task-1"),
    "Notes you kept from earlier runs of this routine:\n- last headline: Rates held at 5%\n- week: Oct 6 second line",
  );
  assert.equal(await notes.render("bot-b", "task-1"), "", "another Bot's routine has its own notes");

  assert.equal((await notes.delete("bot-a", "task-1", "week")).ok, true);
  assert.deepEqual(Object.keys(await notes.read("bot-a", "task-1")), ["last headline"]);
  await notes.clear("bot-a", "task-1");
  assert.equal(await notes.render("bot-a", "task-1"), "");
  assert.deepEqual(Object.keys(await notes.read("bot-a", "task-2")), ["other"]);
});

test("a write over a cap returns notes_full and changes nothing", async () => {
  const notes = notesStore();
  for (let index = 0; index < BOT_ROUTINE_NOTES_LIMITS.keys; index += 1) {
    assert.equal((await notes.set("bot-a", "task-1", `key ${index}`, "v")).ok, true);
  }
  const before = await notes.read("bot-a", "task-1");
  const seventeenth = await notes.set("bot-a", "task-1", "one too many", "v");
  assert.equal(seventeenth.ok, false);
  assert.equal(seventeenth.ok === false && seventeenth.code, "notes_full");
  assert.deepEqual(await notes.read("bot-a", "task-1"), before);
  // Overwriting an existing key is not a new key.
  assert.equal((await notes.set("bot-a", "task-1", "key 0", "updated")).ok, true);

  const bytes = notesStore();
  for (let index = 0; index < 3; index += 1) {
    assert.equal((await bytes.set("bot-a", "task-1", `k${index}`, "x".repeat(2_000))).ok, true);
  }
  const snapshot = await bytes.read("bot-a", "task-1");
  const full = await bytes.set("bot-a", "task-1", "k3", "x".repeat(2_000));
  assert.equal(full.ok === false && full.code, "notes_full", "8,000 bytes per routine");
  assert.deepEqual(await bytes.read("bot-a", "task-1"), snapshot);

  const invalid = await bytes.set("bot-a", "task-1", "", "x");
  assert.equal(invalid.ok === false && invalid.code, "invalid");
  const tooLong = await bytes.set("bot-a", "task-1", "fine", "y".repeat(BOT_ROUTINE_NOTES_LIMITS.valueChars + 1));
  assert.equal(tooLong.ok === false && tooLong.code, "invalid");
});

test("the tool writes the calling run's routine and nothing outside a routine run", async () => {
  const notes = notesStore();
  const bound = (taskId: string | undefined) =>
    routineNotesCandidate("bot-a", { notes, taskIdOf: async () => taskId }).bind!(fakeCall());

  const saved = text(await bound("task-7").execute("c1", { action: "set", key: "seen", value: "Story 42" }));
  assert.deepEqual(saved, { ok: true, notes: { seen: "Story 42" } });
  assert.equal(await notes.render("bot-a", "task-7"), "Notes you kept from earlier runs of this routine:\n- seen: Story 42");

  const outside = text(await bound(undefined).execute("c2", { action: "set", key: "seen", value: "x" }));
  assert.equal(outside.ok, false);
  assert.equal(outside.code, "unavailable");
  assert.equal((await notes.read("bot-a", "task-7")).seen?.value, "Story 42", "nothing was written");

  const deleted = text(await bound("task-7").execute("c3", { action: "delete", key: "seen" }));
  assert.deepEqual(deleted, { ok: true, notes: {} });
});

test("a call is bound to the routine whose input its run serves, not the newest routine", async () => {
  const notice = (id: number, requestId: string) =>
    ({ id, kind: "aiden.bot-notice", data: { notice: "routine", label: "R", requestId } }) as unknown as EntryRecord;
  const entries = [
    notice(1, "routine:task-a:1700000000000"),
    { id: 2, kind: "pi.user" } as unknown as EntryRecord,
    // A second routine queued behind the first while it runs.
    notice(3, "routine:task-b:1700000000000"),
  ];
  const submissions = new Map([
    ["routine:task-a:1700000000000", "11"],
    ["routine:task-b:1700000000000", "12"],
  ]);
  const lookup = (running: string | undefined) => ({
    runningSubmissionId: async () => running,
    submissionIdOf: async (requestId: string) => submissions.get(requestId),
  });
  assert.equal(await routineTaskIdOfRun(entries, lookup("11")), "task-a");
  assert.equal(await routineTaskIdOfRun(entries, lookup("12")), "task-b");
  assert.equal(await routineTaskIdOfRun(entries, lookup("99")), undefined, "a person's run has no routine");
  assert.equal(await routineTaskIdOfRun(entries, lookup(undefined)), undefined, "an idle Bot has no run");
});

class MemoryPersistence<T> {
  constructor(private data: T) {}
  async load(): Promise<T> {
    return structuredClone(this.data);
  }
  async update<R>(mutation: (draft: T) => R | Promise<R>): Promise<R> {
    const draft = structuredClone(this.data);
    const result = await mutation(draft);
    this.data = draft;
    return result;
  }
}

function routineHarness(notes: ReturnType<typeof notesStore>) {
  const store = createScheduleStore(new MemoryPersistence<unknown[]>([]), new MemoryPersistence<unknown[]>([]));
  const sends: Array<{ text: string; requestId: string }> = [];
  const ports: BotRoutinePorts & { routineNotes(botId: string, taskId: string): Promise<string> } = {
    state: async () => ({ kind: "idle" }),
    send: async (_botId, input) => {
      sends.push(input);
      return { submissionId: `sub-${sends.length}`, deduped: false };
    },
    awaitReply: async () => ({ kind: "completed", text: "Done." }),
    markSilent: async () => undefined,
    routineNotes: (botId, taskId) => notes.render(botId, taskId),
  };
  const executor = createBotRoutineExecutor({
    store,
    ports: () => ports,
    notify: () => undefined,
    broadcast: () => undefined,
  });
  const scheduler = createScheduleServiceCore({
    store,
    execution: {
      run: (task: ScheduledTask, runId?: string, trigger?) =>
        executor.run(task, { runId, trigger, signal: new AbortController().signal }),
      cancel: () => false,
      cancelAll: () => undefined,
    },
    globallyEnabled: async () => true,
    broadcast: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  });
  const routines = createBotRoutineService({
    store,
    service: scheduler,
    botExists: async () => true,
    defaultTimezone: () => "UTC",
    notifyChanged: () => undefined,
    routineDeleted: (botId, routineId) => notes.clear(botId, routineId),
  });
  return { sends, scheduler, routines };
}

test("a routine's notes open its own input message, and deleting the routine clears them", async () => {
  const notes = notesStore();
  const { sends, scheduler, routines } = routineHarness(notes);
  const brief = await routines.create({ botId: "bot-a", name: "Brief", schedule: { kind: "daily", time: "08:00" }, prompt: "Brief me." });
  const plan = await routines.create({ botId: "bot-a", name: "Plan", schedule: { kind: "daily", time: "09:00" }, prompt: "Plan the day." });
  await notes.set("bot-a", brief.id, "last story", "Rates held");

  await scheduler.runNow(brief.id);
  await scheduler.runNow(plan.id);
  assert.match(sends[0]!.text, /^Notes you kept from earlier runs of this routine:\n- last story: Rates held\n\nBrief me\./u);
  assert.equal(botRoutinePromptOf(sends[0]!.text), "Brief me.", "chats show only the person's prompt");
  assert.doesNotMatch(sends[1]!.text, /Notes you kept/u, "another routine never sees these notes");

  await routines.delete({ botId: "bot-a", id: brief.id });
  assert.equal(await notes.render("bot-a", brief.id), "");
});
