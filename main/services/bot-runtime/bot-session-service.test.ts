import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getCurrentSystemPrompt, getCurrentTools, type Message } from "@earendil-works/pi-ai";
import { renderBotMemorySection } from "../bot-memory/prompt.js";
import { createBotMemoryService } from "../bot-memory/service.js";
import { createBotMemoryStore } from "../bot-memory/store.js";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { ToolResultEntry, type ModelRef } from "@earendil-works/pi-durable";
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
import { botDirectoryName } from "./harness-host.js";
import { spawnHarnessChild } from "./test-support/child.js";
import { assemblyDeps, assemblyState, FULL_GRANTS, testAuthority } from "./test-support/assembly-fixtures.js";
import { blockingUntilAborted, countingTool, recordingDeps } from "./test-support/fixtures.js";
import { QUESTION_ARGS, QUESTION_TOOL_NAME } from "./test-support/question-fixtures.js";
import { createFauxModels, FAUX_MODEL_REF, slowAnswer, waitFor, type FauxModels } from "./test-support/faux.js";

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
    const first = await service.send("bot:a", { text: "hello", requestId: "desk-1" });
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
