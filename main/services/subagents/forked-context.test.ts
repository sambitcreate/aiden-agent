import assert from "node:assert/strict";
import test from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ResolvedModelRuntime } from "../model-runtime-core.js";
import {
  MAX_FORK_CONTEXT_MESSAGES,
  captureLiveSubagentContext,
  capturePersistedSubagentContext,
  cloneSubagentContextMessages,
  createFreshSubagentContext,
} from "./forked-context.js";

function liveTranscript() {
  return [
    { role: "system", content: "private system", timestamp: 1 },
    {
      role: "user",
      content: [
        { type: "text", text: "Inspect the current design.", textSignature: "private-text-sig" },
        { type: "image", mimeType: "image/png", data: "YWJj", path: "/Users/private/image.png" },
      ],
      timestamp: 2,
      credentials: { token: "private-token" },
    },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "private reasoning", thinkingSignature: "private-sig" },
        { type: "text", text: "I found the relevant design.", textSignature: "private-answer-sig" },
        {
          type: "toolCall",
          id: "call-private",
          name: "subagent",
          arguments: { token: "private-tool-token" },
          thoughtSignature: "private-thought-sig",
        },
      ],
      timestamp: 3,
      responseId: "private-response",
    },
    {
      role: "toolResult",
      toolCallId: "call-private",
      toolName: "subagent",
      content: [{ type: "text", text: "private nested result" }],
      timestamp: 4,
    },
  ];
}

function runtime(input: readonly ("text" | "image")[] = ["text", "image"]): ResolvedModelRuntime {
  const model = {
    id: "fork-model",
    name: "Fork model",
    api: "openai-completions",
    provider: "fork-provider",
    baseUrl: "https://example.invalid/v1",
    reasoning: true,
    input: [...input],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
  } as Model<Api>;
  return {
    provider: {
      id: "fork-provider",
      kind: "openai",
      label: "Fork provider",
      baseUrl: model.baseUrl,
      models: [model.id],
      needsKey: false,
    },
    model,
    apiKey: undefined,
    headers: undefined,
    streams: {
      streamSimple:
        (async () => ({})) as unknown as ResolvedModelRuntime["streams"]["streamSimple"],
    },
  };
}

function persistedChat() {
  return {
    id: "chat-fork",
    updatedAt: 30,
    messages: [
      {
        id: "system-private",
        role: "system",
        content: "Never disclose this system instruction.",
        createdAt: 1,
      },
      {
        id: "user-1",
        role: "user",
        content: "Use the approved blue palette.",
        createdAt: 10,
        attachments: [
          {
            id: "text-1",
            name: "brief.txt",
            mimeType: "text/plain",
            kind: "text",
            size: 5,
            text: "brief",
          },
          {
            id: "image-1",
            name: "reference.png",
            mimeType: "image/png",
            kind: "image",
            size: 3,
            data: "YWJj",
          },
        ],
        approval: { decision: "allow", digest: "private" },
      },
      {
        id: "assistant-1",
        role: "assistant",
        content: "We chose navy and sky blue.",
        createdAt: 20,
        reasoning: "private chain of thought",
        thinkingSignature: "signed-private-thinking",
        timeline: { steps: [{ kind: "tool", payload: "private tool result" }] },
        subagents: { runIds: ["run-private"] },
        toolCalls: [{ name: "write", arguments: { secret: "private" } }],
      },
      {
        id: "tool-1",
        role: "toolResult",
        content: "raw tool payload",
        createdAt: 25,
      },
    ],
  };
}

test("captures only immutable user-visible prose and validated user attachments", () => {
  const capture = capturePersistedSubagentContext(persistedChat());
  assert.equal(capture.mode, "fork");
  assert.match(capture.revisionHash, /^[a-f0-9]{64}$/u);
  assert.deepEqual(
    capture.messages.map((message) => ({
      role: message.role,
      content: message.content,
      attachmentNames: message.attachments?.map((attachment) => attachment.name),
    })),
    [
      {
        role: "user",
        content: "Use the approved blue palette.",
        attachmentNames: ["brief.txt", "reference.png"],
      },
      {
        role: "assistant",
        content: "We chose navy and sky blue.",
        attachmentNames: undefined,
      },
    ],
  );
  const serialized = JSON.stringify(capture);
  for (const secret of [
    "system instruction",
    "private chain",
    "signed-private",
    "private tool",
    "run-private",
    "raw tool",
  ]) {
    assert.doesNotMatch(serialized, new RegExp(secret, "u"));
  }
  assert.equal(Object.isFrozen(capture), true);
  assert.equal(Object.isFrozen(capture.messages), true);
  assert.equal(Object.isFrozen(capture.messages[0]?.attachments), true);
});

test("revision hash binds visible projection, attachment bytes, and persisted revision", () => {
  const original = persistedChat();
  const first = capturePersistedSubagentContext(original).revisionHash;
  assert.equal(capturePersistedSubagentContext(structuredClone(original)).revisionHash, first);

  const contentChanged = structuredClone(original);
  contentChanged.messages[1]!.content = "Use green.";
  assert.notEqual(capturePersistedSubagentContext(contentChanged).revisionHash, first);

  const attachmentChanged = structuredClone(original);
  attachmentChanged.messages[1]!.attachments![1]!.data = "eHl6";
  assert.notEqual(capturePersistedSubagentContext(attachmentChanged).revisionHash, first);

  const revisionChanged = structuredClone(original);
  revisionChanged.updatedAt += 1;
  assert.notEqual(capturePersistedSubagentContext(revisionChanged).revisionHash, first);

  const privateReasoningChanged = structuredClone(original);
  privateReasoningChanged.messages[2]!.reasoning = "different private reasoning";
  assert.equal(capturePersistedSubagentContext(privateReasoningChanged).revisionHash, first);
});

test("builds independent deep-copied Pi transcripts for sibling children", () => {
  const capture = capturePersistedSubagentContext(persistedChat());
  const first = cloneSubagentContextMessages(capture, runtime());
  const second = cloneSubagentContextMessages(capture, runtime());
  assert.notEqual(first, second);
  assert.notEqual(first[0], second[0]);
  assert.notEqual(first[1], second[1]);

  assert.deepEqual(
    first.map((message) => message.role),
    ["user", "assistant"],
  );
  const firstUser = first[0];
  assert.equal(firstUser?.role, "user");
  if (firstUser?.role !== "user" || typeof firstUser.content === "string") {
    assert.fail("Expected a multipart forked user message.");
  }
  assert.match(firstUser.content[0]?.type === "text" ? firstUser.content[0].text : "", /brief/u);
  assert.equal(firstUser.content[1]?.type, "image");

  if (firstUser.content[0]?.type === "text") firstUser.content[0].text = "mutated child one";
  const secondUser = second[0];
  assert.equal(secondUser?.role, "user");
  assert.doesNotMatch(JSON.stringify(secondUser), /mutated child one/u);
  assert.doesNotMatch(JSON.stringify(capture), /mutated child one/u);
});

test("drops image data for a text-only child without dropping visible prose", () => {
  const messages = cloneSubagentContextMessages(
    capturePersistedSubagentContext(persistedChat()),
    runtime(["text"]),
  );
  assert.doesNotMatch(JSON.stringify(messages), /YWJj/u);
  assert.match(JSON.stringify(messages), /approved blue palette/u);
  assert.match(JSON.stringify(messages), /brief/u);
});

test("rejects corrupt or excessive persisted attachments instead of silently forking", () => {
  const badSize = persistedChat();
  badSize.messages[1]!.attachments![1]!.size = 2;
  assert.throws(() => capturePersistedSubagentContext(badSize), /image attachment size/u);

  const badBase64 = persistedChat();
  badBase64.messages[1]!.attachments![1]!.data = "not base64";
  assert.throws(() => capturePersistedSubagentContext(badBase64), /unsupported attachment/u);

  const tooMany = persistedChat();
  tooMany.messages = Array.from({ length: MAX_FORK_CONTEXT_MESSAGES + 1 }, (_, index) => ({
    id: `message-${index}`,
    role: "user",
    content: "bounded",
    createdAt: index,
  }));
  assert.throws(() => capturePersistedSubagentContext(tooMany), /message limit/u);

  const svg = persistedChat();
  svg.messages[1]!.attachments![1]!.mimeType = "image/svg+xml";
  assert.throws(() => capturePersistedSubagentContext(svg), /unsupported attachment/u);

  const arbitraryTextMime = persistedChat();
  arbitraryTextMime.messages[1]!.attachments![0]!.mimeType = "application/octet-stream";
  assert.throws(() => capturePersistedSubagentContext(arbitraryTextMime), /unsupported text/u);

  const fabricatedSize = persistedChat();
  fabricatedSize.messages[1]!.attachments![0]!.size = Number.MAX_SAFE_INTEGER;
  assert.throws(() => capturePersistedSubagentContext(fabricatedSize), /attachment size/u);
});

test("redacts high-confidence secrets from visible fork prose and text files", () => {
  const chat = persistedChat();
  chat.messages[1]!.content = "OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz123456";
  chat.messages[1]!.attachments![0]!.text =
    "token: sk-proj-abcdefghijklmnopqrstuvwxyz123456";
  chat.messages[1]!.attachments![0]!.name =
    "sk-proj-abcdefghijklmnopqrstuvwxyz123456.txt";
  const serialized = JSON.stringify(capturePersistedSubagentContext(chat));
  assert.doesNotMatch(serialized, /sk-proj-/u);
  assert.match(serialized, /REDACTED/u);
});

test("fresh context is empty and privately bound to chat plus generation", () => {
  const first = createFreshSubagentContext({ chatId: "chat-fork", generationId: "generation-1" });
  const second = createFreshSubagentContext({ chatId: "chat-fork", generationId: "generation-2" });
  assert.equal(first.mode, "fresh");
  assert.deepEqual(first.messages, []);
  assert.notEqual(first.revisionHash, second.revisionHash);
  assert.deepEqual(cloneSubagentContextMessages(first, runtime()), []);
});

test("captures a descriptor-safe immutable live child fork with only prose and safe images", () => {
  const transcript = liveTranscript();
  const capture = captureLiveSubagentContext({
    chatId: "chat-live",
    parentRunId: "run-parent",
    messages: transcript,
    descendantContextWindow: 32_000,
  });
  assert.deepEqual(
    capture.messages.map(({ role, content, attachments }) => ({
      role,
      content,
      attachments: attachments?.map(({ kind, mimeType, size }) => ({ kind, mimeType, size })),
    })),
    [
      {
        role: "user",
        content: "Inspect the current design.",
        attachments: [{ kind: "image", mimeType: "image/png", size: 3 }],
      },
      {
        role: "assistant",
        content: "I found the relevant design.",
        attachments: undefined,
      },
    ],
  );
  const serialized = JSON.stringify(capture);
  for (const privateValue of [
    "private system",
    "private reasoning",
    "private-sig",
    "call-private",
    "private nested result",
    "private-response",
    "/Users/private",
  ]) {
    assert.doesNotMatch(serialized, new RegExp(privateValue, "u"));
  }
  assert.equal(Object.isFrozen(capture), true);
  assert.equal(Object.isFrozen(capture.messages), true);
  assert.equal(Object.isFrozen(capture.messages[0]?.attachments), true);
});

test("live child fork redacts credentials and private absolute paths from visible prose", () => {
  const transcript = liveTranscript();
  transcript[1]!.content = [
    {
      type: "text",
      text: "Authorization: Bearer secret-value at /Users/alice/private/config.json and sk-abcdefghijklmnop",
    },
  ];
  const serialized = JSON.stringify(
    captureLiveSubagentContext({
      chatId: "chat-live",
      parentRunId: "run-parent",
      messages: transcript,
      descendantContextWindow: 32_000,
    }),
  );
  assert.doesNotMatch(serialized, /secret-value|\/Users\/alice|sk-abcdefghijklmnop/u);
  assert.match(serialized, /REDACTED|credential redacted|private path redacted/u);
});

test("live child fork rejects accessors, oversize active turns, and unsupported images", () => {
  const getterMessage = { role: "user", timestamp: 1 } as Record<string, unknown>;
  Object.defineProperty(getterMessage, "content", { get: () => "must not execute" });
  assert.throws(
    () =>
      captureLiveSubagentContext({
        chatId: "chat-live",
        parentRunId: "run-parent",
        messages: [getterMessage],
        descendantContextWindow: 32_000,
      }),
    /accessor/u,
  );

  assert.throws(
    () =>
      captureLiveSubagentContext({
        chatId: "chat-live",
        parentRunId: "run-parent",
        messages: [{ role: "user", content: "x".repeat(5_000), timestamp: 1 }],
        descendantContextWindow: 1_024,
      }),
    /cannot fit/u,
  );

  assert.throws(
    () =>
      captureLiveSubagentContext({
        chatId: "chat-live",
        parentRunId: "run-parent",
        messages: [
          {
            role: "user",
            content: [{ type: "image", mimeType: "image/svg+xml", data: "YWJj" }],
            timestamp: 1,
          },
        ],
        descendantContextWindow: 32_000,
      }),
    /unsupported image/u,
  );
});

test("live child fork never observes transcript mutation after capture", () => {
  const transcript = liveTranscript();
  const capture = captureLiveSubagentContext({
    chatId: "chat-live",
    parentRunId: "run-parent",
    messages: transcript,
    descendantContextWindow: 32_000,
  });
  const revision = capture.revisionHash;
  (transcript[1]!.content as { type: string; text?: string }[])[0]!.text = "mutated later";
  transcript.push({ role: "user", content: "new later message", timestamp: 5 });
  assert.equal(capture.revisionHash, revision);
  assert.doesNotMatch(JSON.stringify(capture), /mutated later|new later message/u);
});
