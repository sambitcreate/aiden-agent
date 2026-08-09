import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { InMemorySessionRepo, type Session } from "@earendil-works/pi-agent-core";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  type Api,
  type AssistantMessage,
  type Model,
} from "@earendil-works/pi-ai";
import { PiCompactionCoordinator, type PiCompactionEvent } from "./pi-compaction-core.js";
import {
  AIDEN_CHAT_MESSAGE_MARKER,
  PiCompactionSessionStore,
  syncChatMessagesToPiSession,
} from "./pi-compaction-session-store.js";
import type { ChatMessage } from "./types.js";

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

async function memorySession(id = "compaction-test"): Promise<Session> {
  return new InMemorySessionRepo().create({ id });
}

function user(text: string, timestamp = Date.now()) {
  return { role: "user" as const, content: text, timestamp };
}

function assistant(
  model: Model<Api>,
  options: {
    input?: number;
    output?: number;
    stopReason?: AssistantMessage["stopReason"];
    errorMessage?: string;
    timestamp?: number;
    text?: string;
  } = {},
): AssistantMessage {
  const input = options.input ?? 950;
  const output = options.output ?? 20;
  return {
    role: "assistant",
    content: [{ type: "text", text: options.text ?? "Working state." }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input,
      output,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: input + output,
      cost: { ...ZERO_COST },
    },
    stopReason: options.stopReason ?? "stop",
    errorMessage: options.errorMessage,
    timestamp: options.timestamp ?? Date.now(),
  };
}

function compactionFixture() {
  const faux = fauxProvider({
    api: "openai-completions",
    provider: "faux-compaction",
    models: [{ id: "faux-summary", contextWindow: 1_000, maxTokens: 200 }],
  });
  const models = createModels();
  models.setProvider(faux.provider);
  return { faux, models, model: faux.getModel() as Model<Api> };
}

async function appendCompressibleHistory(
  session: Session,
  model: Model<Api>,
  suffix = "one",
): Promise<AssistantMessage> {
  await session.appendMessage(user(`old-${suffix}: ${"x".repeat(1_200)}`));
  await session.appendMessage(assistant(model, { input: 400, text: `middle-${suffix}` }));
  await session.appendMessage(user(`latest-${suffix}: ${"y".repeat(500)}`));
  const last = assistant(model, { input: 950, text: `answer-${suffix}` });
  await session.appendMessage(last);
  return last;
}

test("Pi coordinator appends a native checkpoint and rebuilds from it", async () => {
  const { faux, models, model } = compactionFixture();
  faux.setResponses([
    fauxAssistantMessage("## Goal\nContinue.\n\n## Progress\nDone: preserved exact state."),
  ]);
  const session = await memorySession();
  const last = await appendCompressibleHistory(session, model);
  const before = await session.getEntries();
  const events: PiCompactionEvent[] = [];
  const coordinator = new PiCompactionCoordinator({
    session,
    models,
    model,
    thinkingLevel: "off",
    settings: { enabled: true, reserveTokens: 100, keepRecentTokens: 100 },
    onEvent: (event) => events.push(event),
  });

  const result = await coordinator.check(last);

  assert.equal(result.compacted, true);
  assert.equal(result.shouldRetry, false);
  assert.equal(result.messages?.[0]?.role, "compactionSummary");
  const after = await session.getEntries();
  assert.equal(after.length, before.length + 1);
  assert.equal(after[after.length - 1]?.type, "compaction");
  assert.deepEqual(
    events.map((event) => event.type),
    ["start", "end"],
  );
});

test("repeated compaction updates the previous Pi summary", async () => {
  const { faux, models, model } = compactionFixture();
  const summarySeen: boolean[] = [];
  faux.setResponses([
    fauxAssistantMessage("first checkpoint"),
    (context) => {
      summarySeen.push(JSON.stringify(context).includes("first checkpoint"));
      return fauxAssistantMessage("updated checkpoint");
    },
  ]);
  const session = await memorySession();
  const coordinator = new PiCompactionCoordinator({
    session,
    models,
    model,
    thinkingLevel: "off",
    settings: { enabled: true, reserveTokens: 100, keepRecentTokens: 100 },
  });
  const first = await appendCompressibleHistory(session, model, "first");
  assert.equal((await coordinator.check(first)).compacted, true);
  const second = await appendCompressibleHistory(session, model, "second");
  second.timestamp = Date.now() + 1_000;
  assert.equal((await coordinator.check(second)).compacted, true);

  assert.deepEqual(summarySeen, [true]);
  const compactions = (await session.getEntries()).filter((entry) => entry.type === "compaction");
  assert.equal(compactions.length, 2);
  assert.equal(compactions[compactions.length - 1]?.summary, "updated checkpoint");
});

test("overflow compacts and retries at most once", async () => {
  const { faux, models, model } = compactionFixture();
  faux.setResponses([fauxAssistantMessage("overflow checkpoint")]);
  const session = await memorySession();
  await appendCompressibleHistory(session, model);
  const firstOverflow = assistant(model, {
    stopReason: "error",
    errorMessage: "Request exceeds the context window.",
  });
  await session.appendMessage(firstOverflow);
  const events: PiCompactionEvent[] = [];
  const coordinator = new PiCompactionCoordinator({
    session,
    models,
    model,
    thinkingLevel: "off",
    settings: { enabled: true, reserveTokens: 100, keepRecentTokens: 100 },
    onEvent: (event) => events.push(event),
  });

  const first = await coordinator.check(firstOverflow);
  assert.equal(first.compacted, true);
  assert.equal(first.shouldRetry, true);

  const secondOverflow = assistant(model, {
    stopReason: "error",
    errorMessage: "Request still exceeds the context window.",
    timestamp: Date.now() + 10,
  });
  await session.appendMessage(secondOverflow);
  const second = await coordinator.check(secondOverflow);
  assert.equal(second.compacted, false);
  assert.equal(second.shouldRetry, false);
  assert.match(second.errorMessage ?? "", /after one compact-and-retry/u);
  assert.equal(
    (await session.getEntries()).filter((entry) => entry.type === "compaction").length,
    1,
  );
  assert.equal(events.filter((event) => event.type === "start").length, 1);
});

test("summary failure leaves the append-only history authoritative", async () => {
  const { faux, models, model } = compactionFixture();
  faux.setResponses([
    fauxAssistantMessage("", { stopReason: "error", errorMessage: "summarizer unavailable" }),
  ]);
  const session = await memorySession();
  const last = await appendCompressibleHistory(session, model);
  const before = await session.getEntries();
  const coordinator = new PiCompactionCoordinator({
    session,
    models,
    model,
    thinkingLevel: "off",
    settings: { enabled: true, reserveTokens: 100, keepRecentTokens: 100 },
  });

  const result = await coordinator.check(last);

  assert.equal(result.compacted, false);
  assert.equal(result.shouldRetry, false);
  assert.deepEqual(await session.getEntries(), before);
});

test("cancelling summary generation leaves the journal uncompacted", async () => {
  const { faux, models, model } = compactionFixture();
  faux.setResponses([
    async (_context, options) => {
      await new Promise<void>((resolve) => {
        if (options?.signal?.aborted) resolve();
        else options?.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return fauxAssistantMessage("", {
        stopReason: "aborted",
        errorMessage: "summary cancelled",
      });
    },
  ]);
  const session = await memorySession();
  const last = await appendCompressibleHistory(session, model);
  const before = await session.getEntries();
  let coordinator!: PiCompactionCoordinator;
  coordinator = new PiCompactionCoordinator({
    session,
    models,
    model,
    thinkingLevel: "off",
    settings: { enabled: true, reserveTokens: 100, keepRecentTokens: 100 },
    onEvent: (event) => {
      if (event.type === "start") coordinator.abort();
    },
  });

  const result = await coordinator.check(last);

  assert.equal(result.compacted, false);
  assert.equal(result.shouldRetry, false);
  assert.deepEqual(await session.getEntries(), before);
});

test("chat synchronization is idempotent and markers stay out of context", async () => {
  const { model } = compactionFixture();
  const session = await memorySession();
  const messages: ChatMessage[] = [
    { id: "user-1", role: "user", content: "Hello", createdAt: 10 },
    { id: "assistant-1", role: "assistant", content: "Hi", createdAt: 20 },
  ];

  await syncChatMessagesToPiSession(session, messages, model, false);
  await syncChatMessagesToPiSession(session, messages, model, false);

  const entries = await session.getEntries();
  assert.equal(entries.filter((entry) => entry.type === "message").length, 2);
  assert.equal(
    entries.filter(
      (entry) => entry.type === "custom" && entry.customType === AIDEN_CHAT_MESSAGE_MARKER,
    ).length,
    2,
  );
  assert.equal((await session.buildContext()).messages.length, 2);
});

test("durable journals are private and delete with their chat", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "aiden-pi-session-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "sessions");
  await mkdir(root, { recursive: true });
  const store = new PiCompactionSessionStore({ root: async () => root });

  const session = await store.openChat("chat-privacy-test");
  await session.appendMessage(user("private"));
  const metadata = await session.getMetadata();
  assert.equal((await stat(root)).mode & 0o777, 0o700);
  assert.equal((await stat(path.dirname(metadata.path))).mode & 0o777, 0o700);
  assert.equal((await stat(metadata.path)).mode & 0o777, 0o600);

  await store.deleteChat("chat-privacy-test");
  await assert.rejects(stat(metadata.path), { code: "ENOENT" });
});
