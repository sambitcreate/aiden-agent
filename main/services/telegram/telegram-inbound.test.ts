import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeTelegramInbound } from "./telegram-inbound.js";
import { createTranscribeRouter } from "../transcription-core.js";

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
  assert.equal(result.hasVoiceInput, true);
});

test("keeps datasets as both bounded text attachments and inspectable local files", async () => {
  const stored: Array<{ name: string; mimeType: string }> = [];
  const result = await normalizeTelegramInbound(
    {
      api: {
        async downloadFile() {
          return { file: { file_id: "d", file_unique_id: "u" }, bytes: Buffer.from("a,b\n1,2") };
        },
      },
      async storeFile({ name, mimeType }) {
        stored.push({ name, mimeType });
        return "/private/inbox/data.csv";
      },
    },
    {
      message_id: 6,
      chat: privateChat,
      date: 0,
      document: { file_id: "d", file_unique_id: "u", file_name: "data.csv", mime_type: "text/csv" },
    },
  );
  assert.equal(result.attachments[0]?.kind, "text");
  assert.deepEqual(stored, [{ name: "data.csv", mimeType: "text/csv" }]);
  assert.deepEqual(result.localFiles, [{ name: "data.csv", mimeType: "text/csv", path: "/private/inbox/data.csv", size: 7 }]);
  assert.match(result.text, /Local path: \/private\/inbox\/data\.csv/);
});

test("stores PDFs and videos as inspectable local files", async () => {
  const result = await normalizeTelegramInbound(
    {
      api: {
        async downloadFile(fileId) {
          return { file: { file_id: fileId, file_unique_id: fileId }, bytes: Uint8Array.from([1, 2]) };
        },
      },
      async storeFile({ name }) { return `/private/inbox/${name}`; },
    },
    {
      message_id: 7,
      chat: privateChat,
      date: 0,
      document: { file_id: "pdf", file_unique_id: "p", file_name: "paper.pdf", mime_type: "application/pdf" },
      video: { file_id: "video", file_unique_id: "v", file_name: "clip.mp4", mime_type: "video/mp4", width: 10, height: 10, duration: 1 },
    },
  );
  assert.deepEqual(result.localFiles.map(({ name }) => name), ["paper.pdf", "clip.mp4"]);
});

function onDeviceRouter(onDevice: string[]) {
  return createTranscribeRouter({
    resolve: async () => ({ kind: "ready", provider: "local", modelId: "parakeet-v3", automatic: true }),
    local: {
      async oggOpus(bytes, modelId) {
        onDevice.push(`${modelId}:${bytes.byteLength}`);
        return "  spoken on this Mac ";
      },
    },
    openai: async () => assert.fail("cloud must not be called"),
    gemini: async () => assert.fail("cloud must not be called"),
  });
}

test("an on-device resolution transcribes a Telegram voice note locally", async () => {
  const onDevice: string[] = [];
  const result = await normalizeTelegramInbound(
    {
      api: {
        async downloadFile() {
          return { file: { file_id: "v", file_unique_id: "u" }, bytes: Uint8Array.from([79, 103, 103, 83]) };
        },
      },
      transcribeAudio: onDeviceRouter(onDevice),
    },
    {
      message_id: 7,
      chat: privateChat,
      date: 0,
      voice: { file_id: "v", file_unique_id: "u", duration: 1, mime_type: "audio/ogg" },
    },
  );
  assert.equal(result.text, "[Voice transcript]\nspoken on this Mac");
  assert.deepEqual(onDevice, ["parakeet-v3:4"]);
  assert.deepEqual(result.notices, []);
});

test("audio the on-device path cannot decode gets a cloud-provider notice", async () => {
  const onDevice: string[] = [];
  const result = await normalizeTelegramInbound(
    {
      api: {
        async downloadFile() {
          return { file: { file_id: "a", file_unique_id: "u" }, bytes: Uint8Array.from([1, 2]) };
        },
      },
      transcribeAudio: onDeviceRouter(onDevice),
    },
    {
      message_id: 8,
      chat: privateChat,
      date: 0,
      audio: { file_id: "a", file_unique_id: "u", duration: 1, mime_type: "audio/mpeg", file_name: "song.mp3" },
    },
  );
  assert.deepEqual(onDevice, []);
  assert.equal(result.text, "");
  assert.deepEqual(result.notices, ["song.mp3 was not transcribed: This audio format needs a cloud voice provider."]);
});
