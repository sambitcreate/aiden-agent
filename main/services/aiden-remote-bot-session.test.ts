import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { BotMemoryEditInput, BotMemoryEditResult, BotMemoryView } from "../../renderer/shared/bot-memory.js";
import type { BotRoutineProposalRespondInput } from "../../renderer/shared/bot-routine-proposals.js";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import test, { after } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { BOT_ACTIVITY_PHASES } from "../../renderer/shared/bot-activity.js";
import { BOT_PRESETS } from "../../renderer/shared/bot-presets.js";
import type { BotDefinition } from "../../renderer/shared/bots.js";
import { AidenRemoteBotService } from "./aiden-remote-bots.js";
import {
  AidenRemoteBotSessionService,
  projectAidenRemoteBotMemory,
  projectBotSessionActivity,
  projectBotSessionEntries,
  projectBotSessionState,
  redactRemoteError,
  type AidenRemoteBotSessionRuntime,
} from "./aiden-remote-bot-session.js";
import type { AskUserQuestionV1 } from "../../renderer/shared/ask-user-question.js";
import { createBotApprovals } from "./bot-runtime/bot-approvals.js";
import { createBotQuestions } from "./bot-runtime/bot-questions.js";
import { createBotTurnIntents } from "./bot-runtime/bot-turn-intents.js";
import { createBotLiveProjection, createBotRunStarts } from "./bot-runtime/live-projection.js";
import {
  AIDEN_REMOTE_BOT_SESSION_MAX_ENTRIES,
  parseAidenRemoteBotSession,
  parseAidenRemoteBotSessionEntry,
  parseAidenRemoteBotSessionEvent,
} from "./aiden-remote-protocol.js";
import {
  BOT_NOTICE_ENTRY_KIND,
  createBotSessionService,
  type BotSessionState,
} from "./bot-runtime/bot-session-service.js";
import { createBotStarter } from "./bot-runtime/bot-starter.js";
import { spawnHarnessChild } from "./bot-runtime/test-support/child.js";
import { createFauxModels, FAUX_MODEL_REF, waitFor } from "./bot-runtime/test-support/faux.js";
import { countingTool, recordingDeps } from "./bot-runtime/test-support/fixtures.js";
import { BOT_ROUTINE_SILENT_INSTRUCTION, type BotRoutine } from "./scheduled-bot-routines.js";
import { botMemoryDirectory, botMemoryFile } from "./bot-memory/files.js";
import { createBotMemoryStore, memoryView as memoryStoreView } from "./bot-memory/store.js";

const BOT_ID = "bot_session_1";
const DEVICE_ID = "device_1";
const RESUME_KEY = "resume-request-0001";

function bot(id = BOT_ID): BotDefinition {
  return {
    id,
    revision: "bot_revision_1",
    name: "Planner",
    instructions: "Plan carefully.",
    avatar: { version: 1, shape: "orb", color: "sky" },
    createdAt: 1_000,
    updatedAt: 2_000,
  };
}

/** A Bot store with one live Bot and no other side effects. */
function botService(options: { sessionStates?: Map<string, "needs_model" | "idle"> } = {}) {
  const application = {
    async get(botId: string) {
      return botId === BOT_ID ? bot() : null;
    },
    async list() {
      return [bot()];
    },
  };
  return new AidenRemoteBotService({
    application: application as never,
    chatStore: { get: async () => null },
    sessionStates: async (ids) => new Map(
      ids.flatMap((id) => (options.sessionStates?.has(id) ? [[id, options.sessionStates.get(id)!] as const] : [])),
    ),
  });
}

/** A fake durable runtime: one interrupted turn that a Resume continues. */
function fakeRuntime(initial: BotSessionState) {
  let state: BotSessionState = initial;
  const calls = { resume: 0, abort: 0, dismiss: 0 };
  let closeWatch: () => void = () => {};
  const conversation = {
    async watch() {
      let resolveClosed!: () => void;
      const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
      closeWatch = () => resolveClosed();
      return {
        value: { entries: [], docs: {} },
        start() {},
        stop: async () => {},
        closed,
      };
    },
    async abort() {
      calls.abort += 1;
    },
  };
  const runtime: AidenRemoteBotSessionRuntime = {
    async send() {
      return { submissionId: "sub_1", deduped: false };
    },
    async resume() {
      calls.resume += 1;
      if (state.kind === "interrupted") state = { kind: "running", submissionId: state.submissionId };
      return state;
    },
    async dismiss() {
      calls.dismiss += 1;
      state = { kind: "idle" };
      return state;
    },
    async stop() {
      if (state.kind === "running") {
        calls.abort += 1;
        state = { kind: "idle" };
      }
      return state;
    },
    async state() {
      return state;
    },
    async conversation() {
      return conversation as never;
    },
    async quietInputs(_botId, ids) {
      // Every queued input is the person's own unless a test says otherwise.
      return new Map(ids.map((id) => [id, false]));
    },
    async placedSubmissions() {
      return new Map();
    },
  };
  return {
    runtime,
    calls,
    closeWatch: () => closeWatch(),
    setState(next: BotSessionState) {
      state = next;
    },
  };
}

function sessionService(runtime: AidenRemoteBotSessionRuntime, bots = botService()) {
  return new AidenRemoteBotSessionService({
    bots,
    runtime: async () => runtime,
    presets: {
      list: () => [],
      create: async () => ({ botId: BOT_ID, created: true }),
    },
    notifyBotsChanged: () => {},
    projectorIdleMs: 60_000,
  });
}

test("a second Resume with the same request key is a no-op that returns the current state", async () => {
  const fake = fakeRuntime({ kind: "interrupted", submissionId: "sub_1" });
  const service = sessionService(fake.runtime);

  const first = await service.resume(DEVICE_ID, BOT_ID, RESUME_KEY, {});
  const second = await service.resume(DEVICE_ID, BOT_ID, RESUME_KEY, {});

  assert.deepEqual(first, { state: "running", interrupted: false });
  assert.deepEqual(second, first);
  assert.equal(fake.calls.resume, 1, "the provider-facing resume runs once");
  await service.close();
});

test("a Resume after the turn already resumed reads the current state without a second resume", async () => {
  const fake = fakeRuntime({ kind: "interrupted", submissionId: "sub_1" });
  const service = sessionService(fake.runtime);

  await service.resume(DEVICE_ID, BOT_ID, RESUME_KEY, {});
  const replayedAfterRestart = await service.resume(DEVICE_ID, BOT_ID, "resume-request-0002", {});

  assert.equal(replayedAfterRestart.state, "running");
  assert.equal(fake.calls.resume, 2, "a new request key is a new request");
  await service.close();
});

test("a Bot without a model reports needs_model on its session and preset summaries", async () => {
  const fake = fakeRuntime({ kind: "needs_model" });
  const bots = botService({ sessionStates: new Map([[BOT_ID, "needs_model"]]) });
  const service = sessionService(fake.runtime, bots);

  const session = await service.session(BOT_ID);
  assert.equal(session.state, "needs_model");
  assert.equal(session.interrupted, false);
  assert.deepEqual(session.entries, []);

  const summary = await bots.summaryOf(BOT_ID);
  assert.equal(summary.sessionState, "needs_model");
  await service.close();
});

test("a model error that blocks a turn is reported as unavailable, not as an unknown state", () => {
  assert.deepEqual(
    projectBotSessionState({ kind: "model_error", message: "Sign in to the provider." }),
    { state: "unavailable", interrupted: false },
  );
  assert.deepEqual(
    projectBotSessionState({ kind: "interrupted", submissionId: "sub_1", blocked: "access_changed" }),
    { state: "interrupted", interrupted: true, blocked: "access_changed" },
  );
});

test("Stop ends a running turn but leaves an interrupted one for Dismiss", async () => {
  const running = fakeRuntime({ kind: "running", submissionId: "sub_1" });
  await sessionService(running.runtime).stop(DEVICE_ID, BOT_ID, "stop-request-0001", {});
  assert.equal(running.calls.abort, 1);

  const paused = fakeRuntime({ kind: "interrupted", submissionId: "sub_1" });
  const view = await sessionService(paused.runtime).stop(DEVICE_ID, BOT_ID, "stop-request-0002", {});
  assert.equal(paused.calls.abort, 0, "a paused turn is not aborted by Stop");
  assert.equal(view.state, "interrupted");
});

test("a phone's Stop reads Stopping wherever the Bot is open, a Stop that fails takes it back, and Resume is the runtime's to announce", async () => {
  const fake = fakeRuntime({ kind: "running", submissionId: "sub_1" });
  let refuse = false;
  const intents = createBotTurnIntents();
  const heard: string[] = [];
  intents.onIntent((botId, intent) => void heard.push(`${intent} ${botId}`));
  const service = new AidenRemoteBotSessionService({
    bots: botService(),
    runtime: async () => ({
      ...fake.runtime,
      async stop(botId: string) {
        if (refuse) throw new Error("The Bot is held by another Aiden.");
        return fake.runtime.stop(botId);
      },
    }),
    turnIntents: intents,
  });
  try {
    assert.equal((await service.stop(DEVICE_ID, BOT_ID, "stop-request-0101", {})).state, "idle");
    assert.deepEqual(heard, [`stopping ${BOT_ID}`]);
    await service.stop(DEVICE_ID, BOT_ID, "stop-request-0101", {});
    assert.deepEqual(heard, [`stopping ${BOT_ID}`], "a replayed request is not a second press");

    fake.setState({ kind: "running", submissionId: "sub_2" });
    refuse = true;
    await assert.rejects(service.stop(DEVICE_ID, BOT_ID, "stop-request-0102", {}));
    assert.deepEqual(heard.slice(1), [`stopping ${BOT_ID}`, `stopCancelled ${BOT_ID}`]);

    // The session announces a Resume it carried out (`onResumed`); the route never guesses ahead of it.
    fake.setState({ kind: "interrupted", submissionId: "sub_2" });
    assert.equal((await service.resume(DEVICE_ID, BOT_ID, RESUME_KEY, {})).state, "running");
    assert.equal(heard.length, 3);
  } finally {
    await service.close();
  }
});

test("a session reopened on the host gets a new epoch, so clients refetch instead of folding", async () => {
  const fake = fakeRuntime({ kind: "idle" });
  const service = sessionService(fake.runtime);

  const before = await service.session(BOT_ID);
  fake.closeWatch();
  await new Promise((resolve) => setImmediate(resolve));
  const after = await service.session(BOT_ID);

  assert.notEqual(after.epoch, before.epoch);
  assert.equal(after.seq, 0);
  await service.close();
});

const WAIT_ID = "5f0c1a2e-7b3d-4e9a-8c61-0d2e3f4a5b6c";
const COLOUR: AskUserQuestionV1[] = [
  {
    question: "Which colour should the banner use?",
    header: "Colour",
    multiSelect: false,
    options: [
      { label: "Blue", description: "Calm and cool." },
      { label: "Red", description: "Loud and warm." },
    ],
  },
];
const option = (answer: string) => ({ cancelled: false, answers: [{ questionIndex: 0, kind: "option" as const, answer }] });

function questionSession(runtime: AidenRemoteBotSessionRuntime) {
  const questions = createBotQuestions();
  const service = new AidenRemoteBotSessionService({
    bots: botService(),
    runtime: async () => runtime,
    questions,
    notifyBotsChanged: () => {},
    projectorIdleMs: 60_000,
  });
  const ask = (signal?: AbortSignal) => {
    const asked = questions.request({ botId: BOT_ID, waitId: WAIT_ID, toolCallId: "call_1", questions: COLOUR, signal });
    asked.catch(() => undefined);
    return asked;
  };
  return { questions, service, ask };
}

const isError = (code: string, status: number) => (error: { code?: string; status?: number }) =>
  error.code === code && error.status === status;

test("a question asked and settled while a client watches moves the session forward with it", async () => {
  const { service, ask, questions } = questionSession(fakeRuntime({ kind: "running", submissionId: "sub_1" }).runtime);
  const before = await service.session(BOT_ID);
  assert.equal(before.question, null);

  ask();
  const asked = await service.session(BOT_ID);
  assert.equal(asked.question?.waitId, WAIT_ID);
  assert.deepEqual(asked.question?.questions.map((item) => item.options.map((choice) => choice.label)), [["Blue", "Red"]]);
  assert.equal(asked.seq, before.seq + 1, "the question went out as one frame");

  assert.equal(questions.answer(BOT_ID, WAIT_ID, { version: 1, promptId: WAIT_ID, ...option("Red") }), "answered");
  const settled = await service.session(BOT_ID);
  assert.equal(settled.question, null);
  assert.equal(settled.seq, asked.seq + 1);
  await service.close();
});

test("answering is idempotent per request UUID, and a second device's answer is refused", async () => {
  const { service, ask } = questionSession(fakeRuntime({ kind: "running", submissionId: "sub_1" }).runtime);
  const asked = ask();
  const [phone, tablet] = await Promise.allSettled([
    service.answerQuestion(DEVICE_ID, BOT_ID, WAIT_ID, "answer-request-0001", option("Blue")),
    service.answerQuestion("device_2", BOT_ID, WAIT_ID, "answer-request-0002", option("Red")),
  ]);
  assert.deepEqual(phone, { status: "fulfilled", value: { waitId: WAIT_ID } });
  assert.equal(tablet.status, "rejected");
  assert.ok(isError("question_expired", 409)((tablet as PromiseRejectedResult).reason));
  assert.deepEqual((await asked).answers, option("Blue").answers, "the Bot gets the first answer only");

  assert.deepEqual(
    await service.answerQuestion(DEVICE_ID, BOT_ID, WAIT_ID, "answer-request-0001", option("Blue")),
    { waitId: WAIT_ID },
    "a retry with the same request UUID replays the receipt",
  );
  await assert.rejects(
    service.answerQuestion(DEVICE_ID, BOT_ID, WAIT_ID, "answer-request-0001", option("Red")),
    "the same request UUID with another answer is not a replay",
  );
  await service.close();
});

test("an answer after the question was withdrawn is refused and records nothing", async () => {
  const { service, ask, questions } = questionSession(fakeRuntime({ kind: "running", submissionId: "sub_1" }).runtime);
  const controller = new AbortController();
  const asked = ask(controller.signal);
  controller.abort(); // Stop, Dismiss, delete or quit
  await assert.rejects(asked);
  await assert.rejects(
    service.answerQuestion(DEVICE_ID, BOT_ID, WAIT_ID, "answer-request-0004", option("Blue")),
    isError("question_expired", 409),
  );
  assert.deepEqual(questions.pending(), []);
  await service.close();
});

test("an answer the question does not accept is invalid and the question keeps waiting", async () => {
  const { service, ask } = questionSession(fakeRuntime({ kind: "running", submissionId: "sub_1" }).runtime);
  ask();
  for (const [key, body] of [
    ["answer-request-0005", option("Purple")],
    ["answer-request-0006", { cancelled: false, answers: [{ questionIndex: 3, kind: "option", answer: "Blue" }] }],
  ] as const) {
    await assert.rejects(service.answerQuestion(DEVICE_ID, BOT_ID, WAIT_ID, key, body), isError("invalid_request", 400));
  }
  await assert.rejects(
    service.answerQuestion(DEVICE_ID, BOT_ID, WAIT_ID, "answer-request-0007", { cancelled: false, answers: [], extra: 1 }),
    isError("invalid_request", 400),
    "a malformed body",
  );
  await assert.rejects(
    service.answerQuestion(DEVICE_ID, "bot_missing", WAIT_ID, "answer-request-0008", option("Blue")),
    "an unknown Bot",
  );
  assert.equal((await service.session(BOT_ID)).question?.waitId, WAIT_ID);
  await service.close();
});

test("an answered question reads as the person's message; a stopped one shows nothing", () => {
  const entries = projectBotSessionEntries([
    {
      id: 7,
      kind: "pi.tool-result",
      model: [{
        role: "toolResult",
        toolName: "ask_user_question",
        isError: false,
        content: [{ type: "text", text: "1. Which colour should the banner use?\nAnswer: Blue" }],
        details: { answerText: "Blue" },
      }],
    },
    {
      id: 8,
      kind: "pi.tool-result",
      model: [{ role: "toolResult", toolName: "ask_user_question", isError: true, content: [{ type: "text", text: "aborted" }] }],
    },
  ] as never);
  assert.deepEqual(entries, [{ type: "message", id: "entry_7", role: "user", text: "Blue" }]);
});

// ---------------------------------------------------------------------------
// Projection parity, live stream, and edge cases
// ---------------------------------------------------------------------------

type RawEntry = { id: number; kind: string; model?: unknown[]; data?: unknown };
const user = (id: number, text: string): RawEntry => ({
  id, kind: "pi.user", model: [{ role: "user", content: [{ type: "text", text }], timestamp: 1_700_000_000_000 }],
});
const assistant = (id: number, text: string, stopReason = "stop", content?: unknown[], errorMessage?: string): RawEntry => ({
  id,
  kind: "pi.assistant",
  model: [{
    role: "assistant",
    content: content ?? [{ type: "text", text }],
    stopReason,
    timestamp: 1_700_000_001_000,
    ...(errorMessage === undefined ? {} : { errorMessage }),
  }],
});
const notice = (id: number, data: unknown): RawEntry => ({ id, kind: BOT_NOTICE_ENTRY_KIND, data });
const card = (id: number, pluginId: string, status = "pending"): RawEntry => ({
  id, kind: "aiden.connect-card", data: { type: "connect_card", pluginId, reason: "I can read your mail.", status },
});

test("phones see what the Mac shows: no self-intro prompt, no [SILENT] turn, and a failed turn surfaces", () => {
  const entries = projectBotSessionEntries([
    notice(1, { notice: "hidden_input", requestId: "intro:bot" }),
    user(2, "Introduce yourself to me for the first time."),
    assistant(3, "Hi, I'm your Meal Planner."),
    notice(4, { notice: "routine", label: "Morning brief", requestId: "routine:t:1" }),
    user(5, `Check my inbox.\n\n${BOT_ROUTINE_SILENT_INSTRUCTION}`),
    assistant(6, "[SILENT]"),
    notice(7, { notice: "routine", label: "Weekly plan", requestId: "routine:t:2" }),
    user(8, `Plan the week.\n\n${BOT_ROUTINE_SILENT_INSTRUCTION}`),
    assistant(9, "", "toolUse", [{ type: "toolCall", id: "call_1", name: "read", arguments: {} }]),
    assistant(10, "Here's the plan."),
    user(11, "Thanks!"),
    assistant(12, "", "error", undefined, "429 from provider at /Users/sam/key"),
  ] as never);

  assert.deepEqual(
    entries.map((entry) => entry.type === "message" ? [entry.role, entry.text, entry.label ?? null] : [entry.type]),
    [
      ["assistant", "Hi, I'm your Meal Planner.", null],
      ["user", "Plan the week.", "Weekly plan"],
      ["assistant", "Here's the plan.", null],
      ["user", "Thanks!", null],
      ["failed_turn"],
    ],
  );
  // The failed turn carries the message Retry resends, and never the model's error.
  const failed = entries[entries.length - 1]!;
  assert.deepEqual(failed, {
    type: "failed_turn",
    id: "entry_12:failed",
    createdAt: new Date(1_700_000_001_000).toISOString(),
    retryText: "Thanks!",
  });
  assert.deepEqual(parseAidenRemoteBotSessionEntry(failed), failed);
});

test("a failed routine or self-intro turn has nothing to retry, and text written before the failure stays", () => {
  const entries = projectBotSessionEntries([
    notice(1, { notice: "routine", label: "Weekly plan", requestId: "routine:t:2" }),
    user(2, `Plan the week.\n\n${BOT_ROUTINE_SILENT_INSTRUCTION}`),
    assistant(3, "", "error"),
    user(4, "Try a shorter plan"),
    assistant(5, "Monday: soup", "error"),
  ] as never);
  assert.deepEqual(
    entries.map((entry) =>
      entry.type === "failed_turn" ? ["failed_turn", entry.retryText ?? null] : entry.type === "message" ? [entry.role, entry.text] : [entry.type],
    ),
    [
      ["user", "Plan the week."],
      ["failed_turn", null],
      ["user", "Try a shorter plan"],
      ["assistant", "Monday: soup"],
      ["failed_turn", "Try a shorter plan"],
    ],
  );
});

test("a routine label cut at the wire bound never splits an emoji, so the session stays servable", () => {
  const label = `${"a".repeat(119)}🍳 breakfast`;
  const entries = projectBotSessionEntries([
    notice(1, { notice: "routine", label, requestId: "routine:t:1" }),
    user(2, "Cook something \uD83D"),
  ] as never);
  const session = parseAidenRemoteBotSession({
    botId: BOT_ID, epoch: "epoch_1", seq: 0, state: "idle", interrupted: false, entries, hasOlder: false, question: null, approval: null,
  });
  const message = session.entries[0];
  assert.equal(message?.type, "message");
  assert.equal(message?.type === "message" && message.label, `${"a".repeat(119)}🍳`);
  assert.equal(message?.type === "message" && message.text, "Cook something �");
});

test("routine errors reach phones without local paths or key-shaped secrets", () => {
  const redacted = redactRemoteError(
    "ENOENT: no such file '/Users/sam/Library/Application Support/Aiden/bots/bot~3a1/session.sqlite' (key sk-abcdefghijklmnopqrstuv)",
  );
  assert.ok(!redacted.includes("/Users"), redacted);
  assert.ok(!redacted.includes("sk-abcdef"), redacted);
  assert.match(redacted, /^ENOENT: no such file/u);
  assert.equal(redactRemoteError("   "), "This routine failed.");
});

/** A conversation whose watch the test drives frame by frame. */
function drivenConversation(initial: RawEntry[], initialDocs: Record<string, unknown> = {}) {
  let listener: ((view: unknown) => Promise<void>) | undefined;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
  const conversation = {
    async watch() {
      return {
        value: { entries: initial, docs: initialDocs },
        start(next: (view: unknown) => Promise<void>) { listener = next; },
        stop: async () => {},
        closed,
      };
    },
  };
  return {
    conversation,
    async emit(entries: RawEntry[], partial?: string) {
      const docs = partial === undefined
        ? {}
        : { "pi.live": { generation: { message: { content: [{ type: "text", text: partial }] } } } };
      await listener!({ entries, docs });
    },
    /** One watch frame with exactly these docs (`pi.live`, `pi.inbox`). */
    async emitView(entries: RawEntry[], docs: Record<string, unknown>) {
      await listener!({ entries, docs });
    },
    /** What a harness close (idle close, delete, quit) does to every watch. */
    end: () => resolveClosed(),
  };
}

interface Frame { type: string; seq: number; epoch: string; payload: any }

/** Serve one Bot's SSE stream over HTTP and collect parsed frames. */
async function openStream(service: AidenRemoteBotSessionService, botId = BOT_ID) {
  const server = createServer((_request, response) => {
    void service.openEvents("device_1", botId, response).catch(() => response.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const response = await fetch(`http://127.0.0.1:${port}/`);
  const frames: Frame[] = [];
  const state = { ended: false };
  const decoder = new TextDecoder();
  let buffer = "";
  const reading = (async () => {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let index: number;
      while ((index = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const data = block.split("\n").find((line) => line.startsWith("data: "));
        if (data) frames.push(parseAidenRemoteBotSessionEvent(JSON.parse(data.slice(6))) as unknown as Frame);
      }
    }
    state.ended = true;
  })();
  return {
    frames,
    get ended() { return state.ended; },
    async until(predicate: () => boolean, what: string) {
      const deadline = Date.now() + 10_000;
      while (!predicate()) {
        if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await reading.catch(() => undefined);
    },
  };
}

test("the session stream is gapless, clears a finished partial, and rewrites history with a snapshot", async () => {
  const driven = drivenConversation([user(1, "Hi")]);
  const fake = fakeRuntime({ kind: "running", submissionId: "sub_1" });
  const runtime = { ...fake.runtime, conversation: async () => driven.conversation as never };
  const service = sessionService(runtime);
  const stream = await openStream(service);
  try {
    await stream.until(() => stream.frames.length >= 1, "the first snapshot");
    assert.equal(stream.frames[0]!.type, "snapshot");

    await driven.emit([user(1, "Hi")], "Hel");
    fake.setState({ kind: "idle" });
    await driven.emit([user(1, "Hi"), assistant(2, "Hello!")]);
    // A routine turn that turns out silent hides its already-shown input.
    const routine = [notice(3, { notice: "routine", label: "Brief", requestId: "r" }), user(4, "Brief me")];
    await driven.emit([user(1, "Hi"), assistant(2, "Hello!"), ...routine]);
    await driven.emit([user(1, "Hi"), assistant(2, "Hello!"), ...routine, assistant(5, "[SILENT]")]);
    await stream.until(() => stream.frames.filter((frame) => frame.type === "snapshot").length === 2, "the rewrite snapshot");

    const seqs = stream.frames.map((frame) => frame.seq);
    assert.deepEqual(seqs, seqs.map((_, index) => seqs[0]! + index), "every frame is exactly one after the last");
    assert.ok(stream.frames.every((frame) => frame.epoch === stream.frames[0]!.epoch));
    const types = stream.frames.map((frame) => frame.type);
    const answer = types.indexOf("entry", types.indexOf("partial") + 1);
    assert.equal(stream.frames[answer]!.payload.entry.text, "Hello!");
    assert.equal(types[answer + 1], "partial", "the partial is cleared explicitly after the answer arrives");
    assert.equal(stream.frames[answer + 1]!.payload.text, "");
    const rewrite = stream.frames[stream.frames.length - 1]!;
    assert.equal(rewrite.type, "snapshot");
    assert.deepEqual(rewrite.payload.session.entries.map((entry: { text: string }) => entry.text), ["Hi", "Hello!"]);
  } finally {
    await stream.close();
    await service.close();
  }
});

test("deleting a Bot while its stream is open ends the stream and the next read is not found", async () => {
  const driven = drivenConversation([user(1, "Hi")]);
  const fake = fakeRuntime({ kind: "idle" });
  let exists = true;
  const bots = new AidenRemoteBotService({
    application: { get: async (id: string) => (id === BOT_ID && exists ? bot() : null), list: async () => [] } as never,
    chatStore: { get: async () => null },
  });
  const service = sessionService({ ...fake.runtime, conversation: async () => driven.conversation as never }, bots);
  const stream = await openStream(service);
  try {
    await stream.until(() => stream.frames.length >= 1, "the first snapshot");
    exists = false;
    driven.end();
    await stream.until(() => stream.ended, "the stream to end");
    assert.equal(stream.frames[stream.frames.length - 1]!.type, "closed");
    await assert.rejects(service.session(BOT_ID), { code: "not_found" });
  } finally {
    await stream.close();
    await service.close();
  }
});

test("a connect card finished on the Mac reads as connected on the next fetch, with nothing committed", async () => {
  const driven = drivenConversation([user(1, "Help with email"), card(2, "gmail")]);
  const connected = new Set<string>();
  const fake = fakeRuntime({ kind: "idle" });
  const service = new AidenRemoteBotSessionService({
    bots: botService(),
    runtime: async () => ({ ...fake.runtime, conversation: async () => driven.conversation as never }),
    connectCardStatus: async (_botId, entry) => (connected.has(entry.pluginId) ? "connected" : entry.status),
  });
  const cardOf = (session: { entries: Array<{ type: string }> }) =>
    session.entries.find((entry) => entry.type === "connect_card") as unknown as { status: string; name: string };
  try {
    assert.equal(cardOf(await service.session(BOT_ID)).status, "pending");
    connected.add("gmail");
    const shown = cardOf(await service.session(BOT_ID));
    assert.equal(shown.status, "connected");
    assert.equal(shown.name, "Gmail");
  } finally {
    await service.close();
  }
});

test("a connection request for an app Aiden can't connect is refused without bothering the Mac", async () => {
  const requested: string[] = [];
  const service = new AidenRemoteBotSessionService({
    bots: botService(),
    runtime: async () => fakeRuntime({ kind: "idle" }).runtime,
    connectionRequested: async ({ pluginId }) => { requested.push(pluginId); },
  });
  await assert.rejects(
    service.requestConnection(DEVICE_ID, BOT_ID, "connect-request-0001", { pluginId: "not-a-real-app" }),
    { code: "not_found", status: 404 },
  );
  await assert.rejects(
    service.requestConnection(DEVICE_ID, BOT_ID, "connect-request-0002", { pluginId: "Gmail!" }),
    { code: "invalid_request", status: 400 },
  );
  assert.deepEqual(requested, []);
  const receipt = await service.requestConnection(DEVICE_ID, BOT_ID, "connect-request-0003", { pluginId: "gmail" });
  assert.deepEqual(receipt, { pluginId: "gmail", name: "Gmail", status: "sent" });
  assert.deepEqual(requested, ["gmail"]);
});

test("a routine change with a stale If-Match is a revision conflict that changes nothing", async () => {
  const routine: BotRoutine = {
    id: "routine_1", botId: BOT_ID, name: "Brief", prompt: "Brief me", schedule: { kind: "daily", time: "08:00" },
    timezone: "UTC", label: "Every day at 8:00 AM", enabled: true, updatedAt: 5_000,
  };
  const writes: string[] = [];
  const service = new AidenRemoteBotSessionService({
    bots: botService(),
    runtime: async () => fakeRuntime({ kind: "idle" }).runtime,
    routines: {
      list: async () => [routine],
      create: async () => { throw new Error("unused"); },
      update: async (input) => {
        writes.push(`update:${input.expectedUpdatedAt}`);
        return { ...routine, enabled: false, updatedAt: 6_000 };
      },
      delete: async () => { writes.push("delete"); },
    },
  });
  const current = (await service.listRoutines(BOT_ID)).routines[0]!.revision;
  await assert.rejects(
    service.updateRoutine(BOT_ID, "routine_1", "routine_revision_4000", { enabled: false }),
    (error: { code: string; status: number; details?: { currentRevision?: string } }) =>
      error.code === "revision_conflict" && error.status === 409 && error.details?.currentRevision === current,
  );
  await assert.rejects(service.deleteRoutine(BOT_ID, "routine_1", "routine_revision_4000"), { code: "revision_conflict" });
  assert.deepEqual(writes, []);
  const updated = await service.updateRoutine(BOT_ID, "routine_1", current, { enabled: false });
  assert.equal(updated.enabled, false);
  assert.notEqual(updated.revision, current);
  assert.deepEqual(writes, ["update:5000"]);
});

test("Start Chat from phones with different request keys and the Mac makes one Bot and one self-intro", async () => {
  const created: string[] = [];
  const sent: string[] = [];
  const store = new Map<string, BotDefinition>();
  const keys = new Map<string, string>();
  const make = async (input: { name: string }, audience: string, botId: string) => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    const made = { ...bot(botId), name: input.name };
    created.push(audience);
    store.set(made.id, made);
    return made;
  };
  const starter = createBotStarter({
    async findBotByCreationKey(key) {
      const id = keys.get(key);
      return id ? store.get(id) ?? null : null;
    },
    mintBotId: () => `bot_preset_${keys.size + created.length + 1}`,
    async reserveCreation(key, botId) {
      keys.set(key, botId);
    },
    createBot: (input, _access, botId) => make(input, "desktop", botId),
    session: {
      state: async () => ({ kind: "idle" }),
      send: async (botId) => { sent.push(botId); return { submissionId: "1", deduped: false }; },
      conversation: async () => ({ context: async () => ({ entries: [] }) }) as never,
    },
  });
  const bots = new AidenRemoteBotService({
    application: { get: async (id: string) => store.get(id) ?? null, list: async () => [...store.values()] } as never,
    chatStore: { get: async () => null },
  });
  const service = new AidenRemoteBotSessionService({
    bots,
    runtime: async () => fakeRuntime({ kind: "idle" }).runtime,
    presets: {
      list: () => BOT_PRESETS,
      create: async (presetId, { audienceId }) => {
        const result = await starter.startFromPreset(presetId, { createBot: (input, botId) => make(input, audienceId, botId) });
        return { botId: result.bot.id, created: result.created };
      },
    },
  });
  const presetId = BOT_PRESETS[0]!.id;
  const [phoneA, phoneB, mac] = await Promise.all([
    service.createFromPreset("device_a", "preset-request-0001", { presetId }),
    service.createFromPreset("device_b", "preset-request-0002", { presetId }),
    starter.startFromPreset(presetId),
  ]);
  const later = await service.createFromPreset("device_a", "preset-request-0003", { presetId });

  assert.equal(created.length, 1, "one Bot");
  assert.equal(new Set([phoneA.bot.id, phoneB.bot.id, mac.bot.id, later.bot.id]).size, 1);
  assert.equal([phoneA.created, phoneB.created, mac.created].filter(Boolean).length, 1);
  assert.equal(later.created, false);
  assert.deepEqual(sent, [phoneA.bot.id], "only the creating call sends the self-intro");
});

// --- Real durable runtime -----------------------------------------------------

const durableRoots: string[] = [];
after(() => {
  for (const root of durableRoots) rmSync(root, { recursive: true, force: true });
});

async function interruptedDurableBot() {
  const profileDir = mkdtempSync(path.join(os.tmpdir(), "aiden-remote-bot-session-"));
  durableRoots.push(profileDir);
  const child = spawnHarnessChild("stream", [profileDir, "bot:killed", "req-killed"]);
  await child.waitFor("STREAMING");
  await child.kill();
  const fauxModels = createFauxModels([fauxAssistantMessage("resumed answer"), fauxAssistantMessage("extra")]);
  const runtime = await createBotSessionService({
    profileDir,
    models: fauxModels.models,
    extension: recordingDeps(),
    resolveModel: async () => FAUX_MODEL_REF,
    knownBotIds: async () => new Set(["bot:killed"]),
  });
  await runtime.initialize();
  let exists = true;
  const bots = new AidenRemoteBotService({
    application: {
      get: async (id: string) => (id === "bot:killed" && exists ? bot("bot:killed") : null),
      list: async () => [],
    } as never,
    chatStore: { get: async () => null },
  });
  const service = new AidenRemoteBotSessionService({ bots, runtime: async () => runtime });
  return { runtime, service, fauxModels, markDeleted: () => { exists = false; } };
}

test("two phones tapping Resume at once on a turn killed mid-stream make one provider request", async () => {
  const { runtime, service, fauxModels } = await interruptedDurableBot();
  try {
    const paused = await service.session("bot:killed");
    assert.equal(paused.state, "interrupted");
    assert.equal(paused.interrupted, true);

    const [first, second] = await Promise.all([
      service.resume("device_a", "bot:killed", "resume-request-000a", {}),
      service.resume("device_b", "bot:killed", "resume-request-000b", {}),
    ]);
    assert.equal(first.state, "running");
    assert.deepEqual(second, first);
    await waitFor(async () => (await runtime.state("bot:killed")).kind === "idle", { what: "the resumed turn" });
    assert.equal(fauxModels.calls(), 1);

    const settled = await service.session("bot:killed");
    assert.equal(settled.state, "idle");
    assert.ok(settled.entries.some((entry) => entry.type === "message" && entry.text === "resumed answer"));
  } finally {
    await service.close();
    await runtime.shutdown();
  }
});

test("deleting a durable Bot while a phone streams its chat closes the stream", async () => {
  const { runtime, service, fauxModels, markDeleted } = await interruptedDurableBot();
  const stream = await openStream(service, "bot:killed");
  try {
    await stream.until(() => stream.frames.length >= 1, "the first snapshot");
    assert.equal(stream.frames[0]!.payload.session.state, "interrupted");
    markDeleted();
    await runtime.deleteBot("bot:killed");
    await stream.until(() => stream.ended, "the stream to end");
    assert.equal(stream.frames[stream.frames.length - 1]!.type, "closed");
    assert.equal(fauxModels.calls(), 0, "deleting a paused Bot never resumes it");
    await assert.rejects(service.session("bot:killed"), { code: "not_found" });
  } finally {
    await stream.close();
    await service.close();
    await runtime.shutdown();
  }
});

/** A durable Bot whose `send_note` tool needs approval, watched by phones through the real Bot approval bridge. */
async function approvalGatedBot(toolName = "send_note") {
  const profileDir = mkdtempSync(path.join(os.tmpdir(), "aiden-remote-bot-approval-"));
  durableRoots.push(profileDir);
  const approvals = createBotApprovals({ publish: () => {} });
  const note = countingTool(toolName);
  const fauxModels = createFauxModels([
    fauxAssistantMessage([fauxToolCall(toolName, { text: "lunch on Friday" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("Sent."),
  ]);
  const extension = recordingDeps({
    tools: [{ tool: note, replay: "unsafe" }],
    policy: (name) => (name === toolName ? { allowed: true, approval: { summary: "Send a note: lunch on Friday" } } : { allowed: true }),
  });
  extension.requestApproval = (request) => approvals.request(request);
  const runtime = await createBotSessionService({
    profileDir,
    models: fauxModels.models,
    extension,
    resolveModel: async () => FAUX_MODEL_REF,
    knownBotIds: async () => new Set([BOT_ID]),
  });
  const service = new AidenRemoteBotSessionService({ bots: botService(), runtime: async () => runtime, approvals });
  return { runtime, service, approvals, note, fauxModels };
}

test("a phone sees a Bot's waiting approval and allowing it runs the tool and finishes the turn", async () => {
  const { runtime, service, approvals, note } = await approvalGatedBot();
  const stream = await openStream(service);
  try {
    await stream.until(() => stream.frames.length >= 1, "the first snapshot");
    assert.equal(stream.frames[0]!.payload.session.approval, null);
    const sent = await runtime.send(BOT_ID, { text: "tell Dana", requestId: "send-request-0001" });
    await waitFor(() => approvals.pending(BOT_ID).length === 1, { what: "the approval prompt" });

    // A phone that reconnects now gets the waiting approval in its snapshot.
    const waiting = (await service.session(BOT_ID)).approval;
    assert.equal(waiting?.summary, "Send a note: lunch on Friday");
    assert.equal(waiting?.toolName, "send_note");
    assert.equal(waiting?.canAllow, true);
    await stream.until(() => stream.frames.some((frame) => frame.type === "approval" && frame.payload.approval !== null), "the approval frame");
    assert.equal(note.executions.length, 0, "nothing runs before the person answers");

    assert.equal(service.ownsApproval(waiting!.waitId), true);
    const resolved = await service.respondApproval(DEVICE_ID, waiting!.waitId, "allow", "approve-request-0001");
    assert.equal(resolved.approvalId, waiting!.waitId);
    assert.equal(resolved.decision, "allow");
    assert.deepEqual(
      await runtime.awaitReply(BOT_ID, sent.submissionId, new AbortController().signal),
      { kind: "completed", text: "Sent." },
    );
    assert.deepEqual(note.executions, [{ text: "lunch on Friday" }]);
    await stream.until(
      () => stream.frames.some((frame) => frame.type === "approval" && frame.payload.approval === null),
      "the approval to clear",
    );
    assert.equal((await service.session(BOT_ID)).approval, null);

    // A retry of the same request replays its receipt; another request finds nothing waiting.
    assert.deepEqual(await service.respondApproval(DEVICE_ID, waiting!.waitId, "allow", "approve-request-0001"), resolved);
    await assert.rejects(
      service.respondApproval("device_2", waiting!.waitId, "deny", "approve-request-0002"),
      isError("approval_expired", 409),
    );
  } finally {
    await stream.close();
    await service.close();
    await runtime.shutdown();
  }
});

test("a phone can deny a Bot approval but only the Mac can allow Computer Use", async () => {
  const { runtime, service, approvals, note } = await approvalGatedBot("computer_use");
  try {
    const sent = await runtime.send(BOT_ID, { text: "click it", requestId: "send-request-0003" });
    await waitFor(() => approvals.pending(BOT_ID).length === 1, { what: "the approval prompt" });
    const waiting = (await service.session(BOT_ID)).approval!;
    assert.equal(waiting.canAllow, false);
    await assert.rejects(
      service.respondApproval(DEVICE_ID, waiting.waitId, "allow", "approve-request-0003"),
      isError("capability_denied", 403),
    );
    await assert.rejects(
      service.respondApproval(DEVICE_ID, waiting.waitId, "deny", "approve-request-0004", "always"),
      isError("invalid_request", 400),
      "Bot approvals are answered once",
    );
    assert.equal(approvals.pending(BOT_ID).length, 1, "a refused answer leaves it waiting");
    await service.respondApproval(DEVICE_ID, waiting.waitId, "deny", "approve-request-0005");
    await runtime.awaitReply(BOT_ID, sent.submissionId, new AbortController().signal);
    assert.equal(note.executions.length, 0, "a denied call never runs");
  } finally {
    await service.close();
    await runtime.shutdown();
  }
});

// ---------------------------------------------------------------------------
// Contract revision 27: memory, routine proposals and suggestions, `bot:cards`
// ---------------------------------------------------------------------------

async function contractFixture(): Promise<Record<string, any>> {
  return JSON.parse(await readFile(path.resolve(process.cwd(), "protocol/aiden-remote/v1/fixtures/contract.json"), "utf8"));
}

const memoryReview = (id: number): RawEntry => ({
  id, kind: "aiden.memory-review", data: { source: "review", added: 1, targets: ["user"] },
});
const proposal = (id: number, proposalId: string, name: string, prompt: string, label: string): RawEntry => ({
  id,
  kind: "aiden.routine-proposal",
  data: { proposalId, name, prompt, schedule: { kind: "daily", time: "09:00" }, timezone: "UTC", label },
});
const proposalStatus = (id: number, proposalId: string, status: string, routineId?: string): RawEntry => ({
  id, kind: "aiden.routine-proposal-status", data: { proposalId, status, ...(routineId ? { routineId } : {}) },
});

/** The conversation behind the shared `botSessionCards` fixture. */
function cardEntries(): RawEntry[] {
  return [
    user(1, "Plan my meals, please."),
    assistant(2, "Done. I'll remember you're vegetarian."),
    memoryReview(20),
    proposal(21, "7d0c5c8e-2f0b-4c4e-9a59-3b6f1f0e9a11", "Daily check-in", "Check in briefly…", "Every day at 9:00 AM"),
    proposal(22, "0b6b7a52-6d0a-4a59-8a1e-2a8b0c4f7e22", "Weekly meal plan", "Plan this week's meals.", "Every Sunday at 9:00 AM"),
    proposalStatus(23, "0b6b7a52-6d0a-4a59-8a1e-2a8b0c4f7e22", "accepted", "task_fixture_routine_02"),
  ];
}

const withoutCreatedAt = (entries: Array<Record<string, unknown>>) =>
  entries.map(({ createdAt: _createdAt, ...entry }) => entry);

test("only a device holding bot:cards sees memory and routine proposal cards, as the shared fixture shows them", async () => {
  const fixture = await contractFixture();
  const driven = drivenConversation(cardEntries());
  const fake = fakeRuntime({ kind: "idle" });
  const service = sessionService({ ...fake.runtime, conversation: async () => driven.conversation as never });
  try {
    const cards = await service.session(BOT_ID, { cards: true });
    const shown = cards.entries.filter((entry) => entry.type === "memory_update" || entry.type === "routine_proposal");
    // Custom entries carry no timestamp, so createdAt appears only when the host knows it.
    assert.deepEqual(withoutCreatedAt(shown as never), withoutCreatedAt(fixture.botSessionCards.entries));

    const legacy = await service.session(BOT_ID);
    assert.deepEqual(legacy.entries.map((entry) => entry.type), ["message", "message"]);
    assert.deepEqual(parseAidenRemoteBotSession(legacy), legacy);
  } finally {
    await service.close();
  }
});

/** Serve one Bot's SSE stream for a device with or without `bot:cards`. */
async function openCardStream(service: AidenRemoteBotSessionService, cards: boolean) {
  const server = createServer((_request, response) => {
    void service.openEvents("device_1", BOT_ID, response, () => {}, { cards }).catch(() => response.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const response = await fetch(`http://127.0.0.1:${port}/`);
  const frames: Frame[] = [];
  const decoder = new TextDecoder();
  let buffer = "";
  const reading = (async () => {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let index: number;
      while ((index = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const data = block.split("\n").find((line) => line.startsWith("data: "));
        // Every frame must parse with the revision-27 parser; legacy devices also
        // must never see a card type.
        if (data) frames.push(parseAidenRemoteBotSessionEvent(JSON.parse(data.slice(6))) as unknown as Frame);
      }
    }
  })();
  return {
    frames,
    async until(predicate: () => boolean, what: string) {
      const deadline = Date.now() + 10_000;
      while (!predicate()) {
        if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await reading.catch(() => undefined);
    },
  };
}

test("a new card reaches bot:cards streams as an entry and other streams as a no-op at the same seq", async () => {
  const driven = drivenConversation([user(1, "Hi"), assistant(2, "Hello!")]);
  const fake = fakeRuntime({ kind: "idle" });
  const service = sessionService({ ...fake.runtime, conversation: async () => driven.conversation as never });
  const cards = await openCardStream(service, true);
  const legacy = await openCardStream(service, false);
  try {
    await cards.until(() => cards.frames.length >= 1, "the cards snapshot");
    await legacy.until(() => legacy.frames.length >= 1, "the legacy snapshot");
    await driven.emit([user(1, "Hi"), assistant(2, "Hello!"), memoryReview(3)]);
    await driven.emit([user(1, "Hi"), assistant(2, "Hello!"), memoryReview(3), assistant(4, "Anything else?")]);
    await cards.until(() => cards.frames.length >= 3, "two frames after the snapshot");
    await legacy.until(() => legacy.frames.length >= 3, "two frames after the snapshot");

    assert.deepEqual(cards.frames.map((frame) => frame.type), ["snapshot", "entry", "entry"]);
    assert.equal(cards.frames[1]!.payload.entry.type, "memory_update");
    assert.deepEqual(legacy.frames.map((frame) => frame.type), ["snapshot", "state", "entry"]);
    assert.deepEqual(legacy.frames[1]!.payload, { state: "idle", interrupted: false }, "the state it already had");
    assert.equal(legacy.frames[2]!.payload.entry.text, "Anything else?");
    for (const stream of [cards, legacy]) {
      const seqs = stream.frames.map((frame) => frame.seq);
      assert.deepEqual(seqs, seqs.map((_, index) => seqs[0]! + index), "gapless for every device");
    }
  } finally {
    await cards.close();
    await legacy.close();
    await service.close();
  }
});

function memoryView(overrides: Partial<BotMemoryView> = {}): BotMemoryView {
  return {
    botId: BOT_ID,
    revision: "9f2c1a0b7d3e4f51",
    readable: true,
    memory: { entries: [{ id: "a1b2c3d4e5f60718", text: "Weekly meal plan is vegetarian except Fridays." }], usedChars: 46, limitChars: 2_200, overBudget: false },
    user: { entries: [{ id: "0f1e2d3c4b5a6978", text: "Prefers short answers." }], usedChars: 22, limitChars: 1_375, overBudget: false },
    updatedAt: Date.parse("2026-08-19T15:00:00.000Z"),
    ...overrides,
  };
}

function memorySession(edit: (input: BotMemoryEditInput) => Promise<BotMemoryEditResult>) {
  const edits: BotMemoryEditInput[] = [];
  const fake = fakeRuntime({ kind: "idle" });
  const service = new AidenRemoteBotSessionService({
    bots: botService(),
    runtime: async () => fake.runtime,
    memory: {
      view: async (botId) => memoryView({ botId }),
      edit: async (input) => {
        edits.push(input);
        return edit(input);
      },
    },
  });
  return { service, edits };
}

test("phones read memory in the shared fixture's shape", async () => {
  const fixture = await contractFixture();
  const { service } = memorySession(async () => assert.fail("no edit"));
  const memory = await service.memory(BOT_ID);
  assert.equal(memory.updatedAt, "2026-08-19T15:00:00.000Z");
  assert.deepEqual(memory.memory, fixture.botMemory.memory);
  // A Bot that never saved anything reports null, and the fixture view round-trips.
  const fresh = projectAidenRemoteBotMemory(memoryView({ updatedAt: null }));
  assert.equal(fresh.updatedAt, null);
  assert.deepEqual(
    projectAidenRemoteBotMemory({ ...fixture.botMemory, updatedAt: Date.parse(fixture.botMemory.updatedAt) }),
    fixture.botMemory,
  );
  await assert.rejects(service.memory("bot_missing"), (error: { code?: string }) => error.code === "not_found");
});

test("every memory view the store can load is one phones accept", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "aiden-remote-bot-memory-"));
  try {
    // The Bot's session directory exists once its harness has opened.
    mkdirSync(path.dirname(botMemoryDirectory(root, BOT_ID)), { recursive: true });
    const store = createBotMemoryStore({ profileDir: root });
    // 65 short, individually valid facts fit the 1,375-character budget many times over.
    const facts = Array.from({ length: 65 }, (_, index) => `Likes tea ${index + 1}.`);
    assert.ok(facts.join("\n§\n").length < 1_375);
    for (const fact of facts) await store.apply(BOT_ID, "user", [{ action: "add", content: fact }]);
    const saved = memoryStoreView(await store.load(BOT_ID));
    assert.equal(saved.user.entries.length, 64, "the 65th save is refused");
    assert.equal(projectAidenRemoteBotMemory(saved).user.entries.length, 64);

    // A shell edit can plant any number of entries: the view stays loadable and holds what the Bot reads.
    writeFileSync(botMemoryFile(root, BOT_ID, "user"), Array.from({ length: 90 }, (_, index) => `Planted ${index + 1}.`).join("\n§\n"));
    const planted = projectAidenRemoteBotMemory(memoryStoreView(await store.load(BOT_ID)));
    assert.equal(planted.user.entries.length, 64);
    assert.equal(planted.user.entries[0]!.text, "Planted 1.");
    // The person can still erase from the phone view.
    const erased = await store.edit(BOT_ID, { kind: "remove", target: "user", entryId: planted.user.entries[0]!.id });
    assert.equal(erased.ok, true);
    assert.equal(projectAidenRemoteBotMemory(memoryStoreView(await store.load(BOT_ID))).user.entries[0]!.text, "Planted 2.");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a memory edit is idempotent per request key and its failures carry the documented codes", async () => {
  const fixture = await contractFixture();
  const results: BotMemoryEditResult[] = [
    { ok: true, view: memoryView({ revision: "7a7a7a7a7a7a7a7a" }) },
    { ok: false, code: "entry_not_found", message: "Not found.", view: memoryView() },
    { ok: false, code: "over_budget", message: "Too long for About you.", view: memoryView() },
    { ok: false, code: "blocked", message: "Blocked.", view: memoryView() },
    { ok: false, code: "invalid", message: "Write 1 to 500 characters.", view: memoryView() },
  ];
  const { service, edits } = memorySession(async () => results.shift()!);
  const request = fixture.botMemoryEdit.request;

  const applied = await service.editMemory(DEVICE_ID, BOT_ID, "memory-edit-key-0001", request);
  const replay = await service.editMemory(DEVICE_ID, BOT_ID, "memory-edit-key-0001", request);
  assert.equal(applied.ok, true);
  assert.equal(applied.view.revision, "7a7a7a7a7a7a7a7a");
  assert.deepEqual(replay, applied);
  assert.deepEqual(edits, [{ botId: BOT_ID, edit: request.edit }], "a replay never edits twice");

  const documented = fixture.botMemoryEdit.errors as Array<{ status: number; code: string }>;
  for (const [index, expected] of [...documented, { status: 422, code: "invalid_request" }].entries()) {
    await assert.rejects(
      service.editMemory(DEVICE_ID, BOT_ID, `memory-edit-key-01${index}0`, request),
      (error: { status?: number; code?: string }) => error.status === expected.status && error.code === expected.code,
      expected.code,
    );
  }
  for (const body of [{ edit: { kind: "replace", target: "user", entryId: "bad", text: "x" } }, { edit: { kind: "rewrite" } }, {}]) {
    await assert.rejects(
      service.editMemory(DEVICE_ID, BOT_ID, "memory-edit-key-0900", body),
      (error: { status?: number; code?: string }) => error.status === 400 && error.code === "invalid_request",
    );
  }
});

test("answering a proposal from a phone is idempotent and an unknown proposal is not found", async () => {
  const fixture = await contractFixture();
  const answers: BotRoutineProposalRespondInput[] = [];
  const fake = fakeRuntime({ kind: "idle" });
  const routines: BotRoutine[] = [];
  const service = new AidenRemoteBotSessionService({
    bots: botService(),
    runtime: async () => fake.runtime,
    routines: {
      list: async () => routines,
      create: async () => assert.fail("phones never create through this path"),
      update: async () => assert.fail("no update"),
      delete: async () => assert.fail("no delete"),
    },
    proposals: {
      respond: async (input) => {
        answers.push(input);
        if (input.proposalId !== "7d0c5c8e-2f0b-4c4e-9a59-3b6f1f0e9a11") {
          throw Object.assign(new Error("gone"), { code: "routine_proposal_not_found" });
        }
        return { status: "accepted", routineId: "task_fixture_routine_03" };
      },
    },
    routineNotifications: { list: async () => ({ notifications: [], now: new Date(0).toISOString() }) },
    defaultTimezone: () => "UTC",
    now: () => Date.parse("2026-08-19T15:00:00.000Z"),
  });
  const proposalId = "7d0c5c8e-2f0b-4c4e-9a59-3b6f1f0e9a11";
  const first = await service.respondRoutineProposal(DEVICE_ID, BOT_ID, proposalId, "proposal-key-00001", fixture.botRoutineProposalRespond.request);
  const replay = await service.respondRoutineProposal(DEVICE_ID, BOT_ID, proposalId, "proposal-key-00001", fixture.botRoutineProposalRespond.request);
  assert.deepEqual(first, fixture.botRoutineProposalRespond.response);
  assert.deepEqual(replay, first);
  assert.equal(answers.length, 1);
  assert.deepEqual(answers[0], { botId: BOT_ID, proposalId, decision: "accept" });

  await assert.rejects(
    service.respondRoutineProposal(DEVICE_ID, BOT_ID, "0b6b7a52-6d0a-4a59-8a1e-2a8b0c4f7e22", "proposal-key-00002", { decision: "dismiss" }),
    (error: { status?: number; code?: string }) => error.status === 404 && error.code === "routine_proposal_not_found",
  );
  for (const [id, body] of [["not-a-uuid", { decision: "accept" }], [proposalId, { decision: "later" }]] as const) {
    await assert.rejects(
      service.respondRoutineProposal(DEVICE_ID, BOT_ID, id, "proposal-key-00003", body),
      (error: { code?: string }) => error.code === "invalid_request",
    );
  }

  // The Daily check-in suggestion matches the fixture until the Bot has a routine.
  assert.deepEqual(await service.routineSuggestions(BOT_ID), fixture.botRoutineSuggestions);
  routines.push({ id: "routine_1" } as BotRoutine);
  assert.deepEqual(await service.routineSuggestions(BOT_ID), { suggestions: [] });
});

// ---------------------------------------------------------------------------
// Contract revision 30: activity and queued frames (`bot:activity`)
// ---------------------------------------------------------------------------

/**
 * The Bot service of a host that announces `bot-activity-v1`: it also has the
 * Chat activity gate (`supportsChatActivity`), which the session service needs
 * alongside `turnIntents`.
 */
function activityBots() {
  const bots = botService();
  return {
    bot: (botId: string) => bots.bot(botId),
    summaryOf: (botId: string) => bots.summaryOf(botId),
    executeIdempotent: bots.executeIdempotent.bind(bots),
    supportsChatActivity: true,
  };
}

/** Serve one Bot's SSE stream to a device with these opt-ins; keep the raw data lines too. */
async function openAudienceStream(
  service: AidenRemoteBotSessionService,
  audience: { cards?: boolean; activity?: boolean },
  botId = BOT_ID,
) {
  const server = createServer((_request, response) => {
    void service.openEvents("device_1", botId, response, () => {}, audience).catch(() => response.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const response = await fetch(`http://127.0.0.1:${port}/`);
  const frames: Frame[] = [];
  const raw: string[] = [];
  const decoder = new TextDecoder();
  let buffer = "";
  const reading = (async () => {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let index: number;
      while ((index = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const data = block.split("\n").find((line) => line.startsWith("data: "));
        if (!data) continue;
        raw.push(data.slice(6));
        frames.push(parseAidenRemoteBotSessionEvent(JSON.parse(data.slice(6))) as unknown as Frame);
      }
    }
  })();
  return {
    frames,
    raw,
    async until(predicate: () => boolean, what: string) {
      const deadline = Date.now() + 10_000;
      while (!predicate()) {
        if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await reading.catch(() => undefined);
    },
  };
}

/** The activity a device holds after each frame that carries one; null is "no turn running". */
function activitiesOf(frames: Frame[]): Array<{ phase: string; app?: string; startedAt: number } | null> {
  const activities: Array<{ phase: string; app?: string; startedAt: number } | null> = [];
  for (const frame of frames) {
    const activity = frame.type === "activity"
      ? frame.payload.activity
      : frame.type === "snapshot" ? frame.payload.session.activity : undefined;
    if (activity !== undefined) activities.push(activity);
  }
  return activities;
}

/** The phases a device saw, in order, with repeats folded. */
function phasesOf(frames: Frame[]): Array<string | null> {
  const phases: Array<string | null> = [];
  for (const activity of activitiesOf(frames)) {
    const phase = activity === null ? null : activity.phase;
    if (phases.length === 0 || phases[phases.length - 1] !== phase) phases.push(phase);
  }
  return phases;
}

function runningOn(
  driven: ReturnType<typeof drivenConversation>,
  fake: ReturnType<typeof fakeRuntime>,
  options: Partial<ConstructorParameters<typeof AidenRemoteBotSessionService>[0]> = {},
) {
  return new AidenRemoteBotSessionService({
    bots: activityBots(),
    runtime: async () => ({ ...fake.runtime, conversation: async () => driven.conversation as never }),
    turnIntents: createBotTurnIntents(),
    ...options,
  });
}

const last = <Item>(items: readonly Item[]): Item | undefined => items[items.length - 1];

const gapless = (frames: Frame[]) => frames.map((frame) => frame.seq).every((seq, index, seqs) => seq === seqs[0]! + index);

test("a phone holding bot:activity follows a real turn's phases and never sees what the tool was given", async () => {
  const profileDir = mkdtempSync(path.join(os.tmpdir(), "aiden-remote-bot-activity-"));
  durableRoots.push(profileDir);
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const command = countingTool("run_command", async () => {
    await held;
    return "done";
  });
  const planted = "cat /Users/dana/Documents/plan.md && echo sk-live-0123456789abcdef";
  const fauxModels = createFauxModels([
    fauxAssistantMessage([fauxToolCall("run_command", { text: planted })], { stopReason: "toolUse" }),
    fauxAssistantMessage("Tidied."),
  ]);
  const runtime = await createBotSessionService({
    profileDir,
    models: fauxModels.models,
    extension: recordingDeps({ tools: [{ tool: command, replay: "unsafe" }] }),
    resolveModel: async () => FAUX_MODEL_REF,
    knownBotIds: async () => new Set([BOT_ID]),
  });
  const service = new AidenRemoteBotSessionService({
    bots: activityBots(),
    runtime: async () => runtime,
    turnIntents: createBotTurnIntents(),
  });
  const stream = await openAudienceStream(service, { activity: true });
  try {
    await stream.until(() => stream.frames.length >= 1, "the first snapshot");
    assert.equal(stream.frames[0]!.payload.session.activity, null, "an idle Bot is doing nothing");
    assert.deepEqual(stream.frames[0]!.payload.session.queued, []);

    await service.send(DEVICE_ID, BOT_ID, "send-request-activity-0001", { text: "Tidy my notes" });
    await stream.until(() => phasesOf(stream.frames).includes("command"), "Running a command");
    release();
    await stream.until(
      () => last(phasesOf(stream.frames)) === null && phasesOf(stream.frames).length > 2,
      "the turn to end",
    );

    for (const phase of phasesOf(stream.frames)) {
      assert.ok(phase === null || (BOT_ACTIVITY_PHASES as readonly string[]).includes(phase), String(phase));
    }
    for (const activity of activitiesOf(stream.frames)) {
      if (activity) assert.deepEqual(Object.keys(activity).filter((key) => !["phase", "app", "startedAt"].includes(key)), []);
    }
    const wire = stream.raw.join("\n");
    for (const secret of ["/Users/dana", "plan.md", "sk-live", "echo "]) {
      assert.equal(wire.includes(secret), false, `${secret} reached the phone`);
    }
    assert.ok(gapless(stream.frames), "gapless");
  } finally {
    release();
    await stream.close();
    await service.close();
    await runtime.shutdown();
  }
});

test("a device without bot:activity gets the state it already has at each activity seq, and no activity keys", async () => {
  const driven = drivenConversation([user(1, "Plan dinners")]);
  const fake = fakeRuntime({ kind: "running", submissionId: "sub_1" });
  const service = runningOn(driven, fake);
  const activity = await openAudienceStream(service, { activity: true });
  const legacy = await openAudienceStream(service, {});
  try {
    await activity.until(() => activity.frames.length >= 1, "the activity snapshot");
    await legacy.until(() => legacy.frames.length >= 1, "the legacy snapshot");
    assert.equal(activity.frames[0]!.payload.session.activity.phase, "preparing", "running with nothing from the model yet");
    assert.equal("activity" in legacy.frames[0]!.payload.session, false);
    assert.equal("queued" in legacy.frames[0]!.payload.session, false);

    await driven.emitView([user(1, "Plan dinners")], {
      "pi.live": { run: {}, tools: [{ callId: "call_1", name: "web_search", status: "running" }] },
      "pi.inbox": { items: [{ id: 18, mode: "followUp", content: [{ type: "text", text: "Also lunches." }] }] },
    });
    await activity.until(() => activity.frames.length >= 3, "the searching and queued frames");
    await legacy.until(() => legacy.frames.length >= 3, "the no-op frames");

    assert.equal(activity.frames[1]!.type, "activity");
    assert.deepEqual(Object.keys(activity.frames[1]!.payload.activity).sort(), ["phase", "startedAt"]);
    assert.equal(activity.frames[1]!.payload.activity.phase, "searching");
    assert.equal(activity.frames[2]!.type, "queued");
    for (const frame of legacy.frames.slice(1)) {
      assert.equal(frame.type, "state");
      assert.deepEqual(frame.payload, { state: "running", interrupted: false });
    }
    assert.deepEqual(legacy.frames.map((frame) => frame.seq), activity.frames.map((frame) => frame.seq), "every device stays on one seq");
    assert.ok(gapless(legacy.frames));
    assert.equal(legacy.raw.some((data) => /web_search|searching|Also lunches|"activity"|"queued"/u.test(data)), false);
    const fetched = await service.session(BOT_ID);
    assert.equal("activity" in fetched || "queued" in fetched, false, "a fetch without bot:activity has no new keys");
  } finally {
    await activity.close();
    await legacy.close();
    await service.close();
  }
});

test("a phone that reconnects mid-run gets the phase and the waiting messages in its first snapshot", async () => {
  const driven = drivenConversation([user(1, "Plan dinners")]);
  const fake = fakeRuntime({ kind: "running", submissionId: "sub_1" });
  const service = runningOn(driven, fake);
  const first = await openAudienceStream(service, { activity: true });
  try {
    await first.until(() => first.frames.length >= 1, "the first snapshot");
    await driven.emitView([user(1, "Plan dinners")], {
      "pi.live": { run: { inputs: [1] }, tools: [{ callId: "call_1", name: "web_search", status: "running" }] },
      "pi.inbox": { items: [{ id: 18, mode: "steer", content: [{ type: "text", text: "Keep it vegetarian." }] }] },
    });
    await first.until(() => first.frames.some((frame) => frame.type === "queued"), "the queued frame");
  } finally {
    await first.close(); // Wi-Fi drops
  }
  const again = await openAudienceStream(service, { activity: true });
  try {
    await again.until(() => again.frames.length >= 1, "the reconnect snapshot");
    const session = again.frames[0]!.payload.session;
    assert.equal(again.frames[0]!.type, "snapshot");
    assert.equal(session.activity.phase, "searching");
    assert.deepEqual(session.queued, [{ submissionId: "18", mode: "steer", text: "Keep it vegetarian." }]);
  } finally {
    await again.close();
    await service.close();
  }
});

test("an app step shows the app's name cut to 40 code points; other phases never carry one", () => {
  const emoji = "😀".repeat(41);
  assert.deepEqual(
    projectBotSessionActivity({ phase: "app", app: emoji, startedAt: 1_760_450_000_000.7 }),
    { phase: "app", app: "😀".repeat(40), startedAt: 1_760_450_000_000 },
  );
  assert.deepEqual(projectBotSessionActivity({ phase: "app", app: "Notion", startedAt: 5 }), { phase: "app", app: "Notion", startedAt: 5 });
  // No name to show: the phone reads its generic app word.
  assert.deepEqual(projectBotSessionActivity({ phase: "app", app: "   ", startedAt: 5 }), { phase: "app", startedAt: 5 });
  assert.deepEqual(projectBotSessionActivity({ phase: "reading", app: "Notion", startedAt: 5 }), { phase: "reading", startedAt: 5 });
  assert.deepEqual(projectBotSessionActivity({ phase: "thinking", startedAt: -3 }), { phase: "thinking", startedAt: 0 });
  // Every cut is one the strict parser accepts.
  const cut = projectBotSessionActivity({ phase: "app", app: `${"x".repeat(39)}😀😀`, startedAt: 5 });
  assert.equal([...cut.app!].length, 40);
  assert.deepEqual(parseAidenRemoteBotSessionEvent({
    protocolVersion: 1, botId: BOT_ID, epoch: "epoch_1", seq: 1, type: "activity", payload: { activity: cut },
  }).payload, { activity: cut });
});

test("a frame that leaves the phase as it was sends no activity frame", async () => {
  const driven = drivenConversation([user(1, "Plan dinners")]);
  const fake = fakeRuntime({ kind: "running", submissionId: "sub_1" });
  const service = runningOn(driven, fake);
  const stream = await openAudienceStream(service, { activity: true });
  try {
    await stream.until(() => stream.frames.length >= 1, "the snapshot");
    const searching = { run: { inputs: [1] }, tools: [{ callId: "call_1", name: "web_search", status: "running" }] };
    await driven.emitView([user(1, "Plan dinners")], { "pi.live": searching });
    // The tool's output grows; the line still reads Searching the web.
    await driven.emitView([user(1, "Plan dinners")], {
      "pi.live": { ...searching, tools: [{ ...searching.tools[0], output: "3 results" }] },
    });
    await driven.emitView([user(1, "Plan dinners"), assistant(2, "Found three.")], { "pi.live": searching });
    await stream.until(() => stream.frames.some((frame) => frame.type === "entry"), "the reply entry");
    assert.deepEqual(stream.frames.slice(1).map((frame) => frame.type), ["activity", "entry"]);
  } finally {
    await stream.close();
    await service.close();
  }
});

test("a Stop pressed anywhere reads Stopping on phones until the run ends, and a Stop with nothing running changes nothing", async () => {
  const driven = drivenConversation([user(1, "Plan dinners")]);
  const fake = fakeRuntime({ kind: "running", submissionId: "sub_1" });
  const intents = createBotTurnIntents();
  const service = runningOn(driven, fake, { turnIntents: intents });
  const stream = await openAudienceStream(service, { activity: true });
  try {
    await stream.until(() => stream.frames.length >= 1, "the snapshot");
    // The run is live in `pi.live` (slice B reads Stop only while a run exists).
    await driven.emitView([user(1, "Plan dinners")], { "pi.live": { run: { inputs: [1] } } });
    intents.announce(BOT_ID, "stopping"); // the Mac's Stop
    await stream.until(() => last(phasesOf(stream.frames)) === "stopping", "Stopping");
    intents.announce(BOT_ID, "stopCancelled"); // that Stop failed: the reply goes on
    await stream.until(() => last(phasesOf(stream.frames)) === "preparing", "back to the work");
    intents.announce(BOT_ID, "stopping");
    await stream.until(() => last(phasesOf(stream.frames)) === "stopping", "Stopping again");

    fake.setState({ kind: "idle" });
    await driven.emitView([user(1, "Plan dinners"), assistant(2, "Here is a start.")], {});
    await stream.until(() => last(phasesOf(stream.frames)) === null, "the run to end");

    const settled = stream.frames.length;
    const settledSeq = last(stream.frames)!.seq;
    intents.announce(BOT_ID, "stopping"); // a double-tap after the reply landed
    const fetched = await service.session(BOT_ID, { activity: true }); // runs after the intent on the projector's lane
    assert.equal(fetched.seq, settledSeq, "nothing was running, so the intent published nothing");
    assert.equal(fetched.activity, null);

    fake.setState({ kind: "running", submissionId: "sub_2" });
    await driven.emitView(
      [user(1, "Plan dinners"), assistant(2, "Here is a start."), user(3, "And lunches")],
      { "pi.live": { run: { inputs: [3] } } },
    );
    await stream.until(() => last(phasesOf(stream.frames)) !== null, "the next run");
    // The lane is serial: anything the intent had published would have come before the next run's frames.
    assert.equal(stream.frames[settled]!.seq, settledSeq + 1);
    assert.deepEqual(phasesOf(stream.frames.slice(settled)), ["preparing"], "the next turn starts at Getting ready");
    assert.ok(gapless(stream.frames));
  } finally {
    await stream.close();
    await service.close();
  }
});

test("a follow-up that replaces the run while the Bot stays running gets its own start time and drops Stopping", async () => {
  const driven = drivenConversation([user(1, "Plan dinners")]);
  const fake = fakeRuntime({ kind: "running", submissionId: "sub_1" });
  const intents = createBotTurnIntents();
  let clock = 1_000;
  const service = runningOn(driven, fake, { turnIntents: intents, now: () => clock });
  const stream = await openAudienceStream(service, { activity: true });
  try {
    await stream.until(() => stream.frames.length >= 1, "the snapshot");
    await driven.emitView([user(1, "Plan dinners")], {
      "pi.live": { run: { inputs: [1] }, generation: { message: { content: [{ type: "text", text: "Mon" }] } } },
    });
    intents.announce(BOT_ID, "stopping");
    await stream.until(() => last(phasesOf(stream.frames)) === "stopping", "Stopping");

    clock = 5_000;
    // The queued follow-up's run replaces the stopped one; the session never left `running`.
    await driven.emitView([user(1, "Plan dinners"), assistant(2, "Mon"), user(3, "And lunches")], {
      "pi.live": { run: { inputs: [3] } },
    });
    await stream.until(() => last(activitiesOf(stream.frames))?.startedAt === 5_000, "the follow-up's run");
    assert.deepEqual(last(activitiesOf(stream.frames)), { phase: "preparing", startedAt: 5_000 });
    assert.equal(activitiesOf(stream.frames)[0]!.startedAt, 1_000);
  } finally {
    await stream.close();
    await service.close();
  }
});

test("a phone or desktop chat that opens mid-run, or after the projector's idle close, sees when the run really started", async () => {
  const driven = drivenConversation([user(1, "Plan dinners")], { "pi.live": { run: { inputs: [1] } } });
  const fake = fakeRuntime({ kind: "running", submissionId: "sub_1" });
  let clock = 1_000;
  const runStarts = createBotRunStarts();
  const service = runningOn(driven, fake, { now: () => clock, runStarts, projectorIdleMs: 20 });
  const desktop = createBotLiveProjection({
    conversation: async () => driven.conversation as never,
    state: () => fake.runtime.state(BOT_ID),
    quietInputs: async () => new Map(),
    now: () => clock,
    runStarts,
  });
  const stream = await openAudienceStream(service, { activity: true });
  try {
    await stream.until(() => stream.frames.length >= 1, "the snapshot");
    const first = stream.frames[0]!.payload.session;
    assert.deepEqual(first.activity, { phase: "preparing", startedAt: 1_000 });

    clock = 31_000; // the Mac's chat opens half a minute in
    const { snapshot, unsubscribe } = await desktop.subscribe(BOT_ID, { send() {} });
    assert.equal(snapshot.activity?.startedAt, 1_000, "the desktop line counts from the run's start");
    unsubscribe();

    await stream.close();
    clock = 91_000; // the phone comes back after the projector closed for being idle
    const deadline = Date.now() + 10_000;
    let reopened = await service.session(BOT_ID, { activity: true });
    while (reopened.epoch === first.epoch) {
      if (Date.now() > deadline) throw new Error("Timed out waiting for the idle close");
      await new Promise((resolve) => setTimeout(resolve, 10));
      reopened = await service.session(BOT_ID, { activity: true });
    }
    assert.deepEqual(reopened.activity, { phase: "preparing", startedAt: 1_000 }, "a new projector, the same run");

    // The run ends; the next one, even for the same input, is timed from its own start.
    fake.setState({ kind: "idle" });
    assert.equal((await service.session(BOT_ID, { activity: true })).activity, null);
    fake.setState({ kind: "running", submissionId: "sub_1" });
    clock = 120_000;
    assert.deepEqual((await service.session(BOT_ID, { activity: true })).activity, { phase: "preparing", startedAt: 120_000 });
  } finally {
    await stream.close();
    await desktop.close();
    await service.close();
  }
});

test("a Resume after a crash mid-reply reads Picking up where it left off on phones until the resumed run moves", async () => {
  const stale = { run: { taskId: 3, inputs: [1] }, generation: { attempt: 1, message: { content: [{ type: "text", text: "Monday: soup" }] } } };
  const driven = drivenConversation([user(1, "Plan dinners")], { "pi.live": stale });
  const fake = fakeRuntime({ kind: "interrupted", submissionId: "sub_1" });
  const intents = createBotTurnIntents();
  const service = runningOn(driven, fake, { turnIntents: intents });
  const stream = await openAudienceStream(service, { activity: true });
  try {
    await stream.until(() => stream.frames.length >= 1, "the snapshot");
    assert.equal(stream.frames[0]!.payload.session.activity, null, "a paused Bot is not working");
    assert.equal(stream.frames[0]!.payload.session.partial, "Monday: soup");

    // The session resumed and announced it (`onResumed`), before any event from the resumed run.
    fake.setState({ kind: "running", submissionId: "sub_1" });
    intents.announce(BOT_ID, "resuming");
    await stream.until(() => last(phasesOf(stream.frames)) === "resuming", "Picking up where it left off");

    await driven.emitView([user(1, "Plan dinners")], { "pi.live": { run: { taskId: 4, inputs: [1] }, generation: { attempt: 1 } } });
    await driven.emitView([user(1, "Plan dinners")], {
      "pi.live": { run: { taskId: 4, inputs: [1] }, generation: { attempt: 1, message: { content: [{ type: "text", text: "Monday" }] } } },
    });
    await stream.until(() => last(phasesOf(stream.frames)) === "writing", "the resumed reply");
    assert.deepEqual(phasesOf(stream.frames), [null, "resuming", "writing"]);
  } finally {
    await stream.close();
    await service.close();
  }
});

test("Steer and Queue reach the runtime as steer and followUp, and only the person's waiting messages are listed", async () => {
  const driven = drivenConversation([user(1, "Plan dinners")]);
  const fake = fakeRuntime({ kind: "running", submissionId: "sub_1" });
  const sends: Array<{ text: string; whenBusy?: string }> = [];
  const service = new AidenRemoteBotSessionService({
    bots: activityBots(),
    runtime: async () => ({
      ...fake.runtime,
      conversation: async () => driven.conversation as never,
      async send(_botId: string, input: { text: string; requestId: string; whenBusy?: "steer" | "followUp" }) {
        sends.push({ text: input.text, ...(input.whenBusy ? { whenBusy: input.whenBusy } : {}) });
        return { submissionId: String(17 + sends.length), deduped: false };
      },
      // 20 is a routine's input: the session knows it from its durable request id.
      async quietInputs(_botId: string, ids: readonly string[]) {
        return new Map(ids.map((id) => [id, id === "20"]));
      },
    }),
    turnIntents: createBotTurnIntents(),
  });
  const stream = await openAudienceStream(service, { activity: true });
  try {
    await service.send(DEVICE_ID, BOT_ID, "send-request-steer-0001", { text: "Keep it vegetarian.", whenBusy: "steer" });
    await service.send(DEVICE_ID, BOT_ID, "send-request-queue-0001", { text: "Also a shopping list.", whenBusy: "queue" });
    await service.send(DEVICE_ID, BOT_ID, "send-request-plain-0001", { text: "Thanks!" });
    assert.deepEqual(sends, [
      { text: "Keep it vegetarian.", whenBusy: "steer" },
      { text: "Also a shopping list.", whenBusy: "followUp" },
      { text: "Thanks!" },
    ]);

    await stream.until(() => stream.frames.length >= 1, "the snapshot");
    await driven.emitView([user(1, "Plan dinners")], {
      "pi.live": { run: { inputs: [1] } },
      "pi.inbox": {
        items: [
          { id: 18, mode: "steer", content: [{ type: "text", text: "Keep it vegetarian." }] },
          { id: 19, mode: "write", entry: { kind: BOT_NOTICE_ENTRY_KIND, data: { notice: "routine" } } },
          { id: 20, mode: "followUp", content: [{ type: "text", text: "Weekly reset: plan the week." }] },
          { id: 21, mode: "followUp", content: [{ type: "text", text: "Also a shopping list." }] },
          // A photo with no words has nothing to show in a text bubble.
          { id: 22, mode: "followUp", content: [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }] },
        ],
      },
    });
    await stream.until(() => stream.frames.some((frame) => frame.type === "queued"), "the queued frame");
    const expected = [
      { submissionId: "18", mode: "steer", text: "Keep it vegetarian." },
      { submissionId: "21", mode: "queue", text: "Also a shopping list." },
    ];
    assert.deepEqual(stream.frames.find((frame) => frame.type === "queued")!.payload.queued, expected);
    assert.deepEqual((await service.session(BOT_ID, { activity: true })).queued, expected, "the snapshot agrees");
    assert.equal(stream.raw.some((data) => data.includes("Weekly reset")), false, "a routine's input is not the person's message");
  } finally {
    await stream.close();
    await service.close();
  }
});

test("a waiting input that can't be classified stays off phones and is retried, not asked again on every frame", async () => {
  const driven = drivenConversation([user(1, "Plan dinners")]);
  const fake = fakeRuntime({ kind: "running", submissionId: "sub_1" });
  const asked: string[][] = [];
  let failing = true;
  const service = new AidenRemoteBotSessionService({
    bots: activityBots(),
    runtime: async () => ({
      ...fake.runtime,
      conversation: async () => driven.conversation as never,
      async quietInputs(_botId: string, ids: readonly string[]) {
        asked.push([...ids]);
        if (failing) throw new Error("The session could not be inspected.");
        return new Map(ids.map((id) => [id, id === "20"]));
      },
    }),
    turnIntents: createBotTurnIntents(),
    classifyRetryMs: 300,
  });
  const stream = await openAudienceStream(service, { activity: true });
  try {
    await stream.until(() => stream.frames.length >= 1, "the snapshot");
    const docs = {
      "pi.live": { run: { inputs: [1] } },
      "pi.inbox": {
        items: [
          { id: 20, mode: "followUp", content: [{ type: "text", text: "Weekly reset: plan the week." }] },
          { id: 21, mode: "followUp", content: [{ type: "text", text: "Also a shopping list." }] },
        ],
      },
    };
    await driven.emitView([user(1, "Plan dinners")], docs);
    await driven.emitView([user(1, "Plan dinners")], docs);
    assert.deepEqual((await service.session(BOT_ID, { activity: true })).queued, [], "withheld while it can't be classified");
    assert.equal(asked.length, 1, "a failing classification is throttled, not retried on every frame");

    failing = false;
    await stream.until(() => stream.frames.some((frame) => frame.type === "queued"), "the retried classification");
    const queued = stream.frames.filter((frame) => frame.type === "queued").map((frame) => frame.payload.queued);
    assert.deepEqual(queued, [[{ submissionId: "21", mode: "queue", text: "Also a shopping list." }]]);
    assert.equal(asked.length, 2);
    assert.equal(stream.raw.some((data) => data.includes("Weekly reset")), false);
  } finally {
    await stream.close();
    await service.close();
  }
});

test("the classification pause runs on the host's clock: once it has passed, the next frame asks again", async () => {
  const driven = drivenConversation([user(1, "Plan dinners")]);
  const fake = fakeRuntime({ kind: "running", submissionId: "sub_1" });
  const asked: string[][] = [];
  let failing = true;
  let clock = 1_000;
  const service = runningOn(driven, fake, {
    runtime: async () => ({
      ...fake.runtime,
      conversation: async () => driven.conversation as never,
      async quietInputs(_botId: string, ids: readonly string[]) {
        asked.push([...ids]);
        if (failing) throw new Error("The session could not be inspected.");
        return new Map(ids.map((id) => [id, false]));
      },
    }),
    now: () => clock,
    // Longer than the test: only a frame after the pause can ask again.
    classifyRetryMs: 60_000,
  });
  try {
    await service.session(BOT_ID, { activity: true });
    const docs = {
      "pi.live": { run: { inputs: [1] } },
      "pi.inbox": { items: [{ id: 21, mode: "followUp", content: [{ type: "text", text: "Also a shopping list." }] }] },
    };
    await driven.emitView([user(1, "Plan dinners")], docs);
    await driven.emitView([user(1, "Plan dinners")], docs);
    assert.equal(asked.length, 1, "within the pause");

    failing = false;
    clock += 60_000;
    await driven.emitView([user(1, "Plan dinners")], docs);
    assert.equal(asked.length, 2, "the pause is over on the host's clock");
    assert.deepEqual((await service.session(BOT_ID, { activity: true })).queued, [
      { submissionId: "21", mode: "queue", text: "Also a shopping list." },
    ]);
  } finally {
    await service.close();
  }
});

test("a host without bot-activity-v1 refuses whenBusy instead of guessing", async () => {
  const fake = fakeRuntime({ kind: "running", submissionId: "sub_1" });
  const service = sessionService(fake.runtime);
  assert.equal(service.supportsActivity, false);
  await assert.rejects(
    service.send(DEVICE_ID, BOT_ID, "send-request-steer-0002", { text: "Hi", whenBusy: "steer" }),
    isError("invalid_request", 400),
  );
  // Turn intents alone are not the token: the Bot service's Chat activity gate is needed too.
  const ungated = new AidenRemoteBotSessionService({ bots: botService(), runtime: async () => fake.runtime, turnIntents: createBotTurnIntents() });
  assert.equal(ungated.supportsActivity, false);
  await assert.rejects(
    ungated.send(DEVICE_ID, BOT_ID, "send-request-queue-0002", { text: "Hi", whenBusy: "queue" }),
    isError("invalid_request", 400),
  );
  await service.close();
  await ungated.close();
});

// ---------------------------------------------------------------------------
// Contract revision 30: the person's messages carry their submissionId
// ---------------------------------------------------------------------------

/** Every `submissionId` key anywhere in a frame or snapshot. */
function submissionIdKeys(value: unknown): number {
  return JSON.stringify(value).match(/"submissionId"/gu)?.length ?? 0;
}

/** The user bubbles a device holds, as `[text, submissionId]`. */
function userBubbles(entries: readonly { type: string; role?: string; text?: string; submissionId?: string }[]) {
  return entries.filter((entry) => entry.type === "message" && entry.role === "user").map((entry) => [entry.text, entry.submissionId ?? null]);
}

test("a person's send carries its submissionId on its bubble in frames and on a reconnect snapshot, and a routine's input never does", async () => {
  const profileDir = mkdtempSync(path.join(os.tmpdir(), "aiden-remote-bot-submission-"));
  durableRoots.push(profileDir);
  const releases: Array<() => void> = [];
  const command = countingTool("run_command", () => new Promise<string>((resolve) => releases.push(() => resolve("done"))));
  const fauxModels = createFauxModels([
    fauxAssistantMessage([fauxToolCall("run_command", { text: "tidy" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("Tidied."),
    fauxAssistantMessage([fauxToolCall("run_command", { text: "brief" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("Inbox is quiet."),
  ]);
  const runtime = await createBotSessionService({
    profileDir,
    models: fauxModels.models,
    extension: recordingDeps({ tools: [{ tool: command, replay: "unsafe" }] }),
    resolveModel: async () => FAUX_MODEL_REF,
    knownBotIds: async () => new Set([BOT_ID]),
  });
  const service = new AidenRemoteBotSessionService({ bots: activityBots(), runtime: async () => runtime, turnIntents: createBotTurnIntents() });
  const holder = await openAudienceStream(service, { activity: true });
  const legacy = await openAudienceStream(service, {});
  const idle = async () => {
    await waitFor(async () => (await runtime.state(BOT_ID)).kind === "idle", { what: "the turn to end" });
  };
  try {
    await holder.until(() => holder.frames.length >= 1, "the first snapshot");
    const receipt = await service.send(DEVICE_ID, BOT_ID, "send-request-submission-0001", { text: "Tidy my notes" });
    await waitFor(() => command.executions.length === 1, { what: "the person's turn to work" });
    // While the turn works, the session lists the person's placed input under its entry.
    assert.deepEqual([...(await runtime.placedSubmissions(BOT_ID)).values()], [receipt.submissionId]);
    releases.shift()!();
    await idle();

    // A routine's input, worked on while the projector watches.
    await runtime.send(BOT_ID, { text: "Check my inbox.", requestId: "routine:task_1:1", label: "Morning brief" });
    await waitFor(() => command.executions.length === 2, { what: "the routine's turn to work" });
    assert.deepEqual([...(await runtime.placedSubmissions(BOT_ID)).values()], [], "a routine's input is not the person's message");
    releases.shift()!();
    await idle();
    await holder.until(
      () => holder.frames.some((frame) => frame.type === "entry" && frame.payload.entry.text === "Inbox is quiet."),
      "the routine's reply",
    );

    const sentFrame = holder.frames.find((frame) => frame.type === "entry" && frame.payload.entry.text === "Tidy my notes")!;
    assert.equal(sentFrame.payload.entry.submissionId, receipt.submissionId, "the bubble's frame names the send it settles");
    const routineFrame = holder.frames.find((frame) => frame.type === "entry" && frame.payload.entry.text === "Check my inbox.")!;
    assert.equal("submissionId" in routineFrame.payload.entry, false);

    // Both turns are done, so the session no longer lists them; the projector remembers.
    assert.deepEqual([...(await runtime.placedSubmissions(BOT_ID)).values()], []);
    const reconnect = await openAudienceStream(service, { activity: true });
    try {
      await reconnect.until(() => reconnect.frames.length >= 1, "the reconnect snapshot");
      const expected = [["Tidy my notes", receipt.submissionId], ["Check my inbox.", null]];
      assert.deepEqual(userBubbles(reconnect.frames[0]!.payload.session.entries), expected);
      assert.deepEqual(userBubbles((await service.session(BOT_ID, { activity: true })).entries), expected, "a fetch agrees");
    } finally {
      await reconnect.close();
    }

    assert.equal(legacy.raw.some((data) => data.includes("submissionId")), false, "a device without bot:activity never sees the key");
    assert.equal(submissionIdKeys(await service.session(BOT_ID)), 0);
    assert.ok(gapless(holder.frames) && gapless(legacy.frames));
  } finally {
    for (const release of releases) release();
    await holder.close();
    await legacy.close();
    await service.close();
    await runtime.shutdown();
  }
});

test("only the person's own message is tagged: a routine's input and a question answer never carry a submissionId", () => {
  const entries = projectBotSessionEntries(
    [
      user(1, "Plan dinners"),
      notice(2, { notice: "routine", label: "Morning brief", requestId: "routine:t:1" }),
      user(3, "Check my inbox."),
      {
        id: 4,
        kind: "pi.tool-result",
        model: [{ role: "toolResult", toolName: "ask_user_question", isError: false, content: [{ type: "text", text: "Answer: Blue" }], details: { answerText: "Blue" } }],
      },
      assistant(5, "Done."),
      user(6, "Thanks"),
    ] as never,
    // A runtime that wrongly listed every entry: only the person's own messages take an id.
    new Map([["1", "17"], ["3", "18"], ["4", "19"], ["5", "20"], ["6", "bad id"]]),
  );
  assert.deepEqual(
    entries.map((entry) => (entry.type === "message" ? [entry.role, entry.text, entry.submissionId ?? null] : [entry.type])),
    [
      ["user", "Plan dinners", "17"],
      ["user", "Check my inbox.", null],
      ["user", "Blue", null],
      ["assistant", "Done.", null],
      ["user", "Thanks", null],
    ],
  );
});

test("a device without bot:activity gets each tagged bubble without its id, at the same seq", async () => {
  const driven = drivenConversation([]);
  const fake = fakeRuntime({ kind: "running", submissionId: "17" });
  let placed = new Map<string, string>();
  const service = runningOn(driven, { ...fake, runtime: { ...fake.runtime, placedSubmissions: async () => placed } });
  const holder = await openAudienceStream(service, { activity: true });
  const legacy = await openAudienceStream(service, {});
  try {
    await holder.until(() => holder.frames.length >= 1, "the holder snapshot");
    await legacy.until(() => legacy.frames.length >= 1, "the legacy snapshot");
    placed = new Map([["1", "17"]]);
    await driven.emit([user(1, "Plan dinners")]);
    // The turn ended: the session forgets the submission, the projector does not.
    placed = new Map();
    fake.setState({ kind: "idle" });
    await driven.emit([user(1, "Plan dinners"), assistant(2, "Monday: soup.")]);
    await holder.until(() => holder.frames.some((frame) => frame.type === "entry" && frame.payload.entry.role === "assistant"), "the reply");
    await legacy.until(() => legacy.frames.length === holder.frames.length, "the same frames");

    const bubbles = (frames: Frame[]) => frames.filter((frame) => frame.type === "entry" && frame.payload.entry.role === "user");
    assert.deepEqual(bubbles(holder.frames).map((frame) => frame.payload.entry.submissionId), ["17"], "one entry frame, never updated");
    const { submissionId: _submissionId, ...untagged } = bubbles(holder.frames)[0]!.payload.entry;
    assert.deepEqual(bubbles(legacy.frames).map((frame) => frame.payload.entry), [untagged], "the same bubble, without its id");
    assert.deepEqual(legacy.frames.map((frame) => frame.seq), holder.frames.map((frame) => frame.seq), "every device stays on one seq");
    assert.equal(legacy.raw.some((data) => data.includes("submissionId")), false);

    assert.deepEqual(userBubbles((await service.session(BOT_ID, { activity: true })).entries), [["Plan dinners", "17"]]);
    assert.equal(submissionIdKeys(await service.session(BOT_ID)), 0, "a fetch without bot:activity has no submissionId");
  } finally {
    await holder.close();
    await legacy.close();
    await service.close();
  }
});

test("tags stay on every bubble in view, past the window, and no old bubble is ever sent again", async () => {
  const driven = drivenConversation([]);
  const fake = fakeRuntime({ kind: "running", submissionId: "1" });
  let asked = 0;
  let current: RawEntry[] = [];
  const service = runningOn(driven, {
    ...fake,
    runtime: {
      ...fake.runtime,
      async placedSubmissions() {
        asked += 1;
        // Only the message just sent is still placed; every earlier turn is done.
        const newest = current[current.length - 1];
        return new Map(newest ? [[String(newest.id), `sub_${newest.id}`]] : []);
      },
    },
  });
  const total = AIDEN_REMOTE_BOT_SESSION_MAX_ENTRIES + 10;
  const holder = await openAudienceStream(service, { activity: true });
  const legacy = await openAudienceStream(service, {});
  try {
    await holder.until(() => holder.frames.length >= 1, "the holder snapshot");
    await legacy.until(() => legacy.frames.length >= 1, "the legacy snapshot");
    for (let id = 1; id <= total; id += 1) {
      current = [...current, user(id, `Message ${id}`)];
      await driven.emit(current);
      if (id % 50 === 0) await driven.emit(current, "Working"); // streaming frames ask nothing
    }
    const entryFrames = (frames: Frame[]) => frames.filter((frame) => frame.type === "entry");
    await holder.until(() => entryFrames(holder.frames).length >= total, "every message");
    await legacy.until(() => legacy.frames.length === holder.frames.length, "the same frames");

    for (const stream of [holder, legacy]) {
      // Each bubble is sent exactly once, when it is new: never again when an older one leaves view.
      assert.deepEqual(
        entryFrames(stream.frames).map((frame) => frame.payload.entry.id),
        Array.from({ length: total }, (_, index) => `entry_${index + 1}`),
      );
      assert.ok(gapless(stream.frames));
    }
    assert.deepEqual(legacy.frames.map((frame) => frame.seq), holder.frames.map((frame) => frame.seq));
    assert.deepEqual(
      entryFrames(holder.frames).map((frame) => frame.payload.entry.submissionId),
      Array.from({ length: total }, (_, index) => `sub_${index + 1}`),
    );
    assert.equal(asked, total, "one lookup per new message");

    // Long after their turns ended, every bubble in view still names its send.
    const bubbles = userBubbles((await service.session(BOT_ID, { activity: true })).entries);
    assert.equal(bubbles.length, AIDEN_REMOTE_BOT_SESSION_MAX_ENTRIES);
    assert.deepEqual(bubbles.map(([, id]) => id), bubbles.map(([text]) => `sub_${String(text).slice("Message ".length)}`));
    assert.equal(legacy.raw.some((data) => data.includes("submissionId")), false);
  } finally {
    await holder.close();
    await legacy.close();
    await service.close();
  }
});

test("a failed placement lookup is reported, and that bubble falls back to its text", async () => {
  const driven = drivenConversation([]);
  const fake = fakeRuntime({ kind: "running", submissionId: "1" });
  const reports: unknown[] = [];
  let failing = true;
  const service = runningOn(
    driven,
    {
      ...fake,
      runtime: {
        ...fake.runtime,
        async placedSubmissions() {
          if (failing) throw new Error("The session could not be inspected.");
          return new Map([["2", "sub_2"]]);
        },
      },
    },
    { onReport: (_botId, error) => reports.push(error) },
  );
  try {
    await service.session(BOT_ID, { activity: true });
    await driven.emit([user(1, "Plan dinners")]);
    failing = false;
    await driven.emit([user(1, "Plan dinners"), user(2, "And lunches")]);
    assert.deepEqual(userBubbles((await service.session(BOT_ID, { activity: true })).entries), [
      ["Plan dinners", null],
      ["And lunches", "sub_2"],
    ]);
    assert.deepEqual(reports.map((error) => (error as Error).message), ["The session could not be inspected."]);
  } finally {
    await service.close();
  }
});

/** Publish order: frames one publish emits never go back in this order. */
const PUBLISH_ORDER = ["entry", "partial", "state", "question", "approval", "activity", "queued"];

test("a steer and a follow-up placed mid-turn take their queued ids, two at one boundary each their own, in the publish that drops them from Queued", async () => {
  const profileDir = mkdtempSync(path.join(os.tmpdir(), "aiden-remote-bot-placed-"));
  durableRoots.push(profileDir);
  const releases: Array<() => void> = [];
  const command = countingTool("run_command", () => new Promise<string>((resolve) => releases.push(() => resolve("done"))));
  const fauxModels = createFauxModels([
    fauxAssistantMessage([fauxToolCall("run_command", { text: "plan" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("Vegetarian, no mushrooms."),
    fauxAssistantMessage("Here is the shopping list."),
  ]);
  const runtime = await createBotSessionService({
    profileDir,
    models: fauxModels.models,
    extension: recordingDeps({ tools: [{ tool: command, replay: "unsafe" }] }),
    resolveModel: async () => FAUX_MODEL_REF,
    knownBotIds: async () => new Set([BOT_ID]),
  });
  const service = new AidenRemoteBotSessionService({ bots: activityBots(), runtime: async () => runtime, turnIntents: createBotTurnIntents() });
  const stream = await openAudienceStream(service, { activity: true });
  try {
    await stream.until(() => stream.frames.length >= 1, "the first snapshot");
    const first = await service.send(DEVICE_ID, BOT_ID, "send-request-placed-0001", { text: "Plan dinners" });
    await waitFor(() => command.executions.length === 1, { what: "the turn to work" });
    const followUp = await service.send(DEVICE_ID, BOT_ID, "send-request-placed-0002", { text: "Also a shopping list.", whenBusy: "queue" });
    const steer = await service.send(DEVICE_ID, BOT_ID, "send-request-placed-0003", { text: "Keep it vegetarian.", whenBusy: "steer" });
    const second = await service.send(DEVICE_ID, BOT_ID, "send-request-placed-0004", { text: "No mushrooms.", whenBusy: "steer" });
    const ids = [followUp, steer, second].map((receipt) => receipt.submissionId);
    await stream.until(
      () => stream.frames.some((frame) => frame.type === "queued" && frame.payload.queued.length === 3),
      "all three waiting",
    );
    releases.shift()!();
    await stream.until(
      () => stream.frames.some((frame) => frame.type === "entry" && frame.payload.entry.text === "Here is the shopping list."),
      "the follow-up's reply",
    );

    const bubbleFrame = (text: string) =>
      stream.frames.findIndex((frame) => frame.type === "entry" && frame.payload.entry.role === "user" && frame.payload.entry.text === text);
    const placedIds = ["Plan dinners", "Also a shopping list.", "Keep it vegetarian.", "No mushrooms."].map(
      (text) => stream.frames[bubbleFrame(text)]!.payload.entry.submissionId,
    );
    assert.deepEqual(placedIds, [first.submissionId, ...ids], "each bubble names its own send");
    assert.equal(new Set(placedIds).size, 4);

    for (const [text, id] of [["Also a shopping list.", ids[0]], ["Keep it vegetarian.", ids[1]], ["No mushrooms.", ids[2]]] as const) {
      const at = bubbleFrame(text);
      const listing = stream.frames.map((frame) =>
        frame.type === "queued" && frame.payload.queued.some((item: { submissionId: string }) => item.submissionId === id));
      const lastListed = listing.lastIndexOf(true);
      const dropped = stream.frames.findIndex((frame, index) => index > lastListed && frame.type === "queued");
      assert.ok(lastListed < at && at < dropped, `${text}: listed, then placed, then dropped`);
      // From the bubble to the Queued change, the frames follow one publish's order.
      const order = stream.frames.slice(at, dropped + 1).map((frame) => PUBLISH_ORDER.indexOf(frame.type));
      assert.deepEqual(order, [...order].sort((left, right) => left - right), `${text}: dropped in the publish that placed it`);
    }
    // Pi places waiting inputs at a boundary: at least two of them landed in one publish
    // (consecutive bubble frames), and each still named its own send.
    const together = stream.frames.findIndex((frame, index) => {
      const next = stream.frames[index + 1];
      return frame.type === "entry" && frame.payload.entry.role === "user"
        && next?.type === "entry" && next.payload.entry.role === "user";
    });
    assert.ok(together > 0, "two inputs placed at one boundary");
    const pair = [stream.frames[together]!, stream.frames[together + 1]!].map((frame) => frame.payload.entry.submissionId);
    assert.ok(pair.every((id) => ids.includes(id)) && pair[0] !== pair[1], JSON.stringify(pair));
    assert.ok(gapless(stream.frames));
  } finally {
    for (const release of releases) release();
    await stream.close();
    await service.close();
    await runtime.shutdown();
  }
});
