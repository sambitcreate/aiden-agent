import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { createBotSessionService } from "../bot-runtime/bot-session-service.js";
import { recordingDeps } from "../bot-runtime/test-support/fixtures.js";
import { createFauxModels, FAUX_MODEL_REF } from "../bot-runtime/test-support/faux.js";
import type { BotReplyOutcome } from "../bot-runtime/bot-session-service.js";
import {
  createTelegramBotIngress,
  MAY_BE_DUPLICATE_PREFIX,
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
