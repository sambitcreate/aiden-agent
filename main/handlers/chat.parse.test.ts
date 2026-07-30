import assert from "node:assert/strict";
import test from "node:test";
import { parseParams } from "./chat-params.js";

test("parseParams accepts the assistant mode and rejects the unattended mode", () => {
  const base = { chatId: "c1", providerId: "p", model: "m", messages: [] };
  assert.equal(parseParams({ ...base, mode: "assistant" }).mode, "assistant");
  assert.equal(parseParams(base).mode, undefined);
  assert.throws(() => parseParams({ ...base, mode: "assistant-unattended" }), /Invalid chat mode/);
  assert.throws(() => parseParams({ ...base, mode: "assistant-automation" }), /Invalid chat mode/);
  assert.throws(() => parseParams({ ...base, mode: "workspace" }), /Invalid chat mode/);
});

test("parseParams rejects non-object envelopes", () => {
  assert.throws(() => parseParams(null), /Invalid generation params/);
  assert.throws(() => parseParams("hi"), /Invalid generation params/);
  assert.throws(() => parseParams(undefined), /Invalid generation params/);
  assert.throws(() => parseParams(42), /Invalid generation params/);
});

test("parseParams requires providerId, model, and messages", () => {
  assert.throws(() => parseParams({}), /Missing providerId/);
  assert.throws(() => parseParams({ providerId: "p" }), /Missing model/);
  assert.throws(() => parseParams({ providerId: "p", model: "m" }), /Missing messages/);
  assert.throws(
    () => parseParams({ providerId: "", model: "m", messages: [] }),
    /Missing providerId/,
  );
  assert.throws(() => parseParams({ providerId: "p", model: "", messages: [] }), /Missing model/);
  assert.throws(
    () => parseParams({ providerId: "p", model: "m", messages: "x" }),
    /Missing messages/,
  );
});

test("parseParams accepts only Aiden's bounded generation thinking enum", () => {
  const base = { providerId: "google", model: "gemini-2.5-pro", messages: [] };
  for (const thinkingLevel of ["off", "low", "medium", "high", "xhigh", "max"] as const) {
    assert.equal(parseParams({ ...base, thinkingLevel }).thinkingLevel, thinkingLevel);
  }
  assert.equal(parseParams(base).thinkingLevel, undefined);
  for (const thinkingLevel of ["minimal", "dynamic", "", 1, null]) {
    assert.throws(() => parseParams({ ...base, thinkingLevel }), /Invalid thinking level/u);
  }
});

test("parseParams coerces unknown roles to user and missing content to empty string", () => {
  const result = parseParams({
    providerId: "p",
    model: "m",
    messages: [
      { role: "assistant", content: "hi" },
      { role: "wizard", content: 123 }, // unknown role + non-string content
      {}, // empty message object
      null, // null message
    ],
  });
  assert.equal(result.messages[0].role, "assistant");
  assert.equal(result.messages[0].content, "hi");
  assert.equal(result.messages[1].role, "user"); // coerced
  assert.equal(result.messages[1].content, ""); // coerced
  assert.equal(result.messages[2].role, "user");
  assert.equal(result.messages[2].content, "");
  assert.equal(result.messages[3].role, "user");
  assert.equal(result.messages[3].content, "");
});

test("parseParams validates and copies well-formed attachments", () => {
  const attachments = [
    {
      id: "a-1",
      name: "f.txt",
      mimeType: "text/plain",
      kind: "text",
      size: 5,
      text: "hello",
    },
  ];
  const result = parseParams({
    providerId: "p",
    model: "m",
    messages: [{ role: "user", content: "x", attachments }],
  });
  assert.deepEqual(result.messages[0].attachments, attachments);
  assert.notEqual(result.messages[0].attachments, attachments);
});

test("parseParams rejects malformed attachment arrays and entries", () => {
  const payload = (attachments: unknown) => ({
    providerId: "p",
    model: "m",
    messages: [{ role: "user", content: "x", attachments }],
  });
  assert.throws(() => parseParams(payload("not-array")), /Invalid message attachments/);
  assert.throws(() => parseParams(payload([null])), /Invalid attachment at index 0/);
  assert.throws(
    () =>
      parseParams(payload([{ id: "a", name: "x", mimeType: "text/plain", kind: "text", size: 1 }])),
    /Invalid attachment text/,
  );
  assert.throws(
    () => parseParams(payload(Array.from({ length: 21 }, () => ({})))),
    /Invalid message attachments/,
  );
});

test("parseParams enforces inline text and image attachment bounds", () => {
  const payload = (attachment: unknown) => ({
    providerId: "p",
    model: "m",
    messages: [{ role: "user", content: "x", attachments: [attachment] }],
  });
  assert.throws(
    () =>
      parseParams(
        payload({
          id: "text",
          name: "large.txt",
          mimeType: "text/plain",
          kind: "text",
          size: 100_015,
          text: "x".repeat(100_015),
        }),
      ),
    /Invalid attachment text/,
  );
  assert.throws(
    () =>
      parseParams(
        payload({
          id: "image",
          name: "bad.png",
          mimeType: "image/png",
          kind: "image",
          size: 4,
          data: "not base64",
        }),
      ),
    /Invalid image attachment data/,
  );
});

test("parseParams accepts a bounded image with matching decoded size", () => {
  const data = Buffer.from([0, 1, 2, 3]).toString("base64");
  const result = parseParams({
    providerId: "p",
    model: "m",
    messages: [
      {
        role: "user",
        content: "x",
        attachments: [
          {
            id: "image",
            name: "pixel.png",
            mimeType: "image/png",
            kind: "image",
            size: 4,
            data,
          },
        ],
      },
    ],
  });
  assert.equal(result.messages[0].attachments?.[0].data, data);
});

test("parseParams defaults chatId and workspaceId", () => {
  const result = parseParams({
    providerId: "p",
    model: "m",
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(result.chatId, "");
  assert.equal(result.workspaceId, undefined);
  // And passes them through when present.
  const withIds = parseParams({
    chatId: "c-1",
    workspaceId: "w-1",
    providerId: "p",
    model: "m",
    messages: [],
  });
  assert.equal(withIds.chatId, "c-1");
  assert.equal(withIds.workspaceId, "w-1");
});

test("parseParams round-trips a well-formed payload", () => {
  const payload = {
    chatId: "c-1",
    workspaceId: "w-1",
    providerId: "openai",
    model: "gpt-4",
    messages: [
      { role: "system", content: "be brief" },
      { role: "user", content: "hello" },
    ],
  };
  // parseParams normalizes each message to {role, content, attachments},
  // where attachments is undefined when not supplied.
  assert.deepEqual(parseParams(payload), {
    ...payload,
    messages: [
      { role: "system", content: "be brief", attachments: undefined },
      { role: "user", content: "hello", attachments: undefined },
    ],
  });
});
