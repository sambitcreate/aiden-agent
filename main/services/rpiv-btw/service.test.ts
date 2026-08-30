import assert from "node:assert/strict";
import test from "node:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { BtwOperationRegistry } from "./operation-registry.js";
import { BtwService, type BtwOwner, type BtwServiceDependencies } from "./service-core.js";
import type { BtwEventV1 } from "../../../renderer/shared/btw.js";

const response: AssistantMessage = {
  role: "assistant",
  content: [{ type: "text", text: "The side answer." }],
  api: "openai-completions",
  provider: "provider-a",
  model: "model-a",
  usage: {
    input: 10,
    output: 4,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 14,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "stop",
  timestamp: Date.now(),
};

function fixture(options: { busy?: boolean; streamDelayMs?: number } = {}) {
  const events: BtwEventV1[] = [];
  const usage: Array<{ source?: string; status?: string }> = [];
  let invalidation: (() => void) | undefined;
  const owner: BtwOwner = {
    documentId: "document-a",
    isDestroyed: () => false,
    send: (_channel, event) => events.push(event),
    onInvalidated: (listener) => {
      invalidation = listener;
      return () => { invalidation = undefined; };
    },
  };
  const streamSimple = () => {
    const stream = createAssistantMessageEventStream();
    const complete = () => {
      stream.push({ type: "text_delta", contentIndex: 0, delta: "The side answer.", partial: response });
      stream.push({ type: "done", reason: "stop", message: response });
    };
    if (options.streamDelayMs === undefined) queueMicrotask(complete);
    else setTimeout(complete, options.streamDelayMs);
    return stream;
  };
  const registry = new BtwOperationRegistry(2);
  const deps: BtwServiceDependencies = {
    getChat: async () => ({
      id: "chat-a",
      title: "Chat",
      workspaceId: "workspace-a",
      providerId: "provider-a",
      model: "model-a",
      createdAt: 1,
      updatedAt: 2,
      messages: [
        { id: "user-a", role: "user", content: "Main question", createdAt: 1 },
        { id: "assistant-a", role: "assistant", content: "Main answer", createdAt: 2 },
      ],
    }),
    resolveRuntime: async () => ({
      provider: {
        id: "provider-a",
        kind: "openai",
        label: "Provider A",
        baseUrl: "https://example.invalid/v1",
        models: ["model-a"],
        needsKey: true,
      },
      model: {
        id: "model-a",
        name: "Model A",
        api: "openai-completions",
        provider: "provider-a",
        baseUrl: "https://example.invalid/v1",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 32_000,
        maxTokens: 4_096,
      },
      models: {} as never,
      apiKey: "secret",
      headers: undefined,
      streams: { streamSimple: streamSimple as never },
    }),
    isChatBusy: () => options.busy === true,
    recordUsage: async (record) => { usage.push(record); },
    registry,
  };
  return {
    service: new BtwService(deps),
    registry,
    owner,
    events,
    usage,
    invalidate: () => invalidation?.(),
  };
}

async function waitForTerminal(events: BtwEventV1[]): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!events.some((event) => event.type === "terminal")) {
    if (Date.now() > deadline) throw new Error("BTW test timed out.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("BTW streams an ephemeral answer and records content-free usage", async () => {
  const app = fixture();
  const receipt = await app.service.start("chat-a", "What changed?", app.owner);
  assert.match(receipt.requestId, /^btw_/u);
  await waitForTerminal(app.events);
  assert.deepEqual(app.events.map((event) => event.type), ["started", "delta", "terminal"]);
  const terminal = app.events[2];
  assert.equal(terminal?.type === "terminal" ? terminal.answer : undefined, "The side answer.");
  assert.equal(app.usage.length, 1);
  assert.equal(app.usage[0]?.source, "btw");
  assert.equal("question" in app.usage[0]!, false);
});

test("BTW refuses busy chats before provider dispatch", async () => {
  const app = fixture({ busy: true });
  await assert.rejects(app.service.start("chat-a", "Question", app.owner), /Finish the current response/u);
  assert.deepEqual(app.events, []);
  assert.deepEqual(app.usage, []);
});

test("renderer invalidation cancels only the ephemeral operation", async () => {
  const app = fixture();
  await app.service.start("chat-a", "Question", app.owner);
  app.invalidate();
  await waitForTerminal(app.events);
  const terminal = app.events.find((event) => event.type === "terminal");
  assert.equal(terminal?.type === "terminal" ? terminal.status : undefined, "cancelled");
});

test("detached deletion ignores late provider events after the abort grace", async () => {
  const app = fixture({ streamDelayMs: 40 });
  await app.service.start("chat-a", "Question", app.owner);
  const deadline = Date.now() + 500;
  while (!app.events.some((event) => event.type === "started")) {
    if (Date.now() > deadline) throw new Error("BTW start event timed out.");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }

  assert.equal(await app.registry.cancelAndSettle("chat-a", 5), false);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(app.events.map((event) => event.type), ["started"]);
});
