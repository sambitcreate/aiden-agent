import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test, { after } from "node:test";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import {
  BOT_ROUTINE_PROPOSAL_ENTRY_KIND,
  BOT_ROUTINE_PROPOSAL_STATUS_ENTRY_KIND,
} from "../../renderer/shared/bot-routine-proposals.js";
import {
  BotRoutineProposalNotFoundError,
  createBotRoutineProposalService,
  parseBotRoutineProposalRespond,
} from "./bot-routine-proposals.js";
import { routinesCandidate } from "./bot-runtime/bot-tool-candidates.js";
import type { BotToolCall } from "./bot-runtime/tool-adapter.js";
import { createScheduleServiceCore } from "./schedule-service-core.js";
import { createScheduleStore } from "./schedule-store.js";
import { createBotRoutineService } from "./scheduled-bot-routines.js";

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
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

function harness() {
  const root = mkdtempSync(path.join(os.tmpdir(), "aiden-routine-proposals-"));
  roots.push(root);
  const store = createScheduleStore(new MemoryPersistence<unknown[]>([]), new MemoryPersistence<unknown[]>([]));
  const scheduler = createScheduleServiceCore({
    store,
    execution: {
      run: async () => {
        throw new Error("nothing runs in these tests");
      },
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
    botExists: async (botId) => botId === "bot-a",
    defaultTimezone: () => "UTC",
    notifyChanged: () => undefined,
  });
  const appended: Array<{ botId: string; kind: string; data: Record<string, unknown> }> = [];
  let sequence = 0;
  const proposals = createBotRoutineProposalService({
    profileDir: () => root,
    routines,
    defaultTimezone: () => "UTC",
    appendEntry: async (botId, kind, data) => void appended.push({ botId, kind, data }),
    now: () => Date.UTC(2026, 9, 9, 12),
    newId: () => `00000000-0000-4000-8000-${String((sequence += 1)).padStart(12, "0")}`,
  });
  return { routines, proposals, appended };
}

const dailyPlan = { name: "Weekly meal plan", schedule: { kind: "weekly", days: [0], time: "09:00" }, prompt: "Plan this week's meals." };

function json(result: AgentToolResult<unknown>): Record<string, unknown> {
  const part = result.content[0];
  assert.ok(part?.type === "text");
  return JSON.parse(part.text) as Record<string, unknown>;
}

function call(appended: Array<{ kind: string; data: unknown }>): BotToolCall {
  return {
    callId: "call_1",
    signal: new AbortController().signal,
    entries: async () => [],
    appendEntry: async (kind, data) => void appended.push({ kind, data }),
    memo: async (_name, candidate) => candidate,
  };
}

test("a proposal is validated like a routine, shows one card, and at most two wait at once", async () => {
  const { proposals, appended } = harness();
  const invalid = await proposals.propose("bot-a", { ...dailyPlan, schedule: { kind: "hourly" } });
  assert.equal(invalid.ok === false && invalid.code, "invalid");
  const longReason = await proposals.propose("bot-a", { ...dailyPlan, reason: "x".repeat(281) });
  assert.equal(longReason.ok === false && longReason.code, "invalid");
  assert.equal(appended.length, 0, "a rejected proposal shows nothing");

  const first = await proposals.propose("bot-a", { ...dailyPlan, reason: "You plan every Sunday." });
  assert.ok(first.ok);
  assert.deepEqual(appended, [{
    botId: "bot-a",
    kind: BOT_ROUTINE_PROPOSAL_ENTRY_KIND,
    data: {
      proposalId: first.proposal.proposalId,
      name: "Weekly meal plan",
      prompt: "Plan this week's meals.",
      schedule: { kind: "weekly", days: [0], time: "09:00" },
      timezone: "UTC",
      label: "Every Sunday at 9:00 AM",
      reason: "You plan every Sunday.",
    },
  }]);
  assert.ok((await proposals.propose("bot-a", { ...dailyPlan, name: "Second" })).ok);
  const third = await proposals.propose("bot-a", { ...dailyPlan, name: "Third" });
  assert.equal(third.ok === false && third.code, "too_many_pending");
  assert.equal(appended.length, 2);

  // Answering one frees a slot.
  await proposals.respond({ botId: "bot-a", proposalId: first.proposal.proposalId, decision: "dismiss" });
  assert.ok((await proposals.propose("bot-a", { ...dailyPlan, name: "Third" })).ok);
});

test("two devices accepting at once create one routine and both get the same answer", async () => {
  const { proposals, routines, appended } = harness();
  const proposed = await proposals.propose("bot-a", dailyPlan);
  assert.ok(proposed.ok);
  const input = { botId: "bot-a", proposalId: proposed.proposal.proposalId, decision: "accept" as const };
  const [mac, phone] = await Promise.all([proposals.respond(input), proposals.respond(input)]);

  const created = await routines.list("bot-a");
  assert.equal(created.length, 1);
  assert.equal(created[0]!.name, "Weekly meal plan");
  assert.equal(created[0]!.label, "Every Sunday at 9:00 AM");
  assert.deepEqual(mac, { status: "accepted", routineId: created[0]!.id });
  assert.deepEqual(phone, mac);
  assert.deepEqual(
    appended.filter((entry) => entry.kind === BOT_ROUTINE_PROPOSAL_STATUS_ENTRY_KIND).map((entry) => entry.data),
    [{ proposalId: proposed.proposal.proposalId, status: "accepted", routineId: created[0]!.id }],
  );
  // A later Not now cannot undo an accepted card.
  assert.deepEqual(await proposals.respond({ ...input, decision: "dismiss" }), mac);
});

test("Not now records a status entry and creates nothing", async () => {
  const { proposals, routines, appended } = harness();
  const proposed = await proposals.propose("bot-a", dailyPlan);
  assert.ok(proposed.ok);
  const answer = await proposals.respond({ botId: "bot-a", proposalId: proposed.proposal.proposalId, decision: "dismiss" });
  assert.deepEqual(answer, { status: "dismissed" });
  assert.deepEqual(await routines.list("bot-a"), []);
  assert.deepEqual(appended[appended.length - 1], {
    botId: "bot-a",
    kind: BOT_ROUTINE_PROPOSAL_STATUS_ENTRY_KIND,
    data: { proposalId: proposed.proposal.proposalId, status: "dismissed" },
  });
  await assert.rejects(
    proposals.respond({ botId: "bot-a", proposalId: "00000000-0000-4000-8000-999999999999", decision: "accept" }),
    BotRoutineProposalNotFoundError,
  );
});

test("the routines tool can list, propose and pause, but never create a routine itself", async () => {
  const { proposals, routines } = harness();
  const existing = await routines.create({ botId: "bot-a", name: "Morning brief", schedule: { kind: "daily", time: "08:00" }, prompt: "Brief me." });
  const cards: Array<{ kind: string; data: unknown }> = [];
  const tool = routinesCandidate("bot-a", {
    list: (botId) => routines.list(botId),
    pause: (botId, id) => routines.pause(botId, id),
    propose: async (botId, input, append) => {
      const outcome = await proposals.propose(botId, input, append);
      return outcome.ok ? { ok: true, proposalId: outcome.proposal.proposalId } : outcome;
    },
  }).bind!(call(cards));

  assert.deepEqual(json(await tool.execute("c1", { action: "list" })), {
    routines: [{ id: existing.id, name: "Morning brief", label: "Every day at 8:00 AM", enabled: true }],
  });

  const proposed = json(await tool.execute("c2", { action: "propose", ...dailyPlan }));
  assert.equal(proposed.ok, true);
  assert.match(String(proposed.message), /Add routine card/u);
  assert.equal(cards.length, 1, "the card lands in the calling conversation");
  assert.equal((await routines.list("bot-a")).length, 1, "proposing creates nothing");

  for (const action of ["create", "update", "remove"]) {
    await assert.rejects(tool.execute("c3", { action, ...dailyPlan }), /Invalid routine request/u);
  }
  await assert.rejects(tool.execute("c4", { action: "propose", ...dailyPlan, botId: "bot-b" }), /Invalid routine request/u);
  assert.equal((await routines.list("bot-a")).length, 1);

  const paused = json(await tool.execute("c5", { action: "pause", id: existing.id }));
  assert.deepEqual(paused, { routine: { id: existing.id, name: "Morning brief", label: "Every day at 8:00 AM", enabled: false } });
  assert.equal((await routines.list("bot-a"))[0]!.enabled, false);
});

test("the respond IPC payload is parsed strictly", () => {
  const valid = { botId: "bot-a", proposalId: "7D0C5C8E-2F0B-4C4E-9A59-3B6F1F0E9A11", decision: "accept" };
  assert.deepEqual(parseBotRoutineProposalRespond(valid), { ...valid, proposalId: valid.proposalId.toLowerCase() });
  for (const invalid of [
    null,
    { ...valid, decision: "later" },
    { ...valid, proposalId: "not-a-uuid" },
    { ...valid, botId: "../escape" },
    { ...valid, extra: true },
    { botId: valid.botId, decision: "accept" },
  ]) {
    assert.throws(() => parseBotRoutineProposalRespond(invalid), /Invalid routine suggestion response/u, JSON.stringify(invalid));
  }
});
