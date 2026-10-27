import assert from "node:assert/strict";
import test from "node:test";
import { createTelegramDeliveryApi } from "./telegram-delivery.js";
import { createTelegramActivityProjector } from "./telegram-activity.js";
import type { TelegramBotApi } from "./telegram-bot-api.js";

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("every actual outbound method rechecks cancellation after its asynchronous authority guard", async () => {
  const hold = barrier(), cancellation = new AbortController();
  const sent: string[] = [];
  const api = Object.fromEntries(["sendMessage", "sendRichMessage", "sendRichMessageDraft", "editMessageText", "sendDocument", "sendVoice", "sendChatAction"].map((name) => [name, async () => { sent.push(name); }])) as unknown as TelegramBotApi;
  const guarded = createTelegramDeliveryApi(api, () => hold.promise, cancellation.signal);
  const results = Promise.allSettled([
    guarded.sendMessage({ chatId: 1, text: "private" }),
    guarded.sendRichMessage({ chatId: 1, markdown: "private" }),
    guarded.sendRichMessageDraft({ chatId: 1, draftId: 1, markdown: "private" }),
    guarded.editMessageText({ chatId: 1, messageId: 1, text: "private" }),
    guarded.sendDocument({ chatId: 1, bytes: new Uint8Array([1]), name: "private.txt" }),
    guarded.sendVoice({ chatId: 1, bytes: new Uint8Array([1]) }),
    guarded.sendChatAction(1, "typing"),
  ]);
  cancellation.abort(); hold.resolve();
  assert.equal((await results).every(({ status }) => status === "rejected"), true);
  assert.deepEqual(sent, []);
});

test("queued drafts, thinking and tool activity cannot send after authority is revoked", async () => {
  const hold = barrier(), cancellation = new AbortController();
  let sent = 0;
  const api = { sendMessage: async () => { sent++; return { message_id: 1 }; }, editMessageText: async () => { sent++; }, sendRichMessageDraft: async () => { sent++; } } as unknown as TelegramBotApi;
  const projector = createTelegramActivityProjector({ api: createTelegramDeliveryApi(api, () => hold.promise, cancellation.signal), chatId: 1, draftPreviews: true, verbosity: "verbose", rendering: "rich", now: () => 1_000 });
  projector.observe("chat:delta", { delta: "Private draft" });
  projector.observe("chat:reasoning-delta", { delta: "Private reasoning" });
  projector.observe("chat:tool", { toolName: "read_file", phase: "result" });
  await Promise.resolve(); cancellation.abort(); hold.resolve();
  await projector.settle();
  assert.equal(sent, 0);
});
