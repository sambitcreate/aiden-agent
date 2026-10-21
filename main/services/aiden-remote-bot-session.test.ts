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
import { AidenRemoteAttachmentStore } from "./aiden-remote-attachments.js";
import { AidenRemoteBotService } from "./aiden-remote-bots.js";
import {
  AidenRemoteBotSessionService,
  projectAidenRemoteBotMemory,
  projectBotSessionActivity,
  projectBotSessionEntries,
  projectBotSessionState,
  redactRemoteError,
  tailWithinJsonBytes,
  type AidenRemoteBotSessionRuntime,
} from "./aiden-remote-bot-session.js";
import type { AskUserQuestionV1 } from "../../renderer/shared/ask-user-question.js";
import { createBotApprovals } from "./bot-runtime/bot-approvals.js";
import { createBotHandoffs } from "./bot-runtime/bot-handoffs.js";
import { signInCandidate } from "./bot-runtime/bot-sign-in-tool.js";
import type { BotHandoffOpened } from "./bot-runtime/bot-handoff-open.js";
import type { BotPendingHandoff } from "../../renderer/shared/bot-handoffs.js";
import { createBotQuestions } from "./bot-runtime/bot-questions.js";
import { createBotTurnIntents } from "./bot-runtime/bot-turn-intents.js";
import { createBotLiveProjection, createBotRunStarts } from "./bot-runtime/live-projection.js";
import {
  AIDEN_REMOTE_BOT_SESSION_MAX_ENTRIES,
  AIDEN_REMOTE_MAX_SSE_FRAME_BYTES,
  parseAidenRemoteBotApproval,
  parseAidenRemoteBotList,
  parseAidenRemoteBotQuestion,
  parseAidenRemoteBotSession,
  parseAidenRemoteBotSessionEntry,
  parseAidenRemoteBotSessionEvent,
  parseAidenRemoteBotSummary,
  parseAidenSseFrames,
} from "./aiden-remote-protocol.js";
import {
  BOT_NOTICE_ENTRY_KIND,
  BotSessionError,
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

function bot(id = BOT_ID, name = "Planner"): BotDefinition {
  return {
    id,
    revision: "bot_revision_1",
    name,
    instructions: "Plan carefully.",
    avatar: { version: 1, shape: "orb", color: "sky" },
    createdAt: 1_000,
    updatedAt: 2_000,
  };
}

/** A Bot store with one live Bot and no other side effects. */
function botService(options: { sessionStates?: Map<string, "needs_model" | "idle">; name?: string } = {}) {
  const application = {
    async get(botId: string) {
      return botId === BOT_ID ? bot(BOT_ID, options.name) : null;
    },
    async list() {
      return [bot(BOT_ID, options.name)];
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
  const calls = { resume: 0, abort: 0, dismiss: 0, pause: [] as string[], unpause: 0 };
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
      // Like the real service: a person's pause refuses before anything runs.
      if (state.kind === "paused") throw new BotSessionError("paused_by_person");
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
    async pause(_botId, by) {
      calls.pause.push(by);
      // Idempotent like the real service: the first pause's time and origin stay.
      if (state.kind !== "paused") state = { kind: "paused", since: 5_000, by };
      return state;
    },
    async unpause() {
      calls.unpause += 1;
      if (state.kind === "paused") state = { kind: "idle" };
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
  for (const attempt of ["first", "retry"]) {
    await assert.rejects(
      service.answerQuestion(DEVICE_ID, BOT_ID, WAIT_ID, "answer-request-0004", option("Blue")),
      isError("question_expired", 409),
      `${attempt}: the same request UUID gets the same refusal, not a server error`,
    );
  }
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

test("photos sent without words read as a caption on phones, and words keep their own text", () => {
  const image = { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" };
  const withContent = (id: number, content: unknown[]): RawEntry => ({
    id, kind: "pi.user", model: [{ role: "user", content, timestamp: 1_700_000_000_000 }],
  });
  const texts = projectBotSessionEntries([
    withContent(1, [image]),
    withContent(2, [image, image]),
    withContent(3, [{ type: "text", text: "What is this?" }, image]),
  ] as never).map((entry) => (entry.type === "message" ? entry.text : entry.type));
  assert.deepEqual(texts, ["Sent a photo", "Sent 2 photos", "What is this?"]);
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

async function interruptedDurableBot(options: { handoffs?: boolean; stateChanges?: boolean } = {}) {
  const profileDir = mkdtempSync(path.join(os.tmpdir(), "aiden-remote-bot-session-"));
  durableRoots.push(profileDir);
  const child = spawnHarnessChild("stream", [profileDir, "bot:killed", "req-killed"]);
  await child.waitFor("STREAMING");
  await child.kill();
  const fauxModels = createFauxModels([fauxAssistantMessage("resumed answer"), fauxAssistantMessage("extra")]);
  // The runtime's own state bridge, as the desktop exposes it (`onBotSessionStateChange`).
  const stateListeners = new Set<(botId: string) => void>();
  const runtime = await createBotSessionService({
    profileDir,
    models: fauxModels.models,
    extension: recordingDeps(),
    resolveModel: async () => FAUX_MODEL_REF,
    knownBotIds: async () => new Set(["bot:killed"]),
    onStateChange: (botId) => {
      for (const listener of stateListeners) listener(botId);
    },
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
  const service = new AidenRemoteBotSessionService({
    bots,
    runtime: async () => runtime,
    // Revision 37: a host wired for hand-offs and pause on phones.
    ...(options.handoffs ? { handoffs: createBotHandoffs(), openHandoffOnMac: async () => "focused" as const } : {}),
    ...(options.stateChanges
      ? {
          stateChanges: (listener: (botId: string) => void) => {
            stateListeners.add(listener);
            return () => void stateListeners.delete(listener);
          },
        }
      : {}),
  });
  return { runtime, service, fauxModels, stateListeners, markDeleted: () => { exists = false; } };
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

test("a paused Bot reads as unavailable to phones on every surface the shipped contract decodes, and its writes are stale", async () => {
  const { runtime, service, fauxModels } = await interruptedDurableBot();
  const stream = await openStream(service, "bot:killed");
  try {
    await stream.until(() => stream.frames.length >= 1, "the first snapshot");
    const paused = await runtime.pause("bot:killed", "mac");
    assert.equal(paused.kind, "paused");

    // Snapshot: the shipped (revision 35) parser decodes it, as unavailable, with its transcript.
    const session = parseAidenRemoteBotSession(JSON.parse(JSON.stringify(await service.session("bot:killed"))));
    assert.deepEqual([session.state, session.interrupted], ["unavailable", false]);
    assert.ok(session.entries.some((entry) => entry.type === "message" && entry.text === "hello"), "the transcript still shows");

    // Stop has nothing to stop; its answer is the same unavailable view.
    assert.deepEqual(await service.stop("device_a", "bot:killed", "stop-request-00p1", {}), {
      state: "unavailable",
      interrupted: false,
    });
    // Frames: every frame already went through the shipped event parser in `openStream`.
    await stream.until(
      () => stream.frames.some((frame) => (frame.type === "snapshot" ? frame.payload.session.state : frame.payload?.state) === "unavailable"),
      "the paused state on the stream",
    );
    const views = stream.frames.flatMap((frame) =>
      frame.type === "state" ? [frame.payload.state] : frame.type === "snapshot" ? [frame.payload.session.state] : [],
    );
    assert.equal(views.includes("paused"), false, "no frame names a state shipped clients cannot decode");

    // Writes: refused with a code shipped clients know, and nothing runs.
    for (const write of [
      () => service.send("device_a", "bot:killed", "send-request-00p1", { text: "are you there?" }),
      () => service.resume("device_a", "bot:killed", "resume-request-0p1", {}),
      () => service.dismiss("device_a", "bot:killed", "dismiss-request-0p1", {}),
    ]) {
      await assert.rejects(write(), isError("operation_stale", 409));
    }
    assert.equal(fauxModels.calls(), 0);

    // The refusals left no ledger record: once unpaused, the same request runs.
    await runtime.unpause("bot:killed");
    assert.equal((await service.session("bot:killed")).state, "interrupted");
    assert.equal((await service.resume("device_a", "bot:killed", "resume-request-0p1", {})).state, "running");
    await waitFor(async () => (await runtime.state("bot:killed")).kind === "idle", { what: "the resumed turn" });
    assert.equal(fauxModels.calls(), 1);
  } finally {
    await stream.close();
    await service.close();
    await runtime.shutdown();
  }
});

test("a paused Bot's list row and summary decode with the shipped parsers and read unavailable", async () => {
  const pausedState = projectBotSessionState({ kind: "paused", since: 1, by: "phone", interrupted: "sub_1" }).state;
  const bots = new AidenRemoteBotService({
    application: {
      async get(botId: string) {
        return botId === BOT_ID ? bot() : null;
      },
      async list() {
        return [bot()];
      },
    } as never,
    chatStore: { get: async () => null },
    sessionStates: async (ids) => new Map(ids.map((id) => [id, pausedState] as const)),
  });
  const list = parseAidenRemoteBotList(JSON.parse(JSON.stringify(await bots.list())));
  assert.deepEqual(list.bots.map((summary) => summary.sessionState), ["unavailable"]);
  assert.equal(parseAidenRemoteBotSummary(JSON.parse(JSON.stringify(await bots.summaryOf(BOT_ID)))).sessionState, "unavailable");
});

test("a paused state is unavailable on the wire, whatever turn waits underneath", () => {
  assert.deepEqual(projectBotSessionState({ kind: "paused", since: 1, by: "phone", interrupted: "sub_1" }), {
    state: "unavailable",
    interrupted: false,
  });
  assert.deepEqual(projectBotSessionState({ kind: "paused", since: 1, by: "mac" }), { state: "unavailable", interrupted: false });
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
    for (const attempt of ["first", "retry"]) {
      await assert.rejects(
        service.respondApproval(DEVICE_ID, waiting.waitId, "allow", "approve-request-0003"),
        isError("capability_denied", 403),
        `${attempt}: the same request UUID gets the same refusal, not a server error`,
      );
    }
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
    // 65 short, individually valid facts fit the 2,750-character budget many times over.
    const facts = Array.from({ length: 65 }, (_, index) => `Likes tea ${index + 1}.`);
    assert.ok(facts.join("\n§\n").length < 2_750);
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
  audience: { cards?: boolean; activity?: boolean; handoffs?: boolean },
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
  /** The SSE blocks as sent on the wire (id, event and data lines, without the blank separator). */
  const blocks: string[] = [];
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
        blocks.push(block);
        raw.push(data.slice(6));
        frames.push(parseAidenRemoteBotSessionEvent(JSON.parse(data.slice(6))) as unknown as Frame);
      }
    }
  })();
  return {
    frames,
    raw,
    blocks,
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

/** A message of `codePoints` CJK code points (three UTF-8 bytes each), led by a label that tells it apart. */
function cjkMessage(label: string, codePoints = 32_000): string {
  return `${label} ${"一".repeat(codePoints - [...label].length - 1)}`;
}

/** The person's waiting follow-ups as the Mac's `pi.inbox` holds them; each id is its submission id. */
function waitingInbox(texts: readonly string[]): Record<string, unknown> {
  return {
    "pi.inbox": {
      items: texts.map((text, index) => ({ id: 30 + index, mode: "followUp", content: [{ type: "text", text }] })),
    },
  };
}

/** Every SSE block a device was sent parses through the native frame reader and stays inside the transport limit. */
function assertEveryFrameFits(blocks: readonly string[]) {
  assert.ok(blocks.length > 0, "the device was sent frames");
  for (const block of blocks) {
    assert.ok(Buffer.byteLength(block, "utf8") <= AIDEN_REMOTE_MAX_SSE_FRAME_BYTES, "a frame exceeds the transport limit");
    assert.equal(parseAidenSseFrames(block).length, 1);
  }
}

test("twenty maximum-length CJK queued messages keep every frame and snapshot inside the transport's frame limit", async () => {
  const driven = drivenConversation([user(1, "Plan dinners")]);
  const fake = fakeRuntime({ kind: "running", submissionId: "sub_1" });
  const service = runningOn(driven, fake);
  const stream = await openAudienceStream(service, { activity: true });
  try {
    await stream.until(() => stream.frames.length >= 1, "the first snapshot");
    await driven.emitView(
      [user(1, "Plan dinners")],
      waitingInbox(Array.from({ length: 20 }, (_, index) => cjkMessage(`m${index}`))),
    );
    await stream.until(() => stream.frames.some((frame) => frame.type === "queued"), "the queued frame");
    assertEveryFrameFits(stream.blocks);

    const session = await service.session(BOT_ID, { activity: true });
    assert.ok(Buffer.byteLength(JSON.stringify(session), "utf8") <= AIDEN_REMOTE_MAX_SSE_FRAME_BYTES, "the snapshot fits");
    const queuedFrames = stream.frames.filter((frame) => frame.type === "queued");
    const shown = queuedFrames[queuedFrames.length - 1]!.payload.queued;
    assert.ok(shown.length >= 1 && shown.length < 20, "some of the twenty fit, and the rest are left out");
    assert.deepEqual(session.queued, shown, "the snapshot agrees with the queued frame");
  } finally {
    await stream.close();
    await service.close();
  }
});

test("the queued frame keeps the oldest messages that fit, in the order sent, and each kept text is whole", async () => {
  const driven = drivenConversation([user(1, "Plan dinners")]);
  const fake = fakeRuntime({ kind: "running", submissionId: "sub_1" });
  const service = runningOn(driven, fake);
  const stream = await openAudienceStream(service, { activity: true });
  try {
    await stream.until(() => stream.frames.length >= 1, "the first snapshot");
    const texts = [...Array.from({ length: 19 }, (_, index) => cjkMessage(`m${index}`)), "Last, a short one."];
    await driven.emitView([user(1, "Plan dinners")], waitingInbox(texts));
    await stream.until(() => stream.frames.some((frame) => frame.type === "queued"), "the queued frame");

    const queuedFrames = stream.frames.filter((frame) => frame.type === "queued");
    const queued = queuedFrames[queuedFrames.length - 1]!.payload.queued as Array<{ submissionId: string; text: string }>;
    assert.ok(queued.length >= 1 && queued.length < texts.length, "some of the messages fit, and the rest are left out");
    const sentIds = texts.map((_, index) => String(30 + index));
    assert.deepEqual(queued.map((item) => item.submissionId), sentIds.slice(0, queued.length), "the oldest that fit, in order");
    assert.deepEqual(queued.map((item) => item.text), texts.slice(0, queued.length), "no kept text is cut");
  } finally {
    await stream.close();
    await service.close();
  }
});

test("a transcript near its own budget with a long partial and a full queue still fits the frame limit, and the transcript gives way", async () => {
  const driven = drivenConversation([user(1, "Plan dinners")]);
  const fake = fakeRuntime({ kind: "running", submissionId: "sub_1" });
  const service = runningOn(driven, fake);
  const stream = await openAudienceStream(service, { activity: true });
  try {
    await stream.until(() => stream.frames.length >= 1, "the first snapshot");
    // Four replies of 64,000 code points (about 768 KB) fill the transcript's own cap on their own.
    const transcript = [
      user(1, "Plan dinners"),
      assistant(2, cjkMessage("a", 64_000)),
      assistant(3, cjkMessage("b", 64_000)),
      assistant(4, cjkMessage("c", 64_000)),
      assistant(5, cjkMessage("d", 64_000)),
    ];
    await driven.emitView(transcript, {
      "pi.live": { generation: { message: { content: [{ type: "text", text: cjkMessage("p", 32_000) }] } } },
      ...waitingInbox(Array.from({ length: 20 }, (_, index) => cjkMessage(`m${index}`))),
    });
    await stream.until(() => stream.frames.some((frame) => frame.type === "queued"), "the queued frame");
    assertEveryFrameFits(stream.blocks);

    const session = await service.session(BOT_ID, { activity: true });
    assert.ok(Buffer.byteLength(JSON.stringify(session), "utf8") <= AIDEN_REMOTE_MAX_SSE_FRAME_BYTES, "the snapshot fits");
    assert.ok(session.partial, "the partial is in the snapshot");
    assert.ok((session.queued?.length ?? 0) >= 1, "the queued list is in the snapshot");
    assert.equal(session.hasOlder, true, "the transcript gave way to the partial and the queue");
    assert.equal(session.entries[session.entries.length - 1]!.id, "entry_5", "the newest replies stay");
  } finally {
    await stream.close();
    await service.close();
  }
});

/** U+0001: a control character, so each code point is written as a six-byte \u escape (the JSON worst case). */
const ESCAPED = "\u0001";

/** A message of `codePoints` escaped code points, led by a label that tells it apart. */
function escapedMessage(label: string, codePoints: number): string {
  return `${label} ${ESCAPED.repeat(codePoints - [...label].length - 1)}`;
}

/** Four questions at the protocol maxima, every character a six-byte escape. */
function maximalQuestions(): AskUserQuestionV1[] {
  return Array.from({ length: 4 }, (_, question) => ({
    question: `${question} ${ESCAPED.repeat(998)}`, // 1,000 code points
    header: `h${question}${ESCAPED.repeat(14)}`, // 16
    multiSelect: false,
    options: Array.from({ length: 5 }, (_, option) => ({
      label: `o${option} ${ESCAPED.repeat(57)}`, // 60
      description: `d${option} ${ESCAPED.repeat(1_997)}`, // 2,000
    })),
  }));
}

test("the parts that ship whole at the protocol maxima take well under half the frame limit", () => {
  // Worst case in JSON bytes, six per code point: four questions of
  // (1,000 + 16 + 5 x (60 + 2,000)) = 44,304 code points, 265,824 bytes; an
  // approval of (2,000 + 120 + 128) = 2,248 code points, 13,488 bytes. State
  // and activity add a few hundred bytes, so the group is under 300 KB, under
  // the 512 KiB half of the 1 MiB frame limit. The partial (600,000 bytes) and
  // the queued list (at most 256 KiB) share what is left of the snapshot budget.
  const question = parseAidenRemoteBotQuestion({ waitId: WAIT_ID, toolCallId: ESCAPED.repeat(128), questions: maximalQuestions() });
  const approval = parseAidenRemoteBotApproval({
    waitId: WAIT_ID,
    toolCallId: ESCAPED.repeat(128),
    toolName: ESCAPED.repeat(120),
    summary: ESCAPED.repeat(2_000),
    canAllow: true,
  });
  const bytes = Buffer.byteLength(JSON.stringify({ question, approval }), "utf8");
  assert.ok(bytes < AIDEN_REMOTE_MAX_SSE_FRAME_BYTES / 2, `the question and approval take ${bytes} bytes`);
});

test("a partial over its share is cut from the front on a code-point boundary, keeping the newest words", () => {
  // From the end, JSON content bytes: a 4-byte emoji, three bytes per CJK
  // character, six per escape. 4 + 3 x 5 + 6 = 25 keeps one escape before the CJK run.
  const text = `head${ESCAPED.repeat(10)}一一一一一😀`;
  const tail = tailWithinJsonBytes(text, 25);
  assert.equal(tail, `${ESCAPED}一一一一一😀`);
  const contentBytes = (value: string) => Buffer.byteLength(JSON.stringify(value), "utf8") - 2;
  assert.ok(contentBytes(tail) <= 25, "the tail fits its share");
  assert.ok(contentBytes(`${ESCAPED}${tail}`) > 25, "one more code point would not fit: the cut is as long as it can be");
  assert.equal(tailWithinJsonBytes("short", 100), "short", "text that fits is kept whole");
  assert.equal(tailWithinJsonBytes("a😀", 3), "", "an emoji is never split, even to its lone half");
});

test("the probe at the protocol maxima keeps every frame and the snapshot inside the frame limit", async () => {
  // A 100,000-code-point escaped partial, four maximal questions and three
  // 14,000-code-point escaped queued messages (84,000 JSON bytes each), plus an
  // escaped 100,000-code-point reply. Written out, the old snapshot was about 1.12 MB.
  const driven = drivenConversation([user(1, "Plan dinners")]);
  const fake = fakeRuntime({ kind: "running", submissionId: "sub_1" });
  const questions = createBotQuestions();
  const service = runningOn(driven, fake, { questions, notifyBotsChanged: () => {} });
  const stream = await openAudienceStream(service, { activity: true });
  const asking = new AbortController();
  try {
    await stream.until(() => stream.frames.length >= 1, "the first snapshot");
    await driven.emitView(
      [user(1, "Plan dinners"), assistant(2, ESCAPED.repeat(100_000))],
      {
        "pi.live": { generation: { message: { content: [{ type: "text", text: ESCAPED.repeat(100_000) }] } } },
        ...waitingInbox(Array.from({ length: 3 }, (_, index) => escapedMessage(`m${index}`, 14_000))),
      },
    );
    const asked = questions.request({
      botId: BOT_ID,
      waitId: WAIT_ID,
      toolCallId: "call_1",
      questions: maximalQuestions(),
      signal: asking.signal,
    });
    asked.catch(() => undefined);
    const kinds = ["entry", "partial", "question", "queued"];
    await stream.until(
      () => kinds.every((kind) => stream.frames.some((frame) => frame.type === kind)),
      "the entry, partial, question and queued frames",
    );
    // Each frame on its own is inside the limit, and each parses through the native reader.
    assertEveryFrameFits(stream.blocks);

    const session = await service.session(BOT_ID, { activity: true });
    const wire = JSON.stringify(session);
    assert.ok(Buffer.byteLength(wire, "utf8") < AIDEN_REMOTE_MAX_SSE_FRAME_BYTES, "the snapshot is inside the frame limit");
    assert.deepEqual(parseAidenRemoteBotSession(JSON.parse(wire)), session, "the snapshot parses back to itself");
    // Priority order: the question (about 268 KB) and the whole partial (600,000 bytes) ship.
    // What is left, about 115 KB of 983,040, takes one 84,000-byte queued message: the second
    // would bring the list to 168,000 bytes. The transcript gets nothing and says so.
    assert.deepEqual(session.question?.questions, maximalQuestions(), "the question ships whole");
    assert.equal(session.partial, ESCAPED.repeat(100_000), "the partial ships whole");
    assert.deepEqual(session.queued?.map((item) => [item.submissionId, item.text]), [
      ["30", escapedMessage("m0", 14_000)],
    ]);
    assert.deepEqual(session.entries, [], "the reply that no longer fits is left out");
    assert.equal(session.hasOlder, true);
  } finally {
    asking.abort();
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

test("staged Bot uploads reach the runtime once: images as images, text files after the words", async () => {
  const fixture = (await contractFixture()).botAttachments;
  const fake = fakeRuntime({ kind: "idle" });
  const sends: Array<{ text: string; requestId: string; attachments?: unknown }> = [];
  let ids = 0;
  const attachments = new AidenRemoteAttachmentStore({
    randomId: () => `att_${String(++ids).padStart(43, "x")}`,
  });
  const service = new AidenRemoteBotSessionService({
    bots: botService(),
    runtime: async () => ({
      ...fake.runtime,
      async send(_botId, input) {
        sends.push(input);
        return { submissionId: String(sends.length), deduped: false };
      },
    }),
    attachments,
  });
  try {
    assert.equal(service.supportsAttachments, true);
    const image = await service.uploadAttachment(DEVICE_ID, BOT_ID, fixture.imageUpload.request);
    const text = await service.uploadAttachment(DEVICE_ID, BOT_ID, fixture.textUpload.request);
    assert.deepEqual(
      [image.kind, image.size, text.kind, text.size],
      [fixture.imageUpload.response.kind, fixture.imageUpload.response.size, fixture.textUpload.response.kind, fixture.textUpload.response.size],
    );

    // Another device can't spend this phone's references, and the refusal leaves them usable.
    await assert.rejects(
      service.send("device_2", BOT_ID, "send-request-attach-0000", { text: "Mine now", attachmentIds: [image.id] }),
      isError("handle_wrong_device", 403),
    );

    const body = { text: "What did I spend?", attachmentIds: [image.id, text.id] };
    await service.send(DEVICE_ID, BOT_ID, "send-request-attach-0001", body);
    // A retried request replays its receipt without asking for the spent references again.
    await service.send(DEVICE_ID, BOT_ID, "send-request-attach-0001", body);
    assert.equal(sends.length, 1);
    assert.equal(sends[0]!.text, "What did I spend?\n\nnotes.md:\n# Groceries\n- oats");
    assert.deepEqual(sends[0]!.attachments, [
      { type: "image", mimeType: "image/png", data: fixture.imageUpload.request.data },
    ]);

    await assert.rejects(
      service.send(DEVICE_ID, BOT_ID, "send-request-attach-0002", { text: "Again", attachmentIds: [image.id] }),
      isError("handle_invalid", 409),
    );

    // Words are optional with attachments; a removed upload can't be sent.
    const only = await service.uploadAttachment(DEVICE_ID, BOT_ID, fixture.imageUpload.request);
    await service.send(DEVICE_ID, BOT_ID, "send-request-attach-0003", { text: "", attachmentIds: [only.id] });
    assert.equal(sends[1]!.text, "");
    const removed = await service.uploadAttachment(DEVICE_ID, BOT_ID, fixture.textUpload.request);
    await service.removeAttachment(DEVICE_ID, BOT_ID, removed.id);
    await assert.rejects(
      service.send(DEVICE_ID, BOT_ID, "send-request-attach-0004", { text: "Hi", attachmentIds: [removed.id] }),
      isError("handle_invalid", 409),
    );
    for (const [index, sample] of (fixture.rejectedSends as unknown[]).entries()) {
      await assert.rejects(
        service.send(DEVICE_ID, BOT_ID, `send-request-reject-000${index}`, sample),
        isError("invalid_request", 400),
        JSON.stringify(sample),
      );
    }
  } finally {
    await service.close();
  }
});

test("a send refused before the turn starts keeps its uploads for the same request", async () => {
  const fixture = (await contractFixture()).botAttachments;
  const fake = fakeRuntime({ kind: "idle" });
  const sends: Array<{ text: string; attachments?: unknown }> = [];
  let refusal: BotSessionError | Error | undefined = new BotSessionError("needs_model");
  const attachments = new AidenRemoteAttachmentStore();
  let duringRefusal: (() => Promise<void>) | undefined;
  const service = new AidenRemoteBotSessionService({
    bots: botService(),
    runtime: async () => ({
      ...fake.runtime,
      async send(_botId, input) {
        await duringRefusal?.();
        duringRefusal = undefined;
        if (refusal) throw refusal;
        sends.push(input);
        return { submissionId: String(sends.length), deduped: false };
      },
    }),
    attachments,
  });
  try {
    const image = await service.uploadAttachment(DEVICE_ID, BOT_ID, fixture.imageUpload.request);
    const body = { text: "Read this", attachmentIds: [image.id] };
    // Uploads that arrive while the send is in flight can't take the photo's
    // place in the Bot's quota (20 per Bot), nor remove it.
    const later: string[] = [];
    duringRefusal = async () => {
      for (let index = 0; index < 20; index += 1) {
        try {
          later.push((await service.uploadAttachment(DEVICE_ID, BOT_ID, fixture.textUpload.request)).id);
        } catch (error) {
          assert.ok(isError("handle_capacity", 429)(error as { code?: string; status?: number }));
        }
      }
      // Removing it mid-send is ignored: the send spends it or gives it back.
      await service.removeAttachment(DEVICE_ID, BOT_ID, image.id);
    };
    await assert.rejects(service.send(DEVICE_ID, BOT_ID, "send-request-refused-0001", body));
    assert.equal(later.length, 19);
    for (const id of later) await service.removeAttachment(DEVICE_ID, BOT_ID, id);
    // The person chooses a model; the same request now runs with its photo.
    refusal = undefined;
    await service.send(DEVICE_ID, BOT_ID, "send-request-refused-0001", body);
    assert.equal(sends.length, 1);
    assert.deepEqual(sends[0]!.attachments, [
      { type: "image", mimeType: "image/png", data: fixture.imageUpload.request.data },
    ]);

    // A failure that may have reached the runtime leaves them spent.
    const other = await service.uploadAttachment(DEVICE_ID, BOT_ID, fixture.imageUpload.request);
    refusal = new Error("connection reset");
    await assert.rejects(service.send(DEVICE_ID, BOT_ID, "send-request-refused-0002", { text: "", attachmentIds: [other.id] }));
    refusal = undefined;
    await assert.rejects(
      service.send(DEVICE_ID, BOT_ID, "send-request-refused-0003", { text: "", attachmentIds: [other.id] }),
      isError("handle_invalid", 409),
    );
  } finally {
    await service.close();
  }
});

test("a host without Bot attachments refuses attachmentIds and the upload routes", async () => {
  const fake = fakeRuntime({ kind: "idle" });
  const service = sessionService(fake.runtime);
  try {
    assert.equal(service.supportsAttachments, false);
    await assert.rejects(
      service.send(DEVICE_ID, BOT_ID, "send-request-attach-0009", { text: "Hi", attachmentIds: [`att_${"A".repeat(43)}`] }),
      isError("invalid_request", 400),
    );
    await assert.rejects(
      service.uploadAttachment(DEVICE_ID, BOT_ID, { name: "a.txt", mimeType: "text/plain", kind: "text", text: "a" }),
      isError("not_found", 404),
    );
  } finally {
    await service.close();
  }
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
    // The memo forgot the bubbles that left view: it holds no more tags than the window shows.
    assert.equal(await service.submissionTagsHeld(BOT_ID), AIDEN_REMOTE_BOT_SESSION_MAX_ENTRIES);
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
          return new Map([["3", "sub_3"]]);
        },
      },
    },
    { onReport: (_botId, error) => reports.push(error) },
  );
  try {
    await service.session(BOT_ID, { activity: true });
    await driven.emit([user(1, "Plan dinners")]);
    await driven.emit([user(1, "Plan dinners"), user(2, "And snacks")]);
    assert.equal(reports.length, 1, "a failing streak is reported once");
    failing = false;
    await driven.emit([user(1, "Plan dinners"), user(2, "And snacks"), user(3, "And lunches")]);
    assert.deepEqual(userBubbles((await service.session(BOT_ID, { activity: true })).entries), [
      ["Plan dinners", null],
      ["And snacks", null],
      ["And lunches", "sub_3"],
    ]);
    failing = true;
    await driven.emit([user(1, "Plan dinners"), user(2, "And snacks"), user(3, "And lunches"), user(4, "And breakfasts")]);
    assert.deepEqual(reports.map((error) => (error as Error).message), [
      "The session could not be inspected.",
      "The session could not be inspected.",
    ], "a new streak after a success is reported again");
  } finally {
    await service.close();
  }
});

/** Publish order: frames one publish emits never go back in this order. */
const PUBLISH_ORDER = ["entry", "partial", "state", "question", "approval", "handoff", "activity", "queued"];

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

// ---------------------------------------------------------------------------
// Contract revision 37: hand-offs and pause on phones (`bot:handoffs`)
// ---------------------------------------------------------------------------

const HANDOFF_WAIT_ID = "4f9c2d1e-7a3b-4c5d-9e8f-0a1b2c3d4e5f";
const HOLDER = { handoffs: true };

/** The card behind the shared `botHandoffs` fixture, as the Mac's hand-off bridge holds it. */
function handoffPrompt(overrides: Partial<BotPendingHandoff> = {}): BotPendingHandoff {
  return {
    botId: BOT_ID,
    waitId: HANDOFF_WAIT_ID,
    toolCallId: "call_fixture_36",
    kind: "action",
    action: "Enter the 2FA code your bank sent you",
    why: "The bank asks for a code only you can see.",
    open: { url: "https://bank.example.com/verify" },
    source: "tool",
    ...overrides,
  };
}

const SIGN_IN: Partial<BotPendingHandoff> = {
  kind: "sign_in",
  action: "Sign in to bank.example.com",
  why: undefined,
  open: { url: "https://bank.example.com" },
  origin: "https://bank.example.com",
  target: "browser",
};

/** The conversation behind the shared `botHandoffs` fixture. */
function scoutConversation(): RawEntry[] {
  return [
    {
      id: 40,
      kind: "pi.user",
      model: [{ role: "user", content: [{ type: "text", text: "Pay the electricity bill." }], timestamp: Date.parse("2026-10-20T09:00:00.000Z") }],
    },
    {
      id: 41,
      kind: "pi.assistant",
      model: [{
        role: "assistant",
        content: [{ type: "text", text: "I've filled in the payment form." }],
        stopReason: "stop",
        timestamp: Date.parse("2026-10-20T09:00:30.000Z"),
      }],
    },
  ];
}

/** The `hand_off` (or `sign_in`) tool result the runtime records when the person answers a card. */
function handoffResult(
  id: number,
  details: Record<string, unknown>,
  options: { toolCallId?: string; isError?: boolean } = {},
): RawEntry {
  return {
    id,
    kind: "pi.tool-result",
    model: [{
      role: "toolResult",
      toolCallId: options.toolCallId ?? "call_fixture_36",
      toolName: details.kind === "sign_in" ? "sign_in" : "hand_off",
      isError: options.isError ?? false,
      content: [{ type: "text", text: "The person answered the card." }],
      details,
      timestamp: Date.parse("2026-10-20T09:02:00.000Z"),
    }],
  };
}

/** A host wired for hand-offs and pause on phones, with a Bot named as the fixture's. */
function handoffSession(
  runtime: AidenRemoteBotSessionRuntime,
  options: { wired?: boolean; opened?: BotHandoffOpened; conversation?: ReturnType<typeof drivenConversation> } = {},
) {
  const handoffs = createBotHandoffs();
  const openedOnMac: Array<[string, string]> = [];
  const service = new AidenRemoteBotSessionService({
    bots: botService({ name: "Scout" }),
    runtime: async () => (options.conversation
      ? { ...runtime, conversation: async () => options.conversation!.conversation as never }
      : runtime),
    ...(options.wired === false
      ? {}
      : {
          handoffs,
          openHandoffOnMac: async (botId: string, waitId: string) => {
            openedOnMac.push([botId, waitId]);
            return options.opened ?? "focused";
          },
        }),
    notifyBotsChanged: () => {},
    projectorIdleMs: 60_000,
  });
  const handOff = (overrides: Partial<BotPendingHandoff> = {}, signal?: AbortSignal) => {
    const asked = handoffs.request({ ...handoffPrompt(overrides), signal });
    asked.catch(() => undefined);
    return asked;
  };
  return { handoffs, service, handOff, openedOnMac };
}

/** A session without its Bot id and stream cursor, which differ between a test host and the fixture. */
const withoutCursor = ({ botId: _botId, epoch: _epoch, seq: _seq, ...session }: Record<string, unknown>) => session;
const framesOf = (frames: Frame[]) => frames.map(({ type, payload }) => ({ type, payload }));

test("a waiting hand-off reads as the shared fixture shows it, to holders and to every other device", async () => {
  const fixture = (await contractFixture()).botHandoffs;
  const driven = drivenConversation(scoutConversation());
  const { service, handOff } = handoffSession(fakeRuntime({ kind: "running", submissionId: "sub_1" }).runtime, { conversation: driven });
  try {
    assert.equal((await service.session(BOT_ID, HOLDER)).handoff, null, "a holder always gets the key");
    handOff();
    const holder = await service.session(BOT_ID, HOLDER);
    assert.deepEqual(withoutCursor(holder as never), withoutCursor(fixture.session));

    const legacy = await service.session(BOT_ID);
    assert.deepEqual(withoutCursor(legacy as never), withoutCursor(fixture.legacy.session));
    assert.equal("handoff" in legacy, false);
    // A device with other opt-ins but not this one is still a legacy device here.
    const cardsOnly = await service.session(BOT_ID, { cards: true, activity: true });
    assert.equal("handoff" in cardsOnly, false);
    assert.equal(last(cardsOnly.entries)?.id, `handoff-notice:${HANDOFF_WAIT_ID}`);
  } finally {
    await service.close();
  }
});

test("a hand-off, its answer and a pause reach holders and other devices frame for frame as the fixture shows, at the same seqs", async () => {
  const fixture = (await contractFixture()).botHandoffs;
  const driven = drivenConversation(scoutConversation());
  const fake = fakeRuntime({ kind: "running", submissionId: "sub_1" });
  const { service, handOff } = handoffSession(fake.runtime, { conversation: driven });
  const holder = await openAudienceStream(service, HOLDER);
  const legacy = await openAudienceStream(service, {});
  try {
    await holder.until(() => holder.frames.length >= 1, "the holder snapshot");
    await legacy.until(() => legacy.frames.length >= 1, "the legacy snapshot");
    const asked = handOff();
    await holder.until(() => holder.frames.length >= 2, "the hand-off frame");

    const receipt = await service.answerHandoff(DEVICE_ID, BOT_ID, HANDOFF_WAIT_ID, "handoff-request-0001", fixture.answer.request, HOLDER);
    assert.deepEqual(receipt, fixture.answer.response);
    assert.deepEqual(await asked, fixture.answer.request, "the Bot gets the person's answer");
    await holder.until(() => holder.frames.length >= 3, "the settled frame");

    // The runtime records the answer; it reads as the person's message for everyone.
    await driven.emit([
      ...scoutConversation(),
      handoffResult(42, { kind: "action", outcome: "done", action: "Enter the 2FA code your bank sent you", note: "The code was from 9:01.", toolCallId: "call_fixture_36" }),
    ]);
    await holder.until(() => holder.frames.length >= 4, "the answer entry");

    assert.deepEqual(await service.pause(DEVICE_ID, BOT_ID, "pause-request-000001", {}, HOLDER), fixture.pause.response);
    assert.deepEqual(fake.calls.pause, ["phone"], "a phone's pause is recorded as the phone's");
    await holder.until(() => holder.frames.length >= 5, "the paused state");
    await legacy.until(() => legacy.frames.length >= 5, "the legacy view of the pause");

    assert.deepEqual(framesOf(holder.frames.slice(1)), framesOf(fixture.events));
    assert.deepEqual(framesOf(legacy.frames.slice(1)), framesOf(fixture.legacy.events));
    for (const stream of [holder, legacy]) assert.ok(gapless(stream.frames));
    assert.deepEqual(legacy.frames.map((frame) => frame.seq), holder.frames.map((frame) => frame.seq));
    for (const line of legacy.raw) assert.doesNotMatch(line, /"handoff"|"paused"/u);

    // A reconnect after the pause: the snapshot both views expect.
    assert.deepEqual(withoutCursor(await service.session(BOT_ID, HOLDER) as never), withoutCursor(fixture.pausedSession));
    assert.deepEqual(withoutCursor(await service.session(BOT_ID) as never), withoutCursor(fixture.legacy.pausedSession));

    // A write to the paused Bot is refused with the code each device knows, and nothing is sent.
    for (const [options, expected] of [[HOLDER, fixture.pausedError], [{}, fixture.legacy.pausedError]] as const) {
      await assert.rejects(
        service.send(DEVICE_ID, BOT_ID, "send-request-paused-01", { text: "Are you there?" }, options),
        (error: { code?: string; status?: number; message?: string }) =>
          error.code === expected.error.code && error.status === 409 && error.message === expected.error.message,
      );
    }
    assert.deepEqual(await service.unpause(DEVICE_ID, BOT_ID, "unpause-request-0001", HOLDER), fixture.unpause.response);
    assert.deepEqual(
      await service.send(DEVICE_ID, BOT_ID, "send-request-paused-01", { text: "Are you there?" }, HOLDER),
      { submissionId: "sub_1", deduped: false, state: "idle", interrupted: false },
      "the refusal recorded nothing, so the same request runs once the Bot is unpaused",
    );
  } finally {
    await holder.close();
    await legacy.close();
    await service.close();
  }
});

test("a hand-off answer is idempotent per request UUID, and a card that stopped waiting is handoff_expired", async () => {
  const { service, handOff, handoffs } = handoffSession(fakeRuntime({ kind: "running", submissionId: "sub_1" }).runtime);
  try {
    const asked = handOff();
    const [phone, tablet] = await Promise.allSettled([
      service.answerHandoff(DEVICE_ID, BOT_ID, HANDOFF_WAIT_ID, "handoff-request-0002", { outcome: "skipped" }, HOLDER),
      service.answerHandoff("device_2", BOT_ID, HANDOFF_WAIT_ID, "handoff-request-0003", { outcome: "done" }, HOLDER),
    ]);
    assert.deepEqual(phone, { status: "fulfilled", value: { waitId: HANDOFF_WAIT_ID } });
    assert.equal(tablet.status, "rejected");
    assert.ok(isError("handoff_expired", 409)((tablet as PromiseRejectedResult).reason));
    assert.deepEqual(await asked, { outcome: "skipped" }, "the first answer wins");

    assert.deepEqual(
      await service.answerHandoff(DEVICE_ID, BOT_ID, HANDOFF_WAIT_ID, "handoff-request-0002", { outcome: "skipped" }, HOLDER),
      { waitId: HANDOFF_WAIT_ID },
      "a retry with the same request UUID replays the receipt",
    );
    await assert.rejects(
      service.answerHandoff(DEVICE_ID, BOT_ID, HANDOFF_WAIT_ID, "handoff-request-0002", { outcome: "done" }, HOLDER),
      "the same request UUID with another answer is not a replay",
    );

    // Withdrawn by Stop, Dismiss, delete or quit.
    const controller = new AbortController();
    const withdrawn = handOff({}, controller.signal);
    controller.abort();
    await assert.rejects(withdrawn);
    await assert.rejects(
      service.answerHandoff(DEVICE_ID, BOT_ID, HANDOFF_WAIT_ID, "handoff-request-0004", { outcome: "done" }, HOLDER),
      isError("handoff_expired", 409),
    );
    await assert.rejects(
      service.answerHandoff(DEVICE_ID, BOT_ID, HANDOFF_WAIT_ID, "handoff-request-0004", { outcome: "done" }, HOLDER),
      isError("handoff_expired", 409),
      "a retry of the refused answer gets the same refusal, not a server error",
    );
    assert.deepEqual(handoffs.pending(), []);
  } finally {
    await service.close();
  }
});

test("an answer the card does not accept is invalid and the card keeps waiting; a phone may only skip a sign-in", async () => {
  const { service, handOff, handoffs } = handoffSession(fakeRuntime({ kind: "running", submissionId: "sub_1" }).runtime);
  try {
    handOff();
    for (const [key, body] of [
      ["handoff-request-0005", { outcome: "later" }],
      ["handoff-request-0006", { outcome: "done", note: "   " }],
      ["handoff-request-0007", { outcome: "done", note: "x".repeat(4_001) }],
      ["handoff-request-0008", { outcome: "done", waitId: HANDOFF_WAIT_ID }],
    ] as const) {
      await assert.rejects(service.answerHandoff(DEVICE_ID, BOT_ID, HANDOFF_WAIT_ID, key, body, HOLDER), isError("invalid_request", 400), key);
    }
    await assert.rejects(
      service.answerHandoff(DEVICE_ID, BOT_ID, "wait id", "handoff-request-0009", { outcome: "done" }, HOLDER),
      isError("invalid_request", 400),
      "a malformed wait id",
    );
    await assert.rejects(
      service.answerHandoff(DEVICE_ID, "bot_missing", HANDOFF_WAIT_ID, "handoff-request-0010", { outcome: "done" }, HOLDER),
      isError("not_found", 404),
    );
    assert.equal((await service.session(BOT_ID, HOLDER)).handoff?.waitId, HANDOFF_WAIT_ID);

    // A sign-in happens in the Mac's browser: Done from a phone is refused, Skip settles it.
    const signIn = handOff(SIGN_IN);
    for (const attempt of ["first", "retry"]) {
      await assert.rejects(
        service.answerHandoff(DEVICE_ID, BOT_ID, HANDOFF_WAIT_ID, "handoff-request-0011", { outcome: "done" }, HOLDER),
        (error: { code?: string; status?: number; message?: string }) =>
          error.code === "invalid_request" && error.status === 400 && /signing in on your Mac/u.test(error.message ?? ""),
        `${attempt}: the same request UUID gets the same refusal`,
      );
    }
    assert.equal(handoffs.pending(BOT_ID).length, 1, "the sign-in still waits");
    await service.answerHandoff(DEVICE_ID, BOT_ID, HANDOFF_WAIT_ID, "handoff-request-0012", { outcome: "skipped", note: "Not today." }, HOLDER);
    assert.deepEqual(await signIn, { outcome: "skipped", note: "Not today." });
  } finally {
    await service.close();
  }
});

test("a sign-in the Bot asks for reaches a holder as a sign_in card and other devices as a needs-you line, Finish on your Mac opens it there, and Skip from the phone answers the Bot", async () => {
  const { service, handoffs, openedOnMac } = handoffSession(fakeRuntime({ kind: "running", submissionId: "sub_1" }).runtime, {
    opened: "browser",
  });
  const holder = await openAudienceStream(service, HOLDER);
  try {
    await holder.until(() => holder.frames.length >= 1, "the holder snapshot");
    // The Bot's sign_in call, as its tool runs it in a turn.
    const asked = signInCandidate(BOT_ID, handoffs)
      .bind!({
        callId: "call_sign_in_1",
        signal: new AbortController().signal,
        entries: async () => [],
        submissions: async () => [],
        appendEntry: async () => {},
        memo: async (_name, candidate) => candidate,
      })
      .execute("call_sign_in_1", { site: "GitHub.com/login", why: "To read your issues." } as never);
    await holder.until(() => holder.frames.some((frame) => frame.type === "handoff"), "the sign-in frame");
    const card = holder.frames.find((frame) => frame.type === "handoff")!.payload.handoff as { waitId: string };
    // The phone gets what it shows: the site's name, never the Bot's own page.
    assert.deepEqual(card, {
      waitId: card.waitId,
      kind: "sign_in",
      action: "Sign in to github.com",
      why: "To read your issues.",
      open: { url: "https://github.com" },
    });
    const legacy = await service.session(BOT_ID);
    const notice = last(legacy.entries);
    assert.equal(notice?.type === "message" && notice.text, "Scout needs you on your Mac: Sign in to github.com");

    // Finish on your Mac: the Mac opens this card where the Bot signs in, and the card still waits.
    assert.deepEqual(await service.openHandoffOnMac(DEVICE_ID, BOT_ID, card.waitId, "open-request-000101", {}), {
      waitId: card.waitId,
      opened: true,
    });
    assert.deepEqual(openedOnMac, [[BOT_ID, card.waitId]]);
    assert.equal(handoffs.get(BOT_ID, card.waitId)?.kind, "sign_in", "opening it answers nothing");
    // Signing in happens on the Mac: a phone can't say it is done.
    await assert.rejects(
      service.answerHandoff(DEVICE_ID, BOT_ID, card.waitId, "handoff-request-0100", { outcome: "done" }, HOLDER),
      isError("invalid_request", 400),
    );

    await service.answerHandoff(DEVICE_ID, BOT_ID, card.waitId, "handoff-request-0101", { outcome: "skipped" }, HOLDER);
    const result = await asked;
    assert.equal(
      result.content.map((part) => (part.type === "text" ? part.text : "")).join(""),
      "The person chose not to do this: Sign in to github.com. Do not try another way to do it; say what you will do instead.",
    );
    await holder.until(() => last(holder.frames.filter((frame) => frame.type === "handoff"))?.payload.handoff === null, "the settled frame");
  } finally {
    await holder.close();
    await service.close();
  }
});

test("Open on Mac brings the waiting card forward once per request UUID and says when nothing could open", async () => {
  const fixture = (await contractFixture()).botHandoffs;
  const { service, handOff, openedOnMac } = handoffSession(fakeRuntime({ kind: "running", submissionId: "sub_1" }).runtime);
  try {
    const asked = handOff();
    const receipt = await service.openHandoffOnMac(DEVICE_ID, BOT_ID, HANDOFF_WAIT_ID, "open-request-000001", fixture.openOnMac.request);
    assert.deepEqual(receipt, fixture.openOnMac.response);
    assert.deepEqual(
      await service.openHandoffOnMac(DEVICE_ID, BOT_ID, HANDOFF_WAIT_ID, "open-request-000001", {}),
      receipt,
      "a retry replays without opening it again",
    );
    assert.deepEqual(openedOnMac, [[BOT_ID, HANDOFF_WAIT_ID]]);
    assert.equal((await service.session(BOT_ID, HOLDER)).handoff?.waitId, HANDOFF_WAIT_ID, "opening it answers nothing");
    await assert.rejects(
      service.openHandoffOnMac(DEVICE_ID, BOT_ID, HANDOFF_WAIT_ID, "open-request-000002", { focus: true }),
      isError("invalid_request", 400),
    );
    await service.answerHandoff(DEVICE_ID, BOT_ID, HANDOFF_WAIT_ID, "handoff-request-0013", { outcome: "done" }, HOLDER);
    await asked;
    for (const attempt of ["first", "retry"]) {
      await assert.rejects(
        service.openHandoffOnMac(DEVICE_ID, BOT_ID, HANDOFF_WAIT_ID, "open-request-000003", {}),
        isError("handoff_expired", 409),
        `${attempt}: the same request UUID gets the same refusal, not a server error`,
      );
    }
  } finally {
    await service.close();
  }

  const nothing = handoffSession(fakeRuntime({ kind: "running", submissionId: "sub_1" }).runtime, { opened: "none" });
  try {
    nothing.handOff();
    assert.deepEqual(
      await nothing.service.openHandoffOnMac(DEVICE_ID, BOT_ID, HANDOFF_WAIT_ID, "open-request-000004", {}),
      { waitId: HANDOFF_WAIT_ID, opened: false },
    );
  } finally {
    await nothing.service.close();
  }
});

test("a host without the hand-off bridge has no hand-off or pause routes and sends every device the revision-35 view", async () => {
  const fake = fakeRuntime({ kind: "running", submissionId: "sub_1" });
  const { service, handOff } = handoffSession(fake.runtime, { wired: false });
  try {
    assert.equal(service.supportsHandoffs, false);
    handOff();
    assert.equal("handoff" in (await service.session(BOT_ID, HOLDER)), false, "a claimed opt-in the host never offered changes nothing");
    for (const call of [
      () => service.answerHandoff(DEVICE_ID, BOT_ID, HANDOFF_WAIT_ID, "handoff-request-0014", { outcome: "done" }, HOLDER),
      () => service.openHandoffOnMac(DEVICE_ID, BOT_ID, HANDOFF_WAIT_ID, "open-request-000005", {}),
      () => service.pause(DEVICE_ID, BOT_ID, "pause-request-000002", {}, HOLDER),
      () => service.unpause(DEVICE_ID, BOT_ID, "unpause-request-0002", HOLDER),
    ]) {
      await assert.rejects(call(), isError("not_found", 404));
    }
    assert.deepEqual(fake.calls.pause, []);
    fake.setState({ kind: "paused", since: 1, by: "mac" });
    assert.equal((await service.session(BOT_ID, HOLDER)).state, "unavailable");
    await assert.rejects(
      service.send(DEVICE_ID, BOT_ID, "send-request-paused-02", { text: "Hi" }, HOLDER),
      isError("operation_stale", 409),
    );
  } finally {
    await service.close();
  }
});

test("a phone's pause holds a real Bot: holders read paused and bot_paused, other devices unavailable and operation_stale, and nothing runs", async () => {
  const { runtime, service, fauxModels } = await interruptedDurableBot({ handoffs: true });
  const holder = await openAudienceStream(service, HOLDER, "bot:killed");
  const legacy = await openAudienceStream(service, {}, "bot:killed");
  try {
    await holder.until(() => holder.frames.length >= 1, "the holder snapshot");
    await legacy.until(() => legacy.frames.length >= 1, "the legacy snapshot");
    // A turn interrupted mid-stream, then paused from the phone: a holder sees the pause.
    assert.deepEqual(
      await service.pause("device_a", "bot:killed", "pause-request-000003", {}, HOLDER),
      { state: "paused", interrupted: false },
    );
    const paused = await runtime.state("bot:killed");
    assert.equal(paused.kind === "paused" && paused.by, "phone");
    assert.deepEqual(
      await service.pause("device_a", "bot:killed", "pause-request-000003", {}, HOLDER),
      { state: "paused", interrupted: false },
      "a retried pause replays",
    );

    await holder.until(() => holder.frames.some((frame) => frame.type === "state" && frame.payload.state === "paused"), "the paused frame");
    await legacy.until(() => legacy.frames.some((frame) => frame.type === "state" && frame.payload.state === "unavailable"), "the unavailable frame");
    assert.deepEqual(legacy.frames.map((frame) => frame.seq), holder.frames.map((frame) => frame.seq));
    assert.equal((await service.session("bot:killed", HOLDER)).state, "paused");
    assert.equal((await service.session("bot:killed")).state, "unavailable");

    for (const [options, code] of [[HOLDER, "bot_paused"], [{}, "operation_stale"]] as const) {
      for (const write of [
        () => service.send("device_a", "bot:killed", "send-request-00p2", { text: "are you there?" }, options),
        () => service.resume("device_a", "bot:killed", "resume-request-0p2", {}, options),
        () => service.dismiss("device_a", "bot:killed", "dismiss-request-0p2", {}, options),
      ]) {
        await assert.rejects(write(), isError(code, 409), code);
      }
    }
    assert.equal(fauxModels.calls(), 0);

    // Unpausing leaves the interrupted turn for Resume; the refused Resume was never recorded.
    assert.deepEqual(
      await service.unpause("device_a", "bot:killed", "unpause-request-0003", HOLDER),
      { state: "interrupted", interrupted: true },
    );
    assert.equal((await service.resume("device_a", "bot:killed", "resume-request-0p2", {}, HOLDER)).state, "running");
    await waitFor(async () => (await runtime.state("bot:killed")).kind === "idle", { what: "the resumed turn" });
    assert.equal(fauxModels.calls(), 1);
  } finally {
    await holder.close();
    await legacy.close();
    await service.close();
    await runtime.shutdown();
  }
});

test("a pause and unpause made on the Mac reach open phone streams at once, as each device names them", async () => {
  const { runtime, service, stateListeners } = await interruptedDurableBot({ handoffs: true, stateChanges: true });
  const holder = await openAudienceStream(service, HOLDER, "bot:killed");
  const legacy = await openAudienceStream(service, {}, "bot:killed");
  const statesOf = (frames: Frame[]) => frames.flatMap((frame) => (frame.type === "state" ? [frame.payload.state] : []));
  try {
    await holder.until(() => holder.frames.length >= 1, "the holder snapshot");
    await legacy.until(() => legacy.frames.length >= 1, "the legacy snapshot");
    // The Mac pauses: no phone route runs and the conversation does not change.
    await runtime.pause("bot:killed", "mac");
    await holder.until(() => statesOf(holder.frames).includes("paused"), "the paused frame");
    await legacy.until(() => statesOf(legacy.frames).includes("unavailable"), "the unavailable frame");
    assert.equal(statesOf(legacy.frames).includes("paused"), false);

    // The Mac unpauses: the interrupted turn is back, waiting for Resume, on both.
    await runtime.unpause("bot:killed");
    await holder.until(() => last(statesOf(holder.frames)) === "interrupted", "the holder's interrupted frame");
    await legacy.until(() => last(statesOf(legacy.frames)) === "interrupted", "the legacy interrupted frame");
    assert.deepEqual(statesOf(holder.frames), ["paused", "interrupted"]);
    assert.deepEqual(statesOf(legacy.frames), ["unavailable", "interrupted"]);
    assert.deepEqual(legacy.frames.map((frame) => frame.seq), holder.frames.map((frame) => frame.seq));
  } finally {
    await holder.close();
    await legacy.close();
    await service.close();
    await runtime.shutdown();
  }
  assert.equal(stateListeners.size, 0, "a closed service stops listening");
});

test("a hand-off holds a running turn at Waiting for you on bot:activity phones, after the hand-off frame", async () => {
  const driven = drivenConversation([user(1, "Pay the bill")]);
  const fake = fakeRuntime({ kind: "running", submissionId: "sub_1" });
  const handoffs = createBotHandoffs();
  const service = runningOn(driven, fake, { handoffs, openHandoffOnMac: async () => "focused" });
  const stream = await openAudienceStream(service, { activity: true, handoffs: true });
  try {
    await stream.until(() => stream.frames.length >= 1, "the snapshot");
    const searching = { run: { inputs: [1] }, tools: [{ callId: "call_1", name: "web_search", status: "running" }] };
    await driven.emitView([user(1, "Pay the bill")], { "pi.live": searching });
    await stream.until(() => phasesOf(stream.frames).includes("searching"), "the tool phase");
    const asked = handoffs.request({ ...handoffPrompt(), signal: undefined });
    await stream.until(() => last(phasesOf(stream.frames)) === "waiting", "the waiting phase");
    const opened = stream.frames.findIndex((frame) => frame.type === "handoff");
    const waiting = stream.frames.findIndex((frame) => frame.type === "activity" && frame.payload.activity?.phase === "waiting");
    assert.ok(opened > 0 && opened < waiting, "a phone has the card before the line says it waits on the person");

    // A reconnect mid-wait gets both in its first snapshot.
    const snapshot = await service.session(BOT_ID, { activity: true, handoffs: true });
    assert.equal(snapshot.handoff?.waitId, HANDOFF_WAIT_ID);
    assert.equal(snapshot.activity?.phase, "waiting");

    assert.equal(handoffs.answer(BOT_ID, HANDOFF_WAIT_ID, { outcome: "done" }), "answered", "answered on the Mac");
    await asked;
    await stream.until(() => last(phasesOf(stream.frames)) === "searching", "the turn back at work");
    assert.equal(last(stream.frames.filter((frame) => frame.type === "handoff"))?.payload.handoff, null);
    assert.ok(gapless(stream.frames));
  } finally {
    await stream.close();
    await service.close();
  }
});

test("a hand-off answer reads as the person's message, and a call id the wire refuses gets a stable id", async () => {
  const fixture = (await contractFixture()).botHandoffs;
  const done = { kind: "action", outcome: "done", action: "Enter the 2FA code your bank sent you", note: "The code was from 9:01." };
  const answerEntry = fixture.events.find((event: { type: string }) => event.type === "entry").payload.entry;
  assert.deepEqual(projectBotSessionEntries([handoffResult(42, done)] as never), [answerEntry]);

  const [skipped] = projectBotSessionEntries([handoffResult(43, { ...done, outcome: "skipped", note: undefined })] as never);
  assert.equal(skipped?.type === "message" && skipped.text, "You skipped this: Enter the 2FA code your bank sent you");
  const [signedIn] = projectBotSessionEntries([
    handoffResult(44, { kind: "sign_in", outcome: "done", action: "Sign in to bank.example.com", origin: "https://bank.example.com" }),
  ] as never);
  assert.equal(signedIn?.type === "message" && signedIn.text, "You signed in to bank.example.com");
  // A stopped card records no answer: nothing on the person's side.
  assert.deepEqual(projectBotSessionEntries([handoffResult(45, done, { isError: true })] as never).filter((entry) => entry.type === "message"), []);

  const odd = (toolCallId: string) => projectBotSessionEntries([handoffResult(46, done, { toolCallId })] as never)[0]!;
  const first = odd("call/with spaces and ünïcode");
  assert.match(first.id, /^entry_handoff_[0-9a-f]{32}$/u);
  assert.deepEqual(parseAidenRemoteBotSessionEntry(first), first);
  assert.equal(odd("call/with spaces and ünïcode").id, first.id, "the same row keys the same bubble on every snapshot");
  assert.notEqual(odd("call/other").id, first.id);
  assert.equal(odd(`call_${"x".repeat(200)}`).id.length, "entry_handoff_".length + 32, "a call id past the wire bound");
});

test("a legacy phone's hand-off line leaves its next snapshot once the card settles", async () => {
  const { service, handOff } = handoffSession(fakeRuntime({ kind: "running", submissionId: "sub_1" }).runtime);
  try {
    const asked = handOff();
    const notices = async () => (await service.session(BOT_ID)).entries.filter((entry) => entry.id.startsWith("handoff-notice:"));
    assert.equal((await notices()).length, 1);
    await service.answerHandoff(DEVICE_ID, BOT_ID, HANDOFF_WAIT_ID, "handoff-request-0015", { outcome: "done" }, HOLDER);
    await asked;
    assert.deepEqual(await notices(), []);
  } finally {
    await service.close();
  }
});
