import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeTelegramInbound } from "./telegram-inbound.js";

const privateChat = { id: 1, type: "private" as const };

test("normalizes a downloaded photo into an Aiden image attachment", async () => {
  const result = await normalizeTelegramInbound(
    {
      api: {
        async downloadFile() {
          return { file: { file_id: "f", file_unique_id: "u" }, bytes: Uint8Array.from([1, 2, 3]) };
        },
      },
    },
    {
      message_id: 4,
      chat: privateChat,
      date: 0,
      caption: "What is this?",
      photo: [{ file_id: "f", file_unique_id: "u", width: 10, height: 10, file_size: 3 }],
    },
  );
  assert.equal(result.text, "What is this?");
  assert.equal(result.attachments[0]?.kind, "image");
  assert.equal(result.attachments[0]?.data, Buffer.from([1, 2, 3]).toString("base64"));
});

test("transcribes voice and includes reply/forward context", async () => {
  const result = await normalizeTelegramInbound(
    {
      api: {
        async downloadFile() {
          return { file: { file_id: "v", file_unique_id: "u" }, bytes: Uint8Array.from([9]) };
        },
      },
      async transcribeAudio() {
        return "voice words";
      },
    },
    {
      message_id: 5,
      chat: privateChat,
      date: 0,
      voice: { file_id: "v", file_unique_id: "u", duration: 1, mime_type: "audio/ogg" },
      reply_to_message: { message_id: 2, chat: privateChat, date: 0, text: "Earlier" },
      forward_origin: { type: "user" },
    },
  );
  assert.match(result.text, /Forwarded Telegram message/);
  assert.match(result.text, /Replying to/);
  assert.match(result.text, /voice words/);
});
