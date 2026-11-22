import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { generationModelMeta } from "./chat-model-selection-meta.js";
import { createChatStore } from "./chat-store-core.js";
import {
  persistGenerationInitializationTerminal,
  type GenerationInitializationTerminalMessage,
  type GenerationInitializationTerminalMeta,
} from "./generation-initialization-terminal.js";

test("initialization terminal persistence is ordered, exact, and once-only", async () => {
  const events: string[] = [];
  const messages: GenerationInitializationTerminalMessage[] = [];
  const metas: GenerationInitializationTerminalMeta[] = [];
  const state = { attempted: false };
  const append = async (message: GenerationInitializationTerminalMessage, meta: GenerationInitializationTerminalMeta) => {
    events.push("append-start");
    await Promise.resolve();
    messages.push(message);
    metas.push(meta);
    events.push("append-durable");
  };
  const common = {
    state,
    hasAuthoritativeChat: true,
    workspaceId: "workspace-1",
    streamId: "stream-1",
    providerId: "provider-1",
    model: "model-1",
    isCurrent: () => true,
    append,
    onUnknownOutcome: () => assert.fail("unexpected unknown persistence outcome"),
  };
  assert.equal(await persistGenerationInitializationTerminal({
    ...common,
    status: "cancelled",
    cancellationOrigin: "user_stop",
  }), "persisted");
  events.push("ownership-release");
  assert.deepEqual(events, ["append-start", "append-durable", "ownership-release"]);
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.timeline.status, "cancelled");
  assert.equal(messages[0]?.timeline.cancellationOrigin, "user_stop");
  assert.equal(metas[0]?.expectedWorkspaceId, "workspace-1");
  assert.equal(await persistGenerationInitializationTerminal({
    ...common,
    status: "failed",
  }), "skipped");
  assert.equal(messages.length, 1);
});

test("initialization terminal persistence is authority gated and unknown outcomes never retry", async () => {
  let appends = 0;
  assert.equal(await persistGenerationInitializationTerminal({
    state: { attempted: false },
    hasAuthoritativeChat: true,
    workspaceId: undefined,
    streamId: "stream-2",
    providerId: "provider-1",
    model: "model-1",
    status: "failed",
    isCurrent: () => true,
    append: async () => { appends += 1; },
    onUnknownOutcome: () => assert.fail("unexpected unknown persistence outcome"),
  }), "skipped");
  const state = { attempted: false };
  let unknowns = 0;
  const options = {
    state,
    hasAuthoritativeChat: true,
    workspaceId: "workspace-1",
    streamId: "stream-3",
    providerId: "provider-1",
    model: "model-1",
    status: "failed" as const,
    isCurrent: () => true,
    append: async () => { appends += 1; throw new Error("unknown append outcome"); },
    onUnknownOutcome: () => { unknowns += 1; },
  };
  assert.equal(await persistGenerationInitializationTerminal(options), "unknown");
  assert.equal(await persistGenerationInitializationTerminal(options), "skipped");
  assert.equal(appends, 1);
  assert.equal(unknowns, 1);
});

test("a run that fails while starting saves its outcome in the chat while it still owns it, and an in-chat task run leaves the chat's model alone", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-init-terminal-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = createChatStore(async () => directory);

  // Wired as llm-client's generation start wires it: the chat store, with the run's model unless it keeps the chat's.
  const persist = async (chatId: string, input: { owns: () => boolean; keepChatModel?: boolean; streamId: string }) =>
    persistGenerationInitializationTerminal({
      state: { attempted: false },
      hasAuthoritativeChat: true,
      workspaceId: "workspace-1",
      streamId: input.streamId,
      providerId: "task-provider",
      model: "task-model",
      status: "failed",
      isCurrent: input.owns,
      append: (message, meta) =>
        store.appendMessage(chatId, message, {
          expectedWorkspaceId: meta.expectedWorkspaceId,
          isCurrent: meta.isCurrent,
          ...generationModelMeta(meta, input.keepChatModel),
        }),
      onUnknownOutcome: (error) => assert.fail(String(error)),
    });

  const taskChat = await store.create({ workspaceId: "workspace-1", providerId: "chat-provider", model: "chat-model" });
  assert.equal(await persist(taskChat.id, { owns: () => true, keepChatModel: true, streamId: "stream-task" }), "persisted");
  const afterTask = await store.get(taskChat.id);
  const outcome = afterTask?.messages[afterTask.messages.length - 1];
  assert.equal(outcome?.role, "assistant");
  assert.equal(outcome?.timeline?.status, "failed");
  assert.deepEqual([afterTask?.providerId, afterTask?.model], ["chat-provider", "chat-model"], "the chat stays on its own model");

  const ordinary = await store.create({ workspaceId: "workspace-1", providerId: "chat-provider", model: "chat-model" });
  assert.equal(await persist(ordinary.id, { owns: () => true, streamId: "stream-ordinary" }), "persisted");
  const afterOrdinary = await store.get(ordinary.id);
  assert.deepEqual([afterOrdinary?.providerId, afterOrdinary?.model], ["task-provider", "task-model"]);

  // Once the run no longer owns its chat, nothing is written for it.
  const released = await store.create({ workspaceId: "workspace-1" });
  assert.equal(await persist(released.id, { owns: () => false, streamId: "stream-released" }), "skipped");
  assert.equal((await store.get(released.id))?.messages.length, 0);
});
