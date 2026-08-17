import assert from "node:assert/strict";
import { test } from "node:test";
import { createTelegramActivityProjector } from "./telegram-activity.js";
import type { TelegramBotApi } from "./telegram-bot-api.js";

test("rich activity uses a safe native draft and lets the final reply complete it", async () => {
  const drafts: Array<Record<string, unknown>> = [];
  const projector = createTelegramActivityProjector({
    api: {
      async sendRichMessageDraft(input: Record<string, unknown>) { drafts.push(input); },
    } as unknown as TelegramBotApi,
    chatId: 7,
    threadId: 11,
    draftPreviews: true,
    verbosity: "quiet",
    rendering: "rich",
    now: () => 1_000,
  });
  projector.observe("chat:delta", { delta: "Working\n<!-- telegram_attach path=\"secret.pdf\" -->" });
  await projector.settle();
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0]?.markdown, "Working");
  assert.equal(drafts[0]?.threadId, 11);
});

test("rich activity holds an unfinished Markdown span until it closes", async () => {
  const drafts: Array<Record<string, unknown>> = [];
  let now = 0;
  const projector = createTelegramActivityProjector({
    api: {
      async sendRichMessageDraft(input: Record<string, unknown>) { drafts.push(input); },
    } as unknown as TelegramBotApi,
    chatId: 9,
    draftPreviews: true,
    verbosity: "quiet",
    rendering: "rich",
    now: () => (now += 1_000),
  });
  projector.observe("chat:delta", { delta: "Starting **unfinished" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(drafts[0]?.markdown, "Starting");
  projector.observe("chat:delta", { delta: "**" });
  await projector.settle();
  assert.equal(drafts[1]?.markdown, "Starting **unfinished**");
});

test("thinking and tool activity remain inside the Telegram thread", async () => {
  const messages: Array<Record<string, unknown>> = [];
  const projector = createTelegramActivityProjector({
    api: {
      async sendMessage(input: Record<string, unknown>) {
        messages.push(input);
        return { message_id: messages.length, chat: { id: 7, type: "private" }, date: 0 };
      },
      async editMessageText() {},
    } as unknown as TelegramBotApi,
    chatId: 7,
    threadId: 11,
    draftPreviews: false,
    verbosity: "verbose",
    rendering: "html",
    now: () => 1_000,
  });
  projector.observe("chat:reasoning-delta", { delta: "reason" });
  projector.observe("chat:tool", { toolName: "read_file", phase: "result" });
  await projector.settle();
  assert.equal(messages.length, 2);
  assert.ok(messages.every((message) => message.threadId === 11));
});
