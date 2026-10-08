import assert from "node:assert/strict";
import test from "node:test";
import type { BotDefinition } from "../../renderer/shared/bots.js";
import { AidenRemoteBotService } from "./aiden-remote-bots.js";
import {
  AidenRemoteBotSessionService,
  projectBotSessionEntries,
  projectBotSessionState,
  type AidenRemoteBotSessionRuntime,
} from "./aiden-remote-bot-session.js";
import type { AskUserQuestionV1 } from "../../renderer/shared/ask-user-question.js";
import { createBotQuestions } from "./bot-runtime/bot-questions.js";
import type { BotSessionState } from "./bot-runtime/bot-session-service.js";

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
    async state() {
      return state;
    },
    async conversation() {
      return conversation as never;
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
