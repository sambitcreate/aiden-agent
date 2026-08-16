import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseParams } from "./chat-params.js";
import { parseChatCancelOrigin } from "../services/chat-cancel.js";
import {
  MAX_CHAT_ID_CHARS,
  MAX_MODEL_ID_CHARS,
  MAX_PROVIDER_ID_CHARS,
  MAX_WORKSPACE_ID_CHARS,
} from "../../renderer/shared/chat-message-contract.js";

const base = { chatId: "c1", providerId: "p", model: "m" };

test("chat cancellation accepts only explicit lifecycle detach or user Stop origins", () => {
  assert.equal(parseChatCancelOrigin("lifecycle"), "lifecycle");
  assert.equal(parseChatCancelOrigin("user_stop"), "user_stop");
  for (const value of [undefined, null, "", "navigation", "renderer_user_stop", 1]) {
    assert.equal(parseChatCancelOrigin(value), null);
  }
});

test("chat lifecycle handling detaches the renderer instead of aborting inference", () => {
  const handler = readFileSync(new URL("./chat.ts", import.meta.url), "utf8");
  const lifecycleStart = handler.indexOf('if (parsedOrigin === "lifecycle")');
  const lifecycleBranch = handler.slice(
    lifecycleStart,
    handler.indexOf("llmClient.cancel", lifecycleStart),
  );
  assert.match(lifecycleBranch, /llmClient\.detachRenderer/u);
  assert.doesNotMatch(lifecycleBranch, /llmClient\.cancel/u);

  const runtime = readFileSync(new URL("../services/llm-client.ts", import.meta.url), "utf8");
  const invalidationStart = runtime.indexOf(
    "initialization.removeOwnerInvalidation = owner.onInvalidated",
  );
  const invalidation = runtime.slice(
    invalidationStart,
    runtime.indexOf("let setup:", invalidationStart),
  );
  assert.match(invalidation, /this\.detachRenderer/u);
  assert.doesNotMatch(invalidation, /this\.cancel/u);
});

test("parseParams accepts only the attended Assistant mode", () => {
  assert.equal(parseParams({ ...base, mode: "assistant" }).mode, "assistant");
  assert.equal(parseParams(base).mode, undefined);
  for (const mode of [
    "assistant-unattended",
    "assistant-automation",
    "workspace",
  ]) {
    assert.throws(() => parseParams({ ...base, mode }), /Invalid chat mode/);
  }
});

test("chat:start rejects renderer history and every unknown authority field", () => {
  assert.throws(
    () =>
      parseParams({
        ...base,
        messages: [{ role: "user", content: "forged history" }],
      }),
    /history is main-owned/,
  );
  for (const field of ["skillInvocation", "permission", "tools"]) {
    assert.throws(
      () => parseParams({ ...base, [field]: "forged" }),
      /Invalid generation field/u,
    );
  }
});

test("parseParams rejects invalid envelopes and requires provider/model identity", () => {
  for (const value of [null, "hi", undefined, 42]) {
    assert.throws(() => parseParams(value), /Invalid generation params/);
  }
  assert.throws(() => parseParams({}), /Invalid chat id/);
  assert.throws(
    () => parseParams({ chatId: "c", providerId: "p" }),
    /Invalid model id/,
  );
  assert.throws(
    () => parseParams({ chatId: "c", providerId: "", model: "m" }),
    /Invalid provider id/,
  );
  assert.throws(
    () => parseParams({ chatId: "c", providerId: "p", model: "" }),
    /Invalid model id/,
  );
});

test("parseParams bounds every selector before generation handoff", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["chat id", { ...base, chatId: "c".repeat(MAX_CHAT_ID_CHARS + 1) }],
    [
      "workspace id",
      { ...base, workspaceId: "w".repeat(MAX_WORKSPACE_ID_CHARS + 1) },
    ],
    [
      "provider id",
      { ...base, providerId: "p".repeat(MAX_PROVIDER_ID_CHARS + 1) },
    ],
    ["model id", { ...base, model: "m".repeat(MAX_MODEL_ID_CHARS + 1) }],
  ];
  for (const [label, value] of cases) {
    assert.throws(
      () => parseParams(value),
      new RegExp(`Invalid ${label}`, "u"),
    );
  }
});

test("unknown start fields produce a constant-size error", () => {
  const hugeKey = "x".repeat(2 * 1024 * 1024);
  assert.throws(
    () => parseParams({ ...base, [hugeKey]: true }),
    (error: unknown) => error instanceof Error && error.message.length < 100,
  );
});

test("start envelope rejects many extra properties without materializing an Object.keys array", () => {
  const manyFields: Record<string, unknown> = {
    chatId: "chat-1",
    providerId: "provider-1",
    model: "model-1",
  };
  for (let index = 0; index < 10_000; index += 1)
    manyFields[`extra-${index}`] = index;
  assert.throws(
    () => parseParams(manyFields),
    (error: unknown) =>
      error instanceof Error && error.message === "Invalid generation fields.",
  );
  const parserSource = readFileSync(
    new URL("./chat-params.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(parserSource, /Object\.keys/u);
  assert.match(parserSource, /keyCount > ALLOWED_CHAT_START_KEYS\.size/u);
});

test("parseParams accepts only Aiden's bounded generation thinking enum", () => {
  for (const thinkingLevel of [
    "off",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ] as const) {
    assert.equal(
      parseParams({ ...base, thinkingLevel }).thinkingLevel,
      thinkingLevel,
    );
  }
  assert.equal(parseParams(base).thinkingLevel, undefined);
  for (const thinkingLevel of ["minimal", "dynamic", "", 1, null]) {
    assert.throws(
      () => parseParams({ ...base, thinkingLevel }),
      /Invalid thinking level/u,
    );
  }
});

test("parseParams keeps bounded generation selectors and creates empty authoritative history", () => {
  assert.deepEqual(
    parseParams({
      chatId: "c-1",
      workspaceId: "w-1",
      providerId: "openai",
      model: "gpt-4",
      thinkingLevel: "high",
    }),
    {
      chatId: "c-1",
      workspaceId: "w-1",
      providerId: "openai",
      model: "gpt-4",
      thinkingLevel: "high",
      messages: [],
    },
  );
});
