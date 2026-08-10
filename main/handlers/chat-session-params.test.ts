import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  CHAT_SESSION_ID_LIMITS,
  parseChatCopyRequest,
  parseChatOnlyRequest,
} from "./chat-session-params.js";

test("session command parsers accept only exact bounded chat selectors", () => {
  assert.deepEqual(parseChatCopyRequest({ chatId: "chat-1" }), {
    chatId: "chat-1",
    throughMessageId: undefined,
  });
  assert.deepEqual(parseChatCopyRequest({ chatId: "chat-1", throughMessageId: "message-1" }), {
    chatId: "chat-1",
    throughMessageId: "message-1",
  });
  assert.deepEqual(parseChatOnlyRequest({ chatId: "chat-1" }), { chatId: "chat-1" });
  for (const invalid of [
    null,
    {},
    { chatId: "" },
    { chatId: "chat", path: "/tmp/private" },
    { chatId: "x".repeat(CHAT_SESSION_ID_LIMITS.chatCharacters + 1) },
    { chatId: "chat", throughMessageId: "" },
  ]) {
    assert.throws(() => parseChatCopyRequest(invalid));
  }
});

test("session command exact-key rejection stays bounded for hostile fields", () => {
  const hugeKey = "x".repeat(2 * 1024 * 1024);
  assert.throws(
    () => parseChatOnlyRequest({ chatId: "chat", [hugeKey]: true }),
    (error: unknown) => error instanceof Error && error.message.length < 80,
  );
  const many = Object.fromEntries(
    Array.from({ length: 10_000 }, (_, index) => [`extra${index}`, true]),
  );
  assert.throws(() => parseChatOnlyRequest({ chatId: "chat", ...many }));
});

test("copied chat metadata uses the renderer notification contract", () => {
  const handlers = readFileSync(new URL("./chats.ts", import.meta.url), "utf8");
  const broadcast = handlers.slice(
    handlers.indexOf('ipcMain.broadcast("chats:metadata-updated"'),
    handlers.indexOf("return copied;", handlers.indexOf('ipcMain.broadcast("chats:metadata-updated"')),
  );
  assert.match(broadcast, /chatId: copied\.id/u);
  assert.match(broadcast, /title: copied\.title/u);
  assert.doesNotMatch(broadcast, /\bid: copied\.id/u);
});
