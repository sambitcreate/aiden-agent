import assert from "node:assert/strict";
import * as fs from "node:fs";
import test from "node:test";
import { MAX_CHAT_MESSAGE_CONTENT_BYTES } from "../../renderer/shared/chat-message-contract.js";
import { parseChatMessageContent } from "./chat-message-contract.js";

test("renderer message text is bounded by raw UTF-8 bytes before persistence", () => {
  const exact = "a".repeat(MAX_CHAT_MESSAGE_CONTENT_BYTES);
  assert.equal(parseChatMessageContent(exact).bytes, MAX_CHAT_MESSAGE_CONTENT_BYTES);
  assert.throws(() => parseChatMessageContent(`${exact}a`), /1 MB limit/);

  const multibyte = "😀".repeat(MAX_CHAT_MESSAGE_CONTENT_BYTES / 4);
  assert.equal(parseChatMessageContent(multibyte).bytes, MAX_CHAT_MESSAGE_CONTENT_BYTES);
  assert.throws(() => parseChatMessageContent(`${multibyte}😀`), /1 MB limit/);
});

test("oversized code-unit input is rejected before exact UTF-8 measurement", () => {
  const source = fs.readFileSync(new URL("./chat-message-contract.ts", import.meta.url), "utf8");
  assert.ok(source.indexOf("content.length >") < source.indexOf("Buffer.byteLength(content"));
  assert.throws(
    () => parseChatMessageContent("a".repeat(MAX_CHAT_MESSAGE_CONTENT_BYTES + 1)),
    /1 MB limit/,
  );
});
