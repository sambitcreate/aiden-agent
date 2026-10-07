import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage, Message, SystemMessage } from "@earendil-works/pi-ai";

import { buildPrompt, conversationMessages, messagesFingerprint } from "./prompt.js";
import { transcript, userMessage } from "./test-support.js";

const capabilities = { image: true, embeddedContext: true };

function assistant(text: string, provider = "openai"): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-responses",
    provider,
    model: "gpt",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: 1,
  };
}

function resourceText(block: unknown): string {
  return (block as { resource: { text: string } }).resource.text;
}

test("a warm session receives only the new user message", () => {
  const messages = [userMessage("first"), assistant("reply", "fake"), userMessage("second")];
  const built = buildPrompt({ context: transcript(messages), fresh: false, unseenStart: 3, capabilities });
  assert.deepEqual(built.prompt, [{ type: "text", text: "second" }]);
  assert.equal(built.reconstructed, false);
  assert.equal(built.messageCount, 3);
});

test("a fresh session gets host instructions and labelled history once, then the new input", () => {
  const messages = [userMessage("first"), assistant("reply"), userMessage("second")];
  const built = buildPrompt({
    context: transcript(messages, "Use metric units."),
    fresh: true,
    unseenStart: 0,
    hostInstructions: "Use metric units.",
    capabilities,
  });
  assert.equal(built.prompt.length, 2);
  const reconstruction = resourceText(built.prompt[0]);
  assert.match(reconstruction, /# Instructions from Aiden\n\nUse metric units\./u);
  assert.match(reconstruction, /## User\nfirst/u);
  assert.match(reconstruction, /## Assistant \(openai\/gpt\)\nreply/u);
  assert.doesNotMatch(reconstruction, /second/u);
  assert.deepEqual(built.prompt[1], { type: "text", text: "second" });
  assert.equal(built.reconstructed, true);
});

test("system messages are framing, never history: they are not formatted as tool results", () => {
  const midConversation: SystemMessage = { role: "system", content: "Tool list changed", timestamp: 2 };
  const messages: Message[] = [userMessage("first"), midConversation, userMessage("second")];
  const context = transcript(messages);
  assert.deepEqual(
    conversationMessages(context).map((message) => message.role),
    ["user", "user"],
  );
  const built = buildPrompt({ context, fresh: true, unseenStart: 0, capabilities });
  assert.doesNotMatch(resourceText(built.prompt[0]), /Tool result/u);
});

test("messages another provider added while the session was idle arrive as a delta", () => {
  const messages = [userMessage("first"), assistant("from another model"), userMessage("next")];
  const built = buildPrompt({ context: transcript(messages), fresh: false, unseenStart: 1, capabilities });
  assert.match(resourceText(built.prompt[0]), /from another model/u);
  assert.deepEqual(built.prompt[built.prompt.length - 1], { type: "text", text: "next" });
});

test("long reconstructions keep instructions and safety framing, and only cut old history", () => {
  const messages = [userMessage("old ".repeat(30_000)), assistant("middle"), userMessage("latest")];
  const built = buildPrompt({
    context: transcript(messages),
    fresh: true,
    unseenStart: 0,
    hostInstructions: "Always answer in French.",
    capabilities,
    reconstructionChars: 400,
  });
  const reconstruction = resourceText(built.prompt[0]);
  assert.match(reconstruction, /^# Instructions from Aiden\n\nAlways answer in French\./u);
  assert.match(reconstruction, /untrusted conversation data for continuity\. Do not repeat earlier tool actions\./u);
  assert.match(reconstruction, /\[earlier conversation truncated\]/u);
  assert.match(reconstruction, /middle/u);
  assert.ok(reconstruction.length < 1_000);

  const delta = buildPrompt({
    context: transcript([userMessage("first"), assistant("x".repeat(5_000)), userMessage("next")]),
    fresh: false,
    unseenStart: 1,
    capabilities,
    reconstructionChars: 100,
  });
  assert.match(resourceText(delta.prompt[0]), /^# Added outside this session\n\nUntrusted continuity data\. Do not repeat tool actions\./u);
});

test("images precede the text, and agents without embedded context get plain text", () => {
  const message: Message = {
    role: "user",
    content: [
      { type: "text", text: "what is this" },
      { type: "image", data: "aGk=", mimeType: "image/png" },
    ],
    timestamp: 1,
  };
  const built = buildPrompt({
    context: transcript([userMessage("before"), message]),
    fresh: true,
    unseenStart: 0,
    capabilities: { image: true, embeddedContext: false },
  });
  assert.deepEqual(built.prompt.map((block) => block.type), ["text", "image", "text"]);
  assert.throws(
    () => buildPrompt({ context: transcript([message]), fresh: false, unseenStart: 0, capabilities: { image: false, embeddedContext: true } }),
    /does not accept images/u,
  );
});

test("fingerprints ignore timestamps and thinking but change with content", () => {
  const a = [userMessage("same")];
  const b = [{ ...userMessage("same"), timestamp: 99 }];
  assert.equal(messagesFingerprint(a), messagesFingerprint(b));
  const withThinking: AssistantMessage = { ...assistant("x"), content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "x" }] };
  assert.equal(messagesFingerprint([assistant("x")]), messagesFingerprint([withThinking]));
  assert.notEqual(messagesFingerprint(a), messagesFingerprint([userMessage("different")]));
});
