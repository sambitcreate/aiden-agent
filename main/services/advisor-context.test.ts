import assert from "node:assert/strict";
import test from "node:test";
import { Type, type AssistantMessage, type ToolResultMessage } from "@earendil-works/pi-ai";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import {
  buildAdvisorInventory,
  projectAdvisorContext,
  repairAdvisorToolProtocol,
  snapshotAdvisorRuntimeMessages,
} from "./advisor-context.js";

const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(content: AssistantMessage["content"]): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "openai",
    model: "executor",
    usage,
    stopReason: "toolUse",
    timestamp: 2,
  };
}

test("advisor projection strips exact in-flight call, hidden reasoning, metadata, and orphans", () => {
  const pairedResult: ToolResultMessage = {
    role: "toolResult",
    toolCallId: "call-read",
    toolName: "read_file",
    content: [{ type: "text", text: "evidence" }],
    details: { private: "never forwarded" },
    isError: false,
    timestamp: 3,
  };
  const live: AgentMessage[] = [
    { role: "user", content: "fix it api_key=sk-abcdefghijklmnopqrstuvwxyz", timestamp: 1 },
    assistant([
      { type: "thinking", thinking: "private chain", thinkingSignature: "encrypted" },
      {
        type: "toolCall",
        id: "call-read",
        name: "read_file",
        arguments: { secret: "never-forward" },
      },
    ]),
    pairedResult,
    assistant([
      { type: "text", text: "I should ask.", textSignature: "signed" },
      { type: "toolCall", id: "call-advisor", name: "advisor", arguments: {} },
      { type: "toolCall", id: "call-orphan", name: "grep", arguments: {} },
    ]),
  ];
  const projection = projectAdvisorContext({
    liveMessages: live,
    inflightToolCallId: "call-advisor",
    executorTools: [],
    reviewerContextWindow: 32_000,
    reviewerSupportsImages: false,
    reviewerSystemPrompt: "review",
    timestamp: 10,
  });
  const wire = JSON.stringify(projection.messages);
  assert.equal(wire.includes("private chain"), false);
  assert.equal(wire.includes("encrypted"), false);
  assert.equal(wire.includes("call-advisor"), false);
  assert.equal(wire.includes("call-orphan"), false);
  assert.equal(wire.includes("private"), false);
  assert.equal(wire.includes("sk-abcdefghijklmnopqrstuvwxyz"), false);
  assert.equal(wire.includes("never-forward"), false);
  assert.equal(wire.includes("credential redacted"), true);
  assert.equal(wire.includes("call-read"), true);
  assert.equal(projection.messages[projection.messages.length - 1]?.role, "user");
});

test("tool repair keeps only correctly named completed pairs", () => {
  const messages = repairAdvisorToolProtocol(
    [
      assistant([{ type: "toolCall", id: "one", name: "read", arguments: {} }]),
      {
        role: "toolResult",
        toolCallId: "one",
        toolName: "write",
        content: [],
        isError: false,
        timestamp: 2,
      },
    ],
    "other",
  );
  assert.deepEqual(messages, []);
});

test("inventory hash changes with schemas and excludes advisor itself", () => {
  const make = (maxLength: number): AgentTool[] => [
    {
      name: "read_file",
      label: "Read",
      description: "Read a file",
      parameters: Type.Object({ path: Type.String({ maxLength }) }),
      execute: async () => ({ content: [], details: null }),
    },
    {
      name: "advisor",
      label: "Advisor",
      description: "self",
      parameters: Type.Object({}),
      execute: async () => ({ content: [], details: null }),
    },
  ];
  const first = buildAdvisorInventory(make(10));
  const second = buildAdvisorInventory(make(20));
  assert.notEqual(first?.hash, second?.hash);
  assert.equal(first?.text.includes("### advisor"), false);
});

test("tool inventory text and schemas redact credential-shaped content", () => {
  const inventory = buildAdvisorInventory([
    {
      name: "inspect_service",
      label: "Inspect",
      description: "Inspect with Authorization: Bearer inventory-bearer-secret",
      parameters: Type.Object({
        token: Type.String({ description: "api_key=inventory-schema-secret" }),
      }),
      execute: async () => ({ content: [], details: null }),
    },
  ]);
  assert.ok(inventory);
  assert.equal(inventory.text.includes("inventory-bearer-secret"), false);
  assert.equal(inventory.text.includes("inventory-schema-secret"), false);
  assert.equal((inventory.text.match(/credential redacted/gu) ?? []).length, 2);
});

test("live snapshot includes a streaming in-flight call exactly once", () => {
  const streamed = assistant([
    { type: "toolCall", id: "call-advisor", name: "advisor", arguments: {} },
  ]);
  const snapshot = snapshotAdvisorRuntimeMessages(
    { messages: [{ role: "user", content: "x", timestamp: 1 }], streamingMessage: streamed },
    "call-advisor",
  );
  assert.equal(snapshot.length, 2);
  const existing = snapshotAdvisorRuntimeMessages(
    { messages: snapshot, streamingMessage: streamed },
    "call-advisor",
  );
  assert.equal(existing.length, 2);
});

test("advisor projection redacts bounded high-confidence credential families", () => {
  // Assemble detector-shaped fixtures at runtime so repository push protection
  // never has to distinguish synthetic examples from real credentials.
  const fixture = (...parts: string[]) => parts.join("");
  const credentials = [
    "Authorization: Bearer bearer-secret-value",
    "api_key=ordinary-secret-value",
    fixture("gh", "p_", "abcdefghijklmnop", "qrstuvwxyz123456"),
    fixture("github_", "pat_", "abcdefghijklmnop", "qrstuvwxyz_123456"),
    fixture("AK", "IA", "ABCDEFGH", "IJKLMNOP"),
    fixture("AI", "za", "abcdefghijklmnop", "qrstuvwxyz1234567890"),
    fixture("xo", "xb-", "1234567890-", "abcdefghijklmnopqrstuvwxyz"),
    fixture("s", "k-", "abcdefghijklmnop", "qrstuvwxyz"),
    "-----BEGIN TEST PRIVATE KEY-----\nprivate-material\n-----END TEST PRIVATE KEY-----",
  ];
  const projection = projectAdvisorContext({
    liveMessages: [{ role: "user", content: credentials.join("\n"), timestamp: 1 }],
    inflightToolCallId: "advisor-call",
    executorTools: [],
    reviewerContextWindow: 128_000,
    reviewerSupportsImages: false,
    reviewerSystemPrompt: "review",
  });
  const wire = JSON.stringify(projection.messages);
  for (const credential of credentials.slice(0, -1)) {
    assert.equal(wire.includes(credential), false, credential);
  }
  assert.equal(wire.includes("private-material"), false);
  assert.equal((wire.match(/credential redacted/gu) ?? []).length, credentials.length);
});
