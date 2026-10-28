import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test, { after } from "node:test";
import { createScheduleStore } from "../schedule-store.js";
import { createBotCommitmentProposer } from "./proposer.js";
import { createBotCommitmentStore } from "./store.js";
import { createNoteFollowUpTool } from "./tool.js";

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

class MemoryPersistence<T> {
  constructor(private data: T) {}
  async load(): Promise<T> { return structuredClone(this.data); }
  async update<R>(mutation: (draft: T) => R | Promise<R>): Promise<R> {
    const draft = structuredClone(this.data);
    const result = await mutation(draft);
    this.data = draft;
    return result;
  }
}

function harness(at = Date.UTC(2026, 9, 27, 12)) {
  const root = mkdtempSync(path.join(os.tmpdir(), "aiden-commitments-"));
  roots.push(root);
  const clock = { at };
  const store = createBotCommitmentStore({ profileDir: () => root, now: () => clock.at, timeZone: () => "UTC" });
  const proposed: Array<{ name: string; schedule: unknown; prompt: string; reason?: string }> = [];
  let pending = 0;
  let sequence = 0;
  const proposer = createBotCommitmentProposer({
    commitments: store,
    proposals: {
      propose: async (_botId, input) => {
        if (pending >= 2) return { ok: false, code: "too_many_pending", error: "busy" };
        pending += 1;
        proposed.push(input);
        return { ok: true, proposal: { proposalId: `p${(sequence += 1)}` } };
      },
      pendingCount: async () => pending,
    },
    pendingLimit: 2,
    timeZone: () => "UTC",
    now: () => clock.at,
  });
  return { store, proposer, proposed, clock, settleOne: () => { pending -= 1; } };
}

test("tool rejects a due date in the past or more than 60 days ahead", async () => {
  const h = harness();
  const tool = createNoteFollowUpTool({ botId: "bot-a", store: h.store, onAdded: () => undefined });
  const reply = async (args: Record<string, unknown>) =>
    JSON.parse(((await tool.execute("c", args as never)).content[0] as { text: string }).text) as { ok: boolean };
  assert.equal((await reply({ text: "Check the invoice", due_date: "2026-10-27" })).ok, false, "today is too soon");
  assert.equal((await reply({ text: "Check the invoice", due_date: "2026-12-27" })).ok, false, "61 days is too far");
  const added = await h.store.add("bot-a", { text: "Check the invoice", dueDate: "2026-10-30" });
  assert.equal(added.ok, true);
});

test("proposes the oldest waiting commitment while fewer than two proposals are pending", async () => {
  const h = harness();
  for (const [text, due] of [["First", "2026-10-29"], ["Second", "2026-10-30"], ["Third", "2026-10-31"]] as const) {
    assert.ok((await h.store.add("bot-a", { text, dueDate: due })).ok);
    h.clock.at += 1_000;
  }
  await h.proposer.pump("bot-a");
  assert.deepEqual(h.proposed.map((input) => input.name), ["Follow up: First", "Follow up: Second"]);
  assert.deepEqual(h.proposed[0]!.schedule, { kind: "once", date: "2026-10-29", time: "09:00" });
  assert.equal(h.proposed[0]!.reason, "You asked me to follow up on this.");
  assert.deepEqual((await h.store.list("bot-a")).map((record) => record.status), ["proposed", "proposed", "waiting"]);
});

test("waits while two proposals are pending and proposes when one settles", async () => {
  const h = harness();
  for (const text of ["A", "B", "C"]) assert.ok((await h.store.add("bot-a", { text, dueDate: "2026-11-02" })).ok);
  await h.proposer.pump("bot-a");
  assert.equal(h.proposed.length, 2);
  h.settleOne();
  await h.proposer.onProposalSettled("bot-a", "p1", "accepted");
  assert.deepEqual(h.proposed.map((input) => input.name), ["Follow up: A", "Follow up: B", "Follow up: C"]);
  assert.equal((await h.store.list("bot-a")).find((record) => record.proposalId === "p1")?.status, "accepted");
});

test("an expired commitment is never proposed", async () => {
  const h = harness();
  assert.ok((await h.store.add("bot-a", { text: "Late", dueDate: "2026-10-29" })).ok);
  h.clock.at = Date.UTC(2026, 9, 29, 12);
  await h.proposer.pump("bot-a");
  assert.equal(h.proposed.length, 0);
  assert.equal((await h.store.list("bot-a"))[0]?.status, "expired");
});

test("duplicate text and due date is refused", async () => {
  const h = harness();
  assert.ok((await h.store.add("bot-a", { text: "Call  the plumber", dueDate: "2026-11-01" })).ok);
  const again = await h.store.add("bot-a", { text: "call the plumber", dueDate: "2026-11-01" });
  assert.equal(!again.ok && again.code, "duplicate");
});

test("a 28 December promise due 3 January is accepted by the schedule store", async () => {
  const h = harness(Date.UTC(2026, 11, 28, 12));
  assert.ok((await h.store.add("bot-a", { text: "Year-end check", dueDate: "2027-01-03" })).ok);
  await h.proposer.pump("bot-a");
  const schedule = h.proposed[0]!.schedule as { kind: "once"; date: string; time: string };
  assert.deepEqual(schedule, { kind: "once", date: "2027-01-03", time: "09:00" });
  const tasks = createScheduleStore(new MemoryPersistence<unknown[]>([]), new MemoryPersistence<unknown[]>([]), () => Date.UTC(2026, 11, 28, 12));
  const saved = await tasks.save({
    name: "Follow up", mode: "llm", cron: "0 9 3 1 *", timezone: "UTC", prompt: "x", permission: "read-only",
    botId: "bot-a", routineSchedule: schedule, enabled: true, notify: true,
  } as never);
  assert.equal(new Date(saved.nextRunAt!).toISOString(), "2027-01-03T09:00:00.000Z");
});

test("a follow-up card nobody answered by its day is settled, freeing its slot", async () => {
  const h = harness();
  const dismissed: string[] = [];
  const proposer = createBotCommitmentProposer({
    commitments: h.store,
    proposals: {
      propose: async () => ({ ok: true, proposal: { proposalId: "p-late" } }),
      pendingCount: async () => 0,
      dismiss: async (_botId, proposalId) => void dismissed.push(proposalId),
    },
    pendingLimit: 2,
    timeZone: () => "UTC",
    now: () => h.clock.at,
  });
  assert.ok((await h.store.add("bot-a", { text: "Invoice", dueDate: "2026-10-29" })).ok);
  await proposer.pump("bot-a");
  assert.equal((await h.store.list("bot-a"))[0]?.status, "proposed");
  h.clock.at = Date.UTC(2026, 9, 30, 12);
  await proposer.pump("bot-a");
  assert.deepEqual(dismissed, ["p-late"]);
  assert.equal((await h.store.list("bot-a"))[0]?.status, "expired");
});
