// Pausing a Bot (plan §7) against a real harness and a faux model. The faux
// provider's request count is the independent oracle for "nothing ran".

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { build } from "esbuild";
import { getCurrentSystemPrompt, type Message } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai/providers/faux";
import { BOT_MEMORY_REVIEW_ENTRY_KIND } from "../../../renderer/shared/bot-memory.js";
import { applyBotLiveEvent, type BotLiveEvent, type BotLiveSnapshot } from "../../../renderer/shared/bot-live.js";
import { createBotMemoryReview } from "../bot-memory/review.js";
import { createBotMemoryService } from "../bot-memory/service.js";
import { createBotMemoryStore } from "../bot-memory/store.js";
import { createBotPauseStore, type BotPauseRecord, type BotPauseStore } from "../bot-pause-store.js";
import { SUGGEST_CONNECTION_TOOL_NAME } from "../bot-runtime-tools/suggest-connection.js";
import { stopBotLegacyChatWork } from "./bot-legacy-chat-pause.js";
import { runBotPauseSteps } from "./bot-pause-steps.js";
import { createBotQuestions } from "./bot-questions.js";
import {
  BOT_NOTICE_ENTRY_KIND,
  BotSessionError,
  createBotSessionService,
  type BotSessionRuntime,
  type BotSessionServiceDeps,
  type BotSessionState,
} from "./bot-session-service.js";
import { suggestConnectionCandidate } from "./bot-tool-candidates.js";
import { botDirectoryName } from "./harness-host.js";
import { createBotLiveProjection, projectBotTranscript } from "./live-projection.js";
import { countingTool, fakeMemoryAuthority, recordingDeps } from "./test-support/fixtures.js";
import {
  createFauxModels,
  FAUX_MODEL,
  FAUX_MODEL_REF,
  FAUX_PROVIDER,
  slowAnswer,
  waitFor,
  type FauxModels,
} from "./test-support/faux.js";
import { optionAnswer, QUESTION_ARGS, QUESTION_TOOL_NAME, questionEntries } from "./test-support/question-fixtures.js";

const roots: string[] = [];
function tempProfile(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "aiden-bot-pause-"));
  roots.push(root);
  return root;
}
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const BOT = "bot:a";
const never = () => new AbortController().signal;

function pauseStore(profile: string, now = () => 1_000): BotPauseStore {
  return createBotPauseStore({ root: () => path.join(profile, "bot-service"), now });
}

async function serviceFor(
  profile: string,
  fauxModels: FauxModels,
  overrides: Partial<BotSessionServiceDeps> = {},
): Promise<BotSessionRuntime> {
  return createBotSessionService({
    profileDir: profile,
    models: fauxModels.models,
    extension: recordingDeps(),
    resolveModel: async () => FAUX_MODEL_REF,
    knownBotIds: async () => new Set([BOT]),
    pauses: pauseStore(profile),
    ...overrides,
  });
}

function refusedWhilePaused(error: unknown): boolean {
  return error instanceof BotSessionError && error.reason === "paused_by_person";
}

/** Start a long streaming reply and wait until the provider is answering it. */
async function streaming(service: BotSessionRuntime, fauxModels: FauxModels, requestId = "desk-1"): Promise<string> {
  const { submissionId } = await service.send(BOT, { text: "write a lot", requestId });
  await waitFor(async () => (await service.state(BOT)).kind === "running" && fauxModels.calls() === 1, {
    what: "the reply to start",
  });
  return submissionId;
}

const pausedAt = (submissionId?: string): BotSessionState => ({
  kind: "paused",
  since: 1_000,
  by: "mac",
  ...(submissionId === undefined ? {} : { interrupted: submissionId }),
});

test("pausing while a reply streams leaves it interrupted under the pause and runs nothing more", async () => {
  const fauxModels = createFauxModels([slowAnswer(), fauxAssistantMessage("never")], { tokensPerSecond: 40 });
  const published: BotSessionState[] = [];
  const order: string[] = [];
  const service = await serviceFor(tempProfile(), fauxModels, {
    onStateChange: (_botId, state) => published.push(state),
    onPaused: () => void order.push("onPaused"),
    afterPaused: () => void order.push(`afterPaused:${fauxModels.calls()}`),
  });
  try {
    const submissionId = await streaming(service, fauxModels);
    const waiting = service.awaitReply(BOT, submissionId, never());

    assert.deepEqual(await service.pause(BOT, "mac"), pausedAt(submissionId));
    assert.deepEqual(order, ["onPaused", "afterPaused:1"], "hooks run before and after the turn is closed");
    assert.deepEqual(published[published.length - 1], pausedAt(submissionId), "the paused state is published");
    assert.deepEqual(await waiting, { kind: "interrupted" }, "a waiting reply is interrupted, not settled");
    assert.deepEqual(await service.awaitReply(BOT, submissionId, never()), { kind: "interrupted" });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(fauxModels.calls(), 1, "a paused Bot makes no provider request");
    assert.deepEqual(await service.state(BOT), pausedAt(submissionId));
  } finally {
    await service.shutdown();
  }
});

test("a pause whose session can't reopen still stops the Bot's other work and tells every window it is paused", async () => {
  const fauxModels = createFauxModels([slowAnswer(), fauxAssistantMessage("never")], { tokensPerSecond: 40 });
  const published: BotSessionState[] = [];
  const reports: unknown[] = [];
  const order: string[] = [];
  let opens = 0;
  const reopenFailure = new Error("the session could not reopen");
  const service = await serviceFor(tempProfile(), fauxModels, {
    onStateChange: (_botId, state) => published.push(state),
    onReport: (_botId, error) => reports.push(error),
    // The first open runs the reply; the reopen after the pause closes it fails once.
    onSessionOpen: () => {
      opens += 1;
      if (opens === 2) throw reopenFailure;
    },
    afterPaused: () => void order.push("afterPaused"),
  });
  try {
    await streaming(service, fauxModels);
    assert.deepEqual(await service.pause(BOT, "mac"), pausedAt(), "the pause answers, with no turn it could read back");
    assert.deepEqual(order, ["afterPaused"], "the Bot's computer and legacy chats are still stopped");
    assert.deepEqual(published[published.length - 1], pausedAt(), "every window hears the Bot is paused");
    assert.ok(reports.includes(reopenFailure), "the failure is reported");
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(fauxModels.calls(), 1, "nothing runs");
    assert.deepEqual(await service.state(BOT), pausedAt(), "the Bot stays paused");
  } finally {
    await service.shutdown();
  }
});

test("a connect card the Bot is suggesting as it pauses never wedges it: the pause, the next message and quit all finish", async () => {
  let started!: () => void;
  const began = new Promise<void>((resolve) => (started = resolve));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const suggest = suggestConnectionCandidate(BOT, {
    isConnected: async () => {
      started();
      await gate;
      return false;
    },
    isDismissed: async () => false,
  });
  const fauxModels = createFauxModels([
    fauxAssistantMessage([fauxToolCall(SUGGEST_CONNECTION_TOOL_NAME, { pluginId: "gmail", reason: "To read your mail." })], {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("never"),
    fauxAssistantMessage("Hello again."),
  ]);
  const service = await serviceFor(tempProfile(), fauxModels, {
    extension: recordingDeps({ tools: [{ tool: suggest.tool, replay: "unsafe", bind: suggest.bind! }] }),
    suspendTimeoutMs: 300,
  });
  const within = <T>(work: Promise<T>, what: string) =>
    Promise.race([
      work,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error(`${what} never finished`)), 5_000)),
    ]);
  try {
    await service.send(BOT, { text: "check my mail", requestId: "desk-1" });
    await began;
    const pausing = service.pause(BOT, "mac");
    // The pause is closing the Bot's session while the tool still works on its card.
    await new Promise((resolve) => setTimeout(resolve, 50));
    release();
    assert.equal((await within(pausing, "the pause")).kind, "paused");
    assert.equal(fauxModels.calls(), 1, "nothing ran under the pause");
    await within(service.unpause(BOT), "the unpause");
    await within(service.send(BOT, { text: "hello?", requestId: "desk-2" }), "the next message");
  } finally {
    await within(service.shutdown(), "quit");
  }
});

test("pausing while a tool is running closes the turn; unpause and Resume finish it", async () => {
  let blockFirst = true;
  const tool = countingTool("run_command", async (params, signal) => {
    if (!blockFirst) return `ran ${params.text}`;
    blockFirst = false;
    return new Promise<string>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  });
  const fauxModels = createFauxModels([
    fauxAssistantMessage([fauxToolCall("run_command", { text: "x" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("done after resume"),
  ]);
  const unpaused: BotPauseRecord[] = [];
  const service = await serviceFor(tempProfile(), fauxModels, {
    extension: recordingDeps({ tools: [{ tool, replay: "safe" }] }),
    onUnpaused: (_botId, record) => void unpaused.push(record),
  });
  try {
    const { submissionId } = await service.send(BOT, { text: "run it", requestId: "desk-1" });
    await waitFor(() => tool.executions.length === 1, { what: "the tool to start" });

    assert.deepEqual(await service.pause(BOT, "mac"), pausedAt(submissionId));
    assert.deepEqual(await service.unpause(BOT), { kind: "interrupted", submissionId });
    assert.deepEqual(unpaused, [{ since: 1_000, by: "mac" }], "the cleared pause reaches the unpause hook");
    assert.equal(fauxModels.calls(), 1, "unpausing alone runs nothing");

    await service.resume(BOT, "resume-1");
    assert.deepEqual(await service.awaitReply(BOT, submissionId, never()), { kind: "completed", text: "done after resume" });
    assert.equal(tool.executions.length, 2, "the interrupted tool call runs again after Resume");
  } finally {
    await service.shutdown();
  }
});

test("while paused, sends, Resume, Dismiss and compaction are refused, and a redelivered request still dedupes", async () => {
  const fauxModels = createFauxModels([fauxAssistantMessage("hello back"), fauxAssistantMessage("never")]);
  const service = await serviceFor(tempProfile(), fauxModels);
  try {
    const first = await service.send(BOT, { text: "hello", requestId: "tg:1:2:0:3" });
    await service.awaitReply(BOT, first.submissionId, never());
    assert.deepEqual(await service.pause(BOT, "mac"), pausedAt());

    assert.deepEqual(await service.send(BOT, { text: "hello", requestId: "tg:1:2:0:3" }), {
      submissionId: first.submissionId,
      deduped: true,
    });
    await assert.rejects(service.send(BOT, { text: "more", requestId: "desk-2" }), refusedWhilePaused);
    await assert.rejects(service.resume(BOT, "resume-1"), refusedWhilePaused);
    await assert.rejects(service.dismiss(BOT, "dismiss-1"), refusedWhilePaused);
    await assert.rejects(service.compact(BOT), refusedWhilePaused);
    assert.equal(
      new BotSessionError("paused_by_person").message,
      "This Bot is paused. Resume it to continue.",
    );
    assert.equal(fauxModels.calls(), 1, "nothing reached the provider while paused");

    assert.equal((await service.unpause(BOT)).kind, "idle");
    const after = await service.send(BOT, { text: "more", requestId: "desk-2" });
    assert.deepEqual(await service.awaitReply(BOT, after.submissionId, never()), { kind: "completed", text: "never" });
  } finally {
    await service.shutdown();
  }
});

test("pausing again keeps the first time and origin, and unpausing twice is harmless", async () => {
  let clock = 1_000;
  const profile = tempProfile();
  const service = await serviceFor(profile, createFauxModels(), { pauses: pauseStore(profile, () => clock) });
  try {
    assert.deepEqual(await service.pause(BOT, "mac"), pausedAt());
    clock = 9_000;
    assert.deepEqual(await service.pause(BOT, "phone"), pausedAt());
    assert.equal((await service.unpause(BOT)).kind, "idle");
    assert.equal((await service.unpause(BOT)).kind, "idle");
  } finally {
    await service.shutdown();
  }
});

test("a pause survives a restart, with its interrupted turn still waiting underneath", async () => {
  const profile = tempProfile();
  const fauxModels = createFauxModels([slowAnswer()], { tokensPerSecond: 40 });
  const before = await serviceFor(profile, fauxModels);
  const submissionId = await streaming(before, fauxModels);
  await before.pause(BOT, "mac");
  await before.shutdown();

  const later = createFauxModels([fauxAssistantMessage("picked up")]);
  const published: BotSessionState[] = [];
  const service = await serviceFor(profile, later, { onStateChange: (_botId, state) => published.push(state) });
  try {
    await service.initialize();
    assert.deepEqual(published, [pausedAt(submissionId)], "startup reports the Bot as paused, not interrupted");
    await assert.rejects(service.resume(BOT, "resume-after-restart"), refusedWhilePaused);
    assert.equal(later.calls(), 0);
    assert.deepEqual(await service.unpause(BOT), { kind: "interrupted", submissionId });
    await service.resume(BOT, "resume-after-unpause");
    assert.equal((await service.awaitReply(BOT, submissionId, never())).kind, "completed");
  } finally {
    await service.shutdown();
  }
});

test("entries written while paused never start the interrupted turn, and the skipped-routines notice shows", async () => {
  const profile = tempProfile();
  const fauxModels = createFauxModels([slowAnswer(), fauxAssistantMessage("never")], { tokensPerSecond: 40 });
  const service = await serviceFor(profile, fauxModels);
  try {
    const submissionId = await streaming(service, fauxModels);
    await service.pause(BOT, "mac");

    await service.appendEntry(BOT, BOT_NOTICE_ENTRY_KIND, {
      notice: "routines_skipped",
      since: 1_000,
      routines: [{ routineId: "r1", name: "Daily digest", count: 3 }],
    });
    await service.markSilent(BOT, "41");
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(fauxModels.calls(), 1, "appending started nothing");
    assert.deepEqual(await service.state(BOT), pausedAt(submissionId));

    const view = await (await service.conversation(BOT)).context(BACKGROUND_CONTEXT);
    const skipped = projectBotTranscript(view.entries).filter((entry) => entry.type === "routines_skipped");
    assert.deepEqual(
      skipped.map(({ type, since, routines }) => ({ type, since, routines })),
      [{ type: "routines_skipped", since: 1_000, routines: [{ routineId: "r1", name: "Daily digest", count: 3 }] }],
    );
  } finally {
    await service.shutdown();
  }
});

test("a paused Bot can be deleted, and the delete forgets its pause", async () => {
  const profile = tempProfile();
  const fauxModels = createFauxModels([slowAnswer(), fauxAssistantMessage("never")], { tokensPerSecond: 40 });
  const pauses = pauseStore(profile);
  const service = await serviceFor(profile, fauxModels, {
    pauses,
    deleteEffects: [(botId) => pauses.forgetBot(botId)],
  });
  try {
    await streaming(service, fauxModels);
    await service.pause(BOT, "mac");
    await service.deleteBot(BOT);
    assert.equal(existsSync(path.join(profile, "bots", botDirectoryName(BOT))), false);
    assert.equal(await pauseStore(profile).get(BOT), undefined);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(fauxModels.calls(), 1, "deleting a paused Bot does not run its interrupted turn");
    await assert.rejects(service.pause(BOT, "mac"), BotSessionError);
  } finally {
    await service.shutdown();
  }
});

test("an open chat gets a new-epoch snapshot showing the Bot paused, then the skipped-routines notice on unpause", async () => {
  const fauxModels = createFauxModels([slowAnswer()], { tokensPerSecond: 40 });
  let projection: ReturnType<typeof createBotLiveProjection> | undefined;
  const skipped = [{ routineId: "r1", name: "Daily digest", count: 2 }];
  const service: BotSessionRuntime = await serviceFor(tempProfile(), fauxModels, {
    onStateChange: (botId, state) => projection?.notifyState(botId, state),
    // As the desktop does: the notice is appended once the pause is cleared.
    onUnpaused: (botId, record) =>
      service.appendEntry(botId, BOT_NOTICE_ENTRY_KIND, { notice: "routines_skipped", since: record.since, routines: skipped }),
  });
  projection = createBotLiveProjection({
    conversation: (botId) => service.conversation(botId),
    state: (botId) => service.state(botId),
    quietInputs: (botId, ids) => service.quietInputs(botId, ids),
  });
  const events: BotLiveEvent[] = [];
  let view: BotLiveSnapshot | null = null;
  let gaps = 0;
  try {
    const subscribed = await projection.subscribe(BOT, {
      send(event) {
        events.push(event);
        if (view === null) return;
        const next = applyBotLiveEvent(view, event);
        if (next === null) gaps += 1;
        else view = next;
      },
    });
    view = subscribed.snapshot;
    try {
      const submissionId = await streaming(service, fauxModels);
      await service.pause(BOT, "mac");
      await waitFor(() => view?.state.kind === "paused", { what: "the paused state in the chat" });
      assert.deepEqual(view!.state, pausedAt(submissionId));
      assert.notEqual(view!.epoch, subscribed.snapshot.epoch, "the reopened session is a new epoch");
      assert.ok(events.some((event) => event.type === "snapshot" && event.epoch !== subscribed.snapshot.epoch));

      assert.deepEqual(await service.unpause(BOT), { kind: "interrupted", submissionId });
      await waitFor(() => view?.entries.some((entry) => entry.type === "routines_skipped") === true, {
        what: "the skipped-routines notice in the open chat",
      });
      const notice = view!.entries.find((entry) => entry.type === "routines_skipped");
      assert.deepEqual(notice?.type === "routines_skipped" ? [notice.since, notice.routines] : null, [1_000, skipped]);
      assert.deepEqual(view!.state, { kind: "interrupted", submissionId }, "the notice does not start the turn");
      assert.equal(fauxModels.calls(), 1);
      assert.equal(gaps, 0);
    } finally {
      subscribed.unsubscribe();
    }
  } finally {
    await projection.close();
    await service.shutdown();
  }
});

test("a question waiting when the Bot pauses is withdrawn, then asked again under the same waitId after Resume", async () => {
  const questions = createBotQuestions();
  const fauxModels = createFauxModels([
    fauxAssistantMessage([fauxToolCall(QUESTION_TOOL_NAME, QUESTION_ARGS)], { stopReason: "toolUse" }),
    fauxAssistantMessage("Green, noted."),
  ]);
  const service = await serviceFor(tempProfile(), fauxModels, {
    extension: recordingDeps({ tools: questionEntries(questions, BOT) }),
  });
  try {
    const { submissionId } = await service.send(BOT, { text: "pick a colour", requestId: "desk-1" });
    await waitFor(() => questions.pending(BOT).length === 1, { what: "the question card" });
    const asked = questions.pending(BOT)[0]!;

    await service.pause(BOT, "mac");
    assert.deepEqual(questions.pending(BOT), [], "pausing withdraws the card");
    assert.equal(questions.answer(BOT, asked.waitId, optionAnswer(asked.waitId, "Blue")), "not_waiting");

    await service.unpause(BOT);
    assert.deepEqual(questions.pending(BOT), [], "unpausing alone asks nothing");
    await service.resume(BOT, "resume-1");
    await waitFor(() => questions.pending(BOT).length === 1, { what: "the re-asked question" });
    assert.equal(questions.pending(BOT)[0]!.waitId, asked.waitId);
    assert.equal(questions.answer(BOT, asked.waitId, optionAnswer(asked.waitId, "Green")), "answered");
    assert.deepEqual(await service.awaitReply(BOT, submissionId, never()), { kind: "completed", text: "Green, noted." });
    assert.equal(fauxModels.calls(), 2, "the question is not generated again");
  } finally {
    await service.shutdown();
  }
});

test("a pause whose close outlives its bound returns in time and reports the turn once the close ends", async () => {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let started = false;
  // Ignores its abort signal until the test lets it go.
  const stubborn = countingTool("run_command", async () => {
    started = true;
    await released;
    return "finally";
  });
  const fauxModels = createFauxModels([
    fauxAssistantMessage([fauxToolCall("run_command", { text: "x" })], { stopReason: "toolUse" }),
  ]);
  const reports: unknown[] = [];
  const published: BotSessionState[] = [];
  const service = await serviceFor(tempProfile(), fauxModels, {
    extension: recordingDeps({ tools: [{ tool: stubborn, replay: "safe" }] }),
    suspendTimeoutMs: 150,
    onReport: (_botId, error) => reports.push(error),
    onStateChange: (_botId, state) => published.push(state),
  });
  try {
    const { submissionId } = await service.send(BOT, { text: "run it", requestId: "desk-1" });
    await waitFor(() => started, { what: "the tool to start" });

    const begun = Date.now();
    assert.deepEqual(await service.pause(BOT, "mac"), pausedAt(), "paused at once; the turn is not known yet");
    assert.ok(Date.now() - begun < 3_000, "pause returned within its bound");
    assert.ok(reports.length >= 1, "the slow close is reported");
    assert.deepEqual(await service.state(BOT), pausedAt(), "state reads do not wait for the close");

    release();
    await waitFor(() => published.some((state) => state.kind === "paused" && state.interrupted === submissionId), {
      what: "the interrupted turn under the pause",
    });
    assert.deepEqual(await service.state(BOT), pausedAt(submissionId));
    assert.equal(fauxModels.calls(), 1);
  } finally {
    release();
    await service.shutdown();
  }
});

test("an unreadable pause file refuses to run turns instead of guessing", async () => {
  const profile = tempProfile();
  mkdirSync(path.join(profile, "bot-service"), { recursive: true });
  writeFileSync(path.join(profile, "bot-service", "bot-pauses.json"), "{ torn");
  const fauxModels = createFauxModels([fauxAssistantMessage("never")]);
  const reports: unknown[] = [];
  const service = await serviceFor(profile, fauxModels, { onReport: (_botId, error) => reports.push(error) });
  try {
    await assert.rejects(service.send(BOT, { text: "hi", requestId: "desk-1" }), /can't read which Bots are paused/u);
    await assert.rejects(service.pause(BOT, "mac"), /can't read which Bots are paused/u);
    assert.equal((await service.state(BOT)).kind, "idle", "state reads still answer");
    assert.ok(reports.length >= 1, "the unreadable file is reported");
    assert.equal(fauxModels.calls(), 0);
  } finally {
    await service.shutdown();
  }
});

/**
 * Ten person turns, then a memory review that answers at once and is held at
 * the conversation lookup for its watermark marker; while it is held, the
 * person starts a long reply. The faux provider serves Bot turns and the
 * review alike, so its request count covers both.
 */
async function reviewHeldAtItsMarker(cancelOnPause: boolean) {
  const profile = tempProfile();
  let holdLookup = false;
  let lookupHeld!: () => void;
  const held = new Promise<void>((resolve) => (lookupHeld = resolve));
  let releaseLookup!: () => void;
  const released = new Promise<void>((resolve) => (releaseLookup = resolve));
  const lastUserText = (messages: Message[]) => {
    const users = messages.filter((message) => message.role === "user");
    const content = users[users.length - 1]?.content ?? "";
    return typeof content === "string" ? content : content.map((part) => (part.type === "text" ? part.text : "")).join("");
  };
  const answer: FauxResponseStep = (context) => {
    if ((getCurrentSystemPrompt(context.messages) ?? "").includes("long-term memory up to date")) {
      // The review is answered; its next step is the lookup for its marker.
      holdLookup = true;
      return fauxAssistantMessage("NOTHING");
    }
    return fauxAssistantMessage(lastUserText(context.messages) === "write a lot" ? "word ".repeat(2_000) : "ok");
  };
  const fauxModels = createFauxModels(Array.from({ length: 30 }, () => answer), { tokensPerSecond: 40 });
  let service!: BotSessionRuntime;
  const review = createBotMemoryReview({
    memory: createBotMemoryService({ store: createBotMemoryStore({ profileDir: profile }) }),
    conversation: async (botId) => {
      if (holdLookup) {
        holdLookup = false;
        lookupHeld();
        await released;
      }
      return service.conversation(botId);
    },
    isIdle: async (botId) => (await service.state(botId)).kind === "idle",
    admit: async () => ({
      ok: true,
      model: { models: fauxModels.models, model: fauxModels.models.getModel(FAUX_PROVIDER, FAUX_MODEL)! },
      lease: fakeMemoryAuthority().lease,
    }),
  });
  // As the desktop wires it, a pause cancels the Bot's memory review.
  service = await serviceFor(profile, fauxModels, cancelOnPause ? { onPaused: (botId) => review.cancel(botId) } : {});
  for (let index = 1; index <= 10; index += 1) {
    const { submissionId } = await service.send(BOT, { text: `Person message ${index}`, requestId: `desk-${index}` });
    assert.equal((await service.awaitReply(BOT, submissionId, never())).kind, "completed");
  }
  const reviewing = review.runNow(BOT);
  await held;
  const { submissionId } = await service.send(BOT, { text: "write a lot", requestId: "desk-long" });
  await waitFor(async () => (await service.state(BOT)).kind === "running" && fauxModels.calls() === 12, {
    what: "the long reply to start after the review's request",
  });
  const markers = async () => {
    const page = await (await service.conversation(BOT)).entries({}, 500, undefined, BACKGROUND_CONTEXT);
    return page.items.filter((entry) => entry.kind === BOT_MEMORY_REVIEW_ENTRY_KIND).map((entry) => entry.data);
  };
  return { service, review, reviewing, submissionId, fauxModels, markers, releaseLookup };
}

test("a memory review cancelled by the pause writes no marker and never restarts the interrupted turn", async () => {
  const held = await reviewHeldAtItsMarker(true);
  try {
    assert.deepEqual(await held.service.pause(BOT, "mac"), pausedAt(held.submissionId));
    held.releaseLookup();
    const outcome = await held.reviewing;
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(held.fauxModels.calls(), 12, "the paused turn makes no further provider request");
    assert.deepEqual(await held.service.state(BOT), pausedAt(held.submissionId));
    assert.deepEqual(outcome, { kind: "aborted" }, "the cancelled review stops before its marker");
    assert.deepEqual(await held.markers(), []);
  } finally {
    held.releaseLookup();
    held.review.shutdown();
    await held.service.shutdown();
  }
});

test("a review marker that lands while the Bot is paused is appended without starting its interrupted turn", async () => {
  // Nothing cancels this review, so it reaches its marker after the pause.
  const held = await reviewHeldAtItsMarker(false);
  try {
    assert.deepEqual(await held.service.pause(BOT, "mac"), pausedAt(held.submissionId));
    held.releaseLookup();
    assert.deepEqual(await held.reviewing, { kind: "reviewed", added: 0, targets: [] });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(held.fauxModels.calls(), 12, "the marker starts nothing");
    assert.deepEqual(await held.service.state(BOT), pausedAt(held.submissionId));
    assert.deepEqual(await held.markers(), [{ source: "review", added: 0, targets: [] }]);
  } finally {
    held.releaseLookup();
    held.review.shutdown();
    await held.service.shutdown();
  }
});

interface LegacyGenerationEntry {
  chatId: string;
  owner: { documentId: string };
  cancelRequested: boolean;
  cancellationOrigin?: string;
  stopCacheWarming: () => void;
  agent: { abort: () => void };
  completion: Promise<void> | null;
}

/**
 * The real `llmClient` with controlled service ports (as the host test in
 * `pi-cache-warming.test.ts` loads it): a test places running legacy
 * generations in its registry and sees whose subagents were stopped.
 */
async function legacyChatHost() {
  let active!: Map<string, LegacyGenerationEntry>;
  const subagentsStopped: string[] = [];
  class UnusedService {}
  const mocks: Record<string, unknown> = {
    "../platform.js": { logger: { info() {}, warn() {} } },
    "./computer-use/generation-gate.js": { ComputerUseGenerationGate: UnusedService },
    "./chat-deletion-gate.js": { ChatDeletionGate: UnusedService },
    "./chat-workspace-mutation-gate.js": { ChatWorkspaceMutationGate: UnusedService },
    "./chat-turn-admission.js": { ChatTurnAdmission: class { isAdmitted() { return false; } } },
    "./generation-delta-coalescer.js": { GenerationDeltaCoalescer: UnusedService },
    "./gemini-context-cache.js": { GeminiContextCache: UnusedService },
    "./chat-run-input-admission.js": {
      createChatRunInputAdmission: (ports: { active: Map<string, LegacyGenerationEntry> }) => {
        active = ports.active;
        return {};
      },
    },
    "./subagents/child-agent-runtime.js": {
      subagentRuntimeRegistry: {
        setHealthMetrics() {},
        setLimits() {},
        setRuntimeFaultReporter() {},
        abortGeneration() {},
        abortChat: (chatId: string) => void subagentsStopped.push(chatId),
        hasChatChildren: () => false,
        hasLiveChatChildren: () => false,
      },
    },
    "./tool-approval.js": { ToolApprovalCoordinator: class { cancelStream() {} } },
    "./ask-user-question-coordinator.js": { AskUserQuestionCoordinator: UnusedService },
  };
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL("../llm-client.ts", import.meta.url))],
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    external: ["*"],
  });
  const module = { exports: {} as typeof import("../llm-client.js") };
  new Function("require", "module", "exports", bundle.outputFiles[0]!.text)(
    (name: string) => mocks[name] ?? {},
    module,
    module.exports,
  );
  return { client: module.exports.llmClient, active, subagentsStopped };
}

/**
 * A generation running on the legacy chat path (a paired desktop's or a
 * phone's turn): every few milliseconds it streams a delta or takes a tool
 * step, until its agent is aborted; its tool then takes a moment to unwind
 * before the run settles and leaves the registry.
 */
function runLegacyGeneration(host: Awaited<ReturnType<typeof legacyChatHost>>, streamId: string, chatId: string) {
  let effects = 0;
  let finish!: () => void;
  const completion = new Promise<void>((resolve) => (finish = resolve));
  const ticking = setInterval(() => void (effects += 1), 5);
  const settle = () => {
    clearInterval(ticking);
    host.active.delete(streamId);
    finish();
  };
  const entry: LegacyGenerationEntry = {
    chatId,
    owner: { documentId: `owner-${streamId}` },
    cancelRequested: false,
    stopCacheWarming() {},
    agent: {
      abort() {
        clearInterval(ticking);
        setTimeout(settle, 50);
      },
    },
    completion,
  };
  host.active.set(streamId, entry);
  return { entry, effects: () => effects, settled: () => !host.active.has(streamId), end: settle };
}

test("a pause answers without waiting for the Bot's computer to stop, which begins only once the run has stopped", async () => {
  let runStopped = false;
  const tool = countingTool(
    "run_command",
    (_params, signal) =>
      new Promise<string>((_resolve, reject) => {
        signal?.addEventListener(
          "abort",
          () => {
            runStopped = true;
            reject(new Error("aborted"));
          },
          { once: true },
        );
      }),
  );
  const fauxModels = createFauxModels([
    fauxAssistantMessage([fauxToolCall("run_command", { text: "build" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("never"),
  ]);
  const order: string[] = [];
  const reports: unknown[] = [];
  let computerStopped!: () => void;
  const gracefulStop = new Promise<void>((resolve) => (computerStopped = resolve));
  const broken = new Error("the legacy chats could not be read");
  const service = await serviceFor(tempProfile(), fauxModels, {
    extension: recordingDeps({ tools: [{ tool, replay: "unsafe" }] }),
    // As the desktop wires it (`afterBotPaused` in bot-session-main.ts): legacy chats, then the computer.
    afterPaused: runBotPauseSteps(
      [
        {
          run: () => {
            order.push("legacy chats");
            throw broken;
          },
        },
        {
          background: true,
          run: async () => {
            order.push(runStopped ? "computer stopping after the run" : "computer stopping DURING the run");
            await gracefulStop;
            order.push("computer stopped");
          },
        },
      ],
      (_botId, error) => reports.push(error),
    ),
  });
  try {
    await service.send(BOT, { text: "build it", requestId: "desk-1" });
    await waitFor(() => tool.executions.length === 1, { what: "the tool to start" });
    const paused = await Promise.race([
      service.pause(BOT, "mac"),
      new Promise<"waited">((resolve) => setTimeout(() => resolve("waited"), 5_000)),
    ]);
    assert.notEqual(paused, "waited", "the pause answered while the computer was still stopping");
    assert.deepEqual(order, ["legacy chats", "computer stopping after the run"]);
    assert.deepEqual(reports, [broken], "a step that fails is reported, and the next one still runs");
    computerStopped();
    await waitFor(() => order.includes("computer stopped"), { what: "the computer to stop" });
  } finally {
    computerStopped();
    await service.shutdown();
  }
});

test("pausing stops the Bot's legacy chat streams and tools and waits for them, leaving other chats running", async () => {
  const host = await legacyChatHost();
  const chatsByBot: Record<string, string[]> = { [BOT]: ["bot-chat", "bot-older-chat"], "bot:b": ["other-bot-chat"] };
  const service = await serviceFor(tempProfile(), createFauxModels(), {
    // The legacy-chat step of `afterBotPaused` in bot-session-main.ts.
    afterPaused: (botId) =>
      stopBotLegacyChatWork(botId, {
        chatIds: async (id) => chatsByBot[id] ?? [],
        stopChat: (chatId) => host.client.stopChatWork(chatId),
      }),
  });
  const paired = runLegacyGeneration(host, "stream-paired", "bot-chat");
  const otherBot = runLegacyGeneration(host, "stream-other-bot", "other-bot-chat");
  const workspace = runLegacyGeneration(host, "stream-workspace", "workspace-chat");
  try {
    await waitFor(() => paired.effects() > 2 && otherBot.effects() > 2 && workspace.effects() > 2, {
      what: "the legacy streams to run",
    });

    assert.deepEqual(await service.pause(BOT, "mac"), pausedAt());
    assert.equal(paired.settled(), true, "the pause returns once the Bot's legacy run has settled");
    assert.equal(paired.entry.cancellationOrigin, "user_stop", "it ends as a Stop, and the chat is kept");
    assert.deepEqual(host.subagentsStopped, ["bot-chat", "bot-older-chat"], "only the paused Bot's chats lose their subagents");

    const [pairedAt, otherBotAt, workspaceAt] = [paired.effects(), otherBot.effects(), workspace.effects()];
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(paired.effects(), pairedAt, "nothing more happens for the paused Bot");
    assert.ok(otherBot.effects() > otherBotAt, "another Bot keeps running");
    assert.ok(workspace.effects() > workspaceAt, "a workspace chat keeps running");
    assert.equal(otherBot.entry.cancelRequested || workspace.entry.cancelRequested, false);
    assert.deepEqual(await service.state(BOT), pausedAt());
  } finally {
    paired.end();
    otherBot.end();
    workspace.end();
    await service.shutdown();
  }
});
