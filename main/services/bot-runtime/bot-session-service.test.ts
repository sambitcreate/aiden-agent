import { createBotLiveProjection, type BotLiveProjection } from "./live-projection.js";
import { createBotPlans, type BotPlans } from "../bot-plans/plans.js";
import { createBotPlanLifecycle } from "../bot-plans/lifecycle.js";
import { botPlanProposalFingerprint, type BotPlanProposal } from "../bot-plans/validate.js";
import { createBotRunAccess } from "./bot-run-access.js";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { readFile, readdir, rm } from "node:fs/promises";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getCurrentSystemPrompt, getCurrentTools, type Message } from "@earendil-works/pi-ai";
import { renderBotMemorySection } from "../bot-memory/prompt.js";
import { BotRuntimeAuthorityError } from "../bot-runtime-authority.js";
import { createBotRoutineExecutor } from "../scheduled-bot-routines.js";
import type { ScheduledRun, ScheduledTask } from "../types.js";
import { createBotMemoryService } from "../bot-memory/service.js";
import { createBotMemoryStore } from "../bot-memory/store.js";
import { DataStore } from "../data-store.js";
import { emptyToolApprovalRulesDocument, normalizeToolApprovalRulesDocument, ToolApprovalRuleBook, TOOL_APPROVAL_RULES_MAX_BYTES, type ToolApprovalRulesDocument } from "../tool-approval-rules.js";
import { createBotAllowList } from "./bot-allow-list.js";
import { BOT_APPROVAL_TALLIES_FILE, createBotApprovalTallies } from "./bot-approval-tallies.js";
import { createBotApprovals } from "./bot-approvals.js";
import { createBotMessageLedger, type BotMessageDelivery } from "../bot-messages/ledger.js";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { ToolResultEntry, type ModelRef } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { botQuestionCandidate } from "./bot-question-tool.js";
import { createBotQuestions } from "./bot-questions.js";
import {
  BOT_NOTICE_ENTRY_KIND,
  BotSessionError,
  createBotSessionService,
  type BotSessionRuntime,
  type BotSessionServiceDeps,
} from "./bot-session-service.js";
import { createBotRuntimeModels } from "./bot-models.js";
import { BOT_SESSION_FILE, botDirectoryName } from "./harness-host.js";
import { spawnHarnessChild } from "./test-support/child.js";
import { assemblyDeps, assemblyState, FULL_GRANTS, testAuthority } from "./test-support/assembly-fixtures.js";
import { blockingUntilAborted, countingTool, recordingDeps } from "./test-support/fixtures.js";
import { QUESTION_ARGS, QUESTION_TOOL_NAME } from "./test-support/question-fixtures.js";
import { createFauxModels, FAUX_MODEL_REF, slowAnswer, waitFor, type FauxModels } from "./test-support/faux.js";

import { createBotIssueService } from "../bot-issues/service.js";
import { createBotIssueStore, type BotIssueStore } from "../bot-issues/store.js";
import { BOT_ISSUE_STATUS_ENTRY_KIND, botIssueStatusOf } from "../../../renderer/shared/bot-issues.js";

const ctx = BACKGROUND_CONTEXT;
const roots: string[] = [];
function tempProfile(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "aiden-bot-session-"));
  roots.push(root);
  return root;
}
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

async function serviceFor(
  profileDir: string,
  fauxModels: FauxModels,
  overrides: Partial<BotSessionServiceDeps> = {},
): Promise<BotSessionRuntime> {
  return createBotSessionService({
    profileDir,
    models: fauxModels.models,
    extension: recordingDeps(),
    resolveModel: async () => FAUX_MODEL_REF,
    knownBotIds: async () => new Set(["bot:a", "bot:killed"]),
    ...overrides,
  });
}

async function entryKinds(service: BotSessionRuntime, botId: string): Promise<string[]> {
  const view = await (await service.conversation(botId)).context(ctx);
  return view.entries.map((entry) => entry.kind).filter((kind) => kind !== "pi.system");
}

async function notices(service: BotSessionRuntime, botId: string): Promise<unknown[]> {
  const view = await (await service.conversation(botId)).context(ctx);
  return view.entries.filter((entry) => entry.kind === BOT_NOTICE_ENTRY_KIND).map((entry) => entry.data);
}

function messageReceiptRow(taskId: string): BotMessageDelivery {
  const id = randomUUID();
  const requestId = `bot:bot:a:1:${id}`;
  return {
    id,
    taskId,
    fromBotId: "bot:a",
    toBotId: "bot:b",
    fromName: "A",
    toName: "B",
    hop: 1,
    targetRequestId: requestId,
    createdAt: Date.now(),
    deadline: Date.now() + 60_000,
    status: "delivered",
    message: "help",
    waiting: [],
    effects: [
      {
        id: `${id}:target`,
        kind: "target",
        botId: "bot:b",
        requestId,
        text: "help",
      },
    ],
  };
}

test("receipt observation after corrupt-session recovery preserves the next send's reset notice", async () => {
  const profile = tempProfile();
  const ledger = createBotMessageLedger({
    file: () => path.join(profile, "bots", "bot-messages.json"),
    now: Date.now,
  });
  let row: BotMessageDelivery | undefined;
  const tool = countingTool("save_message");
  const extension = recordingDeps({
    tools: [
      {
        tool,
        replay: "safe",
        bind: (call) => ({
          ...tool,
          execute: async (...args) => {
            assert.ok(call.taskId, "receipt uses the actual durable tool task");
            row = messageReceiptRow(call.taskId);
            await ledger.reserve(row);
            return tool.execute(...args);
          },
        }),
      },
    ],
  });
  const faux = createFauxModels([
    fauxAssistantMessage([fauxToolCall("save_message", { text: "save" })], {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("saved"),
    fauxAssistantMessage("fresh answer"),
  ]);
  const first = await serviceFor(profile, faux, { extension });
  try {
    const sent = await first.send("bot:a", {
      text: "save a message",
      requestId: "before-corruption",
    });
    assert.equal(
      (
        await first.awaitReply(
          "bot:a",
          sent.submissionId,
          new AbortController().signal,
        )
      ).kind,
      "completed",
    );
  } finally {
    await first.shutdown();
  }
  assert.ok(row?.taskId);
  assert.equal((await ledger.receipt(row.id))?.taskId, row.taskId);
  const directory = path.join(profile, "bots", botDirectoryName("bot:a"));
  const damaged = "not a SQLite session ".repeat(100);
  writeFileSync(path.join(directory, BOT_SESSION_FILE), damaged);
  const recovered = await serviceFor(profile, faux);
  try {
    assert.equal(
      await recovered.awaitMessageTaskSettlement(
        "bot:a",
        row.taskId,
        new AbortController().signal,
      ),
      true,
    );
    await ledger.collectReceipt(row.id, row.taskId);
    assert.equal(await ledger.receipt(row.id), undefined);
    assert.equal(
      faux.calls(),
      2,
      "observing and collecting never runs a model",
    );
    const [moved] = (await readdir(directory)).filter((name) =>
      name.startsWith(`${BOT_SESSION_FILE}.corrupt-`),
    );
    assert.ok(moved);
    assert.equal(await readFile(path.join(directory, moved), "utf8"), damaged);
    const sent = await recovered.send("bot:a", {
      text: "new question",
      requestId: "after-corruption",
    });
    assert.deepEqual(
      await recovered.awaitReply(
        "bot:a",
        sent.submissionId,
        new AbortController().signal,
      ),
      {
        kind: "completed",
        text: "fresh answer",
      },
    );
    assert.deepEqual(await notices(recovered, "bot:a"), [
      { notice: "session_reset", movedTo: moved },
    ]);
    assert.equal(faux.calls(), 3);
  } finally {
    await recovered.shutdown();
  }
});

test("a damaged peer purge marker does not skip later Bot deletion effects", async () => {
  const profile = tempProfile();
  const file = path.join(profile, "bots", "bot-messages.json");
  const ledger = createBotMessageLedger({ file: () => file, now: Date.now });
  await ledger.forgetBot("peer");
  const directory = path.join(
    path.dirname(file),
    ".bot-messages.json.pending-purges",
  );
  const [marker] = await readdir(directory);
  const damaged = "{damaged peer purge";
  writeFileSync(path.join(directory, marker!), damaged);
  const effects: string[] = [];
  const faux = createFauxModels([]);
  const service = await serviceFor(profile, faux, {
    deleteEffects: [
      async (id) => {
        await ledger.forgetBot(id);
      },
      async (id) => {
        effects.push(id);
      },
    ],
  });
  try {
    await service.initialize();
    assert.equal(
      await readFile(path.join(directory, marker!), "utf8"),
      damaged,
      "startup's orphan sweep preserves purge markers",
    );
    await service.deleteBot("bot:a");
    assert.deepEqual(effects, ["bot:a"]);
    assert.equal(
      await readFile(path.join(directory, marker!), "utf8"),
      damaged,
    );
    assert.equal((await readdir(directory)).length, 2);
    await assert.rejects(ledger.open(), /bookkeeping/);
    assert.equal(faux.calls(), 0);
  } finally {
    await service.shutdown();
  }
});

/** Leave `bot:killed` with a turn that was streaming when its process died. */
async function killMidStream(profileDir: string): Promise<string> {
  const child = spawnHarnessChild("stream", [profileDir, "bot:killed", "req-killed"]);
  const submissionId = await child.waitFor("STREAMING");
  await child.kill();
  return submissionId;
}

test("the same requestId twice admits one user message and reports the repeat as deduped", async () => {
  const fauxModels = createFauxModels([fauxAssistantMessage("hello back")]);
  const service = await serviceFor(tempProfile(), fauxModels);
  try {
    assert.equal(await service.submissionForRequest("bot:a", "desk-1"), undefined);
    const first = await service.send("bot:a", { text: "hello", requestId: "desk-1" });
    assert.equal(await service.submissionForRequest("bot:a", "desk-1"), first.submissionId);
    const second = await service.send("bot:a", { text: "hello", requestId: "desk-1" });
    assert.equal(first.deduped, false);
    assert.deepEqual(second, { submissionId: first.submissionId, deduped: true });
    assert.equal((await service.awaitReply("bot:a", first.submissionId, new AbortController().signal)).kind, "completed");
    assert.deepEqual(await entryKinds(service, "bot:a"), ["pi.user", "pi.assistant"]);
    assert.equal(fauxModels.calls(), 1);
  } finally {
    await service.shutdown();
  }
});

test("a requestId is still deduped after a restart", async () => {
  const profile = tempProfile();
  const fauxModels = createFauxModels([fauxAssistantMessage("once")]);
  const first = await serviceFor(profile, fauxModels);
  const { submissionId } = await first.send("bot:a", { text: "hi", requestId: "tg:1:2:0:3" });
  await first.awaitReply("bot:a", submissionId, new AbortController().signal);
  await first.shutdown();

  const second = await serviceFor(profile, fauxModels);
  try {
    assert.equal(await second.submissionForRequest("bot:a", "tg:1:2:0:3"), submissionId);
    assert.deepEqual(await second.send("bot:a", { text: "hi", requestId: "tg:1:2:0:3" }), {
      submissionId,
      deduped: true,
    });
    assert.equal(fauxModels.calls(), 1);
  } finally {
    await second.shutdown();
  }
});

test("startup reports the interrupted Bot and runs nothing", async () => {
  const profile = tempProfile();
  const submissionId = await killMidStream(profile);
  const fauxModels = createFauxModels([fauxAssistantMessage("never")]);
  const service = await serviceFor(profile, fauxModels);
  try {
    assert.deepEqual(await service.initialize(), { removedOrphans: [], interrupted: ["bot:killed"] });
    assert.deepEqual(await service.state("bot:killed"), { kind: "interrupted", submissionId });
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(fauxModels.calls(), 0);
  } finally {
    await service.shutdown();
  }
});

test("sending while interrupted keeps the partial, marks it interrupted, and runs the new turn", async () => {
  const profile = tempProfile();
  const killedSubmission = await killMidStream(profile);
  const fauxModels = createFauxModels([fauxAssistantMessage("fresh reply")]);
  const service = await serviceFor(profile, fauxModels);
  try {
    await service.initialize();
    const sent = await service.send("bot:killed", { text: "new question", requestId: "desk-2" });
    const outcome = await service.awaitReply("bot:killed", sent.submissionId, new AbortController().signal);
    assert.deepEqual(outcome, { kind: "completed", text: "fresh reply" });
    assert.equal(fauxModels.calls(), 1, "only the new turn reaches the provider");
    const view = await (await service.conversation("bot:killed")).context(ctx);
    const partial = view.entries.find((entry) => entry.kind === "pi.assistant");
    assert.match(JSON.stringify(partial?.model), /word word/u, "the interrupted partial answer is kept");
    assert.deepEqual(await notices(service, "bot:killed"), [{ notice: "interrupted", submissionId: killedSubmission }]);
    assert.deepEqual(await service.state("bot:killed"), { kind: "idle" });
  } finally {
    await service.shutdown();
  }
});

test("Resume called twice at once makes one fresh provider request", async () => {
  const profile = tempProfile();
  await killMidStream(profile);
  const fauxModels = createFauxModels([fauxAssistantMessage("resumed answer"), fauxAssistantMessage("extra")]);
  const service = await serviceFor(profile, fauxModels);
  try {
    await service.initialize();
    const [first, second] = await Promise.all([
      service.resume("bot:killed", "phone-1"),
      service.resume("bot:killed", "desk-1"),
    ]);
    assert.equal(first.kind, "running");
    assert.deepEqual(second, first);
    await waitFor(async () => (await service.state("bot:killed")).kind === "idle", { what: "resumed turn to finish" });
    assert.equal(fauxModels.calls(), 1);
    // A retried request replays its first answer.
    assert.deepEqual(await service.resume("bot:killed", "phone-1"), first);
    assert.equal(fauxModels.calls(), 1);
  } finally {
    await service.shutdown();
  }
});

test("Resume reports it resumed only for the call that did: not for a replay, a second request, or a blocked one", async () => {
  const profile = tempProfile();
  await killMidStream(profile);
  const resumed: string[] = [];
  const fauxModels = createFauxModels([fauxAssistantMessage("resumed answer")]);
  const service = await serviceFor(profile, fauxModels, { onResumed: (botId) => resumed.push(botId) });
  try {
    await service.initialize();
    await Promise.all([service.resume("bot:killed", "phone-1"), service.resume("bot:killed", "desk-1")]);
    await service.resume("bot:killed", "phone-1");
    await waitFor(async () => (await service.state("bot:killed")).kind === "idle", { what: "resumed turn to finish" });
    await service.resume("bot:killed", "desk-2");
    assert.deepEqual(resumed, ["bot:killed"]);
  } finally {
    await service.shutdown();
  }
  const blockedProfile = tempProfile();
  await killMidStream(blockedProfile);
  const blocked: string[] = [];
  const refused = await serviceFor(blockedProfile, createFauxModels([fauxAssistantMessage("must not run")]), {
    extension: recordingDeps({ readmit: () => ({ ok: false, reason: "access_changed" }) }),
    onResumed: (botId) => blocked.push(botId),
  });
  try {
    await refused.initialize();
    await refused.resume("bot:killed", "r");
    assert.deepEqual(blocked, []);
  } finally {
    await refused.shutdown();
  }
});

test("Dismiss after a restart makes no provider request and keeps the partial as interrupted", async () => {
  const profile = tempProfile();
  const submissionId = await killMidStream(profile);
  const fauxModels = createFauxModels([fauxAssistantMessage("must not run")]);
  const service = await serviceFor(profile, fauxModels);
  try {
    await service.initialize();
    assert.deepEqual(await service.dismiss("bot:killed", "desk-3"), { kind: "idle" });
    assert.deepEqual(await service.dismiss("bot:killed", "phone-3"), { kind: "idle" });
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(fauxModels.calls(), 0);
    assert.deepEqual(await notices(service, "bot:killed"), [{ notice: "interrupted", submissionId }]);
    assert.deepEqual(await entryKinds(service, "bot:killed"), ["pi.user", "pi.assistant", BOT_NOTICE_ENTRY_KIND]);
  } finally {
    await service.shutdown();
  }
});

test("Resume after an access change runs nothing and reports it", async () => {
  const profile = tempProfile();
  const submissionId = await killMidStream(profile);
  const fauxModels = createFauxModels([fauxAssistantMessage("must not run")]);
  const service = await serviceFor(profile, fauxModels, {
    extension: recordingDeps({ readmit: () => ({ ok: false, reason: "access_changed" }) }),
  });
  try {
    await service.initialize();
    assert.deepEqual(await service.resume("bot:killed", "r"), {
      kind: "interrupted",
      submissionId,
      blocked: "access_changed",
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(fauxModels.calls(), 0);
  } finally {
    await service.shutdown();
  }
});

test("a routine send never dismisses a paused turn", async () => {
  const profile = tempProfile();
  const submissionId = await killMidStream(profile);
  const fauxModels = createFauxModels([fauxAssistantMessage("must not run")]);
  const service = await serviceFor(profile, fauxModels);
  try {
    await service.initialize();
    await assert.rejects(
      service.send("bot:killed", {
        text: "daily digest",
        requestId: "routine:t1:1700000000000",
        ifNotInterrupted: true,
        label: "Daily digest",
      }),
      (error: unknown) => error instanceof BotSessionError && error.reason === "bot_paused",
    );
    await assert.rejects(service.send("bot:killed", {
      text: "framed Bot message", requestId: "bot:J:1:00112233-4455-4677-8899-aabbccddeeff", ifIdle: true, ifNotInterrupted: true,
      botMessage: {kind: "request", deliveryId: "00112233-4455-4677-8899-aabbccddeeff", botId: "J", botName: "Jester", text: "help", deadline: Date.now()+60_000},
    }), (error: unknown) => error instanceof BotSessionError && error.reason === "bot_paused");
    assert.deepEqual(await service.state("bot:killed"), { kind: "interrupted", submissionId });
    assert.deepEqual(await notices(service, "bot:killed"), []);
    assert.equal(fauxModels.calls(), 0);
    assert.deepEqual(
      await service.awaitReply("bot:killed", submissionId, new AbortController().signal),
      { kind: "interrupted" },
      "waiting on a paused turn does not start it",
    );
    assert.equal(fauxModels.calls(), 0);
  } finally {
    await service.shutdown();
  }
});

test("a labelled routine turn and a silent reply are recorded as notices", async () => {
  const fauxModels = createFauxModels([fauxAssistantMessage("[SILENT]")]);
  const service = await serviceFor(tempProfile(), fauxModels);
  try {
    const sent = await service.send("bot:a", {
      text: "anything new?",
      requestId: "routine:t1:1",
      ifNotInterrupted: true,
      label: "Inbox check",
    });
    const outcome = await service.awaitReply("bot:a", sent.submissionId, new AbortController().signal);
    assert.deepEqual(outcome, { kind: "completed", text: "[SILENT]" });
    assert.ok((await entryKinds(service, "bot:a")).includes("aiden.routine-input"));
    await service.markSilent("bot:a", sent.submissionId);
    assert.deepEqual(await notices(service, "bot:a"), [
      { notice: "routine", label: "Inbox check", requestId: "routine:t1:1" },
      { notice: "silent", submissionId: sent.submissionId },
    ]);
  } finally {
    await service.shutdown();
  }
});

test("deleteBot during a running turn erases the session and every owned record", async () => {
  const profile = tempProfile();
  const fauxModels = createFauxModels([slowAnswer(), fauxAssistantMessage("never")], { tokensPerSecond: 40 });
  const routines = new Map([["bot:a", ["r1"]]]);
  const photos = new Set(["bot:a"]);
  const bindings = new Set(["bot:a"]);
  const order: string[] = [];
  const service = await serviceFor(profile, fauxModels, {
    deleteEffects: [
      async (botId) => void (order.push("routines"), routines.delete(botId)),
      async (botId) => void (order.push("photo"), photos.delete(botId)),
      async (botId) => void (order.push("binding"), bindings.delete(botId)),
    ],
  });
  try {
    const sent = await service.send("bot:a", { text: "write a lot", requestId: "desk-del" });
    await waitFor(async () => (await service.state("bot:a")).kind === "running" && fauxModels.calls() === 1, {
      what: "turn start",
    });
    const waiting = service.awaitReply("bot:a", sent.submissionId, new AbortController().signal);
    await service.deleteBot("bot:a");
    assert.equal(existsSync(path.join(profile, "bots", botDirectoryName("bot:a"))), false);
    assert.equal(routines.has("bot:a"), false);
    assert.equal(photos.has("bot:a"), false);
    assert.equal(bindings.has("bot:a"), false);
    assert.deepEqual(order, ["routines", "photo", "binding"]);
    assert.equal((await waiting).kind, "interrupted");
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(fauxModels.calls(), 1);
    await assert.rejects(service.send("bot:a", { text: "again", requestId: "desk-after" }), BotSessionError);
    assert.equal(existsSync(path.join(profile, "bots", botDirectoryName("bot:a"))), false);
  } finally {
    await service.shutdown();
  }
});

test("quarantined approval evidence permits deletion and startup roll-forward through every cleanup effect", async (t) => {
  for (const damage of ["malformed JSON", "unrelated Bot receipt"]) {
    for (const pendingAtStartup of [false, true]) await t.test(`${damage}, ${pendingAtStartup ? "restart pending delete" : "person delete"}`, async () => {
      const profile = tempProfile();
      const file = path.join(profile, "tool-approval-rules.json");
      const journal = path.join(profile, "bots", "pending-deletes.json");
      const target = { kind: "connection", serverId: "gcal", tool: "create_event" } as const;
      const bots = new Set(["bot:a", "bot:b"]);
      const openRules = () => new ToolApprovalRuleBook(new DataStore<ToolApprovalRulesDocument>(
        "tool-approval-rules.json", emptyToolApprovalRulesDocument(), () => profile,
        { normalize: normalizeToolApprovalRulesDocument, reloadBeforeWrite: true, maxBytes: TOOL_APPROVAL_RULES_MAX_BYTES, fileMode: 0o600 },
      ), undefined, undefined, { knownBot: async (id) => {
        if (!bots.has(id)) return false;
        try { return !JSON.parse(await readFile(journal, "utf8")).botIds.includes(id); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return true; throw error; }
      } });
      const rules = openRules();
      await rules.grantBot("bot:a", target, "Calendar A", "own-decision");
      await rules.grantBot("bot:b", target, "Calendar B", "peer-decision");
      const healthy = JSON.parse(await readFile(file, "utf8"));
      const evidence = damage === "malformed JSON" ? '{"version":1,"botGrantOperations":[' : JSON.stringify({
        ...healthy, botGrantOperations: [...healthy.botGrantOperations, { botId: "bot:b", operationId: "damaged-peer" }],
      }, null, 2) + "\n";
      writeFileSync(file, evidence);
      const tallies = createBotApprovalTallies({ profileDir: () => profile });
      for (const botId of bots) await tallies.record(botId, target, {
        id: `decision-${botId}`, authorizationFingerprint: `fingerprint-${botId}`, source: "person", answer: "allow", offered: false,
      });
      const allowed = createBotAllowList({ rules, tallies, approvals: createBotApprovals({ publish() {} }),
        folderEntries: async () => [], revokeFolder: async () => false,
        botName: async () => "Ada", connectionName: async () => "Calendar" });
      const computer = path.join(profile, "computers", "bot-a");
      const home = path.join(profile, "homes", "bot-a");
      for (const directory of [computer, home]) {
        mkdirSync(directory, { recursive: true });
        writeFileSync(path.join(directory, "owned-data"), "private Bot data");
      }
      if (pendingAtStartup) writeFileSync(journal, JSON.stringify({ version: 1, botIds: ["bot:a"] }));
      const order: string[] = [];
      const reports: unknown[] = [];
      const faux = createFauxModels([]);
      const overrides: Partial<BotSessionServiceDeps> = {
        knownBotIds: async () => new Set(bots), onReport: (_id, error) => { reports.push(error); },
        deleteEffects: [
          async (id) => {
            assert.equal(await rules.matchBot(id, target).catch(() => undefined), undefined);
            assert.ok(JSON.parse(await readFile(journal, "utf8")).botIds.includes(id), "intent is durable before cleanup");
            await allowed.forgetBot(id); order.push("allowed");
          },
          async () => { order.push("rules"); },
          async () => { await rm(computer, { recursive: true, force: true }); order.push("computer"); },
          async () => { order.push("dismissals"); },
          async () => { order.push("telegram"); },
          async (id) => { await rm(home, { recursive: true, force: true }); bots.delete(id); order.push("data"); },
        ],
      };
      const assertErased = async () => {
        assert.equal(bots.has("bot:a"), false);
        assert.equal(bots.has("bot:b"), true);
        assert.equal(existsSync(computer), false);
        assert.equal(existsSync(home), false);
        assert.equal(existsSync(path.join(profile, "bots", botDirectoryName("bot:a"))), false);
        assert.equal(existsSync(path.join(profile, "bots", botDirectoryName("bot:b"), BOT_APPROVAL_TALLIES_FILE)), true);
        assert.deepEqual(JSON.parse(await readFile(journal, "utf8")), { version: 1, botIds: [] });
        assert.equal(await readFile(file, "utf8"), evidence);
        assert.deepEqual((await readdir(profile)).filter(name => name.startsWith("tool-approval-rules")), ["tool-approval-rules.json"]);
        for (const book of [rules, openRules()]) {
          await assert.rejects(book.matchBot("bot:a", target), /receipt/u);
          await assert.rejects(book.matchBot("bot:b", target), /receipt/u);
          await assert.rejects(book.grantBot("bot:a", target, "Calendar A", "own-decision"), /receipt/u);
          await assert.rejects(book.grantBot("bot:a", target, "Calendar A", "new-decision"), /receipt/u);
        }
      };
      const service = await serviceFor(profile, faux, overrides);
      try {
        if (pendingAtStartup) {
          await assert.rejects(service.send("bot:a", { text: "cannot reopen", requestId: "pending" }), BotSessionError);
          await service.initialize();
        } else {
          await service.deleteBot("bot:a");
        }
        assert.deepEqual(reports, []);
        assert.deepEqual(order, ["allowed", "rules", "computer", "dismissals", "telegram", "data"]);
        await assertErased();
        await service.deleteBot("bot:a");
        await assertErased();
      } finally { await service.shutdown(); }
      const restarted = await serviceFor(profile, faux, overrides);
      try {
        await restarted.initialize();
        await restarted.deleteBot("bot:a");
        await assertErased();
        await assert.rejects(restarted.send("bot:a", { text: "cannot reopen", requestId: "deleted" }), BotSessionError);
        assert.deepEqual(reports, []);
        assert.equal(faux.calls(), 0);
      } finally { await restarted.shutdown(); }
    });
  }
});

test("a reply whose session fails on a storage error and cannot reopen is failed, not left waiting for Resume", async () => {
  const profile = tempProfile();
  const fauxModels = createFauxModels([slowAnswer()], { tokensPerSecond: 40 });
  const service = await serviceFor(profile, fauxModels);
  try {
    const sent = await service.send("bot:a", { text: "write a lot", requestId: "desk-storage" });
    await waitFor(async () => (await service.state("bot:a")).kind === "running" && fauxModels.calls() === 1, {
      what: "turn start",
    });
    const waiting = service.awaitReply("bot:a", sent.submissionId, new AbortController().signal);
    // Another connection holds the write lock past SQLite's busy timeout: the
    // next commit fails the session, and reopening it fails the same way.
    const blocker = new DatabaseSync(path.join(profile, "bots", botDirectoryName("bot:a"), BOT_SESSION_FILE));
    try {
      blocker.exec("BEGIN EXCLUSIVE");
      await assert.rejects(service.send("bot:a", { text: "and this", requestId: "desk-storage-2" }));
      const outcome = await waiting;
      assert.equal(outcome.kind, "failed");
      assert.ok(outcome.kind === "failed" && outcome.error.length > 0, "the failure has a message for the person");
    } finally {
      blocker.exec("ROLLBACK");
      blocker.close();
    }
  } finally {
    await service.shutdown();
  }
});

test("a reply whose answer committed just before a storage failure is delivered, not reported lost", async () => {
  const profile = tempProfile();
  const fauxModels = createFauxModels([fauxAssistantMessage("Dinner is pasta.")]);
  const service = await serviceFor(profile, fauxModels);
  const original = SqliteStorage.prototype.commit;
  let failed = false;
  // The batch that settles the input lands on disk, then its commit reports a failure.
  SqliteStorage.prototype.commit = async function (this: SqliteStorage, ...args: Parameters<typeof original>) {
    const seq = await original.apply(this, args);
    const [writes] = args;
    if (!failed && /"type":"input"/u.test(JSON.stringify(writes)) && /"status":"done"/u.test(JSON.stringify(writes))) {
      failed = true;
      throw new Error("disk I/O error");
    }
    return seq;
  };
  try {
    const sent = await service.send("bot:a", { text: "plan dinner", requestId: "desk-commit-landed" });
    const outcome = await service.awaitReply("bot:a", sent.submissionId, new AbortController().signal);
    assert.equal(failed, true, "the storage failure was injected");
    assert.deepEqual(outcome, { kind: "completed", text: "Dinner is pasta." });
    assert.equal(fauxModels.calls(), 1, "the answer is read back, not regenerated");
  } finally {
    SqliteStorage.prototype.commit = original;
    await service.shutdown();
  }
});

test("without a model the Bot needs one and sends are refused", async () => {
  let model: ModelRef | null = null;
  const fauxModels = createFauxModels([fauxAssistantMessage("hi")]);
  const service = await serviceFor(tempProfile(), fauxModels, { resolveModel: async () => model });
  try {
    assert.deepEqual(await service.state("bot:a"), { kind: "needs_model" });
    await assert.rejects(
      service.send("bot:a", { text: "hi", requestId: "x" }),
      (error: unknown) => error instanceof BotSessionError && error.reason === "needs_model",
    );
    assert.equal(fauxModels.calls(), 0);
    model = FAUX_MODEL_REF;
    assert.deepEqual(await service.state("bot:a"), { kind: "idle" });
  } finally {
    await service.shutdown();
  }
});

test("a configured model that fails to resolve shows its real error, not 'needs a model'", async () => {
  let failure: Error | null = new Error("Sign in to OpenAI again to use this model.");
  const fauxModels = createFauxModels([fauxAssistantMessage("back")]);
  const service = await serviceFor(tempProfile(), fauxModels, {
    resolveModel: async () => {
      if (failure) throw failure;
      return FAUX_MODEL_REF;
    },
  });
  try {
    assert.deepEqual(await service.state("bot:a"), {
      kind: "model_error",
      message: "Sign in to OpenAI again to use this model.",
    });
    await assert.rejects(
      service.send("bot:a", { text: "hi", requestId: "m-1" }),
      (error: unknown) =>
        error instanceof BotSessionError &&
        error.reason === "model_error" &&
        error.message === "Sign in to OpenAI again to use this model.",
    );
    assert.equal(fauxModels.calls(), 0);
    failure = null;
    const sent = await service.send("bot:a", { text: "hi", requestId: "m-2" });
    assert.equal((await service.awaitReply("bot:a", sent.submissionId, new AbortController().signal)).kind, "completed");
  } finally {
    await service.shutdown();
  }
});

function routineExecutor(service: BotSessionRuntime) {
  const runs: ScheduledRun[] = [];
  return createBotRoutineExecutor({
    store: {
      recordRun: async (run) => {
        const recorded = { ...run, id: run.id ?? `run-${runs.length + 1}` } as ScheduledRun;
        runs.push(recorded);
        return recorded;
      },
      runById: async (taskId, runId) => runs.find((run) => run.taskId === taskId && run.id === runId),
      get: async () => undefined,
      settleRoutineFire: async () => undefined,
    },
    ports: () => service,
    broadcast: () => undefined,
  });
}

test("a tool-free failed routine can retry between unrelated chat turns that use tools", async () => {
  const lookup = countingTool("lookup");
  const models = createFauxModels([
    fauxAssistantMessage([fauxToolCall("lookup", { text: "calendar" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("No appointments."),
    fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 Service Unavailable" }),
    fauxAssistantMessage([fauxToolCall("lookup", { text: "weather" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("Sunny."),
    fauxAssistantMessage("Briefing ready."),
  ]);
  const service = await serviceFor(tempProfile(), models, {
    extension: recordingDeps({ tools: [{ tool: lookup, replay: "safe" }] }),
    settings: { retry: { enabled: false } },
  });
  try {
    const executor = routineExecutor(service);
    const task = { id: "briefing", botId: "bot:a", prompt: "Brief me.", enabled: true } as ScheduledTask;
    const signal = new AbortController().signal;
    const earlier = await service.send("bot:a", { requestId: "desktop-calendar", text: "Check the calendar." });
    assert.equal((await service.awaitReply("bot:a", earlier.submissionId, signal)).kind, "completed");
    assert.equal(lookup.executions.length, 1);
    const original = await executor.run(task, { trigger: { kind: "automatic", fireTime: 42 }, signal });
    assert.equal(original.failure?.kind, "temporary");
    const chat = await service.send("bot:a", { requestId: "desktop-weather", text: "Check the weather." });
    assert.equal((await service.awaitReply("bot:a", chat.submissionId, signal)).kind, "completed");
    assert.equal(lookup.executions.length, 2);
    const requestId = `${original.id}:retry-1`;
    const retry = await executor.run(task, { runId: requestId, trigger: { kind: "retry", requestId, failedRunId: original.id, attempt: 1 }, signal });
    assert.equal(retry.output, "Briefing ready.");
    assert.equal(models.calls(), 6);
  } finally {
    await service.shutdown();
  }
});

test("a delayed routine retry cannot repeat a tool after the next model call fails", async () => {
  const send = countingTool("send_email");
  const sendMessage = () => fauxAssistantMessage([fauxToolCall("send_email", { text: "briefing" })], { stopReason: "toolUse" });
  const failed = fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 Service Unavailable" });
  const models = createFauxModels([failed, sendMessage(), failed, sendMessage(), fauxAssistantMessage("Sent.")]);
  const service = await serviceFor(tempProfile(), models, {
    extension: recordingDeps({ tools: [{ tool: send, replay: "unsafe" }] }),
    settings: { retry: { enabled: false } },
  });
  try {
    const executor = routineExecutor(service);
    const task = { id: "email", botId: "bot:a", prompt: "Email the briefing.", enabled: true } as ScheduledTask;
    const signal = new AbortController().signal;
    const greeting = await service.send("bot:a", { requestId: "desktop-greeting", text: "Hello." });
    assert.equal((await service.awaitReply("bot:a", greeting.submissionId, signal)).kind, "failed");
    const original = await executor.run(task, { trigger: { kind: "automatic", fireTime: 42 }, signal });
    assert.equal(original.failure?.kind, "temporary");
    assert.equal(send.executions.length, 1);
    const requestId = `${original.id}:retry-1`;
    await executor.run(task, { runId: requestId, trigger: { kind: "retry", requestId, failedRunId: original.id, attempt: 1 }, signal });
    assert.equal(send.executions.length, 1, "sending the same message twice is externally observable");
    assert.equal(await service.submissionForRequest("bot:a", requestId), undefined);
  } finally {
    await service.shutdown();
  }
});

test("a watchdog stop while a routine tool is running cannot authorize a fresh submission", async () => {
  const send = countingTool("send_email", (_params, signal) => blockingUntilAborted(signal));
  const models = createFauxModels([
    fauxAssistantMessage([fauxToolCall("send_email", { text: "briefing" })], { stopReason: "toolUse" }),
  ]);
  const service = await serviceFor(tempProfile(), models, {
    extension: recordingDeps({ tools: [{ tool: send, replay: "unsafe" }] }),
  });
  const requestId = "routine:email:42";
  try {
    await service.send("bot:a", { requestId, text: "Email the briefing." });
    await waitFor(() => send.executions.length === 1, { what: "the email tool to start" });
    await service.stop("bot:a");
    assert.equal(await service.canRetryRoutineRequest("bot:a", requestId), false);
  } finally {
    await service.shutdown();
  }
});

test("a routine whose model was refused by runtime authority records access_changed with the typed code", async () => {
  const fauxModels = createFauxModels([fauxAssistantMessage("hi")]);
  const service = await serviceFor(tempProfile(), fauxModels, {
    resolveModel: async () => {
      throw new BotRuntimeAuthorityError("model_changed");
    },
  });
  const executor = routineExecutor(service);
  try {
    const task = { id: "routine-1", name: "Briefing", enabled: true, mode: "llm", cron: "0 9 * * *", timezone: "UTC", permission: "read-only", botId: "bot:a", prompt: "Brief me.", notify: true, createdAt: 1, updatedAt: 1 } as ScheduledTask;
    const run = await executor.run(task, { trigger: { kind: "manual", key: "k1" }, signal: new AbortController().signal });
    assert.equal(run.result, "error");
    assert.equal(run.failure?.kind, "access_changed");
    assert.equal(run.failure?.code, "model_changed");
    assert.equal(fauxModels.calls(), 0);
  } finally {
    await service.shutdown();
  }
});

test("startup removes sessions of Bots that no longer exist", async () => {
  const profile = tempProfile();
  const fauxModels = createFauxModels([fauxAssistantMessage("hi")]);
  const first = await serviceFor(profile, fauxModels, { knownBotIds: async () => new Set(["bot:gone"]) });
  await first.conversation("bot:gone");
  await first.shutdown();
  const service = await serviceFor(profile, fauxModels, { knownBotIds: async () => new Set() });
  try {
    assert.deepEqual(await service.initialize(), { removedOrphans: [botDirectoryName("bot:gone")], interrupted: [] });
  } finally {
    await service.shutdown();
  }
});

test("a second Aiden process holding the profile makes Bots unavailable", async () => {
  const profile = tempProfile();
  const child = spawnHarnessChild("host", [profile]);
  try {
    await child.waitFor("HOST");
    const service = await serviceFor(profile, createFauxModels());
    assert.deepEqual(await service.state("bot:a"), { kind: "unavailable", reason: "held_by_live_process" });
    await assert.rejects(
      service.send("bot:a", { text: "hi", requestId: "x" }),
      /Bots are open in another Aiden window\./u,
    );
    await service.shutdown();
  } finally {
    await child.kill();
  }
});

test("two Bots on the same OpenCode model keep their own session header", async () => {
  const sessions: string[] = [];
  const reply = (_context: unknown, _options: unknown, _state: unknown, model: { headers?: Record<string, string> }) => {
    sessions.push(model.headers?.["x-opencode-session"] ?? "none");
    return fauxAssistantMessage("ok");
  };
  const fauxModels = createFauxModels([reply, reply, reply]);
  const runtimeModels = createBotRuntimeModels();
  const base = fauxModels.models.getModel(FAUX_MODEL_REF.provider, FAUX_MODEL_REF.modelId)!;
  // As production resolves a Bot's model: one runtime per Bot, attributed to that Bot.
  const resolveModel = async (botId: string) => {
    runtimeModels.register(botId, {
      model: { ...base, headers: { "x-opencode-session": botId } },
      models: fauxModels.models,
      streams: fauxModels.models,
    });
    return FAUX_MODEL_REF;
  };
  const service = await serviceFor(tempProfile(), fauxModels, {
    models: runtimeModels.modelsFor,
    resolveModel,
    knownBotIds: async () => new Set(["bot:a", "bot:b"]),
  });
  try {
    const signal = new AbortController().signal;
    const a = await service.send("bot:a", { text: "hi", requestId: "a-1" });
    // Bot B resolves its model before A's turn runs.
    await resolveModel("bot:b");
    await service.awaitReply("bot:a", a.submissionId, signal);
    const b = await service.send("bot:b", { text: "hi", requestId: "b-1" });
    await service.awaitReply("bot:b", b.submissionId, signal);
    await resolveModel("bot:b");
    const again = await service.send("bot:a", { text: "again", requestId: "a-2" });
    await service.awaitReply("bot:a", again.submissionId, signal);
    assert.deepEqual(sessions, ["bot:a", "bot:b", "bot:a"]);
  } finally {
    await service.shutdown();
  }
});

test("each queued input runs with the tool policy of its own ingress", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "aiden-bot-home-"));
  roots.push(home);
  const state = assemblyState(testAuthority({ mode: "full", home, ...FULL_GRANTS }));
  const questions = createBotQuestions();
  let asked = 0;
  questions.onChange(() => (asked = Math.max(asked, questions.pending().length)));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const slow = countingTool("run_command", async () => {
    await gate;
    return "done";
  });
  const extension = assemblyDeps(state, {
    candidates: () => [{ tool: slow }, botQuestionCandidate("bot:a", questions)],
  });
  const offered: string[][] = [];
  const record =
    (reply: () => ReturnType<typeof fauxAssistantMessage>) =>
    (context: { messages: readonly { role: string }[] }) => {
      offered.push(getCurrentTools(context.messages).map((tool) => tool.name));
      return reply();
    };
  const fauxModels = createFauxModels([
    record(() => fauxAssistantMessage([fauxToolCall("run_command", { text: "x" })], { stopReason: "toolUse" })),
    record(() => fauxAssistantMessage("first done")),
    // The routine asks a question anyway; nobody is there to answer it.
    record(() => fauxAssistantMessage([fauxToolCall(QUESTION_TOOL_NAME, QUESTION_ARGS)], { stopReason: "toolUse" })),
    record(() => fauxAssistantMessage("routine done")),
    record(() => fauxAssistantMessage("second done")),
  ]);
  const service = await serviceFor(tempProfile(), fauxModels, { extension });
  try {
    const first = await service.send("bot:a", { text: "run it", requestId: "desk-1" });
    await waitFor(() => slow.executions.length === 1, { what: "the first turn's tool" });
    const routine = await service.send("bot:a", {
      text: "daily digest",
      requestId: "routine:task-1:2026-10-07T09:00:00.000Z",
      ifNotInterrupted: true,
      label: "Daily digest",
    });
    const second = await service.send("bot:a", { text: "and then?", requestId: "desk-2" });
    release();

    const signal = new AbortController().signal;
    assert.equal((await service.awaitReply("bot:a", first.submissionId, signal)).kind, "completed");
    await waitFor(async () => asked > 0 || (await service.state("bot:a")).kind === "idle", {
      what: "the queued turns to finish",
    });
    assert.equal(asked, 0, "the routine never shows a question card");
    assert.deepEqual(await service.awaitReply("bot:a", routine.submissionId, signal), {
      kind: "completed",
      text: "routine done",
    });
    assert.deepEqual(await service.awaitReply("bot:a", second.submissionId, signal), {
      kind: "completed",
      text: "second done",
    });

    assert.ok(offered[0]!.includes(QUESTION_TOOL_NAME), "the desktop turn offers questions");
    assert.equal(offered[2]!.includes(QUESTION_TOOL_NAME), false, "the routine's request offers no question tool");
    assert.ok(offered[4]!.includes(QUESTION_TOOL_NAME), "the desktop follow-up offers questions again");

    const view = await (await service.conversation("bot:a")).context(ctx);
    const questionResults = view.entries
      .filter((entry) => entry.kind === ToolResultEntry.kind)
      .map((entry) => (entry as unknown as { model: Array<{ toolName: string; isError: boolean }> }).model[0]!)
      .filter((result) => result.toolName === QUESTION_TOOL_NAME);
    assert.equal(questionResults.length, 1);
    assert.equal(questionResults[0]!.isError, true, "the routine's question call is refused");
  } finally {
    release();
    await service.shutdown();
  }
});

test("a routine queued before a quit keeps its own tool policy after Resume", async () => {
  const profile = tempProfile();
  const home = mkdtempSync(path.join(os.tmpdir(), "aiden-bot-home-"));
  roots.push(home);
  const state = assemblyState(testAuthority({ mode: "full", home, ...FULL_GRANTS }));
  const candidates = (questions: ReturnType<typeof createBotQuestions>) => () => [
    { tool: countingTool("run_command", (_params, signal) => blockingUntilAborted(signal)) },
    botQuestionCandidate("bot:a", questions),
  ];
  const before = await serviceFor(
    profile,
    createFauxModels([fauxAssistantMessage([fauxToolCall("run_command", { text: "x" })], { stopReason: "toolUse" })]),
    { extension: assemblyDeps(state, { candidates: candidates(createBotQuestions()) }) },
  );
  await before.send("bot:a", { text: "run it", requestId: "desk-1" });
  await waitFor(async () => (await before.state("bot:a")).kind === "running", { what: "the first turn" });
  const routine = await before.send("bot:a", {
    text: "daily digest",
    requestId: "routine:task-1:2026-10-07T09:00:00.000Z",
    ifNotInterrupted: true,
  });
  await before.shutdown();

  const offered: string[][] = [];
  const record = (text: string) => (context: { messages: readonly { role: string }[] }) => {
    offered.push(getCurrentTools(context.messages).map((tool) => tool.name));
    return fauxAssistantMessage(text);
  };
  const service = await serviceFor(profile, createFauxModels([record("first done"), record("routine done")]), {
    extension: assemblyDeps(state, { candidates: candidates(createBotQuestions()) }),
  });
  try {
    await service.initialize();
    assert.equal((await service.state("bot:a")).kind, "interrupted");
    await service.resume("bot:a", "resume-1");
    assert.deepEqual(await service.awaitReply("bot:a", routine.submissionId, new AbortController().signal), {
      kind: "completed",
      text: "routine done",
    });
    assert.ok(offered[0]!.includes(QUESTION_TOOL_NAME), "the resumed desktop turn offers questions");
    assert.equal(offered[1]!.includes(QUESTION_TOOL_NAME), false, "the queued routine still offers none");
  } finally {
    await service.shutdown();
  }
});

test("delete erases the Bot's memory even when its session never opened", async () => {
  const profile = tempProfile();
  const memoryDir = path.join(profile, "bots", botDirectoryName("bot:a"), "memory");
  mkdirSync(memoryDir, { recursive: true });
  writeFileSync(path.join(memoryDir, "USER.md"), "Prefers short answers.");
  const memory = createBotMemoryService({ store: createBotMemoryStore({ profileDir: profile }) });
  const service = await serviceFor(profile, createFauxModels([]), {
    deleteEffects: [async (botId) => memory.forgetBot(botId)],
  });
  try {
    await service.deleteBot("bot:a");
    assert.equal(existsSync(memoryDir), false);
    const view = await memory.view("bot:a");
    assert.deepEqual([view.user.entries, view.updatedAt], [[], null]);
    await assert.rejects(memory.apply("bot:a", "user", [{ action: "add", content: "Has a dog." }]));
    assert.equal(existsSync(memoryDir), false, "nothing writes it back");
  } finally {
    await service.shutdown();
  }
});

test("an open session keeps its memory snapshot; reopening after the idle close re-reads it", async () => {
  const profile = tempProfile();
  const memoryDir = path.join(profile, "bots", botDirectoryName("bot:a"), "memory");
  const memory = createBotMemoryService({ store: createBotMemoryStore({ profileDir: profile }) });
  const sections: string[] = [];
  const record = (context: { messages: Message[] }) => {
    sections.push(getCurrentSystemPrompt(context.messages) ?? "");
    return fauxAssistantMessage("ok");
  };
  const fauxModels = createFauxModels([record, record, record]);
  const service = await serviceFor(profile, fauxModels, {
    idleCloseMs: 50,
    onSessionOpen: (botId) => memory.beginSession(botId),
    extension: {
      ...recordingDeps(),
      memorySection: async (botId, offer) => renderBotMemorySection(await memory.snapshot(botId), offer),
    },
  });
  const turn = async (requestId: string) => {
    const sent = await service.send("bot:a", { text: "hi", requestId });
    await service.awaitReply("bot:a", sent.submissionId, new AbortController().signal);
  };
  try {
    mkdirSync(memoryDir, { recursive: true });
    writeFileSync(path.join(memoryDir, "USER.md"), "Prefers short answers.");
    await turn("desk-1");
    // Written outside the Bot's tool (by the shell, say) while the session is open.
    writeFileSync(path.join(memoryDir, "USER.md"), "Prefers short answers.\n§\nHas a dog.");
    await turn("desk-2");
    assert.ok(sections[0]!.includes("Prefers short answers."));
    assert.ok(!sections[1]!.includes("Has a dog."), "the open session's snapshot is frozen");
    await new Promise((resolve) => setTimeout(resolve, 300));
    await turn("desk-3");
    assert.ok(sections[2]!.includes("Has a dog."), "the reopened session reads current memory");
  } finally {
    await service.shutdown();
  }
});

test('Bot message inputs persist host provenance and are quiet', async () => {
  let release:()=>void=()=>undefined;
  const gate=new Promise<void>(r=>{release=r;});
  const hold=countingTool('hold',async()=>{await gate;return 'done';});
  const service = await serviceFor(tempProfile(), createFauxModels([fauxAssistantMessage([fauxToolCall('hold',{text:'x'})],{stopReason:'toolUse'}),fauxAssistantMessage('answer')]),{extension:recordingDeps({tools:[{tool:hold,replay:'unsafe'}]})});
  const deliveryId = '00112233-4455-4677-8899-aabbccddeeff';
  const input = {text:'framed', requestId:`bot:J:1:${deliveryId}`, ifIdle:true, ifNotInterrupted:true,
    botMessage:{kind:'request' as const, deliveryId, botId:'J', botName:'Jester',text:'clean',deadline:Date.now()+60_000}};
  try {
    const sent = await service.send('bot:a',input);
    assert.equal((await service.quietInputs('bot:a',[sent.submissionId])).get(sent.submissionId),true);
    assert.equal((await service.placedSubmissions('bot:a')).size,0);
    release();await service.awaitReply('bot:a',sent.submissionId,new AbortController().signal);
    const entries = (await (await service.conversation('bot:a')).context(ctx)).entries;
    const entry = entries.find(e=>e.kind === 'aiden.bot-message-input');
    assert.equal((entry?.data as {deadline:number}).deadline,input.botMessage.deadline);
    assert.deepEqual(await notices(service,'bot:a'),[{notice:'bot_message',requestId:input.requestId,...input.botMessage}]);
    await assert.rejects(service.send('bot:a',{...input,requestId:'invalid',label:'routine'}),TypeError);
  } finally {release();await service.shutdown();}
});

test('idle-only Bot delivery cannot queue behind person work', async () => {
  let release:()=>void=()=>undefined;
  const gate=new Promise<void>(r=>{release=r;});
  const hold=countingTool('hold',async()=>{await gate;return 'done';});
  const service = await serviceFor(tempProfile(),createFauxModels([fauxAssistantMessage([fauxToolCall('hold',{text:'x'})],{stopReason:'toolUse'}),fauxAssistantMessage('person answer'),fauxAssistantMessage('bot answer')]),{extension:recordingDeps({tools:[{tool:hold,replay:'unsafe'}]})});
  try {
    const person = await service.send('bot:a',{text:'person',requestId:'person'});
    const input = {text:'bot',requestId:'bot:J:1:00112233-4455-4677-8899-aabbccddeeff',ifIdle:true,ifNotInterrupted:true,botMessage:{kind:'request' as const,botId:'J',botName:'J',text:'bot',deliveryId:'00112233-4455-4677-8899-aabbccddeeff',deadline:Date.now()+60_000}};
    await assert.rejects(service.send('bot:a',input),(e:unknown)=>e instanceof BotSessionError && e.reason === 'bot_busy');
    assert.equal(await service.submissionForRequest('bot:a',input.requestId),undefined);
    release();await service.awaitReply('bot:a',person.submissionId,new AbortController().signal);
    const sent = await service.send('bot:a',input);
    assert.deepEqual(await service.send('bot:a',input),{...sent,deduped:true});
  } finally {release();await service.shutdown();}
});

test('simultaneous cross-message tools remain host-free through pause, delete and shutdown', {timeout:15_000}, async () => {
 const {createBotMessageLedger}=await import('../bot-messages/ledger.js');
 const {createBotMessageCourier}=await import('../bot-messages/courier.js');
 const {messageBotCandidate}=await import('../bot-messages/candidate.js');
 const {createBotApprovals}=await import('./bot-approvals.js');
 const profile=tempProfile();
 const ledger=createBotMessageLedger({file:()=>path.join(profile,'bots','bot-messages.json'),now:Date.now});
 let count=0,release:()=>void=()=>undefined;
 const gate=new Promise<void>(r=>{release=r;});
 const listeners=new Set<(id:string)=>void>();
 const roster=['bot:a','bot:b'].map(id=>({id,name:id,purpose:'help',acceptsMessages:true,sendsMessages:true}));
 const faux=createFauxModels(Array.from({length:8},()=>context=>{
  const last=context.messages[context.messages.length-1];
  return last?.role==='toolResult'?fauxAssistantMessage('Done'):fauxAssistantMessage([fauxToolCall('message_bot',{bot:(getCurrentSystemPrompt(context.messages)??'').includes('bot:a')?'bot:b':'bot:a',message:'Help'})],{stopReason:'toolUse'});
 }));
 let service:BotSessionRuntime;
 const courier=createBotMessageCourier({ledger,sessions:{send:(...a)=>service.send(...a),awaitReply:(...a)=>service.awaitReply(...a),markSilent:(...a)=>service.markSilent(...a),appendEntry:(...a)=>service.appendEntry(...a),state:(...a)=>service.state(...a),submissionForRequest:(...a)=>service.submissionForRequest(...a)},roster:async()=>roster,enabled:async()=>true,approvals:createBotApprovals({publish:()=>undefined}),onStateChange:fn=>{listeners.add(fn);return ()=>void listeners.delete(fn);},now:Date.now,setTimer:(fn,ms)=>{const timer=setTimeout(fn,ms);return {cancel:()=>clearTimeout(timer)};}});
 service=await serviceFor(profile,faux,{knownBotIds:async()=>new Set(roster.map(b=>b.id)),extension:{...recordingDeps(),systemSections:async bot=>[bot.id],currentTools:async bot=>[{...await messageBotCandidate(bot.id,{roster:async()=>roster,post:async input=>{const result=await courier.post(input);assert.equal(result.status,'sent');count++;await gate;return result;}}),replay:'safe'}]},deleteEffects:[id=>courier.forgetBot(id)],onStateChange:id=>{for(const listener of listeners)listener(id);}});
 try {
  await courier.start();await Promise.all(['bot:a','bot:b'].map(id=>service.send(id,{text:'ask the peer',requestId:`person-${id}`})));
  await waitFor(()=>count===2,{what:'both host-free tool acceptances'});
  const pause=service.pause('bot:a','mac');const deletion=service.deleteBot('bot:b');release();
  await Promise.all([pause,deletion]);
  await courier.dispose();await service.shutdown();
  assert.equal((await ledger.open()).filter(r=>r.fromBotId==='bot:b'||r.toBotId==='bot:b').length,0);
 } finally {release();await courier.dispose();await service.shutdown();}
});

test('courier expiry leaves a busy real harness and queued human follow-ups intact',async()=>{
 const {createBotMessageLedger}=await import('../bot-messages/ledger.js');
 const {createBotMessageCourier}=await import('../bot-messages/courier.js');
 const {createBotApprovals}=await import('./bot-approvals.js');
 let release:()=>void=()=>undefined;
 const gate=new Promise<void>(r=>{release=r;});const hold=countingTool('hold',async()=>{await gate;return 'done';});
 const profile=tempProfile();let now=Date.now();
 const service=await serviceFor(profile,createFauxModels([fauxAssistantMessage([fauxToolCall('hold',{text:'x'})],{stopReason:'toolUse'}),fauxAssistantMessage('first human answer'),fauxAssistantMessage('queued human answer')]),{knownBotIds:async()=>new Set(['bot:a','bot:b']),extension:recordingDeps({tools:[{tool:hold,replay:'unsafe'}]})});
 const ledger=createBotMessageLedger({file:()=>path.join(profile,'bots','bot-messages.json'),now:()=>now});
 const deadlines:Array<()=>void>=[];
 const courier=createBotMessageCourier({ledger,sessions:service,roster:async()=>['bot:a','bot:b'].map(id=>({id,name:id,purpose:'help',acceptsMessages:true,sendsMessages:true})),enabled:async()=>true,approvals:createBotApprovals({publish:()=>undefined}),onStateChange:()=>()=>undefined,now:()=>now,setTimer:(fn,ms)=>{if(ms===0){const timer=setTimeout(fn,0);return {cancel:()=>clearTimeout(timer)};}deadlines.push(fn);return {cancel:()=>undefined};}});
 try {
  const first=await service.send('bot:b',{text:'human work',requestId:'human-first'});
  const queued=await service.send('bot:b',{text:'queued human',requestId:'human-second',whenBusy:'followUp'});
  await courier.start();const accepted=await courier.post({fromBotId:'bot:a',target:'bot:b',message:'help',deliveryId:'00112233-4455-4677-8899-aabbccddeeff',runRequestIds:['human-origin']});
  assert.equal(accepted.status,'sent');await waitFor(()=>deadlines.length===1);
  now+=1_800_001;deadlines[0]!();
  await waitFor(async()=>((await (await service.conversation('bot:a')).context(ctx)).entries.some(e=>e.kind==='aiden.bot-message-status')));
  assert.equal(await service.submissionForRequest('bot:b','bot:bot:a:1:00112233-4455-4677-8899-aabbccddeeff'),undefined);
  assert.equal((await service.state('bot:b')).kind,'running');
  release();const answers=await Promise.all([first,queued].map(s=>service.awaitReply('bot:b',s.submissionId,new AbortController().signal)));
  assert.deepEqual(answers,[{kind:'completed',text:'first human answer'},{kind:'completed',text:'queued human answer'}]);
 } finally {release();await courier.dispose();await service.shutdown();}
});


test("issue status append remains one durable entry across marker failures and service/runtime restart", async () => {
  const profile = tempProfile();
  const faux = createFauxModels([]);
  let runtime = await serviceFor(profile, faux);
  let markerFails = true;
  let failures = 0;
  const makeIssues = () => {
    const disk = createBotIssueStore({ profileDir: () => profile });
    const store: BotIssueStore = {
      read: id => disk.read(id),
      forgetBot: id => disk.forgetBot(id),
      change: (id, apply) => disk.change(id, rows => {
        const changed = apply(rows);
        if (markerFails && changed.issues.some(row => row.statusAppended === true && rows.find(old => old.id === row.id)?.statusAppended === false)) throw new Error("marker disk busy");
        return changed;
      }),
    };
    return { disk, issues: createBotIssueService({
      store, now: () => 2000,
      appendEntry: async (id, kind, data) => { await runtime.appendEntry(id, kind, data as import("@earendil-works/chord").JsonValue); },
      onError: () => { failures++; },
      funnel: { deliver: async () => "sent" },
      actions: { resumeRoutine: async () => "missing", stopRun: async () => {}, snoozeStall() {}, openSettings() {} },
    }) };
  };
  const statuses = async () => (await (await runtime.conversation("bot:a")).context(ctx)).entries.filter(entry => entry.kind === BOT_ISSUE_STATUS_ENTRY_KIND);
  try {
    let app = makeIssues();
    const issue = await app.issues.raise({ botId: "bot:a", kind: "access_needed", dedupeKey: "access:taxes", title: "Needs you", body: "Waiting", actions: [{ kind: "dismiss_access" }],
      access: { label: "Taxes", folderPath: "/Taxes", authorization: { policyRevision: "private-policy", requestIds: ["private-run"], target: "folder", root: "/Taxes", identity: { device: "1", inode: "2" }, choices: ["not_now", "always", "once"] } },
    });
    await assert.rejects(app.issues.act("bot:a", issue.id, { kind: "dismiss_access" }), /marker disk busy/u);
    assert.equal((await statuses()).length, 1, "the append committed before the marker failed");
    assert.equal((await app.disk.read("bot:a"))[0]!.statusAppended, false);
    for (let attempt = 0; attempt < 2; attempt++) {
      const before = failures;
      assert.deepEqual(await app.issues.list("bot:a", { open: true }), []);
      await waitFor(() => failures > before);
      assert.equal((await statuses()).length, 1, "read retries must reuse the committed effect");
    }
    await runtime.shutdown();
    runtime = await serviceFor(profile, faux);
    app = makeIssues();
    const before = failures;
    await app.issues.list("bot:a");
    await waitFor(() => failures > before);
    assert.equal((await statuses()).length, 1, "a fresh issue service and reopened SQLite session dedupe the same settlement");
    markerFails = false;
    await app.issues.list("bot:a");
    await waitFor(async () => (await app.disk.read("bot:a"))[0]!.statusAppended === true);
    const entries = await statuses();
    assert.equal(entries.length, 1);
    assert.deepEqual(botIssueStatusOf(entries[0]!.data), { issueId: issue.id, resolution: "dismissed", resolvedAt: 2000 });
    assert.deepEqual(Object.keys(entries[0]!.data as object).sort(), ["effectId", "issueId", "resolution", "resolvedAt"], "host metadata adds only dedupe identity, never private access authorization");
    assert.equal(faux.calls(), 0, "repairs never run inference");
  } finally { await runtime.shutdown(); }
});


test("stop calls onStopped after aborting the running tool and before publishing settled state", async () => {
  const order: string[] = [];
  const hold = countingTool("hold", async (_params, signal) => {
    signal!.addEventListener("abort", () => order.push("aborted"), { once: true });
    return blockingUntilAborted(signal);
  });
  const service = await serviceFor(tempProfile(), createFauxModels([fauxAssistantMessage([fauxToolCall("hold", { text: "wait" })], { stopReason: "toolUse" })]), {
    extension: recordingDeps({ tools: [{ tool: hold, replay: "unsafe" }] }),
    onStopped: (botId) => order.push(`stopped:${botId}`),
    onStateChange: (_botId, state) => { if (state.kind !== "running") order.push(`state:${state.kind}`); },
  });
  try {
    await service.stop("bot:a");
    assert.deepEqual(order, [], "idle Stop has no stop callback");
    await service.send("bot:a", { text: "Work", requestId: "desk-stop-plan" });
    await waitFor(() => hold.executions.length === 1, { what: "running tool" });
    order.length = 0;
    assert.deepEqual(await service.stop("bot:a"), { kind: "idle" });
    assert.deepEqual(order, ["aborted", "stopped:bot:a", "state:idle"]);
    await service.stop("bot:a");
    assert.deepEqual(order, ["aborted", "stopped:bot:a", "state:idle"]);
  } finally { await service.shutdown(); }
});

test("dismiss calls onStopped once after the interrupted turn settles, before publishing, and never on no-op or replay", async () => {
  const profile = tempProfile();
  const submissionId = await killMidStream(profile);
  const order: string[] = [];
  let inspected: Promise<unknown[]> | undefined;
  const service = await serviceFor(profile, createFauxModels([fauxAssistantMessage("must not run")]), {
    onStopped: (botId) => { order.push(`stopped:${botId}`); inspected = notices(service, botId); },
    onStateChange: (_botId, state) => { if (state.kind === "idle") order.push("state:idle"); },
  });
  try {
    await service.initialize();
    order.length = 0;
    await service.stop("bot:killed");
    assert.deepEqual(order, [], "Stop on interrupted is a no-op");
    assert.deepEqual(await service.dismiss("bot:killed", "dismiss-plan"), { kind: "idle" });
    assert.deepEqual(order, ["stopped:bot:killed", "state:idle"]);
    assert.deepEqual(await inspected, [{ notice: "interrupted", submissionId }], "dismissal is already durable at the hook");
    await service.dismiss("bot:killed", "dismiss-plan");
    await service.dismiss("bot:killed", "another-dismiss");
    assert.deepEqual(order, ["stopped:bot:killed", "state:idle"]);
  } finally { await service.shutdown(); }
});


function sessionPlanStore(profileDir: string) {
  const access = createBotRunAccess({ now: Date.now });
  const options = { profileDir, knownBot: async () => true, revalidate: async () => {}, revokeAccess: (botId: string, planId: string) => access.revokeOwner(botId, { kind: "plan", id: planId }) };
  const plans = createBotPlans(options);
  async function approve(botId: string, requestId: string) {
    const proposal: BotPlanProposal = { title: "Calendar job", why: "Finish the task", steps: ["Do the work", "Finish the task"], items: [{ id: "i1", kind: "shell" }], authorization: { policyRevision: "policy", bindingRevision: "binding", proposalFingerprint: "", rules: [] } };
    proposal.authorization.proposalFingerprint = botPlanProposalFingerprint(proposal);
    const result = plans.request({ botId, planId: "p1", toolCallId: "plan-call", proposal, requestIds: [requestId], signal: undefined });
    assert.equal((await plans.current(botId))?.status, "pending");
    assert.equal(await plans.respond(botId, "p1", "approve"), "done");
    assert.equal((await result).status, "approved");
    assert.equal(await plans.grantFreshAccess(botId, "p1", async () => {
      access.grant(botId, { requestIds: [requestId], target: "folder", key: "/Plan", root: "/Plan", label: "Plan folder", identity: { device: "1", inode: "2" }, policyRevision: "policy", access: "write", owner: { kind: "plan", id: "p1" }, grantedAt: Date.now(), expiresAt: Date.now() + 60_000 });
    }), true);
    access.grant(botId, { requestIds: ["other-task"], target: "folder", key: "/Other", root: "/Other", label: "Other task", identity: { device: "1", inode: "3" }, policyRevision: "policy", access: "read", owner: { kind: "access", id: "other" }, grantedAt: Date.now(), expiresAt: Date.now() + 60_000 });
    assert.equal(access.location(botId, [requestId], "policy")?.root, "/Plan");
  }
  return { plans, access, approve, restart: () => createBotPlans(options) };
}

/** The main wiring is deliberately void: plan persistence never blocks the session serial. */
function sessionPlanCallbacks(plans: BotPlans) {
  const pending: Promise<void>[] = [];
  const lifecycle = createBotPlanLifecycle({ plans: { endRuns: (botId, reason) => {
    const operation = plans.endRuns(botId, reason); pending.push(operation); return operation;
  } } });
  return {
    callbacks: {
      onStopped: lifecycle.stopped,
      onStateChange: lifecycle.stateChanged,
    },
    onRunSettled: lifecycle.settled,
    async settled() { await Promise.all(pending); },
  };
}

test("real Stop ends a live plan and revokes only its grant before subsequent use", async () => {
  const profile = tempProfile();
  const store = sessionPlanStore(profile);
  const hooks = sessionPlanCallbacks(store.plans);
  const hold = countingTool("hold", (_params, signal) => blockingUntilAborted(signal));
  const service = await serviceFor(profile, createFauxModels([fauxAssistantMessage([fauxToolCall("hold", { text: "wait" })], { stopReason: "toolUse" })]), { extension: recordingDeps({ tools: [{ tool: hold, replay: "unsafe" }] }), ...hooks.callbacks });
  try {
    await service.send("bot:a", { text: "Work", requestId: "desk-plan-run" });
    await waitFor(() => hold.executions.length === 1, { what: "running tool" });
    await store.approve("bot:a", "desk-plan-run");
    await service.stop("bot:a");
    await hooks.settled();
    assert.equal((await store.plans.current("bot:a"))?.status, "stopped");
    assert.equal(store.access.location("bot:a", ["desk-plan-run"], "policy"), undefined);
    assert.equal(store.access.location("bot:a", ["other-task"], "policy")?.root, "/Other");
  } finally { await service.shutdown(); }
});

test("recovered unfinished approval survives observation, Dismiss ends it and revokes its own grant", async () => {
  const profile = tempProfile();
  const submissionId = await killMidStream(profile);
  const store = sessionPlanStore(profile);
  await store.approve("bot:killed", "req-killed");
  const restored = store.restart();
  const hooks = sessionPlanCallbacks(restored);
  const models = createFauxModels([fauxAssistantMessage("must not run")]);
  const service = await serviceFor(profile, models, hooks.callbacks);
  try {
    assert.deepEqual(await service.state("bot:killed"), { kind: "idle" }, "initial state precedes unfinished-run recovery");
    assert.equal((await restored.current("bot:killed"))?.status, "active");
    await service.initialize();
    assert.deepEqual(await service.state("bot:killed"), { kind: "interrupted", submissionId });
    await hooks.settled();
    assert.equal((await restored.current("bot:killed"))?.status, "active", "opening and initial observations do not finish recovered approval");
    await service.stop("bot:killed");
    assert.equal((await restored.current("bot:killed"))?.status, "active", "idle/interrupted Stop is a no-op");
    await service.dismiss("bot:killed", "dismiss-plan-lifecycle");
    await hooks.settled();
    assert.equal((await restored.current("bot:killed"))?.status, "stopped");
    assert.equal(store.access.location("bot:killed", ["req-killed"], "policy"), undefined);
    assert.equal(store.access.location("bot:killed", ["other-task"], "policy")?.root, "/Other");
    assert.equal(models.calls(), 0);
  } finally { await service.shutdown(); }
});

test("natural completion ends a real plan after a running observation and revokes its grant", async () => {
  const profile = tempProfile();
  const store = sessionPlanStore(profile);
  const hooks = sessionPlanCallbacks(store.plans);
  let finish!: (value: string) => void;
  const held = new Promise<string>((resolve) => { finish = resolve; });
  const hold = countingTool("hold", () => held);
  const models = createFauxModels([fauxAssistantMessage([fauxToolCall("hold", { text: "wait" })], { stopReason: "toolUse" }), fauxAssistantMessage("Done")]);
  let projection: BotLiveProjection | undefined;
  const service = await serviceFor(profile, models, { extension: recordingDeps({ tools: [{ tool: hold, replay: "unsafe" }] }), ...hooks.callbacks,
    onStateChange: (botId, state) => { hooks.callbacks.onStateChange(botId, state); projection?.notifyState(botId, state); },
  });
  projection = createBotLiveProjection({ conversation: (id) => service.conversation(id), state: (id) => service.state(id), quietInputs: (id, ids) => service.quietInputs(id, ids), plan: (id) => store.plans.current(id), onRunSettled: hooks.onRunSettled });
  try {
    const sent = await service.send("bot:a", { text: "Work", requestId: "desk-plan-complete" });
    await waitFor(() => hold.executions.length === 1, { what: "running tool" });
    await store.approve("bot:a", "desk-plan-complete");
    const events: import("../../../renderer/shared/bot-live.js").BotLiveEvent[] = [];
    const subscription = await projection.subscribe("bot:a", { send: (event) => { events.push(event); } });
    assert.equal(subscription.snapshot.plan?.status, "active");
    for (const privateKey of ["authorization", "requestIds", "proposal", "toolCallId", "policyRevision", "bindingRevision", "proposalFingerprint"]) {
      assert.equal(privateKey in subscription.snapshot.plan!, false, `${privateKey} stays main-only`);
    }
    await projection.refreshPlan("bot:a");
    await store.plans.markStep("bot:a", ["desk-plan-complete"], 1, "done");
    await projection.refreshPlan("bot:a");
    await waitFor(() => events.some((event) => event.type === "plan"), { what: "real public plan event" });
    const planEvent = events.find((event) => event.type === "plan")!;
    assert.equal(JSON.stringify(planEvent).includes("desk-plan-complete"), false, "raw request identity never enters the plan event");
    finish("Finished the work");
    assert.equal((await service.awaitReply("bot:a", sent.submissionId, new AbortController().signal)).kind, "completed");
    await waitFor(async () => (await store.plans.current("bot:a"))?.status === "finished", { what: "projection observes natural completion and ends the plan" });
    await hooks.settled();
    assert.equal((await store.plans.current("bot:a"))?.status, "finished");
    assert.equal(store.access.location("bot:a", ["desk-plan-complete"], "policy"), undefined);
    assert.equal(store.access.location("bot:a", ["other-task"], "policy")?.root, "/Other");
  } finally { await projection.close(); await service.shutdown(); }
});
