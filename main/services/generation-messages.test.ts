import assert from "node:assert/strict";
import test from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import { transformMessages } from "@earendil-works/pi-ai/api/transform-messages";
import {
  chatMessageToPiMessage,
  chatUserTextWithAttachments,
  toPiMessages,
} from "./generation-messages.js";
import { SkillInvocationError } from "../../renderer/shared/slash-commands.js";

const model: Model<"openai-completions"> = {
  id: "test",
  name: "Test",
  api: "openai-completions",
  provider: "test",
  baseUrl: "https://example.test/v1",
  reasoning: false,
  input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8_192,
};

const params = {
  chatId: "chat",
  providerId: "test",
  model: "test",
  messages: [
    {
      role: "user" as const,
      content: "Inspect this.",
      attachments: [
        {
          id: "text",
          name: "note.txt",
          mimeType: "text/plain",
          kind: "text" as const,
          size: 4,
          text: "note",
        },
        {
          id: "image",
          name: "capture.png",
          mimeType: "image/png",
          kind: "image" as const,
          size: 4,
          data: "IMAGE_SENTINEL",
        },
      ],
    },
  ],
};

test("keeps images only when the generation's effective model accepts them", () => {
  const vision = toPiMessages(params, model, true)[0];
  assert.equal(vision.role, "user");
  assert.ok(Array.isArray(vision.content));
  assert.equal(
    vision.content.some((part) => part.type === "image"),
    true,
  );
  assert.equal(JSON.stringify(vision.content).includes("note.txt"), true);

  const text = toPiMessages(params, model, false)[0];
  assert.equal(text.role, "user");
  assert.ok(Array.isArray(text.content));
  assert.equal(
    text.content.some((part) => part.type === "image"),
    false,
  );
  assert.equal(JSON.stringify(text.content).includes("note.txt"), true);
  assert.equal(JSON.stringify(text.content).includes("IMAGE_SENTINEL"), false);
});

test("matches Pi's installed tool-result image serialization gate", () => {
  const toolResult = {
    role: "toolResult" as const,
    toolCallId: "call",
    toolName: "computer_use",
    content: [
      { type: "text" as const, text: "capture" },
      {
        type: "image" as const,
        data: "TOOL_IMAGE_SENTINEL",
        mimeType: "image/png",
      },
    ],
    details: null,
    isError: false,
    timestamp: Date.now(),
  };
  const vision = transformMessages([toolResult], model);
  assert.equal(JSON.stringify(vision).includes("TOOL_IMAGE_SENTINEL"), true);
  const textModel = { ...model, input: ["text"] as ("text" | "image")[] };
  const text = transformMessages([toolResult], textModel);
  assert.equal(JSON.stringify(text).includes("TOOL_IMAGE_SENTINEL"), false);
});

test("journal rehydration preserves the authoritative chat timestamp", () => {
  const message = chatMessageToPiMessage(
    {
      id: "message-1",
      role: "assistant",
      content: "Persisted response",
      createdAt: 123_456,
    },
    model,
    false,
  );

  assert.equal(message.role, "assistant");
  assert.equal(message.timestamp, 123_456);
});

test("journal rehydration preserves canonical mixed-provider Pi provenance", () => {
  const canonical = {
    role: "assistant" as const,
    content: [
      { type: "thinking" as const, thinking: "Provider-authored thought" },
      { type: "text" as const, text: "Historical answer" },
    ],
    api: "anthropic-messages" as const,
    provider: "anthropic",
    model: "claude-historical",
    responseModel: "claude-historical-2026",
    responseId: "response-historical",
    usage: {
      input: 10,
      output: 4,
      cacheRead: 2,
      cacheWrite: 3,
      cacheWrite1h: 1,
      totalTokens: 19,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop" as const,
    timestamp: 456,
  };
  const message = chatMessageToPiMessage(
    {
      id: "message-provenance",
      role: "assistant",
      content: "Historical answer",
      createdAt: 456,
      pi: canonical,
    },
    model,
    false,
  );
  assert.deepEqual(message, canonical);
  assert.equal(
    message.role === "assistant" ? message.provider : "",
    "anthropic",
  );
  assert.equal(
    message.role === "assistant" ? message.model : "",
    "claude-historical",
  );
});

test("an explicit invocation overrides only the exact in-memory current turn", () => {
  const persisted = {
    id: "message-2",
    role: "user" as const,
    content: "Inspect this.",
    createdAt: 234_567,
    attachments: params.messages[0]!.attachments,
  };
  const journal = chatMessageToPiMessage(persisted, model, true);
  assert.doesNotMatch(JSON.stringify(journal), /PRIVATE_SKILL_INSTRUCTIONS/u);

  const current = chatMessageToPiMessage(
    persisted,
    model,
    true,
    '<skill name="Review">PRIVATE_SKILL_INSTRUCTIONS</skill>\n\nAttached file: note.txt\n```\nnote\n```\n\nInspect this.',
  );
  const serialized = JSON.stringify(current);
  assert.match(serialized, /PRIVATE_SKILL_INSTRUCTIONS/u);
  assert.equal(serialized.match(/Attached file: note\.txt/gu)?.length, 1);
  assert.equal(serialized.includes("IMAGE_SENTINEL"), true);
  assert.ok(
    serialized.indexOf("PRIVATE_SKILL_INSTRUCTIONS") <
      serialized.indexOf("note.txt"),
  );
});

test("skill message text is rejected before aggregate attachment concatenation exceeds its budget", () => {
  assert.throws(
    () => chatUserTextWithAttachments("12345", undefined, 4),
    (error: unknown) =>
      error instanceof SkillInvocationError &&
      error.code === "instructions_too_large",
  );
  assert.throws(
    () =>
      chatUserTextWithAttachments("tail", params.messages[0]!.attachments, 30),
    (error: unknown) =>
      error instanceof SkillInvocationError &&
      error.code === "instructions_too_large",
  );
});
