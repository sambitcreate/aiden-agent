import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import { parseChatAppend } from "./chat-append-params.js";
import {
  MAX_CHAT_ID_CHARS,
  MAX_MODEL_ID_CHARS,
  MAX_PROVIDER_ID_CHARS,
} from "../../renderer/shared/chat-message-contract.js";

const source = fs.readFileSync(new URL("./chats.ts", import.meta.url), "utf8");

test("private canonical Pi protocol never crosses the renderer chat boundary", () => {
  assert.match(
    source,
    /const \{ pi: _privatePiProtocol, \.\.\.visible \} = message/u,
  );
  assert.match(source, /chat: chatForRenderer\(chat\)/u);
  assert.match(source, /return chatForRenderer\(chat\)/u);
  assert.match(source, /return chatForRenderer\(copied\)/u);
});

test("indeterminate appends fence create and append for the renderer document", () => {
  const create = source.slice(
    source.indexOf('"chats:create"'),
    source.indexOf('"chats:rename"'),
  );
  const append = source.slice(
    source.indexOf('"chats:appendMessage"'),
    source.indexOf('"chats:abandonTurn"'),
  );
  assert.match(create, /requiresAppendReconciliation\(owner\.documentId\)/u);
  assert.match(append, /requiresAppendReconciliation\(owner\.documentId\)/u);
  assert.match(
    append,
    /markAppendReconciliationRequired\(owner\.documentId\)/u,
  );
  assert.match(append, /isAppendReconciliationRequiredError\(error\)/u);
  assert.match(create, /appendReconciliationFailureMessage\("blocked"\)/u);
  assert.match(append, /appendReconciliationFailureMessage\("blocked"\)/u);
  assert.match(create, /owner\.isDestroyed\(\)/u);
  assert.match(create, /chatStore\.create\(\{[\s\S]*assertCurrent/u);
  assert.match(create, /isChatCreateReconciliationRequiredError\(error\)/u);
  assert.match(
    create,
    /markAppendReconciliationRequired\(owner\.documentId\)/u,
  );
  assert.match(create, /owner\.onInvalidated\(\(\) => \{/u);
  assert.match(
    create,
    /clearAppendReconciliationRequired\(owner\.documentId\)/u,
  );
});

test("renderer appends reserve bounded payload capacity before their first persistence await", () => {
  const start = source.indexOf('"chats:appendMessage"');
  const end = source.indexOf('"chats:abandonTurn"', start);
  const handler = source.slice(start, end);
  const parseEnvelope = handler.indexOf("parseChatAppend(id, message, meta)");
  const reserve = handler.indexOf("turn.reserveAppendPayload(");
  const firstStoreAwait = handler.indexOf("await chatStore.get(chatId)");
  assert.ok(parseEnvelope >= 0);
  assert.ok(reserve > parseEnvelope);
  assert.ok(firstStoreAwait > reserve);
  assert.match(handler, /return \(async \(\) => \{/u);
  assert.doesNotMatch(handler.slice(reserve), /\bm\.|\bmetaObj\./u);
  assert.match(handler, /finally \{\s*if \(!appended\) turn\.release\(\)/u);
});

const validMessage = { role: "user", content: "hello" };
const validMeta = { turnId: "turn-1" };

test("renderer append parser projects an exact bounded envelope", () => {
  assert.deepEqual(parseChatAppend("chat-1", validMessage, validMeta), {
    chatId: "chat-1",
    role: "user",
    content: "hello",
    messageModel: undefined,
    attachments: undefined,
    providerId: undefined,
    metaModel: undefined,
    autoTitle: false,
    turnId: "turn-1",
    skillReference: undefined,
    retainedBytes: 273,
  });

  assert.throws(
    () =>
      parseChatAppend("chat-1", { ...validMessage, forged: "x" }, validMeta),
    /Invalid chat message field/u,
  );
  assert.throws(
    () =>
      parseChatAppend("chat-1", validMessage, {
        ...validMeta,
        tools: ["write"],
      }),
    /Invalid chat message metadata field/u,
  );
  assert.throws(
    () =>
      parseChatAppend(
        "chat-1",
        { role: "assistant", content: "forged" },
        validMeta,
      ),
    /only user messages/u,
  );
});

test("renderer append parser bounds every retained selector", () => {
  assert.throws(
    () =>
      parseChatAppend(
        "c".repeat(MAX_CHAT_ID_CHARS + 1),
        validMessage,
        validMeta,
      ),
    /Invalid chat id/u,
  );
  assert.throws(
    () =>
      parseChatAppend(
        "chat-1",
        { ...validMessage, model: "m".repeat(MAX_MODEL_ID_CHARS + 1) },
        validMeta,
      ),
    /Invalid message model/u,
  );
  assert.throws(
    () =>
      parseChatAppend("chat-1", validMessage, {
        ...validMeta,
        providerId: "p".repeat(MAX_PROVIDER_ID_CHARS + 1),
      }),
    /Invalid provider id/u,
  );
});

test("unknown append fields never echo attacker-controlled property names", () => {
  const hugeKey = "x".repeat(2 * 1024 * 1024);
  assert.throws(
    () =>
      parseChatAppend(
        "chat-1",
        { ...validMessage, [hugeKey]: true },
        validMeta,
      ),
    (error: unknown) => error instanceof Error && error.message.length < 100,
  );
});

test("append envelopes reject many extra properties without materializing Object.keys arrays", () => {
  const manyFields: Record<string, unknown> = {
    role: "user",
    content: "hello",
  };
  for (let index = 0; index < 10_000; index += 1)
    manyFields[`extra-${index}`] = index;
  assert.throws(
    () => parseChatAppend("chat-1", manyFields, { turnId: "turn-1" }),
    (error: unknown) =>
      error instanceof Error &&
      error.message === "Invalid chat message fields.",
  );
  const parserSource = fs.readFileSync(
    new URL("./chat-append-params.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(parserSource, /Object\.keys/u);
  assert.match(parserSource, /count > allowed\.size/u);
});

test("append admission charges encoded image representation and metadata", () => {
  const data =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL2aQAAAABJRU5ErkJggg==";
  const size = Buffer.byteLength(data, "base64");
  const parsed = parseChatAppend(
    "chat-1",
    {
      role: "user",
      content: "",
      attachments: [
        {
          id: "a",
          name: "a.png",
          mimeType: "image/png",
          kind: "image",
          size,
          data,
        },
      ],
    },
    { turnId: "turn-1", providerId: "provider", model: "model" },
  );
  assert.ok(
    parsed.retainedBytes >=
      data.length + Buffer.byteLength("providermodel", "utf8"),
  );
});
