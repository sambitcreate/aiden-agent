// Pausing a Bot (plan §7) against a real harness and a faux model. The faux
// provider's request count is the independent oracle for "nothing ran".

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { applyBotLiveEvent, type BotLiveEvent, type BotLiveSnapshot } from "../../../renderer/shared/bot-live.js";
import { createBotPauseStore, type BotPauseRecord, type BotPauseStore } from "../bot-pause-store.js";
import { createBotQuestions } from "./bot-questions.js";
import {
  BOT_NOTICE_ENTRY_KIND,
  BotSessionError,
  createBotSessionService,
  type BotSessionRuntime,
  type BotSessionServiceDeps,
  type BotSessionState,
} from "./bot-session-service.js";
import { botDirectoryName } from "./harness-host.js";
import { createBotLiveProjection, projectBotTranscript } from "./live-projection.js";
import { countingTool, recordingDeps } from "./test-support/fixtures.js";
import { createFauxModels, FAUX_MODEL_REF, slowAnswer, waitFor, type FauxModels } from "./test-support/faux.js";
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

test("an open chat gets a new-epoch snapshot showing the Bot paused, with no gaps", async () => {
  const fauxModels = createFauxModels([slowAnswer()], { tokensPerSecond: 40 });
  let projection: ReturnType<typeof createBotLiveProjection> | undefined;
  const service = await serviceFor(tempProfile(), fauxModels, {
    onStateChange: (botId, state) => projection?.notifyState(botId, state),
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
