import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { createBotSessionService } from "../bot-runtime/bot-session-service.js";
import { recordingDeps } from "../bot-runtime/test-support/fixtures.js";
import { createFauxModels, FAUX_MODEL_REF, slowAnswer, waitFor } from "../bot-runtime/test-support/faux.js";
import type { BotReplyOutcome } from "../bot-runtime/bot-session-service.js";
import {
  createTelegramBotIngress,
  MAY_BE_DUPLICATE_PREFIX,
  telegramBotPausedLine,
  telegramBotRequestId,
  type BotReplyRow,
  type TelegramBotReply,
} from "./bot-reply-outbox.js";

const roots: string[] = [];
function tempDir(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "aiden-tg-outbox-"));
  roots.push(root);
  return root;
}
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** A session that must not be asked for anything: recovery works from the outbox alone. */
function untouchedSession() {
  const calls = { send: 0, awaitReply: 0 };
  return {
    calls,
    session: {
      async send(): Promise<{ submissionId: string; deduped: boolean }> {
        calls.send += 1;
        throw new Error("recovery must not resubmit");
      },
      async awaitReply(): Promise<BotReplyOutcome> {
        calls.awaitReply += 1;
        throw new Error("recovery must not regenerate");
      },
    },
  };
}

function seed(file: string, rows: Array<Partial<BotReplyRow>>): void {
  const full = rows.map((row, index) => ({
    requestId: `tg:bot:a:7:0:${index}`,
    botId: "bot:a",
    submissionId: String(index + 10),
    chatId: 7,
    ownerUserId: 7,
    updatedAt: 1,
    ...row,
  }));
  writeFileSync(file, JSON.stringify({ version: 1, rows: full }));
}

test("the request id names the Bot, chat, thread and message", () => {
  assert.equal(
    telegramBotRequestId({ botId: "bot:a", chatId: 42, threadId: 9, messageId: 1001 }),
    "tg:bot:a:42:9:1001",
  );
  assert.equal(telegramBotRequestId({ botId: "bot:a", chatId: 42, messageId: 1001 }), "tg:bot:a:42:0:1001");
});

test("a redelivered Telegram update makes one submission and one reply", async () => {
  const dir = tempDir();
  const fauxModels = createFauxModels([fauxAssistantMessage("Here you go."), fauxAssistantMessage("extra")]);
  const session = await createBotSessionService({
    profileDir: dir,
    models: fauxModels.models,
    extension: recordingDeps(),
    resolveModel: async () => FAUX_MODEL_REF,
    knownBotIds: async () => new Set(["bot:a"]),
  });
  const delivered: TelegramBotReply[] = [];
  const ingress = createTelegramBotIngress({
    file: path.join(dir, "outbox.json"),
    session,
    deliver: async (reply) => void delivered.push(reply),
  });
  try {
    const message = { botId: "bot:a", chatId: 7, messageId: 55, ownerUserId: 7, text: "plan dinner" };
    const first = await ingress.admit(message);
    const second = await ingress.admit(message);
    assert.equal(first.deduped, false);
    assert.equal(second.deduped, true);
    await ingress.idle();
    assert.equal(fauxModels.calls(), 1);
    assert.deepEqual(delivered, [{ chatId: 7, ownerUserId: 7, text: "Here you go." }]);
    assert.deepEqual((await ingress.rows()).map((row) => row.state), ["sent"]);
  } finally {
    ingress.stop();
    await session.shutdown();
  }
});

test("admission that fails leaves no outbox row, so the update is retried", async () => {
  const dir = tempDir();
  const ingress = createTelegramBotIngress({
    file: path.join(dir, "outbox.json"),
    session: {
      send: async () => {
        throw new Error("Bots are open in another Aiden window.");
      },
      awaitReply: async () => ({ kind: "interrupted" }),
    },
    deliver: async () => assert.fail("nothing to deliver"),
  });
  await assert.rejects(
    ingress.admit({ botId: "bot:a", chatId: 7, messageId: 1, ownerUserId: 7, text: "hi" }),
    /another Aiden window/u,
  );
  assert.deepEqual(await ingress.rows(), []);
});

test("an admission whose outbox write fails is retried from what is on disk, so the reply still arrives", async () => {
  const dir = tempDir();
  const file = path.join(dir, "outbox.json");
  let sends = 0;
  const delivered: TelegramBotReply[] = [];
  const ingress = createTelegramBotIngress({
    file,
    session: {
      // The session dedupes by request id, like the real one.
      send: async () => ({ submissionId: "77", deduped: (sends += 1) > 1 }),
      awaitReply: async () => ({ kind: "completed", text: "Here you go." }),
    },
    deliver: async (reply) => void delivered.push(reply),
  });
  const message = { botId: "bot:a", chatId: 7, messageId: 55, ownerUserId: 7, text: "plan dinner" };
  try {
    assert.deepEqual(await ingress.rows(), []);
    // A directory at the outbox path makes the atomic write fail after the session accepted the message.
    mkdirSync(file);
    // The failure says the session already accepted the turn, so the update must not be skipped.
    await assert.rejects(ingress.admit(message), { name: "BotReplyAdmittedUnrecordedError" });
    rmSync(file, { recursive: true, force: true });
    assert.deepEqual(await ingress.rows(), [], "the cache does not report a row that never reached disk");

    // Telegram redelivers the update because the offset was kept.
    await ingress.admit(message);
    await ingress.idle();
    assert.deepEqual(delivered, [{ chatId: 7, ownerUserId: 7, text: "Here you go." }]);
    const durable = JSON.parse(readFileSync(file, "utf8")) as { rows: BotReplyRow[] };
    assert.deepEqual(durable.rows.map((row) => [row.requestId, row.state]), [[telegramBotRequestId(message), "sent"]]);
    assert.deepEqual(await ingress.rows(), durable.rows);
  } finally {
    ingress.stop();
  }
});

test("a deduped admission of a durable row nobody is waiting on starts waiting for its reply", async () => {
  const file = path.join(tempDir(), "outbox.json");
  const message = { botId: "bot:a", chatId: 7, messageId: 1, ownerUserId: 7, text: "hi" };
  // The row reached disk, but the process lost track of it (a write that was
  // published yet reported as failed, for example).
  seed(file, [{ requestId: telegramBotRequestId(message), state: "awaiting", submissionId: "5" }]);
  const delivered: TelegramBotReply[] = [];
  let waits = 0;
  const ingress = createTelegramBotIngress({
    file,
    session: {
      send: async () => assert.fail("a known row is not resubmitted"),
      awaitReply: async () => {
        waits += 1;
        return { kind: "completed", text: "Hello." };
      },
    },
    deliver: async (reply) => void delivered.push(reply),
  });
  try {
    assert.deepEqual(await ingress.admit(message), { requestId: telegramBotRequestId(message), deduped: true });
    await ingress.idle();
    assert.equal(waits, 1);
    assert.deepEqual(delivered.map((reply) => reply.text), ["Hello."]);
    assert.deepEqual((await ingress.rows()).map((row) => row.state), ["sent"]);
  } finally {
    ingress.stop();
  }
});

test("a reply saved before a crash is delivered on restart without regenerating it", async () => {
  const file = path.join(tempDir(), "outbox.json");
  seed(file, [{ state: "pending", text: "Saved answer." }]);
  const { calls, session } = untouchedSession();
  const delivered: TelegramBotReply[] = [];
  const ingress = createTelegramBotIngress({ file, session, deliver: async (reply) => void delivered.push(reply) });
  await ingress.recover();
  await ingress.idle();
  assert.deepEqual(delivered, [{ chatId: 7, ownerUserId: 7, text: "Saved answer." }]);
  assert.deepEqual(calls, { send: 0, awaitReply: 0 });
  assert.deepEqual((await ingress.rows()).map((row) => row.state), ["sent"]);
});

test("a send cut off by a crash is redelivered once, labelled as a possible duplicate", async () => {
  const file = path.join(tempDir(), "outbox.json");
  seed(file, [{ state: "sending", text: "Half sent." }]);
  const delivered: string[] = [];
  const first = createTelegramBotIngress({
    file,
    session: untouchedSession().session,
    deliver: async (reply) => void delivered.push(reply.text),
  });
  await first.recover();
  await first.idle();
  const second = createTelegramBotIngress({
    file,
    session: untouchedSession().session,
    deliver: async (reply) => void delivered.push(reply.text),
  });
  await second.recover();
  await second.idle();
  assert.deepEqual(delivered, [`${MAY_BE_DUPLICATE_PREFIX} Half sent.`]);
});

test("a redelivery that was itself cut off is not sent a third time", async () => {
  const file = path.join(tempDir(), "outbox.json");
  seed(file, [{ state: "sending", text: "Again?", redelivered: true }]);
  const ingress = createTelegramBotIngress({
    file,
    session: untouchedSession().session,
    deliver: async () => assert.fail("must not resend"),
  });
  await ingress.recover();
  await ingress.idle();
  assert.deepEqual((await ingress.rows()).map((row) => row.state), ["failed"]);
});

test("a send that fails mid-way is retried once with the duplicate label", async () => {
  const file = path.join(tempDir(), "outbox.json");
  const attempts: string[] = [];
  const ingress = createTelegramBotIngress({
    file,
    session: {
      send: async () => ({ submissionId: "3", deduped: false }),
      awaitReply: async () => ({ kind: "completed", text: "Long answer." }),
    },
    deliver: async (reply) => {
      attempts.push(reply.text);
      if (attempts.length === 1) throw new Error("connection reset after the first chunk");
    },
  });
  await ingress.admit({ botId: "bot:a", chatId: 7, messageId: 3, ownerUserId: 7, text: "go" });
  await ingress.idle();
  assert.deepEqual(attempts, ["Long answer.", `${MAY_BE_DUPLICATE_PREFIX} Long answer.`]);
  assert.deepEqual((await ingress.rows()).map((row) => row.state), ["sent"]);
});

test("a turn interrupted by a quit is delivered once after an explicit Resume, across restarts", async () => {
  const dir = tempDir();
  const file = path.join(dir, "outbox.json");
  const delivered: string[] = [];
  const message = { botId: "bot:a", chatId: 7, messageId: 91, ownerUserId: 7, text: "plan the week" };

  /** One process: the real Bot runtime and Telegram ingress, wired the way production wires them. */
  async function open(responses: Parameters<typeof createFauxModels>[0], options?: { tokensPerSecond?: number }) {
    const fauxModels = createFauxModels(responses, options);
    let ingress: ReturnType<typeof createTelegramBotIngress> | undefined;
    const session = await createBotSessionService({
      profileDir: dir,
      models: fauxModels.models,
      extension: recordingDeps(),
      resolveModel: async () => FAUX_MODEL_REF,
      knownBotIds: async () => new Set(["bot:a"]),
      onStateChange: (botId, state) => ingress?.botStateChanged(botId, state),
    });
    ingress = createTelegramBotIngress({ file, session, deliver: async (reply) => void delivered.push(reply.text) });
    const quit = async () => {
      await session.shutdown();
      await ingress!.idle();
      ingress!.stop();
    };
    return { session, ingress, fauxModels, quit };
  }

  const first = await open([slowAnswer()], { tokensPerSecond: 40 });
  await first.ingress.admit(message);
  await waitFor(async () => (await first.session.state("bot:a")).kind === "running" && first.fauxModels.calls() === 1, {
    what: "the Telegram turn to stream",
  });
  await first.quit();
  assert.deepEqual((await first.ingress.rows()).map((row) => row.state), ["interrupted"]);

  // A restart without Resume leaves the paused turn alone and delivers nothing.
  const second = await open([fauxAssistantMessage("never")]);
  await second.session.initialize();
  await second.ingress.recover();
  await second.ingress.idle();
  assert.equal(second.fauxModels.calls(), 0);
  await second.quit();

  const third = await open([fauxAssistantMessage("resumed Telegram answer")]);
  await third.session.initialize();
  await third.ingress.recover();
  await third.ingress.idle();
  assert.deepEqual(delivered, []);
  await third.session.resume("bot:a", "desk-resume");
  await waitFor(async () => (await third.ingress.rows())[0]?.state === "sent", { what: "the resumed reply to be sent" });
  await third.ingress.idle();
  assert.deepEqual(delivered, ["resumed Telegram answer"]);
  await third.quit();

  // The next start does not send it again.
  const fourth = await open([]);
  await fourth.session.initialize();
  await fourth.ingress.recover();
  await fourth.ingress.idle();
  assert.deepEqual(delivered, ["resumed Telegram answer"]);
  await fourth.quit();
});

test("a Resume that lands while startup recovery is still settling its paused observation is delivered once", async () => {
  const dir = tempDir();
  const file = path.join(dir, "outbox.json");
  const delivered: string[] = [];
  const message = { botId: "bot:a", chatId: 7, messageId: 93, ownerUserId: 7, text: "plan the month" };

  const fauxBefore = createFauxModels([slowAnswer()], { tokensPerSecond: 40 });
  const before = await createBotSessionService({
    profileDir: dir,
    models: fauxBefore.models,
    extension: recordingDeps(),
    resolveModel: async () => FAUX_MODEL_REF,
    knownBotIds: async () => new Set(["bot:a"]),
  });
  const beforeIngress = createTelegramBotIngress({ file, session: before, deliver: async (reply) => void delivered.push(reply.text) });
  await beforeIngress.admit(message);
  await waitFor(async () => (await before.state("bot:a")).kind === "running" && fauxBefore.calls() === 1, {
    what: "the Telegram turn to stream",
  });
  await before.shutdown();
  await beforeIngress.idle();
  beforeIngress.stop();

  const fauxModels = createFauxModels([fauxAssistantMessage("resumed answer")]);
  let ingress: ReturnType<typeof createTelegramBotIngress> | undefined;
  const session = await createBotSessionService({
    profileDir: dir,
    models: fauxModels.models,
    extension: recordingDeps(),
    resolveModel: async () => FAUX_MODEL_REF,
    knownBotIds: async () => new Set(["bot:a"]),
    onStateChange: (botId, state) => ingress?.botStateChanged(botId, state),
  });
  // Hold the first recovery wait after it has observed the paused turn.
  let held: BotReplyOutcome | undefined;
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let waits = 0;
  const gatedSession = {
    send: session.send.bind(session),
    async awaitReply(botId: string, submissionId: string, signal: AbortSignal): Promise<BotReplyOutcome> {
      waits += 1;
      const outcome = await session.awaitReply(botId, submissionId, signal);
      if (waits === 1) {
        held = outcome;
        await released;
      }
      return outcome;
    },
  };
  ingress = createTelegramBotIngress({ file, session: gatedSession, deliver: async (reply) => void delivered.push(reply.text) });
  try {
    await session.initialize();
    await ingress.recover();
    await waitFor(async () => held !== undefined, { what: "recovery to observe the paused turn" });
    assert.equal(held?.kind, "interrupted");

    await session.resume("bot:a", "desk-resume");
    await waitFor(async () => fauxModels.calls() === 1 && (await session.state("bot:a")).kind === "idle", {
      what: "the resumed turn to finish",
    });
    release();

    await waitFor(async () => (await ingress!.rows())[0]?.state === "sent", { what: "the resumed reply to be sent" });
    await ingress.idle();
    assert.deepEqual(delivered, ["resumed answer"]);
  } finally {
    release();
    await session.shutdown();
    await ingress.idle();
    ingress.stop();
  }
});

test("a message to a paused Bot gets one fixed line, no row, and never reaches the Bot", async () => {
  const dir = tempDir();
  const fauxModels = createFauxModels([fauxAssistantMessage("never")]);
  const session = await createBotSessionService({
    profileDir: dir,
    models: fauxModels.models,
    extension: recordingDeps(),
    resolveModel: async () => FAUX_MODEL_REF,
    knownBotIds: async () => new Set(["bot:a"]),
  });
  const delivered: TelegramBotReply[] = [];
  const ingress = createTelegramBotIngress({
    file: path.join(dir, "outbox.json"),
    session,
    deliver: async (reply) => void delivered.push(reply),
    botName: async () => "Ada",
  });
  try {
    await session.pause("bot:a", "mac");
    const admitted = await ingress.admit({ botId: "bot:a", chatId: 7, threadId: 3, messageId: 60, ownerUserId: 7, text: "hi" });
    await ingress.idle();
    assert.deepEqual(admitted, { requestId: "tg:bot:a:7:3:60", deduped: false, paused: true });
    assert.deepEqual(delivered, [
      { chatId: 7, threadId: 3, ownerUserId: 7, text: "Ada is paused. Resume it in Aiden to continue." },
    ]);
    assert.deepEqual(await ingress.rows(), [], "nothing waits for an answer");
    assert.equal(fauxModels.calls(), 0);
    const view = await (await session.conversation("bot:a")).context(BACKGROUND_CONTEXT);
    assert.equal(view.entries.some((entry) => entry.kind === "pi.user"), false, "the Bot got no input");
  } finally {
    ingress.stop();
    await session.shutdown();
  }
  assert.equal(telegramBotPausedLine(undefined), "This Bot is paused. Resume it in Aiden to continue.");
});

test("a Telegram turn paused mid-reply is delivered once after unpause and Resume, not before", async () => {
  const dir = tempDir();
  const fauxModels = createFauxModels([slowAnswer(), fauxAssistantMessage("finished after the pause")], { tokensPerSecond: 40 });
  let ingress: ReturnType<typeof createTelegramBotIngress> | undefined;
  const session = await createBotSessionService({
    profileDir: dir,
    models: fauxModels.models,
    extension: recordingDeps(),
    resolveModel: async () => FAUX_MODEL_REF,
    knownBotIds: async () => new Set(["bot:a"]),
    onStateChange: (botId, state) => ingress?.botStateChanged(botId, state),
  });
  const delivered: string[] = [];
  ingress = createTelegramBotIngress({ file: path.join(dir, "outbox.json"), session, deliver: async (reply) => void delivered.push(reply.text) });
  try {
    await ingress.admit({ botId: "bot:a", chatId: 7, messageId: 61, ownerUserId: 7, text: "write it all" });
    await waitFor(async () => (await session.state("bot:a")).kind === "running" && fauxModels.calls() === 1, {
      what: "the Telegram turn to stream",
    });
    await session.pause("bot:a", "phone");
    await waitFor(async () => (await ingress!.rows())[0]?.state === "interrupted", { what: "the paused row" });
    await session.unpause("bot:a");
    await ingress.idle();
    assert.deepEqual(delivered, [], "unpausing alone delivers nothing");
    assert.equal(fauxModels.calls(), 1);

    await session.resume("bot:a", "desk-resume");
    await waitFor(async () => (await ingress!.rows())[0]?.state === "sent", { what: "the resumed reply to be sent" });
    await ingress.idle();
    assert.deepEqual(delivered, ["finished after the pause"]);
  } finally {
    ingress.stop();
    await session.shutdown();
  }
});

test("a turn the person dismissed is settled and never delivered", async () => {
  const dir = tempDir();
  const file = path.join(dir, "outbox.json");
  const delivered: string[] = [];
  const message = { botId: "bot:a", chatId: 7, messageId: 92, ownerUserId: 7, text: "write a lot" };
  const fauxModels = createFauxModels([slowAnswer()], { tokensPerSecond: 40 });
  const before = await createBotSessionService({
    profileDir: dir,
    models: fauxModels.models,
    extension: recordingDeps(),
    resolveModel: async () => FAUX_MODEL_REF,
    knownBotIds: async () => new Set(["bot:a"]),
  });
  const beforeIngress = createTelegramBotIngress({ file, session: before, deliver: async (reply) => void delivered.push(reply.text) });
  await beforeIngress.admit(message);
  await waitFor(async () => (await before.state("bot:a")).kind === "running" && fauxModels.calls() === 1, {
    what: "the Telegram turn to stream",
  });
  await before.shutdown();
  await beforeIngress.idle();
  beforeIngress.stop();

  let ingress: ReturnType<typeof createTelegramBotIngress> | undefined;
  const session = await createBotSessionService({
    profileDir: dir,
    models: createFauxModels([]).models,
    extension: recordingDeps(),
    resolveModel: async () => FAUX_MODEL_REF,
    knownBotIds: async () => new Set(["bot:a"]),
    onStateChange: (botId, state) => ingress?.botStateChanged(botId, state),
  });
  ingress = createTelegramBotIngress({ file, session, deliver: async (reply) => void delivered.push(reply.text) });
  try {
    await session.initialize();
    await ingress.recover();
    await session.dismiss("bot:a", "desk-dismiss");
    await waitFor(async () => (await ingress!.rows())[0]?.state === "dismissed", { what: "the row to settle" });
    await ingress.idle();
    assert.deepEqual(delivered, []);
  } finally {
    await session.shutdown();
    ingress.stop();
  }
});

const routineDelivery = {
  botId: "bot:a",
  requestId: "routine:task-1:1800000000000",
  routineName: "Morning *brief*",
  text: "Your first meeting is at 9:30.",
  chatId: 7,
  ownerUserId: 7,
};

test("a routine result goes to the bound chat once, with the routine name in bold", async () => {
  const file = path.join(tempDir(), "outbox.json");
  const delivered: TelegramBotReply[] = [];
  const ingress = createTelegramBotIngress({
    file,
    session: untouchedSession().session,
    deliver: async (reply) => void delivered.push(reply),
    routineTargetEnabled: async () => true,
  });
  assert.deepEqual(await ingress.enqueueRoutineDelivery(routineDelivery), { queued: true });
  assert.deepEqual(await ingress.enqueueRoutineDelivery(routineDelivery), { queued: false }, "one row per firing");
  await ingress.idle();
  assert.deepEqual(delivered, [
    { chatId: 7, ownerUserId: 7, text: "**Morning \\*brief\\***\n\nYour first meeting is at 9:30." },
  ]);
  assert.deepEqual((await ingress.rows()).map((row) => [row.kind, row.state]), [["routine", "sent"]]);
});

test("a routine result cut off by a crash mid-send is redelivered once with the duplicate label", async () => {
  const file = path.join(tempDir(), "outbox.json");
  let started!: () => void;
  const sending = new Promise<void>((resolve) => { started = resolve; });
  const crashed = createTelegramBotIngress({
    file,
    session: untouchedSession().session,
    // The process dies while Telegram has the message: the send never settles.
    deliver: () => {
      started();
      return new Promise<void>(() => undefined);
    },
    routineTargetEnabled: async () => true,
  });
  await crashed.enqueueRoutineDelivery(routineDelivery);
  await sending;
  crashed.stop();

  const delivered: string[] = [];
  const restarted = createTelegramBotIngress({
    file,
    session: untouchedSession().session,
    deliver: async (reply) => void delivered.push(reply.text),
    routineTargetEnabled: async () => true,
  });
  await restarted.recover();
  await restarted.idle();
  assert.deepEqual(delivered, [`${MAY_BE_DUPLICATE_PREFIX} **Morning \\*brief\\***\n\nYour first meeting is at 9:30.`]);
  assert.deepEqual((await restarted.rows()).map((row) => row.state), ["sent"]);
});

test("a routine result for a binding switched off before the send is dropped unsent", async () => {
  const file = path.join(tempDir(), "outbox.json");
  const checked: Array<{ botId: string; chatId: number }> = [];
  const ingress = createTelegramBotIngress({
    file,
    session: untouchedSession().session,
    deliver: async () => assert.fail("a disabled binding is never sent to"),
    routineTargetEnabled: async ({ botId, chatId }) => {
      checked.push({ botId, chatId });
      return false;
    },
  });
  await ingress.enqueueRoutineDelivery(routineDelivery);
  await ingress.idle();
  assert.deepEqual(checked, [{ botId: "bot:a", chatId: 7 }]);
  assert.deepEqual((await ingress.rows()).map((row) => row.state), ["failed"]);
});

test("an interrupted turn delivers nothing", async () => {
  const file = path.join(tempDir(), "outbox.json");
  seed(file, [{ state: "awaiting" }]);
  const ingress = createTelegramBotIngress({
    file,
    session: {
      send: async () => assert.fail("no resubmission"),
      awaitReply: async () => ({ kind: "interrupted" }),
    },
    deliver: async () => assert.fail("nothing to deliver"),
  });
  await ingress.recover();
  await ingress.idle();
  assert.deepEqual((await ingress.rows()).map((row) => row.state), ["interrupted"]);
});

test("a reply that failed reaches the chat once as an error and is settled", async () => {
  const file = path.join(tempDir(), "outbox.json");
  seed(file, [{ state: "awaiting" }]);
  const delivered: TelegramBotReply[] = [];
  const ingress = createTelegramBotIngress({
    file,
    session: {
      send: async () => assert.fail("no resubmission"),
      awaitReply: async () => ({ kind: "failed", error: "The Bot stopped before it could answer this." }),
    },
    deliver: async (reply) => void delivered.push(reply),
  });
  await ingress.recover();
  await ingress.idle();
  assert.deepEqual(delivered, [{ chatId: 7, ownerUserId: 7, text: "⚠️ Error: The Bot stopped before it could answer this." }]);
  assert.deepEqual((await ingress.rows()).map((row) => row.state), ["sent"]);
});
