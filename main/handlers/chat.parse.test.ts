import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { parseParams } from "./chat-params.js";
import { parseChatCancelOrigin } from "../services/chat-cancel.js";
import { ChatTurnAdmission } from "../services/chat-turn-admission.js";
import { subagentsAllowedForGeneration } from "../services/subagents/eligibility.js";
import type { llmClient } from "../services/llm-client.js";
import {
  MAX_CHAT_ID_CHARS,
  MAX_MODEL_ID_CHARS,
  MAX_PROVIDER_ID_CHARS,
  MAX_WORKSPACE_ID_CHARS,
} from "../../renderer/shared/chat-message-contract.js";

const base = { chatId: "c1", providerId: "p", model: "m" };

test("registered chat:start forwards foreground delegation and the appended turn to generation", async () => {
  type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;
  const handlers = new Map<string, Handler>();
  const admission = new ChatTurnAdmission();
  const owner = {
    id: 7, documentId: "renderer-document-1", isDestroyed: () => false,
    send() {}, onInvalidated: () => () => {},
  };
  const event = { sender: "owning-renderer" };
  const lease = admission.tryBegin("c1", "appended-turn-1", owner.documentId, false);
  assert.ok(lease);
  lease.settleAsyncWork();
  let starts = 0;
  let titles = 0;
  const start: typeof llmClient.start = async (streamId, params, generationOwner, options) => {
    starts++;
    assert.equal(streamId, "stream-1");
    assert.equal(generationOwner, owner);
    assert.ok(options, "chat:start must pass main-owned execution options");
    assert.equal(subagentsAllowedForGeneration({
      assistantMode: false,
      allowSubagents: options.allowSubagents,
      usageSource: options.usageSource,
      workspaceId: params.workspaceId,
      folderPath: "/workspace",
      permission: "ask",
    }), true);
    assert.equal(admission.handoff(params.chatId, options.turnId!, generationOwner.documentId, () => {}), true);
    assert.ok(options.onTurnAccepted, "accepted turn must be acknowledged to the renderer");
    options.onTurnAccepted();
    return true;
  };
  const mocks: Record<string, unknown> = {
    "../platform.js": { ipcMain: { handle: (name: string, handler: Handler) => handlers.set(name, handler) } },
    "../services/llm-client.js": { llmClient: { start } },
    "../services/chat-generation-owner.js": { chatGenerationOwner: (received: unknown) => { assert.equal(received, event); return owner; } },
    "../services/chat-title.js": { chatTitleService: { startForFirstTurn: () => { titles++; } } },
    "../services/config-store.js": { configStore: { setSettings: async () => {} } },
    "../services/gemini-live/service-main.js": { geminiLiveService: {} },
    "../services/tool-approval-rules-main.js": { toolApprovalRules: {} },
  };
  // Bundle the real handler and pure helpers; replace only Electron/service ports.
  // No source rewriting, network, profile reads, or model calls are involved.
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL("./chat.ts", import.meta.url))],
    bundle: true, write: false, platform: "node", format: "cjs", external: Object.keys(mocks),
  });
  const module = { exports: {} as typeof import("./chat.js") };
  const require = createRequire(import.meta.url);
  new Function("require", "module", "exports", bundle.outputFiles[0]!.text)(
    (name: string) => {
      if (name.startsWith("node:")) return require(name);
      assert.ok(name in mocks, `Unexpected dependency: ${name}`);
      return mocks[name];
    },
    module, module.exports,
  );
  module.exports.registerChatGenerationHandlers();
  const handler = handlers.get("chat:start");
  assert.ok(handler);
  try {
    assert.deepEqual(await handler(event, "stream-1", { ...base, workspaceId: "workspace-1" }, "appended-turn-1"), {
      streamId: "stream-1", accepted: true, started: true,
    });
    assert.equal(admission.isAdmitted("c1"), false);
    assert.equal(starts, 1);
    assert.equal(titles, 1);
    await assert.rejects(handler(event, "stream-1", base, undefined), /Invalid chat message turn identifier/u);
    assert.equal(starts, 1);
  } finally {
    lease.release();
  }
});

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
  assert.match(
    runtime,
    /if \(initialization\?\.rendererDetached \|\| generation\?\.rendererDetached\)/u,
  );
});

test("user Stop acknowledges only a generation owned by the calling document", () => {
  const handler = readFileSync(new URL("./chat.ts", import.meta.url), "utf8");
  assert.match(handler, /const cancelled = llmClient\.cancel\(streamId, "user_stop", owner\.documentId\)/u);
  assert.match(handler, /return cancelled;/u);
  const runtime = readFileSync(new URL("../services/llm-client.ts", import.meta.url), "utf8");
  assert.match(runtime, /cancel\([\s\S]*?ownerDocumentId\?: string,[\s\S]*?owner\.documentId !== ownerDocumentId/u);
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
  assert.deepEqual(parseParams({ ...base, visualize: true }).visualize, true);
  assert.throws(() => parseParams({ ...base, visualize: false }), /Invalid generation fields/);
});
